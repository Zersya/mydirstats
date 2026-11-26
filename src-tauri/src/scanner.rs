use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

pub type NodeId = u64;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Video,
    Image,
    Audio,
    Document,
    Code,
    App,
    Archive,
    Other,
}

pub const CAT_INDEX: usize = 8;

pub fn cat_index(c: Category) -> usize {
    match c {
        Category::Video => 0,
        Category::Image => 1,
        Category::Audio => 2,
        Category::Document => 3,
        Category::Code => 4,
        Category::App => 5,
        Category::Archive => 6,
        Category::Other => 7,
    }
}

pub fn cat_from_index(i: usize) -> Category {
    match i {
        0 => Category::Video,
        1 => Category::Image,
        2 => Category::Audio,
        3 => Category::Document,
        4 => Category::Code,
        5 => Category::App,
        6 => Category::Archive,
        _ => Category::Other,
    }
}

fn match_ext(ext: &str, table: &[&str]) -> bool {
    table.iter().any(|t| ext.eq_ignore_ascii_case(t))
}

const VIDEO_EXT: &[&str] = &[
    "mp4", "mov", "mkv", "avi", "webm", "m4v", "mpg", "mpeg", "wmv", "flv",
];
const IMAGE_EXT: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "tiff", "tif", "bmp", "raw", "cr2",
    "cr3", "nef", "arw", "dng", "svg", "ico", "photoslibrary",
];
const AUDIO_EXT: &[&str] = &["mp3", "aac", "flac", "wav", "ogg", "m4a", "aiff", "opus", "wma"];
const DOCUMENT_EXT: &[&str] = &[
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "txt", "md",
    "rtf", "epub", "csv",
];
const CODE_EXT: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "py", "go", "swift", "c", "cpp", "h", "hpp", "java", "rb",
    "php", "html", "css", "json", "yaml", "yml", "toml", "xml", "sh", "zsh", "sql",
];
const ARCHIVE_EXT: &[&str] = &["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "dmg", "iso", "pkg"];

const BUNDLE_EXT: &[&str] = &[
    "app",
    "photoslibrary",
    "photolibrary",
    "bundle",
    "framework",
    "xcodeproj",
    "xcworkspace",
    "playground",
    "sparsebundle",
    "imovielibrary",
    "theater",
];

pub fn category_for_ext(ext: &str) -> Category {
    if match_ext(ext, VIDEO_EXT) {
        Category::Video
    } else if match_ext(ext, IMAGE_EXT) {
        Category::Image
    } else if match_ext(ext, AUDIO_EXT) {
        Category::Audio
    } else if match_ext(ext, DOCUMENT_EXT) {
        Category::Document
    } else if match_ext(ext, CODE_EXT) {
        Category::Code
    } else if match_ext(ext, &["app"]) {
        Category::App
    } else if match_ext(ext, ARCHIVE_EXT) {
        Category::Archive
    } else {
        Category::Other
    }
}

pub fn is_bundle_name(name: &str) -> bool {
    match extension_of(name) {
        Some(e) => match_ext(e, BUNDLE_EXT),
        None => false,
    }
}

fn extension_of(name: &str) -> Option<&str> {
    let idx = name.rfind('.')?;
    if idx == 0 || idx == name.len() - 1 {
        return None;
    }
    Some(&name[idx + 1..])
}

/// v2 node payload — no path field, ever.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePayload {
    pub id: NodeId,
    pub parent_id: Option<NodeId>,
    pub name: String,
    pub is_dir: bool,
    pub is_bundle: bool,
    pub is_symlink: bool,
    pub is_aggregate: bool,
    pub size: u64,
    pub file_count: u64,
    pub category: Category,
    pub inaccessible: bool,
    pub children: Option<Vec<NodeId>>,
    pub mtime: i64,
    pub has_hidden_children: bool,
}

// flag bits
pub const F_DIR: u8 = 1;
pub const F_BUNDLE: u8 = 2;
pub const F_SYMLINK: u8 = 4;
pub const F_INACCESSIBLE: u8 = 8;

