# Task: Phase 2 — DDL Generator + Supabase Deployment

> **Prerequisite:** Phase 1 Closure Backlog (`phase1-closure-backlog.md`) має бути виконаний перед початком цієї фази.

## Контекст

Phase 1 реалізувала повноцінний візуальний конфігуратор метаданих: 7 типів бізнес-об'єктів, 3-панельний layout, Tab/Floating Windows, session persistence, undo/redo, canonical JSON storage. Метадані зберігаються як JSON-файли, що відповідають BRD §7.

**Ціль Phase 2:** Перетворити метадані на реальну PostgreSQL-схему та задеплоїти її. Користувач натискає "Generate" → бачить SQL preview → натискає "Apply" → таблиці з'являються в Supabase з автоматичним REST API.

### Чому Supabase як перший target

- **Instant REST API:** Після `CREATE TABLE` PostgREST автоматично створює REST API для кожної таблиці/view — нуль конфігурації
- **Managed PostgreSQL:** Не потрібно налаштовувати сервер — Supabase надає повноцінний PostgreSQL
- **Web SPA friendly:** Supabase Edge Functions дозволяють виконувати privileged операції без бекенду
- **Auth out of the box:** Для майбутнього Phase 3+ — Row Level Security без власного auth layer

### Архітектурний принцип

DDL генератор — **pure PostgreSQL**, без Supabase-специфічного коду. Supabase — перший **deployment adapter**, не ядро генератора. Це дозволяє у майбутньому додати інші adapters (local PG, Neon, Railway) без переписування генератора.

```
@simetra/core (metadata)
    ↓
@simetra/generator-pg (pure PostgreSQL DDL)
    ↓
apps/web (SQL Preview + Diff UI)
    ↓
Supabase Apply Adapter (Edge Function proxy)
    ↓
Supabase PostgreSQL → Auto REST API (PostgREST)
```

---

## Вимоги

### Модуль 1: PostgreSQL DDL Generator (`packages/generator-pg`)

> Новий пакет у монорепо. Чистий TypeScript без UI і без Supabase SDK.

#### 1.1 Пакет та інфраструктура

- [ ] Створити `packages/generator-pg/` з `package.json` (`@simetra/generator-pg`), `tsconfig.json`, `vitest.config.ts`
- [ ] Залежності: тільки `@simetra/core` (workspace dependency)
- [ ] Додати в `pnpm-workspace.yaml` та `turbo.json`
- [ ] Entry point: `packages/generator-pg/src/index.ts`

#### 1.2 Генерація CREATE TABLE

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

#### 1.3 Генерація Foreign Keys

- [ ] `owner_id` → FK на таблицю owner(s)
- [ ] `recorder_id` → FK на таблицю recorder(s)
- [ ] Single ref → `uuid REFERENCES {table}(id)`
- [ ] Polymorphic ref → без FK (Dynamic Link pattern), з CHECK constraint на `{field}_type`
- [ ] Табличні частини → FK на батьківську таблицю з `ON DELETE CASCADE`

#### 1.4 Генерація Indexes

- [ ] Атрибути з `indexed: true` → `CREATE INDEX`
- [ ] Атрибути з `unique: true` → `UNIQUE` constraint
- [ ] Information Register: composite unique на `(period, dim1, dim2, ...)`
- [ ] Standard indexes: PK на `id`, FK indexes автоматично

#### 1.5 Генерація Views для регістрів (BRD §5.6)

- [ ] AccumulationRegister (Balance): view `{name}_balance` — залишки на дату
- [ ] AccumulationRegister (Balance): view `{name}_turnovers` — обороти за період
- [ ] AccumulationRegister (Turnover): view `{name}_turnovers` — обороти за період
- [ ] InformationRegister: view `{name}_slice_last` — зріз останніх

#### 1.6 Генерація Trigger для автонумерації

- [ ] Catalog з `autonumber: true` → trigger function для code generation
- [ ] Document з `autonumber: true` → trigger function для number generation з урахуванням `numberPeriodicity`

#### 1.7 Output format

- [ ] Інтерфейс `GeneratorOutput`:
  ```
  files: Array<{ path: string, content: string }>
  warnings: string[]
  ```
- [ ] Один SQL-файл на об'єкт або один зведений файл (configurable)
- [ ] Коментарі в SQL з посиланнями на metadata source
- [ ] Правильний порядок: ENUM types → base tables → FK constraints → indexes → views → triggers

