# Права-2a1: роль команд, системні об'єкти прав і функції прав — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: прийнято архітектором задачі 2026-10-18 після трьох раундів аудиту; аудит Codex проведено, знахідки внесено.
Архітектор задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** база вміє обчислити права поточного користувача: існує роль
`simetra_command` (без DML), системні довідники «Ролі» й «Призначення ролей»,
згенеровані функції проєкції й функції множини прав у схемі `simetra`, а
будівник умов політик дає некорельовані предикати за правилом §5.4. Політик
таблиць цей план не змінює — їх перебудовує
план Права-2a2 (пишеться після приймання цього).

**Архітектура:**

- **T0** (`packages/simetra/src/model`): стала платформних ролей
  `PLATFORM_ROLES`; нові ролі довідника `rightsRoles` і `roleAssignments` у
  `CATALOG_ROLES` — стандартні колонки, стандартна ТЧ дельти, лише дія `read`,
  поза селекторами.
- **T1** (`packages/simetra/src/compiler`): перевірки й контракт системних
  довідників (`compiler/rights/system-catalogs.ts`); генератор `rights`
  (`compiler/rights/functions.ts`) — функції даних прав (проєкція з розгорнутим
  `fullAccess`, вимоги, домен рівня, рівні ролей) і функції множини;
  будівник умов (`compiler/rights/predicates.ts`); `EXECUTE` наявних функцій і
  `USAGE` схеми `simetra` — також ролі команд.
- **T2** (`packages/simetra/src/schema/apply`): потрібні ролі — за деревами
  всього бажаного SQL; спільна передперевірка (`plan`, `diff`, репетиція
  `apply`) читає `pg_roles` цілі й сервера тіні й відмовляє без ролі чи з
  небезпечною формою.
- **`@simetrajs/designer`**: інструмент `roles` (CLI `simetra roles`) створює
  відсутні платформні ролі.
- **Стек**: `supabase/roles.sql`, pgTAP базового стану.

**Стек:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query (WASM),
локальний стек Supabase (Postgres 17), pgTAP.

**Спека:** [спека прав](../specs/2026-10-17-rights-design.md) — читати повністю,
головне §2 (Рх5, Рх7, Рх9, Рх10, Рх15, Рх18), §4.6, §5.1, §5.4, §7, §8;
[платформна спека](../specs/2026-09-24-simetra-platform-design.md) §4 «Скоуп»,
§6.7, §6.8, §6.9, §12; [спека системної схеми й користувачів](../specs/2026-10-07-system-schema-users-design.md)
§3, §7, §8; [спека designer](../specs/2026-10-02-simetra-designer-design.md)
§3.2. Плани [Права-1a](2026-10-18-rights-1a-carriers-contract.md) і
[Права-1b](2026-10-18-rights-1b-sets-roles.md) — їхні таблиці рішень діють.

**Залежність:** Права-1a і 1b виконано (до `6c8146f`): є `Contracts.rights`,
`Contracts.roles`, `Contracts.rightsProjection`, `Contracts.accessDimensions`,
`RightsContract`, `RoleContract`, `RightsProjectionRow`, `CompiledAssignedOn`,
`CompiledRoleLevel`, `expandRole`, `membershipOfScopeKind`, коди
`rights.users-missing`, `rights.scope-without-membership`. Перед стартом
виконавець запускає `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-18-rights-2a1-command-role-functions.md`
і звіряє ці імена з кодом.

**Поділ Прав-2** (погоджено архітектором): 2a1 (цей план) → 2a2 «політики
читання й носії» → 2b «запис, ефекти, крок даних носіїв» → 2c «запобіжники,
версії, аудит, заборона дослівних політик і тригерів» → 2d «прийняті джерела,
аналіз прав, гейт планів, бенчмарк». Кожен план — окремий запуск із зеленими
гейтами.

## Global Constraints

