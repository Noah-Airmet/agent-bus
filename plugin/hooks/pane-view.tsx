import type { ElementTable, RenderElement } from 'claude-code'

import type { BusComposer, BusDetail, BusSnapshot, BusTask } from '../types'
import {
  homeFolded,
  isActive,
  LANES,
  LOCAL,
  MODES,
  longSpanOf,
  markOf,
  runSecondsOf,
  sanitize,
  spanOf,
  tailOf,
  taskKeyOf,
  tokensOf,
} from './words'

/**
 * The elements the pane draws with, from `$.ui.resolve(e)`.
 */
export type Ui = Pick<
  ElementTable<'terminal' | 'desktop'>,
  'Box' | 'Text' | 'Button' | 'Markdown' | 'Input' | 'Select'
>

/**
 * What the pane's Buttons do, each closing over the plugin's `$`.
 */
export type PaneActions = {
  select: (id: string) => void
  cancel: (id: string) => void
  toggleAsk: (id: string) => void
  compose: () => void
  discard: () => void
  setHost: (host: string) => void
  setLane: (lane: string) => void
  setMode: (mode: string) => void
  setCwd: (cwd: string) => void
  setPrompt: (prompt: string) => void
  dispatch: (prompt: string) => void
}

/**
 * What every part of one drawing is handed.
 */
export type Kit = {
  ui: Ui
  actions: PaneActions
  columns: number
  home: string | undefined

  /**
   * Whether the surface draws text fields (the mobile app does not), so the
   * pane offers a new task there.
   */
  canCompose: boolean
}

export type PaneModel = {
  snapshot: BusSnapshot | null
  selected: string | null
  detail: BusDetail | null
  armed: string | null
  composer: BusComposer | null
  isDocked: boolean
}

/**
 * Finished tasks the docked list shows under the active ones; inline, fewer.
 */
const RECENT_ROWS_DOCKED = 8
const RECENT_ROWS_INLINE = 3

/**
 * The task the detail shows: the one picked (by its key across machines),
 * else the first active, else the most recent.
 */
export function selectedOf(
  snapshot: BusSnapshot | null,
  selected: string | null,
): BusTask | null {
  const tasks = snapshot?.tasks ?? []

  return (
    tasks.find(task => taskKeyOf(task) === selected) ??
    tasks.find(isActive) ??
    tasks[0] ??
    null
  )
}

const present = (nodes: (RenderElement | null | false)[]): RenderElement[] =>
  nodes.filter((node): node is RenderElement => Boolean(node))

function dimNote(kit: Kit, text: string): RenderElement {
  const { Text } = kit.ui

  return (
    <Text dimColor wrap="truncate-end">
      {text}
    </Text>
  )
}

function divider(kit: Kit): RenderElement {
  const { Text } = kit.ui

  return (
    <Text dimColor wrap="truncate-end">
      {'─'.repeat(Math.max(1, kit.columns))}
    </Text>
  )
}

/**
 * The first line: what is running and queued in bold, or `Idle` and when the
 * bus last finished something.
 */
function headerView(
  kit: Kit,
  snapshot: BusSnapshot,
  isComposable: boolean,
): RenderElement {
  const { Box, Text, Button } = kit.ui
  const tasks = snapshot.tasks
  const running = tasks.filter(task => task.state === 'running').length
  const queued = tasks.filter(task => task.state === 'queued').length
  const last = tasks.find(task => !isActive(task))

  const [lead, aside] =
    running > 0
      ? [`${running} running`, queued > 0 ? ` · ${queued} queued` : '']
      : queued > 0
        ? [`${queued} queued`, '']
        : [
            'Idle',
            last?.finished_at
              ? ` · last finished ${spanOf(snapshot.now - last.finished_at)} ago`
              : '',
          ]

  const unreachable = snapshot.hosts.filter(host => host.error !== null)

  const line = (
    <Box flexDirection="row" height={1}>
      <Text wrap="truncate-end">
        <Text bold>{lead}</Text>
        <Text dimColor>{aside}</Text>
      </Text>
      <Box flexGrow={1} />
      {isComposable ? (
        <Button key="compose" plain dimColor hotkey="n" onPress={kit.actions.compose}>
          New task
        </Button>
      ) : null}
    </Box>
  )

  return unreachable.length === 0 ? (
    line
  ) : (
    <Box flexDirection="column">
      {line}
      {unreachable.map(host => (
        <Text color="warning" wrap="truncate-end">
          {`Couldn't reach ${host.name}`}
        </Text>
      ))}
    </Box>
  )
}

