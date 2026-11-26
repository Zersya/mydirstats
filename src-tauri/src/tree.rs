use crate::scanner::{
    cat_from_index, children_map, walk_tree, NodeId, NodePayload, ScanCompleteEvent, ScanOutput,
    ScanStats, CAT_INDEX,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Compact tree node: name + parent linkage only, no PathBuf.
pub struct TNode {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    pub name: String,
    pub is_dir: bool,
    pub is_bundle: bool,
    pub is_symlink: bool,
    pub inaccessible: bool,
    pub size: u64,
    pub file_count: u64,
    pub cat: u8,
    pub cat_bytes: [u64; CAT_INDEX],
    pub children: Vec<NodeId>,
    pub mtime: i64,
    /// user expanded this dir via expand_dir: leaf children emitted individually
    pub expanded: bool,
    /// id of the aggregate pseudo-node standing in for small leaf children
    pub aggregate_id: Option<NodeId>,
}

pub struct Tree {
    pub nodes: HashMap<NodeId, TNode>,
    /// directory path -> node id (dirs only, incl. bundles); watcher targeting
    pub dir_paths: HashMap<PathBuf, NodeId>,
    pub root_id: Option<NodeId>,
    pub root_path: PathBuf,
    /// file bucketing threshold
    pub tf: u64,
    /// subtree collapse threshold
    pub ts: u64,
}

impl Tree {
    pub fn new() -> Self {
        Tree {
            nodes: HashMap::new(),
            dir_paths: HashMap::new(),
            root_id: None,
            root_path: PathBuf::new(),
            tf: 256 * 1024,
            ts: 8 * 1024 * 1024,
        }
    }

    pub fn build(&mut self, out: &ScanOutput, root_path: &Path) {
        self.nodes.clear();
        self.dir_paths.clear();
        self.root_path = root_path.to_path_buf();
        self.tf = out.tf;
        self.ts = out.ts;
        let entries = &out.result.entries;
        self.root_id = Some(entries[out.root_idx as usize].id);

        let kids = &out.kids;
        for (idx, e) in entries.iter().enumerate() {
            let is_plain_dir = e.is_dir() && !e.is_bundle() && !e.is_symlink();
            let child_ids: Vec<NodeId> = kids
                .get(&(idx as u32))
                .map(|v| v.iter().map(|&c| entries[c as usize].id).collect())
                .unwrap_or_default();
            let cat_bytes = out
                .result
                .dir_cat
                .get(&(idx as u32))
                .copied()
                .unwrap_or([0; CAT_INDEX]);
            let parent = if e.parent != crate::scanner::NO_PARENT {
                Some(entries[e.parent as usize].id)
            } else {
                None
            };
            if e.is_dir() && !e.path.as_os_str().is_empty() {
                self.dir_paths.insert(e.path.clone(), e.id);
            }
            self.nodes.insert(
                e.id,
                TNode {
                    id: e.id,
                    parent,
                    name: e.name.clone(),
                    is_dir: e.is_dir(),
                    is_bundle: e.is_bundle(),
                    is_symlink: e.is_symlink(),
                    inaccessible: e.inaccessible(),
                    size: e.size,
                    file_count: e.file_count,
                    cat: e.cat,
                    cat_bytes,
                    children: if is_plain_dir { child_ids } else { Vec::new() },
                    mtime: e.mtime,
                    expanded: false,
                    aggregate_id: None,
                },
            );
        }
    }

    pub fn reconstruct_path(&self, id: NodeId) -> Option<PathBuf> {
        let mut parts: Vec<&str> = Vec::new();
        let mut cur = Some(id);
        while let Some(cid) = cur {
            let n = self.nodes.get(&cid)?;
            if Some(cid) == self.root_id {
                let mut p = self.root_path.clone();
                for part in parts.iter().rev() {
                    p.push(part);
                }
                return Some(p);
            }
            parts.push(&n.name);
            cur = n.parent;
        }
        None
    }

    pub fn subtree_ids(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack = vec![id];
        while let Some(cur) = stack.pop() {
            out.push(cur);
            if let Some(n) = self.nodes.get(&cur) {
                for c in &n.children {
                    stack.push(*c);
                }
            }
        }
        out
    }

    /// ids currently present frontend-side within the subtree at `id`,
    /// replicating emission rules exactly (v3: subtree collapse + bucketing
    /// + expand_dir detail ids).
    pub fn frontend_ids(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let tf = self.tf;
        let ts = self.ts;
        // iterative DFS following visibility rules
        let mut stack: Vec<(NodeId, bool)> = vec![(id, true)]; // (node, is-subtree-root)
        while let Some((nid, is_root)) = stack.pop() {
            let n = match self.nodes.get(&nid) {
                Some(n) => n,
                None => continue,
            };
            let is_plain_dir = n.is_dir && !n.is_bundle && !n.is_symlink;
            if !is_plain_dir {
                out.push(nid);
                continue;
            }
            // the dir node itself is always emitted (even collapsed)
            out.push(nid);
            let collapsed = !is_root && !n.expanded && n.size < ts;
            if collapsed {
                continue; // descendants invisible
            }
            if !n.expanded {
                if let Some(agg) = n.aggregate_id {
                    out.push(agg);
                }
            }
            for &c in &n.children {
                if let Some(cn) = self.nodes.get(&c) {
                    let cleaf = !cn.is_dir || cn.is_bundle || cn.is_symlink;
                    if cleaf {
                        if n.expanded || cn.size >= tf {
                            out.push(c);
                        }
                    } else {
                        stack.push((c, false));
                    }
                }
            }
        }
        out
    }

    pub fn propagate_delta(
        &mut self,
        start: Option<NodeId>,
        size_d: i64,
        fc_d: i64,
        cat_d: &[i64; CAT_INDEX],
    ) {
        let mut cur = start;
        while let Some(id) = cur {
            let parent = {
                let n = match self.nodes.get_mut(&id) {
                    Some(n) => n,
                    None => break,
                };
                n.size = (n.size as i64 + size_d).max(0) as u64;
                n.file_count = (n.file_count as i64 + fc_d).max(0) as u64;
                for k in 0..CAT_INDEX {
                    n.cat_bytes[k] = (n.cat_bytes[k] as i64 + cat_d[k]).max(0) as u64;
                }
                let mut best = 0usize;
                for k in 1..CAT_INDEX {
                    if n.cat_bytes[k] > n.cat_bytes[best] {
                        best = k;
                    }
                }
                n.cat = best as u8;
                n.parent
            };
            cur = parent;
        }
    }
}

/// payload for one real tree node. `visible_children`: ids the frontend may
/// link (only meaningful for emitted-expanded dirs).
fn node_payload(
    n: &TNode,
    children: Option<Vec<NodeId>>,
    has_hidden: bool,
) -> NodePayload {
    NodePayload {
        id: n.id,
        parent_id: n.parent,
        name: n.name.clone(),
        is_dir: n.is_dir,
        is_bundle: n.is_bundle,
        is_symlink: n.is_symlink,
        is_aggregate: false,
        size: n.size,
        file_count: n.file_count,
        category: cat_from_index(n.cat as usize),
        inaccessible: n.inaccessible,
        children,
        mtime: n.mtime,
        has_hidden_children: has_hidden,
    }
}

/// Emit the visible subtree at `root` following v3 significance rules.
/// If `skip_root` is set, the root node's own payload is omitted (dir-detail).
/// Allocates/persists aggregate pseudo-ids in the tree. Expansion hints in
/// `force_expanded` (relative-path matched) are applied.
pub fn emit_visible(
    tree: &mut Tree,
    root: NodeId,
    skip_root: bool,
    next_id: &Arc<AtomicU64>,
) -> Vec<NodePayload> {
    let tf = tree.tf;
    let ts = tree.ts;
    let scan_root = tree.root_id;
    let mut out: Vec<NodePayload> = Vec::new();

    // DFS preorder: dir payload, then leaves/bucket, then child dirs
    struct Frame {
        id: NodeId,
        is_root: bool,
    }
    let mut stack: Vec<Frame> = vec![Frame {
        id: root,
        is_root: true,
    }];

    while let Some(Frame { id, is_root }) = stack.pop() {
        // clone the small bits we need (avoid borrow conflicts with tree mutation)
        let (n_parent, n_name, n_isdir, n_isbundle, n_issymlink, n_inacc, n_size, n_fc, n_cat, n_mtime, n_expanded, n_agg, n_children) = {
            let n = match tree.nodes.get(&id) {
                Some(n) => n,
                None => continue,
            };
            (
                n.parent,
                n.name.clone(),
                n.is_dir,
                n.is_bundle,
                n.is_symlink,
                n.inaccessible,
                n.size,
                n.file_count,
                n.cat,
                n.mtime,
                n.expanded,
                n.aggregate_id,
                n.children.clone(),
            )
        };
        let is_plain_dir = n_isdir && !n_isbundle && !n_issymlink;

        if !is_plain_dir {
            out.push(NodePayload {
                id,
                parent_id: n_parent,
                name: n_name,
                is_dir: n_isdir,
                is_bundle: n_isbundle,
                is_symlink: n_issymlink,
                is_aggregate: false,
                size: n_size,
                file_count: n_fc,
                category: cat_from_index(n_cat as usize),
                inaccessible: n_inacc,
                children: None,
                mtime: n_mtime,
                has_hidden_children: false,
            });
            continue;
        }

        let collapsed = !is_root && !n_expanded && Some(id) != scan_root && n_size < ts;

        if collapsed {
            if !skip_root || !is_root {
                out.push(NodePayload {
                    id,
                    parent_id: n_parent,
                    name: n_name,
                    is_dir: true,
                    is_bundle: false,
                    is_symlink: false,
                    is_aggregate: false,
                    size: n_size,
                    file_count: n_fc,
                    category: cat_from_index(n_cat as usize),
                    inaccessible: n_inacc,
                    children: None,
                    mtime: n_mtime,
                    has_hidden_children: !n_children.is_empty(),
                });
            }
            continue; // descendants not emitted
        }

        // expanded dir: partition children
        let mut child_ids: Vec<NodeId> = Vec::new();
        let mut leaf_payloads: Vec<NodePayload> = Vec::new();
        let mut dir_children: Vec<NodeId> = Vec::new();
        let mut bucket_count = 0u64;
        let mut bucket_bytes = 0u64;
        let mut bucket_cat = [0u64; CAT_INDEX];

        for &c in &n_children {
            let cn = match tree.nodes.get(&c) {
                Some(cn) => cn,
                None => continue,
            };
            let cleaf = !cn.is_dir || cn.is_bundle || cn.is_symlink;
            if cleaf {
                child_ids.push(c);
                if n_expanded {
                    leaf_payloads.push(node_payload(cn, None, false));
                } else if cn.size >= tf {
                    leaf_payloads.push(node_payload(cn, None, false));
                } else {
                    bucket_count += 1;
                    bucket_bytes += cn.size;
                    bucket_cat[cn.cat as usize] += cn.size;
                }
            } else {
                child_ids.push(c);
                dir_children.push(c);
            }
        }

        let mut has_hidden = false;
        if bucket_count > 0 && !n_expanded {
            has_hidden = true;
            let agg = match n_agg {
                Some(a) => a,
                None => {
                    let a = next_id.fetch_add(1, Ordering::Relaxed);
                    if let Some(n) = tree.nodes.get_mut(&id) {
                        n.aggregate_id = Some(a);
                    }
                    a
                }
            };
            let mut best = 0usize;
            for k in 1..CAT_INDEX {
                if bucket_cat[k] > bucket_cat[best] {
                    best = k;
                }
            }
            child_ids.push(agg);
            leaf_payloads.push(NodePayload {
                id: agg,
                parent_id: Some(id),
                name: format!("{} small files", bucket_count),
                is_dir: false,
                is_bundle: false,
                is_symlink: false,
                is_aggregate: true,
                size: bucket_bytes,
                file_count: bucket_count,
                category: cat_from_index(best),
                inaccessible: false,
                children: None,
                mtime: 0,
                has_hidden_children: false,
            });
        }

        if !skip_root || !is_root {
            out.push(NodePayload {
                id,
                parent_id: n_parent,
                name: n_name,
                is_dir: true,
                is_bundle: false,
                is_symlink: false,
                is_aggregate: false,
                size: n_size,
                file_count: n_fc,
                category: cat_from_index(n_cat as usize),
                inaccessible: n_inacc,
                children: Some(child_ids),
                mtime: n_mtime,
                has_hidden_children: has_hidden,
            });
        } else {
            // skip_root (dir-detail): the child payloads still need correct
            // parentage — already set via parent ids, nothing to do
        }

        out.extend(leaf_payloads);
        for d in dir_children.iter().rev() {
            stack.push(Frame {
                id: *d,
                is_root: false,
            });
        }
    }

    out
}

// ---------- scan-completion emission (v3) ----------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanNodesEvent {
    scan_id: u64,
    nodes: Vec<NodePayload>,
    #[serde(rename = "final")]
    final_flag: bool,
}

