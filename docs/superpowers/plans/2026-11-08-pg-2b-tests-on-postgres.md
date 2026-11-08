# ПГ-2b — DB-тести на стеку `postgres`: план реалізації

> **Статус:** проєкт плану, 2026-11-08; приймає архітекторка
> `runtime-client-data`. Друга частина блоку ПГ-2; стартує після мерджу
> [плану ПГ-2a](2026-11-08-pg-2a-provider-in-engine.md), на `main` з ним.
> **Спільні стеки.** Обидва локальні стеки спільні для сесій машини.
> Виконавець **ніколи** не виконує `pnpm db:stop`, `pnpm db:start`,
> `pnpm db:pg:stop`, `supabase stop`, `node scripts/db-stack.mjs stop … [--volumes]`,
> `docker compose -p simetra-pg …`, `docker volume rm`; DB-тести — лише через
> `pnpm --filter … test:db*` під замками стеків. Повторний `pnpm db:pg:start`
> дозволено, лише коли запущений стек зібрано з файлів цієї гілки
> (`docker/postgres-stack/` без змін проти `main`); після задачі 1 розбіжність
> конфігу дає відмову, а не перестворення.
> **Перед стартом:** `.agents/skills/codebase-research/scripts/orient --plan <цей файл>`;
> якорі, які дає 2a (`postgresClusterSet`, `ensurePostgresCluster`,
> `migrateBetterAuth`, `prepareStackIdentity`, `taggedClusterSet`, проєкт
> `db-pg` обох пакетів, `*.postgres.db.test.ts`, кроки `roles` і
> `better-auth-cli.ts` у `db:pg:start`, `ApplyDatabase.statement`), звір з
> кодом `main`. Розбіжність імені — перейменуй у плані; поведінки — до
> архітекторки.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DB-тести платформи типово йдуть на стеку `postgres` з
`current_user = simetra_owner`; на стеку `supabase` лишаються регресійні
набори (`db-supabase`, базовий стан провайдера); CI має job `db` на
`postgres` і job `db-supabase`; текст `AGENTS.md` для стану з ПГ-2 передано
власнику.

**Architecture:** стек `postgres` після 2a має ролі Simetra, базу `simetra`
власника, шаблон і таблиці Better Auth (`pnpm db:pg:start`, Р13 ПГ-2a).
Тести входять суперкористувачем стека, а кожне з'єднання з адреси тестів
стартує з `role = simetra_owner` (Р1): гранти, `BYPASSRLS` і RLS діють як у
проді, а `SET LOCAL ROLE` у роль запиту чи команд дозволено, бо право
перемикання перевіряється за `session_user`. Роль запиту, таблицю
ідентичності, власника й провайдера компіляції тест-інфра бере з даних
профілю (`PROVIDER_*[testProvider()]`). Кожен DB-файл до переносу дістає
рішення в інвентарі (задача 2): нейтральний до профілю, прив'язаний до
Supabase за §10.5 чи розщеплений. Перенос іде підсистемами; поки він триває,
проєкт `db` лишається на `supabase`, а `db-pg` росте явним переліком, тож
кожен коміт зелений; останнє перемикання — одна задача (Р6).

**Tech Stack:** Vitest 5, `pg` 8.23.1, Postgres 17 (стек `simetra-pg`),
`better-auth` 1.7.12 (тест-залежність з 2a), GitHub Actions.

**Spec:** [спека профілю `postgres`](../specs/2026-11-08-postgres-profile-design.md)
— §4.4, §10.1–§10.7, §12 рядки ПГ-2 і ПГ-3. Правила тестів — скіл
`writing-tests`.

## Global Constraints

- Мова: коментарі — українською, «чому»; повідомлення тест-інфри й CLI —
  англійською.
