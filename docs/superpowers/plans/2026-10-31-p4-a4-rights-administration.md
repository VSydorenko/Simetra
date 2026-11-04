# П4-A4: адміністрування прав — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: чернетка автора; розвилки Р1–Р5 вирішено архітекторкою 2026-11-04;
до аудиту.
Архітекторка задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** команди адміністрування прав §6.12 доведено через `runtime.run` над
тінню рушія; план віддає повний структурований перелік сиріт прав, з якого
клієнт складає пакет очистки; інструмент designer `rights-maintenance` (лише
командний рядок, `--yes`) під входом мігратора робить перше глобальне
призначення, відновлення глобального `fullAccess` і першого власника тенанта.

**Архітектура:**

- **T3 нового механізму не отримує.** Пакет — масив `Operation[]`; дію
  контексту `administerRights` T3 бере з каталогу (`operations.<операція>.context`);
  відмови запобіжників `escalation`, `role-in-use`, `last-full-access`,
  `delta-domain` T3 мапить і на `COMMIT` (`mapDatabaseError`,
  `packages/simetra/src/server/errors.ts`). Блок додає тести, що це доводять.
- **T0** (`packages/simetra/src/model/runtime/`): кодування значень реквізиту
  за каталогом рантайму переїжджає з T3 у T0 без зміни поведінки, щоб ним
  користувалися і T3, і інструмент T2; нова функція `encodeMemberValues` —
  спільна валідація значень рядка учасника (A6 перевикористає її для
  `creatorMember`).
- **T2** (`packages/simetra/src/schema/apply/`): повний перелік сиріт
  `RightsOrphans` у фактах джерел прав і в результаті плану; ядро інструмента
  обслуговування `runRightsMaintenance`; `ApplyDbError` несе `detail`,
  `column`, `constraint`.
- **designer:** `Tool.cliOnly` і причина відмови `cli-only`; інструмент
  `rights-maintenance`; `PlanData.rightsOrphans`; DB-тести команд прав і
  інструмента.
- **Документи:** спека П4 §6.12, §6.15, §7.1, Додаток А; спека прав §7;
  спека designer (перелік інструментів, `cliOnly`); скіл споживача
  `simetra-metadata`; ROADMAP.

**Стек технологій:** TypeScript 7 (native `tsc`), Zod 4, Vitest, `pg` 8
(лише тести й адаптер designer), Postgres 17 локального стека Supabase,
Supavisor (transaction-режим), citty (CLI designer).

**Спека:** [спека П4](../specs/2026-10-26-p4-runtime-design.md) — §6.2 (абзац
«Режим обслуговування прав»), §6.10, §6.12, §6.13 (абзац «Застосунок без ролі
`rootCreator`»), §6.15, §6.16, §7.1–§7.3, рядок A4 у §8. [Спека
прав](../specs/2026-10-17-rights-design.md) — §4.6, §7, Рх19, Рх20.
[Спека designer](../specs/2026-10-02-simetra-designer-design.md) — §3.1,
§3.2 (осі інструментів, канали).

**Залежність:** A1, A2, A3, борг-1, Права-2d2, борг-2 — у `main` (88770a0a).
Робоча гілка — `feat/p4-a4`, де лежить і цей план. Перед стартом:
`.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-31-p4-a4-rights-administration.md`.
Розбіжність якорів із кодом — архітекторці до старту.

## Global Constraints

- 🔴 `pnpm --filter <pkg> test <pattern>` і `pnpm --filter <pkg> test:db <pattern>` — **без** `--` перед шаблоном.
- 🔴 T3 (`src/server`) не отримує жодної перевірки прав, гілки за назвою
  довідника прав чи за причиною запобіжника: «`runCommand` нічого не перевіряє
  поверх запобіжників, лише мапить відмови» (П4 §6.12). Імпорти `src/server` —
  лише `./…`, `simetra/model`, `zod`, `node:async_hooks` (Р-A3-10).
- 🔴 Імпорти лише вниз за ярусами: T0 ← T1 ← T2 ← T3. T2 не імпортує
  `simetra/server`; спільне з T3 — лише через T0.
- 🔴 T0 `simetra/model` — без runtime-залежностей, крім `zod`; без Node API.
- 🔴 Інструмент обслуговування — лише командний рядок: не реєструється в MCP і
  відмовляє `cli-only` на каналі `mcp`; без `--yes` не відкриває з'єднання.
- 🔴 Режим обслуговування інструмент вмикає лише `set_config(<RIGHTS_MAINTENANCE_SETTING>, 'on', true)`
  у транзакції запису. Жодного `SET` без `LOCAL`, жодного
  `SET CONSTRAINTS ALL IMMEDIATE` (Р-A4-6), жодної передперевірки власника:
  бар'єр — база.
- 🔴 Кожен запис інструмента — окремий оператор з одним відношенням; жодного
  CTE, що пише дві таблиці.
- 🔴 Ідентифікатори відношень і колонок — лише з контрактів і фізичного
  знімка моделі (`standardColumn`, `quoteIdent`); значення — лише зв'язані
  параметри `$n`.
- 🔴 Фізичні імена колонок прав — за логічним ім'ям реєстру
  (`RIGHTS_COLUMNS`, `standardColumn`), не літералами.
- 🔴 Нові коди діагностик — у `RULE_CODES` (`packages/simetra/src/compiler/diagnostics.ts`)
  і `messages.ts` (en, uk, підказка); тести перевіряють коди й параметри, не
  текст (крім `messages.test.ts`).
- Тести: скіл `.agents/skills/writing-tests/SKILL.md` — перед кожним кроком
  тестів. Рівень — найнижчий, що доводить. Кожен DB-кейс називає причину.
  Метадані — будівниками `packages/simetra/src/compiler/__tests__/fixtures/rights.ts`.
  Користувачі — лише `signUp`. Об'єкти стека — лише через run-tag.
- Кожна відмова й кожен інваріант має тест, що червоніє від названої мутації;
  DB-мутації — лише на закоміченому дереві. Журнал мутацій — у кінці плану.
