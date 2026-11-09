# ПГ-5 — сховище файлів: план реалізації (ескіз)

> **Статус:** проєкт плану, 2026-11-09; приймає архітекторка `simetra-87`.
> Блок ПГ-5 спеки профілю `postgres`. Форма — ескіз: рішення, інтерфейси,
> інваріанти, задачі з «готово». Тест-кейси, імена й дрібні кроки виконавець
> пише сам за кодом.
> **Частини.** **А** (задачі 0–6) — T0, T1/T2, T3, тест-інфра; стартує після
> мерджу ПГ-3 (а з ним ПГ-2a/2b: проєкт `db` на стеку `postgres`). **Б**
> (задачі 7–8) — endpoint-и й звірка в шаблоні host-а; стартує після мерджу
> зрізу П4-D (`2026-11-08-p4-d-slice.md`) і частини А.
> **Перед стартом кожної частини:** `.agents/skills/codebase-research/scripts/orient --plan <цей файл>`.
> Якорі «після ПГ-2b/ПГ-3»: `asRole`, `queryAs`, `claimsFor`, `signUp`,
> `testAuth`, `withRuntimeLogin`, `withCopy`, `PROVIDER_OWNER_ROLES`.
> Якорі «після П4-D»: `template/src/server/runtime.ts`, `origin.ts`,
> `auth.ts` (`verifySession`), `body-limit.ts`, лінт шаблону, експорт
> `checkRequestOrigin` з `simetra/server`. Якщо в коді інше ім'я — перейменуй
> у плані. Якщо інша поведінка — звертайся до архітекторки.
> **Спільні стеки.** Виконавець ніколи не виконує `pnpm db:stop`,
> `pnpm db:start`, `pnpm db:pg:stop` чи `supabase stop` і не змінює
> `supabase/config.toml`. DB-тести запускає лише через
> `pnpm --filter … test:db*` під замками. Повний `pnpm test:db:pg` і
> `pnpm test:db` — раз на частину, перед фінальною перевіркою.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** файл — рядок довідника з властивістю `storage`, байти — за портом
`FileStore` в обох профілях. Облік і межа обсягу ведуться в транзакції
запису. Байти доступні лише через серверні endpoint-и після читання рядка під
RLS. Сироти прибирає звірка.

**Architecture:** T0 — властивість `storage` і стандартні реквізити файлу в
реєстрі видів. T1 — SQL-юніти: таблиці обліку, definer-функції, тригери
обліку й завершеності. T3 — порт `FileStore`, адаптер `fromS3Client`, методи
рантайму. Тест-інфра — S3-помічник і спорожнення бакета тегу. Шаблон host-а
(частина Б) — три маршрути й скрипт звірки. T3 не імпортує SDK: клієнт S3
читається структурно, як `fromPgPool`.

**Tech Stack:** TypeScript 7, Zod, Vitest, Postgres 17 (стек `simetra-pg`),
Garage `v2.5.0`, Supabase CLI `2.122.1` (S3-протокол Storage),
`@aws-sdk/client-s3` `3.1157.0` (Apache-2.0). Він лише devDependency
`simetra` і `@simetrajs/designer`, а в шаблоні — залежність.

**Spec:** [спека профілю `postgres`](../specs/2026-11-08-postgres-profile-design.md)
§8, §10.3, §12 (рядок ПГ-5); [спека профілів провайдера](../specs/2026-10-23-provider-profiles-design.md)
ПП4; [спека П4](../specs/2026-10-26-p4-runtime-design.md) Рт1, Рт6, Рт19,
§6.5 (`afterCommit`); платформна спека Р32, §6.8. Правила тестів — скіл
`writing-tests`.

## Global Constraints

- Коментарі пишуться українською й пояснюють «чому». Діагностики,
  `CommandError` і JSDoc експорту — англійською. Коміти — Conventional
  Commits з українським описом, без трейлерів.
- T3 (`src/server`) не імпортує S3 SDK. Це тримає наявна зона
  `eslint.tier-zones.js`. `ReadableStream` і `AsyncIterable` — глобальні.
