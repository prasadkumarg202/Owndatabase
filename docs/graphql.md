# GraphQL

Every project has a GraphQL endpoint generated from its tables:

```
POST /graphql/v1/<projectId>        { "query": "…", "variables": { … } }
GET  /graphql/v1/<projectId>?query=…  (queries only)
```

Send the project API key (`apikey` header) and, for a signed-in user,
`Authorization: Bearer <access token>` — exactly as for REST. Each root field
is compiled into **one** SQL statement and runs as that role, so grants and Row
Level Security apply the same way. On a custom domain the path is
`https://api.example.com/graphql/v1`. From JavaScript: `db.graphql(query, variables)`.

## Schema

For every table or view `orders`:

| Field | |
|---|---|
| `orders(where, orderBy, limit, offset): [Orders!]!` | list (limit defaults to and is capped at `MAX_ROWS`, 1000) |
| `orders_by_pk(id: …): Orders` | one row by primary key |
| `orders_count(where): Int!` | |
| `insert_orders(objects: [OrdersInsert!]!): [Orders!]!` | omitted columns get their defaults |
| `update_orders(where: OrdersFilter!, set: OrdersUpdate!): [Orders!]!` | |
| `delete_orders(where: OrdersFilter!): [Orders!]!` | |

Mutations return the affected rows with any selection, including relations.

**Relations** come from foreign keys, both ways: `orders.customer_id → customers`
gives `Orders.customer` (named after the column without `_id`) and
`Customers.orders(where, orderBy, limit, offset)`.

**Filters** (`where`): per column `{ eq, neq, gt, gte, lt, lte, in, is: NULL | NOT_NULL }`,
plus `like` / `ilike` on text; combine with `and: […]`, `or: […]`, `not: {…}`.
**Ordering**: `orderBy: [{ created_at: DESC }, { id: ASC }]` (also `ASC_NULLS_FIRST` etc.).

**Types**: `int2/int4` → `Int`, `int8` → `BigInt` and `numeric` → `BigFloat` (as
strings, to keep precision), floats → `Float`, `bool` → `Boolean`, timestamps →
`Datetime`, `uuid` → `UUID`, `json/jsonb` → `JSON`, arrays → lists, anything
else → `String`.

```graphql
query PaidOrders($min: BigFloat) {
  orders(where: { status: { eq: "paid" }, total: { gte: $min } }, orderBy: [{ total: DESC }], limit: 20) {
    id total
    customer { name }
    order_items(orderBy: [{ id: ASC }]) { sku qty }
  }
}
```

## Limits and behaviour

- Queries deeper than 8 levels and documents over 5,000 tokens are rejected.
- The schema follows DDL automatically (it is rebuilt when the schema cache changes).
- Tables or columns whose names are not valid GraphQL names are left out.
- Introspection is on, so GraphiQL / Apollo tooling works.
- A project over its database size limit (read-only) still answers queries and
  `delete_*` mutations; inserts and updates are refused, as over REST.
