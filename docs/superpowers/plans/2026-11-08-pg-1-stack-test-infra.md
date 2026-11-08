# ПГ-1 — стек `postgres` і тест-інфра: план реалізації

> **Статус:** проєкт плану, 2026-11-08; приймає архітекторка
> `runtime-client-data`. Підсумок аудиту — наприкінці файла.
> **Якорі «після спеки профілю».** Спека профілю `postgres` і її розділи
> (§10, §12) ще в PR #61, не в `main`. Виконавець перед стартом зливає `main`
> у гілку (`git merge origin/main`, без rebase) і звіряє якорі плану з
> кодом (`.agents/skills/codebase-research/scripts/orient --plan <цей файл>`).
> Розбіжність імені — перейменувати в плані за кодом; розбіжність поведінки —
> до архітекторки.
> **Спільний стек.** Локальний стек Supabase на машині — спільний для всіх
> сесій. Виконавець **ніколи** не виконує `pnpm db:stop`, `supabase stop` чи
> `pnpm db:start` на ньому; новий стек `postgres` — окремий compose-проєкт
> поруч.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** поряд із наявним стеком Supabase з'являється локальний і CI-стек
профілю `postgres` (Postgres 17 з pgTAP і `plpgsql_check`, Centrifugo,
Garage), тест-інфра DB знає профіль стека, pgTAP іде через Vitest-раннер, а
тести, прив'язані до Supabase, живуть в окремому проєкті `db-supabase`.

**Architecture:** стек — compose-проєкт `simetra-pg` у `docker/postgres-stack/`,
його старт і стоп — один Node-скрипт `scripts/db-stack.mjs`. Профіль тестового
стека — дані в новому `packages/simetra/test/db/profile.ts`; `connection.ts`,
`stack-guard.ts`, `sweep.ts` і `interrupt.ts` беруть адреси, замок і поради
звідти. Профіль прогону задає `globalSetup` проєкту Vitest. Наявний проєкт
`db` у ПГ-1 лишається на стеку Supabase; на стек `postgres` його переводить
ПГ-2.

**Tech Stack:** Docker Compose v2, `postgres:17.11-trixie` з
`postgresql-17-pgtap` і `postgresql-17-plpgsql-check` (PGDG), Centrifugo
`v6.10.2`, Garage `v2.5.0`, Node (`.node-version`), Vitest, `pg`.

**Spec:** [спека профілю `postgres`](../specs/2026-11-08-postgres-profile-design.md)
— ПГ13, §10 (весь), §12 (рядок ПГ-1); ПП6 [спеки профілів](../specs/2026-10-23-provider-profiles-design.md).
Правила тестів — скіл `writing-tests`.

## Global Constraints

- Мова: коментарі — українською, «чому»; повідомлення тест-інфри й CLI —
  англійською, як наявні в `stack-guard.ts`.
- Коміти: Conventional Commits, український опис, без трейлерів; push і PR
  — архітекторка.
- Порти стека `postgres` — лише на `127.0.0.1`: Postgres `54422`,
  Centrifugo `8100`, Garage S3 `3900`, Garage admin `3903`; Centrifugo стека
  Supabase — `8101`.
- Образи — точний тег: `postgres:17.11-trixie`,
  `centrifugo/centrifugo:v6.10.2`, `dxflrs/garage:v2.5.0`. Версії живуть у
  файлах стека, не в `AGENTS.md`.
- Імена compose-проєктів: `simetra-pg` (стек `postgres`), `simetra-sb`
  (Centrifugo стека Supabase). `docker compose` без `-p`/`name:` —
  заборонено.
- Замок стека Supabase зберігає **наявне ім'я** `simetra-db-stack.lock`:
  сесії на старому коді мусять і далі взаємно виключатися з новими. Стек
  `postgres` — `simetra-db-stack-postgres.lock`.
- Мітка контейнера тест-прогону — `simetra-run=<тег>`; бакет Garage
  тест-прогону — `run-<тег>`.