- Ключ об'єкта — `o/<UUID об'єкта каталогу>/<id рядка>`. Він виводиться й
  ніде не зберігається. Id рядка генерує сервер.
- Розмір і тип вмісту ставить лише тригер вкладення із запису
  `simetra.file_attach` (Р4). Їх немає в колонках команд `simetra_command`.
- `file_attach`, `storage_headroom`, `storage_rows_exist` і `storage_row_page`
  не потрапляють у `PLATFORM_READ_FUNCTIONS`. Тоді наявне правило
  `sql.platform-function-call` забороняє їх у SQL застосунку без нового коду.
- Межа відповіді на «немає» і «не можна» — той самий 404. Відмова
  завантаження настає до першого байта в бакеті.
- `project.storageBuckets` (Storage-API прийнятих баз, ПП4) не змінюється.
  Нова властивість — окремий механізм.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Бекенд байтів у `supabase`** — `fromS3Client` над S3-протоколом Supabase Storage (`/storage/v1/s3`), приватний бакет. SQL-частина (рядок, облік, межа, функції) нейтральна до профілю. Прийняті бази лишаються на Storage-API з політиками. Перевірено: CLI `2.122.1` з `[storage.s3_protocol] enabled = true` віддає `STORAGE_S3_URL` і `S3_PROTOCOL_ACCESS_KEY_*` у `supabase status -o env`, тож конфіг стека не змінюється (рішення архітекторки, варіант 1). **Відхилення:** S3-ключ Supabase діє на весь проєкт і обходить політики Storage, тож вимога §8.2 «ключ лише цього бакета» в `supabase` не виконується. Ключ лишається тільки на сервері, а звірка обмежена префіксом | ПП4, §8.2, §8.4: бекенд і межа ключа в `supabase` (задача 0) |
| Р2 | **Частини А/Б.** Endpoint-и й звірка в шаблоні — після П4-D, бо в зрізі П4-D файлових маршрутів немає | немає |
| Р3 | **Попередня перевірка — одна definer-функція.** `storage_headroom(p_object, p_scope)` повертає `false`, коли немає права `create` у скоупі, коли скоуп не користувача, коли об'єкт без `storage` або коли файл розміру `maxBytes` не вміститься. Одне булеве значення не розкриває, яка умова відмовила. `checkUpload` для гостя чи аноніма повертає `null`, не виконуючи SQL | §8.2 крок 2 (задача 0) |
| Р4 | **Розмір і тип пишуться в `INSERT`, а не в `UPDATE`.** `file_attach(p_object, p_id, p_size, p_type)` перевіряє тип і розмір проти `storage` об'єкта й записує очікуване вкладення в `simetra.storage_pending` з ключем (`pg_current_xact_id()`, об'єкт, id). Ключ запису унікальний, повторний `file_attach` для того самого id відмовляє. Тригер `BEFORE INSERT` (definer) забирає запис атомарно (`DELETE … RETURNING`) і ставить колонки; без запису — одразу `storage.attach-missing`. `attachFile` після `create` перевіряє, що записів поточної транзакції не лишилось; записи чужих `xact` прибирає звірка. Причина: `UPDATE` після `create` піднімав би версію, запускав би тригери прав і змісту, переносив би облік на `UPDATE`, а відкладений тригер падав би на `COMMIT` поза мапінгом помилок. Перевірка `xmin` і стан «уже записано» зникають: інший шлях вставки колонок не має. Копіювання й `dataFn create` без `attachFile` відмовляють | §8.1, §8.2 крок 4, §8.3 (задача 0) |
| Р5 | **Байти видаляє рантайм.** Опція `createCommandRuntime({ files?: FileStore })`. Ключі беруться лише з `DELETE … RETURNING id` закоміченої спроби, бо список `afterCommit` належить спробі, а не команді. Шлях — `dataFn` чи `ctx.run`, будь-який. `markDeletion` байтів не чіпає. Каскадне видалення (власник, скоуп) і робота без опції лишаються звірці | §8.2 «Видалення» (задача 0) |
| Р6 | **Методи T3:** `checkUpload` (крок 2), `attachFile` (крок 4), `reconcileFiles`. `checkUpload` — третій метод: у endpoint-а немає SQL (лінт шаблону). `attachFile` мапить ім'я в стильований логічний `file_name` (`naming.attributeCase`). Результат розрізняє «відкат» і «результат коміту невідомий» (`command.unavailable` після надісланого `COMMIT`) | §8.4 (задача 0) |
| Р7 | **`fromS3Client` працює над структурним клієнтом з методами** `putObject`, `getObject`, `deleteObject`, `listObjectsV2` (форма агрегатного `S3` з `@aws-sdk/client-s3`). `put` сам рахує байти, обриває потік понад `maxBytes` і буферизує тіло, щоб передати `ContentLength`. Пам'ять обмежує стеля T0 `STORAGE_MAX_BYTES` = 100 MiB. Розмір у `file_attach` — лише результат `put`, а не `Content-Length` | §8.1, §8.4 (задача 0) |
| Р8 | **Стандартні реквізити файлу** мають фізичні імена `file_name` (`text`, not null, зміст), `file_size` (`bigint`) і `file_content_type` (`text`). Логічні імена — за `standardLogicalName`. Останні дві колонки: у `platformWrittenNames`, поза колонками змісту `mechanics-units.ts`, незмінні після вставки (тригер `BEFORE UPDATE OF` відмовляє) | немає |
| Р9 | **Сумісність `storage`:** лише `Catalog`, без `role`, `membership`, `rightsContainer`, `predefinedItems` і `hierarchyType: "FoldersAndItems"`; правило T0 `storage.incompatible`. `mediaTypes` — непорожній перелік унікальних `type/subtype` малими літерами без параметрів (`storage.media-type`). `maxBytes` — у межах 1…`STORAGE_MAX_BYTES`. Якщо `storage` додано наявному об'єкту з рядками, план відмовляє (`plan.storage-added`): облік і байти старих рядків не чесні | §8.1 (задача 0) |
| Р10 | **Рядки без байтів** звірка знаходить через `storage_row_page(p_object, p_after uuid) RETURNS SETOF uuid` (definer, до 1000 id). Рядок, що з'явився після початку переліку, не вважається дефектом | §8.2 «Звірка» (задача 0) |
| Р11 | **Помилки сховища — у закритому переліку.** SQL-відмови (`storage.attach-missing`, `storage.attach-invalid`, `storage.quota-exceeded`) мапляться на `command.rejected` з `reason` у `LIMIT_REASONS`-подібному переліку, а не на `command.internal`. Мапінг — у `mapDatabaseError` | спека П4 §6.10 (задача 0) |
| Р12 | **Прив'язка бази й бакета.** `simetra.storage_instance` — один рядок з випадковим uuid, створюється з юнітами. У бакеті лежить об'єкт `simetra-instance` з тим самим uuid; його пише `put` лише в порожній бакет (жодного ключа `o/`); непорожній бакет без маркера — відмова `put` і звірки. Звірка й `put` відмовляють, коли маркери різні. Причина: DSN одного середовища з бакетом іншого мають ті самі префікси `o/<UUID об'єкта>/`, і запобіжник 5 %/20 не зупинив би видалення живих байтів | §8.2 (задача 0) |
| Р13 | **Звірка бере «зараз» з бази** (`now()` у транзакції), а не з годинника host-а: розбіжність годинника не має видаляти завантаження, що триває | §8.2 (задача 0) |
| Р14 | **Бакети тестів.** Прибиральник не приймає тегу як аргументу: він бере тег свого прогону й адресує рівно `runBucketName(<свій тег>)`. Відбору за префіксом немає, `simetra-dev` не адресується ніколи. Garage: `createRunBucket` плюс admin `AllowBucketKey` для dev-ключа. Supabase: бакет `run-<тег>` через S3 `CreateBucket`, знімок читає `storage.buckets` (перевірити `SELECT` ролі guard-а). Бакет тегу спершу спорожнюється (`ListObjectsV2` + `DeleteObjects`), потім видаляється | §10.3 (задача 0); речення `AGENTS.md` — власник |
| Р15 | **Шаблон:** обмеження одночасних завантажень — лічильник на інстанс, `SIMETRA_UPLOADS_PER_USER` (типово 2), понад межу — 429. Спільний бюджет буфера на інстанс — `SIMETRA_UPLOAD_BUFFER_BYTES` (типово 256 MiB): понад нього — 503 до читання тіла. Між завершенням `put` і стартом `attachFile` — не більше 10 хв, інакше відмова й видалення байтів: звірка вважає сиротою об'єкт, старший за 24 год, тож завислого вкладення бути не може. Звірку запускає скрипт `pnpm reconcile-files` за cron оператора поза процесом запиту (ПП7); HTTP-маршруту немає | §8.2 (задача 0) |
| Р16 | **Форма endpoint-ів.** `POST /api/files/$object`: сире тіло, `Content-Type` — тип файлу (параметри відкидаються до перевірки переліку), метадані `{ scope, name, fields }` у заголовку `X-Simetra-File` (URL-кодований JSON до 8 KiB, сувора Zod-схема; `fields` без id, скоупу й `file_*`). `GET`/`DELETE` — `/api/files/$object/$id`, не-UUID `$id` → 404. Маршрут завантаження обходить загальний `limitBody`: межа — `maxBytes` об'єкта, `Content-Length` понад неї → 413 до читання тіла | спека П4-D: виняток з `limitBody` (задача 0) |

