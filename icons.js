// 家族のアイコン（線画のSVG。色は currentColor＝その人の色で表示）
export const ICONS = [
  {
    id: "cat", name: "ねこ",
    svg: '<path d="M4.5 10 4.5 3.5 9 7h6l4.5-3.5V10"/><path d="M4.5 10c0 5.5 3.4 9.5 7.5 9.5s7.5-4 7.5-9.5"/>' +
      '<circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/>' +
      '<path d="M11 15h2l-1 1.2z"/>',
  },
  {
    id: "rabbit", name: "うさぎ",
    svg: '<path d="M9.6 9.6C8 6.5 7.6 2.5 9.2 2.2s2.4 3.2 2.1 7"/><path d="M14.4 9.6c1.6-3.1 2-7.1.4-7.4s-2.4 3.2-2.1 7"/>' +
      '<circle cx="12" cy="15" r="6"/><circle cx="9.8" cy="14.5" r="1" fill="currentColor" stroke="none"/>' +
      '<circle cx="14.2" cy="14.5" r="1" fill="currentColor" stroke="none"/>',
  },
  {
    id: "bird", name: "とり",
    svg: '<path d="M16 9.5c0-2.5-2-4.5-4.5-4.5S7 7 7 9.5V12c-2 .5-3.5 2.5-3.5 4.5 0 2.5 2 3.5 4.5 3.5h4c3.5 0 6-2.5 6-6v-2l3-1.5-3-1.5"/>' +
      '<circle cx="12" cy="9" r="1" fill="currentColor" stroke="none"/><path d="M8 15.5c1.5 1 3.5 1 5-.5"/>',
  },
  {
    id: "fish", name: "さかな",
    svg: '<path d="M2.5 12c3-4.5 8.5-6 13-2.5L21 6v12l-5.5-3.5c-4.5 3.5-10 2-13-2.5z"/>' +
      '<circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none"/>',
  },
  {
    id: "star", name: "ほし",
    svg: '<path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>',
  },
  {
    id: "flower", name: "はな",
    svg: '<circle cx="12" cy="12" r="2.4"/>' +
      [0, 72, 144, 216, 288].map((a) => `<ellipse cx="12" cy="6.2" rx="2.6" ry="3.4" transform="rotate(${a} 12 12)"/>`).join(""),
  },
  {
    id: "sun", name: "たいよう",
    svg: '<circle cx="12" cy="12" r="4"/>' +
      [0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<path d="M12 2.5v2.6" transform="rotate(${a} 12 12)"/>`).join(""),
  },
  {
    id: "moon", name: "つき",
    svg: '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z"/>',
  },
];

const BY_ID = Object.fromEntries(ICONS.map((i) => [i.id, i]));
export const isIcon = (id) => Object.prototype.hasOwnProperty.call(BY_ID, id);

// アイコンの <svg> 要素を作る（中身はこのファイルの固定の文字だけ）
export function iconSvg(id, size = 20) {
  const icon = BY_ID[id] || ICONS[0];
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = icon.svg;
  return svg;
}

// くり返しの予定の印（2本の矢印の輪）
export function repeatSvg(size = 14) {
  const svg = iconSvg("star", size);
  svg.innerHTML = '<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13"/>' +
    '<path d="M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>';
  svg.setAttribute("stroke-width", "2.2");
  return svg;
}
