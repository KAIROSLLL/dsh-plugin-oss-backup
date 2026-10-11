/**
 * 定期全量备份调度的测试。
 *
 * 全是不碰定时器的纯函数 —— "该在什么时候跑"这件事必须能确定性地测，
 * 否则只能靠等到半夜三点看它有没有触发。
 *
 * @module tests/schedule.spec
 */

import { describe, expect, it } from 'vitest'
import {
  clampDayOfMonth,
  DEFAULT_SCHEDULE,
  describeSchedule,
  nextRunAt,
  normalizeSchedule,
  type BackupSchedule,
} from '../src/schedule.js'

/** 造一份调度设置。 */
function sched(patch: Partial<BackupSchedule>): BackupSchedule {
  return { ...DEFAULT_SCHEDULE, ...patch }
}

describe('normalizeSchedule', () => {
  it('缺省 / 类型不对时回退出厂值', () => {
    expect(normalizeSchedule(null)).toEqual(DEFAULT_SCHEDULE)
    expect(normalizeSchedule('nope')).toEqual(DEFAULT_SCHEDULE)
    expect(normalizeSchedule({})).toEqual(DEFAULT_SCHEDULE)
  })

  it('越界的数字会被钳住，而不是原样放进配置', () => {
    const result = normalizeSchedule({ mode: 'daily', hour: 99, minute: -5, every: 0, dayOfMonth: 40 })
    expect(result.mode).toBe('daily')
    expect(result.hour).toBe(23)
    expect(result.minute).toBe(0)
    expect(result.every).toBe(1)
    expect(result.dayOfMonth).toBe(28)
  })

  it('不认识的 mode / unit 回退到基准值（不炸、不静默变成别的模式）', () => {
    const base = sched({ mode: 'monthly', unit: 'day' })
    const result = normalizeSchedule({ mode: 'nope', unit: 'nope' }, base)
    expect(result.mode).toBe('monthly')
    expect(result.unit).toBe('day')
  })
})

describe('nextRunAt：按间隔', () => {
  // 用 UTC 时间戳，避免把时区牵扯进来。
  const from = Date.UTC(2026, 0, 15, 10, 0, 0)

  it('分钟 / 小时 / 天三种单位', () => {
    expect(nextRunAt(sched({ mode: 'interval', every: 30, unit: 'minute' }), from)).toBe(from + 30 * 60_000)
    expect(nextRunAt(sched({ mode: 'interval', every: 2, unit: 'hour' }), from)).toBe(from + 2 * 3_600_000)
    expect(nextRunAt(sched({ mode: 'interval', every: 1, unit: 'day' }), from)).toBe(from + 86_400_000)
  })

  it('every 写成 0 也至少按 1 算（否则会变成"立刻再跑一次"的死循环）', () => {
    expect(nextRunAt(sched({ mode: 'interval', every: 0, unit: 'minute' }), from)).toBe(from + 60_000)
  })
})

describe('nextRunAt：每天', () => {
  it('今天还没到点 → 就在今天', () => {
    const from = new Date(2026, 0, 15, 10, 0, 0).getTime()
    const at = nextRunAt(sched({ mode: 'daily', hour: 18, minute: 30 }), from)
    const date = new Date(at ?? 0)
    expect(date.getDate()).toBe(15)
    expect(date.getHours()).toBe(18)
    expect(date.getMinutes()).toBe(30)
    expect(date.getSeconds()).toBe(0)
  })

  it('今天已经过点 → 顺延到明天', () => {
    const from = new Date(2026, 0, 15, 20, 0, 0).getTime()
    const date = new Date(nextRunAt(sched({ mode: 'daily', hour: 3, minute: 0 }), from) ?? 0)
    expect(date.getDate()).toBe(16)
    expect(date.getHours()).toBe(3)
  })

  it('正好等于当前时刻也算"过了"，顺延到明天（否则会原地重排、反复触发）', () => {
    const from = new Date(2026, 0, 15, 3, 0, 0).getTime()
    const at = nextRunAt(sched({ mode: 'daily', hour: 3, minute: 0 }), from) ?? 0
    expect(at).toBeGreaterThan(from)
    expect(new Date(at).getDate()).toBe(16)
  })
})

