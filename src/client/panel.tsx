/**
 * 设置页 / 侧边栏 / 主面板的界面（Client 半边）。
 *
 * 视觉语言参考 dsh-users-open-source 的设置页（指标卡 + 状态块 + 迷你柱状图 + 记录列表 +
 * 按钮胶囊），但**只借设计，不搬功能**：那套是回环测速，这里的数据全部来自本插件自己的
 * 脱敏状态路由 `GET /oss-backup/state`。
 *
 * 三条设计基调：
 *   · **只读** —— 界面上没有、也不该有凭证输入框；凭证永远只显示"是否已设置"；
 *   · **云端备份**按钮只负责打开 RustFS 控制台（`http://127.0.0.1:9001/`），
 *     不碰本地文件系统；
 *   · 上传进行中（`busy`）时弹出一张图，侧栏与面板共用同一个绘制件。
 *
 * @module dsh-plugin-oss-backup/client/panel
 */

import * as React from 'react'
import {
  fetchState,
  saveCredentials,
  saveSettings,
  FAIL_PATH,
  SHOT_PATH,
  startManualBackup,
  type AutoBackupReport,
  type PluginSettingsView,
  type StateSnapshot,
  type UploadRecord,
} from './api'
import {
  buildChart,
  DIFFICULTIES,
  difficultyOf,
  GOOD_WEIGHT,
  JUDGE_RATIO,
  KEY_TO_TRACK,
  notePosition,
  pickHit,
  settle,
  sweepMisses,
  tauntFor,
  totalDurationMs,
  TRACK_COUNT,
  TRACK_KEYS,
  type GameNote,
  type GameOutcome,
} from './game'
// describeSchedule 是纯函数（不碰 Node），直接复用宿主那一份 —— 免得两处描述逻辑各说各话。
import { describeSchedule } from '../schedule.js'

const { useCallback, useEffect, useRef, useState } = React

/** 「定期全量备份」的模式按钮。 */
const SCHEDULE_MODES = [
  { id: 'off', label: '关闭' },
  { id: 'interval', label: '按间隔' },
  { id: 'daily', label: '每天' },
  { id: 'monthly', label: '每月' },
] as const

/** 「按间隔」的单位按钮。 */
const INTERVAL_UNITS = [
  { id: 'minute', label: '分钟' },
  { id: 'hour', label: '小时' },
  { id: 'day', label: '天' },
] as const

/**
 * 空闲时的轮询间隔（毫秒）。
 *
 * 不能太长：上传由模型调用工具触发，界面事先并不知道，全靠轮询发现"正在上传"。
 * 参考插件用 5 秒是因为它的测速由界面自己发起；这里必须更勤
 * （宿主是本机回环，一次约 471 字节 JSON，开销可忽略）。
 */
const IDLE_POLL_MS = 2000

/** 上传进行中的轮询间隔（毫秒）：要让人看得见"正在上传"，就不能等太久。 */
const BUSY_POLL_MS = 1000

/** 「云端备份」按钮的目标：RustFS 控制台。 */
export const CONSOLE_URL = 'http://127.0.0.1:9001/'

/** 侧栏那张图的宽度（像素）。 */
const SIDEBAR_SHOT_WIDTH = 140

/** 样式。类名统一 `ob-` 前缀，避免与其它插件撞车；色值一律走主题 token。 */
export const CSS = [
  // 滚动：内容高于容器时自己滚。
  // `max-height:100%` 只在父容器有确定高度时生效，而设置页的父容器高度常是 auto ——
  // 所以再给一个**视口兜底**，保证在任何布局下都滚得起来（这就是"设置界面加滚动条"的落点）。
  '.ob-wrap{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary);line-height:1.5;min-height:0;max-height:calc(100vh - 140px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l1) transparent}',
  '.ob-wrap.is-panel{padding:18px 22px 26px;max-width:820px;box-sizing:border-box}',
  // 滚动条：设置页与主面板共用这一套，粗细与主题色对齐。
  // Electron/Chromium 走 ::-webkit-*；上面 .ob-wrap 里的 scrollbar-width/color 是给 Firefox 的。
  '.ob-wrap::-webkit-scrollbar{width:10px;height:10px}',
  '.ob-wrap::-webkit-scrollbar-track{background:transparent}',
  '.ob-wrap::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l1);border-radius:999px;border:3px solid transparent;background-clip:content-box}',
  '.ob-wrap::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-secondary);background-clip:content-box}',
  '.ob-wrap::-webkit-scrollbar-corner{background:transparent}',
  '.ob-head{display:flex;flex-direction:column;gap:4px}',
  '.ob-title{margin:0;font-size:15px;font-weight:650}',
  '.ob-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.ob-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}',
  '.ob-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,.06)}',
  '.ob-card.live{border-color:var(--dsw-alias-brand-primary)}',
  '.ob-card-label{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px}',
  '.ob-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);display:inline-block}',
  '.ob-value{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em;overflow-wrap:anywhere}',
  '.ob-value small{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:8px}',
  '.ob-card-sub{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
  '.ob-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
  '.ob-wrap button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer;transition:border-color .12s ease,background .12s ease}',
  '.ob-wrap button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
  '.ob-wrap button:disabled{opacity:.5;cursor:default}',
  '.ob-wrap .ob-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}',
  '.ob-wrap .ob-link:hover{text-decoration:underline}',
  '.ob-wrap .ob-switch{position:relative;width:40px;height:22px;border-radius:999px;background:var(--dsw-alias-border-l1);border:1px solid var(--dsw-alias-border-l1);cursor:pointer;padding:0;flex:none;transition:background .15s ease}',
  '.ob-wrap .ob-switch > i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .15s ease}',
  '.ob-wrap .ob-switch.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
  '.ob-wrap .ob-switch.on > i{transform:translateX(18px)}',
  '.ob-wrap .ob-input{flex:1;min-width:180px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 9px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}',
  '.ob-wrap .ob-input:focus{border-color:var(--dsw-alias-brand-primary)}',
  // 数字输入（调度用）：固定窄宽度，别把整行撑开。
  '.ob-wrap .ob-num{flex:0 0 auto;min-width:0;width:62px;text-align:center}',
  // 被锁住的控件（服务连不上时）要一眼看得出不能点，而不是只有鼠标悬停才知道。
  '.ob-wrap button:disabled,.ob-wrap input:disabled{opacity:.45;cursor:not-allowed}',
  '.ob-wrap .ob-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:600;padding:7px 20px}',
  '.ob-wrap .ob-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}',
  '.ob-progress{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
  // ── 备份前的小游戏 ────────────────────────────────────────────────────────
  '.ob-game{position:relative;height:176px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;display:flex;flex-direction:column;user-select:none;touch-action:none}',
  '.ob-game-track{position:relative;flex:1;min-height:0;border-bottom:1px dashed var(--dsw-alias-border-l1);cursor:pointer}',
  '.ob-game-track:last-child{border-bottom:none}',
  '.ob-game-track:active{background:rgba(127,127,127,.06)}',
  // 判定线贯穿全部轨道，落在左侧（与 game.ts 的 JUDGE_RATIO 对齐）。
  '.ob-game-judge{position:absolute;top:0;bottom:0;width:2px;background:var(--dsw-alias-label-secondary);opacity:.65;pointer-events:none;transition:box-shadow .1s ease,background .1s ease,opacity .1s ease}',
  // 命中时光效之一：判定线亮起（perfect 更亮）。
  '.ob-game-judge.hit{background:var(--dsw-alias-label-secondary);box-shadow:0 0 12px 2px var(--dsw-alias-label-secondary);opacity:1}',
  '.ob-game-judge.perfect{background:var(--dsw-alias-brand-primary);box-shadow:0 0 20px 5px var(--dsw-alias-brand-primary);opacity:1}',
  '.ob-game-note{position:absolute;top:50%;width:30px;height:16px;margin-top:-8px;margin-left:-15px;border-radius:5px;background:var(--dsw-alias-brand-primary);box-shadow:0 0 10px var(--dsw-alias-brand-primary);pointer-events:none}',
  '.ob-game-note.good{background:var(--dsw-alias-label-secondary);box-shadow:none;opacity:.7}',
  '.ob-game-note.lost{background:transparent;border:1px solid var(--dsw-alias-border-l1);box-shadow:none;opacity:.45}',
  // 命中瞬间在判定线旁边闪一下等级 —— 这样"perfect 不扣分"才是看得见的。
  '.ob-game-flash{position:absolute;top:6px;font-size:12px;font-weight:700;letter-spacing:1px;pointer-events:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
  '.ob-game-flash.perfect{color:var(--dsw-alias-brand-primary)}',
  '.ob-game-flash.good{color:var(--dsw-alias-label-secondary)}',
  // 键位标记贴在各自的轨道上（右侧、半透明），不挡从右边滑进来的方块。
  // 键位贴在**判定线左侧**的固定区域里，z-index 高于方块 —— 任何时刻都看得见。
  '.ob-game-keymark{position:absolute;left:0;width:16%;top:50%;transform:translateY(-50%);text-align:center;font-size:13px;font-weight:700;color:var(--dsw-alias-label-secondary);opacity:.75;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none;z-index:2;letter-spacing:.5px}',
  // 命中时光效之二：整条轨道从判定线往右扫一层光。
  '.ob-game-track.hit::before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,var(--dsw-alias-label-secondary) 0%,transparent 42%);opacity:.2}',
  '.ob-game-track.perfect::before{background:linear-gradient(90deg,var(--dsw-alias-brand-primary) 0%,transparent 52%);opacity:.32}',
  // 命中时光效之三：判定处扩散一圈光环。
  '.ob-game-ripple{position:absolute;top:50%;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;border:2px solid var(--dsw-alias-brand-primary);pointer-events:none;animation:ob-game-ripple .34s ease-out forwards}',
  '.ob-game-ripple.good{border-color:var(--dsw-alias-label-secondary)}',
  '@keyframes ob-game-ripple{from{transform:scale(.5);opacity:.9}to{transform:scale(2.8);opacity:0}}',
  '.ob-progress > i{display:block;height:100%;width:40%;background:var(--dsw-alias-brand-primary);border-radius:999px}',
  '.ob-progress.sweep > i{animation:ob-sweep 1.1s ease-in-out infinite}',
  '@keyframes ob-sweep{0%{margin-left:-40%}100%{margin-left:100%}}',
  '.ob-spark{display:flex;align-items:flex-end;gap:2px;height:46px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-sizing:border-box}',
  '.ob-spark > i{flex:1 1 0;background:var(--dsw-alias-brand-primary);border-radius:2px 2px 0 0;min-height:2px;opacity:.85}',
  '.ob-block{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px}',
  '.ob-sect-title{font-size:12px;font-weight:650;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}',
  '.ob-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
  '.ob-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px}',
  '.ob-field{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2)}',
  '.ob-field .k{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
  '.ob-field .v{font-size:12px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
  '.ob-ok{color:var(--dsw-alias-brand-primary);font-weight:600}',
  '.ob-bad{color:#e5484d;font-weight:600}',
  '.ob-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.ob-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.ob-badge{font-size:11px;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}',
  '.ob-warn{font-size:12px;color:#e5484d}',
  '.ob-hist{display:flex;flex-direction:column;gap:6px}',
  '.ob-hist-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
  '.ob-hist-row{display:grid;grid-template-columns:78px 1fr 68px;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
  '.ob-hist-row .key{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.ob-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 0}',
  // 侧栏那一栏：图标在上，上传中在图标下面接一张图 —— 图是栏目内容的一部分（把栏目撑高），
  // 而不是 fixed 浮层（浮层会盖住下面的东西，观感像被挡住）。
  '.ob-bar{display:flex;flex-direction:column;align-items:center;gap:6px;max-width:100%}',
  '.ob-bar .cap{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}',
  '.ob-bar-shot{display:block;max-width:100%;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.25)}',
  '.ob-shot{width:100%;max-width:340px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);align-self:flex-start}',
  '.ob-icon.on{color:var(--dsw-alias-brand-primary)}',
  '.ob-shot-wrap{display:flex;flex-direction:column;gap:4px;align-items:flex-start}',
  // 游戏失败那张图：圆角 + 轻阴影，别让它像贴上去的。
  '.ob-fail-shot{border-radius:12px;max-width:100%;box-shadow:0 2px 10px rgba(0,0,0,.18)}',
].join('\n')

