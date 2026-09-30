# П2, план C2 — документ, проведення, регістри: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** компілятор знає проведення й регістри повністю на рівні моделі:
ключі, підсумки й індекси регістрів у фізичному знімку, конструктор рухів як
AST з перевірками, запит рухів як іменований блок у `.sql` документа, обидва
джерела — в одну обгортку-функцію, а контракти оболонки проведення,
віртуальних таблиць і перерахунку підсумків — частина скомпільованої моделі.
Генерація SQL оболонки, тригерів і віртуальних таблиць — П3.

**Архітектура:** T0 — схеми (документ, регістри), реєстр видів (стандартні
ключі й таблиця підсумків), розбір виразів конструктора в AST. T1 — стадія 1
виймає блоки з `.sql`, стадія 2 резолвить імена в AST і блоках, стадія 3 будує
ключі й підсумки, стадія 4 перевіряє семантику рухів, нова стадія 5 — повноту
джерел рухів; обгортки запитів і контракти — вихід компілятора.

**Технології:** TypeScript 7, Zod 4, Vitest 5 — як у планах B і C1. Без нових
залежностей: розбір AST — власний рекурсивний спуск.

**Спека:** [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md) §7
(усе про проведення, ключі, підсумки, віртуальні таблиці, імена функцій —
джерело правил цього плану), §5 («Посилання тип + id», константа-одинак),
§6 (скоуп рухів), §8.2 (стадії 4–5), §8.3 (контракти в знімку), §10.1
(негативні тести), §11 крок 6.

**Серія планів П2:** A, B, C1 (виконано) → **C2** (цей) → D → E.

## Рішення плану (узгоджено з архітектором спеки; модельні — вже в спеці §7)

1. **Хвости C1** беруться сюди першою задачею (рецензент C1 відхилив їх як
   малоймовірні, але кожен — тиха діра): ім'я виду скоупу збігається з
   логічним ім'ям стандартного реквізиту; `crossScope` на колонці
   `CustomTable`; `scopeColumn` у нескоупленої `CustomTable`.