- Об'єкти стека в тестах — лише через хелпери тегу
  (`packages/simetra/test/db/connection.ts`).
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`).
- Наявні DB-тести на стеку Supabase лишаються зеленими після кожної задачі.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Типовий профіль тестового стека в ПГ-1 — `supabase`; на `postgres` у ПГ-1 іде лише проєкт `db-pg` (pgTAP базового стану й тест переривання) | немає: §12 ПГ-1 так і каже («наявний `db` … зелені на `supabase`») |
| Р2 | Профіль прогону задає `globalSetup` проєкту (окремий файл на профіль), а не змінна в скрипті: так `vitest run --project <p>` не можна запустити з чужим профілем | немає |
| Р3 | Базовий стан `postgres` у ПГ-1 — без ролей Simetra і без `simetra_template`: їх створює `simetra roles` у ПГ-2 | §12 рядок ПГ-1: «шаблон `simetra_template`» прибрати з базового стану ПГ-1 (задача 0) |
| Р4 | Бакети тегу в ПГ-1: guard їх бачить, прибиральник видаляє **порожні** через admin API. Спорожнення бакета з об'єктами — у ПГ-5 разом із першим, хто пише байти | §10.3 «спершу спорожнюється» — уточнити «з ПГ-5» (задача 0) |
| Р5 | Тести `db-supabase` у CI — окремі рядки наявної матриці `db` (simetra і designer, designer — на 2 шарди), а не один job | §10.6 таблицю уточнити (задача 0) |
| Р6 | Centrifugo стека `postgres` у ПГ-1 стартує без споживача outbox (таблиці ще немає): конфіг стека лише з `health` і просторами; споживача й генератор конфігу дає ПГ-4 | немає: §10.1 називає «конфіг Centrifugo стека», генератор — ПГ-4 |

## Review Focus

1. **Два стеки на одній машині одночасно.** Прогін `db-pg` не чекає замка
   Supabase і навпаки; порти не перетинаються. Тест — задача 2, «lock path
   per provider».
2. **Сесія на старому коді й сесія на новому — на одному стеку Supabase.**
   Ім'я замка Supabase не змінилось. Тест — задача 2, той самий тест.
3. **Прогін на стеку `postgres`, перерваний SIGINT,** не лишає баз, ролей,
   контейнерів і бакетів тегу. Тест — задача 4, `interrupt.db.test.ts` у
   проєкті `db-pg`.
4. **Повторний `pnpm db:pg:start`** на вже запущеному стеку завершується
   кодом 0 і нічого не ламає (layout Garage, бакет і ключ уже є). Перевірка —
   задача 3, крок 6.
5. **Docker чи admin API Garage недоступні під час прогону** — guard падає
   гучно, а не приймає порожній перелік як «нічого не витекло». Тест —
   задача 4, «lister failure fails the run».

---

### Task 0: уточнення спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-postgres-profile-design.md`
  (§10.3, §10.6, §12 рядок ПГ-1)

- [ ] **Step 1:** §12, рядок ПГ-1: «набір базового стану `postgres` (без
  пресету: версія, розширення, шаблон `simetra_template`)» → «набір
  базового стану `postgres` (без пресету: версія, доступні розширення,
  налаштування стека розробки)».
- [ ] **Step 2:** §10.3, пункт «прибирання на сигналах»: після «бакет свого
  тегу спершу спорожнюється» додати «(з ПГ-5, де з'являється перший
  записувач байтів; до того прибиральник видаляє лише порожні бакети тегу)».
- [ ] **Step 3:** §10.6, рядок `db-supabase`: «1» шард → «рядки матриці
  `db`: `simetra` і designer на 2 шарди».
