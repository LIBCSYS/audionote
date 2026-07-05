'use strict';

const state = { songs: [], currentSong: null, timestamps: [], notedOnly: false };
const WEB_MODE    = !!window.WEB_MODE;
const fileHandles = new Map(); // WEB_MODE: songId -> File

const $ = id => document.getElementById(id);

const audio       = $('audio');
const playBtn     = $('play-btn');
const progressBar = $('progress');
const tCurrent    = $('t-current');
const tTotal      = $('t-total');
const volumeBar   = $('volume');
const markBtn     = $('mark-btn');
const noteInput   = $('note-input');
const noteStatus  = $('note-status');
const tsList      = $('ts-list');
const tsCount     = $('ts-count');
const songList    = $('song-list');
const searchInput = $('search-input');
const songCount   = $('song-count');
const playerPanel = $('player-panel');
const emptyState  = $('empty-state');
const rescanBtn   = $('rescan-btn');
const notedFilter = $('noted-filter');
const renameBtn   = $('rename-btn');
const deleteBtn   = $('delete-btn');
const scanPanel    = $('scan-panel');
const foldersList  = $('folders-list');
const drivesHint   = $('drives-hint');
const drivesList   = $('drives-list');
const foldersSection = $('folders-section');
const folderInput  = $('folder-input');
const folderAddBtn = $('folder-add-btn');
const folderError  = $('folder-error');
const scanNowBtn   = $('scan-now-btn');
const openFileBtn  = $('open-file-btn');
const openFileInput = $('open-file-input');

