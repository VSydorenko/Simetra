# ПГ-1 — стек `postgres` і тест-інфра: план реалізації

> **Статус:** проєкт плану, 2026-11-08; приймає архітекторка
> `runtime-client-data`. Підсумок аудиту — наприкінці файла.
> **Якорі «після спеки профілю».** Спека профілю `postgres` і її розділи
> (§6.1, §10, §12) ще в PR #61, не в `main`. Виконавець перед стартом зливає
> `main` у гілку (`git merge origin/main`, без rebase) і звіряє якорі плану з
> кодом (`.agents/skills/codebase-research/scripts/orient --plan <цей файл>`).
> Розбіжність імені — перейменувати в плані за кодом; розбіжність поведінки —
> до архітекторки.
> **Спільний стек.** Локальний стек Supabase на машині — спільний для всіх
> сесій. Виконавець **ніколи** не виконує `pnpm db:stop`, `supabase stop` чи
> `pnpm db:start`; новий стек `postgres` — окремий compose-проєкт поруч.
> Стек `postgres` теж спільний для worktree машини: `pnpm db:pg:start` і
> `pnpm db:pg:stop` відмовляють, поки його замок тримає живий DB-прогін
> (задача 3), а `--volumes` локально не вживається.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** поряд із наявним стеком Supabase з'являється локальний і CI-стек
профілю `postgres` (Postgres 17 з pgTAP і `plpgsql_check`, Centrifugo,
Garage), тест-інфра DB знає профіль стека, pgTAP іде через Vitest-раннер, а
тести, прив'язані до Supabase, живуть в окремому проєкті `db-supabase`.

**Architecture:** стек — compose-проєкт `simetra-pg` у `docker/postgres-stack/`;
старт і стоп — один Node-скрипт `scripts/db-stack.mjs`. Профіль тестового
стека — дані в новому `packages/simetra/test/db/profile.ts`; `connection.ts`,
`stack-guard.ts`, `sweep.ts` і `interrupt.ts` беруть адреси, замок і поради
звідти. Профіль прогону задає `globalSetup` проєкту Vitest (файл на профіль).
Наявний проєкт `db` у ПГ-1 лишається на стеку Supabase; на стек `postgres`
його переводить ПГ-2.

**Tech Stack:** Docker Compose v2, `postgres:17.11-trixie` (з digest) з
`postgresql-17-pgtap` і `postgresql-17-plpgsql-check` (PGDG), Centrifugo `v6.10.2`, Garage `v2.5.0`, Node (`.node-version`),
Vitest, `pg`.

**Spec:** [спека профілю `postgres`](../specs/2026-11-08-postgres-profile-design.md)
— ПГ13, §6.1, §10, §12 (рядок ПГ-1); ПП6
[спеки профілів](../specs/2026-10-23-provider-profiles-design.md). Правила
тестів — скіл `writing-tests`.

## Global Constraints

- Мова: коментарі — українською, «чому»; повідомлення тест-інфри й CLI —
  англійською, як наявні в `stack-guard.ts`.
- Коміти: Conventional Commits, український опис, без трейлерів; push і PR —
  архітекторка.
- Порти стека `postgres` — лише на `127.0.0.1`: Postgres `54422`, Centrifugo
  `8100`, Garage S3 `3900`, Garage admin `3903`; RPC Garage (`3901`) не
  публікується. Centrifugo поруч зі стеком Supabase — `127.0.0.1:8101`.
- Образи — точний тег і digest: `postgres:17.11-trixie@sha256:…`,
  `centrifugo/centrifugo:v6.10.2@sha256:…`, `dxflrs/garage:v2.5.0@sha256:…`
  (digest бере виконавець `docker buildx imagetools inspect`). Пакети PGDG —
  без точного піну: основний репозиторій PGDG тримає лише останню версію, і
  пін зламав би збірку з першим оновленням; доступність розширень доводить
  набір базового стану (задача 5). Версії образів живуть у файлах стека, не
  в `AGENTS.md`.
- Імена compose-проєктів: `simetra-pg`, `simetra-sb`. Виклик `docker
  compose` без `-p` чи `name:` — заборонено.
- Замок стека Supabase зберігає **наявне ім'я** `simetra-db-stack.lock`:
  сесії на старому коді мусять і далі взаємно виключатися з новими. Стек
  `postgres` — `simetra-db-stack-postgres.lock`.
- Контейнер тест-прогону має дві мітки: `simetra-run=<тег>` і
  `simetra-stack=<профіль>`; бакет Garage тест-прогону — `run-<тег>`.
- Dev-секрети стека (`rpc_secret`, `admin_token`, S3-ключ) — в одному файлі
  `docker/postgres-stack/dev-secrets.env`; його читають compose, скрипт старту
  й `profile.ts`. Значення годяться лише для `127.0.0.1`.
