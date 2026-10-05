/**
 * Assert the plugin's structural contract.
 *
 * The behavioural tests drive individual tools; this one covers the surface a
 * consumer depends on before any call happens: the plugin name, the declared
 * service dependency, that all four tools register, and that every tool's
 * `render` returns content blocks rather than a bare string (a bare string
 * breaks the post-execute consumers downstream).
 *
 * No network, no credential, no DSH profile — safe to run in CI.
 *
 * Usage: node tools.mjs
 */
import { loadPlugin, makeRecorder } from './harness.mjs'

const record = makeRecorder()

const EXPECTED_TOOLS = [
  'agnes_media_status',
  'agnes_image_generate',
  'agnes_video_generate',
  'agnes_video_status',
]

const { module, tools } = await loadPlugin()

record('plugin name is agnes-media', module.name === 'agnes-media', module.name)
record(
  'declares the tools service dependency',
  Array.isArray(module.inject) && module.inject.includes('tools'),
  JSON.stringify(module.inject),
)

for (const name of EXPECTED_TOOLS) {
  const tool = tools.get(name)
  const shaped =
    tool !== undefined &&
    typeof tool.execute === 'function' &&
    typeof tool.description === 'string' &&
    tool.description.length > 20 &&
    tool.parameters?.type === 'object'
  record(`registers ${name}`, shaped, tool === undefined ? 'missing' : undefined)
}

record(
  'registers no unexpected tools',
  tools.size === EXPECTED_TOOLS.length,
  [...tools.keys()].join(', '),
)

// `render` is the model-facing projection; the contract requires blocks.
for (const name of EXPECTED_TOOLS) {
  const tool = tools.get(name)
  if (tool === undefined) continue
  let rendered
  try {
    rendered = tool.output.render({}, {})
  } catch (error) {
    record(`${name} render returns blocks`, false, error.message)
    continue
  }
  record(
    `${name} render returns text blocks`,
    Array.isArray(rendered) && rendered.length > 0 && rendered.every((b) => b?.type === 'text'),
    Array.isArray(rendered) ? `${rendered.length} block(s)` : typeof rendered,
  )
}

// Every declared parameter must carry a description, or the model is guessing.
for (const name of EXPECTED_TOOLS) {
  const tool = tools.get(name)
  if (tool === undefined) continue
  const undocumented = Object.entries(tool.parameters?.properties ?? {})
    .filter(([, spec]) => typeof spec?.description !== 'string' || spec.description.length === 0)
    .map(([key]) => key)
  record(
    `${name} documents every parameter`,
    undocumented.length === 0,
    undocumented.join(', ') || `${Object.keys(tool.parameters?.properties ?? {}).length} params`,
  )
}

// Mandatory arguments must be declared in the schema, not only checked at
// runtime: the schema is what tells the model which fields it must supply.
const REQUIRED_PARAMS = {
  agnes_image_generate: ['prompt'],
  agnes_video_generate: ['prompt'],
  agnes_video_status: ['videoId'],
}
for (const [name, expected] of Object.entries(REQUIRED_PARAMS)) {
  const tool = tools.get(name)
  const required = tool?.parameters?.required ?? []
  record(
    `${name} declares its required params`,
    expected.every((param) => required.includes(param)),
    `required: ${required.join(', ') || '(none)'}`,
  )
}

const failed = record.results.filter((entry) => entry.status === 'FAIL').length
console.log(`\n${record.results.length - failed}/${record.results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
