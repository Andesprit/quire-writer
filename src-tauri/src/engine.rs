//! Typst inside the app, for the PDF, Word and web page that the previews and exports build.
//! It stays warm from one build to the next: the fonts are found once, and a change compiles
//! again from what the last build already worked out. The live preview is tinymist's.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use typst::diag::{FileResult, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Feature, Library, LibraryExt, World};
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
        self.files.source(id)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.file(id)
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

fn compile(file: &Path, root: &Path, out: &Path) -> Result<(), String> {
    let main = VirtualPath::virtualize(root, file).map_err(|e| e.to_string())?;
    let main = RootedPath::new(VirtualRoot::Project, main).intern();
    // Held until the build ends: one build at a time, each from where the last one left off.
    let mut last = lock(&LAST);
    let mut project = match last.take() {
        Some(mut p) if p.root == root => {
            p.files.reset(); // read the files again; the ones unchanged compile from memory
            p.time.reset();
            p
        }
        _ => {
            let packages = SystemPackages::new(SystemDownloader::new(concat!("quire/", env!("CARGO_PKG_VERSION"))));
            Project {
                root: root.into(),
                main,
                library: LazyHash::new(Library::builder().with_features([Feature::Html].into_iter().collect()).build()),
                files: FileStore::new(SystemFiles::new(FsRoot::new(root.into()), packages)),
                time: Time::system(),
            }
        }
    };
    project.main = main;
    let made = if out.extension().is_some_and(|e| e == "pdf") {
        typst::compile::<PagedDocument>(&project).output.and_then(|doc| typst_pdf::pdf(&doc, &PdfOptions::default()))
    } else {
        let html = typst::compile::<HtmlDocument>(&project).output;
        html.and_then(|doc| typst_html::html(&doc, &HtmlOptions { pretty: false })).map(String::into_bytes)
    };
    typst::comemo::evict(10); // keep what the last builds worked out, not every build's
    let result = match made {
        Ok(bytes) => fs::write(out, bytes).map_err(|e| e.to_string()),
        Err(errors) => Err(describe(&project, &errors)),
    };
    *last = Some(project);
    result
}

fn describe(project: &Project, errors: &[SourceDiagnostic]) -> String {
    let mut text = NoColor::new(Vec::new());
    let _ = emit(&mut text, project, errors, DiagnosticFormat::Human);
    String::from_utf8_lossy(&text.into_inner()).into_owned()
}
