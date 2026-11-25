// Desktop app: starts the local server inside the app and shows the office in a window.
// Run with `npm start`, or build a double-clickable app with `npm run build`.
const { app, BrowserWindow, Menu, Notification, shell, dialog } = require('electron');
const { start } = require('./server');
const office = require('./lib/office');
const { changes } = require('./lib/watch');

const WATCH_MS = 4000;

let win = null;
let origin = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'Agent Office',
    backgroundColor: '#10161a',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(`${origin}/office`);
  // The pages are local; anything else (there are no such links today) opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(origin)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on('focus', () => { if (process.env.OFFICE_DEBUG) console.log('focus'); clearUnseen(); });
  win.on('blur', () => { if (process.env.OFFICE_DEBUG) console.log('blur'); });
  win.on('closed', () => { win = null; });
}

function show(pathname) {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  if (pathname) win.loadURL(origin + pathname);
}

// ---- Things to do: a notification and a Dock badge for every session that starts waiting on you ----

let lastStates = null; // pid -> state at the previous look
let unseen = 0;
const shown = new Set(); // notifications still on screen

function setBadge(n) {
  if (process.platform === 'darwin') app.dock.setBadge(n ? String(n) : '');
  else app.setBadgeCount(n);
}

// Looking at the app counts as having seen everything.
function clearUnseen() {
  unseen = 0;
  setBadge(0);
  for (const n of shown) n.close();
  shown.clear();
}

function openDesk(pid) {
  show();
  const open = () => win && win.webContents.executeJavaScript(`typeof openCard === 'function' && openCard(${Number(pid)})`).catch(() => {});
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(open, 600));
  else open();
}

async function watch() {
  let snap;
  try {
    snap = await office.snapshot();
  } catch {
    return;
  }
  const { next, events } = changes(lastStates, snap.sessions);
  lastStates = next;
  if (!events.length) return;
  if (win && win.isFocused()) return; // you are already looking at the office
  for (const e of events) {
    unseen++;
    console.log(`notify: ${e.name} (${e.kind})`);
    if (!Notification.isSupported()) continue;
    const n = new Notification({ title: e.name, subtitle: e.project, body: e.text, silent: e.kind === 'done' });
    n.on('click', () => openDesk(e.pid));
    n.on('close', () => shown.delete(n));
    shown.add(n);
    n.show();
  }
  setBadge(unseen);
  console.log(`badge: ${unseen}`);
}

function buildMenu() {
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Open at Login', type: 'checkbox', checked: openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Agent Office', accelerator: 'CmdOrCtrl+1', click: () => show('/office') },
        { label: 'Usage & Cost', accelerator: 'CmdOrCtrl+2', click: () => show('/') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => show());
  app.whenReady().then(async () => {
    try {
      // 4747 if it is free, otherwise any free port (for example when `node server.js` is already running).
      const port = await start({ fallback: true });
      origin = `http://127.0.0.1:${port}`;
    } catch (err) {
      dialog.showErrorBox('Agent Office could not start', String(err && err.message));
      return app.quit();
    }
    buildMenu();
    createWindow();
    watch();
    setInterval(watch, WATCH_MS);
    app.on('activate', () => show());
  });
  // Closing the window keeps the app in the Dock on macOS, like other Mac apps; elsewhere it quits.
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
