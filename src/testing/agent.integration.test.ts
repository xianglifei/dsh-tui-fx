/**
 * Integration layer: a real Agent and a real Session, driven through the real
 * loop by a scripted model. Unit tests pin one reducer case; replay pins one
 * log; this pins the seam in between — that a running Agent emits the events
 * this bundle renders, in the order and shape it renders them.
 */

import { describe, expect, it } from 'vitest'
import { TuiStore } from '../store.js'
import { createAgentHarness } from './agent-harness.js'
import type { ScriptStep } from './agent-harness.js'

const typesOf = (events: readonly { type: string }[]): string[] => events.map(event => event.type)

describe('Agent integration', () => {
  it('runs a text turn and emits the renderable event sequence', async () => {
    const harness = await createAgentHarness([{ text: '你好' }])
    try {
      await harness.send('打个招呼')

      const types = typesOf(harness.events)
      for (const expected of ['turn/start', 'step/start', 'system/message', 'user/message', 'request/header', 'assistant/message', 'step/end', 'turn/end']) {
        expect(types).toContain(expected)
      }
      const turnEnd = harness.events.find(event => event.type === 'turn/end')
      expect(turnEnd?.data).toMatchObject({ reason: { kind: 'completed' } })
      const assistant = harness.events.find(event => event.type === 'assistant/message')
      expect(JSON.stringify(assistant?.data)).toContain('你好')

      // The request really carried the configured route.
      const header = harness.events.find(event => event.type === 'request/header')
      expect(header?.data).toMatchObject({ header: { config: { model: 'fake-1' } } })
      expect(harness.requests).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  it('feeds the captured log into the store exactly like a resume would', async () => {
    const harness = await createAgentHarness([{ text: '记住了' }])
    try {
      await harness.send('这件事记一下')
      const store = new TuiStore('session-check', 'fake/fake-1')
      store.replay(harness.events)
      store.finishReplay()

      const items = store.getSnapshot().items
      expect(items.some(item => item.kind === 'user' && item.text === '这件事记一下')).toBe(true)
      expect(items.some(item => item.kind === 'assistant' && item.text === '记住了')).toBe(true)
      expect(store.getSnapshot().phase).toBe('idle')
    } finally {
      await harness.dispose()
    }
  })

  it('executes a real tool call and records a clean result', async () => {
    const steps: ScriptStep[] = [
      { tool: { name: 'todo_write', args: { todos: [{ content: '写测试', status: 'pending' }] } } },
      { text: '记下了' },
    ]
    const harness = await createAgentHarness(steps)
    try {
      await harness.send('加个待办')

      const call = harness.events.find(event => event.type === 'tool/call')
      expect(call?.data).toMatchObject({ name: 'todo_write' })
      const result = harness.events.find(event => event.type === 'tool/result')
      expect(result?.data).toMatchObject({ message: { toolCallId: 'call-1' } })
      const data = result?.data as { message?: { isError?: boolean } } | undefined
      expect(data?.message?.isError).not.toBe(true)
      expect(harness.requests).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })

  it('reports an unknown tool as a failed result instead of a silent success', async () => {
    const steps: ScriptStep[] = [{ tool: { name: 'no_such_tool', args: {} } }, { text: '没这个工具' }]
    const harness = await createAgentHarness(steps)
    try {
      await harness.send('调个不存在的工具')

      const result = harness.events.find(event => event.type === 'tool/result')
      const data = result?.data as { message?: { isError?: boolean } } | undefined
      expect(data?.message?.isError).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('records a model switch and routes the next request through it', async () => {
    const harness = await createAgentHarness([{ text: '一' }, { text: '二' }])
    try {
      await harness.send('第一轮')
      harness.handle.agent.model.select({ provider: 'fake', model: 'fake-2' })
      await harness.send('第二轮')

      expect(harness.events.some(event => event.type === 'model/selection')).toBe(true)
      const headers = harness.events.filter(event => event.type === 'request/header')
      expect(headers.at(-1)?.data).toMatchObject({ header: { config: { model: 'fake-2' } } })
    } finally {
      await harness.dispose()
    }
  })

  it('surfaces a provider failure as an error turn', async () => {
    const harness = await createAgentHarness([{ fail: { code: 'rate_limit', message: 'slow down' } }])
    try {
      await harness.send('失败一下')
      const turnEnd = harness.events.find(event => event.type === 'turn/end')
      expect(turnEnd?.data).toMatchObject({ reason: { kind: 'error' } })
    } finally {
      await harness.dispose()
    }
  })
})