- [ ] **Step 4:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check`
  — зелені.
- [ ] **Step 5: Commit** — `docs(spec): профіль postgres — уточнення меж блоку ПГ-1`.

### Task 1: профіль тестового стека

**Files:**
- Create: `packages/simetra/test/db/profile.ts`
- Create: `packages/simetra/test/db/profile.test.ts`
- Modify: `packages/simetra/test/db/connection.ts` (`testDatabaseUrl`,
  `testPoolerUrl`, `testSuperuserUrl`)
- Modify: `packages/simetra/test/db/connection.test.ts`

**Interfaces:**
- Produces:
  - `type TestProvider = "postgres" | "supabase"`
  - `const PROVIDER_ENV = "SIMETRA_TEST_PROVIDER"`
  - `interface TestStack { databaseUrl: string; superuserUrl: string; poolerUrl: string | null; superuserName: string; lockFile: string }`
  - `const TEST_STACKS: Record<TestProvider, TestStack>`
  - `function testProvider(): TestProvider` — читає `PROVIDER_ENV`; немає —
    `"supabase"` (Р1); інше значення — `Error`.
  - `function enterProvider(p: TestProvider): void` — ставить `PROVIDER_ENV`
    (успадковують воркери, як `PGAPPNAME` у `enterRun`).
  - `function testStack(): TestStack` = `TEST_STACKS[testProvider()]`.

Значення `TEST_STACKS`:

| Поле | `supabase` | `postgres` |
| --- | --- | --- |
| `databaseUrl` | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | `postgresql://postgres:postgres@127.0.0.1:54422/postgres` |
| `superuserUrl` | `postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres` | `postgresql://postgres:postgres@127.0.0.1:54422/postgres` |
| `poolerUrl` | `postgresql://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres` | `null` |
| `superuserName` | `supabase_admin` | `postgres` |
| `lockFile` | `simetra-db-stack.lock` | `simetra-db-stack-postgres.lock` |

- [ ] **Step 1: failing unit tests** у `profile.test.ts`:
  - `testProvider()` без змінної → `"supabase"`; з `"postgres"` →
    `"postgres"`; з `"pg"` → кидає з текстом, що містить `SIMETRA_TEST_PROVIDER`;
  - `it.each` по `TEST_STACKS`: `databaseUrl` і `superuserUrl` на
    `127.0.0.1`; `lockFile` профілів різні; `supabase.lockFile ===
    "simetra-db-stack.lock"` (Review Focus 2).
  У `connection.test.ts`: з `PROVIDER_ENV=postgres` `testPoolerUrl()` кидає
  `Error` з текстом `no pooler`; `testDatabaseUrl()` і `testSuperuserUrl()`
  повертають значення профілю; змінні `SIMETRA_TEST_*` і далі перевизначають.
- [ ] **Step 2:** `pnpm --filter simetra test profile connection` — FAIL
  (модуля немає).
- [ ] **Step 3:** `profile.ts` за інтерфейсом; у `connection.ts` три функції
  адрес беруть типові значення з `testStack()`, порядок «змінна середовища →
  профіль» зберігається.
- [ ] **Step 4:** `pnpm --filter simetra test profile connection` — PASS;
  `pnpm --filter simetra typecheck` — зелений.
- [ ] **Step 5: Commit** — `test(db): профіль тестового стека`.

### Task 2: stack-guard, прибиральник і переривання за профілем

**Files:**
- Modify: `packages/simetra/test/db/stack-guard.ts` (`LOCK_PATH`,
  `leakMessage`, default export)
- Create: `packages/simetra/test/db/stack-guard.supabase.ts`,
  `packages/simetra/test/db/stack-guard.postgres.ts`
- Modify: `packages/simetra/test/db/sweep.ts`, `packages/simetra/test/db/interrupt.ts`
  (лише якщо вони не беруть суперкористувача через `testSuperuserUrl()`)
- Modify: `packages/simetra/test/db/stack-guard.test.ts`
- Modify: `packages/simetra/vitest.config.ts`, `packages/designer/vitest.config.ts`
  (шлях `globalSetup` проєкту `db` → `stack-guard.supabase.ts`)

**Interfaces:**
- Consumes: `testProvider`, `testStack`, `enterProvider` (задача 1).
- Produces:
  - `function lockPath(p: TestProvider): string` = `join(tmpdir(), TEST_STACKS[p].lockFile)`;
  - `function setupFor(p: TestProvider): () => Promise<() => Promise<void>>`
    — наявна послідовність `setup()`, перед нею `enterProvider(p)`; замок —
    `lockPath(p)`; рядок старту друкує профіль
    (`DB run <tag> on <provider> stack at …`);
  - `leakMessage(changes, p: TestProvider)` — порада `DROP ROLE` каже
    `-- as <TEST_STACKS[p].superuserName>`;
  - `stack-guard.supabase.ts`: `export default setupFor("supabase")`;
    `stack-guard.postgres.ts`: `export default setupFor("postgres")`.
  - Default export `stack-guard.ts` прибирається: імпортери переходять на
    файли профілю (без аліасів, `AGENTS.md` принцип 5).

