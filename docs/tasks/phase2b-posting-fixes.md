# Task: Phase 2b — Виправлення posting engine (code review findings)

## Контекст

Code review Phase 2b Posting Engine виявив 7 проблем у трьох пакетах (`@simetra/core`, `@simetra/generator-pg`, `apps/web`). Головна причина: `generate-posting.ts` будує SQL незалежно від DDL-генератора (`generate-table.ts`), що призводить до невідповідності стовпців, ігнорування register-specific налаштувань та SQL injection вектору через поле `condition`.

**Severity breakdown:** 1 CRITICAL, 3 HIGH, 2 MEDIUM, 1 LOW.

**Масштаб:** переважно `packages/generator-pg/src/generate-posting.ts` + супутні зміни в core та web.

---

## Вимоги

### PROBLEM 1 — Column resolution mismatch (CRITICAL)

- [ ] `expressionToSql` має додавати `_id` суфікс для Ref-атрибутів при перетворенні `doc.field` → `d.field_id`
- [ ] Polymorphic recorder (`recorder_id_type` + `recorder_id_id` у DDL) має коректно транслюватися в INSERT та DELETE statements
- [ ] DELETE statements (`WHERE recorder_id = p_doc_id`) мають використовувати правильну колонку для polymorphic recorder
- [ ] Маппінг Ref-атрибутів у dimensions/resources/attributes (`doc.warehouse` → `d.warehouse_id`) має відповідати DDL

### PROBLEM 2 — Hardcoded standard attribute columns (HIGH)

- [ ] Набір standard columns (`period`, `recorder_id`, `line_number`, `active`, `movement_type`) має визначатися динамічно на основі типу та налаштувань регістру
- [ ] InformationRegister з `writeMode=Independent` не має отримувати `recorder_id`, `line_number`, `active`
- [ ] InformationRegister ніколи не має отримувати `movement_type`
- [ ] AccumulationRegister з `registerType=Turnovers` не має отримувати `movement_type`
- [ ] Набір standard columns в INSERT має збігатися з DDL (визначається через `getStandardAttributes` з core)

### PROBLEM 3 — applyTo field ignored (HIGH)

- [ ] `generateCheckFunction` має фільтрувати рухи за `movement_type` відповідно до `applyTo` (Receipt / Expense / Both)
- [ ] Validation loop (`SELECT DISTINCT`) має фільтрувати записи за `movement_type` відповідно до `applyTo`
- [ ] `applyTo = "Both"` → без фільтра (поточна поведінка)
- [ ] `applyTo = "Receipt"` → `WHERE movement_type = 'Receipt'` в check function та DISTINCT query
- [ ] `applyTo = "Expense"` → аналогічно для `'Expense'`

### PROBLEM 4 — Condition field SQL injection (HIGH)

- [ ] Поле `condition` в `postingMovementSchema` має бути захищене від SQL injection
- [ ] `translateCondition` не має виконувати raw string interpolation незахищених рядків
- [ ] Core schema має валідувати condition або перейти на structured representation

### PROBLEM 5 — Register picker InformationRegister compatibility (MEDIUM)

- [ ] `RegisterPickerDialog` має фільтрувати InformationRegister за `writeMode === "RecorderSubordinate"` (тільки ці регістри підтримують posting)
- [ ] `use-model-validation.ts` має попереджати про InformationRegister з `writeMode !== "RecorderSubordinate"` в posting.movements

### PROBLEM 6 — Expression validation gaps (MEDIUM)

- [ ] `isExpressionInvalid` має бути винесений з dialog у shared utility
- [ ] Валідація має перевіряти не лише source-context (row.* vs document), а й існування полів у target register

### PROBLEM 7 — Aggregate options missing standard TS fields (LOW)

- [ ] `buildExpressionOptions` секція агрегатів має включати стандартні реквізити ТЧ (`line_number`) з `getTabularSectionStandardAttributes()`, а не лише `ts.attributes`

---

## Clarify (питання перед імплементацією)

