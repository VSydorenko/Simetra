# П4-B1c. Умовне й пакетне читання — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** запит `read` конверта несе до 16 частин, які сервер виконує в одній
транзакції `REPEATABLE READ READ ONLY` одним оператором налаштування; частина
`query` може нести `known` і отримує маркер замість тіла незмінного рядка;
відповідь несе епоху версій бази, і ядро T4 порівнює версії лише в межах
однієї епохи.

**Архітектура:** T0 — схеми частин, `known`, маркера й відповіді пакета. T1 —
позначка `copy` атрибута (копія носія чи генерована колонка з неї). T3 —
будівник з умовною проєкцією, серверна функція пакета `readParts` і
обробник частин. T4 — порт `SourceAdapter.read(items)`, адаптер Server
Function, шар джерела ядра `CoreSource` на частинах і правило епохи в ядрі.
Збирач пакета за такт мікрозадач, правило «ключ іде в `known`» і
застосування маркера в сховищі — B3-3, не цей блок.

**Стек:** TypeScript, Zod, Vitest, Postgres 17 (DB — локальний стек
Supabase), libpg-query.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) Рд40, Рд41,
Рд22, Рд24, §4.1 (`known`, «Епоха версій»), §4.2, §4.5, §5.1, §5.2, §6.2,
§6.7, §11 інваріант 27, §12 рядок «швидкодія», §13 рядок B1c; [план
B1e](2026-11-08-p4-b1e-row-version-sequence.md) (епоха й послідовність — вхід
цього блоку).

**Поділ і залежності.** **B1c-1** (Task 1–5, сервер і T0/T1) і **B1c-2**
(Task 6–9, T4 і документи) — кожна з власним «готово». Обидві йдуть після
мерджу B3-2 (B1c-1 змінює адаптер `src/data`, який переносить B3-2) і після
B1e (епоха в базі). Виконавець спершу звіряє план з `main` після мерджу B3-2
(`orient --plan`): імена T4 нижче — з плану й гілки B3-2 (`feat/p4-b3-2`).

## Global Constraints

