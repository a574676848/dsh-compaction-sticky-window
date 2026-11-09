/**
 * Guard the preset snapshot against a DSH upgrade.
 *
 * The preset restates the shipped `standard` preset, and a row whose plugin the
 * installation no longer exports never starts: every new session then fails with
 * `agent-preset/invalid: <row> (<name>): never started`. DSH 0.2.2 folded
 * `@deepseek-ai/dsh-tool-subagent-control/list-agents` into its parent package
 * that way. Regenerating is the fix; these tests fail first when an upgrade
 * lands and the snapshot is left behind.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/** The committed snapshot, whose rows must all exist in the installation. */
const PRESET = fileURLToPath(new URL('../presets/sticky-window.patch.yml', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../scripts/sync-preset.mjs', import.meta.url))

/** Module resolution for a preset row, from the package that declares it. */
const require = createRequire(new URL('../index.js', import.meta.url))

/** This package's own name: the preset's compaction row loads it by name. */
const OWN_NAME = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name

/**
 * Plugin names the snapshot declares, in file order.
 * @returns {string[]} every `name:` value, Loader builtins included.
 */
function presetNames() {
  const text = fs.readFileSync(PRESET, 'utf8')
  return [...text.matchAll(/^\s*name:\s*'?([^'\n]+)'?\s*$/gmu)].map(match => match[1].trim())
}

test('the snapshot is the installed standard preset with the compaction group swapped', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})

test('every plugin a preset row names resolves in the installation', () => {
  const missing = presetNames().filter(name => {
    if (name.startsWith('cordis:') || name === OWN_NAME) return false
    try {
      require.resolve(name)
      return false
    } catch {
      return true
    }
  })
  assert.deepEqual(missing, [], `unresolvable preset rows: ${missing.join(', ')} — run npm run sync-preset`)
})
