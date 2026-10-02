//! Quire, a macOS app (Linux builds are experimental). The window shows the editor (web/);
//! this side opens the project, runs the agent and the previews, and talks to the page
//! through Tauri's own messages.

mod agent;
mod engine;
mod project;

use std::fs::File;
use std::os::fd::AsRawFd;
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tokio::signal::unix::{signal, SignalKind};

/// A lock whose holder panicked still holds good data here: use it rather than fail every
/// later request.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Scroll bars that stay in view in the previews (tinymist, Quarto, the PDF and Markdown
/// pages), as in the editor: macOS hides them until one scrolls. It runs in every frame, at
/// the start, because WebKit styles a scroll bar only when its box is made.
const PREVIEW_SCROLLBARS: &str = r#"if (window !== top) document.documentElement.append(Object.assign(document.createElement("style"), { textContent: `
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-thumb { background: rgb(140 140 140 / 0.7); border: 3px solid transparent; border-radius: 6px; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background-color: rgb(140 140 140 / 0.95); }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }` }))"#;

/// Every message from the page comes through here.
#[tauri::command]
fn message(app: tauri::AppHandle, msg: Value) {
    match msg["type"].as_str() {
        Some("restart") => app.request_restart(), // to open an installed update; the page saved first
        _ => project::receive(msg),
    }
}

fn main() {
    // Set PATH before any thread starts. The bundled tinymist sits next to the app's own
    // program (a signed sidecar), and is found first.
    let bin = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.to_path_buf()));
    std::env::set_var("PATH", format!("{}:{}", bin.unwrap_or_default().display(), shell_path()));
    let folder = std::env::args().nth(1); // a folder to open at start: cargo run -- sample
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![message])
        .register_asynchronous_uri_scheme_protocol("quire", |ctx, request, responder| {
            let (app, path) = (ctx.app_handle().clone(), request.uri().path().to_string());
            std::thread::spawn(move || responder.respond(project::protocol(&app, &path))); // files can be large
        })
        .setup(move |app| {
            // Our errors and the agents' logs (their stderr) go to a file: an app has no terminal.
            let logs = app.path().app_log_dir()?;
            std::fs::create_dir_all(&logs)?;
            let log = File::create(logs.join("agent.log"))?;
            unsafe {
                libc::dup2(log.as_raw_fd(), 1);
                libc::dup2(log.as_raw_fd(), 2);
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

            let name = app.package_info().name.clone(); // productName in tauri.conf.json
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(&name)
                .inner_size(1400.0, 900.0)
                .initialization_script_for_all_frames(PREVIEW_SCROLLBARS)
                .build()?;

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
                if let Some(w) = app.get_webview_window("main") {
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
