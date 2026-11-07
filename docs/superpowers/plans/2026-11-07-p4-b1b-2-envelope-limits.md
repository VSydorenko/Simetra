# П4-B1b-2 — конверт, звірка й межі: план реалізації

> **Статус:** прийнято архітекторкою П4-B 2026-11-07. Виконання — після
> мерджу B1b-1 і B1b-3 в `main`: rebase на `main` і `orient --plan` перед
> стартом. Підсумок аудиту — наприкінці файла.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** T3 дає `createDataHandler(runtime)` — обробник конверта даних
(`read`, `run`, `version`) з перевіркою походження, звіркою сесії й
сумісності, мапінгом форми передачі й бюджетом відповіді; T0 дає схеми
конверта, порт `DataTransport`, сталі меж і код `command.stale-client`;
метадані — `maxBytes` атрибута з валідацією входу й правилами бюджету
компілятора; `runtime.run` перевіряє зменшені межі; кожна помилка з `path`
чи `attributes` несе `object`; декодер T3 переходить на `decodeRow` T0.

**Architecture:** обробник — тонкий шар T3 над `runtime.read` і
`runtime.run`: кроки 0–6 §4.5 спеки в тому самому порядку, усі відмови —
значення `{ ok: false, error }`. Звірка сумісності, підгонка відповіді під
бюджет і перевірка походження — окремі чисті функції T3 з власними тестами;
переклад форми — мапінг T0 (B1b-1). Межу тіла запиту тримають host (П4-D) і
фасад (B3): B1b-2 дає лише сталу й код.

**Tech Stack:** TypeScript 7 (native `tsc`), Zod 4, Vitest; один DB-кейс
через designer (`*.db.test.ts`).

**Spec:** [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) — §2
(Рд4, Рд12, Рд13, Рд17, Рд26, Рд27), §4.0, §4.1 (читання за ключами), §4.4,
§4.5, §7.1 (межі), §7.3, §10, §11, §12 (кейси B1b-2: unit T0, unit T1, unit
T3, unit T3 + мапінг), §13 (рядок B1b-2), §14.3 (рядки B1b-2), Додаток А
(рядки з B1b-2). [Спека П4](../specs/2026-10-26-p4-runtime-design.md) §6.4,
§6.10, Рт11, Рт19. План B1b-1 —
`docs/superpowers/plans/2026-11-07-p4-b1b-1-client-catalog-wire.md`; план
B1b-3 — у `main` після його мерджу.

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
- Тимчасову правку відкочувати лише її фрагментом: `git checkout -- <файл>`
  скидає всю незакомічену роботу файла. `git stash` не використовувати.
- Робоча копія — власний worktree від `main`; основний checkout не чіпати.

## Якорі «після B1b-1» і «після B1b-3»

Перед стартом: rebase на `main`, `orient --plan` цього файла, звірка
кожного якоря.

- B1b-1: `catalogEntrySchema`, `kernelHash`, `creatorMembership`
  (`model/runtime/catalog.ts`), `objectColumns` (`columns.ts`),
  `clientCatalogSchema`, `wire.ts` (`encodeRow`, `decodeRow`,
  `decodeValues`, `WireDecodeError`), `mapping.ts` (`catalogIndex`,
  `Mapped`, `operationFromWire`, `readQueryFromWire`, `readResultToWire`,
  `errorToWire`, `changesToWire`), `envelope.ts` (`wireOperationSchema`,
  `wireCommandErrorSchema`, `wireChangeSchema`, `wireReadQuerySchema`,
  `wireReadResultSchema` без `more`), `path.ts`, `evolvedCatalogs()`.
- B1b-3: `BATCH_MAX` (`model/runtime/operation.ts`), опція виклику
  `{ fullTabularArrays: true }` `runtime.run` (Ф3 плану B1b-3), межа фаз
  `ctx.run` проти `BATCH_MAX` (Ф1), опції бюджету часу
  `CommandRuntimeOptions`, коди `command.busy`/`command.timeout`.
  `TABULAR_LINES_MAX` — у `model/runtime/read.ts` (B1a).

## Рішення

