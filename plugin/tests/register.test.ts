import type { Args, On, RenderInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { BusTask } from '../types'

const SESSION_ID = 'session-1'
const NOW = 1_790_900_000

const taskOf = (overrides: Partial<BusTask>): BusTask => ({
  host: 'local',
  id: 'task',
  state: 'done',
  to: 'codex',
  agent: 'codex',
  model: 'gpt-6-luna',
  effort: 'high',
  mode: 'read-only',
  cwd: '/home/me/development/pulpit-vault',
  prompt: 'Verify the w4 batch.',
  origin: null,
  queued_at: null,
  started_at: NOW - 720,
  finished_at: null,
  elapsed_s: null,
  exit_code: null,
  cancelled: false,
  tokens: null,
  result: '/home/me/.agent-bus/done/task.md',
  log: null,
  note: null,
  worktree: null,
  ...overrides,
})

const RUNNING = taskOf({ id: 'w4-verify', state: 'running', origin: SESSION_ID })

const FINISHED = taskOf({
  id: 'tlac-spike',
  state: 'done',
  model: 'gpt-6.1-sol',
  started_at: NOW - 7_300,
  finished_at: NOW - 7_200,
  elapsed_s: 100,
  tokens: 64_596,
  result: '/home/me/.agent-bus/done/tlac-spike.md',
})

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

const pane = (
  surface: 'terminal' | 'desktop',
  placement: 'dock' | 'inline' = 'dock',
): RenderInput<'Pane'> => ({
  component: 'Pane',
  surface,
  requestId: 'bus',
  viewport: { columns: 160, rows: 40 },
  props: {
    title: 'Bus',
    isFocused: false,
    bodyColumns: 56,
    placement,
    scroll: { offset: 0, bodyRows: 36 },
    view: {},
  },
})

const BUS: Args<'command.run'> = {
  command: 'bus',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
}

type Run = { machine: string; argv: string[]; env?: Record<string, string> }

/**
 * A session whose buses answer from `tasks(machine)`: this machine's
 * `agent-dispatch` directly, another's as `ssh <alias> '<command>'`, and a
 * machine in `unreachable` not at all. This machine's queue folders change
 * when `stamp` moves. Keeps every run and what the plugin shows.
 */
function world(
  on: On,
  tasks: (machine: string) => BusTask[],
  unreachable: string[] = [],
) {
  const runs: Run[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const panes: { id: string; title: string; isActive: boolean }[] = []
  const state = { stamp: 1 }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  mock.env(on, { HOME: '/home/me' })
  mock.store(on, {})
  const clock = mock.clock(on, { now: NOW * 1000 })

  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({
    value: { kind: 'directory', size: 0, mtimeMs: state.stamp, isLink: false },
  }))

  on('process.run', ($, e) => {
    const isSsh = e.argv[0] === 'ssh'
    const machine = isSsh ? (e.argv.at(-2) ?? '') : 'local'
    const line = isSsh ? (e.argv.at(-1) ?? '') : e.argv.slice(1).join(' ')

    runs.push({ machine, argv: [...e.argv], env: e.init?.env })

    if (unreachable.includes(machine)) {
      return {
        value: {
          exitCode: 255,
          stdout: '',
          stderr: `ssh: connect to host ${machine}: timed out`,
        },
      }
    }

    const stdout = /\bstatus\b/.test(line)
      ? JSON.stringify({ version: 1, now: NOW, tasks: tasks(machine) })
      : /\bresult\b/.test(line)
        ? `# Result from ${machine}\n\nAll good.`
        : 'ok'

    return { value: { exitCode: 0, stdout, stderr: '' } }
  })

  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    panes.push({ id: e.id, title: e.title ?? e.id, isActive: true })

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    panes.splice(panes.findIndex(one => one.id === e.id), 1)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes] }))

  return { runs, toasts, statuses, panes, clock, state }
}

const textOf = (tree: unknown): string => JSON.stringify(tree)

