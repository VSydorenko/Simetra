# Оцінка стеку Simetra (станом на 2026-09-29)

## Про цей документ

- **Питання.** Яким має бути стек Simetra: мова ядра, рушій схеми й DDL, мова схем метамоделі, клієнтський рантайм даних, фреймворк UI й оболонки, сервер та інструменти.
- **Дата.** 2026-09-29.
- **Метод.** Дослідження з першоджерел, виконане агентом: версії й дати публікацій взято з npm registry, активність і ліцензії з GitHub API, решту тез із першоджерел (посилання поруч із кожною). Версії й дати перевірено на зазначену дату; перед закріпленням у `package.json` їх треба перевірити повторно.
- **Куди лягли рішення.** Платформна спека `../../superpowers/specs/2026-09-24-simetra-platform-design.md`: §3 (яруси й пакети), §8–§11 (рантайм даних, UI, сервер, інструменти); поіменний вибір бібліотек, ліцензії й межі копіювання коду — `reuse-map-2026-09.md`.
- **Що уточнено пізніше.** pgsql-parser для нормалізації відхилено (канонічна форма — Postgres на тіні; libpg-query лише для гейтів дослівного SQL); PGlite — лише юніт-тести; поіменний вибір бібліотек — [карта перевикористання](reuse-map-2026-09.md).
- **Статус.** Контекст рішень, не правила: чинні правила живуть у спеках.

**Метод.** Версії й дати публікацій взято з npm registry (`npm view …`, перевірено 2026-09-29), активність і ліцензії — з GitHub API, решту тез — із першоджерел, посилання стоять поруч із кожною.

