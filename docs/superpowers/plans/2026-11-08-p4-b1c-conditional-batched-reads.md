# П4-B1c. Умовне й пакетне читання — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** запит `read` конверта несе до 16 частин, які сервер виконує в одній
транзакції `REPEATABLE READ READ ONLY`; частина `query` може нести `known` і
отримує маркер замість тіла незмінного рядка лише в тій самій епосі версій
бази; відповідь несе епоху, і ядро T4 порівнює версії лише в межах однієї
епохи.

**Архітектура:** T0 — схеми частин, `known`, маркерів і відповіді пакета. T1 —
позначка `copy` атрибута каталогу (копія носія чи генерована колонка з неї).
T3 — будівник з умовною проєкцією, серверна функція пакета `readParts` і
обробник частин. T4 — порт `SourceAdapter.read(items)`, адаптер Server
Function, шар джерела ядра на частинах і правило епохи в ядрі. Збирач пакета
за такт мікрозадач, правило «ключ іде в `known`», застосування маркера в
сховищі й `include` тим самим запитом — B3-3, не цей блок.

**Стек:** TypeScript, Zod, Vitest, Postgres 17 (DB — локальний стек
Supabase), libpg-query.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) Рд40, Рд41,
Рд22, Рд24, Рд33, §4.1 (`known`, «Епоха версій»), §4.2, §4.5, §5.1, §5.2,
§6.2, §6.7, §11 інваріант 27, §12 рядок «швидкодія», §13 рядок B1c; [план
B1e](2026-11-08-p4-b1e-row-version-sequence.md) (епоха й послідовність —
вхід цього блоку).

**Поділ і залежності.** **B1c-1** (Task 1–5, T0, T1, T3) і **B1c-2** (Task
6–10, T4 і документи) — кожна з власним «готово». Обидві йдуть після мерджу
B3-2 (B1c-1 змінює адаптер `src/data`, який переносить B3-2) і після
виконання B1e **разом із правкою гранту** (гілка `plan/p4-b1e-grant`:
`EXECUTE` на `row_version_epoch()` ролям запиту `user` і `anonymous`) —
без неї кожне читання падає з `42501`; DB-кейс Task 5b читає епоху під
кожною роллю запиту провайдера. Виконавець спершу звіряє план з `main` (`orient --plan`):
імена T4 нижче — з гілки B3-2 (`feat/p4-b3-2`, `data/store/*`).

## Global Constraints

