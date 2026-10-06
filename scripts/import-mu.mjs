#!/usr/bin/env node
// Reads only an explicitly named configuration; never installs or modifies a profile.
import { readFile, writeFile } from 'node:fs/promises'
import { importMuConfig, renderImportPatch } from '../packages/dsh-sieve/src/migration/import-config.ts'

const [source, flag, destination, ...extra] = process.argv.slice(2)
if (!source || (flag && flag !== '--out') || (flag && !destination) || extra.length) {
  console.error('用法：pnpm import:mu <mu.json 或 kyrn.json> [--out <新 patch 文件>]')
  process.exitCode = 1
} else {
  try {
    const result = importMuConfig(JSON.parse(await readFile(source, 'utf8')))
    const patch = renderImportPatch(result)
    if (destination) await writeFile(destination, patch, { flag: 'wx', mode: 0o600 })
    else process.stdout.write(patch)
    for (const diagnostic of result.diagnostics) console.error(diagnostic)
  } catch {
    // Do not echo JSON parse failures: they can contain secret values.
    console.error('导入失败：检查输入 JSON、目标路径及文件是否已存在。')
    process.exitCode = 1
  }
}
