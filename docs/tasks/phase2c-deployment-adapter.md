# Task: Phase 2c — Deployment Adapter + Schema Diff

> **Prerequisite:** Phase 2a (DDL Generator) — генератор вже генерує SQL.

## Контекст

Phase 2a створює SQL для структури БД, Phase 2b додає posting functions. Phase 2c замикає цикл — дозволяє **задеплоїти** згенерований SQL на живу БД і **підтримувати еволюцію** схеми через diff/migrate.

**Ціль Phase 2c:** Generate → Preview → Apply → REST API auto-created. Supabase як перший deployment target.

### Чому Supabase як перший target

- **Instant REST API:** Після `CREATE TABLE` PostgREST автоматично створює REST API для кожної таблиці/view — нуль конфігурації
- **Managed PostgreSQL:** Не потрібно налаштовувати сервер
- **Management API з CORS:** `api.supabase.com` підтримує CORS — SPA може напряму викликати міграції без middleware
- **Auth out of the box:** Row Level Security без власного auth layer (Phase 3+)

### Модель підключення

Simetra — конфігуратор, що **генерує і застосовує DDL** (CREATE TABLE, CREATE FUNCTION, ALTER TABLE тощо). Для цього сценарію:

- **Data API (PostgREST)** — НЕ підходить: не підтримує DDL-операції, тільки SELECT/INSERT/UPDATE/DELETE
- **Supabase Management API** — підходить: ендпоінт `POST /v1/projects/{ref}/database/migrations` приймає довільний SQL, автоматично створює запис у `supabase_migrations`, робить rollback при помилці
- **Edge Functions** — НЕ потрібні: Management API доступний з браузера через CORS, додатковий middleware не потрібен

**Тип ключа:** Personal Access Token (PAT, формат `sbp_...`) — токен акаунту Supabase, дає доступ до Management API. НЕ publishable/anon key (ті тільки для Data API).

---

## Етапи

### Етап 1: Supabase Connection Settings (початкова реалізація)

- [Х] Додати в Project Settings (ObjectProperties → ProjectSettings) секцію "Deployment":
  - Target: dropdown (Supabase / Manual — copy SQL / None)
  - Supabase Project URL: input (`https://{ref}.supabase.co`)
  - Supabase API Key: password input (anon key)
- [Х] Розширити `projectSchema` у `@simetra/core` — додати опціональне поле `deployment`:
  ```
  deployment: {
    target: "supabase" | "manual" | "none",
    supabase?: { projectUrl: string }
  }
  ```
- [Х] API key **НЕ зберігати у файлах метаданих** — тільки в session (IndexedDB або memory)
- [Х] Оновити серіалізацію — `deployment` у key order для project.meta.json
- [Х] UI: секція в ProjectSettings з conditional fields

### Етап 1.1: Виправлення Connection Settings → Management API

> Етап 1 зберіг anon/publishable key і projectUrl. Для DDL потрібен Management API з PAT і projectRef.

#### Core schema (`packages/core`)

- [Х] Замінити `supabase.projectUrl` на `supabase.projectRef` (рядок, 20+ символів — ідентифікатор Supabase-проєкту)
- [Х] `projectUrl` стає derived: `https://{projectRef}.supabase.co` — обчислюється в UI, не зберігається
- [Х] Додати Zod `.refine()`: якщо `target === "supabase"`, то `supabase.projectRef` обовʼязковий
- [Х] Оновити `DEPLOYMENT_SUPABASE_KEY_ORDER` у серіалізації: `["projectRef"]` замість `["projectUrl"]`
- [Х] Тести: валідація інваріанту target/projectRef, парсинг із projectRef

#### Credential lifecycle (`apps/web`)

- [Х] Змінити тип зберіганого ключа: "Supabase Access Token" (PAT, `sbp_...`) замість "API Key (anon key)"
- [Х] Credential ID будувати на `projectRef`: `supabase-access-token:{projectRef}` (стабільний keying)
- [Х] Прибрати fallback на `project.name` — якщо `projectRef` порожній, credential не зберігається
- [Х] При зміні `projectRef` — очищати старий credential за попереднім ID
- [Х] Базова валідація формату: PAT починається з `sbp_` (warning, не блокувати)

#### UI (`apps/web/src/components/properties/project-settings.tsx`)

- [Х] Замінити поле "Supabase Project URL" на "Project Ref (ID)" з пояснюючим placeholder
- [Х] Показувати derived URL як read-only підказку: `https://{ref}.supabase.co`
- [Х] Замінити label "API Key (anon key)" на "Access Token (PAT)" з hint: "Створити: Dashboard → Account → Access Tokens"
- [Х] Попередження: "Токен дає доступ до керування вашим Supabase-акаунтом"
- [Х] Disable поля Access Token, якщо `projectRef` порожній
- [Х] Оновити i18n (uk.json, en.json) для нових labels і hints

#### Міграція існуючих даних

