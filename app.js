// 家族カレンダー（Firestore に保存・リアルタイム更新）
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, collection, query, where, onSnapshot, getDoc, setDoc, addDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig, FAMILY_ID } from "./firebase-config.js";
import { ICONS, iconSvg, isIcon } from "./icons.js";

// 予定や送迎の担当は固定ID（father / mother / son / daughter）でひもづける。
// 名前とアイコンは profiles に保存され、変えても予定はずれない。
const MEMBERS = [
  { id: "father", name: "父", icon: "sun" },
  { id: "mother", name: "母", icon: "flower" },
  { id: "son", name: "長男", icon: "fish" },
  { id: "daughter", name: "長女", icon: "cat" },
];
// 以前の版のID（papa / mama）で保存された予定も、そのまま読めるようにする
const OLD_IDS = { papa: "father", mama: "mother" };
const normId = (id) => OLD_IDS[id] || id;
const LEG_NAME = { go: "行き", back: "帰り" };
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const NAME_MAX = 10;

let profiles = {}; // Firestore の families/{FAMILY_ID}/profiles/{メンバーID}
const profile = (id) => {
  const base = MEMBERS.find((m) => m.id === id) || { name: "?", icon: "star" };
  const p = profiles[id] || {};
  return {
    name: typeof p.name === "string" && p.name ? p.name : base.name,
    icon: isIcon(p.icon) ? p.icon : base.icon,
  };
};
const memberName = (id) => profile(id).name;
// 文字数は Firestore のルールと同じ数え方（絵文字は2文字になることがある）
const charCount = (s) => s.length;

// ---------- Firebase ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
// 動作確認用：テストのときだけ手元のエミュレーターにつなぐ（ふだんは何もしない）
if (window.FAMILY_CALENDAR_EMULATOR) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}
const memberRef = (uid) => doc(db, "families", FAMILY_ID, "members", uid);
const eventsCol = collection(db, "families", FAMILY_ID, "events");
const profilesCol = collection(db, "families", FAMILY_ID, "profiles");

