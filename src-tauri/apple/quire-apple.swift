// Quire's bridge to Apple's on-device model (FoundationModels: macOS 26 with Apple
// Intelligence). The prompt comes on stdin and the answer goes to stdout. A problem goes to
// stderr, in words for the writer, with exit code 1. `--check` only says whether the model
// can answer on this Mac. `--fixes` makes the answer a JSON list of fixes, which the model
// cannot get wrong (guided generation). build-app.sh builds it; the app carries it next to
// its own program.
import Foundation
import FoundationModels

@Generable
struct Fix {
  @Guide(description: "The mistake and a few words around it, copied exactly from the text")
  var original: String
  @Guide(description: "The same words with only the mistake corrected")
  var suggestion: String
  @Guide(description: "Two to five words on what was wrong")
  var reason: String
}

@Generable
struct Fixes {
  @Guide(description: "Only real mistakes; empty when nothing needs fixing")
  var fixes: [Fix]
}

func fail(_ why: String) -> Never {
  FileHandle.standardError.write(Data(why.utf8))
  exit(1)
}

switch SystemLanguageModel.default.availability {
case .available: break
case .unavailable(.deviceNotEligible): fail("Apple's model needs a Mac with Apple silicon.")
case .unavailable(.appleIntelligenceNotEnabled): fail("Turn on Apple Intelligence in System Settings to use Apple's model.")
case .unavailable(.modelNotReady): fail("Apple's model is still downloading. Try again later.")
case .unavailable(let other): fail("Apple's model cannot answer on this Mac (\(other)).")
}
let args = CommandLine.arguments
if args.contains("--check") { exit(0) }

// --max-tokens N: the longest answer.
let tokens = args.firstIndex(of: "--max-tokens").flatMap { $0 + 1 < args.count ? Int(args[$0 + 1]) : nil }
let prompt = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
let options = GenerationOptions(maximumResponseTokens: tokens)
do {
  if args.contains("--fixes") {
    let reply = try await LanguageModelSession().respond(to: prompt, generating: Fixes.self, options: options)
    let fixes = reply.content.fixes.map { ["original": $0.original, "suggestion": $0.suggestion, "reason": $0.reason] }
    print(String(decoding: try JSONSerialization.data(withJSONObject: fixes), as: UTF8.self), terminator: "")
  } else {
    print(try await LanguageModelSession().respond(to: prompt, options: options).content, terminator: "")
  }
} catch LanguageModelSession.GenerationError.exceededContextWindowSize {
  fail("The text is too long for Apple's model: it reads about 3,000 words at a time.")
} catch LanguageModelSession.GenerationError.guardrailViolation {
  fail("Apple's model declined to answer about this text.")
} catch LanguageModelSession.GenerationError.unsupportedLanguageOrLocale {
  fail("Apple's model does not support this language.")
} catch {
  fail("Apple's model failed: \(error.localizedDescription)")
}