- Кожен коміт задачі — зелені scoped unit-тести, `typecheck` і `lint` кожного
  зачепленого пакета. Повні гейти й повний `pnpm test:db` — на одному SHA,
  лише після «можна» архітекторки. Версій пакетів і `PLATFORM_VERSION` не
  чіпати. `AGENTS.md` і `CLAUDE.md` не правити. Публічні назви, описи
  інструментів, повідомлення CLI — англійською; коментарі — українською й про
  «чому». Фікстури синтетичні, без імен споживача.

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р-A4-1 | **Команди §6.12 — без нового коду T3.** Блок додає: unit-тест T3 «відмова запобіжника на `COMMIT` мапиться в `command.forbidden` з причиною» для кожної причини адміністрування; DB-тести designer через `runtime.run` для кожного рядка таблиці §6.12 (погоджено, розвилка «факт»). | розвідка: пакет, дія з каталогу й мапінг уже є (`phase.ts` `targetOf`, `transaction.ts` `terminalOf`, `errors.ts`) | немає |
| Р-A4-2 | **«База, а не T3» доводиться двома тестами:** unit — та сама операція самопризначення з порт-фейком, що відповідає успіхом, проходить (T3 не відмовляє сам); DB — записувальний порт фіксує, що відмова `escalation` прийшла відповіддю бази на `COMMIT` після всіх фаз | правило §6.12 «лише мапить» інакше не має доказу | немає |
| Р-A4-3 | **Сироти — повний структурований перелік у результаті плану.** `RightsOrphans = { roles, deltas, assignments }` без ліміту; кожен елемент несе `object: MetadataRef` довідника й `id`, дельта — ще `role`. Ліміт `RIGHTS_SOURCE_LIMIT` лишається лише в тексті попередження `plan.rights-orphans`. `PlanData.rightsOrphans` — у `structuredContent` MCP і `--format json`. Пакет очистки складає клієнт: `delete` призначень-сиріт → `markDeletion` ролей-сиріт → `update` ролі з дельтою без рядків-сиріт. T3 і схема `simetra` не змінюються (погоджено, Р1 (а) з повним переліком) | лише план знає домен коду; структуровані дані з обрізанням — пастка для автоматизації | П4 §6.12 рядок «очистити сироти»; спека прав §7 «перелік уражених кастомних ролей» → «ролей, рядків дельти й призначень» |
| Р-A4-4 | **Ідемпотентність інструмента — відмова без запису, ненульовий код виходу, назва стану.** Стан перевіряється в транзакції запису під `pg_advisory_xact_lock`: `maintenance.not-first` (є живе глобальне призначення), `maintenance.holder-exists` (є дієвий носій глобального `fullAccess`), `maintenance.scope-has-members` (у скоупі є будь-який рядок членства, і позначений), `maintenance.not-effective` (новий носій не дієвий після запису — відкат) (погоджено, Р2) | інструмент обходить ⊆, тож кожен запуск має виправдати аварійний стан; мовчазне «нічого» сховало б розбіжність | П4 §6.12 «Поза командами» — перелік відмов |
| Р-A4-5 | **Вхід — `SIMETRA_DATABASE_URL` мігратора (ролі, що застосувала план і володіє функціями прав).** Передперевірки власника немає; відмову бази (`42501` `command.forbidden` / `rights-context`) інструмент дає як `maintenance.refused` з підказкою «увійдіть роллю, що застосувала план» (погоджено, Р4) | бар'єр — `maintenanceSql` у базі; друга перевірка в інструменті нічого не захищає | немає |
| Р-A4-6 | **Без `SET CONSTRAINTS ALL IMMEDIATE`.** Відкладені запобіжники судять на `COMMIT`; їхню відмову інструмент ловить як помилку `COMMIT`. Перевірка дієвості нового носія — `SELECT` до `COMMIT` (бачить власні записи, від відкладених тригерів не залежить). Кожен запис — окремий оператор з одним відношенням (рішення автора на питання архітекторки) | `IMMEDIATE` відкриває шлях хибної `escalation` з беклогу («Хибна escalation у SET CONSTRAINTS ALL IMMEDIATE»): знімок актора на кожному операторі, ⊆ — у кінці; інструменту `IMMEDIATE` нічого не дає | немає |
| Р-A4-7 | **`Tool.cliOnly?: true`.** `registerCatalog` MCP такий інструмент пропускає; `invoke` на каналі `mcp` відмовляє новою причиною `cli-only` раніше за розбір входу (захист у глибину) (погоджено, Р5) | механізму «лише CLI» в designer немає; спека П4 §6.12 вимагає «не в MCP» | спека designer §3.1/§3.2 — поле `cliOnly` і причина `cli-only` |
| Р-A4-8 | **Інструмент `rights-maintenance`:** `files: "read"`, `database: "write"`, `destructive: true` (звідси `--yes`), `cliOnly: true`; вхід — JSON, дискримінант `action`: `firstGlobalAssignment { user, role }`, `restoreGlobalFullAccess { user, role? }`, `firstTenantOwner { scopeKind, scope, user, role, member? }`. `role` — логічне ім'я ролі метаданих; `scopeKind` — логічне ім'я кореня виду скоупу; `user` — id рядка «Користувачів» | JSON — типова форма входу каталогу (`takesJsonInput`); ергономічні прапорці — до першого запиту | П4 §6.12 «Поза командами» — назва й вхід |
| Р-A4-9 | **Вимоги до ролі.** `firstGlobalAssignment` — будь-яка роль рівня `global`; `restoreGlobalFullAccess` — роль рівня `global` з `fullAccess` (без `role` — єдина така, інакше `maintenance.role-ambiguous`); `firstTenantOwner` — роль рівня цього виду скоупу з `fullAccess`. Інакше `maintenance.role-level` | «власник» тенанта — дієвий носій `fullAccess`, інакше тенант лишиться без адміністратора | П4 §6.12 |
| Р-A4-10 | **Звірка моделі:** `simetra.applied_snapshot_hash()` ≠ хеш скомпільованої теки → `maintenance.model-mismatch`, нічого не пишеться (погоджено, Р5) | фізичні імена й архетипи інструмент бере з моделі; чужа модель записала б не ті колонки | немає |
| Р-A4-11 | **Значення рядка учасника.** `firstTenantOwner` приймає необов'язкове `member` — значення реквізитів застосунку за логічними іменами. Перевіряє їх `encodeMemberValues` (T0) за об'єктом довідника членства з каталогу рантайму (`buildRuntimeCatalog`): ключ лише реквізит з `insert`, не з примушених (ключ, скоуп, користувач); значення — тим самим кодуванням, що й вхід команди. Інструмент вставляє рядок через `jsonb_populate_record`, як ядро `save`. Примушений ключ у `member` → `maintenance.invalid-member` з `path`; `23502` → `maintenance.member-required` з реквізитом (погоджено зі зміною, Р5) | застосунок моделі «тенант створює оператор» з обов'язковим реквізитом учасника інакше не заведе першого власника — блокер першої міграції; одна функція для A6 `creatorMember` | П4 §6.12 «Поза командами» — вхід `member`; §6.13 — `creatorMember` валідує `encodeMemberValues` |
| Р-A4-12 | **Кодування значень — у T0.** `encodeItemValue`, `encodePair`, `isPlainObject`, `INTEGER_TEXT` і їхні приватні помічники переїжджають з `server/values.ts` у `model/runtime/values.ts` без зміни поведінки; T3 імпортує їх із `simetra/model` | T2 не може імпортувати T3; дві копії кодування розійшлися б | немає |
| Р-A4-13 | **`ApplyDbError` несе `detail?`, `column?`, `constraint?`** — заповнює адаптер designer (`createApplyDatabase`) з помилки драйвера | інструменту треба відрізнити `rights-context` від інших `42501` і назвати реквізит `23502` | немає |
| Р-A4-14 | **Борг не береться** (погоджено, Р3) | жоден пункт A4 природно не закриває | немає |
| Р-A4-15 | **Обмеження хостованого Supabase:** локально доводяться вхід `postgres` прямим портом і через локальний Supavisor (`postgres.<tenant>`); хостований пулер і застосування не роллю `postgres` (тоді власник функцій інший, режим недоступний) локально не доводяться (погоджено, Р4) | стек тестів — лише локальний | П4 §6.15 — новий пункт |
| Р-A4-16 | **DB-кейси через пулер:** самопризначення (`escalation`) і передача `fullAccess` пакетом — і прямим портом, і пулером; решта — прямим портом | §7.3 вимагає однакового результату; відмова на `COMMIT` і пакет — те, що пулер може зламати; повтор усіх кейсів подвоїв би час | П4 §7.3 — немає (уточнення в плані) |

