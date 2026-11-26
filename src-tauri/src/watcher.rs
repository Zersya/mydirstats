use crate::tree::{rescan_subtree, TreeUpdateEvent};
use crate::AppState;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEventsPayload {
    affected_roots: Vec<String>,
}

enum Msg {
    Fs(notify::Event),
    Stop,
}

/// Watch `root` recursively. Events are debounced (500ms quiet, 2s cap),
/// condensed to covering scanned directories, then each target subtree is
/// rescanned serially with `tree-update` emissions. Stops when the watcher
/// stop flag is set (new scan) or the scanned root disappears.
pub fn start_watcher(app: AppHandle, root: PathBuf, gen: u64) {
    std::thread::spawn(move || {
        let stop = {
            let st = app.state::<AppState>();
            st.watcher_stop.clone()
        };

        let (tx, rx) = mpsc::channel::<Msg>();
        let tx2 = tx.clone();
        let mut watcher: RecommendedWatcher = match notify::Watcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                if let Ok(ev) = res {
                    let _ = tx2.send(Msg::Fs(ev));
                }
            },
            Config::default(),
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("watcher init failed: {}", e);
                return;
            }
        };
        if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
            eprintln!("watcher watch failed: {}", e);
            return;
        }

        // stop signal pump
        {
            let stop_tx = tx.clone();
            let stop_flag = stop.clone();
            std::thread::spawn(move || {
                while !stop_flag.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(200));
                }
                let _ = stop_tx.send(Msg::Stop);
            });
        }

        let is_current = |app: &AppHandle| -> bool {
            app.state::<AppState>().watcher_gen.load(Ordering::SeqCst) == gen
        };

        let mut dirty: HashSet<PathBuf> = HashSet::new();
        let mut first_event_at: Option<Instant> = None;
        let mut last_event_at: Option<Instant> = None;
        let debounce = Duration::from_millis(500);
        let cap = Duration::from_millis(2000);

        loop {
            if !is_current(&app) {
                break;
            }
            let timeout = if dirty.is_empty() {
                Duration::from_millis(1000)
            } else {
                Duration::from_millis(100)
            };
            match rx.recv_timeout(timeout) {
                Ok(Msg::Stop) => break,
                Ok(Msg::Fs(ev)) => {
                    for p in ev.paths {
                        if p.starts_with(&root) {
                            dirty.insert(p);
                        }
                    }
                    let now = Instant::now();
                    first_event_at.get_or_insert(now);
                    last_event_at = Some(now);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            if dirty.is_empty() {
                continue;
            }

            let now = Instant::now();
            let quiet_long_enough = last_event_at
                .map(|l| now.duration_since(l) >= debounce)
                .unwrap_or(false);
            let capped = first_event_at
                .map(|f| now.duration_since(f) >= cap)
                .unwrap_or(false);
            if !quiet_long_enough && !capped {
                continue;
            }

            // --- flush ---
            let changed: Vec<PathBuf> = dirty.drain().collect();
            first_event_at = None;
            last_event_at = None;

            // scan root disappeared: wipe the tree and stop watching
            if !root.exists() {
                let st = app.state::<AppState>();
                let mut tree = st.tree.lock();
                if tree.root_path == root {
                    let all: Vec<u64> = tree.nodes.keys().copied().collect();
                    let old_size = tree
                        .root_id
                        .and_then(|id| tree.nodes.get(&id))
                        .map(|n| n.size)
                        .unwrap_or(0);
                    tree.nodes.clear();
                    tree.dir_paths.clear();
                    tree.root_id = None;
                    let rid = tree.root_id.unwrap_or(0);
                    let _ = app.emit(
                        "tree-update",
                        TreeUpdateEvent {
                            root_id: rid,
                            nodes: Vec::new(),
                            removed_ids: all,
                            root_size_delta: -(old_size as i64),
                        },
                    );
                }
                break;
            }

            // map each changed path to the deepest scanned dir ancestor
            let mut targets: Vec<PathBuf> = Vec::new();
            {
                let st = app.state::<AppState>();
                let tree = st.tree.lock();
                for p in &changed {
                    let mut cur: Option<PathBuf> = Some(p.clone());
                    let mut found: Option<PathBuf> = None;
                    while let Some(c) = cur {
                        if let Some(id) = tree.dir_paths.get(&c) {
                            if let Some(n) = tree.nodes.get(id) {
                                if n.is_dir {
                                    found = Some(c.clone());
                                    break;
                                }
                            }
                        }
                        if c == root {
                            break;
                        }
                        cur = c.parent().map(|x| x.to_path_buf());
                    }
                    if let Some(f) = found {
                        if !targets.contains(&f) {
                            targets.push(f);
                        }
                    }
                }
            }

            // drop targets nested inside other targets
            targets.sort_by_key(|t| t.components().count());
            let mut final_targets: Vec<PathBuf> = Vec::new();
            for t in targets {
                if !final_targets.iter().any(|a: &PathBuf| t.starts_with(a)) {
                    final_targets.push(t);
                }
            }

            if final_targets.is_empty() {
                continue;
            }

            let _ = app.emit(
                "fs-events",
                FsEventsPayload {
                    affected_roots: final_targets
                        .iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect(),
                },
            );

            // serialized subtree rescans, one at a time under the tree lock
            for t in final_targets {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                let st = app.state::<AppState>();
                let empty = {
                    let mut tree = st.tree.lock();
                    rescan_subtree(&app, &mut tree, &t, false, &st.next_id)
                };
                if empty {
                    return;
                }
            }
        }
    });
}