2. **`ResolvedReference.to.kind` `"Column"` → `"Element"`** (реквізит, ТЧ,
   колонка `CustomTable`, поле регістра — усе з UUID усередині об'єкта).
3. **Попередження про `ORDER BY` у блоці запиту** — план D (потрібен розбір
   SQL); у C2 блок не розбирається, лише обгортається.
4. **Форма «вид руху за знаком суми»** і необов'язкові виміри регістра
   відомостей — поза П2 (спека §13).
5. **Стадія 5** з'являється як окремий модуль `stages/links.ts`; у C2 вона
   перевіряє лише джерела рухів; модулі поведінки й функції множини додає D.

## Global Constraints

- Усі обмеження планів B і C1 чинні (чистота T0/T1, UUID v4,
  `chooseConstraintName` для імен, детермінізм, англійські тексти
  діагностики, українські коментарі, без шимів).
- Маркери блоку: рядок, що починається з `-- @movements `, і рядок `-- @end`
  (пробіли на кінці ігноруються); ім'я після маркера — логічне ім'я регістра.
- Параметр обгортки — `p_document_id uuid`; параметри віртуальних таблиць —
  `p_at timestamptz`, `p_from timestamptz`, `p_to timestamptz`.
- Імена похідних функцій — `makeObjectName` + колізія на стадії 4: запит
  рухів `(<документ>, <регістр>, "movements")`; оболонка
  `(<документ>, undefined, "post")` і `(…, "unpost")`; віртуальні таблиці
  `(<регістр>, undefined, "balance" | "balance_and_turnovers" | "turnovers" | "slice_last" | "slice_first")`;
  підсумки — таблиця `(<регістр>, undefined, "totals")`, функції
  `(<регістр>, undefined, "totals_recalculate" | "totals_verify")`.
- Коміти — Conventional Commits, опис українською, без трейлерів.
- Гейти після кожної задачі: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`;
  після правки доків — `python3 scripts/check-doc-anchors.py`.

## Review Focus

1. **Перейменування регістра чи його поля** — маркер `-- @movements <ім'я>`
   і ключі `fields` мусять бути в індексі посилань, інакше каскад D зламає
   їх мовчки. Тести — задачі 4 і 6.
2. **Регістр без вимірів і без скоупу** (один сумарний залишок, одна множина
   значень) — ключ-одинак, а не порожній PK чи помилка. Тест — задача 2.
3. **Ресурс `Integer` зі значенням виразу `Numeric`** (`row.qty * row.price`)
   — `posting.type-mismatch`; навпаки (`Integer → Numeric`) — дозволено.
   Тести — задача 5.
4. **Два джерела рухів одного регістра** (блок і рухи конструктора) чи блок
   для регістра поза `registerMovements` — помилка стадії 5, а не тихий вибір
   одного. Тести — задача 6.
5. **Помилка розбору виразу** вказує на поле з виразом і зміщення в рядку, а
   не на весь файл. Тест — задача 3.

---

### Task 1: Хвости C1 і узагальнення цілі індексу посилань

**Files:**
- Modify: `packages/simetra/src/compiler/stages/identity.ts`, `stages/integrity.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Modify: `packages/simetra/src/model/schemas/custom-table.ts`, `schemas/rules.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-scope-identity.test.ts`, `stage-scope-integrity.test.ts`, `packages/simetra/src/model/__tests__/custom-table.test.ts`

**Interfaces:**
- Produces: `ResolvedReference.to.kind: MetadataKind | "ScopeKind" | "Element"`
  (усі місця, що порівнюють із `"Column"`, переходять на `"Element"`);
  правила: `scope.attribute-name-collision` поширюється на логічні імена
  стандартних реквізитів об'єкта (у стилі проєкту); `customTable.cross-scope-not-allowed`
  (issue T0 — `crossScope` на колонці `CustomTable`: FK там явні);
  `scope.custom-table-column` також коли `scopeColumn` задано, а `scope` —
  `"none"` чи відсутнє.

- [ ] **Step 1: Тести**
- `scope kind named like a standard attribute` — вид скоупу `code` у
  довідника з `codeLength > 0` → `scope.attribute-name-collision`;
- `crossScope on custom table column` → issue `params.rule === "customTable.cross-scope-not-allowed"`;
- `scopeColumn without scope` → `scope.custom-table-column`, pointer `/scopeColumn`;
- наявні тести з `to.kind === "Column"` → `"Element"`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test stage-scope custom-table` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "fix(compiler): хвости скоупу — стандартні імена, crossScope і scopeColumn у CustomTable; ціль Element в індексі посилань"
```

---

### Task 2: Регістри — ключі, підсумки, індекси, контроль залишків

**Files:**
- Modify: `packages/simetra/src/model/schemas/accumulation-register.ts`, `information-register.ts`, `schemas/rules.ts`
- Modify: `packages/simetra/src/model/kinds/standard.ts`, `kinds/accumulation-register.ts`, `kinds/information-register.ts`
- Modify: `packages/simetra/src/compiler/stages/model.ts`, `stages/integrity.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-registers.test.ts`

**Interfaces:**
- Consumes: реєстр видів і стадія 3 (плани B, C1).
- Produces:
  - `accumulationRegisterSchema.balanceControl?: { resources: string[] }` —
    лише для `registerType: "Balance"` (інакше issue `register.balance-control-type`);
    ресурси — логічні імена ресурсів регістра (перевірка стадії 2 —
    `register.balance-control-resource`).
  - `KindDefinition.registerKeys?(obj): RegisterKeySpec` — факт реєстру (стадія
    3 не розгалужується за видом):
    ```ts
    interface RegisterKeySpec {
      movementsPrimaryKey: "recorder" | "dimensions"   // recorder = (recorder_type, recorder_id, line_number)
      dimensionsUnique: boolean                        // UNIQUE (носій скоупу, period?, виміри) поруч із PK рекордера
      dimensionsNotNull: true
      totals: boolean                                  // таблиця поточних підсумків
    }
    ```
    Регістр накопичення: `recorder`, `dimensionsUnique: false`, `totals` —
    `registerType === "Balance"`. Регістр відомостей: підлеглий — `recorder` +
    `dimensionsUnique: true`; незалежний — `dimensions`; `totals: false`.
  - Фізика (спека §7 «Ключі й індекси регістрів»): виміри регістрів і `period`
    регістра відомостей — `NOT NULL`; PK незалежного регістра відомостей —
    `(носій скоупу, period, виміри…)` (частини, яких немає, пропускаються);
    ключ без жодної частини — колонка-одинак `singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)`
    (той самий `StandardColumnDef.singleton`, що в константи); таблиця
    підсумків — `<physicalName регістра>_totals` (ім'я — задача Global
    Constraints), колонки: носій скоупу, виміри (ті самі типи, NOT NULL, ті
    самі FK за правилами C1), ресурси `NOT NULL DEFAULT 0`; PK `(носій скоупу,
    виміри…)` або одинак; `origin` таблиці підсумків —
    `{ objectId, part: "totals" }` (розшир `PhysicalOrigin` полем `part?: "totals"`);
    індекси рухів — `(носій скоупу, виміри…, period)` і `(носій скоупу, period)`
    (правило префікса C1 діє), окремий пошуковий індекс `period` більше не
    будується.
  - Правило стадії 4 `physical.table-duplicate` покриває колізію таблиці
    підсумків (нового коду не треба).

- [ ] **Step 1: Тести**

`stage-registers.test.ts`:
- `accumulation movements key` — PK `(recorder_type, recorder_id, line_number)`,
  виміри `NOT NULL`, індекси `(org_id, warehouse_id, item_id, period)` і
  `(org_id, period)` у скоупленому регістрі; жодного індексу лише на `period`;
- `balance register has totals` — таблиця `stock_totals`: `org_id`, виміри,
  ресурси `numeric(15,3) NOT NULL DEFAULT 0`, PK `(org_id, warehouse_id, item_id)`,
  `origin.part === "totals"`; у оборотного регістра таблиці підсумків немає;
- `degenerate totals key is a singleton` — регістр залишків без вимірів у
  однотенантному проєкті: у `<reg>_totals` PK — `singleton`;
- `independent information register key` — PK `(org_id, period, currency_id)`,
  `period` NOT NULL; неперіодичний — без `period`;
- `subordinate information register` — PK рекордера й
  `UNIQUE (org_id, period, currency_id)`;
- `independent non-periodic register without dimensions or scope` — ключ-одинак;
- `totals table name collision` — довідник із `physicalName: "stock_totals"`
  поруч із регістром `stock` → `physical.table-duplicate`;
- `balanceControl only for balance registers` → `register.balance-control-type`;
  `balanceControl names unknown resource` → `register.balance-control-resource`,
  pointer `/balanceControl/resources/0`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test stage-registers` → FAIL.
