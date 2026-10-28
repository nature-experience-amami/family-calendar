// 家族カレンダー（Firestore に保存・リアルタイム更新）
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, collection, query, where, orderBy, limit, onSnapshot, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig, FAMILY_ID } from "./firebase-config.js";
import { ICONS, iconSvg, isIcon, repeatSvg } from "./icons.js";
import { holidayName } from "./holidays.js";

// 予定や送迎の担当は固定ID（father / mother / son / daughter）でひもづける。
// 名前とアイコン・休みの決まりは profiles に保存され、変えても予定はずれない。
// offDays：いつも休みの曜日（0＝日〜6＝土）、holidayOff：祝日は休みか、work：休みでない日の呼び方
const MEMBERS = [
  { id: "father", name: "父", icon: "sun", offDays: [0, 6], holidayOff: false, work: "仕事" },
  { id: "mother", name: "母", icon: "flower", offDays: [2, 3], holidayOff: false, work: "仕事" },
  { id: "son", name: "長男", icon: "fish", offDays: [0, 6], holidayOff: true, work: "学校" },
  { id: "daughter", name: "長女", icon: "cat", offDays: [0, 6], holidayOff: true, work: "学校" },
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
    offDays: Array.isArray(p.offDays) ? p.offDays : base.offDays || [],
    holidayOff: typeof p.holidayOff === "boolean" ? p.holidayOff : !!base.holidayOff,
  };
};
const workWord = (id) => (MEMBERS.find((m) => m.id === id) || { work: "仕事" }).work;

// ---------- 休みの日 ----------
// いつもの決まり（曜日・祝日）に、その日だけの変更（dayoffs）を重ねて決める
let dayoffs = {}; // "2026-11-03_father" → { off: true / false }
const usualOff = (member, day) => {
  const p = profile(member);
  return p.offDays.includes(new Date(day + "T00:00").getDay()) || (p.holidayOff && !!holidayName(day));
};
const changeOf = (member, day) => dayoffs[`${day}_${member}`];
const isOff = (member, day) => {
  const c = changeOf(member, day);
  return c ? c.off : usualOff(member, day);
};
const offMembers = (day) => MEMBERS.filter((m) => isOff(m.id, day));
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
const dayoffsCol = collection(db, "families", FAMILY_ID, "dayoffs");
const overridesCol = collection(db, "families", FAMILY_ID, "overrides");

