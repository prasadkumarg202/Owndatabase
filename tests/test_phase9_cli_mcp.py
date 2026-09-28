"""Phase 9 — `odb` CLI and the MCP server, driven exactly like a user / AI agent would."""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from odb import URLS

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "platform" / "cli"
MCP = ROOT / "platform" / "mcp-server"


def _tsx(pkg: Path) -> list[str]:
    tsx = pkg / "node_modules" / ".bin" / "tsx"
    if not tsx.exists():
        pytest.skip(f"run `npm install` in {pkg} first")
    return [str(tsx)]


@pytest.fixture(scope="module")
def odb(tmp_path_factory):
    cfg = tmp_path_factory.mktemp("odbcli") / "cli.json"
    env = {**os.environ, "ODB_CONFIG": str(cfg), "ODB_API_URL": URLS["api"], "ODB_STORAGE_URL": URLS["storage"],
           "ODB_FUNCTIONS_URL": URLS["functions"], "NO_COLOR": "1"}
    base = _tsx(CLI) + [str(CLI / "src" / "cli.ts")]

    def run(*args, input=None, ok=True):
        p = subprocess.run(base + list(args), env=env, input=input, capture_output=True, text=True, timeout=90, cwd=CLI)
        if ok:
            assert p.returncode == 0, f"odb {' '.join(args)}\nstdout:{p.stdout}\nstderr:{p.stderr}"
        return p
    return run


def test_cli_end_to_end(odb, owner, tmp_path):
    odb("login", "--email", owner.email, "--password", owner.password)
    assert owner.email in odb("whoami").stdout
    created = json.loads(odb("--json", "projects", "create", "CLI Project").stdout)
    pid = created["id"]
    assert created["api_keys"]["anon"].startswith("odb_anon_")
    assert any(p["id"] == pid for p in json.loads(odb("--json", "projects", "list").stdout))

    out = odb("db", "exec", pid, "-q", "create table cli_t (id int primary key, name text); insert into cli_t values (1,'from cli'); select * from cli_t").stdout
    assert "from cli" in out
    out = odb("db", "exec", pid, input="select count(*) as n from cli_t").stdout   # SQL from stdin
    assert "1" in out
    assert "cli_t" in odb("db", "tables", pid).stdout
    assert "CREATE TABLE" in odb("db", "dump", pid).stdout

    key = json.loads(odb("--json", "keys", "create", pid, "--name", "ci", "--type", "anon").stdout)
    assert key["key"].startswith("odb_anon_")
    odb("secrets", "set", pid, "CLI_SECRET", input="value-from-stdin\n")
    assert "CLI_SECRET" in odb("secrets", "list", pid).stdout

    odb("storage", "create-bucket", pid, "clifiles", "--public")
    f = tmp_path / "hello.txt"
    f.write_text("hi from cli")
    assert "Uploaded clifiles/docs/hello.txt" in odb("storage", "upload", pid, "clifiles", str(f), "docs/hello.txt").stdout
    assert "docs/" in odb("storage", "ls", pid, "clifiles").stdout

    fn = tmp_path / "fn.mjs"
    fn.write_text("export default async (req) => ({ status: 200, body: { ok: true, n: req.body?.n ?? 0 } })")
    assert "deployed (version 1)" in odb("functions", "deploy", pid, "clifn", str(fn), "--no-verify-jwt").stdout
    out = odb("functions", "invoke", pid, "clifn", "-d", '{"n": 7}', "--apikey", created["api_keys"]["anon"]).stdout
    assert json.loads(out) == {"ok": True, "n": 7}

    assert "queued" in odb("backups", "create", pid).stdout.lower()
    assert "project.created" in odb("logs", pid, "--source", "audit").stdout
    assert "healthy" in odb("status").stdout
    odb("projects", "delete", pid, "--confirm", created["slug"])
    bad = odb("projects", "info", pid, ok=False)
    assert bad.returncode == 1 and "not found" in bad.stderr.lower()


class McpClient:
    def __init__(self, env):
        self.p = subprocess.Popen(_tsx(MCP) + [str(MCP / "src" / "index.ts")], cwd=MCP, env=env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.id = 0

    def call(self, method, params=None):
        self.id += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params or {}}) + "\n")
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise AssertionError("MCP server exited: " + self.p.stderr.read())
            msg = json.loads(line)
            if msg.get("id") == self.id:
                return msg

    def notify(self, method):
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
        self.p.stdin.flush()

    def tool(self, name, **args):
        r = self.call("tools/call", {"name": name, "arguments": args})["result"]
        text = r["content"][0]["text"]
        assert not r.get("isError"), text
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def close(self):
        self.p.kill()


def test_mcp_server_tools_resources_prompts(owner, project):
    env = {**os.environ, "OWNDATABASE_API_URL": URLS["api"], "OWNDATABASE_STORAGE_URL": URLS["storage"],
           "OWNDATABASE_EMAIL": owner.email, "OWNDATABASE_PASSWORD": owner.password}
    m = McpClient(env)
    try:
        init = m.call("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "pytest", "version": "1"}})
        assert init["result"]["serverInfo"]["name"] == "owndatabase"
        m.notify("notifications/initialized")
        tools = {t["name"] for t in m.call("tools/list")["result"]["tools"]}
        assert {"list_projects", "run_sql", "describe_table", "create_policy", "deploy_function", "list_buckets", "create_backup"} <= tools

        assert any(p["id"] == project.id for p in m.tool("list_projects"))
        m.tool("run_sql", projectId=project.id, query="create table if not exists mcp_t (id int primary key, label text); insert into mcp_t values (1,'agent') on conflict do nothing")
        res = m.tool("run_sql", projectId=project.id, query="select label from mcp_t", read_only=True)
        assert res["data"] == [{"label": "agent"}]
        desc = m.tool("describe_table", projectId=project.id, table="mcp_t")
        assert [c["name"] for c in desc["columns"]] == ["id", "label"]
        plan = m.tool("explain_query", projectId=project.id, query="select * from mcp_t where id = 1")
        assert "Scan" in plan["plan"]
        err = m.call("tools/call", {"name": "run_sql", "arguments": {"projectId": project.id, "query": "select * from nope"}})["result"]
        assert err["isError"] is True and "nope" in err["content"][0]["text"]

        res_list = m.call("resources/list")["result"]["resources"]
        assert any(r["uri"] == f"project://{project.id}/schema" for r in res_list)
        schema = m.call("resources/read", {"uri": f"project://{project.id}/schema"})["result"]["contents"][0]["text"]
        assert "mcp_t" in schema
        prompts = {p["name"] for p in m.call("prompts/list")["result"]["prompts"]}
        assert "write_rls_policy" in prompts
        msg = m.call("prompts/get", {"name": "write_rls_policy", "arguments": {"table": "mcp_t"}})["result"]["messages"][0]["content"]["text"]
        assert "mcp_t" in msg and "auth.uid()" in msg
    finally:
        m.close()
