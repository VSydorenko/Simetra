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
  безрядкової частини права (Р3) настає до першого байта в бакеті.
- `project.storageBuckets` (Storage-API прийнятих баз, ПП4) не змінюється;
  пункт боргу #128 про його політики — поза блоком.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Бекенд байтів у `supabase`** — `fromS3Client` над S3-протоколом Supabase Storage, приватний бакет; SQL-частина нейтральна до профілю; прийняті бази — на Storage-API. **Прийняте відхилення:** S3-ключ Supabase діє на весь проєкт, тож §8.2 «ключ лише цього бакета» в `supabase` не виконується. Запобіжники: ключ лише в серверному середовищі host-а (І18), бакет і ключ об'єкта задає лише сервер (І19). На `postgres` ключ Garage обмежено бакетом | ПП4, §8.4; §8.2 — відхилення (задача 0) |
| Р2 | **Частини А/Б.** Маршрути й звірка в шаблоні — після П4-D | немає |
| Р3 | **Попередня перевірка — одна definer-функція** `storage_headroom(p_object, p_scope)`: `false`, коли жоден безрядковий грант `create` не покриває `p_scope`, `p_scope` поза межею скоупу користувача, об'єкт без `storage` або файл розміру `maxBytes` не вміститься. Умову прав беруть будівники політик: `rowFreeGrants(rights, "create", main)` (АБО над `any`/`own`/`dim`; для нескоупленого — `has_right`) і `tenantBoundary` / `scopeSetCall`; другої копії правила немає. Перевірка необхідна, не достатня: умови значень рядка (носій власності, вимір, контейнер) судить `INSERT` в `attachFile`, після відомого відкату байти видаляються (І14). Одне булеве не розкриває, яка умова відмовила. Гість і анонім — `null` без SQL | §8.2 крок 2 (задача 0) |
| Р4 | **Розмір і тип пишуться в `INSERT`.** `file_attach(p_object, p_id, p_size, p_type)` перевіряє тип і розмір проти `storage` і пише запис `simetra.storage_pending` з унікальним ключем (`pg_current_xact_id()`, об'єкт, id); повтор для того самого id відмовляє. Тригер `BEFORE INSERT` (definer) забирає запис (`DELETE … RETURNING`) і ставить колонки; без запису — `storage.attach-missing`. Після `create` `attachFile` під `simetra_files` перевіряє, що записів поточної транзакції не лишилось; чужі `xact` прибирає звірка. Причина: `UPDATE` після `create` піднімав би версію, тригери прав і змісту й облік на `UPDATE`. Інший шлях вставки (клієнтська `create`, `ctx.run`, копіювання) відмовляє | §8.1, §8.2 крок 4, §8.3 (задача 0) |
| Р5 | **Байти видаляє лише звірка.** Довідник зі `storage` не має ядра `delete` (ядро `delete` є лише в призначень, а Р9 забороняє їм `storage`): рядок позначається `markDeletion` і зберігає файл — це семантика позначки; фізично рядок зникає лише каскадом (власник, скоуп) чи майбутнім очищенням позначених. Байти таких рядків прибирає `reconcileFiles` через 24 год. Опції `files` у `createCommandRuntime` і видалення в `afterCommit` немає | §8.2 «Видалення» (задача 5) |
| Р6 | **Методи T3:** `checkUpload`, `attachFile`, `reconcileFiles` (у маршруту немає SQL). `attachFile` мапить ім'я в стильований `file_name` (`naming.attributeCase`) і віддає `commitUnknown`, коли `terminalOf` дав `command.unavailable` після надісланого `COMMIT` | §8.4 (задача 0) |
| Р7 | **`fromS3Client`** над структурним клієнтом (`putObject`, `getObject`, `deleteObject`, `listObjectsV2` — форма агрегатного `S3`). `put` сам рахує байти, обриває потік понад `maxBytes` і буферизує тіло для `ContentLength`; стеля T0 `STORAGE_MAX_BYTES` = 100 MiB. Розмір у `file_attach` — лише з `put` | §8.1, §8.4 (задача 0) |
| Р8 | **Реквізити файлу** — умовні колонки `standardColumns` довідника за `catalog.storage`: `file_name` (`text`, not null, зміст), `file_size` (`bigint`), `file_content_type` (`text`), логічні імена за `standardLogicalName`. Дві останні — у `platformWrittenNames`, поза `contentColumns` (`nonContentStandardNames`), незмінні (`BEFORE UPDATE OF` відмовляє) | немає |
| Р9 | **Сумісність `storage`:** лише `Catalog`, без `role`, `membership`, `rightsContainer`, `containerBinding`, `predefinedItems`, `hierarchyType: "FoldersAndItems"` і не корінь виду скоупу (вставку кореня судить `rootCreatePredicates`, а не Р3) — `storage.incompatible`. `mediaTypes` — непорожній перелік унікальних `type/subtype` малими літерами без параметрів (`storage.media-type`); `maxBytes` — 1…`STORAGE_MAX_BYTES`. `containerBinding` — бо `storage_headroom` (`rowFreeGrants`) гранти за контейнером пропускає. `storage`, доданий об'єкту з живою таблицею, — `plan.storage-added` (`schema/apply/plan.ts`) | §8.1 (задача 0) |
| Р10 | **Рядки без байтів** — `storage_row_page(p_object, p_after uuid) RETURNS SETOF uuid` (definer, до 1000 id); рядок, що з'явився під час переліку, не дефект | §8.2 (задача 0) |
| Р11 | **Відмови сховища — закритий перелік T0** `STORAGE_ERRORS` за зразком `COMMAND_CORE_ERRORS`: причини `attach-missing`, `attach-invalid`, `quota-exceeded`. `mapDatabaseError` дає `command.rejected` з `reason` `storage.<причина>`; інакше `RAISE` став би `command.internal`. `LIMIT_REASONS` не змінюється | спека П4 §6.10 (задача 0) |
| Р12 | **Прив'язка бази й бакета.** `simetra.storage_instance` — безумовна платформна таблиця стану з одним рядком випадкового uuid, що переживає повторне застосування й видалення всіх об'єктів зі `storage`. Прибрати `storage` з об'єкта з живою таблицею — `plan.storage-removed`. Маркер `simetra-instance` несе відбиток `uuid:sysid:oid:timeline` (`system_identifier`, oid бази, timeline з імені поточного WAL-файла; рахує `storage_instance_id()`): копія бази (dump, TEMPLATE, PITR, репліка) має той самий uuid, але інший `sysid`/oid/timeline. `put` пише маркер лише в порожній бакет; непорожній без маркера чи інший uuid — `foreign-bucket`; той самий uuid з іншою частиною відбитка — `binding-changed` (відмова `put` і звірки, `report.refused` = `instance` / `binding`). Поки `pg_is_in_recovery()` — звірка нічого не видаляє (`recovery`). Після законного відновлення — `runtime.rebindFileStore(store)`. Залишок — холодна копія каталогу без відновлення — в спеці й експлуатації. Причина: чужий бакет має ті самі префікси, і запобіжник 5 %/20 не зупинив би видалення живих байтів | §8.2 (задача 0) |
| Р13 | **Звірка бере «зараз» з бази** (`now()`), а не з годинника host-а | §8.2 (задача 0) |
| Р14 | **Бакети тестів.** Прибиральник адресує рівно `runBucketName(<свій тег>)`, без відбору за префіксом і без `simetra-dev`. `removeRunResources`: спорожнити (`ListObjectsV2` + `DeleteObjects`), потім видалити; звітувати лише бакет, який спорожнити не вдалося. Garage: `createRunBucket` + admin `AllowBucketKey` (новий endpoint у `garage()`). Supabase: `run-<тег>` через S3 `CreateBucket`, знімок guard-а читає `storage.buckets` (перевірити `SELECT` ролі guard-а); значення S3 — з одного `supabase status -o env` у `globalSetup`, у тести через `provide`/`inject` (новий механізм) | §10.3 (задача 0); речення `AGENTS.md` — власник |
| Р15 | **Шаблон (частина Б):** ліміт одночасних завантажень (429), бюджет буфера (503), не більше 10 хв між `put` і `attachFile`; звірка — `pnpm reconcile-files` за cron оператора, без HTTP | §8.2 (задача 0) |
| Р16 | **Маршрути (частина Б):** `POST /api/files/$object` (сире тіло, метадані в `X-Simetra-File`, сувора схема), `GET`/`DELETE /api/files/$object/$id` (`DELETE` — `markDeletion`); завантаження обходить `limitBody`, межа — `maxBytes` (413 до тіла) | спека П4-D: виняток з `limitBody` (задача 0) |
| Р17 | **Роль `simetra_files`** — `NOLOGIN NOINHERIT`, запис `PLATFORM_ROLES`, як `signalConsumer` **не** призначення гранту: генератор сховища пише їй `USAGE ON SCHEMA simetra` і `EXECUTE` явним `GRANT` після `executeGrants(signature, [], provider)`, тож декларація застосунку її не адресує. Виключення «ключ `PLATFORM_ROLES`, не призначення» (тип `PlatformRolePurpose` і фільтр `callersOfRole`) стає однією сталою T0. Лише вона має `EXECUTE` на `file_attach`, `storage_rows_exist`, `storage_row_page` і перевірку залишку `storage_pending`. Членство: `LOGIN_ROLE_PARENTS.runtime` += `files` (`INHERIT FALSE, SET TRUE`), `supabase/roles.sql` адитивно, `postgres` — `simetra roles`; `inspect()` доводить його `SET LOCAL ROLE`, як для `simetra_command`. `command.privileged-login` без змін. `attachFile`: `SET LOCAL ROLE simetra_files` → `file_attach` → `SET LOCAL ROLE simetra_command` → фаза `create`. Межа: з SQL модуля (`simetra_command`) виклик відмовляє в базі; `SET ROLE`/`set_config('role', …)` — `sql.command-context-write`; виклик з definer-функції застосунку — `sql.platform-function-call` і Р18 (І7) | ПГ11, спека П4 §6.2 (задача 0) |
| Р18 | **Рішення архітекторки (клас, не лише ПГ-5).** `checkPlatformCalls` судить лише кваліфікований `simetra.*`, а definer-функція застосунку могла змінити порожній `search_path` у тілі й кликати функцію платформи без схеми. `search_path` додається в `PROTECTED_SESSION_SETTINGS.names`: наявна перевірка контексту команди (`compiler/sql/command-context.ts`) відмовляє запису в усіх формах (`SET`, `SET LOCAL`, `RESET`, `RESET ALL`, `set_config`, динамічний текст) — одне правило, один перелік. Строгість — як у платформного префікса: помилка й у боргу прийнятих функцій (клас ремонту), не попередження. Опція оболонки `CREATE … SET search_path = ''` лишається дозволеною (її судить `closed-forms.ts`); перевірити, що обхід дерева `CREATE` не приймає її за запис | спека декларацій функцій, спека прав §5.3 — у PR задачі 2 |

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
| І5 | `storage_headroom` — `false` для кожної умови Р3: жоден безрядковий грант `create` не покриває скоуп, скоуп поза межею користувача, об'єкт без `storage`, файл не вміститься; `true` для ролі лише з `create@own` і лише з `create@dimension` у скоупі та для нескоупленого об'єкта з `has_right`. Роль запиту не читає `storage_usage` і `storage_quota` | DB під `asRole("user")` | без перевірки права; без межі скоупу; лише `rights_any` замість `rowFreeGrants`; `GRANT SELECT` ролі запиту |
| І6 | `storage_rows_exist` і `storage_row_page` бачать рядки чужого тенанта, відмовляють для об'єкта без `storage` і понад 1000 id. `has_function_privilege` на `file_attach`, `storage_rows_exist`, `storage_row_page` — `false` для `simetra_command`, `PUBLIC`, `simetra_user`, `simetra_anon`, `anon`, `authenticated`, `service_role`; під `SET ROLE simetra_files` виклик `file_attach` справді проходить (`USAGE` схеми) | DB, обидва профілі | `GRANT EXECUTE … TO simetra_command`; без `REVOKE … FROM PUBLIC`; `SECURITY INVOKER`; без `GRANT USAGE ON SCHEMA` ролі |
| І7 | Виклик функцій сховища в SQL застосунку (модуль, названий запит, декларована функція, definer-функція, динамічний текст) — `sql.platform-function-call`; `SET ROLE simetra_files` і `set_config('role', …)` — `sql.command-context-write`; запис у `simetra.storage_*` — діагностика правила 1; кожна форма запису `search_path` у SQL застосунку — помилка, зокрема в боргу; definer-функція з `SET search_path` у тілі — відмова; опція `CREATE … SET search_path = ''` проходить (Р18). `simetra_files` не призначення гранту: `callersOfRole("simetra_files")` → `undefined`, вербатимний `GRANT EXECUTE … TO simetra_files` у SQL застосунку відмовляє | unit | функція в `PLATFORM_READ_FUNCTIONS`; таблиці поза платформними таблицями знімка; `files` пропущено у фільтрі `callersOfRole`; `search_path` поза `PROTECTED_SESSION_SETTINGS` |
| І8 | `fileObjectKey` відкидає не-UUID. Ключ ззовні не приймається | unit | конкатенація без перевірки |
| І9 | `put` обриває потік на `maxBytes + 1` і не лишає об'єкта. Розмір у `file_attach` — з `put` | unit + Garage | розмір з `Content-Length` |
| І10 | Звірка видаляє сироту, старшу за 24 год; молодшу й з рядком чужого тенанта не чіпає. Невідомий префікс журналює. Перелік — лише префікс. Запобіжник > 5 % **і** > 20 | DB + Garage | існування через RLS-читання; перелік поза префіксом; без межі 20 |
| І11 | Байти не зникають при `markDeletion`: рядок і файл лишаються, облік обсягу не змінюється. Клієнтська `delete` довідника зі `storage` — `command.invalid` (ядра немає). Видаляє лише звірка (І10) | DB + Garage | видалення байтів у `afterCommit` рантайму; ядро `delete` для `storage` |
| І12 | Розбіжність маркерів, непорожній бакет без маркера чи зміна будь-якої частини відбитка (sysid, oid, timeline) окремо — нуль видалень і відмова `put`; `pg_is_in_recovery()` — нуль видалень; після `rebindFileStore` звірка знову працює | unit на фейках + DB + Garage | без перевірки маркера; маркер пишеться в непорожній бакет; кожну частину відбитка по черзі прибрати з порівняння; прибрати перевірку репліки |
| І13 | Прибиральник не звертається до S3 для порожнього тегу, `simetra-dev`, тегу іншого прогону (навіть валідного за `isRunTag`) чи бакета Supabase без `run-` | unit на фейках | відбір за префіксом |
| І20 | Рантайм без членства `simetra_files` не стартує: названа відмова `command.read-role-missing` з роллю (помилка на `inspect`, не на першому завантаженні) | DB | без перевірки членства в `inspect` |
| І21 | Маркер переживає видалення останнього об'єкта зі `storage` і повторне застосування: uuid той самий. Прибрати `storage` з об'єкта з живою таблицею — `plan.storage-removed` | DB (план) | таблиця маркера умовна; без відмови плану |

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
- Таблиці — платформні таблиці знімка з RLS, без грантів ролям API й команд;
  `storage_instance` безумовна (Р12), рядок вставляється ідемпотентно.
- Роль `simetra_files` (Р17): `PLATFORM_ROLES`, стала виключених
  призначень, `LOGIN_ROLE_PARENTS`, `supabase/roles.sql`, перевірка в
  `inspect()`. Форму ролей і членств фіксують і мають оновитися:
  `platform-roles.test.ts`, `stack-roles.postgres.db.test.ts`,
  `db-roles.supabase.db.test.ts`, pgTAP
  `test/db/pgtap/postgres/stack-base-state.pgtap.sql` і
  `supabase/tests/provider-base-state.test.sql` (останні два — лише CI-рівні
  `db`/`db-supabase`; перевірити CI після push).
- Функції: definer, `SET search_path = ''`, `executeGrants(…, [], provider)`
  і явний `GRANT EXECUTE`: `storage_headroom` — ролі запиту користувача,
  решта — лише `simetra_files`.
- Права в `storage_headroom` — з будівників політик вставки (Р3).
- Нескоуплений об'єкт веде облік під `ZERO_UUID` (§8.3).
- Р18: `search_path` у `PROTECTED_SESSION_SETTINGS.names` і поправки спек декларацій функцій та прав §5.3.
- `plan.storage-added` (Р9), `plan.storage-removed` (Р12); мапінг `STORAGE_ERRORS` у `mapDatabaseError` (Р11).

Роль на спільних стеках: CI створює її на своїх стеках. Локальний `postgres`
отримує її через `simetra roles`, локальний Supabase — через `pnpm db:roles`.
Обидва адитивні й ідемпотентні; запускає їх виконавець перед першим DB-тестом
задачі й повідомляє архітекторці в звіті задачі (інші сесії не ламаються:
роль нова, чужих об'єктів не змінює).
**Готово:** compile-тести, І7 (`run-tests unit --changed`) і DB-тести
І1–І6, І20, І21 (`run-tests db --filter storage-` у
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

### Task 5: T3 — `checkUpload`, `attachFile`, `rebindFileStore`

- `checkUpload`: `READ ONLY` під роллю запиту, `storage_headroom`, далі в тій самій
  транзакції `SET LOCAL ROLE simetra_files` і читання відбитка прив'язки
  (`UploadLimits.instance`); кешу немає, `put` судить саме це значення.
- `attachFile` — одна спроба `attempt` з тими самими ретраями й бюджетом,
  що й `run`: `file_attach` під `simetra_files`, далі `create` під
  `simetra_command` (Р17). Внутрішня фаза, без публічних дверей для SQL (Рт6).
- `rebindFileStore(store)` — серверний метод оператора; `fileInstance()` немає
  (відбиток віддає `checkUpload`, звірка й перев'язка читають його свіжим);
  Р5: рантайм байтів не видаляє.
**Готово:** DB-тести І3, І11 і повний цикл `checkUpload` → `put` →
`attachFile` → `read` → `get` → `markDeletion` (байти лишаються) на Garage зелені (`run-tests db --filter
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
лише в `src/server/files.ts`.
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

Ревізія 2026-11-22 під `main` (`orient --plan`, три розвідки коду): виправлено
застарілі припущення про ролі, мапінг помилок, правило 1, реєстрацію
генератора, ключ видалення, тест-інфру й команди. Раунд 1: Sonnet «план
проти спеки й коду» — 2 major (`USAGE` схеми; pgTAP форми ролей) — внесено.
Opus «безпека» — 2 major (Р3 через `rights_any` відмовляв `create@own` і
`create@dimension`; маркер зникав з останнім об'єктом), 1 minor (друга копія
виключення в `callersOfRole`) — внесено. Codex (6 питань, 42 файли): blocker
Р3 — той самий, що в Opus, закрито; blocker «`search_path` у тілі
definer-функції відкриває некваліфікований виклик» — підтверджено в коді,
клас поза ПГ-5 → Р18 на апрув; minor «`RAISE` застосунку підробляє пару
`STORAGE_ERRORS`» — лишено: наслідок лише хибна причина, як у `ctx.reject`.
Архітекторка прийняла план 2026-11-22: Р3, Р12, Р17 затверджено, Р18 — через `PROTECTED_SESSION_SETTINGS`.
