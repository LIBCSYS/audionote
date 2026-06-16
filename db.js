'use strict';

const path = require('path');

// node:sqlite is built-in from Node 22.5+; fall back to better-sqlite3 on older versions
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = require('better-sqlite3');
}

const db = new DatabaseSync(path.join(__dirname, 'audionote.db'));

try { db.exec('PRAGMA journal_mode = WAL;'); } catch {}
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT DEFAULT (datetime('now')),
    method     TEXT,
    path       TEXT,
    status     INTEGER,
    ip         TEXT,
    referrer   TEXT,
    ua         TEXT,
    ms         INTEGER
  );
  CREATE INDEX IF NOT EXISTS visits_ts ON visits(ts);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS scan_dirs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    dirpath    TEXT UNIQUE NOT NULL,
    label      TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS songs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath     TEXT UNIQUE NOT NULL,
    title        TEXT NOT NULL,
    artist       TEXT DEFAULT '',
    album        TEXT DEFAULT '',
    duration_sec REAL DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now')),
    deleted_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS song_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id    INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    note_text  TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS timestamps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id      INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    time_seconds REAL NOT NULL,
    label        TEXT DEFAULT '',
    category     TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now'))
  );
`);

// ── Migrations for upgrading older databases ──────────────
// Run AFTER table creation so a fresh install already has the columns/tables.
// Each is wrapped: it harmlessly fails (and is ignored) when already applied.
// Legacy DBs created before deleted_at existed get the column added here.
try { db.exec('ALTER TABLE songs ADD COLUMN deleted_at TEXT'); } catch {}
// One note per song — app upserts assume this; skipped silently if legacy dup rows exist
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS song_notes_song_id ON song_notes(song_id)'); } catch {}

module.exports = db;