## Review Focus

1. **Пакет очистки з сиротою-роллю, на яку ще є призначення, без зняття призначення в тому самому пакеті** — `role-in-use` на `COMMIT`, нічого не записано (Задача 7, кейс `orphan cleanup keeps the order: assignments before roles`).
2. **`member` з ключем механіки (`ref`, колонка скоупу, колонка користувача), з реквізитом поза `insert`, з невідомим ключем чи `undefined`** — `maintenance.invalid-member` з `path`, з'єднання не відкривається (Задача 3, тест `encodeMemberValues rejects forced, non-insert, unknown and undefined keys`; Задача 6 — інструмент не підключається).
3. **Відновлення для користувача з `invalid = true`** — запис відкочено, `maintenance.not-effective`, журнал без рядка (Задача 8, кейс `restore for an invalid user rolls back`).
4. **Два оператори запускають перше глобальне призначення одночасно** — другий чекає на advisory-замок і отримує `maintenance.not-first` (Задача 8, кейс `a concurrent first assignment waits and refuses`).
5. **Перелік сиріт більший за `RIGHTS_SOURCE_LIMIT`** — текст попередження обрізано, а `rightsOrphans` повний (Задача 4, тест `rightsOrphans stays complete past the warning limit`).

---

### Задача 0: якорі й факти

**Files:** лише читання; звіт — під цією задачею в плані.

- [ ] **Крок 1:** `orient --plan` цього файлу; розбіжності — архітекторці.
- [ ] **Крок 2:** записати фактом:
  - чи `policyDomain(adminRoles())` (`fixtures/rights.ts`) дає довідники
    `OrgRoles`, `OrgRoleAssignments`, `GlobalRoles`, `GlobalRoleAssignments`,
    «Користувачів», `OrgMember`; які ролі `adminRoles()` мають `fullAccess`
    (`ORG_ADMIN_ID`? `GLOBAL_ADMIN_ID`), а яка — лише `administerRights`
    (`RightsAdmin`); фізичні імена таблиць і колонок;
  - як `insertOrphan` (`packages/simetra/test/db/rights-seed.ts`) вставляє
    сироту повз запобіжники — інструмент для засіву Задачі 7;
  - `session_user` при вході `postgres` через локальний Supavisor
    (`testPoolerUrl()`, форма `postgres.<tenant>` як у `throughPoolerAs`) до
    тіні рушія — `SELECT session_user, current_user`;
  - чи є в `packages/simetra/test/support` чи `packages/designer/src/__tests__/support`
    `ApplyDatabase` над одним `pg.Client` зі справжніми `BEGIN`/`COMMIT`
    (потрібен Задачі 8 для сесії `SET SESSION AUTHORIZATION`); якщо немає —
    Задача 8 додає `sessionDatabase(client)`;
  - як `RuntimeObject` (`model/runtime/catalog.ts`) називає ключ, колонку
    скоупу й колонку користувача довідника членства — чи досить
    `contracts.membership[]` (`keyColumn`, `scopeColumn`, `userColumn`), щоб
    перевести їх у логічні імена.
- [ ] **Крок 3:** якщо `postgres` через пулер дає інший `session_user` —
  архітекторці до Задачі 8 (тоді кейс пулера інструмента міняє форму).

