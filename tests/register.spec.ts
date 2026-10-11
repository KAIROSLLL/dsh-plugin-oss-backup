/**
 * 插件注册与工具执行的集成测试（mock 掉 `@aws-sdk/client-s3`）。
 *
 * 覆盖验收里最关键的几条：
 *   · 工具确实以 `oss_backup` 注册，参数 schema 正确；
 *   · 加载时打印日志，且日志里没有凭证值；
 *   · execute 端到端走通（env → 文件 → S3 命令），S3Client 参数符合 S3 兼容端点要求；
 *   · 缺环境变量时失败且消息只含变量名；
 *   · 状态路由只吐脱敏信息。
 *
 * @module tests/register.spec
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** mock 出来的 SDK 调用记录（vi.hoisted 保证在 vi.mock 工厂之前可用）。 */
const sdk = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
  sent: [] as unknown[],
  /** 非 null 时 `send` 会挂起 —— 用来把"上传中"那一瞬拉长给测试观察。 */
  gate: null as Promise<void> | null,
}))

vi.mock('@aws-sdk/client-s3', () => {
  /** 记录构造参数的假客户端。 */
  class S3Client {
    /** 构造参数。 */
    readonly config: Record<string, unknown>

    /**
     * @param config - 构造参数。
     */
    constructor(config: Record<string, unknown>) {
      this.config = config
      sdk.constructed.push(config)
    }

    /**
     * 记录命令并返回一个假响应。
     *
     * @param command - SDK 命令。
     * @returns 假响应。
     */
    async send(command: unknown): Promise<unknown> {
      sdk.sent.push(command)
      // 测试可以放一个 gate 把这次上传挂住，从外部观察"上传中"那一瞬的状态。
      if (sdk.gate !== null) await sdk.gate
      return { ETag: '"fake"' }
    }
  }

  /** 记录 input 的假命令。 */
  class PutObjectCommand {
    /** 命令入参。 */
    readonly input: Record<string, unknown>

    /**
     * @param input - 命令入参。
     */
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  }

  return { S3Client, PutObjectCommand }
})

const { apply, inject, name, SHOT_ROUTE, STATE_ROUTE, TOOL_NAME } = await import('../src/index')
const { writeSettings } = await import('../src/settings.js')

/** 哨兵凭证（不是真值）。 */
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

/** 一份齐备的环境。 */
const COMPLETE_ENV: Record<string, string> = {
  RUSTFS_ENDPOINT: 'http://127.0.0.1:9000',
  RUSTFS_ACCESS_KEY: ACCESS_KEY,
  RUSTFS_SECRET_KEY: SECRET_KEY,
  RUSTFS_BUCKET: 'dsh-backup',
}

/** 原始环境备份，测试结束要还原（免得污染同进程里的其它测试）。 */
let envBackup: NodeJS.ProcessEnv

/** 临时目录，测试结束清理。 */
let workDir: string | null = null

/** 临时 DSH home：设置文件写在这里，绝不碰开发机上的真实配置。 */
let settingsHome: string | null = null

beforeEach(async () => {
  envBackup = { ...process.env }
  for (const key of Object.keys(COMPLETE_ENV)) delete process.env[key]
  // 自动备份开关现在由**设置文件**驱动，所以把 DSH_HOME 指到临时目录：
  // 既隔离了开发机上的真实配置，也让每个用例都从"默认关闭"开始。
  delete process.env.OSS_AUTO_BACKUP
  delete process.env.OSS_BACKUP_PREFIX
  settingsHome = await mkdtemp(join(tmpdir(), 'oss-dshhome-'))
  process.env.DSH_HOME = settingsHome
  sdk.constructed.length = 0
  sdk.sent.length = 0
})

afterEach(async () => {
  process.env = envBackup
  sdk.gate = null
  if (workDir !== null) {
    await rm(workDir, { recursive: true, force: true })
    workDir = null
  }
  if (settingsHome !== null) {
    await rm(settingsHome, { recursive: true, force: true })
    settingsHome = null
  }
})

