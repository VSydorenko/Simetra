# П2, план D1 — завершення API компілятора: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** API компілятора T1 повний: дослівний SQL розбирається в
SQL-одиниці з ідентичністю, гейтом дозволених класів і спільним з таблицями
порядком створення; стадія 5 перевіряє функції множини, блоки рухів і модулі;
діагностика має каталог uk/en і позицію в тексті; є JSON Schema файлів,
логічні TS-типи сутностей, канонічний знімок і хеш моделі, повний
канонічний форматер і ратчет «поле без споживача». Двері (CLI, MCP,
pre-commit) — план D2.

**Архітектура:** `compile()` стає асинхронним (WASM-парсер libpg-query і
Web Crypto). Розбір SQL, граф залежностей, хеш, JSON Schema, кодоген — модулі
T1 над скомпільованою моделлю; T0 отримує лише поля схем (`rowLevelSecurity`,
описи `.meta`) і факти реєстру.

**Технології:** TypeScript 7, Zod 4 (`z.toJSONSchema`, `.meta`), Vitest 5;
нові залежності T1: `libpg-query` **17.7.4** (MIT, WASM, граматика Postgres 17 — цільової мінімальної версії, тег `pg17`; точний пін),
`jsonc-parser` **3.3.1** (MIT). Хеш — `globalThis.crypto.subtle` (Node 24,
браузер), канонізація RFC 8785 — власна.

