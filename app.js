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

const MEMBERS = [
  { id: "papa", name: "パパ" },
  { id: "mama", name: "ママ" },
  { id: "son", name: "長男" },
  { id: "daughter", name: "長女" },
];
const DRIVERS = { papa: "パパ", mama: "ママ" };
const LEG_NAME = { go: "行き", back: "帰り" };
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const memberName = (id) => (MEMBERS.find((m) => m.id === id) || { name: "?" }).name;

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

// ---------- 日付のヘルパー ----------
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const dateLabel = (s) => { const d = new Date(s + "T00:00"); return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`; };

// ---------- 状態 ----------
let events = [];        // Firestore から届いた予定（今日以降）
let me = null;          // 自分（papa / mama / son / daughter）
let loaded = false;     // 最初の読み込みが終わったか
let stopEvents = null;  // リアルタイム更新の停止用
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
const label = (member) => h("span", { class: `label m-${member}` }, memberName(member));
const timeText = (e) => (e.end ? `${e.start}〜${e.end}` : e.start);
const byTime = (a, b) => (a.date === b.date ? toMinutes(a.start) - toMinutes(b.start) : a.date < b.date ? -1 : 1);
const legs = (e) => (e.ride ? ["go", "back"].filter((k) => e.ride[k]) : []);
const hasPending = (e) => legs(e).some((k) => !e.ride[k].driver);

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
function setDriver(e, key, driver) {
  updateDoc(doc(eventsCol, e.id), { [`ride.${key}.driver`]: driver, updatedAt: serverTimestamp() })
    .catch(saveError);
}

// 送迎1件分の表示（未定＝黄色ボタン／確定＝グレー＋取り消し）
function rideRow(e, key) {
  const r = e.ride[key];
  const what = `${LEG_NAME[key]} ${r.time}`;
  if (!r.driver) {
    return h("button", { class: "ride pending", type: "button", onclick: () => openRide(e, key) },
      h("span", { class: "ride-text" }, `${what}　誰が行く？`), "›");
  }
  return h("div", { class: "ride done" },
    h("span", { class: "ride-text" }, `${what}　${DRIVERS[r.driver] || "?"}が行く ✓`),
    h("button", { class: "undo", type: "button", onclick: () => setDriver(e, key, null) }, "取り消し"));
}

// ---------- 画面：今日 ----------
function viewToday() {
  const today = ymd(new Date());
  const list = events.filter((e) => e.date === today).sort(byTime);
  return [
    h("h2", {}, `${dateLabel(today)} の予定`),
    list.length
      ? h("ul", { class: "list" }, list.map((e) =>
          h("li", { class: `event m-${e.member}` },
            h("div", { class: "event-head" }, h("span", { class: "time" }, timeText(e)), label(e.member)),
            h("div", { class: "event-title" }, e.title),
            legs(e).length ? h("div", { class: "rides" }, legs(e).map((k) => rideRow(e, k))) : null)))
      : h("p", { class: "empty" }, "今日の予定はありません"),
  ];
}

// ---------- 画面：週（縦＝曜日、横＝家族。今日から7日間） ----------
function viewWeek() {
  const now = new Date();
  const today = ymd(now);
  const days = Array.from({ length: 7 }, (_, i) => addDays(now, i));

  const head = h("tr", {}, h("th", { class: "day" }, ""), MEMBERS.map((m) => h("th", {}, label(m.id))));
  const rows = days.map((d) => {
    const ds = ymd(d);
    const dow = d.getDay();
    return h("tr", { class: ds === today ? "is-today" : null },
      h("th", { class: `day ${dow === 6 ? "sat" : dow === 0 ? "sun" : ""}`, scope: "row" },
        WEEKDAYS[dow], h("small", {}, `${d.getMonth() + 1}/${d.getDate()}`)),
      MEMBERS.map((m) => h("td", {},
        events.filter((e) => e.date === ds && e.member === m.id).sort(byTime).map((e) =>
          h("div", { class: `mini m-${e.member}${hasPending(e) ? " has-pending" : ""}` },
            h("b", {}, e.start), " ", e.title,
            hasPending(e) ? h("span", { class: "flag" }, "送迎 誰が行く？") : null)))));
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
  const slot = (name, e, showDate) => h("div", { class: "slot" },
    h("span", { class: "slot-name" }, name),
    e ? h("span", {}, h("b", {}, `${showDate ? dateLabel(e.date) + " " : ""}${e.start}`), " ", e.title)
      : h("span", { class: "slot-none" }, "予定なし"));

  return [
    h("h2", {}, "いま と つぎ の予定"),
    h("div", { class: "cards" }, MEMBERS.map((m) => {
      const mine = events.filter((e) => e.member === m.id).sort(byTime);
      const nowEv = mine.find((e) => e.date === today && e.end &&
        toMinutes(e.start) <= nm && nm < toMinutes(e.end));
      const nextEv = mine.find((e) => e !== nowEv &&
        (e.date > today || (e.date === today && toMinutes(e.start) > nm)));
      return h("section", { class: `member m-${m.id}` },
        h("h3", {}, m.name),
        slot("いま", nowEv, false),
        slot("つぎ", nextEv, nextEv && nextEv.date !== today));
    })),
  ];
}

// ---------- 表示の切り替え ----------
const VIEWS = { today: viewToday, week: viewWeek, family: viewFamily };
let current = "today";
const viewEl = $("view");

function render() {
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
function subscribeEvents() {
  if (stopEvents) stopEvents();
  subscribedDay = ymd(new Date());
  const q = query(eventsCol, where("date", ">=", subscribedDay));
  stopEvents = onSnapshot(q, (snap) => {
    events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    loaded = true;
    render();
  }, (err) => {
    console.error(err);
    viewEl.replaceChildren(h("p", { class: "empty" }, "予定を読み込めませんでした。家族グループへの参加をやり直してください。"));
    showJoin(true);
  });
}

// ---------- 送迎の担当決め ----------
const rideDialog = $("rideDialog");
let rideTarget = null;
function openRide(e, key) {
  rideTarget = { e, key };
  $("rideTitle").textContent = `${LEG_NAME[key]}は誰が行く？`;
  $("rideInfo").textContent = `${memberName(e.member)}の「${e.title}」 ${dateLabel(e.date)} ${e.ride[key].time}`;
  rideDialog.showModal();
}
rideDialog.querySelectorAll(".driver").forEach((b) => b.addEventListener("click", () => {
  if (rideTarget) setDriver(rideTarget.e, rideTarget.key, b.dataset.driver);
  rideTarget = null;
  rideDialog.close();
}));
$("cancelRide").addEventListener("click", () => rideDialog.close());

// ---------- メンバーを選ぶボタン（追加画面・参加画面で共用） ----------
function memberPicker(container, onPick) {
  let picked = null;
  const set = (id) => {
    picked = id;
    container.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.member === id)));
    if (onPick) onPick(id);
  };
  MEMBERS.forEach((m) => container.append(h("button", {
    type: "button", class: `chip m-${m.id}`, "aria-pressed": "false", "data-member": m.id, onclick: () => set(m.id),
  }, m.name)));
  return { get: () => picked, set };
}

// ---------- 予定の追加 ----------
const addDialog = $("addDialog");
const form = $("addForm");
const addPicker = memberPicker($("memberPicker"));
const rideToggle = $("rideToggle");
const rideFields = $("rideFields");
const errEl = $("formError");
const leg = (time) => ({ time, driver: null });

rideToggle.addEventListener("change", () => { rideFields.hidden = !rideToggle.checked; });

$("addBtn").addEventListener("click", () => {
  form.reset();
  addPicker.set(me);
  rideFields.hidden = true;
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
  if (!title || !form.date.value || !form.start.value) return void (errEl.textContent = "「何」と「いつ」を入れてください");

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
    member, title, date: form.date.value, start: form.start.value, end: null, ride,
    createdBy: auth.currentUser.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }).catch(saveError);
  addDialog.close();
});

// ---------- 参加（招待コード＋自分を選ぶ） ----------
const joinScreen = $("joinScreen");
const joinForm = $("joinForm");
const joinErr = $("joinError");
const joinPicker = memberPicker($("joinPicker"));

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
  me = member;
  const btn = $("meBtn");
  btn.hidden = false;
  btn.className = `me m-${me}`;
  btn.textContent = `${memberName(me)} ▾`;
  btn.setAttribute("aria-label", `いまは${memberName(me)}として使っています。変える`);
  showJoin(false);
  render();
}

$("meBtn").addEventListener("click", () => showJoin(true, true));
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