- Об'єкти стека в тестах — лише через хелпери тегу
  (`packages/simetra/test/db/connection.ts`).
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`).
- Один процес vitest — один DB-проєкт: DB-скрипти запускають рівно один
  `--project`.
- Наявні DB-тести на стеку Supabase лишаються зеленими після кожної задачі.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Типовий профіль тестового стека в ПГ-1 — `supabase`; на `postgres` у ПГ-1 іде лише проєкт `db-pg` (pgTAP базового стану й тест переривання). ПГ-2 перемикає типовий профіль на `postgres` | §10.3: «типово `postgres`» — «з ПГ-2» (задача 0) |
| Р2 | Профіль прогону задає `globalSetup` проєкту (файл на профіль); guard відмовляє, коли в процесі вже стоїть інший профіль чи замок тримає свій же pid | немає |
| Р3 | Ролі Simetra й `simetra_template` на стеку `postgres` створює `simetra roles` у ПГ-2; базовий стан ПГ-1 — версія, доступні розширення, налаштування стека, відсутність схем Supabase; ролі §3.1 і `better_auth` додають до набору ПГ-2 і ПГ-3 | §10.2 (крок ролей у `db:pg:start`), §10.5 (склад набору), §12 рядок ПГ-1 (задача 0) |
| Р4 | Набір базового стану ПГ-1 іде в базі `postgres` від суперкористувача стека, у транзакції з `ROLLBACK`; теговані бази, `SET ROLE` і claims раннера потрібні наборам з ПГ-2 | §10.5, опис раннера (задача 0) |
| Р5 | Бакети тегу в ПГ-1: guard їх бачить, прибиральник видаляє **порожні**. Спорожнення бакета з об'єктами — у ПГ-5 разом із першим записувачем байтів | §10.3 (задача 0) |
| Р6 | Тести `db-supabase` у CI — рядки наявної матриці `db` (simetra; designer — 2 шарди); стек `postgres` — новий job `db-postgres` | §10.6 і §12 (задача 0) |
| Р7 | Centrifugo обох стеків у ПГ-1 — зі статичним конфігом без споживача outbox і без токенів (таблиці outbox ще немає); вивід генератора конфігу з `audience` і `issuer` замінює його в ПГ-4 | §6.1 «конфіг стека розробки будується тим самим генератором» — «з ПГ-4» (задача 0) |
| Р9 | Транзакцію набору pgTAP відкриває й відкочує раннер; файл набору не має операторів керування транзакцією (`begin`, `commit`, `rollback`, `savepoint` тощо) — раннер їх відхиляє | §10.5, опис раннера (задача 0) |
| Р8 | Centrifugo поруч зі стеком Supabase стартує окремою командою `pnpm db:signals:start`; `db:start` і `db:stop` не змінюються: тести ПГ-1 його не вживають, а зайве завантаження образу в кожному рядку CI — нова причина збою старту | §10.1 «`pnpm db:start` піднімає його» — «окрема команда» (задача 0) |
| Р10 | Кейси з жорстко прописаними ролями чи схемами Supabase, де роль — лише один член загальної перевірки, лишаються в `db`; так само файли на `signUp`, корпус engine-census/engine-extract, вставка в `auth.users` референсного домену, вхід під час виконання в command-grants і рядок build-plan-promotion. ПГ-2 і ПГ-3 переводять їх на дані профілю (§10.5, останній пункт). Перелік перераховує `grep -nE 'auth\.users\|service_role\|supabase_\|authenticator' $(git ls-files '*.db.test.ts' \| grep -v supabase.db)` | немає |

## Review Focus

1. **Два стеки на одній машині одночасно.** Прогін `db-pg` не чекає замка
   Supabase і навпаки, а контейнер прогону одного стека не є «витоком» для
   прогону іншого. Тести — задача 2 «lock path per provider», задача 4
   «container of another stack is not a leak».
2. **Сесія на старому коді й сесія на новому — на одному стеку Supabase.**
   Ім'я замка Supabase не змінилось. Тест — задача 2 «lock path per provider».
3. **Прогін на стеку `postgres`, перерваний SIGINT,** не лишає баз, ролей,
   контейнерів і бакетів тегу. Тест — задача 5, розширений
   `interrupt.db.test.ts` у `db-pg`, з мутацією.
4. **Повторний `pnpm db:pg:start`** на запущеному стеку — код 0, стан той
   самий. Перевірка — задача 3, крок 6.
5. **Docker чи admin API Garage недоступні під час прогону** — guard падає
   гучно, а не приймає порожній перелік; прибиральник не висить довше за
   свій дедлайн. Тести — задача 4 «lister failure fails the run»,
   «sweep keeps its deadline».

---

### Task 0: поправки спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-postgres-profile-design.md`

- [ ] **Step 1:** внести поправки за стовпцем «Вплив на спеку» таблиці
  «Рішення» (Р1, Р3–Р8), кожну — у названому розділі спеки, формулюванням
  стану після ПГ-1 і посиланням на блок, який завершує механізм:
  - §6.1 — Р7; §10.1 — Р8; §10.2 — Р1 (склад `test:db:pg` і `test:db` у
    ПГ-1), Р3; §10.3 — Р1, Р5;
  - §10.5 — Р1 (проєкт `db` на `postgres` — з ПГ-2), Р3, Р4, Р9; §10.6 — Р6
    (рядки `supabase-bound` матриці `db`, job `db-postgres`); §12 рядок
    ПГ-1 — Р3, Р6.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): профіль postgres — межі блоку ПГ-1`.

### Task 1: профіль тестового стека

**Files:**
- Create: `packages/simetra/test/db/profile.ts`, `packages/simetra/test/db/profile.test.ts`
- Create: `docker/postgres-stack/dev-secrets.env` — `GARAGE_RPC_SECRET`
  (64 hex), `GARAGE_ADMIN_TOKEN`, `GARAGE_DEV_KEY_ID` (`GK…`),
  `GARAGE_DEV_KEY_SECRET`; коментар «local stack on 127.0.0.1 only» (його
  ж читають compose і скрипт задачі 3)
- Modify: `packages/simetra/test/db/connection.ts` (`testDatabaseUrl`,
  `testPoolerUrl`, `testSuperuserUrl`), `packages/simetra/test/db/connection.test.ts`

**Interfaces:**
- Produces (усі `export`):
  - `type TestProvider = "postgres" | "supabase"`
  - `const PROVIDER_ENV = "SIMETRA_TEST_PROVIDER"`
  - `interface TestStack { databaseUrl: string; superuserUrl: string; poolerUrl: string | null; superuserName: string; lockFile: string; garageAdminUrl: string | null }`
  - `function garageAdminToken(): string` — читає рядок `GARAGE_ADMIN_TOKEN=`
    з `docker/postgres-stack/dev-secrets.env` (шлях — від `import.meta.url`
    до кореня репо); немає файла чи рядка — `Error` з повним шляхом файла.
    Окрема функція, а не поле: прогін на Supabase не читає файла стека.
  - `const TEST_STACKS: Record<TestProvider, TestStack>`
  - `function testProvider(): TestProvider` — читає `PROVIDER_ENV`; немає —
    `"supabase"` (Р1); інше значення — `Error` з іменем змінної.
  - `function enterProvider(p: TestProvider): void` — ставить `PROVIDER_ENV`;
    якщо там уже інший профіль — `Error` (Р2).
  - `function testStack(): TestStack` = `TEST_STACKS[testProvider()]`.

| Поле | `supabase` | `postgres` |
| --- | --- | --- |
| `databaseUrl` | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | `postgresql://postgres:postgres@127.0.0.1:54422/postgres` |
| `superuserUrl` | `postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres` | `postgresql://postgres:postgres@127.0.0.1:54422/postgres` |
| `poolerUrl` | `postgresql://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres` | `null` |
| `superuserName` | `supabase_admin` | `postgres` |
| `lockFile` | `simetra-db-stack.lock` | `simetra-db-stack-postgres.lock` |
| `garageAdminUrl` | `null` | `http://127.0.0.1:3903` |

