#!/usr/bin/env node
/**
 * Release script — bump version, tag, and push to trigger CI release.
 *
 * Usage:
 *   npm run release          # patch bump (default)
 *   npm run release -- minor # minor bump
 *   npm run release -- major # major bump
 */

import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const bump = process.argv[2] || 'patch'
const root = path.resolve(fileURLToPath(import.meta.url), '..', '..')

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' })

// simple semver bump (no dependencies needed)
function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number)
  if (type === 'major') return `${major + 1}.0.0`
  if (type === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

// 1. collect all package.json paths that need version bumping
const pkgFiles = [
  'package.json',
  'apps/desktop/package.json',
  'packages/core/package.json',
  'packages/integrations/package.json',
  'packages/pi-package/package.json'
]

// read root current version, compute new version
const rootPkgPath = path.join(root, 'package.json')
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'))
const newVersion = bumpVersion(rootPkg.version, bump)

// write new version to all package.json files
for (const rel of pkgFiles) {
  const filePath = path.join(root, rel)
  const pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  pkg.version = newVersion
  fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log(`  ${rel}: ${rootPkg.version} → ${newVersion}`)
}

// 2. create commit + tag
const tag = `v${newVersion}`
run(`git add ${pkgFiles.join(' ')}`)
run(`git commit -m "release: ${tag}"`)
run(`git tag -a ${tag} -m "${tag}"`)

// 3. push commit + tag
run('git push origin HEAD --follow-tags')
console.log(`\n✓ Pushed ${tag} — CI release workflow triggered.`)