function fmt(s) {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── SONG LIST ──────────────────────────────────────────────

async function loadSongs() {
  if (WEB_MODE) return;
  try {
    const res = await fetch('/api/songs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.songs = await res.json();
    applyFilters();
  } catch (e) {
    console.error('[AudioNote] Failed to load songs:', e);
    songList.innerHTML = '<li style="padding:12px 16px;font-style:italic;color:var(--danger)">Could not load library — is the server running?</li>';
  }
}

function visibleSongs() {
  return state.notedOnly ? state.songs.filter(s => s.has_note) : state.songs;
}

function renderSongList(songs) {
  songCount.textContent = `${songs.length} track${songs.length !== 1 ? 's' : ''}`;
  songList.innerHTML = '';
  if (!songs.length) {
    const msg = state.notedOnly
      ? 'No noted tracks yet'
      : (WEB_MODE
          ? 'Click <strong>🎵 Add Files</strong> to load your MP3s'
          : 'Add a music folder in the scan panel, then click <strong>↻ Scan Now</strong>');
    songList.innerHTML = `<li class="muted" style="padding:12px 16px;font-style:italic;line-height:1.5">${msg}</li>`;
    return;
  }
  for (const s of songs) {
    const li = document.createElement('li');
    if (state.currentSong?.id === s.id) li.classList.add('active');
    li.dataset.id = s.id;
    const meta = [s.artist, s.album].filter(Boolean).join(' · ');
    const dur  = s.duration_sec ? `<span class="song-duration">${fmt(s.duration_sec)}</span>` : '';
    li.innerHTML = `
      <div class="song-item-title">${esc(s.title)}${s.has_note ? '<span class="note-flag" aria-label="has note">📝</span>' : ''}</div>
      <div class="song-item-meta">${esc(meta)}${dur}</div>
    `;
    li.addEventListener('click', () => selectSong(s));
    songList.appendChild(li);
  }
}

// ── SELECT SONG ────────────────────────────────────────────

async function selectSong(song) {
  state.currentSong = song;

  document.querySelectorAll('#song-list li').forEach(li =>
    li.classList.toggle('active', parseInt(li.dataset.id) === song.id)
  );

  $('np-title').textContent = song.title;
  $('np-meta').textContent  = [song.artist, song.album].filter(Boolean).join(' · ') || 'Unknown';

  if (WEB_MODE) {
    const file = fileHandles.get(song.id);
    if (audio.src && audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    if (file) {
      audio.src = URL.createObjectURL(file);
    } else if (song.source_url) {
      // URL-sourced clip lives on the server — stream it via /audio/:id
      audio.src = `/audio/${song.id}`;
    } else {
      audio.src = '';
      $('np-meta').textContent = '⚠ File not loaded — click Add Files to reload your folder';
    }
  } else {
    audio.src = `/audio/${song.id}`;
  }
  audio.load();
  progressBar.value   = 0;
  tCurrent.textContent = '0:00';
  tTotal.textContent   = fmt(song.duration_sec);
  playBtn.textContent  = '▶';

  playerPanel.classList.remove('hidden');
  emptyState.classList.add('hidden');

  const [noteRes, tsRes] = await Promise.all([
    fetch(`/api/songs/${song.id}/notes`),
    fetch(`/api/songs/${song.id}/timestamps`),
  ]);
  const noteData = await noteRes.json();
  const tsData   = await tsRes.json();

  noteInput.value       = noteData.note_text || '';
  noteStatus.textContent = '';
  state.timestamps      = tsData;
  renderTimestamps();
}

// ── PLAYBACK ───────────────────────────────────────────────

playBtn.addEventListener('click', () => audio.paused ? audio.play() : audio.pause());

audio.addEventListener('play',  () => { playBtn.textContent = '⏸'; });
audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
audio.addEventListener('ended', () => { playBtn.textContent = '▶'; });

audio.addEventListener('timeupdate', () => {
  if (audio.duration) {
    progressBar.value    = (audio.currentTime / audio.duration) * 1000;
    tCurrent.textContent = fmt(audio.currentTime);
  }
});

audio.addEventListener('loadedmetadata', () => {
  tTotal.textContent = fmt(audio.duration);
});

progressBar.addEventListener('input', () => {
  if (audio.duration) audio.currentTime = (progressBar.value / 1000) * audio.duration;
});

volumeBar.addEventListener('input', () => {
  audio.volume = volumeBar.value / 100;
});

// ── RENAME ────────────────────────────────────────────────

renameBtn.addEventListener('click', () => {
  if (!state.currentSong) return;
  if (WEB_MODE) return;
  const titleEl  = $('np-title');
  const current  = state.currentSong.title;
  const input    = document.createElement('input');
  input.type      = 'text';
  input.value     = current;
  input.className = 'rename-input';
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    const restore = (text) => {
      const div = document.createElement('div');
      div.id = 'np-title';
      div.textContent = text;
      input.replaceWith(div);
    };
    if (!newName || newName === current) { restore(current); return; }
    const res  = await fetch(`/api/songs/${state.currentSong.id}/rename`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName }),
    });
    const data = await res.json();
    if (res.ok) {
      state.currentSong.title = data.title;
      state.currentSong.filepath = data.filepath;
      const entry = state.songs.find(s => s.id === state.currentSong.id);
      if (entry) { entry.title = data.title; entry.filepath = data.filepath; }
      restore(data.title);
      applyFilters();
    } else {
      restore(current);
      alert(data.error || 'Rename failed');
    }
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { done = true; const d = document.createElement('div'); d.id='np-title'; d.textContent=current; input.replaceWith(d); }
  });
  input.addEventListener('blur', commit);
});

// ── DELETE (SOFT) ─────────────────────────────────────────

deleteBtn.addEventListener('click', async () => {
  if (!state.currentSong) return;
  const msg = WEB_MODE
    ? `Remove "${state.currentSong.title}" from this session?\n\nNotes and timestamps are saved and will return next time you load this folder.`
    : `Remove "${state.currentSong.title}" from your library?\n\nThe file stays on disk. Notes and timestamps are preserved in the database.`;
  if (!confirm(msg)) return;
  await fetch(`/api/songs/${state.currentSong.id}`, { method: 'DELETE' });
  state.songs = state.songs.filter(s => s.id !== state.currentSong.id);
  state.currentSong = null;
  $('player-panel').classList.add('hidden');
  $('empty-state').classList.remove('hidden');
  applyFilters();
});