**Спека:** [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md) —
§4 (`rowLevelSecurity`), §8.2 (стадії 1–5), §8.3 (SQL-одиниці, порядок,
знімок, хеш), §8.4 (діагностика), §8.5 (JSON Schema, кодоген), §8.6 (ратчет,
модулі), §11 крок 7; [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
§6.3, §6.9.

**Серія планів П2:** A, B, C1, C2, [C3](2026-10-01-p2c3-physics-refinement.md)
(уточнення фізики за
[спекою «Платформа в Postgres»](../specs/2026-10-01-platform-in-postgres-design.md),
М17–М23; виконано, `222ba48..54cd3fc`) → **D1** (цей) → D2 (`@simetra/cli`
compile/explain/fix з `--format json`, MCP-сервер з операціями й каскадом
перейменування, pre-commit і CI, скіл CLI) → E.

> **Вхід D1 — форма моделі й контрактів після C3** (спека «Платформа в
> Postgres», М17–М23): `predefinedItems` і колонка `predefined_name`
> лишаються; у коді вже є `contracts.numbering` (з `periodColumn?` і
> `assignedAt: "firstWrite"`), `contracts.predefined`, `posting.save`/
> `requiredOnPost`/`immutability`, `registers[].turnoversMonth.resources`,
> `virtualTables[].columns[].source`, стандартні реквізити `version`,
> `predefined_name`, `number_period` (генерована колонка). Задачі 7–10
> спираються на цю форму; де план і код розходяться — правда в коді C3 і спеці
> (`754f54b`, `ec70277`). Хвости C3 — у задачі 0.

## Трасування «пункт спеки → задача»

| Пункт спеки | Задача |
| --- | --- |
| Спека П2 §8.2, стадія 5: функція множини кожного виду скоупу (без аргументів, `RETURNS SETOF uuid`, `STABLE`); рівно одне джерело рухів; блок запиту — один `SELECT`, без `ORDER BY` — попередження; `.module.ts` належить об'єкту; один неявний модуль | 3 |
| §8.3, SQL-одиниці: дослівні блоки `*.sql` і обгортки рухів як оператори верхнього рівня з ідентичністю за класом; дозволені класи; `CREATE TABLE`/`INDEX`/енам-тип, `DROP`, DML — помилка | 1 |
| §8.3, порядок створення: детермінований топологічний порядок таблиць і одиниць, розширення першими, перелік ребер, цикл — діагностика | 2 |
| §4, RLS таблиці: `rowLevelSecurity: off \| enabled \| forced` у `CustomTable`, у видів 1С — реєстр видів | 2 |
| §8.3, знімок і хеш: канонічна форма (посилання `{ kind, id }`, AST без позицій, одиниці деревом без позицій), sha256 за RFC 8785; каталог дій; контракти | 9 (хеш, канонічний знімок), 3 (каталог дій) |
| §8.4, діагностика: файл, JSON-pointer, рядок і колонка, код правила, серйозність, підказка; каталог en/uk; усі діагностики прогону | 4 |
| §8.5, JSON Schema з Zod (draft 2020-12, описи `.meta`) у пакеті | 6 |
| §8.5, кодоген логічних TS-типів (мапа типів, ТЧ як інтерфейси, JSDoc) | 8 |
| §3, форма файлу: канонічний порядок ключів за схемою виду на всіх рівнях | 5 |
| §8.6, ратчет «поле без споживача» для полів метамоделі; модуль-власник кожного об'єкта | 10 (ратчет), 3 (модуль) |
| §8.3, контракти після C3 (нумерація, предвизначені, оболонка, похідні таблиці, `source`) — вхід, не предмет; поля подання (`mainPresentation`, `standardAttributeOverrides`, `predefinedItems[].description`) — споживач | 7 |
| Платформна спека §6.3 (ідентичність SQL-одиниць), §6.9 (об'єкти в чужих схемах компілюються), §5 (ратчет як стадія компілятора) | 1, 10 |
| Хвости C2 і C3 (рев'ю) | 0 |
| Канон і статус: критерії рев'ю, ROADMAP | 10 |

## Рішення плану (узгоджено з архітектором спеки; модельні — у спеці)

1. **`compile()` async** — `Promise<CompileResult>`; `loadModule()` libpg-query
   мемоізовано всередині. Синхронного фасаду немає.
2. **Канонічна форма SQL-одиниці для хешу** — дерево розбору без полів
   `location`, `stmt_location`, `stmt_len`; відбиток libpg-query не
   годиться (ігнорує значення констант). Сирий текст — у знімку для рендера,
   поза хешем.
3. **RFC 8785** — власна реалізація (≈30 рядків): ключі — сортування за
   UTF-16 code units, примітиви — `JSON.stringify` (це саме ES
   Number::toString, якого вимагає RFC); тест на числа з JCS.
4. **Модулі** — один неявний модуль, ім'я = `project.name`; `module` у
   кожного об'єкта й SQL-одиниці. Декларація модулів і ключі поведінки — П4.
5. **Ратчет** — тест із Proxy над розібраними даними «kitchen-sink»-фікстури;
   розв'язки полів-сиріт: `autonumber`, `numberPeriodicity`,
   `numberLength`/`numberType`, `codeType` → `contracts.numbering`;
   `mainPresentation`, `standardAttributeOverrides` → блок
   `CompiledModel.presentation`; `title`/`description` → JSDoc кодогену;
   `predefinedItems[].id`/`name` → `contracts.predefined` (уже в коді C3);
   `predefinedItems[].description` → `presentation[].predefined`
   (задача 7) — там уже живуть заголовки й описи стандартних реквізитів.
   Нова сирота, не названа тут, — зупинка й питання архітектору, не вигаданий
   споживач.
6. **JSON Schema** генерує `buildJsonSchemas()` (T1); файли в
   `packages/simetra/schemas/` комітяться; тест дрейфу порівнює їх із
   згенерованими й перезаписує при `UPDATE_JSON_SCHEMAS=1`.
7. **`sqlFiles`** у `CompiledModel` зникає — його замінюють SQL-одиниці.

## Global Constraints

- Чистота: T0 — лише `zod`; T1 — без Node API (libpg-query, jsonc-parser і
  Web Crypto дозволені). Тести можуть використовувати Node API.
- Нові залежності — точний пін (`"libpg-query": "17.7.4"`,
  `"jsonc-parser": "3.3.1"`), без каретки; ліцензії перевірено (MIT).
- Детермінізм: той самий вхід → побайтно той самий знімок, порядок і хеш;
  порядок вставки в мапу файлів нічого не змінює.
- Тексти діагностики — en обов'язково, uk — поруч у тому самому каталозі;
  коментарі — українською; описи `.meta` у схемах — англійською.
- Без шимів: `sqlFiles` — видаляється, не деприкується (`predefinedItems`
  лишається — М18).
- Коміти — Conventional Commits, опис українською, без трейлерів; видалення
  — `git rm` з явними шляхами.
- Гейти після кожної задачі: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`;
  після правки доків — `python3 scripts/check-doc-anchors.py`.

## Review Focus

1. **Реальний дамп прийнятої схеми** — розширення, publications, окремі
   послідовності, домени, тригер на `auth.users`, політики на
   `storage.objects` — компілюється без `sql.statement-not-allowed`. Тест —
   задача 1.
2. **Зміна лише форматування `.sql`** (пробіли, регістр ключових слів) не
   змінює хеш, а зміна константи в тілі sql-функції — змінює. Тест — задача 9.
3. **`DEFAULT` колонки `CustomTable`, що викликає функцію з одиниці** —
   функція в порядку створення раніше за таблицю; цикл «в'юха ↔ функція» —
   діагностика, а не безкінечний цикл. Тест — задача 2.
4. **Позиція помилки у виразі з екранованими символами** (`'it''s'`, `\"` у
   JSON-рядку) — `range` указує на правильні символи сирого тексту. Тест —
   задача 4.
5. **Функція множини з аргументом чи `RETURNS uuid`** — `scope.set-function-signature`,
   а не мовчазний прохід до П3. Тест — задача 3.

---

### Task 0: Хвости C2 і C3 (тріаж фінальних рев'ю)

**Files:**
- Modify: `packages/simetra/src/compiler/stages/identity.ts`, `stages/integrity.ts`, `compiler/movement-blocks.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Create: `packages/simetra/src/model/posting/walk.ts` (спільний обхід AST)
- Modify (хвости C3): `packages/simetra/src/compiler/contracts.ts` (JSDoc `buildContracts` і `totalsFunctions` — predefined, numbering, turnovers_month), `packages/simetra/src/model/kinds/standard.ts` (тип параметра нумерації — `z.infer` поля `numberType`/`codeType` схем, не дубль літералом `"String" | "Number"`)
- Test: `packages/simetra/src/compiler/__tests__/stage-posting-identity.test.ts`, `stage-links.test.ts` (попередження маркера — на рівні `compile`), `stage-registers.test.ts`, `packages/simetra/src/model/__tests__/posting-parse.test.ts`, `contracts.test.ts` (два нестрогі твердження, які виконавець C3 відклав, — знайти за правилом «`toContain` на фрагмент чи `toBeDefined` замість точного очікування» і замінити точними очікуваннями)

**Interfaces:**
- Produces:
  - `walkExpr(expr: Expr, visit: (node: Expr) => void): void` у T0; `nodesOf` у
    `integrity.ts` і `namedNodes` в `identity.ts` переходять на нього (один
    обхід AST замість двох).
  - Правила: `register.balance-control-duplicate` (ресурс повторюється в
    `balanceControl.resources`, pointer на повтор); `file.movements-marker-indented`
    — **warning** (рядок `^\s+-- @(movements|end)\b` у `.sql` документа).
  - Тести індексу посилань (на них спирається каскад перейменування D2): ролі
    й `span` для полів у `sum`/`count`, у `condition` і в `movementType`-виразі.

- [ ] **Step 1: Тести** — `sum and count references carry spans`;
  `condition references are indexed`; `movementType expression references are indexed`;
  `duplicate balance control resource`; `indented marker is a warning`.
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test stage-posting-identity stage-links stage-registers` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "fix(compiler): хвости C2 і C3 — спільний обхід AST, повтори balanceControl, маркер з відступом, JSDoc контрактів, тип нумерації зі схеми, строгі твердження контрактів" --only -- packages/simetra/src
```

---

### Task 1: Асинхронний `compile()` і SQL-одиниці з дослівних `.sql`

**Files:**
- Modify: `packages/simetra/package.json` (залежність `libpg-query`)
- Create: `packages/simetra/src/compiler/sql/parse.ts`, `sql/units.ts`
- Modify: `compiler/compile.ts`, `stages/files.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`, `compiler/movement-functions.ts` (одиниці рухів — у тому самому масиві)
- Modify: усі тести компілятора (`await compile(...)`)
- Test: `packages/simetra/src/compiler/__tests__/sql-units.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function compile(files: ReadonlyMap<string, string>): Promise<CompileResult>
  type SqlUnitClass = "function" | "procedure" | "aggregate" | "trigger" | "policy" | "view"
    | "materializedView" | "grant" | "defaultPrivileges" | "comment" | "extension"
    | "sequence" | "sequenceOwnedBy" | "domain" | "publication" | "replicaIdentity"
    | "functionSettings" | "movementQuery"
  interface SqlUnit {
    class: SqlUnitClass
    identity: string          // канонічний ключ, напр. "function:public.f(uuid,text)", "trigger:public.orders.trg_x"
    schema: string; name: string
    file?: string             // немає — згенерована одиниця (запит рухів)
    ownerObjectId?: string    // `.sql` об'єкта; для рухів — документ
    module: string
    sql: string               // текст оператора як є (для рендера)
    tree: unknown             // дерево розбору без location/stmt_location/stmt_len (для хешу)
    registerId?: string; documentId?: string; source?: "query" | "constructor"   // лише movementQuery
  }
  ```
  `CompiledModel.sqlUnits: SqlUnit[]` (сортування тут — за `identity`;
  порядок створення — задача 2); `CompiledModel.sqlFiles` видалено. Ця форма
  **замінює** C2-шний `SqlUnit { kind: "movementQuery", … }` (без шиму):
  поле `kind` у `movement-functions.ts` зникає, а контракти C3
  (`buildContracts` читає одиниці рухів) і тести C2/C3 переходять на `class`.
  **Ідентичність за класами** (імена — `schema.name`, частини в списках
  відсортовано, типи аргументів — як у дереві розбору, без імен параметрів):

  | Клас | `identity` |
  | --- | --- |
  | function, procedure, aggregate, functionSettings | `<class>:<schema>.<name>(<типи аргументів через ,>)` |
  | movementQuery | `function:<schema>.<name>(uuid)` — той самий простір, що й функції |
  | trigger, policy | `<class>:<schema>.<table>.<name>` |
  | view, materializedView, sequence, domain | `<class>:<schema>.<name>` |
  | extension | `extension:<name>` |
  | sequenceOwnedBy, replicaIdentity | `<class>:<schema>.<name>` (послідовність / таблиця) |
  | grant | `grant:<grant\|revoke>:<тип об'єкта>:<об'єкти>:<отримувачі>:<привілеї>` |
  | defaultPrivileges | `defaultPrivileges:<роль>:<схеми>:<тип об'єкта>:<grant\|revoke>:<отримувачі>:<привілеї>` |
  | comment | `comment:<тип об'єкта>:<об'єкт>` |
  | publication | `publication:<ім'я>:<add\|drop\|set>:<таблиці>` |

  Отже `GRANT SELECT` і `GRANT INSERT` на ту саму таблицю тому самому
  отримувачу — різні одиниці. Користувацька функція з ім'ям і сигнатурою
  обгортки рухів дає лише `sql.unit-duplicate`; `physical.function-duplicate`
  лишається для імен функцій контрактів (оболонка, віртуальні таблиці,
  перерахунок) проти таблиць і одиниць.
  Правила: `sql.parse` (помилка розбору; `params.line`, `params.column` з
  `cursorPosition`), `sql.statement-not-allowed` (`params.statement` — тип
  вузла, напр. `CreateStmt`), `sql.unit-duplicate` (друга одиниця з тією
  самою `identity`, `params.line`).
  Дозволені вузли верхнього рівня: `CreateFunctionStmt` (функція чи
  процедура), `DefineStmt` з `kind: OBJECT_AGGREGATE`, `CreateTrigStmt`,
  `CreatePolicyStmt`, `ViewStmt`, `CreateTableAsStmt` з
  `objtype: OBJECT_MATVIEW`, `GrantStmt`, `AlterDefaultPrivilegesStmt`,
  `CommentStmt`, `CreateExtensionStmt`, `CreateSeqStmt`, `AlterSeqStmt` лише з
  `OWNED BY`, `CreateDomainStmt`, `AlterPublicationStmt`, `AlterTableStmt`
  лише з `REPLICA IDENTITY`, `AlterFunctionStmt`. Решта (`CreateStmt`,
  `IndexStmt`, `CreateEnumStmt`, `DropStmt`, DML, `ALTER TABLE … ENABLE ROW LEVEL SECURITY`
  — це поле таблиці, задача 2) — `sql.statement-not-allowed`.

- [ ] **Step 1: Тести**

`sql-units.test.ts`:
- `function identity includes argument types` — `CREATE FUNCTION public.f(a uuid, b text) …` → `identity === "function:public.f(uuid,text)"`;
- `trigger and policy identity include table`;
- `grants with different privileges are different units`;
- `two ALTER PUBLICATION ADD TABLE for different tables are different units`;
- `user function colliding with a movement wrapper gives one diagnostic`;
- `accepted-schema dump compiles` — один `sql/public/misc.sql` з
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`, `CREATE SEQUENCE s`,
  `ALTER SEQUENCE s OWNED BY t.c`, `CREATE DOMAIN d AS text`,
  `ALTER PUBLICATION supabase_realtime ADD TABLE t`,
  `CREATE TRIGGER on_auth_user AFTER INSERT ON auth.users …`,
  `CREATE POLICY p ON storage.objects …` → жодної помилки;
- `table, index, enum and drop are not allowed` — по діагностиці з
  `params.statement`;
- `enable rls statement is not allowed` → `sql.statement-not-allowed` з hint про поле `rowLevelSecurity`;
- `duplicate unit` → `sql.unit-duplicate` з `params.line` другої;
- `parse error has line and column`;
- `tree has no locations` — `JSON.stringify(unit.tree)` не містить `"location"`;
- `movement query wrappers are units` — клас `movementQuery`, `registerId`,
  `documentId`, `source`;
- `compile is async` — `compile(...)` повертає `Promise`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test sql-units` → FAIL.
- [ ] **Step 3: Реалізація** — `pnpm --filter simetra add libpg-query@17.7.4 --save-exact`;
  `loadModule()` мемоізовано в `sql/parse.ts`; усі тести компілятора
  переходять на `await`.
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra pnpm-lock.yaml
git commit -m "feat(compiler): async compile і SQL-одиниці з дослівних .sql — ідентичність, гейт дозволених класів" --only -- packages/simetra pnpm-lock.yaml
```

---

### Task 2: `rowLevelSecurity` і спільний порядок створення таблиць та одиниць

**Files:**
- Modify: `packages/simetra/src/model/schemas/custom-table.ts`, `model/kinds/standard.ts` і файли видів із таблицями (факт реєстру), `model/physical/snapshot.ts`
- Create: `packages/simetra/src/compiler/sql/dependencies.ts`
- Modify: `compiler/compile.ts`, `stages/model.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/creation-order.test.ts`

**Interfaces:**
- Produces:
  - `customTableSchema.rowLevelSecurity: "off" | "enabled" | "forced" = "off"`;
    `KindDefinition.rowLevelSecurity?: "enabled"` для видів 1С з таблицями
    (довідник, документ, регістри, константа); `PhysicalTable.rowLevelSecurity: "off" | "enabled" | "forced"`
    (похідні таблиці регістра — `totals`, `turnovers_month` — і рядки ТЧ — як
    у власника).
  - `CompiledModel.creationOrder: ({ type: "enumType"; schema: string; name: string } | { type: "table"; schema: string; name: string } | { type: "unit"; identity: string })[]`
    — топологічний порядок; **розширення — перші вузли взагалі** (їхні типи й
    функції потрібні колонкам і `DEFAULT`); серед решти готових вузлів
    tie-break — `(тип вузла в порядку enumType, table, unit; schema; name/identity)`.
    Tie-break лише впорядковує незалежні вузли, тож кожна залежність таблиці
    від одиниці мусить бути ребром.
  - Ребра (залежність → залежний): енам-тип → таблиця з колонкою цього типу;
    домен → таблиця з колонкою цього типу (`Raw pgType`); послідовність →
    таблиця, у чиєму `DEFAULT` є `nextval('<послідовність>')`;
    функція (за іменем, усі перевантаження)
    → таблиця, у чиєму `DEFAULT`/`CHECK`/предикаті індексу/виразі
    генерованої колонки (`PhysicalColumn.generated.expression`, зараз лише
    вбудовані функції — але це те саме місце виклику) є виклик
    (вирази розбираються як `SELECT (<вираз>)`); відношення й функції запиту
    → в'юха / матеріалізована в'юха; функція тригера й таблиця → тригер;
    функції виразів і таблиця → політика; відношення й функції тіла
    `LANGUAGE sql` → функція; об'єкт → грант, коментар, `OWNED BY`,
    `REPLICA IDENTITY`, `ALTER PUBLICATION`, налаштування функції;
    розширення → усе, що використовує його типи чи функції, не
    відстежується (розширення завжди перші серед одиниць). Тіла plpgsql не
    аналізуються. Ребра на об'єкти поза моделлю (`auth.users`) ігноруються.
    Некваліфіковане ім'я дає ребро до однойменних об'єктів усіх схем
    (`search_path` невідомий), окрім імені CTE у його області видимості.
  - Обмеження FK поза порядком створення: рендер виводить їх окремими
    `ALTER TABLE … ADD CONSTRAINT` після всіх таблиць (спека П2 §8.3), тож
    взаємні посилання таблиць і самопосилання циклом не є.
  - Правило: `sql.dependency-cycle` (`params.cycle` — перелік вузлів циклу),
    pointer — перша одиниця циклу за порядком. Зокрема цикл «`DEFAULT` таблиці
    → `LANGUAGE sql`-функція, що читає цю таблицю» — діагностика (Postgres
    із `check_function_bodies` так не створить), а не безкінечний цикл.

- [ ] **Step 1: Тести**

`creation-order.test.ts`:
- `custom table default calls a unit function` — колонка з
  `default: "public.next_code()"` → одиниця `function:public.next_code()`
  перед таблицею;
- `view after its tables and functions`;
- `trigger after table and function`;
- `extensions come before everything` — таблиця з `DEFAULT extensions.uuid_generate_v4()` після розширення;
- `domain and sequence before the table` — колонка-домен і `DEFAULT nextval('s')`;
- `table default reading its own table through a sql function is a cycle`;
- `cycle is reported` — в'юха `v` читає функцію `f`, а `LANGUAGE sql`-функція
  `f` читає `v` → `sql.dependency-cycle` з обома у `params.cycle`;
- `deterministic regardless of map order`;
- `1C kinds have rls enabled, custom table off by default` —
  `PhysicalTable.rowLevelSecurity`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test creation-order` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): rowLevelSecurity таблиці й спільний порядок створення таблиць і SQL-одиниць" --only -- packages/simetra/src
```

---

### Task 3: Стадія 5 — функції множини, блоки рухів, модулі; каталог дій

**Files:**
- Modify: `packages/simetra/src/compiler/stages/links.ts`, `compiler/compile.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-links.test.ts` (доповнення)

**Interfaces:**
- Produces:
  - Правила: `scope.set-function-missing` (у одиницях немає
    `function:<schema>.<name>()`; pointer `/scopeKinds/<i>/setFunction`, файл
    `project.meta.json`); `scope.set-function-signature` (є, але з
    аргументами, не `RETURNS SETOF uuid` чи не `STABLE`; `params.problem`);
    `posting.query-not-select` (блок рухів — не рівно один `SelectStmt`;
    `params.line` маркера; `WITH … SELECT` і `SELECT … UNION ALL …` — теж
    `SelectStmt`, дозволені); `posting.query-order-missing` — **warning** (у
    `SelectStmt` немає `sortClause`).
  - `CompiledModel.modules: { name: string }[]` (один — `project.name`);
    `SourceObject.module: string`; `SqlUnit.module` (задача 1).
  - `CompiledModel.actions: { objectId: string; actions: readonly string[] }[]`
    — з `KindDefinition.actions`, сортування за `objectId`.
  - `.module.ts` без `.meta.json` — наявне `file.orphan`; тест це закріплює.

- [ ] **Step 1: Тести** — по тесту на кожне правило (code, pointer, severity);
  `set function with the right signature passes`; `modules and actions in the model`;
  `orphan module file` → `file.orphan`.
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test stage-links` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): стадія 5 — функції множини, блоки рухів, модулі; каталог дій" --only -- packages/simetra/src/compiler
```

---

### Task 4: Діагностика — каталог uk/en і позиція в тексті

**Files:**
- Modify: `packages/simetra/package.json` (`jsonc-parser`), `compiler/messages.ts`, `compiler/diagnostics.ts`, `compiler/compile.ts`
- Create: `packages/simetra/src/compiler/locate.ts`
- Test: `packages/simetra/src/compiler/__tests__/locate.test.ts`, `messages.test.ts`

**Interfaces:**
- Produces:
  - `MESSAGES: Record<RuleCode, { en: (p) => string; uk: (p) => string; hint?: { en: string | ((p) => string); uk: string | ((p) => string) } }>`
    (параметричні підказки C1/C2 зберігаються);
    `Diagnostic.message`/`hint` — en; `localize(d: Diagnostic, locale: "en" | "uk"): { message: string; hint?: string }`.
  - `Diagnostic.range` заповнюється для кожної діагностики з файлом, що є в
    мапі: JSON — `jsonc-parser` (`parseTree` + `findNodeAtLocation` за
    шляхом із pointer; для pointer на ключ, якого немає, — найближчий
    наявний предок; якщо помилка про сам ключ (`identity.name-duplicate` на
    `/…/name`) — вузол значення); вираз конструктора — вузол рядка + `params.offset`,
    переведений з декодованого індексу в сирий з урахуванням JSON-екранування
    (`\"`, `\\`, `\uXXXX`); `.sql` — `params.line` (1-базний, як у C2) →
    `range.start.line = line - 1`; `cursorPosition` libpg-query 17.7.4 — 0-базне зміщення в code points від початку розібраного тексту, `stmt_location`/`stmt_len` — байти UTF-8; переведення робить задача 1, `range` — 0-базні рядки й колонки в UTF-16 code units (LSP).
  - Тест повноти каталогу: кожен `RuleCode` має непорожні `en` і `uk`.

