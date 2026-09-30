# П2, план B — ідентичність, типи, реєстр видів, каркас компілятора: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** метамодель T0 з UUID, логічними й фізичними іменами, повним
фізичним описом `CustomTable` і `PgEnum`, розширеною системою типів і
реєстром видів. Над нею — каркас компілятора T1: чиста функція над мапою
файлів, що проганяє стадії 1–3 і частину стадії 4, повертає діагностику з
кодами правил, індекс посилань і структурований фізичний знімок.

**Архітектура:** T0 (`packages/simetra/src/model`) тримає Zod-схеми файлів,
реєстр видів (одне місце знань про вид), контракт фізичного знімка,
відображення логічних типів на Postgres і алгоритм імен обмежень Postgres.
T1 (`packages/simetra/src/compiler`) тримає `compile(files)` і стадії. Файли
прототипу, що дублюють ці знання (`metadata-io`, `serialization`,
`find-references`, `standard-attributes`, `physical-naming`,
`validation-message`, форми), видаляються в тій самій зміні, яка їх замінює.

**Технології:** TypeScript 7, Zod 4 (`zod` — єдина runtime-залежність T0),
Vitest 5, ESLint 10 (+ `@typescript-eslint/no-restricted-imports`).

**Спека:** [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md) —
§3 (ідентичність, імена, файли), §4 (`CustomTable`, `PgEnum`, типи), §5
(види, стандартні реквізити, «тип + id», перерахування, константа), §8.1–§8.4
(реєстр, стадії, знімок, діагностика), §11 кроки 2–4;
[платформна спека](../specs/2026-09-24-simetra-platform-design.md) §3.1, §3.4.

**Серія планів П2:** A (виконано) → **B** (цей) → C (скоуп; документ,
проведення, регістри) → D (хеш, JSON Schema, кодоген, `@simetra/cli`, MCP,
pre-commit) → E (`SchemaEngine`, рендер, тінь, round-trip, домен, паперовий
тест).

## Рішення плану (архітектор, узгоджено з архітектором спеки)

Спека їх не фіксує дослівно; вони — наповнення прогалин, а не відхилення:

1. **Файл → діагностика.** Діагностика з кодами правил вводиться тут, тож
   `validation-message.ts` видаляється вже в B (спека §11 крок 7 — момент
   завершення CLI, а не заборона). Каталог повідомлень — лише en; uk,
   рядок/колонка (jsonc-parser) і `--format json` — план D.
2. **`title`, а не `displayName`** (платформна спека §4, П2 §3); одноразова
   міграція прототипних даних, без шиму.
3. **`id` і `physicalName` у Zod-схемах опційні**, а їх відсутність — помилка
   стадії 2 з підказкою `simetra fix` (спека §3): так файл без id дає
   діагностику з правилом, а не сиру помилку Zod.
4. **Налаштування видів прототипу лишаються** (`autonumber`,
   `mainPresentation`, `predefinedItems`, `standardAttributeOverrides` тощо);
   поле без споживача прибере ратчет плану D. Виняток — `CustomTable`, у якої
   не лишається нічого похідного (`autoAddPrimaryKey`,
   `standardAttributeOverrides` зникають, спека §4).
5. **Фізичні імена стандартних реквізитів — імена прототипу** (спека §5),
   зокрема `parent_id` рядка ТЧ; ключ і таблиці регістрів (PK, унікальність,
   виміри `NOT NULL`, підсумки) — план C (крок 6), тут лише колонки.
6. **Скомпільований об'єкт у B несе розібрані дані з логічними посиланнями +
   індекс резолвлених посилань** (`from` файл і pointer → `to` UUID).
   Канонічний знімок «лише з UUID» для хешу будує план D з того самого індексу.
7. **Порядок стадій:** 1–2 — завжди над усіма файлами; 3–4 — лише якщо 1–2 без
   помилок. Компілятор повертає всі діагностики прогону, що відбувся.

## Global Constraints

- T0 (`src/model`) у не-тестовому коді імпортує лише `zod`, власні відносні
  модулі й `simetra/model`; T1 (`src/compiler`) не імпортує Node API (спека §8.2:
  компілятор — чиста функція, диск читає CLI). Тримає лінт (задача 1).
- UUID метаданих — v4 (спека §3); у тестах — фіксовані v4-рядки.
- Логічні імена: об'єкти й `PgEnum` — PascalCase `^[A-Z][A-Za-z0-9]*$`;
  реквізити, виміри, ресурси, ТЧ, колонки `CustomTable` — за
  `project.naming.attributeCase`: `camelCase` `^[a-z][a-zA-Z0-9]*$` (за
  замовчуванням) або `snake_case` `^[a-z][a-z0-9_]*$` (спека М16).
- `physicalName` — непорожній рядок ≤ 63 байт UTF-8; SQL-зарезервоване слово —
  попередження, не помилка (спека §3).
- Фізичний знімок: типи колонок у формі `format_type()` Postgres, вирази —
  текстом, похідні імена обмежень та індексів — алгоритм Postgres (задача 5).
