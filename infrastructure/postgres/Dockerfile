# OwnDatabase — PostgreSQL 16 with PostGIS, pgvector and pgBackRest
#
# Used by both the `postgres` service (archive_command = pgbackrest archive-push)
# and the `pgbackrest` sidecar (stanza, scheduled backups, restore).
#
# Base: the official postgis/postgis image, which is postgres:16-alpine plus
# PostGIS (same PostgreSQL build, uid 70 and data layout, so existing data
# volumes keep working).
ARG PG_IMAGE=postgis/postgis:16-3.5-alpine
ARG PGVECTOR_VERSION=v0.8.6

# pgvector, compiled against this exact PostgreSQL. OPTFLAGS="" avoids
# -march=native so the image runs on any x86-64 CPU; with_llvm=no skips JIT
# bitcode (clang/llvm are not in the image).
FROM ${PG_IMAGE} AS pgvector
ARG PGVECTOR_VERSION
RUN apk add --no-cache --virtual .build build-base git \
    && git clone --depth 1 --branch ${PGVECTOR_VERSION} https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && cd /tmp/pgvector \
    && make with_llvm=no OPTFLAGS="" \
    && make with_llvm=no install DESTDIR=/out

# Alpine's pgbackrest package depends on a whole PostgreSQL 18 server, so it is
# installed in a throwaway stage and only the binary is copied across. Its libpq
# dependency is satisfied by the image's own PostgreSQL 16 libpq.
FROM postgres:16-alpine AS pgbackrest
RUN apk add --no-cache pgbackrest

FROM ${PG_IMAGE}
RUN apk add --no-cache jq libbz2 libssh2 libxml2 lz4-libs zstd-libs
COPY --from=pgvector /out/usr/local/ /usr/local/
COPY --from=pgbackrest /usr/bin/pgbackrest /usr/bin/pgbackrest
RUN mkdir -p /var/log/pgbackrest /var/spool/pgbackrest /var/lib/pgbackrest /tmp/pgbackrest \
    && chown -R postgres:postgres /var/log/pgbackrest /var/spool/pgbackrest /var/lib/pgbackrest /tmp/pgbackrest \
    && su-exec postgres pgbackrest version \
    && test -f /usr/local/share/postgresql/extension/vector.control \
    && test -f /usr/local/share/postgresql/extension/postgis.control
