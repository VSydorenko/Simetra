# Права-2b2: крок даних копій носіїв — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: прийнято архітектором 2026-10-24 після 4 раундів аудиту автора й аудиту Codex.
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
  лише з `row_security = off` (`CARRIER_STEP_SETTINGS`).
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
- 🔴 Крок даних — під `CARRIER_STEP_SETTINGS` = лише `row_security = off` (на таблиці з `FORCE ROW LEVEL SECURITY` — гучна помилка, не тихий нуль), **не** під `DATA_SETTINGS`: закріплений `search_path = pg_catalog, pg_temp` зламав би тіло дослівного чи прийнятого тригера, що називає об'єкти без схеми (Р2b2-9); і з перевіркою `session_replication_role = 'origin'` (у `replica` тригери носіїв не спрацювали б).
- Кожен ідентифікатор у SQL кроку — кваліфікований і в лапках (`quoteIdent`), рівність пар FK — `OPERATOR(pg_catalog.=)`: крок іде під `search_path` транзакції (Р2b2-9) і від нього не залежить.
- Залишковий код без споживача (`carrierBackfillGate` — Задача 2; `carrierBackfillRefusals`, код `plan.carrier-backfill-missing` і його тексти — Задача 3, разом з переписаним DB-тестом, що його імпортує) — видалити, без шимів.
- Між задачами гейти не червоні; скіл `.agents/skills/writing-tests/SKILL.md` обов'язковий перед кроками тестів.
- Репо публічне: фікстури синтетичні.

## Рішення плану

Розвилки (б) і (в) вирішив архітектор задачі 2026-10-24.

| # | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р2b2-1 | Крок даних копій — `PlanStep` з `origin: "carriers"`, `class: "dataStep"`, `verb: "alter"`, `lockClass: "shareRowExclusive"`, `transactionality: "transactional"`, SQL відрендерено під час плану; `lockedTables` — залежна таблиця й таблиця-джерело (у нових іменах; слід переводить у вихідні, як для кроку двигуна); `produces`/`consumes`/`destroys`, структурні поля й `guards` — порожні; `dataLoss`, `rewriteRisk`, `newSegmentBefore` — `false`. Дозволу не потребує (`NEEDS_PERMISSION` — лише `destructive`, `relaxation`). `ORIGIN_ORDER` = `["intent", "engine", "carriers", "environment"]`; id наскрізні: кроки `carriers` — після кроків двигуна й до кроків середовища. `PLAN_FORMAT` 5 → 6 (нове значення `origin` у схемі артефакту) | план показує SQL, клас і замок, як для інших кроків; у звичайному плані `promotion === null`, тож `PromotionSection.data` не годиться | спека прав §5.2 — «крок даних плану» без «до кроку даних — відмова»; спека промоції §7.2 і платформна §6.2 — блок кроків копій (Задача 0) |
| Р2b2-2 | SQL кроку — один оператор на (залежна таблиця, `through`), форма виведення тригера носіїв (`SELECT … INTO` дає `NULL`, коли рядка джерела немає): `UPDATE <залежна> AS d SET (<копія>, …) = (SELECT s.<колонка>, … FROM <джерело> AS s WHERE s.<колонка FK джерела> = d.<локальна FK> AND …) WHERE d.<копія₁> IS DISTINCT FROM (SELECT s.<колонка₁> FROM <джерело> AS s WHERE …) OR d.<копія₂> IS DISTINCT FROM (SELECT s.<колонка₂> …) OR …` — умова по колонці, як у функції поширення (Postgres порівнює рядок з підзапитом лише операторами `=`, `<>`, `<`…, а не `IS DISTINCT FROM`: форма `(d.a, d.b) IS DISTINCT FROM (SELECT …)` дає `42601` за двох і більше копій; `ROW(…) IS DISTINCT FROM (SELECT ROW(…))` вважав би рядок без зв'язку з `NULL`-копіями відмінним щоразу й будив би підписку; аудит, раунд 2); пари — `fieldForeignKey(<залежна>, through)`, копії — лише очікувані. Рядок з `NULL` у зв'язку отримує `NULL`-копію, а не зберігає старе значення під іменем копії (`UPDATE … FROM` з внутрішнім з'єднанням його б пропустив — витік Р2a2-11; аудит, раунд 1). `IS DISTINCT FROM` не чіпає вже узгоджених рядків (без зайвих `UPDATE`). `BEFORE`-тригер носіїв на цьому `UPDATE` сам перевиводить змінену копію з джерела (`forged-copy-update` 2a2): значення з `SET` перезаписується тим самим — це очікувано | та сама форма, що виведення Р2a2-7, пари — Р2a2-27; рядок джерела — саме той, на який указує FK | немає |
| Р2b2-3 | Порядок операторів — за залежностями копій: оператор копії, чий `copyOf` читає іншу очікувану копію (копія ТЧ читає копію шляху власника), — після неї; решта — за (`schema`, `name`, `through`) кодовими одиницями. Поширення 2a2 й так заповнює наступний крок двоходово, тож другий оператор знаходить рядки вже узгодженими | детермінований план; двоходовий ланцюг не залежить від порядку тригерів | немає |
| Р2b2-4 | Фаза `carriers` у `runAttempt` — між 11 (двигун) і 12 (середовище): `withLocalSettings(tx, CARRIER_STEP_SETTINGS, …)` над `runSteps` блоку `carriers`, перед ним — та сама перевірка `session_replication_role`, що у фазі 8 (спільний помічник, а не копія); фаза (перевірка, налаштування) — лише коли блок `carriers` непорожній, тож журнали плану без копій не змінюються. Тригери не вимикаються: тригер носіїв перевиводить ту саму копію, `contentChangeCondition` придушує механіку й підписки (версія залежних рядків не росте), тригер ефектів 2b1 без контексту мовчить | колонку-копію створює двигун у фазі 11; кроки даних промоції (фаза 10) — до двигуна, тож вони не годяться | спека промоції §7.2 «Порядок транзакції» — пункт «кроки копій носіїв — після кроків двигуна, до кроків середовища, з `row_security = off`, без вимкнення тригерів» (Задача 0) |
| Р2b2-5 | Замок `SHARE ROW EXCLUSIVE` на залежній таблиці й таблиці-джерелі (у `plan.locks`, від початку транзакції): конкурентна зміна носія власника між читанням кроку й `COMMIT`, коли тригер поширення не перестворюється в цьому плані, лишила б застарілу копію. Залежну таблицю, якій двигун додає колонку, уже займає `ACCESS EXCLUSIVE` (`joinModes`) | `SHARE ROW EXCLUSIVE` блокує чужий DML обох таблиць і не конфліктує з власними замками транзакції | немає |
| Р2b2-6 | Промоція — та сама фаза, нові імена: `pendingCarrierCopies` повертає таблицю **в бажаному (новому) імені**, а старе ім'я (`oldName`) лише шукає її в знімку `applied` (`promotion.source`). Доказ збереження промоції копій не міряє (`PreservedTable.columns` — явний перелік змаплених колонок) | після кроків двигуна таблиці вже в нових іменах | немає |
| Р2b2-7 | Крок генерується на кожну очікувану копію незалежно від наявності рядків: план не читає ціль (`carrierBackfillGate` і читальна транзакція зникають). На порожній таблиці крок пише нуль рядків. Копії залишаються в кроці середовища копії (`runOnClone` виконує й кроки `carriers` — на копії без рядків це нуль рядків) | план — дані; одна логіка для порожньої й непорожньої таблиці | немає |
| Р2b2-9 | Налаштування фази — лише `row_security = off` (`CARRIER_STEP_SETTINGS`), а не `DATA_SETTINGS`: закріплені налаштування даних потрібні для детермінованості виразу (спека промоції §4, §7.2), а крок копій нічого не обчислює й не приводить — він переносить значення колонки в колонку того самого типу; закріплений `search_path` зламав би тіло дослівного чи прийнятого тригера на таблиці (функції тригерів платформи мають власний `search_path = ''`) (аудит, раунд 1) | тригери не вимикаються (Р2b2-4), тож їхні тіла мусять іти під налаштуваннями транзакції | спека промоції §7.2 — у пункті кроків копій «з `row_security = off`» (Задача 0) |
| Р2b2-8 | Колонка з іменем копії, що копією не була (видалений реквізит з даними, прийнята колонка), — очікувана копія, як у 2a2 (`same-name-not-copy`): крок перезаписує її значення виведеними з джерела; клас і дозвіл такого кроку — Р2b2-11 | старі значення під іменем копії не є копією (Р2a2-11) | немає |
| Р2b2-10 | DB-кейс, що доводить мовчання тригера ефектів 2b1 під кроком даних (`version` не росте, підписка не спрацювала), спершу явно перевіряє наявність `<t>_simetra_effects` на таблиці з копією (`pg_trigger`). Мутація: прибрати генерацію тригера ефектів → кейс червоний на перевірці наявності, а не зелений | висновок «тригер мовчить» не має бути доведений порожньо (уточнення архітектора задачі 2026-10-24) | немає |
| Р2b2-11 | `pendingCarrierCopies` розрізняє для кожної очікуваної копії, чим її колонка була в знімку `applied`: (1) колонки не було — чисте заповнення; (2) копія з іншим `copyOf` — похідні значення; обидва — крок `dataStep` без дозволу; (3) звичайна колонка (видалений реквізит з даними, прийнята колонка, яку мапінг промоції не взяв) — крок класу `destructive` з `dataLoss: true` і дозволом за id кроку, як для інших деструктивних кроків (`requiredPermissions` → `apply.permission-required` у `executePlan` без `allow`). Колонки випадку 3 — поле `overwrites` очікуваної таблиці; крок — один оператор на (таблицю, `through`), тож оператор, що пише хоч одну колонку випадку 3, — увесь `destructive` (оператор знає свої колонки — поле `columns` у `carrierBackfillStatements`). Колонка, яку створює двигун у цьому плані (Р2b2-12), — випадок 1, хоч би що було в знімку: її старі дані губить крок двигуна, що зняв колонку, і дозвіл просить він | перезапис чужих даних — втрата даних, яку автор має дозволити, як видалення реквізиту з даними; уточнення архітектора на прийманні 2026-10-24 | спека прав §5.2 — речення про колонку з іменем копії, що копією не була |
| Р2b2-12 | Копія, чию колонку створює дія двигуна в цьому ж плані (структурний `produced` дії: `{ kind: "column", schema, table, name }` у бажаних іменах), — завжди очікувана, хоч би що казав знімок `applied`: адміністратор міг вручну зняти колонку-копію, а власник — прийняти дрейф; двигун відтворює колонку порожньою, знімок вважає копію живою, і без кроку рядки тихо сховано. Таблиця, яку план створює цілком, — як і раніше без кроку (рядків немає) | знімок marker не доводить, що колонка на цілі ще та сама; колонку, створену планом, план і заповнює; уточнення архітектора на прийманні 2026-10-24 | спека прав §5.2 — «колонку-копію, створену планом, план і заповнює» |
| Р2b2-13 | Без знімка таблиці в `applied` (ціль без marker — перше застосування поверх наявної схеми; або таблиця, якої знімок не знає, а план не створює) кожна очікувана копія в колонці, яку план не створює, на таблиці, яку план не створює, — випадок 3 Р2b2-11 (`overwrites`, крок `destructive` з `dataLoss: true`). Колонка, створена планом (Р2b2-12), і таблиця, створена планом, — без дозволу | без marker план не знає історії колонки, а невідоме трактуємо як дані; ціна — один зайвий дозвіл на першому застосуванні поверх наявної схеми; рішення архітектора на прийманні 2026-10-24; таблиця поза знімком — той самий принцип «невідоме — дані» (виконавець) | спека прав §5.2 — «без знімка останнього застосування наявна колонка з іменем копії вважається колонкою з даними» |

## Відомі обмеження

- Розгалуження поширення (сотні тисяч рядків ТЧ під одним власником) і час
  кроку на великих таблицях міряє бенчмарк 2d; крок займає `SHARE ROW
  EXCLUSIVE` до `COMMIT`.
- Дослівний тригер на таблиці виду (заборона — 2c) бачить `UPDATE` кроку,
  що змінює лише копії.
- Дослівний тригер з правами викликача, що читає RLS-таблицю чужого власника, під `row_security = off` кроку дає `42501` — застосування падає гучно, нічого не зіпсовано; платформні функції тригерів (носіїв, ефектів 2b1) — `SECURITY DEFINER`, механіка запитів не робить.
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
| `packages/simetra/src/schema/apply/execute.ts` | `ORIGIN_ORDER` і блоки за іменем походження (Задача 2), фаза `carriers` (Задача 3) |
| `packages/simetra/src/schema/apply/settings.ts` | `CARRIER_STEP_SETTINGS` |
| `packages/simetra/src/schema/apply/rehearsal.ts` | фаза `carriers` у `REHEARSAL_PHASES` |
| `packages/simetra/src/compiler/{diagnostics,messages}.ts` | без `plan.carrier-backfill-missing` |
| `packages/simetra/test/db/carrier-backfill.db.test.ts` | гучна відмова кроку на `FORCE ROW LEVEL SECURITY` |
| `packages/designer/src/schema-engine/__tests__/carrier-backfill.db.test.ts` (новий) | кроки на живих рядках |
| `packages/designer/skills/simetra-metadata/references/people-and-rights.md` | крок копій замість відмови |

---

### Задача 0: правки спек

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§5.2), `docs/superpowers/specs/2026-10-06-promotion-design.md` (§7.2), `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (§6.2)

- [x] **Step 1:** Спека прав §5.2 — речення «Поява нового носія … крок даних плану, що заповнює носії (…), під бенчмарком розгалуження §5.4; до кроку даних (план Права-2b) — відмова плану» → «… крок даних плану, що заповнює носії (…), під бенчмарком розгалуження §5.4; крок іде після кроків двигуна в тій самій транзакції, бере значення лише з рядка, на який указує складений FK, і не вимикає тригерів».
- [x] **Step 2:** Спека промоції §7.2, абзац «Закріплені налаштування даних» — перше речення «Кроки даних і заміри збереження … йдуть під закріпленими налаштуваннями» звузити до «Кроки даних промоції (вирази `fill`) і заміри збереження …» з відсиланням: «кроки копій носіїв прав нічого не обчислюють і йдуть лише з `row_security = off` (пункт нижче)». «Порядок транзакції» — у вступному реченні «Кроки йдуть блоками за походженням — наміру, двигуна, середовища» додати «копій носіїв» між двигуном і середовищем; після пункту «кроки двигуна»: «**кроки копій носіїв прав** ([спека прав](2026-10-17-rights-design.md) §5.2) — після кроків двигуна (колонку-копію створює двигун) і до кроків середовища, у нових іменах, з `row_security = off` (інші налаштування даних не закріплюються: крок нічого не обчислює, а тригери на таблиці йдуть під налаштуваннями транзакції); тригери не вимикаються: тригер носіїв перевиводить ту саму копію, а механіка й підписки зміну лише копій ігнорують; дослівний тригер з правами викликача, що читає чужу RLS-таблицю, під `row_security = off` дає гучну відмову».
- [x] **Step 3:** (переліку блоків кроків у §6.2 немає — правки не потрібно) Платформна спека §6.2 — пункт «Застосування»: перевірити (`grep -n "крок" docs/superpowers/specs/2026-09-24-simetra-platform-design.md`), чи є перелік блоків кроків; якщо є — додати блок кроків копій носіїв між двигуном і середовищем з посиланням на спеку промоції §7.2; якщо немає — правки не потрібно (записати в позначці кроку).
- [x] **Step 4:** Run: `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [x] **Step 5: Commit**

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
- Produces: `carrierBackfillStatements(physical: Pick<PhysicalSnapshot, "tables">, pending: readonly { table: QualifiedName; columns: readonly string[] }[]): { table: QualifiedName; source: QualifiedName; sql: string }[]` — у порядку Р2b2-3; очікувана таблиця чи колонка, якої немає в знімку або яка не є копією, — внутрішня помилка `internal: pending carrier <схема>.<таблиця>.<колонка> is not a copy in the desired snapshot` (тест `it("refuses a pending copy the snapshot does not know")`).

- [x] **Step 1: Write the failing tests (unit)** над фізичним знімком `policyDomain()`:
  - `it("backfills copies through the composite key of their link")`: очікувані `task_checklist` (`assignee_id`, `region_id`, `project_id`) → рівно один оператор, дерево якого — `UPDATE <схема>.task_checklist AS d SET (assignee_id, project_id, region_id) = (SELECT s.assignee_id, s.project_id, s.region_id FROM <схема>.task AS s WHERE s.org_id = d.org_id AND s.id = d.parent_id) WHERE d.assignee_id IS DISTINCT FROM (SELECT s.assignee_id FROM <схема>.task AS s WHERE …) OR d.project_id IS DISTINCT FROM (…) OR d.region_id IS DISTINCT FROM (…)` (порівняння — деревами розбору без позицій; рівність пар — `OPERATOR(pg_catalog.=)`); лише очікувані колонки потрапляють у `SET`. Дерево сирого розбору не доводить, що Postgres прийме форму, — це доводить DB-кейс Задачі 4 з трьома копіями на одному зв'язку.
  - `it("a row without a link gets a NULL copy")`: форма — підзапит у `SET`, а не `UPDATE … FROM` (немає `fromClause` в корені `UpdateStmt`): рядок з `NULL` у зв'язку отримує `NULL`, а не лишає старе значення (Р2b2-2). Мутація: форма `UPDATE … FROM` — тест червоніє; на даних — кейс Задачі 4.
  - `it("orders a copy after the copy it reads")`: знімок `policyDomain()` з перевизначеним `physicalName` ТЧ `attachments` коментаря на `a_comment_files` (тож запасний порядок за іменем ставив би її **раніше** за `task_comment`); очікувані `a_comment_files` (копія копії шляху) і `task_comment` (копія шляху) у кожному з двох вхідних порядків → спершу `task_comment`, потім `a_comment_files`. Мутація: прибрати сортування за залежністю — тест червоніє.
  - `it("the backfill joins like the propagation trigger")`: пари умови підзапиту оператора `task_comment` дорівнюють парам `UPDATE` у функції поширення `task_simetra_carriers_out` (Р2a2-27) для того самого `through`.
- [x] **Step 2:** Run: `pnpm --filter simetra test carrier-units` — FAIL.
- [x] **Step 3: Implement** — пари й колонки з тих самих помічників, що функція поширення (виділити спільний помічник, не копіювати); коментар «чому» — Р2b2-2 (FK, `IS DISTINCT FROM`, перевиведення тригером).
- [x] **Step 4:** Run: `pnpm --filter simetra test carrier-units` — PASS.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): SQL кроку даних копій носіїв за ключем зв'язку"
```

---

### Задача 2: кроки плану замість відмови

**Files:**
- Modify: `packages/simetra/src/schema/apply/carrier-backfill.ts`, `schema/apply/steps.ts` (`PlanStep.origin`), `schema/apply/artifact.ts` (`PLAN_FORMAT`, схема `origin`), `schema/apply/plan.ts`, `schema/apply/execute.ts` (`ORIGIN_ORDER`, блоки), `schema/apply/rehearsal.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/carrier-backfill.test.ts`, `plan.test.ts`, `artifact.test.ts`, `steps.test.ts`, `execute.test.ts`

**Interfaces:**
- Consumes: `carrierBackfillStatements` (Задача 1).
- Produces: `pendingCarrierCopies(desired, applied, created, oldName?)` — `table` у бажаному імені (Р2b2-6); `carrierBackfillSteps(desired: Pick<PhysicalSnapshot, "tables">, pending: readonly PendingCarrierCopies[], offset: number): PlanStep[]` (Р2b2-1).

- [x] **Step 1: Write the failing tests (unit):**
  - `carrier-backfill.test.ts`: таблиця `pendingCarrierCopies` лишається; кейс `promotion` перевертається — `table` у новому імені (`task_note`), шукана в `applied` за старим; `describe("carrierBackfillRefusals")` поки лишається (функцію видаляє Задача 3 разом з її DB-тестом — `tsconfig` пакета включає `test`, тож видалення тут зробило б `typecheck` червоним); новий `describe("carrierBackfillSteps")`: `it("one dataStep per link, after the given offset")` — id `s<offset+1>…`, `origin: "carriers"`, `class: "dataStep"`, `lockClass: "shareRowExclusive"`, `lockedTables` — залежна й джерело, SQL — з `carrierBackfillStatements`; `it("no steps without pending copies")` — `[]`.
  - `plan.test.ts`: `it.each(["plan", "plan with a promotion"])("refuses a new carrier copy …")` перевернути на `it.each(…)("carrier copy steps reach the footprint without a read of the target ($case)")`: обидва кейси беруть `emptyScratch`; фейкова ціль не має глобальних ADP (збір середовища копії не бере, а `pg_default_acl` читає й `readWritePath` промоції, тож кидок на ньому зупинив би промоцію до кроків копій) і зупиняє план на читанні права `LOCK` таблиць сліду в `lockPlan` — уже після кроків копій і збору середовища. Тест перевіряє, що слід питає `task_checklist` і її джерело `task`, а `attachments` (створює план) — ні; мутації «відмова перед кроками копій» і «`created` порожній» червоніють. Зв'язку перевіряє `carrier-backfill.test.ts` прямим ланцюгом `pendingCarrierCopies` → `carrierBackfillSteps` → `stepFootprint` над знімками тих самих фікстур: крок для `CHECKLIST_TABLE` є, для `ATTACHMENTS_TABLE` (створює план) — ні; повний статус і порядок «двигун → копії → середовище» доводить DB-тест Задачі 4. `it("reads and refuses a table renamed by the promotion under its old name")` переноситься в `carrier-backfill.test.ts` як `it("a table renamed by the promotion gets its step in the new name")` — SQL кроку називає `task_note` і колонку `task_id_assignee_id`, `lockedTables` у новому імені; `stepFootprint(<крок>, <моделі>)` дає `task_notes` (старе ім'я) і `task` у режимі `shareRowExclusive`.
  - `artifact.test.ts`: наявне `expect(PLAN_FORMAT).toBe(5)` → `toBe(6)`; план з кроком `carriers` проходить схему формату 6; формат 5 — відмова формату, як для наявних змін формату.
  - `steps.test.ts`: `requiredPermissions` не просить дозволу на крок `dataStep` походження `carriers`.
- [x] **Step 2:** Run: `pnpm --filter simetra test carrier-backfill plan artifact steps execute` — FAIL.
- [x] **Step 3: Implement:** `origin` — `"intent" | "engine" | "carriers" | "environment"` (тип і zod-схема), `PLAN_FORMAT = 6`; у `buildPlan` замість `carrierBackfillGate` — кроки після кроків двигуна (у промоції — після наміру й двигуна) з `offset` = кількість уже наявних кроків і до `collectEnvironment`, у `steps` якого вони вже входять (`offset` середовища — `p.steps.length`, Р2b2-7); слід і `plan.locks` — наявним шляхом (`stepFootprint` для не-`intent` переводить нові імена у вихідні). Видалити `carrierBackfillGate` (споживачів більше немає); `carrierBackfillRefusals` і код — Задача 3.
- [x] **Step 3a:** У цьому ж коміті — `execute.ts`: `ORIGIN_ORDER` = `["intent", "engine", "carriers", "environment"]`, текст помилки порядку (`plan steps are out of origin order: …`) — з чотирма походженнями; блоки — **за іменем походження**, а не за позицією (`blocks[1]`/`blocks[2]` у `runAttempt` інакше мовчки зсунулися б: кроки копій пішли б фазою середовища, а кроки середовища не виконалися б); блок `carriers` тут виконується звичайним `runSteps` між двигуном і середовищем, а мітка `phase("carriers")` ставиться **лише коли блок непорожній** (інакше тест точного переліку фаз репетиції в `execute.test.ts` почервонів би); налаштування й перевірку додає Задача 3 — після мітки фази, щоб час перевірки рахувався фазі `carriers`, а не `engine`. `rehearsal.ts` — `"carriers"` між `"engine"` і `"environment"` у `REHEARSAL_PHASES` (`REHEARSAL_FORMAT` лишається 1: старі звіти лишаються дійсними). Тест: `execute.test.ts` — наявне очікування тексту `plan steps are out of origin order: intent, engine, environment` → з чотирма походженнями; план з кроками всіх чотирьох походжень виконує їх у порядку intent → engine → carriers → environment.
- [x] **Step 4:** Run: `pnpm --filter simetra test carrier-backfill plan artifact steps locks execute rehearsal && pnpm --filter simetra typecheck` — PASS.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(schema): крок даних копій носіїв замість відмови плану"
```