- [ ] **Step 3: Реалізація** — за Interfaces.
- [ ] **Step 4: Зелені** — PASS; повні гейти (тести фізики планів B і C1 з
  регістрами оновлюються під нові ключі — зміна очікувана, опиши в коміті).
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): ключі, поточні підсумки й індекси регістрів; контроль залишків як налаштування регістра"
```

---

### Task 3: Конструктор рухів — схема документа й розбір виразів в AST (T0)

**Files:**
- Create: `packages/simetra/src/model/posting/ast.ts`, `posting/parse.ts`, `posting/index.ts`
- Modify: `packages/simetra/src/model/schemas/document.ts`, `schemas/index.ts`, `schemas/rules.ts`, `model/index.ts`, `kinds/document.ts`
- Delete: `packages/simetra/src/model/schemas/posting.ts`, `model/posting-compatibility.ts`, `__tests__/posting-compatibility.test.ts`, `__tests__/condition-expression.test.ts`
- Test: `packages/simetra/src/model/__tests__/posting-parse.test.ts`, `kind-schemas.test.ts` (документ)

**Interfaces:**
- Produces (експорт з `simetra/model`):
  ```ts
  // Вузли несуть [start, end) — зміщення в рядку виразу.
  type Expr =
    | { type: "field"; scope: "doc" | "row"; name: string; start: number; end: number }
    | { type: "sum"; section: string; field: string; start: number; end: number }
    | { type: "count"; section: string; start: number; end: number }
    | { type: "number"; value: string; start: number; end: number }
    | { type: "string"; value: string; start: number; end: number }
    | { type: "boolean"; value: boolean; start: number; end: number }
    | { type: "null"; start: number; end: number }
    | { type: "unary"; op: "-" | "not"; operand: Expr; start: number; end: number }
    | { type: "binary"; op: "+" | "-" | "*" | "/" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or"; left: Expr; right: Expr; start: number; end: number }
  type ParseResult = { ok: true; expr: Expr } | { ok: false; message: string; offset: number }
  function parseExpression(text: string): ParseResult
  ```
  Граматика (пріоритет зростає): `or` < `and` < `not` < порівняння <
  `+ -` < `* /` < унарний `-` < первинні. Ключові слова `and`, `or`, `not`,
  `true`, `false`, `null`, `sum`, `count` — без урахування регістру; рядок —
  `'…'` з подвоєнням `''`; число — `\d+(\.\d+)?`. Аргумент `sum` — лише
  `<ТЧ>.<реквізит>` (без виразу), `count` — лише `<ТЧ>`.
- `documentSchema.posting?: { movements: MovementDecl[] }`, де
  `MovementDecl = { register: MetadataRef, source: "document" | { tabularSection: string }, condition?: string, movementType?: "Receipt" | "Expense" | string, period?: string, fields: Record<string, string> }`;
  `validations` зникає (контроль залишків — задача 2). Рядки-вирази
  розбираються в `superRefine`: помилка → issue `params: { rule: "posting.parse", offset }`,
  path — на поле з виразом (`["posting","movements",i,"fields","qty"]`).
  `movementType` — літерал `Receipt`/`Expense` або вираз.

- [ ] **Step 1: Тести**

`posting-parse.test.ts`:
- `parses precedence` — `row.qty * row.price + doc.delivery` → `binary +` з
  лівим `binary *`;
- `parses aggregates` — `sum(goods.amount)` і `count(goods)`;
- `rejects expression in sum` — `sum(goods.qty * 2)` → `ok: false`, `offset`
  указує на `*`;
- `strings with doubled quotes` — `'it''s'` → value `it's`;
- `keywords are case-insensitive` — `NOT row.active AND doc.posted`;
- `reports offset of unexpected token` — `row.qty +` → `offset === 9`;
- `node spans` — у `doc.date` `start 0`, `end 8`.

`kind-schemas.test.ts` (документ):
- `movement with parse error points at the field` — issue з
  `params.rule === "posting.parse"`, `path` закінчується `"fields","qty"`,
  `params.offset` — число;
- `validations are gone` — розібраний документ не має `posting.validations`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test posting-parse kind-schemas` → FAIL.
- [ ] **Step 3: Реалізація й видалення** — за Interfaces; `kinds/document.ts`
  повертає посилання `movements[].register` з роллю `posting.register`
  (роль `document.postingRegister` зникає).
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add -A packages/simetra/src/model
git commit -m "feat(model): конструктор рухів — плаский fields і розбір виразів в AST; прототипні regex-схеми видалено"
```

---

### Task 4: Стадія 2 — резолв імен у виразах конструктора

**Files:**
- Modify: `packages/simetra/src/compiler/stages/identity.ts`, `packages/simetra/src/model/kinds/standard.ts` (`ReferenceRole`), `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-posting-identity.test.ts`; `__tests__/helpers.ts` (фікстура документа з рухами)

**Interfaces:**
- Consumes: задача 3 (`parseExpression`, `MovementDecl`).
- Produces:
  - ролі: `posting.register` (`to.kind` — вид регістра), `posting.registerField`
    (ключ `fields` → поле регістра, `to.kind: "Element"`, pointer
    `/posting/movements/<i>/fields/<ключ>`; каскад перейменування D знає за
    роллю, що переписувати треба ключ, а не значення), `posting.docField`, `posting.rowField`,
    `posting.tabularSection` (`to.kind: "Element"`; pointer — на поле з
    виразом; зміщення вузла — у `ResolvedReference.span?: { start: number; end: number }`).
    Стандартні реквізити документа (`doc.date`, `doc.ref`, `row.lineNumber`)
    резолвляться в `to: { kind: "Element", id: "<objectId>#<канонічне camelCase-ім'я>" }` —
    стабільний синтетичний id (стандартні реквізити не мають UUID і не
    перейменовуються).
  - Правила: `posting.field-unknown` (поле документа, ТЧ чи рядка ТЧ), 
    `posting.register-field-unknown` (ключ `fields` не є полем регістра),
    `posting.tabular-section-unknown` (у `source` чи агрегаті). Pointer — на
    поле з виразом, `params.offset` — початок вузла.

- [ ] **Step 1: Тести**

`helpers.ts`: `salesDocument()` — документ `Sale` з ТЧ `goods` (`item` Ref,
`qty` Numeric, `amount` Numeric), регістр залишків `Stock` (виміри `item`,
ресурс `qty`, `recorderTypes: [Sale]`) і рух `{ register: Stock, source: { tabularSection: "goods" }, movementType: "Expense", fields: { item: "row.item", qty: "row.qty" } }`.

`stage-posting-identity.test.ts`:
- `resolves movement references` — індекс має `posting.register` (на `Stock`),
  два `posting.registerField`, два `posting.rowField` (на UUID `item`, `qty`
  рядка), `posting.tabularSection` (на UUID `goods`);
- `standard document field resolves to synthetic id` — `period: "doc.date"` →
  `to.id === "<id Sale>#date"`;
- `unknown row field` — `row.qtty` → `posting.field-unknown`, pointer
  `/posting/movements/0/fields/qty`, `params.offset === 0`;
- `unknown register field key` — `fields.quantity` →
  `posting.register-field-unknown`, pointer `/posting/movements/0/fields/quantity`;
- `unknown tabular section` — `source: { tabularSection: "services" }` →
  `posting.tabular-section-unknown`, pointer `/posting/movements/0/source/tabularSection`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test stage-posting-identity` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): стадія 2 — резолв імен у виразах конструктора рухів в індекс посилань"
```

---

### Task 5: Стадія 4 — семантика рухів і типи виразів

**Files:**
- Create: `packages/simetra/src/compiler/posting-types.ts`
- Modify: `packages/simetra/src/compiler/stages/integrity.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-posting-integrity.test.ts`

**Interfaces:**
- Consumes: задачі 2–4.
- Produces:
  - `inferType(expr: Expr, ctx: PostingContext): InferredType` де
    `InferredType = { kind: "numeric"; integer: boolean } | { kind: "text" } | { kind: "boolean" } | { kind: "date" } | { kind: "ref"; targets: string[] } | { kind: "null" } | { kind: "unknown" }`:
    `number` — `integer: !value.includes(".")`; `+ - * /` — numeric (integer,
    якщо обидва integer і оператор не `/`); `count` — integer; `sum` — тип
    реквізиту; поле — з його логічного типу (`Ref` → targets UUID-и цілей;
    `Date`/`DateTime` → date; `String`/`Text` → text); порівняння й логіка —
    boolean.
  - Правила стадії 4 (severity error): `posting.register-undeclared` (регістр
    руху не в `registerMovements`); `posting.recorder-not-allowed` (документ не
    в `recorderTypes` регістра); `posting.fields-incomplete` (регістр
    накопичення — усі виміри й ресурси; регістр відомостей — виміри й
    `required`-ресурси; `params.missing` — перелік); `posting.row-in-document-source`
    (`row.` із джерелом `document`); `posting.aggregate-in-section-source`
    (`sum`/`count` із джерелом ТЧ); `posting.movement-type` (відсутній у
    регістра залишків чи присутній у інших; вираз не text); `posting.type-mismatch`
    (ресурс регістра накопичення — numeric, `Integer`-ресурс не приймає
    неціле; поле регістра відомостей — той самий тип; `Ref` — ті самі цілі або
    `null`; `condition` — boolean; `period` — date).

- [ ] **Step 1: Тести**

`stage-posting-integrity.test.ts` — по тесту на кожне правило (code,
pointer), серед них:
- `integer resource rejects numeric expression` — ресурс `Integer`, вираз
  `row.qty * row.price` (Numeric) → `posting.type-mismatch`;
- `numeric resource accepts integer` — ресурс `Numeric`, вираз `count(goods)` → чисто;
- `ref field requires the same target` — вимір `item` → `Item`, вираз
  `row.warehouse` (Ref на `Warehouse`) → `posting.type-mismatch`;
- `condition must be boolean` — `condition: "row.qty"` → `posting.type-mismatch`, pointer `/posting/movements/0/condition`;
- `fields incomplete lists missing` — без `item` → `posting.fields-incomplete`, `params.missing === "item"`;
- `movement type required for balance register` / `forbidden for turnover register`;
- `document not among recorders` → `posting.recorder-not-allowed`;
- `register not declared in registerMovements` → `posting.register-undeclared`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test stage-posting-integrity` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): стадія 4 — семантика рухів конструктора й типи виразів"
```

---

### Task 6: Блоки запиту рухів і стадія 5 — повнота джерел

**Files:**
- Create: `packages/simetra/src/compiler/stages/links.ts`, `compiler/movement-blocks.ts`
- Modify: `packages/simetra/src/compiler/stages/files.ts`, `stages/identity.ts`, `compile.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`, `packages/simetra/src/model/kinds/standard.ts` (`ReferenceRole`)
- Test: `packages/simetra/src/compiler/__tests__/movement-blocks.test.ts`, `stage-links.test.ts`

**Interfaces:**
- Produces:
  - `extractMovementBlocks(text: string): { blocks: { register: string; sql: string; line: number }[]; errors: { message: string; line: number }[] }`
    — рядки між маркерами (без самих маркерів), `line` — 1-базний рядок
    маркера; помилки: маркер без `-- @end`, вкладений `-- @movements`,
    `-- @end` без відкриття, порожнє ім'я.
  - Стадія 1: для `.sql` документа — блоки в `ParsedObject.movementBlocks`;
    помилки → `file.movements-block` (pointer `""`, `params.line`); блоки в
    `.sql` не-документа чи в `sql/<схема>/` → `file.movements-block`.
  - Стадія 2: ім'я регістра маркера резолвиться (за логічним ім'ям регістра
    будь-якого виду регістра) → роль `posting.movementsBlock`
    (`from.pointer` — `""`, `ResolvedReference.line?: number`); невідоме —
    `reference.unresolved` з `params.line`.
  - Стадія 5 (`checkLinks`): для кожного регістра з `registerMovements` рівно
    одне джерело — `posting.source-missing` (немає ні блоку, ні руху
    конструктора), `posting.source-ambiguous` (обидва, чи два блоки одного
    регістра); блок для регістра поза `registerMovements` — `posting.register-undeclared`.
    `compile` запускає стадію 5 після 4, коли 1–2 без помилок.