- [ ] **Step 1: Тести**

`locate.test.ts`:
- `pointer to a value` — `/attributes/1/length` дає рядок і колонку значення;
- `missing key falls back to the parent`;
- `expression offset with escapes` — значення `"row.qty + \"x\""` у JSON,
  помилка на `"x"` → `range.start.character` указує на екранований `\"`
  сирого тексту;
- `sql diagnostics use line and column`;
- `file-level diagnostic` (`pointer ""`) — range початку файлу.

`messages.test.ts`: `every rule has en and uk`; `localize returns uk text`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test locate messages` → FAIL.
- [ ] **Step 3: Реалізація** — `pnpm --filter simetra add jsonc-parser@3.3.1 --save-exact`.
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra pnpm-lock.yaml
git commit -m "feat(compiler): діагностика з каталогом uk/en і позицією в тексті файлу" --only -- packages/simetra pnpm-lock.yaml
```

---

### Task 5: Повний канонічний порядок ключів форматера (T0)

**Files:**
- Modify: `packages/simetra/src/model/format.ts`, `model/kinds/standard.ts` (`keyOrderOf`)
- Test: `packages/simetra/src/model/__tests__/format.test.ts`

**Interfaces:**
- Produces: `formatMetaFile`/`formatProjectFile` упорядковують ключі на
  **кожному** рівні за порядком оголошення в Zod-схемі цього рівня
  (реквізит, ТЧ, колонка `CustomTable`, обмеження, індекс, значення
  перерахування, `MetadataRef`, рух конструктора, вид скоупу); для
  union-схем — порядок варіанта, до якого належить об'єкт (за
  дискримінатором або першим варіантом, чия схема приймає об'єкт); ключі
  `record`-полів (`fields` руху) — у порядку входу. Порядок виводиться зі
  схем, а не з рукописних списків.