---

### Задача 3: фаза кроків копій у застосуванні

**Files:**
- Modify: `packages/simetra/src/schema/apply/execute.ts`, `schema/apply/settings.ts`, `schema/apply/carrier-backfill.ts`, `schema/apply/index.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Modify: `packages/simetra/test/db/carrier-backfill.db.test.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/execute.test.ts`, `carrier-backfill.test.ts`, `packages/simetra/src/compiler/__tests__/messages.test.ts`

**Interfaces:**
- Produces: `runCarrierSteps(tx: ApplyTransaction, steps: readonly PlanStep[], parse: SqlParser, onStep: (id: string) => void): Promise<void>` (експорт `execute.ts` для DB-тесту; не з `index.ts`) — перевірка `session_replication_role`, далі `withLocalSettings(tx, CARRIER_STEP_SETTINGS, …)` над кроками; `CARRIER_STEP_SETTINGS: readonly EngineSetting[] = [{ name: "row_security", value: "off" }]` у `settings.ts`; `requireOriginReplication(tx: ApplyTransaction): Promise<void>` — спільний помічник фаз 8 і `carriers`.

- [x] **Step 1: Write the failing tests (unit)** у `execute.test.ts` (фейкова `ApplyTransaction`, за зразком блоку `data steps`):
  - `it("runs carrier steps with row security off only, after the engine")` — журнал запитів: SQL кроку `carriers` — після останнього кроку двигуна й до першого кроку середовища; перед ним — `row_security = off` і жодного іншого налаштування (зокрема не `search_path`), після — повернення; фаза `carriers` у звіті фаз.
  - `it("a plan without carrier steps logs nothing for the phase")` — наявний тест повного журналу (`runs one attempt in the order of decision 11`) лишається без змін.
  - `it("refuses carrier steps in replica mode")` — `session_replication_role = 'replica'` → `apply.replication-role`, жодного SQL кроку.
  - `it("disables no triggers for carrier steps")` — у журналі немає `DISABLE TRIGGER`.
- [x] **Step 2:** Run: `pnpm --filter simetra test execute` — FAIL.
- [x] **Step 3: Implement** фазу за Р2b2-4; фаза 8 бере `requireOriginReplication` (без зміни поведінки). Видалити `carrierBackfillRefusals` (з реекспортом у `index.ts` і `describe` у `carrier-backfill.test.ts`), код `plan.carrier-backfill-missing` і його тексти en/uk; `messages.test.ts` — коду немає. Коментар «чому» — колонку створює двигун (фаза 11), тригери не вимикаються.
- [x] **Step 4: DB test** `carrier-backfill.db.test.ts` (причина DB-рівня — `FORCE ROW LEVEL SECURITY` і `row_security` вирішує Postgres): кейс перевертається з відмови на крок — таблиця з `FORCE ROW LEVEL SECURITY` і рядком, власник — тегована роль `NOBYPASSRLS`, сесія під нею; `runCarrierSteps` з кроком над цією таблицею кидає `rejects.toMatchObject({ code: "42501" })`, а не пише нуль рядків (порт тестової транзакції `rollbackDatabase` кидає сиру помилку `pg`, не `ApplyDbError`, тож `runSteps` її не загортає — та сама форма, що в нинішньому тесті файлу). Мутація: прибрати `CARRIER_STEP_SETTINGS` з фази — крок пише нуль рядків, тест червоніє.
- [x] **Step 5:** Run: `pnpm --filter simetra test execute carrier-backfill messages && pnpm --filter simetra typecheck` і `pnpm --filter simetra exec vitest run --project db carrier-backfill` — PASS.
- [x] **Step 6: Commit**

```bash
git add packages/simetra
git commit -m "feat(schema): фаза кроків копій носіїв після кроків двигуна"
```

---

### Задача 4: кроки на живих рядках (designer)

**Files:**
- Create: `packages/designer/src/schema-engine/__tests__/carrier-backfill.db.test.ts`
- Modify: `packages/simetra/test/support.ts` (реекспорти `promotableTaskNote`, `taskNoteMapping`, `TASK_FILE`, `COMMENT_FILE`, `ATTACHMENTS_TABLE`, будівників атрибутів — що знадобиться з `fixtures/rights.ts`)

Причина DB-рівня (шапка файлу): що двигун створить колонку до кроку, що тригери носіїв, механіки й підписок зроблять на `UPDATE` кроку і що промоція перейменує таблицю до нього — вирішує Postgres на живих рядках.

- [x] **Step 1: Write the test** — один опис, одна тінь на кейс; фікстури — `simetra/test/support`. `build-plan.support.ts` прив'язаний до схеми `app` (`compiled()`, `targetScope`), а `policyDomain()` — у `public`, тож ланцюг явний:
  1. `compile(policyDomain(…))` напряму (не `compiled()`), область — `public`;
  2. ціль — `inTarget(EMPTY, …)`, вихідний стан — `establish` (як у `build-plan.db.test.ts`), засів власником;
  3. звичайний план — `buildPlan` → `executePlan(…, { mode: "apply" })` з `allow: artifact.requiredPermissions`;
  4. промоція — `const p = promoted(policyDomain(promotableTaskNote()), taskNoteMapping())` (`build-plan.support.ts`: `before`, `after`, `input`), `establish(url, p.before)`, засів, `buildPlan(engine, dbs, p.after, { target: { url } }, [p.input])` → `executePlan(writer, { url }, artifact, { mode: "rehearse", rehearsal: await rehearsalOf(p.after, artifact), … })` → `rehearsalReport(artifact.planHash, outcome.evidence)` → `executePlan(…, { mode: "apply", report, allow: artifact.requiredPermissions, snapshot: canonicalSnapshot(p.after) })` — за ланцюгом «репетиція на цілі» `promotion-lifecycle.db.test.ts`.

  Це перший наскрізний план і перша промоція моделі з правами на базі: **якщо план відмовляє з причини, не пов'язаної з копіями носіїв, — стоп і звіт архітектору**, без обхідних правок фікстури.
  - `it("a plain plan backfills a path copy and the tabular copy reading it")`: вихідна модель — `policyDomain()` з перевизначеннями: `Task` без `ownership`, `access` і `containerBinding` (реквізити `assignee`, `region`, `project` лишаються; гранти `own`, вимірів і контейнерні ролі на `Task` і на об'єкти з носієм через `Task` прибрати разом, щоб модель компілювалася без помилок) — тож `task_checklist` отримує **три** очікувані копії на одному зв'язку (доказ форми Р2b2-2 на Postgres), `TaskComment` без `ownership` (`TaskReport` лишає свій шлях `["task", "assignee"]`: шлях потребує лише реквізиту цілі, тож його копія вже жива й кроку не має), ТЧ `checklist` з реквізитом `assignee` (Р2b2-8; поки носія немає, `rights.carrier-column-taken` не спрацьовує); засіяти задачу (`assignee` = u1), рядок `checklist` з `assignee` = u2, коментар із вкладенням, і другий коментар з `task` = `NULL` і значенням u2 у колонці з іменем копії шляху (у вихідній моделі `TaskComment` має реквізит `legacyOwner` типу як `assignee` з `physicalName` = ім'я копії шляху `task_id_assignee_id`, у цільовій — ні; реквізит `task` необов'язковий в обох моделях — перевизначенням, якщо фікстура робить його обов'язковим); записати `version` коментаря й лічильник підписки `onWrite`; побудувати й застосувати план до `policyDomain()` → у плані кроки `carriers` для `task_comment`, `task_comment_attachments`, `task_checklist`, причому `task_comment` раніше за `task_comment_attachments` (Р2b2-3); після `COMMIT`: копія шляху коментаря й копія вкладення = u1, копія шляху коментаря без задачі — `NULL` (не u2), `assignee_id`, `region_id`, `project_id` рядка `checklist` = значення задачі, `version` коментаря не змінилася, лічильник підписки не зріс.
  - `it("a promotion backfills the copy of the renamed table")`: прийнята таблиця `promotableTaskNote()` з рядком, що посилається на задачу з `assignee` = u1; промоція `taskNoteMapping()` до `COMMIT` (репетиція — за наявним сценарієм промоції) → `task_note.task_id_assignee_id` = u1.
- [x] **Step 2:** Run: `pnpm --filter @simetrajs/designer exec vitest run --project db carrier-backfill` — PASS. **Мутаційний доказ** (вручну, без коміту): прибрати кроки `carriers` з плану — обидва кейси червоніють (копії `NULL`, `assignee_id` рядка `checklist` = u2); форма `UPDATE … FROM` замість підзапиту — коментар без задачі лишає u2; поставити фазу `carriers` до кроків двигуна — застосування падає `42703` (колонки ще немає); у промоції передати в `carrierBackfillSteps` старе ім'я таблиці — `buildPlan` падає внутрішньою помилкою (таблиці `task_notes` немає в бажаному знімку), кейс червоніє на побудові плану. Скинуті FK вихідних реквізитів (`legacyOwner`, `checklist.assignee`) — кроки `relaxation`; їх дозволяє наявний `allow: artifact.requiredPermissions` помічника застосування. Порядок Р2b2-3 і `IS DISTINCT FROM` доводять unit-тести Задачі 1: на даних їх маскує поширення 2a2 і умова механіки.
- [x] **Step 3: Commit**

```bash
git add packages/designer/src packages/simetra/test/support.ts
git commit -m "test(designer): крок копій носіїв на живих рядках — план і промоція"
```

---

### Задача 5: скіл, гейти й заміри

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/references/people-and-rights.md` (абзац про `plan.carrier-backfill-missing`), `docs/ROADMAP.md`, цей план (позначки)

