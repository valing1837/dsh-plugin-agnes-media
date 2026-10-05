# dsh-plugin-agnes-media

**中文** | [English](README.en.md)

给 DeepSeek Harness (dsh) 接入 **Agnes AI 的图片模型和视频模型**，以四个宿主侧工具的形式暴露给 Agent。

- 图片：`agnes-image-2.5-flash` — 文生图、图生图、多图合成
- 视频：`agnes-video-2.5-flash` — 文生视频、首尾帧控制、多模态参考（异步任务 + 轮询）

生成结果默认**下载到会话工作区**，因此 Agent 可以直接 `present` 给用户看，而不是只拿到一个远端 URL。

<p align="center">
  <img src="docs/example.jpg" alt="用本插件生成的示例图：DeepSeek 二次元形象" width="420">
  <br>
  <em>示例输出：用 <code>agnes_image_generate</code> 生成的 DeepSeek 二次元形象（2K / 3:4）</em>
</p>

## 环境要求

| 项 | 要求 |
| --- | --- |
| dsh | `>= 0.2.0-rc.2`（peer 依赖解析到 profile 的共享闭包） |
| Node | `^22.19.0 \|\| >= 24.0.0` |
| 凭证 | 一个 Agnes API Key，存为 DSH 凭证域里的 `AGNES_API_KEY`（见「配置」） |

## 工具

| 工具 | 作用 |
| --- | --- |
| `agnes_image_generate` | 生成或编辑图片。`output=file`（默认）落盘到工作区，`url` 只返回链接，`base64` 直接返回原始数据 |
| `agnes_video_generate` | 创建视频任务；默认等待完成并下载视频 |
| `agnes_video_status` | 按 `videoId` 查询任务，可选择等待并下载（用于领取超时未取回的任务） |
| `agnes_media_status` | 报告配置与密钥来源；`ping: true` 时调用 `/v1/models` 校验密钥 |

### `agnes_image_generate`

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填。生成或编辑指令 |
| `size` | 档位 `1K` / `2K` / `3K` / `4K`，或精确 `1024x768`。默认 `2K` |
| `ratio` | 配合档位尺寸的画幅：`1:1` `3:4` `4:3` `16:9` `9:16` `2:3` `3:2` `21:9`。默认 `1:1` |
| `images` | 参考图数组（公网 HTTPS URL 或 Data URI）。传入即切换为图生图 / 多图合成 |
| `output` | `file`（默认）/ `url` / `base64` |
| `saveDir` / `fileName` | 落盘位置与文件名；相对路径按工作区根目录解析 |

### `agnes_video_generate`

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填。视频描述 |
| `mode` | `text` / `keyframe` / `reference`，默认 `text` |
| `seconds` | 字符串 `"4"`–`"12"`，默认 `"5"` |
| `size` | Flash 只接受 `720P` |
| `aspectRatio` | `21:9` `16:9` `4:3` `1:1` `3:4` `9:16`，默认 `16:9` |
| `seed` | 随机种子 |
| `firstFrame` / `lastFrame` | `keyframe` 模式使用，至少提供一个 |
| `images` / `audios` | `reference` 模式使用，至少提供一个；Flash 参考图上限 5 张 |
| `wait` / `download` | 是否等待完成、是否下载（默认都开） |

三种模式的素材规则在**本地**就做校验（`text` 不接受任何参考素材、`keyframe` 不接受 `images`/`audios`、`reference` 不接受首尾帧），所以写错参数不会浪费额度。

## 安装

```sh
node scripts/install.mjs
```

脚本做两件事：把源码暂存到 `~/.dsh/profiles/desktop/plugins/dsh-plugin-agnes-media`，再调用 `dsh plugin add link:<该路径>` 让它成为**正式依赖**。装完**必须重启 dsh**。

卸载：`node scripts/install.mjs --remove`。

### 两条必须同时成立的不变量

**① 必须是 `package.json` 里的依赖。** 插件管理器是这样算的：