- [ ] **Яка граматика condition expression?**
  - Чому це важливо: condition — це WHERE clause fragment, що потребує складнішої валідації ніж mappingExpression. Поточний формат — raw string, який інтерполюється в SQL
  - Варіанти:
    - (A) Regex-whitelist: `(doc|row)\.\w+\s*(=|!=|>|<|>=|<=)\s*('[\w\s]+'|\d+)(\s+(AND|OR)\s+...)*`
    - (B) Structured schema: `z.array(z.object({ left, operator, right, combinator }))` — eliminates injection by design
    - (C) Використати mappingExpressionSchema + оператори порівняння як розширення граматики
  - Вплив на рішення: архітектура core schema + generator translation + UI condition input
  - Рекомендація: варіант (B) — structured condition найбезпечніший, але вимагає зміни UI condition input. Варіант (A) — мінімальний, але крихкий

- [ ] **Чи потрібно підтримувати InformationRegister з writeMode=Independent для posting?**
  - Чому це важливо: такий регістр не має recorder_id — пряме записування рухів неможливе
  - Варіанти: (A) Заборонити повністю в UI та core, (B) Підтримати з auto-create recorder_id
  - Вплив на рішення: core validation rules, UI filter, generator logic
  - Рекомендація: (A) — заборонити, це відповідає семантиці проведення

- [ ] **Як обробляти expressionToSql fallback?**
  - Чому це важливо: зараз невідомий вираз повертається as-is (рядок ~66), що може генерувати невалідний SQL
  - Варіанти: (A) Throw error, (B) Повернути SQL-коментар з warning, (C) Повернути NULL
  - Вплив на рішення: runtime behavior генератора
  - Рекомендація: (A) — throw, бо schema вже валідує формат виразу

---

## Рекомендовані патерни

### Shared column resolution utility (generator-pg)

Екстрагувати логіку маппінгу attribute → SQL column name з `generate-table.ts` у shared utility в `generator-pg`. Використовувати і в `generate-table.ts`, і в `generate-posting.ts`. Правила:
- Single Ref (не enum) → `{name}_id`
- Polymorphic Ref → `{name}_type` + `{name}_id`
- Enum Ref → `{name}` (без суфікса)
- Все інше → `toSnakeCase(name)`

Utility **має жити в `generator-pg`**, не в core — маппінг attribute → SQL column є генераторною відповідальністю.

### Dynamic standard columns через getStandardAttributes

Замість hardcoded масиву `['period', 'recorder_id', 'line_number', 'active', 'movement_type']` — викликати `getStandardAttributes(register.kind, registerSettings)` з core і маппити результат у SQL columns. Це гарантує синхронність з DDL генератором, який використовує ту саму функцію.

### Register metadata propagation в expressionToSql

`expressionToSql` потребує доступу до метаданих регістру (dimensions, resources, attributes) для правильного маппінгу Ref-полів. Рекомендовано передавати `RegisterDef` як параметр (register вже доступний у `generateMovementInsert`).

### Structured condition schema (якщо обрано варіант B)

Замість raw string condition — масив об'єктів:
```
{ left: "doc.status", operator: "=", right: "literal:Active", combinator: "AND" }
```
Це eliminates SQL injection by design і спрощує translation у SQL.

### Posting compatibility validation в core

Функція `validatePostingCompatibility(register)` у core — returns validation result з причиною несумісності. Використовується в UI (register picker filter), model validation, і generator guard.

---

## Антипатерни (уникати)

### ❌ Дублювання DDL-логіки в posting generator

НЕ повторювати правила `_id` suffix, polymorphic columns, enum detection в `generate-posting.ts` — екстрагувати shared utility з `generate-table.ts`.

### ❌ Regex-only захист для SQL condition

Regex-based whitelist для WHERE clause fragments — крихкий і складний для підтримки. Structured representation — надійніший, але потребує зміни schema.

### ❌ Hardcoded column set для всіх типів регістрів

Не припускати, що всі регістри мають однаковий набір standard attributes. InformationRegister та AccumulationRegister мають різні набори залежно від settings.

### ❌ Silent fallback у expressionToSql

Повертання невідомого виразу as-is (`return expr`) маскує помилки і може генерувати невалідний SQL. Потрібен explicit error.

### ❌ Зміна core API для column resolution

Core працює з metadata, не з SQL. Не додавати SQL-специфічну логіку (`_id` suffix) в `@simetra/core`.

### ❌ Фільтрація регістрів тільки в UI

`RegisterPickerDialog` не повинен бути єдиним guard для writeMode-несумісних регістрів. Validation має бути і в core (для model validation), і в generator (guard перед генерацією).

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
resolveColumnName(attr)  ─── generator-pg: shared utility для attribute → SQL column
       │
       ├──► generate-table.ts (DDL: CREATE TABLE)
       └──► generate-posting.ts (DML: INSERT/DELETE/SELECT)