- [ ] **Step 1: failing unit tests.** `profile.test.ts`:
  - `testProvider()` без змінної → `"supabase"`; `"postgres"` → `"postgres"`;
    `"pg"` → кидає, текст містить `SIMETRA_TEST_PROVIDER`;
  - `enterProvider("postgres")` після `enterProvider("supabase")` кидає;
  - `it.each` по `TEST_STACKS`: адреси на `127.0.0.1`; `lockFile` різні;
    `TEST_STACKS.supabase.lockFile === "simetra-db-stack.lock"`;
  - `garageAdminToken()` повертає непорожній рядок; з підставним шляхом
    до відсутнього файла кидає з цим шляхом у тексті.

  `connection.test.ts`: з `PROVIDER_ENV=postgres` `testPoolerUrl()` кидає з
  текстом `no pooler`; `testDatabaseUrl()` і `testSuperuserUrl()` дають
  значення профілю; змінні `SIMETRA_TEST_*` і далі перевизначають.
- [ ] **Step 2:** `pnpm --filter simetra test profile connection` — FAIL.
- [ ] **Step 3:** `profile.ts` за інтерфейсом; у `connection.ts` типові
  значення трьох функцій — з `testStack()`, порядок «змінна середовища →
  профіль» той самий.
- [ ] **Step 4:** `pnpm --filter simetra test profile connection` — PASS;
  `pnpm --filter simetra typecheck` — зелений.
- [ ] **Step 5: Commit** — `test(db): профіль тестового стека`.

### Task 2: stack-guard, прибиральник і переривання за профілем

**Files:**
- Modify: `packages/simetra/test/db/stack-guard.ts`, `packages/simetra/test/db/sweep.ts`
  (`manualSweepSql`, CLI), `packages/simetra/test/db/stack-guard.test.ts`
- Create: `packages/simetra/test/db/stack-guard.supabase.ts`,
  `packages/simetra/test/db/stack-guard.postgres.ts`
- Modify: `packages/simetra/vitest.config.ts` (проєкти `db` і `bench`),
  `packages/designer/vitest.config.ts` (проєкт `db`) — `globalSetup` →
  `stack-guard.supabase.ts`

**Interfaces:**
- Consumes: `TestProvider`, `TEST_STACKS`, `testProvider`, `enterProvider` (задача 1).
- Produces (усі `export`):
  - `function lockPath(p: TestProvider): string` = `join(tmpdir(), TEST_STACKS[p].lockFile)`;
  - `function setupFor(p: TestProvider): () => Promise<() => Promise<void>>`
    — `enterProvider(p)`, далі наявна послідовність `setup()` із замком
    `lockPath(p)`; замок, який тримає `process.pid`, — `Error` «one DB
    project per vitest process» (Р2); рядок старту — `DB run <tag> on
    <provider> stack at …`;
  - типи `Snapshot` і `Change` — `export`;
  - `function stackMismatch(p: TestProvider, facts: { supabaseAdmin: boolean }): string | null`
    — для `postgres` роль `supabase_admin` мусить бути відсутня, для
    `supabase` — присутня; розбіжність — текст відмови про змінні
    `SIMETRA_TEST_*` (перевизначення адреси на чужий стек ламало б взаємне
    виключення);
  - `async function assertStack(p: TestProvider): Promise<void>` — читає
    факт через **кожну** ефективну адресу (`testDatabaseUrl()` і
    `testSuperuserUrl()`) і кидає на першому `stackMismatch`; її кличуть
    guard перед знімком «до» і `sweepRun` перед будь-яким `DROP`;
  - `function diff(before: Snapshot, after: Snapshot): Change[]`;
  - `function leakMessage(changes: Change[], p: TestProvider): string` —
    порада `DROP ROLE` закінчується `-- as <TEST_STACKS[p].superuserName>`;
  - `function leftoverReport(before, p: TestProvider, now?)` — команда
    прибиральника `cd packages/simetra && SIMETRA_TEST_PROVIDER=<p> node
    --import tsx test/db/sweep.ts <tag>`;
  - `manualSweepSql(…, p: TestProvider)` у `sweep.ts` — коментар із
    `superuserName` профілю;
  - `stack-guard.supabase.ts` — `export default setupFor("supabase")`;
    `stack-guard.postgres.ts` — `export default setupFor("postgres")`;
    default export `stack-guard.ts` прибирається (без аліасів, `AGENTS.md`
    принцип 5).

