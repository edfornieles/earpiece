import Vision
import AppKit
// prints the recognised text of each image path given, one line per image
for p in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: p), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("?"); continue }
  let req = VNRecognizeTextRequest(); req.recognitionLevel = .accurate; req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: cg).perform([req])
  print((req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " "))
}
