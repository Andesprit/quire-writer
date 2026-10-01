//! Typst Writer. The desktop app shows the editor in a window. With --browser it serves the
//! same page to a browser instead (Chrome or Safari with the Grammarly extension).

mod agent;
mod server;

use std::fs::File;
use std::net::TcpListener;
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};

use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tokio::signal::unix::{signal, SignalKind};

/// A lock whose holder panicked still holds good data here: use it rather than fail every
/// later request.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--browser") => browser(args.next()),
        _ => desktop(),
    }
}

/// Serve the page on PORT (8765 by default), open it in the browser, and open `folder`.
fn browser(folder: Option<String>) {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8765);
    let url = format!("http://127.0.0.1:{port}");
    // Bind before starting anything: otherwise the agent starts, then the server fails to
    // bind, and an older copy keeps running unnoticed.
    let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) else {
        eprintln!(
            "Port {port} is busy: Typst Writer (or another program) is already running at {url}.\n\
             Stop it with Ctrl+C in its terminal, then start again. Or use another port: PORT=8766"
        );
        std::process::exit(1);
    };
    println!("Typst Writer on {url}");
    if std::env::var_os("NO_BROWSER").is_none() {
        let _ = Command::new("open").arg(&url).spawn();
    }
    let web = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/dist");
    tokio::runtime::Runtime::new().expect("could not start").block_on(async {
        // Ctrl+C or a plain kill: stop the agent and the preview too.
        let mut term = signal(SignalKind::terminate()).expect("could not listen for SIGTERM");
        tokio::select! {
            r = server::serve(listener, web, folder) => if let Err(e) = r { eprintln!("{e}") },
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
        server::shutdown();
    });
}

fn desktop() {
    // Set PATH before any thread starts. Resources/bin holds the bundled tinymist, found first.
    let resources = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.parent()?.join("Resources")));
    let bin = resources.unwrap_or_default().join("bin");
    std::env::set_var("PATH", format!("{}:{}", bin.display(), shell_path()));
    tauri::Builder::default()
        .setup(|app| {
            // Our errors and the agents' logs (their stderr) go to a file: an app has no terminal.
            let logs = app.path().app_log_dir()?;
            std::fs::create_dir_all(&logs)?;
            let log = File::create(logs.join("agent.log"))?;
            unsafe {
                libc::dup2(log.as_raw_fd(), 1);
                libc::dup2(log.as_raw_fd(), 2);
            }
            // Bound now, so the window can load the page as soon as the server runs.
            let listener = TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port();
            let web = app.path().resource_dir()?.join("web");
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::serve(listener, web, None).await {
                    eprintln!("{e}");
                }
            });
            let name = app.package_info().name.clone(); // productName in tauri.conf.json
            let url = format!("http://127.0.0.1:{port}").parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(&name)
                .inner_size(1400.0, 900.0)
                .build()?;

            // The built-in Quit ends the app without asking the page about unsaved changes.
            // This one closes the window, which asks first.
            let menu = Menu::default(app.handle())?;
            if let Some(MenuItemKind::Submenu(m)) = menu.items()?.first() {
                m.remove_at(m.items()?.len() - 1)?;
                m.append(&MenuItem::with_id(app, "quit", &format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?)?;
            }
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, e| {
            if e.id() == "quit" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("could not start the app")
        .run(|_, event| {
            if let RunEvent::Exit = event {
                server::shutdown(); // the agent and the preview run as their own processes
            }
        });
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
