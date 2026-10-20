// Live underlines. In the apps the writer turns on, Quire Companion checks each line they can
// see once they stop typing, and draws a squiggle under each mistake; a click on one opens its
// card. Word positions come from Accessibility (Notes, Word) or from WebKit's text markers
// (Mail), as tested on 2026-10-19. Chromium apps (Slack, Discord) give no word positions yet.
import AppKit
import SwiftUI

/// The focused text field of the app in front, read and measured through Accessibility.
struct Field {
  let app: NSRunningApplication
  let element: AXUIElement
  let web: Bool  // WebKit (Mail): text markers instead of ranges

  /// Nil unless the writer turned underlines on for the app in front and a field they can
  /// edit has the focus: never a password, never an email they are only reading.
  static func current() -> Field? {
    guard let app = NSWorkspace.shared.frontmostApplication, Prefs.liveApps.contains(app.bundleIdentifier ?? ""),
      let el = attr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute).map({ $0 as! AXUIElement })
    else { return nil }
    let role = attr(el, kAXRoleAttribute) as? String ?? ""
    var editable: DarwinBoolean = false
    AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &editable)
    guard editable.boolValue, ["AXTextArea", "AXTextField", "AXWebArea"].contains(role),
      attr(el, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole
    else { return nil }
    return Field(app: app, element: el, web: role == "AXWebArea")
  }

  func text() -> String? {
    if !web { return attr(element, kAXValueAttribute) as? String }
    return param("AXTextMarkerRangeForUIElement", element).flatMap { param("AXStringForTextMarkerRange", $0) as? String }
  }

  /// Where `range` (UTF-16, as Accessibility counts) is on screen, top-left origin.
  func rect(_ range: NSRange) -> CGRect? {
    let value: CFTypeRef?
    if web {
      value = markers(range).flatMap { param("AXBoundsForTextMarkerRange", $0) }
    } else {
      var r = CFRange(location: range.location, length: range.length)
      value = param(kAXBoundsForRangeParameterizedAttribute, AXValueCreate(.cfRange, &r)!)
    }
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var rect = CGRect.zero
    return AXValueGetValue(value as! AXValue, .cgRect, &rect) && rect.height > 0 ? rect : nil
  }

  /// Selects `range`, and says whether what got selected is `expected`: only then is it safe
  /// to type over it.
  func select(_ range: NSRange, expecting expected: String) -> Bool {
    if web {
      guard let m = markers(range) else { return false }
      AXUIElementSetAttributeValue(element, "AXSelectedTextMarkerRange" as CFString, m)
      return attr(element, "AXSelectedTextMarkerRange").flatMap { param("AXStringForTextMarkerRange", $0) as? String } == expected
    }
    var r = CFRange(location: range.location, length: range.length)
    AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, AXValueCreate(.cfRange, &r)!)
    return attr(element, kAXSelectedTextAttribute) as? String == expected
  }

  /// The part of the screen the field's text shows in: its scroll area, else its window.
  var visible: CGRect? {
    var el: AXUIElement? = element
    while let e = el {
      if ["AXScrollArea", "AXWindow"].contains(attr(e, kAXRoleAttribute) as? String),
        let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute)
      {
        var (origin, size) = (CGPoint.zero, CGSize.zero)
        AXValueGetValue(p as! AXValue, .cgPoint, &origin)
        AXValueGetValue(s as! AXValue, .cgSize, &size)
        return CGRect(origin: origin, size: size)
      }
      el = attr(e, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return nil
  }

  private func markers(_ range: NSRange) -> CFTypeRef? {
    guard let a = param("AXTextMarkerForIndex", range.location as CFNumber),
      let b = param("AXTextMarkerForIndex", NSMaxRange(range) as CFNumber)
    else { return nil }
    return param("AXTextMarkerRangeForUnorderedTextMarkers", [a, b] as CFArray)
  }

  private func param(_ name: String, _ p: CFTypeRef) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyParameterizedAttributeValue(element, name as CFString, p, &v) == .success ? v : nil
  }
}

/// A line with text in it, and where it starts in the whole text (UTF-16). Word ends its
/// lines with \r, Notes and Mail with \n.
private struct Line {
  let text: String
  let start: Int