| № | Рішення | Хто | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | `BATCH_MAX` вводить B1b-3; B1b-2 обмежує ним схему пакета й конверта (`batch-too-large`) і додає зменшені межі `runtime.run` | архітекторка | §13 — вносить B1b-3 |
| Р2 | Перевірка `deleteIds` — типова в `runtime.run`; `createDataHandler` кличе `run` з `{ fullTabularArrays: true }`; форма передачі `deleteIds` не несе | архітекторка | §13 — вносить B1b-3 |
| Р3 | `object` на кожній помилці з `path` чи `attributes`; у пакеті — об'єкт операції, що відмовила (В10 B1b-1) | архітекторка | §6.10 П4 — рядок Додатку А додає задача 13 |
| Р4 | `server/decode.ts` — на `decodeRow` T0 (В11 B1b-1); сервер лишається суворим (опція `strict`) | архітекторка + автор | §4.4 — внесено |
| Р5 | `version` і `serverHash` — з каталогу рантайму: `CommandRuntime.catalog` (заморожений) | автор | немає |
| Р6 | Причина відмови схеми переноситься в `CommandError.reason`: перевірки меж — custom issue з `params: { reason }`; `issueReason(error)` поруч з `issuePath` (`server/read.ts`) | автор | немає |
| Р7 | `maxBytes` і бюджет — одна міра: `jsonBytes` (UTF-8 байти `JSON.stringify`) закодованого значення форми передачі; `maxBytes` перевіряється лише на вході команди, читання ним не відмовляє | автор | Рд26, рядок П2 Додатку А — задача 13 |
| П1 | Типові `maxBytes`: `Json` і `Bytes` — 1 МіБ, `Text` і масиви — 64 КіБ, більше — явним `maxBytes`; майбутній `RichText` — 1 МіБ тим самим правилом, що `Json` (стандартним `Text` межі не задати — дельта «Ролей») | архітекторка | Рд26, рядок П2 Додатку А — задача 13 |
| П2 | Міра бюджету й `maxBytes` — UTF-8 байти `JSON.stringify` усієї відповіді (`jsonBytes`) | архітекторка | §4.5, Рд26 — задача 13 |
| П4 | Ключ запису в `path` — лише `keyName`: T3 не видає структурного сегмента `id` (`rootInput` у `phase.ts`, Zod-шлях картки `{ object, id }` у `read.ts`); інакше `id` і колонка ключа `id` на дроті нерозрізненні (рев'ю B1b-1) | архітекторка | §4.0 — внесено в B1b-1 |
| П3 | Одна форма рядка для читання й запису: ТЧ рядка `run` — у `tabularSections`; без шимів — `CommandResult.rows`, результат `ctx.run`, MCP `data-command`, скіл і тести-споживачі змінюються в цьому блоці | архітекторка | §4.4, спека П4 §6.4 через Додаток А — задача 13 |
| Р8 | «Сторінка» для бюджету — форма списку чи сторінки ТЧ (`limit`), фільтр якої ніде в дереві не має умови `eq` чи `in` за ключем (fail-closed: такий запит — читання за ключами й не обрізається) | автор (за §4.1) | §4.1 — одне речення (задача 13): `orderBy` для сторінки необов'язковий — без нього будівник сортує за ключем |

## Review Focus

1. **Порядок кроків обробника** — походження → конверт → сесія → звірка →
   переклад → порт: жодна відмова кроків 0–3 не доходить до порту (тест
   порту-фейку з лічильником викликів); відмова походження на невалідному
   конверті — `command.forbidden`, не `command.invalid`.
2. **Вороже фізичне ім'я** (поза каталогом, з лапками, крапкою, `;`,
   системна колонка `ctid`) — `command.stale-client`, порт не викликано.
3. **Бюджет відповіді** — сторінка: найдовший непорожній префікс з
   `more: true` і `included` лише для лишених рядків; читання за ключами,
   картка й «ТЧ власника» — `response-too-large` без обрізання; `run` —
   без `rows`.
4. **`inProcess`** не відкриває `run`: лише `read` і `version`; тип запиту
   читається з сирого входу без винятку.
5. **Помилка без тексту** — будь-який виняток, крім `CommandFailure`, —
   `command.internal` без повідомлення назовні й запис у журнал.

---

### Задача 1: сталі меж, коди, причини й межі схем T0

**Files:** `packages/simetra/src/model/runtime/{errors,operation,limits}.ts`
(`limits.ts` — новий), `index.ts`; `packages/simetra/src/server/{read,phase}.ts`
(`issueReason`); тести `model/runtime/__tests__/`, `server/__tests__/`.

**Interfaces:**
- `limits.ts`: `PAYLOAD_MAX_BYTES = 4 * 1024 * 1024`,
  `RESPONSE_BUDGET_BYTES = 4 * 1024 * 1024`,
  `jsonBytes(value: unknown): number` — UTF-8 байти `JSON.stringify`
  (`bigint` — текстом); одна функція міряє тіло у фасаді (B3), відповідь в
  обробнику й `maxBytes`.
