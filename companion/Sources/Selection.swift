// Reads the selected text in the app in front and puts new text in its place: through
// Accessibility where the app allows it, else through the clipboard (Cmd+C, Cmd+V). In a test
// on 2026-10-19 Accessibility was enough only in Notes: Discord and Word read through it but
// ignore a write while answering that it worked, and Mail's message body gives no text at all.
import AppKit
import Carbon.HIToolbox

/// The selected text and where it came from, to put the new text back there.
struct Selection {
  let app: NSRunningApplication
  let element: AXUIElement?  // nil: read through the clipboard
  let text: String
}

private func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

private func selected(in app: AXUIElement) -> (AXUIElement, String)? {
  guard let el = attr(app, kAXFocusedUIElementAttribute).map({ $0 as! AXUIElement }),
    let text = attr(el, kAXSelectedTextAttribute) as? String, !text.isEmpty
  else { return nil }
  return (el, text)
}

enum Selections {
  /// The selected text in the app in front, or nil when nothing is selected.
  static func read() -> Selection? {
    waitForKeysUp()
    // Not the system-wide element's focused app: with some apps in front (Dia), that fails.
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    if let (el, text) = selected(in: ax) { return Selection(app: app, element: el, text: text) }
    // Chromium and Electron build their tree only for a client that asks for it.
    if AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
      usleep(300_000)
      if let (el, text) = selected(in: ax) { return Selection(app: app, element: el, text: text) }
    }
    let saved = Clipboard.save()
    defer { Clipboard.restore(saved) }
    guard let text = Clipboard.copy(), !text.isEmpty else { return nil }
    return Selection(app: app, element: nil, text: text)
  }

  /// Puts `text` in place of the selection. Its app must be in front again.
  static func write(_ text: String, to selection: Selection) {
    if let el = selection.element {
      let before = attr(el, kAXValueAttribute) as? String
      // Discord and Word answer success and change nothing: only a changed text counts.
      if AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, text as CFString) == .success,
        let after = attr(el, kAXValueAttribute) as? String, after != before, after.contains(text)
      {
        return
      }
    }
    let saved = Clipboard.save()
    Clipboard.paste(text)
    Clipboard.restore(saved)
  }

  /// The hotkey's own keys may still be down, and Cmd+C with Option held is another command.
  private static func waitForKeysUp() {
    let mods: CGEventFlags = [.maskCommand, .maskAlternate, .maskControl, .maskShift]
    for _ in 0..<40 where !CGEventSource.flagsState(.combinedSessionState).intersection(mods).isEmpty {
      usleep(25_000)
    }
  }
}

/// The writer's clipboard is kept whole (every item, every type) and put back after use.
enum Clipboard {
  typealias Saved = [[NSPasteboard.PasteboardType: Data]]

  static func save() -> Saved {
    (NSPasteboard.general.pasteboardItems ?? []).map { item in
      Dictionary(uniqueKeysWithValues: item.types.compactMap { t in item.data(forType: t).map { (t, $0) } })
    }
  }

  static func restore(_ saved: Saved) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.writeObjects(saved.map { types in
      let item = NSPasteboardItem()
      for (t, data) in types { item.setData(data, forType: t) }
      return item
    })
  }

  /// The selection, copied with Cmd+C. Nil when nothing is selected or the app did not copy.
  static func copy() -> String? {
    let pb = NSPasteboard.general
    let before = pb.changeCount
    command(kVK_ANSI_C)
    for _ in 0..<40 {
      usleep(25_000)
      if pb.changeCount != before { return pb.string(forType: .string) }
    }
    return nil
  }

  static func paste(_ text: String) {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(text, forType: .string)
    // Clipboard managers that follow nspasteboard.org leave this out of their history.
    pb.setData(Data(), forType: .init("org.nspasteboard.TransientType"))
    command(kVK_ANSI_V)
    usleep(500_000)  // the app reads the clipboard after the key, not at once
  }

  private static func command(_ key: Int) {
    let source = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(key), keyDown: down)!
      e.flags = .maskCommand
      e.post(tap: .cghidEventTap)
    }
  }
}
