# П4-B1e. Версія рядка з послідовності — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** версія рядка кожної таблиці з механікою береться з однієї
послідовності бази, монотонна через видалення й повторне створення ключа й
через кроки застосування схеми, а база дає епоху версій, яка сама
змінюється на кожній події, після якої видані версії могли повторитися.

**Архітектура:** послідовність `simetra.row_version`, таблиця й функція
епохи живуть у стані застосування (`renderApplyState`, безумовно). Тригер
механіки `simetra.touch()` (дефайнер) бере `nextval`. Новий блок кроків
плану `versions` після кроків двигуна сіє послідовність під замком і
підвищує версію рядків, чиї колонки читання переписав крок двигуна. Крок
даних промоції підвищує версію таблиць, що вже мають механіку. Версію
невидимого кореня й члена читають вузькі функції-дефайнери.

**Стек:** TypeScript, Vitest, Postgres 17 (DB — локальний стек Supabase),
libpg-query.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §7.4,
§4.1 («Епоха версій»), §11 інваріант 27, §13 рядок B1e, Рд24, Рд40; [спека
промоції](../specs/2026-10-06-promotion-design.md) §7.2, §9.2; [спека
системної схеми](../specs/2026-10-07-system-schema-users-design.md) §3;
[платформна спека](../specs/2026-09-24-simetra-platform-design.md) Р24,
Р38.

**Поділ.** Блок завеликий для одного виконання, тож він має дві частини з
власним «готово»: **B1e-1** (Task 1–4) і **B1e-2** (Task 5–7). B1c чекає
обох: маркер `known` коректний лише тоді, коли кроки застосування теж
підвищують версію.

## Global Constraints

- Послідовність одна на базу: `simetra.row_version AS bigint MINVALUE 1 NO CYCLE CACHE 1`; рендериться в `renderApplyState` завжди, незалежно від наявності таблиць механіки.
- Тригер механіки ніколи не бере значення клієнта: вставка — `nextval('simetra.row_version')`, оновлення — `GREATEST(nextval('simetra.row_version'), OLD.version + 1)`.
- `updated_at` кроків застосування не змінюється (конверсія, не бізнес-запис); змінюється лише `version`.
- Ніякої ролі не дано прав на послідовність: `REVOKE ALL ON SEQUENCE simetra.row_version FROM PUBLIC` і з ролей API провайдера.
- DB-тести профілево-нейтральні: лише SQL Postgres; ролі API — з `PROVIDER_API_ROLES[provider]`, не літералом `authenticated`; нові файли — `test/db/<ім'я>.db.test.ts`.
- Файли ПГ-1 (виконується паралельно) не чіпати: `packages/simetra/test/db/{connection,stack-guard,sweep,interrupt}*.ts`, обидва `vitest.config.ts`, `package.json` пакетів і корінь, `.github/workflows/ci.yml`, `AGENTS.md`.
- Термін «епоха версій бази» не плутати з епохою сесії ядра T4 (`Epochs` у B3-2): у коді й коментарях — `rowVersionEpoch`.
- Коментарі — українською й про «чому»; діагностики — en/uk у `packages/simetra/src/compiler/messages.ts`.
- Без шимів: старий шлях `1` / `+1` видаляється в тій самій зміні; `PLAN_FORMAT` (`schema/apply/artifact.ts`) — 7.

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | `simetra.touch()` — тригерна функція-дефайнер через наявний `definerTrigger` (`compiler/rights/definer.ts`), `SET search_path = ''` | `nextval` вимагає `USAGE` на послідовність від того, хто пише; дефайнер обходить це без гранту записувачам; тіло фіксоване (`FIXED_BODY.mechanics`) | спека системної схеми §3 (Task 7) |
| Р2 | Оновлення — `GREATEST(nextval, OLD.version + 1)` | версія ключа не падає, навіть коли послідовність опинилась нижче (логічна реплікація не переносить послідовностей) | немає |
| Р3 | Епоха — `sha256` hex від `system_identifier`, лінії часу з `pg_walfile_name(pg_current_wal_insert_lsn())`, OID бази, OID послідовності, `pg_postmaster_start_time()` і UUID рядка `simetra.version_epoch`; без рядка — `NULL` | змінюється сама: рестарт і відновлення знімка тома (час старту), швидкий failover (лінія часу з WAL, а не з контрольного файла), логічне відновлення (OID), новий кластер (`system_identifier`); хеш не показує браузеру даних кластера; ціна — маркери гаснуть на кожному рестарті. Усі функції доступні не-суперкористувачу Postgres 17 (перевірено 2026-11-08 на `postgres:17` і локальному Supabase) | П4-B §4.1 (Task 7) |
| Р4 | Засів — під замком послідовності (`ALTER SEQUENCE simetra.row_version NO CYCLE` бере `ShareRowExclusiveLock`, що блокує `nextval` до `COMMIT`); `setval` лише коли максимум версій більший за `last_value` | `setval` без замка відкотив би послідовність під конкурентними записувачами | немає |
| Р5 | Рядок епохи: коли план створює послідовність — upsert із новим UUID (`ON CONFLICT (singleton) DO UPDATE SET epoch = gen_random_uuid()`), останнім кроком | пересоздана послідовність починає наново, тож стара епоха брехала б | немає |
| Р6 | Крок даних промоції підвищує версію лише таблиць, що мають колонки механіки в **живій цілі** на фазі 10; прийнята таблиця отримує механіку пізніше (кроки двигуна) з `DEFAULT 1` і засівом | колонки `version` прийнятої таблиці на фазі 10 ще немає; її рядків жоден клієнт не бачив під каталогом рантайму | спека промоції §7.2 (Task 7) |
| Р7 | План з кроками даних на таблицях з механікою в живій цілі без `simetra.row_version` — відмова `plan.row-version-first` | кроки даних (фаза 10) ідуть до кроків двигуна, що створюють послідовність | немає |
| Р8 | Переписані колонки — з кроків двигуна на таблицях з механікою: зміна типу (`ALTER COLUMN TYPE`), `SET EXPRESSION`, зняття й додавання генерованої колонки; не з різниці знімків | різниця тексту виразу між версіями платформи давала б хибне переписування таблиці | інваріант 27 П4-B уже вимагає |
| Р9 | Версію невидимого кореня й рядка члена в `createRoot` читають вузькі функції-дефайнери `simetra.<таблиця>_row_version(p_id uuid) RETURNS bigint` (одна на таблицю кореня й членства), `EXECUTE` — лише роль команд | `currval` після `INSERT` зсувають `AFTER INSERT` тригери підписок, ефектів і `provision` | немає |

