import asyncio
import gzip
import json
import os
import socket
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client

from agent_bus_mcp.server import Bus

CLI = Path(__file__).resolve().parents[2] / "bin" / "agent-dispatch"


@pytest.fixture
def sandbox(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    bindir = tmp_path / "bin"
    bindir.mkdir()
    worker = bindir / "codex"
    worker.write_text(f"#!{sys.executable}\n" + '''
import json, sys, time
from pathlib import Path
prompt = sys.argv[-1]
if "SLOW_WORKER" in prompt:
    print("worker started", flush=True)
    time.sleep(45)
if "FAIL_WORKER" in prompt:
    print("intentional worker failure", flush=True)
    sys.exit(2)
out = sys.argv[sys.argv.index("-o") + 1]
Path(out).write_text("BUS_SMOKE_OK\\nSTATUS: COMPLETE\\n" + "x" * 1500)
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 20}}))
''')
    worker.chmod(0o755)
    env = dict(os.environ, HOME=str(tmp_path), AGENT_BUS_HOME=str(tmp_path / "bus"),
               AGENT_BUS_DISPATCH=str(CLI), AGENT_BUS_MCP_ROOTS=str(project),
               PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""))
    return project, env


@asynccontextmanager
async def session(env):
    params = StdioServerParameters(command=sys.executable,
                                   args=["-m", "agent_bus_mcp.server"], env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as client:
            await client.initialize()
            yield client


async def call(client, name, args=None):
    result = await client.call_tool(name, args or {})
    assert not result.isError, result.content
    return result.structuredContent


async def submit(client, project, **kwargs):
    return await call(client, "submit_task", dict(prompt="smoke test", cwd=str(project),
                                                  model="test-fake", **kwargs))


async def finished(client, task_id):
    result = await call(client, "wait_for_task", {"task_id": task_id, "seconds": 10})
    assert not result["timed_out"], result
    return result["task"]


async def test_stdio_complete_job_output_paging_and_origin(sandbox):
    project, env = sandbox
    async with session(env) as client:
        tools = (await client.list_tools()).tools
        assert len(tools) == 7
        annotations = {t.name: t.annotations for t in tools}
        assert annotations["list_tasks"].readOnlyHint
        assert not annotations["submit_task"].readOnlyHint
        assert annotations["cancel_task"].destructiveHint
        assert all(t.outputSchema for t in tools)
        info = await call(client, "bus_info")
        assert info["project_roots"] == [str(project)]
        submitted = await submit(client, project, origin="chat-test")
        task_id = submitted["task_id"]
        task = await finished(client, task_id)
        assert task["state"] == "done"
        assert task["tokens"] == 30
        assert task["origin"] == "chat-test"
        first = await call(client, "read_task_output", {"task_id": task_id, "limit": 256})
        assert first["text"].startswith("BUS_SMOKE_OK")
        assert first["has_more"]
        second = await call(client, "read_task_output", {"task_id": task_id,
                                                      "offset": first["next_offset"]})
        assert not second["has_more"]
        assert len(first["text"] + second["text"]) > 1500
        assert (await call(client, "list_tasks", {"origin": "unrelated"}))["tasks"] == []
        assert (await call(client, "list_tasks", {"origin": "chat-test"}))["tasks"][0]["id"] == task_id
        # Cancellation of a finished task is a harmless no-op.
        assert not (await call(client, "cancel_task", {"task_id": task_id}))["cancelled"]


async def test_running_cancellation_and_bounded_wait(sandbox):
    project, env = sandbox
    async with session(env) as client:
        job = await call(client, "submit_task", {"cwd": str(project), "prompt": "SLOW_WORKER"})
        task_id = job["task_id"]
        for _ in range(100):
            task = await call(client, "get_task", {"task_id": task_id})
            if task["state"] == "running" and task["log"]:
                break
            await asyncio.sleep(0.05)
        assert task["state"] == "running"
        assert (await call(client, "wait_for_task", {"task_id": task_id, "seconds": 0}))["timed_out"]
        result = await call(client, "cancel_task", {"task_id": task_id})
        assert result["cancelled"]
        assert result["task"]["state"] == "failed"
        assert result["task"]["cancelled"]


async def test_failed_job_and_gzip_result(sandbox):
    project, env = sandbox
    async with session(env) as client:
        job = await call(client, "submit_task", {"cwd": str(project), "prompt": "FAIL_WORKER"})
        task = await finished(client, job["task_id"])
        assert task["state"] == "failed"
        assert task["exit_code"] == 2
        page = await call(client, "read_task_output", {"task_id": task["id"]})
        assert "intentional worker failure" in page["text"]
        path = Path(task["result"])
        with gzip.open(str(path) + ".gz", "wb") as out:
            out.write(path.read_bytes())
        path.unlink()
        assert (await call(client, "read_task_output", {"task_id": task["id"]}))["text"] == page["text"]
        log = Path(task["log"])
        with gzip.open(str(log) + ".gz", "wb") as out:
            out.write(log.read_bytes())
        log.unlink()
        archived = await call(client, "read_task_output", {"task_id": task["id"], "kind": "log"})
        assert archived["available"]
        assert "intentional worker failure" in archived["text"]


async def test_write_default_isolated_worktree(sandbox):
    project, env = sandbox
    subprocess.run(["git", "init", str(project)], check=True, capture_output=True)
    (project / "baseline.txt").write_text("committed")
    subprocess.run(["git", "-C", str(project), "add", "."], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(project), "-c", "user.name=MCP Test",
                    "-c", "user.email=mcp-test@example.invalid", "commit", "-m", "fixture"],
                   check=True, capture_output=True)
    (project / "uncommitted.txt").write_text("must stay in original checkout")
    async with session(env) as client:
        job = await submit(client, project, mode="write", scope="baseline.txt only")
        task = await finished(client, job["task_id"])
        assert task["state"] == "done"
        worktree = Path(task["worktree"])
        assert worktree != project
        assert worktree.is_relative_to(Path(env["AGENT_BUS_HOME"]))
        assert (worktree / "baseline.txt").read_text() == "committed"
        assert not (worktree / "uncommitted.txt").exists()
        assert (project / "uncommitted.txt").exists()


