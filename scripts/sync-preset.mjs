#!/usr/bin/env node
/**
 * Regenerate the patch that retires the summarizing backend on a preset plane.
 *
 * On Web and Desktop profiles each agent preset mounts its own compaction
 * backend inside a group that isolates `compaction`, so a profile-level row
 * cannot reach a session. The supported way to change that backend is to
 * override the preset declaration by its Loader row id, which replaces the
 * whole `config` — so this script re-derives the shipped `standard` preset from
 * the installation and rewrites only its compaction group.
 *
 * The preset keeps its id and its place, so a person's selected preset does not
 * change when this bundle is installed.
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

/** The shipped preset row this bundle overrides. */
const TARGET_ROW = '- id: preset-standard'
/** The compaction row this bundle replaces inside that preset. */
const REPLACED_ROW = '- id: compaction-basic'

/** Header applied to the generated file. */
const HEADER = [
  '# Standard agent preset, compaction group replaced — GENERATED, do not edit by hand.',
  '#',
  '# A preset isolates `compaction`, so a profile-level row cannot reach a session',
  '# that uses one. Overriding this preset by its Loader row id is the supported',
  '# way in: the whole `config` is replaced, so this file restates the shipped',
  '# `standard` preset and swaps only its compaction group.',
  '#',
  '# The preset keeps its id (`standard`) and its order, so installing this bundle',
  '# does not change which preset is selected. Every plugin id below is copied from',
  '# the installation; `sync-preset` refuses to write a file whose id set differs.',
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
 * Rewrite the shipped preset into an override of itself.
 *
 * The shipped file wraps its declaration in `- insert:`; an override is the same
 * declaration at the top level of a patch, so the wrapper goes away and every
 * line below it loses its two-space nesting.
 * @param {string} source - the shipped `standard` patch text.
 * @returns {string} the generated override patch text.
 * @throws {Error} when the source is not the expected `insert` of one preset.
 */
function rewrite(source) {
  const lines = source.split('\n')
  const insertAt = lines.findIndex(line => line.trimEnd() === '- insert:')
  if (insertAt === -1) throw new Error('source is not a single "- insert:" patch')
  const rowAt = lines.findIndex((line, index) => index > insertAt && line.trimStart().startsWith(TARGET_ROW))
  if (rowAt === -1) throw new Error(`source row "${TARGET_ROW}" not found`)

  /** @type {string[]} */
  const out = []
  let replaced = false
  let skipNext = false
  for (const [index, line] of lines.entries()) {
    if (index < rowAt) continue
    if (skipNext) {
      skipNext = false
      continue
    }
    // The declaration sits four spaces under `- insert:`; without the wrapper it
    // becomes a top-level patch entry.
    const dedented = line.startsWith('    ') ? line.slice(4) : line.trimStart()
    if (dedented.trimStart().startsWith(REPLACED_ROW)) {
      const indent = ' '.repeat(indentOf(dedented))
      const child = ' '.repeat(indentOf(dedented) + 2)
      out.push(
        `${indent}- id: compaction-sticky-window`,
        `${child}name: 'dsh-compaction-sticky-window'`,
        `${child}config:`,
        `${child}  thresholdRatio: 0.8`,
        `${child}  retainTokens: 0`,
        `${child}  noteMaxBytes: 6144`,
        // This row only supplies the isolated `compaction` service. Automation,
        // notices, the tools, and the prompt protocol all belong to the host
        // row, because a preset realm inherits the `tools` and `systemPrompt`
        // registries it does not isolate. Registering any of them here would
        // double every notice and every pressure check.
        `${child}  auto: false`,
        `${child}  notices: false`,
        `${child}  noteTool: false`,
        `${child}  sensingTool: false`,
        `${child}  historyTool: false`,
        `${child}  newContextTool: false`,
        `${child}  guidance: false`,
      )
      replaced = true
      skipNext = true
      continue
    }
    out.push(dedented)
  }

  if (!replaced) throw new Error(`source row "${REPLACED_ROW}" not found; the preset layout changed`)
  return `${HEADER.join('\n')}${stripUnregistered(stripSuffixConfig(out)).join('\n')}`
}

/**
 * Drop the persona suffix that named the retired `{{cwd}}` variable.
 *
 * The shipped preset of an older release carried `suffix: Your working
 * directory is {{cwd}}.`; the prompt assembler no longer registers `cwd`, so a
 * preset that still sets it fails assembly before any model request — the whole
 * session errors out. The block is removed with its now-empty `config:` parent.
 * @param {string[]} lines - generated patch lines.
 * @returns {string[]} the lines without that block.
 */
function stripSuffixConfig(lines) {
  /** @type {string[]} */
  const out = []
  for (const [index, line] of lines.entries()) {
    if (!/^\s*suffix:\s*Your working directory is \{\{cwd\}\}\.\s*$/u.test(line)) {
      out.push(line)
      continue
    }
    const previous = out[out.length - 1]
    const next = lines[index + 1]
    // The `config:` wrapper is only useful when it still holds another key.
    if (previous !== undefined && /^\s*config:\s*$/u.test(previous)
      && (next === undefined || next.trim() === '' || indentOf(next) <= indentOf(previous))) {
      out.pop()
    }
  }
  return out
}

/**
 * Refuse a snapshot that names a prompt variable the assembler does not register.
 *
 * Only `provider` and `model` are registered by the loop; anything else aborts
 * prompt assembly, so a stale snapshot must not be able to ship one.
 * @param {string[]} lines - generated patch lines.
 * @returns {string[]} the same lines, when clean.
 * @throws {Error} when an unregistered variable is present.
 */
function stripUnregistered(lines) {
  const joined = lines.join('\n')
  const names = [...joined.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/gu)].map(match => match[1])
  const unknown = [...new Set(names)].filter(name => name !== 'provider' && name !== 'model')
  if (unknown.length > 0) {
    throw new Error(
      `refusing to write a preset that interpolates unregistered prompt variables: [${unknown.join(', ')}];`
      + ' the loop registers only provider and model, and any other name aborts prompt assembly',
    )
  }
  return lines
}

