#!/bin/zsh
# Runs schema.sql, the later migrations and rls.sql on a throwaway local PostgreSQL (Homebrew), with a tiny stand-in for Supabase's auth schema.
# No network: the server listens only on a Unix socket in a temp folder, and is stopped and deleted at the end.
# Usage, from the project root: zsh supabase/tests/run-local.sh [schema file, default supabase/schema.sql]
set -euo pipefail
export LC_ALL=C # macOS: without a valid locale the postmaster refuses to start ("became multithreaded")
dir=$(mktemp -d)
trap 'pg_ctl -D "$dir/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
initdb -D "$dir/db" -A trust >/dev/null
pg_ctl -D "$dir/db" -o "-c listen_addresses='' -k $dir" -l "$dir/log" -w start >/dev/null
run() { psql -h "$dir" -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

# Stand-in for what Supabase provides: roles, auth.users, auth.uid()/auth.jwt(), and pg_cron's cron.schedule.
run <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key, aud text, role text, is_anonymous boolean not null default false,
                         created_at timestamptz not null default now());
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant usage on schema auth, public to anon, authenticated;
create schema cron;
create function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
SQL

grep -v "create extension if not exists pg_cron" "${1:-supabase/schema.sql}" | run
# Migrations applied after schema.sql, as on the live project. Older ones are already folded into schema.sql.
for m in 20261118120000_timezone_slots_notifications 20261119120000_30_minute_grid; do
  run -o /dev/null -f "supabase/migrations/$m.sql"
done
run -o /dev/null -f supabase/tests/rls.sql
echo "RLS checks passed"
