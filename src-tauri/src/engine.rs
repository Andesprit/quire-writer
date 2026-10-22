//! Typst inside the app, for the PDF, Word and web page that the previews and exports build.
//! It stays warm from one build to the next: the fonts are found once, and a change compiles
//! again from what the last build already worked out. The live preview is tinymist's.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde_json::{json, Value};
use typst::diag::{FileResult, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Feature, Library, LibraryExt, World, WorldExt};
use typst_html::{HtmlDocument, HtmlOptions};
use typst_kit::datetime::Time;
use typst_kit::diagnostics::{emit, termcolor::NoColor, DiagnosticFormat, DiagnosticWorld};
use typst_kit::downloader::SystemDownloader;
use typst_kit::files::{FileStore, FsRoot, SystemFiles};
use typst_kit::fonts::{self, FontStore};
use typst_kit::packages::SystemPackages;
use typst_layout::PagedDocument;
use typst_pdf::PdfOptions;

use crate::lock;

/// The computer's fonts and Typst's own, found once: the search takes a good part of a second.
static FONTS: LazyLock<FontStore> = LazyLock::new(|| {
    let mut store = FontStore::new();
    store.extend(fonts::system());
    store.extend(fonts::embedded());
    store
});

/// The project built last, kept for the next build.
static LAST: Mutex<Option<Project>> = Mutex::new(None);

struct Project {
    root: PathBuf,
    main: FileId,
    library: LazyHash<Library>,
    files: FileStore<SystemFiles>,
    time: Time,
    typed: HashMap<FileId, Source>,
}

impl World for Project {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        FONTS.book()
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.typed.get(&id).cloned().map(Ok).unwrap_or_else(|| self.files.source(id))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.typed.get(&id).map(|s| Ok(Bytes::new(s.text().as_bytes().to_vec()))).unwrap_or_else(|| self.files.file(id))
    }

    fn font(&self, index: usize) -> Option<Font> {
        FONTS.font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.time.today(offset)
    }
}

impl DiagnosticWorld for Project {
    fn name(&self, id: FileId) -> String {
        let path = id.get();
        match path.root() {
            VirtualRoot::Project => path.vpath().get_without_slash().into(),
            VirtualRoot::Package(package) => format!("{package}{}", path.vpath().get_with_slash()),
        }
    }
}

/// Compile `file` of the project folder `root` into `out`: a PDF, or else a web page. On
/// failure, what Typst says is wrong, as tinymist says it.
pub async fn build(file: &Path, root: &Path, out: &Path) -> Result<(), String> {
    let (file, root, out) = (file.to_path_buf(), root.to_path_buf(), out.to_path_buf());
    let (tx, rx) = tokio::sync::oneshot::channel();
    // A thread of its own: a deeply nested document needs more stack than other threads get.
    std::thread::Builder::new()
        .stack_size(32 << 20)
        .spawn(move || {
            let _ = tx.send(compile(&file, &root, &out));
        })
        .map_err(|e| e.to_string())?;
    rx.await.unwrap_or_else(|_| Err("Typst stopped while compiling this document.".into()))
}

/// Reuse fonts, library and compile caches for diagnostics and exports. An export always
/// clears the memory overlay: only the writer's saved files belong in an exported document.
fn with_project<T>(file: &Path, root: &Path, typed: &BTreeMap<String, String>, run: impl FnOnce(&Project) -> T) -> Result<T, String> {
    let main = VirtualPath::virtualize(root, file).map_err(|e| e.to_string())?;
    let main = RootedPath::new(VirtualRoot::Project, main).intern();
    let mut last = lock(&LAST);
    let mut project = match last.take() {
        Some(mut p) if p.root == root => {
            p.files.reset();
            p.time.reset();
            p
        }
        _ => {
            let packages = SystemPackages::new(SystemDownloader::new(concat!("quire/", env!("CARGO_PKG_VERSION"))));
            Project {
                root: root.into(), main,
                library: LazyHash::new(Library::builder().with_features([Feature::Html].into_iter().collect()).build()),
                files: FileStore::new(SystemFiles::new(FsRoot::new(root.into()), packages)),
                time: Time::system(),
                typed: HashMap::new(),
            }
        }
    };
    project.main = main;
    project.typed = typed.iter().filter_map(|(path, text)| {
        let path = VirtualPath::virtualize(root, &root.join(path)).ok()?;
        let id = RootedPath::new(VirtualRoot::Project, path).intern();
        Some((id, Source::new(id, text.clone())))
    }).collect();
    let result = run(&project);
    typst::comemo::evict(10);
    *last = Some(project);
    Ok(result)
}

pub fn warm(file: &Path, root: &Path) {
    let _ = with_project(file, root, &BTreeMap::new(), |_| { let _ = FONTS.book(); });
}

