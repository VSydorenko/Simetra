# П4-A4: адміністрування прав — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: чернетка автора після раунду 1 аудиту Opus; розвилки Р1–Р8
вирішено архітекторкою 2026-11-04.
Архітекторка задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** команди адміністрування прав §6.12 доведено через `runtime.run` над
тінню рушія; запис команди після зміни прав у тій самій транзакції
відмовляє (тимчасова ескалація закрита базою); план віддає повний
структурований перелік сиріт прав, з якого клієнт складає пакет очистки;
інструмент designer `rights-maintenance` (лише командний рядок, `--yes`) під
входом мігратора робить перше глобальне призначення, відновлення глобального
`fullAccess` і власника тенанта.

**Архітектура:**

- **T3 нового механізму не отримує.** Пакет — масив `Operation[]`; дію
  контексту `administerRights` T3 бере з каталогу; відмови запобіжників T3
  мапить і на `COMMIT` (`mapDatabaseError`, `packages/simetra/src/server/errors.ts`).
  Блок додає тести, що це доводять.
- **T0** (`packages/simetra/src/model/runtime/`): кодування значень реквізиту
  за каталогом рантайму переїжджає з T3 у T0 без зміни поведінки; нова
  `encodeMemberValues` — спільна валідація значень рядка учасника (A6
  перевикористає її для `creatorMember`).
- **T1** (`packages/simetra/src/compiler/`): RESTRICTIVE-політика команди
  таблиць виду поза довідниками прав відмовляє після зміни прав у транзакції
  (Р-A4-17); будівник `fullAccessHolderRows` винесено з `guard-units.ts` в
  експорт, щоб T2 не копіював SQL носіїв.
- **T2** (`packages/simetra/src/schema/apply/`): повний перелік сиріт
  `RightsOrphans` у фактах джерел прав і в результаті плану; ядро
  інструмента `runRightsMaintenance`; `ApplyDbError` несе `detail`, `column`,
  `constraint`, `table`.
- **designer:** `Tool.cliOnly` і причина відмови `cli-only`; інструмент
  `rights-maintenance`; `PlanData.rightsOrphans`; DB-тести команд прав і
  інструмента.
- **Документи:** спека П4 §6.12, §6.13, §6.15, §6.16, §7.1, §7.3, Додаток А;
  спека прав §7; спека системної схеми §3; спека designer; скіл споживача
  `simetra-metadata`; ROADMAP.

**Стек технологій:** TypeScript 7 (native `tsc`), Zod 4, Vitest, `pg` 8
(лише тести й адаптер designer), `libpg-query` (розбір SQL у unit-тестах, як
у T1), Postgres 17 локального стека Supabase, Supavisor (transaction-режим),
citty (CLI designer).

**Спека:** [спека П4](../specs/2026-10-26-p4-runtime-design.md) — §6.2 (абзац
«Режим обслуговування прав»), §6.10, §6.12, §6.13 (абзац «Застосунок без ролі
`rootCreator`»), §6.15, §6.16, §7.1–§7.3, рядок A4 у §8. [Спека
прав](../specs/2026-10-17-rights-design.md) — §4.6, §7, Рх19, Рх20.
[Спека designer](../specs/2026-10-02-simetra-designer-design.md) — §3.1,
§3.2. [Спека системної схеми](../specs/2026-10-07-system-schema-users-design.md) — §3.

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
- 🔴 Імпорти лише вниз за ярусами, **і в тестах теж** (`eslint.tier-zones.js`):
  тест T0 не імпортує T1–T3 і їхні фікстури; T2 не імпортує `simetra/server`.
- 🔴 T0 `simetra/model` — без runtime-залежностей, крім `zod`; без Node API.
- 🔴 Без шимів: перенесене з T3 у T0 видаляється з T3 у тому самому коміті;
  тести T3 переводять імпорт на `simetra/model`.
- 🔴 Інструмент обслуговування — лише командний рядок: не реєструється в MCP;
  `invoke` відмовляє `cli-only` на будь-якому каналі, крім `cli`; без `--yes`
  не відкриває з'єднання.
- 🔴 Режим обслуговування інструмент вмикає лише
  `set_config(<RIGHTS_MAINTENANCE_SETTING>, 'on', true)` у транзакції запису.
  Жодного `SET` без `LOCAL`, жодного `SET CONSTRAINTS ALL IMMEDIATE`
  (Р-A4-6), жодної передперевірки власника: бар'єр — база.
- 🔴 Кожен запис інструмента — окремий оператор з одним цільовим відношенням;
  жодного CTE. Ідентифікатори — лише з контрактів і фізичного знімка
  (`standardColumn`, `quoteIdent`); значення — лише параметри `$n`.
- 🔴 SQL носіїв `fullAccess` — лише будівник `fullAccessHolderRows` (Задача 6);
  копії JOIN з `rights_full_access_roles()` у T2 немає.
- 🔴 Нові коди діагностик — у `RULE_CODES` (`packages/simetra/src/compiler/diagnostics.ts`)
  і `messages.ts` (en, uk, підказка); тести перевіряють коди й параметри.
- 🔴 `DETAIL` бази йде назовні лише значенням з білого списку
  (`COMMAND_CORE_ERRORS.forbidden` і `.context` T0), як у T3 (Р-A3-8).
- Тести: скіл `.agents/skills/writing-tests/SKILL.md` — перед кожним кроком
  тестів. Рівень — найнижчий, що доводить. Кожен DB-кейс називає причину.
  Метадані — будівниками `packages/simetra/src/compiler/__tests__/fixtures/rights.ts`
  (нові шари — перевизначенням, типові значення не змінюються). Користувачі —
  лише `signUp`. Об'єкти стека — лише через run-tag; кластерний стан (ролі) —
  лише в `beforeAll`/`afterAll`.
