# Task: Phase 2a — DDL Generator + SQL Preview

> **Prerequisite:** Phase 1 Closure Backlog (`phase1-closure-backlog.md`) має бути виконаний перед початком цієї фази.

## Контекст

Phase 1 реалізувала повноцінний візуальний конфігуратор метаданих: 7 типів бізнес-об'єктів, 3-панельний layout, Tab/Floating Windows, session persistence, undo/redo, canonical JSON storage.

**Ціль Phase 2a:** Перетворити метадані на PostgreSQL DDL і показати результат у UI. Це чисто структурна генерація — CREATE TABLE, INDEX, VIEW, triggers. Не включає posting SQL (Phase 2b) і deployment (Phase 2c).

### Архітектурний принцип

DDL генератор — **pure PostgreSQL**, без Supabase-специфічного коду. Supabase — перший deployment adapter, не ядро генератора (Phase 2c).

```
@simetra/core (metadata)
    ↓
@simetra/generator-pg (pure PostgreSQL DDL)
    ↓
apps/web (SQL Preview UI)
```

---

## Етапи

### Етап 1: Пакет та інфраструктура

- [ ] Створити `packages/generator-pg/` з `package.json` (`@simetra/generator-pg`), `tsconfig.json`, `vitest.config.ts`
- [ ] Залежності: тільки `@simetra/core` (workspace dependency)
- [ ] Додати в `pnpm-workspace.yaml` та `turbo.json`
- [ ] Entry point: `packages/generator-pg/src/index.ts`
- [ ] Створити `packages/generator-api/` з `package.json` (`@simetra/generator-api`):
  - Інтерфейс `MetadataGenerator` (BRD §10.4)
  - `GeneratorOutput`: `{ files: Array<{ path, content }>, warnings: string[] }`
- [ ] Створити `packages/cli/` з `package.json` (`@simetra/cli`):
  - Базова структура (citty), команда `simetra generate --target postgresql`
  - Читання metadata з файлової системи → виклик generator → запис результату

### Етап 2: Генерація CREATE TABLE

- [ ] Для кожного типу метаданих генерувати SQL:
  - **Catalog** → основна таблиця + таблиці табличних частин
  - **Document** → основна таблиця + таблиці табличних частин
  - **Enumeration** → PostgreSQL ENUM type або lookup-таблиця (configurable: `enumStrategy`)
  - **InformationRegister** → таблиця з composite unique key (period + dimensions)
  - **AccumulationRegister** → таблиця рухів
  - **Constant** → single-row таблиця або key-value таблиця (configurable: `constantsStrategy`)
  - **CustomTable** → таблиця з optional PK
- [ ] Стандартні реквізити: генерувати з `getStandardAttributes(kind, settings)` з `@simetra/core`
- [ ] Кастомні реквізити: type mapping (BRD §6.1):
  - UUID → `uuid DEFAULT gen_random_uuid()`
  - String → `varchar(N)` (N = length або default)
  - Text → `text`
  - Integer → `integer`
  - Numeric → `numeric(precision, scale)`
  - Boolean → `boolean DEFAULT false`
  - Date → `date`
  - DateTime → `timestamptz`
  - Binary → `bytea`
  - Ref (single) → `uuid REFERENCES {target_table}(id)`
  - Ref (polymorphic) → `{field}_type varchar(100) NOT NULL` + `{field}_id uuid NOT NULL`
- [ ] Naming convention: snake_case для таблиць і колонок (configurable через project settings)
- [ ] Table prefix: з `project.generation.tablePrefix`
- [ ] Schema: з `project.database.schema` (default: `public`)

### Етап 3: Foreign Keys, Indexes, Views, Triggers

- [ ] **Foreign Keys:**
  - `owner_id` → FK на таблицю owner(s)
  - `recorder_id` → FK на таблицю recorder(s)
  - Single ref → `uuid REFERENCES {table}(id)`
  - Polymorphic ref → без FK (Dynamic Link pattern), з CHECK constraint на `{field}_type`
  - Табличні частини → FK на батьківську таблицю з `ON DELETE CASCADE`
