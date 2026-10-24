# Права-2b2: крок даних копій носіїв — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: чернетка на аудит.
Архітектор задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** нова копія носія на таблиці з рядками заповнюється кроком даних
плану, а не дає відмову. Крок — звичайний крок плану класу `dataStep` з
походженням `carriers`, що йде одразу після кроків двигуна (колонку-копію
створює двигун) у тій самій транзакції, для звичайного плану й для
промоції. Відмова `plan.carrier-backfill-missing` плану 2a2 зникає разом з
кодом, а її тести стають тестами кроку.

**Архітектура:**

- **T1** (`packages/simetra/src/compiler/rights/carrier-units.ts`):
  `carrierBackfillStatements` — SQL кроку з тих самих пар складеного FK, що
  тригер поширення 2a2 (Р2a2-27), у порядку залежностей копій.
- **T2** (`packages/simetra/src/schema/apply`): `carrier-backfill.ts` —
  кроки плану з очікуваних копій (`pendingCarrierCopies` лишається); `plan.ts`
  — кроки в обох гілках замість відмови; `artifact.ts` — `origin: "carriers"`,
  `PLAN_FORMAT` 6; `execute.ts` — фаза `carriers` між двигуном і середовищем
  під `DATA_SETTINGS`.
- **Тести:** unit на SQL і плані; DB — гучна відмова на `FORCE ROW LEVEL
  SECURITY` і кроки на живих рядках у designer (звичайний план і промоція).

**Стек:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query (WASM),
локальний стек Supabase (Postgres 17).

**Спека:** [спека прав](../specs/2026-10-17-rights-design.md) §5.2, §5.4;
[спека промоції](../specs/2026-10-06-promotion-design.md) §7.2 («Порядок
транзакції», «Закріплені налаштування даних»), §8 («Класи кроків»);
[платформна спека](../specs/2026-09-24-simetra-platform-design.md) §6.2, §6.6.
Плани [Права-2a2](2026-10-18-rights-2a2-read-policies-carriers.md) (Р2a2-7,
Р2a2-11, Р2a2-19, Р2a2-27, Р2a2-28) і [П3-2b-2](2026-10-14-p3-2b-2-promotion-data-steps.md) — їхні
таблиці рішень діють.

**Залежність:** Права-2a2 виконано (`pendingCarrierCopies`,
`carrierBackfillRefusals`, `carrierBackfillGate` у `plan.ts`, `buildCarrierUnits`,
`carrierCopies`, `fieldForeignKey` у `compiler/stages/model.ts`,
`contentChangeCondition`). З [Права-2b1](2026-10-24-rights-2b1-write-policies-effects.md)
спільного коду немає; виконується після 2b1 (обидва змінюють `diagnostics.ts`
і `messages.ts`). Тригер ефектів 2b1 на кроці мовчить: кроки плану
`simetra.command` не ставлять. Перед стартом —
`.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-24-rights-2b2-carrier-backfill.md`.

## Global Constraints

- Усі обмеження планів Права-2a2 і 2b1 (розділи «Global Constraints») діють і тут.
- 🔴 `pnpm --filter <pkg> test <pattern>` — **без** `--` перед шаблоном.
- 🔴 Значення копії бере лише рядок, на який указує складений FK (пари `fieldForeignKey`), — той самий аргумент, що Р2a2-8 і Р2a2-27; жодних інших з'єднань.
- 🔴 Крок не вимикає тригерів і не ставить GUC-прапорців: тригери носіїв, механіка й підписки 2a2 уже правильно поводяться з зміною лише копій.
- 🔴 Крок даних — під `DATA_SETTINGS` (зокрема `row_security = off`: на таблиці з `FORCE ROW LEVEL SECURITY` — гучна помилка, не тихий нуль) і з перевіркою `session_replication_role = 'origin'` (у `replica` тригери носіїв не спрацювали б).
- Кожен ідентифікатор у SQL кроку — кваліфікований і в лапках (`quoteIdent`): під закріпленим `search_path = pg_catalog, pg_temp` голе ім'я не знайдеться.
- Залишковий код без споживача (`carrierBackfillRefusals`, `carrierBackfillGate`, код `plan.carrier-backfill-missing`, його тексти) — видалити в тому самому коміті, що й заміну.
- Між задачами гейти не червоні; скіл `.agents/skills/writing-tests/SKILL.md` обов'язковий перед кроками тестів.
- Репо публічне: фікстури синтетичні.

