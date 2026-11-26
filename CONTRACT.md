# IPC Contract — mydirstats (v2, scale rework)

Binding contract between Rust backend (`src-tauri/`) and TypeScript frontend (`src/`). Tauri v2. All events via `app.emit` / `listen`. JSON keys camelCase.

## Design invariants (why v2)

- Frontend memory must be bounded by visible detail, not filesystem size. A 7M-file scan must cost the same UI memory as a small one.
- Every number shown is honest: totals are always exact. Small-file aggregation is surfaced as explicit pseudo-nodes, never silently dropped.
- Treemap nodes paint with final sizes only. Sizes never change retroactively during streaming.

## Data types

```typescript
type NodeId = number;

type Category =
  | "video" | "image" | "audio" | "document"
  | "code"  | "app"   | "archive" | "other";

interface Node {
  id: NodeId;
  parentId: NodeId | null;
  name: string;             // file name only; pseudo-nodes: synthetic label e.g. "312 small files"
  isDir: boolean;
  isBundle: boolean;
  isSymlink: boolean;
  isAggregate: boolean;     // true for bucketing pseudo-nodes; not a real filesystem object
  size: number;             // bytes; for dirs = exact sum of descendants (aggregate-inclusive)
  fileCount: number;        // real descendant file count inclusive
  category: Category;       // dominant-by-bytes for dirs; own for leaves; dominant-of-bucket for aggregates
  inaccessible: boolean;
  children: NodeId[] | null;
  mtime: number;            // unix seconds; 0 for aggregates
  hasHiddenChildren: boolean; // true for dirs whose small files were aggregated away — frontend may offer expand_dir
}
```

**No `path` field.** Paths are reconstructed frontend-side by walking up the parent chain from the scan root, whose path the frontend already knows (it chose the scan target). Backend never sends paths inside node payloads.

```typescript
interface ScanStats {
  totalBytes: number;
  totalFiles: number;       // real total file count, regardless of aggregation
  totalDirs: number;
  inaccessibleUnknownCount: number;
  durationMs: number;
}
```

## Commands (frontend → backend, `invoke`)

| Command | Args | Returns | Notes |
|---|---|---|---|
| `start_scan` | `{ path: string }` | `{ scanId: number }` | Cancels any running scan. Validates path exists and is a directory. |
| `cancel_scan` | `{}` | `void` | |
| `expand_dir` | `{ id: number }` | `void` | Re-emit one directory's children with full detail (see below). |
| `trash_items` | `{ paths: string[] }` | `{ trashed: string[], failed: { path: string, error: string }[] }` | macOS Trash only. |
| `reveal_in_finder` | `{ path: string }` | `void` | |
| `copy_path` | `{ path: string }` | `void` | |
| `quick_look` | `{ path: string }` | `void` | |
| `open_full_disk_access_settings` | `{}` | `void` | |
| `expand_bundle` | `{ id: number }` | `void` | Re-scan the bundle at this node id as a normal directory; emits `tree-update`. |
| `default_scan_path` | `{}` | `{ path: string }` | |

## Events (backend → frontend)

### `scan-progress` (walk phase — counters only)
```typescript
{ scanId: number; phase: "walking"; currentPath: string; scannedFiles: number; scannedBytes: number }
```
Emitted at most every 100ms. No node payloads.

### `scan-nodes` (emit phase — the tree, top-down)
```typescript
{
  scanId: number;
  nodes: Node[];   // sorted so parents always precede their children
  final: boolean;  // true on the last emit batch
}
```
Nodes are emitted in depth-first or breadth-first order, parents before children, with final sizes. Batches of ≤4000 nodes, throttled ≤20/sec. Aggregation rules:

- A directory's leaf children smaller than the bucket threshold (backend-chosen, typically ~0.1–1 MB adaptive) are aggregated into ONE pseudo-node per directory: `isAggregate: true`, `name: "<n> small files"`, `size` = sum, `fileCount` = n, `category` = dominant category of the bucket. The directory gets `hasHiddenChildren: true`.
- Directories are always emitted fully (never aggregated), regardless of size.
- Files above the threshold are emitted individually.
- Emit phase should be fast (tree is already in memory backend-side) and typically completes in 1-3s for very large trees.

