// Squarified treemap canvas renderer.
// - Retina-aware canvas 2D
// - incremental animation: rects ease toward targets (ease-out exponential via
//   per-frame smoothing, which reads as ease-out-quart-ish motion and is robust
//   under continuous scan updates)
// - skips sub-pixel nodes, caps drawn nodes per frame
// - click select, double-click zoom (animated), hover highlight, labels when they fit

import type { Node, NodeId, Category } from "./types";
import { store } from "./store";
import { humanSize } from "./format";

// Categorical palette, deuteranopia-oriented: categories separated in luminance
// as well as hue. Files/leaves only — directory chrome stays neutral.
export const CATEGORY_COLORS: Record<Category, { l: number; c: number; h: number }> = {
  image:    { l: 0.78, c: 0.12, h: 90 },   // amber — lightest
  video:    { l: 0.66, c: 0.15, h: 300 },  // violet-blue
  document: { l: 0.64, c: 0.14, h: 30 },   // red-orange
  code:     { l: 0.62, c: 0.09, h: 215 },  // cyan-blue
  audio:    { l: 0.55, c: 0.10, h: 165 },  // teal-green
  archive:  { l: 0.44, c: 0.05, h: 70 },   // brown-olive, low chroma
  app:      { l: 0.48, c: 0.14, h: 340 },  // magenta — deepest chroma
  other:    { l: 0.50, c: 0.03, h: 240 },  // muted slate — quiet but visible
};

export function categoryColor(cat: Category, depthStep: number): string {
  const base = CATEGORY_COLORS[cat];
  // at most 2 luminance steps for depth: alternate slightly darker at depth steps 1..2+
  const l = base.l - 0.07 * Math.min(depthStep, 2);
  return `oklch(${l.toFixed(3)} ${base.c} ${base.h})`;
}

interface Rect {
  x: number; y: number; w: number; h: number;
}

interface DrawItem {
  id: NodeId;
  node: Node;
  target: Rect;
  cur: Rect | null; // null = not yet appeared
  alpha: number;
  targetAlpha: number;
  depthStep: number;
  dead: boolean;
}

const MAX_DRAWN = 4000;
const MIN_AREA = 0.5;
// px² below which a rect is painted solid and its subtree is never visited —
// the hierarchical prune that bounds layout cost by pixels, not tree size.
const MIN_DETAIL_AREA = 16;

// squarified layout. Returns list of {id, rect, depthStep} for nodes within rect.
function squarify(
  node: Node,
  rect: Rect,
  depthStep: number,
  out: { id: NodeId; rect: Rect; depthStep: number; size: number }[],
  budget: { count: number },
) {
  const area = rect.w * rect.h;
  if (area < MIN_AREA || rect.w <= 0 || rect.h <= 0) return;
  out.push({ id: node.id, rect, depthStep, size: node.size });

  // Prune: a node whose rect is too small to meaningfully subdivide is drawn
  // as a solid block and its children are never visited. This is what bounds
  // layout cost: visible detail is limited by pixels, not by tree size, so a
  // 7-million-node scan costs the same as a small one per frame.
  if (area < MIN_DETAIL_AREA) return;

  if (budget.count <= 0) return;
  budget.count--;
  const kids: Node[] = [];
  if (node.children) {
    for (const cid of node.children) {
      const c = store.nodes.get(cid);
      if (c && c.size > 0) kids.push(c);
    }
  }
  if (!kids.length) return;
  kids.sort((a, b) => b.size - a.size);

  // layout children into rect inset by 1px gap
  const inner: Rect = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 };
  if (inner.w <= 0 || inner.h <= 0) return;

  const total = kids.reduce((s, k) => s + k.size, 0);
  if (total <= 0) return;
  const scale = (inner.w * inner.h) / total;

  // squarified algorithm
  let x = inner.x, y = inner.y, w = inner.w, h = inner.h;
  let i = 0;
  const nextDepth = depthStep + 1;
  while (i < kids.length) {
    const side = Math.min(w, h);
    if (side <= 0) break;
    // build row
    const row: Node[] = [];
    let rowSum = 0;
    let best = Infinity;
    while (i < kids.length) {
      const k = kids[i];
      const a = k.size * scale;
      const testSum = rowSum + a;
      // worst aspect ratio if added
      const worst = worstAspect(row.concat([k]), testSum, side, scale);
      if (row.length === 0 || worst <= best) {
        row.push(k);
        rowSum = testSum;
        best = worst;
        i++;
      } else break;
    }
    // lay out row along the shorter side
    const rowArea = rowSum;
    const thickness = rowArea / side;
    let offset = 0;
    for (const k of row) {
      const a = k.size * scale;
      const frac = a / rowArea;
      const rr: Rect = w >= h
        ? { x, y: y + offset, w: thickness, h: side * frac }
        : { x: x + offset, y, w: side * frac, h: thickness };
      squarify(k, rr, nextDepth, out, budget);
      offset += side * frac;
    }
    if (w >= h) { x += thickness; w -= thickness; } else { y += thickness; h -= thickness; }
  }
}

