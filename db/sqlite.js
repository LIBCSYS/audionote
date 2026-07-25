'use strict';

/**
 * SQLite backend — presents the SAME async interface as the MySQL backend.
 *
 * node:sqlite is built in from Node 22.5+; better-sqlite3 is the fallback.
 * The driver is synchronous, so every method simply returns a resolved promise;
 * that keeps one calling convention across both backends.
 */

const path = require('path');
const cfg  = require('../config');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = require('better-sqlite3');
}

const file = path.isAbsolute(cfg.SQLITE_PATH)
  ? cfg.SQLITE_PATH
  : path.join(__dirname, '..', cfg.SQLITE_PATH);

const db = new DatabaseSync(file);
try { db.exec('PRAGMA journal_mode = WAL;'); } catch {}
try { db.exec('PRAGMA foreign_keys = ON;'); } catch {}

/** Translate the portable (MySQL-flavoured) SQL used in app.js into SQLite. */
function tr(sql) {
  return String(sql)
    .replace(/\bINSERT\s+IGNORE\b/gi, 'INSERT OR IGNORE')
    .replace(/\bNOW\(\)/gi, "datetime('now')")
    .replace(/\bAUTO_INCREMENT\b/gi, 'AUTOINCREMENT');
}

module.exports = {
  dialect: 'sqlite',

  async all(sql, params = []) {
    return db.prepare(tr(sql)).all(...params);
  },

  async get(sql, params = []) {
    return db.prepare(tr(sql)).get(...params);
  },

  async run(sql, params = []) {
    const r = db.prepare(tr(sql)).run(...params);
    return {
      insertId: Number(r.lastInsertRowid ?? r.lastInsertROWID ?? 0),
      changes:  Number(r.changes ?? 0),
    };
  },

  async exec(sql) {
    db.exec(tr(sql));
  },

  async close() { try { db.close(); } catch {} },
};
