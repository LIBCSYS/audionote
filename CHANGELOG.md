# Changelog

All notable changes to AudioNote are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
