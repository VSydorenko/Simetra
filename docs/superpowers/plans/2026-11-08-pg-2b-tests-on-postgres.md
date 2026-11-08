# ПГ-2b — DB-тести на стеку `postgres`: план реалізації

> **Статус:** проєкт плану, 2026-11-08; приймає архітекторка
> `runtime-client-data`. Друга частина блоку ПГ-2; стартує після мерджу
> [плану ПГ-2a](2026-11-08-pg-2a-provider-in-engine.md), на `main` з ним.
> **Спільні стеки.** Обидва локальні стеки спільні для сесій машини.
> Виконавець **ніколи** не виконує `pnpm db:stop`, `pnpm db:start`,
> `pnpm db:pg:stop`, `supabase stop`; DB-тести — лише через
> `pnpm --filter … test:db*` під замками стеків. Повторний `pnpm db:pg:start`
> дозволено: він ідемпотентний і бере замок стека.
> **Перед стартом:** `.agents/skills/codebase-research/scripts/orient --plan <цей файл>`;
> якорі, які дає 2a (`postgresClusterSet`, `ensurePostgresCluster`,
> `migrateBetterAuth`, проєкт `db-pg`, `*.postgres.db.test.ts`), звір з кодом
> `main`. Розбіжність імені — перейменуй у плані; поведінки — до архітекторки.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DB-тести платформи типово йдуть на стеку `postgres` від ролі з
атрибутами `simetra_owner`; на стеку `supabase` лишаються регресійні набори
(`db-supabase`, базовий стан провайдера); CI має job `db` на `postgres` і job
`db-supabase`; текст `AGENTS.md` відбиває стан з ПГ-2.

**Architecture:** стек `postgres` дістає ролі Simetra, базу `simetra`
власника й шаблон кроком `simetra roles` у `pnpm db:pg:start`. Тест-інфра
бере ролі запиту, таблицю ідентичності й DSN власника з даних профілю
(`packages/simetra/test/db/profile.ts`, `connection.ts`, `auth.ts`), тож
більшість тестів переходить без правок. Тести, прив'язані до Supabase за
§10.5, — у `*.supabase.db.test.ts`; решта литералів Supabase переводиться на
дані профілю (Р10 плану ПГ-1).

**Tech Stack:** Vitest 5, `pg` 8.23.1, Postgres 17 (стек `simetra-pg`),
`better-auth` 1.7.12 (тест-залежність з 2a), GitHub Actions.

**Spec:** [спека профілю `postgres`](../specs/2026-11-08-postgres-profile-design.md)
— §10.2, §10.3, §10.5, §10.6, §10.7, §12 рядок ПГ-2. Правила тестів — скіл
`writing-tests`.

## Global Constraints

- Мова: коментарі — українською, «чому»; повідомлення тест-інфри й CLI —
  англійською.
