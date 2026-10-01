/**
 * One task as `agent-dispatch status --json` reports it (contract version 1).
 */
export type BusTask = {
  /**
   * The machine whose bus holds the task: `local`, or the ssh alias the
   * pane reached it by. Set by the pane, not the bus.
   */
  host: string
  id: string
  state: 'queued' | 'running' | 'orphaned' | 'done' | 'failed'
  to: string
  agent: string
  model: string | null
  effort: string | null
  mode: string | null
  cwd: string | null
  prompt: string
  origin: string | null
  queued_at: number | null
  started_at: number | null
  finished_at: number | null
  elapsed_s: number | null
  exit_code: number | null
  cancelled: boolean
  tokens: number | null
  result: string
  log: string | null
  note: string | null
  worktree: string | null
}

/**
 * The last poll: its tasks, active first then the most recent finished, and
 * when it was taken (epoch seconds); or why the poll failed.
 */
export type BusSnapshot = {
  /**
   * Every machine the pane watches, in order, and why it could not be read.
   */
  hosts: { name: string; error: string | null }[]
  now: number
  counts: { queued: number; running: number; done: number; failed: number }
  tasks: BusTask[]
  error: string | null
}

/**
 * What the detail under the list shows for the selected task: its result's
 * text once finished, or nothing yet.
 */
export type BusDetail = {
  id: string
  text: string | null
}

/**
 * The new-task form under the list: which lane, whether the worker may
 * write, where it runs, and the prompt typed so far.
 */
export type BusComposer = {
  isOpen: boolean
  host: string
  lane: string
  mode: 'read-only' | 'write'
  cwd: string
  prompt: string
  isSending: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agent-bus': {
      snapshot: BusSnapshot | null
      selected: string | null
      detail: BusDetail | null
      armed: string | null
      composer: BusComposer | null
    }
  }
}
