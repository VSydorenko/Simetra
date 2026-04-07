# Task: Physical Naming + Late-Emitted FK + Enum Naming Fix

## Контекст

При виконанні згенерованого SQL на PostgreSQL/Supabase виникають дві системні помилки:

1. **Forward FK Reference** — inline `REFERENCES` на таблицю, що ще не створена (наприклад, catalog → document). Помилка: `relation "..." does not exist`.
2. **Cross-Kind Name Collision** — `InformationRegister.X` та `AccumulationRegister.X` генерують однакову фізичну таблицю.

Додатково виявлено **enum naming drift**: `generate-posting.ts` хардкодить `` `enum_${toSnakeCase(ref.name)}` `` у 3 місцях, ігноруючи `tablePrefix` і `schema` — результат розходиться з `generate-table.ts`.

### Масштаб змін

Це **не** чистий bugfix. Bug 1 — локальний DDL fix. Bug 2 — зміна canonical physical naming contract генератора. Enum drift — consistency fix. Задача розбита на 3 фази з окремими цілями і DoD.

### Обмеження

- Зворотна сумісність **НЕ потрібна** — жодної існуючої бази даних немає
- У roadmap — підтримка MSSQL як другого target. Рішення мають бути переносимі, але **НЕ** створювати передчасних абстракцій для MSSQL зараз
- `database.target` у core зараз `z.literal("postgresql")` — це не змінюється в цій задачі

---

## Phase A: Core Physical Naming

**Мета:** Додати в `@simetra/core` canonical маппінг `MetadataKind → kind-prefix` і shared naming utilities, які будуть використовуватися всіма генераторами.

**Обґрунтування:** Core вже містить два прецеденти `Record<MetadataKind, string>`: `KIND_SLUG` для $schema URL у `serialization.ts` і `KIND_TO_KEY` для collection keys у `find-references.ts`. Kind-prefix disambiguation — доменна задача (різні бізнес-об'єкти з однаковим ім'ям повинні мати різні фізичні ідентифікатори), а не деталь конкретного SQL діалекту. Якщо маппінг лише в generator-pg, то майбутній generator-mssql мусить або дублювати маппінг, або імпортувати з generator-pg — обидва варіанти хибні.

### Вимоги Phase A

- [X] Новий файл `packages/core/src/schemas/physical-naming.ts`:
  - `KIND_PREFIX: Record<MetadataKind, string>` маппінг:
    - `Catalog` → `"cat_"`
    - `Document` → `"doc_"`
    - `Enumeration` → `"enum_"`
    - `InformationRegister` → `"ir_"`
    - `AccumulationRegister` → `"ar_"`
    - `Constant` → `"const_"`
    - `CustomTable` → `"ct_"`
  - `toSnakeCase(name: string): string` — PascalCase → snake_case (перенести з generator-pg, бо потрібна будь-якому генератору)
  - `physicalObjectName(kind: MetadataKind, objectName: string): string` — повертає `{KIND_PREFIX[kind]}{toSnakeCase(objectName)}`
  - `physicalTabularName(kind: MetadataKind, parentName: string, sectionName: string): string` — повертає `{physicalObjectName(kind, parentName)}_{sectionName}`
- [X] Додати export у `packages/core/src/schemas/index.ts`
- [X] Додати re-export через `packages/core/src/index.ts`
- [X] Тести у `packages/core/src/__tests__/physical-naming.test.ts`:
  - `toSnakeCase`: SalesOrder → sales_order, Products → products, CurrencyExchangeRates → currency_exchange_rates
  - `physicalObjectName` для кожного kind
  - `physicalTabularName` для табличних частин
  - KIND_PREFIX має entry для кожного значення MetadataKind

### Ризики Phase A

- Core стає "товстішим" — але це ~30 рядків, а core вже знає про SQL reserved words (`sql-reserved-words.ts`), тобто це той самий рівень відповідальності
- Prefix не підійде для якоїсь СУБД — малоймовірно: 3–6 символьний ASCII prefix є universal SQL convention

### DoD Phase A