- [ ] **Step 1: failing unit tests** (`stack-guard.test.ts`, `it.each` по профілях):
  - «lock path per provider»: суфікси `simetra-db-stack.lock` і
    `simetra-db-stack-postgres.lock`, шляхи різні (Review Focus 2);
  - `leakMessage` з доданою роллю: `-- as postgres` / `-- as supabase_admin`;
  - `leftoverReport` з тегованою базою: команда містить
    `SIMETRA_TEST_PROVIDER=<p>`;
  - `manualSweepSql` називає суперкористувача профілю;
  - `stackMismatch`: `it.each` чотирьох комбінацій профілю й факту;
  - «globalSetup paths exist»: імпорт обох `vitest.config.ts`, для кожного
    проєкту кожен шлях `globalSetup` і `setupFiles` існує (`existsSync`) —
    ловить і `bench`, і проєкти без файлів.

  Наявні кейси `leftoverReport` у `stack-guard.test.ts` переписати на нову
  сигнатуру (профіль другим параметром, команда з `SIMETRA_TEST_PROVIDER`).
- [ ] **Step 2:** `pnpm --filter simetra test stack-guard sweep` — FAIL.
- [ ] **Step 3:** реалізація за інтерфейсом.
- [ ] **Step 4:** `pnpm --filter simetra test stack-guard sweep` — PASS.
- [ ] **Step 5:** scoped DB-прогони на стеку Supabase:
  `pnpm --filter simetra test:db stack` і
  `pnpm --filter @simetrajs/designer test:db roles-tool` — зелені, рядок
  старту `on supabase stack`.
- [ ] **Step 6: Commit** — `test(db): stack-guard за профілем стека`.

### Task 3: compose-стек `postgres` і команди

**Files:**
- Create: `docker/postgres-stack/Dockerfile` — `FROM postgres:17.11-trixie@sha256:…`;
  `apt-get update` і встановлення `postgresql-17-pgtap`,
  `postgresql-17-plpgsql-check` без точних версій (Global Constraints)
- Create: `docker/postgres-stack/compose.yaml` — `name: simetra-pg`;
  сервіси:
  - `postgres`: `build: .`, `image: simetra-pg/postgres:17.11`,
    `POSTGRES_PASSWORD=postgres`, `127.0.0.1:54422:5432`, том `pg-data`,
    healthcheck `pg_isready -U postgres`;
  - `centrifugo`: образ з digest, `127.0.0.1:8100:8000`, конфіг
    `centrifugo.json`, healthcheck — бінарник образу проти `/health`
    (у образі немає `curl` — звірити, чим він доступний);
  - `garage`: образ з digest, `127.0.0.1:3900:3900`,
    `127.0.0.1:3903:3903`, `env_file: dev-secrets.env` (Garage бере
    `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` із середовища — звірити з
    документацією `v2.5.0`), томи `garage-meta`, `garage-data`;
    healthcheck, що не залежить від layout: `["CMD", "/garage", "status"]`
    (`/health` admin API до застосування layout недоступний);
  - жодного `network_mode`; `3901` не публікується.
- Create: `docker/postgres-stack/centrifugo.json` (Р7): `health.enabled`,
  простори `simetra`, `simetra-rights`, `simetra-user` з історією й
  `force_recovery` (§6.1 спеки); без `consumers`, без `client.token`;
  `http_api.disabled: true`; без анонімного підключення.
- Create: `docker/postgres-stack/garage.toml` — один вузол,
  `replication_factor = 1`, `db_engine = "sqlite"`, S3 на `0.0.0.0:3900`,
  region `garage`, admin на `0.0.0.0:3903`; секрети — лише із середовища.
- Create: `docker/postgres-stack/dev-environment.sql` —
  `ALTER DATABASE postgres SET simetra.environment = 'development';`
- Create: `scripts/db-stack.mjs`
- Create: `packages/simetra/test/db/stack-files.test.ts` (unit над текстом
  файлів стека відносно кореня репо)
- Modify: `package.json` (корінь) — `db:pg:start`, `db:pg:stop`

**Interfaces:**
- Produces:
  - `node scripts/db-stack.mjs start postgres` — `docker compose -f
    docker/postgres-stack/compose.yaml up -d --build --wait`; ініціалізація
    Garage; `dev-environment.sql` через `docker compose … exec -T postgres
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f -`;
  - `node scripts/db-stack.mjs stop postgres [--volumes]` — `docker
    compose … down` (з `--volumes` лише на прапорці);
  - `export async function withStackLock(path: string, fn: () => Promise<void>): Promise<void>`
    у `scripts/db-stack.mjs` — бере той самий замок, що й `stack-guard.ts`
    (`openSync(path, "wx")`, формат `<pid>\n<cwd>\n<since>\n`), тримає його
    весь час `fn` і знімає у `finally`; замок живого чужого pid — відмова
    (код 1, текст `postgres stack is in use by PID <pid>`), замок мертвого
    pid знімається, як у guard. `start` і `stop` профілю `postgres`
    виконують `compose up`/`down` і ініціалізацію лише всередині
    `withStackLock(<tmpdir>/simetra-db-stack-postgres.lock, …)`: між
    перевіркою й дією немає проміжку, у якому DB-прогін узяв би замок;
  - `pnpm db:pg:start`, `pnpm db:pg:stop` — виклики вище без `--volumes`.

- [ ] **Step 1: failing unit test** `stack-files.test.ts`:
  - кожен опублікований порт у `compose.yaml` має префікс `127.0.0.1:`;
    ключа `network_mode` немає; `3901` не опубліковано;
  - кожен `image:` / `FROM` стороннього образу має тег і `@sha256:`; немає
    `latest`;
  - `name: simetra-pg` присутній;
  - у `centrifugo.json` немає ключів `insecure`, `admin`,
    `allow_anonymous_connect_without_token` і жодного `allow_*_for_*`;
    `http_api.disabled === true`;
  - `garage.toml` не містить `rpc_secret` чи `admin_token` (секрети — лише
    з `dev-secrets.env`);
  - `withStackLock`: вільний замок — `fn` виконано, файл після нього
    знято; замок живого чужого pid (підставний файл з pid батьківського
    процесу тесту) — відмова без виклику `fn`; замок неіснуючого pid —
    знято й `fn` виконано; `fn`, що кидає, — замок знято.

  Розбір `compose.yaml` — по рядках регулярними виразами (порти в списках
  `ports:`, ключ `network_mode:`), без нової залежності.
