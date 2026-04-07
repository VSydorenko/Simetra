# Task: Phase 2c — Deployment Flow (Manual Apply + CLI)

> **Prerequisite:** Phase 2a (DDL Generator), Phase 2b (Posting Engine) — генератор вже генерує SQL.

## Контекст

Phase 2a створює SQL для структури БД, Phase 2b додає posting functions. Phase 2c замикає цикл — дає користувачу зручний спосіб **застосувати** згенерований SQL на живу БД і підтримувати **еволюцію** схеми.

**Ціль Phase 2c:** Generate → Preview → Copy/Download → Apply (вручну або через CLI).

### Архітектурне рішення: відмова від browser-side Management API

Попередня версія цього task передбачала direct apply з SPA через Supabase Management API (`api.supabase.com`). Під час верифікації виявлено:

1. **Management API не підтримує CORS** — браузер блокує preflight-запити до `api.supabase.com`. Документація Supabase підтверджує CORS тільки для Data API (PostgREST) і Edge Functions.
2. **PAT у браузері — security concern** — Personal Access Token дає повний доступ до акаунту Supabase. Зберігати та використовувати його в SPA неприйнятно.
3. **Simetra — database-agnostic** — BRD (§3.2) позиціонує генерацію як незалежну від конкретного deployment target. Прив'язка apply до Supabase Management API суперечить цьому.

**Прийняте рішення:** два канали apply:
- **Manual Apply** (Phase 2c) — SPA генерує SQL, користувач застосовує через SQL Editor, psql або будь-який інший інструмент
- **CLI Apply** (Phase 2c) — `simetra apply --connection-string` працює з будь-яким PostgreSQL через direct connection

Runtime-інтеграція (supabase-js, форми, CRUD) — **Phase 3**, коли з'явиться `@simetra/form-runtime`.

### Чому це правильний підхід

- DDL apply — одноразова операція при розгортанні або рідкісна при зміні структури, не постійний runtime
- `simetra generate` + `simetra apply` — такий самий workflow як Prisma, Flyway, Liquibase
- Connection string працює з **будь-яким PostgreSQL** — Supabase, self-hosted, RDS, Cloud SQL, local
- `packages/cli` і `packages/generator-pg` вже існують у монорепо
- SPA залишається pure web-first без privileged credentials

---

## Етапи

### Етап 1: Deployment Settings (реалізовано)

> Секція Deployment у Project Settings з target selector і Supabase-specific полями.

- [X] Додати в Project Settings секцію "Deployment" з target selector (Supabase / Manual / None)
- [X] Розширити `projectSchema` у `@simetra/core`:
  ```
  deployment?: {
    target: "supabase" | "manual" | "none"
    supabase?: { projectRef: string }
  }
  ```
- [X] Серіалізація: `DEPLOYMENT_KEY_ORDER`, `DEPLOYMENT_SUPABASE_KEY_ORDER` у `serialization.ts`
- [X] UI: conditional fields залежно від target

### Етап 1.1: Supabase-specific Settings (реалізовано)

> Поля для Supabase projectRef та Access Token (PAT).

#### Core schema — реалізовано
- [X] `supabase.projectRef` (string, min 20) замість `projectUrl`
- [X] Derived URL: `https://{projectRef}.supabase.co` — обчислюється в UI
- [X] Zod `.refine()`: якщо `target === "supabase"`, то `supabase.projectRef` обовʼязковий

#### Credentials — реалізовано
- [X] PAT зберігається в IndexedDB (store: credentials, key: `supabase-access-token:{projectRef}`)
- [X] При зміні `projectRef` — очищається старий credential
- [X] Базова валідація формату: `sbp_` prefix warning

#### UI — реалізовано
- [X] Project Ref input з derived URL hint
- [X] Access Token (PAT) password input з warning
- [X] Test Connection кнопка (викликає Management API)

### Етап 2: Виправлення — прибрати Management API з SPA

> Management API (`api.supabase.com`) не підтримує CORS і не повинен викликатися з браузера. PAT не повинен зберігатися в SPA. Цей етап виправляє помилкове припущення етапів 1–1.1.

