# If you use the agent bus, add a section like this to your global
# instruction file (~/AGENTS.md, ~/.claude/CLAUDE.md, etc.) so every
# session knows the bus exists. Trim the worker list to what you installed
# (`agent-dispatch workers` shows yours).

## Agent bus — delegate to other AI workers

You can hand tasks to other coding-agent CLIs installed on this machine.
This is worth it when a *different* tool beats more of the same: a cheap
fast model for bulk extraction, a frontier model for a second opinion, or
any worker when your own provider's quota is spent.

```bash
# One-shot calls (result lands in ~/.agent-bus/done/<id>.md)
agent-dispatch submit --to auto --mode read-only --cwd <project-dir> "Task" --run
agent-dispatch submit --to <cursor|antigravity|claude|codex|opencode> --mode write \
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
