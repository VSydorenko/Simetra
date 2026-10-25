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

Розвилки Ф1 і Ф12 вирішив архітектор задачі 2026-10-25.

| # | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р2d1-1 | Поділ і черговість — 2d1 → 2c1 → 2c2 → 2d2; 2d1 і 2c1 паралельно (архітектор, Ф1) | 2d1 на критичному шляху першого споживача й від 2c не залежить: адаптеру не потрібні ні версії, ні журнал (платформа джерело лише читає); аналіз прав 2d2 гейтить дія адміністрування з 2c2 (спека §5.1) | немає |
| Р2d1-2 | Учасник прийнятого джерела членства = первинний ключ таблиці-джерела, лише коли він одноколонковий і має тип `UUID`; інакше помилка `rights.source-member-key` на `/membershipSources/<i>/table` з порадою оголосити одноколонковий uuid-ключ у метаданих `CustomTable` (архітектор, Ф12). Контракт: `MembershipSourceContract.member: string` — фізична колонка ключа | id учасника — значення носія власності, суб'єкта призначення й колонки `member` джерела призначень; складений ключ не має одного значення | спека прав §4.7 — «учасник — одноколонковий uuid-ключ таблиці-джерела» (Задача 0) |
| Р2d1-2a | Типи змапованих колонок джерел перевіряє компілятор: `scope`, `user`, `member`, `container` — `UUID`, `active` — `Boolean`, `role` — `Text` чи `String(n)`; інакше помилка `rights.source-column-type` `{ source, column, expected }` на `/membershipSources/<i>/columns/<поле>` чи `/assignmentSources/<i>/columns/<поле>` | інакше невідповідність типів виявилася б лише під час створення чи виконання функцій прав на застосуванні | немає |
| Р2d1-3 | `rights_my_scopes()` — гілка `UNION ALL` на кожне джерело членства: `SELECT <вид>, s.<scope>, s.<member> FROM <таблиця> s WHERE s.<user> IS NOT NULL AND s.<user> = (SELECT current_user_id()) [AND s.<active> IS TRUE]`; умова активності — лише коли колонку змаплено | та сама форма, що гілка довідника членства (Р2a1-25); `IS TRUE` — `NULL` в активності не дає членства (fail-closed) | немає |
| Р2d1-4 | Ключ ролі → архетип — нова функція даних `simetra.rights_source_keys() RETURNS TABLE (source_id uuid, key text, role_id uuid)` (`VALUES` з `Role.sourceKeys` усіх ролей; `IMMUTABLE`, без `EXECUTE`, як Р2a1-14). `rights_mine`: CTE `assignments` отримує гілку на кожне джерело призначень — `storage = 'source'`, `storage_id = <sourceId>`, `custom_role = NULL`, `archetype` — з `rights_source_keys()` за (`source_id`, значення колонки `role`) внутрішнім з'єднанням (невідомий ключ — нуль рядків); рівень скоупу й контейнерний з контейнером у виді скоупу K — `JOIN my_scopes s ON s.scope_kind_id = <K> AND s.member = src.<member>`, `scope = s.scope`; глобальний і контейнерний з нескоупленим контейнером (вид скоупу контейнера відсутній, як `Partner` у `kitchen-sink.ts`; `storageOf` — глобальний) — `src.<member> = (SELECT current_user_id())`, `scope = NULL`; `container` — колонка `container` джерела (лише контейнерний рівень, інакше `NULL`); `[AND src.<active> IS TRUE]`. CTE `assignments` отримує дві нові колонки: `scope_kind_id` (довідник — його `storage_id`, бо рівень зберігання й є вид скоупу чи `NULL`; джерело — стала K чи `NULL`) і `source_level`/`source_level_id` (джерело — стала рівня джерела, довідник — `NULL`). `typed`: рядок довідника — як зараз (за рівнем зберігання); рядок джерела — `JOIN rights_roles() r ON r.role_id = x.archetype AND r.level = x.source_level AND r.level_id IS NOT DISTINCT FROM x.source_level_id` (рівень зберігання ролей, покритих джерелом, — `NULL`, Р2a1-12, тож рядок довідника їх і далі не вмикає). `held` порівнює вид скоупу контейнера з `t.scope_kind_id`, а не з `t.storage_id` (`storage_id` рядка джерела — id джерела, тож без цієї зміни жоден контейнерний рядок джерела не пройшов би `held`). Дельти й замикання — без змін (кастомної ролі в рядку джерела немає) | один шлях обчислення для довідника й джерела; ключ і рівень — сталі генератора, не дані | немає (§4.7) |
| Р2d1-5 | Системні довідники прав виду, чиє членство дає лише прийняте джерело: ціль стандартного посилання `member` (`standardTargetRefs`) — таблиця-джерело членства виду; складений FK `(скоуп, subject)` потребує `UNIQUE (scope, id)` у метаданих таблиці (`uniques`) — інакше помилка `rights.source-member-unique` на `/membershipSources/<i>/table` з порадою додати обмеження в метадані `CustomTable` (архітектор, Ф12). Помилка `rights.system-catalog-scope` (Р2a1-24, п. 4) лишається лише для виду без жодного членства; пропуск `rights.system-catalog-missing` для виду з членством із джерела знімається — рівень з ролями, не покритий джерелом призначень, потребує довідників, як будь-який інший (Р2a1-5) | сценарій першої міграції: прийняте членство й нові ролі в довідниках Simetra (Р2a1-24, змішування). Наслідок, прийнятий свідомо (як для власності, §4.2, що вже посилається на прийняту таблицю): FK встановлює RI-тригери Postgres на таблиці-джерелі, тож видалення застосунком рядка учасника, на якого посилається призначення Simetra, відмовляє `23503` — це FK, а не тригер платформи; помічники — наявні `singleUuidKeyColumn` (`model/kinds/custom-table.ts`) і `hasScopeKeyUnique` (`compiler/stages/model.ts`) | спека прав §4.7 — речення про `subject` системних довідників, `UNIQUE (scope, id)` і про те, що видалення учасника з призначеннями Simetra відмовляє FK (Задача 0) |
| Р2d1-6 | `simetra.current_user_id()` без «Користувачів» (Р2a1-30): генерується, коли довідника з роллю `users` немає, у проєкті є хоч одне джерело членства, а провайдер має факт T0 `PROVIDER_IDENTITY_SOURCES[provider].subjectIsUserId === true` (Supabase, С8). Тіло — plpgsql `STABLE SECURITY DEFINER SET search_path = ''`: `sub` з `SESSION_CLAIMS_SETTING`; рядок, що відповідає `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`, → `::uuid`, інакше `NULL` (без помилки приведення; спека системної схеми §7.1). `EXECUTE` — ті самі `SESSION_ROLES`, що в шарі з «Користувачами»; гранти схеми `simetra` — рівно одним джерелом (`platformSchemaGrants`, без дубля зі станом застосування). Анонімна сесія провайдера (claim `is_anonymous` = `true`, факт T0 `IdentitySource.anonymousClaim: "is_anonymous"` для Supabase) — `NULL`: з «Користувачами» анонімних входів провізія не створює (`anonymousColumn`), тож без цього анонімний вхід отримав би права `everyUser`. Без джерела членства чи без факту провайдера функції немає, і права не генеруються (тихо, fail-closed: `rights.users-missing` при наявному джерелі членства не спрацьовує, а провайдер зараз один — Supabase — і факт має). Функція — без `ownerObjectId` (як функції прав), гранти схеми `simetra` дає `renderApplyState` (`schema/apply/state.ts`, вже для проєкту без «Користувачів»), шар їх не повторює. Недійсності користувача без «Користувачів» немає — відоме обмеження | §4.6: права без «Користувачів» — лише з прийнятим джерелом членства на провайдері, де id = `sub` | спека системної схеми §7 — речення про функцію без «Користувачів», зокрема анонімну сесію (Задача 0) |
| Р2d1-7 | Предикати генераторів: `hasRightsFunctions(contracts, provider)` = є `Role` і є функція поточного користувача (`contracts.users !== undefined` або умова Р2d1-6) — один експортований помічник `hasSessionUser`, з яким звіряються шар сесії, генератор прав і генератори політик (Р2a2-24); `hasVisibleUsers` = `hasRightsFunctions` ∧ є «Користувачі» ∧ (довідник членства ∨ джерело членства) | одне місце правди: політика не кличе функції, якої немає | немає |
| Р2d1-8 | `rights_visible_users()` — гілка на кожне джерело членства: користувачі рядків джерела, з'єднаних з `rights_my_scopes()` за (`scope_kind_id`, скоуп), з тією самою умовою активності, що Р2d1-3 | закриває борг «Межа Користувачів при членстві лише з прийнятого джерела»; без неї глобальна роль з `read` на «Користувачах» бачила б усіх | немає (§5.2) |
| Р2d1-9 | Попередження `rights.adopted-source-unsupported` видаляється; замість нього — попередження `rights.adopted-source-writes` на кожне джерело (вказівник `/membershipSources/<i>` чи `/assignmentSources/<i>`, лише коли в проєкті є `Role`) з текстом межі відповідальності: «платформа джерело лише читає; шляхи запису в нього — застосунку, і запобіжники прав на них не діють, доки таблиці прав не промотовано» (uk; en — той самий зміст) | §4.7: «план попереджає про це при оголошенні джерела»; попередження компілятора видно й у плані (`checkDiagnostics`) | немає |
| Р2d1-10 | Доступ до таблиці-джерела: роль застосування мусить мати `SELECT` на **кожній** таблиці-джерелі (`has_table_privilege`; інакше функції прав `SECURITY DEFINER` гучно падали б на кожному виклику); якщо на таблиці увімкнено RLS (`relrowsecurity`), роль застосування (`current_user` читальної транзакції — та сама, що `artifact.role` і власник згенерованих функцій) мусить мати права власника — `pg_has_role(current_user, relowner, 'USAGE')` (Postgres пропускає RLS для ролі з привілеями власника, зокрема успадкованими) — або `rolbypassrls` чи `rolsuper`; інакше відмова `plan.rights-source-access` з `{ tables: string }` (імена через кому, ліміт 20, як `OWNER_LIMIT`) і порадою передати власність кроком із дозволом. Таблиця без RLS — без вимоги | `SECURITY DEFINER` іде від власника функції; RLS обходить лише власник таблиці (без `FORCE`) чи роль з `BYPASSRLS`/суперкористувач — `BYPASSRLS` власника таблиці функції, якою володіє інша роль, нічого не дає | спека прав §4.7 — уточнення «власник таблиці-джерела — роль, від якої виконуються функції прав, або ця роль має `BYPASSRLS`» (Задача 0) |
| Р2d1-11 | Невідомі ключі ролей: план читає `DISTINCT` значення колонки `role` активних рядків кожного джерела призначень (під `row_security = off`) і попереджає `plan.rights-source-unknown-keys` `{ source, keys: string, more: number }` (`keys` — через кому) — ключі, яких немає в `sourceKeys` цього джерела, щонайбільше 20 на джерело, решта — кількістю. Дані таблиці, для якої Р2d1-10 відмовив, не читаються (читання впало б `42501` раніше за відмову); так само — таблиці, на цілі якої ще немає змапованої колонки `role` чи `active` (перевірка `pg_attribute`; колонку додасть DDL цього плану — читати нічого). Два джерела над однією таблицею бачать ключі одне одного невідомими — відоме обмеження; скіл радить окремі таблиці | §4.7: «план читає ці дані цілі й попереджає з переліком»; права з таких рядків і так не діють (Р2d1-4) | немає |
| Р2d1-12 | `FORCE ROW LEVEL SECURITY` таблиці-джерела план окремо не перевіряє: це вже помилка компілятора `rights.source-forced-rls` (`compiler/rights/checks.ts`), а гейт дрейфу тримає метадані рівними цілі | факт коду; друга перевірка — дубль | немає |
| Р2d1-13 | Модуль `schema/apply/rights-sources.ts`: `readRightsSourceFacts(tx, sources)` — одна читальна транзакція `dbs.reader` після 2а (`checkOwnerMembership`) і до тіні, один раз до розгалуження промоції (тож діє в обох гілках); таблиця, якої немає на цілі (`to_regclass` — `NULL`), пропускається. Імена — бажані: таблиця-джерело промоцією не перейменовується (промотована в вид таблиця — `rights.source-table`). Модуль розширить 2c2 (перевірки Рх20) | один читач даних цілі для прав; перевірки — до дорогих кроків | немає |
| Р2d1-14 | Версії прав, журнал і запобіжники §7 на прийнятих джерелах не діють (платформа на них нічого не ставить, §4.7); рядок у «Відомих обмеженнях» | рішення архітектора (Ф4) | немає |