- Детермінізм: той самий вхід → побайтно той самий `JSON.stringify(result)`.
- Тексти діагностики — англійською; коментарі — українською, «чому».
- Без шимів: замінене видаляється в тій самій задачі (`AGENTS.md` принцип 5).
- Коміти — Conventional Commits, опис українською, без трейлерів.
- Гейти після кожної задачі: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`;
  після правки доків — `python3 scripts/check-doc-anchors.py`.

## Review Focus

1. **Довге ім'я таблиці чи колонки** (> 63 байт разом із суфіксом, кирилиця в
   логічному імені не буває, але UTF-8 у фізичному — буває): ім'я обмеження
   мусить збігтися з тим, яке дав би Postgres, інакше план E покаже
   «перейменування». Тести — задача 5.
2. **Два реквізити з різними логічними, але однаковими фізичними іменами**, чи
   реквізит, фізичне ім'я якого збігається зі стандартним (`deletion_mark`),
   чи дві цілі поліморфного `Ref` з однаковим `physicalName` у різних
   PG-схемах. Тести — задача 8.
3. **Файл у чужій теці** (`kind: "Document"` у `catalogs/`), тека й ім'я
   файлу не збігаються з `name`, `.sql` без `.meta.json` поруч, файл поза
   відомою розкладкою. Тести — задача 7.
4. **Зламане посилання за іменем і посилання на вид, на який посилатися
   не можна** (регістр, константа), `Ref` на `CustomTable` зі складеним чи
   не-uuid ключем. Тести — задачі 7–8.
5. **Порядок вхідних файлів у мапі** (інший порядок `Map`) не змінює ні
   діагностику, ні знімок. Тест — задача 8.

---

### Task 1: Лінт-межі чистоти T0 і T1 (беклог рев'ю плану A)

**Files:**
- Modify: `packages/simetra/eslint.tier-zones.js`
- Modify: `packages/simetra/test/tier-boundary.test.ts`
- Modify: `.agents/skills/code-review/references/simetra-domain-criteria.md` (рядок «core stays pure»)

**Interfaces:**
- Produces: `tierZoneConfigs` додатково містить блоки чистоти з правилом
  `@typescript-eslint/no-restricted-imports` (окреме правило, тож його опції не
  затирають ярусну зону `no-restricted-imports`); глоби всіх зон —
  `{ts,tsx,mts,cts}`.

- [ ] **Step 1: Негативні тести**

У `tier-boundary.test.ts` допиши helper `purity(code, file)` — як
`restricted`, але фільтр `ruleId === "@typescript-eslint/no-restricted-imports"`.
Тести:
1. `model imports only zod` — у `src/model/__fixture.ts` порожньо для `zod`,
   `zod/v4`, `./local`, `../model/x`; рівно 1 повідомлення з `"T0 purity"` для
   `react`, `node:fs`, `fs`, `@supabase/supabase-js`, `jsonc-parser`.
2. `model tests may use node` — `node:fs` у `src/model/__tests__/__fixture.ts`
   дає порожньо.
3. `compiler uses no node api` — у `src/compiler/__fixture.ts` 1 повідомлення з
   `"T1 purity"` для `node:fs`, `node:path`, `fs`, `path`, `node:crypto`;
   порожньо для `zod`; у `src/compiler/__tests__/__fixture.ts` `node:fs` —
   порожньо.
4. `mts and cts are covered` — `importOf("simetra/compiler")` у
   `src/model/__fixture.mts` і `src/model/__fixture.cts` дає 1 повідомлення
   ярусної зони.

- [ ] **Step 2: Прогнати — червоні**

Run: `pnpm --filter simetra test tier-boundary`
Expected: FAIL у нових кейсах 1, 3, 4.

- [ ] **Step 3: Реалізація в `eslint.tier-zones.js`**

- Глоби зон → `src/<tier>/**/*.{ts,tsx,mts,cts}`.
- Блок `files: ["src/model/**/*.{ts,tsx,mts,cts}"]`, `ignores: ["**/__tests__/**"]`,
  правило `@typescript-eslint/no-restricted-imports` з
  `patterns: [{ regex: "^(?!zod(?:/|$)|\\.|simetra/model(?:/|$))", message: "T0 purity: src/model imports only zod at runtime (AGENTS.md, metamodel rules)." }]`.
- Блок для `src/compiler/**`, ті самі `ignores`, `regex: "^(?:node:|(?:fs|path|os|crypto|url|child_process)(?:/|$))"`,
  message `"T1 purity: the compiler is a pure function over a file map; disk access belongs to the CLI (P2 spec §8.2)."`.
- Коментар над блоками — чому окреме правило (flat config замінює опції
  правила цілком) і чому тести виключено (правило `AGENTS.md`: тести можуть
  читати фікстури Node API).

- [ ] **Step 4: Зелені**

Run: `pnpm --filter simetra test tier-boundary && pnpm --filter simetra lint`
Expected: PASS; лінт чинного коду чистий.

- [ ] **Step 5: Канон**

У `simetra-domain-criteria.md` рядок «core stays pure» переписати: T0
`simetra/model` без runtime-залежностей, крім `zod`, і без Node API у
не-тестовому коді — тримає лінт `packages/simetra/eslint.tier-zones.js`;
рецензент шукає обхід (динамічний `import()`, нову залежність у
`packages/simetra/package.json`, яку імпортує T0). Якір — `packages/simetra/eslint.tier-zones.js`.

Run: `python3 scripts/check-doc-anchors.py && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`

- [ ] **Step 6: Commit**

```bash
git add packages/simetra/eslint.tier-zones.js packages/simetra/test/tier-boundary.test.ts .agents/skills/code-review/references/simetra-domain-criteria.md
git commit -m "feat(simetra): лінт-межі чистоти T0 (лише zod) і T1 (без Node API)"
```

---

### Task 2: Ідентичність, імена, система типів, реквізит (T0)

**Files:**
- Create: `packages/simetra/src/model/schemas/identity.ts`, `value-type.ts`, `rules.ts`
- Test: `packages/simetra/src/model/__tests__/value-type.test.ts`, `identity.test.ts`

Задача лише **додає** модулі поруч із прототипними: старі схеми, IO й
`validation-message.ts` компілюються далі, а перемикання на нові модулі й
видалення старих — задача 3. Так кожна задача закінчується зеленими гейтами.

**Interfaces:**
- Produces (експорт з `simetra/model`):
  - `metadataIdSchema` — `z.uuid({ version: "v4" })`; `type MetadataId = string`.
  - `objectNameSchema` (PascalCase), `elementNameSchema` (`^[A-Za-z][A-Za-z0-9_]*$` —
    стиль перевіряє стадія 2), `physicalNameSchema` (1..63 байт UTF-8).
  - `ATTRIBUTE_CASES = ["camelCase", "snake_case"] as const`,
    `matchesAttributeCase(name: string, style: AttributeCase): boolean`,
    `toSnakeCase(name: string): string` (перенесено з `physical-naming.ts`).
  - `isSqlReservedWord` (без змін, `schemas/sql-reserved-words.ts`).
  - `LOGICAL_TYPES = ["UUID","String","Text","Integer","SmallInt","BigInt","Numeric","Boolean","Date","DateTime","Bytes","Json","Ref"] as const`, `type LogicalType`.
  - `valueTypeShape` — Zod-поля типу, спільні для реквізиту, константи й колонки:
    `type`, `length?`, `precision?`, `scale?`, `ref?: MetadataRef`,
    `allowedTypes?: MetadataRef[]`, `array?: boolean`; і
    `refineValueType(value, ctx)` — перевірки нижче.
  - `type ValueType = z.infer<z.ZodObject<typeof valueTypeShape>>`.
  - `SCHEMA_RULES` (масив рядків-кодів) і `type SchemaRule`: кожна власна
    перевірка T0 додає `ctx.addIssue({ code: "custom", message: <en>, path, params: { rule: <SchemaRule> } })`.
    Коди задачі 2: `type.length-required`, `type.length-not-allowed`,
    `type.precision-not-allowed`, `type.scale-requires-precision`,
    `type.ref-target-required`, `type.ref-exclusive`, `type.ref-not-allowed`;
    задачі 3–4 дописують свої.
  - `valueTypeShape.ref` / `allowedTypes` мають форму `{ kind: string, name: string }`
    (`MetadataRef` із задачі 3 переходить на неї без зміни форми).
- Consumes: —

- [ ] **Step 1: Тести типів і імен**

`value-type.test.ts` (схема для тесту — `z.object(valueTypeShape).superRefine(refineValueType)`):
- `String requires length` → issue з `params.rule === "type.length-required"`;
- `length only for String` → `"type.length-not-allowed"`;
- `Numeric accepts no precision` (`{ type: "Numeric" }` валідний);
- `scale requires precision` → `"type.scale-requires-precision"`;
- `precision only for Numeric` → `"type.precision-not-allowed"`;
- `Ref needs exactly one of ref and allowedTypes` → `"type.ref-target-required"` і `"type.ref-exclusive"`;
- `ref only for Ref` → `"type.ref-not-allowed"`;
- `array flag accepted for every logical type` (кожен з `LOGICAL_TYPES` з мінімальними параметрами + `array: true`);
- `Binary is gone` — `{ type: "Binary" }` невалідний, `{ type: "Bytes" }` валідний.

`identity.test.ts`:
- `metadataIdSchema` приймає `"3f0c2a7e-1b2d-4c3e-9f4a-5b6c7d8e9f01"`, відхиляє не-v4 і не-uuid;
- `physicalNameSchema` відхиляє `""` і рядок із 64 байт (`"ї".repeat(32)` = 64 байти), приймає 63-байтовий;
- `matchesAttributeCase("deletionMark","camelCase") === true`, `("deletion_mark","camelCase") === false`, `("deletion_mark","snake_case") === true`, `("DeletionMark","snake_case") === false`;
- `toSnakeCase` — кейси з чинного `physical-naming.test.ts` (перенеси їх сюди).

- [ ] **Step 2: Прогнати — червоні**

Run: `pnpm --filter simetra test value-type identity`
Expected: FAIL (модулів немає).

- [ ] **Step 3: Реалізація**

Створи `identity.ts`, `value-type.ts`, `rules.ts` за Interfaces. `toSnakeCase`
тут — копія, оригінал у `physical-naming.ts` видаляє задача 6.

- [ ] **Step 4: Зелені**

Run: `pnpm --filter simetra test value-type identity && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: усе зелене.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/model
git commit -m "feat(model): UUID-ідентичність, логічні й фізичні імена, розширена система типів"
```

---

### Task 3: Схеми файлів видів 1С і проєкту; видалення форм і прототипного IO (T0)

**Files:**
- Modify: `schemas/attribute.ts`, `tabular-section.ts`, `metadata-ref.ts`, `metadata-kind.ts`, `catalog.ts`, `document.ts`, `enumeration.ts`, `constant.ts`, `information-register.ts`, `accumulation-register.ts`, `project.ts`, `schemas/index.ts`, `model/index.ts`, `posting-compatibility.ts` (лише імпорти/типи)
- Delete: `schemas/field-type.ts`, `schemas/technical-name.ts`, `schemas/physical-naming.ts` і `__tests__/physical-naming.test.ts` (префікси видів зникають — `physicalName` тепер явний; `toSnakeCase` уже в `identity.ts`), `validation-message.ts`, `schemas/form.ts`, `autoform.ts`, `schemas/project-model.ts`, `metadata-io.ts`, `serialization.ts`, `find-references.ts`, їхні тести (`autoform.test.ts`, `metadata-io.test.ts`, `find-references.test.ts`), форм-блоки й фікстури в `schemas.test.ts` та `__tests__/fixtures/`, рядок фікстур у `.prettierignore`
- Test: `packages/simetra/src/model/__tests__/kind-schemas.test.ts` (замість `schemas.test.ts`; перенеси з нього кейси, що лишаються чинними)

**Interfaces:**
- Consumes: задача 2.
- Produces:
  - `METADATA_KINDS = ["Catalog","Document","Enumeration","InformationRegister","AccumulationRegister","Constant","CustomTable","PgEnum"] as const`, `metadataKindSchema`, `metadataRefSchema` `{ kind, name }`;
    `referenceableKindSchema` і `attributeRefTargetSchema` зникають: «на вид
    можна посилатися» — факт реєстру (задача 6), перевірка — стадія 4 (задача 8).
  - `attributeSchema`: `{ id?, name: elementNameSchema, physicalName?, title?, description?, ...valueTypeShape, required=false, indexed=false, unique=false, defaultValue?: string | number | boolean }` з `refineValueType`.
  - `tabularSectionSchema`: `{ id?, name, physicalName?, title?, standardAttributeOverrides?, attributes=[] }`.
  - Спільна «шапка» об'єкта `objectHeaderShape`:
  `{ $schema?: string, id?: MetadataId, kind, name: objectNameSchema, physicalName?, schema?: string (PG-схема; за замовчуванням — проєкту), title?: LocalizedString, description?: LocalizedString }`.
  Схеми видів (поля налаштувань — як у прототипі, з поправками):
  - `catalogSchema`: `codeLength` і `descriptionLength` — `int ≥ 0` (0 — реквізиту немає, М3), решта налаштувань без змін; `attributes`, `tabularSections`.
  - `documentSchema`: без змін налаштувань; `posting?`, `registerMovements: MetadataRef[]`.
  - `enumerationSchema`: `values: { id?, name: objectNameSchema, physicalName? (фізична мітка), title? }[]`; поле `order` зникає — порядок = порядок масиву (спека §5).
  - `constantSchema`: окремий об'єкт — шапка + `...valueTypeShape` (усі логічні типи, зокрема `Ref`) + `defaultValue?`; `constantsFileSchema` зникає.
  - `informationRegisterSchema`, `accumulationRegisterSchema`: налаштування без змін; `dimensions`, `resources`, `attributes` — `attributeSchema`; ресурси регістра накопичення — лише `Integer` або `Numeric` (правило `register.resource-type`).
  - `projectSchema`: `{ $schema?, name, title?, defaultLocale: "uk"|"en" = "uk", defaultSchema: string = "public", naming: { attributeCase: AttributeCase = "camelCase" } = {} }`; блоки `database`, `generation`, `deployment`, `schemaVersion` зникають (спека §3).
  - Жодна схема не перевіряє унікальність імен у масивах — це стадія 2 з pointer на дублікат.

- [ ] **Step 1: Тести схем видів**

`kind-schemas.test.ts` — по `describe` на вид, мінімальний валідний об'єкт
кожного виду (без `id`/`physicalName` — вони опційні) плюс:
- `catalog accepts codeLength 0 and descriptionLength 0`;
- `enumeration keeps value order` — порядок `values` після парсингу збігається з вхідним, а в розібраному значенні немає ключа `order` (невідомі ключі файлу ловить ратчет плану D);
- `constant accepts Ref value type` (`{ type: "Ref", ref: { kind: "Catalog", name: "Currency" } }`);
- `accumulation register resource must be Integer or Numeric` → issue `params.rule === "register.resource-type"` для `String`;
- `project defaults` — `projectSchema.parse({ name: "Demo" })` дорівнює `{ name: "Demo", defaultLocale: "uk", defaultSchema: "public", naming: { attributeCase: "camelCase" } }`;
- `project has no generation block` — `projectSchema.shape` не має ключів `generation`, `deployment`, `database`.

- [ ] **Step 2: Прогнати — червоні**

Run: `pnpm --filter simetra test kind-schemas`
Expected: FAIL.

- [ ] **Step 3: Реалізація й видалення**

Перепиши схеми видів і проєкту; видали перелічене у Files. У
`schemas/standard-attributes.ts` (його замінює реєстр у задачі 6) додай лише
гілку `case "PgEnum": return []`, щоб вичерпний `switch` компілювався. У
`posting-compatibility.ts` заміни `createValidationMessage(...)` на звичайний
англійський текст причини (модуль переробляє план C). `model/index.ts`
експортує `./schemas` і `posting-compatibility`; `.prettierignore` — прибери
рядок фікстур серіалізації.

- [ ] **Step 4: Гейти**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: зелене.

- [ ] **Step 5: Commit**

```bash
git add -A packages/simetra .prettierignore
git commit -m "feat(model): схеми видів з ідентичністю й title; видалено форми, прототипний IO і validation-message"
```

---

### Task 4: `CustomTable` — повний фізичний опис; `PgEnum` (T0)

**Files:**
- Modify: `schemas/custom-table.ts`
- Create: `schemas/pg-enum.ts`
- Test: `packages/simetra/src/model/__tests__/custom-table.test.ts`

**Interfaces:**
- Consumes: задачі 2–3 (`objectHeaderShape`, `valueTypeShape`, `metadataRefSchema`).
- Produces:
  - `customTableColumnSchema`: `{ id?, name: elementNameSchema, physicalName?, title?, notNull = false, default?: string (SQL-вираз), identity?: "always" | "byDefault", comment?: string }` плюс рівно одне з:
    логічний тип `...valueTypeShape`; `{ type: "PgEnum", enum: MetadataRef, array? }`;
    `{ type: "Raw", pgType: string }` (сирий PG-тип — лише тут, спека §4).
  - `customTableSchema`: шапка + `scope?` (форма — план C; тут не оголошувати),
    `comment?: string`, `columns` (min 1),
    `primaryKey?: { name?: string, columns: string[] }`,
    `uniques: { name?, columns: string[], nullsNotDistinct = false }[] = []`,
    `checks: { name?, expression: string }[] = []`,
    `foreignKeys: { name?, columns: string[], references: { object: MetadataRef, columns: string[] } | { external: { schema: string, table: string, columns: string[] } }, onDelete = "noAction", onUpdate = "noAction", deferrable = "no" }[] = []`
    (`FkAction = "noAction"|"restrict"|"cascade"|"setNull"|"setDefault"`,
    `deferrable: "no"|"deferrable"|"initiallyDeferred"`),
    `indexes: { name?, unique = false, method = "btree", keys: ({ column: string } | { expression: string })[], include: string[] = [], where?: string, nullsNotDistinct = false }[] = []`.
    Колонки в обмеженнях — **логічні** імена колонок таблиці; у `references.object`
    — логічні імена колонок цілі (для виду 1С — логічні імена стандартних
    реквізитів, напр. `ref`); у `external` — фізичні.
    `name` обмеження опційне: відсутнє — ім'я за алгоритмом Postgres
    (задача 5); зворотний генератор (план E) пише імена явно.
  - `pgEnumSchema`: `{ $schema?, id?, kind: "PgEnum", name, physicalName?, schema?, title?, values: string[] (min 1) }`; значення без UUID — вони фізичні мітки (спека §4).
- Власні правила: `customTable.column-type` (колонка без типу чи з двома формами),
  `customTable.identity-type` (identity лише для `SmallInt`/`Integer`/`BigInt`),
  `pgEnum.value-duplicate`.

- [ ] **Step 1: Тести**

`custom-table.test.ts`:
- `accepts table without primary key`;
- `accepts composite primary key and composite foreign key with actions` (`onDelete: "cascade"`, `deferrable: "initiallyDeferred"`);
- `accepts external foreign key to auth.users` (`{ external: { schema: "auth", table: "users", columns: ["id"] } }`);
- `accepts partial, expression and nulls-not-distinct indexes` (`keys: [{ expression: "lower(email)" }]`, `where: "deleted_at IS NULL"`, `nullsNotDistinct: true`);
- `accepts identity always on BigInt`; `rejects identity on Text` → `customTable.identity-type`;
- `accepts PgEnum column by reference` (`{ type: "PgEnum", enum: { kind: "PgEnum", name: "OrderStatus" } }`);
- `accepts Raw pgType`; `rejects Raw together with length` → `customTable.column-type`;
- `pgEnum keeps value order`; `pgEnum rejects duplicate values` → `pgEnum.value-duplicate`;
- `custom table has no derived settings` — `customTableSchema.shape` не має `autoAddPrimaryKey`, `standardAttributeOverrides`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test custom-table` → FAIL.

- [ ] **Step 3: Реалізація** — схеми за Interfaces.

- [ ] **Step 4: Зелені** — той самий прогін PASS; далі повні гейти.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/model
git commit -m "feat(model): CustomTable з повним фізичним описом і PgEnum для прийнятих енам-типів"
```

---

### Task 5: Контракт фізичного знімка, типи Postgres, імена обмежень (T0)

**Files:**
- Create: `packages/simetra/src/model/physical/snapshot.ts`, `pg-types.ts`, `pg-names.ts`, `index.ts`
- Test: `packages/simetra/src/model/__tests__/pg-types.test.ts`, `pg-names.test.ts`

**Interfaces:**
- Produces (експорт з `simetra/model`):
  - Типи знімка (спека §8.3; контракт T0 — з нього будують рендер E, хеш D,
    `explain` D; extract адаптера E мапиться в нього):
    ```ts
    interface PhysicalSnapshot { tables: PhysicalTable[]; enumTypes: PhysicalEnumType[] }
    interface PhysicalOrigin { objectId: string; tabularSectionId?: string }
    interface PhysicalEnumType { schema: string; name: string; values: string[]; origin: PhysicalOrigin }
    interface PhysicalTable {
      schema: string; name: string; comment?: string; origin: PhysicalOrigin
      columns: PhysicalColumn[]            // порядок оголошення
      primaryKey?: { name: string; columns: string[] }
      uniques: { name: string; columns: string[]; nullsNotDistinct: boolean }[]
      checks: { name: string; expression: string }[]
      foreignKeys: { name: string; columns: string[]; references: { schema: string; table: string; columns: string[] };
                     onDelete: FkAction; onUpdate: FkAction; deferrable: "no" | "deferrable" | "initiallyDeferred" }[]
      indexes: { name: string; unique: boolean; method: string; keys: ({ column: string } | { expression: string })[];
                 include: string[]; where?: string; nullsNotDistinct: boolean }[]
    }
    interface PhysicalColumn {
      name: string; type: string; notNull: boolean; default?: string
      identity?: "always" | "byDefault"; comment?: string
      origin: { elementId?: string; standard?: string }   // UUID реквізиту чи логічне ім'я стандартного
    }
    ```
    Масиви `uniques`/`checks`/`foreignKeys`/`indexes` — відсортовані за `name`;
    `tables` — за `(schema, name)`; `enumTypes` — за `(schema, name)`.
  - `pgTypeOf(value: ValueType, refTargetKind?: MetadataKind): string` —
    форма `format_type()`: `UUID`→`uuid`, `String(n)`→`character varying(n)`,
    `Text`→`text`, `SmallInt`→`smallint`, `Integer`→`integer`,
    `BigInt`→`bigint`, `Numeric`→`numeric` / `numeric(p,s)` (без scale —
    `numeric(p,0)`), `Boolean`→`boolean`, `Date`→`date`,
    `DateTime`→`timestamp with time zone`, `Bytes`→`bytea`, `Json`→`jsonb`,
    `Ref`→`uuid` (на `Enumeration` — `text`, спека М15), масив — суфікс `[]`;
    `pgEnumTypeName(schema, physicalName)` → `schema.name` з квотуванням
    частин як у `quote_ident`.
  - `quoteIdent(name: string): string` — як `quote_ident` Postgres (без лапок,
    якщо `^[a-z_][a-z0-9_$]*$` і не зарезервоване слово; інакше в лапках з
    подвоєнням `"`).
  - `makeObjectName(name1: string, name2: string | undefined, label: string): string`
    і `chooseConstraintName(name1: string, name2: string | undefined, label: string, taken: ReadonlySet<string>): string`
    — алгоритм `makeObjectName` / `ChooseConstraintName` Postgres
    (`src/backend/commands/indexcmds.c`, ліцензія PostgreSQL — копіювання
    дозволене `CONTRIBUTING.md`; якщо портуєш код, а не реалізуєш за описом, —
    шапка й запис у `THIRD_PARTY_NOTICES`). Довжини — у байтах UTF-8,
    обрізання не розриває символ; ліміт 63 байти; при колізії — суфікс `1`,
    `2`, … до мітки (`t_c_key1`), з повторним обрізанням.
    Мітки й склад: PK — `(<table>, undefined, "pkey")`; UNIQUE, FK, індекс —
    `(<table>, <колонки через "_">, "key" | "fkey" | "idx")`; виразний ключ
    індексу дає частину `expr`; CHECK колонки — `(<table>, <колонка>, "check")`.

- [ ] **Step 1: Тести**

`pg-types.test.ts` — таблиця «логічний тип → рядок» за Interfaces, зокрема
`numeric(12,2)`, `numeric(10,0)`, `character varying(100)[]`, `Ref` на
`Enumeration` → `text`, `pgEnumTypeName("public","order_status") === "public.order_status"`,
`pgEnumTypeName("Sales","Status") === "\"Sales\".\"Status\""`.

`pg-names.test.ts`:
- `makeObjectName("orders", undefined, "pkey") === "orders_pkey"`;
- `makeObjectName("orders", "customer_id", "fkey") === "orders_customer_id_fkey"`;
- `makeObjectName("a".repeat(40), "b".repeat(40), "fkey") === "a".repeat(29) + "_" + "b".repeat(28) + "_fkey"` (63 байти);
- `makeObjectName("a".repeat(70), undefined, "pkey") === "a".repeat(58) + "_pkey"`;
- `result never exceeds 63 bytes and never splits a UTF-8 character` — `makeObjectName("ї".repeat(40), "c", "key")`: `Buffer.byteLength(r) <= 63` і `r` не містить `�` після `Buffer.from(r).toString()`;
- `chooseConstraintName("t", "c", "key", new Set(["t_c_key"])) === "t_c_key1"`;
- `quoteIdent("order") === "\"order\""`, `quoteIdent("Orders") === "\"Orders\""`, `quoteIdent("orders") === "orders"`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test pg-types pg-names` → FAIL.

- [ ] **Step 3: Реалізація** — модулі за Interfaces.

- [ ] **Step 4: Зелені** — той самий прогін PASS; далі повні гейти.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/model THIRD_PARTY_NOTICES
git commit -m "feat(model): контракт фізичного знімка, типи Postgres і алгоритм імен обмежень"
```

---

### Task 6: Реєстр видів зі стандартними реквізитами й фізичними фактами; форматер (T0)

**Files:**
- Create: `packages/simetra/src/model/kinds/registry.ts`, `kinds/<kind>.ts` (по файлу на кожен із 8 видів), `kinds/standard.ts`, `model/format.ts`
- Delete: `schemas/standard-attributes.ts` і його тести в `kind-schemas.test.ts` (`getStandardAttributes`)
- Test: `__tests__/kind-registry.test.ts`, `__tests__/format.test.ts`

**Interfaces:**
- Consumes: задачі 2–5.
- Produces:
  ```ts
  type WritePattern = "optimistic" | "server" | "none"
  interface StandardColumnDef {
    logicalName: string            // канонічне camelCase; snake_case — toSnakeCase, крім `ref`
    physicalName: string           // ім'я прототипу (спека §5)
    type: ValueType | { raw: string }
    notNull: boolean
    default?: string               // SQL-вираз: "false", "true", "now()", "gen_random_uuid()"
    check?: string                 // вираз CHECK колонки
    primaryKey?: true
    indexed?: true
    unique?: true
    ref?: "self" | "owningObject" | "owners" | "recorders"   // ціль посилання
    polymorphic?: "whenMany" | "always"                      // пара `<base>_type` + `<base>_id`
    title: LocalizedString
  }
  interface KindDefinition {
    kind: MetadataKind
    dir: string                                // тека (спека §3)
    schema: z.ZodType
    keyOrder: readonly string[]                // ключі верхнього рівня для форматера
    referenceable: boolean
    writePattern: WritePattern
    actions: readonly string[]                 // словник дій (каталог дій — план D)
    materializes: "table" | "enumType" | "none"
    standardColumns(obj: unknown): StandardColumnDef[]            // основна таблиця
    tabularSectionColumns?(obj: unknown): StandardColumnDef[]     // рядок ТЧ
    references(obj: unknown): { pointer: string; ref: MetadataRef; role: ReferenceRole }[]
  }
  type ReferenceRole = "attribute.ref" | "attribute.allowedType" | "constant.ref" | "constant.allowedType"
    | "catalog.owner" | "register.recorder" | "document.registerMovement" | "document.postingRegister"
    | "customTable.foreignKey" | "customTable.pgEnum"
  const KIND_REGISTRY: Readonly<Record<MetadataKind, KindDefinition>>
  function kindByDir(dir: string): KindDefinition | undefined
  function standardLogicalName(def: StandardColumnDef, style: AttributeCase): string
  function formatMetaFile(data: Record<string, unknown>): string   // канонічна форма .meta.json
  function formatProjectFile(data: Record<string, unknown>): string
  ```
  `ReferenceRole` — відкритий перелік: план C додає ролі виразів конструктора
  і скоупу.

**Факти реєстру** (фізичні імена — прототипу; `—` означає «немає»):

| Вид | dir | referenceable | writePattern | Стандартні колонки основної таблиці |
| --- | --- | --- | --- | --- |
| Catalog | `catalogs` | так | optimistic | `ref`↔`id` uuid PK, **без** DEFAULT (id дає клієнт, спека §5); `code`↔`code` (якщо `codeLength > 0`: `codeType` String → `character varying(codeLength)`, Number → `integer`; `indexed`; `unique`, якщо `codeUnique`); `description`↔`description` (якщо `descriptionLength > 0`: `character varying(descriptionLength)`); `deletionMark`↔`deletion_mark` boolean NOT NULL DEFAULT `false`; ієрархія ≠ None: `parent`↔`parent_id` uuid, ref self, indexed; `FoldersAndItems`: `isFolder`↔`is_folder` boolean NOT NULL DEFAULT `false`; власники: `owner`↔`owner_id` (один) чи пара `owner_type`+`owner_id` (кілька), indexed; `predefinedName`↔`predefined_name` text; `createdAt`↔`created_at` і `updatedAt`↔`updated_at` timestamptz NOT NULL DEFAULT `now()` |
| Document | `documents` | так | server | `ref`↔`id` uuid PK DEFAULT `gen_random_uuid()`; `number`↔`number` (`character varying(numberLength)` / `integer`), indexed; `date`↔`date` timestamptz NOT NULL, indexed; `posted`↔`posted` boolean NOT NULL DEFAULT `false`; `deletionMark`, `createdAt`, `updatedAt` — як у довідника |
| рядок ТЧ (Catalog, Document) | — | — | як у власника | `ref`↔`id` uuid PK (DEFAULT `gen_random_uuid()` лише в документа); `parent`↔`parent_id` uuid NOT NULL, ref owningObject, FK `ON DELETE CASCADE`, indexed; `lineNumber`↔`line_number` integer NOT NULL |
| Enumeration | `enumerations` | так | none | таблиці немає (`materializes: "none"`); посилання — `text` + `CHECK (<колонка> IN (<мітки>))` (спека М15) |
| InformationRegister | `information-registers` | ні | server | періодичний: `period`↔`period` timestamptz NOT NULL, indexed; `RecorderSubordinate`: `recorder` — пара `recorder_type` text NOT NULL + `recorder_id` uuid NOT NULL (`polymorphic: "always"`, ref recorders), `lineNumber` integer NOT NULL, `active`↔`active` boolean NOT NULL DEFAULT `true` |
| AccumulationRegister | `accumulation-registers` | ні | server | `period` timestamptz NOT NULL, indexed; `recorder` — пара (always); `lineNumber` NOT NULL; `active` NOT NULL DEFAULT `true`; `Balance`: `movementType`↔`movement_type` text NOT NULL, `CHECK (movement_type IN ('Receipt', 'Expense'))` |
| Constant | `constants` | ні | server | `singleton`↔`singleton` boolean PK DEFAULT `true` CHECK `(singleton)`; `value`↔`value` — тип константи (спека §5; скоуплена форма — план C) |
| CustomTable | `custom-tables` | так (перевірка ключа — стадія 4) | optimistic | немає (нічого похідного, спека §4) |
| PgEnum | `pg-enums` | ні (на нього посилається лише колонка `CustomTable`) | none | енам-тип (`materializes: "enumType"`) |

Ключі й підсумки регістрів, контроль залишків і віртуальні таблиці — план C.
Словник дій: Catalog — `read`, `create`, `update`, `markDeletion`, `delete`;
Document — ті самі + `post`, `unpost`; регістри — `read`; Constant — `read`,
`update`; CustomTable — `read`, `create`, `update`, `delete`; Enumeration,
PgEnum — `[]`.

- [ ] **Step 1: Тести реєстру й форматера**

`kind-registry.test.ts`:
- `every kind has a registry entry and a unique dir` — `Object.keys(KIND_REGISTRY)` = `METADATA_KINDS`; `dir` унікальні; `kindByDir("custom-tables")?.kind === "CustomTable"`;
- `catalog code and description follow settings` — `codeLength: 0` → немає колонки `code`; `descriptionLength: 0` → немає `description`; `codeType: "Number"` → `code` типу `Integer`;
- `catalog key has no default, document key has gen_random_uuid()`;
- `ItemsOnly hierarchy has parent but no is_folder`;
- `one owner gives owner_id, many owners give owner_type + owner_id` (перевір `polymorphic` і `physicalName`);
- `balance register has movement_type with check, turnover has none`;
- `information register recorder columns only when RecorderSubordinate`;
- `tabular section row has parent_id cascade and line_number`;
- `standard logical names follow project style` — `standardLogicalName(deletionMark, "snake_case") === "deletion_mark"`, `(ref, "snake_case") === "ref"`, `(parent, "snake_case") === "parent"`;
- `references() finds every MetadataRef` — для документа з `registerMovements`, реквізитом `Ref` і поліморфним реквізитом у ТЧ повертає ролі й pointer-и (`/registerMovements/0`, `/attributes/0/ref`, `/tabularSections/0/attributes/1/allowedTypes/1`).

`format.test.ts`:
- `orders keys by kind key order and is idempotent` — перемішаний каталог → `formatMetaFile(JSON.parse(formatMetaFile(x)))` === `formatMetaFile(x)`, `id`, `kind`, `name`, `physicalName` — перші ключі;
- `unknown keys keep input order after known ones`;
- `2-space indent and trailing newline`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test kind-registry format` → FAIL.

- [ ] **Step 3: Реалізація**

Реєстр — єдине місце розгалуження за видом у T0: `grep -rn '"AccumulationRegister"' packages/simetra/src --include='*.ts'`
після задачі дає лише `kinds/`, `schemas/` і тести. Видали файли з Files.

- [ ] **Step 4: Зелені** — той самий прогін PASS; далі повні гейти.

- [ ] **Step 5: Commit**

```bash
git add -A packages/simetra/src/model
git commit -m "feat(model): реєстр видів зі стандартними реквізитами й фізичними фактами; канонічний форматер .meta.json"
```

---

### Task 7: Компілятор T1 — діагностика, стадії 1–2, індекс посилань

**Files:**
- Create: `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts`, `compile.ts`, `stages/files.ts`, `stages/identity.ts`
- Modify: `packages/simetra/src/compiler/index.ts`
- Test: `packages/simetra/src/compiler/__tests__/helpers.ts`, `stage-files.test.ts`, `stage-identity.test.ts`

**Interfaces:**
- Consumes: реєстр і схеми T0.
- Produces (експорт з `simetra/compiler`):
  ```ts
  type Severity = "error" | "warning"
  interface Diagnostic {
    code: RuleCode; severity: Severity
    file: string; pointer: string          // RFC 6901; "" — весь файл
    message: string; hint?: string
    params?: Record<string, string | number>
    range?: { start: { line: number; character: number }; end: { line: number; character: number } }  // заповнює план D
  }
  type RuleCode = SchemaRule | CompilerRule
  const MESSAGES: Record<RuleCode, { message: (p: Record<string, string | number>) => string; hint?: string }>
  interface ResolvedReference { from: { file: string; pointer: string; objectId: string }; to: { kind: MetadataKind; id: string }; role: ReferenceRole }
  interface SourceObject { id: string; kind: MetadataKind; name: string; file: string; data: unknown }  // data — вихід Zod-схеми виду
  interface CompiledModel {
    project: Project; objects: SourceObject[]          // сортування: порядок METADATA_KINDS, далі name
    references: ResolvedReference[]                    // сортування: file, pointer
    sqlFiles: { file: string; ownerObjectId?: string; schema?: string }[]
    moduleFiles: { file: string; ownerObjectId: string }[]
    physical: PhysicalSnapshot                         // задача 8
  }
  interface CompileResult { ok: boolean; diagnostics: Diagnostic[]; model?: CompiledModel }
  function compile(files: ReadonlyMap<string, string>): CompileResult
  ```
  Шляхи в мапі — відносно кореня `metadata/`, розділювач `/`.
  **Розкладка (стадія 1):** `project.meta.json` (обов'язковий);
  `<dir>/<Name>/<Name>.meta.json`; поруч опційні `<Name>.module.ts`,
  `<Name>.sql`; `sql/<pg-schema>/<file>.sql`. Вміст `.sql` і `.module.ts` у B
  не розбирається — лише реєструється.
  **Правила компілятора** (`CompilerRule`, severity error, якщо не сказано):
  `project.missing`, `file.unknown-path`, `file.orphan` (`.sql`/`.module.ts`
  без `.meta.json`), `file.invalid-json`, `file.schema` (проблема Zod без
  власного `rule`), `file.kind-mismatch` (`kind` ≠ вид теки), `file.name-mismatch`
  (тека чи ім'я файлу ≠ `name`), `identity.id-missing` (hint: `Run simetra fix to assign ids.`),
  `identity.id-duplicate`, `identity.physical-name-missing` (hint про `simetra fix`),
  `identity.name-duplicate` (об'єкт — у межах виду; реквізит, вимір, ресурс, ТЧ,
  колонка — у межах власника; значення перерахування — у межах перерахування),
  `identity.name-case` (стиль `naming.attributeCase`), `identity.name-reserved`
  (логічне ім'я реквізиту збігається з логічним ім'ям стандартного реквізиту
  виду), `reference.unresolved`.
  Проблема Zod → `Diagnostic`: `code = issue.params?.rule ?? "file.schema"`,
  `pointer` — з `issue.path`, `message` — з `MESSAGES`, для `file.schema` — текст Zod.

- [ ] **Step 1: Helpers і тести**

`helpers.ts`: `uuid(n: number): string` → `` `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}` ``;
`project(overrides?)`; `metaFiles(entries: Record<string, unknown>): Map<string, string>`
(об'єкт → `JSON.stringify`, рядок — як є); мінімальні `catalog(name, overrides?)`,
`document(...)`, `customTable(...)` з id і physicalName.

`stage-files.test.ts`:
- `empty map reports project.missing`;
- `valid minimal project compiles with ok true and no diagnostics`;
- `kind mismatch` — документ у `catalogs/Contract/Contract.meta.json` → `file.kind-mismatch`, pointer `/kind`;
- `folder and file name must equal logical name` — `catalogs/contract/contract.meta.json` для `name: "Contract"` → `file.name-mismatch`;
- `unknown path` — `catalogs/Contract/notes.txt` і `foo.json` → `file.unknown-path`;
- `orphan sql` — `catalogs/Contract/Contract.sql` без `.meta.json` → `file.orphan`;
- `shared sql is registered` — `sql/public/scope_sets.sql` потрапляє в `model.sqlFiles` з `schema: "public"`;
- `invalid json` → `file.invalid-json`, pointer `""`;
- `schema rule code survives mapping` — реквізит `{ type: "String" }` без `length` → `type.length-required`, pointer `/attributes/0/length`;
- `all diagnostics of stages 1-2 are returned` — два зламані файли дають діагностику для обох.

`stage-identity.test.ts`:
- `missing id` → `identity.id-missing` з hint, що містить `simetra fix`;
- `duplicate id across files` → `identity.id-duplicate` у другому файлі (порядок — за шляхом);
- `missing physicalName on attribute` → `identity.physical-name-missing`, pointer `/attributes/0/physicalName`;
- `duplicate attribute name` → `identity.name-duplicate`, pointer другого;
- `attribute case follows project style` — реквізит `unit_price` у проєкті `camelCase` → `identity.name-case`; у проєкті `snake_case` — чисто;
- `attribute may not reuse a standard logical name` — реквізит `deletionMark` у довідника → `identity.name-reserved`;
- `unresolved reference` — `ref: { kind: "Catalog", name: "Missing" }` → `reference.unresolved`, pointer `/attributes/0/ref`;
- `references index` — довідник `Contract` з реквізитом-посиланням на `Currency` дає `ResolvedReference` `{ from: { file: "catalogs/Contract/Contract.meta.json", pointer: "/attributes/0/ref", objectId: <id Contract> }, to: { kind: "Catalog", id: <id Currency> }, role: "attribute.ref" }`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test stage-files stage-identity` → FAIL.

- [ ] **Step 3: Реалізація** — за Interfaces; `compile` повертає `model`
лише коли стадії 1–2 без помилок (стадія 3 — задача 8; до неї `physical`
порожній `{ tables: [], enumTypes: [] }`).

- [ ] **Step 4: Зелені** — PASS; далі повні гейти.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): діагностика з кодами правил, стадії 1–2 і індекс посилань над мапою файлів"
```

---

### Task 8: Стадія 3 (фізичний знімок) і частина стадії 4; синхронізація канону

**Files:**
- Create: `packages/simetra/src/compiler/stages/model.ts`, `stages/integrity.ts`
- Modify: `compile.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-model.test.ts`, `stage-integrity.test.ts`
- Modify (канон): `AGENTS.md` § «Metamodel rules», `.agents/skills/code-review/references/simetra-domain-criteria.md`, `docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md` §3 (два якорі референсу каскаду), `docs/ROADMAP.md`

**Interfaces:**
- Consumes: задачі 5–7.
- Produces: `CompiledModel.physical` за правилами:
  - Таблиця об'єкта: `schema` = `obj.schema ?? project.defaultSchema`, `name` =
    `obj.physicalName`; колонки — стандартні (реєстр, у порядку реєстру), далі
    реквізити в порядку файлу (для регістрів — виміри, ресурси, реквізити).
  - ТЧ — окрема таблиця `name` = `section.physicalName`, `origin.tabularSectionId`.
  - Реквізит: `type` — `pgTypeOf`; `required` → `notNull`; `defaultValue` →
    SQL-літерал (`'text'` з подвоєнням `'`, число, `true`/`false`); `unique` →
    UNIQUE (окремого індексу не дає); `indexed` без `unique` і кожен одиночний
    `Ref` не на перерахування → індекс. Те саме для стандартних колонок.
  - Одиночний `Ref`: колонка `physicalName` (uuid), FK на PK цілі (`ON DELETE`
    за замовчуванням `noAction`); на `CustomTable` — на її одноколонковий uuid-PK;
    на `Enumeration` — `text` + CHECK `(<col> IN (<мітки>))` у порядку значень,
    без FK; масив перерахування — `text[]` + CHECK `(<col> <@ ARRAY[<мітки>])`;
    масив `Ref` — `uuid[]` без FK.
  - Поліморфний `Ref` і стандартні пари: `<physicalName>_type` text + `<physicalName>_id`
    uuid, без FK, CHECK `(<base>_type IN (<physicalName цілей>))` (спека §5).
  - `CustomTable`: колонки й обмеження — як описано; логічні імена в
    обмеженнях → фізичні; `PgEnum`-колонка → тип `pgEnumTypeName`.
  - `PgEnum` → `enumTypes`.
  - Імена похідних обмежень та індексів — `chooseConstraintName` з простором
    імен на PG-схему (індекси й обмеження ділять простір імен відношень схеми).
  - **Стадія 4 (частина):** `reference.not-referenceable` (ціль —
    регістр, константа чи `PgEnum` поза колонкою `CustomTable`);
    `reference.custom-table-key` (`Ref` на `CustomTable` без одноколонкового
    PK типу `uuid`); `physical.table-duplicate` (таблиці й енам-типи в межах
    PG-схеми); `physical.column-duplicate` (у межах таблиці, зокрема зі
    стандартними); `physical.discriminator-duplicate` (цілі однієї поліморфної
    множини — `allowedTypes` одного `Ref` чи реєстратори одного регістра — з
    однаковим `physicalName` незалежно від схеми); `physical.reserved-word`
    (severity **warning**); `physical.name-too-long` (> 63 байт).

- [ ] **Step 1: Тести**

`stage-model.test.ts`:
- `catalog table` — довідник `Contract` (`physicalName: "contract"`, реквізит
  `currency` → `Currency`) дає таблицю `public.contract` з колонками
  `id uuid NOT NULL` (без default), `code character varying(9)`,
  `description character varying(150)`, `deletion_mark boolean NOT NULL DEFAULT false`,
  `predefined_name text`, `created_at`, `updated_at`, `currency_id uuid`
  (довідник `Currency` — поруч у мапі); `primaryKey.name === "contract_pkey"`;
  FK `contract_currency_id_fkey` → `public.currency(id)`; індекс
  `contract_currency_id_idx`; UNIQUE `contract_code_key` і жодного окремого
  індексу на `code`;
- `document tabular section` — таблиця ТЧ з `parent_id` FK `ON DELETE cascade`
  на таблицю документа і `line_number integer NOT NULL`; `id` з
  `DEFAULT gen_random_uuid()`;
- `enumeration reference is text with check` — CHECK
  `status IN ('draft', 'posted')` у порядку значень, без FK;
- `polymorphic reference` — `subject_type text` + `subject_id uuid`, CHECK
  `subject_type IN ('contract', 'counterparty')`, FK немає;
- `custom table with external fk and pg enum column` — FK на
  `auth.users(id)` з явним ім'ям; колонка типу `public.order_status`;
  `enumTypes` містить `order_status` з порядком значень;
- `explicit constraint names win`; `long names use postgres truncation` —
  таблиця з 60-символьним `physicalName` і колонкою `customer_id` дає ім'я FK
  з `makeObjectName`;
- `deterministic regardless of map order` — та сама мапа в зворотному порядку
  вставки дає `JSON.stringify(result)` побайтно рівний.

`stage-integrity.test.ts` — по тесту на кожне правило стадії 4 з Interfaces
(очікуваний `code`, severity і pointer), зокрема
`two polymorphic targets with the same physicalName in different schemas`
→ `physical.discriminator-duplicate`; `reserved word is a warning` — `ok`
лишається `true`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test stage-model stage-integrity` → FAIL.

- [ ] **Step 3: Реалізація** — `stages/model.ts` (побудова знімка з реєстру),
`stages/integrity.ts`; `compile` викликає їх, коли стадії 1–2 чисті.

- [ ] **Step 4: Зелені** — PASS; повні гейти.

- [ ] **Step 5: Канон і статус**

- `AGENTS.md` § «Metamodel rules»: блок «⚠️ Identity and naming will change»
  стає правилом (спека §12 «Супутня правка канону»): кожен іменований елемент
  має UUID `id`, посилання у файлах — за логічним іменем `{ kind, name }`,
  `physicalName` призначається раз і не змінюється, стиль логічних імен
  реквізитів — `project.naming.attributeCase`; новий механізм не будується на
  імені як ідентичності. Рядок про стандартні реквізити — SSOT
  `packages/simetra/src/model/kinds/`; додай правило: кожне розгалуження за
  видом читає реєстр видів.
- `simetra-domain-criteria.md`: якорі на видалені `standard-attributes.ts`,
  `physical-naming.ts`, `technical-name.ts`, `serialization.ts`, фікстури —
  на `kinds/`, `schemas/identity.ts`, `model/format.ts`; критерій «canonical
  fixtures» — на тести форматера.
- Спека П2 §3: «референс логіки каскаду — `apps/web/src/stores/metadata-store.ts`,
  граф посилань — `packages/core/src/find-references.ts`» → «референс логіки
  каскаду — `legacy/web/src/stores/metadata-store.ts`; граф посилань — індекс
  посилань стадії 2 (§8.2)».
- `docs/ROADMAP.md`: у «Документи» рядка П2 — посилання на цей план; «Зараз» —
  план B виконано, далі план C.

Run: `python3 scripts/check-doc-anchors.py && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`

- [ ] **Step 6: Commit**

```bash
git add packages/simetra AGENTS.md .agents docs
git commit -m "feat(compiler): стадія 3 — фізичний знімок з реєстру видів, частина стадії 4; канон ідентичності"
```

---

## Критерії приймання плану B

- `compile(files)` над мапою файлів проходить стадії 1–3 і частину 4; кожне
  правило має тест, що червоніє саме ним.
- Файли T0 не містять `id`-незалежних механізмів ідентичності: немає
  `KIND_PREFIX`, `physicalObjectName`, `metadata-io`, `serialization`,
  `find-references`, `validation-message`, форм.
- Реєстр видів — єдине місце знань про вид у T0 і T1.
- Фізичний знімок детермінований і містить типи у формі `format_type()`,
  імена обмежень за алгоритмом Postgres.
- Лінт тримає чистоту T0 (лише `zod`) і T1 (без Node API).
- Гейти зелені; гард якорів чистий.