- [X] `pnpm --filter @simetra/core test` — green
- [X] `pnpm typecheck` — без помилок
- [X] KIND_PREFIX, physicalObjectName, physicalTabularName, toSnakeCase експортовані з `@simetra/core`

---

## Phase B: Generator-pg Migration

**Мета:** Мігрувати generator-pg на core naming, вилучити inline FK, додати секцію FOREIGN KEYS, усунути enum naming drift у generate-posting.

### B.1 — Late-Emitted FK Constraints

Термін "Late-Emitted FK" означає: всі FK виносяться у секцію `ALTER TABLE ... ADD CONSTRAINT` після всіх `CREATE TABLE`. Це **НЕ** PostgreSQL DEFERRABLE/INITIALLY DEFERRED (runtime feature для відкладення перевірки FK до кінця транзакції). SQL Server не підтримує DEFERRABLE — ще одна причина їх не змішувати.

- [ ] `type-mapping.ts:refToColumn()` — прибрати `REFERENCES target(id)` із constraints для non-enum single Ref. Повертає лише `sqlType: "uuid"`
- [ ] Створити інтерфейс `ForeignKeyDef { sourceTable, column, targetTable, onDelete? }` і масив-колектор у `generateProjectDDL()`
- [ ] **Всі** FK виносяться в колектор through єдиний механізм:
  - Single Ref атрибути → `FK (column_id) REFERENCES target(id)`
  - Self parent_id каталогів → `FK (parent_id) REFERENCES self(id)`
  - Tabular parent_id → `FK (parent_id) REFERENCES parent(id) ON DELETE CASCADE`
  - Owner_id (single) → `FK (owner_id) REFERENCES owner(id)`
  - Recorder_id (single) → `FK (recorder_id) REFERENCES recorder(id)`
  - Enumeration lookupTable refs → `FK (column) REFERENCES enum_table(id)`
- [ ] Polymorphic Ref — **без FK** (Dynamic Link pattern, як зараз)
- [ ] pgEnum refs — **без FK** (це PostgreSQL TYPE, не таблиця)
- [ ] `generateProjectDDL()` додає нову секцію **"FOREIGN KEYS"** між TABLES і INDEXES
- [ ] Конвенція іменування FK constraint: `fk_{source_table}_{column_name}`
- [ ] Порядок секцій: ENUM TYPES → TABLES → **FOREIGN KEYS** → INDEXES → VIEWS → TRIGGERS → POSTING FUNCTIONS

### B.2 — Kind-Prefix Table Naming

- [ ] `naming.ts` — оновити для використання core physical naming:
  - `tableName(tablePrefix, kind, objectName)` = `tablePrefix + physicalObjectName(kind, objectName)`
  - `tabularTableName(tablePrefix, kind, parentName, sectionName)` = `tablePrefix + physicalTabularName(kind, parentName, sectionName)`
  - `toSnakeCase` — **видалити** з naming.ts, імпортувати з `@simetra/core`
  - `qualifiedName`, `quoteIdentifier`, `escapeLiteral` — залишаються в generator-pg (dialect-specific)
- [ ] Оновити всі виклики `tableName()` по всьому generator-pg (~45 call sites у generate-table.ts та generate-posting.ts)
- [ ] `buildRefTableLookup()` — передавати kind у tableName
- [ ] `buildEnumTypeLookup()` — передавати `"Enumeration"` як kind
- [ ] Enumeration naming:
  - `pgEnum` стратегія: `CREATE TYPE {prefix}enum_{snake_case(name)} AS ENUM (...)`
  - `lookupTable` стратегія: `CREATE TABLE {prefix}enum_{snake_case(name)} (...)`
  - Обидва варіанти використовують `enum_` prefix — захист від колізій з іншими kind-ами (наприклад, `Catalog.Status` vs `Enumeration.Status`)
- [ ] Constants naming:
  - `singleTable`: фіксоване ім'я `{tablePrefix}const_settings`
  - `separateTables`: стандартний kind-prefix `{tablePrefix}const_{snake_case(name)}`

### B.3 — Enum Naming Drift Fix

