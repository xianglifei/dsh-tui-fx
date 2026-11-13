import type { Context } from '@deepseek-ai/cordis'
import type { JobEvent, JobView } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { activeJobs, JobWatcher, jobDetail, jobRow, jobsPanel, resolveJob, settleNotice } from './jobs.js'
import { TuiStore } from './store.js'

const JOB = (over: Partial<JobView> = {}): JobView => ({
  id: 'bash-1a2b' as JobView['id'],
  kind: 'bash',
  label: 'pnpm build',
  status: 'running',
  startedAt: 1_000,
  ...over,
} as JobView)

describe('job rendering', () => {
  it('counts running and stopping jobs only', () => {
    const views = [JOB(), JOB({ status: 'stopping' }), JOB({ status: 'completed' }), JOB({ status: 'failed' })]
    expect(activeJobs(views)).toHaveLength(2)
  })

  it('resolves a unique prefix, reports ambiguity, and ignores empty input', () => {
    const a = JOB({ id: 'bash-1a2b' as JobView['id'] })
    const b = JOB({ id: 'bash-9z9z' as JobView['id'] })
    expect(resolveJob([a, b], 'bash-1a')).toEqual({ job: a })
    expect(resolveJob([a, b], 'bash-')).toEqual({ ambiguous: [a, b] })
    expect(resolveJob([a, b], 'nope')).toBeUndefined()
    expect(resolveJob([a, b], '')).toBeUndefined()
  })

  it('renders a row with status, progress and elapsed time', () => {
    const row = jobRow(JOB({ progress: '3/10', detail: undefined }), 13_000)
    expect(row).toContain('bash-1a2b · bash · pnpm build · 运行中 · 3/10 · 12.0s')
  })

  it('shows an empty roster honestly', () => {
    expect(jobsPanel([])[0]).toContain('没有后台任务')
  })

  it('caps a long roster and says how many were dropped', () => {
    const views = Array.from({ length: 15 }, (_, index) => JOB({ id: `bash-${index}` as JobView['id'] }))
    const lines = jobsPanel(views, 2_000, 12)
    expect(lines[0]).toContain('15 个任务')
    expect(lines.some(line => line.includes('还有 3 个'))).toBe(true)
  })

  it('tails the output and admits a lossy ring', () => {
    const lines = jobDetail(JOB({ status: 'completed', finishedAt: 3_000 }), { text: 'a\nb\nc', lossy: true })
    expect(lines.join('\n')).toContain('a')
    expect(lines.join('\n')).toContain('输出较早部分已被环形缓冲裁剪')
  })

  it('phrases each settlement by outcome', () => {
    expect(settleNotice(JOB({ status: 'completed', finishedAt: 3_000 }), 3_000)).toMatchObject({ tone: 'info', text: '⚙ 后台任务完成：pnpm build（2.0s）' })
    expect(settleNotice(JOB({ status: 'failed', detail: 'exit code: 1', finishedAt: 3_000 }), 3_000)).toMatchObject({ tone: 'error' })
    expect(settleNotice(JOB({ status: 'killed', finishedAt: 3_000 }), 3_000)).toMatchObject({ tone: 'warn' })
  })
})

// -- Watcher ----------------------------------------------------------------

interface Harness {
  readonly store: TuiStore
  readonly watcher: JobWatcher
  emit(event: JobEvent): void
  setJobs(views: JobView[]): void
  killed: string[]
}

function watcherHarness(initial: JobView[] = []): Harness {
  const store = new TuiStore('s1', 'p/m')
  let views = initial
  const listeners = new Set<(event: JobEvent) => void>()
  const killed: string[] = []
  const registry = {
    list: (): readonly JobView[] => views,
    readAt: (): { chunks: { text: string }[]; next: number } => ({ chunks: [{ text: 'out' }], next: 3 }),
    kill: (id: string): 'requested' => { killed.push(id); return 'requested' },
    events: {
      subscribe: (_filter: unknown, listener: (event: JobEvent) => void): (() => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
  const ctx = { get: (name: string): unknown => (name === 'jobs' ? registry : undefined) } as unknown as Context
  const watcher = new JobWatcher(ctx, store, 's1' as SessionId)
  watcher.start()
  return {
    store,
    watcher,
    killed,
    setJobs: next => { views = next },
    emit: event => { for (const listener of listeners) listener(event) },
  }
}

describe('JobWatcher', () => {
  it('seeds the status-line count from the registry', () => {
    const harness = watcherHarness([JOB(), JOB({ status: 'completed' })])
    expect(harness.store.getSnapshot().jobs).toBe(1)
    expect(harness.watcher.runningCount()).toBe(1)
  })

  it('announces an unawaited settlement and stays quiet for a collected one', () => {
    const harness = watcherHarness()
    harness.emit({ type: 'settled', job: JOB({ status: 'completed', finishedAt: 3_000 }), cause: 'producer', awaited: false } as JobEvent)
    expect(harness.store.getSnapshot().items.at(-1)).toMatchObject({ kind: 'notice', text: '⚙ 后台任务完成：pnpm build（2.0s）' })

    const quiet = watcherHarness()
    quiet.emit({ type: 'settled', job: JOB({ status: 'completed', finishedAt: 3_000 }), cause: 'producer', awaited: true } as JobEvent)
    expect(quiet.store.getSnapshot().items).toEqual([])
  })

  it('drops the count when the last job settles', () => {
    const harness = watcherHarness([JOB()])
    harness.setJobs([])
    harness.emit({ type: 'settled', job: JOB({ status: 'completed', finishedAt: 3_000 }), cause: 'producer', awaited: true } as JobEvent)
    expect(harness.store.getSnapshot().jobs).toBe(0)
  })

  it('degrades to no access when the composition has no jobs service', () => {
    const store = new TuiStore('s1', 'p/m')
    const ctx = { get: (): undefined => undefined } as unknown as Context
    const watcher = new JobWatcher(ctx, store, 's1' as SessionId)
    watcher.start()
    expect(watcher.access()).toBeUndefined()
    expect(store.getSnapshot().jobs).toBe(0)
  })

  it('exposes list/output/kill through one session-scoped accessor', () => {
    const harness = watcherHarness([JOB()])
    const access = harness.watcher.access()
    expect(access?.list()).toHaveLength(1)
    expect(access?.output('bash-1a2b' as JobView['id'])).toEqual({ text: 'out', lossy: false })
    expect(access?.kill('bash-1a2b' as JobView['id'])).toBe('requested')
    expect(harness.killed).toEqual(['bash-1a2b'])
  })
})
