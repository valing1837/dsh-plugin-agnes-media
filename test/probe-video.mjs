/**
 * Live probe of the Agnes video task lifecycle.
 *
 * Creates a text-to-video task, then polls the documented query endpoint until
 * the task settles, printing every distinct status transition so the exact
 * field names (progress, metadata.url, ...) are observed rather than assumed.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.AGNES_BASE_URL ?? 'https://apihub.agnes-ai.com'
const VIDEO_MODEL = 'agnes-video-2.5-flash'
const POLL_MS = 2000
const MAX_POLLS = 90

function readKey(name) {
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

const KEY = readKey('AGNES_API_KEY')
const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }

const request = {
  model: VIDEO_MODEL,
  prompt: 'A calm ocean wave rolling onto a sandy beach at sunset, cinematic',
  mode: 'text',
  seconds: '4',
  size: '720P',
  aspect_ratio: '16:9',
}

// The video queue returns 503 `video_queue_full` under load; retry with backoff
// so the probe observes a real task rather than a transient capacity error.
let payload
for (let attempt = 0; attempt < 12; attempt += 1) {
  const created = await fetch(`${BASE}/v1/videos`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(request),
  })
  const createdText = await created.text()
  console.log(`POST /v1/videos -> HTTP ${created.status} (attempt ${attempt + 1})`)
  if (created.ok) {
    console.log(createdText.slice(0, 1200))
    payload = JSON.parse(createdText)
    break
  }
  console.log(createdText.slice(0, 300))
  if (!/queue_full/.test(createdText)) break
  await new Promise((resolve) => setTimeout(resolve, 15000))
}
if (!payload) process.exit(1)
const videoId = payload.video_id ?? payload.id
if (!videoId) {
  console.error('no video_id in create response')
  process.exit(1)
}

const query = `${BASE}/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(VIDEO_MODEL)}`
console.log(`\nquerying: ${query}\n`)

let lastStatus
for (let i = 0; i < MAX_POLLS; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  const response = await fetch(query, { headers: { authorization: `Bearer ${KEY}` } })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    console.log(`poll ${i}: HTTP ${response.status} non-JSON ${text.slice(0, 200)}`)
    continue
  }
  const status = body.status ?? body.data?.status
  if (status !== lastStatus) {
    console.log(`poll ${i}: status=${status} progress=${body.progress ?? body.data?.progress}`)
    lastStatus = status
  }
  if (status === 'completed' || status === 'failed' || status === 'success') {
    console.log('\n=== final payload ===')
    console.log(JSON.stringify(body, null, 2).slice(0, 3000))
    break
  }
}
