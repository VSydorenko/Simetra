# ПГ-3 — ідентичність Better Auth: план реалізації

> **Статус:** проєкт плану, 2026-11-08; приймає архітекторка
> `runtime-client-data`. Блок ПГ-3 спеки профілю `postgres`. Стартує після
> мерджу ПГ-2a і ПГ-2b на `main`.
> **Межа з П4-D.** Адаптер `verifySession` над Better Auth і dev-користувач
> живуть у шаблоні host-а `packages/create-simetra-app/template` (тонкий зріз
> П4-D, інша сесія). Цей план дає те, на що адаптер спирається: гранти
> `better_auth`, гейти плану, вибір ролі читання за claim аноніма, гейт
> ролі входу рантайму й DB-тести життєвого циклу.
> **Спільні стеки.** Обидва локальні стеки спільні для сесій машини.
> Виконавець **ніколи** не виконує `pnpm db:stop`, `pnpm db:start`,
> `pnpm db:pg:stop`, `supabase stop`. DB-тести запускає лише через
> `pnpm --filter … test:db*` під замками стеків.
> **Перед стартом:** `.agents/skills/codebase-research/scripts/orient --plan <цей файл>`.
> Якорі з позначкою «після ПГ-2» звір з кодом `main`:
> `ensurePostgresCluster`, `PostgresClusterSet`, `PostgresClusterOutcome`,
> `PROVIDER_OWNER_ROLES`, `PROVIDER_LOGIN_ROLES`, `LOGIN_ROLE_PARENTS`,
> `migrateBetterAuth`, `RolePurpose`, `asRole`, `queryAs`, `signUp`,
> `testProvider`, тимчасові гранти `better_auth` у тест-інфрі (Р3 плану
> ПГ-2b). Якщо розходиться ім'я — перейменуй у плані за кодом. Якщо
> розходиться поведінка — звертайся до архітекторки.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** на профілі `postgres` ідентичність Better Auth працює наскрізно:
- `simetra roles` дає власнику адресні гранти на таблицю Better Auth;
- план відмовляє зрозуміло, коли таблиці чи гранту немає і коли крок знімає
  тригер провізії;
- анонімна сесія читає як гість в обох профілях;
- рантайм не стартує на привілейованій ролі входу;
- провізію на таблиці справжньої міграції Better Auth доведено DB-тестами.

**Architecture:** гранти — новий крок `ensurePostgresCluster` (T2). Гейти
плану — у `buildPlan` поруч із наявними відмовами; замок тригера читає дані
профілю T2. Вибір ролі читання й гейт входу — у T3 (`server/runtime.ts`):
обидва на першому з'єднанні `createCommandRuntime` і на кожному читанні.
Better Auth — лише тест-залежність `simetra`; пакет від нього не залежить.

**Tech Stack:** TypeScript 7, Zod, Vitest 5, `pg` 8.23.1, Postgres 17 (стек
`simetra-pg`), стек Supabase CLI, `better-auth` 1.7.12 і `kysely` (лише
devDependency з ПГ-2a).

**Spec:** [спека профілю `postgres`](../specs/2026-11-08-postgres-profile-design.md):
§3.1, §4.1–§4.4, §12 рядок ПГ-3. Також [спека П4](../specs/2026-10-26-p4-runtime-design.md)
§6.2 і §6.11, [спека системної схеми](../specs/2026-10-07-system-schema-users-design.md)
С3–С5 і §12. Правила тестів — скіл `writing-tests`.

## Global Constraints

- Мова: коментарі — українською й пояснюють «чому». Діагностики (en/uk),
  `CommandError` і повідомлення CLI — англійською за `messages.ts`. JSDoc
  експортованого API — англійською.
- Коміти: Conventional Commits, опис українською, без трейлерів. Push і PR
  робить архітекторка.
- Імена ролей, схем і таблиці ідентичності в коді беруться лише з даних
  T0/T2: `PROVIDER_IDENTITY_SOURCES`, `PROVIDER_API_ROLES`,
  `PROVIDER_OWNER_ROLES`, `PROVIDER_LOGIN_ROLES`. Літерал у споживачі
  заборонено.