/**
 * One task's row: the pointer where selected, its mark, its id as a plain
 * Button, and the lane and time at the right edge.
 */
function taskRow(
  kit: Kit,
  task: BusTask,
  now: number,
  isSelected: boolean,
  isTagged: boolean,
): RenderElement {
  const { Box, Text, Button } = kit.ui
  const mark = markOf(task)
  const key = taskKeyOf(task)

  return (
    <Box flexDirection="row" key={`row-${key}`}>
      <Text>{isSelected ? '❯ ' : '  '}</Text>
      <Text color={mark.color}>{`${mark.glyph} `}</Text>
      <Button
        key={`task-${key}`}
        plain
        dimColor={!isSelected && !isActive(task)}
        onPress={() => kit.actions.select(key)}
      >
        {sanitize(task.id)}
      </Button>
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-start">{` ${tailOf(task, now, isTagged)}`}</Text>
    </Box>
  )
}

/**
 * The selected task under the list: its id and actions, how it ran, then
 * its result (finished) or its prompt (still active).
 */
function detailView(kit: Kit, model: PaneModel, task: BusTask): RenderElement {
  const { Box, Text, Button, Markdown } = kit.ui
  const now = model.snapshot?.now ?? 0
  const key = taskKeyOf(task)
  const isArmed = model.armed === key

  const action = isActive(task) ? (
    <Button key="cancel" hotkey="c" onPress={() => kit.actions.cancel(key)}>
      Cancel
    </Button>
  ) : (
    <Button key="ask" hotkey="a" onPress={() => kit.actions.toggleAsk(key)}>
      {isArmed ? 'Asked ✓' : 'Ask'}
    </Button>
  )

  const ran = runSecondsOf(task, now)

  const how = [
    task.agent,
    [task.model, task.effort].filter(part => part).join(' '),
    task.mode,
  ]
    .filter(part => part)
    .join(' · ')

  const when = [
    task.state === 'queued' ? 'queued' : null,
    ran === null ? null : longSpanOf(ran),
    task.tokens ? tokensOf(task.tokens) : null,
  ]
    .filter(part => part)
    .join(' · ')

  const folder = task.worktree ?? task.cwd

  const where =
    task.host === LOCAL
      ? folder && homeFolded(folder, kit.home)
      : [task.host, folder].filter(part => part).join(' · ')

  const body =
    model.detail?.id === key && model.detail.text !== null ? (
      <Markdown key="result" text={model.detail.text} />
    ) : isActive(task) ? (
      <Text wrap="wrap">{sanitize(task.prompt)}</Text>
    ) : (
      dimNote(kit, 'No result file.')
    )

  return (
    <Box flexDirection="column">
      {present([
        <Box flexDirection="row" height={1}>
          <Text bold wrap="truncate-end">
            {sanitize(task.id)}
          </Text>
          <Box flexGrow={1} />
          {action}
        </Box>,
        dimNote(kit, how),
        where ? dimNote(kit, where) : null,
        when ? dimNote(kit, when) : null,
        task.note ? (
          <Text color={task.cancelled ? 'inactive' : 'error'} wrap="wrap">
            {sanitize(task.note.split('\n')[0] ?? '')}
          </Text>
        ) : null,
        <Box height={1} />,
        isActive(task) ? dimNote(kit, 'Prompt') : null,
        body,
      ])}
    </Box>
  )
}

/**
 * The new-task form in the detail's place: lane, mode, folder, then the
 * prompt, whose Enter dispatches in the background.
 */
