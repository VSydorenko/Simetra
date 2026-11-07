# П4-B3-3a — фасад запису й write-back: план реалізації

> **Статус:** на прийманні архітекторкою П4-B (2026-11-07). Підсумок аудиту —
> наприкінці файла. Виконання — після B3-2b (а отже після B3-1, B3-2a, B1b-1 і
> B1b-2). Інтерфейси B3-1, B3-2a і B3-2b взято з імен їхніх планів; якорі з
> позначкою «після B3-…» чи «після B1b-2» виконавець **звіряє в `main` перед
> стартом** (`orient --plan`). Розбіжність імені — перейменувати в плані за
> кодом; розбіжність поведінки — до архітекторки. Перед стартом — злиття
> `main` у гілку (без rebase).
>
> **Проміжний стан до B3-3b:** будь-яка відмова команди лише відхиляє
> транзакцію `CommandFailure` і доходить до викликача; дій за кодом §7.3
> (перечитування на `conflict` і `forbidden`, позначка «застарілий», запит
> `version`) ще немає, а реєстр власних створень звіряє лише перечитування
> після запису.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** фасад T4 приймає `create`, `update`, `markDeletion`, `delete`,
дельти рядка ТЧ і `batch` над логічними іменами, показує їх оптимістично,
шле одним `run` і закриває write-back рядками результату без зменшення
версії, без рядків без власника поза реєстром власних створень і без запису
після `dispose()`.

**Architecture:** один виклик фасаду — одна транзакція RC
(`createTransaction`, `autoCommit`) над колекціями об'єктів і ТЧ і один
`run` (§7.1). Обробник (`mutationFn`) стартує лише після осідання
попередніх мутацій тих самих ключів (черга ключа), бере базу з
підтвердженого знімка ключа чи синхронізованого рядка (§6.2), накладає
дельти рядка, шле `run`, пише рядки результату обгорткою прямого запису й
чекає межі вибірки перечитувань (§7.2). Весь код — у `src/data/facade/`;
публічний вхід `simetra/data` отримує `useWriter` і типи без `@tanstack/*`.

**Tech Stack:** TypeScript 7, `@tanstack/db` і `@tanstack/react-db`
1.0.0-rc.1.4, `@tanstack/query-db-collection` 1.5.1, `@tanstack/query-core`
5.107.1, React 19.3, Vitest (node і jsdom на файл).

**Spec:** [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) — Рд6,
Рд7, Рд22, Рд24–Рд27, Рд32, §4.5 (відповідь `run`), §6.1 («Помилки
розробника», «Колекція `full`»), §6.2 («прямий запис», «Повна підмножина ТЧ»,
«Підтверджений знімок ключа», правила 1–7), §6.3 (`waitPendingSettled`),
§6.4 («Позиція в сторінці»), §7.1, §7.2, §7.3 (перше речення й рядок
«решта»), §12 (кейси B3-3a за «Належністю кейсів»), §13 (рядок B3-3a).
[Звіт спайку B3](../specs/2026-11-07-p4-b3-facade-spike-report.md) — Q5, Q6.
Плани [B3-1](2026-11-07-p4-b3-1-t4-skeleton.md),
[B3-2a](2026-11-07-p4-b3-2a-collections.md),
[B3-2b](2026-11-07-p4-b3-2b-window-full-hooks.md). Наступна частина —
[B3-3b](2026-11-07-p4-b3-3b-error-actions-stale.md).

## Global Constraints

- Мова: коментарі — українською, «чому»; JSDoc публічного API — англійською.
- Коміти: Conventional Commits, український опис, без трейлерів; push — за
  дозволом через архітекторку; PR відкриває архітекторка; конфлікт із
  `main` — `git merge origin/main`, не rebase.
- Бібліотеку бачить лише `src/data/facade/`; `src/data/hooks.ts` — `react` і
  фасад; публічні типи `simetra/data` без `@tanstack/*` (тест `.d.ts` B3-1).