- [ ] Якщо у `project.meta.json` є стара структура `supabase.projectUrl` — автоматично витягнути ref із URL (`https://{ref}.supabase.co` → `ref`) при відкритті проєкту
- [ ] IndexedDB: credentials зі старим keying `supabase-api-key:*` — видалити при першому запуску нової версії (ключ anon більше не потрібен)

### Етап 2: Apply flow через Management API

- [ ] Створити модуль `apps/web/src/lib/supabase-apply.ts`:
  - Функція `applyMigration(projectRef: string, accessToken: string, sql: string, name: string)`:
    - Виклик: `POST https://api.supabase.com/v1/projects/{projectRef}/database/migrations`
    - Headers: `Authorization: Bearer {accessToken}`, `Content-Type: application/json`
    - Body: `{ "query": sql, "name": migrationName }`
    - Повертає: success/failure + details
    - При помилці міграції Supabase автоматично робить rollback
  - Функція `testConnection(projectRef: string, accessToken: string)`:
    - Виклик: `GET https://api.supabase.com/v1/projects/{projectRef}` — перевірка що ref і token валідні
    - Повертає: project name + status або error
- [ ] Додати кнопку "Apply to Supabase" у SQL Preview toolbar (`sql-toolbar.tsx`)
- [ ] Перед apply: виклик `testConnection()` для валідації credentials
- [ ] Migration name: автогенерований `simetra_{timestamp}_{project.name}` або user-overridable
- [ ] Flow: Generate SQL → Preview → Apply → Management API → DB → REST API auto-created

### Етап 3: Apply Status UI

- [ ] Progress indicator при apply (loading state на кнопці + toast)
- [ ] Success toast: "Міграцію застосовано. REST API доступний за: `https://{ref}.supabase.co/rest/v1/{table}`"
- [ ] Error: показати SQL error message з Management API response
- [ ] Link на Supabase Dashboard: `https://supabase.com/dashboard/project/{ref}/editor`
- [ ] "Test Connection" кнопка у Project Settings: перевірити ref + token перед apply

### Етап 4: Schema Diff

- [ ] Schema snapshot: зберігати "applied state" як JSON (які таблиці/колонки створені)
- [ ] Зберігання snapshot у `metadata/.simetra/applied-schema.json` (gitignored)
- [ ] При повторній генерації: порівняти new DDL vs snapshot → показати diff
- [ ] Diff categories: Added tables, Added columns, Modified columns, Dropped columns
- [ ] Генерація ALTER TABLE замість CREATE TABLE для існуючих об'єктів
- [ ] Preview diff перед apply
- [ ] Destructive changes (DROP) — потребують explicit confirmation
- [ ] Apply diff через той самий Management API migrations endpoint (ALTER SQL як migration)
- [ ] **Тести:**
  - Snapshot create → modify metadata → diff → correct ALTER TABLE
  - Add column → ALTER TABLE ADD COLUMN
  - Remove column → warning + DROP COLUMN з confirmation
  - Change type → ALTER TABLE ALTER COLUMN TYPE
  - Rename detection: не в scope MVP (treat as DROP + ADD)

---

## Clarify (питання перед імплементацією)

- [Х] **Edge Function vs Management API?** Management API підтримує CORS і доступний з SPA напряму. Edge Function не потрібна для MVP. **Рішення: Management API.**
- [ ] **Snapshot format?** Мінімальний JSON: `{ tables: { name: { columns: [...] } } }`. Або introspect з живої БД? Рекомендація: JSON snapshot для MVP (не потребує live connection), introspect у Phase 3.
- [ ] **Чи потрібен rollback?** Management API робить auto-rollback при помилці міграції. Ручний rollback успішних міграцій — не в MVP, показувати warning "ця дія незворотна".
- [ ] **PAT scope?** PAT дає доступ до всіх проєктів акаунту. У майбутньому Supabase може додати scoped tokens або OAuth — підготувати UI для переходу.
- [ ] **Rate limits?** Management API має fair-use policy. Для одиничних apply при деплої це не проблема. Batch-операції (кілька міграцій поспіль) — додати throttling.

---

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `docs/architecture/storage-and-persistence.md` — IndexedDB, credentials store
- `docs/BRD-metadata-configurator.md` — бізнес-вимоги, Phase 2c
- `.github/instructions/metadata-model.instructions.md` — правила core schema
- Supabase Management API: `POST /v1/projects/{ref}/database/migrations`
- Supabase API Keys docs: publishable vs secret vs PAT

## Definition of Done

- [ ] `pnpm lint ; pnpm typecheck` — clean
- [ ] Connection settings зберігають `projectRef` у project.meta.json (без Access Token)
- [ ] Access Token зберігається в IndexedDB з keying по `projectRef`
- [ ] Apply flow працює end-to-end через Management API напряму з SPA
- [ ] Test Connection перевіряє ref + token перед apply
- [ ] Schema diff показує коректні відмінності при зміні метаданих
- [ ] ALTER TABLE генерується замість CREATE TABLE для існуючих об'єктів
- [ ] Destructive changes потребують explicit confirmation
- [ ] Міграція зі старого формату (projectUrl → projectRef) працює автоматично
