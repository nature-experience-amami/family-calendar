// 家族カレンダー（第1段階：データ保存なし・仮データ）
"use strict";

const MEMBERS = [
  { id: "papa", name: "パパ" },
  { id: "mama", name: "ママ" },
  { id: "son", name: "長男" },
  { id: "daughter", name: "長女" },
];
const DRIVERS = { papa: "パパ", mama: "ママ" };
const LEG_NAME = { go: "行き", back: "帰り" };
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const memberName = (id) => MEMBERS.find((m) => m.id === id).name;

// ---------- 日付のヘルパー ----------
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const dateLabel = (s) => { const d = new Date(s + "T00:00"); return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`; };

// ---------- 仮データ（今日を基準に作る） ----------
let nextId = 1;
function ev(member, title, dayOffset, start, end, ride) {
  return { id: nextId++, member, title, date: ymd(addDays(new Date(), dayOffset)), start, end: end || null, ride: ride || null };
}
const leg = (time, driver = null) => ({ time, driver });

const events = [
  ev("papa", "出勤", 0, "08:00", "18:00"),
  ev("mama", "パート", 0, "09:30", "14:00"),
  ev("son", "学校", 0, "08:10", "15:30"),
  ev("daughter", "保育園", 0, "08:30", "16:00", { go: leg("08:15", "mama"), back: leg("16:00") }),
  ev("son", "サッカー練習", 0, "17:00", "18:30", { go: leg("16:40"), back: leg("18:30") }),
  ev("mama", "歯医者", 0, "15:00", "15:45"),
  ev("daughter", "ピアノ", 1, "16:30", "17:15", { go: leg("16:15"), back: leg("17:15", "papa") }),
  ev("papa", "飲み会", 1, "19:00", "21:30"),
  ev("son", "塾", 2, "18:00", "20:00", { back: leg("20:00") }),
  ev("mama", "PTA", 3, "10:00", "11:30"),
  ev("daughter", "スイミング", 4, "17:00", "18:00", { go: leg("16:45", "papa"), back: leg("18:00", "mama") }),
  ev("son", "試合", 5, "09:00", "12:00", { go: leg("08:20") }),
  ev("papa", "ゴルフ", 6, "07:00", "13:00"),
];

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
const label = (member) => h("span", { class: `label m-${member}` }, memberName(member));
const timeText = (e) => (e.end ? `${e.start}〜${e.end}` : e.start);
const byTime = (a, b) => (a.date === b.date ? toMinutes(a.start) - toMinutes(b.start) : a.date < b.date ? -1 : 1);
const legs = (e) => (e.ride ? ["go", "back"].filter((k) => e.ride[k]) : []);
const hasPending = (e) => legs(e).some((k) => !e.ride[k].driver);

// 送迎1件分の表示（未定＝黄色ボタン／確定＝グレー＋取り消し）
function rideRow(e, key) {
  const r = e.ride[key];
  const what = `${LEG_NAME[key]} ${r.time}`;
  if (!r.driver) {
    return h("button", { class: "ride pending", type: "button", onclick: () => openRide(e, key) },
      h("span", { class: "ride-text" }, `${what}　誰が行く？`), "›");
  }
  return h("div", { class: "ride done" },
    h("span", { class: "ride-text" }, `${what}　${DRIVERS[r.driver]}が行く ✓`),
    h("button", { class: "undo", type: "button", onclick: () => { r.driver = null; render(); } }, "取り消し"));
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
const viewEl = document.getElementById("view");

function render() {
  viewEl.replaceChildren(...[VIEWS[current]()].flat());
  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.view === current)));
}
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => { current = t.dataset.view; render(); }));

// ---------- 送迎の担当決め ----------
const rideDialog = document.getElementById("rideDialog");
let rideTarget = null;
function openRide(e, key) {
  rideTarget = { e, key };
  document.getElementById("rideTitle").textContent = `${LEG_NAME[key]}は誰が行く？`;
  document.getElementById("rideInfo").textContent =
    `${memberName(e.member)}の「${e.title}」 ${dateLabel(e.date)} ${e.ride[key].time}`;
  rideDialog.showModal();
}
rideDialog.querySelectorAll(".driver").forEach((b) => b.addEventListener("click", () => {
  if (rideTarget) rideTarget.e.ride[rideTarget.key].driver = b.dataset.driver;
  rideTarget = null;
  rideDialog.close();
  render();
}));
document.getElementById("cancelRide").addEventListener("click", () => rideDialog.close());

// ---------- 予定の追加 ----------
const addDialog = document.getElementById("addDialog");
const form = document.getElementById("addForm");
const picker = document.getElementById("memberPicker");
const rideToggle = document.getElementById("rideToggle");
const rideFields = document.getElementById("rideFields");
const errEl = document.getElementById("formError");
let pickedMember = null;

MEMBERS.forEach((m) => picker.append(h("button", {
  type: "button", class: `chip m-${m.id}`, "aria-pressed": "false", "data-member": m.id,
  onclick: () => {
    pickedMember = m.id;
    picker.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.member === m.id)));
  },
}, m.name)));

rideToggle.addEventListener("change", () => { rideFields.hidden = !rideToggle.checked; });

document.getElementById("addBtn").addEventListener("click", () => {
  form.reset();
  pickedMember = null;
  picker.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
  rideFields.hidden = true;
  errEl.textContent = "";
  form.date.value = ymd(new Date());
  addDialog.showModal();
});
document.getElementById("cancelAdd").addEventListener("click", () => addDialog.close());

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = form.title.value.trim();
  if (!pickedMember) return void (errEl.textContent = "誰の予定かを選んでください");
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

  events.push({ id: nextId++, member: pickedMember, title, date: form.date.value, start: form.start.value, end: null, ride });
  addDialog.close();
  render();
});

render();
