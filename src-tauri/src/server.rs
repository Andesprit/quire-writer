//! Local server: serves the editor, talks to the agent, watches the folder.
//! The page talks to it over one WebSocket with JSON messages.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, Stream, StreamExt};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{self, protocol::WebSocketConfig};
use tower_http::services::ServeDir;
use unicode_normalization::UnicodeNormalization;

use crate::agent::{find_agent, registry, BRIDGE};
use crate::lock;

const TEXT_EXT: [&str; 11] = ["typ", "bib", "yml", "yaml", "toml", "md", "txt", "csv", "json", "xml", "tex"];
const MAX_FILE: u64 = 2_000_000;
const DEFAULT_AGENT: &str = "claude-acp";

static CLIENTS: Mutex<Vec<UnboundedSender<String>>> = Mutex::new(Vec::new());
static PORT: OnceLock<u16> = OnceLock::new();
static WS: LazyLock<Mutex<Workspace>> = LazyLock::new(Mutex::default);

fn ws() -> MutexGuard<'static, Workspace> {
    lock(&WS)
}

pub fn send(msg: Value) {
    let text = msg.to_string();
    lock(&CLIENTS).retain(|tx| tx.send(text.clone()).is_ok());
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

fn err(e: std::io::Error) -> String {
    e.to_string()
}

fn is_text_ext(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| TEXT_EXT.contains(&e))
}

/// The file as text, with \r\n and \r turned into \n as the editor's text field does anyway.
fn read_text(p: &Path) -> Result<String, String> {
    let text = String::from_utf8(fs::read(p).map_err(err)?).map_err(|_| format!("{} is not UTF-8 text.", p.display()))?;
    Ok(if text.contains('\r') { text.replace("\r\n", "\n").replace('\r', "\n") } else { text })
}

/// Like Python's Path.resolve(): an absolute path with symlinks followed in the parts that exist.
fn resolve(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in std::path::absolute(p).unwrap_or(p.into()).components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => {
                out.push(c);
                if let Ok(real) = out.canonicalize() {
                    out = real;
                }
            }
        }
    }
    out
}