- [ ] **Step 2:** `pnpm --filter simetra test stack-files` — FAIL.
- [ ] **Step 3:** файли стека й скрипт. Ініціалізація Garage ідемпотентна:
  id вузла з `garage status`; призначення ролі в layout (`dc1`, `1G`) і
  застосування наступної версії layout — лише коли вузол без ролі;
  `key import` зі сталими id і секретом, створення бакета `simetra-dev`,
  дозвіл `read`, `write`, `owner` ключу — лише коли їх немає. Прапорці CLI
  звірити з `garage --help` у контейнері `v2.5.0`.
- [ ] **Step 4:** `pnpm --filter simetra test stack-files` — PASS.
- [ ] **Step 5:** `pnpm db:pg:start` — код 0; `docker compose -f
  docker/postgres-stack/compose.yaml ps` — три сервіси `healthy`; `psql
  postgresql://postgres:postgres@127.0.0.1:54422/postgres -c "select
  current_setting('simetra.environment')"` → `development`; `curl -s -o
  /dev/null -w '%{http_code}' http://127.0.0.1:8100/health` → `200`.
- [ ] **Step 6:** повторний `pnpm db:pg:start` — код 0 (Review Focus 4);
  `docker ps --filter name=supabase_ --format '{{.Names}} {{.Status}}'` до
  й після задачі — той самий uptime.
- [ ] **Step 7: Commit** — `build(db): локальний стек профілю postgres`.

### Task 4: зовнішні ресурси прогону — контейнери й бакети

**Files:**
- Create: `packages/simetra/test/db/external.ts`, `packages/simetra/test/db/external.test.ts`
- Modify: `packages/simetra/test/db/stack-guard.ts` (знімок, `diff`,
  `leakMessage`, `leftoverReport`), `packages/simetra/test/db/sweep.ts`
  (`sweepRun`)

**Interfaces:**
- Consumes: `TestProvider`, `TestStack`, `TEST_STACKS` (задача 1); `diff`,
  `leakMessage`, `leftoverReport` (задача 2).
- Produces (усі `export`):
  - `type Exec = (file: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<string>`
    — обгортка `execFile` (аргументи без shell-лапок);
  - `type Fetch = typeof fetch`;
  - `const nodeExec: Exec` — справжня обгортка `execFile`; її вживають
    `stack-guard.ts`, `sweep.ts` і фікстура задачі 5;
  - `async function createRunBucket(tag: string, stack: TestStack, fetch: Fetch): Promise<string>`
    — бакет з глобальним аліасом `run-<тег>` через admin API, повертає id;
  - `async function runContainers(p: TestProvider, exec: Exec): Promise<{ name: string; tag: string }[]>`
    — `docker ps -a --filter label=simetra-run --filter
    label=simetra-stack=<p> --format {{.Names}}\t{{.Label "simetra-run"}}`;
  - `async function runBuckets(stack: TestStack, fetch: Fetch, timeoutMs: number): Promise<{ id: string; name: string; tag: string; objects: number }[]>`
    — admin API Garage v2: перелік бакетів з глобальними аліасами, лише
    `run-<тег>`, число об'єктів — з інформації про бакет; `stack.garageAdminUrl`
    `null` — `[]`; маршрути звірити з документацією admin API `v2.5.0`;
  - `async function removeRunResources(tag: string, p: TestProvider, deps: { exec: Exec; fetch: Fetch; deadlineMs: number }): Promise<{ removed: string[]; left: string[] }>`
    — `docker rm -f -v` контейнерів тегу свого профілю; видалення
    **порожніх** бакетів тегу за id; непорожній бакет — у `left` з
    причиною (Р5); кожен виклик — з `AbortSignal.timeout` чи `timeoutMs` у
    межах `deadlineMs`;
  - `Snapshot` дістає поля `containers: string[]` і `buckets: string[]`
    (імена, лише свого профілю; `diff` лишається порівнянням множин
    рядків); у `leftoverReport` вони необов'язкові в `Pick`; `leakMessage`
    радить `docker rm -f -v <ім'я>` для контейнера і «empty and delete in
    Garage» для бакета;
  - `sweepRun`: DB-фаза отримує дедлайн мінус гарантований бюджет
    зовнішніх ресурсів `EXTERNAL_BUDGET_MS = 5_000`; `removeRunResources`
    виконується в `finally` — і тоді, коли DB-фаза кинула (база
    недосяжна), і після раннього `return` циклу; сумарно — у межах 40 с
    обробника сигналу (`SWEEP_TIMEOUT_MS` в `interrupt.ts`).

- [ ] **Step 1: failing unit tests** (`external.test.ts`, підставні `exec` і `fetch`):
  - розбір виводу `docker ps` у пари ім'я — тег; рядок без тегу
    пропускається; `exec` отримує фільтр `simetra-stack=<p>`;
  - «container of another stack is not a leak»: підставний `exec` тримає
    контейнери обох стеків і фільтрує їх за переданими аргументами
    `--filter`; `runContainers("supabase", exec)` не повертає контейнера з
    `simetra-stack=postgres` (Review Focus 1);
  - `runBuckets` відбирає лише `run-<тег>` і шле токен;
  - «lister failure fails the run»: `exec` кидає чи `fetch` дає 500 →
    функція кидає (Review Focus 5);
  - `removeRunResources`: порожній бакет — у `removed`, непорожній — у
    `left`, контейнер тегу — у `removed`;
  - «sweep keeps its deadline»: `fetch`, що ніколи не відповідає,
    → `removeRunResources` завершується до `deadlineMs` + 1 с з бакетом у
    `left`;
  - «DB unreachable still removes containers»: `sweepRun` з підставною
    базою, що кидає на з'єднанні, кличе `removeRunResources` і повертає
    контейнер тегу в `dropped`.
- [ ] **Step 2:** `pnpm --filter simetra test external stack-guard sweep` — FAIL.
- [ ] **Step 3:** реалізація; справжні `exec` і `fetch` підставляють
  `stack-guard.ts` і `sweep.ts`.
