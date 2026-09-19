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

  /* effect categories */
  catBlur: `<circle ${S} cx="12" cy="12" r="3.2"/><circle ${S} cx="12" cy="12" r="6.4" opacity=".55"/><circle ${S} cx="12" cy="12" r="9.4" opacity=".25"/>`,
  catColor: `<path ${S} d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.8 2-1.7 0-1.5-1.3-1.9-1.3-3 0-1 .8-1.8 2.1-1.8h2.4a3.3 3.3 0 0 0 3.3-3.3A8.6 8.6 0 0 0 12 3.5z"/><circle ${F} cx="8.2" cy="10" r="1.15"/><circle ${F} cx="12" cy="7.6" r="1.15"/><circle ${F} cx="15.8" cy="10" r="1.15"/>`,
  catStylize: `<path ${S} d="M12 4l1.8 4.9L19 10.7l-5.2 1.8L12 17.5l-1.8-5L5 10.7l5.2-1.8z"/><path ${S} d="M18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>`,
  catDistort: `<path ${S} d="M4 8c2.6-3 5.4 3 8 0s5.4 3 8 0M4 15c2.6-3 5.4 3 8 0s5.4 3 8 0"/>`,
  catKey: `<path ${S} d="M4 5.5h16v13H4z"/><path ${S} d="M12 9.2l2.6 3.4-2.6 3.4-2.6-3.4z"/><path ${S} d="M4 5.5l16 13M20 5.5l-16 13" opacity=".4"/>`,
  catGenerate: `<path ${S} d="M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6z"/><path ${S} d="M16.5 13.5v6M13.5 16.5h6"/>`,

  /* shape kinds */
  shSolid: `<path ${F} d="M5 5h14v14H5z" opacity=".85"/>`,
  shRect: `<path ${S} d="M4.5 6h15v12h-15z"/>`,
  shEllipse: `<circle ${S} cx="12" cy="12" r="7.5"/>`,
  shTriangle: `<path ${S} d="M12 5.2L20 19H4z"/>`,
  shPolygon: `<path ${S} d="M12 4.2l7.4 5.4-2.8 8.8H7.4L4.6 9.6z"/>`,
  shStar: `<path ${S} d="M12 4l2.3 5 5.7.6-4.3 3.9 1.3 5.5-5-3-5 3 1.3-5.5L4 9.6 9.7 9z"/>`,
  shLine: `<path ${S} d="M5 19L19 5"/><circle ${F} cx="5" cy="19" r="1.6"/><circle ${F} cx="19" cy="5" r="1.6"/>`,
  shGradient: `<path ${S} d="M5 5h14v14H5z"/><path ${S} d="M8.5 5v14M12 5v14M15.5 5v14" opacity=".7"/><path ${S} d="M12 5v14" opacity=".35" stroke-width="3.4"/>`,
  shGrid: `<path ${S} d="M4.5 4.5h15v15h-15z"/><path ${S} d="M9.5 4.5v15M14.5 4.5v15M4.5 9.5h15M4.5 14.5h15"/>`,
  shChecker: `<path ${S} d="M4.5 4.5h15v15h-15z"/><path ${F} d="M4.5 4.5h5v5h-5zM14.5 4.5h5v5h-5zM9.5 9.5h5v5h-5zM4.5 14.5h5v5h-5zM14.5 14.5h5v5h-5z" opacity=".8"/>`,
  shNoise: `<path ${F} d="M6 6h2v2H6zM11 5h2v2h-2zM16 7h2v2h-2zM8 10h2v2H8zM13 10.5h2v2h-2zM18 12h2v2h-2zM5.5 14h2v2h-2zM10 15h2v2h-2zM15 16h2v2h-2zM7.5 18h2v2h-2zM12.5 19h2v2h-2zM17.5 18.5h2v2h-2z" opacity=".9"/>`,

  /* tools */
  toolSelect: `<path ${F} d="M6.5 3.8l11 8.6-5 1 2.6 5.4-2.5 1.2-2.6-5.5-3.5 3.4z"/>`,
  toolHand: `<path ${S} d="M8 11V6.6a1.5 1.5 0 0 1 3 0V11m0-4.8V5a1.5 1.5 0 0 1 3 0v6m0-5a1.5 1.5 0 0 1 3 0v7.5c0 3.6-2.4 6-6 6s-5.1-1.7-6.4-4.6L4.4 12c-.5-1 .1-2 1.1-2 .7 0 1.3.4 1.7 1.1L8 12.6"/>`,
  toolZoom: `<circle ${S} cx="10.5" cy="10.5" r="6"/><path ${S} d="M15 15l5 5M8 10.5h5M10.5 8v5"/>`,
  toolPen: `<path ${S} d="M12 3.5l3.5 5-3.5 9-3.5-9z"/><path ${S} d="M8.5 8.5h7"/><circle ${F} cx="12" cy="20" r="1.4"/>`,
  toolText: `<path ${S} d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5"/>`,
  toolRazor: `<circle ${S} cx="7" cy="17.5" r="2.2"/><circle ${S} cx="12.5" cy="17.5" r="2.2"/><path ${S} d="M8.6 15.8L18 4.5M11 15.8L6 4.5"/>`,

  /* editing */
  marker: `<path ${S} d="M7 21V4"/><path ${F} d="M7 4h10l-2.4 3.5L17 11H7z"/>`,
  markerAdd: `<path ${S} d="M7 21V4"/><path ${S} d="M7 4h10l-2.4 3.5L17 11H7z"/><path ${S} d="M17.5 15.5v5M15 18h5"/>`,
  markerPrev: `<path ${F} d="M15 4h6l-1.8 3L21 10h-6z" opacity=".8"/><path ${S} d="M15 4v13"/><path ${S} d="M10 8.5L5.5 12 10 15.5z"/>`,
  markerNext: `<path ${F} d="M9 4H3l1.8 3L3 10h6z" opacity=".8"/><path ${S} d="M9 4v13"/><path ${S} d="M14 8.5l4.5 3.5-4.5 3.5z"/>`,
  markerDel: `<path ${S} d="M7 21V4"/><path ${S} d="M7 4h10l-2.4 3.5L17 11H7z"/><path ${S} d="M15.5 15.5l5 5M20.5 15.5l-5 5"/>`,
  adjustment: `<path ${S} d="M4 7h16M4 12h16M4 17h16"/><circle ${F} cx="9" cy="7" r="2"/><circle ${F} cx="15" cy="12" r="2"/><circle ${F} cx="7.5" cy="17" r="2"/>`,
  speed: `<path ${S} d="M5 17a8 8 0 1 1 14 0"/><path ${S} d="M12 14l4.5-4"/><circle ${F} cx="12" cy="15" r="1.7"/><path ${S} d="M5.6 12.5l1.4.5M18.4 12.5l-1.4.5M12 6.6v1.5"/>`,
  reverse: `<path ${S} d="M7 8h10a3.5 3.5 0 0 1 0 7H7"/><path ${F} d="M9.5 4.8L4.5 8l5 3.2zM14.5 20.2l5-3.2-5-3.2z"/>`,
  trCross: `<path ${S} d="M4 7h9v10H4z" opacity=".55"/><path ${S} d="M11 7h9v10h-9z"/>`,
  trWipe: `<path ${S} d="M4 6h16v12H4z"/><path ${F} d="M4 6h7v12H4z" opacity=".5"/><path ${S} d="M11 4.5v15" stroke-dasharray="2.6 2.2"/>`,
  trSlide: `<path ${S} d="M3.5 7.5h8v9h-8z" opacity=".5"/><path ${S} d="M12.5 7.5h8v9h-8z"/><path ${F} d="M10 12l3-2.4v4.8z"/>`,
  scopes: `<path ${S} d="M4 5.5h16v13H4z"/><path ${S} d="M6.5 15v-4M9.5 15V8M12.5 15v-5M15.5 15V9.5M18 15v-2.5"/>`,
  vectorscope: `<circle ${S} cx="12" cy="12" r="8"/><path ${S} d="M12 4v3M12 17v3M4 12h3M17 12h3" opacity=".6"/><path ${F} d="M10 13.5l3.5-4 1.5 3-2.5 1z" opacity=".9"/>`,
  histogram: `<path ${S} d="M4 19h16"/><path ${S} d="M5.5 19v-3M8.5 19v-6M11.5 19V7M14.5 19v-8M17.5 19v-4"/>`,
  magnet: `<path ${S} d="M6 4v8a6 6 0 0 0 12 0V4"/><path ${S} d="M6 4h4v5H6zM14 4h4v5h-4z"/><path ${F} d="M6 4h4v2.5H6zM14 4h4v2.5h-4z" opacity=".7"/>`,
  stopwatch: `<circle ${S} cx="12" cy="13.5" r="7"/><path ${S} d="M12 13.5l3-3M10 3.5h4M12 3.5v3"/>`,
  graph: `<path ${S} d="M4.5 4.5v15h15"/><path ${S} d="M6.5 16c4 0 4-8 8-8 2.5 0 3.5 3 5 3"/><circle ${F} cx="6.5" cy="16" r="1.5"/><circle ${F} cx="14.5" cy="8" r="1.5"/>`,
  preset: `<path ${S} d="M7 3.5h10v17l-5-3.6-5 3.6z"/><path ${S} d="M9.5 9h5"/>`,
  renderQueue: `<path ${S} d="M4.5 6h15v4h-15zM4.5 14h15v4h-15z"/><path ${F} d="M7 7.4l2 1-2 1zM7 15.4l2 1-2 1z"/><path ${S} d="M11 8h6M11 16h6" opacity=".7"/>`,
  search: `<circle ${S} cx="10.5" cy="10.5" r="6"/><path ${S} d="M15 15l5.5 5.5"/>`,
  tag: `<path ${S} d="M4 5h7l9 9-7 7-9-9z"/><circle ${F} cx="8" cy="9" r="1.5"/>`,
  parent: `<path ${S} d="M7 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM17 13.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/><path ${S} d="M9 9.5c3 0 3 4.5 6 4.5"/>`,
  expr: `<path ${S} d="M8 4.5C5.5 4.5 6.5 10 4.5 12c2 2 1 7.5 3.5 7.5M16 4.5c2.5 0 1.5 5.5 3.5 7.5-2 2-1 7.5-3.5 7.5"/><path ${S} d="M9.5 10l5 4M14.5 10l-5 4"/>`,
  camera: `<path ${S} d="M4 8h10.5v8H4z"/><path ${F} d="M14.5 10.8l5.5-2.6v7.6l-5.5-2.6z"/><circle ${S} cx="7" cy="5.6" r="1.6"/><circle ${S} cx="11.5" cy="5.6" r="1.6"/>`,
  light: `<path ${S} d="M9 4h6v3.5H9z"/><path ${S} d="M8 7.5h8l2 6H6z"/><path ${S} d="M9.5 16.5c0 1.6 1 2.5 2.5 2.5s2.5-.9 2.5-2.5" opacity=".7"/><path ${S} d="M12 10v1.5M9.8 10.6l.6 1.3M14.2 10.6l-.6 1.3" opacity=".8"/>`,
  nullObj: `<path ${S} d="M12 4.5l7.5 7.5-7.5 7.5L4.5 12z"/><path ${S} d="M12 9l3 3-3 3-3-3z" opacity=".7"/>`,
  precomp: `<path ${S} d="M4 6h16v12H4z"/><path ${S} d="M8.5 9.5h7v5h-7z"/><path ${S} d="M4 6l4.5 3.5M20 6l-4.5 3.5M4 18l4.5-3.5M20 18l-4.5-3.5" opacity=".6"/>`,
  alignL: `<path ${S} d="M5 4v16"/><path ${F} d="M8 6.5h9v4H8zM8 13.5h5.5v4H8z" opacity=".85"/>`,
  alignCX: `<path ${S} d="M12 4v16"/><path ${F} d="M7.5 6.5h9v4h-9zM9.5 13.5h5v4h-5z" opacity=".85"/>`,
  alignR: `<path ${S} d="M19 4v16"/><path ${F} d="M7 6.5h9v4H7zM10.5 13.5H16v4h-5.5z" opacity=".85"/>`,
  alignT: `<path ${S} d="M4 5h16"/><path ${F} d="M6.5 8h4v9h-4zM13.5 8h4v5.5h-4z" opacity=".85"/>`,
  alignCY: `<path ${S} d="M4 12h16"/><path ${F} d="M6.5 7.5h4v9h-4zM13.5 9.5h4v5h-4z" opacity=".85"/>`,
  alignB: `<path ${S} d="M4 19h16"/><path ${F} d="M6.5 7h4v9h-4zM13.5 10.5h4V16h-4z" opacity=".85"/>`,
  flipH: `<path ${S} d="M12 4v16" stroke-dasharray="3 2.4"/><path ${F} d="M9.5 7L4 12l5.5 5zM14.5 7L20 12l-5.5 5z" opacity=".85"/>`,
  flipV: `<path ${S} d="M4 12h16" stroke-dasharray="3 2.4"/><path ${F} d="M7 9.5L12 4l5 5.5zM7 14.5L12 20l5-5.5z" opacity=".85"/>`,
  fit: `<path ${S} d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/><path ${S} d="M8.5 12h7"/>`,
  split: `<path ${S} d="M6 4.5h12v15H6z"/><path ${S} d="M12 2.5v19" stroke-dasharray="2.8 2.4"/><path ${F} d="M9 10l-2 2 2 2zM15 10l2 2-2 2z"/>`,
  slip: `<path ${S} d="M4 8h16v8H4z"/><path ${F} d="M9 8h6v8H9z" opacity=".5"/><path ${S} d="M6.5 12H4m16 0h-2.5"/><path ${F} d="M7.5 10.2L5.5 12l2 1.8zM16.5 10.2l2 1.8-2 1.8z"/>`,
  ripple: `<path ${S} d="M4 8h6v8H4zM14 8h6v8h-6z"/><path ${S} d="M12 5v14" stroke-dasharray="2.6 2.2"/><path ${F} d="M10.5 10.3L8.7 12l1.8 1.7zM13.5 10.3l1.8 1.7-1.8 1.7z"/>`,
  ease: `<path ${S} d="M4.5 18.5c8 0 7-13 15-13"/><circle ${S} cx="4.5" cy="18.5" r="1.6"/><circle ${S} cx="19.5" cy="5.5" r="1.6"/>`,
  linear: `<path ${S} d="M5 19L19 5"/><circle ${S} cx="5" cy="19" r="1.6"/><circle ${S} cx="19" cy="5" r="1.6"/>`,
  hold: `<path ${S} d="M5 17h7V7h7"/><circle ${S} cx="5" cy="17" r="1.6"/><circle ${S} cx="19" cy="7" r="1.6"/>`,
  workspace: `<path ${S} d="M4 5h16v6H4zM4 13h7v6H4zM13 13h7v6h-7z"/>`,
  history: `<path ${S} d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4"/><path ${F} d="M4 3.8l.4 4.8 4.7-1z"/><path ${S} d="M12 8v4.4l3 1.8"/>`,
  snap: `<path ${S} d="M7 4.5v7a5 5 0 0 0 10 0v-7"/><path ${S} d="M7 4.5h3.4v4H7zM13.6 4.5H17v4h-3.4z"/>`,
  zoomIn: `<circle ${S} cx="10.5" cy="10.5" r="6"/><path ${S} d="M15 15l5.5 5.5M8 10.5h5M10.5 8v5"/>`,
  zoomOut: `<circle ${S} cx="10.5" cy="10.5" r="6"/><path ${S} d="M15 15l5.5 5.5M8 10.5h5"/>`,
  safeArea: `<path ${S} d="M4 5h16v14H4z"/><path ${S} d="M6.5 7.5h11v9h-11z" opacity=".6"/><path ${S} d="M8.5 9.5h7v5h-7z" opacity=".35"/>`,
  grid: `<path ${S} d="M4 5h16v14H4z"/><path ${S} d="M9.3 5v14M14.6 5v14M4 9.6h16M4 14.3h16" opacity=".6"/>`,
  info: `<circle ${S} cx="12" cy="12" r="8.5"/><path ${S} d="M12 11v5.5M12 7.8v.4"/>`,
  check: `<path ${S} d="M5 12.5l4.5 4.5L19 7.5"/>`,
  caret: `<path ${S} d="M9 6l6 6-6 6"/>`,

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
