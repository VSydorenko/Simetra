import { afterAll, vi } from "vitest"
import { expectNoLeftoverShadows } from "./shadows"

/**
 * setupFile DB-проєкту designer: тіні двигуна несуть тег прогону, а їхні
 * провізії записує облік файлу (`./shadows`).
 *
 * Обгортка `provisionCoLocatedShadow` — прохідна: додає лише `uniqueSuffix`
 * з тегом, коли викликач свого не дав, і записує ім'я тіні; решта аргументів
 * і поведінка pg-delta не змінюються. Чому не опція `ShadowOptions`
 * адаптера: тег прогону — турбота тестів (прибиральник упізнає за ним свої
 * бази), і в публічний API адаптера вона не йде. Це єдине місце в репо, де
 * pg-delta обгорнуто; другий `vi.mock` того самого модуля в тестовому файлі
 * конфліктував би з цим.
 */
vi.mock("@supabase/pg-delta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/pg-delta")>()
  // Імпорти — усередині фабрики: `vi.mock` піднімається над статичними
  // імпортами файлу
  const { recordProvision } = await import("./shadows")
  const { shadowSuffix } = await import("../../../../simetra/test/support")
  return {
    ...actual,
    provisionCoLocatedShadow: (
      url: string,
      opts?: Parameters<typeof actual.provisionCoLocatedShadow>[1]
    ) =>
      recordProvision(
        actual.provisionCoLocatedShadow(url, {
          ...opts,
          uniqueSuffix: opts?.uniqueSuffix ?? shadowSuffix(),
        })
      ),
  }
})

// Після кожного файлу, а не після кожного тесту: у файлі з конкурентними
// тестами живі тіні сусідніх тестів дали б `afterEach` хибну тривогу
afterAll(expectNoLeftoverShadows)
