# П4-B1a — запит читання другої форми: план реалізації

> **Статус:** прийнято архітекторкою П4-B 2026-11-06; у виконанні. Підсумок аудиту
> плану — наприкінці файла.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** серверне читання T3 (`runtime.read`, `ctx.read`, MCP `data-read`)
приймає запит T0 другої форми й повертає нову форму результату; каталог
рантайму несе `ref`, `parentConstraint`, `load` і запис лише для читання;
`CommandFailure` і `ZERO_UUID` живуть у T0.

**Architecture:** T0 (`simetra/model`) оголошує запит, фільтр-дерево, сталі
меж і типи результату; T3 (`simetra/server`) перевіряє запит проти каталогу до
бази й рендерить SQL лише з ідентифікаторів каталогу та зв'язаних параметрів;
T1 (`simetra/compiler`) дає нові поля каталогу й правила лінивості. Форма П4-A
зникає в тому самому блоці разом зі споживачами (принцип 5 `AGENTS.md`).

**Tech Stack:** TypeScript 7 (native `tsc`), Zod 4, Vitest, PostgreSQL 17
(локальний стек Supabase), `pg`.

**Spec:** [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) — §2
(Рд1, Рд2, Рд19–Рд30), §3, §4.0–§4.2, §11, §12, §13 (рядок B1a), Додаток А
(рядки з блоком B1a). Чинна форма, яку блок замінює, —
[спека П4](../specs/2026-10-26-p4-runtime-design.md) §6.3, §6.4, §6.9,
§6.10, §6.11, §6.14. Виконавець читає обидві спеки разом із цим планом.

## Global Constraints

- Мова: коментарі в коді — українською й пояснюють «чому»; JSDoc експортованого
  API, повідомлення валідації, опис MCP-інструмента, скіл споживача — англійською.
- Коміти: Conventional Commits з українським описом; без жодних трейлерів
  (`Co-Authored-By`, «Generated with»); комітити — лише коли власник чи
  архітекторка попросили (запуск `/виконай-задачу` — це прохання).
- T0 `simetra/model` — без runtime-залежностей, крім `zod`; типи — `z.infer`
  схем T0; без `z.any()`.
- Імпорти ярусів — лише вниз; T4 (`src/data`) не імпортує `simetra/server`.
- Без реекспорту й аліасів старих шляхів (`CommandFailure`, `ZERO_UUID`, форма
  запиту П4-A) — старий шлях видаляється в тій самій задачі.
- SQL читання: ідентифікатори — лише з каталогу через `ident()`, значення —
  лише `$n::<castType>`; тексту SQL ззовні немає (Рт13).
- Сталі зі спеки (§4.1, Рд26): `READ_LIMIT_MAX` = 200, `offset` ≤ 10 000,
  межа `count` = 10 000, `in` ≤ 200 значень, глибина фільтра ≤ 8, вузлів ≤ 64,
  `TABULAR_LINES_MAX` = 5 000 (орієнтир; число уточнює бенчмарк B2),
  `statement_timeout` читання типово 15 с; `orderBy` — до 4 реквізитів плюс
  ключ останнім (В6).