pub const NO_PARENT: u32 = u32::MAX;

/// Compact walk entry. Leaf entries do not retain their path (only dirs do,
/// for the watcher); per-entry cat_bytes arrays are gone — directory category
/// bytes are accumulated in a side table during aggregation.
pub struct Entry {
    pub id: NodeId,
    pub parent: u32,
    pub path: PathBuf, // empty for non-dir entries
    pub name: String,
    pub own_size: u64,
    pub size: u64,
    pub file_count: u64,
    pub mtime: i64,
    pub depth: u32,
    pub flags: u8,
    pub cat: u8,
}

impl Entry {
    pub fn is_dir(&self) -> bool {
        self.flags & F_DIR != 0
    }
    pub fn is_bundle(&self) -> bool {
        self.flags & F_BUNDLE != 0
    }
    pub fn is_symlink(&self) -> bool {
        self.flags & F_SYMLINK != 0
    }
    pub fn inaccessible(&self) -> bool {
        self.flags & F_INACCESSIBLE != 0
    }
    pub fn is_leaf(&self) -> bool {
        !self.is_dir() || self.is_bundle() || self.is_symlink()
    }
    pub fn category(&self) -> Category {
        cat_from_index(self.cat as usize)
    }
}

pub struct ScanResult {
    pub entries: Vec<Entry>,
    pub root_index: Option<usize>,
    pub dir_cat: HashMap<u32, [u64; CAT_INDEX]>,
    pub inaccessible_unknown_count: u64,
    pub cancelled: bool,
    pub duration_ms: u64,
}