## Рішення плану

Розвилки (б) і (в) вирішив архітектор задачі 2026-10-24.

| # | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р2b2-1 | Крок даних копій — `PlanStep` з `origin: "carriers"`, `class: "dataStep"`, `verb: "alter"`, `lockClass: "shareRowExclusive"`, `transactionality: "transactional"`, SQL відрендерено під час плану; `lockedTables` — залежна таблиця й таблиця-джерело (у нових іменах; слід переводить у вихідні, як для кроку двигуна); `produces`/`consumes`/`destroys`, структурні поля й `guards` — порожні; `dataLoss`, `rewriteRisk`, `newSegmentBefore` — `false`. Дозволу не потребує (`NEEDS_PERMISSION` — лише `destructive`, `relaxation`). `ORIGIN_ORDER` = `["intent", "engine", "carriers", "environment"]`; id наскрізні: кроки `carriers` — після кроків двигуна й до кроків середовища. `PLAN_FORMAT` 5 → 6 (нове значення `origin` у схемі артефакту) | план показує SQL, клас і замок, як для інших кроків; у звичайному плані `promotion === null`, тож `PromotionSection.data` не годиться | спека прав §5.2 — «крок даних плану» без «до кроку даних — відмова»; спека промоції §7.2 і платформна §6.2 — блок кроків копій (Задача 0) |
| Р2b2-2 | SQL кроку — один оператор на (залежна таблиця, `through`): `UPDATE <залежна> AS d SET <копія> = s.<колонка>, … FROM <джерело> AS s WHERE d.<локальна FK> = s.<колонка FK джерела> AND … AND (d.<копія> IS DISTINCT FROM s.<колонка> OR …)`; пари — `fieldForeignKey(<залежна>, through)`, копії — лише очікувані. `IS DISTINCT FROM` не чіпає вже узгоджених рядків (без зайвих `UPDATE`). `BEFORE`-тригер носіїв на цьому `UPDATE` сам перевиводить змінену копію з джерела (`forged-copy-update` 2a2): значення з `SET` перезаписується тим самим — це очікувано | та сама форма, що поширення Р2a2-27; рядок джерела — саме той, на який указує FK | немає |
| Р2b2-3 | Порядок операторів — за залежностями копій: оператор копії, чий `copyOf` читає іншу очікувану копію (копія ТЧ читає копію шляху власника), — після неї; решта — за (`schema`, `name`, `through`) кодовими одиницями. Поширення 2a2 й так заповнює наступний крок двоходово, тож другий оператор знаходить рядки вже узгодженими | детермінований план; двоходовий ланцюг не залежить від порядку тригерів | немає |
| Р2b2-4 | Фаза `carriers` у `runAttempt` — між 11 (двигун) і 12 (середовище): `withLocalSettings(tx, DATA_SETTINGS, …)` над `runSteps` блоку `carriers`, перед ним — та сама перевірка `session_replication_role`, що у фазі 8 (спільний помічник, а не копія). Тригери не вимикаються: тригер носіїв перевиводить ту саму копію, `contentChangeCondition` придушує механіку й підписки (версія залежних рядків не росте), тригер ефектів 2b1 без контексту мовчить | колонку-копію створює двигун у фазі 11; кроки даних промоції (фаза 10) — до двигуна, тож вони не годяться | спека промоції §7.2 «Порядок транзакції» — пункт «кроки копій носіїв — після кроків двигуна, до кроків середовища, під закріпленими налаштуваннями даних, без вимкнення тригерів» (Задача 0) |
| Р2b2-5 | Замок `SHARE ROW EXCLUSIVE` на залежній таблиці й таблиці-джерелі (у `plan.locks`, від початку транзакції): конкурентна зміна носія власника між читанням кроку й `COMMIT`, коли тригер поширення не перестворюється в цьому плані, лишила б застарілу копію. Залежну таблицю, якій двигун додає колонку, уже займає `ACCESS EXCLUSIVE` (`joinModes`) | `SHARE ROW EXCLUSIVE` блокує чужий DML обох таблиць і не конфліктує з власними замками транзакції | немає |
| Р2b2-6 | Промоція — та сама фаза, нові імена: `pendingCarrierCopies` повертає таблицю **в бажаному (новому) імені**, а старе ім'я (`oldName`) лише шукає її в знімку `applied` (`promotion.source`). Доказ збереження промоції копій не міряє (`PreservedTable.columns` — явний перелік змаплених колонок) | після кроків двигуна таблиці вже в нових іменах | немає |
| Р2b2-7 | Крок генерується на кожну очікувану копію незалежно від наявності рядків: план не читає ціль (`carrierBackfillGate` і читальна транзакція зникають). На порожній таблиці крок пише нуль рядків. Копії залишаються в кроці середовища копії (`runOnClone` виконує й кроки `carriers` — на копії без рядків це нуль рядків) | план — дані; одна логіка для порожньої й непорожньої таблиці | немає |
| Р2b2-8 | Колонка з іменем копії, що копією не була (видалений реквізит з даними, прийнята колонка), — очікувана копія, як у 2a2 (`same-name-not-copy`): крок перезаписує її значення виведеними з джерела | старі значення під іменем копії не є копією (Р2a2-11) | немає |

