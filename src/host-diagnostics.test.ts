import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostDiagnostics } from './host-diagnostics.js'

interface Capture {
  readonly chunks: string[]
  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean
}

function makeStderr(): Capture {
  const chunks: string[] = []
  return {
    chunks,
    write(chunk, callback) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      callback?.()
      return true
    },
  }
}

function makeSink(options: { limit?: number; tags?: readonly string[] } = {}): HostDiagnostics {
  let clock = 0
  return new HostDiagnostics({ ...options, now: () => (clock += 1000) })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('HostDiagnostics', () => {
  it('swallows a tagged line and keeps its tag, text and count', () => {
    const sink = makeSink()
    const stderr = makeStderr()
    expect(sink.install(stderr)).toBe(true)

    stderr.write('[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)\n')

    expect(stderr.chunks).toEqual([])
    expect(sink.total()).toBe(1)
    expect(sink.entries()).toMatchObject([
      { tag: 'llm-deepseek-api-key', text: 'model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)', count: 1 },
    ])
    expect(sink.entries()[0]?.at).toBeGreaterThan(0)
    sink.dispose()
  })

  it('passes unrelated writes through byte-for-byte, stack traces included', () => {
    const sink = makeSink()
    const stderr = makeStderr()
    sink.install(stderr)

    const crash = 'fx-tui: boom\n    at main (/repo/lib/index.js:1:1)\n'
    stderr.write(crash)

    expect(stderr.chunks.join('')).toBe(crash)
    expect(sink.entries()).toEqual([])
    sink.dispose()
  })

  it('keeps the untagged half of a mixed write', () => {
    const sink = makeSink()
    const stderr = makeStderr()
    sink.install(stderr)

    stderr.write('[llm-deepseek-account] model listing failed (offline); using the bundled catalog\na real warning\n')

    expect(stderr.chunks.join('')).toBe('a real warning\n')
    expect(sink.total()).toBe(1)
    sink.dispose()
  })

  it('collapses identical neighbours instead of growing the ring', () => {
    const sink = makeSink()
    const stderr = makeStderr()
    sink.install(stderr)

    const line = '[llm-deepseek-api-key] model listing loaded 2 model(s), skipped 0 row(s)\n'
    stderr.write(line)
    stderr.write(line)

    expect(sink.total()).toBe(2)
    expect(sink.entries()).toMatchObject([{ count: 2 }])
    sink.dispose()
  })

  it('drops the oldest entry past the ring limit', () => {
    const sink = makeSink({ limit: 2 })
    const stderr = makeStderr()
    sink.install(stderr)

    stderr.write('[llm-deepseek-api-key] one\n')
    stderr.write('[llm-deepseek-api-key] two\n')
    stderr.write('[llm-deepseek-api-key] three\n')

    expect(sink.entries().map(entry => entry.text)).toEqual(['two', 'three'])
    expect(sink.total()).toBe(2)
    sink.dispose()
  })

  it('restores the original writer on dispose', () => {
    const sink = makeSink()
    const stderr = makeStderr()
    sink.install(stderr)
    sink.dispose()

    stderr.write('[llm-deepseek-api-key] loaded 2 model(s)\n')

    expect(stderr.chunks.join('')).toBe('[llm-deepseek-api-key] loaded 2 model(s)\n')
    expect(sink.entries()).toEqual([])
  })

  it('leaves stderr raw under FX_TUI_STDERR_RAW=1', () => {
    vi.stubEnv('FX_TUI_STDERR_RAW', '1')
    const sink = makeSink()
    const stderr = makeStderr()
    expect(sink.install(stderr)).toBe(false)

    stderr.write('[llm-deepseek-api-key] loaded 2 model(s)\n')

    expect(stderr.chunks.join('')).toBe('[llm-deepseek-api-key] loaded 2 model(s)\n')
    expect(sink.entries()).toEqual([])
  })

  it('still calls the write callback when it swallows the whole chunk', async () => {
    const sink = makeSink()
    const stderr = makeStderr()
    sink.install(stderr)
    const done = vi.fn<(error?: Error | null) => void>()

    stderr.write('[llm-deepseek-api-key] loaded 2 model(s)\n', done)
    await new Promise(resolve => setImmediate(resolve))

    expect(done).toHaveBeenCalledTimes(1)
    sink.dispose()
  })
})
