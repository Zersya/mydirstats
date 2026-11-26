# Design

Seeded before implementation. Re-run `impeccable document` once real code exists to capture actual tokens.

## Visual Theme

Dark-first, instrument-quiet utility. The chrome is a neutral dark stage; the only saturated colors in the entire interface are the categorical file-type colors inside the treemap, which are data, not decoration. Density is moderate-high: this is a triage tool, information per pixel matters, but nothing is cramped. No cards-in-cards, no hero metrics, no decorative blur. Depth is communicated with 1px borders and luminance steps, not shadows.

Physical scene: evening, "Your disk is almost full" notification just appeared, focused 15-minute cleanup session. Dark theme is load-bearing, not aesthetic default.

## Color Palette

All colors OKLCH. Neutrals tinted very slightly cool (hue ~250, chroma 0.005–0.01) to avoid dead gray.

### Chrome (restrained)

| Role | Value | Usage |
|---|---|---|
| `--surface-base` | oklch(0.17 0.008 250) | Window background |
| `--surface-raised` | oklch(0.21 0.009 250) | Panels, tree pane, inspector |
| `--surface-overlay` | oklch(0.25 0.010 250) | Hover states, popovers |
| `--border-subtle` | oklch(1 0 0 / 8%) | All 1px separators |
| `--text-primary` | oklch(0.93 0.005 250) | Primary content |
| `--text-secondary` | oklch(0.65 0.008 250) | Metadata, sizes in tree |
| `--text-tertiary` | oklch(0.45 0.008 250) | Hints, disabled |
| `--accent` | oklch(0.70 0.14 250) | Selection, focus rings, interactive elements — a calm blue-violet |
| `--danger` | oklch(0.65 0.19 25) | Trash/destructive actions only |

### Treemap categorical palette (data)

Chosen for deuteranopia survival: categories separated in luminance as well as hue. Implemented values (treemap.ts): image oklch(0.78 0.12 90) amber lightest / video oklch(0.66 0.15 300) violet-blue / document oklch(0.64 0.14 30) red-orange / code oklch(0.62 0.09 215) cyan-blue / audio oklch(0.55 0.10 165) teal / other oklch(0.50 0.03 240) muted slate / app oklch(0.48 0.14 340) magenta / archive oklch(0.44 0.05 70) brown-olive. **Categorical color applies to files/leaves only.** Directories render as quiet depth structure: luminance steps anchored at 0.205/0.187/0.169, tinted very slightly toward their dominant category hue (chroma × 0.15) so pruned nesting zones whisper their content type without noise. `other` must stay visible, never near-black: real disks are dominated by uncategorized binaries and near-black reads as holes. Aggregate pseudo-nodes ("n small files") use their bucket's dominant hue dimmed (luminance × 0.72, chroma × 0.55).

### Rules

- Never `#000` or `#fff`. Shadows basically absent; separation via border + luminance.
- Accent appears only on interactive/selected elements. If accent covers more than ~5% of a screen, something is wrong.
- Treemap rectangles: flat fills, 1px gap or dark border between nodes. No cushions, no gradients, no 3D bevels.

## Typography

- UI font: system San Francisco (`-apple-system` / `system-ui`). Native weight and metrics in WKWebView.
- Data font: SF Mono (`ui-monospace`) for all sizes, paths, and counts — numerals must be tabular for scanning columns.
- Scale: 11px fine print / 12px tree rows / 13px body default / 15px section heads / 20px+ rare (empty states only). Hierarchy through weight and size contrast, never color alone.
- Line length cap irrelevant in most panes, but inspector detail text wraps at 65ch.

## Layout

Single window, three-pane composition:

```
┌──────────────────────────────────────────────┐
│ toolbar: scan target, progress, actions      │
├──────────────┬───────────────────────────────┤
│ directory    │                               │
│ tree         │         treemap               │
│ (resizable,  │      (hero, flat,             │
│  ~260–340px) │       live during scan)       │
│              │                               │
├──────────────┴───────────────────────────────┤
│ type breakdown strip (collapsed by default,  │
│ expandable) + status bar: scan state, gaps   │
└──────────────────────────────────────────────┘
```

- Treemap gets majority of area; tree is the navigational index, not the hero.
- Pane dividers draggable, keyboard-adjustable.
- Selection syncs across all panes instantly: hover or select in one, highlight in all.

## Components

- **Tree rows**: 24px, mono size right-aligned, disclosure triangles, type-colored file dots only where helpful.
- **Treemap**: squarified layout algorithm, rectangles sized by bytes, colored by category, subtle luminance step per depth level (max 2 steps) to hint hierarchy without cushions.
- **Toolbar**: native-feeling, minimal; scan target picker, live scan state, rescan, trash action.
- **Inspector** (selection detail): inline bottom-right overlay in treemap pane or right-edge panel — path, exact bytes, file count, type, actions. Never a modal.
- **Empty states**: first-run (no scan yet), scanning-in-progress (progressive treemap + current path + cancel), permission-gaps notice (quantified, with FDA deep-link).

## Motion

- Ease-out exponential curves only (ease-out-quart minimum). Durations 120–250ms.
- Treemap rectangles animate size changes on live updates; deletions shrink-and-fade. No bounce, no elastic, no layout thrash.
- Scan fill-in is the one place motion is expressive: rectangles appear where the walker is working.
- Honors Reduce Motion: all animation collapses to instant state changes.

## Interaction

- Core loop keyboard-completable: arrows navigate tree and treemap, space = Quick Look, ⌘⌫ = move to Trash (with inline undo toast, no confirmation modal for Trash since it is recoverable), ⌘R = rescan, ⌘O = choose scan target.
- Right-click context menus mirror keyboard actions plus "Reveal in Finder" / "Copy path".
- Hovering treemap rectangle highlights the corresponding tree row (and vice versa) with accent outline.
