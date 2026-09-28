"""Phase 3 — auto-generated REST API: CRUD, filters, ordering, paging, embedding, RPC, RLS, keys, OpenAPI, rate-limit headers."""
import base64
import json
import uuid

import pytest
import requests

from odb import URLS


@pytest.fixture(scope="module")
def blog(project):
    project.sql("""
      drop table if exists comments; drop table if exists posts; drop table if exists authors;
      create table authors (id bigint generated always as identity primary key, name text not null, country text);
      create table posts (
        id bigint generated always as identity primary key,
        author_id bigint references authors(id),
        title text not null, body text, published boolean not null default false,
        views int not null default 0, tags text[] default '{}', meta jsonb default '{}'::jsonb,
        created_at timestamptz not null default now());
      create table comments (id bigint generated always as identity primary key, post_id bigint references posts(id) on delete cascade, text text);
      insert into authors(name, country) values ('Ada','UK'),('Linus','FI'),('Grace','US');
      insert into posts(author_id,title,body,published,views,tags,meta) values
        (1,'Hello world','first post',true,10,'{intro,news}','{"lang":"en"}'),
        (1,'Second','more',false,5,'{news}','{"lang":"en"}'),
        (2,'Kernel','linux stuff',true,100,'{tech}','{"lang":"fi"}'),
        (3,'Compilers','cobol',true,50,'{tech,history}','{"lang":"en"}');
      insert into comments(post_id,text) values (1,'nice'),(1,'great'),(3,'wow');
      create or replace function add_numbers(a int, b int) returns int language sql immutable as $$ select a + b $$;
      create or replace function popular_posts(min_views int default 10) returns setof posts language sql stable as $$ select * from posts where views >= min_views order by views desc $$;
    """)
    return project


def test_read_all(blog):
    r = blog.rest("GET", "posts?order=id")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 4 and rows[0]["title"] == "Hello world"
    assert rows[0]["id"] == 1  # bigint → JSON number
    assert rows[0]["tags"] == ["intro", "news"] and rows[0]["meta"] == {"lang": "en"}


@pytest.mark.parametrize("query,expected", [
    ("published=eq.true", 3),
    ("views=gt.10", 2),
    ("views=gte.10", 3),
    ("views=lt.10", 1),
    ("title=like.*o*", 3),
    ("title=ilike.hello*", 1),
    ("id=in.(1,3)", 2),
    ("body=is.null", 0),
    ("published=not.eq.true", 1),
    ("tags=cs.{tech}", 2),
    ("meta->>lang=eq.fi", 1),
    ("or=(views.gt.60,title.eq.Second)", 2),
    ("and=(published.eq.true,views.lt.60)", 2),
    ("body=fts.linux", 1),
])
def test_filters(blog, query, expected):
    r = blog.rest("GET", f"posts?{query}")
    assert r.status_code == 200, r.text
    assert len(r.json()) == expected, (query, r.json())


def test_select_order_limit_offset_and_count(blog):
    r = blog.rest("GET", "posts?select=id,title&order=views.desc&limit=2&offset=1&count=exact")
    assert r.status_code == 206
    assert [p["title"] for p in r.json()] == ["Compilers", "Hello world"]
    assert set(r.json()[0]) == {"id", "title"}
    assert r.headers["Content-Range"] == "1-2/4"


def test_aliases_casts_and_json_paths(blog):
    r = blog.rest("GET", "posts?select=headline:title,views::text,lang:meta->>lang&id=eq.3")
    assert r.json() == [{"headline": "Kernel", "views": "100", "lang": "fi"}]


def test_range_header(blog):
    r = blog.rest("GET", "posts?order=id", headers={"Range": "0-1"})
    assert len(r.json()) == 2


def test_cursor_pagination(blog):
    seen = []
    cursor = ""
    for _ in range(5):
        r = blog.rest("GET", f"posts?select=id,title&limit=2&cursor={cursor}")
        assert r.status_code in (200, 206)
        seen += [p["id"] for p in r.json()]
        cursor = r.headers.get("X-Next-Cursor")
        if not cursor:
            break
    assert seen == [1, 2, 3, 4]


