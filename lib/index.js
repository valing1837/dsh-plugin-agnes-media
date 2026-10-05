/**
 * `dsh-plugin-agnes-media` — Agnes AI image and video generation for DeepSeek
 * Harness, exposed as four host-side tools.
 *
 * Deliberately has NO browser half: no `dsh.client` field and no `lib/client.js`.
 * On DSH 0.2.x a client bundle must self-register through
 * `window.__ModuleLoader__.load({...})`; shipping plain ESM there is a hard boot
 * failure. This plugin only registers host-side tools, so that entire class of
 * failure cannot happen. Configuration is reached through the profile patch
 * layer and the DSH credentials domain instead of a settings page.
 *
 * Two Agnes AI model families are covered, matching the published contracts:
 *
 *   Image — `POST {base}/v1/images/generations`
 *     `model`, `prompt` and `size` are required; `ratio` pairs with a tier size;
 *     `extra_body.image` carries reference images for image-to-image and
 *     multi-image composition; `return_base64` (text-to-image) or
 *     `extra_body.response_format` (`url` | `b64_json`) selects the payload.
 *     `response_format` must NOT sit at the top level of the body.
 *
 *   Video — `POST {base}/v1/videos`, then `GET {base}/agnesapi?video_id=...`
 *     `model`, `prompt` and `mode` (`text` | `keyframe` | `reference`) are
 *     required. Each mode forbids the other modes' media fields. Results are
 *     polled by `video_id` (never `task_id`) with `model_name` attached, and the
 *     finished video URL arrives in the task metadata.
 *
 * The API key is never stored here. It resolves, in order, from:
 *   1. the `apiKey` config field (a literal, `role('secret')`),
 *   2. the DSH credentials domain via `credentialRef(config.apiKeyRef)`
 *      (a name under `refs:` in `$DSH_HOME/.credentials.yaml`),
 *   3. the process environment variable named by `apiKeyRef`.
 *
 * @module dsh-plugin-agnes-media
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'agnes-media'

/** The tool registry this plugin contributes into. */
export const inject = ['tools']

/** Default credential reference resolved from the DSH credentials domain. */
const DEFAULT_KEY_REF = 'AGNES_API_KEY'
/** Agnes AI API root. Both media endpoints hang off this host. */
const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com'
const DEFAULT_IMAGE_MODEL = 'agnes-image-2.5-flash'
const DEFAULT_VIDEO_MODEL = 'agnes-video-2.5-flash'
/** Directory created under the workspace root for downloaded media. */
const DEFAULT_OUTPUT_DIR = 'agnes-media'

/** Tier sizes accepted by the image endpoint. Exact `WxH` strings also work. */
const IMAGE_SIZE_TIERS = ['1K', '2K', '3K', '4K']
/** Aspect ratios accepted alongside a tier size by the image endpoint. */
const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']
/** Resolution tiers accepted by the video endpoint; Flash is 720P only. */
const VIDEO_SIZES = ['720P', '960P', '2K']
const FLASH_VIDEO_SIZES = ['720P']
/** Aspect ratios accepted by the video endpoint. */
const VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
/** Generation modes; each one forbids the other modes' media fields. */
const VIDEO_MODES = ['text', 'keyframe', 'reference']
/** Reference-image ceiling for the Flash video model. */
const FLASH_MAX_REFERENCE_IMAGES = 5

/** Task states that mean the media is ready. */
const TASK_DONE = new Set(['completed', 'success', 'succeeded'])
/** Task states that mean the task will never produce media. */
const TASK_FAILED = new Set(['failed', 'error', 'canceled', 'cancelled'])

/** Content-type to file-extension map for saved media. */
const MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
}

