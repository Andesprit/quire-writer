// The agent (ACP): one agent process from Quire's copy of the ACP registry, JSON-RPC with one
// message per line on its stdin and stdout. As in Quire's suggestions and rewrites, it may only
// answer with text: every tool it asks to use is refused.
import Foundation

struct AgentSpec: Identifiable, Hashable {
  let id: String
  let name: String
  let argv: [String]
  let env: [String: String]
}

enum Registry {
  /// The agents this Mac can start. npx and uvx fetch theirs on first use; a binary is never
  /// downloaded, so it must already be on PATH under its own name.
  static let agents: [AgentSpec] = {
    guard let url = Bundle.main.url(forResource: "agents", withExtension: "json"),
      let data = try? Data(contentsOf: url),
      let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let list = raw["agents"] as? [[String: Any]]
    else { return [] }
    return list.compactMap(spec)
  }()

  private static func spec(_ entry: [String: Any]) -> AgentSpec? {
    guard let id = entry["id"] as? String, let d = entry["distribution"] as? [String: Any] else { return nil }
    let how: [String: Any]
    var argv: [String]
    if let npx = d["npx"] as? [String: Any], let pkg = npx["package"] as? String {
      // --prefer-offline: a pinned version in the npx cache starts without asking npm.
      (how, argv) = (npx, ["npx", "--prefer-offline", "-y", pkg])
    } else if let uvx = d["uvx"] as? [String: Any], let pkg = uvx["package"] as? String {
      (how, argv) = (uvx, ["uvx", pkg])
    } else if let bin = (d["binary"] as? [String: Any])?["darwin-aarch64"] as? [String: Any], let cmd = bin["cmd"] as? String {
      (how, argv) = (bin, [String(cmd.split(separator: "/").last ?? "")])
    } else {
      return nil
    }
    argv += how["args"] as? [String] ?? []
    return AgentSpec(id: id, name: entry["name"] as? String ?? id, argv: argv, env: how["env"] as? [String: String] ?? [:])
  }
}

/// Apps opened from Finder get a bare PATH without Homebrew, so npx would be missing. Ask the
/// login shell for the PATH the writer's terminal has, as Quire does.
private let shellPath: String = {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
  p.arguments = ["-ilc", "printf '__PATH__%s' \"$PATH\""]
  let out = Pipe()
  (p.standardInput, p.standardOutput, p.standardError) = (FileHandle.nullDevice, out, FileHandle.nullDevice)
  try? p.run()
  let said = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
  p.waitUntilExit()
  return said.components(separatedBy: "__PATH__").last.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    ?? ProcessInfo.processInfo.environment["PATH"] ?? ""
}()

/// The agent works in an empty folder of its own: it sees none of the writer's files.
private let workDir: URL = {
  let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appending(path: "Quire Companion/agent")
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}()

/// One prompt at a time: two in one session would mix their replies.
private actor Turn {
  private var busy = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  func begin() async {
    if busy {
      await withCheckedContinuation { waiting.append($0) }
    } else {
      busy = true
    }
  }

  func end() {
    if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
  }
}

final class Agent: @unchecked Sendable {
  static let shared = Agent()

  // Everything below is only touched on `q`.
  private let q = DispatchQueue(label: "agent")
  private var process: Process?
  private var input: FileHandle?
  private var spec: AgentSpec?
  private var next = 0
  private var waiting: [Int: CheckedContinuation<[String: Any], Error>] = [:]
  private var replies: [String: String] = [:]  // session id: the reply so far
  private var sessions: [String: (id: String, uses: Int)] = [:]  // "check" and "rewrite"
  private var prompting: String?  // the session a prompt runs in
  private var buffer = Data()
  private var said: [String] = []  // its last lines of error output: why it stopped
  private let turn = Turn()

  var isRunning: Bool { q.sync { process?.isRunning == true } }

  /// The agent's answer to `text`, asked in its `kind` session: "check" or "rewrite".
  func ask(_ text: String, kind: String, agent id: String) async throws -> String {
    if let sid = q.sync(execute: { prompting }) {
      notify("session/cancel", ["sessionId": sid])  // the newer request wins
    }
    await turn.begin()
    do {
      let reply = try await prompt(text, kind: kind, agent: id)
      await turn.end()
      return reply
    } catch {
      await turn.end()
      throw error
    }
  }

  func stop() {
    q.sync {
      process?.terminate()
      quit(process, why: nil)
    }
  }

  private func prompt(_ text: String, kind: String, agent id: String) async throws -> String {
    try await start(id)
    let sid = try await session(kind)
    q.sync {
      replies[sid] = ""
      prompting = sid
    }
    defer { q.sync { prompting = nil } }
    _ = try await request("session/prompt", ["sessionId": sid, "prompt": [["type": "text", "text": text]]])
    return q.sync { replies.removeValue(forKey: sid) ?? "" }
  }