- [ ] **Step 1: failing unit tests** у `stack-guard.test.ts`:
  - «lock path per provider»: `lockPath("supabase")` закінчується на
    `simetra-db-stack.lock`, `lockPath("postgres")` — на
    `simetra-db-stack-postgres.lock`, шляхи різні;
  - `leakMessage` з доданою роллю: для `"postgres"` містить `-- as postgres`,
    для `"supabase"` — `-- as supabase_admin`.
- [ ] **Step 2:** `pnpm --filter simetra test stack-guard` — FAIL.
- [ ] **Step 3:** реалізація за інтерфейсом; `sweep.ts` і `interrupt.ts`
  беруть суперкористувача лише через `testSuperuserUrl()` (вже профільний) —
  перевірити читанням, правити лише відхилення.
- [ ] **Step 4:** `pnpm --filter simetra test stack-guard` — PASS.
- [ ] **Step 5:** scoped DB-прогін на стеку Supabase не змінив поведінки:
  `pnpm --filter simetra test:db stack` і
  `pnpm --filter @simetrajs/designer test:db roles-tool` — зелені, рядок
  старту каже `on supabase stack`.
- [ ] **Step 6: Commit** — `test(db): stack-guard за профілем стека`.

### Task 3: compose-стек `postgres` і команди

**Files:**
- Create: `docker/postgres-stack/Dockerfile` (`FROM postgres:17.11-trixie`;
  `apt-get install -y --no-install-recommends postgresql-17-pgtap
  postgresql-17-plpgsql-check`)
- Create: `docker/postgres-stack/compose.yaml` (`name: simetra-pg`;
  сервіси `postgres`, `centrifugo`, `garage`; healthcheck кожного; томи
  `pg-data`, `garage-meta`, `garage-data`)
- Create: `docker/postgres-stack/centrifugo.json` (Р6: `health.enabled`,
  простори `simetra`, `simetra-rights`, `simetra-user` з полями §6.1 спеки
  без `consumers` і без `client.token`; `http_api.disabled: true`)
- Create: `docker/postgres-stack/garage.toml` (один вузол,
  `replication_factor = 1`, `db_engine = "sqlite"`, S3 `0.0.0.0:3900`,
  region `garage`, admin `0.0.0.0:3903`, сталі dev-секрети `rpc_secret` і
  `admin_token` — лише для `127.0.0.1`)
- Create: `docker/postgres-stack/dev-environment.sql` —
  `ALTER DATABASE postgres SET simetra.environment = 'development';`
- Create: `scripts/db-stack.mjs`
- Create: `packages/simetra/test/db/stack-files.test.ts` (unit над текстом
  файлів стека; читає їх відносно кореня репо)
- Modify: `package.json` (корінь) — скрипти `db:pg:start`, `db:pg:stop`

**Interfaces:**
- Produces:
  - `node scripts/db-stack.mjs start postgres` — `docker compose -f
    docker/postgres-stack/compose.yaml up -d --build --wait`; потім
    ініціалізація Garage; потім `dev-environment.sql` через
    `docker compose … exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres
    -d postgres -f -`;
  - `node scripts/db-stack.mjs stop postgres` — `docker compose -f … down`
    (без `--volumes`);
  - dev-ключ Garage: імпортований зі сталими `GK…` id і секретом
    (`garage key import --yes`), ім'я `simetra-dev`, бакет `simetra-dev`
    з `--read --write --owner`; сталі — у `scripts/db-stack.mjs` поруч із
    коментарем «лише локальний стек на 127.0.0.1»;
  - `pnpm db:pg:start` / `pnpm db:pg:stop` = виклики вище.