- [ ] Видалити 3 місця з hardcoded `` `enum_${toSnakeCase(ref.name)}` `` у `generate-posting.ts` (рядки ~280, ~487, ~663)
- [ ] `generatePostingFunctions()` отримує `resolveEnumType` callback як параметр від `generateProjectDDL()` — використовує той самий lookup, що й generate-table
- [ ] Це автоматично виправляє: відсутній tablePrefix, відсутній schema qualification у posting enum resolution

### B.4 — Identifier Length Validation

- [ ] Додати warning (не error) коли згенерований ідентифікатор > 63 символів (PostgreSQL NAMEDATALEN-1 limit)
- [ ] PostgreSQL тихо обрізає довгі ідентифікатори — warning пояснює чому рантайм ім'я може не збігатися з очікуваним
- [ ] Перевіряти: table names, constraint names (fk_..., uq_...)
- [ ] Warning додається у `GeneratorOutput.warnings[]`

### Тести Phase B

- [ ] Тест: catalog → document FK (forward reference) генерує `ALTER TABLE ... ADD CONSTRAINT`
- [ ] Тест: document → catalog FK генерує `ALTER TABLE ... ADD CONSTRAINT`
- [ ] Тест: self-reference (catalog → self) генерує правильний FK
- [ ] Тест: tabular section parent_id генерує FK з ON DELETE CASCADE через ALTER TABLE
- [ ] Тест: owner_id single ref генерує FK через ALTER TABLE
- [ ] Тест: recorder_id single ref генерує FK через ALTER TABLE
- [ ] Тест: polymorphic ref **не** генерує FK (Dynamic Link)
- [ ] Тест: pgEnum ref **не** генерує FK
- [ ] Тест: lookupTable enum ref генерує FK
- [ ] Тест: `InformationRegister.X` + `AccumulationRegister.X` генерують різні таблиці (`ir_x` / `ar_x`)
- [ ] Тест: kind-prefix в іменах таблиць для **кожного** kind
- [ ] Тест: kind-prefix з project-wide tablePrefix (`erp_cat_products`)
- [ ] Тест: табличні частини з kind-prefix (`cat_products_barcodes`)
- [ ] Тест: posting функції використовують правильні kind-prefixed імена таблиць
- [ ] Тест: posting enum resolution збігається з DDL enum resolution (з tablePrefix і schema)
- [ ] Тест: constants singleTable → `const_settings`; separateTables → `const_{name}`
- [ ] Тест: identifier > 63 chars генерує warning
- [ ] Тест у `naming.test.ts` для нового signature `tableName(prefix, kind, name)`, `tabularTableName(prefix, kind, parent, section)`
- [ ] Оновити всі існуючі тести, що зламаються через зміну імен таблиць та late-emitted FK

### DoD Phase B

- [ ] `pnpm --filter @simetra/generator-pg test` — всі тести проходять
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm lint` — без помилок
- [ ] Жоден inline REFERENCES у генерованому SQL (окрім pgEnum type refs)
- [ ] SQL містить секцію FOREIGN KEYS з ALTER TABLE ... ADD CONSTRAINT
- [ ] `InformationRegister.X` та `AccumulationRegister.X` генерують різні назви таблиць
- [ ] Кожен kind має свій prefix у фізичних іменах таблиць
- [ ] Posting функції та DDL використовують ідентичне enum type resolution
- [ ] Жодного hardcoded `enum_` у generate-posting.ts

---

## Phase C: Verification

**Мета:** End-to-end перевірка: preview, CLI, повний SQL contract.

### Вимоги Phase C

- [ ] `ddl-store.ts` — не потребує змін (broken refs перевіряються вже зараз, preview лише відображає output генератора)
- [ ] SQL preview panel показує оновлені імена таблиць і late-emitted FK
- [ ] CLI: `pnpm simetra generate --target postgresql` генерує коректний SQL з kind-prefixed names і FK секцією
- [ ] Згенерований SQL успішно виконується на PostgreSQL при будь-якому порядку cross-kind references

### DoD Phase C

- [ ] `pnpm test` — всі тести проходять (core + generator-pg + apps/web)
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm lint` — без помилок
- [ ] SQL preview відображає новий формат без регресій

