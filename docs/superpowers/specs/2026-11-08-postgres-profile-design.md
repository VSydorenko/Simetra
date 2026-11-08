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
сім механізмів відкритими. Ця спека дає кожному правило, причину, вплив на
код і тест, а також стек розробки й CI для обох профілів і порядок блоків.

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
| ПГ1 | **Ролі запиту `postgres` створює платформа:** `simetra_user` (запит користувача) і `simetra_anon` (запит без сесії), обидві `NOLOGIN NOINHERIT`. Сервісної ролі профіль не має: `PROVIDER_API_ROLES.postgres.service` — `null` (§3) | у чистому Postgres ролей API немає; сервісна роль у шляхах застосунку не використовується (платформна спека §6.7), тож роль-заглушка була б мертвим об'єктом |
| ПГ2 | **Роль-власник `simetra_owner`:** `LOGIN NOSUPERUSER BYPASSRLS CREATEDB NOCREATEROLE`; від неї йде застосування. План у профілі `postgres` відмовляє `plan.owner-not-bypassrls`, коли роль застосування не має `BYPASSRLS` і не суперкористувач (§3.3) | definer-функції з `SET row_security = off` на відношенні під чужим RLS дають `42501`; ранній гейт перетворює збій на рантаймі в зрозумілу відмову плану |
| ПГ3 | **Кластерні ролі створює один крок `simetra roles` від суперкористувача;** далі `simetra_owner` суперкористувача не потребує (§3.4) | `BYPASSRLS` і членства ролей платформи видає лише суперкористувач; разовий привілейований крок відокремлено від щоденного застосування |
| ПГ4 | **Пресет ідентичності Better Auth** — запис даних `PROVIDER_IDENTITY_SOURCES.postgres`: схема `better_auth`, таблиця `user`, ключ `id` типу uuid, імена `name` → `email`, анонімність `isAnonymous`, без м'якого видалення, ключ провайдера `better-auth` (§4) | спека профілів ПП5 і С3: новий провайдер — новий запис даних, а SQL провізії один |
| ПГ5 | **Claims із сесії Better Auth формує host:** `{ sub: user.id, is_anonymous }`; JWT для бази немає, claims ставить `set_config` (§4.4) | контракт сесії (С5) не залежить від провайдера; підпис JWT лише для бази — зайвий секрет |
| ПГ6 | **Outbox — `simetra.signal_outbox` у форматі споживача Centrifugo**, один розділ, `id bigserial`, тригер `NOTIFY` рівня оператора; однакова в обох профілях (§5) | вбудований споживач читає таблицю напряму, ретранслятора немає (ПП3); один розділ — бо порядок дають версії, а не канал |
| ПГ7 | **Споживач outbox — логін `simetra_signals`** з `SELECT` і `DELETE` лише на outbox через групову роль `simetra_signal_consumer`; обидва DSN споживача — пряме з'єднання або пулер у сесійному режимі, transaction-режим заборонено (§5.3) | споживач тримає `LISTEN` і advisory lock транзакції; найменші права обмежують шкоду від витоку DSN |
| ПГ8 | **Простори Centrifugo `simetra`, `simetra-rights`, `simetra-user`** з історією й `force_recovery`; клієнт не публікує, не читає історію й не підписується без токена (§6) | recovery скорочує перечитування після короткого розриву; коректність однаково не стоїть на доставці (рішення T4 §3.6) |
| ПГ9 | **Токени Centrifugo — EdDSA (Ed25519), ключі через JWKS host-а**, з `kid` і правилом перекриття під час ротації; TTL токена каналу 5 хв, з'єднання — 15 хв (§6.3) | JWKS дає ротацію без перезапуску Centrifugo; короткий TTL обмежує час, коли відкликане право ще тримає підписку |
| ПГ10 | **Порт сервера сигналів вузький — лише видача токенів** (з'єднання, канал) і JWKS; публікації йдуть через outbox, присутності немає (§7) | ширший контракт (публікація з сервера, присутність) не має споживача; кожен метод порту — поверхня для другого адаптера |
| ПГ11 | **Порт сховища файлів** `FileStore` (put, get, delete) зі структурним адаптером S3; файл — рядок об'єкта з властивістю `storage` і мапінгом колонок; ключ — `o/<id рядка>`; облік обсягу — тригер у транзакції запису рядка (§8) | межу тенанта тримає RLS рядка й серверний ендпоінт, бо Garage не має політик на префікси; ключ з id рядка не залежить від вводу клієнта |
| ПГ12 | **Перехідного PostgREST у `postgres` немає.** Джерело читання — лише Server Function (ПП2) (§9) | PostgREST вимагав би JWT, підписаного для бази, — другий шлях автентифікації й другий секрет |
| ПГ13 | **Стек розробки й CI `postgres` — docker compose:** Postgres 17 (образ репо з pgTAP і `plpgsql_check`), Centrifugo, Garage; команди `pnpm db:pg:*`; DB-тести типово йдуть на ньому; стек `supabase` — регресійний (§10) | основний профіль має бути основним і в тестах; спільна дисципліна stack-guard діє на обох стеках |

## 3. Ролі

### 3.1 Склад ролей профілю

| Роль | Атрибути | Членство | Хто створює |
| --- | --- | --- | --- |
| `simetra_owner` | `LOGIN NOSUPERUSER NOINHERIT BYPASSRLS CREATEDB NOCREATEROLE NOREPLICATION` | — | `roles` від суперкористувача |
| `simetra_command` | `NOLOGIN NOINHERIT` | без змін | `roles` |
| `simetra_runtime` | `LOGIN NOINHERIT` | `simetra_command` і `simetra_user`, обидва `WITH INHERIT FALSE, SET TRUE` | `roles` |
| `simetra_user` | `NOLOGIN NOINHERIT` | — | `roles` |
| `simetra_anon` | `NOLOGIN NOINHERIT` | — | `roles` |
| `simetra_signal_consumer` | `NOLOGIN NOINHERIT` | — | `roles` |
| `simetra_signals` | `LOGIN INHERIT` | `simetra_signal_consumer` `WITH INHERIT TRUE, SET FALSE` | `roles` |
| `simetra_auth` | `LOGIN NOINHERIT` | — | `roles`; власник схеми `better_auth` |

Правила:

- Імена — дані T0 (`packages/simetra/src/model/schemas/project.ts`):
  - `PROVIDER_API_ROLES.postgres = { user: "simetra_user", anonymous: "simetra_anon", service: null }`;
  - `LOGIN_ROLE_REQUEST_PURPOSES.postgres = ["user"]`;
  - `PLATFORM_ROLES` дістає `signalConsumer: "simetra_signal_consumer"`;
  - `PROVIDER_LOGIN_ROLES.postgres = ["simetra_auth", "simetra_signals"]`;
  - нова стала `PLATFORM_OWNER_ROLES.postgres = "simetra_owner"`.
- Паролі ставить оператор поза платформою (спека П4 §6.2): секретів
  платформа не тримає.
- Інваріанти членства спеки П4 §6.2 діють без змін і для `simetra_user`:
  `simetra_command` і роль запиту не члени одна одної; з ролі запиту не
  досяжна роль з `ADMIN` на ролі платформи чи з `SUPERUSER`.
- `simetra_signals` має `INHERIT`, бо Centrifugo не вміє `SET ROLE`; права
  він отримує лише через групу, тож гранти, як і раніше, не видаються ролям
  входу (`GrantPurpose` без ролей входу).
- Ролі кластерні. Кілька застосунків на одному кластері ділять ці ролі, як
  уже ділять `simetra_command`. Ізоляція застосунків — окремі бази й гранти
  на рівні бази (`CONNECT`), а не окремі імена ролей.

**Тип `ProviderApiRoles`.** Поле `service` стає `string | null`. Генератор
грантів пропускає отримувача `null`: функції множини скоупу й сесії не
дістають `EXECUTE` для сервісної ролі, бо її немає. Значення
`publicRead` (`authenticated`, `anon` у
`packages/simetra/src/model/schemas/public-read.ts`) — мітки призначення в
метаданих, а не імена ролей: генератор мапить їх на `PROVIDER_API_ROLES`
профілю. Перейменування міток не потрібне й у цю спеку не входить.

**Вплив на код:** `project.ts` (дані вище), `platform-roles.ts`
(`platformRoleSet` за профілем, створення ролей запиту, власника й
споживача, `DEFAULT_REQUEST_NAMES` без `null`), `access-units.ts` (пропуск
отримувача `null`).

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
  оператора). Інструмент створює відсутні ролі §3.1, звіряє наявні й видає
  власнику типові привілеї схеми `better_auth` (§4.2). Повторний запуск
  ідемпотентний.
