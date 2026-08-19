#!/usr/bin/env node
// Cross-platform bootstrap for @qoder-ai/qoder-agent-sdk postinstall.
//
// The SDK's postinstall.cjs guards main() with `require.main === module`,
// so we cannot simply `require()` it — main() would never execute and the
// bundled CLI binary would not be downloaded.
//
// Instead we spawn postinstall.cjs as a child process so it runs as the
// main module. execFileSync inherits stdio so download progress is visible.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const postinstallScript = path.resolve(
  __dirname,
  '..',
  'node_modules',
  '@qoder-ai',
  'qoder-agent-sdk',
  'scripts',
  'postinstall.cjs'
)

execFileSync(process.execPath, [postinstallScript], {
  env: { ...process.env, QODER_INSTALL_BUNDLED_CLI: '1' },
  stdio: 'inherit'
})
