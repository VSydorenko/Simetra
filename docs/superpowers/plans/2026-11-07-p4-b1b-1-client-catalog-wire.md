# П4-B1b-1 — каталог клієнта, мапінг і форма передачі: план реалізації

> **Статус:** на прийманні архітекторкою П4-B. Виконання — після мерджу B1a в
> `main` і «так» архітекторки. Підсумок аудиту — наприкінці файла.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** T0 (`simetra/model`) дає спільну частину запису каталогу, функцію
переліків колонок, схему клієнтського каталогу, кодек `wire`, мапінг
«логічне ↔ фізичне», схеми помилки й набору змін передачі, порти
`SourceAdapter` і `SignalTransport`, формат каналу й схеми сигналу; T1
(`simetra/compiler`) заповнює UUID ТЧ, `signal` і `kernelHash` і проєктує
клієнтський каталог; designer пише `client-catalog.json`.

**Architecture:** обидва каталоги — рантайму (сервер) і клієнтський (T4) —
мають одну спільну частину запису об'єкта, оголошену схемою T0; запис
рантайму розширює її серверними полями (функції ядра, `pgType`,
`castType`, обмеження). Кожна функція T0 цього блоку (`objectColumns`,
`wire`, мапінг) типізована над спільною частиною, тож сервер мапить каталогом
рантайму, а T4 — клієнтським, тим самим кодом. Конверт, обробник і
`DataTransport` — B1b-2; бюджет часу й коди команди — B1b-3.

**Tech Stack:** TypeScript 7 (native `tsc`), Zod 4, Vitest.

