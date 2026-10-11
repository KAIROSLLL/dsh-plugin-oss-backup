/**
 * 定期全量备份的调度 —— 纯逻辑部分（不碰定时器，方便单测）。
 *
 * 四种模式：
 *   · `off`      —— 关闭（默认）
 *   · `interval` —— 每 N 分钟 / 小时 / 天跑一次
 *   · `daily`    —— 每天固定时刻（如 03:30）
 *   · `monthly`  —— 每月固定几号的固定时刻（如每月 1 日 03:30）
 *
 * 这里只负责"算出下一次该在什么时候跑"；真正的定时器在 `index.ts` 里，
 * 用的是"跑完再排下一次"的链式 `setTimeout`（而不是 `setInterval`），
 * 这样不会堆叠出多次备份。
 *
 * `interval` 模式算的是**排定时刻**（固定节拍）：每 30 分钟就是 :00 与 :30，
 * 每 6 小时就是 00/06/12/18 —— 一次备份跑多久都不会把后续时间点往后推。
 *
 * @module dsh-plugin-oss-backup/schedule
 */

/** 调度模式。 */
export type ScheduleMode = 'off' | 'interval' | 'daily' | 'monthly'

/** `interval` 模式的单位。 */
export type IntervalUnit = 'minute' | 'hour' | 'day'

/** 一份调度设置。 */
export interface BackupSchedule {
  /** 模式。 */
  readonly mode: ScheduleMode
  /** `interval` 模式：间隔数值（至少 1）。 */
  readonly every: number
  /** `interval` 模式：单位。 */
  readonly unit: IntervalUnit
  /** `daily` / `monthly` 模式：小时（0-23）。 */
  readonly hour: number
  /** `daily` / `monthly` 模式：分钟（0-59）。 */
  readonly minute: number
  /** `monthly` 模式：每月几号（1-28）。 */
  readonly dayOfMonth: number
}

/** 出厂调度：关闭。 */
export const DEFAULT_SCHEDULE: BackupSchedule = {
  mode: 'off',
  every: 1,
  unit: 'hour',
  hour: 3,
  minute: 0,
  dayOfMonth: 1,
}

/** 每个单位对应多少毫秒。 */
const UNIT_MS: Readonly<Record<IntervalUnit, number>> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

/**
 * 把"每月几号"钳到 1-28。
 *
 * 刻意不支持 29/30/31：那样会遇到"2 月没有 30 号"这类问题，要么跳过一个月、
 * 要么被 `Date` 自动顺延到下个月 1 号 —— 两种都会让用户觉得"没按我设的跑"。
 * 统一限制在 1-28，每个月都一定存在。
 *
 * @param value - 原始值。
 * @returns 1-28 之间的整数。
 */
export function clampDayOfMonth(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(28, Math.max(1, Math.floor(value)))
}

/**
 * 把"小时 / 分钟"钳到合法范围。
 *
 * @param value - 原始值。
 * @param max - 上界（含）。
 * @returns 0..max 之间的整数。
 */
function clampClock(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(max, Math.max(0, Math.floor(value)))
}

/**
 * 收窄一份外部输入成调度设置。
 *
 * @param input - 外部输入（请求体或文件内容）。
 * @param base - 缺省值来源。
 * @returns 完整调度设置。
 */
export function normalizeSchedule(
  input: unknown,
  base: BackupSchedule = DEFAULT_SCHEDULE,
): BackupSchedule {
  if (input === null || typeof input !== 'object') return base
  const record = input as Record<string, unknown>

  const mode =
    record.mode === 'off' || record.mode === 'interval' || record.mode === 'daily' || record.mode === 'monthly'
      ? record.mode
      : base.mode

  const every =
    typeof record.every === 'number' && Number.isFinite(record.every) && record.every >= 1
      ? Math.floor(record.every)
      : base.every

  const unit =
    record.unit === 'minute' || record.unit === 'hour' || record.unit === 'day' ? record.unit : base.unit

  const hour = typeof record.hour === 'number' ? clampClock(record.hour, 23) : base.hour
  const minute = typeof record.minute === 'number' ? clampClock(record.minute, 59) : base.minute
  const dayOfMonth =
    typeof record.dayOfMonth === 'number' ? clampDayOfMonth(record.dayOfMonth) : base.dayOfMonth

  return { mode, every, unit, hour, minute, dayOfMonth }
}