- Коміти: Conventional Commits, опис українською, без трейлерів; push і PR —
  архітекторка.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`).
- Один процес vitest — один DB-проєкт.
- **Кожен коміт зелений.** До задачі 14 проєкт `db` іде на `supabase`;
  перенесений файл входить у `db-pg` і виходить з `db` тим самим комітом
  (Р6).
- **Кейс не губиться і не задвоюється.** Перелік назв знімається
  `vitest list --staticParse=false --json` з фіксованим
  `SIMETRA_TEST_PROVIDER` (`supabase` для `db` і `db-supabase`, `postgres` для
  `db-pg`), окремим викликом на проєкт; ключ — повна назва
  (`describe > … > it`), не файл. Переліки «до» знімаються з тією самою
  змінною. Об'єднання назв трьох проєктів після задачі дорівнює об'єднанню
  до неї; виняток — кейс, розщеплений за профілем, з причиною у звіті.
- **Обхід суперкористувачем видно.** Кожна задача переносу звітує
  `git grep -c "testSuperuserUrl()\|asSuperuser(\|asStackSuperuser(" -- packages`
  до й після; кожен приріст — з причиною для кожного кейса.
- **Пропуск не ховає перевірку.** У `db` немає `it.skipIf` за
  `testRoleFor`; кейс, якому потрібна сервісна роль, — у
  `*.supabase.db.test.ts` (Р5). Кожна задача переносу звітує число
  пропущених кейсів на кожному стеку (`--reporter=json`, `numPendingTests`).
- Тест, прив'язаний до Supabase за §10.5, — у `*.supabase.db.test.ts`; інший
  літерал Supabase в `db` переводиться на дані профілю, а не
  перейменовується.
- Об'єкти DB-тестів — лише через хелпери тегу (`connection.ts`).
- Dev-паролі стека — у `docker/postgres-stack/dev-secrets.env`, лише для
  `127.0.0.1`; DSN з паролем читається лінивою функцією, як
  `garageAdminToken`, не при імпорті.
- Перемикання ролі сесії (`RESET ROLE`, `SET ROLE NONE`,
  `SET SESSION AUTHORIZATION`) — лише в хелпері `asStackSuperuser`
  (`connection.ts`) і в файлах, названих у тесті задачі 3.
- Задачу 16 (текст `AGENTS.md`) виконавець не виконує (Р14).

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Модель з'єднання тестів на `postgres`** (варіант «а» аудиту, рішення архітекторки). Тести входять суперкористувачем стека; адреса тестів несе стартовий параметр `options=-c role=simetra_owner`, тож **кожне** нове з'єднання, і тест-хелпера, і рушія чи pg-delta з тієї самої адреси, стартує з `current_user = simetra_owner`. `SET LOCAL ROLE <запиту\|команд>` дозволено, бо перемикання перевіряється за `session_user`: рядки `GRANT simetra_command TO CURRENT_USER` у файлах `db` прибираються. Об'єкти, яких власник не створить (`CREATE ROLE`, `CREATE EXTENSION`), — хелпер `asStackSuperuser(client, fn)`: точка збереження, `SET LOCAL ROLE NONE`, прелюдія `search_path`, `fn`, `RELEASE`; на збої — `ROLLBACK TO SAVEPOINT`, що повертає `simetra_owner`. `signUp` на `postgres` — `SET LOCAL ROLE simetra_auth`, як у проді; DML-гранту власнику на `better_auth` немає. Код, що читає `session_user` (прелюдія `roles` у `postgres-cluster.ts`, `runtime.privileged-login` ПГ-3), іде окремим DSN суперкористувача без `options` | §10.3 «адреси» — модель і перелік читачів `session_user` (задача 0) |
| Р2 | Цільова база тестів стека `postgres` — `simetra`. `TEST_STACKS.postgres.databaseUrl` = `postgresql://postgres:postgres@127.0.0.1:54422/simetra?options=-c%20role%3D<PROVIDER_OWNER_ROLES.postgres>`, `superuserUrl` — та сама база без `options`. Набір базового стану pgTAP і далі йде в базі `postgres` (кластерні факти й `simetra.environment` стоять там). Прибиральник робить `DROP OWNED BY` у `postgres` і в базі `testDatabaseUrl()`; `manualSweepSql` і `leakMessage` називають обидві. `assertStack`, `snapshot`, `stopRunBackends` — у базі `postgres`, від суперкористувача з прелюдією `SET ROLE NONE`, `SET search_path = pg_catalog, pg_temp` і з `pg_catalog.`-кваліфікованими каталогами | §10.3 «адреси» — база `simetra` (задача 0) |
| Р3 | Guard стека `postgres` після `acquireLock` і `assertStack`, до `snapshot`, звіряє колонки `better_auth."user"` бази `simetra` (порядок `ordinal_position`) з `PROVIDER_EVENT_SOURCES.postgres`; розбіжність — відмова `better_auth."user" of database simetra does not match this branch (…)`: бракує колонок — порада `pnpm db:pg:start`; зайві — стек з іншої гілки, зупинка стека — за власником. Міграцію й тимчасові гранти дає `db:pg:start` (Р13 ПГ-2a), не `globalSetup` | §10.3 «знімок стека» — звірка `better_auth` (задача 0); §12 рядок ПГ-3 (перенос грантів у `roles`, тест гранту на тегованому кластері, свіжий стек у CI) — править ПГ-3 |
| Р4 | Тест-помічники ролей беруть **призначення** (`user`, `anonymous`, `service`), ім'я ролі — з `PROVIDER_API_ROLES[testProvider()]`. Порядок аргументів не змінюється: `queryAs(client, purpose, claims, sql, params)`, `asRole(client, purpose, claims)`. Claims на `postgres` без `role` (§4.4): тест, що будує `{ role: "authenticated" }`, бере claims з `claimsFor(purpose, sub?)` | немає |
| Р5 | Кейс, якому потрібна сервісна роль, — у `*.supabase.db.test.ts` (ролі провайдера, §10.5); на `postgres` лишається кейс, що доводить **відсутність** сервісних грантів; `it`, що змішує сервісні й користувацькі перевірки, розщеплюється, щоб користувацькі йшли на `postgres` | немає (§10.5) |
| Р6 | **Зелені коміти.** Під час переносу `db` обох пакетів лишається на `supabase`; `db-pg` включає `**/*.postgres.db.test.ts` і явний перелік `ON_POSTGRES` перенесених файлів у `vitest.config.ts` пакета, який `db` виключає. Задача 14 перейменовує `db-pg` на `db`, перемикає типовий профіль на `postgres`, прибирає `db` на `supabase` і `ON_POSTGRES`; CI — задача 15 одразу після | немає (§10.2, §10.5 описують стан) |
| Р7 | Спільні фікстури компіляції (`fixtures/rights.ts` `defaults()` і `singleTenantRights()`, `fixtures/kitchen-sink.ts` `kitchenSink()`) дістають явний параметр `provider`; типове значення лишається `supabase`, тож unit-тести не змінюються; DB-викликачі передають `testProvider()` | немає |
| Р8 | Файл корпусу рушія зі `scope.provider: "supabase"`, що перевіряє поверхню Supabase (ролі провайдера в SQL, публікації, `PROVIDER_SCHEMAS.supabase`), стає `*.supabase.db.test.ts`; звірено: `engine-census`, `engine-extract`, `round-trip`, `fingerprint-coverage`, `promotion-equivalence` | §10.5 — «корпус рушія профілю `supabase`» у переліку `db-supabase` (задача 0) |
| Р9 | `interrupt.db.test.ts` іде і в `db-supabase` (рядок `include`): шлях guard і прибиральника на стеку Supabase лишається покритим | немає |
| Р10 | Раннер pgTAP: суперкористувач стека, тегована база `CREATE DATABASE … TEMPLATE simetra_template` від суперкористувача, `DROP` у `finally`; `pgtap` створює раннер до `SET ROLE`; claims — `SESSION_CLAIMS_SETTING`; із заголовком `role=` раннер відхиляє в наборі `reset role`, `set role`, `set session authorization` і після набору, до `ROLLBACK`, звіряє `current_user`. Базовий стан — база `postgres`, без тегованої бази | немає (§10.5) |
| Р11 | `scripts/db-stack.mjs`: дочірній процес — асинхронний `spawn` у власній групі (`detached: true`), сигнал пересилається групі один раз, замок знімається лише після виходу дочірнього (межа 30 с, потім SIGKILL групи); кроки з базою — `PGAPPNAME=simetra_db_start`, їхні бекенди суперкористувач завершує до зняття замка. `start` на запущеному стеку — `up -d --wait --no-recreate`; розбіжність `docker compose config --hash` з міткою `com.docker.compose.config-hash` контейнера — відмова «stack config differs from this branch; stopping the stack is the owner's call» | §10.2 рядок `db:pg:start` — повтор без перестворення (задача 0) |
| Р12 | Job `db-supabase` у CI — матриця: `provider + simetra`, `designer 1/2`, `designer 2/2`; один рядок перевищив би `timeout-minutes` | §10.6 стовпець «Шарди» `db-supabase` (задача 0) |
| Р13 | Бенчмарк `packages/simetra/bench/rights.bench.db.ts` лишається на `supabase` (проєкт `bench`, `stack-guard.supabase.ts`); задача 4 лише переводить його виклики на нові сигнатури | немає |
| Р14 | Задачу 16 виконавець не виконує: передає текст §10.7 архітекторці й іде далі; правка `AGENTS.md` — частина приймання архітекторкою після затвердження власником; гейти її не вимагають; у тексті PR — що рядки `AGENTS.md` про `test:db` і `test:db:pg` застарілі до затвердження | немає |

