/**
 * 凭证持久化的单元测试。
 *
 * DPAPI 本身没法在 CI 上跑，所以这里注入一个**假的子进程 runner**（base64 当作"加密"），
 * 只验证我们自己的封装逻辑：信封格式、往返、坏文件清理、平台回落、开关语义。
 *
 * 真正的 DPAPI 往返在 Windows 上由 `scripts/live-credential-store.mjs` 做真机冒烟。
 *
 * @module tests/credential-store.spec
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CREDENTIAL_FILE,
  createCredentialStore,
  isCredentialStoreEnabled,
  type Runner,
} from '../src/credential-store.js'
import { SETTINGS_DIR } from '../src/settings.js'

/** 一个"可逆的假 DPAPI"：加密与解密都是 base64（只为让往返成立）。 */
const fakeRunner: Runner = async (_command, args, stdin) =>
  args.join(' ').includes(']::Unprotect(')
    ? Buffer.from(stdin, 'base64').toString('utf8')
    : Buffer.from(stdin, 'utf8').toString('base64')

/** 造一个临时 home。 */
async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'oss-cred-'))
}

describe('isCredentialStoreEnabled', () => {
  it('只有字面量 os（大小写不敏感）才开启', () => {
    expect(isCredentialStoreEnabled({ OSS_CREDENTIAL_STORE: 'os' })).toBe(true)
    expect(isCredentialStoreEnabled({ OSS_CREDENTIAL_STORE: ' OS ' })).toBe(true)
  })

  it('别的取值一律视为关闭 —— 免得"随手设个 true"就把密钥写到磁盘上', () => {
    expect(isCredentialStoreEnabled({ OSS_CREDENTIAL_STORE: 'true' })).toBe(false)
    expect(isCredentialStoreEnabled({ OSS_CREDENTIAL_STORE: '1' })).toBe(false)
    expect(isCredentialStoreEnabled({ OSS_CREDENTIAL_STORE: 'yes' })).toBe(false)
    expect(isCredentialStoreEnabled({ OSS_CREDENTIAL_STORE: '' })).toBe(false)
    expect(isCredentialStoreEnabled({})).toBe(false)
  })
})

describe('createCredentialStore', () => {
  it('非 Windows 平台返回 null（调用方回落到"仅本次会话"）', () => {
    expect(createCredentialStore('C:/home', { platform: 'darwin' })).toBeNull()
    expect(createCredentialStore('C:/home', { platform: 'linux' })).toBeNull()
  })

  it('Windows 上给出 DPAPI 后端', () => {
    const store = createCredentialStore('C:/home', { platform: 'win32', runner: fakeRunner })
    expect(store?.kind).toBe('dpapi')
    expect(store?.label).toContain('DPAPI')
  })
})

describe('DPAPI 后端（用假 runner 驱动）', () => {
  it('save → load 往返，且**落盘的是密文**', async () => {
    const home = await makeHome()
    try {
      const store = createCredentialStore(home, { platform: 'win32', runner: fakeRunner })
      const credentials = { accessKeyId: 'AKIAFAKEPLACEHOLDER', secretAccessKey: 'FAKESECRET-FOR-TEST' }

      await store?.save(credentials)

      const raw = await readFile(join(home, SETTINGS_DIR, CREDENTIAL_FILE), 'utf8')
      expect(raw).not.toContain(credentials.accessKeyId)
      expect(raw).not.toContain(credentials.secretAccessKey)
      expect(JSON.parse(raw).v).toBe(1)

      expect(await store?.load()).toEqual(credentials)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('文件不存在时 load 返回 null，而不是抛异常', async () => {
    const home = await makeHome()
    try {
      const store = createCredentialStore(home, { platform: 'win32', runner: fakeRunner })
      expect(await store?.load()).toBeNull()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('解不开时**清掉坏文件**再回 null（换了机器或 Windows 账户的情形）', async () => {
    const home = await makeHome()
    const file = join(home, SETTINGS_DIR, CREDENTIAL_FILE)
    try {
      await mkdir(join(home, SETTINGS_DIR), { recursive: true })
      await writeFile(file, JSON.stringify({ v: 1, kind: 'dpapi', data: 'not-base64!!' }), 'utf8')

      const failing: Runner = async () => {
        throw new Error('DPAPI 解不开')
      }
      const store = createCredentialStore(home, { platform: 'win32', runner: failing })

      expect(await store?.load()).toBeNull()
      // 坏文件必须被清掉，否则每次启动都会失败一次。
      await expect(readFile(file, 'utf8')).rejects.toThrow()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('信封版本不对时也按坏文件处理', async () => {
    const home = await makeHome()
    const file = join(home, SETTINGS_DIR, CREDENTIAL_FILE)
    try {
      await mkdir(join(home, SETTINGS_DIR), { recursive: true })
      await writeFile(file, JSON.stringify({ v: 99, data: 'whatever' }), 'utf8')
      const store = createCredentialStore(home, { platform: 'win32', runner: fakeRunner })
      expect(await store?.load()).toBeNull()
      await expect(readFile(file, 'utf8')).rejects.toThrow()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('clear 删掉文件；重复 clear 不报错', async () => {
    const home = await makeHome()
    try {
      const store = createCredentialStore(home, { platform: 'win32', runner: fakeRunner })
      await store?.save({ accessKeyId: 'a', secretAccessKey: 'b' })
      await store?.clear()
      await expect(store?.clear()).resolves.toBeUndefined()
      expect(await store?.load()).toBeNull()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('明文只经过 stdin，不出现在 argv 里', async () => {
    const home = await makeHome()
    try {
      const runner = vi.fn(fakeRunner)
      const store = createCredentialStore(home, { platform: 'win32', runner })
      await store?.save({ accessKeyId: 'AKIAFAKEPLACEHOLDER', secretAccessKey: 'FAKESECRET' })

      const call = runner.mock.calls[0]
      expect(call).toBeDefined()
      const [, args, stdin] = call as unknown as [string, readonly string[], string]
      const script = args.join(' ')
      // argv 里只有脚本，没有值。
      expect(script).not.toContain('AKIAFAKEPLACEHOLDER')
      // 值确实是从 stdin 进去的。
      expect(stdin).toContain('AKIAFAKEPLACEHOLDER')
      // 脚本必须先加载 System.Security：Windows PowerShell 5.1 不会自动加载它，
      // 少了这句会在真机上直接报 TypeNotFound（实测踩过）。
      expect(script).toContain('Add-Type -AssemblyName System.Security')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
