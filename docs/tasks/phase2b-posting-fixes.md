# Task: Phase 2b — Виправлення posting engine (code review findings)

## Контекст

Code review Phase 2b Posting Engine виявив 9 проблем у чотирьох пакетах/шарах (`@simetra/core`, `@simetra/generator-pg`, `apps/web` включно з `ddl-store`). Головна причина: `generate-posting.ts` будує SQL незалежно від DDL-генератора (`generate-table.ts`), що призводить до невідповідності стовпців, ігнорування register-specific налаштувань та SQL injection вектору через поле `condition`.

**Бізнес-контекст:** негативний баланс по регістрах — абсолютно нормальне явище. Контроль визначається **прикладним кодом рішення** (як у 1С), а не на рівні регістра. `NonNegativeBalance` — це перевірка рівня **документа**, не обмеження типу регістра. Будь-який тип регістра (Balance, Turnover, IR RecorderSubordinate) може бути target для такої перевірки.

**Severity breakdown:** 1 CRITICAL, 4 HIGH, 2 MEDIUM, 2 LOW.

**Масштаб:** `packages/generator-pg/src/generate-posting.ts` + shared utility, `packages/core/` (helper + schema), `apps/web/` (picker, validation, ddl-store, expression utils).

---

## Вимоги

### PROBLEM 1 — Column resolution mismatch (CRITICAL)

- [ ] Екстрагувати `resolveColumnName` і `resolveStdColumnName` з `generate-table.ts` у shared `packages/generator-pg/src/column-naming.ts`
- [ ] `expressionToSql` має приймати register metadata як параметр і резолвити Ref-атрибути:
  - Single Ref (не enum) → `{name}_id`
  - Enum Ref → `{name}` (без суфікса)
  - Polymorphic Ref → throw error (не підтримується mapping grammar)
- [ ] `generateMovementInsert` має резолвити column names через shared utility замість `toSnakeCase`
- [ ] DELETE statements мають перевіряти polymorphic recorder:
  - Single recorder → `WHERE recorder_id = p_doc_id`
  - Polymorphic recorder → `WHERE recorder_id_type = '{DocKind}.{DocName}' AND recorder_id_id = p_doc_id`
- [ ] Використати shared utility і в `generate-table.ts` (index/view generation) замість локальних функцій

### PROBLEM 2 — Hardcoded standard attribute columns (HIGH)

- [ ] Замінити hardcoded масив `['period', 'recorder_id', 'line_number', 'active', 'movement_type']` на виклик `getStandardAttributes(register.kind, registerSettings)` з core
- [ ] Побудувати `registerSettings` з register object: для IR — `periodicity`, `writeMode`, `recorderTypes`; для AR — `registerType`, `recorderTypes`
- [ ] Маппити standard attributes через shared column-naming utility (для polymorphic recorder → `recorder_id_type` + `recorder_id_id`)
- [ ] Адаптувати SELECT expressions per register kind:
  - `period` → `d.date` (якщо register має period)
  - `recorder_id` → `d.id` (single) або `'{DocKind}.{DocName}'` + `d.id` (polymorphic)
  - `line_number` → `ts.line_number` (tabularSection source) або `1` (document source)
  - `active` → `TRUE`
  - `movement_type` → `mvtTypeExpr` (тільки для AccumulationRegister Balance)
- [ ] InformationRegister ніколи не має отримувати `movement_type`
- [ ] AccumulationRegister `registerType=Turnover` не має отримувати `movement_type`

### PROBLEM 3 — applyTo field ignored + register-aware check function (HIGH)

- [ ] `generateCheckFunction` має адаптуватися до типу регістра:
  - AccumulationRegister Balance: `CASE WHEN movement_type = 'Receipt' THEN resource ELSE -resource END` (поточна логіка, правильна)
  - AccumulationRegister Turnover: `SUM(resource)` без CASE (немає movement_type колонки)
  - InformationRegister RecorderSubordinate: `SUM(resource)` без CASE
- [ ] `applyTo` фільтр у check function — тільки для Balance регістрів (де існує movement_type):
  - `applyTo = "Both"` → без додаткового WHERE
  - `applyTo = "Receipt"` → `AND movement_type = 'Receipt'`
  - `applyTo = "Expense"` → `AND movement_type = 'Expense'`
