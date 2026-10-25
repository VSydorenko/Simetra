# Права-2d1: прийняті джерела членства й призначень — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: чернетка автора, на аудиті.
Архітектор задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** прийняті таблиці членства й призначень (спека прав §4.7, Рх14) дають
права. Учасник прийнятого джерела членства входить у «мої скоупи», рядок
прийнятого джерела призначень вмикає архетип за ключем ролі (`sourceKeys`),
межа видимості «Користувачів» бачить учасників джерела, а системні довідники
прав виду з прийнятим членством посилаються на прийняту таблицю. Проєкт без
«Користувачів» отримує `simetra.current_user_id()` з `sub` (Р2a1-30). План
перевіряє власника таблиці-джерела й попереджає про невідомі ключі ролей у
даних цілі. Попередження `rights.adopted-source-unsupported` зникає.

**Архітектура:**

- **T0** (`packages/simetra/src/model`): факт провайдера
  `IdentitySource.subjectIsUserId` (С8) у `PROVIDER_IDENTITY_SOURCES`.
- **T1** (`packages/simetra/src/compiler`): контракт джерела членства знає
  ключ учасника; `rights_my_scopes`, `rights_mine` і `rights_visible_users`
  (`compiler/rights/functions.ts`) читають джерела; нова функція даних
  `rights_source_keys`; ціль `member` системних довідників — прийнята таблиця
  членства (`compiler/stages/model.ts`); шар сесії без «Користувачів»
  (`compiler/platform/units.ts`); перевірки джерел (`compiler/rights/checks.ts`,
  `system-catalogs.ts`).
- **T2** (`packages/simetra/src/schema/apply`, форма гілки `feat/rights-2b2`):
  `rights-sources.ts` — читання цілі для перевірок плану; `plan.ts` — відмова
  `plan.rights-source-access` і попередження `plan.rights-source-unknown-keys`
  в обох гілках.
- **Тести:** unit на деревах SQL і плані; один DB-файл з двома описами (з
  «Користувачами» й без).

**Стек:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query (WASM),
локальний стек Supabase (Postgres 17).

