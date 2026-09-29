# Queues

OwnDatabase has two kinds of queue.

| | Background jobs | Postgres queues |
|---|---|---|
| Stored in | Redis (BullMQ) | your project's schema (tables `q_<name>`, `a_<name>`) |
| Good for | platform work: call a function, send email, fire a webhook, run SQL on a schedule | your application's messages, sent in the same transaction as your data |
| Retries | automatic, exponential backoff, dead-letter list | visibility timeout: unacknowledged messages come back |
| Used from | dashboard, control API, cron | SQL, RPC (`/rest/v1/:project/rpc/queue_*`), dashboard |

## Postgres queues

Same model as pgmq / Supabase Queues: `read` hides a message for `sleep_seconds`;
`archive` or `delete` acknowledges it; if neither happens before the timeout it
becomes readable again (`read_ct` counts deliveries).

### SQL (SQL editor, migrations, your own functions)

```sql
select odb_queue.create('emails');
select odb_queue.send('emails', '{"to": "a@example.com"}');          -- → msg_id
select odb_queue.send('emails', '{"to": "b@example.com"}', 60);      -- visible in 60 s
select * from odb_queue.read('emails', 30, 10);                      -- up to 10, hidden for 30 s
select odb_queue.archive('emails', 1);                               -- done, keep a copy
select odb_queue.delete('emails', 2);                                -- done
select * from odb_queue.pop('emails');                               -- read + delete in one step
select * from odb_queue.metrics('emails');
select * from odb_queue.list_queues();
select odb_queue.purge('emails');  select odb_queue.drop('emails');
```

Because messages are rows in your schema, `send` inside a transaction is only
visible if the transaction commits — e.g. insert an order and enqueue its
confirmation email atomically. Queues are included in project backups.

### From your application (RPC)

Creating a queue (dashboard or `POST /api/projects/:id/pg-queues`) installs
these functions in the project schema:

| RPC | Arguments |
|---|---|
| `queue_send` | `queue_name, message, sleep_seconds = 0` → msg_id |
| `queue_send_batch` | `queue_name, messages[], sleep_seconds = 0` |
| `queue_read` | `queue_name, sleep_seconds = 30, n = 1` → messages |
| `queue_pop` | `queue_name` |
| `queue_archive` / `queue_delete` | `queue_name, message_id` → boolean |
| `queue_set_vt` | `queue_name, message_id, sleep_seconds` |

```bash
curl -X POST "$ODB_URL/rest/v1/$PROJECT/rpc/queue_send" -H "apikey: $SERVICE_KEY" \
     -H 'content-type: application/json' -d '{"queue_name":"emails","message":{"to":"a@example.com"}}'
```

**Only `service_role` may call them by default**, and the queue tables are not
readable by `anon` / `authenticated`. To let signed-in users enqueue, grant it:

```sql
grant execute on function queue_send(text, jsonb, integer) to authenticated;
grant insert on q_emails to authenticated;
```

### Isolation

The `odb_queue` functions run with the caller's privileges and act on the
caller's schema, so a project can only reach its own queues.
