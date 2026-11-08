# ПГ-2a — провайдер `postgres` у схемному рушії: план реалізації

> **Статус:** проєкт плану, 2026-11-08; приймає архітекторка
> `runtime-client-data`. Блок ПГ-2 поділено: 2a (цей план) — провайдер у
> T0, T2 і `simetra roles`; 2b
> ([план ПГ-2b](2026-11-08-pg-2b-tests-on-postgres.md)) — DB-тести на стеку
> `postgres`, CI і текст `AGENTS.md`. 2b стартує після мерджу 2a.
> **Спільні стеки.** Обидва локальні стеки спільні для сесій машини.
> Виконавець **ніколи** не виконує `pnpm db:stop`, `pnpm db:start`,
> `pnpm db:pg:stop`, `supabase stop`; DB-тести — лише через
> `pnpm --filter … test:db*` під замками стеків.
> **Перед стартом:** `.agents/skills/codebase-research/scripts/orient --plan <цей файл>`;
> повтори `grep -rn "\.service\b" packages/*/src` і
> `grep -rn "\.supabase\b\|SUPABASE_" packages/*/src` (спека §3.1, §4.2) і звір
> з переліками задач 1 і 3. Розбіжність імені — перейменуй у плані за кодом;
> розбіжність поведінки — до архітекторки.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** провайдер `postgres` стає повноправним значенням
`database.provider`: дані T0 і пресети T2 мають його рядок, рушій бере
провайдерні дані з `scope.provider`, тінь і копія доказу на `postgres`
створюються з шаблону `simetra_template`, план відмовляє власнику без
`BYPASSRLS`, а `simetra roles` від суперкористувача готує кластер профілю
`postgres`. Поведінка профілю `supabase` не змінюється.

**Architecture:** дані провайдера — у мапах T0
(`packages/simetra/src/model/schemas/project.ts`) і T2
(`packages/simetra/src/schema/engine/provider/`); жоден споживач не читає
`SUPABASE_*` напряму. Профіль pg-delta `simetra-postgres` — власна політика
без `supabasePolicy`. Провізія тіні з шаблону — окремий модуль designer, щоб
тест-обгортка її бачила. Підготовка кластера `postgres` — новий модуль T2
`postgres-cluster.ts`, який кличе `simetra roles`.

**Tech Stack:** TypeScript 7, Zod, Vitest 5, `pg` 8.23.1,
`@supabase/pg-delta` 1.0.0-alpha.60, Postgres 17 (стек `simetra-pg`),
`better-auth` 1.7.12 і `kysely` (лише devDependency тестів).

**Spec:** [спека профілю `postgres`](../specs/2026-11-08-postgres-profile-design.md)
— §3 (ролі, власник, `roles`, `plpgsql_check`), §4.1–§4.2 (пресет, таблиця
мап, тінь), §10.3, §12 рядок ПГ-2. Платформна спека §6.2 «Тіньова БД»,
§6.7. Правила тестів — скіл `writing-tests`.

## Global Constraints

- Мова: коментарі — українською, «чому»; діагностики (en/uk) і повідомлення
  CLI — англійською за `messages.ts`; JSDoc експортованого API — англійською.
- Коміти: Conventional Commits, опис українською, без трейлерів; push і PR —
  архітекторка.
- Профіль `supabase` без змін поведінки: після кожної задачі наявні DB-тести
  на стеку Supabase зелені (scoped прогони зачеплених файлів; повний
  `pnpm test:db` — один раз у задачі 11).
- Значення мап `postgres` — дослівно з таблиці §4.2 спеки (з поправкою
  задачі 0); імена ролей — з §3.1. Імена ролей і шаблону в коді — лише з даних
  T0/T2, ніколи літералом у споживачі.
- `PROVIDER_API_ROLES.postgres = { user: "simetra_user", anonymous: "simetra_anon", service: null }`;
  `LOGIN_ROLE_REQUEST_PURPOSES.postgres = ["user", "anonymous"]`;
  `PROVIDER_LOGIN_ROLES.postgres = ["simetra_auth"]`;
  `PROVIDER_OWNER_ROLES = { supabase: "postgres", postgres: "simetra_owner" }`;
  шаблон тіні `postgres` — `simetra_template`.
- `better-auth` — точно `1.7.12`, ліцензія MIT (файл `LICENSE.md` репозиторію
  Better Auth); лише `devDependencies`, ніколи в `dependencies` пакета чи в
  тарболі.