## Відомі обмеження

- Розгалуження поширення (сотні тисяч рядків ТЧ під одним власником) і час
  кроку на великих таблицях міряє бенчмарк 2d; крок займає `SHARE ROW
  EXCLUSIVE` до `COMMIT`.
- Дослівний тригер на таблиці виду (заборона — 2c) бачить `UPDATE` кроку,
  що змінює лише копії.
- Звіт репетиції окремих лічильників кроку не несе: тривалість кроку — у
  тривалостях фаз і кроків.

## Review Focus

1. **Ланцюг копій:** нова копія шляху на коментарі й копія ТЧ вкладень, що її читає, заповнюються одним планом; `version` коментарів не змінилася, підписка `onWrite` не спрацювала. Тест — Задача 4 (`plain plan`).
2. **Старі значення під іменем копії:** колонка `assignee_id` ТЧ, що була звичайним реквізитом, після плану дорівнює носію власника. Тест — Задача 2 (`same-name-not-copy`), Задача 4.
3. **Промоція:** перейменована промоцією таблиця з рядками отримує копію в новому імені. Тест — Задача 4 (`promotion`).
4. **Таблиця з `FORCE ROW LEVEL SECURITY`:** крок падає гучно, а не пише нуль рядків. Тест — Задача 3 (DB).
5. **Режим `replica`:** фаза відмовляє `apply.replication-role`. Тест — Задача 3 (unit).

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/compiler/rights/carrier-units.ts` | `carrierBackfillStatements` |
| `packages/simetra/src/schema/apply/carrier-backfill.ts` | `pendingCarrierCopies` (нове ім'я), `carrierBackfillSteps`; без `carrierBackfillRefusals` |
| `packages/simetra/src/schema/apply/{steps,artifact}.ts` | `origin: "carriers"`, `PLAN_FORMAT` 6 |
| `packages/simetra/src/schema/apply/plan.ts` | кроки в обох гілках, без `carrierBackfillGate` |
| `packages/simetra/src/schema/apply/execute.ts` | фаза `carriers`, `ORIGIN_ORDER` |
| `packages/simetra/src/compiler/{diagnostics,messages}.ts` | без `plan.carrier-backfill-missing` |
| `packages/simetra/test/db/carrier-backfill.db.test.ts` | гучна відмова кроку на `FORCE ROW LEVEL SECURITY` |
| `packages/designer/src/schema-engine/__tests__/carrier-backfill.db.test.ts` (новий) | кроки на живих рядках |
| `packages/designer/skills/simetra-metadata/SKILL.md` | крок копій замість відмови |

---

### Задача 0: правки спек

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§5.2), `docs/superpowers/specs/2026-10-06-promotion-design.md` (§7.2), `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (§6.2)