- `contains` і `startsWith` — `ILIKE` без урахування регістру, символи `%`,
  `_`, `\` у значенні екрануються.
- Без явного `COLLATE` у будівнику (Рд29); список не будується з `to_jsonb(t)`.
- Форма картки з ТЧ і «ТЧ власника» — один SQL-оператор (рядок власника з
  корельованими підзапитами ТЧ); понад `TABULAR_LINES_MAX` — `command.invalid`
  `reason: "tabular-too-large"` з `path` ТЧ, без обрізання.
- Тести: скіл `.agents/skills/writing-tests/SKILL.md`; у `pnpm --filter`
  шаблон vitest — **без** `--` перед ним; DB-тест пояснює, чого не дає unit.
- Повний `pnpm test:db` — раз на блок, у фінальних гейтах (задача 11); під
  час роботи — лише scoped DB-файли.
- Репо публічне: жодних даних споживача.

## Не в B1a

Форма передачі, клієнтський каталог, `wire`/`decodeRow` T0, конверт і
`createDataHandler`, переліки колонок і `kernelHash`, `BATCH_MAX`, бюджет
відповіді й `more`, бюджет часу команди й коди `command.busy`/`command.timeout`
для команд, `deleteIds` — B1b. Фасад, адаптери, сигнали — B3 і далі.
Діра «`./../model` проходить як `./…`» у блоці T3 `eslint.tier-zones.js`
(спека §3) — згадка, поза цим планом: доповісти архітекторці.

## Review Focus

1. **Вороже ім'я чи значення у фільтрі** (`"x\"; DROP …"`, крапка, `;`,
   ім'я системної колонки `ctid`) — `command.invalid` з `path` без жодного
   виклику порту; тест — задача 5, крок 1 (таблиця ворожих імен).
2. **Лінивий атрибут текстокодованого типу** (`load: "lazy"` на `Numeric` чи
   `BigInt`) не просочується в списочну форму через приведення до тексту —
   тест задачі 6 («list omits a lazy text-encoded column»).
3. **`contains`/`startsWith` зі значенням `50%_\`** — шаблон шукає літерали,
   а не маску; unit — задача 5, DB — задача 10.
4. **Об'єкт, ширший за 50 колонок**: `jsonb_build_object` приймає до 100
   аргументів, тож списочна проєкція ріжеться на шматки по ≤ 50 пар через
   `||`; тест задачі 6 («a wide object projects in chunks»).
5. **Невидимий чи відсутній рядок**: картка — `{ rows: [] }`, «ТЧ власника» —
   `{ rows: [] }` без `ownerVersion`, сторінка ТЧ з `parent eq` невидимого
   власника — без `ownerVersion`; тести задачі 8 і DB-сценарій задачі 10.

## Рішення архітекторки (2026-11-06)

Розвилки, які спека лишала відкритими; вирішила архітекторка П4-B. Вплив на
спеку — «немає», якщо не сказано інше.

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| В1 | ТЧ рядка картки — у полі `tabularSections: { <логічне ім'я ТЧ>: rows }` (логічна форма, §4.2); ТЧ верхнім рівнем рядка немає | немає |
| В2 | Стала `TABULAR_LINES_MAX` (стеля читання) приходить у B1a: її потребують картка й «ТЧ власника». Межа запису ТЧ і зменшені налаштування — B1b | немає |
| В3 | `load: "eager" \| "lazy"`; без поля — типове за типом: `RichText` і `Bytes` шапки — `lazy`, решта — `eager`; у ТЧ — завжди `eager`, `lazy` там — помилка компілятора | Рд25 і рядок Додатку А «спека П2 … `load`» — значення `"eager" \| "lazy"` (вносить задача 11) |
| В4 | Ключ у `orderBy` дозволено лише останнім елементом; будівник його не дублює; ключ не останнім — `command.invalid`; без ключа в `orderBy` будівник додає ключ `ASC` | немає |
| В5 | `eq`/`ne` зі значенням `null` — `command.invalid` (`reason: "use-isNull"`): тризначна логіка SQL інакше мовчки дала б порожню множину | немає |
| В6 | `orderBy` — до 4 реквізитів плюс ключ останнім (`ORDER_BY_MAX` = 4 без ключа) | немає |
| В7 | `57014` → `command.timeout` скрізь, де є фаза `read`, зокрема в `ctx.read` (команда відхиляється цим кодом); мапінг фаз запису — B1b | немає |
| В8 | Доступу до хостованого Supabase немає. Колляцію перевірено на локальному стеку (нижче); хостовану — рядком у перевірці хостованого Supabase мінімальної доставки (спека П4 §9); не блокер B1a | §4.2 — одне речення (вноситься разом із планом) |
| В9 | `btree_gin` для `uuid` — не в B1a (метадані пошуку — пізніше) | немає |
| В10 | `include` — до `INCLUDE_MAX` = 16 реквізитів (без межі один запит множив би оператори) | §4.1 — одне речення (задача 11) |
| В11 | `include` за лінивим `Ref` у списочній формі — `command.invalid` `reason: "lazy"` (той самий клас, що фільтр і сортування за лінивою колонкою, Рд25) | §4.1 — одне речення (задача 11) |
| В12 | `RuntimeConstraint.references` (колонки цілі FK) — потрібні будівнику для кореляції ТЧ за складеним FK скоупу | спека П4 §6.3 — у тому самому рядку Додатку А, що й `parentConstraint` (вносить задача 11) |

**Колляція локального стеку** (перевірено 2026-11-06 запитом задачі 11, крок 1,
на `supabase_db_simetra`): `datlocprovider = i` (ICU), `datlocale = en-US`,
`datcollate = datctype = en_US.UTF-8`, PostgreSQL 17.11.

---

## Карта файлів

| Файл | Що змінюється |
| --- | --- |
| `packages/simetra/src/model/runtime/errors.ts` | клас `CommandFailure`; код `command.timeout` |
| `packages/simetra/src/model/runtime/core.ts` | `ZERO_UUID` |
| `packages/simetra/src/model/runtime/read.ts` | запит другої форми, фільтр, сталі, типи результату |
| `packages/simetra/src/model/runtime/catalog.ts` | `operations` необов'язкові; `ref`, `load` реквізиту; `parentConstraint` ТЧ |
| `packages/simetra/src/model/runtime/module.ts` | `HookContext.read` — нова форма |
| `packages/simetra/src/model/schemas/attribute.ts`, `tabular-section.ts`, `rules.ts` | `load`; правило `attribute.lazy-not-allowed` |
| `packages/simetra/schemas/*.schema.json` | регенерація (`UPDATE_JSON_SCHEMAS=1`) |
| `packages/simetra/src/compiler/runtime-catalog.ts` | `ref`, `parentConstraint`, `load` |
| `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts`, `stages/model.ts` | правило `rights.carrier-lazy` |
| `packages/simetra/src/compiler/rights/functions.ts`, `holders.ts` | `ZERO_UUID` з T0 |
| `packages/simetra/src/server/read-filter.ts` (новий) | фільтр-дерево → SQL |
| `packages/simetra/src/server/read.ts` | будівник усіх форм, `prepareRead` |
| `packages/simetra/src/server/decode.ts` | `decodeLine`, `decodeCardRow` |
| `packages/simetra/src/server/runtime.ts` | `readRows` — оператори форми, `include`, `statement_timeout`, нова форма результату |
| `packages/simetra/src/server/hook-context.ts` | `ctx.read` — нова форма |
| `packages/simetra/src/server/errors.ts`, `phase.ts`, `index.ts` | без `CommandFailure`; `57014` читання; `operations?.` |
| `packages/simetra/src/server/__tests__/*` | `read.test.ts`, `read-filter.test.ts` (новий), `read-runtime.test.ts`, `hooks.test.ts`, `harness.ts`, `fixtures.ts` |
| `packages/simetra/test/tier-boundary.test.ts` | межа імпортів T4 |
| `packages/designer/src/tools/data-tools.ts`, `src/cli/render.ts` | `data-read` — нова форма |
| `packages/designer/src/__tests__/*` | `support/db.ts`, `command-runtime.db.test.ts`, `rights-admin-commands.db.test.ts`, `tenant-creation.db.test.ts`, `data-tools.db.test.ts`, `read-query.db.test.ts` (новий) |
| `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` | будівник `readQueryLayer()` |
| `packages/designer/skills/simetra-metadata/` | `data-read`, `ctx.read`, `load` |
| `docs/superpowers/specs/*`, `docs/ROADMAP.md` | правки Додатку А з блоком B1a |

---

### Task 1: `CommandFailure` і `ZERO_UUID` у T0, межа імпортів T4

**Files:**
- Modify: `packages/simetra/src/model/runtime/errors.ts`, `packages/simetra/src/model/runtime/core.ts`
- Modify (імпорти, перелік спеки §3 плюс перевірка `grep -rln "CommandFailure\|ZERO_UUID" packages/*/src` — імпорти бувають багаторядкові, тож шукати за файлом, а не за рядком `import`):
  `packages/simetra/src/server/{errors,runtime,phase,transaction,hook-context,decode,index}.ts`,
  `packages/simetra/src/server/__tests__/{errors.test,hooks.test,fake-database,decode.test}.ts`,
  `packages/simetra/src/compiler/rights/{functions,holders,explain-units,guard-units}.ts`,
  `packages/simetra/src/compiler/__tests__/rights-guards.test.ts`,
  `packages/designer/src/tools/data-tools.ts`,
  `packages/designer/src/__tests__/{support/db,command-runtime.db.test,rights-admin-commands.db.test}.ts`;
  `packages/designer/src/io/data.ts` — лише коментар, без змін коду.
- Test: `packages/simetra/test/tier-boundary.test.ts`

**Interfaces:**
- Produces: `CommandFailure` і `ZERO_UUID` з `simetra/model`; `simetra/server`
  більше не експортує `CommandFailure`.

- [ ] **Step 1: Write the failing tests** у `tier-boundary.test.ts`, у
  наявному `describe("tier zones")`:

```ts
// Межу data → server уже тримає `SERVER_MESSAGE`; кейс фіксує, що T4 бере
// клас саме з T0 і що імпорт із server лишається відмовою після переїзду.
it("data takes CommandFailure from model; from server it is refused", async () => {
  expect(
    await restricted(`import { CommandFailure } from "simetra/model"`, "src/data/__fixture.ts")
  ).toEqual([])
  const refused = await restricted(
    `import { CommandFailure } from "simetra/server"`,
    "src/data/__fixture.ts"
  )
  expect(refused).toHaveLength(1)
})

it("server no longer exports CommandFailure; model does", async () => {
  expect("CommandFailure" in (await import("simetra/server"))).toBe(false)
  expect(typeof (await import("simetra/model")).CommandFailure).toBe("function")
  expect((await import("simetra/model")).ZERO_UUID).toBe(
    "00000000-0000-0000-0000-000000000000"
  )
})
```

- [ ] **Step 2: Run, expect FAIL** —
  `pnpm --filter simetra test tier-boundary` (червоний кейс експорту; кейс
  межі зелений уже зараз — це фіксація, а не новий доказ).
- [ ] **Step 3: Move.** Клас `CommandFailure` (без змін тіла й JSDoc)
  переноситься в `model/runtime/errors.ts`; `ZERO_UUID` — у
  `model/runtime/core.ts` з JSDoc «UUID without a scope: the channel and the
  holder key of an unscoped object». Видалити оголошення зі старих місць і
  рядок `export { CommandFailure }` з `server/index.ts`. Усі споживачі
  імпортують із `simetra/model` (у `src/model` — відносно).
- [ ] **Step 4: Run** `pnpm --filter simetra test tier-boundary errors hooks decode rights-guards`
  і `pnpm typecheck` — PASS; `grep -rn "CommandFailure" packages/*/src | grep "server\""`
  — порожньо.
- [ ] **Step 5: Commit** — `refactor(model): CommandFailure і ZERO_UUID у T0 без реекспорту`.

---

### Task 2: запис каталогу лише для читання (Рд1)

**Files:**
- Modify: `packages/simetra/src/model/runtime/catalog.ts`, `packages/simetra/src/server/phase.ts`,
  `packages/designer/src/tools/data-policy.ts` (`?.operations?.create`)
- Test: `packages/simetra/src/model/runtime/__tests__/catalog.test.ts` (новий),
  `packages/simetra/src/server/__tests__/runtime.test.ts`

**Interfaces:**
- Produces: `RuntimeObject.operations?: { create?, update?, markDeletion?, delete? }`.

- [ ] **Step 1: Failing tests.** Unit T0: `runtimeCatalogSchema.parse` приймає
  об'єкт `sample` з `fixtures.ts` без поля `operations`. Unit T3
  (`runtime.test.ts`): каталог з таким об'єктом, `runtime.run(session,
  { action: "update", object: CLIENT, id: ID, expectedVersion: 1 })` →
  `CommandFailure` з `error` = `{ code: "command.invalid", path: "action" }`,
  `db.calls` після створення рантайму — порожній (до бази).
- [ ] **Step 2: Run, expect FAIL** —
  `pnpm --filter simetra test catalog.test runtime.test`.
- [ ] **Step 3: Implement.** `operations: z.strictObject({...}).optional()`;
  `superRefine` каталогу читає `object.operations?.create?.root`;
  `phase.ts`: `object.operations?.[op.action]`, `object.operations?.create?.root`.
  Пошукати інші звертання: `grep -rn "\.operations\b" packages/*/src`.
- [ ] **Step 4: Run** ті самі тести й `pnpm typecheck` (увесь репо: designer теж читає `operations`) — PASS.
- [ ] **Step 5: Commit** — `feat(model): запис каталогу рантайму лише для читання`.

---

### Task 3: поля каталогу `ref` і `parentConstraint`

**Files:**
- Modify: `packages/simetra/src/model/runtime/catalog.ts`, `packages/simetra/src/compiler/runtime-catalog.ts`,
  `packages/simetra/src/server/__tests__/fixtures.ts` (літерали ТЧ і FK отримують нові поля)
- Test: `packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts`,
  `packages/simetra/src/model/runtime/__tests__/catalog.test.ts`

**Interfaces:**
- Produces: `RuntimeAttribute.ref?: { object: string /* UUID цілі */; constraint: string }`;
  `RuntimeSection.parentConstraint: string`; `RuntimeConstraint.references?: string[]`
  (лише для `foreignKey`: колонки цілі в порядку `columns`) — будівник корелює
  ТЧ з власником за **усіма** колонками FK власника.
- Факт коду: FK скоупленої таблиці на ціль того самого виду скоупу —
  складений: `columns = [<скоуп>, <колонка>]`, `references = [<скоуп цілі>, <ключ>]`
  (`scopedKey()` у `compiler/stages/model.ts`; тести «same-kind reference is
  composite», «scoped tabular section row indexes the composite parent key»
  у `stage-scope-model.test.ts`). Простий FK мають лише нескоуплені таблиці,
  ТЧ кореня й `crossScope`.

- [ ] **Step 1: Failing tests** у `runtime-catalog.test.ts` на фікстурі з
  одноцільовим `Ref` на довідник (`refAttribute` з `fixtures/rights.ts`) і ТЧ:
  - реквізит одноцільового `Ref` на об'єкт має `ref` = `{ object: <id
    цілі в моделі>, constraint: <ім'я FK> }` — і для складеного FK того самого
    виду скоупу (`Task.region` з `defaults()` у `fixtures/rights.ts`), і для
    простого (нескоуплена ціль: `OrgMember.user` → «Користувачі»);
  - `ref` — лише для реквізитів логічного типу `Ref` (зокрема стандартних
    `parent`/`owner`, якщо їхній тип `Ref`); колонка скоупу (`UUID`) `ref` не
    має, хоч її FK і веде на корінь;
  - `Ref` на перерахування (`enumValues`), масив `Ref`, пара — без `ref`;
  - кожна ТЧ має `parentConstraint` = ім'я FK таблиці ТЧ на власника, зокрема
    складеного `(org_id, parent_id)` скоупленого `Gauge.lines`;
  - запис `foreignKey` у `constraints` несе `references`; схема каталогу
    (`superRefine`) відхиляє ТЧ, чий `parentConstraint` не називає
    `foreignKey` з `references` у `section.constraints`.
  Unit T0: схема відхиляє ТЧ без `parentConstraint` і `ref` без `constraint`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter simetra test runtime-catalog catalog.test`.
- [ ] **Step 3: Implement** у `attributes()` (лише для `type === "Ref"` без
  `enumValues`, `array` і пари): FK таблиці, чия **остання**
  колонка — `column.name`, а остання колонка `references.columns` — ключ
  цілі; ціль — таблиця моделі з `references.schema/table`, чий `origin` не
  має `tabularSectionId` і `part`; `ref.object` = `origin.objectId`. Без
  такого FK `ref` немає (масив і пара FK не мають). У ТЧ — FK, чия остання
  колонка — `section.parent`, на основну таблицю власника; відсутність —
  `must(...)` (внутрішня помилка: ТЧ ядра завжди має FK власника).
- [ ] **Step 4: Run** — PASS; `pnpm typecheck` і `pnpm metadata:check` — PASS.
- [ ] **Step 5: Commit** — `feat(compiler): ref цілі Ref і parentConstraint ТЧ у каталозі рантайму`.

---

> **Примітка виконання (прийнято архітекторкою, вплив на спеку — немає):**
> фікстура складеного FK — `Ticket.region` (`Task` — документ, поза каталогом);
> ціль поза каталогом — `TaskComment.task`.

### Task 4: лінивий атрибут — метадані, правила, каталог (Рд25)

**Files:**
- Modify: `packages/simetra/src/model/schemas/attribute.ts`, `tabular-section.ts`,
  `rules.ts`; `packages/simetra/src/model/runtime/catalog.ts`;
  `packages/simetra/src/compiler/{diagnostics,messages,runtime-catalog}.ts`,
  `packages/simetra/src/compiler/stages/model.ts`; `packages/simetra/schemas/*.schema.json`
- Test: `packages/simetra/src/model/__tests__/value-type.test.ts` або
  `kind-schemas.test.ts` (там, де вже тестують правила `attributeSchema`), `packages/simetra/src/compiler/__tests__/stage-model.test.ts`,
  `runtime-catalog.test.ts`, `messages.test.ts`

**Interfaces:**
- Produces: метадане `load?: "eager" | "lazy"` на реквізиті шапки (В3);
  `RuntimeAttribute.load?: "lazy"` (лише ефективно лінивий; ТЧ — ніколи);
  правило схеми `attribute.lazy-not-allowed`; правило компілятора
  `rights.carrier-lazy`.

- [ ] **Step 1: Failing tests** (одна таблиця `it.each` на правило):
  - схема: `load: "lazy"` на поліморфному `Ref` (`allowedTypes`) →
    issue `params.rule = "attribute.lazy-not-allowed"`, `path ["load"]`;
    `load: "lazy"` на реквізиті ТЧ (`tabularSectionSchema`) → те саме правило з
    шляхом до реквізиту; `registerFieldSchema` з `load` → невідомий ключ;
  - компілятор (`stage-model.test.ts`): `load: "lazy"` на реквізиті-носії прав
    (власність, вимір, контейнер — набір з `carrierDeclarations`
    `compiler/rights/facts.ts`) → `rights.carrier-lazy` з покажчиком на
    реквізит (`diagnosticBrief`);
  - «зміна `load` — подання»: дві моделі, що різняться лише `load`, дають той
    самий фізичний знімок і ті самі SQL ядра (`catalogCommands`) — рядок
    Додатку А «спека П2 … `load`»;
  - каталог: `Bytes` шапки без `load` → `load: "lazy"`; `Bytes` шапки з
    `load: "eager"` → без `load`; `Numeric` з `load: "lazy"` → `load: "lazy"`;
    `Bytes` у ТЧ → без `load`;
  - `messages.test.ts` — запис для `rights.carrier-lazy`.
- [ ] **Step 2: Run, expect FAIL** —
  `pnpm --filter simetra test attribute stage-model runtime-catalog messages`.
- [ ] **Step 3: Implement.** `attributeShape.load: z.enum(["eager","lazy"]).optional()`
  з `.meta({ description: "Whether list reads omit the attribute; default lazy for Bytes of the header." })`;
  refine пари в `attributeSchema` і `catalogAttributeSchema`; refine
  `tabularSectionSchema` над `attributes[i].load === "lazy"`. Ключ, версія й
  скоуп — стандартні атрибути без `load`, окремого правила не треба (тест
  пари й носія покриває решту Рд25). У каталозі ефективна лінивість —
  `load === "lazy" || (load === undefined && type === "Bytes")` лише для
  атрибутів шапки: `ElementSource` (`entity-fields.ts`) отримує `load?`, а
  `attributes()` — явний прапорець «шапка», бо її кличуть і для ТЧ
  (`RichText` ще немає серед `LOGICAL_TYPES`: його додасть
  окремий блок метаданих разом із тим самим типовим правилом); `load` доходить до `attributes()` через `field.element`.
  Регенерувати JSON-схеми:
  `UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`.
- [ ] **Step 4: Run** — PASS; `pnpm --filter simetra test json-schema` без
  змінної — PASS; `pnpm typecheck`, `pnpm metadata:check` — PASS. Скіл
  споживача (`packages/designer/skills/simetra-metadata/`, довідник
  реквізитів): `load` — коли й навіщо, типове для `Bytes`, заборони Рд25.
  Відоме обмеження: реквізити регістрів беруть ту саму `attributeSchema`, тож
  `load` там приймається й нічого не робить, доки регістри не ввійдуть у
  каталог (Рд1) — згадати в описі поля.
- [ ] **Step 5: Commit** — `feat(model): лінивий атрибут load і правила лінивості`.

---

> **Примітка виконання (прийнято архітекторкою, вплив на спеку — немає):**
> правило `rights.carrier-lazy` живе в `compiler/rights/checks.ts` (стадія 3
> діагностик не видає); реквізит регістра `load` не задає зовсім — правило
> схеми `attribute.load-not-allowed` (регістри поза каталогом, Рд1), а винятки
> ратчета полів для ТЧ і регістрів — «тримає схема».

### Task 5: фільтр-дерево T0 і його рендер T3

**Files:**
- Modify: `packages/simetra/src/model/runtime/read.ts` (лише додати; форма П4-A
  поки лишається — її замінює задача 6)
- Create: `packages/simetra/src/server/read-filter.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/read.test.ts` (новий),
  `packages/simetra/src/server/__tests__/read-filter.test.ts` (новий)

**Interfaces:**
- Produces (T0): `FILTER_OPERATORS`, `FilterOperator`, `Filter`,
  `FilterCondition { attribute: string; op: FilterOperator; value?: unknown }`,
  `filterSchema: z.ZodType<Filter>`, сталі `FILTER_IN_MAX = 200`,
  `FILTER_DEPTH_MAX = 8`, `FILTER_NODES_MAX = 64`.
- Produces (T3):

```ts
/** Колонка, за якою фільтрують: з каталогу, ніколи з запиту. */
export interface FilterColumn {
  name: string                // логічне ім'я в запиті
  column: string
  castType: string
  type: RuntimeAttribute["type"] | "Key" | "Version" | "Parent" | "LineNumber"
  attribute?: RuntimeAttribute // для encodeParam і пари
  lazy: boolean
}
export function renderFilter(
  filter: Filter,
  columns: ReadonlyMap<string, FilterColumn>,
  bind: (value: string | null, cast: string) => string,
  path: string                // "where"
): { sql: string } | { error: CommandError }
export function topLevelParentEq(filter: Filter | undefined, parentName: string): unknown | undefined
```

- [ ] **Step 1: Failing tests.**
  T0 (`read.test.ts`, таблиця): дерево глибини 9 і дерево з 65 вузлами —
  відмова; `{ and: [] }` — відмова; `in` з 201 значенням, `in: []`, `{ or: [] }`, `in` без масиву,
  `isNull` зі значенням, `eq` без `value` — відмова з шляхом до вузла;
  невідомий вузол `{ search: "x" }` і невідомий оператор — відмова **з
  шляхом до вузла** (`where.and.1`, `where.op`): суворий union Zod 4 дає
  `invalid_union` з порожнім `path`, тож гілку вузла обирає наявність ключа
  (`and`/`or`/`not`/`attribute`) до суворого розбору; тест через
  `prepareRead` задачі 6 повторює ці шляхи;
  дійсні дерева з кожним оператором — проходять.
  T3 (`read-filter.test.ts`, порівняння цілого SQL і `params`):
  - кожен оператор: `eq` → `"c" = $1::text`,     `isNull` → `"c" IS NULL`, `lt/lte/gt/gte`, `ne` → `"c" <> $1::…`;
  - `in` — **один параметр на елемент**: `"c" = ANY(ARRAY[$1::text, $2::text])`;
    елементи `NULL` (рядок), `a,b`, `"`, `}`, `\` доходять параметрами
    дослівно (таблиця); літерала масиву Postgres будівник не складає;
    стеля параметрів — ≤ 63 листки × 200 пар × 2 ≈ 25 200 і `include`
    16 × 200 = 3 200, нижче межі 65 535 протоколу;
  - `contains` зі значенням `50%_\` → `"c" ILIKE $1::text`, параметр
    `%50\%\_\\%`; `startsWith` → параметр `50\%\_\\%`;
  - пара: `eq { type: "Catalog.Project", id }` → дві рівності; `in` пар →
    диз'юнкція пар; `isNull` пари → дві `IS NULL`;
  - `and`/`or`/`not` — дужки за деревом;
  - відмови — `{ code: "command.invalid", path }` без виклику `bind`:
    невідоме ім'я (таблиця ворожих імен з Review Focus 1: `x"; DROP TABLE t; --`,
    `a.b`, `ctid`, `""`), `contains` для не рядкового типу, `lt` для
    `Json`/`Bytes`/масиву/пари, `eq`/`ne` з `null` (В5, `reason: "use-isNull"`), фільтр за лінивою
    колонкою (`lazy: true`), значення, що не проходить `encodeParam`
    (зокрема рядок з `\u0000`); шлях — `where.and.1.attribute` чи
    `where.value` за входом;
  - `topLevelParentEq`: `{ attribute: "owner", op: "eq", value: id }` і той самий
    вузол у кореневому `and` → `id`; під `or`, `not`, `in` → `undefined`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter simetra test read.test read-filter`.
- [ ] **Step 3: Implement.** `filterSchema` — `z.lazy` над union суворих
  об'єктів; глибина й кількість вузлів — `superRefine` кореня. Оператори за
  типом: `contains`/`startsWith` — `String`, `Text`; порівняння — скаляри,
  крім `Json`, `Bytes`, `Raw`, масиву й пари; `in` — скаляри й пара. Значення
  кодує наявний `encodeParam`/`encodePair` (`server/values.ts`,
  `model/runtime/values.ts`); `Key` і `Parent` — `uuid`, `LineNumber` і
  `Version` — ціле (`bigint`). Порівняння й `orderBy` — для тих самих
  скалярних типів (не `Json`, `Bytes`, `Raw`, масив, пара, лінивий). Екранування шаблону — `\` → `\\`, `%` → `\%`, `_` → `\_`
  (типовий `ESCAPE '\'` у `ILIKE`).
