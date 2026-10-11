/**
 * 真实 `S3Client` 的构造参数测试（不 mock SDK）。
 *
 * mock 版测试证明"我们传了什么"，这一版证明"SDK 真的收到了什么" ——
 * 尤其 `forcePathStyle: true`：S3 兼容端点（RustFS/MinIO）少了它就会去解析虚拟主机式域名。
 *
 * 构造客户端不发任何网络请求，所以这里可以放心用真类。
 *
 * @module tests/s3-client.spec
 */

import { describe, expect, it } from 'vitest'
import { providerProfile, type OssConfig } from '../src/env.js'
import { createS3Client } from '../src/upload.js'

/** 一份固定的测试配置（值为哨兵）。 */
const CONFIG: OssConfig = {
  provider: 'rustfs',
  profile: providerProfile('rustfs'),
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: 'dsh-backup',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: true,
}

describe('createS3Client', () => {
  it('用 endpoint + path-style + 显式凭证构造（S3 兼容端点必需）', async () => {
    const client = createS3Client(CONFIG)
    try {
      const { config } = client
      expect(config.forcePathStyle).toBe(true)
      expect(config.endpoint).toBeDefined()

      const endpoint = typeof config.endpoint === 'function' ? await config.endpoint() : config.endpoint
      expect(endpoint).toBeDefined()
      // SDK 会把字符串端点解析成 { hostname, port, protocol, path, query }。
      // 断言序列化结果而不是具体字段名：换个 SDK 版本也不至于误报。
      const serialized = JSON.stringify(endpoint, (_key, value) => (value instanceof URL ? value.href : value))
      expect(serialized).toContain('127.0.0.1')
      expect(serialized).toContain('9000')

      const region = typeof config.region === 'function' ? await config.region() : config.region
      expect(region).toBe('us-east-1')

      const credentials = await config.credentials()
      expect(credentials?.accessKeyId).toBe(CONFIG.accessKeyId)
      expect(credentials?.secretAccessKey).toBe(CONFIG.secretAccessKey)
    } finally {
      client.destroy()
    }
  })

  it('区域可被环境变量覆盖后传入', async () => {
    const client = createS3Client({ ...CONFIG, region: 'cn-hangzhou' })
    try {
      const region = typeof client.config.region === 'function' ? await client.config.region() : client.config.region
      expect(region).toBe('cn-hangzhou')
    } finally {
      client.destroy()
    }
  })

  it('阿里云档：虚拟主机风格（forcePathStyle = false）', () => {
    const client = createS3Client({
      ...CONFIG,
      provider: 'aliyun',
      profile: providerProfile('aliyun'),
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      region: 'oss-cn-hangzhou',
      forcePathStyle: false,
    })
    try {
      // 阿里云 OSS 走 `https://<bucket>.oss-cn-hangzhou.aliyuncs.com`，
      // 设成 path-style 反而会失败 —— 这正是 provider 抽象要保证的差异。
      expect(client.config.forcePathStyle).toBe(false)
    } finally {
      client.destroy()
    }
  })

  it('AWS 档：不指定 endpoint 时交给 SDK 默认端点', () => {
    const client = createS3Client({
      ...CONFIG,
      provider: 'aws',
      profile: providerProfile('aws'),
      endpoint: null,
      region: 'us-east-1',
      forcePathStyle: false,
    })
    try {
      expect(client.config.forcePathStyle).toBe(false)
    } finally {
      client.destroy()
    }
  })
})
