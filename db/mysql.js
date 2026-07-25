'use strict';

/**
 * MySQL/MariaDB backend — same async interface as the SQLite backend.
 *
 * Credentials resolve in this order:
 *   1. explicit env vars (MYSQL_HOST / MYSQL_DB / MYSQL_USER / MYSQL_PASS)
 *   2. a root-owned secrets file (MYSQL_SECRETS_FILE)
 * There is deliberately NO hardcoded password fallback: a missing secret must
 * fail loudly at boot rather than silently connecting as the wrong identity.
 */

const fs    = require('fs');
const mysql = require('mysql2/promise');
const cfg   = require('../config');

function readSecrets(file) {
  try {
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0 && !line.trim().startsWith('#')) {
        out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

const s = readSecrets(cfg.MYSQL_SECRETS_FILE);

const host     = cfg.MYSQL.host     || s.JE9_PRIME_HOST || '127.0.0.1';
const database = cfg.MYSQL.database || s.JE9_PRIME_DB   || 'je9_prime';
const user     = cfg.MYSQL.user     || s.JE9_PRIME_USER;
const password = cfg.MYSQL.password || s.JE9_PRIME_PASS;

if (!user || !password) {
  throw new Error(
    `[db/mysql] No credentials. Set MYSQL_USER/MYSQL_PASS, or make ${cfg.MYSQL_SECRETS_FILE} readable ` +
    `(expects JE9_PRIME_USER / JE9_PRIME_PASS). Refusing to start with an unknown identity.`
  );
}

const pool = mysql.createPool({
  host, database, user, password,
  waitForConnections: true,
  connectionLimit: cfg.MYSQL.limit,
});

module.exports = {
  dialect: 'mysql',

  async all(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
  },

  async get(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows && rows.length ? rows[0] : undefined;
  },

  async run(sql, params = []) {
    const [r] = await pool.execute(sql, params);
    return {
      insertId: Number(r.insertId ?? 0),
      changes:  Number(r.affectedRows ?? 0),
    };
  },

  async exec(sql) {
    // DDL batches arrive semicolon-separated; pool.execute takes one at a time.
    for (const stmt of String(sql).split(';')) {
      if (stmt.trim()) await pool.query(stmt);
    }
  },

  async close() { try { await pool.end(); } catch {} },
};