- [ ] **Step 1: failing unit test** «stack files»: кожен рядок секцій
  `ports:` у `compose.yaml` починається з `"127.0.0.1:`; кожен `image:` /
  `FROM` має точний тег (регулярний вираз `:v?\d+\.\d+\.\d+` чи
  `:17\.\d+-trixie`), без `latest`; `name: simetra-pg` присутній;
  `centrifugo.json` не має ключів `insecure`, `admin`,
  `allow_*_for_*`, а `http_api.disabled === true` (§6.1 спеки).
- [ ] **Step 2:** запустити тест — FAIL (файлів немає).
- [ ] **Step 3:** файли стека й `scripts/db-stack.mjs`. Ініціалізація Garage
  ідемпотентна: `garage status` дає id вузла; `layout assign -z dc1 -c 1G`
  і `layout apply --version <поточна+1>` — лише коли вузол без ролі;
  `bucket create`, `key import`, `bucket allow` — лише коли їх немає
  (`bucket info`, `key info`). Точні прапорці CLI звірити з `garage --help`
  у контейнері `v2.5.0`.
- [ ] **Step 4:** тест — PASS.
- [ ] **Step 5:** `pnpm db:pg:start` — код 0; `docker compose -p simetra-pg
  ps` — три сервіси `healthy`; `psql postgresql://postgres:postgres@127.0.0.1:54422/postgres
  -c "select current_setting('simetra.environment')"` → `development`;
  `curl -s http://127.0.0.1:8100/health` → 200.
- [ ] **Step 6:** повторний `pnpm db:pg:start` — код 0 без помилок Garage
  (Review Focus 4); `docker ps --filter name=supabase_` — контейнери
  Supabase з тим самим `Status` (uptime не скинуто).
- [ ] **Step 7: Commit** — `build(db): локальний стек профілю postgres`.

### Task 4: зовнішні ресурси прогону — контейнери й бакети

**Files:**
- Create: `packages/simetra/test/db/external.ts`
- Create: `packages/simetra/test/db/external.test.ts`
- Modify: `packages/simetra/test/db/stack-guard.ts` (знімок і `diff`),
  `packages/simetra/test/db/sweep.ts` (прибирання тегу)
- Modify: `packages/simetra/test/db/profile.ts` (`garageAdminUrl`,
  `garageAdminToken` у `TestStack`, `null` для `supabase`)

**Interfaces:**
- Consumes: `TEST_STACKS`, `testStack` (задача 1).
- Produces:
  - `type Exec = (cmd: string, args: string[]) => Promise<string>`;
    `type Fetch = typeof fetch`;
  - `async function runContainers(exec: Exec): Promise<{ name: string; tag: string }[]>`
    — `docker ps -a --filter label=simetra-run --format
    '{{.Names}}\t{{.Label "simetra-run"}}'`;
  - `async function runBuckets(stack: TestStack, fetch: Fetch): Promise<{ name: string; tag: string }[]>`
    — admin API Garage `GET /v2/ListBuckets` з `Authorization: Bearer
    <token>`, лише імена `run-<тег>`; для стека без Garage — `[]`;
  - `async function removeRunResources(tag, exec, fetch, stack): Promise<{ removed: string[]; left: string[] }>`
    — `docker rm -f -v` контейнерів тегу; `DELETE` порожніх бакетів тегу
    (`/v2/DeleteBucket`); непорожній бакет — у `left` з поясненням (Р4);
  - `Snapshot` дістає поля `containers` і `buckets`; `diff` і `leakMessage`
    їх враховують; `leftoverReport` називає контейнери й бакети тегу.

- [ ] **Step 1: failing unit tests** (`external.test.ts`, підставні `exec` і
  `fetch`):
  - розбір виводу `docker ps` у пари ім'я — тег; рядок без тегу
    пропускається;
  - `runBuckets` відбирає лише `run-<тег>` і шле токен;
  - «lister failure fails the run»: `exec` кидає чи `fetch` дає 500 →
    функція кидає, а не повертає `[]` (Review Focus 5);
  - `diff` зі знімком, де з'явився контейнер тегу, дає зміну виду
    `containers`.
