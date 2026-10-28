// 日本の祝日（「国民の祝日に関する法律」の決まりで計算する。外のサービスは使わない）
// 対象：2020年〜2099年（春分・秋分の日は計算式による。正式には毎年2月の官報で決まる）
// 法律が変わったら、このファイルを直す。

const pad = (n) => String(n).padStart(2, "0");
const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
// その月の第n月曜日
const nthMonday = (y, m, n) => {
  const firstDow = new Date(y, m - 1, 1).getDay();
  return 1 + ((8 - firstDow) % 7) + (n - 1) * 7;
};
const shunbun = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const shubun = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

// 振替休日・国民の休日を除いた祝日
function baseHolidays(y) {
  const list = [
    [1, 1, "元日"],
    [1, nthMonday(y, 1, 2), "成人の日"],
    [2, 11, "建国記念の日"],
    [2, 23, "天皇誕生日"],
    [3, shunbun(y), "春分の日"],
    [4, 29, "昭和の日"],
    [5, 3, "憲法記念日"],
    [5, 4, "みどりの日"],
    [5, 5, "こどもの日"],
    [9, nthMonday(y, 9, 3), "敬老の日"],
    [9, shubun(y), "秋分の日"],
    [11, 3, "文化の日"],
    [11, 23, "勤労感謝の日"],
  ];
  // 東京オリンピック・パラリンピックの年は日付が動いた
  if (y === 2020) list.push([7, 23, "海の日"], [7, 24, "スポーツの日"], [8, 10, "山の日"]);
  else if (y === 2021) list.push([7, 22, "海の日"], [7, 23, "スポーツの日"], [8, 8, "山の日"]);
  else list.push([7, nthMonday(y, 7, 3), "海の日"], [8, 11, "山の日"], [10, nthMonday(y, 10, 2), "スポーツの日"]);
  return new Map(list.map(([m, d, name]) => [key(y, m, d), name]));
}

const cache = new Map();
function holidaysOf(y) {
  if (cache.has(y)) return cache.get(y);
  const map = baseHolidays(y);
  const dateKey = (d) => key(d.getFullYear(), d.getMonth() + 1, d.getDate());
  // 振替休日：祝日が日曜なら、その後のいちばん近い祝日でない日
  for (const k of [...map.keys()].sort()) {
    const d = new Date(k + "T00:00");
    if (d.getDay() !== 0) continue;
    const x = new Date(d);
    do { x.setDate(x.getDate() + 1); } while (map.has(dateKey(x)));
    if (x.getFullYear() === y) map.set(dateKey(x), "振替休日");
  }
  // 国民の休日：前の日と次の日が祝日にはさまれた日（日曜と祝日は除く）
  for (let m = 0; m < 12; m++) {
    for (let d = 2; d <= 30; d++) {
      const x = new Date(y, m, d);
      if (x.getMonth() !== m || x.getDay() === 0 || map.has(dateKey(x))) continue;
      const prev = new Date(y, m, d - 1), next = new Date(y, m, d + 1);
      const isBase = (t) => map.has(dateKey(t)) && map.get(dateKey(t)) !== "振替休日";
      if (isBase(prev) && isBase(next)) map.set(dateKey(x), "国民の休日");
    }
  }
  cache.set(y, map);
  return map;
}

// "2026-11-03" → "文化の日"（祝日でなければ null）
export function holidayName(ymd) {
  const y = Number(ymd.slice(0, 4));
  if (!(y >= 2020 && y <= 2099)) return null;
  return holidaysOf(y).get(ymd) || null;
}