#### 1.8 Тести

- [ ] Golden fixtures: metadata → expected SQL для кожного типу
- [ ] Catalog з ієрархією + owners → correct FK, conditional columns
- [ ] Document з posting + registerMovements → correct trigger setup
- [ ] AccumulationRegister (Balance) → movement_type column + balance view
- [ ] Polymorphic ref → type + id pair, CHECK constraint
- [ ] Project-level: generation з 5+ об'єктів → correct cross-references
- [ ] `pnpm --filter @simetra/generator-pg test` — green

---

### Модуль 2: SQL Preview UI (`apps/web`)

#### 2.1 Generate кнопка та panel

- [ ] Додати кнопку "Generate" у Top Bar (між Save та Export)
- [ ] Keyboard shortcut: Ctrl+G / Cmd+G
- [ ] Command Palette: "Generate SQL"
- [ ] При натисканні — виконати генерацію, відкрити Preview panel

#### 2.2 SQL Preview panel

- [ ] Новий тип вкладки в TabBar: "SQL Preview" (не object editor)
- [ ] Відображення згенерованого SQL з syntax highlighting
- [ ] Tree-like navigation зліва: список файлів/об'єктів
- [ ] Вибір файлу → показ його SQL справа
- [ ] Кнопка "Copy All" — копіювати весь SQL у clipboard
- [ ] Кнопка "Download" — завантажити як .sql файл(и)
- [ ] Warnings panel: якщо генератор повернув warnings

#### 2.3 Validation перед генерацією

- [ ] Project-level validation (з `@simetra/core`): referential integrity, обов'язкові поля
- [ ] Якщо є помилки — показати діалог з переліком перед генерацією
- [ ] Якщо є warnings — показати, але дозволити продовжити

---

### Модуль 3: Supabase Apply Adapter

> Це **deployment adapter** — компонент, який відправляє згенерований SQL на Supabase для виконання.

#### 3.1 Supabase Connection Settings

- [ ] Додати в Project Settings (ObjectProperties → ProjectSettings) секцію "Deployment":
  - Target: dropdown (Supabase / Manual — copy SQL / None)
  - Supabase Project URL: input (`https://{ref}.supabase.co`)
  - Supabase API Key: password input (anon key для RPC, або інструкція для Edge Function)
- [ ] Зберігати connection settings в project.meta.json у секції `deployment` (нове поле, опціональне)
- [ ] API key **НЕ зберігати у файлах метаданих** — тільки в session (IndexedDB або memory)

#### 3.2 Apply flow через Supabase Edge Function

- [ ] Створити reference Edge Function (`supabase/functions/apply-migrations/index.ts`):
  - Приймає: SQL payload (string)
  - Виконує: `sql` через Supabase Management API або `postgres` connection
  - Повертає: success/failure + details
  - Auth: перевірка JWT або custom secret
- [ ] Документація як задеплоїти Edge Function в свій Supabase проєкт
- [ ] Apps/web: кнопка "Apply to Supabase" в SQL Preview panel
- [ ] Flow: Generate SQL → Preview → Apply → Edge Function → DB → REST API auto-created

#### 3.3 Apply status UI

- [ ] Progress indicator при apply
- [ ] Success: "Таблиці створено. REST API доступний за: {supabase_url}/rest/v1/{table}"
- [ ] Error: показати SQL error message з Supabase
- [ ] Link на Supabase Dashboard Table Editor

---

### Модуль 4: Schema Diff (optional, Phase 2b)

> Цей модуль може бути відкладений до Phase 2b або Phase 3 залежно від складності.

- [ ] Schema snapshot: зберігати "applied state" як JSON (які таблиці/колонки створені)
- [ ] При повторній генерації: порівняти new DDL vs snapshot → показати diff
- [ ] Diff categories: Added tables, Added columns, Modified columns, Dropped columns
- [ ] Генерація ALTER TABLE замість CREATE TABLE для існуючих об'єктів
- [ ] Preview diff перед apply
- [ ] Destructive changes (DROP) — потребують explicit confirmation

---

## Clarify (питання перед імплементацією)

### Generator architecture

- [ ] **Один SQL файл vs по-файлово?**
  - Чому: BRD §10.2 не уточнює чи це один файл чи файл-на-об'єкт
  - Варіанти: (A) один зведений файл, (B) файл на об'єкт, (C) configurable
  - Вплив: output format, apply flow
  - Рекомендація: (C) — configurable, default один файл для apply