---

## Прийняті рішення (Clarify resolved)

### 1. KIND_PREFIX живе в core, не в generator-pg
- **Рішення:** `@simetra/core` — canonical source для kind-prefix маппінгу
- **Чому:** Kind-prefix вирішує доменну проблему disambiguation бізнес-об'єктів, а не SQL-діалектну. Core вже знає про SQL reserved words — це той самий рівень відповідальності. Інакше кожен новий генератор (MSSQL, ...) мусить дублювати маппінг або імпортувати з generator-pg

### 2. Всі FK виносяться в одну секцію, включно з self parent_id і tabular parent_id
- **Рішення:** Один механізм для всіх FK — через collector + ALTER TABLE
- **Чому:** Один path завжди простіший за два. Tabular FK з ON DELETE CASCADE і self-reference працюють ідентично в ALTER TABLE form. Переносимо для MSSQL

### 3. Constants singleTable → `const_settings`
- **Рішення:** Фіксоване ім'я `{prefix}const_settings`
- **Чому:** Це service table, а не конкретний бізнес-об'єкт. `const_constants` — тавтологічно

### 4. Enum prefix `enum_` для обох стратегій
- **Рішення:** `enum_` prefix застосовується і до CREATE TYPE (pgEnum), і до CREATE TABLE (lookupTable)
- **Чому:** Захист від cross-kind колізій (Catalog.Status vs Enumeration.Status). PostgreSQL TYPE і TABLE — різні namespaces, але prefix потрібен для консистентності з іншими kind-ами. Для MSSQL pgEnum не існує — залишається lookupTable, де prefix переносимий

### 5. FK constraint naming: `fk_{table}_{column}` для всіх
- **Рішення:** Єдина конвенція для всіх FK (custom attrs, owner_id, parent_id, recorder_id, tabular parent_id)
- **Чому:** Consistency. PostgreSQL дозволяє non-unique constraint names на різних таблицях, але SQL Server вимагає uniqueness в межах schema — `fk_{table}_{column}` дає unique names

### 6. Kind-prefix — поки правило generator-pg, не загальний multi-DB contract
- **Рішення:** Маппінг живе в core (для reuse), але його застосування до SQL — відповідальність кожного генератора
- **Чому:** Поточна система PostgreSQL-only. MSSQL може мати інші правила quoting або schema organization. Не заморожувати передчасно

### 7. Posting оновлюється в цій же задачі
- **Рішення:** Включити generate-posting.ts у scope
- **Чому:** Інакше DDL і posting розʼїдуться по іменах — генератор буде produce inconsistent SQL

### 8. Late-Emitted ≠ DEFERRABLE
- **Рішення:** Використовувати термін "Late-Emitted FK" замість "Deferred FK". НЕ додавати DEFERRABLE INITIALLY DEFERRED на constraints
- **Чому:** SQL Server не підтримує DEFERRABLE. Проблема — в порядку DDL, а не в runtime semantics транзакцій

---

## Рекомендовані патерни

### Late-Emitted FK Collection

Інтерфейс `ForeignKeyDef` та масив-колектор. Кожна generateXxx-функція додає записи FK у колектор замість inline REFERENCES. Після всіх CREATE TABLE — `emitForeignKeys(collector)` генерує ALTER TABLE. Цей патерн є стандартним для DDL генераторів і переноситься на будь-яку СУБД.

### Core Physical Naming як Single Source of Truth

`KIND_PREFIX` і `physicalObjectName()` у core. Generator-pg імпортує їх і додає dialect-specific: `qualifiedName`, `quoteIdentifier`, `escapeLiteral`, `tablePrefix`. Майбутній generator-mssql імпортує ті самі helpers з core, додає свої dialect-specific: brackets quoting, `dbo` schema, etc.

### Enum Resolution через Shared Lookup