// ── MARK TIMESTAMP ────────────────────────────────────────

let _labelSaveTimer = null;

markBtn.addEventListener('click', async () => {
  if (!state.currentSong) return;

  // Cancel any pending debounced save and flush immediately
  clearTimeout(_labelSaveTimer);
  const activeLabel = tsList.querySelector('.ts-label:focus');
  if (activeLabel) {
    const _flushId  = parseInt(activeLabel.dataset.id);
    const _flushVal = activeLabel.value;
    const _flushTs  = state.timestamps.find(t => t.id === _flushId);
    if (_flushTs) _flushTs.label = _flushVal;
    if (_flushVal !== activeLabel.dataset.saved) {
      await fetch(`/api/timestamps/${_flushId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: _flushVal }),
      });
      activeLabel.dataset.saved = _flushVal;
    }
  }

  const res = await fetch(`/api/songs/${state.currentSong.id}/timestamps`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ time_seconds: audio.currentTime }),
  });
  const ts = await res.json();
  state.timestamps.push(ts);
  state.timestamps.sort((a, b) => a.time_seconds - b.time_seconds);
  renderTimestamps();

  // Auto-focus the label input for this new marker
  setTimeout(() => {
    const input = tsList.querySelector(`.ts-label[data-id="${ts.id}"]`);
    if (input) input.focus();
  }, 50);
});

// ── RENDER TIMESTAMPS ────────────────────────────────────

function renderTimestamps() {
  tsCount.textContent = state.timestamps.length || '';
  if (!state.timestamps.length) {
    tsList.innerHTML = '<li class="ts-empty muted">No markers yet — hit Mark This Moment while playing</li>';
    return;
  }
  tsList.innerHTML = '';
  for (const ts of state.timestamps) {
    const li = document.createElement('li');
    li.className = 'ts-item';
    li.innerHTML = `
      <span class="ts-time" data-time="${ts.time_seconds}">${fmt(ts.time_seconds)}</span>
      <input class="ts-label" type="text" data-id="${ts.id}" value="${esc(ts.label)}" placeholder="label this moment...">
      <button class="ts-del" data-id="${ts.id}" title="Delete">✕</button>
    `;

    li.querySelector('.ts-time').addEventListener('click', e => {
      audio.currentTime = parseFloat(e.target.dataset.time);
    });

    const labelInput = li.querySelector('.ts-label');
    labelInput.dataset.saved = ts.label;
    labelInput.addEventListener('input', e => {
      const _id  = parseInt(e.target.dataset.id);
      const _val = e.target.value;
      // Keep in-memory state in sync so re-renders preserve typed labels
      const _ts = state.timestamps.find(t => t.id === _id);
      if (_ts) _ts.label = _val;
      // Debounce the PATCH to avoid race conditions from rapid typing
      clearTimeout(_labelSaveTimer);
      _labelSaveTimer = setTimeout(async () => {
        await fetch(`/api/timestamps/${_id}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ label: _val }),
        });
        e.target.dataset.saved = _val;
      }, 350);
    });

    li.querySelector('.ts-del').addEventListener('click', async e => {
      const id = parseInt(e.target.dataset.id);
      await fetch(`/api/timestamps/${id}`, { method: 'DELETE' });
      state.timestamps = state.timestamps.filter(t => t.id !== id);
      renderTimestamps();
    });

    tsList.appendChild(li);
  }
}

// ── NOTES ────────────────────────────────────────────────

