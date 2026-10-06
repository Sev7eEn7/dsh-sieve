#!/usr/bin/env node
// Builds dsh-sieve-web's browser half, lib/client.js, in the artifact shape DSH
// Client Modules load (pinned DSH 5badb15, packages/client/tsdown.client.ts):
// one CommonJS factory handed to window.__ModuleLoader__.load, whose injected
// require answers only the shell's platform modules. Everything else is
// inlined; a value import of any other @deepseek-ai package, or of a Node
// module, fails the build instead of failing in the browser.
//
// Usage: node scripts/build-client.mjs [--out <dir>]

import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(root, 'packages', 'dsh-sieve-web')

/** The module-table keys the DSH 0.2.1-alpha.1 shell seeds (packages/client/web/src/platform.ts). */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * Build the browser bundle.
 * @param {{ outDir?: string }} options - where client.js and client.js.map go; defaults to the package's lib/.
 * @returns {Promise<{ file: string, requires: string[] }>} the bundle path and the modules it requires.
 */
export async function buildClient({ outDir = join(pkgDir, 'lib') } = {}) {
  const id = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name
  const platform = new Set(PLATFORM_MODULES)
  const bundle = await rolldown({
    input: join(pkgDir, 'src', 'client', 'index.ts'),
    platform: 'browser',
    tsconfig: join(pkgDir, 'tsconfig.client.json'),
    external: source => platform.has(source),
    transform: {
      jsx: 'react-jsx',
      define: { 'process.env.NODE_ENV': '"production"' },
    },
    plugins: [{
      name: 'sieve-client-purity',
      resolveId(source) {
        if (platform.has(source)) return null
        if (source.startsWith('node:') || isBuiltin(source)) {
          throw new Error(`client bundle: "${source}" is a Node module; the browser half must not import it`)
        }
        if (source.startsWith('@deepseek-ai/') || source === 'dsh-sieve' || source.startsWith('dsh-sieve/')) {
          throw new Error(`client bundle: "${source}" is not a platform module; import it as a type or reach it through a Cordis service`)
        }
        return null
      },
    }],
  })
  try {
    const { output } = await bundle.write({
      dir: outDir,
      format: 'cjs',
      entryFileNames: 'client.js',
      sourcemap: true,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    })
    const chunks = output.filter(item => item.type === 'chunk')
    if (chunks.length !== 1) throw new Error(`client bundle: expected one chunk, got ${chunks.map(chunk => chunk.fileName).join(', ')}`)
    const chunk = chunks[0]
    const requires = [...chunk.code.matchAll(/\brequire\("([^"]+)"\)/g)].map(match => match[1])
    const stray = requires.filter(specifier => !platform.has(specifier))
    if (stray.length > 0) throw new Error(`client bundle: requires outside the platform table: ${stray.join(', ')}`)
    return { file: join(outDir, chunk.fileName), requires: [...new Set(requires)].sort() }
  } finally {
    await bundle.close()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flag = process.argv.indexOf('--out')
  const outDir = flag === -1 ? undefined : process.argv[flag + 1]
  const { file, requires } = await buildClient(outDir === undefined ? {} : { outDir: resolve(outDir) })
  console.log(`built ${file} (requires ${requires.join(', ')})`)
}
