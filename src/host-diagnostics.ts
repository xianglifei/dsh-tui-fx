/**
 * Host diagnostics: the stderr side channel dsh plugins use when the hosting
 * profile mounts no exporter for `ctx.logger` — the shipped case is the
 * DeepSeek model-listing notice (`[llm-deepseek-api-key] model listing …`).
 *
 * A TUI owns its screen. Before Ink mounts such a line lands above the banner;
 * once Ink is live it forces `writeToStderr` to erase the frame, write to the
 * real stderr and repaint, leaving the row stranded in the scrollback. So lines
 * whose `[tag]` belongs to a known host plugin are captured into a small ring
 * buffer that `/doctor` reads, while every other byte still reaches stderr
 * untouched — genuine crashes, stack traces and child output keep their channel.
 *
 * Limits, kept deliberate: `console.error(tag, message)` writes one whole line
 * per call, which is what this filter matches; a line split across writes falls
 * through rather than delaying real output. `FX_TUI_STDERR_RAW=1` leaves stderr
 * alone entirely.
 */

/** One captured diagnostic; identical neighbours collapse into one entry. */
export interface HostDiagnostic {
  readonly at: number
  readonly tag: string
  readonly text: string
  /** Occurrences collapsed into this entry (≥ 1). */
  readonly count: number
}

/** Plugin tags whose owners write straight to stderr. Add one per new offender. */
export const HOST_DIAGNOSTIC_TAGS: readonly string[] = ['llm-deepseek-api-key', 'llm-deepseek-account']

/** Ring capacity: a long session refreshes its model listing every 10 minutes. */
const DEFAULT_LIMIT = 200

/** `[tag] message` — the shape `console.error(tag, message)` produces. */
const TAG_LINE = /^\[([a-z][a-z0-9-]*)\] (.*)$/

/** The writer contract: process.stderr satisfies it; tests pass a capture. */
export interface StderrTarget {
  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean
}

export interface HostDiagnosticsOptions {
  readonly tags?: readonly string[]
  readonly limit?: number
  /** Clock injection for tests. */
  readonly now?: () => number
}

export class HostDiagnostics {
  readonly #tags: Set<string>
  readonly #limit: number
  readonly #now: () => number
  #entries: HostDiagnostic[] = []
  #restore: (() => void) | undefined

  constructor(options: HostDiagnosticsOptions = {}) {
    this.#tags = new Set(options.tags ?? HOST_DIAGNOSTIC_TAGS)
    this.#limit = options.limit ?? DEFAULT_LIMIT
    this.#now = options.now ?? Date.now
  }

  /**
   * Absorb tagged lines from `stream`; every other line passes through as-is.
   * @returns false when `FX_TUI_STDERR_RAW=1` left the stream alone.
   */
  install(stream: StderrTarget = process.stderr): boolean {
    if (this.#restore !== undefined) return true
    if (process.env.FX_TUI_STDERR_RAW === '1') return false
    const original = stream.write.bind(stream)
    const write = (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const done = typeof encoding === 'function' ? encoding : callback
      const text = typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8')
      const lines = text.split('\n')
      const kept: string[] = []
      for (const line of lines) {
        const match = TAG_LINE.exec(line)
        const tag = match?.[1]
        if (tag !== undefined && this.#tags.has(tag)) this.#capture(tag, match?.[2] ?? '')
        else kept.push(line)
      }
      // Nothing matched: hand the original chunk over untouched, bytes and all.
      if (kept.length === lines.length) return original(chunk, done)
      const rest = kept.join('\n')
      if (rest !== '') return original(rest, done)
      // A swallowed write still owes its caller the write callback.
      if (done !== undefined) process.nextTick(done)
      return true
    }
    stream.write = write
    this.#restore = () => {
      stream.write = original
    }
    return true
  }

  /** Restore the original writer; already-captured entries stay readable. */
  dispose(): void {
    this.#restore?.()
    this.#restore = undefined
  }

  /** Captured entries, oldest first. */
  entries(): readonly HostDiagnostic[] {
    return this.#entries
  }

  /** Total captured lines, repeats included. */
  total(): number {
    return this.#entries.reduce((sum, entry) => sum + entry.count, 0)
  }

  #capture(tag: string, text: string): void {
    const last = this.#entries[this.#entries.length - 1]
    if (last !== undefined && last.tag === tag && last.text === text) {
      this.#entries[this.#entries.length - 1] = { ...last, at: this.#now(), count: last.count + 1 }
      return
    }
    this.#entries.push({ at: this.#now(), tag, text, count: 1 })
    if (this.#entries.length > this.#limit) this.#entries.shift()
  }
}
