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
> **Модель ПГ-2b, на яку спирається план** (рішення архітекторки
> 2026-11-08): міграцію Better Auth і тимчасові гранти `better_auth` у базі
> `simetra` ставить `pnpm db:pg:start` під замком стека; сесія DB-тестів на
> `postgres` — суперкористувач з `SET ROLE simetra_owner`. Якщо ПГ-2b на
> `main` зробив інакше (`globalSetup`, DSN `simetra_owner`), задачі 1 і 5
> правлять те місце, яке є на `main`: прибрати тимчасові гранти там, де вони
> стоять, і відкривати окремий пул на DSN ролі гейта.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** на профілі `postgres` ідентичність Better Auth працює наскрізно:
- `simetra roles` дає власнику адресні гранти на таблицю Better Auth;
- план відмовляє зрозуміло, коли таблиці чи гранту немає і коли крок знімає
  тригер провізії;
- анонімна сесія читає як гість в обох профілях;
- рантайм не стартує на привілейованій ролі входу;
- провізію на таблиці справжньої міграції Better Auth доведено DB-тестами.

**Architecture:**
- Гранти — новий крок `ensurePostgresCluster` (T2).
- Гейти плану — у `buildPlan` поруч із наявними відмовами; замок тригера
  читає дані профілю T2.
- Гейт ролі входу — у T3 (`server/runtime.ts`), лише на першому з'єднанні
  `createCommandRuntime`. Порт `CommandDatabase` дає з'єднання однієї ролі
  входу (контракт порту, П4 §6.5).
- Вибір ролі читання за claim аноніма — на кожному читанні.
- Better Auth — лише тест-залежність `simetra`; пакет від нього не
  залежить.

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
- Команди DB-тестів — за станом після ПГ-2b (Р6 там):
  - стек `postgres` — `pnpm --filter <пакет> test:db <шаблон>`;
  - стек `supabase` — `pnpm --filter <пакет> test:db:supabase <шаблон>`;
  - повний прогін — корінь: `pnpm test:db:pg` (`postgres`) і `pnpm test:db`
    (регресія `supabase`).
- SQL, який виконує суперкористувач у `roles`, кваліфікує кожне ім'я
  (`pg_catalog.`, схема) і йде після `SET search_path = pg_catalog, pg_temp`
  (§3.4, клас CVE-2018-1058).
- Без shims (`AGENTS.md`, принцип 5): тимчасові гранти тест-інфри ПГ-2b
  прибираються в тій самій зміні, що переносить їх у `roles`.

## Рішення

Рішення Р1–Р5 ухвалила архітекторка 2026-11-08.

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Код гейта ролі входу — `command.privileged-login` у `CommandError`, а не `runtime.privileged-login`. Відмови конструктора рантайму — уже `CommandFailure` з кодами `command.*` (`command.read-role-missing`, `command.model-mismatch`) | §4.2 абзац «Межа довіри» (задача 0) |
| Р2 | `LOGIN_ROLE_REQUEST_PURPOSES.supabase = ["user", "anonymous"]`: роль входу рантайму на `supabase` стає членом `anon` з `SET`. Рантайм без членства в ролі `anonymous` профілю — `command.read-role-missing` на створенні, без запасного шляху через роль команд. Анонім — гість в обох профілях на дверях Server Function (двері PostgREST `supabase` — блок B4) | спека профілю §4.4; спека П4 §6.2 рядок `simetra_runtime` для `supabase`, §6.11 (задача 0) |
| Р3 | Сесію вважаємо анонімною, коли claim `PROVIDER_IDENTITY_SOURCES[provider].anonymousClaim` дорівнює `true` або `"true"`. SQL судить так само (`->> … = 'true'`); розбіжність дала б SQL-гостя під роллю `user`. Нового поля каталогу немає: T3 бере claim з даних T0 за `catalog.provider` | §4.4 «Анонімна сесія читає як гість» (задача 0) |
| Р8 | **Відсутній claim аноніма — відмова, а не роль `user`.** Профіль з `anonymousClaim` ≠ `null` вимагає claim зі значенням `true`, `false`, `"true"` чи `"false"`. Інакше читання й команда (`run`) відмовляють `command.unauthenticated` до будь-якого I/O; `authorizeChannels` (ПГ-4/B2, задача 11) з тим самим `sessionKind` дає `{ user: null, channels: [] }`. Команди теж: у проєкті без «Користувачів» `subjectUserFunction` за відсутнього claim повертає `sub::uuid`, тобто анонім виконав би команду з правами `everyUser`. Правило діє лише на claims із суб'єктом (`sub`): запит без суб'єкта T3 відхиляє ще до нього (Рт8), і Р8 цього не змінює. Причина: адаптер host-а, що забув claim, інакше тихо дав би анонімові права `user` (fail-open). Сесії інструментів designer (`dataSession`) і тест-помічники ставлять `false` явно (рішення автора плану після аудиту безпеки; подано архітекторці) | §4.4 (задача 0) |
| Р9 | **Гейт входу судить факти, а не ім'я.** Відмова, коли `session_user` (сам чи через будь-яке членство, `pg_has_role … 'MEMBER'`) досягає: власника схеми `simetra` (`nspowner`); ролі з іменем `PROVIDER_OWNER_ROLES[provider]`; ролі з `rolsuper`, `rolbypassrls` чи `rolcreaterole`; вбудованих `pg_execute_server_program`, `pg_read_server_files`, `pg_write_server_files`; ролі входу провайдера (`PROVIDER_LOGIN_ROLES`, на `postgres` — `simetra_auth`, власник таблиці Better Auth); сервісної ролі профілю, коли вона не `null`. Обмеження порту: `CommandDatabase` входить роллю входу напряму; пул, що входить суперкористувачем і робить `SET SESSION AUTHORIZATION`, — поза моделлю довіри (такий host уже тримає DSN суперкористувача), це записано в JSDoc `CommandRuntimeOptions.database`. `NOINHERIT` тут не захищає: `SET ROLE` дає владу ролі | §4.2 «Межа довіри» (задача 0) |
| Р10 | Адаптер `verifySession` Better Auth — у шаблоні host-а (П4-D, `packages/create-simetra-app/template`), а не в цьому плані, хоч §12 спеки називає його в ПГ-3 (рішення архітекторки, межа з П4-D) | §12 рядок ПГ-3 (задача 0) |
| Р4 | `plan.identity-trigger-locked` судить дані T2 `PROVIDER_IDENTITY_TRIGGER_LOCKED = { supabase: false, postgres: true }`, а не факт власності таблиці. Факт стека Supabase: роль `postgres` знімає тригер на `auth.users`, хоч не власник і не суперкористувач (supautils). Гейт за власністю зламав би `supabase` | §4.2 таблиця мап, новий рядок (задача 0) |
| Р5 | `plan.identity-table-missing` — спільна перевірка фактів в обох профілях: `to_regclass` таблиці ідентичності й `has_table_privilege(current_user, …, 'TRIGGER')`. Діє лише тоді, коли бажаний стан має тригери провізії. На стеку Supabase обидві умови істинні (перевірено) | немає |
| Р6 | Запис пресету й генерацію тригерів провізії дає ПГ-2a. Цей план лише доводить їх DB-тестами життєвого циклу | немає |
| Р7 | Гранти `better_auth` — крок `ensurePostgresCluster` після створення схеми. Таблиці ще немає — крок `TRIGGER` іде в `skipped`, а не у відмову. Тимчасові гранти тест-інфри (Р3 ПГ-2b) замінює повторний виклик `roles` після міграції | немає |

