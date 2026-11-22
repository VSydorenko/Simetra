# ПГ-5 — сховище файлів: план реалізації (ескіз)

> **Статус:** прийнято 2026-11-09; ревізія частини А під `main` — 2026-11-22,
> приймає архітекторка `m4-simetra-milestone`. Форма — ескіз: рішення,
> інтерфейси, інваріанти, задачі з «готово». Тест-кейси, імена й дрібні кроки
> виконавець пише сам за кодом.
> **Частини.** **А** (задачі 0–6) — T0, T1, T3, тест-інфра; виконується
> зараз. **Б** (задачі 7–8) — маршрути й звірка в шаблоні host-а —
> **після П4-D** за сигналом архітекторки; у цьому блоці не виконується.
> **Перед стартом частини:** `orient --plan <цей файл>`.
> **Якорі «після #335» (Д5 #271, не змерджено):** `PINNED_SESSION_SETTINGS`.
> Якщо #335 змерджено до задачі 2 — згенеровані функції ПГ-5 виконують його
> правило для платформних функцій, якщо воно їх стосується; другого переліку
> налаштувань не заводити.
> **Спільні стеки.** Виконавець ніколи не зупиняє й не стартує стеки, не
> змінює `supabase/config.toml` і `docker/postgres-stack/` (там працює D5-2;
> потреба змінити — розвилка архітекторці). Локально — лише цільові
> `run-tests <level> --filter <file>` чи `--changed`; повні рівні `unit`,
> `db`, `db-supabase` запускає CI на draft PR після кожного push.

**Goal:** файл — рядок довідника з властивістю `storage`, байти — за портом
`FileStore` в обох профілях. Облік і межа обсягу ведуться в транзакції
запису. Байти доступні лише через серверні методи після читання рядка під
RLS. Сироти прибирає звірка.

**Architecture:** T0 — властивість `storage`, стандартні реквізити файлу в
реєстрі видів, відмови сховища. T1 — платформні SQL-юніти генератора
сховища: таблиці обліку, definer-функції, тригери. T3 — порт `FileStore`,
адаптер `fromS3Client`, методи рантайму. Тест-інфра — S3-помічник і
спорожнення бакета тегу. T3 не імпортує SDK: клієнт S3 читається
структурно, як `fromPgPool`.

**Tech Stack:** TypeScript 7, Zod, Vitest, Postgres 17 (стек `simetra-pg`),
Garage `v2.5.0`, Supabase CLI `2.122.1` (S3-протокол Storage увімкнено в
`supabase/config.toml`), `@aws-sdk/client-s3` — поточна стабільна версія на
день задачі 3 (Apache-2.0; перевірити `LICENSE` і закріпити точно). Лише
devDependency `simetra`; у шаблоні — залежність (частина Б).

**Spec:** [спека профілю `postgres`](../specs/2026-11-08-postgres-profile-design.md)
§8, §10.3, §12 (рядок ПГ-5); [спека профілів провайдера](../specs/2026-10-23-provider-profiles-design.md)
ПП4; [спека П4](../specs/2026-10-26-p4-runtime-design.md) Рт1, Рт6, Рт19,
§6.2, §6.10; [спека декларацій функцій](../specs/2026-11-18-sql-function-declarations-design.md)
(правило 1, захищені налаштування); платформна спека Р32, §6.8. Правила
тестів — скіл `writing-tests`.

## Global Constraints

- Коментарі — українською, «чому». Діагностики, `CommandError` і JSDoc
  експорту — англійською. Коміти — Conventional Commits з українським
  описом, без трейлерів; коміт на логічний крок.
