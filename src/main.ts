// App shell: toolbar, panes, resizer, status bar, keyboard map, states.

import "./style.css";
import { store } from "./store";
import { getBackend } from "./ipc";
import { Treemap } from "./treemap";
import { TreePane } from "./treepane";
import { Breakdown } from "./breakdown";
import { Inspector } from "./inspector";
import { humanSize, truncateMiddle } from "./format";
import type { Node } from "./types";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="toolbar" id="toolbar">
    <div class="target-wrap">
      <button class="btn target-btn" id="targetBtn" title="Choose scan target (⌘O)">
        <span id="targetLabel">Choose scan target</span><span class="chev">▾</span>
      </button>
      <div class="target-menu hidden" id="targetMenu">
        <button class="menu-item" data-target="home">Home folder</button>
        <button class="menu-item" data-target="browse">Browse…</button>
        <button class="menu-item" data-target="root">Macintosh HD (/)</button>
        <div class="menu-custom">
          <input id="customPath" type="text" placeholder="/path/to/scan" spellcheck="false"/>
          <button class="btn" id="customGo">Scan</button>
        </div>
      </div>
    </div>
    <span class="scan-state" id="scanState"></span>
    <div class="toolbar-spacer"></div>
    <button class="btn hidden" id="rescanBtn" title="Rescan (⌘R)">Rescan</button>
    <button class="btn danger hidden" id="trashBtn" title="Move selection to Trash (⌘⌫)">Trash</button>
  </div>
  <div class="main-row" id="mainRow">
    <div class="tree-host" id="treeHost"></div>
    <div class="divider" id="divider"></div>
    <div class="treemap-host" id="treemapHost">
      <div class="breadcrumb" id="breadcrumb"></div>
      <canvas id="treemapCanvas"></canvas>
      <div class="empty-state hidden" id="emptyState">
        <div class="empty-title">mydirstats</div>
        <div class="empty-sub">Pick a folder to scan. Sizes fill in live as the walker works.</div>
        <button class="btn accent" id="emptyScanBtn">Choose scan target</button>
      </div>
      <div class="scanning-overlay hidden" id="scanningBar">
        <div class="walk-stats">
          <div class="walk-count" id="walkFiles">0</div>
          <div class="walk-label">files scanned</div>
          <div class="walk-bytes" id="walkBytes">0 B</div>
          <div class="walk-label">read so far</div>
        </div>
        <div class="scanning-path" id="scanningPath"></div>
        <button class="btn" id="cancelBtn">Cancel</button>
      </div>
      <div class="error-state hidden" id="errorState">
        <div class="error-msg" id="errorMsg"></div>
        <button class="btn" id="errorRetry">Try again</button>
      </div>
    </div>
  </div>
  <div class="bottom" id="bottom">
    <div id="breakdownHost"></div>
    <div class="statusbar" id="statusbar">
      <span id="statusText">Ready</span>
      <div class="status-spacer"></div>
      <div class="perm-notice hidden" id="permNotice">
        <span id="permText"></span>
        <button class="btn small" id="fdaBtn">Open Full Disk Access settings</button>
      </div>
    </div>
  </div>
  <div class="toast hidden" id="toast"></div>
