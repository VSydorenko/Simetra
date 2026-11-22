import { afterAll, beforeAll } from "vitest"
import { defineReconcileCases } from "./storage-reconcile.cases"
import {
  ORG_ROOT_CASCADE,
  heldStorageEnv,
  type Env,
} from "./storage-env.support"

/** Звірка бакета з базою на Postgres і Garage (ПГ-5, І10, І12); кейси — `storage-reconcile.cases.ts`. */
const target = heldStorageEnv(ORG_ROOT_CASCADE)
let env: Env
beforeAll(async () => {
  env = await target.open()
}, 180_000)
afterAll(() => target.close(), 60_000)

defineReconcileCases(() => env)