```

### Posting-compatible register filter

```
registerDef (AccumulationRegister | InformationRegister)
       │
       ▼
validatePostingCompatibility(register)  ─── core: returns { compatible: boolean, reason? }
       │
       ├──► RegisterPickerDialog (UI: filter incompatible)
       ├──► use-model-validation.ts (warning for incompatible in posting.movements)
       └──► generate-posting.ts (skip/warn for incompatible)
```

### Condition expression lifecycle

```
UI condition input
       │
       ▼
conditionExpressionSchema / structured condition schema  ─── core: Zod validation
       │
       ▼
translateCondition(condition, aliases)  ─── generator-pg: safe translation
       │
       ▼
SQL WHERE clause (escaped / parameterized)
```

---

## Фази виконання

### Фаза 1: Core schema fixes

**Scope:** `packages/core/src/schemas/posting.ts`, можливо новий файл для posting compatibility

- [ ] Додати валідацію для `condition` field (regex або structured schema — залежно від Clarify)
- [ ] Створити `validatePostingCompatibility(register)` utility:
  - InformationRegister: `writeMode === "RecorderSubordinate"` → compatible
  - AccumulationRegister: завжди compatible
- [ ] Додати тести: condition validation (valid/invalid), posting compatibility (IR independent → incompatible, IR recorder → compatible, AR → compatible)
- [ ] `pnpm --filter @simetra/core test` — green

### Фаза 2: Generator fixes (CRITICAL + HIGH)

**Scope:** `packages/generator-pg/src/generate-posting.ts`, можливо shared utility

#### 2.1. Column resolution (PROBLEM 1)

- [ ] Екстрагувати shared utility для attribute → SQL column name з `generate-table.ts`
- [ ] Адаптувати `expressionToSql`:
  - Приймати register metadata як параметр
  - Для `doc.field` та `row.field` — резолвити через register metadata: якщо target field є Ref → додати `_id`
  - Для polymorphic Ref → враховувати `_type`/`_id` пару
- [ ] Адаптувати DELETE statements:
  - Для polymorphic recorder → `WHERE recorder_id_type = '{DocKind}.{DocName}' AND recorder_id_id = p_doc_id`
  - Для single recorder → `WHERE recorder_id = p_doc_id` (or `recorder_id_id`)
- [ ] Замінити fallback `return expr` на explicit error (throw або SQL comment)

#### 2.2. Dynamic standard columns (PROBLEM 2)

- [ ] Замінити hardcoded масив `['period', 'recorder_id', ...]` на виклик `getStandardAttributes(register.kind, settings)`
- [ ] Маппити standard attributes через shared column resolution utility
- [ ] Адаптувати SELECT expressions для standard columns:
  - `d.date` для `period` (якщо register має period)
  - `d.id` для `recorder_id` (якщо register має recorder)
  - `ts.line_number` або `1` для `line_number` (якщо register має)
  - `TRUE` для `active` (якщо register має)
  - `mvtTypeExpr` для `movement_type` (тільки AccumulationRegister.Balance)

#### 2.3. applyTo filter (PROBLEM 3)

- [ ] `generateCheckFunction`: додати `WHERE movement_type = ...` відповідно до `applyTo` (кожен з Receipt/Expense/Both)
- [ ] Validation loop в `generatePostFunction`: додати filter до `SELECT DISTINCT` query

#### 2.4. Condition safety (PROBLEM 4, generator side)

- [ ] Якщо core валідація structured — адаптувати `translateCondition` для structured input
- [ ] Якщо core валідація regex — додати додатковий sanitization layer у `translateCondition`
- [ ] Забезпечити що condition не може містити SQL keywords (DROP, DELETE, INSERT, UPDATE, ALTER, EXEC, --, /*, ;)

#### 2.5. Тести генератора

- [ ] Golden test: AccumulationRegister.Balance з Ref dimension → INSERT має `warehouse_id` (не `warehouse`)
- [ ] Golden test: polymorphic recorder → DELETE з `recorder_id_type` + `recorder_id_id`
- [ ] Golden test: InformationRegister.RecorderSubordinate → correct standard columns (no `movement_type`)
- [ ] Golden test: AccumulationRegister.Turnovers → correct standard columns (no `movement_type`)
- [ ] Test: applyTo=Receipt → check function має `WHERE movement_type = 'Receipt'`
- [ ] Test: applyTo=Expense → check function має `WHERE movement_type = 'Expense'`
- [ ] Test: applyTo=Both → check function без movement_type filter
- [ ] Test: invalid expression → throw error (не silent fallback)
- [ ] `pnpm --filter @simetra/generator-pg test` — green

### Фаза 3: Web fixes

**Scope:** `apps/web/src/`

#### 3.1. Register picker filter (PROBLEM 5)

- [ ] `RegisterPickerDialog` — фільтрувати InformationRegister за `writeMode === "RecorderSubordinate"` або використовувати `validatePostingCompatibility` з core
- [ ] `use-model-validation.ts` — додати warning якщо posting.movements містить incompatible register

#### 3.2. Expression validation (PROBLEM 6)

- [ ] Витягнути `isExpressionInvalid` з `movement-constructor-dialog.tsx` у `build-expression-options.ts` (або окремий файл)
- [ ] Додати перевірку існування полів: `doc.fieldName` — чи `fieldName` є серед document attributes/standard attrs; `row.fieldName` — чи `fieldName` є серед TS attributes/standard attrs

#### 3.3. Aggregate options (PROBLEM 7)

- [ ] `buildExpressionOptions` — у секції агрегатів додати стандартні реквізити ТЧ з `getTabularSectionStandardAttributes()` до `sum()` опцій (зараз ітерує тільки `ts.attributes`)

#### 3.4. Web тести

- [ ] Test: `buildExpressionOptions` aggregate includes `sum(TsName.line_number)`
- [ ] Test: register picker excludes IR with writeMode=Independent
- [ ] `pnpm --filter web test` — green

### Фаза 4: Verification

- [ ] `pnpm lint ; pnpm typecheck` — clean
- [ ] `pnpm test` — all green
- [ ] Manual review: SQL output для golden fixtures (GoodsReceipt, PaymentOrder) має відповідати DDL

---

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `docs/architecture/metadata-model.md` — модель метаданих, standard attributes, posting semantics
- `docs/BRD-metadata-configurator.md` §5.3.1 — специфікація posting metadata
- `docs/tasks/phase2b-posting-engine.md` — оригінальна задача Phase 2b
- `docs/tasks/posting-cleanup-and-findreferences.md` — cleanup boolean posting (вже виконана)
- `.github/instructions/architecture-core.instructions.md` — core package rules
- `.github/instructions/metadata-model.instructions.md` — Zod schema rules

### Ключові файли для зміни

| Файл | Проблеми |
|------|----------|
| `packages/core/src/schemas/posting.ts` | P4 (condition), P5 (compatibility) |
| `packages/generator-pg/src/generate-posting.ts` | P1, P2, P3, P4 |
| `packages/generator-pg/src/generate-table.ts` | P1 (extract shared utility) |
| `apps/web/src/components/editor/register-picker-dialog.tsx` | P5 |
| `apps/web/src/components/editor/movement-constructor-dialog.tsx` | P6 |
| `apps/web/src/lib/build-expression-options.ts` | P6, P7 |
| `apps/web/src/hooks/use-model-validation.ts` | P5 |

---

## Definition of Done

- [ ] Генерований SQL для AccumulationRegister.Balance з Ref-dimensions має правильні `_id` суфікси
- [ ] Генерований SQL для polymorphic recorder має `recorder_id_type` + `recorder_id_id`
- [ ] InformationRegister.RecorderSubordinate генерує правильний набір standard columns (без `movement_type`)
- [ ] AccumulationRegister.Turnovers генерує правильний набір standard columns (без `movement_type`)
- [ ] Check function фільтрує за `applyTo` (Receipt / Expense / Both)
- [ ] Condition field має schema-level validation (не raw string)
- [ ] `expressionToSql` не має silent fallback — invalid expression → explicit error
- [ ] Register picker не показує InformationRegister з `writeMode=Independent`
- [ ] Model validation попереджає про incompatible registers в posting
- [ ] `buildExpressionOptions` агрегати включають стандартні TS fields
- [ ] Expression validation перевіряє існування полів
- [ ] Всі golden тести генератора оновлені під нову поведінку
- [ ] `pnpm test` — all green
- [ ] `pnpm lint ; pnpm typecheck` — clean