- Better Auth у тестах налаштовано **без** `database.schemaName`. Таблиці
  лягають у `better_auth` через `search_path`: `ALTER ROLE <auth> SET search_path = better_auth`
  ставить `roles` (ПГ-2a), а пул тесту додає `options=-c search_path=better_auth`.
  Причина: Better Auth 1.7.12 з `schemaName` шле `CREATE SCHEMA`, а роль
  `auth` не має `CREATE` на базу (рішення архітекторки).
- Конфіг Better Auth у тестах: `advanced.database.generateId: "uuid"`,
  плагін `anonymous()`, `emailAndPassword.enabled: true`, без
  `session.cookieCache` (§4.4).
- Профіль `supabase` змінюється лише за Р2. Решта його поведінки та сама:
  наявні DB-тести `db-supabase` зелені.
- Об'єкти DB-тестів створюються лише через хелпери тегу
  (`packages/simetra/test/db/connection.ts`).
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`).
- Без shims (`AGENTS.md`, принцип 5): тимчасові гранти тест-інфри ПГ-2b
  прибираються в тій самій зміні, що переносить їх у `roles`.

## Рішення

Рішення Р1–Р5 ухвалила архітекторка 2026-11-08.

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Код гейта ролі входу — `command.privileged-login` у `CommandError`, а не `runtime.privileged-login`. Відмови конструктора рантайму — уже `CommandFailure` з кодами `command.*` (`command.read-role-missing`, `command.model-mismatch`) | §4.2 абзац «Межа довіри» (задача 0) |
| Р2 | `LOGIN_ROLE_REQUEST_PURPOSES.supabase = ["user", "anonymous"]`: роль входу рантайму на `supabase` стає членом `anon` з `SET`. Анонімна сесія без цього членства — `command.read-role-missing` на створенні рантайму, без запасного шляху через роль команд. Анонім — гість в обох дверях | спека профілю §4.4; спека П4 §6.2 рядок `simetra_runtime` для `supabase` (задача 0) |
| Р3 | Сесію вважаємо анонімною, коли claim `PROVIDER_IDENTITY_SOURCES[provider].anonymousClaim` дорівнює `true` або `"true"`. SQL судить так само (`->> … = 'true'`); розбіжність дала б SQL-гостя під роллю `user`. Нового поля каталогу немає: T3 бере claim з даних T0 за `catalog.provider` | §4.4 «Анонімна сесія читає як гість» (задача 0) |
| Р4 | `plan.identity-trigger-locked` судить дані T2 `PROVIDER_IDENTITY_TRIGGER_LOCKED = { supabase: false, postgres: true }`, а не факт власності таблиці. Факт стека Supabase: роль `postgres` знімає тригер на `auth.users`, хоч не власник і не суперкористувач (supautils). Гейт за власністю зламав би `supabase` | §4.2 таблиця мап, новий рядок (задача 0) |
| Р5 | `plan.identity-table-missing` — спільна перевірка фактів в обох профілях: `to_regclass` таблиці ідентичності й `has_table_privilege(current_user, …, 'TRIGGER')`. Діє лише тоді, коли бажаний стан має тригери провізії. На стеку Supabase обидві умови істинні (перевірено) | немає |
| Р6 | Запис пресету й генерацію тригерів провізії дає ПГ-2a. Цей план лише доводить їх DB-тестами життєвого циклу | немає |
| Р7 | Гранти `better_auth` — крок `ensurePostgresCluster` після створення схеми. Таблиці ще немає — крок `TRIGGER` іде в `skipped`, а не у відмову. Тимчасові гранти тест-інфри (Р3 ПГ-2b) замінює повторний виклик `roles` після міграції | немає |

## Review Focus

1. **Claim аноніма рядком.** Сесія з `is_anonymous: "true"` (рядок) читає
   під роллю аноніма, а не `user`. Тест — задача 4, `it.each` на `true`,
   `"true"`, `false`, `"false"`, відсутній claim.
2. **Непрямий власник.** Роль входу, що не є власником, але член його
   (через проміжну роль), чи роль з `BYPASSRLS`, рантайму не створює. Тест —
   задача 5.
3. **Нова таблиця Better Auth.** Після `roles` у `better_auth` з'являється
   нова таблиця (нова версія Better Auth). Власник не має на неї `TRIGGER`:
   типових привілеїв на схему немає. Тест — задача 1.
4. **Конкурентна реєстрація того самого `id`.** Два з'єднання вставляють
   `user` з тим самим `id`. Комітиться одне, ідентичність і рядок
   «Користувачів» — по одному. Тест — задача 6.
5. **Заміна тригера провізії.** Зміна, що перестворює тригер (наприклад,
   інша `anonymousColumn` пресету в тестовому профілі), на `postgres`
   відмовляє `plan.identity-trigger-locked`, а на `supabase` проходить.
   Тест — задача 3.

---

### Task 0: поправки спек

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-postgres-profile-design.md` —
  §4.2:
  - «Межа довіри»: `runtime.privileged-login` → `command.privileged-login` (Р1);
  - таблиця мап: новий рядок `PROVIDER_IDENTITY_TRIGGER_LOCKED` зі
    значенням `true` (Р4);
  - абзац «Зняття й заміна тригера»: гейт судить ці дані.
  
  §4.4: ознака аноніма — `true` або `"true"` (Р3); правило діє на `supabase`
  через членство `anon` (Р2). §12 рядок ПГ-3: прибрати «міграція з
  `database.schemaName: "better_auth"`» — якщо ПГ-2 цього ще не зробив.
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` §6.2 —
  рядок `simetra_runtime` для `supabase`: член `authenticated` і `anon`, обидва
  `INHERIT FALSE, SET TRUE`; §6.11 — роль читання за claim аноніма.

- [ ] **Step 1:** правки за переліком. Без лічильників і наративу фаз.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): ідентичність Better Auth — рішення плану ПГ-3`.