  static func all(_ text: String) -> [Line] {
    let ns = text as NSString
    return pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)).map {
      Line(text: ns.substring(with: $0.range), start: $0.range.location)
    }
  }
  private static let pattern = try! NSRegularExpression(pattern: "[^\\r\\n\\u2028\\u2029]*\\S[^\\r\\n\\u2028\\u2029]*")

  /// Where the words `fix` changes are, in the whole text.
  func range(of fix: Fix) -> NSRange? {
    let at = (text as NSString).range(of: fix.original)
    guard at.location != NSNotFound else { return nil }
    let change = fix.change
    return NSRange(location: start + at.location + (change.before as NSString).length, length: max((change.old as NSString).length, 1))
  }
}

@MainActor @Observable final class Live {
  static let shared = Live()
  /// The apps underlines were tested in. Each one is off until the writer turns it on.
  static let apps: [(id: String, name: String)] = [("com.apple.Notes", "Notes"), ("com.microsoft.Word", "Microsoft Word"), ("com.apple.mail", "Mail")]

  var shown: (fix: Fix, line: String)?  // the suggestion the card shows
  var problem: String?  // why the last check failed

  // A line's text: its fixes not accepted or dismissed yet. A line is checked once per text.
  @ObservationIgnored private var checked: [String: [Fix]] = [:]
  @ObservationIgnored private var drawn: [(fix: Fix, line: String, rect: CGRect)] = []
  @ObservationIgnored private var lastText = ""
  @ObservationIgnored private var changed = Date.distantPast
  @ObservationIgnored private var checking = false
  @ObservationIgnored private let overlay = Overlay()
  @ObservationIgnored private lazy var card: NSPanel = {
    let p = NSPanel(contentRect: .zero, styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    p.becomesKeyOnlyIfNeeded = true  // the writer's keyboard stays in their app
    p.level = .floating
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    let host = NSHostingController(rootView: LiveCard(live: self))
    host.sizingOptions = .preferredContentSize
    p.contentViewController = host
    return p
  }()

  func start() {
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5)  // a busy app must not stall this one
    // ponytail: polled 4 times a second, so the lines trail a fast scroll by up to 0.25 s, and the
    // whole text is read each time (heavy for a long Word document). Accessibility
    // notifications (AXObserver) if that shows.
    Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in MainActor.assumeIsolated { Live.shared.tick() } }
    NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { _ in MainActor.assumeIsolated { Live.shared.clicked() } }
  }

  private func tick() {
    guard let field = Field.current(), let text = field.text(), let visible = field.visible else {
      (drawn, shown) = ([], nil)
      overlay.draw([])
      card.orderOut(nil)
      return
    }
    if text != lastText { (lastText, changed) = (text, Date()) }
    let lines = Line.all(text)
    let covers = covering(field.app.processIdentifier)
    // The lines found again in the text as it is now, where the app says they are.
    drawn = lines.flatMap { line in
      (checked[line.text] ?? []).compactMap { fix in
        guard let r = line.range(of: fix).flatMap(field.rect), r.intersects(visible), !covers.contains(where: r.intersects) else { return nil }
        return (fix, line.text, r)
      }
    }
    overlay.draw(drawn.map { Squiggle(rect: $0.rect, color: NSColor($0.fix.color)) })
    if let shown, !drawn.contains(where: { $0.fix.id == shown.fix.id }) { hideCard() }  // edited or scrolled away
    // Once the writer stops typing, check the next line they can see that was not checked.
    guard !checking, Date().timeIntervalSince(changed) > 1 else { return }
    // ponytail: at most 40 unchecked lines are measured per tick; a long document gets the rest later.
    let unchecked = lines.lazy.filter { self.checked[$0.text] == nil && $0.text.split(separator: " ").count >= 3 }.prefix(40)
    guard let line = unchecked.first(where: { field.rect(NSRange(location: $0.start, length: 1))?.intersects(visible) == true }) else { return }
    if checked.count > 2000 { checked = [:] }  // ponytail: forgets everything rather than the oldest
    checking = true
    Task {
      do {
        checked[line.text] = try await Ask.check(line.text)
        problem = nil
      } catch {
        checked[line.text] = []  // not asked again until the line changes
        problem = error.localizedDescription
      }
      checking = false
    }
  }

  /// The windows of other apps in front of the app `pid`'s front window (top-left origin):
  /// the overlay sits over every window, so a squiggle under one of them is left out.
  // ponytail: normal windows only; another app's floating panel over the text still gets lines.
  private func covering(_ pid: pid_t) -> [CGRect] {
    var covers: [CGRect] = []
    for w in CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [] {
      guard w[kCGWindowLayer as String] as? Int == 0 else { continue }
      let owner = w[kCGWindowOwnerPID as String] as? pid_t
      if owner == pid { break }  // front to back: the rest are behind it
      if owner != getpid(), let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) { covers.append(r) }
    }
    return covers
  }

  private func clicked() {
    let m = NSEvent.mouseLocation
    let top = NSScreen.screens.first?.frame.height ?? 0  // Accessibility measures from the top
    let at = CGPoint(x: m.x, y: top - m.y)
    guard let hit = drawn.first(where: { $0.rect.insetBy(dx: -2, dy: -4).contains(at) }) else { return hideCard() }
    shown = (hit.fix, hit.line)
    DispatchQueue.main.async { [self] in  // once the card has its new size
      card.setFrameOrigin(NSPoint(x: hit.rect.minX - 14, y: top - hit.rect.maxY - 8 - card.frame.height))
      card.orderFrontRegardless()
    }
  }

  func accept() {
    guard let (fix, line) = shown else { return }
    hideCard()
    guard let field = Field.current(), let text = field.text(),
      let range = Line.all(text).first(where: { $0.text == line })?.range(of: fix),
      field.select(range, expecting: fix.change.old)
    else { return NSSound.beep() }
    // The line's other fixes carry over to its new text, so it is not asked about again.
    if let r = line.range(of: fix.original) {
      var after = line
      after.replaceSubrange(r, with: fix.suggestion)
      checked[after] = checked[line]?.filter { $0.id != fix.id }
    }
    let selection = Selection(app: field.app, element: field.web ? nil : field.element, text: fix.change.old, bounds: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { Selections.write(fix.change.new, to: selection) }
  }

  func dismiss() {
    guard let (fix, line) = shown else { return }
    checked[line] = checked[line]?.filter { $0.id != fix.id }
    hideCard()
  }

  private func hideCard() {
    card.orderOut(nil)  // first: an empty card on screen made AppKit lay it out until the stack ran out
    shown = nil
  }
}

