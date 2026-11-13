import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import { runAgents } from './agents.js'
import { makeCtx } from './test-helpers.js'

const CHILD = (over: Record<string, unknown> = {}): SubagentCatalogEntry => ({
  id: 'sess-child-1',
  createdAt: 1_000,
  mode: 'continuable',
  label: '探索方案',
  ...over,
} as unknown as SubagentCatalogEntry)

function ctxWith(
  children: readonly SubagentCatalogEntry[],
  statuses: Record<string, 'idle' | 'running'> = {},
): Record<string, unknown> {
  return {
    agents: { get: (id: string) => (statuses[id] === undefined ? undefined : { id, status: statuses[id] }) },
  }
}

function services(children: readonly SubagentCatalogEntry[], titles: Record<string, string> = {}): Record<string, unknown> {
  return {
    subagents: {
      listChildren: async (): Promise<readonly SubagentCatalogEntry[]> => children,
    },
    sessionQuery: {
      readTitleSnapshots: async (ids: readonly string[]) => ids.map(id => ({
        sessionId: id,
        status: 'fulfilled' as const,
        value: { title: { title: titles[id] ?? `title-${id}` } },
      })),
    },
  }
}

describe('/agents', () => {
  it('says when the composition has no subagent service', async () => {
    const { c, log } = makeCtx()
    await runAgents(c, '')
    expect(log.notices[0]).toContain('没有子代理服务')
  })

  it('lists the roster with live status and the running count', async () => {
    const children = [CHILD(), CHILD({ id: 'sess-child-2', mode: 'one-shot', label: undefined })]
    const { c, log } = makeCtx({}, {
      services: services(children),
      ctx: ctxWith(children, { 'sess-child-1': 'running' }),
    })
    await runAgents(c, '')

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(log.panels[0]?.title).toBe('子代理')
    expect(body).toContain('2 个子代理（1 个在运行）')
    expect(body).toContain('* sess-child-1')
    expect(body).toContain('运行中')
  })

  it('shows one child by prefix and points continuable children at /resume', async () => {
    const children = [CHILD()]
    const { c, log } = makeCtx({}, {
      services: services(children, { 'sess-child-1': '我的标题' }),
      ctx: ctxWith(children, { 'sess-child-1': 'idle' }),
    })
    await runAgents(c, 'sess-child')

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(log.panels[0]?.title).toBe('子代理 sess-child-1')
    expect(body).toContain('我的标题')
    expect(body).toContain('空闲')
    expect(body).toContain('/resume sess-child-1')
  })

  it('explains that a one-shot child cannot be continued', async () => {
    const children = [CHILD({ mode: 'one-shot' })]
    const { c, log } = makeCtx({}, { services: services(children), ctx: ctxWith(children) })
    await runAgents(c, 'sess-child')

    expect((log.panels[0]?.lines ?? []).join('\n')).toContain('one-shot 子代理不能继续对话')
  })

  it('renders an honest empty state', async () => {
    const { c, log } = makeCtx({}, { services: services([]) })
    await runAgents(c, '')
    expect((log.panels[0]?.lines ?? []).join('\n')).toContain('本会话没有子代理')
  })

  it('reports a read failure instead of an empty roster', async () => {
    const { c, log } = makeCtx({}, {
      services: {
        subagents: { listChildren: async (): Promise<never> => { throw new Error('query unavailable') } },
        sessionQuery: { readTitleSnapshots: async (): Promise<never> => { throw new Error('x') } },
      },
    })
    await runAgents(c, '')
    expect(log.notices[0]).toContain('读取子代理目录失败')
  })
})
