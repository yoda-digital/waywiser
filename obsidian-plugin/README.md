# Waywiser Brain — Obsidian Plugin

An Obsidian companion plugin for [Waywiser Brain](https://github.com/yoda-digital), the
self-learning memory system used by the Pi coding agent
(`@yoda-digital/waywiser-brain`). It reads Waywiser Brain's SQLite database
(`brain.db` / `waywiser.db`) directly and surfaces its memories, procedures,
skills, and evolution history inside your vault.

## Status

This is the initial scaffold (plugin id `waywiser-brain`): plugin lifecycle,
settings tab, a read-only SQLite reader, and a file watcher for live refresh.
Dashboard views, commands, and graph-view integration land in follow-up tasks.

## Features (current)

- **Settings tab** — configure the database path, auto-refresh behavior,
  refresh interval, status bar visibility, and graph coloring.
- **DB reader** (`src/db-reader.ts`) — opens `brain.db` with `sql.js` (a
  WebAssembly SQLite build) and exposes read helpers for memories,
  procedures, skill versions, evolution runs, and the brain log.
- **File watcher** (`src/watcher.ts`) — polls `brain.db`'s mtime/size on an
  interval and reloads the in-memory database when it changes, so the
  plugin reflects new memories/procedures without restarting Obsidian.
- **Status bar** — shows a compact summary, e.g. `🧠 42m 7p 3s` (active
  memories, mature procedures, active skills).

## Database location

By default the plugin auto-detects the database in this order:

1. `<vault>/.brain.db`
2. `~/.waywiser/waywiser.db`
3. `~/.waywiser/brain.db`

You can override this by setting an explicit **Database path** in the plugin
settings.

## Development

```bash
npm install
npm run dev      # esbuild watch/dev build -> main.js (with inline sourcemaps)
npm run build    # production build -> main.js
```

The build is bundled with `esbuild` (see `esbuild.config.mjs`) targeting
`es2022`/CommonJS, with `obsidian`, `electron`, and the CodeMirror packages
marked external (provided by the Obsidian runtime).

### Installing into a vault for manual testing

Copy (or symlink) `manifest.json`, `main.js`, `styles.css`, and
`sql-wasm.wasm` (produced by the build, alongside `main.js`) into
`<vault>/.obsidian/plugins/waywiser-brain/`, then enable the plugin from
Obsidian's Community Plugins settings.

## Why sql.js instead of better-sqlite3

Obsidian ships its own bundled Node/Electron runtime, and native addons like
`better-sqlite3` must be rebuilt against Obsidian's exact Electron ABI to
load. `sql.js` is a pure WebAssembly SQLite build with no native bindings, so
it loads reliably across Obsidian's supported platforms without a rebuild
step. Since the plugin only needs read access to `brain.db`, sql.js's
in-memory query model (load the file into a buffer, query it, reload on
change) is a good fit.

## License

Part of the Waywiser project.
