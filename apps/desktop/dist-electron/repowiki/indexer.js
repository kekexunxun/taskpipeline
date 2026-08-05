import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
const CANDIDATE_DIRS = ["repowiki", ".repowiki", ".qoder/repowiki", "docs/repowiki"];
const SUPPORTED_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const MAX_FILE_BYTES = 512 * 1024;
export function sha1(content) {
    return createHash("sha1").update(content, "utf8").digest("hex");
}
function firstHeading(content) {
    const line = content.split(/\r?\n/).find((item) => /^#{1,3}\s+\S/.test(item.trim()));
    return line?.trim().replace(/^#+\s*/, "").trim();
}
function walk(root, dir, out) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === ".git" || entry.name === "node_modules")
                continue;
            walk(root, full, out);
            continue;
        }
        if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase()))
            continue;
        const stat = statSync(full);
        if (stat.size > MAX_FILE_BYTES)
            continue;
        const content = readFileSync(full, "utf8");
        if (!content.trim())
            continue;
        out.push({
            path: relative(root, full).replace(/\\/g, "/"),
            title: firstHeading(content) ?? basename(entry.name, extname(entry.name)),
            content,
            mtime: stat.mtime.toISOString(),
            hash: sha1(content)
        });
    }
}
export function collectRepoWikiDocs(localPath) {
    const out = [];
    for (const candidate of CANDIDATE_DIRS) {
        const dir = join(localPath, candidate);
        if (existsSync(dir) && statSync(dir).isDirectory())
            walk(dir, dir, out);
    }
    return out;
}
//# sourceMappingURL=indexer.js.map