`EXECUTE` на чотири definer-функції має роль `simetra_command`, як у спеці
(ПГ11). Бар'єр проти SQL модулів — наявне правило «заборонено все
`simetra.*`» плюс `REVOKE … FROM PUBLIC`. Окремі ролі для цих функцій —
пропозиція архітекторці поза планом.

## Інтерфейси між задачами

```text
T0  storageSchema = { maxBytes: int, mediaTypes: string[] }  (Catalog.storage?)
    STORAGE_MAX_BYTES = 104857600
    fileObjectKey(objectId, rowId): string    — "o/<objectId>/<rowId>", лише UUID
T1  simetra.storage_usage(scope_kind, scope, bytes), simetra.storage_quota(scope_kind, scope, max_bytes)
    simetra.storage_pending(xact xid8, object uuid, id uuid, size bigint, content_type text)
    simetra.storage_instance(id uuid)
    simetra.file_attach(p_object uuid, p_id uuid, p_size bigint, p_type text) RETURNS void
    simetra.storage_headroom(p_object uuid, p_scope uuid) RETURNS boolean
    simetra.storage_rows_exist(p_object uuid, p_ids uuid[]) RETURNS SETOF uuid
    simetra.storage_row_page(p_object uuid, p_after uuid) RETURNS SETOF uuid
    тригери: вкладення (BEFORE INSERT), незмінність (BEFORE UPDATE OF file_*),
             облік і межа (AFTER INSERT OR DELETE)
T3  FileStore = { put, get, delete, list }   — форма §8.4
    fromS3Client(client: S3ClientLike, bucket: string): FileStore
    CommandRuntime.checkUpload(session, { object, scope }) → { maxBytes, mediaTypes } | null
    CommandRuntime.attachFile(session, { object, scope, id, name, fields, size, contentType })
        → CommandResult  (помилка з ознакою commitUnknown)
    CommandRuntime.reconcileFiles(store, { log }) → ReconcileReport
        = { listed, deleted, refused, unknownPrefixes, rowsWithoutBytes }
test  s3Of(stack): S3ClientLike; emptyAndDeleteRunBucket(tag, stack)
```