- [ ] **Step 1: Тести** — `nested keys follow schema order` (перемішаний
  реквізит → `id, name, physicalName, …`); `custom table column variants`
  (`PgEnum`- і `Raw`-колонки — кожна у своєму порядку); `foreign key
  references internal and external`; `fields map keeps input order`;
  `idempotent on a kitchen-sink file`.
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test format` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/model
git commit -m "feat(model): канонічний порядок ключів на всіх рівнях файлу метаданих" --only -- packages/simetra/src/model
```

---

### Task 6: JSON Schema файлів метаданих

**Files:**
- Modify: схеми T0 (`packages/simetra/src/model/schemas/*.ts`) — `.meta({ description })` англійською на кожному полі верхнього рівня й ключових вкладених
- Create: `packages/simetra/src/compiler/json-schema.ts`, `packages/simetra/schemas/<kind-dir>.schema.json` (по файлу на вид) і `project.schema.json`
- Modify: `packages/simetra/package.json` (`exports["./schemas/*"]: "./schemas/*"`; перевір, що лінт-зони й typecheck не зачіпають JSON), `.prettierignore` (згенеровані схеми не форматуються вручну — генератор пише канонічний JSON)
- Test: `packages/simetra/src/compiler/__tests__/json-schema.test.ts`

**Interfaces:**
- Produces: `buildJsonSchemas(): Record<string, object>` — ключ — ім'я файлу
  (`catalogs.schema.json`, …, `project.schema.json`); кожна схема —
  `z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "throw" })`
  плюс `$id` = ім'я файлу; вміст файлу — `JSON.stringify(schema, null, 2) + "\n"`.
