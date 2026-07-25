'use strict';

/**
 * Database facade.
 *
 * app.js talks ONLY to this module and never knows which engine is underneath.
 * Choosing an engine is configuration (DB_DRIVER), not a code fork — which is
 * what previously caused the public repo and the je9 deployment to diverge.
 *
 *   await db.all(sql, params)  -> rows[]
 *   await db.get(sql, params)  -> row | undefined
 *   await db.run(sql, params)  -> { insertId, changes }
 *   await db.exec(sql)         -> DDL
 *   db.T('songs')              -> prefixed table name
 *
 * Write portable, MySQL-flavoured SQL; the SQLite backend translates.
 */

const cfg    = require('../config');
const schema = require('./schema');

const backend = cfg.DB_DRIVER === 'mysql'
  ? require('./mysql')
  : require('./sqlite');

/** Prefix a logical table name (je9 uses `an_`, local uses none). */
function T(name) {
  return `${cfg.TABLE_PREFIX}${name}`;
}

/**
 * Canonical table names are written `an_<table>` in SQL throughout app.js.
 * Rewrite that logical prefix to whatever this deployment actually uses, so the
 * query text never has to be edited per environment.
 */
const TABLES = ['songs', 'song_notes', 'timestamps', 'scan_dirs', 'visits'];
const TABLE_RE = new RegExp(`\\ban_(${TABLES.join('|')})\\b`, 'g');

function rewrite(sql) {
  return cfg.TABLE_PREFIX === 'an_'
    ? sql
    : String(sql).replace(TABLE_RE, (_m, t) => T(t));
}

let readyPromise = null;

/** Create any missing tables. Idempotent — safe against a populated database. */
async function init() {
  if (!readyPromise) {
    readyPromise = (async () => {
      for (const stmt of schema(backend.dialect, T)) {
        await backend.exec(stmt);
      }
      return true;
    })();
  }
  return readyPromise;
}

module.exports = {
  T,
  init,
  dialect: backend.dialect,
  all:  (sql, params) => backend.all(rewrite(sql), params),
  get:  (sql, params) => backend.get(rewrite(sql), params),
  run:  (sql, params) => backend.run(rewrite(sql), params),
  exec: (sql)         => backend.exec(rewrite(sql)),
  close:()            => backend.close(),
};