- [ ] Для регістрів без movement_type (Turnover, IR) — `applyTo` ігнорується (фільтрувати нема чим)
- [ ] Validation loop (`SELECT DISTINCT`) має включати `applyTo` filter для Balance регістрів
- [ ] NonNegativeBalance НЕ обмежується тільки Balance регістрами — це бізнес-перевірка рівня документа
- [ ] Для NonNegativeBalance з non-numeric resource — generator має throw error

### PROBLEM 4 — Condition field SQL injection (HIGH)

- [ ] Додати `conditionExpressionSchema` в core — regex-based DSL:
  - Дозволено: `(doc|row).\w+`, оператори `=|!=|>|<|>=|<=`, літерали `'...'|number|true|false|null`, зв'язки `AND|OR`
  - Заборонено: SQL keywords, крапки з комою, коментарі, вкладені запити
- [ ] `translateCondition` у generator має працювати через **програмний SQL-builder** з regex-matched частин, а **не через String.replace**
- [ ] Generator додатково блокує SQL keywords як другий шар захисту: `DROP`, `DELETE`, `INSERT`, `UPDATE`, `ALTER`, `EXEC`, `--`, `/*`, `;`, `UNION`
- [ ] Structured AST — планувати як наступну фазу, не в scope цієї задачі

### PROBLEM 5 — Register posting compatibility (MEDIUM)

- [ ] Створити `isPostingCompatible(register)` helper у `packages/core/src/posting-compatibility.ts`:
  - AccumulationRegister → завжди compatible
  - InformationRegister `writeMode=RecorderSubordinate` → compatible
  - InformationRegister `writeMode=Independent` → incompatible (reason: no recorder lifecycle)
- [ ] Enforcement на 4 рівнях:
  - `RegisterPickerDialog` — фільтрувати incompatible registers з дерева вибору
  - `use-model-validation.ts` — warning якщо posting.movements містить incompatible register
  - `ddl-store.ts` — blocking error перед генерацією
  - `generate-posting.ts` — assert/throw перед генерацією INSERT

### PROBLEM 6 — Expression validation gaps + Save blocking (MEDIUM)

- [ ] Екстрагувати `isExpressionInvalid` з `movement-constructor-dialog.tsx` у `apps/web/src/lib/expression-validation.ts`
- [ ] Додати `validateExpressionFields(expr, source, doc, register)` — перевірка існування полів:
  - `doc.fieldName` → перевірити серед `getStandardAttributes("Document")` (без id) та `doc.attributes`
  - `row.fieldName` → перевірити серед `getTabularSectionStandardAttributes()` (без id) та `ts.attributes`
  - `sum(tsName.fieldName)` і `count(tsName)` → перевірити існування ТЧ
- [ ] **Блокувати Save** якщо хоча б один mapping expression невалідний (зараз Save не блокується — тільки візуальна індикація)
- [ ] Validation активується тільки для non-empty expressions (щоб не блокувати draft-стан)

### PROBLEM 7 — Aggregate options missing standard TS fields (LOW)

- [ ] `buildExpressionOptions` секція агрегатів має включати стандартні реквізити ТЧ (`line_number`) з `getTabularSectionStandardAttributes()`, а не лише `ts.attributes`
- [ ] Skip `id` з standard TS attrs (не має сенсу як aggregate target)

### PROBLEM 8 — Термінологічна помилка (LOW)

- [ ] Виправити "Turnovers" → "Turnover" у всіх місцях кодової бази та документації (core enum value: `z.enum(["Balance", "Turnover"])`)

### PROBLEM 9 — Architectural gaps: ddl-store + fail-fast (HIGH)

- [ ] `ddl-store.ts` (`collectValidationErrors`) — додати blocking перевірки:
  - Posting compatibility: IR з writeMode=Independent → blocking error
  - Incomplete mappings: всі NOT NULL dimensions регістру мають мати mapping → blocking error
  - Resource type для NonNegativeBalance: якщо resource не Numeric/Integer → blocking error
