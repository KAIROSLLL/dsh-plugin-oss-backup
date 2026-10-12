/**
 * 环境变量读取与自检的单元测试。
 *
 * 核心安全断言：**缺变量时的错误消息只含变量名，绝不含已设置变量的值。**
 *
 * @module tests/env.spec
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REGION,
  describeOssEnvironment,
  ENV_NAMES,
  MissingEnvironmentError,
  normalizeEndpoint,
  providerProfile,
  readOssConfig,
  readProvider,
  UnsupportedProviderError,
} from '../src/env.js'
import { SECRET_ENV_NAMES } from '../src/redact.js'

/** 一套齐备的测试环境（值全是哨兵，不是真凭证）。 */
const COMPLETE_ENV = {
  RUSTFS_ENDPOINT: '127.0.0.1:9000',
  RUSTFS_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
  RUSTFS_SECRET_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  RUSTFS_BUCKET: 'dsh-backup',
} as const

describe('readOssConfig', () => {
  it('齐备时返回配置，并规范化端点（补 scheme、去尾斜杠）', () => {
    const config = readOssConfig({ ...COMPLETE_ENV, RUSTFS_ENDPOINT: 'http://127.0.0.1:9000/' })
    expect(config.endpoint).toBe('http://127.0.0.1:9000')
    expect(config.bucket).toBe('dsh-backup')
    expect(config.accessKeyId).toBe(COMPLETE_ENV.RUSTFS_ACCESS_KEY)
  })

  it('未设置区域时用 us-east-1', () => {
    expect(readOssConfig({ ...COMPLETE_ENV }).region).toBe(DEFAULT_REGION)
    expect(DEFAULT_REGION).toBe('us-east-1')
  })

  it('设置区域时以环境变量为准', () => {
    expect(readOssConfig({ ...COMPLETE_ENV, RUSTFS_REGION: 'cn-hangzhou' }).region).toBe('cn-hangzhou')
  })

  it('一次性报出所有缺失变量，且只报变量名', () => {
    let caught: unknown
    try {
      readOssConfig({})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MissingEnvironmentError)
    const error = caught as MissingEnvironmentError
    // 断言"缺了哪些"而不是"按什么顺序" —— 读取顺序会随 provider 档位变化
    // （例如阿里云的 endpoint 可以由 region 推导出来，就不算缺）。
    expect([...error.missing].sort()).toEqual(
      [ENV_NAMES.endpoint, ENV_NAMES.accessKeyId, ENV_NAMES.secretAccessKey, ENV_NAMES.bucket].sort(),
    )
    for (const name of error.missing) expect(error.message).toContain(name)
  })

  it('只缺一项时，错误消息里不能出现已设置凭证的值', () => {
    // 这是最容易被忽略的泄漏路径：AK 已设置、SK 缺失，
    // 若实现图省事把整个 env dump 进错误里，AK 就跟着出去了。
    const partial = {
      RUSTFS_ENDPOINT: COMPLETE_ENV.RUSTFS_ENDPOINT,
      RUSTFS_ACCESS_KEY: COMPLETE_ENV.RUSTFS_ACCESS_KEY,
      RUSTFS_BUCKET: COMPLETE_ENV.RUSTFS_BUCKET,
    }
    let caught: unknown
    try {
      readOssConfig(partial)
    } catch (error) {
      caught = error
    }
    const error = caught as MissingEnvironmentError
    expect(error.missing).toEqual([ENV_NAMES.secretAccessKey])
    expect(error.message).toContain(ENV_NAMES.secretAccessKey)
    expect(error.message).not.toContain(COMPLETE_ENV.RUSTFS_ACCESS_KEY)
    // 整个对象也不能把值带出去。
    expect(JSON.stringify(error.missing)).not.toContain(COMPLETE_ENV.RUSTFS_ACCESS_KEY)
  })

  it('空白字符串按缺失处理', () => {
    let caught: unknown
    try {
      readOssConfig({ ...COMPLETE_ENV, RUSTFS_BUCKET: '   ' })
    } catch (error) {
      caught = error
    }
    expect((caught as MissingEnvironmentError).missing).toEqual([ENV_NAMES.bucket])
  })
})

describe('normalizeEndpoint', () => {
  it('无 scheme 时补 http://', () => {
    expect(normalizeEndpoint('127.0.0.1:9000')).toBe('http://127.0.0.1:9000')
  })

  it('保留已有 scheme 并去掉尾部斜杠', () => {
    expect(normalizeEndpoint('https://s3.example.com//')).toBe('https://s3.example.com')
  })
})

