# П4-A4: адміністрування прав — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: після трьох раундів аудиту Opus і аудиту Codex; розвилки Р1–Р8
вирішено архітекторкою 2026-11-04 (Р6 переглянуто після раунду 2); чекає
«далі» архітекторки.
Архітекторка задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** команди адміністрування прав §6.12 доведено через `runtime.run` над
тінню рушія; T3 закриває тимчасовим бар'єром вектор «призначити собі →
скористатися → зняти» в пакеті й хуках (до блоку Права-3); план віддає повний
структурований перелік сиріт прав, з якого клієнт складає пакет очистки;
інструмент designer `rights-maintenance` (лише командний рядок, `--yes`) під
входом мігратора робить перше глобальне призначення, відновлення глобального
`fullAccess` і власника тенанта.

**Архітектура:**

- **T3** (`packages/simetra/src/server/`): прав не перевіряє й відмов
  запобіжників лише мапить. Єдиний новий механізм — тимчасовий бар'єр
  Р-A4-17 на межі фаз і викликів `ctx`, за фактом каталогу
  (`operations.<операція>.context`).
- **T0** (`packages/simetra/src/model/runtime/`): кодування значень реквізиту
  за каталогом рантайму переїжджає з T3 у T0 без зміни поведінки; нова
  `encodeMemberValues` — спільна валідація значень рядка учасника (A6
  перевикористає її для `creatorMember`).
- **T1** (`packages/simetra/src/compiler/`): будівник `fullAccessHolderRows`
  винесено з `guard-units.ts` в експорт, щоб T2 не копіював SQL носіїв.
- **T2** (`packages/simetra/src/schema/apply/`): повний перелік сиріт
  `RightsOrphans` у фактах джерел прав і в результаті плану; ядро
  інструмента `runRightsMaintenance`; `ApplyDbError` несе `detail`,
  `column`, `constraint`, `table`; стала advisory-замка `apply` — в експорт.
- **designer:** `Tool.cliOnly` і причина відмови `cli-only`; інструмент
  `rights-maintenance`; дані `plan` для `unchanged`; DB-тести команд прав і
  інструмента.
- **Документи:** спека П4 §6.9, §6.12, §6.13, §6.15, §6.16, §7.1, §7.2,
  Додаток А; спека прав §7; спека designer; скіл споживача `simetra-metadata`;
  ROADMAP; бриф блоку Права-3 — архітекторці (поза репо).

**Стек технологій:** TypeScript 7 (native `tsc`), Zod 4, Vitest, `pg` 8
(лише тести й адаптер designer), `libpg-query` (розбір SQL у unit-тестах),
Postgres 17 локального стека Supabase, Supavisor (transaction-режим), citty.

**Спека:** [спека П4](../specs/2026-10-26-p4-runtime-design.md) — §6.2 (абзац
«Режим обслуговування прав»), §6.5, §6.9, §6.10, §6.12, §6.13 (абзац «Застосунок
без ролі `rootCreator`»), §6.15, §6.16, §7.1–§7.3, рядок A4 у §8. [Спека
прав](../specs/2026-10-17-rights-design.md) — §4.6, §7, Рх19, Рх20.
[Спека designer](../specs/2026-10-02-simetra-designer-design.md) — §3.1, §3.2.

**Залежність:** A1, A2, A3, борг-1, Права-2d2, борг-2 — у `main` (88770a0a).
Робоча гілка — `feat/p4-a4`, де лежить і цей план. Перед стартом:
`.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-31-p4-a4-rights-administration.md`.
Розбіжність якорів із кодом — архітекторці до старту.

## Global Constraints

- 🔴 `pnpm --filter <pkg> test <pattern>` і `pnpm --filter <pkg> test:db <pattern>` — **без** `--` перед шаблоном.
- 🔴 T3 (`src/server`) не перевіряє прав і не має гілки за назвою довідника
  прав чи причиною запобіжника: відмови запобіжників лише мапить (П4 §6.12).
  Єдиний виняток — бар'єр Р-A4-17, що читає лише `context` операції з
  каталогу. Імпорти `src/server` — лише `./…`, `simetra/model`, `zod`,
  `node:async_hooks` (Р-A3-10).
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
- 🔴 SQL носіїв `fullAccess` — лише будівник `fullAccessHolderRows`; копії
  JOIN з `rights_full_access_roles()` у T2 немає.
- 🔴 Нові коди діагностик — у `RULE_CODES` (`packages/simetra/src/compiler/diagnostics.ts`)
  і `messages.ts` (en, uk, підказка); тести перевіряють коди й параметри.