export const Config = Schema.object({
  apiKeyRef: Schema.string()
    .role('credential-ref')
    .default(DEFAULT_KEY_REF)
    .description('Credential reference resolved through the DSH credentials domain.'),
  apiKey: Schema.string()
    .role('secret')
    .description('Literal API key. Prefer apiKeyRef so the secret stays out of the profile config.'),
  baseUrl: Schema.string()
    .default(DEFAULT_BASE_URL)
    .description('Agnes AI API root. Use https://apihub.agnes-ai.cn for the China site.'),
  imageModel: Schema.string()
    .default(DEFAULT_IMAGE_MODEL)
    .description('Image model id sent to /v1/images/generations.'),
  videoModel: Schema.string()
    .default(DEFAULT_VIDEO_MODEL)
    .description('Video model id sent to /v1/videos and echoed as model_name when polling.'),
  outputDir: Schema.string()
    .default(DEFAULT_OUTPUT_DIR)
    .description(
      'Directory for downloaded media. A relative path resolves against the sandbox workspace root, so generated files land in the session workspace by default.',
    ),
  requestTimeoutMs: Schema.number()
    .step(1000)
    .min(1000)
    .default(300000)
    .description('Per-request timeout for image generation and media downloads.'),
  pollIntervalMs: Schema.number()
    .step(250)
    .min(250)
    .default(2000)
    .description('Delay between video task polls. The vendor recommends 1-2 seconds.'),
  pollTimeoutMs: Schema.number()
    .step(1000)
    .min(1000)
    .default(900000)
    .description('How long agnes_video_generate waits for a task before returning the still-running task id.'),
})

/** Content blocks the model reads for an object-shaped result. */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Canonical object result: structured for programs, JSON text for the model. */
const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: renderJson,
}

/** A rendered block list is the contract; a bare string breaks later consumers. */
function renderText(text) {
  return [{ type: 'text', text }]
}

/** Every failure reads the same way, so a tool error is recognisable at a glance. */
function fail(message) {
  return new Error(`agnes-media: ${message}`)
}

/** Drop `undefined` values: the result contract is lossless JSON. */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = prune(item)
    }
    return out
  }
  return value
}

/** Read a required non-empty string argument. */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw fail(`${field} is required and must be a non-empty string`)
  }
  return value.trim()
}

/** Read an optional non-empty string argument. */
function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Normalise a string[] argument, dropping blanks and non-strings. */
function stringList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

/** Reject a value that is outside a documented enum, listing the alternatives. */
function assertOneOf(value, allowed, field) {
  if (value === undefined) return
  if (!allowed.includes(value)) {
    throw fail(`${field} must be one of ${allowed.join(', ')} (received ${JSON.stringify(value)})`)
  }
}

/** `YYYYMMDD-HHmmss`, so repeated generations never collide. */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * The calling session's workspace directory.
 *
 * Mirrors the built-in filesystem tools: the agent carries its own session
 * (`exec.agent.session.header.cwd`), so each session writes into its own
 * workspace. Returns undefined for agentless calls.
 */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * The deployment's workspace-write fallback root.
 *
 * Documented as "the absolute workspace-write fallback root for calls without a
 * session cwd" — in the desktop build that resolves to the profile directory,
 * so it must not be the primary answer for a relative output directory.
 */
function fallbackWorkspaceRoot(ctx) {
  const policy = ctx.get('sandboxPolicy')
  const root = policy?.workspaceRoot
  return typeof root === 'string' && root.length > 0 ? root : process.cwd()
}

/** Resolve the media output directory for one call. */
function resolveOutputDir(ctx, config, saveDir, exec) {
  const requested = optionalString(saveDir) ?? optionalString(config.outputDir) ?? DEFAULT_OUTPUT_DIR
  if (isAbsolute(requested)) return requested
  return resolve(sessionCwd(exec) ?? fallbackWorkspaceRoot(ctx), requested)
}

