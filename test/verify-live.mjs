/**
 * End-to-end verification for `dsh-plugin-agnes-media`.
 *
 * Loads the plugin's real source, supplies the three DSH peer packages as
 * minimal stubs, and drives every tool against the live Agnes AI API. This
 * checks the actual request bodies, response parsing, file writes and local
 * mode validation without installing anything into a DSH profile.
 *
 * The stubs live in a scratch directory outside the workspace on purpose: a
 * `node_modules/@deepseek-ai/*` under the plugin's own tree would shadow the
 * host-provided packages once the plugin is linked into a profile.
 *
 * Usage:
 *   node verify-live.mjs                 # everything
 *   node verify-live.mjs --only=image    # status + image tools
 *   node verify-live.mjs --only=video    # video tools, with long retries
 */
import { statSync } from 'node:fs'

import { loadPlugin } from './harness.mjs'

const only = process.argv.find((arg) => arg.startsWith('--only='))?.split('=')[1]
const runMedia = only === undefined || only === 'all' || only === 'image'
const runVideo = only === undefined || only === 'all' || only === 'video'

const results = []
const record = (name, status, detail) => {
  results.push({ name, status, detail })
  console.log(`[${status}] ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const { module, tools, exec, call } = await loadPlugin()

console.log(`plugin name=${module.name} tools=${[...tools.keys()].join(', ')}\n`)

let imageUrl

if (runMedia) {
  // 1. Status and credential resolution.
  try {
    const status = await call('agnes_media_status', { ping: true })
    const ok = status.keyPresent && status.ping?.ok === true
    record(
      'agnes_media_status',
      ok ? 'PASS' : 'FAIL',
      `keySource=${status.keySource} imageModelAvailable=${status.ping?.imageModelAvailable} videoModelAvailable=${status.ping?.videoModelAvailable}`,
    )
  } catch (error) {
    record('agnes_media_status', 'FAIL', error.message)
  }

  // 2. Text-to-image saved into the workspace.
  try {
    const image = await call('agnes_image_generate', {
      prompt: 'A minimalist studio photo of a single blue ceramic cup on a light grey surface',
      size: '1K',
      ratio: '1:1',
      output: 'file',
      fileName: 'verify-t2i',
    })
    const bytes = statSync(image.path).size
    imageUrl = image.url
    record(
      'agnes_image_generate (text-to-image -> file)',
      bytes > 1000 && image.mode === 'text-to-image' ? 'PASS' : 'FAIL',
      `path=${image.path} bytes=${bytes} mime=${image.mimeType}`,
    )
  } catch (error) {
    record('agnes_image_generate (text-to-image -> file)', 'FAIL', error.message)
  }

  // 3. URL-only output, which must not touch the filesystem.
  try {
    const image = await call('agnes_image_generate', {
      prompt: 'A single yellow dandelion on a black background, macro photography',
      size: '1K',
      output: 'url',
    })
    imageUrl = image.url ?? imageUrl
    record(
      'agnes_image_generate (output=url)',
      typeof image.url === 'string' && image.path === undefined ? 'PASS' : 'FAIL',
      `url=${String(image.url).slice(0, 70)}...`,
    )
  } catch (error) {
    record('agnes_image_generate (output=url)', 'FAIL', error.message)
  }

  // 4. Base64 output through the text-to-image `return_base64` switch.
  try {
    const image = await call('agnes_image_generate', {
      prompt: 'A tiny green sprout in dark soil, soft window light',
      size: '1K',
      output: 'base64',
    })
    record(
      'agnes_image_generate (output=base64)',
      typeof image.base64 === 'string' && image.base64.length > 1000 ? 'PASS' : 'FAIL',
      `base64Length=${String(image.base64).length}`,
    )
  } catch (error) {
    record('agnes_image_generate (output=base64)', 'FAIL', error.message)
  }

  // 5. Image-to-image, reusing a generated URL as the reference image.
  if (imageUrl !== undefined) {
    try {
      const image = await call('agnes_image_generate', {
        prompt: 'Recolour the background to deep navy while keeping the subject unchanged',
        size: '1K',
        images: [imageUrl],
        output: 'file',
        fileName: 'verify-i2i',
      })
      record(
        'agnes_image_generate (image-to-image)',
        image.mode === 'image-to-image' && statSync(image.path).size > 1000 ? 'PASS' : 'FAIL',
        `mode=${image.mode} path=${image.path}`,
      )
    } catch (error) {
      record('agnes_image_generate (image-to-image)', 'FAIL', error.message)
    }
  } else {
    record('agnes_image_generate (image-to-image)', 'SKIP', 'no reference URL available')
  }

  // 6. Local mode validation must reject illegal media before spending quota.
  try {
    await call('agnes_video_generate', {
      prompt: 'should not run',
      mode: 'text',
      firstFrame: 'https://example.com/frame.png',
    })
    record('agnes_video_generate (mode validation)', 'FAIL', 'illegal firstFrame in text mode was accepted')
  } catch (error) {
    const ok = /mode "text" accepts no reference media/.test(error.message)
    record('agnes_video_generate (mode validation)', ok ? 'PASS' : 'FAIL', error.message)
  }
}

if (runVideo) {
  // 7. Video task creation, polling and download.
  //
  // The Agnes video tier is capacity- and rate-limited (free accounts get about
  // one request per minute, and the queue returns 503 when it is saturated), so
  // this step retries on those two conditions instead of failing outright.
  const attempts = Number(process.env.VERIFY_VIDEO_ATTEMPTS ?? 8)
  const backoffMs = Number(process.env.VERIFY_VIDEO_BACKOFF_MS ?? 65000)
  let settled = false

  for (let attempt = 1; attempt <= attempts && !settled; attempt += 1) {
    try {
      const video = await call('agnes_video_generate', {
        prompt: 'A calm ocean wave rolling onto a sandy beach at sunset, cinematic, slow motion',
        mode: 'text',
        seconds: '4',
        size: '720P',
        aspectRatio: '16:9',
        wait: true,
        fileName: 'verify-video',
      })
      const ok = video.status === 'completed' && video.saved === true && statSync(video.path).size > 1000
      record(
        'agnes_video_generate (create -> wait -> download)',
        ok ? 'PASS' : 'FAIL',
        `videoId=${video.videoId} taskId=${video.taskId} status=${video.status} bytes=${video.bytes} path=${video.path}`,
      )
      settled = true
    } catch (error) {
      const transient =
        error.code === 'video_queue_full' ||
        error.code === 'rate_limit_exceeded' ||
        error.status === 503 ||
        error.status === 429
      if (transient && attempt < attempts) {
        console.log(
          `[retry] attempt ${attempt}/${attempts} hit ${error.code ?? error.status}; waiting ${Math.round(backoffMs / 1000)}s`,
        )
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
        continue
      }
      record(
        'agnes_video_generate (create -> wait -> download)',
        transient ? 'BLOCKED' : 'FAIL',
        `${error.code ?? error.status ?? ''} ${error.message}`.trim(),
      )
      settled = true
    }
  }
}

const failed = results.filter((entry) => entry.status === 'FAIL').length
const blocked = results.filter((entry) => entry.status === 'BLOCKED').length
console.log(
  `\n${results.length - failed - blocked}/${results.length} passed` +
    (blocked > 0 ? `, ${blocked} blocked by server-side limits` : ''),
)
process.exit(failed === 0 ? 0 : 1)
