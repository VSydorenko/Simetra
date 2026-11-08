# Профіль провайдера `postgres`: ролі, ідентичність, outbox, файли, стек

> **Статус:** проєкт детальної спеки від 2026-11-08, автор — сесія автора
> профілю; рішення приймає архітекторка `runtime-client-data`. Закриває
> відкриті питання §5 [спеки профілів провайдера](2026-10-23-provider-profiles-design.md).
> **Напрям власника (2026-11-08).** Профіль `postgres` — основний: чистий
> Postgres 17, Centrifugo (сигнали), Garage (файли), Better Auth
> (ідентичність). Профіль `supabase` лишається. Realtime — частина стеку з
> першого дня в **обох** профілях; транспорт сигналу один — outbox →
> вбудований PG-споживач Centrifugo → канал з токеном від сервера. Supabase
> Realtime не використовується й у профілі `supabase`.
> **Межа з редакцією 3 спеки П4-B.** Формат сигналу, канали,
> `signal_topic_allowed` в обох режимах, `runtime.authorizeChannels`,
> політика `INSERT` на outbox у режимі відправки, порт каналу з `recovered`
> і приймач — у спеці П4-B (редакція 3). Ця спека дає транспорт під ними:
> таблицю outbox, споживача, з'єднання, конфіг Centrifugo, підпис токена.
> **Шляхи:** без префікса — це репо.

---

## 1. Мета й критерії

Спека профілів (ПП1–ПП7) ухвалила форму профілю `postgres`, але лишила
механізми її §5 відкритими. Ця спека дає їм правило, причину, вплив на код
і тест, а також стек розробки й CI для обох профілів і порядок блоків.

**Критерії успіху:**

1. Застосунок на `postgres` запускається без жодного компонента Supabase:
   Postgres 17 з contrib, Centrifugo, Garage, Better Auth у host-і.
2. Застосунок перемикається між профілями зміною `database.provider` і
   переходом даних; метадані й модулі не змінюються (ПП1).
3. Шлях сигналу однаковий в обох профілях: та сама таблиця outbox, той самий
   споживач, ті самі канали й токени.
4. DB-тести платформи йдуть на стеку `postgres` типово; на стеку `supabase`
   лишаються регресійні набори прийому й пресета провайдера.

## 2. Рішення

