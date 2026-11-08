# ПГ-2a — провайдер `postgres` у схемному рушії: план реалізації

> **Статус:** проєкт плану, 2026-11-08; приймає архітекторка
> `runtime-client-data`. Блок ПГ-2 поділено: 2a (цей план) — провайдер у
> T0, T2, `simetra roles` і стек `postgres`; 2b
> (план ПГ-2b, окремий PR) — наявні DB-тести на
> стеку `postgres`, CI і текст `AGENTS.md`. 2b стартує після мерджу 2a.
> **Спільні стеки.** Обидва локальні стеки спільні для сесій машини.
> Виконавець **ніколи** не виконує `pnpm db:stop`, `pnpm db:start`,
> `pnpm db:pg:stop`, `supabase stop`; DB-тести — лише через
> `pnpm --filter … test:db*` під замками стеків. `pnpm db:pg:start`
> дозволено: він ідемпотентний і бере замок стека.
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
створюються з шаблону `simetra_template`, план і застосування відмовляють
власнику без `BYPASSRLS`, а `simetra roles` від суперкористувача готує
кластер профілю `postgres` — і на старті локального стека `postgres`.
Поведінка профілю `supabase` не змінюється.

**Architecture:** дані провайдера — у мапах T0
(`packages/simetra/src/model/schemas/project.ts`) і T2
(`packages/simetra/src/schema/engine/provider/`); жоден споживач поза
`provider/` не читає `SUPABASE_*`. Профіль pg-delta `simetra-postgres` —
власна політика без `supabasePolicy`. Провізія тіні з шаблону — окремий модуль
designer, щоб тест-обгортка її бачила. Підготовка кластера — модуль T2
`postgres-cluster.ts`: фаза читання й звірки, потім фаза запису без жодної
відмови; оператори поза транзакцією (`CREATE DATABASE`, `ALTER DATABASE`) іде
новий метод порту `ApplyDatabase.statement`.

**Tech Stack:** TypeScript 7, Zod, Vitest 5, `pg` 8.23.1,
`@supabase/pg-delta` 1.0.0-alpha.60, Postgres 17 (стек `simetra-pg`),
`better-auth` 1.7.12 і `kysely` (лише devDependency тестів).

**Spec:** [спека профілю `postgres`](../specs/2026-11-08-postgres-profile-design.md)
— §3 (ролі, власник, `roles`, `plpgsql_check`), §4.1–§4.2 (пресет, таблиця
мап, тінь), §10.2, §10.3, §12 рядок ПГ-2. Платформна спека §6.2 «Тіньова
БД», §6.7. Правила тестів — скіл `writing-tests`.

## Global Constraints

- Мова: коментарі — українською, «чому»; діагностики (en/uk) і повідомлення
  CLI — англійською за `messages.ts`; JSDoc експортованого API — англійською.
- Коміти: Conventional Commits, опис українською, без трейлерів; push і PR —
  архітекторка.
- Профіль `supabase` без змін поведінки: після кожної задачі наявні DB-тести
  на стеку Supabase зелені (scoped прогони зачеплених файлів; повний
  `pnpm test:db` — один раз у задачі 12).
- Значення мап `postgres` — дослівно з таблиці §4.2 спеки (з поправкою
  задачі 0); імена ролей — з §3.1. Імена ролей і шаблону в коді — лише з даних
  T0/T2, ніколи літералом у споживачі.
- `PROVIDER_API_ROLES.postgres = { user: "simetra_user", anonymous: "simetra_anon", service: null }`;
  `LOGIN_ROLE_REQUEST_PURPOSES.postgres = ["user", "anonymous"]`;
  `PROVIDER_LOGIN_ROLES.postgres = ["simetra_auth"]`;
  `PROVIDER_OWNER_ROLES = { supabase: "postgres", postgres: "simetra_owner" }`;
  шаблон тіні `postgres` — `simetra_template`; база стека — `simetra`.
- `better-auth` — точно `1.7.12`, ліцензія MIT (файл `LICENSE.md` репозиторію
  Better Auth); лише `devDependencies` пакета `simetra`. Міграцію Better Auth
  запускають без `schemaName`: `search_path = better_auth` дає і налаштування
  ролі, і опція з'єднання пулу (`options=-c search_path=better_auth`).
- DB-тести створюють кластерні ролі, бази й шаблони лише з тегованими іменами
  (`testRoleName`, `testDatabaseName` з `packages/simetra/test/db/connection.ts`)
  і через тест-хелпер кластера `packages/simetra/test/db/postgres-cluster.ts`
  (задача 8); DSN ролей входу на стеку — з паролем (порт стека з хоста
  доходить у `pg_hba` правилом `scram-sha-256`), пароль ставить
  `setTestPasswords` у `beforeAll`.
- Кожна транзакція `roles` у профілі `postgres` першими виконує
  `SET LOCAL ROLE NONE`, `SET LOCAL search_path = pg_catalog, pg_temp`,
  `SET LOCAL statement_timeout = 0`, `SET LOCAL lock_timeout = 0`, потім
  звіряє `current_user = session_user` і `rolsuper`. Оператор
  `ApplyDatabase.statement` іде лише на `conns.maintenance`; його прелюдія —
  `SET ROLE NONE`, `SET search_path = pg_catalog, pg_temp`,
  `SET default_transaction_read_only = off`, `SET statement_timeout = 0`, без
  звірки `rolsuper`: звірку дає транзакція службової бази фази читання з тим
  самим DSN. Кожне ім'я в SQL — кваліфіковане й через `quoteIdent`.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`).