#### Видалити browser-side Management API код

- [X] Видалити `apps/web/src/lib/supabase-management.ts` — browser-side Management API helper
- [X] Видалити виклик `testSupabaseConnection()` з `project-settings.tsx`
- [X] Видалити все, що стосується Test Connection: кнопку, стани checking/success/error, handlers
- [X] Видалити PAT (Access Token) input з Project Settings UI
- [X] Видалити збереження/завантаження credentials у IndexedDB для PAT
- [X] Прибрати `credentialId`, `accessToken` state, `saveCredential`/`loadCredential`/`clearCredential` виклики
- [X] Видалити PAT format warning (`sbp_` prefix check)

#### Спростити deployment schema

- [X] У `projectSchema` (`packages/core/src/schemas/project.ts`) прибрати `.refine()` що вимагає `projectRef` при `target === "supabase"` — тепер `projectRef` опціональний для всіх targets (використовується лише як hint для deep links)
- [X] Зберегти `supabase.projectRef` у схемі — він потрібен для формування deep links на Supabase Dashboard і SQL Editor

#### Оновити Project Settings UI

- [X] Секція Deployment залишається з target selector: `supabase` | `manual` | `none`
- [X] При `target: "supabase"`:
  - [X] Project Ref input — опціональний, використовується для deep links
  - [X] Derived URL hint: `https://{ref}.supabase.co`
  - [X] Link "Open SQL Editor" → `https://supabase.com/dashboard/project/{ref}/sql/new` (disabled без ref)
  - [X] Link "Open Table Editor" → `https://supabase.com/dashboard/project/{ref}/editor` (disabled без ref)
  - [X] Hint text: "Згенерований SQL можна застосувати через SQL Editor у Supabase Dashboard або через CLI: `simetra apply`"
- [X] При `target: "manual"`:
  - [X] Hint: "Скопіюйте згенерований SQL і застосуйте вручну через psql, pgAdmin або інший інструмент"
- [X] При `target: "none"`:
  - [X] Без додаткових полів

#### Очистити i18n

- [X] Видалити ключі, що стосуються PAT і Test Connection:
  - `supabaseAccessToken`, `supabaseAccessTokenHint`, `supabaseAccessTokenWarning`, `supabasePatFormatWarning`
  - `credentialSaving`, `credentialSaved`, `credentialCleared`, `credentialSaveError`
  - `connectionCheck`, `connectionCheckAction`, `connectionChecking`, `connectionCheckHint`
  - `connectionSuccess`, `connectionSuccessWithName`, `connectionError`, `connectionStatusUnknown`
- [X] Додати нові ключі:
  - `supabaseOpenSqlEditor` — "Відкрити SQL Editor"
  - `supabaseOpenTableEditor` — "Відкрити Table Editor"
  - `supabaseApplyHint` — hint про способи apply
  - `manualApplyHint` — hint для manual target

#### Міграція існуючих даних

- [ ] Якщо у `project.meta.json` є стара структура `supabase.projectUrl` — витягнути ref із URL при відкритті
- [X] IndexedDB: видалити всі credentials із ключем `supabase-access-token:*` і `supabase-api-key:*` — вони більше не потрібні

#### Тести

- [X] Core: `deployment.target` валідація без `.refine()` для projectRef
- [ ] UI: Project Settings рендерить правильні поля для кожного target
- [X] Переконатися, що `supabase-management.ts` більше не імпортується ніде

### Етап 3: SQL Preview UX для Manual Apply

> Покращити SQL Preview як основний канал apply для SPA-користувачів.

- [ ] SQL Preview toolbar (`sql-toolbar.tsx`) — додати кнопки:
  - [ ] "Copy to Clipboard" — копіює весь згенерований SQL
  - [ ] "Download .sql" — зберігає як файл `{project-name}_{timestamp}.sql`
  - [ ] "Open Supabase SQL Editor" — deep link (видимий тільки якщо `target === "supabase"` і є `projectRef`)