- [ ] **Step 4: Run** — PASS; `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** — `feat(server): фільтр-дерево запиту читання й рендер SQL`.

---

### Task 6: запит другої форми — об'єктні форми, нова форма результату й усі споживачі

Задача перемикає API: після неї форми П4-A немає. Форми з ТЧ і `include`
додають задачі 7 і 8, розширюючи ту саму схему.

**Files:**
- Modify: `packages/simetra/src/model/runtime/read.ts`, `module.ts`;
  `packages/simetra/src/server/{read,runtime,hook-context}.ts`
- Modify (споживачі): `packages/simetra/src/server/__tests__/{read.test,read-runtime.test,hooks.test,harness}.ts`;
  `packages/designer/src/tools/data-tools.ts`, `packages/designer/src/cli/render.ts`,
  `packages/designer/src/mcp/tools.ts`;
  `packages/simetra/src/model/__tests__/runtime-contracts.test.ts` (`where: {}`, `after`);
  `packages/designer/src/__tests__/{data-tools,mcp,cli}.test.ts`;
  `packages/designer/src/__tests__/{command-runtime,rights-admin-commands,tenant-creation,data-tools}.db.test.ts`;
  `packages/designer/skills/simetra-metadata/references/{agents-over-mcp,object-modules}.md`,
  `packages/designer/skills/simetra-metadata/SKILL.md` (опис, якщо згадує форму)
- Test: ті самі файли

**Interfaces:**
- Consumes: `renderFilter`, `FilterColumn` (задача 5), `RuntimeAttribute.load` (задача 4).
- Produces (T0):

```ts
export const READ_OFFSET_MAX = 10_000
export const READ_COUNT_CAP = 10_000
export const ORDER_BY_MAX = 4 // реквізитів, без ключа (В6)
export const orderBySchema // [{ attribute, direction: "asc"|"desc", nulls?: "first"|"last" }], 1..ORDER_BY_MAX + 1; ключ — лише останнім
export const readQuerySchema // union суворих форм:
//   { object, id }                                  — картка
//   { object, where?, orderBy?, offset?, limit }    — список
//   { object, where?, count: true }                 — лічильник
export type ReadQuery = z.infer<typeof readQuerySchema>
export interface ReadRows {
  rows: Record<string, unknown>[]
  included?: Record<string, Record<string, unknown>[]>
  ownerVersion?: number
}
export interface ReadCount { count: number; capped?: true }
export type ReadResult = ReadRows | ReadCount
export type ReadResultOf<Q> = Q extends { count: true } ? ReadCount : ReadRows
```

- Produces (T3): `CommandRuntime.read<Q extends ReadQuery>(session, query: Q): Promise<ReadResultOf<Q>>`;
  `HookContext.read<Q extends ReadQuery>(query: Q): Promise<ReadResultOf<Q>>`;
  `prepareRead(catalog, query)` → `{ object, plan: ReadPlan } | { error }`,
  де `ReadPlan` — внутрішній опис операторів форми (перший оператор, режим
  декодування), який виконують і `readRows`, і `ctx.read`.

- [ ] **Step 1: Failing tests** (`read.test.ts` — цілі оператори й `params`):
  - список без `orderBy`: `SELECT <проєкція> AS row FROM "s"."t" t ORDER BY "id" LIMIT $n`;
  - `orderBy` з `direction` і `nulls` → `ORDER BY "name" DESC NULLS LAST, "id"`;
    `orderBy`, що закінчується ключем, — ключ не дублюється (В4); ключ не
    останнім — `command.invalid` `orderBy.<i>`;
  - `offset` → `OFFSET $m`; `offset` 10 001, `limit` 201 і `orderBy` з 5 реквізитами без ключа — відмова схеми;
  - проєкція списку — `jsonb_build_object` явного переліку звичайних колонок
    (ключ, версія, реквізити без `load`, колонка типу пари, текстове
    приведення `numeric`/`bigint`), без `to_jsonb(t)` і без `COLLATE`;
  - «list omits a lazy text-encoded column»: `Numeric` з `load: "lazy"` немає
    ні серед колонок, ні серед приведень;
  - «a wide object projects in chunks»: об'єкт з 60 реквізитами →
    `(jsonb_build_object(<50 пар>) || jsonb_build_object(<решта>))::text`;
  - картка `{ object, id }` — повний рядок (`to_jsonb(t) || …` як зараз),
    `LIMIT 1`;
  - лічильник: `SELECT count(*) AS n FROM (SELECT 1 FROM "s"."t" t WHERE … LIMIT $n) c`
    з параметром `10001`; сортування за лінивим реквізитом чи масивом —
    `command.invalid` `orderBy.0.attribute`.
  `read-runtime.test.ts`: `read` повертає `{ rows }` для картки й списку,
  `{ count: 3 }`, `{ count: 10000 }` без `capped` для `n` = 10000 і
  `{ count: 10000, capped: true }` для `n` = 10001;
  кожна відмова (невідомий реквізит, лінивий фільтр, невалідна схема) —
  без жодного виклику порту після створення рантайму. `hooks.test.ts`:
  `ctx.read` повертає `{ rows }` і `{ count }`.
- [ ] **Step 2: Run, expect FAIL** —
  `pnpm --filter simetra test read.test read-runtime hooks`.
- [ ] **Step 3: Implement T0 і T3.** `readQuerySchema` — лише три об'єктні
  форми (П4-A видалити). У `read.ts` T3: мапа `FilterColumn` об'єкта
  (реквізити, `keyName` → `Key`, `versionName` → `Version`); `buildReadStatement`
  розбивається на функції форм; проєкція списку ріже пари на шматки по 50.
  `readRows` і `ctx.read` виконують `ReadPlan` і повертають `ReadRows`/`ReadCount`;
  версія з рядка — як зараз через `decodeRow`.
- [ ] **Step 4: Update consumers.**
  - `data-tools.ts`: вхід `{ query: readQuerySchema }` без змін імені;
    `DataReadData` і `summarizeData` (обидва в `data-tools.ts`) —
    `toJson(ReadResult)` | `{ error }`, підсумок `rows.length` чи `count`; опис інструмента
    англійською: "Reads rows under RLS: a card by id, a page by filter tree
    (`where`, `orderBy`, `offset`, `limit` up to 200) or a capped count.
    BigInt values come as decimal strings."
  - бюджет `tools/list` (`TOOLS_LIST_BUDGET` у `packages/designer/src/__tests__/mcp.test.ts`)
    перезаміряти за правилом коментаря файла (до/після) і оновити коментар;
    те саме в задачах 7 і 8, що розширюють схему входу.
  - designer DB-тести: асерти масиву → `{ rows: [...] }`; `where: {}` →
    форма без `where`; `where: { k: v }` → `{ attribute: "k", op: "eq", value: v }`;
    `after` → keyset-умова `gt` за ключем.
  - скіл: приклади `data-read` (`agents-over-mcp.md`) і опис `ctx.read`
    (`object-modules.md`) — нова форма з одним прикладом фільтра.
- [ ] **Step 5: Run** `pnpm --filter simetra test`, `pnpm --filter @simetrajs/designer test`,
  `pnpm typecheck`, `pnpm lint` — PASS; scoped DB:
  `pnpm --filter @simetrajs/designer test:db command-runtime data-tools tenant-creation rights-admin-commands` — PASS.
- [ ] **Step 6: Commit** — `feat(server): запит читання другої форми замість форми П4-A`.

---

### Task 7: `include` посилань

**Files:**
- Modify: `packages/simetra/src/model/runtime/read.ts`, `packages/simetra/src/server/{read,runtime,hook-context}.ts`,
  `packages/designer/src/tools/data-tools.ts` (опис), `packages/designer/src/__tests__/mcp.test.ts` (бюджет),
  `packages/designer/skills/simetra-metadata/references/agents-over-mcp.md`
- Test: `read.test.ts`, `read-runtime.test.ts`, `hooks.test.ts`

**Interfaces:**
- Consumes: `RuntimeAttribute.ref` (задача 3).
- Produces: `include?: string[]` (1…`INCLUDE_MAX` = 16 унікальних імен, В10) у формах картки й
  списку; `ReadRows.included` з ключем `"<kind>.<name>"` об'єкта цілі.

- [ ] **Step 1: Failing tests.** Будівник: другий оператор
  `SELECT <проєкція списку цілі> AS row FROM <ціль> t WHERE "id" = ANY(ARRAY[$1::uuid, …])`
  (параметр на id)
  на кожну ціль (два реквізити з тією самою ціллю — один оператор з
  об'єднаними id); id — унікальні, без `null`; без id — оператора немає, а
  `included` для цілі — `[]`. Відмови `command.invalid` `include.<i>`:
  реквізит без `ref`, ціль поза каталогом, дубль імені, лінивий `Ref` у
  списочній формі (`reason: "lazy"`, В11: колонки немає в проєкції, тож
  `included` мовчки був би порожнім). Рантайм: обидва
  оператори в одній транзакції до `COMMIT` (послідовність викликів порту
  з `harness.ts`); `ctx.read` з `include` — два `enqueue`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter simetra test read.test read-runtime hooks`.