**Вихідна умова.** Робота ядра — це невеликі метадані (десятки чи сотні об'єктів), невеликий DDL-diff і очікування на Postgres. Гарячого шляху з інтенсивним навантаженням на CPU тут немає.

## 1. Мова ядра (T0–T3)

### Прецеденти: хто куди мігрував і чому

| Проєкт | Рух | Причина | Висновок для Simetra |
|---|---|---|---|
| **Prisma** | Rust-двигун → TS + WASM-компілятор запитів (7.0, [2025-11-19](https://www.prisma.io/blog/announcing-prisma-orm-7-0-0)) → повне переписання на TS (8, RC; «Prisma ORM 8 rewrites Prisma ORM in TypeScript», [docs](https://www.prisma.io/docs/orm)) | [Блог 2025-01-30](https://www.prisma.io/blog/from-rust-to-typescript-a-new-chapter-for-prisma-orm): без Rust важко контриб'ютити; дані серіалізуються на межі Rust↔JS; бінарник під кожну ОС і версію OpenSSL; великі бінарники несумісні з edge. Бандл зменшився з ~14 МБ до 1.6 МБ | Інструмент для TS-споживача платить за Rust контриб'юторами, межею між мовами й дистрибуцією |
| **Supabase CLI** | Go → TS, поступово (v2.106.0, [2026-06-11](https://newreleases.io/project/github/supabase/cli/release/v2.106.0)); мовний склад репо тепер переважно TS (GitHub API) | Один стек з екосистемою споживача | Постачальник нашої БД іде з Go в TS |
| **TypeScript** | TS → Go (7.0 GA [2026-07-08](https://www.theregister.com/devops/2026/07/09/speedier-type-checks-in-typescript-70-as-first-stable-go-release-ships/5268828)), прискорення ~10× | Перевірка мільйонів рядків навантажує CPU; програмний API з'явиться лише в 7.1 | Нативна мова виправдана там, де великий обсяг вхідних даних |
| **Turborepo** | Go → Rust ([2024](https://vercel.com/blog/finishing-turborepos-migration-from-go-to-rust)) | Інтероп із C, Windows, типи | Інструмент гарячого шляху, споживач не пише в ньому розширень |
| **Vite / Rolldown / Oxc / Biome** | Rust-бандлер став стандартом: Vite 8 ([2026-03-12](https://vite.dev/blog/announcing-vite8)), Rolldown 1.0 (травень 2026, [VoidZero](https://voidzero.dev/posts/announcing-rolldown-1-0)) | Бандлинг і лінт навантажують CPU; але Oxlint довелося додати JS-плагіни (alpha, [2026-03-11](https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha.html)) | Розширення мусять бути мовою споживача, інакше потрібен міст |
| **esbuild, Atlas, sqlc, pg-schema-diff, pgroll** | Go | Аудиторія поліглотна; sqlc дає плагіни через WASM або процеси ([docs](https://docs.sqlc.dev/en/v1.26.0/guides/plugins.html)) | Споживач Simetra — TS-застосунок, а не поліглот |
| **Drizzle, Payload, Twenty** | TS від БД до UI | — | Метадані-керовані TS-платформи працюють без нативного ядра |
| **Frappe** | Python на всьому стеку, DocType як метадані, хуки тією ж мовою (v16, [січень 2026](https://frappe.io/framework/version-16)) | — | Для ERP-екосистеми розширення пишуться мовою платформи |

**Закономірність.** Нативна мова виграє, коли вхідні дані величезні й обробка навантажує CPU, або коли аудиторія поліглотна. TS виграє, коли споживач пише на TS, точки розширення теж на TS, а робота здебільшого чекає на БД. Simetra належить до другого випадку.

### Порівняння

| Критерій | TypeScript | Rust-ядро + napi-rs/WASM | Go |
|---|---|---|---|
| Одна екосистема з React UI і конфігуратором | Так | Дві мови, дві збірки | Дві мови |
| Спільні типи | Zod як SSOT, `z.infer` напряму в компіляторі, UI і MCP | SSOT — структури Rust, TS-типи й JSON Schema генеруються; або два кодогени | Те саме |
| DX споживача | Vite-плагін, CLI і MCP імпортують API в тому ж процесі, один стектрейс | Бінарники під кожну платформу через optionalDependencies або WASM (napi-rs v3, [2025-07-07](https://napi.rs/blog/announce-v3)) | Бінарник і JSON через stdio (модель esbuild) |
| Продуктивність | Достатня: немає гарячого шляху | Найкраща, але не потрібна | Дуже добра, але не потрібна |
| Пул контриб'юторів | SO 2025: TS 43.6% усіх / 48.8% професіоналів ([survey](https://survey.stackoverflow.co/2025/technology)); TS #1 на GitHub у серпні 2025 ([Octoverse](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)) | Rust 14.8% | Go 16.4% |
| Розширення споживача (SQL-запит рухів, TS-хуки) | Виконуються й перевіряються в тому ж процесі | Потрібен JS-міст (досвід Oxlint) або WASM-плагіни | Процес або WASM (досвід sqlc) |
| Дистрибуція | Лише npm | npm плюс матриця бінарників у CI (біль Prisma) | npm-обгортка над бінарником |

Щодо агентів: на SWE-bench Multilingual у Rust найвищий відсоток розв'язаних задач (58.14%, [swebench.com](https://www.swebench.com/multilingual.html)), але на рівні репозиторію Rust-SWE-bench дає лише 21–28.6% через строгу семантику трейтів ([ICSE 2026, arXiv 2026-02-26](https://arxiv.org/abs/2602.22764)). Мова сама по собі агентам не заважає; вирішальне те, що агент змінює метамодель, компілятор і UI в одній системі типів, з одним tsc і одним vitest.

### Рекомендація
**TypeScript для всіх ярусів T0–T6.** Нативний код допустимий лише як готові WASM-бібліотеки для вузьких задач (парсинг SQL через `pgsql-parser`/`libpg-query` 18.x, MIT). Власного Rust не писати; переглянути лише за наявності виміряного гарячого шляху. Впевненість: висока. Головний ризик: повільна перевірка великих згенерованих типів — знімає нативний TS 7; інструменти, яким потрібен API компілятора, лишаються на TS 6 до 7.1 (репо вже так налаштоване аліасом).

## 2. Рушій схеми й DDL

Вимоги Simetra, яких немає в жодного загального інструмента: намір з метаданих (UUID: перейменування, а не видалення з додаванням); автоматичні фази «розширити → звузити»; RLS-шаблони, тригери й гранти як частина бажаного стану; зворотна генерація для прийому наявної БД.

| Інструмент | Мова / ліцензія | Зворотна генерація | Часткові / виразні індекси | RLS | Тригери / функції | Enum | Кілька схем | Розширити → звузити | Перейменування | API для TS | Стан |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Drizzle Kit** | TS / Apache-2.0 | `pull` | так | так ([docs](https://orm.drizzle.team/docs/rls)) | **ні** ([#2586](https://github.com/drizzle-team/drizzle-orm/discussions/2586)) | так | так | ні | інтерактивно; програмний `generateMigration` без підказок ([#6053](https://github.com/drizzle-team/drizzle-orm/issues/6053)) | `drizzle-kit/api` у v1 RC | 0.31.11, `1.0.0-rc.x` (2026-09-21) |
| **Prisma Migrate** | TS (8) / Apache-2.0 | `db pull` | 7.4 preview ([2026-02-11](https://www.prisma.io/changelog/2026-02-11)); 8 так ([2026-08-02](https://www.prisma.io/changelog/2026-08-02)) | лише 8 | ні, raw SQL | так | так | ні (TS-міграції з пре- і постперевірками, [2026-04-27](https://www.prisma.io/blog/typescript-migrations-in-prisma-next)) | — | прив'язаний до контракту Prisma | 7.x stable, 8 RC |
| **Atlas** | Go / Apache-2.0 CE + пропрієтарний дистрибутив | `inspect` | так | **лише Pro** | **лише Pro** | так | так | ні | — | Go SDK лише в Pro ([CE](https://atlasgo.io/community-edition)) | v1.3.0, 2026-08-02 |
| **pg-schema-diff** (Stripe) | Go / MIT | `dump` | так | так | так / так | лише enum | так | онлайн-операції, без shadow-таблиць | **ні** ([README](https://github.com/stripe/pg-schema-diff)) | лише Go | v1.0.9, 2024-08-06 |
| **sqldef / psqldef** | Go / MIT | `--export`; офлайн file-to-file | так | так | частково ([docs](https://github.com/sqldef/sqldef/blob/master/cmd-psqldef.md)) | так | так | ні | анотація `@renamed` | лише CLI | v3.11.25, 2026-09-29 |
| **pgroll** | Go / Apache-2.0 | ні, власні JSON-операції | так | ні | raw SQL | так | так | **так**, через версійні схеми-в'юхи | через операції | лише CLI | v0.16.3, 2026-09-08 |
| **graphile-migrate** | TS / MIT | ні (раннер SQL) | — | — | — | — | — | ні | — | так | v2.0.0-rc.5, 2026-09-08 |
| **Supabase declarative + pg-delta** | TS / MIT | так (`schema export`, `load(export(db)) ≡ db`) | так | так | так / так | так | так | ні | за каталогом | **так**: `extract` / `plan` / `apply` / `prove` ([README](https://github.com/supabase/pg-toolbelt)) | `1.0.0-alpha.53`, 2026-09-21; типовий рушій нових проєктів `supabase init` ([CLI ref](https://supabase.com/docs/reference/cli/supabase-db-diff)) |

**Висновок.** Жоден інструмент не знає наміру: всі порівнюють за іменами або за каталогом. Єдиний, хто вміє «розширити → звузити», — pgroll, і його версійні в'юхи конфліктують з експозицією PostgREST і з RLS. Atlas не підходить Apache-2.0-платформі.

### Рекомендація
1. Власний планувальник намірів (Р6/Р7). 2. pg-delta як бібліотека для каталожного гейта і прийому: згенерований DDL накочується на тіньову БД, далі `plan` порівнює її з ціллю, `prove` перевіряє результат; pg-delta сам SQL не парсить, увесь стан читає з каталогу справжнього Postgres, тож йому потрібна тіньова БД. 3. Тести: PGlite 0.5.8 для швидких unit-тестів DDL, локальний Supabase для інтеграційних. 4. Нове обмеження Supabase: з 2026-10-30 таблиці без явного GRANT недоступні для Data API на всіх проєктах ([changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)) — збігається з Р14. Ризик: pg-delta — breaking-change alpha, ізолювати за власним інтерфейсом гейта. Запасний варіант: власна інтроспекція `pg_catalog` лише для об'єктів, які генерує Simetra, плюс `pgsql-parser` для нормалізації виразів.

## 3. Мова схем для метамоделі T0

| Бібліотека | Версія / стан | JSON Schema | Дискримінуючі union, рекурсія | Помилки | Нотатки |
|---|---|---|---|---|---|
| **Zod 4** | 4.6.5 (2026-09; 4.0 — 2025-07-09) | Нативний `z.toJSONSchema`: draft-2020-12/07/OpenAPI, `cycles: "ref"`, реєстр у `$defs`, `io: "input"` ([docs](https://zod.dev/json-schema)) | `discriminatedUnion`; рекурсія через геттери | Кастомізація, `prettifyError` | `zod/mini` ~1.88 КБ; MCP server v2 вимагає peer `zod ^4.2.0`; Standard Schema і Standard JSON Schema ([spec](https://standardschema.dev/json-schema)) |
| **Effect Schema** | Effect 4 у RC ([2026-08-12](https://effect.website/blog/releases/effect/40-rc)); latest stable 3.22.2 | так | так | багаті | Вимагає парадигми Effect; API ламався між 3 і 4 |
| **TypeBox** | 1.3.34 (1.0 — 2025-09-09) | Схема і є JSON Schema 2020-12 | так | нижчого рівня | Один мейнтейнер |
| **ArkType** | 2.2.5 (2026-09) | `toJsonSchema` | так | добрі | Спільнота менша |
| **Valibot** | 1.5.0 | через `@valibot/to-json-schema` | так | добрі | Найменший бандл |
| **JSON Schema + кодоген** | — | джерело | обмежено | слабкі | Має сенс лише при Rust/Go-ядрі |

### Рекомендація
**Zod 4.** Схеми метамоделі мають бути JSON-представні (без `transform`/`preprocess` на структурі); інваріанти між об'єктами перевіряють стадії компілятора, а не `refine`; описи в `.meta()`, звідти `metadata.schema.json` для автодоповнення і входів MCP; CI-тест `toJSONSchema(…, { unrepresentable: "throw" })` на кожен вид. Впевненість: висока.

## 4. Клієнтський рантайм даних (T4)

| Варіант | Стан | RLS Supabase | Запис через Postgres-функцію | Генерація з метаданих |
|---|---|---|---|---|
| **TanStack DB** | 0.9.2 (2026-09-14; 0.1 — 2025-07-29). 1.0 обіцяли на грудень 2025 ([блог 0.5](https://tanstack.com/blog/tanstack-db-0.5-query-driven-sync)) і не випустили; персистентність alpha, до v1 лишився SSR ([0.6](https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes)) | Через Query-колекцію й PostgREST | `createOptimisticAction`: `mutationFn` → `supabase.rpc` → `refetch` ([docs](https://github.com/tanstack/db/blob/main/docs/reference/functions/createOptimisticAction.md)) | Так: колекція — конфіг-об'єкт |
| `@supabase-labs/tanstack-db` | Experimental ([repo](https://github.com/supabase/tanstack-db)) | так | так | так; офсетна пагінація може пропустити або продублювати рядок |
| **Electric** | 1.x GA ([2025-03-17](https://electric-sql.com/blog/2025/03/17/electricsql-1.0-released)), Apache-2.0 | **Ні**: RLS до shapes не застосовується, авторизація в проксі ([мейнтейнер](https://github.com/electric-sql/electric/discussions/1587)) | Через ваш API | так |
| **PowerSync** | web 2.4.1; сервіс під FSL-1.1-ALv2 | Sync Streams плюс RLS на запис ([docs](https://docs.powersync.com/integrations/supabase/guide)) | Черга вивантаження → PostgREST або RPC | так |
| **Zero** | 1.0 ([InfoQ 2026-06-08](https://www.infoq.com/news/2026/06/zero-version-1/)), 1.9.0 | Ні: власні дозволи й custom mutators | Мутатори на вашому сервері | Друга модель схеми (ZQL); SSR немає; клієнт 232 КБ gzip |
| **Convex** | 1.46.0, FSL | — | — | Замінює Postgres |
| **Jazz / LiveStore** | Jazz 2.0 alpha; LiveStore 0.4.0 | — | — | CRDT / event sourcing, не Postgres як джерело правди |
| **TanStack Query v5 + Realtime** | стабільний | так | так | так, без live queries між колекціями |

Realtime: Postgres Changes перевіряє доступ кожного підписника на кожну зміну в один потік; понад ~3 тис. одночасних підписників документація Supabase радить Broadcast із БД через тригер `realtime.broadcast_changes` ([docs](https://supabase.com/docs/guides/realtime/postgres-changes)).

### Рекомендація
**TanStack DB за власним фасадом Simetra** (адаптер джерела, Р8): згенерований код звертається до контракту Simetra; типовий адаптер — Query-колекція + PostgREST + інвалідація через Realtime; команди через `createOptimisticAction` → RPC; для бек-офісу SPA-режим. Electric і PowerSync — пізніше як офлайн-адаптери. Впевненість: середня. Ризик: стан 0.x, фіксувати версію. Запасний варіант: TanStack Query + Realtime за тим самим фасадом.

## 5. Фреймворк для UI і оболонки (T5–T6)

| Варіант | Стан | За і проти |
|---|---|---|
| **TanStack Start** | `@tanstack/react-start` 1.168.59 (2026-09-27); документація досі «Release Candidate» (RC з [2025-09-22](https://tanstack.com/blog/announcing-tanstack-start-v1)); SPA-режим зберігає server functions ([docs](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode)); хостинг Cloudflare, Netlify, Railway, Vercel, Nitro; Vite ≥7 або Rsbuild 2; RSC експериментальні | За: на ньому перший споживач; нативна підтримка Vite-плагінів; типобезпечний роутер. Проти: рік у RC |
| **Next.js** | 16.3.7 | Стабільний; орієнтований на RSC, Turbopack — Vite-плагін не працює; клієнтські колекції погано поєднуються з RSC |
| **React Router 8** | 8.4.0 (8.0 — [2026-06-17](https://www.infoq.com/news/2026/08/react-route-v8/)) | Стабільний framework mode на Vite; надійний запасний хост |
| **Remix 3** | RC [2026-08-31](https://remix.run/blog/remix-3-release-candidate) | Відмовляється від React |
| **Vite SPA** | Vite 8.3.1 | Найпростіший; для T3 потрібен окремий сервер (Hono) |

Чи має платформа залежати від фреймворку? Прецеденти: react-admin 5.15.4 — SPA-бібліотека з `routerProvider` ([інтеграція з TanStack Start](https://marmelab.com/react-admin/TanStackStart.html)); Refine 5 — безголове ядро плюс адаптери роутерів, адаптер TanStack Router прибрано через нестабільність API ([discussion](https://github.com/refinedev/refine/discussions/6846)); Payload у 3.0 прив'язав адмінку до Next.js, а у 4.0 будує «framework adapter», першим доказом є TanStack Start ([2026-06-09](https://payloadcms.com/posts/blog/payload-40-admin-ui-redesign-tanstack-mcp-and-more)); Twenty — React + Vite SPA з NestJS.

### Рекомендація
T5 — React-компоненти, незалежні від фреймворку (лише React, контракти T4, інтерфейс адаптера навігації); T6 постачає адаптер на TanStack Router; TanStack Start — лише в шаблоні хоста і в `simetra studio`; для бек-офісу SPA-режим. Запасний варіант: React Router 8 — заміна зводиться до іншого адаптера.

## 6. Сервер (T3)

Кожен запит PostgREST — одна транзакція; volatile RPC працює в режимі read-write, помилка відкочує все ([docs](https://docs.postgrest.org/en/stable/references/transactions.html)). Проведення як Postgres-функція: стан документа, рухи регістрів, контроль залишків (з блокуванням рядків) і номер вміщуються в одну транзакцію; функцію однаково викликають браузер, Server Function, MCP, CLI і тести. Нумерація без пропусків потребує лічильника в тій самій транзакції: `nextval` не повертається при відкаті ([Postgres docs](https://www.postgresql.org/docs/current/functions-sequence.html)). RLS обмежує рядки, `GRANT`/`EXECUTE` — команди; серверний `authorize` лише дублює перевірки для UX і ніколи не буває єдиним бар'єром.

| | Лише Postgres | Лише тонкий Node | Обидва (рекомендовано) |
|---|---|---|---|
| Атомарність інваріантів | так | ручні транзакції, окремий пул | так, у БД |
| Єдина точка для всіх клієнтів | так | лише через сервер | так |
| Інтеграції, секрети, вебхуки, пошта | погано | так | так, у тонкому сервері |
| DX і спостережуваність | PL/pgSQL слабший | добрі | ядро в SQL, оркестрація в TS |
| Тести | pgTAP через `supabase test db` | vitest | обидва ([docs](https://supabase.com/docs/guides/database/testing)) |

### Рекомендація
Обидва шари з жорсткою межею: інваріанти (проведення, скасування проведення, нумерація, контроль залишків) у Postgres-функціях, оболонку генерує компілятор, споживач дописує SQL-запит рухів; тонкий сервер (server functions Start або Hono) — інтеграції, побічні ефекти, self-host-адаптер; один інваріант ніколи не розривається між двома транзакціями. Ризик: версіонування функцій у фазах «розширити → звузити».

## 7. Інструменти

- CLI: citty 0.2.2 (є в прототипі; на ньому `@nuxt/cli`); запасний — commander 15; oclif надто важкий; clipanion застряг у rc.
- MCP: `@modelcontextprotocol/server` 2.x (пакети v2 стабільні, специфікація 2026-07-28, [repo](https://github.com/modelcontextprotocol/typescript-sdk)); peer `zod ^4.2`.
- Vite-плагін: Vite 8 на Rolldown сумісний із плагінним API; плагін запускає компілятор у тому ж процесі, генерує типи й віртуальні модулі, показує діагностику в оверлеї.
- Конфігуратор: React на TanStack Start (Р12), компоненти T5 для прев'ю і план T2 для прев'ю змін.
- Порядок: бібліотечний API компілятора → CLI → Vite-плагін → MCP → конфігуратор. (Примітка архітектора 30.09.2026: остаточний порядок — API → CLI → MCP → Vite-плагін → студія, бо MCP над API компілятора коштує мало, а агент — повноправний користувач.)

## Узгодженість зі спекою (2026-09-24)
Збігається з Р2, Р3, Р6, Р8, Р12, Р14 і з уже відхиленими Drizzle та pgroll. Нові факти після дати спеки: Supabase вимагатиме явні гранти з 2026-10-30; TanStack Start досі в RC; pg-delta став типовим рушієм diff для нових проєктів Supabase; MCP SDK v2 стабільний.

**Рекомендований стек (одна таблиця)**

| Шар | Вибір | Якщо не спрацює |
|---|---|---|
| Мова T0–T6 | TypeScript (TS 7 для tsc) | WASM-бібліотеки для вузьких задач |
| Метамодель T0 | Zod 4 + toJSONSchema + .meta() | TypeBox 1.x |
| Рушій схеми T2 | Планувальник намірів над каталожним diff-двигуном за портом | — |
| Каталожний гейт і прийом | `@supabase/pg-delta` як бібліотека за власним інтерфейсом | Власна інтроспекція pg_catalog лише для згенерованих об'єктів |
| Тести БД | PGlite (unit) + локальний Supabase + pgTAP | Лише локальний Supabase |
| Сервер T3 | Postgres-функції для інваріантів, RLS, явні гранти; тонкий сервер для інтеграцій | Hono |
| Дані T4 | TanStack DB за фасадом, адаптер PostgREST + Realtime | TanStack Query + Realtime; Electric або PowerSync для офлайну |
| UI T5 | React-компоненти без залежності від фреймворку + адаптер навігації | — |
| Оболонка і хост T6 | Адаптер TanStack Router; хост на TanStack Start у SPA-режимі | React Router 8 |
| CLI | citty | commander 15 |
| MCP | `@modelcontextprotocol/server` v2 | SDK 1.x |
| Dev-цикл | Vite 8-плагін компілятора | Режим watch у CLI |
| Конфігуратор | `simetra studio` на TanStack Start | React Router 8 |
