# agent-bus

A tiny layer that lets AI coding assistants hand work to each other on one
machine. Your main assistant can send a research task to one AI, a coding
task to another, and collect the answers — without you opening anything.

> **How to use this page:** if you're a person, just tell your AI assistant:
> *"Set up github.com/noahairmet/agent-bus for me."* Everything below is
> written for the assistant, not for you.

---

## For the assistant doing the setup

Your human is non-technical. They have (or can install) one or more AI
coding tools, and they may not know which. Your job: figure out what they
have, set up the bus, prove it works, and report back in plain language.
Do every step yourself; only ask the human to do things only a human can
do (installing an app, logging in, approving permissions).

**Step 0 — Explain in one sentence.** Tell the human: *"I'm going to connect
your AI tools so they can delegate work to each other, then test it."*

**Step 1 — See what AI tools are installed.** Run:

```bash
for c in cursor-agent agy codex claude copilot opencode; do
  command -v $c >/dev/null 2>&1 && echo "$c: installed" || echo "$c: missing"
done
```

- If **none** are installed: ask the human which AI service they pay for
  (ChatGPT, Claude, Cursor, Gemini…) and help them install that tool's CLI
  first — the bus needs at least one worker. Stop here until one exists.
- If **some** are missing: that's fine. The bus uses whatever is there.
  Don't install extra tools unprompted; mention them as options at the end.