function composerView(
  kit: Kit,
  composer: BusComposer,
  hosts: string[],
): RenderElement {
  const { Box, Text, Button, Input, Select } = kit.ui
  const lane = LANES.find(one => one.value === composer.lane)

  const hint = composer.isSending
    ? 'Dispatching…'
    : `Enter dispatches to ${lane?.value ?? composer.lane}, ${composer.mode}` +
      (hosts.length > 1 || composer.host !== LOCAL ? `, on ${composer.host}` : '')

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" height={1}>
        <Text bold>New task</Text>
        <Box flexGrow={1} />
        <Button key="discard" role="dismiss" onPress={kit.actions.discard}>
          Discard
        </Button>
      </Box>
      <Box height={1} />
      {hosts.length > 1 ? (
        <Select
          key="host"
          label="Machine "
          value={composer.host}
          options={hosts.map(host => ({
            value: host,
            label: host === LOCAL ? 'this machine' : host,
          }))}
          onSelect={kit.actions.setHost}
        />
      ) : null}
      <Select
        key="lane"
        label="Lane "
        value={composer.lane}
        options={LANES.map(({ value, label }) => ({ value, label }))}
        onSelect={kit.actions.setLane}
      />
      <Select
        key="mode"
        label="Mode "
        value={composer.mode}
        options={MODES.map(({ value, label }) => ({ value, label }))}
        onSelect={kit.actions.setMode}
      />
      <Input
        key="cwd"
        label="Folder "
        value={
          composer.host === LOCAL
            ? homeFolded(composer.cwd, kit.home)
            : composer.cwd
        }
        onInput={kit.actions.setCwd}
        onSubmit={kit.actions.setCwd}
      />
      <Box height={1} />
      <Input
        key="prompt"
        label="Prompt "
        placeholder="What should the worker do?"
        submitLabel="dispatch"
        value={composer.prompt}
        autoFocus
        onInput={kit.actions.setPrompt}
        onSubmit={kit.actions.dispatch}
      />
      <Box height={1} />
      {dimNote(kit, hint)}
    </Box>
  )
}

/**
 * The pane's body for one `ui.render`. Docked: the header, the active
 * tasks, the recent ones, then the selected task in full. Inline above the
 * prompt: the header and the rows alone.
 */
export function paneView(kit: Kit, model: PaneModel): RenderElement {
  const { Box } = kit.ui
  const snapshot = model.snapshot

  const frame = (children: RenderElement[]): RenderElement => (
    <Box
      flexDirection="column"
      paddingTop={model.isDocked ? 1 : 0}
      paddingRight={model.isDocked ? 1 : 0}
    >
      {children}
    </Box>
  )

  if (!snapshot) {
    return frame([dimNote(kit, 'Reading the bus…')])
  }

  if (snapshot.error) {
    return frame([dimNote(kit, snapshot.error)])
  }

  const hosts = snapshot.hosts.map(host => host.name)
  const isTagged = hosts.length > 1
  const isComposing = model.isDocked && model.composer?.isOpen === true
  const isComposable = model.isDocked && kit.canCompose && !isComposing

  if (snapshot.tasks.length === 0) {
    return frame(
      present([
        headerView(kit, snapshot, isComposable),
        <Box height={1} />,
        isComposing && model.composer
          ? composerView(kit, model.composer, hosts)
          : dimNote(kit, 'No bus tasks yet.'),
      ]),
    )
  }

  const selected = selectedOf(snapshot, model.selected)
  const active = snapshot.tasks.filter(isActive)

  const recent = snapshot.tasks
    .filter(task => !isActive(task))
    .slice(0, model.isDocked ? RECENT_ROWS_DOCKED : RECENT_ROWS_INLINE)

  const rowsOf = (tasks: BusTask[]): RenderElement[] =>
    tasks.map(task =>
      taskRow(
        kit,
        task,
        snapshot.now,
        model.isDocked && task === selected,
        isTagged,
      ),
    )

  return frame(
    present([
      headerView(kit, snapshot, isComposable),
      <Box height={1} />,
      ...rowsOf(active),
      active.length > 0 && recent.length > 0 ? <Box height={1} /> : null,
      recent.length > 0 ? dimNote(kit, 'Recent') : null,
      ...rowsOf(recent),
      ...(isComposing && model.composer
        ? [
            <Box height={1} />,
            divider(kit),
            composerView(kit, model.composer, hosts),
          ]
        : model.isDocked && selected
          ? [
              <Box height={1} />,
              divider(kit),
              detailView(kit, model, selected),
            ]
          : []),
    ]),
  )
}