- Тест дрейфу: для кожного ключа порівнює з файлом у `packages/simetra/schemas/`;
  при `process.env.UPDATE_JSON_SCHEMAS === "1"` перезаписує файли (тест може
  використовувати `node:fs`).

- [ ] **Step 1: Тести** — `every kind has a schema`; `schemas are up to date`
  (дрейф); `generation does not throw on any kind` (`unrepresentable: "throw"`);
  `descriptions are present` (у `catalogs.schema.json` є `description` у
  `properties.codeLength`); `kind is a const and required` — у кожній схемі
  виду `properties.kind.const` дорівнює виду, а `kind` є в `required`.
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test json-schema` → FAIL.
- [ ] **Step 3: Реалізація**; згенеруй файли:
  `UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`.
- [ ] **Step 4: Зелені** — PASS без змінної; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra .prettierignore
git commit -m "feat(compiler): JSON Schema файлів метаданих з описами полів і тестом дрейфу" --only -- packages/simetra .prettierignore
```

---

### Task 7: Блок представлення

> Контракти нумерації й предвизначених уже є в коді після C3
> (`contracts.numbering` з `periodColumn?` і `assignedAt`,
> `contracts.predefined` з `{ id, name }`); ця задача їх не чіпає. Тут —
> лише споживачі полів подання, яких ратчет (задача 10) інакше назвав би
> сиротами: `mainPresentation`, `standardAttributeOverrides`,
> `predefinedItems[].description`.

