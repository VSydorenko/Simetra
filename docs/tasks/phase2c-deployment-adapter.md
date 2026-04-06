# Task: Phase 2c — Deployment Adapter + Schema Diff

> **Prerequisite:** Phase 2a (DDL Generator) — генератор вже генерує SQL.

## Контекст

Phase 2a створює SQL для структури БД, Phase 2b додає posting functions. Phase 2c замикає цикл — дозволяє **задеплоїти** згенерований SQL на живу БД і **підтримувати еволюцію** схеми через diff/migrate.

**Ціль Phase 2c:** Generate → Preview → Apply → REST API auto-created. Supabase як перший deployment target.

### Чому Supabase як перший target

- **Instant REST API:** Після `CREATE TABLE` PostgREST автоматично створює REST API для кожної таблиці/view — нуль конфігурації
- **Managed PostgreSQL:** Не потрібно налаштовувати сервер
- **Web SPA friendly:** Edge Functions для privileged операцій без бекенду
- **Auth out of the box:** Row Level Security без власного auth layer (Phase 3+)

---

## Етапи

### Етап 1: Supabase Connection Settings

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

### Етап 2: Apply flow через Supabase Edge Function

- [ ] Створити reference Edge Function (`supabase/functions/apply-migrations/index.ts`):
  - Приймає: SQL payload (string)
  - Виконує: `sql` через Supabase Management API або `postgres` connection
  - Повертає: success/failure + details
  - Auth: перевірка JWT або custom secret
- [ ] Документація як задеплоїти Edge Function в свій Supabase проєкт
- [ ] Додати кнопку "Apply to Supabase" у SQL Preview panel
- [ ] Flow: Generate SQL → Preview → Apply → Edge Function → DB → REST API auto-created

### Етап 3: Apply Status UI

- [ ] Progress indicator при apply
- [ ] Success: "Таблиці створено. REST API доступний за: {supabase_url}/rest/v1/{table}"
- [ ] Error: показати SQL error message з Supabase
- [ ] Link на Supabase Dashboard Table Editor

### Етап 4: Schema Diff

- [ ] Schema snapshot: зберігати "applied state" як JSON (які таблиці/колонки створені)
- [ ] Зберігання snapshot у `metadata/.simetra/applied-schema.json` (gitignored)
- [ ] При повторній генерації: порівняти new DDL vs snapshot → показати diff
- [ ] Diff categories: Added tables, Added columns, Modified columns, Dropped columns
- [ ] Генерація ALTER TABLE замість CREATE TABLE для існуючих об'єктів
- [ ] Preview diff перед apply
- [ ] Destructive changes (DROP) — потребують explicit confirmation
- [ ] **Тести:**
  - Snapshot create → modify metadata → diff → correct ALTER TABLE
  - Add column → ALTER TABLE ADD COLUMN
  - Remove column → warning + DROP COLUMN з confirmation
  - Change type → ALTER TABLE ALTER COLUMN TYPE
  - Rename detection: не в scope MVP (treat as DROP + ADD)

---

## Clarify (питання перед імплементацією)

- [ ] **Edge Function vs direct connection?** Edge Function безпечніший (не виносити DB password у фронтенд). Рекомендація: Edge Function для MVP.
- [ ] **Snapshot format?** Мінімальний JSON: `{ tables: { name: { columns: [...] } } }`. Або introspect з живої БД? Рекомендація: JSON snapshot для MVP (не потребує live connection), introspect у Phase 3.
- [ ] **Чи потрібен rollback?** Відкат ALTER TABLE operations. Рекомендація: не в MVP — показувати warning "ця дія незворотна".

---

## Definition of Done

- [ ] `pnpm lint ; pnpm typecheck` — clean
- [ ] Connection settings зберігаються у project.meta.json (без API key)
- [ ] Apply flow працює end-to-end з Supabase Edge Function
- [ ] Schema diff показує коректні відмінності при зміні метаданих
- [ ] ALTER TABLE генерується замість CREATE TABLE для існуючих об'єктів
- [ ] Destructive changes потребують explicit confirmation
- [ ] Reference Edge Function задокументована з інструкцією деплою