- [ ] **Step 4:** `pnpm --filter simetra test external stack-guard sweep` — PASS.
- [ ] **Step 5: Commit** — `test(db): контейнери й бакети тегу в stack-guard`.

### Task 5: Vitest-раннер pgTAP, базовий стан `postgres` і переривання

**Files:**
- Create: `packages/simetra/test/db/pgtap.ts`, `packages/simetra/test/db/pgtap.test.ts`,
  `packages/simetra/test/db/pgtap.db.test.ts`,
  `packages/simetra/test/db/pgtap/postgres/stack-base-state.pgtap.sql`
- Modify: `packages/simetra/test/db/fixtures/interrupted-run.ts`,
  `packages/simetra/test/db/interrupt.db.test.ts` (контейнер і бакет на
  профілі `postgres`)
- Modify: `packages/simetra/vitest.config.ts` — проєкт `db-pg`
- Modify: `packages/simetra/package.json`, `package.json` (корінь) — `test:db:pg`

**Interfaces:**
- Consumes: `testProvider`, `testDatabaseUrl`, `testStack` (задача 1);
  `stack-guard.postgres.ts` (задача 2); `nodeExec`, `runContainers`,
  `runBuckets`, `createRunBucket`, `removeRunResources` (задача 4).
- Produces (усі `export`):
  - `interface TapResult { planned: number | null; passed: number[]; failed: { n: number; line: string; diag: string[] }[]; bailOut: string | null }`
  - `function parseTap(lines: readonly string[]): TapResult`
  - `function checkSuite(sql: string): void` (Р9) — прибирає коментарі й
    тіла в dollar-quote, ділить на оператори й кидає, коли оператор
    починається з `begin`, `start transaction`, `commit`, `end`,
    `rollback`, `abort`, `savepoint`, `release`, `prepare transaction` чи
    є `alter system`;
  - `async function runPgTap(url: string, sql: string): Promise<TapResult>`
    — новий `pg.Client` на набір; `checkSuite`; `BEGIN`; текст набору одним
    простим запитом; текстові значення рядків усіх результатів, поділені за
    `\n`, — у `parseTap`; у `finally` — `ROLLBACK` і `end()`;
  - `pgtap.db.test.ts`: на кожен `*.pgtap.sql` у
    `test/db/pgtap/<testProvider()>/` — `it(<ім'я файла>)`: `failed`
    порожній, `bailOut === null`, `planned === passed.length`. Для
    `postgres` відсутність `stack-base-state.pgtap.sql` — падіння тесту, а
    не пропуск; для `supabase` порожня тека — `it.skip` з причиною (його
    базовий стан і далі перевіряє `supabase test db`);
  - проєкт `db-pg`: `include: ["test/db/pgtap.db.test.ts",
    "test/db/interrupt.db.test.ts"]`, `fileParallelism: false`,
    `globalSetup: ["./test/db/stack-guard.postgres.ts"]`;
  - `test:db:pg` (simetra) = `vitest run --project db-pg`; у корені —
    `pnpm --filter simetra test:db:pg`.

Набір `stack-base-state.pgtap.sql` (`create extension if not exists pgtap;
select plan(…); …; select * from finish();` — без керування транзакцією,
Р9), Р3, Р4:

1. `current_setting('server_version_num')::int / 10000 = 17`;
2. `pg_available_extensions` містить `pgtap` і `plpgsql_check`;
3. `current_setting('simetra.environment', true) = 'development'`;
4. `hasnt_schema` для `auth`, `storage`, `realtime`;
5. роль `postgres` має `rolsuper`.

- [ ] **Step 1: failing unit tests** (`pgtap.test.ts`, `it.each`): усі `ok`
  з планом `1..3` — `failed` порожній; `not ok 2 - x` з рядками `# …` —
  `failed[0]` з `n: 2` і `diag`; план `1..3` при двох `ok` — `planned` 3,
  `passed.length` 2; `Bail out! …` — `bailOut`; `checkSuite` кидає на
  `commit;`, на `rollback;` посеред набору, на `alter system set …`, на
  `begin;` і пропускає `do $$ begin perform 1; end $$;` та `-- commit` у
  коментарі.
- [ ] **Step 2:** `pnpm --filter simetra test pgtap` — FAIL.
- [ ] **Step 3:** `pgtap.ts`, `pgtap.db.test.ts`, набір і проєкт `db-pg`.
  Помилка SQL у наборі — тест падає з повідомленням Postgres, а не з
  «0 passed».
- [ ] **Step 4:** `pnpm --filter simetra test pgtap` — PASS; на піднятому
  стеку `pnpm test:db:pg` — `pgtap.db.test.ts` зелений, рядок старту
  `on postgres stack`.
- [ ] **Step 5: мутація набору.** Крок 1 набору тимчасово `= 16` —
  `pnpm test:db:pg` червоний з `not ok 1`; повернути.
- [ ] **Step 6: переривання на `postgres`.** У `fixtures/interrupted-run.ts`
  на профілі `postgres` фікстура створює ще контейнер (`nodeExec`; образ
  `simetra-pg/postgres:17.11`, ім'я `simetra-run-<тег>-interrupt`, команда
  `sleep infinity`, мітки `simetra-run=<тег>` і `simetra-stack=postgres`) і
  порожній бакет `run-<тег>` (`createRunBucket`) і друкує `ready` лише
  після обох; `interrupt.db.test.ts` після SIGINT
  перевіряє, що їх немає (`runContainers`, `runBuckets`), — DB-рівень, бо
  доводить справжнє прибирання прибиральником на сигналі. На `supabase`
  кейс без змін.
- [ ] **Step 7:** `pnpm test:db:pg` — зелений (Review Focus 3); мутація:
  виклик `removeRunResources` у `sweepRun` тимчасово прибрано — тест
  червоний; повернути.
