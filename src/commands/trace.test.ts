import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { runTrace, runTree } from './trace.js'
import { cleanupTempHomes, makeCtx, sessionEvent } from './test-helpers.js'

afterEach(cleanupTempHomes)

const CREATED = Date.UTC(2026, 0, 2, 3, 4)

interface RecordOptions {
  readonly cwd?: string
  readonly parent?: string
}

function session(id: string, options: RecordOptions = {}): unknown {
  return {
    header: {
      id,
      cwd: options.cwd ?? '/tmp/work',
      createdAt: CREATED,
      ...(options.parent !== undefined ? { parentSession: options.parent } : {}),
    },
    live: false,
    persisted: true,
  }
}

function traced(parts: {
  readonly target: unknown
  readonly ancestors: readonly unknown[]
  readonly descendants: readonly unknown[]
  readonly complete?: boolean
  readonly unresolvedParentId?: string
}): Context {
  return {
    sessionQuery: {
      traceSession: async () => ({
        target: parts.target,
        ancestors: parts.ancestors,
        descendants: parts.descendants,
        ...(parts.complete === false
          ? { complete: false, unresolvedParentId: parts.unresolvedParentId ?? 'sess-unknown' }
          : { complete: true, root: parts.ancestors.at(-1) ?? parts.target }),
      }),
      readTitleSnapshots: async (ids: readonly string[]) =>
        ids.map(id => ({ status: 'fulfilled', sessionId: id, value: { title: { title: `标题-${id}` } } })),
    },
  } as unknown as Context
}

describe('runTree', () => {
  it('indents the lineage and marks the live session', async () => {
    const ctx = traced({
      target: session('s1', { parent: 's0' }),
      ancestors: [session('s0')],
      descendants: [{ session: session('s2', { parent: 's1' }), descendants: [] }],
    })
    const { c, log } = makeCtx({ ctx })

    await runTree(c)

    const panel = log.panels[0]
    expect(panel?.title).toBe('会话家族树')
    // The stamp renders in the local zone, so only its shape is asserted — a
    // literal time here passes in UTC+8 and fails on a UTC runner.
    expect(panel?.lines[0]).toMatch(/^标题-s0 · \d+-\d+ \d{2}:\d{2} · work · s0$/)
    expect(panel?.lines[1]).toContain('* ')
    expect(panel?.lines[1]).toContain('标题-s1')
    // Two levels deep: the ancestor sits at depth 0, the live session at 1.
    expect(panel?.lines[2]).toMatch(/^ {4}标题-s2/)
  })

  it('admits the chain leaves the visible corpus', async () => {
    const ctx = traced({
      target: session('s1', { parent: 's0' }),
      ancestors: [session('s0')],
      descendants: [],
      complete: false,
      unresolvedParentId: 'sess-missing',
    })
    const { c, log } = makeCtx({ ctx })

    await runTree(c)

    expect(log.panels[0]?.lines[0]).toContain('sess-missing')
  })

  it('reports a failed lineage read instead of an empty tree', async () => {
    const ctx = {
      sessionQuery: { traceSession: async () => { throw new Error('no corpus') } },
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })

    await runTree(c)

    expect(log.notices[0]).toContain('no corpus')
    expect(log.panels).toEqual([])
  })

  it('says when the lineage is longer than it rendered', async () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      session: session(`s${index}`, { parent: 's1' }),
      descendants: [],
    }))
    const ctx = traced({ target: session('s1'), ancestors: [], descendants: many })
    const { c, log } = makeCtx({ ctx })

    await runTree(c)

    expect(log.panels[0]?.lines.join('\n')).toContain('只显示前 40 个')
  })
})

