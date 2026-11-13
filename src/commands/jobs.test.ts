import type { JobView } from '@deepseek-ai/dsh-jobs'
import { describe, expect, it } from 'vitest'
import type { JobAccess } from '../jobs.js'
import { runJobs } from './jobs.js'
import { makeCtx } from './test-helpers.js'

const JOB = (over: Partial<JobView> = {}): JobView => ({
  id: 'bash-1a2b' as JobView['id'],
  kind: 'bash',
  label: 'pnpm build',
  status: 'running',
  startedAt: 1_000,
  ...over,
} as JobView)

function access(views: readonly JobView[], killed: string[] = []): JobAccess {
  return {
    list: () => views,
    output: () => ({ text: 'line one\nline two', lossy: false }),
    kill: (id): 'requested' => { killed.push(String(id)); return 'requested' },
  }
}

describe('/jobs', () => {
  it('says when the composition has no jobs service', () => {
    const { c, log } = makeCtx()
    runJobs(c, '')
    expect(log.notices[0]).toContain('没有后台任务服务')
  })

  it('lists the roster', () => {
    const { c, log } = makeCtx({ jobs: () => access([JOB()]) })
    runJobs(c, '')
    expect(log.panels[0]?.title).toBe('后台任务')
    expect(log.panels[0]?.lines.join('\n')).toContain('bash-1a2b')
  })

  it('shows one job by prefix with its retained output', () => {
    const { c, log } = makeCtx({ jobs: () => access([JOB()]) })
    runJobs(c, 'bash-1')
    expect(log.panels[0]?.title).toBe('任务 bash-1a2b')
    expect(log.panels[0]?.lines.join('\n')).toContain('line one')
  })

  it('kills by unique prefix', () => {
    const killed: string[] = []
    const { c, log } = makeCtx({ jobs: () => access([JOB()], killed) })
    runJobs(c, 'kill bash-1')
    expect(killed).toEqual(['bash-1a2b'])
    expect(log.notices[0]).toContain('已请求取消 bash-1a2b')
  })

  it('refuses an ambiguous prefix and lists the candidates', () => {
    const views = [JOB(), JOB({ id: 'bash-9z9z' as JobView['id'], label: 'lint' })]
    const { c, log } = makeCtx({ jobs: () => access(views) })
    runJobs(c, 'kill bash-')
    expect(log.panels[0]?.title).toBe('任务前缀不唯一')
    expect(log.panels[0]?.lines.join('\n')).toContain('bash-9z9z')
  })

  it('reports an unknown prefix without calling kill', () => {
    const killed: string[] = []
    const { c, log } = makeCtx({ jobs: () => access([JOB()], killed) })
    runJobs(c, 'nope')
    expect(killed).toEqual([])
    expect(log.notices[0]).toContain('没有匹配')
  })

  it('requires an id for kill', () => {
    const { c, log } = makeCtx({ jobs: () => access([JOB()]) })
    runJobs(c, 'kill')
    expect(log.notices[0]).toContain('用法：/jobs kill')
  })
})