- `READ_BATCH_MAX = 16` частин; частина — `{ type: "query", query }` чи `{ type: "version" }` (`rights` додає B5).
- `known` — `{ keys: string[]; versions: string[] }`: UUID, без повторів, рівна довжина, до `READ_LIMIT_MAX` (200), версія — рядок безпечного цілого 1…2^53 − 1; дозволено лише в списочній формі й формі картки без `tabularSections`; в інших формах — `command.invalid` з `reason: "known-form"`.
- Маркер у `rows` — ціле ≥ 0 (позиція в `known`); частковий маркер — рядок з ключем, версією й колонками з позначкою `copy` (об'єкт копіями).
- Транзакція читання: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, один оператор налаштування, по оператору на частину й на ціль `include`, `COMMIT` — 3 + частини + цілі. Бюджет `readBudgetMs` — 30 000 мс; стеля оператора — наявний `readStatementTimeoutMs` (15 000 мс); запобіжник `transaction_timeout` = бюджет + 1 000 мс на PostgreSQL ≥ 17.
- Відповідь `read`: `{ epoch: string | null, items: [{ ok: true, value } | { ok: false, error }, …] }`; бюджет — `RESPONSE_BUDGET_BYTES` на всю `DataResponse`.
- Коди частин: `command.unavailable` з `reason: "batch-aborted"` (помилка бази в попередній частині) і `"batch-budget"` (не вмістилось у залишок); `command.timeout` після дедлайну.
- Ядро шле `known` лише з B3-3; у B1c ядро його не шле, але приймає відповідь з маркерами за схемою.
- Без шимів: окремий тип запиту `version` і `read` з одним `query` видаляються в тій самій зміні (принцип 5).
- Файли ПГ-1 не чіпати (перелік — план B1e, Global Constraints). DB-тести профілево-нейтральні, ролі API — з `PROVIDER_API_ROLES`.
- Коментарі — українською й про «чому»; повідомлення — en/uk у `packages/simetra/src/compiler/messages.ts`.

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | Оператор налаштування: `WITH e AS MATERIALIZED (SELECT simetra.row_version_epoch() AS epoch) SELECT e.epoch, set_config(claims…), set_config('TimeZone'…), set_config('bytea_output'…), set_config('statement_timeout', $ceiling, true), CASE WHEN current_setting('server_version_num')::int >= 170000 THEN set_config('transaction_timeout', $guard, true) END, set_config('role', $readRole, true) FROM e` | функцію епохи виконує лише роль команд (план B1e); матеріалізований CTE обчислює її до зміни ролі, тож лишається один оператор; `set_config('role', …, true)` діє як `SET LOCAL ROLE` | П4-B §4.2 (Task 9) |
| Р2 | Епоха — одна на відповідь (`value.epoch`), а не на частину | частини виконує одна транзакція | П4-B §4.5 (Task 9) |
| Р3 | `known` — лише у формі передачі й у частині пакета T3 (`ReadPart.known`); логічний `ReadQuery` (`runtime.read`, `ctx.read`, MCP) його не має | в API в процесі маркер нікому не потрібен, а `ReadRows` хуків і MCP лишається без чисел у `rows` | П4-B §4.1 (Task 9) |
| Р4 | `runtime.read(session, query)` лишається й виконується як `readParts` з однією частиною | одна транзакційна дисципліна для всіх читань; MCP `data-read` не змінюється | немає |
| Р5 | Позначка атрибута каталогу `copy: true` — колонка з `origin.copyOf` і генерована колонка, вираз якої (розбір libpg-query, вузли `ColumnRef`) посилається на таку колонку | поширення копій версії не підвищує, тож частковий маркер несе й похідну генеровану колонку (рішення архітекторки 2026-11-08) | П4-B §3 (Task 9) |
| Р6 | Ядро порівнює версії лише в межах однієї епохи: `RowEntry.versionEpoch`; рядок іншої епохи заміняє будь-яку версію; відповідь з епохою, відмінною від останньої баченої, скидає пам'ять версій, надгробки, горизонт і поховання пар, ставить усім рядкам `stale` з причиною `epoch` і перечитує видимі вигляди; `purge` від епохи не залежить | після відновлення бази версії сервера можуть бути меншими за клієнтські, а видалене — законно повернутися (рішення архітекторки 2026-11-08) | П4-B Рд24, §6.2 (Task 9) |
| Р7 | `SourceAdapter.read(items)` заміняє `read(query)`; фейк джерела B3-2 і `createCoreSource` переходять разом | принцип 5; порт один для всіх джерел | П4-B §5.1 вже описує |
| Р8 | Обмежувач паралельних читань ядра рахує запит, а не частину: `readKeys` збирає частини одного виклику в запити по `READ_BATCH_MAX` | зворотний тиск §8.4 — запити до сервера | немає |

Кожне рішення — розвилка, погоджена архітекторкою; розбіжність під час
виконання — до неї.

## Review Focus

1. **Ключ із `known`, невидимий під RLS чи поза `where`**: відсутній у
   відповіді, маркера немає — Task 3 (DB).
2. **Помилка бази в середній частині**: попередні частини лишають
   результати, наступні — `batch-aborted` — Task 4 (unit).
3. **Частина, що сама не вміщується в бюджет**: власна відмова, а не
   нескінченний `batch-budget` — Task 5 (unit).
4. **Конкурентний коміт між двома частинами**: обидві бачать один знімок —
   Task 5 (DB).
5. **Відповідь з новою епохою після відновлення**: рядок меншої версії
   заміняє старий, надгробок не ховає повернений рядок — Task 8 (unit).

---

## B1c-1. Сервер, T0 і T1

### Task 1: Схеми T0 — частини, `known`, маркер, відповідь

**Files:**
- Modify: `packages/simetra/src/model/runtime/envelope.ts` (`dataRequestSchema`: гілка `read` з `items`, без `version`; `wireReadQuerySchema` — `known` у списочній формі й формі картки; `wireReadResultSchema` — `rows` з маркерами; нова `wireReadPartsResultSchema`), `read.ts` (`READ_BATCH_MAX`), `mapping.ts` (`readQueryToWire` / `readQueryFromWire` переносять `known`; `readResultFromWire` зберігає маркери), `ports.ts` (`WireReadPart`, `WireReadParts`)
- Test: `packages/simetra/src/model/runtime/__tests__/envelope.test.ts`, `read.test.ts`, `mapping.test.ts`

**Interfaces:**
- Produces: `READ_BATCH_MAX = 16`; `knownSchema`; `WireReadPart = { type: "query"; query: WireRowsQuery } | { type: "version" }`; `WireReadParts = { epoch: string | null; items: Array<{ ok: true; value: WireReadValue } | { ok: false; error: WireCommandError }> }`, де `WireReadValue` — результат частини `query` (`rows` — `Array<WireRow | number>`) чи `version` (`versionValueSchema`); у схемі конверта частини — `z.array(z.unknown())` з межею, кожна частина валідується власною схемою (Task 5).

- [ ] **Step 1: Unit (`it.each`, одна таблиця на схему).** `known`: прийняті й відхилені форми з Global Constraints (зокрема `reason: "known-form"` для `count`, сторінки ТЧ, «ТЧ власника» й картки з `tabularSections`); конверт `read`: 1 і 16 частин прийнято, 0 і 17 — `command.invalid` з причиною межі; окремого `type: "version"` немає; відповідь пакета: маркер-ціле в `rows`, від'ємне чи дробове — відмова; мапінг переносить `known` без змін і зберігає маркери.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test envelope read mapping`.
- [ ] **Step 3: Commit.** `feat(model): частини запиту read, known і маркер у формі передачі`

### Task 2: Позначка `copy` у каталозі (T1)

**Files:**
- Modify: `packages/simetra/src/compiler/entity-fields.ts` (переносить ознаку копії поля), `runtime-catalog.ts` (`attributes()`: `copy: true`), `client-catalog.ts` (`attributeOf`: `present("copy", …)`), `packages/simetra/src/model/runtime/catalog.ts` (`catalogEntryAttributeSchema`: `copy: z.literal(true).optional()`); новий модуль `packages/simetra/src/compiler/copy-columns.ts`
- Test: `packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts`, `copy-columns.test.ts` (Create)

**Interfaces:**
- Produces: `copyColumns(table: PhysicalTable, parse: SqlParser): ReadonlySet<string>` — колонки з `origin.copyOf` і генеровані колонки, чий `generated.expression` (розібраний як вираз) має `ColumnRef` на таку колонку, до нерухомої точки.

- [ ] **Step 1: Unit `copy-columns.test.ts`:** копія носія — у множині; генерована колонка з копії — у множині; генерована з копії через іншу генеровану — у множині; генерована з `date` (`numberPeriod`) — ні. `runtime-catalog.test.ts`: атрибут копії має `copy: true` у каталозі рантайму й клієнта, звичайний — без поля; `kernelHash` позначка не змінює.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test copy-columns runtime-catalog client-catalog`.
- [ ] **Step 3: Commit.** `feat(compiler): позначка copy атрибута каталогу для часткового маркера`

### Task 3: Будівник з умовною проєкцією

**Files:**
- Modify: `packages/simetra/src/server/read.ts` (`ReadPlan.known`, `listProjection`, `cardProjection`, `buildObjectPlan`, `includeStatement`)
- Test: `packages/simetra/src/server/__tests__/read.test.ts`, `packages/designer/src/__tests__/read-batch.db.test.ts` (Create)

**Interfaces:**
- Consumes: `knownSchema` (Task 1), `copy` атрибута (Task 2).
- Produces: `buildReadPlan(object, query, known?: Known)` дає проєкцію `CASE WHEN t.<версія> = k.v THEN <маркер> ELSE <рядок> END`, де `k` — `LEFT JOIN unnest($keys::uuid[], $versions::bigint[]) WITH ORDINALITY AS k(id, v, n) ON k.id = t.<ключ>`, маркер — `to_jsonb(k.n - 1)` для об'єкта без копій і `jsonb_build_object(<ключ>, <версія>, <колонки copy>)` для об'єкта з копіями; `where`, RLS і порядок не змінюються; оператор `include` бере id цілей з рядків першого оператора незалежно від маркера (план повертає id поруч із проєкцією).

- [ ] **Step 1: Unit `read.test.ts`** (розібрані оператори, не фрагменти): список із `known` — проєкція з `CASE` і `LEFT JOIN unnest … WITH ORDINALITY`; без `known` — оператор як був; об'єкт з копіями — частковий маркер з рівно ключем, версією й колонками `copy`; `include` бере id цілей і для маркерних рядків; `ctx.read` (`hook-context.ts`) будує той самий оператор, що й без B1c.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test read hooks`.
- [ ] **Step 3: DB `read-batch.db.test.ts`** (причина DB: RLS і `unnest` виконує Postgres; через `runtime.readParts` з Task 4 — крок виконується після Task 4): ключ із `known`, невидимий під RLS, — відсутній; ключ поза `where` — відсутній; рівна версія — маркер; інша — рядок; поширення копії носія без підвищення версії — частковий маркер з новою копією.
- [ ] **Step 4: Commit.** `feat(server): умовна проєкція known у будівнику читання`

### Task 4: Серверна функція пакета `readParts`

**Files:**
- Modify: `packages/simetra/src/server/runtime.ts` (`readParts`; `read` через неї; `BEGIN_READ_ONLY` для читань — RR; опція `readBudgetMs`), `transaction.ts` (спільний помічник бюджету для читання за зразком `budget(phase)`)
- Test: `packages/simetra/src/server/__tests__/read-runtime.test.ts`

**Interfaces:**
- Produces: `CommandRuntime.readParts(session: SessionClaims, parts: readonly ReadPart[]): Promise<ReadPartsResult>`, `ReadPart = { type: "query"; query: ReadQuery; known?: Known } | { type: "version" }`, `ReadPartsResult = { epoch: string | null; items: Array<{ ok: true; value: ReadPartValue } | { ok: false; error: CommandError }> }`; опція рантайму `readBudgetMs` (типово 30 000).
- Порядок результатів (П4-B §4.2): дедлайн перед частиною — вона й наступні `command.timeout` без виконання; помилка бази в частині — вона отримує свою помилку (`57014`, `25P04` — `command.timeout`), наступні — `batch-aborted`; після `25P04` з'єднання знищується; виконані раніше частини лишають результати. Частина `version` бази не питає.

- [ ] **Step 1: Unit `read-runtime.test.ts`** (порт-фейк з журналом операторів): рівно `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, оператор налаштування за Р1 (розібраний), по оператору на частину й ціль, `COMMIT`; залишок бюджету менший за стелю — окремий `set_config('statement_timeout', …)` перед оператором; дедлайн — `command.timeout` без операторів; `57014` у другій з трьох частин — перша з результатом, друга `command.timeout`, третя `batch-aborted`; `25P04` — з'єднання знищено; `runtime.read` дає ті самі оператори з однією частиною; `epoch` з оператора налаштування в результаті.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test read-runtime transaction`.
- [ ] **Step 3: Commit.** `feat(server): пакет читань в одній транзакції REPEATABLE READ`

### Task 5: Обробник частин, бюджет і походження

**Files:**
- Modify: `packages/simetra/src/server/data-handler.ts` (кроки 1, 3, 5, 6 для частин; `envelopeRefusal` — шлях `items.<i>`), `compatibility.ts` (звірка на частину), `response-budget.ts` (`fitParts`), `origin.ts` (`IN_PROCESS_TYPES = {"read"}`)
- Modify (споживачі старого запиту `version`): `packages/simetra/src/server/__tests__/data-handler*.test.ts`, `compatibility.test.ts`, `packages/designer/src/__tests__/data-handler.db.test.ts`
- Test: `packages/simetra/src/server/__tests__/data-handler.test.ts`, `response-budget.test.ts`, `origin.test.ts`, `packages/designer/src/__tests__/read-batch.db.test.ts`

**Interfaces:**
- Consumes: `readParts` (Task 4), схеми Task 1.
- Produces: `fitParts(index, parts, result: WireReadParts, serverHash): WireReadParts` — частини по черзі; частина, чий результат не вміщується в залишок, а окремо вмістився б, виконана й відкинута, вона й наступні — `batch-budget` (сторінка — непорожній префікс з `more: true`, коли вміщується); частина, що не вміщується й сама, — `response-too-large`.

- [ ] **Step 1: Unit `data-handler.test.ts`:** невалідна частина — `command.invalid` лише їй, решта виконуються; несумісна частина — `stale-client` лише їй; `version` — значення каталогу без звернення до порту; `subject` ≠ `sub` — відмова всього запиту; `response-budget.test.ts` — обидві гілки бюджету пакета; `origin.test.ts` — `inProcess` пропускає `read` з будь-якими частинами, `run` і `receipt` — ні.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test data-handler response-budget origin compatibility`.
- [ ] **Step 3: DB `read-batch.db.test.ts`** (причина DB: знімок `REPEATABLE READ` і епоха B1e): пакет з двох частин і конкурентний коміт між ними (друге з'єднання) — обидві бачать стан до коміту; `epoch` — 64 hex на базі з епохою B1e; кейси Task 3 через обробник.
- [ ] **Step 4: Гейти B1c-1.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm --filter @simetrajs/designer test:db read-batch read-query data-handler`.
- [ ] **Step 5: Commit.** `feat(server): обробник частин read, бюджет пакета й походження`

**Готово B1c-1:** unit T0/T1/T3 і DB-кейси Task 3–5 зелені; окремого запиту `version` немає; `runtime.read` і MCP `data-read` працюють як раніше; адаптер `src/data` шле `{ type: "read", items: [{ type: "query", query }] }` (мінімальна правка, щоб гейти були зелені; повний перехід — Task 6).

## B1c-2. Порт, джерело ядра й правило епохи

### Task 6: Порт і адаптер Server Function

**Files:**
- Modify: `packages/simetra/src/model/runtime/ports.ts` (`SourceAdapter.read(items: readonly WireReadPart[]): Promise<WireReadParts>`), `packages/simetra/src/data/adapter.ts` (`createServerFunctionAdapter`), фейк джерела B3-2 (`packages/simetra/src/data/store/testing/fake-source.ts`)
- Test: `packages/simetra/src/data/__tests__/adapter.test.ts`, тести фейка B3-2

- [ ] **Step 1: Unit:** адаптер шле один запит з усіма частинами й повертає `WireReadParts`; помилка транспорту — `command.unavailable` для всіх частин; фейк приймає частини, `known` і віддає маркери за тими самими правилами, що сервер.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test adapter fake-source`.
- [ ] **Step 3: Commit.** `feat(data): SourceAdapter.read на частинах`

### Task 7: `CoreSource` на частинах

**Files:**
- Modify: `packages/simetra/src/data/store/source.ts` (`CoreSource.read(parts)`, `createCoreSource`, `readKeys`, `serverRow` — розрізняє маркер-ціле, який у B1c не приходить: `command.internal`)
- Test: тести `source.ts` B3-2 (`packages/simetra/src/data/store/__tests__/source.test.ts` чи наявний файл гілки)

**Interfaces:**
- Produces: `CoreSource.read(parts: readonly RowsQuery[]): Promise<CoreReadResult>`, `CoreReadResult = { epoch: string | null; items: Array<{ ok: true; rows: ReadRows } | { ok: false; error: CommandError }> }`; `readKeys` ділить ключі на частини по 200 і частини на запити по `READ_BATCH_MAX`, один слот обмежувача на запит; `batch-aborted` — повтор частини наступним запитом без частини, що впала; `batch-budget` — повтор наступним запитом; навпіл на `response-too-large` — як було.

- [ ] **Step 1: Unit:** 1 000 ключів — 5 частин в одному запиті й один слот обмежувача; 4 000 ключів — два запити; `batch-aborted` у третій частині — повтор частин 3…n без упалої; `batch-budget` — повтор; маркер-ціле в рядках — `command.internal`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test source core`.
- [ ] **Step 3: Commit.** `feat(data): джерело ядра читає частинами`

### Task 8: Правило епохи в ядрі

**Files:**
- Modify: `packages/simetra/src/data/store/object-store.ts` (`RowEntry.versionEpoch`, `mergeVersioned` за епохою), `epoch.ts` (`Epochs.resetVersions()`: пам'ять версій, надгробки, горизонт, поховання пар), `core.ts` / `session.ts` (остання бачена епоха; на зміні — скидання, `stale` з причиною `epoch` усім рядкам і `revalidate` видимих виглядів), `types.ts` (причина `stale`), модельний тест B3-2
- Test: тести `object-store`, `epoch`, `core` гілки B3-2; модельний тест

**Interfaces:**
- Consumes: `CoreReadResult.epoch` (Task 7).
- Produces: `RowEntry.versionEpoch: string | null`; правило: рядок з `versionEpoch`, відмінною від запису, заміняє запис незалежно від версії; `Epochs.resetVersions(): void`; причина `stale` — `epoch`; перша відповідь сесії задає епоху без скидання.

- [ ] **Step 1: Unit:** відповідь нової епохи з меншою версією заміняє рядок; надгробок старої епохи не ховає рядка нової; пам'ять версій скинута; усі рядки — `stale` з причиною `epoch`, видимі вигляди перечитано одним двофазним `commit`; `purge` за втратою доступу після зміни епохи діє як раніше; `null` → рядок і рядок → `null` — теж зміна.
- [ ] **Step 2: Модельний тест** — крок «зміна епохи» з вагою; інваріант «версія не зменшується» діє в межах однієї епохи.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test object-store epoch core model`.
- [ ] **Step 4: Commit.** `feat(data): версії порівнюються в межах однієї епохи версій бази`

### Task 9: Спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (Рд24 і §6.2 правило 1 — правило епохи Р6; §4.2 — оператор налаштування Р1; §4.5 — `value.epoch`, частини без окремого `version`; §4.1 — `known` лише у формі передачі (Р3); §3 — позначка `copy`; Додаток А — рядки B1c «внесено (B1c)»; §6.6 — знімок SSR несе епоху: рядок у колонку B3-6), `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` §8.1 (рядок Додатка А), `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` §6.11 (транзакція читання `REPEATABLE READ READ ONLY`)

- [ ] **Step 1: Правки** за переліком; кожна — стан, без історії.
- [ ] **Step 2: Гейти B1c-2.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`.
- [ ] **Step 3: Commit.** `docs(spec): пакет читань, known і епоха версій під B1c`

**Готово B1c-2:** unit T4, модельний тест і DB-кейси зелені; повний `pnpm test:db` зелений; спеки оновлено; файлів ПГ-1 не змінено.

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| маркер окремим оператором «які версії» поза оператором з RLS | `read.test.ts` (розібраний оператор) і `read-batch.db.test.ts` (невидимий ключ) |
| `known` як фільтр (`INNER JOIN`) | `read-batch.db.test.ts` (ключ поза `known` зник би) |
| частковий маркер без колонок `copy` | `read-batch.db.test.ts` (поширення копії) |
| `READ COMMITTED` замість `REPEATABLE READ` | `read-batch.db.test.ts` (конкурентний коміт) |
| епоха після `set_config('role')` у налаштуванні | `read-batch.db.test.ts` (`42501`) |
| наступні частини після помилки бази виконуються | `read-runtime.test.ts` |
| `batch-budget` для частини, що не вміщується й сама | `response-budget.test.ts` |
| версії порівнюються між епохами | ядро, Task 8 |
| зміна епохи без скидання надгробків | ядро, Task 8 |
| обмежувач рахує частину, а не запит | Task 7 |