/// After a scan's tree is built: stream the visible tree top-down in
/// scan-nodes batches, then emit scan-complete.
pub fn emit_scan_tree(
    app: &AppHandle,
    scan_id: u64,
    tree: &mut Tree,
    out_stats: (u64, u64, u64, u64, u64), // total_bytes, files, dirs, inaccessible_unknown, duration_ms
    next_id: &Arc<AtomicU64>,
) {
    let root_id = match tree.root_id {
        Some(r) => r,
        None => return,
    };
    let payloads = emit_visible(tree, root_id, false, next_id);

    let total = payloads.len();
    let chunk = 4000usize;
    let min_interval = Duration::from_millis(50);
    let mut sent = 0usize;
    let mut last = Instant::now() - min_interval;
    while sent < total {
        let end = (sent + chunk).min(total);
        let batch: Vec<NodePayload> = payloads[sent..end].to_vec();
        let fin = end == total;
        let _ = app.emit(
            "scan-nodes",
            ScanNodesEvent {
                scan_id,
                nodes: batch,
                final_flag: fin,
            },
        );
        sent = end;
        if !fin {
            let elapsed = last.elapsed();
            if elapsed < min_interval {
                std::thread::sleep(min_interval - elapsed);
            }
            last = Instant::now();
        }
    }
    if total == 0 {
        let _ = app.emit(
            "scan-nodes",
            ScanNodesEvent {
                scan_id,
                nodes: Vec::new(),
                final_flag: true,
            },
        );
    }

    let root_name = tree
        .nodes
        .get(&root_id)
        .map(|n| n.name.clone())
        .unwrap_or_default();
    let _ = app.emit(
        "scan-complete",
        ScanCompleteEvent {
            scan_id,
            root_id,
            root_name,
            stats: ScanStats {
                total_bytes: out_stats.0,
                total_files: out_stats.1,
                total_dirs: out_stats.2,
                inaccessible_unknown_count: out_stats.3,
                duration_ms: out_stats.4,
            },
        },
    );
}

