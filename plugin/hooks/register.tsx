import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BusDetail, BusSnapshot } from '../types'
import { paneView, selectedOf } from './pane-view'
import type { PaneActions, Ui } from './pane-view'
import * as Words from './words'

const snapshotAtom = atom(
  { plugin: 'agent-bus', key: 'snapshot' } as const,
  null,
)
const selectedAtom = atom({ plugin: 'agent-bus', key: 'selected' } as const, null)
const detailAtom = atom({ plugin: 'agent-bus', key: 'detail' } as const, null)
const armedAtom = atom({ plugin: 'agent-bus', key: 'armed' } as const, null)

/**
 * How often the queue folders' modification times are compared: a task
 * queued, claimed or finished changes one, and only then is the bus asked.
 */
const WATCH_MS = 2_000

/**
 * While a task runs, how often the bus is asked anyway, so its time moves.
 */
const ACTIVE_REFRESH_MS = 15_000

const QUEUES = ['inbox', 'running', 'done', 'failed'] as const

type RunResult = { exitCode: number; stdout: string; stderr: string }

/**
 * The engine as the plugin's background work reaches it: each member one
 * call on the `$` that `session.start` was handed, bound there.
 */
type Host = {
  run: (argv: string[], timeoutMs: number) => Promise<RunResult>
  now: () => Promise<number>
  mtime: (path: string) => Promise<number>
  readFile: (path: string) => Promise<string | null>
  toast: (text: string) => void
  status: (text: string | undefined) => void
  note: (text: string) => Promise<void>
  getSelected: () => Promise<string | null>
  setSelected: (id: string) => Promise<unknown>
  getDetail: () => Promise<BusDetail | null>
  setDetail: (detail: BusDetail) => Promise<unknown>
  setSnapshot: (snapshot: BusSnapshot) => Promise<unknown>
  toggleArmed: (id: string) => Promise<unknown>
}

const firstLine = (text: string): string =>
  text.trim().split('\n')[0]?.slice(0, 200) ?? ''