- `errors.ts`: код `command.stale-client` у `COMMAND_ERROR_CODES`; сталі
  причин `batch-too-large`, `tabular-too-large`, `too-large`,
  `payload-too-large`, `response-too-large`, `session-changed`, `origin`.
- `operation.ts`: перевірка довжини **до** розбору елементів (Zod 4 не
  виконує `.max` масиву, коли вже є issue елемента): пакет довший за
  `BATCH_MAX` — custom issue `params: { reason: "batch-too-large" }`;
  масив рядків ТЧ довший за `TABULAR_LINES_MAX` — custom issue
  `params: { reason: "tabular-too-large" }`. Механізм не змінює JSON Schema
  інструмента `data-command` (`designer/src/tools/data-tools.ts` бере
  `batchSchema`; тест дрейфу MCP) і не ламає `operationSchema.options`,
  з яких B1b-1 виводить `wireOperationSchema`; `issueReason` віддає перевагу
  issue з `reason`, навіть коли він не перший.
- T3: `issueReason(error: z.ZodError): string | undefined` у `server/read.ts`;
  `prepareInput` (`phase.ts`) і `prepareRead` (`read.ts`) ставлять `reason` у
  `command.invalid`. Шлях `tabular-too-large` нормується до `<ТЧ>` (без
  префікса `tabularSections.` і без індексу операції пакета), `object` — з
  `op.object` відхиленої операції; `batch-too-large` — без `path`.

