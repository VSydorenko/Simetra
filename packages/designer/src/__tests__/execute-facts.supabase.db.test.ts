import { vi } from "vitest"
import { seam } from "./execute-facts.seam"
import { describeExecuteFacts } from "./execute-facts.support"

// Шов: дія тесту виконується в транзакції `introspect` перед читанням фактів
vi.mock("../schema-engine/execute-facts", async (original) => {
  const real = await original<typeof import("../schema-engine/execute-facts")>()
  return {
    ...real,
    readExecuteFacts: async (
      ...args: Parameters<typeof real.readExecuteFacts>
    ) => {
      await seam.beforeFacts?.()
      return real.readExecuteFacts(...args)
    },
  }
})

/** Ті самі вимоги на стеку Supabase: ролі профілю — `authenticated`, `anon`, `service_role`. */
describeExecuteFacts()
