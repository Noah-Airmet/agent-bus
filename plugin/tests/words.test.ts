import { describe, expect, test } from 'claude-code/testing'

import * as Words from '../hooks/words'
import type { BusTask } from '../types'

const task = (overrides: Partial<BusTask>): BusTask => ({
  id: 'w4-verify',
  state: 'done',
  to: 'codex',
  agent: 'codex',
  model: 'gpt-6-luna',
  effort: 'high',
  mode: 'read-only',
  cwd: '/work',
  prompt: 'p',
  origin: 'session-1',
  queued_at: null,
  started_at: 1_000,
  finished_at: 1_724,
  elapsed_s: 724,
  exit_code: 0,
  cancelled: false,
  tokens: null,
  result: '/bus/done/w4-verify.md',
  log: null,
  note: null,
  worktree: null,
  ...overrides,
})

describe('words', () => {
  test('lanes are named as the routing doc names them', () => {
    expect(Words.laneOf(task({}))).toBe('luna')
    expect(Words.laneOf(task({ model: 'gpt-6.1-sol' }))).toBe('sol')
    expect(Words.laneOf(task({ agent: 'claude', model: 'claude-sonnet-5-5' }))).toBe('sonnet')
    expect(Words.laneOf(task({ agent: 'antigravity', model: null }))).toBe('agy')
    expect(Words.laneOf(task({ agent: 'cursor', model: null }))).toBe('cursor')
  })

  test('spans read in their largest whole unit', () => {
    expect([45, 724, 7_300, 200_000].map(Words.spanOf)).toEqual(['45s', '12m', '2h', '2d'])
    expect(Words.longSpanOf(724)).toBe('12m 4s')
    expect(Words.longSpanOf(4_400)).toBe('1h 13m')
  })

  test('the note tells the model what finished and where the result is', () => {
    expect(Words.finishedNoteOf(task({}))).toBe(
      '[agent-bus] Task `w4-verify` that this session dispatched finished ' +
        '(codex, gpt-6-luna, 12m 4s).\nResult: /bus/done/w4-verify.md',
    )

    const failed = Words.finishedNoteOf(
      task({ state: 'failed', note: 'Task timed out.\nmore' }),
    )

    expect(failed).toContain('failed (codex')
    expect(failed).toContain('Dispatcher note: Task timed out.')
    expect(failed).not.toContain('more')
  })

  test('the status line names the running lanes and is empty while idle', () => {
    const snapshot = (tasks: BusTask[]) => ({
      now: 2_000,
      counts: { queued: 0, running: 0, done: 0, failed: 0 },
      tasks,
      error: null,
    })

    expect(Words.statusTextOf(snapshot([task({})]))).toBeUndefined()

    expect(
      Words.statusTextOf(
        snapshot([
          task({ state: 'running' }),
          task({ id: 'b', state: 'running', model: 'gpt-6.1-sol' }),
          task({ id: 'c', state: 'queued' }),
        ]),
      ),
    ).toBe('bus · 2 running (luna, sol) · 1 queued')
  })

  test('an ask is cut by whole lines to the room left', () => {
    const body = Array.from({ length: 50 }, (_, n) => `line ${n}`).join('\n')
    const whole = Words.askTextOf(task({}), body, 10_000)

    expect(whole).toContain('line 49')

    const cut = Words.askTextOf(task({}), body, 250)

    expect(cut).toContain('line 0')
    expect(cut).not.toContain('line 49')
    expect(cut).toContain('result cut to fit')
    expect(cut!.length).toBeLessThanOrEqual(250)
    expect(Words.askTextOf(task({}), body, 20)).toBeUndefined()
  })
})
