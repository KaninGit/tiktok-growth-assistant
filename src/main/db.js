'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS account_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id         TEXT NOT NULL,
  taken_at        INTEGER NOT NULL,
  follower_count  INTEGER,
  following_count INTEGER,
  likes_count     INTEGER,
  video_count     INTEGER
);
CREATE INDEX IF NOT EXISTS ix_acc_snap ON account_snapshots(open_id, taken_at);
CREATE TABLE IF NOT EXISTS videos (
  id              TEXT PRIMARY KEY,
  open_id         TEXT NOT NULL,
  title           TEXT,
  description     TEXT,
  create_time     INTEGER,
  duration        INTEGER,
  cover_image_url TEXT,
  share_url       TEXT,
  view_count      INTEGER DEFAULT 0,
  like_count      INTEGER DEFAULT 0,
  comment_count   INTEGER DEFAULT 0,
  share_count     INTEGER DEFAULT 0,
  updated_at      INTEGER
);
CREATE INDEX IF NOT EXISTS ix_videos_owner ON videos(open_id, create_time);
CREATE TABLE IF NOT EXISTS video_snapshots (
  video_id      TEXT NOT NULL,
  taken_at      INTEGER NOT NULL,
  view_count    INTEGER,
  like_count    INTEGER,
  comment_count INTEGER,
  share_count   INTEGER
);
CREATE INDEX IF NOT EXISTS ix_vid_snap ON video_snapshots(video_id, taken_at);
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id              TEXT,
  file_path            TEXT NOT NULL,
  file_size            INTEGER,
  duration_sec         REAL,
  title                TEXT,
  mode                 TEXT NOT NULL DEFAULT 'direct',  -- direct | inbox
  privacy_level        TEXT,
  disable_comment      INTEGER DEFAULT 0,
  disable_duet         INTEGER DEFAULT 0,
  disable_stitch       INTEGER DEFAULT 0,
  brand_content_toggle INTEGER DEFAULT 0,
  brand_organic_toggle INTEGER DEFAULT 0,
  scheduled_at         INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  publish_id           TEXT,
  progress             REAL DEFAULT 0,
  error                TEXT,
  created_at           INTEGER,
  updated_at           INTEGER
);
CREATE INDEX IF NOT EXISTS ix_posts_due ON scheduled_posts(status, scheduled_at);
CREATE TABLE IF NOT EXISTS sync_runs (
  taken_at INTEGER PRIMARY KEY,
  kind     TEXT NOT NULL            -- full | recent
);
CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL,
  kind  TEXT NOT NULL DEFAULT 'pillar',  -- pillar | format
  color TEXT,
  UNIQUE(name, kind)
);
CREATE TABLE IF NOT EXISTS video_tags (
  video_id TEXT NOT NULL,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);
CREATE TABLE IF NOT EXISTS ideas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  notes       TEXT,
  caption     TEXT,
  tag_ids     TEXT,                  -- JSON array of tag ids
  priority    INTEGER DEFAULT 2,     -- 1 high, 2 normal, 3 low
  status      TEXT DEFAULT 'idea',   -- idea | drafting | scheduled | done | archived
  target_date TEXT,                  -- YYYY-MM-DD
  created_at  INTEGER,
  updated_at  INTEGER
);
CREATE TABLE IF NOT EXISTS velocity_alerts (
  video_id   TEXT NOT NULL,
  level      TEXT NOT NULL,
  ratio      REAL,
  created_at INTEGER,
  PRIMARY KEY (video_id, level)
);
`;

// Columns added after v0.1 — applied with ALTER TABLE if missing.
const MIGRATIONS = [
  ['scheduled_posts', 'idea_id', 'INTEGER'],
  ['scheduled_posts', 'tag_ids', 'TEXT'],
  ['scheduled_posts', 'post_ids', 'TEXT']
];

class Database {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
    this._saveTimer = null;
  }

  async open() {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
    if (this.filePath && fs.existsSync(this.filePath)) {
      this.db = new SQL.Database(fs.readFileSync(this.filePath));
    } else {
      this.db = new SQL.Database();
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    for (const [table, col, type] of MIGRATIONS) {
      const cols = this.all(`PRAGMA table_info(${table})`).map((c) => c.name);
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
    this.flush();
    return this;
  }

  /** Run a write statement. Returns { changes, lastId }. */
  run(sql, params = []) {
    this.db.run(sql, params);
    const changes = this.db.getRowsModified();
    const lastId = this.get('SELECT last_insert_rowid() AS id').id;
    this.scheduleSave();
    return { changes, lastId };
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      this.scheduleSave();
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- settings helpers ----
  getSetting(key, fallback = null) {
    const row = this.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : fallback;
  }
  setSetting(key, value) {
    if (value === null || value === undefined) {
      this.run('DELETE FROM settings WHERE key = ?', [key]);
    } else {
      this.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, String(value)]);
    }
  }

  // ---- persistence (sql.js is in-memory; we write the file ourselves) ----
  scheduleSave() {
    if (!this.filePath) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 500);
  }
  flush() {
    if (!this.filePath || !this.db) return;
    clearTimeout(this._saveTimer);
    const data = Buffer.from(this.db.export());
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.filePath); // atomic replace
  }
  close() {
    this.flush();
    this.db.close();
  }
}

module.exports = { Database };