- [x] **Step 1:** Скіл споживача (англійською): нова копія носія на таблиці з рядками заповнюється кроком плану `carriers` (клас `dataStep`, без дозволу) після кроків двигуна; крок займає `SHARE ROW EXCLUSIVE` на таблиці й джерелі до кінця застосування; речення про відмову плану прибрати.
- [x] **Step 2:** Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — код 0.
- [x] **Step 3:** Run: `pnpm metadata:check && python3 scripts/check-doc-anchors.py && .agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-24-rights-2b2-carrier-backfill.md` — код 0.
- [x] **Step 4:** Повний `pnpm test:db` на одному SHA (у фоні, таймаут не коротший за 45 хв): `/usr/bin/time -f %e pnpm test:db` — код 0 (або CI job `db`); приріст проти прогону після 2b1 ≤ 30 с, разом з 2b1 ≤ 45 с, інакше звіт архітектору з розкладом за файлами.
- [x] **Step 5:** ROADMAP — «Права-2b виконано»; позначки плану.
- [x] **Step 6: Commit**

```bash
git add packages/designer/skills docs/ROADMAP.md docs/superpowers/plans/2026-10-24-rights-2b2-carrier-backfill.md
git commit -m "docs(plan): Права-2b2 виконано — скіл, ROADMAP, позначки"
```

## Критерії приймання

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py` — зелені після **кожного** коміту; повний `pnpm test:db` — зелений на одному SHA, приріст записано.
- Коду, повідомлень і тестів відмови `plan.carrier-backfill-missing` немає; її кейси стали кейсами кроку (Задача 2).
- `PLAN_FORMAT` = 6; крок `carriers` — між двигуном і середовищем, лише з `row_security = off`, без вимкнення тригерів (Задачі 2–3).
- Ланцюг «копія шляху → копія ТЧ» і промоція заповнюються на живих рядках без росту `version` залежних рядків (Задача 4).
- Спека прав §5.2 і спека промоції §7.2 оновлені (Задача 0).