- T3 (`src/server`) не імпортує S3 SDK (зона `eslint.tier-zones.js`).
- Ключ об'єкта — `o/<UUID об'єкта каталогу>/<id рядка>`. Він виводиться й
  ніде не зберігається. Id рядка генерує сервер.
- Розмір і тип вмісту ставить лише тригер вкладення із запису
  `simetra.storage_pending` (Р4). Їх немає в колонках команд.
- Функції сховища не потрапляють у `PLATFORM_READ_FUNCTIONS`: тоді наявне
  `sql.platform-function-call` (`checkPlatformCalls`) забороняє їх у SQL
  застосунку без нового коду.
- Таблиці `simetra.storage_*` реєструються як платформні таблиці знімка (як
  `signalOutboxTable()`): тоді правило 1 (`writePaths`, `ruleOneTables`)
  закриває їх для запису з SQL застосунку без нового коду.
- Ідентичність юнітів — лише через `generatedUnit` і помічники
  `compiler/sql/identity.ts` (лінт #297).
- Межа відповіді на «немає» і «не можна» — той самий 404. Відмова
  завантаження настає до першого байта в бакеті.
- `project.storageBuckets` (Storage-API прийнятих баз, ПП4) не змінюється;
  пункт боргу #128 про його політики — поза блоком.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Бекенд байтів у `supabase`** — `fromS3Client` над S3-протоколом Supabase Storage (`/storage/v1/s3`), приватний бакет; SQL-частина нейтральна до профілю. Прийняті бази лишаються на Storage-API з політиками. **Відхилення (прийнято архітекторкою):** S3-ключ Supabase діє на весь проєкт і обходить політики Storage, тож вимога §8.2 «ключ лише цього бакета» в `supabase` не виконується. Запобіжники: ключ живе лише в серверному середовищі host-а (І18, частина Б); бакет і ключ об'єкта задає лише сервер (І19). На `postgres` ключ Garage обмежено бакетом | ПП4, §8.4; §8.2 — текст відхилення (задача 0) |
| Р2 | **Частини А/Б.** Маршрути й звірка в шаблоні — після П4-D | немає |
| Р3 | **Попередня перевірка — одна definer-функція** `storage_headroom(p_object, p_scope)`: `false`, коли політики вставки об'єкта не пустили б рядок у `p_scope`, коли об'єкт без `storage` або коли файл розміру `maxBytes` не вміститься. Умову прав функція бере з тих самих будівників, що й політики `INSERT` об'єкта: дозвільна `create` (`rightsPredicates` → `rights_any('create', <мітка виду>)`) і обмежувальна межа скоупу (`tenantBoundary` / `scopeSetCall`). Другої копії правила немає. Одне булеве значення не розкриває, яка умова відмовила. `checkUpload` для гостя чи аноніма повертає `null` без SQL | §8.2 крок 2 (задача 0) |
| Р4 | **Розмір і тип пишуться в `INSERT`, а не в `UPDATE`.** `file_attach(p_object, p_id, p_size, p_type)` перевіряє тип і розмір проти `storage` об'єкта й пише запис у `simetra.storage_pending` з ключем (`pg_current_xact_id()`, об'єкт, id); ключ унікальний, повторний `file_attach` для того самого id відмовляє. Тригер `BEFORE INSERT` (definer) забирає запис атомарно (`DELETE … RETURNING`) і ставить колонки; без запису — `storage.attach-missing`. Після `create` `attachFile` під `simetra_files` перевіряє definer-функцією, що записів поточної транзакції не лишилось; записи чужих `xact` прибирає звірка. Причина: `UPDATE` після `create` піднімав би версію, запускав би тригери прав і змісту й переносив би облік на `UPDATE`. Інший шлях вставки колонок відмовляє: клієнтська команда `create`, `ctx.run`, копіювання | §8.1, §8.2 крок 4, §8.3 (задача 0) |
| Р5 | **Байти видаляє рантайм.** Опція `createCommandRuntime({ files?: FileStore })`. Ключ береться лише з результату фази `delete` цієї спроби, де ядро підтвердило видалення рядка (не з вхідного id), і йде в `afterCommit` спроби (`Transaction.afterCommit`). Шлях фази — клієнтська команда чи `ctx.run`. `markDeletion` байтів не чіпає. Каскадне видалення (власник, скоуп) і робота без опції лишаються звірці. Якщо ядро не віддає ознаки видалення — розширити його результат, а не читати id з входу | §8.2 «Видалення» (задача 0) |
| Р6 | **Методи T3:** `checkUpload` (крок 2), `attachFile` (крок 4), `reconcileFiles`. `checkUpload` — окремий метод: у маршруту немає SQL. `attachFile` мапить ім'я в стильований логічний `file_name` (`naming.attributeCase`). Результат розрізняє «відкат» і «результат коміту невідомий»: наявний `terminalOf` дає `command.unavailable` після надісланого `COMMIT`; `attachFile` віддає це ознакою `commitUnknown` | §8.4 (задача 0) |
| Р7 | **`fromS3Client` працює над структурним клієнтом** з методами `putObject`, `getObject`, `deleteObject`, `listObjectsV2` (форма агрегатного `S3` з `@aws-sdk/client-s3`). `put` сам рахує байти, обриває потік понад `maxBytes` і буферизує тіло, щоб передати `ContentLength`. Пам'ять обмежує стеля T0 `STORAGE_MAX_BYTES` = 100 MiB. Розмір у `file_attach` — лише результат `put` | §8.1, §8.4 (задача 0) |
| Р8 | **Стандартні реквізити файлу** — умовні колонки `standardColumns` довідника за `catalog.storage` (як `codeLength`, `owners`): `file_name` (`text`, not null, зміст), `file_size` (`bigint`), `file_content_type` (`text`). Логічні імена — за `standardLogicalName`. Дві останні: у `platformWrittenNames` (`command-columns.ts`), поза `contentColumns` (`mechanics-units.ts`, через `nonContentStandardNames`), незмінні після вставки (тригер `BEFORE UPDATE OF` відмовляє) | немає |
| Р9 | **Сумісність `storage`:** лише `Catalog`, без `role`, `membership`, `rightsContainer`, `predefinedItems` і `hierarchyType: "FoldersAndItems"`; правило схеми `storage.incompatible`. `mediaTypes` — непорожній перелік унікальних `type/subtype` малими літерами без параметрів (`storage.media-type`). `maxBytes` — 1…`STORAGE_MAX_BYTES`. Правила — у `SCHEMA_RULES` з повідомленнями в `compiler/messages.ts`. `storage`, доданий об'єкту з живою таблицею, відмовляє планом (`plan.storage-added`, як `plan.identity-trigger-locked` у `schema/apply/plan.ts`): облік і байти старих рядків не чесні | §8.1 (задача 0) |
| Р10 | **Рядки без байтів** звірка знаходить через `storage_row_page(p_object, p_after uuid) RETURNS SETOF uuid` (definer, до 1000 id). Рядок, що з'явився після початку переліку, не дефект | §8.2 «Звірка» (задача 0) |
| Р11 | **Відмови сховища — закритий перелік T0.** Новий `STORAGE_ERRORS` за зразком `COMMAND_CORE_ERRORS` (`model/runtime/core.ts`): `errcode`, `message` і причини `attach-missing`, `attach-invalid`, `quota-exceeded`. `mapDatabaseError` розпізнає їх за `errcode` і `message` і дає `command.rejected` з `reason` `storage.<причина>`; решта коду `errcode` іде старими гілками. `LIMIT_REASONS` не змінюється. Причина: інакше `RAISE` definer-функції став би `command.internal` | спека П4 §6.10 (задача 0) |
| Р12 | **Прив'язка бази й бакета.** `simetra.storage_instance` — один рядок з випадковим uuid, створюється з юнітами. У бакеті лежить об'єкт `simetra-instance` з тим самим uuid; його пише `put` лише в порожній бакет (жодного ключа `o/`); непорожній бакет без маркера — відмова `put` і звірки. Різні маркери — відмова звірки й `put`. Причина: DSN одного середовища з бакетом іншого мають ті самі префікси, і запобіжник 5 %/20 не зупинив би видалення живих байтів | §8.2 (задача 0) |
| Р13 | **Звірка бере «зараз» з бази** (`now()` у транзакції), а не з годинника host-а | §8.2 (задача 0) |
| Р14 | **Бакети тестів.** Прибиральник бере тег свого прогону й адресує рівно `runBucketName(<свій тег>)`; відбору за префіксом немає, `simetra-dev` не адресується. Зараз `removeRunResources` видаляє лише порожні бакети й звітує непорожні; стає: спорожнити (`ListObjectsV2` + `DeleteObjects`), потім видалити, звітувати лише бакет, який спорожнити не вдалося. Garage: `createRunBucket` плюс admin `AllowBucketKey` для dev-ключа (новий endpoint у `garage()`). Supabase: бакет `run-<тег>` через S3 `CreateBucket`, знімок guard-а читає `storage.buckets` (перевірити `SELECT` ролі guard-а). Значення Supabase S3 (`STORAGE_S3_URL`, `S3_PROTOCOL_ACCESS_KEY_*`) — з одного виклику `supabase status -o env` закріпленого CLI у `globalSetup`, у тести через `provide`/`inject` (новий для репо механізм) | §10.3 (задача 0); речення `AGENTS.md` — власник |
| Р15 | **Шаблон (частина Б):** лічильник одночасних завантажень на інстанс `SIMETRA_UPLOADS_PER_USER` (типово 2, понад — 429); бюджет буфера `SIMETRA_UPLOAD_BUFFER_BYTES` (типово 256 MiB, понад — 503 до читання тіла); між `put` і `attachFile` — не більше 10 хв, інакше відмова й видалення байтів. Звірку запускає `pnpm reconcile-files` за cron оператора (ПП7); HTTP-маршруту немає | §8.2 (задача 0) |
| Р16 | **Форма маршрутів (частина Б).** `POST /api/files/$object`: сире тіло, `Content-Type` — тип файлу (параметри відкидаються до перевірки), метадані `{ scope, name, fields }` у заголовку `X-Simetra-File` (URL-кодований JSON до 8 KiB, сувора Zod-схема; `fields` без id, скоупу й `file_*`). `GET`/`DELETE` — `/api/files/$object/$id`, не-UUID `$id` → 404. Маршрут завантаження обходить `limitBody`: межа — `maxBytes`, `Content-Length` понад неї → 413 до читання тіла | спека П4-D: виняток з `limitBody` (задача 0) |
| Р17 | **Роль `simetra_files`** — `NOLOGIN NOINHERIT`, новий запис `PLATFORM_ROLES`. Як `signalConsumer`, вона **не** `PlatformRolePurpose`: гранти їй пише лише генератор сховища явним `GRANT`, після `executeGrants(signature, [], provider)` (`REVOKE` від `PUBLIC` і ролей API), тож жодна декларація застосунку не адресує її. Тільки вона має `EXECUTE` на `file_attach`, `storage_rows_exist`, `storage_row_page` і перевірку залишку `storage_pending`; `simetra_command` і ролі запиту — ні. Членство: `LOGIN_ROLE_PARENTS.runtime` += `files` (`INHERIT FALSE, SET TRUE`), `supabase/roles.sql` — адитивно, `postgres` — `simetra roles`. `inspect()` рантайму доводить членство так само, як для `simetra_command` (`SET LOCAL ROLE` у транзакції перевірки), щоб відсутнє членство падало на старті. `command.privileged-login` змін не потребує: роль без небезпечних атрибутів. `attachFile` у своїй спробі робить `SET LOCAL ROLE simetra_files` → `file_attach` → `SET LOCAL ROLE simetra_command` → фаза `create`. Межа: прямий виклик з SQL модуля (роль `simetra_command`) відмовляє в базі. `SET ROLE` чи `set_config('role', …)` у SQL застосунку зупиняє `PROTECTED_SESSION_SETTINGS` (`role` уже в `names`, діагностика `sql.command-context-write`), виклик з definer-функції застосунку — `sql.platform-function-call` (І7) | ПГ11, спека П4 §6.2 (задача 0) |

**Реєстрація генератора (Р4, Р8, Р17).** Юніти сховища — новий генератор за
зразком `compiler/platform/outbox.ts` (`outboxUnits`): член `UnitGenerator`
і запис `FIXED_BODY` (`sql/units.ts`), мітка генератора поруч із
`signalOutbox` у `pipeline.ts`, `requires` на таблицю об'єкта (тіла plpgsql
граф порядку не читає), `SET search_path = ''` на кожній функції
(`assertPinnedSearchPath`), сімейства нових тригерів у `platformTriggers()`
(`compiler/platform-triggers.ts`), еталон розпізнавача (`PlatformReference`,
`platform/recogniser.ts`). Юніти існують, лише коли є об'єкт зі `storage`;
диспетчер за `p_object` — у формі `snapshotDispatcher`. Перевірити, що
згенеровані тригери на таблиці виду не змінюють висновку
`rights/snapshot-exempt-writers.ts` (форма «г»); інакше — розвилка.

## Інтерфейси між задачами

```text
T0  storageSchema = { maxBytes: int, mediaTypes: string[] }  (Catalog.storage?)
    STORAGE_MAX_BYTES = 104857600;  STORAGE_ERRORS (за зразком COMMAND_CORE_ERRORS)
    fileObjectKey(objectId, rowId): string    — "o/<objectId>/<rowId>", лише UUID
    catalogEntrySchema.storage? = { maxBytes, mediaTypes }  (клієнт і сервер)
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
| І3 | Рядок без `file_attach` у тій самій транзакції не вставляється (клієнтська команда `create`, `ctx.run`, копіювання) — `command.rejected` / `storage.attach-missing`. Запис іншої транзакції не підходить | DB | тригер не перевіряє `xact`; запис не видаляється при вставці (другий рядок з тим самим записом) |
| І4 | Облік на вставці й видаленні. Понад межу — `storage.quota-exceeded` з відкатом обліку. Два паралельні завантаження біля межі — одне відмовляє | DB, пара з'єднань | читання-потім-запис замість upsert; без декременту на видаленні |
| І5 | `storage_headroom` — `false` для кожної умови Р3: немає `create`, скоуп поза множиною користувача, об'єкт без `storage`, файл не вміститься; і `true` рівно там, де вставка під політиками пройшла б. Роль запиту не читає `storage_usage` і `storage_quota` | DB під `asRole("user")` | без перевірки права; без межі скоупу; власна копія предиката замість будівника політик; `GRANT SELECT` ролі запиту |
| І6 | `storage_rows_exist` і `storage_row_page` бачать рядки чужого тенанта, відмовляють для об'єкта без `storage` і понад 1000 id. `has_function_privilege` на `file_attach`, `storage_rows_exist`, `storage_row_page` — `false` для `simetra_command`, `PUBLIC`, `simetra_user`, `simetra_anon`, `anon`, `authenticated`, `service_role`; `true` для `simetra_files` | DB, обидва профілі | `GRANT EXECUTE … TO simetra_command`; без `REVOKE … FROM PUBLIC`; `SECURITY INVOKER` |
| І7 | Виклик функцій сховища в SQL застосунку (модуль, названий запит, декларована функція, definer-функція, динамічний текст) — `sql.platform-function-call`; `SET ROLE simetra_files` і `set_config('role', …)` — `sql.command-context-write`; запис у `simetra.storage_*` — діагностика правила 1. `simetra_files` не приймається як `PlatformRolePurpose` | unit | функція в `PLATFORM_READ_FUNCTIONS`; таблиці поза платформними таблицями знімка; `files` у `PlatformRolePurpose` |
| І8 | `fileObjectKey` відкидає не-UUID. Ключ ззовні не приймається | unit | конкатенація без перевірки |
| І9 | `put` обриває потік на `maxBytes + 1` і не лишає об'єкта. Розмір у `file_attach` — з `put` | unit + Garage | розмір з `Content-Length` |
| І10 | Звірка видаляє сироту, старшу за 24 год; молодшу й з рядком чужого тенанта не чіпає. Невідомий префікс журналює. Перелік — лише префікс. Запобіжник > 5 % **і** > 20 | DB + Garage | існування через RLS-читання; перелік поза префіксом; без межі 20 |
| І11 | Байти зникають лише після коміту `delete`. `delete` чужого id не чіпає чужих байтів. Повтор спроби, де перша видалила X і відкотилась, лишає байти X | DB + Garage | `files.delete` до коміту; ключі з вхідних id; спільний `afterCommit` спроб |
| І12 | Розбіжність маркерів або непорожній бакет без маркера — нуль видалень і відмова `put` | DB + Garage | без перевірки маркера; маркер пишеться в непорожній бакет |
| І13 | Прибиральник не звертається до S3 для порожнього тегу, `simetra-dev`, тегу іншого прогону (навіть валідного за `isRunTag`) чи бакета Supabase без `run-` | unit на фейках | відбір за префіксом |
| І20 | Рантайм без членства `simetra_files` не стартує (помилка на `inspect`, не на першому завантаженні) | DB | без перевірки членства в `inspect` |

