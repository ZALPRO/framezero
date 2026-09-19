/* FrameZero desktop shell (Electron). Boots the product's static bundle on a
   loopback port and points one BrowserWindow at it. `--smoke` exits 0 once the
   editor finishes booting — used by CI and `npm run desktop:smoke`. */
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const { listen } = require('./serve.cjs');

const SMOKE = process.argv.includes('--smoke');
let win = null;

async function start() {
  const publicDir = path.join(__dirname, '..', 'public');
  const { port } = await listen(publicDir);

  await app.whenReady();
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#08090b',
    title: 'FrameZero',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
  // external links (docs, fonts licences) open in the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const booted = win.webContents.executeJavaScript(
    'new Promise(r => { const t = setInterval(() => { if (window.__FZ__) { clearInterval(t); r(true); } }, 100); })',
    true,
  ).catch(() => false);

  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
  const ok = await booted;

  if (SMOKE) {
    console.log(ok ? 'DESKTOP-SMOKE-OK' : 'DESKTOP-SMOKE-NO-FZ');
    app.exit(ok ? 0 : 1);
    return;
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) start(); });
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  start().catch((e) => { console.error(e); app.exit(1); });
}
