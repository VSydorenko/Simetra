import { createServerFn } from "@tanstack/react-start"
import { KIND_REGISTRY, runtimeCatalogSchema } from "simetra/model"
import { createCommandRuntime } from "simetra/server"

// Форма тригера #8139 на нашому графі: модуль серверної функції на верхньому
// рівні тягне справжні `simetra/model` (реєстр видів, Zod-схеми) і
// `simetra/server` з tarball-а, а `createServerFn` викликається тут же.
const KINDS = Object.keys(KIND_REGISTRY).sort()

export const getOurs = createServerFn({ method: "GET" }).handler(() => ({
  source: "simetra/model",
  kinds: KINDS,
  catalogSchema: typeof runtimeCatalogSchema.parse,
  runtimeFactory: typeof createCommandRuntime,
}))
