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

- [X] Створити `packages/generator-pg/` з `package.json` (`@simetra/generator-pg`), `tsconfig.json`, `vitest.config.ts`
- [X] Залежності: тільки `@simetra/core` (workspace dependency)
- [X] Додати в `pnpm-workspace.yaml` та `turbo.json`
- [X] Entry point: `packages/generator-pg/src/index.ts`
- [X] Створити `packages/generator-api/` з `package.json` (`@simetra/generator-api`):
  - Інтерфейс `MetadataGenerator` (BRD §10.4)
  - `GeneratorOutput`: `{ files: Array<{ path, content }>, warnings: string[] }`
- [X] Створити `packages/cli/` з `package.json` (`@simetra/cli`):
  - Базова структура (citty), команда `simetra generate --target postgresql`
  - Читання metadata з файлової системи → виклик generator → запис результату

### Етап 2: Генерація CREATE TABLE

- [X] Для кожного типу метаданих генерувати SQL:
  - **Catalog** → основна таблиця + таблиці табличних частин
  - **Document** → основна таблиця + таблиці табличних частин
  - **Enumeration** → PostgreSQL ENUM type або lookup-таблиця (configurable: `enumStrategy`)
  - **InformationRegister** → таблиця з composite unique key (period + dimensions)
  - **AccumulationRegister** → таблиця рухів
  - **Constant** → single-row таблиця або key-value таблиця (configurable: `constantsStrategy`)
  - **CustomTable** → таблиця з optional PK
- [X] Стандартні реквізити: генерувати з `getStandardAttributes(kind, settings)` з `@simetra/core`
- [X] Кастомні реквізити: type mapping (BRD §6.1):
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
- [X] Naming convention: snake_case для таблиць і колонок (configurable через project settings)
- [X] Table prefix: з `project.generation.tablePrefix`
- [X] Schema: з `project.database.schema` (default: `public`)

### Етап 3: Foreign Keys, Indexes, Views, Triggers

- [X] **Foreign Keys:**
  - `owner_id` → FK на таблицю owner(s)
  - `recorder_id` → FK на таблицю recorder(s)
  - Single ref → `uuid REFERENCES {table}(id)`
  - Polymorphic ref → без FK (Dynamic Link pattern), з CHECK constraint на `{field}_type`
  - Табличні частини → FK на батьківську таблицю з `ON DELETE CASCADE`
- [X] **Indexes:**
  - Атрибути з `indexed: true` → `CREATE INDEX`
  - Атрибути з `unique: true` → `UNIQUE` constraint
  - Information Register: composite unique на `(period, dim1, dim2, ...)`
  - Standard indexes: PK на `id`, FK indexes автоматично
- [X] **Views для регістрів (BRD §5.6):**
  - AccumulationRegister (Balance): view `{name}_balance` — залишки на дату
  - AccumulationRegister (Balance): view `{name}_turnovers` — обороти за період
  - AccumulationRegister (Turnover): view `{name}_turnovers` — обороти за період
  - InformationRegister: view `{name}_slice_last` — зріз останніх
- [X] **Triggers для автонумерації:**
  - Catalog з `autonumber: true` → trigger function для code generation
  - Document з `autonumber: true` → trigger function для number generation з урахуванням `numberPeriodicity`

### Етап 4: Output format та тести

- [X] Один SQL-файл на об'єкт або один зведений файл (configurable)
- [X] Коментарі в SQL з посиланнями на metadata source
- [X] Правильний порядок: ENUM types → base tables → FK constraints → indexes → views → triggers
- [X] **Тести:**
  - Golden fixtures: metadata → expected SQL для кожного типу
  - Catalog з ієрархією + owners → correct FK, conditional columns
  - Document з posting + registerMovements → correct trigger setup
  - AccumulationRegister (Balance) → movement_type column + balance view
  - Polymorphic ref → type + id pair, CHECK constraint
  - Project-level: generation з 5+ об'єктів → correct cross-references
  - `pnpm --filter @simetra/generator-pg test` — green

### Етап 5: SQL Preview UI

- [X] Додати кнопку "Generate" у Top Bar (між Save та Export)
- [X] Keyboard shortcut: Ctrl+G / Cmd+G
- [X] Command Palette: "Generate SQL"
- [X] Новий тип вкладки в TabBar: "SQL Preview" (не object editor)
- [X] Відображення згенерованого SQL з syntax highlighting
- [X] Tree-like navigation зліва: список файлів/об'єктів
- [X] Вибір файлу → показ його SQL справа
- [X] Кнопка "Copy All" — копіювати весь SQL у clipboard
- [X] Кнопка "Download" — завантажити як .sql файл(и)
- [X] Warnings panel: якщо генератор повернув warnings
- [X] Validation перед генерацією (referential integrity, обов'язкові поля)
- [X] Якщо є помилки — показати діалог з переліком перед генерацією
- [X] Якщо є warnings — показати, але дозволити продовжити

---

## Clarify (прийняті рішення)

- [X] **Один SQL файл vs по-файлово?** Рішення: configurable через `outputMode: 'singleFile' | 'perObject'`, default `singleFile`. Поточна реалізація generator-pg завжди генерує один файл. UI готовий до multi-file (file tree відображається при files.length > 1).
- [X] **Формат enum стратегії:** Рішення: (A) pgEnum (CREATE TYPE) як default, (B) lookupTable як альтернатива. Обидва реалізовані.
- [X] **Стратегія констант:** Рішення: (A) singleTable як default, (B) separateTables як альтернатива. Обидві реалізовані.
- [X] **Syntax highlighting бібліотека:** Рішення: Shiki з темою `github-dark`. Підключена як runtime dependency в apps/web. Lazy loading не реалізований (TODO для оптимізації).

### Code Review Зауваження (Stage 5)

Зауваження від code review та прийняті рішення:

1. **Multi-file preview** — generator-pg зараз генерує тільки один файл (`singleFile` mode). UI file tree показується умовно при `files.length > 1`. Це forward-looking код для майбутньої підтримки `perObject` output mode. Прийнято як допустиме.
2. **Platform-aware shortcut hints** — Tooltip і Command Palette показують "Ctrl+G" hardcoded. Runtime hotkey використовує `mod+g` (Ctrl на Windows/Linux, Cmd на macOS). Hint не platform-aware. TODO для polish.
3. **Shiki lazy loading** — Shiki завантажується статично в initial bundle. TODO: конвертувати на dynamic import при першому відкритті SQL Preview для зменшення initial load.
4. **Pre-generation validation** — Реалізовано перевірку broken refs (атрибути, owners, recorderTypes, registerMovements). При помилках показується banner з можливістю "Згенерувати все одно". Генератор також обробляє unresolved refs через fallback "UNRESOLVED" в SQL.

---

## Definition of Done

- [X] `pnpm --filter @simetra/generator-pg test` — green (89 тестів)
- [X] `pnpm lint ; pnpm typecheck` — clean
- [X] SQL Preview UI працює end-to-end: натискання Generate → відображення SQL
- [X] Тести покривають всі 7 типів метаданих (naming, type-mapping, generate-table)
- [ ] Документація оновлена: README для generator-pg та cli
