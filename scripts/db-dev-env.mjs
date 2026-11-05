// Засів ознаки бази розробника на локальному стеку (`supabase/dev-environment.sql`).
// Через `docker exec` під `supabase_admin`, бо ставить її лише суперкористувач,
// а в образі стеку `local all supabase_admin trust`. Без залежностей: `db:start`
// кличе його одразу після `supabase start`, зокрема в CI.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const config = readFileSync(join(root, "supabase/config.toml"), "utf8")
const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1]
if (projectId === undefined) {
  console.error(
    "db:dev-env failed: project_id not found in supabase/config.toml"
  )
  process.exit(1)
}

const result = spawnSync(
  "docker",
  [
    "exec",
    "-i",
    `supabase_db_${projectId}`,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "supabase_admin",
    "-d",
    "postgres",
    "-f",
    "-",
  ],
  {
    input: readFileSync(join(root, "supabase/dev-environment.sql")),
    stdio: ["pipe", "inherit", "inherit"],
  }
)
if (result.error !== undefined) {
  console.error(`db:dev-env failed: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(
    `db:dev-env failed: docker exec exited with ${result.status ?? result.signal}`
  )
  process.exit(result.status ?? 1)
}
