# Права-2d2: аналіз прав, гейт планів і бенчмарк — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: чернетка автора, на аудиті.
Архітектор задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** база відповідає на питання аналізу прав (Рх17): «що може учасник»,
«хто може дію над об'єктом», «чому рядок видно чи ні» й «що змінювали в
правах» — над тими самими функціями прав, лише адміністратору прав скоупу.
Гейт планів (§5.4) у `test:db` доводить на даних помітного обсягу, що
згенеровані політики читаються некорельовано й індексом. Бенчмарк поза
`test:db` міряє межі (потужність множин, розгалуження ТЧ, крок копій) і
записує їх у скіл.

**Архітектура:**

- **T1** (`packages/simetra/src/compiler/rights/`):
  - `functions.ts` — тіло `rights_mine` будується з одного TS-шаблону з виразом користувача й колонками походження; функції аналізу `rights_member`, `rights_who`, `rights_journal_of`;
  - `explain-units.ts` (новий) — `rights_explain` з гілкою на кожен об'єкт з контрактом прав, з тих самих предикатів, що політики читання (`rightsPredicates`).
- **Тести:** unit на деревах; DB-опис функцій аналізу; DB-гейт планів на
  обсязі; бенчмарк — окремий проєкт Vitest `bench` під сторожем стеку.

**Стек:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query (WASM),
локальний стек Supabase (Postgres 17).

**Спека:** [спека прав](../specs/2026-10-17-rights-design.md) — Рх17, Рх22,
§5.1 (аналіз прав і гейт `administerRights`), §5.4 (гейт планів і межі), §6.3
(знімок прав — з функцій аналізу); [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
§6.8 (EXPLAIN-гейт); [спека системної схеми й користувачів](../specs/2026-10-07-system-schema-users-design.md)
§7. Плани [Права-2a1](2026-10-18-rights-2a1-command-role-functions.md),
[Права-2a2](2026-10-18-rights-2a2-read-policies-carriers.md),
[Права-2b2](2026-10-24-rights-2b2-carrier-backfill.md),
[Права-2d1](2026-10-25-rights-2d1-adopted-sources.md),
[Права-2c2](2026-10-25-rights-2c2-rights-administration-guards.md) — їхні
таблиці рішень діють, їхні форми тут — дані.

**Залежність:** Права-2c2 виконано й прийнято (дія `administerRights`,
`rights_role_grants`, журнал прав, тригери запобіжників — бенчмарк міряє з
ними). Перед стартом —
`.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-25-rights-2d2-analysis-plan-gate-benchmark.md`.

## Global Constraints

- Усі обмеження планів Права-2a1…2c2 (розділи «Global Constraints») діють і тут.
- 🔴 `pnpm --filter <pkg> test <pattern>` — **без** `--` перед шаблоном.
- 🔴 «Мої скоупи» й права обчислює один шаблон: функції аналізу беруть тіло `rights_mine`/`rights_my_scopes`, згенероване тим самим TS-кодом з іншим виразом користувача; друга реалізація призначень, дельт чи замикання заборонена (Р2d2-2).
- 🔴 Функції аналізу не повертають даних рядків об'єктів застосунку: лише id ролей, учасників і користувачів, мітки, дії, обсяги, виміри й булеві збіги (журнал прав — образи рядків системних довідників прав, не об'єктів застосунку).
- 🔴 Без `administerRights` у скоупі запиту функція аналізу повертає порожньо, без помилки (архітектор, Ф13).
- 🔴 Бенчмарк не входить у `test:db` і CI; працює під сторожем стеку (`packages/simetra/test/db/stack-guard.ts`) з тегом прогону; стек не зупиняє й чужих об'єктів не чіпає.
- DB-тест — лише для того, що вирішує Postgres. Скіл `.agents/skills/writing-tests/SKILL.md` обов'язковий перед кожним кроком тестів.
- Між задачами гейти не червоні.
- Репо публічне: фікстури й обсяги синтетичні.

## Рішення плану

Розвилки Ф13 і Ф14 вирішив архітектор задачі 2026-10-25.

| # | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р2d2-1 | Функції аналізу (імена остаточні; §5.1 лишала їх формою): «що можу я» — наявна `rights_mine()`; `simetra.rights_member(p_scope_kind uuid, p_scope uuid, p_member uuid)`; `simetra.rights_who(p_action text, p_object text, p_scope_kind uuid, p_scope uuid)`; `simetra.rights_explain(p_object text, p_row uuid, p_user uuid)`; `simetra.rights_journal_of(p_scope_kind uuid, p_scope uuid, p_limit integer)`. Усі — `STABLE SECURITY DEFINER SET search_path = ''`, `EXECUTE` — `user`, `command`; сервісна роль `EXECUTE` не має (у неї немає користувача, а функції аналізу розкривають чужі права — на відміну від функцій множини, де §5.1 дає їй порожню множину), `LANGUAGE sql` (для `rights_explain` — `plpgsql`, якщо гілка за міткою об'єкта цього вимагає) | Рх17; одна форма з функціями прав | спека прав §5.1 — імена функцій аналізу й `EXECUTE` без сервісної ролі (Задача 0) |
| Р2d2-2 | Один шаблон обчислення прав: генератори `rights_my_scopes`, `rights_mine`, `rights_my_members`, гілки зв'язку `rights_dimension_values`, функції множини скоупу за членством (`<таблиця>_member_scopes`, `compiler/membership-functions.ts`) і `rights_visible_users` параметризуються виразом користувача (`(SELECT "simetra"."current_user_id"())` для наявних функцій) і, для `rights_mine`, набором вихідних колонок. Внутрішні варіанти з аргументом `p_user uuid` (без `EXECUTE`): `simetra.rights_scopes_of(p_user)`, `rights_detail_of(p_user)` (колонки походження `role_id` — архетип, `custom_role`, `via` — `archetype` чи `delta`), `rights_members_of(p_user, p_scope_kind)`, `rights_dimension_values_of(p_user, p_dimension)` (лише виміри зі зв'язком; дослівна функція виміру — немає варіанта), `rights_scope_set_of(p_user, p_scope_kind)` (лише вид скоупу з `setFunction: "membership"`; дослівна функція множини — немає варіанта), `rights_visible_users_of(p_user)`. Наявні функції лишаються окремими з власним тілом (не обгортками) — політики не отримують нового шару виклику. Відповідність варіанта: вираз поточного користувача → `p_user` **і** кожен вкладений виклик функції множини поточного користувача (`rights_my_scopes()`, `rights_my_members(…)`) → її варіант `_of` з `p_user`; `rights_scope_set_of` додає умову виду скоупу, якої немає в `<таблиця>_member_scopes`. Користувач `p_user` діє, лише коли він дійсний (`NOT <invalid>` «Користувачів», як у `current_user_id()`; без «Користувачів» — без умови); інакше варіанти порожні. Колонка `via` проходить `role_rows` і обидва `closurePass` лише як вихідна — у кортеж ідентичності призначення замикання вона не входить (інакше дія з дельти втратила б вимогу, яку дає рядок архетипу): помічник замикання (спільний з `rights_role_grants` 2c2, Р2c2-4) отримує перелік колонок параметром. **Уточнення обмеження Р2a1-25 / Р2a2-18:** «мої скоупи» обчислює лише шаблон `my_scopes` — `rights_my_scopes()` і `rights_scopes_of(p_user)` мають одне тіло з різним виразом користувача; інші функції читають членство лише за скоупами з нього; функції аналізу додатково читають членство скоупу запиту під гейтом Р2d2-3 (учасник і його користувач). Закріплення скоупу act-as (Рх22, П4) змінює одне місце — шаблон | правило «одна реалізація» без нового шару виклику в політиках; без варіантів `_of` `carrier_match` для зв'язку виміру, власності за учасником і межі тенанта не обчислити | спека прав §5.1 — речення про аргументи-сталі уточнюється для функцій аналізу (Задача 0) |
| Р2d2-3 | Гейт аналізу (вид скоупу завжди явний — id скоупу задає той, хто пише, Р2a1-26): виклик дає рядки, лише коли `rights_mine()` викликача має рядок `action = 'administerRights'` на мітці довідника «Призначення ролей» рівня запиту — рівень скоупу: `level = 'scope' AND scope = p_scope` і вид довідника = вид скоупу; глобальний (`p_scope_kind` і `p_scope` — нульовий uuid; для `rights_explain` нескоупленого об'єкта — без скоупу рядка): `level = 'global'`. Скоуп для `rights_who` — (`p_scope_kind`, `p_scope`); для `rights_explain` — вид скоупу об'єкта й колонка скоупу рядка. Рядки `rights_detail_of`, що повертають `rights_member` і `rights_who`, фільтруються за `level_id = p_scope_kind` (рядки контейнера — за видом скоупу контейнера) і `scope = p_scope`: адміністратор виду `team` з підлаштованим id не бачить учасників `org` | §5.1: аналіз розкриває чужі права й рядки поза власною видимістю | немає |
| Р2d2-4 | `rights_member` повертає `TABLE (object text, action text, extent text, dimension_id uuid, container uuid, role_id uuid, custom_role uuid, via text)` — права учасника в цьому скоупі (рядки `rights_detail_of(<користувач учасника>)` зі `scope = p_scope` чи контейнером цього скоупу). Учасник мусить належати скоупу запиту: рядок довідника членства чи прийнятого джерела виду `p_scope_kind` з `id = p_member` і скоупом `p_scope` (рядок джерела — з його умовами `where`, `sourceConditions`, Р2d1-15); інакше, як і для учасника без користувача чи неактивного, — порожньо (адмін A не дізнається, чи учасник B — користувач в A). Глобальна форма (`p_scope_kind`, `p_scope` — нульовий uuid): `p_member` — id користувача, рядки глобального рівня й `everyUser`. Рядки фільтруються за `level_id = p_scope_kind` (Р2d2-3). Набір прав (`RightsSet`) як походження в БД не тягнемо (без колонки `source` у `rights_projection`, архітектор, Ф13): набір — у designer `rights explain` П4 з `RightsProjectionRow.sources` | — | немає |
| Р2d2-5 | `rights_who` повертає `TABLE (user_id uuid, member uuid, role_id uuid, custom_role uuid, extent text, dimension_id uuid, container uuid)` — кожен учасник скоупу (`p_scope_kind`, `p_scope`) (довідник членства й прийняте джерело з його умовами `where`, Р2d1-15), у якого є рядок `rights_detail_of` з `level_id = p_scope_kind`, `scope = p_scope` (чи контейнером цього скоупу) і правом на (`p_action`, `p_object`) у будь-якому обсязі, під гейтом адміністрування цього скоупу. Нескоуплений об'єкт: роль рівня скоупу дає `read` на нескоуплені (Рх7), тож для скоупу — лише рядки ролей рівня цього скоупу (не глобальні, не `everyUser`, не інших тенантів, хоч `has_right` їх і рахує); з нульовим uuid (`p_scope_kind`, `p_scope`) — власники глобальних призначень і рядок ролі `everyUser` (`user_id IS NULL`, `member IS NULL` — кожен дійсний користувач), гейт — глобальне адміністрування. Відповідь — «хто має право через ролі цього рівня», не повна ефективна видимість. Повного переліку «усі тенанти» функція не дає: кожен скоуп — окремий запит свого адміністратора | інакше відповідь «хто читає Users» мовчки пропускала б учасників тенантів | немає |
| Р2d2-6 | `rights_explain` повертає `TABLE (policy text, kind text, extent text, has_right boolean, carrier_match boolean, roles uuid[])` — рівно по рядку на кожен предикат читання основної таблиці (`rightsPredicates(contract, "read", table)`, `kind = 'permissive'`) об'єкта з міткою `p_object` і рядок межі тенанта (`policy = '<t>_scope_read'`, `kind = 'restrictive'`; для «Користувачів» — межа видимості); `policy` — ім'я політики (`accessPolicyNames`); `roles` — архетипи й кастомні ролі, що дають право (масив, тож рядок один на предикат). `has_right` — за формою обсягу предиката: скоуплений об'єкт — рядок `rights_detail_of(p_user)` рівня скоупу зі скоупом рядка; контейнерний предикат — рядок рівня контейнера з контейнером рядка; нескоуплений — рядок рівня `<> 'container'` (як `has_right`, Р2a1-19). `carrier_match` — значення носія рядка ∈ множини `p_user` з варіантів `_of` (Р2d2-2); предикат без носія (`any`) — `TRUE`; рядок межі — `has_right` = `TRUE`, `carrier_match` — скоуп рядка ∈ `rights_scope_set_of`; для «Користувачів» (межа видимості без колонки скоупу, `buildAccessUnits`) — `p_row ∈ rights_visible_users_of(p_user)`. Множина дослівної функції (виміру чи множини скоупу) для `p_user` ≠ поточний користувач невідома — `carrier_match IS NULL`. **Рядок видно** ⇔ рядок межі має `carrier_match` і хоч один `permissive` рядок має `has_right AND carrier_match` (RESTRICTIVE — AND, PERMISSIVE — OR). Об'єкт з `publicRead` — один рядок `policy = '<t>_public_read'`, `kind = 'permissive'`, обидва прапорці `TRUE`, без рядка межі (`buildAccessUnits` не генерує для нього ні межі читання, ні політик прав); виняток — «Користувачі» з `publicRead`: межу видимості `buildAccessUnits` ставить незалежно від `publicRead`, тож її рядок лишається. Правило видимості: рядок межі (якщо він є — нескоуплені об'єкти, крім «Користувачів», межі читання не мають) має `carrier_match`, і хоч один `permissive` рядок має `has_right AND carrier_match`. **Користувач запиту:** (крім об'єкта з `publicRead` — його рядок видно кожному, тож пояснення фактів користувача не розкриває і перевірки членства `p_user` не має) `p_user` мусить належати скоупу рядка — є рядок `rights_scopes_of(p_user)` з видом скоупу об'єкта й скоупом рядка (той самий шаблон, що враховує й прийняте членство 2d1; `rights_scope_set_of` — лише для `carrier_match` рядка межі, де дослівна функція множини дає `NULL`) (для нескоупленого об'єкта — лише глобальний адміністратор може питати про будь-кого); інакше порожньо, як і без права: адмін A не дізнається фактів користувача, що належить лише B (його значень виміру в B). Підтримані лише об'єкти, основна таблиця яких має одноколонковий uuid-ключ (`p_row`); регістри (ключ рухів — реєстратор і рядок) і константи — порожньо, відоме обмеження. Невідома мітка чи рядок, якого немає, — порожньо (оракула наявності немає) | одні предикати з політиками — без розсинхрону TS і SQL; без даних рядка | немає |
| Р2d2-7 | `rights_journal_of` повертає рядки `simetra.rights_journal` з `scope_kind_id = p_scope_kind AND scope = p_scope` (пара, а не лише `scope`: uuid скоупів різних видів спільно не унікальні, Р2a1-26 — інакше адміністратор `team` з id, підлаштованим під тенант, читав би журнал `org`) в порядку `at DESC, seq DESC` (`at` однаковий у межах транзакції; колонки — усі колонки `simetra.rights_journal`, зокрема `relation`, Р2c2-12) щонайбільше `greatest(0, least(p_limit, 1000))` рядків (від'ємний ліміт — порожньо, а не помилка Postgres), під гейтом Р2d2-3 (архітектор, Ф6) | журнал читається лише адміністратором свого скоупу | немає |
| Р2d2-8 | **Гейт планів** (§5.4, архітектор Ф14): DB-тест `packages/simetra/test/db/rights-plan-gate.db.test.ts`, одне розгортання на опис, засів — по одному оператору `INSERT … SELECT … FROM generate_series(…)` на таблицю, далі `ANALYZE`; Форми запиту під `authenticated`: список (`ORDER BY <ключ> LIMIT 50`) і `count(*)` — над `task`, ТЧ `task_checklist` і рухами `TaskHours`; точкове читання за `id` — лише над таблицями з uuid-ключем (`task`, `task_checklist`). Усі політики `PERMISSIVE` складаються через OR для кожного користувача, а розмір множин планувальнику невідомий (`InitPlan`), тож форма плану від ролі не залежить: користувач гейта — учасник одного тенанта з `OrgMember` і з роллю, що дає `own` і вимір. Критерій на `EXPLAIN (ANALYZE, FORMAT JSON)`, за формою: **усі** — жодного вузла з `Parent Relationship = 'SubPlan'` (зокрема хешованого: корельований `EXISTS` під OR Postgres може захешувати, і `Actual Loops` тоді 1 — тому без умови на цикли, як у наявному `rights-policies.db.test.ts`); **точкове** — жодного `Seq Scan` цільової таблиці (будь-який індекс, зокрема ключ); **список і підрахунок** — жодного `Seq Scan` цільової таблиці, а умова на колонку скоупу (межа тенанта) стоїть в `Index Cond` **кожного** індексного вузла цільової таблиці (для `Bitmap Heap Scan` — кожного дочірнього `Bitmap Index Scan` під `BitmapOr`/`BitmapAnd`), а не лише у `Filter` (Р2d2-20). Індекс носія окремо не вимагається: межа тенанта (`RESTRICTIVE`) входить у кожен запит, і індекс зі скоупом першим — достатній доступ (§5.4: «скоуп і носій обмежують читання індексом» — скоуп обмежує). Обсяг і розкладка: для `= ANY(ARRAY(SELECT …))` планувальник оцінює 10 елементів, тож оцінена селективність межі — 10 / N тенантів; гейт бере N = 1000 тенантів по 20 задач (20 000 рядків `task`, 100 000 `task_checklist`, 10 000 рухів `TaskHours`), засів упорядкований за тенантом (фізична кореляція колонки скоупу висока — бітова карта читає мало сторінок). Перший крок Задачі 4 — проба EXPLAIN на цьому засіві до написання перевірок; якщо коректні політики все одно дають `Seq Scan`, — стоп і звіт архітектору з планами, критерій не послаблювати; бюджет — ≤ 30 с на файл; якщо не вміщується — звіт архітектору, критерій не послаблювати | §5.4: форма сама індексного доступу не гарантує | немає |
| Р2d2-9 | **Бенчмарк** (§5.4): проєкт Vitest `bench` у `packages/simetra/vitest.config.ts` (`include: ["bench/**/*.bench.db.ts"]`, той самий `globalSetup` сторожа, `fileParallelism: false`), скрипт `"bench:rights": "vitest run --project bench"` у `packages/simetra/package.json`; у `test:db` і CI не входить. Сценарії: (1) потужність значень виміру — 1 000, 5 000, 20 000 значень на користувача; (2) скоупи `fullAccess` — 100, 500, 2 000 скоупів на користувача; (3) розгалуження ТЧ — зміна носія власника з 100 000 і 300 000 рядків ТЧ (поширення 2a2); (4) крок копій 2b2 на таблиці з 1 000 000 рядків; (5) ціна тригерів запобіжників 2c2 на операторі з 1 000 рядків призначень (у контексті команди з JWT-актором, Р2d2-17). Вихід — таблиця Markdown у stdout (сценарій, обсяг, час списку/точкового/підрахунку чи оператора) | межі записуються в скіл (§5.4) | немає |
| Р2d2-10 | Межі за результатом бенчмарку записуються в скіл споживача (таблиця «Supported limits») і в позначку кроку плану. Попередження компілятора чи плану — лише за межею, яку видно з метаданих; якщо такої немає, попереджень план не додає (архітектор, Ф14). Якщо бенчмарк показує межу, видиму з метаданих, — стоп і звіт архітектору з числами, без вигаданих порогів | — | немає |
| Р2d2-11 | Уточнення Р2d2-2 за кодом 2c2 (інвентаризація 2026-10-30, архітектор): вираз користувача — параметр усіх генераторів, що зараз вшивають `CURRENT_USER` у тіла функцій прав: `mineBody` (зокрема гілка `everyUser`), `assignmentsCte` → `catalogAssignments`/`sourceAssignments` (нескоуплений рівень), `myScopesBody`, `visibleUsersBody`, гілка зв'язку `dimensionValuesBody`, `memberScopesFunction`. `closurePass(previous, { output, identity })` уже параметризований колонками і спільний з `roleGrantsBody` (2c2): `via` додається в обидва плечі `role_rows` і в `output` обох проходів, не в `identity`; `role_id` — наявна колонка `archetype`. Знімок `rights_tx_actor` і `actorCheck` 2c2 кличуть саму `rights_mine()` — їх не змінюємо; інваріант — дерево `rights_mine` з `mineBody(…, CURRENT_USER, false)` = дерево до рефакторингу (окремий unit-тест). Варіанти `_of` — форма `stable`, без `EXECUTE` (як `rights_role_grants`); функції аналізу — `definer` з явним `grants: ["user", "command"]` (типові `SET_ROLES` дають і сервісну роль) | перевірка ⊆ 2c2 лишається тією самою; одна реалізація без нового шару виклику | немає |
| Р2d2-12 | Індекс журналу прав `(scope_kind_id, scope, at DESC, seq DESC)` в `admin-tables.ts` — під `rights_journal_of` (вибірка скоупу з `ORDER BY at DESC, seq DESC LIMIT`); наявний `(xid, relation, row_id, seq)` служить лише першому образу. Гейт планів (Задача 4) покриває `rights_journal_of` на засіві з помітним журналом: жодного `Seq Scan` журналу | без індексу вибірка журналу скоупу — повний перебір із сортуванням | немає (спека журналу індексів не перелічує) |
| Р2d2-13 | Множина в умові предиката (`RightsCondition`, `kind: "column"`) — структуроване посилання (функція множини й аргументи), а не готовий текст: `renderCondition` рендерить наявний варіант функції, `rights_explain` — варіант `_of` з `p_user` або `NULL` для дослівної функції. Політики — байт-у-байт той самий SQL, що до зміни; тримає це тест «дерево в дерево» на політиках наявних фікстур. Зміна `predicates.ts` — мінімальна й окремим комітом (паралельна робота П4-A2 над тим самим `renderCondition`) | текстова заміна в SQL крихка | немає |
| Р2d2-14 | Засів DB-тестів: хелпер `insert` (`test/db/rights-seed.ts`) вмикає режим обслуговування для таблиць прав, перелік яких береться з контрактів прав моделі фікстури, а не з регулярки за іменем (регулярка мовчки пропустила б `team_*` і наступні види скоупу). Зміни призначення «адміністратором» у кейсах журналу — у контексті команди з JWT-актором, як у `rights-guards.db.test.ts` | після 2c2 пряме `INSERT` у таблиці прав поза контекстом команди відмовляє (`rights-context`) | немає |
| Р2d2-15 | Функції аналізу режиму обслуговування не знають: без JWT-користувача `rights_mine()` порожня, тож гейт Р2d2-3 дає порожньо. Обходу не додаємо — аналіз для оператора стеку дає designer `rights explain` (П4) | аналіз розкриває чужі права лише адміністратору прав | немає |
| Р2d2-16 | Гейт планів: критерій «жодного вузла `SubPlan`» записується і в §5.4 (замість «немає `SubPlan` з `loops > 1`»), разом з правкою Задачі 0. Мутація «без індексів зі скоупом першим на `task`» — `DROP CONSTRAINT … CASCADE` (UNIQUE `(org_id, id)` тримають складені FK ТЧ і рухів) у тестовій транзакції | наявний `rights-policies.db.test.ts` уже перевіряє «жодного `SubPlan`» | спека прав §5.4 (Задача 0) |
| Р2d2-17 | Бенчмарк, сценарій 5 (ціна тригерів запобіжників 2c2) — оператор у контексті команди з JWT-актором, не в режимі обслуговування (там запобіжники пропускають перевірку приросту, журнал і ключ `actor`, тож замір був би занижений); засів сценаріїв — у режимі обслуговування | — | немає |
| Р2d2-18 | Уточнення Р2d2-3/Р2d2-4 (рев'ю Задачі 1, архітектор): глобальна форма (`p_scope_kind`, `p_scope` — нульовий uuid) `rights_member` і `rights_who` бере, крім рядків `global` і `everyUser`, рядки `level = 'container'` контейнерів без виду скоупу — під тим самим глобальним гейтом: роль контейнерного рівня на нескоупленому контейнері призначається через глобальний довідник, тож її адмініструє глобальний адміністратор. Форма рівня скоупу цих рядків не бачить. Нескоуплений контейнер компілюється лише в проєкті без видів скоупу (інакше `rights.carrier-cross-tenant` / `rights.grant-level`), тож правило діє там; DB-кейс — Задача 3 (`unscoped-container`, окремий опис на проєкті без видів скоупу) | інакше права на нескоупленому контейнері не видно в жодному запиті | немає |
| Р2d2-19 | `rights_explain` пояснює лише рядок, видимий самому викликачу (рев'ю Задачі 2, архітектор): перевірка — ті самі предикати читання й межа, що й політики, обчислені тією самою функцією побудови рядків пояснення для `current_user_id()` (варіанти `_of` з поточним користувачем, дослівні функції — їхні справжні значення), з правилом видимості Р2d2-6; не видно — той самий порожній результат, що для неіснуючого рядка. Гілка об'єкта з `publicRead` — видима кожному, зокрема об'єкта без контракту прав (рядок `<t>_public_read`). DB-кейс — Задача 3 (`explain-caller-visibility`) | 2c2 не дає адміністратору прав призначити собі `read`, якого він не має (перевірка ⊆, Р2c2-26), тож `administerRights` без `read` — свідома конфігурація; `carrier_match` відкрив би носії рядка (виконавець, вимір, контейнер) | спека прав §5.1, абзац про аналіз прав |
| Р2d2-20 | Гейт планів (контрольна точка, архітектор): для списку й підрахунку умова скоупу — в `Index Cond` **кожної** гілки індексного доступу (кожен `Bitmap Index Scan` під `BitmapOr`/`BitmapAnd`, кожен `Index Scan`), а не хоча б однієї: гілка без скоупу означає, що один `PERMISSIVE`-предикат іде індексом через усі тенанти. Мутація — індекс одного предиката без скоупу першим → червоніє нове правило. Журнал прав у гейті — через `auto_explain` справжнього виклику (`SET LOCAL auto_explain.*` у точці збереження; бібліотека вже в `shared_preload_libraries` образу, `LOAD` недоступний) | на тисячах тенантів гілка без скоупу — та сама деградація, яку гейт має ловити | спека прав §5.4 |

## Відомі обмеження

- `carrier_match` для дослівних функцій виміру чи множини скоупу іншого
  користувача — `NULL` (Р2d2-6).
- Походження з набору прав — лише в designer `rights explain` (П4).
- `rights_explain` не пояснює рядків регістрів і констант (немає одноколонкового
  uuid-ключа) і рядків ТЧ (пояснюється рядок власника).
- Рівень, призначення якого дає лише прийняте джерело, не має довідника «Призначення ролей» — гейт аналізу там завжди порожній.
- `rights_who` відповідає в межах одного скоупу (чи глобального рівня); зведення
  за всіма тенантами — поза обсягом.
- Межі бенчмарку — заміри однієї машини; скіл записує обсяг і час разом із
  версією Postgres.
- Матриця ролей і екрани аналізу — П4 (§6.3).
- Функції аналізу в режимі обслуговування (без JWT-користувача) повертають порожньо (Р2d2-15).
- Межа тенанта з дослівною функцією множини скоупу: `rights_explain` (`SECURITY DEFINER`) виконує її від власника, тож RLS таблиць, які вона читає, не діє — пояснення може показати рядок видимим ширше, ніж політика. Поза скоуп не виходить: гейт і видимість викликачу (Р2d2-19) тримають (борг прав §2).
- Користувач із двома рядками учасника в одному скоупі (довідник членства й прийняте джерело без спільної унікальності) отримує свої права в `rights_member` і `rights_who` на обох `member`: права рахуються за користувачем (борг прав §2).

## Review Focus

1. **Аналіз без права:** учасник без `administerRights` викликає `rights_member`, `rights_who`, `rights_explain`, `rights_journal_of` для свого скоупу — порожньо; адміністратор скоупу A для скоупу B — порожньо. Тест — Задача 3 (`analysis-gate`).
2. **Пояснення не розкриває рядок:** `rights_explain` для рядка поза видимістю викликача-адміністратора іншого тенанта — порожньо; для неіснуючого id — порожньо, та сама форма. Тест — Задача 3 (`explain-oracle`).
3. **Гейт на ТЧ і регістрі:** не лише основна таблиця — ТЧ і регістр читаються індексом. Тест — Задача 4.
4. **Пояснення відповідає RLS для іншого користувача:** для кожного користувача засіву й кожного рядка тенанта правило видимості Р2d2-6 над `rights_explain(…, u)` збігається з тим, що `u` бачить під `authenticated`. Тест — Задача 3 (`explain-equivalence`).
5. **«Хто може» для нескоупленого об'єкта:** `rights_who('read', <«Користувачі»>, <org>, A)` дає учасників A з `TaskReaders`; з нульовим uuid (`p_scope_kind`, `p_scope`) — глобальних власників і рядок `everyUser` (`user_id IS NULL`). Тест — Задача 3 (`who`).

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/compiler/rights/functions.ts` | шаблон `mineBody`, `rights_scopes_of`, `rights_detail_of`, `rights_member`, `rights_who`, `rights_journal_of` |
| `packages/simetra/src/compiler/rights/explain-units.ts` (новий) | `rights_explain` |
| `packages/simetra/src/compiler/{sql/units,pipeline}.ts` | генератор `rightsExplain` |
| `packages/simetra/src/compiler/__tests__/rights-functions.test.ts`, `rights-explain.test.ts` (новий) | unit |
| `packages/simetra/test/db/rights-analysis.db.test.ts` (новий) | DB-опис функцій аналізу |
| `packages/simetra/test/db/rights-plan-gate.db.test.ts` (новий) | гейт планів |
| `packages/simetra/test/db/explain-plan.ts` (новий) | обхід плану `EXPLAIN (FORMAT JSON)` — спільний для гейта й бенчмарку (наявний `relationships` з `rights-policies.db.test.ts` переноситься сюди) |
| `packages/simetra/bench/rights.bench.db.ts` (новий), `packages/simetra/vitest.config.ts`, `packages/simetra/package.json` | бенчмарк |
| `packages/designer/skills/simetra-metadata/references/people-and-rights.md` | аналіз прав, межі |

---

### Задача 0: правки спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§5.1)

- [x] **Step 1:** §5.1, абзац «Імена (остаточні)»: речення «`simetra.authorize` і `simetra.rights_explain` лишаються формою» → «функції аналізу — `rights_member`, `rights_who`, `rights_explain`, `rights_journal_of` (Рх17); `simetra.authorize` лишається формою (П4)»; абзац про `EXECUTE`: «… сервісна роль (для неї — порожня множина, як функції скоупу й членства)» доповнити «; функцій аналізу сервісна роль не виконує» (Р2d2-1); речення «аргументи — лише сталі; поточного користувача читають з claims, ніколи з аргументу» доповнити «— для функцій множини й політик; функції аналізу приймають користувача чи учасника аргументом лише під гейтом адміністрування прав, а їхні внутрішні варіанти без `EXECUTE` кличуть лише вони» (Р2d2-2). §5.4, пункт гейта планів: «скоуп і носій обмежують читання індексом» → «межа скоупу обмежує читання індексом зі скоупом першим (носій — у межах скоупу; окремий індекс носія гейт не вимагає), не фільтром після повного перебору» (Р2d2-8); «немає `SubPlan` з `loops > 1`» → «жодного вузла `SubPlan`» (Р2d2-16).
- [x] **Step 2:** Run: `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [x] **Step 3: Commit**

```bash
git add docs/superpowers/specs
git commit -m "docs(spec): імена функцій аналізу прав"
```

---

### Задача 1: шаблон обчислення прав і функції аналізу учасника

**Files:**
- Modify: `packages/simetra/src/compiler/rights/functions.ts`, `compiler/membership-functions.ts` (`<таблиця>_member_scopes` — параметр виразу користувача для `rights_scope_set_of`), `compiler/rights/admin-tables.ts` (індекс журналу, Р2d2-12), `compiler/rights/predicates.ts` (окремим комітом, Р2d2-13)
- Test: `packages/simetra/src/compiler/__tests__/rights-functions.test.ts`

**Interfaces:**
- Produces: `RIGHTS_FUNCTIONS.scopesOf`, `.detailOf`, `.membersOf`, `.dimensionValuesOf`, `.scopeSetOf`, `.visibleUsersOf`, `.member`, `.who`, `.journalOf`; внутрішній `mineBody(contracts, physical, user: string, detail: boolean): string`; помічник замикання з переліком колонок параметром (той самий, що бере `rights_role_grants` 2c2).

- [x] **Step 1: Write the failing tests (unit):**
  - `it("no _of body reads the current user")` — жодне тіло `_of` не кличе `current_user_id`, `rights_my_scopes`, `rights_my_members` (мутація: лишити вкладений `rights_my_scopes()` у `rights_detail_of` — тест червоніє);
  - `it("each _of variant is the same body with the user argument")` — для кожної пари (`rights_my_scopes` / `rights_scopes_of`, `rights_my_members` / `rights_members_of`, гілка зв'язку `rights_dimension_values` / `rights_dimension_values_of`, `<таблиця>_member_scopes` / `rights_scope_set_of`, `rights_visible_users` / `rights_visible_users_of`) дерево варіанта = дерево наявної функції після відповідності Р2d2-2 (вираз користувача й вкладені функції множини → варіанти `_of`; умова виду в `rights_scope_set_of` і умова дійсності `p_user` — дозволені різниці); дослівна функція виміру чи множини скоупу варіанта не має.
  - `it("detail_of projects to mine")` — дерево `rights_detail_of` без колонок походження, з відповідністю Р2d2-2 у зворотний бік = дерево `rights_mine` (порівняння двох згенерованих тіл, а не зі знімком з `main`).
  - `rights_member`, `rights_who`, `rights_journal_of`: гейт Р2d2-3 у дереві (умова `administerRights` на мітці довідника призначень рівня); `rights_member` з'єднує `p_member` з членством виду `p_scope_kind` і скоупом `p_scope` (Р2d2-4); `rights_journal_of` — `greatest(0, least(p_limit, 1000))` і фільтр за парою `scope_kind_id = p_scope_kind AND scope = p_scope` (мутація: лише `scope` — рядок червоніє); `EXECUTE` — `user` і `command`, не `service`; внутрішні — без `EXECUTE`.
  - Мутації: прибрати гейт — тест гейта червоніє; прибрати з'єднання учасника зі скоупом — тест `rights_member` червоніє.
- [x] **Step 2:** Run: `pnpm --filter simetra test rights-functions` — FAIL.
- [x] **Step 3: Implement** за Р2d2-1…Р2d2-5, Р2d2-7, Р2d2-11…Р2d2-13; тест «дерево `rights_mine` з `CURRENT_USER` = дерево до рефакторингу» і тест «політики наявних фікстур — те саме дерево» (Р2d2-13).
- [x] **Step 4:** Run: `pnpm --filter simetra test rights && pnpm --filter simetra typecheck` — PASS.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): функції аналізу прав учасника, хто може й журнал — з одного шаблону прав"
```

---

### Задача 2: «чому рядок видно»

**Files:**
- Create: `packages/simetra/src/compiler/rights/explain-units.ts`
- Modify: `packages/simetra/src/compiler/sql/units.ts`, `compiler/pipeline.ts`
- Test: `packages/simetra/src/compiler/__tests__/rights-explain.test.ts`

**Interfaces:**
- Consumes: `rightsPredicates`, `renderCondition` (`predicates.ts`), `accessPolicyNames` (`access-units.ts`), `RIGHTS_FUNCTIONS.detailOf` (Задача 1).
- Produces: `buildExplainUnits(contracts, physical, provider, module, parse): SqlUnit[]` (генератор `"rightsExplain"`).

- [x] **Step 1: Write the failing tests (unit):** над `policyDomain()`: гілка `Task` має рівно по рядку на кожен предикат читання основної таблиці з ім'ям політики, що збігається з іменем згенерованої `<t>_read_*` (звірка з одиницями `buildAccessUnits`), і рядок межі тенанта (`kind = 'restrictive'`); `has_right` за формою обсягу (скоуп / контейнер / нескоуплений, Р2d2-6); предикат `any` — `carrier_match` = `TRUE`; зв'язок виміру `region` — через `rights_dimension_values_of(p_user, …)`; дослівна функція виміру (шар з дослівною функцією значень виміру — у `policyDomain()` вимір `region` має зв'язок) → `CASE WHEN p_user = current_user_id() THEN … ELSE NULL END`; гілка «Користувачів»: рядок межі з `carrier_match` через `rights_visible_users_of(p_user)`; гілка об'єкта з `publicRead` — без перевірки членства `p_user`; гілок для регістрів і констант немає; тіло не повертає колонок рядка. Мутація: пропустити один предикат — тест «по рядку на предикат» червоніє.
- [x] **Step 2:** Run: `pnpm --filter simetra test rights-explain` — FAIL.
- [x] **Step 3: Implement** за Р2d2-6.
- [x] **Step 4:** Run: `pnpm --filter simetra test rights-explain rights access && pnpm --filter simetra typecheck` — PASS.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): пояснення видимості рядка з предикатів політик читання"
```

---

### Задача 3: DB-опис функцій аналізу

**Files:**
- Create: `packages/simetra/test/db/rights-analysis.db.test.ts`
- Modify: `packages/simetra/test/db/rights-seed.ts` (перелік таблиць прав з моделі, Р2d2-14)

Причина DB-рівня (шапка): що функції аналізу повернуть на живих призначеннях, дельтах і рядках під роллю `authenticated` і що пояснення збігається з тим, що пропускає RLS.

- [x] **Step 1: Write the test** — один опис, одне розгортання, фікстура `policyDomain(writeRoles(), adminRoles())`, засів — два тенанти, адміністратор прав A (`RightsAdmin`), учасники з `OrgMember`, кастомна роль з дельтою, контейнерне призначення, глобальне. Кейси (`it.each`):
  - `analysis-gate` — Review Focus 1;
  - `member-rights` — `rights_member` для учасника з кастомною роллю: рядки дельти мають `via = 'delta'`, архетипу — `via = 'archetype'`;
  - `who` — `rights_who('read', 'task', <org>, A)` = учасники A з правом; для «Користувачів» у глобальній формі (нульовий uuid) — рядок `everyUser` (Review Focus 5);
  - `explain-equivalence` — адміністратор A для кожного користувача засіву `u` (зокрема тих, чий єдиний доступ — `own`, вимір чи контейнер) і кожного рядка `task` тенанта A: правило видимості Р2d2-6 над `rights_explain(…, u)` ⇔ рядок видно `u` через `queryAs` під `authenticated`. Сам адміністратор у переліку `u` не єдиний: його `read@any` відкрив би все й мутація не червоніла б;
  - `explain-oracle` — Review Focus 2; адміністратор A питає `rights_explain(рядок A, u)` про користувача u, що належить лише B, — порожньо;
  - `cross-kind` — фікстура опису додає `secondScopeKind()` і роль `TeamRightsAdmin` (`scopeKind: "team"`, `read` і `administerRights` на `TeamRoles`/`TeamRoleAssignments`); адміністратор `team` з id кореня `team`, підлаштованим під id тенанта A, викликає `rights_who('read', 'task', <team>, A)` — порожньо, хоч засіяний u8 — учасник і `team`-кореня A, і тенанта `org` A з `OrgMember` (його рядки `rights_detail_of` рівня `org` мають `scope = A`); `rights_member(<team>, A, <учасник org>)` — порожньо; `rights_journal_of(<team>, A, 100)` після зміни призначення в `org` A — порожньо, а позитивний контроль: `RightsAdmin` отримує непорожній `rights_journal_of(<org>, A, 100)`, `TeamRightsAdmin` після зміни призначення в `team` A — свій рядок;
  - `public-read` — `rights_explain` рядка `Bulletin` (`publicRead`) — один рядок `<t>_public_read`, без межі; так само для u, що належить лише B (рядок йому видно); `rights_explain('bulletin', <неіснуючий uuid>, u)` — порожньо (оракула наявності немає);
  - `explain-users` — актор — засіяний носій `GlobalAdmin` (глобальне призначення засіву), результат непорожній; для кожного `u` засіву й кожного рядка «Користувачів»: правило видимості над `rights_explain` ⇔ рядок видно `u` через `queryAs`;
  - `journal-of` — після зміни призначення адміністратором A — рядок журналу видно адміністратору A, не B;
  - `unscoped-container` — роль контейнерного рівня на нескоупленому контейнері видна глобальному адміністратору в `rights_member(0, 0, u)` і `rights_who(…, 0, 0)`, адміністратору скоупу — порожньо (Р2d2-18);
  - `explain-caller-visibility` — адміністратор прав скоупу A без `read` на об'єкт: `rights_explain(рядок A, u)` порожньо для будь-якого `u`; з `read` — пояснення є (Р2d2-19).
- [x] **Step 2:** Run: `pnpm --filter simetra exec vitest run --project db rights-analysis` — PASS. **Мутаційний доказ** (вручну): прибрати гейт `administerRights` → `analysis-gate`; прибрати `scope = p_scope` у гейті → `analysis-gate` (адмін A бачить B); прибрати фільтр `level_id = p_scope_kind` у `rights_who` → `cross-kind` (з'являються `org`-рядки u8); прибрати `scope_kind_id = p_scope_kind` у `rights_journal_of` → `cross-kind` (адміністратор `team` бачить журнал `org` A); `carrier_match` межі «Користувачів» = `TRUE` → `explain-users` (рядок користувача, що належить лише B, для учасника A з `read@any` на «Користувачах»); пропустити предикат контейнера в `rights_explain` → `explain-equivalence`; прибрати `container` з глобального плеча → `unscoped-container`; прибрати перевірку видимості рядка викликачу → `explain-caller-visibility`.
- [x] **Step 3: Commit**

```bash
git add packages/simetra/test/db
git commit -m "test(rights): функції аналізу прав на живих рядках"
```

---

### Задача 4: гейт планів

**Files:**
- Create: `packages/simetra/test/db/rights-plan-gate.db.test.ts`, `packages/simetra/test/db/explain-plan.ts`
- Modify: `packages/simetra/test/db/rights-policies.db.test.ts` (імпорт обходу плану з `explain-plan.ts` замість локального `relationships`)

Причина DB-рівня (шапка): форму плану на обсязі вирішує планувальник Postgres.

**Interfaces:**
- Produces: `planNodes(plan: unknown): PlanNode[]` (`PlanNode { type: string; relation?: string; indexes: string[]; conditions: string[]; parent?: string; loops?: number; filter?: string }` — `indexes` і `conditions` (`Index Cond`, `Recheck Cond`) для `Bitmap Heap Scan` збираються з дочірніх `Bitmap Index Scan` / `BitmapAnd` / `BitmapOr`), `subPlans(plan): PlanNode[]` (усі вузли з `Parent Relationship = 'SubPlan'`), `scansOf(plan, table): PlanNode[]`.

- [x] **Step 0: Probe** — засів Р2d2-8 і `EXPLAIN (ANALYZE, FORMAT JSON)` трьох форм над трьома таблицями вручну; плани — у позначку кроку. Якщо коректні політики дають `Seq Scan` — стоп і звіт архітектору.
- [x] **Step 1: Write the test** за Р2d2-8 і Р2d2-12 (плюс `rights_journal_of` на засіві з помітним журналом — жодного `Seq Scan` журналу): засів, `ANALYZE`, `it.each` над (таблиця × форма запиту): жодного вузла `SubPlan`; для точкового — жоден вузол `scansOf` не `Seq Scan`; для списку й підрахунку — жоден не `Seq Scan`, і колонка скоупу таблиці є в `conditions` індексного вузла. Записати час засіву й прогону в коментар-позначку кроку.
- [x] **Step 2:** Run: `/usr/bin/time -f %e pnpm --filter simetra exec vitest run --project db rights-plan-gate` — PASS і ≤ 30 с. **Мутаційний доказ** (вручну): замінити некорельовану форму `rights_own` на корельовану (`EXISTS` з посиланням на рядок) у згенерованій політиці — кейси червоніють на `SubPlan`; прибрати індекси, що починаються з колонки скоупу на `task` (`DROP CONSTRAINT … CASCADE` унікального `(org_id, id)` і індекси складених FK у тестовій транзакції, Р2d2-16) — кейси списку й підрахунку `task` червоніють на `Seq Scan` чи на відсутності умови скоупу в `conditions`.
- [x] **Step 3: Commit**

```bash
git add packages/simetra/test/db
git commit -m "test(rights): гейт планів політик прав на даних помітного обсягу"
```

---

### Задача 5: бенчмарк і межі

**Files:**
- Create: `packages/simetra/bench/rights.bench.db.ts`
- Modify: `packages/simetra/vitest.config.ts`, `packages/simetra/package.json`, `packages/simetra/tsconfig.json` (`include` додає `bench` — зараз там лише `src`, `test`, `scripts`), конфіг ESLint пакета (якщо `bench/` не охоплений), `packages/designer/skills/simetra-metadata/references/people-and-rights.md`

- [ ] **Step 1:** Проєкт `bench` і скрипт `bench:rights` за Р2d2-9, з `testTimeout` і `hookTimeout` 30 хв (типові 5 с перервали б сценарії на 100 000 і 1 000 000 рядків); перевірити, що `pnpm --filter simetra test:db` і `pnpm --filter simetra test` його не запускають (`.bench.db.ts` не збігається ні з `**/*.db.test.ts`, ні з `**/*.test.ts`).
- [ ] **Step 2:** Сценарії Р2d2-9, кожен — у власній транзакції з відкатом; SQL кроку копій (сценарій 4) — `carrierBackfillStatements` з `simetra/compiler` (2b2, Задача 1) над знімком фікстури, виконаний під `row_security = off` у тій самій транзакції (`COMMIT` не потрібен: міряється час оператора); об'єкти — через хелпери тегу прогону; перед сценарієм 4 перевірити вільне місце (сторож відмовляє на майже повному диску).
- [ ] **Step 3:** Run: `pnpm --filter simetra bench:rights` (у фоні, стек вільний) — код 0; таблицю результатів вставити в позначку кроку.
- [ ] **Step 4:** Межі — у скіл споживача (Р2d2-10): таблиця «Supported limits» англійською з обсягом, часом і версією Postgres. Якщо межу видно з метаданих — стоп і звіт архітектору.
- [ ] **Step 5:** Run: `pnpm format:check && pnpm lint && pnpm typecheck` — код 0.
- [ ] **Step 6: Commit**

```bash
git add packages/simetra/bench packages/simetra/vitest.config.ts packages/simetra/package.json packages/designer/skills
git commit -m "test(rights): бенчмарк меж прав поза test:db і межі в скілі"
```

---

### Задача 6: скіл, гейти й заміри

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/references/people-and-rights.md`, `docs/ROADMAP.md`, цей план (позначки)

- [x] **Step 1:** Скіл споживача (англійською): функції аналізу, гейт `administerRights`, `carrier_match IS NULL` для дослівних функцій, знімок прав для клієнта — з функцій аналізу й версій (2c2).
- [ ] **Step 2:** Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — код 0.
- [ ] **Step 3:** Run: `pnpm metadata:check && python3 scripts/check-doc-anchors.py && .agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-25-rights-2d2-analysis-plan-gate-benchmark.md` — код 0.
- [ ] **Step 4:** Повний `pnpm test:db` на одному SHA (у фоні, таймаут не коротший за 45 хв): `/usr/bin/time -f %e pnpm test:db` — код 0 (або CI job `db`); приріст проти прогону після 2c2 ≤ 40 с (гейт ≤ 30 с, аналіз ≤ 10 с), інакше звіт архітектору з розкладом за файлами.
- [ ] **Step 5:** ROADMAP — «Права-2 виконано»; позначки плану.
- [ ] **Step 6: Commit**

```bash
git add packages/designer/skills docs/ROADMAP.md docs/superpowers/plans/2026-10-25-rights-2d2-analysis-plan-gate-benchmark.md
git commit -m "docs(plan): Права-2d2 виконано — скіл, ROADMAP, позначки"
```

## Критерії приймання

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py` — зелені після **кожного** коміту; повний `pnpm test:db` — зелений на одному SHA, приріст записано (≤ 40 с).
- Тіло `rights_detail_of` проєктується на тіло `rights_mine`, а варіанти `_of` — на наявні функції (Задача 1, тести `detail_of projects to mine`, `each _of variant…`).
- Функції аналізу без `administerRights` у скоупі — порожньо; пояснення еквівалентне RLS на засіві (Задача 3).
- Гейт планів зелений на всіх таблицях, формах і обсягах (Задача 4).
- Бенчмарк поза `test:db`, межі в скілі (Задача 5).
- Спека прав §5.1 оновлена (Задача 0).
