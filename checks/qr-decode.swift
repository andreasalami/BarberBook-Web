// Decodes the QR matrices written by checks.mjs with macOS's own reader (Core Image) and compares the text.
//   TZ=Europe/Rome node checks/checks.mjs /tmp/qr.txt && xcrun swift checks/qr-decode.swift /tmp/qr.txt
import CoreImage
import Foundation

let blocks = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8).components(separatedBy: "\n\n")
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
var failed = false
for block in blocks {
    let lines = block.components(separatedBy: "\n")
    let expected = lines[0], rows = Array(lines.dropFirst())
    let scale = 8, border = 4, size = (rows.count + border * 2) * scale
    var pixels = [UInt8](repeating: 255, count: size * size)
    for (y, row) in rows.enumerated() {
        for (x, c) in row.enumerated() where c == "1" {
            for dy in 0..<scale { for dx in 0..<scale { pixels[((y + border) * scale + dy) * size + (x + border) * scale + dx] = 0 } }
        }
    }
    let provider = CGDataProvider(data: Data(pixels) as CFData)!
    let image = CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: size,
                        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: [], provider: provider, decode: nil,
                        shouldInterpolate: false, intent: .defaultIntent)!
    let found = detector.features(in: CIImage(cgImage: image)).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
    let ok = found == [expected]
    failed = failed || !ok
    print(ok ? "PASS" : "FAIL", rows.count, "modules:", expected.prefix(60), ok ? "" : "→ \(found)")
}
exit(failed ? 1 : 0)
