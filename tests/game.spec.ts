/**
 * 备份前小游戏的逻辑测试。
 *
 * 这里全是纯函数，不碰 DOM —— 所以判定分级、计分规则、谱面生成都能在 CI 上跑。
 *
 * @module tests/game.spec
 */

import { describe, expect, it } from 'vitest'
import {
  buildChart,
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  difficultyOf,
  GOOD_WEIGHT,
  HIT_WINDOW_MS,
  JUDGE_RATIO,
  KEY_TO_TRACK,
  notePosition,
  PERFECT_WINDOW_MS,
  pickHit,
  settle,
  sweepMisses,
  tauntFor,
  totalDurationMs,
  TRACK_COUNT,
  TRACK_KEYS,
  type GameNote,
} from '../src/client/game.js'

/** 造一条 note。 */
function note(id: number, track: number, hitTimeMs: number, state: GameNote['state'] = 'pending'): GameNote {
  return { id, track, hitTimeMs, state }
}

/** 造一局：指定 perfect / good / lost 各多少条。 */
function round(perfect: number, good: number, lost: number): GameNote[] {
  const notes: GameNote[] = []
  let id = 0
  for (let index = 0; index < perfect; index += 1) notes.push(note(id++, 0, 0, 'perfect'))
  for (let index = 0; index < good; index += 1) notes.push(note(id++, 0, 0, 'good'))
  for (let index = 0; index < lost; index += 1) notes.push(note(id++, 0, 0, 'lost'))
  return notes
}

describe('四档难度', () => {
  it('名字就是那四个', () => {
    expect(DIFFICULTIES.map((item) => item.label)).toEqual(['杂鱼', '简单', '中等', '齁哦哦哦'])
  })

  it('每一档都控制在 1 分钟以内', () => {
    for (const spec of DIFFICULTIES) {
      expect(totalDurationMs(spec)).toBeLessThan(60_000)
    }
  })

  it('难度递增：下落更快、间隔更密', () => {
    for (let index = 1; index < DIFFICULTIES.length; index += 1) {
      const previous = DIFFICULTIES[index - 1]!
      const current = DIFFICULTIES[index]!
      expect(current.fallMs).toBeLessThan(previous.fallMs)
      expect(current.intervalMs).toBeLessThan(previous.intervalMs)
    }
  })

  it('difficultyOf：认识的给那一档，不认识的给默认档', () => {
    expect(difficultyOf('hard').id).toBe('hard')
    expect(difficultyOf('不存在的东西').id).toBe(DEFAULT_DIFFICULTY)
  })
})

describe('buildChart', () => {
  it('四档都能生成谱面，轨道与初始状态都合法', () => {
    for (const spec of DIFFICULTIES) {
      const notes = buildChart(spec, () => 0.5)
      expect(notes.length).toBeGreaterThan(5)
      for (const item of notes) {
        expect(item.track).toBeGreaterThanOrEqual(0)
        expect(item.track).toBeLessThan(TRACK_COUNT)
        expect(item.state).toBe('pending')
      }
    }
  })

  it('第一条 note 留出了完整下落时间（不会一出现就在判定线上）', () => {
    for (const spec of DIFFICULTIES) {
      expect(buildChart(spec, () => 0)[0]!.hitTimeMs).toBe(spec.fallMs)
    }
  })

  it('相邻两条不同轨 —— 同轨连续会视觉糊在一起', () => {
    const notes = buildChart(DIFFICULTIES[3]!, () => 0.99)
    for (let index = 1; index < notes.length; index += 1) {
      expect(notes[index]!.track).not.toBe(notes[index - 1]!.track)
    }
  })

  it('id 不重复', () => {
    const notes = buildChart(DIFFICULTIES[2]!)
    expect(new Set(notes.map((item) => item.id)).size).toBe(notes.length)
  })

  it('难度越高 note 越多', () => {
    const counts = DIFFICULTIES.map((spec) => buildChart(spec, () => 0.3).length)
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index]!).toBeGreaterThan(counts[index - 1]!)
    }
  })
})