- [ ] **Step 1:** Спека прав §5.2 — речення «Поява нового носія … крок даних плану, що заповнює носії (…), під бенчмарком розгалуження §5.4; до кроку даних (план Права-2b) — відмова плану» → «… крок даних плану, що заповнює носії (…), під бенчмарком розгалуження §5.4; крок іде після кроків двигуна в тій самій транзакції, бере значення лише з рядка, на який указує складений FK, і не вимикає тригерів».
- [ ] **Step 2:** Спека промоції §7.2, «Порядок транзакції» — після пункту «кроки двигуна»: «**кроки копій носіїв прав** ([спека прав](2026-10-17-rights-design.md) §5.2) — після кроків двигуна (колонку-копію створює двигун) і до кроків середовища, у нових іменах, під закріпленими налаштуваннями даних; тригери не вимикаються: тригер носіїв перевиводить ту саму копію, а механіка й підписки зміну лише копій ігнорують».
- [ ] **Step 3:** Платформна спека §6.2 — пункт «Застосування»: перевірити (`grep -n "крок" docs/superpowers/specs/2026-09-24-simetra-platform-design.md`), чи є перелік блоків кроків; якщо є — додати блок кроків копій носіїв між двигуном і середовищем з посиланням на спеку промоції §7.2; якщо немає — правки не потрібно (записати в позначці кроку).
- [ ] **Step 4:** Run: `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs
git commit -m "docs(spec): крок даних копій носіїв після кроків двигуна"
```

---

### Задача 1: SQL кроку копій у компіляторі

**Files:**
- Modify: `packages/simetra/src/compiler/rights/carrier-units.ts`, `compiler/index.ts` (експорт)
- Test: `packages/simetra/src/compiler/__tests__/carrier-units.test.ts`

**Interfaces:**
- Consumes: `fieldForeignKey`, `carrierCopies`, `origin.copyOf`.
- Produces: `carrierBackfillStatements(physical: PhysicalSnapshot, pending: readonly { table: QualifiedName; columns: readonly string[] }[]): { table: QualifiedName; source: QualifiedName; sql: string }[]` — у порядку Р2b2-3.

- [ ] **Step 1: Write the failing tests (unit)** над фізичним знімком `policyDomain()`:
  - `it("backfills copies through the composite key of their link")`: очікувані `task_checklist` (`assignee_id`, `region_id`, `project_id`) → рівно один оператор, дерево якого — `UPDATE <схема>.task_checklist AS d SET assignee_id = s.assignee_id, project_id = s.project_id, region_id = s.region_id FROM <схема>.task AS s WHERE d.org_id = s.org_id AND d.parent_id = s.id AND (d.assignee_id IS DISTINCT FROM s.assignee_id OR …)` (порівняння — деревами розбору без позицій); лише очікувані колонки потрапляють у `SET`.
  - `it("orders a copy after the copy it reads")`: очікувані `task_comment_attachments` (копія копії шляху) і `task_comment` (копія шляху) у будь-якому вхідному порядку → спершу `task_comment`, потім `task_comment_attachments`.
  - `it("the backfill joins like the propagation trigger")`: пари `WHERE` оператора `task_comment` дорівнюють парам `UPDATE` у функції поширення `task_simetra_carriers_out` (Р2a2-27) для того самого `through`.
