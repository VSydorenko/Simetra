# Права-2a2: політики читання й денормалізовані носії — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: прийнято архітектором задачі 2026-10-18 після трьох раундів аудиту; аудит Codex проведено, знахідки внесено.
Архітектор задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** читання таблиць виду визначають права. Межа тенанта стає
`RESTRICTIVE`-політиками, права — `PERMISSIVE`-політиками за формами обсягу з
будівника умов 2a1, видимість «Користувачів» — власною межею. Рядки ТЧ і носії
через шлях (Рх21) несуть денормалізовані копії носіїв, які пише лише платформа
і поширення яких не є зміною змісту рядка. Приклад і тести переходять на ролі.

**Архітектура:**

- **T1** (`packages/simetra/src/compiler`): копії носіїв у фізичному знімку
  (`stages/model.ts`, `PhysicalColumn.origin.copyOf`); генератор `carriers`
  (`compiler/rights/carrier-units.ts`) — тригери виведення й поширення;
  механіка й тригери підписок не реагують на зміну лише копій;
  `access-units.ts` — політики межі тенанта, видимості «Користувачів» і прав
  читання; перевірки обробника підписки; попередження на вид скоупу.
- **T2** (`packages/simetra/src/schema/apply`): відмова плану
  `plan.carrier-backfill-missing` (звичайний план і промоція);
  `promotion/access.ts` — `RESTRICTIVE`-політика доступу не відкриває.
- **Тести й приклад:** `expectClean` у `__tests__/helpers.ts`, хвиля перевірок
  діагностик, ролі в `examples/reference` і в DB-фікстурах, кейси двох сесій —
  у тіні двигуна (`inTarget`, designer).

**Стек:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query (WASM),
локальний стек Supabase (Postgres 17).

**Спека:** [спека прав](../specs/2026-10-17-rights-design.md) — читати повністю,
головне Рх11, Рх21, §5.2, §5.4, §8, Додаток А; [спека системної схеми й
користувачів](../specs/2026-10-07-system-schema-users-design.md) §12 («Видимість
Користувачів»); [спека промоції](../specs/2026-10-06-promotion-design.md) §8,
§9.3; [платформна спека](../specs/2026-09-24-simetra-platform-design.md) §6.7,
§6.8, Р24. Плани [Права-1a](2026-10-18-rights-1a-carriers-contract.md),
[Права-1b](2026-10-18-rights-1b-sets-roles.md),
[Права-2a1](2026-10-18-rights-2a1-command-role-functions.md),
[П3-3a1](2026-10-15-p3-3a1-access.md), [П3-3a2](2026-10-16-p3-3a2-triggers.md) — їхні таблиці рішень діють.

**Залежність:** Права-2a1 виконано: є `PLATFORM_ROLES`, роль `simetra_command`
на стеку, функції `simetra.rights_*`, `has_right`, `rights_my_scopes`,
`rightsPredicates` і `renderCondition` (`compiler/rights/predicates.ts`),
`RightsContract.system`, `Contracts.rightsCatalogs`, системні довідники у
`withRoles`, `singleTenantRights`, `signUp` у `test/db/auth.ts`. Форми 2a1 тут —
дані: зміна їх — розвилка архітектору (єдине уточнення — Р2a2-18). Перед
стартом — `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-18-rights-2a2-read-policies-carriers.md`.

## Global Constraints

- Усі обмеження планів Права-1a, 1b і 2a1 (розділи «Global Constraints») діють і тут; уточнення одного з них — Р2a2-18.
- 🔴 `pnpm --filter <pkg> test <pattern>` — **без** `--` перед шаблоном.
- 🔴 Кожна умова політики прав — з `rightsPredicates`/`renderCondition` 2a1; власних форм предиката тут немає. Предикат межі тенанта — лише `<носій скоупу> = ANY (ARRAY(SELECT <функція множини скоупу>()))` (платформна спека §6.8), межі «Користувачів» — `id = ANY (ARRAY(SELECT "simetra"."rights_visible_users"()))`.
- 🔴 Ролі в `TO` — лише через `PROVIDER_API_ROLES[provider]` і `PLATFORM_ROLES`; `anon` у політиках прав і межі не буває.
- 🔴 Копії носіїв пише лише платформа: значення з запиту тригер ігнорує; копія без FK (FK тримає власник), з індексом, де скоуп першим.
- 🔴 Функції носіїв — `LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''`, кваліфіковані відношення, у запит нічого не повертають, крім `NEW`.
- 🔴 Зміна лише копій носіїв — не зміна змісту рядка: не підвищує `version`/`updated_at` і не запускає підписок (Р2a2-19).
- 🔴 Між задачами гейти не червоні: зміна, що ламає тест, і правка цього тесту — в одному коміті (виняток — окремий коміт хвилі `test: …`, Р2a2-16).
- Гранти таблиць не змінюються: ролі запиту — `SELECT`, `simetra_command` — нічого (DML і `SELECT` ролі команд — П4).
- DB-тест — лише для того, що вирішує Postgres; SQL-текст — unit. Скіл `.agents/skills/writing-tests/SKILL.md` обов'язковий.
- Репо публічне: приклади й фікстури — синтетичні.

## Рішення плану

