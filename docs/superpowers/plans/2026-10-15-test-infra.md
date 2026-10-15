# Тест-інфраструктура DB-наборів — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** перерваний DB-прогін прибирає свої об'єкти стеку, DB-набір designer помітно швидший без втрати ізоляції, unit-набір стабільний і без шуму libpg_query.

**Architecture:** кожен прогін має тег (globalSetup `stack-guard.ts` генерує його й кладе в env воркерів); усе, що DB-тест створює на спільному стеку, називається через `connection.ts` і несе тег. Синхронний обробник сигналу в головному процесі vitest убиває свої воркери й `spawnSync`-ом запускає прибиральника, що видаляє лише тегові об'єкти. Тіні двигуна отримують тег через прохідну обгортку `provisionCoLocatedShadow` у setupFile DB-проєкту designer, яка ж веде облік провізій замість глобального лічильника тіней; на цьому обліку важкі файли designer переходять на конкурентні тести всередині файлу.

**Tech Stack:** vitest 5.0.2 (pool `forks`), `pg` 8.23.1, `@supabase/pg-delta` 1.0.0-alpha.56, `tsx` 4.23.15, Node 24, ESLint 9 flat config, `@libpg-query/parser` 17.8.0.

**Spec:** `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` §3 «Тест-інфраструктура» плюс рішення архітектора нижче (розділ «Рішення»). Платформну спеку план не змінює: вплив на спеку — «немає».

## Рішення (затверджено архітектором до плану)

- **Р1. «Свої» об'єкти — за тегом прогону в імені.** Тег — 6 символів `[0-9a-z]`, генерує globalSetup, передає воркерам через env `SIMETRA_DB_RUN_TAG`. Єдине джерело імен — `packages/simetra/test/db/connection.ts`. Тіні: `pgdelta_shadow_<мс base36>_<тег>_<rand>` (вік і далі читається з першого сегмента). Діф знімка як ознаку «свого» відкинуто: він зніс би тінь ручного спайку іншої сесії.
- **Р1, обгортка pg-delta.** `vi.mock("@supabase/pg-delta")` у setupFile DB-проєкту designer — лише прохідна: додає `uniqueSuffix`, решту аргументів і поведінку не змінює; одне місце в репо; коментар пояснює, чому не опція `ShadowOptions` (тестова турбота не йде в публічний API адаптера). Облік провізій (запис імені) — спостереження, поведінки не змінює.
- **Р1б. Одне правило:** усе, що DB-тест створює на стеку (бази, ролі), несе тег — і фіксовані тестові ролі теж.
- **Р2. Обробник сигналу.** SIGINT, SIGTERM, SIGHUP; синхронний, у головному процесі: SIGKILL своїм воркерам (прямі діти), `spawnSync` прибиральника за тегом (повтор, доки прохід нічого не знайде, ≤30 с), зняти свій замок, вихід з кодом `128 + номер сигналу`. Причина синхронності: репортер vitest 5.0.2 на сигнал робить `process.exit()` через 1 мс і teardown globalSetup не кличе. SIGKILL самого vitest — відоме обмеження: лишається звіт сиріт на старті наступного прогону.
- **Р3. Тест обробника — без вкладеного vitest і без винятків у замку.** Дочірній node-процес (під замком зовнішнього прогону) ставить обробник з власним тегом, створює тегові об'єкти, отримує сигнал; тест перевіряє, що тегових об'єктів нема і процес вийшов. Звірка стеку зовнішнім прогоном — додатковий доказ.
- **Р4. Швидкість — конкурентні тести всередині файлу.** `describe.concurrent`, `maxConcurrency: 4`, опт-ін по файлу лише після аудиту (чекліст у задачі 6); аудит кожного файлу — рядок у звіті. Файли лишаються послідовними (`fileParallelism: false`): ролі кластерні, а витяг каталогу читає ролі, тож паралель файлів дала б тестові бачити стан іншого. Гарантії stack-guard (один прогін, диск, звірка до/після) не змінюються.
- **Р5. ESLint-тести меж:** холодне завантаження конфігу (typescript-eslint → пакет `typescript`) переноситься в `beforeAll` з явним тайм-аутом хука й коментарем-обґрунтуванням.
- **Р6. libpg_query — прод-фікс:** запобіжник у `parseFunction` — тіло стандарту SQL (`BEGIN ATOMIC`) не йде у WASM PL/pgSQL-парсер. Окремий коміт `fix(compiler): …`, не змішаний з тест-інфрою.
- **Р7.** Спільні помічники designer — `packages/designer/src/__tests__/support/`; `fingerprintAfterSteps` виноситься з `connection.ts`.
- **Р8. Триаж прогалин §3:** беруться `promotionLines` (без тригерів, порожнє `data`), «refuses a copy on another server» без припущення про колацію стека, `planPromotion` копіює `data` (асерція в наявному DB-тесті). Відхилено: «unchanged зі статусу» — `ToolResult` статусу не має, додати = змінити публічну форму; статус `unchanged` уже перевірено на рівні рушія (`build-plan.db.test.ts`, `apply-state.db.test.ts`).