- Прямий запис — лише через обгортки: `applyFullRows` (B3-2b, колекція
  `full`), `sectionWrites` (B3-2a, колекції ТЧ) і нова `objectWrites`
  (задача 3, колекція об'єкта `on-demand`). `writeUpsert` не вживається.
  Присутність ключа — за `collection.base`; проміс `write*` завжди
  чекається в тому самому `try`, що й виклик.
- Рядок колекції не заміняється рядком меншої версії (Рд24): мапа версій
  B3-2a (`versionsOf`) оновлюється кожним записом фасаду.
- Рядків ТЧ обробник напряму не пише (Рд27): ТЧ свіжіє лише перезапитом
  «ТЧ власника».
- Обробник ніколи не чекає **застосування** результату в колекції (воно
  відкладене, поки в колекції є `persisting`-транзакція, зокрема власна —
  взаємне блокування): лише межу вибірки.
- Після кожного `await` асинхронна гілка перевіряє `runtime.disposed`; після
  `dispose()` (зокрема через `session-changed`) нічого не пише, не відкриває
  й не реєструє. Охорона обгортки транспорту B3-1 не покриває
  адаптера-перевизначення (`selectSource({ override })`), тож перевірка —
  у кожній гілці фасаду.
- `retry: false` лишається; автоповтору `run` немає.
- Поза блоком (B3-3b): дії за кодом §7.3, позначка «застарілий», `isStale`,
  `onStaleClient`, `resume()`, `navigated()`, запит `version`; (B5) звірка
  реєстру на `SUBSCRIBED`, `invalidate`, зміна скоупів.
- Тести: скіл `.agents/skills/writing-tests/SKILL.md`; справжня RC,
  фейковий транспорт B3-2a (розширений `run`); без `--` перед шаблоном
  vitest.

## Рішення

Розвилки поділу (3a/3b, межа — успішний шлях; таблиця §7.3 цілком у 3b)
погодила архітекторка 2026-11-07. Рішення З1–З8 — у листі архітекторці
разом із планом.

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| З1 | Публічний API запису — `useWriter(): DataWriter` (рантайм з `DataRuntimeProvider`) і `writerOf(runtime): DataWriter` для коду поза React. `DataWriter` — `create`, `update`, `markDeletion`, `delete`, `addLine`, `updateLine`, `removeLine` (кожен — один `run`) і `batch(ops)` (один `run`); усі повертають `Promise<WriteResult>`, що розв'язується після write-back (транзакція осіла), а відхиляється `CommandFailure` чи `DataError`. `expectedVersion` для `update` без ТЧ, `markDeletion`, `delete` і дельт — необов'язковий (фасад бере базу ключа, §6.2); явний — має перевагу | §7.1 (форма API) |
| З2 | Виклик без жодної оптимістичної мутації (`create` без `id` — корінь виду скоупу; `update` чи `delete` ключа, якого немає в колекції) іде тим самим обробником **поза транзакцією RC**: RC не викликає `mutationFn` порожньої транзакції (`transactions.ts`, `commit()`). Черга ключа й лічильник `waitPendingSettled` такий виклик теж рахують | §7.1 (примітка) |
| З3 | Транзакції — з `autoCommit` (типовим): `commit()` синхронно ставить `persisting`, тож відкат попередньої мутації ключа не відкочує наступну каскадом (`rollbackConflictingTransactions` бере лише `pending`); наступна стартує обробник від бази без змін і доходить до сервера сама | немає |
| З4 | `update` шле лише ті ключі `values`, значення яких відрізняються від бази ключа (структурна рівність після `encodeRow`); виклик без змінених значень і без ТЧ розв'язується без `run` рядком бази | §7.1 (`update`) |
| З5 | Дельта рядка для власника без жодної бази (немає ні знімка ТЧ, ні відкритої підмножини «ТЧ власника») — `DataError` `data.tabular-incomplete` синхронно; база є, але неповна чи з `ownerVersion` ≠ версії шапки — перезапит з межею `TABULAR_REFETCH_MS` = 5 000 мс, після межі — `command.conflict` | §7.1 (`data.tabular-incomplete`) |
| З6 | Рядок ТЧ у повному масиві — ключ рядка й логічні реквізити ТЧ з ознакою `insert` у каталозі (перелік вставки, §10); клієнтське `ownerVersion`, власник і службові колонки не шлються. Так на будь-якій дії, зокрема `update` (переліку `update` для ТЧ немає — після B1b-2) | немає |
| З7 | Межа очікування перечитувань після запису — `WRITE_BACK_REFETCH_MS` = 5 000 мс (опція рантайму `writeBackRefetchMs`, тести — малий); після межі — `needsRefresh`, без відхилення | немає |
| З8 | Нові види `DataLogEntry`: `{ kind: "write-back-failed"; object; ids; error: unknown }` (збій write-back після `COMMIT`, §7.2 крок 7) і `{ kind: "write-back-reread-timeout"; object; ids }` | немає |

## Review Focus

1. **Write-back після `dispose()` чи `session-changed` посеред обробника** —
   відповідь `run` приходить після `dispose()` (зокрема через
   адаптер-перевизначення й обхідний фейк): жодного `write*`, жодної
   підмножини, реєстр порожній; задача 8.
2. **Дві швидкі зміни того самого ключа, перша відкочується** — друга не
   відкочується каскадом, бере базу без змін, сервер приймає; задача 2.
3. **Власний `create` під час перестворення `full` як `window`** — рядок не
   губиться й не дублюється, реєстр перенесено; задача 7.
4. **Ключ вивантажено між відбором за `base` і `writeBatch`** — відхилення
   пакета, поштучний повтор, решта рядків записана, відхилення не виходить з
   обробника; задача 3.
5. **Дельта рядка, поки перезапит «ТЧ власника» стоїть за чужою
   `persisting`-транзакцією** — база з підтвердженого знімка, межа вибірки,
   без очікування застосування; задачі 4 і 5.

---

### Task 0: спека (у коміті планів)

**Files:** `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`.

- [x] §13: рядок B3-3 поділено на B3-3a і B3-3b (як B3-2a/B3-2b); речення
  «B3 поділено…» і порядок — `B3-3a → B3-3b`; рядок B5 — плюс
  «`command.unavailable` на `create` кореня виду скоупу — перечитування знімка
  прав і переліку скоупів» (рішення архітекторки).
- [x] §12 «Належність кейсів»: B3-3 → B3-3a (фасад запису, чернетка й дельти,
  знімок, write-back, перечитування після запису, реєстр і його перенесення,
  write-back після `dispose()`) і B3-3b (таблиця «код → дія», звірка реєстру
  на конфлікті й відмові, позначка, «подія → `version`»); `command.unavailable`
  на `create` кореня — знімок прав — B5.
- [x] Додаток А: рядки з блоком B3-3 — за частинами; рядок
  «`command.forbidden` `origin`» — B3-3b.
- [x] Рішення З1 (§7.1 форма API), З2 (§7.1), З4 (§7.1 `update`), З5 (§7.1
  `data.tabular-incomplete`).
- [x] `python3 scripts/check-doc-anchors.py`; коміт разом із планами.

### Task 1: API запису, перевірки до транспорту й форма `run`

**Files:** Create `packages/simetra/src/data/facade/writer.ts`; Modify
`packages/simetra/src/data/hooks.ts`, `packages/simetra/src/data/index.ts`,
`packages/simetra/src/data/facade/__tests__/fake-transport.ts` (після
B3-2b); Test `packages/simetra/src/data/facade/__tests__/writer.test.ts`.

**Interfaces:**
- Consumes (після B1b-2): `Operation`, `BATCH_MAX`, `LIMIT_REASONS`,
  `operationToWire`, `catalogIndex`, `CommandFailure`; запит `run` — рівно
  одне з `operation` і `batch`, плюс `kernels` (UUID → `kernelHash`);
  (після B3-1) обгортка транспорту рантайму (`facadeOf(runtime)`), `DataError`.
- Produces:
  - `export type WriteOp =`
    `| { action: "create"; object: MetadataRef; id?: string; values?: Record<string, unknown>; tabularSections?: Record<string, LogicalRow[]>; creatorMember?: Record<string, unknown> }`
    `| { action: "update"; object; id: string; values?: Record<string, unknown>; tabularSections?: Record<string, LogicalRow[]>; expectedVersion?: number }`
    `| { action: "markDeletion"; object; id; mark: boolean; expectedVersion?: number }`
    `| { action: "delete"; object; id; expectedVersion?: number }`
    `| { action: "addLine"; object; id; section: string; line: LogicalRow }`
    `| { action: "updateLine"; object; id; section: string; lineId: string; values: Record<string, unknown> }`
    `| { action: "removeLine"; object; id; section: string; lineId: string }`
  - `export type WriteResult = { rows: ReadonlyArray<LogicalRow | undefined> }`
    — рядок результату на операцію (без лінивих колонок і ТЧ); `undefined` —
    відповідь без `rows` чи неповний рядок.
  - `export interface DataWriter { create(op: Omit<Extract<WriteOp, { action: "create" }>, "action">): Promise<WriteResult>; …; batch(ops: readonly WriteOp[]): Promise<WriteResult> }`
    — по методу на кожен `action`.
  - `writerOf(runtime: DataRuntime): DataWriter` (кеш на рантаймі),
    `useWriter(): DataWriter` у `hooks.ts`.
  - Внутрішнє: `prepareOps(runtime, ops): PreparedOp[]` — синхронні перевірки
    до транзакції; `runRequest(runtime, wireOps): DataRequest["request"]` —
    `{ type: "run", operation }` для одного, `{ type: "run", batch }` для
    кількох, `kernels` — за UUID кожного об'єкта операцій.
- Перевірки до транспорту (синхронно, до транзакції й черги):
  `ops.length` 0 — `TypeError`; понад `BATCH_MAX` — відхилення
  `CommandFailure` `command.invalid` `reason: "batch-too-large"`;
  `update` з `tabularSections` без `expectedVersion` — `DataError`
  `data.version-required`; об'єкт поза каталогом — `TypeError` (Р4 B3-2a);
  дельти й `update` з `tabularSections` того самого власника й ТЧ в одному
  виклику — `TypeError` (два джерела повного масиву); після `dispose()` —
  відхилення без транспорту (той самий код, що в обгортці B3-1).
- `create` без `id` для об'єкта, що не є коренем виду скоупу — фасад дає
  `crypto.randomUUID()` (§7.1); для кореня — без `id` (T3 дає id, З2).
- Фейк: `run` за формою передачі — таблиці в пам'яті, версія +1 на запис,
  `command.conflict` за `expectedVersion`, рядки результату за
  `fitRunResult`-правилом (бюджет: без `rows`), журнал, затримка й керований
  порядок відповідей.

- [ ] **Step 1: Failing tests:** `batch` з 501 операції — відмова
  `batch-too-large`, журнал транспорту порожній, оптимістичного стану немає;
  `update` з ТЧ без версії — `data.version-required` синхронно; одна операція
  — запит з `operation`, дві — з `batch` в тому самому порядку; `kernels` має
  рівно об'єкти операцій; `create` без `id` — UUID у запиті й в
  оптимістичному рядку; корінь скоупу без `id` — без оптимістичного рядка;
  `useWriter` без провайдера — `Error`; `writerOf(r)` стабільний; після
  `dispose()` — відмова без транспорту.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test writer`).
- [ ] **Step 5: Commit** — `feat(data): API запису фасаду й перевірки до транспорту`.

### Task 2: транзакція, черга ключа, знімок і `waitPendingSettled`

**Files:** Create `packages/simetra/src/data/facade/transactions.ts`,
`packages/simetra/src/data/facade/snapshots.ts`; Modify `writer.ts`; Test
`transactions.test.ts`.

**Interfaces:**
- `runWrite(runtime, prepared: PreparedOp[]): Promise<WriteResult>` — ключі
  виклику (`<UUID об'єкта>:<id>`; `create` без `id` ключа не має); якщо є
  хоч одна оптимістична мутація — `createTransaction({ mutationFn })` і
  `tx.mutate(() => …)` синхронно (оптимістично: `insert` для `create`,
  `update` змінених атрибутів для присутнього ключа, `delete`, дельти рядка
  над колекцією ТЧ; `markDeletion` — `update` поля позначки); результат —
  `tx.when("settled")`; інакше — обробник напряму (З2).
- `keyQueue(runtime)`: `enqueue(keys: string[], start: () => Promise<T>): Promise<T>`
  — `start` стартує, коли осіли всі попередні виклики з будь-яким з цих
  ключів (успіх чи відмова); один виклик з кількома ключами чекає всіх.
  Обробник викликає `enqueue` першим кроком (оптимістичний стан уже
  показано).
- `snapshotsOf(runtime)`: на ключ `{ header?: { row: LogicalRow; version: number }; sections?: Record<string, { rows: LogicalRow[]; ownerVersion: number }> }`;
  `baseOf(runtime, object, id): { version?: number; row?: LogicalRow }` —
  новіший за версією з `header` знімка й синхронізованого рядка (`base`,
  не оптимістичного); прибирання: шапка — коли колекція застосувала рядок з
  версією ≥ знімка (перевірка в обгортках запису й `keepNewer`), ТЧ — коли
  застосовано підмножину з `ownerVersion` ≥ знімка (перенесення
  `ownerVersion` B3-2a), увесь знімок — з вивантаженням ключа (той самий
  гачок, що прибирає мапу версій B3-2a); новіша версія з сигналу чи
  перечитування робить знімок застарілим (`baseOf` бере новіше).
- `waitPendingSettled(collection): Promise<void>` — лічильник фасаду на
  колекцію: кожен `runWrite` збільшує його для кожної зачепленої колекції до
  старту й зменшує після осідання (і для гілки З2); проміс розв'язується, коли
  лічильник 0; ніколи не відхиляється.
- `expectedVersion` операції без явного — `baseOf(...).version` у мить
  старту обробника (після черги); ключа немає ні в знімку, ні в колекції —
  операція без версії йде до сервера тільки для `create`; для решти —
  `command.conflict` не вигадується: `update`/`markDeletion`/`delete` без
  бази й без явної версії — `DataError` `data.version-required`.

- [ ] **Step 1: Failing tests:**
  - дві швидкі зміни шапки одного рядка — обидві успішні; друга несе
    `expectedVersion` = версія з результату першої, хоча застосування
    результату першої відкладене `persisting`-транзакцією іншого ключа
    (`createTransaction` з обробником, що чекає ручного сигналу);
  - мутація: `expectedVersion` з оптимістичного рядка чи взятий до осідання
    попередньої — тест червоніє;
  - перша з двох змін ключа отримує `command.conflict` — друга не відкочена
    каскадом, стартує від бази без змін, сервер її приймає (Review Focus 2);
  - мутації різних ключів не чекають одна одну (обробник другої стартує,
    поки перша в польоті);
  - `waitPendingSettled` на двох колекціях: одна транзакція успішна, друга
    відкочується — проміс розв'язується після обох, не відхиляється;
    гілка без транзакції (З2) теж рахується;
  - знімок: шапка прибирається після застосування рядка з версією ≥;
    вивантаження ключа прибирає увесь знімок; новіша версія з
    перечитування — `baseOf` бере її;
  - один `run` на виклик через кілька колекцій (об'єкт і ТЧ).
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test transactions`).
- [ ] **Step 5: Commit** — `feat(data): транзакція запису, черга ключа й підтверджений знімок`.

### Task 3: обробник — write-back рядків результату (§7.2, кроки 1–5, 7–8)

**Files:** Create `packages/simetra/src/data/facade/write-back.ts`; Modify
`packages/simetra/src/data/facade/writes.ts` (після B3-2a: `objectWrites`
поруч із `sectionWrites`), `full.ts` (після B3-2b: `applyFullRows` вживає
спільний розбір помилок), `runtime.ts` (`DataLogEntry`, З8); Test
`write-back.test.ts`.

**Interfaces:**
- `objectWrites(runtime, object)` — єдина обгортка прямих записів у колекцію
  об'єкта `on-demand`: `apply(rows, { ownCreates: Set<string> }): Promise<void>`
  і `remove(ids): Promise<void>`. Відбір за `collection.base`: присутній ключ
  — `writeUpdate`, якщо версія ≥ найбільшої баченої (`versionsOf`);
  відсутній — лише власний `create` (`writeInsert`), інакше пропуск;
  дублікати ключа зведено до найбільшої версії до пакета; один
  `writeBatch` на колекцію, проміс чекається; відхилення:
  `UpdateOperationItemNotFoundError`/`DeleteOperationItemNotFoundError` —
  поштучний повтор, повторне відхилення ключа — проковтнути;
  `DuplicateKeySyncError` — `writeUpdate` за правилом версії;
  `SyncNotInitializedError` (синхронно) і `SyncTransactionAbortedError` —
  проковтнути; розпізнавання — `instanceof`. Для колекції `full` — делегує
  `applyFullRows`. Видалення рядка — `writeDelete` рядка й рядків його ТЧ
  (`sectionWrites(...).remove` за власником).
- `decodeRunResult(entry index, value): { rows?: Array<LogicalRow | undefined>; changes: Change[] }`
  — `decodeRow` кожного рядка (після B1b-2: якщо в T0 є декодер результату
  `run`, вжити його), `changesFromWire`.
- `writeBack(runtime, ops, result)`: крок 2 — рядки результату стають
  `header` знімка ключа і йдуть в `objectWrites.apply`; крок 3 — неповний
  рядок (лише ключ і версія) не пишеться, а йде в перечитування; крок 4 —
  рядок об'єкта без колекції в рантаймі (колекцію не відкривали) не пишеться
  і колекції не створює; `delete` — `objectWrites.remove`; крок 5 — ключі
  `changes`, яких `rows` не покривають (зокрема відповідь без `rows`), —
  `rereadKeys`; крок 7 — будь-який виняток write-back (після успішного `run`)
  — `log({ kind: "write-back-failed", … })` і `rereadKeys`, транзакцію не
  відхиляє.
- `rereadKeys(runtime, object, ids): Promise<void>` — читання за ключами
  (форма 1, по ≤ 200) через адаптер, без відкриття підмножини; повернутий
  рядок — `objectWrites.apply` (власник — підмножина, що його вже тримає;
  відсутній ключ не вставляється, крім власного створення з реєстру й
  колекції `full`); не повернутий — `objectWrites.remove` (інв. 9).
- Гілка після `run`: перевірка `runtime.disposed` — після `dispose()` нічого.

- [ ] **Step 1: Failing tests:**
  - рядок результату присутнього ключа — у колекції версія результату;
    результат меншої версії не заміняє рядка (мапа версій);
  - ключ поза колекцією, не власний `create`, — не записано; власний
    `create` відсутнього ключа — `writeInsert`; уже синхронізований
    (принесла інша підмножина) — `writeUpdate` за версією;
  - Review Focus 4: ключ вивантажено між відбором і `writeBatch` (керований
    фейк: `cleanup` підмножини в мить між) — решта рядків записана, обробник
    розв'язався успіхом;
  - дублікати ключа в пакеті — найбільша версія, без `DuplicateKeyInBatchError`;
  - неповний рядок — не записано, рядок перечитано; відповідь без `rows` —
    перечитування ключів `changes`; ключ `changes` поза операціями (фаза
    `ctx.run`) — перечитано;
  - `delete` — рядок і його рядки ТЧ прибрано; перечитування без рядка —
    прибрано;
  - рядок об'єкта, чию колекцію не відкривали, — колекції не створено;
  - збій write-back після `COMMIT` (шпигун кидає з `writeBatch`) — запис
    `write-back-failed` у `log`, перечитування, транзакція не відхилена;
  - мутації (червоніють): прибрати `writeBatch`; писати `rows` до транспорту;
    писати неповний рядок; випустити відхилення `writeBatch` з обробника;
    відхилити транзакцію через збій write-back.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test write-back`).
- [ ] **Step 5: Commit** — `feat(data): write-back рядків результату команди`.

### Task 4: перечитування після запису й знімок ТЧ (§7.2, крок 6)

**Files:** Modify `write-back.ts`, `sections.ts`, `card.ts` (після B3-2a);
Test `write-back-reread.test.ts`.

**Interfaces:**
- `fetchedOnce(handle: SectionHandle | CardHandle): Promise<FetchResult>` —
  проміс **межі вибірки**: розв'язується, коли `queryFn` цієї підмножини
  повернув результат (точка `keepNewer`/`keepNewerSection` B3-2a), а не коли
  його застосовано; для ТЧ — `{ rows; ownerVersion }`. Запуск — `refresh()`
  хендла (single-flight з хвостом, Р7 B3-2a), сам проміс `refresh()`
  обробник **не чекає**: застосування стоїть за власною `persisting`
  транзакцією.
- Обробник після `writeBack`: перезапит підмножини картки — коли операція
  змінила лінивий атрибут чи відповідь без `rows`; перезапит кожної активної
  підмножини «ТЧ власника» змінених власників (операція з `tabularSections`
  чи дельтою); чекає `Promise.all` з межею `writeBackRefetchMs` (З7);
  відповідь «ТЧ власника» — `sections` знімка ключа; після межі чи збою —
  `needsRefresh` підмножини і `log({ kind: "write-back-reread-timeout" })`,
  транзакцію не відхиляє. Неактивна підмножина — без перезапиту.
- Тест «потік мутацій інших ключів не затримує наступної мутації ключа понад
  межу вибірки» (§13): фоновий потік транзакцій інших ключів тримає колекцію
  ТЧ у `persisting` безперервно; дві послідовні дельти одного власника —
  друга стартує обробник не пізніше, ніж повернувся `queryFn` перезапиту
  першої (лічильник фейку), і бере `ownerVersion` зі знімка.

- [ ] **Step 1: Failing tests:** тест §13 вище; перезапит картки лише за
  лінивим атрибутом чи без `rows`; тайм-аут — `needsRefresh`, транзакція
  успішна; `ownerVersion` підмножини оновлюється лише після застосування
  (B3-2a), а знімок — на межі вибірки; мутації: чекати застосування в
  обробнику (тест §13 висне до межі тесту — червоніє); не чекати
  перечитувань (наступна дельта бере стару базу — `command.conflict`).
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test write-back-reread`).
- [ ] **Step 5: Commit** — `feat(data): перечитування після запису до межі вибірки`.

### Task 5: чернетка й дельта рядка ТЧ

**Files:** Create `packages/simetra/src/data/facade/tabular-write.ts`;
Modify `transactions.ts`; Test `tabular-write.test.ts`.

**Interfaces:**
- `lineForWrite(entry, section, row: LogicalRow): LogicalRow` (З6) — ключ
  рядка й реквізити ТЧ з `insert` у каталозі.
- Чернетка: `update` з `tabularSections` і явним `expectedVersion` іде як
  є (масиви — через `lineForWrite`); фасад не переносить її на новіший
  знімок; рядок ТЧ чернетки не перевіряє на повноту — масив дав викликач.
- Дельта: `resolveSectionBase(runtime, object, id, section): Promise<{ rows; ownerVersion }>`
  на старті обробника (після черги): кандидати — знімок ТЧ ключа і повна
  підмножина (`complete` B3-2a); береться новіший за `ownerVersion`, у якого
  `ownerVersion` = версії шапки **тієї самої** бази (`baseOf`); якщо такого
  немає, але підмножина відкрита, — `fetchedOnce` перезапиту з межею
  `TABULAR_REFETCH_MS` (З5); після межі чи розбіжності — `CommandFailure`
  `command.conflict`; бази немає зовсім — `data.tabular-incomplete`
  (синхронно на виклику, З5). Злиття: `addLine` — рядок з `id` (якщо немає —
  `crypto.randomUUID()`) у кінець; `updateLine` — лише дані поля поверх
  рядка бази; `removeLine` — без рядка; ціль `updateLine`/`removeLine`
  відсутня в базі — `command.conflict` без транспорту. Повний масив
  (`lineForWrite`) іде як `update` власника з `expectedVersion` = версія
  шапки бази.
- Оптимістично дельта — мутація колекції ТЧ у транзакції (`insert`,
  `update`, `delete` рядка); повноти не скидає (B3-2a).

- [ ] **Step 1: Failing tests:**
  - дві швидкі дельти різних рядків ТЧ — обидві успішні, жодна не відкочує
    іншої; паралельна зміна інших полів того самого рядка (на сервері між
    дельтами) зберігається;
  - рядок-ціль видалено паралельно — `command.conflict`, рядок не вставлено;
  - знімок з `ownerVersion` ≠ версії шапки — перезапит, після межі —
    `command.conflict`;
  - Review Focus 5: дельта, поки перезапит «ТЧ власника» стоїть за чужою
    `persisting`-транзакцією, — база зі знімка, без очікування застосування;
  - чернетка після паралельної зміни — `command.conflict`, а не тиха заміна;
    чернетку не перенесено на новіший знімок;
  - дельта без бази — `data.tabular-incomplete`, без транспорту;
  - рядок у масиві — лише ключ і реквізити з `insert` (немає
    `ownerVersion`);
  - мутації: накласти дельту на підмножину з версією ≠ версії шапки; повторно
    вставити видалений рядок; перенести чернетку на новіший знімок; будувати
    масив без перевірки `ownerVersion`.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test tabular-write`).
