/**
 * Background-job surface: the status-line count, `/jobs`, and the completion
 * lines a long-running task needs to announce itself.
 *
 * `ctx.jobs` is optional — dsh-base mounts `dsh-jobs-local`, but a profile can
 * omit it, so every entry point degrades to "this composition has no jobs
 * service" instead of assuming the registry exists. All rendering is pure and
 * unit-tested against plain `JobView` values; the watcher only wires events.
 */

import type { Context } from '@deepseek-ai/cordis'
// Declaration-merge carrier: registers `ctx.jobs` and the `job/*` events.
import type {} from '@deepseek-ai/dsh-jobs'
import type { JobEvent, JobId, JobView } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiStore } from './store.js'
import { formatElapsed } from './text.js'
import { truncateLine } from './ui/estimate.js'

/** The narrow slice the slash command needs; tests stub exactly this. */
export interface JobAccess {
  list(): readonly JobView[]
  /** Retained output of one job (never moves the model's own cursor). */
  output(id: JobId): { readonly text: string; readonly lossy: boolean }
  kill(id: JobId): 'requested' | 'already-finished'
}

/** Jobs the status bar counts: live work, including the stopping window. */
export function activeJobs(views: readonly JobView[]): readonly JobView[] {
  return views.filter(job => job.status === 'running' || job.status === 'stopping')
}

/** Prefix resolution for `/jobs <id>`: one match, none, or an ambiguous set. */
export function resolveJob(
  views: readonly JobView[],
  prefix: string,
): { readonly job: JobView } | { readonly ambiguous: readonly JobView[] } | undefined {
  if (prefix === '') return undefined
  const matches = views.filter(job => job.id.startsWith(prefix))
  const [only] = matches
  if (matches.length === 1 && only !== undefined) return { job: only }
  if (matches.length > 1) return { ambiguous: matches }
  return undefined
}

/** `bash-1a2b · pnpm build · 运行中 · 12.3s` — one row of the roster. */
export function jobRow(job: JobView, now = Date.now()): string {
  const elapsed = (job.finishedAt ?? now) - job.startedAt
  const status = job.status === 'running' ? '运行中'
    : job.status === 'stopping' ? '停止中'
      : job.status === 'completed' ? '完成'
        : job.status === 'killed' ? '已取消' : '失败'
  const progress = job.progress !== undefined && job.progress !== '' ? ` · ${job.progress}` : ''
  const detail = job.detail !== undefined && job.detail !== '' ? ` · ${job.detail}` : ''
  return truncateLine(`${job.id} · ${job.kind} · ${job.label} · ${status}${progress}${detail} · ${formatElapsed(elapsed)}`, 160)
}

/** `/jobs` roster: header, rows (capped), and the next-step hint. */
export function jobsPanel(views: readonly JobView[], now = Date.now(), limit = 12): readonly string[] {
  if (views.length === 0) return ['（没有后台任务）', '', '后台任务来自 run_in_background 的工具调用；本会话内没有记录。']
  const live = (job: JobView): number => (job.status === 'running' || job.status === 'stopping' ? 1 : 0)
  const sorted = views.toSorted((a, b) => live(b) - live(a) || b.startedAt - a.startedAt)
  const shown = sorted.slice(0, limit)
  const lines = [`${views.length} 个任务（${activeJobs(views).length} 个在跑）`, '']
  for (const job of shown) lines.push(jobRow(job, now))
  if (sorted.length > shown.length) lines.push(`…（还有 ${sorted.length - shown.length} 个，用 /jobs <id 前缀> 查看）`)
  lines.push('', '/jobs <id 前缀> 看输出 · /jobs kill <id 前缀> 取消')
  return lines
}

/** `/jobs <id>` detail: the settled facts plus the retained tail. */
export function jobDetail(job: JobView, output: { readonly text: string; readonly lossy: boolean }, now = Date.now()): readonly string[] {
  const elapsed = (job.finishedAt ?? now) - job.startedAt
  const lines = [
    `${job.id} · ${job.kind} · ${job.label}`,
    `${jobRow(job, now)}`,
    `状态：${job.status} · 耗时 ${formatElapsed(elapsed)}${job.progress !== undefined ? ` · 进度 ${job.progress}` : ''}`,
    ...(job.detail !== undefined && job.detail !== '' ? [`结算：${job.detail}`] : []),
    ...(output.lossy ? ['（输出较早部分已被环形缓冲裁剪）'] : []),
    '',
  ]
  const text = output.text.trimEnd()
  if (text === '') lines.push('（还没有输出）')
  else {
    const all = text.split('\n')
    const tail = all.slice(-40)
    if (all.length > tail.length) lines.push(`…（前 ${all.length - tail.length} 行省略）`)
    lines.push(...tail)
  }
  return lines
}

/** The one line a settled job contributes to the transcript. */
export function settleNotice(job: JobView, now = Date.now()): { text: string; tone: 'info' | 'warn' | 'error' } {
  const elapsed = formatElapsed(Math.max(0, (job.finishedAt ?? now) - job.startedAt))
  if (job.status === 'failed') {
    const detail = job.detail !== undefined && job.detail !== '' ? ` · ${job.detail}` : ''
    return { text: truncateLine(`⚙ 后台任务失败：${job.label}${detail} · /jobs ${job.id} 看输出`, 160), tone: 'error' }
  }
  if (job.status === 'killed') {
    return { text: truncateLine(`⚙ 后台任务已取消：${job.label}（${elapsed}）`, 160), tone: 'warn' }
  }
  return { text: truncateLine(`⚙ 后台任务完成：${job.label}（${elapsed}）`, 160), tone: 'info' }
}

/** Subscribes to one session's job stream, keeps the status-line count true,
 * and reports settlements the model has not already collected. */
export class JobWatcher {
  private session: SessionId
  private unsubscribe: (() => void) | null = null
  private count = 0

  constructor(
    private readonly ctx: Context,
    private readonly store: TuiStore,
    session: SessionId,
  ) {
    this.session = session
  }

  /** Subscribe for the current session and seed the count. */
  start(): void {
    this.retarget(this.session)
  }

  /** Follow a session switch: the old stream's counts belong to the old owner. */
  retarget(session: SessionId): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.session = session
    const jobs = this.ctx.get('jobs')
    if (jobs !== undefined) {
      this.unsubscribe = jobs.events.subscribe({ owner: session }, event => { this.onEvent(event) })
    }
    this.refresh()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.count = 0
  }

  /** Live count for "still running" lines at turn end. */
  runningCount(): number {
    return this.count
  }

  access(): JobAccess | undefined {
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) return undefined
    const session = (): SessionId => this.session
    return {
      list: () => jobs.list(session()),
      output: id => {
        const read = jobs.readAt(id, 0, session())
        return { text: read.chunks.map(chunk => chunk.text).join(''), lossy: read.chunks.some(chunk => chunk.gapBefore === true) }
      },
      kill: id => jobs.kill(id, session(), 'user'),
    }
  }

  private onEvent(event: JobEvent): void {
    // The stream also carries raw-output notifications that name no job.
    if (!('job' in event)) return
    this.refresh()
    if (event.type !== 'settled') return
    // The model already received this settlement through job_output / job_wait;
    // announcing it again would repeat what the assistant just said.
    if (event.awaited === true) return
    const notice = settleNotice(event.job)
    this.store.addNotice(notice.text, notice.tone)
  }

  private refresh(): void {
    const jobs = this.ctx.get('jobs')
    const views = jobs?.list(this.session) ?? []
    const count = activeJobs(views).length
    if (count === this.count) return
    this.count = count
    this.store.setJobCount(count)
  }
}
