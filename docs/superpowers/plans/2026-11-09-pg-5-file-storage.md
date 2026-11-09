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
- Розмір і тип вмісту пише лише `simetra.file_attach`. Їх немає в колонках
  команд `simetra_command`.
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
| Р1 | **Бекенд байтів у `supabase`** — `fromS3Client` над S3-протоколом Supabase Storage (`/storage/v1/s3`), приватний бакет, ключ лише в host-а. SQL-частина (рядок, облік, межа, функції) нейтральна до профілю. Прийняті бази лишаються на Storage-API з політиками. Перевірено: CLI `2.122.1` з `[storage.s3_protocol] enabled = true` віддає `STORAGE_S3_URL` і `S3_PROTOCOL_ACCESS_KEY_*` у `supabase status -o env`, тож конфіг стека не змінюється (рішення архітекторки, варіант 1) | ПП4, §8.4: назвати бекенд `supabase` (задача 0) |
| Р2 | **Частини А/Б.** Endpoint-и й звірка в шаблоні — після П4-D, бо в зрізі П4-D файлових маршрутів немає | немає |
| Р3 | **Попередня перевірка — одна definer-функція.** `simetra.storage_headroom(p_object, p_scope)` повертає `false`, коли користувач не має права `create` на об'єкт у скоупі, коли скоуп не його, коли об'єкт без `storage` або коли файл розміру `maxBytes` не вміститься. Один булевий результат не розкриває, яка умова відмовила | §8.2 крок 2: право входить у функцію (задача 0) |
| Р4 | **Завершеність рядка** — відкладений тригер обмеження (`DEFERRABLE INITIALLY DEFERRED`) на вставці. На коміті розмір і тип мусять бути записані, інакше `storage.attach-missing`. Так рядок без байтів не з'явиться ні через `dataFn create`, ні через копіювання, ні через `ctx.run` | §8.1: новий інваріант (задача 0) |
| Р5 | **Байти видаляє рантайм.** Опція `createCommandRuntime({ files?: FileStore })`. На кожен закомічений `delete` рядка об'єкта з `storage` (будь-який шлях: `dataFn`, `ctx.run`) рантайм ставить `afterCommit` → `files.delete(key)`. `markDeletion` байтів не чіпає. Без опції видалення лишається звірці | §8.2 «Видалення»: механізм — рантайм, не endpoint (задача 0) |
| Р6 | **Методи T3:** `checkUpload` (крок 2), `attachFile` (крок 4), `reconcileFiles`. `checkUpload` — третій метод поряд із двома зі спеки: endpoint не має SQL (лінт шаблону) | §8.4: додати `checkUpload` (задача 0) |
| Р7 | **`fromS3Client` — над структурним клієнтом з методами** `putObject`, `getObject`, `deleteObject`, `listObjectsV2` (форма агрегатного `S3` з `@aws-sdk/client-s3`). `put` рахує байти сам, обриває потік понад `maxBytes` і буферизує тіло, щоб передати `ContentLength`. Пам'ять обмежує стеля T0 `STORAGE_MAX_BYTES` = 100 MiB. Багаточастинне завантаження — з першою вимогою | §8.1: стеля `maxBytes`; §8.4: буфер (задача 0) |
| Р8 | **Стандартні реквізити файлу:** `file_name` (`text`, not null, зміст, пише команда), `file_size` (`bigint`), `file_content_type` (`text`). Останні два nullable до `file_attach` і є в `platformWrittenNames` | немає (§8.1 дозволяє імена) |
| Р9 | **Сумісність `storage`:** лише `Catalog`, і лише без `role`, `membership`, `rightsContainer`, предвизначених елементів і `hierarchyType: "FoldersAndItems"`. Рядок без файлу (папка, предвизначений) суперечив би Р4. Правило T0 — `storage.incompatible`. `mediaTypes` — непорожній перелік унікальних `type/subtype` малими літерами, без параметрів (`storage.media-type`). `maxBytes` — ціле в межах 1…`STORAGE_MAX_BYTES` | §8.1: перелік несумісностей (задача 0) |
| Р10 | **Рядки без байтів** звірка знаходить через `simetra.storage_row_page(p_object, p_after uuid) RETURNS SETOF uuid` (definer, до 1000 id за сторінку, `EXECUTE` лише `simetra_command`). Під RLS чужі рядки невидимі | §8.2 «Звірка»: нова функція (задача 0) |
| Р11 | **Бакети тестів.** Garage: `createRunBucket` + admin `AllowBucketKey` для dev-ключа стека. Supabase: бакет `run-<тег>` через S3 `CreateBucket`; знімок guard-а читає `storage.buckets` за префіксом `run-`. Прибиральник обох стеків спорожнює бакет тегу (S3 `ListObjectsV2` + `DeleteObjects`), потім видаляє його | §10.3: прибирання на `supabase` (задача 0); речення в `AGENTS.md` — власник |
| Р12 | **Обмеження одночасних завантажень** — лічильник на інстанс у шаблоні, змінна `SIMETRA_UPLOADS_PER_USER` (типово 2), понад межу — 429 | немає (§8.2: опція host-а) |
| Р13 | **Звірка в шаблоні** — скрипт `pnpm reconcile-files`, який запускає планувальник оператора (cron поза процесом запиту, ПП7). HTTP-маршруту немає, бо зайва поверхня з секретом не потрібна | §8.2: «фонове завдання» = скрипт (задача 0) |
| Р14 | **Форма endpoint-ів:** `POST /api/files/$object` — сире тіло, `Content-Type` — тип файлу, метадані `{ scope, name, fields }` у заголовку `X-Simetra-File` (URL-кодований JSON, до 8 KiB). `GET` і `DELETE` — `/api/files/$object/$id`, у `DELETE` є `?expectedVersion=`. `$object` — логічне ім'я, резолвиться за каталогом. Маршрут завантаження обходить загальний `limitBody`: межу задає `maxBytes` об'єкта (`Content-Length` понад межу — 413 до читання тіла) | немає |

