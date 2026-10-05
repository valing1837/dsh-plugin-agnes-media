/**
 * Deterministic verification of the video code path.
 *
 * The live API cannot currently demonstrate a finished video task: Agnes'
 * video queue has answered `503 video_queue_full` continuously, so
 * `agnes_video_generate` never reaches the polling and download branches
 * against the real service. This test covers exactly those branches by
 * replacing `fetch` with a scripted transport, which also makes the assertions
 * precise instead of dependent on whatever the service returns today.
 *
 * Covered:
 *   - the create request body (mode, seconds, size, aspect_ratio, no media)
 *   - queued -> in_progress -> completed status transitions
 *   - `video_id` + `model_name` in the polling URL
 *   - the finished video URL taken from `metadata.url`
 *   - the download branch writing the clip to disk with the right extension
 *   - a failed task surfacing the vendor's error text
 *   - `wait: false` returning immediately without polling
 *   - the queue-full and rate-limit hints
 *   - the poll budget expiring while a task is still running
 *
 * Usage: node video-mock.mjs
 */
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadPlugin, makeRecorder } from './harness.mjs'

const record = makeRecorder()

/** A JSON response with the gateway's content type. */
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * Install a scripted transport.
 *
 * @param handler - (url, init) => Response; throws on an unexpected request.
 * @returns the recorded request log.
 */
function scriptFetch(handler) {
  const log = []
  globalThis.fetch = async (url, init = {}) => {
    log.push({ url: String(url), method: init.method ?? 'GET', body: init.body })
    return handler(String(url), init)
  }
  return log
}

/** The request body the plugin sent, parsed. */
const bodyOf = (entry) => (entry?.body === undefined ? undefined : JSON.parse(entry.body))