/**
 * 预置一份设置文件（写在临时 DSH_HOME 下）。
 *
 * @param patch - 要写入的设置。
 */
async function seedSettings(patch: { autoBackup?: boolean; backupDir?: string; prefix?: string }): Promise<void> {
  await writeSettings(patch, process.env.DSH_HOME as string)
}

/**
 * 等插件把设置读完（`apply` 是同步的，读设置是异步的）。
 *
 * @param harness - 观察结果。
 */
async function waitForSettingsLoaded(harness: Harness): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.logs.join('\n')).toContain('设置已加载')
  })
}

/** 一个被记下来的事件监听器。 */
type RecordedListener = (execution: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>

/** 一次 apply 之后拿到的观察结果。 */
interface Harness {
  /** 注册进去的工具定义。 */
  registered: Array<Record<string, unknown>>
  /** info 日志。 */
  logs: string[]
  /** warn 日志。 */
  warns: string[]
  /** 注册的宿主路由。 */
  routes: Array<{ path: string; handler: (request: unknown, response: FakeResponse) => void | Promise<void> }>
  /** 注册的事件监听器（按事件名分组）。 */
  listeners: Map<string, RecordedListener[]>
}

/** 假响应对象。 */
interface FakeResponse {
  /** 记录到的状态码。 */
  status: number
  /** 记录到的响应头。 */
  headers: Record<string, string>
  /** 记录到的响应体。 */
  body: string
  /**
   * @param status - 状态码。
   * @param headers - 响应头。
   */
  writeHead(status: number, headers: Record<string, string>): void
  /**
   * @param body - 响应体。
   */
  end(body?: string | Uint8Array): void
}

/**
 * 造一个最小上下文并跑一次 apply。
 *
 * @param withWebServer - 是否提供 webServer 软依赖。
 * @returns 观察结果。
 */
function setup(withWebServer = true): Harness {
  const harness: Harness = { registered: [], logs: [], warns: [], routes: [], listeners: new Map() }
  const ctx = {
    logger: {
      info: (message: string) => harness.logs.push(message),
      warn: (message: string) => harness.warns.push(message),
      error: () => {},
    },
    tools: {
      register: (definition: unknown) => {
        harness.registered.push(definition as Record<string, unknown>)
        return () => {}
      },
    },
    effect: (callback: () => void | (() => void)) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: (service: string) =>
      withWebServer && service === 'webServer'
        ? {
            register: (route: { path: string; handler: Harness['routes'][number]['handler'] }) => {
              harness.routes.push(route)
              return () => {}
            },
          }
        : undefined,
    on: (name: string, listener: RecordedListener) => {
      const list = harness.listeners.get(name) ?? []
      list.push(listener)
      harness.listeners.set(name, list)
      return () => {}
    },
  }
  apply(ctx)
  return harness
}

/**
 * 造一个假响应。
 *
 * @returns 假响应。
 */
function makeResponse(): FakeResponse {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = typeof body === 'string' ? body : Buffer.from(body ?? new Uint8Array()).toString('utf8')
    },
  }
}

/**
 * 造一个能吐出 JSON 请求体的假请求。
 *
 * 宿主用 `request.on('data' | 'end')` 读请求体（见 `readJsonBody`），所以这里要在
 * `end` 监听器注册之后**异步**派发一次 data + end。
 *
 * @param body - 请求体；省略视为空体。
 * @param method - HTTP 方法。
 * @returns 假请求。
 */
function makeRequest(body?: unknown, method = 'GET'): unknown {
  const listeners = new Map<string, Array<(chunk?: unknown) => void>>()
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    on(event: string, listener: (chunk?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      if (event === 'end') {
        queueMicrotask(() => {
          for (const item of listeners.get('data') ?? []) item(Buffer.from(text, 'utf8'))
          for (const item of listeners.get('end') ?? []) item()
        })
      }
      return this
    },
  }
}

describe('插件声明', () => {
  it('name 与 inject 符合 DSH 插件约定', () => {
    expect(name).toBe('dsh-plugin-oss-backup')
    // webServer 必须是硬依赖：软取（ctx.get）会因 apply 阶段服务未就绪而拿不到，
    // 结果两条路由静默不注册。
    expect(inject).toEqual(['tools', 'webServer'])
  })
})

