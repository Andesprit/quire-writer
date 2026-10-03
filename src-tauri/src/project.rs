//! The open project and everything the page asks of it: files, changes to review, previews,
//! export, citations and the agent. The page and this side exchange JSON messages through
//! Tauri: `receive` takes the page's, `send` emits ours.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, Stream, StreamExt};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tauri::http::Response;
use tauri::{AppHandle, Emitter, Manager};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{self, protocol::WebSocketConfig};
use unicode_normalization::UnicodeNormalization;

use crate::agent::{complete_api, complete_prompt, find_agent, registry, BRIDGE};
use crate::engine;
use crate::lock;

const TEXT_EXT: [&str; 14] = ["typ", "tex", "qmd", "md", "bib", "sty", "cls", "yml", "yaml", "toml", "txt", "csv", "json", "xml"];
const MAX_FILE: u64 = 2_000_000;
const DEFAULT_AGENT: &str = "claude-acp";
const TROUBLESHOOTING: &str = "https://andesprit.com/quire-writer/troubleshooting.html";

static APP: OnceLock<AppHandle> = OnceLock::new();
static INBOX: OnceLock<UnboundedSender<Value>> = OnceLock::new();
static WS: LazyLock<Mutex<Workspace>> = LazyLock::new(Mutex::default);

fn ws() -> MutexGuard<'static, Workspace> {
    lock(&WS)
}

/// A message to the page.
pub fn send(msg: Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit("message", msg);
    }
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

#[derive(Clone, Copy, PartialEq, Debug)]
enum Lang {
    Typst,
    Latex,
    Quarto,
    Markdown,
    Text,
}

fn lang_of(path: &str) -> Lang {
    match Path::new(path).extension().and_then(|e| e.to_str()) {
        Some("typ") => Lang::Typst,
        Some("tex") => Lang::Latex,
        Some("qmd") => Lang::Quarto,
        Some("md") => Lang::Markdown,
        _ => Lang::Text,
    }
}

/// The language's name, for the agent's instructions.
pub fn language_name(path: &str) -> &'static str {
    match lang_of(path) {
        Lang::Typst => "Typst",
        Lang::Latex => "LaTeX",
        Lang::Quarto => "Quarto",
        Lang::Markdown => "Markdown",
        Lang::Text => "plain text",
    }
}

