-- Migration 007: Realtime trigger function
-- Creates a trigger that sends NOTIFY on table changes for realtime subscriptions.
-- Call setup_realtime_trigger('schema_name', 'table_name', 'project_id') for each table.

CREATE OR REPLACE FUNCTION control_plane.notify_realtime_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    payload  JSONB;
    channel  TEXT := 'owndatabase_changes';
BEGIN
    IF TG_OP = 'DELETE' THEN
        payload := jsonb_build_object(
            'table',      TG_TABLE_NAME,
            'schema',     TG_TABLE_SCHEMA,
            'action',     'DELETE',
            'record',     row_to_json(OLD)::jsonb,
            'old_record', row_to_json(OLD)::jsonb
        );
    ELSIF TG_OP = 'UPDATE' THEN
        payload := jsonb_build_object(
            'table',      TG_TABLE_NAME,
            'schema',     TG_TABLE_SCHEMA,
            'action',     'UPDATE',
            'record',     row_to_json(NEW)::jsonb,
            'old_record', row_to_json(OLD)::jsonb
        );
    ELSE  -- INSERT
        payload := jsonb_build_object(
            'table',      TG_TABLE_NAME,
            'schema',     TG_TABLE_SCHEMA,
            'action',     'INSERT',
            'record',     row_to_json(NEW)::jsonb
        );
    END IF;

    -- Truncate payload to 8000 bytes (PostgreSQL NOTIFY limit is ~8KB)
    PERFORM pg_notify(channel, left(payload::text, 8000));

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Helper function to attach realtime trigger to any table
CREATE OR REPLACE FUNCTION control_plane.setup_realtime_trigger(
    p_schema TEXT,
    p_table  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    trigger_name TEXT := format('owndatabase_realtime_%s_%s', p_schema, p_table);
BEGIN
    -- Drop existing trigger if present
    EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON %I.%I',
        trigger_name, p_schema, p_table
    );

    -- Create trigger for INSERT, UPDATE, DELETE
    EXECUTE format(
        'CREATE TRIGGER %I
         AFTER INSERT OR UPDATE OR DELETE ON %I.%I
         FOR EACH ROW EXECUTE FUNCTION control_plane.notify_realtime_change()',
        trigger_name, p_schema, p_table
    );

    RAISE NOTICE 'Realtime trigger installed on %.%', p_schema, p_table;
END;
$$;

-- Helper to remove realtime trigger from a table
CREATE OR REPLACE FUNCTION control_plane.remove_realtime_trigger(
    p_schema TEXT,
    p_table  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    trigger_name TEXT := format('owndatabase_realtime_%s_%s', p_schema, p_table);
BEGIN
    EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON %I.%I',
        trigger_name, p_schema, p_table
    );
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION control_plane.notify_realtime_change() TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.setup_realtime_trigger(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.remove_realtime_trigger(TEXT, TEXT) TO service_role;
