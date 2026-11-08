# П4-B1e. Версія рядка з послідовності — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** версія рядка кожної таблиці з механікою береться з однієї
послідовності бази, монотонна через видалення й повторне створення ключа й
через кроки застосування схеми, а база дає епоху версій, яка змінюється на
кожній події, після якої видані версії могли повторитися.

**Архітектура:** послідовність `simetra.row_version` — одиниця генератора
механіки, яку компілятор видає завжди. Тригер механіки `simetra.touch()`
(дефайнер) бере `nextval` і запам'ятовує видану версію в локальному
налаштуванні транзакції. Таблиця й функція епохи живуть у стані
застосування. Новий блок кроків плану `versions` після кроків двигуна сіє
послідовність, підвищує версію рядків, чиї колонки читання переписав
двигун, і пише рядок епохи. Крок даних промоції підвищує версію таблиць,
що вже мають механіку.

**Стек:** TypeScript, Vitest, Postgres 17 (DB — локальний стек Supabase),
libpg-query, pg-delta (двигун схеми в `@simetrajs/designer`).

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §7.4,
§4.1 («Епоха версій»), §11 інваріант 27, §13 рядок B1e, Рд24, Рд40; [спека
промоції](../specs/2026-10-06-promotion-design.md) §7.2, §9.2; [спека
системної схеми](../specs/2026-10-07-system-schema-users-design.md) §3;
[платформна спека](../specs/2026-09-24-simetra-platform-design.md) Р24,
Р38.

**Поділ.** Дві частини з власним «готово», кожна незалежно приймається:
**B1e-1** (Task 1–4) — послідовність, тригер, епоха, засів; **B1e-2** (Task
5–8) — версія невидимого кореня, кроки застосування, документи. B1c чекає
обох: маркер `known` коректний лише тоді, коли кроки застосування теж
підвищують версію.

## Global Constraints