let noteSaveTimer;
noteInput.addEventListener('input', () => {
  noteStatus.textContent = 'saving...';
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(async () => {
    if (!state.currentSong) return;
    await fetch(`/api/songs/${state.currentSong.id}/notes`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ note_text: noteInput.value }),
    });
    noteStatus.textContent = '✓ saved';
    setTimeout(() => { noteStatus.textContent = ''; }, 2000);

    // Update sidebar flag live
    const hasNote = noteInput.value.trim().length > 0;
    const entry = state.songs.find(s => s.id === state.currentSong.id);
    if (entry) entry.has_note = hasNote ? 1 : 0;
    const li = songList.querySelector(`li[data-id="${state.currentSong.id}"]`);
    if (li) {
      const titleEl = li.querySelector('.song-item-title');
      const flag = titleEl.querySelector('.note-flag');
      if (hasNote && !flag) titleEl.insertAdjacentHTML('beforeend', '<span class="note-flag">📝</span>');
      else if (!hasNote && flag) flag.remove();
    }
  }, 800);
});

// ── SEARCH ───────────────────────────────────────────────

function applyFilters() {
  const q    = searchInput.value.toLowerCase();
  let result = visibleSongs();
  if (q) result = result.filter(s =>
    s.title.toLowerCase().includes(q) ||
    (s.artist && s.artist.toLowerCase().includes(q)) ||
    (s.album  && s.album.toLowerCase().includes(q))
  );
  renderSongList(result);
}

searchInput.addEventListener('input', applyFilters);

// ── NOTED FILTER ─────────────────────────────────────────

notedFilter.addEventListener('click', () => {
  state.notedOnly = !state.notedOnly;
  notedFilter.classList.toggle('active', state.notedOnly);
  notedFilter.textContent = state.notedOnly ? '📝 Showing noted' : '📝 Noted only';
  applyFilters();
});

// ── CSV IMPORT ────────────────────────────────────────────

const importBtn  = $('import-btn');
const importFile = $('import-file');

if (importBtn) {
  importBtn.addEventListener('click', () => importFile.click());

  importFile.addEventListener('change', async () => {
    const file = importFile.files[0];
    if (!file) return;
    importFile.value = '';

    importBtn.textContent = '⏳ Importing...';
    importBtn.disabled = true;

    try {
      const csv = await file.text();
      const res  = await fetch('/api/import/csv', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ csv }),
      });
      const data = await res.json();

      if (!res.ok) {
        showImportToast('error', data.error || 'Import failed');
        return;
      }

      const parts = [];
      if (data.songs_added)      parts.push(`${data.songs_added} added`);
      if (data.songs_updated)    parts.push(`${data.songs_updated} updated`);
      if (data.notes_set)        parts.push(`${data.notes_set} notes`);
      if (data.timestamps_added) parts.push(`${data.timestamps_added} markers`);
      const summary = parts.length ? parts.join(', ') : 'nothing new';
      showImportToast('ok', `Import complete — ${summary}`);

      // Reload songs if any were added/updated
      if (data.songs_added || data.songs_updated) {
        const songs = await (await fetch('/api/songs')).json();
        state.songs = songs;
        applyFilters();
      }
    } catch (e) {
      showImportToast('error', 'Import failed: ' + e.message);
    } finally {
      importBtn.textContent = '⬆ Import CSV';
      importBtn.disabled = false;
    }
  });
}