## Review Focus

1. **Claim аноніма рядком чи відсутній.** Сесія з `is_anonymous: "true"`
   (рядок) читає під роллю аноніма, а не `user`. Без claim — відмова
   `command.unauthenticated`. Тест — задача 4, `it.each` на `true`,
   `"true"`, `false`, `"false"`, `1`, відсутній claim.
2. **Непрямий привілей.** Роль входу без власних `BYPASSRLS` і `SUPERUSER`,
   але з членством (`SET`) у ролі з ними, у власникові схеми `simetra` чи в
   сервісній ролі, рантайму не створює. Тест — задача 5.
3. **Нова таблиця Better Auth.** Після `roles` у `better_auth` з'являється
   нова таблиця (нова версія Better Auth). Власник не має на неї `TRIGGER`:
   типових привілеїв на схему немає. Тест — задача 1.
4. **Гонка провізії.** Дві паралельні транзакції провізують той самий
   `subject`: ідентичність одна, обидві бачать той самий `user_id`.
   Окремо — дві вставки того самого `id` у `better_auth."user"`: друга
   падає `23505` на ключі Better Auth, рядок «Користувачів» один. Тест —
   задача 6.
5. **Заміна тригера провізії.** Живий тригер провізії відрізняється від
   бажаного. Якщо план його знімає (`DROP`), на `postgres` —
   `plan.identity-trigger-locked`, а на `supabase` план проходить. Заміна
   `CREATE OR REPLACE` проходить в обох профілях. Тест — задача 3.

---

### Task 0: поправки спек

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-postgres-profile-design.md` —
  §4.2:
  - «Межа довіри»: `runtime.privileged-login` → `command.privileged-login` (Р1);
  - таблиця мап: новий рядок `PROVIDER_IDENTITY_TRIGGER_LOCKED` зі
    значенням `true` (Р4);
  - абзац «Зняття й заміна тригера»: гейт судить ці дані й відмовляє лише
    на `DROP TRIGGER`; `CREATE OR REPLACE TRIGGER` потребує лише привілею
    `TRIGGER` і проходить.
  
  «Межа довіри» — правило фактів Р9.
  
  §4.4: ознака аноніма — `true` або `"true"` (Р3); відсутній claim —
  відмова (Р8); правило діє на `supabase` через членство `anon` (Р2), на
  дверях Server Function.
  
  §12 рядок ПГ-3 (його правиш лише ти, ПГ-2a не чіпає) — разом:
  - обсяг: `command.privileged-login` (Р1; замість `runtime.privileged-login`
    з Р7 ПГ-2a); перенесення тимчасових грантів `USAGE`/`TRIGGER` з
    `pnpm db:pg:start` у `roles`, з тестом на тегованому кластері;
    `pnpm db:roles`; адаптер `verifySession` — у П4-D (Р10);
  - «Готово»: «міграція з `database.schemaName: "better_auth"`» →
    «міграція через `search_path = better_auth`, без `schemaName`».
  
  §4.2 крок 2 — те саме про `search_path`, якщо ПГ-2 цього не вніс.
  
  §13 рядок «спека профілів провайдера | ПП5»: `database.schemaName` →
  `search_path` ролі `simetra_auth`.
- Modify: `docs/superpowers/specs/2026-10-23-provider-profiles-design.md`
  ПП5: «опція `database.schemaName` вбудованого адаптера» → «`search_path`
  ролі міграції й пулу Better Auth (`schemaName` шле `CREATE SCHEMA`, а роль
  міграції не має `CREATE` на базу)».
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md`:
  - §6.2 — рядок `simetra_runtime` для `supabase`: член `authenticated` і
    `anon`, обидва `INHERIT FALSE, SET TRUE`;
  - §6.5 — перший оператор транзакції створення рантайму: факти ролі входу
    (Р9);
  - §6.10 — рядок коду `command.privileged-login` у таблиці кодів;
    `command.unauthenticated` дістає причину «немає claim аноніма» (Р8);
  - §6.11 — роль читання за claim аноніма. Інваріант 10 («те саме, що
    PostgREST») — уточнити: для аноніма на `supabase` двері розходяться до
    B4.