- [ ] **Step 1: Тести**

`movement-blocks.test.ts`:
- `extracts named blocks and keeps line numbers`;
- `rest of the file is not a block` — SQL поза маркерами не потрапляє в блоки;
- `unterminated block`, `nested marker`, `stray end` — по помилці з `line`.

`stage-links.test.ts`:
- `query block satisfies register` — документ з `registerMovements: [Stock]`,
  без конструктора, `Sale.sql` з блоком `Stock` → `ok: true`;
- `missing source` → `posting.source-missing`, pointer `/registerMovements/0`;
- `both sources` → `posting.source-ambiguous`;
- `block for undeclared register` → `posting.register-undeclared`;
- `block marker is indexed` — індекс має `posting.movementsBlock` на `Stock`
  з `line`;
- `block in a catalog sql file` → `file.movements-block`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test movement-blocks stage-links` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): блоки запиту рухів у .sql документа і стадія 5 — рівно одне джерело рухів"
```

---

### Task 7: Обгортки запитів рухів і переклад конструктора

**Files:**
- Create: `packages/simetra/src/compiler/movement-functions.ts`
- Modify: `packages/simetra/src/compiler/compile.ts` (`CompiledModel.sqlUnits`)
- Test: `packages/simetra/src/compiler/__tests__/movement-functions.test.ts`

