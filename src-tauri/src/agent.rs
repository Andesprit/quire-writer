//! ACP bridge: one agent process with up to three sessions.
//!
//! - chat:     the chat bar. Its updates stream to the page as-is.
//! - inline:   select-and-edit. Replies with replacement text only.
//! - complete: autocomplete. Replies with the next few words only.
//!
//! Autocomplete can skip the agent: `complete_api` asks an OpenAI- or Anthropic-compatible API instead.
//!
//! Agents are started from agents.json, a copy of the ACP registry, so any agent listed
//! there (Claude, Codex, Gemini, ...) works by id. ACP is JSON-RPC, one message per line on
//! the agent's stdin and stdout.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Notify};

#[cfg(windows)]
use crate::ProcessGroup;
use crate::{killpg, lock, NoWindow, SIGKILL, SIGTERM};
use crate::project::{language_name, restart_agent, send, why};

const AGENTS: &str = include_str!("../../agents.json");
const NO_AGENT: &str = "No agent running. Open a folder first.";
const STOPPED: &str = "The agent stopped.";
const EFFORT_IDS: [&str; 3] = ["effort", "reasoning_effort", "thought_level"];
const FAST_MODEL_HINTS: [&str; 5] = ["haiku", "mini", "flash", "fast", "small"];
const LOW_EFFORT: [&str; 4] = ["minimal", "none", "off", "low"];
// An agent that quits on its own is started again, unless it quit this soon after it started:
// then it would most likely quit again, over and over.
const RESTART_AFTER: Duration = Duration::from_secs(30);
// A stopped agent gets this long to end on its own, then it is killed.
const KILL_AFTER: Duration = Duration::from_secs(2);

fn inline_prompt(path: &str, instruction: &str, selected: &str, before: &str, after: &str) -> String {
    format!(
        "You are editing a {} document ({path}). Rewrite the SELECTED text following the instruction.\n\
         Reply with ONLY the replacement text. No explanation, no quotes, no code fences. Do not use any tools.\n\
         If nothing is selected, reply with the text to insert at the cursor.\n\n\
         Instruction: {instruction}\n\n\
         Text before the selection:\n{before}\n\n\
         SELECTED:\n{selected}\n\n\
         Text after the selection:\n{after}",
        language_name(path)
    )
}

/// What autocomplete asks: the writer's instructions (the page has the default ones), then the
/// text around the cursor.
pub fn complete_prompt(instructions: &str, path: &str, before: &str, after: &str) -> String {
    format!("{}\n\n{before}<CURSOR>{after}", instructions.replace("{language}", language_name(path)))
}

pub struct Agent {
    pub id: String,
    pub name: String,
    argv: Vec<String>,
    env: Vec<(String, String)>,
}

impl Agent {
    /// What starts it: npx, uvx or its own program.
    pub fn program(&self) -> &str {
        &self.argv[0]
    }

    /// The command that signs the agent in (`npx <package> --setup`), for the ones that start
    /// with npx. None for the rest: they sign in their own way, or not at all.
    pub fn setup_command(&self) -> Option<String> {
        (self.argv[0] == "npx")
            .then(|| {
                let pkg = self.argv.iter().skip(1).find(|arg| !arg.starts_with('-'))?;
                Some(format!("npx {pkg} --setup"))
            })
            .flatten()
    }
}