Розвилки Ф1–Ф5 і знахідки першого раунду аудиту (D1–D15) вирішив архітектор
задачі 2026-10-18.

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р2a2-1 | Межа тенанта — `RESTRICTIVE`: `<t>_scope_read` (`FOR SELECT`), `<t>_scope_insert` (`WITH CHECK`), `<t>_scope_update` (`USING` і `WITH CHECK`), `<t>_scope_delete` (`USING`), усі `TO authenticated, simetra_command`; основна таблиця кореня скоупу не має `<t>_scope_insert` (скоуп нового кореня — його власний `id`; межу нового тенанта дасть право створення кореня, П4). Одна `<t>_scope_write` неможлива (одна команда на політику), а `FOR ALL` зачепив би `SELECT` об'єкта з `publicRead`. Нинішня `<t>_read` П3-3a1 — це `<t>_scope_read` | спека прав §5.2 — імена й виняток кореня (Задача 0) |
| Р2a2-2 | Права читання — `PERMISSIVE FOR SELECT TO authenticated, simetra_command`, по політиці на кожен предикат `rightsPredicates(contract, "read", table)`: `<t>_read_any`, `<t>_read_own` (кілька носіїв власності — `<t>_read_own_<колонка>`), `<t>_read_<вимір snake_case>`, `<t>_read_in_<мітка контейнера>_<any \| own \| вимір>`; імена — `makeObjectName(<t>, undefined, <мітка>)`, де мітка не довша за 40 байтів: довшу мітку цілком замінюють її першими 31 байтом, `_` і 8 hex-знаками `sha256` повної мітки; `read_in_<c>_own` з кількома носіями власності отримує ще `_<колонка>`. Генеруються, лише коли в проєкті є `Role` (функції прав є, Р2a1-15) і в об'єкта є контракт прав | немає |
| Р2a2-3 | Об'єкт із `publicRead` не має `<t>_scope_read` і `<t>_read_*` (усі рядки й так видно), але має політики межі запису | немає (§5.2) |
| Р2a2-4 | ТЧ — політики власника за копіями носіїв і власною колонкою скоупу (у ТЧ кореня — `parent_id`); носій-ключ (`ownership: ["ref"]` → `id` власника) копії не має — предикат ТЧ іде за `parent_id`. Похідні таблиці регістра — `any` за власною колонкою скоупу, вимір — за копією виміру (`origin.elementId` виміру рухів). Носій `access` регістра поза виміром регістра чи шляхом — помилка `rights.register-access-dimension`; мапінги шляху на регістрах `kitchen-sink.ts` (`Prices`, `Stock`) знімаються, форма шляху лишається на об'єктах | немає (§5.2 «на вимірах регістра — рухи й підсумки») |
| Р2a2-5 | Копія носія — колонка з `origin.copyOf = { table, column, through }`: значення бере з `table.column` рядка, на який указує локальна колонка `through`. Копія ТЧ — ім'я колонки власника, `through: "parent_id"`; копія шляху на основній таблиці — `makeObjectName(<колонка першого кроку>, undefined, <колонка цілі>)`, `through` — колонка першого кроку; ТЧ об'єкта з носієм шляху копіює копію шляху власника. Збіг імені копії з колонкою таблиці — `rights.carrier-column-taken`. Тип — тип колонки джерела, nullable, без FK; індекс (скоуп, копія), у ТЧ кореня — (`parent_id`, копія) | немає |
| Р2a2-6 | `CarrierContract.value: string` — колонка основної таблиці з кінцевим значенням носія (для прямого носія — `column`, для шляху — копія); `rightsPredicates` на основній таблиці бере `value`, на ТЧ — копію з `copyOf.column === value` власника (носій-ключ — `parent_id`), на похідній таблиці — колонку з тим самим `origin.elementId` | немає (розширення контракту 1a, форми 2a1 не змінюються) |
| Р2a2-7 | Генератор `carriers`. На кожну таблицю з копіями — функція й `BEFORE INSERT OR UPDATE` тригер `<t>_simetra_carriers`: на `INSERT` (і на `UPDATE`, де змінилися `through` чи скоуп) — `SELECT … INTO NEW.<копії> FROM <джерело> WHERE <скоуп> = NEW.<скоуп> AND <ключ> = NEW.<through> FOR SHARE`; на решті `UPDATE`: якщо `NEW.<копія> IS NOT DISTINCT FROM OLD.<копія>` — лишити, інакше перевивести звичайним `SELECT` джерела без `FOR SHARE` (поширення — теж `UPDATE`: його значення дорівнює джерелу в тій самій транзакції й виживає, підроблене — замінюється; блокування власника немає, тож `UPDATE` рядка ТЧ проти `UPDATE` власника не дає `40P01`). Жодних прапорців GUC чи `pg_trigger_depth()`. Значення з запиту ніколи не стає копією. На кожну таблицю-джерело — функція й два тригери на ній (тригер має одну умову `WHEN` на всі події, а `INSERT`-тригер не може посилатися на `OLD`): `<t>_simetra_carriers_out_insert` — `AFTER INSERT` без `WHEN` ( залежний рядок, записаний раніше за джерело в тому самому операторі, — CTE `WITH a AS (INSERT INTO task …) INSERT INTO task_checklist …` чи самопосилання в багаторядковому `INSERT`, — інакше лишився б з копією `NULL`; FK не `DEFERRABLE`, але перевіряється в кінці оператора; і `<t>_simetra_carriers_out` — `AFTER UPDATE … WHEN (OLD.<c> IS DISTINCT FROM NEW.<c> …)` за **кожною колонкою, яку читає будь-який `copyOf`** (зокрема копією: ТЧ копіює копію шляху власника), що оновлює залежні рядки `WHERE <скоуп> = NEW.<скоуп> AND <through> = NEW.<ключ> AND <копія> IS DISTINCT FROM NEW.<c>`. Двоходова зміна (джерело → копія → копія ТЧ) і самопосилання сходяться: `IS DISTINCT FROM` не пише незмінене, тож кожен крок закінчується | немає |
| Р2a2-8 | Функції носіїв — `SECURITY DEFINER`: `FOR SHARE` вимагає права `UPDATE`, а той, хто пише, може не мати права читати джерело. Безпечно, бо значення копії береться лише з рядка, на який уже вказує складений FK у тому самому скоупі (ТЧ — `(скоуп, parent_id)`, шлях — `(скоуп, перший крок)`), і в запит функція нічого не віддає, крім `NEW` з виведеними копіями | немає |
| Р2a2-9 | Незалежність від порядку тригерів — за прецедентом П3-3a2 (заборони, а не імена). На основній таблиці з копією шляху обробник `beforeWrite` не присвоює копії й колонки першого кроку (`subscription.handler-assigns-carrier`, підказка — присвоєння в хук команди, П4) і не читає копії прямим `NEW.<копія>` (`subscription.handler-reads-carrier`: новий обхід `PlpgsqlStatement.expressions` — аналізатор П3-3a2 обходить лише присвоєння). Читання всього запису (`to_jsonb(NEW)`, `NEW.*`, передача `NEW` у функцію) не забороняється — звичайний патерн журналу; обмеження в спеці й скілі: на `INSERT` до тригера носіїв копії в `NEW` — значення запиту, на них не покладаються. Підписок на таблицях ТЧ не буває (`subscriptionSourceTables`), а копія не резолвиться за логічним іменем у `whenChanged` (вже `subscription.when-changed-unknown`), тож окремого коду для `whenChanged` немає | спека прав §5.2 — речення «обробник `beforeWrite` не присвоює копій носіїв і колонки першого кроку шляху й не читає копій прямо (як колонок механіки, спека промоції §9.3); у записі `NEW` на `INSERT` копії до тригера носіїв — значення запиту» (Задача 0) |
| Р2a2-10 | Ціль кроку шляху — об'єкт виду: шлях через `CustomTable` (можливий в однотенантному проєкті) — `rights.carrier-path-adopted` (тригер поширення лежав би на прийнятій таблиці) | Рх21 — «ціль кроку шляху — об'єкт виду» (Задача 0) |
| Р2a2-11 | `plan.carrier-backfill-missing`: колонка-копія бажаного стану **не є живою копією** — у знімку marker цілі (`state.marker.snapshot`) ця колонка не має `copyOf` з тим самим джерелом (одна лише наявність колонки з тим самим ім'ям не рахується: видалений реквізит ТЧ `assignee_id` з даними й нове `ownership` власника дали б старі значення за копію), таблицю не створює цей план (множина — з `actions[].produces` плану двигуна з префіксом `table:`, бо `classifySteps` її не повертає), і в ній є рядок (`EXISTS` під `row_security = off`, як `DATA_SETTINGS`: на таблиці з `FORCE ROW LEVEL SECURITY` без обходу — гучний збій, а не тихий нуль). Спільний помічник T2 для звичайного плану й промоції (у промоції — за старими іменами `tablesNewToOld`; прийнята колонка з тим самим ім'ям — не копія). Справжній крок даних — план 2b | спека прав §5.2 — «до кроку даних — відмова плану» (Задача 0; прибере 2b) |
| Р2a2-12 | `addedRoles` (`promotion/access.ts`) бере лише `PERMISSIVE` нові політики: `RESTRICTIVE` доступу не відкриває. Форма заміни прийнятої політики (`REPLACEMENT_SHAPES.policy`) не змінюється: прийняте читання замінює лише `PERMISSIVE`-політика прав, тож у проєкті без ролей (і для об'єкта без права `read` у жодній ролі) промоція дає `plan.platform-replacement-missing` | немає |
| Р2a2-13 | Попередження `rights.scope-kind-unread` на `project.meta.json` `/scopeKinds/<i>`, завжди: вид має скоуплені об'єкти з контрактом прав, а жоден рядок проєкції (з розгорнутим `fullAccess`) не має `read` на жоден із них; вид без членства потрапляє сюди сам, вид лише з `CustomTable` — ні. Текст — наслідок: «об'єкти виду X не читає жодна роль» | спека прав §8 п.2 — «попередження на вид скоупу» (Задача 0) |
| Р2a2-14 | Ім'я виміру `any`, `own`, з префіксом `own_` чи `in_` — `rights.dimension-name-reserved` (ім'я політики `<t>_read_<вимір>` збіглося б з формою обсягу) | немає |
| Р2a2-15 | Попередження прийнятих джерел (Р2a1-21) лишається до 2d, без відмови плану: блок Права-2 іде до раннього зрізу П4 і першої міграції (платформна спека §12), тож проміжний стан на базу споживача не потрапляє | немає |
| Р2a2-16 | `expectClean(result, { allow?: readonly RuleCode[] })` у `__tests__/helpers.ts` — помилок немає, кожне попередження має код з `allow` (лише явні коди). Хвиля (окремий коміт `test: …`) іде **першою**: реєструє код `rights.scope-kind-unread` (`RuleCode`, `WARNING_RULES`, `MESSAGES`) без випуску й переводить на `expectClean(…, { allow: ["rights.scope-kind-unread"] })` перевірки `diagnostics).toEqual([])` над скоупленими фікстурами без ролей; наступний коміт випускає попередження — гейти зелені між ними. Тести, що чекають конкретного попередження, лишають точне очікування | немає |
| Р2a2-17 | DB-сценарій політик — одне розгортання на опис (`rights-policies.db.test.ts`). Кейси двох сесій (блокування `FOR SHARE` на `INSERT`, `UPDATE` ТЧ проти `UPDATE` власника без `40P01`) — у designer (`carrier-locks.db.test.ts`) через `inTarget`: тінь двигуна має базовий стан провайдера, у ній можна комітити, а об'єкти відкритої транзакції сценарію друга сесія не бачила б | немає |
| Р2a2-18 | Видимість «Користувачів» (спека системної схеми §12): у проєкті з довідником членства **і хоч однією `Role`** (без ролей «Користувачів» через права однаково ніхто не читає, тож гейти між Задачами 5 і 9 лишаються зеленими) генерується `simetra.rights_visible_users() RETURNS SETOF uuid` (`STABLE SECURITY DEFINER`, `EXECUTE` — user, service, command) = я ∪ користувачі учасників моїх скоупів, і `RESTRICTIVE FOR SELECT` політика `<t>_scope_read` на **кожній** таблиці «Користувачів»: основній — `id = ANY (ARRAY(SELECT "simetra"."rights_visible_users"()))`, ТЧ — `parent_id = ANY (…)`. Мої скоупи вона бере з `rights_my_scopes()`, а таблиці членства читає лише за ними — за парою (вид скоупу, скоуп): учасники довідника членства виду K — лише для рядків `rights_my_scopes()` з `scope_kind_id = K` (Р2a1-26) — уточнення обмеження 2a1 «жодна інша функція не читає таблиць членства»: «мої скоупи обчислює лише `rights_my_scopes`; інші функції читають членство лише за скоупами з неї» (закріплення Рх22 і далі змінює одне місце). Власної функції застосунку поле метаданих ще не має — з першим запитом застосунку | спека прав §5.2 — рядок про «Користувачів» (Задача 0) |
| Р2a2-19 | Поширення копій — не зміна змісту рядка (скасовує раніше прийняте «`version` залежного рядка піднімається»): придушується лише зміна, що торкнулася копій і нічого більше: умова `contentChangeCondition` = `(<зміст змінився>) OR NOT (<копії змінилися>)`, де «зміст» — колонки поза механікою, копіями й генерованими (`BEFORE`-`WHEN` не посилається на `NEW` генерованих колонок, а вони випливають зі змістових). Звичайне перезбереження без змін поводиться як на будь-якій таблиці (`version` росте, підписки спрацьовують), поширення придушене за будь-якого порядку `BEFORE`-тригерів (воно пише лише копії). Запит, що змінив лише копії, — це перезбереження: тригер носіїв повертає джерельне значення, тож `version` росте, а спрацювання підписки на ньому не визначене (залежить від порядку імен); обробник на копії не покладається (Р2a2-9), доступу запит не дає. На основній таблиці з копіями шляху механіка розділяється на `<t>_simetra_touch` (`BEFORE INSERT`) і `<t>_simetra_touch_update` (`BEFORE UPDATE … WHEN (<contentChangeCondition>)`); тригер підписки без `whenChanged` — на `<name>` (`UPDATE … WHEN (<contentChangeCondition>)`) і `<name>_insert` (`INSERT`), факт копій передається в `subscriptionTriggerNames`, перевірка довжини імені `_insert` — і для цього випадку; з `whenChanged` лишається наявний `WHEN` (копій і механіки там бути не може). Інакше перепризначення задачі дало б хибні конфлікти версій на всіх коментарях (Р24), а обробники спрацьовували б від імені власника таблиці на зміні, якої ніхто не робив | спека прав §5.2 (речення про поширення: «поширення копій платформою»; запит лише з копіями — перезбереження), спека промоції §9.3 (правило механіки поширюється на копії) (Задача 0) |
| Р2a2-20 | Промоція й зворотна генерація впізнають нові форми: `contentChangeCondition` у формах заміни тригера (`promotion/replacements.ts`) еквівалентний «без `WHEN`»; `<t>_simetra_touch_update` і одиниці носіїв (зокрема `<t>_simetra_carriers_out_insert`) — платформні в `isMechanics` і розпізнавачах зворотної генерації | немає |
| Р2a2-21 | Підтримувана ізоляція шляху запису — `READ COMMITTED`, як у запобіжниках §7: носії узгоджуються в ній; інша ізоляція шляхом запису платформи не підтримується (П4 `runCommand` відкриває `READ COMMITTED`) | спека прав §5.2 — речення про ізоляцію (Задача 0) |
| Р2a2-23 | Кожен платформний запобіжник `BEFORE UPDATE`, зокрема майбутній тригер незмінності проведеного (М22, `PostingContract.immutability`), ігнорує зміну, що торкнулася лише копій (`contentChangeCondition`): інакше він заблокував би поширення в проведений документ | спека прав §5.2, спека промоції §9.3 (Задача 0); рядок боргу для генератора незмінності |
| Р2a2-22 | Імена функцій носіїв — у `derivedFunctions`, тож колізію ловить `functionCollisions` (`physical.function-duplicate`), як для функцій членства | немає |

## Відомі обмеження

- Межу тенанта на запис DB-сценарій 2a2 не перевіряє: DML жодна роль застосунку
  ще не має; її перевіряє 2b разом із політиками запису.
- Нова колонка-копія на таблиці з рядками — відмова плану до кроку даних 2b.
- Попередження прийнятих джерел лишається до 2d; між 2a2 і 2d проєкт із
  джерелами не застосовується до бази споживача (порядок платформної спеки §12).
- Власна функція видимості «Користувачів» застосунку — з першим запитом
  застосунку (поля метаданих немає).
- Розгалуження поширення (сотні тисяч рядків ТЧ під одним власником) міряє
  бенчмарк 2d; гейт планів на даних помітного обсягу — теж 2d.
- Віртуальних таблиць регістрів немає (борг §5, Р-В).
- Генератора незмінності проведеного ще немає: коли з'явиться, його `BEFORE UPDATE` бере `contentChangeCondition` (Р2a2-23; рядок у борг §5).

## Review Focus

1. **Учасник одного тенанта бачить користувачів іншого:** «Користувачі» видно лише свої й учасників моїх скоупів. Тест — Задача 10 (`users-cross-tenant`).
2. **Старі дані під іменем копії:** колонка з тим самим ім'ям, що не була копією (видалений реквізит ТЧ, прийнята колонка промоції), — відмова плану, а не «копія вже є». Тест — Задача 4.
3. **Поширення копій без побічних ефектів:** зміна носія власника чи цілі шляху оновлює копії залежних рядків і копії їхніх ТЧ (двоходово), не змінює `version` залежних рядків і не викликає їхніх підписок. Тест — Задача 10 (`propagation-*`).
4. **Дві сесії:** вставка рядка ТЧ чекає на блокування власника; `UPDATE` рядка ТЧ і `UPDATE` власника одночасно не дають `40P01`, копія узгоджена. Тест — Задача 10 (`carrier-locks.db.test.ts`).
5. **Підроблена копія:** рядок, вставлений з чужим значенням копії, отримує значення з джерела. Тест — Задача 10 (`forged-copy`).

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/model/physical/snapshot.ts` | `PhysicalColumn.origin.copyOf` |
| `packages/simetra/src/compiler/stages/model.ts` | копії носіїв ТЧ і шляху, індекси |
| `packages/simetra/src/compiler/contracts.ts`, `compiler/rights/carriers.ts`, `compiler/rights/contracts.ts` | `CarrierContract.value` |
| `packages/simetra/src/compiler/rights/checks.ts` | `rights.carrier-column-taken`, `rights.carrier-path-adopted`, `rights.register-access-dimension`, `rights.dimension-name-reserved` |
| `packages/simetra/src/compiler/rights/carrier-units.ts` (новий) | генератор `carriers` |
| `packages/simetra/src/compiler/{mechanics-units,subscription-units}.ts` | механіка й підписки не реагують на зміну лише копій |
| `packages/simetra/src/compiler/rights/predicates.ts` | предикати ТЧ, шляху й похідних таблиць |
| `packages/simetra/src/compiler/rights/functions.ts` | `rights_visible_users` |
| `packages/simetra/src/compiler/access-units.ts` | політики межі тенанта, «Користувачів» і прав |
| `packages/simetra/src/compiler/stages/links.ts` | заборони обробника на копії |
| `packages/simetra/src/compiler/rights/scope-kind-warnings.ts` (новий) | `rights.scope-kind-unread` |
| `packages/simetra/src/compiler/{sql/units,pipeline,diagnostics,messages}.ts` | генератор, коди |
| `packages/simetra/src/schema/apply/carrier-backfill.ts` (новий), `plan.ts`, `promotion/access.ts` | відмова backfill, `addedRoles` |
| `packages/simetra/src/compiler/__tests__/helpers.ts` | `expectClean` |
| `packages/simetra/src/compiler/__tests__/fixtures/{rights,kitchen-sink}.ts` | `policyDomain()`; регістри `kitchen-sink` без шляху |
| `examples/reference/metadata/**` | ролі, набір прав, системні довідники |
| `packages/simetra/test/db/{rights-policies,access}.db.test.ts`, `packages/designer/src/__tests__/carrier-locks.db.test.ts`, `packages/designer/src/schema-engine/__tests__/engine-desired-corpus.db.test.ts` | DB-сценарії |
| `packages/designer/skills/simetra-metadata/SKILL.md` | копії носіїв, заборони обробника, політики |

Фікстура `policyDomain(overrides?)` у `fixtures/rights.ts` — шар поверх
`withRoles`: `Task` з `ownership: ["assignee"]`, `access` на `region`,
`containerBinding: "project"` і ТЧ `checklist` (реквізит `note`); `TaskComment`
з `ownership: [["task", "assignee"]]` (шлях) і ТЧ `attachments` (реквізит
`label`, другий крок копії); регістр накопичення `TaskHours` (`Balance`, вимір
`region` → `Region`, ресурс `hours`) з `access` на `region`; набір
`TaskReaders` — `read@any` на `Task`, `TaskComment`, `TaskHours` і «Користувачах»;
роль `Everyone` — `read@own` на «Користувачах»; вимір
`region` (`regionDimension()`); «Користувачі» з `ownership: ["ref"]` і ТЧ
`devices`; підписка `onWrite` на `TaskComment` (обробник пише рядок у службову
таблицю лічильника); документ `TaskReport` з `ownership: [["task", "assignee"]]`
(носій шляху) і типовою нумерацією з періодичністю (генерована колонка
періоду номера). Експорти: `CHECKLIST_TABLE`, `COMMENT_TABLE`,
`ATTACHMENTS_TABLE`, `HOURS_TABLES`.

---

### Задача 0: правки спек

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (Рх21, §5.2, §8)
- Modify: `docs/superpowers/specs/2026-10-06-promotion-design.md` (§9.3)
- Modify: `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` (§5)

- [ ] **Step 1:** Рх21 — «ціль кроку шляху — об'єкт виду (шлях через прийняту таблицю — помилка)».
- [ ] **Step 2:** §5.2:
  - перший пункт: `<t>_scope_write` → «`<t>_scope_insert` (`WITH CHECK`), `<t>_scope_update` (`USING` і `WITH CHECK`), `<t>_scope_delete` (`USING`); основна таблиця кореня скоупу не має `<t>_scope_insert`: межу нового тенанта дає право створення кореня»;
  - пункт ТЧ: після речення про тригер — «обробник `beforeWrite` не присвоює копій носіїв і колонки першого кроку шляху й не читає копій прямо (як колонок механіки, спека промоції §9.3); у записі `NEW` на `INSERT` копії до тригера носіїв — значення запиту; поширення копій платформою — не зміна змісту рядка: не підвищує версію й не запускає ні підписок, ні платформних запобіжників `BEFORE UPDATE` (зокрема незмінності проведеного); запит, що змінив лише копії, — перезбереження (копії відновлено, версія росте, спрацювання підписки не визначене); носії узгоджуються в `READ COMMITTED` — інша ізоляція шляхом запису платформи не підтримується»; речення про крок даних — дописати «до кроку даних (план Права-2b) — відмова плану»;
  - новий пункт: «„Користувачі“ в проєкті з членством і ролями — `RESTRICTIVE`-межа на основній таблиці й ТЧ за множиною „я + користувачі учасників моїх скоупів“ (спека системної схеми §12); роль рівня скоупу читає лише їх».
- [ ] **Step 3:** §8 п.2 — «проєкт з видом скоупу без жодної ролі — попередження компілятора» → «вид скоупу, об'єктів якого не читає жодна роль, — попередження компілятора».
- [ ] **Step 3a:** Борг `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` §5 — рядок «**Генератор незмінності проведеного** (М22) — `BEFORE UPDATE` ігнорує зміну, що торкнулася лише копій носіїв (`contentChangeCondition`, Р2a2-23)».
- [ ] **Step 4:** Спека промоції §9.3 — після правила про колонки механіки: «те саме — для копій носіїв прав (спека прав §5.2): обробник їх не присвоює й не читає прямо, а поширення копій платформою не запускає ні механіки, ні підписок, ні будь-якого платформного запобіжника `BEFORE UPDATE` (зокрема незмінності проведеного); запит, що змінив лише копії, — перезбереження».
- [ ] **Step 5:** Run: `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md
git commit -m "docs(spec): межа тенанта трьома політиками, видимість Користувачів і копії носіїв"
```

---

### Задача 1: копії носіїв у фізичному знімку

**Files:**
- Modify: `packages/simetra/src/model/physical/snapshot.ts`, `compiler/stages/model.ts`, `compiler/contracts.ts`, `compiler/rights/{carriers,contracts,checks}.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`, `compiler/__tests__/fixtures/kitchen-sink.ts`
- Test: `packages/simetra/src/compiler/__tests__/rights-carrier-copies.test.ts` (новий)

**Interfaces:**
- Produces: `PhysicalColumn.origin.copyOf?: { table: QualifiedName; column: string; through: string }`; `CarrierContract.value: string`; коди `rights.carrier-column-taken` (`{ table, column }`), `rights.carrier-path-adopted` (`{ attribute }`), `rights.register-access-dimension` (`{ attribute }`), `rights.dimension-name-reserved` (`{ name }`).

- [ ] **Step 1: Write the failing tests (unit)** над `policyDomain()`:
  - `it("copies every owner carrier into each tabular section")`: таблиця `task_checklist` має колонки `assignee_id`, `region_id`, `project_id` з `origin.copyOf = { table: task, column: <та сама>, through: "parent_id" }`, nullable, без FK; індекси `(org_id, assignee_id)`, `(org_id, region_id)`, `(org_id, project_id)`.
  - `it("denormalizes a path carrier into the object row and its tabular sections")`: `task_comment` має копію `makeObjectName("task_id", undefined, "assignee_id")` з `copyOf = { table: task, column: "assignee_id", through: "task_id" }` і індекс (скоуп, копія); `task_comment_attachments` копіює цю копію (`copyOf.table: task_comment`); `contracts.rights` запису `TaskComment` — `ownership[0].value` дорівнює імені копії, у `Task` — `value === column`.
  - `it("the policy domain compiles clean")`: `expectClean(await compileRights(policyDomain()))` без `allow` (інструмент — Задача 7; до неї — перевірка, що помилок і попереджень немає).
  - `it("a key carrier has no copy in tabular sections")`: «Користувачі» з `ownership: ["ref"]` — таблиця `users_devices` без копії носія.
  - `it.each` помилок:

| case | перевизначення | код (pointer) |
| --- | --- | --- |
| `column-taken` | ТЧ `checklist` з реквізитом `assignee` | `rights.carrier-column-taken` |
| `path-adopted` | `singleTenantRights()` з шляхом через `CustomTable` | `rights.carrier-path-adopted` на `/ownership/0/0` |
| `register-not-dimension` | `TaskHours` з `access` на ресурсі чи реквізиті | `rights.register-access-dimension` |
| `register-path` | `TaskHours` з `access` через шлях | `rights.register-access-dimension` |
| `dimension-reserved` | вимір проєкту з ім'ям `any`, `own`, `ownRegion`, `inProject` | `rights.dimension-name-reserved` |

- [ ] **Step 2:** Run: `pnpm --filter simetra test rights-carrier-copies` — FAIL.
- [ ] **Step 3: Implement:** у `SnapshotBuilder` — після стандартних колонок ТЧ і основної таблиці поля-копії з `origin.copyOf` і `indexed` зі `indexWithin` скоупу (той самий шлях `addField`); `resolveCarrier` заповнює `value`; перевірки — у стадії 4 поруч із наявними `rights.*`; тексти en/uk. У `kitchen-sink.ts` прибрати мапінги `{ ref: ["item", "owner"], dimension: "partner" }` з регістрів `Prices` і `Stock` (на `Item` і `Sale` шлях лишається — ратчет бачить його там).
- [ ] **Step 4:** Run: `pnpm --filter simetra test rights-carrier-copies rights-carriers rights-contract field-ratchet messages` — PASS; точні очікування контрактів 1a змінюються лише полем `value` і знятими мапінгами регістрів.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): денормалізовані копії носіїв ТЧ і шляху у фізичному знімку"
```

---

### Задача 2: тригери виведення й поширення копій

**Files:**
- Create: `packages/simetra/src/compiler/rights/carrier-units.ts`
- Modify: `packages/simetra/src/compiler/sql/units.ts` (`UnitGenerator` — `"carriers"`, `FIXED_BODY.carriers = true`), `compiler/pipeline.ts` (`sqlUnits`, `describeGenerated.carriers`), `compiler/mechanics-units.ts`, `compiler/subscription-units.ts`
- Test: `packages/simetra/src/compiler/__tests__/carrier-units.test.ts` (новий), `mechanics-units.test.ts`, `subscription-units.test.ts`, `creation-order.test.ts`

**Interfaces:**
- Consumes: `origin.copyOf` (Задача 1), `executeGrants`, `makeObjectName`, `generatedUnit`.
- Produces: `buildCarrierUnits(physical: PhysicalSnapshot, provider: DatabaseProvider, module: string, parse: SqlParser): SqlUnit[]`; `carrierTriggerNames(table: QualifiedName): { derive: string; propagate: string; propagateInsert: string }` (`<t>_simetra_carriers`, `<t>_simetra_carriers_out`, `<t>_simetra_carriers_out_insert`; функції — `<t>_simetra_carriers` і `<t>_simetra_carriers_out` у схемі таблиці, обидва тригери поширення — на одній функції); `contentChangeCondition(table: PhysicalTable, attributeCase: AttributeCase): string | undefined` — `(OLD.<c> IS DISTINCT FROM NEW.<c> OR …) OR NOT (OLD.<копія> IS DISTINCT FROM NEW.<копія> OR …)` (зміст — колонки поза механікою, копіями й генерованими), `undefined` для таблиці без копій; `subscriptionTriggerNames(contract, source, copies: boolean)` — наявний аргумент `source` лишається (`whenChanged` — властивість кожного джерела), `copies` — факт таблиці цього джерела: `<name>` і `<name>_insert` і для джерела без `whenChanged` на таблиці з копіями.

- [ ] **Step 1: Write the failing tests (unit)** над `policyDomain()`:
  - `carrier-units.test.ts`, `it("derives copies on insert and on a changed link FOR SHARE, keeps them otherwise")`: для `task_checklist` — тригер `BEFORE INSERT OR UPDATE … FOR EACH ROW`; дерево PL/pgSQL тіла має гілку `TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.org_id IS DISTINCT FROM OLD.org_id` з `SELECT … INTO NEW.assignee_id, NEW.region_id, NEW.project_id FROM <схема>.task … WHERE … org_id = NEW.org_id AND … id = NEW.parent_id FOR SHARE`, інакше — для кожної копії: `NEW.<копія> IS NOT DISTINCT FROM OLD.<копія>` лишає її, інакше звичайний `SELECT` джерела **без** `FOR SHARE` перевиводить; `RETURN NEW`; ні `current_setting`, ні `pg_trigger_depth` у тілі.
  - `it("propagates every column a copy reads, scope first")`: `task_simetra_carriers_out` — `AFTER UPDATE` з `WHEN` рівно на `assignee_id`, `region_id`, `project_id`, і `task_simetra_carriers_out_insert` — `AFTER INSERT` без `WHEN`, обидва на одній функції, що оновлює залежних тим самим `WHERE`; `task_comment_simetra_carriers_out` — `WHEN` на копію шляху (її читає копія `task_comment_attachments`); кожне оновлення залежних — `WHERE <скоуп> = NEW.<скоуп> AND <through> = NEW.<ключ> AND <копія> IS DISTINCT FROM …`.
  - `it("carrier functions are closed and grant nothing")` (Р2a2-8): дерево кожної функції — `LANGUAGE plpgsql`, `SECURITY DEFINER`, опція `search_path` = `''`, кожне відношення кваліфіковане; `EXECUTE` — нікому.
  - `it("renders nothing for a table without copies")`: `rightsFiles()` → жодної одиниці `generator: "carriers"`.
  - `mechanics-units.test.ts`, `it("a copy-only update does not touch the row")` (Р2a2-19): на `task_comment` — `task_comment_simetra_touch` `BEFORE INSERT` і `task_comment_simetra_touch_update` `BEFORE UPDATE … WHEN (<contentChangeCondition>)` — зміст без копії шляху й колонок механіки, копія — у частині `OR NOT (…)`; на `task_report` генерована колонка періоду номера в умову не входить; на `task` (без копій) — одна `task_simetra_touch` `BEFORE INSERT OR UPDATE`, як раніше.
  - `subscription-units.test.ts`, `it("a subscription on a table with copies ignores copy-only updates")`: підписка на `TaskComment` без `whenChanged` — тригери `<name>` (`UPDATE … WHEN (<contentChangeCondition>)`) і `<name>_insert` (`INSERT`); з `whenChanged` — наявний `WHEN` без змін; ім'я `<name>_insert` довжиною понад 63 байти — та сама помилка довжини, що й для `whenChanged`.
  - `it("carrier function names collide like membership functions")` (Р2a2-22): довга основна таблиця і її ТЧ, чиї імена після `makeObjectName` дають однакове ім'я функції носіїв, → `physical.function-duplicate`.
  - `creation-order.test.ts`: тригери `task_simetra_carriers_out` і `task_simetra_carriers_out_insert` — після функції й обох залежних таблиць (`requires`).
- [ ] **Step 2:** Run: `pnpm --filter simetra test carrier-units mechanics-units subscription-units creation-order` — FAIL.
- [ ] **Step 3: Implement** `carrier-units.ts` за зразком `mechanics-units.ts` (одиниці через `generatedUnit`, `requires` — джерельні й залежні таблиці); коментар «чому» біля `SECURITY DEFINER` — аргумент Р2a2-8; біля гілки «зв'язок не змінився» — аргумент про `40P01` і про те, чому поширення виживає; біля `contentChangeCondition` — аргумент Р2a2-19 (незалежність від порядку); біля `WHEN` поширення — збіжність двоходової зміни через `IS DISTINCT FROM`. Механіка й підписки — `contentChangeCondition` (Р2a2-19).
- [ ] **Step 4:** Run: `pnpm --filter simetra test carrier-units mechanics-units subscription-units creation-order platform-layer` — PASS (тест 2a1 «generated SQL never manages the command role itself» охоплює й нові одиниці).
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): тригери копій носіїв; поширення копій не змінює зміст рядка"
```

---

### Задача 3: обробник підписки не пише й не читає копій

**Files:**
- Modify: `packages/simetra/src/compiler/stages/links.ts` (поруч із `subscription.handler-assigns-mechanics`), `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/event-subscriptions.test.ts`

**Interfaces:**
- Produces: коди `subscription.handler-assigns-carrier` (`{ column }`; підказка — присвоєння в хук команди, П4) і `subscription.handler-reads-carrier` (`{ column }`).

- [ ] **Step 1: Write the failing test (unit)** — `it.each` у наявному блоці перевірок обробника (будівник підписки файлу тесту над `policyDomain()`, джерело — `TaskComment`): присвоєння копії шляху → `subscription.handler-assigns-carrier`; присвоєння `NEW.task_id` (перший крок шляху) → той самий код; пряме читання `NEW.<копія>` у виразі → `subscription.handler-reads-carrier`; `to_jsonb(NEW)`, `NEW.*` і передача `NEW` у функцію → нічого; присвоєння й читання `NEW.<звичайний реквізит>` → нічого.
- [ ] **Step 2:** Run: `pnpm --filter simetra test event-subscriptions` — FAIL.
- [ ] **Step 3: Implement:** множина заборонених присвоєнь — колонки механіки ∪ копії ∪ колонки `through` копій шляху основної таблиці; заборонене читання — пряме `NEW.<копія>` (новий обхід `PlpgsqlStatement.expressions`, `ColumnRef` з двох полів `new.<копія>`); тексти en/uk.
- [ ] **Step 4:** Run: `pnpm --filter simetra test event-subscriptions messages` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): обробник підписки не пише й не читає копій носіїв"
```

---

### Задача 4: відмова плану без кроку даних для копій

**Files:**
- Create: `packages/simetra/src/schema/apply/carrier-backfill.ts`
- Modify: `packages/simetra/src/schema/apply/plan.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/carrier-backfill.test.ts` (новий), `plan.test.ts`, `packages/simetra/test/db/carrier-backfill.db.test.ts` (новий)

**Interfaces:**
- Produces:
  - `pendingCarrierCopies(desired: PhysicalSnapshot, applied: PhysicalSnapshot | undefined, created: ReadonlySet<string>, oldName?: (table: QualifiedName) => QualifiedName): { table: QualifiedName; columns: string[] }[]` — копії бажаного стану, які в знімку останнього застосування (`state.marker.snapshot`) не є копіями з тим самим `copyOf` (у промоції `applied` для промотованої таблиці копій не має), на таблицях, яких план не створює;
  - `carrierBackfillRefusals(tx: ApplyTransaction, pending: readonly { table: QualifiedName; columns: string[] }[]): Promise<ApplyDiagnostic[]>` — `SET LOCAL row_security = off`, потім `SELECT EXISTS (SELECT 1 FROM <таблиця>)` на кожну; відмова `plan.carrier-backfill-missing` (`{ table, columns }`; підказка: «додайте носій до появи рядків або дочекайтеся кроку даних (план Права-2b)», починається з «No plan was written.» / «План не записано.»).

- [ ] **Step 1: Write the failing tests (unit)** `carrier-backfill.test.ts`, таблиця `pendingCarrierCopies`:

| case | вхід | очікування |
| --- | --- | --- |
| `already-copy` | колонка в `applied` з тим самим `copyOf` | `[]` |
| `same-name-not-copy` | колонка `assignee_id` в `applied` без `copyOf` (видалений реквізит ТЧ) | `[{ table, columns: ["assignee_id"] }]` |
| `created` | таблиця в `created` | `[]` |
| `new-copy` | колонки немає в `applied` | `[{ table, columns }]` |
| `promotion` | промотована таблиця з прийнятою колонкою того самого імені, `oldName` | `[{ table: <стара назва>, columns }]` |

  `carrierBackfillRefusals` над фейковою транзакцією: перший оператор — `SET LOCAL row_security = off`; `exists: true` → одна відмова; `false` → `[]`. `plan.test.ts` (фейкова база, двигун-`Proxy` за зразком 2a1): звичайний план і план з промоцією, де таблиця цілі має рядки, → `status: "refused"` з `plan.carrier-backfill-missing`.
- [ ] **Step 2:** Run: `pnpm --filter simetra test carrier-backfill plan` — FAIL.
- [ ] **Step 3: Implement;** у `buildPlan` — після `classifySteps`, до `collectEnvironment`; множина створених таблиць — з `actions[].produces` (префікс `table:`); `applied` — знімок marker, який план уже читає; у гілці промоції — з `intent.tablesNewToOld`; читальна транзакція `"rollback"`.
- [ ] **Step 4: DB test** `test/db/carrier-backfill.db.test.ts` (причина DB-рівня — `FORCE ROW LEVEL SECURITY` і `row_security` вирішує Postgres), `withRollback`: таблиця з `FORCE ROW LEVEL SECURITY` і рядком, власник — тегована роль `NOBYPASSRLS` (`testRoleName("force")`), сесія під нею (`SET LOCAL ROLE`): `carrierBackfillRefusals` кидає помилку Postgres, а не повертає `[]`. Мутація: прибрати `SET LOCAL row_security = off` — повертає `[]` (тихий нуль), тест червоніє.
- [ ] **Step 5:** Run: `pnpm --filter simetra test carrier-backfill plan messages` і `pnpm --filter simetra exec vitest run --project db carrier-backfill` — PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/simetra
git commit -m "feat(schema): відмова плану, коли нова копія носія лягає на таблицю з рядками"
```

---

### Задача 5: політики межі тенанта, «Користувачів» і прав читання

**Files:**
- Modify: `packages/simetra/src/compiler/access-units.ts`, `compiler/rights/predicates.ts`, `compiler/rights/functions.ts`, `compiler/contracts.ts` (`AccessContract`), `compiler/pipeline.ts`, `compiler/messages.ts` (`KIND_MODULE_REPLACEMENT.policy`)
- Modify: `packages/simetra/test/db/access.db.test.ts`
- Test: `packages/simetra/src/compiler/__tests__/access-units.test.ts`, `rights-predicates.test.ts`, `rights-functions.test.ts`, `creation-order.test.ts`

**Interfaces:**
- Consumes: `rightsPredicates`, `renderCondition`, `rights_my_scopes` (2a1), `CarrierContract.value`, `origin.copyOf` (Задача 1), `PLATFORM_ROLES`.
- Produces:
  - `AccessContract` додає `root: boolean` (основна таблиця кореня скоупу), `users: boolean` (основна таблиця «Користувачів») і `rights?: { objectId: string }` (контракт прав власника для ТЧ і похідних таблиць);
  - `accessPolicyNames(table: { name: string }): { scopeRead: string; scopeInsert: string; scopeUpdate: string; scopeDelete: string; publicRead: string; rights(label: string): string }` (`rights` — з обмеженням мітки Р2a2-2);
  - `simetra.rights_visible_users() RETURNS SETOF uuid` у генераторі `rights` (Р2a2-18);
  - `rightsPredicates(contract, action, table)` (2a1) приймає таблицю ТЧ і похідну таблицю регістра (Р2a2-6).
  - прибрати пропуск носіїв `via` з 2a1; кейс: носій шляху дає предикат на копії; тест 2a1 про пропуск — перевернути, а не видалити.

- [ ] **Step 1: Write the failing tests (unit)**:
  - `access-units.test.ts` (замінює `scoped table gets the uncorrelated read policy`): `it("scoped table gets restrictive scope policies for every command")` — рівно `CREATE POLICY item_scope_read ON public.item AS RESTRICTIVE FOR SELECT TO authenticated, simetra_command USING (org_id = ANY (ARRAY(SELECT public.org_member_scopes())));` і три політики запису з `WITH CHECK`/`USING` тієї самої форми (цілі оператори).
  - `it("the scope root has no scope insert policy")` (Р2a2-1): `organization` — `scope_read`, `scope_update`, `scope_delete`, без `scope_insert`; `organization_lines` — усі чотири.
  - `it("users are bounded by the visible users set in a project with membership")` (Р2a2-18): «Користувачі» — `users_scope_read AS RESTRICTIVE … USING (id = ANY (ARRAY(SELECT "simetra"."rights_visible_users"())))`, `users_devices_scope_read` — те саме за `parent_id`; в однотенантному проєкті (`singleTenantRights()`) і в проєкті з членством без ролей (`rightsFiles()`) — немає ні політик, ні функції.
  - `it("rights read policies come from the predicate builder")`: для `task` з `policyDomain()` — `task_read_any`, `task_read_own`, `task_read_region`, `task_read_in_project_any` (і `_own`, `_region`), `PERMISSIVE FOR SELECT TO authenticated, simetra_command`, `USING` = `renderCondition` предикатів через `AND`; для `task_checklist` — ті самі форми з копіями й колонкою скоупу ТЧ; для `task_comment` і `task_comment_attachments` — `_read_own` за копією шляху; для `users_devices` — `_read_own` за `parent_id`; для `task_hours_totals` — `_read_any` за `org_id` і `_read_region` за `region_id`.
  - `it("public read keeps write scope policies and has no rights read")` (Р2a2-3).
  - `it("no rights read policies without roles")` — `rightsFiles()` → лише `scope_*` політики.
  - наявний `policy names of a 60-byte table stay within 63 bytes` — над усіма мітками `accessPolicyNames`, зокрема `read_in_<60-байтна таблиця контейнера>_own`; комбінації — довгі контейнер і вимір разом, кілька носіїв `own` (зокрема в контейнері), 63-байтові колонка носія й ім'я виміру — дають імена не довші за 63 байти, і ідентичності політик таблиці не дублюються (Р2a2-2).
  - `rights-functions.test.ts` (наявний, 2a1): `it("renders the visible users set")` — сигнатура, `STABLE SECURITY DEFINER`, гранти user/service/command; тіло читає `simetra.rights_my_scopes` і таблиці членства лише в з'єднанні з нею за парою (`scope_kind_id`, скоуп). У тому самому файлі тест 2a1 `reads every catalog it needs only through qualified relations` переформулювати: «таблиці членства згадують лише `rights_my_scopes` і `rights_visible_users`, остання — лише в з'єднанні з `rights_my_scopes()`» (Р2a1-25), інакше він червоніє.
  - `rights-predicates.test.ts`: правило §5.4 (2a1) — тепер і над ТЧ, копіями шляху й похідними таблицями.
  - `creation-order.test.ts` (оновлює `kind table: generated revoke before grant…`): ребра `simetra.rights_any(text, text)` → `policy:public.task.task_read_any` і таблиця → політика.
- [ ] **Step 2:** Run: `pnpm --filter simetra test access-units rights-predicates rights-functions creation-order` — FAIL.
- [ ] **Step 3: Implement:** `buildAccessUnits` — `readPolicy` з `permissive | restrictive` і командою; рендер політик прав із предикатів; `TO` — `PROVIDER_API_ROLES[provider].user` і `PLATFORM_ROLES.command`; `rights_visible_users` — у `buildRightsUnits`; `KIND_MODULE_REPLACEMENT.policy` — перелік `<t>_scope_*` і `<t>_read_*` замість «права приходять зі спекою прав».
- [ ] **Step 4:** Той самий коміт — `access.db.test.ts`: фікстура `compiled()` отримує системні довідники й роль рівня `org` з `read@any` на **явному переліку** скоуплених об'єктів (`Organization`, `Item`, `Sale`, `Stock`; не `withAction`, бо інакше роль читала б і нескоуплений `Secret`), учасники в `tenant()` — призначення цієї ролі; тест `every read policy plans the scope set once` бере імена з `accessPolicyNames` контрактів (не `tablename || '_read'`) і перевіряє `InitPlan` без `SubPlan` для `scope_read` і кожної `read_*`.
- [ ] **Step 5:** Run: `pnpm --filter simetra test access-units rights-predicates rights-functions creation-order function-execute messages` і `pnpm --filter simetra exec vitest run --project db access` — PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/simetra
git commit -m "feat(compiler): межа тенанта RESTRICTIVE, видимість Користувачів і політики прав читання"
```

---

### Задача 6: промоція й зворотна генерація впізнають нові форми

**Files:**
- Modify: `packages/simetra/src/schema/apply/promotion/access.ts`, `schema/apply/promotion/replacements.ts`, розпізнавачі платформних одиниць зворотної генерації (`isMechanics` і сусідні — `orient isMechanics`)
- Test: `packages/simetra/src/schema/apply/__tests__/promotion-removals.test.ts`, тест зворотної генерації поруч із розпізнавачем

- [ ] **Step 1: Write the failing test (unit)** у блоці `access()`: `it("a restrictive generated policy opens no roles")` — бажана модель з `items_scope_insert AS RESTRICTIVE … TO authenticated` і без прийнятих політик `INSERT` → жодного рядка `adds roles`. Фікстуру `GENERATED` (рядки `item_read`, `item_public_read`) переписати на форми Задачі 5 (`item_scope_read` RESTRICTIVE, `item_read_any` PERMISSIVE); у `describe("policy")` додати `it("is replaced only by a permissive rights policy, not by the restrictive scope policy")`: бажаний стан лише з `item_scope_read` → `plan.platform-replacement-missing`.
- [ ] **Step 2:** Run: `pnpm --filter simetra test promotion-removals` — FAIL на новому кейсі.
  Плюс (Р2a2-20): умова впізнається **лише рівністю дерева** з `contentChangeCondition(<бажана таблиця>)`. Кейси форм заміни тригера: `it("moddatetime is replaced only by the split mechanics with an UPDATE trigger")` — вердикт заміни вимагає саме `<t>_simetra_touch_update` з цією умовою; від'ємний — бажана модель без `_touch_update` → `plan.platform-replacement-missing`; `it("a subscription pair replaces the adopted trigger")` — пара `<name>` (з `contentChangeCondition`) + `<name>_insert`; `it("a user trigger with another OR NOT condition is not platform")` — умова з іншим набором колонок не вважається платформною. Зворотна генерація: `it("recognizes carrier and split mechanics units as platform")` — не пише `<t>_simetra_touch_update`, `<t>_simetra_carriers`, `<t>_simetra_carriers_out`, `<t>_simetra_carriers_out_insert` і їхні функції як дослівні одиниці.
- [ ] **Step 3: Implement:** `addedRoles` фільтрує `now.permissive`; форма заміни тригера й розпізнавачі — за Р2a2-20.
- [ ] **Step 4:** Run: `pnpm --filter simetra test promotion-removals reverse-generate` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/schema
git commit -m "fix(schema): промоція й зворотна генерація впізнають нові форми прав і механіки"
```

---

### Задача 7: хвиля перевірок діагностик (до попередження)

**Files:**
- Modify: `packages/simetra/src/compiler/__tests__/helpers.ts`, `compiler/diagnostics.ts` (`RuleCode`, `WARNING_RULES`), `compiler/messages.ts`
- Modify: тестові файли, що компілюють скоуплені фікстури без ролей і чекають `diagnostics).toEqual([])` (за grep автора плану — близько 25, зокрема `reverse-generate.test.ts`, `operations-promote.test.ts`, `contracts.test.ts`, `stage-links.test.ts`, `operations-fix.test.ts`, `stage-scope-identity.test.ts`, `assigned-once.test.ts`, `predefined.test.ts`; DB — `access.db.test.ts`, `membership.db.test.ts`, `paper-test.db.test.ts`; designer — що знайде прогін Задачі 8)
- Test: `packages/simetra/src/compiler/__tests__/helpers.test.ts` (новий, якщо немає)

**Interfaces:**
- Produces: `expectClean(result: { diagnostics: readonly Diagnostic[] }, options?: { allow?: readonly RuleCode[] }): void`; код `rights.scope-kind-unread` (зареєстрований, ще не випускається).

- [ ] **Step 1: Write the failing test (unit)** `helpers.test.ts`: `expectClean` проходить без діагностик; падає на будь-якій помилці навіть з `allow`; падає на попередженні поза `allow`; проходить на дозволеному.
- [ ] **Step 2:** Run: `pnpm --filter simetra test helpers` — FAIL; реалізувати `expectClean`, зареєструвати код (`RuleCode`, `WARNING_RULES`, `MESSAGES` en/uk — наслідок для автора) — PASS.
- [ ] **Step 3:** У кожному файлі, що компілює скоуплену фікстуру без ролей, замінити `expect(result.diagnostics).toEqual([])` на `expectClean(result, { allow: ["rights.scope-kind-unread"] })`; перевірки, що чекають конкретного попередження, лишити з точним очікуванням; жодної іншої зміни тестів.
- [ ] **Step 4:** Run: `pnpm test` і `pnpm --filter simetra exec vitest run --project db access membership paper-test` — PASS (код ще не випускається, тож хвиля нічого не послаблює).
- [ ] **Step 5: Commit** (окремий — Р2a2-16)

```bash
git add packages
git commit -m "test: перевірки діагностик через expectClean перед попередженням виду скоупу"
```

---

### Задача 8: попередження на вид скоупу

**Files:**
- Create: `packages/simetra/src/compiler/rights/scope-kind-warnings.ts`
- Modify: `packages/simetra/src/compiler/pipeline.ts`
- Test: `packages/simetra/src/compiler/__tests__/rights-scope-kind-warnings.test.ts` (новий)

**Interfaces:**
- Consumes: `rights.scope-kind-unread` (Задача 7).
- Produces: `scopeKindUnreadWarnings(contracts: Pick<Contracts, "rights" | "rightsProjection">, project: Project): Diagnostic[]`.

- [ ] **Step 1: Write the failing tests (unit)** — `it.each`: `rightsFiles()` (вид `org`, ролей немає) → `rights.scope-kind-unread` на `/scopeKinds/0` з `{ scopeKind: "org" }`; вид лише з `CustomTable` → нічого; `withRoles(...)` з `read@any` на `Task` → нічого; `withRoles` лише з `read@own` на `Task` → нічого; вид без членства зі скоупленим документом → попередження; `OrgAdmin` (`fullAccess`) як єдина роль → нічого.
- [ ] **Step 2:** Run: `pnpm --filter simetra test rights-scope-kind-warnings` — FAIL.
- [ ] **Step 3: Implement;** підключити в `pipeline.ts` після контрактів.
- [ ] **Step 4:** Run: `pnpm test` і `pnpm --filter simetra exec vitest run --project db` — PASS (хвиля Задачі 7 уже дозволила код); якщо падає перевірка, якої хвиля не зачепила, — вона йде в цей коміт тією самою заміною.
- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(compiler): попередження на вид скоупу, об'єктів якого не читає жодна роль"
```

---

### Задача 9: перехід прикладу на ролі

**Files:**
- Create: `examples/reference/metadata/catalogs/{OrgRoles,OrgRoleAssignments,GlobalRoles,GlobalRoleAssignments}/*.meta.json`, `examples/reference/metadata/rights-sets/OrgReaders/OrgReaders.meta.json`, `examples/reference/metadata/roles/{OrgMemberRole,OrgAdmin,CurrencyKeeper}/*.meta.json`
- Modify: `packages/simetra/src/schema/__tests__/reference-domain.test.ts`, `packages/simetra/src/compiler/__tests__/fixtures/reference-domain.ts` (якщо перелік файлів фіксований)

- [ ] **Step 1: Write the failing test (unit)** — у `reference-domain.test.ts` прибрати фільтр `!def.rightsDeclaration` («covers every kind»): тест червоніє, бо `Role` і `RightsSet` у прикладі немає; і `it("the reference domain compiles clean")` — `expectClean(result)` без `allow`.
- [ ] **Step 2:** Run: `pnpm --filter simetra test reference-domain` — FAIL.
- [ ] **Step 3:** Додати (через `simetra create` чи вручну з UUID): системні довідники `org` і глобальні; набір `OrgReaders` (`grant { objects: { withAction: "read" }, actions: ["read"], extent: "any" }`: роль рівня скоупу з ним читає й «Користувачів», але лише видимих — Р2a2-18); роль `OrgMemberRole` (`assignedOn: { scopeKind: "org" }`, `include: [OrgReaders]`); роль `OrgAdmin` (`scopeKind: "org"`, `fullAccess: true`); глобальна роль `CurrencyKeeper` (`read`, `update` на `Currency`, `any`).
- [ ] **Step 4:** Run: `pnpm --filter simetra test reference-domain explain operations reference-index-completeness && pnpm metadata:check` — PASS; `pnpm --filter simetra exec vitest run --project db reference-domain paper-test` — PASS.
- [ ] **Step 5: Commit**

```bash
git add examples packages/simetra/src
git commit -m "feat(examples): ролі, набір прав і системні довідники прав у референсному застосунку"
```

---

### Задача 10: DB-сценарії політик і носіїв

**Files:**
- Create: `packages/simetra/test/db/rights-policies.db.test.ts`, `packages/designer/src/__tests__/carrier-locks.db.test.ts`
- Modify: `packages/designer/src/schema-engine/__tests__/engine-desired-corpus.db.test.ts`

Причина DB-рівня (шапка кожного файлу): які рядки бачить роль під RLS, що роблять тригери, блокування й двигун — вирішує Postgres.

- [ ] **Step 1: Write the test** `rights-policies.db.test.ts`, опис «policies»: `beforeAll` — компіляція `policyDomain()` з ролями й `renderDesiredState`, клієнт, `BEGIN`, розгортання, засів (власником): організації A, B; учасники `m1` (A, `OrgMember`: `TaskReaders`), `m2` (A, кастомна роль на `OrgMember` з `deny read@any` на `task`, `task_comment`, `task_hours`), `m3` (A, та сама кастомна роль, рядки `MemberRegion` з регіоном `r1`), `m4` (A, лише `ProjectLead` на `P1`), `m5` (B, `OrgMember`), `m6` (учасник A без призначень і учасник B з `OrgMember`), `u9` (користувач без членства), `s1` (глобальна `Support` з `read@any` на `Announcement`); задачі A у `P1`/`P2` з різними `assignee` і `region`, рядки `checklist`, коментарі з `attachments`, рух `TaskHours`, підсумки. `afterAll` — `ROLLBACK`. Кейси — `queryAs(client, "authenticated", …)`:

| case | user | запит | очікування |
| --- | --- | --- | --- |
| `any` | m1 | `SELECT id FROM task` | усі задачі A, жодної B |
| `foreign-tenant` | m5 | `SELECT id FROM task` | лише задачі B |
| `member-without-role` | m6 | `SELECT id FROM task` | лише задачі B (членство в A без ролі нічого не дає) |
| `own` | m2 | `SELECT id FROM task` | задачі A з `assignee` = m2 |
| `dimension` | m3 | `SELECT id FROM task` | задачі A з `region = r1` і задачі з `assignee` = m3 |
| `container` | m4 | `SELECT id FROM task` | лише задачі `P1` |
| `unscoped` | s1, m1 | `SELECT id FROM announcement` | усі; жодної |
| `users-cross-tenant` | m1 | `SELECT id FROM users` | m1 і користувачі учасників A; жодного лише-B користувача й `u9` |
| `tabular` | m2 | `SELECT parent_id FROM task_checklist` | лише рядки задач m2 |
| `path` | m2 | `SELECT id FROM task_comment` | коментарі задач m2 |
| `path-tabular` | m2 | `SELECT parent_id FROM task_comment_attachments` | лише вкладення коментарів задач m2 |
| `users-devices-cross-tenant` | m1 | `SELECT parent_id FROM users_devices` | лише пристрої видимих користувачів (з `read@any` на «Користувачах» — не всіх) |
| `key-carrier` | u9 (без членства, лише `Everyone`: `read@own` на «Користувачах») | `SELECT parent_id FROM users_devices` | лише власні пристрої |
| `register-totals` | m3 | `SELECT region_id FROM task_hours_totals` | лише `r1` (`deny read@any` m3 покриває й `TaskHours`) |
| `forged-copy-update` | власник | `UPDATE task_comment SET <копія шляху> = <m5> WHERE id = c` | копія відновлена з джерела; `SELECT id FROM task_comment` під m2 — та сама множина, що до запиту; тверджень про `version` і підписку немає |
| `users-cross-kind` | x3 (учасник `team` з навмисно `team.id = A.id`, без членства в A; опис додає `secondScopeKind()`) | `SELECT * FROM simetra.rights_visible_users()` | x3 і учасники `team`; жодного учасника A |
| `forged-copy` | власник | `INSERT INTO task_checklist (…, assignee_id) VALUES (…, <m5>)` | у рядку `assignee_id` = `assignee` власника |
| `source-after-dependent` | власник | `WITH a AS (INSERT INTO task (…, assignee_id) VALUES (…, m2) RETURNING id) INSERT INTO task_checklist (parent_id, …) SELECT id, … FROM a` | копія `assignee_id` рядка ТЧ = m2, не `NULL` (на `AFTER UPDATE`-лише формі кейс червоніє) |
| `propagation-owner` | власник | `UPDATE task SET assignee_id = m1 WHERE id = t` | копії `task_checklist` = m1; `version` задачі +1 рівно раз (на старій формі `NEW.<копія> := OLD.<копія>` кейс червоніє: копія лишається старою) |
| `propagation-path` | власник | те саме | копія `task_comment` і копії `task_comment_attachments` = m1 (двоходово); `version` коментаря **не змінився**; лічильник підписки `onWrite` на `TaskComment` не зріс |
| `tabular-foreign-scope` | власник | `INSERT INTO task_checklist (org_id = B, parent_id = задача A)` | `23503` (якір Р-Г; проходить і до 2a2, мутаційного твердження немає) |

  Плюс `EXPLAIN (FORMAT JSON) SELECT * FROM <t>` під m1 для `task_checklist`, `task_comment`, `task_comment_attachments`, `task_hours_totals`: `InitPlan` є, `SubPlan` немає.
- [ ] **Step 2: Write the test** `carrier-locks.db.test.ts` (designer, Р2a2-17): `inTarget(<бажаний SQL policyDomain()>, <межа>, async (url) => …)` — засів комітом; дві сесії `pg.Client` на `url`:
  - `it("inserting a tabular row waits for the owner row lock")`: сесія 1 `BEGIN; UPDATE task SET assignee_id = … WHERE id = t` (без коміту); сесія 2 `SET lock_timeout = '200ms'; INSERT INTO task_checklist (parent_id = t, …)` → `55P03`; сесія 1 `ROLLBACK`.
  - `it("updating a tabular row and its owner at once does not deadlock")`: сесія 2 `BEGIN; SELECT … FROM task WHERE id = t FOR UPDATE`; сесія 1 `BEGIN; SET lock_timeout = '2s'; UPDATE task_checklist SET note = 'x' WHERE id = r` — проходить одразу (без блокування власника); сесія 2 `UPDATE task SET assignee_id = m1 WHERE id = t` (асинхронно, чекає на `r`); сесія 1 `COMMIT`; сесія 2 завершується без `40P01`, `COMMIT`; копія `r` = m1.
- [ ] **Step 3:** `engine-desired-corpus.db.test.ts`: модель `policyDomain()` (з `TaskReport` — генерована колонка й `WHEN` механіки) — у корпус поруч із `reference domain` (`deployed desired state reconciles empty through the port`): функції носіїв, тригери з `WHEN`, `RESTRICTIVE`-політики й `rights_visible_users` проходять туди-назад.
- [ ] **Step 4:** Run: `pnpm --filter simetra exec vitest run --project db rights-policies access rights-functions` і `pnpm --filter @simetrajs/designer exec vitest run --project db carrier-locks engine-desired-corpus` — PASS. **Мутаційний доказ** (вручну): прибрати `task_read_own` — червоніє `own`; `_read_region` — `dimension`; `_read_in_project_any` — `container`; `users_scope_read` — `users-cross-tenant`; з'єднання `rights_visible_users` лише за скоупом (без виду) — `users-cross-kind`; `users_devices_scope_read` — `users-devices-cross-tenant`; політику ТЧ — `tabular`; копію шляху з предиката — `path`; поширення копії до ТЧ коментаря — `path-tabular`; предикат ТЧ за `parent_id` для носія-ключа — `key-carrier`; політику підсумків — `register-totals`; ігнорування значення з запиту в тригері — `forged-copy`; гілку `INSERT` тригера поширення — `source-after-dependent`; тригер поширення — `propagation-owner`; `contentChangeCondition` механіки чи підписки — `propagation-path`; `FOR SHARE` на `INSERT` — `inserting a tabular row waits…`; блокування власника на кожному `UPDATE` рядка ТЧ — `… does not deadlock` (`55P03` під `lock_timeout`); `RESTRICTIVE` → `PERMISSIVE` у `task_scope_read` — `member-without-role`.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/test/db packages/designer/src
git commit -m "test(db): політики прав читання, копії носіїв, їхні блокування й двигун"
```

---

### Задача 11: скіл, гейти й заміри

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md`, `docs/ROADMAP.md`, `docs/superpowers/plans/2026-10-18-rights-2a2-read-policies-carriers.md` (позначки)

- [ ] **Step 1:** Скіл споживача (англійською): скоуплений об'єкт читається лише з правом `read` ролі; «Користувачі» видно лише свої й учасників моїх скоупів; копії носіїв пише платформа, їхня зміна не підвищує версію й не запускає підписок; обробник `beforeWrite` не присвоює й не читає копій і не присвоює колонки першого кроку шляху (присвоєння — у хук команди); нова копія на таблиці з рядками — відмова плану до кроку даних.
- [ ] **Step 2:** Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — код 0.
- [ ] **Step 3:** Run: `pnpm metadata:check && python3 scripts/check-doc-anchors.py && .agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-18-rights-2a2-read-policies-carriers.md` — код 0.
- [ ] **Step 4:** Повний `pnpm test:db` на одному SHA (у фоні, таймаут не коротший за 45 хв): `/usr/bin/time -f %e pnpm test:db` — код 0; приріст проти прогону після 2a1 ≤ 60 с, інакше звіт архітектору з розкладом за файлами.
- [ ] **Step 5:** ROADMAP — «Права-2a2 виконано»; позначки плану.
- [ ] **Step 6: Commit**

```bash
git add packages/designer/skills docs/ROADMAP.md docs/superpowers/plans/2026-10-18-rights-2a2-read-policies-carriers.md
git commit -m "docs(plan): Права-2a2 виконано — скіл, ROADMAP, позначки"
```

## Критерії приймання

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py` — зелені після **кожного** коміту; повний `pnpm test:db` — зелений на одному SHA, приріст записано.
- Жодної `PERMISSIVE`-політики межі тенанта; `<t>_read` П3-3a1 немає; основна таблиця кореня не має `<t>_scope_insert`; «Користувачі» в проєкті з членством мають `RESTRICTIVE`-межу видимості (Задача 5).
- Кожна умова політики прав — з будівника 2a1; правило §5.4 тримає тест і на ТЧ, шляху й похідних таблицях (Задача 5).
- Копії носіїв пише лише платформа: підроблене значення замінюється, зміна джерела поширюється двоходово без рекурсії, без зміни версії й без підписок, вставка чекає на блокування власника, одночасні `UPDATE` не дають `40P01` — мутаційні докази Задачі 10.
- Колонка з іменем копії, яка не була копією, — відмова плану (Задача 4).
- `examples/reference` компілюється без діагностик (`expectClean` без `allow`), «covers every kind» — без фільтра.
- Хвиля перевірок діагностик — окремим комітом `test: …`, без жодних змін тестів поза заміною перевірки.
