/** `/jobs`: the background-job roster, one job's retained output, and cancel. */

import type { JobView } from '@deepseek-ai/dsh-jobs'
import { jobDetail, jobsPanel, resolveJob } from '../jobs.js'
import type { CommandCtx } from './types.js'

export function runJobs(c: CommandCtx, rest: string): void {
  const access = c.jobs?.()
  if (access === undefined) {
    c.store.addNotice('当前组合没有后台任务服务（dsh-base 提供 dsh-jobs-local）', 'warn')
    return
  }
  const views = access.list()
  const args = rest.trim()
  if (args === '') {
    c.store.addPanel('后台任务', [...jobsPanel(views)])
    return
  }
  const [verb, ...tail] = args.split(/\s+/)
  if (verb === 'kill') {
    const prefix = tail.join(' ').trim()
    if (prefix === '') {
      c.store.addNotice('用法：/jobs kill <id 前缀>', 'warn')
      return
    }
    const resolved = resolveJob(views, prefix)
    reportResolution(c, resolved, prefix, job => {
      const outcome = access.kill(job.id)
      if (outcome === 'requested') c.store.addNotice(`已请求取消 ${job.id}（${job.label}）`)
      else c.store.addNotice(`${job.id} 已经结束，无需取消`, 'warn')
    })
    return
  }
  const resolved = resolveJob(views, args)
  reportResolution(c, resolved, args, job => {
    c.store.addPanel(`任务 ${job.id}`, [...jobDetail(job, access.output(job.id))])
  })
}

type Resolution = { readonly job: JobView } | { readonly ambiguous: readonly JobView[] } | undefined

function reportResolution(
  c: CommandCtx,
  resolved: Resolution,
  prefix: string,
  onResolved: (job: JobView) => void,
): void {
  if (resolved === undefined) {
    c.store.addNotice(`没有匹配「${prefix}」的后台任务 · /jobs 看列表`, 'warn')
    return
  }
  if ('ambiguous' in resolved) {
    c.store.addPanel('任务前缀不唯一', [
      `「${prefix}」匹配 ${resolved.ambiguous.length} 个任务：`,
      '',
      ...resolved.ambiguous.map(job => `${job.id} · ${job.label}`),
      '',
      '输入更长的前缀再试。',
    ])
    return
  }
  onResolved(resolved.job)
}