**Step 2 — Check each installed tool is logged in.** Each CLI needs its own
login (usually done once inside that tool's app or via its login command).
You can't log in *for* the human if it needs a browser or password — if a
tool isn't logged in, tell the human exactly what to open/click, and continue
with the tools that work. Confirm with:

```bash
agent-dispatch workers   # after install; "ready" means installed
```

(A tool can show as installed but still fail on first use because of login.
The smoke test below catches that — a login failure just means that worker
gets skipped, not that setup failed.)

**Step 3 — Install the bus.**

```bash
git clone https://github.com/noahairmet/agent-bus ~/.agent-bus-repo
~/.agent-bus-repo/install.sh
```

This creates `~/.agent-bus/` (task queues and results), links
`agent-dispatch` onto the PATH, and records which workers exist. It never
overwrites an existing `~/.agent-bus/config.json` — re-running is safe.
If `~/.local/bin` isn't on PATH, follow the note the installer prints
(adding one line to `~/.zshrc`).

**Step 4 — Prove it works.** Run the smoke test:

```bash
~/.agent-bus-repo/install.sh --smoke-test
```

This sends one trivial task ("reply with the word hello") through the first
available worker. Success = the word `hello` in the result file. If the
first worker fails (e.g. not logged in), try one explicitly:

```bash
agent-dispatch submit --to <worker> --mode read-only \
  --id smoke-test-2 "Reply with exactly this word and nothing else: hello" --run
```

**Step 5 — Teach the assistant about the bus.** Add the snippet from
`AGENTS.example.md` to the human's global instruction file (`~/AGENTS.md`
if they have one, else the main tool's equivalent). Keep their file's
existing content; append the section.

**Step 6 — Report back in plain language.** Tell the human: which tools are
connected, one example of what to ask for now (e.g. *"ask me to research a
topic with one AI while another writes the draft"*), and anything they still
need to do (logins). No jargon, no file paths unless asked.

## Everyday use (for assistants)

```bash
# One-shot: queue + run + print result path
agent-dispatch submit --to auto --mode read-only --cwd <project> "Task" --run

# Force a specific worker, allow edits within a scope
agent-dispatch submit --to cursor --mode write --cwd <project> \
  --scope "src/ only" "Task with acceptance criteria" --run

# Inspect queues
agent-dispatch status
agent-dispatch list done
```

`submit --bg` starts a detached dispatcher, prints its task ID, and appends
dispatcher output to `logs/<id>.dispatcher.log`. `--worktree` creates a branch
`bus/<id>` and runs in `worktrees/<id>`; the worktree is retained after the
task. `--continuations N` controls how many times Codex or Claude may continue
after a successful answer that has no `STATUS:` line (default 1).

`AGENT_BUS_HOME` overrides the queue root for isolated runs and tests. Tasks
can use `--timeout SECONDS` to set the worker deadline. The dispatcher kills
the worker process group at the deadline. Foreground runs ignore SIGHUP and
record a failed task if they receive SIGTERM or SIGINT.

`agent-dispatch prune --older-than DAYS [--dry-run]` gzips result and log files
older than DAYS (30 by default) in place, like `gzip`: each file is replaced by
a verified `.gz` with the same mtime; nothing is deleted outright. Files for
queued or running tasks are skipped. On task completion, an optional ntfy message is sent using
`AGENT_BUS_NTFY_TOPIC` or the local `ntfy-topic` setting file. Messages contain
only the task ID, outcome, worker, and elapsed time.

- `--to auto` tries codex → antigravity → cursor and falls through on quota
  or auth failures.
- A worker gets **one prompt**. Brief it like a colleague with your tools
  and none of your context: goal, current state, constraints, output format.
- Results land in `~/.agent-bus/done/<id>.md` (final worker response, no
  wrapper). Read the file yourself; never ask the human to check it.

### Recommended models

| Worker | Default | Worth knowing |
|---|---|---|
| Principal / reviewer | Opus 5.5 | Planning and review |
| Workhorse | `gpt-6-luna` at high effort | Scoped implementation and analysis |
| Backup | Gemini 3.8 Flash | Antigravity lane |
| Overflow | Cursor | Use when other lanes are unavailable or constrained |

### Read-only behavior

| Worker | Read-only behavior |
|---|---|
| Codex | Uses the CLI `read-only` sandbox. |
| Claude | Uses permission mode `plan`. |
| Antigravity | **Prompt-only.** `agy --mode plan` headless either denies all tools (without `--dangerously-skip-permissions`) or still writes (with it). |
| Cursor | The installed CLI did not expose a verified read-only mode; its existing sandbox options are retained. |
| Copilot, opencode | No verified read-only mode is wired; existing worker behavior is retained. |

Read-only mode is a CLI safeguard for the named lanes; task prompts also
instruct workers not to edit. Routes inherit the selected worker's behavior.
- Prefer `--mode read-only` for research/audits/summaries. Write tasks need
  `--scope` and success criteria.
- Fan-out: submit N tasks with a shared `--id` prefix (e.g. `batch-1`,
  `batch-2`), then `agent-dispatch wait --prefix batch-`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing executable` | That worker's CLI isn't installed | Use a different `--to`, or help the human install it |
| Task fails mentioning login/auth/quota | Worker CLI not logged in, or plan quota spent | Route to another worker (`--to auto` does this itself); ask human to log in or wait for quota reset |
| `command not found: agent-dispatch` | `~/.local/bin` not on PATH | Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`, restart terminal |
| Task sits in `running/` forever | An older dispatcher process was killed | `agent-dispatch sweep` moves it to `failed/`; re-submit. Use `--bg` so the dispatcher outlives your shell |
| Claude or Cursor fails over SSH/launchd ("Not logged in", "keychain is locked") | macOS login keychain isn't available to non-GUI sessions | Put a long-lived token in `~/.config/claude/oauth-token` (from `claude setup-token`) or `~/.config/cursor/api-key`, mode 0600; the dispatcher reads them |
| Empty result in `failed/` | Worker quota silently returned nothing | Re-submit `--to auto` so it fails over |

## Uninstall

```bash
rm -f ~/.local/bin/agent-dispatch
rm -rf ~/.agent-bus ~/.agent-bus-repo
```

(Also remove the bus section from the instruction file if you added one.)

## Notes and roadmap

- Python 3.8+, stdlib only. No dependencies or daemons. Optional completion notifications use ntfy.
  Queues are plain JSON files; results are plain text.
- Model IDs churn: override per-worker defaults in `~/.agent-bus/config.json`
  (`default_models`), or pass `--model` per task. See
  `config/config.example.json`.
- Coming later: a local-model worker (Ollama / llama.cpp on a home Mac) so
  private bulk work costs nothing. The config schema reserves space for it.