## Борг з ПГ-1

| Пункт | Де | Що з ним у 2b |
| --- | --- | --- |
| `--passWithNoTests` у `test:db:supabase` ховає зламаний `include` | `packages/*/package.json` | задача 5: прапорець прибрано, тест «every DB project has files» |
| Тести з жорсткими ролями, схемами й провайдером Supabase в `db` | обидва пакети | задача 2 — інвентар; задачі 7–13 — перенос |
| Пул пулера в половинах `db` (`poolerPoolOf(login, viaPooler)`) | designer `support/db.ts`, `*.support.ts` | задача 4 (`support/db.ts`), задачі 12–13: на `postgres` `viaPooler` завжди `false` |
| `scripts/db-stack.mjs` на `spawnSync`: сигнал лише pid вузла лишає `docker compose` сиротою, замок уже застарілий | `scripts/db-stack.mjs` | задача 1 (Р11) |
| Немає тесту відмови замка на свій pid (Р2 ПГ-1) і тесту завислого `docker exec` | `stack-guard.test.ts`, `external.test.ts` | задача 5 |
| Проводка `abort` у `sweepClient` без тесту; `PASS_PAUSE_MS` без `unref`; `dropped` недораховує після програної гонки | `packages/simetra/test/db/sweep.ts` | лишається боргом (поза метою 2b) |
| Рядок старту guard друкується до `assertStack` | `stack-guard.ts` | задача 5 |
| Поділ файлів подвоює DB-час у `db-supabase` | CI | задача 15 — тривалість рядків у звіт; шарди — Р12 |
| `STACK_DIR` — залишковий аліас; невдалий `db:signals:start` лишає контейнер до `stop` | `scripts/db-stack.mjs` | задача 1 (аліас); контейнер — лишається боргом |
| `heldTargets` закриває A, B, C послідовно; прямий пул не закривається, якщо `throughPoolerAs` кидає | designer `tenant-creation.support.ts`, `support/db.ts` | задача 13 |
| У реченні `AGENTS.md` про CI — два «and» поспіль | `AGENTS.md` | задача 16 (новий текст) |

## Review Focus

1. **Суперкористувач ховає гранти.** Кожне з'єднання з адреси тестів має
   `current_user = simetra_owner`, зокрема друге з'єднання пулу й з'єднання
   рушія; збій усередині `asStackSuperuser` повертає власника; приріст
   `testSuperuserUrl()`/`asSuperuser(`/`asStackSuperuser(` має причину. Тести
   — задача 3 (i), (ii), (iii); звіти задач 7–13.
2. **Перевірка, що на `postgres` мовчки зникла.** Немає `skipIf` за
   `testRoleFor` у `db`; сервісні кейси — у `db-supabase`; змішані `it`
   розщеплено. Тест — задача 4 (статичний); звіти пропусків задач 7–13.
3. **Повторний `db:pg:start`** не перестворює контейнерів і не знімає замка
   до виходу дочірнього процесу. Перевірка — задача 1, кроки 1 і 4: uptime
   `simetra-pg-*` (і `supabase_*`, якщо піднято) той самий.
4. **Загублений кейс при переносі.** Перевірка — кожна із задач 7–14,
   об'єднання повних назв.
5. **Червоний коміт.** Кожен коміт задач 1–13 лишає `pnpm test:db` (на
   `supabase`) і `pnpm test:db:pg` зеленими; CI-рядок без тестів ловить тест
   задачі 5 «every DB project has files».

---

### Task 0: поправки спеки

**Files:** Modify `docs/superpowers/specs/2026-11-08-postgres-profile-design.md`

