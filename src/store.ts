// Scan store v2: owns the node arena, lazy path reconstruction, expansion state,
// and a subscription model. Memory is bounded by emitted detail, not filesystem size.

import type { Node, NodeId, Category, ScanStats } from "./types";
import { getBackend } from "./ipc";

export type ScanPhase = "idle" | "scanning" | "complete" | "cancelled" | "error";

export interface StoreState {
  phase: ScanPhase;
  scanStage: "walking" | "emitting" | null; // sub-phase while scanning
  currentPath: string;
  scannedFiles: number;
  scannedBytes: number;
  errorMessage: string;
  stats: ScanStats | null;
  selectedId: NodeId | null;
  hoverId: NodeId | null;
  zoomId: NodeId | null;
  scanRootPath: string;
  rootName: string;
}

type Listener = () => void;

export class ScanStore {
  nodes = new Map<NodeId, Node>();
  scanId = 0;
  rootId: NodeId | null = null;
  state: StoreState = {
    phase: "idle",
    scanStage: null,
    currentPath: "",
    scannedFiles: 0,
    scannedBytes: 0,
    errorMessage: "",
    stats: null,
    selectedId: null,
    hoverId: null,
    zoomId: null,
    scanRootPath: "",
    rootName: "",
  };

  private listeners = new Set<Listener>();
  private scheduled = false;
  private detached: (() => void)[] = [];
  private pathCache = new Map<NodeId, string>();
  private expandRequested = new Set<NodeId>();

