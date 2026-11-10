# Моніторинг залежностей

Тут записано, де Simetra обходить, закріплює чи стереже поведінку сторонньої
залежності: дефект і наш обхід, upstream-issue, умова зняття обходу й що
звіряти на оновленні. Правило піна й портів — [CONTRIBUTING](../CONTRIBUTING.md)
§ "Dependencies"; тут — лише живі особливості.

Востаннє звірено: 2026-11-04.

## Як користуватися

**Моніторинг issue.** Для кожного запису з upstream-issue перевіряйте
відповіді й статус. 🔴 Статус issue — не доказ фікса: обхід знімають лише
тоді, коли червоніє його контрольний тест на новій версії, а не тоді, коли
issue закрили.

**Оновлення пакета** — це підняти версію плюс ревізія дельти:

1. Базова лінія до змін: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`
   і `pnpm test:db` — інакше не відрізнити «зламало оновлення» від «було зламано».
2. Прочитати дельту, не всю історію: журнал змін у встановленому пакеті →
   GitHub Releases → diff `.d.ts` між версіями.
3. Звірити кожен запис цього файлу для пакета: що перевірити, чи не
   почервонів контрольний тест, чи не змінився розпізнаваний текст.
4. Окремо шукати мовчазні ламання: нові чи зниклі пакети в diff
   `pnpm-lock.yaml`, `deprecat|will be removed` у виводі тестів.
5. Кандидат зі змін реліз-нот приймається лише з конкретним місцем у нашому
   коді; запис тут оновлюється тим самим комітом.

## pg-delta — двигун схеми

Альфа, точний пін у `packages/designer/package.json`, лише за портом
`SchemaEngine` (`packages/simetra/src/schema/engine/port.ts`); адаптер —
`packages/designer/src/schema-engine/pg-delta/`. Пакет не патчимо (ні
`pnpm patch`, ні копії коду).

### Порядок колонок у плані з порожньої бази

- **Дефект.** Колонку, DEFAULT якої викликає функцію користувача, двигун
  додає окремим `ADD COLUMN` після решти колонок таблиці: Postgres виконує
  функцію під час додавання, а вона може читати пізнішу колонку. Копія доказу
  тоді має інший порядок колонок, ніж ціль. Згенеровану колонку й колонку
  типу, створеного тим самим планом, двигун з 1.0.0-alpha.60 тримає на місці
  сам.
- **Upstream:** [supabase/pg-toolbelt#518](https://github.com/supabase/pg-toolbelt/issues/518)
  (наш коментар з аналізом планувальника —
  [#518, коментар](https://github.com/supabase/pg-toolbelt/issues/518#issuecomment-6246926553));
  реліз-ноти alpha.60 називають цей випадок невиправленим навмисно.
- **Обхід.** `withColumnOrder` (`pg-delta/column-order.ts`) додає ребра
  `c[k+1] → c[k]` між сусідніми колонками лише тих нових таблиць, де DEFAULT
  якоїсь колонки залежить від функції; `cloneAndRun` (`pg-delta/adapter.ts`)
  планує копію над ними. Таблиця, де ребра дали б цикл (посилання вперед,
  DEFAULT чи CHECK домену з функцією, що читає пізнішу колонку, перехресні
  нові таблиці), ребер не дістає — чесний `plan.clone-mismatch`.
- **Умова зняття.** Контрольні тести двигуна
  `the engine alone orders …` (`packages/designer/src/schema-engine/__tests__/column-order.test.ts`)
  фіксують, що двигун робить сам для кожного випадку обходу. Коли рядок
  «DEFAULT calls a user function» почервоніє (двигун тримає порядок),
  прибрати `withColumnOrder` разом із тестами. Почервонілий інший рядок
  означає регресію двигуна — тоді розширити звуження.

### Ідентичність версії двигуна

- `IDENTITY.version` у `pg-delta/adapter.ts` записана вручну: пакет не
  експортує свій `package.json`, а його `ENGINE_VERSION` — версія формату плану.
  Те саме значення — у тестах, що пінять ідентичність артефакту.
- **На оновленні:** спершу змінити `IDENTITY.version`, потім тести.
  Рівність встановленому пакету тримає `engine-identity.test.ts`.

### Стережі, що навмисно червоніють на зміні двигуна

- **Керування транзакцією витягу.** Двигун відкриває `BEGIN` і ставить
  `SET LOCAL search_path = pg_catalog`; `savepoint-pool.ts` перетворює це на
  `SAVEPOINT` і робить `ROLLBACK TO` + `RELEASE`. Тест «rewrites exactly the
  engine's control statements» (`savepoint-extract.db.test.ts`) пінить
  послідовність операторів поточної версії: зміна — через архітектора.
- **`search_path` витягу.** `routine-volatility.ts` дублює
  `SEARCH_PATH_STATEMENT` двигуна (пакет його не експортує) і покладається на
  те, що `pg_get_functiondef` не друкує `VOLATILE`. Звірити обидва.
- **Порожній `search_path` дефініцій** (`map-definitions.ts`): ціль поза
  `pg_catalog` завжди кваліфікована.
- **Невідомі властивості.** Невідомий ключ payload у мапері — гучна помилка
  (`map-tables.ts`); партиції (`partitionKey`, `partitionBound`, індекс-партиція)
  — `engine.unrepresentable`.
- **Повнота контракту.** Таблиці фактів і ребер (`census-facts.ts`,
  `fingerprint-coverage.ts`) — новий вид факту чи ребра ламає typecheck або
  DB-тест на багатому каталозі; невідомий `SET` у преамбулі —
  `engine.preamble-unknown` (`ENGINE_PREAMBLE_ALLOWED`, `port.ts`); переліки
  ролей, схем і розширень провайдера (`schema/engine/provider/supabase.ts`)
  тримає контрактний тест адаптера.
- **Тінь.** Лише тієї самої мажорної версії сервера
  (`ShadowServerMismatchError`): двигун читає каталог версійно залежними
  запитами.

### Під наглядом

- Помітна частка часу плану — CPU двигуна на повних витягах каталогу
  (кандидат — борг П3-2b §3).

## `libpg-query` і `@libpg-query/parser` — парсер SQL

Точні піни в `packages/simetra/package.json`; мажор 17 = Postgres 17.
`loadSqlParser` (`packages/simetra/src/compiler/sql/parse.ts`) кешує
ініціалізацію WASM, невдалу — ні. Порожній текст парсер відхиляє винятком без
деталей; зміщення — індекси UTF-16. `@libpg-query/parser` дає
`parsePlPgSQL` (`packages/simetra/src/compiler/sql/plpgsql.ts`), якого
`libpg-query` 17 не має; з мажором 18 обидва API — в одному пакеті. Мажор 18 —
граматика Postgres 18: оновлюється разом із мажором сервера, а не окремо
(борг — `docs/superpowers/plans/2026-10-30-archive-residual-debt.md`).
⚠️ Звірити розбіжність версії з картою перевикористання
(`docs/research/stack/reuse-map-2026-09.md`).

## TypeScript 7 і typescript-eslint

`tsc` — TypeScript 7 (нативний, пакет `@typescript/native`); пакет `typescript`
— аліас на TypeScript 6, бо typescript-eslint потребує JS API TS 6. Умова
зняття аліаса: мажор typescript-eslint, що працює з JS API TS 7.

## `better-auth` і `kysely` — тестові залежності

Лише `devDependencies` пакета `simetra`, точні піни (`better-auth` 1.7.12,
`kysely` — найновіша версія в межах `^0.28.17 || ^0.29`, опублікована щонайменше
за 14 днів до піна). Потрібні DB-тестам стека `postgres`: хелпер
`packages/simetra/test/db/better-auth.ts` запускає міграцію Better Auth, щоб
перевірити колонки джерела подій `better_auth.user`. Оновлюються разом.
Production-джерела їх не імпортують (лінт-зони `packages/simetra/eslint.tier-zones.js`
і `packages/designer/eslint.zones.js`) і тарболи не оголошують (гейт пакування).
Міграція йде без `schemaName`: з ним Better Auth шле `CREATE SCHEMA IF NOT EXISTS`,
а Postgres перевіряє `CREATE` на базі раніше за `IF NOT EXISTS`. На оновленні —
звірити `getMigrations`, порядок колонок `user` з `PROVIDER_EVENT_SOURCES.postgres`
і поведінку `search_path`.

## Драйвер `pg`

`TRANSPORT_MESSAGE` (`packages/designer/src/schema-engine/apply-database.ts`)
розпізнає транспортні збої за текстом помилки драйвера. На оновленні `pg` —
звірити тексти.

## Supabase CLI і локальний стек

CLI — точний пін у кореневому `package.json`, лише через `pnpm db:*`; Postgres
мажор 17 (`supabase/config.toml`); пулер у transaction-режимі. Оновлення образу
стека стереже `provider-event-sources.supabase.db.test.ts`: колонки джерел подій
провайдера звіряються з образом. Новий пін CLI тягне інші образи, тобто
перезапуск спільного стека для всіх сесій: його оновлюють лише у
погодженому вікні перезапуску.

## Під наглядом до П4: OAuth-сервер Supabase (beta)

Кандидат на двері агентів адаптера Supabase (спека системної схеми й
користувачів §12, рядок «Двері агентів»). Стан за кодом репозиторію Supabase Auth
(гілка master, 2026-09-22): DCR є, CIMD немає
([supabase/auth#2850](https://github.com/supabase/auth/issues/2850)); скоупи
фіксовані, власних немає; `aud` завжди `authenticated`, параметр `resource`
(RFC 8707) ігнорується ([supabase/auth#2610](https://github.com/supabase/auth/issues/2610));
вибір контексту на згоді в токен не потрапляє; custom access token hook на
OAuth-токенах працює; клієнт ChatGPT отримує 400 на `getAuthorizationDetails`
([supabase/auth#2820](https://github.com/supabase/auth/issues/2820)).
Звірити перед планом дверей агентів у П4.