**Files:**
- Create: `packages/simetra/src/compiler/presentation.ts`
- Modify: `compiler/compile.ts` (поле `CompiledModel.presentation`)
- Test: `packages/simetra/src/compiler/__tests__/presentation.test.ts`

**Interfaces:**
- Consumes: `contracts.predefined` (id предвизначених) — щоб описи мали той
  самий ключ, що й контракт засіву.
- Produces:
  - ```ts
    interface PresentationBlock {
      objectId: string
      mainPresentation?: "Code" | "Description"           // лише довідник
      standardAttributes: Record<string, { title?: LocalizedString; description?: LocalizedString }>
      predefined?: { id: string; description: LocalizedString }[]   // лише елементи з description
    }
    CompiledModel.presentation: PresentationBlock[]     // за objectId; об'єкт без жодного з полів у блоці відсутній
    ```
    Ключі `standardAttributes` — канонічні camelCase-імена стандартних
    реквізитів з `standardAttributeOverrides`; `predefined` — у порядку файлу.
    Читачі — `explain` (D2) і хости (П4).

- [ ] **Step 1: Тести** — `presentation block carries overrides and main
  presentation`; `predefined descriptions keyed by id` (елемент без
  `description` у блок не потрапляє; `id` збігається з `contracts.predefined`);
  `object without presentation fields has no block`; `deterministic order`.
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test presentation` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): блок представлення — mainPresentation, перекриття стандартних реквізитів, описи предвизначених" --only -- packages/simetra/src
```

