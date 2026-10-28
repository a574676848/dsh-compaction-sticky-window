#!/usr/bin/env node
/**
 * Regenerate the sticky-window agent preset from a DSH installation.
 *
 * On Web and Desktop profiles each agent preset mounts its own compaction
 * backend inside an isolated group, so this bundle has to ship a preset of its
 * own. Copying the shipped `standard` preset by hand would drift silently on
 * every DSH release; this script re-derives the copy from the installed preset
 * and rewrites only the compaction group.
 *
 * Usage:
 *   node scripts/sync-preset.mjs [--from <standard.patch.yml>] [--out <file>]
 *
 * With no arguments it reads `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
 * resolved from the current Node installation, and writes
 * `presets/sticky-window.patch.yml` beside this package.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** Preset id and row id this bundle publishes. */
const PRESET_ID = 'sticky-window'
const ROW_ID = 'preset-sticky-window'
/** The compaction row this bundle replaces inside the preset. */
const REPLACED_ROW = '- id: compaction-basic'

/** Header applied to the generated file. */
const HEADER = [
  '# Sticky-window agent preset — GENERATED, do not edit by hand.',
  '#',
  '# This is the shipped `standard` preset with its isolated compaction group',
  '# pointed at the sticky-window backend instead of the summarizing one, so a',
  '# preset-backed profile can retire the old mechanism at all: a profile-level',
  '# row cannot reach a session whose preset isolates `compaction`.',
  '#',
  '# Regenerate after a DSH upgrade:  node scripts/sync-preset.mjs',
  '',
]

/**
 * Read an option's value from argv.
 * @param {string[]} argv - process arguments after the script name.
 * @param {string} flag - option name including its leading dashes.
 * @returns {string | undefined} the following argument, when present.
 */
function option(argv, flag) {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

/**
 * Resolve the shipped preset from the active installation.
 * @returns {string} absolute path to `standard.patch.yml`.
 */
function defaultSource() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const require = process.getBuiltinModule('node:module').createRequire(path.join(here, 'index.js'))
  const manifest = require.resolve('@deepseek-ai/dsh-web-app/package.json')
  return path.join(path.dirname(manifest), 'presets', 'standard.patch.yml')
}

/**
 * Indentation width of a line.
 * @param {string} line - one line of YAML.
 * @returns {number} leading spaces.
 */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * Rewrite one shipped preset into this bundle's preset.
 * @param {string} source - the shipped `standard` patch text.
 * @returns {string} the generated patch text.
 * @throws {Error} when the expected compaction row is absent.
 */
function rewrite(source) {
  const lines = source.split('\n')
  /** @type {string[]} */
  const out = []
  let replaced = false
  let presetRow = false
  let presetId = false
  let skipNext = false

  for (const line of lines) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (line.trimStart().startsWith('- id: preset-standard')) {
      presetRow = true
      out.push(line.replace('preset-standard', ROW_ID))
      continue
    }
    if (presetRow && /^\s+id: standard$/u.test(line)) {
      presetId = true
      out.push(line.replace('id: standard', `id: ${PRESET_ID}`))
      continue
    }
    if (presetRow && presetId && /^\s+order: \d+$/u.test(line)) {
      out.push(line.replace(/order: \d+/u, 'order: 0'))
      continue
    }
    if (line.trimStart().startsWith(REPLACED_ROW)) {
      const indent = ' '.repeat(indentOf(line))
      const child = ' '.repeat(indentOf(line) + 2)
      out.push(
        `${indent}- id: compaction-sticky-window`,
        `${child}name: 'dsh-compaction-sticky-window'`,
        `${child}config:`,
        `${child}  thresholdRatio: 0.8`,
        `${child}  retainRatio: 0.35`,
        `${child}  noteMaxBytes: 6144`,
        // This row only supplies the compaction service. The tools and the
        // prompt protocol are registered once, on the host plane, and the
        // preset realm inherits the `tools` and `systemPrompt` registries
        // because only `compaction` and `toolResultPruner` are isolated.
        // Registering them here too would collide on the same tool names.
        `${child}  noteTool: false`,
        `${child}  sensingTool: false`,
        `${child}  historyTool: false`,
        `${child}  guidance: false`,
      )
      replaced = true
      skipNext = true
      continue
    }
    out.push(line)
  }

  if (!presetRow) throw new Error('source preset row "- id: preset-standard" not found')
  if (!replaced) throw new Error(`source row "${REPLACED_ROW}" not found; the preset layout changed`)
  return `${HEADER.join('\n')}${out.join('\n')}`
}

const argv = process.argv.slice(2)
const from = option(argv, '--from') ?? defaultSource()
const out = option(argv, '--out')
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'sticky-window.patch.yml')

const source = fs.readFileSync(from, 'utf8')
const generated = rewrite(source)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `${generated.trimEnd()}\n`, 'utf8')
process.stdout.write(`wrote ${out} from ${from}\n`)
