// OpenMail desktop: a window onto the user's own OpenMail server (its web app and its sign-in, so it works with any
// server and updates with it), plus what a browser tab can't do: be the system's mailto: handler and live in the Dock.
// The first-run "which server?" screen is apps/shell/index.html (copied to setup.html by `npm start`/`npm run package`).
const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('path');

app.setName('OpenMail');
app.userAgentFallback += ' OpenMailDesktop'; // the web app shows desktop wording in Settings → App
const isMailto = (u) => typeof u === 'string' && /^mailto:/i.test(u);
const pending = process.argv.filter(isMailto); // Windows/Linux pass the link as an argument

/** A window that starts at the server-address screen; it goes straight on to the saved server. */
function open(query = {}) {
  const win = new BrowserWindow({ width: 1280, height: 860, minWidth: 380, minHeight: 500, title: 'OpenMail', backgroundColor: '#f4f7fc',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true } });
  win.loadFile(path.join(__dirname, 'setup.html'), { query });
  const wc = win.webContents;
  // Within the window: the setup screen → the server, and pages of that same server. Anything else: the browser.
  wc.on('will-navigate', (e, url) => {
    const from = new URL(wc.getURL()), to = new URL(url);
    if (from.protocol === 'file:' || to.origin === from.origin) return;
    e.preventDefault();
    if (/^https?:$/.test(to.protocol)) shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:')) return { action: 'allow' }; // attachments and printouts the app made itself
    if (isMailto(url)) open({ mailto: url });
    else if (/^https?:/i.test(url)) shell.openExternal(url); // links in email open in the real browser
    return { action: 'deny' };
  });
  // Server unreachable: back to the address screen, which says so.
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && !url.startsWith('file:')) win.loadFile(path.join(__dirname, 'setup.html'), { query: { error: '1' } });
  });
  return win;
}

function mailto(url) {
  if (app.isReady()) open({ mailto: url }); // its own window, so whatever is open in the main one stays
  else pending.push(url);
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const links = argv.filter(isMailto);
  if (links.length) links.forEach(mailto);
  else { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } else open(); }
});
app.on('open-url', (e, url) => { e.preventDefault(); if (isMailto(url)) mailto(url); }); // macOS

app.whenReady().then(() => {
  // The server's page may notify (new mail) and use the clipboard; nothing else (camera, location, …).
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(perm)));
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => open() },
      // The app declares mailto: (Info.plist / installer); becoming the default is the user's choice, not a launch side effect.
      { label: 'Use OpenMail for Email Links', type: 'checkbox', checked: app.isDefaultProtocolClient('mailto'),
        click: (item) => { item.checked = item.checked ? app.setAsDefaultProtocolClient('mailto') : !app.removeAsDefaultProtocolClient('mailto'); } },
      { label: 'Change Server…', click: () => (BrowserWindow.getFocusedWindow() ?? open()).loadFile(path.join(__dirname, 'setup.html'), { query: { change: '1' } }) },
      { type: 'separator' }, mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  if (pending.length) pending.splice(0).forEach((u) => open({ mailto: u }));
  else open();
});
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) open(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