**Spec:** [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) — §2
(Рд1, Рд3, Рд8, Рд12, Рд17, Рд25), §3, §4.0, §4.4, §5.1, §8.1, §8.3 (канали,
сигнальний об'єкт), §8.5, §10, §11, §12 (unit T0, unit T1 — кейси B1b-1), §13
(рядок B1b-1), §14.3 (рядок `kind`/`provider`), Додаток А (рядки з B1b-1).
Чинна форма каталогу — [спека П4](../specs/2026-10-26-p4-runtime-design.md)
§6.3, §6.4, §6.10. План B1a —
`docs/superpowers/plans/2026-11-06-p4-b1a-read-query.md` (на гілці B1a).

## Global Constraints

- Мова: коментарі в коді — українською й пояснюють «чому»; JSDoc
  експортованого API й повідомлення — англійською.
- T0 (`packages/simetra/src/model`) — лише `zod`, без Node API; імпорти лише
  вниз за ярусами (`packages/simetra/eslint.tier-zones.js`).
- Без `z.any()`; типи — `z.infer` схем T0; без реекспортів і шимів
  (принцип 5 `AGENTS.md`).
- Тести — за скілом `.agents/skills/writing-tests/SKILL.md`: unit, таблиці
  `it.each` для каталогів кейсів, будівники фікстур
  (`packages/simetra/src/compiler/__tests__/fixtures/`), без інлайн-метаданих.
  DB-тестів у блоці немає.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter`.
- Коміти — Conventional Commits, опис українською, без трейлерів; коміт після
  кожної задачі.
- Робоча копія — власний worktree від `main` після мерджу B1a; основний
  checkout не чіпати.

## Якорі «після B1a»

Ці файли змінює B1a; план описує їх стан після мерджу B1a. Перед стартом:
rebase на `main`, `orient --plan` цього файла, звірка кожного якоря нижче.

- `packages/simetra/src/model/runtime/catalog.ts` — `operations?`, `ref`,
  `load`, `parentConstraint`, `references` (B1a задачі 2–4).
- `packages/simetra/src/model/runtime/read.ts` — запит другої форми й форма
  результату (`{ rows, included? , more? }`, `{ rows, ownerVersion }`,
  `{ count, capped? }`; рядок картки з `tabularSections` за логічним ім'ям ТЧ,
  рішення В1 B1a).
- `packages/simetra/src/compiler/runtime-catalog.ts` — `ref`,
  `parentConstraint`, `load`.
- `packages/simetra/src/server/decode.ts` — `decodeLine`, `decodeCardRow`.

Якщо форма запиту чи результату B1a після мерджу відрізняється від описаної
тут, задача 8 бере форму з коду, а розбіжність — повідомлення архітекторці.

## Рішення архітекторки (2026-11-07)

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| В1 | B1b поділено на B1b-1, B1b-2, B1b-3 | §13, §12, §14.3, Додаток А — внесено (`057c4f65`) |
| В2 | Переліки колонок не зберігаються в записі: їх виводить чиста функція T0 `objectColumns(entry)` над спільною частиною; порядок — порядок атрибутів | §3, §10, §13, Додаток А §6.3 і платформна §3.3 — внесено (`d28b6a96`) |
| В3 | `DataTransport` — у B1b-2 разом із конвертом | §13 — внесено (`d28b6a96`) |
| В4 | ТЧ у формі передачі — скрізь UUID ТЧ: ключ `tabularSections` операції й рядка картки, перший сегмент фізичного `path`, поле ТЧ запиту читання; фізична таблиця ТЧ — лише в SQL і в розмові з PostgREST | §4.0, Додаток А §6.4 — внесено (`45f99cb7`) |
| В5 | `kernelHash` = sha256 канонічної форми `operations` запису (функції й контексти); запис лише для читання — хеш порожньої канонічної форми, визначений і стабільний | немає |
| В6 | `signal` = ключ — одна колонка `uuid` **і** серед меж `RESTRICTIVE` читання немає межі «Користувачів». Межі читання дає одна функція `access-units.ts`, яку бере й `buildAccessUnits` | немає (§8.3 — одне джерело) |
| В7 | `client-catalog.json` — проєкція запису рантайму без `operations`, `membership`, `constraints`, `pgType`, `castType`; `ref` — повністю, з `constraint` (B4 розрізняє embed ім'ям FK) | немає |

## Review Focus

1. **Вороже логічне чи фізичне ім'я** (`__proto__`, `constructor`, ім'я з
   крапкою чи лапкою) у значеннях операції, у рядку передачі чи в `path`:
   мапінг не пише в прототип і не впізнає ім'я, якого немає в каталозі.
   Тест — задача 7, крок 1; задача 6, крок 1.
2. **Невідомий UUID об'єкта чи ТЧ і невідома колонка** у формі передачі:
   мапінг повертає `{ ok: false, unknown }`, а не кидає й не пропускає; звірка
   B1b-2 зробить з цього `command.stale-client`. Тест — задача 7.
3. **`bigint` поза безпечним цілим і `Numeric` з масштабом** (`10.50`)
   туди й назад без втрат; `DateTime` змінної дробової частини — фіксованої
   ширини. Тест — задача 6.
4. **Перейменування об'єкта, реквізиту й ТЧ** не змінює форми передачі, а
   новий необов'язковий реквізит лише розширює переліки. Тест — задачі 4 і 9.
5. **Зайве поле сигналу** — відмова схеми відправки; невідомий `op` у
   прийнятому повідомленні не проходить сувору схему. Тест — задача 11.

---

## Карта файлів

| Файл | Що змінюється |
| --- | --- |
| `packages/simetra/src/model/runtime/catalog.ts` (після B1a) | спільна частина запису (`catalogObjectSchema`, `catalogSectionSchema`, `catalogAttributeSchema`) і розширення рантайму; `id` ТЧ, `signal`, `kernelHash` |
| `packages/simetra/src/model/runtime/columns.ts` (новий) | `objectColumns` |
| `packages/simetra/src/model/runtime/client-catalog.ts` (новий) | `clientCatalogSchema` |
| `packages/simetra/src/model/runtime/wire.ts` (новий) | `encodeRow`, `decodeRow`, `encodeValues`, `decodeValues` |
| `packages/simetra/src/model/runtime/mapping.ts` (новий) | `catalogIndex` і функції мапінгу |
| `packages/simetra/src/model/runtime/envelope.ts` (новий) | `wireCommandErrorSchema`, `wireChangeSchema`, `wireOperationSchema`, `wireReadQuerySchema`, `wireReadResultSchema` |
| `packages/simetra/src/model/runtime/ports.ts` (новий) | `SourceAdapter`, `SignalTransport` |
| `packages/simetra/src/model/runtime/signal.ts` (новий) | `channelTopic`, `parseTopic`, схеми сигналу |
| `packages/simetra/src/model/runtime/index.ts` | експорти нових модулів |
| `packages/simetra/src/compiler/access-units.ts` | `readBoundaries` |
| `packages/simetra/src/compiler/runtime-catalog.ts` (після B1a) | `id` ТЧ, `signal`, `kernelHash` |
| `packages/simetra/src/compiler/client-catalog.ts` (новий) | `buildClientCatalog` |
| `packages/simetra/src/compiler/index.ts` | експорт `buildClientCatalog`, `kernelHashOf` |
| `packages/designer/src/tools/artifacts.ts` | `client-catalog.json` |
| тести | `packages/simetra/src/model/runtime/__tests__/{catalog,columns,wire,mapping,envelope,signal}.test.ts` (нові, крім наявних); `packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts`, `access-units.test.ts`, `client-catalog.test.ts` (новий); `packages/designer/src/__tests__/compile.test.ts`, `catalog.test.ts` |
| `docs/superpowers/specs/*`, `docs/ROADMAP.md` | Додаток А з блоком B1b-1, ROADMAP |

---

### Задача 1: спільна частина запису каталогу й UUID ТЧ

**Files:**
- Modify: `packages/simetra/src/model/runtime/catalog.ts`
- Modify: `packages/simetra/src/compiler/runtime-catalog.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/catalog.test.ts` (новий),
  `packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts`

**Interfaces:**
- Produces (T0):
  - `catalogAttributeSchema` — поля реквізиту, спільні для обох каталогів:
    `name`, `column`, `type`, `array?`, `required`, `maxLength?`,
    `precision?`, `scale?`, `insert`, `update`, `generated?`,
    `enumValues?`, `pair?`, `ref?` (з `constraint`), `load?`.
    `runtimeAttributeSchema = catalogAttributeSchema.extend({ pgType, castType })`.
  - `catalogSectionSchema` — `id` (UUID ТЧ, `z.guid()`), `name`, `table`,
    `key`, `keyName`, `parent`, `parentName`, `lineNumber`,
    `lineNumberName`, `parentConstraint`, `attributes:
    catalogAttributeSchema[]`. `runtimeSectionSchema` розширює його
    `attributes: runtimeAttributeSchema[]` і `constraints`.
  - `catalogObjectSchema` — `id`, `name`, `kind`, `kindLabel`, `table`,
    `key`, `keyName`, `versionColumn`, `versionName`, `scopeKindId?`,
    `scopeColumn?`, `attributes`, `tabularSections`. `runtimeObjectSchema`
    розширює його `attributes`, `tabularSections`, `constraints`,
    `operations?`, `membership?`.
  - Типи `CatalogObject`, `CatalogSection`, `CatalogAttribute`.
- `RuntimeObject` структурно присвоюється `CatalogObject` (тест типу).

- [ ] **Step 1: тести.** У `catalog.test.ts`: `it.each` — запис рантайму
  з фікстури проходить `runtimeObjectSchema`; ТЧ без `id` чи з `id` не-UUID —
  відмова схеми; `expectTypeOf<RuntimeObject>().toExtend<CatalogObject>()`.
  У `runtime-catalog.test.ts`: `it("a tabular section carries its UUID")` —
  `id` кожної ТЧ запису дорівнює `origin.tabularSectionId` її фізичної
  таблиці в `model.physical`.
- [ ] **Step 2:** `pnpm --filter simetra test catalog` — червоні.
- [ ] **Step 3:** розділити схеми `catalog.ts` на спільну частину й
  розширення рантайму (поля й порядок — як вище); у `runtimeObject`
  (`runtime-catalog.ts`) дати ТЧ `id: section.table.origin.tabularSectionId`
  (через наявний `must`).
- [ ] **Step 4:** `pnpm --filter simetra test catalog` і
  `pnpm --filter simetra typecheck` — зелені.
- [ ] **Step 5: коміт** `feat(model): спільна частина запису каталогу й UUID ТЧ`.

### Задача 2: межі читання й ознака `signal`

**Files:**
- Modify: `packages/simetra/src/compiler/access-units.ts`
- Modify: `packages/simetra/src/model/runtime/catalog.ts`,
  `packages/simetra/src/compiler/runtime-catalog.ts`
- Test: `packages/simetra/src/compiler/__tests__/access-units.test.ts`,
  `runtime-catalog.test.ts`

**Interfaces:**
- Produces (T1, `access-units.ts`):
  `readBoundaries(contract: AccessContract, visibleUsers: boolean): readonly ReadBoundary[]`,
  `type ReadBoundary = "tenant" | "users"`: `"tenant"` — коли `contract.scope`
  є і `publicRead` порожній; `"users"` — коли `visibleUsers && contract.users`.
  `buildAccessUnits` додає політику `scopeRead` межі тенанта й політику межі
  «Користувачів» **лише** за цим результатом.
- Produces (T1, `runtime-catalog.ts`):
  `signalObject(keyIsSingleUuid: boolean, boundaries: readonly ReadBoundary[]): boolean`
  = `keyIsSingleUuid && boundaries.every((b) => b === "tenant")`.
- Produces (T0): `catalogObjectSchema.signal: z.boolean()`.

- [ ] **Step 1: тести.** `access-units.test.ts`: `it.each` над `readBoundaries`
  — скоуплена без `publicRead` → `["tenant"]`; скоуплена з `publicRead` → `[]`;
  нескоуплена → `[]`; «Користувачі» з видимими користувачами → `["users"]`,
  без них → `[]`. Наявні тести дерева SQL політик лишаються зеленими без змін
  (рефакторинг не змінює SQL). `runtime-catalog.test.ts`:
  `it.each` над `signalObject` — `(true, ["tenant"])` → `true`;
  `(true, [])` → `true`; `(false, [])` → `false` (ключ не з однієї колонки
  `uuid`); `(true, ["users"])` → `false` (межа «Користувачів»);
  `(true, ["tenant", "users"])` → `false`. Над моделлю фікстури:
  `Users` — `signal: false`, скоуплений довідник — `true`; корінь виду
  скоупу (`rootCreationDomain()`) — `true`.
- [ ] **Step 2:** `pnpm --filter simetra test access-units` і
  `pnpm --filter simetra test runtime-catalog` — нові кейси червоні.
- [ ] **Step 3:** винести `readBoundaries` і перевести `buildAccessUnits`
  на нього; у `runtimeObject` — `signal: signalObject(<ключ — одна колонка з
  pgType uuid>, readBoundaries(<контракт доступу основної таблиці з
  model.contracts.access>, hasVisibleUsers(model.contracts, <провайдер>)))`.
  Коментар «чому»: те саме рішення пише виклик сигналу в ядрі (B2), тож
  джерело одне (§8.3).
- [ ] **Step 4:** `pnpm --filter simetra test` — увесь unit-набір зелений
  (дерева SQL політик у `access-units.test.ts` і сусідніх не змінилися).
- [ ] **Step 5:** мутація: `signalObject` повертає `keyIsSingleUuid` —
  червоніє кейс `Users`; відкотити.
- [ ] **Step 6: коміт** `feat(compiler): межі читання одним джерелом і ознака signal запису каталогу`.

### Задача 3: `kernelHash`

**Files:**
- Modify: `packages/simetra/src/model/runtime/catalog.ts`,
  `packages/simetra/src/compiler/runtime-catalog.ts`,
  `packages/simetra/src/compiler/index.ts`
- Test: `packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts`

**Interfaces:**
- Produces (T1): `kernelHashOf(operations: RuntimeObject["operations"]): string`
  = `sha256HexSync(canonicalize(operations ?? {}))`
  (`compiler/sha256.ts`, `compiler/canonical.ts`).
- Produces (T0): `catalogObjectSchema.kernelHash: z.string().regex(/^[0-9a-f]{64}$/)`.

- [ ] **Step 1: тести** (`describe("kernelHash")`):
  - `kernelHash` кожного запису дорівнює `kernelHashOf(entry.operations)`;
  - запис без `operations` — `kernelHashOf(undefined)`, однаковий у двох
    компіляціях;
  - `it.each` варіантів фікстури, що **не** змінюють `kernelHash`
    довідника: перейменування об'єкта, реквізиту й ТЧ; новий необов'язковий
    реквізит шапки й ТЧ; зміна подання; зміна гранту прав; зміна іншого
    об'єкта; зміна `load`. Варіанти — перевизначенням шару фікстури,
    перейменування — через наявні помічники операцій перейменування;
  - `kernelHashOf` різних `operations` (інший `context` чи інша функція,
    відсутня дія) — різні хеші.
- [ ] **Step 2:** `pnpm --filter simetra test runtime-catalog` — червоні.
- [ ] **Step 3:** `kernelHashOf` у `runtime-catalog.ts`; поле в записі.
- [ ] **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(compiler): kernelHash запису каталогу`.

### Задача 4: `objectColumns`

**Files:**
- Create: `packages/simetra/src/model/runtime/columns.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/columns.test.ts`

**Interfaces:**
- Produces (T0):

```ts
interface ColumnLists {
  insert: readonly string[] // column (+ pair.typeColumn) реквізитів з insert
  update: readonly string[] // те саме з update
  read: readonly string[]   // звичайні: key, versionColumn, scopeColumn?, column і pair.typeColumn реквізитів без load: "lazy"
  lazy: readonly string[]   // column ліниві
}
interface ObjectColumns extends ColumnLists {
  tabularSections: ReadonlyMap<string /* UUID ТЧ */, ColumnLists> // read: key, parent, lineNumber + колонки реквізитів; lazy: []
}
function objectColumns(entry: CatalogObject): ObjectColumns
```

  Порядок — порядок полів запису (ключ, версія, скоуп, далі атрибути в
  порядку запису); функція читає лише спільну частину.

- [ ] **Step 1: тести** над записом, зібраним з каталогу фікстури
  (`buildRuntimeCatalog`): `toEqual` переліків довідника з парою, ліниві поля
  й ТЧ; `it.each` інваріантів: перейменування реквізиту (запис з іншими
  `name`, тими самими `column`) — переліки рівні; зміна `load` переносить
  колонку між `read` і `lazy`; новий необов'язковий реквізит — переліки
  лише розширені (старий — префікс без перестановки); ТЧ — `read`
  починається з `key`, `parent`, `lineNumber`; генерований реквізит без
  `insert`/`update` — лише в `read`.
- [ ] **Step 2:** `pnpm --filter simetra test columns` — червоні.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(model): objectColumns — переліки колонок зі спільної частини запису`.

