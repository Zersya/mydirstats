// Virtualized directory tree pane. Only visible rows in the DOM.
// 24px rows, mono right-aligned size column, disclosure triangles,
// keyboard navigable, selection/hover sync with treemap.

import type { NodeId } from "./types";
import { store } from "./store";
import { humanSize } from "./format";
import { CATEGORY_COLORS } from "./treemap";

const ROW_H = 24;

interface FlatRow {
  id: NodeId;
  depth: number;
}

export class TreePane {
  root: HTMLElement;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private rowsEl: HTMLElement;
  expanded = new Set<NodeId>();
  private flat: FlatRow[] = [];
  private cursorId: NodeId | null = null;
  private unsub: () => void = () => {};

  constructor(container: HTMLElement) {
    this.root = container;
    this.root.classList.add("tree-pane");
    this.root.tabIndex = 0;

    this.scroller = document.createElement("div");
    this.scroller.className = "tree-scroller";
    this.spacer = document.createElement("div");
    this.spacer.className = "tree-spacer";
    this.rowsEl = document.createElement("div");
    this.rowsEl.className = "tree-rows";
    this.spacer.appendChild(this.rowsEl);
    this.scroller.appendChild(this.spacer);
    this.root.appendChild(this.scroller);

    this.scroller.addEventListener("scroll", () => this.renderRows());
    this.root.addEventListener("keydown", (e) => this.handleKey(e));

    this.unsub = store.subscribe(() => this.rebuild());

    new ResizeObserver(() => this.renderRows()).observe(this.root);
    this.rebuild();
  }

  destroy() { this.unsub(); }

  isExpanded(id: NodeId) { return this.expanded.has(id); }

  private autoExpandedRoot: NodeId | null = null;

  private rebuild() {
    const rows: FlatRow[] = [];
    const rootId = store.rootId;
    if (rootId !== null && rootId !== this.autoExpandedRoot) {
      this.expanded.add(rootId);
      this.autoExpandedRoot = rootId;
    }
    if (rootId !== null && store.nodes.has(rootId)) {
      const walk = (id: NodeId, depth: number) => {
        rows.push({ id, depth });
        if (!this.expanded.has(id)) return;
        for (const child of store.sortedChildren(id)) {
          if (child.isDir) walk(child.id, depth + 1);
        }
        // files of this dir after subdirs (flat, only when expanded)
        if (this.expanded.has(id)) {
          for (const child of store.sortedChildren(id)) {
            if (!child.isDir) rows.push({ id: child.id, depth: depth + 1 });
          }
        }
      };
      walk(rootId, 0);
    }
    this.flat = rows;
    this.spacer.style.height = `${rows.length * ROW_H}px`;
    this.renderRows();
    this.scrollSelectionIntoView();
  }

  private scrollSelectionIntoView() {
    const sel = store.state.selectedId;
    if (sel === null) return;
    const idx = this.flat.findIndex((r) => r.id === sel);
    if (idx < 0) return;
    const top = idx * ROW_H;
    const viewTop = this.scroller.scrollTop;
    const viewBottom = viewTop + this.scroller.clientHeight;
    if (top < viewTop || top + ROW_H > viewBottom) {
      this.scroller.scrollTop = Math.max(0, top - this.scroller.clientHeight / 2);
    }
  }

  private renderRows() {
    const viewTop = this.scroller.scrollTop;
    const viewH = this.scroller.clientHeight || 400;
    const start = Math.max(0, Math.floor(viewTop / ROW_H) - 4);
    const end = Math.min(this.flat.length, Math.ceil((viewTop + viewH) / ROW_H) + 4);

    const sel = store.state.selectedId;
    const hov = store.state.hoverId;

    this.rowsEl.textContent = "";
    this.rowsEl.style.transform = `translateY(${start * ROW_H}px)`;

    for (let i = start; i < end; i++) {
      const row = this.flat[i];
      const n = store.nodes.get(row.id);
      if (!n) continue;
      const el = document.createElement("div");
      el.className = "tree-row";
      if (row.id === sel) el.classList.add("selected");
      if (row.id === hov) el.classList.add("hovered");
      if (row.id === this.cursorId) el.classList.add("cursor");
      el.style.paddingLeft = `${8 + row.depth * 14}px`;
      el.dataset.nodeId = String(row.id);

      if (n.isDir && !n.isBundle) {
        const tri = document.createElement("span");
        tri.className = "disclosure" + (this.expanded.has(row.id) ? " open" : "");
        tri.textContent = "▸";
        el.appendChild(tri);
      } else {
        const dot = document.createElement("span");
        dot.className = "file-dot";
        const col = CATEGORY_COLORS[n.category];
        dot.style.background = `oklch(${col.l} ${col.c} ${col.h})`;
        el.appendChild(dot);
      }

      const name = document.createElement("span");
      name.className = "tree-name" + (n.inaccessible ? " inaccessible" : "") + (n.isAggregate ? " aggregate" : "");
      name.textContent = n.name;
      el.appendChild(name);

      const size = document.createElement("span");
      size.className = "tree-size";
      size.textContent = n.size > 0 || !n.isDir ? humanSize(n.size) : "";
      el.appendChild(size);

      el.addEventListener("click", (e) => {
        store.select(row.id);
        this.cursorId = row.id;
        if (n.isDir && !n.isBundle && (e.target as HTMLElement).classList.contains("disclosure")) {
          this.toggle(row.id);
        }
        e.stopPropagation();
      });
      el.addEventListener("dblclick", () => {
        if (n.isDir && !n.isBundle) this.toggle(row.id);
      });
      el.addEventListener("mousemove", () => store.hover(row.id));
      this.rowsEl.appendChild(el);
    }
  }

  toggle(id: NodeId) {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
      const n = store.nodes.get(id);
      if (n?.hasHiddenChildren) store.expandDir(id);
    }
    this.rebuild();
  }

  expandTo(id: NodeId) {
    let cur = store.nodes.get(id)?.parentId ?? null;
    let hops = 0;
    while (cur !== null && hops < 500) {
      this.expanded.add(cur);
      cur = store.nodes.get(cur)?.parentId ?? null;
      hops++;
    }
    this.rebuild();
  }

  handleKey(e: KeyboardEvent) {
    if (!this.flat.length) return;
    const idx = this.cursorId !== null ? this.flat.findIndex((r) => r.id === this.cursorId) : -1;
    const curRow = idx >= 0 ? this.flat[idx] : null;

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = this.flat[Math.min(this.flat.length - 1, idx + 1)];
        if (next) { this.cursorId = next.id; store.select(next.id); this.renderRows(); this.scrollSelectionIntoView(); }
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev = this.flat[Math.max(0, idx - 1)];
        if (prev) { this.cursorId = prev.id; store.select(prev.id); this.renderRows(); this.scrollSelectionIntoView(); }
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        if (curRow) {
          const n = store.nodes.get(curRow.id);
          if (n?.isDir && !this.expanded.has(curRow.id)) this.toggle(curRow.id);
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        if (curRow) {
          const n = store.nodes.get(curRow.id);
          if (n?.isDir && this.expanded.has(curRow.id)) {
            this.toggle(curRow.id);
          } else if (n?.parentId != null) {
            this.cursorId = n.parentId;
            store.select(n.parentId);
            this.renderRows();
            this.scrollSelectionIntoView();
          }
        }
        break;
      }
    }
  }
}
