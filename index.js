/**
 * Host half of the "QQ 截图" bundle: one capture operation shared by the
 * `qq_screenshot` agent tool and the `/screenshot` composer command.
 *
 * The capture itself is delegated to QQ's own screenshot tool: a helper
 * PowerShell script presses QQ's screenshot hotkey, the user selects a region
 * in QQ's overlay, and QQ copies the result to the clipboard. The helper then
 * stores that bitmap as a PNG inside the session workspace.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const CAPTURE_SCRIPT = path.join(PLUGIN_DIR, 'capture.ps1')

const COMMAND_NAME = 'screenshot'
const TOOL_NAME = 'qq_screenshot'

const DEFAULT_HOTKEY = 'Ctrl+Alt+A'
const DEFAULT_TIMEOUT_SEC = 100
const START_TIMEOUT_SEC = 8

/** Tools and the human-command registry the two callers need. */
export const inject = ['tools', 'commands']

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

const ERROR_TEXT = {
  'no-overlay':
    'QQ 的截图窗口没有打开。请确认 QQ 正在运行并已登录；如果修改过 QQ 的截图快捷键，请在插件里配置对应的 hotkey。',
  cancelled: '截图已在 QQ 中被取消，或完成时没有复制图片（在 QQ 截图里按 Enter 即复制到剪贴板）。',
  timeout: '等待 QQ 截图完成超时。',
  'no-windows': 'QQ 截图只在 Windows 上可用。',
  'no-powershell': '找不到 Windows PowerShell（powershell.exe），无法调用 QQ 截图。',
  error: '调用 QQ 截图失败。',
}

/** Absolute path of the Windows PowerShell 5.1 host, which provides STA + WinForms clipboard access. */
function powershellExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** Directory the PNG is written to: `<session workspace>/screenshots`, or the temp directory. */
async function screenshotDirectory(ctx, agent) {
  let base = ''
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory !== undefined && agent !== undefined) {
    try {
      const session = agent.session
      base = session !== undefined ? workingDirectory.get(session) : workingDirectory.get(agent)
    } catch {
      base = ''
    }
  }
  if (typeof base !== 'string' || base.length === 0) base = os.tmpdir()
  const directory = path.join(base, 'screenshots')
  await mkdir(directory, { recursive: true })
  return directory
}

/** Run the helper script and read back its JSON result file. */
async function runCaptureScript({ outFile, hotkey, timeoutSec, signal }) {
  const resultFile = `${outFile}.json`
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    CAPTURE_SCRIPT,
    '-OutFile',
    outFile,
    '-Hotkey',
    hotkey,
    '-TimeoutSec',
    String(timeoutSec),
    '-StartTimeoutSec',
    String(START_TIMEOUT_SEC),
    '-ResultFile',
    resultFile,
  ]

  const child = spawn(powershellExe(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.on('data', () => {})
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 8000) stderr += chunk.toString('utf8')
  })

  let spawnError
  child.on('error', (error) => {
    spawnError = error
  })

  const killer = setTimeout(() => {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }, (timeoutSec + START_TIMEOUT_SEC + 30) * 1000)
  const onAbort = () => {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  await new Promise((resolve) => {
    child.on('close', resolve)
    child.on('error', resolve)
  })
  clearTimeout(killer)
  if (signal !== undefined) signal.removeEventListener('abort', onAbort)

  if (spawnError !== undefined) {
    if (spawnError.code === 'ENOENT') return { ok: false, code: 'no-powershell' }
    return { ok: false, code: 'error', message: spawnError.message }
  }

  let raw
  try {
    raw = await readFile(resultFile, 'utf8')
  } catch {
    return { ok: false, code: 'error', message: stderr.trim() || 'QQ 截图助手没有返回结果' }
  } finally {
    await rm(resultFile, { force: true }).catch(() => {})
  }

  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    /* fall through */
  }
  return { ok: false, code: 'error', message: stderr.trim() || 'QQ 截图助手返回了无法解析的结果' }
}

