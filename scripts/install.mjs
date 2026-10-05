/**
 * Install (or remove) this plugin in a DSH profile.
 *
 * Two verified facts about the running build drive the design:
 *
 * 1. The plugin manager computes
 *        installed = dependencies.includes(name)
 *        removable = installed && !ownedByInstallation(name)
 *    A bundle row that is not ALSO a declared dependency is reported as
 *    `installed: false, removable: false`, so the Plugins page shows no
 *    enable/disable or uninstall controls — and `reconcile()` silently drops
 *    such a row on the next `dsh plugin` operation. A plugin the user cannot
 *    see or switch off is not really installed.
 *
 * 2. The plugin's RESOLVED real path must stay inside the profile, because its
 *    `@deepseek-ai/*` peer imports are only reachable from there:
 *    `@deepseek-ai/schemastery` lives in the profile's own node_modules, and
 *    the host serves `@deepseek-ai/dsh-tools` / `dsh-credentials` from app.asar
 *    for profile-resident modules. A `link:` to a path OUTSIDE the profile
 *    (say a checkout on the Desktop) resolves to that outside path and fails
 *    with an opaque "failed to import".
 *
 * Both hold if the source is staged into `<profile>/plugins/<name>` and
 * declared as `link:<that path>`: the junction resolves back inside the
 * profile, and the package is a real dependency.
 *
 * Usage:
 *   node scripts/install.mjs [--profile <name>] [--home <dsh-home>] [--dsh <cli>]
 *   node scripts/install.mjs --remove
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGIN_NAME = 'dsh-plugin-agnes-media'
/** Files that make up the staged copy. */
const PAYLOAD = ['lib', 'scripts', 'test', 'package.json', 'cordis.patch.yml', 'README.md']

/** Read `--flag value` from argv. */
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

/**
 * Locate a way to run the `dsh` plugin manager.
 *
 * Preferred: drive the Electron binary directly as Node, exactly as the shipped
 * `dsh.cmd` does. That avoids cmd.exe quoting entirely — the bundled install
 * path contains spaces, and `dsh.cmd` is a batch file that `spawn` cannot
 * execute without a shell.
 *
 * The layout is
 *   <install>/resources/runtime/primary-runtime/dependencies/node/bin/node.exe
 *   <install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js
 * so the install root is six levels up from the interpreter's directory. The
 * CLI script lives INSIDE app.asar, which a plain filesystem check cannot see,
 * so only the archive itself is probed.
 */
function findLauncher() {
  const explicit = option('dsh', process.env.DSH_CLI)
  if (explicit !== undefined) return { kind: 'cmd', path: explicit }

  const installRoot = resolve(dirname(process.execPath), '..', '..', '..', '..', '..', '..')
  const exe = join(installRoot, 'DeepSeek Harness.exe')
  const asar = join(installRoot, 'resources', 'app.asar')
  if (existsSync(exe) && existsSync(asar)) {
    return {
      kind: 'electron',
      exe,
      cliJs: join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    }
  }

  const cmd = join(
    installRoot,
    'resources', 'runtime', 'cli', 'bin',
    process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
  )
  return existsSync(cmd) ? { kind: 'cmd', path: cmd } : undefined
}

const remove = process.argv.includes('--remove')
const dshHome = resolve(option('home', join(homedir(), '.dsh')))
const profileName = option('profile', 'desktop')
const profileDir = join(dshHome, 'profiles', profileName)
const staged = join(profileDir, 'plugins', PLUGIN_NAME)

if (!existsSync(profileDir)) {
  console.error(`profile not found: ${profileDir}`)
  process.exit(1)
}
// Guard the recursive operations below against a mis-resolved path.
if (!staged.startsWith(join(profileDir, 'plugins') + sep)) {
  console.error(`refusing to touch ${staged}: outside ${join(profileDir, 'plugins')}`)
  process.exit(1)
}

const launcher = findLauncher()
if (launcher === undefined) {
  console.error('could not locate the dsh launcher; pass --dsh <path to dsh.cmd>')
  process.exit(1)
}

/** Run the dsh plugin manager, which owns the manifest, bundle row and pnpm. */
function runDshPlugin(args) {
  const argv = ['plugin', '--profile', profileName, ...args]
  const result =
    launcher.kind === 'electron'
      ? spawnSync(launcher.exe, ['--expose-internals', launcher.cliJs, ...argv], {
          stdio: 'inherit',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
      : spawnSync(launcher.path, argv, { stdio: 'inherit' })
  console.log(`> dsh ${argv.join(' ')}  (exit ${result.status ?? 'null'})`)
  return result.status === 0
}

if (remove) {
  if (!runDshPlugin(['remove', PLUGIN_NAME])) {
    console.error('dsh plugin remove failed; nothing else was changed')
    process.exit(1)
  }
  if (existsSync(staged)) {
    rmSync(staged, { recursive: true, force: true })
    console.log(`removed staged source ${staged}`)
  }
  console.log(`\n${PLUGIN_NAME} removed. Restart dsh to unload it.`)
  process.exit(0)
}

// 1. Stage the source inside the profile so the resolved path stays inside it.
if (existsSync(staged)) rmSync(staged, { recursive: true, force: true })
mkdirSync(staged, { recursive: true })
for (const entry of PAYLOAD) {
  cpSync(join(PLUGIN_DIR, entry), join(staged, entry), { recursive: true })
}
console.log(`staged source -> ${staged}`)

// 2. Let the plugin manager declare the dependency and register the bundle row.
if (!runDshPlugin(['add', `link:${staged}`])) {
  console.error('dsh plugin add failed; the staged source is left in place')
  process.exit(1)
}

// 3. Report the resulting state so a wrong outcome is visible immediately.
try {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const declared = manifest.dependencies?.[PLUGIN_NAME]
  const bundled = (manifest.dsh?.profile?.bundles ?? []).includes(PLUGIN_NAME)
  console.log(`\ndependency: ${declared ?? '(missing)'}`)
  console.log(`bundle row: ${bundled ? 'registered' : '(missing)'}`)
  if (declared === undefined || !bundled) {
    console.error('unexpected result: expected both a dependency and a bundle row')
    process.exit(1)
  }
} catch (error) {
  console.error(`could not verify the profile manifest: ${error.message}`)
  process.exit(1)
}

console.log(`\n${PLUGIN_NAME} installed. Restart dsh, then confirm it appears under Plugins.`)