## Інтерфейси між задачами

```text
T0  storageSchema = { maxBytes: int, mediaTypes: string[] }  (Catalog.storage?)
    STORAGE_MAX_BYTES = 104857600
    fileObjectKey(objectId: string, rowId: string): string           — "o/<objectId>/<rowId>"
    FILE_COLUMNS: file_name | file_size | file_content_type         — у реєстрі видів
T1  simetra.storage_usage(scope_kind uuid, scope uuid, bytes bigint, PK(scope_kind, scope))
    simetra.storage_quota(scope_kind uuid, scope uuid, max_bytes bigint, PK(...))
    simetra.file_attach(p_object uuid, p_id uuid, p_size bigint, p_type text) RETURNS void
    simetra.storage_headroom(p_object uuid, p_scope uuid) RETURNS boolean
    simetra.storage_rows_exist(p_object uuid, p_ids uuid[]) RETURNS SETOF uuid
    simetra.storage_row_page(p_object uuid, p_after uuid) RETURNS SETOF uuid
    тригери: облік (AFTER INSERT OR UPDATE OF file_size OR DELETE), завершеність (Р4)
T3  FileStore = { put, get, delete, list }                           — форма §8.4
    fromS3Client(client: S3ClientLike, bucket: string): FileStore
    CommandRuntime.checkUpload(session, { object, scope })
        → { maxBytes, mediaTypes } | null                            — null = відмова (Р3)
    CommandRuntime.attachFile(session, { object, scope, id, fields, size, contentType })
        → CommandResult
    CommandRuntime.reconcileFiles(store, { now?, log }) → ReconcileReport
        ReconcileReport = { listed, deleted, refused: boolean, unknownPrefixes, rowsWithoutBytes }
test  s3Of(stack): S3ClientLike; createRunBucket(...) з доступом dev-ключа; emptyAndDeleteRunBucket
```

## Інваріанти безпеки й тести, що червоніють на дефекті