// ---------------------------------------------------------------------------
// A. Happy path: create -> queued -> in_progress -> completed -> download.
// ---------------------------------------------------------------------------
{
  const { call, workspace, fallbackRoot } = await loadPlugin({
    root: mkdtempSync(join(tmpdir(), 'agnes-mock-a-')),
    config: { apiKey: 'test-key' },
  })

  let polls = 0
  const log = scriptFetch((url, init) => {
    if (url.endsWith('/v1/videos') && (init.method ?? 'GET') === 'POST') {
      return json(200, {
        id: 'task_1',
        video_id: 'vid_abc',
        task_id: 'task_1',
        object: 'video',
        model: 'agnes-video-2.5-flash',
        status: 'queued',
        progress: 0,
        seconds: '4',
      })
    }
    if (url.includes('/agnesapi?')) {
      polls += 1
      if (polls === 1) return json(200, { video_id: 'vid_abc', status: 'in_progress', progress: 40 })
      return json(200, {
        video_id: 'vid_abc',
        status: 'completed',
        progress: 100,
        seconds: '4',
        size: '720P',
        metadata: { url: 'https://cdn.example.com/out.mp4' },
      })
    }
    if (url === 'https://cdn.example.com/out.mp4') {
      return new Response(new Uint8Array(2048), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  })

  try {
    const video = await call(
      'agnes_video_generate',
      {
        prompt: 'a calm ocean wave at sunset',
        mode: 'text',
        seconds: '4',
        size: '720P',
        aspectRatio: '16:9',
        wait: true,
        fileName: 'mock-video',
      },
    )

    const create = log.find((entry) => entry.method === 'POST')
    const createBody = bodyOf(create)
    record(
      'create body',
      createBody?.model === 'agnes-video-2.5-flash' &&
        createBody?.mode === 'text' &&
        createBody?.seconds === '4' &&
        createBody?.size === '720P' &&
        createBody?.aspect_ratio === '16:9' &&
        createBody?.first_frame === undefined &&
        createBody?.images === undefined,
      JSON.stringify(createBody),
    )

    const pollEntry = log.find((entry) => entry.url.includes('/agnesapi?'))
    record(
      'poll URL carries video_id and model_name',
      pollEntry?.url.includes('video_id=vid_abc') &&
        pollEntry?.url.includes('model_name=agnes-video-2.5-flash'),
      pollEntry?.url,
    )

    record('status transitions observed', polls === 2, `${polls} polls`)
    record('final status completed', video.status === 'completed', video.status)
    record('url taken from metadata.url', video.url === 'https://cdn.example.com/out.mp4', video.url)
    record('saved flag set', video.saved === true, String(video.saved))
    record('extension from content type', video.path?.endsWith('.mp4') === true, video.path)
    record(
      'bytes written to disk',
      video.path !== undefined && statSync(video.path).size === 2048,
      `${video.bytes} bytes under ${workspace}`,
    )
    // Regression guard: a relative outputDir must resolve against the SESSION
    // workspace, never the deployment fallback root (which is what sent
    // generated media into the profile directory).
    record(
      'output lands in the session workspace, not the fallback root',
      video.path?.startsWith(workspace) === true && video.path?.startsWith(fallbackRoot) !== true,
      video.path,
    )
  } catch (error) {
    record('happy path', false, error.message)
  }
}

// ---------------------------------------------------------------------------
// B. A failed task must surface the vendor's error text.
// ---------------------------------------------------------------------------
{
  const { call } = await loadPlugin({
    root: mkdtempSync(join(tmpdir(), 'agnes-mock-b-')),
    config: { apiKey: 'test-key', pollIntervalMs: 250 },
  })

  scriptFetch((url, init) => {
    if ((init.method ?? 'GET') === 'POST') return json(200, { video_id: 'vid_fail', status: 'queued' })
    return json(200, {
      video_id: 'vid_fail',
      status: 'failed',
      error: { message: 'content policy violation' },
    })
  })

  try {
    await call('agnes_video_generate', { prompt: 'x', mode: 'text', wait: true })
    record('failed task rejected', false, 'no error thrown')
  } catch (error) {
    record(
      'failed task rejected',
      /failed: content policy violation/.test(error.message),
      error.message,
    )
  }
}

// ---------------------------------------------------------------------------
// C. wait: false must return the id without polling.
// ---------------------------------------------------------------------------
{
  const { call } = await loadPlugin({
    root: mkdtempSync(join(tmpdir(), 'agnes-mock-c-')),
    config: { apiKey: 'test-key' },
  })

  const log = scriptFetch(() => json(200, { video_id: 'vid_async', task_id: 'task_async', status: 'queued' }))

  try {
    const video = await call('agnes_video_generate', { prompt: 'x', mode: 'text', wait: false })
    record(
      'wait:false returns the task id',
      video.videoId === 'vid_async' && video.status === 'queued' && log.length === 1,
      `${log.length} request(s), videoId=${video.videoId}`,
    )
  } catch (error) {
    record('wait:false returns the task id', false, error.message)
  }
}

// ---------------------------------------------------------------------------
// D. agnes_video_status must poll a task created earlier.
// ---------------------------------------------------------------------------
{
  const { call } = await loadPlugin({
    root: mkdtempSync(join(tmpdir(), 'agnes-mock-d-')),
    config: { apiKey: 'test-key' },
  })

  scriptFetch((url) => {
    if (url.includes('/agnesapi?')) {
      return json(200, {
        video_id: 'vid_old',
        status: 'completed',
        seconds: '5',
        metadata: { url: 'https://cdn.example.com/old.mp4' },
      })
    }
    return new Response(new Uint8Array(1024), {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    })
  })

  try {
    const video = await call('agnes_video_status', { videoId: 'vid_old', download: true })
    record(
      'agnes_video_status collects a finished task',
      video.status === 'completed' && video.saved === true && video.videoId === 'vid_old',
      video.path,
    )
  } catch (error) {
    record('agnes_video_status collects a finished task', false, error.message)
  }
}

// ---------------------------------------------------------------------------
// E. Queue-full and rate-limit hints.
// ---------------------------------------------------------------------------
{
  const { call } = await loadPlugin({
    root: mkdtempSync(join(tmpdir(), 'agnes-mock-e-')),
    config: { apiKey: 'test-key' },
  })

  scriptFetch(() => json(503, { code: 'video_queue_full', message: 'video queue is full', data: null }))
  try {
    await call('agnes_video_generate', { prompt: 'x', mode: 'text', wait: false })
    record('queue-full hint', false, 'no error thrown')
  } catch (error) {
    record('queue-full hint', /queue is full right now/.test(error.message), error.message.slice(0, 90))
  }

  // The gateway nests rate-limit failures under `error` instead of flattening them.
  scriptFetch(() =>
    json(429, {
      error: { message: 'You have reached the API rate limit for free users.', code: 'rate_limit_exceeded' },
    }),
  )
  try {
    await call('agnes_video_generate', { prompt: 'x', mode: 'text', wait: false })
    record('rate-limit hint (nested error envelope)', false, 'no error thrown')
  } catch (error) {
    record(
      'rate-limit hint (nested error envelope)',
      /rate limited/.test(error.message) && /1 video request per minute/.test(error.message),
      error.message.slice(0, 90),
    )
  }
}

// ---------------------------------------------------------------------------
// F. The poll budget must expire without hanging.
// ---------------------------------------------------------------------------
{
  const { call } = await loadPlugin({
    root: mkdtempSync(join(tmpdir(), 'agnes-mock-f-')),
    config: { apiKey: 'test-key', pollIntervalMs: 250, pollTimeoutMs: 1200 },
  })

  let polls = 0
  scriptFetch((url, init) => {
    if ((init.method ?? 'GET') === 'POST') return json(200, { video_id: 'vid_slow', status: 'queued' })
    polls += 1
    return json(200, { video_id: 'vid_slow', status: 'in_progress', progress: 10 })
  })

  try {
    await call('agnes_video_generate', { prompt: 'x', mode: 'text', wait: true })
    record('poll budget expires', false, 'no error thrown')
  } catch (error) {
    record(
      'poll budget expires',
      /still in_progress after/.test(error.message) && /agnes_video_status/.test(error.message),
      `${polls} polls then: ${error.message.slice(0, 80)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// G. The documented `wait` defaults: generate waits, status does one check.
// ---------------------------------------------------------------------------
{
  const { call } = await loadPlugin({
    root: mkdtempSync(join(tmpdir(), 'agnes-mock-g-')),
    config: { apiKey: 'test-key' },
  })

  let polls = 0
  scriptFetch((url, init) => {
    if ((init.method ?? 'GET') === 'POST') {
      return json(200, { video_id: 'vid_default', status: 'queued' })
    }
    polls += 1
    return json(200, {
      video_id: 'vid_default',
      status: 'completed',
      metadata: { url: 'https://cdn.example.com/default.mp4' },
    })
  })

  try {
    // `wait` omitted; `download: false` so no media fetch is needed.
    const video = await call('agnes_video_generate', { prompt: 'x', mode: 'text', download: false })
    record(
      'agnes_video_generate defaults to waiting',
      polls === 1 && video.status === 'completed',
      `${polls} poll(s), status=${video.status}`,
    )
  } catch (error) {
    record('agnes_video_generate defaults to waiting', false, error.message)
  }

  let statusPolls = 0
  scriptFetch(() => {
    statusPolls += 1
    return json(200, { video_id: 'vid_check', status: 'in_progress', progress: 30 })
  })

  try {
    const check = await call('agnes_video_status', { videoId: 'vid_check' })
    record(
      'agnes_video_status defaults to a single check',
      statusPolls === 1 && check.status === 'in_progress',
      `${statusPolls} request(s), status=${check.status}`,
    )
  } catch (error) {
    record('agnes_video_status defaults to a single check', false, error.message)
  }
}

const failed = record.results.filter((entry) => entry.status === 'FAIL').length
console.log(`\n${record.results.length - failed}/${record.results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
