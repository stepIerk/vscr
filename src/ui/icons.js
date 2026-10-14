/**
 * Inline SVG icons — Tabler Icons (MIT license, https://tabler.io/icons).
 * Path data is embedded so there is no runtime network and no bundler plugin.
 * Stroke-based, inherits color via CSS currentColor.
 */
const PATHS = {
  hp: ["M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"],
  atk: ["M20 4v5l-9 7l-4 4l-3 -3l4 -4l7 -9z","M6.5 11.5l6 6"],
  atkSpeed: ["M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"],
  spd: ["M13 4m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M4 17l5 1l.75 -1.5","M15 21l0 -4l-4 -3l1 -6","M7 12l0 -3l5 -1l3 3l3 1"],
  range: ["M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M12 7a5 5 0 1 0 5 5","M13 3.055a9 9 0 1 0 7.941 7.945","M15 6v3h3l3 -3h-3v-3z","M15 9l-3 3"],
  regen: ["M12 20l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.96 6.053","M16 19h6","M19 16v6"],
  bio: ["M5 21c.5 -4.5 2.5 -8 7 -10","M9 18c6.218 0 10.5 -3.288 11 -12v-2h-4.014c-9 0 -11.986 4 -12 9c0 1 0 3 2 5h3z"],
  plasma: ["M7.502 19.423c2.602 2.105 6.395 2.105 8.996 0c2.602 -2.105 3.262 -5.708 1.566 -8.546l-4.89 -7.26c-.42 -.625 -1.287 -.803 -1.936 -.397a1.376 1.376 0 0 0 -.41 .397l-4.893 7.26c-1.695 2.838 -1.035 6.441 1.567 8.546z"],
  lvl: ["M7 11l5 -5l5 5","M7 17l5 -5l5 5"],
  kills: ["M12 4c4.418 0 8 3.358 8 7.5c0 1.901 -.755 3.637 -2 4.96l0 2.54a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1v-2.54c-1.245 -1.322 -2 -3.058 -2 -4.96c0 -4.142 3.582 -7.5 8 -7.5z","M10 17v3","M14 17v3","M9 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M15 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"],
  merge: ["M12 4l-8 4l8 4l8 -4l-8 -4","M4 12l8 4l8 -4","M4 16l8 4l8 -4"],
  kindCell: ["M19.875 6.27a2.225 2.225 0 0 1 1.125 1.948v7.284c0 .809 -.443 1.555 -1.158 1.948l-6.75 4.27a2.269 2.269 0 0 1 -2.184 0l-6.75 -4.27a2.225 2.225 0 0 1 -1.158 -1.948v-7.285c0 -.809 .443 -1.554 1.158 -1.947l6.75 -3.98a2.33 2.33 0 0 1 2.25 0l6.75 3.98h-.033z"],
  kindMut: ["M9 3l6 0","M10 9l4 0","M10 3v6l-4 11a.7 .7 0 0 0 .5 1h11a.7 .7 0 0 0 .5 -1l-4 -11v-6"],
  kindUp: ["M9 12h-3.586a1 1 0 0 1 -.707 -1.707l6.586 -6.586a1 1 0 0 1 1.414 0l6.586 6.586a1 1 0 0 1 -.707 1.707h-3.586v3h-6v-3z","M9 21h6","M9 18h6"],
  mut_metabolism: ["M9 3l6 0","M10 9l4 0","M10 3v6l-4 11a.7 .7 0 0 0 .5 1h11a.7 .7 0 0 0 .5 -1l-4 -11v-6"],
  mut_membrane: ["M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"],
  mut_acid: ["M20 8.04l-12.122 12.124a2.857 2.857 0 1 1 -4.041 -4.04l12.122 -12.124","M7 13h8","M19 15l1.5 1.6a2 2 0 1 1 -3 0l1.5 -1.6z","M15 3l6 6"],
  up_pulse: ["M20 4v5l-9 7l-4 4l-3 -3l4 -4l7 -9z","M6.5 11.5l6 6"],
  up_regen: ["M12 20l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.96 6.053","M16 19h6","M19 16v6"],
  up_adaptation: ["M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3","M12 3v18"],
  up_sync: ["M18 4l3 3l-3 3","M18 20l3 -3l-3 -3","M3 7h3a5 5 0 0 1 5 5a5 5 0 0 0 5 5h5","M21 7h-5a4.978 4.978 0 0 0 -3 1m-4 8a4.984 4.984 0 0 1 -3 1h-3"],
  up_swift: ["M13 4m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M4 17l5 1l.75 -1.5","M15 21l0 -4l-4 -3l1 -6","M7 12l0 -3l5 -1l3 3l3 1"],
  up_swarm: ["M5 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M12 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M19 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M5 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M12 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M19 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"],
  // Плавающие кнопки над нижним баром.
  gather: ["M4 13v-8a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v8a2 2 0 0 0 6 0v-8a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v8a8 8 0 0 1 -16 0","M4 8l5 0","M15 8l4 0"],
  scatter: ["M16 4l4 0l0 4","M14 10l6 -6","M8 20l-4 0l0 -4","M4 20l6 -6","M16 20l4 0l0 -4","M14 14l6 6","M8 4l-4 0l0 4","M4 4l6 6"],
  inventory: ["M3 7m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z","M8 7v-2a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2","M12 12l0 .01","M3 13a20 20 0 0 0 18 0"],
};

export const STAT_ICONS = { hp: "hp", atk: "atk", atkSpeed: "atkSpeed", spd: "spd", range: "range", regen: "regen", bio: "bio", plasma: "plasma", lvl: "lvl", kills: "kills", merge: "merge" };

export const KIND_ICONS = { cell: "kindCell", mutation: "kindMut", upgrade: "kindUp" };

const CARD_ICONS = {
  metabolism: "mut_metabolism", membrane: "mut_membrane", acid: "mut_acid",
  pulse: "up_pulse", regen: "up_regen", adaptation: "up_adaptation",
  sync: "up_sync", swift: "up_swift", swarm: "up_swarm"
};

/** Icon svg markup for a known key. */
export function icon(name, cls = "ico") {
  const paths = PATHS[name];
  if (!paths) return "";
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
}

/** Icon for a card (by kind + card payload). */
export function cardIcon(card) {
  if (!card) return "hexagon";
  if (card.mutation && CARD_ICONS[card.mutation]) return CARD_ICONS[card.mutation];
  if (card.upgrade && CARD_ICONS[card.upgrade]) return CARD_ICONS[card.upgrade];
  if (card.kind && KIND_ICONS[card.kind]) return KIND_ICONS[card.kind];
  return "hexagon";
}

/** Stat chip: icon + value. */
export function stat(iconName, value) {
  return `<span class="stat">${icon(iconName, "ico ico-stat")}<span>${value}</span></span>`;
}
