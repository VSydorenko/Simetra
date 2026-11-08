# П4-B1e. Версія рядка з послідовності — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** версія рядка кожної таблиці з механікою береться з однієї
послідовності бази, монотонна через видалення й повторне створення ключа й
через кроки застосування схеми, а база несе епоху версій, що змінюється
після відновлення.

**Архітектура:** тригер механіки (`simetra.touch`, T1) бере `nextval`
послідовності `simetra.row_version` замість `1` і `OLD.version + 1`. Засів
послідовності й рядок епохи пише новий блок кроків плану застосування
`versions` (T2) після кроків двигуна; крок даних промоції підвищує версію
переписаних рядків явно; зміна виразу генерованої колонки отримує крок
підвищення версії. Функція `simetra.row_version_epoch()` дає епоху для
умовного читання B1c.

**Стек:** TypeScript, Vitest, Postgres 17 (локальний стек Supabase для DB),
libpg-query.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §7.4,
§4.1 («Епоха версій»), §11 інваріант 27, §13 рядок B1e, Рд24, Рд40 — усе
після поправки швидкодії (PR #65); [спека
промоції](../specs/2026-10-06-promotion-design.md) §7.2, §9.2; [платформна
спека](../specs/2026-09-24-simetra-platform-design.md) Р24, Р38.

## Global Constraints

- Послідовність одна на базу: `simetra.row_version`, `AS bigint`,
  `MINVALUE 1`, `NO CYCLE`; значення ≤ 2^53 − 1 декодер T4 вже вимагає.
- Тригер механіки ніколи не бере значення клієнта: вставка й оновлення —
  `nextval('simetra.row_version')`.
- `updated_at` кроків застосування не змінюється (конверсія, не бізнес-запис);
  змінюється лише `version`.
- DB-тести профілево-нейтральні: лише SQL Postgres, жодних об'єктів Supabase
  поза `executeGrants(…, provider)`; нові файли — `test/db/<ім'я>.db.test.ts`.
- Файли ПГ-1 (виконується паралельно) не чіпати:
  `packages/simetra/test/db/{connection,stack-guard,sweep,interrupt}*.ts`,
  `packages/simetra/vitest.config.ts`, `packages/designer/vitest.config.ts`,
  `package.json` пакетів і корінь, `.github/workflows/ci.yml`, `AGENTS.md`.
- Коментарі — українською й про «чому»; повідомлення діагностик — en/uk у
  `packages/simetra/src/compiler/messages.ts` за наявним зразком.
- Без шимів: старий шлях `1`/`+1` видаляється в тій самій зміні.

## Рішення плану (вплив на спеку — у дужках)

| № | Рішення | Чому |
| --- | --- | --- |
| Р1 | `simetra.touch()` — `SECURITY DEFINER`, `SET search_path = ''`; на послідовність — `REVOKE ALL FROM PUBLIC`, `GRANT SELECT` лише ролі команд (`currval` у `createRoot`) (спека системної схеми §3 — Додаток А П4-B, рядок уже є) | `nextval` вимагає `USAGE` на послідовність від того, хто пише; тригерна функція дефайнера обходить це без гранту записувачам, а `SELECT` не дає просувати лічильник |
| Р2 | Засів і рядок епохи — новий блок кроків `origin: "versions"` після `carriers`, до `environment` (немає) | послідовність і тригер створюють кроки двигуна, тож засів може йти лише після них; рядок епохи пишеться останнім, тож збій до нього лишає базу без епохи — маркерів немає, це безпечно |
| Р3 | План з кроками даних промоції на таблиці з механікою, коли в цілі ще немає `simetra.row_version`, — відмова `plan.row-version-first` (немає) | кроки даних (фаза 10) ідуть до кроків двигуна, що створюють послідовність; перша B1e-міграція бази й промоція в одному плані — рідкісний збіг, а дві окремі застосування його знімають |
| Р4 | Колонка `version` лишає `DEFAULT 1` (немає) | тригер завжди перезаписує значення; `DEFAULT` діє лише на наявні рядки при додаванні колонки, і засів (Р2) ставить послідовність вище за них |
| Р5 | Крок даних промоції пише `version = nextval(...)`; `updated_at` не змінює (спека промоції §7.2 «тригери на час запису», §9.2 механіка — Task 6) | інваріант 27: клієнт з `known` інакше прийняв би переписане значення за незмінне |
| Р6 | Епоха — `'<system_identifier>/<timeline_id>/<epoch uuid>'` з `pg_control_system()`, `pg_control_checkpoint()` і рядка `simetra.version_epoch`; без рядка — `NULL` (немає; П4-B §4.1 уже описує) | обидві функції Postgres 17 доступні не-суперкористувачу (перевірено 2026-11-08 на `postgres:17` і локальному Supabase); лінія часу зростає на відновленні на мить у минулому, ідентифікатор системи — на логічному відновленні в новий кластер; рядок закриває відновлення в той самий кластер |