- [ ] **Step 3: Implement** — `ReadPlan` отримує крок `include`, що будує
  оператор з декодованих рядків першого; оператор `include` — теж у фазі
  `read` (інакше `57014` там став би `command.internal`). `INCLUDE_MAX` —
  нова стала T0. Опис `data-read` і приклад скіла `agents-over-mcp.md` —
  з `include`; бюджет `tools/list` — перезамір.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck` і `pnpm --filter @simetrajs/designer test` — PASS.
- [ ] **Step 5: Commit** — `feat(server): include посилань у серверному читанні`.

---

### Task 8: ТЧ — картка з ТЧ, «ТЧ власника», сторінка й лічильник ТЧ

**Files:**
- Modify: `packages/simetra/src/model/runtime/read.ts`, `packages/simetra/src/server/{read,decode,runtime,hook-context}.ts`,
  `packages/designer/src/tools/data-tools.ts` (опис), `packages/designer/src/__tests__/mcp.test.ts` (бюджет),
  `packages/designer/skills/simetra-metadata/references/agents-over-mcp.md`
- Test: `read.test.ts`, `read.test.ts` T0, `decode.test.ts`, `read-runtime.test.ts`, `hooks.test.ts`

**Interfaces:**
- Produces (T0): `TABULAR_LINES_MAX = 5_000` (В2); форми

```text
{ object, id, tabularSections?: true | [<ТЧ>], include? }      — картка
{ object, tabularSection, owner }                              — «ТЧ власника»
{ object, tabularSection, where?, orderBy?, offset?, limit }    — сторінка ТЧ
{ object, tabularSection, where?, count: true }                — лічильник ТЧ
```

  Рядок картки з ТЧ: `{ ...шапка, tabularSections: { <ТЧ>: rows } }` (В1);
  «ТЧ власника» → `{ rows, ownerVersion? }`; сторінка ТЧ → `{ rows, ownerVersion? }`.
- Produces (T3): `decodeLine(section, record)` (виділено з `decodeRecord`),
  `decodeCardRow(object, json)`.

- [ ] **Step 1: Failing tests.**
  T0: `tabularSections` у списочній формі, `include` у формах ТЧ, порожній
  масив `tabularSections` — відмова схеми.
  Будівник (цілі оператори):
  - картка з ТЧ — **один** оператор: рядок власника з корельованим підзапитом
    на кожну ТЧ
    `(SELECT coalesce(jsonb_agg(<проєкція рядка> ORDER BY l."line_number", l."id"), '[]') FROM (SELECT * FROM <ТЧ> s WHERE s."parent_id" = t."id" ORDER BY s."line_number", s."id" LIMIT $k) l)`
    з `$k` = `5001`; кореляція — за **всіма** колонками FK власника
    (`s."org_id" = t."org_id" AND s."parent_id" = t."id"` для складеного
    FK; колонки — `parentConstraint` у `section.constraints` з `references`),
    інакше похідний індекс `(org_id, parent_id)` не працює; ТЧ ідуть
    **окремою колонкою результату** `tabular` (об'єкт за ім'ям таблиці ТЧ),
    а не ключем усередині JSON рядка — колонка власника з ім'ям `tabular` не
    затирається;
  - «ТЧ власника» — один оператор над рядком власника за ключем:
    `jsonb_build_object('<версія>', t."<версія>"::text, 'tabular', …)`;
  - сторінка ТЧ — `where` над `parentName`, `lineNumberName`, `keyName` і
    реквізитами ТЧ; типовий порядок — номер рядка, ключ; один рядок
    результату: `coalesce(jsonb_agg(x.r ORDER BY x.n), '[]')` над підзапитом з
    `row_number() OVER (<той самий ORDER BY>) AS n`; з `topLevelParentEq` —
    `owner_version` скалярним підзапитом до власника в тому самому операторі;
    для складеного FK власника рівність `parent` доповнюється рівністю
    скоупу з того самого підзапиту власника (індекс `(org_id, parent_id)`);
  - лічильник ТЧ: без межі лише за `topLevelParentEq`; з `or`, `in`, `not` над
    власником — межа 10 000 (таблиця кейсів).
  Рантайм і декодування: ТЧ з 5 001 рядком у відповіді → `command.invalid`
  `{ reason: "tabular-too-large", path: "<ТЧ>" }` без `rows`; невидимий
  власник (порожня відповідь) → `{ rows: [] }` без `ownerVersion`; видимий
  власник з порожньою ТЧ → `{ rows: [], ownerVersion: N }` — і для «ТЧ
  власника», і для сторінки ТЧ з `parent eq`; невідоме ім'я в
  `tabularSections`/`tabularSection` — `command.invalid` з `path`; `owner` не
  UUID — відмова схеми; рядок
  картки з ТЧ декодовано в `tabularSections`; рядок ТЧ несе `parentName` і
  `lineNumberName` (як у `decodeRecord`); `ctx.read` з тими самими формами.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter simetra test read.test read-runtime hooks decode`.
