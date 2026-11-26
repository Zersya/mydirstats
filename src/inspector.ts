// Inspector: bottom-right overlay in the treemap pane showing selection detail.
// Never a modal. Actions: Trash, Reveal, Copy Path, Quick Look.

import { store } from "./store";
import { getBackend } from "./ipc";
import { humanSize, exactBytes, formatDate } from "./format";
import type { Node } from "./types";

export class Inspector {
  root: HTMLElement;
  private unsub: () => void;
  onTrash: ((node: Node) => void) | null = null;

  constructor(container: HTMLElement) {
    this.root = container;
    this.root.classList.add("inspector");
    this.unsub = store.subscribe(() => this.render());
    this.render();
  }

  destroy() { this.unsub(); }

  private render() {
    this.root.textContent = "";
    const id = store.state.selectedId;
    const n = id !== null ? store.nodes.get(id) : null;
    if (!n) {
      this.root.classList.add("hidden");
      return;
    }
    this.root.classList.remove("hidden");

    const title = document.createElement("div");
    title.className = "inspector-title";
    title.textContent = n.name;
    this.root.appendChild(title);

    const path = document.createElement("div");
    path.className = "inspector-path";
    const fullPath = n.isAggregate ? "" : store.pathOf(n.id);
    path.textContent = n.isAggregate ? "not a filesystem object — aggregated small files" : fullPath;
    path.title = fullPath;
    this.root.appendChild(path);

    const grid = document.createElement("div");
    grid.className = "inspector-grid";
    const addField = (label: string, value: string) => {
      const l = document.createElement("span");
      l.className = "inspector-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "inspector-value";
      v.textContent = value;
      grid.append(l, v);
    };
    addField("Size", `${humanSize(n.size)} (${exactBytes(n.size)})`);
    if (n.isDir) addField("Files", n.fileCount.toLocaleString("en-US"));
    addField("Type", n.isAggregate ? "aggregate" : n.isBundle ? `${n.category} (bundle)` : n.isDir ? "folder" : n.category);
    addField("Modified", formatDate(n.mtime));
    if (n.inaccessible) addField("Access", "permission denied");
    this.root.appendChild(grid);

    const actions = document.createElement("div");
    actions.className = "inspector-actions";

    const mk = (label: string, cls: string, fn: () => void) => {
      const b = document.createElement("button");
      b.className = cls;
      b.textContent = label;
      b.addEventListener("click", fn);
      actions.appendChild(b);
    };

    if (!n.isAggregate) mk("Trash", "btn danger", () => this.onTrash?.(n));
    if (!n.isAggregate) {
      mk("Reveal", "btn", () => void getBackend().invoke("reveal_in_finder", { path: store.pathOf(n.id) }));
      mk("Copy Path", "btn", () => void getBackend().invoke("copy_path", { path: store.pathOf(n.id) }));
      if (!n.isDir) mk("Quick Look", "btn", () => void getBackend().invoke("quick_look", { path: store.pathOf(n.id) }));
    } else {
      const note = document.createElement("span");
      note.className = "inspector-agg-note";
      note.textContent = `${n.fileCount.toLocaleString("en-US")} files aggregated — expand the parent folder to see them`;
      actions.appendChild(note);
    }

    this.root.appendChild(actions);
  }
}
