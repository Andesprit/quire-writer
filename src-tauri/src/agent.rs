//! ACP bridge: one agent process with up to three sessions.
//!
//! - chat:     the chat bar. Its updates stream to the browser as-is.
//! - inline:   select-and-edit. Replies with replacement text only.
//! - complete: autocomplete. Replies with the next few words only.
//!
//! Agents are started from agents.json, a copy of the ACP registry, so any agent listed
//! there (Claude, Codex, Gemini, ...) works by id. ACP is JSON-RPC, one message per line on
//! the agent's stdin and stdout.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::oneshot;

use crate::lock;
use crate::server::send;

const AGENTS: &str = include_str!("../../agents.json");
const NO_AGENT: &str = "No agent running. Open a folder first.";
const STOPPED: &str = "The agent stopped.";
const EFFORT_IDS: [&str; 3] = ["effort", "reasoning_effort", "thought_level"];
const FAST_MODEL_HINTS: [&str; 5] = ["haiku", "mini", "flash", "fast", "small"];
const LOW_EFFORT: [&str; 4] = ["minimal", "none", "off", "low"];

fn inline_prompt(path: &str, instruction: &str, selected: &str, before: &str, after: &str) -> String {
    format!(
        "You are editing a Typst document ({path}). Rewrite the SELECTED text following the instruction.\n\
         Reply with ONLY the replacement text. No explanation, no quotes, no code fences. Do not use any tools.\n\
         If nothing is selected, reply with the text to insert at the cursor.\n\n\
         Instruction: {instruction}\n\n\
         Text before the selection:\n{before}\n\n\
         SELECTED:\n{selected}\n\n\
         Text after the selection:\n{after}"
    )
}

fn complete_prompt(before: &str, after: &str) -> String {
    format!(
        "You are the autocomplete of a Typst editor. Continue the text at <CURSOR>.\n\
         Reply with ONLY the text to insert: a few words, at most one sentence. Start with a space if one is needed.\n\
         No explanation, no quotes, no code fences. Do not use any tools.\n\n\
         {before}<CURSOR>{after}"
    )
}

pub struct Agent {
    pub id: String,
    pub name: String,
    argv: Vec<String>,
    env: Vec<(String, String)>,
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
    _child: Mutex<Child>,
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

    fn kill(&self) {
        if self.group > 0 {
            unsafe { libc::killpg(self.group, libc::SIGTERM) };
        }
    }
}

/// Everything the agent sends: replies to our requests, updates, and its own requests.
async fn read(conn: Arc<Conn>, stdout: ChildStdout) {
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
    lock(&conn.waiting).clear(); // requests still waiting fail with STOPPED
}

pub static BRIDGE: LazyLock<Bridge> = LazyLock::new(Bridge::default);

#[derive(Default)]
pub struct Bridge {
    st: Mutex<State>,
    session_lock: tokio::sync::Mutex<()>, // two requests must not open two sessions of one kind
    complete_lock: tokio::sync::Mutex<()>,
    completions: AtomicU64,
    permissions: AtomicU64,
}

#[derive(Default)]
struct State {
    conn: Option<Arc<Conn>>,
    agent_id: Option<String>,
    root: Option<PathBuf>,
    sessions: HashMap<String, String>,           // kind -> session id
    options: BTreeMap<String, Value>,            // kind -> config options
    chosen: HashMap<String, Map<String, Value>>, // kind -> user picks, re-applied to new sessions
    replies: HashMap<String, String>,            // session id -> reply so far
    pending: HashMap<String, oneshot::Sender<Option<String>>>, // permission id -> answer
}

impl State {
    fn kind_of(&self, session_id: &str) -> Option<String> {
        self.sessions.iter().find(|(_, s)| *s == session_id).map(|(k, _)| k.clone())
    }

