//! Quire, a macOS app (Linux builds are experimental). The window shows the editor (web/);
//! this side opens the project, runs the agent and the previews, and talks to the page
//! through Tauri's own messages.

mod agent;
mod engine;
mod project;

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::process::Command;
#[cfg(not(windows))] // only shell_path's login shell (Mac, Linux) reads no stdin with it
use std::process::Stdio;
use std::sync::{Mutex, MutexGuard};
#[cfg(windows)]
use std::time::{Duration, Instant};

use serde_json::Value;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::webview::WebviewBuilder;
#[cfg(windows)]
use tauri::window::Color;
use tauri::window::WindowBuilder;
use tauri::{LogicalPosition, LogicalSize, Manager, Rect, RunEvent, WebviewUrl};
#[cfg(unix)]
use tokio::signal::unix::{signal, SignalKind};

/// A lock whose holder panicked still holds good data here: use it rather than fail every
/// later request.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(unix)]
use libc::{SIGKILL, SIGTERM};
#[cfg(windows)]
const SIGTERM: i32 = 15;
#[cfg(windows)]
const SIGKILL: i32 = 9;

/// A preview or an agent runs in a process group of its own (`process_group(0)`), so that a
/// signal to the group reaches all it started. Signal 0 only asks whether any of it still
/// runs: 0 is yes.
#[cfg(unix)]
fn killpg(group: i32, signal: i32) -> i32 {
    unsafe { libc::killpg(group, signal) }
}

/// Windows has neither groups nor signals: `taskkill /T` ends a process and all it started,
/// at once, whatever the signal.
#[cfg(windows)]
fn killpg(pid: i32, signal: i32) -> i32 {
    if signal != 0 {
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).output();
    }
    -1 // nothing of it runs any more
}

/// So that starting a process reads the same on Windows, where this does nothing.
#[cfg(windows)]
trait ProcessGroup {
    fn process_group(&mut self, _: i32) -> &mut Self;
}
#[cfg(windows)]
impl ProcessGroup for tokio::process::Command {
    fn process_group(&mut self, _: i32) -> &mut Self {
        self
    }
}

/// Previews, builds and agents are tools the writer never types at: on Windows each would
/// open a console window of its own, so the app starts them without one. Elsewhere this
/// reads as part of the chain and does nothing.
#[cfg(windows)]
pub(crate) trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}
#[cfg(windows)]
impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        self.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
    }
}
#[cfg(not(windows))]
pub(crate) trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}
#[cfg(not(windows))]
impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        self
    }
}