- Unit-тести ядра інструмента перевіряють **властивості** послідовності
  (порядок замка, хешу й записів; `LOCAL`; один оператор без CTE; значення лише
  в параметрах), а не знімок усіх рядків.
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
| Р-A4-1 | **Команди §6.12 — без нового коду T3.** Блок додає unit-тест T3 «відмова запобіжника на `COMMIT`» і «самопризначення T3 не відхиляє сам», DB-тести designer через `runtime.run` для кожного рядка таблиці §6.12 (погоджено) | пакет, дія з каталогу й мапінг уже є (`phase.ts` `targetOf`, `transaction.ts` `terminalOf`, `errors.ts`) | немає |
| Р-A4-2 | **«База, а не T3» — два докази:** unit — самопризначення (`subject` = користувач сесії) з порт-фейком, що відповідає успіхом, проходить; DB — записувальний порт фіксує, що відмова `escalation` прийшла відповіддю бази на `COMMIT` після всіх фаз | правило §6.12 «лише мапить» інакше не має доказу | немає |
| Р-A4-3 | **Сироти — повний структурований перелік.** `RightsOrphans = { roles, deltas, assignments }` без ліміту; елемент несе `object: MetadataRef` довідника, `id`, `scope` (рівень скоупу); дельта — ще `role`; призначення — `role`, коли воно на кастомну роль-сироту. Сорти: роль, чий архетип зник чи змінив рівень → `roles`; **живе призначення на таку роль** → `assignments` з `role`; пряме призначення зниклого архетипу → `assignments`; рядок дельти ролі **поза `roles`**, що вийшов з домену → `deltas`. Ліміт `RIGHTS_SOURCE_LIMIT` — лише в тексті `plan.rights-orphans`. `rightsOrphans` несуть усі результати плану, що прочитали факти, зокрема `unchanged`. Пакет очистки: `delete` усіх `assignments` → `markDeletion` усіх `roles` → `update` ролей з `deltas` з дельтою без цих рядків (погоджено Р1 (а) з повним переліком; сорти уточнено аудитом) | лише план знає домен коду; пакет мусить складатися лише з переліку; повторний план без зміни коду — `unchanged`, і саме тоді клієнт по перелік приходить | П4 §6.12 рядок «очистити сироти»; спека прав §7 «перелік уражених кастомних ролей» → «ролей, призначень і рядків дельти» |
| Р-A4-4 | **Ідемпотентність інструмента — відмова без запису, ненульовий код виходу, назва стану** (погоджено Р2): `maintenance.not-first` (живе глобальне призначення є), `maintenance.holder-exists` (дієвий носій `fullAccess` рівня є), `maintenance.not-effective` (новий носій не дієвий — відкат). Причину `scope-has-members` зняла Р-A4-18 | інструмент обходить ⊆, кожен запуск має виправдати аварійний стан | П4 §6.12 «Поза командами» — перелік відмов |
| Р-A4-5 | **Вхід — `SIMETRA_DATABASE_URL` мігратора.** Передперевірки власника немає. Будь-яке `42501` інструмент дає як `maintenance.refused { reason }`: `reason` — `DETAIL` з білого списку (`COMMAND_CORE_ERRORS.forbidden`, `.context`), інакше `"denied"`; підказка «увійдіть роллю, що застосувала план» (погоджено Р4) | бар'єр — база; найчастіша помилка входу дає `command.context`, RLS чи `permission denied`, і всім потрібна та сама підказка | немає |
| Р-A4-6 | **Без `SET CONSTRAINTS ALL IMMEDIATE`.** Відмову відкладених запобіжників інструмент ловить як помилку `COMMIT`. Перевірка дієвості — `SELECT` до `COMMIT` | `IMMEDIATE` відкриває шлях хибної `escalation` з беклогу; інструменту нічого не дає | немає |
| Р-A4-7 | **`Tool.cliOnly?: true`.** `registerCatalog` такий інструмент пропускає; `invoke` відмовляє `cli-only`, коли `channel !== "cli"` (закрито за замовчуванням), першою перевіркою; `mcpInputSchema` повертає `tool.input` для `cliOnly` (MCP його не бачить) (погоджено Р5) | новий канал не успадкує доступ; вхід-union не ламає `mcpInputSchema` | спека designer §3.1/§3.2 |
| Р-A4-8 | **Інструмент `rights-maintenance`:** `files: "read"`, `database: "write"`, `destructive: true`, `cliOnly: true`; вхід — JSON, `z.discriminatedUnion("action", …)`: `firstGlobalAssignment { user, role }`, `restoreGlobalFullAccess { user, role? }`, `tenantFullAccess { scopeKind, scope, user, role, member? }` (форма за Р-A4-18). `role` — логічне ім'я ролі метаданих; `scopeKind` — ім'я виду скоупу (`CompiledScopeKind.name`); `user` — id рядка «Користувачів» | JSON — типова форма входу (`takesJsonInput`) | П4 §6.12 «Поза командами» |
| Р-A4-9 | **Вимоги до ролі.** Роль `assignable` (якщо контракт ролі має це поле — Задача 0). `firstGlobalAssignment` — рівень `global`; `restoreGlobalFullAccess` — `global` з `fullAccess` (без `role` — єдина така, інакше `maintenance.role-ambiguous`); `tenantFullAccess` — `assignedOn` рівно цей вид скоупу (не контейнер) з `fullAccess`. Інакше `maintenance.role-level` | «власник» — дієвий носій `fullAccess`; контейнерна роль потребує колонки контейнера, якої інструмент не пише | П4 §6.12 |
| Р-A4-10 | **Звірка моделі:** `simetra.applied_snapshot_hash()` ≠ `model.hash` → `maintenance.model-mismatch` (погоджено Р5) | фізичні імена й архетипи — з моделі | немає |
| Р-A4-11 | **Значення рядка учасника.** `member` перевіряє `encodeMemberValues` (T0) за об'єктом довідника членства з `buildRuntimeCatalog`: ключ — лише реквізит з `insert`, не з примушених (ключ, скоуп, користувач); значення — кодуванням команди. Довідника членства немає в каталозі рантайму (без ядра) → `maintenance.no-catalog`. Вставка через `jsonb_populate_record` з переліком колонок. Порушення → `maintenance.invalid-member { path }`; `23502` → `maintenance.member-required { attribute }` (погоджено зі зміною Р5) | застосунок з обов'язковим реквізитом учасника інакше не заведе власника — блокер першої міграції; одна функція для A6 | П4 §6.12 «Поза командами» — вхід `member`; §6.13 — `creatorMember` перевіряє `encodeMemberValues` |
| Р-A4-12 | **Кодування значень — у T0** (`model/runtime/values.ts`): `encodeItemValue`, `encodePair`, `isPlainObject`, `INTEGER_TEXT`, тип `Encoded<T>` і їхні приватні помічники; приватний `invalid` — у T0 свій, у T3 свій (однорядковий) | T2 не може імпортувати T3 | немає |
| Р-A4-13 | **`ApplyDbError` несе `detail?`, `column?`, `constraint?`, `table?`** — заповнює `normalize` адаптера designer (`packages/designer/src/schema-engine/apply-database.ts`) | відрізнити причини `42501` і назвати реквізит `23502` | немає |
| Р-A4-14 | **Борг не береться** (погоджено Р3) | — | немає |
| Р-A4-15 | **Обмеження хостованого Supabase** (погоджено Р4): локально доводиться вхід `postgres` прямим портом і через локальний Supavisor; хостований пулер і застосування не роллю `postgres` (власник функцій інший — режим недоступний) — ні | стек тестів лише локальний | П4 §6.15 — новий пункт |
| Р-A4-16 | **Пулер — усі кейси команд адміністрування** (`describe.each` прямий порт і пулер) (погоджено, Р8 (а)) | П4 §7.3 вимагає однакового результату для кожного кейсу `runCommand` | немає |
| Р-A4-17 | **Тимчасова ескалація закривається базою** (погоджено, Р6 (а) з умовами архітекторки прав). (1) **Позначка «права змінено»** — наявний знімок актора: рядок `simetra.rights_tx_actor` поточного `txid_current()`. Його ставлять statement-тригери знімка (`snapshotBody`, `guard-units.ts`) на кожній таблиці, зміну якої судить ⊆, і лише під контекстом команди поза режимом обслуговування — тобто рівно зміна з причиною журналу `command`. Окремого переліку таблиць немає (одне джерело). (2) **Функція** `simetra.rights_unchanged()` (`SECURITY DEFINER`, `search_path = ''`, `STABLE`, `EXECUTE` лише `simetra_command`): позначки немає → `true`; є → `RAISE 42501 MESSAGE 'command.forbidden' DETAIL 'rights-context'`. (3) **Де діє:** RESTRICTIVE-політики ролі `simetra_command` на **кожній таблиці виду, що не має тригера знімка** — `SELECT` (нова `command_select`), `INSERT`, `UPDATE`, `DELETE` — додають `(SELECT simetra.rights_unchanged())`. `ctx.read` іде в транзакції команди під `simetra_command` (`server/hook-context.ts`), тож `SELECT` обов'язковий; `runtime.read` у хуку — `command.nested` (T3), окремої транзакції читання в команді немає. (4) **Порядок:** записи й читання до зміни прав — за правами початку, дозволені; після зміни — лише таблиці з тригером знімка, їх судить ⊆ на `COMMIT`. Хук `onWrite` призначення, що читає чи пише бізнес-дані, отримує `rights-context` (fail-closed). Посилання ядра на бізнес-довідник після зміни прав у тій самій транзакції (напр. `container` другого призначення) — теж відмова. (5) **A6:** записи функції гранту `root-creator` (§6.13) позначки не ставлять — їх ⊆ не судить (знімок доповнюється законно); A6 відрізняє їх у знімку й розширює `rights_unchanged()`, а речення входить у спеку прав §7 уже в A4. **Залишок** (записати в §6.15): читання таблиць-джерел прав (ролі, призначення, членство, «Користувачі») після зміни прав у тій самій транзакції — дозволене, бо їх пише й читає ядро адміністрування | ⊆ судить кінцевий стан, а перевірка права ядра й RLS читають призначення наживо: пакет «призначити собі → записати чи прочитати X → зняти» інакше проходить | спека прав §7 — новий пункт і виняток `root-creator`; П4 §6.9 (хуки після зміни прав), §6.12, §6.15 (залишок), §6.16 — інваріант 17; спека системної схеми §3 — функція |
| Р-A4-18 | **Власник тенанта — `tenantFullAccess`** (погоджено, Р7). Умова — у скоупі немає дієвого носія `fullAccess` (інакше `holder-exists`). Користувач має рядок членства в скоупі → роль призначається цьому учаснику (`member` тоді → `invalid-member`), інакше вставляється рядок членства з `member`. Роль — рівня цього виду скоупу з `fullAccess`. Після запису — перевірка `not-effective` | тенант, чий єдиний носій став `invalid` поза командою, інакше нічим не відновити: глобальна роль довідників скоупу не адмініструє (спека прав §4.6) | П4 §6.12; спека прав §7 — «відновлення — інструмент обслуговування глобального рівня й рівня скоупу» |
| Р-A4-19 | **Замок — той самий advisory-ключ, що в `apply`** (`ADVISORY_LOCK`, `packages/simetra/src/schema/apply/execute.ts`, винести в іменовану експортовану сталу T2), `pg_try_advisory_xact_lock`; зайнято → `maintenance.busy`, нічого не записано | інструмент упорядковано і з `apply` (звірка хешу без TOCTOU), і з іншим запуском інструмента | немає |
| Р-A4-20 | **Невідомий чи недійсний користувач** — перевірка до запису: рядка «Користувачів» немає → `maintenance.unknown-user`; `invalid` → `maintenance.not-effective`. Обрив з'єднання на `COMMIT` → `maintenance.outcome-unknown` (підказка: запустіть ще раз — побачите стан); інша помилка бази — вгору, `withDatabase` дає `database.failed` | FK `23503` і невідомий результат інакше дали б невиразну відмову | немає |

