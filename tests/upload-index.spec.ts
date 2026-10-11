/**
 * 上传索引的单元测试。
 *
 * 重点在三件事：**容错**（坏输入退化成空索引，绝不让备份失败）、
 * **判定正确**（没变化才跳过）、**只存非机密**（不含任何密钥）。
 *
 * @module tests/upload-index.spec
 */

import { describe, expect, it } from 'vitest'
import { INDEX_VERSION, MAX_INDEX_ENTRIES, UploadIndex } from '../src/upload-index.js'

describe('UploadIndex.parse', () => {
  it('解析正常内容', () => {
    const index = UploadIndex.parse(
      JSON.stringify({ version: INDEX_VERSION, entries: { 'a/b.txt': { size: 5, mtimeMs: 123 } } }),
    )
    expect(index.count).toBe(1)
    expect(index.isUnchanged('a/b.txt', { size: 5, mtimeMs: 123 })).toBe(true)
  })

  it('坏 JSON → 空索引，不抛异常（索引只是优化，不能挡住备份）', () => {
    expect(UploadIndex.parse('{ 这不是 JSON').count).toBe(0)
  })

  it('版本对不上 → 空索引（宁可重传一轮，也不按错结构跳过文件）', () => {
    const index = UploadIndex.parse(JSON.stringify({ version: 999, entries: { k: { size: 1, mtimeMs: 1 } } }))
    expect(index.count).toBe(0)
  })

  it('结构不对的条目被逐条丢掉，好的留下', () => {
    const index = UploadIndex.parse(
      JSON.stringify({
        version: INDEX_VERSION,
        entries: {
          good: { size: 1, mtimeMs: 2 },
          noMtime: { size: 1 },
          notObject: 'nope',
          nullEntry: null,
          nanSize: { size: Number.NaN, mtimeMs: 1 },
        },
      }),
    )
    expect(index.count).toBe(1)
    expect(index.isUnchanged('good', { size: 1, mtimeMs: 2 })).toBe(true)
  })

  it('顶层不是对象时也给空索引', () => {
    expect(UploadIndex.parse('[]').count).toBe(0)
    expect(UploadIndex.parse('null').count).toBe(0)
  })
})

describe('UploadIndex 判定', () => {
  it('size 或 mtime 任一不同 → 不算没变化（必须重传）', () => {
    const index = new UploadIndex()
    index.remember('k', { size: 10, mtimeMs: 100 })
    expect(index.isUnchanged('k', { size: 10, mtimeMs: 100 })).toBe(true)
    expect(index.isUnchanged('k', { size: 11, mtimeMs: 100 })).toBe(false)
    expect(index.isUnchanged('k', { size: 10, mtimeMs: 101 })).toBe(false)
  })

  it('没记过的键 → 一定上传', () => {
    expect(new UploadIndex().isUnchanged('never', { size: 1, mtimeMs: 1 })).toBe(false)
  })

  it('remember 会覆盖旧记录（同一个键被改动后再传一次）', () => {
    const index = new UploadIndex()
    index.remember('k', { size: 10, mtimeMs: 100 })
    index.remember('k', { size: 20, mtimeMs: 200 })
    expect(index.count).toBe(1)
    expect(index.isUnchanged('k', { size: 20, mtimeMs: 200 })).toBe(true)
    expect(index.isUnchanged('k', { size: 10, mtimeMs: 100 })).toBe(false)
  })

  it('forget 之后不再跳过', () => {
    const index = new UploadIndex()
    index.remember('k', { size: 1, mtimeMs: 1 })
    index.forget('k')
    expect(index.isUnchanged('k', { size: 1, mtimeMs: 1 })).toBe(false)
  })
})

describe('UploadIndex 容量上限', () => {
  it(`超过 ${MAX_INDEX_ENTRIES} 条时丢最早的，且总数不超标`, () => {
    const index = new UploadIndex()
    for (let i = 0; i < MAX_INDEX_ENTRIES + 10; i += 1) {
      index.remember(`key-${i}`, { size: i, mtimeMs: i })
    }
    expect(index.count).toBe(MAX_INDEX_ENTRIES)
    // 最早那批被丢掉了。
    expect(index.isUnchanged('key-0', { size: 0, mtimeMs: 0 })).toBe(false)
    // 最新的还在。
    const last = MAX_INDEX_ENTRIES + 9
    expect(index.isUnchanged(`key-${last}`, { size: last, mtimeMs: last })).toBe(true)
  })

  it('重新 remember 一个旧键会把它顶到最新（LRU 语义）', () => {
    const index = new UploadIndex()
    index.remember('old', { size: 1, mtimeMs: 1 })
    for (let i = 0; i < MAX_INDEX_ENTRIES - 1; i += 1) {
      index.remember(`k-${i}`, { size: i, mtimeMs: i })
    }
    // 此时 old 是"最早"的，再记一次就该被顶到末尾。
    index.remember('old', { size: 1, mtimeMs: 1 })
    index.remember('newest', { size: 9, mtimeMs: 9 })
    expect(index.isUnchanged('old', { size: 1, mtimeMs: 1 })).toBe(true)
  })
})

describe('UploadIndex 序列化', () => {
  it('往返后内容一致', () => {
    const index = new UploadIndex()
    index.remember('a/b/c.txt', { size: 42, mtimeMs: 1_700_000_000_000 })
    index.remember('d.txt', { size: 0, mtimeMs: 0 })

    const restored = UploadIndex.parse(index.serialize())
    expect(restored.count).toBe(2)
    expect(restored.isUnchanged('a/b/c.txt', { size: 42, mtimeMs: 1_700_000_000_000 })).toBe(true)
    expect(restored.isUnchanged('d.txt', { size: 0, mtimeMs: 0 })).toBe(true)
  })

  it('**序列化结果里不含任何机密**（只有键、大小、时间）', () => {
    const index = new UploadIndex()
    index.remember('workspace-backup/src/index.ts', { size: 123, mtimeMs: 456 })
    const text = index.serialize()
    expect(text).toContain('workspace-backup/src/index.ts')
    expect(text).toContain('123')
    // 结构上只有这两个字段 —— 没有任何位置能塞进密钥。
    const parsed = JSON.parse(text) as { entries: Record<string, Record<string, unknown>> }
    expect(Object.keys(parsed.entries['workspace-backup/src/index.ts']!).sort()).toEqual(['mtimeMs', 'size'])
  })
})