- [ ] **Step 1:** §10.2 (рядки `test:db:pg` і `test:db` — лише форма «з
  ПГ-2»; `db:pg:start` — Р11), §10.3 (типово `postgres`; «адреси» — Р1, Р2 і
  перелік читачів `session_user`; «знімок стека» — Р3), §10.5 (проєкт `db` на
  `postgres` без форми «до ПГ-2»; Р8), §10.6 (Р12; абзац «До ПГ-2»
  прибрати), §10.7 (рядки `test:db:pg` і `test:db` — стан після задачі 14;
  абзац про CI без двох «and» поспіль; речення «ПГ-1 вносить проміжний
  текст» прибрати). Рядок ПГ-3 §12 не правити: перенос тимчасових грантів у
  `roles` і тест гранту на тегованому кластері передано ПГ-3 (його задача 0).
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): профіль postgres — стан після ПГ-2`.

### Task 1: борг `scripts/db-stack.mjs`

**Files:** Modify `scripts/db-stack.mjs`, `scripts/db-stack.d.mts`,
`packages/simetra/test/db/stack-files.test.ts`

**Interfaces:**
- Produces: `runChild(command, args, opts, spawnFn = spawn): Promise<number>` —
  шов тесту; `compose()`, кроки `garage*`, `psql`, `simetra roles` і
  `better-auth-cli.ts` (з 2a) ідуть через нього; `withStackLock(path, fn)`
  знімає замок лише після завершення `fn`.

- [ ] **Step 1: failing tests** (`stack-files.test.ts`, підставний `spawnFn`):
  `db-stack.mjs` не вживає `STACK_DIR`; дочірній процес стартує з
  `detached: true`; сигнал скрипту пересилається групі дочірнього рівно раз;
  дочірній, що ігнорує перший сигнал, тримає замок, доки живий; після межі —
  SIGKILL групи, потім замок знято; кроки з базою мають
  `PGAPPNAME=simetra_db_start`; `start` на запущеному стеку передає
  `--no-recreate`; розбіжність хешу конфігу — відмова з текстом
  `stopping the stack is the owner's call`, жодного `up`.
- [ ] **Step 2:** `pnpm --filter simetra test stack-files` — FAIL.
- [ ] **Step 3:** реалізація за Р11; перед зняттям замка —
  `pg_terminate_backend` бекендів з `application_name = 'simetra_db_start'`
  від суперкористувача. Перед правкою звір `startPostgres` і `devSecrets()` на
  `main` (2a їх змінює).
- [ ] **Step 4:** PASS; uptime `simetra-pg-postgres-1`, `-garage-1`,
  `-centrifugo-1` (і `supabase_*`, якщо піднято) до й після повторного
  `pnpm db:pg:start` — той самий; код 0 (Review Focus 3).
- [ ] **Step 5: Commit** — `build(db): старт стека postgres тримає замок до виходу дочірнього процесу й не перестворює контейнерів`.

### Task 2: інвентар DB-файлів

**Files:** — (лише звіт задачі; у `docs/` не комітиться)

- [ ] **Step 1:** перелік кандидатів:
  ```bash
  git grep -lE '"authenticated"|"anon"|\banon\b|service_role|authenticator|supabase_|auth\.users|provider: "supabase"|owner postgres|readRoleOf\("supabase"\)' \
    -- '*.db.test.ts' '*.support.ts' 'packages/designer/src/__tests__/support/*.ts' 'packages/simetra/test/db/*.ts' 'packages/simetra/bench/*.ts'
  ```
  плюс кожен файл `git ls-files '*.db.test.ts' | grep -v '\.supabase\.db\.\|\.postgres\.db\.'`
  без збігу.
- [ ] **Step 2:** таблиця у звіті: файл → `profile-neutral` |
  `supabase-bound` (пункт §10.5 чи Р8) | `split` (які кейси куди) → задача
  7–13; для кожного файла — що зачіпає (`GRANT … TO CURRENT_USER`,
  `CREATE ROLE`, `signUp`, claims з `role`, сервісна роль, фікстура з
  провайдером, пулер, `CONNECT`). Кожен файл має рівно одну задачу.
- [ ] **Step 3:** таблицю — архітекторці до задачі 7; файл, якого немає в
  переліках задач 7–13, — до архітекторки, не на вибір виконавця.

### Task 3: модель з'єднання тестів на `postgres`

**Files:**
- Modify: `packages/simetra/test/db/profile.ts` (`TEST_STACKS.postgres`, Р2),
  `packages/simetra/test/db/connection.ts`, `connection.test.ts`,
  `profile.test.ts`, `packages/simetra/test/db/pgtap.db.test.ts` (база
  `postgres` для базового стану), `packages/simetra/test/support.ts`
  (експорт), `packages/designer/src/__tests__/roles-tool.db.test.ts` і
  `rights-admin-commands.db.test.ts` (`RESET ROLE` → `restoreOwnerRole`)
- Create: `packages/simetra/test/db/role-switch.test.ts`,
  `packages/simetra/test/db/connection-model.postgres.db.test.ts`

**Interfaces:**
- Produces (`connection.ts`, `export`):
  - `async function asStackSuperuser<T>(client: pg.Client, fn: () => Promise<T>): Promise<T>`
    — лише в транзакції (інакше `Error`); `SAVEPOINT stack_superuser`,
    `SET LOCAL ROLE NONE`, `SET LOCAL search_path = pg_catalog, pg_temp`,
    `fn`, `RELEASE`; на збої — `ROLLBACK TO SAVEPOINT stack_superuser` і
    повторний кидок; на `supabase` — та сама форма;
  - `async function restoreOwnerRole(client: pg.Client): Promise<void>` —
    `SET ROLE <PROVIDER_OWNER_ROLES[testProvider()]>`;
  - `async function superuserClient(database?: string): Promise<pg.Client>` —
    `testSuperuserUrl()` з базою `database`, першими операторами
    `SET ROLE NONE`, `SET search_path = pg_catalog, pg_temp`;
  - `function loginUrl(base: string, user: string, password: string): string`
    — DSN ролі входу з адреси тестів без параметра `options`.