- [ ] Toast після Copy: "SQL скопійовано. Вставте у SQL Editor для застосування"
- [ ] Розділяти SQL Preview на секції з коментарями:
  - `-- DDL: Tables`
  - `-- DDL: Enums`
  - `-- Functions: Posting`
  - `-- Indexes`
- [ ] Показувати кількість statements / estimated tables у footer preview

### Етап 4: CLI Apply (`simetra apply`)

> Додати команду `apply` до `@simetra/cli` для автоматичного застосування міграцій через connection string.

#### Команда `simetra apply`

- [ ] Додати subcommand `apply` у `packages/cli/src/commands/apply.ts`
- [ ] Аргументи:
  - `--connection-string` або env `SIMETRA_DATABASE_URL` — PostgreSQL connection string
  - `--input` — шлях до директорії metadata (default: `.`)
  - `--schema` — SQL schema (default: `public`)
  - `--dry-run` — показати SQL без виконання
  - `--enum-strategy`, `--constants-strategy` — як у `simetra generate`
- [ ] Flow:
  1. Прочитати metadata з `--input`
  2. Згенерувати SQL через `@simetra/generator-pg`
  3. Якщо `--dry-run` — вивести SQL і вийти
  4. Підключитися до PostgreSQL через connection string
  5. Виконати SQL у транзакції
  6. При помилці — rollback і показати error
  7. При успіху — показати summary (created tables, functions)

#### PostgreSQL client

- [ ] Додати `postgres` (або `pg`) як dependency до `packages/cli`
- [ ] Створити `packages/cli/src/db-client.ts` — обгортка для з'єднання:
  - `connect(connectionString)` → client
  - `execute(client, sql)` → result
  - `disconnect(client)`
  - Connection timeout: 10 секунд
  - SSL: дозволити `?sslmode=require` у connection string (стандарт для Supabase і cloud PostgreSQL)

#### Безпека

- [ ] Connection string **ніколи** не зберігається у файлах метаданих
- [ ] Рекомендувати env variable `SIMETRA_DATABASE_URL` замість CLI arg (не потрапляє в shell history з `export`)
- [ ] Валідація connection string формату перед підключенням
- [ ] Sanitization SQL-помилок у виводі (не показувати connection credentials)

#### Тести

- [ ] Unit: argument parsing, dry-run output
- [ ] Integration (optional, з test PostgreSQL): connect → execute DDL → verify tables exist

### Етап 5: Schema Diff

> Порівняння поточних метаданих з раніше застосованим станом для генерації ALTER TABLE міграцій.

- [ ] Schema snapshot: зберігати "applied state" як JSON (які таблиці/колонки створені)
- [ ] Зберігання snapshot у `metadata/.simetra/applied-schema.json` (gitignored)
- [ ] При повторній генерації: порівняти new DDL vs snapshot → показати diff
- [ ] Diff categories: Added tables, Added columns, Modified columns, Dropped columns
- [ ] Генерація ALTER TABLE замість CREATE TABLE для існуючих об'єктів
- [ ] Preview diff перед apply (і в SPA SQL Preview, і в CLI `--dry-run`)
- [ ] Destructive changes (DROP) — потребують explicit confirmation:
  - В SPA: діалог з переліком destructive changes
  - В CLI: `--allow-destructive` flag, без нього — abort з переліком
- [ ] CLI: `simetra apply` використовує diff якщо snapshot існує, повний DDL якщо ні
- [ ] **Тести:**
  - Snapshot create → modify metadata → diff → correct ALTER TABLE
  - Add column → ALTER TABLE ADD COLUMN
  - Remove column → warning + DROP COLUMN з confirmation
  - Change type → ALTER TABLE ALTER COLUMN TYPE
  - Rename detection: не в scope (treat as DROP + ADD)

---

## Clarify (питання перед імплементацією)