  private func start(_ id: String) async throws {
    if q.sync(execute: { process?.isRunning == true && spec?.id == id }) { return }
    stop()
    guard let spec = Registry.agents.first(where: { $0.id == id }) else {
      throw Failure("Unknown agent: \(id). Pick one in Settings.")
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = spec.argv
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = shellPath
    p.environment = env.merging(spec.env) { $1 }
    p.currentDirectoryURL = workDir
    let (i, o, e) = (Pipe(), Pipe(), Pipe())
    (p.standardInput, p.standardOutput, p.standardError) = (i, o, e)
    o.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil }
      self?.q.async { self?.received(d) }
    }
    e.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil }
      self?.q.async { self?.keep(d) }
    }
    p.terminationHandler = { [weak self] p in self?.q.async { self?.quit(p, why: "\(spec.name) stopped.") } }
    try q.sync {
      do { try p.run() } catch { throw Failure("Could not start \(spec.name): \(error.localizedDescription)") }
      (process, input, self.spec, sessions, said, buffer) = (p, i.fileHandleForWriting, spec, [:], [], Data())
    }
    _ = try await request("initialize", ["protocolVersion": 1, "clientCapabilities": [String: Any]()])
  }

  private func session(_ kind: String) async throws -> String {
    // ponytail: a fresh session every 10 prompts keeps the history small, as in Quire.
    if let s = q.sync(execute: { sessions[kind] }), s.uses < 10 {
      q.sync { sessions[kind]?.uses += 1 }
      return s.id
    }
    let s = try await request("session/new", ["cwd": workDir.path, "mcpServers": [Any]()])
    guard let sid = s["sessionId"] as? String else { throw Failure("The agent did not start a session.") }
    if kind == "check" { await pickFast(sid, s["configOptions"] as? [[String: Any]] ?? []) }
    q.sync { sessions[kind] = (sid, 1) }
    return sid
  }

  /// Suggestions use the agent's fastest model at its lowest effort, as in Quire. The effort
  /// choices depend on the model, so the model comes first.
  private func pickFast(_ sid: String, _ options: [[String: Any]]) async {
    var options = options
    for model in [true, false] {
      for o in options where o["type"] as? String == "select" {
        let (id, category) = (o["id"] as? String ?? "", o["category"] as? String ?? "")
        let values = Self.values(o).map { ($0, $0.lowercased()) }
        var pick: String?
        if model && (category == "model" || id == "model") {
          pick = ["haiku", "mini", "flash", "fast", "small"].lazy.compactMap { h in values.first { $0.1.contains(h) }?.0 }.first
        } else if !model && (category == "thought_level" || ["effort", "reasoning_effort", "thought_level"].contains(id)) {
          pick = ["minimal", "none", "off", "low"].lazy.compactMap { h in values.first { $0.1 == h }?.0 }.first
        }
        guard let pick else { continue }
        let r = try? await request("session/set_config_option", ["sessionId": sid, "configId": id, "value": pick])
        if let newer = r?["configOptions"] as? [[String: Any]] { options = newer }
      }
    }
  }

  /// A select option's values; some agents group them.
  private static func values(_ option: [String: Any]) -> [String] {
    (option["options"] as? [[String: Any]] ?? []).flatMap { entry in
      ((entry["options"] as? [[String: Any]]) ?? [entry]).compactMap { $0["value"] as? String }
    }
  }

  // --- the wire ---

  private func request(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
    try await withCheckedThrowingContinuation { c in
      q.async { [self] in
        guard process != nil else { return c.resume(throwing: Failure("The agent stopped.")) }
        let id = next
        next += 1
        waiting[id] = c
        write(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
      }
    }
  }

  private func notify(_ method: String, _ params: [String: Any]) {
    q.async { [self] in write(["jsonrpc": "2.0", "method": method, "params": params]) }
  }

  private func write(_ msg: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: msg) else { return }
    try? input?.write(contentsOf: data + Data("\n".utf8))  // throws, not crashes, once it has quit
  }

  private func received(_ data: Data) {
    buffer.append(data)
    while let nl = buffer.firstIndex(of: 0x0A) {
      let line = buffer[buffer.startIndex..<nl]
      buffer.removeSubrange(buffer.startIndex...nl)
      if let msg = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { handle(msg) }
    }
  }

  private func handle(_ msg: [String: Any]) {
    let method = msg["method"] as? String
    let params = msg["params"] as? [String: Any] ?? [:]
    if method == nil, let id = msg["id"] as? Int, let c = waiting.removeValue(forKey: id) {
      if let e = msg["error"] as? [String: Any] {
        c.resume(throwing: Failure(e["message"] as? String ?? "The agent failed."))
      } else {
        c.resume(returning: msg["result"] as? [String: Any] ?? [:])
      }
    } else if method == "session/update" {
      let update = params["update"] as? [String: Any] ?? [:]
      let content = update["content"] as? [String: Any] ?? [:]
      if let sid = params["sessionId"] as? String, replies[sid] != nil,
        update["sessionUpdate"] as? String == "agent_message_chunk", content["type"] as? String == "text"
      {
        replies[sid]! += content["text"] as? String ?? ""
      }
    } else if let method, let id = msg["id"] {
      // The agent asks for something: a tool, a file, a terminal. Refuse it all.
      let options = params["options"] as? [[String: Any]] ?? []
      if method == "session/request_permission" {
        let reject = options.first { ($0["kind"] as? String)?.hasPrefix("reject") == true }?["optionId"]
        let outcome: [String: Any] = reject.map { ["outcome": "selected", "optionId": $0] } ?? ["outcome": "cancelled"]
        write(["jsonrpc": "2.0", "id": id, "result": ["outcome": outcome]])
      } else {
        write(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Quire Companion does not offer \(method)."]])
      }
    }
  }

  private func keep(_ data: Data) {
    said += String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
    said = Array(said.suffix(20))
  }

  /// `p` ended or was stopped: whatever still waits for it fails with what it said last.
  private func quit(_ p: Process?, why: String?) {
    guard let p, p === process else { return }
    process = nil
    input = nil
    sessions = [:]
    let lines = said.suffix(6).joined(separator: "\n")
    let failure = Failure((why ?? "The agent stopped.") + (lines.isEmpty ? "" : " It said:\n\(lines)"))
    for c in waiting.values { c.resume(throwing: failure) }
    waiting = [:]
  }
}