- `plan` і `apply` від суперкористувача не вимагають: `simetra_owner` має
  `CREATEDB` для co-located тіні (платформна спека §6.2).
- `roles` без суперкористувача у `postgres` відмовляє
  `roles.superuser-required` і нічого не створює: половина ролей без
  `BYPASSRLS` мовчки змінила б поведінку прав.

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
Генератор провізії мусить брати кожне ім'я з пресету через
`quote_ident`-еквівалент, а не вставляти голим. Хост-шаблон фіксує
вбудований адаптер; адаптер Drizzle з `snake_case` — інша форма колонок і
поза пресетом.

**Плагін `anonymous` обов'язковий у шаблоні host-а.** Пресет посилається на
`isAnonymous`; без плагіна колонки немає, і тригер
`simetra_provision_converted_user` не створюється. Тому шаблон host-а
вмикає плагін завжди, а DB-тест пресету йде на таблиці з колонкою.

### 4.2 Схема й порядок розгортання

1. `roles` створює `simetra_auth` і схему `better_auth` з
   `AUTHORIZATION simetra_auth`, а також
   `ALTER DEFAULT PRIVILEGES FOR ROLE simetra_auth IN SCHEMA better_auth
   GRANT TRIGGER ON TABLES TO simetra_owner`. Так власник платформи ставить
   тригер провізії на таблицю, якою не володіє.
