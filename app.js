'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { spawn } = require('child_process');
const cfg     = require('./config');
const db      = require('./db'); // engine-agnostic facade (sqlite | mysql)

let mm;
try {
  mm = require('music-metadata');
} catch (e) {
  console.warn('[AudioNote] music-metadata unavailable — files will use filename as title:', e.message);
}

const app        = express();
const PORT       = cfg.PORT;
const VERSION    = cfg.VERSION;                    // from package.json — one source of truth
const MUSIC_ROOT = cfg.MUSIC_ROOT || path.join(__dirname, '..');

// Supported audio formats for server-side scanning and streaming.
// Web mode decodes files locally in the browser; server mode needs this
// extension set (so non-MP3 files are cataloged) and a MIME map (so each
// file streams with the correct Content-Type instead of always audio/mpeg).
const AUDIO_EXTS = new Set([
  '.mp3', '.m4a', '.mp4', '.aac', '.wav', '.flac',
  '.ogg', '.oga', '.opus', '.webm', '.wma', '.aif', '.aiff',
]);
const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',  '.m4a': 'audio/mp4',    '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',   '.wav': 'audio/wav',    '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',   '.oga': 'audio/ogg',    '.opus': 'audio/ogg',
  '.webm': 'audio/webm', '.wma': 'audio/x-ms-wma',
  '.aif': 'audio/aiff',  '.aiff': 'audio/aiff',
};

// ── URL ingestion (yt-dlp) ───────────────────────────────
// Any http(s) URL with audio — YouTube, SoundCloud, Bandcamp, a bare .mp3,
// anything yt-dlp supports — is downloaded/transcoded to mp3 in url-cache/
// and catalogued as a normal song, so the existing player + notes just work.
const YTDLP_BIN   = process.env.YTDLP_BIN || '/usr/local/bin/yt-dlp';
const YTDLP_PROXY = process.env.YTDLP_PROXY || '';  // e.g. socks5://127.0.0.1:1080 (Tailscale->trixie) to dodge datacenter-IP bot-walls
const URL_CACHE   = process.env.URL_CACHE || path.join(__dirname, 'url-cache');
try { fs.mkdirSync(URL_CACHE, { recursive: true }); } catch {}

app.use(express.json({ limit: '10mb' }));

