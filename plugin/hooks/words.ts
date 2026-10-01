import type { BusSnapshot, BusTask } from '../types'

/**
 * The pane's one id: its `requestId` at `ui.render`, and what `/bus` toggles.
 */
export const PANE_ID = 'bus'

/**
 * The pane's tab label while another pane is open too.
 */
export const PANE_TITLE = 'Bus'

export const COMMAND_NAME = 'bus'

export const COMMAND_DESCRIPTION =
  'Toggle the agent bus panel showing delegated tasks'

export const PANEL_SHOWN_TEXT = 'Bus panel shown'
export const PANEL_HIDDEN_TEXT = 'Bus panel hidden'

/**
 * The `$.store` key remembering whether the person left the pane open.
 */
export const STORE_OPEN_KEY = 'open'

/**
 * The context a prompt may carry in all; an ask is cut to what is left.
 */
export const PROMPT_CONTEXT_MAX_CHARS = 32_000

/**
 * What a result drawn in the detail is cut to (Markdown takes 10,000).
 */
export const DETAIL_MAX_CHARS = 9_000

/**
 * The lanes the form dispatches to, as agent-ops ROUTING.md names them:
 * each one's `agent-dispatch submit` arguments.
 */
export const LANES: readonly { value: string; label: string; argv: string[] }[] =
  [
    {
      value: 'luna',
      label: 'luna · throughput',
      argv: ['--to', 'codex', '--model', 'gpt-6-luna', '--effort', 'high'],
    },
    {
      value: 'sol',
      label: 'sol · implementation',
      argv: ['--to', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium'],
    },
    {
      value: 'sonnet',
      label: 'sonnet · fallback',
      argv: ['--to', 'claude', '--effort', 'medium'],
    },
  ]

export const MODES = [
  { value: 'read-only', label: 'read-only' },
  { value: 'write', label: 'may edit files' },
] as const

/**
 * The id a task dispatched from the pane is queued under: the time and the
 * prompt's first words, as agent-dispatch names one itself.
 */
export function taskIdOf(prompt: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')

  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`

  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')

  return `${stamp}-${slug || 'task'}`
}

/**
 * The agent-dispatch arguments that submit the form, run in the background
 * so the call returns at once; the folder bounds a writing task's scope.
 */
export function submitArgsOf(
  composer: { lane: string; mode: string; cwd: string; prompt: string },
  id: string,
): string[] | null {
  const lane = LANES.find(one => one.value === composer.lane)
  const prompt = composer.prompt.trim()

  if (!lane || !prompt || !composer.cwd.trim()) return null

  return [
    'submit',
    ...lane.argv,
    '--mode',
    composer.mode,
    '--cwd',
    composer.cwd.trim(),
    ...(composer.mode === 'write'
      ? ['--scope', `files under ${composer.cwd.trim()} only`]
      : []),
    '--id',
    id,
    '--bg',
    prompt,
  ]
}

/**
 * This machine's bus, as the `hosts` option names it.
 */
export const LOCAL = 'local'

/**
 * Where a remote machine's dispatcher is, left unquoted so its shell
 * expands the home directory.
 */
export const REMOTE_DISPATCH = '~/.local/bin/agent-dispatch'

/**
 * The machines the `hosts` option names, in order and once each: `local` or
 * ssh aliases (letters, digits, `.`, `_`, `-`); anything else is dropped.
 */
export function hostsOf(option: unknown): string[] {
  const names = String(option ?? '')
    .split(/[\s,]+/)
    .map(name => name.trim())
    .filter(name => /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('-'))

  const unique = [...new Set(names)]

  return unique.length > 0 ? unique : [LOCAL]
}

/**
 * One word for a POSIX shell: single-quoted, with each `'` closed, escaped
 * and reopened.
 */
export const shellQuote = (word: string): string =>
  `'${word.replace(/'/g, `'\\''`)}'`

/**
 * The command a remote shell runs for these dispatcher arguments, the
 * origin set in its environment when given.
 */
export function remoteCommandOf(args: string[], origin?: string): string {
  const env = origin ? `env AGENT_BUS_ORIGIN=${shellQuote(origin)} ` : ''

  return `${env}${REMOTE_DISPATCH} ${args.map(shellQuote).join(' ')}`
}

/**
 * The ssh argument vector that runs a command on `alias`: never prompting,
 * giving up on an unreachable machine in seconds, and sharing one
 * connection between polls.
 */
export function sshArgvOf(alias: string, command: string): string[] {
  return [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'ControlMaster=auto',
    '-o',
    'ControlPath=/tmp/agent-bus-ssh-%C',
    '-o',
    'ControlPersist=120',
    alias,
    command,
  ]
}

/**
 * A task's address across machines.
 */
export const taskKeyOf = (task: { host: string; id: string }): string =>
  `${task.host}/${task.id}`

/**
 * What one machine's bus answered: its parsed `status --json`, or why not.
 */
export type HostAnswer = {
  host: string
  status: { tasks?: Omit<BusTask, 'host'>[] } | null
  error: string | null
}

/**
 * The machines' answers as one snapshot: every active task in the order the
 * machines are listed, then the most recent finished ones across them all.
 * It fails as a whole only when no machine answered.
 */
export function mergedSnapshotOf(
  answers: HostAnswer[],
  now: number,
  recent = 20,
): BusSnapshot {
  const tasks = answers.flatMap(answer =>
    (answer.status?.tasks ?? []).map(task => ({ ...task, host: answer.host })),
  )

  const active = tasks.filter(task => ACTIVE_STATES.includes(task.state))

  const finished = tasks
    .filter(task => !ACTIVE_STATES.includes(task.state))
    .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0))
    .slice(0, recent)

  const count = (state: BusTask['state']) =>
    tasks.filter(task => task.state === state).length

  const failed = answers.filter(answer => answer.error !== null)

  return {
    hosts: answers.map(({ host, error }) => ({ name: host, error })),
    now,
    counts: {
      queued: count('queued'),
      running: count('running'),
      done: count('done'),
      failed: count('failed'),
    },
    tasks: [...active, ...finished],
    error:
      answers.length > 0 && failed.length === answers.length
        ? (failed[0]?.error ?? null)
        : null,
  }
}

export const ACTIVE_STATES: readonly BusTask['state'][] = [
  'running',
  'queued',
  'orphaned',
]

export const isActive = (task: BusTask): boolean =>
  ACTIVE_STATES.includes(task.state)

/**
 * The lane a task ran in, as the routing doc names them: the model's family
 * where it has one (`luna`, `sol`, `opus`), else the worker CLI.
 */
export function laneOf(task: BusTask): string {
  const model = (task.model ?? '').toLowerCase()
  const lanes = ['luna', 'sol', 'opus', 'sonnet', 'haiku', 'fable', 'argon']
  const lane = lanes.find(name => model.includes(name))

  return lane ?? (task.agent === 'antigravity' ? 'agy' : task.agent)
}

/**
 * A span in its largest whole unit: `45s`, `12m`, `3h`, `2d`.
 */
export function spanOf(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))

  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`

  return `${Math.floor(s / 86_400)}d`
}

/**
 * A span to the minute: `12m 4s`, `1h 12m`.
 */
export function longSpanOf(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))

  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`

  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function tokensOf(count: number): string {
  if (count < 1000) return `${count} tokens`
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k tokens`

  return `${(count / 1_000_000).toFixed(2)}M tokens`
}