describe('describeOssEnvironment', () => {
  it('只报凭证存在性，绝不返回值', () => {
    const report = describeOssEnvironment({ ...COMPLETE_ENV })
    expect(report.ready).toBe(true)
    expect(report.accessKeyConfigured).toBe(true)
    expect(report.secretKeyConfigured).toBe(true)
    expect(JSON.stringify(report)).not.toContain(COMPLETE_ENV.RUSTFS_ACCESS_KEY)
    expect(JSON.stringify(report)).not.toContain(COMPLETE_ENV.RUSTFS_SECRET_KEY)
  })

  it('不齐备时给出缺失项而不是抛异常', () => {
    const report = describeOssEnvironment({ RUSTFS_BUCKET: 'b' })
    expect(report.ready).toBe(false)
    expect(report.missing).toContain(ENV_NAMES.accessKeyId)
  })

  it('端点写成带凭证的 URL 时，展示值被脱敏', () => {
    const report = describeOssEnvironment({
      ...COMPLETE_ENV,
      RUSTFS_ENDPOINT: 'http://someuser:somepass@127.0.0.1:9000',
    })
    expect(report.endpoint).not.toContain('somepass')
    expect(report.endpoint).toContain('***@')
  })
})

describe('「云端备份」控制台地址推导', () => {
  it('RustFS：控制台在 S3 端口 +1（9000 → 9001）', () => {
    const report = describeOssEnvironment({ ...COMPLETE_ENV })
    expect(report.consoleUrl).toBe('http://127.0.0.1:9001/')
  })

  it('RustFS：自定义端口同样 +1', () => {
    const report = describeOssEnvironment({ ...COMPLETE_ENV, RUSTFS_ENDPOINT: 'http://nas.local:8080' })
    expect(report.consoleUrl).toBe('http://nas.local:8081/')
  })

  it('RustFS：端点没写端口时补默认的 9001', () => {
    const report = describeOssEnvironment({ ...COMPLETE_ENV, RUSTFS_ENDPOINT: 'https://s3.example.com' })
    expect(report.consoleUrl).toBe('https://s3.example.com:9001/')
  })

  it('RustFS：端点不是合法 URL 时推导不出来（返回 null，而不是抛异常）', () => {
    const report = describeOssEnvironment({ ...COMPLETE_ENV, RUSTFS_ENDPOINT: 'http://[bad' })
    expect(report.consoleUrl).toBeNull()
  })

  it('阿里云：直达当前这个桶的对象列表', () => {
    const report = describeOssEnvironment({
      OSS_PROVIDER: 'aliyun',
      OSS_BUCKET: 'my-bucket',
      OSS_REGION: 'oss-cn-beijing',
      OSS_ACCESS_KEY_ID: 'id',
      OSS_ACCESS_KEY_SECRET: 'secret',
    })
    expect(report.consoleUrl).toBe('https://oss.console.aliyun.com/bucket/oss-cn-beijing/my-bucket/object')
  })

  it('阿里云：区域留空时用默认区域', () => {
    const report = describeOssEnvironment({
      OSS_PROVIDER: 'aliyun',
      OSS_BUCKET: 'my-bucket',
      OSS_ACCESS_KEY_ID: 'id',
      OSS_ACCESS_KEY_SECRET: 'secret',
    })
    expect(report.consoleUrl).toContain('oss-cn-hangzhou')
  })

  it('AWS：带上 region 直达桶', () => {
    const report = describeOssEnvironment({
      OSS_PROVIDER: 'aws',
      AWS_BUCKET: 'my-bucket',
      AWS_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'id',
      AWS_SECRET_ACCESS_KEY: 'secret',
    })
    expect(report.consoleUrl).toBe('https://s3.console.aws.amazon.com/s3/buckets/my-bucket?region=us-west-2')
  })

  it('桶名要做 URL 编码（桶名里不该有特殊字符，但别让它破坏链接）', () => {
    const report = describeOssEnvironment({
      OSS_PROVIDER: 'aws',
      AWS_BUCKET: 'a b',
      AWS_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'id',
      AWS_SECRET_ACCESS_KEY: 'secret',
    })
    expect(report.consoleUrl).toContain('a%20b')
  })

  it('桶还没配时给出控制台首页，而不是 null', () => {
    const report = describeOssEnvironment({
      OSS_PROVIDER: 'aws',
      AWS_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'id',
      AWS_SECRET_ACCESS_KEY: 'secret',
    })
    expect(report.consoleUrl).toBe('https://s3.console.aws.amazon.com/s3')
  })

  it('**控制台地址里不含任何凭证**（拼链接用的是未脱敏端点，但那只涉及主机名）', () => {
    const report = describeOssEnvironment({
      ...COMPLETE_ENV,
      RUSTFS_ENDPOINT: 'http://someuser:somepass@127.0.0.1:9000',
    })
    expect(report.consoleUrl ?? '').not.toContain('somepass')
    expect(report.consoleUrl ?? '').not.toContain('someuser')
  })
})

