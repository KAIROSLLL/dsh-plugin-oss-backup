/**
 * 可达性探测的测试。
 *
 * 这一项存在的意义：只看环境变量会把「变量都配好了、但服务没开」报成**就绪**，
 * 用户看着绿色就绪、实际每次上传都被连接拒绝。
 *
 * @module tests/reachability.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROBE_TTL_MS, Reachability } from '../src/reachability.js'

describe('Reachability', () => {
  it('探通 → reachable=true，且没有错误', async () => {
    const reachability = new Reachability({ probe: async () => {}, timeoutMs: 50 })
    const result = await reachability.check()
    expect(result.reachable).toBe(true)
    expect(result.error).toBeNull()
    expect(reachability.last).toEqual(result)
  })

  it('探不通 → reachable=false，原因已脱敏；**绝不抛异常**（连不上是正常状态）', async () => {
    const reachability = new Reachability({
      probe: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:9000')
      },
      timeoutMs: 50,
    })
    const result = await reachability.check()
    expect(result.reachable).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('缓存生效：TTL 内不重复探测；过 TTL 或 force 才重探', async () => {
    const probe = vi.fn(async () => {})
    let clock = 1_000
    const reachability = new Reachability({
      probe,
      now: () => clock,
      ttlMs: 1_000,
      timeoutMs: 50,
    })

    await reachability.check()
    await reachability.check()
    expect(probe).toHaveBeenCalledTimes(1)

    clock += 1_500
    await reachability.check()
    expect(probe).toHaveBeenCalledTimes(2)

    await reachability.check(true)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('并发调用共享同一次探测（界面多处同时读状态时不会打好几个请求）', async () => {
    let calls = 0
    const reachability = new Reachability({
      probe: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
      },
      ttlMs: 1_000,
      timeoutMs: 5_000,
    })

    await Promise.all([reachability.check(), reachability.check(), reachability.check()])
    expect(calls).toBe(1)
  })

  it('上传结果可以手工修正探测缓存 —— 界面不必等下一次探测才知道连不上', async () => {
    const reachability = new Reachability({ probe: async () => {}, timeoutMs: 50 })
    expect(reachability.last).toBeNull()

    reachability.markUnreachable('connect ECONNREFUSED 127.0.0.1:9000')
    expect(reachability.last?.reachable).toBe(false)
    expect(reachability.last?.error).toContain('ECONNREFUSED')

    reachability.markReachable()
    expect(reachability.last?.reachable).toBe(true)
    expect(reachability.last?.error).toBeNull()
  })

  it('探测超时会失败，而不是把界面一直挂着', async () => {
    // 用真实定时器：这里只是等一个 30ms 的超时，不值得跟 fake timers 的微任务绕。
    const reachability = new Reachability({
      // 永不 resolve：模拟"端口开着但不回话"。
      probe: () => new Promise<void>(() => {}),
      timeoutMs: 30,
    })
    const result = await reachability.check()
    expect(result.reachable).toBe(false)
    expect(result.error).toContain('timeout')
  })

  it('默认 TTL 是 30 秒：界面轮询很密，但真实探测不必那么频繁', () => {
    expect(DEFAULT_PROBE_TTL_MS).toBe(30_000)
  })
})