`;

function $(id: string): HTMLElement { return document.getElementById(id)!; }

const treeHost = $("treeHost");
const treemapHost = $("treemapHost");
const canvas = document.getElementById("treemapCanvas") as HTMLCanvasElement;

const tree = new TreePane(treeHost);
const treemap = new Treemap(canvas);
treemap.breadcrumbEl = $("breadcrumb");
new Breakdown($("breakdownHost"));
const inspectorHost = document.createElement("div");
treemapHost.appendChild(inspectorHost);
const inspector = new Inspector(inspectorHost);

let lastScanPath = "";

// ---------- scan target picker ----------
const targetMenu = $("targetMenu");
const targetBtn = $("targetBtn");

function toggleMenu(force?: boolean) {
  const show = force ?? targetMenu.classList.contains("hidden");
  targetMenu.classList.toggle("hidden", !show);
  if (show) (document.getElementById("customPath") as HTMLInputElement).focus();
}
targetBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
document.addEventListener("click", (e) => {
  if (!targetMenu.contains(e.target as HTMLElement) && e.target !== targetBtn) {
    targetMenu.classList.add("hidden");
  }
});

async function scanHome() {
  const { path } = await getBackend().invoke("default_scan_path");
  startScan(path);
}
async function scanRoot() { startScan("/"); }

targetMenu.querySelector('[data-target="home"]')!.addEventListener("click", () => {
  targetMenu.classList.add("hidden"); void scanHome();
});
targetMenu.querySelector('[data-target="root"]')!.addEventListener("click", () => {
  targetMenu.classList.add("hidden"); void scanRoot();
});
targetMenu.querySelector('[data-target="browse"]')!.addEventListener("click", () => {
  targetMenu.classList.add("hidden");
  void (async () => {
    if (!("__TAURI__" in window)) {
      // browser dev: no native dialog; fall back to the typed path field
      targetMenu.classList.remove("hidden");
      (document.getElementById("customPath") as HTMLInputElement).focus();
      return;
    }
    const picked = await dialogOpen({ directory: true, multiple: false, title: "Choose folder to scan" });
    if (typeof picked === "string") startScan(picked);
  })();
});
$("customGo").addEventListener("click", () => {
  const v = (document.getElementById("customPath") as HTMLInputElement).value.trim();
  if (v) { targetMenu.classList.add("hidden"); startScan(v); }
});
(document.getElementById("customPath") as HTMLInputElement).addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = (e.target as HTMLInputElement).value.trim();
    if (v) { targetMenu.classList.add("hidden"); startScan(v); }
  }
  e.stopPropagation();
});

function startScan(path: string) {
  lastScanPath = path;
  tree.expanded.clear(); // reset expansion state for fresh scan
  void store.startScan(path);
}

$("emptyScanBtn").addEventListener("click", () => toggleMenu(true));
$("rescanBtn").addEventListener("click", () => { if (lastScanPath) startScan(lastScanPath); });
$("cancelBtn").addEventListener("click", () => store.cancelScan());
$("errorRetry").addEventListener("click", () => { if (lastScanPath) startScan(lastScanPath); });
$("fdaBtn").addEventListener("click", () => void getBackend().invoke("open_full_disk_access_settings"));

// ---------- trash + toast ----------
const toast = $("toast");
let toastTimer: number | undefined;

function showToast(msg: string) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add("hidden"), 4000);
}

async function trashNode(n: Node) {
  if (n.isAggregate) { showToast("Aggregated small files can\u2019t be trashed directly."); return; }
  const res = await getBackend().invoke("trash_items", { paths: [store.pathOf(n.id)] });
  if (res.trashed.length) {
    showToast(`Moved to Trash: ${n.name}`);
  }
  for (const f of res.failed) {
    showToast(`Couldn't trash ${f.path}: ${f.error}`);
  }
}

inspector.onTrash = (n) => void trashNode(n);
$("trashBtn").addEventListener("click", () => {
  const id = store.state.selectedId;
  const n = id !== null ? store.nodes.get(id) : null;
  if (n) void trashNode(n);
});

// ---------- keyboard map ----------
document.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key === "r") {
    e.preventDefault();
    if (lastScanPath) startScan(lastScanPath);
  } else if (meta && e.key === "o") {
    e.preventDefault();
    toggleMenu();
  } else if (meta && e.key === "Backspace") {
    e.preventDefault();
    const id = store.state.selectedId;
    const n = id !== null ? store.nodes.get(id) : null;
    if (n) void trashNode(n);
  } else if (e.key === " " && !meta) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    const id = store.state.selectedId;
    const n = id !== null ? store.nodes.get(id) : null;
    if (n && !n.isAggregate) void getBackend().invoke("quick_look", { path: store.pathOf(n.id) });
  } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && !meta) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA") {
      tree.handleKey(e);
    }
  } else if (e.key === "Escape") {
    if (!targetMenu.classList.contains("hidden")) targetMenu.classList.add("hidden");
    else treemap.zoomOut();
  }
});

// ---------- pane divider ----------
const divider = $("divider");
let dragging = false;
divider.addEventListener("mousedown", (e) => {
  dragging = true;
  e.preventDefault();
  document.body.classList.add("resizing");
});
document.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const rowRect = $("mainRow").getBoundingClientRect();
  const x = e.clientX - rowRect.left;
  const clamped = Math.max(180, Math.min(480, x));
  treeHost.style.width = `${clamped}px`;
});
document.addEventListener("mouseup", () => {
  dragging = false;
  document.body.classList.remove("resizing");
});
// keyboard-adjustable divider (when focused)
divider.tabIndex = 0;
divider.addEventListener("keydown", (e) => {
  const cur = treeHost.getBoundingClientRect().width;
  if (e.key === "ArrowLeft") treeHost.style.width = `${Math.max(180, cur - 16)}px`;
  if (e.key === "ArrowRight") treeHost.style.width = `${Math.min(480, cur + 16)}px`;
});

