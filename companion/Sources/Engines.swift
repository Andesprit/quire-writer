// The three ways to ask a model, as in Quire: the agent (ACP), Apple's on-device model, or an
// API that talks like OpenAI's (Groq, Ollama, LM Studio, OpenAI, ...). The prompts are
// Quire's, for text from any app instead of a Typst or LaTeX document.
import Foundation
import FoundationModels
import Security

struct Failure: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

enum Engine: String, CaseIterable, Identifiable {
  case acp, apple, api
  var id: String { rawValue }
  var label: String {
    switch self {
    case .acp: "Agent (ACP)"
    case .apple: "Apple on-device"
    case .api: "OpenAI-compatible API"
    }
  }
  static var current: Engine { Engine(rawValue: UserDefaults.standard.string(forKey: "engine") ?? "") ?? .acp }
}

/// The settings, as the Settings window keeps them. The API key is in the Keychain.
enum Prefs {
  static var agent: String { UserDefaults.standard.string(forKey: "agent") ?? "claude-acp" }
  static var apiURL: String { (UserDefaults.standard.string(forKey: "apiURL") ?? "").trimmingCharacters(in: .whitespaces) }
  static var apiModel: String { (UserDefaults.standard.string(forKey: "apiModel") ?? "").trimmingCharacters(in: .whitespaces) }
  /// The apps the writer turned live underlines on for, by bundle id.
  static var liveApps: Set<String> { Set((UserDefaults.standard.string(forKey: "liveApps") ?? "").split(separator: ",").map(String.init)) }
}

enum Keychain {
  private static let item: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "Quire Companion",
    kSecAttrAccount as String: "api-key",
  ]

  static func read() -> String {
    var out: CFTypeRef?
    let query = item.merging([kSecReturnData as String: true]) { $1 }
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return "" }
    return String(decoding: data, as: UTF8.self)
  }

  static func write(_ key: String) {
    SecItemDelete(item as CFDictionary)
    if !key.isEmpty { SecItemAdd(item.merging([kSecValueData as String: Data(key.utf8)]) { $1 } as CFDictionary, nil) }
  }
}

/// A fix the model suggests: `original` is copied from the text, `suggestion` replaces it.
struct Fix: Identifiable {
  static let categories = ["Spelling", "Grammar", "Punctuation", "Word choice"]

  let id = UUID()
  let original: String
  let suggestion: String
  let category: String
  let reason: String  // one sentence for the writer

  /// The words that change, and the unchanged words around them: in "has less projects" ->
  /// "has fewer projects", the change is "less" -> "fewer". A comma only added is shown with
  /// the word before it: "However" -> "However,".
  var change: (before: String, old: String, new: String, after: String) {
    let (a, b) = (tokens(original), tokens(suggestion))
    var p = 0
    while p < a.count, p < b.count, a[p] == b[p] { p += 1 }
    var s = 0
    while s < a.count - p, s < b.count - p, a[a.count - 1 - s] == b[b.count - 1 - s] { s += 1 }
    if p + s == a.count, p > 0 { p -= 1 }  // nothing removed: take in the token before
    func join(_ t: ArraySlice<String>) -> String { t.joined() }
    return (join(a[..<p]), join(a[p..<(a.count - s)]), join(b[p..<(b.count - s)]), join(a[(a.count - s)...]))
  }

  /// The fixes in a model's reply, a JSON array, that are found in `text` and change it. Nil
  /// when the reply holds no such array.
  static func parse(_ reply: String, in text: String) -> [Fix]? {
    let r = clean(reply)
    guard let a = r.firstIndex(of: "["), let b = r.lastIndex(of: "]"), a < b,
      let list = try? JSONSerialization.jsonObject(with: Data(r[a...b].utf8)) as? [[String: Any]]
    else { return nil }
    return list.compactMap { item in
      guard let o = item["original"] as? String, let s = item["suggestion"] as? String,
        !o.isEmpty, o != s, text.contains(o)
      else { return nil }
      let category = item["category"] as? String ?? ""
      return Fix(original: o, suggestion: s, category: categories.contains(category) ? category : "Grammar", reason: item["reason"] as? String ?? "")
    }
  }
}