/// Scroll bars that stay in view in the previews (tinymist, Quarto, the PDF and Markdown
/// pages), as in the editor: macOS hides them until one scrolls. It runs in every frame, at
/// the start, because WebKit styles a scroll bar only when its box is made.
const PREVIEW_SCROLLBARS: &str = r#"if (window !== top) document.documentElement.append(Object.assign(document.createElement("style"), { textContent: `
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-thumb { background: rgb(140 140 140 / 0.7); border: 3px solid transparent; border-radius: 6px; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background-color: rgb(140 140 140 / 0.95); }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }` }))"#;

/// tinymist's preview draws only the pages in view. It shows the other pages as canvases
/// inside its SVG, which WebKit paints at the wrong place, over the first pages: hide them (a
/// page is blank until it scrolls into view). And draw the pages that scroll in at once:
/// tinymist waits half a second after a scroll, but draws as soon as the window resizes.
const TINYMIST_PARTIAL: &str = r#"if (window !== top) {
  document.documentElement.append(Object.assign(document.createElement("style"), { textContent: ".typst-svg-mixin-canvas { display: none !important; }" }))
  let queued = 0
  addEventListener("scroll", (e) => {
    if (e.target.id === "typst-container-main" && !queued) queued = setTimeout(() => { queued = 0; dispatchEvent(new Event("resize")) }, 50)
  }, true)
}"#;

/// Every message from the page comes through here.
#[tauri::command]
fn message(app: tauri::AppHandle, msg: Value) {
    match msg["type"].as_str() {
        Some("restart") => app.request_restart(), // to open an installed update; the page saved first
        Some("preview_frame") => place_preview(&app, &msg),
        #[cfg(windows)]
        Some("preview_color") => preview_color(&app, &msg),
        _ => project::receive(msg),
    }
}

/// The preview is a web view of its own, with its own process: a long document drawing there
/// never holds up typing in the page. The page says where its preview panel is and how tall
/// the page shows, in window points, and its zoom; no "w" hides it (no preview, or a dialog or
/// menu over the panel).
fn place_preview(app: &tauri::AppHandle, msg: &Value) {
    #[cfg(windows)]
    place_preview_queued(app, msg);
    #[cfg(not(windows))]
    place_preview_at_once(app, msg)
}

/// macOS and Linux answer every ask at once: WebKit draws where it is told and keeps up.
#[cfg(not(windows))]
fn place_preview_at_once(app: &tauri::AppHandle, msg: &Value) {
    let (Some(view), Some(page)) = (app.get_webview("preview"), app.get_webview("main")) else { return };
    let n = |k: &str| msg[k].as_f64();
    // The page's web view fills the window, title bar included, and WebKit starts the page
    // below the title bar: what the page does not show is the title bar's height.
    let full = page.size().map_or(0.0, |s| s.to_logical::<f64>(page.window().scale_factor().unwrap_or(1.0)).height);
    let top = n("shown").map_or(0.0, |shown| (full - shown).max(0.0));
    let _ = match (n("x"), n("y"), n("w"), n("h"), n("zoom")) {
        (Some(x), Some(y), Some(w), Some(h), Some(zoom)) => view
            .set_zoom(zoom)
            .and_then(|_| view.set_bounds(Rect { position: LogicalPosition::new(x, top + y).into(), size: LogicalSize::new(w, h).into() }))
            .and_then(|_| view.show()),
        _ => view.hide(),
    };
}

/// On Windows every ask crosses into the web view's process, which is also redrawing the
/// document at its new size; answered as fast as they come (many a second while the writer
/// drags the sash or the window's edge), the web view falls behind and the preview lands
/// late, over the page's own view. So at most one draw runs every so often, answering the
/// newest ask, and when the asks stop coming, a last draw answers the last one.
#[cfg(windows)]
struct PreviewPlace {
    shown: Option<(f64, f64, f64, f64, f64, f64)>, // x, y, w, h, zoom, shown height
    asked: Option<(f64, f64, f64, f64, f64, f64)>, // the newest ask not drawn yet
    drawn: Option<Instant>,                        // when the web view last moved
    queued: bool,                                  // a draw is on its way for a later ask
    bg: Option<(u8, u8, u8)>,                      // the color last painted behind the document
}

#[cfg(windows)]
static PLACE: Mutex<PreviewPlace> = Mutex::new(PreviewPlace { shown: None, asked: None, drawn: None, queued: false, bg: None });

#[cfg(windows)]
const DRAW_EVERY: Duration = Duration::from_millis(40);

#[cfg(windows)]
fn place_preview_queued(app: &tauri::AppHandle, msg: &Value) {
    let n = |k: &str| msg[k].as_f64();
    let ask = match (n("x"), n("y"), n("w"), n("h"), n("zoom"), n("shown")) {
        (Some(x), Some(y), Some(w), Some(h), Some(zoom), Some(shown)) => Some((x, y, w, h, zoom, shown)),
        _ => None,
    };
    let due = {
        let mut place = lock(&PLACE);
        place.asked = ask;
        if place.queued {
            return; // a draw is already on its way; it takes this newest ask
        }
        match place.drawn {
            Some(t) if ask.is_some() && t.elapsed() < DRAW_EVERY => {
                place.queued = true;
                Some(DRAW_EVERY - t.elapsed()) // too soon since the last draw: answer when it is due
            }
            _ => None, // due now — or a hide, which answers at once: a dialog waits to be seen
        }
    };
    match due {
        Some(wait) => {
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(wait);
                let queued = app.clone();
                let _ = app.run_on_main_thread(move || draw_preview(&queued));
            });
        }
        None => draw_preview(app),
    }
}

/// Draw (or hide) the preview as the page last asked. Every draw runs on the main thread —
/// the page's asks arrive here too — and the lock never crosses a call that could wait on
/// another thread.
#[cfg(windows)]
fn draw_preview(app: &tauri::AppHandle) {
    let (Some(view), Some(page)) = (app.get_webview("preview"), app.get_webview("main")) else { return };
    let mut place = lock(&PLACE);
    place.queued = false;
    // The page's web view fills the window, title bar included, and WebKit starts the page
    // below the title bar: what the page does not show is the title bar's height.
    let full = page.size().map_or(0.0, |s| s.to_logical::<f64>(page.window().scale_factor().unwrap_or(1.0)).height);
    let _ = match place.asked {
        Some((x, y, w, h, zoom, shown)) => {
            if place.shown == place.asked {
                return; // already there
            }
            let top = (full - shown).max(0.0);
            let mut drawn = Ok(());
            // The zoom changes only from the page's own menu, and every call crosses into
            // the web view's process: ask for it only when it changed.
            if place.shown.map_or(true, |s| s.4 != zoom) {
                drawn = view.set_zoom(zoom);
            }
            drawn = drawn.and_then(|_| {
                view.set_bounds(Rect { position: LogicalPosition::new(x, top + y).into(), size: LogicalSize::new(w, h).into() })
            });
            if place.shown.is_none() {
                drawn = drawn.and_then(|_| view.show()); // it starts hidden; once shown it stays so
            }
            if drawn.is_ok() {
                place.shown = place.asked;
                place.drawn = Some(Instant::now());
            }
            drawn
        }
        None => {
            let was = place.shown.take().is_some();
            place.drawn = Some(Instant::now());
            if was {
                view.hide()
            } else {
                Ok(()) // it starts hidden anyway
            }
        }
    };
}

/// While the web view moves, WebView2 paints white in the places not yet drawn — in every
/// theme. The page knows what color the panel is (it changes with the theme); watch it from
/// the page's own start, and say so whenever the theme changes.
#[cfg(windows)]
const PREVIEW_COLOR_WATCHER: &str = r#"{
  const say = () => {
    const el = document.getElementById("preview")
    if (el) window.__TAURI_INTERNALS__.invoke("message", { msg: { type: "preview_color", color: getComputedStyle(el).backgroundColor } }).catch(() => {})
  }
  say()
  addEventListener("DOMContentLoaded", say)
  new MutationObserver(say).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
}"#;

/// The colored layer paints comments and emphasis in the editor font's own italic, whose
/// glyphs run wider than the regular ones the text field draws behind them (the field has
/// one face for everything). A comment that wraps then wraps at other words in the field,
/// and every line under it drifts: clicks write a line away from where the writer aimed,
/// and selections take in text they do not show. Slant the regular glyphs instead: the same
/// widths, so both layers wrap as one, and near the same look.
#[cfg(windows)]
const EDITOR_TOKEN_METRICS: &str = r#"{
  const style = document.createElement("style")
  style.textContent = ".layer .tk-comment, .layer .tk-emphasis { font-style: oblique 10deg }"
  document.documentElement.append(style)
}"#;

/// Paint the web view's own background the panel's color, when it changed: every call
/// crosses into the web view's process.
#[cfg(windows)]
fn preview_color(app: &tauri::AppHandle, msg: &Value) {
    let Some(s) = msg["color"].as_str() else { return };
    // "rgb(60, 60, 60)", or "rgba" with an alpha the numbers after it make no difference to.
    let rgb: Vec<u8> = s
        .split('(')
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .map(|inner| inner.split(',').filter_map(|p| p.trim().parse::<f64>().ok().map(|v| v as u8)).collect())
        .unwrap_or_default();
    if rgb.len() < 3 {
        return;
    }
    let color = (rgb[0], rgb[1], rgb[2]);
    {
        let mut place = lock(&PLACE);
        if place.bg == Some(color) {
            return;
        }
        place.bg = Some(color);
    }
    if let Some(view) = app.get_webview("preview") {
        let _ = view.set_background_color(Some(Color(color.0, color.1, color.2, 255)));
    }
}

fn main() {
    // Set PATH before any thread starts. The bundled tinymist sits next to the app's own
    // program (a signed sidecar), and is found first.
    let bin = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.to_path_buf()));
    // The app looks its bundled tinymist up by plain name; the installer leaves it under the
    // -<target triple> name Tauri gives sidecars. Copy it beside the app's own program, once,
    // where the PATH below looks first.
    #[cfg(windows)]
    if let Some(dir) = &bin {
        let plain = dir.join("tinymist.exe");
        if !plain.exists() {
            let named = std::fs::read_dir(dir).ok().and_then(|d| {
                d.flatten().map(|e| e.path()).find(|p| {
                    let name = p.file_name().map_or(String::new(), |n| n.to_string_lossy().into_owned());
                    name.starts_with("tinymist-") && name.ends_with(".exe")
                })
            });
            if let Some(from) = named {
                let _ = std::fs::copy(from, &plain);
            }
        }
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    std::env::set_var("PATH", format!("{}{sep}{}", bin.unwrap_or_default().display(), shell_path()));
    let folder = std::env::args().nth(1); // a folder to open at start: cargo run -- sample
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![message]);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_dialog::init()); // folder pickers, save dialogs
    builder
        .register_asynchronous_uri_scheme_protocol("quire", |ctx, request, responder| {
            let (app, path) = (ctx.app_handle().clone(), request.uri().path().to_string());
            std::thread::spawn(move || responder.respond(project::protocol(&app, &path))); // files can be large
        })
        .setup(move |app| {
            // What the registry keeps may be newer than the PATH this app was started with
            // (Tectonic installed after the terminal that opened Quire, say): read it before
            // anything looks a tool up. (~0.3 s, once, at start.)
            #[cfg(windows)]
            tauri::async_runtime::block_on(project::refresh_path());
            // Our errors and the agents' logs (their stderr) go to a file: an app has no terminal.
            // ponytail: not on Windows, where they go to the console the app opens; SetStdHandle would.
            #[cfg(unix)]
            {
                let logs = app.path().app_log_dir()?;
                std::fs::create_dir_all(&logs)?;
                let log = File::create(logs.join("agent.log"))?;
                unsafe {
                    libc::dup2(log.as_raw_fd(), 1);
                    libc::dup2(log.as_raw_fd(), 2);
                }
            }
            project::start(app.handle().clone(), folder.clone());
            #[cfg(not(debug_assertions))] // a dev build has no app bundle to replace
            {
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // ponytail: by then the page listens for messages; keep the news for "hello" if a slow start ever misses it.
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    while !update(&app, false).await {
                        tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
                    }
                });
            }

            // Started from a terminal: Ctrl+C, a kill or a closed terminal quits the normal way,
            // which stops the agent and the preview (they run as their own processes) too.
            #[cfg(unix)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut quit = [SignalKind::interrupt(), SignalKind::terminate(), SignalKind::hangup()]
                        .map(|kind| signal(kind).expect("could not listen for signals"));
                    let [int, term, hup] = &mut quit;
                    tokio::select! {
                        _ = int.recv() => {}
                        _ = term.recv() => {}
                        _ = hup.recv() => {}
                    }
                    handle.exit(0);
                });
            }

            let name = app.package_info().name.clone(); // productName in tauri.conf.json
            let window = WindowBuilder::new(app, "main").title(&name).inner_size(1400.0, 900.0).build()?;
            let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
            #[cfg(windows)]
            let main_page = WebviewBuilder::new("main", WebviewUrl::App("index.html".into()))
                .auto_resize()
                .initialization_script(PREVIEW_COLOR_WATCHER)
                .initialization_script(EDITOR_TOKEN_METRICS);
            #[cfg(not(windows))]
            let main_page = WebviewBuilder::new("main", WebviewUrl::App("index.html".into())).auto_resize();
            window.add_child(main_page, LogicalPosition::new(0.0, 0.0), size)?;
            // The preview's own web view, on top of the page; hidden until the page places it.
            let preview = WebviewBuilder::new("preview", WebviewUrl::App("preview.html".into()))
                .initialization_script_for_all_frames(PREVIEW_SCROLLBARS)
                .initialization_script_for_all_frames(TINYMIST_PARTIAL);
            window.add_child(preview, LogicalPosition::new(0.0, 0.0), LogicalSize::new(0.0, 0.0))?.hide()?;

            // The built-in Quit ends the app without asking the page about unsaved changes.
            // This one closes the window, which asks first. Linux gets no menu bar: closing the
            // window is the way out there, and it asks too.
            #[cfg(target_os = "macos")]
            {
                let menu = Menu::default(app.handle())?;
                if let Some(MenuItemKind::Submenu(m)) = menu.items()?.first() {
                    m.remove_at(m.items()?.len() - 1)?;
                    m.append(&MenuItem::with_id(app, "quit", format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?)?;
                    m.insert(&MenuItem::with_id(app, "setup", "Check Setup…", true, None::<&str>)?, 1)?;
                    #[cfg(not(debug_assertions))] // a dev build has no app bundle to replace
                    m.insert(&MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?, 1)?; // under About
                }
                app.set_menu(menu)?;
            }
            Ok(())
        })
        .on_menu_event(|app, e| match e.id().as_ref() {
            "quit" => {
                if let Some(w) = app.get_window("main") {
                    let _ = w.close();
                }
            }
            "setup" => project::receive(serde_json::json!({"type": "check_setup"})),
            "update" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { update(&app, true).await });
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("could not start the app")
        .run(|_, event| {
            if let RunEvent::Exit = event {
                project::shutdown(); // the agent and the preview run as their own processes
            }
        });
}

/// Updates come from the latest GitHub release, checked after start, then daily, and when
/// asked from the menu. One is installed in the background and opens at the next start; the
/// page offers a restart now. Only when asked does the page also hear "none" or a failure.
/// True once one is installed.
async fn update(app: &tauri::AppHandle, asked: bool) -> bool {
    use tauri_plugin_updater::UpdaterExt;
    // One check at a time, so the daily one and the menu's never download twice.
    static INSTALLED: tokio::sync::Mutex<Option<String>> = tokio::sync::Mutex::const_new(None);
    let mut installed = INSTALLED.lock().await;
    if let Some(version) = installed.as_ref() {
        project::send(serde_json::json!({"type": "update_ready", "version": version}));
        return true;
    }
    let name = &app.package_info().name;
    let notice = |kind: &str, message: String| {
        eprintln!("{message}");
        if asked {
            project::send(serde_json::json!({"type": "notice", "kind": kind, "message": message}));
        }
    };
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    match found {
        Ok(Some(update)) => {
            notice("info", format!("Downloading {name} {}…", update.version));
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => {
                    project::send(serde_json::json!({"type": "update_ready", "version": update.version}));
                    *installed = Some(update.version);
                    return true;
                }
                Err(e) => notice("error", format!("Could not install {name} {}: {e}", update.version)),
            }
        }
        Ok(None) => notice("info", format!("{name} {} is the latest version.", app.package_info().version)),
        Err(e) => notice("error", format!("Could not check for updates: {e}")),
    }
    false
}

/// Apps opened from Finder get a bare PATH without Homebrew, so `npx` and `node` (which most
/// agents need) would be missing. Ask the login shell for the PATH the writer's terminal has.
#[cfg(not(windows))]
fn shell_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    Command::new(shell)
        .args(["-ilc", "printf '__PATH__%s' \"$PATH\""])
        .stdin(Stdio::null())
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).rsplit_once("__PATH__").map(|(_, p)| p.trim().to_string()))
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

/// No login shell to ask on Windows: Git Bash's `sh` would answer with POSIX-style paths
/// (/c/Program Files/..., separated by colons) that mean nothing to Windows, and every
/// program would vanish from PATH. What the app was started with is the terminal's own.
#[cfg(windows)]
fn shell_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}