## Відомі обмеження

- Запобіжники §7, версії прав і журнал на прийнятих джерелах не діють:
  платформа таблиці-джерела лише читає (§4.7, Р2d1-14). Зміна прийнятого
  членства чи призначення не підвищує версії прав (план 2c2) — клієнтський
  кеш прав для такого скоупу не інвалідовується сигналом.
- Без «Користувачів» немає недійсності користувача: видалений обліковий запис
  з чинним токеном лишається поточним користувачем до спливання токена.
- Кастомні ролі з прийнятого джерела (мапінг ресурсів і дій споживача) — після
  промоції таблиць прав (§4.7), не адаптером.
- Перейменування таблиці-джерела промоцією: мапінг змінюється тим самим
  кроком (логічне посилання), але промоція самої таблиці-джерела у вид дає
  `rights.source-table` — джерело мусить стати довідником членства.
- Ціну гілок джерел у `rights_mine` міряє гейт планів і бенчмарк 2d2.
- Два джерела призначень над однією таблицею бачать ключі одне одного
  невідомими (попередження плану); скіл радить окремі таблиці.
- Видалення застосунком рядка прийнятого членства, на який посилається
  призначення Simetra, відмовляє FK (Р2d1-5).

## Review Focus

1. **Учасник іншого виду чи тенанта з підлаштованим id:** рядок джерела призначень з `member` = id учасника іншого виду скоупу (чи учасника, що не є моїм) не вмикає ролі. Тест — Задача 5 (`source-cross-kind`, `source-not-mine`).
2. **Неактивний рядок і `NULL`:** `is_active = false`, `is_active IS NULL`, `user_id IS NULL` у членстві й `NULL` у колонці ролі чи учасника призначення — прав немає, без помилки. Тест — Задача 5 (`source-inactive`).
3. **Ключ ролі не того рівня чи невідомий:** ключ глобальної ролі в контейнерному джерелі не вмикає її; невідомий ключ — прав немає, план попереджає. Тест — Задача 2 (unit), Задача 5 (`source-wrong-level`, `source-unknown-key` — поведінкові), Задача 4.
4. **`sub` не uuid без «Користувачів»:** `current_user_id()` — `NULL` без помилки приведення, функції прав — порожні множини. Тест — Задача 5 (`no-users-subject`).
5. **Межа «Користувачів» із прийнятим членством:** учасник одного тенанта не бачить користувачів учасників іншого. Тест — Задача 5 (`source-visible-users`).

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
  - `codegen.test.ts` — тип `subject` довідника призначень `org` у згенерованих типах посилається на `Membership`.
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
  - `it("an assignment source joins the key and is typed by kind")` — гілка `assignments` контейнерного джерела: внутрішнє з'єднання з `rights_source_keys()` за (`source_id`, `role_key`), з `my_scopes` за (`scope_kind_id` = `org`, `member` = `member_id`), `container` = `project_id`; глобального — `member_id = (SELECT simetra.current_user_id())`, `scope` і `container` — `NULL`; контейнерне джерело з нескоупленим контейнером (`kitchen-sink.ts`, `partnerGrants` на `Partner`) — `member = (SELECT simetra.current_user_id())`, `scope` і `scope_kind_id` — `NULL`, `container` — колонка джерела.
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
- Test: `packages/simetra/src/compiler/__tests__/platform-layer.test.ts`

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

