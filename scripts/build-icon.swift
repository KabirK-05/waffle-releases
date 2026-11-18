// Builds Waffle's macOS app icon from assets/source/icon-art.webp (square artwork, full bleed).
//
// The packaged app's icon is assets/Waffle.icon (Icon Composer format; electron-builder compiles
// it with actool), whose only layer is the artwork at 1024 px: this script writes that too.
// The files below are the dev dock icon and a fallback icns in the same shape.
//
// The artwork is cut to the macOS rounded square (a superellipse on Apple's icon grid: an
// 824 px shape centred on a 1024 px canvas) with a soft shadow beneath, so macOS shows it as is
// instead of putting it on a grey plate. Writes assets/icon.png (1024 px, the dev dock icon)
// and assets/icon.icns (every size, used by the packaged app).
//
//   swift scripts/build-icon.swift        (run from the project folder)

import AppKit
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("assets/source/icon-art.webp")
let canvas: CGFloat = 1024
let shape: CGFloat = 824

guard let art = NSImage(contentsOf: source), let artCG = art.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fatalError("Could not read \(source.path)")
}

/// Superellipse |x|^5 + |y|^5 = 1, close to Apple's continuous-corner icon shape.
func squircle(in rect: CGRect) -> CGPath {
  let path = CGMutablePath()
  let n = 5.0
  let steps = 1024
  for i in 0..<steps {
    let t = 2 * Double.pi * Double(i) / Double(steps)
    let c = cos(t), s = sin(t)
    let x = rect.midX + rect.width / 2 * CGFloat(copysign(pow(abs(c), 2 / n), c))
    let y = rect.midY + rect.height / 2 * CGFloat(copysign(pow(abs(s), 2 / n), s))
    if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
  }
  path.closeSubpath()
  return path
}

func render(size px: Int) -> CGImage {
  let scale = CGFloat(px) / canvas
  let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.interpolationQuality = .high
  ctx.scaleBy(x: scale, y: scale)
  let body = CGRect(x: (canvas - shape) / 2, y: (canvas - shape) / 2, width: shape, height: shape)
  let outline = squircle(in: body)

  // Soft shadow beneath (y is up in Core Graphics, so a negative offset moves it down).
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 28, color: NSColor(white: 0, alpha: 0.3).cgColor)
  ctx.addPath(outline)
  ctx.setFillColor(NSColor(red: 1, green: 0.84, blue: 0.0, alpha: 1).cgColor)
  ctx.fillPath()
  ctx.restoreGState()

  // The artwork, clipped to the shape.
  ctx.saveGState()
  ctx.addPath(outline)
  ctx.clip()
  ctx.draw(artCG, in: body)
  ctx.restoreGState()
  return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
  let rep = NSBitmapImageRep(cgImage: image)
  try! rep.representation(using: .png, properties: [:])!.write(to: url)
}

writePNG(render(size: 1024), to: root.appendingPathComponent("assets/icon.png"))

// The Icon Composer layer: the artwork itself, 1024 px square (macOS applies the shape).
let layer = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
layer.interpolationQuality = .high
layer.draw(artCG, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
writePNG(layer.makeImage()!, to: root.appendingPathComponent("assets/Waffle.icon/Assets/waffle.png"))

let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("waffle-\(UUID().uuidString).iconset")
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
  writePNG(render(size: size), to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
  writePNG(render(size: size * 2), to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", root.appendingPathComponent("assets/icon.icns").path]
try! iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: iconset)
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed") }
print("Wrote assets/icon.png and assets/icon.icns")