    fn picks_for(&self, kind: &str) -> Map<String, Value> {
        let chosen = |k: &str| self.chosen.get(k).cloned().unwrap_or_default();
        if kind != "inline" {
            return chosen(kind);
        }
        // Inline edits follow the chat model and effort, never its mode (a
        // permissive mode would let the inline session edit files).
        let shared: HashSet<&str> = list(self.options.get("chat"))
            .filter(|o| is_model(o) || is_effort(o))
            .filter_map(|o| o["id"].as_str())
            .collect();
        chosen("chat").into_iter().filter(|(k, _)| shared.contains(k.as_str())).collect()
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

    pub fn all_options(&self) -> Vec<(String, Value)> {
        self.st().options.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    fn send_options(&self, kind: &str) {
        let options = self.st().options.get(kind).cloned().unwrap_or_else(|| json!([]));
        send(json!({"type": "options", "kind": kind, "options": options}));
    }

    pub async fn start(&self, agent_id: &str, root: &Path) -> Result<(), String> {
        let spec = find_agent(agent_id)?;
        self.stop();
        self.st().root = Some(root.into()); // set first: nothing may start a session in the previous folder
        let mut child = Command::new(&spec.argv[0])
            .args(&spec.argv[1..])
            .envs(spec.env)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped()) // stderr: the app's log, or the terminal
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", spec.argv[0]))?;
        let (stdin, stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
        let conn = Arc::new(Conn {
            stdin: stdin.into(),
            next: AtomicU64::new(0),
            waiting: Mutex::default(),
            group: child.id().unwrap_or(0) as i32,
            _child: Mutex::new(child),
        });
        tokio::spawn(read(conn.clone(), stdout));
        if let Err(e) = conn.request("initialize", json!({"protocolVersion": 1, "clientCapabilities": {}})).await {
            conn.kill();
            return Err(e);
        }
        {
            let mut st = self.st();
            if st.agent_id.as_deref() != Some(agent_id) {
                st.chosen.clear();
            }
            st.agent_id = Some(agent_id.into());
            st.conn = Some(conn); // usable only now, once it knows its folder and has started
        }
        self.session("chat").await.map(|_| ())
    }

    pub fn stop(&self) {
        self.resolve_permissions(None);
        let mut st = self.st();
        if let Some(conn) = st.conn.take() {
            conn.kill();
        }
        st.sessions.clear();
        st.options.clear();
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
            st.sessions.contains_key("inline") && st.picks_for("inline").contains_key(config_id)
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
        let (_, reply) = self.prompt("inline", &inline_prompt(path, instruction, selected, before, after)).await?;
        Ok(strip_fences(&reply))
    }

    pub async fn complete(&self, before: &str, after: &str) -> Result<String, String> {
        if self.complete_lock.try_lock().is_err() {
            self.cancel("complete").await; // a newer keystroke wins
        }
        let _one = self.complete_lock.lock().await;
        // ponytail: every completion adds to the session history; start a fresh
        // session every 20 so it stays small. Smarter: agent-side NES when agents ship it.
        if self.completions.fetch_add(1, Relaxed) % 20 == 19 {
            self.st().sessions.remove("complete");
        }
        let (_, reply) = self.prompt("complete", &complete_prompt(before, after)).await?;
        let reply = strip_fences(&reply).trim_end_matches('\n').to_string();
        // A suggestion is one short line. Anything else is chatter or an error message.
        Ok(if reply.contains('\n') || reply.chars().count() > 300 { String::new() } else { reply })
    }

    pub fn resolve_permissions(&self, option_id: Option<String>) {
        for (_, tx) in self.st().pending.drain() {
            let _ = tx.send(option_id.clone());
        }
    }

    pub fn answer_permission(&self, pid: &str, option_id: Option<String>) {
        if let Some(tx) = self.st().pending.remove(pid) {
            let _ = tx.send(option_id);
        }
    }

    // --- called by the agent ---

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
        self.st().pending.insert(pid.clone(), tx);
        send(json!({"type": "permission", "id": pid, "toolCall": params["toolCall"], "options": options}));
        match rx.await.ok().flatten() {
            Some(option_id) => selected(&option_id.into()),
            None => cancelled,
        }
    }
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

    #[test]
    fn launch_commands() {
        // npx first, a binary only for this machine.
        let both = json!({"id": "a", "distribution": {"npx": {"package": "a@1", "args": ["--acp"]}, "uvx": {"package": "a"}}});
        assert_eq!(launch(&both).unwrap().argv, ["npx", "--prefer-offline", "-y", "a@1", "--acp"]);
        let bin = json!({"id": "b", "distribution": {"binary": {platform(): {"cmd": "./dist/b", "args": ["acp"]}}}});
        assert_eq!(launch(&bin).unwrap().argv, ["b", "acp"]);
        assert!(launch(&json!({"id": "c", "distribution": {"binary": {"plan9-mips": {"cmd": "c"}}}})).is_none());
        let bundled: Value = serde_json::from_str(AGENTS).unwrap();
        assert!(list(Some(&bundled["agents"])).filter_map(launch).any(|a| a.id == "claude-acp"));
        assert_eq!(strip_fences("```typst\nhello\n```\n"), "hello");
        assert_eq!(strip_fences(" hello"), " hello");
    }
}
