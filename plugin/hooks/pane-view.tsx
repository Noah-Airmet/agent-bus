import type { ElementTable, RenderElement } from 'claude-code'

import type { BusDetail, BusSnapshot, BusTask } from '../types'
import {
  homeFolded,
  isActive,
  longSpanOf,
  markOf,
  runSecondsOf,
  sanitize,
  spanOf,
  tailOf,
  tokensOf,
} from './words'

/**
 * The elements the pane draws with, from `$.ui.resolve(e)`.
 */
export type Ui = Pick<
  ElementTable<'terminal' | 'desktop'>,
  'Box' | 'Text' | 'Button' | 'Markdown'
>

/**
 * What the pane's Buttons do, each closing over the plugin's `$`.
 */
export type PaneActions = {
  select: (id: string) => void
  cancel: (id: string) => void
  toggleAsk: (id: string) => void
}

/**
 * What every part of one drawing is handed.
 */
export type Kit = {
  ui: Ui
  actions: PaneActions
  columns: number
  home: string | undefined
}

export type PaneModel = {
  snapshot: BusSnapshot | null
  selected: string | null
  detail: BusDetail | null
  armed: string | null
  isDocked: boolean
}

/**
 * Finished tasks the docked list shows under the active ones; inline, fewer.
 */
const RECENT_ROWS_DOCKED = 8
const RECENT_ROWS_INLINE = 3

/**
 * The task the detail shows: the one picked, else the first active, else
 * the most recent.
 */
export function selectedOf(
  snapshot: BusSnapshot | null,
  selected: string | null,
): BusTask | null {
  const tasks = snapshot?.tasks ?? []

  return (
    tasks.find(task => task.id === selected) ??
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
function headerView(kit: Kit, snapshot: BusSnapshot): RenderElement {
  const { Box, Text } = kit.ui
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

  return (
    <Box flexDirection="row" height={1}>
      <Text wrap="truncate-end">
        <Text bold>{lead}</Text>
        <Text dimColor>{aside}</Text>
      </Text>
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
): RenderElement {
  const { Box, Text, Button } = kit.ui
  const mark = markOf(task)

  return (
    <Box flexDirection="row" key={`row-${task.id}`}>
      <Text>{isSelected ? '❯ ' : '  '}</Text>
      <Text color={mark.color}>{`${mark.glyph} `}</Text>
      <Button
        key={`task-${task.id}`}
        plain
        dimColor={!isSelected && !isActive(task)}
        onPress={() => kit.actions.select(task.id)}
      >
        {sanitize(task.id)}
      </Button>
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-start">{` ${tailOf(task, now)}`}</Text>
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
  const isArmed = model.armed === task.id

  const action = isActive(task) ? (
    <Button key="cancel" hotkey="c" onPress={() => kit.actions.cancel(task.id)}>
      Cancel
    </Button>
  ) : (
    <Button key="ask" hotkey="a" onPress={() => kit.actions.toggleAsk(task.id)}>
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

  const where = task.worktree ?? task.cwd

  const body =
    model.detail?.id === task.id && model.detail.text !== null ? (
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
        where ? dimNote(kit, homeFolded(where, kit.home)) : null,
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

  if (snapshot.tasks.length === 0) {
    return frame([dimNote(kit, 'No bus tasks yet.')])
  }

  const selected = selectedOf(snapshot, model.selected)
  const active = snapshot.tasks.filter(isActive)

  const recent = snapshot.tasks
    .filter(task => !isActive(task))
    .slice(0, model.isDocked ? RECENT_ROWS_DOCKED : RECENT_ROWS_INLINE)

  const rowsOf = (tasks: BusTask[]): RenderElement[] =>
    tasks.map(task =>
      taskRow(kit, task, snapshot.now, model.isDocked && task === selected),
    )

  return frame(
    present([
      headerView(kit, snapshot),
      <Box height={1} />,
      ...rowsOf(active),
      active.length > 0 && recent.length > 0 ? <Box height={1} /> : null,
      recent.length > 0 ? dimNote(kit, 'Recent') : null,
      ...rowsOf(recent),
      ...(model.isDocked && selected
        ? [
            <Box height={1} />,
            divider(kit),
            detailView(kit, model, selected),
          ]
        : []),
    ]),
  )
}

