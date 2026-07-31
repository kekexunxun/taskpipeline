import { describe, expect, it } from "vitest";
import { resolveBundledOcrBinary, resolveOcrBinary } from "./ocr.js";

describe("ocr binary resolution", () => {
  it("resolves to the bundled @alibaba-group/open-code-review when installed", () => {
    const bundled = resolveBundledOcrBinary();
    if (!bundled) return; // 在没装包的机器上跳过具体路径断言
    expect(bundled).toMatch(/@alibaba-group[\\\/]open-code-review[\\\/]bin[\\\/]ocr\.js$/);
  });

  it("falls back to PATH lookup when the package is not installed", () => {
    const fallback = resolveOcrBinary();
    expect(typeof fallback).toBe("string");
    expect(fallback.length).toBeGreaterThan(0);
  });
});