- Послідовність одна на базу: `simetra.row_version AS bigint MINVALUE 1 NO CYCLE CACHE 1`, одиниця генератора `"mechanics"` (ідентичність `sequence:simetra.row_version`), видається завжди, навіть без таблиць механіки.
- Тригер механіки ніколи не бере значення клієнта: вставка — `nextval('simetra.row_version')`, оновлення — `GREATEST(nextval('simetra.row_version'), OLD.version + 1)`.
- `updated_at` кроків застосування не змінюється (конверсія, не бізнес-запис); змінюється лише `version`.
- Ніякої ролі не дано прав на послідовність: `REVOKE ALL ON SEQUENCE simetra.row_version FROM PUBLIC` і з ролей API провайдера.
- Епоха версій є лише на primary: на репліці (`pg_is_in_recovery()`) функція дає `NULL`; читання з логічного підписника не підтримується (його послідовність своя).
- «Таблиця з механікою в живій цілі» — таблиця з живим тригером `mechanicsTriggerName(t)`, що виконує `MECHANICS_FUNCTION` (`liveMechanicsTables`, Task 4), а не таблиця з колонками `version` і `updated_at`: у живій моделі немає `origin.standard`, а прийнята таблиця може мати власні колонки з цими іменами.
- Таблиці механіки не партиціюються: `TG_RELID` партиції не збігся б з OID таблиці, який читає `createRoot`.
- Транзакція застосування з блоком `versions` чи кроком даних з `bumpsVersion` має `SET LOCAL synchronous_commit = on`: ці кроки пишуть версію з вимкненими тригерами, тож `touch` синхронного коміту не ставить.
- DB-тести профілево-нейтральні: лише SQL Postgres; ролі API — з `PROVIDER_API_ROLES[provider]`, не літералом; кейс, що потребує двигуна (план → застосування), — лише в `packages/designer/src/__tests__/`, бо `simetra` двигуна не має.
- Файли ПГ-1 (виконується паралельно) не чіпати: `packages/simetra/test/db/{connection,stack-guard,sweep,interrupt}*.ts`, обидва `vitest.config.ts`, `package.json` пакетів і корінь, `.github/workflows/ci.yml`, `AGENTS.md`.
- Термін «епоха версій бази» не плутати з епохою сесії ядра T4 (`Epochs` у B3-2): у коді й коментарях — `rowVersionEpoch`.
- Коментарі — українською й про «чому»; діагностики — en/uk у `packages/simetra/src/compiler/messages.ts`.
- Без шимів: старий шлях `1` / `+1` видаляється в тій самій зміні; `PLAN_FORMAT` (`schema/apply/artifact.ts`) — 7.

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | `simetra.touch()` — тригерна функція-дефайнер через `definerTrigger` (`compiler/rights/definer.ts`), `SET search_path = ''` | `nextval` вимагає `USAGE` від того, хто пише; дефайнер обходить це без гранту записувачам; тіло фіксоване (`FIXED_BODY.mechanics`) | спека системної схеми §3 (Task 8) |
| Р2 | Оновлення — `GREATEST(nextval, OLD.version + 1)` | версія ключа не падає, навіть коли послідовність нижче (логічна реплікація не переносить послідовностей); конкурентне оновлення того самого рядка бачить новіший `OLD`. Коли перемагає `OLD.version + 1`, послідовність відстає, і повторно створений ключ міг би отримати вже видану версію; цей стан досяжний лише після переносу логічною реплікацією чи ручного `setval`, і процедура для нього — `reset_row_version_epoch()` (Р5) до запуску застосунку | скіл споживача (Task 8) |
| Р3 | `touch` підвищує `synchronous_commit` до `on` лише зі значень `off` і `local` (`remote_apply` і `remote_write` лишає) і ставить `set_config('simetra.row_version_' \|\| TG_RELID::text, NEW.version::text, true)` | асинхронний коміт губить видані версії при краху без зміни епохи; налаштування з видатною версією читає `createRoot` (Р9), а писати `simetra.*` SQL застосунку компілятор забороняє | П4-B §4.1 (Task 8) |
| Р4 | Епоха — `sha256` hex від `system_identifier`, `substr(pg_walfile_name(pg_current_wal_insert_lsn()), 1, 8)` (лінія часу), OID бази, OID послідовності, `extract(epoch from pg_postmaster_start_time())` (число, незалежне від `TimeZone` сесії) і UUID рядка `simetra.version_epoch`; без рядка чи на репліці — `NULL` | змінюється сама на рестарті й відновленні знімка тома (час старту), швидкому failover (лінія часу з WAL, а не з контрольного файла), логічному відновленні в нову базу (OID), новому кластері; хеш не показує браузеру даних кластера; ціна — маркери гаснуть на кожному рестарті. Функції доступні не-суперкористувачу Postgres 17 (перевірено 2026-11-08 на `postgres:17` і локальному Supabase) | П4-B §4.1 (Task 8) |
| Р5 | Відновлення лише даних у ту саму базу (`pg_restore --data-only`, `psql` з дампу) епохи не змінює — для нього `simetra.reset_row_version_epoch()` у стані застосування: засів над усіма таблицями механіки й новий UUID; без грантів (лише власник схеми). Процедура — відновлення й скидання при зупиненому застосунку, до першого читання; база цієї межі не тримає, тож це залишок, записаний у скілі й поданий архітекторці | дамп повертає `setval` і старий UUID, а OID лишаються | П4-B §4.1, скіл споживача (Task 8) |
| Р6 | Засів: коли `sequenceFresh` — одразу під замками; інакше (`entering`) спершу без замка порівняти максимум версій із наступним значенням послідовності, і лише коли він не менший — замки. Замки — у SQL кроку, а не лише в `lockClass`: `LOCK TABLE <кожна таблиця засіву> IN SHARE MODE` (блокує запис до `COMMIT`; у першій міграції паралельні транзакції ще виконують старий тригер `+1`) і `ALTER SEQUENCE simetra.row_version NO CYCLE` (`ShareRowExclusiveLock`, блокує `nextval`), обидва під `lock_timeout` застосування; потім повторне сканування максимуму й `setval(…, max, true)`; наступне значення — `CASE WHEN is_called THEN last_value + 1 ELSE last_value END` | послідовність лише росте, тож «не треба» без замка лишається правдою; замок лише для `setval` прибирає відкат під конкурентними записувачами й зменшує ризик взаємного блокування з записувачем, що тримає `nextval` і чекає таблицю | немає |
| Р7 | Засів і новий UUID епохи — коли в цілі немає `sequence:simetra.row_version` **або** кроки двигуна цього плану знищують чи створюють цю ідентичність; засів над `entering` — коли таблиці отримують механіку з наявними рядками | пересоздана двигуном послідовність починає наново: без засіву ключ отримав би вже видану версію | немає |
| Р8 | Крок даних промоції підвищує версію лише таблиць з механікою в **живій цілі** (живий тригер механіки) на фазі 10 (`DataTable.bumpsVersion`); прийнята таблиця отримує механіку кроками двигуна з `DEFAULT 1` і засівом | колонки `version` прийнятої таблиці на фазі 10 ще немає; її рядків жоден клієнт не бачив під каталогом рантайму | спека промоції §7.2 (Task 8) |
| Р9 | Версію невидимого кореня й члена `createRoot` читає з `current_setting('simetra.row_version_' \|\| '<таблиця>'::regclass::oid::text, true)` одразу після `INSERT` | `currval` зсувають `AFTER INSERT` тригери підписок, ефектів і `provision`; налаштування на таблицю зсуває лише вставка в ту саму таблицю, якої тригери кореня не роблять; функція-дефайнер за id розкривала б версію будь-якого кореня SQL застосунку | немає |
| Р10 | Переписані колонки — з кроків двигуна на наявних таблицях з механікою: зміна типу колонки (`ALTER COLUMN TYPE`) і пара «знищено й створено» тієї самої ідентичності `column:` (pg-delta замінює зміну виразу генерованої колонки саме так); не з різниці знімків | різниця тексту виразу між версіями платформи давала б хибне переписування таблиці | інваріант 27 П4-B уже вимагає |
| Р11 | План з кроками даних на таблицях з механікою в живій цілі (живий тригер механіки) без `sequence:simetra.row_version` — відмова `plan.row-version-first` | кроки даних (фаза 10) ідуть до кроків двигуна, що створюють послідовність | немає |