| # | Інваріант | Тест (рівень) | Навмисний дефект → червоне |
| --- | --- | --- | --- |
| І1 | `simetra_command` не пише `file_size` і `file_content_type` | DB: `UPDATE`/`INSERT` колонки під `simetra_command` → `42501` | додати колонки в гранти команд |
| І2 | `file_attach` відмовляє `storage.attach-invalid`: рядок не з поточної транзакції (`xmin` ≠ xid), розмір чи тип уже записано, тип поза `mediaTypes`, розмір понад `maxBytes` | DB, таблично по чотирьох умовах | прибрати перевірку `xmin` |
| І3 | Рядок без `file_attach` не комітиться (Р4) | DB: `create` через рантайм без attach → `storage.attach-missing` | зробити тригер не відкладеним або прибрати його |
| І4 | Облік і межа: вставка, видалення й страхувальний `UPDATE OF file_size` ведуть `storage_usage`; понад `storage_quota` — `storage.quota-exceeded`, і облік відкочується разом з рядком | DB | тригер `BEFORE` без перевірки межі |
| І5 | `storage_headroom` — `false` для чужого скоупу, без права `create`, для об'єкта без `storage`, без запасу; роль запиту не читає `storage_usage` і `storage_quota` | DB під `asRole("user")` | прибрати перевірку права з функції |
| І6 | `storage_rows_exist` і `storage_row_page` бачать рядки чужого тенанта, відмовляють для об'єкта без `storage` і понад 1000 id; `EXECUTE` лише `simetra_command` | DB | видати `EXECUTE` ролі запиту |
| І7 | Виклик чотирьох функцій у SQL модуля — `sql.platform-function-call` | unit компілятора | додати функцію в `PLATFORM_READ_FUNCTIONS` |
| І8 | Ключ виводиться лише з id: `fileObjectKey` відкидає не-UUID; endpoint не приймає ключа ззовні | unit | конкатенація без валідації UUID |
| І9 | `put` обриває потік на `maxBytes + 1` і не лишає об'єкта | unit на фейковому клієнті + стенд Garage | рахувати розмір після запису |
| І10 | Звірка: сирота старша за 24 год видаляється; молодша й чужого тенанта з рядком — ні; невідомий префікс лише журналюється; запобіжник (> 5 % **і** > 20) нічого не видаляє | DB + Garage | прибрати нижню межу 20 чи вікно 24 год |
| І11 | `delete` рядка → байти зникають після коміту; відкат → байти лишаються (Р5) | DB + Garage | `files.delete` до коміту |
| І12 | Endpoint: чужий рядок — 404 без звернення до бакета; анонім — 401; без права `create` — жодного байта; заголовки читання §8.2 (`attachment` з RFC 5987, `nosniff`, `sandbox`, `no-store`, тип поза переліком → `application/octet-stream`; CR/LF чи `/` в імені вирізано) | unit заголовків + e2e шаблону з Garage | віддати `Content-Type` з рядка без перевірки переліку |
| І13 | Походження: `POST` і `DELETE` без `Sec-Fetch-Site: same-origin` → відмова до сесії | unit маршруту | перевірка після `verifySession` |

---

## Частина А

### Task 0: поправки спеки

Внести поправки за стовпцем «Вплив на спеку» (Р1, Р3–Р7, Р9–Р11, Р13) у
спеку профілю §8 і §10.3 та в ПП4 спеки профілів. Потім запустити
`python3 scripts/check-doc-anchors.py` і `pnpm format:check`, далі
закомітити.
**Готово:** спека описує Р-рішення; якорі й формат зелені.

### Task 1: T0 — властивість `storage` і реквізити файлу

`catalogSchema.storage` (Р9, `STORAGE_MAX_BYTES`), правила
`storage.incompatible` і `storage.media-type` у `SCHEMA_RULES`. Колонки
`FILE_COLUMNS` у `standardColumns` довідника за наявності `storage` (Р8).
`fileObjectKey` додати в `simetra/model`. Схеми JSON метаданих
перегенерувати, якщо пакет їх публікує.
**Готово:** unit-тести схеми (межі `maxBytes`, перелік типів, кожна
несумісність), колонок і ключа (І8) зелені; `pnpm --filter simetra
typecheck lint` зелені.