- [ ] **Step 5: Commit** — `feat(data): чернетка й дельта рядка ТЧ`.

### Task 6: реєстр власних створень і показ у сторінці вікна

**Files:** Create `packages/simetra/src/data/facade/own-creates.ts`; Modify
`write-back.ts`, `versions.ts`, `window.ts` (після B3-2b); Test
`own-creates.test.ts`.

**Interfaces:**
- `ownCreatesOf(runtime, object): { add(id): void; has(id): boolean; keys(): string[]; delete(id): void }`
  — ключ потрапляє в реєстр на write-back власного `create`; виходить, щойно
  будь-який результат `queryFn` поверне цей ключ (гачок у `keepNewer`) чи
  `rereadKeys` його не поверне (рядок прибрано).
- `reconcileOwnCreates(runtime, object?): Promise<void>` — пакетне
  перечитування ключів реєстру (`rereadKeys`, `in` до 200); точка виклику
  для B3-3b (конфлікт і відмова) і B5 (`SUBSCRIBED`, `invalidate`, зміна
  скоупів). У 3a — лише прямий тест і перенесення в задачі 7.
- Показ: список `window`, чий предикат (обчислювач B3-2a) пропускає власний
  `create` (оптимістичний рядок чи рядок реєстру), показує його на початку
  першої завантаженої сторінки — `rows()` вікна; ключ не входить в
  `inArray` підмножини сторінки; показ тримається до оновлення сторінки
  (`refreshFrom`).