- [ ] **Формат enum стратегії**
  - Чому: BRD §5.4 каже "PostgreSQL ENUM type або lookup-таблиця"
  - Варіанти: (A) pgEnum (CREATE TYPE), (B) lookup table з FK, (C) varchar з CHECK
  - Вплив: DDL complexity, ALTER TABLE для додавання нових значень
  - Рекомендація: (A) pgEnum для MVP (простіше), (B) як опція для migration-friendly

- [ ] **Стратегія констант**
  - Чому: BRD §5.7 каже "одна таблиця key-value або кожна як окрема таблиця"
  - Варіанти: (A) singleTable `constants(key, value_type, value)`, (B) oneTablePerConstant `{name}(id, value)`
  - Вплив: query patterns, type safety
  - Рекомендація: (A) для простоти

- [ ] **Naming convention mapping**
  - Чому: PascalCase metadata name → snake_case SQL table/column
  - Варіанти: (A) camelCase→snake (`SalesOrder` → `sales_order`), (B) lowercase (`salesorder`), (C) configurable
  - Вплив: генерований код, cross-references
  - Рекомендація: (A) — стандарт PostgreSQL

### Supabase integration

- [ ] **Де зберігати Supabase credentials?**
  - Чому: API key не повинен потрапити в Git-репозиторій
  - Варіанти: (A) тільки в пам'яті (вводити кожен раз), (B) IndexedDB session, (C) environment variable (для CLI)
  - Вплив: UX для повторних apply
  - Рекомендація: (B) — IndexedDB session, але не в .meta.json файлах

- [ ] **Management API vs Edge Function vs Direct connection?**
  - Чому: Management API потребує Personal Access Token (не safe для browser); Direct connection потребує connection string (не safe для browser); Edge Function — proxy, потребує deploy
  - Варіанти: (A) Edge Function (deploy instructions), (B) Management API через proxy, (C) тільки Copy SQL (manual apply)
  - Вплив: складність setup для користувача
  - Рекомендація: (A) для automated apply + (C) як fallback

- [ ] **Supabase project creation чи тільки apply до existing?**
  - Чому: чи Simetra має створювати Supabase проєкт чи тільки таблиці в існуючому?
  - Варіанти: (A) тільки apply до existing project, (B) створення через Management API
  - Вплив: scope, auth complexity
  - Рекомендація: (A) — тільки apply

- [ ] **RLS (Row Level Security) enabled by default?**
  - Чому: Supabase створює таблиці з RLS disabled, але рекомендує enable
  - Варіанти: (A) disable (простіше для dev), (B) enable з basic policy, (C) configurable
  - Вплив: security, complexity
  - Рекомендація: (A) для MVP, документувати як setup step

### Diff & Migrations

- [ ] **Snapshot format?**
  - Чому: потрібно знати "що вже задеплоєно" для diff
  - Варіанти: (A) JSON snapshot в project metadata, (B) SQL migration files, (C) introspect live DB
  - Вплив: offline vs online diff
  - Рекомендація: (A) для Phase 2, (C) для Phase 3

- [ ] **Migration runner чи raw ALTER?**
  - Чому: migration runner (вверх/вниз) vs одноразовий ALTER
  - Варіанти: (A) тільки ALTER SQL preview, (B) повноцінний migration runner з up/down
  - Вплив: complexity, reversibility
  - Рекомендація: (A) для Phase 2b, (B) для Phase 3

---

## Рекомендовані патерни

### Generator як pure function
`generate(project: ProjectModel, options: GeneratorOptions): GeneratorOutput` — детерміністична функція. Ніяких side effects, ніякого network. Тестується через golden fixtures.

### SQL Builder з template literals
Не конкатенувати SQL рядки вручну. Використати tagged template literal або tiny builder pattern для safe SQL construction. Уникати SQL injection через параметризацію table/column names.

### Adapter pattern для deployment
`DeploymentAdapter { apply(sql: string): Promise<ApplyResult> }`. Supabase — перший adapter. Manual (clipboard) — другий. Adapter не знає про генератор, генератор не знає про adapter.

### Preview як read-only tab
SQL Preview — це нова вкладка в TabBar (як object editor), але read-only. Не mutable state. Закривається як звичайна вкладка.

---

## Антипатерни (уникати)