describe('工具注册', () => {
  it('以 oss_backup 注册，参数为 filePath 与 objectKey 且都必填', () => {
    const harness = setup()
    expect(harness.registered).toHaveLength(1)
    const tool = harness.registered[0] as {
      name: string
      parameters: Record<string, { type: string; required?: true; description?: string }>
      output: { schema: { type: string } }
    }
    expect(tool.name).toBe(TOOL_NAME)
    expect(tool.name).toBe('oss_backup')
    expect(tool.parameters.filePath?.type).toBe('string')
    expect(tool.parameters.filePath?.required).toBe(true)
    expect(tool.parameters.objectKey?.type).toBe('string')
    expect(tool.parameters.objectKey?.required).toBe(true)
    expect(tool.parameters.filePath?.description).toBeTruthy()
    expect(tool.output.schema.type).toBe('string')
  })

  it('output.render 把规范值原样渲染成文本块', () => {
    const harness = setup()
    const tool = harness.registered[0] as { output: { render: (args: unknown, value: string) => unknown[] } }
    expect(tool.output.render({}, 'Uploaded: k (1 bytes)')).toEqual([{ type: 'text', text: 'Uploaded: k (1 bytes)' }])
  })

  it('加载日志被打印，且不含任何凭证值', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    await waitForSettingsLoaded(harness)
    const joined = harness.logs.join('\n')
    expect(joined).toContain('已加载')
    expect(joined).toContain(TOOL_NAME)
    expect(joined).toContain('RUSTFS_ACCESS_KEY')
    // 设置读完还会再记一条（含开关状态与备份目录）。
    expect(joined).toContain('设置已加载')
    expect(joined).toContain('自动备份=关')
    expect(joined).not.toContain(ACCESS_KEY)
    expect(joined).not.toContain(SECRET_KEY)
  })

  it('没有 webServer 时只告警，不影响工具注册', () => {
    const harness = setup(false)
    expect(harness.registered).toHaveLength(1)
    expect(harness.warns.join('\n')).toContain('webServer')
  })
})

describe('工具执行', () => {
  it('端到端上传：返回固定格式，S3Client 用 path-style + 默认区域', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    const tool = harness.registered[0] as {
      execute: (args: { filePath: string; objectKey: string }, exec: { signal: AbortSignal; callId: string }) => Promise<string>
    }

    workDir = await mkdtemp(join(tmpdir(), 'oss-backup-test-'))
    const filePath = join(workDir, 'report.bin')
    await writeFile(filePath, new Uint8Array([1, 2, 3, 4]))

    const result = await tool.execute(
      { filePath, objectKey: 'backups/report.bin' },
      { signal: new AbortController().signal, callId: 'test-call' },
    )

    expect(result).toBe('Uploaded: backups/report.bin (4 bytes)')
    expect(sdk.sent).toHaveLength(1)
    expect(sdk.constructed).toHaveLength(1)

    const config = sdk.constructed[0] as {
      endpoint: string
      region: string
      forcePathStyle: boolean
      credentials: { accessKeyId: string; secretAccessKey: string }
    }
    expect(config.endpoint).toBe('http://127.0.0.1:9000')
    expect(config.region).toBe('us-east-1')
    expect(config.forcePathStyle).toBe(true)
    expect(config.credentials.accessKeyId).toBe(ACCESS_KEY)
    expect(config.credentials.secretAccessKey).toBe(SECRET_KEY)

    const command = sdk.sent[0] as { input: Record<string, unknown> }
    expect(command.input.Bucket).toBe('dsh-backup')
    expect(command.input.Key).toBe('backups/report.bin')
    expect((command.input.Body as Uint8Array).byteLength).toBe(4)
  })

  it('缺环境变量时抛错，消息里只有变量名', async () => {
    process.env = { ...process.env, RUSTFS_ACCESS_KEY: ACCESS_KEY, RUSTFS_BUCKET: 'b' }
    const harness = setup()
    const tool = harness.registered[0] as {
      execute: (args: { filePath: string; objectKey: string }, exec: unknown) => Promise<string>
    }

    const error = await tool
      .execute({ filePath: '/nope.bin', objectKey: 'k' }, { signal: new AbortController().signal, callId: 'c' })
      .catch((caught: unknown) => caught as Error)

    expect(error.message).toContain('RUSTFS_ENDPOINT')
    expect(error.message).toContain('RUSTFS_SECRET_KEY')
    expect(error.message).not.toContain(ACCESS_KEY)
    // 已设置过的变量不该出现在"缺失"列表里。
    expect(error.message).not.toContain('RUSTFS_BUCKET')
  })
})