- Об'єкти, які створюють DB-тести (ролі, бази, шаблони), — лише через хелпери
  тегу (`packages/simetra/test/db/connection.ts`): у тестах кластерні ролі
  мають теговані імена.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`).
- Без shims: замінене прибирається в тій самій зміні (`AGENTS.md` принцип 5).

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Профіль pg-delta `simetra-postgres` — власна політика: `assumedSchemas: ["better_auth"]`; схема `extensions` з об'єктами — жорстке виключення; ACL, коментарі й мітки безпеки схем `better_auth` і `extensions` виключено; `handlers: []`; без `supabasePolicy` і без `assumedRoles`, `assumedPublications`, `assumedExtensions`, `assumedDefaultGrants`, `defaultOwner`. Причина: припущена й виключена схема стає reference-only, і засів видав би `CREATE SCHEMA "extensions"`, який на тіні з шаблону падає `42P06`; без виключення ACL план відкликав би гранти `roles` на `better_auth` (рішення архітекторки) | §4.2: рядок «профіль pg-delta» і абзац «Тінь» (задача 0) |
| Р2 | Тест-залежність `better-auth` 1.7.12 і хелпер справжньої міграції — у 2a, бо засів тіні бере `better_auth."user"` з фактів цілі: без справжньої таблиці DB-тест рушія на `postgres` не має тригерів провізії (рішення архітекторки). Гард — пак-тест: тарбол і `dependencies` пакетів не містять `better-auth` | немає |
| Р3 | Ролі `simetra_signals` і `simetra_signal_consumer` приносить ПГ-4 в обох профілях разом з outbox і `supabase/roles.sql`; у 2a `LOGIN_ROLE_PARENTS` має лише `runtime`, тож `roles` на `supabase` не змінює поведінки (рішення архітекторки) | §3.1 і §12 рядки ПГ-2, ПГ-4 (задача 0) |
| Р4 | DB-тести, прив'язані до стека `postgres`, — `*.postgres.db.test.ts`, проєкт `db-pg` обох пакетів; проєкт `db` їх виключає. 2b додає їх у `db`, коли той переходить на `postgres` | §10.5 — рядок про `*.postgres.db.test.ts` (задача 0) |
| Р5 | `simetra roles` у профілі `postgres` бере той самий `SIMETRA_DATABASE_URL`, що й зараз, — DSN суперкористувача; кластерні кроки (ролі, `CREATE DATABASE`, шаблон) іде з'єднанням до службової бази `postgres` того самого сервера, кроки бази (розширення, `CONNECT`, схема `better_auth`) — до цільової бази з URL | немає (§3.4 «DSN оператора») |
| Р6 | Підготовку кластера параметризує набір імен `PostgresClusterSet`; `roles` будує його з даних T0, тести — з тегованих імен. Типовий шаблон тіні береться з `PROVIDER_SHADOW_TEMPLATES[provider]`, а опція `shadowTemplate` адаптера дає тестам теговане ім'я | немає |
| Р7 | `runtime.privileged-login`, адресні гранти `better_auth`, `plan.identity-table-missing`, `plan.identity-trigger-locked` — ПГ-3; переведення наявних DB-тестів, CI і `AGENTS.md` — 2b | немає |

## Review Focus

1. **Профіль `supabase` не змінився.** Бажаний SQL, план і поведінка
   `roles` на `supabase` ті самі. Тест — задача 1 «supabase grants
   unchanged» (знімок SQL моделі-прикладу до й після), задача 6 — наявні
   DB-тести `roles-tool` і `platform-roles` на стеку Supabase зелені.
2. **Отримувач `null`.** Жоден генератор не видає `GRANT … TO null` чи
   `REVOKE … FROM null` і не падає на `postgres`. Тест — задача 1
   `it.each` по генераторах із `service: null`.
3. **Засів тіні на `postgres`.** План на тіні з `simetra_template` не видає
   `CREATE SCHEMA "extensions"` і не відкликає гранти `roles` на
   `better_auth`. Тест — задача 9 (вимога архітекторки).
4. **Суперкористувач `roles` під атакою власника.** Власник ставить
   `search_path` бази й кладе `public.format`; наступний `roles` цієї функції
   не кличе. Тест — задача 7.
5. **Повторний `roles`** нічого не змінює; рядки `pg_auth_members` і атрибути
   ті самі. Тест — задачі 6 і 7.

---

### Task 0: поправки спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-postgres-profile-design.md`

- [ ] **Step 1:** внести поправки:
  - §4.2, таблиця мап, рядок «профіль pg-delta» і абзац «Тінь» — за Р1
    (`assumedSchemas` — лише `better_auth`; `extensions` виключено жорстко,
    бо шаблон уже має схему; ACL і коментарі обох схем виключено);
  - §3.1 (рядки `simetra_signal_consumer`, `simetra_signals` і пункти про
    `LOGIN_ROLE_PARENTS`, `PLATFORM_ROLES`, `PLATFORM_LOGIN_ROLES`) і §12 —
    за Р3: ролі сигналів з'являються в ПГ-4 в обох профілях; рядок ПГ-4 дістає
    «ролі сигналів §3.1 у `roles` і `PLATFORM_*`»;
  - §12 рядок ПГ-2 — поділ на ПГ-2a і ПГ-2b з посиланням на обидва плани;
    тест-залежність Better Auth — у 2a (Р2);
  - §10.5 — Р4.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): профіль postgres — поправки блоку ПГ-2a`.

### Task 1: сервісна роль `null`

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts` (`ProviderApiRoles`)
- Modify — кожен споживач `service` чи `Object.values(PROVIDER_API_ROLES[…])`
  (перелік розвідки; звір із `grep` перед стартом):
  `compiler/sql/execute-grants.ts` (`executeGrants`, `grantRole`),
  `compiler/access-units.ts` (`tableGrants`), `compiler/platform/units.ts`
  (`SESSION_ROLES`, `platformSchemaGrants`), `compiler/function-execute.ts`,
  `compiler/membership-functions.ts` (`MEMBER_ROLES`),
  `compiler/rights/functions.ts` (`SET_ROLES`),
  `compiler/operations/promote/gates.ts` (`writePathProblems`),
  `schema/apply/plan.ts` (`readServiceAccess`, `apiRoles`),
  `schema/apply/execute.ts`, `schema/apply/promotion/access.ts`,
  `schema/apply/platform-roles.ts` (`DEFAULT_REQUEST_NAMES`),
  `packages/designer/src/io/data.ts` (`dataGuardFactsParams`)