- `dispose()` очищує реєстр.

- [ ] **Step 1: Failing tests:** власне створення переживає вивантаження
  всіх підмножин; виходить з реєстру, щойно сторінка його поверне;
  `reconcileOwnCreates` — рядок, якого перечитування не повернуло,
  прибрано, реєстр порожній; 450 ключів — три запити (200, 200, 50);
  `create`, що підходить предикату вікна, — на початку першої сторінки
  оптимістично й після write-back, `inArray` сторінки без нього (журнал
  `loadSubset`); після `refreshFrom(0)` — на серверній позиції, один раз;
  мутація: додати власний `create` в `inArray` сторінки.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test own-creates`).
- [ ] **Step 5: Commit** — `feat(data): реєстр власних створень і показ у вікні`.

### Task 7: перенесення в `rebuildAsWindow`

**Files:** Modify `packages/simetra/src/data/facade/full.ts` (після B3-2b);
Test `full-rebuild-writes.test.ts`.

**Interfaces:** `rebuildAsWindow` (задача 5 B3-2b) отримує між кроком 2
(`markTruncated`) і кроком 3 (`cleanup({ dependents: true })`):
2a) `await waitPendingSettled(eager)` — незавершені write-back у `eager`
осідають (нові виклики після кроку 1 уже бачать нову колекцію: обробник
бере колекцію через `collectionsOf` у мить запису, не з замикання);
2b) перевірка `runtime.disposed`; 2c) рядки реєстру власних створень
об'єкта, присутні в `eager`, — `objectWrites(...).apply(rows, { ownCreates })`
у нову колекцію `on-demand` (там вони — власні створення без власника).
Рядки, які write-back після кроку 1 уже записав у нову колекцію, не
дублюються (правило версії).

- [ ] **Step 1: Failing tests:** Review Focus 3 — `create` в польоті під час
  перевищення межі `full` без `strict`: після перестворення рядок у новій
  колекції рівно один раз, реєстр має ключ, стара колекція `cleaned-up`;
  write-back, що закінчився між кроками 1 і 3, — у новій колекції;
  `dispose()` під час 2a — нічого не перенесено; мутація: перенесення після
  `cleanup` (рядок загублено).
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test full-rebuild-writes`).
- [ ] **Step 5: Commit** — `feat(data): перенесення реєстру й write-back під час перестворення full`.

