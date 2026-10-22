//! Earlier versions of project files, kept in the app's data folder (never in the project).
//! One folder per file, one `<milliseconds>.txt` per version holding the text as it was before a write.
use std::fs;
use std::path::{Path, PathBuf};

const GAP_MS: u64 = 5 * 60 * 1000; // typing and auto save: one version per file per 5 minutes
const KEEP: usize = 50;
const KEEP_AGENT: usize = 15; // versions from outside edits (an agent, another program) are kept apart, so their volume never pushes the writer's out
const MAX_AGE_MS: u64 = 30 * 24 * 3600 * 1000;

/// A stable folder name for a path (FNV-1a), so the project path never shows up on disk as a tree.
fn slot(root: &str, rel: &str) -> String {
    let h = root.bytes().chain([0]).chain(rel.bytes()).fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{h:016x}")
}

/// The times (ms) of the versions of `rel`, newest first.
pub fn list(base: &Path, root: &str, rel: &str) -> Vec<u64> {
    entries(base, root, rel).into_iter().map(|(t, _)| t).collect()
}

/// The versions of `rel`, newest first, each with whether an outside edit made it (`<ms>.agent.txt`).
fn entries(base: &Path, root: &str, rel: &str) -> Vec<(u64, bool)> {
    let mut v: Vec<(u64, bool)> = fs::read_dir(base.join(slot(root, rel))).into_iter().flatten().flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let stem = name.strip_suffix(".txt")?;
            match stem.strip_suffix(".agent") {
                Some(t) => Some((t.parse().ok()?, true)),
                None => Some((stem.parse().ok()?, false)),
            }
        }).collect();
    v.sort_unstable_by(|a, b| b.cmp(a));
    v
}

pub fn read(base: &Path, root: &str, rel: &str, at: u64) -> Option<String> {
    let dir = base.join(slot(root, rel));
    fs::read_to_string(dir.join(format!("{at}.txt"))).or_else(|_| fs::read_to_string(dir.join(format!("{at}.agent.txt")))).ok()
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
/// `outside`: the text was replaced by someone else (an agent): it is kept, but at most `KEEP_AGENT` of those.
/// Returns whether a version was written.
pub fn record(base: &Path, root: &str, rel: &str, old: &str, now: u64, force: bool, outside: bool) -> bool {
    let dir: PathBuf = base.join(slot(root, rel));
    let newest = list(base, root, rel).first().copied();
    if old.is_empty() || newest.is_some_and(|t| (!force && now.saturating_sub(t) < GAP_MS) || read(base, root, rel, t).as_deref() == Some(old)) {
        return false;
    }
    let _ = fs::remove_file(dir.join(if outside { format!("{now}.txt") } else { format!("{now}.agent.txt") })); // one version per millisecond
    if fs::create_dir_all(&dir).and_then(|()| fs::write(dir.join(if outside { format!("{now}.agent.txt") } else { format!("{now}.txt") }), old)).is_err() {
        return false; // history is a bonus: never fail the writer's save over it
    }
    let (mut mine, mut theirs) = (0, 0);
    for (t, agent) in entries(base, root, rel) {
        let n = if agent { &mut theirs } else { &mut mine };
        *n += 1;
        if *n > if agent { KEEP_AGENT } else { KEEP } || now.saturating_sub(t) > MAX_AGE_MS {
            let _ = fs::remove_file(dir.join(if agent { format!("{t}.agent.txt") } else { format!("{t}.txt") }));
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
        assert!(record(&b, "/p", "a.typ", "one", t0, false, false));
        assert!(!record(&b, "/p", "a.typ", "two", t0 + 60_000, false, false), "inside 5 minutes");
        assert!(record(&b, "/p", "a.typ", "two", t0 + 60_000, true, false), "forced");
        assert!(!record(&b, "/p", "a.typ", "two", t0 + 600_000, false, false), "same as newest");
        assert!(!record(&b, "/p", "a.typ", "", t0 + 600_000, true, false), "empty");
        assert!(record(&b, "/p", "a.typ", "three", t0 + 600_000, false, false));
        assert_eq!(list(&b, "/p", "a.typ"), vec![t0 + 600_000, t0 + 60_000, t0]);
        assert_eq!(read(&b, "/p", "a.typ", t0).as_deref(), Some("one"));
        assert!(list(&b, "/p", "b.typ").is_empty() && list(&b, "/q", "a.typ").is_empty());
        // count cap
        for i in 0..60u64 {
            record(&b, "/p", "c.typ", &format!("v{i}"), t0 + i * GAP_MS, false, false);
        }
        assert_eq!(list(&b, "/p", "c.typ").len(), KEEP);
        // age cap: a version 31 days old goes at the next write
        record(&b, "/p", "d.typ", "old", t0, false, false);
        record(&b, "/p", "d.typ", "new", t0 + 31 * 24 * 3600 * 1000, false, false);
        assert_eq!(list(&b, "/p", "d.typ"), vec![t0 + 31 * 24 * 3600 * 1000]);
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn agent_volume_keeps_the_writers_versions() {
        let b = tmp("agent");
        let t0 = 1_000_000_000_000;
        for i in 0..3u64 {
            record(&b, "/p", "a.typ", &format!("mine{i}"), t0 + i * GAP_MS, false, false);
        }
        for i in 0..60u64 {
            record(&b, "/p", "a.typ", &format!("agent{i}"), t0 + 4 * GAP_MS + i * 2000, true, true);
        }
        let texts: Vec<String> = list(&b, "/p", "a.typ").into_iter().filter_map(|t| read(&b, "/p", "a.typ", t)).collect();
        assert_eq!(texts.iter().filter(|s| s.starts_with("mine")).count(), 3, "the writer's versions stay");
        assert_eq!(texts.iter().filter(|s| s.starts_with("agent")).count(), KEEP_AGENT);
        assert_eq!(texts[0], "agent59", "the newest agent version is kept");
        // the age limit still applies to both kinds
        record(&b, "/p", "a.typ", "late", t0 + 31 * 24 * 3600 * 1000, false, false);
        assert_eq!(list(&b, "/p", "a.typ").len(), 1);
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn history_follows_a_rename() {
        let b = tmp("moved");
        record(&b, "/p", "a.typ", "one", 5, true, false);
        record(&b, "/p", "b.typ", "stale", 6, true, false);
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
                record(&b, "/p", name, &format!("{body}{i}"), t0 + i * step, false, false);
            }
        }
        let bytes = |n: &str| list(&b, "/p", n).iter().map(|t| read(&b, "/p", n, *t).unwrap().len()).sum::<usize>();
        eprintln!("MEASURE every 10 s: {} versions, {} bytes", list(&b, "/p", "a.typ").len(), bytes("a.typ"));
        eprintln!("MEASURE every 60 s: {} versions, {} bytes", list(&b, "/p", "b.typ").len(), bytes("b.typ"));
        eprintln!("MEASURE 1000 record calls took {:?}", started.elapsed());
        let _ = fs::remove_dir_all(&b);
    }
}
