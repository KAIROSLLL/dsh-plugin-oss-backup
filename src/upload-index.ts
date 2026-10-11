/**
 * 已上传文件索引 —— 用来跳过"没变化"的文件。
 *
 * 批量备份每次都会把整个目录重新走一遍，如果不查重，几千个没动过的文件会被一遍遍重传，
 * 既慢又白费流量。这里记下每个对象键对应的 `(size, mtimeMs)`，下次一样的就跳过。
 *
 * **只存非机密信息**：对象键、字节数、修改时间。不含任何密钥，也不含内容摘要 ——
 * 所以这个文件可以安全地留在磁盘上（它落在 `~/.dsh/oss-backup/`，与设置文件同级）。
 *
 * **为什么用本地索引而不是远端比对**：
 *
 *   · 远端 `ETag` 在**分片上传**时不是内容的 MD5（形如 `<md5-of-md5s>-<n>`），
 *     拿它跟本地算的 MD5 比会永远不相等 —— 那就白查了；
 *   · 每个文件先发一次 `HeadObject` 又要多一轮往返，备份几千个文件时这笔开销很实在；
 *   · 本地索引**零网络开销**，代价只是"文件改了但大小与 mtime 都没变"会被漏掉 ——
 *     这种情况需要刻意为之（保留 mtime 的改写），比前两个坑罕见得多。
 *
 * **局限（如实写出来，别让人以为万无一失）**：
 *
 *   · 换机器、删掉索引文件、或索引损坏 → **会重传一次**，之后恢复正常；
 *   · 文件内容变了但 `size` 与 `mtimeMs` 都没变 → 会被误判为没变化（见上）。
 *
 * @module dsh-plugin-oss-backup/upload-index
 */

/** 一条索引记录。 */
export interface UploadIndexEntry {
  /** 文件字节数。 */
  readonly size: number
  /** 文件修改时间（毫秒）。 */
  readonly mtimeMs: number
}

/** 文件指纹 —— 判定"变没变"就靠这两个数。 */
export interface FileFingerprint {
  /** 文件字节数。 */
  readonly size: number
  /** 修改时间（毫秒）。 */
  readonly mtimeMs: number
}

/** 索引文件的格式版本；将来改结构时用它做兼容判断。 */
export const INDEX_VERSION = 1

/**
 * 索引最多保留多少条。
 *
 * 超过就按插入顺序丢最早的（`Map` 保序）。这是防"索引文件无限长大"的护栏，
 * 被丢掉的只是"下次可能要重传一次"的代价，不会出错。
 */
export const MAX_INDEX_ENTRIES = 20_000

/**
 * 已上传文件的索引。
 *
 * 刻意做成**可变**的：批量备份时每个文件都要查一次、成功后记一次，
 * 不可变实现会带来 O(n²) 的复制开销。
 */
export class UploadIndex {
  private readonly entries = new Map<string, UploadIndexEntry>()

  /** 当前条数。 */
  get count(): number {
    return this.entries.size
  }

  /**
   * 从 JSON 文本解析索引。
   *
   * **任何异常输入都退化成空索引** —— 索引只是优化手段，绝不能因为它坏了就让备份失败。
   *
   * @param text - 索引文件内容。
   * @returns 索引。
   */
  static parse(text: string): UploadIndex {
    const index = new UploadIndex()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return index
    }
    if (raw === null || typeof raw !== 'object') return index
    const record = raw as { version?: unknown; entries?: unknown }
    // 版本不认就直接当空索引：宁可重传一轮，也不要按错误的结构去跳过文件。
    if (record.version !== INDEX_VERSION) return index
    if (record.entries === null || typeof record.entries !== 'object') return index

    for (const [key, value] of Object.entries(record.entries as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const entry = value as { size?: unknown; mtimeMs?: unknown }
      if (typeof entry.size !== 'number' || typeof entry.mtimeMs !== 'number') continue
      if (!Number.isFinite(entry.size) || !Number.isFinite(entry.mtimeMs)) continue
      index.entries.set(key, { size: entry.size, mtimeMs: entry.mtimeMs })
    }
    return index
  }

  /**
   * 序列化成 JSON 文本。
   *
   * @returns 文件内容。
   */
  serialize(): string {
    return `${JSON.stringify(
      { version: INDEX_VERSION, entries: Object.fromEntries(this.entries) },
      null,
      0,
    )}\n`
  }

  /**
   * 这个文件是否**没变化**（可以跳过上传）。
   *
   * @param objectKey - 目标对象键。
   * @param fingerprint - 本地文件的 `(size, mtimeMs)`。
   * @returns 没变化时为 `true`。
   */
  isUnchanged(objectKey: string, fingerprint: FileFingerprint): boolean {
    const entry = this.entries.get(objectKey)
    if (entry === undefined) return false
    return entry.size === fingerprint.size && entry.mtimeMs === fingerprint.mtimeMs
  }

  /**
   * 记下"这个键已经传过了"。
   *
   * 刻意写成先删后插：`Map` 保序，这样最近用到的键会排到末尾，
   * 超出 {@link MAX_INDEX_ENTRIES} 时被丢掉的才是**最久没用过**的那些。
   *
   * @param objectKey - 目标对象键。
   * @param fingerprint - 本地文件的 `(size, mtimeMs)`。
   */
  remember(objectKey: string, fingerprint: FileFingerprint): void {
    this.entries.delete(objectKey)
    this.entries.set(objectKey, { size: fingerprint.size, mtimeMs: fingerprint.mtimeMs })
    while (this.entries.size > MAX_INDEX_ENTRIES) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /**
   * 忘掉一个键（例如远端对象被删了）。
   *
   * @param objectKey - 目标对象键。
   */
  forget(objectKey: string): void {
    this.entries.delete(objectKey)
  }
}