/// Words, runs of space, and single other characters.
private func tokens(_ s: String) -> [String] {
  s.matches(of: try! Regex(#"[\p{L}\p{N}']+|\s+|[^\p{L}\p{N}'\s]"#)).map { String(s[$0.range]) }
}

/// A model that thinks aloud puts its answer after the thoughts; some put it in a code fence.
func clean(_ reply: String) -> String {
  var s = (reply.components(separatedBy: "</think>").last ?? reply).trimmingCharacters(in: .whitespacesAndNewlines)
  if s.hasPrefix("```"), s.hasSuffix("```"), s.count > 6, let nl = s.firstIndex(of: "\n") {
    s = String(s[s.index(after: nl)..<s.index(s.endIndex, offsetBy: -3)]).trimmingCharacters(in: .newlines)
  }
  return s
}

enum Ask {
  /// Quire's rewrite menu, and what each button asks.
  static let styles: [(name: String, instruction: String)] = [
    ("Formal", "Paraphrase it in a formal tone."),
    ("Scientific", "Paraphrase it in a precise, scientific style, as in a research paper."),
    ("Friendly", "Paraphrase it in a friendly, conversational tone."),
    ("Standard", "Paraphrase it in plain, clear language."),
  ]
  static let keep = " Keep its meaning and its language."

  static func check(_ text: String) async throws -> [Fix] {
    let prompt = """
      You proofread text the writer selected in another app: an email, a message or a document. \
      Find spelling, grammar and punctuation mistakes, and wrong words.
      Leave style, meaning and correct text alone.

      Reply with ONLY a JSON array, no other text: [{"original": "...", "suggestion": "...", "category": "...", "reason": "..."}]
      "original" is copied exactly from the text: the mistake and a few words around it, so it is found. \
      "suggestion" is the same words, corrected. "category" is one of \(Fix.categories.joined(separator: ", ")). \
      "reason" is one short sentence that tells the writer what is wrong, for example: \
      "The quantifier less does not fit the countable noun projects." Reply [] when nothing needs fixing.

      Text:
      \(text)
      """
    let reply: String
    switch Engine.current {
    case .acp: reply = try await Agent.shared.ask(prompt, kind: "check", agent: Prefs.agent)
    case .apple: reply = try await AppleModel.fixes(prompt)
    case .api: reply = try await API.ask(prompt)
    }
    guard let fixes = Fix.parse(reply, in: text) else { throw Failure("The model did not answer with a list of fixes.") }
    return fixes
  }

  /// The new text, with the selection's own spaces and line breaks around it: a selected line
  /// ends with its line break, which a model drops.
  static func rewrite(_ text: String, _ instruction: String) async throws -> String {
    let prompt = """
      You are editing text the writer selected in another app. Rewrite the SELECTED text following the instruction.
      Reply with ONLY the replacement text. No explanation, no quotes, no code fences. Do not use any tools.

      Instruction: \(instruction)

      SELECTED:
      \(text)
      """
    let reply: String
    switch Engine.current {
    case .acp: reply = try await Agent.shared.ask(prompt, kind: "rewrite", agent: Prefs.agent)
    case .apple: reply = try await AppleModel.ask(prompt)
    case .api: reply = try await API.ask(prompt)
    }
    let new = clean(reply)
    guard !new.isEmpty else { throw Failure("The model gave no text.") }
    let lead = String(text.prefix { $0.isWhitespace }), trail = String(text.reversed().prefix { $0.isWhitespace }.reversed())
    return lead + new + trail
  }
}

@Generable
struct AppleFix {
  @Guide(description: "The mistake and a few words around it, copied exactly from the text")
  var original: String
  @Guide(description: "The same words with only the mistake corrected")
  var suggestion: String
  @Guide(description: "What kind of mistake it is", .anyOf(Fix.categories))
  var category: String
  @Guide(description: "One short sentence that tells the writer what is wrong")
  var reason: String
}

@Generable
struct AppleFixes {
  @Guide(description: "Only real mistakes; empty when nothing needs fixing")
  var fixes: [AppleFix]
}

/// Apple's on-device model (macOS 26 with Apple Intelligence), as Quire's bridge asks it.
enum AppleModel {
  /// Why it cannot answer on this Mac, or nil.
  static var problem: String? {
    switch SystemLanguageModel.default.availability {
    case .available: nil
    case .unavailable(.deviceNotEligible): "Apple's model needs a Mac with Apple silicon."
    case .unavailable(.appleIntelligenceNotEnabled): "Turn on Apple Intelligence in System Settings to use Apple's model."
    case .unavailable(.modelNotReady): "Apple's model is still downloading. Try again later."
    case .unavailable(let other): "Apple's model cannot answer on this Mac (\(other))."
    }
  }

  /// Made to answer with a well-formed list: on its own it often does not.
  static func fixes(_ prompt: String) async throws -> String {
    let reply = try await answer { try await LanguageModelSession().respond(to: prompt, generating: AppleFixes.self).content }
    let list = reply.fixes.map { ["original": $0.original, "suggestion": $0.suggestion, "category": $0.category, "reason": $0.reason] }
    return String(decoding: try JSONSerialization.data(withJSONObject: list), as: UTF8.self)
  }

  static func ask(_ prompt: String) async throws -> String {
    try await answer { try await LanguageModelSession().respond(to: prompt).content }
  }

  private static func answer<T>(_ ask: () async throws -> T) async throws -> T {
    if let problem { throw Failure(problem) }
    do {
      return try await ask()
    } catch LanguageModelSession.GenerationError.exceededContextWindowSize {
      throw Failure("The text is too long for Apple's model: it reads about 3,000 words at a time.")
    } catch LanguageModelSession.GenerationError.guardrailViolation {
      throw Failure("Apple's model declined to answer about this text.")
    } catch LanguageModelSession.GenerationError.unsupportedLanguageOrLocale {
      throw Failure("Apple's model does not support this language.")
    }
  }
}

/// An API that talks like OpenAI's: one request, one answer, no tools.
enum API {
  static func ask(_ prompt: String) async throws -> String {
    guard let base = URL(string: Prefs.apiURL), ["http", "https"].contains(base.scheme ?? "") else {
      throw Failure("Fill in the API address in Settings. It starts with http:// or https://.")
    }
    guard !Prefs.apiModel.isEmpty else { throw Failure("Fill in the model in Settings.") }
    var request = URLRequest(url: base.appending(path: "chat/completions"), timeoutInterval: 60)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let key = Keychain.read()
    if !key.isEmpty { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
    // The limit leaves room for a model that thinks first. No temperature: newer models refuse one.
    let body: [String: Any] = ["model": Prefs.apiModel, "messages": [["role": "user", "content": prompt]], "max_completion_tokens": 4096]
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let data: Data
    do {
      (data, _) = try await URLSession.shared.data(for: request)
    } catch {
      throw Failure("Could not reach \(base.absoluteString) (\(error.localizedDescription)).")
    }
    guard let answer = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw Failure("\(base.absoluteString) did not answer like an OpenAI-compatible API.")
    }
    if let e = (answer["error"] as? [String: Any])?["message"] as? String ?? answer["error"] as? String { throw Failure(e) }
    let message = (answer["choices"] as? [[String: Any]])?.first?["message"] as? [String: Any]
    return message?["content"] as? String ?? ""
  }
}