/** Optional per-user overrides, re-read on every capture: `~/.dsh/qq-screenshot.json`. */
async function readOverrides() {
  try {
    const raw = await readFile(path.join(os.homedir(), '.dsh', 'qq-screenshot.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** One complete capture: QQ overlay, user selection, PNG on disk. Throws on failure. */
async function captureOnce(ctx, { hotkey, timeoutSec, agent, signal }) {
  if (process.platform !== 'win32') throw new Error(ERROR_TEXT['no-windows'])

  const overrides = await readOverrides()
  const effectiveHotkey =
    typeof overrides.hotkey === 'string' && overrides.hotkey.trim().length > 0
      ? overrides.hotkey.trim()
      : hotkey
  const effectiveTimeoutSec =
    Number.isInteger(overrides.timeoutSec) && overrides.timeoutSec > 5 ? overrides.timeoutSec : timeoutSec

  const directory = await screenshotDirectory(ctx, agent)
  const outFile = path.join(directory, `qq-${timestamp()}.png`)
  const outcome = await runCaptureScript({
    outFile,
    hotkey: effectiveHotkey,
    timeoutSec: effectiveTimeoutSec,
    signal,
  })

  if (outcome.ok === true) {
    const info = await stat(outcome.path ?? outFile).catch(() => undefined)
    return {
      path: outcome.path ?? outFile,
      width: Number(outcome.width) || 0,
      height: Number(outcome.height) || 0,
      bytes: Number(outcome.bytes) || info?.size || 0,
    }
  }

  const known = ERROR_TEXT[outcome.code]
  const detail = typeof outcome.message === 'string' && outcome.message.length > 0 ? outcome.message : ''
  if (known !== undefined) throw new Error(known)
  throw new Error(detail.length > 0 ? detail : ERROR_TEXT.error)
}

/** Whether the exact routed model declares image input, mirroring `read_image`'s gate. */
async function canViewImages(ctx, exec) {
  try {
    const routed = exec.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    const llm = ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) return false
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

function imageBlockOf(value) {
  return {
    type: 'image',
    attachment: {
      attachmentId: value.image.attachmentId,
      mediaType: value.image.mediaType,
      bytes: value.image.bytes,
      width: value.image.width,
      height: value.image.height,
      ...(typeof value.image.name === 'string' ? { name: value.image.name } : {}),
    },
  }
}

function renderCapture(_args, value) {
  const lines = [
    '<path>' + value.path + '</path>',
    '<type>image</type>',
    '<content>',
    `QQ 截图，${value.width}x${value.height} px，${value.bytes} bytes`,
    value.image === undefined ? '当前模型不接受图片输入；如需查看，请让用户切换到支持图片输入的模型，或用 read_image 读取该文件。' : '',
    '</content>',
  ].filter((line) => line.length > 0)
  const content = [{ type: 'text', text: lines.join('\n') }]
  if (value.image !== undefined) content.push(imageBlockOf(value))
  return content
}

/**
 * Register the shared operation as an agent tool and as a human command.
 * @param ctx - owning plugin context.
 * @param config - optional row config carrying `hotkey` and `timeoutSec`.
 */
export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const hotkey =
    typeof settings.hotkey === 'string' && settings.hotkey.trim().length > 0
      ? settings.hotkey.trim()
      : DEFAULT_HOTKEY
  const timeoutSec =
    Number.isInteger(settings.timeoutSec) && settings.timeoutSec > 5 ? settings.timeoutSec : DEFAULT_TIMEOUT_SEC

  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_NAME,
        description:
          '用 QQ 的截图工具截取屏幕区域并把图片交给模型。调用后 QQ 的截图界面会弹出，用户需要框选区域并按 Enter 完成；' +
          '完成后图片会保存到会话工作区的 screenshots 目录，并在模型支持图片输入时直接随结果返回。' +
          '需要用户在自己的电脑前操作，且 QQ 正在运行。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: {
              type: 'string',
              description: '可选：一句话说明这次截图的目的，会显示在工具卡片上，方便用户知道要截什么。',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'width', 'height', 'bytes'],
            properties: {
              path: { type: 'string', description: '保存到磁盘的 PNG 绝对路径。' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              bytes: { type: 'integer' },
              image: IMAGE_VALUE_SCHEMA,
            },
          },
          render: renderCapture,
        },
        timeoutMs: 180_000,
        isConcurrencySafe: () => false,
        async execute(_args, exec) {
          const shot = await captureOnce(ctx, {
            hotkey,
            timeoutSec,
            agent: exec.agent,
            signal: exec.signal,
          })

          const value = {
            path: shot.path,
            width: shot.width,
            height: shot.height,
            bytes: shot.bytes,
          }

          if (await canViewImages(ctx, exec)) {
            const attachments = ctx.get('attachments')
            if (attachments !== undefined) {
              const data = await readFile(shot.path)
              const ref = await attachments.saveImage({
                data,
                mediaType: 'image/png',
                name: path.basename(shot.path),
              })
              value.image = {
                attachmentId: ref.attachmentId,
                mediaType: ref.mediaType,
                bytes: ref.bytes,
                width: ref.width,
                height: ref.height,
                ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
              }
            }
          }
          return value
        },
      }),
    'qq-screenshot: tool',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: COMMAND_NAME,
        description: '用 QQ 截图工具截取屏幕区域，并把 PNG 保存到工作区的 screenshots 目录。',
        recordInput: false,
        handler: async (invocation) => {
          try {
            const shot = await captureOnce(ctx, {
              hotkey,
              timeoutSec,
              agent: invocation.agent,
              signal: invocation.signal,
            })
            return {
              kind: 'success',
              text: `QQ 截图已保存：${shot.path}`,
            }
          } catch (error) {
            return {
              kind: 'error',
              text: error instanceof Error ? error.message : String(error),
            }
          }
        },
      }),
    'qq-screenshot: command',
  )
}