- Без shims: замінене прибирається в тій самій зміні (`AGENTS.md` принцип 5).

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Профіль pg-delta `simetra-postgres` — власна політика: `assumedSchemas: ["better_auth"]`; схема `extensions` з об'єктами — жорстке виключення; ACL, коментарі й мітки безпеки схем `better_auth` і `extensions` виключено; `handlers: []`; без `supabasePolicy`, `assumedRoles`, `assumedPublications`, `assumedExtensions`, `assumedDefaultGrants`, `defaultOwner`. Припущена й виключена схема стає reference-only, і засів видав би `CREATE SCHEMA "extensions"`, що на тіні з шаблону падає `42P06`; без виключення ACL план відкликав би гранти `roles` на `better_auth` (рішення архітекторки) | §4.2: рядок «профіль pg-delta», абзац «Тінь» (задача 0) |
| Р2 | Тест-залежність `better-auth` 1.7.12 і хелпер справжньої міграції — у 2a: засів тіні бере `better_auth."user"` з фактів цілі (рішення архітекторки). Гард — пак-тест і лінт-зона: імпорт `better-auth` і `kysely` поза тестами заборонено | немає |
| Р3 | Ролі `simetra_signals` і `simetra_signal_consumer` приносить ПГ-4 в обох профілях; у 2a `LOGIN_ROLE_PARENTS` має лише `runtime` (рішення архітекторки) | §3.1, §12 рядки ПГ-2 і ПГ-4 (задача 0) |
| Р4 | DB-тести, прив'язані до стека `postgres`, — `*.postgres.db.test.ts`, проєкт `db-pg` обох пакетів; проєкт `db` їх виключає; 2b додає їх у `db` | §10.5 (задача 0) |
| Р5 | `simetra roles` бере той самий `SIMETRA_DATABASE_URL` (у профілі `postgres` — DSN суперкористувача до цільової бази); кластерні кроки — з'єднанням до службової бази `postgres` того самого сервера, кроки бази — до цілі й до шаблону. Скіл споживача радить окрему змінну через `--database-url-env` для `roles` | немає (§3.4 «DSN оператора») |
| Р6 | Набір імен `PostgresClusterSet` параметризує підготовку; `roles` будує його з даних T0/T2, тести — з тегованих імен; шаблон тіні — `ShadowOptions.shadowTemplate ?? PROVIDER_SHADOW_TEMPLATES[provider]` | немає |
| Р7 | Поза 2a: `runtime.privileged-login`, адресні гранти `better_auth`, `plan.identity-table-missing`, `plan.identity-trigger-locked` — ПГ-3; переведення наявних DB-тестів, CI, `AGENTS.md` — 2b | §12 рядок ПГ-3 — править ПГ-3 (задача 0 ПГ-3) |
| Р8 | Міграція Better Auth — без `schemaName`, бо з ним Better Auth шле `CREATE SCHEMA IF NOT EXISTS`, а Postgres перевіряє `CREATE` на базу до `IF NOT EXISTS` (перевірено на стеку). Головний засіб — опція з'єднання пулу host-а й тестів (`search_path = better_auth`); налаштування ролі — другий шар, бо роль сама може його переписати: `roles` ставить `ALTER ROLE <auth> SET search_path = better_auth` і `ALTER ROLE <auth> IN DATABASE <database> SET search_path = better_auth`. `roles` перевіряє: `<auth>` не має `CREATE` ні на базу, ні на `public`, жодне відношення з `relowner = <auth>` не лежить поза `better_auth`, а рядок `pg_db_role_setting` ролі `<auth>` для цілі не задає іншого `search_path` (рішення архітекторки) | §4.1, §4.2 крок 2, §10.1 (задача 0) |
| Р9 | Окремий сервер тіней (`shadowBase`) у профілі `postgres` у 2a не підтримано: `roles`, план і застосування відмовляють `plan.shadow-base-unsupported` (рішення архітекторки) | §14 — новий рядок (задача 0) |
| Р10 | Гейт `plan.owner-not-bypassrls` — на вході плану, застосування (після advisory lock) і репетиції; та сама функція рішення (рішення архітекторки, §3.3) | немає |
| Р11 | `pnpm db:pg:start` після наявних кроків кличе `simetra roles` з теки `docker/postgres-stack/project/` (`project.meta.json`, `provider: "postgres"`) і ставить dev-паролі ролям входу; наскрізний DB-тест плану потребує справжніх ролей грантів, яким грантує бажаний SQL (рішення архітекторки) | §10.2 рядок `db:pg:start` (задача 0) |
| Р13 | До ПГ-3 міграцію Better Auth у базі `simetra` і тимчасові гранти `USAGE` на `better_auth` і `TRIGGER` на `better_auth."user"` для `simetra_owner` ставить `pnpm db:pg:start` під замком стека, після кроку `roles`: мала точка входу `packages/simetra/test/db/better-auth-cli.ts` (`node --import tsx`) кличе `migrateBetterAuth` (задача 5) від `simetra_auth`, а гранти — від суперкористувача й лише після успішної міграції; повтор нічого не змінює. ПГ-3 переносить гранти в `roles` і прибирає їх з `db:pg:start`; тест гранту ПГ-3 — на тегованому кластері (`taggedClusterSet`), не на `simetra`, а CI перевіряє свіжий стек. Стан `better_auth` на стеку звіряє guard 2b (рішення архітекторки) | §10.1 (таблиці Better Auth бази стека `simetra` — з `db:pg:start`), §10.2 рядок `db:pg:start` (задача 0); §12 рядок ПГ-3 — править ПГ-3 (задача 0 ПГ-3) |
| Р12 | Оператори поза транзакцією (`CREATE DATABASE`, `ALTER DATABASE … IS_TEMPLATE`) — метод порту `ApplyDatabase.statement(db, sql)`: T2 не імпортує `pg`, а `transaction` завжди відкриває `BEGIN`. Метод — лише для підготовки кластера (`ensurePostgresCluster`), ніколи в плані чи застосуванні; межу тримає тест-гард | немає |

## Review Focus

1. **Профіль `supabase` не змінився.** Оператори `GRANT`/`REVOKE` моделі
   `examples/reference` на `supabase` ті самі; `roles` на `supabase` створює ті
   самі ролі. Тест — задача 2 «supabase grants unchanged», задача 7 — DB-тести
   `roles-tool` і `provider-roles` на стеку Supabase зелені.
2. **Отримувач `null`.** Жоден генератор не видає `GRANT … TO null` чи не
   падає на `postgres`. Тест — задача 2 `it.each` по генераторах.
3. **Засів тіні на `postgres`.** План на тіні з `simetra_template` не видає
   `CREATE SCHEMA "extensions"` і не відкликає гранти `roles` на
   `better_auth`. Тест — задача 10 (вимога архітекторки).
4. **Сесія суперкористувача `roles` під впливом власника.** Налаштування бази
   `role` чи `search_path` від власника, підкладені функції й оператори в
   `public` не змінюють того, від кого й що виконує `roles`. Тест — задача 8,
   з мутацією.
5. **Відмова `roles` нічого не лишає.** Кожна відмова — до першого запису:
   `pg_roles`, `pg_database` і `datacl` без змін. Тест — задача 8.

---

### Task 0: поправки спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-postgres-profile-design.md`

- [ ] **Step 1:** внести поправки за стовпцем «Вплив на спеку» (Р1, Р3, Р4,
  Р7, Р8, Р9, Р11, Р13): §3.1, §4.1, §4.2 (таблиця мап і «Тінь», крок 2), §10.1,
  §10.2, §10.5, §12 (рядок ПГ-2 — поділ на 2a і 2b з посиланнями на обидва
  плани; ПГ-4 — ролі сигналів), §14 (Р9). Рядок ПГ-3 §12 цей план не
  править: його поправки (Р7, Р13) робить задача 0 ПГ-3. Формулювання — стан після
  блоку, з посиланням на блок, що завершує механізм.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): профіль postgres — поправки блоку ПГ-2a`.

### Task 1: сервісна роль може бути відсутня

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts` (`ProviderApiRoles`)
- Modify — кожен споживач `service` чи `Object.values(PROVIDER_API_ROLES[…])`
  (звір із `grep` перед стартом): `compiler/sql/execute-grants.ts`
  (`executeGrants`, `grantRole`), `compiler/access-units.ts` (`tableGrants`),
  `compiler/platform/units.ts` (`SESSION_ROLES`, `platformSchemaGrants`),
  `compiler/function-execute.ts`, `compiler/membership-functions.ts`
  (`MEMBER_ROLES`), `compiler/rights/functions.ts` (`SET_ROLES`),
  `compiler/operations/promote/gates.ts` (`writePathProblems`),
  `schema/apply/plan.ts` (`readServiceAccess`, `apiRoles`),
  `schema/apply/execute.ts`, `schema/apply/promotion/access.ts`,
  `schema/apply/platform-roles.ts` (`DEFAULT_REQUEST_NAMES`),
  `packages/designer/src/io/data.ts` (`dataGuardFactsParams` — лише тип
  `(string | null)[]`; SQL не змінюється: підзапит з `$2 = NULL` дає `false`)

**Interfaces:**
- Produces: `interface ProviderApiRoles { user: string; anonymous: string; service: string | null }`;
  `function grantRole(purpose: GrantPurpose, provider: DatabaseProvider): string | null`
  — `null` для призначення без ролі; кожен виклик пропускає `null`.

- [ ] **Step 1:** тип і пропуск `null` у кожному споживачі; гілки промоції без
  сервісної ролі не перевіряють доступу сервісу. Провайдера з `null` ще немає,
  тож поведінку на `null` доводить задача 2.
- [ ] **Step 2:** `pnpm typecheck`, `pnpm lint`, `pnpm --filter simetra test` — зелені.
- [ ] **Step 3: Commit** — `refactor(model): сервісна роль профілю може бути відсутня`.

