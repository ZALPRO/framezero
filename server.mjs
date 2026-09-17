// FrameZero — dev server
// Static files + font-instance microservice (fontTools varLib.instancer) + license API
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(import.meta.dirname);
const PUB = join(ROOT, 'public');
const CACHE = join(ROOT, '.fontcache');
const PORT = Number(process.env.PORT || 4173);
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

// Font family -> source file on disk
const FONT_FILES = {
  'Inter': 'Inter-var.ttf',
  'Roboto Flex': 'RobotoFlex-var.ttf',
  'Noto Sans Arabic': 'NotoSansArabic-var.ttf',
  'Vazirmatn': 'Vazirmatn-var.woff2',
};
const FONT_LICENSE = {
  'Inter': 'Inter-OFL.txt',
  'Roboto Flex': 'RobotoFlex-OFL.txt',
  'Noto Sans Arabic': 'NotoSansArabic-OFL.txt',
  'Vazirmatn': 'Vazirmatn-OFL.txt',
};

await mkdir(CACHE, { recursive: true });

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}

async function instantiateFont(family, axes) {
  const src = FONT_FILES[family];
  if (!src) return { error: `unknown family: ${family}` };
  const srcPath = join(PUB, 'fonts', src);
  if (!existsSync(srcPath)) return { error: `missing font file: ${src}` };

  const key = `${family}__${Object.entries(axes).sort().map(([k, v]) => `${k}=${v}`).join(',')}`
    .replace(/[^A-Za-z0-9_.=-]/g, '_');
  const outPath = join(CACHE, `${key}.ttf`);
  if (existsSync(outPath)) return { path: outPath, cached: true };

  const axesArg = JSON.stringify(axes);
  return await new Promise((res) => {
    const py = spawn('python3', [join(ROOT, 'tools', 'instantiate.py'), srcPath, axesArg, outPath]);
    let err = '';
    py.stderr.on('data', (d) => (err += d));
    py.on('error', (e) => res({ error: `spawn failed: ${e.message}` }));
    py.on('close', (code) => {
      if (code === 0 && existsSync(outPath)) res({ path: outPath, cached: false });
      else res({ error: err.slice(0, 400) || `exit ${code}` });
    });
    setTimeout(() => { try { py.kill('SIGKILL'); } catch {} res({ error: 'timeout' }); }, 20000);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    // ---- API: instantiate a variable-font static instance with arbitrary axes ----
    if (p === '/api/font-instance') {
      const family = url.searchParams.get('family');
      const axesRaw = url.searchParams.get('axes') || '{}';
      let axes;
      try { axes = JSON.parse(axesRaw); } catch { return send(res, 400, JSON.stringify({ error: 'bad axes json' }), { 'Content-Type': 'application/json' }); }
      const r = await instantiateFont(family, axes);
      if (r.error) return send(res, 500, JSON.stringify({ error: r.error }), { 'Content-Type': 'application/json' });
      const buf = await readFile(r.path);
      return send(res, 200, buf, {
        'Content-Type': 'font/ttf',
        'X-Instance-Cache': r.cached ? 'hit' : 'miss',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    }

    // ---- API: font license text (powers the Font Clearance Report) ----
    if (p === '/api/font-license') {
      const family = url.searchParams.get('family');
      const f = FONT_LICENSE[family];
      if (!f) return send(res, 404, JSON.stringify({ error: 'unknown family' }), { 'Content-Type': 'application/json' });
      const txt = await readFile(join(PUB, 'fonts', f), 'utf8');
      return send(res, 200, JSON.stringify({ family, license: 'SIL Open Font License 1.1', text: txt }), { 'Content-Type': 'application/json' });
    }

    // ---- API: font metadata (axes) ----
    if (p === '/api/font-axes') {
      const out = spawn('python3', [join(ROOT, 'tools', 'fontinfo.py'), join(PUB, 'fonts')]);
      let s = '';
      out.stdout.on('data', (d) => (s += d));
      out.on('close', () => send(res, 200, s || '{}', { 'Content-Type': 'application/json' }));
      return;
    }

    // ---- Static ----
    let rel = decodeURIComponent(p);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = resolve(join(PUB, normalize(rel)));
    if (!file.startsWith(PUB)) return send(res, 403, 'forbidden');

    let st;
    try { st = await stat(file); } catch { return send(res, 404, 'not found'); }
    if (st.isDirectory()) return send(res, 404, 'not found');

    const buf = await readFile(file);
    return send(res, 200, buf, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
    });
  } catch (e) {
    return send(res, 500, String(e && e.stack || e));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FrameZero server → http://${HOST}:${PORT}`);
});