### Task 1: `simetra roles` — адресні гранти `better_auth`

**Files:**
- Modify (після ПГ-2): `packages/simetra/src/schema/apply/postgres-cluster.ts`
  (`PostgresClusterSet`, `postgresClusterSet`, `ensurePostgresCluster`)
- Modify (після ПГ-2): тест-інфра, що ставить тимчасові гранти `better_auth`
  (Р3 плану ПГ-2b; знайди `grep -rn "GRANT TRIGGER" packages/simetra/test scripts`)
- Test (після ПГ-2): `packages/simetra/src/schema/apply/__tests__/postgres-cluster.test.ts`,
  `packages/designer/src/__tests__/roles-tool.postgres.db.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_IDENTITY_SOURCES.postgres.table`, `PostgresClusterSet` з
  полями `owner`, `auth` (ПГ-2a).
- Produces:
  - `PostgresClusterSet.identity: { schema: string; name: string }`.
    `postgresClusterSet` бере його з `PROVIDER_IDENTITY_SOURCES.postgres.table`,
    тести — з тегованої схеми, якщо ПГ-2a тегує схему (звір).
  - Крок 9 `ensurePostgresCluster`, на з'єднанні цілі, після кроку схеми
    `better_auth`:
    - `GRANT USAGE ON SCHEMA <identity.schema> TO <owner>`. Якщо
      `has_schema_privilege` уже істинний — `present`, інакше `created`.
    - `to_regclass(<qualified identity>)` не `NULL` → `GRANT TRIGGER ON <qualified> TO <owner>`.
      Звітує `present`/`created` так само.
    - `to_regclass` дає `NULL` → запис `skipped` з формою
      `"<schema>.<name>:TRIGGER"`. Це не відмова.
    - Жодного `ALTER DEFAULT PRIVILEGES` і жодного гранту на інші таблиці
      схеми.
  - Рядок у `skipped` CLI показує так само, як наявні пропуски (`render.ts`
    `roles`).