- Усі обмеження планів Права-1a і 1b (їхні розділи «Global Constraints») діють і тут: T0 лише на `zod`, строгі схеми, реєстр замість назви виду, без шимів, індекс посилань і ратчет полів без нових винятків, коди en/uk у `MESSAGES` і `messages.test.ts`, регенерація JSON Schema (`UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`), коміти українською без трейлерів, синтетичні приклади.
- 🔴 `pnpm --filter <pkg> test <pattern>` — **без** `--` перед шаблоном.
- 🔴 Ім'я ролі команд у коді — лише через `PLATFORM_ROLES.command`, ролей API — лише через `PROVIDER_API_ROLES[provider]`; літерала `"simetra_command"` поза T0, `supabase/roles.sql` і pgTAP немає.
- 🔴 Роль кластерна: її немає в бажаному SQL (двигун і так відхиляє `create role`, `engine.desired-rejected`) і в гейті (платформна спека §6.9). Роль — `NOLOGIN NOINHERIT` без `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, `REPLICATION`; не входить у жодну роль; член допустимий лише з `ADMIN` і лише такий, що сам має `SUPERUSER` чи `CREATEROLE` (нічого не здобуває); `GRANT simetra_command TO …` не генерує й не виконує ніхто (це П4). DML-грантів таблиць виду їй не дає ніхто.
- 🔴 План (`plan`) лише читає ціль і сервер тіні; роль створює тільки інструмент `roles`.
- 🔴 Кожна функція прав: `LANGUAGE sql`, `SET search_path = ''`, кваліфіковані відношення, тіло через `AS $tag$ … $tag$` (не `BEGIN ATOMIC`/`RETURN`); поточного користувача — лише `(SELECT "simetra"."current_user_id"())`; аргументи — лише сталі (дія, мітка об'єкта, обсяг, вимір), ніколи носій рядка чи користувач.
- 🔴 «Мої скоупи» (учасник поточного користувача за видом скоупу) обчислює **лише** `simetra.rights_my_scopes()`; інші функції читають членство лише за скоупами з неї (Р2a1-25; закріплення скоупу Рх22 пізніше змінює одне місце).
- 🔴 **Кожна множина учасників і скоупів типізована видом скоупу** (Р2a1-26): `id` довідника задає той, хто пише, тож UUID без виду нічого не означає; кожне з'єднання з `rights_my_scopes()` — і за `scope_kind_id`.
- 🔴 Fail-closed: невідома мітка, дія, обсяг, вимір, архетип чи рівень у даних дельти чи призначення — рядок прав не діє, без помилки.
- Помилки компілятора — лише на моделі; на даних цілі (призначення, дельти) — жодних винятків, лише порожні множини.
- DB-тест — лише для того, що вирішує Postgres (результат функцій під роллю, ACL, атрибути ролі); SQL-текст — unit. Скіл `.agents/skills/writing-tests/SKILL.md` обов'язковий перед кожним кроком тестів.
- Стек: один на машину й спільний. Не зупиняти його, не створювати й не видаляти ролей без тегу прогону, крім одноразового `simetra roles` за Задачею 2 (поза прогоном, див. там).
- Репо публічне: імена, таблиці, схеми споживача — ніде.

## Рішення плану

Розвилки Р-А, Р-Б, Ф1, Ф4, Ф5, Ф6 вирішив архітектор задачі 2026-10-18.

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р2a1-1 | `simetra_command` з'являється з Прав-2 як роль середовища без DML: T0 `PLATFORM_ROLES = { command: "simetra_command" }`; на базі споживача її створює інструмент `roles`, на локальному стеку — `supabase/roles.sql`; `simetra_runtime`, гранти DML і перемикання ролі — П4 | платформна §6.7 (речення про появу ролей), §12 (рядок П3, п.5 порядку); спека прав §8 п.2; спека designer §3.2 — Задача 0 |
| Р2a1-2 | Потрібні ролі — `requiredPlatformRoles(desiredSql, parse)` у T2 за деревами розбору **всього** бажаного SQL (рендер моделі й стан застосування `renderApplyState`, який без «Користувачів» сам вставляє `platformSchemaGrants`) — одне місце правди. Спільна передперевірка T2 `checkPlatformRoles` (за зразком `checkOwnerMembership`) читає їх на цілі й на `shadowBase` до будь-якої тіні: у `buildPlan` — до розгалуження промоції, у `diff` і в репетиції `apply`. Відсутня — `plan.platform-role-missing`; форма порушена (`LOGIN`, `INHERIT`, будь-який із `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, `REPLICATION`, входить у роль, член з `INHERIT` чи `SET`, член з `ADMIN` без `SUPERUSER`/`CREATEROLE`) — `plan.platform-role-shape`. Член лише з `ADMIN`, що сам має `SUPERUSER` чи `CREATEROLE` (Postgres 16+ дає такий грант творцеві), нічого не здобуває й допустимий. Назва коду загальна, бо `simetra_runtime` (П4) піде тим самим шляхом | немає |
| Р2a1-3 | Інструмент designer `roles` (каталог інструментів плаский, тож CLI — `simetra roles`, а не `roles ensure`), вісь `database: "write"`, `files: "read"`: створює кожну відсутню роль `PLATFORM_ROLES` як `NOLOGIN NOINHERIT` на цілі й на сервері тіні, наявну лише звіряє; без `CREATEROLE` — відмова `roles.create-role-denied`, нічого не створено. Перед `CREATE ROLE` — `SET LOCAL createrole_self_grant = ''` у тій самій транзакції: налаштування сесії чи кластера (`'set, inherit'`) інакше дало б творцеві членство з `INHERIT`/`SET`, і власний результат `roles` не пройшов би `plan.platform-role-shape`; так творець отримує рівно `ADMIN` | спека designer §3.2 (Задача 0) |
| Р2a1-4 | `EXECUTE` функцій членства, оголошених функцій множини скоупу й `current_user_id`, а також `USAGE` на `simetra` отримує й роль команд (призначення `command` в `executeGrants`) | немає (§6.7 уже так каже) |
| Р2a1-5 | Системні об'єкти прав — довідники з ролями `rightsRoles` і `roleAssignments`. Рівень — власний `scope` довідника: вид скоупу → рівень скоупу, `none` → глобальний. Один довідник на (роль, рівень). Рівень із ролями (рівня скоупу, глобальними чи контейнерними, чий контейнер у цьому виді скоупу), не покритий прийнятим джерелом (Р2a1-24), без обох довідників — помилка з підказкою `simetra create`. Довідник ролі, скоуплений видом без членства, — помилка. Контейнерна роль, чий контейнер лежить у виді скоупу без членства, — помилка ролі `rights.scope-without-membership` на `/assignedOn/container`: її призначення лежать у довідниках цього виду й не дісталися б нікому. «Версії прав» і «Журнал прав» — 2c | спека прав §4.6 (Задача 0) |
| Р2a1-6 | `rightsRoles` має стандартні колонки `archetype` (uuid, NOT NULL, UUID ролі метаданих, без FK) і `order` (integer); назва — стандартне найменування (довжина > 0 обов'язкова). Стандартна ТЧ `delta` (`<таблиця>_delta`, id ТЧ — `<objectId>#delta`): `object` (text, мітка виду), `action` (text, слово словника чи UUID кастомної дії), `extent` (text, `any`/`own`/`dimension`), `dimension` (uuid, NULL поза `dimension`), `effect` (text, `allow`/`deny`) | немає (§4.6, Рх18) |
| Р2a1-7 | `roleAssignments`: `subject` (uuid NOT NULL; складений FK на довідник членства свого виду скоупу, у глобальному довіднику — FK на «Користувачів»), `archetype` (uuid, без FK), `custom_role` (uuid; у скоупленому довіднику — складений FK `(скоуп, custom_role)` на `rightsRoles` того самого рівня, у глобальному — FK за id: інакше призначення в A посилалося б на кастомну роль B з її дельтами), `container` (uuid, без FK: цілі — різні довідники-контейнери); `CHECK (num_nonnulls(archetype, custom_role) = 1)`. Контейнерні призначення лежать у довіднику виду скоупу контейнера (в однотенантному — у глобальному). **Контейнер призначення — у тенанті призначення й лише для контейнерного архетипу:** `rights_mine` бере колонку `container` лише для архетипів контейнерного рівня й лише через inner join з основною таблицею виду контейнера (з рівня архетипу) за тим самим скоупом, що в призначення (нескоуплений контейнер — за видом контейнера, а не за довідником призначень — лише існування); `NULL`, неіснуючий чи чужий контейнер дає нуль рядків (fail-closed). Для архетипів інших рівнів `container := NULL`, хоч би що лежало в колонці | спека прав §4.6 — речення «контейнер призначення — у тенанті призначення» (Задача 0) |
| Р2a1-8 | Системні об'єкти прав мають лише дію `read` (запис — дія адміністрування прав у 2c) і не підпадають під `grantAll` і `withAction`: їх дає лише явний грант | спека прав §4.6 (Задача 0) |
| Р2a1-9 | `fullAccess` розгортається на рендері проєкції в явні рядки: кожна дія (стандартна й кастомна) кожного об'єкта рівня на кожному підтриманому обсязі (`any`, породжені `own` і виміри), для ролі рівня скоупу — ще `read` нескоуплених. Гілки обходу в SQL немає. Кастомна роль на такому архетипі отримує ці рядки й свої дельти, але носієм `fullAccess` для §7 не є | Рх5, §5.1 (рядок `any`), §4.6, §7 (Задача 0) |
| Р2a1-10 | Функції прав повертають лише скоупи (чи контейнери) з правом — єдину множину, що залежить від гранту; мої id учасника й мої значення виміру — окремі функції без гранту. Умова `own` — `<носій> = ANY(мої id) AND <скоуп> = ANY(rights_own(...))`, носій на «Користувачів» — `<носій> = (SELECT current_user_id())` замість першої множини | §5.1, рядки `own` і вимір (Задача 0) |
| Р2a1-11 | Граф вимог замикається в межах одного призначення: рядок кастомної ролі діє, лише якщо в тій самій ролі в тому самому скоупі (і контейнері) є кожна вимога на тому самому обсязі чи на `any`; вимога з іншої ролі дії не рятує — роль самодостатня, як у 1С, і передбачувана для адміністратора. Замикання — рівно два проходи (`closure_1`, `closure_2`): над транзитивним `rights_requires` (`RightsAction.requires` — замикання) це найбільша нерухома точка за будь-якої висоти графа — перший прохід фіксує шар `any` (req(y) ⊆ req(x)), другий — шари `own` і вимірів; один прохід недостатній через різницю обсягів (`post@own`, `update@any` без `update@own`, `read@own` без `read@any`), а рекурсивний CTE віднімання не виражає. Доказ — коротким коментарем «чому» в генераторі. Архетипи вже замкнені компілятором (`rights.requires-missing`) | Рх9 — «в межах однієї ролі (призначення)» (Задача 0) |
| Р2a1-12 | Домен рівня — згенерована множина допустимих (рівень, об'єкт, дія, обсяг) з тих самих правил, що `expandRole` (`allowedActions`, `levelAllowsExtent`, підтримані обсяги). Дельта `allow` поза доменом рівня архетипу, дельта-сирота, кастомна роль на архетипі іншого рівня чи на зниклому архетипі, призначення архетипу чужого рівня — не діють. Рівень зберігання кожного архетипу генератор вшиває сталою в `rights_roles` з `rightsLevelOf` (скоуп → свій вид; контейнер → вид скоупу контейнера чи глобальний; глобальний → глобальний; `everyUser` і рівень, покритий джерелом, → немає): призначення в довіднику рівня L бере архетип, лише якщо його рівень зберігання — L | немає (§7 «дельта-сирота ігнорується») |
| Р2a1-13 | Призначення чи кастомна роль з позначкою видалення не діє. Членство фільтрується так само, як у `member_scopes` (наявний рядок із непорожнім користувачем); «активність членства» запобіжника §7 — 2c | немає |
| Р2a1-14 | Функції даних прав (`rights_projection`, `rights_requires`, `rights_domain`, `rights_roles`) — `IMMUTABLE`, без `SECURITY DEFINER`, без `EXECUTE` будь-кому: їх кличуть лише функції `SECURITY DEFINER` від власника. Функції множини й помічники — `STABLE SECURITY DEFINER`, `EXECUTE` — роль запиту користувача, сервісна роль і роль команд | §5.1 — функції даних `IMMUTABLE`, без definer і `EXECUTE` (Задача 0) |
| Р2a1-15 | Генератор `rights` дає функції, лише коли в проєкті є хоч одна `Role` | немає |
| Р2a1-16 | Тіло стандарту SQL (`BEGIN ATOMIC`, `RETURN`) відхиляє `setFunctionClosedProblem` — причина `sqlBody` для функції множини скоупу; перевірка функцій виміру бере її звідти ж (закриває борг §5) | немає |
| Р2a1-17 | Будівник умов (Ф5) — у 2a1 і перевіряється правилом §5.4 тут; рендер політик з нього — 2a2 | немає |
| Р2a1-18 | DB-сценарій розгортає схему **раз на опис** (`describe`): `beforeAll` відкриває транзакцію, розгортає й засіває, кожен `it` працює через `queryAs` (точка збереження), `afterAll` — `ROLLBACK`. Описів два — проєкт з видом скоупу й однотенантний (A1). `signUp` — спільний помічник `test/db/auth.ts` (третя копія) | немає |
| Р2a1-19 | Кожна функція множини фільтрує рядки `rights_mine()` за рівнем, по одному запобіжнику на функцію: `rights_any`/`rights_own`/`rights_dim` — `level = 'scope'` (глобальні рядки — лише через `has_right`); `rights_container` — `level = 'container'`; `has_right` (нескоуплені об'єкти) — `level <> 'container'`: інакше в однотенантному проєкті контейнерна роль на одному проєкті відкрила б задачі всіх проєктів, а контейнерна роль — увесь тенант | немає |
| Р2a1-20 | Довідник прав належить лише своєму рівню: правила рівня (`allowedActions`, звідки домен, `expandRole` і розгортання `fullAccess`) не дають довідників `rightsRoles`/`roleAssignments` іншого рівня — роль рівня скоупу не отримує `read` нескоуплених глобальних довідників прав (хто адмін платформи), явний грант на них — `rights.grant-level` | спека прав §4.6, речення поруч із Р2a1-8 (Задача 0) |
| Р2a1-21 | Ролі разом із прийнятими джерелами (`membershipSources`, `assignmentSources`) — **попередження** `rights.adopted-source-unsupported` на кожне джерело з текстом про наслідок: «права з прийнятого джерела ще не обчислюються: учасники джерела не отримають прав на об'єкти виду» (uk; en — той самий зміст; мітки плану в тексті повідомлення немає — його читає споживач): функції 2a1 джерел не читають, тож межа fail-closed — прав менше, а не більше. Попередження, а не помилка: `kitchen-sink.ts` має ролі й джерела, а ратчет полів вимагає його компіляції без помилок, тож помилка потребувала б нового винятку ратчета; валідація джерел і `sourceKeys` лишається досяжною. 2d попередження прибирає | немає |
| Р2a1-23 | Факт «системний довідник прав» — `RightsContract.system?: "rightsRoles" \| "roleAssignments"` з хука реєстру `KindDefinition.rightsSystem?(obj)` (довідник — з `CATALOG_ROLES`), без гілки за назвою виду; його читають селектори (Р2a1-8), правило рівня (Р2a1-20) і перевірки системних довідників | немає |
| Р2a1-24 | Рівні з прийнятим джерелом призначень (Рх14 — на рівні або системні об'єкти, або прийнята таблиця). Рівень тут — рівень призначення (`assignedOn`), як у джерела; системні довідники обслуговують рівень зберігання, що об'єднує рівень скоупу й контейнерні рівні свого виду. Правила: (1) рівень призначення з ролями, покритий `assignmentSources`, системних довідників не потребує — `rights.system-catalog-missing` на ньому не спрацьовує, межу показує попередження джерела (Р2a1-21); (2) архетипи рівня, покритого джерелом, мають у `rights_roles` зберігання `NULL`, тож рядок у довіднику призначень їх не вмикає — паралельної системи на рівні немає; (3) системні довідники рівня зберігання, усі рівні призначення якого покриті джерелами, — помилка `rights.system-catalog-parallel` (Рх14); (4) довідник прав, скоуплений видом, чиє членство дає лише джерело, — `rights.system-catalog-scope` до 2d (у `subject` немає цілі). Змішування в одному виді скоупу (джерело на контейнерному рівні, довідники для рівня скоупу) дозволене: це сценарій першої міграції — прийняті призначення поряд із новими ролями | немає (Рх14) |
| Р2a1-25 | Уточнення обмеження «мої скоупи» (рішення архітектора під час плану 2a2, Р2a2-18): «мої скоупи обчислює лише `rights_my_scopes`; інші функції читають членство лише за скоупами з неї». У 2a1 таблиці членства читає лише `rights_my_scopes`; функція видимих «Користувачів» плану 2a2 читає членство інших учасників саме за скоупами з неї | немає |
| Р2a1-26 | Кожна множина учасників і скоупів типізована видом скоупу: призначення зіставляються з `rights_my_scopes()` за (вид довідника призначень, скоуп, учасник), контейнер — за видом скоупу виду контейнера; «мої id учасника» — `rights_my_members(p_scope_kind uuid)`, будівник умов передає вид скоупу об'єкта, гілка зв'язку виміру — вид довідника суб'єкта. Без виду учасник одного виду з підлаштованими `id` кореня й учасника (ключ довідника задає той, хто пише: `keyColumn(false)`, без значення за замовчуванням) «успадкував» би призначення чи власність учасника іншого виду | спека прав §5.1 — «мої id учасника й мої скоупи — за видом скоупу» (Задача 0) |
| Р2a1-27 | `AccessDimensionContract.values.relation.subjectTarget: { users: true } \| { membership: <scopeKindId> }` — генератор гілки зв'язку виміру знає ціль суб'єкта, не виводячи її з FK | немає |
| Р2a1-28 | Позначка видалення контейнера прав не відкликає: `rights_mine` не фільтрує контейнери за позначкою — зняти її може лише той, хто має права на контейнер; права зникають із вилученням контейнера | спека прав §4.6 |
| Р2a1-29 | Носій власності знає свою ціль: `OwnershipContract.owner: { users: true } \| { membership: <scopeKindId> }` — з резолвленої цілі посилання (роль довідника «Користувачі» чи членство виду скоупу об'єкта), ніколи з назви виду чи таблиці; будівник умов обирає за ним форму `own` (Р2a1-10), не виводячи її з FK | немає |
| Р2a1-22 | Контракти прав для генератора — `Pick<Contracts, "rights" \| "roles" \| "rightsProjection" \| "rightsCatalogs" \| "accessDimensions" \| "membership">`, обчислені до `sqlUnits`; `rightsCatalogs` передається в `buildContracts`, а не будується з `sqlUnits`, — без циклу в `pipeline.ts` | немає |

## Відомі обмеження

- Стеля агента (Рх12) і закріплення скоупу act-as (Рх22) — з механізмом
  агентів у П4 (рішення архітектора Ф6); помічник `rights_my_scopes` — єдине
  місце, яке тоді зміниться.
- Прийняті джерела членства й призначень (§4.7) — 2d: тоді
  `rights_my_scopes` і читання призначень отримують гілки джерел.
- Функції прав нічого не захищають, доки їх не викличе політика (2a2): до
  того їх перевіряє DB-сценарій і будівник умов.
- Перевірки плану над даними цілі (Рх20: дельти-сироти, прямі призначення
  видаленого архетипу) — 2c; тут сироти лише не діють.
- `rights_mine` обчислює всі права користувача на кожен виклик функції
  множини, а одна політика може кликати кілька; ціну міряють гейт планів і
  бенчмарк плану 2d.
- Правило форми ролі «жодного члена з `SET`» П4 послабить для
  `simetra_runtime → simetra_command WITH SET` (Р21); правка — разом із
  `simetra_runtime`.
- Прийняті джерела з ролями — попередження `rights.adopted-source-unsupported`
  до плану 2d: джерела не діють (Р2a1-21). **Для 2a2:** коли політики
  почнуть залежати від прав, 2a2 вирішує, чи лишити попередження, чи посилити
  його до відмови плану — проєкт із джерелами без ролей у довідниках Simetra
  втратить доступ до таблиць виду.
- Значення дельти функції прав порівнюють як текст: `deny` з UUID дії в
  іншому регістрі нічого не забороняє. Перевірка й канонізація значень дельти
  на шляху запису (2c, Рх20) мусить це покрити.

## Review Focus

1. **Замикання вимог з різницею обсягів:** архетип з `post@any` і `unpost@any`, дельта `deny read@any` — обидва не діють; дельти, що лишають `post@own`, `update@any` і `read@own`, — `post@own` не діє (другий прохід). Тест — Задача 8 (кейси `closure`, `closure-chain`, `closure-extents`).
2. **Контейнер витікає за свої межі:** призначення в A з контейнером тенанта B; контейнерний архетип з `container = NULL`; неконтейнерний архетип з заповненою колонкою `container`; в однотенантному проєкті контейнерна роль на одному проєкті — жодне не відкриває більше за свій контейнер. Тест — Задача 8 (`foreign-container`, `container-null`, `container-ignored`, `container-only`, `single-tenant-container`), Задача 4 (складений FK `custom_role`).
3. **Права чужого рівня чи виду:** роль рівня скоупу не читає глобальних довідників прав; архетип чужого рівня в призначенні чи кастомна роль на архетипі іншого рівня не діють; учасник іншого виду скоупу з підлаштованими `id` не успадковує ні призначень, ні власності. Тест — Задача 6, Задача 8 (`global-catalog`, `level-mismatch`, `cross-kind-assignment`, `cross-kind-own`).
4. **Недійсний користувач, сервісна роль, позначка видалення:** порожні множини й `false`, без помилки. Тест — Задача 8 (`invalid-user`, `service-role`, `deletion-mark`, `custom-deletion-mark`).
5. **Ціль чи сервер тіні без ролі команд чи з небезпечною формою:** план відмовляє й називає сервер; `roles` без `CREATEROLE` відмовляє й нічого не створює. Тест — Задача 2.

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/model/schemas/project.ts` | `PLATFORM_ROLES`, `PlatformRolePurpose`, `GrantPurpose` |
| `packages/simetra/src/model/schemas/catalog.ts` | `role` — `"users" \| "rightsRoles" \| "roleAssignments"` |
| `packages/simetra/src/model/kinds/catalog.ts` | `CATALOG_ROLES`: колонки від довідника, ТЧ дельти, лише `read`, поза селекторами |
| `packages/simetra/src/model/kinds/standard.ts` | `StandardColumnDef.ref` — `"member"`, `"rightsRoles"`; `StandardTabularSectionDef`; `KindDefinition.standardTabularSections?`, `KindDefinition.rightsSystem?` |
| `packages/simetra/src/compiler/stages/model.ts` | стандартна ТЧ, цілі `member` і `rightsRoles` |
| `packages/simetra/src/compiler/rights/system-catalogs.ts` (новий) | рівні системних довідників, перевірки, `rightsCatalogContracts` |
| `packages/simetra/src/compiler/rights/expand.ts` | селектори пропускають несекторні об'єкти |
| `packages/simetra/src/compiler/rights/functions.ts` (новий) | генератор `rights`: функції даних і множини |
| `packages/simetra/src/compiler/rights/predicates.ts` (новий) | будівник умов §5.4 |
| `packages/simetra/src/compiler/contracts.ts` | `RightsCatalogContract`, `Contracts.rightsCatalogs` |
| `packages/simetra/src/compiler/sql/{execute-grants,units,function-shape}.ts` | призначення `command`, генератор `rights`, `sqlBody` |
| `packages/simetra/src/compiler/{membership-functions,function-execute,pipeline,diagnostics,messages}.ts`, `platform/units.ts` | ролі виконання, підключення, коди |
| `packages/simetra/src/compiler/rights/dimension-functions.ts` | `sqlBody` — із загальної перевірки |
| `packages/simetra/src/schema/apply/platform-roles.ts` (новий), `plan.ts` | потрібні ролі, читання ролей і відмови плану |
| `packages/designer/src/tools/{apply-tools,database-tools}.ts` | передперевірка ролей у `diff` і в репетиції `apply` |
| `packages/designer/src/tools/roles-tool.ts` (новий), `tools/catalog.ts`, `tools/types.ts` | інструмент `roles` |
| `supabase/roles.sql` (новий), `supabase/tests/provider-base-state.test.sql` | роль у базовому стані стека |
| `packages/simetra/test/db/auth.ts` (новий), `access.db.test.ts`, `membership.db.test.ts`, `platform-users.db.test.ts` | спільний `signUp` |
| `packages/simetra/test/db/provider-roles.db.test.ts` (новий) | `supabase/roles.sql` під `postgres` |
| `packages/simetra/test/db/rights-functions.db.test.ts` (новий) | DB-сценарій функцій прав |
| `packages/simetra/src/compiler/__tests__/fixtures/{rights,kitchen-sink}.ts` | системні довідники в ролях фікстури |
| `packages/designer/skills/simetra-metadata/SKILL.md` | системні довідники прав, `simetra roles` |

Системні довідники фікстури `fixtures/rights.ts` — частина шару
`rolesAndSets()` (не типових файлів 1a): `OrgRoles` (`role: "rightsRoles"`,
`scope: "org"`), `OrgRoleAssignments` (`role: "roleAssignments"`,
`scope: "org"`), `GlobalRoles` і `GlobalRoleAssignments` (`scope: "none"`).
Експорти: `ORG_ROLES_FILE`, `ORG_ASSIGNMENTS_FILE`, `GLOBAL_ROLES_FILE`,
`GLOBAL_ASSIGNMENTS_FILE`. Бо системні довідники мають лише `read` і поза
селекторами (Р2a1-8), рядки проєкції тестів 1b не змінюються.

---

### Задача 0: правки спек і боргу

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (Рх5, §4.6, §5.1, §7, §8)
- Modify: `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (§6.7, §12)
- Modify: `docs/superpowers/specs/2026-10-02-simetra-designer-design.md` (§3.2)
- Modify: `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` (§5)

- [ ] **Step 1:** Спека прав:
  - Рх5 — дописати «обхід реалізовано розгортанням у явні рядки проєкції (усі дії й обсяги об'єктів рівня); окремої гілки обходу в SQL немає».
  - §4.6 — абзац: рівень системного довідника — його власний скоуп, один довідник на (роль, рівень); контейнерні призначення — у довіднику виду скоупу контейнера; до дії адміністрування прав системні об'єкти мають лише `read` і не підпадають під `grantAll` і `withAction`; кастомна роль на архетипі з `fullAccess` отримує його рядки й свої дельти, але носієм `fullAccess` не є.
  - §5.1 — рядок `any`: «скоупи, де користувач має право (`fullAccess` уже розгорнуто в рядки проєкції)»; рядки `own` і вимір: функції прав повертають лише скоупи з правом, мої id і значення виміру — окремі функції без гранту, умова — AND за §5.4; абзац «Імена» замінити остаточними: `simetra.rights_any`, `rights_own`, `rights_dim`, `rights_container`, `has_right`, `rights_mine`, `rights_my_scopes`, `rights_my_members`, `rights_dimension_values`, функції даних `rights_projection`, `rights_requires`, `rights_domain`, `rights_roles`; `authorize` і `rights_explain` лишаються формою.
  - Рх9 — після «дія діє, лише коли діють усі, яких вона вимагає» дописати «в межах однієї ролі (призначення)».
  - §4.6 — у пункті «Призначення ролей» дописати «контейнер призначення — у тенанті призначення: чужий чи неіснуючий контейнер нічого не дає».
  - §4.6 — «довідник прав належить лише своєму рівню: роль іншого рівня не отримує його ні через `read` нескоуплених, ні через `fullAccess`».
  - §5.1 — у вступі: «функції даних прав (проєкція, вимоги, домен рівня, рівні ролей) — `IMMUTABLE`, без `SECURITY DEFINER` і без `EXECUTE`: їх кличуть лише функції прав від власника».
  - §5.1 — «мої id учасника й мої скоупи — за видом скоупу: учасник одного виду не діє в іншому, хоч би які `id` мали їхні рядки».
  - §7 — у пункті про останній дієвий `fullAccess`: «носій — призначення самого архетипу з `fullAccess`; кастомна роль на ньому носієм не є».
  - §8 п.2 — «роль `simetra_command` (без DML) — з Прав-2»; новий рядок: «стеля агента (Рх12) і закріплення скоупу (Рх22) — з механізмом агентів, П4».
- [ ] **Step 2:** Платформна спека §6.7 — речення «Ролі `simetra_runtime` і `simetra_command` з'являються разом із першим шляхом запису (команди, П4): до того DML у таблиці виду не має жодна роль застосунку…» переписати: «`simetra_command` з'являється з Правами-2 як роль без DML (її створює інструмент designer `roles`); гранти DML, `simetra_runtime` і перемикання ролі — з першим шляхом запису (команди, П4): до того DML у таблиці виду не має жодна роль застосунку…» (решту речення зберегти). §12: у рядку П3 таблиці віх «ролі `simetra_runtime` і `simetra_command` — з першим шляхом запису, П4» → «роль `simetra_command` — з Правами-2, `simetra_runtime` і гранти DML — з першим шляхом запису, П4»; п.5 порядку — «ролі `simetra_runtime` і `simetra_command`» → «роль `simetra_runtime`, гранти DML ролі `simetra_command`».
- [ ] **Step 3:** Спека designer §3.2 — після пункту «Запис у базу»: «**Платформні ролі** (інструмент `roles`, `database: "write"`): створює відсутні кластерні ролі платформи (`PLATFORM_ROLES`) як `NOLOGIN NOINHERIT` на цілі й на сервері тіні, наявні лише звіряє; без `CREATEROLE` — відмова. `plan` ролей не створює: без них він відмовляє з порадою запустити `roles`; з небезпечною формою (атрибути, членство) — відмовляє, називаючи порушення й ручний `ALTER ROLE`/`REVOKE`, а `roles` на такій ролі повертає ту саму відмову, а не «наявна». Правило форми «жодного члена з `SET`» послаблює П4 для `simetra_runtime → simetra_command` (Р21).»
- [ ] **Step 4:** Борг §5: позначити пункт «тіла `BEGIN ATOMIC`/`RETURN`» як закритий планом 2a1 (видалити пункт, правило лишається в коді й тесті); додати пункт «**Генератор віртуальних таблиць регістрів** — одразу `security_invoker` (спека прав §5.2); у Права-2 віртуальних таблиць немає».
- [ ] **Step 5:** Run: `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md
git commit -m "docs(spec): роль команд з Прав-2, системні об'єкти прав, форма функцій прав"
```

---

### Задача 1: роль команд у T0, грантах і моделі

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts`, `model/schemas/index.ts`
- Modify: `packages/simetra/src/compiler/sql/execute-grants.ts`, `compiler/membership-functions.ts`, `compiler/function-execute.ts`, `compiler/platform/units.ts`, `compiler/pipeline.ts`, `compiler/compile.ts`
- Create: `supabase/roles.sql`
- Modify: `supabase/tests/provider-base-state.test.sql`
- Test: `packages/simetra/src/compiler/__tests__/{membership,function-execute,platform-layer}.test.ts` (наявні)

**Interfaces:**
- Produces: `PLATFORM_ROLES: { readonly command: "simetra_command" }`, `type PlatformRolePurpose = keyof typeof PLATFORM_ROLES`, `type GrantPurpose = ApiRolePurpose | PlatformRolePurpose` (T0); `executeGrants(signature: string, purposes: readonly GrantPurpose[], provider: DatabaseProvider): string[]`.

- [ ] **Step 1: Write the failing tests (unit)**
  - `membership.test.ts`, `it("grants EXECUTE of membership functions to the command role")`: серед одиниць класу `grant` функції `<t>_member_scopes` є `GRANT EXECUTE ON FUNCTION … TO "simetra_command";`, а `REVOKE … FROM "simetra_command"` немає.
  - `function-execute.test.ts`: оголошена функція множини скоупу — те саме.
  - `platform-layer.test.ts`: `current_user_id` — `GRANT EXECUTE … TO "simetra_command"`; `platformSchemaGrants("supabase")` містить `GRANT USAGE ON SCHEMA "simetra" TO "simetra_command";`.
  - `platform-layer.test.ts`, `it("generated SQL never manages the command role itself")`: над усіма `sqlUnits` моделей `kitchenSink()` і `withRoles(...)` (після Задачі 6 — разом із функціями прав) жодного `CreateRoleStmt`, `AlterRoleStmt`, `GrantRoleStmt` і жодного табличного `GrantStmt` (`objtype` таблиці) з отримувачем `PLATFORM_ROLES.command`.
- [ ] **Step 2:** Run: `pnpm --filter simetra test membership function-execute platform-layer` — FAIL.
- [ ] **Step 3: Implement**
  - T0 `PLATFORM_ROLES`, `PlatformRolePurpose`, `GrantPurpose` поруч із `PROVIDER_API_ROLES`, реекспорт з `model/schemas/index.ts`; коментар «чому»: роль платформи, а не провайдера — її створює designer, а не провайдер.
  - `executeGrants`: призначення `command` дає `GRANT … TO PLATFORM_ROLES.command`; `REVOKE` і далі лише для ролей API без права (роль команд типових привілеїв провайдера не має).
  - Призначення `command` додати в `MEMBER_ROLES`, в оголошені функції множини скоупу (`function-execute.ts`), у `current_user_id` і в `platformSchemaGrants`.
- [ ] **Step 4:** Run: `pnpm --filter simetra test membership function-execute platform-layer` — PASS; далі `pnpm --filter simetra test` — оновити знімки й точні очікування ACL, які змінив новий грант (зокрема знімок каталогу референсного домену), лише за переліком нових рядків `simetra_command`.
- [ ] **Step 5:** Create `supabase/roles.sql` — ідемпотентний блок:

```sql
-- Роль команд платформи (спека прав §5.1, Р2a1-1): кластерна, тож її немає в
-- бажаному стані бази; на базі споживача її створює `simetra roles`.
-- CLI засіває файл під `postgres`, а він не суперкористувач: без скидання
-- `createrole_self_grant` творець отримав би членство з INHERIT/SET.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'simetra_command') THEN
    PERFORM pg_catalog.set_config('createrole_self_grant', '', true);
    CREATE ROLE simetra_command NOLOGIN NOINHERIT;
  END IF;
END
$$;
```

  У `provider-base-state.test.sql`: `plan(9)` → `plan(12)`; `has_role('simetra_command')`; `is((SELECT rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication FROM pg_roles WHERE rolname = 'simetra_command'), false, …)` (відсутня роль дає `NULL` і провал перевірки); `is((SELECT count(*) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.member WHERE m.member = to_regrole('simetra_command') OR (m.roleid = to_regrole('simetra_command') AND (m.inherit_option OR m.set_option OR NOT (g.rolsuper OR g.rolcreaterole))))::int, 0, …)` — роль не входить у жодну роль, а її член має лише `ADMIN` і сам керує ролями.
- [ ] **Step 6:** (Рішення архітектора під час виконання: цей DB-тест пише Задача 2 — він залежить від `readPlatformRoles`; приріст `test:db` Задачі 9 рахує його там.) DB-тест `test/db/provider-roles.db.test.ts` (причина DB-рівня — `CREATE ROLE` і `createrole_self_grant` вирішує Postgres): `it("roles.sql creates an ADMIN-only role under postgres whatever createrole_self_grant says")` — у `withRollback` від `postgres`: `SET LOCAL createrole_self_grant = 'set, inherit'`, текст `supabase/roles.sql` з `simetra_command`, заміненим на `testRoleName("command")`, → `readPlatformRoles` (Задача 2) дає форму без відмов. Тест іде після Задачі 2 (той самий коміт, що й `readPlatformRoles`, або наступний). Run: `pnpm --filter simetra typecheck && pnpm --filter simetra lint` — код 0. pgTAP на піднятому стеку з'явиться після Задачі 2 Step 6 (роль створює `roles`); свіжий стек CI застосовує `roles.sql` сам — це доводить зелений job `db` (Задача 9). Якщо CI-pgTAP падає на `has_role` — стоп і звіт архітектору, обхідного кроку в CI не додавати.
- [ ] **Step 7: Commit**

```bash
git add packages/simetra supabase
git commit -m "feat(compiler): роль команд у T0, EXECUTE функцій і USAGE схеми simetra"
```

---

### Задача 2: інструмент `roles` і відмова плану без ролі

**Files:**
- Create: `packages/simetra/src/schema/apply/platform-roles.ts`
- Modify: `packages/simetra/src/schema/apply/plan.ts`, `schema/apply/index.ts`
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `compiler/messages.ts`
- Create: `packages/designer/src/tools/roles-tool.ts`
- Modify: `packages/designer/src/tools/catalog.ts`, `tools/types.ts` (`TOOL_NAMES`), `tools/database-tools.ts` (`diff`), `tools/apply-tools.ts` (репетиція `apply`)
- Test: `packages/simetra/src/schema/apply/__tests__/platform-roles.test.ts` (новий), `packages/designer/src/__tests__/roles-tool.db.test.ts` (новий), `packages/designer/src/__tests__/cli.test.ts` (наявний: перелік інструментів)

**Interfaces:**
- Consumes: `PLATFORM_ROLES` (Задача 1), `renderApplyState`, `desiredForApply`, зразок `checkOwnerMembership`.
- Produces:
  - `requiredPlatformRoles(desiredSql: string, parse: SqlParser): string[]` — значення `PLATFORM_ROLES`, які згадують дерева розбору (`RoleSpec.rolename`) усього бажаного SQL, відсортовані;
  - `interface PlatformRoleRow { name: string; attributes: { login: boolean; inherit: boolean; superuser: boolean; bypassRls: boolean; createRole: boolean; createDb: boolean; replication: boolean }; memberOf: string[]; members: { role: string; admin: boolean; inherit: boolean; set: boolean; manager: boolean }[] }` — `memberOf`: імена ролей, у які вона входить; `members` — рядки `pg_auth_members` (Postgres 16+) з іменем члена, `manager` — член сам має `SUPERUSER` чи `CREATEROLE`; `violation` відмови — перше порушення за фіксованим порядком: атрибути в порядку оголошення (`login` … `replication`), далі `member-of:<роль>`, далі `member:<роль>`;
  - `checkPlatformRoles(dbs: ApplyDatabase, target: DbConnection, shadowBase: DbConnection | undefined, desiredSql: string, parse: SqlParser): Promise<{ refusal?: ApplyDiagnostic[] }>` — спільна передперевірка (форма як у `checkOwnerMembership`);
  - `readPlatformRoles(tx: ApplyTransaction, names: readonly string[]): Promise<PlatformRoleRow[]>` — один запит до `pg_roles` і `pg_auth_members`;
  - `platformRoleRefusals(required: readonly string[], found: readonly PlatformRoleRow[], server: "target" | "shadow"): ApplyDiagnostic[]`;
  - `ensurePlatformRoles(dbs: ApplyDatabase, servers: readonly { server: "target" | "shadow"; db: DbConnection }[], names: readonly string[]): Promise<{ server: "target" | "shadow"; name: string; outcome: "created" | "present" }[] | { refusal: ApplyDiagnostic[] }>` (експорт `simetra/schema`): спершу на **всіх** серверах читальна перевірка `CREATEROLE` і форми наявних ролей (`platformRoleRefusals`), і лише без відмов — транзакції запису `CREATE ROLE` (Р2a1-3); наявна роль з порушеною формою — відмова, а не `present`;
  - коди `plan.platform-role-missing` (`{ role, server }`), `plan.platform-role-shape` (`{ role, server, violation }` — `violation`: назва атрибута чи `member:<роль>`; підказка — ручний `ALTER ROLE … NO<атрибут>` чи `REVOKE <роль> FROM …`, а не `simetra roles`), `roles.create-role-denied` (`{ role, server }`).

- [ ] **Step 1: Write the failing test (unit)** `platform-roles.test.ts`, таблиця `it.each`:

```ts
it.each([
  { case: "absent", found: [], codes: ["plan.platform-role-missing"] },
  { case: "login", found: [row({ attributes: { login: true } })], codes: ["plan.platform-role-shape"] },
  { case: "inherit", found: [row({ attributes: { inherit: true } })], codes: ["plan.platform-role-shape"] },
  { case: "superuser", found: [row({ attributes: { superuser: true } })], codes: ["plan.platform-role-shape"] },
  { case: "member-of", found: [row({ memberOf: ["authenticated"] })], codes: ["plan.platform-role-shape"] },
  { case: "set-member", found: [row({ members: [member({ set: true })] })], codes: ["plan.platform-role-shape"] },
  { case: "inherit-member", found: [row({ members: [member({ inherit: true })] })], codes: ["plan.platform-role-shape"] },
  { case: "admin-without-power", found: [row({ members: [member({ manager: false })] })], codes: ["plan.platform-role-shape"] },
  { case: "admin-manager", found: [row({ members: [member({})] })], codes: [] },
  { case: "ok", found: [row({})], codes: [] },
])("refuses a plan when the command role is $case", ({ found, codes }) => {
  expect(
    platformRoleRefusals(["simetra_command"], found, "shadow").map((d) => [d.code, d.params?.server])
  ).toEqual(codes.map((c) => [c, "shadow"]))
})
```

  (`row` — локальний будівник: усі `attributes` — `false`, `memberOf: []`, `members: []`, `over.attributes` зливається з типовими; `member` — `{ role: "migrator", admin: true, inherit: false, set: false, manager: true, ...over }`.) Кожен рядок `plan.platform-role-shape` перевіряє й `params.violation`: `"login"`, `"inherit"`, `"superuser"`, `"member-of:authenticated"`, `"member:migrator"`; і `it("names the first violation in a fixed order")` — роль з `login` і членом з `set` → `"login"`. Плюс `it("checks CREATEROLE on every server before creating anything")` над фейковою `ApplyDatabase`: ціль має `CREATEROLE`, тінь — ні → `refusal` з `roles.create-role-denied` (`server: "shadow"`), і жодної транзакції запису (жодного `CREATE ROLE`) на цілі; `it("reports a present role of the wrong shape instead of present")`: наявна роль з `LOGIN` → `refusal` з `plan.platform-role-shape`; і `it("creates once when target and shadow share a cluster")`: фейкова база, де обидва сервери бачать той самий стан ролей, → `[{ server: "target", outcome: "created" }, { server: "shadow", outcome: "present" }]` (після першого запису читання другого сервера бачить роль). Плюс `it("asks for nothing when the model needs no platform role")`: `platformRoleRefusals([], [], "target")` → `[]`; і `it("finds the command role in the apply state of a project without users")`: `requiredPlatformRoles(desiredForApply(<модель без «Користувачів»>).sql, parse)` → `["simetra_command"]` (гранти схеми `simetra` вставив `renderApplyState`), а проєкт з «Користувачами» — теж `["simetra_command"]` (гранти шару).
- [ ] **Step 2:** Run: `pnpm --filter simetra test platform-roles` — FAIL.
- [ ] **Step 3: Implement** `platform-roles.ts`; коди й тексти en/uk (`hint` відмови плану починається з «No plan was written.» / «План не записано.» і радить `simetra roles`); `checkPlatformRoles` — читальна транзакція цілі (`"rollback"`), за наявності `shadowBase` — ще одна до нього. Виклики: у `buildPlan` — до розгалуження промоції й до першого `withDesiredShadow` (відмова — `refused([...])`); у `diff` (`database-tools.ts`, поруч із `checkOwnerMembership`) і в репетиції `apply` (`apply-tools.ts`, до `withDesiredShadow`) — та сама функція.
- [ ] **Step 4: Write the failing test (unit)** `schema/apply/__tests__/plan.test.ts` за наявним зразком фейкової бази (двигун — `Proxy`, що кидає на будь-який виклик): `it.each(["target", "shadow"])("refuses a plan when the command role is missing on the %s server")` — фейкова транзакція повертає порожній `readPlatformRoles` для названого сервера → `status: "refused"`, діагностика `plan.platform-role-missing` з `server`, `withDesiredShadow` не викликано; той самий кейс для плану з промоцією (`promotions` непорожні) — відмова до гілки промоції. `diff` і репетиція `apply` кличуть той самий `checkPlatformRoles` до тіні: їхні інструменти мають лише DB-тести (проєкт `unit` їх виключає), а відсутньої кластерної ролі на спільному стеку не створити, тож від'ємний шлях доводить unit-тест помічника, а додатний — наявні DB-тести `diff` і `apply` на стеку з роллю.
- [ ] **Step 5:** Run: `pnpm --filter simetra test platform-roles plan messages` і `pnpm --filter @simetrajs/designer exec vitest run --project db apply-tools database-tools` — PASS.
- [ ] **Step 6: DB test** — тут і DB-тест `provider-roles.db.test.ts` Задачі 1 Step 6 (перенесено). `roles-tool.db.test.ts` (причина DB-рівня — атрибути ролі й право `CREATEROLE` вирішує Postgres). Один `withRollback` на кейс, ім'я ролі — `testRoleName("command")`, тож сторож стеку слідів не бачить (роль відкочується); `ensurePlatformRoles` отримує `ApplyDatabase`, чия `transaction` віддає транзакцію тесту (як фейкова база в `plan.test.ts`), і один сервер-ціль:
  - `it("creates a missing role NOLOGIN NOINHERIT and is idempotent")`: `ensurePlatformRoles` з одним сервером-ціллю (транзакція тесту) і `[name]` → `[{ server: "target", name, outcome: "created" }]`; `readPlatformRoles` → усі `attributes` `false`, `memberOf: []`, `platformRoleRefusals` порожній (член-творець лише з `ADMIN` і з `CREATEROLE` форму не ламає); повторний виклик → `outcome: "present"`.
  - `it("creates the role with an ADMIN-only self grant whatever createrole_self_grant says")`: `SET LOCAL createrole_self_grant = 'set, inherit'` до виклику → після `ensurePlatformRoles` жоден рядок `members` не має `inherit` чи `set`. Мутація: прибрати з `ensurePlatformRoles` `SET LOCAL createrole_self_grant = ''` — тест червоніє (на стеку, де роль створює не суперкористувач; якщо сесія тесту — суперкористувач, тест робить `SET LOCAL ROLE` у тегову роль з `CREATEROLE`, створену в тій самій транзакції).
  - `it("refuses without CREATEROLE and creates nothing")`: після `SET LOCAL ROLE authenticated` виклик дає `refusal.code === "roles.create-role-denied"`; після `RESET ROLE` роль відсутня.
  - `it("the plan role of the local stack sees the command role")`: `readPlatformRoles(tx, [PLATFORM_ROLES.command])` → одна форма без проблем (`platformRoleRefusals` порожній) — доказ, що стек готовий.
- [ ] **Step 7: Implement the tool** `roles-tool.ts`: `defineTool({ name: "roles", files: "read", database: "write", destructive: false, input: z.strictObject({}) })`; `ensurePlatformRoles(dbs, [{ server: "target", db: ціль }, …(shadowBase ? [{ server: "shadow", db: shadowBase }] : [])], Object.values(PLATFORM_ROLES))` — перевірка `rolcreaterole OR rolsuper` ролі `current_user` і форми наявних ролей на всіх серверах до будь-якого запису; далі на кожному сервері транзакція `SET LOCAL createrole_self_grant = ''` і ідемпотентний `DO` з `IF NOT EXISTS` (як у `roles.sql`) для кожної ролі: ціль і `shadowBase` можуть бути одним кластером, а ролі кластерні, тож роль, що вже з'явилася з першого сервера, дає `present` (Р2a1-3); `data` — перелік `{ server, name, outcome }`; відмова — `refusal` з кодом. Додати в `TOOLS` і `TOOL_NAMES`; опис англійською. Потім **один раз на піднятому стеку**, коли файла замка сторожа `$(node -p "require('os').tmpdir()")/simetra-db-stack.lock` немає (жоден DB-прогін не йде): `SIMETRA_DATABASE_URL=<рядок testDatabaseUrl(), типово локальний стек> node packages/designer/bin/simetra.mjs roles` (інструмент метаданих не читає) — результат `created` або `present`; після цього `pnpm exec supabase test db` — зелений.
- [ ] **Step 8:** Run: `pnpm --filter @simetrajs/designer test cli roles-tool` (`roles-tool` — у проєкті `db`: `pnpm --filter @simetrajs/designer exec vitest run --project db roles-tool`) — PASS; `cli.test.ts` бачить інструмент `roles` у переліку й у тест-гейті розміру описів.
- [ ] **Step 9: Commit**

```bash
git add packages/simetra packages/designer
git commit -m "feat(designer): інструмент roles і відмова плану без ролі команд"
```

---

### Задача 3: закрита форма функції множини скоупу без тіла стандарту SQL

**Files:**
- Modify: `packages/simetra/src/compiler/sql/function-shape.ts`, `compiler/stages/links.ts`, `compiler/rights/dimension-functions.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-links.test.ts`

**Interfaces:**
- Produces: `SetFunctionReason = "language" | "security" | "searchPath" | "unqualified" | "sqlBody"`.

- [ ] **Step 1: Write the failing test (unit)** `stage-links.test.ts`, `it.each` за формою тіла:

```ts
it.each([
  ["BEGIN ATOMIC", "RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' BEGIN ATOMIC SELECT id FROM org; END"],
  // `RETURNS SETOF`: інакше `nullaryFunction` дає `problem`, а не `reason`
  ["RETURN", "RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' RETURN (SELECT id FROM org LIMIT 1)"],
])("rejects a scope set function with a %s body", async (_, tail) => {
  // некваліфіковане `org` у такому тілі зв'язується за search_path сесії під час CREATE
  expect(await setFunctionReasons(tail)).toEqual(["sqlBody"])
})
```

  (`setFunctionReasons` — будівник у файлі тесту над наявним фікстурним проєктом виду скоупу з `setFunction: { name }` і SQL-файлом функції; повертає `reason` діагностик `scope.set-function-signature`.)
- [ ] **Step 2:** Run: `pnpm --filter simetra test stage-links` — FAIL (форма проходить).
- [ ] **Step 3: Implement:** `setFunctionClosedProblem` повертає `"sqlBody"`, коли `fn.sql_body !== undefined` (перед перевіркою відношень); `dimension-functions.ts` бере причину з неї й не дублює перевірку; текст причини `sqlBody` в `MESSAGES["scope.set-function-signature"]` en/uk.
- [ ] **Step 4:** Run: `pnpm --filter simetra test stage-links rights-dimension-functions messages` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "fix(compiler): функція множини скоупу не приймає тіла стандарту SQL"
```

---

### Задача 4: ролі довідника «Ролі» й «Призначення ролей»

**Files:**
- Modify: `packages/simetra/src/model/schemas/catalog.ts`, `model/kinds/catalog.ts`, `model/kinds/standard.ts`
- Modify: `packages/simetra/src/compiler/stages/model.ts`, `compiler/rights/expand.ts`
- Modify: `packages/simetra/schemas/*.schema.json` (регенерація)
- Test: `packages/simetra/src/compiler/__tests__/rights-catalogs.test.ts` (новий), `packages/simetra/src/model/__tests__/catalog-model.test.ts` (рядки прийнятих і відхилених значень `role` — у наявну таблицю форм, якщо вона є, інакше одна нова `it.each`)

**Interfaces:**
- Produces:
  - `Catalog["role"]`: `"users" | "rightsRoles" | "roleAssignments"`;
  - `CatalogRoleDefinition.columns?: (catalog: Catalog) => StandardColumnDef[]` (сигнатура з аргументом — колонка суб'єкта залежить від скоупу довідника);
  - `CatalogRoleDefinition.tabularSection?: StandardTabularSectionDef`, `actions?: "read"`, `rightsSystem?: "rightsRoles" | "roleAssignments"` (єдиний факт про системний довідник прав — його читають `KindDefinition.rightsSystem`, селектори й правило рівня);
  - `interface StandardTabularSectionDef { logicalName: string; physicalSuffix: string; columns: () => StandardColumnDef[] }`;
  - `KindDefinition.standardTabularSections?(obj: unknown): StandardTabularSectionDef[]`, `KindDefinition.rightsSystem?(obj: unknown): "rightsRoles" | "roleAssignments" | undefined`;
  - `RightsContract.system?: "rightsRoles" | "roleAssignments"` (Р2a1-23);
  - `StandardColumnDef.ref` додає `"member"` (довідник членства виду скоупу таблиці; у нескоупленій — «Користувачі») і `"rightsRoles"` (довідник `rightsRoles` того самого рівня).

- [ ] **Step 1: Write the failing tests (unit)** `rights-catalogs.test.ts` над `withRoles()`:
  - `it("gives the roles catalog its standard columns and the delta tabular section")`: таблиця `org_roles` має колонки `archetype` (uuid, NOT NULL) і `order` (integer); таблиця `org_roles_delta` — `object`, `action`, `extent`, `dimension`, `effect` із CHECK `extent IN ('any', 'own', 'dimension')`, `effect IN ('allow', 'deny')` і `(extent = 'dimension') = (dimension IS NOT NULL)`; `origin.tabularSectionId === "<ORG_ROLES_ID>#delta"`; складений FK `(org_id, parent_id)` на `org_roles`.
  - `it.each` за рівнем `it("points the assignment subject at the member of the level")`: `org_role_assignments.subject` → FK `(org_id, subject)` на `org_member (org_id, id)`; `global_role_assignments.subject` → FK на `users (id)`; `custom_role` → складений FK `(org_id, custom_role)` на `org_roles (org_id, id)` / простий FK на `global_roles (id)`; CHECK `num_nonnulls(archetype, custom_role) = 1`; `container` без FK; індекси (скоуп, `subject`), (скоуп, `container`).
  - `it("system rights catalogs have only read and stay out of selectors")`: `contracts.rights` запису `OrgRoleAssignments` має дії `["read"]`; роль з `grantAll("any")` не має рядків проєкції на `OrgRoles` і `OrgRoleAssignments`, а явний `grant(objects(["Catalog","OrgRoleAssignments"]), ["read"], "any")` — має.
  - `it("a rights catalog belongs only to its level")` (Р2a1-20): роль `OrgMember` з явним `grant(objects(["Catalog","GlobalRoleAssignments"]), ["read"], "any")` → `rights.grant-level`; та сама роль з `grant(objects(["Catalog","Users"]), ["read"], "any")` (нескоуплений, але не довідник прав) — без помилки.
- [ ] **Step 2:** Run: `pnpm --filter simetra test rights-catalogs` — FAIL.
- [ ] **Step 3: Implement:** значення `role` у схемі (опис англійською, «at most one per role and level»); `CATALOG_ROLES.rightsRoles` / `.roleAssignments` з колонками за Р2a1-6, Р2a1-7, `actions: "read"`, `rightsSystem`; `actions(obj)` довідника бере `read` з ролі; `standardTabularSections` будує ТЧ з фізичним ім'ям `<physicalName довідника>_<physicalSuffix>`; стадія моделі будує стандартну ТЧ тим самим шляхом, що ТЧ з файлу (`rowScope`, `withScope`, `standardField`), а цілі `member` і `rightsRoles` резолвить за рівнем таблиці; `rightsContracts` заповнює `system` з `rightsSystem`; `expandRole` для `grantAll` і `withAction` пропускає контракти з `system`; `allowedActions` (тепер спільний експорт `expand.ts`) не дає довідника прав іншого рівня (Р2a1-20). Фікстури: шар `rolesAndSets()` отримує чотири системні довідники (опис структури файлів вище); `kitchen-sink.ts` — жодного: усі його рівні з ролями (глобальний, `org`, контейнер `Partner`) покриті джерелами `globalGrants`, `orgGrants`, `partnerGrants` (Р2a1-24), тож ратчет бачить поля джерел без помилок.
- [ ] **Step 4:** Run: `UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema && pnpm --filter simetra test rights-catalogs rights-expand rights-roles field-ratchet reference-index-completeness` — PASS; рядки проєкції `rights-expand.test.ts` не змінилися. Поле `system` змінює лише записи системних довідників: точні очікування `rights-contract.test.ts` і вивід `explain.test.ts`, де є ці довідники, оновити саме цими рядками.

  Фікстура однотенантного проєкту для Задач 6 і 8 — `singleTenantRights(overrides?)` у `fixtures/rights.ts`: без видів скоупу; «Користувачі»; `Project` (`rightsContainer: true`); документ `Task` з `containerBinding: "project"`; роль `ProjectLead` (`assignedOn: { container: Project }`, `read@any` на `Task`); `GlobalRoles`, `GlobalRoleAssignments`. Додається в цій задачі разом із системними довідниками.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(model): системні довідники «Ролі» й «Призначення ролей»"
```

---

### Задача 5: перевірки й контракт системних довідників

**Files:**
- Create: `packages/simetra/src/compiler/rights/system-catalogs.ts`
- Modify: `packages/simetra/src/compiler/contracts.ts`, `compiler/stages/integrity.ts` (чи місце перевірок ролей 1b — `rights/role-checks.ts`), `compiler/rights/dimension-functions.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/rights-catalogs.test.ts`, `rights-dimension-functions.test.ts`

**Interfaces:**
- Produces:
  - `type RightsLevelKey = { level: "global" } | { level: "scope"; scopeKindId: string }`;
  - `interface RightsCatalogContract { level: RightsLevelKey; roles: { objectId: string; table: QualifiedName; delta: QualifiedName }; assignments: { objectId: string; table: QualifiedName } }` — фізичні колонки — сталі Р2a1-6/7 у формі стилю проєкту, які рендер бере з фізичного знімка за `origin.standard`;
  - `Contracts.rightsCatalogs: RightsCatalogContract[]` (за рівнем: глобальний, далі за `scopeKindId`);
  - `coveredAssignmentLevels(levels: readonly CompiledAssignedOn[]): ReadonlySet<string>` — ключі (`levelKey`) рівнів призначення, покритих прийнятими джерелами (Р2a1-24); ключ — рівень призначення (контейнер — за `containerId`), а не рівень зберігання; перевірки стадії 4 дають йому рівні з `sourceLevel`, `rightsLevelOf` — з `contracts.assignmentSources`;
  - `rightsLevelOf(level: CompiledRoleLevel, contracts: Pick<Contracts, "rights" | "assignmentSources">): RightsLevelKey | undefined` — рівень зберігання ролі (контейнер → вид скоупу контейнера чи глобальний; `everyUser` і рівень, покритий джерелом, → `undefined`, Р2a1-12);
  - коди-помилки `rights.system-catalog-missing` (`{ level, missing: "rightsRoles" | "roleAssignments" }`), `rights.system-catalog-duplicate` (`{ role, level, firstFile }`), `rights.system-catalog-scope` (`{ name, scopeKind }`), `rights.system-catalog-description` (`{ name }`), `rights.system-catalog-parallel` (`{ level, source }`); попередження `rights.adopted-source-unsupported` (`{ source }`, у `WARNING_RULES`).

- [ ] **Step 1: Write the failing test (unit)** — одна таблиця `it.each` на `rights-catalogs.test.ts`:

| case | перевизначення `withRoles(...)` | очікувані коди (pointer) |
| --- | --- | --- |
| `missing-roles` | `{ [ORG_ROLES_FILE]: null-файл }` (будівник `without(path)`) | `rights.system-catalog-missing` (`level: "org"`, `missing: "rightsRoles"`) |
| `missing-for-container` | лише `ProjectLead` і без орг-довідників | `rights.system-catalog-missing` для `org` |
| `duplicate` | другий довідник `rightsRoles` зі `scope: "org"` | `rights.system-catalog-duplicate` на `/role` другого |
| `scope-without-membership` | довідник `roleAssignments` зі скоупом виду без членства | `rights.system-catalog-scope` на `/scope` |
| `no-description` | `OrgRoles` з `descriptionLength: 0` | `rights.system-catalog-description` |
| `every-user-only` | проєкт лише з роллю `Everyone` і без системних довідників | — |
| `adopted-source` | ролі + `membershipSources` (будівник `grantsSource` / джерело членства фікстури 1a) | попередження `rights.adopted-source-unsupported` на `/membershipSources/0` (Р2a1-21; 2d знімає), помилок немає |
| `source-covers-level` | джерело `globalGrants` (`assignedOn: "global"`) і без глобальних системних довідників | — (попередження джерела) |
| `parallel` | джерело `globalGrants` і `GlobalRoles`/`GlobalRoleAssignments` (усі глобальні ролі покриті джерелом) | `rights.system-catalog-parallel` на `/role` глобальних довідників |
| `mixed-in-scope-kind` | джерело `grants` (контейнер `Project`) і `OrgRoles`/`OrgRoleAssignments` для ролей рівня `org` | — (попередження джерела) |
| `source-only-membership` | вид скоупу з членством лише з `membershipSources` і довідник `roleAssignments` цього виду | `rights.system-catalog-scope` на `/scope` |

  Плюс `rights-dimension-functions.test.ts`, `it("rejects a dimension function that reads a rights catalog")`: дослівна функція виміру з `SELECT … FROM <схема>.org_role_assignments` (прямо й через проміжну дослівну sql-функцію) → `rights.dimension-function-reads-rights` (виконує відкладене обмеження плану 1a: множина значень не залежить від гранту).

  Плюс `it("lists the rights catalogs of every level")`: `contracts.rightsCatalogs` — два записи (глобальний, `org`) з таблицями `global_roles`, `global_roles_delta`, `global_role_assignments`, `org_roles`, `org_roles_delta`, `org_role_assignments`.
  Наявні тести з джерелами: `rights-roles.test.ts` (`withSources` — джерела є предметом тестів; його глобальне джерело покриває всі глобальні ролі, тож `withSources` прибирає з шару `GlobalRoles`/`GlobalRoleAssignments`, а орг-довідники лишає — рівень `org` змішаний) — кожна перевірка діагностик рахує й нове попередження поруч із власними кодами; `operations-roles.test.ts` (`BASE` з `assignmentSources` — джерела випадкові) — прибрати їх з `BASE`; `kitchen-sink.ts` і `rights-sources.test.ts` — без змін (попередження не ламає ратчет).
- [ ] **Step 2:** Run: `pnpm --filter simetra test rights-catalogs` — FAIL.
- [ ] **Step 3: Implement** перевірки на стадії, де живуть перевірки ролей 1b; перевірка функцій виміру додає таблиці (основні й ТЧ) довідників `rightsRoles` і `roleAssignments` до заборонених відношень тим самим транзитивним обходом; коди en/uk (підказка `missing` називає роль довідника, вид скоупу й `simetra create`); контракт — у `buildContracts` поруч із `roles`, з параметром `rightsCatalogs`, обчисленим до `sqlUnits` (Р2a1-22).
- [ ] **Step 4:** Run: `pnpm --filter simetra test rights-catalogs rights-dimension-functions rights-roles operations-roles field-ratchet messages contracts explain` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): перевірки й контракт системних довідників прав"
```

**Рішення архітектора під час виконання** (Задача 4 і її доведення, Задача 5):

- **A1.** Кастомна дія на системному довіднику прав — помилка
  `rights.system-catalog-custom-action` на `/customActions/<i>` файлу
  довідника, а не мовчазний пропуск; факт «системний довідник» — лише з
  `rightsSystem` (Р2a1-23). Вплив на спеку: §4.6 — речення «кастомні дії на
  системних довідниках прав — помилка компілятора».
- **A2.** Імена `standardTabularSections` зайняті в просторі імен ТЧ так само,
  як стандартні колонки — у просторі реквізитів: загальне правило стадії 2,
  код `identity.name-reserved` (текст — «зайняте стандартним елементом виду»).
  Вплив на спеку: §4.6 — півречення «ім'я `delta` зайняте в просторі ТЧ
  довідника».
- **A3.** Кодоген типів сутностей видає стандартні ТЧ тим самим шляхом, що ТЧ
  з файлу. Вплив на спеку: немає.
- **A4.** Імена CHECK стандартних колонок і ТЧ — через спільний помічник імен
  обмежень (межа 63 байти). Вплив на спеку: немає.

---

### Задача 6: функції прав у схемі `simetra`

**Files:**
- Create: `packages/simetra/src/compiler/rights/functions.ts`
- Modify: `packages/simetra/src/compiler/sql/units.ts` (`UnitGenerator` — `"rights"`, `FIXED_BODY.rights = true`), `compiler/pipeline.ts` (`sqlUnits`, `describeGenerated.rights`), `compiler/contracts.ts` і `compiler/rights/contracts.ts` (`relation.subjectTarget`, Р2a1-27)
- Test: `packages/simetra/src/compiler/__tests__/rights-functions.test.ts` (новий), `creation-order.test.ts`, `rights-dimensions.test.ts` (`subjectTarget`)

**Interfaces:**
- Consumes: `Contracts.rights`, `roles`, `rightsProjection`, `rightsCatalogs`, `accessDimensions`, `membership` (`MembershipContract` + `keyColumn` — id учасника для `rights_my_scopes`), `assignmentSources` (для `rightsLevelOf`, рішення архітектора R3 до Задачі 5), `executeGrants` із `command`, `allowedActions` / `levelAllowsExtent` (спільний експорт `expand.ts`, Задача 4), фізичний знімок (колонки системних довідників і контейнерів — за `origin.standard` / `origin.scopeKindId`, як каже коментар `RightsCatalogContract`).
- Produces: `buildRightsUnits(contracts: Pick<Contracts, "rights" | "roles" | "rightsProjection" | "rightsCatalogs" | "accessDimensions" | "membership" | "assignmentSources">, physical: PhysicalSnapshot, provider: DatabaseProvider, module: string, parse: SqlParser): SqlUnit[]` (Р2a1-22; `assignmentSources` і `physical` — уточнення виконання, вплив на спеку: немає) (порожньо без `Role`), сталі імен `RIGHTS_FUNCTIONS` (`QualifiedName` кожної функції нижче). Сигнатури (усі в `simetra`):

| Функція | Повертає | Форма, `EXECUTE` |
| --- | --- | --- |
| `rights_projection()` | `TABLE (role_id uuid, object text, action text, extent text, dimension_id uuid)` | дані, `IMMUTABLE`; нікому |
| `rights_requires()` | `TABLE (object text, action text, required text)` | дані; нікому |
| `rights_domain()` | `TABLE (level text, level_id uuid, object text, action text, extent text, dimension_id uuid)` | дані; нікому |
| `rights_roles()` | `TABLE (role_id uuid, level text, level_id uuid, storage text, storage_id uuid)` — `storage`: `global` / `scope` / `NULL` (`everyUser` чи рівень, покритий джерелом призначень), `storage_id` — вид скоупу зберігання; обидва — з `rightsLevelOf(level, contracts)` над `rights` і `assignmentSources` (Р2a1-12) | дані; нікому |
| `rights_my_scopes()` | `TABLE (scope_kind_id uuid, scope uuid, member uuid)` | `STABLE SECURITY DEFINER`; user, service, command |
| `rights_mine()` | `TABLE (level text, level_id uuid, scope uuid, container uuid, object text, action text, extent text, dimension_id uuid)` | те саме |
| `rights_any(p_action text, p_object text)` | `SETOF uuid` (скоупи) | те саме |
| `rights_own(p_action text, p_object text)` | `SETOF uuid` (скоупи) | те саме |
| `rights_dim(p_action text, p_object text, p_dimension uuid)` | `SETOF uuid` (скоупи) | те саме |
| `rights_container(p_action text, p_object text, p_extent text, p_dimension uuid)` | `SETOF uuid` (контейнери) | те саме |
| `has_right(p_action text, p_object text, p_extent text, p_dimension uuid)` | `boolean` | те саме |
| `rights_my_members(p_scope_kind uuid)` | `SETOF uuid` (мої учасники цього виду) | те саме |
| `rights_dimension_values(p_dimension uuid)` | `SETOF uuid` | те саме |

  `object` — мітка виду, `action` — слово словника чи UUID кастомної дії, `extent` — `any` / `own` / `dimension`, `level` — `everyUser` / `global` / `scope` / `container`, `level_id` — id виду скоупу чи об'єкта-контейнера.

- [ ] **Step 1: Write the failing tests (unit)** `rights-functions.test.ts` над `withRoles(...)` (гранти — явні перевизначення тесту):
  - `it("renders no rights functions without roles")`: `rightsFiles()` → жодної одиниці `generator: "rights"`.
  - `it("declares every rights function with its signature, shape and grants")`: множина `identity` одиниць класу `function` дорівнює сигнатурам таблиці вище; для кожної функції множини й помічника закриту форму перевіряє власне дерево одиниці (`closedShellProblem` чи опція `search_path` дорівнює `''`, `sql_body` відсутній, `LANGUAGE sql`), бо `functionIdentity(…, [])` функцій з аргументами не знаходить, — і `SECURITY DEFINER`; для функцій даних — `IMMUTABLE`, без `SECURITY DEFINER`; гранти: `GRANT EXECUTE` рівно ролям колонки «`EXECUTE`» (`authenticated`, `service_role`, `simetra_command` чи нікому), `REVOKE … FROM PUBLIC` у кожної.
  - `it.each` `rows of the projection` — рядки `VALUES` тіла `rights_projection` (розбір дерева, не текст) як кортежі `[role, object, action, extent, dimension]`:
    - `OrgMember` з `include: TaskEditors` (`TaskReaders` — `read@any` на `Task`, `TaskEditors` — `update@own`) → `[ORG_MEMBER_ROLE_ID, "task", "read", "any", null]`, `[…, "read", "own", null]`, `[…, "update", "own", null]` (породження `any → own` уже зроблено компілятором);
    - `OrgAdmin` (`fullAccess`) → кожна дія `Task` і `TaskComment` (зокрема `post`, `unpost`, `markDeletion`) на `any` і `own`, `read@any` на `Announcement` і «Користувачах», жодного `create` на `Announcement` (Р2a1-9);
    - `OrgAdmin` → `read@any` на `OrgRoles` і `OrgRoleAssignments` (розгортання `fullAccess` — не селектор, тож Р2a1-8 цих рядків не знімає: адмін бачить ролі свого тенанта) і **жодного** рядка на `GlobalRoles` та `GlobalRoleAssignments` (Р2a1-20);
    - кастомна дія `reassign` на `Task` (перевизначення `customActions`) у `OrgAdmin` → рядок з `action` = UUID дії.
  - `it("pins the storage level of every archetype")` (Р2a1-12): рядки `rights_roles` — `OrgAdmin`/`OrgMember` → `scope`/`ORG_KIND_ID`; `ProjectLead` → `container`, зберігання `scope`/`ORG_KIND_ID`; `Support` → `global`; `Everyone` → `everyUser`, `storage` `NULL`; у `withSources`-подібній фікстурі `ProjectLead` (рівень покритий джерелом `grants`) → `storage` `NULL` (Р2a1-24).
  - `it("renders requires and the level domain from the same rules as expandRole")`: `rights_requires` містить `["task", "update", "read"]`, `["task", "post", "update"]`; `rights_domain` для `scope/org` містить `create@any` на `task`, не містить `create@any` на `announcement` і жодного рядка на `global_role_assignments`; для `everyUser` не містить жодного `any`.
  - `it("closes requires in exactly two passes")` (Р2a1-11): тіло `rights_mine` має CTE замикання `closure_1` і `closure_2` і жодного іншого.
  - `it("the requires of every action are transitively closed")` — якір доказу двох проходів: для кожного `RightsContract` (`kitchen-sink.ts` і `withRoles` з кастомною дією `escalate`, `requires: ["unpost"]`) і кожної дії x `requires(x) ⊇ requires(y)` для кожного `y ∈ requires(x)`; рядки `rights_requires` — рівно ці замикання.
  - `it("renders rights functions for a project without scope kinds")` (Р2a1-19): `singleTenantRights()` → ті самі сигнатури; тіло `rights_my_scopes` — порожня множина типізованих колонок (`… WHERE false`), бо довідників членства немає; тіло `has_right` обмежує `level <> 'container'` (семантику доводить Задача 8).
  - `it("reads every catalog it needs only through qualified relations")`: тіло `rights_mine` згадує таблиці `org_role_assignments`, `org_roles`, `org_roles_delta`, `global_role_assignments`, `global_roles`, `global_roles_delta` і функції `simetra.rights_my_scopes`, `simetra.rights_projection`, `simetra.rights_domain`, `simetra.rights_requires`, `simetra.rights_roles`; таблиці членства згадує **лише** тіло `rights_my_scopes` (Global Constraints).
  - `rights-dimensions.test.ts`: `it("resolves the subject target of a dimension relation")` — `regionDimension()` (`MemberRegion.member` → `OrgMember`) → `subjectTarget: { membership: ORG_KIND_ID }`; суб'єкт на «Користувачів» → `{ users: true }`.
  - `creation-order.test.ts`: `it("creates rights functions after the catalogs they read")` — ребро від `org_role_assignments` до `simetra.rights_mine`.
- [ ] **Step 2:** Run: `pnpm --filter simetra test rights-functions creation-order` — FAIL.
- [ ] **Step 3: Implement** `functions.ts`. Тіла — `closedFunction`-форма (як у `membership-functions.ts`, `dollarTag`). Семантика, яку тіла мусять дати (доводить DB-сценарій Задачі 8):
  - `rights_projection` — рядки `contracts.rightsProjection` плюс розгортання `fullAccess` (Р2a1-9) за правилами рівня `expandRole` (виділити `allowedActions` і `levelAllowsExtent` у спільний експорт `expand.ts`, а не копіювати); мітки — `RightsContract.kindLabel`; порядок рядків — порядок проєкції.
  - `rights_my_scopes` — для кожного довідника членства: `(scopeKindId, <скоуп>, <id учасника>)` рядків, де користувач = `(SELECT simetra.current_user_id())`, за тією самою умовою, що `member_scopes`.
  - `rights_mine` — CTE:
    1. **призначення** — `UNION ALL` за `rightsCatalogs`: рівень скоупу — рядки призначень без позначки видалення, де `(<вид довідника призначень>, скоуп, subject)` ∈ `rights_my_scopes()` (Р2a1-26); глобальний — `subject = (SELECT current_user_id())`; архетип (для кастомної ролі — архетип ролі, з'єднаної за `(скоуп, id)` з довідником того самого рівня, без позначки видалення) береться лише з `rights_roles`, чий `storage`/`storage_id` — рівень цього довідника (Р2a1-12); `container` — лише для архетипів рівня `container` і лише через inner join з основною таблицею виду контейнера (`UNION ALL` за видами контейнерів) з тим самим скоупом і видом скоупу виду контейнера (нескоуплений вид контейнера — лише існування), `NULL` дає нуль рядків; для решти рівнів `container := NULL` (Р2a1-7);
    2. **рядки ролі** — архетип: `rights_projection` за `role_id`; кастомна: рядки архетипу без збігів `deny` (з точністю до обсягу й виміру) ∪ дельти `allow`, що є в `rights_domain` рівня архетипу; рядки поза доменом чи з невідомим архетипом відкидаються (відкидання за рівнем — це вже з'єднання за рівнем зберігання в кроці 1, другого фільтра немає);
    3. **замикання** — два послідовні CTE `closure_1`, `closure_2`: прохід лишає рядок попереднього, якщо для кожної вимоги з `rights_requires` у тому самому призначенні в попередньому проході є рядок вимоги на тому самому обсязі (і вимірі) чи на `any` (Р2a1-11; коментар генератора містить доказ двох проходів);
    4. **`everyUser`** — рядки проєкції ролей рівня `everyUser` зі `scope` і `container` = `NULL`, якщо `current_user_id()` не `NULL`.
  - `rights_any` / `rights_own` / `rights_dim` — `SELECT DISTINCT scope FROM rights_mine()` з `level = 'scope'` і відповідним обсягом; `rights_container` — `container` з `level = 'container'` (Р2a1-19); `has_right` — `EXISTS` над `rights_mine()` за об'єктом, дією, обсягом і виміром незалежно від скоупу, лише рядки з `level <> 'container'` (Р2a1-19).
  - `rights_my_members(p_scope_kind)` — `member` із `rights_my_scopes()` з `scope_kind_id = p_scope_kind`.
  - `rights_dimension_values` — `UNION ALL` за `accessDimensions`, кожна гілка під `p_dimension = '<id>'`: зв'язок — значення рядків, де суб'єкт ∈ `rights_my_members(<вид з relation.subjectTarget>)` (суб'єкт-учасник) чи = `current_user_id()` (`subjectTarget.users`); дослівна функція — `SELECT * FROM <схема>.<функція>()`.
  - Гранти — `executeGrants` за таблицею сигнатур.
- [ ] **Step 4:** Run: `pnpm --filter simetra test rights-functions creation-order platform-layer` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): функції проєкції й множини прав у схемі simetra"
```

---

### Задача 7: будівник умов політик (правило §5.4)

**Files:**
- Create: `packages/simetra/src/compiler/rights/predicates.ts`
- Test: `packages/simetra/src/compiler/__tests__/rights-predicates.test.ts` (новий)

**Interfaces:**
- Consumes: `RightsContract`, `RIGHTS_FUNCTIONS`, `CURRENT_USER` (`membership-functions.ts`; сталу експортувати — зараз вона локальна), колонка скоупу таблиці (`origin.scopeKindId`, як у `accessContracts`).
- Produces:

```ts
export type RightsCondition =
  | { kind: "column"; column: string; set: string; grantDependent: boolean } // `<column> = ANY (ARRAY(SELECT …))`
  | { kind: "currentUser"; column: string } // `<column> = (SELECT "simetra"."current_user_id"())`
  | { kind: "boolean"; expression: string } // `(SELECT "simetra"."has_right"(…))`, залежить від гранту
export interface RightsPredicate {
  extent: ProjectionExtent | { container: string; inner: ProjectionExtent }
  carrier?: string // колонка носія власності, виміру чи прив'язки
  conditions: RightsCondition[] // AND
}
export function rightsPredicates(
  contract: RightsContract,
  action: string,
  table: PhysicalTable
): RightsPredicate[] // OR між предикатами — одна PERMISSIVE-політика на предикат (2a2)
export function renderCondition(condition: RightsCondition): string
```

  Форми (Р2a1-10): скоуплений `any` — `[скоуп = ANY(rights_any(a, o))]`; `own` на носії-учаснику — `[носій = ANY(rights_my_members(<вид скоупу об'єкта>)), скоуп = ANY(rights_own(a, o))]`, на «Користувачах» — `[currentUser(носій), скоуп = ANY(rights_own(a, o))]`; вимір — `[носій = ANY(rights_dimension_values(d)), скоуп = ANY(rights_dim(a, o, d))]`; контейнер — `[прив'язка = ANY(rights_container(a, o, '<обсяг>', d))]` плюс умова власності чи виміру без гранту для внутрішніх `own`/вимір; нескоуплений — `any`: `[boolean has_right(a, o, 'any', NULL)]`, `own`: `[currentUser(носій), boolean has_right(a, o, 'own', NULL)]`, вимір: `[носій = ANY(rights_dimension_values(d)), boolean has_right(…, 'dimension', d)]`. Корінь скоупу — скоуп-колонка `id`. У 2a1 — основні таблиці й носії без шляху; шлях і ТЧ додає 2a2.

- [ ] **Step 1: Write the failing test (unit)** `rights-predicates.test.ts`:
  - `it("every predicate keeps at most one grant-dependent set (§5.4)")` — над `kitchen-sink.ts` і `withRoles` з усіма носіями 1a (`ownership: ["assignee"]`, `ownership: ["createdBy"]`, `access` на `region`, `containerBinding: "project"`): для кожного `RightsContract`, дії й предиката — `conditions.filter(grantDependent).length <= 1`, де `grantDependent` — `kind === "boolean"` чи `column` з `grantDependent: true`; і кожен відрендерений `renderCondition` розбирається libpg-query так: `column` і `currentUser` — `A_Expr` `=` з правою частиною `ARRAY(SubLink)` чи скалярним `SubLink`; `boolean` — голий `SubLink` (`EXPR_SUBLINK`); у жодному підзапиті немає посилань на колонки таблиці (некорельованість).
  - `it.each` форм (таблиця `[case, overrides, action, expected]`): `any` скоупленого `Task` → `["org_id = ANY (ARRAY(SELECT \"simetra\".\"rights_any\"('read', 'task')))"]`; `own` на `assignee` → дві умови в порядку (носій, скоуп); `own` на `createdBy` → `currentUser` першою; вимір `region` → значення виміру й `rights_dim`; контейнер `project` → `rights_container(…, 'any', NULL)`; нескоуплений `Announcement` `any` → одна умова `boolean`.
- [ ] **Step 2:** Run: `pnpm --filter simetra test rights-predicates` — FAIL.
- [ ] **Step 3: Implement** `predicates.ts` (лапки — `quoteIdent`, рядкові сталі — екранування літерала, як у генераторах).
- [ ] **Step 4:** Run: `pnpm --filter simetra test rights-predicates` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): будівник умов прав за правилом некорельованої форми"
```

---

### Задача 8: DB-сценарій функцій прав

**Files:**
- Create: `packages/simetra/test/db/auth.ts`, `packages/simetra/test/db/rights-functions.db.test.ts`
- Modify: `packages/simetra/test/db/access.db.test.ts`, `membership.db.test.ts`, `platform-users.db.test.ts` (імпорт спільного `signUp` замість трьох локальних копій; розширена форма `platform-users` — параметром будівника)

**Interfaces:**
- Consumes: `withRoles`, `singleTenantRights`, будівники `grant`, `deny`, `objects` (`fixtures/rights.ts`), `renderDesiredState`, `queryAs`, `rightsPredicates` і `renderCondition` (Задача 7).
- Produces: `signUp(client: pg.Client): Promise<string>` у `test/db/auth.ts`.

Причина DB-рівня (рядок у шапці файлу): множини, які повертають функції під `authenticated`, вирішує Postgres над даними — компілятор їх не бачить.

- [ ] **Step 1: Write the test.** Два описи, кожен із власним розгортанням (Р2a1-18).

  **Опис «with a scope kind».** `beforeAll`: компіляція `withRoles(...)` з грантами (`OrgMember` — набори фікстури; `OrgAdmin` — `fullAccess`; `ProjectLead` — `read@any` на `Task`; `Everyone` — `read@own` на «Користувачах»; `Task` з `ownership: ["assignee"]`, `access` на `region`, `containerBinding: "project"`), `renderDesiredState`; відкрити клієнта, `BEGIN`, розгорнути, засіяти: організації A, B; користувачі `u1` (учасник A, архетип `OrgMember`, `ProjectLead` на проєкті `P1`), `u2` (учасник A, кастомна роль `custom` на архетипі `OrgMember` з дельтами нижче), `u3` (учасник A, `OrgAdmin`), `u4` (учасник B без призначень), `u5` (глобальна `Support`), `u6` (учасник A, призначення `OrgMember` з позначкою видалення), `u7` (учасник A з призначенням `OrgMember`, недійсний: `invalid = true`), `u8` (учасник A і B, контейнер чужого тенанта в призначенні A), `u9` (кастомна роль на `OrgAdmin` з `deny read@any`), `u10` (кастомна роль на `OrgAdmin` з `deny read@any`, `deny update@own`, `deny post@any` — лишаються `post@own`, `update@any`, `read@own`), `u11`–`u14` (рівні, що не збігаються: призначення `Support` у `OrgRoleAssignments`; глобальне призначення `OrgAdmin`; глобальне призначення `ProjectLead` з контейнером `P1`; кастомна роль в `OrgRoles` на архетипі `Support`, призначена в A), `u15` (учасник A, кастомна роль з позначкою видалення), `u16` (учасник A, призначення `ProjectLead` з `container = NULL`), `u17` (учасник A і B, призначення `OrgMember` в A з `container = P2` тенанта B), `u18` (учасник A лише з `ProjectLead` на `P1`), `x1`, `x2` (Р2a1-26: учасники `team` з навмисно однаковими з A `id` кореня й учасника), `u19` (учасник A, призначення архетипу `Everyone` в `OrgRoleAssignments`), `u20` (учасник A, призначення архетипу `TeamLead` другого виду скоупу `team` в `OrgRoleAssignments`), `u21` (учасник A лише з `ProjectLead` на проєкті `P3` тенанта A з позначкою видалення). У u2 немає рядків `MemberRegion`. Для u20 опис додає перевизначенням `secondScopeKind()` (`fixtures/rights.ts`, новий будівник): вид скоупу `team` з коренем `Team`, членством `TeamMember`, довідниками `TeamRoles`/`TeamRoleAssignments`, довідником `TeamNote` і роллю `TeamLead` (`read@any` на `TeamNote`). `afterAll`: `ROLLBACK`, `client.end()`. Кожен кейс — `queryAs(client, "authenticated", { sub, role: "authenticated" }, sql)`:

| case | user | запит | очікування |
| --- | --- | --- | --- |
| `any` | u1 | `rights_any('read','task')` | `{A}` |
| `foreign-tenant` | u4 | `rights_any('read','task')` | `{}` |
| `deny-keeps-own` | u2 (дельта `deny read@any`) | `rights_any` / `rights_own` (`read`) | `{}` / `{A}` |
| `closure` | u2 (+ `allow update@any`) | `rights_any('update','task')` | `{}` |
| `closure-chain` | u9 | `rights_any('post','task')`, `rights_any('unpost','task')`, `rights_own('post','task')` | `{}`, `{}`, `{A}` |
| `closure-extents` | u10 | `rights_own('post','task')`, `rights_any('update','task')` | `{}`, `{}` |
| `domain` | u2 (+ `allow read@any` і `allow create@any` на `announcement`) | `has_right('read',…)`, `has_right('create','announcement','any',NULL)` | `true`, `false` |
| `global-catalog` | u2 (+ `allow read@any` на мітці `global_role_assignments`), u3 | `has_right('read','global_role_assignments','any',NULL)` | `false`, `false` |
| `level-mismatch` | u11, u12, u13, u14 | `has_right('read','announcement','any',NULL)`; `rights_any('delete','task')`; `rights_container('read','task','any',NULL)`; `has_right('read','announcement','any',NULL)` | `false`; `{}`; `{}`; `false` |
| `orphan` | u2 (+ `allow read@any` на мітці `gone`) | `has_right('read','gone','any',NULL)` | `false`, без помилки |
| `full-access` | u3 | `rights_any('delete','task')`, `has_right('read','announcement','any',NULL)` | `{A}`, `true` |
| `container` | u1 | `rights_container('read','task','any',NULL)` | `{P1}` |
| `foreign-container` | u8 (учасник A і B; у призначеннях A — `ProjectLead` з контейнером `P2` тенанта B) | `rights_container('read','task','any',NULL)` | `{}` |
| `cross-kind-assignment` | x1 (учасник `team` з коренем `team.id = A.id` і `TeamMember.id = id` учасника u3, якому в A призначено `OrgAdmin`) | `rights_any('delete','task')` | `{}` |
| `cross-kind-own` | x2 (учасник A з кастомною роллю `deny read@any` як у u2, плюс учасник `team` з `id` = `id` учасника u1) | `SELECT id FROM task WHERE <rightsPredicates(Task,'read')>`, `rights_my_members(<ORG_KIND_ID>)` | лише задачі A з `assignee` = учасник x2; `{<учасник x2 у A>}` |
| `container-null` | u16 | `rights_container('read','task','any',NULL)`, `rights_any('read','task')` | `{}` (без `NULL`), `{}` |
| `container-ignored` | u17 | `SELECT count(*) FROM simetra.rights_mine() WHERE level <> 'container' AND container IS NOT NULL`, `rights_container('read','task','any',NULL)` | `0`, `{}` (без `NULL`) |
| `container-only` | u18 (`ProjectLead` з `read@any`, тож `expandRole` породив і `read@own`, `read@region` з тим самим скоупом) | `rights_any('read','task')`, `rights_own('read','task')`, `rights_dim('read','task',<REGION_DIMENSION_ID>)`, `rights_container('read','task','any',NULL)` | `{}`, `{}`, `{}`, `{P1}` |
| `container-deletion-mark` | u21 | `rights_container('read','task','any',NULL)` | `{P3}` — позначка видалення контейнера прав не відкликає (Р2a1-28); мутації немає: це відсутність фільтра, а не запобіжник |
| `every-user-archetype` | u19 | `SELECT count(*) FROM simetra.rights_mine() WHERE scope IS NOT NULL AND level = 'everyUser'` | `0` |
| `other-scope-kind` | u20 | `rights_any('read','team_note')`, `SELECT count(*) FROM simetra.rights_mine() WHERE object = 'team_note'` | `{}`, `0` |
| `global` | u5 (`Support`: `read@any` на `Announcement`) | `has_right('read','announcement','any',NULL)`, `rights_any('read','task')` | `true`, `{}` |
| `every-user` | u4 | `has_right('read','users','own',NULL)` | `true` |
| `deletion-mark` | u6 | `rights_any('read','task')` | `{}` |
| `custom-deletion-mark` | u15 | `rights_own('read','task')` | `{}` |
| `invalid-user` | u7 | `rights_any('read','task')`, `has_right('read','users','own',NULL)` | `{}`, `false` |
| `service-role` | `service_role` без `sub` | `rights_any('read','task')` | `{}`, без помилки |
| `dimension-values` | u1 | `rights_dimension_values(<REGION_DIMENSION_ID>)` | регіони рядків `MemberRegion` учасника u1 |
| `predicate` | u2 (без `MemberRegion`, тож похідний `read@region` нічого не дає) | `SELECT id FROM task WHERE <rightsPredicates(Task,'read') через OR>` | лише задачі A з `assignee` = учасник u2 |

  `anon` — `queryAs(client, "anon", { role: "anon" }, "SELECT simetra.rights_any('read','task')")` → `{ code: "42501" }`.

  **Опис «without scope kinds».** `beforeAll` за `singleTenantRights()`: користувач `s1` з глобальним призначенням `ProjectLead` на `P1`, проєкти `P1`, `P2`. Кейс `single-tenant-container`: `has_right('read','task','any',NULL)` → `false`; `rights_container('read','task','any',NULL)` → `{P1}`.
- [ ] **Step 2:** Run: `pnpm --filter simetra exec vitest run --project db rights-functions` — тест проходить на коді Задач 1–7; **мутаційний доказ** (вручну, без коміту): прибрати з `rights_mine` умову замикання — червоніє `closure`; лишити один прохід замикання — `closure-extents`; прибрати фільтр домену — `domain`; прибрати правило рівня довідника прав з домену — `global-catalog`; прибрати фільтр позначки видалення — `deletion-mark`, `custom-deletion-mark`; прибрати умову скоупу контейнера — `foreign-container`; прибрати вид із з'єднання призначень з `rights_my_scopes()` — `cross-kind-assignment`; прибрати фільтр виду в `rights_my_members` — `cross-kind-own`; inner join контейнера замінити на left join — `container-null`; брати колонку `container` для неконтейнерних рівнів — `container-ignored` (перший запит); прибрати `level = 'container'` з `rights_container` — `container-ignored` (другий запит, `{NULL}`); прибрати `level = 'scope'` з `rights_any` — `container-only`; прибрати `level <> 'container'` з `has_right` — `single-tenant-container`; прибрати збіг рівня зберігання архетипу (з'єднання кроку 1) — `level-mismatch`, `every-user-archetype`, `other-scope-kind`; прибрати `level = 'scope'` з `rights_own` — `container-only` (`rights_own`); прибрати `level = 'scope'` з `rights_dim` — `container-only` (`rights_dim`); прибрати умову `current_user_id() IS NOT NULL` гілки `everyUser` — `invalid-user`. Повернути код.
- [ ] **Step 3:** Перенести `signUp` в `test/db/auth.ts`, імпортувати в обох наявних файлах; Run: `pnpm --filter simetra exec vitest run --project db access membership rights-functions` — PASS.
- [ ] **Step 4: Commit**

```bash
git add packages/simetra/test/db
git commit -m "test(db): сценарій функцій прав під роллю користувача"
```

---

### Задача 9: скіл, гейти й заміри

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md`, `docs/ROADMAP.md`, `docs/superpowers/plans/2026-10-18-rights-2a1-command-role-functions.md` (позначки)

- [ ] **Step 1:** Скіл споживача: системні довідники прав (ролі `rightsRoles`, `roleAssignments`, рівень — скоуп довідника, лише `read` до адміністрування прав), команда `simetra roles` перед першим `plan` на новій базі. Англійською.
- [ ] **Step 2:** Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — код 0.
- [ ] **Step 3:** Run: `pnpm metadata:check && python3 scripts/check-doc-anchors.py && .agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-18-rights-2a1-command-role-functions.md` — код 0, якорі живі.
- [ ] **Step 4:** Повний `pnpm test:db` на одному SHA (у фоні; зовнішній таймаут не коротший за 45 хв): `/usr/bin/time -f %e pnpm test:db` — код 0; записати тривалість і порівняти з останнім прогоном до плану (приріст ≤ 45 с: два розгортання сценарію, `roles-tool`, `provider-roles`; більший — звіт архітектору з розкладом за файлами).
- [ ] **Step 5:** ROADMAP — рядок прав: «Права-2a1 виконано»; позначки плану.
- [ ] **Step 6: Commit**

```bash
git add packages/designer/skills docs/ROADMAP.md docs/superpowers/plans/2026-10-18-rights-2a1-command-role-functions.md
git commit -m "docs(plan): Права-2a1 виконано — скіл, ROADMAP, позначки"
```

## Критерії приймання

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py` — зелені; повний `pnpm test:db` (разом із pgTAP) — зелений на одному SHA, приріст часу записано.
- CI job `db` на свіжому стеку зелений (доказ, що `supabase/roles.sql` застосовується).
- Згенерований SQL не містить `CREATE ROLE`, `ALTER ROLE`, `GRANT simetra_command TO` чи табличних грантів ролі команд (тест Задачі 1 `generated SQL never manages the command role itself`); потрібні ролі визначає `requiredPlatformRoles` (Задача 2).
- Політики таблиць не змінено: `access-units.test.ts` і `access.db.test.ts` проходять без правок очікувань (крім імпорту `signUp`).
- Кожен запобіжник функцій (замикання у два проходи, домен, рівень довідника й архетипу, контейнер у тенанті, контейнерні рядки поза `has_right`, позначка видалення, недійсний користувач) має мутаційний доказ Задачі 8.