describe('nextRunAt：每月', () => {
  it('本月还没到 → 本月', () => {
    const from = new Date(2026, 0, 10, 10, 0, 0).getTime()
    const date = new Date(nextRunAt(sched({ mode: 'monthly', dayOfMonth: 20, hour: 3, minute: 0 }), from) ?? 0)
    expect(date.getMonth()).toBe(0)
    expect(date.getDate()).toBe(20)
  })

  it('本月已经过 → 下个月同一天', () => {
    const from = new Date(2026, 0, 25, 10, 0, 0).getTime()
    const date = new Date(nextRunAt(sched({ mode: 'monthly', dayOfMonth: 5, hour: 3, minute: 0 }), from) ?? 0)
    expect(date.getMonth()).toBe(1)
    expect(date.getDate()).toBe(5)
  })

  it('跨年也对：12 月的下一次落在次年 1 月', () => {
    const from = new Date(2026, 11, 20, 10, 0, 0).getTime()
    const date = new Date(nextRunAt(sched({ mode: 'monthly', dayOfMonth: 5, hour: 3, minute: 0 }), from) ?? 0)
    expect(date.getFullYear()).toBe(2027)
    expect(date.getMonth()).toBe(0)
    expect(date.getDate()).toBe(5)
  })

  it('2 月也安全 —— 这正是只支持 1-28 号的原因', () => {
    const from = new Date(2026, 1, 1, 10, 0, 0).getTime()
    const date = new Date(nextRunAt(sched({ mode: 'monthly', dayOfMonth: 28, hour: 3, minute: 0 }), from) ?? 0)
    expect(date.getMonth()).toBe(1)
    expect(date.getDate()).toBe(28)
  })

  it('连闰年 2 月都不会被顺延到 3 月', () => {
    const from = new Date(2028, 1, 1, 10, 0, 0).getTime()
    const date = new Date(nextRunAt(sched({ mode: 'monthly', dayOfMonth: 28, hour: 3, minute: 0 }), from) ?? 0)
    expect(date.getMonth()).toBe(1)
    expect(date.getDate()).toBe(28)
  })
})

describe('nextRunAt：关闭与非法输入', () => {
  it('off 永远返回 null', () => {
    expect(nextRunAt(sched({ mode: 'off' }), Date.now())).toBeNull()
  })

  it('起点不合法时返回 null，而不是造出一个 NaN 时间', () => {
    expect(nextRunAt(sched({ mode: 'daily' }), Number.NaN)).toBeNull()
    expect(nextRunAt(sched({ mode: 'interval' }), Number.NaN)).toBeNull()
  })
})

describe('clampDayOfMonth', () => {
  it('钳到 1-28', () => {
    expect(clampDayOfMonth(0)).toBe(1)
    expect(clampDayOfMonth(-10)).toBe(1)
    expect(clampDayOfMonth(29)).toBe(28)
    expect(clampDayOfMonth(15)).toBe(15)
    expect(clampDayOfMonth(Number.NaN)).toBe(1)
    expect(clampDayOfMonth(3.9)).toBe(3)
  })
})

describe('describeSchedule', () => {
  it('四种模式都能说成人话', () => {
    expect(describeSchedule(sched({ mode: 'off' }))).toBe('关闭')
    expect(describeSchedule(sched({ mode: 'interval', every: 30, unit: 'minute' }))).toBe('每 30 分钟')
    expect(describeSchedule(sched({ mode: 'interval', every: 6, unit: 'hour' }))).toBe('每 6 小时')
    expect(describeSchedule(sched({ mode: 'interval', every: 2, unit: 'day' }))).toBe('每 2 天')
    expect(describeSchedule(sched({ mode: 'daily', hour: 3, minute: 5 }))).toBe('每天 03:05')
    expect(describeSchedule(sched({ mode: 'monthly', dayOfMonth: 1, hour: 3, minute: 0 }))).toBe('每月 1 日 03:00')
  })

  it('时刻补零（3:05 而不是 3:5）', () => {
    expect(describeSchedule(sched({ mode: 'daily', hour: 3, minute: 5 }))).toContain('03:05')
  })
})