describe('notePosition', () => {
  it('出现的那一刻在最右，判定时刻正好落在判定线上', () => {
    const item = note(0, 0, 2000)
    expect(notePosition(item, 2000 - 1000, 1000)).toBeCloseTo(1, 5)
    expect(notePosition(item, 2000, 1000)).toBeCloseTo(JUDGE_RATIO, 5)
  })

  it('还没出现时贴在最右，飞过之后继续往左（看得见"漏了"）', () => {
    const item = note(0, 0, 2000)
    expect(notePosition(item, 0, 1000)).toBe(1)
    expect(notePosition(item, 2600, 1000)).toBeLessThan(JUDGE_RATIO)
  })
})

describe('pickHit 与判定分级', () => {
  it('精确窗口内算 perfect（不扣分）', () => {
    expect(pickHit([note(0, 0, 1000)], 0, 1000)).toEqual({ id: 0, grade: 'perfect' })
    expect(pickHit([note(0, 0, 1000)], 0, 1000 + PERFECT_WINDOW_MS)?.grade).toBe('perfect')
    expect(pickHit([note(0, 0, 1000)], 0, 1000 - PERFECT_WINDOW_MS)?.grade).toBe('perfect')
  })

  it('精确窗口之外、宽松窗口之内算 good', () => {
    expect(pickHit([note(0, 0, 1000)], 0, 1000 + PERFECT_WINDOW_MS + 1)?.grade).toBe('good')
    expect(pickHit([note(0, 0, 1000)], 0, 1000 + HIT_WINDOW_MS)?.grade).toBe('good')
    expect(pickHit([note(0, 0, 1000)], 0, 1000 - HIT_WINDOW_MS)?.grade).toBe('good')
  })

  it('超出宽松窗口就完全不算命中（之后会变成 lost）', () => {
    expect(pickHit([note(0, 0, 1000)], 0, 1000 + HIT_WINDOW_MS + 1)).toBeNull()
    expect(pickHit([note(0, 0, 1000)], 0, 1000 - HIT_WINDOW_MS - 1)).toBeNull()
  })

  it('只在被点的那条轨道上找', () => {
    const notes = [note(0, 0, 1000), note(1, 1, 1000)]
    expect(pickHit(notes, 1, 1000)?.id).toBe(1)
    expect(pickHit(notes, 3, 1000)).toBeNull()
  })

  it('同轨有多条落在窗口内时，取离判定线最近的那条', () => {
    const notes = [note(0, 0, 1000), note(1, 0, 1200)]
    expect(pickHit(notes, 0, 1010)?.id).toBe(0)
    expect(pickHit(notes, 0, 1190)?.id).toBe(1)
  })

  it('已经判定过的不会被重复命中', () => {
    expect(pickHit([note(0, 0, 1000, 'perfect')], 0, 1000)).toBeNull()
    expect(pickHit([note(0, 0, 1000, 'good')], 0, 1000)).toBeNull()
    expect(pickHit([note(0, 0, 1000, 'lost')], 0, 1000)).toBeNull()
  })
})

describe('sweepMisses', () => {
  it('只有过了宽松窗口的 pending 才变成 lost', () => {
    const notes = [note(0, 0, 1000), note(1, 0, 1500)]
    expect(sweepMisses(notes, 1000 + HIT_WINDOW_MS + 1)).toBe(1)
    expect(notes[0]!.state).toBe('lost')
    expect(notes[1]!.state).toBe('pending')
  })

  it('重复调用不会重复计数', () => {
    const notes = [note(0, 0, 1000)]
    expect(sweepMisses(notes, 5000)).toBe(1)
    expect(sweepMisses(notes, 6000)).toBe(0)
  })
})

