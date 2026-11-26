// DEV-ONLY mock backend. Used when window.__TAURI__ is absent (plain browser dev).
// Contract v2: walking counters → top-down final-sized scan-nodes with small-file
// bucketing. Simulates a BIG tree (~300K+ files) with realistic skew: most files
// tiny, most bytes in a few large ones. Memory stays small because individual
// small files never materialize until expand_dir regenerates them from a seed.

import type {
  Node,
  Category,
  TreeUpdateEvent,
} from "./types";
import type { Backend } from "./ipc";

type AnyHandler = (payload: never) => void;

const CAT_EXTS: [Category, string[]][] = [
  ["video", ["mp4", "mov", "mkv", "m4v"]],
  ["image", ["jpg", "png", "heic", "webp"]],
  ["audio", ["mp3", "flac", "m4a", "wav"]],
  ["document", ["pdf", "docx", "pages", "md", "txt"]],
  ["code", ["ts", "js", "rs", "py", "swift", "json"]],
  ["archive", ["zip", "dmg", "pkg", "tar.gz"]],
  ["other", ["dat", "bin", "cache", "tmp"]],
];

const DIR_NAMES = [
  "Documents", "Downloads", "Pictures", "Movies", "Music", "Projects", "Library",
  "Applications", "Desktop", "Code", "work", "personal", "archive", "backups",
  "node_modules", "src", "assets", "photos 2024", "videos", "raw footage",
  "dist", "build", ".cache", "vendor", "test-data", "logs",
];

const FILE_STEMS = [
  "IMG_4021", "report", "notes", "meeting", "clip_final", "backup", "index",
  "main", "app", "util", "render", "session", "export", "draft", "screenshot",
  "invoice", "contract", "mixtape", "episode", "dataset", "model", "chunk",
  "segment", "frame", "take", "master", "comp",
];

const BUCKET_THRESHOLD = 1_000_000; // 1 MB — files below are aggregated

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Dir archetypes give the tree realistic skew: media dirs are huge and file-poor,
// code/cache dirs are small-byte but file-rich (long tails of tiny files).
type Archetype = "media" | "code" | "docs" | "cache" | "mixed";

interface GenFile {
  name: string;
  size: number;
  category: Category;
}

interface DirMeta {
  id: number;
  seed: number;
  nFiles: number;
  archetype: Archetype;
}

export class MockBackend implements Backend {
  private handlers = new Map<string, Set<AnyHandler>>();
  private scanTimer: number | null = null;
  private dirMeta = new Map<number, DirMeta>();
  private currentNodes = new Map<number, Node>(); // full model tree (all nodes, emitted or not)
  private childDirIds = new Map<number, number[]>(); // skeleton: dir id -> child dir ids
  private aggIdOf = new Map<number, number>(); // dir id -> its small-file aggregate node id
  private visibleIds = new Set<number>(); // currently emitted/visible node ids
  private pollFiles = 0;
  private pollBytes = 0;
  private pollPath = "";

  private emit(event: string, payload: unknown) {
    const set = this.handlers.get(event);
    if (set) for (const h of set) (h as (p: unknown) => void)(payload);
  }

