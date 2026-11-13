import { describe, expect, it } from 'vitest'
import { goalChip, goalChipTone, goalSeparator, modesSummary, planChip } from './modes.js'

const GOAL = (over: Partial<Parameters<typeof goalChip>[0]> = {}): NonNullable<Parameters<typeof goalChip>[0]> => ({
  phase: 'active',
  roundsStarted: 3,
  maxGoalRounds: 256,
  objective: '把 CI 修绿',
  ...over,
})

describe('plan chip', () => {
  it('hides when plan mode is off and shortens on narrow terminals', () => {
    expect(planChip(false)).toBe('')
    expect(planChip(true)).toBe('📋 计划中')
    expect(planChip(true, true)).toBe('📋')
  })
})

describe('goal chip', () => {
  it('shows progress, pause, block and completion', () => {
    expect(goalChip(GOAL())).toBe('◎ 目标 3/256')
    expect(goalChip(GOAL({ phase: 'paused' }))).toBe('◎ 目标 已暂停')
    expect(goalChip(GOAL({ phase: 'blocked' }))).toBe('◎ 目标 受阻')
    expect(goalChip(GOAL({ phase: 'complete' }))).toBe('◎ 目标 已完成')
  })

  it('collapses to a glyph plus count when narrow', () => {
    expect(goalChip(GOAL(), true)).toBe('◎ 3/256')
    expect(goalChip(GOAL({ phase: 'blocked' }), true)).toBe('◎ 受阻')
  })

  it('hides without a goal and tolerates a missing cap', () => {
    expect(goalChip(null)).toBe('')
    expect(goalChip(GOAL({ maxGoalRounds: 0 }))).toBe('◎ 目标 3')
  })

  it('is red only when blocked, amber when paused', () => {
    expect(goalChipTone(null)).toBeUndefined()
    expect(goalChipTone(GOAL())).toBeUndefined()
    expect(goalChipTone(GOAL({ phase: 'paused' }))).toBe('warning')
    expect(goalChipTone(GOAL({ phase: 'blocked' }))).toBe('danger')
  })
})

describe('goal separator', () => {
  it('names the round and the cap', () => {
    expect(goalSeparator(4, 256)).toBe('── 目标续行 · 第 4 轮（上限 256） ──')
  })

  it('degrades to a bare round when the cap is unknown or bad input arrives', () => {
    expect(goalSeparator(1, null)).toBe('── 目标续行 · 第 1 轮 ──')
    expect(goalSeparator(0, 0)).toBe('── 目标续行 · 第 1 轮 ──')
    expect(goalSeparator(Number.NaN, 10)).toBe('── 目标续行 · 第 1 轮（上限 10） ──')
  })
})

describe('/status summary', () => {
  it('omits empty parts entirely', () => {
    expect(modesSummary({ planActive: false, goal: null, jobs: 0, childAgents: 0 })).toBe('')
  })

  it('joins whatever is present, modes first', () => {
    expect(modesSummary({ planActive: true, goal: GOAL(), jobs: 2, childAgents: 1 }))
      .toBe('模式：计划中 · 目标 3/256 · 任务 ⚙2 · 子代理 🌱1')
  })

  it('phrases a blocked goal by phase', () => {
    expect(modesSummary({ planActive: false, goal: GOAL({ phase: 'blocked' }), jobs: 0, childAgents: 0 }))
      .toBe('模式：目标 受阻')
  })
})