- [ ] **Step 1: failing tests:**
  - unit `profile.test.ts`: `TEST_STACKS.postgres.databaseUrl` — база
    `simetra`, `options` з `role=` і `PROVIDER_OWNER_ROLES.postgres`;
    `superuserUrl` без `options`; імпорт `profile.ts` не читає
    `dev-secrets.env`; `loginUrl` прибирає `options`;
  - `role-switch.test.ts` (iii): у `packages/simetra/src` і
    `packages/designer/src` (без коментарів; без unit `*.test.ts`, де SQL —
    дані перевірок компілятора) немає `RESET ROLE`, `SET ROLE NONE`,
    `SET LOCAL ROLE NONE`, `SET SESSION AUTHORIZATION`; винятки за іменем:
    `packages/simetra/src/schema/apply/postgres-cluster.ts` (прелюдія
    `roles`), `packages/designer/src/schema-engine/apply-database.ts`
    (`ApplyDatabase.statement`), `packages/simetra/src/compiler/messages.ts`
    (текст діагностики). Перед написанням — `grep -rniE "reset role|set role none|set local role none|session authorization" packages/simetra/src packages/designer/src`;
    нині збіги поза коментарями й unit-тестами — `messages.ts` і `RESET ROLE`
    у `roles-tool.db.test.ts` та `rights-admin-commands.db.test.ts` (ці два
    переходять на `restoreOwnerRole`);
  - `connection-model.postgres.db.test.ts` (у `db-pg`): (i) два з'єднання
    пулу `pg.Pool` з `testDatabaseUrl()`, утримані одночасно, і з'єднання
    `createApplyDatabase` рушія з тієї самої адреси — `current_user =
    simetra_owner`, `session_user` — суперкористувач; `current_user` без
    `rolsuper`, з `rolbypassrls` і `rolcreatedb`; (ii) `fn` у
    `asStackSuperuser` кидає після `CREATE ROLE <тегована>` — далі
    `current_user = simetra_owner`, ролі немає; (iii) `SET LOCAL ROLE
    simetra_command` і `simetra_user` від власника проходять без
    `GRANT … TO CURRENT_USER`; (iv) адреса через `withDatabaseName` pg-delta
    зберігає `options` — `current_user` тіні від рушія `simetra_owner`.
- [ ] **Step 2:** `pnpm --filter simetra test profile connection role-switch` — FAIL.
- [ ] **Step 3:** реалізація. Якщо pg-delta губить `options` (iv) — до
  архітекторки з фактом, не обхід.
- [ ] **Step 4:** PASS; `pnpm --filter simetra test:db:pg` і
  `pnpm --filter @simetrajs/designer test:db:pg` — зелені (файли 2a);
  `pnpm --filter @simetrajs/designer test:db roles-tool rights-admin-commands` на `supabase` — зелені.
- [ ] **Step 5: Commit** — `test(db): тести стека postgres — суперкористувач із роллю власника на кожному з'єднанні`.

### Task 4: помічники ролей, `signUp`, провайдер фікстур, `support/db.ts`

**Files:**
- Modify: `packages/simetra/test/db/connection.ts` (`ApiRole` → `RolePurpose`,
  `asRole`, `queryAs`, `testRoleFor`, `claimsFor`), `packages/simetra/test/db/auth.ts`
  (`signUp`), `connection.test.ts`