- [ ] **Step 3: Implement.** Проєкція рядка ТЧ — та сама функція явного
  переліку, що й списку (реквізити ТЧ лінивими не бувають). `decodeLine`
  виділити з `decodeRecord` без зміни поведінки команд. Перевірка межі —
  у T3 після декодування, до повернення. Опис `data-read` і скіл — форми
  ТЧ (одним прикладом «ТЧ власника»); бюджет `tools/list` — перезамір.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck` і `pnpm --filter @simetrajs/designer test` — PASS.
- [ ] **Step 5: Commit** — `feat(server): ТЧ у серверному читанні одним оператором з межею`.

---

### Task 9: `statement_timeout` читання й `command.timeout`

**Files:**
- Modify: `packages/simetra/src/model/runtime/errors.ts`, `packages/simetra/src/server/{runtime,errors}.ts`
- Test: `read-runtime.test.ts`, `errors.test.ts`, `harness.ts`

**Interfaces:**
- Produces: код `"command.timeout"` у `COMMAND_ERROR_CODES`;
  `CommandRuntimeOptions.readStatementTimeoutMs?: number` (ціле ≥ 1, типово
  `15_000`; 0 — відмова `createCommandRuntime`, бо вимкнув би межу).

- [ ] **Step 1: Failing tests.** `read-runtime.test.ts`: після `BEGIN`
  читання йде `SELECT set_config('statement_timeout', $1, true)` з
  параметром `"15000"` (і `"250"` з опцією); `readStatementTimeoutMs: 0` —
  відмова створення без I/O. `errors.test.ts`: `57014` у фазі `read` →
  `{ code: "command.timeout" }`; у фазі `write` і без фази — `command.internal` (В7).
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter simetra test read-runtime errors`.
- [ ] **Step 3: Implement.** Значення — зв'язаним параметром через
  `set_config`, не текстом `SET`. Фаза `read` ставиться до першого оператора
  будівника, як зараз. `ctx.read` у транзакції команди `statement_timeout`
  не ставить: межу часу команди дає бюджет часу B1b.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** — `feat(server): statement_timeout серверного читання і command.timeout`.

