/* ═══════════════════════════════════════════════════════════════
   core/fonts.js — font registry + live variable-axis instances

   Built directly on measured platform behaviour (see docs/platform-findings.md):
     • variationSettings bakes CUSTOM axes client-side, ~3ms per face  → live sliders
     • featureSettings is DEAD client-side                            → server route
     • shorthand percentages BREAK parse; keywords give 9 buckets      → never use
     • document.fonts grows unbounded                                  → LRU eviction
   ═══════════════════════════════════════════════════════════════ */

const REGISTRY_LIMIT = 220;          // max baked faces retained
const FETCH_TIMEOUT = 20000;         // never let a hung endpoint freeze boot

async function fetchWithTimeout(url, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

export const STOCK_FONTS = [
  { family: 'Inter',              file: '/fonts/Inter-var.ttf',            woff: false, role: 'ui+latin',  axes: ['wght', 'opsz'] },
  { family: 'Roboto Flex',        file: '/fonts/RobotoFlex-var.ttf',       woff: false, role: 'display',   axes: ['wght', 'wdth', 'opsz', 'slnt', 'GRAD', 'XOPQ', 'YOPQ', 'XTRA', 'YTUC', 'YTLC', 'YTAS', 'YTDE', 'YTFI'] },
  { family: 'Noto Sans Arabic',   file: '/fonts/NotoSansArabic-var.ttf',   woff: false, role: 'arabic',    axes: ['wght', 'wdth'] },
  { family: 'Vazirmatn',          file: '/fonts/Vazirmatn-var.woff2',      woff: true,  role: 'persian',   axes: ['wght'] },
  { family: 'Source Serif 4',     file: '/fonts/SourceSerif4-var.ttf',     woff: false, role: 'serif',     axes: ['opsz', 'wght'] },
];

/* ── script detection: which font is legally allowed to draw this codepoint ──
   Persian is split out from Arabic on purpose: پ چ ژ گ ک ی and ۰-۹ have their
   own coverage numbers in the audit, and a font can be 100% Arabic yet still
   miss the four letters Persian actually needs. Order matters — the more
   specific ranges are tested first. */
const SCRIPT_RANGES = [
  { id: 'persian', name: 'Persian-specific', ranges: [
      [0x067E, 0x067E], [0x0686, 0x0686], [0x0698, 0x0698], [0x06AF, 0x06AF],
      [0x06A9, 0x06A9], [0x06CC, 0x06CC], [0x06F0, 0x06F9], [0x0643, 0x0643]] },
  { id: 'arabic',  name: 'Arabic',           ranges: [[0x0600, 0x06FF], [0x0750, 0x077F], [0x08A0, 0x08FF], [0xFB50, 0xFDFF], [0xFE70, 0xFEFF]] },
  { id: 'hebrew',  name: 'Hebrew',           ranges: [[0x0590, 0x05FF], [0xFB1D, 0xFB4F]] },
  { id: 'deva',    name: 'Devanagari',       ranges: [[0x0900, 0x097F], [0xA8E0, 0xA8FF]] },
  { id: 'thai',    name: 'Thai',             ranges: [[0x0E00, 0x0E7F]] },
  { id: 'cjk',     name: 'CJK',              ranges: [[0x3000, 0x303F], [0x3040, 0x30FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xFF00, 0xFFEF], [0xAC00, 0xD7AF]] },
  { id: 'cyril',   name: 'Cyrillic',         ranges: [[0x0400, 0x04FF], [0x0500, 0x052F]] },
  { id: 'greek',   name: 'Greek',            ranges: [[0x0370, 0x03FF], [0x1F00, 0x1FFF]] },
  { id: 'indic-ext', name: 'Indic',          ranges: [[0x0980, 0x0DFF], [0x11000, 0x11FFF]] },
];

export function scriptOf(cp) {
  for (const s of SCRIPT_RANGES)
    for (const [a, b] of s.ranges) if (cp >= a && cp <= b) return s.id;
  if (cp >= 0x0030 && cp <= 0x0039) return 'digit';
  if ((cp >= 0x0041 && cp <= 0x005A) || (cp >= 0x0061 && cp <= 0x007A)) return 'latin';
  if (cp === 0x20 || (cp >= 0x21 && cp <= 0x2F) || (cp >= 0x3A && cp <= 0x40)) return 'punct';
  return 'latin';
}
export const RTL_SCRIPTS = new Set(['arabic', 'persian', 'hebrew']);
export function isRTLScript(s) { return RTL_SCRIPTS.has(s); }

/* ── map the server audit's Unicode-block names onto our script ids ── */
const BLOCK_NEEDS = { latin: 52, cyril: 66, greek: 70, deva: 40, thai: 40, cjk: 40 };
function blockCount(scripts, names) { return names.reduce((n, k) => n + (scripts[k] || 0), 0); }

/**
 * Normalise `/api/font-axes` into a lookup keyed by family.
 * The endpoint returns { fonts:[…] } with Unicode *block* names; the engine
 * needs script ids with a coverage percentage. Doing this once at boot keeps
 * the render path free of shape-sniffing.
 */
export function normalizeFontAudit(raw) {
  const out = {};
  for (const f of raw?.fonts || []) {
    const s = f.scripts || {};
    const scripts = {
      latin: { name: 'Latin', count: blockCount(s, ['Latin Basic', 'Latin Ext']), pct: null },
      arabic: { name: 'Arabic', count: blockCount(s, ['Arabic', 'Arabic Supplement', 'Arabic Pres Forms A', 'Arabic Pres Forms B']), pct: f.arabic?.pct ?? null },
      persian: { name: 'Persian', count: blockCount(s, ['Arabic', 'Arabic Supplement', 'Arabic Pres Forms A', 'Arabic Pres Forms B']), pct: f.persian?.pct ?? null },
      cyril: { name: 'Cyrillic', count: s['Cyrillic'] || 0, pct: null },
      greek: { name: 'Greek', count: s['Greek'] || 0, pct: null },
      hebrew: { name: 'Hebrew', count: blockCount(s, ['Hebrew']), pct: null },
      deva: { name: 'Devanagari', count: blockCount(s, ['Devanagari']), pct: null },
      thai: { name: 'Thai', count: blockCount(s, ['Thai']), pct: null },
      cjk: { name: 'CJK', count: blockCount(s, ['CJK', 'Hiragana', 'Katakana', 'Hangul']), pct: null },
    };
    for (const [id, v] of Object.entries(scripts)) {
      if (v.pct === null) v.pct = v.count >= (BLOCK_NEEDS[id] || 1) ? 100 : Math.round(v.count / (BLOCK_NEEDS[id] || 1) * 100);
      v.covered = v.pct > 0;
    }
    out[f.family] = {
      family: f.family, file: f.file, sizeKb: f.size_kb, variable: f.variable,
      glyphCount: f.glyph_count, instances: f.instances,
      axes: (f.axes || []).map(a => ({ tag: a.tag, min: a.min, max: a.max, def: a.default, registered: !!a.registered })),
      scripts,
      persian: f.persian || null,
      arabic: f.arabic || null,
      presForms: f.pres_forms ?? 0,
      features: f.features || [],
      hasLiga: !!f.has_liga, hasCalt: !!f.has_calt, hasRclt: !!f.has_rclt,
      raw: f,
    };
  }
  return out;
}

/* ═══════════ The registry ═══════════ */

export class FontRegistry {
  constructor() {
    this.loaded = new Map();       // family -> FontFace (base, full axis range)
    this.instances = new Map();    // cacheKey -> { family, lru }
    this.lru = 0;
    this.meta = null;              // server audit (coverage %, axes, glyph counts)
    this.warnings = [];            // surfaced, never swallowed
    this.ready = false;
    this._pending = new Map();
  }

  /* ── boot: load the four stock variable faces ── */
  async loadStock(onProgress) {
    let done = 0;
    await Promise.all(STOCK_FONTS.map(async (f) => {
      try {
        const res = await fetchWithTimeout(f.file);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const desc = { weight: '100 900' };
        if (f.axes.includes('wdth')) desc.stretch = '25% 151%';
        const face = new FontFace(f.family, buf, desc);
        await face.load();
        document.fonts.add(face);
        this.loaded.set(f.family, { face, spec: f, buffer: buf });
      } catch (e) {
        this.warnings.push({ level: 'error', family: f.family, msg: `failed to load: ${e.message}` });
      }
      done++;
      onProgress?.(done / STOCK_FONTS.length, f.family);
    }));
    await document.fonts.ready;
    this.ready = true;
    return this;
  }

  /** Server-side audit (axes, script coverage, OT features). Non-fatal. */
  async loadMeta() {
    try {
      const r = await fetchWithTimeout('/api/font-axes', 60000);   // fontTools scan takes ~2s cold
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.metaRaw = await r.json();
      this.meta = normalizeFontAudit(this.metaRaw);
      if (!Object.keys(this.meta).length) throw new Error('empty audit payload');
    } catch (e) {
      this.meta = null;
      this.warnings.push({ level: 'warn', msg: `font audit unavailable: ${e.message}` });
    }
    return this.meta;
  }

  families() { return STOCK_FONTS.map(f => f.family).filter(f => this.loaded.has(f)); }
  spec(family) { return STOCK_FONTS.find(f => f.family === family); }
  buffer(family) { return this.loaded.get(family)?.buffer; }

  /* ═══════════ live instance baking ═══════════
     `axes` = { GRAD: 150, XOPQ: 90, wdth: 62.5, ... }
     Registered axes that the shorthand can express (wght) stay dynamic;
     everything else is baked, because that is the only way that measures. */
  static BAKEABLE = new Set(['wdth', 'slnt', 'opsz', 'GRAD', 'XOPQ', 'YOPQ', 'XTRA', 'YTUC', 'YTLC', 'YTAS', 'YTDE', 'YTFI', 'SOFT', 'WONK']);

  instanceKey(family, axes) {
    const parts = Object.entries(axes || {})
      .filter(([k]) => FontRegistry.BAKEABLE.has(k))
      .map(([k, v]) => `${k}=${Math.round(v * 1000) / 1000}`)
      .sort();
    return parts.length ? `${family}|${parts.join(',')}` : family;
  }

  /**
   * Resolve a (family, axes) pair to a Canvas-usable family name.
   * Returns { family, baked, ms, fromCache }.
   */
  async instance(family, axes) {
    const key = this.instanceKey(family, axes);
    const hit = this.instances.get(key);
    if (hit) { hit.lru = ++this.lru; return { family: hit.family, baked: hit.baked, ms: 0, fromCache: true }; }

    const base = this.loaded.get(family);
    if (!base) return { family, baked: false, ms: 0, fromCache: false };

    const bake = Object.entries(axes || {}).filter(([k]) => FontRegistry.BAKEABLE.has(k));
    if (!bake.length) return { family, baked: false, ms: 0, fromCache: false };

    // Single-flight: identical concurrent requests share one bake.
    if (this._pending.has(key)) return this._pending.get(key);

    const p = (async () => {
      const t0 = performance.now();
      const instFamily = `FZ_${key.replace(/[^A-Za-z0-9]/g, '_').slice(0, 48)}_${++this.lru}`;
      const vs = bake.map(([k, v]) => `'${k}' ${v}`).join(', ');
      try {
        const face = new FontFace(instFamily, base.buffer, { weight: '100 900', variationSettings: vs });
        await face.load();
        document.fonts.add(face);
        const ms = performance.now() - t0;
        this.instances.set(key, { family: instFamily, baked: true, lru: ++this.lru, face, ms });
        this._evict();
        return { family: instFamily, baked: true, ms, fromCache: false, source: family, axes: bake };
      } catch (e) {
        this.warnings.push({ level: 'error', family, msg: `instance bake failed (${vs}): ${e.message}` });
        return { family, baked: false, ms: performance.now() - t0, fromCache: false, error: e.message };
      } finally {
        this._pending.delete(key);
      }
    })();
    this._pending.set(key, p);
    return p;
  }

  /** Synchronous fast path for the render loop — returns the base family if not yet baked. */
  instanceSync(family, axes) {
    const key = this.instanceKey(family, axes);
    const hit = this.instances.get(key);
    if (hit) { hit.lru = ++this.lru; return hit.family; }
    return family;
  }

  /** Kick off a bake without waiting (keeps sliders at 60fps; next frame uses it). */
  warm(family, axes) {
    const key = this.instanceKey(family, axes);
    if (!this.instances.has(key) && !this._pending.has(key)) this.instance(family, axes);
  }

  _evict() {
    if (this.instances.size <= REGISTRY_LIMIT) return;
    const sorted = [...this.instances.entries()].sort((a, b) => a[1].lru - b[1].lru);
    for (const [k, v] of sorted.slice(0, Math.max(1, this.instances.size - REGISTRY_LIMIT))) {
      document.fonts.delete(v.face);
      this.instances.delete(k);
    }
  }

  stats() {
    return {
      stockLoaded: this.loaded.size,
      bakedInstances: this.instances.size,
      documentFonts: document.fonts.size,
      warnings: this.warnings.length,
    };
  }

  /* ═══════════ coverage audit — the anti-AE feature ═══════════ */
  /** Per-script coverage of `family`, straight from the normalised audit. */
  coverage(family, script) {
    const info = this.meta?.[family]?.scripts?.[script];
    if (!info) return null;
    return { family, script, name: info.name, pct: info.pct, count: info.count, covered: info.covered };
  }

  /** Every character in `text` that `family` cannot draw, with the routed fix. */
  missingGlyphs(family, text) {
    const audit = this.meta?.[family];
    if (!audit) return { family, checked: false, missing: [] };
    const byScript = new Map();
    for (const ch of text) {
      if (!ch.trim()) continue;
      const sc = scriptOf(ch.codePointAt(0));
      if (!byScript.has(sc)) byScript.set(sc, []);
      byScript.get(sc).push(ch);
    }
    const missing = [];
    for (const [sc, chars] of byScript) {
      const info = audit.scripts?.[sc];
      if (!info) continue;
      if (!info.covered) missing.push({ script: sc, name: info.name, pct: info.pct, chars: [...new Set(chars)].join(''), routeTo: this.routeForScript(sc, family) });
    }
    return { family, checked: true, missing };
  }

  /**
   * Detect the After Effects failure: the user asked for font A, the glyphs
   * came from somewhere else, and nothing in the UI says so.
   */
  detectSilentFallback(family, text) {
    if (!this.meta) return { family, checked: false, fallbackDetected: false, scripts: [] };
    const { missing } = this.missingGlyphs(family, text);
    return { family, checked: true, fallbackDetected: missing.length > 0, scripts: missing };
  }

  /** Pick the first family in the chain that genuinely covers `script`. */
  routeForScript(script, preferred) {
    const chain = this.fallbackChain(preferred);
    if (script === 'latin' || script === 'digit' || script === 'punct') return chain[0] || preferred;
    for (const fam of chain) {
      const info = this.meta?.[fam]?.scripts?.[script];
      if (info?.covered) return fam;
    }
    // last resort: prefer a font whose declared role matches the script
    const role = (script === 'arabic' || script === 'persian') ? 'persian' : null;
    const byRole = STOCK_FONTS.find(f => f.role === role && this.loaded.has(f.family));
    return byRole?.family || chain[0] || preferred;
  }

  fallbackChain(preferred) {
    const order = [preferred, ...STOCK_FONTS.map(f => f.family)].filter(Boolean);
    return [...new Set(order)].filter(f => this.loaded.has(f));
  }
}

/* Build the Canvas `font` shorthand. Verified rules:
   • numeric weight works and stays continuous
   • stretch MUST be a keyword or omitted (percentages break the parse)
   • slnt is not reachable via the shorthand — bake it instead            */
const STRETCH_KEYWORDS = [
  [50, 'ultra-condensed'], [62.5, 'extra-condensed'], [75, 'condensed'], [87.5, 'semi-condensed'],
  [100, 'normal'], [112.5, 'semi-expanded'], [125, 'expanded'], [150, 'extra-expanded'], [200, 'ultra-expanded'],
];
export function stretchKeyword(pct) {
  let best = STRETCH_KEYWORDS[0];
  for (const k of STRETCH_KEYWORDS) if (Math.abs(k[0] - pct) < Math.abs(best[0] - pct)) best = k;
  return best[1];
}

export function fontShorthand({ size, family, weight = 400, style = 'normal', stretch = null, tracking = 0 }) {
  const parts = [];
  if (style && style !== 'normal') parts.push(style);
  parts.push(String(Math.round(weight)));
  if (stretch && stretch !== 100) parts.push(stretchKeyword(stretch));
  parts.push(`${size}px`);
  parts.push(`"${family}"`);
  return parts.join(' ');
}