2. Міграція Better Auth (`npx auth migrate` від `simetra_auth`, конфіг
   `database.schemaName: "better_auth"`) створює свої таблиці. Схемою
   володіє вона, а не платформа (ПП5).
3. `simetra apply` від `simetra_owner` ставить тригери провізії на
   `better_auth."user"`. Немає таблиці — відмова плану
   `plan.identity-table-missing` з порадою виконати міграцію провайдера.

Гейт бачить у схемі `better_auth` лише тригери провізії
(`PROVIDER_SURFACES.postgres`, клас `trigger`, таблиця `user`). Схема
входить у `PROVIDER_SCHEMAS.postgres`; інших схем провайдера профіль не має.

**Тінь і копія доказу.** Пресет дає schema-only засів тіні:
`CREATE SCHEMA better_auth` і `CREATE TABLE better_auth."user"` з
колонками, які читає пресет (`id uuid`, `name`, `email`, `isAnonymous`).
Засів — функція `renderProviderSeed(provider)` (зараз без аргументу й лише
для `supabase`). Тінь не потребує решти таблиць Better Auth: гейт їх не
бачить.

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
  а `current_user_id()` читає `invalid`. Кеш сесії Better Auth у cookie
  (`session.cookieCache`) відкладає лише вихід, а не недійсність.

**Вплив на код:** запис пресету в `project.ts`; адаптер `verifySession`
Better Auth — у шаблоні host-а (П4-D), не в `simetra`: пакет не залежить від
`better-auth`.

**Тест:** DB-тест провізії на стеку `postgres` з таблицею, створеною
справжньою міграцією Better Auth закріпленої версії (не рукописним DDL):
реєстрація, анонім, конвертація на місці, прив'язка з видаленням аноніма,
видалення облікового запису, конкурентна реєстрація того самого `id`. Unit:
SQL провізії з пресету `postgres` бере імена колонок у лапках. Тест засіву:
колонки засіву тіні ⊆ колонок справжньої міграції.

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
- `id` з послідовності дає порядок вибірки споживача (`ORDER BY id`). Це
  порядок вставки, а не коміту; приймачу порядок не потрібен, бо показ рухає
  версія рядка (звіт спайку realtime, вимога 2).
- Один розділ: `num_partitions = 1`, `CHECK (partition = 0)`.
- `payload` — запит публікації Centrifugo:
  `{ "channel": <топік>, "data": <прийняте повідомлення>, "idempotency_key": <id повідомлення> }`.
  `data` — схема прийнятого повідомлення П4-B: схема відправки плюс верхній
  `id` (UUID, `gen_random_uuid()`). `idempotency_key` = той самий `id`: якщо
  споживач опублікував подію, а `DELETE` не закомітився, повтор не дасть
  дубля в історії каналу.