/**
 * 字节数格式化。
 *
 * @param bytes - 字节数。
 * @returns 形如 `1.20 MB` 的文本。
 */
function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let scaled = value
  let index = 0
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled.toFixed(digits)} ${units[index]}`
}

/**
 * 时刻格式化。
 *
 * @param iso - ISO 字符串。
 * @returns 本地时间文本。
 */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString()
}

/**
 * 打开 RustFS 控制台。
 *
 * 用 `window.open` 而不是宿主路由：目标是一个外部 Web 界面，让浏览器/Electron
 * 自己决定开新标签还是新窗口最省事。
 *
 * ⚠️ **别拿 `window.open` 的返回值判断成功与否**：features 里带 `noopener` 时它按规范
 * **永远返回 null**（踩过：窗口明明开了，界面却提示"浏览器拦下了新窗口"）。
 * 所以这里先不带 noopener 打开以拿到窗口引用，拿到后再断掉 opener —— 安全性等价。
 *
 * @returns `opened` 表示已发起且未被拦截；`blocked` 表示确实被弹窗策略拦下。
 */
export function openConsole(): 'opened' | 'blocked' {
  try {
    if (typeof window === 'undefined' || typeof window.open !== 'function') return 'blocked'
    const opened = window.open(CONSOLE_URL, '_blank')
    if (opened === null) return 'blocked'
    try {
      // 断开 opener 引用（等价于 rel=noopener）。跨源时可能被拒，忽略即可。
      opened.opener = null
    } catch {
      /* 拿不到就算了 */
    }
    return 'opened'
  } catch {
    return 'blocked'
  }
}

/** 状态订阅结果。 */
export interface OssState {
  /** 最近一次快照。 */
  snapshot: StateSnapshot | null
  /** 最近一次失败原因。 */
  error: string | null
  /** 是否正在拉取。 */
  loading: boolean
  /** 立即刷新。 */
  refresh: () => void
}

/**
 * 订阅宿主状态：进入视图先拉一次，之后按固定间隔刷新（上传中加快）。
 *
 * @returns 状态与刷新函数。
 */
export function useOssState(): OssState {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    let cancelled = false
    setLoading(true)
    void fetchState().then((result) => {
      if (cancelled) return
      setSnapshot(result.snapshot)
      setError(result.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let timer = 0
    const tick = async (): Promise<void> => {
      const result = await fetchState()
      if (disposed) return
      setSnapshot(result.snapshot)
      setError(result.error)
      // 轮询间隔跟着 busy 走：正在上传时看得见状态，空闲时不打扰宿主。
      timer = setTimeout(() => {
        void tick()
      }, result.snapshot !== null && result.snapshot.busy ? BUSY_POLL_MS : IDLE_POLL_MS)
    }
    void tick()
    return () => {
      disposed = true
      if (timer !== 0) clearTimeout(timer)
    }
  }, [])

  return { snapshot, error, loading, refresh }
}

/**
 * 上传中弹出的那张图。
 *
 * 图来自宿主路由 `/oss-backup/asset/shot`（包内 `assets/code-uploading.jpg`），
 * **不 base64 内联进 bundle**：那图 500 KB 出头，内联会让每个浏览器多下约 700 KB。
 * 取不到图时回退到 {@link FallbackShot} 的内置插画，界面不会开天窗。
 *
 * @param props - `width` 控制渲染宽度（像素），`className` 用于外部挂样式。
 * @returns React 元素。
 */
export function UploadShot(props: { width: number; className?: string }): React.ReactElement {
  const [broken, setBroken] = useState(false)
  const width = Number.isFinite(props.width) && props.width > 0 ? props.width : SIDEBAR_SHOT_WIDTH

  if (broken) return React.createElement(FallbackShot, { width, className: props.className })

  return React.createElement('img', {
    className: props.className,
    src: SHOT_PATH,
    width,
    alt: '代码在自己上传',
    onError: () => setBroken(true),
    style: { display: 'block', height: 'auto' },
  })
}

/**
 * 游戏失败时弹出的那张图。
 *
 * 图来自宿主路由 `/oss-backup/asset/fail`（包内 `assets/game-failed.jpg`），
 * 同样不 base64 内联。取不到图时**不显示占位** —— 失败文案本身已经把事说清了，
 * 再顶一张破图只会更难看。
 *
 * @param props - `width` 控制渲染宽度（像素），`className` 用于外部挂样式。
 * @returns React 元素；图挂了就返回 `null`。
 */
export function UploadFail(props: { width: number; className?: string }): React.ReactElement | null {
  const [broken, setBroken] = useState(false)
  if (broken) return null
  return React.createElement('img', {
    className: props.className,
    src: FAIL_PATH,
    width: props.width,
    alt: '偷数据公司给我跪下',
    onError: () => setBroken(true),
    style: { display: 'block', height: 'auto' },
  })
}

/**
 * 内置兜底插画：宿主那张图拿不到时顶上。
 *
 * 一朵云、一双眼睛、一支向上箭头 —— 与侧栏图标同一套线条语言。
 *
 * @param props - `width` 控制渲染宽度（像素），`className` 用于外部挂样式。
 * @returns React 元素。
 */
export function FallbackShot(props: { width: number; className?: string }): React.ReactElement {
  const width = Number.isFinite(props.width) && props.width > 0 ? props.width : SIDEBAR_SHOT_WIDTH
  const height = Math.round((width * 140) / 220)
  const stroke = 'currentColor'
  return React.createElement(
    'svg',
    {
      width,
      height,
      viewBox: '0 0 220 140',
      className: props.className,
      role: 'img',
      'aria-label': '正在上传',
      style: { display: 'block' },
    },
    [
      React.createElement('rect', {
        key: 'bg',
        x: 1,
        y: 1,
        width: 218,
        height: 138,
        rx: 14,
        fill: 'var(--dsw-alias-bg-layer-2)',
        stroke: 'var(--dsw-alias-border-l1)',
        strokeWidth: 1,
      }),
      // 云 + 脸
      React.createElement('path', {
        key: 'cloud',
        d: 'M64 84h92a24 24 0 0 0 4-47 32 32 0 0 0-60-8 21 21 0 0 0-36 19z',
        fill: 'none',
        stroke,
        strokeWidth: 3,
        strokeLinejoin: 'round',
      }),
      React.createElement('circle', { key: 'eye-l', cx: 97, cy: 60, r: 3.4, fill: stroke }),
      React.createElement('circle', { key: 'eye-r', cx: 123, cy: 60, r: 3.4, fill: stroke }),
      React.createElement('path', {
        key: 'smile',
        d: 'M104 71q6 6 12 0',
        fill: 'none',
        stroke,
        strokeWidth: 2.6,
        strokeLinecap: 'round',
      }),
      // 向上箭头（上传）
      React.createElement('path', {
        key: 'shaft',
        d: 'M110 132v-24',
        stroke: 'var(--dsw-alias-brand-primary)',
        strokeWidth: 4,
        strokeLinecap: 'round',
      }),
      React.createElement('path', {
        key: 'head',
        d: 'M99 118l11-11 11 11',
        fill: 'none',
        stroke: 'var(--dsw-alias-brand-primary)',
        strokeWidth: 4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      // 两侧的小星：纯装饰，让"跳出"这件事显得热闹一点
      React.createElement('path', {
        key: 'spark-l',
        d: 'M34 44v12M28 50h12',
        stroke: 'var(--dsw-alias-brand-primary)',
        strokeWidth: 2.4,
        strokeLinecap: 'round',
        opacity: 0.7,
      }),
      React.createElement('path', {
        key: 'spark-r',
        d: 'M188 96v10M183 101h10',
        stroke: 'var(--dsw-alias-brand-primary)',
        strokeWidth: 2.4,
        strokeLinecap: 'round',
        opacity: 0.7,
      }),
    ],
  )
}

/**
 * 单条「键: 值」展示。
 *
 * @param props - 键、值、可选状态色。
 * @returns React 元素。
 */
function Field(props: { name: string; value: string; tone?: 'ok' | 'bad' }): React.ReactElement {
  const cls = props.tone === 'ok' ? 'v ob-ok' : props.tone === 'bad' ? 'v ob-bad' : 'v'
  return React.createElement('div', { className: 'ob-field' }, [
    React.createElement('span', { className: 'k', key: 'k' }, props.name),
    React.createElement('span', { className: cls, key: 'v' }, props.value),
  ])
}

/**
 * 指标卡（设置页顶部那两张）。
 *
 * @param props - 标题、主值、副行、是否高亮。
 * @returns React 元素。
 */
function MetricCard(props: {
  label: string
  value: string
  sub: string
  live?: boolean
  tone?: 'ok' | 'bad'
}): React.ReactElement {
  const valueCls =
    props.tone === 'ok'
      ? 'ob-value ob-ok'
      : props.tone === 'bad'
        ? 'ob-value ob-bad'
        : 'ob-value'
  return React.createElement('div', { className: props.live === true ? 'ob-card live' : 'ob-card' }, [
    React.createElement('div', { className: 'ob-card-label', key: 'label' }, [
      props.live === true ? React.createElement('i', { className: 'ob-dot', key: 'dot' }) : null,
      React.createElement('span', { key: 'text' }, props.label),
    ]),
    React.createElement('div', { className: valueCls, key: 'value' }, props.value),
    React.createElement('div', { className: 'ob-card-sub', key: 'sub' }, props.sub),
  ])
}

/**
 * 迷你柱状图：把最近几次上传的字节数画成柱子。
 *
 * @param props - 采样序列（新 → 旧）。
 * @returns React 元素。
 */
function MiniBars(props: { samples: readonly number[] }): React.ReactElement {
  const samples = props.samples.slice(0, 24).reverse()
  if (samples.length === 0) {
    return React.createElement('div', { className: 'ob-spark' }, [
      React.createElement('i', { key: 'empty', style: { height: '2px', opacity: 0.25 } }),
    ])
  }
  const peak = samples.reduce((max, value) => (value > max ? value : max), 0) || 1
  return React.createElement(
    'div',
    { className: 'ob-spark' },
    samples.map((value, index) =>
      React.createElement('i', {
        key: index,
        title: formatBytes(value),
        style: { height: `${Math.max(3, Math.round((value / peak) * 100))}%` },
      }),
    ),
  )
}

/**
 * 上传状态块：状态文字 + 进度条 + （上传中）那张图。
 *
 * @param props - 快照。
 * @returns React 元素。
 */
function UploadBlock(props: { snapshot: StateSnapshot }): React.ReactElement {
  const { snapshot } = props
  const busy = snapshot.busy
  const last = snapshot.last
  const autoLast = snapshot.autoBackup.last
  const samples = snapshot.history.map((item) => item.bytes)

  return React.createElement('div', { className: 'ob-block' }, [
    React.createElement('div', { className: 'ob-row', key: 'head' }, [
      React.createElement('span', { className: 'ob-sect-title', key: 't' }, '上传状态'),
      React.createElement(
        'span',
        { className: busy ? 'ob-badge' : 'ob-hint', key: 'state' },
        busy
          ? '正在上传…'
          : snapshot.autoBackup.paused
            ? '已暂停自动备份'
            : last === null
              ? '待命中（还没有上传记录）'
              : `最近一次 ${formatTime(last.at)} · ${formatBytes(last.bytes)}`,
      ),
    ]),

    // 熔断提示：服务连不上时自动备份会连续失败，这里如实说明"为什么停了"。
    snapshot.autoBackup.paused
      ? React.createElement(
          'div',
          { className: 'ob-warn', key: 'paused' },
          `自动备份已连续失败 ${snapshot.autoBackup.failures} 次，暂停中${
            snapshot.autoBackup.pausedUntil === null
              ? ''
              : `（约 ${formatTime(new Date(snapshot.autoBackup.pausedUntil).toISOString())} 后恢复）`
          } —— 多半是对象存储连不上，恢复后会自动继续，期间的文件改动会被跳过。`,
        )
      : null,

    // 最近一次自动备份失败：不弹窗、不刷屏，但要让用户看得到原因（已脱敏）。
    autoLast !== null && !autoLast.ok && !snapshot.autoBackup.paused
      ? React.createElement(
          'div',
          { className: 'ob-warn', key: 'lastfail' },
          `最近一次自动备份失败：${autoLast.error ?? '未知原因'}`,
        )
      : null,

    busy
      ? React.createElement('div', { className: 'ob-progress sweep', key: 'bar' }, [React.createElement('i', { key: 'i' })])
      : React.createElement('div', { className: 'ob-progress', key: 'bar' }, [
          React.createElement('i', { key: 'i', style: { width: '0%' } }),
        ]),

    React.createElement(MiniBars, { key: 'spark', samples }),

    // 上传中"跳出"的那张图。
    busy
      ? React.createElement('div', { className: 'ob-shot-wrap', key: 'shot' }, [
          React.createElement(UploadShot, { key: 'img', width: 320, className: 'ob-shot' }),
          React.createElement('span', { className: 'ob-hint', key: 'cap' }, '正在把文件推上去…'),
        ])
      : null,

    React.createElement(
      'div',
      { className: 'ob-hint', key: 'note' },
      `模型调用 ${snapshot.tool} 是单文件上传（filePath + objectKey）；要备份整个文件夹请用下面的「手动备份」。`,
    ),
  ])
}

/**
 * 「云端备份」块：打开 RustFS 控制台。
 *
 * 地址同时做成真链接：万一是浏览器弹窗策略真拦下了，点链接照样能打开，不必手抄 URL。
 *
 * @returns React 元素。
 */
function ConsoleBlock(): React.ReactElement {
  const [note, setNote] = useState('')
  return React.createElement('div', { className: 'ob-block' }, [
    React.createElement('span', { className: 'ob-sect-title', key: 't' }, '云端备份'),
    React.createElement('div', { className: 'ob-row', key: 'row' }, [
      React.createElement(
        'button',
        {
          key: 'open',
          type: 'button',
          className: 'ob-btn-primary',
          onClick: () => {
            // 只有真的返回 null（确实被拦下）才提示 —— "带 noopener 时永远返回 null" 那个坑已经避开。
            setNote(openConsole() === 'blocked' ? '浏览器拦下了新窗口，点右边的地址即可打开。' : '')
          },
        },
        '云端备份',
      ),
      React.createElement(
        'a',
        {
          key: 'url',
          className: 'ob-link',
          href: CONSOLE_URL,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        CONSOLE_URL,
      ),
    ]),
    note === '' ? null : React.createElement('div', { className: 'ob-warn', key: 'note' }, note),
  ])
}

/**
 * 设置块：自动备份开关 + 备份目录（对象键前缀收在「高级设置」里）。
 *
 * 三项都存到宿主（`~/.dsh/oss-backup/config.json`）。这里刻意不碰凭证：
 * AK/SK 永远只从环境变量读，界面上连输入框都不存在。
 *
 * ⚠️ **草稿同步必须按"值"而不是对象引用**：`props.settings` 来自每 2 秒一次的状态轮询，
 * 每次都是**新对象**。早先用 `useEffect(..., [props.settings])` 同步草稿，结果每轮轮询都把
 * 用户正在输入的目录、刚拨的开关冲掉（症状：填了目录就消失、开关自动弹回、看不到"已保存"）。
 *
 * @param props - 当前设置、自动备份状态与"已保存"回调。
 * @returns React 元素。
 */
function SettingsBlock(props: {
  settings: PluginSettingsView
  report: AutoBackupReport
  /** 定期全量备份的下次**实际**触发时刻（宿主报的；未排期为 null）。 */
  nextRunAt: number | null
  /** 宿主现在是否允许上传（`false` 时自动／定期备份都会被拦，设置要相应锁住）。 */
  uploadAllowed: boolean
  /** 不许上传时的原因（**已脱敏**）。 */
  blockedReason: string | null
  onSaved: () => void
}): React.ReactElement {
  const [draft, setDraft] = useState<PluginSettingsView>(props.settings)
  // 草稿的"基准值"：保存成功后立刻对齐，dirty 才能及时归零。
  const [baseline, setBaseline] = useState<PluginSettingsView>(props.settings)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const [advanced, setAdvanced] = useState(false)
  // 服务连不上时宿主已经拦下所有上传 —— 自动／定期备份相关的设置要一起锁住。
  const blocked = !props.uploadAllowed

  // 只有宿主那边的**值**真的变了才同步草稿（同值轮询不该打断输入）。
  //
  // ⚠️ key 必须覆盖**全部**设置项。原来手写了前三个字段，新增 schedule 之后就跟不上了。
  // 直接用序列化结果当 key，天然免疫"再加字段忘了补"。
  const hostKey = JSON.stringify(props.settings)
  useEffect(() => {
    setDraft(props.settings)
    setBaseline(props.settings)
  }, [hostKey])

  /**
   * 草稿与基准是否不同 —— 决定「保存」按钮是否可点。
   *
   * ⚠️ 这里**整体比较**，绝不要手写逐字段的 `!==` 链：原来只比了
   * autoBackup / backupDir / prefix 三项，之后新增的 schedule（以及更早的
   * skipCaches / provider / endpoint / bucket / region / gameDifficulty）都没跟上，
   * 结果是**改了调度但 dirty 恒为 false，「保存」按钮一直点不动** ——
   * 用户看到的现象就是"没有保存功能"。
   *
   * 键顺序不用担心：draft 与 baseline 都源自同一份 props.settings，
   * 之后的更新一律用扩展运算符保持原顺序。
   */
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)

  /**
   * 落盘一份设置。
   *
   * @param next - 要保存的值。
   * @param successNote - 成功后的提示语。
   */
  const persist = useCallback(
    (next: PluginSettingsView, successNote: string) => {
      setSaving(true)
      void saveSettings(next).then((result) => {
        setSaving(false)
        if (result.ok) {
          // 立刻把基准对齐：dirty 归零、提示马上可见，不用等下一次轮询。
          setBaseline(next)
          setNote(successNote)
        } else {
          setNote(`保存失败：${result.error ?? '未知错误'}`)
        }
        props.onSaved()
      })
    },
    [props],
  )

  // 开关即点即生效；输入框才需要显式保存（避免打字过程中反复落盘）。
  const toggle = useCallback(() => {
    const next = { ...draft, autoBackup: !draft.autoBackup }
    setDraft(next)
    persist(next, next.autoBackup ? '自动备份已开启 ✓' : '自动备份已关闭 ✓')
  }, [draft, persist])

  return React.createElement('div', { className: 'ob-block' }, [
    React.createElement('div', { className: 'ob-row', key: 'head' }, [
      React.createElement('span', { className: 'ob-sect-title', key: 't' }, '设置'),
      React.createElement(
        'span',
        { className: dirty ? 'ob-warn' : 'ob-hint', key: 's' },
        dirty ? '有未保存的改动（点下面的「保存」）' : note === '' ? '改动会立即生效' : note,
      ),
    ]),

    // 自动备份开关：即点即存
    //
    // ⚠️ 服务连不上时必须**连开关一起锁住**：宿主那边确实不会上传（applyAutoBackup 直接
    // 不建实例），但如果开关还能拨，用户会以为"开了就在备份"—— 拨了没反应比不让拨更糟。
    blocked
      ? React.createElement(
          'div',
          { className: 'ob-warn', key: 'blocked' },
          `${props.blockedReason ?? '对象存储当前不可用'} —— 自动备份与定期备份暂时不可用，因此下面的开关已锁定；服务恢复后会自动解锁。`,
        )
      : null,

    React.createElement('div', { className: 'ob-row', key: 'toggle' }, [
      React.createElement(
        'button',
        {
          key: 'sw',
          type: 'button',
          className: draft.autoBackup ? 'ob-switch on' : 'ob-switch',
          'aria-pressed': draft.autoBackup,
          title: blocked
            ? (props.blockedReason ?? '对象存储当前不可用')
            : draft.autoBackup
              ? '点击关闭自动备份'
              : '点击开启自动备份',
          disabled: saving || blocked,
          onClick: toggle,
        },
        React.createElement('i', { key: 'knob' }),
      ),
      React.createElement(
        'span',
        { className: 'ob-hint', key: 'label' },
        blocked
          ? '自动备份：已锁定（对象存储连不上，开了也不会真的上传）'
          : draft.autoBackup
            ? `自动备份：开 —— write / edit 落盘后防抖 ${props.report.debounceMs}ms 自动上传`
            : '自动备份：关（默认）',
      ),
      draft.autoBackup && props.report.pending > 0
        ? React.createElement('span', { className: 'ob-badge', key: 'pending' }, `排队 ${props.report.pending}`)
        : null,
    ]),

    // 备份目录：填这个目录，点「立即备份」就把整个文件夹递归传上去
    React.createElement('div', { className: 'ob-row', key: 'dir' }, [
      React.createElement('span', { className: 'ob-hint', key: 'k' }, '备份目录'),
      React.createElement('input', {
        key: 'v',
        type: 'text',
        className: 'ob-input',
        value: draft.backupDir,
        placeholder: 'D:\\projects\\your-project',
        spellCheck: false,
        onChange: (event: { target: { value: string } }) =>
          setDraft((current) => ({ ...current, backupDir: event.target.value })),
      }),
    ]),

    // 跳过缓存目录开关：关掉之后 __pycache__ 之类的目录也会一起备份
    React.createElement('div', { className: 'ob-row', key: 'skip' }, [
      React.createElement(
        'button',
        {
          key: 'sw',
          type: 'button',
          className: draft.skipCaches ? 'ob-switch on' : 'ob-switch',
          'aria-pressed': draft.skipCaches,
          title: draft.skipCaches ? '点击改为「一个文件都不少」' : '点击恢复跳过缓存目录',
          disabled: saving,
          onClick: () => {
            const next = { ...draft, skipCaches: !draft.skipCaches }
            setDraft(next)
            persist(next, next.skipCaches ? '已改为：跳过依赖 / 缓存目录 ✓' : '已改为：不跳过任何目录 ✓')
          },
        },
        React.createElement('i', { key: 'knob' }),
      ),
      React.createElement(
        'span',
        { className: 'ob-hint', key: 'label' },
        draft.skipCaches
          ? '跳过依赖 / 缓存目录：是 —— node_modules、.git、__pycache__、.venv 等 8 类不备份'
          : '跳过依赖 / 缓存目录：否 —— 一个文件都不少（可能撞上文件数上限）',
      ),
    ]),

    // 小游戏开关：点「立即备份」时是否先玩一局（通关才真的开始备份）
    React.createElement('div', { className: 'ob-row', key: 'game' }, [
      React.createElement(
        'button',
        {
          key: 'sw',
          type: 'button',
          className: draft.gameEnabled ? 'ob-switch on' : 'ob-switch',
          'aria-pressed': draft.gameEnabled,
          title: draft.gameEnabled ? '点击关闭：点立即备份时不再弹游戏' : '点击开启：点立即备份时先玩一局',
          disabled: saving,
          onClick: () => {
            const next = { ...draft, gameEnabled: !draft.gameEnabled }
            setDraft(next)
            persist(next, next.gameEnabled ? '备份前的小游戏：开 ✓' : '备份前的小游戏：关 ✓')
          },
        },
        React.createElement('i', { key: 'knob' }),
      ),
      React.createElement(
        'span',
        { className: 'ob-hint', key: 'label' },
        // 玩法说明写在 README 里；界面上只留"开 / 关"。
        draft.gameEnabled ? '备份前的小游戏：开' : '备份前的小游戏：关',
      ),
    ]),

    // 定期全量备份：按时间表把整个备份目录完整传一遍（与"文件一改就传"是两套）
    // 服务连不上时这块也锁住 —— 宿主不会排期，让用户改时间表只会造成误解。
    React.createElement('div', { className: 'ob-row', key: 'sched-mode' }, [
      React.createElement('span', { className: 'ob-hint', key: 'k' }, '定期全量备份'),
      ...(SCHEDULE_MODES.map((item) =>
        React.createElement(
          'button',
          {
            key: item.id,
            type: 'button',
            className: draft.schedule.mode === item.id ? 'ob-btn-primary' : undefined,
            disabled: blocked,
            title: blocked ? (props.blockedReason ?? '对象存储当前不可用') : item.label,
            onClick: () =>
              setDraft((current) => ({
                ...current,
                schedule: { ...current.schedule, mode: item.id },
              })),
          },
          item.label,
        ),
      )),
    ]),

    // 按间隔：数值 + 单位
    draft.schedule.mode === 'interval'
      ? React.createElement('div', { className: 'ob-row', key: 'sched-interval' }, [
          React.createElement('span', { className: 'ob-hint', key: 'k' }, '每'),
          React.createElement('input', {
            key: 'n',
            type: 'number',
            className: 'ob-input ob-num',
            min: 1,
            disabled: blocked,
            value: String(draft.schedule.every),
            onChange: (event: { target: { value: string } }) =>
              setDraft((current) => ({
                ...current,
                schedule: {
                  ...current.schedule,
                  every: Math.max(1, Math.floor(Number(event.target.value)) || 1),
                },
              })),
          }),
          ...(INTERVAL_UNITS.map((item) =>
            React.createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                className: draft.schedule.unit === item.id ? 'ob-btn-primary' : undefined,
                disabled: blocked,
                onClick: () =>
                  setDraft((current) => ({
                    ...current,
                    schedule: { ...current.schedule, unit: item.id },
                  })),
              },
              item.label,
            ),
          )),
          React.createElement(
            'span',
            { className: 'ob-hint', key: 'tip' },
            '按**排定时刻**对齐（每 30 分钟 = :00 / :30，每 6 小时 = 00/06/12/18）',
          ),
        ])
      : null,

    // 每天 / 每月：时刻（每月多一个"几号"）
    draft.schedule.mode === 'daily' || draft.schedule.mode === 'monthly'
      ? React.createElement('div', { className: 'ob-row', key: 'sched-clock' }, [
          React.createElement(
            'span',
            { className: 'ob-hint', key: 'k' },
            draft.schedule.mode === 'monthly' ? '每月' : '每天',
          ),
          draft.schedule.mode === 'monthly'
            ? React.createElement('input', {
                key: 'day',
                type: 'number',
                className: 'ob-input ob-num',
                min: 1,
                max: 28,
                disabled: blocked,
                value: String(draft.schedule.dayOfMonth),
                onChange: (event: { target: { value: string } }) =>
                  setDraft((current) => ({
                    ...current,
                    schedule: {
                      ...current.schedule,
                      dayOfMonth: Math.min(28, Math.max(1, Math.floor(Number(event.target.value)) || 1)),
                    },
                  })),
              })
            : null,
          draft.schedule.mode === 'monthly'
            ? React.createElement('span', { className: 'ob-hint', key: 'd' }, '日')
            : null,
          React.createElement('input', {
            key: 'h',
            type: 'number',
            className: 'ob-input ob-num',
            min: 0,
            max: 23,
            disabled: blocked,
            value: String(draft.schedule.hour).padStart(2, '0'),
            onChange: (event: { target: { value: string } }) =>
              setDraft((current) => ({
                ...current,
                schedule: {
                  ...current.schedule,
                  hour: Math.min(23, Math.max(0, Math.floor(Number(event.target.value)) || 0)),
                },
              })),
          }),
          React.createElement('span', { className: 'ob-hint', key: 'c' }, ':'),
          React.createElement('input', {
            key: 'm',
            type: 'number',
            className: 'ob-input ob-num',
            min: 0,
            max: 59,
            disabled: blocked,
            value: String(draft.schedule.minute).padStart(2, '0'),
            onChange: (event: { target: { value: string } }) =>
              setDraft((current) => ({
                ...current,
                schedule: {
                  ...current.schedule,
                  minute: Math.min(59, Math.max(0, Math.floor(Number(event.target.value)) || 0)),
                },
              })),
          }),
          draft.schedule.mode === 'monthly'
            ? React.createElement(
                'span',
                { className: 'ob-hint', key: 'limit' },
                '（只支持 1-28 号：每月都一定存在，不会遇到"2 月没有 30 号"）',
              )
            : null,
        ])
      : null,

    React.createElement(
      'div',
      { className: 'ob-hint', key: 'sched-note' },
      draft.schedule.mode === 'off'
        ? '定期全量备份：关闭 —— 与「自动备份」独立，这里关掉不影响文件改动即时上传'
        : `定期全量备份：${describeSchedule(draft.schedule)}${
            dirty ? '（改完点保存生效）' : ''
          }${props.nextRunAt === null ? ' · 已排期' : ` · 下次 ${new Date(props.nextRunAt).toLocaleString()}`}`,
    ),

    // 保存 + 高级设置入口
    React.createElement('div', { className: 'ob-row', key: 'save-row' }, [
      React.createElement(
        'button',
        {
          key: 'save',
          type: 'button',
          className: dirty ? 'ob-btn-primary' : undefined,
          disabled: saving || !dirty,
          onClick: () => persist(draft, '已保存 ✓'),
        },
        saving ? '保存中…' : dirty ? '保存' : '已同步',
      ),
      React.createElement(
        'button',
        { key: 'adv', type: 'button', onClick: () => setAdvanced((value) => !value) },
        advanced ? '收起高级设置' : '高级设置',
      ),
      React.createElement('span', { className: 'ob-hint', key: 'prefix-hint' }, `对象键前缀：${draft.prefix}`),
    ]),

    // 高级：对象键前缀 + 连接信息（都是**非机密**，所以可以持久化到 config.json）
    advanced
      ? [
          React.createElement('div', { className: 'ob-row', key: 'prefix' }, [
            React.createElement('span', { className: 'ob-hint', key: 'k' }, '对象键前缀'),
            React.createElement('input', {
              key: 'v',
              type: 'text',
              className: 'ob-input',
              value: draft.prefix,
              spellCheck: false,
              onChange: (event: { target: { value: string } }) =>
                setDraft((current) => ({ ...current, prefix: event.target.value })),
            }),
          ]),
          React.createElement('div', { className: 'ob-row', key: 'provider' }, [
            React.createElement('span', { className: 'ob-hint', key: 'k' }, 'Provider'),
            React.createElement('input', {
              key: 'v',
              type: 'text',
              className: 'ob-input',
              value: draft.provider,
              placeholder: 'rustfs / aliyun / aws（留空 = 用环境变量）',
              spellCheck: false,
              onChange: (event: { target: { value: string } }) =>
                setDraft((current) => ({ ...current, provider: event.target.value })),
            }),
          ]),
          React.createElement('div', { className: 'ob-row', key: 'endpoint' }, [
            React.createElement('span', { className: 'ob-hint', key: 'k' }, '端点'),
            React.createElement('input', {
              key: 'v',
              type: 'text',
              className: 'ob-input',
              value: draft.endpoint,
              placeholder: '留空 = 用环境变量 / provider 默认',
              spellCheck: false,
              onChange: (event: { target: { value: string } }) =>
                setDraft((current) => ({ ...current, endpoint: event.target.value })),
            }),
          ]),
          React.createElement('div', { className: 'ob-row', key: 'bucket' }, [
            React.createElement('span', { className: 'ob-hint', key: 'k' }, '存储桶'),
            React.createElement('input', {
              key: 'v',
              type: 'text',
              className: 'ob-input',
              value: draft.bucket,
              placeholder: '留空 = 用环境变量',
              spellCheck: false,
              onChange: (event: { target: { value: string } }) =>
                setDraft((current) => ({ ...current, bucket: event.target.value })),
            }),
          ]),
          React.createElement('div', { className: 'ob-row', key: 'region' }, [
            React.createElement('span', { className: 'ob-hint', key: 'k' }, '区域'),
            React.createElement('input', {
              key: 'v',
              type: 'text',
              className: 'ob-input',
              value: draft.region,
              placeholder: '留空 = 用环境变量 / provider 默认',
              spellCheck: false,
              onChange: (event: { target: { value: string } }) =>
                setDraft((current) => ({ ...current, region: event.target.value })),
            }),
          ]),
        ]
      : null,
  ])
}

/**
 * 备份前的小游戏：四条轨道从右往左滑，经过左侧判定线时点掉它。
 *
 * 判定逻辑全在 `game.ts`（纯函数、有单测），这里只管渲染与输入。
 * 每帧只做一次 `setNowMs`，note 的命中 / 漏掉状态就地写在 `notesRef` 里 ——
 * 一次 setState 触发重渲染，避免每帧复制整个数组。
 *
 * @param props - 当前难度、难度切换回调、通过回调、关闭回调。
 * @returns React 元素。
 */
function BackupGame(props: {
  difficulty: string
  onPickDifficulty: (id: string) => void
  onPass: () => void
  onClose: () => void
}): React.ReactElement {
  // 难度在本地也持有一份：点按钮**立刻**生效，不必等宿主状态轮询回来 ——
  // 否则点了之后界面毫无变化，看起来就像"选不了"。
  const [difficulty, setDifficulty] = useState(props.difficulty)
  const spec = difficultyOf(difficulty)
  const [phase, setPhase] = useState<'ready' | 'playing' | 'done'>('ready')
  const [nowMs, setNowMs] = useState(0)
  const [outcome, setOutcome] = useState<GameOutcome | null>(null)
  const [flash, setFlash] = useState<{ track: number; grade: 'perfect' | 'good'; at: number } | null>(null)
  const notesRef = useRef<GameNote[]>([])
  const startedAtRef = useRef(0)

  const begin = useCallback(() => {
    notesRef.current = buildChart(spec)
    startedAtRef.current = Date.now()
    setNowMs(0)
    setOutcome(null)
    setPhase('playing')
  }, [spec])

  const tap = useCallback(
    (track: number) => {
      if (phase !== 'playing') return
      const elapsed = Date.now() - startedAtRef.current
      const hit = pickHit(notesRef.current, track, elapsed)
      if (hit === null) return
      const note = notesRef.current.find((item) => item.id === hit.id)
      if (note === undefined) return
      note.state = hit.grade
      // 命中光效：记下轨道与等级，渲染时给判定线 / 轨道 / 光环用。
      setFlash({ track, grade: hit.grade, at: elapsed })
    },
    [phase],
  )

  // 主循环：推进时间 + 把错过判定窗口的 note 标记为漏掉。
  useEffect(() => {
    if (phase !== 'playing') return
    let raf = 0
    const loop = (): void => {
      const elapsed = Date.now() - startedAtRef.current
      sweepMisses(notesRef.current, elapsed)
      setNowMs(elapsed)
      if (elapsed >= totalDurationMs(spec)) {
        setOutcome(settle(notesRef.current))
        setPhase('done')
        return
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [phase, spec])

  // 键盘：D F J K（音游常见的四键布局）。
  useEffect(() => {
    if (phase !== 'playing') return
    const onKey = (event: KeyboardEvent): void => {
      const track = KEY_TO_TRACK[event.key.toLowerCase()]
      if (track === undefined) return
      event.preventDefault()
      tap(track)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, tap])

  // 通过 → 让结果停留一下，再自动开跑备份。
  useEffect(() => {
    if (phase !== 'done' || outcome === null || !outcome.passed) return
    const timer = setTimeout(() => props.onPass(), 1400)
    return () => clearTimeout(timer)
  }, [phase, outcome, props])

  let perfect = 0
  let good = 0
  let lost = 0
  for (const note of notesRef.current) {
    if (note.state === 'perfect') perfect += 1
    else if (note.state === 'good') good += 1
    else if (note.state === 'lost') lost += 1
  }
  const total = notesRef.current.length
  const deduction = total === 0 ? 0 : Math.round(((good * GOOD_WEIGHT + lost) / total) * 100)
  const remaining = Math.max(0, 100 - deduction)

  // 命中光效持续 340ms（略长于动画，保证能播完）。
  const flashOn = flash !== null && nowMs - flash.at < 340

  const trackNodes = Array.from({ length: TRACK_COUNT }, (_, track) =>
    React.createElement(
      'div',
      {
        key: `track-${track}`,
        className: flashOn && flash.track === track ? `ob-game-track hit ${flash.grade}` : 'ob-game-track',
        onPointerDown: () => tap(track),
      },
      [
        // 键位贴在判定线左侧、层级高于方块 —— 任何时刻都看得见。
        React.createElement('span', { key: 'mark', className: 'ob-game-keymark' }, TRACK_KEYS[track]),
        // 命中处扩散的光环；key 用命中时刻，连续命中也能重启动画。
        flashOn && flash.track === track
          ? React.createElement('i', {
              key: `ripple-${flash.at}`,
              className: flash.grade === 'perfect' ? 'ob-game-ripple' : 'ob-game-ripple good',
              style: { left: `${JUDGE_RATIO * 100}%` },
            })
          : null,
        ...notesRef.current
          // perfect / good 命中即消失（干净）；lost 留在原地淡出，让"漏了"看得见。
          .filter((note) => note.track === track && (note.state === 'pending' || note.state === 'lost'))
          .map((note) =>
            React.createElement('i', {
              key: note.id,
              className: note.state === 'lost' ? 'ob-game-note lost' : 'ob-game-note',
              style: { left: `${notePosition(note, nowMs, spec.fallMs) * 100}%` },
            }),
          ),
      ],
    ),
  )

  return React.createElement('div', { className: 'ob-block' }, [
    React.createElement('div', { className: 'ob-row', key: 'head' }, [
      React.createElement('span', { className: 'ob-sect-title', key: 't' }, '我们一起偷代码'),
      React.createElement(
        'span',
        { className: phase === 'playing' ? 'ob-badge' : 'ob-hint', key: 's' },
        phase === 'ready'
          ? '方块经过判定线时点掉它 —— 越准分越高，漏掉会扣分'
          : phase === 'playing'
            ? `剩余 ${remaining} 分 · PERFECT ${perfect} / GOOD ${good} / LOST ${lost}`
            : outcome === null
              ? ''
              : outcome.passed
                ? `通过：${outcome.score} 分（PERFECT ${outcome.perfect} · GOOD ${outcome.good} · LOST ${outcome.lost}）—— 马上开始备份…`
                : `${outcome.score} 分（PERFECT ${outcome.perfect} · GOOD ${outcome.good} · LOST ${outcome.lost}，扣了 ${outcome.deduction} 分）—— 备份未触发`,
      ),
    ]),

    // 失败了要挨一句嘲讽 + 弹那张图。图**一直显示**，直到玩家点「再来一局」或「放弃备份」
    // （那两个按钮会把 phase 从 done 改走，这里自然就收了）。
    phase === 'done' && outcome !== null && !outcome.passed
      ? React.createElement('div', { className: 'ob-row', key: 'taunt-row' }, [
          React.createElement('div', { className: 'ob-warn', key: 'taunt' }, tauntFor(outcome)),
          React.createElement(UploadFail, { key: 'img', width: 300, className: 'ob-fail-shot' }),
        ])
      : null,

    React.createElement('div', { className: 'ob-game', key: 'stage' }, [
      React.createElement('div', {
        key: 'judge',
        className: flashOn ? `ob-game-judge hit ${flash.grade}` : 'ob-game-judge',
        style: { left: `${JUDGE_RATIO * 100}%` },
      }),
      // 命中等级在判定线右侧闪一下。
      flashOn && flash !== null
        ? React.createElement(
            'div',
            {
              key: `flash-${flash.at}`,
              className: `ob-game-flash ${flash.grade}`,
              style: { left: `calc(${JUDGE_RATIO * 100}% + 10px)` },
            },
            flash.grade === 'perfect' ? 'PERFECT!' : 'GOOD',
          )
        : null,
      ...trackNodes,
    ]),

    React.createElement(
      'div',
      { className: 'ob-hint', key: 'keys' },
      `键盘 ${TRACK_KEYS.join(' / ')} 对应四条轨道（键位标在各自轨道右侧），也可以直接用鼠标点那条轨道`,
    ),

    phase === 'ready'
      ? React.createElement(
          'div',
          { className: 'ob-row', key: 'pick' },
          DIFFICULTIES.map((item) =>
            React.createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                className: item.id === difficulty ? 'ob-btn-primary' : undefined,
                title: item.hint,
                onClick: () => {
                  // 先改本地（立刻高亮），再让宿主持久化 —— 顺手也不同步等待。
                  setDifficulty(item.id)
                  props.onPickDifficulty(item.id)
                },
              },
              `${item.label}（${Math.round(totalDurationMs(item) / 1000)} 秒）`,
            ),
          ),
        )
      : null,

    React.createElement('div', { className: 'ob-row', key: 'act' }, [
      phase === 'ready'
        ? React.createElement(
            'button',
            { key: 'go', type: 'button', className: 'ob-btn-primary', onClick: begin },
            '开始（通过后自动备份）',
          )
        : null,
      phase === 'done' && outcome !== null && !outcome.passed
        ? React.createElement(
            'button',
            { key: 'retry', type: 'button', className: 'ob-btn-primary', onClick: begin },
            '再来一局',
          )
        : null,
      React.createElement(
        'button',
        { key: 'cancel', type: 'button', onClick: props.onClose },
        phase === 'done' && outcome !== null && !outcome.passed ? '放弃备份' : '取消',
      ),
      React.createElement(
        'span',
        { className: 'ob-hint', key: 'rule' },
        '满分 100，扣分到 30 就判定失败，备份不会触发',
      ),
    ]),
  ])
}

/**
 * 凭证块：在界面上填 AK/SK，由宿主写进**它自己的** `process.env`。
 *
 * 安全边界与"只从环境变量读"完全一致，只是多了一条写入路径：
 *   · **不落盘** —— 宿主零文件写入，进程退出即失效（所以重启后要重填）；
 *   · **不回显** —— 提交后立刻清空输入框，宿主响应里只有变量名列表；
 *   · **不进日志** —— 宿主只记"注入了哪些变量名"。
 *
 * @param props - 快照与"状态可能已变"回调。
 * @returns React 元素。
 */
function CredentialBlock(props: { snapshot: StateSnapshot; onChanged: () => void }): React.ReactElement {
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [remember, setRemember] = useState(false)

  const env = props.snapshot.environment
  const credentials = props.snapshot.credentials
  const names = env.variableNames

  const submit = useCallback(() => {
    if (accessKeyId.trim() === '' && secretAccessKey.trim() === '') {
      setNote('至少填一个值')
      return
    }
    const persist = remember && credentials.persistent
    setBusy(true)
    void saveCredentials(accessKeyId, secretAccessKey, persist).then((result) => {
      setBusy(false)
      // 无论成败都立刻清空：值已经交出去了，留在组件状态里没有任何好处。
      setAccessKeyId('')
      setSecretAccessKey('')
      setNote(
        result.ok
          ? persist
            ? '已注入并加密保存到本机 ✓'
            : '已注入本次进程的环境变量，立即可用 ✓'
          : `失败：${result.error ?? '未知错误'}`,
      )
      props.onChanged()
    })
  }, [accessKeyId, secretAccessKey, remember, credentials.persistent, props])

  return React.createElement('div', { className: 'ob-block' }, [
    React.createElement('div', { className: 'ob-row', key: 'head' }, [
      React.createElement('span', { className: 'ob-sect-title', key: 't' }, '凭证（在设置页填写）'),
      React.createElement(
        'span',
        { className: credentials.sessionOnly ? 'ob-badge' : 'ob-hint', key: 's' },
        credentials.sessionOnly
          ? `本次进程已注入：${credentials.sessionVars.join('、')}`
          : env.accessKeyConfigured && env.secretKeyConfigured
            ? credentials.fromDotenv.length > 0
              ? `.env（${credentials.fromDotenv.join('、')}）`
              : credentials.fromOs.length > 0
                ? `系统环境变量（自动补读：${credentials.fromOs.join('、')}）`
                : '当前来自环境变量'
            : '尚未配置',
      ),
    ]),

    React.createElement('div', { className: 'ob-row', key: 'ak' }, [
      React.createElement('span', { className: 'ob-hint', key: 'k' }, names.accessKeyId),
      React.createElement('input', {
        key: 'v',
        type: 'password',
        className: 'ob-input',
        value: accessKeyId,
        autoComplete: 'off',
        spellCheck: false,
        placeholder: '仅本次进程，提交后不回显',
        onChange: (event: { target: { value: string } }) => setAccessKeyId(event.target.value),
      }),
    ]),

    React.createElement('div', { className: 'ob-row', key: 'sk' }, [
      React.createElement('span', { className: 'ob-hint', key: 'k' }, names.secretAccessKey),
      React.createElement('input', {
        key: 'v',
        type: 'password',
        className: 'ob-input',
        value: secretAccessKey,
        autoComplete: 'off',
        spellCheck: false,
        placeholder: '仅本次进程，提交后不回显',
        onChange: (event: { target: { value: string } }) => setSecretAccessKey(event.target.value),
      }),
    ]),

    // 「记住到本机」只在宿主**显式**开启了持久化时才出现；未开启时不显示任何提示 ——
    // 这个能力不对普通用户开放，界面上不留引导文案。
    credentials.persistent
      ? React.createElement('label', { className: 'ob-row', key: 'remember' }, [
          React.createElement('input', {
            key: 'c',
            type: 'checkbox',
            checked: remember,
            onChange: (event: { target: { checked: boolean } }) => setRemember(event.target.checked),
          }),
          React.createElement(
            'span',
            { className: 'ob-hint', key: 't' },
            `记住到本机（${credentials.storeLabel ?? 'OS 密钥库'}）—— 密文落盘，只有当前系统账户能解开`,
          ),
        ])
      : null,

    React.createElement('div', { className: 'ob-row', key: 'act' }, [
      React.createElement(
        'button',
        { key: 'go', type: 'button', className: 'ob-btn-primary', disabled: busy, onClick: submit },
        busy ? '注入中…' : '应用到本次进程',
      ),
      note === '' ? null : React.createElement('span', { className: 'ob-warn', key: 'note' }, note),
    ]),
  ])
}

/**
 * 手动备份块：一个按钮 + 进度 + 上次汇总。
 *
 * @param props - 快照与"状态可能已变"回调。
 * @returns React 元素。
 */
function ManualBlock(props: {
  snapshot: StateSnapshot
  onChanged: () => void
  onRequestBackup: () => void
}): React.ReactElement {
  const { snapshot } = props
  const [starting, setStarting] = useState(false)
  const [note, setNote] = useState('')
  const manual = snapshot.manual
  const directory = snapshot.settings.backupDir
  const running = manual?.running === true
  const gameEnabled = snapshot.settings.gameEnabled
  // 服务连不上时宿主已经把上传入口全拦了 —— 按钮直接禁用，别让人点了才发现不行。
  const blocked = !snapshot.uploadAllowed
  const percent =
    manual !== null && manual !== undefined && manual.total > 0
      ? Math.round((manual.done / manual.total) * 100)
      : 0

  // 开了小游戏就先让用户玩一局（通过了才真的开始备份）；关掉游戏时直接开跑。
  const start = useCallback(() => {
    if (gameEnabled) {
      props.onRequestBackup()
      return
    }
    setStarting(true)
    void startManualBackup().then((result) => {
      setStarting(false)
      setNote(result.ok ? '' : `启动失败：${result.error ?? '未知错误'}`)
      props.onChanged()
    })
  }, [props, gameEnabled])

  return React.createElement('div', { className: 'ob-block' }, [
    React.createElement('div', { className: 'ob-row', key: 'head' }, [
      React.createElement('span', { className: 'ob-sect-title', key: 't' }, '手动备份（整个文件夹）'),
      React.createElement(
        'span',
        { className: running ? 'ob-badge' : 'ob-hint', key: 's' },
        running
          ? `进行中 ${manual?.done ?? 0}/${manual?.total ?? 0}`
          : directory === ''
            ? '先在上面填「备份目录」'
            : `递归备份：${directory}`,
      ),
    ]),

    React.createElement('div', { className: running ? 'ob-progress' : 'ob-progress', key: 'bar' }, [
      React.createElement('i', { key: 'i', style: { width: `${percent}%` } }),
    ]),

    React.createElement('div', { className: 'ob-row', key: 'act' }, [
      React.createElement(
        'button',
        {
          key: 'run',
          type: 'button',
          className: 'ob-btn-primary',
          disabled: running || starting || directory === '' || blocked,
          title: blocked ? (snapshot.uploadBlockedReason ?? '对象存储当前不可用') : undefined,
          onClick: start,
        },
        blocked
          ? '服务连不上，已暂停上传'
          : running
            ? '备份中…'
            : starting
              ? '启动中…'
              : '立即备份',
      ),
      running && manual !== null ? React.createElement('span', { className: 'ob-hint', key: 'cur' }, `当前：${manual.current}`) : null,
      blocked
        ? React.createElement(
            'span',
            { className: 'ob-warn', key: 'blocked' },
            `${snapshot.uploadBlockedReason ?? '对象存储当前不可用'} —— 请先确认服务已启动；恢复后会自动重新可用。`,
          )
        : null,
      note === '' ? null : React.createElement('span', { className: 'ob-warn', key: 'note' }, note),
    ]),

    manual?.result != null
      ? React.createElement(
          'div',
          { className: 'ob-hint', key: 'result' },
          `上次：共 ${manual.result.total} 个文件 → 成功 ${manual.result.uploaded} / 失败 ${manual.result.failed} · ${formatBytes(manual.result.bytes)}` +
            (manual.result.skippedFiles > 0 ? ` · 因限额跳过 ${manual.result.skippedFiles} 个` : '') +
            (manual.result.truncated ? ' · 已触到文件数上限' : ''),
        )
      : null,

    manual?.result != null && manual.result.errors.length > 0
      ? React.createElement('div', { className: 'ob-code', key: 'errs' }, manual.result.errors.join('\n'))
      : null,

    React.createElement(
      'div',
      { className: 'ob-hint', key: 'tip' },
      '递归上传备份目录下的所有文件（含各级子目录）；node_modules、.git、.pnpm-store 等依赖目录自动跳过，另带文件数与大小上限。',
    ),
  ])
}

/**
 * 环境自检区。
 *
 * @param props - 快照。
 * @returns React 元素。
 */
function EnvironmentBlock(props: { snapshot: StateSnapshot }): React.ReactElement {
  const env = props.snapshot.environment
  const names = env.variableNames
  const rows: React.ReactElement[] = [
    React.createElement(Field, {
      key: 'endpoint',
      name: names.endpoint,
      value: env.endpoint ?? '（未设置）',
      tone: env.endpoint === null ? 'bad' : undefined,
    }),
    React.createElement(Field, {
      key: 'bucket',
      name: names.bucket,
      value: env.bucket ?? '（未设置）',
      tone: env.bucket === null ? 'bad' : undefined,
    }),
    React.createElement(Field, {
      key: 'provider',
      name: 'OSS_PROVIDER',
      value: `${env.providerLabel}${env.forcePathStyle ? ' · path-style' : ' · 虚拟主机风格'}`,
    }),
    React.createElement(Field, { key: 'region', name: names.region, value: env.region }),
    React.createElement(Field, {
      key: 'ak',
      name: names.accessKeyId,
      value: env.accessKeyConfigured ? '已设置（值不显示）' : '未设置',
      tone: env.accessKeyConfigured ? 'ok' : 'bad',
    }),
    React.createElement(Field, {
      key: 'sk',
      name: names.secretAccessKey,
      value: env.secretKeyConfigured ? '已设置（值不显示）' : '未设置',
      tone: env.secretKeyConfigured ? 'ok' : 'bad',
    }),
  ]

  // 「变量配齐」和「服务能用」是两回事：宿主会真发一次 HeadBucket 探可达性。
  const reach = env.reachability
  const unreachable = env.ready && reach !== null && !reach.reachable

  return React.createElement('div', { className: 'ob-block' }, [
    React.createElement('div', { className: 'ob-row', key: 'head' }, [
      React.createElement('span', { className: 'ob-sect-title', key: 't' }, '环境自检'),
      React.createElement(
        'span',
        { className: env.ready && !unreachable ? 'ob-ok' : 'ob-bad', key: 's' },
        !env.ready
          ? `缺少 ${env.missing.length} 个变量`
          : unreachable
            ? '变量齐了，但服务连不上'
            : '就绪',
      ),
    ]),
    unreachable
      ? React.createElement(
          'div',
          { className: 'ob-warn', key: 'unreachable' },
          `对象存储连不上：${reach?.error ?? '未知原因'} —— 上传会失败，自动备份连续失败几次后会自行暂停。请确认服务已启动、端点与桶名正确。`,
        )
      : null,
    React.createElement('div', { className: 'ob-grid', key: 'grid' }, rows),
    env.ready
      ? null
      : React.createElement(
          'div',
          { className: 'ob-code', key: 'missing' },
          [
            '未设置：',
            env.missing.join('、'),
            '\n\n在启动 dsh web 之前设置（Windows 示例，值请自己填）：\n',
            `setx ${names.endpoint} "http://127.0.0.1:9000"`,
            `\nsetx ${names.bucket} "your-bucket"`,
            `\nsetx ${names.accessKeyId} "<你的子账号 AK>"`,
            `\nsetx ${names.secretAccessKey} "<你的子账号 SK>"`,
            '\n\n设完必须重启 dsh web：宿主只在进程启动时读一次环境变量。',
          ].join(''),
        ),
  ])
}

/**
 * 上传记录区。
 *
 * @param props - 记录列表。
 * @returns React 元素。
 */
function HistoryBlock(props: { items: readonly UploadRecord[] }): React.ReactElement {
  return React.createElement('div', { className: 'ob-block' }, [
    React.createElement('div', { className: 'ob-hist-head', key: 'head' }, [
      React.createElement('span', { className: 'ob-sect-title', key: 't' }, `最近上传（保留 ${props.items.length} 条）`),
    ]),
    props.items.length === 0
      ? React.createElement('div', { className: 'ob-empty', key: 'empty' }, '还没有上传记录')
      : React.createElement(
          'div',
          { className: 'ob-hist', key: 'list' },
          props.items.slice(0, 8).map((item, index) =>
            React.createElement('div', { className: 'ob-hist-row', key: `${item.at}-${index}` }, [
              React.createElement('span', { key: 'at' }, formatTime(item.at)),
              React.createElement('span', { className: 'key', key: 'key', title: item.objectKey }, item.objectKey),
              React.createElement('span', { key: 'size' }, formatBytes(item.bytes)),
            ]),
          ),
        ),
  ])
}

/**
 * 主体面板（设置页与主面板共用）。
 *
 * @param props - `variant` 决定是设置页样式还是整页面板样式。
 * @returns React 元素。
 */
export function OssPanel(props: { variant?: 'settings' | 'panel' }): React.ReactElement {
  const { snapshot, error, loading, refresh } = useOssState()
  const isPanel = props.variant === 'panel'
  const env = snapshot?.environment ?? null
  const busy = snapshot?.busy === true
  /** 小游戏是否正占据「上传状态」那一格。 */
  const [gameActive, setGameActive] = useState(false)

  /** 真正开跑一次手动备份 —— 游戏通过后走的也是这条路。 */
  const runBackup = useCallback(() => {
    void startManualBackup().then(() => {
      void refresh()
    })
  }, [refresh])

  const handlePass = useCallback(() => {
    setGameActive(false)
    runBackup()
  }, [runBackup])

  const pickDifficulty = useCallback(
    (id: string) => {
      if (snapshot === null) return
      // 难度是设置的一部分，顺手持久化，下次打开还是这档。
      void saveSettings({ ...snapshot.settings, gameDifficulty: id }).then(() => {
        void refresh()
      })
    },
    [snapshot, refresh],
  )

  return React.createElement('div', { className: isPanel ? 'ob-wrap is-panel' : 'ob-wrap' }, [
    React.createElement('div', { className: 'ob-head', key: 'head' }, [
      React.createElement('h2', { className: 'ob-title', key: 'title' }, '对象存储备份'),
      React.createElement(
        'div',
        { className: 'ob-sub', key: 'sub' },
        '把工作区文件上传到 S3 兼容对象存储（RustFS / 阿里云 OSS / AWS S3）。AK/SK 只从环境变量读取。',
      ),
    ]),

    // 指标卡：端点 / 桶 / 状态，一眼能看出"能不能用"。
    React.createElement('div', { className: 'ob-metrics', key: 'metrics' }, [
      React.createElement(MetricCard, {
        key: 'endpoint',
        label: '存储端点',
        value: env?.endpoint ?? '—',
        sub: env?.bucket === null || env?.bucket === undefined ? '桶未设置' : `bucket: ${env.bucket}`,
        live: busy,
        tone: env === null ? undefined : env.endpoint === null ? 'bad' : 'ok',
      }),
      React.createElement(MetricCard, {
        key: 'state',
        label: '环境状态',
        value:
          snapshot === null
            ? '未连接'
            : env?.ready !== true
              ? '缺配置'
              : env.reachability !== null && !env.reachability.reachable
                ? '服务连不上'
                : '就绪',
        sub:
          snapshot === null
            ? error ?? '正在读取…'
            : env?.ready === true && env.reachability !== null && !env.reachability.reachable
              ? `已配 AK/SK，但连不上：${env.reachability.error ?? '未知原因'}`
              : `AK ${env?.accessKeyConfigured === true ? '已设置' : '未设置'} · SK ${env?.secretKeyConfigured === true ? '已设置' : '未设置'} · ${env?.region ?? ''}`,
        live: busy,
        tone:
          snapshot === null
            ? undefined
            : env?.ready !== true || (env.reachability !== null && !env.reachability.reachable)
              ? 'bad'
              : 'ok',
      }),
    ]),

    snapshot === null
      ? React.createElement('div', { className: 'ob-block', key: 'offline' }, [
          React.createElement('span', { className: 'ob-sect-title', key: 't' }, '宿主状态'),
          React.createElement('div', { className: 'ob-hint', key: 'e' }, error ?? '正在读取…'),
          React.createElement(
            'div',
            { className: 'ob-hint', key: 'tip' },
            '如果一直这样：确认插件已安装并重启过 dsh web（宿主半边不热重载）。',
          ),
        ])
      : gameActive && snapshot.settings.gameEnabled
        ? React.createElement(BackupGame, {
            key: 'game',
            difficulty: snapshot.settings.gameDifficulty,
            onPickDifficulty: pickDifficulty,
            onPass: handlePass,
            onClose: () => setGameActive(false),
          })
        : React.createElement(UploadBlock, { key: 'upload', snapshot }),

    React.createElement(ConsoleBlock, { key: 'console' }),

    // 手动备份紧跟在「云端备份」下面 —— 这两个是"动手做点什么"的一组，放一起更顺。
    snapshot === null
      ? null
      : React.createElement(ManualBlock, {
          key: 'manual',
          snapshot,
          onChanged: () => {
            void refresh()
          },
          onRequestBackup: () => setGameActive(true),
        }),

    snapshot === null
      ? null
      : React.createElement(SettingsBlock, {
          key: 'settings',
          settings: snapshot.settings,
          report: snapshot.autoBackup,
          nextRunAt: snapshot.schedule.nextRunAt,
          uploadAllowed: snapshot.uploadAllowed,
          blockedReason: snapshot.uploadBlockedReason,
          onSaved: () => {
            void refresh()
          },
        }),

    snapshot === null
      ? null
      : React.createElement(CredentialBlock, {
          key: 'credentials',
          snapshot,
          onChanged: () => {
            void refresh()
          },
        }),

    snapshot === null ? null : React.createElement(EnvironmentBlock, { key: 'env', snapshot }),

    snapshot === null ? null : React.createElement(HistoryBlock, { key: 'hist', items: snapshot.history }),

    React.createElement('div', { className: 'ob-actions', key: 'actions' }, [
      React.createElement(
        'button',
        { key: 'refresh', type: 'button', disabled: loading, onClick: () => void refresh() },
        loading ? '自检中…' : '重新自检',
      ),
      React.createElement(
        'span',
        { className: 'ob-hint', key: 'poll' },
        busy ? '上传中：每秒刷新一次' : `每 ${Math.round(IDLE_POLL_MS / 1000)} 秒自动刷新一次`,
      ),
    ]),
  ])
}

/** 侧栏图标的尺寸上下限，避免别的插件传进极端值。 */
const ICON_MIN = 14
const ICON_MAX = 64

/**
 * 侧边栏栏目：云上传图标 + 就绪短标签；**上传中在图标下方弹出那张图**。
 *
 * @param props - 侧边栏给的图标槽属性（尺寸、是否选中）。
 * @returns React 元素。
 */
export function OssSidebarEntry(props: { size?: number; active?: boolean }): React.ReactElement {
  const raw = typeof props.size === 'number' && Number.isFinite(props.size) ? props.size : 30
  const size = Math.min(ICON_MAX, Math.max(ICON_MIN, Math.round(raw)))
  const { snapshot } = useOssState()

  const busy = snapshot?.busy === true
  const ready = snapshot !== null && snapshot.environment.ready
  // 「配好了变量」和「服务真的连得上」是两回事 —— 侧边栏也要如实反映后者。
  const unreachable =
    ready && snapshot.environment.reachability !== null && !snapshot.environment.reachability.reachable
  const caption =
    snapshot === null ? '未连接' : busy ? '上传中' : unreachable ? '连不上' : ready ? '已就绪' : '缺配置'
  const tone = snapshot === null ? undefined : busy || (ready && !unreachable) ? 'ob-ok' : 'ob-bad'

  return React.createElement('div', { className: 'ob-bar' }, [
    React.createElement(
      'svg',
      {
        key: 'icon',
        className: props.active === true ? 'ob-icon on' : 'ob-icon',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        role: 'img',
      },
      [
        React.createElement('title', { key: 'title' }, `对象存储备份 · ${caption}`),
        // 云 + 向上箭头。
        React.createElement('path', { key: 'cloud', d: 'M7 18h9a4 4 0 0 0 .6-8A5.5 5.5 0 0 0 6 11.2 3.4 3.4 0 0 0 7 18z' }),
        React.createElement('path', { key: 'arrow', d: 'M12 20.5V13' }),
        React.createElement('path', { key: 'head', d: 'M9.2 15.4 12 12.6l2.8 2.8' }),
      ],
    ),
    React.createElement('span', { className: tone === undefined ? 'cap' : `cap ${tone}`, key: 'cap' }, caption),
    busy
      ? React.createElement(UploadShot, {
          key: 'shot',
          width: SIDEBAR_SHOT_WIDTH,
          className: 'ob-bar-shot',
        })
      : null,
  ])
}