**Спека:** [спека прав](../specs/2026-10-17-rights-design.md) — читати
повністю, головне Рх7, Рх14, §4.2, §4.6, §4.7, §5.1, §5.2 (рядок «Користувачі»);
[спека системної схеми й користувачів](../specs/2026-10-07-system-schema-users-design.md)
§7, §7.1 (С5, С8), §8, §12; [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
§6.7, §6.8. Плани [Права-2a1](2026-10-18-rights-2a1-command-role-functions.md)
(Р2a1-12, Р2a1-21, Р2a1-24, Р2a1-25, Р2a1-26, Р2a1-30),
[Права-2a2](2026-10-18-rights-2a2-read-policies-carriers.md) (Р2a2-15,
Р2a2-18, Р2a2-24), [Права-2b1](2026-10-24-rights-2b1-write-policies-effects.md) і
[Права-2b2](2026-10-24-rights-2b2-carrier-backfill.md) — їхні таблиці рішень
діють, їхні форми тут — дані.

**Залежність:** Права-2b2 виконано й прийнято (гілка `feat/rights-2b2` чи її
злиття): `schema/apply/plan.ts` має форму 2b2 (`carrierBackfillSteps`,
`PLAN_FORMAT` 6). Від 2c1/2c2 план не залежить; 2c1 можна виконувати
паралельно в іншому worktree (спільні файли — лише `compiler/diagnostics.ts`,
`compiler/messages.ts`, скіл споживача: конфлікти механічні). Перед стартом —
`.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-25-rights-2d1-adopted-sources.md`.

**Поділ Прав-2c/2d** (погоджено архітектором 2026-10-25, Ф1): 2d1 (цей план) →
2c1 «заборони й межа довіри» → 2c2 «адміністрування прав: запобіжники, версії,
журнал» → 2d2 «аналіз прав, гейт планів, бенчмарк». 2d1 і 2c1 можуть іти
паралельно.

## Global Constraints

- Усі обмеження планів Права-2a1, 2a2, 2b1 і 2b2 (розділи «Global Constraints») діють і тут.
- 🔴 `pnpm --filter <pkg> test <pattern>` — **без** `--` перед шаблоном.
- 🔴 «Мої скоупи» обчислює **лише** `rights_my_scopes()` (Р2a1-25); гілка джерела членства — у ній, інші функції читають прийняте членство лише за скоупами з неї. Кожна множина учасників і скоупів типізована видом скоупу (Р2a1-26).
- 🔴 Прийняте джерело платформа **лише читає**: жодних тригерів, політик, грантів чи DDL на таблиці-джерелі; DDL прийнятої таблиці (зокрема `UNIQUE (scope, id)`) — лише через її метадані `CustomTable`.
- 🔴 Fail-closed: невідомий ключ ролі, неактивний рядок, учасник іншого виду, `NULL` у колонці зв'язку — рядок прав не діє, без помилки. Помилки компілятора — лише на моделі; на даних цілі — лише попередження плану.
- 🔴 Прийняте джерело дає призначення **лише архетипам** (§4.7): кастомних ролей і дельт з джерела немає.
- Функції прав — `LANGUAGE sql`, `SET search_path = ''`, кваліфіковані відношення, `(SELECT "simetra"."current_user_id"())`; функції даних — `IMMUTABLE`, без `SECURITY DEFINER` і `EXECUTE` (Р2a1-14).
- Перевірки плану читають ціль лише читальною транзакцією `dbs.reader` (Р2a1-2); дані таблиць — під `row_security = off` (на `FORCE ROW LEVEL SECURITY` — гучна помилка, не тихий нуль).
- DB-тест — лише для того, що вирішує Postgres; SQL-текст — unit. Скіл `.agents/skills/writing-tests/SKILL.md` обов'язковий перед кожним кроком тестів.
- Між задачами гейти не червоні: зміна, що ламає тест, і правка цього тесту — в одному коміті.
- Репо публічне: фікстури синтетичні.

## Рішення плану

Розвилки Ф1 і Ф12 вирішив архітектор задачі 2026-10-25. Доповнення 2d1
(Р2d1-15…Р2d1-19, Задача 3a) — рішення архітектора після Задач 0–2: форма
§4.7 не вміщала поліморфної таблиці призначень і таблиці ролей зі спільними
ключами системних і кастомних ролей.

| # | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р2d1-1 | Поділ і черговість — 2d1 → 2c1 → 2c2 → 2d2; 2d1 і 2c1 паралельно (архітектор, Ф1) | 2d1 на критичному шляху першого споживача й від 2c не залежить: адаптеру не потрібні ні версії, ні журнал (платформа джерело лише читає); аналіз прав 2d2 гейтить дія адміністрування з 2c2 (спека §5.1) | немає |
| Р2d1-2 | Учасник прийнятого джерела членства = первинний ключ таблиці-джерела, лише коли він одноколонковий і має тип `UUID`; інакше помилка `rights.source-member-key` на `/membershipSources/<i>/table` з порадою оголосити одноколонковий uuid-ключ у метаданих `CustomTable` (архітектор, Ф12). Контракт: `MembershipSourceContract.member: string` — фізична колонка ключа | id учасника — значення носія власності, суб'єкта призначення й колонки `member` джерела призначень; складений ключ не має одного значення | спека прав §4.7 — «учасник — одноколонковий uuid-ключ таблиці-джерела» (Задача 0) |
| Р2d1-2a | Типи змапованих колонок джерел перевіряє компілятор: `scope`, `user`, `member`, `container` — `UUID`, `active` — `Boolean`, `role` — `Text` чи `String(n)`; інакше помилка `rights.source-column-type` `{ source, column, expected }` на `/membershipSources/<i>/columns/<поле>` чи `/assignmentSources/<i>/columns/<поле>` | інакше невідповідність типів виявилася б лише під час створення чи виконання функцій прав на застосуванні | немає |
| Р2d1-3 | `rights_my_scopes()` — гілка `UNION ALL` на кожне джерело членства: `SELECT <вид>, s.<scope>, s.<member> FROM <таблиця> s WHERE s.<user> IS NOT NULL AND s.<user> = (SELECT current_user_id()) [AND s.<active> IS TRUE]`; умова активності — лише коли колонку змаплено | та сама форма, що гілка довідника членства (Р2a1-25); `IS TRUE` — `NULL` в активності не дає членства (fail-closed) | немає |
| Р2d1-4 | Ключ ролі → архетип — нова функція даних `simetra.rights_source_keys() RETURNS TABLE (source_id uuid, key text, role_id uuid)` (`VALUES` з `Role.sourceKeys` усіх ролей; `IMMUTABLE`, без `EXECUTE`, як Р2a1-14). `rights_mine`: CTE `assignments` отримує гілку на кожне джерело призначень — `storage = 'source'`, `storage_id = <sourceId>`, `custom_role = NULL`, `archetype` — з `rights_source_keys()` за (`source_id`, значення колонки `role`) внутрішнім з'єднанням (невідомий ключ — нуль рядків); рівень скоупу й контейнерний з контейнером у виді скоупу K — `JOIN my_scopes s ON s.scope_kind_id = <K> AND s.member = src.<member>`, `scope = s.scope`; глобальний і контейнерний з нескоупленим контейнером (вид скоупу контейнера відсутній, як `Project` з `scope: "none"` у `singleTenantRights`; `storageOf` — глобальний; якір виправлено за фактом коду: `Partner` у `kitchen-sink.ts` скоуплений) — `src.<member> = (SELECT current_user_id())`, `scope = NULL`; `container` — колонка `container` джерела (лише контейнерний рівень, інакше `NULL`); `[AND src.<active> IS TRUE]`. CTE `assignments` отримує дві нові колонки: `scope_kind_id` (довідник — його `storage_id`, бо рівень зберігання й є вид скоупу чи `NULL`; джерело — стала K чи `NULL`) і `source_level`/`source_level_id` (джерело — стала рівня джерела, довідник — `NULL`). `typed`: рядок довідника — як зараз (за рівнем зберігання); рядок джерела — `JOIN rights_roles() r ON r.role_id = x.archetype AND r.level = x.source_level AND r.level_id IS NOT DISTINCT FROM x.source_level_id` (рівень зберігання ролей, покритих джерелом, — `NULL`, Р2a1-12, тож рядок довідника їх і далі не вмикає). `held` порівнює вид скоупу контейнера з `t.scope_kind_id`, а не з `t.storage_id` (`storage_id` рядка джерела — id джерела, тож без цієї зміни жоден контейнерний рядок джерела не пройшов би `held`). Дельти й замикання — без змін (кастомної ролі в рядку джерела немає) | один шлях обчислення для довідника й джерела; ключ і рівень — сталі генератора, не дані | немає (§4.7) |
| Р2d1-5 | Системні довідники прав виду, чиє членство дає лише прийняте джерело: ціль стандартного посилання `member` (`standardTargetRefs`) — таблиця-джерело членства виду; складений FK `(скоуп, subject)` потребує `UNIQUE (scope, id)` у метаданих таблиці (`uniques`) — інакше помилка `rights.source-member-unique` на `/membershipSources/<i>/table` з порадою додати обмеження в метадані `CustomTable` (архітектор, Ф12). Помилка `rights.system-catalog-scope` (Р2a1-24, п. 4) лишається лише для виду без жодного членства; пропуск `rights.system-catalog-missing` для виду з членством із джерела знімається — рівень з ролями, не покритий джерелом призначень, потребує довідників, як будь-який інший (Р2a1-5) | сценарій першої міграції: прийняте членство й нові ролі в довідниках Simetra (Р2a1-24, змішування). Наслідок, прийнятий свідомо (як для власності, §4.2, що вже посилається на прийняту таблицю): FK встановлює RI-тригери Postgres на таблиці-джерелі, тож видалення застосунком рядка учасника, на якого посилається призначення Simetra, відмовляє `23503` — це FK, а не тригер платформи; помічники — наявні `singleUuidKeyColumn` (`model/kinds/custom-table.ts`) і `hasScopeKeyUnique` (`compiler/stages/model.ts`) | спека прав §4.7 — речення про `subject` системних довідників, `UNIQUE (scope, id)` і про те, що видалення учасника з призначеннями Simetra відмовляє FK (Задача 0) |
| Р2d1-6 | `simetra.current_user_id()` без «Користувачів» (Р2a1-30): генерується, коли довідника з роллю `users` немає, у проєкті є хоч одне джерело членства, а провайдер має факт T0 `PROVIDER_IDENTITY_SOURCES[provider].subjectIsUserId === true` (Supabase, С8). Тіло — plpgsql `STABLE SECURITY DEFINER SET search_path = ''`: `sub` з `SESSION_CLAIMS_SETTING`; рядок, що відповідає `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`, → `::uuid`, інакше `NULL` (без помилки приведення; спека системної схеми §7.1). `EXECUTE` — ті самі `SESSION_ROLES`, що в шарі з «Користувачами»; гранти схеми `simetra` — рівно одним джерелом (`platformSchemaGrants`, без дубля зі станом застосування). Анонімна сесія провайдера (claim `is_anonymous` = `true`, факт T0 `IdentitySource.anonymousClaim: "is_anonymous"` для Supabase; відхилення при виконанні, погоджено архітектором: `anonymousClaim` — обов'язкове `string | null` (`null` — у провайдера немає анонімних сесій), щоб новий провайдер не міг тихо пропустити анонімну перевірку; вплив на спеку: немає)) — `NULL`: з «Користувачами» анонімних входів провізія не створює (`anonymousColumn`), тож без цього анонімний вхід отримав би права `everyUser`. Без джерела членства чи без факту провайдера функції немає, і права не генеруються (тихо, fail-closed: `rights.users-missing` при наявному джерелі членства не спрацьовує, а провайдер зараз один — Supabase — і факт має). Функція — без `ownerObjectId` (як функції прав), гранти схеми `simetra` дає `renderApplyState` (`schema/apply/state.ts`, вже для проєкту без «Користувачів»), шар їх не повторює. Недійсності користувача без «Користувачів» немає — відоме обмеження | §4.6: права без «Користувачів» — лише з прийнятим джерелом членства на провайдері, де id = `sub` | спека системної схеми §7 — речення про функцію без «Користувачів», зокрема анонімну сесію (Задача 0) |
| Р2d1-7 | Предикати генераторів: `hasRightsFunctions(contracts, provider)` = є `Role` і є функція поточного користувача (`contracts.users !== undefined` або умова Р2d1-6) — один експортований помічник `hasSessionUser`, з яким звіряються шар сесії, генератор прав і генератори політик (Р2a2-24); `hasVisibleUsers` = `hasRightsFunctions` ∧ є «Користувачі» ∧ (довідник членства ∨ джерело членства) | одне місце правди: політика не кличе функції, якої немає | немає |
| Р2d1-8 | `rights_visible_users()` — гілка на кожне джерело членства: користувачі рядків джерела, з'єднаних з `rights_my_scopes()` за (`scope_kind_id`, скоуп), з тією самою умовою активності, що Р2d1-3 | закриває борг «Межа Користувачів при членстві лише з прийнятого джерела»; без неї глобальна роль з `read` на «Користувачах» бачила б усіх | немає (§5.2) |
| Р2d1-9 | Попередження `rights.adopted-source-unsupported` видаляється; замість нього — попередження `rights.adopted-source-writes` на кожне джерело (вказівник `/membershipSources/<i>` чи `/assignmentSources/<i>`, лише коли в проєкті є `Role`) з текстом межі відповідальності: «платформа джерело лише читає; шляхи запису в нього — застосунку, і запобіжники прав на них не діють, доки таблиці прав не промотовано» (uk; en — той самий зміст) | §4.7: «план попереджає про це при оголошенні джерела»; попередження компілятора видно й у плані (`checkDiagnostics`) | немає |
| Р2d1-10 | Доступ до таблиці-джерела: роль застосування мусить мати `USAGE` на схемі таблиці й `SELECT` на **кожній** таблиці-джерелі й таблиці ролей джерела призначень (Р2d1-17; `has_schema_privilege`, `has_table_privilege`; таблиці шукаються за іменем у `pg_namespace`/`pg_class`, не `to_regclass`, тож схема без `USAGE` — відмова, а не сира `42501`; відхилення при виконанні, погоджено архітектором: вплив на спеку: немає); інакше функції прав `SECURITY DEFINER` гучно падали б на кожному виклику); якщо на таблиці увімкнено RLS (`relrowsecurity`), роль застосування (`current_user` читальної транзакції — та сама, що `artifact.role` і власник згенерованих функцій) мусить мати права власника — `pg_has_role(current_user, relowner, 'USAGE')` (Postgres пропускає RLS для ролі з привілеями власника, зокрема успадкованими) — або `rolbypassrls` чи `rolsuper`; інакше відмова `plan.rights-source-access` з `{ tables: string }` (імена через кому, ліміт 20, як `OWNER_LIMIT`) і порадою передати власність кроком із дозволом. Таблиця без RLS — без вимоги | `SECURITY DEFINER` іде від власника функції; RLS обходить лише власник таблиці (без `FORCE`) чи роль з `BYPASSRLS`/суперкористувач — `BYPASSRLS` власника таблиці функції, якою володіє інша роль, нічого не дає | спека прав §4.7 — уточнення «власник таблиці-джерела — роль, від якої виконуються функції прав, або ця роль має `BYPASSRLS`» (Задача 0) |
| Р2d1-11 | Невідомі ключі ролей: план читає `DISTINCT` ключі активних рядків кожного джерела призначень (під `row_security = off`) — колонку `role`, а для ролі через посилання — `sr.<key>` того самого з'єднання з таблицею ролей, з умовами `where` джерела й ролі (Р2d1-17, Р2d1-18) і попереджає `plan.rights-source-unknown-keys` `{ source, keys: string, more: number }` (`keys` — через кому) — ключі, яких немає в `sourceKeys` цього джерела, щонайбільше 20 на джерело, решта — кількістю. Дані таблиці, для якої Р2d1-10 відмовив, не читаються (ключі джерела не читаються й тоді, коли відмовлено його таблиці ролей: з'єднання `sr` впало б `42501`); так само — джерела, на цілі якого ще немає таблиці ролей чи будь-якої колонки, яку читає запит ключів (`role`, `active`, колонок `where`, `key` і ключа таблиці ролей; перевірка `pg_attribute`; колонку додасть DDL цього плану — читати нічого). Два джерела над однією таблицею, чиї `where` не розділяють рядків, бачать ключі одне одного невідомими — відоме обмеження; скіл радить окремі таблиці | §4.7: «план читає ці дані цілі й попереджає з переліком»; права з таких рядків і так не діють (Р2d1-4) | немає |
| Р2d1-12 | `FORCE ROW LEVEL SECURITY` таблиці-джерела план окремо не перевіряє: це вже помилка компілятора `rights.source-forced-rls` (`compiler/rights/checks.ts`), а гейт дрейфу тримає метадані рівними цілі | факт коду; друга перевірка — дубль | немає |
| Р2d1-13 | Модуль `schema/apply/rights-sources.ts`: `readRightsSourceFacts(tx, sources)` — одна читальна транзакція `dbs.reader` після 2а (`checkOwnerMembership`) і до тіні, один раз до розгалуження промоції (тож діє в обох гілках); таблиця, якої немає на цілі (немає рядка в `pg_namespace`/`pg_class`, див. Р2d1-10), пропускається. Імена — бажані: таблиця-джерело промоцією не перейменовується (промотована в вид таблиця — `rights.source-table`). Модуль розширить 2c2 (перевірки Рх20) | один читач даних цілі для прав; перевірки — до дорогих кроків | немає |
| Р2d1-14 | Версії прав, журнал і запобіжники §7 на прийнятих джерелах не діють (платформа на них нічого не ставить, §4.7); рядок у «Відомих обмеженнях» | рішення архітектора (Ф4) | немає |
| Р2d1-15 | Умова рядків джерела `where` (архітектор, доповнення 2d1, (a)): необов'язкове поле **обох** видів джерел, масив кон'юнктів `{ column, equals: <літерал> }` або `{ column, isNull: true \| false }` (`.default([])`). Колонка — логічне ім'я колонки таблиці-джерела (стадія 2 резолвить її з роллю `source.column` на вказівнику `/…/where/<j>/column`; невідома — `customTable.column-unknown`). Тип колонки для `equals` — `Text`/`String`, `Boolean`, `UUID` (зокрема `Raw` з `pgType` uuid, як `isUuidColumn`), `SmallInt`/`Integer`/`BigInt`, у кожному разі не масив (`array !== true`, як `SOURCE_COLUMN_TYPES`); літерал — рядок, `true`/`false`, uuid-рядок у канонічній формі з дефісами (`UUID_TEXT`, `model/schemas/value-type.ts`), ціле (`Number.isSafeInteger`) відповідно. Невідповідність — помилка `rights.source-where` `{ source, column, reason: "type" \| "literal" }` на `/…/where/<j>`. SQL — кон'юнкти `<alias>.<col> = <літерал>` (`Text` — `sqlLiteral`, `UUID` — `uuidLiteral`, `Boolean` — `TRUE`/`FALSE`, цілі — число) чи `IS [NOT] NULL` у гілці джерела в `rights_my_scopes`, `rights_visible_users`, `assignments` (`rights_mine`) і в читанні ключів плану (Р2d1-11); один експортований помічник `sourceConditions(alias, conditions): string[]` (`compiler/rights/functions.ts`) | рядок джерела, що не належить джерелу (інший рівень поліморфної таблиці, R1'), інакше читався б як призначення; умова лише звужує, а `NULL = <літерал>` рядка не дає (fail-closed). Цілі — вся родина цілих типів (архітектор назвав `Integer`; `SmallInt`/`BigInt` так само порівнюються з числом) | спека прав §4.7 (Задача 3a, крок 1) |
| Р2d1-16 | Колонка скоупу рядка в джерелі призначень (архітектор, (s)): `columns.scope` — лише рівень скоупу; не задано, а таблиця оголошує `scopeColumn` — береться вона; скоуп з учасника (законна форма) — лише явним `columns.scope: null`, пропуск без `scopeColumn` — помилка (Р2d1-19). SQL: `AND s.scope = src.<scope>` у з'єднанні з `my_scopes`. Перевірки — код `rights.source-scope-column` (той самий, що в джерела членства) з новою причиною `"level"` (`columns.scope` не на рівні скоупу, вказівник `/…/columns/scope`), а наявні причини для джерела призначень діють лише так: `"scope"` — таблиця скоуплена (`scopeKindOf` ≠ `undefined`) і її вид ≠ виду рівня (вказівник `/…/table`); `"column"` — таблиця оголошує `scopeColumn`, і він ≠ `columns.scope`. Нескоуплена таблиця без `scopeColumn` з `columns.scope` — законна (поліморфна таблиця). Помічник `checkSourceScope` джерела членства (він вимагає скоупленої таблиці й рівності зі `scopeColumn`) для джерела призначень без змін не підходить — окрема перевірка; тип — `UUID` (`rights.source-column-type`). Контракт: `AssignmentSourceContract.scope?: string` (фізична колонка; є лише на рівні скоупу) | правило §4.7: скоуп призначення рівня скоупу — скоуп учасника; власна колонка скоупу рядка, якщо є, мусить із ним збігатися — інакше адмін тенанта A вписує учасника B зі скоупом A, і рядок діє в B (R1). Контейнерний рівень не потребує колонки: `held` вимагає, щоб контейнер лежав у скоупі учасника (`k.scope IS NOT DISTINCT FROM t.scope`, де `t.scope` — скоуп з `my_scopes` учасника), тож рядок «учасник B, контейнер тенанта A» не проходить | спека прав §4.7 (Задача 3a, крок 1) |
| Р2d1-17 | Роль через посилання (архітектор, (b)): `columns.role` — назва колонки ключа (як зараз) **або** `{ column, references: <MetadataRef на CustomTable>, key, where? }`. `column` — колонка таблиці-джерела типу `UUID`; ціль `references` (роль посилання `source.roleTable`, вказівник `/…/columns/role/references`) — `CustomTable` з одноколонковим uuid-ключем (`singleUuidKeyColumn`), інакше `rights.source-table` (не прийнята таблиця) чи нова помилка `rights.source-role-key` `{ source, table }`; `FORCE ROW LEVEL SECURITY` на ній — `rights.source-forced-rls`; `key` — колонка цілі `Text`/`String` (`rights.source-column-type` на `/…/columns/role/key`); `where` — форма Р2d1-15 над колонками цілі (`/…/columns/role/where/<j>`). SQL: `JOIN <roles> sr ON sr.<pk> = src.<column> [AND <where sr>] JOIN rights_source_keys() k ON k.source_id = <id> AND k.key = sr.<key>`. Контракт: `AssignmentSourceContract.role` — фізична колонка таблиці-джерела (ключ чи посилання), нове `roleTable?: { table: QualifiedName; id: string; key: string; where: SourceConditionContract[] }`. Таблиця ролей підлягає Р2d1-10 (власник, RLS) і читається в Р2d1-11 тим самим з'єднанням. Псевдонім — `sr`, не `r`: у `typed` того самого тіла `r` — `rights_roles()` | системну роль споживач впізнає за ключем серед рядків без тенанта; кастомна роль тенанта може мати той самий ключ (R2) — її відсікає `where` ролі. Відхилено архітектором: uuid-ключі в `sourceKeys` (метадані залежали б від id рядків оточення) і згенеровані колонки споживача (R1 не закривають, безпека трималася б на обмеженні, якого компілятор не бачить) | спека прав §4.7 (Задача 3a, крок 1) |
| Р2d1-19 | Забута умова — помилка компілятора, не «мусить» (архітектор, розвилка Codex; ознаки «поліморфна таблиця» немає). (1) R1: `columns.scope` джерела призначень рівня скоупу — назва колонки **або** `null` (явно: «скоуп з учасника»; лише на таблиці без `scopeColumn` — на таблиці з ним `null` дає причину `"column"`); пропустити поле можна лише, коли таблиця оголошує `scopeColumn` (береться він, Р2d1-16); інакше `rights.source-scope-column` з причиною `"missing"` на `/assignmentSources/<i>/columns`. Zod: `.nullable().optional()` з описом трьох станів; на рівнях, крім скоупу, поле відсутнє (і `null` — причина `"level"`); контракт `scope?: string` (`null` → немає). (2) R1': одна прийнята таблиця (за id об'єкта цілі) за двома й більше джерелами призначень — `where` кожної пари джерел мусять бути **доведено несумісні** (архітектор, посилення п. 2): знайдеться колонка, де обидва мають `equals` з різними літералами, або `equals` проти `isNull: true`, або `isNull: true` проти `isNull: false`. Літерали порівнюються як значення колонки: uuid — без урахування регістру (Postgres їх ототожнює; форма літерала канонічна, Р2d1-15), текст — точно, ціле й логічне — за значенням; різні літерали на колонці `Text`/`String` з власною `collation` несумісності **не** доводять (недетермінована колація може ототожнити `'org'` і `'ORG'` — fail-closed, як `collation` у п. 3), а `equals` проти `isNull: true` і `isNull` проти `isNull` на ній діють. Порожній `where` несумісності не доводить. Інакше `rights.source-where` з причиною `"shared"` на `/assignmentSources/<i>/table` **обох** джерел пари. Несумісність через різні колонки компілятор не доводить — автор переписує її однією колонкою-дискримінатором (параметри `{ source, reason }`, `column` — лише для `"type"`/`"literal"`). (3) R2: роль через посилання без `where` ролі дозволена, лише коли в таблиці ролей колонка `key` унікальна сама: обмеження `uniques` (не відкладене) з колонками рівно `[key]` чи унікальний індекс (`indexes[].unique`) з одним ключем-колонкою `key` **без** `where` (первинний ключ не розглядається: ключ таблиці ролей — uuid, Р2d1-17; `order`, `nulls`, `include` і `nullsNotDistinct` унікальності не змінюють і не впливають; ключ з `opclass` чи `collation` не рахується — fail-closed, бо інший клас операторів чи колація може розрізняти рядки, які `=` у з'єднанні ототожнює); інакше `rights.source-role-key` з причиною `"ambiguous"` на `/assignmentSources/<i>/columns/role`. Частковий унікальний індекс не рахується: він і пускає кастомну роль із системним ключем. Предикат часткового індексу в метаданих є (`indexSchema.where`), і зворотний генератор його переносить (`schema/reverse/tables.ts`, факт коду), а гейт дрейфу тримає метадані рівними цілі. `rights.source-role-key` отримує параметр `reason: "primaryKey" \| "ambiguous"` (`"primaryKey"` — таблиця ролей без одноколонкового uuid-ключа, Р2d1-17) | забута умова інакше — тихий fail-open; кожен із трьох ризиків компілятор ловить точно, без нової форми. (2) відкидає лише несумісність, яку не можна довести однією колонкою; сумісні умови (однаковий літерал, `equals` проти `isNull: false`, умови на різних колонках) читають рядки одне одного, тож R1' лишався б | спека прав §4.7 (Задача 3a, крок 1) |
| Р2d1-18 | Рядки, які відсікає `where` джерела чи ролі, — не призначення джерела: план про їхні ключі не попереджає (Р2d1-11 читає ключі тим самим з'єднанням і умовами, що функції прав) | `where` — оголошення споживача, що ці рядки (інший рівень, кастомні ролі) не належать джерелу; попередження про них було б шумом на кожному плані. Посилання на кастомну роль, яку `where` відсікає, план тому не називає — це свідомо звужує речення §4.7 «план … попереджає з переліком» | спека прав §4.7 (Задача 3a, крок 1) |

## Відомі обмеження

- Запобіжники §7, версії прав і журнал на прийнятих джерелах не діють:
  платформа таблиці-джерела лише читає (§4.7, Р2d1-14). Зміна прийнятого
  членства чи призначення не підвищує версії прав (план 2c2) — клієнтський
  кеш прав для такого скоупу не інвалідовується сигналом.
- Гілку `rolsuper` у перевірці власника живим тестом не доведено (на спільному стеку суперкористувача тест створити не може); помилка fail-closed — гучна відмова.
- Умова `where` порівнює літерал з колонкою цілі ще до гейта дрейфу: якщо план змінює тип цієї колонки, читання ключів може впасти сирою помилкою приведення.
- Без «Користувачів» немає недійсності користувача: видалений обліковий запис
  з чинним токеном лишається поточним користувачем до спливання токена.
- Кастомні ролі з прийнятого джерела (мапінг ресурсів і дій споживача) — після
  промоції таблиць прав (§4.7), не адаптером.
- Перейменування таблиці-джерела промоцією: мапінг змінюється тим самим
  кроком (логічне посилання), але промоція самої таблиці-джерела у вид дає
  `rights.source-table` — джерело мусить стати довідником членства.
- Ціну гілок джерел у `rights_mine` міряє гейт планів і бенчмарк 2d2.
- Два джерела призначень над однією таблицею, чиї `where` не розділяють
  рядків, бачать ключі одне одного невідомими (попередження плану); скіл
  радить окремі таблиці чи дискримінатор `where`.
- Видалення застосунком рядка прийнятого членства, на який посилається
  призначення Simetra, відмовляє FK (Р2d1-5).
- Одне джерело над поліморфною таблицею без `where` рівня (R1' без другого
  джерела) читає рядки чужого рівня: компілятор ловить це лише для таблиці
  під двома джерелами (Р2d1-19, п. 2: умови пари мусять бути несумісні). Скоуп тримає п. 1 (`columns.scope`
  явний), а від рядка чужого рівня захищає лише зіставлення рівня ролі
  (`typed`): ключ ролі іншого рівня в цьому джерелі не діє. Скіл радить
  дискримінатор і для одного джерела.
- Контейнером може бути лише `Catalog` з `rightsContainer`: прийнятий
  контейнер споживач спершу промотує — це його міграція, не адаптер.
- Членство в контейнері без ролі покривають гранти в архетипах контейнера;
  окремої форми джерела для нього немає.
- Обмеження токена claim-ом скоупу (act-as) — механізм act-as, П4.

## Review Focus

1. **Учасник іншого виду чи тенанта з підлаштованим id:** рядок джерела призначень з `member` = id учасника іншого виду скоупу (чи учасника, що не є моїм) не вмикає ролі. Тест — Задача 5 (`source-cross-kind`, `source-not-mine`).
2. **Неактивний рядок і `NULL`:** `is_active = false`, `is_active IS NULL`, `user_id IS NULL` у членстві й `NULL` у колонці ролі чи учасника призначення — прав немає, без помилки. Тест — Задача 5 (`source-inactive`).
3. **Ключ ролі не того рівня чи невідомий:** ключ глобальної ролі в контейнерному джерелі не вмикає її; невідомий ключ — прав немає, план попереджає. Тест — Задача 2 (unit), Задача 5 (`source-wrong-level`, `source-unknown-key` — поведінкові), Задача 4.
4. **`sub` не uuid без «Користувачів»:** `current_user_id()` — `NULL` без помилки приведення, функції прав — порожні множини. Тест — Задача 5 (`no-users-subject`).
5. **Межа «Користувачів» із прийнятим членством:** учасник одного тенанта не бачить користувачів учасників іншого. Тест — Задача 5 (`source-visible-users`).
6. **Контейнерне джерело над поліморфною таблицею без `where`:** рядок рівня скоупу (`scope_id` = id тенанта) контейнерне джерело читає як контейнер з тим самим id. `held` вимагає, щоб контейнер лежав у скоупі учасника, тож чужого тенанта рядок не відкриває; але id контейнера генерує клієнт, і контейнер з id тенанта A, створений у B, разом із рядком, вписаним адміном A, дав би учаснику B роль на контейнері B. Закриває лише дискримінатор `where` контейнерного джерела; коли над таблицею стоїть і джерело рівня скоупу, його вимагає компілятор (Р2d1-19, п. 2; DB-кейс `poly-container-collision`), одне контейнерне джерело над такою таблицею — відоме обмеження, а аналог R1 для контейнера (учасник B, контейнер A) тримає `held`. Тест — Задача 5 (`source-not-mine`, твердження про u3, читання `rights_mine()` напряму, і нова мутація: прибрати `k.scope IS NOT DISTINCT FROM t.scope` у `held`).
7. **Скоуп рядка проти скоупу учасника:** рядок рівня скоупу з учасником тенанта B і `scope_id` = A прав ні в A, ні в B не дає (R1); скоуп з учасника — лише явним `columns.scope: null` (Р2d1-19). Тест — Задача 5 (`poly-scope-mismatch`), Задача 3a (unit на автоматичний `scopeColumn`).

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/model/schemas/project.ts` | `IdentitySource.subjectIsUserId` |
| `packages/simetra/src/compiler/contracts.ts`, `compiler/rights/contracts.ts` | `MembershipSourceContract.member` |
| `packages/simetra/src/compiler/rights/checks.ts` | `rights.source-member-key`, `rights.source-member-unique`, `rights.source-column-type` |
| `packages/simetra/src/compiler/rights/system-catalogs.ts` | `rights.adopted-source-writes`; зняття пропуску для виду з членством із джерела |
| `packages/simetra/src/compiler/stages/model.ts` | ціль `member` — таблиця-джерело членства |
| `packages/simetra/src/compiler/rights/functions.ts` | гілки джерел, `rights_source_keys`, `hasSessionUser` |
| `packages/simetra/src/compiler/platform/units.ts` | шар сесії без «Користувачів» |
| `packages/simetra/src/compiler/{access-units,pipeline,diagnostics,messages}.ts`, `rights/command-units.ts`, `rights/effects-units.ts` | новий предикат, коди |
| `packages/simetra/src/schema/apply/rights-sources.ts` (новий), `plan.ts` | перевірки плану над даними цілі |
| `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` | шар `adoptedSources()` |
| `packages/simetra/test/db/rights-sources.db.test.ts` (новий) | DB-сценарій джерел |
| `packages/simetra/src/model/schemas/rights.ts`, `model/kinds/standard.ts`, `compiler/stages/identity.ts`, `compiler/rights/{checks,contracts,functions}.ts`, `compiler/contracts.ts`, `packages/simetra/schemas/project.schema.json` | `where`, `columns.scope`, роль через посилання (Задача 3a) |
| `packages/designer/skills/simetra-metadata/references/people-and-rights.md` | прийняті джерела |
| `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` | зняти рядок «Межа Користувачів … (Права-2d)» |

Шар фікстури `adoptedSources(): Layer` (`fixtures/rights.ts`, поверх
`policyDomain()` і `adoptedMembership()`; колонки `Membership.userId`, `Membership.isActive`, `RoleGrant.memberId`, `RoleGrant.roleKey` і їхні відповідники в `GlobalGrant` — `notNull: false`: помічник `column()` за замовчуванням ставить `NOT NULL`, а fail-closed гілки `IS NOT NULL`/`IS TRUE` треба довести на рядках з `NULL`): джерело членства `membersSource()`
над `Membership`; джерело призначень `grantsSource()` (контейнерний рівень
`Project`, `RoleGrant.memberId` — учасник `Membership`) і
`globalGrantsSource({ table: ref("CustomTable", "GlobalGrant") })` — будівник отримує параметр `overrides` (як `grantsSource`), його типова таблиця лишається `RoleGrant` для наявних викликів; нова таблиця `GlobalGrant` — будівник `globalGrantTable()` (як `grantTable()`, без `projectId`; учасник — id користувача); `sourceKeys`:
`ProjectLead` — `{ source: "grants", key: "lead" }` і грант `read@any` на `Task` (у `rolesAndSets()` грантів у неї немає), `Support` —
`{ source: "globalGrants", key: "support" }` і грант `read@any` на `Announcement`; системні довідники `org`
лишаються (рівень скоупу не покритий джерелом), їхній `subject` посилається
на `Membership`; глобальні системні довідники (`GLOBAL_ROLES_FILE`,
`GLOBAL_ASSIGNMENTS_FILE`) шар прибирає: єдину глобальну роль `Support` покриває
`globalGrants`, інакше `rights.system-catalog-parallel`. Другий вид скоупу для
кейсу між видами — шар `adoptedCrossKind()`: оголошує обидва види скоупу
(`org` з `setFunction: public.org_ids` і `team` як у `secondScopeKind()`) одним
значенням `scopeKinds` і бере решту файлів `secondScopeKind()` (корінь `Team`, довідник членства `TeamMember` тощо — усе, крім `PROJECT_FILE`), бо `withRoles` зливає файли поверхнево і
`secondScopeKind()` повернув би `org` форму `membership`. Експорти `ADOPTED_LEAD_KEY`, `ADOPTED_SUPPORT_KEY`, `adoptedSourcesDomain(...layers: Layer[]): Map<string, string>`. Шар
`withoutUsers(): Layer` — прибирає «Користувачі» й усе, що на них посилається
(власність `["ref"]`, ТЧ `devices`, `trackAuthor: false` на `Task`, «Користувачі» з грантів
`TaskReaders` і `Everyone`), лишає джерела. Шар `adoptedSources()` сам кладе SQL-файл функції множини `org_ids` і прибирає вимір `region` (форма — Задача 5): `adoptedMembership()` оголошує `setFunction: public.org_ids`, але SQL не дає, а зв'язок виміру `MemberRegion` прибирає — без цього модель не компілюється чи не розгортається. Шар `policyDomain` зливає лише JSON, тож SQL-файл кладе будівник `policyDomain`-подібно (`files.set`) — у функції-обгортці `adoptedSourcesDomain(...layers)` поруч із `policyDomain`.

---

### Задача 0: правки спек і боргу

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§4.7), `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` (§7), `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` (§5)

- [ ] **Step 1:** Спека прав §4.7, перший пункт («членства»): після «необов'язково колонка активності» — «учасник — одноколонковий uuid-ключ таблиці-джерела; системні довідники прав такого виду посилаються на неї складеним FK, тож таблиця мусить мати `UNIQUE (scope, id)` у своїх метаданих» (Р2d1-2, Р2d1-5). Абзац «Межа відповідальності»: речення «Власник таблиці-джерела має бути власником згенерованих функцій прав (мігратор) або роль з `BYPASSRLS`» → «Таблицею-джерелом з увімкненим RLS має володіти роль, від якої виконуються функції прав (роль застосування), або ця роль має `BYPASSRLS`» (Р2d1-10). Там само: речення «Перейменування чи промоція таблиці-джерела змінює мапінг тим самим кроком» → «Таблиця-джерело лишається `CustomTable`: промотувати її у вид, поки вона джерело, не можна (`rights.source-table`); видалення застосунком учасника, на якого посилається призначення Simetra, відмовляє FK» (Р2d1-5, Р2d1-13).
- [ ] **Step 2:** Спека системної схеми §7, після першого пункту: «Без довідника «Користувачі» (права лише з прийнятим джерелом членства, [спека прав](2026-10-17-rights-design.md) §4.6) функція повертає `sub` як uuid на провайдері, де id користувача — `sub` (С8), і `NULL` для `sub`, що не є uuid; недійсності користувача тоді немає, а анонімна сесія провайдера дає `NULL`» (Р2d1-6).
- [ ] **Step 3:** Борг §5 — видалити пункт «Межа «Користувачів» при членстві лише з прийнятого джерела (Права-2d)».
- [ ] **Step 4:** Run: `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md
git commit -m "docs(spec): прийняті джерела прав — учасник, власник таблиці, поточний користувач без «Користувачів»"
```

---

### Задача 1: модель джерел — учасник, ціль `member`, діагностики

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts`, `compiler/contracts.ts`, `compiler/rights/contracts.ts`, `compiler/rights/checks.ts`, `compiler/rights/system-catalogs.ts`, `compiler/stages/model.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Modify: `standardRefTargets` і всі його виклики — `compiler/stages/model.ts`, `compiler/codegen.ts` (`emitEntityTypes`), `compiler/operations/promote/kind-file.ts`, `compiler/operations/promote/sql.ts`: сигнатура приймає проєкт (джерела членства), щоб типи й цілі промоції бачили ту саму ціль `subject`, що стадія 3
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` (шари `adoptedSources`, `withoutUsers`), `fixtures/kitchen-sink.ts` (якщо знятий пропуск Р2d1-5 вимагає довідників — додати їх у фікстуру, не виняток ратчета)
- Modify: `packages/simetra/test/db/rights-functions.db.test.ts` (`singleTenantModel` чекає `rights.adopted-source-unsupported` — замінити на `rights.adopted-source-writes` у тому самому коміті: `pnpm test` DB-тестів не запускає, а `test:db` інакше почервонів би)
- Test: `packages/simetra/src/compiler/__tests__/rights-sources.test.ts`, `rights-catalogs.test.ts`, `rights-roles.test.ts`, `codegen.test.ts`, `messages.test.ts`; наявні тести, що чекають пропуску для виду з членством із джерела (`access-units.test.ts` «no rights read policies where there are no rights functions», `rights-functions.test.ts` «renders no rights functions without users…»), — оновити в тому самому коміті під Р2d1-5/Р2d1-7

**Interfaces:**
- Produces: `IdentitySource.subjectIsUserId: boolean` (Supabase — `true`); `MembershipSourceContract.member: string` (фізична колонка ключа); коди `rights.source-member-key` (`{ source, table }`), `rights.source-member-unique` (`{ source, table }`), `rights.source-column-type` (`{ source, column, expected }`), `rights.adopted-source-writes` (`{ source }`, попередження); код `rights.adopted-source-unsupported` видалено.

- [ ] **Step 1: Write the failing tests (unit)**, `it.each` однією таблицею над `adoptedSourcesDomain()` з перевизначеннями:
  - `"composite key"` — `Membership.primaryKey.columns = ["orgId", "id"]` → `rights.source-member-key` на `/membershipSources/0/table`;
  - `"text key"` — тип ключа `Text` → `rights.source-member-key`;
  - `"no unique for subject"` — без `uniques: [{ columns: ["orgId", "id"] }]` → `rights.source-member-unique` (лише коли вид має системні довідники);
  - `"member text"` — колонка `memberId` джерела призначень типу `Text` → `rights.source-column-type` (`expected: "UUID"`); `"active text"` — `isActive` типу `Text` → `rights.source-column-type` (`expected: "Boolean"`) (Р2d1-2a);
  - (рядки з помилками перевіряють наявність цільового коду на його вказівнику, а не точний перелік: зламаний ключ таблиці дає й супутні діагностики на `Task.assignee`)
  - `"clean"` — помилок немає; попередження — рівно `rights.adopted-source-writes` на кожне джерело (`expectClean(result, { allow: ["rights.adopted-source-writes"] })` і точний перелік вказівників).
  - `rights-catalogs.test.ts`: тест 2a1 на `rights.system-catalog-scope` для виду з членством із джерела **перевертається** — фізичний знімок: FK `subject` довідника призначень `org` — складений `(org_id, subject) → membership (org_id, id)`; вид без членства — `rights.system-catalog-scope` лишається; вид з членством із джерела, ролями рівня скоупу й без довідників — `rights.system-catalog-missing`.
  - `messages.test.ts` — нові коди, без `rights.adopted-source-unsupported`.
  - ~~`codegen.test.ts` — тип `subject` довідника призначень `org` у згенерованих типах посилається на `Membership`.~~ (відхилення при виконанні, погоджено архітектором: тест скасовано — `emitEntityTypes` типізує одноцільове стандартне посилання як `string`, тож такий тест нічого б не стверджував; вплив на спеку: немає)
- [ ] **Step 2:** Run: `pnpm --filter simetra test rights-sources rights-catalogs messages codegen` — FAIL.
- [ ] **Step 3: Implement** за Р2d1-2, Р2d1-5, Р2d1-9: факт T0; `member` у `sourceContracts`; перевірки в `checks.ts` поруч із `rights.source-forced-rls`; `standardTargetRefs` бере ціль `member` з мапи, що включає джерела членства (`targets.membership` будується з довідників і джерел — одним місцем); у `checkSystemCatalogs` прибрати `continue` для `membershipOfScopeKind(…) === "source"`, умову `rights.system-catalog-scope` змінити з `!== "catalog"` на `=== undefined` і замінити попередження. Коментарі «чому» — Р2d1-5 (сценарій змішування).
- [ ] **Step 4:** Run: `pnpm --filter simetra test rights access field-ratchet kitchen messages json-schema codegen && pnpm --filter simetra typecheck` — PASS (JSON Schema — `UPDATE_JSON_SCHEMAS=1`, лише якщо змінилася схема).
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src packages/simetra/test/db/rights-functions.db.test.ts
git commit -m "feat(compiler): учасник прийнятого джерела членства й ціль суб'єкта системних довідників"
# у цей коміт — і packages/simetra/test/db/rights-functions.db.test.ts
```

---

### Задача 2: функції прав читають джерела

**Files:**
- Modify: `packages/simetra/src/compiler/rights/functions.ts`, `compiler/access-units.ts`, `compiler/rights/command-units.ts`, `compiler/rights/effects-units.ts`
- Test: `packages/simetra/src/compiler/__tests__/rights-functions.test.ts`

**Interfaces:**
- Consumes: `MembershipSourceContract.member` (Задача 1); `Contracts.membershipSources`, `Contracts.assignmentSources`.
- Produces: `RIGHTS_FUNCTIONS.sourceKeys` (`simetra.rights_source_keys`; без жодного `sourceKeys` — порожня множина `emptySet`, не порожній `VALUES`); `RightsFunctionContracts` додає `"membershipSources"`; `hasSessionUser(contracts: Pick<Contracts, "users" | "membershipSources">, provider: DatabaseProvider): boolean`; `hasRightsFunctions(contracts, provider)` і `hasVisibleUsers(contracts, provider)` — нові сигнатури (усі споживачі передають провайдера).

- [ ] **Step 1: Write the failing tests (unit, дерева розбору без позицій):**
  - `it("my scopes include an adopted membership source, active rows only")` — тіло `rights_my_scopes` над `adoptedSourcesDomain()` має гілку `FROM public.membership s WHERE s.user_id IS NOT NULL AND s.user_id = (SELECT simetra.current_user_id()) AND s.is_active IS TRUE` з видом `org` і `member` = `s.id`; джерело без колонки активності — без умови `IS TRUE`.
  - `it("source keys are a data function of the role keys")` — `rights_source_keys` — `IMMUTABLE`, без `SECURITY DEFINER`, без `GRANT EXECUTE`; рядки `VALUES` — рівно (`GRANTS_SOURCE_ID`, `lead`, `PROJECT_LEAD_ID`) і (`GLOBAL_GRANTS_SOURCE_ID`, `support`, `SUPPORT_ID`).
  - `it("an assignment source joins the key and is typed by kind")` — гілка `assignments` контейнерного джерела: внутрішнє з'єднання з `rights_source_keys()` за (`source_id`, `role_key`), з `my_scopes` за (`scope_kind_id` = `org`, `member` = `member_id`), `container` = `project_id`; глобального — `member_id = (SELECT simetra.current_user_id())`, `scope` і `container` — `NULL`; контейнерне джерело з нескоупленим контейнером (`singleTenantRights` з `grantsSource()` і `grantTable()`: `Project` має `scope: "none"`) — `member = (SELECT simetra.current_user_id())`, `scope` і `scope_kind_id` — `NULL`, `container` — колонка джерела.
  - `it("held compares the container kind with the row scope kind, not the storage")` — у `held` умова `k.scope_kind_id IS NOT DISTINCT FROM t.scope_kind_id`; рядок довідника несе `scope_kind_id` = свій `storage_id`. Мутація: повернути порівняння з `t.storage_id` — DB-кейс `source-container` червоніє (рядок джерела не проходить `held`).
  - `it("a source row passes only for a role of the source level")` — умова `typed` для `storage = 'source'` порівнює (`level`, `level_id`) з `rights_roles()` зі сталою рівня джерела. Мутація: прибрати порівняння рівня — тест червоніє (лише unit: на даних його тримає з'єднання за `source_id`).
  - `it("visible users include an adopted membership")` — `rights_visible_users` має гілку джерела з `JOIN simetra.rights_my_scopes()` за (`scope_kind_id`, скоуп) і умовою активності.
  - `it.each` предикатів: (ролі, «Користувачі», довідник членства) → функції прав і межа «Користувачів» є; (ролі, джерело членства, без «Користувачів») → функції прав є, `rights_visible_users` немає; (ролі, без «Користувачів», без джерела) → функцій немає. Мутація: `hasRightsFunctions` без умови сесії — третій рядок червоніє.
- [ ] **Step 2:** Run: `pnpm --filter simetra test rights-functions` — FAIL.
- [ ] **Step 3: Implement** за Р2d1-3, Р2d1-4, Р2d1-7, Р2d1-8; нові колонки `assignments`/`typed` (`scope_kind_id`, `source_level`, `source_level_id`) — у переліку колонок CTE, гілки довідників дають їм свої значення. Споживачі `hasRightsFunctions`/`hasVisibleUsers` передають `project.database.provider`. Коментарі «чому» — Р2d1-4 (рівень зберігання `NULL`, рівень — стала генератора).
- [ ] **Step 4:** Run: `pnpm --filter simetra test rights access && pnpm --filter simetra typecheck` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): функції прав читають прийняті джерела членства й призначень"
```

---

### Задача 3: поточний користувач без «Користувачів»

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts` (`IdentitySource.anonymousClaim`), `packages/simetra/src/compiler/platform/units.ts`, `compiler/pipeline.ts`; `packages/simetra/src/schema/apply/state.ts` (`renderApplyState`) — лише читання: він уже дає `platformSchemaGrants` без «Користувачів», шар їх не повторює
- Test: `packages/simetra/src/compiler/__tests__/platform-layer.test.ts`; тест «`GRANT USAGE ON SCHEMA simetra` рівно один раз» живе в `packages/simetra/src/schema/apply/__tests__/state.test.ts` (відхилення при виконанні, погоджено архітектором: зона шарів забороняє тестам компілятора імпортувати `simetra/schema`; вплив на спеку: немає)

**Interfaces:**
- Consumes: `hasSessionUser` (Задача 2), `IdentitySource.subjectIsUserId` (Задача 1).
- Produces: `buildPlatformUnits` повертає для проєкту без «Користувачів» з `hasSessionUser` — функцію `simetra.current_user_id()` за Р2d1-6 і її `EXECUTE` (гранти схеми — від `renderApplyState`); генератор — `"platformLayer"`.

- [ ] **Step 1: Write the failing tests (unit):**
  - `it("without users the session user is the subject as uuid")` — над `adoptedSourcesDomain(withoutUsers())`: рівно одна функція `simetra.current_user_id()` (plpgsql, `STABLE`, `SECURITY DEFINER`, `SET search_path = ''`), дерево тіла містить regex-перевірку й приведення `::uuid`; `GRANT EXECUTE` — ролям `SESSION_ROLES`; `GRANT USAGE ON SCHEMA simetra` — рівно раз у всьому бажаному SQL (`renderApplyState` разом з одиницями моделі).
  - `it("an anonymous session is not a user")` — тіло повертає `NULL`, коли `claims ->> 'is_anonymous' = 'true'` (DB-кейс `no-users-subject`).
  - `it("without users and without a membership source there is no session user")` — шар порожній, функцій прав немає.
- [ ] **Step 2:** Run: `pnpm --filter simetra test platform-layer` — FAIL.
- [ ] **Step 3: Implement** — окрема функція `subjectUserFunction()` поруч із `currentUserFunction`; вибір у `buildPlatformUnits` за `users` і `hasSessionUser`. Коментар «чому» — С8, regex замість приведення (стороння `sub` не валить запит).
- [ ] **Step 4:** Run: `pnpm --filter simetra test platform-layer rights render && pnpm --filter simetra typecheck` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): поточний користувач із sub без довідника «Користувачі»"
```

---

### Задача 3a: умови рядків джерела, скоуп рядка й роль через посилання

Доповнення архітектора після Задач 0–2 (Р2d1-15…Р2d1-19). Задачі 4–5 спираються на цю задачу: виконувати її перед ними.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§4.7)
- Modify: `packages/simetra/src/model/schemas/rights.ts` (`sourceConditionSchema`; `where` в `membershipSourceSchema` і `assignmentSourceSchema`; `columns.scope` і об'єднана форма `columns.role` джерела призначень), `packages/simetra/schemas/project.schema.json` (`UPDATE_JSON_SCHEMAS=1`)
- Modify: `packages/simetra/src/model/kinds/standard.ts` (роль посилання `"source.roleTable"`), `compiler/stages/identity.ts` (реєстрація колонок `where`, `columns.scope`, цілі й колонок ролі через посилання)
- Modify: `compiler/contracts.ts` (`SourceConditionContract`, нові поля контрактів), `compiler/rights/contracts.ts` (`sourceContracts`), `compiler/canonical.ts` (лише якщо канонічна форма перелічує поля контрактів джерел явно)
- Modify: `compiler/rights/checks.ts` (`checkSources`), `compiler/rights/functions.ts` (`sourceConditions`, гілки джерел), `compiler/diagnostics.ts`, `compiler/messages.ts` (нові коди; тексти `rights.source-scope-column` узагальнити з «джерела членства» на «джерела» і додати причину `"level"`)
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` (шар `polymorphicGrants()`), `fixtures/kitchen-sink.ts` (Р2d1-19: три джерела `globalGrants`, `orgGrants`, `partnerGrants` стоять над однією `RoleGrant` без `where`, а `orgGrants` — рівня скоупу без колонки скоупу; таблиця отримує колонку-дискримінатор `level` (Text), кожне джерело — `where` за нею, `orgGrants` — `columns.scope: null`), і кожне інше оголошення джерел, яке нові помилки зачіпають (`grep -rn "assignmentSources\|grantsSource(" packages/simetra/src packages/simetra/test`; зокрема `rights-roles.test.ts` (`withSources` — два джерела над `RoleGrant`, `"shared"`), `access-units.test.ts` (`grantsSource()` разом із `globalGrantsSource()` над `RoleGrant`), `rights-catalogs.test.ts` (`rightsLevelOf`, `orgGrants` без скоупу — `"missing"`), `rights-sources.test.ts`) — у тому самому коміті. Kitchen-sink тримає ратчет полів (`test/field-ratchet.test.ts`: компіляція мусить прочитати кожен шлях схеми, гілки union включно), тож він отримує й решту нових полів: `where` джерела членства `Crew` з обома гілками (`{ column: "account", isNull: false }` і `{ column: "isActive", equals: true }`), кон'юнкт `isNull` на одному джерелі призначень (поруч із дискримінатором — несумісність за `level` не змінюється), таблицю ролей (`CustomTable` з uuid-ключем, колонкою ключа й колонкою тенанта) і роль через посилання з `where` ролі з обома гілками (`equals` і `isNull`) на одному з джерел — ратчет розгортає кожен union окремо в кожному місці схеми. Літерали дискримінатора — синтетичні й не збігаються з жодним логічним іменем фікстури (`level_global`, `level_org`, `level_partner`, не `org`/`partner`): `reference-index-completeness.test.ts` бере кандидатом кожен рядок, рівний логічному імені
- Test: `compiler/__tests__/rights-sources.test.ts`, `rights-functions.test.ts`, `messages.test.ts`, `json-schema.test.ts`

**Interfaces:**
- Consumes: `AssignmentSourceContract`, `MembershipSourceContract` (Задача 1), `sourceAssignments`, `myScopesBody`, `visibleUsersBody` (Задача 2), `singleUuidKeyColumn`, `isUuidColumn`, `SOURCE_COLUMN_TYPES`, `scopeKindOf`.
- Produces:
  - схема: `sourceConditionSchema = z.union([z.strictObject({ column: elementNameSchema, equals: z.union([z.string(), z.boolean(), z.number().int()]) }), z.strictObject({ column: elementNameSchema, isNull: z.boolean() })])`; `where: z.array(sourceConditionSchema).default([])` на обох видах джерел; `columns.scope: elementName | null` (`.nullable().optional()`, Р2d1-19) і `columns.role: elementName | { column, references: MetadataRef, key, where: SourceCondition[] (.default([])) }` джерела призначень; описи `.meta` англійською;
  - `type SourceConditionContract = { column: string; isNull: boolean } | { column: string; equals: string | boolean | number; type: "text" | "uuid" | "boolean" | "integer" }`;
  - `MembershipSourceContract.where: SourceConditionContract[]`; `AssignmentSourceContract.where: SourceConditionContract[]`, `.scope?: string`, `.roleTable?: { table: QualifiedName; id: string; key: string; where: SourceConditionContract[] }` (`role` лишається фізичною колонкою таблиці-джерела — ключ чи посилання);
  - `export function sourceConditions(alias: string, conditions: readonly SourceConditionContract[]): string[]` у `compiler/rights/functions.ts` — його беруть Задача 4 і 2d2 (Р2d2-4, Р2d2-5);
  - коди `rights.source-where` (`{ source, reason: "type" | "literal" | "shared", column? }`), `rights.source-role-key` (`{ source, table, reason: "primaryKey" | "ambiguous" }`); `rights.source-scope-column` — нові причини `"level"` і `"missing"`;
  - шар фікстури `polymorphicGrants(): Layer` і експорти `POLY_GRANTS_SOURCE_ID`, `POLY_CONTAINER_GRANTS_SOURCE_ID`, `ADOPTED_MEMBER_KEY` (`"member"`).

Шар `polymorphicGrants()` (поверх `adoptedSources()`; синтетичний, без імен споживача): таблиця ролей `SourceRole` (`source_roles`: `id` UUID — ключ, `key` Text, `orgId` UUID `notNull: false`, без скоупу) і поліморфна таблиця призначень `PolyGrant` (`poly_grants`: `id` UUID — ключ, `memberId` UUID, `roleId` UUID, `scopeType` Text, `scopeId` UUID — без FK і без `scopeColumn`; `memberId` і `roleId` — `notNull: false`); джерело `polyGrants` (`POLY_GRANTS_SOURCE_ID` — вільний `uuid(…)` фікстури) рівня `{ scopeKind: "org" }` над `PolyGrant` з `where: [{ column: "scopeType", equals: "org" }]` і `columns: { member: "memberId", scope: "scopeId", role: { column: "roleId", references: ref("CustomTable", "SourceRole"), key: "key", where: [{ column: "orgId", isNull: true }] } }`; друге джерело над тією самою таблицею — `polyContainerGrants` (`POLY_CONTAINER_GRANTS_SOURCE_ID`) контейнерного рівня `{ container: ref("Catalog", "Project") }` з `where: [{ column: "scopeType", equals: "container" }]` і `columns: { member: "memberId", container: "scopeId", role: <те саме посилання на SourceRole з where ролі> }` — контейнерний бік поліморфної таблиці (Review Focus 6); `OrgMember.sourceKeys` — `[{ source: "polyGrants", key: ADOPTED_MEMBER_KEY }]`, `ProjectLead.sourceKeys` — `[{ source: "grants", key: ADOPTED_LEAD_KEY }, { source: "polyContainerGrants", key: ADOPTED_LEAD_KEY }]` (масив замінюється цілком); `assignmentSources` шар повторює повністю (`grantsSource()`, `globalGrantsSource(…)`, `polyGrants`, `polyContainerGrants`), бо `withRoles` зливає поверхнево. Рівень скоупу `org` і контейнер `Project` тоді обидва покриті джерелами, тож шар прибирає `ORG_ROLES_FILE` і `ORG_ASSIGNMENTS_FILE` (інакше `rights.system-catalog-parallel`); якщо компілятор вимагає ключа від кожної ролі покритого рівня, `OrgAdmin` отримує власний ключ `admin` — у DB-засіві рядків з ним немає.

- [ ] **Step 1:** Спека прав §4.7. У пункт «членства» після «необов'язково колонка активності» додати «і необов'язкову умову рядків `where`»; у пункт «призначень» після «необов'язково активність» — «, колонку скоупу рядка (рівень скоупу: колонка, `null` — скоуп з учасника, або пропущена, коли таблиця оголошує `scopeColumn`) і умову рядків `where`; роль — колонкою ключа або посиланням на прийняту таблицю ролей з колонкою ключа й власною умовою `where`». Новий абзац після абзацу «Невідомий ключ ролі…»: «Умова `where` — кон'юнкція рівностей колонки літералу й перевірок на `NULL`; вона лише звужує рядки джерела, а рядки, які вона відсікає, — не призначення джерела, і план про їхні ключі не попереджає. Скоуп призначення рівня скоупу — скоуп учасника; власна колонка скоупу рядка мусить із ним збігатися, і джерело рівня скоупу оголошує її явно — колонкою чи `null` («скоуп з учасника»), якщо таблиця не має `scopeColumn`. Контейнер призначення контейнерного рівня мусить лежати в скоупі учасника. Таблиця під кількома джерелами призначень вимагає, щоб умови `where` кожної пари джерел були несумісні за однією колонкою (різні літерали — не на колонці з власною колацією, літерал проти `NULL`, `NULL` проти не-`NULL`); роль через посилання без `where` ролі — лише коли ключ у таблиці ролей унікальний без предиката. Порушення — помилки компілятора. Одне джерело над таблицею з рядками кількох рівнів компілятор не відрізняє від звичайного: дискримінатор рівня в `where` — на розсуд автора.» В абзаці «Межа відповідальності» після речення про власника таблиці-джерела — «Те саме стосується таблиці ролей джерела.» Run: `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [ ] **Step 2: Write the failing tests (unit).** `rights-sources.test.ts` — `it.each` однією таблицею над `adoptedSourcesDomain(polymorphicGrants())` з перевизначеннями (рядок перевіряє наявність цільового коду на вказівнику, як у Задачі 1; `j` — індекс у `where`, джерело `polyGrants` — `/assignmentSources/2`):
  - `"where unknown column"` — `where[0].column = "nope"` → `customTable.column-unknown` на `/assignmentSources/2/where/0/column`;
  - `"where literal of a text column"` — `{ column: "scopeType", equals: 1 }` → `rights.source-where` `reason: "literal"` на `/assignmentSources/2/where/0`;
  - `"where uuid literal"` — `{ column: "scopeId", equals: "not-a-uuid" }` → `reason: "literal"`; `"where uuid without dashes"` — uuid з 32 hex без дефісів → `reason: "literal"`;
  - `"where array column"` — `PolyGrant` з колонкою `tags` `Text` `array: true`, `{ column: "tags", equals: "x" }` → `reason: "type"`;
  - `"where unsupported type"` — `PolyGrant` з колонкою `weight` `Numeric`, `{ column: "weight", equals: 1 }` → `reason: "type"`;
  - окремий `it("isNull accepts a column of any type")` — `{ column: "weight", isNull: true }` → жодного `rights.source-where` (таблиця вище перевіряє лише наявність коду, тож негативна перевірка — окремо);
  - `"membership where"` — `membersSource` з `where: [{ column: "isActive", equals: "yes" }]` → `rights.source-where` `reason: "literal"` на `/membershipSources/0/where/0`;
  - `"scope missing"` — `polyGrants` без `columns.scope` (таблиця без `scopeColumn`) → `rights.source-scope-column` `reason: "missing"` на `/assignmentSources/2/columns`;
  - `"scope null"` — `columns.scope: null` → без `rights.source-scope-column` (позитивний рядок окремим `it`, як `isNull`; дерево SQL — без кон'юнкта скоупу);
  - `"scope null on a table with a scope column"` — `PolyGrant` скоуплений `org` з `scopeColumn: "scopeId"` і `columns.scope: null` → `rights.source-scope-column` `reason: "column"` на `/assignmentSources/2/columns/scope` (інакше `null` вимикав би звірку скоупу саме там, де таблиця його несе);
  - `"scope null on a container level"` — `grantsSource` з `columns.scope: null` → `reason: "level"`;
  - `"shared table without where"` — `polyContainerGrants` без `where` → `rights.source-where` `reason: "shared"` на `/assignmentSources/2/table` і `/assignmentSources/3/table` (на обох джерелах пари);
  - `"shared with the same literal"` — обидва `where: [{ column: "scopeType", equals: "org" }]` → `reason: "shared"` на обох;
  - `"shared with the same uuid in another case"` — обидва `{ column: "scopeId", equals: <uuid> }`, у другого — той самий uuid великими літерами → `reason: "shared"`;
  - `"shared with equals against isNull false"` — `{ column: "scopeType", equals: "org" }` і `{ column: "scopeType", isNull: false }` → `reason: "shared"`;
  - `"shared with different literals under a column collation"` — `scopeType` з `collation` (будь-яка, наприклад `"C"`), літерали `org` і `container` → `reason: "shared"`;
  - `"shared with conditions on different columns"` — `{ column: "scopeType", equals: "org" }` і `{ column: "scopeId", isNull: true }` → `reason: "shared"`;
  - окремий `it.each("disjoint conditions pass")` — різні літерали (форма фікстури); `equals` проти `isNull: true`; `isNull: true` проти `isNull: false`; пара, несумісна за однією колонкою при спільних інших кон'юнктах → жодного `rights.source-where` `reason: "shared"`;
  - `"role ambiguous"` — `where` ролі прибрано в обох джерел → `rights.source-role-key` `reason: "ambiguous"` на `/assignmentSources/2/columns/role` і `/assignmentSources/3/columns/role`;
  - `"role ambiguous with a collated unique index"` — `where` ролі прибрано, унікальний індекс `keys: [{ column: "key", collation: "C" }]` → `reason: "ambiguous"` (так само рядок з `opclass`);
  - `"role ambiguous with a partial unique index"` — як попередній, плюс `SourceRole.indexes: [{ name: "source_roles_key_system", unique: true, keys: [{ column: "key" }], where: "org_id IS NULL" }]` → `reason: "ambiguous"`;
  - окремий `it.each("a unique role key needs no role where")` — `where` ролі прибрано, а `SourceRole` має `uniques: [{ columns: ["key"] }]` або унікальний індекс `keys: [{ column: "key" }]` без `where` (два рядки; рядка з первинним ключем немає — ключ таблиці ролей мусить бути uuid `id`, Р2d1-17) → жодного `rights.source-role-key`;
  - `"scope on a container level"` — `grantsSource` з `columns.scope = "projectId"` (наявна колонка UUID `RoleGrant`, тож стадія 2 її резолвить) → `rights.source-scope-column` `reason: "level"` на `/assignmentSources/0/columns/scope`;
  - `"scope text"` — `scopeId` типу `Text` → `rights.source-column-type` `expected: "UUID"` на `/assignmentSources/2/columns/scope`;
  - `"unscoped table with a scope column"` — `polyGrants` як у шарі (нескоуплена `PolyGrant` без `scopeColumn`, `columns.scope = "scopeId"`) — без `rights.source-scope-column` (покриває й `"clean"`, але рядок називає правило явно);
  - `"scope other than the table scope column"` — `PolyGrant` скоуплений `org` з `scopeColumn: "orgId"` (нова колонка UUID), `columns.scope = "scopeId"` → `rights.source-scope-column` `reason: "column"`;
  - `"role table not adopted"` — `references: ref("Catalog", "Project")` → `rights.source-table` на `/assignmentSources/2/columns/role/references`;
  - `"role table composite key"` — ключ `SourceRole` — `["orgId", "id"]` → `rights.source-role-key` `reason: "primaryKey"`;
  - `"role table forced rls"` — `SourceRole.rowLevelSecurity = "forced"` → `rights.source-forced-rls` на `/assignmentSources/2/columns/role/references`;
  - `"role key uuid"` — `key: "id"` → `rights.source-column-type` `expected: "Text"` на `/assignmentSources/2/columns/role/key`;
  - `"role column text"` — `roleId` типу `Text` → `rights.source-column-type` `expected: "UUID"` на `/assignmentSources/2/columns/role/column`;
  - `"role where literal"` — `{ column: "orgId", equals: true }` → `rights.source-where` `reason: "literal"` на `/assignmentSources/2/columns/role/where/0`;
  - `"clean"` — помилок немає, попередження — рівно `rights.adopted-source-writes` на кожне джерело.

  `rights-functions.test.ts` (дерева розбору без позицій):
  - `it("a polymorphic source filters rows, checks the row scope and joins the role table")` — гілка `assignments` джерела `polyGrants` дорівнює дереву:
    ```sql
    SELECT 'source'::text AS storage, '<POLY>'::uuid AS storage_id, s.scope AS scope, NULL::uuid AS container, NULL::uuid AS custom_role, k.role_id AS archetype,
           '<ORG>'::uuid AS scope_kind_id, 'scope'::text AS source_level, '<ORG>'::uuid AS source_level_id
    FROM public.poly_grants src
    JOIN public.source_roles sr ON sr.id = src.role_id AND sr.org_id IS NULL
    JOIN simetra.rights_source_keys() k ON k.source_id = '<POLY>'::uuid AND k.key = sr.key
    JOIN my_scopes s ON s.scope_kind_id = '<ORG>'::uuid AND s.member = src.member_id AND s.scope = src.scope_id
    WHERE src.scope_type = 'org'
    ```
  - `it("the row scope column defaults to the table scope column")` — `PolyGrant` скоуплений `org` з `scopeColumn: "scopeId"`, без `columns.scope` → кон'юнкт `s.scope = src.scope_id`; нескоуплена `PolyGrant` без `scopeColumn` з `columns.scope: null` → кон'юнкта скоупу немає (скоуп з учасника); контейнерна гілка `grants` — без кон'юнкта скоупу.
  - `it("a membership where narrows my scopes and visible users")` — `membersSource` з `where: [{ column: "userId", isNull: false }, { column: "isActive", equals: true }]` → гілка `rights_my_scopes` має `s.user_id IS NOT NULL AND s.is_active = TRUE`, гілка `rights_visible_users` — `m.user_id IS NOT NULL AND m.is_active = TRUE`.
  - `it.each` над `sourceConditions("src", …)`: текст з лапкою (`o'k`) → `src.c = 'o''k'`; uuid → `src.c = '<uuid>'::uuid`; `true` → `src.c = TRUE`; ціле `7` → `src.c = 7`; `isNull: false` → `src.c IS NOT NULL`; порожній масив → `[]`.
  - `messages.test.ts` — нові коди й причини `"level"`, `"missing"`, `"shared"`, `"ambiguous"`, `"primaryKey"`.
- [ ] **Step 3:** Run: `pnpm --filter simetra test rights-sources rights-functions messages` — FAIL.
- [ ] **Step 4: Implement** за Р2d1-15…Р2d1-19. Стадія 2 (`identity.ts`): помічник `table(...)` (`identity.ts`) зараз жорстко будує вказівник `${at}/columns/${field}` і сам реєструє `source.table` — його параметризувати (ціль і перелік пар «вказівник → ім'я колонки»), щоб колонки `where` (`${at}/where/${j}/column`), `columns.scope` і колонка посилання (`${at}/columns/role/column`) резолвилися над таблицею-джерелом, а `key` і `where` ролі — над ціллю `columns.role.references` (`resolveObjectRef(…, "source.roleTable")`), з роллю `source.column`. Стадія 4 (`checkSources`): типи — через `checkColumnTypes` з полями `"scope"`, `"role/column"` (`UUID`), а `"role"` (`Text`) — лише для форми рядком; `checkColumnTypes` шукає колонку серед колонок переданої таблиці, тож `role/key` і `where` ролі перевіряються з таблицею ролей як ціллю (інакше тип мовчки не перевіриться); таблиця ролей — той самий шлях, що `table(...)` (прийнята, без `FORCE`) плюс `singleUuidKeyColumn`; помічник `table(...)` у `checks.ts` звітує на жорстко заданому `${at}/table` з роллю `source.table` — параметризувати його вказівником і роллю посилання (`${at}/columns/role/references`, `source.roleTable`), так само як у `identity.ts`; `where` — одна функція перевірки для джерела й ролі. Контракт `scope`: `columns.scope` — рядок → його фізична колонка; `null` → `undefined`; поле відсутнє → фізична колонка `scopeColumn` (наявність на рівні скоупу гарантує помилка `"missing"`). Перевірка `"shared"` групує джерела призначень за id цілі `source.table` і для кожної пари шукає колонку доведеної несумісності (Р2d1-19, п. 2); літерал порівнюється за типом колонки, uuid — у нижньому регістрі; `"ambiguous"` читає `uniques` і `indexes` таблиці ролей за правилом Р2d1-19 (3) (ключ індексу — колонка, не вираз; індекс із `where` — частковий, не рахується; `opclass`/`collation` — не рахується). SQL — `sourceConditions` у `myScopesBody`, `visibleUsersBody` і `sourceAssignments` (кон'юнкти `where` джерела — у `WHERE`, умови ролі — в `ON` з'єднання `sr`). Коментарі «чому» — R1/R1'/R2 синтетично (адмін тенанта A вписує учасника B; рядок іншого рівня; кастомна роль із ключем системної), без деталей споживача.
- [ ] **Step 5:** Run: `UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`, потім `pnpm --filter simetra test rights access messages json-schema codegen field-ratchet reference-index operations-rename && pnpm --filter simetra typecheck` — PASS. **Мутації** (вручну, без коміту): прибрати кон'юнкт `s.scope = src.<scope>` → червоніє перший тест `rights-functions`; прибрати перевірку літерала — рядок `"where uuid literal"` червоніє; прибрати перевірку `"missing"` → `"scope missing"`; прибрати перевірку `"shared"` → `"shared table without where"`; звести перевірку несумісності до непорожності `where` → червоніють `"shared with the same literal"`, `"shared with equals against isNull false"` і `"shared with conditions on different columns"`; порівнювати uuid з урахуванням регістру → `"shared with the same uuid in another case"`; ігнорувати `collation` колонки → `"shared with different literals under a column collation"`; рахувати індекс з `collation`/`opclass` унікальним → `"role ambiguous with a collated unique index"`; прибрати перевірку `"ambiguous"` → `"role ambiguous"`; рахувати частковий індекс унікальним (ігнорувати `where` індексу) → `"role ambiguous with a partial unique index"`.
- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-17-rights-design.md packages/simetra/src packages/simetra/schemas
git commit -m "feat(compiler): умови рядків прийнятого джерела, скоуп рядка й роль через посилання"
```

---

### Задача 4: перевірки плану над даними цілі

**Files:**
- Create: `packages/simetra/src/schema/apply/rights-sources.ts`
- Modify: `packages/simetra/src/schema/apply/plan.ts`, `schema/apply/index.ts` (лише якщо DB-тест імпортує через нього), `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/rights-sources.test.ts`, `plan.test.ts`, `compiler/__tests__/messages.test.ts`

**Interfaces:**
- Consumes: `CompiledModel.contracts.membershipSources`, `.assignmentSources` (з `where`, `roleTable` — Задача 3a), `.roles` (`sourceKeys`); `sourceConditions` (Задача 3a).
- Produces:
  - `interface RightsSourceFacts { owners: { table: string; owned: boolean }[]; unknownKeys: { source: string; keys: string[]; more: number }[] }`;
  - `readRightsSourceFacts(tx: ApplyTransaction, input: { tables: QualifiedName[]; assignments: { source: AssignmentSourceContract; keys: string[] }[] }): Promise<RightsSourceFacts>` — одна транзакція; `tables` — таблиці-джерела й таблиці ролей (`roleTable.table`) без повторів; дані — під `withLocalSettings(tx, [{ name: "row_security", value: "off" }], …)`;
  - `unknownKeysQuery(source: AssignmentSourceContract): { sql: string; columns: { table: QualifiedName; column: string }[] }` — чистий будівник запиту ключів (параметр `$1` — масив відомих ключів) і перелік колонок, які він читає (для перевірки `pg_attribute`, Р2d1-11);
  - `rightsSourceInput(contracts: Pick<Contracts, "membershipSources" | "assignmentSources" | "roles">): Parameters<typeof readRightsSourceFacts>[1]` — вхід читача, який будує `plan.ts`;
  - `rightsSourceDiagnostics(facts: RightsSourceFacts): { refusal?: EngineDiagnostic; warnings: EngineDiagnostic[] }`;
  - коди `plan.rights-source-access` (`{ tables: string }`, помилка) і `plan.rights-source-unknown-keys` (`{ source, keys: string, more: number }`, попередження через `applyDiagnostic(…, "warning", …)`).

- [ ] **Step 1: Write the failing tests (unit, фейкова `ApplyTransaction` за зразком `plan.test.ts`):**
  - `rights-sources.test.ts`: `it.each` над `rightsSourceDiagnostics`: таблиця, якою роль не володіє (`owned: false`) → відмова з переліком; 25 таких → перелік з 20 і решта кількістю; усі `owned` → без відмови; невідомі ключі → одне попередження на джерело з `keys` і `more`.
  - `it("reads data with row security off and skips a missing or unowned table")` — журнал запитів фейку: читання ключів — після запиту `withLocalSettings` з параметрами (`row_security`, `off`) (імена й значення передаються масивами-параметрами, тож перевіряються параметри, а не текст SQL); таблиця з `to_regclass` = `NULL` і таблиця з `owned: false` — без запиту даних.
  - `it("the keys query reads the role table through the same join and conditions")` — дерево `unknownKeysQuery` для `polyGrants` (`adoptedSourcesDomain(polymorphicGrants())`) має `JOIN public.source_roles sr ON sr.id = src.role_id AND sr.org_id IS NULL`, ключ `sr.key` і `src.scope_type = 'org'`; `columns` — `role_id`, `scope_type`, `id`, `key`, `org_id` з їхніми таблицями; для `grants` — без з'єднання, ключ `src.role_key`, `columns` — `role_key` (колонки активності `grants` не мапить; `active` потрапляє в `columns` лише змапованою — рядок `it.each` з перевизначенням `columns.active`). Мутація: прибрати умову ролі з будівника → тест червоніє (DB-кейс `poly-plan-keys`, Задача 5).
  - `it("checks the owner of a role table")` — `rightsSourceInput(contracts)` для `adoptedSourcesDomain(polymorphicGrants())`: `tables` містить `public.source_roles` поруч із таблицями-джерелами, кожну рівно раз; `assignments` — по запису на джерело з його `keys` (`sourceKeys` ролей цього джерела).
  - `plan.test.ts`: `it("refuses a plan when the apply role cannot bypass RLS of a source table")` — фейк відповідає `owned: false` → `status: "refused"`, код `plan.rights-source-access`, тінь не будувалася; `it("warns about unknown role keys in a source")` — план будується далі, попередження в `diagnostics`. Обидва кейси — і для гілки промоції (`it.each(["plan", "plan with a promotion"])`): перевірка йде до розгалуження.
  - `messages.test.ts` — нові коди.
- [ ] **Step 2:** Run: `pnpm --filter simetra test rights-sources plan messages` — FAIL.
- [ ] **Step 3: Implement** за Р2d1-10, Р2d1-11, Р2d1-13. SQL власника: `relrowsecurity`, `pg_has_role(current_user, relowner, 'USAGE')`, `rolbypassrls`/`rolsuper` ролі `current_user`, `has_table_privilege(current_user, <oid>, 'SELECT')` (усе `pg_catalog`-кваліфіковано). SQL ключів (`unknownKeysQuery`): `SELECT DISTINCT <ключ>::text FROM <таблиця> src [JOIN <ролі> sr ON sr.<pk> = src.<role> [AND <where ролі>]] WHERE <ключ> IS NOT NULL [AND src.<active> IS TRUE] [AND <where джерела>] AND NOT (<ключ>::text = ANY($1))`, де `<ключ>` — `src.<role>` чи `sr.<key>`; умови — `sourceConditions` (Р2d1-18). Коментар «чому» — `SECURITY DEFINER` від власника функції (Р2d1-10).
- [ ] **Step 4:** Run: `pnpm --filter simetra test rights-sources plan messages && pnpm --filter simetra typecheck` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(schema): план перевіряє власника таблиці-джерела й невідомі ключі ролей"
```

---

### Задача 5: DB-сценарій прийнятих джерел

**Files:**
- Create: `packages/simetra/test/db/rights-sources.db.test.ts`
- Modify: `packages/simetra/test/db/rights-seed.ts` (будівники рядків джерел, якщо засів повторюється)

Причина DB-рівня (шапка файлу): що Postgres поверне з функцій прав під роллю `authenticated` для живих рядків прийнятих таблиць (зокрема поліморфної таблиці призначень і таблиці ролей), що політики читання пропустять, що regex і приведення `sub` не кинуть, і що читання власника й даних цілі працює на справжньому каталозі.

- [ ] **Step 1: Write the test** — два описи, одне розгортання на опис (`describeTransaction`, Р2a1-18):
  - опис `adopted sources` над `adoptedSourcesDomain(adoptedCrossKind())`. Шар `adoptedSources()`: кладе SQL-файл функції множини `public.org_ids()` (`LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''`, `SELECT m.org_id FROM public.membership m WHERE m.user_id = (SELECT simetra.current_user_id()) AND m.is_active IS TRUE`) — межа тенанта поважає активність; прибирає вимір `region` (`accessDimensions: []`, `access: undefined` на `Task` і `TaskHours` (відхилення при виконанні, погоджено архітектором: `accessSchema` має `.min(1)`, тож порожній `access: []` недопустимий; вплив на спеку: немає)) — його зв'язок `MemberRegion` прибрав `adoptedMembership()`; глобальне джерело — над окремою таблицею `GlobalGrant` (`globalGrantTable()`), щоб ключі одного джерела не були «невідомими» для іншого. Засів (увесь — у `beforeAll`; кейси лише читають через `queryAs`, тож порядок кейсів не впливає). «Порожньо» й «рівно права» в кейсах нижче — про рядки `rights_mine()` з `level <> 'everyUser'`: роль `Everyone` (`read@own` на «Користувачах») дає рядки кожному дійсному користувачу, і це не джерело. Засів: тенанти A і B, учасники `Membership` (активний u1 в A; активний u5 в A без рядків `RoleGrant` і без призначень; активний u7 в A; активний u9 в A; неактивний u2 в A; учасник з `is_active IS NULL` в A; u3 в B; рядок без `user_id`), проєкти P1 і P2 в A, проєкт P1 в A з задачею, `RoleGrant`: (u1-учасник, `lead`, P1), (u3-учасник, `lead`, P1) — учасник B на проєкті A, (u1-учасник, `nope`, P1), (u2-учасник, `lead`, P1), глобальний (u4-користувач, `support`). Кейси (`it.each`, `queryAs` під `authenticated`):
    - `source-scopes` — `rights_my_scopes()` u1: (`org`, A, учасник u1); u2 (неактивний) і рядок без користувача — нічого (кейс читає функцію напряму: межа тенанта `org_ids` теж поважає активність і маскувала б мутацію);
    - `source-container` — u1 читає задачу P1 (`read@any` контейнерної `ProjectLead`);
    - `source-not-mine` — `rights_mine()` u5 (учасник A без власних рядків джерела) порожня, хоч рядок `RoleGrant` (u1-учасник, `lead`, P1) лежить у тому самому тенанті; u3 (учасник B) задачі P1 не бачить, а `rights_mine()` u3 (напряму: межа тенанта `org_ids` маскувала б мутацію `held`) не має рядка `level = 'container'` з `container` = P1;
    - `source-cross-kind` — користувач u6, єдине членство якого — рядок виду `team` (шар `adoptedCrossKind()`) з підлаштованими id: id рядка членства = id **неактивного** учасника u2 в A, id кореня `team` = A (Р2a1-26 — збіг обох); рядок `RoleGrant` (цей id, `lead`, P2) нічого не дає u2 (неактивний) — `rights_mine()` u6 порожня;
    - `source-inactive` — u2 (`is_active = false`) і учасник з `is_active IS NULL`: `rights_my_scopes()` і `rights_mine()` порожні (напряму, не через таблицю);
    - `source-unknown-key` — рядок з `nope` нічого не дає (u1 має рівно права `lead`); рядки `RoleGrant` з `role_key IS NULL` і з `member_id IS NULL` — нічого, без помилки;
    - `source-wrong-level` — засіяний рядок контейнерного джерела (u9-учасник, `support`, P1) нічого не дає (u9 — окремий учасник: u7 має призначення каталогу з `source-subject`) (поведінковий кейс без мутації: його тримає і з'єднання за `source_id`, і помилка компілятора `rights.source-key-level`; порівняння рівня в `typed` доводить unit-тест Задачі 2);
    - `source-global` — u4 має права `Support` (`has_right`);
    - `source-visible-users` — `rights_visible_users()` під u1 (напряму: межа `RESTRICTIVE` нічого не відкриває сама, а права читання «Користувачів» в u1 — лише `own`) містить u1 і u5, не u3 і не u2 (неактивний);
    - `source-subject` — призначення в довіднику `org` з `subject` = учасник `Membership` u7 діє (u7, а не u1 чи u5: `source-unknown-key` перевіряє рівно права `lead` у u1, `source-not-mine` — порожнечу в u5); засів призначення — через спільний будівник `insert` (`rights-seed.ts`), який після 2c2 вмикає режим обслуговування для системних довідників; FK відхиляє `subject` учасника B у довіднику A (`23503`); видалення рядка `Membership` u7, на якого посилається призначення, відмовляє `23503` (Р2d1-5);
    - `source-plan-facts` — `readRightsSourceFacts` через `rollbackDatabase(client)` (як `carrier-backfill.db.test.ts`): під роллю опису (`postgres`, власник) → `owned: true`, ключ `nope` — у `unknownKeys`; під `SET LOCAL ROLE <тегована NOLOGIN NOBYPASSRLS роль, не член власника, з SELECT на всі таблиці-джерела>` (через `testRoleName`) при увімкненому RLS таблиці (`ALTER TABLE … ENABLE ROW LEVEL SECURITY` у тій самій транзакції `rollbackDatabase` — фікстурна таблиця його не має) → `owned: false` і дані не читаються; `unknownKeys` перевіряється на наявність `nope` (рядок u9 з `support` теж туди потрапляє).
  - опис `without users` над `adoptedSourcesDomain(withoutUsers(), polymorphicGrants())` (Задача 3a; системних довідників `org` у цьому описі немає — жоден його кейс їх не читає), власний засів (друге розгортання): тенанти A і B, рядки `Membership` активних u1, u5 в A і u3, u8 в B (id користувача = uuid `sub`), проєкт P1 в A із задачею, рядок `RoleGrant` (u1-учасник, `lead`, P1); `source_roles`: R_sys (`org_id IS NULL`, `member`), R_cust (`org_id` = A, `member`), R_ghost (`org_id IS NULL`, `ghost`), R_z (`org_id` = A, `zzz`), R_lead (`org_id IS NULL`, `lead`); проєкт P_B у B і проєкт P_X у B з id, рівним id тенанта A (колізія id, які генерує клієнт); `poly_grants`: (u1-учасник, R_sys, `org`, A) — контроль; (u3-учасник, R_sys, `org`, A) — R1; (u8-учасник, R_sys, `container`, B) — R1'; (u5-учасник, R_cust, `org`, A) — R2; (u1-учасник, R_ghost, `org`, A); (u1-учасник, R_z, `org`, A); (u8-учасник, R_lead, `container`, P_B) — контейнерний контроль; (u3-учасник, R_lead, `org`, A) — рядок рівня скоупу, чий `scope_id` збігається з id P_X. Кейси (`queryAs` з claims `sub`; «рядки рівня скоупу» — рядки `rights_mine()` з `level = 'scope'`, напряму, без таблиць — межа тенанта не маскує):
    - `no-users-subject` — claims з `sub` = uuid u1 → `current_user_id()` = u1 і задача P1 видна; `sub` = `"not-a-uuid"` → `NULL`, запит без помилки, рядків нуль; `anon` без `sub` → `NULL`;
    - `poly-control` — позитивний контроль: u1 має рядки рівня скоупу зі `scope` = A — права `OrgMember` (набір `TaskEditors`: рядок (`Task`, `read`) серед них; `rights_mine` колонки ролі не має, тож роль видно за правами). Рядки R1, R1' і R2 відрізняються від рядка u1 учасником (іншого користувача) і ще кожен своєю ознакою — R1 нічим, R1' `scope_type` і `scope_id`, R2 роллю; що відмову дає саме цільова умова, а не з'єднання, RLS чи FK, доводять мутації нижче (кожна червонить свій кейс при зеленому `poly-control`);
    - `poly-scope-mismatch` (R1) — u3 рядків рівня скоупу не має (ні A, ні B);
    - `poly-other-level` (R1') — u8 рядків рівня скоупу не має;
    - `poly-custom-role` (R2) — u5 рядків рівня скоупу не має;
    - `poly-container-collision` (Review Focus 6) — u8 має рядок `level = 'container'` з `container` = P_B (контроль); u3 рядка `level = 'container'` з `container` = P_X (= A) не має;
    - `poly-plan-keys` — `readRightsSourceFacts(tx, rightsSourceInput(contracts))` під роллю опису: `unknownKeys` джерела `polyGrants` — рівно `["ghost", "lead"]` (`lead` — з рядка колізії: ключ контейнерної ролі в рядку рівня скоупу; `zzz` відсікає `where` ролі, Р2d1-18; `member` відомий), джерела `polyContainerGrants` — рівно `["member"]` (рядок R1' (u8, R_sys, `container`, B) проходить його `where`, а ключ `member` контейнерне джерело не знає — той самий ефект двох джерел над однією таблицею, що у «Відомих обмеженнях»). Ключі порівнюються як є: `readRightsSourceFacts` сортує їх (`compareStrings`), бо `SELECT DISTINCT` порядку не гарантує, а текст попередження має бути стабільним.
- [ ] **Step 2:** Run: `pnpm --filter simetra exec vitest run --project db rights-sources` — PASS. **Мутаційний доказ** (вручну, без коміту), кожна мутація червонить свій кейс і саме на цільовій умові, а не на RLS межі тенанта чи FK:
  - прибрати `IS TRUE` активності в `rights_my_scopes` → `source-scopes`/`source-inactive` (`rights_my_scopes()` і `rights_mine()` u2 стають непорожніми; кейси читають функції напряму, бо межа тенанта `org_ids` теж поважає активність);
  - прибрати умову `s.member = src.<member>` у з'єднанні гілки джерела з `my_scopes` → `source-not-mine` на твердженні про u5 (рядок u1-учасника стає «своїм» для u5 у тому самому тенанті; для u3 рядок не проходить `held` за скоупом, тож тверджень про u3 мутація не червонить);
  - прибрати типізацію за видом (`s.scope_kind_id = <K>`) → `source-cross-kind`;
  - прибрати regex у `subjectUserFunction` → `no-users-subject` (помилка `22P02`);
  - прибрати гілку джерела з `rights_visible_users` → `source-visible-users`;
  - прибрати `k.scope IS NOT DISTINCT FROM t.scope` у `held` → `source-not-mine` на твердженні про `rights_mine()` u3 (учасник B на контейнері A — аналог R1 для контейнера, Review Focus 6; твердження про таблицю лишається зеленим — його тримає межа тенанта);
  - прибрати кон'юнкт `s.scope = src.<scope>` (Р2d1-16) → `poly-scope-mismatch` (u3 отримує рядки рівня скоупу в B), `poly-control` зелений;
  - прибрати `where` джерела `polyGrants` у генераторі (Р2d1-15) → `poly-other-level` (u8 отримує рядки рівня скоупу в B), `poly-control` зелений;
  - прибрати `where` ролі в `sourceAssignments` (Р2d1-17) → `poly-custom-role` (u5 отримує рядки рівня скоупу в A), `poly-control` зелений;
  - прибрати `where` ролі в `unknownKeysQuery` → `poly-plan-keys` (`zzz` з'являється);
  - прибрати `where` джерела `polyContainerGrants` у генераторі `sourceAssignments` (не в метаданих фікстури: тоді почервоніє й `poly-plan-keys`) → `poly-container-collision` (u3 отримує роль `ProjectLead` на P_X у B: рядок рівня скоупу, вписаний адміном A, читається як контейнер), контроль u8 зелений.
- [ ] **Step 3: Commit**

```bash
git add packages/simetra/test/db
git commit -m "test(rights): прийняті джерела на живих рядках"
```

---

### Задача 6: скіл, гейти й заміри

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/references/people-and-rights.md`, `docs/ROADMAP.md`, цей план (позначки)

- [ ] **Step 1:** Скіл споживача (англійською): прийняте членство й призначення дають права; учасник — одноколонковий uuid-ключ; `UNIQUE (scope, id)` у метаданих таблиці для системних довідників; `sourceKeys`; роль застосування має володіти таблицею-джерелом з RLS чи мати `BYPASSRLS`; запобіжники й версії на джерелах не діють; без «Користувачів» — `sub` як uuid; умова рядків `where` (обидва види джерел), колонка скоупу рядка (`columns.scope`; пропущена — `scopeColumn` таблиці; `null` — явно скоуп учасника; пропуск без `scopeColumn` — помилка) і роль через посилання на таблицю ролей із власною `where`; компілятор вимагає явного `columns.scope` (колонка чи `null`) на рівні скоупу без `scopeColumn`, попарно несумісних за однією колонкою `where` на джерелах над спільною таблицею й `where` ролі, коли ключ у таблиці ролей не унікальний без предиката (Р2d1-19) — скіл пояснює кожну помилку й радить дискримінатор рівня (синтетичний приклад — `scope_type`) і для одного джерела над такою таблицею; рядки, відсічені `where`, план не називає; дослівна функція множини скоупу (`setFunction` з SQL споживача) **мусить** застосовувати ту саму `where` джерела членства, що й активність, — інакше межа тенанта розійдеться з `rights_my_scopes`; видалити учасника прийнятого членства, на якого посилаються платформні призначення, — спершу зняти призначення (інакше `23503`). Речення про попередження `rights.adopted-source-unsupported` прибрати.
- [ ] **Step 2:** Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — код 0.
- [ ] **Step 3:** Run: `pnpm metadata:check && python3 scripts/check-doc-anchors.py && .agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-25-rights-2d1-adopted-sources.md` — код 0.
- [ ] **Step 4:** Повний `pnpm test:db` на одному SHA (у фоні, таймаут не коротший за 45 хв): `/usr/bin/time -f %e pnpm test:db` — код 0 (або CI job `db`); приріст проти прогону після 2b2 ≤ 15 с (два розгортання `rights-sources`), інакше звіт архітектору з розкладом за файлами.
- [ ] **Step 5:** ROADMAP — «Права-2d1 виконано»; позначки плану.
- [ ] **Step 6: Commit**

```bash
git add packages/designer/skills docs/ROADMAP.md docs/superpowers/plans/2026-10-25-rights-2d1-adopted-sources.md
git commit -m "docs(plan): Права-2d1 виконано — скіл, ROADMAP, позначки"
```

## Критерії приймання

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py` — зелені після **кожного** коміту; повний `pnpm test:db` — зелений на одному SHA, приріст записано (≤ 15 с).
- Коду й повідомлень `rights.adopted-source-unsupported` немає; є попередження `rights.adopted-source-writes` (Задача 1).
- Умова `where`, колонка скоупу рядка й роль через посилання діють у функціях прав і в читанні ключів плану; R1, R1' і R2 закрито з мутаційним доказом (Задачі 3a, 5).
- Учасник і призначення прийнятих джерел дають права лише в межах свого виду, тенанта, рівня й активності (Задача 5, мутації).
- Без «Користувачів» на Supabase права працюють від `sub`; `sub`, що не є uuid, — `NULL` без помилки (Задачі 3, 5).
- План відмовляє `plan.rights-source-access` і попереджає `plan.rights-source-unknown-keys` в обох гілках (Задача 4).
- Спека прав §4.7, спека системної схеми §7 і борг §5 оновлені (Задача 0).