- Таблицю, послідовність, тригер і функцію тригера генерує платформа в
  схемі `simetra`; власник — `simetra_owner` (у `supabase` — роль
  застосування). Таблиця входить у межу гейта як об'єкт платформи.

### 5.2 Гранти, RLS, `NOTIFY`

- `ENABLE ROW LEVEL SECURITY`, без `FORCE`.
- `simetra_command`: `INSERT (method, payload)`, `USAGE` на послідовність
  `id`. Політику `INSERT` у режимі відправки задає П4-B; ця спека лише
  фіксує, що іншого запису в outbox у ролей застосунку немає.
- `simetra_signal_consumer`: `USAGE` на схему `simetra`, `SELECT` і `DELETE`
  на таблицю й політики `signal_outbox_consumer_select` і
  `signal_outbox_consumer_delete` (`USING (true)`, `TO simetra_signal_consumer`).
  Жодного іншого гранту в схемі `simetra`; це названий виняток із правила
  «ролі застосунку не мають грантів на таблиці `simetra`» (С1).
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
- Один інстанс Centrifugo на застосунок (ПП3). Другий інстанс для
  доступності читає той самий outbox; `use_try_lock` не дає їм чекати один
  одного.

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
    "token": { "jwks_public_endpoint": "<host>/simetra/signals/jwks" },
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
| з'єднання | `sub` = `claims.sub` сесії, `exp` | 15 хв | endpoint host-а після `verifySession`; без сесії чи для аноніма — 401 |
| каналу | `sub`, `channel`, `exp` | 5 хв | endpoint host-а: `runtime.authorizeChannels` (П4-B) повертає дозволені канали, порт підписує токен на кожен |

- Клієнт оновлює обидва токени колбеком `getToken` SDK до `exp`; відмова
  авторизації каналу — `auth` порту каналу без автоповтору (П4-B).
- Відкликане право перестає тримати підписку щонайпізніше через TTL токена
  каналу: на оновленні `signal_topic_allowed` поверне `false`. Сигнал прав
  (П4-B) змушує чесного клієнта перепідписатись раніше. Через короткий TTL
  обмеження Supabase «кеш авторизації на час з'єднання» тут не діє.
- Анонім сигналів не отримує (як §8.6 П4-B).

### 6.3 Підпис і ротація

- Алгоритм — EdDSA (Ed25519, `kty: OKP`); ключ — WebCrypto, без залежності.
  Кожен токен має `kid`.
- Host публікує JWKS на `/simetra/signals/jwks`; Centrifugo кешує ключі до
  години.
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
- Клієнтська частина — реалізація порту каналу П4-B над SDK `centrifuge`
  (`simetra/data/centrifugo`, peer-залежність); вона одна для обох
  профілів.

**Тест:** unit — claims і `kid`, перевірка підпису публічним ключем з JWKS,
`exp`; стенд — Centrifugo приймає токен з JWKS host-а, відхиляє чужий
канал, прострочений токен і токен невідомого `kid`; ротація за правилом
§6.3 без розриву підписок.

## 8. Файли: Garage і порт сховища

### 8.1 Межа рядка й байтів

- **Файл — рядок об'єкта з властивістю `storage`.** Властивість оголошує
  об'єкт довідника чи прийнята `CustomTable` у метаданих. Платформа знає
  мапінг колонок рядка: ключ сховища, розмір, тип вмісту, ім'я файлу.
  - Для виду платформа виводить ці колонки як стандартні реквізити з
    реєстру видів (`packages/simetra/src/model/kinds/`).
  - Для прийнятої таблиці вкладень споживача — мапінг на її наявні колонки,
    як мапінг членства прийнятої таблиці (спека прав §4.7). Мапінг — межа:
    платформа читає ці колонки, а запис іде командами чи кодом споживача,
    доки таблицю не промотовано.
- Доступ до рядка — RLS рядка, як до будь-якого об'єкта (§6.8 платформної
  спеки). Доступ до байтів — лише серверні endpoint-и після читання рядка
  під роллю запиту.
- Колонку ключа пише лише платформа: колонковий грант `simetra_command` без
  цієї колонки, значення ставить серверний шлях завантаження (нижче).

### 8.2 Ключ, бакет, потоки

- **Бакет на застосунок;** ключ доступу Garage дає читання й запис лише
  цього бакета; ключ знає лише host. Публічного доступу, вебсайту бакета й
  підписаних посилань немає (ПП4).
