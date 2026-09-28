#!/bin/bash
# PostgreSQL initialization script
# Runs once, when the data directory is first created.
#
# Creates extensions and the built-in API roles. Schema migrations are NOT run
# here any more: the control API applies platform/migrations/*.sql on start
# (tracked in control_plane.schema_migrations), so fresh and existing
# databases follow exactly the same path.

set -euo pipefail

echo "→ Initializing OwnDatabase PostgreSQL..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
    CREATE EXTENSION IF NOT EXISTS "pg_trgm";

    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'monitoring') THEN
            CREATE ROLE monitoring WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
        END IF;
        -- API roles. None of them can log in; services SET ROLE into them.
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
            CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
            CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
            CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
    END
    \$\$;
    GRANT pg_monitor TO monitoring;
EOSQL

echo "✓ OwnDatabase initialization complete (migrations run from control-api)."