Кожне рішення — розвилка, погоджена архітекторкою (сесія
`runtime-client-data`); розбіжність під час виконання — до неї.

**Поза планом, до архітекторки:** нова епоха скидає лише право на `known`
(П4-B §6.7); правило версії ядра (Рд24, §6.2) далі не приймає меншої версії,
тож після відновлення бази чи засіву за живим максимумом рядок застрягає в
`stale`. Потрібне правило спеки П4-B: на зміні епохи ядро порівнює версії
лише в межах однієї епохи. Генерована колонка, виведена з копії носія,
змінюється поширенням без підвищення версії — її треба позначати в
каталозі як копію для часткового маркера (B1c). Одна послідовність на базу
показує клієнту сумарну частоту записів усіх тенантів через приріст версій
— побічний канал рівня спеки (Р24); одиниця боргу може поставити
`synchronous_commit = off` після `touch` (лише попередження
`sql.debt-session-write`).

**Рішення архітекторки 2026-11-08:** Р1–Р11 погоджено. Версії між епохами й генерована колонка з копії носія — обсяг B1c. Побічний канал — прийнятий залишковий ризик (платформна Р24). Два залишки, яких база не тримає (вікно між відновленням лише даних і скиданням; одиниця боргу з `synchronous_commit = off`), записуються в коментар `reset_row_version_epoch()` і в скіл споживача (Task 3, Task 8) — цього достатньо.

## Review Focus

1. **База з даними й версіями `+1`** (кожна наявна база): перше
   застосування сіє послідовність не нижче за найбільшу версію, зокрема коли
   всі версії дорівнюють `1` — Task 4.
2. **Конкурентний записувач під час застосування**: послідовність не
   відкочується — Task 4, unit (порядок «без замка → замок → повторно →
   `setval`»).
3. **Записувач без прав на послідовність** (роль команд, роль API
   провайдера): вставка й оновлення проходять — Task 1.
4. **Корінь з підпискою `AFTER INSERT`, що пише таблицю з механікою**:
   відповідь несе версію кореня — Task 5.
5. **Репліка й відновлення лише даних**: на репліці епоха `NULL`; після
   відновлення даних `reset_row_version_epoch()` змінює епоху й сіє
   послідовність — Task 3.

---

## B1e-1. Послідовність, тригер, епоха, засів

### Task 1: Послідовність і тригер механіки

**Files:**
- Modify: `packages/simetra/src/compiler/mechanics-units.ts` (`buildMechanicsUnits` видає одиницю послідовності завжди; `touchFunction` через `definerTrigger`; константа `ROW_VERSION_SEQUENCE`)
- Modify: `packages/simetra/src/compiler/sql/execute-grants.ts` (`sequenceRevokes`)
- Test: `packages/simetra/src/compiler/__tests__/mechanics-units.test.ts`, `packages/simetra/test/db/mechanics.db.test.ts`

**Interfaces:**
- Produces: `export const ROW_VERSION_SEQUENCE = { schema: PLATFORM_SCHEMA, name: "row_version" } as const`; `sequenceRevokes(sequence: QualifiedName, provider: DatabaseProvider): string[]` — `REVOKE ALL ON SEQUENCE … FROM PUBLIC` і з ролей API провайдера; GUC-префікс `ROW_VERSION_SETTING = "simetra.row_version_"` (експорт для Task 5).

