-- Postgres-native message queues (pgmq-style, pure SQL).
--
-- Each queue is a table <project schema>.q_<name> (+ archive a_<name>), so the
-- messages live in the project's own schema, are covered by its backups and
-- are isolated by ordinary PostgreSQL privileges. The odb_queue functions run
-- with the CALLER's rights (SECURITY INVOKER) and act on the caller's
-- current schema (the project schema for both the SQL editor and the API).
--
--   select odb_queue.create('emails');
--   select odb_queue.send('emails', '{"to":"a@b.c"}', 0);            -- → msg_id
--   select * from odb_queue.read('emails', 30, 10);                  -- hide for 30 s, up to 10
--   select odb_queue.archive('emails', 1);  /  odb_queue.delete('emails', 1)
--   select * from odb_queue.pop('emails');                           -- read + delete
--   select * from odb_queue.metrics('emails');  /  odb_queue.list_queues()
--
-- Visibility timeout: a read message is invisible for `vt` seconds; if it is
-- not archived/deleted by then it becomes readable again (read_ct counts).

CREATE SCHEMA IF NOT EXISTS odb_queue;
GRANT USAGE ON SCHEMA odb_queue TO PUBLIC;

CREATE OR REPLACE FUNCTION odb_queue._check(queue_name TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF queue_name IS NULL OR queue_name !~ '^[a-z][a-z0-9_]{0,47}$' THEN
        RAISE EXCEPTION 'invalid queue name "%": use a-z, 0-9 and _, starting with a letter (max 48)', queue_name USING ERRCODE = '22023';
    END IF;
    RETURN queue_name;
END $$;

CREATE OR REPLACE FUNCTION odb_queue._table(queue_name TEXT, archive BOOLEAN DEFAULT FALSE) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE t TEXT := (CASE WHEN archive THEN 'a_' ELSE 'q_' END) || odb_queue._check(queue_name);
BEGIN
    IF to_regclass(format('%I.%I', current_schema(), t)) IS NULL THEN
        RAISE EXCEPTION 'queue "%" does not exist', queue_name USING ERRCODE = '42P01';
    END IF;
    RETURN format('%I.%I', current_schema(), t);
END $$;

CREATE OR REPLACE FUNCTION odb_queue."create"(queue_name TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    s TEXT := current_schema();
    q TEXT := 'q_' || odb_queue._check(queue_name);
    a TEXT := 'a_' || queue_name;
BEGIN
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.%I (
        msg_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        read_ct     INTEGER NOT NULL DEFAULT 0,
        enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        vt          TIMESTAMPTZ NOT NULL DEFAULT now(),
        message     JSONB NOT NULL)', s, q);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (vt, msg_id)', q || '_vt', s, q);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.%I (
        msg_id      BIGINT PRIMARY KEY,
        read_ct     INTEGER NOT NULL,
        enqueued_at TIMESTAMPTZ NOT NULL,
        archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        vt          TIMESTAMPTZ NOT NULL,
        message     JSONB NOT NULL)', s, a);
    -- project default privileges grant tables to the API roles; queues are for
    -- service_role (and whatever the project grants on the queue_* functions)
    EXECUTE format('REVOKE ALL ON %I.%I, %I.%I FROM anon, authenticated', s, q, s, a);
    EXECUTE format('COMMENT ON TABLE %I.%I IS %L', s, q, 'odb queue');
END $$;

CREATE OR REPLACE FUNCTION odb_queue."drop"(queue_name TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('DROP TABLE IF EXISTS %I.%I, %I.%I', current_schema(), 'q_' || odb_queue._check(queue_name), current_schema(), 'a_' || queue_name);
    RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION odb_queue.send(queue_name TEXT, message JSONB, sleep_seconds INTEGER DEFAULT 0) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE id BIGINT;
BEGIN
    EXECUTE format('INSERT INTO %s (vt, message) VALUES (now() + make_interval(secs => $1), $2) RETURNING msg_id', odb_queue._table(queue_name))
        INTO id USING greatest(coalesce(sleep_seconds, 0), 0), message;
    RETURN id;
END $$;

CREATE OR REPLACE FUNCTION odb_queue.send_batch(queue_name TEXT, messages JSONB[], sleep_seconds INTEGER DEFAULT 0) RETURNS SETOF BIGINT
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY EXECUTE format('INSERT INTO %s (vt, message) SELECT now() + make_interval(secs => $1), m FROM unnest($2) m RETURNING msg_id', odb_queue._table(queue_name))
        USING greatest(coalesce(sleep_seconds, 0), 0), messages;
END $$;

CREATE OR REPLACE FUNCTION odb_queue.read(queue_name TEXT, sleep_seconds INTEGER, n INTEGER DEFAULT 1)
RETURNS TABLE (msg_id BIGINT, read_ct INTEGER, enqueued_at TIMESTAMPTZ, vt TIMESTAMPTZ, message JSONB)
LANGUAGE plpgsql AS $$
DECLARE t TEXT := odb_queue._table(queue_name);
BEGIN
    RETURN QUERY EXECUTE format(
        'UPDATE %1$s q SET vt = now() + make_interval(secs => $1), read_ct = q.read_ct + 1
         WHERE q.msg_id IN (SELECT m.msg_id FROM %1$s m WHERE m.vt <= now() ORDER BY m.msg_id LIMIT $2 FOR UPDATE SKIP LOCKED)
         RETURNING q.msg_id, q.read_ct, q.enqueued_at, q.vt, q.message', t)
        USING greatest(coalesce(sleep_seconds, 30), 0), least(greatest(coalesce(n, 1), 1), 1000);
END $$;

CREATE OR REPLACE FUNCTION odb_queue.pop(queue_name TEXT)
RETURNS TABLE (msg_id BIGINT, read_ct INTEGER, enqueued_at TIMESTAMPTZ, vt TIMESTAMPTZ, message JSONB)
LANGUAGE plpgsql AS $$
DECLARE t TEXT := odb_queue._table(queue_name);
BEGIN
    RETURN QUERY EXECUTE format(
        'DELETE FROM %1$s q WHERE q.msg_id = (SELECT m.msg_id FROM %1$s m WHERE m.vt <= now() ORDER BY m.msg_id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING q.msg_id, q.read_ct, q.enqueued_at, q.vt, q.message', t);
END $$;

CREATE OR REPLACE FUNCTION odb_queue.archive(queue_name TEXT, message_id BIGINT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
    EXECUTE format('WITH moved AS (DELETE FROM %s WHERE msg_id = $1 RETURNING msg_id, read_ct, enqueued_at, vt, message)
                    INSERT INTO %s (msg_id, read_ct, enqueued_at, vt, message) SELECT * FROM moved',
                   odb_queue._table(queue_name), odb_queue._table(queue_name, TRUE)) USING message_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n > 0;
END $$;

CREATE OR REPLACE FUNCTION odb_queue.delete(queue_name TEXT, message_id BIGINT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
    EXECUTE format('DELETE FROM %s WHERE msg_id = $1', odb_queue._table(queue_name)) USING message_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n > 0;
END $$;

CREATE OR REPLACE FUNCTION odb_queue.set_vt(queue_name TEXT, message_id BIGINT, sleep_seconds INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
    EXECUTE format('UPDATE %s SET vt = now() + make_interval(secs => $2) WHERE msg_id = $1', odb_queue._table(queue_name))
        USING message_id, greatest(coalesce(sleep_seconds, 0), 0);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n > 0;
END $$;

CREATE OR REPLACE FUNCTION odb_queue.purge(queue_name TEXT) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE n BIGINT;
BEGIN
    EXECUTE format('DELETE FROM %s', odb_queue._table(queue_name));
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- (the input is q_name: plpgsql forbids a parameter and an output column with the same name)
CREATE OR REPLACE FUNCTION odb_queue.metrics(q_name TEXT)
RETURNS TABLE (queue_name TEXT, queue_length BIGINT, visible BIGINT, oldest_msg_age_sec INTEGER, newest_msg_age_sec INTEGER, total_messages BIGINT, archived BIGINT)
LANGUAGE plpgsql AS $$
DECLARE t TEXT := odb_queue._table(q_name);
BEGIN
    RETURN QUERY EXECUTE format(
        'SELECT $1::text, count(*), count(*) FILTER (WHERE vt <= now()),
                extract(epoch FROM now() - min(enqueued_at))::int, extract(epoch FROM now() - max(enqueued_at))::int,
                coalesce((SELECT last_value FROM pg_sequences WHERE schemaname = $2 AND sequencename = $3), 0)::bigint,
                (SELECT count(*) FROM %s)
         FROM %s', odb_queue._table(q_name, TRUE), t)
        USING q_name, current_schema()::text, 'q_' || q_name || '_msg_id_seq';
END $$;

CREATE OR REPLACE FUNCTION odb_queue.list_queues()
RETURNS TABLE (queue_name TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
    SELECT substr(c.relname, 3)::text, NULL::timestamptz
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname LIKE 'q\_%'
      AND obj_description(c.oid, 'pg_class') = 'odb queue'
    ORDER BY 1
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA odb_queue TO PUBLIC;