```js
const installed = dependencies.includes(name);
const removable = installed && !ownedByInstallation(name);
```

只登记 bundle 行、不写进 `dependencies` 的插件会被报成 `installed: false, removable: false`——**插件页不会给它开关和卸载入口**，而且 `reconcile()` 会在下一次 `dsh plugin` 操作时把这一行悄悄丢掉。本机的 `dsh-plugin-github` 就是这种状态。

**② 解析后的真实路径必须留在 profile 内。** 插件的 `@deepseek-ai/*` 对等依赖只有从 profile 里才找得到：

- `@deepseek-ai/schemastery` → profile 自己的 `node_modules`
- `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-credentials` → app.asar 里的应用闭包

所以 `link:` 指向 profile **之外**（比如桌面上的源码目录）必然失败：真实路径跑到 profile 外面，对等依赖解析不到，而 loader 只会给出一句没有下文的 `failed to import`。这正是 `dsh plugin add link:C:\...\Desktop\...` 踩的坑。

把源码放进 `<profile>/plugins/` 再 link，两条同时满足：junction 解析回 profile 内部，同时它又是一个正式依赖。

> `@deepseek-ai/*` 一律声明为 **peerDependencies**：它们必须解析到 profile 里那一份共享的 dsh 闭包，写进 `dependencies` 会装出第二个 cordis 实例并让 loader 崩掉。

### 重启是必需的

Node 按 (specifier, parentURL) 缓存模块解析结果，运行中的 host 会一直沿用旧答案。重启后 `plugin_manager` 里该行会从 `fiberPhase: null` 变成 `active`，bundle 列表里的 `installed` / `removable` 也会变成 `true`。

### 关掉它

三种方式任选：

1. **插件页直接关**——现在是 `removable: true`，页面上有开关。
2. **在 profile 的 `cordis.patch.yml` 加一行**（和关 `web-ui-pet` 完全一样的做法）：
   ```yaml
   - id: agnes-media
     disabled: true
   ```
3. **彻底卸载**：`node scripts/install.mjs --remove`，然后重启。

## 配置

默认零配置即可用：密钥从 DSH 凭证域里名为 `AGNES_API_KEY` 的 ref 解析（本机已存在）。需要覆盖时，在 profile 的 `cordis.patch.yml` 里按行 id 打补丁：

```yaml
- id: agnes-media
  config:
    baseUrl: https://apihub.agnes-ai.cn   # 中国站
    imageModel: agnes-image-2.5-flash
    videoModel: agnes-video-2.5-flash
    outputDir: agnes-media
    pollIntervalMs: 2000
    pollTimeoutMs: 900000
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKeyRef` | `AGNES_API_KEY` | 凭证引用名（`~/.dsh/.credentials.yaml` 的 `refs:`） |
| `apiKey` | — | 直接写死密钥（`role('secret')`），不推荐 |
| `baseUrl` | `https://apihub.agnes-ai.com` | API 根地址 |
| `imageModel` / `videoModel` | `agnes-image-2.5-flash` / `agnes-video-2.5-flash` | 模型 id |
| `outputDir` | `agnes-media` | 落盘目录，相对路径按工作区根解析 |
| `requestTimeoutMs` | `300000` | 生成与下载的单次超时 |
| `pollIntervalMs` | `2000` | 轮询间隔，官方建议 1–2 秒 |
| `pollTimeoutMs` | `900000` | 等待视频任务的上限，超时后仍可用 `agnes_video_status` 取回 |

## 实现的接口契约

**图片** `POST {base}/v1/images/generations`

必填 `model` / `prompt` / `size`。`response_format` 必须放在 `extra_body` 内、不能放请求体顶层；文生图取 Base64 用顶层 `return_base64: true`，图生图取 Base64 用 `extra_body.response_format: "b64_json"`。响应形如：

```json
{ "data": [ { "url": "...", "b64_json": "", "revised_prompt": "" } ], "created": 1791169692, "task_id": "task_..." }
```