/**
 * 算出"从 `from` 时刻起，下一次该备份的时刻"。
 *
 * @param schedule - 调度设置。
 * @param from - 起点（毫秒时间戳）。
 * @returns 下次触发时刻；`off` 或参数非法时返回 `null`。
 *
 * `interval` 模式对齐到**排定时刻**（固定节拍），而不是"从 `from` 往后加一段"：
 * 一次备份跑多久都不会把后续时间点往后推。
 */
export function nextRunAt(schedule: BackupSchedule, from: number): number | null {
  if (schedule.mode === 'off') return null
  if (!Number.isFinite(from)) return null

  if (schedule.mode === 'interval') {
    const every = Math.max(1, Math.floor(schedule.every))
    const step = every * UNIT_MS[schedule.unit]

    if (schedule.unit === 'day') {
      // 「每 N 天」对齐到**当地零点**的固定节拍：按"绝对天数 % N"取余，
      // 这样今天是哪天都不影响节拍（否则会今天算后天、后天再算大后天，一路漂下去）。
      const midnight = new Date(from)
      midnight.setHours(0, 0, 0, 0)
      const dayIndex = Math.floor(midnight.getTime() / UNIT_MS.day)
      const remainder = ((dayIndex % every) + every) % every
      const addDays = remainder === 0 ? every : every - remainder
      midnight.setDate(midnight.getDate() + addDays)
      return midnight.getTime()
    }

    // 分钟 / 小时：按**绝对时间**取模对齐到排定时刻 —— 每 30 分钟就是 :00 和 :30，
    // 每 6 小时就是 00/06/12/18。固定节拍，与时区无关。
    return Math.floor(from / step) * step + step
  }

  if (schedule.mode === 'daily') {
    const next = new Date(from)
    next.setHours(clampClock(schedule.hour, 23), clampClock(schedule.minute, 59), 0, 0)
    // 今天这个点已经过了（或正好等于）就顺延到明天。
    if (next.getTime() <= from) next.setDate(next.getDate() + 1)
    return next.getTime()
  }

  // monthly
  const day = clampDayOfMonth(schedule.dayOfMonth)
  const next = new Date(from)
  next.setDate(day)
  next.setHours(clampClock(schedule.hour, 23), clampClock(schedule.minute, 59), 0, 0)
  if (next.getTime() <= from) {
    // 换月之后必须重设日期：setMonth 会按"当月天数"调整，先设日期再换月才稳。
    next.setMonth(next.getMonth() + 1)
    next.setDate(day)
  }
  return next.getTime()
}

/**
 * 一句话描述这个调度（给界面用）。
 *
 * @param schedule - 调度设置。
 * @returns 中文描述。
 */
export function describeSchedule(schedule: BackupSchedule): string {
  const hh = String(clampClock(schedule.hour, 23)).padStart(2, '0')
  const mm = String(clampClock(schedule.minute, 59)).padStart(2, '0')
  const unitLabel: Record<IntervalUnit, string> = { minute: '分钟', hour: '小时', day: '天' }

  switch (schedule.mode) {
    case 'off':
      return '关闭'
    case 'interval':
      return `每 ${Math.max(1, Math.floor(schedule.every))} ${unitLabel[schedule.unit]}`
    case 'daily':
      return `每天 ${hh}:${mm}`
    case 'monthly':
      return `每月 ${clampDayOfMonth(schedule.dayOfMonth)} 日 ${hh}:${mm}`
  }
}