Кожне рішення — розвилка, погоджена архітекторкою (сесія
`runtime-client-data`); розбіжність під час виконання — до неї.

## Review Focus

1. **База з даними й версіями `+1`** (кожна наявна база): перше застосування
   сіє послідовність вище за найбільшу версію — Task 3, DB-кейс засіву.
2. **Конкурентний записувач під час застосування**: послідовність не
   відкочується — Task 3, unit (замок перед `setval`) і мутація.
3. **Записувач без прав на послідовність** (роль команд і роль API
   провайдера): вставка й оновлення проходять — Task 1, DB-кейс.
4. **Корінь з підпискою `AFTER INSERT`, що пише таблицю з механікою**:
   відповідь несе версію кореня — Task 4, DB-кейс.
5. **Повторне застосування без змін**: блок `versions` порожній, епоха не
   змінюється — Task 3, unit.

---

## B1e-1. Послідовність, тригер, епоха, засів

### Task 1: Послідовність і тригер механіки з `nextval`

**Files:**
- Modify: `packages/simetra/src/schema/apply/state.ts` (`renderApplyState`: послідовність і `REVOKE`)
- Modify: `packages/simetra/src/compiler/mechanics-units.ts` (`touchFunction` через `definerTrigger`; константа `ROW_VERSION_SEQUENCE`)
- Test: `packages/simetra/src/compiler/__tests__/mechanics-units.test.ts`, `packages/simetra/src/schema/apply/__tests__/state.test.ts`, `packages/simetra/test/db/mechanics.db.test.ts`