**Interfaces:**
- Consumes: задачі 2–6, фізичний знімок.
- Produces:
  - `CompiledModel.sqlUnits: SqlUnit[]`, `interface SqlUnit { kind: "movementQuery"; schema: string; name: string; documentId: string; registerId: string; source: "query" | "constructor"; sql: string }`
    (сортування — `(schema, name)`; дослівні `.sql`-одиниці й топологічний
    порядок — план D/E).
  - Обгортка (спека §7):
    ```sql
    CREATE OR REPLACE FUNCTION <схема документа>.<ім'я>(p_document_id uuid)
    RETURNS TABLE (<колонки рухів регістра мінус recorder_type, recorder_id, line_number, active і носій скоупу — у порядку таблиці рухів, "<ім'я>" <PG-тип>>)
    LANGUAGE sql STABLE
    AS $simetra$
    <тіло>
    $simetra$;
    ```
    Для блоку тіло — текст блоку як є. Для конструктора — `SELECT`-и рухів
    регістра через `UNION ALL`, кожен: колонки в порядку `RETURNS TABLE`;
    `period` — вираз руху або `d.date`, для періодичного регістра відомостей —
    `date_trunc('<day|month|quarter|year>', …)`; `movement_type` — літерал чи
    вираз; поля з `fields`; незмаплене необов'язкове — `NULL::<тип>`;
    `FROM <таблиця документа> d` (джерело шапка) або
    `FROM <таблиця ТЧ> r JOIN <таблиця документа> d ON d.id = r.parent_id`
    (джерело ТЧ) з `WHERE d.id = p_document_id` і `AND (<condition>)`;
    `sum(<ТЧ>.<реквізит>)` → `(SELECT COALESCE(sum(t.<колонка>), 0) FROM <таблиця ТЧ> t WHERE t.parent_id = d.id)`,
    `count(<ТЧ>)` → `(SELECT count(*) FROM <таблиця ТЧ> t WHERE t.parent_id = d.id)`;
    `doc.x` → `d.<фізичне ім'я>`, `row.x` → `r.<фізичне ім'я>`; літерали —
    SQL-літерали; `and/or/not` → `AND/OR/NOT`. Порядок рядків (оболонка
    нумерує рухи за ним) SQL після `UNION ALL` не гарантує, тож кожен `SELECT`
    додає службові `<i> AS __movement` (індекс руху) і `r.line_number AS __line`
    (для шапки — `0`), а зовнішній запит —
    `SELECT <колонки> FROM (<SELECT-и через UNION ALL>) m ORDER BY m.__movement, m.__line`.
    Ідентифікатори — `quoteIdent`.
  - Функція детермінована: той самий вхід — побайтно той самий `sql`.

