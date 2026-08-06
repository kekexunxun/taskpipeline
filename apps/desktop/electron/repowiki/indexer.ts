import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

const CANDIDATE_DIRS = ["repowiki", ".repowiki", ".qoder/repowiki", "docs/repowiki"];
// 仓库根 Agent 指引文件（AGENTS.md 优先，二者同时存在时只索引一个，避免内容重复）。
const ROOT_AGENTS_CANDIDATES = ["AGENTS.md", "agents.md"];
const SUPPORTED_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const MAX_FILE_BYTES = 512 * 1024;

export type WikiFile = { path: string; title: string; content: string; mtime: string; hash: string };

export function sha1(content: string): string {
  return createHash("sha1").update(content, "utf8").digest("hex");
}

function firstHeading(content: string): string | undefined {
  const line = content.split(/\r?\n/).find((item) => /^#{1,3}\s+\S/.test(item.trim()));
  return line?.trim().replace(/^#+\s*/, "").trim();
}

function walk(root: string, dir: string, out: WikiFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      walk(root, full, out);
      continue;
    }
    if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const stat = statSync(full);
    if (stat.size > MAX_FILE_BYTES) continue;
    const content = readFileSync(full, "utf8");
    if (!content.trim()) continue;
    out.push({
      path: relative(root, full).replace(/\\/g, "/"),
      title: firstHeading(content) ?? basename(entry.name, extname(entry.name)),
      content,
      mtime: stat.mtime.toISOString(),
      hash: sha1(content)
    });
  }
}

export function collectRepoWikiDocs(localPath: string): WikiFile[] {
  const out: WikiFile[] = [];
  for (const candidate of CANDIDATE_DIRS) {
    const dir = join(localPath, candidate);
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, dir, out);
  }
  // 仓库根 AGENTS.md：单文件索引，同样受大小限制；标题优先取首个标题。
  // 用 readdirSync 精确匹配文件名，避免 macOS 大小写不敏感误命中 agents.md。
  const rootEntries = new Set(readdirSync(localPath));
  for (const name of ROOT_AGENTS_CANDIDATES) {
    if (!rootEntries.has(name)) continue;
    const full = join(localPath, name);
    const stat = statSync(full);
    if (stat.size > MAX_FILE_BYTES) continue;
    const content = readFileSync(full, "utf8");
    if (!content.trim()) continue;
    out.push({
      path: name,
      title: firstHeading(content) ?? "AGENTS.md",
      content,
      mtime: stat.mtime.toISOString(),
      hash: sha1(content)
    });
    break;
  }
  return out;
}