- [ ] Generator — **fail-fast**, не skip/warn: якщо generator отримує incompatible register або невалідний expression → `throw Error`
- [ ] `expressionToSql` fallback (рядок ~66): замінити `return expr` на throw з повідомленням про невідомий формат
- [ ] `use-model-validation.ts` — warning для incomplete mappings (не blocking, бо draft-flow)

---

## Clarify (питання перед імплементацією)

### Вирішені питання

- [Х] **Яка граматика condition expression?**
  - **Рішення: regex-based DSL (варіант A) + програмний SQL-builder у generator**
  - Чому: structured AST (варіант B) — правильніший довгостроково, але для MVP вимагає зміну persisted формату + UI. Regex DSL + програмний builder (не String.replace) + SQL keyword blocklist — достатній рівень захисту
  - Міграція на structured AST — у наступній фазі

- [Х] **Чи підтримувати InformationRegister з writeMode=Independent для posting?**
  - **Рішення: заборонити (варіант A)**
  - Чому: IR Independent не має recorder_id — recorder lifecycle неможливий. Це відповідає семантиці 1С (РВ з незалежним режимом не може бути ціллю рухів)
  - Enforcement: picker filter + model-validation warning + ddl-store blocking + generator assert

- [Х] **Як обробляти expressionToSql fallback?**
  - **Рішення: throw error (варіант A)**
  - Чому: schema вже валідує формат виразу, silent fallback маскує помилки

- [Х] **Чи обмежувати NonNegativeBalance тільки Balance регістрами?**
  - **Рішення: НЕ обмежувати**
  - Чому: негативний баланс по регістрах — нормальне явище. NonNegativeBalance — це бізнес-перевірка рівня документа (як у 1С). Будь-який тип регістра (Balance, Turnover, IR) може бути target
  - Для AR.Balance: check function з CASE WHEN movement_type
  - Для AR.Turnover та IR: check function з простим SUM (без CASE WHEN, бо немає movement_type)

### Вирішені з follow-up документуванням

- [Х] **Семантика NonNegativeBalance для InformationRegister**
  - **Рішення: дозволити з простим SUM, задокументувати семантику**
  - IR не має руху Receipt/Expense. Check function: `SUM(resource) GROUP BY dimensions >= 0`
  - Follow-up: додати коментар у generator code та docs/architecture/metadata-model.md з описом семантики для кожного типу регістра

- [Х] **applyTo для регістрів без movement_type**
  - **Рішення: ігнорувати applyTo мовчки**
  - Для AR.Turnover і IR колонки movement_type немає — фільтрувати нема чим. applyTo залишається в schema для Balance-use-case, для Turnover/IR просто не має ефекту
  - Follow-up: додати коментар у generator code з поясненням чому applyTo не використовується

---

## Рекомендовані патерни

### Shared column resolution utility (generator-pg)

Екстрагувати логіку маппінгу attribute → SQL column name з `generate-table.ts` у shared `packages/generator-pg/src/column-naming.ts`. Використовувати і в `generate-table.ts`, і в `generate-posting.ts`. Правила:
- Single Ref (не enum) → `{name}_id`
- Polymorphic Ref → `{name}_type` + `{name}_id`
- Enum Ref → `{name}` (без суфікса)
- Все інше → `toSnakeCase(name)`

Utility **має жити в `generator-pg`**, не в core — маппінг attribute → SQL column є генераторною відповідальністю.

### Dynamic standard columns через getStandardAttributes

Замість hardcoded масиву `['period', 'recorder_id', 'line_number', 'active', 'movement_type']` — викликати `getStandardAttributes(register.kind, registerSettings)` з core і маппити результат у SQL columns. Це гарантує синхронність з DDL генератором, який використовує ту саму функцію.

### Register metadata propagation в expressionToSql

`expressionToSql` потребує доступу до метаданих регістру (dimensions, resources, attributes) для правильного маппінгу Ref-полів. Передавати `RegisterDef` як параметр (register вже доступний у `generateMovementInsert`).

### Regex-based condition DSL + програмний SQL-builder