- [ ] **Step 1: Тести**

`movement-functions.test.ts` — порівняння з еталонними рядками (inline
snapshot `toMatchInlineSnapshot` для читабельності):
- `wraps a query block` — `RETURNS TABLE (period timestamp with time zone, movement_type text, item_id uuid, qty numeric(15,3))`, тіло — блок як є;
- `translates constructor movement from tabular section`;
- `union of two movements into one register`;
- `aggregate from document source`;
- `periodic information register truncates period` — `date_trunc('month', d.date)`;
- `deterministic output` — два прогони дають однаковий `sql`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test movement-functions` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): обгортки запитів рухів і переклад конструктора в той самий запит"
```

---

### Task 8: Контракти проведення й регістрів; колізії імен функцій; канон

**Files:**
- Create: `packages/simetra/src/compiler/contracts.ts`
- Modify: `packages/simetra/src/compiler/compile.ts`, `stages/integrity.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/contracts.test.ts`
- Modify (канон): `AGENTS.md` § «Metamodel rules» (рядок про регістри), `.agents/skills/code-review/references/simetra-domain-criteria.md`, `docs/ROADMAP.md`

**Interfaces:**
- Produces `CompiledModel.contracts`:
  ```ts
  interface Contracts { posting: PostingContract[]; registers: RegisterContract[] }
  interface PostingContract {
    documentId: string
    post: QualifiedName; unpost: QualifiedName          // QualifiedName = { schema: string; name: string }
    movements: { registerId: string; source: "query" | "constructor"; function: QualifiedName }[]
    balanceControl: { registerId: string; resources: string[] }[]   // фізичні імена ресурсів
  }
  interface RegisterContract {
    registerId: string
    movements: QualifiedName; totals?: QualifiedName
    virtualTables: { kind: "balance" | "balanceAndTurnovers" | "turnovers" | "sliceLast" | "sliceFirst"; function: QualifiedName;
                     parameters: { name: "p_at" | "p_from" | "p_to"; type: "timestamp with time zone" }[];
                     columns: { name: string; type: string }[] }[]
    totalsMaintenance?: { recalculate: QualifiedName; verify: QualifiedName }
    balanceControl?: { resources: string[] }
  }
  ```
  Віртуальні таблиці: регістр залишків — `balance(p_at)` (виміри + ресурси),
  `balanceAndTurnovers(p_from, p_to)` (виміри + для кожного ресурсу
  `<r>_opening`, `<r>_receipt`, `<r>_expense`, `<r>_closing`); оборотний —
  `turnovers(p_from, p_to)` (виміри + ресурси); періодичний регістр відомостей
  — `sliceLast(p_at)` і `sliceFirst(p_at)` (period, виміри, ресурси,
  реквізити). Сортування — за id.