// ---------- 日付のヘルパー ----------
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const dateLabel = (s) => { const d = new Date(s + "T00:00"); return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`; };

// ---------- 状態 ----------
let events = [];        // Firestore から届いた予定（今日以降）
let me = null;          // 自分（father / mother / son / daughter）
let loaded = false;     // 最初の読み込みが終わったか
let stopEvents = null;  // リアルタイム更新の停止用
let stopProfiles = null;
let subscribedDay = null;

// ---------- 小さな部品 ----------
// 入力された文字は textContent で入れる（HTMLとして解釈させない）
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
// その人の色の丸＋アイコン
const avatar = (member, size = 32, iconId) => {
  const el = h("span", { class: `avatar m-${member}`, style: `--size:${size}px` });
  el.append(iconSvg(iconId || profile(member).icon, Math.round(size * 0.62)));
  return el;
};
// 色ラベル（アイコン＋名前）
const label = (member) => {
  const el = h("span", { class: `label m-${member}` });
  el.append(iconSvg(profile(member).icon, 16), memberName(member));
  return el;
};
const legs = (e) => (e.ride ? ["go", "back"].filter((k) => e.ride[k]) : []);

// ---------- 予定の日時 ----------
// 予定の項目：date（始まりの日）、endDate（終わりの日。1日だけなら null か無し）、
// allDay（終日）、start（開始時間。終日なら null）、end（終了時間。無ければ null）
// 以前の版の予定は allDay・endDate が無く、start だけ入っている。
const showTime = (t) => t.replace(/^0(\d)/, "$1"); // 09:00 → 9:00
const isAllDay = (e) => e.allDay === true || !e.start;
const lastDay = (e) => (e.endDate && e.endDate > e.date ? e.endDate : e.date);
const isMultiDay = (e) => lastDay(e) !== e.date;
const onDay = (e, day) => e.date <= day && day <= lastDay(e);
const rangeText = (e) => `${dateLabel(e.date)}〜${dateLabel(lastDay(e))}`;

// その日の予定1件分（何日か続く予定は、日によって時間の出し方が変わる）
//   text：「終日」「9:00〜」「9:00〜15:00」「〜10:00」
//   from / to：その日の何分から何分まで（分からないときは null）
function occurrence(e, day) {
  const first = day === e.date;
  const last = day === lastDay(e);
  const o = { e, day, allDay: false, from: null, to: null, text: "" };
  if (isAllDay(e) || (!first && !last) || (!first && last && !e.end)) {
    o.allDay = true; o.from = 0; o.to = 24 * 60; o.text = "終日";
  } else if (first) {
    o.from = toMinutes(e.start);
    o.to = last ? (e.end ? toMinutes(e.end) : null) : 24 * 60;
    o.text = last && e.end ? `${showTime(e.start)}〜${showTime(e.end)}` : `${showTime(e.start)}〜`;
  } else {
    o.from = 0; o.to = toMinutes(e.end); o.text = `〜${showTime(e.end)}`;
  }
  // 送り（行き）は始まりの日、お迎え（帰り）は終わりの日に出す
  o.legs = legs(e).filter((k) => (k === "go" ? first : last));
  o.pending = o.legs.some((k) => !e.ride[k].driver);
  return o;
}

// その日の予定を、終日→時間の早い順に並べる
function dayList(day, member) {
  return events
    .filter((e) => onDay(e, day) && (!member || e.member === member))
    .map((e) => occurrence(e, day))
    .sort((a, b) => (b.allDay - a.allDay) || (a.from - b.from) || a.e.title.localeCompare(b.e.title, "ja"));
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
function saveError(err) {
  console.error(err);
  toast(err && err.code === "permission-denied"
    ? "保存できませんでした（家族グループに参加していない可能性があります）"
    : "保存できませんでした。電波の良いところでもう一度試してください");
}

// ---------- 送迎の担当を保存 ----------
// 以前の版のID（papa / mama）が残っていたら、ついでに新しいIDに直して保存する
function setDriver(e, key, driver) {
  const patch = { member: e.member, [`ride.${key}.driver`]: driver, updatedAt: serverTimestamp() };
  for (const k of legs(e)) if (k !== key) patch[`ride.${k}.driver`] = e.ride[k].driver;
  updateDoc(doc(eventsCol, e.id), patch).catch(saveError);
}

// 送迎1件分の表示（未定＝黄色ボタン／確定＝グレー＋取り消し）
function rideRow(e, key) {
  const r = e.ride[key];
  const what = `${LEG_NAME[key]} ${showTime(r.time)}`;
  if (!r.driver) {
    return h("button", { class: "ride pending", type: "button", onclick: () => openRide(e, key) },
      h("span", { class: "ride-text" }, `${what}　誰が行く？`), "›");
  }
  return h("div", { class: "ride done" },
    h("span", { class: "ride-text" }, `${what}　${memberName(r.driver)}が行く ✓`),
    h("button", { class: "undo", type: "button", onclick: () => setDriver(e, key, null) }, "取り消し"));
}

// ---------- 画面：今日 ----------
function viewToday() {
  const today = ymd(new Date());
  const list = dayList(today);
  return [
    h("h2", {}, `${dateLabel(today)} の予定`),
    list.length
      ? h("ul", { class: "list" }, list.map((o) =>
          h("li", { class: `event m-${o.e.member}${o.allDay ? " all-day" : ""}` },
            h("div", { class: "event-head" }, h("span", { class: "time" }, o.text), label(o.e.member)),
            h("div", { class: "event-title" }, o.e.title),
            isMultiDay(o.e) ? h("div", { class: "range" }, rangeText(o.e)) : null,
            o.legs.length ? h("div", { class: "rides" }, o.legs.map((k) => rideRow(o.e, k))) : null)))
      : h("p", { class: "empty" }, "今日の予定はありません"),
  ];
}

// ---------- 画面：週（縦＝曜日、横＝家族。今日から7日間） ----------
function viewWeek() {
  const now = new Date();
  const today = ymd(now);
  const days = Array.from({ length: 7 }, (_, i) => addDays(now, i));

  const head = h("tr", {}, h("th", { class: "day" }, ""), MEMBERS.map((m) => h("th", { class: `m-${m.id}` },
    h("div", { class: "who" }, avatar(m.id, 28), h("span", {}, memberName(m.id))))));
  const rows = days.map((d) => {
    const ds = ymd(d);
    const dow = d.getDay();
    return h("tr", { class: ds === today ? "is-today" : null },
      h("th", { class: `day ${dow === 6 ? "sat" : dow === 0 ? "sun" : ""}`, scope: "row" },
        WEEKDAYS[dow], h("small", {}, `${d.getMonth() + 1}/${d.getDate()}`)),
      MEMBERS.map((m) => h("td", {},
        dayList(ds, m.id).map((o) =>
          h("div", { class: `mini m-${o.e.member}${o.allDay ? " all-day" : ""}${o.pending ? " has-pending" : ""}` },
            h("b", {}, o.text), " ", o.e.title,
            o.pending ? h("span", { class: "flag" }, "送迎 誰が行く？") : null)))));
  });

  return [
    h("h2", {}, `${dateLabel(ymd(days[0]))} 〜 ${dateLabel(ymd(days[6]))}`),
    h("div", { class: "week-wrap" }, h("table", { class: "week" }, h("thead", {}, head), h("tbody", {}, rows))),
  ];
}

// ---------- 画面：家族（いま／つぎ） ----------
function viewFamily() {
  const today = ymd(new Date());
  const nm = nowMinutes();
  const slot = (name, timeLabel, e) => h("div", { class: "slot" },
    h("span", { class: "slot-name" }, name),
    e ? h("span", {}, h("b", {}, timeLabel), " ", e.title)
      : h("span", { class: "slot-none" }, "予定なし"));

  return [
    h("h2", {}, "いま と つぎ の予定"),
    h("div", { class: "cards" }, MEMBERS.map((m) => {
      // いま：今日の予定のうち、いまの時刻が入っているもの（時間付きを優先）
      const nowList = dayList(today, m.id).filter((o) => o.to != null && o.from <= nm && nm < o.to);
      const nowOcc = nowList.find((o) => !o.allDay) || nowList[0];
      // つぎ：これから始まる予定のうち、いちばん早いもの
      const nextEv = events
        .filter((e) => e.member === m.id && (e.date > today || (e.date === today && !isAllDay(e) && toMinutes(e.start) > nm)))
        .sort((a, b) => (a.date === b.date
          ? (isAllDay(b) - isAllDay(a)) || ((a.start ? toMinutes(a.start) : 0) - (b.start ? toMinutes(b.start) : 0))
          : a.date < b.date ? -1 : 1))[0];
      const nextLabel = nextEv
        ? `${nextEv.date !== today ? dateLabel(nextEv.date) + " " : ""}${isAllDay(nextEv) ? "終日" : showTime(nextEv.start) + "〜"}`
        : "";
      return h("section", { class: `member m-${m.id}` },
        h("h3", {}, avatar(m.id, 40), memberName(m.id)),
        slot("いま", nowOcc ? nowOcc.text : "", nowOcc && nowOcc.e),
        slot("つぎ", nextLabel, nextEv));
    })),
  ];
}

// ---------- 表示の切り替え ----------
const VIEWS = { today: viewToday, week: viewWeek, family: viewFamily };
let current = "today";
const viewEl = $("view");

function render() {
  refreshNames();
  if (!me) return;
  // 日付が変わっていたら、読み込む範囲（今日以降）を取り直す
  if (subscribedDay !== ymd(new Date())) subscribeEvents();
  viewEl.replaceChildren(...(loaded ? [VIEWS[current]()].flat() : [h("p", { class: "empty" }, "読み込み中…")]));
  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.view === current)));
}
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => { current = t.dataset.view; render(); }));
// 「いま」の表示を1分ごとに更新・アプリに戻ったときも更新
setInterval(render, 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

// ---------- リアルタイム更新 ----------
// 今日以降に始まる予定と、前に始まって今日以降まで続く予定（旅行など）の2つを読んで合わせる
function subscribeEvents() {
  if (stopEvents) stopEvents();
  subscribedDay = ymd(new Date());
  const parts = { starts: null, continues: null };
  const merge = () => {
    if (!parts.starts || !parts.continues) return;
    const byId = new Map();
    for (const list of [parts.starts, parts.continues]) for (const e of list) byId.set(e.id, e);
    events = [...byId.values()];
    loaded = true;
    render();
  };
  const fail = (err) => {
    console.error(err);
    viewEl.replaceChildren(h("p", { class: "empty" }, "予定を読み込めませんでした。家族グループへの参加をやり直してください。"));
    showJoin(true);
  };
  const listen = (key, q) => onSnapshot(q, (snap) => {
    parts[key] = snap.docs.map((d) => normEvent({ id: d.id, ...d.data() }));
    merge();
  }, fail);
  const stops = [
    listen("starts", query(eventsCol, where("date", ">=", subscribedDay))),
    listen("continues", query(eventsCol, where("endDate", ">=", subscribedDay))),
  ];
  stopEvents = () => stops.forEach((stop) => stop());
}

function normEvent(e) {
  e.member = normId(e.member);
  for (const k of legs(e)) e.ride[k].driver = e.ride[k].driver ? normId(e.ride[k].driver) : null;
  return e;
}

// 名前とアイコン：変わったら全員の画面にすぐ反映
function subscribeProfiles() {
  if (stopProfiles) return;
  stopProfiles = onSnapshot(profilesCol, (snap) => {
    profiles = {};
    snap.forEach((d) => { profiles[d.id] = d.data(); });
    render();
    if (profileDialog.open) drawProfileEditor();
  }, (err) => { console.error(err); stopProfiles = null; });
}

// 名前が出る場所のうち、作り直さないもの（ボタンなど）を更新
function refreshNames() {
  document.querySelectorAll(".chips").forEach((c) => c._refresh && c._refresh());
  document.querySelectorAll(".btn.driver").forEach((b) => { b.textContent = `${memberName(b.dataset.driver)}が行く`; });
  if (me) {
    const btn = $("meBtn");
    btn.hidden = false;
    btn.className = `me m-${me}`;
    btn.replaceChildren(avatar(me, 30), h("span", {}, memberName(me)), " ▾");
    btn.setAttribute("aria-label", `いまは${memberName(me)}として使っています。メニューを開く`);
  }
}

// ---------- 送迎の担当決め ----------
const rideDialog = $("rideDialog");
let rideTarget = null;
function openRide(e, key) {
  rideTarget = { e, key };
  $("rideTitle").textContent = `${LEG_NAME[key]}は誰が行く？`;
  const day = key === "go" ? e.date : lastDay(e);
  $("rideInfo").textContent = `${memberName(e.member)}の「${e.title}」 ${dateLabel(day)} ${showTime(e.ride[key].time)}`;
  rideDialog.showModal();
}
rideDialog.querySelectorAll(".driver").forEach((b) => b.addEventListener("click", () => {
  if (rideTarget) setDriver(rideTarget.e, rideTarget.key, b.dataset.driver);
  rideTarget = null;
  rideDialog.close();
}));
$("cancelRide").addEventListener("click", () => rideDialog.close());

// ---------- メンバーを選ぶボタン（追加画面・参加画面で共用） ----------
// useDefault：参加前は家族の名前を読めないので、最初の呼び名（父・母・長男・長女）で出す
function memberPicker(container, onPick, useDefault = false) {
  let picked = null;
  const set = (id) => {
    picked = id;
    container.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.member === id)));
    if (onPick) onPick(id);
  };
  const draw = () => container.replaceChildren(...MEMBERS.map((m) => {
    const p = useDefault ? m : profile(m.id);
    const b = h("button", {
      type: "button", class: `chip m-${m.id}`, "aria-pressed": String(picked === m.id), "data-member": m.id,
      onclick: () => set(m.id),
    });
    b.append(iconSvg(p.icon, 18), h("span", {}, p.name));
    return b;
  }));
  draw();
  if (!useDefault) container._refresh = draw;
  return { get: () => picked, set };
}

// ---------- 予定の追加 ----------
const addDialog = $("addDialog");
const form = $("addForm");
const addPicker = memberPicker($("memberPicker"));
const rideToggle = $("rideToggle");
const rideFields = $("rideFields");
const errEl = $("formError");
const allDayToggle = $("allDayToggle");
const timeFields = $("timeFields");
const leg = (time) => ({ time, driver: null });

// 送り・お迎えの時間の初期値：送り＝開始時間、お迎え＝終了時間（手で変えたら、それ以降は上書きしない）
let goTouched = false;
let backTouched = false;
function syncRideTimes() {
  if (allDayToggle.checked) return;
  if (!goTouched && form.start.value) form.goTime.value = form.start.value;
  if (!backTouched && form.end.value) form.backTime.value = form.end.value;
}
form.goTime.addEventListener("input", () => { goTouched = true; });
form.backTime.addEventListener("input", () => { backTouched = true; });

// 日時の確認（入力のたびと、保存のときに使う）
function timeProblem() {
  const date = form.date.value, endDate = form.endDate.value;
  if (endDate && date && endDate < date) return "終わりの日を確認してください";
  if (allDayToggle.checked) return "";
  const start = form.start.value, end = form.end.value;
  const oneDay = !endDate || endDate === date;
  // 1日だけの予定で、終了時間が開始時間より前ならだめ（何日か続く予定は、終わりの日の時間なので比べない）
  if (oneDay && start && end && end < start) return "終了時間を確認してください";
  return "";
}
function onTimeInput() {
  syncRideTimes();
  errEl.textContent = timeProblem();
}
for (const name of ["date", "endDate", "start", "end"]) {
  form[name].addEventListener("input", onTimeInput);
  form[name].addEventListener("change", onTimeInput);
}
allDayToggle.addEventListener("change", () => {
  timeFields.hidden = allDayToggle.checked;
  onTimeInput();
});
rideToggle.addEventListener("change", () => {
  rideFields.hidden = !rideToggle.checked;
  syncRideTimes();
});

$("addBtn").addEventListener("click", () => {
  form.reset();
  addPicker.set(me);
  rideFields.hidden = true;
  timeFields.hidden = false;
  goTouched = false;
  backTouched = false;
  errEl.textContent = "";
  form.date.value = ymd(new Date());
  addDialog.showModal();
});
$("cancelAdd").addEventListener("click", () => addDialog.close());

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const member = addPicker.get();
  const title = form.title.value.trim();
  if (!member) return void (errEl.textContent = "誰の予定かを選んでください");
  if (!title || !form.date.value) return void (errEl.textContent = "「何」と「いつ」を入れてください");
  const allDay = allDayToggle.checked;
  if (!allDay && !form.start.value) return void (errEl.textContent = "開始時間を入れてください（時間が無ければ「終日」をオン）");
  const problem = timeProblem();
  if (problem) return void (errEl.textContent = problem);
  const date = form.date.value;
  const endDate = form.endDate.value && form.endDate.value > date ? form.endDate.value : null;

  let ride = null;
  if (rideToggle.checked) {
    const goOn = form.goOn.checked, backOn = form.backOn.checked;
    if (!goOn && !backOn) return void (errEl.textContent = "行き・帰りのどちらかを選んでください");
    if ((goOn && !form.goTime.value) || (backOn && !form.backTime.value)) {
      return void (errEl.textContent = "送迎の時間を入れてください");
    }
    ride = {};
    if (goOn) ride.go = leg(form.goTime.value);
    if (backOn) ride.back = leg(form.backTime.value);
  }

  // 電波が弱くても画面にはすぐ出て、つながったときに保存される
  addDoc(eventsCol, {
    member, title, date, endDate, allDay,
    start: allDay ? null : form.start.value,
    end: allDay ? null : (form.end.value || null),
    ride,
    createdBy: auth.currentUser.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }).catch(saveError);
  addDialog.close();
});

// ---------- 参加（招待コード＋自分を選ぶ） ----------
const joinScreen = $("joinScreen");
const joinForm = $("joinForm");
const joinErr = $("joinError");
const joinPicker = memberPicker($("joinPicker"), null, true);

function showJoin(show, changing = false) {
  joinScreen.hidden = !show;
  viewEl.hidden = show;
  $("addBtn").hidden = show || !me;
  document.querySelector(".tabs").hidden = show;
  $("joinTitle").textContent = changing ? "自分を変える" : "家族グループに参加";
  $("joinCancel").hidden = !changing;
  if (show) { joinErr.textContent = ""; joinPicker.set(changing ? me : null); }
}

function setMe(member) {
  me = normId(member);
  showJoin(false);
  subscribeProfiles();
  render();
}

// ---------- 右上のメニュー ----------
const menuDialog = $("menuDialog");
$("meBtn").addEventListener("click", () => {
  $("menuTitle").textContent = `${memberName(me)}のメニュー`;
  menuDialog.showModal();
});
$("openSwitchMe").addEventListener("click", () => { menuDialog.close(); showJoin(true, true); });
$("openProfiles").addEventListener("click", () => { menuDialog.close(); openProfiles(me); });

// ---------- 名前とアイコン ----------
const profileDialog = $("profileDialog");
const profileForm = $("profileForm");
const profileMsg = $("profileError");
let editing = null;     // 編集中の人
let editingIcon = null; // 選んでいるアイコン

function openProfiles(member) {
  selectProfile(member || "father");
  profileDialog.showModal();
}

function selectProfile(member) {
  editing = member;
  const p = profile(member);
  editingIcon = p.icon;
  profileForm.name.value = p.name;
  profileMsg.className = "error";
  profileMsg.textContent = "";
  drawProfileEditor();
}

function drawProfileEditor() {
  const color = `m-${editing}`;
  $("whoTabs").replaceChildren(...MEMBERS.map((m) => {
    const b = h("button", {
      type: "button", class: `chip m-${m.id}`, "aria-pressed": String(m.id === editing), onclick: () => selectProfile(m.id),
    });
    b.append(iconSvg(profile(m.id).icon, 18), h("span", {}, memberName(m.id)));
    return b;
  }));
  const typed = profileForm.name.value.trim();
  $("profilePreview").className = `preview ${color}`;
  $("profilePreview").replaceChildren(avatar(editing, 88, editingIcon), h("span", { class: "preview-name" }, typed || "　"));
  $("iconGrid").className = `icon-grid ${color}`;
  $("iconGrid").replaceChildren(...ICONS.map((icon) => {
    const b = h("button", {
      type: "button", class: "icon-choice", role: "radio", "aria-checked": String(icon.id === editingIcon),
      "aria-label": icon.name, onclick: () => { editingIcon = icon.id; drawProfileEditor(); },
    });
    b.append(iconSvg(icon.id, 28), h("span", {}, icon.name));
    return b;
  }));
}

profileForm.name.addEventListener("input", () => {
  const typed = profileForm.name.value.trim();
  document.querySelector("#profilePreview .preview-name").textContent = typed || "　";
});
$("closeProfiles").addEventListener("click", () => profileDialog.close());

profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = profileForm.name.value.trim();
  profileMsg.className = "error";
  if (!name) return void (profileMsg.textContent = "名前を入れてください");
  if (charCount(name) > NAME_MAX) return void (profileMsg.textContent = `名前は${NAME_MAX}文字までです`);
  const who = editing;
  profileMsg.textContent = "";
  // 電波が弱くても画面にはすぐ出て、つながったときに保存される
  setDoc(doc(profilesCol, who), {
    name, icon: editingIcon, updatedBy: auth.currentUser.uid, updatedAt: serverTimestamp(),
  }).catch(saveError);
  profileMsg.className = "ok";
  profileMsg.textContent = `${name}を保存しました`;
  drawProfileEditor();
});
$("joinCancel").addEventListener("click", () => showJoin(false));

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = joinForm.code.value.trim();
  const member = joinPicker.get();
  if (!code) return void (joinErr.textContent = "招待コードを入れてください");
  if (!member) return void (joinErr.textContent = "自分を選んでください");
  joinErr.textContent = "確かめています…";
  try {
    await setDoc(memberRef(auth.currentUser.uid), { member, inviteCode: code, joinedAt: serverTimestamp() });
    joinForm.code.value = "";
    setMe(member);
  } catch (err) {
    console.error(err);
    joinErr.textContent = err.code === "permission-denied"
      ? "招待コードが違います"
      : "つながりませんでした。電波の良いところでもう一度試してください";
  }
});

// ---------- 起動：匿名ログイン → 参加済みか確かめる ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    signInAnonymously(auth).catch((err) => {
      console.error(err);
      viewEl.replaceChildren(h("p", { class: "empty" }, "ログインできませんでした。電波を確かめて再読み込みしてください。"));
    });
    return;
  }
  try {
    const snap = await getDoc(memberRef(user.uid));
    if (snap.exists()) setMe(snap.data().member);
    else showJoin(true);
  } catch (err) {
    console.error(err);
    showJoin(true);
  }
});