- **Ключ об'єкта** — `o/<id рядка>`; id — UUID, який генерує сервер. Ключ
  не залежить від вводу клієнта, тож клієнт не може адресувати чужий
  об'єкт. Garage ігнорує `If-None-Match: *`, тож від перезапису захищає
  лише унікальність id.
- **Завантаження:** endpoint перевіряє сесію → генерує id → пише байти в
  `o/<id>` з межею розміру (`maxBytes` об'єкта) і рахує розмір сам → команда
  `create` рядка з id, ключем, розміром, типом і ім'ям в одній транзакції з
  обліком обсягу. Відмова команди → видалення об'єкта після відповіді
  (`afterCommit` не настає, тож видаляє endpoint); що лишилось — прибирає
  звірка.
- **Читання:** endpoint читає рядок під роллю запиту (`runtime.read`) → немає
  рядка — 404 (той самий для «немає» й «не можна») → потік з
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
  `Cache-Control: private, no-store`.
- **Видалення:** команда видаляє рядок; `afterCommit` видаляє об'єкт;
  невдача — звірка.
- **Звірка** — фонове завдання host-а: об'єкти бакета без рядка, старші за
  24 год, видаляються. Рядок без об'єкта — дефект, звірка його журналює.

### 8.3 Облік обсягу

- Тригер `AFTER INSERT OR UPDATE OF <розмір> OR DELETE` на таблиці рядків
  файлів у транзакції запису веде `simetra.storage_usage (scope_kind,
  scope, bytes)` (upsert).
- Межу обсягу (`simetra.storage_quota`, за скоупом; без рядка — без межі)
  перевіряє той самий тригер: понад межу — відмова
  `storage.quota-exceeded`, і команда відкочується разом з обліком.
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
- У профілі `supabase` прийняті бази лишаються на Storage-API з політиками
  на `storage.objects` (ПП4); нові об'єкти з властивістю `storage` в обох
  профілях ідуть через цей порт.
- Перенесення байтів зі Storage у Garage — частина переїзду споживача (спека
  профілів §4), не платформи.

**Тести:** unit — ключ з id, межа розміру на потоці; DB — облік обсягу на
вставці, зміні й видаленні, відмова понад межу з відкатом, колонку ключа
`simetra_command` не пише; стенд з Garage — повний цикл, чужий рядок дає 404
без звернення до бакета, звірка прибирає сироту.

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
| Centrifugo | `centrifugo/centrifugo` v6, точний тег | 8100 | обидва |
| Garage | `dxflrs/garage`, точний тег | 3900 (S3), 3903 (admin) | `postgres` |
| Supabase | Supabase CLI 2.122.1, як зараз | 54322, 54329 | `supabase` |

- Compose-проєкт `simetra-pg` у каталозі `docker/` репо: Dockerfile образу
  Postgres, `compose.yaml`, конфіг Centrifugo стека, скрипт ініціалізації
  Garage (layout, бакет `simetra-dev`, ключ). Версії — у файлах стека, не в
  `AGENTS.md`.
- Better Auth не має сервісу: він живе в host-і. Для тестів його таблиці
  створює справжня міграція закріпленої версії (§4.4) у шаблонній базі
  стека.
- Стек `supabase` дістає Centrifugo: шаблон конфігу з DSN бази стека. Сервіс
  `realtime` у `supabase/config.toml` вимикається: він більше не
  використовується.

### 10.2 Команди

| Команда | Дія |
| --- | --- |
| `pnpm db:pg:start` | `docker compose -p simetra-pg up -d --wait`, далі ролі (`supabase/roles.sql`-аналог для `postgres`) і `simetra.environment = 'development'` |
| `pnpm db:pg:stop` | `docker compose -p simetra-pg down` (томи лишаються; `--volumes` — лише явно) |
| `pnpm test:db:pg` | DB-тести `simetra` і `@simetrajs/designer` на стеку `postgres` |
| `pnpm db:start`, `pnpm db:stop`, `pnpm test:db` | стек `supabase`, як зараз; `test:db` — лише регресійні набори (§10.5) |

Стек запускається лише цими командами, ніколи глобальним `docker compose`
без `-p` чи сторонньою версією образів.

### 10.3 Stack-guard і тег прогону

`packages/simetra/test/db/stack-guard.ts` стає параметризованим профілем
(`SIMETRA_TEST_PROVIDER = postgres | supabase`, типово `postgres`):

- **замок на стек:** окремий файл замка на профіль; прогони різних стеків
  не чекають один одного, прогони одного — по черзі;
- **адреси:** `connection.ts` бере DSN з даних профілю (`postgres`:
  `postgresql://postgres:postgres@127.0.0.1:54422/postgres`, суперкористувач
  — той самий); змінні `SIMETRA_TEST_*` їх перевизначають;
- **знімок стека:** до бази, ролей, схем і розширень додаються контейнери з
  міткою `simetra-run=<тег>` і бакети Garage з префіксом тегу; різниця після
  прогону — збій, як зараз;
- **прибирання на сигналах:** ті самі SIGINT, SIGTERM, SIGHUP; додатково
  `docker rm -f` контейнерів свого тегу й видалення бакетів свого тегу;
- **тег прогону:** бази, ролі й тіні — як зараз (`connection.ts`);
  контейнер Centrifugo стенду — мітка й ім'я з тегом; бакет — `run-<тег>`.

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
- `supabase test db` лишається лише для набору базового стану провайдера
  `supabase/tests/provider-base-state.test.sql`. Аналог для `postgres` —
  набір базового стану стека `postgres` через раннер: версія 17, ролі §3.1 і
  їхні атрибути, схема `better_auth`, розширення `pgtap` і `plpgsql_check`.
- **Розподіл DB-тестів:**
  - проєкт `db` — на стеку `postgres`; роль запиту й таблицю ідентичності
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
| `db` | `postgres` | базовий стан `postgres`, DB `simetra`, DB designer | `simetra` + 4 designer, як зараз |
| `db-supabase` | `supabase` | `supabase test db`, `db-supabase` обох пакетів | 1 |
| `packaging` | — | без змін | 1 |

- Стек `postgres` у CI стартує тим самим `pnpm db:pg:start`; образ Postgres
  збирається з кешем шарів (або тягнеться з реєстру за digest).
- Повторні спроби старту — як для Supabase зараз (до 3, з паузою).

### 10.7 Текст для `AGENTS.md` (затверджує власник)

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

- «The local stack is started only through `pnpm db:*` (pinned CLI
  version)» → «Each local stack is started only through its `pnpm db:*`
  commands (pinned images and CLI), never through a global `supabase` or
  `docker compose` without the project name.»
- «The local stack is one per machine and shared…» → «Each local stack
  (`postgres`, `supabase`) is one per machine and shared by every session
  and agent on it.» Далі без змін, з доповненням після речення про
  `globalSetup`: «The guard is per stack: runs on different stacks do not
  wait for each other.»
- Абзац про run tag доповнити: «Signal stands and buckets carry the run tag
  too: a Centrifugo container gets the `simetra-run=<tag>` label, a Garage
  bucket the `run-<tag>` name; the guard removes its own on exit and on the
  same signals.»
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

Порядок жорсткий: кожен блок стоїть на попередньому.

| Блок | Обсяг | Готово, коли | Залежить від |
| --- | --- | --- | --- |
| **ПГ-1. Стек і тест-інфра** | `docker/` (образ, compose, конфіги, ініціалізація Garage); `pnpm db:pg:*`, `test:db:pg`; stack-guard за профілем (замок, адреси, знімок, контейнери й бакети); Vitest-раннер pgTAP; набір базового стану `postgres`; розподіл `db` / `db-supabase` і переведення тестів на дані профілю; CI-матриця; Centrifugo в стеку `supabase`, `realtime` вимкнено; текст `AGENTS.md` на затвердження | обидва стеки стартують своїми командами; `db` зелений на `postgres`, `db-supabase` — на `supabase`; прогін, перерваний SIGINT, не лишає ні баз, ні контейнерів, ні бакетів; CI зелений | — |
| **ПГ-2. Провайдер у схемному рушії** | `postgres` у `DATABASE_PROVIDERS` і всіх мапах T0 і T2; споживачі `PROVIDER_SCHEMAS.supabase` і `SUPABASE_*` — за `scope.provider`; `renderProviderSeed(provider)`; ролі §3 у `roles`; `service: null`; гейт `plan.owner-not-bypassrls` | наявні гейт, план, доказ і застосування проходять на `postgres` тими самими DB-тестами; каталожний гейт бачить у чужих схемах лише розширення й тригери провізії; тест ролей §3.1 зелений | ПГ-1 |
| **ПГ-3. Ідентичність** | запис пресету §4.1; імена колонок у лапках; засів тіні `better_auth`; `plan.identity-table-missing`; адаптер `verifySession` у шаблоні host-а (разом з П4-D) | DB-тести §4.4 на таблиці справжньої міграції зелені; `runCommand` і читання з claims Better Auth дають той самий `current_user_id()`, що й на `supabase` | ПГ-2 |
| **ПГ-4. Outbox, споживач, токени** | таблиця, гранти, політики споживача, `NOTIFY`, `prune`; конфіг Centrifugo з designer; `simetra/server/signals` (порт, EdDSA, JWKS); стенд сигналів у тест-інфрі; разом із B8 П4-B — тіла функцій сигналу й `authorizeChannels` | тести §5.3 і §7 зелені в обох профілях; на стенді сигнал команди доходить, чужий канал і прострочений токен відхилено, ротація без розриву | ПГ-3; B6 П4-B |
| **ПГ-5. Сховище файлів** | властивість `storage` у T0 з мапінгом; стандартні реквізити виду; облік і межа обсягу; `FileStore`, `fromS3Client`; endpoint-и й звірка в шаблоні host-а | тести §8 зелені на стеку `postgres` з Garage | ПГ-2 (схема), П4-D (host) |

ПГ-5 не залежить від ПГ-3 і ПГ-4 і може йти паралельно з ними після ПГ-2.

## 13. Поправки інших документів

| Документ | Місце | Поправка | Рішення |
| --- | --- | --- | --- |
| спека профілів провайдера | ПП2 | прибрати «PostgREST лишається адаптером, доступним і в `postgres` як перехідний» | ПГ12 |
| спека профілів провайдера | ПП3 | транспорт `supabase` — теж outbox і Centrifugo; `realtime.send` і політики на `realtime.messages` не використовуються; споживач на нетимчасовій помилці губить сигнал, на тимчасовій — повторює | ПГ6, напрям власника |
| спека профілів провайдера | ПП5 | схема Better Auth — `better_auth` (`database.schemaName`), вбудований адаптер, плагін `anonymous` | ПГ4 |
| спека профілів провайдера | §5 | питання закрито цією спекою (посилання) | усі |
| платформна спека | Р31, §8.2 | один транспорт в обох профілях: outbox → PG-споживач Centrifugo; «ретранслятор передає його через `LISTEN/NOTIFY`» замінити на «вбудований споживач Centrifugo читає outbox (`LISTEN/NOTIFY` і опитування)» | ПГ6 |
| платформна спека | §6.9 | у `supabase` політики приватних каналів на `realtime.messages` зникають з переліку поверхонь гейта | напрям власника |
| платформна спека | §6.7 | профіль без сервісної ролі; виняток для `simetra_signal_consumer` на outbox | ПГ1, ПГ7 |
| спека системної схеми | С1, §3 | у схемі `simetra` — `signal_outbox`, `storage_usage`, `storage_quota`; грант групи споживача | ПГ7, ПГ11 |
| спека П4 | §6.2 | рядок `simetra_runtime` для `postgres`: член `simetra_user` | ПГ1 |
| спека П4-B (редакція 3) | §8.2, §8.3, §8.5, §8.6, B2, B8 | тіла сигналу — outbox в обох профілях; кеш авторизації Realtime замінює TTL токена каналу; порт каналу над `centrifuge`; e2e-стек — стенд сигналів цієї спеки | узгоджує архітекторка |
| `AGENTS.md` | «Commands and gates» | текст §10.7 | власник |

## 14. Відкриті питання

| Питання | Пропозиція |
| --- | --- |
| Керовані Postgres (RDS, Neon, Azure) не завжди дають створити роль з `BYPASSRLS` | перша ціль `postgres` — власний сервер; для керованого провайдера — окремий пресет після перевірки його атрибутів ролей |
| Кілька інстансів Centrifugo з рушієм Redis | після першої віхи, коли знадобиться доступність; outbox і токени від цього не змінюються |
| Примусове від'єднання при недійсності користувача | TTL токенів (§6.2) вважаємо достатнім; HTTP API `disconnect` — з першою вимогою |
| Числа історії (`history_size`, `history_ttl`) | уточнює бенчмарк B2 П4-B |
