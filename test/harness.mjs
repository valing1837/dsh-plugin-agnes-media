/**
 * Shared harness for the plugin's tests.
 *
 * Loads the plugin's real source with the three DSH peer packages supplied as
 * minimal stubs, and returns a callable tool surface. The stubs live in a
 * scratch directory OUTSIDE the plugin tree on purpose: a
 * `node_modules/@deepseek-ai/*` under the plugin's own directory would shadow
 * the host-provided packages once the plugin is installed into a profile.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_SOURCE = fileURLToPath(new URL('../lib/index.js', import.meta.url))

/** Read one `refs:` entry from the DSH credential store, for live tests. */
export function readKey(name) {
  if (process.env[name]) return process.env[name]
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const lines = text.split(/\r?\n/)
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (inRefs && /^\S/.test(line)) break
    const match = inRefs ? line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/) : null
    if (match && match[1] === name) return match[2].trim().replace(/^["']|["']$/g, '')
  }
  return undefined
}

/** Install the peer-package stubs the plugin imports. */
function installStubs(root) {
  const write = (pkg, source) => {
    const dir = join(root, 'node_modules', '@deepseek-ai', pkg)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: `@deepseek-ai/${pkg}`, type: 'module', main: 'index.js' }),
    )
    writeFileSync(join(dir, 'index.js'), source)
  }

  // defineTool normalizes the author-facing parameter property map into an
  // object-rooted JSON Schema (pulling `required: true` entries into a
  // `required` array) and rejects a call whose required arguments are absent.
  // Mirroring both keeps the tests honest about what the real definition does,
  // instead of only checking the shape the source declares.
  write(
    'dsh-tools',
    [
      'export const defineTool = (options) => {',
      '  const properties = {}',
      '  const required = []',
      '  for (const [key, spec] of Object.entries(options.parameters ?? {})) {',
      '    const { required: isRequired, ...rest } = spec',
      '    properties[key] = rest',
      '    if (isRequired === true) required.push(key)',
      '  }',
      '  return {',
      '    ...options,',
      '    parameters: {',
      "      type: 'object',",
      '      properties,',
      '      ...(required.length > 0 ? { required } : {}),',
      '    },',
      '    async execute(args, exec) {',
      '      for (const key of required) {',
      '        if (args == null || args[key] === undefined) {',
      '          throw new Error(`invalid arguments: ${key} is required`)',
      '        }',
      '      }',
      '      return options.execute(args, exec)',
      '    },',
      '  }',
      '}',
      '',
    ].join('\n'),
  )

  // credentialRef just brands the reference name.
  write('dsh-credentials', 'export const credentialRef = (name) => ({ ref: name })\n')

  // Schemastery only declares the Config schema at import time; a permissive
  // chainable proxy is enough to evaluate that declaration.
  write(
    'schemastery',
    [
      'const chain = new Proxy(function () {}, {',
      '  get(_target, prop) {',
      "    if (typeof prop === 'symbol') return undefined",
      '    return () => chain',
      '  },',
      '  apply() { return chain },',
      '})',
      'const Schema = new Proxy({}, { get: () => () => chain })',
      'export default Schema',
      '',
    ].join('\n'),
  )
}

/**
 * Load the plugin and return its registered tools.
 *
 * @param options.root - scratch directory; defaults to a stable temp path.
 * @param options.config - plugin config handed to `apply`.
 * @param options.credentials - map used to answer `ctx.credentials.resolve`.
 */
export async function loadPlugin(options = {}) {
  const root = options.root ?? join(tmpdir(), 'agnes-plugin-verify')
  // The session workspace and the deployment fallback root are deliberately
  // DIFFERENT directories: a relative outputDir must resolve against the
  // session cwd, and only a regression would land files in the fallback.
  const workspace = options.workspace ?? join(root, 'workspace')
  const fallbackRoot = options.fallbackRoot ?? join(root, 'profile-root')
  const credentials = options.credentials ?? {
    async resolve(ref) {
      const value = readKey(ref?.ref)
      return value === undefined ? undefined : { value }
    },
  }

  installStubs(root)
  mkdirSync(join(root, 'plugin'), { recursive: true })
  copyFileSync(PLUGIN_SOURCE, join(root, 'plugin', 'index.js'))

  const module = await import(pathToFileURL(join(root, 'plugin', 'index.js')).href)

  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get(service) {
      if (service === 'credentials') return credentials
      if (service === 'sandboxPolicy') return { workspaceRoot: fallbackRoot }
      return undefined
    },
  }

  module.apply(ctx, options.config ?? {})

  // Shape a real tool execution: the built-in tools read the session cwd from
  // `exec.agent.session.header.cwd`, so the stub must expose the same path.
  const exec = {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: workspace } } },
  }
  return {
    module,
    ctx,
    tools,
    workspace,
    fallbackRoot,
    exec,
    call: (name, args, override) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`no such tool: ${name}`)
      return tool.execute(args, override ?? exec)
    },
  }
}

/** Minimal assertion helper: records PASS/FAIL and never throws. */
export function makeRecorder() {
  const results = []
  const record = (name, ok, detail) => {
    const status = ok ? 'PASS' : 'FAIL'
    results.push({ name, status, detail })
    console.log(`[${status}] ${name}${detail === undefined ? '' : ` — ${detail}`}`)
    return ok
  }
  record.results = results
  return record
}