### Задача 4: перевірки плану над даними цілі

**Files:**
- Create: `packages/simetra/src/schema/apply/rights-sources.ts`
- Modify: `packages/simetra/src/schema/apply/plan.ts`, `schema/apply/index.ts` (лише якщо DB-тест імпортує через нього), `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/rights-sources.test.ts`, `plan.test.ts`, `compiler/__tests__/messages.test.ts`

**Interfaces:**
- Consumes: `CompiledModel.contracts.membershipSources`, `.assignmentSources`, `.roles` (`sourceKeys`).
- Produces:
  - `interface RightsSourceFacts { owners: { table: string; owned: boolean }[]; unknownKeys: { source: string; keys: string[]; more: number }[] }`;
  - `readRightsSourceFacts(tx: ApplyTransaction, input: { tables: QualifiedName[]; assignments: { source: string; table: QualifiedName; role: string; active?: string; keys: string[] }[] }): Promise<RightsSourceFacts>` — одна транзакція; дані — під `withLocalSettings(tx, [{ name: "row_security", value: "off" }], …)`;
  - `rightsSourceDiagnostics(facts: RightsSourceFacts): { refusal?: EngineDiagnostic; warnings: EngineDiagnostic[] }`;
  - коди `plan.rights-source-access` (`{ tables: string }`, помилка) і `plan.rights-source-unknown-keys` (`{ source, keys: string, more: number }`, попередження через `applyDiagnostic(…, "warning", …)`).