describe('状态路由（供设置页/侧边栏）', () => {
  it('只吐脱敏信息：凭证只报存在性，不返回值', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    expect(harness.routes.map((route) => route.path)).toContain(STATE_ROUTE)

    const response = makeResponse()
    await harness.routes[0]?.handler({ method: 'GET' }, response)

    expect(response.status).toBe(200)
    const payload = JSON.parse(response.body) as {
      tool: string
      environment: { ready: boolean; accessKeyConfigured: boolean; secretKeyConfigured: boolean; endpoint: string | null }
    }
    expect(payload.tool).toBe('oss_backup')
    expect(payload.environment.ready).toBe(true)
    expect(payload.environment.accessKeyConfigured).toBe(true)
    expect(payload.environment.secretKeyConfigured).toBe(true)
    expect(payload.environment.endpoint).toBe('http://127.0.0.1:9000')
    expect(response.body).not.toContain(ACCESS_KEY)
    expect(response.body).not.toContain(SECRET_KEY)
  })

  it('空闲时 busy 为 false（UI 据此决定要不要弹图）', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    const response = makeResponse()
    await harness.routes[0]?.handler({ method: 'GET' }, response)
    const payload = JSON.parse(response.body) as { busy: boolean }
    expect(payload.busy).toBe(false)
  })

  it('上传期间 busy 为 true，结束后仍有最短可见窗口', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    const tool = harness.registered[0] as {
      execute: (args: { filePath: string; objectKey: string }, exec: unknown) => Promise<string>
    }

    workDir = await mkdtemp(join(tmpdir(), 'oss-backup-test-'))
    const filePath = join(workDir, 'busy.bin')
    await writeFile(filePath, new Uint8Array(16))

    // 把这次 send 挂住，好在"上传中"查一次状态。
    let release: () => void = () => {}
    sdk.gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const pending = tool.execute(
      { filePath, objectKey: 'k/busy.bin' },
      { signal: new AbortController().signal, callId: 'busy-call' },
    )
    // 让 execute 走到 send（await 一拍即可）。
    await new Promise((resolve) => setTimeout(resolve, 20))

    const during = makeResponse()
    await harness.routes[0]?.handler({ method: 'GET' }, during)
    expect((JSON.parse(during.body) as { busy: boolean }).busy).toBe(true)

    release()
    await pending

    // 结束后仍在最短可见窗口内 —— 界面 2 秒一次的轮询必定采得到，图不会一闪而过。
    const after = makeResponse()
    await harness.routes[0]?.handler({ method: 'GET' }, after)
    const payload = JSON.parse(after.body) as { busy: boolean; last: { bytes: number } | null }
    expect(payload.busy).toBe(true)
    expect(payload.last?.bytes).toBe(16)
  })

  it('非 GET 一律 405', async () => {
    const harness = setup()
    const response = makeResponse()
    await harness.routes[0]?.handler({ method: 'POST' }, response)
    expect(response.status).toBe(405)
  })

  it('上传历史里只出现对象键与字节数', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    const tool = harness.registered[0] as {
      execute: (args: { filePath: string; objectKey: string }, exec: unknown) => Promise<string>
    }

    workDir = await mkdtemp(join(tmpdir(), 'oss-backup-test-'))
    const filePath = join(workDir, 'a.txt')
    await writeFile(filePath, 'hello')
    await tool.execute({ filePath, objectKey: 'k/a.txt' }, { signal: new AbortController().signal, callId: 'c' })

    const response = makeResponse()
    await harness.routes[0]?.handler({ method: 'GET' }, response)
    const payload = JSON.parse(response.body) as { last: { objectKey: string; bytes: number } | null }
    expect(payload.last?.objectKey).toBe('k/a.txt')
    expect(payload.last?.bytes).toBe(5)
  })

  it('上传中那张图由宿主路由提供（image/jpeg，来自包内 assets）', async () => {
    const harness = setup()
    expect(harness.routes.map((route) => route.path)).toContain(SHOT_ROUTE)

    const route = harness.routes.find((item) => item.path === SHOT_ROUTE)
    const response = makeResponse()
    await route?.handler({ method: 'GET' }, response)

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('image/jpeg')
    // 真实文件在 assets/ 里；这里只断言确实吐了非空字节。
    expect(Number(response.headers['content-length'])).toBeGreaterThan(1000)
  })

  it('状态里带上自动备份的只读信息（默认关闭）', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    const response = makeResponse()
    await harness.routes[0]?.handler({ method: 'GET' }, response)
    const payload = JSON.parse(response.body) as {
      autoBackup: { enabled: boolean; prefix: string; debounceMs: number; retries: number; pending: number }
    }
    expect(payload.autoBackup.enabled).toBe(false)
    expect(payload.autoBackup.prefix).toBe('workspace-backup/')
    expect(payload.autoBackup.debounceMs).toBe(2000)
    expect(payload.autoBackup.retries).toBe(3)
    expect(payload.autoBackup.pending).toBe(0)
  })
})

