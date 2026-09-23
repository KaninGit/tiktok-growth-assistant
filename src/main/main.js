'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, shell, dialog, safeStorage, Tray, Menu, Notification, nativeImage
} = require('electron');

const cfg = require('./config');
const { Database } = require('./db');
const { TikTokClient } = require('./tiktok-api');
const { waitForAuthorization, redirectUri } = require('./oauth');
const { syncAll } = require('./sync');
const { Scheduler } = require('./scheduler');
const A = require('./analytics');

const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

let win = null;
let tray = null;
let db = null;
let client = null;
let scheduler = null;
let autoSyncTimer = null;
let quitting = false;

// ---------- single instance ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// ---------- secrets (Windows DPAPI via safeStorage) ----------
function encrypt(str) {
  if (str === null || str === undefined) return null;
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(str).toString('base64');
  return 'raw:' + Buffer.from(str).toString('base64');
}
function decrypt(val) {
  if (!val) return null;
  const [kind, data] = [val.slice(0, 4), val.slice(4)];
  if (kind === 'enc:') return safeStorage.decryptString(Buffer.from(data, 'base64'));
  return Buffer.from(data, 'base64').toString('utf8');
}

function getCredentials() {
  return { clientKey: db.getSetting('client_key', ''), clientSecret: decrypt(db.getSetting('client_secret')) || '' };
}
function loadTokens() {
  const v = decrypt(db.getSetting('tokens'));
  return v ? JSON.parse(v) : null;
}
function saveTokens(t) {
  db.setSetting('tokens', t ? encrypt(JSON.stringify(t)) : null);
}

function currentOpenId() {
  const t = loadTokens();
  return t ? t.open_id : null;
}

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body: String(body || '').slice(0, 200), icon: ICON }).show();
}

// ---------- window & tray ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 660,
    title: 'TikTok Growth Assistant',
    icon: ICON,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open external links in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  win.on('close', (e) => {
    const toTray = db.getSetting('close_to_tray', '1') === '1';
    if (!quitting && toTray) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('TikTok Growth Assistant');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: showWindow },
    { label: 'Sync now', click: () => runSync().catch(() => {}) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', showWindow);
}

// ---------- sync ----------
async function runSync() {
  emit('sync:state', { running: true });
  try {
    const r = await syncAll(client, db);
    emit('sync:state', { running: false, ok: true, at: r.at });
    return r;
  } catch (e) {
    emit('sync:state', { running: false, ok: false, error: e.message });
    throw e;
  }
}

function setupAutoSync() {
  clearInterval(autoSyncTimer);
  if (db.getSetting('auto_sync', '1') !== '1') return;
  autoSyncTimer = setInterval(() => {
    if (loadTokens()) runSync().catch(() => {});
  }, cfg.AUTO_SYNC_INTERVAL_MS);
  const last = Number(db.getSetting('last_sync', 0));
  if (loadTokens() && Date.now() - last > cfg.AUTO_SYNC_INTERVAL_MS) setTimeout(() => runSync().catch(() => {}), 5000);
}

// ---------- data helpers ----------
function videosFor(openId) {
  return openId ? db.all('SELECT * FROM videos WHERE open_id = ? ORDER BY create_time DESC', [openId]) : [];
}
function snapshotsFor(openId) {
  return openId ? db.all('SELECT * FROM account_snapshots WHERE open_id = ? ORDER BY taken_at', [openId]) : [];
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code, logId: e.logId };
    }
  });
}

