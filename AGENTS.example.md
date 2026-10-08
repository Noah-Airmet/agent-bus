# If you use the agent bus, add a section like this to your global
# instruction file (~/AGENTS.md, ~/.claude/CLAUDE.md, etc.) so every
# session knows the bus exists. Trim the worker list to what you installed
# (`agent-dispatch workers` shows yours).

## Agent bus — delegate to other AI workers

## Noah's routing policy

All code writing, features, fixes, refactors, tests, scripts and UI work must
use **Sonnet 5.5 on High** or **Opus 5.5 on High**. Pin the Claude model and
`--effort high` explicitly. OpenAI is allowed only for super simple one-step
operations (CLI installs, setup of existing GitHub tools, routine docs) and
computer use, never code writing or debugging. If the scope grows, hand it
to Claude. Claude quota exhaustion means wait or report the block, never
fallback to OpenAI, `--to auto`, `--to cheap`, or another model for code.
Canonical policy: `~/development/agent-ops/docs/ROUTING.md`.


You can hand tasks to other coding-agent CLIs installed on this machine.
This is worth it when a *different* tool beats more of the same: a cheap
fast model for bulk extraction, a frontier model for a second opinion, or
an approved worker for the task.

```bash
# One-shot calls (result lands in ~/.agent-bus/done/<id>.md)
agent-dispatch submit --to auto --mode read-only --cwd <project-dir> "Task" --run
agent-dispatch submit --to claude --model claude-sonnet-5-5 --effort high --mode write \
  --cwd <project-dir> --scope "files in scope" "Task" --run

# Inspect
agent-dispatch status
agent-dispatch workers          # which worker CLIs are installed
```

- Prefer `--mode read-only` for research, audits, summaries.
- Write tasks need `--scope` (which files may change) and success criteria.
- A worker gets ONE prompt: brief it like a colleague with your tools and
  none of your context (goal, current state, constraints, output format).
- Check the result file yourself; don't ask the human to poll for it.