- [ ] **Step 1: Write the failing tests (unit, фейкова `ApplyTransaction` за зразком `plan.test.ts`):**
  - `rights-sources.test.ts`: `it.each` над `rightsSourceDiagnostics`: таблиця, якою роль не володіє (`owned: false`) → відмова з переліком; 25 таких → перелік з 20 і решта кількістю; усі `owned` → без відмови; невідомі ключі → одне попередження на джерело з `keys` і `more`.
  - `it("reads data with row security off and skips a missing or unowned table")` — журнал запитів фейку: читання ключів — після запиту `withLocalSettings` з параметрами (`row_security`, `off`) (імена й значення передаються масивами-параметрами, тож перевіряються параметри, а не текст SQL); таблиця з `to_regclass` = `NULL` і таблиця з `owned: false` — без запиту даних.
  - `plan.test.ts`: `it("refuses a plan when the apply role cannot bypass RLS of a source table")` — фейк відповідає `owned: false` → `status: "refused"`, код `plan.rights-source-access`, тінь не будувалася; `it("warns about unknown role keys in a source")` — план будується далі, попередження в `diagnostics`. Обидва кейси — і для гілки промоції (`it.each(["plan", "plan with a promotion"])`): перевірка йде до розгалуження.
  - `messages.test.ts` — нові коди.
