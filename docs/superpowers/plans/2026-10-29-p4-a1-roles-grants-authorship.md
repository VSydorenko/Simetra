# П4-A1: ролі, гранти, авторство — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: виконано; повні гейти — після дозволу архітекторки.
Архітекторка задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** у кластері з'являється роль входу рантайму `simetra_runtime` з
членствами `WITH INHERIT FALSE, SET TRUE`; режим обслуговування прав не
вмикається для жодної ролі входу платформи чи провайдера; роль команд
`simetra_command` отримує згенеровані гранти таблиць виду — `SELECT` і
поколонкові `INSERT`/`UPDATE` довідників за таблицею §6.2; тригер авторства
примушує `created_by_id`/`updated_by_id` під контекстом команди, а порядок
`BEFORE`-тригерів платформи `author → carriers → touch` тримається на будь-якій
довжині назви таблиці.

**Архітектура:**

- **T0** (`packages/simetra/src/model`): `PLATFORM_LOGIN_ROLES`,
  `LOGIN_ROLE_REQUEST_PURPOSES` (`schemas/project.ts`); прапорець реєстру
  `commandWrites` на виді `Catalog` (`kinds/standard.ts`, `kinds/catalog.ts`).
- **T1** (`packages/simetra/src/compiler`): `maintenanceSql` з обома
  переліками ролей входу; спільний будівник імен рядкових `BEFORE`-тригерів
  платформи; генератор тригера авторства; авторство — механіка (зміст,
  обробники, підписки, тригер ефектів); поколонкові гранти в генераторі
  доступу.
- **T2** (`packages/simetra/src/schema`): форма й створення ролі входу
  (`apply/platform-roles.ts`); зворотна генерація й промоція впізнають тригер
  авторства.
- **designer**: інструмент `roles` читає `database.provider` і створює
  `simetra_runtime` лише на цілі.
- **Стек:** `supabase/roles.sql`, pgTAP базового стану.

**Стек технологій:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query
(WASM), локальний стек Supabase (Postgres 17), `@supabase/pg-delta`.

**Спека:** [спека П4](../specs/2026-10-26-p4-runtime-design.md) — Рт7, Рт9,
Рт10 (§5), §6.2, §6.8, §6.16 (інваріанти 1, 2, 8, 9), §7 (рівні, кейси A1,
мутації, гейти), рядок A1 у §8, рядок про спільний префікс у §9, рядки з
блоком A1 у Додатку А. Суміжні: [спека прав](../specs/2026-10-17-rights-design.md)
§5.2, §5.3, §7 (режим обслуговування); [спека системної
схеми](../specs/2026-10-07-system-schema-users-design.md) §8 «Авторство»;
[спека designer](../specs/2026-10-02-simetra-designer-design.md) §3.2
«Платформні ролі». Плани [Права-2b1](2026-10-24-rights-2b1-write-policies-effects.md)
(Р2b1-9, Р2b1-13, Р2b1-15) і [Права-2c2](2026-10-25-rights-2c2-rights-administration-guards.md)
(Р2c2-18) — їхні рішення діють.

**Залежність:** Права-2c2 у `main` (влито в `feat/p4-a1`, `53be4ac5`).
Перед стартом — `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-29-p4-a1-roles-grants-authorship.md`.

## Global Constraints