/**
 * How long a task has run, or ran, as of the snapshot.
 */
export function runSecondsOf(task: BusTask, now: number): number | null {
  if (task.elapsed_s !== null) return task.elapsed_s
  if (task.started_at !== null) return now - task.started_at
  if (task.queued_at !== null) return now - task.queued_at

  return null
}

/**
 * A list row's right edge: the lane and, while active, how long it has run;
 * once finished, how long ago.
 */
export function tailOf(task: BusTask, now: number, isTagged = false): string {
  const lane = isTagged ? `${task.host} · ${laneOf(task)}` : laneOf(task)

  if (task.state === 'queued') return `${lane} · queued`
  if (task.state === 'orphaned') return `${lane} · stranded`

  if (task.state === 'running') {
    const ran = runSecondsOf(task, now)

    return ran === null ? lane : `${lane} · ${spanOf(ran)}`
  }

  return task.finished_at === null
    ? lane
    : `${lane} · ${spanOf(now - task.finished_at)} ago`
}

/**
 * The glyph before a row, and the theme colour it draws in.
 */
export function markOf(task: BusTask): { glyph: string; color?: string } {
  if (task.cancelled) return { glyph: '⊘', color: 'inactive' }

  switch (task.state) {
    case 'running':
      return { glyph: '●', color: 'warning' }
    case 'queued':
      return { glyph: '○', color: 'inactive' }
    case 'orphaned':
      return { glyph: '!', color: 'error' }
    case 'done':
      return { glyph: '✓', color: 'success' }
    case 'failed':
      return { glyph: '✗', color: 'error' }
  }
}

