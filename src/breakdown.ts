// Type breakdown strip: proportional horizontal bar of bytes per category,
// collapsed by default, expandable to a legend list with exact sizes.

import type { Category } from "./types";
import { store } from "./store";
import { humanSize } from "./format";
import { CATEGORY_COLORS } from "./treemap";

const CAT_ORDER: Category[] = ["video", "image", "audio", "document", "code", "app", "archive", "other"];
const CAT_LABELS: Record<Category, string> = {
  video: "Video", image: "Images", audio: "Audio", document: "Documents",
  code: "Code", app: "Apps", archive: "Archives", other: "Other",
};

export class Breakdown {
  root: HTMLElement;
  expanded = false;
  private unsub: () => void;

  constructor(container: HTMLElement) {
    this.root = container;
    this.root.classList.add("breakdown");
    this.unsub = store.subscribe(() => this.render());
    this.render();
  }

  destroy() { this.unsub(); }

  private render() {
    this.root.textContent = "";
    const data = store.categoryBreakdown();
    const total = [...data.values()].reduce((s, v) => s + v, 0);
    if (total <= 0) {
      this.root.classList.add("hidden");
      return;
    }
    this.root.classList.remove("hidden");

    const bar = document.createElement("div");
    bar.className = "breakdown-bar";
    for (const cat of CAT_ORDER) {
      const bytes = data.get(cat) ?? 0;
      if (bytes <= 0) continue;
      const seg = document.createElement("div");
      seg.className = "breakdown-seg";
      const col = CATEGORY_COLORS[cat];
      seg.style.background = `oklch(${col.l} ${col.c} ${col.h})`;
      seg.style.width = `${(bytes / total) * 100}%`;
      seg.title = `${CAT_LABELS[cat]} — ${humanSize(bytes)}`;
      bar.appendChild(seg);
    }
    this.root.appendChild(bar);

    const toggle = document.createElement("button");
    toggle.className = "breakdown-toggle";
    toggle.textContent = this.expanded ? "Hide breakdown ▾" : "By type ▸";
    toggle.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.render();
    });
    this.root.appendChild(toggle);

    if (this.expanded) {
      const list = document.createElement("div");
      list.className = "breakdown-list";
      const sorted = CAT_ORDER.filter((c) => (data.get(c) ?? 0) > 0).sort((a, b) => (data.get(b) ?? 0) - (data.get(a) ?? 0));
      for (const cat of sorted) {
        const bytes = data.get(cat) ?? 0;
        const item = document.createElement("div");
        item.className = "breakdown-item";
        const col = CATEGORY_COLORS[cat];
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = `oklch(${col.l} ${col.c} ${col.h})`;
        const label = document.createElement("span");
        label.className = "breakdown-label";
        label.textContent = CAT_LABELS[cat];
        const val = document.createElement("span");
        val.className = "breakdown-value";
        val.textContent = `${humanSize(bytes)} · ${((bytes / total) * 100).toFixed(1)}%`;
        item.append(swatch, label, val);
        list.appendChild(item);
      }
      this.root.appendChild(list);
    }
  }
}