// Traffic logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    db.run(
      'INSERT INTO an_visits (method, path, status, ip, referrer, ua, ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.method, req.path, res.statusCode,
       req.headers['x-forwarded-for'] || req.ip || '',
       req.headers['referer'] || req.headers['referrer'] || '',
       req.headers['user-agent'] || '',
       Date.now() - start]
    ).catch(() => {});
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function scanDir(dir, results = []) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const item of items) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (path.normalize(full).toLowerCase() !== path.normalize(__dirname).toLowerCase()) scanDir(full, results);
    } else if (item.isFile() && AUDIO_EXTS.has(path.extname(item.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

app.get('/api/drives', (req, res) => {
  const drives = [];
  for (let i = 67; i <= 90; i++) {
    const drive = String.fromCharCode(i) + ':\\';
    if (fs.existsSync(drive)) drives.push(drive);
  }
  res.json(drives);
});

// ── SCAN DIRECTORIES ──────────────────────────────────────

app.get('/api/scan-dirs', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM an_scan_dirs ORDER BY created_at');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scan-dirs', async (req, res) => {
  const { dirpath, label } = req.body;
  if (!dirpath) return res.status(400).json({ error: 'dirpath required' });
  const normalizedPath = path.normalize(dirpath.trim());
  if (!fs.existsSync(normalizedPath)) return res.status(400).json({ error: `Directory not found: ${normalizedPath}` });
  try {
    const existing = await db.get('SELECT id FROM an_scan_dirs WHERE dirpath = ?', [normalizedPath]);
    if (existing) return res.status(409).json({ error: 'Directory already added' });
    const result = await db.run('INSERT INTO an_scan_dirs (dirpath, label) VALUES (?, ?)', [normalizedPath, label || '']);
    const row = await db.get('SELECT * FROM an_scan_dirs WHERE id = ?', [result.insertId]);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/scan-dirs/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM an_scan_dirs WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const SONGS_QUERY = `
  SELECT s.*,
    CASE WHEN sn.note_text IS NOT NULL AND sn.note_text != '' THEN 1 ELSE 0 END AS has_note
  FROM an_songs s
  LEFT JOIN an_song_notes sn ON sn.song_id = s.id
  WHERE s.deleted_at IS NULL
  ORDER BY s.artist, s.title
`;

app.post('/api/rescan', async (req, res) => {
  try {
    const dirRows = await db.all('SELECT dirpath FROM an_scan_dirs');
    const configuredDirs = dirRows.map(r => r.dirpath);
    const dirsToScan = configuredDirs.length ? configuredDirs : [MUSIC_ROOT];
    const files = [];
    for (const dir of dirsToScan) scanDir(dir, files);

    let added = 0;
    for (const fp of files) {
      const existing = await db.get('SELECT id, deleted_at FROM an_songs WHERE filepath = ?', [fp]);
      let title = path.basename(fp, path.extname(fp));
      let artist = '', album = '', duration_sec = 0;
      if (mm) {
        try {
          const meta = await mm.parseFile(fp, { duration: true, skipCovers: true });
          title        = meta.common.title  || title;
          artist       = meta.common.artist || '';
          album        = meta.common.album  || '';
          duration_sec = meta.format.duration || 0;
        } catch {}
      }
      if (!existing) {
        await db.run(
          'INSERT IGNORE INTO an_songs (filepath, title, artist, album, duration_sec) VALUES (?, ?, ?, ?, ?)',
          [fp, title, artist, album, duration_sec]
        );
        added++;
      } else if (existing.deleted_at) {
        await db.run(
          'UPDATE an_songs SET deleted_at = NULL, title=?, artist=?, album=?, duration_sec=? WHERE id=?',
          [title, artist, album, duration_sec, existing.id]
        );
        added++;
      }
    }

    const allSongs = await db.all('SELECT id, filepath FROM an_songs WHERE deleted_at IS NULL');
    const removed = allSongs.filter(s => !fs.existsSync(s.filepath));
    for (const s of removed) {
      await db.run('UPDATE an_songs SET deleted_at = NOW() WHERE id = ?', [s.id]);
    }

    const songs = await db.run(SONGS_QUERY);
    res.json({ added, removed: removed.length, total: songs.length, songs });
  } catch (err) {
    console.error('[rescan error]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/songs', async (req, res) => {
  try {
    const rows = await db.all(SONGS_QUERY);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/songs/:id/notes', async (req, res) => {
  try {
    const note = await db.get('SELECT * FROM an_song_notes WHERE song_id = ?', [req.params.id]);
    res.json(note || { note_text: '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/songs/:id/notes', async (req, res) => {
  try {
    const { note_text } = req.body;
    const exists = await db.get('SELECT id FROM an_song_notes WHERE song_id = ?', [req.params.id]);
    if (exists) {
      await db.run('UPDATE an_song_notes SET note_text = ? WHERE song_id = ?', [note_text, req.params.id]);
    } else {
      await db.run('INSERT INTO an_song_notes (song_id, note_text) VALUES (?, ?)', [req.params.id, note_text]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/songs/:id/timestamps', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM an_timestamps WHERE song_id = ? ORDER BY time_seconds', [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/songs/:id/timestamps', async (req, res) => {
  try {
    const { time_seconds, label = '', category = '' } = req.body;
    if (typeof time_seconds !== 'number' || !isFinite(time_seconds) || time_seconds < 0) {
      return res.status(400).json({ error: 'time_seconds must be a non-negative number' });
    }
    const result = await db.run(
      'INSERT INTO an_timestamps (song_id, time_seconds, label, category) VALUES (?, ?, ?, ?)',
      [req.params.id, time_seconds, label, category]
    );
    const row = await db.get('SELECT * FROM an_timestamps WHERE id = ?', [result.insertId]);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/songs/:id', async (req, res) => {
  try {
    await db.run('UPDATE an_songs SET deleted_at = NOW() WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/songs/:id/rename', async (req, res) => {
  const { newName } = req.body;
  if (!newName || !newName.trim()) return res.status(400).json({ error: 'Name required' });

  try {
    const song = await db.get('SELECT * FROM an_songs WHERE id = ?', [req.params.id]);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    if (song.filepath.startsWith('web:')) return res.status(400).json({ error: 'Cannot rename a browser-local file from the server' });

    const safeName = newName.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });

    const dir     = path.dirname(song.filepath);
    const ext     = path.extname(song.filepath);
    const newPath = path.join(dir, safeName + ext);

    if (newPath !== song.filepath && fs.existsSync(newPath)) {
      return res.status(409).json({ error: 'A file with that name already exists' });
    }
    if (newPath !== song.filepath) fs.renameSync(song.filepath, newPath);
    await db.run('UPDATE an_songs SET filepath = ?, title = ? WHERE id = ?', [newPath, safeName, req.params.id]);
    res.json({ ok: true, filepath: newPath, title: safeName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CSV IMPORT ────────────────────────────────────────────

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r' && n === '\n') { row.push(field); field = ''; rows.push(row); row = []; i++; }
      else if (c === '\n' || c === '\r') { row.push(field); field = ''; rows.push(row); row = []; }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim()));
}

const COL_ALIASES = {
  filepath:      ['filepath','file_path','path','location','file location','file','track location'],
  title:         ['title','name','track','track name','song','song name','song title','track title'],
  artist:        ['artist','artist name','artists','performer','artist(s)','album artist'],
  album:         ['album','album name','album title','release','disc'],
  duration_sec:  ['duration_sec','duration','length','total time','time_seconds_total','playtime'],
  note_text:     ['note','note_text','notes','comment','comments','description','annotation','lyrics'],
  time_seconds:  ['time_seconds','time','position','offset','offset_sec','cue','cue_seconds'],
  time_formatted:['time_formatted','timestamp','time_format','cue_time','marker','mark','timecode'],
  label:         ['label','marker_label','tag','marker_name','cue_name','note_label','cue_label'],
  category:      ['category','cat','type','genre_marker','cue_type'],
};

function mapHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const key = h.trim().toLowerCase().replace(/\s+/g, ' ');
    for (const [col, aliases] of Object.entries(COL_ALIASES)) {
      if (aliases.includes(key) && !(col in map)) { map[col] = i; break; }
    }
  });
  return map;
}

function parseTimeFmt(str) {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split(':').map(p => parseFloat(p) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

app.post('/api/import/csv', async (req, res) => {
  const { csv } = req.body;
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv string required' });

  let rows;
  try { rows = parseCSV(csv); } catch (e) { return res.status(400).json({ error: 'CSV parse error: ' + e.message }); }
  if (rows.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });

  const headers = rows[0];
  const col     = mapHeaders(headers);
  const get     = (row, key) => col[key] !== undefined ? (row[col[key]] || '').trim() : '';

  const songMap = new Map();
  for (const row of rows.slice(1)) {
    const fp    = get(row, 'filepath');
    const title = get(row, 'title');
    const artist= get(row, 'artist');
    const key   = fp || `${title}|||${artist}`;
    if (!key || key === '|||') continue;
    if (!songMap.has(key)) {
      songMap.set(key, {
        filepath:     fp,
        title:        title || 'Unknown',
        artist:       artist || '',
        album:        get(row, 'album'),
        duration_sec: parseFloat(get(row, 'duration_sec')) || 0,
        rows: [],
      });
    }
    songMap.get(key).rows.push(row);
  }

  let songs_added = 0, songs_updated = 0, notes_set = 0, timestamps_added = 0, skipped = 0;

  try {
    for (const [, song] of songMap) {
      const fp = song.filepath || `import:${song.title}`;

      const info = await db.run(
        'INSERT IGNORE INTO an_songs (filepath, title, artist, album, duration_sec) VALUES (?, ?, ?, ?, ?)',
        [fp, song.title, song.artist, song.album, song.duration_sec]
      );
      if (info.affectedRows > 0) {
        songs_added++;
      } else {
        await db.run(
          'UPDATE an_songs SET title=?, artist=?, album=?, duration_sec=?, deleted_at=NULL WHERE filepath=?',
          [song.title, song.artist, song.album, song.duration_sec, fp]
        );
        songs_updated++;
      }

      const dbSong = await db.get('SELECT id FROM an_songs WHERE filepath=?', [fp]);
      if (!dbSong) { skipped++; continue; }
      const songId = dbSong.id;

      const noteText = song.rows.map(r => get(r, 'note_text')).find(n => n) || '';
      if (noteText) {
        const noteExists = await db.get('SELECT id FROM an_song_notes WHERE song_id = ?', [songId]);
        if (noteExists) {
          await db.run('UPDATE an_song_notes SET note_text = ? WHERE song_id = ?', [noteText, songId]);
        } else {
          await db.run('INSERT INTO an_song_notes (song_id, note_text) VALUES (?, ?)', [songId, noteText]);
        }
        notes_set++;
      }

      for (const row of song.rows) {
        let secs = parseFloat(get(row, 'time_seconds'));
        if (isNaN(secs) || secs === 0) {
          const parsed = parseTimeFmt(get(row, 'time_formatted'));
          if (parsed !== null) secs = parsed;
          else continue;
        }
        const hasTs = await db.get(
          'SELECT id FROM an_timestamps WHERE song_id=? AND ABS(time_seconds - ?) < 0.5',
          [songId, secs]
        );
        if (!hasTs) {
          await db.run(
            'INSERT INTO an_timestamps (song_id, time_seconds, label, category) VALUES (?, ?, ?, ?)',
            [songId, secs, get(row, 'label'), get(row, 'category')]
          );
          timestamps_added++;
        }
      }
    }
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const { n: total } = await db.get('SELECT COUNT(*) AS n FROM an_songs WHERE deleted_at IS NULL');
  res.json({ songs_added, songs_updated, notes_set, timestamps_added, skipped, total, columns_detected: Object.keys(col) });
});

// CSV export
app.get('/api/export/csv', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT
        s.id            AS song_id,
        s.title, s.artist, s.album,
        s.duration_sec,
        s.filepath,
        s.created_at    AS cataloged_at,
        sn.note_text,
        sn.updated_at   AS note_updated_at,
        ts.id           AS timestamp_id,
        ts.time_seconds,
        ts.label,
        ts.category,
        ts.created_at   AS marked_at
      FROM an_songs s
      LEFT JOIN an_song_notes sn ON sn.song_id = s.id AND sn.note_text != ''
      LEFT JOIN an_timestamps  ts ON ts.song_id = s.id
      ORDER BY s.artist, s.title, ts.time_seconds
    `);

    const fmtTime = s => {
      if (s === null || s === undefined) return '';
      return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    };
    const cell = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const headers = [
      'song_id','title','artist','album',
      'duration_sec','duration_formatted',
      'filepath','note','note_updated_at',
      'timestamp_id','time_seconds','time_formatted',
      'label','category','marked_at','cataloged_at'
    ];
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        r.song_id, cell(r.title), cell(r.artist), cell(r.album),
        r.duration_sec ?? '', fmtTime(r.duration_sec),
        cell(r.filepath), cell(r.note_text ?? ''), r.note_updated_at ?? '',
        r.timestamp_id ?? '', r.time_seconds ?? '', fmtTime(r.time_seconds),
        cell(r.label ?? ''), cell(r.category ?? ''), r.marked_at ?? '', r.cataloged_at
      ].join(','));
    }

    const csv = lines.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audionote-export.csv"');
    res.send('﻿' + csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ANALYTICS ────────────────────────────────────────────

app.get('/api/analytics', async (req, res) => {
  try {
    const { total } = await db.get('SELECT COUNT(*) AS total FROM an_visits');
    const { today } = await db.get('SELECT COUNT(*) AS today FROM an_visits WHERE DATE(ts) = CURDATE()');
    const { week } = await db.get('SELECT COUNT(*) AS week FROM an_visits WHERE ts >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)');
    const { avgMs } = await db.get('SELECT ROUND(AVG(ms),1) AS avgMs FROM an_visits WHERE ts >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)');
    const { uniqIPs } = await db.get("SELECT COUNT(DISTINCT ip) AS uniqIPs FROM an_visits WHERE ip != ''");
    const topPaths = await db.all('SELECT path, COUNT(*) AS hits FROM an_visits GROUP BY path ORDER BY hits DESC LIMIT 15');
    const recent = await db.all('SELECT ts, method, path, status, ip, ms FROM an_visits ORDER BY id DESC LIMIT 50');
    const byDay = await db.all("SELECT DATE(ts) AS day, COUNT(*) AS hits FROM an_visits WHERE ts >= DATE_SUB(CURDATE(), INTERVAL 29 DAY) GROUP BY day ORDER BY day");
    res.json({ total, today, week, avgMs, uniqIPs, topPaths, recent, byDay });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/timestamps/:id', async (req, res) => {
  try {
    const { label = '', category = '' } = req.body;
    await db.run('UPDATE an_timestamps SET label = ?, category = ? WHERE id = ?', [label, category, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/timestamps/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM an_timestamps WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stream audio with range support
app.get('/audio/:id', async (req, res) => {
  try {
    const song = await db.get('SELECT filepath FROM an_songs WHERE id = ?', [req.params.id]);
    if (!song || !fs.existsSync(song.filepath)) return res.status(404).send('Not found');

    const stat     = fs.statSync(song.filepath);
    const fileSize = stat.size;
    const ctype    = MIME_BY_EXT[path.extname(song.filepath).toLowerCase()] || 'audio/mpeg';
    const range    = req.headers.range;

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      // Suffix range (bytes=-N) means "last N bytes"
      let start = m && m[1] !== '' ? parseInt(m[1], 10)
                : m && m[2] !== '' ? Math.max(0, fileSize - parseInt(m[2], 10))
                : NaN;
      let end   = m && m[1] !== '' && m[2] !== '' ? parseInt(m[2], 10) : fileSize - 1;
      if (isNaN(start) || start >= fileSize || start > end) {
        return res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` }).end();
      }
      end = Math.min(end, fileSize - 1);
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
        'Content-Type':   ctype,
      });
      fs.createReadStream(song.filepath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type':   ctype,
        'Accept-Ranges':  'bytes',
      });
      fs.createReadStream(song.filepath).pipe(res);
    }
  } catch (e) { res.status(500).send('Error'); }
});

// Web mode upsert
app.post('/api/songs/web-upsert', async (req, res) => {
  const songs = req.body;
  if (!Array.isArray(songs)) return res.status(400).json({ error: 'expected array' });
  const result = [];
  try {
    for (const s of songs) {
      if (!s.filepath) continue;
      const existing = await db.get('SELECT * FROM an_songs WHERE filepath = ?', [s.filepath]);
      if (existing) {
        await db.run(
          'UPDATE an_songs SET title=?, artist=?, album=?, duration_sec=?, deleted_at=NULL WHERE id=?',
          [s.title || existing.title, s.artist || '', s.album || '', s.duration_sec || 0, existing.id]
        );
        result.push({ ...existing, title: s.title || existing.title, artist: s.artist || '', album: s.album || '', duration_sec: s.duration_sec || 0, deleted_at: null, has_note: 0 });
      } else {
        const info = await db.run(
          'INSERT INTO an_songs (filepath, title, artist, album, duration_sec) VALUES (?, ?, ?, ?, ?)',
          [s.filepath, s.title || 'Unknown', s.artist || '', s.album || '', s.duration_sec || 0]
        );
        result.push({ id: info.insertId, filepath: s.filepath, title: s.title || 'Unknown', artist: s.artist || '', album: s.album || '', duration_sec: s.duration_sec || 0, created_at: new Date().toISOString(), deleted_at: null, has_note: 0 });
      }
    }
    for (const r of result) {
      const n = await db.get('SELECT note_text FROM an_song_notes WHERE song_id = ?', [r.id]);
      r.has_note = (n && n.note_text) ? 1 : 0;
    }
    result.sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || a.title.localeCompare(b.title));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Add from URL ─────────────────────────────────────────
// Runs yt-dlp to extract audio from any supported URL, caches it as mp3,
// and inserts an an_songs row. Returns the same song shape as web-upsert.
function runYtdlp(url, outTemplate, useProxy) {
  return new Promise((resolve, reject) => {
    const args = [
      '-x', '--audio-format', 'mp3',
      '--no-playlist', '--no-progress', '--no-warnings',
      '--no-simulate',
      '--print', '%(title)s\t%(uploader)s\t%(duration)s\t%(thumbnail)s',
      '-o', outTemplate,
    ];
    if (useProxy && YTDLP_PROXY) args.push('--proxy', YTDLP_PROXY);
    args.push(url);
    const proc = spawn(YTDLP_BIN, args, { timeout: 900000 });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', e => reject(new Error(`yt-dlp failed to start: ${e.message}`)));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited ${code}`));
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      const [title, uploader, duration, thumbnail] = line.split('\t');
      resolve({
        title:     (title && title !== 'NA') ? title : '',
        artist:    (uploader && uploader !== 'NA') ? uploader : '',
        duration:  parseFloat(duration) || 0,
        thumbnail: (thumbnail && thumbnail !== 'NA') ? thumbnail : null,
      });
    });
  });
}

// Turn raw yt-dlp failures into a short, human message. Returned with HTTP 200
// (see below) so the reverse proxy's HTML error pages never replace the JSON.
function friendlyYtdlpError(msg) {
  const m = String(msg || '');
  if (/sign in to confirm|not a bot|cookies/i.test(m))
    return 'That site blocked the request from our server (YouTube does this to shared servers). Try a direct audio-file link (.mp3/.m4a) or a non-YouTube source.';
  if (/unsupported url|no video formats|unable to (extract|download)|not a valid url/i.test(m))
    return 'Couldn’t find audio at that link.';
  if (/private|members-only|login required|age|drm/i.test(m))
    return 'That link needs sign-in or is restricted, so its audio can’t be fetched.';
  if (/timed out|timeout|etimedout/i.test(m))
    return 'That link took too long to fetch. Try again, or use a direct audio link.';
  return m.replace(/^ERROR:\s*/i, '').replace(/\s+See\s+https?:\/\/\S+.*$/i, '').slice(0, 240) || 'Extraction failed.';
}

// In-progress extractions, keyed by URL. Extraction runs in the background so a
// long track (e.g. a 1-hour video through the proxy) never holds the HTTP
// request open past a proxy timeout — the client polls this same endpoint and
// the dedupe check hands back the finished song once it lands.
const urlJobs = new Map(); // url -> { status:'running'|'error', error?, startedAt }

async function extractToSong(url) {
  const key       = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const outTmpl   = path.join(URL_CACHE, `${key}.%(ext)s`);
  const finalPath = path.join(URL_CACHE, `${key}.mp3`);
  // Try direct first (so direct/most URLs never depend on the proxy tunnel),
  // then fall back to YTDLP_PROXY only if the direct attempt fails.
  let meta;
  try {
    meta = await runYtdlp(url, outTmpl, false);
  } catch (eDirect) {
    if (!YTDLP_PROXY) throw eDirect;
    meta = await runYtdlp(url, outTmpl, true);
  }
  if (!fs.existsSync(finalPath)) throw new Error('No audio could be extracted from that URL');
  const title = meta.title || url.replace(/^https?:\/\//, '').slice(0, 120);
  await db.run(
    'INSERT INTO an_songs (filepath, source_url, thumbnail_url, title, artist, album, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [finalPath, url, meta.thumbnail, title, meta.artist, '', meta.duration]
  );
}

async function songForUrl(url) {
  const s = await db.get('SELECT * FROM an_songs WHERE source_url = ? AND deleted_at IS NULL LIMIT 1', [url]);
  if (!s) return null;
  const n = await db.get('SELECT note_text FROM an_song_notes WHERE song_id = ?', [s.id]);
  return { ...s, has_note: (n && n.note_text) ? 1 : 0 };
}

app.post('/api/songs/from-url', async (req, res) => {
  const url = ((req.body && req.body.url) || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return res.json({ error: 'Enter a valid http(s) URL' });
  try {
    // Already have it (finished on a previous poll, or added earlier)?
    const done = await songForUrl(url);
    if (done) return res.json({ ...done, reused: true });

    // A job in flight for this URL?
    const job = urlJobs.get(url);
    if (job) {
      if (job.status === 'error') { urlJobs.delete(url); return res.json({ error: job.error }); }
      return res.json({ status: 'processing' }); // still running — client keeps polling
    }

    // Start a new background extraction and return immediately.
    urlJobs.set(url, { status: 'running', startedAt: Date.now() });
    extractToSong(url)
      .then(() => { urlJobs.delete(url); }) // next poll's dedupe returns the song
      .catch(e => {
        console.error('[AudioNote] from-url error:', e.message);
        urlJobs.set(url, { status: 'error', error: friendlyYtdlpError(e.message) });
      });
    res.json({ status: 'processing' });
  } catch (e) {
    console.error('[AudioNote] from-url route error:', e.message);
    res.json({ error: friendlyYtdlpError(e.message) });
  }
});

// App version — single source of truth for the UI footer
app.get('/api/version', (req, res) => res.json({ version: VERSION }));

// Deployment-specific presentation, served to the client so that what used to be
// a hard-coded fork (WEB_MODE, chat widget, site badge) is now configuration.
app.get('/api/config', (req, res) => res.json({
  version:      VERSION,
  webMode:      cfg.WEB_MODE,
  chatEnabled:  cfg.CHAT_ENABLED,
  chatEndpoint: cfg.CHAT_ENDPOINT,
  siteBadge:    cfg.SITE_BADGE,
  siteBadgeUrl: cfg.SITE_BADGE_URL,
  brandName:    cfg.BRAND_NAME,
  brandTagline: cfg.BRAND_TAGLINE,
}));

// Catch-all 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'error.html'));
});

const BIND = process.env.BIND_ADDR || '127.0.0.1';

// Ensure the schema exists before accepting traffic. Idempotent on a populated DB.
db.init()
  .then(() => {
    app.listen(PORT, BIND, () => {
      const os   = require('os');
      const nets = Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal);
      const ip   = nets.length ? nets[0].address : 'YOUR_IP';
      console.log(`\n${cfg.BRAND_NAME} v${VERSION}  [db=${db.dialect} prefix="${cfg.TABLE_PREFIX}"]`);
      console.log(`Local     : http://localhost:${PORT}`);
      console.log(`Network   : http://${ip}:${PORT}`);
      console.log(`Music root: ${MUSIC_ROOT}\n`);
    });
  })
  .catch(err => {
    console.error('[AudioNote] database init failed — refusing to start:', err.message);
    process.exit(1);
  });