- [ ] **Step 8: Commit** — `test(db): Vitest-раннер pgTAP, базовий стан стека postgres, прибирання на перериванні`.

### Task 6: проєкт `db-supabase`

**Files:**
- Modify: `packages/simetra/vitest.config.ts`, `packages/designer/vitest.config.ts`
  — проєкт `db` виключає `**/*.supabase.db.test.ts`; новий проєкт
  `db-supabase` (`include: ["**/*.supabase.db.test.ts"]`, ті самі
  `fileParallelism`, `maxConcurrency`, `setupFiles`, `testTimeout`, що й `db`
  пакета; `globalSetup` — `stack-guard.supabase.ts`)
- Modify: `packages/simetra/package.json`, `packages/designer/package.json` —
  `test:db:supabase` = `vitest run --project db-supabase --passWithNoTests`
- Modify: `package.json` (корінь) — `test:db` після наявних кроків додає
  `pnpm --filter simetra test:db:supabase && pnpm --filter @simetrajs/designer test:db:supabase`
- Rename / split: тести, прив'язані до Supabase (нижче)

**Правило відбору.** Кейс прив'язаний до Supabase, коли вимагає хоча б
одного: схем `auth`, `storage`, `realtime` чи таблиці `auth.users`; ролей,
яких профіль `postgres` не має (`service_role`, `authenticator`,
`supabase_*`); пулера Supavisor (`testPoolerUrl`, `throughPoolerAs`);
поведінки пресету `supabase` (поверхні, замки supautils, базові розширення).
Вживання лише `authenticated`/`anon` через `asRole` чи `queryAs` кейс
**не** прив'язує: такі файли лишаються в `db`, ролі профілю вони отримують у
ПГ-2.

**Кандидати** (розвідка grep; кожен підтвердити читанням):

- designer `src/schema-engine/__tests__/`: `build-plan-promotion`,
  `build-plan-provider`, `build-plan`, `engine-extract`, `engine-scope`,
  `engine-census`, `engine-desired`, `engine-desired-corpus`,
  `engine-apply-port`, `execute-plan`, `fingerprint`,
  `fingerprint-coverage`, `round-trip`, `apply-state`, `read-only`,
  `promotion-equivalence`, `promotion-access`, `function-checks`;
- designer: `runtime-login`, `command-runtime`, `rights-admin-commands`,
  `rights-maintenance`, `tenant-creation` — лише кейси з пулером;
- simetra: `src/schema/__tests__/provider-preset`,
  `test/db/provider-event-sources`, `test/db/provider-roles`,
  `test/db/platform-users`, `test/db/subscriptions`; у `test/db/stack` —
  лише кейс «provider base state is visible».

Файл, де прив'язані всі кейси, — `git mv` у `<ім'я>.supabase.db.test.ts`.
Файл зі змішаними кейсами ділиться: прив'язані кейси — у новий сусідній
`<ім'я>.supabase.db.test.ts`, спільний setup — у наявний модуль `support/`
чи `test/db/`, не копією (`writing-tests` §3). Фактичні переноси виконавець
перелічує у звіті задачі.

- [ ] **Step 1:** до переносу на піднятому стеку Supabase — назви кейсів
  кожного проєкту окремим викликом: `pnpm --filter simetra exec vitest list
  --project db --json` і те саме для designer → `before-<пакет>.json` у
  scratchpad. (Якщо `vitest list` виконує `globalSetup`, він бере замок —
  це нормально, прогін короткий.)
- [ ] **Step 2:** конфіги проєктів і скрипти;
  `pnpm --filter simetra test:db:supabase` — код 0 (`--passWithNoTests`).
- [ ] **Step 3:** переноси за правилом.
- [ ] **Step 4:** `vitest list --json` проєктів `db` і `db-supabase` кожного
  пакета (кожен — окремий виклик): об'єднання назв дорівнює
  `before-<пакет>.json` — жоден кейс не загубився й не задвоївся.
- [ ] **Step 5:** `pnpm --filter simetra test:db:supabase` і
  `pnpm --filter @simetrajs/designer test:db:supabase` — зелені;
  `pnpm --filter simetra test:db stack` — зелений.
- [ ] **Step 6: Commit** — `test(db): проєкт db-supabase для тестів, прив'язаних до Supabase`.

### Task 7: Centrifugo поруч зі стеком Supabase

**Files:**
- Create: `docker/supabase-signals/compose.yaml` (`name: simetra-sb`; сервіс
  `centrifugo`, образ з digest, `127.0.0.1:8101:8000`, healthcheck як у
  задачі 3), `docker/supabase-signals/centrifugo.json` (як у задачі 3, Р7)
- Modify: `scripts/db-stack.mjs` — профіль `supabase-signals`
- Modify: `package.json` (корінь) — `db:signals:start`, `db:signals:stop`;
  `db:start` і `db:stop` **не змінюються** (Р8)
- Modify: `packages/simetra/test/db/stack-files.test.ts` — ті самі
  перевірки для `docker/supabase-signals/`

- [ ] **Step 1:** розширити `stack-files.test.ts` — FAIL.
- [ ] **Step 2:** файли й скрипти.
- [ ] **Step 3:** `pnpm --filter simetra test stack-files` — PASS.
- [ ] **Step 4:** `pnpm db:signals:start` — `curl -s -o /dev/null -w
  '%{http_code}' http://127.0.0.1:8101/health` → `200`; uptime
  контейнерів `supabase_` не змінився; `pnpm db:signals:stop`.
- [ ] **Step 5: Commit** — `build(db): Centrifugo поруч зі стеком Supabase`.

### Task 8: CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1:** job `db-postgres` (`name: Database (postgres stack)`,
  `runs-on: ubuntu-latest`, `timeout-minutes: 20`): кроки встановлення як у
  `db`; «Start postgres stack» — той самий цикл трьох спроб, що й старт
  Supabase, з `pnpm db:pg:start` і `node scripts/db-stack.mjs stop postgres
  --volumes || true` між спробами; тести — `pnpm test:db:pg`.
