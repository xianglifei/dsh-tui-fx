/** /export: dump the current session log as a Markdown file in the cwd. */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { blocksToTextOf, toolResultCallIdOf, toolResultTextOf } from '../store.js'
import type { CommandCtx } from './types.js'

export async function exportSession(c: CommandCtx): Promise<void> {
  const agent = c.agent()
  const lines: string[] = [
    `# fx-tui 会话导出 · ${agent.id}`,
    '',
    `- 模型：${c.modelLabel()}`,
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '---',
    '',
  ]
  const pendingNames = new Map<string, string>()
  /** Last non-empty system prompt and how many times it changed. */
  let system: { text: string; seq: number | undefined; at: number | undefined } | null = null
  let systemCount = 0
  const toolChanges: { seq: number | undefined; added: string[]; removed: string[] }[] = []
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'tool/call') {
      try {
        const parsed = JSON.parse(event.data.arguments) as Record<string, unknown>
        const summary = typeof parsed.command === 'string' ? parsed.command
          : typeof parsed.path === 'string' ? parsed.path : ''
        pendingNames.set(event.data.callId, `${event.data.name}${summary !== '' ? `（${summary}）` : ''}`)
      } catch {
        pendingNames.set(event.data.callId, event.data.name)
      }
    } else if (event.type === 'tool/result') {
      const callId = toolResultCallIdOf(event.data.message)
      const name = callId !== undefined ? pendingNames.get(callId) : undefined
      if (callId !== undefined) pendingNames.delete(callId)
      lines.push(`> 🔧 **工具** ${name ?? '(unknown)'}：${toolResultTextOf(event.data.message, undefined).split('\n')[0] ?? ''}`, '')
    } else if (event.type === 'user/message') {
      if (event.data.source.kind === 'user') {
        lines.push(`## 👤 用户`, '', blocksToTextOf(event.data.content), '')
      }
    } else if (event.type === 'assistant/message') {
      const text = blocksToTextOf(event.data.message.content)
      if (text !== '') lines.push(`## 🤖 助手`, '', text, '')
    } else if (event.type === 'system/message') {
      const text = blocksToTextOf(event.data.message.content)
      if (text !== '') {
        systemCount += 1
        system = { text, seq: event.seq, at: event.time }
      }
    } else if (event.type === 'developer/message') {
      const added: string[] = []
      const removed: string[] = []
      for (const block of event.data.message.content) {
        if (block.type === 'tool-addition') added.push(block.toolName)
        else if (block.type === 'tool-removal') removed.push(block.toolName)
      }
      if (added.length > 0 || removed.length > 0) toolChanges.push({ seq: event.seq, added, removed })
    }
  }
  // The model-visible surface is not transcript, but leaving it out makes the
  // export unable to explain what the model was asked to do. Both appendices
  // are opt-in by presence: a session without the events gains no empty section.
  if (system !== null) {
    const stamp = system.at !== undefined ? ` · ${new Date(system.at).toLocaleString('zh-CN')}` : ''
    const seq = system.seq !== undefined ? ` · seq #${system.seq}` : ''
    lines.push('## 附录 · 系统提示词快照', '')
    if (systemCount > 1) lines.push(`本会话内系统提示词共 ${systemCount} 次变更，以下为最后一版。`, '')
    lines.push(`<details><summary>最后一版${seq}${stamp}</summary>`, '', '```text', system.text, '```', '', '</details>', '')
  }
  if (toolChanges.length > 0) {
    lines.push('## 附录 · 工具目录变更', '')
    for (const change of toolChanges) {
      const names = [...change.added.map(name => `+${name}`), ...change.removed.map(name => `−${name}`)]
      lines.push(`- ${change.seq !== undefined ? `#${change.seq} · ` : ''}${names.join(' ')}`)
    }
    lines.push('')
  }
  const file = resolve(process.cwd(), `fx-tui-export-${agent.id.slice(0, 13)}.md`)
  try {
    writeFileSync(file, lines.join('\n'), { encoding: 'utf8' })
    c.store.addPanel('会话已导出', [file])
  } catch (error) {
    c.store.addNotice(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}