- [ ] **Step 1: failing unit test** (`postgres-cluster.test.ts`):
  `postgresClusterSet("app").identity` дорівнює `PROVIDER_IDENTITY_SOURCES.postgres.table`.
- [ ] **Step 2: failing DB tests** (`roles-tool.postgres.db.test.ts`, тегований
  кластер задачі 7 ПГ-2a):
  - до міграції Better Auth: `USAGE` є, у `skipped` — `better_auth.user:TRIGGER`,
    виклик успішний;
  - після `migrateBetterAuth` повторний виклик:
    `has_table_privilege(owner, 'better_auth."user"', 'TRIGGER')` — `true`;
    `TRIGGER` уже в `created`, а не в `skipped`;
  - третій виклик — `created` порожній (ідемпотентність);
  - Review Focus 3: від ролі `auth` створити `better_auth.extra(id int)`.
    `has_table_privilege(owner, 'better_auth.extra', 'TRIGGER')` — `false`.
    `pg_default_acl` для схеми `better_auth` не має рядків.
- [ ] **Step 3:** `pnpm --filter simetra test postgres-cluster` і
  `pnpm --filter @simetrajs/designer test:db:pg roles-tool` — FAIL.
  Скрипт DB-тестів назви за станом після ПГ-2b.
- [ ] **Step 4:** реалізація. Тимчасові гранти тест-інфри (Р3 ПГ-2b) заміни
  повторним `ensurePostgresCluster` після міграції Better Auth у тому самому
  місці. Ручний `GRANT` у тест-інфрі не лишається:
  `grep -rn "GRANT TRIGGER\|GRANT USAGE ON SCHEMA better_auth" packages/*/test scripts` — порожньо.
- [ ] **Step 5:** PASS; повний DB-проєкт стека `postgres` зелений (знімок
  guard без залишків).
- [ ] **Step 6: Commit** — `feat(schema): roles дає власнику адресні гранти таблиці Better Auth`.

### Task 2: гейт `plan.identity-table-missing`

**Files:**
- Modify: `packages/simetra/src/schema/apply/plan.ts` (`buildPlan`; поруч із
  блоком платформних ролей)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/` (unit рішення),
  `packages/designer/src/schema-engine/__tests__/plan.postgres.db.test.ts`
  (після ПГ-2), `packages/designer/src/schema-engine/__tests__/build-plan-provider.supabase.db.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_IDENTITY_SOURCES[provider].table`; вхід
  `providerTriggerConflicts` (`model.sqlUnits` з генератором із
  `PROVIDER_TRIGGER_GENERATORS`) — він і є умовою «бажаний стан має тригери
  провізії».
- Produces:
  - `function identityTableRefusal(facts: { exists: boolean; trigger: boolean }, table: string): EngineDiagnostic | undefined`
    — `exists: false` → reason `table`; `exists: true, trigger: false` →
    reason `privilege`;
  - код `plan.identity-table-missing` (помилка), параметри `{ table, reason }`;
  - підказки через `hintOf` за `reason`:
    - `table` — «run the Better Auth migration as the provider login role,
      then `simetra roles` again»;
    - `privilege` — «run `simetra roles` again as superuser»;
  - читання фактів — у першій читальній транзакції `buildPlan`:
    `SELECT to_regclass($1) IS NOT NULL AS exists, CASE WHEN to_regclass($1) IS NULL THEN false ELSE has_table_privilege(current_user, $1, 'TRIGGER') END AS trigger`.
    Ім'я таблиці — з `qualified`/`quoteIdent`. Відмова — до першого кроку,
    в обох профілях (Р5).

- [ ] **Step 1: failing tests:**
  - unit: `identityTableRefusal` — три стани фактів, `undefined` лише для
    `{ true, true }`;
  - DB `postgres`: ціль без міграції Better Auth — `plan.identity-table-missing`
    з `reason: "table"`, жодного кроку. Після міграції, але без
    `TRIGGER` (`REVOKE` від суперкористувача в тесті) — `reason: "privilege"`;
  - DB `supabase`: наявні кейси `build-plan-provider` зелені (Р5).
- [ ] **Step 2:** `pnpm --filter simetra test plan` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; scoped DB обох стеків —
  `pnpm --filter @simetrajs/designer test:db:pg plan` і
  `pnpm --filter @simetrajs/designer test:db build-plan-provider` — зелені.
- [ ] **Step 5: Commit** — `feat(schema): відмова плану без таблиці ідентичності чи гранту TRIGGER`.

### Task 3: гейт `plan.identity-trigger-locked`

**Files:**
- Modify: `packages/simetra/src/schema/engine/provider/presets.ts` (поруч із
  `PROVIDER_LOCKS`)
- Modify: `packages/simetra/src/compiler/platform/units.ts` — експорт імен тригерів
- Modify: `packages/simetra/src/schema/apply/plan.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: unit поруч із тестами `plan.ts`; DB — ті самі файли, що в задачі 2

