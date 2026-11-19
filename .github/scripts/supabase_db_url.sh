#!/usr/bin/env bash
# Prints a Postgres URL for the Supabase project (session pooler, which GitHub runners
# can reach over IPv4). Needs SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SUPABASE_DB_PASSWORD.
set -euo pipefail
for v in SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF SUPABASE_DB_PASSWORD; do
  if [ -z "${!v:-}" ]; then echo "The $v secret is missing (Settings > Secrets and variables > Actions)." >&2; exit 1; fi
done
json=$(curl -sSf --max-time 30 -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/database/pooler")
host=$(printf '%s' "$json" | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d if isinstance(d,list) else [d]; print(next(x["db_host"] for x in d if x.get("db_host")))')
pass=$(python3 -c 'import os,urllib.parse; print(urllib.parse.quote(os.environ["SUPABASE_DB_PASSWORD"], safe=""))')
echo "postgresql://postgres.$SUPABASE_PROJECT_REF:$pass@$host:5432/postgres?sslmode=require"
