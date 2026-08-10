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
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const bump = process.argv[2] || 'patch'
const root = path.resolve(fileURLToPath(import.meta.url), '..', '..')

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' })

// 1. collect all package.json paths that need version bumping
const workspaceDirs = ['apps/desktop', 'packages/core', 'packages/integrations', 'packages/pi-package']
const pkgPaths = ['package.json', ...workspaceDirs.map((d) => path.join(d, 'package.json'))]

// bump all packages (no git tag, we create it manually below)
for (const p of pkgPaths) {
  const dir = path.dirname(p) === '.' ? root : path.join(root, path.dirname(p))
  execSync(`npm version ${bump} --no-git-tag-version`, { cwd: dir, stdio: 'inherit' })
}

// 2. create commit + tag with the new version
const rootPkg = require(path.join(root, 'package.json'))
const tag = `v${rootPkg.version}`
run(`git add ${pkgPaths.join(' ')}`)
run(`git commit -m "release: ${tag}"`)
run(`git tag -a ${tag} -m "${tag}"`)

// 3. push commit + tag
run('git push origin HEAD --follow-tags')
console.log(`\n✓ Pushed ${tag} — CI release workflow triggered.`)