**Interfaces:**
- Produces:
  - `export const PROVIDER_IDENTITY_TRIGGER_LOCKED: Readonly<Record<DatabaseProvider, boolean>> = { supabase: false, postgres: true }`;
  - `export const IDENTITY_TRIGGERS: readonly string[]` — значення наявної
    мапи `TRIGGERS` у `platform/units.ts`; мапа лишається джерелом;
  - `function identityTriggerLocks(steps: readonly PlanStep[], table: { schema: string; name: string }): EngineDiagnostic[]`
    — для кожного кроку, чий `destroyed` має
    `{ kind: "trigger", schema: table.schema, table: table.name }` з іменем з
    `IDENTITY_TRIGGERS`: діагностика `plan.identity-trigger-locked` (помилка),
    параметри `{ trigger, table, login }`. `login` =
    `PROVIDER_LOGIN_ROLES[provider][0]`; підказка — виконати крок від цієї
    ролі;
  - виклик у `buildPlan` після побудови кроків, лише коли
    `PROVIDER_IDENTITY_TRIGGER_LOCKED[provider]`. Відмова — план не пишеться.
    Перше створення тригера (лише `produced`) не відмовляє. Зміна тіла
    функції провізії не відмовляє (§4.2).

- [ ] **Step 1: failing tests:**
  - unit: крок з `destroyed` тригера провізії на таблиці ідентичності —
    відмова; крок з `destroyed` іншого тригера тієї самої таблиці — ні; з
    `produced` — ні; той самий крок, але дані `false` — ні;
  - DB `postgres` (Review Focus 5): модель застосовано. Друга модель
    перестворює тригер конвертації: тестовий пресет з іншою
    `anonymousColumn`, колонку додає тест від ролі `auth`. План —
    `plan.identity-trigger-locked`, жодного кроку;
  - DB `supabase`: та сама пара моделей на `auth.users` дає план без
    відмови.
- [ ] **Step 2:** `pnpm --filter simetra test plan` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; scoped DB обох стеків — як у задачі 2.
- [ ] **Step 5: Commit** — `feat(schema): план не знімає тригер провізії на таблиці Better Auth`.