### Задача 5: клієнтський каталог і `client-catalog.json`

**Files:**
- Create: `packages/simetra/src/model/runtime/client-catalog.ts`,
  `packages/simetra/src/compiler/client-catalog.ts`
- Modify: `packages/simetra/src/model/runtime/index.ts`,
  `packages/simetra/src/compiler/index.ts`,
  `packages/designer/src/tools/artifacts.ts`
- Test: `packages/simetra/src/compiler/__tests__/client-catalog.test.ts`
  (новий), `packages/designer/src/__tests__/compile.test.ts`,
  `packages/designer/src/__tests__/catalog.test.ts`

**Interfaces:**
- Produces (T0): `clientCatalogSchema = z.strictObject({ format: z.literal(1),
  snapshotHash, provider, objects: z.array(catalogObjectSchema) })`, тип
  `ClientCatalog`. Контракт прав для обчислювача — B6, не тут.
- Produces (T1): `buildClientCatalog(runtime: RuntimeCatalog): ClientCatalog`
  — явна проєкція кожного запису (поля спільної частини; реквізити й ТЧ без
  `pgType`, `castType`, `constraints`), порядок об'єктів — як у каталозі
  рантайму.
- designer: `compileArtifacts` додає
  `{ path: "client-catalog.json", content: JSON.stringify(buildClientCatalog(buildRuntimeCatalog(model)), null, 2) + "\n" }`
  після `runtime-catalog.json`.