- [ ] **Step 1: Unit `mechanics-units.test.ts`.** Без таблиць механіки — рівно одиниця послідовності `CREATE SEQUENCE simetra.row_version AS bigint MINVALUE 1 NO CYCLE CACHE 1` і її `REVOKE` (`it.each` над `DATABASE_PROVIDERS`); з таблицями — ще функція й тригери; розібране тіло `touch`: вставка `NEW.version := nextval('simetra.row_version')`, оновлення `NEW.version := GREATEST(nextval('simetra.row_version'), OLD.version + 1)`, підвищення `synchronous_commit` до `on` лише з `off` і `local`, `set_config('simetra.row_version_' || TG_RELID::text, NEW.version::text, true)`; функція `SECURITY DEFINER` з `SET search_path = ''`.
- [ ] **Step 2: Червоний.** `pnpm --filter simetra test mechanics-units` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: DB `mechanics.db.test.ts`** (причина DB: тригер і привілеї послідовності виконує Postgres). Замість `"1"`…`"4"`: кожна наступна версія рядка більша за попередню; видалення й повторне створення того самого `id` дає версію, більшу за будь-яку бачену; вставка й оновлення під роллю команд проходять; `nextval('simetra.row_version')` під роллю команд і під `PROVIDER_API_ROLES[provider].user` — `42501`; оновлення після `setval` нижче за версію рядка дає `OLD.version + 1`; після вставки `current_setting('simetra.row_version_<oid>')` дорівнює версії рядка.
- [ ] **Step 5: Зелений.** `pnpm --filter simetra test mechanics-units`, `pnpm --filter simetra test:db mechanics` → PASS.
- [ ] **Step 6: Commit.** `feat(compiler): версія рядка з послідовності simetra.row_version`

### Task 2: Тести з жорсткими версіями

**Files:**
- Modify (лише ті, що червоніють після Task 1): `packages/simetra/test/db/catalog-command.db.test.ts`, `rights-write.db.test.ts`, `rights-policies.db.test.ts`, `command-grants.db.test.ts`, `tenant-creation.db.test.ts`; `packages/designer/src/__tests__/rights-admin-commands.db.test.ts`, `tenant-creation.db.test.ts`, `read-query.db.test.ts`, `data-tools.db.test.ts`, `promotion-commit.db.test.ts`

- [ ] **Step 1: Прогін.** `pnpm --filter simetra test`, `pnpm --filter @simetrajs/designer test`, `pnpm test:db` — перелік червоних тестів.
- [ ] **Step 2: Правка.** Жорстка версія чи `version + 1` → «більша за попередню» (для промоції — «більша чи рівна `1`» на прийнятій таблиці до кроків B1e-2); тести з клієнтським `version` (`SET version = 5`, `version = 999`) перевіряють, що тригер значення ігнорує. Невидимий корінь (`root: { id, version: "1" }`) лишається до Task 5 як є, якщо він не червоніє.
- [ ] **Step 3: Зелений.** Ті самі команди → PASS.
- [ ] **Step 4: Commit.** `test: версії з послідовності — відносні порівняння`

### Task 3: Епоха версій

**Files:**
- Modify: `packages/simetra/src/schema/apply/state.ts` (`renderApplyState`: таблиця `simetra.version_epoch`, функції `simetra.row_version_epoch()` і `simetra.reset_row_version_epoch()`; `planPlatformFunctions`; `applyStateOf` — нові ідентичності в `owns`, їхня відсутність — у `absent`; `readApplyState` — наявність рядка епохи)
- Test: `packages/simetra/src/schema/apply/__tests__/state.test.ts`, `packages/simetra/test/db/row-version.db.test.ts` (Create)

