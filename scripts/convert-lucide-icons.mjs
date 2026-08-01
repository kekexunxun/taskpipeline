// Convert lucide-react imports to use xxxIcon suffix naming.
// - For each .ts/.tsx file under apps/desktop/src
// - Find `import { ... } from "lucide-react"` and `import type { ... } from "lucide-react"`
// - For each named import (excluding types like LucideIcon/LucideProps and helpers like
//   createLucideIcon/icons), rename to the Icon-suffixed equivalent.
// - Update both the import line and JSX usages (<Foo ... />, </Foo>) of the renamed symbol.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

// Symbols exported by lucide-react that should not be suffixed
const KEEP_AS_IS = new Set([
  "LucideIcon",
  "LucideProps",
  "createLucideIcon",
  "icons",
  "SVGAttributes",
]);

// Words that, if appearing as a top-level tag in JSX, are NOT an icon we should rename.
// These should never be wrapped as <Foo> components; matching is purely defensive.
function isAlreadyIconSuffix(name) {
  return name.endsWith("Icon");
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-electron") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
}

const files = [];
walk(path.join(ROOT, "apps", "desktop", "src"), files);

let changedFiles = 0;
let renamedCount = 0;

for (const file of files) {
  const original = fs.readFileSync(file, "utf8");
  let content = original;

  // Match: import (type) { a, b as c, ... } from "lucide-react"
  const importRe = /import\s+(type\s+)?\{([^}]+)\}\s+from\s+["']lucide-react["'];?/g;
  const renames = new Map(); // oldName -> newName

  content = content.replace(importRe, (full, typeKw, inner) => {
    const items = inner
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const newItems = items.map((item) => {
      // `Foo as Bar` or just `Foo`
      const asMatch = item.match(/^(\S+)(?:\s+as\s+(\S+))?$/);
      if (!asMatch) return item;
      const originalName = asMatch[1];
      const alias = asMatch[2];

      if (KEEP_AS_IS.has(originalName)) return item;
      if (isAlreadyIconSuffix(originalName)) return item;
      if (alias) {
        // Already aliased; assume the alias already has the suffix or is intentionally named
        return item;
      }
      const newName = `${originalName}Icon`;
      renames.set(originalName, newName);
      return newName;
    });

    return `import${typeKw ?? ""} { ${newItems.join(", ")} } from "lucide-react";`;
  });

  if (renames.size === 0) continue;

  // Update JSX usages. Use a word-boundary regex so we don't accidentally rename parts
  // of longer identifiers (e.g. don't touch `FileDiffProp` or `myFileDiff`).
  for (const [oldName, newName] of renames) {
    const re = new RegExp(`\\b${oldName}\\b`, "g");
    content = content.replace(re, newName);
  }

  if (content !== original) {
    fs.writeFileSync(file, content, "utf8");
    changedFiles += 1;
    renamedCount += renames.size;
    console.log(`[updated] ${path.relative(ROOT, file)} (${renames.size} rename(s))`);
  }
}

console.log(`\nDone. ${changedFiles} file(s) updated, ${renamedCount} rename(s).`);
