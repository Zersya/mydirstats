# mydirstats

A disk usage analyzer for macOS in the WinDirStat tradition: directory tree, squarified treemap, and extension breakdown in three synced panes. Built to answer one question fast - what is eating my disk, and what can I safely delete?

Built with Tauri v2: a Rust parallel scan engine behind a canvas-rendered webview UI. The app itself is 4.3MB, because a tool that diagnoses bloat should not be bloat.

## Why not the existing tools

- **WinDirStat** is Windows-only and its scan is a frozen snapshot.
- **DaisyDisk** is beautiful but closed, paid, and its radial layout is weak for deep hierarchies.
- **GrandPerspective / Disk Inventory X** are free but dated in interaction and rendering.

mydirstats keeps the proven tri-pane layout, adds progressive live scanning (watch the treemap fill in), and keeps the picture true after the scan via FSEvents-driven incremental rescans.

## Features

- **Progressive two-phase scan** - quiet parallel walk with live counters, then the treemap blooms top-down with final sizes
- **Scale architecture** - subtree-significance emission and small-file bucketing keep the UI responsive at millions of files; aggregate pseudo-nodes expand on demand
- **Three synced panes** - directory tree, treemap, type breakdown; selection and hover sync everywhere
- **Safe cleanup loop** - move to Trash (recoverable, never hard delete), inline undo toast, reveal in Finder, copy path, Quick Look
- **Live watching** - FSEvents rescans changed subtrees in the background; the treemap never goes stale
- **macOS semantics** - app bundles and packages are atomic objects by default (matching how you think about them), expandable on demand; bundle contents drillable when you need them
- **Honest scanning** - unreadable directories are quantified and surfaced, never silently skipped; optional Full Disk Access for complete coverage
- **Keyboard-first** - full navigation without the mouse; ⌫ trashes, space Quick-Looks, arrows navigate
- **Deuteranopia-surviving palette** - categorical colors separated in luminance as well as hue; selection is never color-only

## Install

Grab the app from Releases, or build from source:

```sh
npm install
npx tauri build
# bundle lands in src-tauri/target/release/bundle/macos/mydirstats.app
```

Requirements: Rust stable, Node 20+, macOS 12+.

For complete scans including protected locations (Mail, Messages, other apps' containers), grant Full Disk Access when prompted - the app works fine without it, and tells you exactly what it couldn't read.

## Development

```sh
npm run dev        # vite dev server, frontend mocks a synthetic scan in the browser
cargo tauri dev    # full app with hot reload
```

Verification harness:

```sh
cd src-tauri && cargo run --release --example scan_smoke -- /path/to/dir
```

The IPC contract between frontend and backend lives in `CONTRACT.md`. Design decisions live in `DESIGN.md`, product context in `PRODUCT.md`.

## Known limitations

- Scan speed is I/O-bound. On a warm disk the walker sustains ~40K files/sec; on a cold, nearly-full disk expect far less. A 700K-file tree scans in ~20s warm.
- Memory peaks transiently during the walk phase (hundreds of MB for multi-million-file scans) before aggregation collapses it. Bounded, but real.
- Logical sizes match Finder, not `du` - symlinks are never followed, bundle sizes include their contents.

## License

MIT - see [LICENSE](LICENSE).