/// The registry's name for this machine, e.g. darwin-aarch64.
fn platform() -> String {
    let os = if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// How to start a registry agent here. npx and uvx fetch the agent on first use; a binary
/// is never downloaded, so it must already be on PATH under its own name.
fn launch(entry: &Value) -> Option<Agent> {
    let d = &entry["distribution"];
    let binary = &d["binary"][platform().as_str()];
    let (e, mut argv): (&Value, Vec<String>) = if let Some(pkg) = d["npx"]["package"].as_str() {
        // --prefer-offline: a pinned version in the npx cache starts without asking npm.
        (&d["npx"], vec!["npx".into(), "--prefer-offline".into(), "-y".into(), pkg.into()])
    } else if let Some(pkg) = d["uvx"]["package"].as_str() {
        (&d["uvx"], vec!["uvx".into(), pkg.into()])
    } else if binary.is_object() {
        (binary, vec![binary["cmd"].as_str().unwrap_or("").rsplit('/').next().unwrap_or("").into()])
    } else {
        return None;
    };
    argv.extend(e["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(String::from)));
    let env = e["env"].as_object().into_iter().flatten();
    let id = entry["id"].as_str()?.to_string();
    Some(Agent {
        name: entry["name"].as_str().unwrap_or(&id).into(),
        id,
        argv,
        env: env.filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect(),
    })
}

/// `npx --prefer-offline` trusts npm's saved list of an agent's versions. A list saved before
/// the pinned version came out says that version does not exist (ETARGET): then start it
/// once more, and npm fetches a fresh list.
fn ask_npm_afresh(argv: &[String], error: &str) -> Option<Vec<String>> {
    (error.contains("ETARGET") && argv.iter().any(|a| a == "--prefer-offline"))
        .then(|| argv.iter().filter(|a| *a != "--prefer-offline").cloned().collect())
}

/// npx downloads an agent into its own folder, `_npx/<hash>`, on first start. A download cut
/// short (Quire quit during it) leaves that folder without package.json, and every later
/// start fails with ENOENT for it. The folder to remove, so that the next start downloads
/// the agent again.
// ponytail: npm prints "***" for any part of a path that looks like a UUID, so such a path
// is not found and the writer removes the folder by hand (Troubleshooting). Normal npm
// caches (~/.npm) have none.
fn broken_download(error: &str) -> Option<PathBuf> {
    let path = regex::Regex::new(r"(/[^\n']*/_npx/[0-9a-f]{16})/").unwrap().captures(error)?;
    error.contains("ENOENT").then(|| PathBuf::from(&path[1]))
}

pub fn registry() -> Vec<Agent> {
    // `atelier harness sync` (flow-atelier) writes a fresher copy here; use it when present.
    let user = std::env::var("HOME").map(|h| PathBuf::from(h).join(".atelier/acp_registry.json"));
    let raw: Value = user
        .ok()
        .and_then(|p| serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok())
        .unwrap_or_else(|| serde_json::from_str(AGENTS).expect("agents.json is valid JSON"));
    raw["agents"].as_array().into_iter().flatten().filter_map(launch).collect()
}

pub fn find_agent(id: &str) -> Result<Agent, String> {
    registry().into_iter().find(|a| a.id == id).ok_or_else(|| format!("Unknown agent: {id}"))
}

fn list(v: Option<&Value>) -> impl Iterator<Item = &Value> {
    v.and_then(Value::as_array).into_iter().flatten()
}

fn select_values(option: &Value) -> Vec<String> {
    let mut values = vec![];
    for entry in list(Some(&option["options"])) {
        let group: Vec<&Value> = if entry["options"].is_array() { list(Some(&entry["options"])).collect() } else { vec![entry] };
        values.extend(group.iter().filter_map(|o| o["value"].as_str().map(String::from)));
    }
    values
}

fn is_model(o: &Value) -> bool {
    o["category"] == "model" || o["id"] == "model"
}

fn is_effort(o: &Value) -> bool {
    o["category"] == "thought_level" || o["id"].as_str().is_some_and(|id| EFFORT_IDS.contains(&id))
}

/// One JSON-RPC connection to an agent process.
struct Conn {
    stdin: tokio::sync::Mutex<ChildStdin>,
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    group: i32, // its process group: npx starts the real agent as its own child
    started: Instant,
    said: Arc<Mutex<Vec<String>>>, // its last lines of error output: why it stopped
    child: Mutex<Child>,
}

impl Conn {
    async fn write(&self, msg: Value) -> Result<(), String> {
        let line = msg.to_string() + "\n";
        self.stdin.lock().await.write_all(line.as_bytes()).await.map_err(|_| STOPPED.to_string())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Relaxed);
        let (tx, rx) = oneshot::channel();
        lock(&self.waiting).insert(id, tx);
        self.write(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await?;
        rx.await.unwrap_or_else(|_| Err(STOPPED.into()))
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(json!({"jsonrpc": "2.0", "method": method, "params": params})).await
    }

    /// Ends its whole process group: SIGTERM, then SIGKILL for whatever still runs after
    /// KILL_AFTER. npm, while it downloads an agent, finishes its current step before it obeys
    /// SIGTERM, which can take minutes, and keeps the agent's npx folder locked until then.
    /// The handle finishes once all of it has ended.
    fn kill(self: &Arc<Self>) -> std::thread::JoinHandle<()> {
        let conn = self.clone();
        std::thread::spawn(move || {
            let group = conn.group;
            if group <= 0 {
                return;
            }
            killpg(group, SIGTERM);
            let until = Instant::now() + KILL_AFTER;
            loop {
                // Collect npx once it has ended: until then Linux counts it as running.
                let _ = lock(&conn.child).try_wait();
                if killpg(group, 0) != 0 {
                    return; // nothing in the group runs any more
                }
                if Instant::now() >= until {
                    killpg(group, SIGKILL);
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })
    }
}

/// The agent's error output goes to the app's log; its last lines are kept to say why it stopped.
async fn keep_stderr(stderr: ChildStderr, said: Arc<Mutex<Vec<String>>>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        eprintln!("{line}");
        let mut said = lock(&said);
        said.push(line);
        if said.len() > 40 {
            said.remove(0);
        }
    }
}

/// Everything the agent sends: replies to our requests, updates, and its own requests.
async fn read(conn: Arc<Conn>, stdout: ChildStdout, stderr: tokio::task::JoinHandle<()>) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line).await.is_ok_and(|n| n > 0) {
        let msg: Value = serde_json::from_slice(&line).unwrap_or_default();
        line.clear();
        match (msg["method"].as_str(), msg.get("id")) {
            (None, Some(id)) => {
                if let Some(tx) = id.as_u64().and_then(|id| lock(&conn.waiting).remove(&id)) {
                    let _ = tx.send(match msg.get("error") {
                        Some(e) => Err(e["message"].as_str().unwrap_or("The agent reported an error.").into()),
                        None => Ok(msg["result"].clone()),
                    });
                }
            }
            (Some("session/update"), None) => BRIDGE.session_update(&msg["params"]),
            (Some(method), Some(id)) => {
                let (conn, id, method, params) = (conn.clone(), id.clone(), method.to_string(), msg["params"].clone());
                tokio::spawn(async move {
                    let reply = if method == "session/request_permission" {
                        json!({"jsonrpc": "2.0", "id": id, "result": BRIDGE.request_permission(&params).await})
                    } else {
                        let error = json!({"code": -32601, "message": "Method not found", "data": {"method": method}});
                        json!({"jsonrpc": "2.0", "id": id, "error": error})
                    };
                    let _ = conn.write(reply).await;
                });
            }
            _ => {} // other notifications, or a line that is not JSON
        }
    }
    // It quit: requests still waiting fail with what it said last (npx failing, a Node.js too old).
    let _ = tokio::time::timeout(Duration::from_secs(1), stderr).await;
    let said = why(&lock(&conn.said).join("\n"));
    let stopped = if said.is_empty() { STOPPED.to_string() } else { format!("{STOPPED} It said:\n{said}") };
    for (_, tx) in lock(&conn.waiting).drain() {
        let _ = tx.send(Err(stopped.clone()));
    }
    BRIDGE.quit(&conn, &said);
}

pub static BRIDGE: LazyLock<Bridge> = LazyLock::new(Bridge::default);

#[derive(Default)]
pub struct Bridge {
    st: Mutex<State>,
    session_lock: tokio::sync::Mutex<()>, // two requests must not open two sessions of one kind
    inline_lock: tokio::sync::Mutex<()>,
    complete_lock: tokio::sync::Mutex<()>,
    completions: AtomicU64,
    newest_completion: AtomicU64,
    permissions: AtomicU64,
}

#[derive(Default)]
struct State {
    conn: Option<Arc<Conn>>,
    starting: Option<Arc<Conn>>, // started, not answered "initialize" yet
    agent_id: Option<String>,
    error: Option<String>, // why it last failed to start, for a page that loads later
    root: Option<PathBuf>,
    sessions: HashMap<String, String>,           // kind -> session id
    options: BTreeMap<String, Value>,            // kind -> config options
    chosen: HashMap<String, Map<String, Value>>, // kind -> user picks, re-applied to new sessions
    replies: HashMap<String, String>,            // session id -> reply so far
    pending: HashMap<String, (oneshot::Sender<Option<String>>, Value)>, // permission id -> answer, question
}

impl State {
    fn kind_of(&self, session_id: &str) -> Option<String> {
        self.sessions.iter().find(|(_, s)| *s == session_id).map(|(k, _)| k.clone())
    }

    /// The writer's picks to apply to a new `kind` session, the model first: effort choices
    /// depend on the model.
    fn picks_for(&self, kind: &str) -> Vec<(String, Value)> {
        let ids = |k: &str, keep: fn(&Value) -> bool| -> HashSet<String> {
            list(self.options.get(k)).filter(|o| keep(o)).filter_map(|o| o["id"].as_str().map(String::from)).collect()
        };
        let mut picks: Vec<(String, Value)> = if kind == "inline" {
            // Inline edits follow the chat model and effort, never its mode (a
            // permissive mode would let the inline session edit files).
            let shared = ids("chat", |o| is_model(o) || is_effort(o));
            self.chosen.get("chat").into_iter().flatten().filter(|(k, _)| shared.contains(*k)).map(|(k, v)| (k.clone(), v.clone())).collect()
        } else {
            self.chosen.get(kind).into_iter().flatten().map(|(k, v)| (k.clone(), v.clone())).collect()
        };
        let models = ids(kind, is_model);
        picks.sort_by_key(|(k, _)| !models.contains(k));
        picks
    }

    /// Smallest model (model=true) or lowest effort the complete session offers.
    fn fast_picks(&self, model: bool) -> Vec<(String, Value)> {
        let mut picks = vec![];
        for o in list(self.options.get("complete")) {
            if o["type"] != "select" {
                continue;
            }
            let values = select_values(o);
            let found = if model && is_model(o) {
                FAST_MODEL_HINTS.iter().find_map(|h| values.iter().find(|v| v.to_lowercase().contains(h)))
            } else if !model && is_effort(o) {
                LOW_EFFORT.iter().find_map(|h| values.iter().find(|v| v.to_lowercase() == *h))
            } else {
                continue;
            };
            if let (Some(id), Some(value)) = (o["id"].as_str(), found) {
                picks.push((id.to_string(), Value::from(value.as_str())));
            }
        }
        picks
    }
}

impl Bridge {
    fn st(&self) -> MutexGuard<'_, State> {
        lock(&self.st)
    }

    pub fn agent_id(&self) -> Option<String> {
        self.st().agent_id.clone()
    }

    pub fn set_agent_id(&self, id: &str) {
        self.st().agent_id = Some(id.into());
    }

    pub fn running(&self) -> bool {
        self.st().conn.is_some()
    }

    pub fn starting(&self) -> bool {
        self.st().starting.is_some()
    }

    pub fn error(&self) -> Option<String> {
        self.st().error.clone()
    }

    /// It could not start: the page shows why in Check Setup. On Windows, an agent that says
    /// to run `--setup` means its npx package (the bare name it prints, no terminal there
    /// runs): the command to copy comes along with the error.
    pub fn failed(&self, id: &str, error: String) {
        {
            let mut st = self.st();
            st.agent_id = Some(id.into()); // the page says this one is chosen: a Run opens its setup
            st.error = Some(error.clone());
        }
        #[cfg(windows)]
        let fix = find_agent(id).ok().and_then(|a| error.contains("--setup").then(|| a.setup_command()).flatten());
        #[cfg(not(windows))]
        let fix: Option<String> = None;
        send(json!({"type": "agent", "id": id, "ready": false, "error": error, "fix": fix}));
    }

    pub fn all_options(&self) -> Vec<(String, Value)> {
        self.st().options.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    fn send_options(&self, kind: &str) {
        let options = self.st().options.get(kind).cloned().unwrap_or_else(|| json!([]));
        send(json!({"type": "options", "kind": kind, "options": options}));
    }

    /// Ok(false): another start or a stop came first, and this agent was stopped.
    pub async fn start(&self, agent_id: &str, root: &Path) -> Result<bool, String> {
        let spec = find_agent(agent_id)?;
        self.stop();
        self.st().root = Some(root.into()); // set first: nothing may start a session in the previous folder
        self.st().error = None;
        let mut argv = spec.argv;
        #[cfg(windows)]
        if argv[0] == "npx" {
            argv = [Some("cmd".into()), Some("/c".into())].into_iter().flatten().chain(argv).collect();
        }
        let program = argv[0].clone();
        let mut cleaned = false;
        let conn = loop {
            let mut child = Command::new(&argv[0])
                .args(&argv[1..])
                .envs(spec.env.clone())
                .current_dir(root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0)
                .no_window()
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| format!("Could not start {program}: {e}"))?;
            let (stdin, stdout, stderr) = (child.stdin.take().unwrap(), child.stdout.take().unwrap(), child.stderr.take().unwrap());
            let said = Arc::new(Mutex::new(Vec::new()));
            let stderr = tokio::spawn(keep_stderr(stderr, said.clone()));
            let conn = Arc::new(Conn {
                stdin: stdin.into(),
                next: AtomicU64::new(0),
                waiting: Mutex::default(),
                group: child.id().unwrap_or(0) as i32,
                started: Instant::now(),
                said,
                child: Mutex::new(child),
            });
            tokio::spawn(read(conn.clone(), stdout, stderr));
            self.st().starting = Some(conn.clone()); // so a stop meanwhile stops it too
            let started = conn.request("initialize", json!({"protocolVersion": 1, "clientCapabilities": {}})).await;
            // A download cut short: remove it and start once more. Removing takes a moment, and
            // a stop meanwhile is seen below.
            let broken = (!cleaned).then(|| started.as_ref().err().and_then(|e| broken_download(e))).flatten().filter(|d| d.is_dir());
            if let Some(dir) = broken.clone() {
                cleaned = true;
                send(json!({"type": "status", "text": format!("Downloading {} again: its first download was cut short...", spec.name)}));
                let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(dir)).await;
            }
            let mut st = self.st();
            if !st.starting.as_ref().is_some_and(|c| Arc::ptr_eq(c, &conn)) {
                return Ok(false);
            }
            st.starting = None;
            if let Err(e) = started {
                conn.kill();
                if broken.is_none() {
                    argv = ask_npm_afresh(&argv, &e).ok_or(e)?;
                }
                continue;
            }
            if st.agent_id.as_deref() != Some(agent_id) {
                st.chosen.clear();
            }
            st.agent_id = Some(agent_id.into());
            st.conn = Some(conn.clone()); // usable only now, once it knows its folder and has started
            break conn;
        };
        match self.session("chat").await {
            // Another folder or agent replaced this one while its session started: not an error.
            Err(_) if !self.st().conn.as_ref().is_some_and(|c| Arc::ptr_eq(c, &conn)) => Ok(false),
            r => r.map(|_| true),
        }
    }

    /// The handles finish once the agent's processes have ended.
    pub fn stop(&self) -> Vec<std::thread::JoinHandle<()>> {
        self.resolve_permissions(None);
        let mut st = self.st();
        let ending = [st.conn.take(), st.starting.take()].into_iter().flatten().map(|conn| conn.kill()).collect();
        st.sessions.clear();
        st.options.clear();
        ending
    }

    pub async fn session(&self, kind: &str) -> Result<String, String> {
        let _one = self.session_lock.lock().await;
        let (conn, root) = {
            let st = self.st();
            if let Some(sid) = st.sessions.get(kind) {
                return Ok(sid.clone());
            }
            match (&st.conn, &st.root) {
                (Some(conn), Some(root)) => (conn.clone(), root.clone()),
                _ => return Err(NO_AGENT.into()),
            }
        };
        let s = conn.request("session/new", json!({"cwd": root.to_string_lossy(), "mcpServers": []})).await?;
        let sid = s["sessionId"].as_str().ok_or("The agent did not start a session.")?.to_string();
        let picks = {
            let mut st = self.st();
            st.sessions.insert(kind.into(), sid.clone());
            st.options.insert(kind.into(), if s["configOptions"].is_array() { s["configOptions"].clone() } else { json!([]) });
            st.picks_for(kind)
        };
        for (config_id, value) in picks {
            self.apply_option(kind, &config_id, value).await?;
        }
        if kind == "complete" && self.st().chosen.get("complete").is_none_or(Map::is_empty) {
            // Effort choices depend on the model, so pick the model first.
            for model in [true, false] {
                let picks = self.st().fast_picks(model);
                for (config_id, value) in picks {
                    self.apply_option(kind, &config_id, value).await?;
                }
            }
        }
        self.send_options(kind);
        Ok(sid)
    }

    async fn apply_option(&self, kind: &str, config_id: &str, value: Value) -> Result<(), String> {
        let (conn, sid) = {
            let st = self.st();
            match (&st.conn, st.sessions.get(kind)) {
                (Some(conn), Some(sid)) => (conn.clone(), sid.clone()),
                _ => return Err(NO_AGENT.into()),
            }
        };
        let params = json!({"sessionId": sid, "configId": config_id, "value": value});
        let r = conn.request("session/set_config_option", params).await?;
        if r["configOptions"].is_array() {
            self.st().options.insert(kind.into(), r["configOptions"].clone());
        }
        Ok(())
    }

    pub async fn set_option(&self, kind: &str, config_id: &str, value: Value) -> Result<(), String> {
        self.session(kind).await?;
        self.st().chosen.entry(kind.into()).or_default().insert(config_id.into(), value.clone());
        self.apply_option(kind, config_id, value.clone()).await?;
        self.send_options(kind);
        let inline_too = kind == "chat" && {
            let st = self.st();
            st.sessions.contains_key("inline") && st.picks_for("inline").iter().any(|(k, _)| k == config_id)
        };
        if inline_too {
            self.apply_option("inline", config_id, value).await?;
        }
        Ok(())
    }

    /// Returns the stop reason and the reply text.
    pub async fn prompt(&self, kind: &str, text: &str) -> Result<(String, String), String> {
        let sid = self.session(kind).await?;
        let conn = self.st().conn.clone().ok_or(NO_AGENT)?;
        self.st().replies.insert(sid.clone(), String::new());
        let params = json!({"sessionId": sid, "prompt": [{"type": "text", "text": text}]});
        let r = conn.request("session/prompt", params).await;
        let reply = self.st().replies.remove(&sid).unwrap_or_default();
        Ok((r?["stopReason"].as_str().unwrap_or("").into(), reply))
    }

    pub async fn cancel(&self, kind: &str) {
        if kind == "chat" {
            self.resolve_permissions(None);
        }
        let target = {
            let st = self.st();
            st.conn.clone().zip(st.sessions.get(kind).cloned())
        };
        if let Some((conn, sid)) = target {
            let _ = conn.notify("session/cancel", json!({"sessionId": sid})).await;
        }
    }

    pub async fn inline(&self, path: &str, instruction: &str, selected: &str, before: &str, after: &str) -> Result<String, String> {
        // One at a time: two prompts in one session would mix their replies.
        if self.inline_lock.try_lock().is_err() {
            self.cancel("inline").await; // the newer request wins
        }
        let _one = self.inline_lock.lock().await;
        let (_, reply) = self.prompt("inline", &inline_prompt(path, instruction, selected, before, after)).await?;
        Ok(strip_fences(&reply))
    }

    pub async fn complete(&self, prompt: &str) -> Result<String, String> {
        let me = self.newest_completion.fetch_add(1, Relaxed) + 1;
        if self.complete_lock.try_lock().is_err() {
            self.cancel("complete").await; // a newer keystroke wins
        }
        let _one = self.complete_lock.lock().await;
        if self.newest_completion.load(Relaxed) != me {
            return Ok(String::new()); // a newer keystroke came while this one waited
        }
        // ponytail: every completion adds to the session history; start a fresh
        // session every 20 so it stays small. Smarter: agent-side NES when agents ship it.
        if self.completions.fetch_add(1, Relaxed) % 20 == 19 {
            self.st().sessions.remove("complete");
        }
        let (_, reply) = self.prompt("complete", prompt).await?;
        Ok(suggestion(&reply))
    }

    fn resolve_permissions(&self, option_id: Option<String>) {
        for (_, (tx, _)) in self.st().pending.drain() {
            let _ = tx.send(option_id.clone());
        }
    }

    pub fn answer_permission(&self, pid: &str, option_id: Option<String>) {
        if let Some((tx, _)) = self.st().pending.remove(pid) {
            let _ = tx.send(option_id);
        }
    }

    /// The permission questions still waiting for the writer.
    pub fn open_permissions(&self) -> Vec<Value> {
        self.st().pending.values().map(|(_, question)| question.clone()).collect()
    }

    // --- called by the agent ---

    /// The agent process ended. A stop or a newer start takes it out first, so if it is still
    /// the current one, it quit on its own (it crashed): start it again.
    fn quit(&self, conn: &Arc<Conn>, said: &str) {
        let id = {
            let st = self.st();
            st.conn.as_ref().filter(|c| Arc::ptr_eq(c, conn)).and(st.agent_id.clone())
        };
        let Some(id) = id else { return };
        let name = find_agent(&id).map_or(id.clone(), |a| a.name);
        if conn.started.elapsed() < RESTART_AFTER {
            self.stop();
            let said = if said.is_empty() { String::new() } else { format!(" It said:\n{said}") };
            self.failed(&id, format!("{name} stopped right after it started.{said}"));
        } else {
            send(json!({"type": "error", "message": format!("{name} stopped. Quire is starting it again, with a new conversation.")}));
            restart_agent(&id);
        }
    }

    fn session_update(&self, params: &Value) {
        let (sid, update) = (params["sessionId"].as_str().unwrap_or(""), &params["update"]);
        let mut st = self.st();
        let kind = st.kind_of(sid);
        if let (Some(kind), "config_option_update") = (&kind, update["sessionUpdate"].as_str().unwrap_or("")) {
            st.options.insert(kind.clone(), update["configOptions"].clone());
            drop(st);
            self.send_options(kind);
        } else if kind.as_deref() == Some("chat") {
            drop(st);
            send(json!({"type": "update", "update": update}));
        } else if update["sessionUpdate"] == "agent_message_chunk" && update["content"]["type"] == "text" {
            let text = update["content"]["text"].as_str().unwrap_or("");
            st.replies.entry(sid.into()).or_default().push_str(text);
        }
    }

    async fn request_permission(&self, params: &Value) -> Value {
        let options = params["options"].clone();
        let selected = |option_id: &Value| json!({"outcome": {"outcome": "selected", "optionId": option_id}});
        let cancelled = json!({"outcome": {"outcome": "cancelled"}});
        if self.st().kind_of(params["sessionId"].as_str().unwrap_or("")).as_deref() != Some("chat") {
            // inline/complete must only reply with text: refuse every tool.
            let reject = list(Some(&options)).find(|o| o["kind"].as_str().is_some_and(|k| k.starts_with("reject")));
            return reject.map_or(cancelled, |o| selected(&o["optionId"]));
        }
        let pid = format!("p{}", self.permissions.fetch_add(1, Relaxed));
        let (tx, rx) = oneshot::channel();
        let question = json!({"type": "permission", "id": pid, "toolCall": params["toolCall"], "options": options});
        self.st().pending.insert(pid, (tx, question.clone()));
        send(question);
        match rx.await.ok().flatten() {
            Some(option_id) => selected(&option_id.into()),
            None => cancelled,
        }
    }
}