def test_embedding_many_to_one_and_one_to_many(blog):
    r = blog.rest("GET", "posts?select=title,author:authors(name,country),comments(text)&id=eq.1")
    assert r.status_code == 200, r.text
    post = r.json()[0]
    assert post["author"] == {"name": "Ada", "country": "UK"}
    assert sorted(c["text"] for c in post["comments"]) == ["great", "nice"]
    r = blog.rest("GET", "authors?select=name,posts(title,comments(text))&id=eq.1")
    a = r.json()[0]
    assert len(a["posts"]) == 2 and any(len(p["comments"]) == 2 for p in a["posts"])


def test_single_object(blog):
    r = blog.rest("GET", "posts?id=eq.3", headers={"Accept": "application/vnd.pgrst.object+json"})
    assert r.status_code == 200 and r.json()["title"] == "Kernel"
    r = blog.rest("GET", "posts", headers={"Accept": "application/vnd.pgrst.object+json"})
    assert r.status_code == 406
    assert blog.rest("GET", "posts/4").json()["title"] == "Compilers"
    assert blog.rest("GET", "posts/999").status_code == 404


def test_insert_bulk_defaults_and_return(blog):
    r = blog.rest("POST", "posts?select=id,title,published,views", json=[{"title": "A", "author_id": 1}, {"title": "B", "views": 7, "published": True}])
    assert r.status_code == 201, r.text
    rows = sorted(r.json(), key=lambda x: x["title"])
    assert rows[0]["published"] is False and rows[0]["views"] == 0   # column defaults apply to missing keys
    assert rows[1]["views"] == 7
    r = blog.rest("POST", "posts", json={"title": "C"}, headers={"Prefer": "return=minimal"})
    assert r.status_code == 201 and r.text == ""


def test_upsert(blog):
    r = blog.rest("POST", "authors?select=id,name", json={"id": 3, "name": "Grace Hopper"}, headers={"Prefer": "resolution=merge-duplicates"})
    assert r.status_code == 201, r.text
    assert blog.rest("GET", "authors/3").json()["name"] == "Grace Hopper"


def test_update_and_delete_require_filters(blog):
    assert blog.rest("PATCH", "posts", json={"views": 1}).status_code == 400
    assert blog.rest("DELETE", "posts").status_code == 400
    r = blog.rest("PATCH", "posts?title=eq.A", json={"views": 42, "published": True})
    assert r.status_code == 200 and r.json()[0]["views"] == 42 and r.json()[0]["published"] is True
    r = blog.rest("DELETE", "posts?title=in.(A,B,C)", headers={"Prefer": "return=representation"})
    assert r.status_code == 200 and len(r.json()) == 3
    assert blog.rest("PATCH", "posts/1", json={"views": 11}).json()[0]["views"] == 11


def test_constraint_errors_are_mapped(blog):
    assert blog.rest("POST", "posts", json={"body": "no title"}).status_code == 400          # not null
    assert blog.rest("POST", "posts", json={"title": "x", "author_id": 9999}).status_code == 409  # FK
    assert blog.rest("GET", "posts?views=eq.notanumber").status_code == 400                  # bad input
    assert blog.rest("GET", "posts?nope=eq.1").status_code == 400                             # unknown column
    assert blog.rest("GET", "posts?id=xx.1").status_code in (400,)                            # treated as eq literal → bad input
    assert blog.rest("GET", "missing_table").status_code == 404


def test_injection_attempts_are_harmless(blog):
    for q in ["posts?title=eq.'; drop table posts; --", "posts?order=id;drop table posts", "posts?select=id,(select 1)"]:
        r = blog.rest("GET", q)
        assert r.status_code in (200, 400)
    assert blog.rest("GET", "posts").status_code == 200


def test_rpc(blog):
    r = blog.rest("POST", "rpc/add_numbers", json={"a": 2, "b": 40})
    assert r.status_code == 200 and r.json() == 42
    r = blog.rest("GET", "rpc/popular_posts?min_views=50")
    assert [p["title"] for p in r.json()] == ["Kernel", "Compilers"]
    assert blog.rest("POST", "rpc/add_numbers", json={"a": 1}).status_code == 400
    assert blog.rest("POST", "rpc/nope", json={}).status_code == 404


