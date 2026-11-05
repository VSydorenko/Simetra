#!/usr/bin/env bash
# Повне відтворення спайку П0 (г) на власному стеку (supabase start уже виконано).
set -euo pipefail
cd "$(dirname "$0")"
sb=../../node_modules/.bin/supabase
$sb db reset --workdir . >/dev/null 2>&1
./node_modules/.bin/tsc -p tsconfig.json --noEmit && echo "PROBE1 OK (tsc)"
./node_modules/.bin/tsx src/probe2-signal.ts | grep 'PROBE2'
./node_modules/.bin/tsx src/probe3-sync.ts | grep -A8 'PROBE3'
