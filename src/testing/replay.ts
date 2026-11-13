/**
 * Session-log replay harness: fold a persisted log into the TuiStore and emit
 * a stable, comparable snapshot.
 *
 * This is the regression net for "an existing event path renders the same".
 * Unit tests pin individual events; a replay pins the *whole* transcript a real
 * log produces, which is what a resume actually shows. Fixtures live in
 * `test/fixtures/session-logs/` and carry only the envelope facts the view
 * reads, so the snapshot is byte-stable.
 *
 * `scripts/replay-session.mjs` exposes the same fold on the built output for
 * inspecting a log by hand (`--update` rewrites the expected snapshot).
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TuiStore } from '../store.js'

/** The comparable view: the transcript, the pending tray, and the session-level
 * labels that survive a resume. */
export interface ReplaySnapshot {
  readonly model: string
  readonly phase: string
  readonly items: readonly unknown[]
  readonly queued: readonly unknown[]
}

export interface ReplayOptions {
  /** Session id used for the store (display only). */
  readonly sessionId?: string
  /** Route label before the log's own `model/selection` events fold in. */
  readonly model?: string
}

/** Parse a JSONL fixture into session events. */
export function parseFixture(text: string): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line) as SessionEvent)
    } catch (error) {
      throw new Error(
        `fixture line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
  return events
}

/** Fold one log and return the normalized snapshot (JSON round-tripped, so
 * `undefined` fields disappear exactly as they do in a committed expectation). */
export function replaySession(events: readonly SessionEvent[], options: ReplayOptions = {}): ReplaySnapshot {
  const store = new TuiStore(options.sessionId ?? 'session-replay', options.model ?? 'deepseek-official/deepseek-flash')
  store.replay(events)
  store.finishReplay()
  const snapshot = store.getSnapshot()
  const view = {
    model: snapshot.model,
    phase: snapshot.phase,
    items: snapshot.items,
    queued: snapshot.queuedMessages,
  }
  return JSON.parse(JSON.stringify(view)) as ReplaySnapshot
}