### Задача 1: T3 — відмова запобіжника на `COMMIT` і «лише мапить»

**Files:**
- Modify: `packages/simetra/src/server/__tests__/transaction.test.ts`

**Interfaces:** споживає `createCommandRuntime`, порт-фейк файлу, `COMMAND_CORE_ERRORS.forbidden` (T0). Нічого не виробляє.

- [ ] **Крок 1:** тест `maps a guard refusal at COMMIT to command.forbidden with its reason` — `it.each` за `escalation`, `role-in-use`, `last-full-access`, `delta-domain`, `rights-context`: фейк відповідає успіхом на всі оператори фази й `42501` `MESSAGE 'command.forbidden'` `DETAIL <причина>` на `COMMIT`; очікування — `CommandFailure` з `error = { code: "command.forbidden", reason }` без `object`, точна послідовність операторів завершується `COMMIT`, `release()` рівно раз.
- [ ] **Крок 2:** тест `does not refuse a rights administration batch on its own` — каталог з довідником призначень (`context: "administerRights"`), пакет `[create, delete]` на ньому; фейк відповідає успіхом → результат з двома рядками; послідовність містить обидва виклики ядра й `COMMIT`.
- [ ] **Крок 3:** обидва тести зелені на поточному коді (це тести наявного механізму); мутація М1 (журнал мутацій) їх червонить.
- [ ] **Крок 4:** коміт `test(server): відмова запобіжника прав на COMMIT і пакет адміністрування без власних перевірок T3`.

### Задача 2: кодування значень у T0 і `encodeMemberValues`

**Files:**
- Create: `packages/simetra/src/model/runtime/values.ts`
- Modify: `packages/simetra/src/model/runtime/index.ts` (експорт)
- Modify: `packages/simetra/src/server/values.ts` (імпорт з `simetra/model`, переміщені функції видалено)
- Create: `packages/simetra/src/model/runtime/__tests__/values.test.ts`

**Interfaces:**
- Produces: `encodeItemValue(attribute: RuntimeAttribute, value: unknown, path: string)`, `encodePair`, `isPlainObject`, `INTEGER_TEXT` — ті самі сигнатури, тепер із `simetra/model`; тип `Encoded<T> = { value: T } | { error: CommandError }` експортується.
- Produces: `encodeMemberValues(object: RuntimeObject, values: unknown, forced: readonly string[]): { columns: Record<string, unknown> } | { error: CommandError }` — `values` має бути простим об'єктом; кожен ключ — реквізит об'єкта з `insert: true`, не з `forced` (логічні імена); значення — `encodeItemValue` (пара дає обидві колонки); результат — фізичні колонки → JSON-значення для `jsonb_populate_record`. Порядок помилок — як `encodeItem` (Р-A3-8): реквізити за порядком каталогу, далі невідомі ключі за порядком входу. `path` — логічне ім'я реквізиту.

- [ ] **Крок 1:** перенести функції без зміни тіл; наявні unit-тести T3 (`server/__tests__/values.test.ts` чи сусідні) зелені без правок — доказ «без зміни поведінки».
- [ ] **Крок 2:** тест `encodeMemberValues rejects forced, non-insert, unknown and undefined keys` — `it.each`: ключ із `forced`, реквізит з `insert: false`, невідомий ключ, значення `undefined`, не-об'єкт `values` → `command.invalid` з очікуваним `path`.
- [ ] **Крок 3:** тест `encodeMemberValues encodes like a command` — `Numeric` рядком, пара `{ type, id }`, `null` → ті самі колонки й значення, що дає `encodeItem` для того самого реквізиту в `create`.
- [ ] **Крок 4:** реалізувати `encodeMemberValues`; тести зелені; `pnpm --filter simetra test values`, `typecheck`, `lint`.
- [ ] **Крок 5:** коміт `refactor(model): кодування значень каталогу рантайму в T0 і encodeMemberValues`.

### Задача 3: діагностики `maintenance.*` і `ApplyDbError`

**Files:**
- Modify: `packages/simetra/src/compiler/diagnostics.ts` (`RULE_CODES`)
- Modify: `packages/simetra/src/compiler/messages.ts`
- Modify: `packages/simetra/src/compiler/__tests__/messages.test.ts`
- Modify: `packages/simetra/src/schema/apply/port.ts` (`ApplyDbError`)
- Modify: адаптер `createApplyDatabase` у `packages/designer/src/schema-engine/` (файл, де створюється `ApplyDbError`)

**Interfaces:**
- Produces: коди (усі `error`) і параметри:
  `maintenance.model-mismatch { applied, compiled }`,
  `maintenance.unknown-role { role }`,
  `maintenance.role-level { role, expected }` (`expected`: `global`, `global fullAccess`, `<вид скоупу> fullAccess`),
  `maintenance.role-ambiguous { roles }`,
  `maintenance.unknown-scope-kind { scopeKind }`,
  `maintenance.no-catalog { level }` (рівень без довідника призначень чи з прийнятим джерелом членства/призначень),
  `maintenance.scope-missing { scope }`,
  `maintenance.not-first {}`, `maintenance.holder-exists {}`,
  `maintenance.scope-has-members { scope }`,
  `maintenance.not-effective { user }`,
  `maintenance.invalid-member { path }`,
  `maintenance.member-required { attribute }`,
  `maintenance.refused { reason }` (підказка: увійти роллю, що застосувала план; спека П4 §6.2).
- Produces: `ApplyDbError(message, sqlstate, extra?: { detail?: string; column?: string; constraint?: string })` з однойменними `readonly` полями.

- [ ] **Крок 1:** `messages.test.ts` — наявний тест повноти каталогу повідомлень червоніє від нових кодів без текстів; додати тексти en/uk і підказки.
- [ ] **Крок 2:** адаптер заповнює `detail`, `column`, `constraint` з помилки `pg`; unit-тест адаптера (якщо в нього є unit-тести) або перевірка в Задачі 8.
- [ ] **Крок 3:** `pnpm --filter simetra test messages`, `typecheck`, `lint` обох пакетів.
- [ ] **Крок 4:** коміт `feat(schema): діагностики режиму обслуговування прав і поля помилки бази`.

