#!/usr/bin/env node
// Build the two bundles and pack them into release/ as the exact tarballs to
// publish: `npm publish release/<name>-<version>.tgz` for npm, and the same
// files attached to the GitHub Release `v<version>` for URL installs. Checks
// that both packages share one version, that dsh-sieve-web peers on that
// dsh-sieve version, and that no tarball carries workspace: specifiers or
// repository paths. Publishes nothing and calls no model.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'release')
const repo = 'Sev7eEn7/sieve'
const packages = ['dsh-sieve', 'dsh-sieve-web'].map(dir => {
  const path = join(root, 'packages', dir)
  return { path, manifest: JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) }
})

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
}

function check(condition, message) {
  if (!condition) throw new Error(`release pack: ${message}`)
  console.log(`ok - ${message}`)
}

const [sieve, web] = packages
const version = sieve.manifest.version
check(web.manifest.version === version, `both packages are version ${version}`)
check(web.manifest.peerDependencies['dsh-sieve'] === version, `dsh-sieve-web peers on dsh-sieve ${version}`)

run('pnpm', ['build'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const sums = []
for (const { path, manifest } of packages) {
  const tgz = join(out, `${manifest.name}-${manifest.version}.tgz`)
  run('pnpm', ['pack', '--pack-destination', out], { cwd: path })
  const packed = JSON.parse(run('tar', ['-xzOf', tgz, 'package/package.json']))
  const contents = run('tar', ['-xzOf', tgz])
  check(packed.version === version, `${manifest.name}: packed manifest is ${version}`)
  check(!contents.includes('workspace:'), `${manifest.name}: no workspace: specifiers`)
  check(!contents.includes(root), `${manifest.name}: no repository absolute paths`)
  sums.push(`${createHash('sha256').update(readFileSync(tgz)).digest('hex')}  ${basename(tgz)}`)
}
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)

const files = packages.map(({ manifest }) => `release/${manifest.name}-${version}.tgz`)
console.log(`
${sums.join('\n')}

npm:
${files.map(file => `  npm publish ${file}`).join('\n')}

GitHub Release v${version}:
  gh release create v${version} ${files.join(' ')} release/SHA256SUMS --repo ${repo}
`)