### Task 2: T1 — облік, межа, функції, тригери

Юніти генеруються, лише коли проєкт має хоч один об'єкт зі `storage`.
- Таблиці `storage_usage` і `storage_quota` без грантів ролям API й команд.
- Функції — `SECURITY DEFINER`, `SET search_path = ''`. Диспетчер за
  `p_object` будується так само, як `snapshotDispatcher`. `EXECUTE` за
  інтерфейсами: `storage_headroom` має роль запиту користувача (не гість),
  решта — лише `command`.
- Тригери обліку й завершеності — нові сімейства в `platformTriggers()`, щоб
  їх знали зворотна генерація й промоція.
- Нескоуплений об'єкт веде облік під `ZERO_UUID` виду й скоупу (§8.3).
- Право `create` у `storage_headroom` береться з тієї самої функції множини
  прав, що й політика межі вставки (§6.8). Якщо в коді такої немає —
  звертайся до архітекторки.
- `file_size`/`file_content_type` виключити з колонок команд через
  `platformWrittenNames` (І1).
**Готово:** compile-тести юнітів і правило І7 зелені. DB-тести І1–І6 на
`postgres` (`packages/designer/src/__tests__/storage-*.db.test.ts`, форма —
`read-anonymous.db.test.ts`) зелені й червоніють на дефектах таблиці. Тест
«план з нуля» знає нові тригери.

### Task 3: тест-інфра — S3 і прибирання бакетів

`@aws-sdk/client-s3` `3.1157.0` іде devDependency. В `external.ts`:
- `s3Of(stack)`: Garage — `http://127.0.0.1:3900`, регіон `garage`, dev-ключ
  з `dev-secrets.env`; Supabase — `STORAGE_S3_URL` і ключі з одного виклику
  `supabase status -o env` закріпленого CLI у `globalSetup` guard-а, передані
  через `provide`.
- `AllowBucketKey` для Garage.
- `emptyAndDeleteRunBucket` для обох стеків.
- Знімок `supabase` читає `storage.buckets` з префіксом `run-`.
- Прибиральник спорожнює бакет тегу й видаляє його. Звіт про залишки називає
  лише бакет, який спорожнити не вдалося.
**Готово:** unit `external.test.ts` на фейках: спорожнення, потім видалення;
чужий тег не чіпається; збій S3 → звіт. Перерваний SIGINT прогін з
об'єктом у бакеті не лишає бакета (розширити
`fixtures/interrupted-run.ts`).

### Task 4: T3 — `FileStore` і `fromS3Client`

Файл `src/server/file-store.ts`, експорт з `src/server/index.ts`. Що
перевіряють тести:
- `put` рахує розмір і обриває потік (І9);
- `get` відсутнього ключа повертає `null`, а не помилку;
- `list` бере лише префікс і сторінкує через `after`.
**Готово:** unit на фейковому `S3ClientLike` зелений; зона T3 не має
імпорту SDK.

### Task 5: T3 — `checkUpload`, `attachFile`, видалення після коміту

- `checkUpload`: транзакція `READ ONLY` під роллю запиту, виклик
  `storage_headroom`, повертає `maxBytes` і `mediaTypes` з каталогу.
- `attachFile`: одна спроба `attempt` з `create` і кроком
  `file_attach`. Внутрішній API — новий тип фази або список кроків
  `attempt`; публічних дверей для довільного SQL не додавати (Рт6). Тут
  працюють ті самі ретраї, бюджет і сигнал, що й для `run`.
- Опція `files` і `afterCommit` на `delete` за Р5. Каталог рантайму несе
  ознаку `storage` об'єкта.
- Клієнтський `create` об'єкта зі `storage` через `run` дає
  `storage.attach-missing` (І3).
