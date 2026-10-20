// Quire Companion: Quire's suggestions and rewrites in any app. It lives in the menu bar;
// Ctrl+Option+Q on a selection opens its panel.
import Carbon.HIToolbox
import SwiftUI

@main struct CompanionApp: App {
  @NSApplicationDelegateAdaptor(Delegate.self) private var delegate

  init() {
    CLI.run()
  }

  var body: some Scene {
    MenuBarExtra("Quire Companion", systemImage: "text.badge.checkmark") {
      MenuItems()
    }
    Window("Quire Companion Settings", id: "settings") {
      SettingsView()
    }
    .windowResizability(.contentSize)
    .defaultLaunchBehavior(.suppressed)
  }
}

private struct MenuItems: View {
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    Button("Check Selection   ⌃⌥Q") { Companion.show() }
    Button("Settings...") {
      openWindow(id: "settings")
      NSApp.activate()
    }
    Divider()
    Button("Quit Quire Companion") { NSApp.terminate(nil) }
  }
}

final class Delegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    signal(SIGPIPE, SIG_IGN)  // the agent may quit while we write to it
    // Asks macOS to show the Accessibility switch the first time.
    AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    var ref: EventHotKeyRef?
    RegisterEventHotKey(
      UInt32(kVK_ANSI_Q), UInt32(controlKey | optionKey), EventHotKeyID(signature: 0x5155_4952, id: 1),  // "QUIR"
      GetApplicationEventTarget(), 0, &ref)
    var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
      Task { @MainActor in Companion.show() }
      return noErr
    }, 1, &pressed, nil, nil)
    MainActor.assumeIsolated { Live.shared.start() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    Agent.shared.stop()
  }
}

struct SettingsView: View {
  @AppStorage("engine") private var engine = Engine.acp.rawValue
  @AppStorage("agent") private var agent = "claude-acp"
  @AppStorage("apiURL") private var apiURL = ""
  @AppStorage("apiModel") private var apiModel = ""
  @State private var key = Keychain.read()
  @AppStorage("liveApps") private var liveApps = ""

  var body: some View {
    Form {
      Picker("Model", selection: $engine) {
        ForEach(Engine.allCases) { Text($0.label).tag($0.rawValue) }
      }
      .pickerStyle(.radioGroup)
      switch Engine(rawValue: engine) ?? .acp {
      case .acp:
        Picker("Agent", selection: $agent) {
          ForEach(Registry.agents) { Text($0.name).tag($0.id) }
        }
        note("It signs in with your own subscription. It may only answer with text: Quire Companion refuses every tool it asks for. Suggestions use its fastest model.")
      case .apple:
        note(AppleModel.problem ?? "Ready. Your text never leaves this Mac.")
      case .api:
        TextField("Address", text: $apiURL, prompt: Text("https://api.groq.com/openai/v1"))
        TextField("Model", text: $apiModel, prompt: Text("llama-3.3-70b-versatile"))
        SecureField("API key", text: $key, prompt: Text("Kept in your Keychain"))
          .onChange(of: key) { Keychain.write(key) }
        note("Any API that talks like OpenAI's: OpenAI, Groq, OpenRouter, Ollama (http://localhost:11434/v1), LM Studio.")
      }
      Section("Underline mistakes as you type") {
        ForEach(Live.apps, id: \.id) { app in
          Toggle(app.name, isOn: Binding(
            get: { Prefs.liveApps.contains(app.id) },
            set: { on in
              var apps = Prefs.liveApps
              if on { apps.insert(app.id) } else { apps.remove(app.id) }
              liveApps = apps.sorted().joined(separator: ",")
            }))
        }
        note("Off until you turn an app on. Each line you can see is checked once you stop typing; click a squiggle to fix it. With the agent every check counts against your subscription. Apple's model is free and private but finds fewer mistakes.")
        if let problem = Live.shared.problem { Text(problem).font(.callout).foregroundStyle(.red) }
      }
      Section {
        note("Select text in any app and press Ctrl+Option+Q.")
      }
    }
    .formStyle(.grouped)
    .frame(width: 480)
  }

  private func note(_ text: String) -> some View {
    Text(text).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
  }
}

/// Test hooks, without the menu bar. They use the engine chosen in Settings:
///   --selftest                    checks the reading of a model's fixes
///   --check TEXT                  prints the fixes for TEXT
///   --rewrite INSTRUCTION TEXT    prints TEXT rewritten
enum CLI {
  static func run() {
    let a = CommandLine.arguments
    if a.contains("--selftest") {
      selftest()
      print("ok")
      exit(0)
    }
    guard a.count >= 3, a[1] == "--check" || (a[1] == "--rewrite" && a.count >= 4) else { return }
    signal(SIGPIPE, SIG_IGN)
    Task.detached {
      do {
        print("Engine: \(Engine.current.label)")
        if a[1] == "--check" {
          for fix in try await Ask.check(a[2]) {
            let c = fix.change
            print("[\(fix.category)] \(c.old) -> \(c.new)   in \"\(fix.original)\"\n  \(fix.reason)")
          }
        } else {
          print(try await Ask.rewrite(a[3], a[2]))
        }
        Agent.shared.stop()
        exit(0)
      } catch {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        Agent.shared.stop()
        exit(1)
      }
    }
    DispatchSemaphore(value: 0).wait()  // the task above ends the program
  }

  private static func selftest() {
    let text = "Their going to the libary."
    let reply = """
      <think>Two mistakes.</think>
      ```json
      [{"original": "Their going", "suggestion": "They're going", "reason": "wrong word"},
       {"original": "not in the text", "suggestion": "x", "reason": "made up"},
       {"original": "the libary", "suggestion": "the libary", "reason": "no change"}]
      ```
      """
    let fixes = Fix.parse(reply, in: text)
    precondition(fixes?.count == 1 && fixes?[0].suggestion == "They're going", "fixes not found in the text are dropped")
    precondition(Fix.parse("I found nothing to fix.", in: text) == nil, "a reply without a list is not 'no mistakes'")
    precondition(Fix.parse("[]", in: text)?.isEmpty == true)
    precondition(clean("```\nHello\n```") == "Hello" && clean("```") == "```")
    let change = { (o: String, s: String) in Fix(original: o, suggestion: s, category: "Grammar", reason: "").change }
    precondition(change("has less projects", "has fewer projects") == ("has ", "less", "fewer", " projects"))
    precondition(change("However the", "However, the") == ("", "However", "However,", " the"), "a comma only added comes with its word")
    precondition(change("to the libary", "to the library") == ("to the ", "libary", "library", ""))
  }
}