### Задача 4: повний перелік сиріт у плані

**Files:**
- Modify: `packages/simetra/src/schema/apply/rights-sources.ts`
- Modify: `packages/simetra/src/schema/apply/plan.ts` (`PlanOutcome` несе `rightsOrphans`)
- Modify: `packages/simetra/src/schema/apply/index.ts` (тип `RightsOrphans`)
- Modify: `packages/designer/src/tools/apply-tools.ts` (`PlanData.rightsOrphans`)
- Modify: `packages/designer/src/cli/render.ts` лише якщо `--format json` бере `PlanData` не цілком
- Test: `packages/simetra/src/schema/apply/__tests__/rights-sources.test.ts`, `packages/designer/src/__tests__/mcp.test.ts` (або тест, що вже перевіряє `structuredContent` плану)

**Interfaces:**
- Produces:
  ```ts
  export interface RightsOrphans {
    roles: { object: MetadataRef; id: string }[]
    deltas: { object: MetadataRef; role: string; id: string }[]
    assignments: { object: MetadataRef; id: string }[]
  }
  ```
  `RightsSourceFacts.orphans` стає `RightsOrphans` (повний, відсортований за `id` у кожному переліку, без дублів); `object` — логічне ім'я довідника ролей чи призначень з об'єкта моделі за `RightsCatalogContract.roles.objectId` / `assignments.objectId` (`RightsCatalogInput` отримує `rolesObject`, `assignmentsObject`). Сорти — як у `collectRightsFacts`: роль, чий архетип зник чи змінив рівень → `roles`; рядок дельти живої ролі поза доменом → `deltas` з `role` = id батька; пряме призначення архетипу, що зник чи змінив рівень → `assignments`.
- Produces: `PlanOutcome` (усі статуси з фактами) і `PlanData` несуть `rightsOrphans: RightsOrphans`; без довідників прав — порожні переліки.
- Діагностика `plan.rights-orphans` — ті самі параметри `customRoles` (id ролей і дельт), `assignments`, `more`, обчислені з `RightsOrphans` з лімітом `RIGHTS_SOURCE_LIMIT` (текст не змінюється).

- [ ] **Крок 1:** тест `collects orphans by sort with their catalogs` — роль з архетипом, якого немає; дельта живої ролі поза доменом; пряме призначення зниклого архетипу; позначена роль не потрапляє → точні три переліки з `object` і `role`.
- [ ] **Крок 2:** тест `rightsOrphans stays complete past the warning limit` — `RIGHTS_SOURCE_LIMIT + 5` сиріт → `rightsOrphans` має всі; параметри попередження — перші `RIGHTS_SOURCE_LIMIT` і `more = 5` (наявний тест `warns once for capped orphan row IDs` лишається зеленим).
- [ ] **Крок 3:** реалізувати; тест MCP/CLI: `structuredContent` плану й `--format json` містять `rightsOrphans`.
- [ ] **Крок 4:** `pnpm --filter simetra test rights-sources`, `pnpm --filter @simetrajs/designer test mcp`, `typecheck`, `lint`.
- [ ] **Крок 5:** коміт `feat(schema): повний структурований перелік сиріт прав у результаті плану`.

### Задача 5: `Tool.cliOnly` і відмова `cli-only`

**Files:**
- Modify: `packages/designer/src/tools/types.ts` (`Tool.cliOnly?: true`, `RefusalReason` + `"cli-only"`)
- Modify: `packages/designer/src/tools/invoke.ts`
- Modify: `packages/designer/src/mcp/tools.ts` (`registerCatalog`)
- Test: `packages/designer/src/__tests__/mcp.test.ts`, тест `invoke` (наявний файл тестів `invoke`, інакше `cli.test.ts`)

**Interfaces:**
- Produces: `Tool.cliOnly?: true`; `invoke` з `channel: "mcp"` для такого інструмента повертає `refusal.reason = "cli-only"` першою перевіркою (до розбору входу); `registerCatalog` пропускає `tool.cliOnly`.

- [ ] **Крок 1:** тест `refuses a cli-only tool on the mcp channel before parsing input` — тестовий інструмент з `cliOnly: true` і невалідним входом → `cli-only`, `run` не викликано; на каналі `cli` — звичайний шлях.
- [ ] **Крок 2:** тест `does not register cli-only tools` — сервер MCP з каталогом, що містить `cliOnly`-інструмент (через `TOOLS` після Задачі 6 — точний перелік `lists every catalog tool in read-only mode` не змінюється), і явна перевірка, що `rights-maintenance` у `tools/list` відсутній. Якщо Задача 6 ще не влита — тест додається в Задачі 6.
- [ ] **Крок 3:** реалізувати; `pnpm --filter @simetrajs/designer test invoke`, `test mcp`, `typecheck`, `lint`.
- [ ] **Крок 4:** коміт `feat(designer): інструменти лише для командного рядка`.

### Задача 6: ядро `runRightsMaintenance` (T2) і інструмент `rights-maintenance`

**Files:**
- Create: `packages/simetra/src/schema/apply/rights-maintenance.ts`
- Modify: `packages/simetra/src/schema/apply/index.ts` (експорт)
- Create: `packages/simetra/src/schema/apply/__tests__/rights-maintenance.test.ts`
- Create: `packages/designer/src/tools/rights-maintenance-tool.ts`
- Modify: `packages/designer/src/tools/types.ts` (`TOOL_NAMES` + `"rights-maintenance"`), `packages/designer/src/tools/catalog.ts` (`TOOLS`)
- Modify: `packages/designer/src/cli/render.ts` (текст результату)
- Test: `packages/designer/src/__tests__/cli.test.ts`, `packages/designer/src/__tests__/rights-maintenance-tool.test.ts`