**Interfaces:**
- Produces: `export const ROW_VERSION_SEQUENCE = { schema: PLATFORM_SCHEMA, name: "row_version" } as const` (`compiler/mechanics-units.ts`); `sequenceRevokes(sequence: QualifiedName, provider: DatabaseProvider): string[]` — `REVOKE ALL` з `PUBLIC` і ролей API, у тому самому модулі, що `executeGrants`.

- [ ] **Step 1: Unit.** `mechanics-units.test.ts`: розібране тіло `touch` — вставка `NEW.version := nextval('simetra.row_version')`, оновлення `NEW.version := GREATEST(nextval('simetra.row_version'), OLD.version + 1)`; функція `SECURITY DEFINER` з `SET search_path = ''`. `state.test.ts`: стан застосування містить `CREATE SEQUENCE simetra.row_version AS bigint MINVALUE 1 NO CYCLE CACHE 1` і `REVOKE ALL` з `PUBLIC` і ролей API кожного провайдера (`it.each` над `DATABASE_PROVIDERS`).
- [ ] **Step 2: Червоний.** `pnpm --filter simetra test mechanics-units state` → FAIL.
- [ ] **Step 3: Реалізація** `sequenceRevokes` і `touchFunction` через `definerTrigger`.
- [ ] **Step 4: DB `mechanics.db.test.ts`** (причина DB: тригер і привілеї послідовності виконує Postgres). Замість `"1"`…`"4"`: кожна наступна версія рядка більша за попередню; видалення й повторне створення того самого `id` дає версію, більшу за будь-яку бачену; вставка й оновлення під роллю команд проходять; `nextval('simetra.row_version')` під роллю команд і під `PROVIDER_API_ROLES[provider].user` — `42501`; оновлення після `setval` нижче за версію рядка дає `OLD.version + 1`.
- [ ] **Step 5: Зелений.** `pnpm --filter simetra test mechanics-units state` і `pnpm --filter simetra test:db mechanics` → PASS.
- [ ] **Step 6: Commit.** `feat(schema): версія рядка з послідовності simetra.row_version`

### Task 2: Епоха версій

**Files:**
- Modify: `packages/simetra/src/schema/apply/state.ts` (таблиця `simetra.version_epoch`, функція `simetra.row_version_epoch()`, `planPlatformFunctions`)
- Test: `packages/simetra/src/schema/apply/__tests__/state.test.ts`, `packages/simetra/test/db/row-version.db.test.ts` (Create)

**Interfaces:**
- Produces: `simetra.version_epoch (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), epoch uuid NOT NULL DEFAULT gen_random_uuid())` — рядок пише крок Task 3; `simetra.row_version_epoch() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''` — `encode(sha256(convert_to(<system_identifier> || '/' || <лінія часу> || '/' || <OID бази> || '/' || <OID послідовності> || '/' || <час старту> || '/' || <epoch>, 'UTF8')), 'hex')` або `NULL` без рядка; `EXECUTE` — роль команд (`executeGrants(…, ["command"], provider)`); функція в `planPlatformFunctions`.

