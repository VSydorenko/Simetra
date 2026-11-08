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
перемикання перевіряється за `session_user`. Модель тримають чотири
запобіжники: (i) роль власника — стартовий параметр кожного з'єднання, а
сесійні налаштування його дописують, не замінюють; (ii) вихід у
суперкористувача явно відновлює роль і `search_path` на обох шляхах; (iii)
дрейф ролі ловлять guard на старті прогону, `afterEach` DB-проєктів і
статичний тест форм скидання ролі; (iv) код, що вимагає
`session_user = current_user`, іде окремим DSN прямого входу власника
(Р1, Р15, Р16). Роль запиту, таблицю
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
  архітекторка, і лише після задачі 14: до неї CI-рядки `db` і `db-postgres`
  не відповідають проміжному стану гілки (`db-postgres` — один процес з
  межею часу, у який ростуть перенесені файли).
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`).
- Один процес vitest — один DB-проєкт.
- **Кожен коміт зелений.** До задачі 14 проєкт `db` іде на `supabase`;
  перенесений файл входить у `db-pg` і виходить з `db` тим самим комітом
  (Р6).
- **Кейс не губиться і не задвоюється.** Перелік назв знімається окремим
  викликом на проєкт:
  ```bash
  SIMETRA_TEST_PROVIDER=<профіль> pnpm --filter <пакет> exec vitest list \
    --project <проєкт> --staticParse=false --json > <scratchpad>/<пакет>-<проєкт>.json
  ```
  з профілем `supabase` для `db` і `db-supabase`, `postgres` для `db-pg`.
  `vitest list` виконує `globalSetup` проєкту: guard бере замок стека й
  потребує піднятого стека, тож переліки знімаються по одному, не під час
  іншого DB-прогону. Ключ — повна назва (`describe > … > it`), не файл.
  Переліки «до» знімаються з тією самою змінною. Об'єднання назв трьох
  проєктів після задачі дорівнює об'єднанню до неї; винятки з причиною у
  звіті — кейс, розщеплений за профілем, і назва, що на рівні модуля містить
  провайдер (шаблон чи `it.each` з `testProvider()`, як
  `pgTAP suites of the ${provider} stack`).
- **Обхід суперкористувачем видно.** Кожна задача переносу звітує
  `git grep -cE "testSuperuserUrl\(\)|asSuperuser\(|asStackSuperuser\(|superuserClient\(|superuserUrl|asSessionLogin\(|SESSION AUTHORIZATION|ROLE postgres" -- packages`
  до й після; кожен приріст — з причиною для кожного кейса.
- **Пропуск не ховає перевірку.** У файлах `db` (`*.db.test.ts` без
  `.supabase.` і `.postgres.`) немає `.skip`, `.todo`, порівняння
  `testRoleFor(…)` з `null` і раннього `return` за ним, а `skipIf(`/`runIf(`
  (`it`, `test`, `describe`) — лише з умовою, що не читає профіль (без
  `testProvider`, `testRoleFor`, `PROVIDER_`, `TEST_STACKS`, `provider`);
  винятки — поіменно в `skip-boundary.test.ts` (задача 4). Кейс, якому
  потрібна сервісна роль, — у `*.supabase.db.test.ts` (Р5). Кожна задача
  переносу звітує число пропущених кейсів на кожному стеку
  (`--reporter=json`, `numPendingTests`).
- Тест, прив'язаний до Supabase за §10.5, — у `*.supabase.db.test.ts`; інший
  літерал Supabase в `db` переводиться на дані профілю, а не
  перейменовується.
- Об'єкти DB-тестів — лише через хелпери тегу (`connection.ts`).
- Dev-паролі стека — у `docker/postgres-stack/dev-secrets.env`, лише для
  `127.0.0.1`; DSN з паролем читається лінивою функцією `devSecret(name)`
  (`profile.ts`, задача 3), не при імпорті.
- **Роль сесії не дрейфує — дозволений перелік, а не чорний список.**
  Будь-яка форма `(RE)SET [LOCAL|SESSION] ROLE` (з `TO`, `=`, лапками чи
  без), будь-яке `session authorization` / `session_authorization` і будь-який
  `set_config(` з першим аргументом поза дозволеними — лише в місцях,
  названих поіменно в `role-switch.test.ts` (задача 3). Дозволено без
  винятку: `SET LOCAL ROLE ${…}` у DB-файлах і помічниках, коли ціль —
  `PLATFORM_ROLES.…`, `testRoleFor(…)`, `PROVIDER_*[…]`, `readRoleOf(…)`,
  `testRoleName(…)` (тегована роль прогону) чи стала, оголошена з них у
  файлі чи в його помічнику; `set_config(` з першим аргументом — літералом з переліку
  `ALLOWED_SETTINGS` тесту чи підстановкою `SESSION_CLAIMS_SETTING`,
  `COMMAND_SETTING`, `RIGHTS_MAINTENANCE_SETTING` (зокрема через `literal(…)`,
  `sqlLiteral(…)`); `set_config($1` — лише в `connection.ts` (помічник
  `setLocalSetting`) і `rights-seed.ts`. Повернення до власника —
  `restoreOwnerRole(client)`; вихід у суперкористувача — `asStackSuperuser`;
  інша роль входу в межах транзакції — `asSessionLogin`. Літерал ролі
  `postgres` у SQL файлів `db` (`role postgres`, `to postgres`,
  `for role postgres`) — збій того самого тесту; ім'я —
  `PROVIDER_OWNER_ROLES[testProvider()]`. Дрейф ловлять guard на старті
  прогону, перевірка `withRollback` і `afterEach` DB-проєктів (Р15).
- **Параметр `options` адреси тестів не перезаписується.** Сесійні
  налаштування дописує `withSessionOptions(url, extra)`, і `-c role=`
  лишається; адреса з двома параметрами `options` — `Error` (у
  `pg-connection-string` перемагає останній, і роль губиться); DSN ролі входу
  будує лише `loginUrl()`, що прибирає `-c role=`. У джерелах тестів поза
  `withSessionOptions` і `loginUrl` будь-який рядок `options=`, будь-який
  виклик `searchParams.*("options"`, `.username =` на адресі тестів і ключ
  `options:` у конфігу `pg.Pool`/`pg.Client` поряд з `connectionString` —
  збій статичного тесту задачі 3.
- **Код, що вимагає `session_user = current_user`,** у тестах іде на
  `testOwnerLoginUrl()` чи, для тегованої цілі чи копії designer-а, на
  `withDatabaseName(testOwnerLoginUrl(), <база>)` (`@supabase/pg-delta`), а
  засів у транзакції адреси тестів — через `asSessionLogin` з власником
  (Р16); такий тест не потребує `SET ROLE` за членством.
- Задачу 16 (текст `AGENTS.md`) виконавець не виконує (Р14).

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Модель з'єднання тестів на `postgres`** (варіант «а» аудиту, рішення архітекторки). Тести входять суперкористувачем стека; адреса тестів несе стартовий параметр `options=-c role=simetra_owner`, тож **кожне** нове з'єднання, і тест-хелпера, і рушія чи pg-delta з тієї самої адреси, стартує з `current_user = simetra_owner`. `SET LOCAL ROLE <запиту\|команд>` дозволено, бо перемикання перевіряється за `session_user`: рядки `GRANT simetra_command TO CURRENT_USER` у файлах `db` прибираються. `RESET ROLE` повертає стартову роль, а не суперкористувача (перевірено аудитом), але в тестах його вживає лише обгортка `restoreOwnerRole` — одне місце форми для статичного тесту. Об'єкти, яких власник не створить (`CREATE ROLE`, `CREATE EXTENSION`), — хелпер `asStackSuperuser(client, fn)`. `SET LOCAL`, зроблений у точці збереження, переживає `RELEASE SAVEPOINT`, тож хелпер відновлює роль і `search_path` **явно на обох шляхах**: після успішного `fn` — `set_config('role', <попередня>, true)` і `set_config('search_path', <попередній>, true)` до `RELEASE`; на збої — `ROLLBACK TO SAVEPOINT`. У `fn` кожне ім'я кваліфіковане, `CREATE EXTENSION` — завжди з `SCHEMA` (прелюдія `search_path = pg_catalog, pg_temp` лишається, §3.4). `signUp` на `postgres` вставляє від `simetra_auth`, як у проді, і завжди перемикається зі стану викликача й відновлює його: читає `session_user` і `current_user`, `SET LOCAL SESSION AUTHORIZATION DEFAULT` (назад до суперкористувача входу), `SET LOCAL ROLE simetra_auth`, вставка, потім явне `SET LOCAL SESSION AUTHORIZATION <попередній session_user>` і `SET LOCAL ROLE <попередній current_user>` на обох шляхах — тож `signUp` працює й усередині `asSessionLogin(власник)` засіву під режимом обслуговування (Р16); DML-гранту власнику на `better_auth` немає. Інша роль входу в межах транзакції (кейси `session_user` у `rights-guards` і `command-grants`, засів Р16) — `asSessionLogin(client, login, fn)`, що на обох шляхах відновлює попередні `current_user` і `search_path`. DSN ролі входу — `loginUrl()` без `-c role=`; сесійні налаштування — `withSessionOptions()`, що дописує до `options`. Прелюдія `roles` у `postgres-cluster.ts` іде окремим DSN суперкористувача без `options`; код, що вимагає `session_user = current_user`, — Р16 | §10.3 «адреси» — модель і чотири запобіжники (задача 0) |
| Р2 | Цільова база тестів стека `postgres` — `simetra`. `TEST_STACKS.postgres.databaseUrl` = `postgresql://postgres:postgres@127.0.0.1:54422/simetra?options=-c%20role%3D<PROVIDER_OWNER_ROLES.postgres>`, `superuserUrl` — та сама база без `options`. Набір базового стану pgTAP і далі йде в базі `postgres` (кластерні факти й `simetra.environment` стоять там). Прибиральник робить `DROP OWNED BY` у `postgres` і в базі `testDatabaseUrl()`; `manualSweepSql` і `leakMessage` називають обидві. `assertStack`, `snapshot`, `stopRunBackends` — у базі `postgres`, від суперкористувача з прелюдією `SET ROLE NONE`, `SET search_path = pg_catalog, pg_temp` і з `pg_catalog.`-кваліфікованими каталогами | §10.3 «адреси» — база `simetra` (задача 0) |
| Р3 | Guard стека `postgres` після `acquireLock` і `assertStack`, до `snapshot`, звіряє колонки `better_auth."user"` бази `simetra` (порядок `ordinal_position`) з `PROVIDER_EVENT_SOURCES.postgres` і знімає відбиток `better_auth`: `md5` від (відношення, колонка, тип, `attnotnull`) усіх відношень схеми, `nspowner` і `nspacl` схеми, `relowner` і `relacl` відношень, рядків `pg_trigger` на них (`tgname`, `tgenabled`), `pg_default_acl` схеми і рядка `pg_db_role_setting` ролі `simetra_auth`; відбиток після прогону ≠ до — збій `the run changed better_auth` (знімок стека ACL не містить, тож грант, виданий тестом поза відкатом, інакше лишився б непоміченим). Відбиток лише відносний: залишок прогону, убитого SIGKILL до знімка «після», став би базою наступного. Тому на старті ще й абсолютна звірка з очікуваним станом після `db:pg:start`: власник схеми й відношень — `simetra_auth`; у `nspacl` і `relacl` інших отримувачів, крім `simetra_auth`, `USAGE` на схемі й `TRIGGER` на `better_auth."user"` для `simetra_owner`, немає; `pg_default_acl` схеми порожній; тригери на `better_auth."user"`, якщо є, увімкнені; розбіжність — відмова `better_auth of database simetra is not in the db:pg:start state (…)` з тим, що відрізняється. Розбіжність колонок — відмова `better_auth."user" of database simetra does not match this branch (…)`: бракує колонок — порада `pnpm db:pg:start`; зайві — стек з іншої гілки, зупинка стека — за власником. Міграцію й тимчасові гранти дає `db:pg:start` (Р13 ПГ-2a), не `globalSetup` | §10.3 «знімок стека» — звірка `better_auth` (задача 0); §12 рядок ПГ-3 (перенос грантів у `roles`, тест гранту на тегованому кластері, свіжий стек у CI) — править ПГ-3 |
| Р4 | Тест-помічники ролей беруть **призначення** (`user`, `anonymous`, `service`), ім'я ролі — з `PROVIDER_API_ROLES[testProvider()]`. Порядок аргументів не змінюється: `queryAs(client, purpose, claims, sql, params)`, `asRole(client, purpose, claims)`. Claims на `postgres` без `role` (§4.4): тест, що будує `{ role: "authenticated" }`, бере claims з `claimsFor(purpose, sub?)` | немає |
| Р5 | Кейс, якому потрібна сервісна роль, — у `*.supabase.db.test.ts` (ролі провайдера, §10.5); на `postgres` лишається кейс, що доводить **відсутність** сервісних грантів; `it`, що змішує сервісні й користувацькі перевірки, розщеплюється, щоб користувацькі йшли на `postgres` | немає (§10.5) |
| Р6 | **Зелені коміти.** Під час переносу `db` обох пакетів лишається на `supabase`; `db-pg` включає `**/*.postgres.db.test.ts` і явний перелік `ON_POSTGRES` перенесених файлів у `vitest.config.ts` пакета, який `db` виключає. Задача 14 одним комітом перейменовує `db-pg` на `db`, перемикає типовий профіль на `postgres`, прибирає `db` на `supabase` і `ON_POSTGRES` і переводить CI: між перемиканням і CI немає коміту, на якому CI червоний | немає (§10.2, §10.5 описують стан) |
| Р7 | Спільні фікстури з літералами провайдера дістають явний параметр `provider`: `compiler/__tests__/fixtures/rights.ts` (`defaults()`, `singleTenantRights()`), `schema/__tests__/fixtures/e1-fixtures.ts` (FK на таблицю ідентичності, читання `sub`), designer `schema-engine/__tests__/fixtures/round-trip-classes.ts` (`auth.users`, `auth.uid()`, `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`) і `fixtures/engine-boundary.ts` (`provider: "supabase"`, `PROVIDER_SCHEMAS.supabase`). Літерали ідентичності й ролей — з `PROVIDER_*[provider]`; клас без аналога на `postgres` — кейс `supabase-bound` за інвентарем. Типове значення — `supabase`, тож unit-тести не змінюються; DB-викликачі передають `testProvider()`. `kitchenSink()` не змінюється: DB-споживача немає (лише unit-тести) | немає |
| Р8 | **Корпус рушія конвертується, а не перейменовується** (§10.5). `promotion-equivalence` і `fingerprint-coverage` — `scope.provider` з `testProvider()`, файл у `ON_POSTGRES`. `engine-extract`, `engine-census`, `round-trip` — `split`: у `*.supabase.db.test.ts` ідуть лише кейси з публікацією `supabase_realtime`, ролями провайдера в SQL чи `PROVIDER_SCHEMAS.supabase`; решта — на дані профілю | §10.5 — у переліку `db-supabase` публікація `supabase_realtime` і схеми провайдера в кейсах корпусу рушія (задача 0) |
| Р9 | `interrupt.db.test.ts` іде і в `db-supabase` (рядок `include`): шлях guard і прибиральника на стеку Supabase лишається покритим | немає |
| Р10 | Раннер pgTAP: суперкористувач стека, тегована база `CREATE DATABASE … TEMPLATE simetra_template` від суперкористувача, `DROP` у `finally`; `pgtap` створює раннер до `SET ROLE`; claims — `SESSION_CLAIMS_SETTING`; із заголовком `role=` раннер відхиляє в наборі `reset role`, `set role`, `set session authorization` і після набору, до `ROLLBACK`, звіряє `current_user`. Базовий стан — база `postgres`, без тегованої бази | немає (§10.5) |
| Р11 | `scripts/db-stack.mjs`: дочірній процес — асинхронний `spawn` у власній групі (`detached: true`), сигнал пересилається групі один раз, замок знімається лише після виходу дочірнього (межа 30 с, потім SIGKILL групи); кроки з базою — `PGAPPNAME=simetra_db_start`: вузлові кроки (`simetra roles`, `better-auth-cli.ts`) дістають його з середовища, а `psql` у контейнері — через `compose exec -T -e PGAPPNAME=simetra_db_start postgres psql …` (`exec` не передає середовища хоста); їхні бекенди суперкористувач завершує до зняття замка. `start` на запущеному стеку — `up -d --wait --no-recreate`; `docker compose config --hash="*"` друкує рядок `<сервіс> <хеш>` на сервіс, і хеш кожного сервісу звіряється з міткою `com.docker.compose.config-hash` його контейнера; розбіжність — відмова «stack config differs from this branch; stopping the stack is the owner's call». Хеш конфігу не бачить `Dockerfile`, тож контейнер `postgres` несе ще мітку `simetra.stack-files-hash` (`sha256` вмісту `docker/postgres-stack/**`), яка звіряється так само; на запущеному стеку `start` іде без `--build` (інакше перезбирає спільний тег з файлів своєї гілки). Файл замка стека — у фіксованому `/tmp`, не в `tmpdir()`: сесії з різним `TMPDIR` інакше не виключають одна одну; `better-auth-cli.ts` відмовляє без змінної, яку ставить `withStackLock` | §10.2 рядок `db:pg:start` — повтор без перестворення (задача 0) |
| Р12 | Job `db-supabase` у CI — матриця: `provider + simetra`, `designer 1/2`, `designer 2/2`; один рядок перевищив би `timeout-minutes` | §10.6 стовпець «Шарди» `db-supabase` (задача 0) |
| Р13 | Бенчмарк `packages/simetra/bench/rights.bench.db.ts` лишається на `supabase` (проєкт `bench`, `stack-guard.supabase.ts`); задача 4 лише переводить його виклики на нові сигнатури | немає |
| Р14 | Задачу 16 виконавець не виконує: передає текст §10.7 архітекторці й іде далі; правка `AGENTS.md` — частина приймання архітекторкою після затвердження власником; гейти її не вимагають; у тексті PR — що рядки `AGENTS.md` про `test:db` і `test:db:pg` застарілі до затвердження | немає |
| Р15 | **Дрейф ролі ловиться.** (а) Guard стека після `assertStack` відкриває з'єднання з `testDatabaseUrl()` і відмовляє, коли `current_user <> PROVIDER_OWNER_ROLES[p]` або `current_user` має `rolsuper`: «test database URL does not run as <owner> (SIMETRA_TEST_DATABASE_URL?)» — так модель перевіряє кожен прогін, зокрема scoped і з перевизначеною адресою. (б) Дрейф ловиться в тесті, що його спричинив, без хибних тривог від законних станів і сусідніх конкурентних тестів. `withRollback` одразу після `connect` читає стартову роль клієнта; **перед** `ROLLBACK`, коли стартова роль не суперкористувач, звіряє, що поточна теж не суперкористувач (`SELECT NOT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user`; помилку перерваної транзакції ковтає, як і помилку `ROLLBACK`): законна роль запиту чи команд до кінця транзакції (`asRole` у `platform-users.supabase`, `SET LOCAL ROLE` перед `SET CONSTRAINTS` у `rights-plan-gate`, помічник `catalog-command-concurrency`) проходить; **після** `ROLLBACK` на тому самому клієнті — `current_user` = стартова роль (це і є перевірка витоку; на адресі тестів — власник). Клієнт інших хелперів (`connection.ts`, designer `support/db.ts`) пов'язується з тестом, що його відкрив: хелпер реєструє `onTestFinished`, який звіряє `current_user` зі стартовою роллю цього клієнта поза транзакцією (клієнт у транзакції чи вже закритий — пропуск з причиною в коментарі); клієнти конкурентних тестів (`describe.concurrent` у designer-і, як `execute-plan`, `build-plan`, `apply-tools`, `promotion-lifecycle`) не опитуються — з тієї самої причини наявний `support/db-setup.ts` перевіряє тіні в `afterAll`. Пули хелперів — в `afterAll` файлу: `pool.totalCount` клієнтів через одночасні `pool.connect()`, кожен звіряється зі стартовою роллю адреси пулу й звільняється (публічного переліку вільних клієнтів `pg.Pool` немає). Setup-файл DB-проєкту стека `postgres` (simetra — новий `test/db/db-setup.ts`, designer — наявний `support/db-setup.ts`) додає `afterAll` пулів і нове з'єднання з `testDatabaseUrl()` | §10.3 «адреси» — запобіжник (iii) (задача 0) |
| Р16 | **Код, що вимагає `session_user = current_user`, — окремий DSN** (запобіжник (iv)). `testOwnerLoginUrl()` у `connection.ts`: на `postgres` — прямий вхід `simetra_owner` з `devSecret("SIMETRA_OWNER_DEV_PASSWORD")` до бази `simetra`, без `options`; на `supabase` — `testDatabaseUrl()` (там власник і є роль входу). Теговані цілі й копії designer-а (`inTarget`, `withCopy`) — `withDatabaseName(testOwnerLoginUrl(), <база цілі чи копії>)` з `@supabase/pg-delta`, не база `simetra`; власник цілі (`inTarget` — роль рушія з адреси тестів) і копії (`withCopy`, задача 4) — `simetra_owner`, тож `CONNECT` у нього є. Місця в коді: `maintenanceSql` гарда прав (`compiler/rights/guard-units.ts`; споживачі — `insert` у `rights-seed.ts`, `seedUnderMaintenance` designer, `rights-maintenance`, `rights-last-full-access`, `tenant-creation`); `DATA_GUARD_FACTS_SQL` (`designer/src/io/data.ts`, `rolsuper` і членства `session_user`); `MEMBER` у `server/runtime.ts` (`pg_has_role(session_user, …)`: на адресі тестів суперкористувач — член усього, і відмова `command.read-role-missing` не настане). Тест на цьому DSN не потребує `SET ROLE` за членством; кейс, якому потрібне і те, і те, розщеплюється. **Засів під режимом обслуговування в тій самій відкочуваній транзакції** (`insert` з `rights-seed.ts` поряд із `queryAs`/`commandAs`; кандидати — `access`, `catalog-command`, `catalog-command-admin`, `catalog-command-rights`, `command-grants`, `rights-analysis`, `rights-functions`, `rights-guards`, `rights-plan-gate`, `rights-policies`, `rights-sources`, `rights-write`, `snake-case`, `tenant-creation`; точний перелік — інвентар задачі 2) іде через `asSessionLogin(client, PROVIDER_OWNER_ROLES[testProvider()], fn)` на тому самому з'єднанні (рішення архітекторки): `SET LOCAL SESSION AUTHORIZATION` дає `session_user = current_user = simetra_owner` для гарда, а авторизація закінчується з транзакцією, навіть якщо відновлення пропущено. Так само designer `seedUnderMaintenance` (`support/db.ts`): у транзакції `committed` увесь засів — `set_config` режиму, `steps`, `SET CONSTRAINTS ALL IMMEDIATE`, вимкнення — іде всередині `asSessionLogin(owner, PROVIDER_OWNER_ROLES[testProvider()], …)`; `signUp` у `steps` (`seedRuntimeActor`, `seedOrg` → `addPeople` у `rights-admin-commands.support.ts`) сам виходить до суперкористувача входу й повертає стан викликача (Р1), тож розщеплювати ці помічники не треба. На `supabase` `asSessionLogin` з власником — без змін поведінки (власник і є роль входу) | §10.3 «адреси» — запобіжник (iv) і перелік місць (задача 0) |
| Р17 | **`signUp` у тегованих цілях designer-а** (рішення архітекторки). Ціль, якій потрібна ідентичність (`inTarget`, `withCopy`, `seedRuntimeActor`), дістає справжню міграцію Better Auth **до першого плану чи застосування, що посилається на ідентичність**; порядок у користувачах хелпера сталий: ціль без SQL ідентичності (`inTarget` з desired SQL без `better_auth`, чи `withCopy`) → `withTargetIdentity(url)` → план і застосування моделі з FK на `better_auth."user"` і тригером провізії → `signUp`. Хелпер у `support/db.ts` від суперкористувача дає `simetra_auth` `CONNECT` і схему `better_auth` з власником `simetra_auth` (`CREATE SCHEMA IF NOT EXISTS … AUTHORIZATION`; наявна схема іншого власника — помилка), потім кличе `prepareStackIdentity` задачі 9 ПГ-2a (`superuserUrl` — `asSuperuser(url)`, `authUrl` — `loginUrl(url, "simetra_auth", devSecret("SIMETRA_AUTH_DEV_PASSWORD"))`, `owner` — `PROVIDER_OWNER_ROLES.postgres`): міграція від `simetra_auth`, перевірка, що `better_auth."user"` — таблиця `simetra_auth`, і тимчасові гранти `USAGE`/`TRIGGER` власнику, які тест задачі 10 ПГ-2a на цілі ставить від суперкористувача; так ціль має той самий стан, що й `simetra` після `db:pg:start`, а засів тіні плану бере `better_auth."user"` з фактів цілі (Р2 ПГ-2a). Наявна `better_auth."user"` іншого власника — заглушка, яку pg-delta створила від ролі рушія, коли desired SQL цілі вже посилався на ідентичність, — лишається помилкою налаштування тесту: хелпер перевіряє власника до міграції й кидає `better_auth."user" of <база> is owned by <роль>, not simetra_auth`; він не вставляє в неї і не перевласнює її | немає |

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
   рушія; і успіх, і збій усередині `asStackSuperuser`, `asSessionLogin` і
   `signUp` повертають власника й попередній `search_path`; guard і
   `afterEach` ловлять дрейф (Р15); жоден тест не губить `-c role=`
   (`withSessionOptions`, `loginUrl`); приріст лічильника обходу має
   причину. Тести — задача 3; звіти задач 7–13.
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
  чотири запобіжники моделі: (i) роль власника — стартовий параметр кожного
  з'єднання, `withSessionOptions` і `loginUrl`; (ii) явне відновлення ролі
  й `search_path` в `asStackSuperuser`; (iii) перевірка дрейфу — guard на
  старті, `afterEach`, статичний тест (Р15); (iv) код, що вимагає
  `session_user = current_user`, — на окремому DSN `testOwnerLoginUrl()`, з
  переліком місць Р16; «знімок стека» — Р3), §10.5 (проєкт `db` на
  `postgres` без форми «до ПГ-2»; до переліку `db-supabase` — лише
  публікація `supabase_realtime` і схеми провайдера в кейсах корпусу рушія,
  Р8; решта корпусу конвертується), §10.6 (Р12; абзац «До ПГ-2»
  прибрати), §10.7 (рядки `test:db:pg` і `test:db` — стан після задачі 14;
  абзац про CI без двох «and» поспіль; речення «ПГ-1 вносить проміжний
  текст» прибрати). Рядок ПГ-3 §12 не правити: перенос тимчасових грантів у
  `roles` і тест гранту на тегованому кластері передано ПГ-3 (його задача 0).
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): профіль postgres — стан після ПГ-2`.

### Task 1: борг `scripts/db-stack.mjs`

**Files:** Modify `scripts/db-stack.mjs`, `scripts/db-stack.d.mts`,
`packages/simetra/test/db/stack-files.test.ts`,
`docker/postgres-stack/compose.yaml` (мітка `simetra.stack-files-hash` з
аргументу збірки), `packages/simetra/test/db/better-auth-cli.ts` (з 2a;
відмова поза замком), `packages/simetra/test/db/stack-guard.ts` (шлях замка)

**Interfaces:**
- Produces: `runChild(command, args, opts, spawnFn = spawn): Promise<number>` —
  шов тесту; `compose()`, кроки `garage*`, `psql`, `simetra roles` і
  `better-auth-cli.ts` (з 2a) ідуть через нього; `withStackLock(path, fn)`
  знімає замок лише після завершення `fn`;
  `stackFilesHash(): string` — `sha256` вмісту `docker/postgres-stack/**`,
  одне джерело і для аргументу збірки `SIMETRA_STACK_FILES_HASH` (мітка
  `simetra.stack-files-hash`), і для звірки; підкоманда
  `node scripts/db-stack.mjs files-hash postgres` друкує його (CI, задача 14).

- [ ] **Step 1: failing tests** (`stack-files.test.ts`, підставний `spawnFn`):
  `db-stack.mjs` не вживає `STACK_DIR`; дочірній процес стартує з
  `detached: true`; сигнал скрипту пересилається групі дочірнього рівно раз;
  дочірній, що ігнорує перший сигнал, тримає замок, доки живий; після межі —
  SIGKILL групи, потім замок знято; вузлові кроки з базою мають
  `PGAPPNAME=simetra_db_start` у середовищі, а аргументи кожного
  `compose exec … psql` — `-e PGAPPNAME=simetra_db_start`; `start` на
  запущеному стеку передає `--no-recreate`; хеш береться з
  `config --hash="*"` (підставний вивід — рядки `<сервіс> <хеш>`) і
  звіряється з міткою контейнера кожного сервісу; так само мітка
  `simetra.stack-files-hash`; розбіжність — відмова з текстом
  `stopping the stack is the owner's call`, жодного `up`; на запущеному
  стеку, як і з прапорцем `--no-build` (для CI), аргументи `up` без
  `--build`; шлях замка — `/tmp/<lockFile>` і в
  скрипті, і в guard незалежно від `TMPDIR`; `better-auth-cli.ts` без
  змінної замка — відмова; вивід `files-hash postgres` дорівнює аргументу
  збірки `SIMETRA_STACK_FILES_HASH`, який скрипт передає `up`, і значенню,
  з яким звіряє мітку.
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
  git grep -lE '"authenticated"|"anon"|\banon\b|service_role|authenticator|supabase_|auth\.users|auth\.uid|provider: "supabase"|PROVIDER_SCHEMAS\.supabase|owner postgres|ROLE postgres|to postgres\b|for role postgres|SESSION AUTHORIZATION|RESET ROLE|readRoleOf\("supabase"\)|session_user|RIGHTS_MAINTENANCE_SETTING|seedUnderMaintenance|"options"|options:|\.username =' \
    -- '*.db.test.ts' '*.support.ts' '**/fixtures/*.ts' 'packages/designer/src/__tests__/support/*.ts' 'packages/simetra/test/db/*.ts' 'packages/simetra/bench/*.ts'
  ```
  плюс кожен файл `git ls-files '*.db.test.ts' | grep -v '\.supabase\.db\.\|\.postgres\.db\.'`
  без збігу. Перевірка повноти: об'єднання переліків задач 7–13, наявних
  `*.supabase.db.test.ts`/`*.postgres.db.test.ts` і файлів
  `test/db/pgtap.db.test.ts`, `test/db/interrupt.db.test.ts` (уже в `db-pg`
  з 2a) дорівнює
  `git ls-files '*.db.test.ts'`; файл понад це — нова зміна `main`, до
  архітекторки.
- [ ] **Step 2:** таблиця у звіті: файл → `profile-neutral` |
  `supabase-bound` (пункт §10.5 чи Р8) | `split` (які кейси куди) → задача
  7–13; для кожного файла — що зачіпає (`GRANT … TO CURRENT_USER`,
  `CREATE ROLE`, `signUp`, claims з `role`, сервісна роль, фікстура з
  провайдером, пулер, `CONNECT`, літерал ролі `postgres`, форма скидання
  ролі, `options` чи `.username =` на адресі тестів, код Р16 і змішані
  кейси засіву Р16). Файл з літералом ролі `postgres` у SQL — `split`,
  `supabase-bound` чи перехід на `asStackSuperuser`/дані профілю з
  причиною; такий файл — тимчасовий виняток `role-switch.test.ts` (задача 3)
  до своєї задачі. Кожен файл має рівно одну задачу.
- [ ] **Step 3:** таблицю — архітекторці до задачі 7; файл, якого немає в
  переліках задач 7–13, — до архітекторки, не на вибір виконавця.

### Task 3: модель з'єднання тестів на `postgres`

Guard і прибиральник (Р2, Р15 (а)) змінюються в цьому ж коміті, до того як
`TEST_STACKS.postgres` націлиться на базу `simetra`: інакше `snapshot()` і
`DROP OWNED BY` працювали б з новою адресою по-старому.

**Files:**
- Modify: `packages/simetra/test/db/profile.ts` (`TEST_STACKS.postgres`, Р2;
  `devSecret`, `SUPERUSER_PRELUDE`),
  `packages/simetra/test/db/connection.ts`, `connection.test.ts`,
  `profile.test.ts`, `packages/simetra/test/db/pgtap.db.test.ts` (база
  `postgres` для базового стану), `packages/simetra/test/db/stack-guard.ts`
  (`assertStack`, `snapshot`, `stopRunBackends`, `leakMessage` за Р2;
  перевірка ролі адреси тестів, Р15 (а)), `packages/simetra/test/db/sweep.ts`
  (`DROP OWNED BY` в обох базах, `manualSweepSql`, Р2), `stack-guard.test.ts`,
  обидва `vitest.config.ts` (`setupFiles` проєкту `db-pg`, Р15 (б)),
  `packages/designer/src/__tests__/support/db-setup.ts` (`afterEach`, Р15 (б)),
  `packages/simetra/test/support.ts` (додати
  `export { testProvider } from "./db/profile"`; нові хелпери
  `connection.ts` уже йдуть через `export * from "./db/connection"`)
- Modify (форми скидання ролі → `restoreOwnerRole`): `RESET ROLE` у
  `packages/simetra/test/db/connection.ts` (`commandAs`, `commandSteps`),
  `packages/designer/src/__tests__/roles-tool.db.test.ts`,
  `rights-admin-commands.db.test.ts`, `packages/simetra/test/db/`
  `catalog-command-admin`, `rights-analysis`, `rights-sources`,
  `rights-write`, `subscriptions.supabase` (`*.db.test.ts`); у `rights-guards`
  і `command-grants` (`SET ROLE postgres`, `SET SESSION AUTHORIZATION …`) і в
  `packages/simetra/bench/rights.bench.db.ts` форми переписує задача, що
  володіє файлом (7 і 4), а до неї ці файли — винятки тесту з причиною
- Modify (`set_config($1, …)` → `setLocalSetting`; перелік —
  `git grep -lE 'set_config *\(\$1' -- packages` без `connection.ts`,
  `rights-seed.ts`, `pgtap.ts` і продового
  `src/schema/apply/rights-maintenance.ts`): designer `src/__tests__/`
  `catalog-command-concurrency`, `command-runtime`, `read-query`,
  `rights-admin-commands`, `rights-last-full-access` (`*.db.test.ts`) і
  `support/db.ts`; simetra `test/db/` `access`, `catalog-command-admin`,
  `catalog-command-rights`, `command-grants`, `rights-analysis`,
  `rights-guards`, `rights-plan-gate`, `rights-write`, `tenant-creation`
  (`*.db.test.ts`) і `bench/rights.bench.db.ts` — механічна заміна, SQL і
  порядок операторів ті самі
- Create: `packages/simetra/test/db/role-switch.test.ts`,
  `packages/simetra/test/db/db-setup.ts`,
  `packages/simetra/test/db/connection-model.postgres.db.test.ts`

**Interfaces:**
- Produces (`connection.ts`, `export`):
  - `async function asStackSuperuser<T>(client: pg.Client, fn: () => Promise<T>): Promise<T>`
    — лише в транзакції (інакше `Error`); `SAVEPOINT stack_superuser`,
    `SELECT current_user, current_setting('search_path')` (попередні
    значення), `SET LOCAL ROLE NONE`,
    `SET LOCAL search_path = pg_catalog, pg_temp`, `fn`; успіх —
    `SELECT set_config('role', $1, true), set_config('search_path', $2, true)`
    з попередніми значеннями, потім `RELEASE`; збій —
    `ROLLBACK TO SAVEPOINT stack_superuser` і повторний кидок; на
    `supabase` — та сама форма. JSDoc: у `fn` кожне ім'я кваліфіковане,
    `CREATE EXTENSION` — з `SCHEMA`;
  - `async function asSessionLogin<T>(client: pg.Client, login: string, fn: () => Promise<T>): Promise<T>`
    — та сама форма з `SET LOCAL SESSION AUTHORIZATION <login>` (лише
    `LOCAL`) замість `SET LOCAL ROLE NONE`; і успіх, і збій — явне
    `RESET SESSION AUTHORIZATION` і `SET LOCAL ROLE <попередня current_user>`
    (та `set_config` попереднього `search_path`), як в `asStackSuperuser`, а
    не роль власника: виклик у контексті ролі команд чи запиту інакше лишив
    би решту транзакції власнику з `BYPASSRLS`; на збої — після
    `ROLLBACK TO SAVEPOINT`;
  - `async function restoreOwnerRole(client: pg.Client): Promise<void>` —
    `RESET ROLE`: повертає стартову роль з'єднання — на адресі тестів
    власника, на `testSuperuserUrl()` суперкористувача, як і нинішній
    `RESET ROLE` (явний `SET ROLE <власник>` змінив би кейси, що йдуть від
    суперкористувача);
  - `async function superuserClient(database?: string): Promise<pg.Client>` —
    `testSuperuserUrl()` з базою `database`, першими операторами —
    `SUPERUSER_PRELUDE`;
  - `function loginUrl(base: string, user: string, password: string): string`
    — DSN ролі входу з адреси тестів без параметра `options`;
  - `function withSessionOptions(url: string, extra: string): string` —
    дописує `extra` до наявного `options` адреси (`-c role=` лишається);
    адреса з двома параметрами `options` — `Error`;
  - `function testOwnerLoginUrl(): string` — Р16, ліниво;
  - `async function setLocalSetting(client: pg.Client, name: SimetraSetting, value: string): Promise<void>`
    — `SELECT set_config($1, $2, true)`; `SimetraSetting` — об'єднання типів
    `SESSION_CLAIMS_SETTING`, `COMMAND_SETTING`, `RIGHTS_MAINTENANCE_SETTING`:
    перший аргумент `set_config` у тестах — лише названа константа;
  - `withRollback` — перевірки Р15 (б) перед і після `ROLLBACK`; хелпери,
    що відкривають клієнт чи пул, реєструють перевірку Р15 (б).
- Produces (`profile.ts`, `export`):
  - `function devSecret(name: string, path?: string): string` — ліниве
    читання змінної з `dev-secrets.env` (форма `garageAdminToken`, який
    переходить на нього); немає файла чи змінної — `Error` з іменем;
  - `const SUPERUSER_PRELUDE: readonly string[]` — `SET ROLE NONE`,
    `SET search_path = pg_catalog, pg_temp`; одне місце форми, яке беруть
    `superuserClient`, `stack-guard.ts` і `sweep.ts` (Р2).

- [ ] **Step 1: failing tests:**
  - unit `profile.test.ts` / `connection.test.ts`:
    `TEST_STACKS.postgres.databaseUrl` — база `simetra`, `options` з
    `role=` і `PROVIDER_OWNER_ROLES.postgres`; `superuserUrl` без
    `options`; імпорт `profile.ts` не читає `dev-secrets.env`; `loginUrl`
    прибирає `options`; `withSessionOptions` лишає `-c role=` і додає
    `extra`, а на адресі з двома параметрами `options` кидає;
    `testOwnerLoginUrl()` на `postgres` — роль `simetra_owner`,
    без `options`, на `supabase` — `testDatabaseUrl()`; `devSecret` —
    значення з підставного файла, `Error` з іменем без змінної й без файла;
    порядок операторів `asStackSuperuser`, `asSessionLogin` (відновлення
    попередньої `current_user`) і `setLocalSetting` — на підставному
    клієнті;
  - `stack-guard.test.ts` (підставні клієнти): `assertStack`, `snapshot`,
    `stopRunBackends` — у базі `postgres` з прелюдією; прибиральник робить
    `DROP OWNED BY` у `postgres` і в базі `testDatabaseUrl()`;
    `manualSweepSql` і `leakMessage` називають обидві; після `assertStack`
    адреса тестів з `current_user` ≠ власника чи з `rolsuper` — відмова
    `test database URL does not run as <owner>` до `snapshot`;
  - `role-switch.test.ts` (iii) сканує `packages/*/src`, `packages/*/test` і
    `packages/simetra/bench` (DB-тести, помічники, unit-тести й продовий
    код; без коментарів) **дозволеним переліком** (Global Constraints), а не
    переліком цілей. Збіг — будь-що з
    `/\b(re)?set\s+(local\s+|session\s+)?role\b/i`,
    `/session[\s_]+authorization/i` і `/set_config\s*\(/i`, крім дозволених
    форм: `SET LOCAL ROLE ${<ціль>}` з ціллю з `PLATFORM_ROLES`,
    `testRoleFor`, `PROVIDER_*`, `readRoleOf`, `testRoleName` чи сталою,
    оголошеною з них у тому самому файлі чи в імпортованому помічнику
    (`*.support.ts`, `support/`, `test/db/`) — як `REQUEST_ROLE` (лише у
    файлах тестів); `set_config(` (з
    `pg_catalog.` чи без) з першим аргументом — літералом з масиву
    `ALLOWED_SETTINGS` тесту (`statement_timeout`, `lock_timeout`,
    `idle_in_transaction_session_timeout`, `transaction_timeout`,
    `search_path`, `TimeZone`, `bytea_output`, `row_security`, `jit` і
    значення трьох названих констант) чи підстановкою
    `SESSION_CLAIMS_SETTING`, `COMMAND_SETTING`, `RIGHTS_MAINTENANCE_SETTING`
    (`${X}`, `'${X}'`, `${literal(X)}`, `${sqlLiteral(X)}`);
    `set_config($1` — лише в `connection.ts` і `rights-seed.ts`. Кожен
    виняток — рядок масиву з файлом, причиною й, для тимчасового, задачею,
    що його прибирає; виняток без збігу в своєму файлі — теж збій
    (застарілий). Постійні винятки (місця, які план сам вводить чи лишає):
    `connection.ts` (тіла `asStackSuperuser`, `asSessionLogin`,
    `restoreOwnerRole`, `superuserClient`, `asRole`, `commandAs`,
    `commandSteps`, `setLocalSetting`), `connection.test.ts` (порядок
    операторів хелперів), `SUPERUSER_PRELUDE` у `profile.ts` (прелюдії
    `stack-guard.ts` і `sweep.ts` беруть його звідти),
    `stack-guard.test.ts` (перевірки прелюдії), `auth.ts` (тіло `signUp`,
    Р1), `pgtap.ts` (заборонені форми як дані відхилення й маркер раннера
    `set_config($1`) і `pgtap.test.ts`, `role-switch.test.ts` сам,
    `packages/simetra/src/schema/apply/postgres-cluster.ts` (прелюдія
    `roles`, 2a), `packages/designer/src/schema-engine/apply-database.ts`
    (`ApplyDatabase.statement`, 2a), `packages/simetra/src/compiler/messages.ts`
    (текст діагностики), `packages/simetra/src/model/schemas/project.ts`
    (перелік заборонених налаштувань `role`, `session_authorization`);
    продовий SQL сервера й застосування з власних спек:
    `src/server/runtime.ts` (`SET LOCAL ROLE` ролі читання зі стану),
    `src/server/transaction.ts` (`SET LOCAL ROLE` ролі команд),
    `src/schema/apply/settings.ts` (`set_config(s.name` з переліку
    налаштувань), `src/schema/apply/function-checks.ts` (`set_config` з
    `proconfig`), `src/schema/apply/rights-maintenance.ts`
    (`MAINTENANCE_ON`, параметр — `RIGHTS_MAINTENANCE_SETTING`);
    unit-тести, де ці форми — очікуваний SQL чи дані перевірок компілятора
    чи `vet`: `compiler/__tests__/` `closed-forms`, `function-body`,
    `event-subscriptions`, `heads`, `stage-integrity`,
    `schema/apply/__tests__/execute.test.ts`, `server/__tests__/`
    `harness.ts`, `runtime.test.ts`, `read-runtime.test.ts`,
    `designer/src/schema-engine/__tests__/read-only.test.ts`;
    `execute-plan.supabase.db.test.ts` (`ALTER ROLE … SET role` ролі
    API_LOGIN — регресія Supabase), `subscriptions.supabase.db.test.ts`
    (`APP_ROLE`, `AUTH_SERVICE_ROLE` — ролі провайдера Supabase, §10.5). Тимчасові, до задачі-власника:
    `rights-guards.db.test.ts`, `command-grants.db.test.ts` (задача 7),
    `rights.bench.db.ts` (задача 4), `roles-tool.db.test.ts`
    (`SET LOCAL ROLE authenticated`, задача 12). Перед написанням —
    `git grep -niE "(re)?set +(local +|session +)?role|session[ _]+authorization|set_config *\(" -- packages`
    і звір кожного збігу поза коментарями з дозволеними формами й цим
    переліком; збіг, що не вкладається ні в те, ні в те, — до архітекторки.
    Той самий тест: у SQL файлів `db` (`*.db.test.ts` без `.supabase.` і
    `.postgres.`) немає літерала ролі `postgres`
    (`/\b(role|to|for\s+role)\s+"?postgres\b/i`); тимчасові винятки — файли
    зі збігом на момент коміту (задача 2 називає їх і задачу-власника серед
    7–13, яка свій рядок прибирає). І ще: у джерелах тестів поза
    `withSessionOptions` і `loginUrl` немає рядка `options=`, виклику
    `searchParams.*("options"`, `.username =` (поза `loginUrl` і похідною
    адресою пулера в `throughPoolerAs`, `support/db.ts`), ключа `options:`
    у конфігу `pg.Pool`/`pg.Client` поряд з `connectionString`;
    тимчасові винятки до задачі 4, яка їх переводить, — `command-port.db.test.ts`,
    `database-tools.db.test.ts`, `execute-plan.support.ts`,
    `execute-plan.supabase.db.test.ts`, `function-checks.db.test.ts`,
    `build-plan-provider.db.test.ts`, `withRuntimeLogin` у `support/db.ts`;
    `data-tools.db.test.ts` ставить `options` на `env.login`
    (роль входу без `-c role=`) — виняток з причиною;
  - `connection-model.postgres.db.test.ts` (у `db-pg`): (i) два з'єднання
    пулу `pg.Pool` з `testDatabaseUrl()`, утримані одночасно, і з'єднання
    `createApplyDatabase` рушія з тієї самої адреси — `current_user =
    simetra_owner`, `session_user` — суперкористувач; `current_user` без
    `rolsuper`, з `rolbypassrls` і `rolcreatedb`; (ii) `asStackSuperuser`:
    успішний `fn` (`CREATE ROLE <тегована>`) — далі `current_user =
    simetra_owner`, `search_path` попередній, таблиця `public` розв'язується
    без кваліфікації; `fn`, що кидає після `CREATE ROLE`, — те саме, ролі
    немає; виклик усередині `SET LOCAL ROLE simetra_command` повертає
    `simetra_command`; `CREATE EXTENSION … SCHEMA extensions` у `fn` ставить
    розширення в `extensions`; (ii′) `asSessionLogin` — успіх і збій
    (`fn`, що кидає) повертають `session_user` суперкористувача стека й
    `current_user = simetra_owner`; виклик усередині
    `SET LOCAL ROLE ${PLATFORM_ROLES.command}` повертає `simetra_command`;
    мутація — без відновлення тест
    червоний (результат — у звіт задачі); засів під режимом обслуговування
    через `asSessionLogin` з власником проходить гард `maintenanceSql`; (iii) `SET LOCAL ROLE simetra_command` і `simetra_user`
    від власника проходять без `GRANT … TO CURRENT_USER`; (iv) адреса через
    `withDatabaseName` pg-delta зберігає `options` — `current_user` тіні від
    рушія `simetra_owner`; (v) `withSessionOptions(testDatabaseUrl(), "-c bytea_output=escape")`
    — `current_user = simetra_owner` і `bytea_output = escape`; (vi)
    `testOwnerLoginUrl()` — `session_user = current_user = simetra_owner`;
    (vii) Р15 (б): `withRollback` із законною
    `SET LOCAL ROLE ${PLATFORM_ROLES.command}` до кінця транзакції — зелений;
    із суперкористувачем перед відкатом — червоний (підставний клієнт у
    `connection.test.ts`, без бази: форма скидання поза винятками
    `role-switch.test.ts` не пишеться); збій `fn` у перерваній транзакції дає
    першопричину, а не помилку перевірки; два конкурентні кейси
    (`it.concurrent`) з різними ролями не заважають один одному; клієнт
    хелпера, лишений тестом з `current_user` ≠ стартової ролі поза
    транзакцією, валить перевірку `onTestFinished` (підставний кейс у
    `connection.test.ts` на функції перевірки, без бази). Цілі
    `SET LOCAL ROLE` у файлі — з `PLATFORM_ROLES`, не літерали
    (`role-switch.test.ts`).
- [ ] **Step 2:** `pnpm --filter simetra test profile connection role-switch stack-guard` — FAIL.
- [ ] **Step 3:** реалізація. Якщо pg-delta губить `options` (iv) — до
  архітекторки з фактом, не обхід.
- [ ] **Step 4:** PASS; `pnpm --filter simetra test:db:pg` і
  `pnpm --filter @simetrajs/designer test:db:pg` — зелені (файли 2a);
  `pnpm --filter @simetrajs/designer test:db roles-tool rights-admin-commands catalog-command-concurrency command-runtime read-query rights-last-full-access`
  і `pnpm --filter simetra test:db catalog-command-admin rights-analysis rights-sources rights-write access catalog-command-rights command-grants rights-guards rights-plan-gate tenant-creation`
  на `supabase` — зелені; `pnpm --filter simetra test:db:supabase subscriptions`
  — зелений; `pnpm typecheck` (бенчмарк на `setLocalSetting`).
- [ ] **Step 5: Commit** — `test(db): тести стека postgres — суперкористувач із роллю власника на кожному з'єднанні`.

### Task 4: помічники ролей, `signUp`, провайдер фікстур, `support/db.ts`

**Files:**
- Modify: `packages/simetra/test/db/connection.ts` (`ApiRole` → `RolePurpose`,
  `asRole`, `queryAs`, `testRoleFor`, `claimsFor`), `packages/simetra/test/db/auth.ts`
  (`signUp`), `connection.test.ts`
- Modify — кожен викликач `asRole`/`queryAs`/`ApiRole` (звір
  `git grep -lE "\b(queryAs|asRole|ApiRole)\b" -- packages`):
  `packages/simetra/bench/rights.bench.db.ts` (і `RESET ROLE` →
  `restoreOwnerRole`; виняток тесту задачі 3 прибрати),
  `packages/simetra/src/schema/__tests__/reference-domain.db.test.ts`,
  `packages/simetra/test/db/{access,applied-snapshot-hash,catalog-command,membership,platform-users.supabase,rights-analysis,rights-functions,rights-guards,rights-plan-gate,rights-policies,rights-sources}.db.test.ts`,
  `packages/simetra/test/db/{closure-oracle,rights-seed}.ts`
- Modify (фікстури, Р7; параметр `provider = "supabase"`):
  `packages/simetra/src/compiler/__tests__/fixtures/rights.ts`
  (`defaults`, `singleTenantRights`),
  `packages/simetra/src/schema/__tests__/fixtures/e1-fixtures.ts`,
  `packages/designer/src/schema-engine/__tests__/fixtures/round-trip-classes.ts`,
  `packages/designer/src/schema-engine/__tests__/fixtures/engine-boundary.ts`;
  `kitchen-sink.ts` не змінюється (DB-споживача немає)
- Modify: `packages/designer/src/__tests__/support/db.ts` (`withCopy` —
  власник копії `PROVIDER_OWNER_ROLES[testProvider()]`; `withRuntimeLogin` —
  `loginUrl` і `GRANT CONNECT ON DATABASE <база адреси>` тегованій ролі від
  суперкористувача; `poolerPoolOf` — `false` на профілі без пулера;
  суперкористувач — через `superuserClient`; `withTargetIdentity`, Р17;
  `seedUnderMaintenance` — засів усередині `asSessionLogin` з власником,
  Р16; клієнти й пули — під перевірку Р15 (б))
- Modify (адреси ролей входу й сесійні налаштування — `loginUrl`,
  `withSessionOptions`; Global Constraints): `loginAs` у
  `packages/designer/src/schema-engine/__tests__/execute-plan.support.ts`,
  `function-checks.db.test.ts` (`NOUSAGE`), `build-plan-provider.db.test.ts`
  (`COPIER`), `execute-plan.supabase.db.test.ts` (`API_LOGIN`),
  `packages/designer/src/__tests__/database-tools.db.test.ts` (вхід `USER` —
  `loginUrl`; кейс «no pool is left open» — `withSessionOptions(url, "-c statement_timeout=1")`
  замість `searchParams.set("options", …)`, що лишав рушій і CLI
  суперкористувачем), `packages/simetra/test/db/command-port.db.test.ts`
  (пул — `connectionString: withSessionOptions(testDatabaseUrl(), SESSION)`
  без ключа `options`, бо адреса перекриває конфіг `pg`)
- Create: `packages/simetra/test/db/skip-boundary.test.ts`,
  `packages/simetra/test/db/auth.postgres.db.test.ts`,
  `packages/designer/src/__tests__/target-identity.postgres.db.test.ts`

**Interfaces:**
- Produces:
  - `type RolePurpose = "user" | "anonymous" | "service"`;
    `asRole(client, purpose, claims)`, `queryAs(client, purpose, claims, sql, params?)`
    — ім'я ролі з `PROVIDER_API_ROLES[testProvider()]`; призначення без ролі —
    `Error` `no <purpose> role in <provider> profile`; після `SET LOCAL ROLE`
    `asRole` окремим запитом звіряє `current_user = <роль>` і кидає на
    розбіжності: поза транзакцією `SET LOCAL` — лише `WARNING`, і запит
    тихо пішов би від власника з `BYPASSRLS`;
  - `function testRoleFor(purpose: RolePurpose): string | null`;
  - `function claimsFor(purpose: RolePurpose, sub?: string): Record<string, unknown>`
    — `supabase`: з `role` (ім'я ролі); `postgres`: без `role`, з `sub` і
    `is_anonymous` (§4.4);
  - `signUp(client, account)` — `supabase`: `auth.users` як зараз;
    `postgres`: роль — єдиний елемент `PROVIDER_LOGIN_ROLES.postgres`
    (масив `readonly string[]`; довжина ≠ 1 — `Error`); завжди
    перемикається зі стану викликача й повертає його (Р1): у точці
    збереження читає `session_user` і `current_user`,
    `SET LOCAL SESSION AUTHORIZATION DEFAULT`, `SET LOCAL ROLE <роль>`,
    `INSERT INTO better_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "isAnonymous")`
    (таблиця — з `PROVIDER_IDENTITY_SOURCES.postgres`), `name` = email;
    успіх — `SET LOCAL SESSION AUTHORIZATION <попередній session_user>` і
    `SET LOCAL ROLE <попередня current_user>` до `RELEASE`; збій —
    `ROLLBACK TO SAVEPOINT`, ті самі два оператори й повторний кидок; так
    `signUp` працює й усередині `asSessionLogin(власник)` (`seedRuntimeActor`,
    `seedOrg`, `addPeople` під `seedUnderMaintenance`); `email: null`, `phone`, `meta` на
    `postgres` — `Error` з іменем поля (`email` у Better Auth `NOT NULL`;
    аналога `phone` і `meta` немає);
  - `async function withTargetIdentity(url: string): Promise<void>` (designer
    `support/db.ts`, Р17) — на `supabase` нічого не робить.

- [ ] **Step 1: failing tests:** unit — `testRoleFor` і `claimsFor` для обох
  профілів за `PROVIDER_API_ROLES`; `asRole(…, "service")` на `postgres`
  кидає `no service role`; `signUp` на `postgres` з `email: null`, `phone`,
  `meta` — `Error` з іменем поля; порядок операторів `signUp` і звірка
  `asRole` — на підставному клієнті; `skip-boundary.test.ts` — у файлах `db`
  (`*.db.test.ts` без `.supabase.` і `.postgres.`) немає `.skip`, `.todo`,
  `skipIf(`/`runIf(` (`it`, `test`, `describe`) з умовою, що читає профіль
  (`testProvider`, `testRoleFor`, `PROVIDER_`, `TEST_STACKS`, `provider`),
  порівняння `testRoleFor(…)` з `null` і раннього `return` за ним; `runIf`
  за параметром таблиці кейсів (`execute-plan` — `mode`, `access` —
  `schema`) дозволено; виняток з причиною — `pgtap.db.test.ts` (`it.skip`
  «none here» на стеку `supabase`, де базовий стан перевіряє
  `supabase test db`); виняток без збігу — збій; `fixtures` — без аргументу провайдер
  `supabase`, з `"postgres"` — літерали профілю `postgres`; DB
  `auth.postgres.db.test.ts` — `signUp` повертає uuid, рядок
  `better_auth."user"` вставлено від `simetra_auth` (тригер провізії бачить
  `current_user = simetra_auth`); після успіху й після збою (дубль email)
  `current_user = simetra_owner` і `search_path` попередній; `signUp`
  усередині `asSessionLogin(client, PROVIDER_OWNER_ROLES.postgres, …)`
  повертається з `session_user = current_user = simetra_owner` і на успіху,
  і на збої, а засів під режимом обслуговування після нього проходить гард
  `maintenanceSql`;
  `target-identity.postgres.db.test.ts` — у сталому порядку Р17: ціль
  `inTarget` з desired SQL без `better_auth` → `withTargetIdentity` →
  план і застосування моделі з FK на `better_auth."user"` і тригером
  провізії → `signUp` проходить, власник `better_auth."user"` —
  `simetra_auth`; те саме на `withCopy` цієї цілі; ціль, чий desired SQL уже
  посилається на ідентичність (заглушка від ролі рушія), —
  `withTargetIdentity` кидає `is owned by <роль>, not simetra_auth` до
  міграції; `seedRuntimeActor` на цілі після `withTargetIdentity` проходить
  гард прав; з'єднання з `withDatabaseName(testOwnerLoginUrl(), <база цілі>)`
  — `session_user = current_user = simetra_owner`; `command-port.db.test.ts` — перед роботою ядра
  `current_setting('bytea_output') = 'escape'` і `TimeZone = Asia/Tokyo` на
  сесії пулу: без `SESSION` кейс падає (перевір, прибравши аргумент).
- [ ] **Step 2:** `pnpm --filter simetra test connection auth skip-boundary` — FAIL.
- [ ] **Step 3:** реалізація; виклики переходять на призначення
  (`authenticated` → `user`, `anon` → `anonymous`, `service_role` →
  `service`) і `claimsFor` у тій самій зміні, без аліасів; на `supabase` SQL
  тестів не змінюється.
- [ ] **Step 4:** PASS; `pnpm typecheck` (бенчмарк типізується);
  scoped DB на Supabase `pnpm --filter simetra test:db access membership rights-sources`,
  `pnpm --filter simetra test:db:supabase platform-users` і
  `pnpm --filter @simetrajs/designer test:db data-tools roles-tool database-tools function-checks build-plan-provider execute-plan`,
  `pnpm --filter @simetrajs/designer test:db:supabase execute-plan`,
  `pnpm --filter simetra test:db command-port` — зелені;
  `pnpm --filter simetra test:db:pg auth` і
  `pnpm --filter @simetrajs/designer test:db:pg target-identity` — зелені.
- [ ] **Step 5: Commit** — `test(db): ролі запиту, ідентичність і провайдер фікстур — з даних профілю`.

### Task 5: guard, прибиральник і DB-проєкти

**Files:**
- Modify: `packages/simetra/test/db/stack-guard.ts` (Р3; рядок старту після
  `assertStack`; Р2 і Р15 (а) — уже в задачі 3), `stack-guard.test.ts`,
  `packages/simetra/test/db/external.test.ts`,
  обидва `vitest.config.ts` (`ON_POSTGRES` — порожній перелік, Р6;
  `db-supabase` simetra включає `test/db/interrupt.db.test.ts`, Р9, і `db`
  його тим самим комітом виключає — інакше файл іде двічі за `test:db`),
  `packages/*/package.json` (`--passWithNoTests` прибрати)
- Create: `packages/simetra/test/db/identity-state.postgres.db.test.ts`

- [ ] **Step 1: failing tests:** `stack-guard.test.ts` (підставні клієнти):
  звірка `better_auth."user"` стоїть після `assertStack` і до `snapshot`;
  відбиток `better_auth`, що змінився за прогін (підставний грант
  `UPDATE`), — збій `the run changed better_auth`; абсолютна звірка на
  старті — зайвий отримувач у `relacl`, інший власник відношення, рядок
  `pg_default_acl` схеми, вимкнений тригер на `better_auth."user"` — кожен
  дає відмову `not in the db:pg:start state` до `snapshot`;
  бракує колонки — відмова з `pnpm db:pg:start`; зайва колонка — відмова з
  `owner's call`; замок свого pid — відмова «one DB project per vitest
  process»; рядок старту — після `assertStack`; кожен DB-проєкт кожного пакета має хоча б
  один файл (Review Focus 5); `db` виключає кожен файл `ON_POSTGRES`, `db-pg`
  його включає; `interrupt.db.test.ts` — рівно в одному проєкті стека
  `supabase`; `external.test.ts` — завислий `docker exec` у
  `runContainers` дає помилку до дедлайну; `identity-state.postgres.db.test.ts`
  — звірка Р3 (відносна й абсолютна) на справжній `simetra` проходить.
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
  (`role=user claims={"sub":"<сталий uuid>"}`) — лише видиме в копії
  шаблону: `plpgsql_check` є, `better_auth` немає,
  `current_user = simetra_user`, і `sub` з
  `current_setting(<SESSION_CLAIMS_SETTING>)` дорівнює заголовку — так
  claims раннера перевірено наскрізно, а не лише порядком операторів
  (§10.5). Кластерні факти
  лишаються в наборі базового стану 2a.
- [ ] **Step 2:** `pnpm --filter simetra test pgtap` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS; `pnpm --filter simetra test:db:pg pgtap` — зелений;
  тегованих баз після прогону немає.
- [ ] **Step 5: Commit** — `test(db): раннер pgTAP з тегованою базою, роллю й claims; набір ролі запиту`.

### Tasks 7–13: перенос DB-файлів на стек `postgres` за підсистемами

Одна задача — один коміт. Файли — з таблиці задачі 2. Змішані кейси засіву
під режимом обслуговування — через `asSessionLogin` з власником (Р16).
Кроки кожної:

- [ ] **Step 1:** переліки «до» за Global Constraints (`db` і `db-supabase`
  з `SIMETRA_TEST_PROVIDER=supabase`, `db-pg` з `postgres`) і
  `git grep -c` суперкористувача → scratchpad.
- [ ] **Step 2:** кожен файл задачі за інвентарем:
  - `profile-neutral` — у `ON_POSTGRES` свого пакета; літерали Supabase — на
    дані профілю (`testRoleFor`, `claimsFor`, `PROVIDER_*[testProvider()]`,
    `signUp`, фікстури з `testProvider()`); `GRANT simetra_command TO CURRENT_USER`
    прибрати; `CREATE ROLE`, `CREATE EXTENSION` від власника — через
    `asStackSuperuser` (у `fn` імена кваліфіковані, `CREATE EXTENSION` — з
    `SCHEMA`); суперкористувач `supabase_admin` → `superuserClient`; літерал
    ролі `postgres` у SQL (`ROLE postgres`, `to postgres`,
    `for role postgres`) — `PROVIDER_OWNER_ROLES[testProvider()]`, бо на
    стеку `postgres` це суперкористувач (рядок файла у винятках
    `role-switch.test.ts` прибрати); кейс Р16 — на `testOwnerLoginUrl()`,
    на тегованій цілі чи копії designer-а — на
    `withDatabaseName(testOwnerLoginUrl(), <база>)`; ціль designer-а з
    `signUp` — у сталому порядку Р17: ціль без SQL ідентичності →
    `withTargetIdentity` → план і застосування → `signUp`; цілі
    `SET LOCAL ROLE` — з дозволених джерел (літерал `authenticated` →
    `testRoleFor("user")`);
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
  (`GRANT EXECUTE … TO <testRoleFor("user")>`). У `rights-guards` (`probe`,
  кейси `api_login`) і `command-grants` (`runtime login role`)
  `SET SESSION AUTHORIZATION <login>` → `asSessionLogin`, `SET ROLE postgres`
  → `asStackSuperuser` чи роль власника профілю, логін `"postgres"` — роль
  власника профілю; винятки цих файлів у `role-switch.test.ts` прибрати.
- **Task 8 — simetra, каталог і команди:** `test/db/` `catalog-command`,
  `catalog-command-admin`, `catalog-command-rights`, `catalog-functions`,
  `command-port`, `applied-snapshot-hash`, `tenant-creation`, `snake-case`,
  `unique-within`, `value-checks`, `builtin-functions`, `mechanics`,
  `carrier-backfill`, `promote-rewrite`; помічник `catalog.ts`.
- **Task 9 — simetra, схема й стек:** `src/schema/__tests__/` `deploy`,
  `paper-test`, `reference-domain`; `test/db/stack.db.test.ts`. `interrupt` і
  `pgtap` уже в `db-pg` з 2a.
- **Task 10 — designer, корпус рушія:** `src/schema-engine/__tests__/`
  `promotion-equivalence`, `fingerprint-coverage` (Р8 — конвертація,
  `scope.provider` з `testProvider()`), `engine-census`, `engine-extract`,
  `round-trip` (Р8 — `split`: кейси з `supabase_realtime`, ролями
  провайдера в SQL чи `PROVIDER_SCHEMAS.supabase` — у
  `*.supabase.db.test.ts`, решта на дані профілю), `engine-desired`,
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
  `rights-maintenance`, `carrier-locks` (блокування тригерів копій носіїв,
  дві сесії на цілі `inTarget`); помічники `command-runtime.support.ts`,
  `tenant-creation.support.ts`, `rights-admin-commands.support.ts`
  (`REQUEST_ROLE` — `readRoleOf(testProvider())`; `heldEnv`, `heldLogin`,
  `poolerPoolOf` — `viaPooler` `false` на `postgres`),
  `rights-maintenance.support.ts`; `heldTargets` закриває A, B, C через
  `Promise.allSettled`; прямий пул закривається, коли `poolerPoolOf` кидає.

### Task 14: перемикання — `db` на `postgres` і CI одним комітом

Перемикання й CI — один коміт (Р6): CI старого вигляду на новій розкладці
проєктів червоний (матриця `db` кличе `test:db` пакета, що вже йде на
`postgres`, проти стека Supabase).

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
  `test:db` = `supabase test db && pnpm --filter simetra test:db:supabase && pnpm --filter @simetrajs/designer test:db:supabase`),
  `.github/workflows/ci.yml`

- [ ] **Step 1:** переліки «до» трьох проєктів за Global Constraints.
- [ ] **Step 2: failing tests:** `testProvider()` без змінної — `postgres`;
  перелік DB-проєктів — `db`, `db-supabase`, `bench`; `db` — guard `postgres`.
- [ ] **Step 3:** `pnpm --filter simetra test profile stack-guard` — FAIL; реалізація; PASS.
- [ ] **Step 4:** CI (`.github/workflows/ci.yml`):
  - job `db` — стек `postgres`: старт `pnpm db:pg:start` з трьома спробами
    й `node scripts/db-stack.mjs stop postgres --volumes || true` між ними
    (коментар повторів — з наявного job-а); `timeout-minutes` — як у
    наявного `db`; образ Postgres — `docker/build-push-action` з
    `load: true`, `tags: simetra-pg/postgres:17.11`, `cache-from: type=gha`,
    `cache-to: type=gha,mode=max` і
    `build-args: SIMETRA_STACK_FILES_HASH=<вивід node scripts/db-stack.mjs files-hash postgres>`
    (крок перед збіркою пише його в `$GITHUB_OUTPUT`; без нього мітка
    `simetra.stack-files-hash` порожня, і другий `db:pg:start` відмовить)
    до старту, а старт — `pnpm db:pg:start --no-build`
    (прапорець задачі 1), бо інакше compose збирає власним builder-ом мимо
    кешу; матриця: `postgres base state + simetra`
    (`pnpm db:pg:start` другий раз — код 0, потім
    `pnpm --filter simetra test:db`), `designer 1/4`…`4/4`
    (`pnpm --filter @simetrajs/designer test:db --shard=N/4`);
  - job `db-supabase` — стек Supabase (наявний старт із трьома спробами й
    коментарем), власний `timeout-minutes`; матриця за Р12:
    `provider + simetra` (`pnpm exec supabase test db && pnpm --filter simetra test:db:supabase`),
    `designer 1/2`, `2/2` (`pnpm --filter @simetrajs/designer test:db:supabase --shard=N/2`);
  - job `db-postgres` і коментар про нього в job-і `db` прибрати;
  - `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` — без помилки.
- [ ] **Step 5:** переліки «після»: назви `db` = об'єднання «до» `db-pg` і
  `db`; `db-supabase` — без змін.
- [ ] **Step 6:** `pnpm --filter simetra test` і
  `pnpm --filter @simetrajs/designer test` — зелені (unit-набори читають
  типовий профіль); `pnpm test:db:pg` (повний, `postgres`) — зелений, рядок
  старту `on postgres stack`; `pnpm --filter simetra test:db:supabase` і
  `pnpm --filter @simetrajs/designer test:db:supabase` — зелені.
- [ ] **Step 7: Commit** — `test(db): проєкт db і CI — на стеку postgres, окремий job db-supabase`.

### Task 15: CI після push

**Files:** —

- [ ] **Step 1:** після push архітекторкою (уперше — після задачі 14) усі
  jobs зелені; тривалість кожного рядка `db` і `db-supabase` — у звіт.
  Червоний рядок — до архітекторки з логом, не правка «навмання».

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