## Global Constraints

- Стек — лише `pnpm db:*`; ручний `psql` — `docker exec supabase_db_simetra psql …`. Стек не зупиняти й не перезапускати.
- `pnpm test:db` і DB-прогони пакетів — без зовнішнього таймауту коротшого за 45 хв; довгі — у фоні. Один DB-прогін за раз (тримає globalSetup).
- Не видаляти об'єкти стеку, створені не тобою: `metahub_copy*` (проба), `p3_3_spike_*` (сесія П3-3). Сторож завалив прогін через `p3_3_spike_*` — не дефект, повторити прогін, не виключати ці бази зі звірки.
- Гейти не ганяти, поки дерево редагується. Committing agents — послідовно.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter`.
- Коміти: Conventional Commits, опис українською, без жодних трейлерів.
- Гарантії `stack-guard.ts` (замок «один прогін», перевірка диска, звірка стеку до/після) не послаблюються.
- Коментарі в коді — українською й про «чому»; повідомлення помилок і JSDoc експортованого — англійською.
- Нова залежність лише одна: `tsx` 4.23.15 у devDependencies `simetra` (уже є в `@simetra/designer` тієї ж версії).

## Review Focus

1. **Чужий об'єкт зі схожим іменем не прибирається ніколи:** тінь іншої сесії `pgdelta_shadow_<ts>_<rand>` (два сегменти), `metahub_copy`, `p3_3_spike_x`, стара фіксована `simetra_build_plan_owner`, об'єкт з тегом іншого прогону. Тест: unit-шаблони (задача 2) і чужа тінь у тесті обробника (задача 3).
2. **Сигнал посеред `CREATE DATABASE` у воркері:** воркер, що безперервно створює тегові бази, після сигналу не лишає жодної. Тест: дочірній «воркер» фікстури (задача 3).
3. **Стек недоступний під час прибирання:** обробник не висне довше межі, знімає замок, виходить ненульовим кодом і друкує, що лишилось. Тест: CLI прибиральника з недосяжною адресою (задача 3).
4. **DB-тест без globalSetup** (файл запущено не через DB-проєкт): `runTag()` кидає зрозумілу помилку, а не створює нетегове ім'я. Тест: задача 2.
5. **Конкурентні тести одного файлу:** облік провізій не дає хибної тривоги на живих тінях сусідніх тестів і ловить справжню сироту. Тест: задача 4 (сирота в ledger) і прогони задачі 6.

---

### Task 1: `connection.ts` без `src/schema`

**Files:**
- Create: `packages/simetra/test/db/fingerprint.ts`
- Modify: `packages/simetra/test/db/connection.ts` (прибрати імпорт `../../src/schema` і `fingerprintAfterSteps`)
- Modify: `packages/simetra/test/support.ts` (реекспорт `./db/fingerprint`)
- Test: `packages/simetra/test/db/connection.test.ts`

**Interfaces:**
- Produces: `fingerprintAfterSteps(url, scope, steps, o?)` — та сама сигнатура, тепер у `test/db/fingerprint.ts`; designer бере її через `test/support.ts` як і раніше (імпорти в designer не змінюються).

- [ ] **Step 1: тест** у `connection.test.ts`: `it("imports nothing from the package sources", …)` — читає `connection.ts` (`readFileSync` поруч із тестом) і `expect(source).not.toMatch(/from\s+"\.\.\/\.\.\/src/)`. Коментар: globalSetup і прибиральник вантажать цей модуль у головному процесі та в `spawnSync`, тож він має лишатися легким.
- [ ] **Step 2:** `pnpm --filter simetra test connection` — FAIL.
- [ ] **Step 3:** перенести `fingerprintAfterSteps` разом з її імпортами (`readFingerprint`, типи) у `fingerprint.ts`; JSDoc без змін; реекспорт у `support.ts`.
- [ ] **Step 4:** `pnpm --filter simetra test connection` — PASS; `pnpm --filter simetra typecheck && pnpm --filter @simetra/designer typecheck` — без помилок.
- [ ] **Step 5: Commit** `refactor(test): connection.ts без залежності від src/schema`.

### Task 2: тег прогону й імена з одного джерела

**Files:**
- Modify: `packages/simetra/test/db/connection.ts`
- Modify: `packages/simetra/test/db/stack-guard.ts` (генерує тег, кладе в env, друкує)
- Test: `packages/simetra/test/db/connection.test.ts`

**Interfaces:**
- Produces (усе в `connection.ts`, експортовано):
  - `RUN_TAG_ENV = "SIMETRA_DB_RUN_TAG"`
  - `newRunTag(): string` — 6 символів `[0-9a-z]`.
  - `runTag(): string` — з env; без нього кидає `Error("SIMETRA_DB_RUN_TAG is not set: DB tests run only under the stack-guard globalSetup (vitest project db)")`.
  - `testRoleName(label: string): string` → `simetra_${label}_${runTag()}`; `label` поза `/^[a-z0-9_]+$/` → `Error`.
  - `testDatabaseName(label: string): string` → `simetra_${label}_${runTag()}_${rand6}`.
  - `shadowSuffix(): string` → `${Date.now().toString(36)}_${runTag()}_${rand6}` (суфікс для `uniqueSuffix` pg-delta).
  - `runObjectPatterns(tag: string): { databases: RegExp; roles: RegExp }` — databases `^(pgdelta_shadow_[0-9a-z]+_<tag>_[0-9a-z]+|simetra_[a-z0-9_]+_<tag>_[0-9a-z]+)$`, roles `^simetra_[a-z0-9_]+_<tag>$`. Синтаксис — спільна підмножина JS і POSIX ARE: прибиральник передає `.source` у Postgres-оператор `~`.

- [ ] **Step 1: тести** (`describe("run tag names", …)`, тег задається через `vi.stubEnv(RUN_TAG_ENV, "abc123")`):
  - `newRunTag()` відповідає `/^[0-9a-z]{6}$/`.
  - `runTag()` без env кидає з текстом, що містить `stack-guard`.
  - `testRoleName("build_plan_owner")` = `"simetra_build_plan_owner_abc123"`; `testRoleName("Bad-Label")` кидає.
  - `testDatabaseName("copy")`, `testRoleName("x")` і `SHADOW_PREFIX + shadowSuffix()` збігаються з відповідним шаблоном `runObjectPatterns("abc123")`.
  - `shadowAgeMinutes(SHADOW_PREFIX + shadowSuffix())` < 1 (вік читається з тегового імені).
  - Чужі імена НЕ збігаються з жодним шаблоном: `pgdelta_shadow_mv9rieqo_6uepn5`, `metahub_copy`, `metahub_copy_rehearsal`, `p3_3_spike_a`, `simetra_build_plan_owner`, `simetra_copy_zzz999_k3j2h1` (інший тег), `postgres`.
- [ ] **Step 2:** `pnpm --filter simetra test connection` — FAIL (немає експортів).
- [ ] **Step 3:** реалізувати в `connection.ts`; у `stack-guard.ts` `setup()` після `acquireLock()` — `process.env[RUN_TAG_ENV] = newRunTag()` (env успадковують форки, які vitest стартує після globalSetup) і рядок у stderr `DB run tag <тег> at <summary>` замість теперішнього `DB run at …`.
- [ ] **Step 4:** `pnpm --filter simetra test connection` — PASS. Перевірка, що воркер бачить тег: тимчасово не потрібна окремо — її доводить задача 4 (тінь отримує тег у DB-тесті).
- [ ] **Step 5: Commit** `test(db): тег прогону й імена об'єктів стеку з одного джерела`.

### Task 3: прибиральник і обробник сигналу

**Files:**
- Create: `packages/simetra/test/db/sweep.ts` — функція й CLI-вхід
- Create: `packages/simetra/test/db/interrupt.ts` — обробник
- Create: `packages/simetra/test/db/fixtures/interrupted-run.ts` — дочірній процес для тесту
- Create: `packages/simetra/test/db/interrupt.db.test.ts`
- Modify: `packages/simetra/test/db/stack-guard.ts` (ставить обробник, знімає його в teardown)
- Modify: `packages/simetra/package.json` (devDependencies `"tsx": "4.23.15"`), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `runObjectPatterns`, `testSuperuserUrl`, `testDatabaseUrl`, `testDatabaseName`, `testRoleName`, `shadowSuffix`, `SHADOW_PREFIX`, `RUN_TAG_ENV` (задача 2).
- Produces:
  - `sweepRun(tag: string, o?: { deadlineMs?: number }): Promise<{ dropped: string[]; left: string[] }>` — від `testSuperuserUrl()` до бази `postgres`: бази за `databases` → `DROP DATABASE … WITH (FORCE)`; ролі за `roles` → `DROP OWNED BY` + `DROP ROLE`; прохід повторюється з паузою 1 с, доки прохід нічого не знайде або не мине `deadlineMs` (типово 30 000). Помилка окремого `DROP` не зупиняє прохід — ім'я йде в `left`.
  - CLI: `node --import tsx sweep.ts <tag>` — друкує `dropped`/`left` у stderr; код 0, якщо `left` порожній, інакше 1; недосяжний стек — код 1 з текстом причини й SQL ручного прибирання за тегом.
  - `installInterruptCleanup(o: { tag: string; release: () => void }): () => void` — ставить `process.once` на SIGINT, SIGTERM, SIGHUP; повертає функцію зняття обробників. Обробник синхронний: (1) `pgrep -P <process.pid>` → `process.kill(pid, "SIGKILL")` кожному (ESRCH ігнорується; без `pgrep` — рядок у stderr і далі); (2) `spawnSync(process.execPath, ["--import", <URL tsx>, <шлях sweep.ts>, tag], { stdio: "inherit", timeout: 40_000 })`, де URL tsx — `pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href`; (3) `o.release()`; (4) `process.exit(128 + os.constants.signals[signal])`.
- `stack-guard.ts`: `setup()` ставить обробник одразу після генерації тегу з `release: releaseLock`; teardown спершу знімає його (нормальне завершення прибирання не запускає — звірка стеку лишається як є).

- [ ] **Step 1: фікстура** `fixtures/interrupted-run.ts` (аргумент — тег, ставить `process.env[RUN_TAG_ENV]`): `installInterruptCleanup({ tag, release: () => {} })`; від суперкористувача створює базу `testDatabaseName("interrupt_copy")`, базу `SHADOW_PREFIX + shadowSuffix()`, роль `testRoleName("interrupt_owner")` і чужу на вигляд тінь `SHADOW_PREFIX + <мс36>_<rand>` (без тегу, ім'я друкує); форкає дочірній процес-«воркер» (той самий файл з аргументом `--worker`), що в циклі кожні 200 мс створює `testDatabaseName("interrupt_worker")`; друкує в stdout `ready <ім'я чужої тіні> <pid воркера>`; далі чекає безкінечно.
- [ ] **Step 2: тести** `interrupt.db.test.ts` (`describe("an interrupted DB run", …)`, `it.each(["SIGTERM", "SIGINT"])`): запустити фікстуру `node --import tsx` з тегом `newRunTag()`; дочекатися `ready`, ще 500 мс (воркер встигає створити бази); надіслати сигнал; дочекатися виходу (≤45 с). Перевірки: код виходу `128 + номер`; у `pg_database`/`pg_roles` немає імен, що збігаються з `runObjectPatterns(tag)`; чужа тінь існує (тест сам видаляє її у `finally` — її створив цей тест); pid воркера мертвий (`process.kill(pid, 0)` кидає ESRCH). Окремий `it("exits non-zero with the cleanup SQL when the stack is unreachable", …)`: CLI `sweep.ts` з `SIMETRA_TEST_SUPERUSER_URL` на закритий порт (`127.0.0.1:1`) → код 1 за ≤10 с, stderr містить тег.
- [ ] **Step 3:** `pnpm --filter simetra test:db interrupt` — FAIL (модулів нема).
- [ ] **Step 4:** реалізувати `sweep.ts`, `interrupt.ts`, підключення в `stack-guard.ts`, `tsx` у devDependencies (`pnpm install`).
- [ ] **Step 5:** `pnpm --filter simetra test:db interrupt` — PASS; прогін не падає на звірці стеку.
- [ ] **Step 6: ручна перевірка сценарію-приводу** (зовнішній `timeout`): у фоні `timeout -s TERM 90 pnpm --filter @simetra/designer test:db build-plan`; після виходу — `docker exec supabase_db_simetra psql -U postgres -Atc "select datname from pg_database where datname ~ '^(pgdelta_shadow_|simetra_)'"` і те саме для `pg_roles` з `'^simetra_'`: об'єктів з тегом цього прогону (тег — у stderr прогону) немає, файл `$(node -p "require('os').tmpdir()")/simetra-db-stack.lock` відсутній або не цього pid. Результат (і чи pnpm донесла SIGTERM до vitest) — у звіт задачі. Якщо pnpm сигнал не донесла — зупинитися й доповісти архітекторові.
- [ ] **Step 7: Commit** `test(db): перерваний прогін прибирає свої об'єкти стеку`.

### Task 4: спільні помічники DB-тестів designer і облік провізій

**Files:**
- Create: `packages/designer/src/__tests__/support/db.ts` — помічники
- Create: `packages/designer/src/__tests__/support/shadows.ts` — облік провізій
- Create: `packages/designer/src/__tests__/support/db-setup.ts` — setupFile DB-проєкту
- Create: `packages/designer/src/__tests__/support/shadows.db.test.ts`
- Modify: `packages/designer/vitest.config.ts` (проєкт `db`: `setupFiles: ["./src/__tests__/support/db-setup.ts"]`)
- Modify: `src/schema-engine/__tests__/round-trip.db.test.ts` (власний `vi.mock` pg-delta і `provisioned`/`inFlight` → облік із `shadows.ts`), `build-plan.db.test.ts` і `execute-plan.db.test.ts` (глобальний `shadowDatabaseCount` у `beforeEach`/`afterEach` прибрати)

**Interfaces:**
- Consumes: `testDatabaseUrl`, `testSuperuserUrl`, `testDatabaseName`, `testRoleName`, `shadowSuffix` через `simetra/test/support`.
- Produces (`support/db.ts`):
  - `query<R extends pg.QueryResultRow>(url: string, sql: string, params?: unknown[]): Promise<R[]>` — окремий клієнт на виклик, `end` у `finally`.
  - `asSuperuser(url: string): string` — та сама база, облікові дані `testSuperuserUrl()`.
  - `inTarget<T>(desiredSql: string, scope: EngineScope, fn: (url: string) => Promise<T>, engine?: SchemaEngine): Promise<T>` — `withDesiredShadow({ target: { url: testDatabaseUrl() } }, …)`; статус ≠ `loaded` → `Error("target did not load: …")`.
  - `withCopy<T>(clause: string, fn: (url: string, name: string) => Promise<T>): Promise<T>` — `create database "<testDatabaseName("copy")>" owner postgres <clause>` від суперкористувача, `drop database if exists … with (force)` у `finally`.
  - `dropRoles(...names: string[]): Promise<void>` — `drop role if exists` від суперкористувача.
- Produces (`support/shadows.ts`):
  - `recordProvision<T extends { name: string }>(p: Promise<T>): Promise<T>` — кличе лише обгортка з `db-setup.ts`.
  - `provisionedShadows(): readonly string[]`
  - `leftoverShadows(): Promise<string[]>` — чекає провізії в польоті, повертає записані імена, що досі є в `pg_database`.
  - `expectNoLeftoverShadows(): Promise<void>` — сироти є → видаляє їх (`WITH (FORCE)`, це тіні цього файлу) і кидає `Error` з їхніми іменами.
- `db-setup.ts`: `vi.mock("@supabase/pg-delta", …)` — прохідна обгортка `provisionCoLocatedShadow(url, opts)` → `recordProvision(actual(url, { ...opts, uniqueSuffix: opts?.uniqueSuffix ?? shadowSuffix() }))`, коментар «чому не в `ShadowOptions`»; глобальний `afterAll(expectNoLeftoverShadows)` (після кожного файлу; `afterEach` свідомо ні — у конкурентних файлах живі тіні сусідніх тестів дали б хибну тривогу).

- [ ] **Step 1: тест** `shadows.db.test.ts`: (а) `withDesiredShadow` на `select 1;` → `provisionedShadows()` має одне нове ім'я, що збігається з `runObjectPatterns(runTag()).databases`, і `leftoverShadows()` порожній після виходу; (б) провізія напряму через замоканий `provisionCoLocatedShadow` без `cleanup` → `expectNoLeftoverShadows()` кидає з цим іменем і тінь зникла зі стеку.
- [ ] **Step 2:** `pnpm --filter @simetra/designer test:db shadows` — FAIL.
- [ ] **Step 3:** реалізувати `support/*`, підключити setupFile; у `round-trip.db.test.ts` замінити власний мок і `provisioned`/`inFlight` на `provisionedShadows()`/`leftoverShadows()` (поведінка перевірок файлу — та сама); у `build-plan` і `execute-plan` прибрати лічильник тіней (`shadowsBefore`).
- [ ] **Step 4:** `pnpm --filter @simetra/designer test:db shadows` — PASS; `pnpm --filter @simetra/designer test:db round-trip` — PASS.
- [ ] **Step 5: Commit** `test(designer): облік провізій тіней і тег у їхніх іменах`.

### Task 5: перехід DB-тестів designer на спільні помічники й тегові імена

**Files:**
- Modify: усі `packages/designer/src/**/*.db.test.ts`, що мають локальні `other`/`query`/`exec`/`rows`/`one`/`inTarget`/`withCopy`/`asSuperuser`/`dropRole(s)` або створюють ролі чи бази на стеку. Перелік — командою `grep -lE "function (other|query|exec|rows|one|inTarget|withCopy|asSuperuser|superuserIn|dropRoles?)\b|create (role|database)" -r packages/designer/src --include=*.db.test.ts`.

**Interfaces:**
- Consumes: `support/db.ts` (задача 4), `testRoleName` (задача 2).

- [ ] **Step 1:** у кожному файлі: локальні копії замінити імпортом із `support/db.ts`; варіант із відмінною семантикою (напр. `inTarget`, що спершу вантажить `desired.sql`, а `setup` виконує окремо; `function-checks` із третім аргументом) лишається локальною тонкою обгорткою над спільним `inTarget`/`query` з коментарем, чим відрізняється.
- [ ] **Step 2:** усі фіксовані тестові ролі (`simetra_apply_lifecycle_owner`, `simetra_apply_tools_owner`, `simetra_build_plan_owner` і решта ролей `build-plan` — `STRANGER`, `WRITERS`, `COPIER`, `simetra_execute_owner`, `simetra_fingerprint_owner`, `simetra_fncheck_owner`, `simetra_round_trip_owner`, `simetra_db_tools_stranger`, `COPY_OWNER` у `execute-plan`) → `testRoleName("<мітка>")`; бази-копії `execute-plan` і `promotion-commit` → `withCopy` (копія `promotion-commit` більше не маскується під тінь `pgdelta_shadow_…_copy_`). Рядок «роль могла лишитися від убитого прогону» з попереднім `dropRole` прибрати: тегова роль від іншого прогону не перетинається з поточною, а свою прибирає обробник сигналу.
- [ ] **Step 3: перевірка повноти:** `grep -rnE "create (role|database) " packages/designer/src --include=*.db.test.ts` — кожне ім'я йде з `testRoleName`/`testDatabaseName`/`withCopy`; `grep -rnE "^(async )?function (other|query|exec|rows|one|withCopy|asSuperuser|superuserIn|dropRoles?)\b" packages/designer/src --include=*.db.test.ts` — порожньо (або лише задокументовані тонкі обгортки з кроку 1).
- [ ] **Step 4:** повний `pnpm --filter @simetra/designer test:db` у фоні — усі зелені, звірка стеку чиста; `pnpm --filter @simetra/designer lint && pnpm --filter @simetra/designer typecheck`.
- [ ] **Step 5: Commit** `test(designer): спільні помічники DB-тестів і тегові ролі та копії`.

### Task 6: конкурентні тести у важких DB-файлах

**Files:**
- Modify: `packages/designer/vitest.config.ts` (проєкт `db`: `maxConcurrency: 4` з коментарем — стеля CPU одного процесу, 8 не швидше за 4 за заміром)
- Modify (лише ті, що пройшли аудит): `build-plan.db.test.ts`, `promotion-lifecycle.db.test.ts`, `execute-plan.db.test.ts`, `round-trip.db.test.ts`, `apply-lifecycle.db.test.ts`, `apply-tools.db.test.ts`

- [ ] **Step 1: аудит кожного файлу за чеклистом**, результат — рядок у звіті («файл: так/ні, причина»): (1) кожен тест працює у власних тінях/копіях, не на базі стеку `postgres` напряму; (2) немає змінного стану рівня файлу (`let`, що переприсвоюється в тестах чи `beforeEach`); (3) немає спільних `vi.spyOn`/`vi.mock`-шпигунів, чиї лічильники читає тест; (4) тест не змінює кластерного стану (`create/alter/drop role`, `grant <роль> to`, `alter system`, налаштування ролей) поза `beforeAll`; (5) немає `toMatchSnapshot`/`expect.assertions`/`expect.hasAssertions` через глобальний `expect` (для конкурентних — `expect` з контексту тесту); (6) немає тестів, чутливих до часу чи сторонніх сесій (утримувачі блокувань `holder`, `pg_stat_activity`) — такі лишаються в послідовному `describe` того самого файлу.
- [ ] **Step 2:** для файлів, що пройшли: верхні `describe` → `describe.concurrent`; чутливі тести з п. 6 — в окремий послідовний `describe`.
- [ ] **Step 3:** кожен змінений файл — тричі поспіль `pnpm --filter @simetra/designer test:db <файл>`: усі зелені щоразу (нестабільність = файл назад у послідовний з причиною в звіті).
- [ ] **Step 4: Commit** `test(designer): конкурентні тести у важких DB-файлах`.

### Task 7: ESLint-тести меж без холодного старту в тесті

**Files:**
- Modify: `packages/designer/test/studio-boundary.test.ts`, `packages/designer/test/support-boundary.test.ts`, `packages/simetra/test/tier-boundary.test.ts`

- [ ] **Step 1:** у кожному файлі `beforeAll(async () => { await eslint.lintText("", { filePath: join(PKG, "src/index.ts"), warnIgnored: true }) }, 60_000)` з коментарем: перший `lintText` вантажить конфіг пакета з typescript-eslint і пакетом `typescript` — разова ціна процесу (0,6 с у спокої, до 4,7 с під повним `pnpm test`), а не перевірки межі; тайм-аут тесту має міряти тест. Шлях-файл має існувати в пакеті й підпадати під TS-конфіг (для simetra — відповідний існуючий `src/**/*.ts`).
- [ ] **Step 2:** поодинці: `pnpm --filter @simetra/designer test boundary` і `pnpm --filter simetra test tier-boundary` — PASS.
- [ ] **Step 3:** тричі `pnpm test --force` (без DB-прогонів паралельно): зелено; у виводі тривалість кожного тесту цих трьох файлів < 1 с (`grep -E "boundary" <лог>`).
- [ ] **Step 4: Commit** `test: ESLint-тести меж прогрівають конфіг поза тайм-аутом тесту`.

### Task 8: тіло стандарту SQL не йде у WASM PL/pgSQL-парсер (прод-фікс)

**Files:**
- Modify: `packages/simetra/src/compiler/sql/plpgsql.ts` (`parseFunction`)
- Test: `packages/simetra/src/compiler/__tests__/plpgsql.test.ts`, `packages/simetra/src/compiler/__tests__/operations-promote-sql.test.ts`

**Interfaces:**
- `PlpgsqlParser` — сигнатура без змін; для CREATE FUNCTION з тілом стандарту SQL повертає `{ ok: true, fn: undefined }` (як для `LANGUAGE sql` з `AS $$…$$`), не викликаючи `parsePlPgSQLSync`.

- [ ] **Step 1: тести.** У `plpgsql.test.ts` — шпигун на `parsePlPgSQLSync` через `vi.mock("@libpg-query/parser", async (orig) => ({ ...(await orig()), parsePlPgSQLSync: vi.fn((await orig()).parsePlPgSQLSync) }))`; наявний тест «turns a SQL-standard body…» перейменувати на `"returns fn undefined for a SQL-standard body without calling the WASM parser, and keeps parsing"`: `expect(parse("CREATE FUNCTION app.s() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;")).toEqual({ ok: true, fn: undefined })`, шпигун для цього входу не викликано, `parse(fn("BEGIN RETURN NEW; END")).ok` = `true`. У `operations-promote-sql.test.ts` — випадок промоції, де серед одиниць є `CREATE FUNCTION … LANGUAGE sql BEGIN ATOMIC …`, що посилається на промотовану таблицю: результат такий самий, як для еквівалентної функції з `AS $$…$$` (той самий набір посилань/відмов, що вже перевіряє сусідній тест файлу), і `parsePlPgSQLSync` не викликано.
- [ ] **Step 2:** `pnpm --filter simetra test plpgsql` і `pnpm --filter simetra test operations-promote-sql` — FAIL.
- [ ] **Step 3:** у `parseFunction` до `parsePlPgSQLSync`: розібрати `sql` звичайним `parseSync` того самого пакета (модуль уже завантажено `loadModule`); перший оператор — `CreateFunctionStmt` з тілом стандарту SQL (поле `sql_body`; точну назву поля звірити пробним розбором) → `{ ok: true, fn: undefined }`. Коментар: C-assert `proc_source != NULL` у `pg_query_parse_plpgsql.c` друкує `Aborted(…)` у stderr процесу ще до `RuntimeError`, тож перехоплення не досить — виклик не повинен відбуватися; виклик у `promote/sql.ts` (`calls`) мови не перевіряє.
- [ ] **Step 4:** обидва файли — PASS; `pnpm --filter simetra test` — у stderr немає `Aborted(`.
- [ ] **Step 5: Commit** (окремо від тест-інфри) `fix(compiler): тіло стандарту SQL не потрапляє у WASM-парсер PL/pgSQL`.

### Task 9: прогалини тестів із §3 боргу

**Files:**
- Test: `packages/designer/src/__tests__/cli.test.ts` (`promotionLines`)
- Test: `packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts` («refuses a copy on another server»)
- Test: `packages/designer/src/__tests__/promotion-lifecycle.db.test.ts` (`planPromotion` копіює `data`)

- [ ] **Step 1: `promotionLines`** (`packages/designer/src/io/report.ts`): поруч із наявним блоком у `cli.test.ts` — `it("prints no trigger line for a table without triggers", …)` (та сама фікстура `PlanData`, `triggers: []` → у виводі немає рядка «triggers disabled during the write»; рядок кроків даних є) і `it("prints no data-step lines for an empty data", …)` (`data` порожній → немає рядків «data steps»). `pnpm --filter @simetra/designer test cli` — PASS (якщо гілки вже працюють правильно, тест зелений одразу — це фіксація поведінки, не виправлення).
- [ ] **Step 2: «another server»:** прибрати `expect(plan.server.collate).not.toBe("C")`; колацію копії обирати від фактичної колації цілі: зчитати `datcollate` цілі, для копії взяти `C`, а якщо ціль уже `C` — `C.UTF-8`; `lc_ctype` — те саме значення. Тест перевіряє ту саму відмову, що й раніше.
- [ ] **Step 3: `planPromotion` копіює `data`:** у тесті `promotion-lifecycle`, що планує промоцію з кроками даних (`data: { codeLength: 0 }` в інтенті), додати: `data.promotion!.data` непорожній і дорівнює секції `promotion.data` артефакту плану, прочитаного з `data.file` (JSON). Без експорту `planPromotion` для тестів.
- [ ] **Step 4:** `pnpm --filter @simetra/designer test:db execute-plan` і `pnpm --filter @simetra/designer test:db promotion-lifecycle` — PASS.
- [ ] **Step 5: Commit** `test(designer): прогалини тестів із залишкового боргу П3-2b`.

### Task 10: документація, гейти, замір «після», звіт

**Files:**
- Modify: `AGENTS.md` § «Commands and gates» — абзац про globalSetup DB-проєктів: додати, що кожен об'єкт, який DB-тест створює на стеку, іменується помічниками тегу прогону з `packages/simetra/test/db/connection.ts`, а перерваний сигналом прогін прибирає свої об'єкти сам (SIGKILL — ні: сироти називає наступний прогін).
- Modify: `packages/simetra/test/db/stack-guard.ts` — застарілий коментар «Повний прогін designer триває ~20 хв» (оновити за заміром «після», без цифри-лічильника, якщо можна сформулювати правилом).
- Перевірити `orient --map "DB tests stack guard"` на інші документи, що описують сторож/лічильник тіней, і оновити їх за правилом «одне місце — один факт».

- [ ] **Step 1:** правки документів; `python3 scripts/check-doc-anchors.py` — без помилок.
- [ ] **Step 2: Commit** `docs: тег прогону DB-тестів і прибирання перерваного прогону`.
- [ ] **Step 3: гейти на одному SHA** (дерево не редагується): `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db` (у фоні, без таймауту < 45 хв). Записати SHA.
- [ ] **Step 4: замір «після»** тим самим способом, що «до»: послідовно `cd packages/simetra && npx vitest run --project db --reporter=json --reporter=default --outputFile.json=<файл>` і так само для `packages/designer`; wall-time кожного; поруч — HEAD, чисте дерево, відсутність інших vitest і DB-прогонів (якщо сторож завалив через `p3_3_spike_*` — повторити).
- [ ] **Step 5: звіт архітекторові** (`consumer-reconciliation2`): коміти; «до» (HEAD 769f565: designer 1726 с, build-plan 830 с, simetra 10 с) і «після» по файлах; рядки аудиту задачі 6; результат ручної перевірки задачі 3; рішення; кандидати поза планом (щонайменше: 11 витягів каталогу на один `buildPlan` у прод-коді — це й швидкість для користувача; паралель файлів після розв'язання видимості кластерних ролей).
- [ ] **Step 6: після прийняття** — окремим комітом зняти §3 з `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` з посиланням на цей план; відхилене «unchanged зі статусу» — у §5 «Відхилено» з причиною.