- [ ] **Step 1: тести.** `client-catalog.test.ts`: результат проходить
  `clientCatalogSchema`; детермінований у двох компіляціях; у серіалізованому
  тексті немає ключів `operations`, `membership`, `constraints`, `pgType`,
  `castType` (обхід дерева JSON, не `toContain`); кожен запис несе
  `kindLabel`, `kernelHash`, `signal`, `ref` з `constraint`, `load`,
  `parentConstraint`, `id` ТЧ; `provider` і `snapshotHash` = каталогу
  рантайму; `objectColumns` проєкції = `objectColumns` запису рантайму для
  кожного об'єкта. designer: точні переліки файлів у `compile.test.ts`
  («--out writes …») і `catalog.test.ts` («compileArtifacts emits …»)
  доповнюються `client-catalog.json`; вміст — `buildClientCatalog` тієї самої
  моделі.
- [ ] **Step 2:** `pnpm --filter simetra test client-catalog`,
  `pnpm --filter @simetrajs/designer test compile catalog` — червоні.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(compiler): клієнтський каталог і client-catalog.json`.

### Задача 6: кодек `wire`

**Files:**
- Create: `packages/simetra/src/model/runtime/wire.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/wire.test.ts`

**Interfaces:**
- Produces (T0), усі над `CatalogObject` / `CatalogSection`:
  - `encodeValues(attributes: readonly CatalogAttribute[], values: Readonly<Record<string, unknown>>): Record<string, unknown>`
    — логічні імена → фізичні колонки (пара — дві колонки: `column` = id,
    `typeColumn` = мітка цілі; перерахування — мітка; `BigInt` — рядок).
  - `decodeValues(attributes, raw: Readonly<Record<string, unknown>>): Record<string, unknown>`
    — обернене за таблицею §4.4; фізичний ключ поза каталогом ігнорується,
    відсутній ключ — відсутнє поле.
  - `encodeRow(entry: CatalogObject, row: LogicalRow): WireRow` і
    `decodeRow(entry: CatalogObject, raw: WireRow): LogicalRow` — плюс ключ,
    версія (рядок цілого ↔ безпечне ціле `number`), скоуп; рядок картки —
    `tabularSections` за UUID ТЧ ↔ за логічним ім'ям ТЧ (рядки ТЧ —
    `key`, `parent`, `lineNumber` і реквізити ТЧ).
  - `DateTime` у `decodeValues` — ISO 8601 UTC фіксованої ширини з
    мікросекундами (`YYYY-MM-DDTHH:MM:SS.ffffffZ`) з будь-якого зсуву й
    довжини дробу; `Numeric` — рядок без змін; `Json` — значення; `Bytes` —
    рядок `\x…` без змін; невідома мітка перерахування чи пари — помилка
    `WireDecodeError` (клас T0) з фізичною колонкою.
  - `WireRow = Record<string, unknown>` (фізичні ключі) і
    `LogicalRow = Record<string, unknown>` (логічні імена) — так само, як
    `CommandResult.rows` у `result.ts`; рядок картки несе `tabularSections`
    (рішення В1 B1a).
  - Записи в об'єкти — лише через `Object.hasOwn` і `Object.create(null)`
    або `Object.fromEntries`: фізичний ключ `__proto__` не змінює прототипу.

- [ ] **Step 1: тести** `it.each` за логічним типом (`BigInt` понад 2^53,
  версія, `Numeric` `10.50`, `DateTime` з `+00:00` і 3/6/0 знаками дробу,
  `Date`, перерахування, пара, `Json` об'єкт і масив, `Bytes`, масив
  `BigInt`, `null`): `decodeRow(encodeRow(x))` = `x`; конкретна форма
  передачі кожного типу (`toEqual` на літерал); ключ поза каталогом
  ігнорується; відсутній ключ — немає поля; рядок картки з двома ТЧ;
  невідома мітка — `WireDecodeError`; рядок з ключем `__proto__` — прототип
  результату `Object.prototype` і поле не з'являється.
- [ ] **Step 2:** `pnpm --filter simetra test wire` — червоні.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(model): кодек wire — encodeRow і decodeRow`.