Кожне рішення — розвилка, погоджена архітекторкою (сесія
`runtime-client-data`); розбіжність під час виконання — до неї, не мовчки.

## Review Focus

1. **База, де вже є дані з версіями `+1`** (кожна наявна база): перше
   застосування мусить посіяти послідовність вище за найбільшу версію, інакше
   повторно створений ключ отримає меншу версію — Task 4, DB-кейс «засів
   поверх наявних».
2. **Записувач без прав на послідовність** (роль команд, `authenticated` у
   профілі `supabase`): вставка й оновлення проходять — Task 1, DB-кейс.
3. **Створення кореня без ролі `rootCreator`** (невидимий рядок): відповідь
   несе справжню версію, а не `1` — Task 2.
4. **Повторне застосування без змін**: блок `versions` порожній, епоха не
   змінюється — Task 3, unit «ідемпотентність».
5. **Відновлення в той самий кластер**: скидання епохи змінює вихід функції
   — Task 5, DB-кейс; процедура — у скілі споживача (Task 6).

---

### Task 1: Послідовність і тригер механіки з `nextval`

**Files:**
- Modify: `packages/simetra/src/compiler/mechanics-units.ts` (`buildMechanicsUnits`, `touchFunction`, новий `ROW_VERSION_SEQUENCE`)
- Modify: `packages/simetra/src/schema/reverse/units.ts` (перелік платформних одиниць поряд з `isPlatformTrigger`)
- Test: `packages/simetra/src/compiler/__tests__/mechanics-units.test.ts`
- Test: `packages/simetra/test/db/mechanics.db.test.ts`

**Interfaces:**
- Produces: `export const ROW_VERSION_SEQUENCE = { schema: PLATFORM_SCHEMA, name: "row_version" } as const` у `mechanics-units.ts`; одиниця послідовності генератора `"mechanics"` (клас `sequence`, вже відомий парсеру `src/compiler/sql/units.ts`).

- [ ] **Step 1: Unit — переписати очікування тексту функції.** У `mechanics-units.test.ts` замінити перевірки фрагментів `NEW.version := 1;` / `OLD.version + 1` порівнянням розібраних операторів: тіло містить `NEW.version := nextval('simetra.row_version')` в обох гілках `TG_OP`; функція `SECURITY DEFINER` з `SET search_path = ''`; одиниці містять `CREATE SEQUENCE simetra.row_version AS bigint MINVALUE 1 NO CYCLE`, `REVOKE ALL ON SEQUENCE … FROM PUBLIC` і `GRANT SELECT ON SEQUENCE … TO <роль команд>`; без таблиць механіки — жодної одиниці (наявний кейс лишається).
- [ ] **Step 2: Запуск — червоний.** `pnpm --filter simetra test mechanics-units` → FAIL на нових очікуваннях.
- [ ] **Step 3: Реалізація.** `touchFunction` — `nextval` у обох гілках, `SECURITY DEFINER`; одиниця послідовності й гранти в `buildMechanicsUnits` (гранти — тим самим механізмом, що `executeGrants`, з `provider`). Зворотна генерація не пише послідовність: додати її до переліку платформних одиниць `schema/reverse/units.ts`.
- [ ] **Step 4: DB — переписати `mechanics.db.test.ts`** (причина DB: тригер і права послідовності виконує Postgres). Замість `"1"`…`"4"` — кожна наступна версія рядка більша за попередню; видалення й повторне створення того самого `id` дає версію, більшу за будь-яку бачену цим рядком; вставка й оновлення під роллю команд (без гранту `USAGE` на послідовність) проходять; `nextval` під роллю команд — `42501`.
- [ ] **Step 5: Запуск.** `pnpm --filter simetra test mechanics-units` і `pnpm --filter simetra test:db mechanics` → PASS.
- [ ] **Step 6: Commit.** `feat(compiler): версія рядка з послідовності simetra.row_version`