describe('register', () => {
  test('the pane lists active then recent tasks and details the active one', async ($, on) => {
    const bus = world(on, () => [RUNNING, FINISHED])

    await $.session.start(START)
    await bus.clock.advance(100)

    for (const surface of ['terminal', 'desktop'] as const) {
      const text = textOf(await $.ui.render(pane(surface)))

      expect(text).toContain('1 running')
      expect(text).toContain('w4-verify')
      expect(text).toContain('luna · 12m')
      expect(text).toContain('Recent')
      expect(text).toContain('sol · 2h ago')
      expect(text).toContain('Cancel')
      expect(text).toContain('Verify the w4 batch.')
      expect(text).toContain('~/development/pulpit-vault')
      expect(text, 'one machine: no machine tag').not.toContain('local ·')
    }
  })

  test('inline above the prompt it draws the rows without a detail', async ($, on) => {
    const bus = world(on, () => [RUNNING, FINISHED])

    await $.session.start(START)
    await bus.clock.advance(100)

    const text = textOf(await $.ui.render(pane('terminal', 'inline')))

    expect(text).toContain('w4-verify')
    expect(text).not.toContain('Cancel')
  })

  test('the status line counts what runs and clears once idle', async ($, on) => {
    let tasks = [RUNNING]
    const bus = world(on, () => tasks)

    await $.session.start(START)
    await bus.clock.advance(100)

    expect(bus.statuses.at(-1)).toBe('bus · 1 running (luna)')

    tasks = [{ ...RUNNING, state: 'done', finished_at: NOW, elapsed_s: 720 }]
    bus.state.stamp += 1
    await bus.clock.advance(2_100)

    expect(bus.statuses.at(-1)).toBeUndefined()
  })

  // The kit answers no session.append beneath a plugin in this release, so
  // the note the model reads is covered by words.test.ts and in a session.
  test('a task this session dispatched toasts when it finishes', async ($, on) => {
    let tasks = [RUNNING, FINISHED]
    const bus = world(on, () => tasks)

    await $.session.start(START)
    await bus.clock.advance(100)

    expect(bus.toasts, 'what had finished before is not news').toEqual([])

    tasks = [
      { ...RUNNING, state: 'done', finished_at: NOW, elapsed_s: 724 },
      FINISHED,
    ]
    bus.state.stamp += 1
    await bus.clock.advance(2_100)

    expect(bus.toasts).toEqual(['✓ w4-verify done · luna · 12m'])
  })

  test("another session's task finishing stays out of this one", async ($, on) => {
    let tasks = [{ ...RUNNING, origin: 'session-2' }]
    const bus = world(on, () => tasks)

    await $.session.start(START)
    await bus.clock.advance(100)

    tasks = [{ ...RUNNING, origin: 'session-2', state: 'done', finished_at: NOW }]
    bus.state.stamp += 1
    await bus.clock.advance(2_100)

    expect(bus.toasts).toEqual([])
  })

  test('/bus opens the pane, then closes it', async ($, on) => {
    const bus = world(on, () => [])

    await $.session.start(START)

    expect(await $.command.run(BUS)).toEqual({ text: 'Bus panel shown' })
    expect(bus.panes.map(one => one.id)).toEqual(['bus'])
    expect(await $.command.run(BUS)).toEqual({ text: 'Bus panel hidden' })
    expect(bus.panes).toEqual([])
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a new task from the ${surface} pane dispatches in the lane picked, under this session`, async ($, on) => {
      const bus = world(on, () => [FINISHED])

      await $.session.start({ ...START, surface, cwd: '/home/me/development/hymns' })
      await bus.clock.advance(100)

      const ui = await $.ui.mount({
        plugin: 'agent-bus',
        surface,
        component: 'Pane',
        props: pane(surface).props,
        requestId: 'bus',
      })

      await ui.press({ key: 'compose' })
      await ui.select({ key: 'lane', value: 'sol' })
      await ui.select({ key: 'mode', value: 'write' })
      await ui.input({ key: 'prompt', text: 'Add a tempo slider', kind: 'change' })
      await ui.input({ key: 'prompt', text: 'Add a tempo slider' })
      await bus.clock.advance(100)

      const submit = bus.runs.find(run => run.argv.includes('submit'))

      expect(submit?.argv.slice(1)).toEqual([
        'submit',
        '--to',
        'codex',
        '--model',
        'gpt-6.1-sol',
        '--effort',
        'medium',
        '--mode',
        'write',
        '--cwd',
        '/home/me/development/hymns',
        '--scope',
        'files under /home/me/development/hymns only',
        '--id',
        expect.stringMatching(/^\d{8}-\d{6}-add-a-tempo-slider$/),
        '--bg',
        'Add a tempo slider',
      ])
      expect(submit?.env).toEqual({ AGENT_BUS_ORIGIN: SESSION_ID })
      expect(bus.toasts.at(-1)).toMatch(/^Dispatched \d{8}-\d{6}-add-a-tempo-slider to sol$/)

      await ui.unmount()
    })
  }

  test('an idle bus with no history says so', async ($, on) => {
    const bus = world(on, () => [])

    await $.session.start({ ...START, surface: 'desktop' })
    await bus.clock.advance(100)

    expect(textOf(await $.ui.render(pane('desktop')))).toContain('No bus tasks yet.')
  })

  test('a machine without a bus says so', async ($, on) => {
    const bus = world(on, () => [], ['local'])

    await $.session.start(START)
    await bus.clock.advance(100)

    expect(textOf(await $.ui.render(pane('desktop')))).toContain(
      "Couldn't run ~/.local/bin/agent-dispatch. Is the agent bus installed?",
    )
  })
})

describe('another machine', () => {
  test('hosts: imac reads the iMac over ssh, never this machine', { options: { hosts: 'imac' } }, async ($, on) => {
    const bus = world(on, machine => (machine === 'imac' ? [RUNNING, FINISHED] : []))

    await $.session.start(START)
    await bus.clock.advance(100)

    expect(bus.runs.every(run => run.machine === 'imac')).toBe(true)

    const status = bus.runs[0]?.argv ?? []

    expect(status.slice(0, 2)).toEqual(['ssh', '-o'])
    expect(status).toContain('BatchMode=yes')
    expect(status.at(-2)).toBe('imac')
    expect(status.at(-1)).toBe(
      "~/.local/bin/agent-dispatch 'status' '--json' '--recent' '20'",
    )

    const text = textOf(await $.ui.render(pane('desktop')))

    expect(text).toContain('w4-verify')
    expect(text, 'the detail says where it runs').toContain(
      'imac · /home/me/development/pulpit-vault',
    )
    expect(text, 'one machine: rows untagged').not.toContain('imac · luna')
  })

  test('it asks a remote bus every five seconds, with no folder to watch', { options: { hosts: 'imac' } }, async ($, on) => {
    const bus = world(on, () => [])

    await $.session.start(START)
    await bus.clock.advance(100)

    const asked = () =>
      bus.runs.filter(run => run.argv.at(-1)?.includes("'status'")).length

    expect(asked()).toBe(1)

    await bus.clock.advance(4_000)

    expect(asked()).toBe(1)

    await bus.clock.advance(2_100)

    expect(asked()).toBe(2)
  })

  test('a finished result is read from the machine that ran it', { options: { hosts: 'imac' } }, async ($, on) => {
    const bus = world(on, () => [FINISHED])

    await $.session.start(START)
    await bus.clock.advance(100)

    expect(
      bus.runs.some(
        run =>
          run.argv.at(-1) === "~/.local/bin/agent-dispatch 'result' 'tlac-spike'",
      ),
    ).toBe(true)
    expect(textOf(await $.ui.render(pane('desktop')))).toContain(
      '# Result from imac',
    )
  })

  test('several machines merge into one tagged list, and an unreachable one says so', { options: { hosts: 'local, imac, mini' } }, async ($, on) => {
    const bus = world(
      on,
      machine =>
        machine === 'imac'
          ? [{ ...RUNNING, id: 'hermes-digest' }]
          : [RUNNING, FINISHED],
      ['mini'],
    )

    await $.session.start(START)
    await bus.clock.advance(100)

    const text = textOf(await $.ui.render(pane('terminal')))

    expect(text).toContain('2 running')
    expect(text).toContain('local · luna · 12m')
    expect(text).toContain('imac · luna · 12m')
    expect(text).toContain("Couldn't reach mini")
  })

  test('a new task picks its machine and dispatches there over ssh under this session', { options: { hosts: 'local, imac' } }, async ($, on) => {
    const bus = world(on, () => [])

    await $.session.start(START)
    await bus.clock.advance(100)

    const ui = await $.ui.mount({
      plugin: 'agent-bus',
      surface: 'desktop',
      component: 'Pane',
      props: pane('desktop').props,
      requestId: 'bus',
    })

    await ui.press({ key: 'compose' })
    await ui.select({ key: 'host', value: 'imac' })
    await bus.clock.advance(100)
    await ui.input({ key: 'cwd', text: '~/development/hymns' })
    await ui.input({ key: 'prompt', text: "Fix the singer's $PART bug" })
    await bus.clock.advance(100)

    const submit = bus.runs.find(run => run.argv.at(-1)?.includes("'submit'"))

    expect(submit?.machine).toBe('imac')
    expect(submit?.argv.at(-1)).toMatch(
      new RegExp(
        "^env AGENT_BUS_ORIGIN='session-1' ~/.local/bin/agent-dispatch 'submit' '--to' 'codex' " +
          "'--model' 'gpt-6-luna' '--effort' 'high' '--mode' 'read-only' '--cwd' '~/development/hymns' " +
          "'--id' '\\d{8}-\\d{6}-fix-the-singer-s-part-bug' '--bg' 'Fix the singer'\\\\''s \\$PART bug'$",
      ),
    )
    expect(bus.toasts.at(-1)).toMatch(/ to luna on imac$/)

    await ui.unmount()
  })
})
