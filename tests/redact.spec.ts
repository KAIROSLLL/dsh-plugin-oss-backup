/**
 * 脱敏层的单元测试。
 *
 * 这是本插件最重要的一组断言：**任何出口字符串都不允许出现凭证值**。
 *
 * @module tests/redact.spec
 */

import { describe, expect, it } from 'vitest'
import { collectSecretValues, redactSecrets, safeErrorMessage, REDACTED, SECRET_ENV_NAMES } from '../src/redact.js'

/** 测试用哨兵：造得像真凭证，且一眼能在输出里搜出来。 */
const FAKE_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const FAKE_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

describe('collectSecretValues', () => {
  it('收集已设置的凭证变量，忽略空值与过短的值', () => {
    const values = collectSecretValues({
      RUSTFS_ACCESS_KEY: FAKE_ACCESS_KEY,
      RUSTFS_SECRET_KEY: '',
      AWS_SESSION_TOKEN: 'ab',
    })
    expect(values).toEqual([FAKE_ACCESS_KEY])
  })

  it('覆盖的变量名里包含本插件使用的两个', () => {
    expect(SECRET_ENV_NAMES).toContain('RUSTFS_ACCESS_KEY')
    expect(SECRET_ENV_NAMES).toContain('RUSTFS_SECRET_KEY')
  })
})

describe('redactSecrets', () => {
  it('把已知凭证值替换成占位符，且不留下原文片段', () => {
    const text = `sign failed: ak=${FAKE_ACCESS_KEY} sk=${FAKE_SECRET_KEY}`
    const output = redactSecrets(text, [FAKE_ACCESS_KEY, FAKE_SECRET_KEY])
    expect(output).not.toContain(FAKE_ACCESS_KEY)
    expect(output).not.toContain(FAKE_SECRET_KEY)
    expect(output).toBe(`sign failed: ak=${REDACTED} sk=${REDACTED}`)
  })

  it('长值优先替换，避免一个是另一个前缀时留下尾串', () => {
    const output = redactSecrets('token=abcdefghijkl', ['abcdefgh', 'abcdefghijkl'])
    expect(output).toBe(`token=${REDACTED}`)
  })

  it('抹掉 URL 里的 userinfo（端点可能被写成带凭证形式）', () => {
    const output = redactSecrets('endpoint=http://someuser:somepass@127.0.0.1:9000/bucket', [])
    expect(output).toBe('endpoint=http://***@127.0.0.1:9000/bucket')
  })

  it('抹掉 AWS 签名相关的 query 与请求头字段', () => {
    // 测试里的假值刻意用**低熵 + 明显标记**的形态：像真密钥那样高熵的串会被
    // Gitleaks 之类的扫描器当成真凭证（实测踩过：本文件原先的假 token 让扫描红了）。
    const fakeToken = 'FAKE-SESSION-TOKEN-FOR-TEST'
    const text = [
      'GET /k?X-Amz-Signature=deadbeefdeadbeef&X-Amz-Credential=AKIA/20260101',
      'Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260101/us-east-1/s3/aws4_request',
      `x-amz-security-token: ${fakeToken}`,
    ].join('\n')
    const output = redactSecrets(text, [])
    expect(output).not.toContain('deadbeefdeadbeef')
    expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(output).not.toContain(fakeToken)
  })

  it('没有凭证时原样返回可读文本', () => {
    const text = 'normal message about bucket=dsh-backup'
    expect(redactSecrets(text, [])).toBe(text)
  })

  it('抹掉 Authorization 头里的裸 Signature=（不只是 X-Amz-Signature）', () => {
    // 实测踩到过：只覆盖 X-Amz-* 形态时，服务端回显的 `Signature=deadbeef…` 会原样漏出去。
    // 假 AK 刻意带 FAKE 标记 —— 不带标记的高熵串会被 Gitleaks / check:secrets 当成真凭证。
    const fakeAk = 'AKIAFAKEPLACEHOLDER'
    const text =
      `SignatureDoesNotMatch: ... Credential=${fakeAk}/20261011/us-east-1/s3/aws4_request, ` +
      'SignedHeaders=host;x-amz-date, Signature=deadbeefdeadbeefdeadbeef'
    const output = redactSecrets(text, [])
    expect(output).not.toContain('deadbeefdeadbeefdeadbeef')
    expect(output).not.toContain(fakeAk)
    // 不相关的字段不该被误伤。
    expect(output).toContain('SignedHeaders=host;x-amz-date')
  })
})

describe('safeErrorMessage', () => {
  it('整理 Error 时带上名字，并脱敏消息体', () => {
    const error = new Error(`SignatureDoesNotMatch for key ${FAKE_ACCESS_KEY}`)
    error.name = 'SignatureDoesNotMatch'
    // 真实运行时脱敏表来自进程环境（见 collectSecretValues），所以这里先把哨兵放进环境。
    const previous = process.env.RUSTFS_ACCESS_KEY
    process.env.RUSTFS_ACCESS_KEY = FAKE_ACCESS_KEY
    try {
      const message = safeErrorMessage(error)
      expect(message).toContain('SignatureDoesNotMatch')
      expect(message).not.toContain(FAKE_ACCESS_KEY)
    } finally {
      if (previous === undefined) delete process.env.RUSTFS_ACCESS_KEY
      else process.env.RUSTFS_ACCESS_KEY = previous
    }
  })

  it('不序列化整个 error 对象（AWS 异常上挂着请求头）', () => {
    const error = Object.assign(new Error(`boom Credential=${FAKE_ACCESS_KEY}/20260101`), {
      $metadata: { httpHeaders: { authorization: `AWS4-HMAC Credential=${FAKE_ACCESS_KEY}` } },
    })
    const message = safeErrorMessage(error)
    // 只取 message/name，不碰 $metadata。
    expect(message).not.toContain('$metadata')
    // 且消息体里的 Credential= 形态被抹掉（这条不依赖环境里是否有该值）。
    expect(message).not.toContain(FAKE_ACCESS_KEY)
    expect(message).toContain('Credential=***')
  })

  it('字符串与陌生值都能收成一行', () => {
    expect(safeErrorMessage('plain text')).toBe('plain text')
    expect(safeErrorMessage(undefined)).toBe('undefined')
  })
})