- [ ] **Step 2:** Run: `pnpm --filter simetra test carrier-units` — FAIL.
- [ ] **Step 3: Implement** — пари й колонки з тих самих помічників, що функція поширення (виділити спільний помічник, не копіювати); коментар «чому» — Р2b2-2 (FK, `IS DISTINCT FROM`, перевиведення тригером).
- [ ] **Step 4:** Run: `pnpm --filter simetra test carrier-units` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): SQL кроку даних копій носіїв за ключем зв'язку"
```

---

### Задача 2: кроки плану замість відмови

**Files:**
- Modify: `packages/simetra/src/schema/apply/carrier-backfill.ts`, `schema/apply/steps.ts` (`PlanStep.origin`), `schema/apply/artifact.ts` (`PLAN_FORMAT`, схема `origin`), `schema/apply/plan.ts`, `schema/apply/index.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/carrier-backfill.test.ts`, `plan.test.ts`, `artifact.test.ts`, `steps.test.ts`, `packages/simetra/src/compiler/__tests__/messages.test.ts`

**Interfaces:**
- Consumes: `carrierBackfillStatements` (Задача 1).
- Produces: `pendingCarrierCopies(desired, applied, created, oldName?)` — `table` у бажаному імені (Р2b2-6); `carrierBackfillSteps(desired: Pick<PhysicalSnapshot, "tables">, pending: readonly PendingCarrierCopies[], offset: number): PlanStep[]` (Р2b2-1).

- [ ] **Step 1: Write the failing tests (unit):**
  - `carrier-backfill.test.ts`: таблиця `pendingCarrierCopies` лишається; кейс `promotion` перевертається — `table` у новому імені (`task_note`), шукана в `applied` за старим; `describe("carrierBackfillRefusals")` замінити на `describe("carrierBackfillSteps")`: `it("one dataStep per link, after the given offset")` — id `s<offset+1>…`, `origin: "carriers"`, `class: "dataStep"`, `lockClass: "shareRowExclusive"`, `lockedTables` — залежна й джерело, SQL — з `carrierBackfillStatements`; `it("no steps without pending copies")` — `[]`.
  - `plan.test.ts`: `it.each(["plan", "plan with a promotion"])("refuses a new carrier copy …")` перевернути на `it.each(…)("plans a carrier step for a new copy on an existing table ($case)")` — `status` не `"refused"`, кроки `carriers` для `CHECKLIST_TABLE` після кроків двигуна й до кроків середовища, жодного запиту `EXISTS` до цілі (фейкова база не отримує його), `ATTACHMENTS_TABLE` (створює план) кроку не має; `it("reads and refuses a table renamed by the promotion under its old name")` → `it("a table renamed by the promotion gets its step in the new name")` — SQL кроку називає `task_note` і колонку `task_id_assignee_id`; `lockedTables` у новому імені, `plan.locks` — у старому (`task_notes`) з `shareRowExclusive`.
  - `artifact.test.ts`: план з кроком `carriers` проходить схему формату 6; формат 5 — відмова формату, як для наявних змін формату.
  - `steps.test.ts`: `requiredPermissions` не просить дозволу на крок `dataStep` походження `carriers`.
  - `messages.test.ts`: коду `plan.carrier-backfill-missing` немає.
- [ ] **Step 2:** Run: `pnpm --filter simetra test carrier-backfill plan artifact steps messages` — FAIL.
- [ ] **Step 3: Implement:** `origin` — `"intent" | "engine" | "carriers" | "environment"` (тип і zod-схема), `PLAN_FORMAT = 6`; у `buildPlan` замість `carrierBackfillGate` — кроки після кроків двигуна (у промоції — після наміру й двигуна) з `offset` = кількість уже наявних кроків і до `collectEnvironment`, у `steps` якого вони вже входять (`offset` середовища — `p.steps.length`, Р2b2-7); слід і `plan.locks` — наявним шляхом (`stepFootprint` для не-`intent` переводить нові імена у вихідні). Видалити `carrierBackfillRefusals`, `carrierBackfillGate`, код і тексти `plan.carrier-backfill-missing`.
- [ ] **Step 4:** Run: `pnpm --filter simetra test carrier-backfill plan artifact steps messages locks execute` — PASS (тест упорядкування кроків за походженням у `execute.ts` — Задача 3, тож якщо він уже тут червоніє через `ORIGIN_ORDER`, додати `"carriers"` до `ORIGIN_ORDER` у цьому ж коміті).
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(schema): крок даних копій носіїв замість відмови плану"
```

