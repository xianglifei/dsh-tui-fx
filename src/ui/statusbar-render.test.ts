/**
 * Ink-level render of the status bar's mode chips. The estimator and the pure
 * chip helpers are unit-tested elsewhere; this is the one place the actual
 * render path proves the chips appear in order, hide when empty, and shrink on
 * a narrow terminal.
 */

import { Console } from 'node:console'
import { PassThrough, Writable } from 'node:stream'
import type { ReadStream, WriteStream } from 'node:tty'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUS_LINE } from '../statusline.js'
import type { GoalChipState } from '../modes.js'
import { StatusBar } from './StatusBar.js'

// vitest swaps the global console for a capture object without the Console
// constructor, which ink's patch-console needs — restore it before rendering.
;(console as { Console?: typeof Console }).Console ??= Console

const GOAL: GoalChipState = { phase: 'active', roundsStarted: 3, maxGoalRounds: 256, objective: '把 CI 修绿' }

async function renderBar(over: { columns?: number; planActive?: boolean; goal?: GoalChipState | null; jobs?: number; childAgents?: number } = {}): Promise<string> {
  const frames: string[] = []
  class Capture extends Writable {
    override _write(chunk: Buffer, _enc: string, cb: () => void): void {
      frames.push(chunk.toString())
      cb()
    }
  }
  const stdout = new Capture() as unknown as WriteStream & { columns: number; rows: number }
  stdout.columns = over.columns ?? 120
  stdout.rows = 30
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as ReadStream
  const instance = render(
    createElement(StatusBar, {
      phase: 'idle',
      detail: '',
      usage: '',
      reasoningChars: 0,
      contextTokens: 0,
      childAgents: over.childAgents ?? 0,
      jobs: over.jobs ?? 0,
      planActive: over.planActive ?? false,
      goal: over.goal ?? null,
      effortLabel: '',
      retryWait: null,
      items: DEFAULT_STATUS_LINE,
      model: 'p/m',
      gitBranch: '',
      customStatus: null,
      compacting: false,
    }),
    { stdout, stdin, exitOnCtrlC: false },
  )
  instance.unmount()
  await new Promise(resolve => setTimeout(resolve, 50))
  const last = frames.findLast(frame => frame !== '') ?? ''
  return last.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim()
}

describe('StatusBar mode chips', () => {
  it('renders no chips when nothing is active', async () => {
    const line = await renderBar()
    expect(line).not.toContain('📋')
    expect(line).not.toContain('◎')
    expect(line).not.toContain('⚙')
    expect(line).not.toContain('🌱')
  })

  it('renders plan, goal, jobs and subagents in that order', async () => {
    const line = await renderBar({ planActive: true, goal: GOAL, jobs: 2, childAgents: 1 })
    const plan = line.indexOf('📋 计划中')
    const goal = line.indexOf('◎ 目标 3/256')
    const jobs = line.indexOf('⚙×2')
    const child = line.indexOf('🌱×1')
    expect(plan).toBeGreaterThanOrEqual(0)
    expect(goal).toBeGreaterThan(plan)
    expect(jobs).toBeGreaterThan(goal)
    expect(child).toBeGreaterThan(jobs)
  })

  it('shrinks the plan and goal chips on a narrow terminal', async () => {
    const line = await renderBar({ columns: 44, planActive: true, goal: GOAL })
    expect(line).toContain('📋')
    expect(line).not.toContain('计划中')
    expect(line).toContain('◎ 3/256')
  })

  it('keeps a blocked goal visible with its own wording', async () => {
    const line = await renderBar({ goal: { ...GOAL, phase: 'blocked' } })
    expect(line).toContain('◎ 目标 受阻')
  })
})
