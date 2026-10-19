// The panel the hotkey opens next to the pointer: the selected text, the fixes the model
// suggests, Quire's rewrite styles, a box to ask for any change, and Replace. Nothing reaches
// the other app until the writer presses Replace.
import AppKit
import SwiftUI

@MainActor @Observable final class Draft {
  var selection: Selection?
  var text = ""  // the new text so far
  var fixes: [Fix] = []
  var checked = false
  var ask = ""
  var status = ""
  var failed = false
  var busy = false
  private var request = 0  // a newer selection or request wins

  func start(_ selection: Selection?, status: String = "") {
    request += 1
    (self.selection, text, fixes, checked, ask, self.status, failed, busy) = (selection, selection?.text ?? "", [], false, "", status, false, false)
    if selection != nil { check() }
  }

  func check() {
    let text = text
    let starting = Engine.current == .acp && !Agent.shared.isRunning
    run(starting ? "Starting the agent. Its first start can take a minute..." : "Checking...", { try await Ask.check(text) }) { [self] in
      (fixes, checked) = ($0, true)
    }
  }

  func rewrite(_ instruction: String, keep: Bool) {
    let (text, instruction) = (text, instruction.trimmingCharacters(in: .whitespacesAndNewlines))
    guard !instruction.isEmpty else { return }
    run("Rewriting...", { try await Ask.rewrite(text, keep ? instruction + Ask.keep : instruction) }) { [self] in
      (self.text, fixes, checked, ask) = ($0, [], false, "")
    }
  }

  func accept(_ fix: Fix) {
    if let r = text.range(of: fix.original) { text.replaceSubrange(r, with: fix.suggestion) }
    fixes.removeAll { $0.id == fix.id }
  }

  private func run<T>(_ doing: String, _ ask: @escaping () async throws -> T, then apply: @escaping (T) -> Void) {
    request += 1
    let me = request
    (busy, failed, status) = (true, false, doing)
    Task {
      do {
        let result = try await ask()
        guard me == request else { return }
        apply(result)
        status = ""
      } catch {
        guard me == request else { return }
        (failed, status) = (true, error.localizedDescription)
      }
      busy = false
    }
  }
}

struct PanelView: View {
  @Bindable var draft: Draft

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if draft.selection != nil {
        ScrollView {
          Text(draft.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 150)
        .fixedSize(horizontal: false, vertical: true)
        .padding(8)
        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 6))
        ForEach(draft.fixes) { fix in
          HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
              Text(fix.original).strikethrough().foregroundStyle(.secondary)
              Text(fix.suggestion)
              if !fix.reason.isEmpty { Text(fix.reason).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            Button("Accept") { draft.accept(fix) }
          }
        }
        if draft.fixes.count > 1 {
          Button("Accept All") { for fix in draft.fixes { draft.accept(fix) } }
        } else if draft.checked && draft.fixes.isEmpty {
          Label("No mistakes found.", systemImage: "checkmark").foregroundStyle(.secondary)
        }
        HStack {
          ForEach(Ask.styles, id: \.name) { style in
            Button(style.name) { draft.rewrite(style.instruction, keep: true) }
          }
          Spacer()
          Button("Check") { draft.check() }
        }
        .disabled(draft.busy)
        TextField("Ask for a change, then press Return", text: $draft.ask)
          .onSubmit { draft.rewrite(draft.ask, keep: false) }
          .disabled(draft.busy)
      }
      HStack(alignment: .firstTextBaseline) {
        if draft.busy { ProgressView().controlSize(.small) }
        Text(draft.status)
          .font(.callout)
          .foregroundStyle(draft.failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
        Button("Cancel") { Companion.close() }.keyboardShortcut(.cancelAction)
        if let selection = draft.selection {
          Button("Replace") { Companion.replace() }
            .keyboardShortcut(.defaultAction)
            .disabled(draft.busy || draft.text == selection.text)
        }
      }
      Text("\(Engine.current.label)  ·  ⌃⌥Q on a selection in any app")
        .font(.caption2)
        .foregroundStyle(.tertiary)
    }
    .padding(16)
    .frame(width: 460)
  }
}

/// A panel that takes the keyboard without bringing Quire Companion to the front: the other
/// app stays active, with its selection.
final class Panel: NSPanel {
  override var canBecomeKey: Bool { true }
}

@MainActor enum Companion {
  static let draft = Draft()

  static let panel: Panel = {
    let p = Panel(
      contentRect: .zero, styleMask: [.nonactivatingPanel, .titled, .closable, .fullSizeContentView],
      backing: .buffered, defer: false)
    p.title = "Quire Companion"
    p.titlebarAppearsTransparent = true
    p.level = .floating
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    let host = NSHostingController(rootView: PanelView(draft: draft))
    host.sizingOptions = .preferredContentSize
    p.contentViewController = host
    return p
  }()

  /// The hotkey: reads the selection in the app in front and opens the panel on it.
  static func show() {
    guard AXIsProcessTrusted() else {
      draft.start(nil, status: "Quire Companion needs Accessibility to read your selection. Turn it on in System Settings > Privacy & Security > Accessibility, then press ⌃⌥Q again.")
      return open()
    }
    let selection = Selections.read()
    draft.start(selection, status: selection == nil ? "Select some text first, then press ⌃⌥Q." : "")
    open()
  }

  static func close() {
    draft.start(nil)  // a request still running is dropped
    panel.orderOut(nil)
  }

  static func replace() {
    guard let selection = draft.selection else { return }
    let text = draft.text
    close()
    selection.app.activate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { Selections.write(text, to: selection) }
  }

  /// Next to the pointer, inside the screen.
  private static func open() {
    panel.layoutIfNeeded()
    let mouse = NSEvent.mouseLocation
    let screen = (NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main)?.visibleFrame ?? .zero
    let size = panel.frame.size
    panel.setFrameOrigin(NSPoint(
      x: min(max(mouse.x + 12, screen.minX), screen.maxX - size.width),
      y: min(max(mouse.y - size.height - 12, screen.minY), screen.maxY - size.height)))
    panel.orderFrontRegardless()
    panel.makeKey()
  }
}
