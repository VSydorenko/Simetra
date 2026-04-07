# Task: DDL Generator — Deferred FK + Kind-Prefix Naming

## Контекст

При виконанні згенерованого SQL на Supabase виникає помилка:  
`ERROR: 42P01: relation "document_post" does not exist`

Аналіз виявив **дві системні помилки** у `packages/generator-pg`:

1. **Forward FK Reference** — inline `REFERENCES` на таблицю, що ще не створена (catalog → document).
2. **Cross-Kind Name Collision** — `InformationRegister.X` та `AccumulationRegister.X` генерують однакову фізичну таблицю.

Зворотна сумісність НЕ потрібна — жодної існуючої бази даних немає. Перероблюємо генератор і все.

## Вимоги

### Bug 1 — Deferred FK Constraints

- [ ] `type-mapping.ts:refToColumn()` НЕ додає `REFERENCES target(id)` inline. Повертає лише `sqlType: "uuid"` для single Ref
- [ ] Кожне місце, де генерується колонка з FK, **збирає** метаінформацію (source table, column, target table) у колектор
- [ ] `generateProjectDDL()` додає нову секцію **"FOREIGN KEYS"** після секції "TABLES", перед "INDEXES"
- [ ] Секція "FOREIGN KEYS" містить `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES ...`
- [ ] Конвенція іменування FK constraint: `fk_{source_table}_{column_name}`
- [ ] FK генеруються для: single Ref атрибутів, owner_id, parent_id, recorder_id (де applicable)
- [ ] Порядок секцій: ENUM TYPES → TABLES → **FOREIGN KEYS** → INDEXES → VIEWS → TRIGGERS → POSTING FUNCTIONS

### Bug 2 — Kind-Prefix Table Naming

- [ ] `naming.ts:tableName()` приймає додатковий параметр `kind: MetadataKind` і додає kind-prefix
- [ ] Маппінг kind → prefix:
  - `Catalog` → `cat_`
  - `Document` → `doc_`
  - `Enumeration` → `enum_` (для lookupTable стратегії)
  - `InformationRegister` → `ir_`
  - `AccumulationRegister` → `ar_`
  - `Constant` → `const_` (для separateTables стратегії)
  - `CustomTable` → `ct_`
- [ ] Kind-prefix додається **після** project-wide `tablePrefix` і **перед** snake_case назвою: `{tablePrefix}{kindPrefix}{snake_case_name}`
- [ ] Приклад: prefix="" → `cat_products`, `ir_currencies_exchange_rates`, `ar_currencies_exchange_rates`
- [ ] Приклад: prefix="erp_" → `erp_cat_products`, `erp_doc_sales_order`
- [ ] Оновити `tabularTableName()` — таблична частина має успадковувати kind-prefix від батьківської таблиці
- [ ] Оновити `buildRefTableLookup()` та `buildEnumTypeLookup()` — передавати kind
- [ ] Оновити `generateEnumeration()` — CREATE TYPE name теж має kind-prefix для lookupTable
- [ ] Оновити всі виклики `tableName()` по всьому generator-pg, включно з `generate-posting.ts`
- [ ] Constants singleTable: таблиця називається `{prefix}const_settings` (або аналогічне фіксоване ім'я)

### Тести

- [ ] Тест: catalog → document FK (forward reference) генерує `ALTER TABLE ... ADD CONSTRAINT`
- [ ] Тест: document → catalog FK генерує `ALTER TABLE ... ADD CONSTRAINT`
- [ ] Тест: self-reference (catalog → self) генерує правильний FK
- [ ] Тест: `InformationRegister.X` + `AccumulationRegister.X` генерують різні таблиці (`ir_x` / `ar_x`)
- [ ] Тест: kind-prefix в іменах таблиць для **кожного** kind
- [ ] Тест: kind-prefix з project-wide tablePrefix
- [ ] Тест: табличні частини success-case з kind-prefix
- [ ] Тест: posting функції використовують правильні kind-prefixed імена таблиць
- [ ] Оновити всі існуючі тести, що зламаються через зміну імен таблиць та deferred FK
- [ ] Тест у `naming.test.ts` для нового signature `tableName(prefix, kind, name)`

### Оновлення ddl-store (apps/web)

- [ ] `ddl-store.ts:collectValidationErrors()` — не потребує змін (broken refs перевіряються вже зараз)
- [ ] Переконатися, що SQL preview panel показує оновлені імена таблиць і deferred FK

## Clarify (питання перед імплементацією)

- [ ] Константи з singleTable стратегією: яке ім'я для загальної таблиці? `const_settings`? `const_constants`?
  - Чому це важливо: kind-prefix `const_` + objectName collision
  - Варіанти: `const_settings` / без kind-prefix для singleTable (бо одна таблиця)
  - Вплив на рішення: naming convention

- [ ] Enum type name (pgEnum): чи CREATE TYPE з kind-prefix? `enum_order_status` чи `order_status`?
  - Чому це важливо: PostgreSQL TYPE namespace — глобальний в schema
  - Варіанти: A) `enum_` prefix завжди / B) без prefix для TYPE (бо TYPE ≠ TABLE)
  - Вплив на рішення: naming convention, backward compatibility

- [ ] FK constraint name для standard attrs (owner_id, parent_id): яка конвенція?
  - Чому це важливо: consistency across generated SQL
  - Варіанти: `fk_{table}_{column}` для всіх однаково
  - Вплив на рішення: naming convention

## Рекомендовані патерни

### Deferred FK Collection

Створити допоміжний інтерфейс `ForeignKeyDef` та масив-колектор. Кожна функція генерації таблиці (generateCatalog, generateDocument, тощо) додає записи FK у колектор замість inline REFERENCES. Після всіх таблиць — емісія ALTER TABLE.