### Task 4: роль читання за claim аноніма

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts` (`LOGIN_ROLE_REQUEST_PURPOSES.supabase`, Р2)
- Modify: `packages/simetra/src/server/runtime.ts` (`readRoleOf`, `inspect`,
  `createCommandRuntime`, читання), `packages/simetra/src/server/transaction.ts`
  (`RuntimeState`), `packages/simetra/src/server/index.ts`
- Modify: `supabase/roles.sql` — `simetra_runtime` член `anon` з
  `INHERIT FALSE, SET TRUE`; `supabase/tests/provider-base-state.test.sql` —
  перевірка цього членства, `plan(…)` + 1
- Modify: тест-помічники ролі входу рантайму, які дають членство лише в ролі
  `user`:
  - `packages/designer/src/__tests__/support/db.ts`;
  - `command-runtime.support.ts`, `rights-admin-commands.support.ts`,
    `tenant-creation.support.ts`, `data-tools.db.test.ts`.
  
  Перелік перерахуй: `grep -rln "SET TRUE" packages/*/src/__tests__ packages/*/test`.
- Test: `packages/simetra/src/server/__tests__/read-runtime.test.ts`,
  `runtime.test.ts`, `harness.ts`; DB — `packages/designer/src/__tests__/read-anonymous.support.ts`,
  `read-anonymous.db.test.ts` (стек `postgres`), `read-anonymous.supabase.db.test.ts`

**Interfaces:**
- Produces:
  - `readRoleOf(provider, purpose: RequestRolePurpose = "user", purposes?, roles?): string | undefined`
    — роль призначення, якщо вона є в `purposes[provider]`. Наявні виклики
    без `purpose` не змінюються (`dataSession` у designer);
  - `export function isAnonymousSession(provider: DatabaseProvider, claims: SessionClaims): boolean`
    — `anonymousClaim` `null` → `false`; інакше значення claim `=== true || === "true"` (Р3);
  - `RuntimeState.readRoles: { user?: string; anonymous?: string }` замість
    `readRole`. `inspect` перевіряє членство `SET` для кожної ролі
    призначення профілю тим самим `MEMBER`. Без членства в ролі
    `anonymous` — `command.read-role-missing` з `role`. `readFallback` її не
    обходить, бо стосується лише `user`;
  - читання: `isAnonymousSession` → `SET LOCAL ROLE <anonymous>`, інакше — як
    зараз. Команди не змінюються: їх судить `current_user_id()` = `NULL`.
- Фейкова база (`harness.ts`) відповідає на другий запит членства.

- [ ] **Step 1: failing unit tests:**
  - `isAnonymousSession` — `it.each` (Review Focus 1): `true`, `"true"` → так;
    `false`, `"false"`, `1`, відсутній claim → ні; профіль без `anonymousClaim` → ні;
  - `read-runtime.test.ts`: claims аноніма → оператор `SET LOCAL ROLE`
    ролі `anonymous` профілю; звичайні claims → роль `user`;
    `readFallback: true` без членства `anonymous` —
    `command.read-role-missing` на створенні;
  - `readRoleOf("supabase", "anonymous")` = `PROVIDER_API_ROLES.supabase.anonymous`.
- [ ] **Step 2: failing DB tests** (`read-anonymous.support.ts`: спільне тіло
  кейсів, два тонкі файли за профілем). Фікстура — об'єкт з `publicRead: anon`
  і об'єкт з `publicRead: authenticated`. Рантайм на тегованій ролі входу.
  Перевірки:
  - анонімні claims бачать рядки лише першого об'єкта;
  - звичайний користувач бачить обидва;
  - анонім з `"true"` поводиться так само, як з `true`.
- [ ] **Step 3:** `pnpm --filter simetra test runtime read-runtime` — FAIL.
- [ ] **Step 4:** реалізація; помічники ролі входу дають і членство `anonymous`.
- [ ] **Step 5:** PASS; scoped DB:
  - стек `postgres` — `read-anonymous`, `command-runtime`, `data-handler`;
  - стек `supabase` — `read-anonymous`;
  - `supabase test db` базового стану — зелений.
- [ ] **Step 6: Commit** — `feat(server): анонімна сесія читає роллю гостя в обох профілях`.

### Task 5: гейт ролі входу рантайму `command.privileged-login`

**Files:**
- Modify: `packages/simetra/src/model/runtime/errors.ts` (варіант `CommandError`)
- Modify: `packages/simetra/src/server/runtime.ts` (`inspect`)
- Modify: `packages/simetra/src/server/__tests__/harness.ts`
- Test: `packages/simetra/src/server/__tests__/runtime.test.ts`,
  `packages/designer/src/__tests__/command-runtime.db.test.ts` (обидва стеки
  через профіль; тонкий `*.supabase.db.test.ts`, якщо файл профіль не
  перемикає)

**Interfaces:**
- Produces:
  - `CommandError` варіант `{ code: "command.privileged-login"; reason: "owner" | "owner-member" | "superuser" | "bypassrls" }`;
  - у `inspect` перший оператор після `BEGIN READ ONLY` — факти `session_user`:
    ```sql
    SELECT r.rolsuper, r.rolbypassrls, r.rolname = $1 AS owner,
      COALESCE((SELECT pg_catalog.pg_has_role(session_user, o.oid, 'MEMBER')
                FROM pg_catalog.pg_roles o WHERE o.rolname = $1), false) AS owner_member
    FROM pg_catalog.pg_roles r WHERE r.rolname = session_user
    ```
    `$1` = `PROVIDER_OWNER_ROLES[catalog.provider]`. Порядок причин:
    `owner`, `owner-member`, `superuser`, `bypassrls` — перша істинна.
    Відмова — до звірки хешу (`command.model-mismatch`). З'єднання
    звільняється.
- `DATA_GUARD_FACTS_SQL` designer не змінюється: його гейт інструмента
  вужчий і діє раніше.

- [ ] **Step 1: failing tests:**
  - unit (`runtime.test.ts`, фейкова база): кожна причина з таблиці → своя
    відмова; усі `false` → рантайм створюється. Відмова іде раніше за
    `command.model-mismatch` за хибного хешу;
  - DB (Review Focus 2):
    - рантайм на DSN тегованого власника (`postgres`) або ролі `postgres`
      стека (`supabase`) — `owner` / `bypassrls`;
    - тегована роль, член власника через проміжну роль, — `owner-member`;
    - тегована роль з `BYPASSRLS` — `bypassrls`;
    - тегована роль входу форми `simetra_runtime` — рантайм створюється.
- [ ] **Step 2:** `pnpm --filter simetra test runtime` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; scoped DB `command-runtime` обох стеків — зелений.
  Наявні DB-тести designer, що створюють рантайм, зелені на стеку `postgres`:
  `pnpm --filter @simetrajs/designer test:db:pg command data-handler read-query rights-admin tenant-creation wide-text`.
- [ ] **Step 5: Commit** — `feat(server): рантайм відмовляє привілейованій ролі входу`.

### Task 6: DB-тести життєвого циклу на справжній міграції Better Auth

**Files:**
- Modify (після ПГ-2): `packages/simetra/test/db/better-auth.ts` — фабрика
  тестового екземпляра
- Create: `packages/simetra/test/db/platform-users.postgres.db.test.ts`
- Reference: `packages/simetra/test/db/platform-users.supabase.db.test.ts` (форма кейсів)

**Interfaces:**
- Produces: `function testAuth(url: string): { auth: ReturnType<typeof betterAuth>; close(): Promise<void> }`.
  Конфіг — за Global Constraints. Пул з `options=-c search_path=better_auth`,
  `url` — DSN тегованої ролі `auth` до тегованої бази. `migrateBetterAuth`
  бере той самий конфіг (одне джерело).

Кейси (`describe("platform users layer on Better Auth")`). База — тегована,
з моделлю з «Користувачами», застосованою від тегованого власника, і з
міграцією та грантами задачі 1. Події йдуть через `auth.api`, крім двох, де
API немає:
- реєстрація `signUpEmail` → одна ідентичність `(better-auth, id)` і один
  рядок «Користувачів» з іменем з `name`; порожнє `name` → ім'я з `email`;
- анонімний вхід `signInAnonymous` → провізії немає;
- прив'язка: сесія аноніма (cookie з `returnHeaders`) → `signUpEmail` →
  новий користувач провізований, анонімний `user` видалено, жодного
  `invalid`;
- конвертація на місці: `UPDATE better_auth."user" SET "isAnonymous" = false`
  від ролі `auth` → провізія один раз; повтор `UPDATE` — без дубля;
- видалення: `deleteUser` (або `DELETE` від ролі `auth`, якщо API вимагає
  верифікації) → ідентичність видалено, рядок «Користувачів» лишається з
  `invalid`;
- конкурентна реєстрація того самого `id` (Review Focus 4): два з'єднання
  ролі `auth`, обидва `BEGIN; INSERT … id = $1`, перше `COMMIT`, друге —
  `23505`. Ідентичностей одна, рядок «Користувачів» один;
- claims: `{ sub: <id>, is_anonymous: false }` → `current_user_id()` під
  `commandAs` — id «Користувачів»; `{ sub: <анонім>, is_anonymous: true }`
  → `NULL`; `sub` з великими літерами → `NULL`. Ключ — `sub` у нижньому
  регістрі (§4.4); обидва результати збігаються з кейсами
  `platform-users.supabase.db.test.ts`;
- рядок пресету: колонки `PROVIDER_EVENT_SOURCES.postgres` є в таблиці
  міграції.

- [ ] **Step 1:** написати кейси. Вони мають бути червоні лише там, де бракує
  коду задач 1–5; решта — доказ ПГ-2a. Кожен червоний кейс назви у звіті з
  причиною.
- [ ] **Step 2:** `pnpm --filter simetra test:db:pg platform-users` — FAIL
  (чи PASS для доказових кейсів, з переліком).
- [ ] **Step 3:** фабрика `testAuth`, зміни міграційного хелпера.
- [ ] **Step 4:** PASS; `docker ps -a --filter label=simetra-run` — порожньо.
- [ ] **Step 5: Commit** — `test(db): провізія користувачів на таблиці справжньої міграції Better Auth`.

### Task 7: документація

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/references/people-and-rights.md`
  (англійською):
  - `simetra roles` на `postgres`: гранти `better_auth`, пропуск до
    міграції, повтор після неї;
  - коди `plan.identity-table-missing`, `plan.identity-trigger-locked`,
    `command.privileged-login`;
  - анонім — гість.