- [X] **Edge Function vs Management API vs Manual Apply?** Management API не підтримує CORS з браузера. PAT не повинен зберігатися в SPA. **Рішення: Manual Apply (Copy SQL) + CLI Apply (connection string).**
- [ ] **Snapshot format?** Мінімальний JSON: `{ tables: { name: { columns: [...] } } }`. Або introspect з живої БД? Рекомендація: JSON snapshot для MVP (не потребує live connection). CLI може додати live introspect пізніше.
- [ ] **Чи потрібен rollback?** CLI виконує SQL у транзакції — при помилці PostgreSQL автоматично робить rollback. Ручний rollback успішних міграцій — не в scope, показувати warning "ця дія незворотна".
- [ ] **PostgreSQL client для CLI?** `postgres` (postgresjs) — lightweight, zero-dependency. Альтернатива: `pg` (node-postgres) — більш зрілий, ширший API. Рекомендація: `postgres` для мінімальності CLI.
- [ ] **Connection string у Supabase?** Supabase надає connection string у Dashboard → Settings → Database → Connection string. Формат: `postgresql://postgres.[ref]:[password]@aws-0-{region}.pooler.supabase.com:5432/postgres`. Session pooler підходить для разових міграцій.

## Антипатерни (уникати)

### ❌ PAT у браузері
Не зберігати Personal Access Token або інші привілейовані credentials у SPA. PAT дає повний доступ до акаунту Supabase.

### ❌ Management API з браузера
`api.supabase.com` не підтримує CORS. Не намагатися обійти це через проксі в рамках web SPA — це ускладнює архітектуру без потреби.

### ❌ Supabase-specific apply у SPA
SPA не повинен бути прив'язаний до конкретного deployment target для apply. Generate + Preview + Copy — універсальний flow для будь-якого PostgreSQL.

### ❌ Runtime-інтеграція на Phase 2c
supabase-js client, CRUD через PostgREST, runtime-форми — це Phase 3 (`@simetra/form-runtime`). Не змішувати deployment (DDL) з runtime (DML).

---

## Архітектурні рішення

```mermaid
flowchart TD
  META["Metadata\n(JSON files)"] --> GEN["generator-pg\n(DDL + Functions)"]
  GEN --> SQL["SQL Output"]

  SQL --> SPA_PREVIEW["SPA: SQL Preview\nCopy / Download"]
  SPA_PREVIEW --> MANUAL["Manual Apply\n→ Supabase SQL Editor\n→ psql\n→ pgAdmin\n→ будь-який інструмент"]

  SQL --> CLI["CLI: simetra apply\n--connection-string"]
  CLI --> PG["PostgreSQL\n(будь-який)"]

  SQL --> DIFF["Schema Diff\n(якщо snapshot є)"]
  DIFF --> ALTER["ALTER TABLE\nміграції"]
```

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `docs/architecture/storage-and-persistence.md` — IndexedDB, browser persistence
- `docs/BRD-metadata-configurator.md` — бізнес-вимоги, Phase 2c, Phase 3 roadmap
- `docs/tasks/phase2c-supabase-management-api-blocker.md` — research: чому Management API не працює з SPA
- `.github/instructions/metadata-model.instructions.md` — правила core schema
- `packages/cli/src/commands/generate.ts` — існуюча команда generate
- `packages/generator-pg/src/index.ts` — PostgreSQL DDL генератор
- Supabase Dashboard deep links: `https://supabase.com/dashboard/project/{ref}/sql/new`

## Definition of Done

- [ ] `pnpm lint ; pnpm typecheck` — clean
- [ ] `supabase-management.ts` видалений, PAT input і Test Connection прибрані з UI
- [ ] Project Settings показує deployment target і deep links для Supabase (без privileged credentials)
- [ ] SQL Preview має Copy / Download / Open SQL Editor кнопки
- [ ] CLI: `simetra apply --connection-string` працює end-to-end з PostgreSQL
- [ ] CLI: `simetra apply --dry-run` показує SQL без виконання
- [ ] Schema diff генерує ALTER TABLE при наявності snapshot
- [ ] Destructive changes потребують explicit confirmation (діалог у SPA, `--allow-destructive` у CLI)
- [ ] i18n оновлено: прибрані PAT/connection ключі, додані нові для apply flow
- [ ] Міграція зі старого формату (projectUrl → projectRef, IndexedDB cleanup) працює