- [ ] Step 1: тести: пакет `BATCH_MAX` валідних операцій — проходить,
  `BATCH_MAX + 1` — `batch-too-large`; `BATCH_MAX + 1` з хибною операцією —
  теж `batch-too-large`; ТЧ `TABULAR_LINES_MAX + 1` рядків —
  `tabular-too-large`, `path` = `<ТЧ>`, `object` операції (і в другій
  операції пакета); `jsonBytes` — кирилиця, емодзі, лапка й `\`, `bigint`.
- [ ] Step 2–4: червоні → реалізація → `pnpm --filter simetra test`.
- [ ] Step 5: коміт `feat(model): сталі меж, код stale-client і причини відмов схем`.

### Задача 2: `maxBytes` атрибута — метадані, каталог, валідація входу

**Files:** `model/schemas/attribute.ts`, `tabular-section.ts`, `rules.ts`;
`packages/simetra/schemas/*.schema.json` (`pnpm --filter simetra schemas:update`);
`compiler/entity-fields.ts`, `runtime-catalog.ts`, `client-catalog.ts`;
`model/runtime/catalog.ts` (`catalogEntryAttributeSchema.maxBytes?`),
`model/runtime/values.ts`; `test/field-ratchet.test.ts`; скіл
`packages/designer/skills/simetra-metadata/SKILL.md`. Шаблон — поле `load`
B1a (`git show c99068f1 --stat`).

**Interfaces:**
- метадані: `maxBytes?: z.int().positive()` для `Text`, `Json`, `Bytes` і
  для **будь-якого масиву** у шапці й ТЧ; інший тип — помилка схеми; масив
  без явного `maxBytes` отримує типове значення масиву (П1), тож вхід
  обмежує його так само, як `rowBytesOf` його рахує;
  типові значення — П1: `Json` і `Bytes` — 1 МіБ, `Text` і масиви — 64 КіБ;
- каталог: ефективне `maxBytes` у спільній частині запису;
- валідація лише на **вході команди**: `EncodeAttributesOptions.maxBytes:
  true` (ставлять `encodeItem`/`encodeMember` T3), `scalar` без опції — без
  перевірки, тож `encodeRow` (читання) збережене значення понад межу не
  відхиляє. Міра — `jsonBytes` закодованого значення форми передачі (для
  `Bytes` — рядок `\x…`); масив — увесь масив. Понад — `command.invalid`
  `reason: "too-large"` з `path`.

- [ ] Step 1: тести — схема (`Text`/`Json`/`Bytes` — так, `Integer` —
  відмова); каталог несе ефективне значення; вхід: межа й межа + 1 байт для
  кожного типу, кирилиця й лапки рахуються мірою `jsonBytes`, масив `Text`;
  `encodeRow` значення понад `maxBytes` — проходить.
- [ ] Step 2–4: червоні → реалізація → `pnpm --filter simetra test`,
  `schemas:update`, `pnpm format:check`.
- [ ] Step 5: коміт `feat(model): maxBytes атрибута й відмова too-large на вході`.

### Задача 3: правила бюджету рядка в компіляторі

**Files:** модуль правил атрибутів T1 (там, де B1a поставив
`rights.carrier-lazy`), `compiler/diagnostics.ts` (`WARNING_RULES`),
`compiler/messages.ts`; тести `compiler/__tests__/`.

**Interfaces:**
- `rowBytesOf(columns)` — верхня межа `jsonBytes` рядка форми передачі:
  для кожної колонки — `jsonBytes` імені колонки з `:` і `,` плюс верхня
  межа значення: ефективне `maxBytes` для `Text`/`Json`/`Bytes` і масивів,
  `6 × maxLength + 2` для `String` (екранування `\u00XX` — 6 байтів на
  кодову точку); явні сталі в коді для UUID, одноцільового `Ref`, колонки
  типу пари (найдовша мітка цілі), мітки перерахування (найдовша мітка),
  чисел, булевого, дати, `DateTime`, версії; `Numeric` з точністю —
  `precision + 3`, без точності — межа Postgres (131 072 + 16 383 + 2
  символи); `Raw` — правило не рахує й не обіцяє (копії носіїв — UUID, сталою
  UUID);
- помилка `attribute.row-over-budget` — звичайні колонки шапки чи колонки
  рядка ТЧ понад `RESPONSE_BUDGET_BYTES`; попередження
  `attribute.lazy-over-budget` (у `WARNING_RULES`) — сума лінивих понад
  бюджет картки.

- [ ] Step 1: тести — модель на межі (без діагностики), понад межу (помилка з
  кодом і вказівником на об'єкт), ліниві понад межу (попередження),
  еталонний домен (`examples/reference`) — без діагностик; каталог
  повідомлень (`messages.test.ts`).
- [ ] Step 2–4. Step 5: коміт `feat(compiler): помилка й попередження бюджету рядка`.

### Задача 4: зменшені межі в `runtime.run`

**Files:** `server/runtime.ts` (опції), `server/phase.ts` /
`transaction.ts` (вхід), `server/hook-context.ts` (межа фаз `ctx.run`);
тести `server/__tests__/runtime.test.ts`, `hooks.test.ts`.

**Interfaces:** `CommandRuntimeOptions.maxBatch?: number` (1…`BATCH_MAX`),
`maxTabularLines?: number` (1…`TABULAR_LINES_MAX`); значення поза діапазоном
— помилка створення рантайму. `runtime.run` перевіряє їх до бази: розмір
пакета верхнього виклику — `batch-too-large`; рядки ТЧ кожної операції —
верхнього виклику й кожної фази `ctx.run` — `tabular-too-large` з `path`
`<ТЧ>` і `object`. Межа фаз `ctx.run` лишається на сталій `BATCH_MAX`
(B1b-3, Ф1): §7.1 — «фази `ctx.run` у межу пакета не рахуються», тож
`maxBatch` хуків проведення не обмежує. Пакета в `ctx.run` не буває
(`runNested` приймає одну операцію), тож зменшений `maxBatch` діє лише на
верхній вхід; `maxTabularLines` — на кожну операцію, зокрема фази
`ctx.run`. `maxTabularLines` стелі читання ТЧ
(`TABULAR_LINES_MAX` будівника) не змінює.

- [ ] Step 1: тести порт-фейку: зменшені межі пакета й ТЧ відхиляють на
  верхньому вході; ТЧ — і у фазі `ctx.run`; зменшений `maxBatch` не
  обмежує ліку фаз `ctx.run`; порт не викликано; опція понад сталу — відмова створення.
- [ ] Step 2–5; коміт `feat(server): зменшені межі пакета й ТЧ у runtime.run`.

### Задача 5: `object` на кожній помилці з `path` чи `attributes`

**Files:** `server/errors.ts`, `phase.ts`, `values.ts`, `read.ts`,
`read-filter.ts`, `hook-context.ts`; тести `server/__tests__/` і спільна
перевірка в `harness.ts`.

**Interfaces:** кожен `CommandError` з `path` чи `attributes` отримує
`object: MetadataRef`:
- вхід операції — `found.object` (`phase.ts`);
- помилка бази `23502`/`23503`/`23505`/`23514` — об'єкт **знайденої
  таблиці** (`tableOf` шукає й поза фазою), не об'єкт `ErrorPhase`; на
  `COMMIT` (фази немає) — так само за таблицею;
- винятки з цього правила — шлях `creatorMember.*` (гілка `23502` членства
  мапить його за таблицею довідника членства) і `22023` (`invalidOf` таблиці
  не має, шлях — відносно фази): `object` — об'єкт фази (операції), бо
  `path.ts` мапить `creatorMember.` через `creatorMembership` запису
  власника;
- читання і фільтр — об'єкт запиту;
- `ctx.reject` — об'єкт фази хука;
- у пакеті — об'єкт операції, що відмовила;
- ключ запису в `path` — лише `keyName` (П4): `rootInput` (`phase.ts`,
  `invalid("id")`) і Zod-шлях картки `{ object, id }` (`read.ts`) дають
  `keyName` об'єкта; структурного сегмента `id` у шляху помилки немає.
  Таблиця взаємної однозначності `path` з B1b-1 (`path.test.ts`) отримує
  рядок `id` → `keyName`.
Винятки (немає об'єкта, до якого прив'язати): `path: "object"` невідомого
об'єкта (`prepareRead`, `targetOf`), корінь вводу і відмови схеми
`prepareInput`/`prepareRead` до розбору операції (`expectedVersion`,
`0.action`, …). Правило для них: `object` додається, коли сирий
`op.object` проходить `metadataRefSchema` і знаходиться в каталозі; інакше
`object` немає, а такий `path` складається лише зі структурних сегментів і
мапінгу не потребує. Спільна перевірка називає ці винятки. Для `tabular-too-large` зі
схеми (задача 1) `object` читається з сирого `op.object` у `try`, проходить
`metadataRefSchema` і пошук у каталозі; інакше — без `object`.

- [ ] Step 1: таблиця `it.each` джерел помилок, зокрема «таблиця іншого
  об'єкта» й «відкладене обмеження на `COMMIT`»; спільна перевірка в
  `harness.ts`: жодна помилка з `path`/`attributes` без `object`, крім
  названих винятків; кейси `creatorMember.<реквізит>` з `23502` і `22023` —
  `object` операції.
- [ ] Step 2–5; коміт `feat(server): object на кожній помилці з path чи attributes`.

### Задача 6: декодер T3 на `decodeRow` T0

**Files:** `model/runtime/wire.ts` (опція `strict`), `server/decode.ts`, його
викликачі (`phase.ts` — `decodeCoreRow` кореня, `read.ts`); тести
`decode.test.ts`, `values.test.ts`, `wire.test.ts`; designer DB-тести, що
порівнюють `DateTime`.

**Interfaces:**
- `decodeRow(entry, raw, options?: { strict?: boolean })`: `strict` —
  невідома мітка перерахування чи цілі пари — `WireDecodeError` (сервер:
  рядок бази не відповідає каталогу — дефект), без опції — відсутнє поле
  (клієнт, В9).
- `server/decode.ts` — лише адаптер рядка бази до форми передачі для обох
  джерел: рядок ядра (`to_jsonb` з `tabular[<table.name>]`; корінь — два
  рядки в одному JSON, `decodeCoreRow`) і рядок читання (колонки `row` і
  `tabular`, ключ — `table.name`): ключі ТЧ `table.name` → id ТЧ; версія й
  номер рядка ТЧ, які jsonb дає числом, — у рядок цілого; далі
  `decodeRow(…, { strict: true })`; `WireDecodeError` — `command.internal`.
- `DateTime` у `runtime.read` і результаті `run` стає фіксованої ширини
  (§4.4); `timestamptz` `infinity` і роки поза 1–9999 на сервері в
  режимі `strict` — `command.internal` (кейс у тесті й речення в §4.4,
  задача 13).
- **Форма рядків `run` змінюється** (П3): ТЧ рядка результату
  переходить з верхнього рівня (`out[section.name]`, `decodeRecord`) у
  `tabularSections` — як у рядку картки (`read.ts`). Зачеплені: значення
  `CommandResult.rows`, результат `ctx.run` у хуку, вихід MCP
  `data-command` (`packages/designer/src/tools/data-tools.ts`), тести
  `decode.test.ts`, `hooks.test.ts`, designer `command-runtime.db.test.ts` і
  сусідні, скіл споживача. Вплив на спеку — §4.4 і спека П4 §6.4 (через
  Додаток А, задача 13).
- Адаптер читання лишає перевірку `tabular-too-large` (`decodeSections`) до
  виклику `decodeRow`. Фізичний ключ `tabularSections` у `to_jsonb(t)` не
  трапляється: фізичні імена платформи — у `snake_case`.

- [ ] Step 1: наявні тести `decode.test.ts` — на очікування T0 (`DateTime`
  фіксованої ширини); кейси: номер рядка ТЧ числом; ТЧ рядка ядра й рядка
  читання; корінь; невідома мітка на сервері — `command.internal`.
- [ ] Step 2–4: `pnpm --filter simetra test`,
  `pnpm --filter @simetrajs/designer test`; designer DB-тести, що
  порівнюють `DateTime`, — scoped прогоном.
- [ ] Step 5: коміт `refactor(server): декодер рядків бази — decodeRow T0`.

### Задача 7: схеми конверта й порт `DataTransport`

**Files:** `model/runtime/envelope.ts`, `ports.ts`; тести
`envelope.test.ts`, `ports.test.ts`.

**Interfaces:**
- `dataRequestSchema` = `{ subject: string, request }`, `request`:
  `{ type: "read", query: wireReadQuerySchema }`
  | `{ type: "run", operation: wireOperationSchema }`
  | `{ type: "run", batch: wireOperationSchema[] (≤ BATCH_MAX, reason batch-too-large) }`
  (`kernels?: Record<UUID, kernelHash>` в обох формах `run`; рівно один з
  `operation`/`batch`)
  | `{ type: "version" }`; `rights` — B5. Масив рядків ТЧ форми передачі —
  ≤ `TABULAR_LINES_MAX` з `reason: "tabular-too-large"`, `path` `<id ТЧ>`,
  `object` — UUID операції. `deleteIds` форма передачі не несе: схема
  `update` передачі після rebase на B1b-3 — явний `omit({ deleteIds })` без
  успадкованого `superRefine` (у Zod 4 `.extend` об'єкта з refinement кидає).
  Відмову схеми конверта в `WireCommandError` перетворює обробник на кроці 1
  (задача 10): `reason` через `issueReason`, `path` — як дав Zod без
  префікса `request.`, `object` — UUID операції, якщо є.
- `dataResponseSchema` = `{ ok: true, value, serverHash } | { ok: false, error: wireCommandErrorSchema, serverHash }`.
- `wireReadResultSchema` (B1b-1) отримує `more?: true`; що `more` буває лише
  на сторінці, тримає обробник (задача 9), не схема.
- `versionValueSchema` = `{ snapshotHash, objects: Record<UUID, kernelHash> }`.
- `type DataTransport = (request: DataRequest) => Promise<DataResponse>`.

- [ ] Step 1: таблиця схем: `kernels` необов'язкові; `operation` і `batch`
  разом — відмова; `type: "rights"` — відмова; `deleteIds` — відмова;
  межі пакета й ТЧ з причинами.
- [ ] Step 2–5; коміт `feat(model): схеми конверта й порт DataTransport`.

### Задача 8: `checkRequestOrigin`

**Files:** `server/origin.ts` (новий); тест `server/__tests__/origin.test.ts`.

**Interfaces:**
`type RequestOrigin = { secFetchSite?: string; origin?: string; expectedOrigin: string } | { inProcess: true }`;
`checkRequestOrigin(origin: RequestOrigin, rawRequest: unknown): CommandError | undefined`:
- HTTP-гілка — без типу запиту, до розбору: `Sec-Fetch-Site` є і ≠
  `same-origin` — відмова; інакше `Origin` є і ≠ `expectedOrigin` — відмова;
  обох немає — відмова; `expectedOrigin` іншої форми, ніж
  `new URL(x).origin === x` (зокрема `"null"`), — відмова;
- `inProcess` — тип читається один раз у `try` з сирого входу
  (`rawRequest.request.type`): лише рядок `"read"` чи `"version"`, інакше чи
  на винятку (геттер, Proxy) — відмова;
- обробник після кроку 1 повторно звіряє розібраний тип з `inProcess`
  (fail-closed).
Відмова — `command.forbidden` `reason: "origin"`.

- [ ] Step 1: `it.each` усіх гілок §12; `inProcess` з `run`, з не-рядковим
  типом і з геттером, що кидає; хибний `expectedOrigin`.
- [ ] Step 2–5; коміт `feat(server): checkRequestOrigin`.

### Задача 9: звірка сумісності й підгонка відповіді під бюджет

**Files:** `server/compatibility.ts`, `server/response-budget.ts` (нові);
тести `server/__tests__/compatibility.test.ts`, `response-budget.test.ts`.

**Interfaces:**
- `checkCompatibility(catalog: RuntimeCatalog, request: DataRequest["request"]): CommandError | undefined`
  (§10): невідомий UUID об'єкта; для `run` — відсутній чи інший
  `kernelHash` об'єкта будь-якої операції; колонка операції (шапки, рядків
  ТЧ, `creatorMember` — проти запису довідника `creatorMembership`) поза
  `objectColumns` дії; невідомий id ТЧ; для `read` — колонка фільтра,
  сортування, `include`, ТЧ поза `read ∪ lazy`. Відмова —
  `command.stale-client` з `object` (UUID); пакет з однією несумісною
  операцією — відмова цілком. Фільтр `in` за ключем і за версією проходить.
- `fitResponse(index: CatalogIndex, query: WireReadQuery, result: WireReadResult): WireReadResult | CommandError`
  (каталог — щоб знайти колонки `include` і ключ цілі)
  (Р8): сторінка — найдовший непорожній префікс рядків, `included` — лише
  цілі, на які посилаються лишені рядки, `more: true`, коли щось
  відкинуто; перший рядок понад бюджет — `response-too-large`; читання за
  ключами, картка, «ТЧ власника» — `response-too-large` без обрізання.
  Міряється вся відповідь `DataResponse`, як її серіалізує обробник: база —
  `jsonBytes` відповіді без рядків і `included` (зокрема `serverHash`,
  `more`, `ownerVersion`), далі додається `jsonBytes` кожного рядка й
  кожного рядка `included` з комами й ключами — лінійно, кожен рядок раз,
  без повторного `stringify` усієї відповіді; тест — випадок, де межу
  перетинають саме неповторні поля.
- `fitRunResult(index, result)` — рядки `run` без лінивих колонок і рядків ТЧ;
  понад бюджет — результат без `rows`. `changes` бюджету не перевищують: їх
  не більше ніж `BATCH_MAX` фаз пакета плюс `BATCH_MAX` фаз `ctx.run`, кожна
  — сталий набір полів; JSDoc записує цей інваріант, тест — найбільший
  набір `changes` під бюджетом.

- [ ] Step 1: `it.each` кожної гілки звірки §12 (зокрема ворожі імена,
  системна колонка, `creatorMember`); `fitResponse` — сторінка з префіксом і
  `included`, перший рядок понад бюджет, читання за ключем, `in` за ключем,
  картка, «ТЧ власника»; `fitRunResult`.
- [ ] Step 2–5; коміт `feat(server): звірка сумісності й бюджет відповіді`.

### Задача 10: `createDataHandler`

**Files:** `server/data-handler.ts` (новий), `server/runtime.ts`
(`CommandRuntime.catalog`), `server/index.ts`; тест
`server/__tests__/data-handler.test.ts`.

**Interfaces:**
- `CommandRuntime.catalog: RuntimeCatalog` — той самий розібраний каталог,
  глибоко заморожений при створенні рантайму (власна копія після
  `runtimeCatalogSchema.parse`); рукописні фейки `CommandRuntime` у тестах
  отримують поле.
- `createDataHandler(runtime: CommandRuntime, options?: { log?: (error: unknown) => void }): (session: SessionClaims, request: unknown, origin: RequestOrigin) => Promise<DataResponse>`
  (типовий `log` — `console.error`), кроки §4.5:
  0. `checkRequestOrigin(origin, request)`;
  1. `dataRequestSchema` (`command.invalid` з `reason`); повторна звірка
     типу з `inProcess`;
  2. `sessionClaimsSchema` сесії (невалідна — `command.unauthenticated`);
     `subject` ≠ `session.sub` — `command.unauthenticated` `session-changed`;
  3. `checkCompatibility`;
  4. `*FromWire` мапінгу: `invalid` — `errorToWire(invalid)` з `object`;
     `unknown` після звірки — `command.internal` і `log` (дефект);
  5. `runtime.read` / `runtime.run(…, { fullTabularArrays: true })` /
     `version` з `runtime.catalog`;
  6. `fitResponse` / `fitRunResult`; `CommandFailure` —
     `{ ok: false, error: errorToWire(…) }` через сувору
     `wireCommandErrorSchema` (лише поля `CommandError`; `detail` T3
     заповнює лише значеннями з білого списку — `CONTEXT_DETAILS`; `reason`
     і `path` `ctx.reject` — тексти самого застосунку); інший виняток —
     `command.internal` без тексту й `log`.
  Кожна відповідь — `serverHash` = `runtime.catalog.snapshotHash`.
  Обробник безстановий.

- [ ] Step 1: тести порт-фейку: порядок кроків (лічильник викликів порту);
  відмова походження на невалідному конверті — `forbidden`;
  `session-changed` до звірки; невалідна сесія; `BATCH_MAX` у конверті;
  `inProcess` + `run`; `version`; фільтр за лінивим атрибутом —
  `command.invalid`, не `stale-client`; фази `ctx.run` не звіряються; помилка
  як значення з фізичними полями; `command.internal` без тексту й виклик
  `log`; виклик без `origin` не компілюється (`@ts-expect-error`), у
  рантаймі — `command.forbidden`; `runtime.catalog` заморожений.
- [ ] Step 2–5; коміт `feat(server): createDataHandler`.

### Задача 11: перейменування й розширення через обробник

**Files:** тест `server/__tests__/data-handler-evolution.test.ts`
(порт-фейк); DB-тест
`packages/designer/src/__tests__/data-handler.db.test.ts` (новий, один кейс).

- [ ] Step 1: unit (порт-фейк; клієнт — `buildClientCatalog(a)`, сервер —
  рантайм над `aPrime` з `evolvedCatalogs()` B1b-1): `read`, `include`, ТЧ
  картки, `run`, `command.constraint` з `attributes` і `changes`
  декодуються в імена A без `stale-client`; запит з видаленим реквізитом чи
  прибраною ТЧ — `stale-client`; запис без нього проходить.
- [ ] Step 2: DB (причина рівня — значення нової колонки береже `sectionLines`
  ядра, видно лише на базі): одна модель (A′), обробник отримує `update` з
  повним масивом рядків ТЧ у формі передачі без нової колонки рядків —
  значення нової колонки збережено.
- [ ] Step 3: коміт `test(server): обробник між каталогами після перейменування й розширення`.

### Задача 12: повторна перевірка правок третього раунду спеки

- [ ] Адверсарійна перевірка (окремий аудитор Opus) реалізації проти правок
  третього раунду аудиту редакції 2 спеки в частині B1b-2 (§14.3): бюджет
  відповіді й читання за ключами без обрізання. Результат — рядок у
  «Підсумку аудиту виконання» цього плану; знахідки — виправлення в тому
  самому блоці.

### Задача 13: документація, гейти, PR

- [ ] Додаток А: додати рядок «спека П4 §6.10 — `object` на кожній помилці з
  `path` чи `attributes`» (Р3); Рд26 і рядок П2 — `maxBytes` (Р7, рішення
  П1); внести рядки з блоком B1b-2 у спеку П4 (§6.4, §6.10 — `stale-client`,
  `session-changed`, `origin`, Рт11, Рт19) і платформну (§7, §9); ROADMAP;
  скіл споживача — `maxBytes` (зокрема як підняти межу довгого `Text`),
  межі пакета й ТЧ у `data-write`, форма рядка `run` з `tabularSections`.
  `check-doc-anchors.py` — чисто.
- [ ] Гейти: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
  `pnpm metadata:check`, один повний `pnpm test:db`. PR у `main`; звіт
  архітекторці.

---

## Підсумок аудиту плану

- **Раунд 1** (Opus, повний план): 0 blocker; 9 major, з них 1 безпековий
  (М7 — тип запиту на кроці 0 перевірки походження). Внесено: перенесення
  причини відмови схеми, нормування `path`, `object` за знайденою
  таблицею, `maxBytes` лише на вході й однією мірою з бюджетом, правило
  сторінки й `included`, перевірка походження без типу до розбору, повний
  адаптер декодера, рекомендація П1.
- **Раунд 2** (Opus, дифф): 0 blocker, 0 безпекових major; 4 major —
  форма рядків `run` (→ П3), `object` для `creatorMember.*` і `22023`, межа
  фаз `ctx.run` лишається на `BATCH_MAX`, межа масивів на вході; minor
  внесено. Перевірено: заморожування каталогу безпечне, еталонний домен
  без нових діагностик.
- **Codex** (gpt-6-sol, вбудований контекст): 0 blocker, 5 major. Внесено:
  бюджет міряє всю відповідь, інваріант розміру `changes`, правило `object`
  для відмов схеми, білий список полів помилки. Спростовано: «пакет у
  `ctx.run`» (`runNested` приймає одну операцію — уточнено текст);
  «типові `maxBytes` не визначені» — це питання П1, закривається рішенням
  архітекторки до старту.