- [ ] **Step 2:** `pnpm --filter simetra test external stack-guard` — FAIL.
- [ ] **Step 3:** реалізація; справжні `exec` (`execFile`) і `fetch`
  підставляє `stack-guard.ts` і `sweep.ts`. Імена API звірити з документацією
  admin API Garage `v2.5.0` (context7 чи `garage` у контейнері).
- [ ] **Step 4:** `pnpm --filter simetra test external stack-guard` — PASS.
- [ ] **Step 5: Commit** — `test(db): контейнери й бакети тегу в stack-guard`.

### Task 5: Vitest-раннер pgTAP і базовий стан `postgres`

**Files:**
- Create: `packages/simetra/test/db/pgtap.ts`
- Create: `packages/simetra/test/db/pgtap.test.ts` (unit, розбір TAP)
- Create: `packages/simetra/test/db/pgtap.db.test.ts`
- Create: `packages/simetra/test/db/pgtap/postgres/stack-base-state.pgtap.sql`
- Modify: `packages/simetra/vitest.config.ts` — проєкт `db-pg`
- Modify: `packages/simetra/package.json` — скрипт `test:db:pg`
- Modify: `package.json` (корінь) — скрипт `test:db:pg`

**Interfaces:**
- Consumes: `testProvider`, `testDatabaseUrl` (задача 1); `stack-guard.postgres.ts` (задача 2).
- Produces:
  - `interface TapResult { planned: number | null; passed: number[]; failed: { n: number; line: string; diag: string[] }[]; bailOut: string | null }`
  - `function parseTap(lines: readonly string[]): TapResult`
  - `async function runPgTap(client: pg.Client, sql: string): Promise<TapResult>`
    — виконує текст набору одним простим запитом (багато операторів), збирає
    текстові значення рядків усіх результатів, ділить за `\n`, розбирає;
    після виконання завжди `ROLLBACK` (набір сам відкриває `begin`, раннер
    страхує);
  - `pgtap.db.test.ts`: для кожного `*.pgtap.sql` у
    `test/db/pgtap/<testProvider()>/` — один `it(<ім'я файла>)`:
    `failed` порожній, `bailOut === null`, `planned === passed.length`;
    теки профілю немає чи вона порожня — `it.skip` з причиною;
  - проєкт `db-pg`: `include: ["test/db/pgtap.db.test.ts", "test/db/interrupt.db.test.ts"]`,
    `fileParallelism: false`, `globalSetup: ["./test/db/stack-guard.postgres.ts"]`;
  - `test:db:pg` (simetra) = `vitest run --project db-pg`; корінь —
    `pnpm --filter simetra test:db:pg`.

Набір `stack-base-state.pgtap.sql` (у транзакції з `rollback`, `create
extension if not exists pgtap` усередині):

1. `current_setting('server_version_num')::int / 10000 = 17`;
2. `pg_available_extensions` містить `pgtap` і `plpgsql_check`;
3. `current_setting('simetra.environment', true) = 'development'`;
4. схем `auth`, `storage`, `realtime` немає (`hasnt_schema`);
5. роль `postgres` — суперкористувач.

- [ ] **Step 1: failing unit tests** (`pgtap.test.ts`, таблиця `it.each`):
  усі `ok` з планом `1..3` → `failed` порожній; рядок `not ok 2 - x` з
  наступними `# ` → `failed[0]` з `n: 2` і `diag`; план `1..3` при двох
  `ok` → `planned` 3, `passed.length` 2; `Bail out! …` → `bailOut`.
- [ ] **Step 2:** `pnpm --filter simetra test pgtap` — FAIL.
- [ ] **Step 3:** `pgtap.ts`, `pgtap.db.test.ts`, набір і проєкт `db-pg`.
  SQL-помилка набору (синтаксис) — тест падає з повідомленням Postgres,
  а не з «0 passed».
- [ ] **Step 4:** `pnpm --filter simetra test pgtap` — PASS; на піднятому
  стеку `pnpm test:db:pg` — `pgtap.db.test.ts` зелений, рядок старту —
  `on postgres stack`.