`generateProjectDDL()` будує `resolveEnumType` callback один раз і передає його в усі підсистеми (generate-table, generate-posting). Жодних локальних дублів resolution.

### Мінімальні зміни в type-mapping.ts

`refToColumn()` повертає лише `sqlType: "uuid"` без constraints для non-enum single Ref. FK-інформацію збирає caller (generate-table.ts) через collector.

---

## Антипатерни (уникати)

### ❌ Topological Sort замість Late-Emitted FK
Сортування таблиць за графом залежностей не вирішує циклічні залежності (A→B→A) і значно складніше. Late-emitted FK — стандартне рішення.

### ❌ Kind-prefix як опціональна фіча
Не робити kind-prefix конфігурабельним через прапорець — це ускладнює тестування і створює два паралельних шляхи. Зворотна сумісність не потрібна.

### ❌ Валідація cross-kind uniqueness замість kind-prefix
Заборона однакових імен між різними kind-ами — занадто обмежувальне рішення, яке обмежує користувача.

### ❌ Дублювання kind-prefix маппінгу
НЕ хардкодити `cat_`, `doc_`, `enum_` і т.д. у generateXxx-функціях або generate-posting. Єдиний маппінг — `KIND_PREFIX` у core.

### ❌ Hardcoded enum resolution у posting
НЕ робити локальний `` `enum_${toSnakeCase(name)}` `` у generate-posting.ts. Це вже зараз розходиться з generate-table.ts при non-empty tablePrefix.

### ❌ Передчасна multi-DB абстракція
НЕ рефакторити GeneratorOptions, НЕ створювати dialect-neutral IR, НЕ виносити `enumStrategy` з generator-api. Ці зміни — для окремої задачі при появі другого target.

### ❌ DEFERRABLE на FK constraints
НЕ додавати `DEFERRABLE INITIALLY DEFERRED` — це runtime feature, SQL Server її не підтримує, і вона не потрібна для вирішення DDL ordering problem.

---

## Архітектурні рішення

### Шари відповідальності

```
@simetra/core
  └── KIND_PREFIX, physicalObjectName, physicalTabularName, toSnakeCase
  └── Доменна логіка: "різні бізнес-об'єкти → різні фізичні ідентифікатори"

@simetra/generator-pg
  └── tableName = tablePrefix + physicalObjectName  (dialect: qualifiedName, quoting)
  └── FK collector + ALTER TABLE emission
  └── Type mapping (uuid, varchar, timestamptz — PG-specific)
  └── Enum/Constants strategy rendering
```

### Flow генерації

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
                                            └─ отримує resolveEnumType від caller
```

### Зміна signature naming.ts

```
До:   tableName(prefix, objectName) → "products"
Після: tableName(prefix, kind, objectName) → "cat_products"

До:   tabularTableName(prefix, parentName, section) → "products_barcodes"
Після: tabularTableName(prefix, kind, parentName, section) → "cat_products_barcodes"
```

### FK output format

```sql
-- ============================================================
-- FOREIGN KEYS
-- ============================================================

-- Catalog: Products
ALTER TABLE cat_products
  ADD CONSTRAINT fk_cat_products_default_warehouse_id
  FOREIGN KEY (default_warehouse_id) REFERENCES cat_warehouses(id);

ALTER TABLE cat_products
  ADD CONSTRAINT fk_cat_products_parent_id
  FOREIGN KEY (parent_id) REFERENCES cat_products(id);

-- Tabular: Products.Barcodes
ALTER TABLE cat_products_barcodes
  ADD CONSTRAINT fk_cat_products_barcodes_parent_id
  FOREIGN KEY (parent_id) REFERENCES cat_products(id) ON DELETE CASCADE;

-- Document: SalesOrder
ALTER TABLE doc_sales_order
  ADD CONSTRAINT fk_doc_sales_order_product_id
  FOREIGN KEY (product_id) REFERENCES cat_products(id);
```

### Identifier length check

```
⚠ Warning: identifier "fk_erp_ar_very_long_register_name_with_extra_words_some_dimension_id"
  exceeds PostgreSQL limit of 63 characters and will be silently truncated
