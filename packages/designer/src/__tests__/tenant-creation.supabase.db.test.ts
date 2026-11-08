import { describe } from "vitest"

import {
  parallelCases,
  POOLER_PORT,
  throughCases,
  heldTargets,
} from "./tenant-creation.support"

/**
 * Створення тенанта через `runtime.run` і пулер Supavisor у режимі
 * транзакцій: пулер міняє серверне з'єднання між командами (спека П4 §7.3).
 * Ті самі кейси, що й прямим портом у `tenant-creation.db.test.ts`; спільна
 * підготовка — `tenant-creation.support.ts`.
 */

describe("tenant creation through runtime.run", () => {
  const target = heldTargets(true)

  describe.each([POOLER_PORT])("through %s", (_, port) => {
    throughCases(target, port)
  })

  // Чутливий до часу й чужих сесій сценарій — окремо й послідовно
  describe.each([POOLER_PORT])(
    "parallel tenant creation through %s",
    (_, port) => {
      parallelCases(target, port)
    }
  )
})