## Інваріанти безпеки й тести, що червоніють на дефекті

Кожна умова в рядку — окремий тест з власним дефектом.

| # | Інваріант | Тест | Навмисний дефект → червоне |
| --- | --- | --- | --- |
| І1 | `simetra_command` не пише `file_size` і `file_content_type`, а `UPDATE` цих колонок відмовляє | DB | колонки в гранти команд; без тригера незмінності |
| І2 | `file_attach` відмовляє `storage.attach-invalid`: тип поза `mediaTypes`, розмір понад `maxBytes`, об'єкт без `storage` | DB, таблично | прибрати кожну перевірку окремо |
| І3 | Рядок без `file_attach` у тій самій транзакції не вставляється (`dataFn create`, копіювання, `ctx.run`). Запис іншої транзакції не підходить | DB | тригер не перевіряє `xact`; запис не видаляється при вставці (другий рядок з тим самим записом) |
| І4 | Облік на вставці й видаленні. Понад межу — `storage.quota-exceeded` з відкатом обліку. Два паралельні завантаження біля межі — одне відмовляє | DB, пара з'єднань | читання-потім-запис замість upsert; без декременту на видаленні |
| І5 | `storage_headroom` — `false` для кожної з чотирьох умов Р3. Роль запиту не читає `storage_usage` і `storage_quota` | DB під `asRole("user")` | без перевірки права; `GRANT SELECT` ролі запиту |
| І6 | `storage_rows_exist` і `storage_row_page` бачать рядки чужого тенанта, відмовляють для об'єкта без `storage` і понад 1000 id. Права `EXECUTE` немає в `PUBLIC`, `simetra_user`, `simetra_anon` (на `supabase` — `anon`, `authenticated`) | DB | без `REVOKE … FROM PUBLIC`; `SECURITY INVOKER` |
| І7 | Виклик функцій сховища в SQL модуля — `sql.platform-function-call` | unit | функція в `PLATFORM_READ_FUNCTIONS` |
| І8 | `fileObjectKey` відкидає не-UUID. Ключ ззовні не приймається | unit | конкатенація без перевірки |
| І9 | `put` обриває потік на `maxBytes + 1` і не лишає об'єкта. Розмір у `file_attach` — з `put` | unit + Garage | розмір з `Content-Length` |
| І10 | Звірка видаляє сироту, старшу за 24 год; молодшу й з рядком чужого тенанта не чіпає. Невідомий префікс журналює. Перелік — лише префікс. Запобіжник > 5 % **і** > 20 | DB + Garage | існування через RLS-читання; перелік поза префіксом; без межі 20 |
| І11 | Байти зникають лише після коміту `delete`. `delete` чужого id не чіпає чужих байтів. Повтор спроби, де перша видалила X і відкотилась, лишає байти X | DB + Garage | `files.delete` до коміту; ключі з вхідних id; спільний `afterCommit` спроб |
| І12 | Розбіжність маркерів, або непорожній бакет без маркера — нуль видалень і відмова `put` | DB + Garage | без перевірки маркера; маркер пишеться в непорожній бакет |
| І13 | Прибиральник не звертається до S3 для порожнього тегу, `simetra-dev`, тегу іншого прогону (навіть валідного за `isRunTag`) чи бакета Supabase без `run-` | unit на фейках | відбір за префіксом |
| І14 | Endpoint видаляє байти лише після відомого відкату. При `commitUnknown` байти лишаються | unit маршруту з фейком рантайму | видаляти на будь-якій помилці |
| І15 | Чужий рядок — 404 без звернення до бакета. Анонім — 401. Без права `create` — жодного байта. Повторна `verifySession` перед `attachFile`: сесію відкликано під час `put` → рядка немає, байти видалено | unit + e2e | читання бакета до RLS-читання; без повторної перевірки сесії |
| І16 | Заголовки читання: `attachment` з `filename*` (RFC 5987) і ASCII-запасом `filename=`; без CR/LF, `/`, `\` і символів категорії Cf; `nosniff`, `sandbox`, `no-store`, `Cross-Origin-Resource-Policy: same-origin`; тип поза переліком → `application/octet-stream` | unit | `Content-Type` з рядка без перевірки |
| І17 | `POST` і `DELETE` без `Sec-Fetch-Site: same-origin` відмовляють до перевірки сесії. `files.ts` без змінних S3 не стартує | unit | перевірка після `verifySession`; типові значення dev-ключа |

---

## Частина А

### Task 0: поправки спеки

Внести поправки за стовпцем «Вплив на спеку» в спеку профілю (§8, §10.3 —
зокрема речення, що спорожнення «приходить у ПГ-5»), у ПП4 спеки профілів,
у спеку П4 §6.10 і в спеку П4-D (виняток з `limitBody`). Потім запустити
`python3 scripts/check-doc-anchors.py` і `pnpm format:check`, далі
закомітити.
**Готово:** спеки описують Р1, Р3–Р7, Р9–Р13, Р15–Р16; якорі й формат
зелені.

### Task 1: T0 — властивість `storage` і реквізити файлу

- `catalogSchema.storage` разом із правилами `storage.incompatible` і
  `storage.media-type`: `SCHEMA_RULES`, `messages.ts`, `diagnostics.ts`.
- Колонки файлу в `standardColumns` довідника (Р8).
- `fileObjectKey`.
- Ознака `storage` у каталозі рантайму (`model/runtime/catalog.ts`,
  генератор `runtime-catalog.ts`) і вплив на `serverHash`. У клієнтський
  каталог потрапляють лише `maxBytes` і `mediaTypes`.
**Готово:** unit-тести схеми, колонок, ключа (І8) і каталогу зелені;
`typecheck` і `lint` зелені.

### Task 2: T1 — таблиці, функції, тригери

- Юніти генеруються, лише коли є об'єкт зі `storage`.
- Таблиці без грантів ролям API й команд.
- Функції: definer, `SET search_path = ''`, диспетчер за `p_object` у формі
  `snapshotDispatcher`, `REVOKE … FROM PUBLIC`.
- `EXECUTE`: на `storage_headroom` — роль запиту користувача, на решту — лише
  `command`.
- Право `create` у `storage_headroom` береться з функції множини, яку вживає
  політика межі вставки (§6.8). Якщо такої немає — звертайся до
  архітекторки.
- Нові тригери — сімейства в `platformTriggers()`.
- Нескоуплений об'єкт веде облік під `ZERO_UUID` (§8.3).
- Відмова `plan.storage-added` (Р9).
- Мапінг відмов Р11 у `mapDatabaseError`.
**Готово:** compile-тести, І7 і DB-тести І1–І6 на `postgres`
(`packages/designer/src/__tests__/storage-*.db.test.ts`; форма —
`read-anonymous.db.test.ts` з ПГ-3) зелені й червоніють на своїх дефектах.
Тест «план з нуля» знає нові тригери. Версія рядка після `attachFile`
дорівнює 1.

### Task 3: тест-інфра — S3 і прибирання бакетів

- `@aws-sdk/client-s3` `3.1157.0` іде devDependency.
- `s3Of(stack)`:
  - Garage: `127.0.0.1:3900`, регіон `garage`, dev-ключ;
  - Supabase: `STORAGE_S3_URL` і ключі з одного виклику `supabase status -o env`
    закріпленого CLI у `globalSetup`, передані через `provide`.
- `AllowBucketKey`.
- `emptyAndDeleteRunBucket` за Р14.
- Звіт про залишки називає лише бакет, який спорожнити не вдалося.
**Готово:** unit `external.test.ts` (І13; спорожнення, потім видалення; збій
S3 → звіт) зелений. Перерваний SIGINT прогін з об'єктом у бакеті Garage
не лишає бакета (`fixtures/interrupted-run.ts`).

### Task 4: T3 — `FileStore` і `fromS3Client`

Файл `src/server/file-store.ts` з експортом з `src/server/index.ts`. Що
перевіряють тести:
- І9;
- `get` відсутнього ключа → `null`;
- `list` лише префікса зі сторінками;
- маркер Р12.
**Готово:** unit на фейковому `S3ClientLike` зелений; у зоні T3 немає
імпорту SDK.

### Task 5: T3 — `checkUpload`, `attachFile`, видалення після коміту

- `checkUpload`: `READ ONLY` під роллю запиту, `storage_headroom`.
- `attachFile` — одна спроба `attempt`: спершу `file_attach`, далі `create`.
  Внутрішня фаза, без публічних дверей для SQL (Рт6). Ті самі ретраї, бюджет
  і сигнал, що й у `run`.
- Опція `files` і Р5: `RETURNING` у фазі `delete`, `afterCommit` спроби.
**Готово:** DB-тести І3, І11 і повний цикл `checkUpload` → `put` →
`attachFile` → `read` → `delete` на Garage зелені. Тест повтору: другий
рядок обліку не з'являється.

### Task 6: T3 — `reconcileFiles`; тест `supabase`

- Алгоритм §8.2 з Р10, Р12 і Р13: кандидати збираються за прогін;
  запобіжник і маркер перевіряються до будь-якого видалення.
- id перевіряються сторінками по 1000.
- Кожна сирота перед видаленням перевіряється ще раз.
- Окремий `storage.supabase.db.test.ts` проходить повний цикл через S3
  Supabase (Р1).
**Готово:**
- І10 і І12 зелені на Garage;
- тест `supabase` зелений;
- `pnpm test:db:pg` і `pnpm test:db` зелені повністю, раз на частину;
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` зелені.