**Interfaces:**
- Consumes: `encodeMemberValues` (Задача 2), коди Задачі 3, `effectiveHolderRows` і `RIGHTS_FUNCTIONS.fullAccessRoles` з `simetra/compiler` (якщо `RIGHTS_FUNCTIONS` не експортований — експортувати), `buildRuntimeCatalog`, `RIGHTS_MAINTENANCE_SETTING`, `APPLIED_SNAPSHOT_HASH_FUNCTION_NAME` з `simetra/model`.
- Produces:
  ```ts
  export type RightsMaintenanceRequest =
    | { action: "firstGlobalAssignment"; user: string; role: string }
    | { action: "restoreGlobalFullAccess"; user: string; role?: string }
    | { action: "firstTenantOwner"; scopeKind: string; scope: string; user: string; role: string; member?: Record<string, unknown> }
  export interface RightsMaintenanceDone { assignment: string; member?: string }
  export async function runRightsMaintenance(
    dbs: ApplyDatabase, target: DbConnection, model: CompiledModel, request: RightsMaintenanceRequest
  ): Promise<{ ok: true; done: RightsMaintenanceDone } | { ok: false; diagnostic: EngineDiagnostic }>
  ```
  Zod-схема входу інструмента — `z.discriminatedUnion("action", …)` з `z.strictObject`, `user`/`scope` — UUID.

**Порядок `runRightsMaintenance`** (одна транзакція `dbs.transaction(target, "commit", …)`):

1. До з'єднання: роль за ім'ям і вимоги Р-A4-9; вид скоупу, довідник призначень рівня (не прийняте джерело), довідник членства виду (не прийняте джерело); `member` — `encodeMemberValues` з `forced` = ключ, скоуп, користувач. Будь-яка відмова тут — без з'єднання.
2. `SELECT pg_advisory_xact_lock(<стала bigint>)` — стала названа в коді з коментарем.
3. `SELECT simetra.applied_snapshot_hash()` ≠ `model.hash` → `maintenance.model-mismatch`.
4. Стан: `firstGlobalAssignment` — живий (не позначений) рядок глобальних призначень → `not-first`; `restoreGlobalFullAccess` — рядок `holderRows` глобального рівня → `holder-exists`; `firstTenantOwner` — кореня `scope` немає → `scope-missing`; будь-який рядок членства скоупу → `scope-has-members`.
5. `SELECT set_config($1, 'on', true)` з `RIGHTS_MAINTENANCE_SETTING`.
6. `firstTenantOwner`: ключ учасника — `SELECT gen_random_uuid()` окремим оператором (T2 без `node:crypto`); JSON = колонки з `encodeMemberValues` плюс примушені ключ, скоуп, користувач; `INSERT INTO <членство> (<колонки JSON>) SELECT <колонки JSON> FROM jsonb_populate_record(NULL::<членство>, $1::jsonb)` — перелік колонок обов'язковий, щоб решта взяла `DEFAULT`.
7. Ключ призначення — так само `gen_random_uuid()`; `INSERT INTO <призначення> (<ключ>, [<скоуп>,] <subject>, <archetype>) VALUES ($1, …)` — `subject` = користувач (глобальний рівень) чи ключ учасника (скоуп).
8. Перевірка дієвості: для `restoreGlobalFullAccess` і `firstTenantOwner` — рядок `holderRows` рівня з `actor` = користувач (глобальний) чи учасник; для `firstGlobalAssignment` — рядок `effectiveHolderRows` з цим призначенням. Немає → виняток → відкат → `maintenance.not-effective`.
9. `COMMIT` (порт). Помилка бази будь-якого кроку: `42501` `command.forbidden` → `maintenance.refused { reason: detail }`; `23502` у членстві → `maintenance.member-required` з реквізитом за колонкою (каталог рантайму); інша → наявна `database.failed`.

- [ ] **Крок 1:** unit-тести ядра без бази (`rights-maintenance.test.ts`) на порт-фейку `ApplyDatabase`: `it.each` відмов кроку 1 (невідома роль, роль не того рівня, роль без `fullAccess`, неоднозначна роль, невідомий вид скоупу, прийняте джерело) — порт не викликано; точна послідовність операторів кожної дії цілими рядками (крок 2 → 9) з параметрами; `model-mismatch` зупиняє до `set_config`.
- [ ] **Крок 2:** реалізувати `runRightsMaintenance`.
- [ ] **Крок 3:** інструмент: компілює теку (`readMetadataDir` → `compile`), помилки компіляції → відмова з діагностиками без з'єднання; викликає `runRightsMaintenance` через `withDatabase(required(database), "rights-maintenance", …)` і `createApplyDatabase({ readOnly: false })`; `data` — `RightsMaintenanceDone`. Опис англійською називає: лише CLI, `--yes`, вхід мігратора, три дії, відмови стану.
- [ ] **Крок 4:** тести інструмента (`rights-maintenance-tool.test.ts`): `does not connect without --yes` — `runTool` з фейковим `DatabaseResource`, чий `connect` рахує виклики → `unconfirmed`, код виходу ≠ 0, `connect` не викликано; `is absent from MCP and refused on the mcp channel` — `tools/list` без `rights-maintenance`, `invoke(channel: "mcp")` → `cli-only`. `cli.test.ts` — `TOOLS` ≡ `TOOL_NAMES`.
- [ ] **Крок 5:** `pnpm --filter simetra test rights-maintenance`, `pnpm --filter @simetrajs/designer test rights-maintenance cli mcp`, `typecheck`, `lint` обох пакетів.
- [ ] **Крок 6:** коміт `feat(designer): інструмент обслуговування прав rights-maintenance`.

### Задача 7: DB-тести команд адміністрування прав

