import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectRepoWikiDocs } from "./indexer";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repowiki-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("collectRepoWikiDocs", () => {
  it("indexes the repository root AGENTS.md", () => {
    writeFileSync(join(root, "AGENTS.md"), "# Agent Instructions\n\n请优先使用公司规范。\n", "utf8");
    const docs = collectRepoWikiDocs(root);
    expect(docs.map((doc) => doc.path)).toContain("AGENTS.md");
    const agents = docs.find((doc) => doc.path === "AGENTS.md");
    expect(agents?.title).toBe("Agent Instructions");
    expect(agents?.content).toContain("公司规范");
    expect(agents?.hash).toBeTruthy();
  });

  it("prefers AGENTS.md over agents.md when both exist", () => {
    writeFileSync(join(root, "AGENTS.md"), "# AGENTS\n", "utf8");
    writeFileSync(join(root, "agents.md"), "# agents\n", "utf8");
    const docs = collectRepoWikiDocs(root);
    expect(docs.filter((doc) => doc.path === "AGENTS.md" || doc.path === "agents.md")).toHaveLength(1);
    expect(docs.find((doc) => doc.path === "AGENTS.md")).toBeTruthy();
  });

  it("falls back to agents.md when AGENTS.md is absent", () => {
    writeFileSync(join(root, "agents.md"), "# Agents\n", "utf8");
    const docs = collectRepoWikiDocs(root);
    expect(docs.map((doc) => doc.path)).toContain("agents.md");
  });

  it("skips empty AGENTS.md and oversized files", () => {
    writeFileSync(join(root, "AGENTS.md"), "   \n", "utf8");
    writeFileSync(join(root, "agents.md"), "x".repeat(512 * 1024 + 1), "utf8");
    const docs = collectRepoWikiDocs(root);
    expect(docs.some((doc) => doc.path === "AGENTS.md" || doc.path === "agents.md")).toBe(false);
  });

  it("indexes root AGENTS.md alongside repowiki directory docs", () => {
    writeFileSync(join(root, "AGENTS.md"), "# Agent Instructions\n", "utf8");
    mkdirSync(join(root, "repowiki"), { recursive: true });
    writeFileSync(join(root, "repowiki", "architecture.md"), "# 架构\n", "utf8");
    const docs = collectRepoWikiDocs(root);
    // repowiki 目录内文档的 path 相对 repowiki 目录（存量行为）。
    expect(docs.map((doc) => doc.path)).toEqual(expect.arrayContaining(["AGENTS.md", "architecture.md"]));
  });

  it("returns repowiki docs only when no root agents file exists", () => {
    mkdirSync(join(root, "repowiki"), { recursive: true });
    writeFileSync(join(root, "repowiki", "guide.md"), "# Guide\n", "utf8");
    const docs = collectRepoWikiDocs(root);
    expect(docs.map((doc) => doc.path)).toEqual(["guide.md"]);
  });
});