### ❌ Supabase-специфічний SQL у generator-pg
Генератор має виробляти **стандартний PostgreSQL DDL**. Supabase-specific — тільки в adapter (RLS policies, Edge Function calls).

### ❌ API key у metadata JSON файлах
Credentials ніколи не потрапляють у Git. Тільки session storage (IndexedDB) або environment.

### ❌ Dynamic SQL execution від browser без proxy
`service_role` key і Management API token не safe для browser. Apply тільки через trusted executor (Edge Function).

### ❌ ALTER TABLE без diff preview
Ніколи не виконувати destructive changes без explicit user confirmation і preview.

### ❌ Generator залежить від UI
`@simetra/generator-pg` — чистий TS пакет, як `@simetra/core`. Без React, без browser API.

---

## Архітектурні рішення

### Потік Generate + Preview + Apply

```
User: clicks "Generate"
  → apps/web: validateProject(model)
    → if errors: show validation dialog
    → if ok: generateSql(model, options)  // @simetra/generator-pg
      → GeneratorOutput { files, warnings }
  → apps/web: open SQL Preview tab
    → show file tree + SQL content + warnings
    → buttons: [Copy] [Download] [Apply to Supabase]
      → [Apply]: supabaseAdapter.apply(sql)
        → Edge Function → Supabase DB
        → show result (success / error)
```

### Монорепо після Phase 2

```
packages/
├── core/                  ← existing: Zod schemas, types, validation
├── generator-pg/          ← NEW: PostgreSQL DDL generator
├── ui/                    ← existing: shadcn/ui components
apps/
├── web/                   ← existing + SQL Preview + Supabase settings
supabase/
└── functions/
    └── apply-migrations/  ← NEW: Edge Function for DDL execution
```

### PostgreSQL type mapping table

| MetaModel Type | PostgreSQL | Notes |
|----------------|-----------|-------|
| UUID | `uuid DEFAULT gen_random_uuid()` | PK для всіх об'єктів |
| String | `varchar(N)` | N = attribute.length або default |
| Text | `text` | Необмежена довжина |
| Integer | `integer` | 4 bytes |
| Numeric | `numeric(p,s)` | p=precision, s=scale |
| Boolean | `boolean DEFAULT false` | |
| Date | `date` | |
| DateTime | `timestamptz` | З часовим поясом |
| Binary | `bytea` | |
| Ref (single) | `uuid REFERENCES {table}(id)` | FK |
| Ref (polymorphic) | `{field}_type varchar(100)` + `{field}_id uuid` | Dynamic Link |

---

## Пов'язана документація

- `docs/BRD-metadata-configurator.md` §10 — архітектура генераторів
- `docs/BRD-metadata-configurator.md` §6.1 — type mapping
- `docs/BRD-metadata-configurator.md` §5.2-5.9 — стандартні реквізити кожного типу
- `docs/BRD-metadata-configurator.md` §7 — формат метаданих (input для генератора)
- `docs/BRD-metadata-configurator.md` §12 Phase 2 — планований scope
- `.github/instructions/metadata-model.instructions.md` — reference model
- `packages/core/src/schemas/` — Zod-схеми (input для генератора)
- `packages/core/src/schemas/standard-attributes.ts` — стандартні реквізити

---

## Definition of Done

### Модуль 1: Generator
- [ ] `@simetra/generator-pg` пакет створений в монорепо
- [ ] Генерація CREATE TABLE для всіх 7 типів метаданих
- [ ] FK, indexes, UNIQUE constraints
- [ ] Views для регістрів (balance, turnovers, slice_last)
- [ ] Trigger для автонумерації
- [ ] Polymorphic ref → type + id pair
- [ ] Golden fixture тести для кожного типу
- [ ] `pnpm --filter @simetra/generator-pg test` — green

### Модуль 2: SQL Preview
- [ ] Кнопка "Generate" в UI з Ctrl+G
- [ ] SQL Preview tab з syntax highlighting
- [ ] File navigation у preview
- [ ] Copy / Download SQL
- [ ] Validation перед генерацією

### Модуль 3: Supabase Apply
- [ ] Reference Edge Function для DDL execution
- [ ] Connection settings у Project Settings
- [ ] Apply flow з progress/success/error UI
- [ ] API key НЕ зберігається у .meta.json

### Quality gate
- [ ] `pnpm lint` — без помилок
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm test` — все зелене
- [ ] Generator не залежить від React/browser API
- [ ] Supabase credentials не в Git