### `scan-complete`
```typescript
{ scanId: number; rootId: NodeId; rootName: string; stats: ScanStats }
```

### `scan-cancelled` / `scan-error`
```typescript
{ scanId: number }
{ scanId: number; message: string }
```

### `dir-detail` (response to expand_dir)
```typescript
{
  parentId: NodeId;
  nodes: Node[];        // the directory's individual small files, replacing its aggregate pseudo-node
  removedIds: NodeId[]; // ids of pseudo-nodes replaced
}
```
Re-expansion is shallow: grandchildren directories keep their own aggregates until they too are expanded.

### `tree-update` (fs-event rescans and expand_bundle)
```typescript
{
  rootId: NodeId;      // id of the replaced subtree root (stable — the same node object updated)
  nodes: Node[];       // replacement subtree, parents first, aggregated per same rules
  removedIds: NodeId[];
  rootSizeDelta: number;
}
```

### `fs-events`
```typescript
{ affectedRoots: string[] }   // informational; tree-update follows
```

## Category rules (backend authoritative)

By extension, case-insensitive:

- video: mp4 mov mkv avi webm m4v mpg mpeg wmv flv
- image: jpg jpeg png gif heic heif webp tiff tif bmp raw cr2 cr3 nef arw dng svg ico photoslibrary
- audio: mp3 aac flac wav ogg m4a aiff opus wma
- document: pdf doc docx xls xlsx ppt pptx pages numbers key txt md rtf epub csv
- code: rs ts tsx js jsx py go swift c cpp h hpp java rb php html css json yaml yml toml xml sh zsh sql
- app: app
- archive: zip tar gz bz2 xz 7z rar dmg iso pkg
- other: everything else

Directory category = category owning most descendant bytes. Aggregate category = dominant category within the bucket.

## Bundle detection

Directory scanned atomically (leaf) if extension (case-insensitive) in: `app photoslibrary photolibrary bundle framework xcodeproj xcworkspace playground sparsebundle imovielibrary theater`. `.app` → category app, `.photoslibrary`/`.photolibrary` → image. Symlinks never followed, leaf nodes, category other.

## Scanner semantics

- Parallel walk (jwalk), logical file size (st_len), hidden files included.
- Permission-denied dirs: `inaccessible: true`, counted in `inaccessibleUnknownCount`.
- Scan ids monotonic; stale events ignorable by scanId.
- Backend memory: nodes must not retain full PathBufs beyond what the watcher needs; prefer name + parent linkage with on-demand path reconstruction backend-side too.

---

# v3 amendment — subtree significance (supersedes v2 aggregation rules)

The v2 file-only bucketing is insufficient: directory count alone (node_modules-scale trees) can exceed any budget. Aggregation now applies to whole subtrees.

## Emission rules v3

For each directory, decided top-down:
- If a directory's **total size is below the subtree threshold Ts**, it is emitted as a leaf-like node: `children: null` (or empty), `hasHiddenChildren: true`. Its descendants are NOT emitted. Treemap shows it as a single rectangle; sizes remain exact.
- If emitted expanded, its leaf children below the file threshold Tf bucket into one pseudo-node as in v2 (isAggregate).
- Dirs above Ts are always emitted expanded regardless of depth.

Backend chooses Ts and Tf adaptively post-walk: the smallest thresholds keeping total emitted nodes ≤ ~120K. Both reported nowhere — frontend doesn't need them.

## expand_dir (revised semantics)

`expand_dir { id }` re-emits the children of any hidden-detail directory (whether collapsed-as-leaf or bucketed): `dir-detail { parentId, nodes, removedIds }`. Children are emitted subject to the same significance rules — grandchild dirs below Ts arrive collapsed. For a collapsed dir, removedIds is empty (nothing was emitted below it). For a bucketed dir, removedIds contains the pseudo-node id. A dir can have BOTH conditions; handle both.

## Frontend requirements

- Treemap zoom into a collapsed dir: fire expand_dir, then render children as they arrive.
- Tree pane expand chevron on hasHiddenChildren dir: same.
- Collapsed dirs are real filesystem objects: inspector/actions normal (Trash/Reveal/QuickLook valid). Only isAggregate pseudo-nodes are non-objects.