**Files:**
- Create: `packages/designer/src/__tests__/rights-admin-commands.db.test.ts`
- Modify: `packages/designer/src/__tests__/support/db.ts` — винести з `command-runtime.db.test.ts` `committed` і засів актора під режимом обслуговування в спільний помічник (`seedUnderMaintenance(owner, steps)`), якщо файл їх повторює
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` — лише якщо Задача 0 показала, що `policyDomain(adminRoles())` бракує довідника

**Причина рівня:** запобіжники судять на `COMMIT` у справжній транзакції з закоміченими даними інших сесій; пулер і `runtime.run` — лише в DB.

**Interfaces:** споживає `inTarget`, `withRuntimeLogin`, `throughPoolerAs`, `seedMarker`, `signUp`, `createCommandRuntime`, `fromPgPool`, `buildRuntimeCatalog`; планування сиріт — `planDatabase`/`plan` T2 з `RightsOrphans` (Задача 4).

Одне розгортання на файл; засів — власником під режимом обслуговування. Актори: `admin` — учасник з `RightsAdmin` (адміністрування без `fullAccess`); `holder` — учасник з архетипом `fullAccess` рівня org; `peer` — третій учасник. Кожен кейс бере свіжі рядки.

- [ ] **Крок 1:** кейси (`it` з причиною в коментарі):
  - `creates, updates and marks a custom role through runtime.run` — `create` ролі з дельтою → рядок журналу `reason = 'command'`, `actor` = `admin`; `update` з поточною версією й новою дельтою (повна заміна ТЧ) → версія +1; `update` зі старою версією → `command.conflict` `reason: "version"`, `currentVersion`;
  - `assigns and unassigns a role` — `create` призначення кастомної ролі для `peer` → проходить; `delete` з версією → проходить; `markDeletion` ролі після зняття → проходить;
  - `refuses to mark a role in use` — `markDeletion` ролі з живим призначенням → `command.forbidden` `role-in-use`, роль не позначена;
  - `refuses self-assignment as escalation, through the database at COMMIT` — `admin` призначає собі роль ширшу за власну → `command.forbidden` `escalation`; записувальний порт-обгортка над `fromPgPool` фіксує: останній оператор, на який прийшла помилка, — `COMMIT` (Р-A4-2); `describe.each` прямий порт і пулер;
  - `transfers fullAccess in one batch` — `holder` пакетом `[create призначення fullAccess для peer, delete свого]` → проходить; `peer` — дієвий носій; `describe.each` прямий порт і пулер;
  - `refuses to drop the last fullAccess holder` — `holder` знімає своє єдине призначення → `command.forbidden` `last-full-access`, призначення живе.
- [ ] **Крок 2:** кейс `cleans orphans with a client batch from the plan` (наскрізний, Р-A4-3): засів `insertOrphan`-способом (Задача 0) — кастомна роль з дельтою поза доменом і рядком у домені, роль з неіснуючим архетипом і живим призначенням на неї, пряме призначення неіснуючого архетипу; план T2 на тій самій моделі → `rightsOrphans` рівно ці рядки; пакет `admin`: `delete` двох призначень → `markDeletion` ролі-сироти → `update` ролі з дельтою без сирітського рядка (рядки дельти тест читає власником — як клієнт своїм шляхом); повторний план → порожній `rightsOrphans`.
- [ ] **Крок 3:** кейс `orphan cleanup keeps the order: assignments before roles` — пакет `markDeletion` ролі-сироти без зняття її призначення → `role-in-use`, нічого не записано; повторний план → `rightsOrphans` незмінний (сирота лишилась — тест не зелений від порожнього переліку).
- [ ] **Крок 4:** `pnpm --filter @simetrajs/designer test:db rights-admin-commands` — зелено; час записати.
- [ ] **Крок 5:** коміт `test(designer): команди адміністрування прав через рантайм над тінню`.

### Задача 8: DB-тести інструмента обслуговування

**Files:**
- Create: `packages/designer/src/__tests__/rights-maintenance.db.test.ts`
- Modify: `packages/designer/src/__tests__/support/db.ts` — `sessionDatabase(client: pg.Client): ApplyDatabase` (справжні `BEGIN`/`COMMIT`/`ROLLBACK` на одному клієнті), якщо Задача 0 не знайшла наявного

**Причина рівня:** режим обслуговування вирішує `session_user` справжньої сесії й відкладені тригери на `COMMIT`.

Одне розгортання; кейси інструмента викликають `runRightsMaintenance` з `createApplyDatabase` на URL цілі (вхід `postgres` — власник функцій) або з `sessionDatabase` для негативних сесій. Позитивний наскрізний виклик CLI (`runTool` з `--yes` і змінною середовища з URL цілі) — один кейс.

- [ ] **Крок 1:** кейси:
  - `first global assignment journals the maintenance actor` — через `runTool` CLI з `--yes` → призначення є; журнал прав: `actor IS NULL`, `reason = 'maintenance'`, `action IS NULL`; повторний запуск → `maintenance.not-first`, код виходу ≠ 0, кількість рядків призначень незмінна;
  - `a concurrent first assignment waits and refuses` — тестова сесія тримає `pg_advisory_xact_lock(<стала>)`, інструмент чекає (`waitForLock`), тест вставляє глобальне призначення під режимом і комітить → інструмент `not-first`;
  - `restore refuses while an effective holder exists` → `holder-exists`;
  - `restore for an invalid user rolls back` — носія немає, `user` з `invalid = true` → `not-effective`, призначення й журналу немає;
  - `restore after the holder became invalid` — дієвого носія зроблено недійсним (`invalid false → true` поза командою — дозволений виняток) → відновлення для іншого користувача проходить, він дієвий;
  - `first tenant owner with member values` — корінь org без учасників (засів власником), `member` з обов'язковим реквізитом застосунку → рядок членства з примушеними ключем, скоупом, користувачем і значенням; призначення `fullAccess`; користувач — дієвий носій; повтор → `scope-has-members`;
  - `first tenant owner without a required member value` → `maintenance.member-required` з реквізитом, нічого не записано;
  - `refuses a model mismatch` — marker з іншим хешем (`seedMarker`) → `model-mismatch`, нічого не записано;
  - `works through the local pooler` — URL `postgres` через Supavisor (форма з Задачі 0) → перше глобальне призначення в чистому стані проходить.
- [ ] **Крок 2:** негативні кейси режиму (Р-A4-5):
  - `the real simetra_runtime login cannot enable maintenance` — клієнт суперкористувача на цілі: `SET SESSION AUTHORIZATION simetra_runtime`, `SET ROLE simetra_command` (справжня роль стека, `supabase/roles.sql`; тегована роль ім'я не доводить, П4 §7.2) → `sessionDatabase(client)` → `maintenance.refused { reason: "rights-context" }`; призначень і журналу немає;
  - `a provider login that owns the rights functions cannot enable maintenance` — у копії бази (`withCopy`) власник усіх `SECURITY DEFINER`-функцій схем застосунку й `simetra` → `supabase_admin`; сесія `SET SESSION AUTHORIZATION supabase_admin` → `maintenance.refused { reason: "rights-context" }`;
  - `the migrator login enables maintenance` — та сама обв'язка (`sessionDatabase` над клієнтом суперкористувача, `SET SESSION AUTHORIZATION postgres`) на цілі з власником `postgres` → проходить (контроль: негативи червоніють від умови режиму, а не від обв'язки).
- [ ] **Крок 3:** `pnpm --filter @simetrajs/designer test:db rights-maintenance` — зелено; час записати.
- [ ] **Крок 4:** коміт `test(designer): інструмент обслуговування прав і межі режиму над тінню`.

### Задача 9: мутації

**Files:** без змін у коді; журнал мутацій у цьому плані.

- [ ] **Крок 1:** на закоміченому дереві виконати кожну мутацію журналу, запустити названий scoped тест, записати «що прибрано → що почервоніло», відкотити (`git checkout -- <файл>`). DB-мутації — по одній, scoped `test:db`.
- [ ] **Крок 2:** коміт `docs(plan): П4-A4 — журнал мутацій`.

### Задача 10: документи

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` — §6.12 (рядок «очистити сироти» за Р-A4-3; абзац «Поза командами»: назва `rights-maintenance`, дії, вхід `member`, відмови стану Р-A4-4, звірка хешу), §6.13 (речення: `creatorMember` перевіряє `encodeMemberValues`), §6.15 (обмеження хостованого Supabase, Р-A4-15), §7.1 (рядок «DB designer» — команди прав і інструмент), Додаток А (рядки з блоком A4 для кожної правки)
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` — §7 (перелік сиріт: ролі, рядки дельти, призначення; повний у даних плану)
- Modify: `docs/superpowers/specs/2026-10-02-simetra-designer-design.md` — §3.1/§3.2: `rights-maintenance`, `cliOnly`, `cli-only`
- Modify: `packages/designer/skills/simetra-metadata/references/people-and-rights.md` — команди адміністрування через рантайм (форма операцій, пакет передачі `fullAccess`, пакет очистки сиріт з `rightsOrphans`), інструмент обслуговування (коли, вхід мігратора, `--yes`, відмови)
- Modify: `docs/ROADMAP.md` — статус A4

- [ ] **Крок 1:** внести правки; `python3 scripts/check-doc-anchors.py`.
- [ ] **Крок 2:** коміт `docs(spec): П4-A4 — адміністрування прав і інструмент обслуговування`.

### Задача 11: перевірка й звіт

- [ ] **Крок 1:** перевірка за `/виконай-задачу`: лінзи `code-review` за дифом, обов'язкові `correctness` (режим вмикається лише для мігратора; ескалація через пакет; інструмент не пише без `--yes`) і `test-honesty`; кожну знахідку — `code-review-verifier`.
- [ ] **Крок 2:** контрольна точка архітекторці після DB-тестів (SHA, коміти, мутації, час DB-тестів, рішення й відхилення з «вплив на спеку»).
- [ ] **Крок 3:** повні гейти на одному SHA — лише після «можна».

## Журнал мутацій

| № | Мутація | Тест, що має почервоніти | Результат |
| --- | --- | --- | --- |
| М1 | `errors.ts`: прибрати `role-in-use` з `FORBIDDEN_REASONS` | Задача 1 `maps a guard refusal at COMMIT…`; Задача 7 `refuses to mark a role in use` | |
| М2 | `guard-units.ts` `maintenanceSql`: прибрати `session_user = current_user` | Задача 8 `the real simetra_runtime login cannot enable maintenance` | |
| М3 | `guard-units.ts` `maintenanceSql`: прибрати умову `PROVIDER_LOGIN_ROLES` | Задача 8 `a provider login that owns the rights functions…` | |
| М4 | `guard-units.ts` `escalationSql`: прибрати перевірку приросту | Задача 7 `refuses self-assignment as escalation…` | |
| М5 | `mcp/tools.ts` `registerCatalog`: не пропускати `cliOnly` | Задача 6 `is absent from MCP…` | |
| М6 | `invoke.ts`: прибрати відмову `cli-only` | Задача 5 `refuses a cli-only tool on the mcp channel…` | |
| М7 | `rights-maintenance-tool.ts`: `destructive: false` | Задача 6 `does not connect without --yes` | |
| М8 | `runRightsMaintenance`: прибрати перевірку `not-first` | Задача 8 `first global assignment journals…` (повтор) | |
| М9 | `runRightsMaintenance`: прибрати advisory-замок | Задача 8 `a concurrent first assignment waits and refuses` | |
| М10 | `runRightsMaintenance`: прибрати перевірку дієвості (крок 8) | Задача 8 `restore for an invalid user rolls back` | |
| М11 | `runRightsMaintenance`: прибрати `set_config` режиму | Задача 8 `the migrator login enables maintenance` і позитивні кейси | |
| М12 | `encodeMemberValues`: не перевіряти `forced` | Задача 2 `…rejects forced…` | |
| М13 | `collectRightsFacts`: обрізати `rightsOrphans` лімітом | Задача 4 `rightsOrphans stays complete…` | |
| М14 | `runRightsMaintenance`: прибрати звірку хешу | Задача 8 `refuses a model mismatch` | |