- `READ_BATCH_MAX = 16` частин; частина — `{ type: "query", query }` чи `{ type: "version" }` (`rights` додає B5).
- `known` — `{ epoch: string, keys: string[], versions: string[] }`: епоха — 64 hex; ключі — UUID без повторів; рівна довжина, до `READ_LIMIT_MAX` (200); версія — рядок безпечного цілого 1…2^53 − 1; дозволено лише в списочній формі й формі картки без `tabularSections` і без `include`; в інших формах — `command.invalid` з `reason: "known-form"` (`known` разом з `include` вводить B3-3 разом з `include` тим самим запитом: id цілей маркерного рядка будівнику ще не відомі). `known` — лише в частині пакета й у формі передачі; логічний `ReadQuery` (`runtime.read`, `ctx.read`, MCP) його не має.
- Маркер у `rows`: ціле ≥ 0 — позиція в `known` (рядок незмінний); `{ "$known": n, <колонки copy> }` — частковий маркер об'єкта, що має атрибути `copy`. Частковий маркер відрізняє відсутність колонки ключа: повний рядок завжди її має, тож навіть фізична колонка з іменем `$known` не плутає форм.
- Маркер — лише коли `known.epoch` дорівнює епосі бази цієї транзакції й вона не `NULL`; інакше відповідь повна.
- Транзакція читання: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, оператор налаштування, оператор епохи, по оператору на частину й на ціль `include`, `COMMIT` — **4 + частини `query` + цілі `include`**, ще +1 оператор `set_config('statement_timeout', …)` біля дедлайну; частина `version` бази не питає. Бюджет пакета `readBudgetMs` — 15 000 мс, рівний наявній межі одиночного читання (`readStatementTimeoutMs`), тож пакет тримає з'єднання не довше, ніж одиночне читання сьогодні; стеля оператора — та сама; запобіжник `transaction_timeout` = бюджет + 1 000 мс на PostgreSQL ≥ 17; операторів частин і цілей `include` у пакеті — не більше `READ_BATCH_STATEMENTS_MAX = 32` (понад — `command.invalid` з `reason: "batch-too-large"` до бази). Межа одночасних запитів на `subject` на сервері лишається залишком П4-D: пакет не робить її гіршою, ніж для одиночних читань сьогодні.
- Відповідь `read` (запит лише з частин `version` транзакції не відкриває й має `epoch: null`): `{ epoch: string | null, items: [{ ok: true, value } | { ok: false, error }, …] }`; бюджет — `RESPONSE_BUDGET_BYTES` на всю `DataResponse`.
- Коди частин: `command.unavailable` з `reason: "batch-aborted"` (помилка бази в попередній частині) і `"batch-budget"` (не вмістилось у залишок); `command.timeout` після дедлайну; втрата з'єднання — `command.unavailable` усім невиконаним частинам.
- Ядро шле `known` лише з B3-3; у B1c ядро його не шле, а маркер у відповіді без `known` — `command.internal`.
- Без шимів: окремий тип запиту `version` і `read` з одним `query` видаляються в тій самій зміні; запит невідомого типу чи `read` старої форми — `command.stale-client` (стара вкладка дізнається про нове розгортання); невідомий тип **частини** — `command.invalid` лише цій частині (новіший клієнт на старішому сервері не має перезавантажуватись — сумісність «клієнт новіший» тримає звірка хеша каталогу).
- Файли ПГ-1 не чіпати (перелік — план B1e, Global Constraints). DB-тести профілево-нейтральні, ролі API — з `PROVIDER_API_ROLES`; читання в DB-тестах — під справжньою роллю входу (`runtime-login.db.test.ts` — зразок).
- Коментарі — українською й про «чому»; повідомлення — en/uk у `packages/simetra/src/compiler/messages.ts`.

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | Налаштування — один `SELECT` з `set_config` claims, `TimeZone`, `bytea_output`, `statement_timeout` (стеля), `transaction_timeout` (за `server_version_num >= 170000`) і `role` (роль читання); епоху читає наступний оператор `SELECT simetra.row_version_epoch()` уже під роллю читання. **Грант:** `EXECUTE` на `row_version_epoch()` — ролям запиту провайдера й ролі команд; вносить план B1e (гілка `plan/p4-b1e-grant`, рішення архітекторки 2026-11-08) | роль входу `simetra_runtime` за дизайном не отримує грантів згенерованого SQL (`PLATFORM_LOGIN_ROLES`), а `EXECUTE` Postgres перевіряє на старті виконавця, тож прочитати епоху в операторі налаштування неможливо; значення й так іде браузеру, функція — дефайнер і дає лише хеш | П4-B §4.2, §6.7, §12 (3 → 4 оператори; Task 10); план B1e Task 3 |
| Р2 | Епоха — одна на відповідь (`value.epoch`) | частини виконує одна транзакція | П4-B §4.5, §5.1 (Task 10) |
| Р3 | `runtime.read(session, query)` лишається й виконується як `readParts` з однією частиною | одна транзакційна дисципліна; MCP `data-read` не змінюється | немає |
| Р4 | Позначку `copy` обчислює компілятор у стадії з парсером і кладе в `CompiledModel.copyColumns` (не у фізичний знімок); `buildRuntimeCatalog` лишається синхронним і бере її звідти | копія — `origin.copyOf`; похідна генерована колонка — `ColumnRef` у розібраному `generated.expression`; поле фізичного знімка змінило б `snapshotHash` усіх проєктів | П4-B §3 (Task 10) |
| Р5 | Ядро порівнює версії лише в межах однієї епохи: рядок, лінива проєкція, `ownerVersion` ТЧ, записи пам'яті версій (`seen`) і позначки `stale.minVersion` несуть епоху, з якою їх записано; відповідь поточної непорожньої епохи не бере до уваги пам'яті й позначок інших епох і заміняє запис іншої епохи незалежно від версії; відповідь з `null` порівнюється з пам'яттю будь-якої епохи (Рд24 для відсталої репліки лишається) і не заміняє рядка поточної непорожньої епохи — такий ключ лише отримує `stale` і перечитування (версії різних епох не впорядковані); надгробки, горизонт і поховання пар не змінюються | надгробки тримаються за епохою сесії, і їхнє скидання повернуло б рядки, прибрані `purge` (Рд33); стерта пам'ять дала б відсталій репліці з `null` показати старший рядок як підтверджений після рестарту primary (рішення архітекторки 2026-11-08: версії між епохами не порівнюються; уточнення аудиту — пам'ять позначається, а не стирається) | П4-B Рд24, §6.2 (Task 10) |
| Р6 | (рішення архітекторки 2026-11-08) Зміна епохи — лише між двома різними непорожніми значеннями; `null` (репліка, база без епохи) останньої баченої не змінює, і версії тоді порівнюються як завжди | чергування primary і репліки за балансувальником інакше давало б нескінченні скидання й заміну новішого рядка старшим з репліки | П4-B §6.2 (Task 10) |
| Р7 | Момент перемикання епохи — подія епохи сесії; відповідь з епохою, відмінною від поточної, від читання, що стартувало до перемикання, ядро не застосовує (ключі — `stale` і перечитування) | пізня відповідь старої епохи інакше перезаписала б свіжі рядки | немає |
| Р8 | (рішення архітекторки 2026-11-08) Після перемикання рядки одразу отримують `stale` з причиною `epoch`; видимі вигляди перечитуються з розкидом, рівномірним на `[0, revalidateIntervalMs)`; позначку знімає читання, що почалось після перемикання | рестарт primary змінює епоху в усіх клієнтів одночасно, і миттєве перечитування було б шквалом | немає |
| Р9 | `SourceAdapter.read(items)` заміняє `read(query)`; фейк джерела B3-2 і `createCoreSource` переходять разом | принцип 5 | П4-B §5.1 (Task 10) |
| Р11 | Перевірка частини (Zod, каталог, межі) — до `BEGIN`; вибір проєкції з `known` — після оператора епохи: `ReadPlan.known` рендериться під час виконання (`renderKnown(plan, dbEpoch)`), бо епоха відома лише всередині транзакції | `prepareRead` викликається до `connect()` | немає |
| Р12 | Покинуті епохи: ядро тримає всі епохи, з яких перемикалось, до кінця сесії (хеші по 64 символи; рестарт бази — рідкісна подія), тож витіснена епоха не може повернутись як нова; відповідь покинутої епохи не застосовується й нічого не перемикає (ключі — `stale` і перечитування); відповідь, що спричинила перемикання, застосовується; перечитування після відкинутої відповіді — з паузою, що зростає, а після 8 відкинутих поспіль вигляд отримує `command.unavailable` | чергування інстансів старої й нової бази під час PITR інакше перемикало б епоху на кожній відповіді | П4-B §6.2 (Task 10) |
| Р13 | Позначку `stale.epoch` знімає лише відповідь поточної непорожньої епохи, що почалась після перемикання; рядок, вставлений з `null`-відповіді після перемикання, отримує `stale.epoch`; `row_ver` сигналу (B5) порівнюється лише з пам'яттю й рядками поточної епохи; результат `run` епохи не несе й порівнюється за правилом `null` (епоху в результат `run` може додати B3-4) | інакше позначка старої епохи не знімалась би ніколи, а відставлена репліка зняла б позначку, не довівши свіжості | П4-B §6.2, §8.4 (Task 10) |
| Р10 | Обмежувач паралельних читань ядра рахує запит, а не частину; повтор `batch-aborted` — через обмежувач з паузою, що зростає | зворотний тиск §8.4; без паузи збій бази давав би до 16 послідовних повторів на пакет | немає |

Кожне рішення — розвилка, погоджена архітекторкою (2026-11-08); Р11–Р13 —
правки аудиту, до погодження. Межа одночасних читань на `subject` на сервері
— залишок: Task 10 записує його в §14.3 П4-B з блоком-власником (П4-D,
шаблон host-а).

## Review Focus

1. **Ключ із `known`, невидимий під RLS чи поза `where`**: відсутній у
   відповіді, маркера немає — Task 5b (DB).
2. **`known` іншої епохи чи база без епохи**: повна відповідь без маркерів —
   Task 3 (unit) і Task 5b (DB).
3. **Помилка бази в середній частині**: попередні частини лишають результати,
   наступні — `batch-aborted` — Task 4.
4. **Конкурентний коміт між частинами**: обидві бачать один знімок — Task 5b
   (DB).
5. **Пізня відповідь старої епохи, що стартувала до `purge`**: рядок не
   повертається — Task 9.

---

## B1c-1. T0, T1, T3

### Task 1: Схеми T0 — частини, `known`, маркери, відповідь

**Files:**
- Modify: `packages/simetra/src/model/runtime/envelope.ts` (`dataRequestSchema`: гілка `read` з `items`, без `version`; `wireReadQuerySchema` — `known` у списочній формі й формі картки; `wireReadResultSchema` — `rows` з маркерами; нова `wireReadPartsResultSchema`), `read.ts` (`READ_BATCH_MAX`), `ports.ts` (`WireReadPart`, `WireReadParts`), `mapping.ts` (`readPartToWire`, `readPartFromWire` — `known` переноситься окремо від запиту; `readResultToWire`, `readResultFromWire` — маркери)
- Test: `packages/simetra/src/model/runtime/__tests__/envelope.test.ts`, `read.test.ts`, `mapping.test.ts`

**Interfaces:**
- Produces: `READ_BATCH_MAX = 16`; `knownSchema` і тип `KnownVersions`; логічний маркер `KnownMarker = { known: number; copies?: Record<string, unknown> }` (копії — логічні імена) і `ReadPartValue = ReadCount | (Omit<ReadRows, "rows"> & { rows: Array<Record<string, unknown> | KnownMarker> })` у `read.ts`; `readResultToWire` / `readResultFromWire` (`mapping.ts`) кодують і декодують маркери; `WireReadPart` і `WireReadParts` — `z.infer` схем частини й відповіді в `envelope.ts` (одне визначення): частина — `{ type: "query", query: WireReadQuery & { known?: KnownVersions } } | { type: "version" }` (`count` — теж частина `query`), значення частини — `WireReadResult` (рядки з маркерами або лічильник) `| VersionValue`; `ports.ts` для адаптера лише звужує їх `Extract`; рядок результату — `WireRow | number | { $known: number; [copyColumn: string]: unknown }`; схема конверта бере частини як `z.array(z.unknown())` з межею, кожну частину валідує окрема схема (Task 5).

- [ ] **Step 1: Unit (`it.each`, одна таблиця на схему).** `known` — прийняті й відхилені форми з Global Constraints, зокрема `reason: "known-form"` для `count`, сторінки ТЧ, «ТЧ власника», картки з `tabularSections` і будь-якої форми з `include`; конверт `read` — 1 і 16 частин прийнято, 0 і 17 — відмова з причиною межі; рядки відповіді — ціле ≥ 0 і `{ $known }` прийнято, від'ємне, дробове й `{ $known: -1 }` — ні; `readPartToWire` / `readPartFromWire` переносять `known` без змін; `readResultToWire` / `readResultFromWire` — маркер туди й назад, частковий маркер з копіями в логічних і фізичних іменах; об'єкт з `$known` і з колонкою ключа — рядок, а не маркер.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test envelope read mapping`.
- [ ] **Step 3: Commit.** `feat(model): частини запиту read, known з епохою і маркери у формі передачі`

### Task 2: Позначка `copy` (T1)

**Files:**
- Create: `packages/simetra/src/compiler/copy-columns.ts`
- Modify: стадія компілятора, де є парсер і фізична модель (`packages/simetra/src/compiler/pipeline.ts` — збирання `CompiledModel`), `packages/simetra/src/compiler/runtime-catalog.ts` (`attributes()`: `copy: true` з `model.copyColumns`, шапка й ТЧ), `client-catalog.ts` (`attributeOf`: `present("copy", …)`), `packages/simetra/src/model/runtime/catalog.ts` (`catalogEntryAttributeSchema`: `copy: z.literal(true).optional()`)
- Test: `packages/simetra/src/compiler/__tests__/copy-columns.test.ts` (Create), `runtime-catalog.test.ts`

**Interfaces:**
- Produces: `copyColumns(table: PhysicalTable, parse: SqlParser): ReadonlySet<string>` — колонки з `origin.copyOf` і генеровані колонки, чий розібраний `generated.expression` має `ColumnRef` на колонку множини, до нерухомої точки; `CompiledModel.copyColumns: ReadonlyMap<string /* schema.table */, ReadonlySet<string>>`.

- [ ] **Step 1: Unit `copy-columns.test.ts`:** копія — у множині; генерована з копії — так; генерована з копії через іншу генеровану — так; генерована з `date` (`numberPeriod`) — ні. `runtime-catalog.test.ts`: атрибут копії шапки й рядка ТЧ має `copy: true` у каталозі рантайму й клієнта; звичайний — без поля; `kernelHash` і `snapshotHash` позначка не змінює.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test copy-columns runtime-catalog client-catalog pipeline`.
- [ ] **Step 3: Commit.** `feat(compiler): позначка copy атрибута каталогу`

### Task 3: Будівник з умовною проєкцією

**Files:**
- Modify: `packages/simetra/src/server/read.ts` (`ReadPlan.known`, `renderKnown`, `listProjection`, `cardProjection`, `buildObjectPlan`, `readResult`, `decodeRows`), `decode.ts`, `read-filter.ts` (колонки фільтра кваліфіковано `t.`), ключ картки — `t.<ключ>`
- Test: `packages/simetra/src/server/__tests__/read.test.ts`, `read-filter.test.ts`

**Interfaces:**
- Consumes: `KnownVersions` (Task 1), `copy` атрибута (Task 2), епоха бази транзакції (Task 4 передає її будівнику).
- Produces: `ReadPlan.known?: KnownVersions` (план будується до `BEGIN` наявним `buildReadPlan(catalog, object, query)` з додатковим аргументом `known`) і `renderKnown(plan: ReadPlan, dbEpoch: string | null): ReadStatement` під час виконання (план з `known` зберігає частини оператора — проєкцію, `FROM` і хвіст — замість готового тексту); коли `known.epoch === dbEpoch !== null`: `LEFT JOIN unnest($keys::uuid[], $versions::bigint[]) WITH ORDINALITY AS simetra_known(simetra_known_key, simetra_known_version, simetra_known_position) ON simetra_known.simetra_known_key = t.<ключ>`, проєкція `CASE WHEN t.<версія> = simetra_known.simetra_known_version THEN <маркер> ELSE <рядок> END`, де маркер — `(simetra_known.simetra_known_position - 1)::text` без копій і `jsonb_build_object('$known', simetra_known.simetra_known_position - 1, <колонки copy з тими самими приведеннями, що в рядку>)::text` з копіями; `where`, RLS і порядок не змінюються; масиви `$keys` і `$versions` — текстом масиву Postgres (`{…}`, UUID і цілі без лапок), бо порт приймає `(string | null)[]`; `readResult` / `decodeRows` (`read.ts`, `decode.ts`) розбирають маркер-ціле й `{ $known }` без колонки ключа в `KnownMarker`.

- [ ] **Step 1: Unit `read.test.ts`** (розібрані оператори): список і читання за ключами (`in` за ключем) з `known` і рівною епохою — `LEFT JOIN … WITH ORDINALITY` і `CASE` з однаковим типом гілок; `known` з іншою епохою чи `dbEpoch = null` — оператор без `known`; об'єкт з копіями — частковий маркер рівно з `$known` і колонками `copy`, без ключа; `known` з `include` — `known-form`; `ctx.read` будує той самий оператор, що й раніше; `decodeRows` дає `KnownMarker`. `read-filter.test.ts`: колонки кваліфіковано `t.`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test read read-filter hooks`.
- [ ] **Step 3: Commit.** `feat(server): умовна проєкція known у будівнику читання`

### Task 4: Серверна функція пакета `readParts`

**Files:**
- Modify: `packages/simetra/src/server/runtime.ts` (`readParts`; `read` через неї; RR для читань; опція `readBudgetMs`), `transaction.ts` (помічник бюджету читання за зразком `budget(phase)`)
- Test: `packages/simetra/src/server/__tests__/read-runtime.test.ts`

**Interfaces:**
- Produces: `CommandRuntime.readParts(session: SessionClaims, parts: readonly ReadPart[]): Promise<ReadPartsResult>`; `ReadPart = { type: "query"; query: ReadQuery; known?: KnownVersions }` (частину `version` обробляє лише обробник, Task 5); `ReadPartsResult = { epoch: string | null; items: Array<{ ok: true; value: ReadPartValue } | { ok: false; error: CommandError }> }`; необов'язковий `fit` (Task 5) зупиняє виконання решти частин; опція рантайму `readBudgetMs` (типово 15 000); `READ_BATCH_STATEMENTS_MAX = 32` у T0.
- Порядок результатів (П4-B §4.2): дедлайн перед частиною — вона й наступні `command.timeout` без виконання; помилка бази в частині — вона отримує свою помилку (`57014`, `25P04` — `command.timeout`), наступні — `batch-aborted`; втрата з'єднання — невиконаним `command.unavailable`; після `25P04` з'єднання знищується; виконані раніше частини лишають результати. 
- [ ] **Step 1: Unit `read-runtime.test.ts`** (порт-фейк з журналом операторів): рівно `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, налаштування (розібране: усі `set_config` Р1, `role` останнім), `SELECT simetra.row_version_epoch()`, по оператору на частину й ціль, `COMMIT`; залишок бюджету менший за стелю — окремий `set_config('statement_timeout', …)` перед оператором; дедлайн — `command.timeout` без операторів; `57014` у другій з трьох частин — перша з результатом, друга `command.timeout`, третя `batch-aborted`; обрив з'єднання — `command.unavailable` невиконаним; `runtime.read` дає ті самі оператори з однією частиною; епоха з оператора епохи — в результаті.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test read-runtime transaction`.
- [ ] **Step 3: Commit.** `feat(server): пакет читань в одній транзакції REPEATABLE READ`

### Task 5: Обробник частин, бюджет і походження

**Files:**
- Modify: `packages/simetra/src/server/data-handler.ts` (кроки 1, 3, 5, 6 для частин; `envelopeRefusal` — шлях `items.<i>`; невідомий тип запиту й `read` без `items` — `stale-client`), `compatibility.ts` (звірка на частину), `response-budget.ts` (`fitParts`), `origin.ts` (`IN_PROCESS_TYPES = {"read"}`)
- Modify (споживачі старого запиту `version`): `packages/simetra/src/server/__tests__/data-handler*.test.ts`, `compatibility.test.ts`, `packages/simetra/src/data/__tests__/runtime.test.ts`, `packages/designer/src/__tests__/data-handler.db.test.ts`; адаптер `packages/simetra/src/data/adapter.ts` — мінімально: одна частина `query`
- Test: `packages/simetra/src/server/__tests__/data-handler.test.ts`, `response-budget.test.ts`, `origin.test.ts`

**Interfaces:**
- Consumes: `readParts` (Task 4), схеми Task 1.
- Produces: `fitParts` — вимірювач, який обробник передає в `readParts` (`readParts(session, parts, { fit })`, `fit(index, value) => "accept" | "overflow"` міряє закодовану форму передачі частини проти залишку бюджету відповіді **до** виконання наступної частини); частина, чий результат не вміщується в залишок, а окремо вмістився б, виконана один раз і відкинута, вона й наступні (вже без виконання) — `batch-budget` (сторінка — непорожній префікс з `more: true`, коли вміщується); частина, що не вміщується й сама, — `response-too-large`.

- [ ] **Step 1: Unit:** невалідна частина — `command.invalid` лише їй; несумісна — `stale-client` лише їй; `version` — значення каталогу без звернення до порту; `subject` ≠ `sub` — відмова всього запиту; `{ type: "version" }` і `read` з `query` замість `items` — `stale-client`; невідомий тип частини — `command.invalid` лише їй; обидві гілки бюджету пакета (частина після переповнення не виконується — порт-фейк не бачить її оператора); понад `READ_BATCH_STATEMENTS_MAX` — `batch-too-large` до бази; `inProcess` пропускає `read` з будь-якими частинами, `run` і `receipt` — ні.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test data-handler response-budget origin compatibility runtime`.
- [ ] **Step 3: Commit.** `feat(server): обробник частин read, бюджет пакета й походження`

### Task 5b: DB-кейси пакета читань

**Files:**
- Create: `packages/designer/src/__tests__/read-batch.db.test.ts`

- [ ] **Step 1: DB** (причина DB: RLS, `unnest`, знімок `REPEATABLE READ` і епоха B1e виконує Postgres; під справжньою роллю входу): епоха читається під кожною роллю запиту провайдера (`user`, `anonymous` — коли є); ключ із `known`, невидимий під RLS, — відсутній; ключ поза `where` — відсутній; рівна версія й епоха — маркер; інша версія — рядок; ключ, якого немає в `known`, — повний рядок поряд із маркерами; `known` іншої епохи — повна відповідь; база без рядка епохи — `epoch: null` і повна відповідь; поширення копії носія без підвищення версії — частковий маркер з новою копією; пакет з двох частин і конкурентний коміт між ними (друге з'єднання) — обидві бачать стан до коміту; `epoch` — 64 hex.
- [ ] **Step 2: Гейти B1c-1.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm --filter @simetrajs/designer test:db read-batch read-query data-handler runtime-login`.
- [ ] **Step 3: Commit.** `test(server): DB-кейси пакета читань`

**Готово B1c-1:** unit T0/T1/T3 і DB-кейси Task 5b зелені; окремого запиту `version` немає; `runtime.read` і MCP `data-read` працюють як раніше.

## B1c-2. Порт, джерело ядра, епоха, документи

### Task 6: Порт і адаптер Server Function

**Files:**
- Modify: `packages/simetra/src/model/runtime/ports.ts` (`SourceAdapter.read(items: readonly WireReadPart[]): Promise<WireReadParts>`), `packages/simetra/src/data/adapter.ts`, фейк джерела `packages/simetra/src/data/store/testing/fake-source.ts`
- Test: `packages/simetra/src/data/__tests__/adapter.test.ts`, тести фейка

- [ ] **Step 1: Unit:** адаптер шле один запит з усіма частинами й повертає `WireReadParts`; збій транспорту — `command.unavailable` усім частинам; фейк приймає частини й `known` з епохою і віддає маркери за правилами сервера (рівна епоха — маркер, інша — повний рядок).
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test adapter fake-source`.
- [ ] **Step 3: Commit.** `feat(data): SourceAdapter.read на частинах`

### Task 7: `CoreSource` на частинах

**Files:**
- Modify: `packages/simetra/src/data/store/source.ts` (`CoreSource.read(parts)`, `createCoreSource`, `readKeys`, `serverRow` — маркер без `known` — `command.internal`), `readers.ts`, `include.ts` (виклики через частини)
- Test: тести `source`, `readers`, `include` гілки B3-2

**Interfaces:**
- Produces: `CoreSource.read(parts: readonly RowsQuery[]): Promise<CoreReadResult>`, `CoreReadResult = { items: Array<{ ok: true; rows: ReadRows; epoch: string | null } | { ok: false; error: CommandError }> }` — порядок частин збережено; частини групуються за адаптером (`sourceFor(object)`), кожна група — свій запит і своя епоха, тож епоха несеться на частину, а не на весь виклик; епоху версій бази `readKeys` переносить на кожен `ServerRow.versionEpoch` (кілька запитів одного виклику можуть мати різні епохи), а епоху старту читання сесії бере викликач (`readEpoch` у `readers.ts`, епохи старту `writer.ts` і `core.ts`), як і зараз; `readKeys` ділить ключі на частини по `ReadKeysOptions.keysPerRequest` (≤ 200), а форма картки — по ключу на частину, і частини — на запити по `READ_BATCH_MAX`, один слот обмежувача на запит; `batch-aborted` — повтор частин після упалої наступним запитом через обмежувач з паузою, що зростає; `batch-budget` — повтор наступним запитом; навпіл на `response-too-large` — як було.

- [ ] **Step 1: Unit:** частини двох об'єктів з різними адаптерами — два запити, порядок і епоха кожної частини збережені; 1 000 ключів — 5 частин в одному запиті й один слот; 4 000 ключів — два запити; `batch-aborted` у третій частині — повтор частин 3…n без упалої, з паузою; `batch-budget` — повтор; маркер без `known` — `command.internal`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test source readers include core`.
- [ ] **Step 3: Commit.** `feat(data): джерело ядра читає частинами`

### Task 8: Епоха у сховищах

**Files:**
- Modify: `packages/simetra/src/data/store/types.ts` (`ServerRow.versionEpoch`), `source.ts` (`serverRow`, `readKeys` переносять епоху), `object-store.ts` (`RowEntry.versionEpoch`, `mergeVersioned` за епохою, `lazyVersions` з епохою), `section-store.ts` (`ownerVersions` з епохою), `snapshot.ts` (`staleFields` порівнює лише версії однієї епохи)
- Test: тести `object-store`, `section-store`, `snapshot` гілки B3-2

**Interfaces:**
- Produces: правило — запис з `versionEpoch`, відмінною від запису в сховищі (обидві непорожні), заміняє його незалежно від версії; за `null` в одній зі сторін — звичайне правило версії (Р6).

- [ ] **Step 1: Unit:** рядок нової епохи з меншою версією заміняє рядок; `null`-епоха меншої версії — ні; «ТЧ власника» нової епохи з меншою `ownerVersion` приймається; ліниве поле старої епохи — `staleFields`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test object-store section-store snapshot`.
- [ ] **Step 3: Commit.** `feat(data): сховища несуть епоху версій`

### Task 9: Правило перемикання епохи

**Files:**
- Modify: `packages/simetra/src/data/store/epoch.ts` (`Epochs.remember` / `seen` з епохою версій бази запису; надгробки, горизонт і поховання пар не змінюються), `session.ts` (поточна епоха, покинуті, подія перемикання; `acceptEpoch(epoch: string | null, startEpoch: number): "apply" | "discard"` — єдина точка перевірки перед записом у сховище), виклики `acceptEpoch` у `readers.ts`, `include.ts`, `writer.ts`, `core.ts`, `object-store.ts` (позначка `stale.epoch` у `RowEntry.stale`; перемикання скидає `stale.minVersion` рядків і ТЧ; `remember` лише для поточної епохи), `types.ts` (`DEFAULT_CORE_LIMITS.revalidateIntervalMs = 60_000` — розкид Р8; такт інтервалу — B5), модельний тест B3-2
- Test: тести `epoch`, `core` гілки B3-2; модельний тест

**Interfaces:**
- Consumes: `ServerRow.versionEpoch` (Task 8) і епоха старту викликача; `acceptEpoch` викликається на `commit`, по кожному результату, у порядку застосування (у двофазному `revalidate` результат старої епохи, прийнятий до перемикання в тому самому `commit`, вже не перезапише рядка нової).
- Produces: перша непорожня епоха сесії задає поточну без скидання; інша непорожня — перемикання: пам'ять і позначки інших епох більше не беруться до уваги для відповідей поточної (Р5), `stale.epoch` усім рядкам, перечитування видимих виглядів з розкидом `[0, revalidateIntervalMs)`; відповідь іншої епохи від читання з `startEpoch` до перемикання не застосовується (ключі — `stale` і перечитування); позначку `epoch` знімає читання, що почалось після перемикання.

- [ ] **Step 1: Unit:** чергування `A`, `null`, `A` — жодного перемикання; `A`, `B`, `A` — друга `A` покинута, не застосована й не перемикає (і після десяти інших перемикань); після перемикання `null`-рядок вищої версії не заміняє рядка поточної епохи, ключ — `stale`; відповідь, що спричинила перемикання, застосована; `stale.minVersion` старої епохи не заважає першому читанню нової; після перемикання `null`-рядок версії, нижчої за запам'ятовану, — `stale`, а не `synced`; `null`-відповідь не знімає `stale.epoch`; після 8 відкинутих відповідей поспіль — `command.unavailable`; `A` → `B` — пам'ять епохи `A` не береться до уваги, `stale`, перечитування в межах інтервалу, а не одразу; пізня відповідь `A` після перемикання — не застосовано; читання до `buryPair`, відповідь з епохою `B` — рядок не записано; `purge` після перемикання діє як раніше.
- [ ] **Step 2: Модельний тест** — крок «перемикання епохи» з вагою; інваріанти «версія не зменшується» і «видалене й `purge` не воскресають» — у межах однієї епохи й через перемикання відповідно.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test epoch core model`.
- [ ] **Step 4: Commit.** `feat(data): версії порівнюються в межах однієї епохи версій бази`

### Task 10: Спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` — Рд24 і §6.2 правило 1 (Р5–Р8); §4.2 і §6.7 (Р1: 4 + частини + цілі, грант епохи; `readBudgetMs` — 15 с замість 30 с і `READ_BATCH_STATEMENTS_MAX = 32`); §12 (бюджет операторів 4 + частини + цілі); §4.5 і §5.1 (`value.epoch`, частини без окремого `version`, `stale-client` для старої форми); §4.1 (`known` лише у формі передачі й частині; маркери `n` і `{ $known }`); §3 (позначка `copy`); Рд40 (частковий маркер — `$known` і копії, без ключа й версії); §4.1 абзац «Епоха версій» (окремий оператор під роллю читання, епоха — у `value.epoch`); обґрунтування Рд41 і рядок B1c у §13 (лічильник операторів); §8.4 (`row_ver` сигналу — лише в межах поточної епохи, для B5); §14.3 (серверна межа одночасних читань на `subject` — П4-D); §6.6 (знімок SSR несе епоху — рядок Додатка А з колонкою B3-6); Додаток А — рядки B1c «внесено (B1c)»
- Modify: `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` §8.1 (рядок Додатка А), `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` §6.11 (транзакція читання `REPEATABLE READ READ ONLY`)

- [ ] **Step 1: Правки** за переліком; кожна — стан, без історії.
- [ ] **Step 2: Гейти B1c-2.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`.
- [ ] **Step 3: Commit.** `docs(spec): пакет читань, known і епоха версій під B1c`

**Готово B1c-2:** unit T4, модельний тест і DB-кейси зелені; повний `pnpm test:db` зелений; спеки оновлено; файлів ПГ-1 не змінено.

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| маркер окремим оператором «які версії» поза оператором з RLS | `read.test.ts` і `read-batch.db.test.ts` (невидимий ключ) |
| `known` як фільтр (`INNER JOIN`) | `read-batch.db.test.ts` (ключ поза `known`) |
| маркер без перевірки `known.epoch` | `read.test.ts` і `read-batch.db.test.ts` (інша епоха) |
| частковий маркер без колонок `copy` | `read-batch.db.test.ts` (поширення копії) |
| колонка фільтра без `t.` | `read-filter.test.ts` |
| `READ COMMITTED` замість `REPEATABLE READ` | `read-batch.db.test.ts` (конкурентний коміт) |
| наступні частини після помилки бази виконуються | `read-runtime.test.ts` |
| `batch-budget` для частини, що не вміщується й сама | `response-budget.test.ts` |
| версії порівнюються між епохами | Task 8 |
| перемикання епохи скидає надгробки | Task 9 (`buryPair`) |
| `null` змінює епоху | Task 9 (чергування) |
| обмежувач рахує частину, а не запит | Task 7 |
| `fit` після виконання всіх частин | `response-budget.test.ts` (оператор зайвої частини) |
| `null`-рядок заміняє рядок поточної епохи | Task 9 |
| покинута епоха витісняється | Task 9 |
| повернення на покинуту епоху перемикає | Task 9 (`A`, `B`, `A`) |
| перемикання без скидання `stale.minVersion` | Task 9 |
| `known` разом з `include` приймається | `envelope.test.ts` |
| пам'ять версій стирається замість позначки епохою | Task 9 (`null`-рядок після перемикання) |
