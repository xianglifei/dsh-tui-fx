import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportSession } from './export.js'
import { cleanupTempHomes, makeCtx } from './test-helpers.js'

let dir: string
let restoreCwd: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fx-tui-export-'))
  restoreCwd = process.cwd()
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(restoreCwd)
  rmSync(dir, { recursive: true, force: true })
  cleanupTempHomes()
})

function agentWithEvents(events: readonly unknown[]): Agent {
  return {
    id: 'session-abcdefghijklmnop',
    session: { id: 'session-abcdefghijklmnop', header: { cwd: dir }, snapshotEvents: () => events, deriveMessages: () => [] },
  } as unknown as Agent
}

const USER = (text: string): unknown => ({
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

const ASSISTANT = (text: string): unknown => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
})

const TOOL_CALL = (callId: string, args: string): unknown => ({
  type: 'tool/call',
  data: { callId, name: 'bash', arguments: args },
})

const TOOL_RESULT = (callId: string, text: string): unknown => ({
  type: 'tool/result',
  data: {
    message: {
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text }],
    },
  },
})

const SYSTEM = (text: string, seq: number): unknown => ({
  type: 'system/message',
  seq,
  time: 1000 + seq,
  data: { message: { role: 'system', content: [{ type: 'text', text }] } },
})

const DEVELOPER = (blocks: readonly unknown[], seq: number): unknown => ({
  type: 'developer/message',
  seq,
  time: 1000 + seq,
  data: { message: { role: 'developer', content: blocks } },
})

describe('/export', () => {
  it('writes a markdown timeline next to the working directory', async () => {
    const { c, log } = makeCtx({ agent: () => agentWithEvents([USER('你好'), ASSISTANT('收到')]) })
    await exportSession(c)

    const file = log.panels[0]?.lines[0] ?? ''
    expect(log.panels[0]?.title).toBe('会话已导出')
    // tmpdir reports /var on macOS while process.cwd() resolves to /private/var.
    expect(file.startsWith(realpathSync(dir))).toBe(true)

    const body = readFileSync(file, 'utf8')
    expect(body).toContain('# fx-tui 会话导出')
    expect(body).toContain('你好')
    expect(body).toContain('收到')
  })

  it('names the tool by its command or path, falling back to the tool name', async () => {
    const events = [
      TOOL_CALL('c1', JSON.stringify({ command: 'ls -la' })),
      TOOL_RESULT('c1', 'total 0'),
      TOOL_CALL('c2', JSON.stringify({ path: '/tmp/a.txt' })),
      TOOL_RESULT('c2', 'ok'),
      TOOL_CALL('c3', 'not json'),
      TOOL_RESULT('c3', 'ok'),
    ]
    const { c, log } = makeCtx({ agent: () => agentWithEvents(events) })
    await exportSession(c)

    const body = readFileSync(log.panels[0]?.lines[0] ?? '', 'utf8')
    expect(body).toContain('bash（ls -la）')
    expect(body).toContain('bash（/tmp/a.txt）')
    expect(body).toContain('bash')
  })

  it('appends the system prompt and the tool-catalog changes', async () => {
    const events = [
      SYSTEM('你是 fx-tui。', 0),
      DEVELOPER([{ type: 'tool-addition', toolName: 'apply_patch' }], 1),
      USER('你好'),
      DEVELOPER([{ type: 'tool-removal', toolName: 'run_tests' }], 2),
      ASSISTANT('收到'),
    ]
    const { c, log } = makeCtx({ agent: () => agentWithEvents(events) })
    await exportSession(c)

    const body = readFileSync(log.panels[0]?.lines[0] ?? '', 'utf8')
    expect(body).toContain('## 附录 · 系统提示词快照')
    expect(body).toContain('你是 fx-tui。')
    expect(body).toContain('## 附录 · 工具目录变更')
    expect(body).toContain('+apply_patch')
    expect(body).toContain('−run_tests')
    // The transcript still leads: appendices come after the timeline.
    expect(body.indexOf('## 👤 用户')).toBeLessThan(body.indexOf('## 附录 · 系统提示词快照'))
  })

  it('omits both appendices when the session logged neither', async () => {
    const { c, log } = makeCtx({ agent: () => agentWithEvents([USER('你好'), ASSISTANT('收到')]) })
    await exportSession(c)

    const body = readFileSync(log.panels[0]?.lines[0] ?? '', 'utf8')
    expect(body).not.toContain('附录')
  })

  it('reports a write failure instead of throwing', async () => {
    // A read-only cwd fails the relative write; permissions are restored so
    // afterEach can remove it.
    const readOnly = mkdtempSync(join(tmpdir(), 'fx-tui-ro-'))
    const real = realpathSync(readOnly)
    process.chdir(real)
    chmodSync(real, 0o500)

    try {
      const { c, log } = makeCtx({ agent: () => agentWithEvents([USER('x')]) })
      await exportSession(c)
      expect(log.notices[0]).toContain('导出失败')
    } finally {
      chmodSync(real, 0o700)
    }
  })
})
