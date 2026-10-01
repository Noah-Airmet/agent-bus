import type { Args, On, RenderInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { BusTask } from '../types'

const SESSION_ID = 'session-1'
const NOW = 1_790_900_000

const taskOf = (overrides: Partial<BusTask>): BusTask => ({
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

const snapshotOf = (tasks: BusTask[]) =>
  JSON.stringify({
    version: 1,
    now: NOW,
    counts: { queued: 0, running: 1, done: 1, failed: 0 },
    tasks,
  })

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

/**
 * A session whose bus answers `status --json` from `tasks()`, whose queue
 * folders change when `stamp` moves, and which keeps what the plugin shows.
 */
function world(on: On, tasks: () => BusTask[]) {
  const runs: string[][] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const panes: { id: string; title: string; isActive: boolean }[] = []
  const state = { stamp: 1 }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  mock.env(on, { HOME: '/home/me' })
  mock.store(on, {})
  const clock = mock.clock(on, { now: 0 })

  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({
    value: { kind: 'directory', size: 0, mtimeMs: state.stamp, isLink: false },
  }))
  on('fs.read', ($, e) => ({ value: `# Result of ${e.path}\n\nAll good.` }))

  on('process.run', ($, e) => {
    runs.push([...e.argv])

    const isStatus = e.argv.includes('status')

    return {
      value: {
        exitCode: 0,
        stdout: isStatus ? snapshotOf(tasks()) : `cancelled: ${e.argv[2]}`,
        stderr: '',
      },
    }
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

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
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
    }
  })

  test('inline above the prompt it draws the rows without a detail', async ($, on) => {
    const bus = world(on, () => [RUNNING, FINISHED])

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await bus.clock.advance(100)

    const text = textOf(await $.ui.render(pane('terminal', 'inline')))

    expect(text).toContain('w4-verify')
    expect(text).not.toContain('Cancel')
  })

  test('the status line counts what runs and clears once idle', async ($, on) => {
    let tasks = [RUNNING]
    const bus = world(on, () => tasks)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
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

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
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

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await bus.clock.advance(100)

    tasks = [{ ...RUNNING, origin: 'session-2', state: 'done', finished_at: NOW }]
    bus.state.stamp += 1
    await bus.clock.advance(2_100)

    expect(bus.toasts).toEqual([])
  })

  test('/bus opens the pane, then closes it', async ($, on) => {
    const bus = world(on, () => [])

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    expect(await $.command.run(BUS)).toEqual({ text: 'Bus panel shown' })
    expect(bus.panes.map(one => one.id)).toEqual(['bus'])
    expect(await $.command.run(BUS)).toEqual({ text: 'Bus panel hidden' })
    expect(bus.panes).toEqual([])
  })

  test('an idle bus with no history says so', async ($, on) => {
    const bus = world(on, () => [])

    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await bus.clock.advance(100)

    expect(textOf(await $.ui.render(pane('desktop')))).toContain('No bus tasks yet.')
  })
})