---

### Task 10: DB-кейси серверного читання

Причина DB-рівня: RLS, порядок колляції, `ILIKE`, атомарність одного
оператора під конкурентним комітом і `statement_timeout` вирішує Postgres;
порт-фейк цього не доводить. Один файл, одне розгортання, сценарії, а не
окремі кейси на кожен факт.

**Files:**
- Create: `packages/designer/src/__tests__/read-query.db.test.ts`
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts`
  (будівник `readQueryLayer()`), `packages/simetra/test/support.ts`
  (реекспорт), `packages/designer/src/__tests__/support/db.ts`
  (порт-інтерцептор), `packages/designer/src/__tests__/command-runtime.db.test.ts`
  (наявний тест інваріанта 10)

**Interfaces:**
- Produces: `readQueryLayer(): Layer` — `runtimeValuesLayer()` плюс
  одноцільовий `Ref` `site` на довідник `Region` з `crossScope: true` у
  `Gauge` (простий FK дає засіяти посилання на `Region` чужого скоупу —
  складений FK того самого виду це заборонив би); перший кейс перевіряє,
  що `Region` є в каталозі рантайму;
  без зміни наявних фікстур (наявні асерти на них не міняються).
  `beforeStatement(inner: CommandDatabase, hook: (index: number, text: string) => Promise<void>): CommandDatabase`
  у `support/db.ts` — кличе `hook` перед кожним оператором клієнта.

- [ ] **Step 1: Write the DB tests** (рантайм над тінню, як у
  `command-runtime.db.test.ts`; два актори двох скоупів):
  1. «second-form reads under RLS»: фільтр-дерево, `orderBy`, `offset`,
     `count` бачать лише рядки свого скоупу; `in` з елементами `a,b`, `NULL`,
     `"`, `\` знаходить рівно рядки з цими літералами; `contains`/`startsWith`
     зі значенням `50%_\` знаходять лише літерал і без урахування регістру;
     список не має `blob` (типово лінивий `Bytes`), картка — має;
  2. «include of an invisible target keeps the row»: `site` на `Region`
     чужого скоупу засіяно привілейованим з'єднанням тіні (ядро команди
     відхилило б невидиму ціль) — рядок є, `included["Catalog.Region"]` без цілі;
  3. «owner tabular section and card read one statement under a concurrent commit»:
     параметризовано індексом `i` оператора фази читання; кількість
     операторів заміряє пробний прогін через `beforeStatement` (а не стала в
     тесті), тож розщеплення на два оператори додає прогін і червоніє; кожен прогін — свіжа
     транзакція B (зміна `note` рядка ТЧ і `update` власника через
     `runtime.run`), яку `beforeStatement` комітить рівно перед оператором
     `i`; асерт кожного прогону — пара (`ownerVersion`, рядки ТЧ) або
     стара/стара, або нова/нова; видимий власник з порожньою ТЧ —
     `ownerVersion` є; невидимий — `{ rows: [] }` без `ownerVersion`;
  4. «tabular section over the limit is refused»: 5 001 рядок ТЧ (засів
     `generate_series` роллю власника) — `tabular-too-large` і для картки, і
     для «ТЧ власника»; сторінка ТЧ під RLS власника: чужий власник — порожньо;
  5. «order follows the column collation»: `orderBy` за `String` з рядками
     `"a"`, `"B"`, `"á"`, `"b"` дає той самий порядок, що
     `SELECT … ORDER BY <колонка>` під тими самими claims (без явного `COLLATE`);
  6. «read statement_timeout is command.timeout»: інша сесія тримає
     `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` (`heldResource`/`waitForLock`),
     читання з `readStatementTimeoutMs: 250` → `command.timeout`, транзакцію
     закрито, наступне читання проходить.
  У `command-runtime.db.test.ts` тест «runtime.read sees what a SELECT under
  the request role sees» доповнити запитами другої форми (фільтр `or`/`not`,
  `orderBy`, `count`): множина id `runtime.read` = множина `SELECT` під роллю
  запиту з тими самими claims, і запасний шлях дає те саме (інваріант 10).
- [ ] **Step 2: Run** —
  `pnpm --filter @simetrajs/designer test:db read-query command-runtime` — PASS
- [ ] **Step 3: Mutation check (обов'язковий).** Локально, без коміту,
  розщепити «ТЧ власника» на два оператори (версія власника окремо від
  рядків ТЧ) — кейс 3 червоніє на прогоні `i` = другий оператор; так само
  додати явний `COLLATE "C"` у `orderBy` — кейс 5 червоніє. Повернути код.
- [ ] **Step 4: Commit** — `test(designer): DB-кейси серверного читання другої форми`.

---

### Task 11: документація, колляція й фінальні гейти

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (рядки Додатку А з блоком B1a → «внесено (B1a)»),
  `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` (Рт13, Рт15,
  §6.3, §6.4, §6.10, §6.11, §6.16 — за рядками Додатку А з блоком B1a),
  `docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md` (`load`),
  `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (Р30),
  `docs/superpowers/specs/2026-10-23-provider-profiles-design.md` (ПП2),
  `docs/ROADMAP.md` (рядок П4: B1a виконано)

