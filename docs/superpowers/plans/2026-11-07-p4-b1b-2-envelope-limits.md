# П4-B1b-2 — конверт, звірка й межі: план реалізації

> **Статус:** чернетка, на аудиті. Виконання — після мерджу B1b-1 і B1b-3 в
> `main` і «так» архітекторки. Підсумок аудиту — наприкінці файла.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** T3 дає `createDataHandler(runtime)` — обробник конверта даних
(`read`, `run`, `version`) з перевіркою походження, звіркою сесії й
сумісності, мапінгом форми передачі й бюджетом відповіді; T0 дає схеми
конверта, порт `DataTransport`, сталі меж і новий код `command.stale-client`;
метадані — `maxBytes` атрибута з валідацією й правилами бюджету компілятора;
`runtime.run` перевіряє зменшені межі; кожна помилка з `path` чи
`attributes` несе `object`; декодер T3 переходить на `decodeRow` T0.

**Architecture:** обробник — тонкий шар T3 над `runtime.read` і
`runtime.run`: кроки 0–6 §4.5 спеки в тому самому порядку, усі відмови до
порту — значення `{ ok: false, error }`. Звірка сумісності — чиста функція
над каталогом рантайму й `objectColumns` T0 (B1b-1); переклад форми — мапінг
T0 (B1b-1). Межі тіла запиту тримають host (П4-D) і фасад (B3): B1b-2 дає
лише сталу й код.

**Tech Stack:** TypeScript 7 (native `tsc`), Zod 4, Vitest; один DB-кейс
через designer (`*.db.test.ts`).

**Spec:** [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) — §2
(Рд4, Рд12, Рд13, Рд17, Рд26, Рд27), §4.0, §4.4, §4.5, §7.1 (межі), §7.3,
§10, §11, §12 (кейси B1b-2: unit T0, unit T1, unit T3, unit T3 + мапінг), §13
(рядок B1b-2), §14.3 (рядки B1b-2), Додаток А (рядки з B1b-2).
[Спека П4](../specs/2026-10-26-p4-runtime-design.md) §6.4, §6.10, Рт11, Рт19.
План B1b-1 — `docs/superpowers/plans/2026-11-07-p4-b1b-1-client-catalog-wire.md`;
план B1b-3 — у `main` після його мерджу.

## Global Constraints

- Мова: коментарі в коді — українською й пояснюють «чому»; JSDoc
  експортованого API й повідомлення — англійською.
- T0 — лише `zod`; T3 імпортує T0 і T1, не навпаки
  (`packages/simetra/eslint.tier-zones.js`); тести T0 теж під межею ярусів.
- Без `z.any()`, без реекспортів і шимів (принцип 5 `AGENTS.md`).
- Тести — за `.agents/skills/writing-tests/SKILL.md`: unit перед DB, таблиці
  `it.each`, будівники фікстур (T0 — `model/runtime/__tests__/entries.ts`).
  DB-кейс — один, із причиною в назві.