**Interfaces:**
- Produces:
  - `simetra.version_epoch (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), epoch uuid NOT NULL DEFAULT gen_random_uuid())` — рядок пише крок Task 4;
  - `simetra.row_version_epoch() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''` — `NULL` на репліці чи без рядка; інакше `encode(sha256(convert_to(<system_identifier> || '/' || <лінія часу> || '/' || <OID бази> || '/' || <OID послідовності> || '/' || <час старту як extract(epoch from pg_postmaster_start_time())::text> || '/' || <epoch>, 'UTF8')), 'hex')`; `EXECUTE` — роль команд і ролі запиту провайдера `PROVIDER_API_ROLES[provider].user` і `.anonymous` (гостьова сесія теж читає, зокрема `publicRead`; роль, якої в провайдера немає, пропускається), за зразком `executeGrants`: читання B1c бере епоху окремим оператором під роллю читання, бо роль входу `simetra_runtime` грантів згенерованого SQL не має; функція — дефайнер і дає лише хеш, який і так іде браузеру (рішення архітекторки 2026-11-08); є в `planPlatformFunctions`;
  - `simetra.reset_row_version_epoch() RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''` — засів над усіма таблицями механіки моделі за правилом Р6 і `UPDATE simetra.version_epoch SET epoch = gen_random_uuid()` (вставка, коли рядка немає); без `EXECUTE` для будь-якої ролі, крім власника; перелік таблиць рендериться з моделі в кожному застосуванні;
  - `rowVersionEpoch: boolean` у варіанті `applied` об'єднання `ApplyState` (для `fresh` — `false`); `renderApplyState` бере `Pick<CompiledModel, "project" | "contracts" | "physical">`, бо тіло `reset_row_version_epoch()` перелічує таблиці механіки; `EXECUTE` на `reset_row_version_epoch()` явно відкликано `executeGrants(sig, [], provider)`.

- [ ] **Step 1: Unit `state.test.ts`.** (Коментар над `reset_row_version_epoch()` називає обидва залишки, яких база не тримає: вікно до виклику після відновлення лише даних і одиницю боргу з `synchronous_commit = off`.) Таблиця й обидві функції: властивості й гранти (`row_version_epoch` — ролі команд і ролям запиту провайдера `user` і `anonymous`; `reset_row_version_epoch` — нікому); розібране тіло `row_version_epoch` має `pg_is_in_recovery()` і `substr(…, 1, 8)`; `applyStateOf` на базі без жодного застосування з новими об'єктами — `absent`, з ними — їхні ідентичності в `owns`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test state`.
- [ ] **Step 3: DB `row-version.db.test.ts`** (причина DB: `pg_control_*`, WAL і привілеї виконує Postgres; розгортання — `renderDesiredState` + `renderApplyState`, без двигуна): без рядка — `NULL`; з рядком — 64 hex-символи; під роллю команд, під `PROVIDER_API_ROLES[provider].user` і під `.anonymous` виконується (роль, якої в провайдера немає, — кейс явно пропускається через `it.skipIf`), під роллю без гранту (тестова роль з run-tag) — `42501`; сценарій відновлення лише даних: записати рядкам версії, відкотити послідовність `setval` нижче за них, лишити UUID — епоха та сама; `reset_row_version_epoch()` — епоха інша, наступне значення послідовності більше за найбільшу версію; під роллю команд `reset_row_version_epoch()` — `42501`.
- [ ] **Step 4: Commit.** `feat(schema): епоха версій бази й скидання після відновлення даних`

### Task 4: Блок кроків `versions` — засів і рядок епохи

**Files:**
- Create: `packages/simetra/src/schema/apply/row-version.ts`
- Modify: `packages/simetra/src/schema/apply/plan.ts` (обидва місця збирання — звичайний план біля `withCarriers` і план промоції; кроки `versions` — до виклику `collectEnvironment`, id наскрізні; умова `unchanged` враховує `!state.rowVersionEpoch`), `steps.ts` (`origin`), `artifact.ts` (Zod `origin`, `PLAN_FORMAT = 7`), `rehearsal.ts`, `execute.ts` (`ORIGIN_ORDER`, фаза `versions` лише для непорожнього блоку), `compiler/messages.ts` (`plan.row-version-first`)
- Test: `packages/simetra/src/schema/apply/__tests__/row-version.test.ts` (Create), `packages/designer/src/__tests__/row-version.db.test.ts` (Create)

**Interfaces:**
- Produces: `rowVersionSteps(input: RowVersionInput, offset: number): PlanStep[]`; `RowVersionInput = { sequenceFresh: boolean; epochExists: boolean; mechanicsTables: readonly TableRef[]; entering: readonly TableRef[]; rewritten: readonly RewrittenTable[] }`; `TableRef = { schema: string; name: string }` (бажані імена, як у кроків двигуна); `RewrittenTable` — Task 6 (до нього порожній).
  - `sequenceFresh` — `sequence:simetra.row_version` немає в `live.extracted.model.units` **або** кроки двигуна плану мають її в `destroys` чи `produces`;
  - `liveMechanicsTables(model: CatalogModel): TableRef[]` — таблиці з живим тригером `mechanicsTriggerName(t)`, що виконує `MECHANICS_FUNCTION`;
  - `mechanicsTables` — перетин `liveMechanicsTables(live.extracted.model)` і таблиць з механікою в бажаному знімку (таблицю, яку план знищує, засів не читає);
  - `entering` — таблиці з механікою в бажаному знімку, що є в `live.extracted.model`, але не в `liveMechanicsTables` (для промоції — через `intent.tablesNewToOld`), зокрема прийнята таблиця з власними колонками `version` і `updated_at`.