- [ ] **Step 2:** Run: `pnpm --filter simetra test rights-sources plan messages` — FAIL.
- [ ] **Step 3: Implement** за Р2d1-10, Р2d1-11, Р2d1-13. SQL власника: `relrowsecurity`, `pg_has_role(current_user, relowner, 'USAGE')`, `rolbypassrls`/`rolsuper` ролі `current_user`, `has_table_privilege(current_user, <oid>, 'SELECT')` (усе `pg_catalog`-кваліфіковано). SQL ключів: `SELECT DISTINCT <role>::text FROM <таблиця> WHERE <role> IS NOT NULL [AND <active> IS TRUE]` з відсіюванням відомих ключів параметром-масивом. Коментар «чому» — `SECURITY DEFINER` від власника функції (Р2d1-10).
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

Причина DB-рівня (шапка файлу): що Postgres поверне з функцій прав під роллю `authenticated` для живих рядків прийнятих таблиць, що політики читання пропустять, що regex і приведення `sub` не кинуть, і що читання власника й даних цілі працює на справжньому каталозі.

- [ ] **Step 1: Write the test** — два описи, одне розгортання на опис (`describeTransaction`, Р2a1-18):
  - опис `adopted sources` над `adoptedSourcesDomain(adoptedCrossKind())`. Шар `adoptedSources()`: кладе SQL-файл функції множини `public.org_ids()` (`LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''`, `SELECT m.org_id FROM public.membership m WHERE m.user_id = (SELECT simetra.current_user_id()) AND m.is_active IS TRUE`) — межа тенанта поважає активність; прибирає вимір `region` (`accessDimensions: []`, `access: []` на `Task` і `TaskHours`) — його зв'язок `MemberRegion` прибрав `adoptedMembership()`; глобальне джерело — над окремою таблицею `GlobalGrant` (`globalGrantTable()`), щоб ключі одного джерела не були «невідомими» для іншого. Засів (увесь — у `beforeAll`; кейси лише читають через `queryAs`, тож порядок кейсів не впливає). «Порожньо» й «рівно права» в кейсах нижче — про рядки `rights_mine()` з `level <> 'everyUser'`: роль `Everyone` (`read@own` на «Користувачах») дає рядки кожному дійсному користувачу, і це не джерело. Засів: тенанти A і B, учасники `Membership` (активний u1 в A; активний u5 в A без рядків `RoleGrant` і без призначень; активний u7 в A; активний u9 в A; неактивний u2 в A; учасник з `is_active IS NULL` в A; u3 в B; рядок без `user_id`), проєкти P1 і P2 в A, проєкт P1 в A з задачею, `RoleGrant`: (u1-учасник, `lead`, P1), (u3-учасник, `lead`, P1) — учасник B на проєкті A, (u1-учасник, `nope`, P1), (u2-учасник, `lead`, P1), глобальний (u4-користувач, `support`). Кейси (`it.each`, `queryAs` під `authenticated`):
    - `source-scopes` — `rights_my_scopes()` u1: (`org`, A, учасник u1); u2 (неактивний) і рядок без користувача — нічого (кейс читає функцію напряму: межа тенанта `org_ids` теж поважає активність і маскувала б мутацію);
    - `source-container` — u1 читає задачу P1 (`read@any` контейнерної `ProjectLead`);
    - `source-not-mine` — `rights_mine()` u5 (учасник A без власних рядків джерела) порожня, хоч рядок `RoleGrant` (u1-учасник, `lead`, P1) лежить у тому самому тенанті; u3 (учасник B) задачі P1 не бачить;
    - `source-cross-kind` — користувач u6, єдине членство якого — рядок виду `team` (шар `adoptedCrossKind()`) з підлаштованими id: id рядка членства = id **неактивного** учасника u2 в A, id кореня `team` = A (Р2a1-26 — збіг обох); рядок `RoleGrant` (цей id, `lead`, P2) нічого не дає u2 (неактивний) — `rights_mine()` u6 порожня;
    - `source-inactive` — u2 (`is_active = false`) і учасник з `is_active IS NULL`: `rights_my_scopes()` і `rights_mine()` порожні (напряму, не через таблицю);
    - `source-unknown-key` — рядок з `nope` нічого не дає (u1 має рівно права `lead`); рядки `RoleGrant` з `role_key IS NULL` і з `member_id IS NULL` — нічого, без помилки;
    - `source-wrong-level` — засіяний рядок контейнерного джерела (u9-учасник, `support`, P1) нічого не дає (u9 — окремий учасник: u7 має призначення каталогу з `source-subject`) (поведінковий кейс без мутації: його тримає і з'єднання за `source_id`, і помилка компілятора `rights.source-key-level`; порівняння рівня в `typed` доводить unit-тест Задачі 2);
    - `source-global` — u4 має права `Support` (`has_right`);
    - `source-visible-users` — `rights_visible_users()` під u1 (напряму: межа `RESTRICTIVE` нічого не відкриває сама, а права читання «Користувачів» в u1 — лише `own`) містить u1 і u5, не u3 і не u2 (неактивний);
    - `source-subject` — призначення в довіднику `org` з `subject` = учасник `Membership` u7 діє (u7, а не u1 чи u5: `source-unknown-key` перевіряє рівно права `lead` у u1, `source-not-mine` — порожнечу в u5); засів призначення — через спільний будівник `insert` (`rights-seed.ts`), який після 2c2 вмикає режим обслуговування для системних довідників; FK відхиляє `subject` учасника B у довіднику A (`23503`); видалення рядка `Membership` u7, на якого посилається призначення, відмовляє `23503` (Р2d1-5);
    - `source-plan-facts` — `readRightsSourceFacts` через `rollbackDatabase(client)` (як `carrier-backfill.db.test.ts`): під роллю опису (`postgres`, власник) → `owned: true`, ключ `nope` — у `unknownKeys`; під `SET LOCAL ROLE <тегована NOLOGIN NOBYPASSRLS роль, не член власника, з SELECT на всі таблиці-джерела>` (через `testRoleName`) при увімкненому RLS таблиці (`ALTER TABLE … ENABLE ROW LEVEL SECURITY` у тій самій транзакції `rollbackDatabase` — фікстурна таблиця його не має) → `owned: false` і дані не читаються; `unknownKeys` перевіряється на наявність `nope` (рядок u9 з `support` теж туди потрапляє).
  - опис `without users` над `adoptedSourcesDomain(withoutUsers())`, власний засів (друге розгортання): тенант A, рядок `Membership` активного u1 (id користувача = uuid `sub`), проєкт P1 із задачею, рядок `RoleGrant` (u1-учасник, `lead`, P1): `no-users-subject` — claims з `sub` = uuid u1 → `current_user_id()` = u1 і задача P1 видна; `sub` = `"not-a-uuid"` → `NULL`, запит без помилки, рядків нуль; `anon` без `sub` → `NULL`.
- [ ] **Step 2:** Run: `pnpm --filter simetra exec vitest run --project db rights-sources` — PASS. **Мутаційний доказ** (вручну, без коміту), кожна мутація червонить свій кейс і саме на цільовій умові, а не на RLS межі тенанта чи FK:
  - прибрати `IS TRUE` активності в `rights_my_scopes` → `source-scopes`/`source-inactive` (`rights_my_scopes()` і `rights_mine()` u2 стають непорожніми; кейси читають функції напряму, бо межа тенанта `org_ids` теж поважає активність);
  - прибрати умову `s.member = src.<member>` у з'єднанні гілки джерела з `my_scopes` → `source-not-mine` на твердженні про u5 (рядок u1-учасника стає «своїм» для u5 у тому самому тенанті; для u3 рядок не проходить `held` за скоупом, тож тверджень про u3 мутація не червонить);
  - прибрати типізацію за видом (`s.scope_kind_id = <K>`) → `source-cross-kind`;
  - прибрати regex у `subjectUserFunction` → `no-users-subject` (помилка `22P02`);
  - прибрати гілку джерела з `rights_visible_users` → `source-visible-users`.
- [ ] **Step 3: Commit**

```bash
git add packages/simetra/test/db
git commit -m "test(rights): прийняті джерела на живих рядках"
```

---

### Задача 6: скіл, гейти й заміри

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/references/people-and-rights.md`, `docs/ROADMAP.md`, цей план (позначки)

- [ ] **Step 1:** Скіл споживача (англійською): прийняте членство й призначення дають права; учасник — одноколонковий uuid-ключ; `UNIQUE (scope, id)` у метаданих таблиці для системних довідників; `sourceKeys`; роль застосування має володіти таблицею-джерелом з RLS чи мати `BYPASSRLS`; запобіжники й версії на джерелах не діють; без «Користувачів» — `sub` як uuid; видалити учасника прийнятого членства, на якого посилаються платформні призначення, — спершу зняти призначення (інакше `23503`). Речення про попередження `rights.adopted-source-unsupported` прибрати.
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
- Учасник і призначення прийнятих джерел дають права лише в межах свого виду, тенанта, рівня й активності (Задача 5, мутації).
- Без «Користувачів» на Supabase права працюють від `sub`; `sub`, що не є uuid, — `NULL` без помилки (Задачі 3, 5).
- План відмовляє `plan.rights-source-access` і попереджає `plan.rights-source-unknown-keys` в обох гілках (Задача 4).
- Спека прав §4.7, спека системної схеми §7 і борг §5 оновлені (Задача 0).