---

### Задача 3: фаза кроків копій у застосуванні

**Files:**
- Modify: `packages/simetra/src/schema/apply/execute.ts`
- Modify: `packages/simetra/test/db/carrier-backfill.db.test.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/execute.test.ts`

**Interfaces:**
- Produces: `runCarrierSteps(tx: ApplyTransaction, steps: readonly PlanStep[], parse: SqlParser, onStep: (id: string) => void): Promise<void>` (експорт `execute.ts` для DB-тесту; не з `index.ts`) — перевірка `session_replication_role`, далі `withLocalSettings(tx, DATA_SETTINGS, …)` над кроками; `requireOriginReplication(tx: ApplyTransaction): Promise<void>` — спільний помічник фаз 8 і `carriers`.

- [ ] **Step 1: Write the failing tests (unit)** у `execute.test.ts` (фейкова `ApplyTransaction`, за зразком блоку `data steps`):
  - `it("runs carrier steps after the engine and before the environment, under the data settings")` — журнал запитів: SQL кроку `carriers` — після останнього кроку двигуна й до першого кроку середовища; між ними — `SET LOCAL` кожного з `DATA_SETTINGS`, зокрема `row_security = off`, і повернення налаштувань після; фаза `carriers` у звіті фаз.
  - `it("refuses carrier steps in replica mode")` — `session_replication_role = 'replica'` → `apply.replication-role`, жодного SQL кроку.
  - `it("disables no triggers for carrier steps")` — у журналі немає `DISABLE TRIGGER`.
- [ ] **Step 2:** Run: `pnpm --filter simetra test execute` — FAIL.
- [ ] **Step 3: Implement** фазу за Р2b2-4; фаза 8 бере `requireOriginReplication` (без зміни поведінки). Коментар «чому» — колонку створює двигун (фаза 11), тригери не вимикаються.
- [ ] **Step 4: DB test** `carrier-backfill.db.test.ts` (причина DB-рівня — `FORCE ROW LEVEL SECURITY` і `row_security` вирішує Postgres): кейс перевертається з відмови на крок — таблиця з `FORCE ROW LEVEL SECURITY` і рядком, власник — тегована роль `NOBYPASSRLS`, сесія під нею; `runCarrierSteps` з кроком над цією таблицею кидає помилку Postgres (`42501`), а не пише нуль рядків. Мутація: прибрати `DATA_SETTINGS` з фази — крок пише нуль рядків, тест червоніє.
- [ ] **Step 5:** Run: `pnpm --filter simetra test execute` і `pnpm --filter simetra exec vitest run --project db carrier-backfill` — PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/simetra
git commit -m "feat(schema): фаза кроків копій носіїв після кроків двигуна"
```

---

### Задача 4: кроки на живих рядках (designer)

**Files:**
- Create: `packages/designer/src/schema-engine/__tests__/carrier-backfill.db.test.ts`

Причина DB-рівня (шапка файлу): що двигун створить колонку до кроку, що тригери носіїв, механіки й підписок зроблять на `UPDATE` кроку і що промоція перейменує таблицю до нього — вирішує Postgres на живих рядках.

- [ ] **Step 1: Write the test** за зразком `build-plan-promotion-data.db.test.ts` (помічники `build-plan.support.ts`, фікстури — `simetra/test/support`), один опис, одна тінь на кейс:
  - `it("a plain plan backfills a path copy and the tabular copy reading it")`: вихідна модель — `policyDomain()` з перевизначеннями: `Task` без `ownership` (реквізит `assignee` лишається; гранти `own` на `Task` і на об'єкти з носієм через `Task` прибрати разом, щоб модель компілювалася без помилок), `TaskComment` і `TaskReport` без `ownership`, ТЧ `checklist` з реквізитом `assignee` (Р2b2-8; поки носія немає, `rights.carrier-column-taken` не спрацьовує); засіяти задачу (`assignee` = u1), рядок `checklist` з `assignee` = u2, коментар із вкладенням; записати `version` коментаря й лічильник підписки `onWrite`; побудувати й застосувати план до `policyDomain()` → у плані кроки `carriers` для `task_comment`, `task_comment_attachments`, `task_checklist`, причому `task_comment` раніше за `task_comment_attachments` (Р2b2-3); після `COMMIT`: копія шляху коментаря й копія вкладення = u1, `assignee_id` рядка `checklist` = u1, `version` коментаря не змінилася, лічильник підписки не зріс.
  - `it("a promotion backfills the copy of the renamed table")`: прийнята таблиця `promotableTaskNote()` з рядком, що посилається на задачу з `assignee` = u1; промоція `taskNoteMapping()` до `COMMIT` (репетиція — за наявним сценарієм промоції) → `task_note.task_id_assignee_id` = u1.
- [ ] **Step 2:** Run: `pnpm --filter @simetrajs/designer exec vitest run --project db carrier-backfill` — PASS. **Мутаційний доказ** (вручну, без коміту): прибрати кроки `carriers` з плану — обидва кейси червоніють (копії `NULL`, `assignee_id` рядка `checklist` = u2); поставити фазу `carriers` до кроків двигуна — застосування падає `42703` (колонки ще немає); у промоції брати `pendingCarrierCopies` у старому імені — кейс `promotion` падає `42P01`. Порядок Р2b2-3 і `IS DISTINCT FROM` доводять unit-тести Задачі 1: на даних їх маскує поширення 2a2 і умова механіки.
- [ ] **Step 3: Commit**

```bash
git add packages/designer/src
git commit -m "test(designer): крок копій носіїв на живих рядках — план і промоція"
```

---

### Задача 5: скіл, гейти й заміри

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md`, `docs/ROADMAP.md`, цей план (позначки)