- [ ] **Step 1: Unit `state.test.ts`.** Таблиця й функція з `SECURITY DEFINER`, порожнім `search_path`, грантом лише ролі команд; функція є в `planPlatformFunctions`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test state`.
- [ ] **Step 3: DB `row-version.db.test.ts`** (причина DB: `pg_control_*`, WAL і привілеї виконує Postgres): без рядка — `NULL`; з рядком — 64 hex-символи; новий UUID змінює вихід; під роллю команд виконується, під `PROVIDER_API_ROLES[provider].user` — `42501`.
- [ ] **Step 4: Commit.** `feat(schema): епоха версій бази simetra.row_version_epoch()`

### Task 3: Блок кроків `versions` — засів і рядок епохи

**Files:**
- Create: `packages/simetra/src/schema/apply/row-version.ts`
- Modify: `packages/simetra/src/schema/apply/plan.ts` (обидва місця збирання — звичайний план біля `withCarriers` і план промоції; кроки `versions` — до виклику `collectEnvironment`, id наскрізні), `steps.ts` (`origin`), `artifact.ts` (Zod `origin`, `PLAN_FORMAT = 7`), `rehearsal.ts`, `execute.ts` (`ORIGIN_ORDER`, фаза `versions` лише для непорожнього блоку), `state.ts` (`readApplyState`: наявність рядка епохи через `to_regclass` і `SELECT`), `compiler/messages.ts` (`plan.row-version-first`)
- Test: `packages/simetra/src/schema/apply/__tests__/row-version.test.ts` (Create), `packages/simetra/test/db/row-version.db.test.ts`

**Interfaces:**
- Produces: `rowVersionSteps(input: RowVersionInput, offset: number): PlanStep[]`, де `RowVersionInput = { sequenceExists: boolean; epochExists: boolean; mechanicsTables: readonly TableRef[]; entering: readonly TableRef[]; rewritten: readonly RewrittenTable[] }` і `TableRef = { schema: string; name: string }` (бажані імена, як у кроків двигуна); `RewrittenTable` — Task 5 (до нього `rewritten` порожній).
  - `sequenceExists` — ідентичність `sequence:simetra.row_version` у `live.extracted.model.units`;
  - `mechanicsTables` — таблиці з колонками механіки в цілі: звичайний план — з `markerTables(state.marker)`, промоція — з `promotion.source` через `intent.tablesNewToOld`, як у копій носіїв;
  - `entering` — таблиці, що отримують механіку в цьому плані й існують у цілі.
- Порядок `origin`: `intent, engine, carriers, versions, environment`.
- Кроки (`transactional`, `newSegmentBefore: false`), у такому порядку:
  - **засів**, коли `!sequenceExists` (над `mechanicsTables`) або `entering` непорожній (над `entering`): один оператор `DO`-блоку — спершу `ALTER SEQUENCE simetra.row_version NO CYCLE` (замок), потім `max(version)` таблиць і `setval(…, max)` лише за `max > last_value`; клас `validationScan`, замок `share` на таблицях;
  - **підвищення** — Task 5;
  - **епоха**, коли `!sequenceExists` або `!epochExists`: `INSERT INTO simetra.version_epoch DEFAULT VALUES ON CONFLICT (singleton) DO UPDATE SET epoch = gen_random_uuid()`; клас `catalogOnly`.
- Відмова: кроки даних (фаза 10) на таблиці з колонками механіки в живій цілі при `!sequenceExists` — `plan.row-version-first` (error).

- [ ] **Step 1: Unit `row-version.test.ts`** (`it.each`): перше застосування на базі з таблицею механіки — засів над нею й епоха; повторне без змін — `[]`; промоція з таблицею, що входить у механіку, — засів лише над нею, без епохи; база без рядка епохи — лише епоха; засів: замок стоїть перед читанням `last_value`, `setval` — під умовою `max > last_value`; кроки даних без послідовності — `plan.row-version-first`; порядок `origin` у плані — `versions` між `carriers` і `environment`.
- [ ] **Step 2: Червоний.** `pnpm --filter simetra test row-version` → FAIL.
- [ ] **Step 3: Реалізація** `rowVersionSteps`, підключення в обидва місця `plan.ts`, раннер.
- [ ] **Step 4: DB (той самий файл)** (причина DB: засів і замок виконує раннер на справжній базі): застосувати бажаний стан → записати рядкам високі версії (`UPDATE` під власником з вимкненим тригером механіки) → видалити `simetra.row_version` → застосувати з дозволом `drift`: план має засів і епоху, послідовність вища за найбільшу версію, повторно створений ключ отримує більшу версію, епоха змінилась.
- [ ] **Step 5: Зелений.** `pnpm --filter simetra test row-version apply`, `pnpm --filter simetra test:db row-version`, `pnpm --filter simetra typecheck` → PASS.
- [ ] **Step 6: Commit.** `feat(schema): блок кроків versions — засів послідовності під замком і епоха`

### Task 4: Версія невидимого кореня й члена

**Files:**
- Modify: `packages/simetra/src/compiler/catalog-command/units.ts` (`createRootFunction`: гілки `ELSE` з `'1'::text` для кореня й `v_member`; нові одиниці функцій версії)
- Test: `packages/simetra/src/compiler/__tests__/catalog-command-root.test.ts`, `packages/simetra/test/db/tenant-creation.db.test.ts`

**Interfaces:**
- Produces: для кожної таблиці кореня з `rootCreator` і її таблиці членства — одиниця `simetra.<таблиця>_row_version(p_id uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''` (`SELECT version FROM <таблиця> WHERE <ключ> = p_id`), `EXECUTE` — роль команд.

- [ ] **Step 1: Unit.** Гілка невидимого рядка будує `{ <key>, <versionColumn>: <функція>(<id>)::text }` для кореня й члена; одиниці функцій версії — дефайнери з грантом лише ролі команд; літерала `'1'::text` немає.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test catalog-command-root`.
- [ ] **Step 3: DB `tenant-creation.db.test.ts`** (причина DB: порядок тригерів `AFTER INSERT`): корінь моделі оператора з підпискою `AFTER INSERT`, що пише таблицю з механікою, — відповідь несе версію кореня й члена, рівну прочитаній під власником схеми.
- [ ] **Step 4: Commit.** `fix(compiler): невидимий корінь і член повертають справжню версію`

**Готово B1e-1:** unit і DB-кейси Task 1–4 зелені; тести з жорсткими версіями, що червоніють від Task 1–4, виправлено за Task 6 Step 4; `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `pnpm test:db`.

## B1e-2. Кроки застосування підвищують версію

### Task 5: Підвищення версії за переписаними колонками

**Files:**
- Modify: `packages/simetra/src/schema/apply/row-version.ts`, `plan.ts` (джерело `rewritten`), `steps.ts` і `artifact.ts` (поле тригерів кроку), `execute.ts` (вимкнення й увімкнення тригерів кроку)
- Test: `packages/simetra/src/schema/apply/__tests__/row-version.test.ts`, `packages/simetra/test/db/row-version.db.test.ts`

**Interfaces:**
- Produces: `RewrittenTable = TableRef & { triggers: DataTable["triggers"] }`; `PlanStep.triggers?: DataTable["triggers"]` (Zod — та сама схема, що в `DataTable`); `rewritten` будується з кроків двигуна на таблицях з механікою (`classifySteps` / `guardedChanges`): зміна типу колонки, `SET EXPRESSION`, зняття й додавання генерованої колонки; тригери — з `live.extracted.model` на мить плану.
- Крок **підвищення** на таблицю `rewritten`: `UPDATE <таблиця> SET version = nextval('simetra.row_version')`; раннер перед ним звіряє живі тригери з `triggers` кроку (`readUserTriggers`), вимикає їх (`triggerSql(…, false)`) і вмикає після блоку `versions` за дисципліною `writeData` / `enableTriggers`; клас `dataStep`, `rewriteRisk: true`.

- [ ] **Step 1: Unit:** крок двигуна зі зміною типу колонки таблиці з механікою — крок підвищення з тригерами; `SET EXPRESSION` — так само; таблиця без механіки — нічого; лише перейменування колонки — нічого.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test row-version`.
- [ ] **Step 3: DB (той самий файл):** зміна типу `Numeric` зі зменшенням масштабу на таблиці з механікою — версія кожного рядка зросла, `updated_at` незмінний, тригер користувача на `UPDATE` не спрацював.
- [ ] **Step 4: Commit.** `feat(schema): переписані двигуном колонки читання підвищують версію`

### Task 6: Крок даних промоції; тести з жорсткими версіями

**Files:**
- Modify: `packages/simetra/src/schema/apply/promotion/data.ts` (`dataWriteSql`), тип `DataTable` і його Zod у `artifact.ts` (ознака `bumpsVersion: boolean`)
- Test: `packages/simetra/src/schema/apply/__tests__/promotion-data.test.ts`, `packages/designer/src/__tests__/promotion-commit.db.test.ts`
- Modify (лише червоні): `packages/simetra/test/db/catalog-command.db.test.ts`, `packages/simetra/test/db/rights-write.db.test.ts`, `packages/simetra/test/db/rights-policies.db.test.ts`, `packages/simetra/test/db/command-grants.db.test.ts`, `packages/simetra/test/db/tenant-creation.db.test.ts`, `packages/designer/src/__tests__/rights-admin-commands.db.test.ts`, `packages/designer/src/__tests__/tenant-creation.db.test.ts`, `packages/designer/src/__tests__/read-query.db.test.ts`, `packages/designer/src/__tests__/data-tools.db.test.ts`

- [ ] **Step 1: Unit.** `bumpsVersion` — істина рівно для таблиці з колонками механіки в живій цілі; тоді `dataWriteSql` додає до `SET` `"version" = nextval('simetra.row_version')`; інакше — без нього (порівняння розібраного оператора).
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test promotion-data`.
- [ ] **Step 3: DB `promotion-commit.db.test.ts`.** Прийнята таблиця лишає `version = 1` (механіка приходить кроками двигуна); новий кейс — крок даних на таблиці, що вже має механіку, якщо такий шлях промоції існує (інакше `bumpsVersion` і цей кейс прибрати й записати це у звіті виконання): версія зросла, `updated_at` незмінний.
- [ ] **Step 4: Повний прогін і правка червоних тестів.** `pnpm --filter simetra test`, `pnpm --filter @simetrajs/designer test`, `pnpm test:db`; кожен червоний тест з жорсткою версією чи `version + 1` → «більша за попередню»; тести з клієнтським `version` (`SET version = 5`, `version = 999`) перевіряють, що тригер значення ігнорує.
- [ ] **Step 5: Commit.** `feat(schema): крок даних промоції підвищує версію; test: відносні порівняння версій`

### Task 7: Спеки й скіл

**Files:**
- Modify: `docs/superpowers/specs/2026-10-06-promotion-design.md` (§7.2 «тригери на час запису», §9.2 рядок механіки), `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (§4.1 «Епоха версій» — склад за Р3; Додаток А: рядок спеки системної схеми й B1e — «внесено (B1e)»), `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` §3, скіл споживача `packages/designer/skills/simetra-metadata/`

- [ ] **Step 1: Спека промоції.** §7.2: «серед вимкнених — і тригери механіки … `version` і `updated_at` записаних рядків не змінюються» → «`updated_at` не змінюється; `version` таблиці, що вже має механіку, крок даних пише з `simetra.row_version`: після П4 відкриті клієнти тримають рядки за версією (П4-B, інваріант 27); прийнята таблиця отримує механіку кроками двигуна з `DEFAULT 1` і засівом послідовності»; §9.2: «вставка = 1, оновлення = +1» → «вставка — `nextval`, оновлення — `GREATEST(nextval, OLD.version + 1)` послідовності `simetra.row_version`».
- [ ] **Step 2: П4-B §4.1** — склад епохи за Р3 (хеш; лінія часу з WAL; OID бази й послідовності; час старту); ручного скидання немає.
- [ ] **Step 3: Спека системної схеми §3** — `row_version`, `version_epoch`, `row_version_epoch()`, функції `<таблиця>_row_version`.
- [ ] **Step 4: Скіл споживача** — одне речення: епоха змінюється сама на рестарті й відновленні бази, тож після них клієнти один раз перечитують дані повністю.
- [ ] **Step 5: Гейти.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`.
- [ ] **Step 6: Commit.** `docs(spec): промоція, системна схема й епоха версій під B1e`

**Готово B1e-2:** unit і DB-кейси Task 5–6 зелені; повний `pnpm test:db` зелений; спеки й скіл оновлено; файлів ПГ-1 зі списку Global Constraints не змінено (`git diff --stat`).

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| `OLD.version + 1` без `nextval` у тригері | `mechanics.db.test.ts` (повторне створення ключа) |
| `nextval` без `GREATEST` в оновленні | `mechanics.db.test.ts` (після `setval` нижче) |
| `SECURITY INVOKER` у `touch` | `mechanics.db.test.ts` (запис ролі команд) |
| засів без замка послідовності | `row-version.test.ts` |
| засів, що ставить `setval` за `max ≤ last_value` | `row-version.test.ts` |
| епоха без часу старту чи лінії часу з WAL | `state.test.ts` (склад функції) |
| рядок епохи не оновлюється при пересозданій послідовності | `row-version.db.test.ts` |
| `currval` замість функції версії в `createRoot` | `tenant-creation.db.test.ts` |
| крок підвищення без вимкнення тригерів | `row-version.db.test.ts` (`updated_at`) |
| `dataWriteSql` з `version` для прийнятої таблиці | `promotion-commit.db.test.ts` |