### Kind-Prefix Mapping

Створити простий `Record<MetadataKind, string>` маппінг і використовувати його в `tableName()`. Маппінг має бути в `naming.ts` як єдине джерело правди — **НЕ** дублювати його в інших файлах.

### Мінімальні зміни в type-mapping.ts

`refToColumn()` має лише повертати `sqlType: "uuid"` без constraints для non-enum single Ref. FK-інформацію збирає caller (generate-table.ts), а не type-mapping.

## Антипатерни (уникати)

### ❌ Topological Sort замість Deferred FK
Сортування таблиць за графом залежностей не вирішує циклічні залежності (A→B→A) і значно складніше. Deferred FK — стандартне рішення в DDL генераторах.

### ❌ Kind-prefix як опціональна фіча
Не робити kind-prefix конфігурабельним через прапорець — це ускладнює тестування і створює два паралельних шляхи. Зворотна сумісність не потрібна.

### ❌ Валідація cross-kind uniqueness замість kind-prefix
Заборона однакових імен між різними kind-ами — занадто обмежувальне рішення. Kind-prefix вирішує колізію архітектурно, не обмежуючи користувача.

### ❌ Дублювання kind-prefix маппінгу
НЕ хардкодити `cat_`, `doc_` і т.д. у кожній generateXxx-функції. Єдиний маппінг — в `naming.ts`.

### ❌ Зміна core schemas для цього фіксу
Не потрібно додавати `superRefine` у `projectModelSchema` або змінювати щось у `packages/core/` — проблема повністю в generator-pg.

## Архітектурні рішення

```
generateProjectDDL()
  │
  ├── 1. fileHeader()
  ├── 2. generateEnumeration()           ── ENUM TYPES
  ├── 3. generateCatalog()               ── TABLES (без inline FK)
  │      └─ збирає FK у fkCollector
  ├── 4. generateDocument()              ── TABLES
  │      └─ збирає FK у fkCollector
  ├── 5. generateInfoRegister()          ── TABLES
  │      └─ збирає FK у fkCollector
  ├── 6. generateAccRegister()           ── TABLES
  │      └─ збирає FK у fkCollector
  ├── 7. generateConstants()             ── TABLES
  ├── 8. generateCustomTable()           ── TABLES
  │      └─ збирає FK у fkCollector
  ├── 9. emitForeignKeys(fkCollector)    ── FOREIGN KEYS  ← НОВА СЕКЦІЯ
  ├── 10. collectIndexes()               ── INDEXES
  ├── 11. generateViews()                ── VIEWS
  ├── 12. generateTriggers()             ── TRIGGERS
  └── 13. generatePostingFunctions()     ── POSTING FUNCTIONS
```

### Зміна signature tableName

```
До:   tableName(prefix, objectName) → "products"
Після: tableName(prefix, kind, objectName) → "cat_products"
```

### FK output format

```sql
-- ============================================================
-- FOREIGN KEYS
-- ============================================================

ALTER TABLE cat_products
  ADD CONSTRAINT fk_cat_products_default_warehouse_id
  FOREIGN KEY (default_warehouse_id) REFERENCES cat_warehouses(id);

ALTER TABLE doc_sales_order
  ADD CONSTRAINT fk_doc_sales_order_product_id
  FOREIGN KEY (product_id) REFERENCES cat_products(id);
```

## Scope змін (файли)

| Файл | Зміни |
|------|-------|
| `packages/generator-pg/src/naming.ts` | Додати kind-prefix маппінг, змінити signature `tableName()` |
| `packages/generator-pg/src/type-mapping.ts` | `refToColumn()` прибрати inline REFERENCES для non-enum single Ref |
| `packages/generator-pg/src/generate-table.ts` | FK колектор, нова секція FOREIGN KEYS, передача kind у tableName |
| `packages/generator-pg/src/generate-posting.ts` | Передача kind у tableName |
| `packages/generator-pg/src/__tests__/naming.test.ts` | Тести kind-prefix |
| `packages/generator-pg/src/__tests__/type-mapping.test.ts` | Оновити тести (без inline REFERENCES) |
| `packages/generator-pg/src/__tests__/generate-table.test.ts` | Додати forward-ref тест, name collision тест, оновити існуючі |
| `packages/generator-pg/src/__tests__/generate-posting.test.ts` | Оновити table names з kind-prefix |

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `docs/BRD-metadata-configurator.md` — бізнес-вимоги, секція 7 (JSON format), секція 5 (types)
- `docs/tasks/phase2a-ddl-generator.md` — оригінальна специфікація (рядок 93: FK constraints як окрема фаза)
- `packages/generator-pg/src/naming.ts` — поточний naming
- `packages/generator-pg/src/type-mapping.ts` — поточний inline FK
- `packages/generator-pg/src/generate-table.ts` — головна функція генерації
- `.github/instructions/architecture-core.instructions.md` — архітектурні правила
- `.github/instructions/coding-style.instructions.md` — конвенції коду

## Definition of Done

- [ ] `pnpm --filter @simetra/generator-pg test` — всі тести проходять
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm lint` — без помилок
- [ ] Forward FK reference (catalog → document) більше не генерує inline REFERENCES
- [ ] SQL містить секцію FOREIGN KEYS з ALTER TABLE ... ADD CONSTRAINT
- [ ] `InformationRegister.X` та `AccumulationRegister.X` генерують різні назви таблиць
- [ ] Кожен kind має свій prefix у фізичних іменах таблиць
- [ ] Згенерований SQL успішно виконується на PostgreSQL при будь-якому порядку cross-kind references
- [ ] Posting функції використовують оновлені імена таблиць
- [ ] Існуючі тести оновлені під нову схему іменування
- [ ] Нові тести покривають обидва баги