- Test: поряд із кожним генератором у його наявному `__tests__`

**Interfaces:**
- Produces: `interface ProviderApiRoles { user: string; anonymous: string; service: string | null }`;
  `function grantRole(purpose: GrantPurpose, provider: DatabaseProvider): string | null`
  (`null` — призначення без ролі в профілі; кожен виклик пропускає `null`).

- [ ] **Step 1: failing tests.** `it.each` по генераторах (`executeGrants`,
  `tableGrants`, `platformSchemaGrants`, функції сесії, членства й прав) з
  тестовими ролями профілю, де `service: null` (`vi.spyOn` чи параметр ролей
  генератора, як заведено в тесті файла): у SQL немає `null` як імені ролі
  й немає рядка гранту для сервісного призначення; для `supabase` SQL
  дорівнює знімку до зміни (тест «supabase grants unchanged» — SQL
  `examples/reference` через `compile`, порівняння з SQL, зібраним на
  базовому коміті й збереженим у фікстурі тесту).
- [ ] **Step 2:** `pnpm --filter simetra test execute-grants access-units platform membership rights` — FAIL.
- [ ] **Step 3:** тип і пропуск `null` у кожному споживачі. Гілки промоції
  (`readServiceAccess`, `promotion/access.ts`) без сервісної ролі не
  перевіряють доступ сервісу; `dataGuardFactsParams` передає `null`, а SQL
  `DATA_GUARD_FACTS_SQL` порівнює через `IS NOT DISTINCT FROM`, а не `=`.
- [ ] **Step 4:** тести — PASS; `pnpm typecheck` — зелений (обидва пакети).
- [ ] **Step 5:** scoped DB на Supabase: `pnpm --filter simetra test:db access rights-functions membership` і
  `pnpm --filter @simetrajs/designer test:db data-tools build-plan-promotion` — зелені.
- [ ] **Step 6: Commit** — `feat(model): сервісна роль профілю може бути відсутня`.

