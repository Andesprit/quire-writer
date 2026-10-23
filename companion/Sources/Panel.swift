// The panel the hotkey opens under the selection, in the manner of Grammarly's card: the text
// with the current mistake marked, one suggestion at a time (its kind, the change, why), then
// Quire's rewrite styles and a box to ask for any change. Nothing reaches the other app until
// the writer presses Replace.
import AppKit
import SwiftUI

private let green = Color(red: 0.01, green: 0.49, blue: 0.43)

@MainActor @Observable final class Draft {
  var selection: Selection?
  var text = ""  // the new text so far
  var fixes: [Fix] = []  // the ones not accepted or dismissed yet
  var current = 0
  var found = 0  // how many the last check found
  var accepted = 0
  var checked = false
  var ask = ""
  var status = ""
  var failed = false
  var busy = false
  private var request = 0  // a newer selection or request wins

  var fix: Fix? { fixes.indices.contains(current) ? fixes[current] : nil }

  func start(_ selection: Selection?, status: String = "") {
    request += 1
    (self.selection, text, ask, self.status, failed, busy) = (selection, selection?.text ?? "", "", status, false, false)
    (fixes, current, found, accepted, checked) = ([], 0, 0, 0, false)
    if selection != nil { check() }
  }

  func check() {
    let text = text
    let starting = Engine.current == .acp && !Agent.shared.isRunning
    run(starting ? "Starting the agent. Its first start can take a minute..." : "Checking...", { try await Ask.check(text) }) { [self] in
      (fixes, current, found, checked) = ($0, 0, $0.count, true)
    }
  }

  func rewrite(_ instruction: String, keep: Bool) {
    let (text, instruction) = (text, instruction.trimmingCharacters(in: .whitespacesAndNewlines))
    guard !instruction.isEmpty else { return }
    run("Rewriting...", { try await Ask.rewrite(text, keep ? instruction + Ask.keep : instruction) }) { [self] in
      (self.text, fixes, current, found, checked, ask) = ($0, [], 0, 0, false, "")
    }
  }

  func accept(_ fix: Fix) {
    if let r = text.range(of: fix.original) {
      text.replaceSubrange(r, with: fix.suggestion)
      accepted += 1
    }
    dismiss(fix)
  }

  func dismiss(_ fix: Fix) {
    fixes.removeAll { $0.id == fix.id }
    current = min(current, max(fixes.count - 1, 0))
  }

  func step(_ by: Int) {
    if !fixes.isEmpty { current = (current + by + fixes.count) % fixes.count }
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
          Text(marked).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 120)
        .fixedSize(horizontal: false, vertical: true)
        if let fix = draft.fix {
          let count: Int = draft.fixes.count
          let step: (Int) -> Void = { draft.step($0) }
          let acceptAll: () -> Void = { for fix in draft.fixes { draft.accept(fix) } }
          FixCard(
            fix: fix, position: count > 1 ? (draft.current, count, step) : nil,
            accept: { draft.accept(fix) }, dismiss: { draft.dismiss(fix) },
            acceptAll: count > 1 ? acceptAll : nil)
        } else if draft.checked {
          done
        }
        rewrite
      }
      footer
    }
    .padding(16)
    .frame(width: 440)
  }

  /// The text, with the words the current suggestion changes underlined as Grammarly does.
  private var marked: AttributedString {
    var s = AttributedString(draft.text)
    guard let fix = draft.fix, let whole = s.range(of: fix.original) else { return s }
    let change = fix.change
    let from = s.characters.index(whole.lowerBound, offsetBy: change.before.count)
    let to = s.characters.index(from, offsetBy: max(change.old.count, 1))
    s[from..<to].underlineStyle = Text.LineStyle(pattern: .solid, color: fix.color)
    s[from..<to].backgroundColor = fix.color.opacity(0.15)
    return s
  }

  private var done: some View {
    Label(
      draft.found == 0 ? "No mistakes found." : "All suggestions reviewed: \(draft.accepted) accepted.",
      systemImage: "checkmark.circle.fill"
    )
    .foregroundStyle(green)
  }

  private var rewrite: some View {
    VStack(alignment: .leading, spacing: 8) {
      Divider()
      HStack {
        Text("Rewrite").foregroundStyle(.secondary)
        ForEach(Ask.styles, id: \.name) { style in
          Button(style.name) { draft.rewrite(style.instruction, keep: true) }
        }
        Spacer()
        Button { draft.check() } label: { Image(systemName: "arrow.clockwise") }.help("Check again")
      }
      .controlSize(.small)
      TextField("Ask for a change, then press Return", text: $draft.ask)
        .onSubmit { draft.rewrite(draft.ask, keep: false) }
    }
    .disabled(draft.busy)
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        if draft.busy { ProgressView().controlSize(.small) }
        Text(draft.status)
          .font(.callout)
          .foregroundStyle(draft.failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
        Button("Cancel") { Companion.close() }.keyboardShortcut(.cancelAction)
        if let selection = draft.selection {
          let replace = Button("Replace") { Companion.replace() }.disabled(draft.busy || draft.text == selection.text)
          // Return accepts the suggestion on screen; once none is left, it replaces.
          if draft.fix == nil { replace.keyboardShortcut(.defaultAction) } else { replace }
        }
      }
      Text("\(Engine.current.label)  ·  ⌃⌥Q on a selection in any app")
        .font(.caption2)
        .foregroundStyle(.tertiary)
    }
  }
}

