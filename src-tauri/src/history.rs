//! Earlier versions of project files, kept in the app's data folder (never in the project).
//! One folder per file, one `<milliseconds>.txt` per version holding the text as it was before a write.
use std::fs;
use std::path::{Path, PathBuf};

const GAP_MS: u64 = 5 * 60 * 1000; // typing and auto save: one version per file per 5 minutes
const KEEP: usize = 50;
const MAX_AGE_MS: u64 = 30 * 24 * 3600 * 1000;

/// A stable folder name for a path (FNV-1a), so the project path never shows up on disk as a tree.
fn slot(root: &str, rel: &str) -> String {
    let h = root.bytes().chain([0]).chain(rel.bytes()).fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{h:016x}")
}

/// The times (ms) of the versions of `rel`, newest first.
pub fn list(base: &Path, root: &str, rel: &str) -> Vec<u64> {
    let mut v: Vec<u64> = fs::read_dir(base.join(slot(root, rel))).into_iter().flatten().flatten()
        .filter_map(|e| e.file_name().to_str()?.strip_suffix(".txt")?.parse().ok()).collect();
    v.sort_unstable_by(|a, b| b.cmp(a));
    v
}

pub fn read(base: &Path, root: &str, rel: &str, at: u64) -> Option<String> {
    fs::read_to_string(base.join(slot(root, rel)).join(format!("{at}.txt"))).ok()
}

/// The history of `from` becomes the history of `to` (the file was renamed or moved).
pub fn moved(base: &Path, root: &str, from: &str, to: &str) {
    let (src, dst) = (base.join(slot(root, from)), base.join(slot(root, to)));
    if src.is_dir() {
        let _ = fs::remove_dir_all(&dst); // older than the file that now has this name
        let _ = fs::rename(&src, &dst);
    }
}

/// Keeps `old` (the text a write is about to replace) as a version. `force` skips the 5 minute gap
/// (before a multi-file change or a restore). Same text as the newest version, or an empty file: nothing.
/// Returns whether a version was written.
pub fn record(base: &Path, root: &str, rel: &str, old: &str, now: u64, force: bool) -> bool {
    let dir: PathBuf = base.join(slot(root, rel));
    let newest = list(base, root, rel).first().copied();
    if old.is_empty() || newest.is_some_and(|t| (!force && now.saturating_sub(t) < GAP_MS) || read(base, root, rel, t).as_deref() == Some(old)) {
        return false;
    }
    if fs::create_dir_all(&dir).and_then(|()| fs::write(dir.join(format!("{now}.txt")), old)).is_err() {
        return false; // history is a bonus: never fail the writer's save over it
    }
    for (i, t) in list(base, root, rel).into_iter().enumerate() {
        if i >= KEEP || now.saturating_sub(t) > MAX_AGE_MS {
            let _ = fs::remove_file(dir.join(format!("{t}.txt")));
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("quire-history-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn throttle_force_dedupe_and_prune() {
        let b = tmp("rules");
        let t0 = 1_000_000_000_000;
        assert!(record(&b, "/p", "a.typ", "one", t0, false));
        assert!(!record(&b, "/p", "a.typ", "two", t0 + 60_000, false), "inside 5 minutes");
        assert!(record(&b, "/p", "a.typ", "two", t0 + 60_000, true), "forced");
        assert!(!record(&b, "/p", "a.typ", "two", t0 + 600_000, false), "same as newest");
        assert!(!record(&b, "/p", "a.typ", "", t0 + 600_000, true), "empty");
        assert!(record(&b, "/p", "a.typ", "three", t0 + 600_000, false));
        assert_eq!(list(&b, "/p", "a.typ"), vec![t0 + 600_000, t0 + 60_000, t0]);
        assert_eq!(read(&b, "/p", "a.typ", t0).as_deref(), Some("one"));
        assert!(list(&b, "/p", "b.typ").is_empty() && list(&b, "/q", "a.typ").is_empty());
        // count cap
        for i in 0..60u64 {
            record(&b, "/p", "c.typ", &format!("v{i}"), t0 + i * GAP_MS, false);
        }
        assert_eq!(list(&b, "/p", "c.typ").len(), KEEP);
        // age cap: a version 31 days old goes at the next write
        record(&b, "/p", "d.typ", "old", t0, false);
        record(&b, "/p", "d.typ", "new", t0 + 31 * 24 * 3600 * 1000, false);
        assert_eq!(list(&b, "/p", "d.typ"), vec![t0 + 31 * 24 * 3600 * 1000]);
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn history_follows_a_rename() {
        let b = tmp("moved");
        record(&b, "/p", "a.typ", "one", 5, true);
        record(&b, "/p", "b.typ", "stale", 6, true);
        moved(&b, "/p", "a.typ", "b.typ");
        assert!(list(&b, "/p", "a.typ").is_empty());
        assert_eq!(list(&b, "/p", "b.typ"), vec![5]);
        assert_eq!(read(&b, "/p", "b.typ", 5).as_deref(), Some("one"));
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn five_hundred_saves_of_50kb() {
        let b = tmp("measure");
        let t0 = 1_000_000_000_000;
        let body = "word ".repeat(10_000); // 50 KB
        let started = std::time::Instant::now();
        // A: a save every 10 s (about 83 minutes of continuous typing). B: a save every minute (8 hours).
        for (name, step) in [("a.typ", 10_000u64), ("b.typ", 60_000)] {
            for i in 0..500u64 {
                record(&b, "/p", name, &format!("{body}{i}"), t0 + i * step, false);
            }
        }
        let bytes = |n: &str| list(&b, "/p", n).iter().map(|t| read(&b, "/p", n, *t).unwrap().len()).sum::<usize>();
        eprintln!("MEASURE every 10 s: {} versions, {} bytes", list(&b, "/p", "a.typ").len(), bytes("a.typ"));
        eprintln!("MEASURE every 60 s: {} versions, {} bytes", list(&b, "/p", "b.typ").len(), bytes("b.typ"));
        eprintln!("MEASURE 1000 record calls took {:?}", started.elapsed());
        let _ = fs::remove_dir_all(&b);
    }
}