**视频** `POST {base}/v1/videos`，再 `GET {base}/agnesapi?video_id=<id>&model_name=agnes-video-2.5-flash`

结果查询用 `video_id`（不是 `task_id`），并带上 `model_name`；状态为 `queued` / `in_progress` / `completed` / `failed`，完成后视频地址在任务元数据里。

## 已知的服务端行为

插件对两类瞬时失败给出了明确提示，而不是抛出裸状态码：

- `503 video_queue_full` — 视频队列满，请求未被受理，稍后重试即可
- `429 rate_limit_exceeded` — 免费账号视频约 **1 请求/分钟**，需要等约一分钟

网关的错误体有两种形态，插件都解析：`{ code, message }` 与 `{ error: { code, message } }`。

## 验证

`test/verify-live.mjs` 会加载插件的真实源码、以最小桩替代三个对等依赖，然后对着线上 API 跑通每个工具：

```sh
node test/verify-live.mjs                # 全部
node test/verify-live.mjs --only=image   # 状态 + 图片
node test/verify-live.mjs --only=video   # 视频（含长重试）
```

`test/video-mock.mjs` 用**脚本化的 fetch** 确定性地验证视频链路（不依赖服务端当天状态），`test/probe-video.mjs` 则是观察真实排队/限流状态的独立探针。

### 已实测通过（真实出图）

- 密钥解析与 `ping`（`keySource=credentials:AGNES_API_KEY`，`imageModelAvailable` / `videoModelAvailable` 均为 true）
- 文生图 → 落盘 PNG（约 830–850 KB）
- `output=url`（不落盘）与 `output=base64`（约 1.4 MB base64）
- 图生图（以生成出的 URL 作为参考图）
- 三种视频模式的本地参数校验

### 视频链路：确定性验证（14/14）

Agnes 的视频队列在测试期间**持续**返回 `503 video_queue_full`（跨多个小时、十余次重试），所以真实服务端跑不出一次完整的 `completed`。轮询与下载这段因此改用脚本化 fetch 验证，覆盖：

- 创建请求体（`mode` / `seconds` / `size` / `aspect_ratio`，且不含任何媒体字段）
- 轮询 URL 带 `video_id` 与 `model_name`
- `queued → in_progress → completed` 状态流转
- 从 `metadata.url` 取出成片地址
- 下载分支落盘、扩展名取自 `content-type`
- 任务失败时透出厂商的错误文本
- `wait: false` 立即返回且**不发起轮询**
- `agnes_video_status` 能领取先前创建的任务
- 队列满与限流两类提示（含网关的嵌套 `error` 错误体）
- 轮询预算耗尽时**不挂死**，并提示改用 `agnes_video_status` 取回

也就是说：视频链路的代码路径已被覆盖，唯一未观测到的是「真实服务端跑完一次」——那是服务端容量问题，不是插件问题。

## 设计说明

**为什么没有前端半区（client half）**：dsh 0.2.x 的客户端 bundle 必须通过 `window.__ModuleLoader__.load({...})` 自注册，直接发普通 ESM 会导致启动失败。本插件只注册宿主侧工具，因此这类故障不可能发生；配置改走 profile 补丁层 + 凭证域，不依赖设置页。这也与仓库里 `dsh-plugin-github` 的做法一致。

**结果默认落盘**：图片和视频默认下载到会话工作区的 `agnes-media/` 目录并返回本地路径，这样 Agent 可以直接把文件呈现给用户，而不是只给一个远端 URL。落盘位置取自调用会话的工作区（`exec.agent.session.header.cwd`，与内置文件工具一致）；没有会话时才退到部署级的兜底根。

**没有前端半区**还带来一个好处：配置不依赖设置页，纯文本的 profile 补丁层即可，便于版本管理和复现。

## 卸载

```sh
node scripts/install.mjs --remove
```

插件不保存任何状态，卸载不会动你的 `AGNES_API_KEY`。

## License

[MIT](LICENSE)
