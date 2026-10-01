import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BusComposer, BusDetail, BusSnapshot, BusTask } from '../types'
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
const composerAtom = atom(
  { plugin: 'agent-bus', key: 'composer' } as const,
  null,
)

/**
 * How often this machine's queue folders' modification times are compared:
 * a task queued, claimed or finished changes one, and only then is the bus
 * asked.
 */
const WATCH_MS = 2_000

/**
 * How often another machine's bus is asked: no folder to watch over ssh.
 */
const REMOTE_POLL_MS = 5_000

/**
 * While a task runs, how often the bus is asked anyway, so its time moves.
 */
const ACTIVE_REFRESH_MS = 15_000

const QUEUES = ['inbox', 'running', 'done', 'failed'] as const

/**
 * The `$.store` key remembering the folder last dispatched to on a machine.
 */
const cwdKeyOf = (host: string): string => `cwd:${host}`

type RunResult = { exitCode: number; stdout: string; stderr: string }

/**
 * The engine as the plugin's background work reaches it: each member one
 * call on the `$` that `session.start` was handed, bound there.
 */
type Host = {
  run: (
    argv: string[],
    timeoutMs: number,
    env?: Record<string, string>,
  ) => Promise<RunResult>
  now: () => Promise<number>
  mtime: (path: string) => Promise<number>
  toast: (text: string) => void
  status: (text: string | undefined) => void
  note: (text: string) => Promise<void>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  getSelected: () => Promise<string | null>
  setSelected: (key: string) => Promise<unknown>
  getDetail: () => Promise<BusDetail | null>
  setDetail: (detail: BusDetail) => Promise<unknown>
  setSnapshot: (snapshot: BusSnapshot) => Promise<unknown>
  toggleArmed: (key: string) => Promise<unknown>
  getComposer: () => Promise<BusComposer | null>
  editComposer: (
    edit: (composer: BusComposer | null) => BusComposer | null,
  ) => Promise<unknown>
}

const firstLine = (text: string): string =>
  text.trim().split('\n')[0]?.slice(0, 200) ?? ''