Condition expression як regex-validated DSL у core. Generator парсить regex matches і будує SQL **програмно** — не через `String.replace`, а через extracted tokens → SQL expression builder. Regex визначає граматику, generator будує SQL безпечно з матчів. SQL keyword blocklist як другий шар захисту.

### Posting compatibility — 4-layer validation stack

Відповідає існуючому патерну broken refs validation. Кожен шар має різну роль:

| Шар | Роль | Коли спрацьовує |
|-----|------|-----------------|
| Picker filter | UX guidance — не показувати incompatible | При відкритті RegisterPickerDialog |
| model-validation | Warning у StatusBar | Debounced, при зміні моделі |
| ddl-store | Blocking error — зупиняє генерацію | При натисканні Generate DDL |
| generator assert | Last-resort safety net | При виклику generate функції |

### Register-aware check function

Check function для NonNegativeBalance має різну SQL-структуру залежно від типу регістра:
- **Balance:** `CASE WHEN movement_type = 'Receipt' THEN +res ELSE -res END` — з applyTo-фільтром
- **Turnover:** `SUM(resource)` без CASE WHEN — applyTo ігнорується
- **IR RecorderSubordinate:** `SUM(resource)` без CASE WHEN — applyTo ігнорується

---

## Антипатерни (уникати)

### ❌ Дублювання DDL-логіки в posting generator

НЕ повторювати правила `_id` suffix, polymorphic columns, enum detection в `generate-posting.ts` — екстрагувати shared utility з `generate-table.ts`.

### ❌ String.replace для translateCondition

`translateCondition` НЕ повинен працювати через наївний `String.replace` — це маскує структуру виразу і дозволяє injection bypasses. Тільки програмний SQL-builder з regex-parsed tokens.

### ❌ Hardcoded column set для всіх типів регістрів

Не припускати, що всі регістри мають однаковий набір standard attributes. InformationRegister та AccumulationRegister мають різні набори залежно від settings.

### ❌ Silent fallback у expressionToSql

Повертання невідомого виразу as-is (`return expr`) маскує помилки і може генерувати невалідний SQL. Потрібен explicit error.

### ❌ Зміна core API для column resolution

Core працює з metadata, не з SQL. Не додавати SQL-специфічну логіку (`_id` suffix) в `@simetra/core`.

### ❌ Фільтрація регістрів тільки в UI

`RegisterPickerDialog` не повинен бути єдиним guard для writeMode-несумісних регістрів. Validation має бути на 4 рівнях: picker → model-validation → ddl-store → generator.

### ❌ Skip/warn замість fail-fast у generator

Generator НЕ повинен пропускати incompatible registers або невалідні expressions з коментарем/warning у SQL. Тільки `throw Error`. DDL-store вже ловить ці ситуації раніше — throw у генераторі це second safety net.

### ❌ Обмеження NonNegativeBalance тільки Balance регістрами

NonNegativeBalance — це бізнес-перевірка документа, а не обмеження типу регістра. Будь-який тип регістра (Balance, Turnover, IR) може бути target. Різниця — в SQL-структурі check function, не в дозволеності.

---

## Архітектурні рішення

### Потік даних column resolution

```
register metadata (core)
       │
       ▼
getStandardAttributes(kind, settings)  ─── core: source of truth для набору standard attrs
       │
       ▼
resolveColumnName(attr)  ─── generator-pg/src/column-naming.ts: shared utility
       │
       ├──► generate-table.ts (DDL: CREATE TABLE, indexes, views)
       └──► generate-posting.ts (DML: INSERT/DELETE/SELECT)
```

### Posting-compatible register — 4-layer enforcement

```
registerDef (AccumulationRegister | InformationRegister)
       │
       ▼
isPostingCompatible(register)  ─── core/src/posting-compatibility.ts: pure helper
       │
       ├──► RegisterPickerDialog (UI: filter incompatible з дерева)
       ├──► use-model-validation.ts (warning у StatusBar)
       ├──► ddl-store.ts (blocking error перед генерацією)
       └──► generate-posting.ts (assert/throw — last-resort safety net)
```

### Register-aware check function