Частина Б (маршрути): І14 — видалення байтів лише після відомого відкату,
при `commitUnknown` байти лишаються; І15 — чужий рядок 404 без звернення до
бакета, анонім 401, без права `create` жодного байта, повторна
`verifySession` перед `attachFile`; І16 — заголовки читання (`attachment` з
`filename*` RFC 5987 і ASCII-запасом, без CR/LF, `/`, `\`, Cf; `nosniff`,
`sandbox`, `no-store`, `Cross-Origin-Resource-Policy: same-origin`; тип поза
переліком → `application/octet-stream`); І17 — `POST`/`DELETE` без
`Sec-Fetch-Site: same-origin` відмовляють до перевірки сесії, `files.ts` без
змінних S3 не стартує; І18 — значення й імена змінних S3 не потрапляють у
клієнтський бандл і HTML SSR (тест збірки з контрольними значеннями);
І19 — `$id` з `../`, повний ключ чи чужий префікс відхиляються до S3.
Дефекти — як у ревізії 2026-11-09: порядок перевірок, видалення на будь-якій
помилці, ключ з параметра без `fileObjectKey`, змінна з `VITE_`.

---

## Частина А

### Task 0: поправки спеки

Внести поправки за стовпцем «Вплив на спеку» в спеку профілю (§8 — зокрема
§8.1 «`EXECUTE` лише `simetra_command`» → `simetra_files`, §8.2 крок 4 без
`xmin`; §10.3 — речення, що спорожнення «приходить у ПГ-5»), у ПП4 спеки
профілів, у спеку П4 §6.2 і §6.10, у ПГ11 і в спеку П4-D (виняток з
`limitBody`).
**Готово:** спеки описують Р1, Р3–Р7, Р9–Р13, Р15–Р17; `doc anchors && doc lint`
і `pnpm format:check` зелені.

### Task 1: T0 — властивість `storage`, реквізити, відмови

- `catalogSchema.storage` з правилами `storage.incompatible` і
  `storage.media-type` (`SCHEMA_RULES`, повідомлення в `compiler/messages.ts`;
  `messages.test.ts` ловить пропуск).
- Колонки файлу в `standardColumns` довідника (Р8).
- `fileObjectKey`, `STORAGE_MAX_BYTES`, `STORAGE_ERRORS` (Р11).
- `catalogEntrySchema.storage` і генератор `compiler/runtime-catalog.ts`;
  перевірити, що поле входить у `serverHash`.
**Готово:** unit-тести схеми, колонок, ключа (І8) і каталогу зелені —
`run-tests unit --changed`; `typecheck` і `lint` пакета зелені.

### Task 2: T1 — таблиці, функції, тригери, роль

- Генератор сховища й реєстрація (абзац «Реєстрація генератора»).
- Таблиці — платформні таблиці знімка з RLS, без грантів ролям API й команд.
- Роль `simetra_files` (Р17): `PLATFORM_ROLES`, `LOGIN_ROLE_PARENTS`,
  `supabase/roles.sql`, перевірка в `inspect()`; тести форми ролей обох
  профілів (`platform-roles.test.ts`, `stack-roles.postgres.db.test.ts`,
  `db-roles.supabase.db.test.ts`).
- Функції: definer, `SET search_path = ''`, `executeGrants(…, [], provider)`
  і явний `GRANT EXECUTE`: `storage_headroom` — ролі запиту користувача,
  решта — лише `simetra_files`.
- Права в `storage_headroom` — з будівників політик вставки (Р3).
- Нескоуплений об'єкт веде облік під `ZERO_UUID` (§8.3).
- `plan.storage-added` (Р9); мапінг `STORAGE_ERRORS` у `mapDatabaseError` (Р11).

Роль на спільних стеках: CI створює її на своїх стеках. Локальний `postgres`
отримує її через `simetra roles`, локальний Supabase — через `pnpm db:roles`.
Обидва адитивні й ідемпотентні; запускає їх виконавець перед першим DB-тестом
задачі й повідомляє архітекторці в звіті задачі (інші сесії не ламаються:
роль нова, чужих об'єктів не змінює).
**Готово:** compile-тести, І7 (`run-tests unit --changed`) і DB-тести
І1–І6, І20 (`run-tests db --filter storage-` у
`packages/designer/src/__tests__/storage-*.db.test.ts`) зелені й червоніють
на своїх дефектах; `platform-triggers.test.ts` знає нові тригери; версія
рядка після вставки з `file_attach` дорівнює 1.

### Task 3: тест-інфра — S3 і прибирання бакетів

- `@aws-sdk/client-s3` — devDependency `simetra` (точна версія, ліцензія за
  `LICENSE`).
- `s3Of(stack)`: Garage — `127.0.0.1:3900`, регіон `garage`, dev-ключ з
  `docker/postgres-stack/dev-secrets.env` (читати, не змінювати); Supabase —
  значення з `globalSetup` через `provide` (Р14).
- `AllowBucketKey`, `emptyAndDeleteRunBucket` і новий хід
  `removeRunResources` за Р14.
**Готово:** `run-tests unit --filter external.test.ts` (І13; спорожнення,
потім видалення; збій S3 → звіт) зелений. Перерваний SIGINT прогін з
об'єктом у бакеті Garage не лишає бакета (`fixtures/interrupted-run.ts`,
`run-tests db --filter interrupt`).

### Task 4: T3 — `FileStore` і `fromS3Client`

Файл `src/server/file-store.ts` з експортом з `src/server/index.ts`. Тести:
І9; `get` відсутнього ключа → `null`; `list` лише префікса зі сторінками;
маркер Р12.
**Готово:** `run-tests unit --changed` на фейковому `S3ClientLike` зелений;
у зоні T3 немає імпорту SDK.

### Task 5: T3 — `checkUpload`, `attachFile`, видалення після коміту

- `checkUpload`: `READ ONLY` під роллю запиту, `storage_headroom`.
- `attachFile` — одна спроба `attempt` з тими самими ретраями й бюджетом,
  що й `run`: `file_attach` під `simetra_files`, далі `create` під
  `simetra_command` (Р17). Внутрішня фаза, без публічних дверей для SQL (Рт6).
- Опція `files` і Р5.
**Готово:** DB-тести І3, І11 і повний цикл `checkUpload` → `put` →
`attachFile` → `read` → `delete` на Garage зелені (`run-tests db --filter
storage-`). Тест повтору: другого рядка обліку немає.

### Task 6: T3 — `reconcileFiles`; тест `supabase`

- Алгоритм §8.2 з Р10, Р12 і Р13: кандидати збираються за прогін;
  запобіжник і маркер перевіряються до будь-якого видалення.
- id перевіряються сторінками по 1000; кожна сирота перед видаленням
  перевіряється ще раз.
- `storage.supabase.db.test.ts` проходить повний цикл через S3 Supabase (Р1).
**Готово:** І10 і І12 зелені на Garage (`run-tests db --filter storage-`);
тест `supabase` зелений (`run-tests db-supabase --filter storage`); CI на
draft PR зелений повністю.

**Готово А:** тести §8 рівнів unit і DB зелені на `postgres` з Garage.
Повний цикл зелений на `supabase`. Перерваний прогін не лишає бакетів.

## Частина Б (після П4-D; не виконується в цьому блоці)

Якорі: `packages/create-simetra-app/template/src/server/{runtime,origin,auth,body-limit,request-guard}.ts`,
лінт шаблону, `checkRequestOrigin` з `simetra/server`. Перед стартом —
ревізія за `orient --plan`.

### Task 7: шаблон — маршрути файлів

Маршрути Р16 у `template/src/routes/api/files/`, порядок: походження (І17);
сесія, анонім → 401; `checkUpload`, `null` → 403; ліміти Р15; `put`;
повторна `verifySession`; `attachFile`: відкат → `files.delete`,
`commitUnknown` → нічого (І14). Читання: `runtime.read`, потім `get` із
заголовками І16. Клієнт S3 живе лише в `src/server/files.ts`; змінні
`SIMETRA_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`,
`_REGION` читає тільки він; без них він падає. Лінт шаблону: `@aws-sdk/*`
лише в `src/server/files.ts`. `runtime.ts` передає `files`.
**Готово:** unit І14–І17 і І19, тест збірки І18 зелені.

### Task 8: шаблон — звірка й e2e

Скрипт `pnpm reconcile-files` друкує `ReconcileReport` і повертає ненульовий
код, коли `refused`. e2e на стенді з Garage: повний цикл; 404 на чужий рядок
без звернення до бакета; анонім і користувач без права не пишуть байтів; 413.
**Готово Б:** e2e зелені.

## Задачі власника (виконуються лише після апруву)

- `AGENTS.md`, абзац про run tag: «removes its own containers and its empty
  buckets, and reports a non-empty bucket» → «empties and removes its own
  buckets, and reports a bucket it could not empty». Речення передає
  архітекторка разом із PR частини А.

## Review Focus

1. Повтор `attempt` в `attachFile`: запис `storage_pending` прив'язано до
   `xact`, тож повтор не дає ні подвійного обліку, ні осиротілого запису.
2. Перемикання ролі в спробі `attachFile` повертає `simetra_command` до
   фази `create` на кожній гілці, зокрема після відмови `file_attach`.
3. `Content-Length` відсутній або бреше: межу тримає лічба в `put`.
4. Рядок з'являється чи зникає під час звірки: не дефект і не видалення.
5. Рядок файлу видалено каскадом: байти забирає лише звірка через 24 год.

## Аудит

Ревізія 2026-11-09 (PR #81): раунд Sonnet і Opus, вузький раунд Opus і раунд
Codex; знахідки внесено (Р1, Р4, Р5, Р11–Р15, Р17, І14–І19), відхилення Р1 і
окрему роль прийняла архітекторка.

Ревізія 2026-11-22 під `main`: — (заповнюється після аудиту).