- [ ] **Step 1: Колляція (В8).** Повторити запит на локальному стеку
  (`pnpm db:start`, лише читання):

```sql
SELECT datname, datlocprovider, datlocale, datcollate, datctype,
       current_setting('server_version') AS version
FROM pg_database WHERE datname = current_database();
```

  Якщо значення відрізняються від записаних у розділі «Рішення архітекторки» —
  зупинитися й доповісти архітекторці. Речення §4.2 про колляцію і пункт
  колляції в рядку «Хостований Supabase» спеки П4 §9 внесено разом із планом
  (рядок Додатку А П4-B «внесено (B1a)»).
- [ ] **Step 2: Правки спек** — рядок у рядок за Додатком А (колонка «Блок» =
  B1a, зокрема B1a-частини змішаних рядків §6.3 і §6.10), плюс відповіді
  архітекторки на В1–В7. Старий текст форми П4-A в §6.11 спеки П4 замінити
  посиланням на §4.1–§4.2 П4-B, не дублюючи її.
- [ ] **Step 3: Anchors** — `python3 scripts/check-doc-anchors.py` — без
  помилок.
- [ ] **Step 4: Гейти блоку**:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm metadata:check
pnpm test:db
pnpm build:packages && pnpm test:packaging   # змінено публічні експорти simetra/model і simetra/server
```

  Очікування: усе зелене; `test:db` — один повний прогін на блок, без
  паралельної сесії, що редагує checkout.
- [ ] **Step 5: Commit** — `docs(spec): П4-B1a — правки Додатку А, колляція бази, ROADMAP`.

---

## Готово (спека §13, рядок B1a)

- unit T0 (запит, фільтр, запис лише для читання), T1 (правила лінивості,
  `ref`, `parentConstraint`) і T3 (будівник, відмови до порту) — зелені;
- DB-кейси серверного читання, «ТЧ власника» з конкурентним комітом і
  еквівалентності множини рядків — зелені;
- DB-тест designer: MCP `data-read` читає новою формою;
- колляцію локального стеку записано в §4.2; перевірку хостованої — у рядку спеки П4 §9 (В8);
- `grep -rn "after:" packages/simetra/src/model/runtime/read.ts` і
  `grep -rn "CommandFailure" packages/simetra/src/server/index.ts` — порожньо.

## Підсумок аудиту плану

- **Раунд 1** — два незалежні аудитори (Opus): лінза «покриття й вірність
  спеці» і лінза «правда проти коду, SQL і безпека». Знайдено 2 blocker
  (складені FK скоупу ламали `parentConstraint` і `ref`) і 9 major (кодування
  масиву `in`, шлях невідомого вузла фільтра, бюджет `tools/list`, неповні
  переліки файлів і червоний typecheck між задачами, неоднозначний
  конкурентний DB-кейс, `ownerVersion` порожньої ТЧ, індекс ТЧ за складеним
  FK). Усі виправлено.
- **Раунд 2** — один аудитор (Opus) на дифф виправлень: blocker і
  безпекових major — 0; 5 minor виправлено (тип-фільтр `ref`, `superRefine`
  `parentConstraint`, засів кейсу `include`, переліки файлів задач 7–8, В12).
- **Codex** (`gpt-6-sol`, замороженe дерево) — 2 знахідки з позначкою
  security major; автор перевірив обидві й не прийняв як major для B1a:
  1. «значення фільтра без межі розміру» — у B1a немає браузерного входу:
     `createDataHandler` і межу тіла (`payload-too-large`, Рд26) вводить
     B1b; викликачі `runtime.read` — довірений серверний код host-а й MCP над
     базою розробника; екранування лінійне;
  2. «`ctx.read` без `statement_timeout`» — хук — довірений код застосунку в
     транзакції команди, яка вже зараз не має межі часу на жоден оператор
     хука; бюджет часу перед кожним оператором — B1b (§13). B1a вади не вводить.
  Архітекторка прийняла обидва відхилення; пункти — у брифі автора B1b.
- **Підсумок:** blocker — 0, безпекових major — 0.