### Задача 7: мапінг операції, помилки й набору змін; схеми передачі

**Files:**
- Create: `packages/simetra/src/model/runtime/mapping.ts`,
  `packages/simetra/src/model/runtime/envelope.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/mapping.test.ts`,
  `envelope.test.ts`

**Interfaces:**
- Produces (T0, `envelope.ts`) — лише схеми форми передачі, без конверта
  (конверт — B1b-2):
  - `wireOperationSchema` — `operationSchema` з `object: z.guid()`,
    `values`/`creatorMember` — записи фізичних колонок,
    `tabularSections` — запис `UUID ТЧ → рядки фізичних колонок`;
    `expectedVersion` — як у логічній формі;
  - `wireCommandErrorSchema` — `CommandError` з `object?: z.guid()`,
    `path?` фізичним, `attributes?` фізичними колонками; решта полів — ті
    самі;
  - `wireChangeSchema` — елемент набору змін з `object: z.guid()`.
- Produces (T0, `mapping.ts`):
  - `catalogIndex(objects: readonly CatalogObject[]): CatalogIndex` —
    пошук за UUID і за `MetadataRef` (`Map`, не літерал об'єкта).
  - `type Mapped<T> = { ok: true; value: T } | { ok: false; unknown: { object?: string; section?: string; column?: string; name?: string } }`.
  - `operationToWire(index, op: Operation): Mapped<WireOperation>`,
    `operationFromWire(index, wire: WireOperation): Mapped<Operation>`.
  - `pathToWire(entry, path: string): Mapped<string>`,
    `pathFromWire(entry, path: string): Mapped<string>` —
    `<ТЧ>.<реквізит>` ↔ `<UUID ТЧ>.<колонка>`, `<реквізит>` ↔ `<колонка>`.
  - `errorToWire(index, error: CommandError): WireCommandError`,
    `errorFromWire(index, error: WireCommandError): CommandError` — поле, що
    не мапиться, лишається без поля (помилка не губиться через мапінг).
  - `changesToWire` / `changesFromWire` — над `object` (`Change` з
    `result.ts`; `scopeKind`, `scope`, `id`, `version`, `operation` — без
    змін).

- [ ] **Step 1: тести** (`it.each` над каталогом фікстури): кожна дія
  операції туди й назад; `creatorMember` кореня; масив ТЧ з двома рядками;
  `path` шапки й ТЧ; `errorToWire`/`errorFromWire` для
  `command.constraint` з `attributes` і `path` ТЧ; набір змін; невідомий
  UUID об'єкта, невідомий UUID ТЧ, невідома колонка, невідоме логічне ім'я —
  `{ ok: false, unknown }` з названим елементом; ворожі імена (`__proto__`,
  `constructor`, `a.b`, `"x`) — `unknown`, прототип не змінено;
  `wireOperationSchema` відхиляє `object`, що не UUID.
- [ ] **Step 2:** `pnpm --filter simetra test mapping envelope` — червоні.
- [ ] **Step 3:** реалізація над `wire.ts` (`encodeValues`/`decodeValues`).
- [ ] **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(model): мапінг операції, помилки й набору змін у форму передачі`.

### Задача 8: мапінг запиту й результату читання (після B1a)

**Files:**
- Modify: `packages/simetra/src/model/runtime/mapping.ts`,
  `packages/simetra/src/model/runtime/envelope.ts`
- Test: `mapping.test.ts`, `envelope.test.ts`

**Interfaces:**
- Produces (T0):
  - `wireReadQuerySchema` — `readQuerySchema` B1a з `object: z.guid()`,
    фізичними колонками у фільтрі, сортуванні й `include`, UUID ТЧ у
    `tabularSection`/`tabularSections`;
  - `wireReadResultSchema` — `{ rows: WireRow[], included?: { "<UUID об'єкта>": WireRow[] }, more? }`,
    `{ rows, ownerVersion }` чи `{ count, capped? }`;
  - `readQueryToWire(index, query: ReadQuery): Mapped<WireReadQuery>`,
    `readQueryFromWire(index, wire): Mapped<ReadQuery>`;
  - `readResultToWire(index, query: ReadQuery, result: ReadResult): WireReadResult`
    (сервер, `encodeRow`), `readResultFromWire(index, query, wire): ReadResult`
    (клієнт, `decodeRow`).
- Consumes: `ReadQuery`, `ReadResult`, `Filter` з `read.ts` B1a.

- [ ] **Step 1: тести:** `it.each` над кожною формою запиту B1a (список з
  фільтром `and`/`or`/`not` і кожним оператором, сортування, `include`,
  картка з ТЧ, «ТЧ власника», ТЧ як ціль списку, `count`): туди й назад;
  фільтр за невідомою колонкою — `unknown`; невідомий UUID ТЧ — `unknown`;
  результат: `included` за UUID ↔ за `"<kind>.<name>"`, `ownerVersion`,
  `more`, `count`.
- [ ] **Step 2:** червоні. **Step 3:** реалізація. **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(model): мапінг запиту й результату читання у форму передачі`.

### Задача 9: перейменування й розширення (каталоги A і A′)

**Files:**
- Test: `packages/simetra/src/model/runtime/__tests__/mapping-evolution.test.ts` (новий)
- Modify: будівник у `packages/simetra/src/compiler/__tests__/fixtures/` —
  пара каталогів `A` і `A′`, якщо такого ще немає (`evolvedCatalogs()`)

**Interfaces:**
- Consumes: усе з задач 6–8.
- Produces: `evolvedCatalogs(): Promise<{ a: RuntimeCatalog; aPrime: RuntimeCatalog }>`
  — `A′` = `A` з перейменованими об'єктом, реквізитом і ТЧ, новим
  необов'язковим реквізитом шапки й ТЧ і реквізитом, видаленим на фазі
  розширення (компіляція двох варіантів фікстури).

- [ ] **Step 1: тести** — клієнт мапить каталогом `A` (через
  `buildClientCatalog`), сервер — каталогом `A′`: запит читання з
  фільтром, `include`, карткою з ТЧ; операція `update` з повною заміною
  рядків ТЧ; помилка `command.constraint` з `attributes`; набір змін.
  Логічне `A` → передача → логічне `A′` дає ті самі колонки під новими
  іменами; результат `A′` → передача → логічне `A` — імена `A`, нова
  колонка відсутня в рядку `A`, а в повній заміні рядків ТЧ старою вкладкою
  нова колонка не називається (її значення зберігає сервер — доводить
  B1b-2); запит, що називає видалений реквізит, — `unknown` на боці `A′`
  (B1b-2 зробить з нього `stale-client`); перейменування ТЧ не змінює форми
  передачі; `objectColumns(A)` — підмножина `objectColumns(A′)` за
  колонками, крім видаленої.
- [ ] **Step 2:** червоні (будівник ще не існує). **Step 3:** будівник.
  **Step 4:** зелені.
- [ ] **Step 5: коміт** `test(model): мапінг між каталогами після перейменування й розширення`.

### Задача 10: порти `SourceAdapter` і `SignalTransport`

**Files:**
- Create: `packages/simetra/src/model/runtime/ports.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/ports.test.ts`

**Interfaces:**
- Produces (T0) — лише типи (§5.1, §8.5):

```ts
interface SourceAdapter {
  read(query: WireReadQuery): Promise<WireReadResult>
  capabilities: { include: boolean }
}
type SignalErrorKind = "auth" | "transport"
type Unsubscribe = () => void
interface SignalTransport {
  subscribe(channels: readonly string[], onSignal: (topic: string, payload: unknown) => void, onError: (kind: SignalErrorKind) => void): Unsubscribe
  onSubscribed(handler: () => void): Unsubscribe
}
```

- [ ] **Step 1: тест типів** (`expectTypeOf`): фейкова реалізація з
  тестового модуля задовольняє обидва порти; `read` повертає форму
  `wireReadResultSchema`.
- [ ] **Step 2–4:** червоний → реалізація → зелений
  (`pnpm --filter simetra test ports`, `pnpm --filter simetra typecheck`).
- [ ] **Step 5: коміт** `feat(model): порти SourceAdapter і SignalTransport`.

### Задача 11: формат каналу й схеми сигналу

**Files:**
- Create: `packages/simetra/src/model/runtime/signal.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/signal.test.ts`

**Interfaces:**
- Produces (T0, §8.1, §8.3):
  - `type Channel = { kind: "changes"; scopeKindId: string; scope: string; object: string } | { kind: "rights"; scopeKindId: string; scope: string } | { kind: "user"; userId: string }`;
  - `channelTopic(channel: Channel): string` — `simetra:<вид>:<скоуп>:<об'єкт>`,
    `simetra-rights:<вид>:<скоуп>`, `simetra-user:<id>`; нескоуплений —
    `ZERO_UUID`;
  - `parseTopic(topic: string): Channel | undefined` — суворий: рівно та
    кількість сегментів, кожен — UUID у нижньому регістрі; інше —
    `undefined`;
  - `changeSignalSchema` (рівно `object`, `op` ∈ create/update/markDeletion/delete,
    `keys` — `Record<колонка, UUID>`, `row_ver` — безпечне ціле),
    `invalidateSignalSchema` (рівно `object`, `op: "invalidate"`),
    `rightsSignalSchema` (рівно `op: "rights"`, `row_ver`) — `z.strictObject`;
    `receivedChangeSchema`, `receivedInvalidateSchema`, `receivedRightsSchema`
    — те саме плюс `id: z.guid()`. Поля `sections` немає.

- [ ] **Step 1: тести:** `it.each` — `channelTopic` ↔ `parseTopic` туди й
  назад для кожного виду й нескоупленого; `parseTopic` чужих форматів
  (`realtime:x`, зайвий сегмент, верхній регістр, не-UUID, `simetraX:…`) —
  `undefined`; таблиця схем: зміна — рівно чотири поля, `invalidate` —
  рівно два, права — рівно два, зайве поле (зокрема `sections`) — відмова;
  прийняте — те саме плюс `id`; невідомий `op` — відмова.
- [ ] **Step 2–4:** червоний → реалізація → зелений
  (`pnpm --filter simetra test signal`).
- [ ] **Step 5: коміт** `feat(model): формат каналу й схеми сигналу`.

### Задача 12: документація, гейти, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` (§6.3,
  §6.4 — рядки Додатку А з блоком B1b-1),
  `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (§3.1,
  §3.3 — рядки Додатку А з B1b-1), `docs/ROADMAP.md`

- [ ] **Step 1:** внести правки Додатку А спеки П4-B з колонкою «Блок» =
  B1b-1 у названі документи; позначити їх у Додатку А виконаними так, як це
  робить B1a. `python3 scripts/check-doc-anchors.py` — чисто.
- [ ] **Step 2:** ROADMAP — стан П4-B (B1b-1 виконано).
- [ ] **Step 3: гейти:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
  `pnpm metadata:check`. DB-гейт не потрібен (блок без DB-змін), але
  `pnpm --filter @simetrajs/designer test` — зелений.
- [ ] **Step 4: коміт** `docs(spec): П4-B1b-1 — правки Додатку А й ROADMAP`; PR у
  `main`; звіт архітекторці.

---

## Не в B1b-1

- Конверт, `createDataHandler`, `DataTransport`, звірка сумісності,
  `stale-client`, межі й бюджет відповіді — B1b-2.
- Бюджет часу, коди команди, масиви ТЧ і `deleteIds` — B1b-3.
- Контракт прав у клієнтському каталозі — B6.
- Переведення декодера T3 (`server/decode.ts`) на кодек T0 — питання
  архітекторці (нижче).

## Відкриті питання до архітекторки

1. **Один декодер на сервері.** `server/decode.ts` (T3) декодує jsonb рядка
   бази з фізичними ключами — по суті ту саму форму, що `decodeRow` T0.
   Пропозиція: у B1b-2 (де обробник складає декодування й кодування)
   перевести T3 на `decodeValues` T0, щоб семантика значень (зокрема
   `DateTime` фіксованої ширини) не розійшлася. Вплив на спеку: §4.4 — одне
   речення.

## Підсумок аудиту плану

(заповнюється після аудиту)
