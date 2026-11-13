import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRestartArgs, meetsNodeFloor, runContext, runCost, runDoctor, runHelp, runInit, runLogs, runRestart, runStatus } from './info.js'
import { cleanupTempHomes, makeBusy, makeCtx, sessionEvent } from './test-helpers.js'

afterEach(cleanupTempHomes)

/** An agent whose session log holds the events a command wants to read. */
function agentWithEvents(events: readonly unknown[]): Agent {
  return {
    id: 'agent-1',
    session: { id: 's1', header: { cwd: '/tmp/work' }, snapshotEvents: () => events, deriveMessages: () => [] },
  } as unknown as Agent
}

describe('/help', () => {
  it('renders the key bindings and the command list', () => {
    const { c, log } = makeCtx()
    runHelp(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(log.panels[0]?.title).toContain('按键与命令')
    expect(body).toContain('Ctrl+O')
    expect(body).toContain('/config')
    expect(body).toContain('fx-tui-input-history.json')
  })
})

describe('/context', () => {
  it('reports the water level and admits the split is an estimate', async () => {
    const { c, log } = makeCtx({ agent: () => agentWithEvents([]) })
    await runContext(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(log.panels[0]?.title).toBe('已加载上下文')
    expect(body).toContain('上下文水位')
    expect(body).toContain('启发式估算')
    expect(body).toContain('尚无用量记录')
  })

  it('estimates the system prompt from the system-prompt service and the tools from the newest header', async () => {
    const ctx = {
      get: (key: string) => (key === 'systemPrompt'
        ? { assemble: async () => ({ sections: [{ name: 'persona', text: 'x'.repeat(300) }], contexts: [], tools: [] }) }
        : undefined),
    } as unknown as Context
    const events = [
      { type: 'request/header', data: { header: { tools: [{ name: 'bash' }] } } },
    ]
    const { c, log } = makeCtx({ ctx, agent: () => agentWithEvents(events) })
    await runContext(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(body).toContain('300 字符')
    expect(body).toContain('1 个')
  })

  it('prefers the token meter when the kernel offers one', async () => {
    const ctx = {
      get: (key: string) => (key === 'tokenMeter' ? { measure: () => ({ totalTokens: 4321 }) } : undefined),
    } as unknown as Context
    const { c, log } = makeCtx({ ctx, agent: () => agentWithEvents([]) })
    await runContext(c)

    expect(log.panels[0]?.lines[0]).toContain('4321')
  })
})

describe('/status', () => {
  it('summarises version, model, permissions and the plugin tree', async () => {
    const ctx = {
      registry: { forEach: (visit: (runtime: { name?: string }) => void) => {
        visit({ name: 'dsh-tools' })
        visit({ name: 'fx-tui' })
      } },
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })
    await runStatus(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(log.panels[0]?.title).toBe('运行状态')
    expect(body).toContain('fx-tui v')
    expect(body).toContain('权限模式')
    expect(body).toContain('已加载插件（2）')
  })

  it('survives a registry that refuses to be walked', async () => {
    const ctx = {
      registry: { forEach: () => { throw new Error('locked') } },
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })
    await runStatus(c)

    expect(log.panels[0]?.lines.join('\n')).toContain('已加载插件（0）')
  })
})

describe('/init', () => {
  const tempDirs: string[] = []
  const tempCwd = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-tui-init-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    vi.restoreAllMocks()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates a skeleton AGENTS.md in the working directory', () => {
    const dir = tempCwd()
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    const { c, log } = makeCtx()
    runInit(c)

    const target = join(dir, 'AGENTS.md')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('# AGENTS.md')
    expect(log.panels[0]?.lines[0]).toContain(target)
  })

  it('refuses to overwrite an existing AGENTS.md', () => {
    const dir = tempCwd()
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    writeFileSync(join(dir, 'AGENTS.md'), 'keep me', 'utf8')
    const { c, log } = makeCtx()
    runInit(c)

    expect(log.notices[0]).toContain('未改动')
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('keep me')
  })

  it('reports a write failure instead of pretending success', () => {
    const dir = tempCwd()
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    chmodSync(dir, 0o500)
    const { c, log } = makeCtx()
    try {
      runInit(c)

      expect(log.notices.some(notice => notice.startsWith('创建 AGENTS.md 失败'))).toBe(true)
      expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false)
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})

describe('/cost', () => {
  it('says so when the session has no completed calls', () => {
    const { c, log } = makeCtx()
    runCost(c)

    expect(log.notices[0]).toContain('还没有用量记录')
  })

  it('folds every assistant usage report into session totals and a cache rate', () => {
    const events = [
      sessionEvent('assistant/message', { turn: 0, step: 0, message: {}, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 100 } }, 0),
      sessionEvent('user/message', {}, 1),
      sessionEvent('assistant/message', { turn: 1, step: 0, message: {}, usage: { inputTokens: 30, outputTokens: 70 } }, 2),
      // A call the adapter reported no accounting for contributes nothing.
      sessionEvent('assistant/message', { turn: 2, step: 0, message: {} }, 3),
    ]
    const { c, log } = makeCtx({}, { events })
    runCost(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(log.panels[0]?.title).toContain('/cost')
    expect(body).toContain('完成调用：2 次')
    expect(body).toContain('未命中缓存 130')
    expect(body).toContain('输出合计：120')
    expect(body).toContain('缓存读 200')
    // Billed input = 130 + 200 + 100 = 430 → hit rate 200/430 = 46.5%.
    expect(body).toContain('46.5%')
  })
})

describe('/restart', () => {
  it('refuses while a turn is running', async () => {
    const { c, store, log } = makeCtx()
    makeBusy(store)
    await runRestart(c)

    expect(log.notices[0]).toContain('运行中')
    expect(log.restartCount).toBe(0)
  })

  it('hands off to the runner respawn when idle', async () => {
    const { c, log } = makeCtx()
    await runRestart(c)

    expect(log.restartCount).toBe(1)
    expect(log.notices[0]).toContain('重启')
  })
})

describe('/doctor', () => {
  it('reports a raw stderr channel when nothing was captured', async () => {
    const { c, log } = makeCtx()
    await runDoctor(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(log.panels[0]?.title).toContain('/doctor')
    expect(body).toContain('· 宿主诊断：未捕获（stderr 直通）')
  })

  it('tallies captured diagnostics and points at /logs instead of dumping lines', async () => {
    const at = Date.UTC(2026, 10, 13, 7, 18, 2)
    const { c, log } = makeCtx({
      hostDiagnostics: () => [
        { at, tag: 'llm-deepseek-api-key', text: 'model listing loaded 2 model(s), skipped 0 row(s)', count: 2 },
      ],
    })
    await runDoctor(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    const stamp = new Date(at).toTimeString().slice(0, 8)
    expect(body).toContain(`· 宿主诊断：2 条已收编 · 最近 ${stamp} · /logs 查看`)
    expect(body).not.toContain('[llm-deepseek-api-key]')
  })

  it('checks Node against the engines floor (24.9), not the old 22', async () => {
    const { c, log } = makeCtx()
    await runDoctor(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(body).toContain(`（要求 ≥24.9.0）`)
    expect(body).not.toContain('≥22.19')
  })
})

describe('meetsNodeFloor', () => {
  it('compares major and minor against 24.9', () => {
    expect(meetsNodeFloor('24.9.0')).toBe(true)
    expect(meetsNodeFloor('24.10.1')).toBe(true)
    expect(meetsNodeFloor('25.0.0')).toBe(true)
    expect(meetsNodeFloor('26.5.1')).toBe(true)
    expect(meetsNodeFloor('24.8.9')).toBe(false)
    expect(meetsNodeFloor('23.11.0')).toBe(false)
    expect(meetsNodeFloor('22.19.0')).toBe(false)
  })
})

describe('/logs', () => {
  it('says the channel is quiet when nothing was captured', () => {
    const { c, log } = makeCtx()
    runLogs(c)

    expect(log.panels).toEqual([])
    expect(log.notices[0]).toContain('宿主日志为空')
  })

  it('renders the ring newest-first with repeat counts and the total', () => {
    const old = Date.UTC(2026, 10, 13, 7, 18, 2)
    const recent = Date.UTC(2026, 10, 13, 7, 28, 2)
    const { c, log } = makeCtx({
      hostDiagnostics: () => [
        { at: old, tag: 'llm-deepseek-api-key', text: 'model listing loaded 2 model(s), skipped 0 row(s)', count: 1 },
        { at: recent, tag: 'llm-deepseek-account', text: 'model listing failed (offline); using the bundled catalog', count: 3 },
      ],
    })
    runLogs(c)

    expect(log.panels[0]?.title).toBe('宿主日志 · 4 条')
    const lines = log.panels[0]?.lines ?? []
    const failure = lines.findIndex(line => line.includes('[llm-deepseek-account]') && line.includes('×3'))
    const success = lines.findIndex(line => line.includes('[llm-deepseek-api-key]'))
    expect(failure).toBeGreaterThan(-1)
    // Newest first: the repeated failure sits above the older success line.
    expect(failure).toBeLessThan(success)
    expect(lines[0]).toContain('共 4 条（去重后 2 条）')
    expect(lines.join('\n')).toContain('FX_TUI_STDERR_RAW=1')
  })
})

describe('buildRestartArgs', () => {
  const hostArgv = ['/usr/local/bin/node', '/opt/dsh/lib/bin.js', '--profile', 'fx']

  it('defaults the profile to fx and lands on the live session id', () => {
    expect(buildRestartArgs(hostArgv, [], 's-live')).toEqual(['--profile', 'fx', '--resume', 's-live'])
  })

  it('keeps the profile the host was launched with plus other bundle args', () => {
    expect(buildRestartArgs([...hostArgv, '--profile', 'work'], ['--flag'], 's-live'))
      .toEqual(['--profile', 'work', '--flag', '--resume', 's-live'])
  })

  it('replaces a previous --resume (both spellings) with the live session', () => {
    expect(buildRestartArgs(hostArgv, ['--resume', 's-old', '--resume=s-older'], 's-live'))
      .toEqual(['--profile', 'fx', '--resume', 's-live'])
  })
})
