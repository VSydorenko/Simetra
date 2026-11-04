// Portions copied from simplyCMS (https://github.com/simplyCMS/simplyCMS, packages/create-simplycms-store/template/routes.ts)
// Copyright (c) 2026 simplyCMS
// Licensed under MIT. Modified: one stub package, variant chosen by env, host routes for the transaction probe.
import { realpathSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { physical, rootRoute, route } from "@tanstack/virtual-file-routes"

const HOST_ROOT = dirname(fileURLToPath(import.meta.url))
const ROUTES_DIR = resolve(HOST_ROOT, "src/routes")
const variant = process.env.SPIKE_VARIANT ?? "ours"

// TanStack Router #4984: генератор має бачити той самий шлях, що й Vite
// (через `.pnpm/`), інакше маршрути пакета не розбиваються на чанки.
const packageRoutes = (sub: string) =>
  relative(
    ROUTES_DIR,
    join(
      realpathSync(
        resolve(HOST_ROOT, "node_modules/@simetra-spike/p0a-stub/routes")
      ),
      sub
    )
  )

// Маршрути кроку 8 тягнуть `simetra/server` і `pg`; у варіанті форми репорту
// їх немає, щоб граф серверної функції лишався синтетичним.
export const routes = rootRoute("__root.tsx", [
  physical("", packageRoutes(variant)),
  ...(variant === "ours"
    ? [route("/tx", "tx.tsx"), route("/after", "after.tsx")]
    : []),
])