- 🔴 `DETAIL` бази йде назовні лише значенням з білого списку пар
  (`message`, `detail`), як `mapDatabaseError` T3 (Р-A3-8).
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
| Р-A4-1 | **Команди §6.12 — без нового коду T3, крім бар'єру Р-A4-17.** Блок додає unit-тести T3 «відмова запобіжника на `COMMIT`» і «самопризначення T3 не відхиляє сам», DB-тести designer через `runtime.run` для кожного рядка таблиці §6.12 (погоджено) | пакет, дія з каталогу й мапінг уже є (`phase.ts` `targetOf`, `transaction.ts` `terminalOf`, `errors.ts`) | немає |
| Р-A4-2 | **«База, а не T3» — два докази:** unit — самопризначення (`subject` = учасник користувача сесії) з порт-фейком, що відповідає успіхом, проходить; DB — записувальний порт фіксує, що відмова `escalation` прийшла відповіддю бази на `COMMIT` після всіх фаз | правило §6.12 «лише мапить» інакше не має доказу | немає |
| Р-A4-3 | **Сироти — повний структурований перелік.** `RightsOrphans = { roles, assignments, deltas }` без ліміту; елемент несе `object: MetadataRef` довідника, `id`, `version` (очікувана версія операції; у дельти — версія її ролі), `scope` (id скоупу рядка на рівні скоупу); дельта — ще `role`; призначення на кастомну роль-сироту — `role`. Сорти: роль, чий архетип зник чи змінив рівень → `roles`; **живе призначення на таку роль** → `assignments` з `role`; пряме призначення зниклого архетипу → `assignments`; рядок дельти ролі **поза `roles`**, що вийшов з домену → `deltas`. Ліміт `RIGHTS_SOURCE_LIMIT` — лише в тексті `plan.rights-orphans`. Дані `plan`: `PlanData` несе `rightsOrphans`; статус `unchanged` дає `UnchangedPlanData = { unchanged: true; rightsOrphans }` (раніше — без даних); без довідників прав — порожні переліки. Пакет очистки: `delete` усіх `assignments` → `markDeletion` усіх `roles` → `update` ролей з `deltas` з дельтою без цих рядків; рядки дельти, що лишаються, клієнт читає сам (читання ТЧ — П4-B); застаріла версія — `command.conflict` (погоджено Р1 (а); сорти й версію уточнено аудитом) | лише план знає домен коду; повторний план без зміни коду — `unchanged`, і саме тоді клієнт по перелік приходить | П4 §6.12 рядок «очистити сироти»; спека прав §7 «перелік уражених кастомних ролей» → «ролей, призначень і рядків дельти» |
| Р-A4-4 | **Ідемпотентність інструмента — відмова без запису, ненульовий код виходу, назва стану** (погоджено Р2): `maintenance.not-first`, `maintenance.holder-exists`, `maintenance.not-effective` | інструмент обходить ⊆, кожен запуск має виправдати аварійний стан | П4 §6.12 «Поза командами» — перелік відмов |
| Р-A4-5 | **Вхід — `SIMETRA_DATABASE_URL` мігратора.** Передперевірки власника немає. Читання стану — під `row_security = off` (як `readRightsSourceFacts`): вхід, що не обходить RLS, отримує гучне `42501`, а не тихі нулі. Будь-яке `42501` → `maintenance.refused { reason }`: `reason` — `DETAIL`, лише коли пара (`message`, `detail`) з білого списку (`command.forbidden` × `COMMAND_CORE_ERRORS.forbidden`, `command.context` × `.context`), інакше `"denied"`; підказка «увійдіть роллю, що застосувала план» (погоджено Р4) | бар'єр — база; найчастіша помилка входу дає `command.context`, RLS чи `permission denied`; SQL застосунку може кинути той самий `DETAIL` | немає |
| Р-A4-6 | **Без `SET CONSTRAINTS ALL IMMEDIATE`.** Відмову відкладених запобіжників інструмент ловить як помилку `COMMIT`. Перевірка дієвості — `SELECT` до `COMMIT` | `IMMEDIATE` відкриває шлях хибної `escalation` з беклогу; інструменту нічого не дає | немає |
| Р-A4-7 | **`Tool.cliOnly?: true`.** `registerCatalog` такий інструмент пропускає; `invoke` відмовляє `cli-only`, коли `channel !== "cli"`, першою перевіркою; `mcpInputSchema` повертає `tool.input` для `cliOnly` (погоджено Р5) | новий канал не успадкує доступ; вхід-union не ламає `mcpInputSchema` | спека designer §3.1/§3.2 |
| Р-A4-8 | **Інструмент `rights-maintenance`:** `files: "read"`, `database: "write"`, `destructive: true`, `cliOnly: true`; вхід — JSON, `z.discriminatedUnion("action", …)` з `z.strictObject`: `firstGlobalAssignment { user, role }`, `restoreGlobalFullAccess { user, role? }`, `tenantFullAccess { scopeKind, scope, user, role, member? }`. `role` — логічне ім'я ролі метаданих; `scopeKind` — ім'я виду скоупу (`CompiledScopeKind.name`); `user`, `scope` — UUID | JSON — типова форма входу (`takesJsonInput`) | П4 §6.12 «Поза командами» |
| Р-A4-9 | **Вимоги до ролі.** Роль `assignable` (якщо контракт ролі має поле — Задача 0). `firstGlobalAssignment` — рівень `global`; `restoreGlobalFullAccess` — `global` з `fullAccess` (без `role` — єдина така; кілька → `role-ambiguous`; жодної → `role-level`); `tenantFullAccess` — `assignedOn` рівно цей вид скоупу (не контейнер) з `fullAccess`. Інакше `maintenance.role-level`. `maxHolders` SQL ніде не тримає — інструмент теж ні, як команди | «власник» — дієвий носій `fullAccess`; контейнерна роль потребує колонки контейнера | П4 §6.12 |
| Р-A4-10 | **Звірка моделі:** `simetra.applied_snapshot_hash()` ≠ `model.hash` → `maintenance.model-mismatch` (погоджено Р5); функції чи схеми немає (`42883`, `3F000`) → `model-mismatch { applied: "none" }`, як `NO_APPLIED_STATE` рантайму | фізичні імена й архетипи — з моделі | немає |
| Р-A4-11 | **Значення рядка учасника.** `member` перевіряє `encodeMemberValues` (T0) за об'єктом довідника членства з `buildRuntimeCatalog`: ключ — лише реквізит з `insert`, не з примушених (ключ, скоуп, користувач); значення — кодуванням команди. Довідника членства немає в каталозі рантайму (без ядра) чи членство — прийняте джерело → `maintenance.no-catalog`, але **лише на гілці вставки нового учасника** (після читання стану, до `set_config` режиму): наявному учаснику роль призначається й без каталогу членства. Вставка через `jsonb_populate_record` з переліком колонок. Порушення → `maintenance.invalid-member { path }`; `23502` → `maintenance.member-required { attribute }` (погоджено зі зміною Р5) | застосунок з обов'язковим реквізитом учасника інакше не заведе власника — блокер першої міграції; одна функція для A6 | П4 §6.12 «Поза командами» — вхід `member`; §6.13 — `creatorMember` перевіряє `encodeMemberValues` |
| Р-A4-12 | **Кодування значень — у T0** (`model/runtime/values.ts`): `encodeItemValue`, `encodePair`, `isPlainObject`, `INTEGER_TEXT`, тип `Encoded<T>` і їхні приватні помічники; приватний `invalid` — у T0 свій, у T3 свій (однорядковий) | T2 не може імпортувати T3 | немає |
| Р-A4-13 | **`ApplyDbError` несе `detail?`, `column?`, `constraint?`, `table?`** — заповнює `normalize` адаптера designer (`packages/designer/src/schema-engine/apply-database.ts`, експортувати для unit-тесту) | відрізнити причини `42501` і назвати реквізит `23502` | немає |
| Р-A4-14 | **Борг не береться** (погоджено Р3) | — | немає |
| Р-A4-15 | **Обмеження хостованого Supabase** (погоджено Р4): локально доводиться вхід `postgres` прямим портом і через локальний Supavisor; хостований пулер і застосування не роллю `postgres` (власник функцій інший — режим недоступний) — ні | стек тестів лише локальний | П4 §6.15 — новий пункт |
| Р-A4-16 | **Пулер — усі кейси команд адміністрування** (`describe.each` прямий порт і пулер) (погоджено Р8 (а)) | П4 §7.3 | немає |
| Р-A4-17 | **Тимчасовий бар'єр T3 до блоку Права-3** (погоджено Р6: (В) + бар'єр). Транзакція команди (`Transaction`/стан спроби) запам'ятовує, що почалася фаза над об'єктом з `operations.<операція>.context = administerRights` (назва дії — з T0, `administerRightsAction`); ознака ставиться **на початку** такої фази, до її хука «до». Ознаку T3 перевіряє **синхронно безпосередньо перед постановкою в чергу** виклику ядра фази не-прав і оператора `ctx.read` (черга FIFO): так закрито і фазу застосунку, чий `beforeWrite` сам виконав `ctx.run` фази прав, і паралельні неочікувані `ctx.run` одного хука. Відмова — `command.forbidden` `reason: "rights-context"` без звернення до бази для цієї операції; черга закривається, як для будь-якої відмови (Р-A3-15). Ціль `ctx.read` — об'єкт каталогу рантайму; «прав» — коли всі його операції мають `context = administerRights` (`actionsOf` змішаних не дає). Ознака — поле `Transaction` (новий екземпляр на спробу), тож повтор (`40001`) починає з чистою ознакою. Довідник членства — дані застосунку: хук `onWrite` членства, що призначає роль через `ctx.run`, робить наступні фази пакета й наступні `ctx.read`/`ctx.run` цього хука неможливими (fail-closed; призначення — останньою фазою чи окремою командою з `afterCommit`; у т.ч. для хуків членства A6). Ядро `create` кореня A6 (§6.13) — фаза застосунку з грантом усередині ядра, без фази прав T3, тож ознаки не ставить; A6 додає наскрізний DB-кейс «корінь → призначення останньою фазою → `COMMIT`» і «фаза даних після призначення → `rights-context`». Внутрішні читання ядра (`subject`, ТЧ, `RETURNING`) і SQL-підписки бар'єр не чіпає: друге призначення в пакеті й передача `fullAccess` проходять. Хук «до» чи «після» фази прав з `ctx.read`/`ctx.run` даних застосунку → відмова. Це звуження вектора, не закриття: код host-а з пулом `simetra_runtime` обходить T3 (Рт6), і діра бази лишається до Права-3 | ⊆ судить кінцевий стан, а перевірка права ядра й RLS читають призначення наживо; делегований адміністратор скоупу з `administerRights` інакше тимчасово отримує будь-які дані свого скоупу | П4 §6.5 (крок перевірки ознаки перед викликом ядра), §6.9 (хуки фази прав і хуки членства), §6.10 (`rights-context` у `command.forbidden` може дати й T3), §6.12, §6.15 (діра як відоме обмеження + тимчасовий бар'єр з посиланням на Права-3), §6.16 (інваріант 17 рівня T3); спека прав §7 — посилання на Права-3 |
| Р-A4-17 (підстава) | **Членство — по бік даних застосунку; бар'єр на ньому ознаки не ставить (гілка (А) архітекторки).** Рядок учасника без призначення актору прав не дає: роль скоупу тримається лише на призначенні (`catalogAssignments`/`sourceAssignments` у `compiler/rights/functions.ts` з'єднують `my_scopes` за id учасника), `own` і вимір парують скоуп ролі (`rights_own`/`rights_dim` — лише скоупи з рядками ролі (`scopesBody`)), а «кожен користувач» відкриває лише нескоуплені об'єкти й без `any` (`expand.ts` `allowedActions`, `levelAllowsExtent`). Новий id учасника рядків не має: призначення, носії власності й рядки зв'язку виміру посилаються на нього FK, а повторну вставку id з призначеннями відхиляє тригер членства. Зробити учасником себе команда не може: `create` на членстві скоупу дає лише роль, яку тримає його учасник, а ключ (скоуп, користувач) другого рядка не пускає; користувач, скоуп і ключ рядка незмінні, самоприйняття вже учасником відхиляє тригер. Що змінює запис даних застосунку (атрибут рядка учасника як зв'язок виміру чи шлях власності, рядки довідника зв'язку), те саме дає й постійний запис, який ⊆ не судить за задумом (спека прав §4.4) — тимчасовий запис не дає більшого. DB-кейси `rights-admin-commands` › `a membership change gives the actor no right` (обидва порти): `[учасник собі → update X → markDeletion]` → `command.constraint` `unique` `[org, user]`, оператора по `X` не надіслано; рядок учасника іншої організації без призначення з `assignee` і виміром на нього → `read` порожній, `update` → `no-right`, контроль — ті самі ролі пишуть свої рядки в `home`. Коду T3 не змінено; тест `refuses a second member of a batch when the membership onWrite assigns a role` — без змін | гілку обрано за фактом функцій прав і DB-кейсів | П4 §6.15 — уточнення вектору: бар'єр закриває лише права, які судить ⊆ (призначення й ролі); членство їх не дає |
| Р-A4-18 | **Власник тенанта — `tenantFullAccess`** (погоджено Р7). Умова — у скоупі немає дієвого носія `fullAccess` (інакше `holder-exists`). Користувач має рядок членства в скоупі → роль призначається цьому учаснику (`member` тоді → `invalid-member`), інакше вставляється рядок членства з `member`. Після запису — перевірка `not-effective` | тенант, чий єдиний носій став `invalid` поза командою, інакше нічим не відновити: глобальна роль довідників скоупу не адмініструє (спека прав §4.6) | П4 §6.12; спека прав §7 — «відновлення — інструмент обслуговування глобального рівня й рівня скоупу» |
| Р-A4-19 | **Замок — той самий advisory-ключ, що в `apply`** (`ADVISORY_LOCK`, `packages/simetra/src/schema/apply/execute.ts` → експортована `APPLY_ADVISORY_LOCK`), `pg_try_advisory_xact_lock`; зайнято → `maintenance.busy`, нічого не записано. Команди рантайму замка не беруть, і це безпечно: стан, який перевіряє інструмент, команда змінити не може. Носія `fullAccess` рівня командою створює лише носій `fullAccess` того самого рівня (інакше `escalation`), а за умовою `restore`/`tenantFullAccess` дієвого носія немає; перше глобальне призначення командою потребує глобального `administerRights`, тобто вже наявного глобального призначення. Залишок — носій, що став дієвим без команди (провізія), дає двох носіїв, а не обхід | інструмент упорядковано і з `apply` (звірка хешу без TOCTOU), і з іншим запуском | немає |
| Р-A4-20 | **Користувач і результат.** Рядка «Користувачів» немає → `maintenance.unknown-user`; `invalid` → `maintenance.not-effective` — обидва до запису (без «Користувачів» у проєкті перевірка пропускається; лишається пост-перевірка). `ApplyConnectionLost` **після** повернення `fn` (прапорець у ядрі) → `maintenance.outcome-unknown` (підказка: запустіть ще раз — побачите стан); раніше — вгору. Інша помилка бази — вгору, `withDatabase` дає `database.failed` | FK `23503` і невідомий результат інакше дали б невиразну відмову | немає |

## Review Focus

1. **Пакет очистки з `rightsOrphans` (плюс рядки дельти, що лишаються, — їх клієнт читає сам до П4-B), коли роль-сирота має живе призначення й дельти** — проходить; повторний план — порожній перелік (Задача 8, сценарій сиріт).
2. **`member` з ключем механіки, реквізитом поза `insert`, невідомим ключем чи `undefined`** — `maintenance.invalid-member` з `path`, порт бази не викликано (Задача 7, крок 1).
3. **Хук `onWrite` призначення читає дані застосунку через `ctx.read`** — `rights-context`, нічого не закомічено (Задачі 6 і 8).
4. **Інструмент під час `apply` чи другого запуску** — `maintenance.busy`, нічого не записано (Задача 9, сценарій `first global`).
5. **Перелік сиріт більший за `RIGHTS_SOURCE_LIMIT`** — текст обрізано, `rightsOrphans` повний (Задача 4).

---

### Задача 0: якорі й факти

**Files:** лише читання; звіт — під цією задачею в плані.