export const register: Register = on => {
  let host: Host | null = null
  let home: string | undefined
  let busHome = ''
  let dispatch = 'agent-dispatch'
  let sessionId = ''

  let signature = ''
  let lastPollAt = 0
  let isPolling = false
  let latest: BusSnapshot | null = null
  let seenFinished: Set<string> | null = null
  let statusText: string | undefined
  let carrying: string | null = null

  const errorSnapshot = (error: string): BusSnapshot => ({
    now: Date.now() / 1000,
    counts: { queued: 0, running: 0, done: 0, failed: 0 },
    tasks: [],
    error,
  })

  /**
   * Toasts each task that finished since the last poll, unless another
   * session dispatched it; a task this session dispatched is also written
   * into the conversation, so the model knows where its result is.
   *
   * The first poll after a load only learns what had already finished.
   */
  async function announce(engine: Host, snapshot: BusSnapshot) {
    const finished = snapshot.tasks.filter(task => !Words.isActive(task))

    if (seenFinished === null) {
      seenFinished = new Set(finished.map(task => task.id))

      return
    }

    for (const task of finished) {
      if (seenFinished.has(task.id)) continue

      seenFinished.add(task.id)

      if (task.origin && task.origin !== sessionId) continue

      engine.toast(Words.toastOf(task))

      if (task.origin === sessionId) {
        await engine.note(Words.finishedNoteOf(task)).catch(() => undefined)
      }
    }
  }

  function syncStatus(engine: Host, snapshot: BusSnapshot) {
    const text = Words.statusTextOf(snapshot)

    if (text !== statusText) {
      statusText = text
      engine.status(text)
    }
  }

  /**
   * Reads the selected task's result into the detail once it has finished;
   * an active task's detail draws its prompt from the snapshot instead.
   */
  async function refreshDetail(engine: Host) {
    const task = selectedOf(latest, await engine.getSelected())
    const detail = await engine.getDetail()

    if (!task) return

    if (Words.isActive(task)) {
      if (detail?.id !== task.id || detail.text !== null) {
        await engine.setDetail({ id: task.id, text: null })
      }

      return
    }

    if (detail?.id === task.id && detail.text !== null) return

    const text = await engine.readFile(task.result)

    const shown =
      text === null
        ? null
        : Words.sanitize(
            text.length > Words.DETAIL_MAX_CHARS
              ? `${text.slice(0, Words.DETAIL_MAX_CHARS)}\n\n…`
              : text,
          )

    await engine.setDetail({ id: task.id, text: shown })
  }

  async function poll(engine: Host) {
    if (isPolling) return

    isPolling = true

    try {
      const run = await engine.run(
        [dispatch, 'status', '--json', '--recent', '20'],
        15_000,
      )

      const snapshot: BusSnapshot =
        run.exitCode === 0
          ? { ...JSON.parse(run.stdout), error: null }
          : errorSnapshot(
              `agent-dispatch status failed: ${firstLine(run.stderr)}`,
            )

      lastPollAt = await engine.now()
      latest = snapshot

      await announce(engine, snapshot)
      await engine.setSnapshot(snapshot)
      syncStatus(engine, snapshot)
      await refreshDetail(engine)
    } catch {
      latest = errorSnapshot(
        `Couldn't run ${Words.homeFolded(dispatch, home)}. ` +
          'Is the agent bus installed?',
      )

      await engine.setSnapshot(latest).catch(() => undefined)
    } finally {
      isPolling = false
    }
  }

  async function tick(engine: Host) {
    const stamps = await Promise.all(
      QUEUES.map(queue => engine.mtime(`${busHome}/${queue}`)),
    )

    const next = stamps.join(':')
    const hasActive = latest?.tasks.some(Words.isActive) ?? false
    const isDue = (await engine.now()) - lastPollAt >= ACTIVE_REFRESH_MS

    if (next !== signature || (hasActive && isDue)) {
      signature = next
      await poll(engine)
    }
  }

  function actionsOf(engine: Host): PaneActions {
    return {
      select: id => {
        void engine.setSelected(id).then(() => refreshDetail(engine))
      },
      cancel: id => {
        void (async () => {
          const run = await engine
            .run([dispatch, 'cancel', id], 30_000)
            .catch(() => null)

          engine.toast(
            run === null
              ? `Couldn't run agent-dispatch cancel ${id}`
              : firstLine(run.exitCode === 0 ? run.stdout : run.stderr),
          )

          await poll(engine)
        })()
      },
      toggleAsk: id => {
        void engine.toggleArmed(id)
      },
    }
  }

  on('session.start', async ($, e, next) => {
    home = await $.env.get('HOME')
    busHome = (await $.env.get('AGENT_BUS_HOME')) ?? `${home}/.agent-bus`
    sessionId = await $.session.id()

    const installed = `${home}/.local/bin/agent-dispatch`

    dispatch = (await $.fs.exists(installed)) ? installed : 'agent-dispatch'

    const engine: Host = {
      run: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
      now: () => $.clock.now(),
      mtime: path =>
        $.fs
          .stat(path)
          .then(stat => stat.mtimeMs)
          .catch(() => 0),
      readFile: path => $.fs.read(path).catch(() => null),
      toast: text => $.ui.toast(text, { timeoutMs: 6_000 }),
      status: text => $.ui.status(text),
      note: async text => {
        await $.session.append({
          message: { type: 'user', content: [{ type: 'text', text }] },
        })
      },
      getSelected: () => read($, selectedAtom),
      setSelected: id => update($, selectedAtom, () => id),
      getDetail: () => read($, detailAtom),
      setDetail: detail => update($, detailAtom, () => detail),
      setSnapshot: snapshot => update($, snapshotAtom, () => snapshot),
      toggleArmed: id =>
        update($, armedAtom, armed => (armed === id ? null : id)),
    }

    host = engine

    await $.command.register({
      name: Words.COMMAND_NAME,
      description: Words.COMMAND_DESCRIPTION,
    })

    const started = await next(e)

    void poll(engine)

    $.clock.every(WATCH_MS, () => {
      void tick(engine).catch(() => undefined)
    })

    if ((await $.store.get(Words.STORE_OPEN_KEY)) === true) {
      void $.ui.open({ id: Words.PANE_ID, title: Words.PANE_TITLE })
    }

    return started
  })

  on('command.run', { command: 'bus' }, async ($, e) => {
    const panes = await $.ui.panes().catch(() => [])

    if (panes.some(pane => pane.id === Words.PANE_ID)) {
      await $.ui.close({ id: Words.PANE_ID })
      await $.store.set(Words.STORE_OPEN_KEY, false)

      return { text: Words.PANEL_HIDDEN_TEXT }
    }

    const isInline = e.presentation.isFullscreen === false

    await $.ui.open(
      isInline
        ? {
            id: Words.PANE_ID,
            title: Words.PANE_TITLE,
            focus: true,
            closeOnEscape: true,
          }
        : { id: Words.PANE_ID, title: Words.PANE_TITLE },
    )

    if (host) void poll(host)

    if (isInline) return {}

    await $.store.set(Words.STORE_OPEN_KEY, true)

    return { text: Words.PANEL_SHOWN_TEXT }
  })

  on('ui.close', { id: 'bus' }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await $.store.set(Words.STORE_OPEN_KEY, false).catch(() => undefined)
    }

    return next(e)
  })

  on(
    'ui.render',
    { component: 'Pane', requestId: 'bus' },
    async ($, e, next) => {
      if (!host) return next(e)

      const { Box, Text, Button, Markdown } = (await $.ui.resolve(e)) as Ui
      const isDocked = e.props.placement === 'dock'

      const [snapshot, selected, detail, armed] = await Promise.all([
        read($, snapshotAtom),
        read($, selectedAtom),
        read($, detailAtom),
        read($, armedAtom),
      ])

      return paneView(
        {
          ui: { Box, Text, Button, Markdown },
          actions: actionsOf(host),
          columns: Math.max(1, e.props.bodyColumns - (isDocked ? 1 : 0)),
          home,
        },
        { snapshot, selected, detail, armed, isDocked },
      )
    },
  )

  on('prompt.submit', async ($, e, next) => {
    const armed = await read($, armedAtom)
    const task = latest?.tasks.find(one => one.id === armed)

    if (!armed || !task || carrying === armed) return next(e)

    const context = e.context ?? []

    const room =
      Words.PROMPT_CONTEXT_MAX_CHARS -
      context.reduce((sum, entry) => sum + entry.length, 0)

    const result = await $.fs.read(task.result).catch(() => null)
    const text = result === null ? undefined : Words.askTextOf(task, result, room)

    if (text === undefined) {
      await update($, armedAtom, () => null)
      $.ui.toast(`${task.id}'s result did not fit in the prompt`)

      return next(e)
    }

    carrying = armed

    try {
      const submitted = await next({ ...e, context: [...context, text] })

      if (submitted.drop === undefined) {
        await update($, armedAtom, current => (current === armed ? null : current))
      }

      return submitted
    } finally {
      carrying = null
    }
  })
}