- [ ] **Step 1:** Скіл споживача (англійською): нова копія носія на таблиці з рядками заповнюється кроком плану `carriers` (клас `dataStep`, без дозволу) після кроків двигуна; крок займає `SHARE ROW EXCLUSIVE` на таблиці й джерелі до кінця застосування; речення про відмову плану прибрати.
- [ ] **Step 2:** Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — код 0.
- [ ] **Step 3:** Run: `pnpm metadata:check && python3 scripts/check-doc-anchors.py && .agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-24-rights-2b2-carrier-backfill.md` — код 0.
- [ ] **Step 4:** Повний `pnpm test:db` на одному SHA (у фоні, таймаут не коротший за 45 хв): `/usr/bin/time -f %e pnpm test:db` — код 0 (або CI job `db`); приріст проти прогону після 2b1 ≤ 30 с, разом з 2b1 ≤ 45 с, інакше звіт архітектору з розкладом за файлами.
- [ ] **Step 5:** ROADMAP — «Права-2b виконано»; позначки плану.
- [ ] **Step 6: Commit**

```bash
git add packages/designer/skills docs/ROADMAP.md docs/superpowers/plans/2026-10-24-rights-2b2-carrier-backfill.md
git commit -m "docs(plan): Права-2b2 виконано — скіл, ROADMAP, позначки"
```

## Критерії приймання

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py` — зелені після **кожного** коміту; повний `pnpm test:db` — зелений на одному SHA, приріст записано.
- Коду, повідомлень і тестів відмови `plan.carrier-backfill-missing` немає; її кейси стали кейсами кроку (Задача 2).
- `PLAN_FORMAT` = 6; крок `carriers` — між двигуном і середовищем, під `DATA_SETTINGS`, без вимкнення тригерів (Задача 3).
- Ланцюг «копія шляху → копія ТЧ» і промоція заповнюються на живих рядках без росту `version` залежних рядків (Задача 4).
- Спека прав §5.2 і спека промоції §7.2 оновлені (Задача 0).