- [ ] **Step 1:** правки за переліком. Без лічильників і наративу фаз.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): ідентичність Better Auth — рішення плану ПГ-3`.

### Task 1: `simetra roles` — адресні гранти `better_auth`

**Files:**
- Modify (після ПГ-2): `packages/simetra/src/schema/apply/postgres-cluster.ts`
  (`PostgresClusterSet`, `postgresClusterSet`, `ensurePostgresCluster`)
- Modify: `packages/designer/src/tools/roles-tool.ts` (`RolesData`,
  `SkippedRole`), `packages/designer/src/cli/render.ts` (гілка `roles`)
- Modify (після ПГ-2): `scripts/db-stack.mjs` — крок `pnpm db:pg:start`, що
  під замком стека ставить тимчасові гранти `USAGE`/`TRIGGER` для
  `simetra_owner` у базі `simetra` (рішення ПГ-2b). Міграцію Better Auth
  крок лишає, а гранти замінює повторним `simetra roles` після неї. Звірка
  guard стану схеми `better_auth` з порадою «`pnpm db:pg:start`» не
  змінюється. Інші місця ручних грантів знайди так:
  `grep -rn "GRANT TRIGGER\|GRANT USAGE ON SCHEMA better_auth" packages/*/src packages/*/test scripts`.
- Modify (після ПГ-2): тести ПГ-2a, що ставлять гранти `better_auth` руками
  від суперкористувача — `packages/designer/src/schema-engine/__tests__/plan.postgres.db.test.ts`,
  `template-shadow.postgres.db.test.ts` та інші за grep кроку 4. Ручні
  гранти замінює `ensurePostgresCluster` тегованого кластера після
  `migrateBetterAuth`.
- Test (після ПГ-2): `packages/simetra/src/schema/apply/__tests__/postgres-cluster.test.ts`,
  `packages/designer/src/__tests__/roles-tool.test.ts`,
  `packages/designer/src/__tests__/roles-tool.postgres.db.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_IDENTITY_SOURCES.postgres.table`, `PostgresClusterSet`
  з полями `owner`, `auth`, `ensurePostgresCluster` з фазами читання й запису
  (ПГ-2a).
- Produces:
  - `PostgresClusterSet.identity: { schema: string; name: string }` — з
    `PROVIDER_IDENTITY_SOURCES.postgres.table`. Схема `better_auth` не
    тегується; у тестах теговані лише база й ролі;
  - `PostgresClusterOutcome.skipped: string[]` — нове поле;
  - фаза читання `ensurePostgresCluster` на з'єднанні цілі читає (лише коли
    схема вже є в `pg_namespace`; інакше обидва гранти — `created` у фазі
    запису, а таблиці немає) `has_schema_privilege(owner, schema, 'USAGE')`, `pg_catalog.to_regclass(<qualified>)`
    і (коли таблиця є) `has_table_privilege(owner, <qualified>, 'TRIGGER')`;
  - фаза запису, після створення схеми `better_auth`:
    - `GRANT USAGE ON SCHEMA <schema> TO <owner>` — `created`, якщо гранту
      не було, інакше `present`;
    - таблиця є → `GRANT TRIGGER ON <qualified> TO <owner>`, звіт так само;
    - таблиці немає → `skipped` дістає `"<schema>.<name>:TRIGGER"`. Це не
      відмова;
    - жодного `ALTER DEFAULT PRIVILEGES` і жодного гранту на інші таблиці
      схеми;
  - `SkippedRole.reason` дістає значення `"identity-table-missing"`, а
    `rolesTool` мапить кожен запис `skipped` у `RolesData.skipped`;
  - `render.ts` друкує для нього рядок англійською: «`<table>`: TRIGGER not
    granted yet — run the Better Auth migration, then `simetra roles`
    again». Наявний текст про `project.meta.json` лишається для своєї
    причини.

- [ ] **Step 1: failing unit tests:**
  - `postgres-cluster.test.ts`: `postgresClusterSet("app").identity`
    дорівнює `PROVIDER_IDENTITY_SOURCES.postgres.table`;
  - `roles-tool.test.ts`: пропуск `identity-table-missing` дає свій рядок
    CLI, а не текст про `project.meta.json`.
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
- [ ] **Step 3:** `pnpm --filter simetra test postgres-cluster`,
  `pnpm --filter @simetrajs/designer test roles-tool` і
  `pnpm --filter @simetrajs/designer test:db roles-tool` — FAIL.
- [ ] **Step 4:** реалізація. У `pnpm db:pg:start` тимчасові гранти заміни
  повторним `simetra roles` після міграції Better Auth. DB-тести гранту
  йдуть на тегованому кластері (`taggedClusterSet`, ПГ-2a), а не на спільній
  базі `simetra`. Ручних грантів не лишається:
  `grep -rn "GRANT TRIGGER\|GRANT USAGE ON SCHEMA better_auth" packages/*/src packages/*/test scripts`
  дає лише генератор `postgres-cluster.ts` і кейси задач 1–2, що
  відкликають чи ставлять грант навмисно.
- [ ] **Step 5:** повторний `pnpm db:pg:start` (ідемпотентний, під замком
  стека; дозволено, ПГ-2b) — зелений, guard звірку `better_auth` проходить;
  PASS; повний `pnpm test:db:pg` зелений (знімок guard без залишків).
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
- Consumes: `PROVIDER_IDENTITY_SOURCES[provider].table`; `model.sqlUnits`.
- Produces:
  - `function hasIdentityTriggers(units: readonly SqlUnit[], table: { schema: string; name: string }): boolean`
    — є одиниця з `class === "trigger"`, `generator === "platformLayer"` і
    `identity`, що починається з `trigger:<schema>.<name>.`. Це умова «бажаний
    стан має тригери провізії»;
  - `interface IdentityTableFacts { usage: boolean; exists: boolean; trigger: boolean; triggers: string[] }`
    — `triggers` — імена наявних нетехнічних тригерів таблиці (звіт плану й
    тест задачі 3);
  - `function identityTableRefusal(facts: IdentityTableFacts, table: string): EngineDiagnostic | undefined`:
    - `usage: false` чи `exists: true, trigger: false` → reason `privilege`;
    - `exists: false` → reason `table`;
  - код `plan.identity-table-missing` (помилка), параметри `{ table, reason }`;
  - підказки через `hintOf` за `reason`:
    - `table` — «run the Better Auth migration as the provider login role,
      then `simetra roles` again»;
    - `privilege` — «run `simetra roles` again as superuser»;
  - факти читаються в тій самій транзакції `buildPlan`, що кличе
    `serverVersionRefusal`, і лише коли `hasIdentityTriggers`. Спершу oid
    схеми з `pg_catalog.pg_namespace`: схеми немає — `usage: false,
    exists: false` і reason `table`, бо `has_schema_privilege` на відсутній
    схемі кидає `3F000`. Далі за oid — `has_schema_privilege(current_user, oid, 'USAGE')`:
    без `USAGE` `to_regclass` кидає `42501`, а не дає `NULL`. Далі, лише з `USAGE` —
    `to_regclass`, `has_table_privilege(current_user, …, 'TRIGGER')` і
    `SELECT tgname FROM pg_catalog.pg_trigger WHERE tgrelid = … AND NOT tgisinternal`.
    Ім'я — через `qualified`/`quoteIdent`. Відмова — до першого кроку, в
    обох профілях (Р5).

- [ ] **Step 1: failing tests:**
  - unit: `identityTableRefusal` — чотири стани фактів, `undefined` лише для
    повних; `hasIdentityTriggers` на моделі з «Користувачами» й без;
  - DB `postgres` — на тегованому кластері (`taggedClusterSet`,
    `setTestPasswords`, ПГ-2a), не на спільній базі `simetra`; міграція
    Better Auth — лише в кейсах, яким потрібна таблиця:
    - ціль без міграції Better Auth — `reason: "table"`, жодного кроку;
    - після міграції без `TRIGGER` (`REVOKE` від суперкористувача в тесті) —
      `reason: "privilege"`;
    - без `USAGE` на `better_auth` — `reason: "privilege"`, а не внутрішня
      помилка;
    - без схеми `better_auth` — `reason: "table"`;
  - DB `supabase`: наявні кейси `build-plan-provider` зелені (Р5).
- [ ] **Step 2:** `pnpm --filter simetra test plan` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; scoped DB обох стеків —
  `pnpm --filter @simetrajs/designer test:db plan` і
  `pnpm --filter @simetrajs/designer test:db:supabase build-plan-provider` — зелені.
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
    — тригер з `IDENTITY_TRIGGERS` на таблиці ідентичності, який крок
    знімає (`destroyed`). Для нього — діагностика
    `plan.identity-trigger-locked` (помилка), параметри
    `{ trigger, table, login }`. `login` = `PROVIDER_LOGIN_ROLES[provider][0]`.
    Підказка: виконати крок від цієї ролі; якщо живий тригер змінено поза
    Simetra — це ознака підробки, звір її з власником таблиці. Крок
    `CREATE OR REPLACE TRIGGER` (лише `produced`) не відмовляє: Postgres
    вимагає для нього лише привілею `TRIGGER`, який власник має (задача 1);
  - виклик в **обох** шляхах плану, лише коли
    `PROVIDER_IDENTITY_TRIGGER_LOCKED[provider]`: у `buildPlan` після
    `classifySteps` і в `planPromotion` над кроками промоції (`buildPlan`
    повертає `planPromotion` раніше, ніж будує звичайні кроки). Відмова — план не пишеться.
    Перше створення тригера не відмовляє. Зміна тіла
    функції провізії не відмовляє (§4.2).

- [ ] **Step 1: failing tests:**
  - unit:
    - `destroyed` тригера провізії — відмова;
    - лише `produced` (заміна чи створення) — ні;
    - інший тригер тієї самої таблиці — ні;
    - дані `false` — ні;
  - DB `postgres` (Review Focus 5): модель застосовано. Тест від ролі `auth`
    (власник таблиці) перевизначає живий тригер провізії: `CREATE OR REPLACE TRIGGER`
    з тим самим іменем, але без умови `WHEN` чи з іншою подією. Наступний
    план тієї самої моделі хоче повернути бажаний тригер. Якщо крок —
    `DROP`+`CREATE` (`destroyed`), очікується `plan.identity-trigger-locked`
    і жодного кроку. Якщо крок — `CREATE OR REPLACE`, план проходить, а
    застосування від тегованого власника повертає бажаний тригер. Форму
    кроку запиши у звіт фактом; тест перевіряє ту гілку, яку дав рушій;
  - unit, шлях промоції: `planPromotion` з кроком, що має `destroyed`
    тригера провізії, — та сама відмова (кроки — фікстура unit-тестів
    промоції);
  - DB `supabase`: той самий сценарій у тегованій базі тестів провайдера
    (як `build-plan-provider.supabase.db.test.ts`), з відновленням тригера у
    `finally`. Спільна база стека не зачіпається. З'єднання
    `testSuperuserUrl()` (`supabase_admin`), `SET ROLE supabase_auth_admin`
    (власник таблиці), `CREATE OR REPLACE TRIGGER` у тегованій базі — план
    без відмови.
- [ ] **Step 2:** `pnpm --filter simetra test plan` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; scoped DB обох стеків — як у задачі 2.
- [ ] **Step 5: Commit** — `feat(schema): план не знімає тригер провізії на таблиці Better Auth`.

### Task 4a: `pnpm db:roles` — ролі на запущеному стеку `supabase`

**Files:**
- Modify: `scripts/db-stack.mjs` — дія `roles` профілю `supabase`: під тим
  самим замком стека, що й `start`/`stop` (`withStackLock`), виконує
  `supabase/roles.sql` на запущеному стеку від ролі `postgres`. Форма —
  рецепт з першого рядка файлу:
  `docker exec -i supabase_db_simetra psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f -`.
  Стек не запущено — помилка з порадою `pnpm db:start`.
- Modify: `package.json` (корінь) — скрипт `db:roles`
- Modify: `supabase/roles.sql` — ідемпотентність для доданих членств:
  кожне членство, яке додає файл, ставиться поза блоком `IF NOT EXISTS` ролі,
  під власною перевіркою `pg_auth_members`. Перше таке членство — `anon`
  для `simetra_runtime` (задача 4). Жодного `ALTER`/`DROP` наявних ролей чи
  членств
- Modify: перший рядок-коментар `supabase/roles.sql` — рецепт замінює
  «`pnpm db:roles`»
- Create: `packages/simetra/test/db/db-roles.supabase.db.test.ts` або кейс
  у наявному тесті скриптів стека (`packages/simetra/test/db/stack-files.test.ts`
  — для статичної частини)

**Interfaces:**
- Produces: команда `pnpm db:roles`. Межі (рішення архітекторки, Р11 плану
  ПГ-4/B2):
  - лише `CREATE` відсутнього і членства, які додає сам файл;
  - під замком стека;
  - CI стартує зі свіжого тому й команди не потребує.
- **Інваріант для інших гілок:** роль чи членство, які додає `roles.sql`,
  не робить нову роль членом ролей, які перевіряють гейти форми
  (`LOGIN_ROLE_PARENTS`, власник), і не дає їм нових членів. Тоді гейти
  гілок без цих ролей не червоніють. Членство `simetra_runtime` в `anon`
  — пара, яку гейт ролей цієї гілки очікує (Р2).

- [ ] **Step 1: failing tests:**
  - статичний (`stack-files.test.ts`): кожен `GRANT … TO` у `roles.sql` стоїть
    під перевіркою `pg_auth_members` або в блоці створення своєї ролі;
    `ALTER ROLE`/`DROP` у файлі немає;
  - DB (`db-roles.supabase.db.test.ts`): знімок `pg_roles` і
    `pg_auth_members` ролей Simetra до й після повторного виконання
    `roles.sql` у транзакції з `ROLLBACK` — однаковий.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація.
- [ ] **Step 4:** `pnpm db:roles` двічі на спільному стеку (дозволено, Р11) —
  другий прогін нічого не змінює; `pnpm exec supabase test db` — зелений.
- [ ] **Step 5:** рядок `AGENTS.md` (розділ «Commands and gates») — **задача
  власника**. Виконавець пише текст у звіт:
  `pnpm db:roles                            # apply supabase/roles.sql to the running Supabase stack (additive, idempotent)`.
  Сам `AGENTS.md` не править.