- Порядок `origin`: `intent, engine, carriers, versions, environment`.
- Кроки (`transactional`, `newSegmentBefore: false`), у такому порядку:
  - **засів**, коли `sequenceFresh` і `mechanicsTables` непорожній (над ними) або `entering` непорожній (над ним): один `DO`-блок за правилом Р6; клас `validationScan`, замок `share` на таблицях; порожній перелік таблиць — кроку немає;
  - **підвищення** — Task 6;
  - **епоха**, коли `sequenceFresh` або `!epochExists`: `INSERT INTO simetra.version_epoch DEFAULT VALUES ON CONFLICT (singleton) DO UPDATE SET epoch = gen_random_uuid()`; клас `catalogOnly`.
- Відмова: кроки даних (фаза 10) на таблиці з `liveMechanicsTables` (живий тригер механіки), коли `sequence:simetra.row_version` у живій цілі немає, — `plan.row-version-first` (error).

- [ ] **Step 1: Unit `row-version.test.ts`** (`it.each`): база без послідовності з таблицею механіки — засів над нею й епоха; повторне без змін — `[]`; кроки двигуна пересоздають послідовність — засів над усіма й епоха; промоція з таблицею, що входить у механіку, — засів лише над нею, без епохи; база без рядка епохи — лише епоха, і план не `unchanged`; таблиця, яку план знищує, у засів не входить; засів: за `sequenceFresh` — `LOCK TABLE … IN SHARE MODE` кожної таблиці й замок послідовності до сканування; за `entering` — перевірка без замка, потім ті самі замки, повторне сканування, `setval(…, max, true)`; наступне значення враховує `is_called`; кроки даних без послідовності — `plan.row-version-first`; прийнята таблиця з власними `version` і `updated_at` без тригера механіки — в `entering`; свіжа база без таблиць — кроку засіву немає; наступне значення: `is_called = false` — `last_value`, `true` — `last_value + 1`; порядок `origin` у плані — `versions` між `carriers` і `environment`; раннер ставить `SET LOCAL synchronous_commit = on` за непорожнього блоку `versions`.
- [ ] **Step 2: Червоний.** `pnpm --filter simetra test row-version` → FAIL.
- [ ] **Step 3: Реалізація** `rowVersionSteps`, підключення в обидва місця `plan.ts`, раннер.
- [ ] **Step 4: DB `packages/designer/src/__tests__/row-version.db.test.ts`** (причина DB: план і застосування з двигуном на справжній базі): один сценарій — застосувати проєкт → записати рядкам високі версії й рядок з версією `1` (`UPDATE` під власником з вимкненим тригером механіки) → видалити `simetra.row_version` → застосувати з дозволом `drift`: план має засів і епоху, наступне значення послідовності більше за найбільшу версію, повторно створений ключ отримує більшу версію, UUID рядка епохи новий; повторне застосування — `unchanged`, UUID той самий. Другий кейс: усі рядки мають версію `1`, послідовність видалено, застосування — `nextval` дає більше за `1`.
- [ ] **Step 5: Зелений і брижі.** `pnpm --filter simetra test`, `pnpm --filter @simetrajs/designer test`, `pnpm --filter @simetrajs/designer test:db row-version apply-lifecycle`, `pnpm --filter simetra typecheck`; тести структури плану й фаз (`execute.test.ts`, `artifact.test.ts`, `steps.test.ts`, `carrier-backfill*.test.ts`, `platform-triggers.test.ts`, designer DB-тести плану), що червоніють від нового блоку, `PLAN_FORMAT = 7` і зсуву id кроків, оновлено → PASS.
- [ ] **Step 6: Commit.** `feat(schema): блок кроків versions — засів послідовності й епоха`