extension Fix {
  var color: Color { category == "Word choice" ? .blue : .red }
}

/// One suggestion, as Grammarly shows it: its kind, the change, why, Accept and Dismiss.
struct FixCard: View {
  let fix: Fix
  var position: (index: Int, count: Int, step: (Int) -> Void)?
  let accept: () -> Void
  let dismiss: () -> Void
  var acceptAll: (() -> Void)?

  var body: some View {
    let change = fix.change
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        Circle().fill(fix.color).frame(width: 7, height: 7)
        Text(fix.category).foregroundStyle(.secondary)
        Spacer()
        if let position {
          Text("\(position.index + 1) of \(position.count)").font(.callout).foregroundStyle(.secondary).monospacedDigit()
          Button { position.step(-1) } label: { Image(systemName: "chevron.left") }.help("Previous suggestion")
          Button { position.step(1) } label: { Image(systemName: "chevron.right") }.help("Next suggestion")
        }
      }
      .buttonStyle(.borderless)
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        if !change.old.isEmpty {
          Text(change.old).strikethrough(color: .red).foregroundStyle(.secondary)
          Image(systemName: "arrow.right").foregroundStyle(.secondary)
        }
        Text(change.new.isEmpty ? "Remove" : change.new)
          .foregroundStyle(.white)
          .padding(.horizontal, 8)
          .padding(.vertical, 3)
          .background(change.new.isEmpty ? Color.red : green, in: .rect(cornerRadius: 5))
      }
      .font(.title3)
      if !fix.reason.isEmpty {
        Text(fix.reason).fixedSize(horizontal: false, vertical: true)
      }
      HStack(spacing: 14) {
        // Drawn by hand: macOS greys a standard button out in a window that is not active,
        // and the live card never is.
        Button(action: accept) {
          Text("Accept").foregroundStyle(.white).padding(.horizontal, 12).padding(.vertical, 5)
            .background(green, in: .rect(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.defaultAction)
        Button("Dismiss", action: dismiss).buttonStyle(.borderless)
        Spacer()
        if let acceptAll, let position {
          Button("Accept all \(position.count)", action: acceptAll).buttonStyle(.borderless)
        }
      }
    }
    .padding(14)
    .background(RoundedRectangle(cornerRadius: 10).strokeBorder(green, lineWidth: 1.5))
  }
}

/// A panel that takes the keyboard without bringing Quire Companion to the front: the other
/// app stays active, with its selection.
final class Panel: NSPanel {
  override var canBecomeKey: Bool { true }
}

@MainActor enum Companion {
  static let draft = Draft()
  private static var top: CGFloat = 0  // the panel grows down from here as suggestions arrive

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
    // A window grows up from its bottom edge; keep the top edge where it was instead.
    NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: p, queue: .main) { _ in
      MainActor.assumeIsolated { p.setFrameOrigin(NSPoint(x: p.frame.minX, y: max(top - p.frame.height, 0))) }
    }
    NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: p, queue: .main) { _ in
      MainActor.assumeIsolated { top = p.frame.maxY }
    }
    return p
  }()

  /// The hotkey: reads the selection in the app in front and opens the panel on it.
  static func show() {
    guard AXIsProcessTrusted() else {
      draft.start(nil, status: "Quire Companion needs Accessibility to read your selection. Turn it on in System Settings > Privacy & Security > Accessibility, then press ⌃⌥Q again.")
      return open(near: nil)
    }
    let selection = Selections.read()
    draft.start(selection, status: selection == nil ? "Select some text first, then press ⌃⌥Q." : "")
    open(near: selection?.bounds)
  }

  static func close() {
    draft.start(nil)  // a request still running is dropped
    panel.orderOut(nil)
  }

  static func replace() {
    guard let selection = draft.selection else { return }
    let text = draft.text
    panel.orderOut(nil)  // hidden, not closed: the keys sent next go to the app, not to the panel
    selection.app.activate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
      // The panel comes back with the new text, so nothing is lost when the selection moved.
      guard Selections.unchanged(selection) else {
        (draft.failed, draft.status) = (true, "The selection in \(selection.app.localizedName ?? "the app") changed. Select the same text again, then press Replace.")
        panel.orderFrontRegardless()
        return
      }
      close()
      Selections.write(text, to: selection)
    }
  }

  /// Under the selection when the app says where it is (`text`, top-left origin), else under
  /// the pointer; inside the screen either way.
  private static func open(near text: CGRect?) {
    panel.layoutIfNeeded()
    let height = NSScreen.screens.first?.frame.height ?? 0  // Accessibility measures from its top
    let at = text.map { NSPoint(x: $0.minX - 16, y: height - $0.maxY - 6) } ?? NSEvent.mouseLocation.applying(.init(translationX: -16, y: -12))
    let screen = (NSScreen.screens.first { $0.frame.contains(at) } ?? NSScreen.main)?.visibleFrame ?? .zero
    let size = panel.frame.size
    top = min(max(at.y, screen.minY + size.height), screen.maxY)
    panel.setFrameOrigin(NSPoint(x: min(max(at.x, screen.minX), screen.maxX - size.width), y: top - size.height))
    panel.orderFrontRegardless()
    panel.makeKey()
  }
}