/// Walk `root` with jwalk (parallel, quiet — progress counters only via on_progress).
/// If `expand_root` is true, the root itself is descended even if it is a bundle.
pub fn walk_tree(
    root: &Path,
    expand_root: bool,
    next_id: &Arc<AtomicU64>,
    cancel: Option<&AtomicBool>,
    mut on_entry: impl FnMut(&Entry),
) -> ScanResult {
    let started = Instant::now();
    let root_buf = root.to_path_buf();
    let process = {
        let root_buf = root_buf.clone();
        move |_depth: Option<usize>,
              dir_path: &Path,
              _state: &mut (),
              children: &mut Vec<Result<jwalk::DirEntry<((), ())>, jwalk::Error>>| {
            // never descend into bundle directories
            for c in children.iter_mut().flatten() {
                if c.file_type.is_dir() && !c.file_type.is_symlink() {
                    if is_bundle_name(&c.file_name.to_string_lossy()) {
                        c.read_children_path = None;
                    }
                }
            }
            // bundle scan-root: do not read its contents unless expanding
            if !expand_root
                && dir_path == root_buf.as_path()
                && root_buf
                    .file_name()
                    .map(|n| is_bundle_name(&n.to_string_lossy()))
                    .unwrap_or(false)
            {
                children.clear();
            }
        }
    };

    let walker = jwalk::WalkDirGeneric::<((), ())>::new(root_buf.clone())
        .skip_hidden(false)
        .follow_links(false)
        .sort(false)
        .process_read_dir(process);

    let mut entries: Vec<Entry> = Vec::new();
    // parent-path resolution only ever needs DIRECTORIES
    let mut dir_index: HashMap<PathBuf, u32> = HashMap::new();
    // entries whose parent dir hasn't been yielded yet (parallel reordering)
    let mut pending: HashMap<PathBuf, Vec<u32>> = HashMap::new();
    let mut inaccessible_unknown_count: u64 = 0;
    let mut cancelled = false;
    let mut root_index: Option<usize> = None;

    let mut count_since_check: u32 = 0;
    let mut fatal_root_error = false;

    for item in walker {
        if let Some(c) = cancel {
            count_since_check += 1;
            if count_since_check >= 512 {
                count_since_check = 0;
                if c.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
            }
        }
        let e = match item {
            Ok(e) => e,
            Err(err) => {
                if err.depth() == 0 {
                    fatal_root_error = true;
                }
                continue;
            }
        };

        let path = e.path();
        let is_symlink = e.file_type.is_symlink();
        let is_dir = e.file_type.is_dir() && !is_symlink;
        let parent_path: &Path = e.parent_path();
        let depth = e.depth as u32;
        let is_root = depth == 0 && path == root_buf;

        let meta = std::fs::symlink_metadata(&path).ok();
        let own_size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let name = if is_root {
            root_buf
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned())
        } else {
            e.file_name.to_string_lossy().into_owned()
        };

        let mut flags = 0u8;
        if is_dir {
            flags |= F_DIR;
        }
        if is_symlink {
            flags |= F_SYMLINK;
        }
        if is_dir && e.read_children_error.is_some() {
            flags |= F_INACCESSIBLE;
            inaccessible_unknown_count += 1;
        }
        let expanded_root = expand_root && is_root;
        let is_bundle = is_dir && !expanded_root && is_bundle_name(&name);
        if is_bundle {
            flags |= F_BUNDLE;
        }

        let cat = if is_symlink {
            Category::Other
        } else if !is_dir || is_bundle {
            extension_of(&name)
                .map(category_for_ext)
                .unwrap_or(Category::Other)
        } else {
            Category::Other // dirs recomputed in aggregation
        };

        let id = next_id.fetch_add(1, Ordering::Relaxed);
        let idx = entries.len() as u32;
        let parent_idx = if is_root {
            NO_PARENT
        } else {
            dir_index.get(parent_path).copied().unwrap_or(NO_PARENT)
        };

        entries.push(Entry {
            id,
            parent: parent_idx,
            path: if is_dir { path.clone() } else { PathBuf::new() },
            name,
            own_size,
            size: 0,
            file_count: 0,
            mtime,
            depth,
            flags,
            cat: cat_index(cat) as u8,
        });

        if is_dir {
            dir_index.insert(path.clone(), idx);
            // flush queued children of this dir
            if let Some(waiters) = pending.remove(&path) {
                for w in waiters {
                    entries[w as usize].parent = idx;
                }
            }
        }

        if !is_root && parent_idx == NO_PARENT {
            pending
                .entry(parent_path.to_path_buf())
                .or_default()
                .push(idx);
        }

        if is_root {
            root_index = Some(idx as usize);
        }

        on_entry(&entries[idx as usize]);
    }

    let duration_ms = started.elapsed().as_millis() as u64;

    if (fatal_root_error && entries.is_empty()) || entries.is_empty() {
        return ScanResult {
            entries,
            root_index: None,
            dir_cat: HashMap::new(),
            inaccessible_unknown_count,
            cancelled,
            duration_ms,
        };
    }

    // ---------- aggregation, deepest-first, no per-leaf cat arrays ----------
    let n = entries.len();
    let mut order: Vec<u32> = (0..n as u32).collect();
    order.sort_unstable_by_key(|&i| std::cmp::Reverse(entries[i as usize].depth));

    let mut dir_cat: HashMap<u32, [u64; CAT_INDEX]> = HashMap::new();

    // init own contributions
    for e in entries.iter_mut() {
        if e.is_leaf() {
            e.size = if e.inaccessible() { 0 } else { e.own_size };
            e.file_count = 1;
        } else {
            e.size = e.own_size; // dir inode size
            e.file_count = 0;
        }
    }

    for &i in &order {
        let idx = i as usize;
        let e = &entries[idx];
        let parent = e.parent;
        let is_plain_dir = e.is_dir() && !e.is_bundle() && !e.is_symlink();
        let size = e.size;
        let fc = e.file_count;
        let cat = e.cat;

        // finalize this dir's dominant category from its accumulated bytes
        if is_plain_dir {
            if let Some(cb) = dir_cat.get(&i) {
                let mut best = 0usize;
                for k in 1..CAT_INDEX {
                    if cb[k] > cb[best] {
                        best = k;
                    }
                }
                entries[idx].cat = best as u8;
            }
        }

        // propagate to parent
        if parent != NO_PARENT {
            let p = parent as usize;
            entries[p].size += size;
            entries[p].file_count += fc;
            let own_cb: Option<[u64; CAT_INDEX]> = if is_plain_dir {
                dir_cat.get(&i).copied()
            } else {
                None
            };
            let pcb = dir_cat.entry(parent).or_insert([0; CAT_INDEX]);
            if let Some(cb) = own_cb {
                for k in 0..CAT_INDEX {
                    pcb[k] += cb[k];
                }
            } else {
                pcb[cat as usize] += size;
            }
        }
    }

    ScanResult {
        entries,
        root_index,
        dir_cat,
        inaccessible_unknown_count,
        cancelled,
        duration_ms,
    }
}

