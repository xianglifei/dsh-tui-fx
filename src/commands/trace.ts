/** Read-only session introspection: /tree draws the lineage the fork commands
 * build, /trace dumps the event log the transcript is rendered from.
 *
 * Both are panels rather than pickers: /sessions already owns "go somewhere",
 * so these only answer "where am I" and "what happened".
 */

import { basename } from 'node:path'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode, SessionRecord } from '@deepseek-ai/dsh-session-query'
import { blocksToTextOf } from '../store.js'
import { truncateLine } from '../ui/estimate.js'
import type { CommandCtx } from './types.js'

/** Nodes /tree renders before it stops and says the rest exist. */
const TREE_LIMIT = 40
/** /trace windows from the end: the tail is what the user just lived through. */
const TRACE_WINDOW = 60

export async function runTree(c: CommandCtx): Promise<void> {
  const current = c.agent().session.id
  let trace
  try {
    trace = await c.ctx.sessionQuery.traceSession(current)
  } catch (error) {
    c.store.addNotice(`读取会话血缘失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }

  // `ancestors` runs from the immediate parent outward, so reversing it puts
  // the oldest known ancestor at depth 0.
  const chain = [...trace.ancestors].toReversed()
  const rows: { depth: number; record: SessionRecord }[] = []
  let total = 0
  const push = (depth: number, record: SessionRecord): void => {
    total += 1
    if (rows.length < TREE_LIMIT) rows.push({ depth, record })
  }
  const walk = (node: SessionLineageNode, depth: number): void => {
    push(depth, node.session)
    for (const child of node.descendants) walk(child, depth + 1)
  }
  chain.forEach((record, depth) => push(depth, record))
  push(chain.length, trace.target)
  for (const child of trace.descendants) walk(child, chain.length + 1)

  const titleById = new Map<string, string>()
  try {
    const observations = await c.ctx.sessionQuery.readTitleSnapshots(rows.map(row => row.record.header.id))
    for (const observation of observations) {
      if (observation.status === 'fulfilled' && observation.value.title !== undefined) {
        titleById.set(observation.sessionId, observation.value.title.title)
      }
    }
  } catch { /* titles are display-optional */ }

  const lines: string[] = []
  for (const row of rows) {
    const header = row.record.header
    const title = titleById.get(header.id)
    const dir = header.cwd !== undefined ? basename(header.cwd) : '?'
    const mark = header.id === current ? '* ' : ''
    lines.push(`${'  '.repeat(row.depth)}${mark}${title !== undefined ? truncateLine(title, 24) : '(无标题)'} · ${stampOf(header.createdAt)} · ${dir} · ${header.id.slice(0, 21)}`)
  }
  if (!trace.complete) lines.unshift(`… 更早的祖先不在可见范围内（${trace.unresolvedParentId}）`)
  if (total > rows.length) lines.push(`…（血缘共 ${total} 个会话，只显示前 ${rows.length} 个）`)
  lines.push('', '* 当前会话 · /sessions 可切换 · /fork /clear /rewind 会产生分支')
  c.store.addPanel('会话家族树', lines)
}

export function runTrace(c: CommandCtx): void {
  const events = c.agent().session.snapshotEvents()
  if (events.length === 0) {
    c.store.addNotice('当前会话还没有任何事件')
    return
  }
  const lines = traceLines(events)
  const shown = lines.slice(-TRACE_WINDOW)
  const header = lines.length > shown.length
    ? `共 ${lines.length} 条记录，显示最后 ${shown.length} 条`
    : `共 ${lines.length} 条记录`
  c.store.addPanel('会话事件轨迹', [header, '', ...shown])
}

function traceLines(events: readonly SessionEvent[]): string[] {
  const lines: string[] = []
  const origin = events[0]?.time ?? 0
  for (const event of events) {
    lines.push(`${prefix(event.seq, event.time - origin)}${labelOf(event)}`)
  }
  return lines
}

/** Text + reasoning deltas packed in one settled assistant stream; tool-call
 * deltas are excluded — they announce a tool card, not visible output. */
function streamChunkCount(stream: readonly AssistantStreamRecord[]): number {
  let count = 0
  for (const record of stream) {
    if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') count += record.texts.length
  }
  return count
}

function prefix(seq: number, delta: number): string {
  return `#${seq} · +${elapsed(delta)} · `
}

function elapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

function labelOf(event: SessionEvent): string {
  const known = labelOfKnown(event)
  return known !== '' ? known : labelOfExtension(event.type, event.data)
}

/** Core event vocabulary this build compiles against. */
function labelOfKnown(event: SessionEvent): string {
  switch (event.type) {
    case 'turn/start':
      return `轮次 ${event.data.turn} 开始`
    case 'turn/end':
      return `轮次 ${event.data.turn} 结束（${event.data.reason.kind}）`
    case 'step/start':
      return `步骤 ${event.data.step} 开始`
    case 'step/end':
      return `步骤 ${event.data.step} 结束`
    case 'user/message':
      return `用户：${preview(blocksToTextOf(event.data.content))}`
    case 'assistant/message': {
      // Streaming deltas are no longer log events (dsh 0.1.5 embeds the timed
      // model stream in the message itself), so surface the packed count.
      const streamed = streamChunkCount(event.data.stream)
      const label = `助手：${preview(blocksToTextOf(event.data.message.content))}`
      return streamed > 0 ? `${label} · 流式 ${streamed} 块` : label
    }
    case 'tool/call':
      return `工具调用 ${event.data.name}（${argumentSummary(event.data.arguments)}）`
    case 'tool/result':
      return `工具结果 ${event.data.error === undefined ? '完成' : `失败 ${event.data.error.code}`}`
    default:
      return ''
  }
}

/** Events contributed by packages fx-tui does not depend on at the type level
 * (inbox, goal, plan, jobs, subagent). They still arrive on the session log, so
 * the trace reads them by wire name and fields defensively: a label must never
 * throw because a plugin changed a payload shape. */
function labelOfExtension(type: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>
  switch (type) {
    case 'agent/inbox/spliced': {
      const target = d.target === 'next-step' ? 'next-step' : 'next-turn'
      const inserted = Array.isArray(d.inserted) ? d.inserted.length : 0
      const removed = typeof d.removedCount === 'number' ? d.removedCount : 0
      const counts = [inserted > 0 ? `+${inserted}` : '', removed > 0 ? `−${removed}` : ''].filter(part => part !== '')
      return `队列变更 ${target}${counts.length > 0 ? ` ${counts.join(' ')}` : ''}${d.outcome === 'canceled' ? '（取消）' : ''}`
    }
    case 'developer/message': {
      const message = d.message as { content?: readonly unknown[] } | undefined
      const names: string[] = []
      for (const block of message?.content ?? []) {
        const entry = block as { type?: string; toolName?: string }
        if (entry.type === 'tool-addition' && entry.toolName !== undefined) names.push(`+${entry.toolName}`)
        else if (entry.type === 'tool-removal' && entry.toolName !== undefined) names.push(`−${entry.toolName}`)
      }
      return names.length > 0 ? `工具目录 ${names.join(' ')}` : '开发者消息'
    }
    case 'system/message': {
      const message = d.message as { content?: readonly unknown[] } | undefined
      const text = (message?.content ?? [])
        .map(block => (block as { type?: string; text?: string }))
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text ?? '')
        .join('')
      return text === '' ? '系统提示词（空）' : `系统提示词 ${text.length} 字`
    }
    case 'model/selection': {
      const provider = typeof d.provider === 'string' ? d.provider : '?'
      const model = typeof d.model === 'string' ? d.model : '?'
      const effort = typeof d.reasoningEffort === 'string' ? ` · effort ${d.reasoningEffort}` : ''
      return `模型选择 ${provider}/${model}${effort}`
    }
    case 'goal/change': {
      const operation = typeof d.operation === 'string' ? d.operation : '?'
      const goal = d.goal as { objective?: unknown } | undefined
      const objective = typeof goal?.objective === 'string' ? `「${preview(goal.objective)}」` : ''
      const rounds = typeof d.roundsStarted === 'number' ? ` · ${d.roundsStarted} 轮` : ''
      return `目标 ${operation}${objective}${rounds}`
    }
    case 'plan/mode':
      return `计划模式 ${d.active === true ? '开启' : '关闭'}`
    case 'job/registered':
    case 'job/settled': {
      const job = d.job as { id?: unknown; kind?: unknown; label?: unknown; status?: unknown; detail?: unknown } | undefined
      const id = typeof job?.id === 'string' ? job.id : '?'
      const label = typeof job?.label === 'string' ? `「${preview(job.label)}」` : ''
      const status = typeof job?.status === 'string' ? ` ${job.status}` : ''
      const detail = typeof job?.detail === 'string' ? `（${preview(job.detail)}）` : ''
      return `后台任务 ${id}${label}${status}${detail}`
    }
    case 'subagent/descriptor': {
      const mode = typeof d.mode === 'string' ? d.mode : '?'
      const provider = typeof d.provider === 'string' ? d.provider : '?'
      return `子代理 ${mode} · ${provider}`
    }
    case 'subagent/catalog':
      return '子代理目录更新'
    default:
      return type
  }
}

/** The one argument worth reading, by the same heuristic /export uses. */
function argumentSummary(raw: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return preview(raw)
  }
  const summary = typeof parsed.command === 'string' ? parsed.command
    : typeof parsed.path === 'string' ? parsed.path
      : typeof parsed.pattern === 'string' ? parsed.pattern : ''
  return summary === '' ? '…' : preview(summary)
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat === '' ? '(空)' : truncateLine(flat, 60)
}

/** `M-D HH:mm` — the shape every session listing uses. */
function stampOf(time: number): string {
  const at = new Date(time)
  return `${at.getMonth() + 1}-${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