function showImportToast(type, msg) {
  const existing = document.querySelector('.import-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `import-toast import-toast-${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 300); }, 4000);
}

// ── RESCAN PANEL ─────────────────────────────────────────

async function openScanPanel() {
  scanPanel.classList.remove('hidden');
  rescanBtn.textContent = '↑ Close';
  await loadFolders();
  await loadDrives();
}

rescanBtn.addEventListener('click', async () => {
  if (WEB_MODE) { pickAndScanDirectory(); return; }
  const isOpen = !scanPanel.classList.contains('hidden');
  if (isOpen) {
    scanPanel.classList.add('hidden');
    rescanBtn.textContent = '↻ Scan Library';
  } else {
    await openScanPanel();
  }
});

async function loadDrives() {
  let drives = [];
  try { drives = await fetch('/api/drives').then(r => r.json()); } catch {}
  drivesList.innerHTML = '';
  if (!drives.length) {
    if (drivesHint) drivesHint.classList.add('hidden');
    return;
  }
  if (drivesHint) drivesHint.classList.remove('hidden');
  const scanDirs = await fetch('/api/scan-dirs').then(r => r.json()).catch(() => []);
  for (const drive of drives) {
    const normDrive = drive.replace(/\\/g, '/').toUpperCase().replace(/\/$/, '');
    const isTracked = scanDirs.some(d =>
      d.dirpath.replace(/\\/g, '/').toUpperCase().replace(/\/$/, '') === normDrive
    );
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'drive-chip' + (isTracked ? ' active' : '');
    chip.title = isTracked ? `${drive} — already in scan list` : `Click to use ${drive}`;
    chip.textContent = drive.replace(/\\$/, ''); // "X:" not "X:\"
    chip.addEventListener('click', () => {
      folderInput.value = drive;
      folderInput.focus();
      folderInput.setSelectionRange(folderInput.value.length, folderInput.value.length);
    });
    drivesList.appendChild(chip);
  }
}

scanNowBtn.addEventListener('click', async () => {
  // If no folders configured yet, try to auto-add whatever is in the input first
  const currentDirs = await fetch('/api/scan-dirs').then(r => r.json()).catch(() => []);
  if (!currentDirs.length) {
    const pending = folderInput.value.trim();
    if (!pending) {
      folderError.textContent = 'Add a music folder path first, then click Scan Now';
      folderInput.focus();
      return;
    }
    const addRes = await fetch('/api/scan-dirs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirpath: pending }),
    });
    if (!addRes.ok) {
      const d = await addRes.json();
      folderError.textContent = d.error || 'Could not add folder';
      return;
    }
    folderInput.value = '';
    folderError.textContent = '';
    await loadFolders();
    await loadDrives();
  }

  scanNowBtn.textContent = '↻ Scanning...';
  scanNowBtn.disabled = true;
  try {
    const res  = await fetch('/api/rescan', { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.songs = data.songs;
    applyFilters();
    scanNowBtn.textContent = `✓ ${data.added} added, ${data.removed} removed`;
    // Auto-close the scan panel if we found songs
    if (data.total > 0) {
      setTimeout(() => {
        scanPanel.classList.add('hidden');
        rescanBtn.textContent = '↻ Scan Library';
        scanNowBtn.textContent = '↻ Scan Now';
        scanNowBtn.disabled = false;
      }, 1800);
      return;
    }
  } catch (err) {
    scanNowBtn.textContent = '↻ Scan failed';
    alert('Scan failed: ' + (err.message || 'unknown error'));
  }
  setTimeout(() => {
    scanNowBtn.textContent = '↻ Scan Now';
    scanNowBtn.disabled = false;
  }, 2500);
});

// ── KEYBOARD ─────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'KeyM' && state.currentSong) {
    e.preventDefault();
    markBtn.click();
  }
});

// ── SCAN FOLDERS ─────────────────────────────────────────