### Task 2: Справжня версія невидимого кореня

**Files:**
- Modify: `packages/simetra/src/compiler/catalog-command/units.ts` (`createRootFunction`, гілка `ELSE` з `'1'::text`)
- Test: `packages/simetra/src/compiler/__tests__/catalog-command-root.test.ts`
- Test: `packages/simetra/test/db/tenant-creation.db.test.ts`

**Interfaces:**
- Consumes: `ROW_VERSION_SEQUENCE` (Task 1).

- [ ] **Step 1: Unit.** Очікування в `catalog-command-root.test.ts`: одразу після `INSERT` кореня функція зберігає `currval('simetra.row_version')` у локальну змінну; гілка невидимого рядка будує `{ <key>, <versionColumn>: <змінна>::text }`; літерала `'1'::text` немає.
- [ ] **Step 2: Червоний.** `pnpm --filter simetra test catalog-command-root` → FAIL.
- [ ] **Step 3: Реалізація.** `currval` читається до функції гранту: грант може вставити інші рядки з механікою й зсунути `currval`.
- [ ] **Step 4: DB.** У `tenant-creation.db.test.ts` очікування `root: { id, version: "1" }` → версія дорівнює `version` рядка кореня, прочитаного під власником схеми (причина DB: `currval` і порядок тригерів виконує Postgres).
- [ ] **Step 5: Запуск.** `pnpm --filter simetra test catalog-command-root` і `pnpm --filter simetra test:db tenant-creation` → PASS.
- [ ] **Step 6: Commit.** `fix(compiler): невидимий корінь повертає справжню версію`

### Task 3: Блок кроків `versions` у плані

**Files:**
- Create: `packages/simetra/src/schema/apply/row-version.ts`
- Modify: `packages/simetra/src/schema/apply/plan.ts` (збирання кроків після `carrierBackfillSteps`), `steps.ts` (тип `origin`), `artifact.ts` (Zod `origin`), `rehearsal.ts` (перелік походжень), `execute.ts` (`ORIGIN_ORDER`, фаза), `packages/simetra/src/compiler/messages.ts` (`plan.row-version-first`)
- Test: `packages/simetra/src/schema/apply/__tests__/row-version.test.ts`

**Interfaces:**
- Produces:
  - `rowVersionSteps(input: { current: PhysicalSnapshot | undefined; desired: PhysicalSnapshot; sequenceExists: boolean; epochExists: boolean; entering: readonly TableRef[]; generatedChanged: readonly TableRef[] }, offset: number): PlanStep[]`, де `TableRef = { schema: string; name: string }` (у бажаних іменах, як кроки двигуна);
  - `PlanStep.origin` отримує значення `"versions"`; порядок `intent, engine, carriers, versions, environment`.
