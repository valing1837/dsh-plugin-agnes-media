/**
 * Pre-flight audit of the DSH profile this plugin installs into.
 *
 * Installing a bundle means editing the profile's `package.json`, its pnpm
 * lockfile and its `node_modules`. A mistake in any of the three can make the
 * loader fail on the next start, so this script checks the whole surface and
 * reports PASS / WARN / FAIL per item before anything is restarted.
 *
 * It is read-only: it never writes to the profile.
 *
 * Usage:
 *   node scripts/doctor.mjs [--profile <name>] [--home <dsh-home>]
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGIN_NAME = 'dsh-plugin-agnes-media'

/** Read `--flag value` from argv. */
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const dshHome = resolve(option('home', join(homedir(), '.dsh')))
const profileName = option('profile', 'desktop')
const profileDir = join(dshHome, 'profiles', profileName)
const nodeModules = join(profileDir, 'node_modules')

const results = []
const record = (level, subject, detail) => {
  results.push({ level, subject, detail })
  console.log(`[${level}] ${subject}${detail === undefined ? '' : ` — ${detail}`}`)
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

// 1. The profile itself must exist and its manifest must parse.
if (!existsSync(profileDir)) {
  record('FAIL', 'profile directory', `missing: ${profileDir}`)
  process.exit(1)
}
record('PASS', 'profile directory', profileDir)

let manifest
try {
  manifest = readJson(join(profileDir, 'package.json'))
  record('PASS', 'profile package.json parses')
} catch (error) {
  record('FAIL', 'profile package.json', error.message)
  process.exit(1)
}

const dependencies = manifest.dependencies ?? {}
const bundles = manifest.dsh?.profile?.bundles ?? []
if (!Array.isArray(bundles)) {
  record('FAIL', 'dsh.profile.bundles', 'is not an array')
  process.exit(1)
}
record('PASS', 'bundle list', `${bundles.length} entries`)

// 2. Every declared dependency must be present in node_modules.
for (const [name, spec] of Object.entries(dependencies)) {
  const dir = join(nodeModules, name)
  if (!existsSync(dir)) {
    record('FAIL', `dependency ${name}`, `declared as ${spec} but missing from node_modules`)
    continue
  }
  try {
    const pkg = readJson(join(dir, 'package.json'))
    record('PASS', `dependency ${name}`, `${pkg.name}@${pkg.version}`)
  } catch (error) {
    record('FAIL', `dependency ${name}`, `package.json unreadable: ${error.message}`)
  }
}

/**
 * Every bundle entry must be resolvable. `@deepseek-ai/*` bundles are served by
 * the application closure inside app.asar and are not expected in the profile.
 */
for (const entry of bundles) {
  if (entry.startsWith('@deepseek-ai/')) {
    record('INFO', `bundle ${entry}`, 'resolved from the application closure (app.asar)')
    continue
  }
  const dir = join(nodeModules, entry)
  if (!existsSync(dir)) {
    record('FAIL', `bundle ${entry}`, 'no such directory in node_modules')
    continue
  }
  let pkg
  try {
    pkg = readJson(join(dir, 'package.json'))
  } catch (error) {
    record('FAIL', `bundle ${entry}`, `package.json unreadable: ${error.message}`)
    continue
  }
  if (pkg.name !== entry) {
    record('WARN', `bundle ${entry}`, `directory package.json declares name ${pkg.name}`)
  }

  // The entry point the loader will import must actually exist.
  const candidates = []
  if (typeof pkg.exports === 'string') candidates.push(pkg.exports)
  else if (pkg.exports?.['.'] !== undefined) {
    const root = pkg.exports['.']
    candidates.push(typeof root === 'string' ? root : (root.import ?? root.default ?? root.require))
  }
  if (typeof pkg.main === 'string') candidates.push(pkg.main)
  const resolved = candidates.filter((value) => typeof value === 'string')
  const hit = resolved.find((relative) => existsSync(join(dir, relative)))
  if (hit === undefined) {
    record('FAIL', `bundle ${entry}`, `no entry point found among ${resolved.join(', ') || '(none declared)'}`)
  } else {
    record('PASS', `bundle ${entry}`, `entry ${hit}`)
  }

  if (pkg.dsh?.bundle?.patch !== undefined && !existsSync(join(dir, pkg.dsh.bundle.patch))) {
    record('FAIL', `bundle ${entry}`, `dsh.bundle.patch missing: ${pkg.dsh.bundle.patch}`)
  }
}

// 3. A stale `link:` entry makes the loader resolve a bundle outside the profile.
const lockPath = join(profileDir, 'pnpm-lock.yaml')
if (!existsSync(lockPath)) {
  record('WARN', 'pnpm-lock.yaml', 'absent; DSH will fall back to node_modules resolution')
} else {
  const lock = readFileSync(lockPath, 'utf8')
  // A `link:` is fine — and is in fact how this plugin installs — as long as it
  // resolves INSIDE the profile. A target outside it is the original bug: the
  // loader then imports the plugin from there and the @deepseek-ai peers are
  // unreachable, which surfaces only as an opaque "failed to import".
  const linkTargets = lock
    .split('\n')
    .map((line) => line.match(/^\s+specifier:\s*link:(.+)$/u)?.[1])
    .filter((value) => value !== undefined)
    .map((value) => value.trim())
  const outsideProfile = linkTargets.filter((target) => {
    const absolute = isAbsolute(target) ? resolve(target) : resolve(profileDir, target)
    return !(absolute === profileDir || absolute.startsWith(profileDir + sep))
  })
  if (outsideProfile.length === 0) {
    record(
      'PASS',
      'pnpm-lock.yaml link: targets',
      linkTargets.length === 0 ? 'none declared' : `${linkTargets.length}, all inside the profile`,
    )
  } else {
    record('FAIL', 'pnpm-lock.yaml link: targets outside the profile', outsideProfile.join('; '))
  }

  // The importer block must agree with the manifest, or pnpm will want to
  // reconcile it on the next install.
  const lines = lock.split('\n')
  const start = lines.findIndex((line) => line === '    dependencies:')
  const declared = new Set()
  if (start !== -1) {
    for (let index = start + 1; index < lines.length; index += 1) {
      const match = lines[index].match(/^ {6}(\S.*):$/u)
      if (match) declared.add(match[1].replace(/^'|'$/gu, ''))
      else if (/^ {4}\S/u.test(lines[index])) break
    }
  }
  const manifestNames = new Set(Object.keys(dependencies))
  const onlyInLock = [...declared].filter((name) => !manifestNames.has(name))
  const onlyInManifest = [...manifestNames].filter((name) => !declared.has(name))
  if (onlyInLock.length === 0 && onlyInManifest.length === 0) {
    record('PASS', 'lockfile importers match package.json dependencies')
  } else {
    record(
      'WARN',
      'lockfile/manifest mismatch',
      `lockfile-only: ${onlyInLock.join(', ') || 'none'}; manifest-only: ${onlyInManifest.join(', ') || 'none'}`,
    )
  }
}

// 4. This plugin specifically.
//
// Two invariants matter here and they pull in opposite directions:
//   - the RESOLVED real path must stay inside the profile, or the
//     `@deepseek-ai` peers are unreachable from it (the original failure);
//   - the package must be a DECLARED dependency, or the plugin manager reports
//     `installed: false` (so the Plugins page offers no controls) and
//     `reconcile()` drops the bundle row on the next install.
// A junction into <profile>/plugins/ satisfies both at once.
const installed = join(nodeModules, PLUGIN_NAME)
if (!existsSync(installed)) {
  record('WARN', `${PLUGIN_NAME} installed`, 'not present in node_modules')
} else {
  const real = realpathSync(installed)
  if (!(real === profileDir || real.startsWith(profileDir + sep))) {
    record(
      'FAIL',
      `${PLUGIN_NAME} install location`,
      `resolves outside the profile (${real}); the @deepseek-ai peers will not resolve from there`,
    )
  } else {
    record(
      'PASS',
      `${PLUGIN_NAME} install location`,
      lstatSync(installed).isSymbolicLink()
        ? `linked to ${real}`
        : 'real directory inside the profile',
    )
  }

  if (!Object.hasOwn(dependencies, PLUGIN_NAME)) {
    record(
      'FAIL',
      `${PLUGIN_NAME} is a declared dependency`,
      'absent from package.json dependencies: the Plugins page reports installed=false and reconcile() drops the bundle row',
    )
  } else {
    record('PASS', `${PLUGIN_NAME} is a declared dependency`, dependencies[PLUGIN_NAME])
  }

  const installedSource = join(installed, 'lib', 'index.js')
  const localSource = join(PLUGIN_DIR, 'lib', 'index.js')
  if (existsSync(installedSource) && existsSync(localSource)) {
    const same =
      readFileSync(installedSource, 'utf8') === readFileSync(localSource, 'utf8')
    record(
      same ? 'PASS' : 'WARN',
      `${PLUGIN_NAME} in sync with source`,
      same ? undefined : 'installed lib/index.js differs; re-run scripts/install.mjs',
    )
  }
}

// 5. Leftover scratch state must not be referenced by the loader.
const leftovers = []
for (const entry of bundles) {
  if (/agnes-probe/u.test(entry)) leftovers.push(`bundle entry ${entry}`)
}
try {
  for (const name of readdirSync(nodeModules)) {
    if (/agnes-probe/u.test(name)) leftovers.push(`node_modules/${name}`)
  }
} catch {
  // Directory listing is best-effort.
}
for (const candidate of ['agnes-probe-report.txt', 'agnes-probe3.txt', 'agnes-probe4.txt']) {
  if (existsSync(join(dshHome, candidate))) leftovers.push(`~/.dsh/${candidate}`)
}
if (leftovers.length === 0) {
  record('PASS', 'no diagnostic leftovers')
} else {
  record('WARN', 'diagnostic leftovers', leftovers.join(', '))
}

// 6. The profile's own patch layer must still be a YAML sequence, and it must
// not carry scratch rows left behind by enable/disable experiments: the plugin
// manager persists those as `- id: <row>` entries that outlive the package.
const patchPath = join(profileDir, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  record('WARN', 'profile cordis.patch.yml', 'absent')
} else {
  const patch = readFileSync(patchPath, 'utf8')
  if (statSync(patchPath).size === 0) {
    record('WARN', 'profile cordis.patch.yml', 'empty file')
  } else if (!/^\s*-/mu.test(patch)) {
    record('WARN', 'profile cordis.patch.yml', 'no sequence entries found')
  } else {
    const patchIds = [...patch.matchAll(/^- id:\s*(\S+)/gmu)].map((match) => match[1])
    record('INFO', 'patch layer ids', patchIds.join(', '))
    const scratch = patchIds.filter((id) => /probe|scratch|tmp|dummy/iu.test(id))
    if (scratch.length === 0) {
      record('PASS', 'profile cordis.patch.yml', `${patchIds.length} entries, no scratch rows`)
    } else {
      record('FAIL', 'scratch rows in cordis.patch.yml', `${scratch.join(', ')} — remove them by hand`)
    }
  }
}

// 7. cordis.yml is the profile ROOT and is documented as an empty entry list;
// DSH composes the real tree from the bundles plus the patch layer. A populated
// root is a saved snapshot and can double-mount every row on the next start.
const rootPath = join(profileDir, 'cordis.yml')
if (!existsSync(rootPath)) {
  record('INFO', 'cordis.yml root', 'absent')
} else {
  const rootText = readFileSync(rootPath, 'utf8')
  const rootEntries = rootText.split('\n').filter((line) => /^- /.test(line)).length
  if (rootEntries === 0) {
    record('PASS', 'cordis.yml root is empty', 'tree is composed from bundles + cordis.patch.yml')
  } else {
    record(
      'WARN',
      'cordis.yml root is not empty',
      `${rootEntries} top-level entries; DSH expects an empty root and composes the tree itself`,
    )
  }
}

const failures = results.filter((entry) => entry.level === 'FAIL')
const warnings = results.filter((entry) => entry.level === 'WARN')
console.log(`\n${results.length} checks: ${failures.length} failed, ${warnings.length} warnings`)
process.exit(failures.length === 0 ? 0 : 1)