**Готово:** DB-тести І3, І11 (на Garage через `s3Of`) і повний цикл
`checkUpload` → `put` → `attachFile` → `read` → `delete` зелені.

### Task 6: T3 — `reconcileFiles`; тест `supabase`

Алгоритм §8.2 з Р10:
- зібрати кандидатів за прогін, застосувати запобіжник і лише потім
  видаляти;
- id перевіряти сторінками по 1000;
- пройти рядки через `storage_row_page`, щоб знайти рядки без байтів.

Окремий `storage.supabase.db.test.ts` проходить повний цикл через S3
Supabase (Р1).
**Готово:**
- DB-тести І10 на Garage зелені, зокрема «запобіжник на порожній базі»;
- тест `supabase` зелений у `pnpm test:db`;
- `pnpm test:db:pg` і `pnpm test:db` зелені повністю, раз на частину;
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` зелені.

**Готово А:** тести §8 рівнів unit і DB зелені на `postgres` з Garage. Тест
повного циклу зелений на `supabase`. Перерваний прогін не лишає бакетів.

## Частина Б (після П4-D)

### Task 7: шаблон — маршрути файлів

Маршрути Р14 у `packages/create-simetra-app/template/src/routes/api/files/`
мають такий порядок:
1. `checkRequestOrigin` для `POST` і `DELETE`;
2. `verifySession`: анонім або без `sub` → 401;
3. `checkUpload`; `null` → 403, і жоден байт не пишеться;
4. обмеження одночасних завантажень (Р12);
5. `put` з `maxBytes`;
6. `attachFile`; якщо відмова, то `files.delete`.

Читання йде через `runtime.read` і `get` із заголовками §8.2. Клієнт S3 —
модульний, у `src/server/files.ts`; змінні `SIMETRA_S3_ENDPOINT`,
`SIMETRA_S3_BUCKET`, `SIMETRA_S3_ACCESS_KEY_ID`,
`SIMETRA_S3_SECRET_ACCESS_KEY`, `SIMETRA_S3_REGION` читає лише він. Лінт
шаблону розширити: `@aws-sdk/*` дозволено лише в `src/server/files.ts`.
`runtime.ts` передає `files` у `createCommandRuntime`.
**Готово:** unit-тести І12 (заголовки, імена) і І13 зелені. Тест складу
збірки: секрет S3 не потрапляє в клієнтський бандл.

### Task 8: шаблон — звірка й e2e

Скрипт `pnpm reconcile-files` (Р13) друкує `ReconcileReport` і виходить з
ненульовим кодом, коли `refused`. e2e шаблону на стенді з Garage:
- повний цикл;
- чужий рядок → 404 без запиту до бакета (лічильник запитів фейкового
  проксі або журнал Garage);
- анонім і користувач без права не пишуть байтів;
- 413 за `Content-Length`.
**Готово Б:** e2e зелені; тести §8 рівня «стенд з Garage» закрито.

## Задачі власника (виконавець не робить)

- `AGENTS.md`, абзац про run tag: «removes its own containers and its empty
  buckets, and reports a non-empty bucket» замінити на «empties and removes
  its own buckets, and reports a bucket it could not empty». Архітекторка
  передає речення власнику разом із PR частини А.

## Review Focus

1. Повтор `attempt` після серіалізаційної помилки в `attachFile`. Байти вже в
   бакеті, а id рядка той самий. Повтор не має давати другого рядка обліку
   (задача 5, тест повтору).
2. `Content-Length` відсутній або бреше: межу тримає лічба в `put`, а не
   заголовок (задачі 4 і 7).
3. Ім'я файлу з керівними символами, `..` чи лише пробілів. Збереження
   дозволене (зміст), видача очищена (задача 7).
4. Видалення рядка під час звірки: рядок і байти зникають між `list` і
   перевіркою. Звірка не має видавати це за дефект (задача 6).
5. Одночасні завантаження одного скоупу біля межі. Upsert серіалізує, тож
   друге отримує `storage.quota-exceeded`, а байти прибираються
   (задача 5).

## Аудит

_Заповнює автор після раундів._
