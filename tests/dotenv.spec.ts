/**
 * `.env` 加载的测试。
 *
 * 这一项的存在意义：让"值从哪来"不影响插件 —— 写在 `.env` 里与 `setx` 到系统里、
 * 由 CI Secret 注入，对插件而言完全等价。
 *
 * @module tests/dotenv.spec
 */

import { describe, expect, it } from 'vitest'
import { loadDotenv, loadDotenvFile, parseDotenv } from '../src/dotenv.js'

/** 造一个假的读文件实现（缺失的路径抛 ENOENT，与真实行为一致）。 */
function files(map: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string): Promise<string> => {
    const text = map[path]
    if (text === undefined) {
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code?: string }
      error.code = 'ENOENT'
      throw error
    }
    return text
  }
}

describe('parseDotenv', () => {
  it('基本键值对', () => {
    expect([...parseDotenv('A=1\nB=two')]).toEqual([
      ['A', '1'],
      ['B', 'two'],
    ])
  })

  it('跳过注释与空行', () => {
    expect([...parseDotenv('# 注释\n\nA=1\n   \n# 又一條')]).toEqual([['A', '1']])
  })

  it('剥掉成对的引号（单双都行）', () => {
    const parsed = parseDotenv('A="x y"\nB=\'z\'')
    expect(parsed.get('A')).toBe('x y')
    expect(parsed.get('B')).toBe('z')
  })

  it('单边引号原样保留（那本来就是值的一部分）', () => {
    expect(parseDotenv('A="x').get('A')).toBe('"x')
  })

  it('容忍 export 前缀', () => {
    expect(parseDotenv('export A=1').get('A')).toBe('1')
  })

  it('值里的 # 不算注释（行内注释刻意不支持，免得值被悄悄截断）', () => {
    expect(parseDotenv('A=a#b').get('A')).toBe('a#b')
  })

  it('键名不像环境变量的行直接忽略', () => {
    expect([...parseDotenv('not a var\n{"json": 1}\nOK=1')]).toEqual([['OK', '1']])
  })

  it('重复键后者胜', () => {
    expect(parseDotenv('A=1\nA=2').get('A')).toBe('2')
  })

  it('等号后面的内容整体作为值', () => {
    expect(parseDotenv('A=b=c').get('A')).toBe('b=c')
  })

  it('空值也保留（用户可能故意留空）', () => {
    expect(parseDotenv('A=').get('A')).toBe('')
  })

  it('CRLF 换行同样能解析（Windows 上编辑过）', () => {
    expect(parseDotenv('A=1\r\nB=2').get('B')).toBe('2')
  })
})

describe('loadDotenvFile', () => {
  it('把值写进环境变量表，且**返回结果里只有变量名、没有值**', async () => {
    const env: NodeJS.ProcessEnv = {}
    const result = await loadDotenvFile(
      '/x/.env',
      env,
      files({ '/x/.env': 'RUSTFS_BUCKET=bucket-name\nRUSTFS_ACCESS_KEY=AKIAFAKEPLACEHOLDER' }),
    )
    expect(env.RUSTFS_BUCKET).toBe('bucket-name')
    expect(env.RUSTFS_ACCESS_KEY).toBe('AKIAFAKEPLACEHOLDER')
    expect(result.loaded).toEqual(['RUSTFS_BUCKET', 'RUSTFS_ACCESS_KEY'])
    // 结果对象里绝不能带出值 —— 它会被日志和界面用到。
    expect(JSON.stringify(result)).not.toContain('bucket-name')
    expect(JSON.stringify(result)).not.toContain('AKIAFAKEPLACEHOLDER')
  })

  it('默认**覆盖**已有值，并记下被覆盖的键名（.env 优先于系统环境）', async () => {
    const env: NodeJS.ProcessEnv = { RUSTFS_BUCKET: 'old' }
    const result = await loadDotenvFile('/x/.env', env, files({ '/x/.env': 'RUSTFS_BUCKET=new' }))
    expect(env.RUSTFS_BUCKET).toBe('new')
    expect(result.overridden).toEqual(['RUSTFS_BUCKET'])
  })

  it('值相同时不算「覆盖」（免得日志变吵）', async () => {
    const env: NodeJS.ProcessEnv = { RUSTFS_BUCKET: 'same' }
    const result = await loadDotenvFile('/x/.env', env, files({ '/x/.env': 'RUSTFS_BUCKET=same' }))
    expect(result.overridden).toEqual([])
    expect(result.loaded).toEqual(['RUSTFS_BUCKET'])
  })

  it('override: false 时保留已有值（dotenv 的通行语义）', async () => {
    const env: NodeJS.ProcessEnv = { RUSTFS_BUCKET: 'old' }
    const result = await loadDotenvFile('/x/.env', env, files({ '/x/.env': 'RUSTFS_BUCKET=new' }), {
      override: false,
    })
    expect(env.RUSTFS_BUCKET).toBe('old')
    expect(result.skipped).toEqual(['RUSTFS_BUCKET'])
    expect(result.overridden).toEqual([])
  })

  it('文件不存在不算错误（用户没建 .env 是正常情况）', async () => {
    const env: NodeJS.ProcessEnv = {}
    const result = await loadDotenvFile('/x/.env', env, files({}))
    expect(result).toEqual({ path: null, loaded: [], skipped: [], overridden: [], error: null })
    expect(env.RUSTFS_BUCKET).toBeUndefined()
  })

  it('读文件失败（非 ENOENT）回报脱敏后的原因，且不抛异常', async () => {
    const failing = async (): Promise<string> => {
      const error = new Error('EACCES: permission denied, open /x/.env') as Error & { code?: string }
      error.code = 'EACCES'
      throw error
    }
    const result = await loadDotenvFile('/x/.env', {}, failing)
    expect(result.error).toContain('EACCES')
    expect(result.loaded).toEqual([])
  })

  it('空白值不算「已有值」（否则 .env 里没法把它补上）', async () => {
    const env: NodeJS.ProcessEnv = { RUSTFS_BUCKET: '   ' }
    const result = await loadDotenvFile('/x/.env', env, files({ '/x/.env': 'RUSTFS_BUCKET=real' }))
    expect(env.RUSTFS_BUCKET).toBe('real')
    expect(result.overridden).toEqual([])
  })
})

describe('loadDotenv：候选路径', () => {
  it('采用第一个能读到的文件', async () => {
    const env: NodeJS.ProcessEnv = {}
    const result = await loadDotenv(['/home/.env', '/cwd/.env'], env, files({ '/cwd/.env': 'A=1' }))
    expect(result.path).toBe('/cwd/.env')
    expect(env.A).toBe('1')
  })

  it('靠前的候选优先', async () => {
    const env: NodeJS.ProcessEnv = {}
    const result = await loadDotenv(
      ['/home/.env', '/cwd/.env'],
      env,
      files({ '/home/.env': 'A=home', '/cwd/.env': 'A=cwd' }),
    )
    expect(result.path).toBe('/home/.env')
    expect(env.A).toBe('home')
  })

  it('全都不存在 → 空结果，不报错', async () => {
    const result = await loadDotenv(['/a/.env', '/b/.env'], {}, files({}))
    expect(result.path).toBeNull()
    expect(result.error).toBeNull()
    expect(result.loaded).toEqual([])
  })
})