```
NonNegativeBalance validation
       │
       ├── target: AR Balance
       │     └── CASE WHEN movement_type = 'Receipt' THEN +res ELSE -res END
       │         + applyTo filter (WHERE movement_type = ...)
       │
       ├── target: AR Turnover
       │     └── SUM(resource) — без CASE WHEN, applyTo ігнорується
       │
       └── target: IR RecorderSubordinate
             └── SUM(resource) — без CASE WHEN, applyTo ігнорується
```

### Condition expression lifecycle

```
UI condition input
       │
       ▼
conditionExpressionSchema (regex DSL)  ─── core: Zod validation (граматика)
       │
       ▼
parseConditionTokens(condition)  ─── generator-pg: regex match → tokens
       │
       ▼
buildConditionSql(tokens, aliases)  ─── generator-pg: програмний builder (не String.replace)
       │
       ▼
SQL WHERE clause (побудований програмно, не інтерпольований)
```

---

## Фази виконання

### Фаза 1: Core schema + helper

**Scope:** `packages/core/src/schemas/posting.ts`, новий `packages/core/src/posting-compatibility.ts`

- [ ] Додати `conditionExpressionSchema` — regex-based DSL validation для condition field
- [ ] Замінити `z.string().nullable().optional()` для condition на `conditionExpressionSchema.nullable().optional()`
- [ ] Створити `isPostingCompatible(register)` у `packages/core/src/posting-compatibility.ts`:
  - AccumulationRegister → compatible
  - InformationRegister `writeMode=RecorderSubordinate` → compatible
  - InformationRegister `writeMode=Independent` → incompatible (reason string)
- [ ] Експортувати `isPostingCompatible` з `packages/core/src/index.ts`
- [ ] Тести: condition validation (valid patterns, invalid/injection patterns), posting compatibility (IR independent → incompatible, IR recorder → compatible, AR both types → compatible)
- [ ] `pnpm --filter @simetra/core test` — green

### Фаза 2: Generator fixes (CRITICAL + HIGH)

**Scope:** `packages/generator-pg/src/generate-posting.ts`, новий `packages/generator-pg/src/column-naming.ts`

#### 2.1. Shared column-naming utility (PROBLEM 1)

- [ ] Екстрагувати `resolveColumnName` і `resolveStdColumnName` з `generate-table.ts` у `packages/generator-pg/src/column-naming.ts`
- [ ] Оновити `generate-table.ts` — імпортувати з нового модуля замість локальних функцій
- [ ] Адаптувати `expressionToSql`:
  - Додати параметр `register: RegisterDef`
  - Для `doc.field` та `row.field` — резолвити target field через register metadata + shared utility
  - Для polymorphic Ref як mapping target → throw error
- [ ] Адаптувати `generateMovementInsert` — column names через shared utility замість `toSnakeCase`
- [ ] Адаптувати DELETE statements — перевірка polymorphic recorder:
  - Single → `WHERE recorder_id = p_doc_id`
  - Polymorphic → `WHERE recorder_id_type = '{DocKind}.{DocName}' AND recorder_id_id = p_doc_id`
- [ ] Замінити fallback `return expr` на throw з повідомленням

#### 2.2. Dynamic standard columns (PROBLEM 2)

- [ ] Замінити hardcoded масив на `getStandardAttributes(register.kind, settings)` з core
- [ ] Побудувати registerSettings з register object
- [ ] Маппити standard attributes через shared column-naming utility
- [ ] Адаптувати SELECT expressions per register kind (period, recorder_id, line_number, active, movement_type)

#### 2.3. Register-aware check function + applyTo (PROBLEM 3)

- [ ] `generateCheckFunction` — різна SQL-структура per register type:
  - AR Balance: `CASE WHEN movement_type = 'Receipt' THEN +res ELSE -res END`
  - AR Turnover: `SUM(resource)` без CASE WHEN
  - IR RecorderSubordinate: `SUM(resource)` без CASE WHEN
- [ ] `applyTo` фільтр — тільки для Balance (де існує movement_type):
  - Both → без WHERE; Receipt → `AND movement_type = 'Receipt'`; Expense → аналогічно
- [ ] Для Turnover/IR — `applyTo` ігнорується
- [ ] NonNegativeBalance з non-numeric resource → throw error
- [ ] Validation loop — `applyTo` filter у `SELECT DISTINCT` query для Balance

