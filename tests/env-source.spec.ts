/**
 * 系统环境变量补读的单元测试。
 *
 * 真机行为（真的去读 Windows 注册表）由 `pwsh` 现场验证；
 * 这里用注入的假 source 覆盖逻辑本身：补齐、不覆盖、静默降级、只返回变量名。
 *
 * @module tests/env-source.spec
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  createEnvironmentSource,
  environmentVariableNames,
  hydrateEnvironment,
  type EnvironmentSource,
} from '../src/env-source.js'

/** 测试里用到的变量名（用完清理，别污染同进程的其它测试）。 */
const TOUCHED = ['OSS_TEST_KEEP', 'OSS_TEST_NEW', 'OSS_TEST_SECRET']

afterEach(() => {
  for (const name of TOUCHED) delete process.env[name]
})

describe('environmentVariableNames', () => {
  it('覆盖三个 provider 的全部变量 + 两个开关', () => {
    const names = environmentVariableNames()
    expect(names).toContain('OSS_PROVIDER')
    expect(names).toContain('OSS_CREDENTIAL_STORE')
    // rustfs
    expect(names).toContain('RUSTFS_ENDPOINT')
    expect(names).toContain('RUSTFS_BUCKET')
    expect(names).toContain('RUSTFS_ACCESS_KEY')
    expect(names).toContain('RUSTFS_SECRET_KEY')
    // aliyun
    expect(names).toContain('OSS_ENDPOINT')
    expect(names).toContain('OSS_ACCESS_KEY_ID')
    expect(names).toContain('OSS_ACCESS_KEY_SECRET')
    // aws
    expect(names).toContain('AWS_REGION')
    expect(names).toContain('AWS_ACCESS_KEY_ID')
    expect(names).toContain('AWS_SECRET_ACCESS_KEY')
  })
})

describe('createEnvironmentSource', () => {
  it('非 Windows 返回 null（那些平台没有"用户级环境变量"可查）', () => {
    expect(createEnvironmentSource({ platform: 'darwin' })).toBeNull()
    expect(createEnvironmentSource({ platform: 'linux' })).toBeNull()
  })

  it('Windows 上给出一个可用的来源', () => {
    const source = createEnvironmentSource({ platform: 'win32', runner: async () => '{}' })
    expect(source).not.toBeNull()
    expect(typeof source?.read).toBe('function')
  })

  it('空名单不发子进程', async () => {
    let called = 0
    const source = createEnvironmentSource({
      platform: 'win32',
      runner: async () => {
        called += 1
        return '{}'
      },
    })
    expect(await source?.read([])).toEqual({})
    expect(called).toBe(0)
  })

  it('PowerShell 输出空串（一个都没读到）时按空结果处理', async () => {
    const source = createEnvironmentSource({ platform: 'win32', runner: async () => '   ' })
    expect(await source?.read(['X'])).toEqual({})
  })

  it('过滤掉非字符串与空值', async () => {
    const source = createEnvironmentSource({
      platform: 'win32',
      runner: async () => JSON.stringify({ A: 'v', B: '', C: 42, D: null }),
    })
    expect(await source?.read(['A', 'B', 'C', 'D'])).toEqual({ A: 'v' })
  })
})

describe('hydrateEnvironment', () => {
  it('补齐进程里没有的变量，且**绝不覆盖已有值**', async () => {
    process.env.OSS_TEST_KEEP = 'already-here'
    const source: EnvironmentSource = {
      read: async () => ({ OSS_TEST_KEEP: 'from-os', OSS_TEST_NEW: 'from-os' }),
    }

    const added = await hydrateEnvironment(['OSS_TEST_KEEP', 'OSS_TEST_NEW'], source)

    // 进程已有的值优先级最高 —— 比如你在某个 shell 里临时 export 过。
    expect(process.env.OSS_TEST_KEEP).toBe('already-here')
    expect(process.env.OSS_TEST_NEW).toBe('from-os')
    expect(added).toEqual(['OSS_TEST_NEW'])
  })

  it('source 为 null（平台不支持）时什么都不做', async () => {
    expect(await hydrateEnvironment(['OSS_TEST_NEW'], null)).toEqual([])
  })

  it('读取失败时静默降级 —— 补读只是便利，绝不能让插件加载不了', async () => {
    const source: EnvironmentSource = {
      read: async () => {
        throw new Error('powershell 挂了')
      },
    }
    expect(await hydrateEnvironment(['OSS_TEST_NEW'], source)).toEqual([])
  })

  it('返回的只有变量名，**不含值**', async () => {
    const source: EnvironmentSource = {
      read: async () => ({ OSS_TEST_SECRET: 'super-secret-value-12345' }),
    }
    const added = await hydrateEnvironment(['OSS_TEST_SECRET'], source)
    expect(added).toEqual(['OSS_TEST_SECRET'])
    expect(JSON.stringify(added)).not.toContain('super-secret-value-12345')
  })

  it('空字符串值不补（避免把"设了个空值"当成配置）', async () => {
    const source: EnvironmentSource = { read: async () => ({ OSS_TEST_NEW: '' }) }
    expect(await hydrateEnvironment(['OSS_TEST_NEW'], source)).toEqual([])
    expect(process.env.OSS_TEST_NEW).toBeUndefined()
  })
})