- Правило стадії 4: `physical.function-duplicate` — ім'я функції контракту чи
  обгортки збігається з іншою функцією чи таблицею в тій самій PG-схемі.

- [ ] **Step 1: Тести**

`contracts.test.ts`:
- `posting contract of a document` — `post`/`unpost` імена, рух `Stock` з
  `source: "constructor"` і функцією з задачі 7, `balanceControl` з фізичним
  іменем ресурсу;
- `balance register contract` — `totals`, `virtualTables` `balance` і
  `balanceAndTurnovers` з колонками `qty_opening…qty_closing`,
  `totalsMaintenance`;
- `turnover and information registers` — `turnovers`; `sliceLast`/`sliceFirst`
  лише в періодичного;
- `function name collision` — довідник `physicalName: "stock_balance"` поруч
  із регістром залишків `stock` → `physical.function-duplicate`.

- [ ] **Step 2: Червоні** — `pnpm --filter simetra test contracts` → FAIL.
- [ ] **Step 3: Реалізація.**
- [ ] **Step 4: Зелені** — PASS; повні гейти.
- [ ] **Step 5: Канон і статус**
- `AGENTS.md` § «Metamodel rules», рядок про ролі полів регістрів: додай, що
  рухи пишуть лише запит рухів чи конструктор документа, а ключі, підсумки й
  віртуальні таблиці регістра — стандартні елементи виду (спека П2 §7).
- `simetra-domain-criteria.md`: критерій «posting and condition DSL» —
  переписати під AST (`packages/simetra/src/model/posting/`) і блоки запиту;
  рецензент шукає вираз, що обходить AST, чи рух, що пише оболонкові колонки.
- `docs/ROADMAP.md`: посилання на план; «Зараз» — C2 виконано, далі D.

Run: `python3 scripts/check-doc-anchors.py && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`

- [ ] **Step 6: Commit**

```bash
git add packages/simetra AGENTS.md .agents docs/ROADMAP.md
git commit -m "feat(compiler): контракти проведення й регістрів у скомпільованій моделі"
```

---

## Критерії приймання плану C2

- Документ із рухами (блоком чи конструктором) компілюється в обгортку-функцію
  з контрактом, виведеним із регістра; конструктор і блок дають однаковий
  `RETURNS TABLE`.
- Регістри мають ключі, підсумки (регістр залишків) і індекси за спекою §7.
- Кожен негативний тест проведення зі спеки §10.1 («оголошений регістр без
  запиту рухів») червоніє своїм правилом.
- Прототипні regex-схеми DSL і `posting-compatibility` видалено.
- Гейти зелені; гард якорів чистий.