- [ ] **Indexes:**
  - Атрибути з `indexed: true` → `CREATE INDEX`
  - Атрибути з `unique: true` → `UNIQUE` constraint
  - Information Register: composite unique на `(period, dim1, dim2, ...)`
  - Standard indexes: PK на `id`, FK indexes автоматично
- [ ] **Views для регістрів (BRD §5.6):**
  - AccumulationRegister (Balance): view `{name}_balance` — залишки на дату
  - AccumulationRegister (Balance): view `{name}_turnovers` — обороти за період
  - AccumulationRegister (Turnover): view `{name}_turnovers` — обороти за період
  - InformationRegister: view `{name}_slice_last` — зріз останніх
- [ ] **Triggers для автонумерації:**
  - Catalog з `autonumber: true` → trigger function для code generation
  - Document з `autonumber: true` → trigger function для number generation з урахуванням `numberPeriodicity`

### Етап 4: Output format та тести

- [ ] Один SQL-файл на об'єкт або один зведений файл (configurable)
- [ ] Коментарі в SQL з посиланнями на metadata source
- [ ] Правильний порядок: ENUM types → base tables → FK constraints → indexes → views → triggers
- [ ] **Тести:**
  - Golden fixtures: metadata → expected SQL для кожного типу
  - Catalog з ієрархією + owners → correct FK, conditional columns
  - Document з posting + registerMovements → correct trigger setup
  - AccumulationRegister (Balance) → movement_type column + balance view
  - Polymorphic ref → type + id pair, CHECK constraint
  - Project-level: generation з 5+ об'єктів → correct cross-references
  - `pnpm --filter @simetra/generator-pg test` — green

### Етап 5: SQL Preview UI

- [ ] Додати кнопку "Generate" у Top Bar (між Save та Export)
- [ ] Keyboard shortcut: Ctrl+G / Cmd+G
- [ ] Command Palette: "Generate SQL"
- [ ] Новий тип вкладки в TabBar: "SQL Preview" (не object editor)
- [ ] Відображення згенерованого SQL з syntax highlighting
- [ ] Tree-like navigation зліва: список файлів/об'єктів
- [ ] Вибір файлу → показ його SQL справа
- [ ] Кнопка "Copy All" — копіювати весь SQL у clipboard
- [ ] Кнопка "Download" — завантажити як .sql файл(и)
- [ ] Warnings panel: якщо генератор повернув warnings
- [ ] Validation перед генерацією (referential integrity, обов'язкові поля)
- [ ] Якщо є помилки — показати діалог з переліком перед генерацією
- [ ] Якщо є warnings — показати, але дозволити продовжити

---

## Clarify (питання перед імплементацією)

- [ ] **Один SQL файл vs по-файлово?** Рекомендація: configurable, default один файл для apply.
- [ ] **Формат enum стратегії:** (A) pgEnum (CREATE TYPE), (B) lookup table з FK, (C) varchar з CHECK. Рекомендація: (A) для MVP.
- [ ] **Стратегія констант:** (A) singleTable `constants(key, value_type, value)`, (B) oneTablePerConstant. Рекомендація: (A).
- [ ] **Syntax highlighting бібліотека:** Shiki, Prism, CodeMirror? Рекомендація: Shiki (сучасний, tree-shakeable).

---

## Definition of Done

- [ ] `pnpm --filter @simetra/generator-pg test` — green
- [ ] `pnpm --filter @simetra/cli test` — green (якщо є тести CLI)
- [ ] `pnpm lint ; pnpm typecheck` — clean
- [ ] SQL Preview UI працює end-to-end: натискання Generate → відображення SQL
- [ ] Golden snapshots покривають всі 7 типів метаданих
- [ ] Документація оновлена: README для generator-pg та cli