---

### Task 8: Кодоген логічних TS-типів сутностей

**Files:**
- Create: `packages/simetra/src/compiler/codegen.ts`
- Test: `packages/simetra/src/compiler/__tests__/codegen.test.ts`

**Interfaces:**
- Produces: `emitEntityTypes(model: CompiledModel): string` — TS-модуль:
  `export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }`;
  інтерфейс на кожен об'єкт з таблицею (ім'я — логічне PascalCase; довідник,
  документ, регістри, константа, `CustomTable`) і на кожну ТЧ
  (`<Object><Section>` у PascalCase), поле-масив ТЧ у власника; поля — логічні
  імена в стилі проєкту, стандартні реквізити включно, носій скоупу — ім'я виду;
  типи (спека §8.5): `UUID`/`Ref`/`String`/`Text`/`Date`/`DateTime`/`Bytes` →
  `string`, `Integer`/`SmallInt` → `number`, `BigInt`/`Numeric` → `string`,
  `Boolean` → `boolean`, `Json` → `Json`, перерахування → union логічних
  імен значень, масив → `T[]`, nullable (не `notNull`) → `T | null` — зокрема
  `required` реквізит документа (після C3 його колонка nullable), а
  `version` (`BigInt`) → `string`; генерована колонка (`number_period`) —
  `readonly` поле, бо її не пишуть; похідні таблиці регістрів (`totals`,
  `turnovers_month`) інтерфейсів не мають;
  поліморфний `Ref` → `{ type: "<Kind>.<Name>" | …; id: string }`;
  `PgEnum`-колонка → union значень; `Raw` → `unknown`. JSDoc — `title.en ?? title.uk`
  і `description`. Порядок — як у `model.objects`; вихід детермінований.

- [ ] **Step 1: Тести** (`toMatchInlineSnapshot` для фрагментів):
  `catalog interface with standard attributes and jsdoc`; `numeric and bigint
  are strings`; `enumeration reference is a union of logical names`;
  `tabular section interface and array field`; `snake_case project uses
  snake_case fields`; `scoped object has scope field`; `deterministic`.
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test codegen` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): кодоген логічних TS-типів сутностей" --only -- packages/simetra/src/compiler
```

---

### Task 9: Канонічний знімок і хеш моделі

**Files:**
- Create: `packages/simetra/src/compiler/canonical.ts`
- Modify: `compiler/compile.ts`
- Test: `packages/simetra/src/compiler/__tests__/canonical.test.ts`