async function loadFolders() {
  const dirs = await fetch('/api/scan-dirs').then(r => r.json()).catch(() => []);
  foldersList.innerHTML = '';
  if (foldersSection) foldersSection.style.display = dirs.length ? '' : 'none';
  for (const d of dirs) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="folder-path" title="${esc(d.dirpath)}">${esc(d.dirpath)}</span><button class="folder-del" data-id="${d.id}" title="Remove">✕</button>`;
    li.querySelector('.folder-del').addEventListener('click', async e => {
      await fetch(`/api/scan-dirs/${e.target.dataset.id}`, { method: 'DELETE' });
      loadFolders();
      loadDrives();
    });
    foldersList.appendChild(li);
  }
}

async function addFolder() {
  const dirpath = folderInput.value.trim();
  if (!dirpath) return;
  folderError.textContent = '';
  const res = await fetch('/api/scan-dirs', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ dirpath }),
  });
  if (res.ok) {
    folderInput.value = '';
    loadFolders();
    loadDrives();
  } else {
    const data = await res.json();
    folderError.textContent = data.error || 'Failed to add folder';
  }
}

folderAddBtn.addEventListener('click', addFolder);
folderInput.addEventListener('keydown', e => { if (e.key === 'Enter') addFolder(); });

// ── WEB MODE: FILE PICKER ─────────────────────────────────

function pickAndScanDirectory() {
  const input = document.createElement('input');
  input.type     = 'file';
  input.accept   = '.mp3,.m4a,.aac,.wav,.flac,.ogg';
  input.multiple = true;

  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;

    rescanBtn.textContent = '↻ Loading...';
    rescanBtn.disabled = true;

    const pending = [];
    for (const file of files) {
      const duration = await getDuration(file);
      pending.push({ filepath: `web:${file.name}`, title: file.name.replace(/\.[^.]+$/, ''), artist: '', album: '', duration_sec: duration, _file: file });
    }

    const res = await fetch('/api/songs/web-upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pending.map(({ _file, ...s }) => s)),
    });
    const serverSongs = await res.json();

    for (const ss of serverSongs) {
      const p = pending.find(s => s.filepath === ss.filepath);
      if (p) fileHandles.set(ss.id, p._file);
    }

    // Merge new files into existing list (don't wipe — allow adding more)
    const existingIds = new Set(state.songs.map(s => s.id));
    for (const s of serverSongs) {
      if (!existingIds.has(s.id)) state.songs.push(s);
      else { const i = state.songs.findIndex(x => x.id === s.id); if (i >= 0) state.songs[i] = s; }
    }
    state.songs.sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || a.title.localeCompare(b.title));
    applyFilters();

    rescanBtn.textContent = `✓ ${files.length} added`;
    setTimeout(() => { rescanBtn.textContent = '🎵 Add Files'; rescanBtn.disabled = false; }, 2000);
  });

  input.click();
}

function getDuration(file) {
  return new Promise(resolve => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    a.addEventListener('loadedmetadata', () => { URL.revokeObjectURL(url); resolve(a.duration || 0); });
    a.addEventListener('error', () => { URL.revokeObjectURL(url); resolve(0); });
    a.src = url;
  });
}

// ── PLAY A FILE (local mode) ──────────────────────────────

if (openFileBtn && openFileInput) {
  openFileBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openFileInput.click();
  });
}

if (openFileInput) {
  openFileInput.addEventListener('change', async () => {
    const files = Array.from(openFileInput.files || []);
    if (!files.length) return;
    openFileInput.value = '';

    for (const file of files) {
      const duration = await getDuration(file);
      const title    = file.name.replace(/\.[^.]+$/, '');

      if (audio.src && audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
      const blobUrl = URL.createObjectURL(file);

      // Synthetic entry — not saved to catalog; use negative IDs to avoid collision
      const song = {
        id: -(Date.now()),
        filepath: `local:${file.name}`,
        title,
        artist: '',
        album:  '',
        duration_sec: duration,
        has_note: 0,
      };

      // Play the first file; subsequent files could be queued in a future feature
      state.currentSong = song;
      $('np-title').textContent = title;
      $('np-meta').textContent  = 'Local file — not in library';

      audio.src = blobUrl;
      audio.load();
      audio.play().catch(() => {});

      playerPanel.classList.remove('hidden');
      emptyState.classList.add('hidden');

      tsList.innerHTML = '<li class="ts-empty muted">Add file to library to save markers</li>';
      tsCount.textContent = '';
      noteInput.value = '';
      noteStatus.textContent = '';
      break; // play the first selected file
    }
  });
}

// ── ADD FROM URL ─────────────────────────────────────────
const SAMPLE_URL = 'https://www.youtube.com/watch?v=N98wn41rsdw';
const addUrlBtn = $('add-url-btn');
const urlPanel  = $('url-panel');
const urlInput  = $('url-input');
const urlGoBtn  = $('url-go-btn');
const urlStatus = $('url-status');

function setUrlStatus(msg, cls) {
  if (!urlStatus) return;
  urlStatus.textContent = msg || '';
  urlStatus.className = 'url-status' + (cls ? ' ' + cls : '');
}

async function addFromUrl() {
  const url = (urlInput.value || '').trim();
  if (!/^https?:\/\/\S+/i.test(url)) { setUrlStatus('Enter a valid http(s) URL', 'err'); return; }
  urlGoBtn.disabled = true;
  urlInput.disabled = true;
  setUrlStatus('⏳ Fetching audio… this can take a moment', 'working');
  try {
    const res = await fetch('/api/songs/from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    // Parse defensively — a proxy timeout or error page can return HTML, not JSON.
    const raw = await res.text();
    let song;
    try { song = JSON.parse(raw); } catch {
      throw new Error(res.status >= 500
        ? 'The server hit an error fetching that link — try a direct audio link (.mp3/.m4a).'
        : 'Unexpected response from the server. Please try again.');
    }
    if (song && song.error) throw new Error(song.error);
    if (!res.ok || !song || !song.id) throw new Error('Could not add that URL.');

    // Merge into the library (same pattern as Add Files)
    const i = state.songs.findIndex(s => s.id === song.id);
    if (i >= 0) state.songs[i] = song; else state.songs.push(song);
    state.songs.sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || a.title.localeCompare(b.title));
    applyFilters();

    setUrlStatus(song.reused ? '✓ Already in your library — opening' : `✓ Added: ${song.title}`, 'ok');
    urlInput.value = '';
    selectSong(song);
    setTimeout(() => setUrlStatus('', ''), 4000);
  } catch (e) {
    setUrlStatus('✕ ' + e.message, 'err');
  } finally {
    urlGoBtn.disabled = false;
    urlInput.disabled = false;
  }
}

if (addUrlBtn) {
  addUrlBtn.addEventListener('click', () => {
    const nowHidden = urlPanel.classList.toggle('hidden');
    if (!nowHidden) urlInput.focus();
  });
}
if (urlGoBtn) urlGoBtn.addEventListener('click', addFromUrl);
if (urlInput) urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') addFromUrl(); });

// Homepage "Try a sample clip" — prefill and fetch the sample URL
const trySampleLink = $('try-sample-link');
if (trySampleLink) {
  trySampleLink.addEventListener('click', e => {
    e.preventDefault();
    if (urlPanel) urlPanel.classList.remove('hidden');
    urlInput.value = SAMPLE_URL;
    addFromUrl();
  });
}

// ── INIT ─────────────────────────────────────────────────

if (WEB_MODE) {
  rescanBtn.textContent = '🎵 Add Files';
  if (openFileBtn) openFileBtn.style.display = 'none';
  scanPanel.classList.add('hidden');
  renameBtn.classList.add('hidden');
  const homeAddBtn = $('home-add-btn');
  if (homeAddBtn) homeAddBtn.addEventListener('click', pickAndScanDirectory);
} else {
  rescanBtn.textContent = '↻ Scan Library';
  const homeAddBtn = $('home-add-btn');
  if (homeAddBtn) homeAddBtn.style.display = 'none';
  const homeNote = document.querySelector('.home-browser-note');
  if (homeNote) homeNote.textContent = 'Add your music folder below, then click ↻ Scan Now';
  // Load songs; auto-open the scan panel when the library is empty
  loadSongs().then(() => {
    if (!state.songs.length) openScanPanel();
  });
}

window.AUDIONOTE_LOADED = true;
