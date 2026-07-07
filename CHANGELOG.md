# Changelog

All notable changes to AudioNote are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.3.3] — 2026-07-05

### Changed
- **Add from URL no longer blocks on long tracks.** Extraction now runs in the
  background and the client polls for completion, so a lengthy download (e.g. a
  1-hour video, especially through a proxy) never holds the request open past a
  reverse-proxy timeout and leaves the UI spinning. The job cap is 15 minutes.

## [1.3.2] — 2026-07-05

### Changed
- **Add from URL is resilient to a down proxy.** When `YTDLP_PROXY` is set,
  extraction now tries a direct connection first and only falls back to the
  proxy if that fails — so direct-audio links and non-blocked sites keep working
  even if the proxy is unavailable, and the proxy is reserved for sites that
  actually need it (e.g. YouTube on a datacenter IP).

## [1.3.1] — 2026-07-05

### Fixed
- **Add from URL now fails gracefully.** Extraction failures (a blocked site, an
  unsupported link, no audio) return a short human-readable message as an HTTP
  200 JSON envelope instead of a 5xx — so a reverse proxy that swaps error
  responses for an HTML page can no longer break the client with a JSON parse
  error (`Unexpected token '<'`). The client also parses defensively and shows a
  clear message for any non-JSON response.

## [1.3.0] — 2026-07-04

### Added
- **Add from a URL.** Paste a YouTube, SoundCloud, Bandcamp, or direct audio
  link and AudioNote extracts the audio server-side (via `yt-dlp`, transcoded to
  mp3 with `ffmpeg`) and catalogs it as a normal track — ready to timestamp and
  note like any file. New `POST /api/songs/from-url` route, a "🔗 Add from URL"
  control in the sidebar, and a one-click "Try a sample clip" on the home page.
- `source_url` and `thumbnail_url` columns on `songs` (auto-migrated on existing
  databases) record a URL track's provenance and poster image. Re-adding the
  same URL de-dupes to the existing track instead of downloading again.
- `YTDLP_PROXY` environment variable routes extraction through a proxy
  (e.g. `socks5://host:port`) for sites that rate-limit a server's IP.

### Requirements
- The URL feature needs [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and
  [`ffmpeg`](https://ffmpeg.org) on the server's `PATH`. Everything else works
  without them; only "Add from URL" is affected if they're missing.

## [1.2.0] — 2026-06-16

### Changed
- **Full visual redesign — "After Hours."** A studio-console identity: a deep
  blue-black surface, a single amber signal accent, monospace timecodes as the
  through-line, and timeline-ruler tick dividers. Self-hosted display type
  (Bricolage Grotesque) — no external font CDN, fully offline. The footer now
  shows the live app version from `/api/version` instead of a hardcoded string.
- **Cleaner repository layout.** Brand art moved to `assets/`, the Windows
  launcher to `scripts/`, so the project root is just the code and docs.

### Added
- `GET /api/version` — single source of truth for the version shown in the UI.
- Brand logo (note whose stem becomes a pencil) recolored to the new palette and
  used as the app icon, hero mark, and favicon; an "AudioNote · LibcSys" lockup
  and an explicit "Open Source on GitHub" badge in the header.

## [1.1.0] — 2026-06-16

### Fixed
- **Fresh-install crash.** Database migrations ran *before* the tables were
  created, so on a new `audionote.db` the `deleted_at` column was never added
  and every endpoint returned `500: no such column: deleted_at`. The column is
  now part of the `CREATE TABLE songs` definition and migrations run after all
  tables exist. Fully backward compatible — existing databases are untouched.

### Added
- **Multi-format support in local/server mode.** The scanner now catalogs
  `.mp3 .m4a .mp4 .aac .wav .flac .ogg .oga .opus .webm .wma .aif .aiff`
  (previously MP3-only), titles are derived from the real extension, and
  `/audio/:id` streams each file with the correct `Content-Type` instead of
  always `audio/mpeg`. This matches the formats the UI already advertised and
  completes the open roadmap item.
- **MIT LICENSE file** and a `license` field in `package.json` (the project was
  already declared MIT but shipped without the license text).
- npm metadata: `engines`, `repository`, `homepage`, `bugs`, `keywords`.

## [1.0.0] — 2026

- Open-source release: MIT, web demo, CSV import/export, analytics, timestamp
  markers, song notes, soft delete, rename-on-disk, Ask AudioNote.
