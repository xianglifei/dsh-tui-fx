/** `/agents`: the durable subagent roster, with live status where a child is
 * still resident. Lineage stays `/tree`; this answers "who is working now". */

import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent'
import { formatElapsed } from '../text.js'
import { truncateLine } from '../ui/estimate.js'
import type { CommandCtx } from './types.js'

const AGENTS_SHOWN = 12

export async function runAgents(c: CommandCtx, rest: string): Promise<void> {
  const subagents = c.ctx.get('subagents')
  if (subagents === undefined) {
    c.store.addNotice('当前组合没有子代理服务（dsh-base 提供 dsh-subagent）', 'warn')
    return
  }
  let children: readonly SubagentCatalogEntry[]
  try {
    children = await subagents.listChildren(c.agent().session.id)
  } catch (error) {
    c.store.addNotice(`读取子代理目录失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }
  if (children.length === 0) {
    c.store.addPanel('子代理', [
      '（本会话没有子代理）',
      '',
      '模型调用 subagent / subagent_fork 时，子会话会出现在这里；',
      '血缘用 /tree 看，进入某个可续会话用 /resume <id>。',
    ])
    return
  }

  const titles = await titlesOf(c, children.map(child => child.id))
  const query = rest.trim()
  if (query === '') {
    listRoster(c, children, titles)
    return
  }
  const matches = children.filter(child => child.id.startsWith(query))
  const [only] = matches
  if (matches.length === 0 || only === undefined) {
    c.store.addNotice(`没有匹配「${query}」的子代理 · /agents 看列表`, 'warn')
    return
  }
  if (matches.length > 1) {
    c.store.addPanel('子代理前缀不唯一', [
      `「${query}」匹配 ${matches.length} 个：`,
      '',
      ...matches.map(child => `${child.id} · ${labelOf(child)}`),
      '',
      '输入更长的前缀再试。',
    ])
    return
  }
  detail(c, only, titles)
}

function listRoster(
  c: CommandCtx,
  children: readonly SubagentCatalogEntry[],
  titles: ReadonlyMap<string, string>,
): void {
  const running = children.filter(child => statusOf(c, child.id) === 'running').length
  const lines = [`${children.length} 个子代理（${running} 个在运行）`, '']
  for (const child of children.slice(0, AGENTS_SHOWN)) {
    const mark = statusOf(c, child.id) === 'running' ? '* ' : '  '
    const status = statusOf(c, child.id) === 'running' ? `运行中 ${formatElapsed(Date.now() - child.createdAt)}` : '空闲'
    lines.push(truncateLine(`${mark}${child.id} · ${child.mode} · 「${titles.get(child.id) ?? labelOf(child)}」 · ${status}`, 160))
  }
  if (children.length > AGENTS_SHOWN) lines.push(`…（还有 ${children.length - AGENTS_SHOWN} 个）`)
  lines.push('', '/agents <id 前缀> 看详情 · /resume <id> 进入可续会话 · 血缘见 /tree')
  c.store.addPanel('子代理', lines)
}

function detail(
  c: CommandCtx,
  child: SubagentCatalogEntry,
  titles: ReadonlyMap<string, string>,
): void {
  const status = statusOf(c, child.id)
  const lines = [
    `id：${child.id}`,
    `标题：${titles.get(child.id) ?? '（无标题）'}`,
    `模式：${child.mode}${child.label !== undefined ? ` · 标签「${child.label}」` : ''}`,
    `状态：${status === 'running' ? '运行中' : status === 'idle' ? '空闲（可继续对话）' : '未加载'} · 创建于 ${new Date(child.createdAt).toLocaleString('zh-CN')}`,
  ]
  if (child.mode === 'continuable' || child.mode === 'external') {
    lines.push('', `要接着和它对话：/resume ${child.id}（会切换当前会话）`)
  } else {
    lines.push('', 'one-shot 子代理不能继续对话；它的结论在父会话的工具结果里。')
  }
  c.store.addPanel(`子代理 ${child.id}`, lines)
}

/** Live status when the child is resident; undefined once released. */
function statusOf(c: CommandCtx, id: SubagentCatalogEntry['id']): 'running' | 'idle' | undefined {
  return c.ctx.agents.get(id)?.status
}

function labelOf(child: SubagentCatalogEntry): string {
  return child.label ?? '（无标签）'
}

async function titlesOf(c: CommandCtx, ids: readonly SubagentCatalogEntry['id'][]): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>()
  try {
    const observations = await c.ctx.sessionQuery.readTitleSnapshots(ids)
    for (const observation of observations) {
      if (observation.status === 'fulfilled' && observation.value.title !== undefined) {
        titles.set(observation.sessionId, observation.value.title.title)
      }
    }
  } catch { /* titles are display-optional */ }
  return titles
}
