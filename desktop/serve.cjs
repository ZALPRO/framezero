/* Minimal static file server for the packaged app. The product is plain
   static ES modules, so the desktop shell needs nothing more than correct
   MIME types and a loopback bind — no writes, no endpoints. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.ttf': 'font/ttf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

function createServer(publicDir) {
  const root = path.resolve(publicDir);
  return http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end(); return; }
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.join(root, urlPath);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
  });
}

/** Bind to a free loopback port and resolve with { server, port }. */
function listen(publicDir) {
  return new Promise((resolve, reject) => {
    const server = createServer(publicDir);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { createServer, listen };
