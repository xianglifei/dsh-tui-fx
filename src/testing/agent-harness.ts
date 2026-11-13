/**
 * Real Agent/Session integration harness: mounts the actual dsh core plugins on
 * a private cordis Context, registers a scripted fake LLM adapter, and drives
 * full turns through the real agent loop.
 *
 * The point is the seam the replay fixtures cannot cover: that the events this
 * bundle renders are the events a running Agent actually emits. No network, no
 * credentials, no persistence — one turn costs a few milliseconds, so this can
 * run in CI.
 *
 * `dsh-llm-mock-server` upstream was not available in this dependency set; this
 * adapter is ~80 lines and needs no server process.
 */

import { Context } from '@deepseek-ai/cordis'
import AgentPlugin from '@deepseek-ai/dsh-agent'
import AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import LlmPlugin, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionPlugin, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ProjectionsPlugin from '@deepseek-ai/dsh-session-projection'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as TodoTool from '@deepseek-ai/dsh-tool-todo'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolsPlugin from '@deepseek-ai/dsh-tools'

/** One scripted model call. The adapter consumes them in order. */
export type ScriptStep =
  | {
    readonly text: string
    readonly reasoning?: string
    readonly usage?: TokenUsage
  }
  | {
    readonly tool: { readonly name: string; readonly args: unknown; readonly id?: string }
    readonly usage?: TokenUsage
  }
  | {
    readonly fail: { readonly code: string; readonly message: string }
  }

const DEFAULT_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 }

/** Scripted provider: every call replays the next step verbatim. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly steps: ScriptStep[]

  constructor(steps: readonly ScriptStep[]) {
    super()
    this.steps = [...steps]
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.steps.shift()
    if (step === undefined) {
      throw new Error('script exhausted: the Agent made more model calls than the script provides')
    }
    if ('fail' in step) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: step.fail.code, message: step.fail.message } } }
      return
    }
    if ('tool' in step) {
      const argumentsJson = JSON.stringify(step.tool.args)
      const id = (step.tool.id ?? 'call-1') as ToolCallId
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: step.tool.name, argumentsDelta: argumentsJson }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: step.tool.name, arguments: argumentsJson },
      }
      yield { type: 'usage', usage: step.usage ?? DEFAULT_USAGE }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    let index = 0
    if (step.reasoning !== undefined && step.reasoning !== '') {
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: step.reasoning }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: step.reasoning } }
      index += 1
    }
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text: step.text }
    yield { type: 'block-end', index, block: { type: 'text', text: step.text } }
    yield { type: 'usage', usage: step.usage ?? DEFAULT_USAGE }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export interface AgentHarness {
  readonly ctx: Context
  readonly handle: Awaited<ReturnType<Context['agents']['create']>>
  readonly events: readonly SessionEvent[]
  /** Every request the scripted model received, in call order. */
  readonly requests: readonly GenerateOptions[]
  /** Submit one user message and wait for the agent to settle. */
  send(text: string): Promise<void>
  /** Fold the captured log through the real store (view-level assertions). */
  dispose(): Promise<void>
}

let sessionCounter = 0

/** Build the harness. Callers are responsible for `dispose()`. */
export async function createAgentHarness(steps: readonly ScriptStep[]): Promise<AgentHarness> {
  const ctx = new Context()
  // The exact services a headless agent needs: sessions, projections, the LLM
  // registry, the prompt builder, the tool layer plus one executor, one real
  // tool, the agent registry, and the loop that drives it. Each fork resolves
  // when its own apply() settles; `agentLoop` is the last injection to turn on.
  const mounted = [
    ctx.plugin(SessionPlugin),
    ctx.plugin(ProjectionsPlugin),
    ctx.plugin(LlmPlugin),
    ctx.plugin(SystemPromptPlugin),
    ctx.plugin(ToolsPlugin),
    ctx.plugin(NativeExecutor),
    ctx.plugin(TodoTool, { allowParallelInProgress: false }),
    ctx.plugin(AgentPlugin),
    ctx.plugin(AgentLoopPlugin),
  ]
  await Promise.all(mounted)
  for (let attempt = 0; attempt < 50 && ctx.get('agentLoop') === undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (ctx.get('agentLoop') === undefined) throw new Error('agent harness: the loop never activated')

  const adapter = new ScriptedAdapter(steps)
  ctx.llm.registerAdapter(['fake'], adapter)
  const events: SessionEvent[] = []
  ctx.on('session/event', (_session, event) => { events.push(event) })

  sessionCounter += 1
  const handle = await ctx.agents.create({
    sessionId: SessionId(`session-harness-${sessionCounter}`),
    agentOptions: { provider: 'fake', model: 'fake-1' },
  })

  return {
    ctx,
    handle,
    events,
    requests: adapter.requests,
    async send(text: string): Promise<void> {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
    },
    async dispose(): Promise<void> {
      await handle.dispose()
    },
  }
}