function registerIpc() {
  handle('settings:get', () => {
    const acc = db.getSetting('account');
    const port = Number(db.getSetting('port', cfg.DEFAULT_PORT));
    return {
      clientKey: db.getSetting('client_key', ''),
      hasSecret: !!db.getSetting('client_secret'),
      port,
      redirectUri: redirectUri(port),
      lang: db.getSetting('lang', 'th'),
      autoSync: db.getSetting('auto_sync', '1') === '1',
      closeToTray: db.getSetting('close_to_tray', '1') === '1',
      loggedIn: !!loadTokens(),
      account: acc ? JSON.parse(acc) : null,
      lastSync: Number(db.getSetting('last_sync', 0)) || null,
      scopes: cfg.SCOPES,
      version: app.getVersion()
    };
  });

  handle('settings:save', (s = {}) => {
    if (typeof s.clientKey === 'string') db.setSetting('client_key', s.clientKey.trim());
    if (typeof s.clientSecret === 'string' && s.clientSecret.trim()) db.setSetting('client_secret', encrypt(s.clientSecret.trim()));
    if (s.port !== undefined) {
      const p = Number(s.port);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Port must be 1024–65535');
      db.setSetting('port', p);
    }
    if (s.lang) db.setSetting('lang', s.lang === 'en' ? 'en' : 'th');
    if (s.autoSync !== undefined) { db.setSetting('auto_sync', s.autoSync ? '1' : '0'); setupAutoSync(); }
    if (s.closeToTray !== undefined) db.setSetting('close_to_tray', s.closeToTray ? '1' : '0');
    return true;
  });

  handle('auth:login', async () => {
    const { clientKey, clientSecret } = getCredentials();
    if (!clientKey || !clientSecret) throw new Error('Please enter Client Key and Client Secret in Settings first');
    const port = Number(db.getSetting('port', cfg.DEFAULT_PORT));
    const grant = await waitForAuthorization({ clientKey, port, openExternal: (u) => shell.openExternal(u) });
    await client.exchangeCode(grant);
    showWindow();
    const r = await runSync();
    setupAutoSync();
    return { account: r.user };
  });

  handle('auth:logout', async () => {
    await client.revoke();
    db.setSetting('account', null);
    return true;
  });

  handle('sync:run', () => runSync());

  handle('dashboard:get', () => {
    const openId = currentOpenId();
    const videos = videosFor(openId);
    const growth = A.dailyGrowth(snapshotsFor(openId));
    const acc = db.getSetting('account');
    return {
      account: acc ? JSON.parse(acc) : null,
      growth,
      summary: A.summary(videos, growth),
      recent: videos.slice(0, 12).map((v) => ({ ...v, engagement: A.engagementRate(v) })),
      top: A.topVideos(videos, 5, 'view_count'),
      lastSync: Number(db.getSetting('last_sync', 0)) || null
    };
  });

  handle('videos:list', () => videosFor(currentOpenId()).map((v) => ({ ...v, engagement: A.engagementRate(v) })));

  handle('videos:history', (videoId) =>
    db.all('SELECT * FROM video_snapshots WHERE video_id = ? ORDER BY taken_at', [String(videoId)]));

  handle('analytics:get', () => {
    const videos = videosFor(currentOpenId());
    return {
      best: A.bestTimes(videos),
      rollup: A.dayHourRollup(videos),
      hashtags: A.hashtagStats(videos).slice(0, 30),
      duration: A.durationStats(videos),
      topEngagement: A.topVideos(videos.filter((v) => v.view_count >= 100), 10, 'engagement'),
      sampleSize: videos.length
    };
  });

  // ----- posts / scheduler -----
  handle('posts:creatorInfo', () => client.creatorInfo());

  handle('posts:list', () => db.all('SELECT * FROM scheduled_posts ORDER BY scheduled_at DESC LIMIT 500'));

  handle('posts:create', (p = {}) => {
    if (!p.filePath || !fs.existsSync(p.filePath)) throw new Error('Video file not found');
    const mode = p.mode === 'inbox' ? 'inbox' : 'direct';
    const allowed = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
    if (mode === 'direct' && !allowed.includes(p.privacyLevel)) throw new Error('Please choose who can view this video');
    if (p.brandContent && p.privacyLevel === 'SELF_ONLY') throw new Error('Branded content cannot be private');
    const at = Number(p.scheduledAt);
    if (!at) throw new Error('Invalid schedule time');
    const title = String(p.title || '').slice(0, 2200);
    const now = Date.now();
    const r = db.run(`INSERT INTO scheduled_posts(open_id, file_path, file_size, duration_sec, title, mode, privacy_level,
        disable_comment, disable_duet, disable_stitch, brand_content_toggle, brand_organic_toggle,
        scheduled_at, status, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`,
    [currentOpenId(), p.filePath, fs.statSync(p.filePath).size, Number(p.durationSec) || null, title, mode,
      mode === 'direct' ? p.privacyLevel : null,
      p.disableComment ? 1 : 0, p.disableDuet ? 1 : 0, p.disableStitch ? 1 : 0,
      p.brandContent ? 1 : 0, p.brandOrganic ? 1 : 0, at, now, now]);
    emit('posts:updated');
    setTimeout(() => scheduler.tick(), 500);
    return r.lastId;
  });

  handle('posts:cancel', (id) => {
    db.run(`UPDATE scheduled_posts SET status='cancelled', updated_at=? WHERE id=? AND status='pending'`, [Date.now(), id]);
    emit('posts:updated');
    return true;
  });

  handle('posts:retry', (id) => {
    db.run(`UPDATE scheduled_posts SET status='pending', error=NULL, progress=0, scheduled_at=?, updated_at=?
            WHERE id=? AND status IN ('failed','cancelled')`, [Date.now(), Date.now(), id]);
    emit('posts:updated');
    setTimeout(() => scheduler.tick(), 500);
    return true;
  });

  handle('posts:delete', (id) => {
    db.run(`DELETE FROM scheduled_posts WHERE id=? AND status NOT IN ('uploading','processing')`, [id]);
    emit('posts:updated');
    return true;
  });

  handle('dialog:pickVideo', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select video',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const fp = r.filePaths[0];
    return { path: fp, name: path.basename(fp), size: fs.statSync(fp).size };
  });

  handle('export:csv', async (kind) => {
    const openId = currentOpenId();
    let rows; let columns; let name;
    if (kind === 'followers') {
      rows = A.dailyGrowth(snapshotsFor(openId));
      columns = [
        { label: 'date', key: 'date' }, { label: 'followers', key: 'followers' },
        { label: 'delta', key: 'delta' }, { label: 'likes', key: 'likes' }, { label: 'videos', key: 'videos' }
      ];
      name = 'followers';
    } else {
      rows = videosFor(openId);
      columns = [
        { label: 'id', key: 'id' }, { label: 'title', key: 'title' },
        { label: 'posted_at', value: (r) => (r.create_time ? new Date(r.create_time * 1000).toISOString() : '') },
        { label: 'duration_s', key: 'duration' }, { label: 'views', key: 'view_count' },
        { label: 'likes', key: 'like_count' }, { label: 'comments', key: 'comment_count' },
        { label: 'shares', key: 'share_count' },
        { label: 'engagement_rate', value: (r) => A.engagementRate(r).toFixed(4) },
        { label: 'url', key: 'share_url' }
      ];
      name = 'videos';
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `tiktok-${name}-${stamp}.csv`,
      filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }]
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, A.toCsv(rows, columns), 'utf8');
    return r.filePath;
  });

  handle('shell:open', (url) => {
    if (!/^https:\/\/([a-z0-9-]+\.)*(tiktok\.com|tiktokapis\.com)\//i.test(String(url))) throw new Error('Blocked URL');
    return shell.openExternal(url);
  });
}

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  app.setAppUserModelId('com.barrelofexcellence.tiktokgrowth');
  db = await new Database(path.join(app.getPath('userData'), 'tga.sqlite')).open();
  client = new TikTokClient({ getCredentials, loadTokens, saveTokens });
  scheduler = new Scheduler({ db, client, onChange: () => emit('posts:updated'), notify });

  registerIpc();
  createWindow();
  createTray();
  scheduler.start();
  setupAutoSync();
});

app.on('before-quit', () => {
  quitting = true;
  if (scheduler) scheduler.stop();
  if (db) db.flush();
});

app.on('window-all-closed', () => {
  // Keep running in tray (scheduler needs the app alive). Quit only via tray menu.
  if (db && db.getSetting('close_to_tray', '1') !== '1') app.quit();
});