- Modify — кожен викликач `asRole`/`queryAs`/`ApiRole` (звір
  `git grep -lE "\b(queryAs|asRole|ApiRole)\b" -- packages`):
  `packages/simetra/bench/rights.bench.db.ts`,
  `packages/simetra/src/schema/__tests__/reference-domain.db.test.ts`,
  `packages/simetra/test/db/{access,applied-snapshot-hash,catalog-command,membership,platform-users.supabase,rights-analysis,rights-functions,rights-guards,rights-plan-gate,rights-policies,rights-sources}.db.test.ts`,
  `packages/simetra/test/db/{closure-oracle,rights-seed}.ts`
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts`
  (`defaults(provider = "supabase")`, `singleTenantRights(provider = "supabase")`),
  `fixtures/kitchen-sink.ts` (`kitchenSink(provider = "supabase")`)
- Modify: `packages/designer/src/__tests__/support/db.ts` (`withCopy` —
  власник копії `PROVIDER_OWNER_ROLES[testProvider()]`; `withRuntimeLogin` —
  `loginUrl` і `GRANT CONNECT ON DATABASE <база адреси>` тегованій ролі від
  суперкористувача; `poolerPoolOf` — `false` на профілі без пулера;
  суперкористувач — через `superuserClient`)
- Create: `packages/simetra/test/db/skip-boundary.test.ts`,
  `packages/simetra/test/db/auth.postgres.db.test.ts`

**Interfaces:**
- Produces:
  - `type RolePurpose = "user" | "anonymous" | "service"`;
    `asRole(client, purpose, claims)`, `queryAs(client, purpose, claims, sql, params?)`
    — ім'я ролі з `PROVIDER_API_ROLES[testProvider()]`; призначення без ролі —
    `Error` `no <purpose> role in <provider> profile`;
  - `function testRoleFor(purpose: RolePurpose): string | null`;
  - `function claimsFor(purpose: RolePurpose, sub?: string): Record<string, unknown>`
    — `supabase`: з `role` (ім'я ролі); `postgres`: без `role`, з `sub` і
    `is_anonymous` (§4.4);
  - `signUp(client, account)` — `supabase`: `auth.users` як зараз;
    `postgres`: у точці збереження `SET LOCAL ROLE <PROVIDER_LOGIN_ROLES.postgres>`
    і `INSERT INTO better_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "isAnonymous")`
    (таблиця — з `PROVIDER_IDENTITY_SOURCES.postgres`), `name` = email,
    потім повернення до власника; `email: null`, `phone`, `meta` на
    `postgres` — `Error` з іменем поля (`email` у Better Auth `NOT NULL`;
    аналога `phone` і `meta` немає).

- [ ] **Step 1: failing tests:** unit — `testRoleFor` і `claimsFor` для обох
  профілів за `PROVIDER_API_ROLES`; `asRole(…, "service")` на `postgres`
  кидає `no service role`; `signUp` на `postgres` з `email: null`, `phone`,
  `meta` — `Error` з іменем поля; `skip-boundary.test.ts` — у файлах `db`
  (`*.db.test.ts` без `.supabase.` і `.postgres.`) немає `skipIf(`, що
  посилається на `testRoleFor`; `fixtures` — без аргументу провайдер
  `supabase`, з `"postgres"` — `postgres`; DB `auth.postgres.db.test.ts` —
  `signUp` повертає uuid, рядок `better_auth."user"` вставлено від
  `simetra_auth` (тригер провізії бачить `current_user = simetra_auth`), після
  повернення `current_user = simetra_owner`.
- [ ] **Step 2:** `pnpm --filter simetra test connection auth skip-boundary` — FAIL.
- [ ] **Step 3:** реалізація; виклики переходять на призначення
  (`authenticated` → `user`, `anon` → `anonymous`, `service_role` →
  `service`) і `claimsFor` у тій самій зміні, без аліасів; на `supabase` SQL
  тестів не змінюється.
- [ ] **Step 4:** PASS; `pnpm typecheck` (бенчмарк типізується);
  scoped DB на Supabase `pnpm --filter simetra test:db access membership rights-sources`,
  `pnpm --filter simetra test:db:supabase platform-users` і
  `pnpm --filter @simetrajs/designer test:db data-tools roles-tool` — зелені;
  `pnpm --filter simetra test:db:pg auth` — зелений.
- [ ] **Step 5: Commit** — `test(db): ролі запиту, ідентичність і провайдер фікстур — з даних профілю`.

### Task 5: guard, прибиральник і DB-проєкти

**Files:**
- Modify: `packages/simetra/test/db/stack-guard.ts` (Р3; рядок старту після
  `assertStack`; `assertStack`, `snapshot`, `leakMessage` за Р2),
  `packages/simetra/test/db/sweep.ts` (Р2), `stack-guard.test.ts`,
  `packages/simetra/test/db/external.test.ts`,
  обидва `vitest.config.ts` (`ON_POSTGRES` — порожній перелік, Р6;
  `db-supabase` simetra включає `test/db/interrupt.db.test.ts`, Р9),
  `packages/*/package.json` (`--passWithNoTests` прибрати)
- Create: `packages/simetra/test/db/identity-state.postgres.db.test.ts`

- [ ] **Step 1: failing tests:** `stack-guard.test.ts` (підставні клієнти):
  звірка `better_auth."user"` стоїть після `assertStack` і до `snapshot`;
  бракує колонки — відмова з `pnpm db:pg:start`; зайва колонка — відмова з
  `owner's call`; замок свого pid — відмова «one DB project per vitest
  process»; рядок старту — після `assertStack`; прибиральник робить
  `DROP OWNED BY` у `postgres` і в базі `testDatabaseUrl()`; `manualSweepSql`
  і `leakMessage` називають обидві; кожен DB-проєкт кожного пакета має хоча б
  один файл (Review Focus 5); `db` виключає кожен файл `ON_POSTGRES`, `db-pg`
  його включає; `external.test.ts` — завислий `docker exec` у
  `runContainers` дає помилку до дедлайну; `identity-state.postgres.db.test.ts`
  — звірка Р3 на справжній `simetra` проходить.
- [ ] **Step 2:** `pnpm --filter simetra test stack-guard external` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; `pnpm --filter simetra test:db:pg`,
  `pnpm --filter simetra test:db:supabase interrupt` — зелені.
- [ ] **Step 5: Commit** — `test(db): guard звіряє better_auth, прибирає в обох базах; DB-проєкти без порожніх`.

### Task 6: раннер pgTAP — тегована база, роль, claims

**Files:**
- Modify: `packages/simetra/test/db/pgtap.ts`, `pgtap.test.ts`, `pgtap.db.test.ts`
- Create: `packages/simetra/test/db/pgtap/postgres/roles.pgtap.sql`

**Interfaces:**
- Produces: `runPgTap(url: string, sql: string, opts?: { role?: string; claims?: Record<string, unknown> }): Promise<TapResult>`
  — `url` — суперкористувач стека. З `role` чи `claims`: раннер від
  суперкористувача створює теговану базу
  (`testDatabaseName`, `CREATE DATABASE … TEMPLATE simetra_template`), у ній
  `BEGIN`, `CREATE EXTENSION IF NOT EXISTS pgtap`,
  `set_config(SESSION_CLAIMS_SETTING, …, true)`, `SET LOCAL ROLE <роль>`,
  набір, звірка `current_user = <роль>`, `ROLLBACK`; база видаляється у
  `finally`. Без опцій — як зараз (базовий стан, база `postgres`). Заголовок
  набору `-- pgtap: role=<призначення> claims=<json>` читає
  `pgtap.db.test.ts`; призначення → роль — `testRoleFor`.

- [ ] **Step 1: failing tests:** unit — заголовок розбирається; невідоме
  призначення — помилка; з `role=` набір з `reset role`, `set role`,
  `set session authorization` відхилено; порядок операторів: `pgtap`, claims,
  `SET LOCAL ROLE`, набір, звірка `current_user`; `roles.pgtap.sql`
  (`role=user`) — лише видиме в копії шаблону: `plpgsql_check` є,
  `better_auth` немає, `current_user = simetra_user`. Кластерні факти
  лишаються в наборі базового стану 2a.
- [ ] **Step 2:** `pnpm --filter simetra test pgtap` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; `pnpm --filter simetra test:db:pg pgtap` — зелений;
  тегованих баз після прогону немає.
- [ ] **Step 5: Commit** — `test(db): раннер pgTAP з тегованою базою, роллю й claims; набір ролі запиту`.

### Tasks 7–13: перенос DB-файлів на стек `postgres` за підсистемами

Одна задача — один коміт. Файли — з таблиці задачі 2. Кроки кожної:

- [ ] **Step 1:** переліки «до» за Global Constraints (`db` і `db-supabase`
  з `SIMETRA_TEST_PROVIDER=supabase`, `db-pg` з `postgres`) і
  `git grep -c` суперкористувача → scratchpad.
- [ ] **Step 2:** кожен файл задачі за інвентарем:
  - `profile-neutral` — у `ON_POSTGRES` свого пакета; літерали Supabase — на
    дані профілю (`testRoleFor`, `claimsFor`, `PROVIDER_*[testProvider()]`,
    `signUp`, фікстури з `testProvider()`); `GRANT simetra_command TO CURRENT_USER`
    прибрати; `CREATE ROLE`, `CREATE EXTENSION` від власника — через
    `asStackSuperuser`; суперкористувач `supabase_admin` → `superuserClient`;
  - `supabase-bound` — `git mv` у `*.supabase.db.test.ts`, спільний setup — у
    наявний `support/` чи `*.support.ts` модуль;
  - `split` — сервісні й інші прив'язані кейси в `*.supabase.db.test.ts`
    (Р5), решта в `ON_POSTGRES`; на `postgres` — кейс відсутності сервісних
    грантів;
  - тегована роль входу до `simetra` — лише через `withRuntimeLogin`
    (`GRANT CONNECT` від суперкористувача); `CONNECT` для `PUBLIC` не
    повертати.
- [ ] **Step 3:** переліки «після»; об'єднання повних назв = «до»; число
  пропущених кейсів на кожному стеку; `git grep -c` після з причиною
  кожного приросту — у звіт.
- [ ] **Step 4:** `pnpm --filter <пакет> test:db:pg <файли задачі>` — зелені;
  `pnpm --filter <пакет> test:db:supabase <перейменовані>` — зелені;
  `pnpm --filter <пакет> test:db` — зелений (решта на `supabase`).
- [ ] **Step 5: Commit** — `test(db): <підсистема> на стеку postgres`.

Підсистеми (кожен файл — з таблиці задачі 2; нові файли `main` — до
архітекторки):

- **Task 7 — simetra, права:** `test/db/` `access`, `membership`,
  `rights-analysis`, `rights-functions`, `rights-guards`, `rights-plan-gate`,
  `rights-policies`, `rights-sources`, `rights-write`, `row-rule`,
  `command-grants`; помічники `rights-seed.ts`, `closure-oracle.ts`
  (`GRANT EXECUTE … TO <testRoleFor("user")>`).
- **Task 8 — simetra, каталог і команди:** `test/db/` `catalog-command`,
  `catalog-command-admin`, `catalog-command-rights`, `catalog-functions`,
  `command-port`, `applied-snapshot-hash`, `tenant-creation`, `snake-case`,
  `unique-within`, `value-checks`, `builtin-functions`, `mechanics`,
  `carrier-backfill`, `promote-rewrite`; помічник `catalog.ts`.
- **Task 9 — simetra, схема й стек:** `src/schema/__tests__/` `deploy`,
  `paper-test`, `reference-domain`; `test/db/stack.db.test.ts`. `interrupt` і
  `pgtap` уже в `db-pg` з 2a.
- **Task 10 — designer, корпус рушія:** `src/schema-engine/__tests__/`
  `engine-census`, `engine-extract`, `round-trip`, `fingerprint-coverage`,
  `promotion-equivalence` (Р8 — `*.supabase.db.test.ts`), `engine-desired`,
  `engine-desired-corpus`, `engine-scope`, `engine-apply-port`,
  `savepoint-extract`, `read-only`, `function-checks`, `fingerprint`,
  `apply-database`, `apply-state`; помічники `fingerprint.support.ts`,
  `read-only.support.ts`.
- **Task 11 — designer, план і застосування:** `src/schema-engine/__tests__/`
  `build-plan`, `build-plan-provider`, `build-plan-promotion`,
  `build-plan-promotion-data`, `execute-plan`, `carrier-backfill`,
  `promotion-access`; помічники `build-plan.support.ts`,
  `execute-plan.support.ts`.
- **Task 12 — designer, інструменти й життєвий цикл:** `src/__tests__/`
  `apply-lifecycle`, `apply-tools`, `database-tools`, `data-tools`,
  `data-handler`, `read-query`, `roles-tool`, `promotion-commit`,
  `promotion-lifecycle`, `wide-text-columns`, `support/shadows.db.test.ts`.
- **Task 13 — designer, рантайм і адміністрування прав:** `src/__tests__/`
  `command-runtime`, `command-time`, `catalog-command-concurrency`,
  `tenant-creation`, `rights-admin-commands`, `rights-last-full-access`,
  `rights-maintenance`; помічники `command-runtime.support.ts`,
  `tenant-creation.support.ts`, `rights-admin-commands.support.ts`
  (`REQUEST_ROLE` — `readRoleOf(testProvider())`; `heldEnv`, `heldLogin`,
  `poolerPoolOf` — `viaPooler` `false` на `postgres`),
  `rights-maintenance.support.ts`; `heldTargets` закриває A, B, C через
  `Promise.allSettled`; прямий пул закривається, коли `poolerPoolOf` кидає.

### Task 14: перемикання — `db` на `postgres`

**Files:**
- Modify: обидва `vitest.config.ts` (`db-pg` → `db` з `globalSetup`
  `stack-guard.postgres.ts`, `include` `**/*.db.test.ts`, `exclude`
  `**/*.supabase.db.test.ts`; `db` на `supabase` і `ON_POSTGRES` прибрати),
  `packages/simetra/test/db/profile.ts` (`testProvider()` без змінної —
  `"postgres"`), `profile.test.ts`, `stack-guard.test.ts` («globalSetup paths
  exist», «guards every DB project» — без `db-pg` і `designer/db-pg` з 2a),
  `packages/simetra/package.json`, `packages/designer/package.json` (`test:db`
  = `vitest run --project db`, `test:db:supabase`; `test:db:pg` прибрати),
  `package.json` (корінь: `test:db:pg` = `test:db` обох пакетів;
  `test:db` = `supabase test db && pnpm --filter simetra test:db:supabase && pnpm --filter @simetrajs/designer test:db:supabase`)

- [ ] **Step 1:** переліки «до» трьох проєктів за Global Constraints.
- [ ] **Step 2: failing tests:** `testProvider()` без змінної — `postgres`;
  перелік DB-проєктів — `db`, `db-supabase`, `bench`; `db` — guard `postgres`.
- [ ] **Step 3:** `pnpm --filter simetra test profile stack-guard` — FAIL; реалізація; PASS.
- [ ] **Step 4:** переліки «після»: назви `db` = об'єднання «до» `db-pg` і
  `db`; `db-supabase` — без змін.
- [ ] **Step 5:** `pnpm test:db:pg` (повний, `postgres`) — зелений, рядок
  старту `on postgres stack`; `pnpm --filter simetra test:db:supabase` і
  `pnpm --filter @simetrajs/designer test:db:supabase` — зелені.
- [ ] **Step 6: Commit** — `test(db): проєкт db — на стеку postgres`.

### Task 15: CI

**Files:** Modify `.github/workflows/ci.yml`

- [ ] **Step 1:** job `db` — стек `postgres`: старт
  `pnpm db:pg:start` з трьома спробами й
  `node scripts/db-stack.mjs stop postgres --volumes || true` між ними
  (коментар повторів — з наявного job-а); `timeout-minutes` — як у
  наявного `db`; образ Postgres — `docker/build-push-action` з
  `cache-from: type=gha`, `cache-to: type=gha,mode=max` до старту (або образ
  за digest); матриця: `postgres base state + simetra`
  (`pnpm db:pg:start` другий раз — код 0, потім `pnpm --filter simetra test:db`),
  `designer 1/4`…`4/4` (`pnpm --filter @simetrajs/designer test:db --shard=N/4`).
- [ ] **Step 2:** job `db-supabase` — стек Supabase (наявний старт із трьома
  спробами й коментарем), власний `timeout-minutes`; матриця за Р12:
  `provider + simetra` (`pnpm exec supabase test db && pnpm --filter simetra test:db:supabase`),
  `designer 1/2`, `2/2` (`pnpm --filter @simetrajs/designer test:db:supabase --shard=N/2`).
- [ ] **Step 3:** job `db-postgres` і коментар про нього в job-і `db` прибрати.
- [ ] **Step 4:** `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` — без помилки.
- [ ] **Step 5: Commit** — `ci: DB-тести на стеку postgres, окремий job db-supabase`.
- [ ] **Step 6:** після push архітекторкою — усі jobs зелені; тривалість
  кожного рядка — у звіт.

### Task 16: текст `AGENTS.md` — не виконується виконавцем (Р14)

**Files:** — (`AGENTS.md` не змінюється в цьому плані)

- [ ] **Step 1:** передати архітекторці текст §10.7 спеки (з поправками
  задачі 0): `test:db:pg` — типовий набір; `test:db` — регресія `supabase`;
  CI — job `db` на `postgres` і job `db-supabase`. Далі — задача 17.

Правку `AGENTS.md` дослівно за затвердженим текстом,
`python3 scripts/check-doc-anchors.py`, `pnpm format:check` і коміт
`docs(agents): DB-тести типово на стеку postgres` робить архітекторка під
час приймання, після затвердження власником.

### Task 17: документація

**Files:** Modify `README.md`, `docs/architecture/repository.md`,
`docs/architecture/release.md`, `.agents/skills/writing-tests/SKILL.md`,
`docs/ROADMAP.md`

- [ ] **Step 1:** `README.md`, блок «Database tests»: перший рядок — стек
  `postgres` (`pnpm db:pg:start && pnpm test:db:pg && pnpm db:pg:stop`,
  коментар `# DB tests (default)`), другий — Supabase з коментарем
  `# supabase-profile regression`; речення над блоком — «Database tests run on
  the postgres-profile stack; the Supabase stack keeps the supabase-profile
  regression suites.»
- [ ] **Step 2:** `docs/architecture/repository.md`: рядки `pnpm test:db` і
  `pnpm test:db:pg` — одним реченням кожен за §10.2 з посиланням на
  §10.2 спеки; рядок таблиці `docker/` — «для DB-тестів (`pnpm test:db:pg`)».
- [ ] **Step 3:** `docs/architecture/release.md`: «`pnpm test:db`» →
  «`pnpm test:db:pg` і `pnpm test:db`».
- [ ] **Step 4:** `writing-tests`: правило `*.postgres.db.test.ts` і
  `*.supabase.db.test.ts` (посилання на §10.5), модель з'єднання (посилання
  на §10.3: `asStackSuperuser`, без `GRANT … TO CURRENT_USER`, сервісні кейси
  — у `db-supabase`); «The full `pnpm test:db` run» → «A full DB run».
- [ ] **Step 5:** `docs/ROADMAP.md` — статус ПГ-2 (2b).
- [ ] **Step 6:** `python3 scripts/check-doc-anchors.py`, `pnpm format:check` — зелені.
- [ ] **Step 7: Commit** — `docs: DB-тести типово на стеку postgres`.

### Task 18: гейти

- [ ] **Step 1:** `git merge origin/main`.
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — зелені.
- [ ] **Step 3:** `pnpm test:db:pg` (повний, `postgres`) і `pnpm test:db`
  (повний, `supabase`) — по одному разу; зелені;
  `docker ps -a --filter label=simetra-run` — порожньо.
- [ ] **Step 4:** `pnpm build:packages && pnpm test:packaging`; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 5:** текст PR (для архітекторки): рядки `AGENTS.md` про
  `test:db` і `test:db:pg` застарілі до затвердження тексту задачі 16.

## Готово (§12, рядок ПГ-2, частина 2b)

- Проєкт `db` зелений на `postgres` з `current_user = simetra_owner` на
  кожному з'єднанні, `db-supabase` — на `supabase`; назви кейсів збережено;
  сервісні кейси — у `db-supabase`, без пропусків у `db`.
- Набір ролі запиту `roles.pgtap.sql` у тегованій копії шаблону зелений.
- CI: job `db` на `postgres`, job `db-supabase`; зелені.
- Текст `AGENTS.md` передано архітекторці; правка — після затвердження
  власником.
