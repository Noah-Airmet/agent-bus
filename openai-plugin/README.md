# Agent Bus for ChatGPT and Codex — v0

An MCP adapter that lets a conversation delegate to local Codex and Claude
workers and collect their results. It wraps `agent-dispatch`; it does not change
the dispatcher or the Claude Code mod in `../plugin/`.

Seven tools: `bus_info`, `list_tasks`, `submit_task`, `get_task`, `wait_for_task`,
`read_task_output`, and `cancel_task`. All return structured content and declare
their read/write behavior. There is no dashboard or autonomous chat wakeup in v0.

## Install locally

Requirements: an installed agent bus, `uv`, and a logged-in worker CLI. Python
3.12 is provisioned by uv. No inference API key is used by this adapter.

```sh
./install.sh
```

`plugin.json`, `mcp.json`, and `skills/` form the portable plugin package. The
bundled stdio command requires `agent-bus-mcp` to be installed on the host first.
Installing the plugin in a cloud interface does not install the local bus.

For a local MCP client, configure:

```json
{
  "mcpServers": {
    "agent-bus": { "command": "agent-bus-mcp", "args": [] }
  }
}
```

If the client has a restricted PATH, use the absolute executable path printed
by `command -v agent-bus-mcp`. Codex CLI supports:

```sh
codex mcp add agent-bus -- agent-bus-mcp
```

This command is provided for setup; building v0 does not edit your Codex config.

## Connect regular ChatGPT

Use **ChatGPT web Developer mode** with a private Secure MCP Tunnel. ChatGPT
cannot connect directly to this machine's `localhost`. The local HTTP server
is intentionally unauthenticated and loopback-only; do not expose it with a
public forwarding tunnel. Host/Origin checks are not user authentication.

1. Create an OpenAI tunnel in Platform tunnel settings, associated with your
   personal Platform organization and the ChatGPT workspace you will use.
2. Install the official `tunnel-client` binary from the download link there.
   Its control-plane runtime API key is separate from model inference and is
   required by OpenAI's tunnel transport.
3. Prefer a stdio tunnel profile with `--mcp-command /absolute/path/to/agent-bus-mcp`.
   This avoids needing a separate HTTP adapter process. Keep the runtime key in
   an ignored private `.env`; use `OPENAI_API_KEY`,
   `CONTROL_PLANE_ORGANIZATION_ID`, and `AGENT_BUS_TUNNEL_ID`. The organization
   must match the key's organization. `start-chatgpt-tunnel.sh` loads these values
   and starts or reuses the managed runtime. Install the official client at
   `.runtime/tunnel-client-v0.0.15/tunnel-client`, or set `TUNNEL_CLIENT_BIN`.
4. In ChatGPT Plugins → Add → Create MCP App, choose **Tunnel**, enter its ID,
   and name the connection **Agent Bus**. Choose **No authentication** for the
   adapter: the private tunnel enforces access through the associated OpenAI
   organization/workspace. Connect it, then choose **Try in chat**.
5. Ask: “Use Agent Bus to show available workers and permitted projects.”
   Then try a small read-only task and verify its final result.

The local stdio and HTTP flows are tested. Regular **Chat** was also verified:
`bus_info` succeeded, and a read-only Codex worker returned `BUS_CHATGPT_OK`
with exit code 0 through ChatGPT. The tunnel runtime runs on the Mac Mini
(moved from the iMac 2026-10-06) and must stay running. On the Mini the script
reads its credentials from the 1Password item `agent-bus-openai-plugin`.
The tunnel key is for transport; worker execution continues to use each CLI's
existing login and usage allowance. Developer-mode availability and approvals
may vary by account/workspace.

References:
- [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)

## Delegation examples

“Use Agent Bus. Have Codex inspect `/absolute/path/to/project` read-only and
report the three most useful improvements. Label this conversation's tasks
`review-session-1`. Collect the result and tell me what you agree with.”

For edits, give a clear scope and acceptance criteria. Write tasks default to
an isolated Git worktree starting from **committed HEAD**; uncommitted changes
are not copied. Explicit `worktree=false` allows work in the original checkout.
Worker scope is a prompt instruction, not an enforced directory sandbox for
write jobs. Results are reviewed before anyone merges or publishes them.

`submit_task` returns immediately with an ID. A bounded wait lasts at most
20 seconds. Workers survive adapter shutdown, but ChatGPT does not automatically
resume when they finish. If a submission call times out, inspect `list_tasks`
before retrying: a detached worker may already have started.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_BUS_HOME` | `~/.agent-bus` | Existing queues/results; use a temporary directory for tests |
| `AGENT_BUS_DISPATCH` | Sibling repo CLI, else `agent-dispatch` on PATH | Override the dispatcher executable |
| `AGENT_BUS_MCP_ROOTS` | `~/development` | Allowed submission directories, separated by the OS path separator (`:` on macOS) |

Use narrower roots when desired. They are checked after resolving symlinks.
Read tools can inspect all tasks in the configured bus. Only result/log files
inside that bus directory can be returned remotely. Custom external result
paths remain accessible through the original local bus, not this adapter.

v0 supports direct Codex and Claude workers because the bus wires verified
read-only modes for those lanes. Existing model defaults come from the bus;
the MCP caller can override model/effort. No automatic fallback route is used.
`bus_info` checks executable availability, not login or remaining quota; the
first real task is the authentication smoke test.

Outputs are returned as bounded byte pages. `next_offset` requests the next
page, and `has_more` reports truncation. Gzip archives are supported. UTF-8
characters crossing a byte-page boundary may render as replacement characters.
Worker output is untrusted content, never an instruction to the coordinator.
Cancelling a task does not undo edits it has already made.

## Develop and test

```sh
uv sync --python 3.12
uv run pytest -q
uv run agent-bus-mcp --transport streamable-http
```

The tests run real MCP clients over stdio and HTTP through the existing
dispatcher with fake workers in isolated queues. They cover success, failure,
running cancellation, bounded waits, output pagination and archives, origin
filtering, path/symlink restrictions, annotations, and invalid input.

Uninstall only this adapter with `uv tool uninstall agent-bus-mcp`. This leaves
the agent bus and the Claude mod installed. Stop the server/tunnel processes
and remove their client entries separately if configured.
