# П4-A3: рантайм команд T3 — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: прийнято архітекторкою 2026-10-30 після п'яти раундів аудиту Opus і
аудиту Codex; до виконання.
Архітекторка задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** host створює рантайм команд з пулу `simetra_runtime`, каталогу
рантайму й модулів об'єктів. Рантайм виконує операції й пакети над SQL-ядром
A2 в одній транзакції з claims, роллю, контекстом фази й хуками
`beforeWrite`/`onWrite`, а також мінімальне серверне читання під роллю
запиту профілю. Пакет публікує `simetra/server`.

**Архітектура:**

- **T0** (`packages/simetra/src/model/runtime/`): контракти сервера й клієнта
  (операція, пакет, результат, набір змін, помилка, запит читання,
  `SessionClaims`, тип порту ідентичності, модуль об'єкта, контекст хука),
  Zod-схема каталогу рантайму, коди помилок ядра й правило текстового
  кодування `numeric`/`bigint` — єдине джерело для T1 і T3.
- **T1** (`packages/simetra/src/compiler`): `<t>_delete` повертає й скоуп;
  `CompiledModel.catalogCommands` (поза канонічним знімком); спільний обхід
  полів сутності з кодогеном; будівник `buildRuntimeCatalog`.
- **T2** (`packages/simetra/src/schema/apply/state.ts`):
  `simetra.applied_snapshot_hash()`.
- **T3** (`packages/simetra/src/server`, плоска тека): порт `CommandDatabase`
  і `fromPgPool`, кодування й декодування значень, мапінг помилок,
  `createCommandRuntime`, транзакція з чергою запитів, фази, хуки, читання.
- **designer:** `compile --out` пише `runtime-catalog.json`; DB-тести рантайму
  над тінню рушія.
- **Лінт і пакування:** зона `src/server`, заборона T4/T5 → `simetra/server`,
  `./server` у збірці й `publishConfig.exports`.
- **Документи:** спека П4 §6.3, §6.4, §6.6, §6.9, §6.10, §6.12, §7.1, Рт20,
  Рт21, Додаток А; спека прав §5.3; спека системної схеми §3; борг прав §1;
  ROADMAP; скіл споживача `simetra-metadata`.

**Стек технологій:** TypeScript 7 (native `tsc`), Zod 4, Vitest, `pg` 8
(лише тести), Postgres 17 локального стека Supabase, Supavisor
(transaction-режим).

**Спека:** [спека П4](../specs/2026-10-26-p4-runtime-design.md) — Рт1, Рт5,
Рт6, Рт8, Рт11, Рт13, Рт15, Рт17–Рт21 (§5), §6.3–§6.6, §6.9–§6.11, §6.15,
§6.16 (інваріанти 3–7, 10, 13–16), §7.1–§7.4, рядок A3 у §8, рядки A3 у
Додатку А. Суміжні: [спека прав](../specs/2026-10-17-rights-design.md) §5.3;
[спека профілів провайдера](../specs/2026-10-23-provider-profiles-design.md)
ПП5, ПП7; [дослідження рантайму](../../research/runtime/server-runtime-2026-10.md).
Ядро A2 описано в §6.6–§6.7 спеки П4, ролі й гранти A1 — у §6.2 і §6.8.

**Залежність:** A2 у `main`; рішення Рт17–Рт21 (PR #18). Робоча гілка —
`feat/p4-a3`, де лежить і цей план; після злиття PR #18 —
`git merge origin/main`. Перед стартом:
`.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-30-p4-a3-command-runtime.md`.
Розбіжність якорів із кодом — архітекторці до старту.

## Global Constraints

- 🔴 `pnpm --filter <pkg> test <pattern>` і `pnpm --filter <pkg> test:db <pattern>` — **без** `--` перед шаблоном.
- 🔴 Ядро команд — лише згенеровані функції §6.6 спеки П4; користувач у SQL —
  лише `(SELECT simetra.current_user_id())`; контекст команди в SQL — лише
  функції `COMMAND_FUNCTIONS` (`compiler/rights/command-units.ts`).
- 🔴 Production-код `src/server` — плоска тека; імпортує лише `./…`,
  `simetra/model`, `zod` і `node:async_hooks` (Р-A3-10). Жодного `../…`,
  `pg`, `simetra/compiler`, `simetra/schema`, `node:fs`, `process.env`, I/O чи
  таймерів на рівні модуля (Рт17).
- 🔴 Жодної гілки за назвою провайдера чи ролі в `src/server`: ролі —
  `PLATFORM_ROLES`, `PROVIDER_API_ROLES`, `LOGIN_ROLE_REQUEST_PURPOSES`;
  налаштування — `SESSION_CLAIMS_SETTING`, `COMMAND_SETTING` (Рт18).
- 🔴 Коди помилок ядра (`command.*`, `hierarchy.isolation`) у T1 — лише
  імпортом з T0; рядкових літералів кодів у коді `src/compiler` (без
  коментарів) поза T0 немає.
- 🔴 Розгалуження за видом — лише через реєстр видів і контракти; колонку
  визначають за `origin`, не за іменем.
- 🔴 Лише зв'язані параметри (`$n`, значення — `string | null`) і безіменні
  оператори; жодного `SET` без `LOCAL`; ідентифікатори відношень, колонок і
  типів приведення — лише з каталогу, у лапках чи з переліку `CAST_TYPES`.
- 🔴 Текст помилки Postgres не потрапляє в жодне поле `CommandError`, у
  `CommandFailure.message` чи `cause`. Виняток — `DETAIL` і `HINT` помилок з
  кодом ядра, лише коли значення точно збігається з дозволеним переліком
  `COMMAND_CORE_ERRORS` для цього коду (`no-right`, `version`, причини
  запобіжників прав…), колонкою каталогу чи безпечним цілим версії; інакше —
  `command.internal` без тексту (SQL-обробник застосунку може кинути той самий
  `MESSAGE` з даними рядка в `DETAIL`).
- Тести T3 — на порт-фейку з відкладеними відповідями: точна послідовність
  операторів і параметрів цілими рядками, не `toContain` фрагмента.
- DB-тест — лише для того, що вирішує Postgres; кожен новий DB-кейс називає
  причину. Скіл `.agents/skills/writing-tests/SKILL.md` — перед кожним кроком
  тестів. Метадані — будівниками `fixtures/rights.ts`, не літералами.
- Об'єкти стека (ролі входу, бази) — лише через run-tag
  (`packages/simetra/test/db/connection.ts`); тест прибирає їх і на помилці.
- Кожна відмова й кожен інваріант має тест, що червоніє від названої мутації;
  DB-мутації — лише на закоміченому дереві. Журнал мутацій — у кінці плану.
- Між задачами гейти не червоні; кожен коміт — зелені scoped unit-тести,
  `pnpm --filter simetra typecheck` і `lint`.
- Повні гейти й повний `pnpm test:db` — на одному SHA, лише після «можна»
  архітекторки. Версій пакетів не чіпати. `AGENTS.md` і `CLAUDE.md` не
  правити. Публічні назви — англійською; коментарі — українською й про «чому».

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р-A3-1 | **Поле `action` операції — операція над об'єктом:** `create`, `update`, `markDeletion`, `delete`. Функцію ядра й дію контексту `simetra.command` T3 бере з каталогу: `operations.<операція> = { function, context }`; на системних довідниках прав `context` = `administerRights` (з `CatalogCommandContract.actions`). Операція — discriminated union за `action` (Задача 2). `create` завжди передає ядру `p_expected_version = NULL` (погоджено архітекторкою 2026-10-30) | за §6.12 команди адміністрування — ті самі `save`, `mark_deletion`, `delete`; клієнт обирає лише операцію, тож підробити контекст адміністрування через вхід неможливо | П4 §6.4 (пункт «операція»), §6.12 |
| Р-A3-2 | **Подію модуля визначає операція:** `OPERATION_EVENTS` у T0 — `create`, `update`, `markDeletion` → `write`; `delete` → немає подій в A3 (`beforeDelete` — разом із видаленням позначених) (погоджено) | `administerRights` охоплює і запис, і видалення, тож факт «дія → подія» в `KindAction` був би неоднозначним | П4 Рт20, §6.9 |
| Р-A3-3 | **Коди помилок ядра й правило текстового кодування — у T0** (`model/runtime/core.ts`): `COMMAND_CORE_ERRORS` (переноситься `CATALOG_COMMAND_ERRORS` без зміни форми — поля `errcode`, `message`, …), `HIERARCHY_ISOLATION_ERROR` у тій самій формі, `isTextEncodedType(pgType)`. T0 — єдине джерело (погоджено) | T3 не імпортує T1: T1 тягне `libpg-query` у серверний бандл (Рт11) | немає |
| Р-A3-4 | **`CompiledModel.catalogCommands: CatalogCommandContract[]`** — рівно той набір, з якого `pipeline.ts` генерує SQL ядра (`[]`, коли `!hasRightsFunctions(...)`, `compiler/rights/functions.ts`); `canonicalSnapshot` поля не читає, хеш не змінюється (погоджено) | одне джерело для SQL-ядра й каталогу | немає |
| Р-A3-5 | **Форма каталогу** — повна Zod-форма в Задачі 2. Ключі `p_item` — прапорці `insert`/`update` реквізиту з `createKeys`/`updateKeys` (ТЧ — `rowKeys`/`updateColumns`); ключ таблиці — поза реквізитами, лише з `op.id`. Поле `module` A3 не пише; джерело ознаки для MCP вирішує план A5 (погоджено) | T3 перевіряє вхід тими самими ключами, що й гранти | П4 §6.3 — форма |
| Р-A3-6 | **Каталог містить лише довідники з контрактом ядра** (погоджено) | інших цілей команд у П4-A немає (§6.1) | немає |
| Р-A3-7 | **Значення:** `Numeric` — рядок (десятковий без втрат); `BigInt` — JS `bigint`; колонка версії — `number` (поза безпечним цілим — `command.internal`); `Integer`, `SmallInt` — `number`; `Date` — `YYYY-MM-DD`; `DateTime` — ISO-рядок Postgres; `Json` — як є; масиви — поелементно. На вході (і в `where` читання) `Numeric` — лише рядок у межах `precision`/`scale` колонки (`fitsNumeric` T0), `BigInt` — `bigint` чи рядок цілого, `DateTime` — ISO зі зсувом. Посилання на перерахування — логічне ім'я значення на вході й виході (мітку знає лише база); поліморфна пара — `{ type: "<Kind>.<Name>", id }`, як у кодогені, а `kindLabel` цілі — лише в базі; невідоме значення — `command.invalid` з `path`. `Bytes` — hex-рядок `\\x…` в обидва боки, як у кодогені (`TS_OF_LOGICAL.Bytes: "string"`). Кожен тип перевіряється на вході: `Integer`, `SmallInt` — `Number.isInteger` у межах типу (`isWithinType` T0); `Boolean` — `boolean`; `String`, `Text`, `UUID`, `Bytes` — рядок; `Json` — лише чисті JSON-значення (скінченні числа, прості об'єкти й масиви, без `undefined`, `bigint`, `Map`, `Date`); `undefined` у `values`, рядку ТЧ чи чернетці — `command.invalid` з `path`. `DateTime` на виході — UTC: транзакція ставить `TimeZone` = `UTC` і `bytea_output` = `hex` локально разом із claims. Ключ і версія в декодованому рядку — під логічними іменами реквізитів (`keyName`, `versionName` каталогу; у довідника ключ — `ref`), як у типі сутності кодогену. Кодоген узгоджується: `BigInt` → `bigint`, стандартна колонка версії → `number` (погоджено). `bigint` — in-process API T3; формат передачі `bigint` клієнтові (JSON його не має) вирішує П4-B | Рт1 без втрат; тип сутності з кодогену (`defineObjectModule<Entity>`, §6.4) має збігатися з рядком рантайму; `decimal.js` і Temporal — T4 (платформна спека §8.5) | П4 §6.4 — речення: формат передачі `bigint` клієнтові — П4-B; спека П2, абзац «Кодоген»: `BigInt` → `bigint`, версія → `number` |
| Р-A3-8 | **Помилка назовні:** `run` і `read` відхиляються `CommandFailure` (`Error`, `message` = код, без `cause`, поле `error: CommandError`); з кількох помилок входу — перша за порядком реквізитів (погоджено) | один тип для host-а й MCP | П4 §6.4 (пункт «помилка») |
| Р-A3-9 | **DB-тести `runCommand` — у designer** над тінню рушія (`inTarget` з `desiredForApply`); контракт порту й `applied_snapshot_hash` — у `simetra/test/db` (погоджено) | лише тінь рушія дає стан провайдера в окремій базі з закоміченими даними | П4 §7.1 (рядки DB) |
| Р-A3-10 | **Лінт:** `src/server` імпортує лише `./…`, `simetra/model`, `zod`, `node:async_hooks` — у блоці `@typescript-eslint/no-restricted-imports` разом із `DB_ENGINE_PATTERN`; `src/data` і `src/ui` не імпортують `simetra/server` — у тих самих опціях `no-restricted-imports`, що й ярусні шаблони (погоджено) | Рт15, Рт17 тримає лінт; відносний `../model` вбудував би другу копію T0 у `dist/server` | немає |
| Р-A3-11 | **`command.nested`** — один `AsyncLocalStorage` на рівні модуля `simetra/server` (не I/O) для всіх екземплярів рантайму, лише `.run()`; дії `afterCommit` — поза сховищем (`exit`) (погоджено) | хук, що викликає `run` іншого екземпляра, інакше взяв би друге з'єднання й чекав би на свій же замок | немає |
| Р-A3-12 | **Створення рантайму — одна транзакція `READ ONLY`:** `pg_has_role(session_user, <роль запиту>, 'SET')` → `SET LOCAL ROLE simetra_command` → `SELECT simetra.applied_snapshot_hash()` → `COMMIT` (погоджено) | дві перевірки Рт11 і Рт18 за один обмін | немає |
| Р-A3-13 | **`23503` → `command.invalid`**; реквізит — за ім'ям обмеження з `foreignKey` каталогу (Postgres не заповнює `column`) (погоджено) | усі посилання команди перевіряє ядро (§6.6), `23503` — лише гонка | П4 §6.10 — рядок `command.constraint` без `23503` |
| Р-A3-14 | **`<t>_delete` повертає й колонку скоупу** рядка «до»; у кореня виду скоупу (`scopeColumn === key`) ключ не дублюється (погоджено; unit-дерево й DB-кейс) | набір змін має скоуп для write-back П4-B | П4 §6.6 (абзац про `<t>_delete`) |
| Р-A3-15 | **Черга й час життя `ctx`.** Одиниця черги транзакції — один оператор або неподільна пара `[set_config(simetra.command), виклик ядра]`; хуки ніколи не виконуються всередині завдання черги. Перша відмова будь-якої фази — помилка бази, `ctx.reject`, виняток хука, `command.depth`, `command.invalid` чи `command.nested` вкладеної фази — закриває чергу: нові операції відхиляються без звернення до порту (лише `ROLLBACK`), і команда завершується цією відмовою, навіть перехопленою хуком чи з `ctx.run`, якого хук не чекав (`40001`/`40P01` — повтором). Глибину `ctx.run` T3 бере з поточної фази в ALS, а не з `ctx`; сховище ALS несе ознаку «команда активна», яку T3 знімає після завершення команди. Метод `ctx` діє, лише поки виконується його хук і лише в асинхронному контексті своєї спроби (звірка зі сховищем ALS); інакше — `command.internal`. T3 чекає всі операції `ctx`, які хук почав, до наступного кроку. Вхід — `structuredClone` на спробу; `onWrite` отримує копію рядка | інакше два паралельні `ctx.run` переплели б контексти фаз (Рт5), а збережений `ctx` виконав би запит у чужій транзакції з чужими claims | П4 §6.9 — речення про час життя `ctx`; §6.5 — абзац «Помилка будь-якого кроку»: термінальна будь-яка відмова фази, не лише помилка бази |
| Р-A3-16 | **Гранти стану застосування:** `EXECUTE` функції `applied_snapshot_hash` — рівно рядки `executeGrants(sig, ["command"], provider)`, лише для `simetra_command`; гранти схеми лишаються як є (`platformSchemaGrants`); таблиці стану — без грантів. `executeGrants` експортується з `simetra/compiler` (погоджено) | правило «стан без грантів» звужується рівно на одну функцію | спека системної схеми §3 |
| Р-A3-17 | **Об'єкт у контрактах T0 — `MetadataRef` `{ kind, name }`** (`Operation.object`, `ReadQuery.object`, `Change.object`); ключ `objectModules` — `"<kind>.<name>"` (`"Catalog.Client"`). Перейменування об'єкта змінює його адресу в API рантайму — свідомо, як і в файлах; стабільна ідентичність — UUID у каталозі (погоджено) | ідентичність об'єкта — пара `(kind, name)` (`compiler/stages/identity.ts`); голе ім'я зламалося б у П4-C, коли документ має ім'я довідника; правило `AGENTS.md` «одна форма посилання» | П4 §6.4 |
| Р-A3-18 | **`ctx.action` — операція фази** (`create`, `update`, `markDeletion`), а не дія контексту; чернетка `markDeletion` — порожня (`values`, `tabularSections`, `mark` у ній — `command.invalid`), позначку хук бачить у `ctx.mark` (погоджено) | на довідниках прав дія контексту — `administerRights` для всіх операцій, і хук не відрізнив би створення від позначки | П4 Рт21, §6.9 |
| Р-A3-19 | **Відмова RLS на записі** (`42501` без коду ядра) — `command.forbidden` з `reason: "rls"`, `object` і `operation` фази; таблицю Postgres дає лише в тексті повідомлення, тож її T3 не повертає. Помилка на `COMMIT` — `object` за `error.table` лише при однозначному збігу імені серед таблиць каталогу (основні й ТЧ); неоднозначний — `object` відсутній (погоджено) | текст Postgres назовні не йде; запобіжники 2c2 ставлять `TABLE` без схеми | П4 §6.10 (рядок `command.forbidden`) |
| Р-A3-20 | **`required` не перевіряється до транзакції.** Обов'язковість — інваріант бази: незаповнений `NOT NULL` дає `23502` → `command.constraint` `notNull` з реквізитом (§6.10). `required` у каталозі — для форм і клієнтів | `beforeWrite` (аналог `ПередЗаписью`) часто дописує код чи номер; перевірка до хука відкинула б такий `create`; перевірка заповнення — подія `fillCheckProcessing` (П4-D) | немає |
| Р-A3-21 | **Колонка CHECK у каталозі рантайму** — з побічного результату компілятора: мапа «ім'я CHECK → колонка» (`CompiledModel.checkColumns`) з `assignNames` за фактично призначеними іменами; CHECK без колонки (правило рядка) — `columns: []`, і його `23514` лишається `command.internal` | `23514` → `command.constraint` з `kind: "check"` і реквізитом за §6.10; мапа поза канонічним знімком, тож знімок і хеш не змінюються | немає |

## Review Focus

1. **Хук «до» повертає чернетку з ключем поза грантом, ключем таблиці, невідомою ТЧ чи рядком ТЧ без `id`** — T3 повторює перевірку й відмовляє `command.invalid` з `path` (Задача 9, тест `revalidates the draft returned by beforeWrite`).
2. **Хук кидає звичайний `Error`** — `ROLLBACK`, `release()` рівно раз, `command.internal`, текст помилки назовні не йде, помилка йде в `log` (`kind: "hook"`), `afterCommit` не виконується (Задача 9, тест `maps a thrown hook error to command.internal`).
3. **`defer` host-а сам кидає виняток** — команда однаково повертає результат, помилка йде в `log` (Задача 9, тест `keeps the result when defer throws`).
4. **`connect()` пулу падає чи з'єднання рветься посеред фази** — `command.unavailable`, `release(true)` для обірваного з'єднання, повтору немає (Задача 8, тести `maps connect failure and logs the original error`, `destroys a lost connection`).
5. **`Numeric` приходить числом JS чи з більшим `scale`, `DateTime` — без зсуву, рядок довший за `maxLength`, `where` читання з `varchar(n)` довшим за `n`** — `command.invalid` з `path` без звернення до бази; читання не обрізає параметр (Задачі 6 і 7, тести `rejects lossy and invalid values`, `does not truncate where parameters`).

---

### Задача 0: якорі й вхід тегованої ролі через пулер

**Files:** лише читання; звіт — під цією задачею в плані.

- [x] **Крок 1:** `orient --plan` цього файлу; розбіжності — архітекторці.
- [x] **Крок 2:** з'ясувати фактом, як тегована роль входу з паролем
  (`testRoleName("runtime")`, `LOGIN PASSWORD`, членства `simetra_command` і
  `authenticated` `WITH INHERIT FALSE, SET TRUE`, створена під
  `testSuperuserUrl()`) входить через локальний Supavisor (`testPoolerUrl()`,
  `supabase/config.toml` `[db.pooler]`; зразок — `throughPooler` у
  `packages/designer/src/schema-engine/__tests__/read-only.db.test.ts`) до
  тіні рушія. Записати форму URL чи причину відмови.
- [x] **Крок 3:** (не знадобився: вхід можливий, див. звіт нижче) якщо вхід неможливий — запасна форма §7.3: вхід роллю пулера
  й тестовий порт-обгортка, що ставить `SET LOCAL ROLE <тегована роль>`
  першим оператором кожної транзакції; записати, що тест тоді доводить
  семантику transaction-режиму, а не вхід. Вибір — архітекторці.

**Звіт Задачі 0 (2026-10-31).** Якорі: усі ✗ `orient --plan` — файли, які
план створює; символи, які план споживає, на місці (`throughPooler` — локальна
функція `read-only.db.test.ts`, не експорт). Вхід через пулер можливий, запасна
форма §7.3 не потрібна. Проба: роль `LOGIN NOINHERIT PASSWORD` з членствами
`simetra_command` і `authenticated` `WITH INHERIT FALSE, SET TRUE`, окрема
база під `testSuperuserUrl()`.

| Форма URL | Результат |
| --- | --- |
| `postgresql://<роль>.pooler-dev:<пароль>@127.0.0.1:54329/<база>` (хост і порт — з `testPoolerUrl()`, база — з адреси цілі, як `throughPooler`) | вхід; `session_user` = тегована роль; `pg_has_role(session_user, 'simetra_command', 'SET')` = `true`; `SET LOCAL ROLE` і `set_config(…, true)` діють у транзакції |
| `postgresql://<роль>:<пароль>@127.0.0.1:54329/<база>` (без суфікса тенанта) | відмова `XX000` `ENOIDENTIFIER` |

Після `COMMIT` на тому самому з'єднанні `current_user` — роль входу, а
`current_setting('request.jwt.claims', true)` — порожній рядок, не `NULL`
(GUC, раз поставлений у сесії, лишається визначеним). Тест інваріанта 7
перевіряє «порожньо або `NULL`», а не `IS NULL`.

### Задача 1: коди помилок ядра в T0

**Files:**
- Create: `packages/simetra/src/model/runtime/core.ts`, `packages/simetra/src/model/runtime/index.ts`
- Modify: `packages/simetra/src/model/index.ts`; генератори з літералами кодів — `compiler/catalog-command/units.ts`, `compiler/hierarchy-units.ts`, `compiler/key-units.ts`, `compiler/rights/guard-units.ts`, `compiler/rights/effects-units.ts`, `compiler/rights/command-units.ts`; імпортери `CATALOG_COMMAND_ERRORS` — `packages/simetra/test/db/catalog-command{,-rights,-admin}.db.test.ts`
- Test: `packages/simetra/src/model/__tests__/runtime-core.test.ts`, `packages/simetra/src/compiler/__tests__/core-error-source.test.ts`

**Interfaces — Produces:**
- `COMMAND_CORE_ERRORS` — форма `CATALOG_COMMAND_ERRORS` плюс коди, які генератори прав і ключа пишуть літералами; старе ім'я видаляється (без реекспорту).
- `HIERARCHY_ISOLATION_ERROR = { errcode: "0A000", message: "hierarchy.isolation" }`.
- `isTextEncodedType(pgType: string): boolean` — `^(bigint|numeric)(\(.*\))?(\[\])?$`.
- `CURRENT_USER_FUNCTION_NAME = "current_user_id"`, `APPLIED_SNAPSHOT_HASH_FUNCTION_NAME = "applied_snapshot_hash"` (схема — `PLATFORM_SCHEMA`); T1 (`compiler/platform/names.ts`) і T2 беруть імена звідси, T3 — теж.

- [x] **Крок 1:** тести: `isTextEncodedType` на `bigint`, `numeric(12,2)`, `numeric[]`, `bigint[]` (true) і `integer`, `text`, `numeric_x` (false); `core-error-source.test.ts` — код джерел `src/compiler` поза `__tests__`, без коментарів (`//…`, `/* … */`), не містить рядкового літерала `/["'`]command\.[a-z-]+["'`]/` і `hierarchy.isolation`; текстові колонки результату ядра фікстури A2 — рівно колонки з `isTextEncodedType`.
- [x] **Крок 2:** `pnpm --filter simetra test runtime-core core-error-source` — FAIL.
- [x] **Крок 3:** створити `core.ts`; генератори беруть коди й регекс з T0 (`sqlLiteral(COMMAND_CORE_ERRORS.…)`).
- [x] **Крок 4:** `pnpm --filter simetra test catalog-command hierarchy rights runtime-core core-error-source` і `typecheck` — PASS; згенерований SQL незмінний.
- [x] **Крок 5: коміт** — `refactor(model): коди помилок ядра й кодування numeric/bigint — у T0`.

### Задача 2: контракти рантайму в T0

**Files:**
- Create: `packages/simetra/src/model/runtime/{operation,result,errors,session,read,module,catalog}.ts`
- Modify: `packages/simetra/src/model/runtime/index.ts`, `packages/simetra/src/model/schemas/value-type.ts` (експорт `fitsNumeric`, `isDate`, `isDateTime` для T3)
- Test: `packages/simetra/src/model/__tests__/runtime-contracts.test.ts`

**Interfaces — Produces** (усе експортує `simetra/model`):
- `OBJECT_OPERATIONS = ["create", "update", "markDeletion", "delete"] as const`; `ObjectOperation`; `OPERATION_EVENTS: Readonly<Record<ObjectOperation, "write" | undefined>>`.
- `operationSchema` — `z.discriminatedUnion("action", …)`, кожна гілка strict, `object` — `MetadataRef` (Р-A3-17): `create { object, id, values?, tabularSections? }` (`id` — `z.guid()`: Postgres приймає UUID без RFC-варіанта, а `z.uuid()` їх відкидає); `update { object, id, expectedVersion, values?, tabularSections? }`; `markDeletion { object, id, expectedVersion, mark: boolean }`; `delete { object, id, expectedVersion }`; `expectedVersion` — безпечне ціле ≥ 1; `values` — `Record<string, unknown>`; `tabularSections` — `Record<string, Record<string, unknown>[]>` (рядок ТЧ — логічні реквізити й ключ рядка під `keyName` ТЧ; перевіряє T3 за каталогом). `Operation = z.infer<…>`; `batchSchema` — непорожній масив.
- `Change { object: MetadataRef; scopeKind?: string /* id виду скоупу */; scope?: string /* лише в скоуплених */; id: string; version: number; operation: ObjectOperation }`; `CommandResult { rows: Record<string, unknown>[] /* по одному на операцію входу, у її порядку */; changes: Change[] /* усі фази, зокрема ctx.run, у порядку викликів ядра */ }`.
- `COMMAND_ERROR_CODES` (коди §6.10 і `command.read-role-missing`); `CommandErrorCode`; `CommandError { code; reason?: string; object?: MetadataRef; operation?: ObjectOperation; path?: string; detail?: string; currentVersion?: number; kind?: "notNull" | "unique" | "check"; attributes?: string[]; hashes?: { catalog: string; applied: string | null }; role?: string }`.
- `SessionClaims { sub: string; act?: { sub: string }; readonly [claim: string]: unknown }`; `sessionClaimsSchema` (`sub` — непорожній рядок, решта — passthrough).
- `HeaderSource { get(name: string): string | null }`; `VerifySession = (headers: HeaderSource) => Promise<SessionClaims | null>` — лише тип (Рт19).
- `READ_LIMIT_MAX = 200`; `readQuerySchema` — union `{ object, id: guid }` | `{ object, where: Record<string, unknown>, after?: guid, limit: 1…200 }`; `ReadQuery`.
- `Draft<E> { values?: Partial<E>; tabularSections?: Record<string, Record<string, unknown>[]> }` — без `id` і `mark` (Р-A3-18).
- `HookContext { readonly object: MetadataRef; readonly id: string; readonly action: ObjectOperation; readonly isNew: boolean; readonly mark?: boolean; readonly additionalProperties: Map<string, unknown>; readonly user: string; readonly act?: { sub: string }; run(operation: Operation): Promise<Record<string, unknown>>; read(query: ReadQuery): Promise<Record<string, unknown>[]>; reject(code: string, path?: string): never; afterCommit(fn: () => unknown): void }`.
- `ObjectModule<E extends object = Record<string, unknown>> { beforeWrite?(args: { ctx: HookContext; draft: Draft<E> }): Draft<E> | Promise<Draft<E>>; onWrite?(args: { ctx: HookContext; row: E }): void | Promise<void> }`; `OBJECT_MODULE_KEYS = ["beforeWrite", "onWrite"] as const`; `defineObjectModule<E extends object>(module: ObjectModule<E>): ObjectModule<E>`.
- `CAST_TYPES` — перелік базових типів приведення: `text`, `uuid`, `boolean`, `smallint`, `integer`, `bigint`, `numeric`, `real`, `double precision`, `date`, `timestamp with time zone`, `timestamp without time zone`, `time without time zone`, `interval`, `character varying`, `bytea`, `json`, `jsonb` (без `character`: `$n::character` — це `char(1)`).
- Каталог (`catalog.ts`, усі схеми strict):
  - `qualifiedNameSchema { schema: string; name: string }`;
  - `castTypeSchema` — `CAST_TYPES` чи `"<схема>"."<ім'я>"` (ідентифікатори без `"`), з необов'язковим `[]`;
  - `runtimeAttributeSchema { name; column; pgType: string /* лише для type і декодування, у SQL не йде */; castType; type: LogicalType | "PgEnum" | "Raw"; array?: true; required: boolean; maxLength?: number; precision?: number; scale?: number; insert: boolean; update: boolean; generated?: true; enumValues?: { name: string; label: string }[] /* Ref на Enumeration */; pair?: { typeColumn: string; targets: { object: MetadataRef; label: string }[] } }`;
  - `runtimeConstraintSchema { name; kind: "primaryKey" | "unique" | "check" | "foreignKey"; columns: string[] }`;
  - `runtimeSectionSchema { name; table: qualifiedName; key; keyName; parent; lineNumber; attributes; constraints }`;
  - `runtimeOperationTargetSchema { function: qualifiedName; context: string }`;
  - `runtimeObjectSchema { id; name; kind; kindLabel; table; key; keyName; versionColumn; versionName; scopeKindId?; scopeColumn?; attributes; tabularSections; operations: { create?; update?; markDeletion?; delete? }; constraints }`;
  - `runtimeCatalogSchema { format: 1; snapshotHash; provider: z.enum(DATABASE_PROVIDERS); objects }`; типи — `z.infer`.

- [x] **Крок 1:** тести: `operationSchema` відкидає `create` з `expectedVersion`, `update` без неї, `markDeletion` без `mark`, `delete` без `id`, `action: "administerRights"`, невідомий ключ, `id` не UUID, `object` рядком, `batchSchema` відкидає `[]`; `readQuerySchema` відкидає `limit: 201` і `0`; `sessionClaimsSchema` відкидає `sub: ""` і зберігає `role`; `castTypeSchema` відкидає `text or true` і `numeric(12,2)`, приймає `"public"."OrderStatus"[]`; `runtimeCatalogSchema` відкидає `format: 2`; `OPERATION_EVENTS.delete === undefined`; `defineObjectModule(m) === m`; типовий тест: `defineObjectModule<{ code: string }>({ beforeWrite: ({ draft }) => draft })` присвоюється до `Record<string, ObjectModule<object>>`.
- [x] **Крок 2:** `pnpm --filter simetra test runtime-contracts` — FAIL.
- [x] **Крок 3:** реалізувати; T0 — лише `zod`.
- [x] **Крок 4:** тест, `typecheck`, `lint` — PASS.
- [x] **Крок 5: коміт** — `feat(model): контракти рантайму команд у T0`.

### Задача 3: ядро `delete`, контракти в моделі, каталог рантайму

**Files:**
- Create: `packages/simetra/src/compiler/entity-fields.ts`, `packages/simetra/src/compiler/runtime-catalog.ts`
- Modify: `compiler/catalog-command/units.ts` (`deleteFunction`), `compiler/codegen.ts` (обхід колонок — через `entityFields`; `TS_OF_LOGICAL.BigInt` → `bigint`; стандартна колонка версії → `number` за визначенням реєстру, не за іменем), `compiler/compile.ts` (`CompiledModel.catalogCommands`), `compiler/pipeline.ts` (виклик `catalogCommandContracts` винести з аргументу `buildCatalogCommandUnits`), `compiler/index.ts`
- Test: `packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts`, `packages/simetra/src/compiler/__tests__/codegen.test.ts` (`version: number`, `BigInt` → `bigint`), `packages/simetra/src/compiler/__tests__/catalog-command-mark.test.ts` (дерево результату `delete`), `packages/simetra/test/db/catalog-command-admin.db.test.ts` (DB-кейс скоупу в результаті `delete`)

**Interfaces:**
- Consumes: `catalogCommandContracts`, `CatalogCommandContract`, `hasRightsFunctions` (`compiler/rights/functions.ts`), `runtimeCatalogSchema`, `CAST_TYPES` (Задача 2).
- Produces:
  - `entityFields(model: CompiledModel, table: PhysicalTable, context: { standard: ReadonlyMap<string, StandardColumnDef>; elements: ReadonlyMap<string, ElementSource> }): EntityField[]`, `EntityField { name: string; columns: [string] | [string, string]; standard?: StandardColumnDef; element?: ElementSource; scopeKindId?: string; notNull: boolean; generated: boolean; hasDefault: boolean /* default чи identity */ }` — обхід `origin`, як в `emitEntityTypes`; рядок-одинак (`def.singleton`) пропускається; заголовки, описи, цілі стандартного `Ref` і `readonly` лишаються в `codegen.ts`;
  - `buildRuntimeCatalog(model: CompiledModel): RuntimeCatalog`; обидві — з `simetra/compiler`.

Правила побудови: ключ, колонка версії, `parent` і `lineNumber` ТЧ — поза `attributes`; `keyName`, `versionName` — логічні імена стандартних колонок у стилі проєкту (`standardLogicalName`); `precision`/`scale` — з типу значення `Numeric`; `required` — лише серед `insert: true`: `notNull && !hasDefault && !generated`; `maxLength` — `length` типу значення (`schemas/value-type.ts`) логічного `String` з `element` чи `standard.type`; `castType` — базовий тип колонки без typmod (`character varying(10)` → `character varying`) чи енам у лапках; `pair.typeColumn` — перша колонка пари, `targets` — `MetadataRef` і `kindLabel` кожної цілі (`CommandReference.pair.targets`); `enumValues` — ім'я й `physicalName` кожного значення перерахування-цілі; `operations` — з `functions` і `actions` контракту (`create` лише за `actions.create`); `constraints` — PK, `uniques`, унікальні `indexes` (колонки — `keys[].column`, ключ-вираз пропускається), `checks` (колонка — за Р-A3-21), `foreignKeys`, і так само для кожної ТЧ; порядок об'єктів — порядок `model.objects`.

- [x] **Крок 1:** тести: дерево `<t>_delete` повертає ключ, версію текстом і колонку скоупу, без дубля ключа в кореня; DB-кейс (причина: видимість рядка «до» вирішує RLS): видалення призначення повертає скоуп призначення; каталог фікстури `compileRights(withSql(policyDomain(writeRoles(), adminRoles(), commandCoreLayer(), ticketNoticeHandler().layer), ticketNoticeHandler()))` — `snapshotHash === model.hash`; дві компіляції дають однаковий `JSON.stringify`; у довідника призначень `operations.delete.context === "administerRights"`; у «Користувачів» немає `create` і `markDeletion`; поліморфний `Ref` має `pair`; колонка поза грантом має `update: false`; ключ не входить у `attributes`; `runtimeCatalogSchema.parse` проходить; `canonicalSnapshot(model)` не має ключа `catalogCommands`, а `modelHash({ ...model, catalogCommands: [] }) === model.hash`.
- [x] **Крок 2:** FAIL.
- [x] **Крок 3:** реалізувати.
- [x] **Крок 4:** `pnpm --filter simetra test runtime-catalog codegen canonical catalog-command` і `test:db catalog-command-admin` — PASS (`entities.d.ts` змінюється лише в типах `BigInt` і версії); `typecheck`.
- [x] **Крок 5: коміт** — `feat(compiler): каталог рантайму з контрактів ядра; delete повертає скоуп`.

### Задача 4: `runtime-catalog.json` у `compile --out`

**Files:**
- Modify: `packages/designer/src/tools/artifacts.ts`, `packages/designer/src/cli/command.ts` (опис `--out`), `packages/designer/skills/simetra-metadata/SKILL.md` (перелік артефактів `--out`)
- Test: `packages/designer/src/__tests__/catalog.test.ts`, `packages/designer/src/__tests__/compile.test.ts`

- [x] **Крок 1:** тести: перелік артефактів містить `runtime-catalog.json`; вміст = `JSON.stringify(buildRuntimeCatalog(model), null, 2) + "\n"`.
- [x] **Крок 2:** FAIL. **Крок 3:** додати артефакт, опис прапора й рядок скіла. **Крок 4:** `pnpm --filter @simetrajs/designer test catalog compile skill-examples` — PASS.
- [x] **Крок 5: коміт** — `feat(designer): compile --out пише runtime-catalog.json`.

### Задача 5: `simetra.applied_snapshot_hash()`

**Files:**
- Modify: `packages/simetra/src/schema/apply/state.ts` (`renderApplyState`, `applyStateOf`), `packages/simetra/src/compiler/index.ts` (експорт `executeGrants`)
- Test: `packages/simetra/src/schema/apply/__tests__/state.test.ts`, `packages/simetra/test/db/applied-snapshot-hash.db.test.ts`

Форма: `STABLE SECURITY DEFINER SET search_path = ''`, повертає `snapshot_hash` з `simetra.marker` (`NULL` без рядка); гранти — рівно рядки `executeGrants(sig, ["command"], provider)`, і коли гранти схеми дає платформний шар. `applyStateOf.owns` визнає функцію, її `acl` і ідентичності грантів своїми, як таблиці стану; `applyStateOf.state` враховує й функцію (стан з функцією без таблиць — не `absent`).

- [x] **Крок 1:** unit: оператор функції й рядки гранту цілими рядками; тести «leaves schema grants to the platform layer when it is present» і «grants nothing on the state tables» переписати на правило Р-A3-16; `applyStateOf` на стані з функцією не дає стороннього об'єкта.
- [x] **Крок 2:** DB (причина: гранти й `SECURITY DEFINER` вирішує Postgres): під `simetra_command` функція повертає записаний хеш; під `authenticated` — `42501`.
- [x] **Крок 3:** FAIL → реалізувати → `pnpm --filter simetra test state` і `pnpm --filter simetra test:db applied-snapshot-hash` — PASS.
- [x] **Крок 4: коміт** — `feat(schema): applied_snapshot_hash для звірки рантайму`.

### Задача 6: порт і значення T3

**Files:**
- Create: `packages/simetra/src/server/port.ts`, `packages/simetra/src/server/values.ts`
- Test: `packages/simetra/src/server/__tests__/values.test.ts`, `packages/simetra/src/server/__tests__/port.test.ts`, `packages/simetra/test/db/command-port.db.test.ts`

**Interfaces — Produces:**
- `CommandDatabase { connect(): Promise<DatabaseClient> }`; `DatabaseClient { query(text: string, params?: readonly (string | null)[]): Promise<{ rows: Record<string, unknown>[]; command: string }>; release(destroy?: boolean): void }`.
- `DatabaseError { code?: string; message: string; detail?: string; hint?: string; constraint?: string; table?: string; column?: string; connectionLost: boolean }`; `normalizeError(error: unknown): DatabaseError` — `connectionLost` для класу `08`, `57P01`–`57P03` і помилки без коду.
- `fromPgPool(pool: PgPoolLike): CommandDatabase`; `PgPoolLike` — структурний тип `connect()` пулу `pg` без імпорту `pg`; `query` — `{ text, values }` без `name`.
- `encodeItemValue(attribute: RuntimeAttribute, value: unknown, path: string): { value: unknown } | { error: CommandError }` — значення JSON для `p_item` (`jsonb_populate_record`): `Numeric`, `BigInt`, дати — рядками; `Json` — як є; масив — масивом JS; перерахування — мітка; пара — дві колонки.
- `encodeParam(attribute: RuntimeAttribute, value: unknown, path: string): { value: string | null } | { error: CommandError }` — текст параметра `where` за тими самими правилами; `Json` і масив у `where` — `command.invalid`.
- `encodeItem(object: RuntimeObject, op: Operation, draft: Draft<object>): { item: Record<string, unknown> } | { error: CommandError }` — ключ таблиці = `op.id`; логічні імена → фізичні; `tabular` за `table.name` ТЧ, значення `keyName` рядка (UUID, обов'язкове) → `key` ТЧ; пара `{ type, id }` → дві колонки; ключі шапки лише з `insert` (`create`) чи `update` (`update`), ключі рядків ТЧ — з `insert` реквізитів ТЧ на будь-якій операції (так звіряє ядро, `rowKeys`); ключ таблиці (`keyName`) чи невідомий реквізит у `values` — `command.invalid` з `path`; значення — `encodeItemValue`; `required` не перевіряється (Р-A3-20); `maxLength` — у символах; значення, яке не клонується (`DataCloneError`), — `command.invalid`.
- `decodeRow(object: RuntimeObject, json: string): Record<string, unknown>` — реквізити за типами; мітка → ім'я значення; `kindLabel` пари → `"<Kind>.<Name>"`; ключ → `keyName`; `versionColumn` → `versionName` як `number`; `tabular` — за реквізитами ТЧ з ключем рядка під `keyName` ТЧ.

- [x] **Крок 1:** unit `values`: кожне правило Р-A3-7 в обидва боки, зокрема перерахування (`"Open"` ↔ `open`), пара, `Json` об'єктом (не JSON-рядком), масив, `Bytes`; невідоме значення перерахування — `command.invalid`; `rejects lossy and invalid values` охоплює також `NaN`, `Infinity`, дріб в `Integer`, `Map`/`Date`/`bigint` у `Json`, `undefined` у `values` і в рядку ТЧ; `rejects lossy and invalid values` (Review Focus 5); ключ поза `update` і ключ таблиці у `values` — `command.invalid` з `path`; insert-only реквізит нового рядка ТЧ на `update` — приймається; рядок результату має ключ під `ref` і версію під `version` як `number`; версія `9007199254740992` — `command.internal`.
- [x] **Крок 2:** unit `port`: `fromPgPool` на фейку передає `{ text, values }` без `name`; `normalizeError` на `08006`, `57P01`, помилці без коду, `P0001` з `hint`.
- [x] **Крок 3:** DB-контракт (причина: парсери типів `pg`, Р19): JSON-текст у формі ядра з `numeric` на 20 цифр, `jsonb`, `bytea` (і за `bytea_output = escape` у сесії пулу — та сама форма після `set_config` кроку 2), `bigint` понад 2^53, `timestamptz`, `date`, масивами дає той самий `decodeRow` на пулі з типовими парсерами й на пулі з власними `types.getTypeParser`; `RAISE … USING HINT` дає `hint`.
- [x] **Крок 4:** FAIL → реалізувати → PASS (`pnpm --filter simetra test values port`, `test:db command-port`).
- [x] **Крок 5: коміт** — `feat(server): порт CommandDatabase і кодування значень`.

### Задача 7: мапінг помилок і будівник читання

**Files:**
- Create: `packages/simetra/src/server/errors.ts`, `packages/simetra/src/server/read.ts`
- Test: `packages/simetra/src/server/__tests__/errors.test.ts`, `packages/simetra/src/server/__tests__/read.test.ts`

**Interfaces — Produces:**
- `class CommandFailure extends Error { readonly error: CommandError }` — `message` = `error.code`, без `cause`.
- `mapDatabaseError(error: DatabaseError, catalog: RuntimeCatalog, phase: { object: RuntimeObject; operation: ObjectOperation } | undefined): CommandError` — порядок перевірок: `connectionLost` → `unavailable`; `42501`+`command.context` → `context`; `42501`+`command.forbidden` → `forbidden` з `reason` = `detail`, лише якщо `detail` — з дозволеного переліку T0; `42501` без них → `forbidden` за Р-A3-19; `P0001`+`command.conflict` → `conflict` з `reason` = `detail` (`version`, `exists`), `currentVersion` з `hint` лише як безпечне ціле; `22023`+`command.invalid` → `invalid` за таблицею нижче; `23503` → `invalid`, `path` — реквізит за `constraint` з `foreignKey` каталогу (Р-A3-13); `23502` → `constraint` `notNull`, `attributes` за парою `table` + `column` (основна таблиця чи ТЧ); `23505`, `23514` → `constraint` з `kind` і `attributes` за `constraint` каталогу (основна таблиця чи ТЧ); `0A000`+`hierarchy.isolation` → `internal`; решта → `internal`. Кожен `internal` з помилки бази йде в `log` (`kind: "database"`, повна помилка) — назовні лише код.
- Таблиця `DETAIL` → поле для `22023`: фізична колонка основної таблиці → `path` = реквізит; `tabular.<таблиця>` → `path` = ім'я ТЧ; `tabular.<таблиця>.<колонка>` → `path` = `<ТЧ>.<реквізит>` (ключ рядка → `<ТЧ>.<keyName>`); колонка типу пари → `path` = реквізит пари; `create`, `p_item`, `tabular`, `p_expected_version`, `p_mark`, `predefined` → `reason` = значення, без `path`; невідоме → `reason: "unknown"`.
- `buildReadStatement(object: RuntimeObject, query: ReadQuery): { text: string; params: (string | null)[] } | { error: CommandError }` — `SELECT (to_jsonb(t) || jsonb_build_object(<колонки isTextEncodedType>))::text AS row FROM "<schema>"."<table>" t WHERE … ORDER BY "<key>" LIMIT $n`; рівність `"<col>" = $n::<castType>`; значення — `encodeParam`; текстові колонки масивів — `::text[]`, як у `textColumns` ядра; пара — дві рівності; `after` — `"<key>" > $n::uuid`; `null` у `where` — `"<col>" IS NULL`; невідомий реквізит — `command.invalid` з `path`; `22P02` під час читання — `command.invalid`.

- [x] **Крок 1:** тести на кожну гілку порядку й кожен рядок таблиці `DETAIL`; `command.forbidden`/`command.conflict`/`command.context` з `DETAIL` поза дозволеним переліком чи `HINT` не цілим — `command.internal` без тексту; для кожного класу `23xxx` і `42501` текст `message`/`detail` Postgres (зокрема «Failing row contains (…)», «Key (…)=(…)») не потрапляє в жодне поле `CommandError` і в `CommandFailure`; помилка на `COMMIT` з однозначним `table` дає `object`, з неоднозначним — без нього; оператори читання цілими рядками для `{ object, id }`, `where` з парою, `after`, `limit`; `does not truncate where parameters` — колонка `character varying(10)` приводиться до `character varying` (Review Focus 5).
- [x] **Крок 2:** FAIL → **Крок 3:** реалізувати → **Крок 4:** PASS.
- [x] **Крок 5: коміт** — `feat(server): мапінг помилок §6.10 і будівник читання`.

### Задача 8: `createCommandRuntime`, транзакція й фази без хуків

**Files:**
- Create: `packages/simetra/src/server/runtime.ts`, `packages/simetra/src/server/transaction.ts`, `packages/simetra/src/server/phase.ts`
- Modify: `packages/simetra/src/server/index.ts`
- Test: `packages/simetra/src/server/__tests__/runtime.test.ts`, `packages/simetra/src/server/__tests__/transaction.test.ts`, `packages/simetra/src/server/__tests__/fake-database.ts`

**Interfaces — Produces:**
- `CommandRuntimeOptions { database: CommandDatabase; catalog: unknown; objectModules?: Readonly<Record<string /* "<kind>.<name>" */, ObjectModule<object>>>; defer?: (work: Promise<unknown>) => void; readFallback?: boolean; maxAttempts?: number /* 3 — спроб загалом */; maxDepth?: number /* 8 */; log?: (entry: { kind: "afterCommit" | "hook" | "defer" | "database"; error: unknown }) => void /* типово console.error */ }`.
- `createCommandRuntime(options): Promise<CommandRuntime>`; у цій задачі `CommandRuntime { run(session: SessionClaims, input: Operation | readonly Operation[]): Promise<CommandResult> }`; `read` додає Задача 10.
- `readRoleOf(provider: DatabaseProvider, purposes = LOGIN_ROLE_REQUEST_PURPOSES, roles = PROVIDER_API_ROLES): string | undefined`.
- Фейк: `fakeDatabase(script)` записує кожен `query`/`release` і відповідає відкладеними промісами, які тест розв'язує вручну.

Правила: створення — `runtimeCatalogSchema.parse`; невідомий об'єкт чи ключ модуля поза `OBJECT_MODULE_KEYS` — відмова; транзакція Р-A3-12; профіль без ролі запиту — без перевірки членства; `readFallback: true` замінює лише `command.read-role-missing` запасним шляхом (за наявного членства читання йде під роллю запиту); `42883` на `applied_snapshot_hash()` (база до цієї функції) і `3F000` (немає схеми `simetra`) — `command.model-mismatch` з `applied: null`; кожна дія `afterCommit` виконується й після помилки попередньої, помилка кожної — у `log`. Транзакція команди — кроки 1–8 §6.5; черга — Р-A3-15; вхід — `structuredClone` на спробу; крок 2 §6.5 — один оператор `SELECT set_config('request.jwt.claims', $1, true), set_config('TimeZone', 'UTC', true), set_config('bytea_output', 'hex', true)`; контекст фази — `JSON.stringify` значення типу `CommandContext` з T0 `{ action: operations[op].context, object: kindLabel, root: id }`; операції немає в `operations` каталогу — `command.invalid` без звернення до порту; `decodeRow` фаз — до `COMMIT`; помилка самого `ROLLBACK` — `release(true)`; `ROLLBACK` у відповідь на `COMMIT` — `command.internal` з `log`; відмова `SET LOCAL ROLE simetra_command` під час створення рантайму — `command.internal` з `log`; виклик — `SELECT "<schema>"."<fn>"($1::jsonb, $2::bigint) AS r` (`mark_deletion` — `($1::uuid, $2::bigint, $3::boolean)`, `delete` — `($1::uuid, $2::bigint)`); тег `COMMIT` у відповіді — інакше помилка; набір змін — з рядка результату (`scope` — колонка скоупу, у кореня — id).

- [x] **Крок 1:** unit `runtime`: `command.model-mismatch` з `hashes`; `command.read-role-missing` з `role`; `readFallback` знімає відмову; `readRoleOf` на підставлених таблицях (`["user"]` — роль, `[]` — `undefined`); невідомий об'єкт і ключ модуля — відмова; `42883` на хеші — `command.model-mismatch` з `applied: null`.
- [x] **Крок 2:** unit `transaction`: точна послідовність для `create` і пакета з двох фаз; `create` на довіднику прав ставить контекст `administerRights` і версію `NULL`; кожна недійсна операція (Задача 2) — `command.invalid` без звернення до порту; `command.unauthenticated` без жодної фази й без виклику хука; `40001` і `40P01` → повтор з кроку 1 на клоні входу, третя невдала спроба — `command.retry-exhausted`; `ROLLBACK` у відповідь на `COMMIT` — помилка; `maps connect failure and logs the original error`, `destroys a lost connection` (Review Focus 4); `release` рівно раз у кожному шляху; `rows` — по одному на операцію входу; після першої помилки бази порт не отримує жодного оператора, крім `ROLLBACK`.
- [x] **Крок 3:** FAIL → реалізувати → PASS; `typecheck`, `lint`.
- [x] **Крок 4: коміт** — `feat(server): createCommandRuntime і транзакція команди`.

### Задача 9: хуки, контекст хука, `afterCommit`

**Files:**
- Modify: `packages/simetra/src/server/phase.ts`, `packages/simetra/src/server/transaction.ts`
- Test: `packages/simetra/src/server/__tests__/hooks.test.ts`

Правила: `beforeWrite` — до пари «контекст + ядро», `onWrite` — після неї, лише коли `OPERATION_EVENTS[op] === "write"`; аргумент — один об'єкт; `additionalProperties` — новий `Map` на фазу; `ctx` — за Р-A3-15; `ctx.run` — вкладена фаза зі своїм контекстом, хуками й глибиною (`command.depth` після `maxDepth`); `ctx.read` — `buildReadStatement` у транзакції команди під `simetra_command`; `ctx.reject` → `command.rejected` з `reason` і `path`; `ctx.afterCommit` — черга спроби; після `COMMIT` і `release()` — `defer(chain)` або очікування до повернення, поза сховищем ALS; `run` чи `read` будь-якого екземпляра рантайму в асинхронному контексті команди — `command.nested`.

- [x] **Крок 1:** тести:
  контекст фази ставиться після `beforeWrite`, а фаза `ctx.run` з хука «до» ставить свій контекст раніше (інваріант 3);
  `revalidates the draft returned by beforeWrite` (Review Focus 1); чернетка `markDeletion` з `values` — `command.invalid`;
  `maps a thrown hook error to command.internal` (Review Focus 2); `beforeWrite` повертає не об'єкт (`undefined`) — `command.internal` з `log`;
  хук, що перехопив відмову `ctx.run`, — команда падає з кодом цієї відмови, `afterCommit` не виконується; після перехопленої відмови новий `ctx.run` не йде в порт;
  хук перехопив `40001` з `ctx.run` — повтор;
  вкладений `onWrite` кидає `ctx.reject`, зовнішній `beforeWrite` перехоплює відмову `ctx.run` — `command.rejected`, `ROLLBACK`, жодного `COMMIT`; те саме для `ctx.run`, якого хук не чекав (Р-A3-15; погоджено архітекторкою як fail-closed);
  рекурсія `ctx.run` через захоплений кореневий `ctx` — `command.depth` на `maxDepth` за глибиною з ALS;
  `runtime.run` з продовження, запланованого хуком після завершення команди, — не `command.nested`;
  хук не чекає `ctx.run` — T3 чекає його до наступного кроку;
  `Promise.all` двох `ctx.run`, де кожен `beforeWrite` сам чекає `ctx.read`, — команда завершується, кожен виклик ядра стоїть одразу після свого `set_config` (мутація «черга без пари» червоніє);
  `ctx`, збережений хуком і викликаний після його завершення чи з іншої команди, — `command.internal`;
  `ctx.run` з `afterCommit` — `command.internal` у `log`; відхилений виклик `ctx`, якого ніхто не чекав, не дає unhandled rejection — лише запис у `log`;
  `additionalProperties` спільні для `beforeWrite` і `onWrite` однієї фази, порожні у фазі `ctx.run` і на повторі, набір змін і `afterCommit` невдалої спроби відкидаються (інваріант 16; мутація «не очищати на повторі» червоніє);
  `ctx.action`, `ctx.isNew`, `ctx.id`, `ctx.mark` для `create`, `update`, `markDeletion`; хуки не викликаються на `delete`;
  зміна `row` у `onWrite` не змінює `rows` результату;
  послідовність `ctx.read` у транзакції команди;
  `afterCommit` через `defer` і без нього; `keeps the result when defer throws` (Review Focus 3);
  `command.nested` для `run` і `read` того самого й іншого екземпляра; `afterCommit`, що запускає нову команду, не дає `command.nested`;
  `command.depth`; ключі `ctx` — рівно ті, що в `HookContext` (інваріант 6; мутація «дати хуку клієнта» червоніє); `changes` містять фази `ctx.run`.
- [x] **Крок 2:** FAIL → реалізувати → PASS.
- [x] **Крок 3: коміт** — `feat(server): хуки beforeWrite і onWrite, контекст хука, afterCommit`.

### Задача 10: серверне читання

**Files:**
- Modify: `packages/simetra/src/server/runtime.ts`, `packages/simetra/src/server/read.ts`
- Test: `packages/simetra/src/server/__tests__/read-runtime.test.ts`

**Interfaces — Produces:** `CommandRuntime.read(session: SessionClaims, query: ReadQuery): Promise<Record<string, unknown>[]>`.

Правила: `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY` → claims → `SET LOCAL ROLE <readRoleOf(provider)>` → оператор будівника → `COMMIT`; запасний шлях — `SET LOCAL ROLE simetra_command` першим оператором після claims, без `simetra.command`; профіль без ролі запиту (`readRoleOf` → `undefined`) читає запасним шляхом автоматично (§6.11); claims, `TimeZone` і `bytea_output` — тим самим оператором, що в команді; результат — `decodeRow`.

- [x] **Крок 1:** тести послідовності для обох шляхів; `limit` понад 200 — `command.invalid` до бази; `release` рівно раз.
- [x] **Крок 2:** FAIL → реалізувати → PASS.
- [x] **Крок 3: коміт** — `feat(server): серверне читання під роллю запиту профілю`.

### Задача 11: лінт-зони, джерела й пакування

**Files:**
- Modify: `packages/simetra/eslint.tier-zones.js`, `packages/simetra/test/tier-boundary.test.ts`, `packages/simetra/tsdown.config.ts` (`entry` + `server/index`), `packages/simetra/package.json` (`publishConfig.exports["./server"]`), `packages/designer/test/packaging/published-packages.pack.test.ts`
- Create: `packages/simetra/test/server-sources.test.ts`

- [x] **Крок 1:** негативні тести: `src/data` і `src/ui` → `simetra/server` і `../server/x` — відмова; `src/server` → `simetra/compiler`, `simetra/schema`, `../compiler/x`, `../schema/x`, `../model/x`, `node:fs`, `pg` — відмова; `./x`, `node:async_hooks`, `zod`, `simetra/model` — дозволено. Тест «allows lower tiers» виключає лише пари `data|ui → server` (обмеження `src/server` — у правилі `@typescript-eslint/…`, яке `restricted()` не читає).
- [x] **Крок 2:** `server-sources.test.ts`: рядкові літерали коду `src/server` поза `__tests__` не дорівнюють жодному значенню `PROVIDER_API_ROLES`, `PROVIDER_LOGIN_ROLES` і `DATABASE_PROVIDERS` (перелік виводиться з T0); код без коментарів не містить `process.env` (інваріанти 14, 15).
- [x] **Крок 3:** пакування: `./server` у переліку `exports`, `dist/server/index.js` і `.d.ts` у tarball, регекс самодостатності з `server`, `import("simetra/server")` у скрипті Node.
- [ ] **Крок 4:** FAIL → реалізувати → `pnpm --filter simetra test tier-boundary server-sources`, `lint`; `pnpm build:packages && pnpm test:packaging` — PASS. (Scoped тести й `lint` — зелені; `build:package` simetra — зібрано; `test:packaging` — у прогоні повних гейтів за дозволом архітекторки.)
- [x] **Крок 5: коміт** — `build(simetra): зона й публікація simetra/server`.

### Задача 12: DB-тести рантайму

**Files:**
- Create: `packages/designer/src/__tests__/command-runtime.db.test.ts`
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` — будівник `runtimeValuesLayer()`: окремий скоуплений довідник з `Numeric(30,10)`, `BigInt`, `Json`, `Bytes`, посиланням на перерахування (ім'я ≠ мітка), поліморфним `Ref`, масивом і ТЧ (наявні фікстури A2 не змінюються)
- Modify: `packages/designer/src/__tests__/support/db.ts` — `withRuntimeLogin(url, memberOf, fn)` (тегована роль входу з паролем під `testSuperuserUrl()`, членства з `memberOf` `WITH INHERIT FALSE, SET TRUE` — обидві ролі для основних кейсів, лише `simetra_command` для `command.read-role-missing`; видалення й на помилці) і `seedMarker(client, hash)` (мінімальний `INSERT` у `simetra.marker` з усіма `NOT NULL` колонками `renderApplyState`, `snapshot_hash = hash`)

Ціль: `const desired = await desiredForApply(model); inTarget(desired.sql, desired.scope, …)`; засів — `seedMarker` і закомічені рядки фікстури A2 з рядком чужого тенанта; роль входу — після розгортання тіні; рантайм — `fromPgPool(new pg.Pool({ connectionString: <URL ролі> }))`, каталог — `buildRuntimeCatalog(model)`, модуль — `defineObjectModule` з `beforeWrite`, що через `ctx.run` пише рядок іншого довідника.

- [x] **Крок 1:** кейси (причина кожного — RLS, замки чи стан сесії вирішує Postgres):
  `create` → `update` з версією → `markDeletion` довідника `runtimeValuesLayer()`: `Numeric` на 20 цифр, `BigInt` понад 2^53, `Json` об'єктом, масив, перерахування за ім'ям, поліморфна пара, ТЧ; реквізити шапки й версія результату збігаються з `runtime.read` (інваріант 13);
  `update` чужого й відсутнього рядка — та сама відмова `no-right` (інваріант 4);
  модуль з `beforeWrite` і `ctx.run`: обидва рядки записано, контекст зовнішньої фази — свій (інваріант 3);
  хук, що перехопив відмову `ctx.run`, — команда падає з її кодом, `afterCommit` не виконується, нічого не записано (§7.2);
  успішний пакет з двох фаз на різних рядках; пакет, друга фаза падає з `command.forbidden`, — код саме цей, нічого не записано;
  claims без користувача — `command.unauthenticated`, жодного запису й жодного виклику хука (інваріант 5);
  `runtime.read` ≡ `SELECT` під `SET LOCAL ROLE authenticated` з тими самими claims, рядок чужого тенанта не видно; рантайм з `readFallback: true` читає те саме (інваріант 10);
  `createCommandRuntime` на базі з іншим хешем — `command.model-mismatch`; роль входу без членства в `authenticated` — `command.read-role-missing`;
  через пулер (форма з Задачі 0) — той самий `current_user_id()` і ті самі відмови; наступна транзакція на тому самому з'єднанні не бачить ролі й claims команди (інваріант 7).
- [x] **Крок 2:** прогін на закоміченому дереві: `pnpm --filter @simetrajs/designer test:db command-runtime` — PASS; мутації (лише прямий порт, крім останньої): прибрати `SET LOCAL ROLE`, поставити контекст до `beforeWrite`, поставити контекст один раз на пакет, читати з claims іншого користувача, прибрати `::text` у текстових колонках, `SET` без `LOCAL` (пулер) — кожна червоніє (журнал).
- [x] **Крок 3: коміт** — `test(designer): рантайм команд над тінню через пул і пулер`.

### Задача 13: документи

- [x] **Крок 1:** спека П4: §6.3 — форма каталогу (Р-A3-5); §6.4 — операція (Р-A3-1, Р-A3-17, з реченням про перейменування й UUID), помилка (Р-A3-8) і речення «`bigint` — in-process API T3; формат передачі клієнтові — П4-B» (Р-A3-7); §6.5 — абзац «Помилка будь-якого кроку»: термінальна будь-яка відмова фази (Р-A3-15), крок 2 — claims, `TimeZone` = `UTC` і `bytea_output` = `hex` одним оператором (Р-A3-7); §6.6 — результат `<t>_delete` зі скоупом (Р-A3-14); Рт20 і §6.9 — `OPERATION_EVENTS`, «події видалення прийдуть разом із видаленням позначених» (Р-A3-2), час життя `ctx` (Р-A3-15); Рт21 і §6.9 — `ctx.action` як операція, `ctx.mark` (Р-A3-18); §6.10 — `23503` у `command.invalid` (Р-A3-13) і відмова RLS (Р-A3-19); §6.12 — операції адміністрування з полем `action` операції; §7.1 — рядки DB (Р-A3-9); Додаток А — рядки A3 позначити внесеними.
- [x] **Крок 2:** спека П2 (`docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md`), абзац «Кодоген»: `BigInt` → `bigint`, стандартна колонка версії → `number` (Р-A3-7); спека прав §5.3 — «API хуків П4» → посилання на §6.9 спеки П4; спека системної схеми §3 — `applied_snapshot_hash()` і правило грантів Р-A3-16.
- [x] **Крок 3:** борг прав §1 — зняти пункт «Самоприйняття членства…» з посиланням на Рт6 і §6.9 спеки П4.
- [x] **Крок 4:** ROADMAP — рядок «Ранній зріз П4»: A3 виконано. Скіл `packages/designer/skills/simetra-metadata/` — короткий розділ про модуль об'єкта: ключі `beforeWrite`/`onWrite`, правило без зовнішнього I/O, `afterCommit`, посилання на §6.9.
- [x] **Крок 5:** `python3 scripts/check-doc-anchors.py` — зелений.
- [x] **Крок 6: коміт** — `docs(spec): П4-A3 — рантайм команд у спеках і скілі`.

### Задача 14: перевірка й звіт

- [x] **Крок 1:** рев'ю гілки за скілом `code-review` (лінзи correctness, test-honesty, drift, architecture), кожна знахідка — через `code-review-verifier`.
- [x] **Крок 2:** контрольна точка архітекторці: SHA, журнал мутацій, час DB-прогонів.
- [ ] **Крок 3:** після «можна»: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`, `pnpm build:packages && pnpm test:packaging` — на одному SHA.

## Журнал мутацій

| Задача | Що прибрано | Що почервоніло |
| --- | --- | --- |
| T1 | літерали `command.forbidden`/`effect` повернуто в key-units | core-error-source |
| T1 | літерал `hierarchy.isolation` повернуто в hierarchy-units | core-error-source |
| T1 | звужено регекс `^bigint` у `core.ts` | runtime-core (3: numeric(12,2), numeric, numeric[]) |
| T2 | strict: гілка `create` — `z.object` замість `z.strictObject` | operationSchema: rejects create with expectedVersion; rejects an unknown key |
| T2 | дискримінатор `action: z.literal("create")` → `z.string()` | operationSchema: accepts/rejects (усі кейси union) |
| T2 | `update.expectedVersion` → `.optional()` | operationSchema: rejects update without expectedVersion |
| T2 | `markDeletion.mark` → `.optional()` | operationSchema: rejects markDeletion without mark |
| T2 | `rowIdSchema`: `z.guid()` → `z.string()` | rejects a non-UUID id |
| T2 | `rowIdSchema`: `z.guid()` → `z.uuid()` | accepts create |
| T2 | `expectedVersion`: прибрано `.min(1)` | rejects a zero expectedVersion |
| T2 | `batchSchema`: прибрано `.min(1)` | batchSchema: rejects an empty batch |
| T2 | `OPERATION_EVENTS.delete` → `"write"` | object module: delete raises no module event |
| T2 | limit: прибрано `.max(READ_LIMIT_MAX)` | readQuerySchema: limit 201 as false |
| T2 | limit: прибрано `.min(1)` | readQuerySchema: limit 0 as false |
| T2 | `sub`: прибрано `.min(1)` | sessionClaimsSchema: rejects an empty sub |
| T2 | `looseObject` → `object` | sessionClaimsSchema: keeps extra claims |
| T2 | castType-регекс: прибрано `^` | castTypeSchema: `"pub"lic"."X"` as false |
| T2 | castType-регекс: прибрано `$` | castTypeSchema: text or true; numeric(12,2) as false |
| T2 | castType-регекс: `[^"]+` → `[^]+` | castTypeSchema: `"pub"lic"."X"` as false |
| T2 | `CAST_TYPES` + `"character"` | castTypeSchema: character as false |
| T2 | `format: z.literal(1)` → `z.int()` | runtimeCatalogSchema: rejects format 2 |
| T2 | `defineObjectModule` повертає копію `{ ...module }` | defineObjectModule returns the module itself |
| T2 | `ObjectModule.onWrite` — властивість-функція замість методу | typecheck TS2322 (a typed module fits the module map) |
| T2 (fix) | `expectedVersion`: `z.int()` → `z.number().min(1)` | operationSchema: rejects an unsafe expectedVersion |
| T2 (fix) | readQuery `id`: `z.guid()` → `z.uuid()` | readQuerySchema: parses id 00000000-…-0001 as true |
| T2 (fix) | readQuery `after`: `z.guid()` → `z.uuid()` | readQuerySchema: parses after … as true |
| T2 (fix) | runtimeAttributeSchema: `strictObject` → `object` | runtimeAttributeSchema: parses an unknown key as false |
| T2 (fix) | runtimeAttributeSchema: прибрано `.min(0)` у `scale` | runtimeAttributeSchema: parses a negative scale as false |
| T3 | скоуп прибрано з `RETURN` `<t>_delete` (U0) | catalog-command-mark: `<t>_delete` ключ, версія й скоуп |
| T3 | (DB) скоуп прибрано з `RETURN` (D1) | catalog-command-admin: delete of an assignment returns the scope |
| T3 | `catalogCommands: []` у моделі (U1) | runtime-catalog: is the set the core SQL is generated from |
| T3 | `catalogCommands` додано в `canonicalSnapshot` (U2) | runtime-catalog: stays outside the canonical snapshot and the hash |
| T3 | `TS_OF_LOGICAL.BigInt` → `"string"` (M1) | codegen: numeric is a string, bigint a bigint |
| T3 | прибрано гілку версії → `number` (M2) | codegen: 8 тестів (catalog interface…, scoped object…) |
| T3 | ключ не виключено з `attributes` (M3) | runtime-catalog: keeps the key and the version out of attributes |
| T3 | `update` завжди `true` (M4) | runtime-catalog: insert and update flags follow the grant keys |
| T3 | `required` без умови `insert` (M5) | runtime-catalog: insert and update flags (скоуп рядка ТЧ) |
| T3 | `create` без умови `actions.create` (M6) | runtime-catalog: operations come from the contract functions |
| T3 | без операції `delete` (M7) | runtime-catalog: operations come from … |
| T3 | без `enumValues` (M8) | runtime-catalog: value facts |
| T3 | без `pair` (M9) | runtime-catalog: value facts |
| T3 | без унікальних індексів (M10) | runtime-catalog: constraints |
| T3 | typmod не знімається (M11) | runtime-catalog: beforeAll (no cast type for character varying(9)) |
| T3 | ключ-одинак не пропускається в `entityFields` (M12) | codegen: constant exposes only its value; degenerate register hides singleton key |
| T3 | об'єкти в порядку контрактів, не `model.objects` (M13) | runtime-catalog: lists exactly the catalogs … in model order |
| T4 | прибрано артефакт з переліку компіляції | designer: compileArtifacts…; --out writes… |
| T4 | прибрано `\n` в артефакті | designer: compileArtifacts… (перевірка вмісту) |
| T5 | `executeGrants(sig, [], …)` без GRANT ролі команд (M1) | DB: returns the recorded hash to the command role ×2; unit: leaves schema grants; grants nothing on state tables |
| T5 | прибрано `SECURITY DEFINER` (M2) | DB: returns the recorded hash to the command role ×2 |
| T5 | `EXECUTE` ще й для `authenticated` (M3) | DB: refuses the API role ×2 |
| T5 | `state` не враховує функцію (M4) | unit: sees the state as present when only the function is left |
| T5 | `owns` не визнає одиниць гранту функції (M5) | unit: owns the function, its ACL and its grant units |
| T5 | `owns` не визнає саму функцію (M6) | unit: owns the function, its ACL and its grant units |
| T5 | функція рендериться перед marker (M7) | unit: reads the applied snapshot hash through a definer function |
| T5 (fix) | у `planPlatformFunctions` прибрано сигнатуру функції стану (F1) | unit: adds the apply state function to the platform functions; DB designer: fails when plpgsql_check cannot be taken |
| T5 (fix) | `state` вимагає `schemaAbsent` і за наявного шару (F3) | unit: does not need the schema to be absent when the platform layer owns it |
| T6 | `Numeric` приймає число JS (M1) | rejects lossy and invalid values: amount 1.5; encodeParam applies the same value rules |
| T6 | `precision`/`scale` не передаються (M2) | amount 1.12345678901; amount 123456789012345678901 |
| T6 | `DateTime` без зсуву приймається (M3) | at 2026-10-31T10:00:00 |
| T6 | `Integer` без `isWithinType` (M4) | count NaN/Infinity/1.5/2147483648; encodeItem rejects an invalid value |
| T6 | `Json` приймає нескінченне число (M5) | payload `{ a: NaN }` |
| T6 | `Json` без перевірки простого об'єкта (M6) | payload Map; payload Date |
| T6 | `Json` приймає `bigint` (M7) | payload 1n |
| T6 | `undefined` реквізиту мовчки пропускається (M8) | encodeItem rejects undefined in values / in a row |
| T6 | ключ таблиці дозволено у `values` (M9) | encodeItem rejects the table key in values |
| T6 | гранти `insert \|\| update` (M10) | rejects a key outside update; scope is insert-only |
| T6 | рядок ТЧ за ключами `update` (M11) | accepts an insert-only attribute of a new row on update |
| T6 | невідоме значення перерахування проходить (M12) | status Pending; status open |
| T6 | версія `Number.isInteger` замість `isSafeInteger` (M13) | decodeRow: a version beyond a safe integer is command.internal |
| T6 | `maxLength` не передається (M14) | code abcd; the scope is insert-only and the length counts characters |
| T6 | `BigInt` приймає число JS (M15) | big: 1 |
| T6 | невідома мітка на виході віддається як є (M16) | decodeRow: an unknown enumeration label is command.internal |
| T6 | `Json`/масив дозволено в `where` (M17) | encodeParam rejects Json and arrays in where |
| T6 | `name` у запиті pg (M18) | fromPgPool: passes text and values without a statement name |
| T6 | клас 08 не вважається обривом (M19) | normalizeError: connectionLost for class 08 |
| T6 | мережевий `code` вважається SQLSTATE (M20) | normalizeError: connectionLost for a Node network code |
| T6 | (DB) `hint` не копіюється (D1) | command-port.db: RAISE … HINT reaches normalizeError |
| T6 | (DB) `BigInt` декодується через `Number` (D2) | command-port.db: a core row decodes the same with parsers |
| T6 (fix 1) | `at()` пропускає сирий виняток (F1) | 10 кейсів «a draft that cannot be read» |
| T6 (fix 1) | старий порядок: окремий прохід «поза грантом» (F2) | reports the first error in catalog order (×2) |
| T6 (fix 1) | перевірку гранту прибрано (F2') | rejects a key outside insert/update; an unknown key last; scope is insert-only |
| T6 (fix 1) | `String(error)` без захисту (F3) | normalizeError: never throws, whatever was thrown |
| T6 (fix 1) | `storable` завжди true (F4) | 9 кейсів (`a\0`, `x\uDC00`, `\uDBFF`, applies the same value rules…) |
| T6 (fix 1) | без перевірки `\u0000` (F5) | code/note/payload з `\0`; ключ `Json` з `\0` |
| T6 (fix 1) | (DB) порт без `types: RAW_TYPES` (D3) | command-port.db: a core row decodes the same with custom type parsers |
| T6 (fix 2) | у `encodeItemValue` прибрано `catch` | 4 нові кейси «inside a value» і rejects a value that cannot be read |
| T7 | прибрано `connectionLost` | errors: a lost connection is command.unavailable whatever the code |
| T7 | перелік context → `detail !== undefined` | command.context outside the allowed T0 values; 42501 {message: command.context} |
| T7 | перелік forbidden прибрано | command.forbidden outside the allowed T0 values ×2; 42501 {message: command.forbidden} |
| T7 | перелік conflict прибрано | command.conflict outside the allowed T0 values |
| T7 | перевірку HINT → `true` | command.conflict outside … ×2 |
| T7 | прибрано `Number.isSafeInteger` | command.conflict outside … (9007199254740992) |
| T7 | `operation` у rls прибрано | a write refused by RLS is command.forbidden rls with the phase |
| T7 | неоднозначний `TABLE` → `all[0]` | an RLS refusal on COMMIT with an ambiguous table names no object |
| T7 | об'єкт з `TABLE` на COMMIT прибрано | an RLS refusal on COMMIT names the object of a main/section table |
| T7 | `unknown` → сирий `detail` | 22023 DETAIL missing_col…; tabular.mirror_lines… |
| T7 | колонку основної таблиці прибрано | 22023 DETAIL code_col/subject_type/subject_col |
| T7 | `typeColumn` пари прибрано | 22023 DETAIL subject_type; 23502 on sample.subject_type |
| T7 | шлях ключа прибрано | 22023 DETAIL id; tabular.sample_lines.id |
| T7 | префікс ТЧ прибрано | 22023 DETAIL tabular.sample_lines ×3 |
| T7 | перевірку виду FK прибрано | 23503 non-FK constraint sample_code_key is command.internal |
| T7 | перевірку виду unique/check прибрано | another kind (sample_count_check); (sample_code_key) |
| T7 | дедуплікацію прибрано | 23505 on sample by sample_subject_key is command.constraint |
| T7 | пріоритет таблиць фази прибрано | 23503 on sample; 23502 on sample.code_col… (×6) |
| T7 | `22P02` поза читанням | 22P02 in a write is command.internal |
| T7 | `22023` поза фазою | 22023 command.invalid outside a phase is command.internal |
| T7 (read.ts) | `::text[]` → `::text` | reads one row by id; reads a page without a filter; filters by… |
| T7 (read.ts) | невідомий реквізит пропускається | an unknown attribute…; the key name… |
| T7 (read.ts) | помилку `encodePair` прибрано | an unknown pair target… |
| T7 (read.ts) | помилку `encodeParam` прибрано | a value of another type…; a Json attribute…; an array attribute… |
| T7 (read.ts) | `IS NULL` прибрано | filters by…; a null pair is two IS NULL |
| T7 (read.ts) | `after` прибрано | filters by… |
| T7 (read.ts) | `limit` → 200 | filters by…; a null pair…; does not truncate… |
| T7 (read.ts) | рівність `typeColumn` пари прибрано | filters by…; a null pair… |
| T7 (read.ts) | приведення за `pgType` замість `castType` | does not truncate where parameters; filters by… |
| T7 (read.ts) | порожній `WHERE` | reads a page without a filter |
| T7 (fix 1) | прибрано `lastFullAccess` з T0 | command.forbidden keeps the allowed reason last-full-access |
| T7 (fix 1) | `refusal(COMMAND_CORE_ERRORS.forbidden.escalation)` → літерал | takes every refusal reason from simetra/model, not from a literal |
| T7 (fix 2) | прибрано перевірку `message` у conflict | command.conflict outside the allowed T0 values (P0001 app.error) |
| T7 (fix 2) | прибрано перевірку `message` у invalid | command.invalid outside … (22023 app.error) |
| T7 (fix 2) | прибрано перевірку `message` у context | 16 тестів (forbidden keeps the allowed reason…; 42501 with a foreign message…) |
| T7 (fix 2) | прибрано перевірку `message` у forbidden | 8 тестів (a write refused by RLS…; an RLS refusal in a read…) |
| T7 (fix 2) | `VERSION_TEXT` → `^[+-]?\d+$` | command.conflict outside … (-5, +7, 0) |
| T7 (fix 2) | `22P02` за будь-якої фази | 22P02 in a write is command.internal |
| T7 (fix 2) | `operation` у rls прибрано | a write refused by RLS…; два 42501 with a foreign message… |
| T8 | прибрано `SET LOCAL ROLE` у транзакції (M1) | 10 тестів, зокрема runs a create as the exact statement sequence |
| T8 | контекст лише в першій фазі пакета (M2) | runs a batch of two phases with one row per operation |
| T8 | не закривати чергу після першої помилки (M3) | closes at the first failure: later units never reach the port |
| T8 | `release` двічі / жодного разу (M4a/b) | 7 тестів послідовності |
| T8 | знімок входу без `structuredClone` (M5) | retries 40001/40P01 from step 1 on a copy of the input |
| T8 | `COMMIT` без перевірки тегу (M6) | fails when COMMIT answers ROLLBACK |
| T8 | без перевірки `current_user_id` (M7) | rejects without a user before any phase or hook |
| T8 | `40P01` без повтору (M8) | retries 40P01 from step 1 on a copy of the input |
| T8 | обрив без `release(true)` (M9) | destroys a lost connection |
| T8 | збій `ROLLBACK` без знищення з'єднання (M10) | destroys the connection when ROLLBACK fails |
| T8 | без `log` для `command.internal` бази (M11) | sends only ROLLBACK after the first database error |
| T8 | без перевірки до транзакції (M12) | 21 тест, зокрема rejects create with expectedVersion before the port |
| T8 | операція поза `operations` каталогу (M13) | rejects an operation the catalog lacks before the port |
| T8 | без звірки хешу (M14) | rejects another applied hash with both hashes; rejects no marker |
| T8 | `42883`/`3F000` як `internal` (M15) | rejects no hash function (42883); no platform schema (3F000) |
| T8 | `readFallback` ігнорується (M16) | lets readFallback replace the missing membership |
| T8 | без перевірки членства (M17) | rejects a missing request role membership with the role |
| T8 | ключ модуля поза `OBJECT_MODULE_KEYS` (M18) | rejects a key outside OBJECT_MODULE_KEYS before the database |
| T8 | невідомий об'єкт модуля (M19) | rejects an unknown object before the database |
| T8 | відмова `SET ROLE` при створенні без `log` (M20) | maps a refused SET LOCAL ROLE to command.internal and logs it |
| T8 | `create` з версією замість `NULL` (M21) | 6 тестів, зокрема sets administerRights and a NULL version |
| T8 | `afterCommit` зупиняється на першій помилці (M22) | runs every action even after a failing one and logs each failure |
| T8 | набір змін без `scope` (M23) | runs a create as the exact statement sequence |
| T8 (fix) | `anomaly` без `log` (F1a) | decodes the row before COMMIT and logs (×2); logs an unexpected exception |
| T8 (fix) | виняток через `abort` без журналу (F1b) | logs an unexpected exception as command.internal |
| T8 (fix) | `maxAttempts` без перевірки (F2a) | rejects maxAttempts = 0; = 1.5 |
| T8 (fix) | `maxDepth` без перевірки (F2b) | rejects maxDepth = 0 before the database |
| T8 (fix) | `42704` не обробляється (F3) | treats a request role absent from the database (42704) as missing |
| T8 (fix) | набір змін спільний для спроб (F5a) | drops the rows and changes of a failed attempt (+3) |
| T8 (fix) | `40001` на `COMMIT` без повтору (F5b) | retries a 40001 on COMMIT |
| T8 (fix) | скоуп кореня не береться з ключа (F5c) | puts the row id as the scope of a scope root |
| T9 | «черга без пари» — контекст і ядро окремі (M1) | keeps each core call right after its context under Promise.all |
| T9 | не очищати на повторі, спільний `Map` (M2) | shares additionalProperties within a phase only; a retry drops the failed attempt |
| T9 | `database` у `ctx` (M3) | gives action, isNew, id and mark on create/update/markDeletion |
| T9 | контекст до `beforeWrite` (M4) | 25 тестів (sets the phase context after beforeWrite…; Promise.all…) |
| T9 | прибрати звірку ALS у методах `ctx` (M5) | rejects a ctx of a running hook used from another command |
| T9 | `ctx.reject` без закриття черги (M6a) | fails closed … awaited/not awaited; fails with a ctx.run rejection the hook caught |
| T9 | `command.nested` без закриття черги (M6b) | rejects run of the same/another runtime inside a hook |
| T9 | прибрати очікування невичеканих `ctx` (M7) | waits for a ctx.run the hook did not await |
| T9 | `database`-гілка: без `log` винятку хука (M11) | maps a thrown hook error to command.internal (обидва) |
| T9 | без `structuredClone` на спробу (M8) | gives each attempt the original input after a hook changed it |
| T9 | глибина не з ALS, `depth = 1` (M9) | counts depth from the async context; gives command.depth past maxDepth |
| T9 | без повторної перевірки чернетки (M10) | 13 тестів (revalidates…, markDeletion, non-object, passes the draft…) |
| T9 | виняток `defer` не перехоплено (M12) | keeps the result when defer throws |
| T9 | `onWrite` без копії рядка (M13) | keeps the result row when onWrite changes its row |
| T9 | ознаку «команда активна» не знято (M14a) | allows run from a continuation scheduled by a hook after the command |
| T9 | без `promise.catch` у `track` (M15) | rejects a ctx kept past its hook (unhandledRejection) |
| T9 | хуки і на `delete` (M16) | does not call hooks on delete |
| T9 | без `rejectNested` (M17) | rejects run of the same/another runtime… |
| T9 | чернетка `markDeletion` приймає ключі (M18) | rejects a markDeletion draft with values/tabularSections/mark |
| T9 | без перевірки «чернетка — об'єкт» (M19) | fails with command.internal when beforeWrite returns undefined / an array |
| T9 (fix) | `misuse` не закриває чергу (F1) | fails the command when a hook continuation calls ctx…; fails a batch whose second hook uses the ctx kept… |
| T9 (fix) | без `if (tx.terminal) throw` після хука (F2, = M6c) | stops a batch when onWrite caught a ctx.run rejection; does not check the draft after beforeWrite caught a rejection |
| T9 (fix) | виняток читання чернетки минає `try` у `checkDraft` (F3) | maps a draft with a prototype trap / an own-keys trap |
| T9 (fix) | `log` host-а без обгортки (F4) | releases once and keeps the code when the host log throws |
| T10 | прибрано `SET LOCAL ROLE` (M1) | 10 тестів послідовностей (reads under the request role of the profile…) |
| T10 | запасний шлях ставить `simetra.command` замість ролі команд (M2) | reads through the fallback path under readFallback (×2) |
| T10 | прибрано `rejectNested()` (M3) | rejects read of the same/another runtime inside a hook |
| T10 | `release` двічі (M4) | 6 тестів успішного шляху |
| T10 | `limit` без перевірки (M5) | rejects a limit over 200 as command.invalid before the database |
| T10 | прибрано перевірку `sub` (M6) | rejects a session without sub / with an empty sub |
| T10 | `readFallback` діє і за членства (M7) | keeps the request role when readFallback is set but the membership exists |
| T10 | фаза читання прибрана (M8) | maps 22P02 of the read to command.invalid without logging |
| T10 | журнал `internal` прибрано (M9) | maps an unknown database error to command.internal and logs it |
| T10 | тег `COMMIT` не перевіряється (M10) | fails a COMMIT answered ROLLBACK as command.internal and logs it |
| T11 | регекс сервера зі стороннім дозволом `\.\./` | server-sources: server imports only local files, model, zod and async_hooks |
| T11 | файл `src/server/zz-mut.ts` з імпортом `../model/x` | eslint: T3 purity (A3-10) |
| T11 | літерал `"authenticated"` у файлі `src/server` | server-sources: names no provider or provider role in string literals |
| T11 | `process.env` у файлі `src/server` | server-sources: does not read process.env |
| T11 | `tierPattern(["server"])` → неіснуючий ярус | data and ui do not import server |
| T12 | прибрано `await tx.enqueue([COMMAND_ROLE])` у транзакції (M1) | 9 DB-тестів (create → update → markDeletion…; обидва кейси пулера) |
| T12 | контекст фази окремим оператором до `beforeWrite` (M2) | beforeWrite with ctx.run writes both rows, each under its own phase context |
| T12 | контекст лише першій фазі транзакції (M3) | beforeWrite with ctx.run…; a batch of two phases on different rows; second phase is forbidden |
| T12 | читання ставить claims іншого користувача (M4) | create → update → markDeletion…; runtime.read sees what a SELECT sees; через пулер |
| T12 | прибрано `::text`/`::text[]` у проєкції читання (M5) | create → update → markDeletion…; runtime.read sees what a SELECT… |
| T12 | `SET ROLE` без `LOCAL` (M6, пулер) | through the pooler: the next transaction sees neither the role nor the claims |
| T12 | claims через `set_config(…, false)` (M6b, пулер) | той самий тест інваріанта 7 |
| T12 | прибрано перевірку `user == null → command.unauthenticated` (M7) | claims without a user…; through the pooler: the same refusals |
| T12 (unit) | `maxLength` не пишеться в каталог | value facts: length…; a custom String attribute has maxLength |
| T12 (unit) | `scale` не пишеться в каталог | value facts…; Numeric(30,10), BigInt, Json, Bytes…; custom String attribute (`qty` ТЧ) |
| T12 (unit) | мітка перерахування = логічне ім'я | value facts…; an enumeration reference carries names and labels |
| Parked | `readRows.fail` мапить 40001/40P01 у `command.retry-exhausted` | обидва кейси нового тесту (40001, 40P01) |
| Parked | `checkDraft`: читання `draft[key]` винесено з `try` | новий тест; an own-keys trap |
| Після контрольної точки | `PgEnum` повернуто в `castTypeOf` | runtime-catalog: каталог без PgEnum |
| Після контрольної точки | `planPlatformFunctions` → `platformFunctionSignatures` у `lockPlan` | plan.test: функція стану серед функцій плану |
| Після контрольної точки | прибрано лог помилки без SQLSTATE | transaction/runtime/read-runtime: logs the original error |
| Після контрольної точки | літерал причини `invalid` у генераторі (`"'p_item'"`, `sqlLiteral("create")`, `tabular.`) | core-error-source |
| Після контрольної точки | прибрано причину з `COMMAND_CORE_ERRORS.invalid` | errors.test (22023) |
| Після контрольної точки | `parent`/`lineNumber` ТЧ не декодуються | decode.test; DB command-runtime |
| Після контрольної точки | ідентифікатор провайдера / `DATABASE_PROVIDERS` у `src/server` | server-sources |
| Після контрольної точки | `textColumns` лише `version` | core-text-columns |
| Після контрольної точки | CHECK знову з `columns: []` | runtime-catalog, errors.test; DB command-runtime (`nonNegative`, `-1`) |
| Після контрольної точки | мапа CHECK у знімку / ім'я перераховане / лише з `elementId` | runtime-catalog (хеш, обрізання імені, покриття) |

Не червоніють (з поясненням):

- T1 (`^bigint`): `core-text-columns` не червоніє, бо єдина текстова колонка довідників фікстури — `version` (bigint); червоніє `runtime-core`, питання про numeric-атрибут у фікстурі передано архітекторові.
- T2 (рецензія, `z.int()` → `z.number().int().min(1)`): тест пережив, бо мутація еквівалентна — `.int()` у Zod 4 сам обмежує безпечним діапазоном.
- T8 M5b (копія входу на кожну спробу прибрана): не червоніє в T8, бо вхід змінюють лише хуки, яких ще не було; ловить тест T9 (M8).
- T9 M6c (`if (tx.terminal) throw` після хука): у початковому раунді зелено, бо закрита черга однаково відхиляє наступне; перевірку лишено як захист і закрито тестами у fix-раунді (F2).
- T9 M14b (прибрати `outsideCommand` разом з M14a): тест `afterCommit` зелений, бо ланцюжок `afterCommit` стартує вже без `Frame`; захист за Р-A3-11 не спостерігається тестом.
- T11 (прибрати `./server` з `publishConfig.exports`): не запускалась; за звітом її мали б зловити "exposes only the built tiers" і "imports every tier in plain Node".