| № | Рішення | Чому |
| --- | --- | --- |
| ПГ1 | **Ролі запиту `postgres` створює платформа:** `simetra_user` (запит користувача) і `simetra_anon` (анонімна сесія, гість), обидві `NOLOGIN NOINHERIT`; `simetra_runtime` — член обох з `SET`. Сервісної ролі профіль не має: `PROVIDER_API_ROLES.postgres.service` — `null` (§3) | у чистому Postgres ролей API немає; `simetra_anon` читає анонімна сесія Better Auth (§4.4); сервісна роль у шляхах застосунку не використовується (платформна спека §6.7), тож роль-заглушка була б мертвим об'єктом |
| ПГ2 | **Роль-власник `simetra_owner`:** `LOGIN NOSUPERUSER NOINHERIT BYPASSRLS CREATEDB NOCREATEROLE NOREPLICATION`; від неї йде застосування. План у профілі `postgres` відмовляє `plan.owner-not-bypassrls`, коли роль застосування не має `BYPASSRLS` і не суперкористувач (§3.3) | definer-функції з `SET row_security = off` на відношенні під чужим RLS дають `42501`; ранній гейт перетворює збій на рантаймі в зрозумілу відмову плану |
| ПГ3 | **Кластерні ролі створює один крок `simetra roles` від суперкористувача;** далі `simetra_owner` суперкористувача не потребує (§3.4) | `BYPASSRLS` може видати лише роль, яка сама його має, членства — роль з `ADMIN`, розширення поза довіреними — суперкористувач; один разовий крок від суперкористувача дає все це без постійно привілейованої ролі застосування |
| ПГ4 | **Пресет ідентичності Better Auth** — запис даних `PROVIDER_IDENTITY_SOURCES.postgres`: схема `better_auth`, таблиця `user`, ключ `id` типу uuid, імена `name` → `email`, анонімність `isAnonymous`, без м'якого видалення, ключ провайдера `better-auth` (§4) | спека профілів ПП5 і С3: новий провайдер — новий запис даних, а SQL провізії один |
| ПГ5 | **Claims із сесії Better Auth формує host:** `{ sub: user.id, is_anonymous }`; JWT для бази немає, claims ставить `set_config` (§4.4) | контракт сесії (С5) не залежить від провайдера; підпис JWT лише для бази — зайвий секрет |
| ПГ6 | **Outbox — `simetra.signal_outbox` у форматі споживача Centrifugo**, один розділ, `id bigserial`, тригер `NOTIFY` рівня оператора; однакова в обох профілях (§5) | вбудований споживач читає таблицю напряму, ретранслятора немає (ПП3); один розділ — бо порядок дають версії, а не канал |
| ПГ7 | **Споживач outbox — логін `simetra_signals`** з `SELECT` і `DELETE` лише на outbox через групову роль `simetra_signal_consumer` (членство `SET`, роль ставить `ALTER ROLE … SET role`); обидва DSN споживача — пряме з'єднання або пулер у сесійному режимі, transaction-режим заборонено (§5.3) | споживач тримає `LISTEN` і advisory lock транзакції; найменші права обмежують шкоду від витоку DSN |
| ПГ8 | **Простори Centrifugo `simetra`, `simetra-rights`, `simetra-user`** з історією й `force_recovery`; клієнт не публікує, не читає історію й не підписується без токена (§6) | recovery скорочує перечитування після короткого розриву; коректність однаково не стоїть на доставці (рішення T4 §3.6) |
| ПГ9 | **Токени Centrifugo — EdDSA (Ed25519), ключі через JWKS host-а**, з `kid` і правилом перекриття під час ротації; TTL токена каналу 5 хв, з'єднання — 15 хв (§6.3) | JWKS дає ротацію без перезапуску Centrifugo; короткий TTL обмежує час, коли відкликане право ще тримає підписку |
| ПГ10 | **Порт сервера сигналів вузький — лише видача токенів** (з'єднання, канал) і JWKS; публікації йдуть через outbox, присутності немає (§7) | ширший контракт (публікація з сервера, присутність) не має споживача; кожен метод порту — поверхня для другого адаптера |
| ПГ11 | **Порт сховища файлів** `FileStore` (put, get, delete) зі структурним адаптером S3; файл — рядок об'єкта з властивістю `storage`; ключ виводиться з id об'єкта й рядка (`o/<об'єкт>/<id>`) і в рядку не зберігається; розмір і тип пише лише платформа; облік обсягу — тригер у транзакції запису рядка (§8) | межу тенанта тримає RLS рядка й серверний ендпоінт, бо Garage не має політик на префікси; ключ з id рядка не залежить від вводу клієнта |
| ПГ12 | **Перехідного PostgREST у `postgres` немає.** Джерело читання — лише Server Function (ПП2) (§9) | PostgREST вимагав би JWT, підписаного для бази, — другий шлях автентифікації й другий секрет |
| ПГ13 | **Стек розробки й CI `postgres` — docker compose:** Postgres 17 (образ репо з pgTAP і `plpgsql_check`), Centrifugo, Garage; команди `pnpm db:pg:*`; DB-тести типово йдуть на ньому; стек `supabase` — регресійний (§10) | основний профіль має бути основним і в тестах; спільна дисципліна stack-guard діє на обох стеках |

## 3. Ролі

### 3.1 Склад ролей профілю

| Роль | Атрибути | Членство | Хто створює |
| --- | --- | --- | --- |
| `simetra_owner` | `LOGIN NOSUPERUSER NOINHERIT BYPASSRLS CREATEDB NOCREATEROLE NOREPLICATION` | — | `roles` від суперкористувача |
| `simetra_command` | `NOLOGIN NOINHERIT` | без змін | `roles` |
| `simetra_runtime` | `LOGIN NOINHERIT` | `simetra_command`, `simetra_user` і `simetra_anon`, усі `WITH INHERIT FALSE, SET TRUE` | `roles` |
| `simetra_user` | `NOLOGIN NOINHERIT` | — | `roles` |
| `simetra_anon` | `NOLOGIN NOINHERIT` | — | `roles` |
| `simetra_signal_consumer` | `NOLOGIN NOINHERIT` | — | `roles` |
| `simetra_signals` | `LOGIN NOINHERIT`; `ALTER ROLE simetra_signals SET role = 'simetra_signal_consumer'` | `simetra_signal_consumer` `WITH INHERIT FALSE, SET TRUE` | `roles`, в обох профілях |
| `simetra_auth` | `LOGIN NOINHERIT` | — | `roles`; власник схеми `better_auth` |

Правила:

- Імена — дані T0 (`packages/simetra/src/model/schemas/project.ts`):
  - `PROVIDER_API_ROLES.postgres = { user: "simetra_user", anonymous: "simetra_anon", service: null }`;
  - `LOGIN_ROLE_REQUEST_PURPOSES.postgres = ["user", "anonymous"]`;
  - `PLATFORM_ROLES` дістає `signalConsumer: "simetra_signal_consumer"`;
  - `PLATFORM_LOGIN_ROLES` дістає `signals: "simetra_signals"` (в обох
    профілях);
  - нова мапа T0 `LOGIN_ROLE_PARENTS` — дозволені батьки кожної ролі входу
    платформи: `runtime` — `simetra_command` і ролі запиту за
    `LOGIN_ROLE_REQUEST_PURPOSES`; `signals` — лише
    `simetra_signal_consumer`. Гейт ролей (`platformRoleRefusals`,
    `checkPlatformRoles`) звіряє кожну роль входу за її рядком, а не за
    спільною множиною; `PlatformRoleSet.login` стає переліком. Без цього
    `simetra_signals` з членством у `simetra_command` пройшов би гейт, і
    витік DSN споживача дав би роль команд;
  - `PROVIDER_LOGIN_ROLES.postgres = ["simetra_auth"]`;
  - нова мапа `PROVIDER_OWNER_ROLES = { supabase: "postgres", postgres: "simetra_owner" }`
    — очікувана роль застосування.
- Паролі ставить оператор поза платформою (спека П4 §6.2): секретів
  платформа не тримає.
- Інваріанти членства спеки П4 §6.2 діють без змін і для `simetra_user`:
  `simetra_command` і роль запиту не члени одна одної; з ролі запиту не
  досяжна роль з `ADMIN` на ролі платформи чи з `SUPERUSER`.
- `simetra_signals` — роль входу у формі пари гейта ролей
  (`INHERIT FALSE, SET TRUE`, як `simetra_runtime`). Centrifugo не вміє
  `SET ROLE`, тож групу ставить налаштування ролі
  `ALTER ROLE simetra_signals SET role = 'simetra_signal_consumer'`: воно
  діє з першого оператора сесії. Без налаштування споживач лишається під
  роллю без привілеїв і падає `permission denied` — fail-closed. Гранти, як
  і раніше, не видаються ролям входу (`GrantPurpose` без ролей входу).
  Звірка `roles` перевіряє й налаштування ролі (`pg_db_role_setting`).
- **Кластер на застосунок.** Ролі кластерні, а імена фіксовані, тож логін
  одного застосунку (`simetra_auth`, `simetra_signals`, `simetra_runtime`)
  мав би ту саму владу в базі іншого застосунку того самого кластера. Тому в
  профілі `postgres` продовий кластер тримає одну базу застосунку Simetra.
  `roles` закріплює це двома кроками:
  - на цільовій базі — `REVOKE CONNECT … FROM PUBLIC` і адресний
    `GRANT CONNECT` ролям входу Simetra;
  - якщо роль входу Simetra вже має **явний** (не через `PUBLIC`) `CONNECT`
    до іншої бази — це база іншого застосунку, і `roles` відмовляє
    `roles.shared-cluster` з переліком баз.

  Службова база `postgres`, шаблони й тіні мають лише `CONNECT` для
  `PUBLIC` і перевірку не зачіпають. База іншого застосунку Simetra завжди
  має явні гранти, бо її готував той самий `roles`, тож перевірка її
  бачить. Сторонню базу з `CONNECT` для `PUBLIC` роль Simetra відкриває,
  але грантів на її об'єкти не має; це поза межею правила. Спільний стек розробки й тестів цього правила не порушує: тести
  працюють на тегованих іменах ролей (`packages/simetra/test/db/connection.ts`).
  Імена ролей із префіксом застосунку — окреме рішення разом із ролями
  `supabase` (там ролі провайдера теж фіксовані).

**Тип `ProviderApiRoles`.** Поле `service` стає `string | null`. Генератор
грантів пропускає отримувача `null`: функції множини скоупу й сесії не
дістають `EXECUTE` для сервісної ролі, бо її немає. Значення
`publicRead` (`authenticated`, `anon` у
`packages/simetra/src/model/schemas/public-read.ts`) — мітки призначення в
метаданих, а не імена ролей: генератор мапить їх на `PROVIDER_API_ROLES`
профілю. Перейменування міток не потрібне й у цю спеку не входить.

**Вплив на код:**

- `project.ts` — дані вище;
- `platform-roles.ts` — `platformRoleSet` за профілем, створення ролей
  запиту, власника й споживача, дозволений батько `simetra_signals`,
  налаштування ролі, `DEFAULT_REQUEST_NAMES` без `null`;
- отримувач `null` пропускають усі споживачі `service`:
  `compiler/access-units.ts`, `compiler/platform/units.ts`
  (`SESSION_ROLES`), `schema/apply/plan.ts`
  (`plan.service-role-access-lost`),
  `packages/simetra/src/schema/apply/promotion/access.ts`,
  `packages/designer/src/io/data.ts` (`dataGuardFactsParams`). Повний
  перелік дає `grep -rn "\.service\b" packages/*/src` перед блоком.

**Тест:** DB-тест `roles` на тегованих іменах — атрибути й рядки
`pg_auth_members` кожної пари за таблицею вище; повторний запуск нічого не
змінює; `simetra_runtime` без `SET ROLE` не читає таблиці виду; гейт ролей
відмовляє на `simetra_user` з членом-посередником з `CREATEROLE`.

### 3.2 Гранти ролей запиту

Генератор грантів (`tableGrants`, `executeGrants`) працює за призначенням,
тож у `postgres` він видає ті самі гранти, що й у `supabase`, але
отримувачам `simetra_user` і `simetra_anon`. Окремого коду профілю немає.
Додаткові гранти профілю — лише для outbox (§5.2).

### 3.3 Власник з `BYPASSRLS`

**Правило.** У профілі `postgres` роль застосування — `simetra_owner`. Вона
володіє схемою `simetra`, схемами застосунку й усіма керованими об'єктами
(платформна спека §6.7). На вході плану й застосування T2 читає атрибути
`current_user`; без `rolbypassrls` і без `rolsuper` — відмова
`plan.owner-not-bypassrls` з порадою `ALTER ROLE … BYPASSRLS` від
суперкористувача.

**Причина.** Definer-функції платформи йдуть із `SET row_security = off`
(функції прав, `rights_bump`, функції сигналів, обхід ієрархії). Postgres
у такому режимі не пропускає RLS мовчки: запит до відношення, на яке діє
чужа політика, падає `42501`. Власник таблиці RLS обходить сам, але не на
прийнятих таблицях-джерелах з іншим власником (спека прав §4.7) і не на
таблицях з `FORCE ROW LEVEL SECURITY`. У Supabase роль `postgres` має
`BYPASSRLS`; без того самого атрибута в `postgres` профілі ті самі функції
поводились би інакше. Fail-closed лишається: функція відмовляє, а не читає
порожню множину.

**Вплив на код:** перевірка в `packages/simetra/src/schema/apply/plan.ts`
за даними профілю (у профілі `supabase` вона теж діє: роль `postgres`
проходить); діагностика в `compiler/messages.ts`.

**Тест:** DB-тест — план від тегованої ролі-власника без `BYPASSRLS` дає
`plan.owner-not-bypassrls` до першого кроку; з атрибутом — план іде.

### 3.4 Хто створює ролі

- `simetra roles` у профілі `postgres` виконує суперкористувач (DSN
  оператора). Інструмент створює відсутні ролі §3.1, звіряє наявні, видає
  адресні гранти на `better_auth` (§4.2) і готує шаблон тіней з
  `plpgsql_check` (§3.5). Повторний запуск ідемпотентний.
- **Сесія суперкористувача захищена від об'єктів власника.** База належить
  `simetra_owner`, тож він може поставити `search_path` на базу чи
  покласти в `public` функцію з іменем вбудованої; суперкористувач `roles`
  виконав би її (клас CVE-2018-1058). Тому `roles` першим оператором ставить
  `SET search_path = pg_catalog, pg_temp`, кваліфікує кожне ім'я в своєму
  SQL і відмовляє `roles.unsafe-schema`, коли схема `extensions` належить
  не суперкористувачу. Тест: власник ставить `search_path` бази й кладе
  `public.format`; наступний `roles` цієї функції не викликає.
- `plan` і `apply` від суперкористувача не вимагають: `simetra_owner` має
  `CREATEDB` для co-located тіні (платформна спека §6.2).
- **Цільова база належить `simetra_owner`.** `roles` створює її
  (`CREATE DATABASE … OWNER simetra_owner`) або звіряє власника наявної;
  інший власник — відмова `roles.database-owner`. Причина: з Postgres 15
  схемою `public` володіє `pg_database_owner`, а схеми `simetra` і
  застосунку власник створює правом `CREATE` на базу.
- `roles` без суперкористувача у `postgres` відмовляє
  `roles.superuser-required` і нічого не створює: половина ролей без
  `BYPASSRLS` мовчки змінила б поведінку прав.

### 3.5 `plpgsql_check`

Перевірку тіл функцій дає `plpgsql_check` (платформна спека §6.11), а
промоція без нього — відмова (спека промоції §7.2). Розширення не довірене,
тож `simetra_owner` його не створює. Перевірки тіл ідуть на цілі й на
копії доказу; копію, як і тінь, адаптер pg-delta створює з `template0`
(`provisionCoLocatedShadow`), а раннер на копії без розширення пробує
`CREATE EXTENSION` сам — і від `simetra_owner` падає.

**Правило.** `roles` від суперкористувача:

1. ставить `CREATE EXTENSION IF NOT EXISTS plpgsql_check SCHEMA extensions`
   у цільовій базі (схема `extensions` — суперкористувача, `USAGE` для
   `simetra_owner`);
2. створює базу-шаблон `simetra_template` з `template0`, ставить у неї те
   саме розширення й позначає `IS_TEMPLATE true, ALLOW_CONNECTIONS false`.

У профілі `postgres` адаптер схемного рушія створює тінь і копію доказу
`CREATE DATABASE … TEMPLATE simetra_template` від `simetra_owner` (право
`CREATEDB` і позначка шаблону цього досить), а не через
`provisionCoLocatedShadow`, де `template0` зашитий. Тоді режим перевірки —
`installed` на цілі й на копії. Копія не створюється з цілі як шаблону,
тож даних цілі (зокрема таблиць `better_auth`) у ній немає.
`PROVIDER_INSTALLABLE_EXTENSIONS.postgres` — порожній перелік. Теговані
тестові бази стек створює з того самого шаблону.

**Вплив на код:** власна провізія co-located бази в
`packages/designer/src/schema-engine/pg-delta/adapter.ts` для `postgres`
(запасний шлях платформної спеки §6.2 — під доведену прогалину двигуна).
Прохання до pg-delta про опцію шаблону — зовнішня дія, її вирішує власник.

**Тест:** DB — ціль, тінь і копія доказу від `simetra_owner` мають режим
`installed`; у копії немає рядків цілі.

## 4. Ідентичність: Better Auth

### 4.1 Запис пресету

`PROVIDER_IDENTITY_SOURCES.postgres`:

| Поле `IdentitySource` | Значення | Чому |
| --- | --- | --- |
| `table` | `{ schema: "better_auth", name: "user" }` | фіксована схема дає статичний пресет гейта; ім'я таблиці — типове в Better Auth |
| `keyColumn` | `id` | з `advanced.database.generateId: "uuid"` колонка має тип `uuid` (С8: ключ облікового запису = `id` «Користувачів») |
| `nameSources` | `[{ column: "name" }, { column: "email" }]` | `name` у Better Auth обов'язкове, але може бути порожнім; порожні джерела генератор пропускає |
| `anonymousColumn` | `isAnonymous` | колонка плагіна `anonymous`; без плагіна колонки немає — див. нижче |
| `deletedAtColumn` | немає | Better Auth видаляє обліковий запис фізично (`deleteUser`) |
| `providerKey` | `better-auth` | значення `simetra.identities.provider` |
| `subjectIsUserId` | `true` | `sub` = `user.id` = id «Користувачів» |
| `anonymousClaim` | `is_anonymous` | той самий claim, що в `supabase` |

**Імена колонок.** Вбудований адаптер Better Auth (Kysely) створює колонки
з іменами полів, тобто `"isAnonymous"`, `"emailVerified"` у лапках.
Генератор провізії вже бере кожне ім'я через `quoteIdent`
(`packages/simetra/src/compiler/platform/units.ts`); тест пресету це
закріплює для імен у верхньому регістрі. Хост-шаблон фіксує
вбудований адаптер; адаптер Drizzle з `snake_case` — інша форма колонок і
поза пресетом.

**Плагін `anonymous` обов'язковий у шаблоні host-а.** Пресет посилається на
`isAnonymous`; без плагіна колонки немає, і тригер
`simetra_provision_converted_user` не створюється. Тому шаблон host-а
вмикає плагін завжди, а DB-тест пресету йде на таблиці з колонкою.

### 4.2 Схема й порядок розгортання

1. `roles` створює `simetra_auth` і схему `better_auth` з
   `AUTHORIZATION simetra_auth`.
2. Міграція Better Auth (`npx auth migrate` від `simetra_auth`, конфіг
   `database.schemaName: "better_auth"`) створює свої таблиці. Схемою
   володіє вона, а не платформа (ПП5).
3. Повторний `roles` (суперкористувач) видає адресно
   `GRANT USAGE ON SCHEMA better_auth TO simetra_owner` і
   `GRANT TRIGGER ON better_auth."user" TO simetra_owner` — лише на цю
   таблицю, без типових привілеїв схеми. Таблиці ще немає — `roles` називає
   пропуск.
4. `simetra apply` від `simetra_owner` ставить функції й тригери провізії
   так само, як у `supabase`: тригери — частина бажаного стану
   (`packages/simetra/src/compiler/platform/units.ts`), і гейт, план і
   доказ працюють з ними без винятків. Немає `better_auth."user"` на цілі —
   відмова плану `plan.identity-table-missing` з порадою виконати кроки 2–3;
   немає гранту — та сама відмова з іншою порадою.

**Межа довіри: власник рівний базі.** Тригер виконує функцію з правами
ролі, що змінює таблицю, якщо функція не `SECURITY DEFINER`. Тож власник
із `TRIGGER` на `better_auth."user"` (чи власник функції провізії, яку
кличе будь-який тригер) може виконати код від `simetra_auth` і прочитати
`better_auth.session` і `account`. Відділити від власника секрети Better
Auth не можна дешево, і це не мета: `simetra_owner` і так володіє всіма
даними застосунку з `BYPASSRLS` і функцією `current_user_id()`, тобто вже
може діяти від імені будь-якого користувача. Тому DSN власника — секрет
рівня суперкористувача бази: лише в кроці застосування, ніколи в рантаймі
чи host-і. Рантайм host-а не має DSN власника; гейт це перевіряє:
`createCommandRuntime` на першому з'єднанні читає атрибути
`session_user` і відмовляє `runtime.privileged-login`, коли роль входу —
роль застосування профілю (`PROVIDER_OWNER_ROLES`), член її, суперкористувач
чи має `BYPASSRLS` (DB-тест — рантайм на DSN власника не створюється). Типових привілеїв на всю схему `better_auth` немає, щоб
`TRIGGER` не розповзався на нові таблиці провайдера.

**Зняття й заміна тригера.** `DROP TRIGGER` вимагає власника таблиці, а
`TRIGGER` дає лише створення. Тому план відмовляє
`plan.identity-trigger-locked` на кроці, що знімає чи перестворює тригер
провізії на `better_auth."user"`, з порадою виконати цей крок від
`simetra_auth`. Це окрема перевірка плану, а не `PROVIDER_LOCKS`: та мапа
описує замки supautils з налаштуванням цілі, а в чистому Postgres їх
немає (`PROVIDER_LOCKS.postgres` — порожні `sources` і `services`). Зміна
тіла провізії тригера не чіпає: тіло — функція `simetra`.

Гейт бачить у схемі `better_auth` лише тригери провізії
(`PROVIDER_SURFACES.postgres`, клас `trigger`, таблиця `user`).

**Значення пресету `postgres` у мапах T0 і T2** (виконавцю не вгадувати):

| Мапа | Значення `postgres` |
| --- | --- |
| `PROVIDER_SCHEMAS` | `better_auth`, `extensions`, `information_schema` |
| `PROVIDER_EVENT_SOURCES` | `better_auth."user"` з колонками `id`, `name`, `email`, `emailVerified`, `image`, `createdAt`, `updatedAt`, `isAnonymous`; джерела `storage.objects` немає |
| `PROVIDER_FUNCTIONS` | порожньо (`auth.uid` тощо — лише `supabase`) |
| `PROVIDER_EXPRESSION_FUNCTIONS` | порожньо: `gen_random_uuid()` — ядро Postgres |
| `PROVIDER_SQL_TEXT_FUNCTIONS` | функції `dblink*` (contrib); решти записів `supabase` немає |
| `PROVIDER_SYSTEM_ROLES` | порожньо: `simetra_auth` не має типових привілеїв у схемах межі |
| `PROVIDER_SURFACES` | `{ schema: "better_auth", table: "user", classes: ["trigger"] }` |
| `PROVIDER_LOCKS` | `{ sources: [], services: [] }`; зняття тригера судить `plan.identity-trigger-locked` (див. вище) |
| `PROVIDER_INSTALLABLE_EXTENSIONS` | порожньо (§3.5) |
| `PROVIDER_EXPECTED_BLIND_FUNCTIONS` | порожньо |
| розширення поза керуванням | `plpgsql`, `plpgsql_check` |
| гранти схеми `public` у засіві тіні | лише вбудовані Postgres 15+ (`USAGE` для `PUBLIC`, власник — `pg_database_owner`) |
| засів тіні (`renderProviderSeed("postgres")`) | порожній: заглушку `better_auth."user"` дає профіль pg-delta (нижче) |
| профіль pg-delta (`scopeProfile`, `packages/designer/src/schema-engine/pg-delta/policy.ts`) | власний `IntegrationProfile` `simetra-postgres`: `assumedSchemas` — `better_auth`, `extensions`; без ролей і схем Supabase |

Споживачі, що зараз читають `PROVIDER_SCHEMAS.supabase` чи `SUPABASE_*`
напряму, переходять на `scope.provider`:
`packages/simetra/src/schema/engine/desired.ts`,
`packages/designer/src/schema-engine/census-read.ts`,
`packages/designer/src/schema-engine/pg-delta/policy.ts`,
`packages/designer/src/schema-engine/pg-delta/map-units.ts`,
`packages/designer/src/schema-engine/pg-delta/adapter.ts`,
`packages/designer/src/tools/database-tools.ts`. Перелік перед блоком
перераховує `grep -rn "\.supabase\b\|SUPABASE_" packages/*/src`.

**Тінь.** Заглушку `better_auth."user"` у тіні дає той самий механізм, що
й `auth.users` у `supabase`: pg-delta виводить засів припущених схем із
фактів цілі (`seedAssumedSchemas`). Тож колонки заглушки — колонки
справжньої таблиці цілі, зокрема всі колонки `PROVIDER_EVENT_SOURCES`, і
рукописного `CREATE TABLE` у пресеті немає. Для цього `scopeProfile` дає
для `postgres` власний профіль (таблиця вище) замість `supabaseProfile`.

### 4.3 Життєвий цикл облікового запису

| Подія Better Auth | Що бачить база | Що робить платформа |
| --- | --- | --- |
| реєстрація | `INSERT` у `user` з `isAnonymous` false чи `NULL` | тригер провізії: `identities` і рядок «Користувачі» в тій самій транзакції (С3) |
| анонімний вхід | `INSERT` з `isAnonymous = true` | пропуск: анонім не провізується (спека системної схеми §12) |
| прив'язка аноніма до постійного входу | `INSERT` нового `user` і `DELETE` анонімного (типова поведінка плагіна) | провізія нового; видалення аноніма — no-op, бо ідентичності немає |
| зміна `isAnonymous` з true на false на місці | `UPDATE OF "isAnonymous"` | тригер конвертації провізує тим самим шляхом |
| видалення облікового запису (`deleteUser`) | `DELETE` з `user`; сесії й облікові записи — каскадом Better Auth | тригер недійсності: видаляє `identities`, ставить `invalid` (С4) |
| бан (плагін `admin`) | `UPDATE` колонок `banned*` | нічого: бан діє на вході Better Auth; блокування в застосунку — платформна команда `invalid` (С4) |

FK з «Користувачів» на `better_auth."user"` немає (як С8 для Supabase).

### 4.4 Claims із сесії

Host реалізує порт `VerifySession` (`packages/simetra/src/model/runtime/session.ts`)
над Better Auth:

1. `auth.api.getSession({ headers })` → сесія чи `null`.
2. `null` → `null` (запит без сесії).
3. Інакше claims `{ sub: session.user.id, is_anonymous: session.user.isAnonymous === true }`.

Правила:

- `sub` — рядок uuid у нижньому регістрі; `simetra.current_user_id()` шукає
  ідентичність за `(better-auth, sub)` і повертає `NULL` для аноніма й
  недійсного користувача (С5).
- `role`, `iss`, `aud` у claims не потрібні: роль ставить `runCommand` чи
  читання (`SET LOCAL ROLE`), а не claim.
- Act-as — claim `act` за С5; Better Auth його не дає, тож його ставить
  лише агентний шлях платформи (П4-F).
- Недійсність діє на наступному запиті: claims формуються на кожен запит,
  а `current_user_id()` читає `invalid`.
- Шаблон host-а не вмикає кеш сесії в cookie (`session.cookieCache`): з
  ним відкликана чи забанена сесія жила б до `maxAge` кешу без звернення
  до бази, зокрема на endpoint-ах токенів і файлів.

**Анонімна сесія читає як гість.** Сесія аноніма Better Auth має `sub`, а
політика `<t>_public_read` для ролі запиту користувача відкриває рядки будь-
кому з цією роллю (платформна спека §6.8). Тому T3 обирає роль запиту за
claim `anonymousClaim` пресету: `is_anonymous = true` → роль призначення
`anonymous` (`simetra_anon`), інакше — `user`. Анонім бачить лише
`publicRead: anon`, команди йому відмовляють (`current_user_id()` —
`NULL`), токенів Centrifugo й endpoint-ів файлів він не отримує. Правило
діє в T3 для обох профілів на дверях Server Function; у `supabase` двері
PostgREST ставлять роль за claim `role` провайдера, і їх вирівнює окреме
рішення архітекторки (§14).

**Вплив на код:** запис пресету в `project.ts`; адаптер `verifySession`
Better Auth — у шаблоні host-а (П4-D), не в `simetra`: пакет не залежить від
`better-auth`.

**Тест:** DB-тест провізії на стеку `postgres` з таблицею, створеною
справжньою міграцією Better Auth закріпленої версії (не рукописним DDL):
реєстрація, анонім, конвертація на місці, прив'язка з видаленням аноніма,
видалення облікового запису, конкурентна реєстрація того самого `id`. Unit:
SQL провізії з пресету `postgres` бере імена колонок у лапках. Тест профілю
pg-delta `simetra-postgres`: заглушка `better_auth."user"` у тіні має
колонки таблиці цілі.

## 5. Outbox і споживач

Ця частина однакова для обох профілів: Centrifugo читає outbox і з бази
Supabase.

### 5.1 Таблиця

```sql
CREATE TABLE simetra.signal_outbox (
  id         bigserial PRIMARY KEY,
  method     text NOT NULL CHECK (method = 'publish'),
  payload    jsonb NOT NULL,
  partition  integer NOT NULL DEFAULT 0 CHECK (partition = 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- Колонки — рівно формат споживача Centrifugo (`id`, `method`, `payload`,
  `partition`, `created_at`); імена й типи змінювати не можна.
- Форма `payload` закрита на рівні бази: `CHECK` — рівно ключі `channel`,
  `data`, `idempotency_key`; `channel` відповідає формі топіків П4-B
  (`^simetra(-rights|-user)?:[0-9a-f:-]+$`); `idempotency_key` =
  `data->>'id'`. Інакше вставка в outbox могла б додати поля запиту
  публікації Centrifugo (`skip_history`, `b64data`, `tags`) чи чужий ключ
  ідемпотентності. Політику `INSERT` режиму відправки П4-B будує над
  `payload->>'channel'`: окремої колонки `topic` у формі споживача немає.
- `id` з послідовності дає порядок вибірки споживача (`ORDER BY id`). Це
  порядок вставки, а не коміту; приймачу порядок не потрібен, бо показ рухає
  версія рядка (звіт спайку realtime, вимога 2).
- Один розділ: `num_partitions = 1`, `CHECK (partition = 0)`.
- `payload` — запит публікації Centrifugo:
  `{ "channel": <топік>, "data": <повідомлення>, "idempotency_key": <id повідомлення> }`.
  Форму `data` і топіка задає П4-B (схема прийнятого повідомлення з верхнім
  `id`). Ця спека додає лише `idempotency_key` = `data->>'id'`: якщо
  споживач опублікував подію, а `DELETE` не закомітився, повтор не дасть
  дубля в історії каналу.
- Таблицю, послідовність, тригер і функцію тригера генерує платформа в
  схемі `simetra`; власник — `simetra_owner` (у `supabase` — роль
  застосування). Таблиця входить у межу гейта як об'єкт платформи.

### 5.2 Гранти, RLS, `NOTIFY`

- `ENABLE ROW LEVEL SECURITY`, без `FORCE`.
- `simetra_command`: `INSERT (method, payload)`, `USAGE` на послідовність
  `id`. Це названий виняток із правила «ролі застосунку не мають грантів на
  таблиці `simetra`» (С1, платформна спека §6.7): сигнал пише функція
  `SECURITY INVOKER` від ролі команд (П4-B). Політику `INSERT` у режимі
  відправки задає П4-B; іншого запису в outbox у ролей застосунку немає.
- `simetra_signal_consumer`: `USAGE` на схему `simetra`, `SELECT` і `DELETE`
  на таблицю й політики `signal_outbox_consumer_select` і
  `signal_outbox_consumer_delete` (`USING (true)`, `TO simetra_signal_consumer`).
  Жодного іншого гранту в схемі `simetra`; це другий названий виняток із
  того самого правила.
- Ролі запиту, `PUBLIC` і сервісна роль — нічого.
- `NOTIFY`: тригер `AFTER INSERT … FOR EACH STATEMENT` кличе
  `pg_notify('simetra_signal_outbox', '0')`. Рівень оператора, а не рядка:
  команда з кількома сигналами дає одне сповіщення; Postgres і так зводить
  однакові сповіщення транзакції в одне. Сповіщення доходить після коміту.
- Advisory lock транзакції споживача (`pg_advisory_xact_lock(hashtext(…))`)
  прав не потребує.

**Поведінка споживача (Centrifugo v6, факти з коду й документації):**

- транзакція на пачку в `READ COMMITTED`: замок розділу → `SELECT id,
  method, payload, partition … WHERE partition = $1 ORDER BY id LIMIT $2` →
  публікація → `DELETE … WHERE id = ANY($1)` → `COMMIT`;
- `FOR UPDATE` не використовується, тож `UPDATE` не потрібен;
- тимчасова помилка публікації (коди 100 і 111) — пачка обривається,
  непублікована подія лишається й повторюється;
- нетимчасова помилка (наприклад 107, некоректний запит) — подію
  позначено обробленою, сигнал губиться (ПП3).

**Втрата публікації.** Сигнал може загубитись: нетимчасова помилка, рестарт
Centrifugo з рушієм у пам'яті, обрив сокета без recovery. Коректність на
доставці не стоїть: приймач перечитує активні вигляди після кожного
приєднання без `recovered`, на фокус і видимість вкладки й з обмеженим
інтервалом (рішення T4 §3.6 і §4, зобов'язання 4; максимальний час збіжності
задає П4-B). Транспорт додає одне: метрика найстаршого `created_at` в outbox
і лічильник помилок споживача (§11). Нетимчасова помилка в нашій формі —
дефект генератора: unit-тест схеми `payload` її запобігає.

**Ріст таблиці.** Поки Centrifugo лежить, outbox росте; після старту
споживач публікує накопичене. Такі сигнали шкоди не роблять (ідемпотентні),
лише зайві перечитування. Платформа дає функцію
`simetra.signal_outbox_prune(p_older_than interval)` для оператора
(`EXECUTE` лише власнику); розкладу в ядрі немає (Р27).

### 5.3 З'єднання споживача

| Параметр Centrifugo | Значення |
| --- | --- |
| `dsn` | логін `simetra_signals`; пряме з'єднання або пулер у **сесійному** режимі |
| `partition_notification_dsn` | пряме з'єднання (для `LISTEN`) |
| `partition_notification_channel` | `simetra_signal_outbox` |
| `outbox_table_name` | `simetra.signal_outbox` |
| `num_partitions` | `1` |
| `partition_select_limit` | `100` (типове) |
| `partition_poll_interval` | `300ms` (типове; страховка, коли `LISTEN` обірвано) |
| `use_try_lock` | `true` (лише один інстанс тримає транзакцію; решта не чекають) |

- Transaction-режим пулера заборонено для обох DSN: `LISTEN` потребує
  власного з'єднання, а драйвер споживача (pgx) типово готує оператори.
- **Supabase.** Пряме з'єднання з базою проєкту (порт 5432 хоста бази) або
  Supavisor у сесійному режимі; `simetra_signals` створює `roles` від ролі
  `postgres`. Локальний стек дає пряме з'єднання на порту бази.
- Рівно один інстанс Centrifugo на застосунок (ПП3). Рушій історії й
  підписок — пам'ять інстансу (§6.1), тож другий інстанс, що читає той
  самий outbox, забирав би сигнали, яких клієнти першого не отримають.
  Кілька інстансів — лише зі спільним рушієм (Redis), окремим рішенням
  (§14). `use_try_lock` лишається: короткий перекрив під час
  перезапуску не тримає транзакцію.

**Вплив на код:** генератор об'єктів outbox у шарі платформи
(`packages/simetra/src/compiler/platform/units.ts`), гранти й політики
споживача, функція `prune`; тіла `signal`, `signal_rights`,
`signal_user_rights` для outbox — блок B8 П4-B за цією формою.

**Тести:**

- unit T1: DDL таблиці дорівнює формату споживача; `payload` сигналу
  проходить схему запиту публікації (`channel`, `data`, `idempotency_key`);
  тригер — рівня оператора;
- DB: `simetra_signals` читає й видаляє рядки, але не вставляє й не
  оновлює; не читає жодної іншої таблиці `simetra` і схем застосунку;
  `simetra_command` вставляє, але не читає й не видаляє; `simetra_user` —
  нічого; одне сповіщення на команду з кількома сигналами; `ROLLBACK` —
  ні рядка, ні сповіщення;
- стенд (Centrifugo в контейнері, §10.4): сигнал команди доходить у канал
  з `LISTEN` за ≤ 50 мс p95 без мережі; з обірваним `LISTEN` — за такт
  опитування; логін `simetra_signals` з грантами лише цієї спеки працює
  (доказ «лише `SELECT` і `DELETE`» на справжньому споживачі).

## 6. Centrifugo

### 6.1 Конфіг

Шаблон конфігу (v6) генерує інструмент designer за проєктом; оператор
підставляє секрети середовищем.

```json
{
  "client": {
    "allowed_origins": ["<origin застосунку>"],
    "token": {
      "jwks_public_endpoint": "<внутрішня адреса host-а>/simetra/signals/jwks",
      "audience": "centrifugo:<id застосунку>",
      "issuer": "<origin host-а>"
    },
    "recovery_max_publication_limit": 300
  },
  "channel": {
    "without_namespace": {},
    "namespaces": [
      { "name": "simetra",        "history_size": 100, "history_ttl": "300s", "history_meta_ttl": "24h", "force_recovery": true },
      { "name": "simetra-rights", "history_size": 20,  "history_ttl": "300s", "history_meta_ttl": "24h", "force_recovery": true },
      { "name": "simetra-user",   "history_size": 20,  "history_ttl": "300s", "history_meta_ttl": "24h", "force_recovery": true }
    ]
  },
  "consumers": [ { "enabled": true, "name": "simetra_outbox", "type": "postgresql", "postgresql": { "…": "§5.3" } } ],
  "http_api": { "disabled": true }
}
```

Правила:

- Простір Centrifugo — частина топіка до першої `:`; топіки П4-B
  (`simetra:…`, `simetra-rights:…`, `simetra-user:…`) лягають у три простори
  без зміни формату.
- Клієнт не публікує, не читає історії вручну, не бачить присутності й не
  підписується без токена каналу: у просторах немає `allow_publish_for_*`,
  `allow_history_for_*`, `allow_presence_for_*`, `allow_subscribe_for_*`.
  Анонімного підключення немає.
- Простір без імені не має жодного дозволу: канал поза трьома просторами
  недосяжний.
- Шаблон перевіряє unit-тест: немає `client.insecure`, `admin`,
  анонімного підключення й жодного `allow_*_for_*`; `http_api.disabled` —
  `true`; `audience` і `issuer` задано. З ПГ-4 конфіг стека розробки
  будується тим самим генератором, лише з адресами стека. До ПГ-4 Centrifugo
  обох стеків іде зі статичним конфігом у файлах стека: ті самі простори й
  `http_api.disabled`, але без споживача outbox і без `client.token` —
  таблиці outbox і JWKS ще немає. Unit-тест файлів стека перевіряє його тими
  самими заборонами, без вимоги `audience` і `issuer`.
- `http_api` вимкнено: публікація йде лише з outbox. Оператор, якому
  потрібен API, вмикає його лише у внутрішній мережі з ключем.
- **Розмір історії.** `history_size` 100 на канал змін покриває типовий
  сплеск команди в межах `history_ttl`; пропуск понад
  `recovery_max_publication_limit` чи понад історію дає `recovered: false`
  і перечитування — це коректно (звіт спайку realtime, вимога 4). Числа
  уточнює бенчмарк блоку B2 П4-B.
- Рушій — пам'ять (один інстанс). Рестарт — нова епоха, клієнти
  перечитують. Redis-рушій для кількох інстансів — поза першою віхою.

### 6.2 Токени

| Токен | Claims | TTL | Хто видає |
| --- | --- | --- | --- |
| з'єднання | `sub` = `claims.sub` сесії, `aud`, `iss`, `exp` | 15 хв | endpoint host-а після `verifySession`; без сесії, для аноніма й коли `current_user_id()` = `NULL` (недійсний користувач) — 401 |
| каналу | `sub`, `channel`, `aud`, `iss`, `exp` | 5 хв | endpoint host-а: `runtime.authorizeChannels` (П4-B) повертає дозволені канали, порт підписує токен на кожен |

- Клієнт оновлює обидва токени колбеком `getToken` SDK до `exp`; відмова
  авторизації каналу — `auth` порту каналу без автоповтору (П4-B).
- Відкликане право перестає тримати підписку щонайпізніше через TTL токена
  каналу: на оновленні `signal_topic_allowed` поверне `false`. Сигнал прав
  (П4-B) змушує чесного клієнта перепідписатись раніше. Через короткий TTL
  обмеження Supabase «кеш авторизації на час з'єднання» тут не діє.
- Анонім сигналів не отримує (як §8.6 П4-B).
- Сигнал прав користувача змушує клієнт одразу оновити токени каналів, а
  втрачене право закриває підписку на клієнті, не чекаючи TTL (П4-B).

**Серверного примусового відписування немає.** Рішення: на відкликання
права сервер не кличе `unsubscribe` чи `disconnect` Centrifugo. Причини:

1. Клієнт, що не реагує на сигнал прав, тримає підписку щонайдовше TTL
   токена каналу (5 хв). За цей час він бачить лише id і версії рядків, без
   даних; перечитування під RLS їх відсіює.
2. Той самий клас залишку П4-B уже приймає назавжди для обсягів `own` і
   вимірних прав (Р-4, §8.6 П4-B). Страховка закривала б 5 хвилин залишку,
   який в інших випадках прийнято без строку.
3. Відписування в момент відкликання потребувало б другого шляху з бази до
   Centrifugo. База не відрізняє дешево втрату права від здобуття, тож
   відписування на кожну зміну прав рвало б з'єднання й давало повне
   перечитування без потреби.

Якщо страховка знадобиться, шлях уже є: той самий outbox приймає метод
`disconnect` сервера Centrifugo (`{ user }`, `user` = `sub` токена
з'єднання = id користувача), і його пише та сама транзакція, що й сигнал
прав користувача. Тоді `CHECK (method = 'publish')` розширюється рівно до
`disconnect`. Це окреме рішення, не перша віха.

### 6.3 Підпис і ротація

- Алгоритм — EdDSA (Ed25519, `kty: OKP`); ключ — WebCrypto, без залежності.
  Кожен токен має `kid`.
- `aud` — `centrifugo:<id застосунку>`, `iss` — origin host-а; Centrifugo
  перевіряє обидва (`client.token.audience`, `client.token.issuer`), тож
  токен іншого застосунку чи середовища не приймається.
- Host публікує JWKS на `/simetra/signals/jwks`; Centrifugo кешує ключі до
  години. Centrifugo бере JWKS лише за внутрішньою адресою host-а або через
  TLS: підміна відповіді JWKS дала б токен на будь-який канал.
- **Ротація:** (1) новий ключ додається в JWKS; (2) підпис новим ключем
  починається не раніше ніж через 1 год 5 хв; (3) старий ключ лишається в
  JWKS ще 20 хв після останнього підпису (найдовший TTL плюс запас), потім
  зникає. Правило не залежить від того, чи перечитує Centrifugo JWKS на
  невідомому `kid`.
- Компрометація ключа: ключ прибирають з JWKS одразу й перезапускають
  Centrifugo (скидає кеш). Клієнти перепідключаються з новими токенами,
  нова епоха дає перечитування.
- Приватні ключі — секрет host-а (змінні середовища, формат JWK); JWKS
  містить лише публічні.

## 7. Порт сервера сигналів

```text
SignalTokens = {
  connectionToken(subject: string): Promise<{ token, expiresAt }>,
  channelToken(subject: string, channel: string): Promise<{ token, expiresAt }>,
  jwks(): JsonWebKeySet
}
```

- Порт і адаптер Centrifugo — у T3, підшлях `simetra/server/signals`:
  WebCrypto, без драйвера й без SDK, тож шлях запиту лишається переносним
  (ПП7). Адаптер будує claims за §6.2 і підписує ключами з опцій.
- Endpoint-и токенів і JWKS — у шаблоні host-а (П4-D) над портом і
  `runtime.authorizeChannels` (П4-B).
- Публікації з сервера, присутності й примусового від'єднання порт не має.
  Їх додасть окреме рішення разом зі споживачем, якому вони потрібні.
- Клієнтську реалізацію порту каналу над SDK `centrifuge` задає П4-B; ця
  спека вимагає лише, щоб вона була одна для обох профілів і брала токени
  з endpoint-ів §6.2.

**Тест:** unit — claims і `kid`, перевірка підпису публічним ключем з JWKS,
`exp`; стенд — Centrifugo приймає токен з JWKS host-а, відхиляє чужий
канал, прострочений токен і токен невідомого `kid`; ротація за правилом
§6.3 без розриву підписок.

## 8. Файли: Garage і порт сховища

### 8.1 Межа рядка й байтів

- **Файл — рядок об'єкта з властивістю `storage`.** Властивість оголошує
  об'єкт довідника з UUID-ключем. Форма в T0 — Zod-схема з тестами разом із
  блоком ПГ-5: `storage: { maxBytes: <ціле, байти>, mediaTypes: <перелік
  дозволених типів> }`; інших полів у першій віхі немає. Платформа виводить колонки файлу — розмір,
  тип вмісту, ім'я — як стандартні реквізити з реєстру видів
  (`packages/simetra/src/model/kinds/`).
- **Ключа в рядку немає:** ключ об'єкта сховища виводиться з id об'єкта
  каталогу й id рядка (§8.2). Тож жоден записувач рядка не може вказати на
  чужі байти.
- **Колонки файлу пише лише платформа.** `simetra_command` не має гранту на
  розмір і тип вмісту: їх ставить функція `simetra.file_attach` (definer,
  `EXECUTE` лише `simetra_command`), яку кличе лише серверний шлях
  завантаження через T3 (`runtime.attachFile`, §8.4). Клієнтська команда
  `create` чи `update` цих колонок не має; хуки сирого SQL не бачать
  (спека П4 Рт6). Ім'я файлу — звичайний реквізит змісту.
- **Прийнята таблиця вкладень споживача** у першій віхі за портом не
  обслуговується: вона лишається на Storage-API в профілі `supabase` (ПП4)
  і переходить на порт промоцією у вид з властивістю `storage`. Причина:
  колонки прийнятої таблиці пише код споживача, тож платформа не може
  гарантувати, що розмір і посилання на байти чесні.
- Виклик `simetra.file_attach`, `simetra.storage_rows_exist` і
  `simetra.storage_headroom` у SQL застосунку (модулі, названі запити) —
  помилка компілятора: ці функції — лише шлях T3, а `EXECUTE` має та сама
  роль команд, від якої виконується SQL модулів.
- Доступ до рядка — RLS рядка, як до будь-якого об'єкта (§6.8 платформної
  спеки). Доступ до байтів — лише серверні endpoint-и після читання рядка
  під роллю запиту.

### 8.2 Ключ, бакет, потоки

- **Бакет на застосунок;** ключ доступу Garage дає читання й запис лише
  цього бакета; ключ знає лише host. Публічного доступу, вебсайту бакета й
  підписаних посилань немає (ПП4).
- **Ключ об'єкта** — `o/<UUID об'єкта каталогу>/<id рядка>`; id рядка —
  UUID, який генерує сервер. Ключ виводиться, а не зберігається, тож
  клієнт не може адресувати чужий об'єкт. Garage ігнорує
  `If-None-Match: *`, тож від перезапису захищає лише унікальність id.
- **Завантаження:**
  1. endpoint перевіряє походження запиту (`RequestOrigin`, спека П4
     Рт19, fail-closed) і сесію; анонім і `current_user_id()` = `NULL` — 401;
  2. попередня перевірка в транзакції `READ ONLY` під роллю запиту: право
     `create` на об'єкт у цільовому скоупі й запас обсягу через
     `simetra.storage_headroom(p_object uuid, p_scope uuid) RETURNS
     boolean` (definer, `EXECUTE` ролі запиту користувача; `false`, коли
     скоуп не входить у множину скоупів користувача чи об'єкт без
     `storage`). Функція відповідає лише «чи вміститься файл розміру
     `maxBytes` об'єкта»: поріг сталий, тож двійковим пошуком обсяг скоупу
     не дізнатись. Роль запиту грантів на таблиці обліку не має.
     Відмова — без жодного байта в бакеті;
  3. генерує id і пише байти в `o/<об'єкт>/<id>` з межею `maxBytes` об'єкта,
     рахуючи розмір сам;
  4. `runtime.attachFile` — одна транзакція команди: `create` рядка з
     реквізитами змісту, `simetra.file_attach` з розміром і типом, облік
     обсягу з остаточною перевіркою межі. `file_attach` відмовляє
     `storage.attach-invalid`, коли: рядок вставлено не в поточній
     транзакції (`xmin` рядка ≠ поточний xid); розмір чи тип уже записано;
     тип поза `mediaTypes`; розмір понад `maxBytes`;
  5. відмова кроку 4 — endpoint видаляє об'єкт; що лишилось після збою
     процесу — прибирає звірка.

  Кількість одночасних завантажень на користувача обмежує host (опція
  шаблону): межа обсягу судить лише закомічені рядки. Заміна файлу — лише
  новий рядок з новим id і видалення старого; зміни байтів чи розміру на
  місці немає, тож тригер обліку на `UPDATE OF <розмір>` лише страхує.
- **Читання:** endpoint читає рядок під роллю запиту (`runtime.read`) → немає
  рядка — 404 (той самий для «немає» й «не можна») → потік з
  `Content-Disposition: attachment; filename*=UTF-8''<ім'я>` (ім'я без
  керівних символів і розділювачів шляху, закодоване за RFC 5987),
  `Content-Type` з переліку дозволених типів об'єкта, інакше
  `application/octet-stream`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox`, `Cache-Control: private, no-store`.
- **Видалення:** endpoint перевіряє походження, як завантаження; команда видаляє рядок; `afterCommit` видаляє об'єкт;
  невдача — звірка.
- **Звірка** — фонове завдання host-а:
  - перелічує лише префікс `o/<UUID об'єкта>/` для об'єктів каталогу з
    властивістю `storage`; префікс невідомого об'єкта не видаляється, а
    журналюється;
  - наявність рядків перевіряє definer-функція власника
    `simetra.storage_rows_exist(p_object uuid, p_ids uuid[])` (`EXECUTE`
    лише `simetra_command`, кличе лише T3 `runtime.reconcileFiles`), бо під
    RLS рядки інших тенантів невидимі й їхні байти стали б «сиротами».
    Функція відмовляє для об'єкта без властивості `storage` і для понад
    1000 id за виклик;
  - видаляє об'єкти без рядка, старші за 24 год;
  - запобіжник: якщо за прогін до видалення припадає понад 5 %
    переліченого **і** понад 20 об'єктів, звірка нічого не видаляє й
    журналює відмову (помилковий DSN чи бакет). Нижня межа в 20 об'єктів
    дає прибрати поодинокі сироти в малому бакеті;
  - рядок без об'єкта — дефект, звірка його журналює.

### 8.3 Облік обсягу

- Тригер `AFTER INSERT OR UPDATE OF <розмір> OR DELETE` на таблиці рядків
  файлів у транзакції запису веде `simetra.storage_usage (scope_kind,
  scope, bytes)` (upsert). Функція тригера — `SECURITY DEFINER` від
  власника з `SET search_path = ''`: роль команд грантів на таблиці
  `simetra` не має.
- Межу обсягу (`simetra.storage_quota`, за скоупом; без рядка — без межі)
  перевіряє той самий тригер: понад межу — відмова
  `storage.quota-exceeded`, і команда відкочується разом з обліком.
- `storage_quota` у першій віхі пише лише оператор від власника; платформна
  команда адміністрування межі — з першою вимогою застосунку.
- Колонка скоупу рядка незмінна (колонки зміни її не містять, спека П4
  §6.2), тож переносу обсягу між скоупами немає. Нескоуплений об'єкт веде
  облік під нульовими UUID виду й скоупу.
- Upsert рядка обліку серіалізує завантаження одного скоупу; для першої
  віхи прийнято.

### 8.4 Порт

```text
FileStore = {
  put(key, body: ReadableStream, { contentType, maxBytes }): Promise<{ size }>,
  get(key): Promise<{ body: ReadableStream, size, contentType } | null>,
  delete(key): Promise<void>,
  list(prefix, after?): AsyncIterable<{ key, lastModified }>   — для звірки
}
```

- Порт — T3; адаптер `fromS3Client(client, bucket)` читає клієнт S3
  структурно, без імпорту SDK (як `fromPgPool`, спека П4 Рт1).
- T3 дає `runtime.attachFile(session, { object, scope, id, fields, size,
  contentType })` (крок 4 завантаження) і `runtime.reconcileFiles(store)`
  (звірка); обидва — серверні, без дверей клієнта.
- У профілі `supabase` прийняті бази лишаються на Storage-API з політиками
  на `storage.objects` (ПП4); нові об'єкти з властивістю `storage` в обох
  профілях ідуть через цей порт.
- Перенесення байтів зі Storage у Garage — частина переїзду споживача (спека
  профілів §4), не платформи.

**Тести:** unit — ключ з id об'єкта й рядка, межа розміру на потоці,
`Content-Disposition` з CR/LF чи `/` в імені, тип поза переліком —
`application/octet-stream`; DB — облік обсягу на вставці, зміні й
видаленні, відмова понад межу з відкатом, розмір і тип `simetra_command`
напряму не пише, `storage_rows_exist` бачить рядок чужого тенанта;
стенд з Garage — повний цикл, чужий рядок дає 404 без звернення до бакета,
анонім і користувач без права `create` не пишуть жодного байта, звірка
прибирає сироту й не чіпає байтів чужого тенанта, запобіжник 5 % зупиняє
звірку на порожній базі.

## 9. Перехідного PostgREST немає

- Профіль `postgres` не має PostgREST. Типове й єдине джерело читання —
  Server Function під RLS (ПП2, Р30).
- Причина: PostgREST ставить роль і claims лише з JWT, підписаного секретом
  бази. Для `postgres` це другий шлях автентифікації поруч із сесією Better
  Auth і другий секрет, а виграшу немає: процес host-а живе поруч із базою.
- Адаптер PostgREST лишається кодом T4 для профілю `supabase` (платформна
  спека §8.2). Рядок ПП2 «PostgREST лишається адаптером, доступним і в
  `postgres` як перехідний» знімається поправкою (§13).

## 10. Стек розробки й CI

### 10.1 Склад

| Сервіс | Образ | Порт на хості | Профіль |
| --- | --- | --- | --- |
| Postgres 17 | образ репо: `postgres:17` + pgTAP + `plpgsql_check` з PGDG, точний тег і digest | 54422 | `postgres` |
| Centrifugo | `centrifugo/centrifugo` v6, точний тег | 8100 у `simetra-pg`, 8101 у `simetra-sb` | обидва, окремий інстанс на стек |
| Garage | `dxflrs/garage`, точний тег | 3900 (S3), 3903 (admin) | `postgres` |
| Supabase | Supabase CLI (пін у `package.json`) | 54322, 54329 | `supabase` |

- Порти стека публікуються лише на `127.0.0.1`: Docker інакше відкриває їх
  на всіх інтерфейсах в обхід брандмауера, а стек має суперкористувача з
  відомим паролем і admin Garage.
- Compose-проєкт `simetra-pg` у каталозі `docker/postgres-stack/` репо:
  Dockerfile образу Postgres, `compose.yaml`, конфіг Centrifugo стека,
  `garage.toml`, `dev-environment.sql` і `dev-secrets.env`. Ініціалізацію
  Garage (layout, бакет `simetra-dev`, ключ) робить `scripts/db-stack.mjs`,
  а не скрипт у `docker/`. Версії — у файлах стека, не в `AGENTS.md`.
- Better Auth не має сервісу: він живе в host-і. Для тестів його таблиці
  створює справжня міграція закріпленої версії (§4.4) у кожній тегованій
  тестовій базі, якій потрібна ідентичність, від тегованої ролі
  `simetra_auth`. У `simetra_template` таблиць Better Auth немає: шаблон
  несе лише `plpgsql_check`, а заглушку `better_auth."user"` тінь отримує з
  фактів цілі (§4.2).
- Стек `supabase` дістає власний Centrifugo: compose-проєкт `simetra-sb`
  (лише Centrifugo, порт 8101; DSN бази стека Supabase він дістає з ПГ-4,
  разом зі споживачем outbox, §6.1). Його піднімає
  окрема команда `pnpm db:signals:start` і зупиняє `pnpm db:signals:stop`;
  `pnpm db:start` і `pnpm db:stop` його не чіпають: DB-тести його не
  вживають (стенд сигналів — власний на прогін, §10.4), а зайве
  завантаження образу в кожному рядку CI — нова причина збою старту. Так
  паралельно запущені стеки не ділять порту.
- Сервіс `realtime` у `supabase/config.toml` вимикається в блоці ПГ-4,
  разом із переходом сигналів на outbox у П4-B (редакція 3), а не раніше:
  до того чинні плани П4-B ще стоять на `realtime.send`. Набір базового
  стану `supabase` перестає вимагати схему `realtime` у тому самому блоці.

### 10.2 Команди

| Команда | Дія |
| --- | --- |
| `pnpm db:pg:start` | `docker compose -p simetra-pg up -d --wait`, ініціалізація Garage і `simetra.environment = 'development'`; з ПГ-2 далі ролі Simetra й шаблон `simetra_template` кроком `simetra roles` (§3.4, §3.5) |
| `pnpm db:pg:stop` | `docker compose -p simetra-pg down` (томи лишаються; `--volumes` — лише явно) |
| `pnpm test:db:pg` | до ПГ-2 — проєкт `db-pg` пакета `simetra`: набір базового стану `postgres` через Vitest-раннер і тест переривання; з ПГ-2 — DB-тести `simetra` і `@simetrajs/designer` на стеку `postgres` |
| `pnpm db:signals:start`, `pnpm db:signals:stop` | Centrifugo поруч зі стеком `supabase` (compose-проєкт `simetra-sb`, §10.1) |
| `pnpm db:start`, `pnpm db:stop`, `pnpm test:db` | стек `supabase`, як зараз; `test:db` до ПГ-2 — набір базового стану провайдера, проєкт `db` і проєкт `db-supabase` обох пакетів, з ПГ-2 — лише регресійні набори (§10.5) |

Стек запускається лише цими командами, ніколи глобальним `docker compose`
без `-p` чи сторонньою версією образів.

### 10.3 Stack-guard і тег прогону

`packages/simetra/test/db/stack-guard.ts` стає параметризованим профілем
(`SIMETRA_TEST_PROVIDER = postgres | supabase`; типово `supabase` до ПГ-2,
з ПГ-2 — `postgres`, разом із переведенням проєкту `db`):

- **замок на стек:** окремий файл замка на профіль; прогони різних стеків
  не чекають один одного, прогони одного — по черзі;
- **адреси:** `connection.ts` бере DSN з даних профілю; змінні
  `SIMETRA_TEST_*` їх перевизначають. З ПГ-2 у `postgres` суперкористувач
  (`postgres`, порт 54422) лише створює ролі на старті стека й тегованих
  прогонів, а тести плану й застосування йдуть від ролі з атрибутами
  `simetra_owner` (`NOSUPERUSER BYPASSRLS CREATEDB`), як у проді: інакше
  суперкористувач сховав би гранти `better_auth`, замок `dropTrigger` і
  режим `plpgsql_check`. Так само на `supabase` тести вже йдуть від
  не-суперкористувача `postgres`. Роль власника на стеку `postgres` з'являється
  з ПГ-2 (`simetra roles`); до того обидві адреси профілю — суперкористувач
  `postgres`, і на стеку йдуть лише набір базового стану й тест переривання;
- **знімок стека:** до бази, ролей, схем і розширень додаються контейнери з
  двома мітками, `simetra-run=<тег>` і `simetra-stack=<профіль>`, і бакети
  Garage з префіксом тегу; різниця після прогону — збій, як зараз. Контейнер
  з міткою іншого стека не є витоком цього;
- **прибирання на сигналах:** ті самі SIGINT, SIGTERM, SIGHUP; додатково
  `docker rm -f` контейнерів свого тегу; бакет свого тегу спершу
  спорожнюється, потім видаляється (Garage видаляє лише порожній бакет).
  До ПГ-5 прибиральник видаляє лише **порожні** бакети тегу, а непорожній
  називає в звіті про залишки; спорожнення бакета з об'єктами приходить у
  ПГ-5 разом із першим тестом, що пише байти;
- **тег прогону:** бази, ролі й тіні — як зараз (`connection.ts`);
  контейнер Centrifugo стенду — обидві мітки (аргументи `docker run` дає
  помічник `runContainerLabels` у `packages/simetra/test/db/external.ts`) і
  ім'я з тегом; бакет — `run-<тег>`.

### 10.4 Стенд сигналів

Тести транспорту (§5.3, §7) піднімають власний контейнер Centrifugo на
прогін: споживач дивиться на теговану базу тесту, а не на базу стека.
Помічник стенду переноситься з гілки `spike/t4-realtime`
(`packages/simetra/test/realtime/stand.ts` там) у тест-інфру з тегом
прогону й прибиранням stack-guard. Стенд — частина DB-проєкту, не окремий
конфіг.

### 10.5 pgTAP і розподіл тестів

- pgTAP-набори йдуть через тонкий Vitest-раннер в обох профілях (ПП6):
  тегована база, транзакція з `ROLLBACK`, `SET ROLE`, claims; раннер
  збирає вивід TAP і падає на `not ok` чи на розбіжності плану.
  Транзакцію набору відкриває й відкочує раннер: файл набору не має
  операторів керування транзакцією (`begin`, `commit`, `rollback`,
  `savepoint` тощо) і `alter system` — раннер такий набір відхиляє. Набір
  базового стану `postgres` іде в базі `postgres` від суперкористувача
  стека; теговані бази, `SET ROLE` і claims раннер дістає з ПГ-2, з першими
  наборами, яким вони потрібні.
- `supabase test db` лишається лише для набору базового стану провайдера
  `supabase/tests/provider-base-state.test.sql`. Аналог для `postgres` —
  набір базового стану стека `postgres` через раннер: версія 17, доступні
  розширення `pgtap` і `plpgsql_check`, налаштування стека
  `simetra.environment`, відсутність схем Supabase (`auth`, `storage`,
  `realtime`). Ролі §3.1 і їхні атрибути та схему `better_auth` набір
  дістає разом із `simetra roles` (ПГ-2) і грантами ідентичності (ПГ-3).
- **Розподіл DB-тестів:**
  - проєкт `db` — на стеку `postgres` з ПГ-2 (до того — на стеку
    `supabase`, а на `postgres` іде лише проєкт `db-pg`: набір базового
    стану й тест переривання); роль запиту й таблицю ідентичності
    тести беруть з даних профілю (помічник `test/db`), а не з імен Supabase;
  - проєкт `db-supabase` (`*.supabase.db.test.ts`) — на стеку `supabase`:
    прийом бази Supabase, пресет гейта `supabase` (поверхні `auth`,
    `storage`), провізія з `auth.users`, пулер Supavisor, ролі провайдера;
  - тест, що вживає ролі чи схеми Supabase поза цим переліком, переводиться
    на дані профілю, а не перейменовується.

### 10.6 CI

| Job | Стек | Що | Шарди |
| --- | --- | --- | --- |
| `checks` | — | без змін | 1 |
| `db` | `postgres` | базовий стан `postgres`, DB `simetra`, DB designer | за наявною схемою шардів `.github/workflows/ci.yml` |
| `db-supabase` | `supabase` | `supabase test db`, `db-supabase` обох пакетів | 1 |
| `packaging` | — | без змін | 1 |

- Стек `postgres` у CI стартує тим самим `pnpm db:pg:start`; образ Postgres
  збирається з кешем шарів (або тягнеться з реєстру за digest).
- Повторні спроби старту — за тим самим правилом, що й для стека Supabase
  у `.github/workflows/ci.yml`.
- **До ПГ-2** таблиця має проміжну форму: матриця `db` лишається на стеку
  `supabase` і дістає рядки `supabase-bound` (проєкт `db-supabase`:
  `simetra` одним рядком, designer — двома шардами), а стек `postgres` іде
  окремим job-ом `db-postgres` (`pnpm db:pg:start`, `pnpm test:db:pg`).
  ПГ-2 переводить `db` на стек `postgres` за таблицею вище.

### 10.7 Текст для `AGENTS.md` (затверджує власник)

Текст описує стан з ПГ-2. ПГ-1 вносить проміжний текст: власні команди
(`db:pg:*`, `test:db:pg`), рядки `supabase-bound` матриці `db` і job
`db-postgres` (§10.6).

У розділі «Commands and gates» блок команд замінити так:

```bash
pnpm db:pg:start                          # local postgres-profile stack: Postgres 17, Centrifugo, Garage (needs Docker)
pnpm test:db:pg                           # DB tests of simetra and @simetrajs/designer on the postgres stack (the default DB suite)
pnpm db:pg:stop

pnpm db:start                             # local Supabase stack (needs Docker) — supabase-profile regression only
pnpm test:db                              # provider base-state pgTAP + *.supabase.db.test.ts against the Supabase stack
pnpm db:stop
```

Пункти під блоком:

Блок також дістає рядок `pnpm db:signals:start` / `pnpm db:signals:stop`
(Centrifugo поруч зі стеком Supabase, §10.1).

- «The local stack is started only through `pnpm db:*` (pinned CLI
  version)» → «Each local stack is started only through its `pnpm db:*`
  commands (pinned images and CLI), never through a global `supabase` or
  `docker compose` without the project name.»
- «The local stack is one per machine and shared…» → «Each local stack
  (`postgres`, `supabase`) is one per profile per machine and shared by
  every session and agent on it.» У реченні про `globalSetup` дужки з
  `stack-guard.ts` → «(`stack-guard.<provider>.ts` of the DB project, over
  the guard module `packages/simetra/test/db/stack-guard.ts`)». Після нього:
  «The guard is per stack: runs on different stacks do not wait for each
  other.»
- Абзац про run tag доповнити: «Signal stands and buckets carry the run tag
  too: a run container gets the `simetra-run=<tag>` and
  `simetra-stack=<provider>` labels (`runContainerLabels` in
  `packages/simetra/test/db/external.ts`), a Garage bucket the `run-<tag>`
  name; the guard removes its own containers and its empty buckets on exit
  and on the same signals, and reports a non-empty bucket.» Останнє — до
  ПГ-5 (§10.3).
- «Versions live in `.node-version` and `package.json`, not here.» →
  «Versions live in `.node-version`, `package.json` and the stack files
  (`docker/*/compose.yaml`, `Dockerfile`), not here.»
- Абзац про CI: «a `db` matrix (each shard starts its own stack…)» →
  «a `db` matrix on the postgres stack (base-state pgTAP through the Vitest
  runner with `simetra`, then `@simetrajs/designer` split by `vitest
  --shard`), a `db-supabase` job (provider pgTAP and `*.supabase.db.test.ts`
  on the Supabase stack)».

## 11. Експлуатація

- Метрики транспорту без приватних даних: вік найстаршого рядка outbox,
  число рядків, помилки споживача за кодом, `recovered: false` на клієнті
  (рішення T4 §4, зобов'язання 12).
- Журнал Centrifugo не пише `data` публікацій (рівень `info`, без debug у
  проді).
- Резервна копія бази не мусить містити outbox: після відновлення клієнти
  однаково перечитують.

## 12. Блоки виконання

Порядок задає стовпець «Залежить від».

| Блок | Обсяг | Готово, коли | Залежить від |
| --- | --- | --- | --- |
| **ПГ-1. Стек і тест-інфра** | `docker/` (образ, compose, конфіги, ініціалізація Garage); `pnpm db:pg:*`, `test:db:pg`; stack-guard за профілем (замок, адреси, знімок, контейнери й бакети); Vitest-раннер pgTAP; набір базового стану `postgres` (версія, доступні розширення, налаштування стека, відсутність схем Supabase; ролі й шаблон `simetra_template` — з ПГ-2); проєкт `db-supabase` і перенесення в нього тестів, прив'язаних до Supabase; CI: рядки `supabase-bound` у наявній матриці `db` і job `db-postgres` (§10.6); compose `simetra-sb` з Centrifugo (`pnpm db:signals:*`); текст `AGENTS.md` на затвердження | обидва стеки стартують своїми командами; наявний `db` і `db-supabase` зелені на `supabase`; базовий стан `postgres` зелений через Vitest-раннер; прогін, перерваний SIGINT, не лишає ні баз, ні контейнерів, ні бакетів; CI зелений | — |
| **ПГ-2. Провайдер у схемному рушії** | `postgres` у `DATABASE_PROVIDERS` і мапах за таблицею §4.2; споживачі `PROVIDER_SCHEMAS.supabase` і `SUPABASE_*` — за `scope.provider`; `renderProviderSeed(provider)`; профіль pg-delta `simetra-postgres`; запис пресету §4.1 (тип `Record<DatabaseProvider, …>` його вимагає); ролі §3 з `LOGIN_ROLE_PARENTS` і власником бази; `plpgsql_check` у цілі й шаблон `simetra_template`; власна провізія тіні й копії з шаблону (§3.5); `service: null`; гейт `plan.owner-not-bypassrls`; таблиця ідентичності в тестах — справжня міграція Better Auth закріпленої версії; переведення проєкту `db` на стек `postgres` і тестів — на дані профілю; теговані бази, `SET ROLE` і claims у Vitest-раннері pgTAP (§10.5); CI-job `db` на стеку `postgres` і окремий job `db-supabase` (рядки `supabase-bound` з ПГ-1) | проєкт `db` зелений на `postgres` від ролі з атрибутами власника, `db-supabase` — на `supabase`; каталожний гейт бачить у чужих схемах лише розширення й тригери провізії; тест ролей §3.1 зелений | ПГ-1 |
| **ПГ-3. Ідентичність** | адресні гранти `better_auth` у `roles` (§4.2); `plan.identity-table-missing`, `plan.identity-trigger-locked`; вибір ролі читання за `anonymousClaim`; адаптер `verifySession` у шаблоні host-а (разом з П4-D) | DB-тести §4.4 на таблиці справжньої міграції зелені (міграція з `database.schemaName: "better_auth"` створює таблиці саме там); план від `simetra_owner` ставить тригери провізії на `better_auth."user"`, а крок зняття тригера відмовляє `plan.identity-trigger-locked`; анонімна сесія читає лише `publicRead: anon`; `runCommand` і читання з claims Better Auth дають той самий `current_user_id()`, що й на `supabase` | ПГ-2 |
| **ПГ-4. Outbox, споживач, токени** | таблиця, гранти, політики споживача, `NOTIFY`, `prune`; конфіг Centrifugo з designer; `simetra/server/signals` (порт, EdDSA, JWKS); стенд сигналів у тест-інфрі; разом із B8 П4-B — тіла функцій сигналу й `authorizeChannels` | `supabase/roles.sql` і `supabase/tests/provider-base-state.test.sql` знають `simetra_signal_consumer` і `simetra_signals`; тести §5.3 і §7 зелені в обох профілях; на стенді доведено фактом: `simetra.signal_outbox` зі схемою в `outbox_table_name`, `partition_notification_dsn`, `use_try_lock`, вхід `simetra_signals` з налаштуванням ролі; сигнал команди доходить, чужий канал, прострочений токен і токен з чужим `aud` відхилено; JWKS з ключем Ed25519 (`OKP`) приймається; ротація без розриву; `realtime` у стеку `supabase` вимкнено | ПГ-3; B6 П4-B |
| **ПГ-5. Сховище файлів** | властивість `storage` у T0 з мапінгом; стандартні реквізити виду; облік і межа обсягу; `FileStore`, `fromS3Client`; endpoint-и й звірка в шаблоні host-а; спорожнення бакета тегу з об'єктами в прибиральнику stack-guard (§10.3) | тести §8 зелені на стеку `postgres` з Garage | ПГ-3 (ідентичність у тестах), П4-D (host) |

ПГ-5 не залежить від ПГ-4 і може йти паралельно з ним після ПГ-3.

## 13. Поправки інших документів

| Документ | Місце | Поправка | Рішення |
| --- | --- | --- | --- |
| спека профілів провайдера | ПП2 | прибрати «PostgREST лишається адаптером, доступним і в `postgres` як перехідний» | ПГ12 |
| спека профілів провайдера | ПП3 | транспорт `supabase` — теж outbox і Centrifugo; `realtime.send` і політики на `realtime.messages` не використовуються. Уточнення поведінки споживача: тимчасова помилка публікації (коди Centrifugo 100 і 111) — подія лишається в outbox і повторюється; нетимчасова (наприклад 107) — подію позначено обробленою, сигнал губиться. Токен каналу видається за `signal_topic_allowed` (П4-B), а не за функцією множини скоупу | ПГ6, напрям власника; правку вносить PR редакції 3 П4-B (`simetra-13`), ця спека її лише формулює |
| спека профілів провайдера | ПП5 | схема Better Auth — `better_auth` (`database.schemaName`), вбудований адаптер, плагін `anonymous` | ПГ4 |
| спека профілів провайдера | §5 | питання закрито цією спекою (посилання) | усі |
| платформна спека | Р31, §8.2 | один транспорт в обох профілях: outbox → PG-споживач Centrifugo; «ретранслятор передає його через `LISTEN/NOTIFY`» замінити на «вбудований споживач Centrifugo читає outbox (`LISTEN/NOTIFY` і опитування)» | ПГ6; правку вносить PR редакції 3 П4-B (`simetra-13`), ця спека її лише формулює |
| платформна спека | §6.9 | платформа більше не генерує політик на `realtime.messages`; поверхня лишається в пресеті `supabase` для прийнятих баз | напрям власника |
| платформна спека | §6.2 «Тіньова БД» | dev і CI — стек `postgres` (compose) типово, локальний стек Supabase CLI — для профілю `supabase` | ПГ13 |
| платформна спека | §6.2 «Тіньова БД» | у профілі `postgres` тінь і копія доказу — `CREATE DATABASE … TEMPLATE simetra_template` (шаблон з `plpgsql_check`, готує `roles`); копія без даних цілі | §3.5 |
| спека профілів провайдера | §3 | outbox без `pgmq` — таблиця `simetra.signal_outbox` у форматі споживача Centrifugo; споживач розділяє роботу advisory lock транзакції, а не `SKIP LOCKED` | ПГ6 |
| платформна спека | §6.7 | профіль без сервісної ролі; два названі винятки на outbox: `INSERT` для `simetra_command`, `SELECT` і `DELETE` для `simetra_signal_consumer` | ПГ1, ПГ7 |
| спека системної схеми | С1, §3 | у схемі `simetra` — `signal_outbox`, `storage_usage`, `storage_quota`; грант групи споживача | ПГ7, ПГ11 |
| спека П4 | §6.2 | рядок `simetra_runtime` для `postgres`: член `simetra_user` і `simetra_anon`; новий рядок `simetra_signals` | ПГ1, ПГ7 |
| спека П4 | §6.11 | роль читання обирається за `anonymousClaim`: анонімна сесія — роль призначення `anonymous` | §4.4 |
| спека П4-B (редакція 3) | §8.2, §8.3, §8.5, §8.6, B2, B8 | тіла сигналу — outbox в обох профілях; кеш авторизації Realtime замінює TTL токена каналу; порт каналу над `centrifuge`; e2e-стек — стенд сигналів цієї спеки | узгоджує архітекторка |
| `AGENTS.md` | «Commands and gates» | текст §10.7 | власник |

## 14. Відкриті питання

| Питання | Пропозиція |
| --- | --- |
| Керовані Postgres (RDS, Neon, Azure) не завжди дають створити роль з `BYPASSRLS` | перша ціль `postgres` — власний сервер; для керованого провайдера — окремий пресет після перевірки його атрибутів ролей |
| Кілька інстансів Centrifugo з рушієм Redis | після першої віхи, коли знадобиться доступність; токени не змінюються, а споживач outbox працює на одному інстансі під advisory lock, публікуючи в спільний рушій |
| Примусове від'єднання при недійсності користувача | TTL токенів (§6.2) вважаємо достатнім; HTTP API `disconnect` — з першою вимогою |
| Числа історії (`history_size`, `history_ttl`) | уточнює бенчмарк B2 П4-B |
| Двері PostgREST у `supabase` ставлять анонімній сесії роль `authenticated` за claim `role` провайдера, а Server Function — роль гостя (§4.4) | **Закрито** (рішення архітекторки 2026-11-08): анонімна сесія — гість в обох дверях. У `supabase` функції прав трактують claim `is_anonymous` як гостя й тоді, коли роль запиту — `authenticated`. Реалізація — блок B4 П4-B (адаптер PostgREST); до B4 дверей PostgREST для аноніма немає |
