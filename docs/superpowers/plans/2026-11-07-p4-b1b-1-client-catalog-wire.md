# П4-B1b-1 — каталог клієнта, мапінг і форма передачі: план реалізації

> **Статус:** прийнято архітекторкою П4-B 2026-11-07. Виконання — на новій
> гілці від `main` після мерджу B1a. Підсумок аудиту — наприкінці файла.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** T0 (`simetra/model`) дає спільну частину запису каталогу, функцію
переліків колонок, схему клієнтського каталогу, кодек `wire`, мапінг
«логічне ↔ фізичне», схеми форми передачі, порти `SourceAdapter` і
`SignalTransport`, формат каналу й схеми сигналу; T1 (`simetra/compiler`)
заповнює id ТЧ, `signal`, `kernelHash`, `creatorMembership` і проєктує
клієнтський каталог; designer пише `client-catalog.json`.

**Architecture:** обидва каталоги — рантайму (сервер) і клієнтський (T4) —
мають одну спільну частину запису об'єкта, оголошену схемою T0; запис
рантайму розширює її серверними полями (функції ядра, `membership`,
`pgType`, `castType`, обмеження). Кожна функція T0 цього блоку
(`objectColumns`, `wire`, мапінг) типізована над спільною частиною, тож
сервер мапить каталогом рантайму, а T4 — клієнтським, тим самим кодом.
Кодування значень бере наявний кодувальник T0 (`model/runtime/values.ts`),
другого не з'являється. Конверт, обробник, `DataTransport` і звірка
сумісності — B1b-2; бюджет часу й коди команди — B1b-3.

**Tech Stack:** TypeScript 7 (native `tsc`), Zod 4, Vitest.