/// Build children adjacency (entry-index keyed) in one pass.
pub fn children_map(entries: &[Entry]) -> HashMap<u32, Vec<u32>> {
    let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
    for (idx, e) in entries.iter().enumerate() {
        if e.parent != NO_PARENT {
            map.entry(e.parent).or_default().push(idx as u32);
        }
    }
    map
}

// ---------- adaptive threshold selection (v3) ----------

pub const TF_CANDIDATES: [u64; 4] = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
pub const TS_CANDIDATES: [u64; 5] = [
    1024 * 1024,
    8 * 1024 * 1024,
    32 * 1024 * 1024,
    128 * 1024 * 1024,
    512 * 1024 * 1024,
];
pub const NODE_BUDGET: usize = 120_000;

/// Pick the smallest (Tf, Ts) keeping total emitted nodes within budget.
/// Ts collapses whole subtrees below the size; Tf buckets small leaf files
/// inside expanded dirs. Exact counting: dirs propagate an expansion bitmask
/// (bit c = emitted-expanded under Ts candidate c) down the tree; leaves are
/// counted per (c, t) combo; buckets counted per (dir, c, t) bitmask.
pub fn choose_thresholds(entries: &[Entry], root_idx: u32) -> (u64, u64) {
    let nc = TS_CANDIDATES.len();
    let nt = TF_CANDIDATES.len();
    let all_bits: u8 = (1u8 << nc) - 1;

    // depth-ascending order so parent masks are ready before children
    let mut order: Vec<u32> = (0..entries.len() as u32).collect();
    order.sort_unstable_by_key(|&i| entries[i as usize].depth);

    // per-entry expansion bitmask (dirs only meaningful)
    let mut bits: Vec<u8> = vec![0u8; entries.len()];

    let mut expanded_count = [0u64; 5];
    let mut collapsed_count = [0u64; 5];
    let mut big_leaves = [[0u64; 4]; 5];
    // bucket presence bitmask per dir entry: bit (c*nt+t)
    let mut bucket_bits: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();

    for &i in &order {
        let idx = i as usize;
        let e = &entries[idx];
        let is_plain_dir = e.is_dir() && !e.is_bundle() && !e.is_symlink();
        let is_root = i == root_idx;

        if is_plain_dir {
            let parent_bits = if is_root {
                all_bits
            } else if e.parent != NO_PARENT {
                bits[e.parent as usize]
            } else {
                0
            };
            let mut my_bits = 0u8;
            for c in 0..nc {
                let chain_open = parent_bits & (1 << c) != 0;
                if !chain_open {
                    continue;
                }
                if is_root || e.size >= TS_CANDIDATES[c] {
                    my_bits |= 1 << c;
                    expanded_count[c] += 1;
                } else {
                    collapsed_count[c] += 1;
                }
            }
            bits[idx] = my_bits;
        } else {
            // leaf: counted if its parent dir is expanded under candidate c
            if e.parent == NO_PARENT {
                continue;
            }
            let pbits = bits[e.parent as usize];
            if pbits == 0 {
                continue;
            }
            for c in 0..nc {
                if pbits & (1 << c) == 0 {
                    continue;
                }
                let mut bmask = 0u32;
                for t in 0..nt {
                    if e.size >= TF_CANDIDATES[t] {
                        big_leaves[c][t] += 1;
                    } else {
                        bmask |= 1 << (c * nt + t);
                    }
                }
                if bmask != 0 {
                    *bucket_bits.entry(e.parent).or_insert(0) |= bmask;
                }
            }
        }
    }

    let mut bucket_count = [[0u64; 4]; 5];
    for &m in bucket_bits.values() {
        for c in 0..nc {
            for t in 0..nt {
                if m & (1 << (c * nt + t)) != 0 {
                    bucket_count[c][t] += 1;
                }
            }
        }
    }

    for c in 0..nc {
        for t in 0..nt {
            let total = expanded_count[c] + collapsed_count[c] + big_leaves[c][t] + bucket_count[c][t];
            if (total as usize) <= NODE_BUDGET {
                return (TF_CANDIDATES[t], TS_CANDIDATES[c]);
            }
        }
    }
    (TF_CANDIDATES[nt - 1], TS_CANDIDATES[nc - 1])
}

