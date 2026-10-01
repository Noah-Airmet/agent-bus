import { describe, expect, test } from 'claude-code/testing'

import * as Words from '../hooks/words'
import type { BusTask } from '../types'

const task = (overrides: Partial<BusTask>): BusTask => ({
  host: 'local',
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
      hosts: [{ name: 'local', error: null }],
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

  test('a submit needs a lane, a folder and a prompt', () => {
    const form = { lane: 'luna', mode: 'read-only', cwd: '/work', prompt: '  go  ' }

    expect(Words.submitArgsOf(form, 'id')).toEqual([
      'submit', '--to', 'codex', '--model', 'gpt-6-luna', '--effort', 'high',
      '--mode', 'read-only', '--cwd', '/work', '--id', 'id', '--bg', 'go',
    ])
    expect(Words.submitArgsOf({ ...form, prompt: ' ' }, 'id')).toBeNull()
    expect(Words.submitArgsOf({ ...form, lane: 'opus' }, 'id')).toBeNull()
    expect(Words.taskIdOf('Fix the  hymn #12 tempo!', new Date(2026, 9, 1, 15, 4, 5))).toBe(
      '20261001-150405-fix-the-hymn-12-tempo',
    )
  })

  test('a remote note says which machine holds the result and how to read it', () => {
    expect(Words.finishedNoteOf(task({ host: 'imac' }))).toBe(
      '[agent-bus] Task `w4-verify` that this session dispatched finished ' +
        '(codex, gpt-6-luna, 12m 4s, on imac).\n' +
        "Result on imac: read it with `ssh imac '~/.local/bin/agent-dispatch result w4-verify'`",
    )
  })

  test('hosts are parsed in order, once, and only as ssh aliases', () => {
    expect(Words.hostsOf(undefined)).toEqual(['local'])
    expect(Words.hostsOf('')).toEqual(['local'])
    expect(Words.hostsOf('local, imac,mini imac')).toEqual(['local', 'imac', 'mini'])
    expect(Words.hostsOf('imac;, -oProxyCommand=x, $(id), mini')).toEqual(['mini'])
  })

  test('a word is quoted for a remote shell, quotes and dollars intact', () => {
    expect(Words.shellQuote("it's $HOME")).toBe("'it'\\''s $HOME'")
    expect(Words.remoteCommandOf(['result', 'a b'], "o'k")).toBe(
      "env AGENT_BUS_ORIGIN='o'\\''k' ~/.local/bin/agent-dispatch 'result' 'a b'",
    )
  })

  test('machines merge active first, then the newest finished, failing whole only when all fail', () => {
    const merged = Words.mergedSnapshotOf(
      [
        { host: 'local', status: { tasks: [task({ id: 'old', finished_at: 1 }), task({ id: 'run', state: 'running' })] }, error: null },
        { host: 'imac', status: { tasks: [task({ id: 'new', finished_at: 9 })] }, error: null },
        { host: 'mini', status: null, error: 'down' },
      ],
      10,
    )

    expect(merged.tasks.map(Words.taskKeyOf)).toEqual(['local/run', 'imac/new', 'local/old'])
    expect(merged.error).toBeNull()
    expect(merged.counts.running).toBe(1)

    const down = Words.mergedSnapshotOf([{ host: 'imac', status: null, error: 'down' }], 10)

    expect(down.error).toBe('down')
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