- [ ] **Step 6: Commit** — `build(db): pnpm db:roles — ролі на запущеному стеку Supabase`.

### Task 4: роль читання за claim аноніма

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts` (`LOGIN_ROLE_REQUEST_PURPOSES.supabase`, Р2)
- Modify: `packages/simetra/src/server/runtime.ts` (`readRoleOf`, `inspect`,
  `createCommandRuntime`, `readRows`), `packages/simetra/src/server/transaction.ts`
  (`RuntimeState`), `packages/simetra/src/server/index.ts`
- Modify: `packages/designer/src/io/data.ts` (`dataSession` — claim аноніма
  `false`, коли `anonymousClaim` ≠ `null`; Р8)
- Modify: `supabase/roles.sql` — членство `simetra_runtime` в `anon`
  `WITH INHERIT FALSE, SET TRUE` за правилом ідемпотентності задачі 4a; на
  спільному стеку його ставить `pnpm db:roles` (задача 4a)
- Modify: `supabase/tests/provider-base-state.test.sql` — `VALUES` у
  `results_eq` членств `simetra_runtime`: пара `('anon', false, false, true)`
  стає першою (`ORDER BY 1`); опис перевірки й коментар «рівно дві пари» —
  «три»; `plan(…)` не змінюється
- Modify: тест-помічники й тести, що будують роль входу рантайму чи claims
  читання:
  - `packages/designer/src/__tests__/support/db.ts` (`withRuntimeLogin`);
  - `command-runtime.support.ts`, `rights-admin-commands.support.ts`,
    `tenant-creation.support.ts`;
  - `command-time.db.test.ts`, `wide-text-columns.db.test.ts`,
    `read-query.db.test.ts`, `data-handler.db.test.ts`,
    `rights-maintenance.db.test.ts`, `data-tools.db.test.ts`.
  
  Перелік звір так: `grep -rln "withRuntimeLogin\|REQUEST_ROLE\|readRoleOf" packages/designer/src packages/simetra/src packages/simetra/test`.
  Членство в ролі `anonymous` профілю дає `withRuntimeLogin` за
  `LOGIN_ROLE_REQUEST_PURPOSES`, а не кожен виклик. Claims читання дістають
  claim аноніма `false` через один помічник сесії тестів.
- Test: `packages/simetra/src/server/__tests__/read-runtime.test.ts`,
  `runtime.test.ts` (наявний виклик `readRoleOf("supabase", { supabase: purposes }, PROVIDER_API_ROLES)`
  — за новою сигнатурою), `harness.ts`; DB —
  `packages/designer/src/__tests__/read-anonymous.support.ts`,
  `read-anonymous.db.test.ts` (стек `postgres`),
  `read-anonymous.supabase.db.test.ts`

**Interfaces:**
- Produces:
  - `readRoleOf(provider, purposes?, roles?, purpose: RequestRolePurpose = "user"): string | undefined`
    — роль призначення, якщо вона є в `purposes[provider]`. Порядок перших
    трьох параметрів не змінюється;
  - `export function sessionKind(provider: DatabaseProvider, claims: SessionClaims): "user" | "anonymous" | "invalid"`:
    - `anonymousClaim` `null` → `"user"`;
    - claim `true` чи `"true"` → `"anonymous"` (Р3);
    - `false` чи `"false"` → `"user"`;
    - інакше (відсутній, `1`, `null`, інший рядок) → `"invalid"` (Р8);
  - `RuntimeState.readRoles: { user?: string; anonymous?: string }` замість
    `readRole`;
  - `inspect` приймає перелік ролей призначень профілю й повертає
    `members: Record<RequestRolePurpose, boolean>`. Членство кожної ролі за
    замовчуванням — `false`. `42704` на одній ролі означає `false` лише для
    неї: повтор перевіряє решту;
  - на створенні:
    - немає членства в ролі `user` — як зараз (`readFallback` діє лише тут);
    - роль `anonymous` профілю є в `purposes`, а членства немає —
      `command.read-role-missing` з `role`, `readFallback` не діє;
  - читання:
    - `"invalid"` → `command.unauthenticated`;
    - `"anonymous"` → `SET LOCAL ROLE <readRoles.anonymous>`;
    - профіль без ролі `anonymous` → `command.unauthenticated`. Ніколи не
      роль `user` і не роль команд;
    - `"user"` — як зараз.
  
  Команди: `run` перевіряє `sessionKind` до I/O так само — `"invalid"` →
  `command.unauthenticated` (Р8). Анонімна команда йде як зараз: її судить
  `current_user_id()` = `NULL`.
- Фейкова база (`harness.ts`) відповідає на перевірку членства кожної ролі.

- [ ] **Step 1: failing unit tests:**
  - `sessionKind` — `it.each` (Review Focus 1):
    - `true`, `"true"` → `anonymous`;
    - `false`, `"false"` → `user`;
    - `1`, `null`, `"yes"`, відсутній → `invalid`;
    - профіль без `anonymousClaim` → `user`;
  - `read-runtime.test.ts`:
    - claims аноніма → `SET LOCAL ROLE` ролі `anonymous`;
    - `invalid` → `command.unauthenticated` без запиту до бази, і для
      `read`, і для `run` (`it.each` за входом);
    - підставлений профіль без `anonymous` у `purposes` — анонім отримує
      `command.unauthenticated`;
    - `readFallback: true` без членства `anonymous` —
      `command.read-role-missing` на створенні;
    - `42704` лише на ролі `anonymous` — `read-role-missing` для неї, роль
      `user` перевірено;
  - `readRoleOf("supabase", undefined, undefined, "anonymous")` =
    `PROVIDER_API_ROLES.supabase.anonymous`;
  - `dataSession` ставить `is_anonymous: false`.
- [ ] **Step 2: failing DB tests** (`read-anonymous.support.ts` — спільне тіло
  кейсів, два тонкі файли за профілем). Фікстура — об'єкт з
  `publicRead: anon` і об'єкт з `publicRead: authenticated`. Рантайм — на
  тегованій ролі входу. Перевірки:
  - анонімні claims бачать рядки лише першого об'єкта;
  - звичайний користувач бачить обидва;
  - `"true"` поводиться так само, як `true`;
  - claims з `sub`, але без claim аноніма — `command.unauthenticated`;
  - запит без суб'єкта — claims форми справжнього запиту без сесії (на
    `supabase` — `{ role: "anon" }` ключа `anon`, на `postgres` — `{}`) —
    `command.unauthenticated` до будь-якого запиту в базу. Так само було до
    Р8 (Рт8, `sessionClaimsSchema` вимагає `sub`); кейс фіксує, що Р8 цього
    не змінює (уточнення архітекторки).
- [ ] **Step 3:** `pnpm --filter simetra test runtime read-runtime` і
  `pnpm --filter @simetrajs/designer test data` — FAIL.
- [ ] **Step 4:** реалізація; помічники за переліком.
- [ ] **Step 5:** PASS; scoped DB:
  - `postgres` — `pnpm --filter @simetrajs/designer test:db read-anonymous command data-handler read-query wide-text rights tenant-creation`;
  - `supabase` — `pnpm --filter @simetrajs/designer test:db:supabase read-anonymous`;
  - перед DB-кейсами `supabase` — `pnpm db:roles`;
  - `pnpm exec supabase test db` (набір базового стану) — зелений.
- [ ] **Step 6: Commit** — `feat(server): анонімна сесія читає роллю гостя в обох профілях`.

### Task 5: гейт ролі входу рантайму `command.privileged-login`

**Files:**
- Modify: `packages/simetra/src/model/runtime/errors.ts` — код
  `"command.privileged-login"` у `COMMAND_ERROR_CODES` (`envelope.ts` бере
  перелік через `z.enum`)
- Modify: `packages/simetra/src/server/runtime.ts` (`inspect`)
- Modify: `packages/simetra/src/server/__tests__/harness.ts`
- Test: `packages/simetra/src/server/__tests__/runtime.test.ts`;
  `packages/simetra/src/model/__tests__/` — тест переліку кодів чи
  конверта, якщо він перелічує коди;
  `packages/designer/src/__tests__/command-runtime.db.test.ts` (стек
  `postgres`) і `command-runtime.supabase.db.test.ts` (стек `supabase`)

**Interfaces:**
- Produces:
  - `CommandError` з `code: "command.privileged-login"` і наявним полем
    `reason`: `"owner"`, `"superuser"`, `"bypassrls"`, `"createrole"`,
    `"server-files"`, `"provider-login"`, `"service"`. Ці
    значення — новий перелік `PRIVILEGED_LOGIN_REASONS` поруч із
    `LIMIT_REASONS` у `errors.ts`, з тим самим оформленням документації.
    Причина `service` на наявних профілях недосяжна окремо: `service_role`
    `supabase` має `BYPASSRLS` і спрацьовує раніше, а в `postgres` сервісної
    ролі немає. Її тримає unit-кейс;
  - у `inspect` перший оператор після `BEGIN READ ONLY` — факти ролі входу
    (Р9):
    ```sql
    SELECT
      COALESCE((SELECT pg_catalog.pg_has_role(session_user, n.nspowner, 'MEMBER')
                FROM pg_catalog.pg_namespace n WHERE n.nspname = $1), false)
        OR COALESCE((SELECT pg_catalog.pg_has_role(session_user, o.oid, 'MEMBER')
                     FROM pg_catalog.pg_roles o WHERE o.rolname = $2), false) AS owner,
      EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolsuper
              AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS superuser,
      EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolbypassrls
              AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS bypassrls,
      EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolcreaterole
              AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS createrole,
      EXISTS (SELECT FROM pg_catalog.pg_roles x
              WHERE x.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files')
              AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS server_files,
      EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolname = ANY ($4::text[])
              AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS provider_login,
      COALESCE((SELECT pg_catalog.pg_has_role(session_user, s.oid, 'MEMBER')
                FROM pg_catalog.pg_roles s WHERE s.rolname = $3), false) AS service
    ```
    `$1` = `PLATFORM_SCHEMA`, `$2` = `PROVIDER_OWNER_ROLES[catalog.provider]`,
    `$3` = `PROVIDER_API_ROLES[catalog.provider].service` (на `null` —
    `NULL`, тоді `false`), `$4` = `PROVIDER_LOGIN_ROLES[catalog.provider]`.
    `pg_has_role(…, 'MEMBER')` бачить і саму роль, і
    непряме членство незалежно від `INHERIT` і `SET`;
  - причина — перша істинна в порядку `owner`, `superuser`, `bypassrls`,
    `createrole`, `server-files`, `provider-login`, `service`. Відмова — до
    звірки хешу (`command.model-mismatch`). З'єднання звільняється;
  - запит фактів — безумовний перший оператор **кожної** транзакції
    `inspect`, зокрема повтору після `42704` на членстві. Повтор не має
    прапорця пропуску гейта.
- `DATA_GUARD_FACTS_SQL` designer не змінюється. Він судить роль
  інструмента до створення рантайму; рантайм тепер судить не слабше.

- [ ] **Step 1: failing tests:**
  - unit (`runtime.test.ts`, фейкова база): кожна причина → своя відмова;
    `42704` на ролі `anonymous` разом із `bypassrls: true` →
    `command.privileged-login` (повтор теж судить факти);
    усі `false` → рантайм створюється; відмова іде раніше за
    `command.model-mismatch` за хибного хешу;
  - теговані ролі входу DB-кейсів — `LOGIN` з `TEST_LOGIN_PASSWORD`
    (`setTestPasswords` чи `CREATE ROLE … LOGIN PASSWORD` від суперкористувача);
  - DB (Review Focus 2), стек `postgres`. Звичайна сесія тестів на
    `postgres` — суперкористувач з `SET ROLE simetra_owner` (ПГ-2b), тож
    `session_user` там — суперкористувач. Кожен кейс гейта відкриває
    **окремий пул на DSN своєї ролі входу** (`roleUrl`, ПГ-2a), а не
    спільний пул тестів:
    - DSN стекового `simetra_owner` (пароль з `dev-secrets.env`, ПГ-2b) —
      `owner`;
    - тегований власник цілі теста (власник схеми `simetra`, ім'я не
      `simetra_owner`) — `owner`, за фактом `nspowner`;
    - тегована роль без атрибутів, член тегованої ролі з `BYPASSRLS` з
      `SET` — `bypassrls`;
    - тегована роль, член власника через проміжну роль, — `owner`;
    - тегована роль, член ролі з `BYPASSRLS` **з `INHERIT FALSE, SET TRUE`**
      (на PG16+ таке членство дає `SET ROLE` без успадкування), — `bypassrls`.
      Мутація: заміна `'MEMBER'` на `'USAGE'` у запиті фактів — кейс
      червоніє (рішення архітекторки);
    - тегована роль, член ролі входу провайдера `simetra_auth` стека
      (фіксоване ім'я з `PROVIDER_LOGIN_ROLES`; тегована `auth` гейт не
      бачить), — `provider-login`. Членство знімається разом із тегованою
      роллю; член `pg_read_server_files` — `server-files`;
    - тегована роль входу форми `simetra_runtime` — рантайм створюється;
  - DB, стек `supabase`: DSN ролі `postgres` — `owner`; тегована роль, член
    `service_role`, — `bypassrls` (`service_role` має `BYPASSRLS`;
    причину запиши фактом).
- [ ] **Step 2:** `pnpm --filter simetra test runtime` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; `pnpm --filter @simetrajs/designer test:db command-runtime`
  і `pnpm --filter @simetrajs/designer test:db:supabase command-runtime` —
  зелені. Наявні DB-тести designer, що створюють рантайм, зелені на стеку
  `postgres`:
  `pnpm --filter @simetrajs/designer test:db command data-handler read-query rights tenant-creation wide-text`.
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
- видалення: `DELETE FROM better_auth."user" WHERE id = $1` від ролі `auth`
  (так видаляє `deleteUser`; API потребує `user.deleteUser.enabled` і
  верифікації, тож тест іде напряму) → ідентичність видалено, рядок
  «Користувачів» лишається з `invalid`;
- гонка провізії (Review Focus 4):
  - порядок фіксований: A `BEGIN` і виклик з `p_user_id` = X, B `BEGIN` і
    виклик з тим самим `subject` і `p_user_id` = Y (B чекає замка), A
    `COMMIT`, B завершується. Обидва результати — X, ідентичність одна.
    Тобто дві паралельні транзакції (два з'єднання тегованого власника: функція
    провізії не має `EXECUTE` для ролей застосунку) кличуть
    `simetra.provision_user(...)` з тим самим `subject`. Ідентичність одна,
    обидві повертають той самий `user_id`;
  - дві вставки `better_auth."user"` з тим самим `id` від ролі `auth`
    (колонки `id`, `name`, `email`, `"emailVerified"`, `"createdAt"`,
    `"updatedAt"`, `"isAnonymous"`):
    друга — `23505` на ключі Better Auth, рядок «Користувачів» один;
- claims: `{ sub: <id>, is_anonymous: false }` → `current_user_id()` під
  `commandAs` — id «Користувачів» (так само, як кейс `valid` у
  `platform-users.supabase.db.test.ts`); `{ sub: <анонім>, is_anonymous: true }`
  → `NULL`, бо анонім не провізований (`currentUserFunction` claim аноніма
  не читає); `sub` з великими літерами → `NULL`, бо ключ — `sub` у нижньому
  регістрі (§4.4);
- рядок пресету: колонки `PROVIDER_EVENT_SOURCES.postgres` є в таблиці
  міграції.

- [ ] **Step 1:** написати кейси. Вони мають бути червоні лише там, де бракує
  коду задач 1–5; решта — доказ ПГ-2a. Кожен червоний кейс назви у звіті з
  причиною.
- [ ] **Step 2:** `pnpm --filter simetra test:db platform-users` — FAIL
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
  - анонім — гість; claim аноніма обов'язковий (Р8);
  - для наявного розгортання `supabase` — крок
    `GRANT anon TO <runtime login> WITH INHERIT FALSE, SET TRUE` (Р2), інакше
    рантайм не створюється (`command.read-role-missing`).
- Modify: `docs/ROADMAP.md` — статус ПГ-3 у рядку профілю `postgres`

- [ ] **Step 1:** правки. Без лічильників і наративу фаз.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs: ідентичність Better Auth у скілі споживача й ROADMAP`.

### Task 8: гейти

- [ ] **Step 1:** `git merge origin/main` (без rebase).
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — зелені.
- [ ] **Step 3:** `pnpm metadata:check` — зелений.
- [ ] **Step 4:** повний DB-набір стека `postgres` (`pnpm test:db:pg`) — зелений;
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
  `current_user_id()` з claims Better Auth дає id провізованого
  користувача, а для аноніма й чужого регістру `sub` — `NULL`.