// Labels: <name> defines one; @name, ref(<name>), link(<name>) and show <name> use it.
static LABEL: LazyLock<Regex> = LazyLock::new(|| re(r"(\(\s*|,\s*|show\s+)?<([\w:.-]+)>"));
static REF: LazyLock<Regex> = LazyLock::new(|| re(r"@([\w-]+(?:[:.][\w-]+)*)"));
// Comments, raw text and math, where <...> and @... mean something else.
static HIDDEN: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?s)/\*.*?\*/|```.*?```|`[^`\n]*`|\$(?:[^$\\]|\\.)*\$|//[^\n]*"));

/// The regex crate has no look-behind, so it is checked here: a match that starts right after
/// `before` does not count, and the search goes on one character later.
fn find_not_after<'t>(r: &Regex, text: &'t str, mut pos: usize, before: impl Fn(char, &str) -> bool) -> Vec<regex::Captures<'t>> {
    let mut found = vec![];
    while let Some(c) = r.captures_at(text, pos) {
        let m = c.get(0).unwrap();
        if text[..m.start()].chars().next_back().is_some_and(|b| before(b, m.as_str())) {
            pos = m.start() + 1; // every pattern here starts with an ASCII character
        } else {
            pos = m.end();
            found.push(c);
        }
    }
    found
}

/// Blanks comments, raw text and math, keeping lines and columns.
fn blank_hidden(text: &str) -> String {
    // \$ is a dollar sign, and :// is part of a URL.
    let skip = |b: char, m: &str| (b == '\\' && m.starts_with('$')) || (b == ':' && m.starts_with("//"));
    let (mut out, mut at) = (String::with_capacity(text.len()), 0);
    for c in find_not_after(&HIDDEN, text, 0, skip) {
        let m = c.get(0).unwrap();
        out.push_str(&text[at..m.start()]);
        out.extend(m.as_str().chars().map(|ch| if ch == '\n' { '\n' } else { ' ' }));
        at = m.end();
    }
    out + &text[at..]
}

/// Every label defined in the .typ files, and how many times it is used.
fn labels(texts: &BTreeMap<String, String>) -> Vec<Value> {
    let (mut found, mut uses) = (vec![], HashMap::<String, u64>::new());
    for (rel, text) in texts.iter().filter(|(rel, _)| rel.ends_with(".typ")) {
        for (n, line) in blank_hidden(text).split('\n').enumerate() {
            // Not after a letter or a backslash: me@site.org and \@ are not references.
            for c in find_not_after(&REF, line, 0, |b, _| b.is_alphanumeric() || b == '_' || b == '\\') {
                *uses.entry(c[1].to_string()).or_default() += 1;
            }
            for c in LABEL.captures_iter(line) {
                if c.get(1).is_some() {
                    *uses.entry(c[2].to_string()).or_default() += 1;
                } else {
                    let col = line[..c.get(0).unwrap().start()].chars().count();
                    found.push((c[2].to_string(), rel.clone(), n, col));
                }
            }
        }
    }
    found
        .into_iter()
        .map(|(name, path, line, col)| {
            let refs = uses.get(&name).copied().unwrap_or(0);
            json!({"name": name, "path": path, "line": line, "col": col, "refs": refs})
        })
        .collect()
}

// Citations. arXiv gives every paper a DOI, so both go through doi.org.
static ARXIV: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)^(?:arxiv:\s*|https?://arxiv\.org/(?:abs|pdf)/)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})(?:v\d+)?(?:\.pdf)?$")
});
static BIB_KEY: LazyLock<Regex> = LazyLock::new(|| re(r"@\w+\s*\{\s*([^,\s]+)\s*,"));

fn doi_of(ident: &str) -> Result<String, String> {
    let s = ident.trim();
    if let Some(m) = ARXIV.captures(s) {
        return Ok(format!("10.48550/arXiv.{}", &m[1]));
    }
    let doi = re(r"(?i)^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)").replace(s, "");
    if re(r"^10\.\d{4,9}/\S+$").is_match(&doi) {
        return Ok(doi.into());
    }
    Err(format!("{s} is not a DOI or an arXiv ID."))
}

/// A key like lecun2015. The registries' own keys can be whole URLs, which @ cannot use.
fn cite_key(entry: &str, taken: &HashSet<String>) -> String {
    let author = re(r"(?i)\bauthor\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}").captures(entry);
    let first = author.as_ref().map_or("", |a| a.get(1).unwrap().as_str()).split(" and ").next().unwrap_or("");
    let last = if first.contains(',') { first.split(',').next().unwrap_or("") } else { first.split_whitespace().last().unwrap_or("") };
    let last: String = re(r"\\.|[{}]").replace_all(last, "").nfkd().collect(); // {\"u} and ü both become u
    let year = re(r"(?i)\byear\s*=\s*\{?\s*(\d{4})").captures(entry).map_or(String::new(), |y| y[1].to_string());
    let letters: String = last.to_lowercase().chars().filter(char::is_ascii_lowercase).collect();
    let base = if letters.is_empty() { "ref".to_string() } else { letters } + &year;
    let mut key = base.clone();
    for c in 'a'..='z' {
        if !taken.contains(&key) {
            break;
        }
        key = format!("{base}{c}");
    }
    key
}

/// Like Python's urllib.parse.quote: everything but letters, digits and _.-~/ as %XX.
fn quote(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"_.-~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// curl ships with macOS, so the app needs no TLS code of its own.
async fn fetch_bibtex(doi: &str) -> Result<String, String> {
    let url = format!("https://doi.org/{}", quote(doi));
    let accept = "Accept: application/x-bibtex; charset=utf-8";
    let out = Command::new("curl")
        .args(["-sS", "-L", "--max-time", "20", "-H", accept, "-w", "\n%{http_code}", &url])
        .output()
        .await
        .map_err(|e| format!("Could not run curl: {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        let why = why.trim().split_once(") ").map_or(why.trim(), |(_, w)| w); // drop "curl: (6) "
        return Err(format!("Could not reach doi.org ({why}). Check your internet connection."));
    }
    let body = String::from_utf8_lossy(&out.stdout);
    let (body, code) = body.rsplit_once('\n').unwrap_or(("", &body));
    match code {
        c if c.starts_with('2') => Ok(body.into()),
        "404" => Err(format!("No paper found for {doi}.")),
        c => Err(format!("doi.org answered {c} for {doi}.")),
    }
}

/// The open folder. Every change made outside the editor (by the agent, or any other
/// program) becomes a change the writer reviews.
#[derive(Default)]
pub struct Workspace {
    root: Option<PathBuf>,
    known: BTreeMap<String, String>,    // last content the editor and disk agreed on
    baseline: BTreeMap<String, String>, // content before unreviewed changes
    turn: u64,
    checkpoints: BTreeMap<u64, BTreeMap<String, Option<String>>>, // turn -> {path: content before it}
    watcher: Option<(RecommendedWatcher, JoinHandle<()>)>,
    preview_proc: Option<Child>,
    control: Option<UnboundedSender<String>>, // tinymist's editor connection
    preview_shown: bool,
    preview_id: u64, // which preview is the current one
}

/// Move (or drop, when `to` is None) every key at or under `rel`.
fn move_keys<V>(d: &mut BTreeMap<String, V>, rel: &str, to: Option<&str>) {
    let under = format!("{rel}/");
    let keys: Vec<String> = d.keys().filter(|k| *k == rel || k.starts_with(&under)).cloned().collect();
    for k in keys {
        let v = d.remove(&k).unwrap();
        if let Some(to) = to {
            d.insert(format!("{to}{}", &k[rel.len()..]), v);
        }
    }
}

/// Every file and folder under `dir` (hidden ones and node_modules left out).
fn walk(root: &Path, dir: &Path, files: &mut Vec<String>, dirs: &mut Vec<String>) {
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let p = e.path();
        if name.starts_with('.') {
            continue;
        }
        let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().into_owned();
        if !p.is_dir() {
            files.push(rel);
        } else if name != "node_modules" {
            dirs.push(rel);
            if !e.file_type().is_ok_and(|t| t.is_symlink()) {
                walk(root, &p, files, dirs); // like os.walk: a link to a folder is listed, not entered
            }
        }
    }
}

impl Workspace {
    fn root(&self) -> Result<&Path, String> {
        self.root.as_deref().ok_or_else(|| "No folder is open.".into())
    }

    fn path(&self, rel: &str) -> Result<PathBuf, String> {
        let root = self.root()?;
        let p = resolve(&root.join(rel));
        if !p.starts_with(root) {
            return Err(format!("Path outside the project: {rel}")); // never read or write outside the folder
        }
        Ok(p)
    }

    fn is_text(&self, rel: &Path) -> bool {
        is_text_ext(rel) && !rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
    }

    fn entries(&self) -> Result<(Vec<String>, Vec<String>), String> {
        let (mut files, mut dirs) = (vec![], vec![]);
        walk(self.root()?, self.root()?, &mut files, &mut dirs);
        files.sort();
        dirs.sort();
        Ok((files, dirs))
    }

    /// The text files whose changes are tracked.
    fn files(&self) -> Result<Vec<String>, String> {
        Ok(self.entries()?.0.into_iter().filter(|f| is_text_ext(Path::new(f))).collect())
    }

    /// Normalize a path from the page, refusing the project folder itself.
    fn norm(&self, rel: &str) -> Result<String, String> {
        let p = self.path(rel)?;
        if p == self.root()? {
            return Err("That is the project folder itself.".into());
        }
        Ok(p.strip_prefix(self.root()?).unwrap().to_string_lossy().into_owned())
    }

    fn forget(&mut self, rel: &str, to: Option<&str>) {
        move_keys(&mut self.known, rel, to);
        move_keys(&mut self.baseline, rel, to);
        for d in self.checkpoints.values_mut() {
            move_keys(d, rel, to);
        }
    }

    fn create(&mut self, rel: &str, folder: bool) -> Result<(), String> {
        let rel = self.norm(rel)?;
        let p = self.path(&rel)?;
        if p.exists() {
            return Err(format!("{rel} already exists."));
        }
        if folder {
            fs::create_dir_all(&p).map_err(err)?;
        } else {
            fs::create_dir_all(p.parent().unwrap()).map_err(err)?;
            self.known.insert(rel.clone(), String::new());
            fs::File::create_new(&p).map_err(err)?;
        }
        send(self.state());
        if !folder && is_text_ext(&p) {
            send(json!({"type": "file", "path": rel, "content": "", "baseline": null}));
        }
        Ok(())
    }

    fn rename(&mut self, old: &str, new: &str) -> Result<(), String> {
        let (old, new) = (self.norm(old)?, self.norm(new)?);
        let (src, dst) = (self.path(&old)?, self.path(&new)?);
        if !src.exists() {
            return Err(format!("{old} does not exist."));
        }
        if dst.exists() {
            return Err(format!("{new} already exists."));
        }
        if dst.starts_with(&src) {
            return Err("A folder cannot be moved inside itself.".into());
        }
        fs::create_dir_all(dst.parent().unwrap()).map_err(err)?;
        self.forget(&old, Some(&new));
        fs::rename(&src, &dst).map_err(err)?;
        send(json!({"type": "renamed", "from": old, "to": new}));
        send(self.state());
        Ok(())
    }

    fn delete(&mut self, rel: &str) -> Result<(), String> {
        let rel = self.norm(rel)?;
        let p = self.path(&rel)?;
        if !p.exists() {
            return Err(format!("{rel} does not exist."));
        }
        trash(&p)?; // the Trash, not a permanent delete: the writer can get it back
        self.forget(&rel, None);
        send(json!({"type": "deleted", "path": rel}));
        send(self.state());
        Ok(())
    }

    fn read(&self, rel: &str) -> Option<String> {
        let p = self.path(rel).ok()?;
        if p.metadata().ok()?.len() > MAX_FILE {
            return None;
        }
        read_text(&p).ok()
    }

    fn open(&mut self, root: &str) -> Result<(), String> {
        let expanded = match root.strip_prefix('~') {
            Some(rest) => format!("{}{rest}", std::env::var("HOME").unwrap_or_default()),
            None => root.into(),
        };
        let dir = resolve(Path::new(&expanded));
        if !dir.is_dir() {
            return Err(format!("Not a folder: {root}"));
        }
        self.root = Some(dir.clone());
        self.known = self.files()?.into_iter().filter_map(|rel| Some((rel.clone(), self.read(&rel)?))).collect();
        self.baseline.clear();
        self.turn = 0;
        self.checkpoints.clear();
        if let Some(p) = &mut self.preview_proc {
            let _ = p.start_kill(); // it shows a file from the previous folder
        }
        if let Some((_, task)) = self.watcher.take() {
            task.abort();
        }
        self.watcher = Some(watch(dir)?);
        send(self.state());
        Ok(())
    }

    fn state(&self) -> Value {
        let (files, dirs) = self.entries().unwrap_or_default();
        json!({
            "type": "folder",
            "root": self.root.as_ref().map(|r| r.to_string_lossy()),
            "files": files,
            "dirs": dirs,
            "changed": self.baseline.keys().collect::<Vec<_>>(),
            "labels": labels(&self.known),
        })
    }

    fn save(&mut self, rel: &str, content: &str, baseline: Option<String>) -> Result<(), String> {
        if let Some(disk) = self.read(rel) {
            if self.known.get(rel).is_some_and(|k| *k != disk) {
                // Someone else wrote the file since we last looked: keep their
                // version and show it as a change instead of overwriting it.
                self.external(rel, disk);
                return Ok(());
            }
        }
        self.known.insert(rel.into(), content.into());
        fs::write(self.path(rel)?, content).map_err(err)?;
        self.set_baseline(rel, Some(content), baseline);
        send(json!({"type": "saved", "path": rel}));
        Ok(())
    }

    fn set_baseline(&mut self, rel: &str, content: Option<&str>, baseline: Option<String>) {
        match baseline {
            Some(b) if Some(b.as_str()) != content => self.baseline.insert(rel.into(), b),
            _ => self.baseline.remove(rel),
        };
    }

    fn external(&mut self, rel: &str, new: String) {
        let old = self.known.get(rel).cloned();
        if old.as_ref() == Some(&new) {
            return;
        }
        self.known.insert(rel.into(), new.clone());
        let base = self.baseline.entry(rel.into()).or_insert_with(|| old.clone().unwrap_or_default()).clone();
        if self.turn > 0 {
            // First change to this file in this turn: remember how it was.
            self.checkpoints.entry(self.turn).or_default().entry(rel.into()).or_insert(old);
        }
        send(json!({"type": "file_changed", "path": rel, "content": new, "baseline": base}));
    }

    fn changed_on_disk(&mut self, root: &Path, paths: BTreeSet<PathBuf>) {
        if self.root.as_deref() != Some(root) {
            return; // the watcher of a folder that is no longer open
        }
        for p in paths {
            let Ok(rel) = p.strip_prefix(root) else { continue };
            if p.is_file() && self.is_text(rel) {
                let rel = rel.to_string_lossy().into_owned();
                if let Some(new) = self.read(&rel) {
                    self.external(&rel, new);
                }
            }
        }
        send(self.state());
    }

    /// Put every file the agent touched back to how it was before `turn`.
    fn restore(&mut self, turn: u64) -> Result<(), String> {
        let mut before = BTreeMap::new();
        let turns: Vec<u64> = self.checkpoints.range(turn..).map(|(t, _)| *t).rev().collect();
        for t in turns {
            before.extend(self.checkpoints.remove(&t).unwrap()); // earlier turns win
        }
        for (rel, old) in before {
            self.baseline.remove(&rel);
            match &old {
                None => {
                    // The agent created it.
                    self.known.remove(&rel);
                    match fs::remove_file(self.path(&rel)?) {
                        Err(e) if e.kind() != ErrorKind::NotFound => return Err(err(e)),
                        _ => {}
                    }
                }
                Some(text) => {
                    self.known.insert(rel.clone(), text.clone());
                    fs::write(self.path(&rel)?, text).map_err(err)?;
                }
            }
            let deleted = old.is_none();
            send(json!({"type": "file_changed", "path": rel, "content": old.unwrap_or_default(), "baseline": null, "deleted": deleted}));
        }
        send(self.state());
        Ok(())
    }

    fn scroll_preview(&self, rel: &str, line: &Value, col: &Value) -> Result<(), String> {
        // Only once the preview has drawn: before that tinymist has nothing to scroll, and in
        // testing a scroll during loading once left the preview blank.
        if let (Some(control), true) = (&self.control, self.preview_shown) {
            let file = self.path(rel)?.to_string_lossy().into_owned();
            let _ = control.send(json!({"event": "panelScrollTo", "filepath": file, "line": line, "character": col}).to_string());
        }
        Ok(())
    }

    /// The .bib file new citations go to, and whether a #bibliography(...) uses it.
    fn bib_file(&self) -> Result<(String, bool), String> {
        let bibliography = re(r#"bibliography\(\s*\(?\s*"([^"]+\.bib)""#);
        for (rel, text) in self.known.iter().filter(|(rel, _)| rel.ends_with(".typ")) {
            if let Some(m) = bibliography.captures(text) {
                let name = match m[1].strip_prefix('/') {
                    Some(from_root) => from_root.into(),
                    None => Path::new(rel).parent().unwrap_or(Path::new("")).join(&m[1]).to_string_lossy().into_owned(),
                };
                return Ok((self.norm(&name)?, true));
            }
        }
        Ok((self.files()?.into_iter().find(|f| f.ends_with(".bib")).unwrap_or_else(|| "refs.bib".into()), false))
    }
}

#[cfg(not(test))]
fn trash(p: &Path) -> Result<(), String> {
    trash::delete(p).map_err(|e| e.to_string())
}

#[cfg(test)]
static TRASHED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[cfg(test)]
fn trash(p: &Path) -> Result<(), String> {
    lock(&TRASHED).push(p.into()); // keep the real Trash out of the test
    Ok(())
}

fn watch(root: PathBuf) -> Result<(RecommendedWatcher, JoinHandle<()>), String> {
    let (tx, mut rx) = unbounded_channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |e: notify::Result<notify::Event>| {
        for p in e.map(|e| e.paths).unwrap_or_default() {
            let _ = tx.send(p);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    let task = tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            // Take changes in groups: until 50 ms pass with none, or 150 ms in all.
            let mut paths = BTreeSet::from([first]);
            let end = Instant::now() + Duration::from_millis(150);
            let wait = || end.saturating_duration_since(Instant::now()).min(Duration::from_millis(50));
            while let Ok(Some(p)) = tokio::time::timeout(wait(), rx.recv()).await {
                paths.insert(p);
            }
            ws().changed_on_disk(&root, paths);
        }
    });
    Ok((watcher, task))
}

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(err)?;
    Ok(listener.local_addr().map_err(err)?.port())
}

async fn preview(rel: &str) -> Result<(), String> {
    let (file, root, id) = {
        let mut w = ws();
        if let Some(p) = &mut w.preview_proc {
            let _ = p.start_kill();
        }
        (w.control, w.preview_shown) = (None, false);
        w.preview_id += 1;
        (w.path(rel)?, w.root()?.to_path_buf(), w.preview_id)
    };
    let (port, data, control) = (free_port()?, free_port()?, free_port()?);
    // tinymist opens three servers, two on fixed default ports; give each its own free
    // port so two previews (two copies of the app) can run at once.
    let hosts = [("--host", port), ("--data-plane-host", data), ("--control-plane-host", control)];
    let child = Command::new("tinymist")
        .arg("preview")
        .arg(&file)
        .arg("--root")
        .arg(&root)
        .args(hosts.iter().flat_map(|(flag, port)| [flag.to_string(), format!("127.0.0.1:{port}")]))
        // Redraw only the pages in view: long theses update far faster.
        .args(["--no-open", "--partial-rendering", "true"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| if e.kind() == ErrorKind::NotFound { "Live preview needs tinymist: brew install tinymist".into() } else { err(e) })?;
    ws().preview_proc = Some(child);
    let mut connection = None;
    for _ in 0..50 {
        // Wait until it listens. Then the editor connection: clicks in the preview come in,
        // "show this line" goes out. tinymist takes one, and quits when it gets a ping, which
        // tungstenite never sends on its own.
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            let config = WebSocketConfig::default().max_message_size(None).max_frame_size(None);
            let url = format!("ws://127.0.0.1:{control}");
            if let Ok((stream, _)) = tokio_tungstenite::connect_async_with_config(url, Some(config), false).await {
                connection = Some(stream);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if let Some(stream) = connection {
        let (mut sink, incoming) = stream.split();
        let (tx, mut rx) = unbounded_channel::<String>();
        {
            let mut w = ws();
            if w.preview_id == id {
                w.control = Some(tx);
            }
        }
        tokio::spawn(async move {
            while let Some(text) = rx.recv().await {
                if sink.send(tungstenite::Message::text(text)).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(follow(incoming, id));
    }
    send(json!({"type": "preview", "path": rel, "url": format!("http://127.0.0.1:{port}")}));
    Ok(())
}

/// A click in the preview: show that place in the editor.
async fn follow(mut incoming: impl Stream<Item = Result<tungstenite::Message, tungstenite::Error>> + Unpin, id: u64) {
    // Ends when the preview is closed or replaced.
    while let Some(Ok(raw)) = incoming.next().await {
        let msg: Value = raw.to_text().ok().and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
        let mut w = ws();
        if msg["event"] == "outline" && w.preview_id == id {
            w.preview_shown = true; // tinymist sends the outline once the page has drawn
        }
        if msg["event"] != "editorScrollTo" || !msg["start"].as_array().is_some_and(|s| !s.is_empty()) {
            continue;
        }
        let p = PathBuf::from(msg["filepath"].as_str().unwrap_or(""));
        let p = p.canonicalize().unwrap_or(p);
        if let Some(rel) = w.root.as_ref().and_then(|root| p.strip_prefix(root).ok()) {
            // Not text inside a package.
            send(json!({"type": "jump", "path": rel.to_string_lossy(), "line": msg["start"][0], "col": msg["start"][1]}));
        }
    }
}

/// Add the paper for a DOI or arXiv ID to the .bib file. Returns its key.
async fn cite(ident: &str) -> Result<Value, String> {
    let doi = doi_of(ident)?;
    let (rel, linked, p) = {
        let w = ws();
        let (rel, linked) = w.bib_file()?;
        let p = w.path(&rel)?;
        (rel, linked, p)
    };
    let text = if p.exists() { read_text(&p)? } else { String::new() };
    // Already there: reuse its key.
    let dup = re(&format!(r#"(?i)\bdoi\s*=\s*[{{"]\s*{}\s*[}}"]"#, regex::escape(&doi)));
    if let Some(d) = dup.find(&text) {
        if let Some(key) = BIB_KEY.captures_iter(&text[..d.start()]).last() {
            return Ok(json!({"key": &key[1], "bib": rel, "linked": linked, "added": false}));
        }
    }
    let entry = fetch_bibtex(&doi).await?;
    let entry = entry.trim();
    let m = BIB_KEY.captures(entry).filter(|m| m.get(0).unwrap().start() == 0).ok_or_else(|| format!("doi.org has no BibTeX for {doi}."))?;
    let key = cite_key(entry, &BIB_KEY.captures_iter(&text).map(|c| c[1].to_string()).collect());
    let at = m.get(1).unwrap();
    let entry = format!("{}{key}{}", &entry[..at.start()], &entry[at.end()..]);
    let new = if text.trim().is_empty() { String::new() } else { format!("{}\n\n", text.trim_end()) } + &entry + "\n";
    let mut w = ws();
    let tracked = w.known.contains_key(&rel) || !p.exists();
    if tracked {
        w.known.insert(rel.clone(), new.clone()); // the writer asked for it: not a change to review
    }
    fs::write(&p, &new).map_err(err)?;
    if tracked {
        send(json!({"type": "file_changed", "path": rel, "content": new, "baseline": w.baseline.get(&rel)}));
    }
    Ok(json!({"key": key, "bib": rel, "linked": linked, "added": true}))
}

async fn start_agent(agent_id: &str) -> Result<(), String> {
    let root = ws().root.clone();
    let Some(root) = root else {
        // No folder yet: remember the choice, start on open.
        BRIDGE.set_agent_id(agent_id);
        send(json!({"type": "agent", "id": agent_id, "ready": false}));
        return Ok(());
    };
    send(json!({"type": "status", "text": format!("Starting {}...", find_agent(agent_id)?.name)}));
    BRIDGE.start(agent_id, &root).await?;
    send(json!({"type": "agent", "id": agent_id, "ready": true}));
    Ok(())
}

async fn pick_folder() -> Option<String> {
    let out = Command::new("osascript")
        .args(["-e", r#"POSIX path of (choose folder with prompt "Open a Typst project")"#])
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|p| !p.is_empty())
}

async fn chat(text: &str, path: Option<&str>, selection: Option<&str>) {
    let turn = {
        let mut w = ws();
        w.turn += 1;
        w.turn
    };
    let mut context = path.filter(|p| !p.is_empty()).map_or(String::new(), |p| format!("\n\n(The writer has {p} open.)"));
    if let Some(selection) = selection.filter(|s| !s.is_empty()) {
        context += &format!("\n\nSelected text:\n{selection}");
    }
    send(json!({"type": "turn_start", "turn": turn, "text": text}));
    let stop = match BRIDGE.prompt("chat", &format!("{text}{context}")).await {
        Ok((stop, _)) => stop,
        Err(e) => {
            send(json!({"type": "error", "message": e}));
            "error".into()
        }
    };
    send(json!({"type": "turn_end", "turn": turn, "stop": stop}));
}

// Messages that read or write files. Each carries the folder the page is showing, so a
// page (or a second tab) still showing another folder can never write into this one.
const FILE_OPS: [&str; 9] = ["open_file", "save", "review", "create", "rename", "delete", "preview", "restore", "cite"];

fn field<'a>(msg: &'a Value, key: &str) -> Result<&'a str, String> {
    msg[key].as_str().ok_or_else(|| format!("'{key}' is missing"))
}

async fn handle(msg: &Value) -> Result<(), String> {
    let t = field(msg, "type")?;
    if FILE_OPS.contains(&t) {
        let root = ws().root.as_ref().map(|r| r.to_string_lossy().into_owned());
        if root.is_none() || msg["root"].as_str() != root.as_deref() {
            return Err("This page was showing a different folder, so nothing was changed. Reload the page.".into());
        }
    }
    let f = |key| field(msg, key);
    let opt = |key: &str| msg[key].as_str();
    match t {
        "open_folder" => {
            let path = match opt("path").filter(|p| !p.is_empty()) {
                Some(p) => Some(p.to_string()),
                None => pick_folder().await,
            };
            if let Some(path) = path {
                ws().open(&path)?;
                start_agent(&BRIDGE.agent_id().unwrap_or(DEFAULT_AGENT.into())).await?;
            }
        }
        "open_file" => {
            let rel = f("path")?;
            if !is_text_ext(Path::new(rel)) {
                let name = Path::new(rel).file_name().map_or(rel.into(), |n| n.to_string_lossy());
                return Err(format!("{name} is not a text file, so it cannot be opened here."));
            }
            let w = ws();
            let content = w.read(rel).ok_or_else(|| format!("Cannot open {rel}"))?;
            send(json!({"type": "file", "path": rel, "content": content, "baseline": w.baseline.get(rel)}));
        }
        "save" => ws().save(f("path")?, f("content")?, opt("baseline").map(String::from))?,
        "review" => {
            // Review decisions (accept/reject) while the text itself is not saved yet.
            let mut w = ws();
            let rel = w.norm(f("path")?)?;
            w.set_baseline(&rel, None, opt("baseline").map(String::from));
        }
        "create" => ws().create(f("path")?, msg["folder"].as_bool().unwrap_or(false))?,
        "rename" => ws().rename(f("from")?, f("to")?)?,
        "delete" => ws().delete(f("path")?)?,
        "preview" => preview(f("path")?).await?,
        "scroll_preview" => ws().scroll_preview(f("path")?, &msg["line"], &msg["col"])?,
        "cite" => {
            let mut result = cite(f("id")?).await?;
            (result["type"], result["req"]) = ("cite_result".into(), msg["req"].clone());
            send(result);
        }
        "prompt" => chat(f("text")?, opt("path"), opt("selection")).await,
        "cancel" => BRIDGE.cancel("chat").await,
        "permission" => BRIDGE.answer_permission(f("id")?, opt("option").map(String::from)),
        "set_agent" => start_agent(f("id")?).await?,
        "set_option" => BRIDGE.set_option(f("kind")?, f("id")?, msg["value"].clone()).await?,
        "inline" => {
            let text = BRIDGE.inline(f("path")?, f("instruction")?, f("selected")?, f("before")?, f("after")?).await?;
            send(json!({"type": "inline_result", "req": msg["req"], "text": text}));
        }
        "complete" => {
            let text = BRIDGE.complete(f("before")?, f("after")?).await?;
            send(json!({"type": "complete_result", "req": msg["req"], "text": text}));
        }
        "warm" => {
            if BRIDGE.running() {
                BRIDGE.session(f("kind")?).await?; // no agent yet: it warms up when the agent starts
            }
        }
        "restore" => ws().restore(msg["turn"].as_u64().ok_or("'turn' is missing")?)?,
        _ => {}
    }
    Ok(())
}

async fn safe(msg: Value) {
    if let Err(e) = handle(&msg).await {
        let t = msg["type"].as_str().unwrap_or("");
        send(json!({"type": "error", "message": format!("{t}: {e}"), "req": msg["req"], "op": t}));
    }
}

async fn websocket(upgrade: WebSocketUpgrade, headers: HeaderMap) -> Response {
    // Any web page can open a socket to localhost; only our own page may drive the agent.
    let port = PORT.get().copied().unwrap_or(0);
    let origin = headers.get("origin").and_then(|o| o.to_str().ok()).unwrap_or("");
    if origin != format!("http://127.0.0.1:{port}") && origin != format!("http://localhost:{port}") {
        return StatusCode::FORBIDDEN.into_response();
    }
    upgrade.on_upgrade(client)
}

async fn client(socket: WebSocket) {
    let (mut out, mut incoming) = socket.split();
    let (tx, mut rx) = unbounded_channel::<String>();
    lock(&CLIENTS).push(tx.clone());
    let mut agents: Vec<Value> = registry().into_iter().map(|a| json!({"id": a.id, "name": a.name})).collect();
    agents.sort_by_key(|a| a["name"].as_str().unwrap_or("").to_lowercase());
    let agent = BRIDGE.agent_id().unwrap_or(DEFAULT_AGENT.into());
    let _ = tx.send(json!({"type": "hello", "agents": agents, "agent": agent}).to_string());
    let _ = tx.send(ws().state().to_string());
    for (kind, options) in BRIDGE.all_options() {
        let _ = tx.send(json!({"type": "options", "kind": kind, "options": options}).to_string());
    }
    drop(tx);
    tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if out.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(raw)) = incoming.next().await {
        let Message::Text(text) = raw else { continue };
        let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
        if matches!(msg["type"].as_str(), Some("save" | "review")) {
            safe(msg).await; // in order, so an older save never lands after a newer one
        } else {
            tokio::spawn(safe(msg));
        }
    }
}

/// Serve the page from `web` and the WebSocket at /ws. Opens `folder` first when given.
pub async fn serve(listener: std::net::TcpListener, web: PathBuf, folder: Option<String>) -> std::io::Result<()> {
    let _ = PORT.set(listener.local_addr()?.port());
    if let Some(folder) = folder {
        tokio::spawn(safe(json!({"type": "open_folder", "path": folder})));
    }
    listener.set_nonblocking(true)?;
    let app = Router::new().route("/ws", get(websocket)).fallback_service(ServeDir::new(web));
    axum::serve(tokio::net::TcpListener::from_std(listener)?, app).await
}

/// Stop the agent and the preview, which run as their own processes.
pub fn shutdown() {
    BRIDGE.stop();
    if let Some(p) = &mut ws().preview_proc {
        let _ = p.start_kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map<V: Clone>(pairs: &[(&str, V)]) -> BTreeMap<String, V> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[tokio::test]
    async fn workspace() {
        let dir = std::env::temp_dir().join(format!("typst-writer-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = dir.canonicalize().unwrap();
        let text = |rel: &str| fs::read_to_string(root.join(rel)).unwrap();
        fs::write(root.join("main.typ"), "old").unwrap();
        *ws() = Workspace { root: Some(root.clone()), known: map(&[("main.typ", "old".to_string())]), ..Default::default() };
        {
            let mut w = ws();
            // The agent edits a file during turn 1 and creates another.
            w.turn = 1;
            fs::write(root.join("main.typ"), "agent").unwrap();
            w.external("main.typ", "agent".into());
            w.external("new.typ", "created".into());
            assert_eq!(w.baseline, map(&[("main.typ", "old".to_string()), ("new.typ", String::new())]));
            let before = map(&[("main.typ", Some("old".to_string())), ("new.typ", None)]);
            assert_eq!(w.checkpoints, BTreeMap::from([(1, before)]));

            // A save from a stale editor must not overwrite a newer disk version.
            fs::write(root.join("main.typ"), "agent again").unwrap();
            w.save("main.typ", "stale editor text", Some("old".into())).unwrap();
            assert_eq!(text("main.typ"), "agent again");

            // Accepting everything clears the baseline.
            w.save("main.typ", "agent again", None).unwrap();
            assert!(!w.baseline.contains_key("main.typ"));

            // Restore puts files back to before turn 1 and removes created ones.
            fs::write(root.join("new.typ"), "created").unwrap();
            w.restore(1).unwrap();
            assert_eq!(text("main.typ"), "old");
            assert!(!root.join("new.typ").exists());
            assert!(w.checkpoints.is_empty());

            // Files and folders: create, rename (tracked changes follow), delete (to the Trash).
            w.create("notes/ch1.typ", false).unwrap();
            assert_eq!(text("notes/ch1.typ"), "");
            w.create("figures", true).unwrap();
            assert!(root.join("figures").is_dir());
            w.baseline.insert("notes/ch1.typ".into(), "old text".into());
            w.rename("notes", "chapters").unwrap();
            assert!(root.join("chapters/ch1.typ").exists() && !root.join("notes").exists());
            assert_eq!(w.baseline, map(&[("chapters/ch1.typ", "old text".to_string())]));
            assert!(w.create("chapters/ch1.typ", false).is_err());
            assert!(w.rename("chapters", "chapters/in").is_err());
            assert!(w.delete("").is_err());
            w.delete("chapters").unwrap();
            assert_eq!(*lock(&TRASHED), [root.join("chapters")]);
            assert!(!w.baseline.contains_key("chapters/ch1.typ"));

            // Paths outside the folder are refused.
            assert!(w.path("../outside.typ").is_err());
        }

        // A page still showing another folder cannot save into this one.
        let save = json!({"type": "save", "root": "/some/other/folder", "path": "main.typ", "content": "x"});
        assert!(handle(&save).await.is_err());
        assert_eq!(text("main.typ"), "old");

        // Labels: definitions, uses, and look-alikes in comments, raw text, math and e-mails.
        let found = labels(&map(&[
            ("main.typ", "= Intro <intro>\nSee @fig:a. and #link(<intro>)[here].\n// <old> @gone\n$a<b>c$ `<raw>`\n#show <note>: none".to_string()),
            ("ch/a.typ", "#figure[x] <fig:a>\nmail me@site.org <unused>".to_string()),
            ("refs.bib", "<nope>".to_string()),
        ]));
        let found: Vec<_> = found.iter().map(|f| (f["name"].as_str().unwrap(), f["path"].as_str().unwrap(), f["line"].as_u64().unwrap(), f["refs"].as_u64().unwrap())).collect();
        assert_eq!(found, [("fig:a", "ch/a.typ", 0, 1), ("unused", "ch/a.typ", 1, 0), ("intro", "main.typ", 0, 1)]);
        // \$ is a dollar sign and :// a URL, not math or a comment.
        assert_eq!(blank_hidden(r"a \$ <x> $m$ https://y.z <w> // c"), r"a \$ <x>     https://y.z <w>     ");

        // Citations: DOI and arXiv forms, and keys made from the first author and year.
        assert_eq!(doi_of(" https://doi.org/10.1038/nature14539 ").unwrap(), "10.1038/nature14539");
        assert_eq!(doi_of("arXiv:1706.03762v5").unwrap(), "10.48550/arXiv.1706.03762");
        assert_eq!(doi_of("https://arxiv.org/abs/1706.03762").unwrap(), "10.48550/arXiv.1706.03762");
        assert_eq!(doi_of("hep-th/9901001").unwrap(), "10.48550/arXiv.hep-th/9901001");
        assert!(doi_of("attention is all you need").is_err());
        let entry = "@misc{https://doi.org/x, author = {Vaswani, Ashish and Shazeer, Noam}, year = {2017}}";
        assert_eq!(cite_key(entry, &HashSet::new()), "vaswani2017");
        assert_eq!(cite_key(entry, &HashSet::from(["vaswani2017".to_string()])), "vaswani2017a");
        assert_eq!(cite_key(r#"@article{k, author={M{\"u}ller, J.}, year={2020}}"#, &HashSet::new()), "muller2020");
        assert_eq!(cite_key("@article{k, author={Müller, J.}, year={2020}}", &HashSet::new()), "muller2020");
        assert_eq!(cite_key("@misc{k, title={No author}}", &HashSet::new()), "ref");

        // A citation already in the .bib file is not fetched again.
        fs::write(root.join("refs.bib"), "@article{lecun2015, title={Deep learning}, doi={10.1038/Nature14539}}\n").unwrap();
        ws().known = map(&[("main.typ", r#"#bibliography("refs.bib")"#.to_string())]);
        let r = cite("10.1038/nature14539").await.unwrap();
        assert_eq!(r, json!({"key": "lecun2015", "bib": "refs.bib", "linked": true, "added": false}));
        let _ = fs::remove_dir_all(&dir);
    }
}