- [x] **Крок 1:** `orient --plan` цього файлу; розбіжності — архітекторці.
- [x] **Крок 2:** записати фактом:
  - склад `policyDomain(adminRoles(), commandCoreLayer())` (`fixtures/rights.ts`):
    довідники `OrgRoles`, `OrgRoleAssignments`, `GlobalRoles`,
    `GlobalRoleAssignments`, «Користувачі», `OrgMember`, `Ticket` з ядром;
    ролі: з `fullAccess` (`ORG_ADMIN_ID`?, `GLOBAL_ADMIN_ID`), `RightsAdmin`
    (адміністрування й `read` `Task`), `TICKET_WRITER_ID` (`read`/`update`
    `Ticket`); архетип для кастомної ролі ⊆ прав `RightsAdmin` (`TaskViewer`?);
    чи `OrgMember` має ядро (є в `buildRuntimeCatalog`) і чи `RightsAdmin` має
    `read` на `OrgMember` (перевірка `subject`);
  - чи `RoleContract` має `assignable`; ім'я виду скоупу в
    `CompiledScopeKind.name`; таблиця кореня, зокрема зовнішній корінь;
  - `insertOrphan` (`packages/simetra/test/db/rights-seed.ts`) і що з нього й
    з ідентифікаторів ролей реекспортує `packages/simetra/test/support.ts`;
  - як `apply-lifecycle.db.test.ts` розгортає модель інструментами `plan` і
    `apply` (`databaseResource`, `invoke`) — зразок справжнього marker;
  - `session_user` при вході `postgres` через локальний Supavisor (форма
    `postgres.<tenant>`, як `throughPoolerAs`);
  - чи тегована роль `LOGIN SUPERUSER`, створена під `testSuperuserUrl()`,
    входить паролем прямим портом;
  - чи `withCopy` (`packages/designer/src/__tests__/support/db.ts`) копіює
    ціль `inTarget` і які з'єднання закрити перед `CREATE DATABASE … TEMPLATE`;
  - де в T3 стан спроби транзакції (поле для ознаки Р-A4-17) і де
    `runPhase` / `runNested` / `ctx.read` беруть ціль каталогу.
- [x] **Крок 3:** якщо `postgres` через пулер дає інший `session_user` чи
  тегований суперкористувач не входить — архітекторці до Задачі 9.

#### Звіт Задачі 0

Дерево: `feat/p4-a4` на `917e41e4`. Код не змінено; тимчасові проби (три
файли `zz-probe0*`) видалено, `git status` чистий. DB-проби йшли лише крізь
`pnpm --filter … test:db` (сторож стека, тег прогону), ролі й тіні — із тегом
і прибрані самим прогоном; сторож стека не побачив різниці. Крок 3 не
спрацював: `needsArchitect` не потрібен.

**Крок 1. `orient --plan`:** ✓ 54, ✗ 9. Усі 9 `MISSING` — файли, які план
створює (`values.ts`, `values.test.ts` у `model/runtime`, `rights-maintenance.ts`
і його тест у `schema/apply`, `rights-maintenance-tool.ts`, його тест,
`apply-database.test.ts`, `rights-admin-commands.db.test.ts`,
`rights-maintenance.db.test.ts`). Серед символів `APPLY_ADVISORY_LOCK` і
`RightsOrphans` ще не існують — так і заплановано (`ADVISORY_LOCK` лежить у
`schema/apply/execute.ts` приватною сталою `"1397312837, 1"`, береться
`pg_try_advisory_xact_lock`). Розбіжностей якорів, що міняють обсяг, немає;
дрібні уточнення — у «Нотатках» нижче.

**Крок 2. Факти.**