  version = 0; // bumps on structural changes only — not hover/selection

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Batched notification: coalesce every mutation in a frame into one subscriber pass.
  notify(structural = true) {
    if (structural) this.version++;
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const fn of this.listeners) fn();
    });
  }

  // Lazy path reconstruction: walk parents to the scan root. Memoized per id,
  // invalidated for replaced/removed subtrees.
  pathOf(id: NodeId): string {
    const cached = this.pathCache.get(id);
    if (cached !== undefined) return cached;
    const n = this.nodes.get(id);
    if (!n) return "";
    const parts: string[] = [];
    let cur: Node | undefined = n;
    let hops = 0;
    while (cur && cur.parentId !== null && hops < 2000) {
      parts.unshift(cur.name);
      cur = cur.parentId !== null ? this.nodes.get(cur.parentId) : undefined;
      hops++;
    }
    const rootPath = this.state.scanRootPath.replace(/\/+$/, "");
    const path = parts.length ? rootPath + "/" + parts.join("/") : rootPath;
    this.pathCache.set(id, path);
    return path;
  }

  async attachBackend() {
    const b = getBackend();
    const stale = (scanId: number) => scanId !== this.scanId;

    this.detached.push(await b.listen("scan-progress", (ev) => {
      if (stale(ev.scanId)) return;
      this.state.scanStage = "walking";
      this.state.currentPath = ev.currentPath;
      this.state.scannedFiles = ev.scannedFiles;
      this.state.scannedBytes = ev.scannedBytes;
      this.notify(false);
    }));

    this.detached.push(await b.listen("scan-nodes", (ev) => {
      if (stale(ev.scanId)) return;
      this.state.scanStage = "emitting";
      this.ingestNodes(ev.nodes);
      if (ev.final) {
        // all nodes arrived; scan-complete follows imminently
      }
      this.notify();
    }));

    this.detached.push(await b.listen("scan-complete", (ev) => {
      if (stale(ev.scanId)) return;
      this.rootId = ev.rootId;
      this.state.stats = ev.stats;
      this.state.rootName = ev.rootName;
      this.state.phase = "complete";
      this.state.scanStage = null;
      this.state.currentPath = "";
      this.notify();
    }));

    this.detached.push(await b.listen("scan-cancelled", (ev) => {
      if (stale(ev.scanId)) return;
      this.state.phase = "cancelled";
      this.state.scanStage = null;
      this.state.currentPath = "";
      this.notify();
    }));

    this.detached.push(await b.listen("scan-error", (ev) => {
      if (stale(ev.scanId)) return;
      this.state.phase = "error";
      this.state.scanStage = null;
      this.state.errorMessage = ev.message;
      this.notify();
    }));

    this.detached.push(await b.listen("tree-update", (ev) => {
      this.applyTreeUpdate(ev.rootId, ev.nodes, ev.removedIds, ev.rootSizeDelta);
      this.notify();
    }));

    this.detached.push(await b.listen("dir-detail", (ev) => {
      this.applyDirDetail(ev.parentId, ev.nodes, ev.removedIds);
      this.notify();
    }));

    this.detached.push(await b.listen("fs-events", () => { /* backend rescans itself; nothing to do here */ }));
  }

  async startScan(path: string) {
    const b = getBackend();
    const { scanId } = await b.invoke("start_scan", { path });
    this.scanId = scanId;
    this.nodes.clear();
    this.pathCache.clear();
    this.expandRequested.clear();
    this.rootId = null;
    this.state.phase = "scanning";
    this.state.scanStage = "walking";
    this.state.scannedFiles = 0;
    this.state.scannedBytes = 0;
    this.state.currentPath = path;
    this.state.errorMessage = "";
    this.state.stats = null;
    this.state.selectedId = null;
    this.state.hoverId = null;
    this.state.zoomId = null;
    this.state.scanRootPath = path;
    this.state.rootName = "";
    this.notify();
  }

  cancelScan() {
    void getBackend().invoke("cancel_scan");
  }

  // Expansion of a directory's hidden small files. Guarded against duplicates.
  expandDir(id: NodeId) {
    const n = this.nodes.get(id);
    if (!n || !n.hasHiddenChildren) return;
    if (this.expandRequested.has(id)) return;
    this.expandRequested.add(id);
    void getBackend().invoke("expand_dir", { id });
  }

  expandBundle(id: NodeId) {
    void getBackend().invoke("expand_bundle", { id });
  }

  private ingestNodes(batch: Node[]) {
    for (const raw of batch) {
      if (this.nodes.has(raw.id)) continue;
      const n: Node = { ...raw, children: raw.children ? [...raw.children] : raw.isDir ? [] : null };
      this.nodes.set(n.id, n);
      if (n.parentId !== null) {
        const p = this.nodes.get(n.parentId);
        if (p && p.children && !p.children.includes(n.id)) {
          p.children.push(n.id);
        }
      }
      if (!this.rootId && n.parentId === null) this.rootId = n.id;
    }
  }

  private applyDirDetail(parentId: NodeId, nodes: Node[], removedIds: NodeId[]) {
    const parent = this.nodes.get(parentId);
    if (!parent) return;
    // drop the replaced aggregate pseudo-nodes
    for (const rid of removedIds) {
      this.removeSubtree(rid, true);
    }
    parent.hasHiddenChildren = false;
    this.expandRequested.delete(parentId);
    this.ingestNodes(nodes);
  }

  private applyTreeUpdate(rootId: NodeId, nodes: Node[], removedIds: NodeId[], rootSizeDelta: number) {
    const old = this.nodes.get(rootId);
    const parentId = old?.parentId ?? null;

    if (old) this.removeSubtree(rootId, true);
    for (const id of removedIds) this.removeSubtree(id, true);

    this.ingestNodes(nodes);

    // ancestor sizes shift by the known delta — re-link the replacement root
    // and propagate the delta upward since sizes are final, not derived.
    if (parentId !== null && rootSizeDelta !== 0) {
      let cur: NodeId | null = parentId;
      let hops = 0;
      while (cur !== null && hops < 2000) {
        const n = this.nodes.get(cur);
        if (!n) break;
        n.size += rootSizeDelta;
        cur = n.parentId;
        hops++;
      }
    }
  }

  private removeSubtree(id: NodeId, unlink: boolean) {
    const n = this.nodes.get(id);
    if (!n) return;
    if (unlink && n.parentId !== null) {
      const p = this.nodes.get(n.parentId);
      if (p?.children) {
        const idx = p.children.indexOf(id);
        if (idx >= 0) p.children.splice(idx, 1);
      }
    }
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      const node = this.nodes.get(cur);
      if (!node) continue;
      if (node.children) stack.push(...node.children);
      this.nodes.delete(cur);
      this.pathCache.delete(cur);
      this.expandRequested.delete(cur);
    }
    if (this.state.selectedId !== null && !this.nodes.has(this.state.selectedId)) {
      this.state.selectedId = null;
    }
    if (this.state.zoomId !== null && !this.nodes.has(this.state.zoomId)) {
      this.state.zoomId = null;
    }
  }

  select(id: NodeId | null) {
    if (this.state.selectedId === id) return;
    this.state.selectedId = id;
    this.notify(false);
  }

  hover(id: NodeId | null) {
    if (this.state.hoverId === id) return;
    this.state.hoverId = id;
    this.notify(false);
  }

  zoomInto(id: NodeId | null) {
    this.state.zoomId = id;
    this.notify();
  }

  // Sorted children for tree display: dirs first, then by size desc.
  sortedChildren(id: NodeId): Node[] {
    const n = this.nodes.get(id);
    if (!n?.children) return [];
    const out: Node[] = [];
    for (const cid of n.children) {
      const c = this.nodes.get(cid);
      if (c) out.push(c);
    }
    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return b.size - a.size;
    });
    return out;
  }

  zoomRoot(): Node | null {
    if (this.state.zoomId !== null) return this.nodes.get(this.state.zoomId) ?? null;
    return this.rootId !== null ? this.nodes.get(this.rootId) ?? null : null;
  }

  // bytes per category across visible detail: files + aggregate pseudo-nodes
  // contribute their category bytes; real totals stay exact because aggregates
  // carry the bucketed bytes.
  categoryBreakdown(): Map<Category, number> {
    const out = new Map<Category, number>();
    const root = this.rootId !== null ? this.nodes.get(this.rootId) : null;
    if (!root) return out;
    const stack: NodeId[] = [root.id];
    while (stack.length) {
      const id = stack.pop()!;
      const n = this.nodes.get(id);
      if (!n) continue;
      if (!n.isDir || n.isBundle) {
        out.set(n.category, (out.get(n.category) ?? 0) + n.size);
      } else if (n.children) {
        for (const c of n.children) stack.push(c);
      }
    }
    return out;
  }
}

export const store = new ScanStore();
