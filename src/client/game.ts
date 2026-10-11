/**
 * 「备份前的小游戏」—— 纯逻辑部分（不碰 DOM，方便单测）。
 *
 * 玩法：把上传条拆成一份一份的，四条轨道从右往左滑，左侧有一条判定线；
 * 经过判定线时点掉它（键盘 `D` `F` `J` `K` 或直接点那条轨道）。
 *
 * 判定分三级：
 *   · **perfect** —— 在 {@link PERFECT_WINDOW_MS} 内点中，**不扣分**；
 *   · **good**    —— 在 {@link HIT_WINDOW_MS} 内但不够准，按权重扣分；
 *   · **lost**    —— 过了窗口都没点，按权重扣分。
 *
 * 扣分按**总 note 数分摊**：
 *   扣分 = round((good × {@link GOOD_WEIGHT} + lost) / total × 100)
 * 这样四档难度（密度差了好几倍）的容错率一致 —— 固定扣分会让高难度变得不可能。
 * 参考：全 perfect = 100 分；全 good = 50 分；全 lost = 0 分。
 *
 * @module dsh-plugin-oss-backup/client/game
 */

/** 四档难度。 */
export type GameDifficulty = 'zayu' | 'easy' | 'normal' | 'hard'

/** 一档难度的参数。 */
export interface DifficultySpec {
  /** 标识。 */
  readonly id: GameDifficulty
  /** 界面上的名字。 */
  readonly label: string
  /** 一句话说明。 */
  readonly hint: string
  /** 谱面时长（毫秒）：从第一条 note 的判定时刻算到最后一条。 */
  readonly durationMs: number
  /** 相邻两条 note 的间隔（毫秒）—— 越小越密。 */
  readonly intervalMs: number
  /** 从右边缘滑到判定线所需时间（毫秒）—— 越小越快。 */
  readonly fallMs: number
}

/** 四档难度，按难度递增排列。 */
export const DIFFICULTIES: readonly DifficultySpec[] = [
  {
    id: 'zayu',
    label: '杂鱼',
    hint: '慢悠悠，够你认键',
    durationMs: 18_000,
    intervalMs: 1_400,
    fallMs: 3_500,
  },
  {
    id: 'easy',
    label: '简单',
    hint: '有点节奏感就行',
    durationMs: 26_000,
    intervalMs: 950,
    fallMs: 2_800,
  },
  {
    id: 'normal',
    label: '中等',
    hint: '手要跟上眼睛',
    durationMs: 34_000,
    intervalMs: 700,
    fallMs: 2_200,
  },
  {
    id: 'hard',
    label: '齁哦哦哦',
    hint: '只有高手才过得去',
    // 这一档是刻意做难的：下落时间砍到 1.15 秒、间隔压到 0.38 秒 ——
    // 判定线上同时会有 3 个方块在窗口里，得靠节奏记忆而不是反应。
    durationMs: 44_000,
    intervalMs: 380,
    fallMs: 1_150,
  },
]

/** 默认难度。 */
export const DEFAULT_DIFFICULTY: GameDifficulty = 'easy'

/**
 * 取一档难度。
 *
 * @param id - 难度标识。
 * @returns 难度参数；标识不认识时返回默认档。
 */
export function difficultyOf(id: string): DifficultySpec {
  return DIFFICULTIES.find((item) => item.id === id) ?? DIFFICULTIES[1]!
}

/** 轨道数量。 */
export const TRACK_COUNT = 4

/** 判定线的位置（占轨道宽度的比例，从左边缘算起）。 */
export const JUDGE_RATIO = 0.16

/**
 * 精确判定窗口（毫秒）：在这个范围内点中算 **perfect**，不扣分。
 *
 * 90ms 相当严 —— 大致是"跟着节奏正好按下去"的水平（一般音游的 perfect 在 ±40~80ms，
 * 这里留了一点余量，但绝不是随便点就能拿到）。
 */
export const PERFECT_WINDOW_MS = 90

/**
 * 宽松判定窗口（毫秒）：超出它就彻底算漏（**lost**）。
 *
 * 175ms 比常见音游的 good 还紧一些 —— 松了谁都能过，那就没意思了。
 */
export const HIT_WINDOW_MS = 175

/** good 的扣分权重：perfect 是 0，lost 是 1，good 取中间。 */
export const GOOD_WEIGHT = 0.5

/**
 * 扣分**达到**这个值就判定失败（此时备份不触发）。
 *
 * 30 分相当严：漏掉三成方块就没了。注意是"达到即失败" —— 扣 29 算过，扣 30 不算。
 */
export const FAIL_THRESHOLD = 30

/** 判定等级。 */
export type NoteGrade = 'perfect' | 'good' | 'lost'

/** 键盘按键到轨道的映射（音游常见的四键布局）。 */
export const KEY_TO_TRACK: Readonly<Record<string, number>> = {
  d: 0,
  f: 1,
  j: 2,
  k: 3,
}

/** 每条轨道对应的键帽文字。 */
export const TRACK_KEYS: readonly string[] = ['D', 'F', 'J', 'K']

/** 一条 note。 */
export interface GameNote {
  /** 唯一 id。 */
  readonly id: number
  /** 轨道（0 起始）。 */
  readonly track: number
  /** 该 note 应该被点掉的时刻（毫秒，相对游戏开始）。 */
  readonly hitTimeMs: number
  /** 判定状态（就地更新，避免每帧复制整个数组）。 */
  state: 'pending' | NoteGrade
}

/**
 * 生成一局谱面。
 *
 * @param spec - 难度。
 * @param random - 随机源（测试可注入固定值）。
 * @returns note 列表。
 */
