import importlib.machinery
import importlib.util
import subprocess
import json
import os
import signal
import threading
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "agent-dispatch"
loader = importlib.machinery.SourceFileLoader("agent_dispatch", str(SCRIPT))
spec = importlib.util.spec_from_loader("agent_dispatch", loader)
ad = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ad)


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        ad.BUS = self.home / "bus"
        ad.CONFIG_PATH = ad.BUS / "config.json"
        ad.INBOX = ad.BUS / "inbox"
        ad.RUNNING = ad.BUS / "running"
        ad.DONE = ad.BUS / "done"
        ad.FAILED = ad.BUS / "failed"
        ad.LOGS = ad.BUS / "logs"
        ad.WORKTREES = ad.BUS / "worktrees"
        ad.HOME = self.home
        ad.ensure_bus()

    def tearDown(self):
        self.tmp.cleanup()

    def test_read_only_commands(self):
        c = ad.build_worker_cmd("codex", {"mode": "read-only", "model": "m", "output_file": "/tmp/o"}, "p")
        self.assertIn("read-only", c)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", c)
        c = ad.build_worker_cmd("claude", {"mode": "read-only", "model": "haiku"}, "p")
        self.assertIn("plan", c)
        self.assertNotIn("--dangerously-skip-permissions", c)

    def test_antigravity_timeout_and_route_tail(self):
        c = ad.build_worker_cmd("antigravity", {"mode": "write", "timeout_seconds": 71}, "p")
        self.assertEqual(c[c.index("--print-timeout") + 1], "71s")
        self.assertTrue(ad.quota_like_failure("x" * 100000 + " quota"))
        log = ad.LOGS / "route.log"
        log.write_text("x" * 100000 + "quota")
        self.assertTrue(ad.quota_like_failure(ad.log_tail(log)))

    def _fake_worker(self, body):
        bindir = self.home / "bin"
        bindir.mkdir()
        exe = bindir / "dispatch-fake-worker"
        exe.write_text("#!/bin/sh\n" + body + "\n")
        exe.chmod(0o755)
        (bindir / "codex").symlink_to(exe)
        ad.AGENT_COMMANDS["testfake"] = ["dispatch-fake-worker"]
        ad.DEFAULT_MODELS["testfake"] = "fake-model"
        ad.DEFAULT_EFFORT["testfake"] = "low"
        old_path = os.environ.get("PATH", "")
        os.environ["PATH"] = str(bindir) + os.pathsep + old_path
        return old_path

    def _queue_fake(self, task_id, timeout=3):
        task = {"id": task_id, "to": "testfake", "mode": "write", "cwd": str(self.home),
                "prompt": "test", "timeout_seconds": timeout, "retry": 0, "result": str(ad.DONE / (task_id + ".md"))}
        return ad.write_task(task)

    def test_silent_worker_timeout_finishes_failed(self):
        old_path = self._fake_worker("sleep 30")
        try:
            path = self._queue_fake("silent-timeout", 3)
            started = time.monotonic()
            self.assertEqual(ad.run_task(path), 124)
            self.assertLess(time.monotonic() - started, 10)
            self.assertTrue((ad.FAILED / "silent-timeout.json").exists())
            self.assertIn("timed out", (ad.FAILED / "silent-timeout.note.txt").read_text())
        finally:
            os.environ["PATH"] = old_path

    def test_foreground_sigterm_fails_and_kills_worker(self):
        old_path = self._fake_worker("sleep 30")
        old_signal = signal.signal(signal.SIGTERM, ad.handle_termination)
        ad.TERMINATION_SIGNAL = None
        outcome = []
        try:
            path = self._queue_fake("signal-task", 20)
            thread = threading.Thread(target=lambda: outcome.append(ad.run_task(path)))
            thread.start()
            limit = time.monotonic() + 5
            while ad.ACTIVE_PROCESS is None and time.monotonic() < limit:
                time.sleep(.02)
            os.kill(os.getpid(), signal.SIGTERM)
            thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertTrue((ad.FAILED / "signal-task.json").exists())
            self.assertIn("terminated by signal", (ad.FAILED / "signal-task.note.txt").read_text())
        finally:
            signal.signal(signal.SIGTERM, old_signal)
            os.environ["PATH"] = old_path
            ad.TERMINATION_SIGNAL = None
            ad.ACTIVE_PROCESS = None

    def test_continuation_status_policy(self):
        self.assertTrue(ad.needs_continuation("codex", "answer", 1))
        self.assertFalse(ad.needs_continuation("codex", "answer\nSTATUS: PARTIAL", 1))
        self.assertFalse(ad.needs_continuation("cursor", "answer", 1))
        self.assertFalse(ad.needs_continuation("codex", "rejected (`EPERM`). STATUS: BLOCKED — read-only", 1))

    def test_codex_continues_once_without_status_but_not_partial(self):
        count = self.home / "calls"
        count.write_text("0")
        old_path = self._fake_worker(
            'n=$(cat "' + str(count) + '"); n=$((n + 1)); echo "$n" > "' + str(count) + '"\n'
            'out=""; prev=""; for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done\n'
            'if [ "$n" -eq 1 ]; then echo \'{"type":"thread.started","thread_id":"fake-session"}\'; '
            'printf "answer without status" > "$out"; else echo \'{"type":"turn.completed","usage":{"output_tokens":2}}\'; '
            'case "$*" in *fake-session*) ;; *) exit 9;; esac; case "$*" in *sandbox_mode*read-only*) ;; *) exit 8;; esac; printf "answer\\nSTATUS: DONE\\n" > "$out"; fi')
        try:
            ad.AGENT_COMMANDS["codex"] = ["codex"]
            task = {"id": "continue-once", "to": "codex", "mode": "read-only", "cwd": str(self.home),
                    "prompt": "test", "timeout_seconds": 5, "retry": 0, "continuations": 1}
            path = ad.write_task(task)
            self.assertEqual(ad.run_task(path), 0)
            self.assertEqual(count.read_text().strip(), "2")
            self.assertIn("STATUS: DONE", (ad.DONE / "continue-once.md").read_text())

            count.write_text("0")
            task["id"] = "no-partial-continuation"
            task["result"] = str(ad.DONE / "no-partial-continuation.md")
            path = ad.write_task(task)
            # Run a partial-result fixture by replacing the parser's clean text.
            original = ad.parse_worker_output
            def partial_parser(agent, raw, task_data):
                text, usage = original(agent, raw, task_data)
                if task_data.get("id") == "no-partial-continuation":
                    return "answer\nSTATUS: PARTIAL", usage
                return text, usage
            ad.parse_worker_output = partial_parser
            try:
                self.assertEqual(ad.run_task(path), 0)
                self.assertEqual(count.read_text().strip(), "1")
            finally:
                ad.parse_worker_output = original
        finally:
            os.environ["PATH"] = old_path

    def test_worktree_keeps_write_isolated_and_records_branch(self):
        old_path = self._fake_worker('echo worker-line >> README; printf "fake output\\n"')
        repo = self.home / "scratch"
        repo.mkdir()
        subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True)
        (repo / "README").write_text("base\n")
        subprocess.run(["git", "-C", str(repo), "add", "README"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-m", "base"], check=True, capture_output=True)
        try:
            path = ad.write_task({"id": "worktree-task", "to": "testfake", "mode": "write",
                "cwd": str(repo), "prompt": "test", "timeout_seconds": 5, "retry": 0,
                "worktree": True})
            self.assertEqual(ad.run_task(path), 0)
            self.assertEqual((repo / "README").read_text(), "base\n")
            wt = ad.WORKTREES / "worktree-task"
            self.assertEqual((wt / "README").read_text(), "base\nworker-line\n")
            saved = json.loads((ad.DONE / "worktree-task.json").read_text())
            self.assertEqual(saved["worktree"], str(wt))
            self.assertEqual(saved["branch"], "bus/worktree-task")
        finally:
            os.environ["PATH"] = old_path

    def test_background_submit_spawns_detached_dispatcher(self):
        from argparse import Namespace
        args = Namespace(prompt=["hello"], prompt_file=None, id="bg-task", result=None,
            to="codex", mode="read-only", cwd=str(self.home), scope="test", timeout=10,
            retry=0, continuations=1, model=None, effort=None, wrap_result=False,
            worktree=False, bg=True, run=False)
        with mock.patch.object(ad.subprocess, "Popen") as popen:
            self.assertEqual(ad.cmd_submit(args), 0)
            self.assertTrue(popen.call_args.kwargs["start_new_session"])
            self.assertEqual(popen.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_preamble_rules_cap(self):
        (ad.BUS / "worker-rules.md").write_text("R" * 9000)
        prompt = ad.task_prompt({"id": "x", "cwd": "/tmp", "mode": "read-only", "prompt": "p"})
        self.assertIn("R" * 8192, prompt)
        self.assertNotIn("R" * 8193, prompt)
        self.assertNotIn("BEGIN ~/AGENTS.md", prompt)

    def test_clean_worker_parsers(self):
        text, usage = ad.parse_worker_output("claude", json.dumps({"result": "hello", "total_cost_usd": .01,
            "duration_ms": 25, "num_turns": 1, "session_id": "s", "usage": {"input_tokens": 4}}), {})
        self.assertEqual(text, "hello")
        self.assertEqual(usage["total_cost_usd"], .01)

    def test_prune_replaces_old_files_with_gzip(self):
        from argparse import Namespace
        old = ad.DONE / "old.md"
        old.write_text("result")
        os.utime(old, (1, 1))
        ad.cmd_prune(Namespace(older_than=30, dry_run=True))
        self.assertTrue(old.exists())
        ad.cmd_prune(Namespace(older_than=30, dry_run=False))
        self.assertFalse(old.exists())
        import gzip as _gz
        with _gz.open(str(ad.DONE / "old.md.gz"), "rt") as f:
            self.assertEqual(f.read(), "result")

    def test_finish_metrics(self):
        task = {"id": "metric", "to": "codex", "mode": "read-only", "_started_monotonic": ad.time.monotonic()}
        path = ad.write_task(task, ad.RUNNING)
        ad.finish(path, ad.DONE, task=task)
        saved = json.loads((ad.DONE / path.name).read_text())
        for key in ("finished_at", "elapsed_s", "exit_code", "agent", "model", "effort", "usage"):
            self.assertIn(key, saved)


if __name__ == "__main__":
    unittest.main()