- Коміти: Conventional Commits, опис українською, без трейлерів; push і PR —
  архітекторка.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`).
- Один процес vitest — один DB-проєкт.
- Кейс не губиться і не задвоюється при переносі: об'єднання назв
  (`vitest list --staticParse=false --json`) після задачі дорівнює переліку до
  неї; виняток — кейс, розщеплений на два за профілем, з причиною у звіті.
- Тест, прив'язаний до Supabase за §10.5, — у `*.supabase.db.test.ts`; інший
  літерал Supabase в `db` переводиться на дані профілю, а не перейменовується.
- Об'єкти DB-тестів — лише через хелпери тегу (`connection.ts`).
- Dev-паролі стека — у `docker/postgres-stack/dev-secrets.env`, лише для `127.0.0.1`.
- Текст `AGENTS.md` (задача 9) — лише після затвердження власником.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Цільова база DB-тестів стека `postgres` — `simetra`, власник `simetra_owner`; `TEST_STACKS.postgres.databaseUrl` — `postgresql://simetra_owner:<dev>@127.0.0.1:54422/simetra`, `superuserUrl` — `postgres@…/simetra`; пароль — `SIMETRA_OWNER_DEV_PASSWORD` у `dev-secrets.env` | §10.3 «адреси» — назвати базу `simetra` (задача 0) |
| Р2 | `pnpm db:pg:start` після наявних кроків кличе `node packages/designer/bin/simetra.mjs roles docker/postgres-stack/project` з `SIMETRA_DATABASE_URL` суперкористувача до бази `simetra`, потім ставить dev-паролі ролям входу (`simetra_owner`, `simetra_runtime`, `simetra_auth`); тека `docker/postgres-stack/project/` тримає лише `project.meta.json` з `database.provider: "postgres"`. Шапку `scripts/db-stack.mjs` про «без залежностей» уточнити: `start postgres` вимагає `pnpm install` | §10.2 рядок `db:pg:start` (задача 0) |
| Р3 | До ПГ-3 гранти `USAGE` на `better_auth` і `TRIGGER` на `better_auth."user"` для `simetra_owner` і міграцію Better Auth у базі `simetra` ставить `globalSetup` стека `postgres` перед знімком «до» (ідемпотентно, від суперкористувача й `simetra_auth`); ПГ-3 переносить гранти в `roles` і прибирає їх з `globalSetup` | §12 рядок ПГ-3 — «прибрати тимчасові гранти з `globalSetup`» (задача 0) |
| Р4 | Тест-помічник ролей запиту бере призначення (`user`, `anonymous`, `service`), а ім'я ролі — з `PROVIDER_API_ROLES[testProvider()]`; кейс із `service` на профілі без сервісної ролі пропускається `it.skipIf` з причиною «no service role in profile» | немає |
| Р5 | Job `db-supabase` у CI — матриця з рядків `supabase-bound` ПГ-1 (`provider + simetra`, designer 1/2, 2/2); один рядок перевищив би `timeout-minutes` | §10.6 стовпець «Шарди» `db-supabase` (задача 0) |
| Р6 | Проєкт `db-pg` прибирається: `db` обох пакетів іде на стеку `postgres` і включає `*.postgres.db.test.ts`; скрипт `test:db:pg` = `db` обох пакетів; `test:db` = регресія `supabase` | немає (§10.2) |

## Борг з ПГ-1

| Пункт | Де | Що з ним у 2b |
| --- | --- | --- |
| `--passWithNoTests` у `test:db:supabase` ховає зламаний `include` | `packages/*/package.json` | задача 4: прапорець прибрано, тест «кожен DB-проєкт має файли» |
| Тести з жорсткими ролями й схемами Supabase в `db` (Р10 плану ПГ-1; перелік — `grep -nE 'auth\.users\|service_role\|supabase_\|authenticator' $(git ls-files '*.db.test.ts' \| grep -v supabase.db)`) | обидва пакети | задачі 5–8 |
| Пул пулера в половинах `db` (`poolerPoolOf(login, viaPooler)`) | `packages/designer/src/__tests__/support/db.ts` | задачі 7–8: на `postgres` `viaPooler` завжди `false`; перевірка — `db` зелений на `postgres` |
| `scripts/db-stack.mjs` на `spawnSync`: сигнал лише pid вузла лишає `docker compose` сиротою, замок уже застарілий | `scripts/db-stack.mjs` | задача 1: дочірній процес у тій самій групі, обробник сигналу пересилає його й знімає замок; тест на підставному процесі |
| Немає тесту відмови замка на свій pid (Р2 ПГ-1) і тесту завислого `docker exec` | `stack-guard.test.ts`, `external.test.ts` | задача 4 |
| Проводка `abort` у `sweepClient` без тесту; `PASS_PAUSE_MS` без `unref`; `dropped` недораховує після програної гонки | `packages/simetra/test/db/sweep.ts` | лишається боргом (поза метою 2b) |
| Рядок старту guard друкується до `assertStack` | `stack-guard.ts` | задача 4 |
| Поділ файлів подвоює DB-час у `db-supabase` | CI | задача 10 — тривалість рядків у звіт; рішення про шарди — Р5 |
| `STACK_DIR` — залишковий аліас; невдалий `db:signals:start` лишає контейнер до `stop` | `scripts/db-stack.mjs` | задача 1 (аліас); контейнер — лишається боргом |
| `heldTargets` закриває A, B, C послідовно; прямий пул не закривається, якщо `throughPoolerAs` кидає | designer `tenant-creation.support.ts`, `support/db.ts` | задача 8 |
| У реченні `AGENTS.md` про CI — два «and» поспіль | `AGENTS.md` | задача 9 (новий текст) |