/// A suggestion is one short line. Anything else is chatter or an error message.
fn suggestion(reply: &str) -> String {
    // A model that thinks aloud puts its answer after the thoughts.
    let reply = reply.rsplit_once("</think>").map_or(reply, |(_, answer)| answer);
    let reply = strip_fences(reply).trim_end_matches('\n').to_string();
    if reply.contains('\n') || reply.chars().count() > 300 { String::new() } else { reply }
}

/// What curl reads on stdin to post `body` to `url`.
fn curl_config(url: &str, headers: &[String], body: &Value) -> Result<String, String> {
    // Each setting is one line, and curl opens any kind of address: keep both as meant.
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.chars().chain(headers.iter().flat_map(|h| h.chars())).any(char::is_control) {
        return Err("The API address must start with http:// or https://, and the key must be one line.".into());
    }
    let quoted = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
    let mut config = format!("url = {}\nheader = \"Content-Type: application/json\"\ndata-raw = {}\n", quoted(url), quoted(&body.to_string()));
    for header in headers {
        config += &format!("header = {}\n", quoted(header));
    }
    Ok(config)
}

/// Autocomplete without the agent: one request to an API that talks like OpenAI's (Groq,
/// Ollama, ...) or like Anthropic's. No session and no tools, so the answer comes in well
/// under a second.
// ponytail: a new curl, so a new TLS handshake (about 150 ms to Groq), for every suggestion.
// A kept connection (reqwest is already in the build, for the updater) if that matters.
pub async fn complete_api(kind: &str, url: &str, model: &str, key: &str, prompt: &str) -> Result<String, String> {
    static NEWER: Notify = Notify::const_new();
    NEWER.notify_waiters(); // a newer keystroke wins: the request still waiting ends, and its curl with it
    let (anthropic, base) = (kind == "anthropic", url.trim_end_matches('/'));
    // The two kinds differ in the address, the name of the limit and the key's header. The
    // limit leaves room for a model that thinks first; the instructions keep the answer short.
    // No temperature: the newer models of both refuse one.
    let (url, limit, mut headers) = if anthropic {
        // Their base address has no /v1, but people paste it with one.
        (format!("{}/v1/messages", base.trim_end_matches("/v1")), "max_tokens", vec!["anthropic-version: 2023-06-01".to_string()])
    } else {
        (format!("{base}/chat/completions"), "max_completion_tokens", vec![])
    };
    if !key.is_empty() {
        headers.push(if anthropic { format!("x-api-key: {key}") } else { format!("Authorization: Bearer {key}") });
    }
    let body = json!({"model": model, "messages": [{"role": "user", "content": prompt}], limit: 1024});
    // The key and the text go in on stdin: other programs can read a command's arguments.
    let config = curl_config(&url, &headers, &body)?;
    let mut child = Command::new("curl").no_window()
        .args(["-sS", "--max-time", "15", "--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not run curl: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(config.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin); // curl reads to the end of it
    let out = tokio::select! {
        out = child.wait_with_output() => out.map_err(|e| e.to_string())?,
        _ = NEWER.notified() => return Ok(String::new()),
    };
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        let why = why.trim().split_once(") ").map_or(why.trim(), |(_, w)| w); // drop "curl: (7) "
        return Err(format!("Could not reach {url} ({why})."));
    }
    let kind = if anthropic { "Anthropic" } else { "OpenAI" };
    let answer: Value = serde_json::from_slice(&out.stdout).map_err(|_| format!("{url} did not answer like an {kind}-compatible API."))?;
    if let Some(e) = answer["error"]["message"].as_str().or(answer["error"].as_str()) {
        return Err(e.into());
    }
    let reply: String = if anthropic {
        // The answer is the text blocks; thoughts come in blocks of their own.
        answer["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect()
    } else {
        answer["choices"][0]["message"]["content"].as_str().unwrap_or("").into()
    };
    Ok(suggestion(&reply))
}

fn strip_fences(text: &str) -> String {
    let t = text.trim_matches('\n');
    if !(t.starts_with("```") && t.ends_with("```")) {
        return t.into();
    }
    match t.split_once('\n') {
        Some((_, rest)) => rest.rsplit_once("```").map_or(rest, |(body, _)| body).trim_end_matches('\n').into(),
        None => t.trim_matches('`').into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[test]
    fn launch_commands() {
        // npx first, a binary only for this machine.
        let both = json!({"id": "a", "distribution": {"npx": {"package": "a@1", "args": ["--acp"]}, "uvx": {"package": "a"}}});
        assert_eq!(launch(&both).unwrap().argv, ["npx", "--prefer-offline", "-y", "a@1", "--acp"]);
        let bin = json!({"id": "b", "distribution": {"binary": {platform(): {"cmd": "./dist/b", "args": ["acp"]}}}});
        assert_eq!(launch(&bin).unwrap().argv, ["b", "acp"]);
        assert!(launch(&json!({"id": "c", "distribution": {"binary": {"plan9-mips": {"cmd": "c"}}}})).is_none());
        let npx = launch(&both).unwrap().argv;
        assert_eq!(ask_npm_afresh(&npx, "npm error code ETARGET").unwrap(), ["npx", "-y", "a@1", "--acp"]);
        assert!(ask_npm_afresh(&npx, "npm error code E404").is_none());
        assert!(ask_npm_afresh(&["npx".into(), "-y".into(), "a@1".into()], "npm error code ETARGET").is_none());
        // A download cut short, as npm says it (a home folder may have a space).
        let enoent = "The agent stopped. It said:\nnpm error code ENOENT\nnpm error syscall open\n\
                      npm error path /Users/A B/.npm/_npx/698eb38f5d7f5a61/package.json\nnpm error errno -2\n\
                      npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/Users/A B/.npm/_npx/698eb38f5d7f5a61/package.json'";
        assert_eq!(broken_download(enoent).unwrap(), Path::new("/Users/A B/.npm/_npx/698eb38f5d7f5a61"));
        assert!(broken_download("npm error code ENOENT\nnpm error path /Users/me/book/package.json").is_none());
        assert!(broken_download("npm error code E404\nnpm error path /Users/me/.npm/_npx/698eb38f5d7f5a61/package.json").is_none());
        let bundled: Value = serde_json::from_str(AGENTS).unwrap();
        assert!(list(Some(&bundled["agents"])).filter_map(launch).any(|a| a.id == "claude-acp"));
        assert_eq!(strip_fences("```typst\nhello\n```\n"), "hello");
        assert_eq!(strip_fences(" hello"), " hello");
        assert_eq!(suggestion("<think>\nhmm\n</think>\n\nand so on.\n"), "and so on.");
        assert_eq!(suggestion("Sure! Here it is:\nand so on."), "");
        assert!(curl_config("file:///etc/passwd", &[], &json!({})).is_err());
        assert!(curl_config("https://api.groq.com/openai/v1", &["x-api-key: key\nurl = \"file:///etc/passwd\"".into()], &json!({})).is_err());
    }

    /// A stand-in for an API: it answers one request with `answer` and gives back what curl sent.
    async fn api(answer: Value) -> (String, tokio::task::JoinHandle<(String, Value)>) {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", server.local_addr().unwrap());
        let asked = tokio::spawn(async move {
            let (mut conn, _) = server.accept().await.unwrap();
            let (mut request, mut buf) = (Vec::new(), [0; 4096]);
            let (head, body) = loop {
                let n = conn.read(&mut buf).await.unwrap();
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).into_owned();
                let Some((head, body)) = text.split_once("\r\n\r\n") else { continue };
                let length = head.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ")?.parse().ok());
                if length == Some(body.len()) {
                    break (head.to_string(), body.to_string());
                }
            };
            let answer = answer.to_string();
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}", answer.len());
            conn.write_all(reply.as_bytes()).await.unwrap();
            (head, serde_json::from_str::<Value>(&body).unwrap())
        });
        (url, asked)
    }

    #[tokio::test]
    async fn completes_from_an_api() {
        // Quotes, a backslash and a new line: curl must send them as they are.
        let prompt = complete_prompt("Continue this {language} text.", "a.typ", "She said \"hi\" \\ then\nleft", " now");
        assert_eq!(prompt, "Continue this Typst text.\n\nShe said \"hi\" \\ then\nleft<CURSOR> now");
        let (url, asked) = api(json!({"choices": [{"message": {"role": "assistant", "content": "```\nand so on.\n```"}}]})).await;
        assert_eq!(complete_api("openai", &format!("{url}/v1/"), "m", "k\"y", &prompt).await.unwrap(), "and so on.");
        let (head, body) = asked.await.unwrap();
        assert!(head.starts_with("POST /v1/chat/completions "), "{head}");
        assert!(head.contains("Authorization: Bearer k\"y\r\n"), "{head}");
        assert_eq!((&body["model"], &body["max_completion_tokens"]), (&json!("m"), &json!(1024)));
        assert_eq!(body["messages"][0]["content"], prompt);

        // Anthropic's way: another address, header and limit; the answer comes after the thoughts.
        let (url, asked) = api(json!({"content": [{"type": "thinking", "thinking": "hm"}, {"type": "text", "text": "and so on."}]})).await;
        assert_eq!(complete_api("anthropic", &format!("{url}/v1"), "m", "key", &prompt).await.unwrap(), "and so on.");
        let (head, body) = asked.await.unwrap();
        assert!(head.starts_with("POST /v1/messages "), "{head}");
        assert!(head.contains("x-api-key: key\r\n") && head.contains("anthropic-version: 2023-06-01\r\n"), "{head}");
        assert_eq!((&body["max_tokens"], &body["temperature"]), (&json!(1024), &Value::Null));

        // What the API says is wrong reaches the writer, in either shape.
        let (url, _asked) = api(json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})).await;
        assert_eq!(complete_api("anthropic", &url, "m", "key", "x").await.unwrap_err(), "invalid x-api-key");
        // Nothing listens there (Ollama not started): said plainly.
        assert!(complete_api("openai", "http://127.0.0.1:1/v1", "m", "", "x").await.unwrap_err().starts_with("Could not reach"));
    }

    #[cfg(unix)] // sh and its signals
    #[tokio::test]
    async fn kill_ends_the_group() {
        let start = |script: &str| {
            let mut child = Command::new("sh").args(["-c", script]).stdin(Stdio::piped()).stdout(Stdio::piped()).process_group(0).spawn().unwrap();
            let said = BufReader::new(child.stdout.take().unwrap()).lines();
            let conn = Arc::new(Conn {
                stdin: child.stdin.take().unwrap().into(),
                next: AtomicU64::new(0),
                waiting: Mutex::default(),
                group: child.id().unwrap() as i32,
                started: Instant::now(),
                said: Arc::default(),
                child: Mutex::new(child),
            });
            (conn, said)
        };
        // An agent ends on SIGTERM: quitting does not wait for KILL_AFTER.
        let t = Instant::now();
        start("sleep 30").0.kill().join().unwrap();
        assert!(t.elapsed() < KILL_AFTER);
        // npm finishing a download step, with a child of its own: killed after KILL_AFTER.
        let (npm, mut said) = start("trap '' TERM; sleep 30 & echo ready; wait");
        said.next_line().await.unwrap(); // it ignores SIGTERM from now on
        let t = Instant::now();
        npm.kill().join().unwrap();
        assert!(t.elapsed() >= KILL_AFTER);
        std::thread::sleep(Duration::from_millis(200));
        let _ = lock(&npm.child).try_wait();
        assert_ne!(killpg(npm.group, 0), 0);
    }
}