## Review Focus

1. **Пакет очистки, складений лише з `rightsOrphans`, коли роль-сирота має живе призначення й дельти** — проходить; повторний план — порожній перелік (Задача 8, кейс `cleans orphans with a batch built only from the plan`).
2. **`member` з ключем механіки, реквізитом поза `insert`, невідомим ключем чи `undefined`** — `maintenance.invalid-member` з `path`, порт бази не викликано (Задача 7, крок 1).
3. **Відновлення для недійсного користувача** — `maintenance.not-effective`, нічого не записано (Задача 9, сценарій `restore`).
4. **Інструмент під час `apply` чи другого запуску** — `maintenance.busy`, нічого не записано (Задача 9, сценарій `first global`).
5. **Перелік сиріт більший за `RIGHTS_SOURCE_LIMIT`** — текст обрізано, `rightsOrphans` повний (Задача 4).

---

### Задача 0: якорі й факти

**Files:** лише читання; звіт — під цією задачею в плані.

- [ ] **Крок 1:** `orient --plan` цього файлу; розбіжності — архітекторці.
- [ ] **Крок 2:** записати фактом:
  - склад `policyDomain(adminRoles())` (`fixtures/rights.ts`): довідники
    `OrgRoles`, `OrgRoleAssignments`, `GlobalRoles`, `GlobalRoleAssignments`,
    «Користувачі», `OrgMember`; ролі з `fullAccess` (`ORG_ADMIN_ID`?,
    `GLOBAL_ADMIN_ID`) і роль лише з `administerRights` (`RightsAdmin`?);
    фізичні імена; чи `OrgMember` має ядро (є в `buildRuntimeCatalog`);
  - чи `RoleContract` має `assignable` і `maxHolders`; ім'я виду скоупу в
    `CompiledScopeKind.name` і як знайти таблицю кореня (зокрема зовнішній
    корінь `root.external`);
  - як `insertOrphan` (`packages/simetra/test/db/rights-seed.ts`) вставляє
    сироту повз запобіжники; що з нього й з `RIGHTS_ADMIN_ID` /
    `GLOBAL_ADMIN_ID` реекспортує `packages/simetra/test/support.ts`;
  - як `apply-lifecycle.db.test.ts` розгортає модель інструментами `plan` і
    `apply` (`databaseResource`, `invoke`) — зразок справжнього marker для
    Задачі 8;
  - `session_user` при вході `postgres` через локальний Supavisor (форма
    `postgres.<tenant>`, як `throughPoolerAs`) — `SELECT session_user`;
  - чи тегована роль `LOGIN SUPERUSER`, створена під `testSuperuserUrl()`,
    входить паролем прямим портом (кейс Задачі 9);
  - чи `withCopy` (`packages/designer/src/__tests__/support/db.ts`) копіює
    ціль `inTarget` і які з'єднання мають бути закриті перед `CREATE
    DATABASE … TEMPLATE` (пули тесту, бекенди пулера);
  - для Р-A4-17: на яких таблицях генератор ставить тригер знімка
    (`snapshotBody`; ролі, дельта, призначення, членство, «Користувачі»,
    таблиці зв'язку вимірів?); коли рядок `rights_tx_actor` поточного
    `xid` з'являється й зникає; чи `relationReads` (`compiler/sql/reads.ts`)
    розбирає тіла згенерованих функцій прав.
- [ ] **Крок 3:** якщо `postgres` через пулер дає інший `session_user` чи
  тегований суперкористувач не входить — архітекторці до Задачі 9.

### Задача 1: T3 — відмова на `COMMIT` і самопризначення

**Files:**
- Modify: `packages/simetra/src/server/__tests__/transaction.test.ts`

**Interfaces:** споживає `createCommandRuntime`, порт-фейк файлу. Нічого не виробляє.

- [ ] **Крок 1:** тест `maps a guard refusal answered at COMMIT` — один кейс: фейк відповідає успіхом на фази й `42501` `MESSAGE 'command.forbidden'` `DETAIL 'escalation'` на `COMMIT` → `command.forbidden` `reason: "escalation"` без `object`; послідовність завершується `COMMIT`; `release()` рівно раз. (Повний перелік причин уже тримає `errors.test.ts` › `command.forbidden keeps the allowed reason`.)
- [ ] **Крок 2:** тест `does not refuse a self-assignment on its own` — каталог з довідником призначень (`context: "administerRights"`), `create` призначення з `subject` = `sub` сесії; фейк відповідає успіхом → результат з рядком; виклик ядра й `COMMIT` надіслано.
- [ ] **Крок 3:** обидва зелені на поточному коді (тести наявного механізму); мутації М1, М2 їх червонять.
- [ ] **Крок 4:** коміт `test(server): відмова запобіжника на COMMIT і самопризначення без власних перевірок T3`.

### Задача 2: кодування значень у T0 і `encodeMemberValues`

**Files:**
- Create: `packages/simetra/src/model/runtime/values.ts`
- Modify: `packages/simetra/src/model/runtime/index.ts` (експорт)
- Modify: `packages/simetra/src/server/values.ts` (імпорт з `simetra/model`; перенесене видалено)
- Modify: `packages/simetra/src/server/__tests__/values.test.ts` (імпорт з `simetra/model`; тест паритету)
- Create: `packages/simetra/src/model/runtime/__tests__/values.test.ts`

**Interfaces:**
- Produces: `encodeItemValue(attribute: RuntimeAttribute, value: unknown, path: string): Encoded<unknown>`, `encodePair`, `isPlainObject`, `INTEGER_TEXT`, `type Encoded<T> = { value: T } | { error: CommandError }` — із `simetra/model`.
- Produces: `encodeMemberValues(object: RuntimeObject, values: unknown, forced: readonly string[]): { columns: Record<string, unknown> } | { error: CommandError }` — `values` — простий об'єкт; кожен ключ — реквізит з `insert: true`, не з `forced` (логічні імена); значення — `encodeItemValue` (пара — обидві колонки); результат — фізичні колонки → JSON-значення. Порядок помилок — як `encodeItem` (Р-A3-8). `path` — логічне ім'я реквізиту.

- [ ] **Крок 1:** перенести функції; тести T3 переводять імпорт на `simetra/model` і лишаються зеленими без зміни очікувань.
- [ ] **Крок 2:** T0-тест на вручну зібраному `RuntimeObject` — `encodeMemberValues rejects forced, non-insert, unknown and undefined keys` (`it.each`: ключ із `forced`, реквізит `insert: false`, невідомий ключ, `undefined`, не-об'єкт → `command.invalid` з очікуваним `path`) і `encodes values and pairs by physical column`.
- [ ] **Крок 3:** тест паритету в `server/__tests__/values.test.ts` — `encodeMemberValues matches encodeItem for create`: ті самі колонки й значення для `Numeric`, пари й `null`.
- [ ] **Крок 4:** реалізувати; `pnpm --filter simetra test values`, `typecheck`, `lint`.
- [ ] **Крок 5:** коміт `refactor(model): кодування значень каталогу рантайму в T0 і encodeMemberValues`.

### Задача 3: діагностики `maintenance.*` і `ApplyDbError`

**Files:**
- Modify: `packages/simetra/src/compiler/diagnostics.ts` (`RULE_CODES`), `packages/simetra/src/compiler/messages.ts`, `packages/simetra/src/compiler/__tests__/messages.test.ts`
- Modify: `packages/simetra/src/schema/apply/port.ts` (`ApplyDbError`)
- Modify: `packages/designer/src/schema-engine/apply-database.ts` (`normalize`) і його тест (наявний unit-тест адаптера; якщо немає — `packages/designer/src/schema-engine/__tests__/apply-database.test.ts` на об'єкті помилки `pg` без бази)

**Interfaces:**
- Produces: коди (усі `error`): `maintenance.model-mismatch { applied, compiled }`, `maintenance.unknown-role { role }`, `maintenance.role-level { role, expected }`, `maintenance.role-ambiguous { roles }`, `maintenance.unknown-scope-kind { scopeKind }`, `maintenance.no-catalog { level }`, `maintenance.scope-missing { scope }`, `maintenance.unknown-user { user }`, `maintenance.busy {}`, `maintenance.not-first {}`, `maintenance.holder-exists { level }`, `maintenance.not-effective { user }`, `maintenance.invalid-member { path }`, `maintenance.member-required { attribute }`, `maintenance.refused { reason }`, `maintenance.outcome-unknown {}`.
- Produces: `new ApplyDbError(message, sqlstate, extra?: { detail?: string; column?: string; constraint?: string; table?: string })` з однойменними `readonly` полями.

- [ ] **Крок 1:** `messages.test.ts` червоніє від кодів без текстів; додати тексти en/uk і підказки (`refused` — увійти роллю, що застосувала план, спека П4 §6.2; `outcome-unknown` — запустити ще раз).
- [ ] **Крок 2:** тест `normalize keeps detail, column, constraint and table` → реалізувати.
- [ ] **Крок 3:** `pnpm --filter simetra test messages`, `pnpm --filter @simetrajs/designer test apply-database`, `typecheck`, `lint`.
- [ ] **Крок 4:** коміт `feat(schema): діагностики режиму обслуговування прав і поля помилки бази`.

### Задача 4: повний перелік сиріт у плані

**Files:**
- Modify: `packages/simetra/src/schema/apply/rights-sources.ts` (`RightsOrphans`, `collectRightsFacts`, `appliedRightsSchema` + `objectId`, `RightsCatalogInput` + `rolesObject`, `assignmentsObject`)
- Modify: `packages/simetra/src/schema/apply/plan.ts` (`PlanOutcome`), `packages/simetra/src/schema/apply/index.ts` (тип)
- Modify: `packages/designer/src/tools/apply-tools.ts` (`PlanData.rightsOrphans`, зокрема для `unchanged`)
- Modify (наявні тести з літералами `orphans`): `packages/simetra/src/schema/apply/__tests__/rights-sources.test.ts`, `packages/simetra/test/db/rights-sources.db.test.ts`, `packages/designer/src/__tests__/cli.test.ts` (літерал `PlanData`)

**Interfaces:**
- Produces:
  ```ts
  export interface RightsOrphans {
    roles: { object: MetadataRef; id: string; scope?: string }[]
    assignments: { object: MetadataRef; id: string; scope?: string; role?: string }[]
    deltas: { object: MetadataRef; role: string; id: string; scope?: string }[]
  }
  ```
  `object` — логічне ім'я довідника з об'єкта **бажаної** `CompiledModel` за `objectId` (довідник із застосованого знімка — теж за `objectId`, тому `appliedRightsSchema` розбирає `objectId`); довідника немає в бажаній моделі → його рядки не потрапляють у `rightsOrphans` (команд над ним немає), лише в текст попередження. Сорти й порядок — Р-A4-3; кожен перелік відсортовано за `id`, без дублів.
- Produces: `PlanOutcome` несе `rightsOrphans?: RightsOrphans` (відсутній лише в ранніх відмовах до читання фактів); `PlanData.rightsOrphans` — з будь-якого статусу, де поле є.

- [ ] **Крок 1:** переписати наявний `finds invalid custom roles, deltas and direct assignments by row ID` під `RightsOrphans`: роль-сирота з дельтою й живим призначенням, дельта живої ролі поза доменом, пряме призначення зниклого архетипу, позначена роль → рівно очікувані переліки (дельта ролі-сироти — не в `deltas`; її призначення — у `assignments` з `role`).
- [ ] **Крок 2:** переписати `warns once for capped orphan row IDs` → `rightsOrphans stays complete past the warning limit`: `RIGHTS_SOURCE_LIMIT + 5` сиріт → повний перелік; параметри попередження — перші `RIGHTS_SOURCE_LIMIT`, `more = 5`.
- [ ] **Крок 3:** реалізувати; оновити інші літерали; `pnpm --filter simetra test rights-sources`, `pnpm --filter @simetrajs/designer test cli`, `typecheck`, `lint`. (DB-літерал `rights-sources.db.test.ts` перевіряє Задача 8 scoped-прогоном.)
- [ ] **Крок 4:** коміт `feat(schema): повний структурований перелік сиріт прав у результаті плану`.

### Задача 5: `Tool.cliOnly` і відмова `cli-only`

**Files:**
- Modify: `packages/designer/src/tools/types.ts`, `packages/designer/src/tools/invoke.ts`, `packages/designer/src/mcp/tools.ts` (`registerCatalog`, `mcpInputSchema`)
- Modify: `packages/designer/src/__tests__/catalog.test.ts` (помічник `mcpFields` пропускає `cliOnly`)
- Test: тест `invoke` (наявний файл; інакше `cli.test.ts`)

**Interfaces:** `Tool.cliOnly?: true`; `RefusalReason` + `"cli-only"`.

- [ ] **Крок 1:** тест `refuses a cli-only tool outside the cli channel before parsing input` — тестовий інструмент `cliOnly` з невалідним входом на каналі `mcp` → `cli-only`, `run` не викликано; на `cli` — звичайний шлях.
- [ ] **Крок 2:** реалізувати (перевірка `o.channel !== "cli"`); `registerCatalog` пропускає `cliOnly`; `mcpInputSchema` повертає `tool.input` для `cliOnly`.
- [ ] **Крок 3:** `pnpm --filter @simetrajs/designer test invoke catalog mcp`, `typecheck`, `lint`.
- [ ] **Крок 4:** коміт `feat(designer): інструменти лише для командного рядка`.

### Задача 6: тимчасова ескалація — правило бази (Р-A4-17)

**Files:**
- Modify: `packages/simetra/src/compiler/access-units.ts` (`writePolicies` і нова `command_select`: умова для таблиць виду без тригера знімка)
- Modify: `packages/simetra/src/compiler/rights/guard-units.ts` (функція `rights_unchanged`, гранти `EXECUTE` — як `executeGrants`; експорт переліку таблиць з тригером знімка, яким користуються і генератор тригерів, і `access-units.ts`; винести `holderRows` в експортований `fullAccessHolderRows(catalog, contracts, physical, style)` і використати його в запобіжнику без зміни SQL)
- Modify: `packages/simetra/src/compiler/index.ts` (експорт `fullAccessHolderRows`)
- Test: unit дерев SQL поруч з наявними тестами `access-units` і `guard-units`; DB — `packages/simetra/test/db/rights-guards.db.test.ts` (наявне розгортання файлу)

**Interfaces:**
- Produces: `simetra.rights_unchanged()` (Р-A4-17); `snapshotTables(...)` (назву дає виконавець) — єдиний перелік таблиць з тригером знімка; `fullAccessHolderRows(...)`: `SELECT scope, actor` носіїв `fullAccess` рівня.

- [ ] **Крок 1:** unit: на фікстурі `policyDomain(adminRoles())` політики `command_select`/`command_insert`/`command_update`/`command_delete` таблиці виду без тригера знімка містять `(SELECT simetra.rights_unchanged())` (порівняння дерев цілих операторів), таблиці з тригером знімка — ні; дерево функції й гранти (`EXECUTE` лише `simetra_command`, `REVOKE … FROM PUBLIC`).
- [ ] **Крок 2:** unit звірки джерел (умова 2 архітекторки): відношення, які читають тіла згенерованих функцій прав (`relationReads`, `packages/simetra/src/compiler/sql/reads.ts`, над SQL `rights_mine`, функцій множин, проєкції й носіїв), — таблиці застосунку з цього переліку ⊆ перелік таблиць з тригером знімка. Мутація: прибрати тригер знімка з довідника членства → тест червоний.
- [ ] **Крок 3:** DB-кейс `a command cannot use rights granted earlier in its transaction` (причина: відмову дає RLS у справжній транзакції): `commandAs` адміністратора — `save` `Task` **до** призначення проходить за правами початку; `save` призначення собі ролі з `update` на `Task` → `save` `Task` → `42501` `DETAIL 'rights-context'`; `SELECT` `Task` під `simetra_command` після призначення → та сама відмова.
- [ ] **Крок 4:** прогнати наявні DB-набори прав (`pnpm --filter simetra test:db rights-guards catalog-command-admin catalog-command-rights`). Кейс, що червоніє від нового правила, — **до архітекторки** зі сценарієм, без мовчазної правки очікувань.
- [ ] **Крок 5:** `pnpm --filter simetra test access-units guard-units`, `typecheck`, `lint`.
- [ ] **Крок 6:** коміт `fix(compiler): команда не читає й не пише поза джерелами прав після зміни прав у транзакції`.

### Задача 7: ядро `runRightsMaintenance` (T2) і інструмент `rights-maintenance`

**Files:**
- Create: `packages/simetra/src/schema/apply/rights-maintenance.ts`, `packages/simetra/src/schema/apply/__tests__/rights-maintenance.test.ts`
- Modify: `packages/simetra/src/schema/apply/execute.ts` (сталу `ADVISORY_LOCK` винести в експорт T2, напр. `APPLY_ADVISORY_LOCK`), `packages/simetra/src/schema/apply/index.ts`
- Create: `packages/designer/src/tools/rights-maintenance-tool.ts`, `packages/designer/src/__tests__/rights-maintenance-tool.test.ts`
- Modify: `packages/designer/src/tools/types.ts` (`TOOL_NAMES`), `packages/designer/src/tools/catalog.ts` (`TOOLS`), `packages/designer/src/cli/render.ts`, `packages/designer/src/__tests__/catalog.test.ts` (`names every tool once`), `packages/designer/skills/simetra-metadata/SKILL.md` (маршрут `rights-maintenance` — тест `every tool of the catalog is routed in the skill`)

**Interfaces:**
- Consumes: `encodeMemberValues` (Задача 2), коди й `ApplyDbError` (Задача 3), `fullAccessHolderRows` (Задача 6), `effectiveHolderRows`, `buildRuntimeCatalog`, `standardColumn` з `simetra/compiler`; `RIGHTS_MAINTENANCE_SETTING`, `APPLIED_SNAPSHOT_HASH_FUNCTION_NAME`, `COMMAND_CORE_ERRORS` з `simetra/model`.
- Produces:
  ```ts
  export type RightsMaintenanceRequest =
    | { action: "firstGlobalAssignment"; user: string; role: string }
    | { action: "restoreGlobalFullAccess"; user: string; role?: string }
    | { action: "tenantFullAccess"; scopeKind: string; scope: string; user: string; role: string; member?: Record<string, unknown> }
  export interface RightsMaintenanceDone { assignment: string; member?: string }
  export async function runRightsMaintenance(
    dbs: ApplyDatabase, target: DbConnection, model: CompiledModel, request: RightsMaintenanceRequest
  ): Promise<{ ok: true; done: RightsMaintenanceDone } | { ok: false; diagnostic: EngineDiagnostic }>
  ```

**Порядок** (одна `dbs.transaction(target, "commit", …)`):

1. До з'єднання: роль і вимоги Р-A4-9; вид скоупу, довідник призначень рівня, довідник членства виду (не прийняті джерела; є в каталозі рантайму); `member` — `encodeMemberValues` з `forced` = ключ, скоуп, користувач. Відмова — без звернення до порту.
2. `SELECT pg_try_advisory_xact_lock(<APPLY_ADVISORY_LOCK>)` → `false` — `maintenance.busy`.
3. `SELECT simetra.applied_snapshot_hash()` ≠ `model.hash` → `model-mismatch`.
4. Користувач: рядка «Користувачів» немає → `unknown-user`; `invalid` → `not-effective`.
5. Стан: `firstGlobalAssignment` — живе глобальне призначення → `not-first`; `restoreGlobalFullAccess` — рядок `fullAccessHolderRows` глобального рівня → `holder-exists`; `tenantFullAccess` — кореня немає → `scope-missing`; рядок `fullAccessHolderRows` з `scope` = скоуп → `holder-exists`; рядок членства користувача в скоупі є → учасник наявний (`member` тоді → `invalid-member`).
6. `SELECT set_config($1, 'on', true)`.
7. Нового учасника: ключ — `SELECT gen_random_uuid()`; `INSERT INTO <членство> (<колонки>) SELECT <колонки> FROM jsonb_populate_record(NULL::<членство>, $1::jsonb)` — колонки `member` плюс ключ, скоуп, користувач.
8. Ключ призначення — `gen_random_uuid()`; `INSERT INTO <призначення> (<ключ>, [<скоуп>,] <subject>, <archetype>) VALUES ($1, …)`; `subject` — користувач (глобальний рівень) чи учасник (скоуп).
9. Дієвість (`actor` — завжди **користувач**): `restoreGlobalFullAccess` — рядок `fullAccessHolderRows` з `actor = user`; `tenantFullAccess` — з `scope` і `actor = user`; `firstGlobalAssignment` — рядок `effectiveHolderRows` глобального рівня з `actor = user` і `archetype = role`. Немає → виняток → відкат → `not-effective`.
10. `COMMIT`. Мапінг помилок — Р-A4-5, Р-A4-11, Р-A4-20.

- [ ] **Крок 1:** unit на порт-фейку `ApplyDatabase` (`rights-maintenance.test.ts`):
  - `it.each` відмов кроку 1 (невідома роль, роль не того рівня, без `fullAccess`, неоднозначна, контейнерна, невідомий вид скоупу, прийняте джерело, довідник членства поза каталогом рантайму, `member` з примушеним ключем) — порт не викликано;
  - властивості: замок — перший оператор; хеш — до першого читання стану; `set_config` має третій аргумент `true` і стоїть до першого `INSERT`; кожен оператор — один оператор без CTE з одним цільовим відношенням (розбір `libpg-query`); значення входу (рядок з лапкою в `member`) є лише в параметрах;
  - `it.each(actions)`: порожня відповідь перевірки дієвості → `not-effective`, `COMMIT` не надіслано;
  - мапінг: `ApplyDbError('command.forbidden','42501',{detail:'rights-context'})` → `refused { reason: "rights-context" }`; `42501` з невідомим `DETAIL` → `reason: "denied"`, `DETAIL` назовні не йде; `23502` з колонкою членства → `member-required` з реквізитом; `ApplyConnectionLost` на `COMMIT` → `outcome-unknown`; інша помилка — вгору.
- [ ] **Крок 2:** реалізувати `runRightsMaintenance`.
- [ ] **Крок 3:** інструмент: `readMetadataDir` → `compile`; помилки компіляції — відмова без з'єднання; `createApplyDatabase` — лінивим `import("../schema-engine")`, як `roles-tool.ts`; `withDatabase(required(database), "rights-maintenance", …)`; опис англійською (лише CLI, `--yes`, вхід мігратора, дії, відмови).
- [ ] **Крок 4:** тести інструмента: `does not connect without confirmation` — `invoke(tool, input, { channel: "cli", confirmed: false, database: fake })`, де `fake.connect` рахує виклики → `unconfirmed`, `connect` не викликано; `runTool` без `--yes` → код виходу 2; `is absent from MCP` — `tools/list` без `rights-maintenance` (точний перелік `lists every catalog tool in read-only mode` не змінюється).
- [ ] **Крок 5:** `pnpm --filter simetra test rights-maintenance`, `pnpm --filter @simetrajs/designer test rights-maintenance catalog skill-examples cli mcp`, `typecheck`, `lint` обох пакетів.
- [ ] **Крок 6:** коміт `feat(designer): інструмент обслуговування прав rights-maintenance`.

### Задача 8: DB-тести команд адміністрування прав

**Files:**
- Create: `packages/designer/src/__tests__/rights-admin-commands.db.test.ts`
- Modify: `packages/designer/src/__tests__/support/db.ts` — засів під режимом обслуговування (`committed`, `seedUnderMaintenance`) винести з `command-runtime.db.test.ts`, якщо новий файл його повторює; записувальна обгортка `recordingDatabase(inner: CommandDatabase)` (тексти операторів і на якому прийшла помилка)
- Modify: `packages/simetra/test/support.ts` — реекспорт `insertOrphan` і ідентифікаторів ролей, якщо Задача 0 показала, що їх немає

**Причина рівня:** запобіжники судять на `COMMIT` у справжній транзакції з закоміченими даними; пулер; план читає дані цілі.

Розгортання — одне, **справжнім `plan` + `apply`** (зразок `apply-lifecycle.db.test.ts`): marker з канонічним знімком потрібен і рантайму (хеш), і плану (факти прав). Актори: `admin` — учасник з роллю лише `administerRights`; `holder` — учасник з архетипом `fullAccess` org; `peer`, `third` — учасники без прав. Кейси, крім сиріт, — `describe.each` прямий порт і пулер (Р-A4-16).

- [ ] **Крок 1:** кейси команд:
  - `creates, updates and marks a custom role` — `create` ролі з дельтою → журнал `reason = 'command'`, `actor` = `admin`; `update` з поточною версією й новою дельтою → версія +1, дельта замінена; `update` зі старою версією → `command.conflict` `reason: "version"`, `currentVersion`;
  - `assigns and unassigns a role` — `create` призначення кастомної ролі `peer` → `delete` з версією → `markDeletion` ролі → усе проходить;
  - `refuses to mark a role in use` → `command.forbidden` `role-in-use`, роль не позначена;
  - `refuses self-assignment as escalation at COMMIT` — `admin` призначає собі ширшу роль → `command.forbidden` `escalation`; `recordingDatabase`: помилка прийшла на `COMMIT` після виклику ядра;
  - `refuses a non-holder granting fullAccess` — `admin` призначає `peer` архетип `fullAccess` → `escalation`;
  - `transfers fullAccess in one batch, own assignment first` — `holder` пакетом `[delete свого, create fullAccess для third]` → проходить (лише тому, що `last-full-access` судять на `COMMIT`); `third` — дієвий носій;
  - `refuses to drop the last fullAccess holder` — одне `delete` свого → `last-full-access`;
  - тимчасова ескалація (Р-A4-17; кожен червоний без правила, М7): `admin` без права на рядок `X`, ширша роль `R` дає `update` і `read` на `X`:
    - `assign → update X → unassign in one batch` — пакет `[create призначення собі R, update X, delete призначення]` → `command.forbidden` `rights-context`; `X` незмінний;
    - `assign → read X → unassign through a hook` — модуль довідника призначень: `onWrite` викликає `ctx.read({ object: X, id })`; пакет `[create призначення собі R, delete призначення]` → `rights-context`, хук нічого не повернув назовні;
    - `assign → update X through ctx.run in a hook` — `onWrite` призначення викликає `ctx.run(update X)` → `rights-context`;
    - пакет передачі `fullAccess` (кейс вище) проходить — правило його не зачіпає.
- [ ] **Крок 2:** кейс `cleans orphans with a batch built only from the plan` (прямий порт): засів `insertOrphan`-способом — роль-сирота з дельтою й живим призначенням `peer`, жива роль з рядком дельти поза доменом і рядком у домені, пряме призначення зниклого архетипу; `runTool("plan", …, --format json)` → статус `unchanged`, `rightsOrphans` непорожній; пакет `admin` будується **лише** з `rightsOrphans` (рядки дельти для заміни тест читає власником, як клієнт своїм шляхом) за порядком Р-A4-3 → проходить; повторний `plan` → `rightsOrphans` порожній.
- [ ] **Крок 3:** кейс `orphans stay listed when the batch fails` — пакет з `markDeletion` ролі-сироти без зняття її призначення → `role-in-use`; повторний `plan` → `rightsOrphans` незмінний (не порожній).
- [ ] **Крок 4:** `pnpm --filter @simetrajs/designer test:db rights-admin-commands`, `pnpm --filter simetra test:db rights-sources` — зелено; час записати.
- [ ] **Крок 5:** коміт `test(designer): команди адміністрування прав через рантайм над тінню`.

### Задача 9: DB-тести інструмента обслуговування

**Files:**
- Create: `packages/designer/src/__tests__/rights-maintenance.db.test.ts`
- Modify: `packages/simetra/test/db/command-grants.db.test.ts` (кейс справжнього `simetra_runtime`)
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` — шар `requiredMemberAttribute()` (перевизначення `OrgMember` з обов'язковим реквізитом застосунку без `DEFAULT`)

**Причина рівня:** режим вирішує `session_user` справжньої сесії; запобіжники — на `COMMIT`.

Розгортання — одне (`inTarget` з `seedMarker(model.hash)`); **глобальні сценарії — кожен у своїй копії** (`withCopy`), бо глобальний `fullAccess`, раз записаний, не зняти навіть у режимі (`last-full-access`). Сценарії рівня скоупу — на розгортанні, кожен у своєму `org`.

- [ ] **Крок 1:** сценарії (у послідовному `describe`):
  - `first global` (копія): сесія тесту тримає `pg_advisory_xact_lock(<APPLY_ADVISORY_LOCK>)` → інструмент `busy`, нічого не записано; замок знято → `runTool` CLI з `--yes` → призначення є; журнал: `actor IS NULL`, `reason = 'maintenance'`, `action IS NULL`; повтор → `not-first`, код виходу ≠ 0, рядків не додано;
  - `restore` (копія): носій є → `holder-exists`; носія зроблено `invalid` (поза командою — дозволений виняток) → відновлення для іншого недійсного користувача → `not-effective`, нічого не записано → для дійсного — проходить, він дієвий носій;
  - `pooler` (копія): вхід `postgres` через локальний Supavisor (форма Задачі 0) → перше глобальне призначення проходить;
  - `tenant` (розгортання, шар `requiredMemberAttribute`): корінь `org` без учасників → без `member` → `member-required` з реквізитом, нічого не записано → з `member` → рядок членства з примушеними ключем, скоупом, користувачем; користувач — дієвий носій → повтор → `holder-exists`;
  - `tenant restore` (за Р-A4-18): єдиний носій `org` став `invalid` → `tenantFullAccess` для наявного учасника → призначення без нового рядка членства; `member` при наявному учаснику → `invalid-member`;
  - `scope missing` → `scope-missing`.
- [ ] **Крок 2:** межа режиму на шляху інструмента: `a superuser that is not the migrator cannot enable maintenance` — тегована `LOGIN SUPERUSER` роль (`beforeAll`, прибирання в `afterAll`; не власник функцій, поза `PROVIDER_LOGIN_ROLES`; RLS і гранти обходить) → інструмент → `refused { reason: "rights-context" }`, нічого не записано. Червоніє лише від умови `session_user = current_user` (М3).
- [ ] **Крок 3:** справжня загроза рантайму — кейс у `command-grants.db.test.ts` › `runtime login role`: `the runtime login cannot enable maintenance even with a command context` — `SET SESSION AUTHORIZATION simetra_runtime` (справжня роль `supabase/roles.sql`), `BEGIN`, claims адміністратора, `set_config(<maintenance>, 'on', true)`, `SET LOCAL ROLE simetra_command`, контекст `administerRights`, ядро `save` самопризначення ширшої ролі → `COMMIT` → `42501` `escalation` (режим не ввімкнувся, ⊆ діє). Межу провайдера тримають наявні `rights-guards.db.test.ts` › `maintenance only from the owner login` (М4).
- [ ] **Крок 4:** `pnpm --filter @simetrajs/designer test:db rights-maintenance`, `pnpm --filter simetra test:db command-grants` — зелено; час записати.
- [ ] **Крок 5:** коміт `test(designer): інструмент обслуговування прав і межі режиму`.

### Задача 10: мутації

- [ ] **Крок 1:** на закоміченому дереві — кожна мутація журналу, названий scoped тест, «що прибрано → що почервоніло», відкат (`git checkout -- <файл>`). DB-мутації — по одній.
- [ ] **Крок 2:** коміт `docs(plan): П4-A4 — журнал мутацій`.

### Задача 11: документи

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` — §6.9 (хук після зміни прав у транзакції — `rights-context`), §6.12 (рядок «очистити сироти», абзац «Поза командами»: `rights-maintenance`, дії, `member`, відмови, звірка хешу, замок `apply`; правило Р-A4-17), §6.13 (`creatorMember` перевіряє `encodeMemberValues`; записи `root-creator` позначки не ставлять), §6.15 (Р-A4-15; залишок читання джерел прав Р-A4-17), §6.16 (інваріант 17: після зміни прав команда читає й пише лише таблиці-джерела прав), §7.1 (рядки DB designer), §7.2 (кейси тимчасової ескалації), Додаток А (рядки з блоком A4)
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` — §7 (перелік сиріт; відновлення — інструмент глобального рівня й рівня скоупу; правило Р-A4-17 з винятком `root-creator`)
- Modify: `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` — §3 (`simetra.rights_unchanged()`)
- Modify: `docs/superpowers/specs/2026-10-02-simetra-designer-design.md` — §3.1/§3.2 (`rights-maintenance`, `cliOnly`, `cli-only`)
- Modify: `packages/designer/skills/simetra-metadata/references/people-and-rights.md` — команди адміністрування через рантайм (операції, пакет передачі, пакет очистки з `rightsOrphans`, заборона використати щойно надане право), інструмент обслуговування
- Modify: `docs/ROADMAP.md` — статус A4

- [ ] **Крок 1:** внести; `python3 scripts/check-doc-anchors.py`.
- [ ] **Крок 2:** коміт `docs(spec): П4-A4 — адміністрування прав і інструмент обслуговування`.

### Задача 12: перевірка й звіт

- [ ] **Крок 1:** перевірка за `/виконай-задачу`: лінзи `code-review` за дифом, обов'язкові `correctness` (режим лише для мігратора; ескалація через пакет; без `--yes` — нічого) і `test-honesty`; кожну знахідку — `code-review-verifier`.
- [ ] **Крок 2:** контрольна точка архітекторці після DB-тестів.
- [ ] **Крок 3:** повні гейти на одному SHA — лише після «можна».

## Журнал мутацій

| № | Мутація | Тест, що має почервоніти | Результат |
| --- | --- | --- | --- |
| М1 | `errors.ts`: прибрати `escalation` з `FORBIDDEN_REASONS` | Задача 1 `maps a guard refusal answered at COMMIT`; Задача 8 `refuses self-assignment…` | |
| М2 | `phase.ts`: T3 відмовляє операції з `context = administerRights`, де `subject` = `sub` | Задача 1 `does not refuse a self-assignment on its own` | |
| М3 | `guard-units.ts` `maintenanceSql`: прибрати `session_user = current_user` | Задача 9 `a superuser that is not the migrator…`; `command-grants` › `the runtime login cannot enable maintenance…` | |
| М4 | `guard-units.ts` `maintenanceSql`: прибрати умову `PROVIDER_LOGIN_ROLES` | наявний `rights-guards` › `maintenance only from the owner login` (власник `supabase_admin`) | |
| М5 | `guard-units.ts`: гілка `assignment` у `catalogCheck` без перевірки приросту | Задача 8 `refuses a non-holder granting fullAccess` | |
| М6 | `guard-units.ts`: перевірку `holders` перенести з відкладеного тригера в оператор | Задача 8 `transfers fullAccess in one batch, own assignment first` | |
| М7 | `access-units.ts`: прибрати `rights_unchanged()` з політик запису | Задача 6 DB-кейс; Задача 8 `assign → update X…`, `…through ctx.run…` | |
| М7а | `access-units.ts`: прибрати політику `command_select` | Задача 6 DB-кейс (`SELECT`); Задача 8 `assign → read X → unassign through a hook` | |
| М7б | `guard-units.ts`: не ставити тригер знімка на довідник членства | Задача 6 крок 2 (звірка джерел) | |
| М8 | `invoke.ts`: прибрати відмову `cli-only` | Задача 5 `refuses a cli-only tool…` | |
| М9 | `registerCatalog`: не пропускати `cliOnly` | наявний `mcp.test.ts` › `lists every catalog tool in read-only mode`; Задача 7 `is absent from MCP` | |
| М10 | інструмент: `destructive: false` | Задача 7 `does not connect without confirmation` | |
| М11 | ядро: перевірку `not-first` прибрати | Задача 9 `first global` (повтор) | |
| М12 | ядро: перевірку `holder-exists` прибрати | Задача 9 `restore`, `tenant` (повтор) | |
| М13 | ядро: замок прибрати чи перенести після читання стану | Задача 7 властивість «замок — перший»; Задача 9 `first global` (`busy`) | |
| М14 | ядро: перевірку дієвості прибрати | Задача 7 `it.each(actions)` `not-effective`; Задача 9 `restore` | |
| М15 | ядро: `set_config(…, false)` чи без третього аргументу | Задача 7 властивість `LOCAL` | |
| М16 | ядро: значення інтерполювати в текст | Задача 7 властивість «значення лише в параметрах» | |
| М17 | ядро: звірку хешу прибрати | Задача 7 (`model-mismatch` до `set_config`) | |
| М18 | ядро: `42501` без білого списку `DETAIL` | Задача 7 мапінг `reason: "denied"` | |
| М19 | ядро: `23502` → `database.failed` | Задача 7 мапінг; Задача 9 `tenant` (`member-required`) | |
| М20 | ядро: перевірку `scope-missing` прибрати | Задача 9 `scope missing` | |
| М21 | `normalize`: не заповнювати `detail` | Задача 3 `normalize keeps…`; Задача 9 `a superuser that is not the migrator…` | |
| М22 | `encodeMemberValues`: не перевіряти `forced` | Задача 2 `…rejects forced…` | |
| М23 | `collectRightsFacts`: обрізати `rightsOrphans` лімітом | Задача 4 `rightsOrphans stays complete…` | |
| М24 | `collectRightsFacts`: не класти призначення ролей-сиріт | Задача 4 крок 1; Задача 8 `cleans orphans…` | |
| М25 | `apply-tools.ts`: не віддавати `rightsOrphans` для `unchanged` | Задача 8 `cleans orphans…` | |
