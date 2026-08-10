// 图标归一化：检测"铺满画布"的成品图标（alpha 包围盒 ≥ 99%），按 macOS Big Sur 标准网格
// （1024 画布 / 824 图形）等比缩小并居中到透明画布；已有留白的图标原样拷贝。
// 用法: swift normalize-icon.swift <src.png> <dst.png>
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write("usage: normalize-icon.swift <src> <dst>\n".data(using: .utf8)!)
    exit(2)
}
let src = args[1]
let dst = args[2]

guard let srcImage = NSImage(contentsOfFile: src),
      let cg = srcImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("[normalize-icon] 无法读取: \(src)\n".data(using: .utf8)!)
    exit(1)
}

let w = cg.width
let h = cg.height
let colorSpace = CGColorSpaceCreateDeviceRGB()
var pixels = [UInt8](repeating: 0, count: w * h * 4)
guard let ctx = CGContext(
    data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
    space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { exit(1) }
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))

// 计算 alpha 包围盒
var minX = w, minY = h, maxX = -1, maxY = -1
for y in 0..<h {
    for x in 0..<w where pixels[(y * w + x) * 4 + 3] > 8 {
        if x < minX { minX = x }
        if x > maxX { maxX = x }
        if y < minY { minY = y }
        if y > maxY { maxY = y }
    }
}

let bboxW = maxX - minX + 1
let bboxH = maxY - minY + 1
let fullBleed = maxX >= 0 && Double(bboxW) >= Double(w) * 0.99 && Double(bboxH) >= Double(h) * 0.99

guard let outCtx = CGContext(
    data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
    space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { exit(1) }

if fullBleed {
    // macOS 标准网格：图形占画布的 824/1024，居中放置
    let s = Int(Double(w) * 824.0 / 1024.0)
    let rect = CGRect(x: (w - s) / 2, y: (h - s) / 2, width: s, height: s)
    outCtx.draw(cg, in: rect)
    print("[normalize-icon] 检测到铺满画布图标，已按 824/1024 网格居中归一化")
} else {
    outCtx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    print("[normalize-icon] 图标已有留白，原样输出")
}

guard let outCG = outCtx.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: outCG)
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
do {
    try png.write(to: URL(fileURLWithPath: dst))
} catch {
    FileHandle.standardError.write("[normalize-icon] 写入失败: \(error)\n".data(using: .utf8)!)
    exit(1)
}