private struct LiveCard: View {
  let live: Live

  var body: some View {
    if let shown = live.shown {
      FixCard(fix: shown.fix, accept: live.accept, dismiss: live.dismiss)
        .background(Color(nsColor: .windowBackgroundColor), in: .rect(cornerRadius: 10))
        .frame(width: 360)
    } else {
      Color.clear.frame(width: 360, height: 10)  // never zero-sized: see hideCard
    }
  }
}

struct Squiggle: Equatable {
  let rect: CGRect  // the word, top-left origin
  let color: NSColor
}

/// A window over the apps that draws the squiggles and lets every click through.
private final class Overlay {
  private let window = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
  private let view = Squiggles()

  init() {
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue + 1)  // over the app, under the cards
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    window.contentView = view
  }

  /// The window covers only the strips the squiggles take, under the words, not the screen.
  func draw(_ squiggles: [Squiggle]) {
    let top = NSScreen.screens.first?.frame.height ?? 0
    let words = squiggles.map { CGRect(x: $0.rect.minX, y: top - $0.rect.maxY, width: $0.rect.width, height: $0.rect.height) }
    guard let frame = words.map({ CGRect(x: $0.minX - 1, y: $0.minY - 2, width: $0.width + 2, height: 6) }).reduce(nil, { $0?.union($1) ?? $1 })
    else { return window.orderOut(nil) }
    if window.frame != frame { window.setFrame(frame, display: false) }
    view.squiggles = zip(words, squiggles).map { word, s in
      Squiggle(rect: word.offsetBy(dx: -frame.minX, dy: -frame.minY), color: s.color)
    }
    if !window.isVisible { window.orderFrontRegardless() }
  }
}

private final class Squiggles: NSView {
  var squiggles: [Squiggle] = [] {
    didSet { if squiggles != oldValue { needsDisplay = true } }
  }

  override func draw(_ dirtyRect: NSRect) {
    for s in squiggles {
      let path = NSBezierPath()
      path.lineWidth = 1.5
      let y = s.rect.minY + 2  // just under the letters, in the line's bottom margin
      var (x, up) = (s.rect.minX, true)
      path.move(to: NSPoint(x: x, y: y))
      while x < s.rect.maxX {
        x = min(x + 2, s.rect.maxX)
        path.line(to: NSPoint(x: x, y: up ? y - 2 : y))
        up.toggle()
      }
      s.color.setStroke()
      path.stroke()
    }
  }
}