/// Structured errors for the source as typed. Positions are zero-based UTF-16, as in a
/// textarea; package errors retain their message but cannot jump outside the project.
pub fn diagnostics(file: &Path, root: &Path, typed: &BTreeMap<String, String>) -> Result<Vec<Value>, String> {
    with_project(file, root, typed, |project| {
        typst::compile::<PagedDocument>(project).output.err().unwrap_or_default().iter().map(|e| {
            let source = e.span.id().and_then(|id| project.source(id).ok());
            let range = project.range(e.span);
            let position = |at: usize| {
                let text = source.as_ref().map_or("", |s| s.text());
                let prefix = &text[..at.min(text.len())];
                (prefix.bytes().filter(|b| *b == b'\n').count(), prefix.rsplit('\n').next().unwrap_or("").encode_utf16().count())
            };
            let (line, col) = position(range.as_ref().map_or(0, |r| r.start));
            let (end_line, end_col) = position(range.as_ref().map_or(0, |r| r.end));
            let path = e.span.id().and_then(|id| matches!(id.get().root(), VirtualRoot::Project).then(|| project.name(id)));
            // A file that is not there: the quoted path the span marks, so the page can offer the right file.
            let file = e.message.starts_with("file not found").then(|| {
                let text = source.as_ref()?.text();
                text.get(range.as_ref()?.clone()).map(|t| t.trim_matches('"').to_string())
            }).flatten();
            json!({"path": path, "line": line, "col": col, "end_line": end_line, "end_col": end_col, "file": file,
                "message": e.message.as_str(), "hints": e.hints.iter().map(|h| h.v.as_str()).collect::<Vec<_>>()})
        }).collect()
    })
}

fn compile(file: &Path, root: &Path, out: &Path) -> Result<(), String> {
    with_project(file, root, &BTreeMap::new(), |project| {
        let made = if out.extension().is_some_and(|e| e == "pdf") {
            typst::compile::<PagedDocument>(project).output.and_then(|doc| typst_pdf::pdf(&doc, &PdfOptions::default()))
        } else {
            typst::compile::<HtmlDocument>(project).output
                .and_then(|doc| typst_html::html(&doc, &HtmlOptions { pretty: false })).map(String::into_bytes)
        };
        match made {
            Ok(bytes) => fs::write(out, bytes).map_err(|e| e.to_string()),
            Err(errors) => Err(describe(project, &errors)),
        }
    })?
}

fn describe(project: &Project, errors: &[SourceDiagnostic]) -> String {
    let mut text = NoColor::new(Vec::new());
    let _ = emit(&mut text, project, errors, DiagnosticFormat::Human);
    String::from_utf8_lossy(&text.into_inner()).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn missing_file_names_the_quoted_path() {
        let root = std::env::temp_dir().join(format!("quire-missing-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("main.typ");
        fs::write(&file, "#image(\"figs/pic.png\")\n").unwrap();
        let errors = diagnostics(&file, &root, &BTreeMap::new()).unwrap();
        assert_eq!(errors[0]["file"], "figs/pic.png"); // Typst reports the first missing file only
        fs::write(&file, "#include \"ch.typ\"\n").unwrap();
        assert_eq!(diagnostics(&file, &root, &BTreeMap::new()).unwrap()[0]["file"], "ch.typ");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unsaved_diagnostics_and_utf16_positions() {
        let root = std::env::temp_dir().join(format!("quire-diagnostics-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("main.typ");
        let original = include_str!("../../sample/main.typ");
        fs::write(&file, original).unwrap();
        let broken = original.replacen("== Fermentation", "#let x = (\n#foo(bar\n== Fermentation", 1);
        let errors = diagnostics(&file, &root, &BTreeMap::from([("main.typ".into(), broken)])).unwrap();
        assert_eq!(errors[0]["path"], "main.typ");
        assert_eq!(errors[0]["line"], 8); // zero-based on the wire
        assert_eq!(errors[0]["col"], 9);
        assert_eq!(errors[0]["message"], "unclosed delimiter");
        assert!(errors.iter().any(|d| d["hints"].as_array().is_some_and(|h| !h.is_empty())));
        assert_eq!(fs::read_to_string(&file).unwrap(), original, "diagnostics never save typed text");
        let unicode = "🍞 café #foo()\n";
        let errors = diagnostics(&file, &root, &BTreeMap::from([("main.typ".into(), unicode.into())])).unwrap();
        assert_eq!(errors[0]["col"], "🍞 café #".encode_utf16().count());
        assert_eq!(errors[0]["message"], "unknown variable: foo");
        assert!(diagnostics(&file, &root, &BTreeMap::new()).unwrap().is_empty(), "fixed disk source replaces the overlay");
        fs::write(root.join("chapter.typ"), "Chapter\n").unwrap();
        let errors = diagnostics(&file, &root, &BTreeMap::from([
            ("main.typ".into(), "#include \"chapter.typ\"".into()),
            ("chapter.typ".into(), "#missing()".into()),
        ])).unwrap();
        assert_eq!(errors[0]["path"], "chapter.typ");
        assert_eq!(errors[0]["message"], "unknown variable: missing");
        fs::remove_dir_all(root).unwrap();
    }
}