- Усі обмеження планів Права-2a1…2c2 (розділи «Global Constraints») діють і тут.
- 🔴 `pnpm --filter <pkg> test <pattern>` — **без** `--` перед шаблоном.
- 🔴 Контекст команди в SQL — лише `simetra.command_current()` (Р2b1-2); користувач — лише `(SELECT simetra.current_user_id())`; режим обслуговування — лише `maintenanceSql(provider)`.
- 🔴 Розгалуження за видом — лише через реєстр видів (`AGENTS.md` § «Metamodel rules»); роль довідника — `catalog.role` / `rightsSystem`, не ім'я.
- 🔴 Колонку визначають за `origin` фізичного знімка (`standard`, `scopeKindId`, `copyOf`) і `table.origin.tabularSectionId`, не за фізичним ім'ям.
- 🔴 `TRUNCATE`, `REFERENCES`, `TRIGGER` ролі `simetra_command` — ніколи; на таблиці схеми `simetra` — нічого.
- 🔴 `GrantPurpose` не отримує ролей входу: генератор не може видати гранту `simetra_runtime`.
- Тести SQL — на деревах (`compiler/__tests__/fixtures/sql-shape.ts`: `tree`, `bodyShape`) чи цілими операторами, не `toContain` фрагмента.
- DB-тест — лише для того, що вирішує Postgres; кожен новий DB-кейс називає причину. Скіл `.agents/skills/writing-tests/SKILL.md` — перед кожним кроком тестів.
- Об'єкти стека — лише через run-tag (`packages/simetra/test/db/connection.ts`); виняток — Р-A1-12.
- Кожна відмова й кожен інваріант має тест, що червоніє від названої мутації; мутації — лише на закоміченому дереві.
- Між задачами гейти не червоні: зміна, що ламає тест чи фікстуру, і її правка — в одному коміті.
- Версій пакетів і `PLATFORM_VERSION` не чіпати. Репо публічне: фікстури синтетичні.

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р-A1-1 | **Задача 0 (факт, 2026-10-29):** на локальному стеку (PG 17.6) `postgres` не суперкористувач, але має членство в `authenticated` з `admin_option = t` (grantor `supabase_admin`). Отже `GRANT authenticated TO simetra_runtime WITH INHERIT FALSE, SET TRUE` від `postgres` проходить; членство в ролі запиту — основний шлях §6.2, запасний шлях серверного читання (§6.11) у A1 не потрібен. Рушій `@supabase/pg-delta` витягує колонкові ACL (`pg_attribute.attacl`), гейт (`schema/apply/fingerprint.ts`) їх уже порівнює | §6.2 «`ADMIN` на ролі запиту» — перевірка фактом | немає |
| Р-A1-2 | T0: `PLATFORM_LOGIN_ROLES = { runtime: "simetra_runtime" } as const` і `LOGIN_ROLE_REQUEST_PURPOSES: Readonly<Record<DatabaseProvider, readonly RequestRolePurpose[]>> = { supabase: ["user"] }` у `schemas/project.ts`, експорт з барелю. `GrantPurpose` без змін. `DATABASE_PROVIDERS` у коді — лише `supabase`; профіль `postgres` додасть свій рядок разом зі своїми ролями запиту | профіль вирішує членство в ролі запиту даними, а не гілкою за іменем провайдера | немає |
| Р-A1-3 | **Форма ролі входу.** `PlatformRoleRow.memberOf` стає `{ role, grantor, admin, inherit, set }[]` — рядок `pg_auth_members` на кожного grantor. Роль входу дійсна, коли атрибути — лише `login` (без `inherit`, `superuser`, `bypassRls`, `createRole`, `createDb`, `replication`); множина батьків дорівнює очікуваній; кожен рядок членства — `admin = false`, `inherit = false`, `set = true`; члени — за правилом ролей платформи (лише керівники з `ADMIN`). Порушення (перше за фіксованим порядком): атрибут; `member-of:<батько>` (зайвий батько); `membership-missing:<батько>`; `membership-option:<батько>` (рядок будь-якого grantor з `admin`, `inherit` чи без `set`); `member:<роль>`. **Ролі `PLATFORM_ROLES`:** правило членів без змін, крім одного — член з формою пари (`admin = false`, `inherit = false`, `set = true` у **кожному** рядку будь-якого grantor) допустимий, коли його ім'я в `loginNames`. `platformRoleRefusals(required, found, server, loginNames = Object.values(PLATFORM_LOGIN_ROLES), login?: { name; memberOf })`: виняток не залежить від того, хто кличе, тож `checkPlatformRoles` (`plan`, `diff`, `rehearse`, `apply`) і кожен прохід `ensurePlatformRoles` (ціль і тінь) приймають пару `simetra_runtime` без змін у викликах; тест на тегованих іменах передає `loginNames`. Форму самої ролі входу (`login`) повністю звіряє лише `roles`; але виняток **закритий за замовчуванням**: член з формою пари допустимий, лише коли рядок цієї ролі входу є в `found` і він має **безпечну форму**: атрибути — лише `login`; кожен рядок `memberOf` будь-якого grantor — `admin = false`, `inherit = false`, `set = true`; батьки ⊆ ролі платформи, які перевіряє цей виклик (`required` гейту, `names` у `ensurePlatformRoles` — так теговані тести мають тегованого батька) ∪ ролі запиту з `LOGIN_ROLE_REQUEST_PURPOSES` усіх провайдерів (і `login.memberOf`, коли його передано); батько поза множиною — `member-of:<батько>`; члени ролі входу — лише керівники з `ADMIN`. Порушення — відмова `plan.platform-role-shape` з `role: <роль входу>` і порушенням за порядком вище; рядка немає — `member:<роль входу>`. Повноту членств (`membership-missing`) звіряє лише `roles`: брак членства безпеки не послаблює. Тому `checkPlatformRoles` і перевірка `names` усередині `ensurePlatformRoles` читають `readPlatformRoles(tx, [...required, ...loginNames])`: інакше `GRANT simetra_runtime TO x` дав би `x` ланцюг `SET` до `simetra_command` повз гейт | з PG16 атрибут `NOINHERIT` лише задає типове значення, тож перевіряється кожен рядок пари (§6.2); послаблення «жодного члена з `SET`» — рівно для пар таблиці §6.2; без незалежного від виклику винятку після появи `simetra_runtime` кожен `plan` відмовляв би `member:simetra_runtime` | немає |
| Р-A1-4 | **`ensurePlatformRoles(dbs, servers, roles: PlatformRoleSet)`**, `PlatformRoleSet = { names: readonly string[]; login?: { name: string; memberOf: readonly string[] } }`. Ролі `names` — як зараз (`NOLOGIN NOINHERIT`, на кожному сервері). Роль `login` — лише на сервері `target`: відсутню створює `CREATE ROLE <q> LOGIN NOINHERIT` і `GRANT <батько> TO <q> WITH INHERIT FALSE, SET TRUE` на кожного батька в тому самому `SAVEPOINT`, після створення ролей `names`; наявну — звіряє (Р-A1-3), без виправлень; власні перевірки форми ролей `names` кличуть `platformRoleRefusals` з `loginNames = [roles.login.name]`, коли `login` задано. Перевірка `ADMIN` стосується **лише ролі входу**: ролі `names` створюються й без неї (від них залежить `plan` кожного проєкту, бо `SELECT` ролі команд дістає кожна таблиця з RLS), а відмова `roles.admin-option-missing` повертається разом з результатом створення `names` (новий результат `{ created: PlatformRoleOutcome[], refusal?: Diagnostic[] }`; інструмент `roles` показує обидва). Фаза читання ролі входу (до її запису), лише коли ролі входу немає: для кожного **наявного** батька (зокрема `simetra_command`, створеної раніше іншим виконавцем) — `pg_has_role(current_user, <батько>, 'MEMBER WITH ADMIN OPTION')`; без нього — відмова `roles.admin-option-missing` з `{ role: <батько> }`, роль входу не створено (ролі `names` — створено); відсутній батько поза `names` — та сама відмова. Не перевіряє лише батька з `names`, якого цей виклик створить: творець ролі отримує на неї `ADMIN` сам. Помічник `platformRoleSet(provider?: DatabaseProvider): PlatformRoleSet`: `names` — `Object.values(PLATFORM_ROLES)`; `login = { name: PLATFORM_LOGIN_ROLES.runtime, memberOf: [PLATFORM_ROLES.command, ...LOGIN_ROLE_REQUEST_PURPOSES[provider].map((p) => PROVIDER_API_ROLES[provider][p])] }`; без провайдера (немає файлу проєкту) — `{ names }` без `login`: роль входу не створюється й не звіряється | DB-тест працює на тегованих іменах (§6.2); бажаний SQL роль входу не згадує, тож тіні вона не потрібна; часткове створення без `ADMIN` лишило б роль без членства в ролі запиту; так само без провайдера — роль без членства в ролі запиту `roles` потім не виправив би (наявну лише звіряє) | спека П4 §6.2 «Хто створює»: «без файлу проєкту — лише членство в `simetra_command`» → «без файлу проєкту роль входу не створюється» (**відхилення на погодження архітекторки**); §6.2 «`ADMIN` на ролі запиту»: «Якщо `ADMIN` немає, `simetra_runtime` не стає членом ролі запиту…» → «Якщо `ADMIN` немає, `roles` створює ролі грантів, а на ролі входу відмовляє `roles.admin-option-missing` і її не створює; запасний шлях серверного читання — рішення мінімальної доставки (§9)» (Задача 6; **відхилення на погодження архітекторки**: роль без членства мовчки змінила б шлях читання) |
| Р-A1-5 | **Інструмент `roles`** читає `project.meta.json` теки проєкту (`ToolContext.dir`) тим самим читачем метаданих, що й інші інструменти (`readMetadataDir`), і бере `database.provider`; файлу немає — `platformRoleSet(undefined)` (лише ролі грантів, без ролі входу); файл є, але не проходить схему T0 — та сама відмова, що в `compile`. Опис інструмента й скіл кажуть, що `roles` читає файл проєкту | §6.2 «новий доступ інструмента — читання файлів проєкту» (`files: "read"` уже є) | немає |
| Р-A1-6 | **`maintenanceSql(provider)`** порівнює `session_user` з об'єднанням `PROVIDER_LOGIN_ROLES[provider]` і `Object.values(PLATFORM_LOGIN_ROLES)` (у порядку: провайдер, далі платформа) | §6.2 «Режим обслуговування прав»; у тому самому коміті, що й створення ролі (вимога архітекторки) | спека прав §7 — правка Додатку А (Задача 6) |
| Р-A1-7 | **Спільний префікс імен.** Новий модуль `compiler/before-trigger-names.ts`: `PLATFORM_BEFORE_ROW_LABELS = ["simetra_author", "simetra_author_update", "simetra_carriers", "simetra_rights_id", "simetra_touch", "simetra_touch_update"] as const` (порядок масиву = порядок спрацювання) і `platformBeforeTriggerName(table: string, label: PlatformBeforeRowLabel): string`. `L` = байти найдовшої мітки групи (21). Якщо `bytes(table) + 1 + L ≤ 63` — `${table}_${label}`; інакше — `${clipBytes(table, 63 - 1 - L - 9)}_${hash8}_${label}`, де `hash8 = sha256HexSync(table).slice(0, 8)` (той самий хеш, що `generatedTableFunctionName`). Через нього будуються `mechanicsTriggerName`, `mechanicsUpdateTriggerName`, `carrierTriggerNames(...).derive` (а з ним `carrierFunctionNames(...).derive`), ім'я тригера `simetra_rights_id` у `guard-names.ts` і тригери авторства. Ім'я **функції** `rights_id` лишається `generatedTableFunctionName`. Решта тригерів (`AFTER`, рядкові й операторні запобіжники `snapshot`/`truncate`, тригери підписок) — без змін: `AFTER` не впливають на `NEW`, а операторні тригери не перемежовуються з рядковими | Postgres бере тригери однакового часу за іменем (порівняння байтів); `makeObjectName` обрізає назву на довжину мітки, тож від 49 байтів `…_simetra_author` стала б після `…_simetra_carriers` (§6.8); таблиці до 41 байта імен не міняють | спека П4 §6.8 — «рядкові `BEFORE`-тригери платформи», перелік міток; рядок §9 закрито (Задача 6) |
| Р-A1-8 | **Тригер авторства.** Функція `simetra.author()` (`AUTHOR_FUNCTION`, одна на проєкт) — `LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''` (через `definerTrigger`, як функції ефектів і виведення носіїв, Р2b1-8; приватні копії `definerTrigger` у `effects-units.ts` і `carrier-units.ts` винести в один експорт поруч, напр. `compiler/rights/definer.ts`, і перевести обидва файли на нього), `EXECUTE` — нікому (`executeGrants(..., [], provider)`). Тіло: `IF (SELECT c.action FROM simetra.command_current() AS c) IS NOT NULL THEN IF TG_OP = 'INSERT' THEN NEW.created_by_id := (SELECT simetra.current_user_id()); END IF; NEW.updated_by_id := (SELECT simetra.current_user_id()); END IF; RETURN NEW;` — колонки за `authorColumns()` реєстру (фізичні імена — з реєстру, не літерали в генераторі). Тригери — на кожній таблиці з обома колонками `origin.standard` ∈ `authorStandardNames`: без копій носіїв — `<author> BEFORE INSERT OR UPDATE`; з копіями — `<author> BEFORE INSERT` і `<author_update> BEFORE UPDATE … WHEN (<contentChangeCondition>)`. Таблиця з лише однією з колонок чи з іншими фізичними іменами — `internal:` (як `buildMechanicsUnits`). `generator: "mechanics"`, `ownerObjectId` — об'єкт таблиці. **Лише коли `hasRightsFunctions(contracts, provider)`** (`compiler/rights/functions.ts`; той самий гейт, що в `command-units.ts` і `effects-units.ts`): без функцій прав немає ні `simetra.command_current()`, ні команд, тож примушувати нічого. Одиниця функції має `requires` на `functionIdentity` `COMMAND_FUNCTIONS.current` і `CURRENT_USER_FUNCTION`, як тригер ефектів | Рт7, §6.8: без контексту імпорт і мігратор пишуть історичних авторів; `WHEN` — щоб поширення копій не ставило `updated_by_id` чужим рядкам; без гейту тригер на проєкті з «Користувачами» й `trackAuthor`, але без ролей, ламав би кожен запис `42883`; `DEFINER` — бо `EXECUTE` на `simetra.command_current()` має лише `simetra_command` (`command-units.ts`), тож під правами викликача кожен запис ролі поза командою (сервісна роль, мігратор без гранту, кейс `provider-api-role-write`) падав би `42501` на функції контексту замість дійти до гілки «без контексту»; функції читають лише налаштування сесії (контекст, claims), тож роль власника нічого не розширює | спека П4 §6.8 — «`SECURITY INVOKER`» → «`SECURITY DEFINER SET search_path = ''`, як функції ефектів» (Задача 6) |
| Р-A1-9 | **Авторство — механіка.** `mechanics-units.ts`: `authorStandardNames(attributeCase)` (`createdBy`, `updatedBy` у стилі проєкту) і `nonContentStandardNames(attributeCase)` = `mechanicsStandardNames` ∪ `authorStandardNames`. `contentColumns` виключає `nonContentStandardNames`; `buildMechanicsUnits` і далі вимагає рівно `mechanicsStandardNames`. `beforeWriteMechanics` (`stages/links.ts`) повертає й колонки авторства — присвоєння в обробнику дає наявний код `subscription.handler-assigns-mechanics`; `checkSubscriptions` (`stages/integrity.ts`) вживає `nonContentStandardNames` там, де зараз `mechanicsStandardNames`. Кастомна дія з `effects.header`, що називає `createdBy` чи `updatedBy`, — той самий діагноз, що для `ref` (`immutableIds` у `compiler/rights/checks.ts`, Р2b1-23): `created_by_id` незмінний, `updated_by_id` примушує тригер, тож декларація нічого б не дала | §6.8: «колонки авторства — механіка; `beforeWrite` їх не присвоює»; окремий код не потрібен — вони механіка | немає |
| Р-A1-10 | **Тригер ефектів і умова `WHEN`.** `immutableColumns` додає колонку з `origin.standard` = стандартне ім'я `createdBy` у стилі проєкту. `contentChangeCondition(table, attributeCase, watched?: readonly PhysicalColumn[])`: з `watched` — `((<зміст>) OR (<watched>)) OR NOT (<копії>)`. Колонки авторства таблиці передають як `watched` три тригери: `<touch_update>`, `<author_update>`, `<effects_update>`; підписки — без `watched` (поведінка підписок не змінюється, крім виходу авторства зі змісту). У `replacements.ts` — два предикати: з `watched` авторства — для `touchUpdate`, `author_update` (і ефектів, якщо їх `WHEN` порівнюється); без `watched` — для пар підписок (`subscriptionShapes`). Попутно `immutableColumns` (`effects-units.ts`) і `guard-units.ts` порівнюють `invalid`/`userKind` за `standardLogicalName` у стилі проєкту, а не літералом `"userKind"` (дефект snake_case-проєкту; у звіт як кандидат поза планом, виправлено тут) | на таблиці, де копія носія виводиться з `createdBy`, зміна лише `created_by_id` змінює й копію, тож без `watched` умова хибна: ефекти не спрацювали б (незмінність трималась би лише грантом), а `touch` поза командою (мігратор) не підвищив би версію при зміні носія | немає |
| Р-A1-11 | **Гранти `simetra_command`.** Реєстр: `KindDefinition.commandWrites?: true`, ставить вид `Catalog`. `AccessContract.command?: { insert: readonly string[]; update: readonly string[]; delete: boolean }` (`contracts.ts`), рахує `accessContracts` для таблиць об'єкта виду з `commandWrites`. База = колонки таблиці без: `generated`, `origin.copyOf`, `origin.standard` ∈ {`version`, `updatedAt`, `createdAt`, `createdBy`, `updatedBy`, `predefinedName`} (стандартні імена в стилі проєкту). **insert** = база без колонок переходів (`RightsContract.transitions` об'єкта). **update** = база без ключа (`origin.standard` = `ref`), колонок з `origin.scopeKindId`, власника рядка ТЧ (`table.origin.tabularSectionId !== undefined` і `origin.standard` = `parent`), на основній таблиці «Користувачів» — `invalid`, `userKind`. Усі стандартні імена — через `standardLogicalName(def, attributeCase)` з визначень реєстру (`origin.standard` несе стиль проєкту: `user_kind` у snake_case), тож `accessContracts` отримує `attributeCase` проєкту новим параметром. **delete** = таблиця ТЧ або основна таблиця довідника з `rightsSystem === "roleAssignments"`. Основна таблиця «Користувачів» — `insert: []` (рядок без `INSERT`). ТЧ «Користувачів» — як ТЧ будь-якого довідника (**розвилка на погодження архітекторки до Задачі 4**: рядок ТЧ — частина об'єкта, а не створення користувача; запасний варіант, якщо не погоджено, — ТЧ «Користувачів» лише `UPDATE (<колонки зміни>)`, без `INSERT` і `DELETE`). `tableGrants` дає `GRANT SELECT ON TABLE <t> TO simetra_command` кожній таблиці `AccessContract`, а з `command` — ще `GRANT INSERT (<insert>)`, `GRANT UPDATE (<update>)`, `GRANT DELETE` окремими операторами (порожній перелік — без оператора); колонки — у порядку таблиці. `simetra_command` у `REVOKE` не додається (типових привілеїв він не має; зайве знімає дифф ACL рушія) | §6.2, Рт10; колонковий грант — друга лінія за тригером ефектів; факти — у контракті, генератор лише рендерить | спека П4 §6.2 — уточнення «ТЧ «Користувачів» — як ТЧ довідника» (Задача 6) |
| Р-A1-12 | **Справжня `simetra_runtime` у DB-тесті** — як `session_user`, за зразком `rights-guards.db.test.ts` «maintenance from provider API logins»: у `withRollback(fn, testSuperuserUrl())` (з'єднання суперкористувача `supabase_admin`; типовий `withRollback` іде від `postgres`, який не суперкористувач) модель розгортається під `SET ROLE postgres`, далі `RESET ROLE` і `SET SESSION AUTHORIZATION simetra_runtime` (той самий прийом у `rights-guards.db.test.ts`) дає справжнє ім'я сесії без пароля й без закоміченої бази. Роль створює `supabase/roles.sql` — тест чекає її після перезапуску стека (дозвіл архітекторки) і падає з поясненням, коли її немає. Проба режиму: функція-зонд `SECURITY DEFINER` власника `postgres` ставить `simetra.rights_maintenance = on` і вставляє призначення ролі без контексту команди; з сесії `simetra_runtime` (`SET ROLE simetra_command`, `EXECUTE` зонда виданий у тесті) → `rights-context`; з сесії `SET SESSION AUTHORIZATION postgres` → проходить (не `RESET`: він повертає до `supabase_admin`, ролі входу провайдера). Як у зразку — `SET CONSTRAINTS ALL IMMEDIATE`, щоб відкладена перевірка спрацювала в межах кейсу. RLS тут не бар'єр: зонд пише від власника таблиці | §7.2: «тегована роль ім'я не доводить» — режим судить `session_user`, і він тут — справжнє ім'я; зміна пароля спільної кластерної ролі лишила б слід після SIGKILL; запис під `simetra_command` без контексту зупинила б політика `command.context` раніше за запобіжник | немає; якщо архітекторка читає «вхід» як обов'язковий логін — запасна форма з тимчасовим паролем |
| Р-A1-13 | **Наявні DB-тести** (`rights-write.db.test.ts`, `rights-guards.db.test.ts`) лишають повний грант фікстури (Р2b1-13). Кейс `forged-author` лишає відмову `effect("created_by_id")`, але з новою причиною — незмінність `created_by_id` (коментар «Автора механіка не примушує (Р2b1-15)» → «`created_by_id` незмінний (Рт7)»). Відмову `42501` згенерованого гранту доводить новий опис без повного гранту (Задача 5) | §6.2 «Наявні DB-тести» | немає |

## Рішення архітекторки (2026-10-29)

План прийнято (`34744e7e`). Відхилення й розвилки:

- **Відхилення 1** (Р-A1-4, без `ADMIN` — `roles.admin-option-missing`) — так. Задача 6 править і §6.2 «`ADMIN` на ролі запиту», і рядок §9 про хостований Supabase: «`roles` відмовляє `roles.admin-option-missing`; запасний шлях читання під `simetra_command` — явний вибір мінімальної доставки, не неявна деградація».
- **Відхилення 2** (без файлу проєкту роль входу не створюється) — так, з умовою: пропуск не мовчазний. Вивід `roles` каже, що роль входу пропущено, і чому (немає `database.provider`); unit-кейс на цей вивід — Задача 1, Step 3.
- **Відхилення 3** (`simetra.author()` — `SECURITY DEFINER`) — так, з умовами (Задача 3, Step 1): `SET search_path = ''`, усі імена кваліфіковані; тіло лише кличе `simetra.command_current()` і `simetra.current_user_id()` і присвоює поля `NEW` — жодного читання таблиць чи іншого виклику (unit-тест на дереві: DEFINER, `search_path`, перелік викликів); `EXECUTE` відкликано від `PUBLIC` і ролей API (`executeGrants` без отримувачів); власник — той самий, що в функцій ефектів; `provider-api-role-write` лишається зеленим. У звіт: зіпсований `simetra.command` у сесії ролі API тепер дає `42501 command.context` уже з тригера авторства, не лише з тригера ефектів (очікувано; кейс — лише якщо 2b1 його не покриває).
- **Розвилка ТЧ «Користувачів»** — як ТЧ довідника: `INSERT`, `UPDATE`, `DELETE`. Межу тримають колонка власника рядка ТЧ поза колонками зміни і політики запису ТЧ за правом власника; `invalid`, `userKind` — лише в основній таблиці. Спека §6.2, рядок «Користувачі» → «основна таблиця — `UPDATE (<колонки зміни>)` без `INSERT`; ТЧ — як ТЧ довідника».
- **Р-A1-12** (`SET SESSION AUTHORIZATION` від `supabase_admin`) — прийнято, логін з паролем не потрібен.
- **Перезапуск стека** після Задачі 1 — дозволено з умовами: лише `pnpm db:stop && pnpm db:start` (жодних `db reset`, `--no-backup`, видалення томів: на стеку чужі бази `metahub_copy*`); перед зупинкою — жодного DB-прогону (сторож, `pg_stat_activity`); після старту — `simetra_runtime` має форму §6.2, бази `metahub_copy*` на місці (`SELECT datname FROM pg_database`). Якщо `roles.sql` на наявному томі не застосувався — зупинитись і написати архітекторці, не обходити.

## Відомі обмеження

- `simetra_runtime` на хостованому Supabase без `ADMIN` на ролі запиту — `roles` створює `simetra_command`, а на ролі входу відмовляє `roles.admin-option-missing`; запасний шлях — рішення мінімальної доставки (спека П4 §9).
- Порядок відносно `BEFORE`-тригерів підписок (`beforeWrite`) задає їхнє ім'я застосунку; присвоєння колонок авторства, механіки й копій у них забороняє компілятор (Р-A1-9), тож порядок на результат не впливає.
- SQL-ядра команд ще немає (A2): DB-кейси A1 пишуть через `commandAs`.

## Review Focus

1. **Довга назва таблиці з носієм за `createdBy.<вимір>`:** на 60-байтній назві копія носія дорівнює виміру примушеного автора, а не значенню із запиту. Тест — Задача 5 (`author-carrier`, коротка й довга назва).
2. **Довга назва при промоції й зворотній генерації:** прийнята таблиця на 42–63 байти з тригерами під **новими** іменами `platformBeforeTriggerName`, що кличуть платформні функції, впізнається як платформна; база, розгорнута до A1 зі старими іменами, отримує в плані звичайне зняття й створення тригерів (дифф рушія, без нового коду). Тест — Задача 2 (unit промоції й зворотної генерації).
3. **Другий grantor з `INHERIT TRUE`:** пара `simetra_runtime` → `simetra_command` з правильним рядком від `postgres` і другим рядком від іншого grantor з `INHERIT TRUE` — відмова `membership-option:simetra_command`. Тест — Задача 1 (designer DB).
4. **Зміна лише `created_by_id` на таблиці з копіями** під командою з повним грантом — `effect`. Тест — Задача 3 (unit `WHEN`) і Задача 5 (DB `author-immutable`).
5. **`INSERT` в основну таблицю «Користувачів» під `simetra_command`** — `42501`; `DELETE` основної таблиці звичайного довідника — `42501`. Тест — Задача 4 (unit) і Задача 5 (DB `grant-denials`).

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/model/schemas/project.ts`, `schemas/index.ts` | `PLATFORM_LOGIN_ROLES`, `LOGIN_ROLE_REQUEST_PURPOSES` |
| `packages/simetra/src/model/kinds/standard.ts`, `kinds/catalog.ts` | `commandWrites`; коментар `authorColumns` |
| `packages/simetra/src/compiler/rights/guard-units.ts` | `maintenanceSql` |
| `packages/simetra/src/schema/apply/platform-roles.ts` | форма й створення ролі входу, `platformRoleSet` |
| `packages/designer/src/tools/roles-tool.ts` | читання провайдера, роль входу |
| `supabase/roles.sql`, `supabase/tests/provider-base-state.test.sql` | роль локального стека й pgTAP |
| `packages/simetra/src/compiler/before-trigger-names.ts` (новий) | спільний префікс |
| `packages/simetra/src/compiler/mechanics-units.ts`, `rights/carrier-units.ts`, `rights/guard-names.ts` | імена через спільний префікс; `authorStandardNames`, `nonContentStandardNames`, `watched` |
| `packages/simetra/src/compiler/author-units.ts` (новий), `compiler/pipeline.ts` | тригер авторства |
| `packages/simetra/src/compiler/rights/effects-units.ts` | незмінний `created_by_id`, `watched` |
| `packages/simetra/src/compiler/stages/links.ts`, `stages/integrity.ts` | авторство — механіка |
| `packages/simetra/src/schema/reverse/units.ts`, `schema/apply/promotion/replacements.ts` | тригер авторства — платформний |
| `packages/simetra/src/compiler/contracts.ts`, `access-units.ts` | `AccessContract.command`, гранти |
| `packages/simetra/test/db/command-grants.db.test.ts` (новий), `rights-write.db.test.ts`, `provider-roles.db.test.ts` | DB-кейси |
| `packages/designer/src/__tests__/roles-tool.db.test.ts`, `schema-engine/__tests__/build-plan.db.test.ts` | роль входу; гейт бачить колонковий ACL |
| `docs/superpowers/specs/*`, `packages/designer/skills/simetra-metadata/*`, `docs/ROADMAP.md` | Додаток А, скіл, статус |

---

### Задача 0: факти стека (без змін коду)

Виконано автором плану 2026-10-29 (Р-A1-1). Виконавець повторює запити й
звіряє з Р-A1-1; розбіжність — до архітекторки до Задачі 1.

- [x] **Step 1:** `docker exec supabase_db_simetra psql -U postgres -d postgres -Atc "select r.rolname, m.rolname, g.rolname, am.admin_option, am.inherit_option, am.set_option from pg_auth_members am join pg_roles r on r.oid=am.roleid join pg_roles m on m.oid=am.member join pg_roles g on g.oid=am.grantor where r.rolname='authenticated' and m.rolname='postgres'"` — очікувано `authenticated|postgres|supabase_admin|t|t|t`.
- [x] **Step 2:** `grep -n "attacl" node_modules/.pnpm/@supabase+pg-delta@*/node_modules/@supabase/pg-delta/src/extract/relations.ts` — є витяг колонкового ACL.

---

### Задача 1: роль входу `simetra_runtime` і режим обслуговування

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts`, `packages/simetra/src/model/schemas/index.ts`
- Modify: `packages/simetra/src/compiler/rights/guard-units.ts` (`maintenanceSql`)
- Modify: `packages/simetra/src/schema/apply/platform-roles.ts`; коди `roles.admin-option-missing` — там, де зареєстровано `roles.create-role-denied` (`grep -rn "create-role-denied" packages/simetra/src`), з повідомленням; `roles.create-role-denied` діє й на відсутню роль входу
- Modify: `packages/designer/src/tools/roles-tool.ts`, `packages/designer/src/schema-engine/__tests__/engine-census.db.test.ts`
- Modify: `supabase/roles.sql`, `supabase/tests/provider-base-state.test.sql`
- Test: `packages/simetra/src/compiler/__tests__/rights-guards.test.ts`, `packages/simetra/src/schema/apply/__tests__/platform-roles.test.ts`, `packages/designer/src/__tests__/roles-tool.db.test.ts`, `packages/simetra/test/db/provider-roles.db.test.ts`

**Interfaces:**
- Produces: `PLATFORM_LOGIN_ROLES`, `LOGIN_ROLE_REQUEST_PURPOSES` (`simetra/model`); `PlatformRoleSet`, `platformRoleSet(provider?)`, `ensurePlatformRoles(dbs, servers, roles: PlatformRoleSet)`, `PlatformRoleRow.memberOf: { role; grantor; admin; inherit; set }[]`, `platformRoleRefusals(required, found, server, loginNames?: readonly string[], login?: { name; memberOf })`, `platformRoleGate(tx, required, loginNames, server)` (`simetra/schema`).

- [x] **Step 1: Unit `maintenanceSql`.** У `rights-guards.test.ts` кейс `maintenance mode requires a non-API login role` переписати: оракул — дерево виразу з масивом `[...PROVIDER_LOGIN_ROLES.supabase, ...Object.values(PLATFORM_LOGIN_ROLES)]`; окремо `it.each(DATABASE_PROVIDERS)` — масив містить `simetra_runtime` для кожного провайдера. Мутація: прибрати `PLATFORM_LOGIN_ROLES` з `maintenanceSql` → червоний.
- [x] **Step 2: Unit форми ролі входу** (`platform-roles.test.ts`, `describe("platformRoleRefusals")`, один `it.each`): рядки `PlatformRoleRow` для ролі входу → очікуване порушення: правильна форма → `[]`; атрибут `inherit: true` → `inherit`; без батька `authenticated` → `membership-missing:authenticated`; зайвий батько → `member-of:<x>`; другий рядок того самого батька від іншого grantor з `inherit: true` → `membership-option:simetra_command`; рядок з `admin: true` → `membership-option:…`. Ролі `simetra_command` (без аргументу `login`, як кличе `checkPlatformRoles`): член `simetra_runtime` з формою пари → `[]`; той самий член, але другий рядок іншого grantor з `inherit: true` → `member:simetra_runtime`; член з формою пари, чиє ім'я не в `loginNames` → `member:<роль>`; член `simetra_runtime` з правильною парою, але сам `simetra_runtime` має члена `x` з `SET` → `member:x`; рядка ролі входу немає в `found` → `member:simetra_runtime`; пара з `simetra_command` правильна, але рядок членства ролі входу в `authenticated` має `inherit: true` → `membership-option:authenticated` для ролі входу; роль входу з атрибутом `createRole` → `createRole`; роль входу з батьком поза множиною (напр. `service_role`) → `member-of:service_role` (мутації: гейт не звіряє `memberOf` ролі входу → червоний; не читати членів ролі входу → червоний; приймати пару без рядка ролі входу → червоний). Мутації: перевіряти лише перший рядок пари (а не всі grantor) → червоний; дозволити пару `SET` будь-якому члену `simetra_command` → червоний.
- [x] **Step 3: Unit `platformRoleSet`:** `supabase` → `login` = `{ name: "simetra_runtime", memberOf: ["simetra_command", "authenticated"] }`; `undefined` → `login` відсутній; `names` = `Object.values(PLATFORM_ROLES)`. Unit `ensurePlatformRoles` (наявний `describe` з фейком БД): роль входу не створюється на сервері `shadow`; батько поза `names` без `ADMIN` → `roles.admin-option-missing`, жодного запису для ролі входу, а `CREATE ROLE <command>` (ролі `names`, якої не було) — виконано; результат несе і `created`, і `refusal`; фейк кластера (`fakeCluster`) отримує відповідь на запит `pg_has_role(..., 'MEMBER WITH ADMIN OPTION')`; батько з `names`, якого виклик створює, перевірки `ADMIN` не проходить; наявний батько з `names` без `ADMIN` → `roles.admin-option-missing`.
- [x] **Step 4:** Run `pnpm --filter simetra test rights-guards platform-roles` — FAIL з очікуваних причин.
- [x] **Step 5: Реалізація T0, `maintenanceSql`, `platform-roles.ts`** за Р-A1-2…Р-A1-4, Р-A1-6. `readPlatformRoles` читає `memberOf` рядками з `grantor`, `admin_option`, `inherit_option`, `set_option`. Створення ролі входу — у тому самому `SAVEPOINT platform_role`, з `SET LOCAL createrole_self_grant = ''` (уже є). `ensurePlatformRoles` повертає й рядок ролі входу `{ server: "target", name, outcome }`.
- [x] **Step 6:** Run `pnpm --filter simetra test rights-guards platform-roles` — PASS; `pnpm --filter simetra typecheck`.
- [x] **Step 7: Інструмент `roles`** за Р-A1-5: `run({ database, dir })` — `platformRoleSet(provider)`; опис інструмента: "Creates the platform roles: NOLOGIN roles on the target and the shadow server, and the runtime login role on the target only. Reads the project file for `database.provider`." Наявні виклики `ensurePlatformRoles` (`roles-tool.db.test.ts`, `platform-roles.test.ts`) переходять на `PlatformRoleSet`; новий результат `{ created, refusal? }` — і в `RolesData` (`roles-tool.ts`) та його рендері (`packages/designer/src/cli/render.ts`). Опис інструмента: без файлу проєкту роль входу не створюється.
- [x] **Step 8: `supabase/roles.sql`:** після блоку `simetra_command` — блок `DO` з тим самим `createrole_self_grant = ''`: якщо немає `simetra_runtime` — `CREATE ROLE simetra_runtime LOGIN NOINHERIT; GRANT simetra_command TO simetra_runtime WITH INHERIT FALSE, SET TRUE; GRANT authenticated TO simetra_runtime WITH INHERIT FALSE, SET TRUE;`. Коментар — чому без пароля (ставить оператор; тест — Р-A1-12).
- [x] **Step 9: pgTAP** `provider-base-state.test.sql` (база `postgres`, де схеми `simetra` немає — привілеї на таблиці виду доводить Задача 5): `simetra_runtime` — `rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication`; рівно два рядки `pg_auth_members` з `member = simetra_runtime` — `simetra_command` і `authenticated`, кожен `NOT admin_option AND NOT inherit_option AND set_option`; `simetra_command` і `authenticated` не мають рядка членства між собою в жодному напрямку; наявне твердження «члени `simetra_command` лише з `ADMIN`» отримує виняток рівно для пари `simetra_runtime` з формою вище (`plan(N)` оновити). Запуск pgTAP — після перезапуску стека (Задача 5).
- [x] **Step 10: DB designer** (`roles-tool.db.test.ts`; причина DB — членства й `ADMIN` вирішує Postgres). Усі кейси — у `withRollback`, від тегованого виконавця `testRoleName("roles_exec")` (`CREATE ROLE … NOLOGIN CREATEROLE`; `postgres` отримує на нього `SET` через `GRANT … TO postgres WITH SET TRUE` у транзакції; далі `SET LOCAL ROLE` на нього), як уже робить наявний кейс без `CREATEROLE`. Імена — `testRoleName("command")`, `testRoleName("runtime")`; `loginNames` — тегований `runtime`:
  - (a) `ensurePlatformRoles` створює обидві ролі; `readPlatformRoles` + `platformRoleRefusals(..., loginNames, login)` → `[]`; другий виклик → `present`;
  - (b) батько ролі входу — справжній `authenticated` (лише якщо виконавець має на ньому `ADMIN`: виконавцем у цьому кейсі лишається `postgres`): рядок членства `inherit_option = false`, `set_option = true`;
  - (c) Review Focus 3: теговий керівник `testRoleName("mgr")` (`CREATEROLE`; `GRANT <command> TO <mgr> WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`; виконавець отримує `SET` на `mgr`) після `SET LOCAL ROLE <mgr>` дає `GRANT <command> TO <runtime> WITH INHERIT TRUE` (grantor — `mgr`), далі `SET LOCAL ROLE` назад на виконавця → повторний `ensurePlatformRoles` повертає відмови `plan.platform-role-shape`, серед яких `membership-option:<command>` (роль входу) і `member:<runtime>` (роль команд) — порівняння множиною, а `platformRoleRefusals([<command>], found, "target", [<runtime>])` — `member:<runtime>`;
  - (d) теговий батько `testRoleName("request")`, створений від `postgres` **до** `SET LOCAL ROLE` виконавця (виконавець не має на ньому `ADMIN`), у `login.memberOf` → `roles.admin-option-missing` з `{ role: <request> }`; ролі входу немає;
  - (e) теговий `<command>` уже існує, створений від `postgres` (виконавець не має на ньому `ADMIN`) → `roles.admin-option-missing` з `{ role: <command> }`, роль входу не створено; у (d) роль `<command>`, якої не було, — створено (результат містить і створення, і відмову);
  - (c′) теговий `x`; від виконавця `GRANT <runtime> TO x WITH SET TRUE` → `platformRoleGate(tx, [<command>], [<runtime>], server)` → `member:x`; (c″) правильна пара `<runtime>` → `<command>`, але другий батько `authenticated` виданий `WITH INHERIT TRUE, SET TRUE` → `platformRoleGate` → `membership-option:authenticated` (роль входу); повторний `ensurePlatformRoles` → `member:x`. Мутація: прибрати `loginNames` з виклику `readPlatformRoles` у `platformRoleGate` → червоний. Новий експортований помічник `platformRoleGate(tx, required, loginNames, server): Promise<Diagnostic[]>` — читання `readPlatformRoles(tx, [...required, ...loginNames])` і `platformRoleRefusals`; його кличуть `checkPlatformRoles` (після `requiredPlatformRoles`, з типовими `loginNames`), перевірка `names` в `ensurePlatformRoles` і внутрішня `shape()` у `createOrCheck` (повторна звірка після `42710`), з `roles.login.name` чи типовими `loginNames`; мутація: `shape()` без помічника → (a) «другий виклик → `present`» червоний; виклики `plan.ts`, `database-tools.ts`, `apply-tools.ts` — без змін. (`requiredPlatformRoles` відсікає не справжні імена, тож теговий кейс іде через помічник.)
  Мутація: `WITH INHERIT TRUE, SET TRUE` у `GRANT` створення → (a) червоний (просте прибирання `INHERIT FALSE` не мутація: з PG16 типове значення бере `NOINHERIT` ролі).
- [x] **Step 11: DB `provider-roles.db.test.ts`:** кейс `roles.sql` підміняє і `PLATFORM_ROLES.command`, і `PLATFORM_LOGIN_ROLES.runtime` тегованими іменами (батько `authenticated` лишається справжнім — у відкатній транзакції); `platformRoleRefusals` для обох ролей з тегованими `loginNames` і `login` → `[]`. Наявний кейс designer «the plan role of the local stack sees the command role» переписати на `platformRoleGate(tx, [PLATFORM_ROLES.command], Object.values(PLATFORM_LOGIN_ROLES), "target")` з очікуванням `[]` — після перезапуску стека з новим `roles.sql` прямий `platformRoleRefusals` з рядком лише `simetra_command` за Р-A1-3 дає `member:simetra_runtime` (закритий виняток), і саме так має бути.
- [x] **Step 11a: `engine-census.db.test.ts`** (designer): рушій бачить кожну кластерну роль і членство; після появи справжньої `simetra_runtime` перевірка «кожен факт ролі — роль платформи» бере `Object.values(PLATFORM_ROLES)` ∪ `Object.values(PLATFORM_LOGIN_ROLES)`, а факти `membership` між ролями платформи й ролями запиту провайдера — інфраструктура кластера, як `role` (коментар: ролі кластерні, бажаний стан бази їх не несе). Зелений до й після перезапуску стека; прогін після перезапуску — разом із pgTAP.
- [x] **Step 12:** Run `pnpm --filter simetra test rights-guards platform-roles`, `pnpm --filter simetra typecheck`, `pnpm --filter @simetrajs/designer typecheck`, `pnpm --filter simetra lint`, `pnpm --filter @simetrajs/designer lint`; scoped DB (без перезапуску стека — лише теговані імена): `pnpm --filter @simetrajs/designer test:db roles-tool` і `pnpm --filter simetra test:db provider-roles`.
- [x] **Step 13: Commit** (один коміт: роль і `maintenanceSql` разом)

```bash
git add packages/simetra/src packages/simetra/test packages/designer/src supabase
git commit -m "feat(roles): роль входу simetra_runtime і режим обслуговування без ролей входу платформи"
```

Після коміту — запит архітекторці на перезапуск стека (`pnpm db:stop && pnpm db:start`) для нового `roles.sql`; без «можна» Задачі 2–4 йдуть далі, а pgTAP і Задача 5 Step 2 чекають.

---

### Задача 2: спільний префікс імен рядкових `BEFORE`-тригерів

**Files:**
- Create: `packages/simetra/src/compiler/before-trigger-names.ts`
- Modify: `packages/simetra/src/compiler/mechanics-units.ts`, `compiler/rights/carrier-units.ts`, `compiler/rights/guard-names.ts`, `compiler/rights/guard-units.ts` (`triggerName` шукає ім'я за міткою в `rightsGuardNames`, а не перераховує `generatedTableFunctionName`), `model/physical/pg-names.ts` (експорт `clipBytes(bytes: Uint8Array, max: number)` через барель `simetra/model`, якщо T1 бере його звідти)
- Test: `packages/simetra/src/compiler/__tests__/before-trigger-names.test.ts` (новий), `mechanics-units.test.ts`, `carrier-units.test.ts`, `rights-guards.test.ts`, `schema/apply/__tests__/promotion-removals.test.ts`, `schema/__tests__/reverse-generate.test.ts`

**Interfaces:**
- Produces: `PLATFORM_BEFORE_ROW_LABELS`, `type PlatformBeforeRowLabel`, `platformBeforeTriggerName(table: string, label: PlatformBeforeRowLabel): string`.

- [x] **Step 1: Unit** `before-trigger-names.test.ts`, `describe.each` над назвами: коротка (`"client"`), 41 байт, 42 байти, 60 байтів ASCII, 60 байтів із кирилицею (межа символу UTF-8). Для кожної: (1) усі імена ≤ 63 байти; (2) `PLATFORM_BEFORE_ROW_LABELS.map(name)` відсортовані байтово (`Buffer.compare`) дорівнюють тому самому масиву в порядку міток; (3) префікс до мітки однаковий для всіх міток; (4) коротка й 41-байтна — `${table}_${label}`. Мутація: `platformBeforeTriggerName = (t, l) => makeObjectName(t, undefined, l)` → (2) червоний на 60-байтній (назва з літерою в позиції обрізання).
- [x] **Step 2:** Run `pnpm --filter simetra test before-trigger-names` — FAIL (модуля немає).
- [x] **Step 3:** Реалізувати за Р-A1-7; `clipBytes` і `sha256HexSync` — ті самі, що в `model/physical/pg-names.ts` і `compiler/rights/generated-names.ts` (винести `clipBytes` в експорт `pg-names.ts`, якщо він приватний). Перевести `mechanicsTriggerName`, `mechanicsUpdateTriggerName`, `carrierTriggerNames().derive`, тригер `simetra_rights_id` у `TABLE_GUARDS`.
- [x] **Step 4:** Оновити очікування довгих назв у `mechanics-units.test.ts` (кейс 60 байтів), `carrier-units.test.ts`. Review Focus 2 (unit) — у `promotion-removals.test.ts` кейс прийнятої таблиці з назвою 50 байтів і тригерами `touch`/`carriers` під іменами `platformBeforeTriggerName`, що кличуть платформні функції: розпізнаються як платформні (той самий результат, що наявні кейси коротких назв). У `reverse-generate.test.ts` — той самий кейс 50-байтної таблиці: тригери й функція виведення носіїв під новими іменами — платформні. У `rights-guards.test.ts` — таблиця 50 байтів компілюється, а тригер `simetra_rights_id` має ім'я `platformBeforeTriggerName` (мутація: лишити `triggerName` на `generatedTableFunctionName` → `internal: unknown rights trigger`).
- [x] **Step 5:** Run `pnpm --filter simetra test` (весь unit пакета) — PASS; typecheck, lint. Scoped DB (імена тригерів у точних переліках): `pnpm --filter simetra test:db mechanics carrier promote rights-guards` і `pnpm --filter @simetrajs/designer test:db promotion build-plan round-trip` — PASS; кожен тест із літеральним довгим іменем тригера оновити в цьому ж коміті (`grep -rn "_simetra_touch\|_simetra_carriers\|_simetra_rights_id" packages/*/src packages/*/test`).
- [x] **Step 6: Commit**

```bash
git add packages/simetra/src packages/simetra/test packages/designer/src
git commit -m "feat(compiler): спільний префікс імен рядкових BEFORE-тригерів платформи"
```

---

### Задача 3: тригер авторства й авторство як механіка

**Files:**
- Create: `packages/simetra/src/compiler/author-units.ts`
- Modify: `compiler/mechanics-units.ts`, `compiler/pipeline.ts`, `compiler/rights/effects-units.ts`, `compiler/rights/checks.ts`, `compiler/rights/guard-units.ts`, `compiler/rights/carrier-units.ts` (спільний `definerTrigger`), `compiler/__tests__/rights-contract.test.ts`, `compiler/stages/links.ts`, `compiler/stages/integrity.ts`, `schema/reverse/units.ts`, `schema/apply/promotion/replacements.ts`, `model/kinds/standard.ts` (коментар `authorColumns`: «заповнює `runCommand`» → «примушує тригер авторства під контекстом команди»)
- Modify (фікстура): `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` — шар `authorCarrier(physicalName?: string): Layer`
- Test: `compiler/__tests__/author-units.test.ts` (новий), `effects-units.test.ts`, `mechanics-units.test.ts`, тести діагностик обробників (файл, де тестується `subscription.handler-assigns-mechanics`), `promotion-removals.test.ts`, `reverse-generate.test.ts`

**Interfaces:**
- Consumes: `platformBeforeTriggerName` (Задача 2).
- Produces: `AUTHOR_FUNCTION`, `authorTriggerName(table)`, `authorUpdateTriggerName(table)`, `buildAuthorUnits(physical, contracts, attributeCase, provider, module, parse): SqlUnit[]` (параметри — як у `buildMechanicsUnits` плюс `contracts` для гейту `hasRightsFunctions`); `authorStandardNames`, `nonContentStandardNames`; `contentChangeCondition(table, attributeCase, watched?)`; шар `authorCarrier`.

Шар фікстури `authorCarrier(variant: "short" | "long" = "short")` (поверх `policyDomain()` і `writeRoles()`; той самий стиль, що `adminRoles()`): «Користувачі» отримують реквізит-`Ref` `region` на довідник регіонів, що вже є вимір доступу фікстури (якщо такого довідника немає — новий довідник `Region` і вимір `region` у шарі); довідник `Note` (`scopeKind: "org"`, `trackAuthor: true`, реквізит `text`, ТЧ `lines` з реквізитом `text`), варіант `short` — файл `NOTE_FILE`, об'єкт `Note`, `physicalName` `note`; варіант `long` — окремий файл `NOTE_LONG_FILE`, об'єкт `NoteLong`, власні UUID об'єкта, реквізитів, ТЧ і ролі, `physicalName` `NOTE_LONG`, ТЧ — `physicalName` `note_long_lines` (шари зливаються за шляхом файлу, тож варіанти мусять мати різні файли й ідентичності); спільні для обох — реквізит «Користувачів» і вимір; носій прав `Note` — за шляхом `createdBy.region`; роль `NoteWriter` (`org`) — `read`, `create`, `update` `@any` на `Note`. Експорти `NOTE_FILE`, `NOTE_LONG_FILE`, `NOTE_WRITER_ID`, `NOTE_LONG_WRITER_ID`. 60-байтна назва для Задачі 5 — `NOTE_LONG = "note_" + "a".repeat(55)` (літери в позиціях обрізання: мутація `makeObjectName` дає непослідовний порядок).

- [x] **Step 1: Unit `author-units.test.ts`** (фікстура — `authorCarrier()`): (a) `bodyShape` функції `simetra.author()` = дерево з Р-A1-8 (гілка лише під `action IS NOT NULL`; на `INSERT` — обидві колонки; на `UPDATE` — лише `updated_by_id`; значення — `(SELECT simetra.current_user_id())`); атрибути — `SECURITY DEFINER`, `search_path = ''`; (b) таблиця з `trackAuthor` без копій (наявний `Task` фікстури `rights.ts`) — один оператор `CREATE TRIGGER <author> BEFORE INSERT OR UPDATE … EXECUTE FUNCTION simetra.author()` (дерево цілого оператора); (c) `Note` (копія з `createdBy`) — `BEFORE INSERT` і `BEFORE UPDATE … WHEN (<те саме дерево, що в touch_update, з watched авторства>)`; (d) таблиця без `trackAuthor` — без тригера; (e) колонки з чужим фізичним іменем → `internal:`; (f) проєкт з «Користувачами» й `trackAuthor`, але без ролей (`hasRightsFunctions` хибний) — жодної одиниці авторства. Мутації: прибрати перевірку контексту → (a) червоний; ставити `created_by_id` і на `UPDATE` → (a) червоний; прибрати `WHEN` → (c) червоний; прибрати гейт → (f) червоний; `SECURITY INVOKER` замість `DEFINER` → `provider-api-role-write` (`rights-write.db.test.ts`, Step 6) червоний.
- [x] **Step 2: Unit механіки.** `effects-units.test.ts` (кейс Р2b1-15 на рядках ~100–120): `created_by_id`, `updated_by_id` — поза переліком змісту; `created_by_id` — серед незмінних (`IF TG_OP = 'UPDATE' AND OLD.created_by_id IS DISTINCT FROM NEW.created_by_id THEN … DETAIL = 'effect'`); на `Note` умова `<effects_update>` = `((<зміст>) OR (<created_by_id змінився> OR <updated_by_id змінився>)) OR NOT (<копії>)` (Review Focus 4, дерево); те саме `watched` у `<touch_update>` `Note`. `mechanics-units.test.ts`: «content columns are one list» — без колонок авторства. Діагностика: обробник `beforeWrite`, що присвоює `NEW.created_by_id` чи `NEW.updated_by_id` на таблиці з `trackAuthor` → `subscription.handler-assigns-mechanics`; підписка з `whenChanged` на `updatedBy` → той самий код, що на `updatedAt`. `rights-contract.test.ts`: дія з `effects.header: ["createdBy"]` чи `["updatedBy"]` → той самий код, що для `ref` (наявну фікстурну дію `stamp` перевести на змістовий реквізит); `effects-units.test.ts` і `rights-guards.test.ts` — кейс проєкту `snake_case`: `user_kind` серед незмінних. Promotion: таблиця з `trackAuthor`, копіями й парою підписки — пара підписки впізнається (предикат без `watched`), `touch_update` — теж (з `watched`). Мутації: прибрати `authorStandardNames` з `beforeWriteMechanics` → червоний; прибрати `watched` з ефектів → червоний; прибрати `createdBy` з `immutableIds` → червоний.
- [x] **Step 3: Unit розпізнавачів.** `reverse-generate.test.ts`: зворотна генерація таблиці з тригером авторства відносить тригер і `simetra.author()` до платформних. `promotion-removals.test.ts`: прийнята таблиця з тригером `<t>_simetra_author`, що кличе `simetra.author()`, — платформний (замінюється, не «чужий»); тригер з тим самим іменем на іншу функцію — не платформний. Мутація: прибрати предикат `author` з `platform` у `replacements.ts` → червоний.
- [x] **Step 4:** Run `pnpm --filter simetra test author-units effects-units mechanics-units promotion-removals reverse-generate` — FAIL з очікуваних причин.
- [x] **Step 5:** Реалізація за Р-A1-8…Р-A1-10; `buildAuthorUnits` підключити в `pipeline.ts` поряд із `buildMechanicsUnits`; предикат `author` у `replacements.ts` — ім'я (`authorTriggerName`/`authorUpdateTriggerName`) + `sameFunction(t.function, AUTHOR_FUNCTION)`, для `author_update` ще `isContent` дерева `WHEN`, як `touchUpdate`; `reverse/units.ts` — гілка «тригер авторства → `simetra.author()`» і коментар.
- [x] **Step 6:** Run `pnpm --filter simetra test` (весь unit пакета: зміна змісту зачіпає багато тестів) — PASS; typecheck, lint; `pnpm metadata:check` — без нових помилок на `examples/` (нові попередження — у звіт). Scoped DB (зміст, `WHEN`, ефекти): `pnpm --filter simetra test:db mechanics rights-write rights-guards subscriptions carrier` і `pnpm --filter @simetrajs/designer test:db promotion build-plan` — PASS; `forged-author` переписати тут за Р-A1-13.
- [x] **Step 7: Commit**

```bash
git add packages/simetra/src packages/simetra/test packages/designer/src
git commit -m "feat(compiler): тригер авторства під контекстом команди; авторство — механіка"
```

---

### Задача 4: гранти `simetra_command`

**Files:**
- Modify: `packages/simetra/src/model/kinds/standard.ts`, `model/kinds/catalog.ts` (`commandWrites`)
- Modify: `packages/simetra/src/compiler/contracts.ts`, `compiler/access-units.ts`
- Test: `packages/simetra/src/compiler/__tests__/access-units.test.ts`, `function-execute.test.ts`

**Interfaces:**
- Produces: `KindDefinition.commandWrites?: true`; `AccessContract.command?: { insert; update; delete }`; `accessContracts(..., attributeCase)` — новий параметр (виклик у `pipeline.ts`); `tableGrants(table, readers, provider, command?)`.

- [x] **Step 1: Unit `access-units.test.ts`**, один `describe.each` над таблицями фікстури (шар з довідником зі скоупом, ТЧ, переходом, `predefined_name`, копією носія, `trackAuthor`, ієрархією; системні «Призначення ролей» і «Користувачі» з ТЧ): для кожної таблиці — повний відсортований перелік операторів `tableGrants` для `simetra_command` дорівнює очікуваному. Очікування, які мусять бути в таблиці кейсів:
  - основна довідника: `SELECT`; `INSERT (<зміст>, id, <скоуп>)` — без `deletion_mark` (перехід), `version`, `created_at`, `updated_at`, `created_by_id`, `updated_by_id`, `predefined_name`, копії; `UPDATE (<зміст>, deletion_mark, parent_id)` — ієрархічний `parent_id` є, ключа й скоупу немає; без `DELETE`;
  - ТЧ довідника: `INSERT (…, parent_id, line_number)`, `UPDATE (…, line_number)` без `parent_id`, `DELETE`;
  - «Призначення ролей»: ще `DELETE` основної;
  - «Користувачі» основна: лише `SELECT` і `UPDATE (…)` без `invalid`, `user_kind`; без `INSERT`;
  - таблиця документа (вид без `commandWrites`): лише `SELECT`;
  - жодна таблиця: `TRUNCATE`, `REFERENCES`, `TRIGGER`, `ALL`; жодна одиниця не має цілі в схемі `simetra`.
  Мутації: зняти колонковий перелік (`GRANT INSERT ON TABLE`) → червоний; розпізнавати власника ТЧ за фізичним ім'ям `parent_id` → червоний на ієрархічному довіднику; дати `DELETE` основній таблиці довідника → червоний.
- [x] **Step 2: Характеризаційний unit `function-execute.test.ts`** (не red-first: заборона вже діє за ціллю): дослівний `GRANT UPDATE (x) ON TABLE <таблиця виду> TO <роль>` у SQL застосунку → `sql.generated-grant`. Мутація: `grantTargetKeys` ігнорує оператори з колонками → червоний.
- [x] **Step 3:** Run `pnpm --filter simetra test access-units` — FAIL (Step 1); `function-execute` — PASS (Step 2).
- [x] **Step 4:** Реалізація за Р-A1-11. Ім'я ролі — `PLATFORM_ROLES.command` через наявний помічник `grantRole`; колонки — `quoteIdent`, порядок — колонок таблиці.
- [x] **Step 5:** Run `pnpm --filter simetra test` — PASS (оновити наявні точні очікування `GRANT SELECT … TO authenticated` там, де до переліку додаються оператори `simetra_command`); typecheck, lint; `pnpm metadata:check`. Unit-таблиця Step 1 має й кейс проєкту зі стилем `snake_case` (`user_kind`). Scoped DB (гранти в розгортанні й промоції): `pnpm --filter simetra test:db access rights-write rights-guards promote` і `pnpm --filter @simetrajs/designer test:db build-plan promotion round-trip engine-extract` — PASS.
- [x] **Step 6: Commit**

```bash
git add packages/simetra/src packages/simetra/test packages/designer/src
git commit -m "feat(compiler): гранти simetra_command — SELECT і поколонкові INSERT/UPDATE довідників"
```

---

### Задача 5: DB-кейси A1

**Files:**
- Create: `packages/simetra/test/db/command-grants.db.test.ts`
- Modify: `packages/simetra/test/db/rights-write.db.test.ts` (`forged-author`, Р-A1-13)
- Modify: `packages/designer/src/schema-engine/__tests__/build-plan.db.test.ts`
- Fixtures: шар `authorCarrier` (Задача 3) — обидва варіанти, `authorCarrier("short")` і `authorCarrier("long")`, в одному розгортанні.

Один опис — одне розгортання; кожен кейс — у точці збереження `commandAs`. **Без** повного гранту таблиць фікстури (`GRANT … ON ALL TABLES`): діють лише згенеровані гранти; членство `GRANT simetra_command TO CURRENT_USER WITH SET TRUE` у транзакції опису лишається (його потребує `SET LOCAL ROLE` у `commandAs`). Причина DB — привілеї, порядок тригерів і RLS вирішує Postgres.

- [x] **Step 1: Кейси `command-grants.db.test.ts`** (`it.each` там, де форма однакова):
  - `grant-denials`: під `commandAs` — `UPDATE … SET version = …`, `UPDATE … SET created_by_id = …`, `INSERT (…, created_by_id)` основної, `INSERT` в основну «Користувачів», `DELETE` основної довідника, `TRUNCATE` → відмова саме гранту: `code = "42501"`, `message` відповідає `/^permission denied for (table|column) /`, `detail` відсутній (не `command.forbidden`/`command.context` з RLS чи тригера); `DELETE` рядка ТЧ — не відмова гранту;
  - `author-forced`: вставка під контекстом користувача U з явним `created_by_id` неможлива (грант), тож вставка без неї — `created_by_id = updated_by_id = U`; зміна змісту під V — `updated_by_id = V`, `created_by_id = U`;
  - `author-not-overridden`: від власника (поза кейсом) додати `ALTER COLUMN created_by_id SET DEFAULT '<X>'` і сирий `BEFORE`-тригер з іменем, що сортується раніше за `<t>_simetra_author`, який ставить `NEW.created_by_id := '<X>'`; вставка під U → `U`; усе — у точці збереження, відкочується;
  - `author-no-context`: вставка власником без контексту з `created_by_id = H` → `H` лишається;
  - `author-carrier` (Review Focus 1, коротка й 60-байтна назва): копія носія `createdBy.<вимір>` нового рядка дорівнює виміру U;
  - `author-immutable` (Review Focus 4): на `Note` (копія з `createdBy.region`, автори в різних регіонах) під грантом **цього кейсу** (`GRANT UPDATE (created_by_id)` у точці збереження) зміна лише `created_by_id` → `command.forbidden` / `effect`.
  Мутації (кожна на закоміченому дереві, результат — у звіт): прибрати колонковий перелік гранту → `grant-denials` червоний; перейменувати тригер авторства на `makeObjectName` → `author-carrier` на 60 байтах червоний; прибрати `watched` → `author-immutable` червоний; прибрати перевірку контексту → `author-no-context` червоний.
- [x] **Step 2: Кейс справжньої ролі** (той самий файл, окремий `describe`, Р-A1-12, у `withRollback`): після розгортання моделі `SET SESSION AUTHORIZATION simetra_runtime`: (a) інваріант 1 (§6.16) — каталогом, а не пробою (відмова `USAGE` схеми маскувала б прямі гранти): для кожної таблиці виду й кожної таблиці схеми `simetra` `has_table_privilege('simetra_runtime', <oid>, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')` — `false`; для кожної функції схеми `simetra` (функцій ядра ще немає — A2) `has_function_privilege('simetra_runtime', <oid>, 'EXECUTE')` — `false`; `has_schema_privilege('simetra_runtime', 'simetra', 'USAGE')` — `false`; плюс одна проба: `SELECT` з таблиці виду під сесією `simetra_runtime` → `42501`. Мутація: `GRANT SELECT ON <таблиця> TO simetra_runtime` у точці збереження → червоний; (b) проба режиму за Р-A1-12: сесія `simetra_runtime` → `SET ROLE simetra_command` → виклик зонда → `command.forbidden` / `rights-context`; `SET SESSION AUTHORIZATION postgres`, той самий зонд → проходить. Обидві гілки — з `SET CONSTRAINTS ALL IMMEDIATE`, у точках збереження. Мутація: прибрати `PLATFORM_LOGIN_ROLES` з `maintenanceSql` → (b) червоний. Потрібен перезапуск стека з новим `roles.sql` — **лише з «можна» архітекторки**; після нього — pgTAP базового стану (команда — та, що `pnpm test:db` вживає для pgTAP).
- [x] **Step 3:** `forged-author` переписано в Задачі 3 (Р-A1-13); тут лише перевірити, що опис `rights-write` зелений.
- [x] **Step 4: Гейт бачить ACL** (`build-plan.db.test.ts`, поряд із «plans over drift by model»): після `establish` — `GRANT UPDATE (version) ON app.<t> TO simetra_command` → `apply.drift`, шлях дрейфу містить ACL колонки; план повертає ACL до бажаного. Мутація: виключити рівень `column` із запиту ACL `fingerprint.ts` → червоний.
- [x] **Step 5:** Run scoped DB: `pnpm --filter simetra test:db command-grants rights-write provider-roles`, `pnpm --filter @simetrajs/designer test:db build-plan roles-tool` — PASS; час — у звіт.
- [x] **Step 6: Commit**

```bash
git add packages/simetra/test packages/simetra/src/compiler/__tests__/fixtures packages/designer/src
git commit -m "test(db): гранти simetra_command, примушене авторство, роль входу й режим обслуговування"
```

**Контрольна точка:** SHA, коміти, мутації, час DB, рішення й відхилення — архітекторці; далі — лише з «далі».

---

### Задача 6: документи

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§5.3, §7)
- Modify: `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` (§8 «Авторство»)
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` (§6.2, §6.8, §9)
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md`, `references/people-and-rights.md`
- Modify: `docs/ROADMAP.md`

- [x] **Step 1:** Спека прав §5.3: «авторство (`created_by`, `updated_by`) стане механікою з примушеною механікою авторства П4, а до того його зміна під дією-переходом — відмова тригера ефектів» → «авторство (`created_by`, `updated_by`) — механіка: під контекстом команди його примушує тригер авторства ([спека П4](2026-10-26-p4-runtime-design.md) §6.8), `created_by` незмінний за будь-якої дії».
- [x] **Step 2:** Спека прав §7: «…діє лише для сесії, чия роль входу не належить до ролей входу API провайдера)» → «…до ролей входу API провайдера й до ролей входу платформи)».
- [x] **Step 3:** Спека системної схеми §8: «їх заповнює `runCommand` з `current_user_id()`» → «їх примушує тригер авторства під контекстом команди з `current_user_id()` ([спека П4](2026-10-26-p4-runtime-design.md) §6.8); без контексту (імпорт, мігратор) значення пише той, хто пише рядок».
- [x] **Step 4:** Спека П4: §6.2 «Хто створює» і «`ADMIN` на ролі запиту» — за Р-A1-4; §6.8 — «(платформна функція в схемі `simetra`, як `touch`; `SECURITY INVOKER`)» → «(платформна функція в схемі `simetra`; `SECURITY DEFINER SET search_path = ''`, як функції ефектів: `EXECUTE` функції контексту має лише роль команд)» (Р-A1-8), «імена рядкових `BEFORE`-тригерів платформи» і перелік міток Р-A1-7; рядок §6.8 «`created_by_id` додається до незмінних колонок тригера ефектів» доповнити «; кастомна дія не називає `createdBy`/`updatedBy` у шапці ефектів (Р-A1-9)»; §6.2 — «ТЧ «Користувачів» — як ТЧ довідника» (Р-A1-11); §9 — рядок про спільний префікс прибрати (закрито A1); Додаток А — у колонці «Блок» рядків A1 нічого не міняти (стан описує текст спек).
- [x] **Step 5:** Скіл `simetra-metadata`: абзац про `roles` — «creates `simetra_command` (`NOLOGIN NOINHERIT`, target and shadow) and, when a project file is present, the runtime login role `simetra_runtime` on the target only (`LOGIN NOINHERIT`, member of `simetra_command` and, for `supabase`, of `authenticated` with `INHERIT FALSE, SET TRUE`); reads `database.provider` from the project file; the operator sets the password»; таблиця інструментів — `roles` читає файл проєкту; `people-and-rights.md` «Authorship» — «under a command the platform forces `createdBy`/`updatedBy` to the current user; `createdBy` never changes; a `beforeWrite` handler may not assign them».
- [x] **Step 6:** ROADMAP, рядок раннього зрізу П4: «в роботі: план A1» → «A1 (ролі, гранти, авторство) виконано; далі A2».
- [x] **Step 7:** Run `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [x] **Step 8: Commit**

```bash
git add docs packages/designer/skills
git commit -m "docs(spec): П4-A1 — авторство як механіка, режим обслуговування, префікс BEFORE-тригерів"
```

---

## Критерії приймання

- Тест членства ролей (pgTAP і designer DB) і кейси грантів та авторства зелені; гейт бачить колонковий ACL (Задача 5, Step 4).
- `simetra_runtime` без `SET LOCAL ROLE` — `permission denied`; режим обслуговування для її сесії не вмикається.
- Порядок `author → carriers → touch` тримається на 60-байтній назві (unit і DB).
- Кожна мутація з задач 1–5 червоніє; перелік «прибрано → почервоніло» — у звіті.
- Повні гейти на одному SHA (лише з «можна»): `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db` (приріст > 15 с — пояснення).
- На `examples/` і фікстурах нових помилок немає; нові попередження — у звіті переліком.