- [ ] **Step 5: мутація.** Тимчасово змінити крок 1 набору на `= 16` —
  `pnpm test:db:pg` червоний з `not ok 1`; повернути.
- [ ] **Step 6:** `interrupt.db.test.ts` у `db-pg` зелений (Review Focus 3).
  Якщо він вимагає чогось із Supabase — виправити лише залежність від
  стека (адреси, суперкористувач) через профіль; інша залежність — до
  архітекторки.
- [ ] **Step 7: Commit** — `test(db): Vitest-раннер pgTAP і базовий стан стека postgres`.

### Task 6: проєкт `db-supabase`

**Files:**
- Modify: `packages/simetra/vitest.config.ts`, `packages/designer/vitest.config.ts`
  — проєкт `db` виключає `**/*.supabase.db.test.ts`; новий проєкт
  `db-supabase` (`include: ["**/*.supabase.db.test.ts"]`, ті самі
  `fileParallelism`, `maxConcurrency`, `setupFiles`, `testTimeout`, що й
  `db` пакета; `globalSetup` — `stack-guard.supabase.ts`)
- Modify: `packages/simetra/package.json`, `packages/designer/package.json`
  — `test:db:supabase` = `vitest run --project db-supabase`
- Modify: `package.json` (корінь) — `test:db` додає
  `pnpm --filter simetra test:db:supabase && pnpm --filter @simetrajs/designer test:db:supabase`
- Rename / split: тести, прив'язані до Supabase (нижче)

**Правило відбору.** Кейс прив'язаний до Supabase, коли вимагає хоча б
одного: схем `auth`, `storage`, `realtime` чи таблиці `auth.users`; ролей,
яких профіль `postgres` не має (`service_role`, `authenticator`,
`supabase_*`); пулера Supavisor (`testPoolerUrl`, `throughPoolerAs`);
поведінки пресету `supabase` (поверхні, замки supautils, базові розширення).
Використання лише `authenticated`/`anon` через `asRole` чи `queryAs` кейс
**не** прив'язує: ці файли лишаються в `db` і отримують ролі профілю в ПГ-2.

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

Файл, де прив'язані всі кейси, перейменовується в
`<ім'я>.supabase.db.test.ts` (`git mv`). Файл зі змішаними кейсами
ділиться: прив'язані кейси — у новий сусідній `<ім'я>.supabase.db.test.ts`,
спільний setup — у наявний модуль `support/` чи `test/db/`, не копією
(`writing-tests` §3). Перелік фактичних переносів виконавець вносить у звіт
задачі.

- [ ] **Step 1:** до переносу — зафіксувати число кейсів:
  `pnpm --filter simetra exec vitest list --project db` і те саме для
  designer → у звіт (`<N_simetra>`, `<N_designer>`).
- [ ] **Step 2:** конфіги проєктів і скрипти; `vitest list --project
  db-supabase` порожній (перенесень ще немає) — конфіг працює.
- [ ] **Step 3:** переноси за правилом.
- [ ] **Step 4:** `vitest list` проєктів `db` + `db-supabase` кожного
  пакета дає рівно `N` кейсів з кроку 1 — жоден не загубився й не
  задвоївся.
- [ ] **Step 5:** `pnpm --filter simetra test:db:supabase` і
  `pnpm --filter @simetrajs/designer test:db:supabase` — зелені на стеку
  Supabase.
- [ ] **Step 6: Commit** — `test(db): проєкт db-supabase для тестів, прив'язаних до Supabase`.

### Task 7: Centrifugo стека Supabase

**Files:**
- Create: `docker/supabase-signals/compose.yaml` (`name: simetra-sb`; один
  сервіс `centrifugo`, `127.0.0.1:8101:8000`, той самий образ)
- Create: `docker/supabase-signals/centrifugo.json` (як у задачі 3, без
  споживача — Р6)
- Modify: `scripts/db-stack.mjs` — профіль `supabase-signals` для
  `start`/`stop`