// ---------- scan driver ----------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgressEvent {
    scan_id: u64,
    phase: &'static str,
    current_path: String,
    scanned_files: u64,
    scanned_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub total_bytes: u64,
    pub total_files: u64,
    pub total_dirs: u64,
    pub inaccessible_unknown_count: u64,
    pub duration_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCompleteEvent {
    pub scan_id: u64,
    pub root_id: NodeId,
    pub root_name: String,
    pub stats: ScanStats,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCancelledEvent {
    scan_id: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanErrorEvent {
    scan_id: u64,
    message: String,
}

pub struct ScanOutput {
    pub result: ScanResult,
    pub tf: u64,
    pub ts: u64,
    pub kids: HashMap<u32, Vec<u32>>,
    pub root_idx: u32,
}

/// Run the full v2 scan: quiet walk phase, adaptive aggregation, top-down emit phase.
pub fn run_scan(
    app: &AppHandle,
    scan_id: u64,
    root: &Path,
    cancel: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
) -> Result<ScanOutput, String> {
    if !root.exists() {
        return Err(format!("path does not exist: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("path is not a directory: {}", root.display()));
    }

    // ---- phase 1: quiet walk. progress is written to shared atomics and
    // polled by the frontend; no push events (they stall under scan load). ----
    let prog_files = &app.state::<crate::AppState>().progress_files;
    let prog_bytes = &app.state::<crate::AppState>().progress_bytes;
    let prog_scan_id = &app.state::<crate::AppState>().progress_scan_id;
    let prog_phase = &app.state::<crate::AppState>().progress_phase;
    prog_scan_id.store(scan_id, Ordering::Relaxed);
    prog_phase.store(1, Ordering::Relaxed);

    let result = walk_tree(root, false, &next_id, Some(&cancel), |e| {
        let files = prog_files.fetch_add(1, Ordering::Relaxed) + 1;
        if e.is_leaf() {
            prog_bytes.fetch_add(e.own_size, Ordering::Relaxed);
        }
        // path display is cosmetic: update at most every ~2048 entries to keep
        // mutex contention off the parallel walker's hot path
        if e.is_dir() && files % 2048 == 0 {
            let st = app.state::<crate::AppState>();
            *st.progress_path.lock() = e.path.to_string_lossy().into_owned();
        }
    });

    if result.cancelled {
        let _ = app.emit("scan-cancelled", ScanCancelledEvent { scan_id });
        return Err("cancelled".to_string());
    }
    if result.entries.is_empty() || result.root_index.is_none() {
        let msg = format!("cannot scan {}", root.display());
        let _ = app.emit(
            "scan-error",
            ScanErrorEvent {
                scan_id,
                message: msg.clone(),
            },
        );
        return Err(msg);
    }

    // ---- aggregation done in walk_tree; choose adaptive thresholds ----
    let kids = children_map(&result.entries);
    let root_idx = result.root_index.unwrap() as u32;
    let (tf, ts) = choose_thresholds(&result.entries, root_idx);

    Ok(ScanOutput {
        result,
        tf,
        ts,
        kids,
        root_idx,
    })
}
