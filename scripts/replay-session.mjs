#!/usr/bin/env node
/**
 * Replay one session-log fixture through the built TuiStore and print (or
 * rewrite) the expected snapshot.
 *
 *   pnpm build
 *   node scripts/replay-session.mjs test/fixtures/session-logs/basic-turn.jsonl
 *   node scripts/replay-session.mjs test/fixtures/session-logs/basic-turn.jsonl --update
 *
 * `--update` is for a deliberate rendering change: run it, then read the diff
 * and explain it in the commit. A snapshot never updates itself in CI.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseFixture, replaySession } from '../lib/testing/replay.js'

const [input, flag] = process.argv.slice(2)
if (input === undefined) {
  console.error('usage: node scripts/replay-session.mjs <fixture.jsonl> [--update]')
  process.exit(2)
}
if (flag !== undefined && flag !== '--update') {
  console.error(`unknown option: ${flag}`)
  process.exit(2)
}

const text = readFileSync(input, 'utf8')
const snapshot = replaySession(parseFixture(text))
const rendered = `${JSON.stringify(snapshot, null, 2)}\n`

if (flag === '--update') {
  const target = input.replace(/\.jsonl$/, '') + '.expected.json'
  writeFileSync(target, rendered, 'utf8')
  console.log(`updated ${basename(target)}`)
} else {
  process.stdout.write(rendered)
}
