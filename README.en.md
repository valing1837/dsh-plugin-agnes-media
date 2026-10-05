# dsh-plugin-agnes-media

[中文](README.md) | **English**

Agnes AI image and video generation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh),
exposed to the agent as four host-side tools.

- **Image** — `agnes-image-2.5-flash`: text-to-image, image-to-image, multi-image composition
- **Video** — `agnes-video-2.5-flash`: text-to-video, first/last-frame control, multimodal reference (async task + polling)

Generated media is downloaded into the **calling session's workspace** by default, so the agent can present the
actual file instead of handing back a remote URL.

<p align="center">
  <img src="docs/example.jpg" alt="Example output: an anime-style DeepSeek character" width="420">
  <br>
  <em>Example output: an anime-style DeepSeek character generated with <code>agnes_image_generate</code> (2K, 3:4)</em>
</p>

## Requirements

| | |
| --- | --- |
| dsh | `>= 0.2.0-rc.2` (peer dependencies resolve to the profile's shared closure) |
| Node | `^22.19.0 \|\| >= 24.0.0` |
| Credential | an Agnes API key stored as `AGNES_API_KEY` in the DSH credentials domain (see [Configure](#configure)) |

## Tools

| Tool | Purpose |
| --- | --- |
| `agnes_image_generate` | Generate or edit an image. `output=file` (default) writes it into the workspace, `url` returns the link only, `base64` returns the raw payload |
| `agnes_video_generate` | Create a video task; waits for completion and downloads the clip by default |
| `agnes_video_status` | Query a task by `videoId`, optionally waiting and downloading (for collecting a task that timed out) |
| `agnes_media_status` | Report configuration and credential source; `ping: true` validates the key against `/v1/models` |

### `agnes_image_generate`

| Parameter | Description |
| --- | --- |
| `prompt` | Required. Generation or edit instruction |
| `size` | Tier `1K` / `2K` / `3K` / `4K`, or an exact `1024x768`. Default `2K` |
| `ratio` | Aspect ratio used with a tier size: `1:1` `3:4` `4:3` `16:9` `9:16` `2:3` `3:2` `21:9`. Default `1:1` |
| `images` | Reference images (public HTTPS URL or data URI). Supplying these switches to image-to-image / multi-image composition |
| `output` | `file` (default) / `url` / `base64` |
| `saveDir` / `fileName` | Where to write, and what to call it. A relative `saveDir` resolves against the session workspace |

### `agnes_video_generate`

| Parameter | Description |
| --- | --- |
| `prompt` | Required. Video description |
| `mode` | `text` / `keyframe` / `reference`. Default `text` |
| `seconds` | String `"4"`–`"12"`. Default `"5"` |
| `size` | The Flash model accepts only `720P` |
| `aspectRatio` | `21:9` `16:9` `4:3` `1:1` `3:4` `9:16`. Default `16:9` |
| `seed` | Random seed |
| `firstFrame` / `lastFrame` | For `keyframe` mode; supply at least one |
| `images` / `audios` | For `reference` mode; supply at least one. Flash allows at most 5 reference images |
| `wait` / `download` | Whether to wait for completion and download (both default to true) |

The per-mode media rules are enforced **locally** (`text` rejects any reference media, `keyframe` rejects
`images`/`audios`, `reference` rejects the frame fields), so a malformed call costs no quota.

## Install

```sh
node scripts/install.mjs
```

The script stages the source into `~/.dsh/profiles/desktop/plugins/dsh-plugin-agnes-media` and then runs
`dsh plugin add link:<that path>`, which declares it as a real dependency. **Restart dsh afterwards.**

Uninstall: `node scripts/install.mjs --remove`.

### Two invariants, and why both matter

**1. It must be a declared dependency.** The plugin manager computes:

```js
const installed = dependencies.includes(name);
const removable = installed && !ownedByInstallation(name);
```

A bundle row that is not also listed in `dependencies` is reported as `installed: false, removable: false` —
the Plugins page then offers **no enable/disable or uninstall control**, and `reconcile()` silently drops the
row on the next `dsh plugin` operation. A plugin the user cannot see or switch off is not really installed.

**2. The resolved real path must stay inside the profile.** The plugin's `@deepseek-ai/*` peer imports are only
reachable from there:

- `@deepseek-ai/schemastery` lives in the profile's own `node_modules`
- `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-credentials` are served from the application closure in `app.asar`

So a `link:` pointing **outside** the profile (say, a checkout on the Desktop) always fails: the real path lands
outside, the peers no longer resolve, and the loader reports only an opaque `failed to import`. Staging the
source under `<profile>/plugins/` and linking to it satisfies both invariants at once — the junction resolves
back inside the profile, and the package is a genuine dependency.

> `@deepseek-ai/*` must stay in **peerDependencies**. They have to resolve to the profile's single shared dsh
> closure; listing them under `dependencies` installs a second cordis instance and crashes the loader.

### A restart is required

Node caches module resolution per `(specifier, parentURL)`, and a running host keeps using the old answer. After
a restart the row moves from `fiberPhase: null` to `active`, and `installed` / `removable` both become `true`.

### Turning it off

Any of:

1. Toggle it on the Plugins page — it is `removable: true`, so the control is there.
2. Add a row to the profile's `cordis.patch.yml` (the same way `web-ui-pet` is disabled):
   ```yaml
   - id: agnes-media
     disabled: true
   ```
3. Uninstall entirely: `node scripts/install.mjs --remove`, then restart.

## Configure

Zero configuration is enough by default: the key is resolved from the DSH credential ref named `AGNES_API_KEY`.
To override anything, patch the row by id in the profile's `cordis.patch.yml`:

```yaml
- id: agnes-media
  config:
    baseUrl: https://apihub.agnes-ai.cn   # China site
    imageModel: agnes-image-2.5-flash
    videoModel: agnes-video-2.5-flash
    outputDir: agnes-media
    pollIntervalMs: 2000
    pollTimeoutMs: 900000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyRef` | `AGNES_API_KEY` | Credential ref (`refs:` in `~/.dsh/.credentials.yaml`) |
| `apiKey` | — | Literal key (`role('secret')`); prefer `apiKeyRef` |
| `baseUrl` | `https://apihub.agnes-ai.com` | API root |
| `imageModel` / `videoModel` | `agnes-image-2.5-flash` / `agnes-video-2.5-flash` | Model ids |
| `outputDir` | `agnes-media` | Output directory; a relative path resolves against the session workspace |
| `requestTimeoutMs` | `300000` | Per-request timeout for generation and downloads |
| `pollIntervalMs` | `2000` | Poll interval; the vendor suggests 1–2 s |
| `pollTimeoutMs` | `900000` | How long to wait on a video task before handing back the task id |

## API contracts implemented

**Image** — `POST {base}/v1/images/generations`

`model`, `prompt` and `size` are required. `response_format` must sit inside `extra_body`, never at the top
level of the body; base64 for text-to-image uses the top-level `return_base64: true`, while image-to-image uses
`extra_body.response_format: "b64_json"`. The response looks like:

```json
{ "data": [ { "url": "...", "b64_json": "", "revised_prompt": "" } ], "created": 1791169692, "task_id": "task_..." }
```

**Video** — `POST {base}/v1/videos`, then `GET {base}/agnesapi?video_id=<id>&model_name=agnes-video-2.5-flash`

Results are polled by `video_id` (not `task_id`) with `model_name` attached. Status is one of `queued` /
`in_progress` / `completed` / `failed`, and the finished clip URL arrives in the task metadata.

## Known server-side behaviour

The plugin turns two transient failures into explicit messages instead of leaking a bare status code:

- `503 video_queue_full` — the video queue is saturated; the request was not accepted, retry shortly
- `429 rate_limit_exceeded` — free accounts get roughly **1 video request per minute**

The gateway reports errors in two shapes and both are parsed: `{ code, message }` and `{ error: { code, message } }`.

## Verification

```sh
node test/video-mock.mjs        # deterministic, no network or credential needed
node test/verify-live.mjs       # hits the real API; needs AGNES_API_KEY
node scripts/doctor.mjs         # audits the installed profile (read-only)
```

`test/video-mock.mjs` replaces `fetch` with a scripted transport, so the video code path is covered precisely
rather than depending on what the service returns today. It checks the create body, the `video_id` +
`model_name` poll URL, `queued → in_progress → completed` transitions, the clip URL taken from `metadata.url`,
the download branch and its file extension, failed-task error text, `wait: false` returning without polling,
the documented `wait` defaults, both capacity-error hints, the poll budget expiring without hanging, and that
output lands in the **session workspace** rather than the deployment fallback root.

`test/verify-live.mjs` exercises the real API: credential resolution plus `ping`, text-to-image to a file
(~850 KB PNG), `output=url`, `output=base64`, image-to-image, and the local video-mode validation.

> **Honest gap:** Agnes' video queue returned `503 video_queue_full` continuously across a multi-hour window, so
> no complete `completed` was ever observed against the live service. The polling and download branches are
> covered by the deterministic test above; what is unverified is the service finishing a task, not the plugin.

## Design notes

**No client half.** A dsh 0.2.x client bundle must self-register through `window.__ModuleLoader__.load({...})`,
and shipping plain ESM there is a hard boot failure. This plugin only registers host-side tools, so that class
of failure cannot happen; configuration goes through the profile patch layer and the credentials domain instead
of a settings page. It also means configuration stays plain text and reviewable.

**Media lands in the session workspace.** The output directory comes from the calling session
(`exec.agent.session.header.cwd`, matching the built-in filesystem tools); the deployment-level root is only a
fallback for agentless calls.

**No automatic retry on image generation.** Generation is not idempotent — retrying a 5xx could spend quota
twice for one image — so failures are surfaced verbatim and the caller decides.

## License

[MIT](LICENSE)