describe('自动备份监听（tools/post-execute）', () => {
  it('默认关闭：监听仍注册，但不会调度上传', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    await waitForSettingsLoaded(harness)

    // 监听**始终**注册（开关只决定要不要真的调度），这样拨开关不必动监听。
    expect(harness.listeners.get('tools/post-execute')).toHaveLength(1)
    expect(harness.logs.join('\n')).toContain('自动备份=关')
  })

  it('监听器必须把 next() 的结果原样返回（waterfall 旁观者语义）', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    await waitForSettingsLoaded(harness)
    const listeners = harness.listeners.get('tools/post-execute')

    const sentinel = { kind: 'accept' }
    const next = vi.fn(async () => sentinel)
    const returned = await listeners?.[0]?.({ name: 'read', arguments: {} }, { isError: false }, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(returned).toBe(sentinel)
  })

  it('开关打开后：非 write/edit 与失败的调用都不登记', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    await seedSettings({ autoBackup: true })
    const harness = setup()
    await waitForSettingsLoaded(harness)
    const listener = harness.listeners.get('tools/post-execute')?.[0]
    const next = vi.fn(async () => ({ kind: 'accept' }))

    await listener?.({ name: 'read', arguments: { file_path: '/ws/a.ts' } }, { isError: false }, next)
    await listener?.({ name: 'write', arguments: { file_path: '/ws/a.ts' } }, { isError: true }, next)
    await listener?.({ name: 'write', arguments: {} }, { isError: false }, next)

    const response = makeResponse()
    await harness.routes[0]?.handler({ method: 'GET' }, response)
    const payload = JSON.parse(response.body) as { autoBackup: { pending: number } }
    expect(payload.autoBackup.pending).toBe(0)
  })

  it('开关打开后：write 成功会登记，防抖 2 秒到期触发一次真实上传', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    await seedSettings({ autoBackup: true })
    const harness = setup()
    await waitForSettingsLoaded(harness)
    const listener = harness.listeners.get('tools/post-execute')?.[0]

    workDir = await mkdtemp(join(tmpdir(), 'oss-backup-auto-'))
    const filePath = join(workDir, 'auto.txt')
    await writeFile(filePath, 'auto-backup')

    await listener?.({ name: 'write', arguments: { file_path: filePath } }, { isError: false }, async () => ({}))

    // 防抖窗口内不该发生上传。
    expect(sdk.sent).toHaveLength(0)

    // 刻意用真实计时：fake timers 与真实文件 IO 混用容易假失败。
    await vi.waitFor(() => expect(sdk.sent).toHaveLength(1), { timeout: 8000, interval: 100 })
    const command = sdk.sent[0] as { input: Record<string, unknown> }
    expect(command.input.Key).toBe('workspace-backup/auto.txt')
  }, 20000)

  it('开关关闭时 write 也不登记，且超过防抖窗口真的没有上传（默认关闭的验收点）', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    await waitForSettingsLoaded(harness)
    const listener = harness.listeners.get('tools/post-execute')?.[0]

    workDir = await mkdtemp(join(tmpdir(), 'oss-backup-off-'))
    const filePath = join(workDir, 'off.txt')
    await writeFile(filePath, 'x')

    await listener?.({ name: 'write', arguments: { file_path: filePath } }, { isError: false }, async () => ({}))

    const response = makeResponse()
    await harness.routes[0]?.handler({ method: 'GET' }, response)
    const payload = JSON.parse(response.body) as { autoBackup: { pending: number; enabled: boolean } }
    expect(payload.autoBackup.enabled).toBe(false)
    expect(payload.autoBackup.pending).toBe(0)

    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(sdk.sent).toHaveLength(0)
  }, 20000)
})