- **Склад `policyDomain(adminRoles(), commandCoreLayer())`** (проба
  `buildRuntimeCatalog` + `compile`, діагностик 0). Об'єкти ядра рантайму:
  `GlobalRoleAssignments`, `GlobalRoles`, `OrgMember`, `OrgRoleAssignments`,
  `OrgRoles`, `Organization`, `Project`, `Region`, `TaskComment`, `Ticket`,
  `Users`. `Task` — документ, ядра не має. Контексти операцій: системні
  довідники прав (`Org*`, `Global*`) — `administerRights` на кожній операції
  (`create`, `update`, `markDeletion`; призначення ще й `delete`); решта —
  `create`/`update`/`markDeletion` за іменем операції; `Users` — лише `update`,
  `Organization` — `update`, `markDeletion`.
  Ролі: `OrgAdmin` (`ORG_ADMIN_ID`, рівень `org`, `fullAccess`) — у
  `rolesAndSets()`; `GlobalAdmin` (`GLOBAL_ADMIN_ID`, `global`, `fullAccess`) —
  в `adminRoles()`; `RightsAdmin` (`RIGHTS_ADMIN_ID`, `org`): `read` +
  `administerRights` на `OrgRoles` і `OrgRoleAssignments`, `read` `Task`;
  **`read` на `OrgMember` у нього немає** (див. «Нотатки» п. 3);
  `TicketWriter` (`TICKET_WRITER_ID`, `org`): `read`, `create`, `update`,
  `markDeletion` на `Ticket`, обсяг `any`. Архетип для кастомної ролі ⊆ прав
  `RightsAdmin`: `TaskViewer` (`TASK_VIEWER_ID`, `read` `Task` `any`) — його ж
  беруть наявні тести (`catalog-command-admin.db.test.ts`). Також у шарі:
  `TaskEditor`, `ProjectReader`, `MemberEditor` (`read`, `update` на `OrgMember`).
  `OrgMember` **має ядро**: `create`/`update`/`markDeletion`, колонка скоупу
  `org_id`; реквізити зі статусом «вставляє команда»: `org` (скоуп, обов'язковий),
  `code`, `description`, `user` (`Ref`, не обов'язковий) — для `encodeMemberValues`
  із `forced` = (ключ, скоуп, користувач) лишаються `code` і `description`.
  Колонки `OrgRoleAssignments`: `org`, `subject` (UUID, обов'язковий),
  `archetype`, `customRole`, `container`, `code`, `description`; `OrgRoles`:
  `org`, `archetype` (обов'язковий), `order`, `code`, `description`.
- **`RoleContract.assignable` є** (`packages/simetra/src/compiler/rights/contracts.ts`,
  `assignable: role.assignable`; схема `packages/simetra/src/model/schemas/rights.ts`
  — `z.boolean().default(true)`). Ролі лежать у `model.contracts.roles`
  (`RoleContract[]`), каталоги прав рівня — `model.contracts.rightsCatalogs`
  (`level`, `roles.{table,delta}`, `assignments.table`), членство —
  `model.contracts.membership`.
- **Вид скоупу:** `CompiledScopeKind.name` (`packages/simetra/src/compiler/compile.ts`):
  у фікстурі `org`, `physicalName` `org_id`, `setFunction` `public.org_member_member_scopes`.
  **Корінь:** `root: { objectId } | { external: { schema, table, column } }`.
  У фікстурі — `{ objectId }` довідника `Organization` (таблиця `organization`,
  ключ `id`); таблицю для `objectId` дає `mainTableOf(model.physical, objectId)`
  (експортовано з `simetra/compiler`), для зовнішнього кореня — прямо
  `schema.table.column`.
- **`insertOrphan`** — `packages/simetra/test/db/rights-seed.ts`:
  `insertOrphan(client, table, values)` вимикає `ALTER TABLE … DISABLE TRIGGER USER`
  навколо вставки (потрібен власник таблиці). `packages/simetra/test/support.ts`
  його **не реекспортує** (реекспорти — лише `./db/auth` `signUp`, `./db/connection`,
  `./db/fingerprint`, `./db/catalog`). З ідентифікаторів ролей `support.ts` дає
  лише `ORG_ADMIN_ID`, `TICKET_WRITER_ID`, `TICKET_TARGETS_READER_ID`,
  `GAUGE_WRITER_ID`; **немає** `RIGHTS_ADMIN_ID`, `TASK_VIEWER_ID`, `TASK_EDITOR_ID`,
  `GLOBAL_ADMIN_ID`, `TASK_WRITER_ID`, `MEMBER_EDITOR_ID`, а також `role`, `grant`,
  `objects`, `ROLE_FILE`, `compileRights`. Також `rights-seed.insert()` для
  таблиць прав потребує попереднього `deploy(client, model)` на тому самому
  клієнті (інакше кидає) — на цілі, розгорнутій інструментами, `deploy` не
  викликався, тож Задача 8 бере свій `seedUnderMaintenance`, а не `insert`.
- **Розгортання моделі справжнім `plan`+`apply`:** зразок
  `packages/designer/src/__tests__/apply-lifecycle.db.test.ts`:
  `inTarget("select 1;", scope, url => …)` → тека метаданих (`mkdtemp`, у
  `node_modules` симлінк на `packages/simetra`, файли з `acceptDebt(...)`) →
  `databaseResource({ SIMETRA_DATABASE_URL: url }, { url: "SIMETRA_DATABASE_URL" })`
  → `invoke(toolByName("plan"), {}, opts)` → `PlanData { file, planHash,
  requiredPermissions, … }` → `invoke(toolByName("apply"), { plan: file, planHash,
  allow: requiredPermissions }, opts)`; `opts` = `{ dir, readOnly: false,
  allowDatabaseWrite: true, dryRun: false, confirmed: true, channel: "cli",
  database }`. **Проба на справжній моделі `policyDomain(adminRoles(),
  commandCoreLayer())`:** `compile` — 0 діагностик; `plan` 10,4 с (попередження
  `apply.first-apply`, `plan.foreign-exclusive-lock`, `plan.numbering-not-generated`
  ×14, `plan.schema-only-proof`; `requiredPermissions` порожній; 1261 крок);
  `apply` `committed`, 2,3 с, `attempts: 1`; `simetra.marker.snapshot_hash` =
  `model.hash`, `simetra.applied_snapshot_hash()` = `model.hash`, у `public` 25
  таблиць; повторний `plan` — `ok`, `data` не задано (`unchanged` без даних, як
  описує Задача 4). Модель з `defaultSchema` типовим `public` і `scope =
  { schemas: ["public"], provider: "supabase" }` для `inTarget` працює; весь файл
  з однією пробою — 25 с стінного часу. Отже «справжній marker» Задачі 8
  здійсненний без `seedMarker`.
- **`session_user` через пулер** (проба на локальному стеку): `SIMETRA_TEST_POOLER_URL`
  за замовчуванням — користувач `postgres.pooler-dev`; запит через нього повертає
  `session_user = current_user = postgres`, `application_name = Supavisor`,
  `is_superuser = off`, `rolcreaterole`, `rolbypassrls` як у прямого входу.
  Тобто режим обслуговування (`session_user = current_user`, не з
  `PROVIDER_LOGIN_ROLES`) пулер не ламає; форма `postgres.<tenant>` — лише в
  рядку підключення, не в `session_user`. Прямий вхід: `session_user = postgres`,
  `application_name = simetra_db_<тег>`.
- **Тегована `LOGIN SUPERUSER`:** `CREATE ROLE "simetra_<мітка>_<тег>" LOGIN
  SUPERUSER PASSWORD '…'`, створена під `testSuperuserUrl()` (`supabase_admin`),
  входить паролем **і прямим портом, і через `throughPoolerAs`**
  (`session_user = current_user = <тегована роль>`, `is_superuser = on`).
  Ім'я не з `PROVIDER_LOGIN_ROLES`. Прибиралася через `dropRoles` після
  `pg_terminate_backend` її бекендів (як `withRuntimeLogin`); у проби не лишилось
  слідів. Висновок для Задачі 9: умову `session_user = current_user`
  `maintenanceSql` (`packages/simetra/src/compiler/rights/guard-units.ts`) перевіряють
  `SECURITY DEFINER`-тригери; тегований суперкористувач має
  `session_user` ≠ власник функцій (`postgres`) — це і є механізм відмови
  (на цьому кроці не доводилось: його доведе саме тест Задачі 9).
- **`withCopy`** (`packages/designer/src/__tests__/support/db.ts`):
  `withCopy(clause, fn)` робить `CREATE DATABASE "<simetra_copy_<тег>_…>" OWNER
  postgres <clause>` під суперкористувачем і `DROP DATABASE … WITH (FORCE)` у
  `finally`; `fn(url, name)` бере URL копії для типової тестової ролі. Копію цілі
  `inTarget` робить пункт `template "<ім'я бази цілі>"` (зразки:
  `templateOf(url)` у `promotion-commit.db.test.ts`,
  `` `template ${nameOf(url)}` `` в `execute-plan.db.test.ts`). `TEMPLATE` вимагає,
  щоб до цілі не було відкритих з'єднань: інструменти `plan`/`apply` і
  `query()` закривають пул/клієнта по виклику, але **тримані тестом `pg.Client`
  (власник засіву, суперкористувач-спостерігач), `pg.Pool` ролі входу й
  `withRuntimeLogin`-ролі треба закрити (`end()`) до `withCopy`**.
- **Стан спроби в T3 і ціль каталогу:** клас `Transaction`
  (`packages/simetra/src/server/transaction.ts`) — поля `terminal`, `changes`,
  `afterCommit`, `user`, `act`; новий екземпляр на кожну спробу в `attempt(...)`
  (`new Transaction(client, state)`), тож ознака бар'єру як поле `Transaction`
  чиста на повторі. `runPhase(tx, op)`
  (`packages/simetra/src/server/phase.ts`): `targetOf(catalog, op)` дає
  `{ object, target }`, `target.context` — дія контексту фази; **точка постановки
  виклику ядра** — `tx.enqueue([{ CONTEXT_TEXT… }, call], { kind: "write", … })`
  одним блоком після хука `beforeWrite`; хук `onWrite` — після. Старт фази — на
  початку `runPhase` (до `beforeWrite`) — місце для ознаки. `runNested`
  (там само) валідує вхід (`prepareInput`) і викликає `runPhase`. Хуки:
  `callHook`/`contextOf` у `packages/simetra/src/server/hook-context.ts`:
  `ctx.run` → `track → phase.runNested(operation)` → `runPhase`; `ctx.read` →
  `track → prepareRead(catalog, query)` (дає `object: RuntimeObject` цілі) →
  `tx.enqueue([statement], { kind: "read", object })` — це **точка перевірки
  ознаки для читань**. Черга — `Transaction.enqueue` (FIFO, `this.tail`).

**Нотатки (уточнення якорів, обсяг не міняють).**

1. `administerRightsAction` **не реекспортується** з `simetra/model`:
   `packages/simetra/src/model/kinds/registry.ts` дає `STANDARD_ACTIONS` та
   інше з `./actions`, але не сам об'єкт. Задача 6 додає реекспорт
   (план це й передбачає: «якщо його немає»); T3 порівнює
   `target.context === administerRightsAction.name`. Вплив на спеку: немає.
2. Задача 6 крок 3 називає `Project` об'єктом застосунку «з роллю запису з
   `writeRoles()`». У моделі `catalog-command-admin.db.test.ts`
   (`policyDomain(writeRoles(), adminRoles(), rightsAdmins(), nickname())`)
   `Project` має ядро (проба: `create`/`update`/`markDeletion`), **але жодна роль
   не дає запису на `Project`** (`PROJECT_WRITER_ID` — контейнерна роль, що
   пише `Task`). Придатний об'єкт — `Bulletin` (`BULLETIN_FILE`, реквізит `text`,
   має ядро `create`/`update`/`markDeletion`): `TaskWriter`
   (`TASK_WRITER_ID`, рівень `org`) дає на ньому `read`, `create`, `update`
   `any`. Рядків `Bulletin` засів (`seedAdministration`) не створює: DB-кейс
   вставляє його сам (`insert(client, "bulletin", { id, org_id, text })`).
   Вплив на спеку: немає.
3. Задачі 8–9 і `RightsAdmin` з `adminRoles()`: призначення адресує учасника
   лише за явного `read` на довіднику членства, інакше `command.invalid`
   `subject` (доведено `catalog-command-admin.db.test.ts` › `rights admin without
   read on membership → command.invalid subject`; там `RightsAdmin` отримує
   `read` на `OrgMember` локальним шаром `rightsAdmins()`, неекспортованим).
   Задача 8 має дати актору `admin` `read` на `OrgMember` — або локальним шаром
   у своєму тесті, або експортованим шаром у `fixtures/rights.ts`. Окремої ролі
   «лише адміністрування» для сценарію передачі `fullAccess` у фікстурах немає
   готової в `adminRoles()`; є `RIGHTS_ONLY_ADMIN_ID` (`analysisRoles()`, `org`,
   `read`+`administerRights` на `OrgRoles`/`OrgRoleAssignments`, без `read` на
   `OrgMember`) — теж потребує `read` на членстві для адресації учасника.
   Вплив на спеку: немає.
4. `support.ts` не віддає нічого з `rights-seed` і більшість id ролей (див.
   вище) — Задача 8 «Modify `packages/simetra/test/support.ts`» має додати
   `insertOrphan`, `RIGHTS_ADMIN_ID`, `TASK_VIEWER_ID`, `GLOBAL_ADMIN_ID`,
   `TASK_WRITER_ID` (за потреби `TASK_EDITOR_ID`, `MEMBER_EDITOR_ID`, `role`,
   `grant`, `objects`, `ROLE_FILE`) — реекспорт, без логіки.
5. `encodeParam` (читання `where`) лишається в T3 `values.ts` і імпортує
   `encodeItemValue`/`encodePair` з `simetra/model`; `read.ts` і `decode.ts`
   переводяться на імпорт (план їх уже називає). Вплив на спеку: немає.
6. У `hooks.test.ts` об'єкт `RIGHTS` (`rightsRole` з `fixtures.ts`) уже є
   «другим об'єктом»; `read-runtime.test.ts` читає його публічним `runtime.read`
   (поза командою) — бар'єр Р-A4-17 його не торкається. Які саме тести
   `hooks.test.ts`/`transaction.test.ts` почервоніють після Задачі 6 (фаза
   `RIGHTS` перед фазою чи `ctx.read` застосунку) — не перевірялося: це
   визначить червоний прогін Задачі 6; план переводить їх на об'єкт застосунку
   (`client`).

### Задача 1: T3 — відмова на `COMMIT` і самопризначення

**Files:**
- Modify: `packages/simetra/src/server/__tests__/transaction.test.ts`

**Interfaces:** споживає `createCommandRuntime`, порт-фейк файлу. Нічого не виробляє.

- [x] **Крок 1:** тест `maps a guard refusal answered at COMMIT` — один кейс: фейк відповідає успіхом на фази й `42501` `MESSAGE 'command.forbidden'` `DETAIL 'escalation'` на `COMMIT` → `command.forbidden` `reason: "escalation"` без `object`; послідовність завершується `COMMIT`; `release()` рівно раз. (Повний перелік причин тримає `errors.test.ts` › `command.forbidden keeps the allowed reason`.)
- [x] **Крок 2:** тест `does not refuse a self-assignment on its own` — каталог з довідником призначень (`context: "administerRights"`), `create` призначення з `subject` = учасник користувача сесії; фейк відповідає успіхом → результат з рядком; виклик ядра й `COMMIT` надіслано.
- [x] **Крок 3:** обидва зелені на поточному коді; мутації М1, М2 їх червонять.
- [x] **Крок 4:** коміт `test(server): відмова запобіжника на COMMIT і самопризначення без власних перевірок T3`.

### Задача 2: кодування значень у T0 і `encodeMemberValues`

**Files:**
- Create: `packages/simetra/src/model/runtime/values.ts`, `packages/simetra/src/model/runtime/__tests__/values.test.ts`
- Modify: `packages/simetra/src/model/runtime/index.ts`, `packages/simetra/src/server/values.ts`, `packages/simetra/src/server/__tests__/values.test.ts`
- Modify (імпорт перенесеного — з `simetra/model`): `packages/simetra/src/server/decode.ts`, `packages/simetra/src/server/phase.ts`, `packages/simetra/src/server/read.ts`

**Interfaces:**
- Produces: `encodeItemValue(attribute: RuntimeAttribute, value: unknown, path: string): Encoded<unknown>`, `encodePair`, `isPlainObject`, `INTEGER_TEXT`, `type Encoded<T> = { value: T } | { error: CommandError }` — із `simetra/model`.
- Produces: `encodeMemberValues(object: RuntimeObject, values: unknown, forced: readonly string[]): { columns: Record<string, unknown> } | { error: CommandError }` — `values` — простий об'єкт; кожен ключ — реквізит з `insert: true`, не з `forced` (логічні імена); значення — `encodeItemValue` (пара — обидві колонки); результат — фізичні колонки → JSON-значення. Порядок помилок — як `encodeItem` (Р-A3-8). `path` — логічне ім'я реквізиту.

- [x] **Крок 1:** перенести функції; тести T3 переводять імпорт на `simetra/model` і лишаються зеленими без зміни очікувань.
- [x] **Крок 2:** T0-тест на вручну зібраному `RuntimeObject`: `encodeMemberValues rejects forced, non-insert, unknown and undefined keys` (`it.each`: ключ із `forced`, `insert: false`, невідомий, `undefined`, не-об'єкт → `command.invalid` з `path`) і `encodes values and pairs by physical column`.
- [x] **Крок 3:** у `server/__tests__/values.test.ts` — `encodeMemberValues matches encodeItem for create`: ті самі колонки й значення для `Numeric`, пари й `null`.
- [x] **Крок 4:** реалізувати; `pnpm --filter simetra test values`, `typecheck`, `lint`.
- [x] **Крок 5:** коміт `refactor(model): кодування значень каталогу рантайму в T0 і encodeMemberValues`.

### Задача 3: діагностики `maintenance.*` і `ApplyDbError`

**Files:**
- Modify: `packages/simetra/src/compiler/diagnostics.ts` (`RULE_CODES`), `packages/simetra/src/compiler/messages.ts`, `packages/simetra/src/compiler/__tests__/messages.test.ts`
- Modify: `packages/simetra/src/schema/apply/port.ts` (`ApplyDbError`)
- Modify: `packages/designer/src/schema-engine/apply-database.ts` (`normalize` — заповнення й експорт)
- Create: `packages/designer/src/schema-engine/__tests__/apply-database.test.ts` (unit без бази, на об'єкті помилки `pg`)

**Interfaces:**
- Produces: коди (усі `error`): `maintenance.model-mismatch { applied, compiled }`, `maintenance.unknown-role { role }`, `maintenance.role-level { role, expected }`, `maintenance.role-ambiguous { roles }`, `maintenance.unknown-scope-kind { scopeKind }`, `maintenance.no-catalog { level }`, `maintenance.scope-missing { scope }`, `maintenance.unknown-user { user }`, `maintenance.busy {}`, `maintenance.not-first {}`, `maintenance.holder-exists { level }`, `maintenance.not-effective { user }`, `maintenance.invalid-member { path }`, `maintenance.member-required { attribute }`, `maintenance.refused { reason }`, `maintenance.outcome-unknown {}`.
- Produces: `new ApplyDbError(message, sqlstate, extra?: { detail?: string; column?: string; constraint?: string; table?: string })` з однойменними `readonly` полями.

- [x] **Крок 1:** `messages.test.ts` червоніє від кодів без текстів; додати тексти en/uk і підказки (`refused` — увійти роллю, що застосувала план, спека П4 §6.2; `outcome-unknown` — запустити ще раз).
- [x] **Крок 2:** тест `normalize keeps detail, column, constraint and table` → реалізувати.
- [x] **Крок 3:** `pnpm --filter simetra test messages`, `pnpm --filter @simetrajs/designer test apply-database`, `typecheck`, `lint`.
- [x] **Крок 4:** коміт `feat(schema): діагностики режиму обслуговування прав і поля помилки бази`.

### Задача 4: повний перелік сиріт у плані

**Files:**
- Modify: `packages/simetra/src/schema/apply/rights-sources.ts` (`RightsOrphans`; `RightsSourceFacts.orphans: RightsOrphans`; `collectRightsFacts`; `catalogSql` читає й версію; `appliedRightsSchema` + `objectId`; `rightsSourceInput` отримує `objectRef: (objectId: string) => MetadataRef | undefined` з `model.objects`)
- Modify: `packages/simetra/src/schema/apply/plan.ts` (`PlanOutcome.rightsOrphans`, і через `planPromotion`), `packages/simetra/src/schema/apply/index.ts`
- Modify: `packages/designer/src/tools/apply-tools.ts` (`PlanData.rightsOrphans`, `UnchangedPlanData`), `packages/designer/src/io/report.ts` (`renderPlan`: `unchanged` — «nothing to apply»), `packages/designer/src/mcp/tools.ts`, `packages/designer/src/cli/render.ts`
- Modify (тести з літералами чи очікуванням «`unchanged` без даних»): `packages/simetra/src/schema/apply/__tests__/rights-sources.test.ts`, `packages/simetra/test/db/rights-sources.db.test.ts`, `packages/designer/src/__tests__/cli.test.ts`, `packages/designer/src/__tests__/apply-lifecycle.db.test.ts` (`expectUnchanged`), `packages/designer/src/__tests__/apply-tools.db.test.ts`, `packages/designer/src/__tests__/promotion-commit.db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RightsOrphans {
    roles: { object: MetadataRef; id: string; version: number; scope?: string }[]
    assignments: { object: MetadataRef; id: string; version: number; scope?: string; role?: string }[]
    deltas: { object: MetadataRef; role: string; id: string; version: number; scope?: string }[]
  }
  export interface UnchangedPlanData { unchanged: true; rightsOrphans: RightsOrphans }
  ```
  `object` — з об'єкта **бажаної** моделі за `objectId`; довідника немає в бажаній моделі → його рядки не потрапляють у `rightsOrphans`, лише в текст попередження: план видаляє таблицю такого довідника разом з рядками, тож очищати командами нічого (команд над ним уже немає). Сорти — Р-A4-3; кожен перелік відсортовано за `id`, без дублів. `PlanOutcome.rightsOrphans?` відсутній лише в ранніх відмовах до читання фактів. Параметри й текст `plan.rights-orphans` не змінюються (`customRoles` — id ролей і дельт, `assignments`, `more` — з `RightsOrphans` з лімітом).

- [x] **Крок 1:** переписати `finds invalid custom roles, deltas and direct assignments by row ID` під `RightsOrphans`: роль-сирота з дельтою й живим призначенням, дельта живої ролі поза доменом, пряме призначення зниклого архетипу, позначена роль → рівно очікувані переліки з версіями (дельта ролі-сироти — не в `deltas`; її призначення — у `assignments` з `role`).
- [x] **Крок 2:** переписати `warns once for capped orphan row IDs` → `rightsOrphans stays complete past the warning limit`: `RIGHTS_SOURCE_LIMIT + 5` сиріт → повний перелік; параметри попередження — перші `RIGHTS_SOURCE_LIMIT`, `more = 5`.
- [x] **Крок 3:** тест `renders an unchanged plan with orphans` (`report.ts`/`cli.test.ts`): `UnchangedPlanData` → текст «nothing to apply», JSON-вивід несе `unchanged` і `rightsOrphans`.
- [x] **Крок 4:** реалізувати; оновити літерали й очікування трьох DB-тестів `unchanged` (вони перевіряються scoped-прогоном у Задачі 8); `pnpm --filter simetra test rights-sources`, `pnpm --filter @simetrajs/designer test cli report mcp`, `typecheck`, `lint`.
- [x] **Крок 5:** коміт `feat(schema): повний структурований перелік сиріт прав у результаті плану`.

### Задача 5: `Tool.cliOnly` і відмова `cli-only`

**Files:**
- Modify: `packages/designer/src/tools/types.ts`, `packages/designer/src/tools/invoke.ts`, `packages/designer/src/mcp/tools.ts` (`registerCatalog`, `mcpInputSchema`)
- Test: `packages/designer/src/__tests__/catalog.test.ts` › `describe("invoke refusals")`

**Interfaces:** `Tool.cliOnly?: true`; `RefusalReason` + `"cli-only"`.

- [x] **Крок 1:** тест `refuses a cli-only tool outside the cli channel before parsing input` — тестовий інструмент `cliOnly` з невалідним входом на каналі `mcp` → `cli-only`, `run` не викликано; на `cli` — звичайний шлях.
- [x] **Крок 2:** реалізувати (`o.channel !== "cli"`); `registerCatalog` пропускає `cliOnly`; `mcpInputSchema` повертає `tool.input` для `cliOnly`.
- [x] **Крок 3:** `pnpm --filter @simetrajs/designer test catalog mcp`, `typecheck`, `lint`.
- [x] **Крок 4:** коміт `feat(designer): інструменти лише для командного рядка`.

### Задача 6: тимчасовий бар'єр T3 (Р-A4-17)

**Files:**
- Modify: `packages/simetra/src/server/transaction.ts`, `packages/simetra/src/server/phase.ts`, `packages/simetra/src/server/hook-context.ts` (точні місця — з Задачі 0)
- Modify: `packages/simetra/src/model/kinds/registry.ts` (реекспорт `administerRightsAction`, якщо його немає в `simetra/model`)
- Modify: `packages/simetra/src/server/__tests__/fixtures.ts` (об'єкт застосунку `Ticket` і довідник призначень з `delete`), `packages/simetra/src/server/__tests__/hooks.test.ts` (наявні тести, де «другий об'єкт» — довідник прав, переводяться на об'єкт застосунку, без зміни того, що вони доводять)
- Test: `packages/simetra/src/server/__tests__/transaction.test.ts`, `hooks.test.ts`
- Test (DB, фіксація поточної бази): `packages/simetra/test/db/catalog-command-admin.db.test.ts`

**Interfaces:**
- Consumes: `administerRightsAction` з `simetra/model` — назва дії; `operations.<операція>.context` каталогу.
- Produces: ознака «фаза прав почалася» в стані спроби транзакції; відмова `{ code: "command.forbidden", reason: "rights-context" }` — значення вже є в `COMMAND_CORE_ERRORS.forbidden`.

- [x] **Крок 1:** unit (порт-фейк, точна послідовність):
  - `refuses a non-rights phase after a rights phase in a batch` — `[create призначення, update Ticket]` → друга фаза не надсилає жодного оператора бази, результат `command.forbidden` `rights-context`, `ROLLBACK`, `release()` раз;
  - `refuses ctx.read and ctx.run of application data from a hook of a rights phase` — `it.each` (`beforeWrite`, `onWrite`) × (`ctx.read` `Ticket`, `ctx.run` `update Ticket`) → `rights-context`, оператора читання чи ядра `Ticket` не надіслано;
  - `allows rights phases after a rights phase` — `[create призначення, create призначення, delete призначення]` → усі три виклики ядра й `COMMIT`;
  - `allows application phases before the first rights phase` — `[update Ticket, create призначення]` → обидва виклики й `COMMIT`;
  - `starts a retry without the mark` — `40001` на `COMMIT` пакета `[update Ticket, create призначення]` → повтор проходить;
  - `refuses the core call of an application phase whose beforeWrite ran a rights phase` — `beforeWrite` фази `update Ticket` робить `ctx.run(create призначення)` → виклик ядра `Ticket` не надіслано, `rights-context`;
  - `refuses a concurrent ctx.run queued after a rights phase` — хук запускає без очікування `ctx.run(create призначення)` і `ctx.run(update Ticket)` → ядро `Ticket` не надіслано;
  - `allows rights data from a hook of a rights phase` — `it.each`: `ctx.read` довідника призначень і `ctx.run` фази прав з `onWrite` фази прав → проходять;
  - `refuses a second member of a batch when the membership onWrite assigns a role` — `onWrite` довідника членства робить `ctx.run(create призначення)`; пакет `[create учасника A, create учасника B]` → друга фаза `rights-context` (фіксує компроміс Р-A4-17).
- [x] **Крок 2:** реалізувати.
- [x] **Крок 3:** DB-кейс фіксації бази в `catalog-command-admin.db.test.ts` (об'єкт — довідник застосунку моделі цього файлу з роллю запису з `writeRoles()`, напр. `Project`; Задача 0 підтверджує): `the database still lets a direct command use rights granted in its transaction (closed by Права-3)` — один багатокроковий помічник в **одній** точці збереження: claims адміністратора; контекст `administerRights` → `save` призначення собі ролі запису → контекст `update` → `save` рядка → контекст `administerRights` → `delete` призначення → `RESET ROLE` → `SET CONSTRAINTS ALL IMMEDIATE` → проходить, рядок змінено. Коментар: «стане червоним після Права-3 — тоді очікування міняється на `rights-context`».
  - Відхилення при виконанні: об'єкт кейсу — `Bulletin` (`BULLETIN_TABLE`) з роллю `TaskWriter` (`TASK_WRITER_ID`), а не `Project`: у моделі файлу жодна роль не пише `Project` (Звіт Задачі 0, нотатка 2). Рядок `Bulletin` вставляє сам кейс; контрольний крок без призначення дає `command.forbidden` `no-right`. Вплив на спеку: немає.
- [x] **Крок 4:** `pnpm --filter simetra test transaction`, `pnpm --filter simetra test:db catalog-command-admin`, `typecheck`, `lint`.
- [x] **Крок 5:** коміт `fix(server): тимчасовий бар'єр — після фази прав команда не торкається даних застосунку`.

### Задача 7: ядро `runRightsMaintenance` (T2) і інструмент `rights-maintenance`

**Files:**
- Create: `packages/simetra/src/schema/apply/rights-maintenance.ts`, `packages/simetra/src/schema/apply/__tests__/rights-maintenance.test.ts`
- Modify: `packages/simetra/src/compiler/rights/guard-units.ts` (`holderRows` → експортований `fullAccessHolderRows(catalog, contracts, physical, style)`, запобіжник використовує його без зміни SQL), `packages/simetra/src/compiler/index.ts`
- Modify: `packages/simetra/src/schema/apply/execute.ts` (`APPLY_ADVISORY_LOCK` в експорт), `packages/simetra/src/schema/apply/index.ts`
- Create: `packages/designer/src/tools/rights-maintenance-tool.ts`, `packages/designer/src/__tests__/rights-maintenance-tool.test.ts`
- Modify: `packages/designer/src/tools/types.ts` (`TOOL_NAMES`), `packages/designer/src/tools/catalog.ts` (`TOOLS`), `packages/designer/src/cli/render.ts`, `packages/designer/src/__tests__/catalog.test.ts` (`names every tool once`), `packages/designer/skills/simetra-metadata/SKILL.md` (маршрут `rights-maintenance` для тесту `every tool of the catalog is routed in the skill`)

**Interfaces:**
- Consumes: `encodeMemberValues` (Задача 2), коди й `ApplyDbError` (Задача 3), `effectiveHolderRows`, `buildRuntimeCatalog`, `standardColumn` з `simetra/compiler`; `RIGHTS_MAINTENANCE_SETTING`, `APPLIED_SNAPSHOT_HASH_FUNCTION_NAME`, `COMMAND_CORE_ERRORS` з `simetra/model`.
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
  export function fullAccessHolderRows(...): string // SELECT scope, actor
  export const APPLY_ADVISORY_LOCK: string
  ```

**Порядок** (одна `dbs.transaction(target, "commit", …)`):

1. До з'єднання: роль і вимоги Р-A4-9; вид скоупу, довідник призначень рівня, довідник членства виду (Р-A4-11); `member` — `encodeMemberValues` з `forced` = ключ, скоуп, користувач. Відмова — без звернення до порту.
2. `SELECT pg_try_advisory_xact_lock(<APPLY_ADVISORY_LOCK>)` → `false` — `maintenance.busy`.
3. `SELECT simetra.applied_snapshot_hash()` ≠ `model.hash` → `model-mismatch`.
4. `SELECT set_config('row_security', 'off', true)` — читання стану.
5. Користувач: рядка «Користувачів» немає → `unknown-user`; `invalid` → `not-effective`.
6. Стан: `firstGlobalAssignment` — живе глобальне призначення → `not-first`; `restoreGlobalFullAccess` — рядок `fullAccessHolderRows` глобального рівня → `holder-exists`; `tenantFullAccess` — кореня немає → `scope-missing`; рядок `fullAccessHolderRows` з цим `scope` → `holder-exists`; рядок членства користувача в скоупі → учасник наявний (`member` тоді → `invalid-member`).
7. `SELECT set_config($1, 'on', true)` з `RIGHTS_MAINTENANCE_SETTING`.
8. Новий учасник: ключ — `SELECT gen_random_uuid()`; `INSERT INTO <членство> (<колонки>) SELECT <колонки> FROM jsonb_populate_record(NULL::<членство>, $1::jsonb)` — колонки `member` плюс ключ, скоуп, користувач.
9. Ключ призначення — `gen_random_uuid()`; `INSERT INTO <призначення> (<ключ>, [<скоуп>,] <subject>, <archetype>) VALUES ($1, …)`; `subject` — користувач (глобальний рівень) чи учасник (скоуп).
10. Дієвість (`actor` — завжди **користувач**): `restoreGlobalFullAccess` — рядок `fullAccessHolderRows` з `actor = user`; `tenantFullAccess` — з цим `scope` і `actor = user`; `firstGlobalAssignment` — рядок `effectiveHolderRows` глобального рівня з `actor = user` і `archetype = role`. Немає → виняток → відкат → `not-effective`.
11. `COMMIT`. Мапінг помилок — Р-A4-5, Р-A4-11, Р-A4-20.

- [x] **Крок 1:** unit на порт-фейку `ApplyDatabase` (`rights-maintenance.test.ts`):
  - `it.each` відмов кроку 1 (невідома роль, роль не того рівня, без `fullAccess`, неоднозначна, жодної `fullAccess`, контейнерна, невідомий вид скоупу, прийняте джерело членства, довідник членства поза каталогом рантайму, `member` з примушеним ключем) — порт не викликано;
  - `model-mismatch`: інший хеш → відмова, `set_config` режиму не надіслано; `unknown-user`: порожня відповідь читання користувача → відмова, запису немає; `busy`: `false` замка → відмова;
  - властивості: замок — перший оператор; хеш — до першого читання стану; `row_security` — до читання стану; `set_config` режиму має третій аргумент `true` і стоїть до першого `INSERT`; кожен оператор — один без CTE з одним цільовим відношенням (`libpg-query`); рядок з лапкою в `member` є лише в параметрах;
  - `it.each(actions)`: порожня відповідь перевірки дієвості → `not-effective`, `COMMIT` не надіслано;
  - мапінг: `ApplyDbError('command.forbidden','42501',{detail:'rights-context'})` → `refused { reason: "rights-context" }`; `42501` з `message` не з білого списку і `DETAIL 'escalation'` → `reason: "denied"`; `23502` з колонкою членства → `member-required` з реквізитом; `ApplyConnectionLost` після `fn` → `outcome-unknown`, до — вгору; інша помилка — вгору.
  - Відхилення при виконанні: кейси «прийняте джерело членства» і «довідник членства поза каталогом рантайму» не стоять серед відмов «порт не викликано»: за Р-A4-11 `no-catalog` членства — лише на гілці вставки, тож вони — окремий `it.each` (`no-catalog only on the insert branch`): учасника немає → `no-catalog`, режим і `INSERT` не надіслано; учасник є → призначення проходить. Формат параметрів: `level` — `global` чи `scope:<ім'я виду скоупу>` (і в `holder-exists`, і в `no-catalog`); `role-level.expected` — `assignable on the global level`, `assignable on the global level with fullAccess`, `assignable on scope:<вид> with fullAccess`; без кандидата `restoreGlobalFullAccess` дає `role-level { role: "(none)" }`. Наявного учасника прийнятого джерела ядро читає з таблиці джерела з умовами `active`/`where`. Вплив на спеку: немає.
- [x] **Крок 2:** реалізувати `runRightsMaintenance` і `fullAccessHolderRows` (наявні unit-дерева запобіжника не змінюються).
- [x] **Крок 3:** інструмент: `readMetadataDir` → `compile`; помилки компіляції — відмова без з'єднання; `createApplyDatabase` — лінивим `import("../schema-engine")`, як `roles-tool.ts`; `withDatabase(required(database), "rights-maintenance", …)`; опис англійською (лише CLI, `--yes`, вхід мігратора, дії, відмови).
- [x] **Крок 4:** тести інструмента: `does not connect without confirmation` — `invoke(tool, input, { channel: "cli", confirmed: false, database: fake })`, `fake.connect` рахує виклики → `unconfirmed`, `connect` не викликано; `runTool` без `--yes` → код виходу 2; `is absent from MCP` — `tools/list` без `rights-maintenance`.
- [x] **Крок 5:** `pnpm --filter simetra test rights-maintenance guard-units`, `pnpm --filter @simetrajs/designer test rights-maintenance catalog skill-examples cli mcp`, `typecheck`, `lint` обох пакетів.
  - Відхилення при виконанні: шаблон `guard-units` не збігається з жодним файлом тестів; дерево запобіжника тримає `rights-guards.test.ts`, тож прогін — `pnpm --filter simetra test rights-guards rights-maintenance`. Вплив на спеку: немає.
- [x] **Крок 6:** коміт `feat(designer): інструмент обслуговування прав rights-maintenance`.

### Задача 8: DB-тести команд адміністрування прав

**Files:**
- Create: `packages/designer/src/__tests__/rights-admin-commands.db.test.ts`
- Modify: `packages/designer/src/__tests__/support/db.ts` — `committed` і засів актора під режимом обслуговування (`seedUnderMaintenance(owner, steps)`) винести з `command-runtime.db.test.ts` (той файл переходить на помічник); `recordingDatabase(inner: CommandDatabase)` — тексти операторів і на якому прийшла помилка
- Modify: `packages/simetra/test/support.ts` — реекспорт `insertOrphan` і ідентифікаторів ролей, якщо Задача 0 показала, що їх немає

**Причина рівня:** запобіжники судять на `COMMIT` у справжній транзакції з закоміченими даними; пулер; план читає дані цілі.

Розгортання — одне, **справжнім `plan` + `apply`** (зразок `apply-lifecycle.db.test.ts`) моделі `policyDomain(adminRoles(), commandCoreLayer())`: marker з канонічним знімком потрібен і рантайму, і плану. Назви ролей і об'єктів — з Задачі 0: `X` — рядок `Ticket`; `R` — роль `TICKET_WRITER_ID` (`read`/`update` `Ticket`); кастомна роль — на архетипі ⊆ прав `RightsAdmin`.

- [x] **Крок 1:** `describe.each([direct, pooler])`; у кожному — **свій `org` і свої актори** (`beforeAll` усередині): `admin` — учасник з `RightsAdmin`; `peer`, `third` — учасники без прав. Сценарії передачі й «останнього носія» — кожен у своєму `org` з власним `holder` (архетип `fullAccess` org плюс окрема роль лише з адмініструванням). Кейси:
  - `creates, updates and marks a custom role` — `create` ролі з дельтою → журнал `reason = 'command'`, `actor` = `admin`; `update` з поточною версією й новою дельтою → версія +1, дельта замінена; `update` зі старою версією → `command.conflict` `reason: "version"`, `currentVersion`;
  - `assigns two subjects in one batch, then unassigns` — пакет `[create призначення peer, create призначення third]` → проходить; `delete` з версією → проходить; `markDeletion` ролі після зняття всіх → проходить;
  - `refuses to mark a role in use` → `command.forbidden` `role-in-use`, роль не позначена;
  - `refuses self-assignment as escalation at COMMIT` — `admin` призначає собі `R` → `escalation`; `recordingDatabase`: помилка прийшла на `COMMIT` після виклику ядра;
  - `refuses a non-holder granting fullAccess` — `admin` призначає `peer` архетип `fullAccess` → `escalation`;
  - `transfers fullAccess in one batch, own assignment first` — `holder` пакетом `[delete свого fullAccess, create fullAccess для third]` → проходить (лише тому, що `last-full-access` судять на `COMMIT`, а адміністрування дає окрема роль); `third` — дієвий носій;
  - `refuses to drop the last fullAccess holder` — одне `delete` свого → `last-full-access`;
  - бар'єр Р-A4-17 (кожен червоний без бар'єру, М7): `assign → update X → unassign in one batch`; `assign → read X → unassign through a hook` (`onWrite` призначення кладе результат `ctx.read(X)` у змінну тесту — вона лишається порожньою); `assign → update X through ctx.run in a hook`; `assign → update a member row → unassign` (роль `R2` з `update` на `OrgMember`, рядок колеги) → кожен `command.forbidden` `rights-context`, `X` і рядок учасника незмінні, а `recordingDatabase` показує, що жодного оператора по `X` чи `OrgMember` не надіслано (відмовив T3, не база).
- [x] **Крок 2:** сценарій сиріт (прямий порт, свій `org` адміністратора): засів `insertOrphan`-способом — роль-сирота з дельтою й живим призначенням `peer`, жива роль з рядком дельти поза доменом і рядком у домені, пряме призначення зниклого архетипу → `runTool("plan", …, "--format", "json")` → `unchanged: true`, `rightsOrphans` рівно ці рядки → пакет `admin` з `markDeletion` ролі-сироти без зняття її призначення → `role-in-use`; повторний `plan` → той самий перелік → пакет **лише з `rightsOrphans`** (версії з переліку; рядки дельти для заміни тест читає власником) за порядком Р-A4-3 → проходить → повторний `plan` → переліки порожні.
  - Відхилення при виконанні: роль входу рантайму існує лише в блоках команд (`beforeAll`/`afterAll`), а не на весь файл: поки тегована роль входу — член ролі команд, `plan` відмовляє `plan.platform-role-shape`. Тож сценарій сиріт — послідовні кроки одного `describe` (план → блок команд `role-in-use` → план → блок команд з пакетом очистки → план), кожен блок команд тримає роль входу у своєму `beforeAll`. Актор `admin` отримує `read` на `OrgMember` новим будівником `rightsAdminReadingMembers()` (`fixtures/rights.ts`, перевизначення; локальний `rightsAdmins()` у `catalog-command-admin.db.test.ts` не чіпався). Утримання колбек-ресурсу між `beforeAll` і `afterAll` винесено в `heldResource` (`support/db.ts`); `command-runtime.db.test.ts` перейшов і на нього. Вплив на спеку: немає.
- [x] **Крок 3:** `pnpm --filter @simetrajs/designer test:db rights-admin-commands command-runtime apply-lifecycle apply-tools promotion-commit`, `pnpm --filter simetra test:db rights-sources` — зелено; час записати.
  - Прогін: designer — 5 файлів, 74 тести (`rights-admin-commands` 27, `command-runtime` 13, `apply-lifecycle` 7, `apply-tools` 21, `promotion-commit` 6), 315 с стінного часу (новий файл окремо — 31 с); `simetra` `rights-sources` — 20 тестів, 5 с.
- [x] **Крок 4:** коміт `test(designer): команди адміністрування прав через рантайм над тінню`.

### Задача 9: DB-тести інструмента обслуговування

**Files:**
- Create: `packages/designer/src/__tests__/rights-maintenance.db.test.ts`
- Modify: `packages/simetra/test/db/command-grants.db.test.ts` (кейс справжнього `simetra_runtime`)
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` — шар `requiredMemberAttribute()` (перевизначення `OrgMember` з обов'язковим реквізитом застосунку без `DEFAULT`); `packages/simetra/test/support.ts` — його реекспорт

**Причина рівня:** режим вирішує `session_user` справжньої сесії; запобіжники — на `COMMIT`.

Розгортання — одне (`inTarget` з `seedMarker(model.hash)`; модель `policyDomain(adminRoles(), requiredMemberAttribute())`); **глобальні сценарії — кожен у своїй копії** (`withCopy`), бо глобальний `fullAccess`, раз записаний, не зняти навіть у режимі (`last-full-access`). Сценарії рівня скоупу — на розгортанні, кожен у своєму `org`.

- [x] **Крок 1:** сценарії (послідовний `describe`):
  - `first global` (копія): сесія тесту (`postgres`) тримає `pg_advisory_xact_lock(<APPLY_ADVISORY_LOCK>)` → інструмент `busy`, нічого не записано; замок знято → інструмент через **пулер** (`postgres` через Supavisor, форма Задачі 0) → призначення є; журнал: `actor IS NULL`, `reason = 'maintenance'`, `action IS NULL`; повтор `runTool` CLI з `--yes` прямим портом → `not-first`, код виходу ≠ 0, рядків не додано;
  - `restore` (копія): носій є → `holder-exists`; носія зроблено `invalid` (поза командою — дозволений виняток) → відновлення для іншого недійсного → `not-effective`, нічого не записано → для дійсного — проходить, він дієвий носій;
  - `tenant` (розгортання): корінь `org` без учасників → без `member` → `member-required` з реквізитом, нічого не записано → з `member` → рядок членства з примушеними ключем, скоупом, користувачем і значенням; користувач — дієвий носій; журнал `maintenance` → повтор → `holder-exists`;
  - `tenant restore` (розгортання): єдиний носій `org` став `invalid` → `tenantFullAccess` для наявного учасника → призначення без нового рядка членства; `member` при наявному учаснику → `invalid-member`;
  - `scope missing` → `scope-missing`.
- [x] **Крок 2:** межа режиму на шляху інструмента: `a superuser that is not the migrator cannot enable maintenance` — тегована `LOGIN SUPERUSER` роль (`beforeAll`, прибирання в `afterAll`; не власник функцій, поза `PROVIDER_LOGIN_ROLES`; RLS і гранти обходить) → інструмент → `refused { reason: "rights-context" }`, нічого не записано. Червоніє лише від умови `session_user = current_user` (М3).
- [x] **Крок 3:** справжня загроза рантайму — кейс у `command-grants.db.test.ts` › `runtime login role` (модель з ядром призначень і засів адміністратора — з наявного розгортання файлу, інакше будівник): `the runtime login cannot enable maintenance even with a command context` — у `withRollback`: точка збереження, `SET SESSION AUTHORIZATION simetra_runtime` (справжня роль `supabase/roles.sql`), claims адміністратора, `set_config(<maintenance>, 'on', true)`, `SET LOCAL ROLE simetra_command`, контекст `administerRights`, ядро `save` самопризначення ширшої ролі, `SET CONSTRAINTS ALL IMMEDIATE` (лише в тесті: імітація `COMMIT` у відкатній транзакції, один оператор ядра без CTE) → `42501` `escalation`. Межу провайдера тримає наявний `rights-guards.db.test.ts` › `maintenance only from the owner login` (М4).
- [x] **Крок 4:** `pnpm --filter @simetrajs/designer test:db rights-maintenance`, `pnpm --filter simetra test:db command-grants` — зелено; час записати.
  - Прогін: designer `rights-maintenance` — 6 тестів, 19 с стінного часу; `simetra` `command-grants` — 15 тестів, 6 с.
  - Відхилення при виконанні: засів кейсу `command-grants` іде під `SET SESSION AUTHORIZATION postgres`, а не `SET ROLE postgres`: режим обслуговування засіву (`insert` довідників прав) дає лише сесія власника функцій. Модель кейсу — будівниками `policyDomain(adminRoles(), rightsAdminReadingMembers())` (у моделі файлу немає ядра призначень рівня `org` і адміністратора); ширша роль самопризначення — `TaskEditor`. Тегований суперкористувач — `withRuntimeLogin` без членств плюс `ALTER ROLE … SUPERUSER` (прибирання бекендів і ролі — його). `support.ts` реекспортує ще `GLOBAL_ADMIN_ID` і `MEMBER_TITLE`. Вплив на спеку: немає.
- [x] **Крок 5:** коміт `test(designer): інструмент обслуговування прав і межі режиму`.

### Задача 10: мутації

- [x] **Крок 1:** на закоміченому дереві — кожна мутація журналу, названий scoped тест, «що прибрано → що почервоніло», відкат (`git checkout -- <файл>`). DB-мутації — по одній.
- [x] **Крок 2:** коміт `docs(plan): П4-A4 — журнал мутацій`.

### Задача 11: документи

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` — §6.5 (перевірка ознаки бар'єру перед постановкою виклику ядра), §6.9 (хук фази прав не читає й не викликає даних застосунку; хук членства, що призначає роль — Р-A4-17), §6.10 (`rights-context` дає й T3), §6.12 (рядок «очистити сироти»; пакети: порядок фаз — дані застосунку до першої фази прав; абзац «Поза командами»: `rights-maintenance`, дії, `member`, відмови, звірка хешу, замок `apply`), §6.13 (`creatorMember` перевіряє `encodeMemberValues`), §6.15 (Р-A4-15; тимчасова ескалація як відоме обмеження бази з посиланням на блок Права-3 і тимчасовий бар'єр T3; явно: **Права-3 прибирає бар'єр T3 разом з обмеженням хуків членства**, а тест `refuses a second member of a batch when the membership onWrite assigns a role` стає позитивним), §6.16 (інваріант 17: після фази прав T3 не виконує фази, `ctx.run` і `ctx.read` над даними застосунку), §7.1 (рядки DB designer), §7.2 (кейси адміністрування й бар'єру), Додаток А (рядки з блоком A4)
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` — §7 (перелік сиріт; відновлення — інструмент глобального рівня й рівня скоупу; посилання на Права-3 щодо «прав актора на початок» без зміни механізму)
- Modify: `docs/superpowers/specs/2026-10-02-simetra-designer-design.md` — §3.1/§3.2 (`rights-maintenance`, `cliOnly`, `cli-only`)
- Modify: `packages/designer/skills/simetra-metadata/references/people-and-rights.md` — команди адміністрування через рантайм (операції, порядок фаз у пакеті, передача `fullAccess`, пакет очистки з `rightsOrphans`, хуки фаз прав без даних застосунку; рецепт: призначення в хуку членства — останньою фазою пакета або окремою командою з `afterCommit`), інструмент обслуговування
- Modify: `docs/ROADMAP.md` — статус A4; блок Права-3 — за рішенням архітекторки

- [x] **Крок 1:** внести; `python3 scripts/check-doc-anchors.py`.
  - Перевірка якорів іде разом із повними гейтами (Задача 12, крок 3), за
    дозволом архітекторки.
- [x] **Крок 2:** коміт `docs(spec): П4-A4 — адміністрування прав і інструмент обслуговування`.

### Задача 12: перевірка й звіт

- [ ] **Крок 1:** перевірка за `/виконай-задачу`: лінзи `code-review` за дифом, обов'язкові `correctness` (режим лише для мігратора; ескалація через пакет і бар'єр; без `--yes` — нічого) і `test-honesty`; кожну знахідку — `code-review-verifier`.
- [ ] **Крок 2:** контрольна точка архітекторці після DB-тестів.
- [ ] **Крок 3:** повні гейти на одному SHA — лише після «можна».

## Журнал мутацій

| № | Мутація | Тест, що має почервоніти | Результат |
| --- | --- | --- | --- |
| М1 | `errors.ts`: прибрати `escalation` з `FORBIDDEN_REASONS` | Задача 1 `maps a guard refusal answered at COMMIT`; Задача 8 `refuses self-assignment…` | ✅ червоніє Задача 1 `maps a guard refusal answered at COMMIT`. Якір виправлено: причини — у `COMMAND_CORE_ERRORS.forbidden` (`model/runtime/core.ts`), не в `errors.ts`; DB-кейс Задачі 8 під М1 не ганявся |
| М2 | `phase.ts`: T3 відмовляє операції з `context = administerRights`, де `subject` — учасник сесії | Задача 1 `does not refuse a self-assignment on its own` | ✅ червоніє `does not refuse a self-assignment on its own` |
| М3 | `guard-units.ts` `maintenanceSql`: прибрати `session_user = current_user` | Задача 9 `a superuser that is not the migrator…`; `command-grants` › `the runtime login cannot enable maintenance…` | ✅ червоніють Задача 9 `cannot enable maintenance` (запис пройшов, 13 с), `command-grants` › `the runtime login cannot enable maintenance…` (5 с) і наявний `has no direct rights and cannot enable maintenance` |
| М4 | `guard-units.ts` `maintenanceSql`: прибрати умову `PROVIDER_LOGIN_ROLES` | наявний `rights-guards` › `maintenance only from the owner login` | ✅ червоніє наявний `rights-guards` › `a provider login that owns the rights functions never enables maintenance` (77/78, 17 с) |
| М5 | `guard-units.ts`: гілка `assignment` у `catalogCheck` без перевірки приросту | Задача 8 `refuses a non-holder granting fullAccess` | ✅ червоніє `refuses a non-holder granting fullAccess` (прямий порт і пулер, 15 с); `refuses self-assignment…` лишається зеленим — його окремо ловить перевірка `actor` |
| М6 | `guard-units.ts`: перевірку `holders` перенести з відкладеного тригера в оператор | Задача 8 `transfers fullAccess…, own assignment first` | ✅ форма мутації: тригер `rights_tx_pending_check` — `INITIALLY IMMEDIATE` (окремої відкладеності лише для `holders` у коді немає); червоніє `transfers fullAccess…, own assignment first` (прямий порт і пулер, 16 с) |
| М7 | T3: прибрати бар'єр Р-A4-17 | Задача 6 крок 1; Задача 8 кейси бар'єру | ✅ червоніють усі 9 відмовних unit-кейсів Задачі 6; DB-кейси бар'єру Задачі 8 під М7 не ганялися |
| М7а | T3: ставити ознаку бар'єру після хука «до» фази прав, а не на її початку | Задача 6 `…from a hook of a rights phase` (`beforeWrite`) | ✅ червоніють `refuses ctx.read and ctx.run … (beforeWrite, ctx.read)` і `(beforeWrite, ctx.run)` |
| М7б | T3: ознаку тримати в стані команди, а не спроби | Задача 6 `starts a retry without the mark` | ✅ червоніє `starts a retry without the mark` |
| М7в | T3: перевіряти ознаку лише на старті фази, не перед постановкою виклику ядра | Задача 6 `refuses the core call of an application phase whose beforeWrite ran a rights phase`, `refuses a concurrent ctx.run…` | ✅ червоніють `refuses the core call of an application phase…` і `refuses a concurrent ctx.run … (the application phase first)`; варіант «спершу фаза прав» зелений, як і має бути |
| М7г | T3: бар'єр відхиляє будь-який `ctx.read` після ознаки | Задача 6 `allows rights data from a hook of a rights phase` | ✅ червоніє `allows rights data from a hook of a rights phase (ctx.read of the assignments)` |
| М8 | `invoke.ts`: прибрати відмову `cli-only` | Задача 5 `refuses a cli-only tool…` | ✅ червоніє `refuses a cli-only tool outside the cli channel before parsing input` |
| М9 | `registerCatalog`: не пропускати `cliOnly` | наявний `mcp.test.ts` › `lists every catalog tool in read-only mode`; Задача 7 `is absent from MCP` | ✅ червоніє наявний `lists every catalog tool in read-only mode` (23 с) |
| М10 | інструмент: `destructive: false` | Задача 7 `does not connect without confirmation` | ✅ червоніють `does not connect without confirmation`, `exits 2 without --yes` |
| М11 | ядро: прибрати перевірку `not-first` | Задача 9 `first global` (повтор) | ✅ червоніє Задача 9 `first global` (повтор через CLI не відмовив); 1924 с — майже весь час очікування замка стека іншою сесією |
| М12 | ядро: прибрати перевірку `holder-exists` | Задача 9 `restore`, `tenant` (повтор) | ✅ червоніють Задача 9 `restore` і `tenant` (87 с) |
| М13 | ядро: замок прибрати чи перенести після читання стану | Задача 7 властивість «замок — перший»; Задача 9 `first global` (`busy`) | ✅ червоніють `busy…` і три властивості `…: lock first, hash and row_security before the state…` |
| М14 | ядро: прибрати пост-перевірку дієвості | Задача 7 `it.each(actions)` `not-effective` (DB-кейсу, де вирішує лише пост-перевірка, немає: недійсного користувача відсіює передперевірка) | ✅ червоніють три unit `…: an assignment that is not effective rolls back as not-effective` |
| М15 | ядро: `set_config(…, false)` чи без третього аргументу | Задача 7 властивість `LOCAL` | ✅ червоніють три властивості `lock first…` |
| М16 | ядро: значення інтерполювати в текст | Задача 7 властивість «значення лише в параметрах» | ✅ червоніє `keeps a member value with a quote and every id in the parameters` |
| М17 | ядро: прибрати звірку хешу | Задача 7 `model-mismatch` | ✅ червоніють чотири `model-mismatch on …` |
| М18 | ядро: білий список без пари (`message`, `detail`) | Задача 7 мапінг `reason: "denied"` | ✅ червоніє `42501 — a reason detail under a message off the whitelist → maintenance.refused` |
| М19 | ядро: `23502` → `database.failed` | Задача 7 мапінг; Задача 9 `tenant` (`member-required`) | ✅ червоніє Задача 9 `tenant` (`database.failed` замість `member-required`, 10 с) |
| М20 | ядро: прибрати перевірку `scope-missing` | Задача 9 `scope missing` | ✅ червоніє Задача 9 `scope missing` (21 с) |
| М21 | ядро: прибрати перевірку `unknown-user` | Задача 7 `unknown-user` | ✅ червоніє `unknown user: refused before any write` |
| М22 | ядро: прибрати `row_security = off` | Задача 7 властивість «`row_security` — до читання стану» | ✅ червоніють три властивості `lock first…` |
| М23 | `normalize`: не заповнювати `detail` | Задача 3 `normalize keeps…`; Задача 9 `a superuser that is not the migrator…` | ✅ червоніють Задача 3 `normalize keeps…`, `leaves fields the server did not send undefined`; Задача 9 `cannot enable maintenance` → `reason: "denied"` (24 с) |
| М24 | `encodeMemberValues`: не перевіряти `forced` | Задача 2 `…rejects forced…` | ✅ червоніє Задача 2 `rejects a forced key` |
| М25 | `collectRightsFacts`: обрізати `rightsOrphans` лімітом | Задача 4 `rightsOrphans stays complete…` | ✅ червоніє `rightsOrphans stays complete past the warning limit` |
| М26 | `collectRightsFacts`: не класти призначення ролей-сиріт | Задача 4 крок 1; Задача 8 сценарій сиріт | ✅ червоніють Задача 4 крок 1 і Задача 8 `the plan lists every orphan…`, `cleans every orphan…`, `the plan then lists no orphans` (26 с) |
| М27 | `apply-tools.ts`: не віддавати `rightsOrphans` для `unchanged` | Задача 4 `renders an unchanged plan…`; Задача 8 сценарій сиріт | ✅ червоніють ті самі три кейси Задачі 8 (27 с); тест Задачі 4 `renders an unchanged plan…` червонить окрема мутація `renderPlan` без гілки `unchanged` |
| М28 | `stages/model.ts` `addMembershipKey`: ключа членства (скоуп, користувач) не виводити | Р-A4-17 (підстава) `cannot add himself to his own scope a second time` | ✅ червоніє (прямий порт і пулер, 20 с): другий рядок учасника створено, але пакет далі відмовлено `command.forbidden` `no-right` на `X` — новий учасник без призначення прав не дав і без ключа |
| М29 | `functions.ts` `scopesBody`: `own` — усі мої скоупи (`rights_my_scopes`), а не скоупи ролі | Р-A4-17 (підстава) `a member row without an assignment opens no data of its scope` | ✅ червоніє (прямий порт і пулер, 30 с): `read` чужого скоупу повертає рядок, власник якого — мій учасник без призначення |
| М30 | `functions.ts` `scopesBody`: вимір — усі мої скоупи, а не скоупи ролі | Р-A4-17 (підстава) `a member row without an assignment opens no data of its scope` | ✅ червоніє (прямий порт і пулер, 28 с): `read` чужого скоупу повертає рядок зі значенням виміру мого учасника без призначення |
