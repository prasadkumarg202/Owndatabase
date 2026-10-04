#!/usr/bin/env python3
"""Converts a Supabase database dump (supabase db dump: schema.sql + data.sql) into SQL for an
OwnDatabase project (docs/import-supabase.md).

    python scripts/import-supabase.py --schema schema.sql --data data.sql \
        --target-schema project_ev2ev --project-id <uuid> --out out/

Writes, in --out:
  1_schema.sql          the app's own objects from Supabase's `public` schema (types, tables, functions,
                        constraints, indexes, triggers, RLS policies, grants to anon / authenticated /
                        service_role), moved into the project's schema. Run as the project's owner role.
  2_data.sql            the rows of those tables (COPY), run as a superuser with replication role
                        (foreign keys and triggers are not re-checked while loading).
  3_auth_triggers.sql   Supabase triggers on auth.users (e.g. on_auth_user_created → handle_new_user),
                        re-created on OwnDatabase's shared auth.users limited to this project's users.
  report.txt            what was kept, rewritten and left out.

Left out on purpose: roles.sql, Supabase's own schemas (auth, storage, realtime, vault, graphql, net,
supabase_*), extensions (enable them in the dashboard), event triggers, publications, default privileges
and grants to Supabase's internal roles.
"""
import argparse
import os
import re
import sys
from collections import Counter

HEADER = re.compile(r"^-- Name: (?P<name>.*?); Type: (?P<type>[A-Z ]+); Schema: (?P<schema>[^;]+); Owner: ?(?P<owner>.*)$")
APP_ROLES = {"anon", "authenticated", "service_role", "public"}


def blocks(sql: str):
    """pg_dump's plain format: each object starts with '--\\n-- Name: ...; Type: ...; Schema: ...'."""
    lines = sql.splitlines(keepends=True)
    cur = {"header": None, "lines": []}
    out = [cur]
    i = 0
    while i < len(lines):
        if lines[i].startswith("-- Name: ") and HEADER.match(lines[i].rstrip("\n")):
            m = HEADER.match(lines[i].rstrip("\n"))
            # drop the '--' line that opened this header from the previous block
            if cur["lines"] and cur["lines"][-1].strip() == "--":
                cur["lines"].pop()
            cur = {"header": m.groupdict(), "lines": []}
            out.append(cur)
        else:
            cur["lines"].append(lines[i])
        i += 1
    return out


def rewrite(text: str, target: str) -> str:
    """public.x → <target>.x and extensions.x → public.x (where OwnDatabase installs extensions)."""
    ph = "\x00EXT\x00"
    text = re.sub(r'(?<![\w."])"?extensions"?\.', ph, text)
    text = re.sub(r'(?<![\w."])"public"\.', f'"{target}".', text)
    text = re.sub(r"(?<![\w.\"])public\.", f"{target}.", text)
    text = text.replace(ph, "public.")

    # search_path settings name schemas without a dot
    def sp(m):
        s = m.group(0)
        s = re.sub(r"(?<![\w])'?public'?(?![\w])", lambda x: x.group(0).replace("public", target), s)
        s = re.sub(r"(?<![\w])'?extensions'?(?![\w])", lambda x: x.group(0).replace("extensions", "public"), s)
        # extensions live in public: keep it on the path
        if not re.search(r"(?<![\w])'?public'?(?![\w])", s.split("search_path", 1)[1]):
            s = s.rstrip() + (", 'public'" if "'" in s else ", public")
        return s
    text = re.sub(r"(?i)search_path\s*(?:TO|=)\s*[^;\n]*", sp, text)
    return text


def filter_acl(body: str, report: Counter) -> str:
    out = []
    for line in body.splitlines(keepends=True):
        m = re.match(r"^(GRANT|REVOKE)\b.*\b(TO|FROM)\s+(.+?);\s*$", line.strip())
        if m:
            roles = {r.strip().strip('"').lower() for r in m.group(3).split(",")}
            if roles <= APP_ROLES:
                out.append(line)
            else:
                report["grant to Supabase role skipped"] += 1
            continue
        out.append(line)
    return "".join(out)