function worstAspect(row: Node[], rowSum: number, side: number, scale: number): number {
  let worst = 0;
  const s2 = side * side;
  const r2 = rowSum * rowSum;
  for (const k of row) {
    const a = k.size * scale;
    const aspect = Math.max((s2 * a) / r2, r2 / (s2 * a));
    if (aspect > worst) worst = aspect;
  }
  return worst;
}

export class Treemap {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private items = new Map<NodeId, DrawItem>();
  private order: NodeId[] = []; // paint order (parents first)
  private running = false;
  private needsLayout = true;
  private lastVersion = -1;
  private unsub: () => void;
  private resizeObs: ResizeObserver;
  private reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private lastFrame = 0;
  private lastRetargetAt = 0;
  breadcrumbEl: HTMLElement | null = null;
  onEmptyAreaClick: (() => void) | null = null;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.unsub = store.subscribe(() => {
      if (store.version !== this.lastVersion) {
        this.lastVersion = store.version;
        this.needsLayout = true;
      }
      this.ensureRunning();
    });
    this.resizeObs = new ResizeObserver(() => { this.needsLayout = true; this.ensureRunning(); });
    this.resizeObs.observe(canvas.parentElement ?? canvas);

    canvas.addEventListener("click", (e) => this.handleClick(e, false));
    canvas.addEventListener("dblclick", (e) => this.handleClick(e, true));
    canvas.addEventListener("mousemove", (e) => this.handleHover(e));
    canvas.addEventListener("mouseleave", () => store.hover(null));
  }

  destroy() {
    this.unsub();
    this.resizeObs.disconnect();
    this.running = false;
  }

  private layoutRects(): { id: NodeId; rect: Rect; depthStep: number; size: number }[] {
    const zoom = store.zoomRoot();
    if (!zoom || zoom.size <= 0) return [];
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w < 4 || h < 4) return [];
    const out: { id: NodeId; rect: Rect; depthStep: number; size: number }[] = [];
    squarify(zoom, { x: 0, y: 0, w, h }, 0, out, { count: MAX_DRAWN });
    return out;
  }

  private handleClick(e: MouseEvent, isDouble: boolean) {
    const hit = this.hitTest(e);
    if (!hit) {
      if (!isDouble) store.select(null);
      this.onEmptyAreaClick?.();
      return;
    }
    if (isDouble) {
      const n = store.nodes.get(hit);
      if (n?.isDir && !n.isBundle) {
        if (n.hasHiddenChildren) store.expandDir(hit);
        store.zoomInto(hit);
        store.select(hit);
        this.needsLayout = true;
        this.animateZoomReset();
        this.ensureRunning();
      }
    } else {
      store.select(hit);
    }
  }

  private animateZoomReset() {
    // on zoom change, items reappear from their parent-scaled position:
    // simplest readable motion — fade small rects in place by resetting cur.
    if (this.reduceMotion) { this.items.clear(); return; }
    for (const item of this.items.values()) item.cur = null;
  }

  zoomOut() {
    const zoom = store.zoomRoot();
    if (!zoom) return;
    store.zoomInto(zoom.parentId !== null && store.nodes.has(zoom.parentId) ? zoom.parentId : null);
    this.needsLayout = true;
    this.animateZoomReset();
    this.ensureRunning();
  }

  private handleHover(e: MouseEvent) {
    const hit = this.hitTest(e);
    store.hover(hit);
  }

  private hitTest(e: MouseEvent): NodeId | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // topmost = last painted (children paint after parents)
    for (let i = this.order.length - 1; i >= 0; i--) {
      const item = this.items.get(this.order[i]);
      if (!item || !item.cur) continue;
      const r = item.cur;
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return item.id;
    }
    return null;
  }

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number) {
    if (!this.running) return;
    const dt = Math.min(64, now - this.lastFrame);
    this.lastFrame = now;

    // resize canvas backing store
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
      this.needsLayout = true;
    }

    // Relayout throttle: during scanning, batches can arrive 20x/second and
    // each invalidates layout. Even a cheap layout at that rate starves the
    // frame. Cap retargets at ~7/sec during scanning; unthrottled otherwise.
    if (this.needsLayout) {
      const scanning = store.state.phase === "scanning";
      if (!scanning || now - this.lastRetargetAt >= 140) {
        this.needsLayout = false;
        this.lastRetargetAt = now;
        this.retarget();
      }
    }

    // animation step: exponential smoothing, ~ease-out. time constant ~60ms.
    const k = this.reduceMotion ? 1 : 1 - Math.exp(-dt / 60);
    let settled = true;
    let painted = 0;

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, cw, ch);

    const selId = store.state.selectedId;
    const hovId = store.state.hoverId;

    this.order.length = 0;
    for (const item of this.items.values()) {
      if (!item.target || item.dead) continue;
      if (!item.cur) {
        item.cur = { ...item.target };
        if (!this.reduceMotion) {
          // appear animation: start slightly smaller, at center
          const cx = item.target.x + item.target.w / 2;
          const cy = item.target.y + item.target.h / 2;
          item.cur = {
            x: cx - item.target.w * 0.4, y: cy - item.target.h * 0.4,
            w: item.target.w * 0.8, h: item.target.h * 0.8,
          };
          item.alpha = 0;
        } else {
          item.alpha = item.targetAlpha;
        }
      }
      const c = item.cur;
      const t = item.target;
      const dx = t.x - c.x, dy = t.y - c.y, dw = t.w - c.w, dh = t.h - c.h, da = item.targetAlpha - item.alpha;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dw) + Math.abs(dh) + Math.abs(da) > 0.3) {
        settled = false;
        c.x += dx * k; c.y += dy * k; c.w += dw * k; c.h += dh * k;
        item.alpha += da * k;
      } else {
        c.x = t.x; c.y = t.y; c.w = t.w; c.h = t.h;
        item.alpha = item.targetAlpha;
      }
      if (c.w < MIN_AREA || c.h < MIN_AREA) continue;
      this.order.push(item.id);
      this.paint(item, selId === item.id, hovId === item.id);
      painted++;
    }

    if (painted === 0) {
      this.paintEmpty(cw, ch);
    }

    if (!settled || (store.state.phase === "scanning" && this.needsLayout)) {
      requestAnimationFrame((t2) => this.frame(t2));
    } else {
      this.running = false;
    }
  }

  private retarget() {
    const layout = this.layoutRects();
    const seen = new Set<NodeId>();
    for (const { id, rect, depthStep } of layout) {
      seen.add(id);
      const node = store.nodes.get(id);
      if (!node) continue;
      let item = this.items.get(id);
      if (!item) {
        item = { id, node, target: rect, cur: null, alpha: 0, targetAlpha: 1, depthStep, dead: false };
        this.items.set(id, item);
      } else {
        item.node = node;
        item.target = rect;
        item.depthStep = depthStep;
        item.targetAlpha = 1;
        item.dead = false;
      }
    }
    // items not in layout anymore: shrink away
    for (const item of this.items.values()) {
      if (!seen.has(item.id) && !item.dead) {
        if (this.reduceMotion || !store.nodes.has(item.id)) {
          this.items.delete(item.id);
        } else {
          item.dead = true;
          item.targetAlpha = 0;
          const cx = item.target.x + item.target.w / 2;
          const cy = item.target.y + item.target.h / 2;
          item.target = { x: cx, y: cy, w: 0.1, h: 0.1 };
          // delete fully-faded items next retarget; cheap safety valve:
          setTimeout(() => this.items.delete(item.id), 400);
        }
      }
    }
    this.renderBreadcrumb();
  }

  private renderBreadcrumb() {
    if (!this.breadcrumbEl) return;
    const zoom = store.zoomRoot();
    const el = this.breadcrumbEl;
    el.textContent = "";
    if (!zoom) return;
    const chain: Node[] = [];
    let cur: Node | undefined = zoom;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId !== null ? store.nodes.get(cur.parentId) : undefined;
      if (chain.length > 60) break;
    }
    chain.forEach((n, i) => {
      const btn = document.createElement("button");
      btn.className = "crumb";
      btn.textContent = n.name;
      const isLast = i === chain.length - 1;
      if (!isLast) {
        btn.addEventListener("click", () => {
          store.zoomInto(n.parentId === null && store.rootId === n.id ? null : n.id);
          this.needsLayout = true;
          this.animateZoomReset();
          this.ensureRunning();
        });
      } else {
        btn.classList.add("current");
      }
      el.appendChild(btn);
      if (!isLast) {
        const sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.textContent = "›";
        el.appendChild(sep);
      }
    });
    // back-out button when zoomed
    if (store.state.zoomId !== null) {
      const back = document.createElement("button");
      back.className = "crumb-back";
      back.textContent = "Back";
      back.title = "Zoom out (double-click empty area or press Escape)";
      back.addEventListener("click", () => this.zoomOut());
      el.prepend(back);
    }
  }

  private paint(item: DrawItem, selected: boolean, hovered: boolean) {
    const c = item.cur!;
    const ctx = this.ctx;
    ctx.globalAlpha = item.alpha;
    // Files and leaves carry the categorical color. Directories render as
    // neutral depth structure: the surface darkens with depth, children paint
    // their colors over it. This keeps categorical color load-bearing instead
    // of mud — the user reads file types, not dominant-directory averages.
    const isLeaf = !item.node.isDir || item.node.isBundle || !item.node.children?.length;
    if (isLeaf) {
      ctx.fillStyle = categoryColor(item.node.category, 0);
      // aggregate pseudo-nodes read as "many small things": same hue family,
      // but dimmed — reduced luminance AND chroma pull them toward the chrome.
      if (item.node.isAggregate) {
        const col = CATEGORY_COLORS[item.node.category];
        ctx.fillStyle = `oklch(${(col.l * 0.72).toFixed(3)} ${(col.c * 0.55).toFixed(3)} ${col.h})`;
      }
    } else {
      // directory nesting zones: luminance stays anchored to the depth step,
      // but the fill whispers the dominant content hue at very low chroma
      // instead of pure neutral — pruned regions read as typed mass, not voids.
      const l = 0.205 - 0.018 * Math.min(item.depthStep, 2);
      const dom = CATEGORY_COLORS[item.node.category];
      ctx.fillStyle = `oklch(${l.toFixed(3)} ${(dom.c * 0.15).toFixed(3)} ${dom.h})`;
    }
    ctx.fillRect(c.x, c.y, c.w, c.h);

    // inner dark gap: paint a 1px dark stroke on inside edge
    ctx.strokeStyle = "oklch(0.13 0.006 250)";
    ctx.lineWidth = 1;
    ctx.strokeRect(c.x + 0.5, c.y + 0.5, Math.max(0, c.w - 1), Math.max(0, c.h - 1));

    if (hovered || selected) {
      ctx.strokeStyle = selected ? "oklch(0.70 0.14 250)" : "oklch(0.70 0.14 250 / 55%)";
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeRect(c.x + 1, c.y + 1, Math.max(0, c.w - 2), Math.max(0, c.h - 2));
    }

    // label when it fits; contrast adapts to the fill luminance
    if (c.w > 44 && c.h > 24) {
      const fillL = isLeaf ? CATEGORY_COLORS[item.node.category].l : 0.2;
      const lightBg = fillL > 0.62;
      ctx.fillStyle = lightBg ? "oklch(0.22 0.01 250 / 90%)" : "oklch(0.93 0.005 250 / 92%)";
      ctx.font = "11px -apple-system, system-ui, sans-serif";
      ctx.textBaseline = "top";
      const name = item.node.name;
      const maxW = c.w - 8;
      ctx.save();
      ctx.beginPath();
      ctx.rect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
      ctx.clip();
      ctx.fillText(name, c.x + 4, c.y + 3, maxW);
      if (c.h > 38) {
        ctx.fillStyle = lightBg ? "oklch(0.22 0.01 250 / 65%)" : "oklch(0.93 0.005 250 / 60%)";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(humanSize(item.node.size), c.x + 4, c.y + 17, maxW);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private paintEmpty(w: number, h: number) {
    const ctx = this.ctx;
    ctx.fillStyle = "oklch(0.45 0.008 250)";
    ctx.font = "13px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    const msg = store.state.phase === "scanning" ? "Scanning…" : "";
    if (msg) ctx.fillText(msg, w / 2, h / 2);
    ctx.textAlign = "left";
  }
}
