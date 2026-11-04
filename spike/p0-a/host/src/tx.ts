import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { readAfterLog, runCommandProbe } from "./db.server"

const probeInput = z.object({
  user: z.string(),
  org: z.string(),
  delay: z.number().optional(),
  after: z.number().optional(),
})

// Серверні функції host-а для кроку 8; тіло — у `db.server.ts`, щоб пул і
// драйвер не потрапили в клієнтський граф.
export const runProbe = createServerFn({ method: "GET" })
  .validator((input: z.input<typeof probeInput>) => probeInput.parse(input))
  .handler(({ data }) => runCommandProbe(data))

export const afterLog = createServerFn({ method: "GET" }).handler(() =>
  readAfterLog()
)
