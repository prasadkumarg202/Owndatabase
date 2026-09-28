# OwnDatabase — PostgreSQL 16 with pgBackRest
#
# Used by both the `postgres` service (archive_command = pgbackrest archive-push)
# and the `pgbackrest` sidecar (stanza, scheduled backups, restore).
#
# Alpine's pgbackrest package depends on a whole PostgreSQL 18 server, so it is
# installed in a throwaway stage and only the binary is copied across. Its libpq
# dependency is satisfied by the image's own PostgreSQL 16 libpq.

FROM postgres:16-alpine AS pgbackrest
RUN apk add --no-cache pgbackrest

FROM postgres:16-alpine
RUN apk add --no-cache jq libbz2 libssh2 libxml2 lz4-libs zstd-libs
COPY --from=pgbackrest /usr/bin/pgbackrest /usr/bin/pgbackrest
RUN mkdir -p /var/log/pgbackrest /var/spool/pgbackrest /var/lib/pgbackrest /tmp/pgbackrest \
    && chown -R postgres:postgres /var/log/pgbackrest /var/spool/pgbackrest /var/lib/pgbackrest /tmp/pgbackrest \
    && su-exec postgres pgbackrest version