```

---

## Scope змін (файли)

| Файл | Phase | Зміни |
|------|-------|-------|
| `packages/core/src/schemas/physical-naming.ts` | A | **Новий**: KIND_PREFIX, toSnakeCase, physicalObjectName, physicalTabularName |
| `packages/core/src/schemas/index.ts` | A | Додати export |
| `packages/core/src/index.ts` | A | Додати re-export |
| `packages/core/src/__tests__/physical-naming.test.ts` | A | **Новий**: тести naming |
| `packages/generator-pg/src/naming.ts` | B | Видалити toSnakeCase (імпорт з core), оновити tableName/tabularTableName signature |
| `packages/generator-pg/src/type-mapping.ts` | B | refToColumn — прибрати inline REFERENCES |
| `packages/generator-pg/src/generate-table.ts` | B | FK collector, секція FOREIGN KEYS, kind у tableName, identifier length warnings |
| `packages/generator-pg/src/generate-posting.ts` | B | Видалити 3x hardcoded enum_, додати resolveEnumType param, kind у tableName |
| `packages/generator-pg/src/__tests__/naming.test.ts` | B | Тести нового signature |
| `packages/generator-pg/src/__tests__/type-mapping.test.ts` | B | Оновити (без inline REFERENCES) |
| `packages/generator-pg/src/__tests__/generate-table.test.ts` | B | Forward-ref, name collision, FK emission, identifier length warning |
| `packages/generator-pg/src/__tests__/generate-posting.test.ts` | B | Kind-prefixed table names, shared enum resolution |

---

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура, шари core/generator-pg
- `docs/architecture/metadata-model.md` — MetadataKind, reference-модель, стандартні реквізити
- `docs/BRD-metadata-configurator.md` — бізнес-вимоги, секції 5 (types), 6 (fields), 7 (JSON), 10.4 (generator plugin)
- `docs/tasks/phase2a-ddl-generator.md` — оригінальна специфікація (рядок 93: FK constraints як окрема фаза — ця задача повертає до того контракту)
- `packages/core/src/serialization.ts` — прецедент KIND_SLUG маппінгу
- `packages/core/src/find-references.ts` — прецедент KIND_TO_KEY маппінгу
- `packages/core/src/schemas/sql-reserved-words.ts` — прецедент SQL awareness в core
- `.github/instructions/architecture-core.instructions.md` — архітектурні правила
- `.github/instructions/metadata-model.instructions.md` — правила Zod-схем

### Зовнішні джерела (підтверджено через Context7)

- PostgreSQL 18 docs §4.1.1: ідентифікатори обрізаються на 63 байти (NAMEDATALEN-1) **тихо**
- PostgreSQL 18 docs §5.4.5: ALTER TABLE ADD CONSTRAINT FOREIGN KEY — стандартний механізм
- SQL Server docs: max identifier 128 chars, `uniqueidentifier` замість `uuid`, `NEWID()` замість `gen_random_uuid()`, **немає** DEFERRABLE на FK
- SQL Server docs: ALTER TABLE ADD CONSTRAINT FOREIGN KEY — синтаксис ідентичний PostgreSQL

---

## Definition of Done (загальний)

- [ ] `pnpm test` — всі тести проходять (core + generator-pg)
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm lint` — без помилок
- [ ] KIND_PREFIX маппінг експортований з `@simetra/core`
- [ ] Жоден inline REFERENCES у генерованому SQL
- [ ] SQL містить секцію FOREIGN KEYS з ALTER TABLE ... ADD CONSTRAINT
- [ ] Всі FK (single ref, self, tabular, owner, recorder) через єдиний collector
- [ ] `InformationRegister.X` та `AccumulationRegister.X` генерують різні назви таблиць
- [ ] Кожен kind має свій prefix у фізичних іменах таблиць
- [ ] Posting функції та DDL використовують ідентичне naming і enum resolution
- [ ] Жодного hardcoded `enum_` у generate-posting.ts
- [ ] Identifier > 63 chars генерує warning
- [ ] SQL preview відображає оновлений формат
