"""GraphQL over the project schema (/graphql/v1/:projectId): queries, relations, mutations, RLS."""
import pytest
import requests
from odb import URLS, BASE, create_project

GQL = BASE + "/graphql/v1/{}"


@pytest.fixture(scope="module")
def gp(owner):
    p = create_project(owner, "GraphQL")
    p.sql("""
        create table customers (id int primary key, name text not null, big bigint, joined timestamptz default now());
        create table orders (id int primary key, customer_id int references customers(id), total numeric(10,2), status text default 'new', tags text[]);
        create table notes (id bigint generated always as identity primary key, body text, owner uuid default auth.uid());
        alter table notes enable row level security;
        create policy own on notes for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
        grant select, insert on notes to authenticated;
        grant select on customers, orders to anon;
        insert into customers values (1, 'Asha', 9007199254740993), (2, 'Ravi', null);
        insert into orders values (10, 1, 120.50, 'paid', '{a,b}'), (11, 1, 30, 'new', null), (12, 2, 99.99, 'paid', null);
    """)
    return p


def gql(p, query, variables=None, key=None, token=None):
    headers = {"apikey": key or p.service_key}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.post(GQL.format(p.id), json={"query": query, "variables": variables}, headers=headers, timeout=20)


def test_query_with_filters_order_limit_and_relations(gp):
    r = gql(gp, """
      query($min: BigFloat) {
        paid: orders(where: { status: { eq: "paid" }, total: { gte: $min } }, orderBy: [{ total: DESC }]) {
          id total tags
          customer { name big }
        }
        customers(orderBy: [{ id: ASC }], limit: 1) { ...C orders(orderBy: [{ id: DESC }]) { id } }
        orders_count(where: { or: [{ status: { eq: "new" } }, { id: { in: [12] } }] })
        orders_by_pk(id: 11) { id status }
      }
      fragment C on Customers { id name }""", {"min": "50"})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["paid"] == [
        {"id": 10, "total": "120.50", "tags": ["a", "b"], "customer": {"name": "Asha", "big": "9007199254740993"}},
        {"id": 12, "total": "99.99", "tags": None, "customer": {"name": "Ravi", "big": None}},
    ]
    assert d["customers"] == [{"id": 1, "name": "Asha", "orders": [{"id": 11}, {"id": 10}]}]
    assert d["orders_count"] == 2 and d["orders_by_pk"] == {"id": 11, "status": "new"}


def test_mutations(gp):
    r = gql(gp, """mutation {
      insert_orders(objects: [{ id: 20, customer_id: 2, total: "5" }, { id: 21, total: "6", status: "paid" }]) { id status customer { name } }
    }""")
    assert r.status_code == 200, r.text
    ins = r.json()["data"]["insert_orders"]
    assert ins == [{"id": 20, "status": "new", "customer": {"name": "Ravi"}}, {"id": 21, "status": "paid", "customer": None}]   # default applied
    r = gql(gp, 'mutation { update_orders(where: { id: { in: [20, 21] } }, set: { status: "shipped" }) { id status } }')
    assert sorted(x["id"] for x in r.json()["data"]["update_orders"]) == [20, 21]
    r = gql(gp, "mutation { delete_orders(where: { status: { eq: \"shipped\" } }) { id } }")
    assert len(r.json()["data"]["delete_orders"]) == 2
    r = gql(gp, 'mutation { insert_orders(objects: [{ id: 10 }]) { id } }')
    assert r.status_code == 200 and "duplicate key" in r.json()["errors"][0]["message"]


def test_rls_and_anon(gp):
    user = gp.new_user()
    r = gql(gp, 'mutation { insert_notes(objects: [{ body: "mine" }]) { body owner } }', key=gp.anon_key, token=user["access_token"])
    assert r.status_code == 200 and r.json()["data"]["insert_notes"][0]["owner"] == user["user"]["id"], r.text
    other = gp.new_user()
    r = gql(gp, "{ notes { body } }", key=gp.anon_key, token=other["access_token"])
    assert r.json()["data"]["notes"] == []                                   # RLS hides the other user's row
    r = gql(gp, "{ notes { body } }", key=gp.anon_key, token=user["access_token"])
    assert r.json()["data"]["notes"] == [{"body": "mine"}]
    # anon: RLS (no policy for anon) hides every row; revoked privileges are errors
    assert gql(gp, "{ customers { id } }", key=gp.anon_key).json()["data"]["customers"]
    assert gql(gp, "{ notes { body } }", key=gp.anon_key).json()["data"]["notes"] == []
    gp.sql("create table secret_stuff (id int primary key); revoke all on secret_stuff from anon")
    import time; time.sleep(1)
    r = gql(gp, "{ secret_stuff { id } }", key=gp.anon_key)
    assert "permission denied" in r.json()["errors"][0]["message"], r.text


def test_introspection_validation_and_limits(gp):
    r = gql(gp, "{ __schema { queryType { fields { name } } mutationType { name } } }")
    names = {f["name"] for f in r.json()["data"]["__schema"]["queryType"]["fields"]}
    assert {"customers", "orders", "orders_by_pk", "orders_count", "notes"} <= names
    r = gql(gp, "{ orders { nope } }")
    assert r.status_code == 400 and "nope" in r.json()["errors"][0]["message"]
    deep = "{ customers { orders { customer { orders { customer { orders { customer { orders { customer { id } } } } } } } } } }"
    r = gql(gp, deep)
    assert r.status_code == 400 and "deeper" in r.json()["errors"][0]["message"]
    assert requests.post(GQL.format(gp.id), json={"query": "{ customers { id } }"}, timeout=10).status_code == 401   # API key required
    r = requests.get(GQL.format(gp.id), params={"query": "{ orders_count }"}, headers={"apikey": gp.service_key}, timeout=10)
    assert r.json()["data"]["orders_count"] >= 3


def test_schema_follows_ddl(gp):
    gp.sql("create table late_table (id int primary key, x text)")
    import time
    for _ in range(20):
        r = gql(gp, "{ late_table { id } }")
        if r.status_code == 200:
            break
        time.sleep(0.5)
    assert r.status_code == 200 and r.json()["data"]["late_table"] == [], r.text


def test_read_only_project_allows_queries_and_deletes(owner, platform_admin):
    p = create_project(owner, "GraphQL read-only")
    p.sql("create table big (id int primary key, v text); insert into big select g, repeat('x', 100) from generate_series(1, 50) g")
    assert platform_admin.put(f"/projects/{p.id}/limits", json={"database_bytes": 1}).json()["read_only"] is True
    import time
    for _ in range(20):
        r = gql(p, 'mutation { insert_big(objects: [{ id: 999 }]) { id } }')
        if r.status_code == 402:
            break
        time.sleep(0.5)
    assert r.status_code == 402, r.text
    assert gql(p, "{ big_count }").json()["data"]["big_count"] == 50
    assert len(gql(p, "mutation { delete_big(where: { id: { lte: 10 } }) { id } }").json()["data"]["delete_big"]) == 10
