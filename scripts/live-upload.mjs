/**
 * 真实对象存储冒烟验证（本地 RustFS / MinIO / 云 OSS 均可）。
 *
 * 用法（**先 build**，脚本跑的是 lib/ 产物）：
 *     pnpm run build
 *     node scripts/live-upload.mjs [本地文件] [--keep]
 *
 * 环境变量（值请在你自己的终端里设置，别写进任何文件）：
 *     RUSTFS_ENDPOINT RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY RUSTFS_BUCKET [RUSTFS_REGION]
 *
 * 本脚本的行为约定：
 *   · 只从 `process.env` 读凭证，不写任何文件、不打印任何值；
 *   · 不传文件时自己造一个 1 KiB 随机临时文件，并在结束时删掉；
 *   · 上传后额外做一次 HeadObject 校验（大小一致才算通过）；
 *   · 默认上传完就删除远端对象（`--keep` 可保留，方便去控制台肉眼确认）；
 *   · 所有失败路径都过 `safeErrorMessage()` 脱敏。
 *
 * 退出码：0 通过；2 环境变量不全；3 上传或校验失败。
 *
 * @module scripts/live-upload
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { describeOssEnvironment, readOssConfig } from '../lib/env.js'
import { safeErrorMessage } from '../lib/redact.js'
import { createS3Client, uploadFileToOss } from '../lib/upload.js'

/**
 * 打印一行脱敏结果。
 *
 * @param text - 文本。
 */
function say(text) {
  process.stdout.write(`${text}\n`)
}

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const explicitPath = argv.find((item) => item !== '--keep')

const report = describeOssEnvironment()
say('=== 环境自检（只显示存在性，不显示值）===')
say(`  就绪: ${report.ready ? 'yes' : 'no'}`)
say(`  endpoint: ${report.endpoint ?? '(未设置)'}`)
say(`  bucket: ${report.bucket ?? '(未设置)'}`)
say(`  region: ${report.region}`)
say(`  ${report.variableNames.accessKeyId}: ${report.accessKeyConfigured ? 'present' : 'absent'}`)
say(`  ${report.variableNames.secretAccessKey}: ${report.secretKeyConfigured ? 'present' : 'absent'}`)

if (!report.ready) {
  say(`\n缺少环境变量：${report.missing.join('、')}`)
  say('请设置后重跑；值不要写进任何被版本控制的文件。')
  process.exit(2)
}

/** 需要清理的临时目录（没造过就是 null）。 */
let temporaryDir = null
/** 待上传的本地路径。 */
let localPath
/** 上传前统计到的字节数。 */
let expectedBytes

try {
  if (explicitPath === undefined) {
    temporaryDir = await mkdtemp(join(tmpdir(), 'oss-backup-'))
    localPath = join(temporaryDir, 'oss-backup-smoke.bin')
    await writeFile(localPath, randomBytes(1024))
    say(`\n已生成临时文件：${localPath}（1024 字节）`)
  } else {
    localPath = resolve(explicitPath)
    say(`\n使用现有文件：${localPath}`)
  }
  expectedBytes = (await stat(localPath)).size

  const config = readOssConfig()
  const objectKey = `oss-backup-smoke/${Date.now()}-${basename(localPath)}`
  say(`目标对象键：${objectKey}（bucket=${config.bucket}）`)

  say('\n=== 上传 ===')
  const result = await uploadFileToOss({ filePath: localPath, objectKey })
  say(`工具将返回：${result.message}`)

  say('\n=== 校验（HeadObject）===')
  const client = createS3Client(config)
  const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey }))
  const remoteBytes = head.ContentLength
  if (remoteBytes !== expectedBytes) {
    throw new Error(`大小不一致：本地 ${expectedBytes} 字节，远端 ${String(remoteBytes)} 字节`)
  }
  say(`  大小一致：${remoteBytes} 字节`)
  say(`  ETag: ${typeof head.ETag === 'string' ? head.ETag : '(未提供)'}`)

  if (keep) {
    say('\n--keep 已指定：远端对象保留，可去控制台肉眼确认。')
  } else {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey }))
    say('\n已删除远端测试对象（要保留请加 --keep）。')
  }

  say('\n结果：PASS')
} catch (error) {
  say(`\n结果：FAIL —— ${safeErrorMessage(error)}`)
  process.exitCode = 3
} finally {
  if (temporaryDir !== null) {
    await rm(temporaryDir, { recursive: true, force: true })
    say(`已清理临时目录：${temporaryDir}`)
  }
}