## Review Focus

1. **Тест, що на `postgres` мовчки нічого не перевіряє.** Кейс, у якого
   роль запиту стала `null`, пропущено явно з причиною, а не проходить
   порожнім. Тест — задача 2 «skipped service case is reported».
2. **Суперкористувач ховає гранти.** DB-тести плану й застосування йдуть від
   `simetra_owner`, а не від `postgres`. Тест — задача 3 «test database url is
   not a superuser» на стеку.
3. **Повторний `db:pg:start`** ідемпотентний і не ламає прогону, що йде на
   іншому стеку. Перевірка — задача 1, крок 5.
4. **Загублений кейс при переносі.** Перевірка — кожна із задач 5–8,
   порівняння назв.
5. **CI-рядок без тестів.** Тест — задача 4 «every DB project has files».

---

### Task 0: поправки спеки

**Files:** Modify `docs/superpowers/specs/2026-11-08-postgres-profile-design.md`

- [ ] **Step 1:** §10.2 (Р2), §10.3 (Р1; «типово `supabase` до ПГ-2» →
  стан: типово `postgres`), §10.5 (проєкт `db` на `postgres`; без форми «до
  ПГ-2»), §10.6 (Р5; абзац «До ПГ-2» прибрати), §12 рядок ПГ-3 (Р3).
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): профіль postgres — стан після ПГ-2`.

### Task 1: ролі й база `simetra` на старті стека

**Files:**
- Create: `docker/postgres-stack/project/project.meta.json`
- Modify: `docker/postgres-stack/dev-secrets.env` (`SIMETRA_OWNER_DEV_PASSWORD`,
  `SIMETRA_RUNTIME_DEV_PASSWORD`, `SIMETRA_AUTH_DEV_PASSWORD`),
  `scripts/db-stack.mjs` (`startPostgres`, пересилання сигналу, `STACK_DIR`),
  `scripts/db-stack.d.mts`, `packages/simetra/test/db/stack-files.test.ts`

- [ ] **Step 1: failing test** (`stack-files.test.ts`): `project.meta.json`
  стека має `database.provider: "postgres"`; `dev-secrets.env` має три
  паролі; `db-stack.mjs` не вживає `STACK_DIR`; сигнал, надісланий
  pid скрипта під час `withStackLock`, доходить до дочірнього процесу й
  знімає замок (підставна команда `sleep`).
- [ ] **Step 2:** `pnpm --filter simetra test stack-files` — FAIL.
- [ ] **Step 3:** реалізація за Р2; паролі — `ALTER ROLE … PASSWORD` від
  суперкористувача з `-v` змінними `psql`, не інтерполяцією.
- [ ] **Step 4:** PASS; `pnpm db:pg:start` — код 0; `psql` від
  `simetra_owner` до `simetra` — `select current_user` = `simetra_owner`;
  `simetra_template` — `datistemplate`.
- [ ] **Step 5:** повторний `pnpm db:pg:start` — код 0, рядки
  `pg_auth_members` ті самі; `docker ps --filter name=supabase_` — той самий
  uptime (Review Focus 3).
- [ ] **Step 6: Commit** — `build(db): ролі Simetra й база simetra на старті стека postgres`.

### Task 2: тест-помічники за даними профілю

**Files:**
- Modify: `packages/simetra/test/db/connection.ts` (`ApiRole`, `asRole`,
  `queryAs`), `packages/simetra/test/db/auth.ts` (`signUp`),
  `packages/simetra/test/db/profile.ts` (`TEST_STACKS.postgres`, Р1),
  відповідні `*.test.ts`

**Interfaces:**
- Produces:
  - `type RolePurpose = "user" | "anonymous" | "service"`; `asRole(client, purpose, claims?)`,
    `queryAs(client, purpose, sql, params?, claims?)` — ім'я ролі з
    `PROVIDER_API_ROLES[testProvider()]`; призначення без ролі — `Error`
    `no <purpose> role in <provider> profile`;
  - `function testRoleFor(purpose: RolePurpose): string | null`;
  - `signUp(client, account)` — `supabase`: `auth.users` як зараз;
    `postgres`: `INSERT INTO better_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "isAnonymous")`;
    поля `phone` і `meta` акаунта на `postgres` — `Error` з іменем поля
    (аналога в Better Auth немає).

- [ ] **Step 1: failing unit tests:** `testRoleFor` для обох профілів за
  `PROVIDER_API_ROLES`; `asRole(…, "service")` на `postgres` кидає з текстом
  `no service role`; кейс з `it.skipIf(testRoleFor("service") === null)` має
  причину в назві звіту (Review Focus 1).
- [ ] **Step 2:** `pnpm --filter simetra test connection auth profile` — FAIL.
- [ ] **Step 3:** реалізація; виклики `asRole(…, "authenticated")` у тестах
  переходять на призначення механічно (`authenticated` → `user`, `anon` →
  `anonymous`, `service_role` → `service`) у тій самій зміні, без аліасів.
- [ ] **Step 4:** PASS; scoped DB на Supabase `pnpm --filter simetra test:db access membership` — зелені.
- [ ] **Step 5: Commit** — `test(db): ролі запиту й таблиця ідентичності — з даних профілю`.

### Task 3: стек `postgres` — типовий; проєкт `db` переходить

**Files:**
- Modify: `packages/simetra/test/db/profile.ts` (`testProvider()` без змінної —
  `"postgres"`), `packages/simetra/test/db/stack-guard.postgres.ts` (Р3),
  обидва `vitest.config.ts` (`db` — `globalSetup` `stack-guard.postgres.ts`,
  `include` з `*.postgres.db.test.ts`; `db-pg` прибрати),
  `packages/*/package.json`, `package.json` (корінь: `test:db:pg`, `test:db` за Р6),
  `packages/simetra/test/db/stack-guard.test.ts`
- Create: `packages/simetra/test/db/stack-target.postgres.db.test.ts`

- [ ] **Step 1: failing tests:** `testProvider()` без змінної — `postgres`;
  «globalSetup paths exist» і «guards every DB project» — без `db-pg`;
  `stack-target.postgres.db.test.ts`: `current_user` з `testDatabaseUrl()` —
  без `rolsuper`, з `rolbypassrls` і `rolcreatedb` (Review Focus 2);
  `better_auth."user"` існує; `has_table_privilege(current_user, 'better_auth."user"', 'TRIGGER')`.
- [ ] **Step 2:** `pnpm --filter simetra test profile stack-guard` — FAIL.
- [ ] **Step 3:** реалізація; `globalSetup` стека `postgres` за Р3 до знімка «до».
- [ ] **Step 4:** PASS; `pnpm --filter simetra test:db stack-target pgtap interrupt` — зелений, рядок старту `on postgres stack`.
- [ ] **Step 5:** перелік файлів `db`, що падають на `postgres`
  (`pnpm --filter simetra test:db` і `pnpm --filter @simetrajs/designer test:db`, повні) —
  у звіт; це вхід задач 5–8. Падіння тут очікувані й не комітяться як «skip».
- [ ] **Step 6: Commit** — `test(db): стек postgres — типовий для проєкту db`.

### Task 4: раннер pgTAP — теговані бази, `SET ROLE`, claims; борг guard

**Files:**
- Modify: `packages/simetra/test/db/pgtap.ts`, `pgtap.test.ts`, `pgtap.db.test.ts`,
  `packages/simetra/test/db/pgtap/postgres/stack-base-state.pgtap.sql`,
  `packages/simetra/test/db/stack-guard.ts`, `stack-guard.test.ts`,
  `packages/simetra/test/db/external.test.ts`, `packages/*/package.json` (`--passWithNoTests`)
- Create: `packages/simetra/test/db/pgtap/postgres/roles.pgtap.sql`

**Interfaces:**
- Produces: `runPgTap(url: string, sql: string, opts?: { role?: string; claims?: Record<string, unknown> }): Promise<TapResult>`
  — після `BEGIN` і маркера: `set_config('request.jwt.claims', …, true)`, потім
  `SET LOCAL ROLE`; заголовок набору `-- pgtap: role=<призначення> claims=<json>`
  (необов'язковий) читає `pgtap.db.test.ts`; набір іде в тегованій базі з
  `simetra_template` (`CREATE DATABASE … TEMPLATE`), яка видаляється у `finally`.

- [ ] **Step 1: failing tests:** unit — заголовок розбирається; невідоме
  призначення — помилка; `SET ROLE` і claims стоять до тексту набору;
  `roles.pgtap.sql` — атрибути й членства ролей §3.1 стека
  (`simetra_owner`, `simetra_command`, `simetra_runtime`, `simetra_user`,
  `simetra_anon`, `simetra_auth`), `better_auth` належить `simetra_auth`,
  `simetra_template` — шаблон з `plpgsql_check`; набір з `role=user` бачить
  `current_user = simetra_user`; guard: замок свого pid — відмова «one DB
  project per vitest process»; завислий `docker exec` у `runContainers` —
  помилка до дедлайну; рядок старту — після `assertStack`; кожен DB-проєкт
  кожного пакета має хоча б один файл (Review Focus 5).
- [ ] **Step 2:** `pnpm --filter simetra test pgtap stack-guard external` — FAIL.
- [ ] **Step 3:** реалізація; `--passWithNoTests` прибрати.
- [ ] **Step 4:** PASS; `pnpm --filter simetra test:db pgtap` — зелений.
- [ ] **Step 5: Commit** — `test(db): раннер pgTAP з тегованою базою, роллю й claims; набір ролей стека`.

### Tasks 5–8: перенос DB-тестів на стек `postgres` пакетами

Один пакет — одна задача, один коміт. Для кожного:

- [ ] **Step 1:** до змін — `vitest list --staticParse=false --json` проєктів
  `db` і `db-supabase` пакета (окремі виклики) → scratchpad.
- [ ] **Step 2:** кожен файл пакета з переліку задачі 3, крок 5, і з боргу Р10:
  - кейс прив'язаний до Supabase за §10.5 (прийом бази Supabase, пресет
    `supabase`, провізія з `auth.users`, пулер, ролі провайдера) — у сусідній
    `*.supabase.db.test.ts`, спільний setup — у наявний `support/` модуль;
  - інакше — літерал ролі чи схеми Supabase на дані профілю (`testRoleFor`,
    `PROVIDER_*[testProvider()]`, `signUp`); суперкористувач `supabase_admin`
    → `testSuperuserUrl()`;
  - кейс, що перевіряє відсутність сервісної ролі, на `postgres` — `skipIf` з
    причиною (Р4).
- [ ] **Step 3:** назви після = до (Global Constraints).
- [ ] **Step 4:** `pnpm --filter <пакет> test:db <файли пакета>` — зелені на
  `postgres`; `pnpm --filter <пакет> test:db:supabase` — зелений на `supabase`.
- [ ] **Step 5: Commit** — `test(db): <пакет> на стеку postgres`.

Пакети:

- **Task 5 — simetra, права й доступ:** `test/db/` (`access`, `membership`,
  `rights-*`, `command-grants`, `platform-users`, `subscriptions`, …).
- **Task 6 — simetra, компілятор і схема:** `src/**/__tests__/*.db.test.ts`
  (`reference-domain` та ін.).
- **Task 7 — designer, схемний рушій:** `src/schema-engine/__tests__/`
  (`engine-census`, `engine-extract`, `build-plan-promotion`, …); пул пулера —
  `viaPooler` `false` на `postgres`.
- **Task 8 — designer, інструменти й рантайм:** `src/__tests__/` (`data-tools`,
  `command-runtime`, `tenant-creation`, `rights-*`, `runtime-login`, …);
  `heldTargets` закриває A, B, C через `Promise.allSettled`; прямий пул
  закривається, коли `poolerPoolOf` кидає.

### Task 9: текст `AGENTS.md` (виконання — лише після затвердження власником)

**Files:** Modify `AGENTS.md` (розділ «Commands and gates»)

- [ ] **Step 1:** архітекторка передає власнику текст §10.7 спеки (з
  поправками задачі 0), де «Database tests» описують стан ПГ-2: `test:db:pg`
  — типовий набір; `test:db` — регресія `supabase`; CI — job `db` на
  `postgres` і job `db-supabase`; речення про CI без двох «and» поспіль.
- [ ] **Step 2:** після затвердження — правка дослівно,
  `python3 scripts/check-doc-anchors.py`, `pnpm format:check`, коміт
  `docs(agents): DB-тести типово на стеку postgres`.

### Task 10: CI

**Files:** Modify `.github/workflows/ci.yml`

- [ ] **Step 1:** job `db` — стек `postgres` (`pnpm db:pg:start`, три спроби,
  `node scripts/db-stack.mjs stop postgres --volumes || true` між ними);
  матриця: `postgres base state + simetra` (`pnpm --filter simetra test:db`),
  `designer 1/4`…`4/4` (`pnpm --filter @simetrajs/designer test:db --shard=N/4`).
- [ ] **Step 2:** job `db-supabase` — стек Supabase (наявний старт із трьома
  спробами); матриця за Р5: `provider + simetra` (`pnpm exec supabase test db && pnpm --filter simetra test:db:supabase`),
  `designer 1/2`, `2/2` (`pnpm --filter @simetrajs/designer test:db:supabase --shard=N/2`).
- [ ] **Step 3:** job `db-postgres` прибрати.
- [ ] **Step 4:** `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` — без помилки.
- [ ] **Step 5: Commit** — `ci: DB-тести на стеку postgres, окремий job db-supabase`.
- [ ] **Step 6:** після push архітекторкою — усі jobs зелені; тривалість
  кожного рядка — у звіт.

### Task 11: документація

**Files:** Modify `README.md`, `docs/architecture/repository.md`,
`docs/architecture/release.md`, `.agents/skills/writing-tests/SKILL.md`,
`docs/ROADMAP.md`

- [ ] **Step 1:** DB-тести типово на стеку `postgres` (`pnpm db:pg:start`,
  `pnpm test:db:pg`), регресія `supabase` — `pnpm test:db`; правило
  `*.postgres.db.test.ts` і `*.supabase.db.test.ts` у `writing-tests`.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py`, `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs: DB-тести типово на стеку postgres`.

### Task 12: гейти

- [ ] **Step 1:** `git merge origin/main`.
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — зелені.
- [ ] **Step 3:** `pnpm test:db:pg` (повний, `postgres`) і `pnpm test:db`
  (повний, `supabase`) — по одному разу; зелені; `docker ps -a --filter label=simetra-run` — порожньо.
- [ ] **Step 4:** `pnpm build:packages && pnpm test:packaging`; `python3 scripts/check-doc-anchors.py`.

## Готово (§12, рядок ПГ-2, частина 2b)

- Проєкт `db` зелений на `postgres` від ролі з атрибутами власника,
  `db-supabase` — на `supabase`; назви кейсів збережено.
- Тест ролей §3.1 (набір `roles.pgtap.sql`) зелений.
- CI: job `db` на `postgres`, job `db-supabase`; зелені.
- Текст `AGENTS.md` передано власнику; правка — після затвердження.
