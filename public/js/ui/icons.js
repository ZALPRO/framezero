/**
 * icons.js — the one icon set in the product.
 *
 * Every glyph is inline SVG on a 24×24 grid, 1.7 stroke, round caps, drawn in
 * `currentColor` so it inherits state colour (hover, active, disabled) exactly
 * like text. No icon font, no emoji: emoji render differently on every OS and
 * cannot be aligned to a 1.7px stroke grid, which is why a mixed set always
 * looks borrowed. Filled parts carry fill="currentColor" stroke="none"
 * explicitly — CSS must not override presentation attributes here.
 */

const S = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const F = 'fill="currentColor" stroke="none"';

export const ICONS = {
  /* transport */
  start: `<path ${S} d="M6.5 5v14"/><path ${F} d="M18 6.2v11.6L9.4 12z"/>`,
  prevKey: `<path ${S} d="M13.5 6.5L7.5 12l6 5.5z"/><path ${S} d="M18.6 8.4l3 3.6-3 3.6-3-3.6z"/>`,
  play: `<path ${F} d="M8.2 5.4v13.2L19 12z"/>`,
  pause: `<path ${F} d="M8 5.5h3v13H8zM13.5 5.5h3v13h-3z"/>`,
  nextKey: `<path ${S} d="M10.5 6.5l6 5.5-6 5.5z"/><path ${S} d="M5.4 8.4l-3 3.6 3 3.6 3-3.6z"/>`,
  end: `<path ${S} d="M17.5 5v14"/><path ${F} d="M6 6.2v11.6L14.6 12z"/>`,
  loop: `<path ${S} d="M17.5 8.5A6.5 6.5 0 1 0 19 12"/><path ${F} d="M17.9 4.6l2.6 4.2-4.9.5z"/>`,

  /* layer kinds */
  text: `<path ${S} d="M6.5 7.5V6h11v1.5M12 6v12M10 18h4"/>`,
  shape: `<path ${S} d="M4.5 4.5h9v9h-9z"/><path ${S} d="M14.5 10.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/>`,
  solid: `<path ${F} d="M5 5h14v14H5z" opacity=".9"/>`,
  image: `<path ${S} d="M4 5.5h16v13H4z"/><path ${S} d="M4 15l4.5-4.5L13 15l3-3 4 4"/><circle ${S} cx="9" cy="9.5" r="1.6"/>`,
  video: `<path ${S} d="M4 6h11v12H4z"/><path ${F} d="M15 10.4l5-2.9v9l-5-2.9z"/>`,
  audio: `<path ${S} d="M4 10.5v3M7.5 7.5v9M11 5v14M14.5 8.5v7M18 10v4M21 11.5v1"/>`,
  file: `<path ${S} d="M7 3.5h7l4 4v13H7z"/><path ${S} d="M14 3.5v4h4"/>`,

  /* actions */
  plus: `<path ${S} d="M12 5.5v13M5.5 12h13"/>`,
  x: `<path ${S} d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
  eye: `<path ${S} d="M3 12s3.6-6 9-6 9 6 9 6-3.6 6-9 6-9-6-9-6z"/><circle ${S} cx="12" cy="12" r="2.6"/>`,
  eyeOff: `<path ${S} d="M4 4l16 16M9.9 5.2A9.8 9.8 0 0 1 12 6c5.4 0 9 6 9 6a17 17 0 0 1-2.7 3.3M6.3 6.9A16.6 16.6 0 0 0 3 12s3.6 6 9 6a9.3 9.3 0 0 0 4-.9"/>`,
  lock: `<path ${S} d="M6.5 10.5h11V20h-11z"/><path ${S} d="M9 10.5V8a3 3 0 0 1 6 0v2.5"/>`,
  unlock: `<path ${S} d="M6.5 10.5h11V20h-11z"/><path ${S} d="M9 10.5V8a3 3 0 0 1 5.8-1"/>`,
  solo: `<circle ${S} cx="12" cy="12" r="7.5"/><circle ${F} cx="12" cy="12" r="2.6"/>`,
  trash: `<path ${S} d="M5 7h14M9.5 7V5h5v2M7 7l1 13h8l1-13M10.5 10.5v6M13.5 10.5v6"/>`,
  copy: `<path ${S} d="M8.5 8.5h11v11h-11z"/><path ${S} d="M15.5 8.5v-4h-11v11h4"/>`,
  refresh: `<path ${S} d="M19 12a7 7 0 1 1-2-4.9"/><path ${F} d="M19.6 3.8l.5 4.8-4.7-1z"/>`,
  reset: `<path ${S} d="M5 12a7 7 0 1 0 2-4.9"/><path ${F} d="M4.4 3.8l-.5 4.8 4.7-1z"/>`,
  gauge: `<path ${S} d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path ${S} d="M12 13.5l4-4.5"/><circle ${F} cx="12" cy="14" r="1.6"/>`,
  bolt: `<path ${F} d="M13.5 3L5.5 13.5h5L10 21l8.5-10.5h-5z"/>`,
  folder: `<path ${S} d="M3.5 6.5h6l2 2.5h9v10h-17z"/>`,
  save: `<path ${S} d="M5 4h11l3 3v13H5z"/><path ${S} d="M8.5 4v5h7V4M8.5 20v-6h7v6"/>`,
  exportImg: `<path ${S} d="M4 6.5h10v11H4z"/><path ${S} d="M4 14l3.5-3.5L11 14l2-2 1 1"/><path ${S} d="M17.5 4v9M14.8 6.7L17.5 4l2.7 2.7"/>`,
  exportVid: `<path ${S} d="M4 7h9v10H4z"/><path ${F} d="M13 10.6l4.5-2.6v8L13 13.4z"/><path ${S} d="M20 4v9M17.3 6.7L20 4l2.7 2.7"/>`,
  command: `<path ${S} d="M9 9V7.5a2.5 2.5 0 1 0-2.5 2.5H9zm0 0h6m-6 0v6m6-6V7.5A2.5 2.5 0 1 1 17.5 10H15zm0 6H9m6 0v1.5a2.5 2.5 0 1 0 2.5-2.5H15zm-6 0v1.5A2.5 2.5 0 1 1 6.5 14H9z"/>`,
  mask: `<path ${S} d="M4 5.5h16v13H4z" stroke-dasharray="3 2.6"/><path ${S} d="M12 8.2a3.8 5.4 0 1 1 0 7.6 3.8 5.4 0 0 1 0-7.6z"/>`,
  matte: `<path ${S} d="M4 5.5h16v13H4z"/><path ${F} d="M4 5.5h8v13H4z" opacity=".45"/><path ${S} d="M12 5.5v13"/>`,
  key: `<path ${S} d="M12 5.5l5 6.5-5 6.5-5-6.5z"/>`,
  chevD: `<path ${S} d="M7 10l5 5 5-5"/>`,
  wave: `<path ${S} d="M3 12h2l2-5 3 10 3-14 3 12 2-3h3"/>`,
  warn: `<path ${S} d="M12 4l9 16H3z"/><path ${S} d="M12 10v4.5M12 17.5v.5"/>`,
};

/** SVG markup for an icon (safe: names are a closed set). */
export function iconSVG(name, size = 14) {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="ic-svg" data-icon="${name}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** A sized inline element wrapping one icon. */
export function iconEl(name, cls = '', size = 14) {
  const s = document.createElement('span');
  s.className = ('ic ' + cls).trim();
  s.innerHTML = iconSVG(name, size);
  return s;
}

/** Replace a button's content with an icon, keeping its accessible title. */
export function setIcon(elm, name, size = 14) {
  if (!elm) return;
  elm.innerHTML = iconSVG(name, size);
}