/**
 * Plugin ids directly under `config.plugins`, at the given indent width.
 * @param {string} text - a preset patch file.
 * @param {number} spaces - indentation of those child entries.
 * @returns {string[]} the ids, in order.
 */
function childIds(text, spaces) {
  const pattern = new RegExp(`^ {${spaces}}- id: (\\S+)$`, 'gmu')
  return [...text.matchAll(pattern)].map(match => match[1])
}

/**
 * Refuse to write a preset that differs from the shipped one beyond one group.
 *
 * A snapshot that quietly drops a plugin takes tools away from every session
 * that uses it. Comparing id sets — not text, which legitimately differs in the
 * compaction group — is what makes that impossible to ship.
 * @param {string} shipped - the shipped preset text (children at ten spaces).
 * @param {string} written - the rewritten text (children at six spaces).
 * @throws {Error} when the two disagree on which plugins exist.
 */
function assertSameChildren(shipped, written) {
  const before = childIds(shipped, 10)
  const after = childIds(written, 6)
  const missing = before.filter(id => !after.includes(id))
  const added = after.filter(id => !before.includes(id))
  if (before.length === 0 || after.length === 0) {
    throw new Error('could not read the plugin ids on one side; refusing to write')
  }
  if (missing.length > 0 || added.length > 0) {
    throw new Error(
      'refusing to write a preset that differs from the shipped one beyond the compaction group:'
      + `${missing.length > 0 ? ` missing [${missing.join(', ')}]` : ''}`
      + `${added.length > 0 ? ` added [${added.join(', ')}]` : ''}`,
    )
  }
  return after.length
}

const argv = process.argv.slice(2)
const from = option(argv, '--from') ?? defaultSource()
const out = option(argv, '--out')
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'sticky-window.patch.yml')

const source = fs.readFileSync(from, 'utf8')
const generated = rewrite(source)
const plugins = assertSameChildren(source, generated)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `${generated.trimEnd()}\n`, 'utf8')
process.stdout.write(`wrote ${out} from ${from} (${plugins} plugins, id set unchanged)\n`)