- Modify: `package.json` (корінь) — `db:signals:start`, `db:signals:stop`;
  `db:start` = `supabase start && pnpm db:dev-env && pnpm db:signals:start`;
  `db:stop` = `pnpm db:signals:stop && supabase stop`
- Modify: тест «stack files» задачі 3 — і на цей compose

- [ ] **Step 1:** розширити тест «stack files» на `docker/supabase-signals/`
  — FAIL.
- [ ] **Step 2:** файли й скрипти.
- [ ] **Step 3:** тест — PASS.
- [ ] **Step 4:** `pnpm db:signals:start` (лише він — **не** `db:start`) —
  `curl -s http://127.0.0.1:8101/health` → 200; стек Supabase не
  перезапустився (як у задачі 3, крок 6); `pnpm db:signals:stop`.
- [ ] **Step 5: Commit** — `build(db): Centrifugo поруч зі стеком Supabase`.

### Task 8: CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1:** новий job `db-postgres` (`name: Database (postgres stack)`,
  `runs-on: ubuntu-latest`, `timeout-minutes: 20`): ті самі кроки
  встановлення, що й `db`; крок «Start postgres stack» — той самий цикл
  трьох спроб, що й старт Supabase, з `pnpm db:pg:start` і прибиранням
  `pnpm db:pg:stop || true` між спробами; крок тестів — `pnpm test:db:pg`.
- [ ] **Step 2:** матриця `db` дістає рядки `supabase-bound simetra`
  (`pnpm --filter simetra test:db:supabase`) і `supabase-bound designer
  1/2`, `2/2` (`pnpm --filter @simetrajs/designer test:db:supabase
  --shard=N/2`) (Р5).
- [ ] **Step 3:** `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"`
  — без помилки.
- [ ] **Step 4: Commit** — `ci: стек postgres і тести db-supabase`.
- [ ] **Step 5:** після push архітекторкою — усі jobs CI зелені; час
  рядків `supabase-bound` у звіт (поріг 30 хв job-а).

### Task 9: текст `AGENTS.md` (виконання — лише після затвердження власником)

**Files:**
- Modify: `AGENTS.md` (розділ «Commands and gates»)

Текст — стан після ПГ-1 (кінцевий текст §10.7 спеки ляже з ПГ-2):

- [ ] **Step 1:** архітекторка передає власнику на затвердження такий текст;
  до затвердження задача не виконується:
  - у блок команд після `pnpm db:stop` додати:
    ```bash
    pnpm db:pg:start                          # local postgres-profile stack: Postgres 17, Centrifugo, Garage (needs Docker)
    pnpm test:db:pg                           # postgres-stack base state (pgTAP through the Vitest runner) and interrupt cleanup
    pnpm db:pg:stop
    ```
  - пункт «The local stack is started only through `pnpm db:*` (pinned CLI
    version), never through a global `supabase`» → «Each local stack is
    started only through its `pnpm db:*` commands (pinned images and CLI),
    never through a global `supabase` or `docker compose` without the
    project name.»
  - після речення про `globalSetup` у пункті про спільний стек: «The guard is
    per stack: runs on the Supabase and the postgres stacks do not wait for
    each other; tests bound to Supabase live in `*.supabase.db.test.ts`
    (project `db-supabase`).»
  - у пункт про run tag: «A Centrifugo container of a run carries the
    `simetra-run=<tag>` label and a Garage bucket of a run is named
    `run-<tag>`; the guard reports and removes its own.»
  - у пункт про CI: після опису матриці `db` додати «, a `db-postgres` job
    (the postgres stack and `pnpm test:db:pg`)».
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
- Наявний `db` і новий `db-supabase` зелені на `supabase`; сума кейсів
  `db` + `db-supabase` дорівнює числу до переносу.
- Базовий стан `postgres` зелений через Vitest-раннер; мутація набору
  червона.
- Прогін на стеку `postgres`, перерваний SIGINT, не лишає баз, ролей,
  контейнерів і бакетів тегу.
- CI зелений: `db` з рядками `supabase-bound`, `db-postgres`.
- Текст `AGENTS.md` передано власнику; правка — після затвердження.

## Підсумок аудиту плану

_Заповнюється після аудиту._
