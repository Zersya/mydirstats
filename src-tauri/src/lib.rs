pub mod scanner;
pub mod tree;
mod watcher;

use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppState {
    pub scan_counter: AtomicU64,
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub tree: Mutex<tree::Tree>,
    pub next_id: Arc<AtomicU64>,
    pub watcher_stop: Arc<AtomicBool>,
    pub watcher_gen: AtomicU64,
    // live walk-phase counters, polled by the frontend. Tauri's push events
    // demonstrably stall under scan load; pull-based progress has no channel.
    pub progress_files: AtomicU64,
    pub progress_bytes: AtomicU64,
    pub progress_scan_id: AtomicU64,
    pub progress_phase: AtomicU64, // 0 idle, 1 walking, 2 emitting, 3 done
    pub progress_path: Mutex<String>,
}

// ---------- commands ----------


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgressPoll {
    scan_id: u64,
    phase: u64,
    files: u64,
    bytes: u64,
    current_path: String,
}

#[tauri::command]
fn scan_progress_poll(state: State<'_, AppState>) -> ScanProgressPoll {
    ScanProgressPoll {
        scan_id: state.progress_scan_id.load(Ordering::Relaxed),
        phase: state.progress_phase.load(Ordering::Relaxed),
        files: state.progress_files.load(Ordering::Relaxed),
        bytes: state.progress_bytes.load(Ordering::Relaxed),
        current_path: state.progress_path.lock().clone(),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartScanResult {
    scan_id: u64,
}

#[tauri::command]
fn start_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<StartScanResult, String> {
    let root = PathBuf::from(&path);
    if !root.exists() {
        return Err(format!("path does not exist: {}", path));
    }
    if !root.is_dir() {
        return Err(format!("path is not a directory: {}", path));
    }

    // cancel any running scan and stop the old watcher
    if let Some(c) = state.cancel.lock().take() {
        c.store(true, Ordering::SeqCst);
    }
    state.watcher_stop.store(true, Ordering::SeqCst);
    state.watcher_gen.fetch_add(1, Ordering::SeqCst);

    let scan_id = state.scan_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock() = Some(cancel.clone());

    // reset pollable progress for the new scan
    state.progress_files.store(0, Ordering::Relaxed);
    state.progress_bytes.store(0, Ordering::Relaxed);
    state.progress_phase.store(1, Ordering::Relaxed);
    *state.progress_path.lock() = path.clone();

    let app2 = app.clone();
    let root2 = root.clone();
    std::thread::spawn(move || {
        let st = app2.state::<AppState>();
        let next_id = st.next_id.clone();
        let result = scanner::run_scan(&app2, scan_id, &root2, cancel, next_id.clone());
        if let Ok(out) = result {
            let stats = {
                let total_files = out.result.entries.iter().filter(|e| e.is_leaf()).count() as u64;
                let total_dirs = out
                    .result
                    .entries
                    .iter()
                    .filter(|e| e.is_dir() && !e.is_bundle() && !e.is_symlink())
                    .count() as u64;
                let total_bytes = out.result.entries[out.root_idx as usize].size;
                (
                    total_bytes,
                    total_files,
                    total_dirs,
                    out.result.inaccessible_unknown_count,
                    out.result.duration_ms,
                )
            };
            {
                let mut t = st.tree.lock();
                t.build(&out, &root2);
                drop(out);
                st.progress_phase.store(2, Ordering::Relaxed);
                tree::emit_scan_tree(&app2, scan_id, &mut t, stats, &next_id);
                st.progress_phase.store(3, Ordering::Relaxed);
            }
            let gen = st.watcher_gen.load(Ordering::SeqCst);
            watcher::start_watcher(app2.clone(), root2, gen);
        }
    });

    Ok(StartScanResult { scan_id })
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    if let Some(c) = state.cancel.lock().take() {
        c.store(true, Ordering::SeqCst);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashFailure {
    path: String,
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashResult {
    trashed: Vec<String>,
    failed: Vec<TrashFailure>,
}

#[tauri::command]
fn trash_items(paths: Vec<String>) -> TrashResult {
    let mut trashed = Vec::new();
    let mut failed = Vec::new();
    for p in paths {
        match trash::delete(&p) {
            Ok(()) => trashed.push(p),
            Err(e) => failed.push(TrashFailure {
                path: p,
                error: e.to_string(),
            }),
        }
    }
    TrashResult { trashed, failed }
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn copy_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        use objc2_foundation::NSString;
        unsafe {
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            let s = NSString::from_str(&path);
            pb.setString_forType(&s, NSPasteboardTypeString);
        }
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("unsupported platform".to_string())
    }
}

#[tauri::command]
fn quick_look(path: String) -> Result<(), String> {
    Command::new("qlmanage")
        .arg("-p")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_full_disk_access_settings() -> Result<(), String> {
    Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DefaultPathResult {
    path: String,
}

#[tauri::command]
fn default_scan_path() -> DefaultPathResult {
    // MYDIRSTATS_SCAN_PATH overrides the home default — dev/verification hook
    // for scanning specific targets on launch.
    let path = std::env::var("MYDIRSTATS_SCAN_PATH")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "/".to_string());
    DefaultPathResult { path }
}

#[tauri::command]
fn expand_bundle(app: AppHandle, id: u64) -> Result<(), String> {
    let st = app.state::<AppState>();
    let mut t = st.tree.lock();
    if !t.nodes.contains_key(&id) {
        return Err("node not in scanned tree".to_string());
    }
    let p = t
        .reconstruct_path(id)
        .ok_or_else(|| "cannot reconstruct path".to_string())?;
    if !p.exists() {
        return Err("path no longer exists".to_string());
    }
    tree::rescan_subtree(&app, &mut t, &p, true, &st.next_id);
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirDetailEvent {
    parent_id: u64,
    nodes: Vec<scanner::NodePayload>,
    removed_ids: Vec<u64>,
}

#[tauri::command]
fn expand_dir(app: AppHandle, id: u64) -> Result<(), String> {
    let st = app.state::<AppState>();
    let mut t = st.tree.lock();
    {
        let n = t.nodes.get(&id).ok_or_else(|| "node not in tree".to_string())?;
        if !(n.is_dir && !n.is_bundle) {
            return Err("node is not an expandable directory".to_string());
        }
    }
    let agg_id = t.nodes.get(&id).and_then(|n| n.aggregate_id);
    if let Some(n) = t.nodes.get_mut(&id) {
        n.expanded = true;
    }
    // children emitted subject to significance rules (grandchildren below Ts
    // arrive collapsed); the root payload itself is skipped.
    let nodes = tree::emit_visible(&mut t, id, true, &st.next_id);
    let mut removed = Vec::new();
    if let Some(a) = agg_id {
        removed.push(a);
    }
    app.emit(
        "dir-detail",
        DirDetailEvent {
            parent_id: id,
            nodes,
            removed_ids: removed,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            scan_counter: AtomicU64::new(0),
            cancel: Mutex::new(None),
            tree: Mutex::new(tree::Tree::new()),
            next_id: Arc::new(AtomicU64::new(1)),
            watcher_stop: Arc::new(AtomicBool::new(false)),
            watcher_gen: AtomicU64::new(0),
            progress_files: AtomicU64::new(0),
            progress_bytes: AtomicU64::new(0),
            progress_scan_id: AtomicU64::new(0),
            progress_phase: AtomicU64::new(0),
            progress_path: Mutex::new(String::new()),
        })
        .invoke_handler(tauri::generate_handler![
            start_scan,
            scan_progress_poll,
            cancel_scan,
            trash_items,
            reveal_in_finder,
            copy_path,
            quick_look,
            open_full_disk_access_settings,
            default_scan_path,
            expand_bundle,
            expand_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
