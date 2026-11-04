import { createServerFn } from "@tanstack/react-start"
import { getTableConfig } from "drizzle-orm/pg-core"
import { REGISTRY } from "./registry"

export const getSynth = createServerFn({ method: "GET" }).handler(() => {
  const config = getTableConfig(REGISTRY.probeItems)
  return {
    source: "synthetic-registry",
    table: config.name,
    columns: config.columns.map((c) => c.name),
  }
})
