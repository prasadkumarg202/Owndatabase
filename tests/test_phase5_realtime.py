"""Phase 5 — realtime: auth on connect, table change events, filters, RLS-aware delivery, broadcast, presence."""
import json
import time
import uuid

import pytest
import requests
import websocket

from odb import URLS


class Client:
    def __init__(self, project, key=None, token=None, dashboard_token=None):
        q = f"project_id={project.id}"
        if key is not False and not dashboard_token:
            q += f"&apikey={key or project.anon_key}"
        if token or dashboard_token:
            q += f"&token={token or dashboard_token}"
        self.ws = websocket.create_connection(f"{URLS['realtime']}?{q}", timeout=10)
        self.hello = self.recv_type("connected", "error")

    def send(self, **msg):
        self.ws.send(json.dumps(msg))

    def recv(self, timeout=5):
        self.ws.settimeout(timeout)
        return json.loads(self.ws.recv())

    def recv_type(self, *types, timeout=8):
        deadline = time.time() + timeout
        while time.time() < deadline:
            m = self.recv(max(0.1, deadline - time.time()))
            if m["type"] in types:
                return m
        raise AssertionError(f"no message of type {types}")

    def expect_none(self, types=("postgres_changes",), wait=1.5):
        deadline = time.time() + wait
        while time.time() < deadline:
            try:
                m = self.recv(max(0.1, deadline - time.time()))
            except websocket.WebSocketTimeoutException:
                return
            assert m["type"] not in types, f"unexpected message {m}"

    def close(self):
        self.ws.close()


@pytest.fixture(scope="module")
def rt(project):
    project.sql("""
      drop table if exists messages;
      create table messages (id bigint generated always as identity primary key, room text, body text,
        user_id uuid default auth.uid());
      alter table messages enable row level security;
      create policy read_room_a on messages for select to anon, authenticated using (room = 'a');
      create policy own_rows on messages for select to authenticated using (user_id = auth.uid());
      create policy insert_own on messages for insert to authenticated with check (user_id = auth.uid());
    """)
    r = project.owner.post(f"/projects/{project.id}/tables/messages/realtime", json={"enabled": True})
    assert r.status_code == 200
    return project


def test_connect_requires_valid_key(project):
    ws = websocket.create_connection(f"{URLS['realtime']}?project_id={project.id}&apikey=odb_anon_bad_bad_bad_bad", timeout=10)
    msg = json.loads(ws.recv())
    assert msg["type"] == "error" and msg["code"] == "auth_failed"
    ws.close()


def test_insert_update_delete_events(rt):
    c = Client(rt, key=rt.service_key)
    assert c.hello["role"] == "service_role"
    c.send(type="subscribe", channel="db:messages", ref="1")
    assert c.recv_type("subscribed")["channel"] == "db:messages"
    rt.sql("insert into messages(room, body) values ('a', 'hi')")
    ev = c.recv_type("postgres_changes")
    assert ev["event"] == "insert" and ev["record"]["body"] == "hi"
    rt.sql(f"update messages set body = 'edited' where id = {ev['record']['id']}")
    up = c.recv_type("postgres_changes")
    assert up["event"] == "update" and up["record"]["body"] == "edited" and up["old_record"]["body"] == "hi"
    rt.sql(f"delete from messages where id = {ev['record']['id']}")
    assert c.recv_type("postgres_changes")["event"] == "delete"
    c.close()


def test_event_and_column_filters(rt):
    c = Client(rt, key=rt.service_key)
    c.send(type="subscribe", channel="db:messages:insert", filter="room=eq.b")
    c.recv_type("subscribed")
    rt.sql("insert into messages(room, body) values ('a', 'not for me'), ('b', 'for me')")
    ev = c.recv_type("postgres_changes")
    assert ev["record"]["body"] == "for me"
    c.expect_none()
    c.close()


def test_rls_aware_delivery(rt):
    anon = Client(rt)                      # anon: may only see room 'a'
    anon.send(type="subscribe", channel="db:messages")
    anon.recv_type("subscribed")
    rt.sql("insert into messages(room, body) values ('secret', 'hidden')")
    anon.expect_none()
    rt.sql("insert into messages(room, body) values ('a', 'visible')")
    assert anon.recv_type("postgres_changes")["record"]["body"] == "visible"
    anon.close()

    user = rt.new_user()
    u = Client(rt, token=user["access_token"])
    assert u.hello["role"] == "authenticated" and u.hello["user_id"] == user["user"]["id"]
    u.send(type="subscribe", channel="db:messages")
    u.recv_type("subscribed")
    r = rt.rest("POST", "messages", token=user["access_token"], json={"room": "private", "body": "mine"}, headers={"Prefer": "return=minimal"})
    assert r.status_code == 201, r.text
    assert u.recv_type("postgres_changes")["record"]["body"] == "mine"
    u.close()


def test_broadcast_between_clients(project):
    a, b = Client(project), Client(project)
    for c in (a, b):
        c.send(type="subscribe", channel="broadcast:lobby")
        c.recv_type("subscribed")
    a.send(type="broadcast", channel="lobby", event="chat", payload={"text": "hello"})
    msg = b.recv_type("broadcast")
    assert msg["event"] == "chat" and msg["payload"] == {"text": "hello"}
    a.expect_none(("broadcast",), wait=1)  # sender does not receive its own message by default
    a.close(); b.close()


def test_private_channels_need_user(project):
    c = Client(project)
    c.send(type="subscribe", channel="broadcast:private-room")
    assert c.recv_type("error")["message"].startswith("Private channels")
    c.close()


def test_server_side_broadcast(project):
    c = Client(project)
    c.send(type="subscribe", channel="broadcast:news")
    c.recv_type("subscribed")
    http = URLS["realtime"].replace("ws://", "http://", 1).replace("wss://", "https://", 1)
    r = requests.post(f"{http}/v1/{project.id}/broadcast", headers={"apikey": project.service_key},
                      json={"channel": "news", "event": "deploy", "payload": {"v": 2}}, timeout=10)
    if r.status_code == 404:
        pytest.skip("realtime HTTP API not routed through this gateway")
    assert r.status_code == 202, r.text
    assert c.recv_type("broadcast")["payload"] == {"v": 2}
    c.close()


def test_presence(project):
    a, b = Client(project), Client(project)
    room = f"room-{uuid.uuid4().hex[:6]}"
    a.send(type="presence", action="track", channel=room, payload={"name": "alice"})
    sync = a.recv_type("presence")
    assert sync["event"] == "sync" and any(p.get("name") == "alice" for p in sync["presences"])
    b.send(type="presence", action="track", channel=room, payload={"name": "bob"})
    assert any(p.get("name") == "alice" for p in b.recv_type("presence")["presences"])
    join = a.recv_type("presence")
    assert join["event"] == "join" and join["payload"]["name"] == "bob"
    b.close()
    leave = a.recv_type("presence")
    assert leave["event"] == "leave"
    a.close()


def test_dashboard_token_can_inspect(rt):
    c = Client(rt, dashboard_token=rt.owner.token)
    assert c.hello["role"] == "service_role"
    c.close()