**Готово B1e-1:** unit і DB-кейси Task 1–4 зелені; `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `pnpm test:db`; файлів ПГ-1 зі списку Global Constraints не змінено (`git diff --stat`).

## B1e-2. Версія кореня, кроки застосування, документи

### Task 5: Версія невидимого кореня й члена

**Files:**
- Modify: `packages/simetra/src/compiler/catalog-command/units.ts` (`createRootFunction`: гілки `ELSE` з `'1'::text` для кореня й `v_member`)
- Test: `packages/simetra/src/compiler/__tests__/catalog-command-root.test.ts`, `packages/simetra/test/db/tenant-creation.db.test.ts`

**Interfaces:**
- Consumes: `ROW_VERSION_SETTING` (Task 1).

- [ ] **Step 1: Unit.** Одразу після `INSERT` кореня функція зберігає `current_setting('simetra.row_version_' || '<таблиця кореня>'::regclass::oid::text, true)` у локальну змінну, так само після вставки члена; гілки невидимого рядка беруть ці змінні; літерала `'1'::text` немає.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test catalog-command-root`.
- [ ] **Step 3: DB `tenant-creation.db.test.ts`** (причина DB: порядок тригерів `AFTER INSERT`): корінь моделі оператора з підпискою `AFTER INSERT`, що пише іншу таблицю з механікою, — відповідь несе версії кореня й члена, рівні прочитаним під власником схеми.
- [ ] **Step 4: Commit.** `fix(compiler): невидимий корінь і член повертають справжню версію`

### Task 6: Підвищення версії за переписаними колонками

**Files:**
- Modify: `packages/simetra/src/schema/apply/row-version.ts`, `plan.ts` (джерело `rewritten`), `steps.ts` і `artifact.ts` (поле тригерів кроку), `execute.ts` (вимкнення й увімкнення тригерів кроку)
- Test: `packages/simetra/src/schema/apply/__tests__/row-version.test.ts`, `packages/designer/src/__tests__/row-version.db.test.ts`

**Interfaces:**
- Produces: `RewrittenTable = TableRef & { triggers: DataTable["triggers"] }`; `PlanStep.triggers?: DataTable["triggers"]` (Zod — та сама схема, що в `DataTable`); `rewritten` — наявні таблиці з механікою, на яких кроки двигуна (`classifySteps`) змінюють тип колонки або знищують і створюють ту саму ідентичність `column:`; тригери — з моделі бажаної тіні (`target.extracted.model`, бажані імена), бо раннер звіряє їх після кроків двигуна.
- Крок **підвищення** на таблицю `rewritten`: `UPDATE <таблиця> SET version = nextval('simetra.row_version')`; раннер перед ним звіряє живі тригери з `triggers` кроку (`readUserTriggers`), вимикає їх (`triggerSql(…, false)`) і вмикає після блоку `versions` за дисципліною `writeData` / `enableTriggers`; клас `dataStep`, `rewriteRisk: true`, `lockClass: "shareRowExclusive"` (`DISABLE TRIGGER`). Тригери поза моделлю (провайдера) на живій таблиці звіряються так само, як у `writeData`: розбіжність — `apply.target-changed`.

- [ ] **Step 1: Unit:** зміна типу колонки таблиці з механікою — крок підвищення з тригерами бажаної тіні; знищення й створення тієї самої колонки — так само; таблиця без механіки — нічого; нова колонка — нічого; перейменування — нічого.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test row-version`.
- [ ] **Step 3: DB (designer, той самий файл, другий сценарій):** зміна типу `Numeric` зі зменшенням масштабу на таблиці з механікою — версія кожного рядка зросла, `updated_at` незмінний, тригер користувача на `UPDATE` не спрацював.
- [ ] **Step 4: Commit.** `feat(schema): переписані двигуном колонки читання підвищують версію`

### Task 7: Крок даних промоції

**Files:**
- Modify: `packages/simetra/src/schema/apply/promotion/data.ts` (`dataWriteSql`), тип `DataTable` і його Zod у `artifact.ts` (`bumpsVersion: boolean`)
- Test: `packages/simetra/src/schema/apply/__tests__/promotion-data.test.ts`, `packages/designer/src/__tests__/promotion-commit.db.test.ts`

- [ ] **Step 1: Unit.** `bumpsVersion` — істина рівно для таблиці з `liveMechanicsTables` (прийнята таблиця з власними `version` і `updated_at` — хибна); тоді `dataWriteSql` додає до `SET` `"version" = nextval('simetra.row_version')`; інакше — без нього (порівняння розібраного оператора); план з кроком `bumpsVersion` — раннер ставить `SET LOCAL synchronous_commit = on`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test promotion-data`.
- [ ] **Step 3: DB `promotion-commit.db.test.ts`.** Прийнята таблиця отримує версію з `DEFAULT 1`, а засів ставить послідовність вище; кейс кроку даних на таблиці, що вже має механіку, — якщо такий шлях промоції існує (інакше `bumpsVersion` прибрати й записати це у звіті виконання): версія зросла, `updated_at` незмінний.
- [ ] **Step 4: Commit.** `feat(schema): крок даних промоції підвищує версію таблиць з механікою`