/**
 * The status line's entry: what is active, or nothing while the bus is idle.
 */
export function statusTextOf(snapshot: BusSnapshot | null): string | undefined {
  if (!snapshot || snapshot.error) return undefined

  const running = snapshot.tasks.filter(task => task.state === 'running')
  const queued = snapshot.tasks.filter(task => task.state === 'queued').length

  if (running.length === 0 && queued === 0) return undefined

  const lanes = [...new Set(running.map(laneOf))].join(', ')

  const parts = [
    running.length > 0 ? `${running.length} running (${lanes})` : null,
    queued > 0 ? `${queued} queued` : null,
  ].filter(part => part !== null)

  return `bus · ${parts.join(' · ')}`
}

/**
 * The toast for a task that finished while this session watched.
 */
export function toastOf(task: BusTask): string {
  const verb = task.cancelled
    ? 'cancelled'
    : task.state === 'done'
      ? 'done'
      : 'failed'

  const ran = task.elapsed_s === null ? '' : ` · ${spanOf(task.elapsed_s)}`

  return `${markOf(task).glyph} ${task.id} ${verb} · ${laneOf(task)}${ran}`
}

/**
 * The note the model reads when a task this session dispatched finishes:
 * enough to act on without asking, and where the whole result is.
 */
export function finishedNoteOf(task: BusTask): string {
  const verb = task.cancelled
    ? 'was cancelled'
    : task.state === 'done'
      ? 'finished'
      : 'failed'

  const how = [
    task.agent,
    task.model,
    task.elapsed_s === null ? null : longSpanOf(task.elapsed_s),
  ]
    .filter(part => part)
    .join(', ')

  const isRemote = task.host !== LOCAL

  const lines = [
    `[agent-bus] Task \`${task.id}\` that this session dispatched ${verb} (${how}${isRemote ? `, on ${task.host}` : ''}).`,
    isRemote
      ? `Result on ${task.host}: read it with \`ssh ${task.host} '${REMOTE_DISPATCH} result ${task.id}'\``
      : `Result: ${task.result}`,
  ]

  if (task.note) lines.push(`Dispatcher note: ${task.note.split('\n')[0]}`)

  return lines.join('\n')
}

/**
 * What an ask adds to the next prompt: the task, then its result, cut by
 * whole lines to the room left.
 */
export function askTextOf(
  task: BusTask,
  text: string,
  room: number,
): string | undefined {
  const head =
    `Result of agent-bus task \`${task.id}\` (${laneOf(task)}, ` +
    `${task.state}) from ${task.result}:\n\n`

  const cut = '\n[… result cut to fit; the whole file is at the path above]'

  if (head.length + text.length <= room) return head + text

  const kept: string[] = []

  let used = head.length + cut.length

  for (const line of text.split('\n')) {
    if (used + line.length + 1 > room) break

    kept.push(line)
    used += line.length + 1
  }

  return kept.length > 0 ? head + kept.join('\n') + cut : undefined
}

/**
 * A path with the home directory folded to `~`.
 */
export const homeFolded = (path: string, home: string | undefined): string =>
  home && path.startsWith(home) ? `~${path.slice(home.length)}` : path

/**
 * Text safe to draw: no control characters but newline and tab.
 */
export const sanitize = (text: string): string =>
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