export function buildChart(spec: DifficultySpec, random: () => number = Math.random): GameNote[] {
  const notes: GameNote[] = []
  // 第一条 note 也要留出完整的下落时间，否则它一出现就已经在判定线上了。
  const first = spec.fallMs
  const last = first + spec.durationMs
  let at = first
  let id = 0
  let previousTrack = -1

  while (at <= last) {
    let track = Math.floor(random() * TRACK_COUNT)
    // 避免与上一条同轨：连续同轨在视觉上会糊成一条，手感也差。
    if (track === previousTrack) track = (track + 1) % TRACK_COUNT
    previousTrack = track
    notes.push({ id, track, hitTimeMs: at, state: 'pending' })
    id += 1
    at += spec.intervalMs
  }
  return notes
}

/** 一次命中的结果。 */
export interface HitResult {
  /** 命中的 note id。 */
  readonly id: number
  /** 判定等级（只可能是 perfect 或 good）。 */
  readonly grade: 'perfect' | 'good'
}

/** 一局的结果。 */
export interface GameOutcome {
  /** 总 note 数。 */
  readonly total: number
  /** perfect 数。 */
  readonly perfect: number
  /** good 数。 */
  readonly good: number
  /** lost 数。 */
  readonly lost: number
  /** 扣分（0-100）。 */
  readonly deduction: number
  /** 得分（100 - 扣分）。 */
  readonly score: number
  /** 是否通过 —— 通过才触发备份。 */
  readonly passed: boolean
}

/**
 * 结算一局。
 *
 * @param notes - 判定完毕的 note 列表。
 * @returns 结果。
 */
export function settle(notes: readonly GameNote[]): GameOutcome {
  const total = notes.length
  let perfect = 0
  let good = 0
  let lost = 0
  for (const note of notes) {
    if (note.state === 'perfect') perfect += 1
    else if (note.state === 'good') good += 1
    else if (note.state === 'lost') lost += 1
  }

  // 扣分按总 note 数分摊：perfect 不计，good 算半个，lost 算一个。
  const deduction = total === 0 ? 0 : Math.round(((good * GOOD_WEIGHT + lost) / total) * 100)
  const score = 100 - deduction
  return { total, perfect, good, lost, deduction, score, passed: deduction < FAIL_THRESHOLD }
}

/**
 * 失败时的嘲讽。
 *
 * 按"漏掉的比例"分档 —— 漏得越多，话说得越不留情。基调是「被抓住了。。。」
 * （呼应插件里那句"代码在自己上传"，这里就是"代码被抓住了"）。
 *
 * 只在失败时用；成功时不给这句话，免得赢了还被阴阳。
 *
 * @param outcome - 结算结果。
 * @returns 一句嘲讽。
 */
export function tauntFor(outcome: GameOutcome): string {
  const total = Math.max(1, outcome.total)
  const ratio = outcome.lost / total
  if (ratio >= 0.8) return '被抓住了。。。代码全跑光了，你是闭着眼睛按的吗'
  if (ratio >= 0.6) return '被抓住了。。。手速跟不上，先去练两把'
  if (ratio >= 0.4) return '被抓住了。。。就差那么一点点'
  return '被抓住了。。。差点就成功了，再来一次'
}

/**
 * 计算某条 note 在某一时刻的横向位置。
 *
 * @param note - note。
 * @param nowMs - 当前时刻（相对游戏开始）。
 * @param fallMs - 下落时长。
 * @returns 比例：1 = 最右，{@link JUDGE_RATIO} = 正好在判定线上，更小 = 已飞过判定线。
 */
export function notePosition(note: GameNote, nowMs: number, fallMs: number): number {
  const appearAt = note.hitTimeMs - fallMs
  const elapsed = nowMs - appearAt
  if (elapsed <= 0) return 1
  // 越过判定线之后还让它继续飞一小段（1.6 倍），这样"漏掉"是看得见的。
  const progress = Math.min(elapsed / fallMs, 1.6)
  return 1 - progress * (1 - JUDGE_RATIO)
}

/**
 * 判断一次点击命中了哪条 note，以及是什么等级。
 *
 * 同一轨道上可能有多条处于判定窗口内（高密度档才会出现），取**离判定线最近**的那条。
 *
 * @param notes - 当前 note 列表。
 * @param track - 被点击的轨道。
 * @param nowMs - 当前时刻。
 * @returns 命中结果；没命中返回 `null`。
 */
export function pickHit(notes: readonly GameNote[], track: number, nowMs: number): HitResult | null {
  let bestId: number | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (const note of notes) {
    if (note.track !== track || note.state !== 'pending') continue
    const delta = Math.abs(note.hitTimeMs - nowMs)
    if (delta > HIT_WINDOW_MS) continue
    if (delta < bestDelta) {
      bestDelta = delta
      bestId = note.id
    }
  }
  if (bestId === null) return null
  return { id: bestId, grade: bestDelta <= PERFECT_WINDOW_MS ? 'perfect' : 'good' }
}

/**
 * 把已经错过判定窗口的 note 标记为漏掉（lost）。
 *
 * @param notes - note 列表（就地更新）。
 * @param nowMs - 当前时刻。
 * @returns 本次新标记的数量。
 */
export function sweepMisses(notes: readonly GameNote[], nowMs: number): number {
  let count = 0
  for (const note of notes) {
    if (note.state === 'pending' && nowMs - note.hitTimeMs > HIT_WINDOW_MS) {
      note.state = 'lost'
      count += 1
    }
  }
  return count
}

/**
 * 一局的总时长（毫秒）：含第一条 note 的下落时间。
 *
 * @param spec - 难度。
 * @returns 毫秒。
 */
export function totalDurationMs(spec: DifficultySpec): number {
  return spec.fallMs + spec.durationMs + HIT_WINDOW_MS
}