export const register: Register = (on, options) => {
  const hosts = Words.hostsOf(options.hosts)
  const hasLocal = hosts.includes(Words.LOCAL)
  const hasRemote = hosts.some(machine => machine !== Words.LOCAL)

  let host: Host | null = null
  let home: string | undefined
  let busHome = ''
  let dispatch = 'agent-dispatch'
  let sessionId = ''
  let sessionCwd = ''

  let signature = ''
  let lastPollAt = 0
  let isPolling = false
  let latest: BusSnapshot | null = null
  let seenFinished: Set<string> | null = null
  let statusText: string | undefined
  let carrying: string | null = null

  /**
   * Runs agent-dispatch with these arguments on a machine: this one's
   * directly, another's over ssh; the origin, when given, rides in the
   * dispatcher's environment either way.
   */
  function bus(
    engine: Host,
    machine: string,
    args: string[],
    timeoutMs: number,
    origin?: string,
  ): Promise<RunResult> {
    if (machine === Words.LOCAL) {
      return engine.run(
        [dispatch, ...args],
        timeoutMs,
        origin ? { AGENT_BUS_ORIGIN: origin } : undefined,
      )
    }

    return engine.run(
      Words.sshArgvOf(machine, Words.remoteCommandOf(args, origin)),
      timeoutMs + 5_000,
    )
  }

  async function answerOf(
    engine: Host,
    machine: string,
  ): Promise<Words.HostAnswer> {
    const failure =
      machine === Words.LOCAL
        ? `Couldn't run ${Words.homeFolded(dispatch, home)}. Is the agent bus installed?`
        : `Couldn't reach the bus on ${machine}.`

    const run = await bus(
      engine,
      machine,
      ['status', '--json', '--recent', '20'],
      15_000,
    ).catch(() => null)

    if (run === null || run.exitCode !== 0) {
      const why = run === null ? '' : firstLine(run.stderr)

      return {
        host: machine,
        status: null,
        error: why ? `${failure} ${why}` : failure,
      }
    }

    try {
      return { host: machine, status: JSON.parse(run.stdout), error: null }
    } catch {
      return {
        host: machine,
        status: null,
        error: `${failure} It answered something other than JSON.`,
      }
    }
  }

  /**
   * A finished task's result text, asked of the machine that ran it.
   */
  async function resultOf(engine: Host, task: BusTask): Promise<string | null> {
    const run = await bus(engine, task.host, ['result', task.id], 15_000).catch(
      () => null,
    )

    return run !== null && run.exitCode === 0 ? run.stdout : null
  }

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
      seenFinished = new Set(finished.map(Words.taskKeyOf))

      return
    }

    for (const task of finished) {
      const key = Words.taskKeyOf(task)

      if (seenFinished.has(key)) continue

      seenFinished.add(key)

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

    const key = Words.taskKeyOf(task)

    if (Words.isActive(task)) {
      if (detail?.id !== key || detail.text !== null) {
        await engine.setDetail({ id: key, text: null })
      }

      return
    }

    if (detail?.id === key && detail.text !== null) return

    const text = await resultOf(engine, task)

    const shown =
      text === null
        ? null
        : Words.sanitize(
            text.length > Words.DETAIL_MAX_CHARS
              ? `${text.slice(0, Words.DETAIL_MAX_CHARS)}\n\n…`
              : text,
          )

    await engine.setDetail({ id: key, text: shown })
  }

  async function poll(engine: Host) {
    if (isPolling) return

    isPolling = true

    try {
      const answers = await Promise.all(
        hosts.map(machine => answerOf(engine, machine)),
      )

      lastPollAt = await engine.now()

      const snapshot = Words.mergedSnapshotOf(answers, lastPollAt / 1000)

      latest = snapshot

      await announce(engine, snapshot)
      await engine.setSnapshot(snapshot)
      syncStatus(engine, snapshot)
      await refreshDetail(engine)
    } finally {
      isPolling = false
    }
  }

  async function tick(engine: Host) {
    const now = await engine.now()

    const stamps = hasLocal
      ? await Promise.all(
          QUEUES.map(queue => engine.mtime(`${busHome}/${queue}`)),
        )
      : []

    const next = stamps.join(':')
    const hasActive = latest?.tasks.some(Words.isActive) ?? false

    const isDue =
      next !== signature ||
      (hasRemote && now - lastPollAt >= REMOTE_POLL_MS) ||
      (hasActive && now - lastPollAt >= ACTIVE_REFRESH_MS)

    if (isDue) {
      signature = next
      await poll(engine)
    }
  }

  /**
   * The folder a new task on this machine starts in: the one last
   * dispatched to there, else the session's here and the home elsewhere.
   */
  async function cwdFor(engine: Host, machine: string): Promise<string> {
    const kept = await engine.storeGet(cwdKeyOf(machine)).catch(() => null)

    if (typeof kept === 'string' && kept) return kept

    return machine === Words.LOCAL ? sessionCwd : '~'
  }

  function actionsOf(engine: Host): PaneActions {
    const taskOf = (key: string) =>
      latest?.tasks.find(task => Words.taskKeyOf(task) === key)

    return {
      select: key => {
        void engine.setSelected(key).then(() => refreshDetail(engine))
      },
      cancel: key => {
        const task = taskOf(key)

        if (!task) return

        void (async () => {
          const run = await bus(
            engine,
            task.host,
            ['cancel', task.id],
            30_000,
          ).catch(() => null)

          engine.toast(
            run === null
              ? `Couldn't run agent-dispatch cancel ${task.id}`
              : firstLine(run.exitCode === 0 ? run.stdout : run.stderr),
          )

          await poll(engine)
        })()
      },
      toggleAsk: key => {
        void engine.toggleArmed(key)
      },
      compose: () => {
        void (async () => {
          const current = await engine.getComposer()
          const machine = current?.host ?? hosts[0] ?? Words.LOCAL
          const cwd = current?.cwd ?? (await cwdFor(engine, machine))

          await engine.editComposer(composer => ({
            isOpen: true,
            host: machine,
            lane: composer?.lane ?? 'luna',
            mode: composer?.mode ?? 'read-only',
            cwd,
            prompt: composer?.prompt ?? '',
            isSending: false,
          }))
        })()
      },
      discard: () => {
        void engine.editComposer(
          composer => composer && { ...composer, isOpen: false, prompt: '' },
        )
      },
      setHost: machine => {
        void (async () => {
          const cwd = await cwdFor(engine, machine)

          await engine.editComposer(
            composer => composer && { ...composer, host: machine, cwd },
          )
        })()
      },
      setLane: lane => {
        void engine.editComposer(composer => composer && { ...composer, lane })
      },
      setMode: mode => {
        const next = mode === 'write' ? 'write' : 'read-only'

        void engine.editComposer(
          composer => composer && { ...composer, mode: next },
        )
      },
      setCwd: cwd => {
        void engine.editComposer(composer => {
          if (!composer) return composer

          const isHere = composer.host === Words.LOCAL

          const path =
            isHere && home && cwd.startsWith('~') ? home + cwd.slice(1) : cwd

          return { ...composer, cwd: path }
        })
      },
      setPrompt: prompt => {
        void engine.editComposer(composer => composer && { ...composer, prompt })
      },
      dispatch: prompt => {
        void submit(engine, prompt)
      },
    }
  }

  /**
   * Dispatches the form in the background on its machine, under this
   * session's origin so its finish reports here; then shows the new task,
   * remembers the folder, and clears the form.
   */
  async function submit(engine: Host, prompt: string) {
    const composer = await engine.getComposer()

    if (!composer || composer.isSending) return

    const id = Words.taskIdOf(prompt, new Date(await engine.now()))
    const args = Words.submitArgsOf({ ...composer, prompt }, id)

    if (!args) {
      engine.toast('Type a prompt and a folder first')

      return
    }

    await engine.editComposer(
      current => current && { ...current, prompt, isSending: true },
    )

    const run = await bus(engine, composer.host, args, 30_000, sessionId).catch(
      () => null,
    )

    if (run === null || run.exitCode !== 0) {
      engine.toast(
        run === null
          ? "Couldn't run agent-dispatch submit"
          : firstLine(run.stderr || run.stdout),
      )

      await engine.editComposer(
        current => current && { ...current, isSending: false },
      )

      return
    }

    const where = composer.host === Words.LOCAL ? '' : ` on ${composer.host}`

    engine.toast(`Dispatched ${id} to ${composer.lane}${where}`)

    await engine
      .storeSet(cwdKeyOf(composer.host), composer.cwd)
      .catch(() => undefined)

    await engine.editComposer(
      current =>
        current && { ...current, isOpen: false, prompt: '', isSending: false },
    )

    await engine.setSelected(Words.taskKeyOf({ host: composer.host, id }))
    await poll(engine)
  }

  on('session.start', async ($, e, next) => {
    home = await $.env.get('HOME')
    busHome = (await $.env.get('AGENT_BUS_HOME')) ?? `${home}/.agent-bus`
    sessionId = await $.session.id()
    sessionCwd = e.cwd

    const installed = `${home}/.local/bin/agent-dispatch`

    dispatch = (await $.fs.exists(installed)) ? installed : 'agent-dispatch'

    const engine: Host = {
      run: (argv, timeoutMs, env) => $.process.run(argv, { timeoutMs, env }),
      now: () => $.clock.now(),
      mtime: path =>
        $.fs
          .stat(path)
          .then(stat => stat.mtimeMs)
          .catch(() => 0),
      toast: text => $.ui.toast(text, { timeoutMs: 6_000 }),
      status: text => $.ui.status(text),
      note: async text => {
        await $.session.append({
          message: { type: 'user', content: [{ type: 'text', text }] },
        })
      },
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      getSelected: () => read($, selectedAtom),
      setSelected: key => update($, selectedAtom, () => key),
      getDetail: () => read($, detailAtom),
      setDetail: detail => update($, detailAtom, () => detail),
      setSnapshot: snapshot => update($, snapshotAtom, () => snapshot),
      toggleArmed: key =>
        update($, armedAtom, armed => (armed === key ? null : key)),
      getComposer: () => read($, composerAtom),
      editComposer: edit => update($, composerAtom, edit),
    }

    host = engine

    await $.command.register({
      name: Words.COMMAND_NAME,
      description: Words.COMMAND_DESCRIPTION,
    })

    const started = await next(e)

    void poll(engine).catch(() => undefined)

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

    if (host) void poll(host).catch(() => undefined)

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

      const { Box, Text, Button, Markdown, Input, Select } = (await $.ui.resolve(
        e,
      )) as Ui

      const isDocked = e.props.placement === 'dock'

      const [snapshot, selected, detail, armed, composer] = await Promise.all([
        read($, snapshotAtom),
        read($, selectedAtom),
        read($, detailAtom),
        read($, armedAtom),
        read($, composerAtom),
      ])

      return paneView(
        {
          ui: { Box, Text, Button, Markdown, Input, Select },
          actions: actionsOf(host),
          columns: Math.max(1, e.props.bodyColumns - (isDocked ? 1 : 0)),
          home,
          canCompose: e.surface !== 'mobile',
        },
        { snapshot, selected, detail, armed, composer, isDocked },
      )
    },
  )

  on('prompt.submit', async ($, e, next) => {
    const armed = await read($, armedAtom)
    const task = latest?.tasks.find(one => Words.taskKeyOf(one) === armed)

    if (!armed || !task || !host || carrying === armed) return next(e)

    const context = e.context ?? []

    const room =
      Words.PROMPT_CONTEXT_MAX_CHARS -
      context.reduce((sum, entry) => sum + entry.length, 0)

    const result = await resultOf(host, task)
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