/// The file as text, with \r\n and \r turned into \n as the editor's text field does anyway,
/// and without a byte order mark at the start: an invisible mark that makes WebKit measure the
/// whole text field again on every key, three times slower in a long chapter. A save writes
/// the file without it.
fn read_text(p: &Path) -> Result<String, String> {
    let text = String::from_utf8(fs::read(p).map_err(err)?).map_err(|_| format!("{} is not UTF-8 text.", p.display()))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    Ok(if text.contains('\r') { text.replace("\r\n", "\n").replace('\r', "\n") } else { text.into() })
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
// LaTeX: \label{name} defines one; \ref{name}, \cref{a,b} and the like use it. Comments and
// verbatim text hide them.
static TEX_LABEL: LazyLock<Regex> = LazyLock::new(|| re(r"\\label\{([^}]+)\}"));
static TEX_REF: LazyLock<Regex> =
    LazyLock::new(|| re(r"\\(?:[cCvV]ref|ref|eqref|pageref|autoref|nameref|[cC]pageref|labelcref)\*?\{([^}]+)\}"));
static TEX_HIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?s)\\begin\{(?:verbatim|lstlisting|minted|comment)\*?\}.*?\\end\{(?:verbatim|lstlisting|minted|comment)\*?\}|%[^\n]*")
});
// Quarto: {#fig-name} after a heading, figure or table, or "#| label: fig-name" in a code
// chunk, defines one; @fig-name uses it. Comments and code hide them.
static QMD_LABEL: LazyLock<Regex> = LazyLock::new(|| re(r"\{(?:[^}\n]*\s)?#([A-Za-z][\w:.-]*)"));
static CHUNK_LABEL: LazyLock<Regex> = LazyLock::new(|| re(r#"^\s*#\|\s*label:\s*["']?([\w:.-]+)"#));
static MD_HIDDEN: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)<!--.*?-->|```.*?```|~~~.*?~~~|`[^`\n]*`"));

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
fn blank_hidden(text: &str, lang: Lang) -> String {
    // Typst: \$ is a dollar sign, and :// is part of a URL. LaTeX: \% is a percent sign.
    let (hidden, skip): (&Regex, fn(char, &str) -> bool) = match lang {
        Lang::Typst => (&HIDDEN, |b, m| (b == '\\' && m.starts_with('$')) || (b == ':' && m.starts_with("//"))),
        Lang::Latex => (&TEX_HIDDEN, |b, m| b == '\\' && m.starts_with('%')),
        _ => (&MD_HIDDEN, |_, _| false),
    };
    let (mut out, mut at) = (String::with_capacity(text.len()), 0);
    for c in find_not_after(hidden, text, 0, skip) {
        let m = c.get(0).unwrap();
        out.push_str(&text[at..m.start()]);
        out.extend(m.as_str().chars().map(|ch| if ch == '\n' { '\n' } else { ' ' }));
        at = m.end();
    }
    out + &text[at..]
}

/// Every label defined in the Typst, LaTeX and Quarto files, and how many times it is used.
fn labels(texts: &BTreeMap<String, String>) -> Vec<Value> {
    let (mut found, mut uses) = (vec![], HashMap::<String, u64>::new());
    for (rel, text) in texts {
        let lang = lang_of(rel);
        if !matches!(lang, Lang::Typst | Lang::Latex | Lang::Quarto) {
            continue;
        }
        let blanked = blank_hidden(text, lang);
        for (n, (line, raw)) in blanked.split('\n').zip(text.split('\n')).enumerate() {
            let mut define = |name: &str, at: usize| found.push((name.to_string(), rel.clone(), n, line[..at].chars().count()));
            let mut refs = |name: &str| *uses.entry(name.trim().to_string()).or_default() += 1;
            if lang == Lang::Latex {
                TEX_LABEL.captures_iter(line).for_each(|c| define(&c[1], c.get(0).unwrap().start()));
                TEX_REF.captures_iter(line).for_each(|c| c[1].split(',').for_each(&mut refs));
                continue;
            }
            // Not after a letter or a backslash: me@site.org and \@ are not references.
            for c in find_not_after(&REF, line, 0, |b, _| b.is_alphanumeric() || b == '_' || b == '\\') {
                refs(&c[1]);
            }
            if lang == Lang::Quarto {
                QMD_LABEL.captures_iter(line).for_each(|c| define(&c[1], c.get(0).unwrap().start()));
                if let Some(c) = CHUNK_LABEL.captures(raw) {
                    define(&c[1], 0); // inside a code chunk, which `blanked` has emptied
                }
                continue;
            }
            for c in LABEL.captures_iter(line) {
                if c.get(1).is_some() {
                    refs(&c[2]);
                } else {
                    define(&c[2], c.get(0).unwrap().start());
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
    shadowed: BTreeSet<String>,               // files tinymist reads from the editor's text, not the disk
    preview_shown: bool,
    preview_id: u64, // which preview is the current one
    asked: u64,      // the newest preview the page asked for: an older request that finishes later must not replace it
    built: Option<Built>,
}

/// A preview the app builds itself on every change: the document as the export makes it,
/// as PDF, Word or a web page. The file built, where its output goes, and whether a build runs.
struct Built {
    main: String,
    out: PathBuf,
    to: &'static str, // "pdf", "docx" or "html"
    running: bool,
    again: bool, // something changed during the compile: run once more
    id: u64,
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

/// Hidden files and folders, and node_modules: not listed, not tracked, not served.
fn skipped(rel: &Path) -> bool {
    rel.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        name.starts_with('.') || name == "node_modules"
    })
}

/// Every file and folder under `dir`, without the skipped ones.
fn walk(root: &Path, dir: &Path, files: &mut Vec<String>, dirs: &mut Vec<String>) {
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if skipped(Path::new(&e.file_name())) || quarto_output(&p) {
            continue;
        }
        let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().into_owned();
        if !p.is_dir() {
            files.push(rel);
        } else {
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
        is_text_ext(rel) && !skipped(rel)
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
        let under = format!("{rel}/");
        let moved: Vec<String> = self.shadowed.iter().filter(|k| *k == rel || k.starts_with(&under)).cloned().collect();
        for k in moved {
            self.unshadow(&k);
        }
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
        fs::rename(&src, &dst).map_err(err)?;
        self.forget(&old, Some(&new));
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
        self.checkpoints.clear(); // `turn` goes on counting: the chat keeps the old folder's turns
        self.stop_preview(); // it shows a file from the previous folder
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
        let p = self.path(rel)?;
        let disk = self.read(rel);
        if let Some(disk) = &disk {
            if self.known.get(rel).is_some_and(|k| k != disk) {
                // Someone else wrote the file since we last looked: keep their
                // version and show it as a change instead of overwriting it.
                self.external(rel, disk.clone());
                return Ok(());
            }
        }
        // The same text: no write, so the watcher and the LaTeX preview stay quiet.
        if disk.as_deref() != Some(content) {
            fs::write(&p, content).map_err(err)?;
        }
        self.known.insert(rel.into(), content.into());
        self.set_baseline(rel, Some(content), baseline);
        send(json!({"type": "saved", "path": rel}));
        Ok(())
    }

    fn set_baseline(&mut self, rel: &str, content: Option<&str>, baseline: Option<String>) {
        let had = self.baseline.contains_key(rel);
        match baseline {
            Some(b) if Some(b.as_str()) != content => self.baseline.insert(rel.into(), b),
            _ => self.baseline.remove(rel),
        };
        if had != self.baseline.contains_key(rel) {
            send(self.state()); // the explorer's and the tab's "to review" marks
        }
    }

    fn external(&mut self, rel: &str, new: String) {
        let old = self.known.get(rel).cloned();
        if old.as_ref() == Some(&new) {
            return;
        }
        self.unshadow(rel);
        self.known.insert(rel.into(), new.clone());
        let base = self.baseline.entry(rel.into()).or_insert_with(|| old.clone().unwrap_or_default()).clone();
        if self.turn > 0 {
            // First change to this file in this turn: remember how it was.
            self.checkpoints.entry(self.turn).or_default().entry(rel.into()).or_insert(old);
        }
        send(json!({"type": "file_changed", "path": rel, "content": new, "baseline": base}));
    }

    /// `rel` (a file, or a folder and all in it) was deleted or moved away by someone else.
    /// Restore can bring it back.
    fn gone(&mut self, rel: &str) {
        let under = format!("{rel}/");
        let files: Vec<String> = self.known.keys().filter(|k| *k == rel || k.starts_with(&under)).cloned().collect();
        for f in files {
            self.unshadow(&f);
            let old = self.known.remove(&f);
            self.baseline.remove(&f);
            if self.turn > 0 {
                self.checkpoints.entry(self.turn).or_default().entry(f.clone()).or_insert(old);
            }
            send(json!({"type": "file_changed", "path": f, "content": "", "baseline": null, "deleted": true}));
        }
    }

    /// Returns whether the built preview (LaTeX's PDF, Word) should build again.
    fn changed_on_disk(&mut self, root: &Path, paths: BTreeSet<PathBuf>) -> bool {
        if self.root.as_deref() != Some(root) {
            return false; // the watcher of a folder that is no longer open
        }
        // A file the writer already has stays theirs, even with the name Quarto would use.
        let known = |p: &Path| p.strip_prefix(root).is_ok_and(|rel| self.known.contains_key(&*rel.to_string_lossy()));
        let paths: BTreeSet<PathBuf> = paths.into_iter().filter(|p| known(p) || !quarto_output(p)).collect();
        if paths.is_empty() {
            return false;
        }
        let build = self.built.is_some() && paths.iter().any(|p| p.strip_prefix(root).is_ok_and(|rel| !skipped(rel)));
        for p in paths {
            let Ok(rel) = p.strip_prefix(root) else { continue };
            if !p.exists() {
                self.gone(&rel.to_string_lossy());
            } else if p.is_file() && self.is_text(rel) {
                let rel = rel.to_string_lossy().into_owned();
                if let Some(new) = self.read(&rel) {
                    self.external(&rel, new);
                }
            }
        }
        send(self.state());
        build
    }

    /// Stop whatever preview runs for the one the page asked for as `asked`, unless it has asked
    /// for another since. Returns the id the new preview gets.
    fn start_preview(&mut self, asked: u64) -> Option<u64> {
        (asked == self.asked).then(|| self.stop_preview())
    }

    /// Stop whatever preview runs. Returns the id the next preview gets.
    fn stop_preview(&mut self) -> u64 {
        if let Some(p) = self.preview_proc.take() {
            if let Some(pid) = p.id() {
                unsafe { libc::killpg(pid as i32, libc::SIGTERM) }; // Quarto runs helpers of its own
            }
        }
        (self.control, self.preview_shown, self.built) = (None, false, None);
        self.shadowed.clear();
        self.preview_id += 1;
        self.preview_id
    }

    /// The whole document `rel` belongs to, as the preview and export show it: Typst's
    /// main.typ, LaTeX's main file, or else the file itself.
    fn main_of(&self, rel: &str) -> String {
        match lang_of(rel) {
            Lang::Typst if self.known.contains_key("main.typ") => "main.typ".into(),
            Lang::Latex => self.latex_main(rel),
            _ => rel.to_string(),
        }
    }

    /// The file LaTeX compiles: the one a "% !TEX root = ..." line names, the file itself
    /// when it has \documentclass, or else main.tex or another file that has one.
    fn latex_main(&self, rel: &str) -> String {
        let text = self.known.get(rel).map_or("", String::as_str);
        if let Some(m) = re(r"(?im)^\s*%\s*!TEX\s+root\s*=\s*(.+?)\s*$").captures(text) {
            if let Ok(main) = self.norm(&Path::new(rel).parent().unwrap_or(Path::new("")).join(&m[1]).to_string_lossy()) {
                return main;
            }
        }
        let is_main = |t: &str| t.contains("\\documentclass");
        if is_main(text) {
            return rel.into();
        }
        let mut mains = self.known.iter().filter(|(p, t)| p.ends_with(".tex") && is_main(t)).map(|(p, _)| p);
        if self.known.get("main.tex").is_some_and(|t| is_main(t)) { "main.tex".into() } else { mains.next().map_or(rel.into(), Clone::clone) }
    }

    /// Put every file the agent touched back to how it was before `turn`.
    fn restore(&mut self, turn: u64) -> Result<(), String> {
        let mut before = BTreeMap::new();
        let turns: Vec<u64> = self.checkpoints.range(turn..).map(|(t, _)| *t).rev().collect();
        for t in turns {
            before.extend(self.checkpoints.remove(&t).unwrap()); // earlier turns win
        }
        for (rel, old) in before {
            let p = self.path(&rel)?;
            match &old {
                None => {
                    // The agent created it.
                    self.known.remove(&rel);
                    self.baseline.remove(&rel);
                    match fs::remove_file(&p) {
                        Err(e) if e.kind() != ErrorKind::NotFound => return Err(err(e)),
                        _ => {}
                    }
                }
                Some(text) => {
                    fs::create_dir_all(p.parent().unwrap()).map_err(err)?; // moved away with its folder
                    fs::write(&p, text).map_err(err)?;
                    self.known.insert(rel.clone(), text.clone());
                    // Changes from earlier turns that wait for review still do.
                    let earlier = self.baseline.get(&rel).cloned();
                    self.set_baseline(&rel, Some(text), earlier);
                }
            }
            let deleted = old.is_none();
            let base = self.baseline.get(&rel);
            send(json!({"type": "file_changed", "path": rel, "content": old.unwrap_or_default(), "baseline": base, "deleted": deleted}));
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

    /// The editor's text of a Typst file: the live preview shows it as typed, before auto save
    /// writes it, and keeps showing it until the file changes on disk some other way.
    fn typed(&mut self, rel: &str, content: &str) -> Result<(), String> {
        if let Some(control) = &self.control {
            let file = self.path(rel)?.to_string_lossy().into_owned();
            let _ = control.send(json!({"event": "updateMemoryFiles", "files": {file: content}}).to_string());
            self.shadowed.insert(rel.into());
        }
        Ok(())
    }

    /// The live preview reads `rel` from the disk again.
    fn unshadow(&mut self, rel: &str) {
        if !self.shadowed.remove(rel) {
            return;
        }
        if let (Some(control), Ok(file)) = (&self.control, self.path(rel)) {
            let _ = control.send(json!({"event": "removeMemoryFiles", "files": [file.to_string_lossy()]}).to_string());
        }
    }

    /// The .bib file new citations from `from` go to, and whether a file in its language
    /// names it: #bibliography(...), \bibliography{...} or "bibliography:" in YAML.
    fn bib_file(&self, from: &str) -> Result<(String, bool), String> {
        let lang = lang_of(from);
        let (bibliography, same_kind) = match lang {
            Lang::Typst => (re(r#"bibliography\(\s*\(?\s*"([^"]+\.bib)""#), &["typ"][..]),
            Lang::Latex => (re(r"\\(?:bibliography|addbibresource)\{([^},]+)"), &["tex"][..]),
            _ => (re(r#"(?m)^\s*bibliography:\s*(?:\n\s*-\s*)?["']?([^"'\s]+\.bib)"#), &["qmd", "md", "yml", "yaml"][..]),
        };
        let kind = |rel: &str| Path::new(rel).extension().and_then(|e| e.to_str()).is_some_and(|e| same_kind.contains(&e));
        for (rel, text) in self.known.iter().filter(|(rel, _)| kind(rel)) {
            if let Some(m) = bibliography.captures(text) {
                let file = m[1].trim();
                let file = if file.ends_with(".bib") { file.to_string() } else { format!("{file}.bib") }; // \bibliography{refs}
                let name = match file.strip_prefix('/') {
                    Some(from_root) => from_root.into(),
                    None => Path::new(rel).parent().unwrap_or(Path::new("")).join(&file).to_string_lossy().into_owned(),
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
            if ws().changed_on_disk(&root, paths) {
                compile();
            }
        }
    });
    Ok((watcher, task))
}

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(err)?;
    Ok(listener.local_addr().map_err(err)?.port())
}

/// The address of one of the app's own preview pages (see `protocol`).
fn our(page: &str) -> String {
    format!("quire://localhost/{page}")
}

/// The document as `to` shows it: "pdf", "docx" or "html". Typst's PDF, Quarto's and
/// Markdown's HTML are live views; the rest are the export, built again on every change.
/// `asked` numbers the page's requests (see `start`).
async fn preview(rel: &str, to: &str, asked: u64) -> Result<(), String> {
    match (lang_of(rel), to) {
        (Lang::Text, _) => Ok(()),
        (Lang::Typst, "pdf") => typst_preview(rel, asked).await,
        (Lang::Quarto, "html") => quarto_preview(rel, asked).await,
        (Lang::Markdown, "html") => {
            // Drawn by the page itself from the text in the editor: no program to run.
            if ws().start_preview(asked).is_some() {
                send(json!({"type": "preview", "path": rel, "kind": "markdown", "url": our("markdown.html")}));
            }
            Ok(())
        }
        (_, "pdf") => built_preview(rel, "pdf", asked),
        (_, "docx") => built_preview(rel, "docx", asked),
        (_, "html") => built_preview(rel, "html", asked),
        _ => Err(format!("Quire cannot preview as .{to}.")),
    }
}

async fn typst_preview(rel: &str, asked: u64) -> Result<(), String> {
    let (file, root, id) = {
        let mut w = ws();
        let Some(id) = w.start_preview(asked) else { return Ok(()) };
        (w.path(rel)?, w.root()?.to_path_buf(), id)
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
        // Only the pages in view are drawn again on a change: on a 57-page paper an edit shows
        // in 0.18 s instead of 1.3 s. WebKit needs the help of TINYMIST_PARTIAL (main.rs).
        .args(["--partial-rendering", "true"])
        .arg("--no-open")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| if e.kind() == ErrorKind::NotFound { "Live preview needs tinymist: brew install tinymist".into() } else { err(e) })?;
    keep_preview(child, id);
    let (mut connection, mut listening) = (None, false);
    for _ in 0..250 {
        if ws().preview_id != id {
            return Ok(()); // another preview replaced this one
        }
        // Wait until it listens, about 0.1 s after it starts. Then the editor connection: clicks
        // in the preview come in, "show this line" goes out. tinymist takes one, and quits when
        // it gets a ping, which tungstenite never sends on its own.
        listening = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok();
        if listening {
            let config = WebSocketConfig::default().max_message_size(None).max_frame_size(None);
            let url = format!("ws://127.0.0.1:{control}");
            if let Ok((stream, _)) = tokio_tungstenite::connect_async_with_config(url, Some(config), false).await {
                connection = Some(stream);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !listening {
        return Err(format!("tinymist could not show a preview of {rel}."));
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
    send(json!({"type": "preview", "path": rel, "kind": "live", "url": format!("http://127.0.0.1:{port}")}));
    Ok(())
}

/// Keep the preview's process, unless another preview started meanwhile.
fn keep_preview(child: Child, id: u64) {
    let mut w = ws();
    if w.preview_id == id {
        w.preview_proc = Some(child);
    } else if let Some(pid) = child.id() {
        unsafe { libc::killpg(pid as i32, libc::SIGTERM) };
    }
}

/// The document exported as `to` ("pdf", "docx" or "html"), built again on every change.
fn built_preview(rel: &str, to: &'static str, asked: u64) -> Result<(), String> {
    let mut w = ws();
    if asked != w.asked {
        return Ok(()); // the page asked for another preview since
    }
    let main = w.main_of(rel);
    let message = json!({"type": "preview", "path": main, "kind": to, "url": our(&format!("{to}.html"))});
    if w.built.as_ref().is_some_and(|b| b.main == main && b.to == to) {
        send(message); // a chapter of the document already shown
        return Ok(());
    }
    let id = w.stop_preview();
    // Build files go outside the folder: the writer's project stays clean, and the watcher
    // does not see them (they would start the next compile).
    let file = w.path(&main)?;
    let out = std::env::temp_dir().join(format!("quire-{to}-{:x}", hash(&file)));
    w.built = Some(Built { main, out, to, running: false, again: false, id });
    drop(w);
    send(message);
    compile();
    Ok(())
}

fn hash(p: &Path) -> u64 {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut h = DefaultHasher::new();
    p.hash(&mut h);
    h.finish()
}

/// Build the preview now, or once more after the build that is running.
fn compile() {
    let (file, root, bib, out, to, id) = {
        let mut w = ws();
        let Some(b) = &mut w.built else { return };
        if b.running {
            b.again = true;
            return;
        }
        b.running = true;
        let (main, out, to, id) = (b.main.clone(), b.out.clone(), b.to, b.id);
        let bib = w.bib_file(&main).ok().filter(|(_, linked)| *linked).and_then(|(b, _)| w.path(&b).ok());
        let (Ok(file), Ok(root)) = (w.path(&main), w.root().map(Path::to_path_buf)) else { return };
        (file, root, bib, out, to, id)
    };
    tokio::spawn(async move {
        loop {
            send(json!({"type": "build", "running": true}));
            match convert(&file, &root, to, bib.clone(), &out).await {
                Ok(()) => send(json!({"type": "build", "ok": true})),
                Err(log) => send(json!({"type": "build", "ok": false, "log": log})),
            }
            let mut w = ws();
            match &mut w.built {
                Some(l) if l.id == id && l.again => l.again = false,
                Some(l) if l.id == id => {
                    l.running = false;
                    break;
                }
                _ => break,
            }
        }
    });
}

fn on_path(program: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|dir| dir.join(program).is_file()))
}

/// One line of Check Setup. Status: ok, warn, error, or off (an optional tool that is not
/// installed). Fix: a command that installs what is missing.
fn row(label: &str, status: &str, detail: String, fix: &str) -> Value {
    json!({"label": label, "status": status, "detail": detail, "fix": fix})
}

/// Check Setup: what the chosen agent needs to start, then the tools each preview and export
/// needs, and which agents can start here. The page adds whether the agent itself runs.
async fn setup() -> Result<Value, String> {
    let agent = find_agent(&BRIDGE.agent_id().unwrap_or(DEFAULT_AGENT.into()))?;
    let mut rows = vec![match agent.program() {
        "npx" => {
            let out = Command::new("node").arg("--version").output().await.ok().filter(|o| o.status.success());
            let version = out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
            let major = version.as_deref().and_then(|v| v.trim_start_matches('v').split('.').next()?.parse::<u32>().ok());
            match (version, major) {
                (Some(v), Some(m)) if m >= 22 => row("Node.js", "ok", v, ""),
                // Agents ask for different versions (Claude 22, Codex 20): 22 serves them all.
                (Some(v), _) => row("Node.js", "warn", format!("{v} is old. Some agents need Node.js 22 or newer."), "brew upgrade node"),
                (None, _) => row("Node.js", "error", format!("Not found. {} starts with npx, which comes with Node.js.", agent.name), "brew install node"),
            }
        }
        "uvx" if on_path("uvx") => row("uv", "ok", "Found uvx".into(), ""),
        "uvx" => row("uv", "error", format!("Not found. {} starts with uvx, which comes with uv.", agent.name), "brew install uv"),
        program if on_path(program) => row(&agent.name, "ok", format!("Found {program}"), ""),
        program => row(&agent.name, "error", format!("Not found. Install {} so that {program} is on your PATH.", agent.name), ""),
    }];
    let tools: [(&str, &[&str], &str, &str); 4] = [
        ("Typst preview", &["tinymist"], "Not installed.", "brew install tinymist"),
        ("LaTeX preview", &["latexmk", "tectonic"], "Not installed. MacTeX (tug.org/mactex) works too.", "brew install tectonic"),
        ("Quarto preview", &["quarto"], "Not installed.", "brew install --cask quarto"),
        ("Word and other exports", &["pandoc", "quarto"], "Not installed. Quarto carries its own.", "brew install pandoc"),
    ];
    for (label, programs, missing, fix) in tools {
        rows.push(match programs.iter().find(|p| on_path(p)) {
            Some(p) => row(label, "ok", format!("Found {p}"), ""),
            None => row(label, "off", missing.into(), fix),
        });
    }
    let log = APP.get().and_then(|a| a.path().app_log_dir().ok()).map(|d| d.join("agent.log"));
    // The agents whose starter (npx, uvx or their own program) is on this computer.
    let mut ready: Vec<String> = registry().into_iter().filter(|a| on_path(a.program())).map(|a| a.name).collect();
    ready.sort_by_key(|name| name.to_lowercase());
    Ok(json!({"type": "setup", "rows": rows, "log": log, "ready": ready}))
}

/// Compile with the writer's own TeX: latexmk (MacTeX, TeX Live) or else Tectonic. On failure,
/// returns the lines of the log that say what went wrong.
async fn run_latex(file: &Path, out: &Path) -> Result<(), String> {
    let text = fs::read_to_string(file).unwrap_or_default();
    let program = re(r"(?i)%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)").captures(&text).map(|c| c[1].to_lowercase());
    let mut cmd = if on_path("latexmk") {
        let engine = match program.as_deref() {
            Some("xelatex") => "-pdfxe",
            Some("lualatex") => "-pdflua",
            _ => "-pdf",
        };
        let mut cmd = Command::new("latexmk");
        cmd.args([engine, "-interaction=nonstopmode", "-synctex=1", "-file-line-error"]).arg(format!("-outdir={}", out.display()));
        cmd
    } else if on_path("tectonic") {
        let mut cmd = Command::new("tectonic");
        // Keep what TeX wrote for references and contents, and read it back on the next build:
        // TeX then runs once, not three times, unless a reference changed (on 34 pages, 0.6 s
        // instead of 1.3 s). A failed build keeps none of it, so an error cannot stick.
        cmd.args(["--synctex", "--keep-logs", "--keep-intermediates", "-Z"]).arg(format!("search-path={}", out.display()));
        cmd.arg("--outdir").arg(out);
        cmd
    } else {
        return Err("LaTeX preview needs TeX. Install MacTeX (tug.org/mactex) or Tectonic (brew install tectonic).".into());
    };
    fs::create_dir_all(out).map_err(err)?;
    let o = cmd.arg(file.file_name().unwrap()).current_dir(file.parent().unwrap()).stdin(Stdio::null()).output().await.map_err(err)?;
    if o.status.success() {
        return Ok(());
    }
    let log = String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr);
    let lines: Vec<&str> = log.lines().collect();
    let errors: Vec<&str> = lines.iter().copied().filter(|l| l.starts_with('!') || l.contains(".tex:") || l.starts_with("error")).take(8).collect();
    Err(if errors.is_empty() { lines[lines.len().saturating_sub(8)..].join("\n") } else { errors.join("\n") })
}

/// Quarto renders the file, serves it, and renders it again on every save.
async fn quarto_preview(rel: &str, asked: u64) -> Result<(), String> {
    let (file, id) = {
        let mut w = ws();
        let Some(id) = w.start_preview(asked) else { return Ok(()) };
        (w.path(rel)?, id)
    };
    let port = free_port()?;
    let mut child = Command::new("quarto")
        .arg("preview")
        .arg(file.file_name().unwrap())
        .args(["--no-browser", "--host", "127.0.0.1", "--port", &port.to_string()])
        .current_dir(file.parent().unwrap())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| if e.kind() == ErrorKind::NotFound { "Quarto preview needs Quarto: quarto.org/docs/get-started".into() } else { err(e) })?;
    // Keep what it prints last, to say why it failed.
    let said = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let (stdout, stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    tokio::spawn(keep_lines(stdout, said.clone()));
    tokio::spawn(keep_lines(stderr, said.clone()));
    keep_preview(child, id);
    // Wait until it listens: the first render can take a while (R or Python code runs in it).
    for _ in 0..1200 {
        if ws().preview_id != id {
            return Ok(()); // another preview replaced this one
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            send(json!({"type": "preview", "path": rel, "kind": "live", "url": format!("http://127.0.0.1:{port}/")}));
            return Ok(());
        }
        let exited = ws().preview_proc.as_mut().map(|c| c.try_wait().is_ok_and(|s| s.is_some()));
        if exited == Some(true) {
            return Err(format!("Quarto could not render {rel}:\n{}", why(&lock(&said).join("\n"))));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("Quarto took more than two minutes to render {rel}."))
}

/// What a tool printed when it failed, short: its "ERROR: ..." line and what follows up to the
/// stack trace, or else its last lines.
pub fn why(output: &str) -> String {
    let output = re(r"\x1b\[[0-9;]*m").replace_all(output, "");
    let lines: Vec<&str> = output.lines().collect();
    let from = lines.iter().position(|l| l.trim_start().to_lowercase().starts_with("error")).unwrap_or(lines.len().saturating_sub(8));
    let why: Vec<&str> = lines[from..].iter().copied().take_while(|l| !l.starts_with("Stack trace")).take(8).collect();
    why.join("\n").trim_end().to_string()
}

async fn keep_lines(stream: impl tokio::io::AsyncRead + Unpin, said: std::sync::Arc<Mutex<Vec<String>>>) {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let mut said = lock(&said);
        said.push(line);
        if said.len() > 40 {
            said.remove(0);
        }
    }
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
            // The click went to the preview's own web view: the keys go back to the editor.
            if let Some(page) = APP.get().and_then(|app| app.get_webview("main")) {
                let _ = page.set_focus();
            }
        }
    }
}

// ---------- export ----------

/// Export formats: the file extension, Pandoc's name for it, and Quarto's.
const FORMATS: [(&str, &str, &str); 8] = [
    ("pdf", "pdf", "pdf"),
    ("docx", "docx", "docx"),
    ("odt", "odt", "odt"),
    ("html", "html", "html"),
    ("epub", "epub", "epub"),
    ("md", "markdown", "md"),
    ("tex", "latex", "latex"),
    ("typ", "typst", "typst"),
];

static EXPORTED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new()); // the files "reveal" may open

/// Export the document `rel` belongs to as `to` (a file extension). Asks where to save.
/// None: the writer cancelled.
async fn export(rel: &str, to: &str) -> Result<Option<PathBuf>, String> {
    let (root, file, bib) = {
        let w = ws();
        let main = w.main_of(rel);
        let bib = w.bib_file(&main).ok().filter(|(_, linked)| *linked).and_then(|(b, _)| w.path(&b).ok());
        (w.root()?.to_path_buf(), w.path(&main)?, bib)
    };
    if !FORMATS.iter().any(|f| f.0 == to) {
        return Err(format!("Quire cannot export to .{to}."));
    }
    let name = file.with_extension(to).file_name().unwrap().to_string_lossy().into_owned();
    let Some(dest) = save_dialog(file.parent().unwrap(), &name).await else {
        return Ok(None);
    };
    send(json!({"type": "exporting", "name": dest.file_name().map(|n| n.to_string_lossy())}));
    // One folder per document, outside the project. LaTeX reuses its build files there.
    let tmp = std::env::temp_dir().join(format!("quire-export-{:x}", hash(&file)));
    let made = tmp.join(format!("{}.{to}", file.file_stem().unwrap().to_string_lossy()));
    let _ = fs::remove_file(&made); // never hand over an older export
    convert(&file, &root, to, bib, &tmp).await?;
    if !made.is_file() {
        return Err(format!("The export made no .{to} file."));
    }
    if let (Ok(rel), Ok(text)) = (dest.strip_prefix(&root), read_text(&made)) {
        let mut w = ws();
        if w.is_text(rel) {
            w.known.insert(rel.to_string_lossy().into_owned(), text); // the writer's own file, not a change to review
        }
    }
    fs::copy(&made, &dest).map_err(err)?;
    lock(&EXPORTED).push(dest.clone());
    Ok(Some(dest))
}

/// Write `file` as `to` into `tmp`, with the tool that suits the language: the app's own Typst
/// for Typst PDF and web page, the writer's TeX for LaTeX PDF, Quarto for Quarto and Markdown,
/// Pandoc for the rest.
async fn convert(file: &Path, root: &Path, to: &str, bib: Option<PathBuf>, tmp: &Path) -> Result<(), String> {
    fs::create_dir_all(tmp).map_err(err)?; // a document's first build
    let (_, writer, quarto_format) = FORMATS.iter().copied().find(|f| f.0 == to).unwrap();
    let lang = lang_of(&file.to_string_lossy());
    let name = file.file_name().unwrap();
    let out = tmp.join(file.with_extension(to).file_name().unwrap());
    let mut cmd = match (lang, to) {
        (Lang::Typst, "pdf") => return engine::build(file, root, &out).await.map_err(|e| why(&e)),
        (Lang::Typst, "html") => {
            engine::build(file, root, &out).await.map_err(|e| why(&e))?;
            // Typst's web page comes with no style: give it the app's.
            let html = fs::read_to_string(&out).map_err(err)?;
            return fs::write(&out, html.replacen("</head>", &format!("<style>{DOCUMENT_CSS}</style></head>"), 1)).map_err(err);
        }
        (Lang::Latex, "pdf") => return run_latex(file, tmp).await,
        (Lang::Typst, "docx") => {
            // Pandoc reads Typst only in part: it fails on packages such as cetz. Typst
            // writes the document as HTML, and Pandoc turns that into Word.
            let html = out.with_extension("html");
            engine::build(file, root, &html).await.map_err(|e| why(&e))?;
            picture_files(&html)?;
            let mut cmd = pandoc()?;
            // Typst's web page keeps <h1> for the title: its = headings are <h2>.
            cmd.args(["-f", "html", "-t", "docx", "--shift-heading-level-by=-1"]).arg(&html).arg("-o").arg(&out);
            cmd.arg("--reference-doc").arg(style_file("reference.docx", REFERENCE_DOCX)?);
            cmd
        }
        // Quarto documents keep Quarto's own look (and the one their settings choose); Markdown
        // gets the app's, from Pandoc, as its preview has. Not Typst source: Quarto writes that
        // next to the document, over any file of that name.
        (Lang::Quarto, _) | (Lang::Markdown, "pdf") if to != "typ" && on_path("quarto") => {
            let format = match quarto_format {
                "pdf" => quarto_pdf(&fs::read_to_string(file).unwrap_or_default()),
                f => f,
            };
            let mut cmd = Command::new("quarto");
            cmd.arg("render").arg(name).args(["--to", format, "--output-dir"]).arg(tmp);
            if to == "html" {
                cmd.args(["-M", "embed-resources:true"]); // one file, images inside
            }
            cmd
        }
        (Lang::Markdown, "pdf") => return Err("PDF from Markdown needs Quarto: quarto.org/docs/get-started".into()),
        _ => {
            let mut cmd = pandoc()?;
            let from = match lang {
                Lang::Typst => "typst",
                Lang::Latex => "latex",
                _ => "markdown",
            };
            cmd.args(["-f", from, "-t", writer]).arg(name).arg("-o").arg(&out);
            match to {
                "tex" | "typ" => {
                    cmd.arg("-s"); // a whole document, with its preamble
                }
                "md" => {}
                _ => {
                    // Citations become text, from the .bib file the document names.
                    cmd.arg("--citeproc");
                    if let Some(bib) = &bib {
                        cmd.arg("--bibliography").arg(bib);
                    }
                    if to == "html" {
                        cmd.args(["-s", "--embed-resources", "--mathml", "--css"]).arg(style_file("document.css", DOCUMENT_CSS.as_bytes())?);
                    }
                    if to == "docx" {
                        cmd.arg("--reference-doc").arg(style_file("reference.docx", REFERENCE_DOCX)?);
                    }
                }
            }
            cmd
        }
    };
    let _rendering = cmd.as_std().get_args().next().is_some_and(|a| a == "render").then(|| Rendering::start(file));
    let o = cmd.current_dir(file.parent().unwrap()).stdin(Stdio::null()).output().await.map_err(err)?;
    if !o.status.success() {
        return Err(why(&(String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr))));
    }
    Ok(())
}

/// Typst's web page holds its pictures as base64 text, and Pandoc takes seconds over each large
/// one: write them to files next to the page, which Pandoc reads at once.
fn picture_files(html: &Path) -> Result<(), String> {
    let text = fs::read_to_string(html).map_err(err)?;
    let mut n = 0;
    let text = re(r#"src="data:image/([\w+]+);base64,([^"]*)""#).replace_all(&text, |c: &regex::Captures| {
        n += 1;
        let file = html.with_extension(format!("{n}.{}", c[1].trim_end_matches("+xml")));
        match unbase64(&c[2]).map(|bytes| fs::write(&file, bytes)) {
            Some(Ok(())) => format!("src=\"{}\"", file.display()),
            _ => c[0].to_string(), // left as it was: slower, still right
        }
    });
    fs::write(html, text.as_bytes()).map_err(err)
}

/// Standard base64, as in a data: URL. None when it is not base64.
fn unbase64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.trim_end_matches('=').bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6 | v as u32) & 0xffff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// How a document looks: as a web page (the Markdown preview's look too) and in Word.
const DOCUMENT_CSS: &str = include_str!("../../web/document.css");
const REFERENCE_DOCX: &[u8] = include_bytes!("../style/reference.docx");

/// A file of the app's own, written where Pandoc can read it.
fn style_file(name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let p = std::env::temp_dir().join(format!("quire-{name}"));
    if fs::read(&p).ok().as_deref() != Some(bytes) {
        fs::write(&p, bytes).map_err(err)?;
    }
    Ok(p)
}

/// Documents Quarto renders now (no end yet), or finished rendering under two seconds ago.
/// What it writes next to one for that time (`report.typ`, `report_files/`) is its own work:
/// not a change to review, not a file for the explorer, and no reason to build again.
static RENDERING: Mutex<Vec<(PathBuf, Option<Instant>)>> = Mutex::new(Vec::new());

/// `doc` renders until this is dropped.
struct Rendering(PathBuf);

impl Rendering {
    fn start(doc: &Path) -> Self {
        lock(&RENDERING).push((doc.into(), None));
        Rendering(doc.into())
    }
}

impl Drop for Rendering {
    fn drop(&mut self) {
        if let Some(r) = lock(&RENDERING).iter_mut().find(|(d, end)| *d == self.0 && end.is_none()) {
            r.1 = Some(Instant::now());
        }
        // Then the explorer shows what Quarto left (an export into the project, say).
        tauri::async_runtime::spawn(async {
            tokio::time::sleep(Duration::from_millis(2100)).await;
            let w = ws();
            if w.root.is_some() {
                send(w.state());
            }
        });
    }
}

/// Whether `p` is a file Quarto writes next to a document it is rendering.
fn quarto_output(p: &Path) -> bool {
    const OUT: [&str; 9] = ["typ", "tex", "pdf", "docx", "odt", "epub", "html", "md", "quarto_ipynb"];
    let mut r = lock(&RENDERING);
    r.retain(|(_, end)| end.is_none_or(|t| t.elapsed() < Duration::from_secs(2)));
    r.iter().any(|(doc, _)| {
        let (Some(dir), Some(stem)) = (doc.parent(), doc.file_stem()) else { return false };
        let Some(first) = p.strip_prefix(dir).ok().and_then(|rest| rest.components().next()) else { return false };
        let (name, stem) = (first.as_os_str().to_string_lossy(), stem.to_string_lossy());
        let out = Path::new(&*name).extension().and_then(|e| e.to_str()).is_some_and(|e| OUT.contains(&e));
        p != doc && (name == format!("{stem}_files") || (name.starts_with(&format!("{stem}.")) && out))
    })
}

/// Quarto's way to a PDF: through Typst, which Quarto carries, so no TeX is needed. A
/// document whose front matter sets up LaTeX PDF keeps it.
fn quarto_pdf(text: &str) -> &'static str {
    let front = text.strip_prefix("---").and_then(|t| t.split("\n---").next()).unwrap_or("");
    if re(r"(?m)^(format:\s*pdf\b|\s+pdf\s*:)").is_match(front) { "pdf" } else { "typst" }
}

/// Pandoc on its own, or the copy inside Quarto.
fn pandoc() -> Result<Command, String> {
    if on_path("pandoc") {
        return Ok(Command::new("pandoc"));
    }
    if let Some(inside) = quarto_pandoc() {
        return Ok(Command::new(inside));
    }
    if on_path("quarto") {
        let mut cmd = Command::new("quarto");
        cmd.arg("pandoc");
        return Ok(cmd);
    }
    Err("Export to Word and other formats needs Pandoc (brew install pandoc) or Quarto (quarto.org).".into())
}

/// The Pandoc inside Quarto, run directly: `quarto pandoc` takes half a second to start it.
/// Quarto keeps it in tools/<arch>/ next to its own launcher.
fn quarto_pandoc() -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let quarto = std::env::split_paths(&paths).map(|d| d.join("quarto")).find(|p| p.is_file())?;
    let p = quarto.canonicalize().ok()?.parent()?.join("tools").join(std::env::consts::ARCH).join("pandoc");
    p.is_file().then_some(p)
}

/// The macOS save dialog. None: cancelled.
async fn save_dialog(dir: &Path, name: &str) -> Option<PathBuf> {
    let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"POSIX path of (choose file name with prompt "Export as" default name "{}" default location (POSIX file "{}"))"#,
        escape(name),
        escape(&dir.to_string_lossy())
    );
    let out = Command::new("osascript").args(["-e", &script]).stderr(Stdio::null()).output().await.ok()?;
    Some(PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())).filter(|p| !p.as_os_str().is_empty())
}

/// Add the paper for a DOI or arXiv ID to the .bib file. Returns its key.
async fn cite(ident: &str, from: &str) -> Result<Value, String> {
    let doi = doi_of(ident)?;
    let (rel, linked, p) = {
        let w = ws();
        let (rel, linked) = w.bib_file(from)?;
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
    let mut w = ws();
    // Read again: the agent or the writer may have changed it while doi.org answered.
    let text = if p.exists() { read_text(&p)? } else { String::new() };
    let key = cite_key(entry, &BIB_KEY.captures_iter(&text).map(|c| c[1].to_string()).collect());
    let at = m.get(1).unwrap();
    let entry = format!("{}{key}{}", &entry[..at.start()], &entry[at.end()..]);
    let new = if text.trim().is_empty() { String::new() } else { format!("{}\n\n", text.trim_end()) } + &entry + "\n";
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
    match BRIDGE.start(agent_id, &root).await {
        Ok(true) => send(json!({"type": "agent", "id": agent_id, "ready": true})),
        Ok(false) => {}
        Err(e) => BRIDGE.failed(agent_id, e),
    }
    Ok(())
}

/// Start the agent again, as if the writer picked it (when it quit on its own).
pub fn restart_agent(id: &str) {
    tokio::spawn(safe(json!({"type": "set_agent", "id": id})));
}

async fn pick_folder(prompt: &str) -> Option<String> {
    let out = Command::new("osascript")
        .args(["-e", &format!(r#"POSIX path of (choose folder with prompt "{prompt}")"#)])
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|p| !p.is_empty())
}

/// The kinds of new project: id, name, starter file and its text.
const TEMPLATES: [(&str, &str, &str, &str); 4] = [
    ("typst", "Typst", "main.typ", include_str!("../templates/main.typ")),
    ("latex", "LaTeX", "main.tex", include_str!("../templates/main.tex")),
    ("quarto", "Quarto", "index.qmd", include_str!("../templates/index.qmd")),
    ("markdown", "Markdown", "main.md", include_str!("../templates/main.md")),
];

/// Put the starter file of a new project in `dir`, never over a file already there.
fn write_template(dir: &str, (_, _, file, text): (&str, &str, &str, &str)) -> Result<(), String> {
    let p = Path::new(dir).join(file);
    fs::File::create_new(&p).map_err(|e| match e.kind() {
        ErrorKind::AlreadyExists => format!("{file} already exists in that folder. Open it with Open Project instead."),
        _ => e.to_string(),
    })?;
    fs::write(&p, text).map_err(err)
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
// page still showing another folder can never write into this one.
const FILE_OPS: [&str; 11] = ["open_file", "save", "typed", "review", "create", "rename", "delete", "preview", "restore", "cite", "export"];

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
        "hello" => hello(),
        "open_folder" | "new_project" => {
            // A new project: its kind first, then the folder, which gets the kind's starter file.
            let template = match t {
                "new_project" => {
                    let kind = f("kind")?;
                    Some(*TEMPLATES.iter().find(|k| k.0 == kind).ok_or(format!("Unknown project type: {kind}"))?)
                }
                _ => None,
            };
            let prompt = template.map_or("Open a project folder".into(), |k| format!("Choose the folder for the new {} project", k.1));
            let path = match opt("path").filter(|p| !p.is_empty()) {
                Some(p) => Some(p.to_string()),
                None => pick_folder(&prompt).await,
            };
            if let Some(path) = path {
                if let Some(k) = template {
                    write_template(&path, k)?;
                }
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
        "typed" => ws().typed(f("path")?, f("content")?)?,
        "review" => {
            // Review decisions (accept/reject) while the text itself is not saved yet.
            let mut w = ws();
            let rel = w.norm(f("path")?)?;
            w.set_baseline(&rel, None, opt("baseline").map(String::from));
        }
        "create" => ws().create(f("path")?, msg["folder"].as_bool().unwrap_or(false))?,
        "rename" => ws().rename(f("from")?, f("to")?)?,
        "delete" => ws().delete(f("path")?)?,
        "preview" => preview(f("path")?, f("to")?, msg["asked"].as_u64().unwrap_or(0)).await?,
        "scroll_preview" => ws().scroll_preview(f("path")?, &msg["line"], &msg["col"])?,
        "cite" => {
            let mut result = cite(f("id")?, opt("path").unwrap_or("")).await?;
            (result["type"], result["req"]) = ("cite_result".into(), msg["req"].clone());
            send(result);
        }
        "prompt" => chat(f("text")?, opt("path"), opt("selection")).await,
        "cancel" => BRIDGE.cancel("chat").await,
        "permission" => BRIDGE.answer_permission(f("id")?, opt("option").map(String::from)),
        "set_agent" => start_agent(f("id")?).await?,
        "check_setup" => {
            let mut found = setup().await?;
            found["quiet"] = msg["quiet"].clone(); // the start page asks, and wants no dialog
            send(found);
        }
        "troubleshooting" => {
            Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" }).arg(TROUBLESHOOTING).spawn().map_err(err)?;
        }
        "set_option" => BRIDGE.set_option(f("kind")?, f("id")?, msg["value"].clone()).await?,
        "inline" => {
            let text = BRIDGE.inline(f("path")?, f("instruction")?, f("selected")?, f("before")?, f("after")?).await?;
            send(json!({"type": "inline_result", "req": msg["req"], "text": text}));
        }
        "complete" => {
            let prompt = complete_prompt(f("prompt")?, opt("path").unwrap_or(""), f("before")?, f("after")?);
            let text = match opt("url") {
                Some(url) => complete_api(f("kind")?, url, f("model")?, opt("key").unwrap_or(""), &prompt).await?,
                None => BRIDGE.complete(&prompt).await?,
            };
            send(json!({"type": "complete_result", "req": msg["req"], "text": text}));
        }
        "warm" => {
            if BRIDGE.running() {
                BRIDGE.session(f("kind")?).await?; // no agent yet: it warms up when the agent starts
            }
        }
        "restore" => ws().restore(msg["turn"].as_u64().ok_or("'turn' is missing")?)?,
        "export" => {
            let path = export(f("path")?, f("to")?).await?;
            send(json!({"type": "exported", "req": msg["req"], "path": path.map(|p| p.to_string_lossy().into_owned())}));
        }
        "reveal" => {
            let path = PathBuf::from(f("path")?);
            if !lock(&EXPORTED).contains(&path) {
                return Err("Only exported files open from here.".into());
            }
            let finder = msg["finder"].as_bool().unwrap_or(false);
            #[cfg(target_os = "macos")]
            Command::new("open").args(finder.then_some("-R")).arg(path).spawn().map_err(err)?;
            // Linux file managers share no "show this file": open its folder instead.
            #[cfg(not(target_os = "macos"))]
            Command::new("xdg-open").arg(if finder { path.parent().unwrap_or(&path) } else { &path }).spawn().map_err(err)?;
        }
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

/// What a page that has just loaded shows first. Later changes come as they happen.
fn hello() {
    let mut agents: Vec<Value> = registry().into_iter().map(|a| json!({"id": a.id, "name": a.name})).collect();
    agents.sort_by_key(|a| a["name"].as_str().unwrap_or("").to_lowercase());
    let agent = BRIDGE.agent_id().unwrap_or(DEFAULT_AGENT.into());
    send(json!({"type": "hello", "agents": agents, "agent": agent}));
    send(ws().state());
    // Whether the agent runs: an agent that failed before the page listened stays not running,
    // and the page still hears why.
    if BRIDGE.starting() {
        let name = find_agent(&agent).map_or(agent.clone(), |a| a.name);
        send(json!({"type": "status", "text": format!("Starting {name}...")}));
    } else {
        send(json!({"type": "agent", "id": agent, "ready": BRIDGE.running(), "error": BRIDGE.error()}));
    }
    for (kind, options) in BRIDGE.all_options() {
        send(json!({"type": "options", "kind": kind, "options": options}));
    }
    for question in BRIDGE.open_permissions() {
        send(question); // a reloaded page must still be able to answer
    }
}

/// A message from the page.
pub fn receive(msg: Value) {
    if let Some(inbox) = INBOX.get() {
        let _ = inbox.send(msg);
    }
}

/// Take the page's messages from now on. Opens `folder` first when given.
pub fn start(app: AppHandle, folder: Option<String>) {
    let _ = APP.set(app);
    let (tx, mut rx) = unbounded_channel::<Value>();
    let _ = INBOX.set(tx);
    tauri::async_runtime::spawn(async move {
        while let Some(mut msg) = rx.recv().await {
            if msg["type"] == "preview" {
                // Numbered in the order the page asked, before they run side by side.
                let mut w = ws();
                w.asked += 1;
                msg["asked"] = w.asked.into();
            }
            if matches!(msg["type"].as_str(), Some("save" | "review" | "typed")) {
                safe(msg).await; // in order, so an older save or text never lands after a newer one
            } else {
                tokio::spawn(safe(msg));
            }
        }
    });
    if let Some(folder) = folder {
        receive(json!({"type": "open_folder", "path": folder}));
    }
}

/// The `quire://` address, for the preview frame: the Markdown and PDF viewers (built with the
/// page), the project's files (images in the Markdown preview) and the LaTeX PDF. One address,
/// so the viewers may read those files.
pub fn protocol(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let path = percent_encoding::percent_decode_str(path).decode_utf8_lossy();
    let file = if let Some(rel) = path.strip_prefix("/file/") {
        (!skipped(Path::new(rel))).then(|| ws().path(rel).ok()).flatten() // hidden files stay hidden
    } else if matches!(&*path, "/pdf" | "/docx" | "/html") {
        ws().built.as_ref().filter(|b| path[1..] == *b.to).map(|b| b.out.join(Path::new(&b.main).with_extension(b.to).file_name().unwrap()))
    } else {
        return match app.asset_resolver().get(path.into_owned()) {
            Some(asset) => Response::builder().header("content-type", asset.mime_type).body(asset.bytes).unwrap(),
            None => Response::builder().status(404).body(vec![]).unwrap(),
        };
    };
    let Some((file, bytes)) = file.and_then(|f| fs::read(&f).ok().map(|b| (f, b))) else {
        return Response::builder().status(404).body(vec![]).unwrap();
    };
    let kind = match file.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    };
    // "sandbox": a file opened on its own (an SVG, say) runs as no site and cannot run script.
    Response::builder()
        .header("content-type", kind)
        .header("content-security-policy", "sandbox")
        .header("cache-control", "no-store")
        .body(bytes)
        .unwrap()
}