describe('凭证注入路由（POST /oss-backup/credentials）', () => {
  it('把值写进宿主 process.env，且响应 / 日志 / state 里都不出现值', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    await waitForSettingsLoaded(harness)

    const route = harness.routes.find((item) => item.path === '/oss-backup/credentials')
    expect(route).toBeDefined()

    const fakeAk = 'AKIAFAKEPLACEHOLDER'
    const fakeSk = 'FAKESECRET-FOR-TEST-ONLY'
    const response = makeResponse()
    await route?.handler(makeRequest({ accessKeyId: fakeAk, secretAccessKey: fakeSk }, 'POST'), response)

    // ① 真的注入了宿主进程的环境变量 —— 因此既有读取代码一行都不用改。
    expect(process.env.RUSTFS_ACCESS_KEY).toBe(fakeAk)
    expect(process.env.RUSTFS_SECRET_KEY).toBe(fakeSk)

    // ② 响应只回变量名，绝不回值。
    expect(response.status).toBe(200)
    expect(response.body).toContain('RUSTFS_ACCESS_KEY')
    expect(response.body).not.toContain(fakeAk)
    expect(response.body).not.toContain(fakeSk)

    // ③ 日志里也不出现值。
    const logs = harness.logs.join('\n')
    expect(logs).toContain('已从设置页注入')
    expect(logs).not.toContain(fakeAk)
    expect(logs).not.toContain(fakeSk)

    // ④ state 如实报告"本次会话注入过"，但同样只有变量名。
    const stateResponse = makeResponse()
    await harness.routes
      .find((item) => item.path === '/oss-backup/state')
      ?.handler({ method: 'GET' }, stateResponse)
    expect(stateResponse.body).toContain('sessionVars')
    expect(stateResponse.body).not.toContain(fakeAk)
    expect(stateResponse.body).not.toContain(fakeSk)
  })

  it('两个值都为空时拒绝，且不写环境变量', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    delete process.env.RUSTFS_ACCESS_KEY
    const harness = setup()
    const route = harness.routes.find((item) => item.path === '/oss-backup/credentials')

    const response = makeResponse()
    await route?.handler(makeRequest({ accessKeyId: '   ', secretAccessKey: '' }, 'POST'), response)

    expect(response.status).toBe(400)
    expect(process.env.RUSTFS_ACCESS_KEY).toBeUndefined()
  })

  it('非 POST 方法被拒', async () => {
    process.env = { ...process.env, ...COMPLETE_ENV }
    const harness = setup()
    const route = harness.routes.find((item) => item.path === '/oss-backup/credentials')
    const response = makeResponse()
    await route?.handler(makeRequest(undefined, 'GET'), response)
    expect(response.status).toBe(405)
  })
})