#### 2.4. Condition safety (PROBLEM 4, generator side)

- [ ] Замінити `translateCondition` на програмний flow: `parseConditionTokens` → `buildConditionSql`
  - `parseConditionTokens`: regex match → масив структурованих tokens (left, op, right, combinator)
  - `buildConditionSql`: програмна побудова SQL з tokens + aliases (не String.replace)
- [ ] Додати SQL keyword blocklist як другий шар захисту
- [ ] Додати assert перед генерацією: `isPostingCompatible(register)` — throw якщо incompatible

#### 2.5. Тести генератора

- [ ] Golden test: AR.Balance з Ref dimension → INSERT має `warehouse_id` (не `warehouse`)
- [ ] Golden test: polymorphic recorder → DELETE з `recorder_id_type` + `recorder_id_id`
- [ ] Golden test: IR.RecorderSubordinate → correct standard columns (без `movement_type`)
- [ ] Golden test: AR.Turnover → correct standard columns (без `movement_type`)
- [ ] Test: check function AR.Balance — CASE WHEN movement_type
- [ ] Test: check function AR.Turnover — SUM без CASE WHEN
- [ ] Test: applyTo=Receipt → check function має `WHERE movement_type = 'Receipt'`
- [ ] Test: applyTo=Expense → check function має `WHERE movement_type = 'Expense'`
- [ ] Test: applyTo=Both → check function без movement_type filter
- [ ] Test: invalid expression → throw error (не silent fallback)
- [ ] Test: condition з SQL injection patterns → throw або block
- [ ] `pnpm --filter @simetra/generator-pg test` — green

### Фаза 3: Web fixes

**Scope:** `apps/web/src/`

#### 3.1. Register picker + model validation (PROBLEM 5)

- [ ] `RegisterPickerDialog` — фільтрувати через `isPostingCompatible` з core (видалити incompatible з дерева)
- [ ] `use-model-validation.ts` — додати warning якщо posting.movements містить incompatible register
- [ ] `use-model-validation.ts` — додати warning для incomplete mappings (не blocking, draft-flow)

#### 3.2. DDL store — blocking checks (PROBLEM 9)

- [ ] `ddl-store.ts` (`collectValidationErrors`) — додати:
  - Posting compatibility check через `isPostingCompatible` → blocking error
  - Incomplete mappings: всі NOT NULL dimensions мають мати mapping → blocking error
  - Resource type для NonNegativeBalance: non-numeric resource → blocking error

#### 3.3. Expression validation + Save blocking (PROBLEM 6)

- [ ] Екстрагувати `isExpressionInvalid` з `movement-constructor-dialog.tsx` у `apps/web/src/lib/expression-validation.ts`
- [ ] Додати `validateExpressionFields(expr, source, doc, register)` — перевірка існування полів у source (doc attrs, TS attrs, standard attrs)
- [ ] Блокувати Save при невалідних expressions (зараз — тільки візуальна індикація)
- [ ] Validation активується тільки для non-empty expressions

#### 3.4. Aggregate options (PROBLEM 7)

- [ ] `buildExpressionOptions` — додати стандартні реквізити ТЧ з `getTabularSectionStandardAttributes()` до sum() опцій (skip `id`)

#### 3.5. Web тести

- [ ] Test: `buildExpressionOptions` aggregate includes `sum(TsName.line_number)`
- [ ] Test: register picker excludes IR with writeMode=Independent
- [ ] Test: expression validation blocks Save on invalid expression
- [ ] `pnpm --filter web test` — green

### Фаза 4: Terminology + Verification

- [ ] Виправити "Turnovers" → "Turnover" у всіх місцях кодової бази та документації (PROBLEM 8)
- [ ] `pnpm lint ; pnpm typecheck` — clean
- [ ] `pnpm test` — all green
- [ ] Manual review: SQL output для golden fixtures має відповідати DDL