**Interfaces:**
- Produces:
  - `canonicalize(value: unknown): string` — RFC 8785 («Рішення плану» п. 3);
    кидає на `NaN`, `Infinity`, `undefined` у масиві й самотніх сурогатах.
  - `canonicalSnapshot(model: CompiledModel): unknown` — `{ project, objects: [{ id, kind, name, module, scopeKindId?, data }] (у data кожен MetadataRef за індексом посилань → { kind, id }; вирази конструктора — AST без позицій), scopeKinds, physical, sqlUnits: [{ class, identity, module, tree }], creationOrder, contracts, actions, presentation, modules }`
    — без шляхів файлів, діагностики, сирого SQL.
  - `CompiledModel.hash: string` — hex sha256 від `canonicalize(canonicalSnapshot(model))`
    через `crypto.subtle.digest("SHA-256", …)`.

- [ ] **Step 1: Тести**
- `canonicalize sorts keys by code units and serializes numbers like JCS` —
  порядок ключів — звичайне порівняння рядків (кодові одиниці UTF-16, не
  `localeCompare`), вектори з додатка RFC 8785 (`1E+30` → `1e+30`, `1e-7`,
  `-0` → `0`, юнікодні ключі); `undefined`, `NaN`, `Infinity` — кидає;
- `formatting and comments do not change the hash` — пробіли, регістр
  ключових слів і SQL-коментарі в `.sql`;
- `constant change in a sql function body changes the hash`;
- `renaming a logical name changes the hash`; `key order in a file does not`;
- `hash is stable across map insertion order`.
- [ ] **Step 2: Червоні** — `pnpm --filter simetra test canonical` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): канонічний знімок і sha256-хеш моделі за RFC 8785" --only -- packages/simetra/src/compiler
```

---

### Task 10: Ратчет «поле без споживача»; канон і статус

**Files:**
- Create: `packages/simetra/src/compiler/pipeline.ts`, `__tests__/field-ratchet.test.ts`, `__tests__/fixtures/kitchen-sink.ts`
- Modify: `packages/simetra/src/compiler/compile.ts`
- Modify (канон): `.agents/skills/code-review/references/simetra-domain-criteria.md`, `docs/ROADMAP.md`

**Interfaces:**
- Consumes: усе з задач 1–9.
- Шов: `compile()` ділиться у внутрішньому модулі `compiler/pipeline.ts` на
  `readFiles(files)` (стадія 1, вже є) і `runStages(stage1: FilesStageResult): Promise<CompileResult>`
  (стадії 2–5 і вихід); `compile = files => runStages(readFiles(files))`.
  `pipeline.ts` не експортується з `simetra/compiler` — тест імпортує його
  відносним шляхом; публічний API не змінюється (це не тестовий хук).
- Produces: тест — «kitchen-sink»-проєкт, де кожне поле кожної схеми видів і
  проєкту задане (вкладені включно); між `readFiles` і `runStages` розібрані
  дані загортаються в Proxy, що
  записує прочитані шляхи (масиви — за елементами, шлях нормалізується до
  `kind.field.subfield`); прогін `compile` + `emitEntityTypes` +
  `canonicalSnapshot`; тест порівнює множину шляхів схем (зі Zod-форм) із
  прочитаними і падає з переліком непрочитаних. Службові ключі (`$schema`)
  — у явному списку винятків з коментарем «чому».

- [ ] **Step 1: Тест** — написати; прогнати.
- [ ] **Step 2: Розв'язати сиріт** — кожне непрочитане поле: або споживач у
  відповідній стадії/контракті/кодогені, або видалення зі схеми (без шиму);
  нове рішення, не передбачене «Рішеннями плану» п. 5, — зупинись і спитай
  архітектора (не вигадуй споживача).
- [ ] **Step 3: Зелені** — `pnpm --filter simetra test field-ratchet` PASS; повні гейти.
- [ ] **Step 4: Канон і статус**
- `simetra-domain-criteria.md`: критерій «поле без споживача» — якір на
  `packages/simetra/src/compiler/__tests__/field-ratchet.test.ts`; критерій
  дослівного SQL — гейт класів `sql.statement-not-allowed`.
- `docs/ROADMAP.md`: посилання на план; «Зараз» — D1 виконано, далі D2.

Run: `python3 scripts/check-doc-anchors.py && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`

- [ ] **Step 5: Commit**

```bash
git add packages/simetra .agents docs/ROADMAP.md
git commit -m "test(compiler): ратчет «поле без споживача» для полів метамоделі" --only -- packages/simetra .agents docs/ROADMAP.md
```

---

## Критерії приймання плану D1

- `await compile(files)` повертає модель із SQL-одиницями, порядком
  створення, модулями, діями, контрактами (нумерація включно), блоком
  представлення, фізичним знімком і хешем; діагностики мають `range` і
  перекладаються uk/en.
- Дамп прийнятої схеми з об'єктами провайдера компілюється; заборонені класи
  дають гучну помилку.
- JSON Schema в `packages/simetra/schemas/` актуальні (тест дрейфу).
- Кодоген дає детерміновані логічні типи за спекою §8.5.
- Ратчет зелений: кожне поле метамоделі має споживача.
- Гейти зелені; гард якорів чистий.
