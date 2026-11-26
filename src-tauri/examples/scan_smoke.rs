// v3 smoke harness: times each scan phase against real data.
// Usage: cargo run --release --example scan_smoke -- <path>

use mydirstats_lib::scanner::{children_map, choose_thresholds, walk_tree, ScanOutput};
use mydirstats_lib::tree::{emit_visible, Tree};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| std::env::var("HOME").unwrap());
    println!("scanning {path} ...");
    let next_id = Arc::new(AtomicU64::new(1));

    let t0 = std::time::Instant::now();
    let mut count = 0u64;
    let result = walk_tree(std::path::Path::new(&path), false, &next_id, None, |_e| {
        count += 1;
    });
    let walk_t = t0.elapsed();
    println!("walk: {:?} — {} entries", walk_t, result.entries.len());

    let t1 = std::time::Instant::now();
    let kids = children_map(&result.entries);
    println!("children_map: {:?}", t1.elapsed());

    let root_idx = result.root_index.expect("root") as u32;
    let t2 = std::time::Instant::now();
    let (tf, ts) = choose_thresholds(&result.entries, root_idx);
    println!(
        "choose_thresholds: {:?} — tf {} bytes, ts {} bytes",
        t2.elapsed(),
        tf,
        ts
    );

    let out = ScanOutput {
        result,
        tf,
        ts,
        kids,
        root_idx,
    };

    let t3 = std::time::Instant::now();
    let mut tree = Tree::new();
    tree.build(&out, std::path::Path::new(&path));
    println!(
        "tree build: {:?} — {} nodes",
        t3.elapsed(),
        tree.nodes.len()
    );
    drop(out);

    let t4 = std::time::Instant::now();
    let root_id = tree.root_id.expect("root id");
    let payloads = emit_visible(&mut tree, root_id, false, &next_id);
    println!(
        "emit_visible: {:?} — {} payloads",
        t4.elapsed(),
        payloads.len()
    );

    let t5 = std::time::Instant::now();
    let mut bytes = 0usize;
    for chunk in payloads.chunks(4000) {
        bytes += serde_json::to_string(chunk).map(|s| s.len()).unwrap_or(0);
    }
    println!(
        "json serialize all payloads: {:?} — {:.1} MB total",
        t5.elapsed(),
        bytes as f64 / 1e6
    );

    if let Some(root) = tree.nodes.get(&root_id) {
        println!("root size: {:.2} GiB", root.size as f64 / 2f64.powi(30));
    }
}
