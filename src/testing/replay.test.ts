import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseFixture, replaySession } from './replay.js'

const FIXTURES = new URL('../../test/fixtures/session-logs/', import.meta.url)

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8')

/** Every fixture ships with a committed snapshot; a new fixture without one
 * fails loudly instead of silently skipping coverage. */
const FIXTURES_WITH_SNAPSHOTS = ['basic-turn', 'new-events', 'interrupted-tools']

describe('session-log replay', () => {
  for (const name of FIXTURES_WITH_SNAPSHOTS) {
    it(`replays ${name} exactly as the committed snapshot`, () => {
      const actual = replaySession(parseFixture(fixture(`${name}.jsonl`)))
      const expected = JSON.parse(fixture(`${name}.expected.json`)) as unknown
      expect(actual).toEqual(expected)
    })
  }

  it('keeps a pending inbox visible after replay (the --resume tray)', () => {
    const snapshot = replaySession(parseFixture(fixture('new-events.jsonl')))
    expect(snapshot.queued.map(row => (row as { text: string }).text)).toEqual(['下一轮做 E2E', '换个方向'])
    expect(snapshot.queued.map(row => (row as { mode: string }).mode)).toEqual(['queue', 'steer'])
  })

  it('adopts the recorded model selection instead of the startup label', () => {
    const snapshot = replaySession(parseFixture(fixture('new-events.jsonl')), { model: 'stale/label' })
    expect(snapshot.model).toBe('deepseek-official/deepseek-v4-pro')
  })

  it('never throws on events this build does not know (plan/goal/job)', () => {
    expect(fixture('new-events.jsonl')).toContain('"plan/mode"')
    expect(() => replaySession(parseFixture(fixture('new-events.jsonl')))).not.toThrow()
  })

  it('converts a dangling tool call into a settled card', () => {
    const snapshot = replaySession(parseFixture(fixture('interrupted-tools.jsonl')))
    expect(snapshot.items.at(-1)).toMatchObject({ kind: 'tool', result: '(结果未记录)' })
  })

  it('names the offending line in a parse error', () => {
    expect(() => parseFixture('{"seq":0}\nnot json\n')).toThrow(/fixture line 2/)
  })
})