### Task 2: значення `postgres` у мапах T0 і T2

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts`,
  `packages/simetra/src/schema/engine/provider/presets.ts`,
  `packages/simetra/src/data/adapter.ts` (`DEFAULT_SOURCE`)
- Create: `packages/simetra/src/schema/engine/provider/postgres.ts` (дані T2
  профілю, дзеркало `provider/supabase.ts`)
- Modify: `packages/simetra/schemas/project.schema.json` (`pnpm --filter simetra schemas:update`),
  `packages/designer/src/cli/command.ts` (опис `--provider`)
- Test: `packages/simetra/src/model/__tests__/` (тест мап проєкту),
  `packages/simetra/src/schema/engine/provider/__tests__/`

**Interfaces:**
- Produces (усі `export` з `simetra/model` чи `simetra/schema`):
  - `DATABASE_PROVIDERS = ["supabase", "postgres"] as const`;
  - рядок `postgres` у кожній `Record<DatabaseProvider, …>` T0 — значення з
    §3.1 і §4.1–§4.2 (Global Constraints, таблиця §4.2);
  - `const PROVIDER_OWNER_ROLES: Readonly<Record<DatabaseProvider, string>>`;
  - `type PlatformLoginPurpose = keyof typeof PLATFORM_LOGIN_ROLES`;
  - `const LOGIN_ROLE_PARENTS: Readonly<Record<PlatformLoginPurpose, readonly ("command" | "request")[]>>`
    = `{ runtime: ["command", "request"] }` (Р3);
  - `function loginRoleParentNames(purpose: PlatformLoginPurpose, provider: DatabaseProvider): readonly string[]`
    — `command` → `PLATFORM_ROLES.command`, `request` → ролі
    `LOGIN_ROLE_REQUEST_PURPOSES[provider]` з `PROVIDER_API_ROLES[provider]`;
  - T2: рядок `postgres` у `PROVIDER_SURFACES`
    (`{ schema: "better_auth", table: "user", classes: ["trigger"] }`),
    `PROVIDER_SYSTEM_ROLES` (`[]`), `PROVIDER_LOCKS`
    (`{ sources: [], services: [] }`), `PROVIDER_INSTALLABLE_EXTENSIONS`
    (`[]`), `PROVIDER_EXPECTED_BLIND_FUNCTIONS` (`[]`);
  - `const PROVIDER_SHADOW_TEMPLATES: Readonly<Record<DatabaseProvider, string | null>>`
    = `{ supabase: null, postgres: "simetra_template" }`.

- [ ] **Step 1: failing tests:** `it.each` по мапах T0 і T2 — рядок
  `postgres` дорівнює значенню таблиці §4.2 (для `PROVIDER_EVENT_SOURCES` —
  `better_auth."user"` з колонками `id`, `name`, `email`, `emailVerified`,
  `image`, `createdAt`, `updatedAt`, `isAnonymous`; без `storage.objects`);
  `PROVIDER_IDENTITY_SOURCES.postgres` — таблиця §4.1;
  `loginRoleParentNames("runtime", "postgres")` =
  `["simetra_command", "simetra_user", "simetra_anon"]`, для `supabase` —
  як `platformRoleSet("supabase").login.memberOf` до зміни; схема проєкту
  приймає `database.provider: "postgres"`.
- [ ] **Step 2:** `pnpm --filter simetra test project presets` — FAIL.
- [ ] **Step 3:** дані; `schemas:update`; опис CLI — без «default "supabase"»,
  якщо типового значення в коді немає (звір у `cli/command.ts`).
- [ ] **Step 4:** PASS; `pnpm typecheck` і `pnpm lint` — зелені; unit SQL
  провізії з пресету `postgres` бере імена колонок у лапках (`"isAnonymous"`)
  — тест у `compiler/platform/__tests__` (§4.4 спеки).
- [ ] **Step 5: Commit** — `feat(model): провайдер postgres у даних T0 і пресетах T2`.

### Task 3: споживачі констант Supabase — за `scope.provider`

**Files:**
- Modify: `packages/simetra/src/schema/engine/provider/supabase.ts`,
  `provider/postgres.ts`, `provider/presets.ts`,
  `packages/simetra/src/schema/engine/desired.ts` (`outOfScopeDiagnostics`, `onSurface`, `engineScope`),
  `packages/simetra/src/schema/engine/index.ts`,
  `packages/designer/src/schema-engine/census-read.ts`,
  `packages/designer/src/schema-engine/pg-delta/map-units.ts` (`presetGrants`),
  `packages/designer/src/schema-engine/pg-delta/map-model.ts` (опції `mapModel`),
  `packages/designer/src/schema-engine/pg-delta/adapter.ts` (`extractFrom`, `planAndRun`, `cloneAndRun`),
  `packages/designer/src/tools/database-tools.ts` (`introspect`)
- Test: наявні `__tests__` цих модулів

**Interfaces:**
- Produces (T2, `export`):
  - `const PROVIDER_UNMANAGED_EXTENSIONS: Readonly<Record<DatabaseProvider, readonly string[]>>`
    (`supabase` — нинішній `SUPABASE_EXTENSIONS`; `postgres` — `["plpgsql", "plpgsql_check"]`);
  - `const PROVIDER_EVENT_TRIGGERS: Readonly<Record<DatabaseProvider, readonly string[]>>`
    (`postgres` — `[]`);
  - `const PROVIDER_PUBLIC_SCHEMA_GRANTS: Readonly<Record<DatabaseProvider, …>>`
    (тип — як у `SUPABASE_PUBLIC_SCHEMA_GRANTS`; `postgres` — вбудовані
    Postgres 15+: `USAGE` для `PUBLIC`, власник `pg_database_owner`);
  - `function renderProviderSeed(provider: DatabaseProvider): string`
    (`postgres` — порожній рядок);
  - `mapModel(…, { provider })` — опція провайдера, яку `extractFrom` бере
    з `scope.provider`;
  - константи `SUPABASE_*` перестають бути експортом поза `provider/`
    (жоден споживач поза `provider/` їх не читає; без аліасів).

- [ ] **Step 1: failing tests:** `outOfScopeDiagnostics` для моделі з
  `provider: "postgres"` не згадує `auth`, `storage`; `onSurface` бере
  поверхні профілю (тригер на `better_auth.user` — на поверхні, на
  `auth.users` — ні); `readCensus` передає в SQL параметри профілю (тест на
  параметри запиту з підставним `db`); `introspect` з
  `provider: "postgres"` відмовляє на схемі `better_auth`, а не на `auth`;
  `renderProviderSeed("postgres") === ""`; для `supabase` усі ці виходи —
  як до зміни.
- [ ] **Step 2:** `pnpm --filter simetra test desired presets` і
  `pnpm --filter @simetrajs/designer test census-read map-units database-tools` — FAIL.
- [ ] **Step 3:** реалізація; у `introspect` визначення провайдера стоїть
  перед перевіркою схем провайдера.
- [ ] **Step 4:** PASS; `grep -rn "SUPABASE_" packages/*/src | grep -v "schema/engine/provider/"`
  — порожньо (крім тестів, що звіряють пресет `supabase`).
- [ ] **Step 5:** scoped DB на Supabase: `pnpm --filter @simetrajs/designer test:db engine-census engine-desired engine-extract database-tools` — зелені.
- [ ] **Step 6: Commit** — `refactor(schema): дані провайдера в рушії — за scope.provider`.

### Task 4: профіль pg-delta `simetra-postgres`

**Files:**
- Modify: `packages/designer/src/schema-engine/pg-delta/policy.ts`
- Test: `packages/designer/src/schema-engine/__tests__/engine-policy.test.ts`

**Interfaces:**
- Produces: `postgresBasePolicy: Policy` (id `simetra-postgres-base`);
  `scopePolicy(scope)` — `extends: [supabasePolicy]` для `supabase`,
  `[postgresBasePolicy]` для `postgres`; `inside` = `scope.schemas ∪ PROVIDER_SCHEMAS[scope.provider]`;
  виключення розширень — `PROVIDER_UNMANAGED_EXTENSIONS[scope.provider]`;
  `scopeProfile(scope)` для `postgres` — `{ id: "simetra-postgres", handlers: [], policy }`.
  Правила `postgresBasePolicy` (Р1), форма — як відповідні правила `supabasePolicy`:
  1. include `{ all: [{kind:"trigger"}, {schema:"better_auth"}, {idField:{field:"table",glob:"user"}}, {not:{edgeTo:{kind:"function", schema:"better_auth"}}}] }`;
  2. exclude `{ schema: ["better_auth", "extensions"] }` і
     `{ all: [{kind:"schema"}, {name:["better_auth","extensions"]}] }`;
  3. exclude `{ all: [{kind:["acl","comment","securityLabel"]}, {any:[{target:{schema:["better_auth","extensions"]}},{target:{kind:"schema",name:["better_auth","extensions"]}}]}] }`;
  `assumedSchemas: ["better_auth"]`; інших полів немає.

- [ ] **Step 1: failing tests** (`engine-policy.test.ts`, наявні помічники файла):
  - `flattenPolicy(scopePolicy({ schemas: ["app"], provider: "postgres" })).assumedSchemas`
    = `["better_auth"]` ⊂ `PROVIDER_SCHEMAS.postgres`; `extensions` і
    `information_schema` — провайдерні, але не припущені;
  - виключені розширення = `PROVIDER_UNMANAGED_EXTENSIONS.postgres`;
  - жодне правило не називає ролей `PROVIDER_SYSTEM_ROLES.supabase` чи схем
    `PROVIDER_SCHEMAS.supabase`; предка з id `supabase` немає;
    `assumedRoles`, `assumedPublications`, `assumedExtensions`,
    `assumedDefaultGrants` порожні; `defaultOwner` — `undefined`;
    `scopeProfile(postgres).id === "simetra-postgres"`, `handlers.length === 0`;
  - поверхня тригерів = `PROVIDER_SURFACES.postgres` (помічник
    `triggerSurfaceSchemas` читає й `idField` `table`);
  - вердикти `resolveView` (`@supabase/pg-delta/policy`): тригер на
    `better_auth.user` з ребром до `simetra.*` — керований; таблиця
    `better_auth.user` — reference-only; ACL на `better_auth.user` для
    `simetra_owner` — відкинуто; схема `extensions` — відкинуто, не
    reference-only; ADP від `simetra_owner` у `app` — керований;
  - для `supabase` наявні кейси без змін.
- [ ] **Step 2:** `pnpm --filter @simetrajs/designer test engine-policy` — FAIL.
- [ ] **Step 3:** реалізація; `validatePolicy` на обох профілях без помилок.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(schema-engine): профіль pg-delta simetra-postgres`.

### Task 5: тест-інфра стека `postgres` для 2a — проєкт `db-pg` і міграція Better Auth

**Files:**
- Modify: `packages/simetra/vitest.config.ts`, `packages/designer/vitest.config.ts`
  — проєкт `db-pg`: `include` — наявні два файли simetra плюс
  `**/*.postgres.db.test.ts`; проєкт `db` виключає `**/*.postgres.db.test.ts`;
  у designer `db-pg` має ті самі `setupFiles`, `maxConcurrency`,
  `testTimeout`, що й `db`; `globalSetup` — `stack-guard.postgres.ts`
- Modify: `packages/designer/package.json` (`test:db:pg`), `package.json`
  (корінь: `test:db:pg` кличе обидва пакети)
- Modify: `packages/simetra/package.json` — `devDependencies`:
  `"better-auth": "1.7.12"`, `"kysely"` — версія, яку тягне `better-auth`
  1.7.12 (звір у `pnpm-lock.yaml` після встановлення), точна
- Create: `packages/simetra/test/db/better-auth.ts`, `packages/simetra/test/db/better-auth.postgres.db.test.ts`
- Modify: `packages/simetra/test/db/stack-guard.test.ts` («guards every DB project» — `designer/db-pg`)
- Modify: `packages/designer/test/packaging/published-packages.pack.test.ts` — гард Р2
- Modify: `docs/dependency-monitoring.md` — рядок `better-auth` (тест-залежність, точний пін)

**Interfaces:**
- Produces:
  - `async function migrateBetterAuth(url: string): Promise<void>` у
    `test/db/better-auth.ts` — `getMigrations` з `better-auth/db/migration`,
    `database: { type: "postgres", dialect: new PostgresDialect({ pool }), schemaName: "better_auth" }`,
    `advanced: { database: { generateId: "uuid" } }`, `plugins: [anonymous()]`
    (`better-auth/plugins`), `runMigrations()`; пул закривається у `finally`;
    `url` — DSN тегованої ролі `simetra_auth` до тегованої бази;
  - `BETTER_AUTH_USER_COLUMNS` не вводиться: колонки звіряють з
    `PROVIDER_EVENT_SOURCES.postgres`.

- [ ] **Step 1: failing tests:**
  - `better-auth.postgres.db.test.ts`: у тегованій базі (`testDatabaseName`,
    створена суперкористувачем, видаляється у `finally`) від тегованої ролі
    (`testRoleName("auth")`, власник схеми `better_auth`) міграція створює
    `better_auth."user"`; її колонки й типи містять усі колонки
    `PROVIDER_EVENT_SOURCES.postgres`, `id` — `uuid`, `"isAnonymous"` —
    `boolean`; повторна міграція нічого не змінює;
  - пак-тест: `dependencies` і `peerDependencies` кожного опублікованого
    пакета не містять `better-auth` і `kysely`; файли тарбола не містять
    `better-auth`;
  - `stack-guard.test.ts` — новий проєкт у переліку.
- [ ] **Step 2:** `pnpm --filter simetra test stack-guard` — FAIL;
  `pnpm test:db:pg` — FAIL (немає модуля).
- [ ] **Step 3:** конфіги, скрипти, залежність (`pnpm --filter simetra add -D -E better-auth@1.7.12 kysely@<версія>`), хелпер.
- [ ] **Step 4:** `pnpm test:db:pg` — зелений, рядок старту `on postgres stack`;
  `pnpm build:packages && pnpm test:packaging` — зелені;
  `docker ps -a --filter label=simetra-run` — порожньо.
- [ ] **Step 5: Commit** — `test(db): проєкт db-pg обох пакетів і міграція Better Auth`.

### Task 6: гейт ролей входу за `LOGIN_ROLE_PARENTS`

**Files:**
- Modify: `packages/simetra/src/schema/apply/platform-roles.ts`
  (`PlatformRoleSet`, `platformRoleSet`, `platformRoleRefusals`,
  `platformRoleGate`, `checkPlatformRoles`, `grantRoleViolations`,
  `loginViolation`, `ensurePlatformRoles`), `packages/designer/src/tools/roles-tool.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/platform-roles.test.ts`,
  `packages/designer/src/__tests__/roles-tool.test.ts`

**Interfaces:**
- Consumes: `loginRoleParentNames`, `LOGIN_ROLE_PARENTS` (задача 2).
- Produces: `interface PlatformRoleSet { names: readonly string[]; login: readonly PlatformLoginRole[] }`
  (порожній перелік — роль входу пропущено); кожна роль входу звіряється з
  власним `memberOf`, а не зі спільною множиною дозволених батьків.

- [ ] **Step 1: failing tests** (`platform-roles.test.ts`, табличні кейси
  файла): роль входу з батьком, дозволеним **іншій** ролі входу, — відмова
  `plan.platform-role-shape` з `member-of:<батько>`; `platformRoleSet("postgres").login`
  = `[{ name: "simetra_runtime", memberOf: ["simetra_command", "simetra_user", "simetra_anon"] }]`;
  `platformRoleSet(undefined).login` = `[]`; для `supabase` — як до зміни.
- [ ] **Step 2:** `pnpm --filter simetra test platform-roles` і
  `pnpm --filter @simetrajs/designer test roles-tool` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; scoped DB на Supabase:
  `pnpm --filter @simetrajs/designer test:db roles-tool` і
  `pnpm --filter simetra test:db command-grants` — зелені (Review Focus 1, 5).
- [ ] **Step 5: Commit** — `refactor(schema): гейт ролей входу за дозволеними батьками кожної ролі`.

### Task 7: `simetra roles` — кластер профілю `postgres`

**Files:**
- Create: `packages/simetra/src/schema/apply/postgres-cluster.ts`,
  `packages/simetra/src/schema/apply/__tests__/postgres-cluster.test.ts`,
  `packages/designer/src/__tests__/roles-tool.postgres.db.test.ts`
- Modify: `packages/simetra/src/schema/apply/index.ts` (експорт),
  `packages/designer/src/tools/roles-tool.ts` (гілка за провайдером),
  `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts`

**Interfaces:**
- Consumes: `PlatformRoleSet` (задача 6), `PROVIDER_OWNER_ROLES`,
  `PROVIDER_LOGIN_ROLES`, `PROVIDER_API_ROLES`, `PROVIDER_SHADOW_TEMPLATES`
  (задача 2).
- Produces:
  - `interface PostgresClusterSet { owner: string; roles: PlatformRoleSet; request: readonly string[]; auth: string; template: string; database: string }`
    — `request` — ролі запиту (`NOLOGIN NOINHERIT`), `auth` — роль
    входу провайдера (`LOGIN NOINHERIT`, власник схеми `better_auth`),
    `database` — ім'я цільової бази з URL;
  - `function postgresClusterSet(database: string): PostgresClusterSet` — імена з даних T0/T2;
  - `async function ensurePostgresCluster(maintenance: DbConnection, target: DbConnection, dbs: ApplyDatabase, set: PostgresClusterSet): Promise<Result<PostgresClusterOutcome, EngineDiagnostic>>`
    — `PostgresClusterOutcome { created: string[]; present: string[]; skipped: string[] }`;
  - коди: `roles.superuser-required`, `roles.unsafe-schema`,
    `roles.database-owner`, `roles.shared-cluster` (en, uk, підказка; тексти
    — за §3.1, §3.4 спеки).

Порядок кроків `ensurePostgresCluster` (кожна сесія першим оператором ставить
`SET search_path = pg_catalog, pg_temp`; кожне ім'я в SQL кваліфіковане й
взяте через `quoteIdent`):

1. службова база: `current_user` без `rolsuper` — `roles.superuser-required`, нічого не створено;
2. ролі §3.1 (у 2a — без ролей сигналів, Р3): `owner`
   (`LOGIN NOSUPERUSER NOINHERIT BYPASSRLS CREATEDB NOCREATEROLE NOREPLICATION`),
   `request` і ролі грантів (`NOLOGIN NOINHERIT`), `auth` (`LOGIN NOINHERIT`),
   роль входу рантайму з парами `WITH INHERIT FALSE, SET TRUE`; наявні —
   лише звіряються (той самий гейт, що й `ensurePlatformRoles`);
3. база: немає — `CREATE DATABASE <database> OWNER <owner>`; інший власник —
   `roles.database-owner`;
4. роль входу Simetra з **явним** `CONNECT` до іншої бази (не через
   `PUBLIC`) — `roles.shared-cluster` з переліком баз;
5. ціль: `REVOKE CONNECT ON DATABASE … FROM PUBLIC`, `GRANT CONNECT` кожній
   ролі входу Simetra;
6. ціль: схема `extensions` належить не суперкористувачу —
   `roles.unsafe-schema`; немає — `CREATE SCHEMA extensions` (власник —
   суперкористувач), `GRANT USAGE … TO <owner>`;
   `CREATE EXTENSION IF NOT EXISTS plpgsql_check SCHEMA extensions`;
7. ціль: схема `better_auth` з `AUTHORIZATION <auth>`, якщо її немає;
8. шаблон: немає — `CREATE DATABASE <template> TEMPLATE template0`, у ньому
   кроки 6 без `better_auth`, потім `ALTER DATABASE … IS_TEMPLATE true ALLOW_CONNECTIONS false`;
   є — звірка `datistemplate`.

- [ ] **Step 1: failing unit tests** (`postgres-cluster.test.ts`):
  `postgresClusterSet("app")` бере імена з даних (`simetra_owner`,
  `simetra_user`, `simetra_anon`, `simetra_auth`, `simetra_template`);
  `messages.test.ts` — нові коди мають en/uk і підказку (автоматично).
- [ ] **Step 2: failing DB tests** (`roles-tool.postgres.db.test.ts`, теговані
  імена: `testRoleName(...)` для кожної ролі, `testDatabaseName(...)` для бази
  й шаблону; прибирання — `afterAll`: шаблон спершу `IS_TEMPLATE false`, потім
  `DROP DATABASE … WITH (FORCE)`, далі ролі):
  - атрибути й рядки `pg_auth_members` кожної ролі за §3.1; власник бази —
    `owner`; `datistemplate` і `datallowconn` шаблону; `plpgsql_check` у цілі
    й у шаблоні; `has_schema_privilege(owner, 'extensions', 'USAGE')`;
    `better_auth` належить `auth`, у шаблоні `better_auth` немає;
  - повторний виклик — `created` порожній, рядки ті самі (Review Focus 5);
  - не-суперкористувач — `roles.superuser-required`, жодного об'єкта;
  - база з іншим власником — `roles.database-owner`;
  - роль входу з явним `CONNECT` до іншої тегованої бази — `roles.shared-cluster`;
  - `extensions` належить `owner` — `roles.unsafe-schema`;
  - власник ставить `ALTER DATABASE … SET search_path = public, pg_catalog`
    і створює `public.format(text)`, що пише маркер у таблицю; наступний
    виклик маркера не пише (Review Focus 4);
  - `simetra_runtime`-подібна роль без `SET ROLE` не читає таблиці виду
    (таблиця з `GRANT SELECT` лише ролі запиту).
- [ ] **Step 3:** `pnpm --filter simetra test postgres-cluster` і `pnpm test:db:pg` — FAIL.
- [ ] **Step 4:** реалізація; `rolesTool`: провайдер `postgres` — `ensurePostgresCluster`
  (службова база — URL цілі з базою `postgres` через `withDatabaseName`
  з `@supabase/pg-delta`), `supabase` — наявний шлях; опис інструмента
  англійською доповнити гілкою `postgres` (суперкористувач, база, шаблон).
- [ ] **Step 5:** PASS; scoped DB на Supabase `pnpm --filter @simetrajs/designer test:db roles-tool` — зелений.
- [ ] **Step 6: Commit** — `feat(designer): simetra roles готує кластер профілю postgres`.

### Task 8: тінь і копія доказу з шаблону

**Files:**
- Create: `packages/designer/src/schema-engine/pg-delta/template-shadow.ts`
- Modify: `packages/designer/src/schema-engine/pg-delta/adapter.ts` (`provisionShadow`, опції),
  `packages/designer/src/__tests__/support/db-setup.ts` (другий `vi.mock`),
  `packages/designer/src/__tests__/support/shadows.ts` (документація обліку)
- Create: `packages/designer/src/schema-engine/__tests__/template-shadow.postgres.db.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_SHADOW_TEMPLATES` (задача 2); шаблон від
  `ensurePostgresCluster` (задача 7).
- Produces:
  - `async function provisionTemplateShadow(baseUrl: string, template: string, opts?: ProvisionCoLocatedShadowOptions): Promise<CoLocatedShadow>`
    — та сама перевірка `rolcreatedb OR rolsuper`, перевірка
    `datistemplate` шаблону (немає чи `false` — `ShadowProvisionError` з
    порадою `simetra roles`), `CREATE DATABASE "pgdelta_shadow_<suffix>" TEMPLATE "<template>"`;
    ім'я, типовий суфікс і `cleanup` — як у `provisionCoLocatedShadow`;
  - `provisionShadow(o)`: шаблон = `o.shadowTemplate ?? PROVIDER_SHADOW_TEMPLATES[scope.provider]`;
    `null` — `provisionCoLocatedShadow`; інакше `provisionTemplateShadow`;
    помилка на окремому сервері тіней називає цей сервер;
  - опція `shadowTemplate?: string` у тих самих опціях, що й `shadowBase`.

- [ ] **Step 1: failing DB tests** (`template-shadow.postgres.db.test.ts`,
  теговані кластер і шаблон задачі 7): тінь від тегованого `owner` має
  `plpgsql_check`, ім'я `pgdelta_shadow_<тег>…`, облік `recordProvision`
  її бачить, після `cleanup` бази немає; шаблон без `datistemplate` —
  `ShadowCreateRefusedError` з порадою `simetra roles`; два паралельні
  створення з одного шаблону — обидва успішні.
- [ ] **Step 2:** `pnpm test:db:pg` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; scoped DB на Supabase
  `pnpm --filter @simetrajs/designer test:db shadows engine-desired` — зелені.
- [ ] **Step 5: Commit** — `feat(schema-engine): тінь профілю postgres з шаблону simetra_template`.

### Task 9: гейт `plan.owner-not-bypassrls` і план на `postgres` наскрізно

**Files:**
- Modify: `packages/simetra/src/schema/apply/plan.ts` (`buildPlan`, `planPromotion`),
  `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts`
- Create: `packages/designer/src/schema-engine/__tests__/plan.postgres.db.test.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/` (unit гейта)

**Interfaces:**
- Consumes: `PROVIDER_OWNER_ROLES` не потрібен гейту (він читає атрибути
  `current_user`); тінь задачі 8; `migrateBetterAuth` (задача 5).
- Produces: код `plan.owner-not-bypassrls` (помилка; підказка — `ALTER ROLE … BYPASSRLS`
  від суперкористувача); перевірка — у першій читальній транзакції
  `buildPlan` поруч із `serverVersionRefusal`, до `checkPlatformRoles`, і на
  вході `planPromotion`; `current_user` без `rolbypassrls` і без `rolsuper`
  — відмова до першого кроку; в обох профілях.

- [ ] **Step 1: failing tests:**
  - unit: функція рішення гейта за рядком атрибутів (`{ bypassrls, superuser }`
    → відмова лише для `false, false`);
  - DB (`plan.postgres.db.test.ts`; тегований кластер задачі 7, теговані
    бази цілі й шаблону; міграція Better Auth на цілі від тегованого
    `auth`; гранти `USAGE` на `better_auth` і `TRIGGER` на `better_auth."user"`
    тегованому `owner` ставить сам тест від суперкористувача — у ПГ-3 їх
    дасть `roles`):
    - план і застосування моделі `examples/reference` з `provider: "postgres"`
      від тегованого `owner` проходять; тригери провізії стоять на
      `better_auth."user"`; режим `plpgsql_check` — `installed` на цілі й на
      копії доказу; у копії немає рядків `better_auth."user"` цілі;
    - текст плану не містить `CREATE SCHEMA "extensions"` і жодного
      `REVOKE` на `better_auth` (Review Focus 3, вимога архітекторки);
    - каталожний гейт (`readCensus`) бачить у чужих схемах лише розширення й
      тригери провізії;
    - той самий план від тегованої ролі без `BYPASSRLS` — `plan.owner-not-bypassrls`
      і жодного кроку;
  - на Supabase: наявні тести плану зелені (роль `postgres` має `BYPASSRLS`).
- [ ] **Step 2:** `pnpm --filter simetra test plan` і `pnpm test:db:pg` — FAIL.
- [ ] **Step 3:** реалізація; якщо наскрізний план падає на прогалині
  pg-delta — до архітекторки з фактом, не обхід.
- [ ] **Step 4:** PASS; scoped DB на Supabase
  `pnpm --filter @simetrajs/designer test:db build-plan execute-plan` — зелені.
- [ ] **Step 5: Commit** — `feat(schema): відмова плану власнику без BYPASSRLS; план на postgres наскрізно`.

### Task 10: документація

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` і
  `packages/designer/skills/simetra-metadata/references/people-and-rights.md`
  (розділ про `simetra roles`: у `postgres` — суперкористувач, база власника,
  шаблон, нові коди `roles.*`; англійською)
- Modify: `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` §6.2
  «Тіньова БД» — рядок §13 спеки профілю про шаблон `simetra_template`
- Modify: `docs/ROADMAP.md` — статус ПГ-2a

- [ ] **Step 1:** правки за переліком; без лічильників і наративу фаз.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs: провайдер postgres у скілі споживача й платформній спеці`.

### Task 11: гейти

- [ ] **Step 1:** `git merge origin/main` (без rebase).
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — зелені.
- [ ] **Step 3:** `pnpm test:db:pg` — зелений; `docker ps -a --filter label=simetra-run` — порожньо.
- [ ] **Step 4:** повний `pnpm test:db` на стеку Supabase — **один раз** за
  блок; зелений (Review Focus 1).
- [ ] **Step 5:** `pnpm build:packages && pnpm test:packaging`; `python3 scripts/check-doc-anchors.py` — зелені.

## Готово (§12, рядок ПГ-2, частина 2a)

- `database.provider: "postgres"` компілюється; мапи T0 і T2 мають рядок
  `postgres` за §4.2; поза `provider/` немає читачів `SUPABASE_*`.
- `simetra roles` від суперкористувача готує ролі §3.1 (без ролей сигналів),
  базу власника, `plpgsql_check` і `simetra_template`; повторний запуск
  нічого не змінює; не-суперкористувач, чужий власник бази, спільний
  кластер і небезпечна схема — відмови.
- План від ролі з атрибутами `simetra_owner` проходить на `postgres` з тінню
  й копією з шаблону, `plpgsql_check` — `installed`; без `BYPASSRLS` —
  `plan.owner-not-bypassrls`.
- Профіль `supabase` без змін: повний `pnpm test:db` зелений.
- `better-auth` — лише devDependency `simetra`; пак-тест це тримає.