/** Choose a free file path, suffixing `-2`, `-3`, ... rather than overwriting. */
function uniquePath(dir, base, extension) {
  let candidate = join(dir, `${base}${extension}`)
  let counter = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${base}-${counter}${extension}`)
    counter += 1
  }
  return candidate
}

/** Pick a file extension from the response content type, then the URL. */
function extensionFor(mimeType, url, fallback) {
  const normalised = optionalString(mimeType)?.split(';')[0].trim().toLowerCase()
  if (normalised !== undefined && MIME_EXTENSIONS[normalised] !== undefined) {
    return MIME_EXTENSIONS[normalised]
  }
  if (optionalString(url) !== undefined) {
    try {
      const fromUrl = extname(new URL(url).pathname)
      if (fromUrl.length > 0 && fromUrl.length <= 5) return fromUrl
    } catch {
      // A malformed URL is not fatal here; fall through to the caller's default.
    }
  }
  return fallback
}

/** Abort when either the caller cancels or the request budget expires. */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Sleep that rejects immediately when the surrounding call is cancelled. */
function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(resolvePromise, ms)
    if (signal === undefined) return
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        rejectPromise(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })
}

/**
 * Resolve the Agnes API key and report where it came from, so `agnes_media_status`
 * can explain a misconfiguration without leaking the secret.
 *
 * @param ctx - Cordis context.
 * @param config - Resolved plugin config.
 * @returns key plus a human-readable source label, or undefined key.
 */
async function resolveApiKey(ctx, config) {
  if (typeof config.apiKey === 'string' && config.apiKey.length > 0) {
    return { key: config.apiKey, source: 'config.apiKey' }
  }

  const ref = config.apiKeyRef ?? DEFAULT_KEY_REF
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(credentialRef(ref))
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
        return { key: hit.value, source: `credentials:${ref}` }
      }
    } catch (error) {
      return { key: undefined, source: `credentials:${ref} (resolve failed: ${error?.message ?? error})` }
    }
  }

  const ambient = process.env[ref]
  if (typeof ambient === 'string' && ambient.length > 0) {
    return { key: ambient, source: `env:${ref}` }
  }

  return { key: undefined, source: `unset (${ref})` }
}

/** The API root with any trailing slash removed. */
function apiBase(config) {
  return (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/**
 * One Agnes AI call.
 *
 * The gateway reports failures as `{ code, message, data }`, so both are
 * surfaced: `code` is what callers branch on (`video_queue_full`) and `message`
 * is what a human needs to read.
 *
 * @param ctx - Cordis context (for credential resolution).
 * @param config - Resolved plugin config.
 * @param method - HTTP method.
 * @param path - Path beginning with `/`.
 * @param body - Optional JSON request body.
 * @param signal - Abort signal from the tool execution.
 * @returns Parsed JSON body.
 */
async function agnesRequest(ctx, config, method, path, body, signal) {
  const { key, source } = await resolveApiKey(ctx, config)
  if (key === undefined) {
    throw fail(
      `no API key available (looked in ${source}). Add ${config.apiKeyRef ?? DEFAULT_KEY_REF} to $DSH_HOME/.credentials.yaml refs, or set the apiKey config field.`,
    )
  }

  const headers = { authorization: `Bearer ${key}` }
  if (body !== undefined) headers['content-type'] = 'application/json'

  const response = await fetch(`${apiBase(config)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: withTimeout(signal, config.requestTimeoutMs ?? 300000),
  })

  const text = await response.text()
  let parsed
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
  }

  if (!response.ok) {
    // The gateway reports failures in two shapes: a flat `{ code, message }`
    // (capacity errors such as video_queue_full) and a nested
    // `{ error: { code, message } }` (rate limits). Accept both.
    const code = optionalString(parsed?.code) ?? optionalString(parsed?.error?.code)
    const detail =
      optionalString(parsed?.message) ??
      optionalString(parsed?.error?.message) ??
      text.slice(0, 300)
    const error = fail(
      `${method} ${path} -> HTTP ${response.status}${code === undefined ? '' : ` (${code})`}: ${detail}`,
    )
    error.status = response.status
    if (code !== undefined) error.code = code
    throw error
  }

  if (parsed === undefined) {
    throw fail(`${method} ${path} returned a non-JSON body: ${text.slice(0, 300)}`)
  }
  return parsed
}