**Готово А:** тести §8 рівнів unit і DB зелені на `postgres` з Garage.
Повний цикл зелений на `supabase`. Перерваний прогін не лишає бакетів.

## Частина Б (після П4-D)

Якорі: `packages/create-simetra-app/template/src/server/{runtime,origin,auth,body-limit}.ts`,
лінт шаблону, експорт `checkRequestOrigin`.

### Task 7: шаблон — маршрути файлів

Маршрути Р16 у `template/src/routes/api/files/` мають такий порядок:
1. походження (І17);
2. сесія: анонім → 401;
3. `checkUpload`; `null` → 403;
4. ліміт одночасних завантажень (Р15);
5. `put`;
6. повторна `verifySession`;
7. `attachFile`: відкат → `files.delete`, `commitUnknown` → нічого (І14).

Читання: `runtime.read`, потім `get` із заголовками І16. Клієнт S3 живе
лише в `src/server/files.ts`. Змінні `SIMETRA_S3_ENDPOINT`, `_BUCKET`,
`_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION` читає тільки він; без
змінних він падає. Лінт шаблону: `@aws-sdk/*` дозволено лише в
`src/server/files.ts`. `runtime.ts` передає `files`.
**Готово:** unit І14–І17 зелені. Тест складу збірки: секрети S3 не
потрапляють у клієнтський бандл.