/// Stop the agent and the preview, which run as their own processes.
pub fn shutdown() {
    let agent = BRIDGE.stop();
    ws().stop_preview();
    // Wait: an npx still downloading the agent would outlive Quire and keep its folder locked.
    for ending in agent {
        let _ = ending.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map<V: Clone>(pairs: &[(&str, V)]) -> BTreeMap<String, V> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn quarto_output() {
        let doc = Path::new("/q/report.qmd");
        assert!(!super::quarto_output(Path::new("/q/report.typ"))); // nothing renders yet
        let rendering = Rendering::start(doc);
        for p in ["/q/report.typ", "/q/report.docx", "/q/report.knit.md", "/q/report_files/libs/a.js"] {
            assert!(super::quarto_output(Path::new(p)), "{p}");
        }
        for p in ["/q/report.qmd", "/q/report.bib", "/q/other.typ", "/q/sub/report.typ", "/q/reports.typ"] {
            assert!(!super::quarto_output(Path::new(p)), "{p}");
        }
        drop(rendering);
        assert!(super::quarto_output(Path::new("/q/report.typ"))); // still, for a moment
    }

    #[test]
    fn picture_files() {
        assert_eq!(unbase64("aGVsbG8gd29ybGQ="), Some(b"hello world".to_vec()));
        assert_eq!((unbase64("TWE="), unbase64("TQ=="), unbase64("")), (Some(b"Ma".to_vec()), Some(b"M".to_vec()), Some(vec![])));
        assert_eq!(unbase64("a$b"), None);
        let dir = std::env::temp_dir().join(format!("quire-pictures-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let html = dir.join("main.html");
        fs::write(&html, r#"<img src="data:image/png;base64,aGk="><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="a.png">"#).unwrap();
        super::picture_files(&html).unwrap();
        let (png, svg) = (dir.join("main.1.png"), dir.join("main.2.svg"));
        let want = format!(r#"<img src="{}"><img src="{}"><img src="a.png">"#, png.display(), svg.display());
        assert_eq!(fs::read_to_string(&html).unwrap(), want);
        assert_eq!((fs::read(&png).unwrap(), fs::read_to_string(&svg).unwrap()), (b"hi".to_vec(), "<svg>".into()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn typed() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        let (tx, mut rx) = unbounded_channel();
        let mut w = Workspace { root: Some(root.clone()), known: map(&[("a.typ", "disk".to_string())]), control: Some(tx), ..Default::default() };
        let file = root.join("a.typ").to_string_lossy().into_owned();
        w.typed("a.typ", "typed").unwrap();
        assert_eq!(rx.try_recv().unwrap(), json!({"event": "updateMemoryFiles", "files": {&file: "typed"}}).to_string());
        w.external("a.typ", "disk".into()); // the disk as the editor last saved it: the typed text stays
        assert!(rx.try_recv().is_err());
        w.external("a.typ", "agent".into()); // someone else wrote it: the preview reads the disk
        assert_eq!(rx.try_recv().unwrap(), json!({"event": "removeMemoryFiles", "files": [&file]}).to_string());
        w.external("a.typ", "agent again".into());
        assert!(rx.try_recv().is_err()); // it already does
    }

    #[test]
    fn new_project() {
        let dir = std::env::temp_dir().join(format!("quire-new-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let d = dir.to_str().unwrap();
        for k in TEMPLATES {
            write_template(d, k).unwrap();
            assert_eq!(fs::read_to_string(dir.join(k.2)).unwrap(), k.3);
        }
        // The writer's own file is kept, not replaced by the template.
        fs::write(dir.join("main.typ"), "mine").unwrap();
        assert!(write_template(d, TEMPLATES[0]).is_err());
        assert_eq!(fs::read_to_string(dir.join("main.typ")).unwrap(), "mine");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_text() {
        let p = std::env::temp_dir().join(format!("quire-bom-{}.typ", std::process::id()));
        fs::write(&p, "\u{feff}= Title\r\nText \u{feff}kept\r").unwrap();
        assert_eq!(super::read_text(&p).unwrap(), "= Title\nText \u{feff}kept\n");
        let _ = fs::remove_file(&p);
    }

    #[tokio::test]
    async fn convert_into_a_new_folder() {
        // A document never built before: its build folder does not exist yet.
        let dir = std::env::temp_dir().join(format!("quire-convert-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.typ"), "= Hello").unwrap();
        let out = dir.join("never-made");
        convert(&dir.join("main.typ"), &dir, "html", None, &out).await.unwrap();
        assert!(fs::read_to_string(out.join("main.html")).unwrap().contains("Hello"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn workspace() {
        let dir = std::env::temp_dir().join(format!("quire-test-{}", std::process::id()));
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

            // A file the agent moves away comes back with Restore.
            fs::write(root.join("ch.typ"), "one").unwrap();
            w.known.insert("ch.typ".into(), "one".into());
            w.turn = 2;
            fs::rename(root.join("ch.typ"), root.join("moved.typ")).unwrap();
            w.gone("ch.typ");
            w.external("moved.typ", "one".into());
            w.restore(2).unwrap();
            assert_eq!(text("ch.typ"), "one");
            assert!(!root.join("moved.typ").exists() && !w.known.contains_key("moved.typ"));

            // Restoring a later turn keeps the earlier turn's changes waiting for review.
            w.turn = 3;
            w.external("ch.typ", "two".into());
            w.turn = 4;
            w.external("ch.typ", "three".into());
            w.restore(4).unwrap();
            assert_eq!(text("ch.typ"), "two");
            assert_eq!(w.baseline.get("ch.typ").map(String::as_str), Some("one"));
            w.baseline.clear();

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
        assert_eq!(blank_hidden(r"a \$ <x> $m$ https://y.z <w> // c", Lang::Typst), r"a \$ <x>     https://y.z <w>     ");

        // LaTeX: \label and the \ref family, but not in comments (\% is no comment) or verbatim.
        // Quarto: {#...} attributes and chunk labels, but not in comments.
        let found = labels(&map(&[
            ("paper.tex", "\\section{A}\\label{sec:a} 5\\% \\label{pct}\nSee \\ref{sec:a}, \\cref{sec:a,fig:b}. % \\label{old}\n\\begin{verbatim}\n\\label{no}\n\\end{verbatim}".to_string()),
            ("report.qmd", "## A {#sec-q}\nSee @sec-q.\n```{r}\n#| label: fig-b\nplot(1)\n```\n<!-- {#sec-old} -->".to_string()),
            ("notes.md", "# A {#sec-md}".to_string()),
        ]));
        let found: Vec<_> = found.iter().map(|f| (f["name"].as_str().unwrap(), f["line"].as_u64().unwrap(), f["refs"].as_u64().unwrap())).collect();
        assert_eq!(found, [("sec:a", 0, 2), ("pct", 0, 0), ("sec-q", 0, 1), ("fig-b", 3, 0)]);
        assert_eq!(language_name("a/b.qmd"), "Quarto");
        assert_eq!(quarto_pdf("---\ntitle: A pdf guide\nformat: html\n---\nformat: pdf"), "typst");
        assert_eq!(quarto_pdf("---\nformat: pdf\n---"), "pdf");
        assert_eq!(quarto_pdf("---\nformat:\n  pdf:\n    toc: true\n---"), "pdf");

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
        let r = cite("10.1038/nature14539", "main.typ").await.unwrap();
        assert_eq!(r, json!({"key": "lecun2015", "bib": "refs.bib", "linked": true, "added": false}));

        // Each language finds its .bib file its own way, and the LaTeX main file.
        {
            let mut w = ws();
            w.known = map(&[
                ("ch/one.tex", "% !TEX root = ../paper.tex\n\\section{One}".to_string()),
                ("ch/two.tex", "\\section{Two}".to_string()),
                ("paper.tex", "\\documentclass{article}\n\\bibliography{lit/refs}".to_string()),
                ("_quarto.yml", "project:\n  type: default\nbibliography:\n  - refs/quarto.bib".to_string()),
            ]);
            assert_eq!(w.bib_file("ch/one.tex").unwrap(), ("lit/refs.bib".to_string(), true));
            assert_eq!(w.bib_file("report.qmd").unwrap(), ("refs/quarto.bib".to_string(), true));
            assert_eq!(w.bib_file("main.typ").unwrap(), ("refs.bib".to_string(), false));
            assert_eq!(w.latex_main("ch/one.tex"), "paper.tex");
            assert_eq!(w.latex_main("ch/two.tex"), "paper.tex");
            assert_eq!(w.latex_main("paper.tex"), "paper.tex");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