  listen(event: string, handler: AnyHandler): Promise<() => void> {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler);
    return Promise.resolve(() => set!.delete(handler));
  }

  invoke(cmd: string, args?: unknown): Promise<never> {
    const a = (args ?? {}) as { path?: string; paths?: string[]; id?: number };
    switch (cmd) {
      case "start_scan":
        return this.startScan(a.path ?? "/Users/dev") as Promise<never>;
      case "cancel_scan":
        if (this.scanTimer !== null) {
          clearTimeout(this.scanTimer);
          this.scanTimer = null;
        }
        this.emit("scan-cancelled", { scanId: this.scanIdCounter });
        return Promise.resolve(undefined as never);
      case "scan_progress_poll":
        return Promise.resolve({
          scanId: this.scanIdCounter,
          phase: 1,
          files: this.pollFiles,
          bytes: this.pollBytes,
          currentPath: this.pollPath,
        } as never);
      case "expand_dir":
        this.expandDir(a.id ?? 0);
        return Promise.resolve(undefined as never);
      case "trash_items":
        return this.trashItems(a.paths ?? []) as Promise<never>;
      case "expand_bundle":
      case "reveal_in_finder":
      case "quick_look":
      case "open_full_disk_access_settings":
        return Promise.resolve(undefined as never);
      case "copy_path":
        void navigator.clipboard?.writeText(a.path ?? "");
        return Promise.resolve(undefined as never);
      case "default_scan_path":
        return Promise.resolve({ path: "/Users/dev" } as never);
      default:
        return Promise.resolve(undefined as never);
    }
  }

  // ---- generative model -------------------------------------------------

  // Draw the file population of one directory. Deterministic per seed.
  // Returns nothing — calls back per file. Iterating 300K files is cheap;
  // retaining them is not, so callers keep only what they need.
  private eachFile(meta: DirMeta, cb: (f: GenFile, index: number) => void) {
    const rng = mulberry32(meta.seed);
    for (let i = 0; i < meta.nFiles; i++) {
      // size distribution: log-normal-ish with archetype mean; long tail
      const u1 = rng() || 1e-9;
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const meanLog = { media: 17.5, code: 9.5, docs: 12.5, cache: 8.5, mixed: 12.0 }[meta.archetype];
      const size = Math.max(64, Math.floor(Math.exp(meanLog + z * 1.6)));
      // category by archetype
      const rc = rng();
      let category: Category;
      if (meta.archetype === "media") category = rc < 0.5 ? "video" : rc < 0.85 ? "image" : "audio";
      else if (meta.archetype === "code") category = rc < 0.75 ? "code" : rc < 0.9 ? "document" : "other";
      else if (meta.archetype === "cache") category = rc < 0.7 ? "other" : "code";
      else if (meta.archetype === "docs") category = rc < 0.6 ? "document" : rc < 0.85 ? "image" : "archive";
      else {
        const cats: Category[] = ["video", "image", "audio", "document", "code", "archive", "other"];
        category = cats[Math.floor(rc * cats.length)];
      }
      const exts = CAT_EXTS.find(([c]) => c === category)![1];
      const ext = exts[Math.floor(rng() * exts.length)];
      const stem = FILE_STEMS[Math.floor(rng() * FILE_STEMS.length)];
      cb({ name: `${stem}_${Math.floor(rng() * 99999)}.${ext}`, size, category }, i);
    }
  }

  private scanIdCounter = 0;

  private startScan(path: string): Promise<{ scanId: number }> {
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    const scanId = ++this.scanIdCounter;
    this.dirMeta.clear();
    this.currentNodes.clear();
    this.childDirIds.clear();
    this.aggIdOf.clear();
    this.visibleIds.clear();

    // Phase 1: walking — counters climb for ~2.5s while we "walk" 300K files.
    // We generate the tree structure up front (dirs are few; files are statistics).
    const tree = this.generateTree();
    const totalFiles = tree.totalFiles;
    const totalBytes = tree.totalBytes;

    let walked = 0;
    let walkedBytes = 0;
    const walkStart = Date.now();
    const WALK_MS = 2400;

    const walkTick = () => {
      const elapsed = Date.now() - walkStart;
      const frac = Math.min(1, elapsed / WALK_MS);
      walked = Math.floor(totalFiles * frac);
      walkedBytes = Math.floor(totalBytes * frac);
      const dirName = DIR_NAMES[Math.floor((elapsed / 90) % DIR_NAMES.length)];
      this.pollFiles = walked;
      this.pollBytes = walkedBytes;
      this.pollPath = `${path}/${dirName}/${FILE_STEPS_NAMES[Math.floor((elapsed / 130) % FILE_STEPS_NAMES.length)]}`;
      if (frac < 1) {
        this.scanTimer = setTimeout(walkTick, 90);
      } else {
        this.emitPhase(scanId, tree);
      }
    };
    this.scanTimer = setTimeout(walkTick, 100);
    return Promise.resolve({ scanId });
  }

  // Build directory skeleton + file statistics. Files are iterated but only
  // big files (>= threshold) are retained; small files become bucket statistics.
  private generateTree(): {
    rootId: number;
    nodes: Node[];
    totalFiles: number;
    totalBytes: number;
  } {
    const rng = mulberry32(1337);
    let nextId = 1;
    const now = Math.floor(Date.now() / 1000);
    const nodes: Node[] = [];
    const emitted = this.currentNodes;

    let totalFiles = 0;
    let totalBytes = 0;

    const mkNode = (partial: Omit<Node, "id">): Node => {
      const n: Node = { ...partial, id: nextId++ };
      nodes.push(n);
      emitted.set(n.id, n);
      return n;
    };

    const root = mkNode({
      parentId: null, name: "dev", isDir: true, isBundle: false, isSymlink: false,
      isAggregate: false, size: 0, fileCount: 0, category: "other",
      inaccessible: false, children: [], mtime: now, hasHiddenChildren: false,
    });

    // Recursively build dirs. Aggregate statistics flow upward.
    const buildDir = (
      dirNode: Node,
      depth: number,
      archetype: Archetype,
      fileBudget: number,
    ): { bytes: number; files: number } => {
      const seed = (dirNode.id * 2654435761) >>> 0;
      // realistic skew: media dirs have few big files; code/cache dirs swarm
      // with tiny ones — this is what makes bucketing effective in real scans
      const archScale = { media: 0.12, docs: 0.5, mixed: 1.0, code: 2.2, cache: 3.5 }[archetype];
      const nFiles = Math.max(6, Math.floor(fileBudget * archScale * (0.5 + rng())));
      const meta: DirMeta = { id: dirNode.id, seed, nFiles, archetype };
      this.dirMeta.set(dirNode.id, meta);

      let smallBytes = 0;
      let smallCount = 0;
      let dirBytes = 0;
      let dirFiles = 0;
      const catBytes = new Map<Category, number>();

      const addCat = (c: Category, b: number) => catBytes.set(c, (catBytes.get(c) ?? 0) + b);

      this.eachFile(meta, (f) => {
        dirBytes += f.size;
        dirFiles++;
        addCat(f.category, f.size);
        if (f.size >= BUCKET_THRESHOLD) {
          mkNode({
            parentId: dirNode.id, name: f.name, isDir: false, isBundle: false,
            isSymlink: false, isAggregate: false, size: f.size, fileCount: 1,
            category: f.category, inaccessible: false, children: null,
            mtime: now - Math.floor(rng() * 3e7), hasHiddenChildren: false,
          });
        } else {
          smallBytes += f.size;
          smallCount++;
        }
      });

      // subdirectories — depth-limited, media/code archetypes propagate loosely
      if (depth < 5) {
        const nDirs = depth === 0 ? 8 + Math.floor(rng() * 5) : 1 + Math.floor(rng() * 4);
        for (let i = 0; i < nDirs; i++) {
          const subArch: Archetype =
            rng() < 0.2 ? "media" :
            rng() < 0.45 ? "code" :
            rng() < 0.6 ? "docs" :
            rng() < 0.72 ? "cache" : "mixed";
          const subName = DIR_NAMES[Math.floor(rng() * DIR_NAMES.length)] + (depth > 0 ? ` ${i}` : "");
          const sub = mkNode({
            parentId: dirNode.id, name: subName, isDir: true, isBundle: false,
            isSymlink: false, isAggregate: false, size: 0, fileCount: 0,
            category: "other", inaccessible: rng() < 0.004, children: [],
            mtime: now - Math.floor(rng() * 3e7), hasHiddenChildren: false,
          });
          // child budget decays; occasional huge subtree keeps the skew dramatic
          const childBudget = fileBudget * (rng() < 0.08 ? 0.9 : 0.42);
          let arr = this.childDirIds.get(dirNode.id);
          if (!arr) { arr = []; this.childDirIds.set(dirNode.id, arr); }
          arr.push(sub.id);
          const r = buildDir(sub, depth + 1, subArch, childBudget);
          dirBytes += r.bytes;
          dirFiles += r.files;
          // fold child dominant cats upward coarsely
          addCat(sub.category, r.bytes);
        }
      }

      // aggregate pseudo-node for this dir's small files
      if (smallCount > 0) {
        // dominant category among smalls: re-derive cheaply — use dir dominant
        let domSmall: Category = "other";
        let best = -1;
        for (const [c, b] of catBytes) if (b > best) { best = b; domSmall = c; }
        const agg = mkNode({
          parentId: dirNode.id, name: `${smallCount.toLocaleString("en-US")} small files`,
          isDir: false, isBundle: false, isSymlink: false, isAggregate: true,
          size: smallBytes, fileCount: smallCount, category: domSmall,
          inaccessible: false, children: null, mtime: 0, hasHiddenChildren: false,
        });
        this.aggIdOf.set(dirNode.id, agg.id);
        dirNode.hasHiddenChildren = true;
      }

      dirNode.size = dirBytes;
      dirNode.fileCount = dirFiles;
      // dominant category overall
      let dom: Category = "other";
      let bestB = -1;
      for (const [c, b] of catBytes) if (b > bestB) { bestB = b; dom = c; }
      dirNode.category = dom;

      totalFiles += 0; // (accounted at root return)
      return { bytes: dirBytes, files: dirFiles };
    };

    buildDir(root, 0, "mixed", 9000);
    totalFiles = root.fileCount;
    totalBytes = root.size;

    // a few .app bundles hanging off any "Applications" dir
    for (const meta of [...this.dirMeta.values()]) {
      const dirNode = emitted.get(meta.id)!;
      if (!dirNode.name.startsWith("Applications")) continue;
      for (let i = 0; i < 5; i++) {
        const appName = ["PhotoEdit", "Notes Plus", "TerminalX", "MusicBox", "Mailer"][i] + ".app";
        const sz = Math.floor(30e6 + rng() * 800e6);
        const app = mkNode({
          parentId: dirNode.id, name: appName, isDir: false, isBundle: true,
          isSymlink: false, isAggregate: false, size: sz, fileCount: 1,
          category: "app", inaccessible: false, children: null,
          mtime: now - Math.floor(rng() * 1e7), hasHiddenChildren: false,
        });
        app.parentId = dirNode.id;
        dirNode.size += sz;
        dirNode.fileCount += 1;
        root.size += sz;
        root.fileCount += 1;
        totalBytes += sz;
        totalFiles += 1;
      }
    }

    return { rootId: root.id, nodes, totalFiles, totalBytes };
  }

  // v3 subtree significance: dirs whose total size is below TS are emitted
  // collapsed (children: null, hasHiddenChildren: true); descendants omitted.
  private readonly TS = 50_000_000; // 50 MB subtree threshold

  // DFS pre-order emission list for one directory's subtree, applying collapse.
  // Returns payload nodes (cloned, children: null always — linkage is by parentId).
  private emitSubtree(dirId: number, out: Node[]) {
    const dir = this.currentNodes.get(dirId);
    if (!dir) return;
    for (const childDirId of this.childDirIds.get(dirId) ?? []) {
      const cd = this.currentNodes.get(childDirId);
      if (!cd) continue;
      if (cd.size < this.TS) {
        // collapsed leaf-like dir — real object, detail hidden
        out.push({ ...cd, children: null, hasHiddenChildren: true });
        this.visibleIds.add(cd.id);
      } else {
        out.push({ ...cd, children: null });
        this.visibleIds.add(cd.id);
        this.emitSubtree(childDirId, out);
      }
    }
    // big files + aggregate of this dir
    for (const n of this.currentNodes.values()) {
      if (n.parentId !== dirId || n.isDir) continue;
      out.push({ ...n, children: null });
      this.visibleIds.add(n.id);
    }
  }

  // Phase 2: emit the pre-built nodes top-down in batches, final sizes.
  private emitPhase(scanId: number, tree: { rootId: number; nodes: Node[]; totalFiles: number; totalBytes: number }) {
    const rootModel = this.currentNodes.get(tree.rootId)!;
    const ordered: Node[] = [{ ...rootModel, children: null }];
    this.visibleIds.add(tree.rootId);
    this.emitSubtree(tree.rootId, ordered);
    let cursor = 0;
    const BATCH = 3800;

    const tick = () => {
      const end = Math.min(ordered.length, cursor + BATCH);
      const batch = ordered.slice(cursor, end).map((n) => ({ ...n, children: n.isDir ? [] : null }));
      cursor = end;
      this.emit("scan-nodes", { scanId, nodes: batch, final: cursor >= ordered.length });
      if (cursor < ordered.length) {
        this.scanTimer = setTimeout(tick, 50);
      } else {
        this.scanTimer = null;
        const stats = {
          totalBytes: tree.totalBytes,
          totalFiles: tree.totalFiles,
          totalDirs: tree.nodes.filter((n) => n.isDir).length,
          inaccessibleUnknownCount: tree.nodes.filter((n) => n.inaccessible).length,
          durationMs: 3400,
        };
        this.emit("scan-complete", {
          scanId, rootId: tree.rootId, rootName: "dev", stats,
        });
      }
    };
    this.scanTimer = setTimeout(tick, 60);
  }

  // expand_dir v3: two cases, sometimes both.
  //  - bucketed dir: aggregate pseudo-node is replaced by the regenerated small
  //    files (removedIds = [aggId]).
  //  - collapsed dir: children emitted for the first time (removedIds empty);
  //    grandchild dirs below TS arrive collapsed per the same significance rules.
  private expandDir(id: number) {
    const meta = this.dirMeta.get(id);
    const parent = this.currentNodes.get(id);
    if (!meta || !parent) return;

    const nodes: Node[] = [];
    const removedIds: number[] = [];
    const aggId = this.aggIdOf.get(id);
    const aggVisible = aggId !== undefined && this.visibleIds.has(aggId);
    const noChildrenVisible = !(this.childDirIds.get(id) ?? []).some((c) => this.visibleIds.has(c))
      && ![...this.currentNodes.values()].some((n) => n.parentId === id && !n.isDir && !n.isAggregate && this.visibleIds.has(n.id));

    if (aggVisible) {
      // bucket replacement: small files materialize individually
      removedIds.push(aggId!);
      this.visibleIds.delete(aggId!);
      let nextId = 900_000_000 + id * 1000;
      const now = Math.floor(Date.now() / 1000);
      this.eachFile(meta, (f) => {
        if (f.size >= BUCKET_THRESHOLD) return;
        const n: Node = {
          id: nextId++, parentId: id, name: f.name, isDir: false, isBundle: false,
          isSymlink: false, isAggregate: false, size: f.size, fileCount: 1,
          category: f.category, inaccessible: false, children: null,
          mtime: now - 86400, hasHiddenChildren: false,
        };
        nodes.push(n);
        this.currentNodes.set(n.id, n);
        this.visibleIds.add(n.id);
      });
    } else if (noChildrenVisible) {
      // collapsed dir: emit children per significance rules (grandchildren may collapse)
      this.emitSubtree(id, nodes);
    } else {
      // already fully expanded — nothing new to send
      return;
    }

    this.emit("dir-detail", { parentId: id, nodes, removedIds });
  }

  private trashItems(paths: string[]): Promise<{ trashed: string[]; failed: { path: string; error: string }[] }> {
    // dev-only: locate node by reconstructing — paths in the mock are derivable
    // only for emitted nodes; simplest is to match the final path segment.
    for (const p of paths) {
      const name = p.split("/").pop() ?? "";
      let victim: Node | undefined;
      for (const n of this.currentNodes.values()) {
        if (n.name === name && !n.isAggregate) { victim = n; break; }
      }
      if (victim) {
        const upd: TreeUpdateEvent = {
          rootId: victim.id,
          nodes: [],
          removedIds: [],
          rootSizeDelta: -victim.size,
        };
        this.emit("tree-update", upd);
      }
    }
    return Promise.resolve({ trashed: paths, failed: [] });
  }
}

const FILE_STEPS_NAMES = ["scanning", "walking", "reading", "indexing", "measuring"];
