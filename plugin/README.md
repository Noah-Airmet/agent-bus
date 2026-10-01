# agent-bus (Claude Code mod)

The agent bus beside the transcript. `/bus` opens a pane that lists the
queued and running tasks, then the most recent finished ones, and shows the
selected task below them. Each toggle leaves `Bus panel shown` or
`Bus panel hidden` in the transcript, and the pane reopens in later sessions
if it was left open.

- **Active tasks:** each row shows its lane (`luna`, `sol`, `sonnet`, …) and
  how long it has run. The detail shows how and where it runs, plus its
  prompt, with **Cancel** (`c`).
- **Finished tasks:** each row shows how long ago it finished. The detail
  renders the result file as Markdown, with **Ask** (`a`), which attaches that
  result to your next prompt once, the way `/diff`'s ask attaches hunks.
- **New task** (`n`, docked): a form in the detail's place. Pick a lane
  (luna, sol or sonnet, as agent-ops `ROUTING.md` names them), read-only or
  may-edit, and a folder (the session's by default), then type the prompt;
  Enter dispatches it in the background under this session, selects it in
  the list, and its finish reports back here.
- **Status line:** while anything runs it reads
  `bus · 2 running (luna, sol) · 1 queued`. It clears once the bus is idle.
- **Completion:** when a task finishes, a toast says so in the session that
  dispatched it, or in every session for a task no session claims. A session
  that dispatched the task also gets a note in its conversation naming the
  result file, so Claude knows to read it without being told.

Nothing narrates the pane: the rows, the marks (`●` running, `○` queued,
`✓` done, `✗` failed, `⊘` cancelled, `!` stranded) and the detail carry it.

## Machines

The `hosts` option lists the buses the pane watches, in order: `local` for
this machine's, or an ssh alias for another's. It defaults to `local`.

```sh
echo '{"hosts":"imac"}' | claude plugin configure agent-bus@agent-bus --values-stdin
```

- **A machine with no bus** (a laptop) lists the machines that have one,
  e.g. `imac`, or `mini, imac`.
- **A machine with its own bus** lists `local` first, e.g. `local, imac`.
- **Watching more than one machine:** each row gets a dim machine tag, a
  machine that can't be reached gets a warning line under the header, and
  New task gains a Machine picker. The first machine is the default.
- **Folders:** each machine remembers the folder last dispatched to there.
  Another machine's folder starts at `~` and is its own path, not this one's.
- **Completion reports:** a task finishing on another machine still reports
  to the session that dispatched it, because the origin is the session's id.

Another machine is reached as `ssh <alias> '~/.local/bin/agent-dispatch …'`:
BatchMode so it never prompts, a 5 s connect timeout, and one shared
connection (`ControlPersist`). Every argument is single-quoted for the remote
shell. Only names made of letters, digits, `.`, `_` and `-`, not starting
with `-`, count as aliases. The other machine needs the bus installed and
this machine's key in its `authorized_keys`.

## How it reads the bus

Only through `agent-dispatch`, never the queue files directly:

- `agent-dispatch status --json --recent 20` (contract version 1) gives the
  snapshot.
- `agent-dispatch cancel <id>` stops a task.
- `agent-dispatch result <id>` gives a finished task's result text (for the
  detail and for Ask).
- `agent-dispatch submit … --bg` with `AGENT_BUS_ORIGIN` set to the
  session's id dispatches the form.
- `agent-dispatch submit` stamps each task with the submitting session's id
  (`CLAUDE_CODE_SESSION_ID`, or `AGENT_BUS_ORIGIN`), which is how a
  completion finds its way home.

Every 2 s the mod compares this machine's queue folders' modification times
and asks the bus again only when one changed. Another machine's bus is asked
every 5 s, since there is no folder to watch over ssh. While a task runs, the
bus is also asked every 15 s, so elapsed times move.

## What it hooks

| event | what the hook does |
| --- | --- |
| `session.start` | Registers `/bus`, binds the engine, takes the first snapshot, starts the folder watch, reopens the pane if it was left open. |
| `command.run` of `bus` | Opens or closes the pane: docked in the fullscreen layout and desktop, otherwise inline with focus and Esc to close. Remembers the choice. |
| `ui.close` of the pane | Remembers the person's close. |
| `ui.render` of `Pane` | Draws the pane: header, active rows, recent rows, and, when docked, the selected task's detail. |
| `prompt.submit` | Adds an asked result to the prompt's context (cut by whole lines to fit), then disarms. |

## What it calls on `$`

`clock.every`, `clock.now`, `command.register`, `env.get` (`HOME`,
`AGENT_BUS_HOME`), `fs.exists`, `fs.stat`, `process.run` (`agent-dispatch`,
or `ssh <alias>` running it), `session.append`, `session.id`, `state.get`,
`state.set`, `store.get`, `store.set`, `ui.close`, `ui.open`, `ui.panes`,
`ui.resolve`, `ui.status`, `ui.toast`.

## Develop

```sh
claude plugin validate plugin
claude plugin test plugin
claude --plugin-dir plugin
```

The API is early access and changes between Claude Code releases. After an
update, re-run `validate` and `test` before trusting the pane.