### Task 2: значення `postgres` у мапах T0 і T2

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts`,
  `packages/simetra/src/schema/engine/provider/presets.ts`,
  `packages/simetra/src/data/adapter.ts` (`DEFAULT_SOURCE`),
  `packages/simetra/schemas/project.schema.json` (`pnpm --filter simetra schemas:update`),
  `packages/designer/src/cli/command.ts` (опис `--database-provider`)
- Create: `packages/simetra/src/schema/engine/provider/postgres.ts` (дані T2
  профілю, дзеркало `provider/supabase.ts`),
  `packages/simetra/src/model/__tests__/project-providers.test.ts`,
  `packages/simetra/src/compiler/__tests__/provider-grants.test.ts`
- Modify (тести): `packages/simetra/src/schema/__tests__/engine-provider.test.ts`

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
    (`[{ schema: "better_auth", table: "user", classes: ["trigger"] }]`),
    `PROVIDER_SYSTEM_ROLES` (`[]`), `PROVIDER_LOCKS`
    (`{ sources: [], services: [] }`), `PROVIDER_INSTALLABLE_EXTENSIONS`
    (`[]`), `PROVIDER_EXPECTED_BLIND_FUNCTIONS` (`[]`);
  - `const PROVIDER_SHADOW_TEMPLATES: Readonly<Record<DatabaseProvider, string | null>>`
    = `{ supabase: null, postgres: "simetra_template" }`.

- [ ] **Step 1: failing tests:**
  - `project-providers.test.ts`: `it.each` по мапах T0 — рядок `postgres`
    дорівнює значенню §4.1–§4.2; `PROVIDER_EVENT_SOURCES.postgres` —
    `toEqual` у порядку `ordinal_position` таблиці справжньої міграції
    (`id`, `name`, `email`, `emailVerified`, `image`, `createdAt`,
    `updatedAt`, `isAnonymous`); `loginRoleParentNames("runtime", "postgres")`
    = `["simetra_command", "simetra_user", "simetra_anon"]`, для `supabase` —
    як `memberOf` ролі входу `platformRoleSet("supabase")` до зміни; схема
    проєкту приймає `database.provider: "postgres"`;
  - `engine-provider.test.ts`: рядки `postgres` мап T2;
  - `provider-grants.test.ts`: `it.each` по генераторах (`executeGrants`,
    `tableGrants`, `platformSchemaGrants`, функції сесії, членства й прав) з
    `provider: "postgres"` — у SQL немає рядка гранту сервісному
    призначенню й немає `null`; «supabase grants unchanged» — розібрані
    оператори `GRANT`/`REVOKE` компіляції `examples/reference` на `supabase`
    дорівнюють переліку, зібраному на базовому коміті задачі й вписаному в
    тест як дані (лише ці оператори, не весь SQL) (Review Focus 1, 2); unit
    SQL провізії з пресету `postgres` бере колонки в лапках (`"isAnonymous"`).
- [ ] **Step 2:** `pnpm --filter simetra test project-providers engine-provider provider-grants` — FAIL.
- [ ] **Step 3:** дані; `schemas:update`; опис `--database-provider` —
  перелік `supabase | postgres`, типове лишається `supabase`
  (`database-tools.ts`: `?? "supabase"`).
- [ ] **Step 4:** PASS; `pnpm typecheck` і `pnpm lint` — зелені.
- [ ] **Step 5:** scoped DB на Supabase: `pnpm --filter simetra test:db access rights-functions membership` і
  `pnpm --filter @simetrajs/designer test:db data-tools` — зелені.
- [ ] **Step 6: Commit** — `feat(model): провайдер postgres у даних T0 і пресетах T2`.

### Task 3: споживачі констант Supabase — за `scope.provider`

**Files:**
- Modify: `packages/simetra/src/schema/engine/provider/{supabase,postgres,presets}.ts`,
  `packages/simetra/src/schema/engine/desired.ts` (`outOfScopeDiagnostics` —
  `Pick` з `"project"`; `onSurface`; `engineScope`),
  `packages/simetra/src/schema/engine/index.ts` (експорт),
  `packages/designer/src/schema-engine/census-read.ts`,
  `packages/designer/src/schema-engine/pg-delta/map-units.ts` (`presetGrants`),
  `packages/designer/src/schema-engine/pg-delta/map-model.ts` (`MapContext.provider`),
  `packages/designer/src/schema-engine/pg-delta/adapter.ts` (`extractFrom`, `planAndRun`, `cloneAndRun`),
  `packages/designer/src/tools/database-tools.ts` (`introspect`)
- Modify (тести, що імпортують `SUPABASE_*` з `simetra/schema`):
  `packages/designer/src/schema-engine/__tests__/{function-checks.db,read-only.supabase.db,engine-policy,build-plan-promotion.supabase.db,build-plan.supabase.db,execute-plan.supabase.db}.test.ts`,
  `execute-plan.support.ts`, `packages/designer/src/schema-engine/__tests__/map-model.test.ts`; `packages/simetra/src/schema/__tests__/{provider-preset.supabase.db,engine-provider,provider-event-sources}.test.ts`,
  `packages/simetra/src/schema/apply/__tests__/execute.test.ts`
- Create: `packages/designer/src/schema-engine/__tests__/census-read.test.ts`,
  `packages/designer/src/tools/__tests__/database-tools.test.ts`

**Interfaces:**
- Produces (T2, `export`):
  - `PROVIDER_UNMANAGED_EXTENSIONS: Readonly<Record<DatabaseProvider, readonly string[]>>`
    (`supabase` — нинішній `SUPABASE_EXTENSIONS`; `postgres` — `["plpgsql", "plpgsql_check"]`);
  - `PROVIDER_EVENT_TRIGGERS` (`postgres` — `[]`);
  - `PROVIDER_PUBLIC_SCHEMA_GRANTS` (тип як у `SUPABASE_PUBLIC_SCHEMA_GRANTS`;
    `postgres` — `[{ grantee: "PUBLIC", privileges: ["USAGE"] }]`);
  - `PROVIDER_BASE_EXTENSIONS` (`supabase` — нинішній `SUPABASE_BASE_EXTENSIONS`; `postgres` — `[]`);
  - `function renderProviderSeed(provider: DatabaseProvider): string` (`postgres` — `""`);
  - `function onSurface(cls, target, provider: DatabaseProvider)`;
  - `MapContext.provider: DatabaseProvider` — `extractFrom` бере його з
    `scope.provider`, `presetGrants` і `revokedPresetStatements` читають його з
    контексту;
  - константи `SUPABASE_*` не експортуються з `simetra/schema`; тести беруть
    `PROVIDER_*.supabase` (без аліасів).

- [ ] **Step 1: failing tests:** `outOfScopeDiagnostics` для моделі з
  `provider: "postgres"` не згадує `auth`, `storage`; `onSurface` з
  `postgres`: тригер на `better_auth.user` — на поверхні, на `auth.users` — ні;
  `census-read.test.ts` — параметри запиту профілю з підставним `db`;
  `database-tools.test.ts` — `introspect` з `provider: "postgres"` відмовляє
  на схемі `better_auth`, а не на `auth`, до доступу до бази;
  `renderProviderSeed("postgres") === ""`; для `supabase` ці виходи — як до зміни.
- [ ] **Step 2:** `pnpm --filter simetra test desired engine-provider provider-event-sources` і
  `pnpm --filter @simetrajs/designer test census-read database-tools map-model` — FAIL.
- [ ] **Step 3:** реалізація; у `introspect` провайдер визначається до перевірки схем.
- [ ] **Step 4:** PASS; `grep -rn "SUPABASE_" packages/*/src | grep -v "schema/engine/provider/"` — порожньо.
- [ ] **Step 5:** scoped DB на Supabase: `pnpm --filter @simetrajs/designer test:db engine-census engine-desired engine-extract database-tools function-checks` і
  `pnpm --filter @simetrajs/designer test:db:supabase read-only build-plan execute-plan`,
  `pnpm --filter simetra test:db:supabase provider-preset` — зелені.
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
  Правила `postgresBasePolicy` (Р1):
  1. include `{ all: [{kind:"trigger"}, {schema:"better_auth"}, {idField:{field:"table",glob:"user"}}, {not:{edgeTo:{kind:"function", schema:"better_auth"}}}] }`;
  2. exclude `{ schema: ["better_auth", "extensions"] }` і
     `{ all: [{kind:"schema"}, {name:["better_auth","extensions"]}] }`;
  3. exclude `{ all: [{kind:["acl","comment","securityLabel"]}, {any:[{target:{schema:["better_auth","extensions"]}},{target:{kind:"schema",name:["better_auth","extensions"]}}]}] }`;
  `assumedSchemas: ["better_auth"]`; інших полів немає.

- [ ] **Step 1: failing tests** (наявні помічники файла):
  - `flattenPolicy(scopePolicy({ schemas: ["app"], provider: "postgres" })).assumedSchemas`
    = `["better_auth"]` ⊂ `PROVIDER_SCHEMAS.postgres`; `extensions` і
    `information_schema` — провайдерні, не припущені;
  - виключені розширення = `PROVIDER_UNMANAGED_EXTENSIONS.postgres`;
  - жодне правило не називає `PROVIDER_SYSTEM_ROLES.supabase` чи схем
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

### Task 5: тест-інфра стека `postgres` для 2a

**Files:**
- Modify: `packages/simetra/vitest.config.ts`, `packages/designer/vitest.config.ts`
  — проєкт `db-pg`: `include` — наявні два файли simetra плюс
  `**/*.postgres.db.test.ts`; `db` виключає `**/*.postgres.db.test.ts`; у
  designer `db-pg` — `globalSetup: ["../simetra/test/db/stack-guard.postgres.ts"]`,
  `fileParallelism: false` (як у `db-pg` simetra), ті самі `setupFiles`,
  `maxConcurrency`, `testTimeout`, що й `db`
- Modify: `packages/designer/package.json` (`test:db:pg`), `package.json`
  (корінь: `test:db:pg` кличе обидва пакети)
- Modify: `packages/simetra/package.json` — `devDependencies`
  `"better-auth": "1.7.12"` і `"kysely"` — найновіша версія в межах
  `^0.28.17 || ^0.29`, опублікована щонайменше 14 днів тому, точний пін;
  ліцензію кожної нової транзитивної залежності звірити за `CONTRIBUTING.md`
  § «Dependencies»
- Modify: `packages/simetra/test/db/sweep.ts` (цикл і `manualSweepSql`),
  `packages/simetra/test/db/stack-guard.ts` (звіт про залишки) — тегована база з
  `datistemplate` спершу `ALTER DATABASE … WITH IS_TEMPLATE false`, потім `DROP … WITH (FORCE)`
- Modify: `packages/simetra/eslint.tier-zones.js`, `packages/designer/eslint.zones.js`,
  `packages/simetra/test/tier-boundary.test.ts` — `^(?:better-auth|kysely)(?:/|$)`
  заборонено в production-джерелах (негативний кейс)
- Modify: `packages/designer/test/packaging/published-packages.pack.test.ts`
- Modify: `docs/dependency-monitoring.md` — рядки `better-auth` і `kysely`
  (тест-залежності, точний пін, оновлюються разом)
- Create: `packages/simetra/test/db/better-auth.ts`,
  `packages/simetra/test/db/better-auth.postgres.db.test.ts`
- Modify: `packages/simetra/test/db/stack-guard.test.ts` («guards every DB project»)

**Interfaces:**
- Produces: `async function migrateBetterAuth(url: string): Promise<void>` у
  `test/db/better-auth.ts` — `getMigrations` з `better-auth/db/migration`,
  `database: { type: "postgres", dialect: new PostgresDialect({ pool }) }`
  (без `schemaName`, Р8), пул з `options: "-c search_path=better_auth"`,
  `advanced: { database: { generateId: "uuid" } }`, `plugins: [anonymous()]`
  (`better-auth/plugins`), `runMigrations()`; пул закривається у `finally`;
  `url` — DSN ролі `auth` до цільової бази.

- [ ] **Step 1: failing tests:**
  - `better-auth.postgres.db.test.ts`: тегована база й тегована роль `auth`
    з паролем (`testDatabaseName`, `testRoleName`; створює суперкористувач
    прямо, без `PostgresClusterSet`, видаляє у `finally`); `auth` — власник
    схеми `better_auth`, з `ALTER ROLE … SET search_path = better_auth`, без
    `CREATE` на базу; міграція створює `better_auth."user"`, колонки й типи —
    `PROVIDER_EVENT_SOURCES.postgres` у тому самому порядку, `id` — `uuid`,
    `"isAnonymous"` — `boolean`; у `public` нічого; повторна міграція
    нічого не змінює;
  - пак-тест: `dependencies`, `peerDependencies`, `optionalDependencies`
    кожного тарбола не містять `better-auth`, `kysely`; голі специфікатори
    (`bareSpecifiers`) усіх `dist/**/*.js` і `*.d.ts` не містять
    `better-auth`, `better-auth/…`, `kysely`;
  - `tier-boundary.test.ts`: імпорт `better-auth` з production-джерела — помилка лінту;
  - `stack-guard.test.ts`: `designer/db-pg` у переліку; прибиральник видаляє
    теговану базу з `datistemplate` (підставний клієнт: `ALTER … IS_TEMPLATE false` перед `DROP`).
- [ ] **Step 2:** `pnpm --filter simetra test stack-guard tier-boundary` — FAIL.
- [ ] **Step 3:** конфіги, скрипти, залежність
  (`pnpm --filter simetra add -D -E better-auth@1.7.12 kysely@<вибрана>`),
  хелпер. `test:db:pg` designer — без `--passWithNoTests`: перший файл дає задача 6.
- [ ] **Step 4:** `pnpm --filter simetra test:db:pg` — зелений, рядок старту
  `on postgres stack`; `pnpm build:packages && pnpm test:packaging` — зелені;
  `docker ps -a --filter label=simetra-run` — порожньо.
- [ ] **Step 5: Commit** — `test(db): проєкт db-pg обох пакетів, міграція Better Auth, прибирання шаблонів`.

### Task 6: порт — оператор поза транзакцією

**Files:**
- Modify: `packages/simetra/src/schema/apply/port.ts` (`ApplyDatabase`),
  `packages/designer/src/schema-engine/apply-database.ts` (`createApplyDatabase`)
- Modify — кожна реалізація `ApplyDatabase` (звір із
  `grep -rln "ApplyDatabase\|transaction(" packages --include=*.ts` перед стартом):
  `packages/simetra/test/db/connection.ts` (`rollbackDatabase`),
  `packages/designer/src/schema-engine/__tests__/execute-plan.support.ts`
  (`counted`, `observing`, `afterEnd`, `sessionLeftover`),
  `packages/designer/src/schema-engine/__tests__/build-plan.support.ts`
  (`readerWithoutPlpgsqlCheck`);
  `packages/simetra/src/schema/apply/__tests__/{rights-maintenance,plan,execute,platform-roles}.test.ts`,
  `packages/designer/src/__tests__/apply-outcome.test.ts`;
  DB-тести з власними портами: `packages/designer/src/__tests__/apply-tools.db.test.ts`,
  `packages/designer/src/schema-engine/__tests__/{build-plan,build-plan-promotion-data,build-plan-provider,execute-plan}.db.test.ts`.
  Заглушки реалізують `statement` як
  `() => Promise.reject(new Error("no statement expected"))`; обгортки
  (`counted`, `observing` та інші) пересилають виклик `db.statement(…)`
- Create: `packages/designer/src/schema-engine/__tests__/apply-database.postgres.db.test.ts`,
  `packages/simetra/src/schema/apply/__tests__/statement-boundary.test.ts`

**Interfaces:**
- Produces: `ApplyDatabase.statement(db: DbConnection, sql: string): Promise<void>`
  — окреме з'єднання без `BEGIN`; перед `sql` — прелюдія `statement` з Global
  Constraints; з'єднання закривається у `finally`. JSDoc англійською: «only
  for cluster preparation (`ensurePostgresCluster`); never in plan or apply».
- Змінює: `createApplyDatabase({ readOnly: false })` відкриває
  `BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE`.

- [ ] **Step 1: failing tests:**
  - DB: `statement` виконує `CREATE DATABASE <тегована>` (у `transaction` той
    самий оператор дає `25001`); після виклику
    `current_setting('search_path')` нового з'єднання не змінено; база з
    `ALTER DATABASE … SET default_transaction_read_only = on` приймає
    запис і в `transaction` з `readOnly: false`, і в `statement`; бази
    видаляються у `finally`;
  - гард `statement-boundary.test.ts`: у `packages/simetra/src/schema/apply`
    немає виклику `.statement(` поза `postgres-cluster.ts`.
- [ ] **Step 2:** `pnpm --filter @simetrajs/designer test:db:pg apply-database` — FAIL.
- [ ] **Step 3:** реалізація; читальна реалізація (`readOnly: true`) `statement` відмовляє.
- [ ] **Step 4:** PASS; `pnpm --filter simetra test statement-boundary`, `pnpm test:db:pg`, `pnpm typecheck` — зелені.
- [ ] **Step 5: Commit** — `feat(schema): порт ApplyDatabase — оператор поза транзакцією`.

### Task 7: гейт ролей входу за `LOGIN_ROLE_PARENTS`

**Files:**
- Modify: `packages/simetra/src/schema/apply/platform-roles.ts`
  (`PlatformRoleSet`, `platformRoleSet`, `platformRoleRefusals`,
  `platformRoleGate`, `checkPlatformRoles`, `grantRoleViolations`,
  `loginViolation`, `ensurePlatformRoles`),
  `packages/simetra/src/schema/apply/plan.ts`,
  `packages/designer/src/tools/{roles-tool,apply-tools,database-tools}.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/platform-roles.test.ts`,
  `packages/designer/src/__tests__/roles-tool.test.ts`,
  `packages/designer/src/__tests__/roles-tool.db.test.ts`,
  `packages/simetra/test/db/provider-roles.supabase.db.test.ts`

**Interfaces:**
- Consumes: `loginRoleParentNames`, `LOGIN_ROLE_PARENTS` (задача 2).
- Produces:
  - `interface PlatformRoleSet { names: readonly string[]; login: readonly PlatformLoginRole[] }`
    (порожній перелік — роль входу пропущено);
  - `platformRoleRefusals(required, found, server, login: readonly PlatformLoginRole[], requestNames)`;
  - `platformRoleGate(tx, required, login: readonly PlatformLoginRole[], server)`;
  - `checkPlatformRoles(dbs, target, shadowBase, desiredSql, parse, provider: DatabaseProvider)`
    — ролі входу й дозволені батьки з `platformRoleSet(provider).login`;
    викликачі передають `scope.provider` (`plan.ts`, `apply-tools.ts`, `database-tools.ts`);
  - кожна роль входу звіряється з власним `memberOf`.

- [ ] **Step 1: failing tests** (`platform-roles.test.ts`, табличні кейси):
  роль входу з батьком, дозволеним **іншій** ролі входу, — `plan.platform-role-shape`
  з `member-of:<батько>`; роль запиту `simetra_user` з членом-посередником з
  `CREATEROLE` — `request-path:<посередник>` (§3.1);
  `platformRoleSet("postgres").login` =
  `[{ name: "simetra_runtime", memberOf: ["simetra_command", "simetra_user", "simetra_anon"] }]`;
  `platformRoleSet(undefined).login` = `[]`; для `supabase` — як до зміни.
- [ ] **Step 2:** `pnpm --filter simetra test platform-roles` і `pnpm --filter @simetrajs/designer test roles-tool` — FAIL.
- [ ] **Step 3:** реалізація; виклики в тестах переходять на нові сигнатури.
- [ ] **Step 4:** PASS; scoped DB на Supabase: `pnpm --filter @simetrajs/designer test:db roles-tool`,
  `pnpm --filter simetra test:db:supabase provider-roles`, `pnpm --filter simetra test:db command-grants` — зелені.
- [ ] **Step 5: Commit** — `refactor(schema): гейт ролей входу за дозволеними батьками кожної ролі`.

### Task 8: `simetra roles` — кластер профілю `postgres`

**Files:**
- Create: `packages/simetra/src/schema/apply/postgres-cluster.ts`,
  `packages/simetra/src/schema/apply/__tests__/postgres-cluster.test.ts`,
  `packages/simetra/test/db/postgres-cluster.ts` (тест-хелпер кластера; designer-тести
  імпортують його звідти),
  `packages/designer/src/__tests__/roles-tool.postgres.db.test.ts`
- Modify: `packages/simetra/src/schema/apply/index.ts`,
  `packages/simetra/src/schema/apply/execute.ts` (`CLUSTER_ADVISORY_LOCK` поруч
  з `APPLY_ADVISORY_LOCK`),
  `packages/designer/src/tools/roles-tool.ts`,
  `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts`

**Interfaces:**
- Consumes: `PlatformRoleSet` (задача 7), `ApplyDatabase.statement` (задача 6),
  `PROVIDER_OWNER_ROLES`, `PROVIDER_LOGIN_ROLES`, `PROVIDER_API_ROLES`,
  `PROVIDER_SHADOW_TEMPLATES` (задача 2).
- Produces:
  - `interface PostgresClusterSet { owner: string; roles: PlatformRoleSet; request: readonly string[]; auth: string; template: string; database: string }`;
  - `function postgresClusterSet(database: string): PostgresClusterSet` — імена з даних T0/T2;
  - `async function ensurePostgresCluster(dbs: ApplyDatabase, conns: { maintenance: DbConnection; target: DbConnection; template: DbConnection }, set: PostgresClusterSet): Promise<Result<PostgresClusterOutcome, EngineDiagnostic[]>>`
    — `PostgresClusterOutcome { created: string[]; present: string[] }`;
    `conns` будує designer (`withDatabaseName` з `@supabase/pg-delta`);
    `conns.template` відкривається лише для незапечатаного шаблону;
  - `CLUSTER_ADVISORY_LOCK` — ключ замка `roles`;
  - коди (en, uk, підказка; за §3.1, §3.4): `roles.superuser-required`,
    `roles.unsafe-schema`, `roles.unsafe-template`, `roles.database-owner`,
    `roles.shared-cluster`, `plan.shadow-base-unsupported` (Р9);
  - тест-хелпер `packages/simetra/test/db/postgres-cluster.ts`:
    `function taggedClusterSet(label: string): PostgresClusterSet` (теговані
    імена ролей, бази й шаблону), `const TEST_LOGIN_PASSWORD`,
    `function roleUrl(set, role): string` (DSN ролі входу до цілі),
    `async function setTestPasswords(set): Promise<void>` (від
    суперкористувача, `TEST_LOGIN_PASSWORD`; тести, що входять тегованими
    ролями, кличуть його в `beforeAll`),
    `async function dropTaggedCluster(set, extraDatabases?: readonly string[]): Promise<void>`
    (спершу додаткові бази, потім шаблон `IS_TEMPLATE false` і
    `DROP … WITH (FORCE)`, база, ролі; помилки кожного кроку збираються,
    останнім кидається перша).

`ensurePostgresCluster` — дві фази в зовнішній транзакції службової бази, що
бере `pg_advisory_xact_lock(CLUSTER_ADVISORY_LOCK)` і тримає його до кінця
обох фаз; ця транзакція лише тримає замок і читає. Кожен запис фази запису
комітиться власною транзакцією чи `statement` до наступного кроку, що від
нього залежить: ролі — до `CREATE DATABASE … OWNER <owner>`, бо інше
з'єднання незакомічених ролей не бачить (Review Focus 5).

**Запечатаний шаблон** — `datistemplate`, `NOT datallowconn`, власник —
суперкористувач (з `pg_database` через службову базу). Він довірений без
з'єднання: його вміст міг змінити лише суперкористувач. З'єднання з шаблоном
(прелюдія, перевірки п. 5, відсутність `better_auth`, доробка й позначка) —
лише коли шаблон ще не запечатано.

**Фаза читання** (жодного запису; будь-яка відмова — повернення без запису;
результат — знімок для фази запису):
1. у кожній транзакції (службова база, ціль, якщо є, незапечатаний шаблон) —
   прелюдія Global Constraints; `current_user ≠ session_user` чи без
   `rolsuper` — `roles.superuser-required`;
2. форма наявних ролей: `owner` — атрибути рівно
   `LOGIN NOSUPERUSER NOINHERIT BYPASSRLS CREATEDB NOCREATEROLE NOREPLICATION`,
   не член жодної ролі (зокрема `pg_*`), без членів; `auth` — атрибути рівно
   `LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
   без членств і членів; ролі запиту — форма ролі грантів, члени — лише пари
   ролі входу рантайму; роль входу рантайму — наявний гейт (задача 7);
   порушення — `plan.platform-role-shape` з `violation`;
3. наявна база: власник ≠ `owner` — `roles.database-owner`;
4. явний `CONNECT` ролі входу Simetra (`runtime`, `auth`) до іншої бази —
   рядок `aclexplode(datacl)` при `datacl IS NOT NULL`, `grantee <> 0`,
   `datname <> database` — `roles.shared-cluster` з переліком баз;
5. ціль (якщо є) і незапечатаний шаблон: схема `extensions` — `roles.unsafe-schema`,
   коли власник без `rolsuper`, `nspacl` дає `CREATE` не суперкористувачу, чи
   в схемі є об'єкт (`pg_class`, `pg_proc`, `pg_type`, `pg_operator`) з
   власником без `rolsuper`; `plpgsql_check` у схемі, відмінній від
   `extensions`, — та сама відмова;
6. ціль: `better_auth` належить не `auth`; `auth` має `CREATE` на базу чи на
   `public`; будь-яке відношення з `relowner = <auth>` поза `better_auth`;
   рядок `pg_db_role_setting` ролі `auth` для цілі з іншим `search_path` —
   `roles.unsafe-schema` (Р8);
7. шаблон: власник без `rolsuper`, чи `datallowconn` за `datistemplate` —
   `roles.unsafe-template`; у незапечатаному шаблоні є `better_auth` —
   `roles.unsafe-template`.

**Фаза запису** (лише без жодної відмови) діє за знімком фази читання: наявне
в знімку пропускається, а чого не було, створюється без `IF NOT EXISTS`
(`CREATE SCHEMA extensions`, `CREATE SCHEMA better_auth AUTHORIZATION …`,
`CREATE DATABASE`). Об'єкт, що з'явився між фазами, дає помилку оператора, а
не пропуск.
1. відсутні ролі §3.1 (у 2a — без ролей сигналів, Р3) з атрибутами вище,
   пари `WITH INHERIT FALSE, SET TRUE`; `ALTER ROLE <auth> SET search_path = better_auth`;
2. база — `statement`: `CREATE DATABASE <database> OWNER <owner> TEMPLATE template0`;
3. ціль: `REVOKE CONNECT, TEMPORARY ON DATABASE … FROM PUBLIC`; `GRANT CONNECT`
   ролям входу Simetra; `CREATE SCHEMA extensions` (власник — суперкористувач),
   `GRANT USAGE … TO <owner>`; перевірку фази читання 5 повторити в тій самій
   транзакції безпосередньо перед `CREATE EXTENSION plpgsql_check SCHEMA extensions`;
   `CREATE SCHEMA better_auth AUTHORIZATION <auth>`;
   `ALTER ROLE <auth> IN DATABASE <database> SET search_path = better_auth`;
4. шаблон — `statement`: `CREATE DATABASE <template> TEMPLATE template0`,
   одразу `REVOKE CONNECT, TEMPORARY … FROM PUBLIC`; у ньому кроки
   `extensions` пункту 3 (з повторною перевіркою 5) без `better_auth`;
   `ALTER DATABASE … IS_TEMPLATE true ALLOW_CONNECTIONS false`; після позначки —
   `pg_terminate_backend` інших сесій шаблону
   (`pg_stat_activity.datname = <template>`, `pid <> pg_backend_pid()`).
   Незапечатаний шаблон суперкористувача — доробити тими самими кроками й позначити.

- [ ] **Step 1: failing unit tests** (`postgres-cluster.test.ts`):
  `postgresClusterSet("app")` бере імена з даних; функції рішення фази читання
  (форма ролей, явний `CONNECT`, безпечна схема, запечатаний шаблон,
  налаштування `search_path` ролі `auth` для цілі) — табличні кейси з рядків
  каталогу; гілка `rolesTool` за провайдером — з підставним портом;
  `messages.test.ts` — нові коди мають en/uk і підказку.
- [ ] **Step 2: failing DB tests** (`roles-tool.postgres.db.test.ts`; кожен
  сценарій — свій `taggedClusterSet(<мітка>)`, `dropTaggedCluster` у `afterAll`;
  виклик — `ensurePostgresCluster` з тегованим набором, не справжній `rolesTool`;
  `plpgsql_check` і відсутність `better_auth` у шаблоні перевіряються в
  тегованій одноразовій копії `CREATE DATABASE <тег> TEMPLATE <шаблон>`, не
  з'єднанням із шаблоном):
  - атрибути й рядки `pg_auth_members` кожної ролі за §3.1; власник бази;
    `datistemplate` і `datallowconn` шаблону; `plpgsql_check` у цілі й у
    копії шаблону; `USAGE` власника на `extensions`; `better_auth` належить
    `auth`, у копії шаблону її немає; налаштування `search_path` ролі `auth`
    (`pg_db_role_setting`, рядок ролі й рядок ролі в цілі);
  - повторна перевірка перед `CREATE EXTENSION`: наявна безпечна `extensions`,
    між фазами (обгортка порту) їй дають `GRANT CREATE` тегованому `owner` —
    саме `roles.unsafe-schema`, `plpgsql_check` не встановлено (окремо від
    кейсу колізії, де `CREATE SCHEMA` без `IF NOT EXISTS` падає сам);
  - повторний виклик — `created` порожній, рядки ті самі; третій виклик після
    позначки шаблону — успіх, `created` порожній;
  - шаблон, створений суперкористувачем без позначки (перерваний запуск), —
    наступний виклик доробляє й позначає його;
  - не-суперкористувач — `roles.superuser-required`; база з іншим власником —
    `roles.database-owner`; явний `CONNECT` до іншої тегованої бази —
    `roles.shared-cluster` (ця база передається в `dropTaggedCluster` як
    додаткова); `extensions` власника, `GRANT CREATE` на `extensions`
    власнику, `better_auth` належить не `auth` — `roles.unsafe-schema`;
    шаблон, створений власником, — `roles.unsafe-template`; `owner` член
    `pg_execute_server_program`, `runtime` член `owner`, `auth` з `BYPASSRLS`,
    член-посередник з `CREATEROLE` у тегованої ролі `user` —
    `plan.platform-role-shape` (посередник — `request-path:<посередник>`, §3.1);
    для кожної відмови `pg_roles`, `pg_database` і `datacl` цілі — без змін;
  - власник створює `extensions` між фазами (обгортка порту виконує це від
    тегованого `owner` після фази читання) — `roles` падає, `plpgsql_check` у
    схемі власника не з'являється;
  - власник ставить `ALTER DATABASE <ціль> SET role = <owner>` і
    `SET search_path = public, pg_catalog`, кладе в `public` функцію й
    оператор із сигнатурами вбудованих, які SQL фази цілі справді кличе
    (перелік — з власного SQL, щонайменше одна функція й оператор `=`), що
    пишуть маркер; наступний виклик проходить як суперкористувач (власник
    `extensions` — суперкористувач) і маркера не пише; мутація — без
    прелюдії тест червоний (результат мутації — у звіт задачі) (Review Focus 4);
  - роль входу рантайму без `SET ROLE` не читає таблиці з `GRANT SELECT` лише
    ролі запиту (`setTestPasswords` у `beforeAll`).
- [ ] **Step 3:** `pnpm --filter simetra test postgres-cluster` і `pnpm test:db:pg` — FAIL.
- [ ] **Step 4:** реалізація; `rolesTool`: `postgres` — `ensurePostgresCluster`
  (`maintenance` — URL цілі з базою `postgres`, `template` — з базою шаблону),
  `shadowBase` — `plan.shadow-base-unsupported`; `supabase` — наявний шлях;
  опис інструмента англійською доповнити гілкою `postgres`.
- [ ] **Step 5:** PASS; scoped DB на Supabase `pnpm --filter @simetrajs/designer test:db roles-tool` — зелений.
- [ ] **Step 6: Commit** — `feat(designer): simetra roles готує кластер профілю postgres`.

### Task 9: стек `postgres` — ролі, база `simetra`, шаблон і ідентичність на старті

**Files:**
- Create: `docker/postgres-stack/project/project.meta.json` — вміст
  `{ "name": "simetra-dev", "database": { "provider": "postgres" } }`; тека
  поза шаблоном `*metadata`, тож `metadata:check` її не компілює
- Create: `packages/simetra/test/db/better-auth-cli.ts` (Р13),
  `packages/simetra/test/db/better-auth-cli.postgres.db.test.ts`,
  `packages/simetra/test/db/stack-roles.postgres.db.test.ts`
- Modify: `docker/postgres-stack/dev-secrets.env` (`SIMETRA_OWNER_DEV_PASSWORD`,
  `SIMETRA_RUNTIME_DEV_PASSWORD`, `SIMETRA_AUTH_DEV_PASSWORD`),
  `scripts/db-stack.mjs` (`startPostgres`), `scripts/db-stack.d.mts`,
  `packages/simetra/test/db/stack-files.test.ts`,
  `packages/simetra/test/db/pgtap/postgres/stack-base-state.pgtap.sql` (`plan(N)`
  і шапку про ролі Simetra оновити)

**Interfaces:**
- Produces (`better-auth-cli.ts`):
  - `async function prepareStackIdentity(o: { superuserUrl: string; authUrl: string; owner: string; migrate?: (authUrl: string) => Promise<void> }): Promise<void>`
    — спершу транзакція суперкористувача з прелюдією `roles` (Global
    Constraints) відкликає тимчасові гранти, якщо вони є (`REVOKE USAGE ON SCHEMA better_auth FROM <owner>`,
    `REVOKE TRIGGER ON better_auth."user" FROM <owner>`), — тоді й на теплому
    стеку збій міграції не лишає грантів над напівмігрованою схемою; далі
    `(o.migrate ?? migrateBetterAuth)(o.authUrl)` від ролі `auth`; лише після її
    успіху — одна транзакція суперкористувача з прелюдією: перевірка, що
    `better_auth."user"` — таблиця (`relkind = 'r'`), якою володіє `auth`
    (інакше виняток без гранту), потім `GRANT USAGE ON SCHEMA better_auth TO <owner>`,
    `GRANT TRIGGER ON better_auth."user" TO <owner>`; `migrate` — шов тесту;
  - точка входу CLI: DSN — зі змінних середовища `SIMETRA_SUPERUSER_URL` і
    `SIMETRA_AUTH_URL` (не argv), `owner` — `PROVIDER_OWNER_ROLES.postgres`;
    код виходу 1 з повідомленням англійською на збій.

- [ ] **Step 1: failing tests:**
  - `stack-files.test.ts` — `project.meta.json` стека з
    `database.provider: "postgres"`; `dev-secrets.env` має три паролі;
    `startPostgres` кличе `better-auth-cli.ts` після кроку `roles` і паролів;
  - набір базового стану (pgTAP, база `postgres`) — лише кластерні факти:
    ролі §3.1 (без ролей сигналів) з атрибутами (`pg_roles`) і членствами
    (`pg_auth_members`); `simetra` належить `simetra_owner` (`pg_database`);
    `simetra_template` — `datistemplate` і `NOT datallowconn`; налаштування
    `search_path` ролі `simetra_auth` (`pg_db_role_setting`);
  - `stack-roles.postgres.db.test.ts`: у `simetra` схема `better_auth` належить
    `simetra_auth`, `plpgsql_check` стоїть у `extensions`; колонки
    `better_auth."user"` — `PROVIDER_EVENT_SOURCES.postgres` у тому самому
    порядку; `simetra_owner` має `USAGE` на `better_auth` і `TRIGGER` на
    `better_auth."user"` і не має на ній `INSERT`, `SELECT`; у тегованій
    одноразовій копії `CREATE DATABASE <тег> TEMPLATE simetra_template` —
    `plpgsql_check` є, `better_auth` немає; копія видаляється у `finally`;
  - `better-auth-cli.postgres.db.test.ts` (тегований кластер задачі 8:
    `taggedClusterSet`, `ensurePostgresCluster`, `setTestPasswords`,
    `dropTaggedCluster` у `afterAll`):
    - **повтор нічого не змінює:** `prepareStackIdentity` двічі; знімок після
      першого й другого виклику однаковий — атрибути ролей набору
      (`pg_roles`), рядки `pg_auth_members`, `has_schema_privilege` і
      `has_table_privilege` тегованого `owner` на `better_auth` і
      `better_auth."user"` (`USAGE`, `TRIGGER`, `INSERT`, `SELECT`), колонки
      `better_auth."user"` (`information_schema.columns`), `pg_db_role_setting`,
      сирі `nspacl` схеми `better_auth` і `relacl` кожного відношення в ній
      (гранти `PUBLIC`, іншим ролям, `WITH GRANT OPTION`), перелік `pg_class`
      схеми `better_auth`;
    - **збій міграції не лишає грантів:** `migrate` — справжня міграція, що
      після `runMigrations` кидає, і окремо підставна, що створює частину
      таблиць і кидає; `prepareStackIdentity` кидає, у тегованого `owner`
      немає `USAGE` на `better_auth` і `TRIGGER` на `better_auth."user"`
      (якщо таблиця є); наступний виклик зі справжньою міграцією дає обидва
      гранти; те саме на «теплому» кластері — перший виклик успішний, гранти
      видано, другий з міграцією, що кидає, лишає без грантів;
    - `better_auth."user"` як подання чи таблиця іншого власника — виняток,
      гранту немає.
- [ ] **Step 2:** `pnpm --filter simetra test stack-files` і `pnpm --filter simetra test:db:pg better-auth-cli` — FAIL.
- [ ] **Step 3:** `startPostgres` після `dev-environment.sql`, під тим самим
  замком: `node packages/designer/bin/simetra.mjs roles docker/postgres-stack/project`
  з `SIMETRA_DATABASE_URL` суперкористувача до бази `simetra`; потім паролі
  ролям входу від суперкористувача через stdin `psql` (`\set` і
  `ALTER ROLE … PASSWORD :'pw'`, як `dev-environment.sql` через `input:`), не
  `-v` в argv; потім `node --import tsx packages/simetra/test/db/better-auth-cli.ts`
  з `SIMETRA_SUPERUSER_URL` (суперкористувач до `simetra`) і
  `SIMETRA_AUTH_URL` (`simetra_auth` з `SIMETRA_AUTH_DEV_PASSWORD` до
  `simetra`) у середовищі дочірнього процесу. Шапку `db-stack.mjs` про «без
  залежностей» уточнити: `start postgres` вимагає `pnpm install`.
- [ ] **Step 4:** PASS; `pnpm db:pg:start` — код 0; `pnpm test:db:pg` —
  зелений; знімок стека (запит знімка тесту «повтор нічого не змінює» від
  суперкористувача до `simetra`) до й після повторного `pnpm db:pg:start` —
  однаковий, вивід обох — у звіт; uptime контейнерів `simetra-pg-*` — той
  самий; `docker ps --filter name=supabase_` — той самий uptime, якщо стек
  Supabase піднято.
- [ ] **Step 5: Commit** — `build(db): ролі Simetra, база simetra, шаблон і міграція Better Auth на старті стека postgres`.

### Task 10: тінь і копія доказу з шаблону; план на `postgres` наскрізно

**Files:**
- Create: `packages/designer/src/schema-engine/pg-delta/template-shadow.ts`
- Modify: `packages/simetra/src/schema/engine/port.ts` (`ShadowOptions.shadowTemplate?`, JSDoc англійською),
  `packages/simetra/src/schema/apply/plan.ts` (`buildPlan` — відмова `shadowBase`),
  `packages/designer/src/tools/apply-tools.ts` (вхід `rehearse` і `apply` — та сама відмова),
  `packages/designer/src/schema-engine/pg-delta/adapter.ts` (`provisionShadow(o, scope)`),
  `packages/designer/src/schema-engine/errors.ts` (`ShadowTemplateMissingError`, `ShadowBaseUnsupportedError`),
  `packages/designer/src/io/database.ts` (`classify`),
  `packages/designer/src/__tests__/support/db-setup.ts` (другий `vi.mock` на новий модуль),
  `packages/designer/src/__tests__/support/shadows.ts` (документація обліку)
- Modify (тести): `packages/simetra/src/schema/apply/__tests__/plan.test.ts`
- Create: `packages/designer/src/schema-engine/__tests__/template-shadow.postgres.db.test.ts`,
  `packages/designer/src/schema-engine/__tests__/plan.postgres.db.test.ts`

**Interfaces:**
- Produces:
  - `async function provisionTemplateShadow(baseUrl: string, template: string, opts?: ProvisionCoLocatedShadowOptions): Promise<CoLocatedShadow>`
    — перевірка `rolcreatedb OR rolsuper`; перевірка шаблону: є,
    `datistemplate`, `NOT datallowconn`, власник — суперкористувач, інакше
    `ShadowTemplateMissingError`; `provisionShadow` пропускає її до `classify`
    без перетворення на `ShadowCreateRefusedError`; `CREATE DATABASE "pgdelta_shadow_<suffix>" TEMPLATE "<template>"`;
    ім'я, типовий суфікс і `cleanup` — як у `provisionCoLocatedShadow`;
  - `provisionShadow(o, scope)`: шаблон = `o.shadowTemplate ?? PROVIDER_SHADOW_TEMPLATES[scope.provider]`;
    `null` — `provisionCoLocatedShadow`; інакше `provisionTemplateShadow`;
    `scope.provider === "postgres"` з `o.shadowBase` — `ShadowBaseUnsupportedError`;
  - `buildPlan` і вхід `rehearse`/`apply`: `provider === "postgres"` з
    `shadowBase` — діагностика `plan.shadow-base-unsupported` до
    `checkPlatformRoles` і до будь-якого звернення до бази;
  - `ShadowTemplateMissingError { template: string }` — `classify` друкує
    шаблон і пораду `simetra roles`; `ShadowBaseUnsupportedError` — гілка
    `classify` з кодом `plan.shadow-base-unsupported`.

- [ ] **Step 1: failing tests:**
  - unit (`plan.test.ts`): `provider: "postgres"` і `shadowBase` — відмова
    `plan.shadow-base-unsupported` до будь-якого звернення до бази (підставний
    порт не отримує жодного запиту);
  - `template-shadow.postgres.db.test.ts` (хелпер кластера задачі 8,
    `setTestPasswords` у `beforeAll`):
    тінь від тегованого `owner` має `plpgsql_check`, ім'я
    `pgdelta_shadow_<тег>…`, облік `recordProvision` її бачить, після
    `cleanup` бази немає; шаблон без позначки чи з власником `owner` —
    `ShadowTemplateMissingError` і текст `simetra roles`; два паралельні
    створення з одного шаблону — обидва успішні;
  - `plan.postgres.db.test.ts` (ролі грантів стека з задачі 9; тегована ціль
    від суперкористувача з власником — тегованим `owner` з атрибутами
    `simetra_owner` і членом нічого; міграція Better Auth на цілі від
    тегованого `auth`; паролі — `setTestPasswords`; гранти `USAGE` на `better_auth` і `TRIGGER` на
    `better_auth."user"` тегованому `owner` ставить тест від суперкористувача
    — у ПГ-3 їх дасть `roles`; `shadowTemplate` — `simetra_template` стека):
    - план і застосування моделі `examples/reference` з `provider: "postgres"`
      від тегованого `owner` проходять; тригери провізії стоять на
      `better_auth."user"`; режим `plpgsql_check` — `installed` на цілі й на
      копії доказу; у копії немає рядків `better_auth."user"` цілі;
    - текст плану не містить `CREATE SCHEMA "extensions"` і жодного `REVOKE`
      на `better_auth` (Review Focus 3);
    - каталожний гейт (`readCensus`) бачить у чужих схемах лише розширення й
      тригери провізії.
- [ ] **Step 2:** `pnpm --filter simetra test plan` і `pnpm test:db:pg` — FAIL.
- [ ] **Step 3:** реалізація; прогалина pg-delta в наскрізному плані — до
  архітекторки з фактом, не обхід.
- [ ] **Step 4:** PASS; scoped DB на Supabase
  `pnpm --filter @simetrajs/designer test:db apply-tools build-plan-provider engine-desired build-plan execute-plan` — зелені.
- [ ] **Step 5: Commit** — `feat(schema-engine): тінь профілю postgres з шаблону; план на postgres наскрізно`.

### Task 11: гейт `plan.owner-not-bypassrls`

**Files:**
- Modify: `packages/simetra/src/schema/apply/plan.ts` (`buildPlan`),
  `packages/simetra/src/schema/apply/execute.ts` (`executePlan`, фаза `role`,
  не для `mode: "proof"`), `packages/designer/src/tools/apply-tools.ts`
  (гілка `rehearse`, до `withDesiredShadow`),
  `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts`
- Modify (тести з підставними портами): `packages/simetra/src/schema/apply/__tests__/plan.test.ts`,
  `packages/simetra/src/schema/apply/__tests__/execute.test.ts`, фейки
  `apply-tools`-тестів за потреби — на запит атрибутів `current_user`
  відповідають `{ bypassrls: true, superuser: false }`
- Create: `packages/simetra/src/schema/apply/owner-gate.ts`,
  `packages/simetra/src/schema/apply/__tests__/owner-gate.test.ts`,
  `packages/designer/src/schema-engine/__tests__/owner-gate.postgres.db.test.ts`

**Interfaces:**
- Produces: `function ownerRefusal(row: { bypassrls: boolean; superuser: boolean } | undefined): EngineDiagnostic | undefined`
  і `async function checkOwnerAttributes(tx: ApplyTransaction): Promise<EngineDiagnostic | undefined>`
  (читає атрибути `current_user`; відсутній рядок — відмова, fail-closed);
  код `plan.owner-not-bypassrls` (помилка; підказка — `ALTER ROLE … BYPASSRLS`
  від суперкористувача). Виклики (Р10): `buildPlan` — у першій читальній
  транзакції після `serverVersionRefusal`, до `checkPlatformRoles`;
  `executePlan` — у транзакції застосування після advisory lock, до першого
  кроку; `rehearse` — до `withDesiredShadow`.

- [ ] **Step 1: failing tests:** unit `ownerRefusal` — відмова для
  `{ false, false }` і для відсутнього рядка; DB (`owner-gate.postgres.db.test.ts`,
  хелпер кластера задачі 8, `setTestPasswords` у `beforeAll`):
  план від ролі без `BYPASSRLS` — відмова, жодного кроку; план від ролі з
  `BYPASSRLS`, потім `ALTER ROLE … NOBYPASSRLS`, потім застосування — відмова,
  у ledger нічого; репетиція від ролі без `BYPASSRLS` — відмова до створення тіні.
- [ ] **Step 2:** `pnpm --filter simetra test owner-gate` і `pnpm test:db:pg` — FAIL.
- [ ] **Step 3:** реалізація; фейки `plan.test.ts` і `execute.test.ts`
  відповідають на новий запит.
- [ ] **Step 4:** PASS; `pnpm --filter simetra test plan execute`; scoped DB на
  Supabase `pnpm --filter @simetrajs/designer test:db build-plan execute-plan apply-tools round-trip database-tools`
  — зелені (роль `postgres` має `BYPASSRLS`; ролям, які створюють
  `round-trip.db.test.ts` і `database-tools.db.test.ts` і від яких будують план,
  у налаштуванні тесту може знадобитися `BYPASSRLS`).
- [ ] **Step 5: Commit** — `feat(schema): відмова власнику без BYPASSRLS на плані, застосуванні й репетиції`.

### Task 12: документація й гейти

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` і
  `references/people-and-rights.md` (англійською: `simetra roles` у
  `postgres` — суперкористувач через окрему змінну `--database-url-env`,
  база власника, шаблон, нові коди `roles.*`, `plan.owner-not-bypassrls`,
  `plan.shadow-base-unsupported`)
- Modify: `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` §6.2
  «Тіньова БД» (шаблон `simetra_template`) і §6.7 (профіль без сервісної
  ролі; винятки outbox — ПГ-4)
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` §6.2 —
  рядок `simetra_runtime` для `postgres`: член `simetra_user` і `simetra_anon`
  (рядка `simetra_signals` немає — ПГ-4)
- Modify: `docs/ROADMAP.md` — статус ПГ-2a

- [ ] **Step 1:** правки; без лічильників і наративу фаз.
- [ ] **Step 2: Commit** — `docs: провайдер postgres у скілі споживача й платформній спеці`.
- [ ] **Step 3:** `git merge origin/main` (без rebase).
- [ ] **Step 4:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — зелені.
- [ ] **Step 5:** `pnpm test:db:pg` — зелений; `docker ps -a --filter label=simetra-run` — порожньо.
- [ ] **Step 6:** повний `pnpm test:db` на стеку Supabase — **один раз** за блок; зелений (Review Focus 1).
- [ ] **Step 7:** `pnpm build:packages && pnpm test:packaging`; `python3 scripts/check-doc-anchors.py` — зелені.

## Готово (§12, рядок ПГ-2, частина 2a)

- `database.provider: "postgres"` компілюється; мапи T0 і T2 мають рядок
  `postgres` за §4.2; поза `provider/` немає читачів `SUPABASE_*`.
- `simetra roles` від суперкористувача готує ролі §3.1 (без ролей сигналів),
  базу власника, `plpgsql_check` і `simetra_template`; повторний запуск
  нічого не змінює; відмови — до першого запису; `pnpm db:pg:start` виконує
  його на стеку, потім міграцію Better Auth у `simetra` і тимчасові гранти
  власнику (Р13); повторний старт нічого не змінює.
- План і застосування від ролі з атрибутами `simetra_owner` проходять на
  `postgres` з тінню й копією з шаблону, `plpgsql_check` — `installed`; без
  `BYPASSRLS` — `plan.owner-not-bypassrls` на плані, застосуванні й репетиції.
- Профіль `supabase` без змін: повний `pnpm test:db` зелений.
- `better-auth` — лише devDependency `simetra`; пак-тест і лінт-зона це тримають.