- Записи за іменем з даних — лише через `Map`, `Object.hasOwn`,
  `Object.fromEntries`.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter`. DB — лише через
  проєкт `db`; повний `pnpm test:db` — раз наприкінці блоку.
- Коміти — Conventional Commits, опис українською, без трейлерів; коміт після
  кожної задачі. Перед кожним комітом `git diff --stat` — лише файли задачі.
- Робоча копія — власний worktree від `main`; основний checkout не чіпати.

## Якорі «після B1b-1» і «після B1b-3»

Перед стартом: rebase на `main`, `orient --plan` цього файла, звірка
кожного якоря.

- B1b-1: `catalogEntrySchema` і `kernelHash` (`model/runtime/catalog.ts`),
  `objectColumns` (`model/runtime/columns.ts`), `clientCatalogSchema`,
  `wire.ts` (`encodeRow`, `decodeRow`, `WireDecodeError`), `mapping.ts`
  (`catalogIndex`, `Mapped`, `operationFromWire`, `readQueryFromWire`,
  `readResultToWire`, `errorToWire`, `changesToWire`), `envelope.ts`
  (`wireOperationSchema`, `wireCommandErrorSchema`, `wireChangeSchema`,
  `wireReadQuerySchema`, `wireReadResultSchema`), `path.ts`.
- B1b-3: `BATCH_MAX` (`model/runtime/operation.ts`), опція виклику
  `{ fullTabularArrays: true }` `runtime.run` (Ф3 плану B1b-3), опції
  `CommandRuntimeOptions` бюджету часу (`server/runtime.ts`), коди
  `command.busy`/`command.timeout`.

## Рішення (до плану)

| № | Рішення | Хто | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | `BATCH_MAX` вводить B1b-3; B1b-2 обмежує ним схему пакета (`batch-too-large`) і додає зменшені межі `runtime.run` | архітекторка | §13 — вносить B1b-3 |
| Р2 | Перевірка `deleteIds` — типова в `runtime.run`; `createDataHandler` кличе `run` з `{ fullTabularArrays: true }` (фасад шле повні масиви з `expectedVersion` = `ownerVersion`) | архітекторка | §13 — вносить B1b-3 |
| Р3 | `object` на кожній помилці з `path` чи `attributes`; у пакеті — об'єкт операції, що відмовила (В10 B1b-1) | архітекторка | §6.10 П4 через Додаток А — тут |
| Р4 | `server/decode.ts` — на `decodeRow` T0 (В11 B1b-1) | архітекторка | §4.4 — внесено |
| Р5 | `version` і `serverHash` обробник бере з каталогу рантайму: `CommandRuntime` отримує `readonly catalog: RuntimeCatalog` | автор | немає |

## Review Focus

1. **Порядок кроків обробника** — походження → конверт → `subject` → звірка
   → переклад → порт: жодна відмова кроків 0–3 не доходить до порту (тест
   порту-фейку з лічильником викликів).
2. **Вороже фізичне ім'я** (поза каталогом, з лапками, крапкою, `;`,
   системна колонка `ctid`) — `command.stale-client`, порт не викликано.
3. **Бюджет відповіді** — сторінка понад бюджет дає найдовший непорожній
   префікс з `more: true`; читання за ключами, картка й «ТЧ власника» —
   `response-too-large` без обрізання; `run` — без `rows`.
4. **`inProcess`** не відкриває `run`: лише `read` і `version`.
5. **Помилка без тексту** — будь-який виняток, крім `CommandFailure`, —
   `command.internal` без повідомлення назовні й запис у журнал.

---

### Задача 1: сталі меж, коди й межі схем T0

**Files:** `packages/simetra/src/model/runtime/{errors,operation,limits}.ts`
(`limits.ts` — новий), `index.ts`; тести `model/runtime/__tests__/`.

**Interfaces:**
- `limits.ts`: `PAYLOAD_MAX_BYTES = 4 * 1024 * 1024`,
  `RESPONSE_BUDGET_BYTES = 4 * 1024 * 1024`, `jsonBytes(value: unknown): number`
  (UTF-8 байти `JSON.stringify` з серіалізацією `bigint` текстом — та сама
  функція міряє тіло у фасаді й відповідь в обробнику).
- `errors.ts`: код `command.stale-client` у `COMMAND_ERROR_CODES`; сталі
  причин `batch-too-large`, `tabular-too-large`, `too-large`,
  `payload-too-large`, `response-too-large`, `session-changed`, `origin`
  (одне місце для рядків причин T0).
- `operation.ts`: `batchSchema` — `.max(BATCH_MAX)` з причиною
  `batch-too-large`; масив рядків ТЧ в операції — `.max(TABULAR_LINES_MAX)` з
  причиною `tabular-too-large` і `path` ТЧ. Механізм причини — той, яким T3
  уже переводить відмову схеми входу в `command.invalid` (виконавець
  знаходить його в `server/phase.ts`; якщо причини з Zod-відмови не
  переносяться — повідомлення автору плану, а не новий механізм).

- [ ] Step 1: тести `it.each`: пакет `BATCH_MAX` — проходить, `BATCH_MAX + 1`
  — `batch-too-large`; ТЧ `TABULAR_LINES_MAX + 1` рядків —
  `tabular-too-large` з `path` ТЧ; `jsonBytes` — кирилиця й емодзі в байтах
  UTF-8, `bigint` текстом. Step 2: червоні. Step 3: реалізація. Step 4:
  `pnpm --filter simetra test`. Step 5: коміт
  `feat(model): сталі меж, код stale-client і межі схем пакета й ТЧ`.

### Задача 2: `maxBytes` атрибута — метадані, каталог, валідація

**Files:** `model/schemas/attribute.ts`, `tabular-section.ts`, `rules.ts`;
`packages/simetra/schemas/*.schema.json` (`pnpm --filter simetra schemas:update`);
`compiler/entity-fields.ts`, `runtime-catalog.ts`, `client-catalog.ts`;
`model/runtime/catalog.ts` (`catalogEntryAttributeSchema.maxBytes?`),
`model/runtime/values.ts` (`scalar`); `test/field-ratchet.test.ts`;
скіл `packages/designer/skills/simetra-metadata/SKILL.md`. Шаблон — поле
`load` B1a (`git show c99068f1 --stat`).

**Interfaces:**
- метадані: `maxBytes?: z.int().positive()` для `Text`, `Json`, `Bytes` у
  шапці й ТЧ; інший тип — помилка схеми; типові значення — рішення П1
  нижче;
- каталог: `maxBytes` (ефективне значення) у спільній частині запису;
- валідація: `scalar` у `values.ts` — значення понад `maxBytes` (байти
  UTF-8 тексту, `jsonBytes` для `Json`, байти даних для `Bytes` `\x…`) —
  `command.invalid` `reason: "too-large"` з `path`.

- [ ] Step 1: тести — схема (`maxBytes` на `Text`/`Json`/`Bytes` — так, на
  `Integer` — відмова); каталог несе ефективне значення; `encodeItemValue`
  межа й межа + 1 байт для кожного типу; кирилиця рахується байтами.
  Step 2–4: червоні → реалізація → `pnpm --filter simetra test`,
  `schemas:update`, `format:check`. Step 5: коміт
  `feat(model): maxBytes атрибута й відмова too-large`.

### Задача 3: правила бюджету відповіді в компіляторі

**Files:** `compiler/stages/model.ts` (чи модуль правил атрибутів, де B1a
поставив `rights.carrier-lazy`), `diagnostics.ts`, `messages.ts`; тести
`compiler/__tests__/`.

**Interfaces:**
- `rowBytesOf(entry)`: оцінка верхньої межі рядка — сума `maxBytes`
  (ефективних) звичайних колонок плюс стала оцінка фіксованих типів (UUID,
  числа, дата) і `4 × maxLength` для `String`; рядок ТЧ — так само;
- помилка `attribute.row-over-budget` — рядок списочної форми чи рядок ТЧ
  може перевищити `RESPONSE_BUDGET_BYTES`; попередження
  `attribute.lazy-over-budget` — сума лінивих `maxBytes` понад бюджет
  картки.

- [ ] Step 1: тести — модель на межі (без діагностики), понад межу (помилка
  з кодом і вказівником на об'єкт), ліниві понад межу (попередження);
  каталог повідомлень (`messages.test.ts`). Step 2–4. Step 5: коміт
  `feat(compiler): помилка й попередження бюджету рядка`.

### Задача 4: зменшені межі в `runtime.run`

**Files:** `server/runtime.ts` (опції), `server/transaction.ts` /
`phase.ts` (вхід і `ctx.run`), `server/hook-context.ts`; тести
`server/__tests__/runtime.test.ts`, `hooks.test.ts`.

**Interfaces:** `CommandRuntimeOptions.maxBatch?: number` (1…`BATCH_MAX`),
`maxTabularLines?: number` (1…`TABULAR_LINES_MAX`); `runtime.run` перевіряє
їх на кожному вході — верхній виклик (конверт, MCP, код host-а) і кожна фаза
`ctx.run` — до бази: `batch-too-large`, `tabular-too-large` з `path`.
Значення поза діапазоном — помилка створення рантайму.

- [ ] Step 1: тести порт-фейку: зменшена межа пакета й ТЧ відхиляє на
  верхньому вході й у `ctx.run`; порт не викликано; опція понад сталу —
  відмова створення. Step 2–5; коміт
  `feat(server): зменшені межі пакета й ТЧ у runtime.run`.

### Задача 5: `object` на кожній помилці з `path` чи `attributes`

**Files:** `server/errors.ts`, `phase.ts`, `values.ts`, `read.ts`,
`read-filter.ts`, `hook-context.ts`; тести `server/__tests__/`.

**Interfaces:** кожен конструктор `CommandError` з `path` чи `attributes`
отримує `object: MetadataRef` об'єкта, над яким відмова: вхід операції —
`found.object` (`phase.ts`); помилка бази — об'єкт `ErrorPhase`; читання —
об'єкт запиту; `ctx.reject` — об'єкт фази хука. У пакеті — об'єкт тієї
операції, що відмовила.

- [ ] Step 1: таблиця `it.each` джерел помилок (`invalidOf`, `23502`,
  `23505`, `23514`, `22023`, відмова входу, відмова читання, фільтр,
  `ctx.reject`, друга операція пакета) — кожна несе `object`; інваріантний
  тест: жодна помилка з `path`/`attributes` у тестах `server/__tests__` без
  `object` (спільна перевірка в `harness.ts`). Step 2–5; коміт
  `feat(server): object на кожній помилці з path чи attributes`.

### Задача 6: декодер T3 на `decodeRow` T0

**Files:** `server/decode.ts`, його викликачі (`phase.ts`, `read.ts`);
тести `decode.test.ts`, `values.test.ts`, designer DB-тести, що порівнюють
`DateTime`.

**Interfaces:** `server/decode.ts` лишає лише адаптер рядка бази до форми
передачі: версія й номер рядка ТЧ, які jsonb дає числом, — у рядок цілого;
далі `decodeRow` T0. Помилка `WireDecodeError` — `command.internal` (рядок
бази не відповідає каталогу — дефект). `DateTime` у `runtime.read` і
результаті `run` стає фіксованої ширини (§4.4).

- [ ] Step 1: наявні тести `decode.test.ts` переводяться на очікування T0
  (`DateTime` фіксованої ширини); кейс: номер рядка ТЧ числом з бази —
  `number`. Step 2–4: `pnpm --filter simetra test`,
  `pnpm --filter @simetrajs/designer test` (unit); DB-тести designer —
  scoped прогоном тих, що порівнюють `DateTime`. Step 5: коміт
  `refactor(server): декодер рядків бази — decodeRow T0`.

### Задача 7: схеми конверта й порт `DataTransport`

**Files:** `model/runtime/envelope.ts`, `ports.ts`; тести
`envelope.test.ts`, `ports.test.ts`.

**Interfaces:** `dataRequestSchema` — `{ subject, request }`, `request` —
`{ type: "read", query: wireReadQuerySchema }` |
`{ type: "run", operation | batch (wireOperationSchema), kernels?: Record<UUID, kernelHash> }`
| `{ type: "version" }` (`rights` — B5); `dataResponseSchema` —
`{ ok: true, value, serverHash } | { ok: false, error: wireCommandErrorSchema, serverHash }`;
`wireReadResultSchema` отримує `more?: true` (лише сторінки);
`type DataTransport = (request: DataRequest) => Promise<DataResponse>`;
`versionValueSchema` — `{ snapshotHash, objects: Record<UUID, kernelHash> }`.

- [ ] Step 1: таблиця схем: `kernels` необов'язкові; `type: "rights"` —
  відмова (ще не існує); `more` лише на формі сторінки. Step 2–5; коміт
  `feat(model): схеми конверта й порт DataTransport`.

### Задача 8: `checkRequestOrigin`

**Files:** `server/origin.ts` (новий); тест `server/__tests__/origin.test.ts`.

**Interfaces:** `type RequestOrigin = { secFetchSite?: string; origin?: string; expectedOrigin: string } | { inProcess: true }`;
`checkRequestOrigin(origin: RequestOrigin, type: DataRequest["request"]["type"]): CommandError | undefined`
— fail-closed (§4.5): `Sec-Fetch-Site` є і ≠ `same-origin` — відмова; інакше
`Origin` є і ≠ `expectedOrigin` — відмова; обох немає — відмова;
`inProcess` — лише `read` і `version`. Відмова — `command.forbidden`
`reason: "origin"`.

- [ ] Step 1: `it.each` усіх гілок §12 і `inProcess` + `run` — відмова.
  Step 2–5; коміт `feat(server): checkRequestOrigin`.

### Задача 9: звірка сумісності

**Files:** `server/compatibility.ts` (новий); тест
`server/__tests__/compatibility.test.ts`.

**Interfaces:**
`checkCompatibility(catalog: RuntimeCatalog, request: DataRequest["request"]): CommandError | undefined`
(§10): невідомий UUID об'єкта; для `run` — відсутній чи інший `kernelHash`
об'єкта будь-якої операції; колонка операції (шапки, рядків ТЧ,
`creatorMember` — проти запису довідника `creatorMembership`) поза
`objectColumns` дії; невідомий id ТЧ; для `read` — колонка фільтра,
сортування, `include`, ТЧ поза `read ∪ lazy`. Відмова —
`command.stale-client` з `object` (UUID); пакет з однією несумісною
операцією — відмова цілком. Фільтр `in` за ключем і версією проходить.

- [ ] Step 1: `it.each` кожної гілки §12 (зокрема ворожі імена й системна
  колонка); прохід сумісного запиту; пакет. Step 2–5; коміт
  `feat(server): звірка сумісності запиту з каталогом сервера`.

### Задача 10: `createDataHandler`

**Files:** `server/data-handler.ts` (новий), `server/runtime.ts`
(`CommandRuntime.catalog`), `server/index.ts`; тест
`server/__tests__/data-handler.test.ts`.

**Interfaces:**
`createDataHandler(runtime: CommandRuntime): (session: SessionClaims, request: unknown, origin: RequestOrigin) => Promise<DataResponse>`
— кроки §4.5: 0 `checkRequestOrigin`; 1 `dataRequestSchema`
(`command.invalid`); 2 `subject` ≠ `session.sub` —
`command.unauthenticated` `session-changed`; 3 `checkCompatibility`; 4
`*FromWire` мапінгу (`unknown` після звірки — `command.internal` і журнал:
дефект); 5 `runtime.read` / `runtime.run(…, { fullTabularArrays: true })` /
`version`; 6 кодування й бюджет: сторінка — найдовший непорожній префікс з
`more: true`, перший рядок понад бюджет — `response-too-large`; читання за
ключами, картка, «ТЧ власника» — `response-too-large`; `run` — рядки без
лінивих колонок і без рядків ТЧ, понад бюджет — без `rows`. `CommandFailure`
— `{ ok: false, error: errorToWire(…) }`; інший виняток — `command.internal`
без тексту й `runtime` log. Кожна відповідь — `serverHash` =
`runtime.catalog.snapshotHash`. Обробник безстановий.

- [ ] Step 1: тести порт-фейку: порядок кроків (лічильник викликів порту);
  `session-changed` до звірки; `BATCH_MAX` у конверті; `inProcess` + `run`;
  `version`; бюджет (порт-фейк з великими рядками); помилка як значення з
  фізичними полями; `command.internal` без тексту; виклик без
  `origin` не компілюється (`@ts-expect-error`) і в рантаймі —
  `command.forbidden`. Step 2–5; коміт `feat(server): createDataHandler`.

### Задача 11: перейменування й розширення через обробник

**Files:** тест `server/__tests__/data-handler-evolution.test.ts`
(порт-фейк); DB-тест
`packages/designer/src/__tests__/data-handler.db.test.ts` (новий, один кейс).

- [ ] Step 1: unit (порт-фейк, клієнт — каталог A, сервер — A′ з
  `evolvedCatalogs()` B1b-1): `read`, `include`, ТЧ картки, `run`,
  `command.constraint` з `attributes` і `changes` декодуються в імена A без
  `stale-client`; запит з видаленим реквізитом чи прибраною ТЧ —
  `stale-client`; запис без нього проходить.
- [ ] Step 2: DB (причина рівня — збереження значення нової колонки ядром,
  `sectionLines`, видно лише на базі): стара вкладка повністю замінює рядки
  ТЧ через обробник, нова колонка рядків зберігає значення.
- [ ] Step 3: коміт `test(server): обробник між каталогами після перейменування й розширення`.

### Задача 12: документація, гейти, PR

- [ ] Додаток А з блоком B1b-2 — у спеку П4 (§6.4, §6.10 — `stale-client`,
  `session-changed`, `origin`, `object` на помилках, Рт11, Рт19) і
  платформну (§7, §9); ROADMAP; скіл споживача — `maxBytes`, межі пакета й
  ТЧ у `data-write`. `check-doc-anchors.py` — чисто.
- [ ] Гейти: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
  `pnpm metadata:check`, один повний `pnpm test:db`. PR у `main`; звіт
  архітекторці.

---

## Відкриті питання до архітекторки

1. **П1. Типові `maxBytes`.** Спека дає орієнтир «1 МБ для `Json` і
   `RichText`», а `RichText` як типу немає (`LOGICAL_TYPES`). Пропоную: типове
   1 МБ для `Json`, `Text` і `Bytes`; з таким типовим довідник з чотирма
   звичайними `Text` дає помилку бюджету рядка (задача 3) — тому `Text` без
   явного `maxBytes` у правилі бюджету рахується за типовим, а помилка
   підказує або `maxBytes`, або `load: "lazy"`. Альтернатива — типове лише для
   `Json` і `Bytes`, а `Text` без `maxBytes` у бюджеті не рахується (тоді
   помилка компілятора нічого не гарантує для `Text`). Вплив на спеку:
   Рд26 і рядок П2 Додатку А.
2. **П2. Міра бюджету** — UTF-8 байти `JSON.stringify` значення відповіді
   (`jsonBytes`), без обгортки Server Function. Вплив: §4.5 — одне речення.

## Підсумок аудиту плану

(заповнюється після аудиту)