/** Download a media URL to disk and report what was written. */
async function downloadToFile(url, targetPath, signal, timeoutMs) {
  const response = await fetch(url, { signal: withTimeout(signal, timeoutMs) })
  if (!response.ok) {
    throw fail(`download ${url} -> HTTP ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, bytes)
  return {
    bytes: bytes.length,
    mimeType: optionalString(response.headers.get('content-type')),
  }
}

/** Decode a base64 payload to disk. */
function writeBase64File(base64, targetPath) {
  const bytes = Buffer.from(base64, 'base64')
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, bytes)
  return { bytes: bytes.length }
}

/** The first non-empty `data[]` entry of an image response. */
function firstImageData(parsed) {
  return Array.isArray(parsed?.data) ? parsed.data[0] : undefined
}

/** Normalise a task status, wherever the gateway puts it. */
function taskStatus(body) {
  const raw = body?.status ?? body?.data?.status ?? body?.state
  return typeof raw === 'string' ? raw.toLowerCase() : 'unknown'
}

/** Task progress as a number, when the gateway reports one. */
function taskProgress(body) {
  const raw = body?.progress ?? body?.data?.progress
  return typeof raw === 'number' ? raw : undefined
}

/** Find the finished video URL among the shapes the gateway has used. */
function extractVideoUrl(body) {
  const candidates = [
    body?.metadata?.url,
    body?.data?.[0]?.url,
    body?.data?.url,
    body?.video_url,
    body?.url,
    body?.output?.url,
    body?.result?.url,
  ]
  return candidates.find((value) => typeof value === 'string' && /^https?:\/\//.test(value))
}

/** The vendor's error text for a failed task. */
function taskError(body) {
  return (
    optionalString(body?.error?.message) ??
    optionalString(body?.error) ??
    optionalString(body?.message) ??
    'no detail reported'
  )
}

/**
 * Query one video task.
 *
 * @returns the raw body plus normalised status, progress and (when ready) URL.
 */
async function queryVideo(ctx, config, videoId, signal) {
  const model = config.videoModel ?? DEFAULT_VIDEO_MODEL
  const path =
    `/agnesapi?video_id=${encodeURIComponent(videoId)}` + `&model_name=${encodeURIComponent(model)}`
  const body = await agnesRequest(ctx, config, 'GET', path, undefined, signal)
  return {
    body,
    status: taskStatus(body),
    progress: taskProgress(body),
    url: extractVideoUrl(body),
  }
}

/**
 * Poll a video task until it settles, the caller stops waiting, or the budget runs out.
 *
 * @param wait - when false, one query is made and a non-terminal status is returned as-is.
 */
async function pollVideo(ctx, config, videoId, options) {
  const { wait, signal, onProgress } = options
  const interval = config.pollIntervalMs ?? 2000
  const deadline = Date.now() + (config.pollTimeoutMs ?? 900000)
  let last

  for (;;) {
    last = await queryVideo(ctx, config, videoId, signal)
    if (onProgress !== undefined) onProgress(last)

    if (TASK_DONE.has(last.status)) return last
    if (TASK_FAILED.has(last.status)) {
      throw fail(`video task ${videoId} ${last.status}: ${taskError(last.body)}`)
    }
    if (!wait) return last
    if (Date.now() >= deadline) {
      const error = fail(
        `video task ${videoId} is still ${last.status} after ${Math.round((config.pollTimeoutMs ?? 900000) / 1000)}s. ` +
          `It keeps running server-side — call agnes_video_status with this videoId to collect it.`,
      )
      error.videoId = videoId
      throw error
    }
    await sleep(interval, signal)
  }
}

/**
 * Shared argument plumbing for the two tools that can wait on a video task.
 *
 * @param args - the model-supplied arguments.
 * @param defaultWait - the tool's documented default when `wait` is omitted:
 *   true for `agnes_video_generate` (it should hand back a finished clip),
 *   false for `agnes_video_status` (one status check unless asked to wait).
 */
function videoOptions(args, defaultWait) {
  return {
    wait: args.wait === undefined ? defaultWait : args.wait === true,
    download: args.download !== false,
    saveDir: args.saveDir,
    fileName: args.fileName,
  }
}

/**
 * Persist a settled video task and shape the tool result.
 *
 * @param task - the settled poll result.
 */
async function collectVideo(ctx, config, task, options, exec) {
  const result = {
    videoId: task.body?.video_id ?? task.body?.id,
    taskId: task.body?.task_id,
    status: task.status,
    progress: task.progress,
    seconds: task.body?.seconds,
    size: task.body?.size,
    aspectRatio: task.body?.aspect_ratio ?? task.body?.ratio,
    model: task.body?.model,
    url: task.url,
    saved: false,
  }

  if (task.url !== undefined && options.download) {
    const dir = resolveOutputDir(ctx, config, options.saveDir, exec)
    const extension = extensionFor(undefined, task.url, '.mp4')
    const base = optionalString(options.fileName) ?? `agnes-video-${stamp()}`
    const target = uniquePath(dir, base, extension)
    const written = await downloadToFile(
      task.url,
      target,
      exec?.signal,
      config.requestTimeoutMs ?? 300000,
    )
    result.path = target
    result.bytes = written.bytes
    result.mimeType = written.mimeType
    result.saved = true
  }

  return prune(result)
}

/**
 * Register the Agnes media tool surface.
 *
 * @param ctx - Cordis context.
 * @param config - Resolved plugin config.
 */
export function apply(ctx, config) {
  const keyRef = config.apiKeyRef ?? DEFAULT_KEY_REF
  const imageModel = config.imageModel ?? DEFAULT_IMAGE_MODEL
  const videoModel = config.videoModel ?? DEFAULT_VIDEO_MODEL

  ctx.tools.register(
    defineTool({
      name: 'agnes_media_status',
      description:
        'Report the Agnes media plugin configuration: resolved API key source, base URL, model ids and output directory. Performs no network request unless ping is true.',
      parameters: {
        ping: {
          type: 'boolean',
          description: 'Also call GET /v1/models to confirm the key authenticates.',
        },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const { key, source } = await resolveApiKey(ctx, config)
        const result = {
          keyPresent: key !== undefined,
          keySource: source,
          keyRef,
          baseUrl: apiBase(config),
          imageModel,
          videoModel,
          imageEndpoint: `${apiBase(config)}/v1/images/generations`,
          videoEndpoint: `${apiBase(config)}/v1/videos`,
          videoQueryEndpoint: `${apiBase(config)}/agnesapi?video_id=<video_id>&model_name=${videoModel}`,
          outputDir: resolveOutputDir(ctx, config, undefined, exec),
        }
        if (args.ping === true) {
          try {
            const models = await agnesRequest(ctx, config, 'GET', '/v1/models', undefined, exec?.signal)
            const ids = Array.isArray(models?.data) ? models.data.map((entry) => entry?.id) : []
            result.ping = {
              ok: true,
              imageModelAvailable: ids.includes(imageModel),
              videoModelAvailable: ids.includes(videoModel),
              modelCount: ids.length,
            }
          } catch (error) {
            result.ping = { ok: false, error: error?.message ?? String(error) }
          }
        }
        return prune(result)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'agnes_image_generate',
      description:
        'Generate or edit images with the Agnes image model (agnes-image-2.5-flash): text-to-image, image-to-image, and multi-image composition. By default the result is downloaded into the workspace and the local path is returned, so it can be shown to the user.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description:
            'What to generate or how to edit the input images. A clear structure works best: subject + scene + style + lighting + composition + quality.',
        },
        size: {
          type: 'string',
          description:
            `Output size tier (${IMAGE_SIZE_TIERS.join(', ')}) or an exact WxH string such as 1024x768. Default 2K.`,
        },
        ratio: {
          type: 'string',
          description: `Aspect ratio used with a tier size: ${IMAGE_RATIOS.join(', ')}. Default 1:1.`,
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Reference images for image-to-image or multi-image composition. Each entry is a publicly reachable HTTPS image URL or a data URI (data:image/png;base64,...). Supplying these switches the call to editing mode.',
        },
        output: {
          type: 'string',
          description:
            "'file' (default) downloads the image into the workspace, 'url' returns the vendor URL only, 'base64' returns the raw base64 payload in the result.",
        },
        saveDir: {
          type: 'string',
          description:
            'Directory for output=file. A relative path resolves against the workspace root; defaults to the configured outputDir.',
        },
        fileName: {
          type: 'string',
          description: 'Optional file name (without extension) for output=file.',
        },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const prompt = requireString(args.prompt, 'prompt')
        const size = optionalString(args.size) ?? '2K'
        const ratio = optionalString(args.ratio)
        assertOneOf(ratio, IMAGE_RATIOS, 'ratio')
        const references = stringList(args.images)
        const output = optionalString(args.output) ?? 'file'
        assertOneOf(output, ['file', 'url', 'base64'], 'output')

        const editing = references.length > 0
        const wantsBase64 = output === 'base64'

        const body = { model: imageModel, prompt, size }
        if (ratio !== undefined) body.ratio = ratio

        // `response_format` must live inside extra_body, never at the top level.
        const extraBody = {}
        if (editing) extraBody.image = references
        if (editing) extraBody.response_format = wantsBase64 ? 'b64_json' : 'url'
        else if (!wantsBase64) extraBody.response_format = 'url'
        if (Object.keys(extraBody).length > 0) body.extra_body = extraBody
        // Text-to-image has its own base64 switch; image-to-image uses response_format.
        if (!editing && wantsBase64) body.return_base64 = true

        const parsed = await agnesRequest(
          ctx,
          config,
          'POST',
          '/v1/images/generations',
          body,
          exec?.signal,
        )

        const first = firstImageData(parsed)
        const url = optionalString(first?.url)
        const base64 = optionalString(first?.b64_json)
        if (url === undefined && base64 === undefined) {
          throw fail('response contained neither data[0].url nor data[0].b64_json')
        }

        const result = {
          model: imageModel,
          prompt,
          size,
          ratio,
          mode: editing ? (references.length > 1 ? 'multi-image' : 'image-to-image') : 'text-to-image',
          referenceCount: editing ? references.length : 0,
          taskId: parsed?.task_id,
          created: parsed?.created,
          revisedPrompt: optionalString(first?.revised_prompt),
          output,
        }

        if (output === 'file') {
          const dir = resolveOutputDir(ctx, config, args.saveDir, exec)
          const base = optionalString(args.fileName) ?? `agnes-image-${stamp()}`
          if (url !== undefined) {
            const extension = extensionFor(undefined, url, '.png')
            const target = uniquePath(dir, base, extension)
            const written = await downloadToFile(url, target, exec?.signal, config.requestTimeoutMs ?? 300000)
            result.path = target
            result.bytes = written.bytes
            result.mimeType = written.mimeType
            result.url = url
          } else {
            const target = uniquePath(dir, base, '.png')
            const written = writeBase64File(base64, target)
            result.path = target
            result.bytes = written.bytes
            result.mimeType = 'image/png'
          }
          result.saved = true
        } else if (output === 'url') {
          result.url = url
        } else {
          result.base64 = base64
          result.url = url
        }

        return prune(result)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'agnes_video_generate',
      description:
        'Create an Agnes video generation task (agnes-video-2.5-flash) and, by default, wait for it and download the finished video into the workspace. Modes: text (prompt only), keyframe (first/last frame images), reference (reference images and/or audio).',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description:
            'Video description. In reference mode, refer to the supplied media in order.',
        },
        mode: {
          type: 'string',
          description: `Generation mode: ${VIDEO_MODES.join(', ')}. Default text.`,
        },
        seconds: {
          type: 'string',
          description: 'Clip duration as a string from "4" to "12". Default "5".',
        },
        size: {
          type: 'string',
          description: `Resolution tier. The Flash model accepts only ${FLASH_VIDEO_SIZES.join(', ')}.`,
        },
        aspectRatio: {
          type: 'string',
          description: `Frame aspect ratio: ${VIDEO_RATIOS.join(', ')}. Default 16:9.`,
        },
        seed: {
          type: 'number',
          description: 'Random seed; reuse the same seed to make a result more reproducible.',
        },
        firstFrame: {
          type: 'string',
          description: 'keyframe mode: first-frame image URL. At least one of firstFrame/lastFrame is required.',
        },
        lastFrame: {
          type: 'string',
          description: 'keyframe mode: last-frame image URL. At least one of firstFrame/lastFrame is required.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: `reference mode: reference image URLs, at most ${FLASH_MAX_REFERENCE_IMAGES} for the Flash model.`,
        },
        audios: {
          type: 'array',
          items: { type: 'string' },
          description: 'reference mode: reference audio URLs, used to drive rhythm and audio-visual consistency.',
        },
        wait: {
          type: 'boolean',
          description:
            'Poll until the task finishes (default true). Set false to return the videoId immediately.',
        },
        download: {
          type: 'boolean',
          description: 'Download the finished video into the workspace (default true).',
        },
        saveDir: {
          type: 'string',
          description: 'Directory for the downloaded video; relative paths resolve against the workspace root.',
        },
        fileName: {
          type: 'string',
          description: 'Optional file name (without extension) for the downloaded video.',
        },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const prompt = requireString(args.prompt, 'prompt')
        const mode = optionalString(args.mode) ?? 'text'
        assertOneOf(mode, VIDEO_MODES, 'mode')

        const seconds = optionalString(args.seconds) ?? '5'
        const size = optionalString(args.size)
        const aspectRatio = optionalString(args.aspectRatio)
        assertOneOf(size, VIDEO_SIZES, 'size')
        assertOneOf(aspectRatio, VIDEO_RATIOS, 'aspectRatio')

        const firstFrame = optionalString(args.firstFrame)
        const lastFrame = optionalString(args.lastFrame)
        const images = stringList(args.images)
        const audios = stringList(args.audios)

        // Enforce the documented per-mode media rules locally, so a mistake costs
        // no quota and the message names the exact field at fault.
        if (mode === 'text') {
          const offending = [
            firstFrame === undefined ? undefined : 'firstFrame',
            lastFrame === undefined ? undefined : 'lastFrame',
            images.length > 0 ? 'images' : undefined,
            audios.length > 0 ? 'audios' : undefined,
          ].filter(Boolean)
          if (offending.length > 0) {
            throw fail(`mode "text" accepts no reference media, but received ${offending.join(', ')}`)
          }
        } else if (mode === 'keyframe') {
          if (firstFrame === undefined && lastFrame === undefined) {
            throw fail('mode "keyframe" requires at least one of firstFrame or lastFrame')
          }
          const offending = [
            images.length > 0 ? 'images' : undefined,
            audios.length > 0 ? 'audios' : undefined,
          ].filter(Boolean)
          if (offending.length > 0) {
            throw fail(`mode "keyframe" does not accept ${offending.join(', ')}; use mode "reference"`)
          }
        } else if (mode === 'reference') {
          if (images.length === 0 && audios.length === 0) {
            throw fail('mode "reference" requires at least one non-empty images or audios array')
          }
          const offending = [
            firstFrame === undefined ? undefined : 'firstFrame',
            lastFrame === undefined ? undefined : 'lastFrame',
          ].filter(Boolean)
          if (offending.length > 0) {
            throw fail(`mode "reference" does not accept ${offending.join(', ')}; use mode "keyframe"`)
          }
          if (images.length > FLASH_MAX_REFERENCE_IMAGES) {
            throw fail(
              `the Flash video model accepts at most ${FLASH_MAX_REFERENCE_IMAGES} reference images (received ${images.length})`,
            )
          }
        }

        const body = { model: videoModel, prompt, mode, seconds }
        if (size !== undefined) body.size = size
        if (aspectRatio !== undefined) body.aspect_ratio = aspectRatio
        if (typeof args.seed === 'number') body.seed = args.seed
        if (firstFrame !== undefined) body.first_frame = firstFrame
        if (lastFrame !== undefined) body.last_frame = lastFrame
        if (images.length > 0) body.images = images
        if (audios.length > 0) body.audios = audios

        let created
        try {
          created = await agnesRequest(ctx, config, 'POST', '/v1/videos', body, exec?.signal)
        } catch (error) {
          // Two capacity failures are worth explaining: both are transient and
          // both look like a plugin bug to anyone reading the raw status code.
          if (error?.code === 'video_queue_full' || error?.status === 503) {
            const busy = fail(
              `the Agnes video queue is full right now (${error.message}). Wait a minute and call agnes_video_generate again; the request was not queued.`,
            )
            busy.code = error?.code
            busy.status = error?.status
            throw busy
          }
          if (error?.code === 'rate_limit_exceeded' || error?.status === 429) {
            const limited = fail(
              `the Agnes account is rate limited (${error.message}). Free accounts allow about 1 video request per minute, so wait roughly a minute before retrying.`,
            )
            limited.code = error?.code
            limited.status = error?.status
            throw limited
          }
          throw error
        }

        const videoId = created?.video_id ?? created?.id
        if (optionalString(videoId) === undefined) {
          throw fail(`create response carried no video_id: ${JSON.stringify(created).slice(0, 300)}`)
        }

        const options = videoOptions(args, true)
        const base = {
          videoId,
          taskId: created?.task_id,
          mode,
          seconds,
          size: size ?? created?.size,
          aspectRatio: aspectRatio ?? created?.aspect_ratio,
          model: created?.model ?? videoModel,
          prompt,
        }

        if (!options.wait) {
          return prune({
            ...base,
            status: taskStatus(created),
            progress: taskProgress(created),
            url: extractVideoUrl(created),
            saved: false,
            hint: 'Call agnes_video_status with this videoId to collect the result.',
          })
        }

        const task = await pollVideo(ctx, config, videoId, {
          wait: true,
          signal: exec?.signal,
        })
        const collected = await collectVideo(ctx, config, task, options, exec)
        return prune({ ...base, ...collected })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'agnes_video_status',
      description:
        'Check an Agnes video task by videoId, optionally waiting for it to finish and downloading the result. Use this to collect a task created earlier, or one whose generation wait timed out.',
      parameters: {
        videoId: {
          type: 'string',
          required: true,
          description: 'The video_id returned when the task was created.',
        },
        wait: {
          type: 'boolean',
          description: 'Poll until the task finishes (default false; one status check).',
        },
        download: {
          type: 'boolean',
          description: 'Download the video once it is ready (default true).',
        },
        saveDir: {
          type: 'string',
          description: 'Directory for the downloaded video; relative paths resolve against the workspace root.',
        },
        fileName: {
          type: 'string',
          description: 'Optional file name (without extension) for the downloaded video.',
        },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const videoId = requireString(args.videoId, 'videoId')
        const options = videoOptions(args, false)

        const task = await pollVideo(ctx, config, videoId, {
          wait: options.wait,
          signal: exec?.signal,
        })

        if (!TASK_DONE.has(task.status)) {
          return prune({
            videoId,
            taskId: task.body?.task_id,
            status: task.status,
            progress: task.progress,
            seconds: task.body?.seconds,
            size: task.body?.size,
            model: task.body?.model,
            saved: false,
          })
        }

        const collected = await collectVideo(ctx, config, task, options, exec)
        return prune({ videoId, ...collected })
      },
    }),
  )
}