// ---------- tree-update (rescans / expand_bundle) ----------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeUpdateEvent {
    pub root_id: NodeId,
    pub nodes: Vec<NodePayload>,
    pub removed_ids: Vec<NodeId>,
    pub root_size_delta: i64,
}

/// Rescan the subtree at `target_path`, re-aggregate per v3 rules, emit tree-update.
/// Returns true if the scan root itself disappeared.
pub fn rescan_subtree(
    app: &AppHandle,
    tree: &mut Tree,
    target_path: &Path,
    expand_root: bool,
    next_id: &Arc<AtomicU64>,
) -> bool {
    let existing_id = tree.dir_paths.get(target_path).copied();
    let existing = existing_id.and_then(|id| {
        let n = tree.nodes.get(&id)?;
        Some((n.parent, n.size, n.file_count, n.cat_bytes, n.is_bundle))
    });

    let old_size = existing.map(|e| e.1).unwrap_or(0);
    let old_fc = existing.map(|e| e.2).unwrap_or(0);
    let old_cat_bytes = existing.map(|e| e.3).unwrap_or([0; CAT_INDEX]);
    let parent_id = existing.and_then(|e| e.0);

    let old_frontend_ids: Vec<NodeId> = existing_id
        .map(|id| tree.frontend_ids(id))
        .unwrap_or_default();

    // expansion preservation: collect expanded dir paths relative to target
    let mut expanded_rel: HashSet<Vec<String>> = HashSet::new();
    if let Some(id) = existing_id {
        for nid in tree.subtree_ids(id) {
            if let Some(n) = tree.nodes.get(&nid) {
                if n.expanded && nid != id {
                    // build relative path
                    let mut parts: Vec<String> = Vec::new();
                    let mut cur = Some(nid);
                    while let Some(cid) = cur {
                        if cid == id {
                            break;
                        }
                        match tree.nodes.get(&cid) {
                            Some(nn) => {
                                parts.push(nn.name.clone());
                                cur = nn.parent;
                            }
                            None => break,
                        }
                    }
                    if cur == Some(id) {
                        parts.reverse();
                        expanded_rel.insert(parts);
                    }
                }
            }
        }
    }

    let was_expanded = existing_id
        .and_then(|id| tree.nodes.get(&id))
        .map(|n| n.is_dir && !n.is_bundle && crate::scanner::is_bundle_name(&n.name))
        .unwrap_or(false);
    let expand = expand_root || was_expanded;
    // target root keeps expanded state too
    let root_was_expanded = existing_id
        .and_then(|id| tree.nodes.get(&id))
        .map(|n| n.expanded)
        .unwrap_or(false);

    let result = walk_tree(target_path, expand, next_id, None, |_| {});
    let root_idx = result.root_index;

    if result.entries.is_empty() || root_idx.is_none() {
        let id = match existing_id {
            Some(id) => id,
            None => return tree.nodes.is_empty(),
        };
        for rid in tree.subtree_ids(id) {
            tree.nodes.remove(&rid);
        }
        tree.dir_paths.retain(|p, _| !p.starts_with(target_path));
        if let Some(pid) = parent_id {
            if let Some(p) = tree.nodes.get_mut(&pid) {
                p.children.retain(|c| *c != id);
            }
        }
        let mut cat_d = [0i64; CAT_INDEX];
        for k in 0..CAT_INDEX {
            cat_d[k] = -(old_cat_bytes[k] as i64);
        }
        tree.propagate_delta(parent_id, -(old_size as i64), -(old_fc as i64), &cat_d);
        let was_root = tree.root_id == Some(id);
        if was_root {
            tree.root_id = None;
        }
        let _ = app.emit(
            "tree-update",
            TreeUpdateEvent {
                root_id: id,
                nodes: Vec::new(),
                removed_ids: old_frontend_ids,
                root_size_delta: -(old_size as i64),
            },
        );
        return tree.nodes.is_empty() || was_root;
    }

    let root_idx = root_idx.unwrap() as u32;
    let kids = children_map(&result.entries);
    let mut entries = result.entries;
    if let Some(keep) = existing_id {
        entries[root_idx as usize].id = keep;
    }
    let new_root_id = entries[root_idx as usize].id;

    let removed_ids: Vec<NodeId> = old_frontend_ids
        .iter()
        .copied()
        .filter(|x| *x != new_root_id)
        .collect();

    if let Some(id) = existing_id {
        for rid in tree.subtree_ids(id) {
            if rid != new_root_id {
                tree.nodes.remove(&rid);
            }
        }
    }
    tree.dir_paths.retain(|p, _| !p.starts_with(target_path));

    // insert new nodes, restoring expansion state by relative path
    for (idx, e) in entries.iter().enumerate() {
        let is_plain_dir = e.is_dir() && !e.is_bundle() && !e.is_symlink();
        let child_ids: Vec<NodeId> = kids
            .get(&(idx as u32))
            .map(|v| v.iter().map(|&c| entries[c as usize].id).collect())
            .unwrap_or_default();
        let cat_bytes = result
            .dir_cat
            .get(&(idx as u32))
            .copied()
            .unwrap_or([0; CAT_INDEX]);
        let parent = if idx as u32 == root_idx {
            parent_id
        } else if e.parent != crate::scanner::NO_PARENT {
            Some(entries[e.parent as usize].id)
        } else {
            parent_id
        };
        if e.is_dir() && !e.path.as_os_str().is_empty() {
            tree.dir_paths.insert(e.path.clone(), e.id);
        }
        // expansion restore: build relative path lazily only when needed
        let mut expanded = false;
        if is_plain_dir && !expanded_rel.is_empty() {
            // walk up entries to build rel path
            let mut parts: Vec<String> = Vec::new();
            let mut cur = idx as u32;
            while cur != root_idx {
                parts.push(entries[cur as usize].name.clone());
                let p = entries[cur as usize].parent;
                if p == crate::scanner::NO_PARENT {
                    break;
                }
                cur = p;
            }
            if cur == root_idx {
                parts.reverse();
                expanded = expanded_rel.contains(&parts);
            }
        }
        if idx as u32 == root_idx && root_was_expanded {
            expanded = true;
        }
        tree.nodes.insert(
            e.id,
            TNode {
                id: e.id,
                parent,
                name: e.name.clone(),
                is_dir: e.is_dir(),
                is_bundle: e.is_bundle(),
                is_symlink: e.is_symlink(),
                inaccessible: e.inaccessible(),
                size: e.size,
                file_count: e.file_count,
                cat: e.cat,
                cat_bytes,
                children: if is_plain_dir { child_ids } else { Vec::new() },
                mtime: e.mtime,
                expanded,
                aggregate_id: None,
            },
        );
    }

    if let Some(pid) = parent_id {
        if let Some(p) = tree.nodes.get_mut(&pid) {
            if !p.children.contains(&new_root_id) {
                p.children.push(new_root_id);
            }
        }
    }

    let new_size = entries[root_idx as usize].size;
    let new_fc = entries[root_idx as usize].file_count;
    let size_d = new_size as i64 - old_size as i64;
    let fc_d = new_fc as i64 - old_fc as i64;
    let mut cat_d = [0i64; CAT_INDEX];
    let new_cb = result
        .dir_cat
        .get(&root_idx)
        .copied()
        .unwrap_or_else(|| {
            let mut cb = [0u64; CAT_INDEX];
            cb[entries[root_idx as usize].cat as usize] = new_size;
            cb
        });
    for k in 0..CAT_INDEX {
        cat_d[k] = new_cb[k] as i64 - old_cat_bytes[k] as i64;
    }
    tree.propagate_delta(parent_id, size_d, fc_d, &cat_d);

    // emit replacement nodes per v3 visibility, patching root parentId
    let mut payloads = emit_visible(tree, new_root_id, false, next_id);
    if let Some(first) = payloads.iter_mut().find(|p| p.id == new_root_id) {
        first.parent_id = parent_id;
    }

    let _ = app.emit(
        "tree-update",
        TreeUpdateEvent {
            root_id: new_root_id,
            nodes: payloads,
            removed_ids,
            root_size_delta: size_d,
        },
    );
    false
}
