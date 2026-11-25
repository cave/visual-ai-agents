// Desktop app: starts the local server inside the app and shows the office in a window.
// Run with `npm start`, or build a double-clickable app with `npm run build`.
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { start } = require('./server');

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
  win.on('closed', () => { win = null; });
}

function show(pathname) {
  if (!win) createWindow();
  else win.show();
  if (pathname) win.loadURL(origin + pathname);
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
    app.on('activate', () => show());
  });
  // Closing the window keeps the app in the Dock on macOS, like other Mac apps; elsewhere it quits.
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