def convert_schema(sql: str, target: str, project_id: str, report: Counter, notes: list):
    keep, auth_triggers = [], []
    for b in blocks(sql):
        h = b["header"]
        body = "".join(b["lines"])
        if h is None:
            continue  # preamble (SET ..., \restrict)
        schema, typ = h["schema"].strip(), h["type"].strip()
        if schema == "public":
            if typ in ("DEFAULT ACL",):
                report[f"public {typ} skipped"] += 1
                continue
            if typ == "SCHEMA" or typ == "EXTENSION":
                continue
            body = re.sub(r"(?m)^ALTER [A-Z ]+ .* OWNER TO .*;\n", "", body)
            if typ == "ACL":
                body = filter_acl(body, report)
            keep.append(f"-- {typ}: {h['name']}\n" + rewrite(body, target))
            report[f"public {typ}"] += 1
        elif schema == "auth" and typ == "TRIGGER":
            m = re.search(r"CREATE TRIGGER (\w+) (.*?) ON auth\.users (FOR EACH ROW) (?:WHEN \((.*?)\) )?EXECUTE (?:FUNCTION|PROCEDURE) public\.(\w+)\(\);", body, re.S)
            if not m:
                notes.append(f"auth trigger not converted: {h['name']}")
                continue
            name, timing, each, when, fn = m.groups()
            cond = f"NEW.project_id = '{project_id}'" + (f" AND ({when})" if when else "")
            tname = f"odb_{project_id.replace('-', '')[:12]}_{name}"[:63]
            auth_triggers.append(
                f"DROP TRIGGER IF EXISTS {tname} ON auth.users;\n"
                f"CREATE TRIGGER {tname} {timing} ON auth.users {each} WHEN ({cond}) EXECUTE FUNCTION \"{target}\".{fn}();\n")
            report["auth trigger converted"] += 1
        else:
            report[f"{schema} {typ} skipped"] += 1
    head = (f"-- Supabase schema converted for OwnDatabase ({target}). Run as the project's owner role.\n"
            f"SET check_function_bodies = false;\nSET client_min_messages = warning;\n"
            f"SET search_path = \"{target}\", public;\n\n")
    return head + "\n".join(keep), "".join(auth_triggers)


def convert_data(sql: str, target: str, report: Counter):
    out = [f"-- Supabase data converted for OwnDatabase ({target}). Run as a superuser.\n",
           "SET session_replication_role = replica;\nSET client_min_messages = warning;\n\n"]
    lines = sql.splitlines(keepends=True)
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r'^COPY "?(\w+)"?\."?(\w+)"? (\(.*\)) FROM stdin;', line)
        if m:
            schema, table, cols = m.groups()
            j = i + 1
            while j < len(lines) and lines[j].rstrip("\n") != "\\.":
                j += 1
            if schema == "public":
                out.append(f'COPY "{target}"."{table}" {cols} FROM stdin;\n')
                out.extend(lines[i + 1:j + 1])
                out.append("\n")
                report[f"rows {table}"] = j - i - 1
            else:
                report[f"data {schema}.{table} skipped"] += 1
            i = j + 1
            continue
        m = re.match(r"^SELECT pg_catalog\.setval\('(\w+)\.([\w\"]+)', (.*)\);", line)
        if m and m.group(1) == "public":
            out.append(f"SELECT pg_catalog.setval('\"{target}\".{m.group(2)}', {m.group(3)});\n")
        i += 1
    out.append("SET session_replication_role = origin;\n")
    return "".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--schema", required=True)
    ap.add_argument("--data")
    ap.add_argument("--target-schema", required=True)
    ap.add_argument("--project-id", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if not re.fullmatch(r"project_[a-z0-9_]+", a.target_schema):
        sys.exit("--target-schema must be the project's schema, e.g. project_ev2ev")
    if not re.fullmatch(r"[0-9a-f-]{36}", a.project_id):
        sys.exit("--project-id must be the project's UUID")
    os.makedirs(a.out, exist_ok=True)
    report, notes = Counter(), []
    schema_sql, triggers = convert_schema(open(a.schema, encoding="utf-8").read(), a.target_schema, a.project_id, report, notes)
    open(os.path.join(a.out, "1_schema.sql"), "w", encoding="utf-8", newline="\n").write(schema_sql)
    open(os.path.join(a.out, "3_auth_triggers.sql"), "w", encoding="utf-8", newline="\n").write(triggers)
    if a.data:
        data_sql = convert_data(open(a.data, encoding="utf-8").read(), a.target_schema, report)
        open(os.path.join(a.out, "2_data.sql"), "w", encoding="utf-8", newline="\n").write(data_sql)
    exts = re.findall(r"CREATE EXTENSION IF NOT EXISTS \"?([\w-]+)\"?", open(a.schema, encoding="utf-8").read())
    lines = [f"{k}: {v}" for k, v in sorted(report.items())] + [f"note: {n}" for n in notes]
    lines.append("extensions used by the source (enable the ones you need in the dashboard): " + ", ".join(sorted(set(exts))))
    open(os.path.join(a.out, "report.txt"), "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
