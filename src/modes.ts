/**
 * Session-mode surfaces shared by the status bar and `/status`: plan mode, goal
 * progress, and the goal-continuation separator.
 *
 * Kept pure and separate from the store so the wording can be unit-tested and
 * both consumers stay identical — the status bar has room for three chips and
 * `/status` needs the same facts in one line.
 */

/** How automatic goal rounds appear in the transcript. */
export type GoalRoundsMode = 'timeline' | 'quiet'

/** Durable goal lifecycle (`dsh-goal`), mirrored here without a type import:
 * the package is not a runtime dependency of this bundle. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** The subset of a goal the chip renders. */
export interface GoalChipState {
  readonly phase: GoalPhase
  readonly roundsStarted: number
  readonly maxGoalRounds: number
  readonly objective: string
  readonly blockedMessage?: string
}

/** `📋 计划中` while plan mode is on; '' otherwise (no chip = no占位). */
export function planChip(active: boolean, narrow = false): string {
  if (!active) return ''
  return narrow ? '📋' : '📋 计划中'
}

/** Compact (narrow terminals) or full goal chip; '' when no goal is current. */
export function goalChip(goal: GoalChipState | null, narrow = false): string {
  if (goal === null) return ''
  const rounds = goal.maxGoalRounds > 0 ? `${goal.roundsStarted}/${goal.maxGoalRounds}` : `${goal.roundsStarted}`
  switch (goal.phase) {
    case 'paused':
      return narrow ? '◎ 暂停' : '◎ 目标 已暂停'
    case 'blocked':
      return narrow ? '◎ 受阻' : '◎ 目标 受阻'
    case 'complete':
      return narrow ? '◎ 完成' : '◎ 目标 已完成'
    default:
      return narrow ? `◎ ${rounds}` : `◎ 目标 ${rounds}`
  }
}

/** The one tone the goal chip may take: a blocked goal is the red case. */
export function goalChipTone(goal: GoalChipState | null): 'danger' | 'warning' | undefined {
  if (goal === null) return undefined
  if (goal.phase === 'blocked') return 'danger'
  if (goal.phase === 'paused') return 'warning'
  return undefined
}

/** Separator inserted before each automatic goal round's output. */
export function goalSeparator(round: number, maxRounds: number | null): string {
  const safeRound = Number.isFinite(round) && round > 0 ? Math.floor(round) : 1
  const cap = maxRounds !== null && maxRounds > 0 ? `（上限 ${maxRounds}）` : ''
  return `── 目标续行 · 第 ${safeRound} 轮${cap} ──`
}

export interface ModesSummaryInput {
  readonly planActive: boolean
  readonly goal: GoalChipState | null
  readonly jobs: number
  readonly childAgents: number
}

/** `/status` one-liner: the chips plus the counts, empty parts omitted. */
export function modesSummary(input: ModesSummaryInput): string {
  const parts: string[] = []
  if (input.planActive) parts.push('计划中')
  if (input.goal !== null) {
    const rounds = input.goal.maxGoalRounds > 0 ? `${input.goal.roundsStarted}/${input.goal.maxGoalRounds}` : `${input.goal.roundsStarted}`
    const suffix = input.goal.phase === 'active' ? ` ${rounds}`
      : input.goal.phase === 'paused' ? ' 已暂停'
        : input.goal.phase === 'blocked' ? ' 受阻'
          : ' 已完成'
    parts.push(`目标${suffix}`)
  }
  if (input.jobs > 0) parts.push(`任务 ⚙${input.jobs}`)
  if (input.childAgents > 0) parts.push(`子代理 🌱${input.childAgents}`)
  return parts.length > 0 ? `模式：${parts.join(' · ')}` : ''
}
