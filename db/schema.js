'use strict';

/**
 * Schema DDL, per dialect.
 *
 * Every statement is CREATE TABLE IF NOT EXISTS and mirrors the shape already
 * live on je9 (je9_prime.an_*), so running this against production is a no-op.
 * Table names are prefixed at runtime via cfg.TABLE_PREFIX.
 */

module.exports = function schema(dialect, T) {
  if (dialect === 'mysql') {
    return [
      `CREATE TABLE IF NOT EXISTS ${T('visits')} (
         id int(10) unsigned NOT NULL AUTO_INCREMENT,
         ts datetime DEFAULT current_timestamp(),
         method varchar(10) DEFAULT NULL,
         path varchar(500) DEFAULT NULL,
         status int(11) DEFAULT NULL,
         ip varchar(45) DEFAULT NULL,
         referrer text DEFAULT NULL,
         ua text DEFAULT NULL,
         ms int(11) DEFAULT NULL,
         PRIMARY KEY (id), KEY idx_ts (ts)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS ${T('scan_dirs')} (
         id int(10) unsigned NOT NULL AUTO_INCREMENT,
         dirpath text DEFAULT NULL,
         label varchar(255) DEFAULT NULL,
         created_at datetime DEFAULT current_timestamp(),
         PRIMARY KEY (id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS ${T('songs')} (
         id int(10) unsigned NOT NULL AUTO_INCREMENT,
         filepath text DEFAULT NULL,
         source_url varchar(1000) DEFAULT NULL,
         thumbnail_url text DEFAULT NULL,
         title varchar(500) DEFAULT NULL,
         artist varchar(255) DEFAULT NULL,
         album varchar(255) DEFAULT NULL,
         duration_sec decimal(10,3) DEFAULT NULL,
         created_at datetime DEFAULT current_timestamp(),
         deleted_at datetime DEFAULT NULL,
         PRIMARY KEY (id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS ${T('song_notes')} (
         id int(10) unsigned NOT NULL AUTO_INCREMENT,
         song_id int(10) unsigned DEFAULT NULL,
         note_text text DEFAULT NULL,
         updated_at datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
         PRIMARY KEY (id), KEY idx_song (song_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS ${T('timestamps')} (
         id int(10) unsigned NOT NULL AUTO_INCREMENT,
         song_id int(10) unsigned DEFAULT NULL,
         time_seconds decimal(10,3) DEFAULT NULL,
         label varchar(500) DEFAULT NULL,
         category varchar(100) DEFAULT NULL,
         created_at datetime DEFAULT current_timestamp(),
         PRIMARY KEY (id), KEY idx_song (song_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
  }

  // sqlite
  return [
    `CREATE TABLE IF NOT EXISTS ${T('visits')} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ts TEXT DEFAULT (datetime('now')),
       method TEXT, path TEXT, status INTEGER, ip TEXT,
       referrer TEXT, ua TEXT, ms INTEGER)`,
    `CREATE INDEX IF NOT EXISTS ${T('visits')}_ts ON ${T('visits')}(ts)`,

    `CREATE TABLE IF NOT EXISTS ${T('scan_dirs')} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       dirpath TEXT UNIQUE NOT NULL,
       label TEXT DEFAULT '',
       created_at TEXT DEFAULT (datetime('now')))`,

    `CREATE TABLE IF NOT EXISTS ${T('songs')} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       filepath TEXT UNIQUE NOT NULL,
       source_url TEXT, thumbnail_url TEXT,
       title TEXT NOT NULL,
       artist TEXT DEFAULT '', album TEXT DEFAULT '',
       duration_sec REAL DEFAULT 0,
       created_at TEXT DEFAULT (datetime('now')),
       deleted_at TEXT)`,

    `CREATE TABLE IF NOT EXISTS ${T('song_notes')} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       song_id INTEGER NOT NULL REFERENCES ${T('songs')}(id) ON DELETE CASCADE,
       note_text TEXT DEFAULT '',
       updated_at TEXT DEFAULT (datetime('now')))`,

    `CREATE TABLE IF NOT EXISTS ${T('timestamps')} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       song_id INTEGER NOT NULL REFERENCES ${T('songs')}(id) ON DELETE CASCADE,
       time_seconds REAL NOT NULL,
       label TEXT DEFAULT '', category TEXT DEFAULT '',
       created_at TEXT DEFAULT (datetime('now')))`,
  ];
};