### Task 8: шаблон — звірка й e2e

Скрипт `pnpm reconcile-files` друкує `ReconcileReport` і повертає
ненульовий код, коли `refused`. e2e на стенді з Garage:
- повний цикл;
- 404 на чужий рядок без звернення до бакета;
- анонім і користувач без права не пишуть байтів;
- 413.
**Готово Б:** e2e зелені.

## Задачі власника (виконавець не робить)

- `AGENTS.md`, абзац про run tag: «removes its own containers and its empty
  buckets, and reports a non-empty bucket» замінити на «empties and removes
  its own buckets, and reports a bucket it could not empty». Речення
  передає архітекторка разом із PR частини А.

## Review Focus

1. Повтор `attempt` в `attachFile`: запис у `storage_pending` прив'язано до
   `xact`, тож повтор не дає ні подвійного обліку, ні «осиротілого» запису
   (задача 5).
2. `Content-Length` відсутній або бреше: межу тримає лічба в `put`
   (задачі 4 і 7).
3. Ім'я файлу з `..`, лише з пробілів чи з bidi-символами: збереження
   дозволене (зміст), видача очищена (задача 7).
4. Рядок з'являється чи зникає під час звірки: не дефект і не видалення
   (задача 6).
5. Рядок файлу видалено каскадом (власник, скоуп): байти забирає лише
   звірка через 24 год. Тест це фіксує (задача 6).