### Task 8: `dispose()` і `session-changed` посеред запису, мутації, документація, гейти

**Files:** Test `write-dispose.test.ts`; docs.

- [ ] **Step 1: Failing tests** (Review Focus 1; §13 «write-back після
  `dispose()` чи `session-changed` нікуди не пише»): для кожного джерела —
  обгортка транспорту B3-1 і адаптер-перевизначення з затримкою (перечитування
  йдуть через адаптер) — і для кожної точки — відповідь `run`, відповідь
  перечитування після запису, `fetchedOnce`, перенесення задачі 7: `dispose()`
  у польоті → після відповіді нуль `write*` (шпигун на `utils` кожної
  колекції), нових підмножин немає, реєстр і знімки порожні, `size` 0;
  відповідь `command.unauthenticated` `session-changed` на `run` при іншій
  транзакції в польоті — друга нічого не пише, `onSessionChanged` один раз,
  проміси обох відхилено.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test write-dispose`).
- [ ] **Step 5: Mutation check (без коміту; кожна червоніє):** зняти
  перевірку `runtime.disposed` після `run` (задача 8); після `fetchedOnce`
  (задача 8); `writeUpsert` замість відбору за `base` (задача 3); брати
  `expectedVersion` з оптимістичного рядка (задача 2); `update` усіх
  атрибутів, а не змінених (задача 1, журнал); розбити `batch` понад
  `BATCH_MAX` (задача 1). Повернути код.
- [ ] **Step 6:** спека П4-B — рядок §14.3 «Повторна адверсарійна перевірка…»:
  частину B3-3 (дельта рядка й чернетка) — «закрито (B3-3a)»; Додаток А
  «платформна спека §8.1» — внести в
  `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` §8.1
  write-back рядками результату й рядок без власника (лише власне
  створення, прибирає перечитування за ключем) і позначити «внесено
  (B3-3a)»; `docs/ROADMAP.md` (рядок П4: B3-3a); скіл споживача
  `packages/designer/skills/` — якщо є розділ даних застосунку, додати
  `useWriter`; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 7: Гейти:**

```bash
pnpm deps:check
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm metadata:check
pnpm test:db
pnpm build:packages && pnpm test:packaging
```

- [ ] **Step 8: Commit** — `docs(spec): П4-B3-3a — §8.1 платформної, §14 і ROADMAP`.

## Готово (§13, рядок B3-3a)

- кейси запису B3-3a з §12 зелені на справжній RC;
- тест «потік мутацій інших ключів не затримує наступної мутації ключа понад
  межу вибірки» (задача 4) і «write-back після `dispose()` чи
  `session-changed` нікуди не пише» (задача 8) зелені;
- мутації задач 3–8 червоніють; гейти зелені.

## Підсумок аудиту плану

(заповнюється після аудиту)