// ---------- 日付のヘルパー ----------
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const shiftDay = (s, n) => ymd(addDays(new Date(s + "T00:00"), n)); // "2026-10-25" の n 日後
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00") - new Date(a + "T00:00")) / 86400000);
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const dateLabel = (s) => { const d = new Date(s + "T00:00"); return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`; };

// ---------- 状態 ----------
let events = [];        // Firestore から届いた予定（表示している期間の分）
let me = null;          // 自分（father / mother / son / daughter）
let loaded = false;     // 最初の読み込みが終わったか
let stopProfiles = null;

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

// ---------- くり返しの予定 ----------
// くり返しの予定は1件（元の予定）として保存し、表示している期間の分だけ日ごとに広げる。
//   repeat：{ freq: "daily" | "weekly" | "monthly", days: [曜日…]（毎週のとき）, until: 終わりの日 or null }
//   repeatUntil：読み込みで探すための終わりの日（ずっと続くなら "9999-12-31"）
// その日だけの変更（内容・送迎の担当・削除）は overrides/{元の予定のID}_{日付} に保存する。
const FOREVER = "9999-12-31";
const REPEAT_AHEAD = 92; // 「これからの予定」に、くり返しの予定を何日先まで出すか
const FREQ_NAME = { daily: "毎日", weekly: "毎週", monthly: "毎月" };
const isSeries = (e) => !!(e && e.repeat && FREQ_NAME[e.repeat.freq]);
const copyRide = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
let overrides = {}; // "元の予定のID_日付" → その日だけの変更

function repeatsOn(s, day) {
  if (day < s.date || (s.repeat.until && day > s.repeat.until)) return false;
  const d = new Date(day + "T00:00");
  if (s.repeat.freq === "daily") return true;
  if (s.repeat.freq === "weekly") return (s.repeat.days || []).includes(d.getDay());
  return d.getDate() === Number(s.date.slice(8, 10)); // 毎月：同じ日付（その日が無い月は飛ばす）
}

// くり返しの予定の、ある日の分（その日だけの変更を重ねる）。削除された日は null
function instanceOf(s, day) {
  const ov = overrides[`${s.id}_${day}`];
  if (ov && ov.cancelled) return null;
  const pick = (k) => (ov && k in ov ? ov[k] : s[k]);
  return normEvent({
    id: s.id, series: s, day, date: day, endDate: null, repeat: s.repeat,
    member: pick("member"), title: pick("title"), allDay: pick("allDay") === true,
    start: pick("start") || null, end: pick("end") || null, ride: copyRide(pick("ride")),
  });
}

function expandSeries(list, from, to) {
  const out = [];
  for (const s of list) {
    const last = s.repeat.until && s.repeat.until < to ? s.repeat.until : to;
    for (let day = s.date > from ? s.date : from; day <= last; day = shiftDay(day, 1)) {
      if (!repeatsOn(s, day)) continue;
      const inst = instanceOf(s, day);
      if (inst) out.push(inst);
    }
  }
  return out;
}

const repeatMark = () => h("span", { class: "repeat-mark", title: "くり返しの予定", "aria-label": "くり返し" }, repeatSvg(13));

// ---------- 送迎の担当を保存 ----------
// 以前の版のID（papa / mama）が残っていたら、ついでに新しいIDに直して保存する
function setDriver(e, key, driver) {
  // くり返しの予定は、その日の分だけに保存する（毎週同じ人とは限らないため）
  if (e.series) {
    const ride = copyRide(e.ride);
    ride[key].driver = driver;
    setDoc(doc(overridesCol, `${e.series.id}_${e.day}`), {
      seriesId: e.series.id, date: e.day, ride, updatedBy: auth.currentUser.uid, updatedAt: serverTimestamp(),
    }, { merge: true }).catch(saveError);
    return;
  }
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

// ---------- 予定カード（今日・月の下の一覧で共用） ----------
function eventCard(o) {
  return h("li", { class: `event m-${o.e.member}${o.allDay ? " all-day" : ""}` },
    h("div", { class: "event-head" }, h("span", { class: "time" }, o.text), label(o.e.member),
      isSeries(o.e) ? repeatMark() : null,
      h("button", { type: "button", class: "edit-btn", onclick: () => openEditor(o.e, o.day), "aria-label": `「${o.e.title}」を編集` }, "編集")),
    h("div", { class: "event-title" }, o.e.title),
    isMultiDay(o.e) ? h("div", { class: "range" }, rangeText(o.e)) : null,
    o.legs.length ? h("div", { class: "rides" }, o.legs.map((k) => rideRow(o.e, k))) : null);
}
const dayCards = (list, emptyText) => (list.length
  ? h("ul", { class: "list" }, list.map(eventCard))
  : h("p", { class: "empty" }, emptyText));

// 前・次・戻るのボタン
function navBar(title, prevText, nextText, backText, onMove, atHome) {
  return h("div", { class: "nav" },
    h("div", { class: "nav-row" },
      h("button", { type: "button", class: "btn nav-btn", onclick: () => onMove(-1) }, `‹ ${prevText}`),
      h("h2", { class: "nav-title" }, title),
      h("button", { type: "button", class: "btn nav-btn", onclick: () => onMove(1) }, `${nextText} ›`)),
    h("button", { type: "button", class: "btn nav-home", disabled: atHome, onclick: () => onMove(0) }, backText));
}

// ---------- 祝日と休みの表示（今日・月で共用） ----------
function dayHeading(day, suffix, cls = "") {
  const hol = holidayName(day);
  return h("h2", { class: cls || null }, `${dateLabel(day)} ${suffix}`,
    hol ? h("span", { class: "hol-name" }, hol) : null);
}
function offLine(day) {
  const off = offMembers(day);
  if (!off.length) return null;
  return h("p", { class: "off-line" }, "お休み：",
    off.map((m) => h("span", { class: `off-who m-${m.id}` }, avatar(m.id, 20), memberName(m.id))));
}
// 月の表示で日付を押したときの「お休み」：人ごとに休み／仕事・学校を切り替える
function offEditor(day) {
  return h("ul", { class: "off-editor" }, MEMBERS.map((m) => {
    const off = isOff(m.id, day);
    const changed = !!changeOf(m.id, day);
    return h("li", { class: `off-row m-${m.id}${off ? " is-off" : ""}` },
      avatar(m.id, 28),
      h("span", { class: "off-name" }, memberName(m.id)),
      h("span", { class: "off-state" }, off ? "休み" : workWord(m.id), changed ? h("small", {}, "いつもと違う") : null),
      h("button", { type: "button", class: "btn off-btn", onclick: () => setOff(m.id, day, !off) },
        off ? `${workWord(m.id)}にする` : "休みにする"));
  }));
}
// いつもの決まりと同じに戻すときは、その日だけの変更を消す
function setOff(member, day, off) {
  const ref = doc(dayoffsCol, `${day}_${member}`);
  const job = off === usualOff(member, day)
    ? deleteDoc(ref)
    : setDoc(ref, { member, date: day, off, updatedBy: auth.currentUser.uid, updatedAt: serverTimestamp() });
  job.catch(saveError);
}

// ---------- 画面：今日 ----------
const UPCOMING_STEP = 10;
let upcomingLimit = UPCOMING_STEP;
let upcoming = [];         // 明日以降の予定（日付順、最大 upcomingLimit 件）
let upcomingMore = false;  // まだ先があるか

function viewToday() {
  const today = ymd(new Date());
  const rows = upcoming
    .map((e) => occurrence(e, e.date))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (b.allDay - a.allDay) || (a.from - b.from)));
  let lastDate = null;
  const items = [];
  for (const o of rows) {
    if (o.day !== lastDate) { items.push(h("li", { class: "up-date" }, dateLabel(o.day))); lastDate = o.day; }
    items.push(h("li", {}, h("button", {
      type: "button", class: `up-item m-${o.e.member}${o.pending ? " has-pending" : ""}`,
      onclick: () => openEditor(o.e, o.day),
    },
      h("span", { class: "time" }, o.text),
      avatar(o.e.member, 24),
      h("span", { class: "up-title" }, o.e.title,
        isMultiDay(o.e) ? h("small", {}, `〜${dateLabel(lastDay(o.e))}`) : null,
        isSeries(o.e) ? repeatMark() : null),
      o.pending ? h("span", { class: "flag" }, "送迎 誰が行く？") : null)));
  }
  return [
    dayHeading(today, "の予定"),
    offLine(today),
    dayCards(dayList(today), "今日の予定はありません"),
    h("h2", { class: "section-title" }, "これからの予定"),
    rows.length ? h("ul", { class: "upcoming" }, items) : h("p", { class: "empty" }, "これからの予定はありません"),
    upcomingMore
      ? h("button", { type: "button", class: "btn more", onclick: () => { upcomingLimit += UPCOMING_STEP; render(); } }, "もっと見る")
      : rows.length ? h("p", { class: "the-end" }, "これより先の予定はありません") : null,
  ];
}

// ---------- 画面：週（縦＝曜日、横＝家族。7日ずつ移動） ----------
let weekOffset = 0; // 0＝今日から7日間、1＝その次の7日間…
const weekStart = () => shiftDay(ymd(new Date()), weekOffset * 7);

function viewWeek() {
  const today = ymd(new Date());
  const start = weekStart();
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(start, i));

  const head = h("tr", {}, h("th", { class: "day" }, ""), MEMBERS.map((m) => h("th", { class: `m-${m.id}` },
    h("div", { class: "who" }, avatar(m.id, 28), h("span", {}, memberName(m.id))))));
  const rows = days.map((ds) => {
    const d = new Date(ds + "T00:00");
    const dow = d.getDay();
    const hol = holidayName(ds);
    return h("tr", { class: ds === today ? "is-today" : null },
      h("th", { class: `day ${dow === 0 || hol ? "sun" : dow === 6 ? "sat" : ""}`, scope: "row" },
        WEEKDAYS[dow], h("small", {}, `${d.getMonth() + 1}/${d.getDate()}`),
        hol ? h("small", { class: "hol-name" }, hol) : null),
      MEMBERS.map((m) => h("td", { class: isOff(m.id, ds) ? "is-off" : null },
        isOff(m.id, ds) ? h("span", { class: "off-badge" }, "休") : null,
        dayList(ds, m.id).map((o) =>
          h("div", { class: `mini m-${o.e.member}${o.allDay ? " all-day" : ""}${o.pending ? " has-pending" : ""}` },
            h("b", {}, o.text), " ", o.e.title, isSeries(o.e) ? repeatMark() : null,
            o.pending ? h("span", { class: "flag" }, "送迎 誰が行く？") : null)))));
  });

  return [
    navBar(`${dateLabel(days[0])} 〜 ${dateLabel(days[6])}`, "前の週", "次の週", "今日に戻る",
      (n) => { weekOffset = n === 0 ? 0 : weekOffset + n; render(); }, weekOffset === 0),
    h("div", { class: "week-wrap" }, h("table", { class: "week" }, h("thead", {}, head), h("tbody", {}, rows))),
  ];
}

// ---------- 画面：月 ----------
let monthOffset = 0;     // 0＝今月
let selectedDay = null;  // 月の表示で押した日
function monthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return { first: ymd(first), last: ymd(last), year: first.getFullYear(), month: first.getMonth() + 1, lead: first.getDay(), days: last.getDate() };
}

function viewMonth() {
  const today = ymd(new Date());
  const r = monthRange();
  if (!selectedDay || selectedDay < r.first || selectedDay > r.last) {
    selectedDay = today >= r.first && today <= r.last ? today : r.first;
  }
  const cells = [];
  for (let i = 0; i < r.lead; i++) cells.push(h("div", { class: "mcell blank", "aria-hidden": "true" }));
  for (let n = 1; n <= r.days; n++) {
    const ds = `${r.year}-${pad(r.month)}-${pad(n)}`;
    const list = dayList(ds);
    const who = MEMBERS.filter((m) => list.some((o) => o.e.member === m.id));
    const pending = list.some((o) => o.pending);
    const dow = (r.lead + n - 1) % 7;
    const names = who.map((m) => memberName(m.id)).join("・");
    const hol = holidayName(ds);
    cells.push(h("button", {
      type: "button",
      class: `mcell${ds === today ? " is-today" : ""}${ds === selectedDay ? " is-selected" : ""}${dow === 0 || hol ? " sun" : dow === 6 ? " sat" : ""}`,
      "aria-pressed": String(ds === selectedDay),
      "aria-label": `${r.month}月${n}日${hol ? "（" + hol + "）" : ""}${names ? "、" + names + "の予定" : "、予定なし"}${pending ? "、送迎が未定" : ""}`,
      onclick: () => { selectedDay = ds; render(); },
    },
      h("span", { class: "mnum" }, n),
      hol ? h("span", { class: "mhol" }, hol) : null,
      pending ? h("span", { class: "mpending", title: "送迎が未定" }, "!") : null,
      h("span", { class: "dots" }, who.map((m) => h("span", { class: `dot m-${m.id}` })))));
  }
  return [
    navBar(`${r.year}年${r.month}月`, "前の月", "次の月", "今月に戻る",
      (n) => { monthOffset = n === 0 ? 0 : monthOffset + n; selectedDay = null; render(); }, monthOffset === 0),
    h("div", { class: "month" },
      WEEKDAYS.map((w, i) => h("div", { class: `mhead${i === 0 ? " sun" : i === 6 ? " sat" : ""}` }, w)),
      cells),
    h("p", { class: "legend" }, h("span", { class: "mpending" }, "!"), " は送迎が未定の予定がある日"),
    dayHeading(selectedDay, "の予定", "section-title"),
    dayCards(dayList(selectedDay), "この日の予定はありません"),
    h("h3", { class: "sub-title" }, "お休み"),
    offEditor(selectedDay),
  ];
}

// ---------- 画面：家族（いま／つぎ） ----------
const FAMILY_DAYS = 60; // 「つぎ」を探す範囲（今日から何日先まで）
function viewFamily() {
  const today = ymd(new Date());
  const nm = nowMinutes();
  const slot = (name, timeLabel, e, none = "予定なし") => h("div", { class: "slot" },
    h("span", { class: "slot-name" }, name),
    e ? h("span", {}, h("b", {}, timeLabel), " ", e.title)
      : h("span", { class: "slot-none" }, none));

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
        h("h3", {}, avatar(m.id, 40), memberName(m.id),
          isOff(m.id, today) ? h("span", { class: "off-badge" }, "今日はお休み") : null),
        slot("いま", nowOcc ? nowOcc.text : "", nowOcc && nowOcc.e),
        slot("つぎ", nextLabel, nextEv, `${FAMILY_DAYS}日先まで予定なし`));
    })),
  ];
}

// ---------- 表示の切り替え ----------
const VIEWS = { today: viewToday, week: viewWeek, month: viewMonth, family: viewFamily };
let current = "today";
const viewEl = $("view");

function render() {
  refreshNames();
  if (!me) return;
  watchForView();
  // 画面の部品のうち「無し」（null・false など）は並べない（そのまま渡すと「null」と文字で出てしまう）
  const parts = loaded ? [VIEWS[current]()].flat().filter((c) => c instanceof Node) : [h("p", { class: "empty" }, "読み込み中…")];
  viewEl.replaceChildren(...parts);
  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.view === current)));
}
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => { current = t.dataset.view; render(); }));
// 「いま」の表示を1分ごとに更新・アプリに戻ったときも更新（日付が変わったら読み込む範囲も変わる）
setInterval(render, 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

// ---------- 読み込み（表示している期間の分だけ・リアルタイム更新） ----------
// 何日か続く予定の長さの上限。「終わりの日」がこの日数より先の予定は作れない。
// （始まりの日が表示期間より前でも、終わりの日で探せば見つかるように、探す幅を決めておく）
const SPAN_MAX = 62;
let watching = {}; // 名前 → { key, stop, docs }

// 表示している期間の予定を読む2つの問い合わせ
//   starts：期間中に始まる予定
//   continues：期間より前に始まって、期間中まで続く予定（終わりの日で探す）
function rangeQueries(from, to) {
  return {
    starts: { key: `s|${from}|${to}`, q: () => query(eventsCol, where("date", ">=", from), where("date", "<=", to)) },
    continues: {
      key: `c|${from}|${to}`,
      q: () => query(eventsCol, where("endDate", ">=", from), where("endDate", "<=", shiftDay(to, SPAN_MAX))),
    },
  };
}

// その日だけの休みの変更（表示している期間の分）
const dayoffQuery = (from, to) => ({
  dayoffs: { kind: "dayoffs", key: `d|${from}|${to}`, q: () => query(dayoffsCol, where("date", ">=", from), where("date", "<=", to)) },
});

// くり返しの予定：期間の始まりより後まで続くもの（repeatUntil で探す）と、その日だけの変更
const repeatQueries = (from, to) => ({
  series: { key: `r|${from}`, q: () => query(eventsCol, where("repeatUntil", ">=", from)) },
  overrides: {
    kind: "overrides", key: `o|${from}|${to}`,
    q: () => query(overridesCol, where("date", ">=", from), where("date", "<=", to)),
  },
});

let viewRange = { from: "", to: "" }; // 予定を日ごとに広げる期間
function wantedForView() {
  const today = ymd(new Date());
  if (current === "week") {
    const from = weekStart(), to = shiftDay(weekStart(), 6);
    viewRange = { from, to };
    return { ...rangeQueries(from, to), ...dayoffQuery(from, to), ...repeatQueries(from, to) };
  }
  if (current === "month") {
    const r = monthRange();
    viewRange = { from: r.first, to: r.last };
    return { ...rangeQueries(r.first, r.last), ...dayoffQuery(r.first, r.last), ...repeatQueries(r.first, r.last) };
  }
  if (current === "family") {
    viewRange = { from: today, to: shiftDay(today, FAMILY_DAYS) };
    return { ...rangeQueries(today, viewRange.to), ...dayoffQuery(today, today), ...repeatQueries(today, viewRange.to) };
  }
  viewRange = { from: today, to: today };
  return {
    ...rangeQueries(today, today),
    ...dayoffQuery(today, today),
    ...repeatQueries(today, shiftDay(today, REPEAT_AHEAD)),
    upcoming: {
      key: `u|${today}|${upcomingLimit}`,
      q: () => query(eventsCol, where("date", ">", today), orderBy("date"), limit(upcomingLimit)),
    },
  };
}

function watchForView() {
  const wanted = wantedForView();
  let changed = false;
  for (const name of Object.keys(watching)) {
    if (!wanted[name] || wanted[name].key !== watching[name].key) {
      watching[name].stop();
      delete watching[name];
      changed = true;
    }
  }
  for (const [name, w] of Object.entries(wanted)) {
    if (watching[name]) continue;
    changed = true;
    // 表示する期間が変わったときは、そろうまで「読み込み中」（「もっと見る」のときは今の表示を残す）
    if (name !== "upcoming") loaded = false;
    const entry = { key: w.key, kind: w.kind || "events", docs: null };
    entry.stop = onSnapshot(w.q(), (snap) => {
      if (watching[name] !== entry) return; // もう使っていない問い合わせ
      entry.docs = entry.kind === "events"
        ? snap.docs.map((d) => normEvent({ id: d.id, ...d.data() }))
        : snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      mergeWatched();
    }, (err) => {
      console.error(err);
      viewEl.replaceChildren(h("p", { class: "empty" }, "予定を読み込めませんでした。家族グループへの参加をやり直してください。"));
      showJoin(true);
    });
    watching[name] = entry;
  }
  if (changed) mergeWatched(false);
}

// 届いた分を合わせて画面へ（全部そろってから）
function mergeWatched(draw = true) {
  const all = Object.values(watching);
  if (!all.length || all.some((w) => !w.docs)) return;
  const byId = new Map();
  for (const w of all) if (w.kind === "events") for (const e of w.docs) byId.set(e.id, e);
  dayoffs = {};
  for (const w of all) if (w.kind === "dayoffs") for (const d of w.docs) if (typeof d.off === "boolean") dayoffs[d.id] = d;
  overrides = {};
  for (const w of all) if (w.kind === "overrides") for (const d of w.docs) overrides[d.id] = d;
  // 普通の予定はそのまま、くり返しの予定は表示している期間の日ごとに広げる
  const docs = [...byId.values()];
  const seriesList = docs.filter(isSeries);
  events = [...docs.filter((e) => !isSeries(e)), ...expandSeries(seriesList, viewRange.from, viewRange.to)];
  if (watching.upcoming) {
    // 明日以降：普通の予定（件数で区切って読む）と、くり返しの予定（REPEAT_AHEAD 日先まで）を合わせて日付順に
    const raw = watching.upcoming.docs;
    const rawMore = raw.length >= upcomingLimit;
    const today = ymd(new Date());
    let horizon = shiftDay(today, REPEAT_AHEAD);
    if (rawMore && raw.length && raw[raw.length - 1].date < horizon) horizon = raw[raw.length - 1].date;
    const list = [...raw.filter((e) => !isSeries(e)), ...expandSeries(seriesList, shiftDay(today, 1), horizon)]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
        : (isAllDay(b) - isAllDay(a)) || ((a.start ? toMinutes(a.start) : 0) - (b.start ? toMinutes(b.start) : 0))));
    upcoming = list.slice(0, upcomingLimit);
    upcomingMore = rawMore || list.length > upcomingLimit;
  }
  loaded = true;
  if (draw) render();
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

// ---------- 予定の追加・編集・削除 ----------
const addDialog = $("addDialog");
const form = $("addForm");
const addPicker = memberPicker($("memberPicker"));
const rideToggle = $("rideToggle");
const rideFields = $("rideFields");
const errEl = $("formError");
const allDayToggle = $("allDayToggle");
const timeFields = $("timeFields");
const leg = (time) => ({ time, driver: null });

let editTarget = null; // 編集中の予定（新しく追加するときは null）
let editDay = null;    // 編集中の日（くり返しの予定のときは、押した日）
let repeatFreq = "none";
let repeatDays = [];

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

// くり返しの入力
function drawRepeat() {
  $("repeatSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.freq === repeatFreq)));
  const on = repeatFreq !== "none";
  $("repeatDays").hidden = repeatFreq !== "weekly";
  $("repeatUntilBox").hidden = !on;
  $("endDateBox").hidden = on; // くり返しの予定は1日ずつ（何日か続く予定にはしない）
  const md = form.date.value ? Number(form.date.value.slice(8, 10)) : null;
  $("repeatMonthly").hidden = repeatFreq !== "monthly";
  $("repeatMonthly").textContent = md ? `毎月${md}日（${md}日が無い月は飛ばします）` : "";
  $("repeatDays").replaceChildren(...WEEKDAYS.map((w, i) => h("button", {
    type: "button", class: "offday", "aria-pressed": String(repeatDays.includes(i)), "aria-label": `${w}曜日`,
    onclick: () => {
      repeatDays = repeatDays.includes(i) ? repeatDays.filter((x) => x !== i) : [...repeatDays, i].sort();
      drawRepeat();
    },
  }, w)));
}
$("repeatSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  repeatFreq = b.dataset.freq;
  if (repeatFreq === "weekly" && !repeatDays.length && form.date.value) repeatDays = [new Date(form.date.value + "T00:00").getDay()];
  drawRepeat();
  errEl.textContent = timeProblem();
}));

// 日時の確認（入力のたびと、保存のときに使う）
function timeProblem() {
  const date = form.date.value;
  const endDate = repeatFreq === "none" ? form.endDate.value : "";
  if (endDate && date && endDate < date) return "終わりの日を確認してください";
  if (endDate && date && daysBetween(date, endDate) > SPAN_MAX) return `終わりの日は${SPAN_MAX}日先までにしてください`;
  if (repeatFreq !== "none" && form.repeatUntil.value && date && form.repeatUntil.value < date) return "くり返しの終わりの日を確認してください";
  if (allDayToggle.checked) return "";
  const start = form.start.value, end = form.end.value;
  const oneDay = !endDate || endDate === date;
  // 1日だけの予定で、終了時間が開始時間より前ならだめ（何日か続く予定は、終わりの日の時間なので比べない）
  if (oneDay && start && end && end < start) return "終了時間を確認してください";
  return "";
}
function onTimeInput() {
  syncRideTimes();
  if (repeatFreq === "monthly") drawRepeat();
  errEl.textContent = timeProblem();
}
for (const name of ["date", "endDate", "start", "end", "repeatUntil"]) {
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

// 追加（e なし）・編集（e＝押した予定、day＝その日）の画面を開く
function openEditor(e = null, day = null) {
  form.reset();
  editTarget = e;
  editDay = day;
  errEl.textContent = "";
  goTouched = !!e;
  backTouched = !!e;
  $("editorTitle").textContent = e ? "予定を編集" : "予定を追加";
  $("deleteEvent").hidden = !e;
  const src = e && e.series ? e.series : e;
  repeatFreq = isSeries(src) ? src.repeat.freq : "none";
  repeatDays = isSeries(src) && src.repeat.freq === "weekly" ? [...src.repeat.days] : [];
  if (!e) {
    addPicker.set(me);
    form.date.value = ymd(new Date());
  } else {
    addPicker.set(e.member);
    form.title.value = e.title;
    form.date.value = e.series ? day : e.date;
    form.endDate.value = !e.series && e.endDate ? e.endDate : "";
    allDayToggle.checked = isAllDay(e);
    form.start.value = e.start || "";
    form.end.value = e.end || "";
    form.repeatUntil.value = isSeries(src) && src.repeat.until ? src.repeat.until : "";
    rideToggle.checked = !!e.ride;
    form.goOn.checked = !!(e.ride && e.ride.go);
    form.backOn.checked = !!(e.ride && e.ride.back);
    form.goTime.value = e.ride && e.ride.go ? e.ride.go.time : "";
    form.backTime.value = e.ride && e.ride.back ? e.ride.back.time : "";
  }
  timeFields.hidden = allDayToggle.checked;
  rideFields.hidden = !rideToggle.checked;
  drawRepeat();
  addDialog.showModal();
}
$("addBtn").addEventListener("click", () => openEditor());
$("cancelAdd").addEventListener("click", () => addDialog.close());

// 選ぶ画面（「この日だけ／これ以降すべて」や削除の確認）。選んだ値を返す（やめたら null）
const chooseDialog = $("chooseDialog");
function choose(title, info, options) {
  return new Promise((resolve) => {
    $("chooseTitle").textContent = title;
    $("chooseInfo").textContent = info;
    const done = (v) => { chooseDialog.close(); resolve(v); };
    $("chooseButtons").replaceChildren(
      ...options.map((o) => h("button", { type: "button", class: `btn ${o.cls || ""}`, onclick: () => done(o.value) }, o.label)),
      h("button", { type: "button", class: "btn ghost", onclick: () => done(null) }, "やめる"));
    chooseDialog.onclose = () => resolve(null);
    chooseDialog.showModal();
  });
}
const scopeOptions = (verb) => [
  { value: "this", label: `この日だけ${verb}` },
  { value: "future", label: `これ以降すべて${verb}` },
];

// 入力を読み取る（だめなら errEl に書いて null）
function readForm() {
  const member = addPicker.get();
  const title = form.title.value.trim();
  if (!member) return void (errEl.textContent = "誰の予定かを選んでください");
  if (!title || !form.date.value) return void (errEl.textContent = "「何」と「いつ」を入れてください");
  const allDay = allDayToggle.checked;
  if (!allDay && !form.start.value) return void (errEl.textContent = "開始時間を入れてください（時間が無ければ「終日」をオン）");
  if (repeatFreq === "weekly" && !repeatDays.length) return void (errEl.textContent = "くり返す曜日を選んでください");
  const problem = timeProblem();
  if (problem) return void (errEl.textContent = problem);
  const date = form.date.value;
  const repeating = repeatFreq !== "none";
  const endDate = !repeating && form.endDate.value && form.endDate.value > date ? form.endDate.value : null;

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
  const until = repeating && form.repeatUntil.value ? form.repeatUntil.value : null;
  return {
    member, title, date, endDate, allDay,
    start: allDay ? null : form.start.value,
    end: allDay ? null : (form.end.value || null),
    ride,
    repeat: repeating ? { freq: repeatFreq, days: repeatFreq === "weekly" ? repeatDays : [], until } : null,
    repeatUntil: repeating ? until || FOREVER : null,
  };
}

// 送迎の担当は、同じ行き・帰りが残っていれば引き継ぐ
function keepDrivers(ride, old) {
  if (!ride || !old) return ride;
  for (const k of ["go", "back"]) if (ride[k] && old[k]) ride[k].driver = old[k].driver || null;
  return ride;
}
const uid = () => auth.currentUser.uid;
const newDoc = (v) => ({ ...v, createdBy: uid(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const v = readForm();
  if (!v) return;
  const e = editTarget;
  // 電波が弱くても画面にはすぐ出て、つながったときに保存される（失敗したらお知らせを出す）
  try {
    if (!e) {
      addDoc(eventsCol, newDoc(v)).catch(saveError);
    } else if (!e.series) {
      // 普通の予定の編集
      if (v.repeat) v.endDate = null;
      updateDoc(doc(eventsCol, e.id), { ...v, ride: v.repeat ? v.ride : keepDrivers(v.ride, e.ride), updatedAt: serverTimestamp() })
        .catch(saveError);
    } else {
      const scope = await choose("くり返しの予定を変える", `${e.title}（${dateLabel(editDay)}）`, scopeOptions("変える"));
      if (!scope) return;
      if (scope === "this") await saveThisDay(e, v);
      else await saveFuture(e, v);
    }
    addDialog.close();
  } catch (err) {
    saveError(err);
  }
});

// この日だけ変える：日付を変えなければ、その日の変更として保存。日付を変えたら、その日を消して普通の予定を作る
async function saveThisDay(e, v) {
  const s = e.series;
  const ref = doc(overridesCol, `${s.id}_${editDay}`);
  if (v.date === editDay) {
    setDoc(ref, {
      seriesId: s.id, date: editDay, cancelled: false,
      member: v.member, title: v.title, allDay: v.allDay, start: v.start, end: v.end, ride: keepDrivers(v.ride, e.ride),
      updatedBy: uid(), updatedAt: serverTimestamp(),
    }).catch(saveError);
  } else {
    const batch = writeBatch(db);
    batch.set(ref, { seriesId: s.id, date: editDay, cancelled: true, updatedBy: uid(), updatedAt: serverTimestamp() });
    batch.set(doc(eventsCol), newDoc({ ...v, ride: keepDrivers(v.ride, e.ride), repeat: null, repeatUntil: null }));
    batch.commit().catch(saveError);
  }
}

// これ以降すべて変える：最初の日からなら元の予定を直す。途中からなら、前の日で終わらせて新しく作る
async function saveFuture(e, v) {
  const s = e.series;
  const tidy = (x) => ({ ...x, endDate: null, ride: x.ride });
  if (editDay <= s.date) {
    updateDoc(doc(eventsCol, s.id), { ...tidy(v), updatedAt: serverTimestamp() }).catch(saveError);
    return;
  }
  const until = shiftDay(editDay, -1);
  const batch = writeBatch(db);
  batch.update(doc(eventsCol, s.id), { repeat: { ...s.repeat, until }, repeatUntil: until, updatedAt: serverTimestamp() });
  const newRef = doc(eventsCol);
  batch.set(newRef, newDoc(tidy(v)));
  // その日以降に決めた送迎の担当などを、新しい予定へ引き継ぐ（日付を動かしたときは引き継がない）
  if (v.repeat && v.date === editDay) {
    const snap = await getDocs(query(overridesCol, where("seriesId", "==", s.id)));
    snap.forEach((d) => {
      const ov = d.data();
      if (ov.date < editDay) return;
      batch.set(doc(overridesCol, `${newRef.id}_${ov.date}`), { ...ov, seriesId: newRef.id, updatedBy: uid(), updatedAt: serverTimestamp() });
    });
  }
  batch.commit().catch(saveError);
}

$("deleteEvent").addEventListener("click", async () => {
  const e = editTarget;
  if (!e) return;
  try {
    if (!e.series) {
      const ok = await choose("予定を削除", `「${e.title}」を削除しますか？`, [{ value: "yes", label: "削除する", cls: "danger" }]);
      if (!ok) return;
      deleteDoc(doc(eventsCol, e.id)).catch(saveError);
    } else {
      const s = e.series;
      const scope = await choose("くり返しの予定を削除", `${e.title}（${dateLabel(editDay)}）`,
        scopeOptions("削除").map((o) => ({ ...o, cls: "danger" })));
      if (!scope) return;
      if (scope === "this") {
        setDoc(doc(overridesCol, `${s.id}_${editDay}`), {
          seriesId: s.id, date: editDay, cancelled: true, updatedBy: uid(), updatedAt: serverTimestamp(),
        }).catch(saveError);
      } else if (editDay <= s.date) {
        deleteDoc(doc(eventsCol, s.id)).catch(saveError);
      } else {
        const until = shiftDay(editDay, -1);
        updateDoc(doc(eventsCol, s.id), { repeat: { ...s.repeat, until }, repeatUntil: until, updatedAt: serverTimestamp() })
          .catch(saveError);
      }
    }
    addDialog.close();
  } catch (err) {
    saveError(err);
  }
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
let editingOffDays = [];       // 休みの曜日
let editingHolidayOff = false; // 祝日は休みか

function openProfiles(member) {
  selectProfile(member || "father");
  profileDialog.showModal();
}

function selectProfile(member) {
  editing = member;
  const p = profile(member);
  editingIcon = p.icon;
  editingOffDays = [...p.offDays];
  editingHolidayOff = p.holidayOff;
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
  $("offDayGrid").className = `offday-grid ${color}`;
  $("offDayGrid").replaceChildren(...WEEKDAYS.map((w, i) => h("button", {
    type: "button", class: "offday", "aria-pressed": String(editingOffDays.includes(i)), "aria-label": `${w}曜日`,
    onclick: () => {
      editingOffDays = editingOffDays.includes(i) ? editingOffDays.filter((x) => x !== i) : [...editingOffDays, i].sort();
      drawProfileEditor();
    },
  }, w)));
  $("holidayOffToggle").checked = editingHolidayOff;
}
$("holidayOffToggle").addEventListener("change", (e) => { editingHolidayOff = e.target.checked; });

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
    name, icon: editingIcon, offDays: editingOffDays, holidayOff: editingHolidayOff,
    updatedBy: auth.currentUser.uid, updatedAt: serverTimestamp(),
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