describe('settle：perfect 不扣分，good / lost 按总 note 数分摊', () => {
  it('全 perfect = 100 分，通过', () => {
    expect(settle(round(4, 0, 0))).toEqual({
      total: 4,
      perfect: 4,
      good: 0,
      lost: 0,
      deduction: 0,
      score: 100,
      passed: true,
    })
  })

  it('全 good = 50 分（good 权重 0.5）', () => {
    const outcome = settle(round(0, 4, 0))
    expect(outcome.deduction).toBe(50)
    expect(outcome.score).toBe(50)
    expect(outcome.passed).toBe(false)
  })

  it('全 lost = 0 分', () => {
    const outcome = settle(round(0, 0, 4))
    expect(outcome.deduction).toBe(100)
    expect(outcome.score).toBe(0)
    expect(outcome.passed).toBe(false)
  })

  it('扣分只看比例，与 note 总数无关 —— 四档难度容错率才一致', () => {
    expect(settle(round(60, 0, 40)).deduction).toBe(40)
    expect(settle(round(7, 0, 5)).deduction).toBe(42)
  })

  it('good 与 lost 混着算', () => {
    // 10 条：4 perfect + 3 good + 3 lost → (3×0.5 + 3)/10 = 45%
    const outcome = settle(round(4, 3, 3))
    expect(outcome).toMatchObject({ total: 10, perfect: 4, good: 3, lost: 3, deduction: 45, score: 55 })
    expect(outcome.passed).toBe(false)
  })

  it('扣 29 算通过，扣到 30 就失败（阈值是"达到即失败"）', () => {
    const pass = settle(round(71, 0, 29))
    expect(pass.deduction).toBe(29)
    expect(pass.passed).toBe(true)

    const fail = settle(round(70, 0, 30))
    expect(fail.deduction).toBe(30)
    expect(fail.passed).toBe(false)
  })

  it('空谱面不炸（除零保护）', () => {
    expect(settle([])).toEqual({
      total: 0,
      perfect: 0,
      good: 0,
      lost: 0,
      deduction: 0,
      score: 100,
      passed: true,
    })
  })

  it('权重常量就是"perfect 0 / good 半个 / lost 一个"', () => {
    expect(GOOD_WEIGHT).toBe(0.5)
    expect(PERFECT_WINDOW_MS).toBeLessThan(HIT_WINDOW_MS)
  })
})

describe('键位', () => {
  it('就是 D F J K 四键，与轨道数对齐', () => {
    expect(Object.keys(KEY_TO_TRACK).sort()).toEqual(['d', 'f', 'j', 'k'])
    expect(TRACK_KEYS).toHaveLength(TRACK_COUNT)
    for (const value of Object.values(KEY_TO_TRACK)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(TRACK_COUNT)
    }
  })
})

describe('失败嘲讽', () => {
  it('不管漏多少，都以"被抓住了"开头（这就是这个游戏的梗）', () => {
    // 注意：这些用例必须**都是失败的**（扣分 > 40）—— 40 分及以下算通关。
    const outcomes = [
      settle(round(1, 0, 11)), // 漏 91.7%
      settle(round(2, 0, 8)), // 漏 80%
      settle(round(4, 0, 6)), // 漏 60%
      settle(round(5, 0, 6)), // 漏 54.5%
      settle(round(0, 10, 0)), // 一个没漏，但全是 good（扣 50）
    ]
    for (const outcome of outcomes) {
      expect(outcome.passed).toBe(false)
      expect(tauntFor(outcome)).toContain('被抓住了')
    }
  })

  it('全 good 也会失败（扣 50 分），同样挨嘲讽', () => {
    const outcome = settle(round(0, 10, 0))
    expect(outcome.deduction).toBe(50)
    expect(outcome.passed).toBe(false)
    expect(tauntFor(outcome)).toContain('被抓住了')
  })

  it('漏得越多，话越不留情（不同档位文案确实不同）', () => {
    const worst = tauntFor(settle(round(1, 0, 11)))
    const best = tauntFor(settle(round(0, 10, 0)))
    expect(worst).not.toBe(best)
  })

  it('空谱面也不炸', () => {
    expect(tauntFor(settle([]))).toContain('被抓住了')
  })
})

describe('难度参数（收紧之后）', () => {
  it('判定够严：perfect 窗口 ≤ 100ms，good 窗口 ≤ 200ms', () => {
    expect(PERFECT_WINDOW_MS).toBeLessThanOrEqual(100)
    expect(HIT_WINDOW_MS).toBeLessThanOrEqual(200)
  })

  it('「齁哦哦哦」明显比中等难：下落更快、间隔更密', () => {
    const normal = difficultyOf('normal')
    const hard = difficultyOf('hard')
    expect(hard.fallMs).toBeLessThan(normal.fallMs * 0.7)
    expect(hard.intervalMs).toBeLessThan(normal.intervalMs * 0.7)
  })

  it('「齁哦哦哦」的判定线上会同时有多个方块 —— 得靠节奏记忆而不是纯反应', () => {
    const hard = difficultyOf('hard')
    expect(hard.fallMs / hard.intervalMs).toBeGreaterThan(2.5)
  })

  it('四档仍然都在 1 分钟以内', () => {
    expect(totalDurationMs(difficultyOf('hard'))).toBeLessThan(60_000)
  })
})