describe('runTrace', () => {
  it('reports an empty session rather than an empty panel', () => {
    const { c, log } = makeCtx()

    runTrace(c)

    expect(log.notices[0]).toContain('还没有任何事件')
  })

  it('folds the message-embedded stream into a per-message chunk count', () => {
    const events = [
      sessionEvent('turn/start', { turn: 1 }, 0),
      sessionEvent('assistant/message', {
        turn: 1, step: 1,
        message: { content: [{ type: 'text', text: 'a' }] },
        stream: [
          { type: 'text-chunks', time0: 1000, index: 0, dt: [10, 10], texts: ['a', 'b'] },
          { type: 'reasoning-chunks', time0: 900, index: 1, dt: [5], texts: ['c'] },
          { type: 'tool-call-chunks', time0: 1100, index: 2, dt: [10], id: 'c1', args: ['{}'] },
        ],
      }, 1),
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2),
    ]
    const { c, log } = makeCtx({}, { events })

    runTrace(c)

    const lines = log.panels[0]?.lines ?? []
    // Text + reasoning deltas count; tool-call deltas do not.
    expect(lines.some(line => line.includes('流式 3 块'))).toBe(true)
    expect(lines[0]).toContain('共 3 条记录')
  })

  it('labels the events a reader actually cares about', () => {
    const events = [
      sessionEvent('turn/start', { turn: 1 }, 0),
      sessionEvent('user/message', { turn: 1, content: [{ type: 'text', text: '读一下这个文件' }], source: { kind: 'user' } }, 1),
      sessionEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }, 2),
      sessionEvent('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [] } }, 3),
      sessionEvent('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [] }, error: { name: 'E', code: 'EACCES' } }, 4),
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ]
    const { c, log } = makeCtx({}, { events })

    runTrace(c)

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(body).toContain('轮次 1 开始')
    expect(body).toContain('用户：读一下这个文件')
    expect(body).toContain('工具调用 read（a.ts）')
    expect(body).toContain('工具结果 完成')
    expect(body).toContain('工具结果 失败 EACCES')
    expect(body).toContain('轮次 1 结束（completed）')
  })

  it('labels the extension events (inbox, tools, system, goal, plan, jobs, subagents)', () => {
    const events = [
      sessionEvent('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [{ id: 'm1' }, { id: 'm2' }] }, 0),
      sessionEvent('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 2, inserted: [], outcome: 'canceled' }, 1),
      sessionEvent('developer/message', { turn: 1, step: 1, message: { role: 'developer', content: [{ type: 'tool-addition', toolName: 'apply_patch' }, { type: 'tool-removal', toolName: 'run_tests' }] } }, 2),
      sessionEvent('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '你是 fx-tui' }] } }, 3),
      sessionEvent('model/selection', { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }, 4),
      sessionEvent('goal/change', { operation: 'create', goal: { objective: '把 CI 修绿' }, roundsStarted: 3 }, 5),
      sessionEvent('plan/mode', { active: true }, 6),
      sessionEvent('job/registered', { job: { id: 'bash-1a2b', kind: 'bash', label: 'pnpm build', status: 'running' } }, 7),
      sessionEvent('job/settled', { job: { id: 'bash-1a2b', kind: 'bash', label: 'pnpm build', status: 'completed', detail: 'exit code: 0' } }, 8),
      sessionEvent('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'spawn' }, 9),
    ]
    const { c, log } = makeCtx({}, { events })

    runTrace(c)

    const body = (log.panels[0]?.lines ?? []).join('\n')
    expect(body).toContain('队列变更 next-turn +2 −1')
    expect(body).toContain('队列变更 next-step −2（取消）')
    expect(body).toContain('工具目录 +apply_patch −run_tests')
    expect(body).toContain('系统提示词 9 字')
    expect(body).toContain('模型选择 deepseek-official/deepseek-v4-pro · effort high')
    expect(body).toContain('目标 create「把 CI 修绿」 · 3 轮')
    expect(body).toContain('计划模式 开启')
    expect(body).toContain('后台任务 bash-1a2b「pnpm build」 running')
    expect(body).toContain('后台任务 bash-1a2b「pnpm build」 completed（exit code: 0）')
    expect(body).toContain('子代理 one-shot · spawn')
  })

  it('windows the tail and says how much it dropped', () => {
    const events = Array.from({ length: 80 }, (_, seq) => sessionEvent('todo/write', { todos: [] }, seq))
    const { c, log } = makeCtx({}, { events })

    runTrace(c)

    const lines = log.panels[0]?.lines ?? []
    expect(lines[0]).toContain('共 80 条记录，显示最后 60 条')
    expect(lines.at(-1)).toContain('#79')
  })
})