describe('provider 抽象', () => {
  it('未设置 OSS_PROVIDER 时默认 rustfs（既有配置不受影响）', () => {
    expect(readProvider({}).provider).toBe('rustfs')
    expect(readProvider({ OSS_PROVIDER: '  ' }).provider).toBe('rustfs')
  })

  it('识别三个 provider 与常见别名（大小写不敏感）', () => {
    expect(readProvider({ OSS_PROVIDER: 'rustfs' }).provider).toBe('rustfs')
    expect(readProvider({ OSS_PROVIDER: 'aliyun' }).provider).toBe('aliyun')
    expect(readProvider({ OSS_PROVIDER: 'aws' }).provider).toBe('aws')
    expect(readProvider({ OSS_PROVIDER: 'MinIO' }).provider).toBe('rustfs')
    expect(readProvider({ OSS_PROVIDER: 'OSS' }).provider).toBe('aliyun')
    expect(readProvider({ OSS_PROVIDER: 's3' }).provider).toBe('aws')
  })

  it('取值无法识别时抛错，且**不回显用户填的内容**（可能被误填成密钥）', () => {
    expect(readProvider({ OSS_PROVIDER: 'garbage' }).unsupported).toBe(true)

    let caught: unknown
    try {
      readOssConfig({ OSS_PROVIDER: 'AKIAIOSFODNN7EXAMPLE' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UnsupportedProviderError)
    const message = (caught as Error).message
    expect(message).toContain('OSS_PROVIDER')
    expect(message).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('rustfs 档：path-style + 端点必填 + 默认区域 us-east-1', () => {
    const config = readOssConfig({
      OSS_PROVIDER: 'rustfs',
      RUSTFS_ENDPOINT: '127.0.0.1:9000',
      RUSTFS_BUCKET: 'b',
      RUSTFS_ACCESS_KEY: 'ak',
      RUSTFS_SECRET_KEY: 'sk',
    })
    expect(config.forcePathStyle).toBe(true)
    expect(config.endpoint).toBe('http://127.0.0.1:9000')
    expect(config.region).toBe('us-east-1')
  })

  it('aliyun 档：虚拟主机风格 + 端点可由 region 推导', () => {
    const config = readOssConfig({
      OSS_PROVIDER: 'aliyun',
      OSS_BUCKET: 'b',
      OSS_ACCESS_KEY_ID: 'ak',
      OSS_ACCESS_KEY_SECRET: 'sk',
    })
    expect(config.forcePathStyle).toBe(false)
    expect(config.region).toBe('oss-cn-hangzhou')
    expect(config.endpoint).toBe('https://oss-cn-hangzhou.aliyuncs.com')
  })

  it('aliyun 档：显式 OSS_ENDPOINT 优先于推导，https 不会被补成 http', () => {
    const config = readOssConfig({
      OSS_PROVIDER: 'aliyun',
      OSS_ENDPOINT: 'https://oss-cn-beijing.aliyuncs.com',
      OSS_REGION: 'oss-cn-beijing',
      OSS_BUCKET: 'b',
      OSS_ACCESS_KEY_ID: 'ak',
      OSS_ACCESS_KEY_SECRET: 'sk',
    })
    expect(config.endpoint).toBe('https://oss-cn-beijing.aliyuncs.com')
  })

  it('aws 档：默认不指定 endpoint（交给 SDK），但 region 必填', () => {
    const config = readOssConfig({
      OSS_PROVIDER: 'aws',
      AWS_BUCKET: 'b',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'ak',
      AWS_SECRET_ACCESS_KEY: 'sk',
    })
    expect(config.endpoint).toBeNull()
    expect(config.forcePathStyle).toBe(false)

    expect(() =>
      readOssConfig({
        OSS_PROVIDER: 'aws',
        AWS_BUCKET: 'b',
        AWS_ACCESS_KEY_ID: 'ak',
        AWS_SECRET_ACCESS_KEY: 'sk',
      }),
    ).toThrow(MissingEnvironmentError)
  })

  it('三个 provider 的凭证变量名都在脱敏表里', () => {
    expect(SECRET_ENV_NAMES).toContain('RUSTFS_ACCESS_KEY')
    expect(SECRET_ENV_NAMES).toContain('OSS_ACCESS_KEY_ID')
    expect(SECRET_ENV_NAMES).toContain('OSS_ACCESS_KEY_SECRET')
    expect(SECRET_ENV_NAMES).toContain('AWS_ACCESS_KEY_ID')
    expect(SECRET_ENV_NAMES).toContain('AWS_SECRET_ACCESS_KEY')
  })

  it('自检报告会带上 provider 信息（供 UI 展示）', () => {
    const report = describeOssEnvironment({ OSS_PROVIDER: 'aliyun' })
    expect(report.provider).toBe('aliyun')
    expect(report.providerLabel).toContain('阿里云')
    expect(report.forcePathStyle).toBe(false)
    expect(report.variableNames.accessKeyId).toBe('OSS_ACCESS_KEY_ID')
  })

  it('生效区域显示 provider 默认值，而不是空串（真机验证时踩到过）', () => {
    const rustfs = describeOssEnvironment({
      RUSTFS_ENDPOINT: 'http://127.0.0.1:9000',
      RUSTFS_BUCKET: 'b',
      RUSTFS_ACCESS_KEY: 'ak',
      RUSTFS_SECRET_KEY: 'sk',
    })
    expect(rustfs.region).toBe('us-east-1')

    const aliyun = describeOssEnvironment({ OSS_PROVIDER: 'aliyun' })
    expect(aliyun.region).toBe('oss-cn-hangzhou')
  })
})