- Modify: `docs/ROADMAP.md` — статус ПГ-3 у рядку профілю `postgres`
- Modify: `docs/superpowers/specs/2026-11-08-postgres-profile-design.md` §13 —
  рядки «спека П4 §6.2» і «§6.11» позначити внесеними, якщо таблиця це веде

- [ ] **Step 1:** правки. Без лічильників і наративу фаз.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs: ідентичність Better Auth у скілі споживача й ROADMAP`.

### Task 8: гейти

- [ ] **Step 1:** `git merge origin/main` (без rebase).
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — зелені.
- [ ] **Step 3:** `pnpm metadata:check` — зелений.
- [ ] **Step 4:** DB-набір стека `postgres` (`pnpm test:db:pg`) — зелений;
  `docker ps -a --filter label=simetra-run` — порожньо.
- [ ] **Step 5:** повний `pnpm test:db` на стеку Supabase — **один раз** за
  блок, після всіх задач; зелений (Р2 змінює `supabase`).
- [ ] **Step 6:** `pnpm build:packages && pnpm test:packaging` — зелені;
  тарбол не містить `better-auth`.

## Готово (§12, рядок ПГ-3)

- `simetra roles` на `postgres` дає власнику `USAGE` на `better_auth` і
  `TRIGGER` лише на таблицю ідентичності. До міграції — названий пропуск.
  Тимчасових грантів у тест-інфрі немає.
- План від `simetra_owner` ставить тригери провізії на `better_auth."user"`.
  Без таблиці чи гранту — `plan.identity-table-missing`. Крок зняття чи
  заміни тригера — `plan.identity-trigger-locked`. На `supabase` план тих
  самих моделей проходить.
- Анонімна сесія (`true` чи `"true"`) читає лише `publicRead: anon` в обох
  профілях.
- Рантайм не створюється на ролі власника, його члені, суперкористувачі чи
  ролі з `BYPASSRLS`.
- DB-тести провізії на таблиці справжньої міграції Better Auth зелені.
  `current_user_id()` з claims Better Auth дає той самий результат, що й на
  `supabase`.