- [ ] **Step 2:** матриця `db` дістає рядки `supabase-bound simetra`
  (`pnpm --filter simetra test:db:supabase`) і `supabase-bound designer
  1/2`, `2/2` (`pnpm --filter @simetrajs/designer test:db:supabase
  --shard=N/2`) (Р6).
- [ ] **Step 3:** `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` — без помилки.
- [ ] **Step 4: Commit** — `ci: стек postgres і тести db-supabase`.
- [ ] **Step 5:** після push архітекторкою — усі jobs зелені; тривалість
  рядків `supabase-bound` і `db-postgres` — у звіт (поріг job-а — його
  `timeout-minutes`).

### Task 9: текст `AGENTS.md` (виконання — лише після затвердження власником)

**Files:**
- Modify: `AGENTS.md` (розділ «Commands and gates»)

Текст відбиває стан після ПГ-1; кінцевий текст §10.7 спеки ляже з ПГ-2.

- [ ] **Step 1:** архітекторка передає власнику на затвердження; до
  затвердження задача не виконується:
  - у блок команд після `pnpm db:stop`:
    ```bash
    pnpm db:signals:start                     # Centrifugo beside the Supabase stack (needs Docker)
    pnpm db:signals:stop

    pnpm db:pg:start                          # local postgres-profile stack: Postgres 17, Centrifugo, Garage (needs Docker)
    pnpm test:db:pg                           # postgres-stack base state (pgTAP through the Vitest runner) and interrupt cleanup
    pnpm db:pg:stop
    ```
  - «The local stack is started only through `pnpm db:*` (pinned CLI
    version), never through a global `supabase`.» → «Each local stack is
    started only through its `pnpm db:*` commands (pinned images and CLI),
    never through a global `supabase` or `docker compose` without the
    project name.»
  - «The local stack is one per machine and shared by every session and
    agent on it.» → «Each local stack (`postgres`, `supabase`) is one per
    profile per machine and shared by every session and agent on it.»
  - у тому самому пункті «The DB test projects' `globalSetup`
    (`packages/simetra/test/db/stack-guard.ts`) runs one DB run at a time» →
    «The `globalSetup` of each DB project (`stack-guard.<provider>.ts` over
    the guard module `packages/simetra/test/db/stack-guard.ts`) runs one DB
    run at a time per stack».
  - після речення про `globalSetup`: «The guard is per stack: runs on the
    Supabase and the postgres stacks do not wait for each other. One vitest
    process runs one DB project. Tests bound to Supabase live in
    `*.supabase.db.test.ts` (project `db-supabase`).»
  - у пункт про run tag: «A container of a run carries the
    `simetra-run=<tag>` and `simetra-stack=<provider>` labels
    (`runContainerLabels` in `packages/simetra/test/db/external.ts`) and a
    Garage bucket of a run is named `run-<tag>`; the guard reports both,
    removes its own containers and its empty buckets, and reports a
    non-empty bucket instead of emptying it.»
  - «Versions live in `.node-version` and `package.json`, not here.» →
    «Versions live in `.node-version`, `package.json` and the stack files
    (`docker/*/compose.yaml`, `Dockerfile`), not here.»
  - у пункт про CI після опису матриці `db`: «, its `supabase-bound` rows
    (`*.supabase.db.test.ts`), and a `db-postgres` job (the postgres stack
    and `pnpm test:db:pg`)».
- [ ] **Step 2:** після затвердження — правка, `python3 scripts/check-doc-anchors.py`,
  `pnpm format:check`, коміт `docs(agents): команди й стек профілю postgres`.

### Task 10: гейти

- [ ] **Step 1:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — зелені.
- [ ] **Step 2:** `pnpm test:db:pg` — зелений; `docker ps -a --filter
  label=simetra-run` — порожньо; бакетів `run-*` немає.
- [ ] **Step 3:** повний `pnpm test:db` на стеку Supabase — **один раз** за
  блок, перед фінальною перевіркою; зелений.
- [ ] **Step 4:** `python3 scripts/check-doc-anchors.py` — зелений.

## Готово (§12, рядок ПГ-1)

- Обидва стеки стартують своїми командами; повторний старт — код 0.
- Наявний `db` і новий `db-supabase` зелені на `supabase`; кожен кейс із
  переліку до переносу є в `db` ∪ `db-supabase`. Виняток — сценарій
  обслуговування прав, розділений на прямий кейс (`db`) і кейс через пулер
  (`db-supabase`).
- Базовий стан `postgres` зелений через Vitest-раннер; мутація набору
  червона.
- Прогін на стеку `postgres`, перерваний SIGINT, не лишає баз, ролей,
  контейнерів і бакетів тегу; мутація прибиральника червона.
- CI зелений: `db` з рядками `supabase-bound`, `db-postgres`.
- Текст `AGENTS.md` передано власнику; правка — після затвердження.

## Підсумок аудиту плану

Два раунди двох незалежних аудиторів Opus («план проти коду,
виконуваність» і «безпека й операційний ризик»), потім Codex `gpt-6-sol`.
Кожну знахідку автор звірив з кодом; спростовано одну (тег
`postgres:17.11-trixie` існує). Виправлено, зокрема:

- поправки спеки на кожне відхилення (задача 0);
- контейнери в знімку прив'язано до стека міткою;
- доказ прибирання контейнерів і бакетів на перериванні, з мутацією;
- один DB-проєкт на процес vitest;
- healthcheck Garage, що не залежить від layout;
- профільна команда ручного прибирання;
- порядок і бюджети прибиральника;
- старт і стоп стека — під тим самим замком, що й DB-прогін;
- звірка кожної ефективної адреси з профілем;
- раннер pgTAP сам керує транзакцією й відхиляє оператори керування нею;
- без точного піну пакетів PGDG.

Відкритих blocker і безпекових major немає. Окремого раунду після правок
Codex не було.