- Кроки (усі `transactional`, `newSegmentBefore: false`):
  - **засів** — коли `sequenceExists` хибне (план створює послідовність) — над усіма таблицями механіки `current`; інакше — над `entering` (таблиці, що отримують механіку з наявними рядками: промоція); SQL: `SELECT pg_catalog.setval('simetra.row_version', GREATEST((SELECT last_value FROM simetra.row_version), <max(version) кожної таблиці>, 1))`; клас `validationScan`, замок `share` на таблицях;
  - **підвищення** — на кожну таблицю `generatedChanged` (таблиця з механікою, де вираз генерованої колонки змінився або генерована колонка пересоздана з тим самим ім'ям між `current` і `desired`): `UPDATE <таблиця> SET version = nextval('simetra.row_version')` з вимкненими тригерами користувача за дисципліною `writeData`; клас `dataStep`, `rewriteRisk: true`;
  - **епоха** — останнім, коли в цілі немає рядка `simetra.version_epoch`: `INSERT INTO simetra.version_epoch DEFAULT VALUES ON CONFLICT DO NOTHING`; клас `catalogOnly`.
- Відмова: кроки даних промоції на таблиці з механікою при `sequenceExists = false` — діагностика `plan.row-version-first` (error), без кроків.

- [ ] **Step 1: Unit `row-version.test.ts`** (table-driven, `it.each`): (а) перше застосування на базі з таблицею механіки — засів над нею + епоха; (б) повторне без змін — `[]`; (в) промоція з таблицею, що входить у механіку, — засів лише над нею; (г) змінений вираз генерованої колонки — крок підвищення з `dataStep` і `rewriteRisk`; (д) кроки даних промоції без послідовності — `plan.row-version-first`; (е) порядок `origin` у плані — `versions` після `carriers`. Знімки — через наявні будівники фікстур `packages/simetra/src/schema/apply/__tests__/` (новий будівник, якщо таблиці з механікою там немає).
- [ ] **Step 2: Червоний.** `pnpm --filter simetra test row-version` → FAIL.
- [ ] **Step 3: Реалізація `rowVersionSteps`** і підключення в `plan.ts`; `sequenceExists` і наявність рядка епохи план бере з фізичного знімка цілі (послідовність — об'єкт знімка, рядок епохи — читання стану застосування разом із `marker`); `entering` і `generatedChanged` — з порівняння таблиць механіки й колонок `generated` у `current` і `desired`.
- [ ] **Step 4: Раннер.** `execute.ts`: блок `versions` після `carriers` (фаза `versions` лише для непорожнього блоку, як у копій); підвищення — з тим самим вимиканням і звіркою тригерів, що `writeData`.
- [ ] **Step 5: Запуск.** `pnpm --filter simetra test row-version` і `pnpm --filter simetra test apply` → PASS; `pnpm --filter simetra typecheck`.
- [ ] **Step 6: Commit.** `feat(schema): блок кроків versions — засів послідовності, підвищення версії й епоха`

### Task 4: Крок даних промоції підвищує версію

**Files:**
- Modify: `packages/simetra/src/schema/apply/promotion/data.ts` (`dataWriteSql`)
- Test: `packages/simetra/src/schema/apply/__tests__/promotion-data.test.ts`
- Test: `packages/designer/src/__tests__/promotion-commit.db.test.ts`
- Test: `packages/simetra/test/db/row-version.db.test.ts` (Create)

**Interfaces:**
- Consumes: `ROW_VERSION_SEQUENCE` (Task 1); блок `versions` (Task 3).

- [ ] **Step 1: Unit.** Для таблиці з механікою `dataWriteSql` додає до `SET` присвоєння `"version" = nextval('simetra.row_version')`; для таблиці без механіки — без нього; порівняння розібраного оператора, не фрагмента.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test promotion-data`.
- [ ] **Step 3: DB `row-version.db.test.ts`** (причина DB: засів і порядок кроків виконує раннер на справжній базі). Один сценарій: застосувати бажаний стан → записати рядкам версії вище за поточне значення послідовності (`UPDATE` під власником з вимкненим тригером механіки) → видалити `simetra.row_version` і рядок епохи → застосувати знову: план має засів і епоху, послідовність вища за найбільшу версію, повторно створений ключ отримує більшу версію.
- [ ] **Step 4: DB промоції.** У `promotion-commit.db.test.ts` очікування `filter (where version = 1)` → версія кожного переписаного рядка більша за версію до застосування, `updated_at` незмінний.
- [ ] **Step 5: Запуск.** `pnpm --filter simetra test:db row-version`, `pnpm --filter @simetrajs/designer test:db promotion-commit` → PASS.
- [ ] **Step 6: Commit.** `feat(schema): крок даних промоції підвищує версію переписаних рядків`

### Task 5: Епоха версій

**Files:**
- Modify: `packages/simetra/src/schema/apply/state.ts` (`renderApplyState`: таблиця `simetra.version_epoch`, функція `simetra.row_version_epoch()`)
- Test: `packages/simetra/src/schema/apply/__tests__/state.test.ts`
- Test: `packages/simetra/test/db/row-version.db.test.ts`

**Interfaces:**
- Produces: `simetra.version_epoch (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), epoch uuid NOT NULL DEFAULT gen_random_uuid())` без рядка (рядок пише крок епохи Task 3); `simetra.row_version_epoch() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''` — `'<system_identifier>/<timeline_id>/<epoch>'` або `NULL` без рядка; `EXECUTE` — роль команд (`executeGrants(…, ["command"], provider)`, як `applied_snapshot_hash()`).

- [ ] **Step 1: Unit `state.test.ts`.** Стан застосування містить таблицю й функцію з `SECURITY DEFINER`, порожнім `search_path` і грантом лише ролі команд (порівняння розібраних операторів).
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test state`.
- [ ] **Step 3: DB (той самий сценарій-файл).** Без рядка — `NULL`; після застосування — три частини, перша дорівнює `(pg_control_system()).system_identifier`, друга — `timeline_id` з `pg_control_checkpoint()`; `UPDATE simetra.version_epoch SET epoch = gen_random_uuid()` змінює вихід; під роллю команд функція виконується, під `authenticated` — `42501`.
- [ ] **Step 4: Запуск.** `pnpm --filter simetra test:db row-version` → PASS.
- [ ] **Step 5: Commit.** `feat(schema): епоха версій бази simetra.row_version_epoch()`

### Task 6: Тести з жорсткими версіями, спеки й скіл

**Files:**
- Modify (лише там, де тест червоніє після Task 1–5; рівність `version + 1` чи літерал → «більша за попередню»): `packages/simetra/test/db/catalog-command.db.test.ts`, `rights-write.db.test.ts`, `rights-policies.db.test.ts`, `packages/designer/src/__tests__/rights-admin-commands.db.test.ts`, `tenant-creation.db.test.ts`, `read-query.db.test.ts`
- Modify: `docs/superpowers/specs/2026-10-06-promotion-design.md` (§7.2 «тригери на час запису», §9.2 рядок механіки), `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (Додаток А: рядок спеки системної схеми й рядки B1e — «внесено (B1e)»), `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` §3 (`row_version`, `version_epoch`, `row_version_epoch()`)
- Modify: скіл споживача `packages/designer/skills/simetra-metadata/` (розділ про експлуатацію бази: після будь-якого відновлення — `UPDATE simetra.version_epoch SET epoch = gen_random_uuid()`)

- [ ] **Step 1: Повний прогін.** `pnpm --filter simetra test`, `pnpm --filter @simetrajs/designer test`, `pnpm test:db` (раз на блок) — перелік червоних тестів з жорсткими версіями.
- [ ] **Step 2: Виправити кожен червоний тест** на відносне порівняння версій; тести, що ставлять клієнтське `version` (`command-grants.db.test.ts` `SET version = 5`, `rights-write.db.test.ts` `version = 999`), перевіряють, що тригер значення клієнта ігнорує.
- [ ] **Step 3: Спека промоції.** §7.2: «серед вимкнених — і тригери механіки … `version` і `updated_at` записаних рядків не змінюються» → «`updated_at` не змінюється, а `version` крок даних пише явно з `simetra.row_version`: після П4 відкриті клієнти тримають рядки за версією (спека П4-B, інваріант 27)»; §9.2: «вставка = 1, оновлення = +1» → «`nextval` послідовності `simetra.row_version`».
- [ ] **Step 4: Спека системної схеми §3 і Додаток А П4-B** — рядки «внесено (B1e)».
- [ ] **Step 5: Скіл споживача** — абзац про скидання епохи після відновлення з посиланням на П4-B §4.1.
- [ ] **Step 6: Гейти.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`.
- [ ] **Step 7: Commit.** `test: версії з послідовності — відносні порівняння; docs(spec): промоція й системна схема під B1e`

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| `OLD.version + 1` у тригері замість `nextval` | `mechanics.db.test.ts` (повторне створення ключа) |
| `SECURITY INVOKER` у `touch` | `mechanics.db.test.ts` (запис ролі команд) |
| `GRANT USAGE` на послідовність ролі команд | `mechanics.db.test.ts` (`nextval` — `42501`) |
| засів без таблиць `current` при першому застосуванні | `row-version.db.test.ts` |
| рядок епохи раніше за кроки двигуна | `row-version.test.ts` (порядок) |
| `dataWriteSql` без `version` | `promotion-commit.db.test.ts` |
| `currval` після функції гранту | `tenant-creation.db.test.ts` |
| епоха без лінії часу | `row-version.db.test.ts` |

## Готово, коли

- unit T1/T2 і DB-кейси Task 1–5 зелені; повний `pnpm test:db` зелений;
- видалення й повторне створення ключа дають більшу версію; крок даних і
  зміна виразу генерованої колонки підвищують версію; база без рядка епохи
  дає `NULL`, з рядком — три частини;
- спеки промоції й системної схеми, Додаток А П4-B і скіл споживача
  оновлено; `check-doc-anchors` зелений;
- файлів ПГ-1 зі списку Global Constraints не змінено (`git diff --stat`).