// ---------- context menu (right-click on treemap) ----------
const ctxMenu = document.createElement("div");
ctxMenu.className = "ctx-menu hidden";
document.body.appendChild(ctxMenu);
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const id = store.state.hoverId ?? store.state.selectedId;
  const n = id !== null ? store.nodes.get(id) : null;
  if (!n) return;
  store.select(n.id);
  ctxMenu.textContent = "";
  const mkItem = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "menu-item";
    b.textContent = label;
    b.addEventListener("click", () => { ctxMenu.classList.add("hidden"); fn(); });
    ctxMenu.appendChild(b);
  };
  mkItem("Reveal in Finder", () => void getBackend().invoke("reveal_in_finder", { path: store.pathOf(n.id) }));
  mkItem("Copy Path", () => void getBackend().invoke("copy_path", { path: store.pathOf(n.id) }));
  if (!n.isDir && !n.isAggregate) mkItem("Quick Look", () => void getBackend().invoke("quick_look", { path: store.pathOf(n.id) }));
  if (n.isBundle) mkItem("Expand bundle", () => store.expandBundle(n.id));
  mkItem("Move to Trash", () => void trashNode(n));
  ctxMenu.style.left = `${e.clientX}px`;
  ctxMenu.style.top = `${e.clientY}px`;
  ctxMenu.classList.remove("hidden");
});
document.addEventListener("click", (e) => {
  if (!ctxMenu.contains(e.target as HTMLElement)) ctxMenu.classList.add("hidden");
});

// selection in treemap expands tree to show it
store.subscribe(() => {
  const sel = store.state.selectedId;
  if (sel !== null && store.nodes.has(sel)) {
    tree.expandTo(sel);
  }
});

// ---------- reactive shell ----------
function renderShell() {
  const s = store.state;
  const empty = $("emptyState");
  const scanningBar = $("scanningBar");
  const errorState = $("errorState");
  const statusText = $("statusText");
  const scanState = $("scanState");
  const permNotice = $("permNotice");

  empty.classList.toggle("hidden", s.phase !== "idle");
  scanningBar.classList.toggle("hidden", s.phase !== "scanning");
  errorState.classList.toggle("hidden", s.phase !== "error");
  $("rescanBtn").classList.toggle("hidden", s.phase === "idle" || s.phase === "scanning");
  $("trashBtn").classList.toggle("hidden", s.selectedId === null);

  if (s.phase === "scanning") {
    $("scanningPath").textContent = truncateMiddle(s.currentPath, 72);
    $("walkFiles").textContent = s.scannedFiles.toLocaleString("en-US");
    $("walkBytes").textContent = humanSize(s.scannedBytes);
    // during the emit phase the treemap takes over — counters step aside
    const emitting = s.scanStage === "emitting";
    scanningBar.classList.toggle("emitting", emitting);
    scanState.textContent = `${s.scannedFiles.toLocaleString("en-US")} files · ${humanSize(s.scannedBytes)}`;
    statusText.textContent = emitting ? "Assembling picture…" : "Scanning…";
  } else if (s.phase === "complete" && s.stats) {
    scanState.textContent = "";
    statusText.textContent = `${humanSize(s.stats.totalBytes)} · ${s.stats.totalFiles.toLocaleString("en-US")} files · scanned in ${(s.stats.durationMs / 1000).toFixed(1)}s`;
    const root = store.rootId !== null ? store.nodes.get(store.rootId) : null;
    if (root) $("targetLabel").textContent = store.state.rootName || root.name;
  } else if (s.phase === "error") {
    scanState.textContent = "";
    $("errorMsg").textContent = s.errorMessage || "Scan failed.";
    statusText.textContent = "Scan error";
  } else if (s.phase === "cancelled") {
    scanState.textContent = "";
    statusText.textContent = "Scan cancelled";
  } else {
    scanState.textContent = "";
    statusText.textContent = "Ready";
  }

  // permission gaps
  const unknown = s.stats?.inaccessibleUnknownCount ?? 0;
  if (unknown > 0) {
    permNotice.classList.remove("hidden");
    $("permText").textContent = `${unknown} ${unknown === 1 ? "folder" : "folders"} couldn't be read — sizes are incomplete.`;
  } else {
    permNotice.classList.add("hidden");
  }
}
store.subscribe(renderShell);

// ---------- boot ----------
(window as unknown as { __mdsStore: unknown }).__mdsStore = store;
void store.attachBackend().then(() => {
  renderShell();
  treemap.ensureRunning();
  // in the real app, scanning starts immediately: the user opened a disk tool,
  // the disk is the point. home folder default; mock/browser stays manual.
  if ("__TAURI__" in window) {
    void scanHome();
  }
});