**Spec:** [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) — §2
(Рд1, Рд3, Рд8, Рд12, Рд17, Рд25), §3, §4.0, §4.4, §5.1, §8.1, §8.3 (канали,
сигнальний об'єкт), §8.5, §10, §11, §12 (unit T0, unit T1 — кейси B1b-1), §13
(рядок B1b-1), §14.3 (рядок `kind`/`provider`), Додаток А (рядки з B1b-1).
Чинна форма каталогу — [спека П4](../specs/2026-10-26-p4-runtime-design.md)
§6.3, §6.4, §6.10. План B1a —
`docs/superpowers/plans/2026-11-06-p4-b1a-read-query.md` (у `main` після
мерджу B1a).

## Global Constraints

- Мова: коментарі в коді — українською й пояснюють «чому»; JSDoc
  експортованого API й повідомлення — англійською.
- T0 (`packages/simetra/src/model`) — лише `zod`, без Node API; імпорти лише
  вниз за ярусами (`packages/simetra/eslint.tier-zones.js`).
- 🔴 **Тести T0 теж під межею ярусів.** `tierConfigs` у
  `eslint.tier-zones.js` не мають `ignores` для `__tests__`: тест у
  `src/model/**/__tests__/` не імпортує `simetra/compiler` чи
  `../../compiler/…`. Тести на скомпільованих каталогах живуть у
  `packages/simetra/src/compiler/__tests__/`; тести T0 будують записи
  будівником T0 (`packages/simetra/src/model/runtime/__tests__/entries.ts`,
  задача 1), без інлайн-JSON.
- Без `z.any()`; типи — `z.infer` схем T0; без реекспортів і шимів
  (принцип 5 `AGENTS.md`).
- Тести — за скілом `.agents/skills/writing-tests/SKILL.md`: unit, таблиці
  `it.each` для каталогів кейсів, будівники фікстур. DB-тестів у блоці немає.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter`.
- Записи в об'єкти за іменем з даних (`values`, рядок, `tabularSections`,
  `included`) — лише через `Map`, `Object.hasOwn` і `Object.fromEntries`:
  ім'я `__proto__` чи `constructor` не змінює прототипу й не дає поля.
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
  результату `ReadResult` (`{ rows, included?, more? }`,
  `{ rows, ownerVersion }`, `{ count, capped? }`; рядок картки з
  `tabularSections` за логічним ім'ям ТЧ — рішення В1 B1a).
- `packages/simetra/src/compiler/runtime-catalog.ts` — `ref`,
  `parentConstraint`, `load`.
- `packages/simetra/src/server/__tests__/fixtures.ts` — ручні записи
  каталогу (задача 1 доповнює їх новими обов'язковими полями).

Якщо форма запиту чи результату B1a після мерджу відрізняється від описаної
тут, задача 8 бере форму з коду, а розбіжність — повідомлення архітекторці.

## Рішення архітекторки (2026-11-07)

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| В1 | B1b поділено на B1b-1, B1b-2, B1b-3 | §13, §12, §14.3, Додаток А — внесено (`057c4f65`) |
| В2 | Переліки колонок не зберігаються в записі: їх виводить чиста функція T0 `objectColumns(entry)` над спільною частиною | §3, §10, §13, Додаток А — внесено (`d28b6a96`, `1df170be`) |
| В3 | `DataTransport` — у B1b-2 разом із конвертом | §13 — внесено (`d28b6a96`) |
| В4 | ТЧ у формі передачі — скрізь UUID ТЧ: ключ `tabularSections` операції й рядка картки, перший сегмент фізичного `path`, поле ТЧ запиту читання; фізична таблиця ТЧ — лише в SQL і в розмові з PostgREST | §4.0, Додаток А — внесено (`45f99cb7`) |
| В5 | `kernelHash` = sha256 канонічної форми `operations` запису (функції й контексти); запис без `operations` — хеш порожньої канонічної форми | немає |
| В6 | `signal` = ключ — одна колонка `uuid` **і** серед меж `RESTRICTIVE` читання немає межі «Користувачів»; межі читання — одна функція `access-units.ts` для політик і для ознаки | немає (§8.3 — одне джерело) |
| В7 | `client-catalog.json` — проєкція запису рантайму без `operations`, `membership`, `constraints`, `pgType`, `castType`; `ref` — повністю, з `constraint` | немає |
| В8 | `creatorMembership` (UUID довідника членства) у спільній частині запису кореня з творцем: ним мапиться `creatorMember` | §3 — внесено |
| В9 | Невідома мітка перерахування чи цілі пари в рядку читання — відсутнє поле, не помилка; відсутнє поле на дроті лишається відсутнім, а не `null` (ядро лишає старе значення для ключа, відсутнього в рядку, — `sectionLines`) | §4.4 — внесено |
| В10 | T3 ставить `object` на кожну помилку з `path` чи `attributes` (у пакеті — об'єкт операції, що відмовила); виконання — B1b-2, B1b-1 мапить `error.object` | §4.0 «Поля помилки» — внесено; §6.10 П4 — через Додаток А в B1b-2 |
| В11 | `server/decode.ts` переходить на `decodeRow` T0 у B1b-2 | §4.4 — внесено |
| В12 | id ТЧ у записі й у формі передачі — id елемента: UUID оголошеної ТЧ, синтетичний `<UUID об'єкта>#<канонічне ім'я>` стандартної (`standardElementId`). Формат — одне місце в T0: `standardElementId` і `elementIdSchema` переїжджають у T0, T1 імпортує їх звідти; нового регулярного виразу немає | §3, §4.0, Додаток А — внесено із задачею 1 |
| В13 | Імена спільної частини — `catalogEntry*` (`catalogAttributeSchema` і `CatalogAttribute` зайняті схемою реквізиту виду Catalog) | немає |

## Review Focus

1. **Вороже ім'я** (`__proto__`, `constructor`, `a.b`, `"x`) у значеннях
   операції, у рядку передачі, у `path`: прототип не змінено, ім'я поза
   каталогом — `unknown`. Тест — задачі 6, 7.
2. **Невідомий UUID об'єкта чи ТЧ і невідома колонка** у формі передачі:
   мапінг повертає `{ ok: false, unknown }` з UUID об'єкта, а не кидає й не
   пропускає мовчки. Тест — задача 7.
3. **Хибне значення від клієнта** на сервері — не виняток і не `unknown`:
   `BigInt: "abc"` проходить мапінг як є, і його відхиляє валідація
   `runtime.run`; невідома мітка перерахування чи цілі пари —
   `{ ok: false, invalid }` мапінгу з логічним `path`. Обидва — `command.invalid`.
   Тест — задача 7.
4. **`bigint` поза безпечним цілим, `Numeric` з масштабом, `DateTime` з
   будь-яким зсувом і дробом** — без втрат і фіксованої ширини. Тест —
   задача 6.
5. **Перейменування об'єкта, реквізиту й ТЧ** не змінює форми передачі;
   новий необов'язковий реквізит лише розширює переліки. Тест — задачі 4, 9.

---

## Карта файлів

| Файл | Що змінюється |
| --- | --- |
| `packages/simetra/src/model/runtime/catalog.ts` (після B1a) | спільна частина запису й розширення рантайму; `id` ТЧ, `signal`, `kernelHash`, `creatorMembership` |
| `packages/simetra/src/model/runtime/values.ts` | кодувальник над `CatalogEntryAttribute` замість `RuntimeAttribute` |
| `packages/simetra/src/model/runtime/columns.ts` (новий) | `objectColumns` |
| `packages/simetra/src/model/runtime/client-catalog.ts` (новий) | `clientCatalogSchema` |
| `packages/simetra/src/model/runtime/wire.ts` (новий) | `encodeRow`, `decodeRow`, `decodeValues` |
| `packages/simetra/src/model/runtime/path.ts` (новий) | `pathToWire`, `pathFromWire` |
| `packages/simetra/src/model/runtime/mapping.ts` (новий) | `catalogIndex` і мапінг операції, помилки, змін, читання |
| `packages/simetra/src/model/runtime/envelope.ts` (новий) | схеми форми передачі (без конверта) |
| `packages/simetra/src/model/runtime/ports.ts` (новий) | `SourceAdapter`, `SignalTransport` |
| `packages/simetra/src/model/runtime/signal.ts` (новий) | `channelTopic`, `parseTopic`, схеми сигналу |
| `packages/simetra/src/model/runtime/index.ts` | експорти нових модулів |
| `packages/simetra/src/compiler/access-units.ts` | `readBoundaries`, `isSignalObject` |
| `packages/simetra/src/compiler/runtime-catalog.ts` (після B1a) | `id` ТЧ, `signal`, `kernelHash`, `creatorMembership` |
| `packages/simetra/src/compiler/client-catalog.ts` (новий) | `buildClientCatalog` |
| `packages/simetra/src/compiler/index.ts` | експорти `buildClientCatalog`, `kernelHashOf` |
| `packages/designer/src/tools/artifacts.ts`, `src/cli/command.ts` | `client-catalog.json`, текст довідки `--out` |
| `packages/designer/skills/simetra-metadata/SKILL.md` | `client-catalog.json` серед артефактів |
| тести T0 | `packages/simetra/src/model/runtime/__tests__/`: `entries.ts` (будівник, новий), `catalog.test.ts`, `values.test.ts` (наявні), `columns.test.ts`, `wire.test.ts`, `path.test.ts`, `mapping.test.ts`, `envelope.test.ts`, `ports.test.ts`, `signal.test.ts` (нові) |
| тести T1 | `packages/simetra/src/compiler/__tests__/`: `runtime-catalog.test.ts`, `access-units.test.ts`, `client-catalog.test.ts` (новий), `wire-catalog.test.ts` (новий: wire і мапінг над скомпільованим каталогом), `mapping-evolution.test.ts` (новий) |
| тести T3 | `packages/simetra/src/server/__tests__/fixtures.ts` (нові обов'язкові поля записів) |
| тести designer | `packages/designer/src/__tests__/compile.test.ts`, `catalog.test.ts` |
| `docs/superpowers/specs/*`, `docs/ROADMAP.md` | Додаток А з блоком B1b-1, ROADMAP |

---

### Задача 1: спільна частина запису каталогу й id ТЧ

**Files:**
- Modify: `packages/simetra/src/model/runtime/catalog.ts`,
  `packages/simetra/src/model/runtime/values.ts`,
  `packages/simetra/src/compiler/runtime-catalog.ts`,
  `packages/simetra/src/server/__tests__/fixtures.ts`,
  `packages/simetra/src/server/__tests__/errors.test.ts` (ручні записи)
- Create: `packages/simetra/src/model/runtime/__tests__/entries.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/catalog.test.ts`
  (наявний), `values.test.ts` (наявний),
  `packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts`

**Interfaces:**
- Produces (T0):
  - `catalogEntryAttributeSchema` — поля реквізиту, спільні для обох каталогів:
    `name`, `column`, `type`, `array?`, `required`, `maxLength?`,
    `precision?`, `scale?`, `insert`, `update`, `generated?`,
    `enumValues?`, `pair?`, `ref?` (з `constraint`), `load?`.
    `runtimeAttributeSchema = catalogEntryAttributeSchema.extend({ pgType, castType })`.
  - `elementIdSchema` (T0, `packages/simetra/src/model/schemas/element-id.ts`,
    новий) — UUID або синтетичний id стандартного елемента; разом із ним у
    T0 переїжджає `standardElementId(ownerId, column)` з
    `compiler/stages/identity.ts` (без реекспорту: імпорти T1 —
    `entity-fields.ts`, `contracts.ts`, `rights/checks.ts`,
    `rights/role-checks.ts`, `stages/identity.ts` — на T0). Схема розбирає
    рядок тим самим форматом, що будує функція (роздільник — одна стала),
    без окремого регулярного виразу; префікс — `z.guid()`, ім'я —
    непорожнє, без роздільника й без крапки (крапка ділить `path`).
  - `catalogEntrySectionSchema` — `id` (`elementIdSchema`), `name`, `table`,
    `key`, `keyName`, `parent`, `parentName`, `lineNumber`,
    `lineNumberName`, `parentConstraint`, `attributes`.
    `runtimeSectionSchema` розширює його `attributes: runtimeAttributeSchema[]`
    і `constraints`.
  - `catalogEntrySchema` — `id` (`z.guid()`), `name`, `kind`, `kindLabel`,
    `table`, `key`, `keyName`, `versionColumn`, `versionName`,
    `scopeKindId?`, `scopeColumn?`, `attributes`, `tabularSections`.
    `runtimeObjectSchema` розширює його `attributes`, `tabularSections`,
    `constraints`, `operations?`, `membership?`.
  - Типи `CatalogEntry`, `CatalogEntrySection`, `CatalogEntryAttribute`.
  - `values.ts`: `encodePair`, `encodeItemValue`, `encodeAttributes` і
    `scalar` приймають `CatalogEntryAttribute` (вони читають лише спільні поля:
    `type`, `array`, `precision`, `scale`, `maxLength`, `enumValues`,
    `pair`, `column`, `name`, `insert`, `update`). `EncodeAttributesOptions`
    — узагальнений за типом реквізиту (`allowed: (a: A) => boolean`), щоб
    явні анотації `(a: RuntimeAttribute) => …` у викликачах компілювалися;
    виклики — `rg -n "encodeAttributes" packages`.
- Produces (T0 тести): `entries.ts` — `catalogEntryAttribute(overrides)`,
  `catalogEntrySection(overrides)`, `catalogEntry(overrides)`,
  `runtimeObject(overrides)` зі стабільними типовими значеннями (довідник
  зі скоупом, пара, перерахування, лінивий `Text`, ТЧ з двома реквізитами).
  Задачі 2–11 доповнюють їх лише перевизначеннями.

- [ ] **Step 1: тести.** `element-id.test.ts` (T0): `it.each` —
  `standardElementId(uuid, { logicalName: "delta" })` проходить
  `elementIdSchema`; UUID проходить; `не-uuid#delta`, `<uuid>#`,
  `<uuid>#a.b`, `<uuid>#a#b`, порожній рядок — відмова. `catalog.test.ts`:
  `it.each` — запис будівника проходить `runtimeObjectSchema`; ТЧ без `id`
  чи з хибним `id`, об'єкт з `id` не-UUID — відмова; стандартна ТЧ з
  синтетичним `id` — проходить; `expectTypeOf<RuntimeObject>().toExtend<CatalogEntry>()`.
  `runtime-catalog.test.ts`: `it("a tabular section carries its UUID")` —
  `id` кожної ТЧ дорівнює `origin.tabularSectionId` її фізичної таблиці в
  `model.physical`, зокрема синтетичний id дельти «Ролей».
- [ ] **Step 2:** `pnpm --filter simetra test catalog` — червоні.
- [ ] **Step 3:** розділити схеми; у `runtimeObject` (`runtime-catalog.ts`)
  — `id: section.table.origin.tabularSectionId` через наявний `must`;
  перетипізувати `values.ts`; доповнити ручні записи
  `server/__tests__/fixtures.ts` і `values.test.ts` (там, де вони не на
  будівнику, — перевести на `entries.ts`).
- [ ] **Step 4:** `pnpm --filter simetra test` і
  `pnpm --filter simetra typecheck` — зелені.
- [ ] **Step 5: коміт** `feat(model): спільна частина запису каталогу й id ТЧ`.

### Задача 2: межі читання й ознака `signal`

**Files:**
- Modify: `packages/simetra/src/compiler/access-units.ts`,
  `packages/simetra/src/model/runtime/catalog.ts`,
  `packages/simetra/src/compiler/runtime-catalog.ts`,
  `packages/simetra/src/model/runtime/__tests__/entries.ts`,
  `packages/simetra/src/server/__tests__/fixtures.ts` і `errors.test.ts`
  (нове обов'язкове поле)
- Test: `packages/simetra/src/compiler/__tests__/access-units.test.ts`,
  `runtime-catalog.test.ts`

**Interfaces:**
- Produces (T1, `access-units.ts`):
  - `type ReadBoundary = "tenant" | "users"`;
  - `readBoundaries(contract: AccessContract, visibleUsers: boolean): readonly ReadBoundary[]`
    — `"tenant"`, коли `contract.scope` є і `publicRead` порожній; `"users"`,
    коли `visibleUsers && contract.users`. `buildAccessUnits` додає політику
    `scopeRead` межі тенанта й політику межі «Користувачів» **лише** за цим
    результатом;
  - `signalObject(keyIsSingleUuid: boolean, boundaries: readonly ReadBoundary[]): boolean`
    = `keyIsSingleUuid && boundaries.every((b) => b === "tenant")`;
  - `isSignalObject(model: CompiledModel, objectId: string): boolean` — один
    вхід для каталогу й для генератора ядра (B2): ключ основної таблиці
    об'єкта — одна колонка з `pgType` `uuid`; контракт доступу основної
    таблиці з `model.contracts.access`; `visibleUsers` —
    `hasVisibleUsers(model.contracts, <провайдер проєкту>)`
    (`compiler/rights/functions.ts`). Немає контракту доступу (RLS вимкнено)
    — `false`: без політик межу читання не доведено.
- Produces (T0): `catalogEntrySchema.signal: z.boolean()`.

- [ ] **Step 1: тести.** `access-units.test.ts`: `it.each` над
  `readBoundaries` — скоуплена без `publicRead` → `["tenant"]`; скоуплена з
  `publicRead` → `[]`; нескоуплена → `[]`; «Користувачі» з видимими
  користувачами → `["users"]`, без них → `[]`. Наявні тести дерева SQL
  політик лишаються зеленими без змін. `runtime-catalog.test.ts`:
  `it.each` над `signalObject` — `(true, ["tenant"])` → `true`;
  `(true, [])` → `true`; `(false, [])` → `false` (ключ не з однієї колонки
  `uuid`); `(true, ["users"])` → `false` (межа «Користувачів»);
  `(true, ["tenant", "users"])` → `false`. Над моделлю фікстури
  `runtime-catalog.test.ts` (передумова в тесті:
  `hasVisibleUsers(model.contracts, "supabase")` — `true`): `Users` —
  `signal: false`, скоуплений довідник — `true`; корінь виду скоупу
  (`rootCreationDomain()`) — `true`; запис без `operations` — за тим самим
  правилом.
- [ ] **Step 2:** `pnpm --filter simetra test access-units` і
  `pnpm --filter simetra test runtime-catalog` — нові кейси червоні.
- [ ] **Step 3:** винести `readBoundaries`, перевести `buildAccessUnits` на
  нього; `isSignalObject` і поле `signal` у `runtimeObject`. Коментар
  «чому»: те саме рішення пише виклик сигналу в ядрі (B2), тож джерело
  одне (§8.3).
- [ ] **Step 4:** `pnpm --filter simetra test` — увесь unit-набір зелений.
- [ ] **Step 5:** мутація — `signalObject` повертає `keyIsSingleUuid`:
  червоніє кейс `Users`; відкотити.
- [ ] **Step 6: коміт** `feat(compiler): межі читання одним джерелом і ознака signal запису каталогу`.

### Задача 3: `kernelHash` і `creatorMembership`

**Files:**
- Modify: `packages/simetra/src/model/runtime/catalog.ts`,
  `packages/simetra/src/compiler/runtime-catalog.ts`,
  `packages/simetra/src/compiler/index.ts`,
  `packages/simetra/src/model/runtime/__tests__/entries.ts`,
  `packages/simetra/src/server/__tests__/fixtures.ts` і `errors.test.ts`
  (нове обов'язкове поле)
- Test: `packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts`

**Interfaces:**
- Produces (T1): `kernelHashOf(operations: RuntimeObject["operations"]): string`
  = `sha256HexSync(canonicalize(operations ?? {}))` (`compiler/sha256.ts`,
  `compiler/canonical.ts`).
- Produces (T0): `catalogEntrySchema.kernelHash: z.string().regex(/^[0-9a-f]{64}$/)`;
  `catalogEntrySchema.creatorMembership?: z.guid()` — UUID довідника
  членства кореня виду скоупу з творцем (те саме, що
  `operations.create.root.membership`): клієнт мапить `creatorMember` записом
  цього довідника без `operations` (В8). `superRefine`
  `runtimeObjectSchema`: `creatorMembership` = `operations.create.root.membership`;
  `clientCatalogSchema` (задача 5): ціль `creatorMembership` — серед
  `objects`.

- [ ] **Step 1: тести** (`describe("kernelHash")`):
  - `kernelHash` кожного запису = `kernelHashOf(entry.operations)`;
  - запис без `operations` — `kernelHashOf(undefined)`, однаковий у двох
    компіляціях;
  - `it.each` варіантів фікстури, що **не** змінюють `kernelHash`
    довідника: перейменування об'єкта, реквізиту й ТЧ (через
    `renameElement` з `simetra/compiler`); новий необов'язковий реквізит
    шапки й ТЧ; зміна подання; зміна гранту дії ролі (не `rootCreator`);
    зміна іншого об'єкта; зміна `load`;
  - `kernelHashOf` різних `operations` (інший `context`, інша функція,
    відсутня дія) — різні хеші.
  - `creatorMembership`: корінь з творцем (`rootCreationDomain()`) — UUID
    довідника членства = `operations.create.root.membership`; корінь без
    творця й не корінь — поля немає.
- [ ] **Step 2:** `pnpm --filter simetra test runtime-catalog` — червоні.
- [ ] **Step 3:** `kernelHashOf`, поля в записі.
- [ ] **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(compiler): kernelHash і creatorMembership запису каталогу`.

### Задача 4: `objectColumns`

**Files:**
- Create: `packages/simetra/src/model/runtime/columns.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/columns.test.ts`,
  `packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts`

**Interfaces:**
- Produces (T0):

```ts
interface ColumnLists {
  insert: readonly string[]
  update: readonly string[]
  read: readonly string[] // звичайні
  lazy: readonly string[]
}
interface ObjectColumns extends ColumnLists {
  tabularSections: ReadonlyMap<string /* id ТЧ */, ColumnLists>
}
function objectColumns(entry: CatalogEntry): ObjectColumns
```

  - шапка: `insert`/`update` — `column` і `pair.typeColumn` реквізитів з
    `insert`/`update`; `read` — `key`, `versionColumn`, `scopeColumn`, далі
    `column` і `pair.typeColumn` реквізитів без `load: "lazy"`; `lazy` —
    `column` лінивих;
  - ТЧ: `insert`/`update` — `key` рядка (рядок ТЧ в операції завжди несе
    ключ) і колонки реквізитів ТЧ з `insert`/`update`; `read` — `key`,
    `parent`, `lineNumber`, колонки реквізитів; `lazy` — `[]`;
  - **без дублів, порядок — перше входження**: скоуп скоупленого довідника
    є й реквізитом, а в кореня `scopeColumn` = `key`.
  Функція чиста й читає лише спільну частину. Локальна `objectColumns` у
  `server/read.ts` (B1a) має інше призначення: якщо імпорт T0 з'являється в
  тому самому модулі, локальну перейменувати на `listColumns`.

- [ ] **Step 1: тести.** `columns.test.ts` (будівник `entries.ts`):
  `toEqual` переліків довідника з парою, лінивим полем і ТЧ; `it.each`
  інваріантів — перейменування реквізиту (інші `name`, ті самі `column`) —
  переліки рівні; зміна `load` переносить колонку між `read` і `lazy`;
  новий необов'язковий реквізит — старі переліки є підмножинами нових;
  ТЧ — `read` починається з `key`, `parent`, `lineNumber`, `insert` — з
  `key`; генерований реквізит без `insert`/`update` — лише в `read`;
  скоуплений довідник і корінь (`scopeColumn` = `key`) — без дублів.
  `runtime-catalog.test.ts`: `objectColumns` скомпільованого скоупленого
  довідника — без дублів, `read` містить ключ, версію, скоуп і колонку пари.
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
  `packages/designer/src/tools/artifacts.ts`,
  `packages/designer/src/cli/command.ts` (довідка `--out`),
  `packages/designer/skills/simetra-metadata/SKILL.md` (перелік артефактів)
- Test: `packages/simetra/src/compiler/__tests__/client-catalog.test.ts`
  (новий), `packages/designer/src/__tests__/compile.test.ts`,
  `packages/designer/src/__tests__/catalog.test.ts`

**Interfaces:**
- Produces (T0): `clientCatalogSchema = z.strictObject({ format: z.literal(1),
  snapshotHash, provider, objects: z.array(catalogEntrySchema) })`, тип
  `ClientCatalog`. Контракт прав для обчислювача — B6.
- Produces (T1): `buildClientCatalog(runtime: RuntimeCatalog): ClientCatalog`
  — явна проєкція кожного запису (поля спільної частини; реквізити й ТЧ без
  `pgType`, `castType`, `constraints`), порядок об'єктів — як у каталозі
  рантайму.
- designer: `compileArtifacts` додає `client-catalog.json`
  (`JSON.stringify(buildClientCatalog(buildRuntimeCatalog(model)), null, 2) + "\n"`)
  після `runtime-catalog.json`.

- [ ] **Step 1: тести.** `client-catalog.test.ts`: результат проходить
  `clientCatalogSchema`; детермінований у двох компіляціях; обхід дерева
  JSON не знаходить ключів `operations`, `membership`, `constraints`,
  `pgType`, `castType`, `function`; кожен запис несе `kind`, `kindLabel`,
  `kernelHash`, `signal`, `ref` з `constraint`, `load`, `parentConstraint`,
  `id` ТЧ, а корінь з творцем — `creatorMembership`; `provider` і
  `snapshotHash` = каталогу рантайму; `objectColumns` проєкції =
  `objectColumns` запису рантайму для кожного об'єкта. designer: точні
  переліки файлів у `compile.test.ts` («--out writes …») і `catalog.test.ts`
  («compileArtifacts emits …») доповнюються `client-catalog.json`; вміст —
  `buildClientCatalog` тієї самої моделі.
- [ ] **Step 2:** `pnpm --filter simetra test client-catalog`,
  `pnpm --filter @simetrajs/designer test compile catalog` — червоні.
- [ ] **Step 3:** реалізація; довідка CLI й скіл споживача називають
  `client-catalog.json`.
- [ ] **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(compiler): клієнтський каталог і client-catalog.json`.

### Задача 6: кодек `wire`

**Files:**
- Create: `packages/simetra/src/model/runtime/wire.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/wire.test.ts`,
  `packages/simetra/src/compiler/__tests__/wire-catalog.test.ts` (новий)

**Interfaces:**
- Consumes: `encodeItemValue`, `encodePair`, `INTEGER_TEXT`,
  `isPlainObject` з `values.ts` (задача 1). Логічна форма пари —
  `{ type: "<Kind>.<Name>", id }` (як в `encodePair`).
- Produces (T0), над `CatalogEntry`:
  - `type WireRow = Record<string, unknown>` (фізичні ключі),
    `type LogicalRow = Record<string, unknown>` (логічні імена, як
    `CommandResult.rows`); рядок картки несе `tabularSections`.
  - `encodeRow(entry: CatalogEntry, row: LogicalRow): WireRow` (сервер) —
    значення реквізитів через `encodeItemValue` (пара — дві колонки,
    перерахування — мітка, `BigInt` — рядок); ключ, версія й номер рядка ТЧ
    — рядок цілого; `tabularSections` за логічним ім'ям → за id ТЧ; поле
    рядка, якого немає в записі, не потрапляє в результат. Значення,
    яке `encodeItemValue` відхиляє, — `WireEncodeError` (клас T0): рядок
    рантайму вже пройшов валідацію, тож це дефект, а не вхід.
  - `decodeRow(entry: CatalogEntry, raw: WireRow): LogicalRow` (клієнт,
    обидва адаптери) — за таблицею §4.4: `BigInt` — JS `bigint`; версія й
    номер рядка ТЧ — лише рядок цілого → безпечне ціле `number`; `Numeric`,
    `Date`, `Bytes` — рядок без змін; `DateTime` — рядок
    `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, рівно 6 знаків дробу) з будь-якого
    зсуву й 0–6 знаків дробу, розбором рядка (не `Date`: він губить
    мікросекунди); понад 6 знаків — `WireDecodeError` (точність
    `timestamptz` — мікросекунди, тож довший дріб — не значення бази); перерахування — логічне ім'я; пара — `{ type, id }`;
    `Json` — значення; фізичний ключ поза записом ігнорується; відсутній ключ
    — відсутнє поле; `tabularSections` за id ТЧ → за логічним ім'ям.
    Невідома мітка перерахування чи цілі пари — поле відсутнє, як колонка
    поза каталогом (В9).
    Значення не того типу (не рядок цілого для `BigInt`) — `WireDecodeError`
    з фізичною колонкою.
  - `Raw` (копії носія прав, напр. `copy_id`) — і `encodeRow`, і
    `decodeRow` передають значення як є, без `encodeItemValue`: `scalar`
    відхиляє `Raw` як вхід команди, а читання їх віддає.
  - Значення бази, яких `encodeItemValue` не приймає (`infinity` для
    `Date`/`DateTime`, `NaN` для `Numeric`), — `WireEncodeError`; записати
    це в JSDoc `encodeRow`.

- [ ] **Step 1: тести.** `wire.test.ts` (будівник `entries.ts`): таблиця
  `it.each` з `LOGICAL_TYPES` (`model/schemas/value-type.ts`) плюс `Raw`,
  масив, одноцільовий `Ref`, перерахування, пара, `null` — конкретна форма
  передачі кожного (`toEqual` на літерал) і `decodeRow(encodeRow(x))` = `x`
  для нормалізованого `x`; `BigInt` 2^63−1; `Numeric` `10.50`; `DateTime`
  `+00:00`, `+05:30`, `-08:00` з 0, 3 і 6 знаками дробу → однаковий
  нормалізований рядок; 7 знаків дробу — `WireDecodeError`; версія `"7"` → `7`, версія числом — `WireDecodeError`;
  ключ поза записом ігнорується; відсутній ключ — немає поля; рядок картки з
  двома ТЧ; ключі `__proto__` і `constructor` у рядку — прототип результату
  `Object.prototype`, полів немає. `wire-catalog.test.ts`: `encodeRow` /
  `decodeRow` рядка скомпільованого довідника з парою й ТЧ (каталог фікстури
  `policyDomain`), обидва каталоги (рантайму й клієнтський) дають ту саму
  форму передачі.
- [ ] **Step 2:** `pnpm --filter simetra test wire` — червоні.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(model): кодек wire — encodeRow і decodeRow`.

### Задача 7: `path`, мапінг операції, помилки й набору змін; схеми передачі

**Files:**
- Create: `packages/simetra/src/model/runtime/path.ts`,
  `packages/simetra/src/model/runtime/mapping.ts`,
  `packages/simetra/src/model/runtime/envelope.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/path.test.ts`,
  `mapping.test.ts`, `envelope.test.ts`,
  `packages/simetra/src/compiler/__tests__/wire-catalog.test.ts`

**Interfaces:**
- Produces (T0, `path.ts`) — граматика шляху (форми, які видають
  `server/values.ts`, `server/errors.ts`, `server/read.ts` і
  `hook-context.ts`): сегменти через крапку; мапиться за правилами нижче,
  решта сегментів — без змін:
  - ТЧ: `<ТЧ>[.<i>][.<реквізит ТЧ | keyName ТЧ>[.<j>]]` ↔
    `<id ТЧ>[.<i>][.<колонка>[.<j>]]` (id ТЧ — UUID чи синтетичний id
    стандартної ТЧ, В12; крапки в ньому немає); сегмент лише з цифр — індекс (без
    змін), інакше ім'я. Так покрито `<ТЧ>`, `<ТЧ>.<i>`, `<ТЧ>.<i>.<реквізит>`,
    `<ТЧ>.<i>.<реквізит>.<j>` (масив), `<ТЧ>.<i>.<keyName ТЧ>` з
    `server/values.ts` і `<ТЧ>.<реквізит>` без індексу з `server/errors.ts`
    (`tablesOf` дає префікс `<ТЧ>.`);
  - `creatorMember[.<реквізит | keyName довідника членства>]` ↔
    `creatorMember[.<колонка>]` — записом з `creatorMembership`;
  - `<реквізит шапки>[.<i>]`, `keyName`, `versionName` ↔ колонка;
  - структурні сегменти (`values`, `id`, `object`, `orderBy`, `filter`,
    `expectedVersion`, …) і довільний шлях `ctx.reject`, що не збігається з
    іменем каталогу, — без змін.
  - Правило неоднозначності: перший сегмент спершу шукається серед ТЧ, далі
    `creatorMember`, далі серед реквізитів, ключа й версії; збіг з іменем
    каталогу виграє в структурного слова. Імена ТЧ і реквізитів шапки —
    один простір імен об'єкта (виконавець звіряє це з правилом унікальності
    імен T0; якщо простори різні — повідомлення архітекторці).
  - `pathToWire(index, objectId, path): string`,
    `pathFromWire(index, objectId, path): string` — завжди повертають шлях
    (помилка не губиться через мапінг).
- Produces (T0, `envelope.ts`) — лише схеми форми передачі (конверт —
  B1b-2):
  - `wireOperationSchema` — як `operationSchema`, з `object: z.guid()`,
    `values`/`creatorMember` — записи фізичних колонок, `tabularSections` —
    запис `id ТЧ → рядки фізичних колонок`; `expectedVersion` — як у
    логічній формі;
  - `wireCommandErrorSchema` — `CommandError` з `object?: z.guid()`,
    `path?` фізичним, `attributes?` фізичними (`<колонка>` шапки,
    `<id ТЧ>.<колонка>` ТЧ; пара — її `column`);
  - `wireChangeSchema` — `Change` з `object: z.guid()`.
- Produces (T0, `mapping.ts`):
  - `catalogIndex(objects: readonly CatalogEntry[]): CatalogIndex` — пошук
    за UUID і за `MetadataRef` (`Map`).
  - `type Mapped<T> = { ok: true; value: T } | { ok: false; unknown: { object: string; section?: string; column?: string; name?: string } } | { ok: false; invalid: CommandError }`
    — `unknown.object` завжди UUID об'єкта (чи UUID з запиту, коли об'єкт
    невідомий). `unknown` означає лише **ім'я** поза каталогом; B1b-2 перед
    мапінгом звіряє сумісність кроком 3 і дає `command.stale-client`, тож на
    сервері `unknown` після звірки — дефект.
  - `operationToWire(index, op: Operation): Mapped<WireOperation>` (T4):
    невідоме логічне ім'я — `unknown` (помилка входу T4); значення —
    через `encodeItemValue`, його відмова — `{ ok: false, invalid }` з
    логічним `path`.
  - `operationFromWire(index, wire: WireOperation): Mapped<Operation>`
    (сервер): невідома фізична колонка в `values`, рядку ТЧ чи
    `creatorMember`, невідомий id ТЧ — `unknown` (не ігнорується);
    значення, що потребують перекладу, перекладаються суворо: мітка
    перерахування → ім'я, пара з двох колонок → `{ type, id }`; невідома
    мітка (зокрема логічне ім'я замість мітки) — `{ ok: false, invalid }` з
    логічним `path`. Решта значень (`BigInt` текстом, `Numeric`, дати,
    `Json`, `Raw`) передається як є, і її валідує `runtime.run`
    (`parseInput` у `server/phase.ts` → `command.invalid`).
    `operationFromWire` не кидає.
  - `errorToWire(index, error: CommandError): WireCommandError` і
    `errorFromWire(index, error: WireCommandError): CommandError` — `path` і
    `attributes` мапляться записом `error.object` через `path.ts`; помилка
    без `object` мапить лише `object`-незалежні поля, а `path` і `attributes`
    лишає без змін (В10: T3 ставить `object` на кожну помилку з `path` чи
    `attributes` у B1b-2).
  - `changesToWire` / `changesFromWire` — над `object` (`Change` з
    `result.ts`; решта полів без змін).

- [ ] **Step 1: тести.** `path.test.ts` (будівник): `it.each` кожної
  форми граматики туди й назад, зокрема `<ТЧ>.<i>.<реквізит>`, `<ТЧ>.<i>`,
  `<ТЧ>`, стандартна ТЧ із синтетичним id (туди й назад), `creatorMember.<реквізит>`, `keyName`, `values`, `orderBy.0.attribute`,
  довільний шлях застосунку; реквізит з ім'ям `values` — колонка;
  `__proto__` — без змін. `mapping.test.ts` (будівник): кожна дія операції
  туди й назад; `creatorMember` кореня мапиться записом довідника членства
  **клієнтського** каталогу; масив ТЧ з двома рядками; `errorToWire` /
  `errorFromWire` для `command.constraint` з `attributes` шапки, пари й ТЧ і
  `path` ТЧ (`<ТЧ>.<реквізит>` без індексу), помилка без `object` — `path`
  без змін; набір змін; невідомий UUID об'єкта, невідомий id ТЧ, невідома
  колонка, невідоме логічне ім'я — `unknown` з UUID об'єкта; ворожі імена
  (`__proto__`, `constructor`, `a.b`, `"x`) — `unknown`, прототип не змінено;
  відсутнє поле в `values` чи рядку ТЧ лишається відсутнім після
  `operationToWire` і `operationFromWire`, а не стає `null` (В9: ядро лишає
  старе значення лише для відсутнього ключа); `BigInt: "abc"` в
  `operationFromWire` — `ok`, значення як є; невідома
  мітка перерахування й логічне ім'я значення замість мітки — `invalid` з
  логічним `path`; `operationToWire` з `BigInt` не тим типом —
  `invalid` з логічним `path`. `envelope.test.ts`: `wireOperationSchema`
  відхиляє `object`, що не UUID; таблиця схем помилки й змін.
  `wire-catalog.test.ts`: операція й помилка над скомпільованим каталогом —
  обидва каталоги дають ту саму форму передачі.
- [ ] **Step 2:** `pnpm --filter simetra test path mapping envelope wire-catalog`
  — червоні.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(model): path і мапінг операції, помилки й набору змін у форму передачі`.

### Задача 8: мапінг запиту й результату читання (після B1a)

**Files:**
- Modify: `packages/simetra/src/model/runtime/mapping.ts`,
  `packages/simetra/src/model/runtime/envelope.ts`
- Test: `mapping.test.ts`, `envelope.test.ts`, `wire-catalog.test.ts`

**Interfaces:**
- Consumes: `ReadQuery`, `ReadResult`, `Filter` з `read.ts` B1a.
- Produces (T0):
  - `wireReadQuerySchema` — `readQuerySchema` B1a з `object: z.guid()`,
    фізичними колонками у фільтрі, сортуванні й `include`, id ТЧ у
    `tabularSection`/`tabularSections`;
  - `wireReadResultSchema` — `{ rows: WireRow[], included?: { "<UUID об'єкта>": WireRow[] }, more? }`,
    `{ rows, ownerVersion }`, `{ count, capped? }`;
  - `readQueryToWire(index, query: ReadQuery): Mapped<WireReadQuery>`,
    `readQueryFromWire(index, wire): Mapped<ReadQuery>` — невідома колонка
    фільтра, сортування, `include` чи id ТЧ — `unknown`. Форми значень
    умови фільтра в передачі: версія — рядок цілого (логічна — `number`,
    `read-filter.ts` вимагає безпечне ціле); перерахування — мітка; пара —
    умова над `column` пари зі значенням `{ type: <мітка цілі>, id }`
    (логічна — `{ type: "<Kind>.<Name>", id }`); `BigInt` — рядок; решта —
    як є. Невідома мітка — `invalid` з логічним `path`, як в операції;
  - `readResultToWire(index, query, result: ReadResult): WireReadResult`
    (сервер, `encodeRow`), `readResultFromWire(index, query, wire): ReadResult`
    (клієнт, `decodeRow`).

- [ ] **Step 1: тести:** `it.each` над кожною формою запиту B1a (список з
  `and`/`or`/`not` і кожним оператором, сортування, `include`, картка з ТЧ,
  «ТЧ власника», ТЧ як ціль списку, `count`) — туди й назад; фільтр за
  невідомою колонкою — `unknown`; невідомий id ТЧ — `unknown`; результат
  — `included` за UUID ↔ за `"<kind>.<name>"`, `ownerVersion`, `more`,
  `count`.
- [ ] **Step 2:** червоні. **Step 3:** реалізація. **Step 4:** зелені.
- [ ] **Step 5: коміт** `feat(model): мапінг запиту й результату читання у форму передачі`.

### Задача 9: перейменування й розширення (каталоги A і A′)

**Files:**
- Test: `packages/simetra/src/compiler/__tests__/mapping-evolution.test.ts` (новий)
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/` — будівник
  `evolvedCatalogs()`

**Interfaces:**
- Produces: `evolvedCatalogs(): Promise<{ a: RuntimeCatalog; aPrime: RuntimeCatalog }>`
  — `A′` = `A` з перейменованими (через `renameElement`) об'єктом, реквізитом
  і ТЧ, новим необов'язковим реквізитом шапки й ТЧ і реквізитом, видаленим на
  фазі розширення.

- [ ] **Step 1: тести** — клієнт мапить `buildClientCatalog(a)`, сервер —
  каталогом рантайму `aPrime`: запит читання з фільтром, `include`, карткою
  з ТЧ; `update` з повною заміною рядків ТЧ; помилка `command.constraint` з
  `attributes`; набір змін. Логічне `A` → передача → логічне `A′` — ті самі
  колонки під новими іменами; результат `A′` → передача → логічне `A` —
  імена `A`, нової колонки в рядку `A` немає; у повній заміні рядків ТЧ
  старою вкладкою нова колонка не називається (збереження її значення
  сервером доводить B1b-2); запит з видаленим реквізитом — `unknown` на боці
  `A′` (B1b-2 дасть `stale-client`); перейменування ТЧ не змінює форми
  передачі; `objectColumns(A)` без колонки видаленого реквізиту —
  підмножина `objectColumns(A′)`, а колонка видаленого реквізиту в
  `objectColumns(A′)` відсутня (окремий `expect`).
- [ ] **Step 2:** червоні. **Step 3:** будівник. **Step 4:** зелені.
- [ ] **Step 5: коміт** `test(model): мапінг між каталогами після перейменування й розширення`.

### Задача 10: порти `SourceAdapter` і `SignalTransport`

**Files:**
- Create: `packages/simetra/src/model/runtime/ports.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/ports.test.ts`

**Interfaces:**
- Produces (T0) — лише типи (§5.1, §8.5):

```ts
// лічильник — через DataTransport (B1b-2), тож порт його не бачить ні на вході, ні на виході
type WireRowsQuery = Exclude<WireReadQuery, { count: true }>
type WireRowsResult = Exclude<WireReadResult, { count: unknown }>
interface SourceAdapter {
  read(query: WireRowsQuery): Promise<WireRowsResult>
  capabilities: { include: boolean }
}
type SignalErrorKind = "auth" | "transport"
type Unsubscribe = () => void
interface SignalTransport {
  subscribe(channels: readonly string[], onSignal: (topic: string, payload: unknown) => void, onError: (kind: SignalErrorKind) => void): Unsubscribe
  onSubscribed(handler: () => void): Unsubscribe
}
```

- [ ] **Step 1: тест типів** (`expectTypeOf`): фейкова реалізація
  задовольняє обидва порти; `// @ts-expect-error` на виклику `read` із
  запитом `{ count: true }` і на реалізації, що повертає `{ count }`.
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
  - `changeSignalSchema` — `z.strictObject` рівно з `object` (UUID), `op` ∈
    `create`/`update`/`markDeletion`/`delete`, `keys` — рівно один запис
    `<колонка>: <UUID>`, `row_ver` — безпечне ціле;
    `invalidateSignalSchema` — рівно `object`, `op: "invalidate"`;
    `rightsSignalSchema` — рівно `op: "rights"`, `row_ver`;
    `receivedChangeSchema`, `receivedInvalidateSchema`,
    `receivedRightsSchema` — те саме плюс `id: z.guid()`. Поля `sections`
    немає.

- [ ] **Step 1: тести:** `it.each` — `channelTopic` ↔ `parseTopic` туди й
  назад для кожного виду й нескоупленого; `parseTopic` чужих форматів
  (`realtime:x`, зайвий сегмент, верхній регістр, не-UUID, `simetraX:…`) —
  `undefined`; таблиця схем: зміна — рівно чотири поля, `invalidate` —
  рівно два, права — рівно два; зайве поле (зокрема `sections`), `keys` з
  двома записами чи порожній — відмова; прийняте — те саме плюс `id`;
  невідомий `op` — відмова.
- [ ] **Step 2–4:** червоний → реалізація → зелений
  (`pnpm --filter simetra test signal`).
- [ ] **Step 5: коміт** `feat(model): формат каналу й схеми сигналу`.

### Задача 12: документація, гейти, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md`,
  `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (рядки
  Додатку А спеки П4-B з блоком B1b-1), `docs/ROADMAP.md`

- [ ] **Step 1:** внести правки Додатку А з колонкою «Блок» = B1b-1 у названі
  документи так само, як це робить B1a; `python3 scripts/check-doc-anchors.py`
  — чисто.
- [ ] **Step 2:** ROADMAP — стан П4-B (B1b-1 виконано).
- [ ] **Step 3: гейти:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
  `pnpm metadata:check`. DB-гейту блок не потребує (DB-змін немає).
- [ ] **Step 4: коміт** `docs(spec): П4-B1b-1 — правки Додатку А й ROADMAP`; PR у
  `main`; звіт архітекторці.

---

## Не в B1b-1

- Конверт, `createDataHandler`, `DataTransport`, звірка сумісності,
  `stale-client`, межі й бюджет відповіді — B1b-2.
- `object` на кожній помилці T3 з `path` чи `attributes` (В10) і перехід
  `server/decode.ts` на `decodeRow` T0 (В11) — B1b-2.
- Бюджет часу, коди команди, масиви ТЧ і `deleteIds` — B1b-3.
- Фасад не перетворює відсутнє поле чернетки на `null` (В9) — правило B3.
- Контракт прав у клієнтському каталозі — B6 (рядок B6 §13), хоча §3 описує
  його серед вмісту клієнтського каталогу: каталог B1b-1 — його частина без
  контракту прав.
- Лінива пара: колонки пари лінивими не бувають (Рд25, правило B1a), тож
  `lazy` пари не містить.

## Підсумок аудиту плану

- **Раунд 1** (Opus, повний план): 0 blocker, 0 безпекових major; 6 major —
  тести T0 під межею ярусів, неповна граматика `path`, `creatorMember` без
  довідника в клієнтському каталозі, семантика збою мапінгу, дублі в
  переліках, другий кодувальник поруч із `values.ts`; minor — внесено.
  Наслідкові правки спеки — `1df170be`.
- **Раунд 2** (Opus, дифф): 0 blocker, 0 безпекових major; 3 major — форми
  `path` ТЧ без індексу й з `keyName`, об'єкт для мапінгу помилки (→ В10),
  `Raw` у кодеку; minor — внесено. Перевірено: значення «як є» до SQL без
  валідації не доходить (`parseInput`, `encodeMember`, `encodeParam`).
- **Codex** (gpt-6-sol, вбудований контекст): 1 «blocker» і 5 major.
  Спростовано: «blocker» про контракт прав (це B6 за §13), лінива пара
  (заборонена Рд25), підмножина в задачі 9 (план уже виключав видалену
  колонку — формулювання уточнено). Внесено: дріб `DateTime` понад 6 знаків,
  узгодження Review Focus 3 із задачею 7, запит `count` поза портом
  `SourceAdapter`.
- Повторна перевірка правок третього раунду аудиту спеки (§14.3) для B1b-1
  не потрібна: ті пункти — B1b-2, B1b-3 і B3.