---

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `docs/architecture/metadata-model.md` — модель метаданих, standard attributes, posting semantics
- `docs/architecture/patterns-and-decisions.md` — архітектурні рішення, defense-in-depth
- `docs/BRD-metadata-configurator.md` §5.3.1 — специфікація posting metadata
- `docs/BRD-metadata-configurator.md` §5.5–5.6 — AccumulationRegister (movement_type тільки для Balance), InformationRegister (writeMode)
- `docs/tasks/phase2b-posting-engine.md` — оригінальна задача Phase 2b
- `docs/tasks/posting-cleanup-and-findreferences.md` — cleanup boolean posting (вже виконана)
- `docs/research/Завдання 1 Повна карта метаданих 1СПідприємство 8.3.md` — 1С reference: контроль залишків = прикладна логіка
- `.github/instructions/architecture-core.instructions.md` — core package rules
- `.github/instructions/metadata-model.instructions.md` — Zod schema rules

### Ключові файли для зміни

| Файл | Проблеми |
|------|----------|
| `packages/core/src/schemas/posting.ts` | P4 (conditionExpressionSchema) |
| `packages/core/src/posting-compatibility.ts` | P5 (новий — isPostingCompatible helper) |
| `packages/core/src/index.ts` | P5 (export isPostingCompatible) |
| `packages/generator-pg/src/column-naming.ts` | P1 (новий — shared utility) |
| `packages/generator-pg/src/generate-posting.ts` | P1, P2, P3, P4, P9 |
| `packages/generator-pg/src/generate-table.ts` | P1 (рефакторинг — імпорт з column-naming) |
| `apps/web/src/components/editor/register-picker-dialog.tsx` | P5 |
| `apps/web/src/components/editor/movement-constructor-dialog.tsx` | P6 (екстракція isExpressionInvalid) |
| `apps/web/src/lib/expression-validation.ts` | P6 (новий — shared expression validation) |
| `apps/web/src/lib/build-expression-options.ts` | P7 |
| `apps/web/src/hooks/use-model-validation.ts` | P5, P9 |
| `apps/web/src/stores/ddl-store.ts` | P5, P9 |

_Таблиця non-exhaustive — тести та файли імпортів не включені._

---

## Definition of Done

### Generator correctness
- [ ] Генерований SQL для AR.Balance з Ref-dimensions має правильні `_id` суфікси
- [ ] Генерований SQL для polymorphic recorder має `recorder_id_type` + `recorder_id_id`
- [ ] IR.RecorderSubordinate генерує правильний набір standard columns (без `movement_type`)
- [ ] AR.Turnover генерує правильний набір standard columns (без `movement_type`)
- [ ] Check function для AR.Balance використовує `CASE WHEN movement_type`
- [ ] Check function для AR.Turnover використовує простий `SUM` (без CASE WHEN)
- [ ] Check function для IR.RecorderSubordinate використовує простий `SUM` (без CASE WHEN)
- [ ] Check function фільтрує за `applyTo` тільки для Balance (де є movement_type)
- [ ] `expressionToSql` не має silent fallback — invalid expression → throw
- [ ] Generator fail-fast: incompatible register або invalid input → throw Error

### Security
- [ ] Condition field має `conditionExpressionSchema` validation (regex DSL, не raw string)
- [ ] `translateCondition` замінений на програмний SQL-builder (не String.replace)
- [ ] SQL keyword blocklist як другий шар захисту

### Validation layers
- [ ] Register picker не показує IR з `writeMode=Independent`
- [ ] Model validation попереджає про incompatible registers в posting
- [ ] Model validation попереджає про incomplete mappings
- [ ] DDL store блокує генерацію для incompatible registers
- [ ] DDL store блокує генерацію для incomplete mappings
- [ ] DDL store блокує генерацію для NonNegativeBalance з non-numeric resource

### UI
- [ ] `buildExpressionOptions` агрегати включають стандартні TS fields (`line_number`)
- [ ] Expression validation перевіряє існування полів у source
- [ ] Expression validation блокує Save при невалідних expressions

### Terminology
- [ ] "Turnovers" виправлено на "Turnover" у всій кодовій базі та документації

### Quality gate
- [ ] Всі golden тести генератора оновлені під нову поведінку
- [ ] `pnpm test` — all green
- [ ] `pnpm lint ; pnpm typecheck` — clean