## Аудит

Раунд 1 (2026-11-09). Sonnet перевірив план проти спеки й коду: blocker
немає, 4 major. Opus перевірив безпеку: 6 major, 7 minor. Прийнято й
внесено:
- закритий перелік помилок (Р11);
- вставка розміру й типу в `INSERT` замість `UPDATE` (Р4). Вона знімає
  зайву версію, тригери прав, облік на `UPDATE`, відкладену помилку на
  `COMMIT` і проблему `xmin` у підтранзакції;
- ключі видалення з `RETURNING` спроби (Р5);
- `commitUnknown` (Р6, І14);
- межа S3-ключа Supabase як відхилення (Р1);
- маркер бази й бакета (Р12);
- точна адреса бакета прибиральника (Р14);
- час з бази (Р13);
- незмінність колонок файлу й `plan.storage-added`;
- повторна перевірка сесії, сувора схема метаданих, заголовки (І15–І17);
- виняток з `limitBody` у спеці П4-D.

Раунд Codex (`gpt-6-sol`, безпека, на правленому плані): 1 blocker і 6 major. Внесено одноразовий запис `storage_pending` (Р4), маркер лише в порожній бакет (Р12), межу 10 хв між `put` і `attachFile` і бюджет буфера на інстанс (Р15), прибиральник лише свого тегу (Р14). Передано архітекторці: blocker «S3-ключ Supabase на весь проєкт» (Р1 — прийняти ризик або обмежити `storage` профілем `postgres`) і повторну знахідку про окрему роль для `file_attach`.

Не прийнято в раунді 1: окремі ролі для definer-функцій. Спека ПГ11 свідомо дала
`EXECUTE` ролі `simetra_command`. Взято лише `REVOKE … FROM PUBLIC` у тесті
І6; пропозицію ролей передано архітекторці. Codex не запускався:
безпековий major прийнято правками, а не лишено відкритим.
