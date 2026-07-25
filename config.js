'use strict';

/**
 * AudioNote — single source of configuration.
 *
 * Everything that used to differ between the public repo and the je9 deployment
 * is expressed here as environment config, NOT as a code fork. Same artifact
 * everywhere; only the environment changes.
 */

/**
 * Load a .env file sitting next to this module into process.env, without adding
 * a dependency. Real environment variables always win, so a process manager or
 * shell export can still override the file.
 */
(function loadDotEnv() {
  try {
    const fs = require('fs'), path = require('path');
    const file = process.env.ENV_FILE || path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* config falls back to defaults */ }
})();

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

const DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase();

module.exports = {
  // --- app ---
  PORT:        parseInt(process.env.PORT || '2600', 10),
  VERSION:     require('./package.json').version,

  // --- database ---
  DB_DRIVER:   DRIVER,                                   // 'sqlite' | 'mysql'
  TABLE_PREFIX: process.env.TABLE_PREFIX || (DRIVER === 'mysql' ? 'an_' : ''),
  SQLITE_PATH: process.env.SQLITE_PATH || 'audionote.db',
  // mysql creds come from a secrets file (never hardcoded) or discrete env vars
  MYSQL_SECRETS_FILE: process.env.MYSQL_SECRETS_FILE || '/etc/je9/je9_prime.je9',
  MYSQL: {
    host:     process.env.MYSQL_HOST,
    database: process.env.MYSQL_DB,
    user:     process.env.MYSQL_USER,
    password: process.env.MYSQL_PASS,
    limit:    parseInt(process.env.MYSQL_POOL || '5', 10),
  },

  // --- media ---
  MUSIC_ROOT:  process.env.MUSIC_ROOT || '',
  URL_CACHE:   process.env.URL_CACHE  || '',
  YTDLP_BIN:   process.env.YTDLP_BIN  || 'yt-dlp',
  YTDLP_PROXY: process.env.YTDLP_PROXY || '',

  // --- deployment-specific presentation (was hard-coded personalisation) ---
  WEB_MODE:      bool(process.env.WEB_MODE, false),      // browser-side file picking
  CHAT_ENABLED:  bool(process.env.CHAT_ENABLED, false),  // "Ask AudioNote" assistant
  CHAT_ENDPOINT: process.env.CHAT_ENDPOINT || '',
  SITE_BADGE:    process.env.SITE_BADGE || '',           // e.g. "je9.us"
  SITE_BADGE_URL:process.env.SITE_BADGE_URL || '',
  ANALYTICS:     bool(process.env.ANALYTICS, false),     // visit logging
  BRAND_NAME:    process.env.BRAND_NAME || 'AudioNote',
  BRAND_TAGLINE: process.env.BRAND_TAGLINE || '',
};