def test_api_key_rules(blog, project):
    assert requests.get(f"{URLS['rest']}/v1/{project.id}/posts", timeout=10).status_code == 401
    assert blog.rest("GET", "posts", key="odb_anon_" + "x" * 43).status_code == 401
    assert blog.rest("GET", "posts", key="odb_anon_" + "x" * 43).json()["message"] == "Invalid API key"
    # keys can be sent as ?apikey= too
    assert requests.get(f"{URLS['rest']}/v1/{project.id}/posts?apikey={project.anon_key}", timeout=10).status_code == 200
    # forged JWT is rejected
    forged = ".".join([base64.urlsafe_b64encode(json.dumps(x).encode()).decode().rstrip("=") for x in ({"alg": "HS256"}, {"sub": str(uuid.uuid4()), "role": "service_role", "project_id": project.id})]) + ".c2lnbmF0dXJl"
    assert blog.rest("GET", "posts", token=forged).status_code == 401


def test_revoked_key_stops_working(project):
    r = project.owner.post("/keys", json={"project_id": project.id, "name": "temp", "type": "anon"})
    assert r.status_code == 201
    key = r.json()["key"]
    assert project.rest("GET", "posts", key=key).status_code == 200
    assert project.owner.delete(f"/keys/{r.json()['id']}").status_code == 200
    assert project.rest("GET", "posts", key=key).status_code == 401


def test_key_from_another_project_rejected(blog, owner):
    from odb import create_project
    other = create_project(owner)
    assert blog.rest("GET", "posts", key=other.anon_key).status_code == 401


def test_row_level_security(project):
    project.sql("""
      drop table if exists notes;
      create table notes (id bigint generated always as identity primary key,
        user_id uuid not null default auth.uid() references auth.users(id) on delete cascade, body text);
      alter table notes enable row level security;
      create policy own on notes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
    """)
    alice, bob = project.new_user(), project.new_user()
    r = project.rest("POST", "notes", token=alice["access_token"], json={"body": "alice secret"})
    assert r.status_code == 201, r.text
    assert r.json()[0]["user_id"] == alice["user"]["id"]
    project.rest("POST", "notes", token=bob["access_token"], json={"body": "bob note"})
    assert [n["body"] for n in project.rest("GET", "notes", token=alice["access_token"]).json()] == ["alice secret"]
    assert [n["body"] for n in project.rest("GET", "notes", token=bob["access_token"]).json()] == ["bob note"]
    assert project.rest("GET", "notes").json() == []                       # anon sees nothing
    # bob cannot write rows as alice
    r = project.rest("POST", "notes", token=bob["access_token"], json={"body": "x", "user_id": alice["user"]["id"]})
    assert r.status_code == 403
    # bob cannot update alice's note (silently 0 rows)
    alice_note = project.rest("GET", "notes", token=alice["access_token"]).json()[0]["id"]
    assert project.rest("PATCH", f"notes?id=eq.{alice_note}", token=bob["access_token"], json={"body": "hacked"}).json() == []
    # service_role bypasses RLS
    assert len(project.rest("GET", "notes", key=project.service_key).json()) == 2


def test_openapi(blog):
    spec = blog.rest("GET", "openapi.json").json()
    assert spec["openapi"] == "3.1.0"
    assert f"/v1/{blog.id}/posts" in spec["paths"]
    assert f"/v1/{blog.id}/rpc/add_numbers" in spec["paths"]
    assert spec["components"]["schemas"]["posts"]["properties"]["views"]["type"] == "integer"


def test_rate_limit_headers(blog):
    r = blog.rest("GET", "posts?limit=1")
    assert int(r.headers["X-RateLimit-Limit"]) > 0
    assert "X-RateLimit-Remaining" in r.headers


def test_schema_changes_are_picked_up(project):
    project.sql("create table if not exists late_table (id int primary key, v text); insert into late_table values (1,'x') on conflict do nothing")
    assert project.rest("GET", "late_table").json() == [{"id": 1, "v": "x"}]
    project.sql("alter table late_table add column extra int default 5")
    assert project.rest("GET", "late_table?select=extra").json() == [{"extra": 5}]