async def test_reject_paths_scope_ids_and_invalid_schema(sandbox):
    project, env = sandbox
    escape = project / "escape"
    escape.symlink_to(project.parent, target_is_directory=True)
    async with session(env) as client:
        for args in [
            {"cwd": str(project.parent), "prompt": "hello"},
            {"cwd": str(escape), "prompt": "hello"},
            {"cwd": str(project), "prompt": "hello", "mode": "write"},
            {"cwd": str(project), "prompt": " "},
            {"cwd": str(project), "prompt": "hello", "worker": "antigravity"},
            {"cwd": str(project), "prompt": "hello", "timeout_seconds": 99999},
        ]:
            assert (await client.call_tool("submit_task", args)).isError
        assert (await client.call_tool("get_task", {"task_id": "../../secret"})).isError
        assert (await client.call_tool("read_task_output", {"task_id": "none", "offset": -1})).isError
        assert not list(Path(env["AGENT_BUS_HOME"]).glob("inbox/*.json"))


def test_outputs_cannot_read_arbitrary_files_or_symlinks(sandbox, monkeypatch):
    project, env = sandbox
    for key in ("AGENT_BUS_HOME", "AGENT_BUS_DISPATCH", "AGENT_BUS_MCP_ROOTS"):
        monkeypatch.setenv(key, env[key])
    bus = Bus()
    secret = project / "secret"
    secret.write_text("must not appear")
    bus.home.mkdir()
    link = bus.home / "result.md"
    link.symlink_to(secret)
    for path in [secret, link]:
        with pytest.raises(ValueError, match="outside"):
            bus.output({"result": str(path)}, "result", 0, 256)


async def test_http_transport(sandbox):
    project, env = sandbox
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "agent_bus_mcp.server", "--transport", "streamable-http",
        "--port", str(port), env=env, stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}/mcp"
    try:
        async with httpx.AsyncClient() as http:
            for _ in range(100):
                try:
                    await http.get(url)
                    break
                except httpx.ConnectError:
                    await asyncio.sleep(0.05)
            # SDK protects localhost against DNS rebinding even without auth.
            assert (await http.post(url, headers={"Host": "evil.example"}, json={})).status_code == 421
        async with streamablehttp_client(url) as (read, write, _):
            async with ClientSession(read, write) as client:
                await client.initialize()
                assert len((await client.list_tools()).tools) == 7
                job = await submit(client, project)
                assert (await finished(client, job["task_id"]))["state"] == "done"
                assert "BUS_SMOKE_OK" in (await call(client, "read_task_output", {"task_id": job["task_id"]}))["text"]
    finally:
        process.terminate()
        await asyncio.wait_for(process.wait(), 5)