### Task 8: Спеки й скіл

**Files:**
- Modify: `docs/superpowers/specs/2026-10-06-promotion-design.md` (§7.2 «тригери на час запису», §9.2 рядок механіки), `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (§4.1 «Епоха версій» — склад за Р3–Р5; Додаток А: рядок спеки системної схеми й B1e — «внесено (B1e)»), `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` §3, скіл споживача `packages/designer/skills/simetra-metadata/`

- [ ] **Step 1: Спека промоції.** §7.2: «серед вимкнених — і тригери механіки … `version` і `updated_at` записаних рядків не змінюються» → «`updated_at` не змінюється; `version` таблиці, що вже має механіку, крок даних пише з `simetra.row_version`: після П4 відкриті клієнти тримають рядки за версією (П4-B, інваріант 27); прийнята таблиця отримує механіку кроками двигуна з `DEFAULT 1` і засівом послідовності»; §9.2: «вставка = 1, оновлення = +1» → «вставка — `nextval`, оновлення — `GREATEST(nextval, OLD.version + 1)` послідовності `simetra.row_version`».
- [ ] **Step 2: П4-B §4.1** — склад епохи за Р4; лише primary; відновлення лише даних — `simetra.reset_row_version_epoch()`; синхронний коміт транзакцій з механікою.
- [ ] **Step 3: Спека системної схеми §3** — `row_version`, `version_epoch`, `row_version_epoch()`, `reset_row_version_epoch()`, налаштування `simetra.row_version_<oid>`.
- [ ] **Step 3a: Платформна спека Р24** — речення про побічний канал уже внесено разом із планом (рішення архітекторки 2026-11-08); перевірити, що воно на місці.
- [ ] **Step 4: Скіл споживача** — епоха змінюється сама на рестарті й відновленні знімка чи на мить у минулому; після відновлення лише даних у ту саму базу й після переносу бази логічною реплікацією власник схеми кличе `SELECT simetra.reset_row_version_epoch()` при зупиненому застосунку, до першого читання.
- [ ] **Step 5: Гейти.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`.
- [ ] **Step 6: Commit.** `docs(spec): промоція, системна схема й епоха версій під B1e`

**Готово B1e-2:** unit і DB-кейси Task 5–7 зелені; повний `pnpm test:db` зелений; спеки й скіл оновлено; файлів ПГ-1 зі списку Global Constraints не змінено (`git diff --stat`).

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| `OLD.version + 1` без `nextval` у тригері | `mechanics.db.test.ts` (повторне створення ключа) |
| `nextval` без `GREATEST` в оновленні | `mechanics.db.test.ts` (після `setval` нижче) |
| `SECURITY INVOKER` у `touch` | `mechanics.db.test.ts` (запис ролі команд) |
| одиниця послідовності лише за наявності таблиць механіки | `mechanics-units.test.ts` |
| засів без замка перед `setval` | `row-version.test.ts` |
| засів без `LOCK TABLE … IN SHARE MODE` таблиць за `sequenceFresh` | `row-version.test.ts` |
| час старту в епосі текстом із `TimeZone` | `state.test.ts` |
| наступне значення без `is_called` | `row-version.test.ts` (арифметика) і `designer/row-version.db.test.ts` (усі версії `1`) |
| механіка за іменами колонок замість живого тригера | `row-version.test.ts` (прийнята таблиця) |
| блок `versions` без `SET LOCAL synchronous_commit = on` | `row-version.test.ts` |
| засів без умови «двигун пересоздає послідовність» | `row-version.test.ts` |
| епоха без перевірки `pg_is_in_recovery()` | `state.test.ts` |
| `reset_row_version_epoch()` без нового UUID | `simetra/row-version.db.test.ts` |
| `currval` замість налаштування таблиці в `createRoot` | `tenant-creation.db.test.ts` |
| тригери кроку підвищення з живої цілі замість бажаної тіні | `row-version.test.ts` |
| `dataWriteSql` з `version` для прийнятої таблиці | `promotion-commit.db.test.ts` |
