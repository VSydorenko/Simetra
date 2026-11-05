# П4-A6: створення тенанта — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Виконання — за `/виконай-задачу` цього репо.

Статус: план (фаза 1). Виконання — після «далі» архітекторки прав
(`consumer-reconciliation2`). База плану — `main` bdd881a6 (гілка `feat/p4-a6` без upstream до
`push -u`).

**Goal:** згенерована команда `create` кореня скоупу створює тенант в одній
транзакції: корінь, рядок членства творця й призначення ролі `rootCreator`;
творець має права `rootCreator` рівно в новому скоупі вже в цій транзакції, а
⊆ на `COMMIT` ловить усе інше. Вид скоупу без `rootCreator` (модель
оператора) створює корінь без творця.

**Architecture:** право `create` кореня дають лише явні гранти рівнів `global`
і `everyUser` (Р-A6-1, Р-A6-2); політика `INSERT` кореня й перевірка ядра —
булева форма над `has_right`. T3 генерує id кореня й рядка членства, перевіряє
`creatorMember` тим самим обходом T0, що й `values`, запускає хуки кореня й
довідника членства й кличе окреме ядро `<корінь>_create_root`. Ядро вставляє
корінь без `RETURNING`, перевіряє `creatorMember` згенерованою функцією
перевірки рядка членства (той самий механізм кличе інструмент обслуговування) і
кличе definer-функцію гранту `simetra.<вид скоупу>_root_creator`. Функція
споживає маркер кореня, вставляє членство (тригер знімка бере знімок),
перевіряє знімок і кеш початку, дописує входи знімка з походженням
`root-creator` і вставляє призначення; журнал пише причину `root-creator`.

**Tech Stack:** TypeScript (T0 `packages/simetra/src/model`, T1
`packages/simetra/src/compiler`, T2 `packages/simetra/src/schema`, T3
`packages/simetra/src/server`), PostgreSQL 17, Vitest (unit, DB
`*.db.test.ts`, проєкт `bench`), DB-тести `@simetrajs/designer`.

**Spec:** [спека П4](../specs/2026-10-26-p4-runtime-design.md) §6.3, §6.4, §6.5,
§6.6, §6.7, §6.8, §6.9, §6.12, §6.13, §6.15, §6.16, §7.2, §8 (рядок A6),
Додаток А (рядки блоку A6); [спека прав](../specs/2026-10-17-rights-design.md)
Рх5, Рх7, Рх9, Рх19, §3, §4.1, §4.6, §4.7, §5.1, §5.2, §7. Правки обох спек під
рішення цього плану внесено в коміті плану.

## Global Constraints

- Комітиш лише у `feat/p4-a6` (основний checkout `/home/vsydorenko/Simetra`);
  Conventional Commits з українським описом; без трейлерів; історію не
  переписуєш; злиття `main` — `git merge`. Паралельні сесії (A5, візуальна
  мова, П4-B, спайк П0 (г)) у цей checkout не комітять.
- Версії пакетів і `PLATFORM_VERSION` не змінюються. `AGENTS.md`, `CLAUDE.md`
  не правиш (потрібну правку — у звіт). Репо публічне: фікстури синтетичні.
- Під час роботи — лише scoped: `pnpm --filter <pkg> test <pattern>` і
  `pnpm --filter <pkg> test:db <pattern>`, **без** `--` перед шаблоном;
  `pnpm --filter <pkg> lint` і `typecheck` на коміт задачі.
- **Гейти — одне вікно на блок** (Задача 11): повні гейти разом із повним
  `pnpm test:db` (зовнішній таймаут ≥ 45 хв) — рівно один раз, після всіх
  задач і мутацій, на одному SHA, за «можна» архітекторки:
  `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
  `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`,
  `pnpm --filter simetra bench:rights`, `pnpm build:packages && pnpm test:packaging`.
  Після виправлень рецензії — лише швидкі гейти й scoped DB зачеплених файлів.
- Scoped DB зачеплених областей A6:
  `pnpm --filter simetra test:db tenant-creation catalog-command rights-guards rights-write membership access`,
  `pnpm --filter @simetrajs/designer test:db command-runtime tenant-creation rights-maintenance rights-admin-commands`.
- Стек — лише `pnpm db:*`, не зупиняти й не перезапускати; бази
  `metahub_copy*` не чіпати; зміна `supabase/roles.sql` — до архітекторки.
- DB-мутації — лише на закоміченому дереві; журнал — у кінці плану.
- Розвилки й відхилення — архітекторці, з полем «вплив на спеку»; погоджене
  відхилення приходить разом із правкою спеки в цьому блоці.
- Коментарі коду — українською, «чому». Імена тестів — англійською.
- Принцип 5 `AGENTS.md` — у цьому блоці без обгорток видаляються: колонкові
  політики `INSERT` кореня й родина «решта рядків» `INSERT` кореня;
  `encodeMemberValues` і внутрішній обхід `writeAttributes` (замінює спільний
  обхід T0) разом зі старим тестом паритету.
- Скіл `.agents/skills/writing-tests/SKILL.md` — перед кожною задачею з
  тестами; фікстури — зі спільних будівників
  (`packages/simetra/src/compiler/__tests__/fixtures/rights.ts`,
  `packages/simetra/test/db/rights-seed.ts`,
  `packages/designer/src/__tests__/support/`).
- Безпекових перевірок не спрощуєш: кожна відмова функції гранту має тест, у
  якому саме вона — перша відмова на шляху (усі вони дають `rights-context`,
  тож пізніша перевірка інакше ховає ранішу; кожен рядок таблиці кейсів
  називає свою підготовку). Мутація кожної — червоний тест (Задача 10), крім мутацій, задокументованих у
  плані як еквівалентні з поясненням (М13, М17а); нову еквівалентну мутацію
  виконавець не оголошує сам — розвилка архітекторці.

## Рішення

Р-A6-1…Р-A6-23 і пороги бенчмарку архітекторка погодила 2026-11-05 (Р-A6-19 —
з реченням у П4 §6.15, внесено).

| № | Рішення | Обґрунтування | Вплив на спеку |
| --- | --- | --- | --- |
| Р-A6-1 | **`create` кореня скоупу — лише рівні `global` і `everyUser`, лише явним грантом.** Рівень скоупу й контейнера `create` кореня не має ні в грантах (`rights.grant-level`), ні в домені рівня (дельта `allow create` кореня кастомної ролі рівня скоупу — `delta-domain`; інакше носій `fullAccess` тенанта відкрив би собі створення тенантів через `has_right`). `grantAll`, `withAction` і розгортання `fullAccess` (Рх5) пари не дають. Домен рівня `global`/`everyUser` (`levelDomain(level, explicit = true)` → `domainRows`, `rightsDomainRows`) пару містить, розгортання `fullAccess` (`levelDomain(level, explicit = false)` у `expandedProjection`) — ні: дельта `allow` глобальної кастомної ролі може її дати, ⊆ стримує. Решта дій кореня — як було | `has_right` рахує всі рівні, крім контейнера: грант рівня скоупу інакше відкрив би створення тенантів; модель тенанта — явний вибір застосунку | Рх7, §4.1 (внесено) |
| Р-A6-2 | **Ребро `create ⇒ read` для кореня скоупу знімається** у `RightsAction.requires` контракту прав (`packages/simetra/src/compiler/rights/contracts.ts`) — тож і в `rights_requires`, і в `rights.requires-missing`; реєстр видів не змінюється (він не знає, який об'єкт — корінь). Інші дії й об'єкти без змін | після Р-A6-1 пару мають лише `global`/`everyUser` | Рх9, §3 (внесено) |
| Р-A6-3 | **Знімок до запису в довідники прав** бере тригер знімка таблиці членства на вставці членства; функція одразу після неї перевіряє заголовки фактів `rights` і `scopes` цього xid з актором `current_user_id()`, інакше `rights-context`. Знімок, узятий раніше в транзакції, — проходить | спільного «взяти знімок» немає; членство — джерело обох фактів | П4 §6.13 крок 5, спека прав §7 (внесено) |
| Р-A6-4 | **Перед дописуванням входів** функція перевіряє, що `rights_tx_start` цього xid порожній, інакше `rights-context` | кеш, заповнений раніше, не мав би прав творця — явна відмова замість `escalation` | спека прав §7 (внесено) |
| Р-A6-5 | **Походження й причина журналу.** `simetra.rights_tx_typed` отримує дві колонки лише в DDL (не в `INPUT_COLUMNS`; знімок пише `NULL`): `provenance text NULL` і `assignment uuid NULL` — id рядка призначення (`storage_id` призначення рівня скоупу — id виду скоупу, `storageSql`, рядка не називає). `transitionSql` довідника призначень, лише в тригері `INSERT`: `CASE WHEN v_maintenance THEN 'maintenance' WHEN EXISTS (SELECT 1 FROM simetra.rights_tx_typed t WHERE t.xid = txid_current() AND t.provenance = 'root-creator' AND t.assignment = r.row_id) AND NOT EXISTS (SELECT 1 FROM simetra.rights_journal j WHERE j.xid = txid_current() AND j.relation = <таблиця> AND j.row_id = r.row_id) THEN 'root-creator' ELSE 'command' END` (лише перший образ рядка); частковий індекс `rights_tx_typed (xid, assignment) WHERE provenance IS NOT NULL` — інакше `EXISTS` на кожен рядок журналу читав би всі рядки `typed` актора; `UPDATE` і `DELETE` того самого рядка — звичайна причина (`command`): це вже дія творця командою. `stateRows`: `j.reason IN ('command', 'root-creator')` — за спекою (перший образ вставки творця — `NULL`, рядок не стає «наявним на початку»); відмінності результату ⊆ ця умова не дає, бо права рядка вже в кеші початку (мутація М13 — еквівалентна, журнал мутацій). Проєкція `INPUT_COLUMNS.typed` рядка функції дорівнює живому рядку входу `typed` того призначення | причина — з рядка знімка, по рядку призначення | спека прав §4.6, §7; П4 §6.13 кроки 6–7 (внесено) |
| Р-A6-6 | **Id рядка членства генерує T3**: `simetra.<вид скоупу>_root_creator(p_root uuid, p_member_id uuid, p_member jsonb) RETURNS void`. Скоуп, користувача й механіку примушує функція; id призначення — `gen_random_uuid()` у функції | хуки довідника членства потребують `ctx.id` | П4 §6.13 (внесено) |
| Р-A6-7 | **Маркер кореня** — `simetra.rights_tx_root_marker (xid bigint, scope_kind_id uuid, root uuid, actor uuid NOT NULL, PRIMARY KEY (xid, scope_kind_id, root))` (актор — Р-A6-23) у `rightsAdminTables`, без грантів і RLS. Рядок ставить тригер ефектів основної таблиці кореня на `INSERT` кореневого рядка під `create`, лише для виду з `rootCreator`. Відкладений constraint-тригер `AFTER INSERT … DEFERRABLE INITIALLY DEFERRED FOR EACH ROW` перечитує рядок за ключем: лежить — `rights-context` | fail-closed | П4 §6.13; спека системної схеми §3 (Задача 9) |
| Р-A6-8 | **Окреме ядро** `<корінь>_create_root(p_item jsonb, p_member jsonb, p_member_id uuid) RETURNS text` (`SECURITY INVOKER`, `search_path = ''`) на кожному корені виду скоупу з об'єктом-коренем. `save` кореня лишається без гілки створення (наявна відмова `create`, без змін). На виді з `rootCreator` `p_member` `NULL` — `command.invalid` `creatorMember`, грант — завжди; на виді без — `p_member` не `NULL` — та сама відмова, гранту немає | одна функція — одна дія | П4 §6.6, §6.13 (внесено) |
| Р-A6-9 | **Каталог рантайму:** `operations.create.root?: { membership?: <id об'єкта каталогу> }`. `root` — T3 генерує id і відхиляє `id`/`tabularSections`; `membership` — `creatorMember` дозволений (типово `{}`), інакше `creatorMember` — `command.invalid`. Схема каталогу перевіряє, що `membership` — id об'єкта цього каталогу. `format` лишається `1` | T3 не має інших джерел факту «корінь» і «довідник членства» | П4 §6.3 (внесено) |
| Р-A6-10 | **Результат ядра кореня** — JSON `{"root": <рядок>, "member": <рядок> \| null}`; рядок — повний, коли видимий після гранту, інакше `{<ключ>: id, <версія>: 1}` (вставка дає версію 1 — тригер механіки). `CommandResult.rows` — рядок кореня; рядок членства отримує лише `onWrite` довідника членства; набір змін — один запис фази кореня (`scope` = id) | `RETURNING` під політикою `SELECT` упав би | П4 §6.13 (внесено) |
| Р-A6-11 | **Політики `INSERT` кореня** — лише родина кореневого рядка в булевій формі: `id = command_root(<мітка>) AND (has_right('create', <мітка>, 'any', NULL) OR (has_right('create', <мітка>, 'own', NULL) AND created_by_id = current_user_id()))` (дія — літерал `'create'`, не `command_action()`) (лише обсяги, які дає хоч один грант). Родини «решта рядків» для `INSERT` кореня й колонкових політик `INSERT` кореня немає; `UPDATE`/`DELETE` кореня без змін. `<t>_scope_insert` на корені нема. Перевірка права ядра кореня рендерить ту саму форму тим самим будівником над `v_new` з примушеним автором | колонкова форма для нового id не проходить ніколи | спека прав §5.2 (внесено) |
| Р-A6-12 | **Перевірка рядка членства — одна згенерована функція** `<членство>_simetra_member_check(p_member jsonb, p_scope uuid) RETURNS text` на **кожному** довіднику з `membership` (`SECURITY INVOKER`, `search_path = ''`, `EXECUTE` лише `simetra_command`; ім'я — `generatedTableFunctionName`). Тіло — ті самі будівники, що й гілка створення `<членство>_save`: дозволені ключі (колонки вставки мінус примушені ключ, скоуп, користувач; без `tabular`), приведення типів, `referenceViolations` над `jsonb_populate_record(NULL::<таблиця членства>, p_member)` зі скоупом `p_scope`; повертає колонку першого порушення чи `NULL`. Ядро кореня кличе її під RLS команди — видимість цілі. Інструмент обслуговування (`tenantFullAccess`) — від власника з `row_security = off`: «ціль існує й у тому самому скоупі», не видимість | борг прав §1: один механізм | П4 §6.12, §6.13 (внесено) |
| Р-A6-13 | **Один обхід реквізитів у T0:** `encodeAttributes(attributes: readonly RuntimeAttribute[], values: unknown, options: { allowed: (a: RuntimeAttribute) => boolean; forced?: readonly string[]; path: string; prefix: string; rowKey?: string }): { columns: Record<string, unknown> } \| { error: CommandError }` у `packages/simetra/src/model/runtime/values.ts`. T3 (шапка, рядки ТЧ, `creatorMember` з префіксом `creatorMember.`) і інструмент обслуговування кличуть його; `encodeMemberValues` і обхід у `writeAttributes` видаляються | беклог §6 | немає |
| Р-A6-14 | **Хуки створення тенанта**: `beforeWrite` кореня → `beforeWrite` довідника членства (чернетка `{ values: creatorMember }`, `ctx.object` — членство, `ctx.id` — id рядка членства, `ctx.isNew`, `ctx.action: "create"`) → повторна перевірка обох чернеток (корінь: без `id` і `tabularSections`; членство: без `tabularSections`, обхід Р-A6-13 з примушеними ключами) → контекст `{create, <мітка кореня>, <id>}` + виклик ядра однією одиницею черги → `onWrite` кореня → `onWrite` членства | контекст після хуків «до» (Рт5) | П4 §6.13 (внесено) |
| Р-A6-15 | **Контекст вставок функції гранту:** зберегти поточне значення `simetra.command`; перед вставкою членства — `{create, <мітка членства>, p_member_id}`, перед вставкою призначення — `{administerRights, <мітка призначень>, <id призначення>}`; після — повернути збережене окремим `set_config` | тригер ефектів судить кореневий рядок дією контексту | немає |
| Р-A6-16 | **Компілятор:** `rights.root-creator-membership` — `rootCreator` на виді без довідника з `membership`; `rights.root-creator-assignments` — `rootCreator` на виді без системного довідника «Призначення ролей» свого рівня (призначення з прийнятого джерела функція гранту не пише, а таблиць знімка й маркера без довідника прав немає); `rights.root-creator-subscription` — SQL-підписка `beforeWrite`/`onWrite` на `INSERT` довідника членства чи «Призначень ролей» виду з `rootCreator` (підказка — хук команди); `rights.root-create-author` — грант `create@own` на корені (`everyUser` чи `global`) без власності `createdBy` (нема `trackAuthor` чи `ownership` без `createdBy`); `rights.root-creator-no-admin` (попередження) — роль `rootCreator` без `fullAccess` і без `administerRights` на довідниках прав свого рівня; «архетип не рівня цього виду» — наявна `rights.root-creator-level` | п'ять правил §6.13 | спека прав §4.1, §4.6 (внесено) |
| Р-A6-17 | **Бенчмарк** — сценарій 8 у `packages/simetra/bench/rights.bench.db.ts`; пороги — після погодження архітекторкою (Задача 8) | форма сценаріїв Права-3 | немає |
| Р-A6-22 | **Носій глобального `fullAccess` може дати `create` кореня призначенням.** «Лише явний грант» (Р-A6-1) — правило розгортання метаданих: `fullAccess` сам пари не дає. Але ⊆ на рівні `global` покриває носія `fullAccess` (`s.full_access`), тож він може призначити собі чи іншому оголошену глобальну роль з `create` кореня або глобальну кастомну роль з дельтою `allow create` — це адміністрування рівня, не обхід: носій `fullAccess` і так призначає будь-які глобальні ролі. Носій без `fullAccess` дати пару не може без неї самої (⊆) | одна модель адміністрування; виняток з покриття `fullAccess` ускладнив би ⊆ без захисту від власника рівня | спека прав Рх7 (речення) |
| Р-A6-23 | **Маркер несе актора:** `rights_tx_root_marker` отримує `actor uuid NOT NULL` = `current_user_id()` на вставці кореня; крок (2) функції гранту споживає маркер лише з `actor = current_user_id()`, інакше `rights-context` | захист у глибину: право `create` перевірено для актора вставки, грант — для того самого актора (у шляху команд claims між ними не змінюються, але сирий SQL під `simetra_command` міг би) | П4 §6.13 крок 2 (речення) |
| Р-A6-18 | **Перетин з A5.** `feat/p4-a5` комітів не має: A6 мерджиться першим, MCP-кейс `create` кореня з `creatorMember` — за A5 (його задача 7a). Якщо на час зведення `feat/p4-a5` уже в `main`, A6 робить повний кейс §6.14: обидва прапорці й правило «об'єкт із модулем» і для довідника членства (Задача 9 крок 0) | П4 §6.14 | немає |
| Р-A6-19 | **Модель тенанта задає вид скоупу, не рівень ролі творця.** Корінь виду з `rootCreator` завжди отримує творця — хоч творець діє за `everyUser`, хоч за `global`; модель оператора — вид без `rootCreator`. `rootCreator` вимагає `setFunction: "membership"` виду (`rights.root-creator-set-function`): межа тенанта виду з дослівною функцією множини читає знімок `scopeSets` (`rights_scope_set`), а функція гранту не може дописати вихід дослівної функції — це логіка застосунку | інакше глобальний оператор тихо збирав би `fullAccess` у тенантах або новий тенант був би невидимим творцю | П4 §6.13; спека прав §4.1 (внесено) |
| Р-A6-20 | **Id кореня й рядка членства T3 генерує раз на `run`** (до циклу повторів); повтор `40001`/`40P01` бере ті самі id | відкат спроби прибирає рядки, тож id вільні; різні id у спробах змінили б `ctx.id` хуків між спробами | П4 §6.13 (внесено) |
| Р-A6-21 | **`rightsPredicates` отримує DML:** `rightsPredicates(contract, action, table, main, dml: "select" \| "insert" \| "update" \| "delete")`; булева форма Р-A6-11 — лише для `insert` на основній таблиці кореня. Усі виклики передають DML (зокрема `packages/simetra/test/db/rights-functions.db.test.ts`): політики читання й `explain-units.ts` — `select`, `writePolicies` — DML політики, перевірка ядра — DML функції. `RightsContract` отримує `root?: true` (з `scopeKinds[].root.objectId` у `rights/contracts.ts`) — факт для `allowedActions` і `rightsPredicates` | без DML булева гілка замінила б і політики `UPDATE`/`DELETE` кореня | немає |

## Review Focus

1. **Кеш початку раніше за дописування** — `rights-context` з перевірки (6),
   не з маркера. Тест — Задача 5 (кейс із контролем).
2. **Один актор створює два тенанти й пише поза ними** — права рівно в X і Y;
   власне призначення в наявному тенанті понад права — `escalation`.
   Тест — Задачі 5 і 7.
3. **Хук `beforeWrite` кореня повертає `tabularSections`** — `command.invalid`.
   Тест — Задача 6.
4. **Глобальний `fullAccess` без явного гранту** не створює корінь
   (`no-right`). Тест — Задачі 1 і 5.
5. **`creatorMember` з поліморфним чи масивним `Ref` на невидимий рядок** —
   `command.invalid` `creatorMember.<реквізит>`, як для відсутнього. Тест —
   Задачі 5 і 7.

## Файли

| Файл | Що змінюється |
| --- | --- |
| `packages/simetra/src/compiler/contracts.ts`, `rights/contracts.ts` | `RightsContract.root`; вимоги `create` кореня (Р-A6-2, Р-A6-21) |
| `packages/simetra/src/compiler/rights/expand.ts`, `rights/functions.ts` (`levelDomain`, `expandedProjection`) | Р-A6-1 |
| `packages/simetra/src/compiler/rights/role-checks.ts`, `stages/links.ts`, `diagnostics.ts`, `messages.ts` | Р-A6-16, Р-A6-19 |
| `packages/simetra/src/compiler/rights/predicates.ts`, `access-units.ts`, `catalog-command/rights-check.ts`, `rights/explain-units.ts` | Р-A6-11, Р-A6-21 |
| `packages/simetra/src/compiler/rights/admin-tables.ts`, `effects-units.ts`, `guard-units.ts` | Р-A6-5, Р-A6-7 |
| `packages/simetra/src/compiler/rights/root-creator-units.ts` (новий) | функція гранту |
| `packages/simetra/src/compiler/catalog-command/member-check.ts` (новий), `units.ts`, `contracts.ts`, `pipeline.ts` | Р-A6-8, Р-A6-12 |
| `packages/simetra/src/compiler/runtime-catalog.ts`, `packages/simetra/src/model/runtime/{catalog,operation,values}.ts` | Р-A6-9, Р-A6-13, §6.4 |
| `packages/simetra/src/server/{phase,values,errors,transaction}.ts` | Р-A6-10, Р-A6-13, Р-A6-14, Р-A6-20 |
| `packages/simetra/src/schema/apply/rights-maintenance.ts` | Р-A6-12, Р-A6-13 |
| `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` | будівники Задачі 1 |
| `packages/simetra/test/db/tenant-creation.db.test.ts` (новий) | DB ядра й функції гранту |
| `packages/designer/src/__tests__/tenant-creation.db.test.ts` (новий), `rights-maintenance.db.test.ts` | DB `runtime.run`, інструмент |
| `packages/simetra/bench/rights.bench.db.ts` | сценарій 8 |
| `packages/designer/skills/simetra-metadata/references/people-and-rights.md`, `SKILL.md` | скіл споживача |
| `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` (Додаток А), `2026-10-07-system-schema-users-design.md` (§3), `docs/ROADMAP.md`, борг і беклог | Задача 9 |

## Задача 0: старт фази 2

- [ ] **Крок 1.** `git fetch origin && git status` — гілка `feat/p4-a6`, дерево
  чисте. `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-11-05-p4-a6-tenant-creation.md`;
  розбіжності якорів — архітекторці до старту.
- [x] **Крок 2.** Правки спеки прав (Рх7, Рх9, Рх19, §3, §4.1, §4.6, §5.2,
  §7) і спеки П4 (§6.3, §6.6, §6.12, §6.13) за рішеннями плану — внесено в
  коміті плану. Відхилення під час виконання — разом із правкою спеки.

## Задача 1: право `create` кореня, вимоги, діагностики (Р-A6-1, Р-A6-2, Р-A6-16, Р-A6-19, Р-A6-21)

**Files:** `packages/simetra/src/compiler/contracts.ts`,
`packages/simetra/src/compiler/rights/{contracts,expand,functions,role-checks}.ts`,
`packages/simetra/src/compiler/stages/links.ts`, `diagnostics.ts`,
`messages.ts`; тести `rights-expand.test.ts`, `rights-roles.test.ts`,
`rights-contract.test.ts`, `event-subscriptions.test.ts`, `messages.test.ts`;
фікстури `fixtures/rights.ts`.

**Interfaces:**
- Produces:
  - `RightsContract.root?: true`;
  - `allowedActions(level, contract, explicit: boolean)`: для кореня скоупу на
    рівні скоупу чи контейнера `create` немає за будь-якого `explicit`; на
    `global`/`everyUser` — `{create}` лише з `explicit = true`;
  - `levelDomain(level, contracts, explicit: boolean)`: `domainRows` і
    `rightsDomainRows` кличуть з `true`, `expandedProjection` — з `false`;
    явні гранти — `allowedActions(…, true)`, селектори `grantAll`/`withAction` —
    `false`;
  - будівник `tenantSelfService(options?: { fullAccess?: boolean; requiredMember?: boolean; founder?: boolean }): Layer` —
    вид `org` (наявний `ORG_SCOPE_KIND`, `setFunction: "membership"`):
    `Organization` з `trackAuthor` і `ownership: ["createdBy"]`; роль
    `everyUser` `TenantFounder` з грантом `create@own` на `Organization` (опція
    `founder`, типово `true`) і `read@own` на `Users` (власний профіль — видима
    ціль `Ref` для кейсів перевірки посилань); роль
    рівня `org` `TenantOwner` з `rootCreator: true`, `fullAccess` за опцією
    (типово `true`), а з `fullAccess: false` — гранти `read`/`update` на
    `Organization`, `read`/`create`/`update` на `OrgMember`, `administerRights`
    на «Призначеннях ролей» рівня `org`; роль рівня `org` `TenantAuditor` з
    правом, якого `TenantOwner` (без `fullAccess`) не має (`markDeletion` на
    `Organization`); `OrgMember` отримує поліморфний `Ref` і масив `Ref` на
    нескоуплені цілі (`Users`, нескоуплений довідник фікстур);
  - будівник `tenantOperator(): Layer` — другий вид скоупу `branch` (за
    зразком `secondScopeKind()`, разом з `ORG_SCOPE_KIND`; свій корінь `Branch`,
    довідник членства `BranchMember`, роль рівня `branch` з `fullAccess` без
    `rootCreator`), ролі `global`: `TenantOperator` (`create@any` на `Branch`),
    `GlobalFounder` (`create@any` на `Organization`), `GlobalFull`
    (`fullAccess`, без явних грантів на корені) і `GlobalAdmin`
    (`administerRights` на глобальних «Призначеннях ролей»);
  - у `tenantSelfService` ще: роль рівня `org` `TenantAdmin` лише з
    `administerRights` (і його вимогою `read`) на «Призначеннях ролей» рівня
    `org`; роль рівня `org` `TenantReader` лише з `read` на `Organization`
    (⊆ `TenantOwner` в обох варіантах); опція `requiredMember?: boolean` —
    обов'язковий реквізит `title` на `OrgMember` поруч із `Ref`-реквізитами
    (замість композиції з `requiredMemberAttribute()`, яка перезаписала б
    реквізити `OrgMember`);
  - коди: `rights.root-creator-membership`, `rights.root-creator-subscription`,
    `rights.root-create-author`, `rights.root-creator-set-function`,
    `rights.root-creator-assignments`,
    `rights.root-creator-no-admin` (warning).

- [x] **Крок 1 (unit, червоні).** У `rights-expand.test.ts` — `describe.each`
  «root create by level»: явний `create` на `Organization` — `global` і
  `everyUser@own` проходять; рівень `org` і контейнер — `rights.grant-level`;
  `everyUser@any` — `rights.grant-level`; `create@<вимір>` кореня на будь-якому
  рівні — `rights.grant-level` (носія виміру нового кореня обирав би творець);
  `update`/`read` кореня на `global` — `rights.grant-level`. «root create is explicit only»: роль `global` з
  `fullAccess`, з `grantAll`, з `withAction: "create"` — у розгорнутій
  проєкції нема `(Organization, create)`; `domainRows` і `rightsDomainRows`
  рівня `global` пару містять, рівня `org` і контейнерного — ні (так само для
  `fullAccess` ролі рівня `org`). «root create requires nothing»:
  `RightsAction.requires` `create` кореня порожній, `create` іншого довідника
  — `["read"]`; роль `global` лише з `create` кореня — без
  `rights.requires-missing`.
- [x] **Крок 2.** Реалізація (факт кореня — `RightsContract.root`, не назва
  виду).
- [x] **Крок 3 (unit, червоні).** `it.each` у `rights-roles.test.ts`: вид з
  `rootCreator` без довідника з `membership` (лише прийняте джерело) —
  `rights.root-creator-membership`; вид з `rootCreator` і дослівною функцією
  множини — `rights.root-creator-set-function`; вид з `rootCreator`,
  чиї призначення — з прийнятого джерела (без довідника «Призначення ролей»
  рівня) — `rights.root-creator-assignments`; `TenantFounder` без
  `trackAuthor` і з `trackAuthor`, але `ownership` без `createdBy`, і роль
  `global` з `create@own` кореня без `trackAuthor` — `rights.root-create-author`; `TenantOwner` з `fullAccess: false` без
  `administerRights` — попередження `rights.root-creator-no-admin`, з ним —
  без; роль `global` з `rootCreator` — `rights.root-creator-level` (наявна).
  У `event-subscriptions.test.ts`: підписка `beforeWrite`/`onWrite` на
  `INSERT` `OrgMember` і «Призначень ролей» рівня `org` у проєкті з
  `tenantSelfService()` — `rights.root-creator-subscription`; на `UPDATE` тих
  самих таблиць і на `INSERT` `BranchMember` (`tenantOperator()`) — без.
- [x] **Крок 4.** Реалізація діагностик, тексти en/uk. Фікстура `kitchen-sink`
  (`OrgOwner` з `rootCreator` і `sourceKeys` прийнятого джерела призначень,
  без довідника «Призначення ролей») тепер дає `rights.root-creator-assignments`:
  `rootCreator` з `OrgOwner` прибрати; твердження, що спирались на нього
  (`grep -rn rootCreator packages/simetra/src/compiler/__tests__`), перенести
  на `tenantSelfService()`. Тест `rights-roles.test.ts` «compiles roles into
  role contracts» (`OrgMember: { rootCreator: true }` без `fullAccess` і
  `administerRights`) отримує очікування `rights.root-creator-no-admin` у
  точному переліку діагностик.
  Наявні фікстури з грантом рівня скоупу на `create` кореня — переписати під
  Р-A6-1, перевірку не послаблювати.
- [x] **Крок 5.** `pnpm --filter simetra test rights-expand rights-roles rights-contract event-subscriptions messages platform-layer reference-index-completeness rights-functions key-units`
  (тести, що читають діагностики `kitchen-sink`; виконавець доповнює перелік за
  `grep -l kitchen-sink packages/simetra/src/compiler/__tests__`);
  lint, typecheck; коміт `feat(compiler): право create кореня скоупу — лише явний грант global чи everyUser`.

## Задача 2: політика `INSERT` кореня й перевірка ядра (Р-A6-11, Р-A6-21)

**Files:** `packages/simetra/src/compiler/rights/predicates.ts`,
`access-units.ts`, `catalog-command/rights-check.ts`; тести
`rights-predicates.test.ts`, `access-units.test.ts`,
`catalog-command-rights-check.test.ts`.

**Interfaces:**
- Consumes: `RightsContract.root` (Задача 1).
- Produces: `rightsPredicates(contract, action, table, main, dml)`; для
  `dml = "insert"` на основній таблиці кореня — `any` →
  `{kind: "boolean"}` над `has_right`; `own` →
  `[ownerCondition(createdBy → currentUser), {kind: "boolean"}]` (інші власники
  кореня в `own` створення не входять); дія в `has_right` — літерал `'create'`,
  не `command_action()` (`has_right` рахує й рядки рівня скоупу будь-якого
  тенанта: з `command_action()` вставка кореня під контекстом `update` пройшла б
  RLS для власника `update` кореня в іншому тенанті).

- [x] **Крок 1 (unit, червоні).** `rights-predicates.test.ts` «root insert is
  boolean» — дерево умов для `tenantSelfService()` (`own`) і
  `tenantOperator()` (`any` на `Branch`); `update`/`delete` кореня — колонкова
  форма без змін. `access-units.test.ts` (цілі оператори): на `Organization`
  політики `INSERT` — лише родина кореневого рядка з булевою умовою; нема
  `insert_rest_*`, колонкових `insert_root_*`, `<t>_scope_insert`; політики
  `UPDATE`/`DELETE` кореня й `INSERT` некореневих таблиць — як були.
  `catalog-command-rights-check.test.ts`: перевірка ядра кореня = та сама
  булева форма над `v_new`.
- [x] **Крок 2.** Реалізація; `writePolicies` передає DML і не будує родину
  «решта рядків» для `INSERT` кореня.
- [x] **Крок 3.** `pnpm --filter simetra test rights-predicates access-units catalog-command-rights-check`;
  коміт `feat(compiler): булева політика INSERT кореня скоупу`.

## Задача 3: маркер, походження, причина журналу (Р-A6-5, Р-A6-7)

**Files:** `packages/simetra/src/compiler/rights/admin-tables.ts`,
`effects-units.ts`, `guard-units.ts`, `guard-names.ts`; тести
`rights-admin-tables.test.ts`, `rights-guards.test.ts`,
`rights-snapshot-sources.test.ts`.

**Interfaces:**
- Produces: `ROOT_MARKER_TABLE = platform("rights_tx_root_marker")`, функція
  `simetra.rights_tx_root_marker_check()` і constraint-тригер
  `rights_tx_root_marker_check`; колонки `rights_tx_typed.provenance`,
  `rights_tx_typed.assignment`; стала `ROOT_CREATOR_REASON = "root-creator"`.

- [x] **Крок 1 (unit, червоні).** `rights-admin-tables.test.ts`:
  `rights_tx_typed` = `xid` + `INPUT_COLUMNS.typed` + `provenance` +
  `assignment`, частковий індекс `(xid, assignment) WHERE provenance IS NOT NULL`; «snapshot inputs do not see provenance» — тіло знімка,
  `snapshotInputs(…)` і живий CTE `typed` без обох колонок; таблиця маркера з
  PK `(xid, scope_kind_id, root)`, без RLS і грантів.
  `rights-guards.test.ts` (цілі оператори): причина `transitionSql` довідника
  призначень — вираз Р-A6-5 лише в тригері `INSERT`; у тригерах `UPDATE`/`DELETE`
  і на «Ролях» та дельтах — без гілки `root-creator`;
  `stateRows` — `j.reason IN ('command', 'root-creator')`; тригер ефектів
  кореня виду з `rootCreator` вставляє маркер у гілці `INSERT` кореневого
  рядка під `create`, виду без `rootCreator` — ні; constraint-тригер
  маркера — `DEFERRABLE INITIALLY DEFERRED`, тіло — перечитування за ключем і
  `rights-context`. `rights-snapshot-sources.test.ts`: маркер — не джерело
  знімка (`rights.snapshot-source-unknown` не виникає).
- [x] **Крок 2.** Реалізація; маркер — у `rightsAdminTables` з `origin`
  власника, як інші таблиці схеми `simetra`.
- [x] **Крок 3.** `pnpm --filter simetra test rights-admin-tables rights-guards rights-snapshot-sources`;
  коміт `feat(compiler): маркер кореня й причина журналу root-creator`.

## Задача 4: перевірка членства, функція гранту, ядро кореня (Р-A6-6, Р-A6-8, Р-A6-12, Р-A6-15)

**Files:** `packages/simetra/src/compiler/catalog-command/member-check.ts`
(новий), `units.ts`, `contracts.ts`;
`packages/simetra/src/compiler/rights/root-creator-units.ts` (новий);
`packages/simetra/src/compiler/pipeline.ts`; тести
`catalog-command-save.test.ts`, нові `catalog-command-root.test.ts`,
`rights-root-creator.test.ts`.

**Interfaces:**
- Consumes: `referenceViolations`, будівники перевірки ключів і типів
  (`inputLines`) з `catalog-command/units.ts`; `rightsCheck`; `ROOT_MARKER_TABLE`;
  `SNAPSHOT_TABLES`; `refusal`.
- Produces:
  - рефакторинг: `inputLines` параметризується назвою параметра (`p_item` /
    `p_member`), переліком дозволених ключів і ознакою `tabular`;
    `inputLines` і `referenceViolations` експортуються з `units.ts`;
  - `memberCheckUnit(membership: CatalogCommandContract, …): SqlUnit`;
  - `rootCreatorUnit(…): SqlUnit` — `simetra.<вид скоупу>_root_creator(p_root uuid, p_member_id uuid, p_member jsonb) RETURNS void`
    (`plpgsql VOLATILE SECURITY DEFINER SET search_path = ''`, `EXECUTE` лише
    `simetra_command`) для виду з `rootCreator`;
  - `CatalogCommandContract.functions.createRoot` і функція
    `<корінь>_create_root(p_item jsonb, p_member jsonb, p_member_id uuid) RETURNS text`;
  - деталі `invalid` для `p_member`: `creatorMember` (форма, `NULL`) і
    `creatorMember.<колонка>`.

- [x] **Крок 1 (unit, червоні).** `catalog-command-root.test.ts` — цілі
  оператори: тіло `<корінь>_create_root` у порядку: перевірка `p_item` (ключі
  вставки кореня, `tabular` — `command.invalid` `tabular`) → `p_member`: вид з
  `rootCreator` — `NULL` → `command.invalid` `creatorMember`, інакше виклик
  `<членство>_simetra_member_check(p_member, v_in.id)`, непорожній результат →
  `command.invalid` `creatorMember.<колонка>`; вид без `rootCreator` —
  `p_member IS NOT NULL` → `command.invalid` `creatorMember` → контекст
  (`create`, `command_root` = `v_in.id`) → стан «після» з примушеним автором →
  перевірка права Р-A6-11 (`no-right`) → `INSERT` без `RETURNING` (блок
  `unique_violation` як у `save`) → на виді з `rootCreator` `PERFORM` функції
  гранту `(v_in.<ключ>, p_member_id, p_member)` → читання кореня й рядка
  членства під командою → JSON Р-A6-10. Сигнатура —
  `<корінь>_create_root(p_item jsonb, p_member jsonb, p_member_id uuid)`:
  `p_member_id` — id рядка членства від T3 (Р-A6-6); на виді з `rootCreator`
  `NULL` — `command.invalid` `creatorMember`, на виді без — не `NULL` — та
  сама відмова.
- [x] **Крок 2 (unit, червоні).** `catalog-command-save.test.ts`: тіло
  `<членство>_simetra_member_check` збудоване тими самими будівниками, що й
  гілка створення `<членство>_save` (фрагменти умов `referenceViolations`
  однакові для тих самих колонок); функція є на кожному довіднику з
  `membership` (`OrgMember`, `BranchMember`).
- [x] **Крок 3 (unit, червоні).** `rights-root-creator.test.ts` — оператори
  функції гранту в порядку: (1) `command_action() = 'create'` і
  `command_root(<мітка кореня>) = p_root`, інакше `rights-context`; (2)
  `DELETE` маркера `(txid_current(), <вид>, p_root)` з
  `actor = simetra.current_user_id()`, нуль рядків — `rights-context`; (3) нема рядків членства й призначень зі скоупом `p_root`,
  інакше `rights-context`; (4) збереження контексту, `set_config`
  `{create, <мітка членства>, p_member_id}`; `INSERT` членства лише колонок
  вставки зі списку компіляції з `jsonb_populate_record(NULL::<таблиця>, p_member)`,
  ключ = `p_member_id`, скоуп = `p_root`, користувач =
  `simetra.current_user_id()`; (5) заголовки `rights` і `scopes` цього xid з
  актором — інакше `rights-context`; (6) `rights_tx_start` цього xid порожній —
  інакше `rights-context`; (7) `v_assignment := gen_random_uuid()`; `INSERT` у
  `rights_tx_typed` (колонки `INPUT_COLUMNS.typed` як у живого входу `typed`:
  `storage = 'scope'`, `storage_id` = id виду, `scope = p_root`, архетип,
  рівень; `provenance = 'root-creator'`, `assignment = v_assignment`),
  `rights_tx_holders` (лише коли архетип має `fullAccess`), `rights_tx_scopes`
  (`catalog = true`, `member = p_member_id`); (8) `set_config`
  `{administerRights, <мітка призначень>, v_assignment}`, `INSERT` призначення;
  (9) повернення збереженого контексту. «grant function has no EXECUTE except
  command», «no dynamic SQL».
- [x] **Крок 4.** Реалізація трьох генераторів; `contracts.ts` — `actionsOf`
  лишає корінь без `create` у `save`, `functions.createRoot` додає.
- [x] **Крок 5.** `pnpm --filter simetra test catalog-command rights-root-creator rights-guards`;
  коміт `feat(compiler): ядро create кореня й функція гранту root_creator`.

## Задача 5: DB-доказ ядра й функції гранту

**Files:** `packages/simetra/test/db/tenant-creation.db.test.ts` (новий). Два
розгортання: А — `policyDomain(tenantSelfService({ requiredMember: true }), tenantOperator())`
(самообслуговування й модель оператора на `Branch`); Б —
`policyDomain(tenantSelfService({ fullAccess: false, founder: false }), tenantOperator())`
(`Organization` створює лише `GlobalFounder`: `everyUser`-гранту на корінь
немає, тож відмови за правом не маскує рядок `everyUser`). Глобальні
призначення й призначення в наявних тенантах — засівом у режимі
обслуговування (`insert` з `rights-seed.ts`), як в інших DB-тестах. Кожен кейс нижче
називає своє (типово А). Справжніх `COMMIT` інфраструктура simetra DB не дає
(розгортання — у транзакції з відкатом): «`COMMIT`» тут — `SET CONSTRAINTS ALL IMMEDIATE`. Кейси —
`commandAs`/`commandSteps` (`packages/simetra/test/db/connection.ts`;
відкладені перевірки — `{ immediate: true }` чи явний `SET CONSTRAINTS ALL IMMEDIATE`
останнім кроком); користувачі — `signUp`.

Причина DB-рівня: RLS, тригери, відкладені обмеження й знімок виконує лише
Postgres.

- [x] **Крок 1.** Кейси (`it`; для відмов функції гранту — `it.each` з
  підготовкою в кожному рядку):
  - `creates a tenant: root, member and assignment in one transaction` —
    творець — дієвий носій `TenantOwner`; журнал призначення
    `reason = 'root-creator'`, актор — творець; після ядра
    `current_setting('simetra.command')` = контекст кореня;
  - `appended typed row equals the live typed row` — проєкція
    `INPUT_COLUMNS.typed` рядка з `provenance = 'root-creator'` = живий рядок
    входу `typed` призначення; `assignment` = id призначення; рядок
    `rights_tx_holders` (`level`, `level_id`, `scope`) = рядок живого
    `fullAccessHolderRows` актора в новому скоупі; рядок `rights_tx_scopes` =
    рядок живого `rights_my_scopes_live()` для нового скоупу з `catalog = true`;
  - `marker of another actor` — сирий `INSERT` кореня R під claims A, зміна
    claims на B, прямий виклик під B — `rights-context` з кроку (2) (до
    знімка: заголовків ще немає, тож відмова саме маркера);
  - `creator rights exist only in the new scope` (Б): актор — `GlobalFounder`
    і учасник наявного тенанта T з `TenantAdmin`; у тій самій транзакції створює X і
    призначає собі `TenantReader` у T — `escalation`; те саме в X — проходить;
  - `escalation through the creator's own assignment` (Б, творець —
    `GlobalFounder`): після створення X творець змінює роль свого призначення на `TenantAuditor` — `escalation`;
    журнал оновлення — `command`;
  - відмови функції гранту (`rights-context`), кожна — перша на шляху:
    - контекст: сирий `INSERT` кореня R під `create` (маркер R є), потім
      контекст `update` R / інша мітка / `create` з іншим `root`, виклик з
      `p_root` = R;
    - маркер: корінь R вставлено в тій самій транзакції від власника без
      контексту команди (тригер ефектів без контексту маркера не ставить;
      режим обслуговування не вмикати — інакше відмова прийшла б з (5)),
      потім контекст `create` R і прямий виклик;
    - другий виклик у тому самому скоупі (маркер спожито — відмова (2));
    - порожній скоуп: сирий `INSERT` кореня, вставка членства від власника
      (`asOwner`), контекст кореня, виклик;
    - заголовки знімка: сесія власника функцій прав (вхід тестів `postgres`)
      з `simetra.rights_maintenance = 'on'`; сирий `INSERT` кореня під
      контекстом `create` (тригер ефектів ставить маркер і в режимі
      обслуговування), потім прямий виклик (тригер знімка в режимі
      обслуговування знімка не бере — відмова (5));
    - кеш початку: запис у джерело (членство іншого тенанта),
      `SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;`, сирий
      `INSERT` кореня під `create`, прямий виклик — відмова (6); контроль —
      той самий сценарій без `SET CONSTRAINTS` проходить;
  - `marker without creator fails at COMMIT` — сирий `INSERT` кореня під
    `create` без функції гранту: `COMMIT` — `rights-context`;
  - `snapshot taken earlier passes` — запис у джерело до створення: права
    творця є;
  - `actor change fails` — зміна claims після створення до `COMMIT` —
    `rights-context`;
  - `forced member columns` — сирий `INSERT` кореня R під `create`, прямий
    виклик `simetra.org_root_creator(R, <id>, p_member)` з ключами чужого
    користувача й скоупу (ядро й функцію перевірки оминає): у вставленому
    рядку користувач = творець, скоуп = R;
  - `creatorMember reference checks` — поліморфний і масивний `Ref` на
    чужий рядок «Користувачів» (невидимий творцю) — `command.invalid`
    `creatorMember.<колонка>`, як і на відсутній id; на власний рядок творця
    (видимий за `read@own`) — проходить;
  - `core input refusals` — прямий виклик ядра: `tabular` у `p_item` —
    `command.invalid` `tabular`; `p_member` `NULL` на `Organization` —
    `creatorMember`; не `NULL` на `Branch` — `creatorMember`;
  - `missing required member attribute` — `creatorMember` без обов'язкового
    реквізиту (`requiredMember: true`, розгортання А): `23502` з таблицею членства;
    очікуваний код T3 — Задача 6;
  - `operator model` — `TenantOperator` на `Branch`: корінь створено, маркера
    нема, `COMMIT` проходить, результат `{"root": {id, version: 1}, "member": null}`;
  - `global creator on a rootCreator kind becomes the owner` (Б) —
    `GlobalFounder`, `p_member = '{}'`: творець — учасник і носій `TenantOwner`;
  - `global fullAccess without explicit grant cannot create a root` (Б) —
    `GlobalFull`: `no-right`; `GlobalFull` командою призначає собі
    `GlobalFounder` — ⊆ на «`COMMIT`» проходить (Р-A6-22); окремий крок того
    самого кейсу засіває це призначення в режимі обслуговування й показує,
    що `GlobalFull` тепер створює корінь; `GlobalAdmin` призначити собі
    `GlobalFounder` не може — `escalation`;
  - `scope delta cannot grant root create` (Б): актор — `OrgAdmin` базової
    фікстури (`fullAccess` рівня `org`); кастомна роль рівня `org` на
    архетипі `TenantOwner` з дельтою `allow create` `Organization` —
    `delta-domain` на «`COMMIT`»;
  - `insert policy` — прямий `INSERT` `Branch` під `simetra_command` з
    контекстом `create` без права — `42501` RLS; `TenantOperator` — проходить;
    (Б) прямий `INSERT` `Organization` під контекстом `update` з новим id
    актором з `update` кореня в іншому тенанті (`TenantOwner` без
    `fullAccess`) — `42501` RLS (не `effect`);
- [x] **Крок 2.** `pnpm --filter simetra test:db tenant-creation catalog-command rights-guards rights-write membership access`;
  коміт `test(db): створення тенанта в ядрі й функції гранту`.

## Задача 6: T0 і T3 (Р-A6-9, Р-A6-10, Р-A6-13, Р-A6-14, Р-A6-20)

**Files:** `packages/simetra/src/model/runtime/{operation,catalog,values,errors}.ts`;
`packages/simetra/src/compiler/runtime-catalog.ts`;
`packages/simetra/src/server/{phase,values,errors,transaction}.ts`;
`packages/simetra/src/schema/apply/rights-maintenance.ts`; тести
`packages/simetra/src/model/runtime/__tests__/values.test.ts`,
`packages/simetra/src/model/runtime/__tests__/operation.test.ts`,
`packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts`,
`packages/simetra/src/server/__tests__/{transaction,hooks,values,errors}.test.ts`.

**Interfaces:**
- Consumes: ядро `<корінь>_create_root(p_item jsonb, p_member jsonb, p_member_id uuid)`
  (Задача 4).
- Produces: `create` операції: `id?: string`,
  `creatorMember?: Record<string, unknown>`; `operations.create.root?: { membership?: string }`;
  `encodeAttributes` (Р-A6-13); мапінг деталі `creatorMember.<колонка>` →
  `path: "creatorMember.<реквізит>"`; `23502` з таблицею довідника членства
  `root.membership` у фазі кореня → `command.invalid` з тим самим шляхом.

- [x] **Крок 1 (unit, червоні).** Схема операції (`operation.test.ts`, одна
  таблиця): `create` без `id` і з `creatorMember` приймається схемою;
  обов'язковість `id` — у `prepareInput`. `runtime-catalog.test.ts`:
  `operations.create.root` у `Organization` — `{ membership: <id OrgMember> }`,
  у `Branch` — `{}`, у некореня — відсутнє; схема відхиляє `membership` поза
  каталогом; каталог детермінований.
- [x] **Крок 2 (unit, червоні).** T3 на порт-фейку: точна послідовність
  `create` кореня (id згенеровано до контексту; контекст
  `{create, <мітка>, <id>}`; виклик `<корінь>_create_root($1::jsonb, $2::jsonb, $3::uuid)`;
  ключ у `p_item` = id). `command.invalid` (`it.each`): `id` у `create`
  кореня; без `id` у некореня; `tabularSections` у `create` кореня;
  `creatorMember` у `Branch` і в некореня; `creatorMember` з ключем, скоупом,
  користувачем чи невідомим ключем; `beforeWrite` кореня повертає
  `tabularSections`; `beforeWrite` членства повертає `tabularSections`. Хуки
  (`hooks.test.ts`): порядок Р-A6-14; `ctx` хука членства; `onWrite` кореня
  в моделі оператора отримує `{id, version}`. Р-A6-20: повтор `40001` — ті
  самі id у параметрах обох спроб. Набір змін — один запис з `scope` = id;
  `rows` — рядок кореня. Мапінг (`errors.test.ts`): `creatorMember.<колонка>`
  і `23502` таблиці членства → `command.invalid` з шляхом.
- [x] **Крок 3 (unit, червоні).** Р-A6-13 (`model/runtime/__tests__/values.test.ts`):
  одна таблиця входів — шапка, рядок ТЧ (`rowKey`, префікс) і
  `creatorMember` (примушені ключі, префікс) — однакові вихід і помилки з
  поведінкою до злиття (таблиця очікувань переноситься з наявних тестів
  `encodeMemberValues` і `server/__tests__/values.test.ts`).
- [x] **Крок 4.** Реалізація. `rights-maintenance.ts`: `tenantFullAccess` —
  `encodeAttributes`, потім функція Р-A6-12 окремим оператором після
  `row_security = off`; порушення — `maintenance.invalid-member` з `path`.
- [x] **Крок 5.** `pnpm --filter simetra test runtime server rights-maintenance`;
  коміт `feat(server): створення тенанта в runCommand`.

## Задача 7: DB designer — `runtime.run` прямим портом і пулером, інструмент

**Files:** `packages/designer/src/__tests__/tenant-creation.db.test.ts` (новий;
моделі А і Б Задачі 5 — А для самообслуговування, оператора й
`requiredMember`, Б для хука членства; розгортання — як `command-runtime.db.test.ts`: `compile`, `desiredForApply`,
`inTarget`, `withRuntimeLogin`, `throughPoolerAs`);
`packages/designer/src/__tests__/rights-maintenance.db.test.ts`.

Причина DB-рівня: транзакція `runCommand` із закоміченими даними й пулер —
лише над тінню (П4 §7.1).

- [ ] **Крок 1.** Кейси, кожен — прямим портом і через `throughPoolerAs`
  (`describe.each`):
  - `self-service tenant` (`everyUser`): `run(create Organization, creatorMember)`
    — `rows[0]` — повний рядок кореня; наступна транзакція читає корінь;
    журнал `root-creator`;
  - `operator tenant` (`global` на `Branch`): `rows[0]` = `{id, version: 1}`;
  - `id in input`, `tabularSections`, `creatorMember` без обов'язкового
    реквізиту (`requiredMember: true`) — `command.invalid` (останній — з шляхом);
  - `two tenants in one batch` — один актор, X і Y одним пакетом: після
    `COMMIT` носій `TenantOwner` рівно в X і Y;
  - `retry keeps ids` — перша спроба `create` кореня падає `40001` (хук
    `onWrite` кореня кидає помилку з цим кодом рівно раз), друга з тими самими
    id комітиться: без `command.invalid`, маркера після `COMMIT` немає
    (`rights_tx_root_marker` порожня), творець — носій `TenantOwner`;
  - `parallel tenant creation does not block` — окремий послідовний
    `describe` над закоміченою тінню: перший `run` тримає транзакцію (хук
    `onWrite` кореня чекає на сигнал тесту), другий `run` іншого актора
    завершується без очікування; потім перший комітиться;
  - `membership hook assigns a role` (модель Б, творець — `GlobalFounder`):
    `onWrite` членства через `ctx.run` призначає творцю `TenantReader` у
    новому скоупі — пакет комітиться, журнал цього призначення — `command`;
    `TenantAuditor` — `escalation`.
- [ ] **Крок 2.** `rights-maintenance.db.test.ts`: `tenantFullAccess` з
  `member`, де масивний `Ref` чи поліморфна пара вказує на відсутній рядок
  чи рядок іншого скоупу, — `maintenance.invalid-member` з `path`; на наявний
  рядок того самого скоупу — проходить.
- [ ] **Крок 3.** `pnpm --filter @simetrajs/designer test:db tenant-creation rights-maintenance command-runtime`;
  коміт `test(designer): створення тенанта через runtime.run і пулер`.

## Задача 8: бенчмарк (Р-A6-17)

**Files:** `packages/simetra/bench/rights.bench.db.ts`.

- [ ] **Крок 1.** `snapshotBenchDomain(...layers: Layer[])` (`fixtures/rights.ts`)
  приймає шари; сценарій `8 tenant creation` — модель сценарію 7 плюс
  `tenantSelfService()`; «`COMMIT`» — `SET CONSTRAINTS ALL IMMEDIATE` у
  транзакції сценарію, як у сценарії 7: актори `ordinary actor` (`actor(1, 1)`) і `largest actor`
  (`actor(2000, 20000)`; `RIGHTS_BENCH_SMOKE` — `actor(100, 1000)`). Рядки:
  `8 tenant creation, <актор>` (ядро кореня до `COMMIT`),
  `8 tenant creation COMMIT, <актор>`, розбивка: вставка членства з
  заповненням знімка, тіло функції гранту без знімка; плюс рядок
  `8 assignment write, largest actor` — звичайне призначення найбільшим
  актором до й після змін Задачі 3 (ціна гілки причини журналу).
- [ ] **Крок 2.** Пороги (погоджено архітекторкою; рядок «звичайне призначення
  найбільшим актором до/після» обов'язковий, > 10 % — розвилка з розкладом):
  звичайний актор — ядро ≤ 30 мс, `COMMIT` ≤ 30 мс (медіана); найбільший —
  ядро ≤ Σ операторів заповнення знімка того самого актора (рядок `7 snapshot fill`) + 50 мс, `COMMIT` ≤ 6 с (поріг
  `COMMIT` одного призначення Р3-9). Перевищення — розвилка архітекторці.
- [ ] **Крок 3.** `RIGHTS_BENCH_SMOKE=1 pnpm --filter simetra bench:rights`;
  коміт `test(bench): сценарій створення тенанта`.
- [ ] **Контрольна точка (обов'язкова, після Задач 5, 7 і 8).** Звіт
  архітекторці: SHA і коміти по рядку; мутації, які вже можна (Задача 10);
  scoped DB з часом; рішення й відхилення з полем «вплив на спеку». Чекати
  «далі».

## Задача 9: документи й борг

- [ ] **Крок 0 (Р-A6-18).** `git fetch origin && git log origin/main --oneline | head`,
  `git log origin/feat/p4-a5 --oneline -3`. A5 у `main` — повний кейс §6.14 у
  цьому блоці: розширити `dataCommandRefusal`
  (`packages/designer/src/tools/data-policy.ts`) перевіркою модуля довідника
  членства для `create` кореня з `creatorMember`; unit-рядки (обидва прапорці;
  без `--allow-rights-write` — відмова; модуль на довіднику членства —
  `command.invalid`); DB-кейс designer з обома прапорцями; мутація «перевірка
  модуля лише на об'єкті фази» — червоний unit-рядок. Вплив на спеку: немає.
  Інакше — рядок у звіт «за A5 (задача 7a)».
- [ ] **Крок 1.** Спека П4, Додаток А — рядки блоку A6 «внесено»; спека
  системної схеми §3 — `rights_tx_root_marker` і функція гранту.
- [ ] **Крок 2.** Скіл споживача `people-and-rights.md`: створення тенанта
  (вид з `rootCreator`, явний грант `everyUser` `create@own` чи `global`
  `create`, `setFunction: "membership"`, `creatorMember`, результат
  оператора, підписки на `INSERT` членства — хук команди, діагностики
  Р-A6-16 і Р-A6-19); `tenantFullAccess` — перевірка посилань `member`;
  `SKILL.md` — рядок таблиці задач.
- [ ] **Крок 3.** `docs/ROADMAP.md` — статус A6. Зняти: борг прав §1
  «Інструмент обслуговування не перевіряє посилань у `member`», беклог §6
  «Обхід реквізитів значень двічі».
- [ ] **Крок 4.** `python3 scripts/check-doc-anchors.py`; коміт
  `docs: П4-A6 — Додаток А, скіл споживача, ROADMAP, борг`.

## Задача 10: мутації (після контрольної точки, до вікна гейтів)

Кожна — окремо, на закоміченому дереві; названий тест червоний; після —
`git checkout -- .`. Результат — у журнал.

| # | Мутація | Червоніє |
| --- | --- | --- |
| М1 | `allowedActions`: `create` кореня рівню скоупу | `root create by level` |
| М1а | `create` кореня лишається в домені рівня скоупу | `root create is explicit only` (домен `org`); DB `scope delta cannot grant root create` |
| М2 | `levelDomain(…, true)` у `expandedProjection` (`fullAccess` розгортає `create` кореня) | `root create is explicit only`; DB `global fullAccess without explicit grant…` (Б) |
| М3 | лишити ребро `create ⇒ read` кореня | `root create requires nothing` |
| М4 | `own` політики кореня без `created_by_id = current_user_id()` | unit `root insert is boolean` (DB не бачить: автор примушений до `WITH CHECK`) |
| М4а | лишити родину «решта рядків» `INSERT` кореня | unit `access-units` |
| М4б | `rightsPredicates` без DML — булева форма і для `UPDATE` кореня | unit `rights-predicates` |
| М5 | функція гранту без перевірки контексту | DB відмова «контекст» |
| М6 | без споживання маркера | DB відмова «маркер» (з мутацією виклик проходить до кінця — тест чекає `rights-context`) |
| М7 | без перевірки порожнього скоупу | DB відмова «порожній скоуп» |
| М8 | без перевірки заголовків знімка | DB відмова «заголовки знімка» |
| М9 | без перевірки `rights_tx_start` | DB відмова «кеш початку» |
| М10 | `rights_tx_typed.scope` = `NULL` | DB `creator rights exist only in the new scope` (сценарій у X) |
| М10а | `rights_tx_holders.scope` = `NULL` чи `level_id` іншого виду | DB `appended typed row equals the live typed row` (звірка holders) |
| М10б | маркер споживається без умови `actor` | DB `marker of another actor` |
| М11 | `rights_tx_scopes.catalog = false` | DB `creates a tenant…` (рядок кореня невидимий — неповний результат) |
| М12 | `provenance` у `INPUT_COLUMNS.typed` | `snapshot inputs do not see provenance` |
| М12а | причина за `scope` (будь-який рядок `root-creator` цього скоупу), а не за `assignment` | designer `membership hook assigns a role` (журнал `command`) |
| М13 | `stateRows` лише `reason = 'command'` | еквівалентна: перший образ вставки творця — права, які вже є в кеші початку, тож результат ⊆ не змінюється; умова лишається за спекою як захист порівняння — у журнал з цим поясненням |
| М13а | причина `root-creator` і для `UPDATE` рядка творця | DB `escalation through the creator's own assignment` (журнал оновлення — `command`) |
| М13б | політика `INSERT` кореня з `command_action()` замість `'create'` | unit `root insert is boolean`; DB `insert policy` (Б, контекст `update` — з мутацією `effect` замість `42501`) |
| М14 | причина без гілки `root-creator` | DB `creates a tenant…` |
| М15 | constraint-тригер маркера без відмови / не відкладений | DB `marker without creator…`; не відкладений — DB `creates a tenant…` |
| М16 | маркер і для виду без `rootCreator` | DB `operator model` |
| М16а | грант лише коли `creatorMember` непорожній | DB `global creator on a rootCreator kind becomes the owner` (з `{}`) |
| М17 | без `set_config` перед вставкою призначення | DB `creates a tenant…` (`effect`) |
| М17а | без `set_config` перед вставкою членства | еквівалентна за побудовою: під контекстом кореня рядок членства некореневий і проходить природною `create` тригера ефектів; контекст членства тримає узгодженість «контекст = рядок» (П4 §6.13), тесту, що розрізняє, немає — у журнал з цим поясненням |
| М18 | без повернення контексту кореня | DB `creates a tenant…` (`current_setting`) |
| М19 | користувач членства з `p_member` | DB `forced member columns` |
| М20 | ядро без виклику функції перевірки членства | DB `creatorMember reference checks` |
| М21 | T3 не відхиляє `id` у `create` кореня | unit T3 |
| М22 | T3 не перевіряє чернетку `beforeWrite` кореня | unit T3 hooks |
| М23 | id на кожну спробу | unit T3 retry |
| М24 | `EXECUTE` функції гранту для `authenticated` | unit `grant function has no EXECUTE except command` |
| М25 | кожна діагностика Р-A6-16/Р-A6-19 вимкнена по черзі | відповідний рядок `it.each` |
| М26 | інструмент без функції перевірки членства | designer `rights-maintenance` |

## Задача 11: гейти, перевірка, зведення

- [ ] **Крок 1.** Написати архітекторці й чекати «можна». Повні гейти одним
  вікном на одному SHA (Global Constraints), час кожного — у звіт.
- [ ] **Крок 2.** Лінзи `code-review`: `correctness` (функція гранту діє лише
  після вставки кореня під `create` у цій транзакції й з контекстом цього
  кореня; у шляху команд її кличе лише ядро кореня, сирий SQL під
  `simetra_command` — домен довіри host-а, Рт6; права творця — рівно в
  новому скоупі; ⊆ ловить усе інше), `test-honesty`, `drift`, `architecture`;
  кожну знахідку — `code-review-verifier`.
- [ ] **Крок 3.** Виправлення — scoped DB і швидкі гейти; фінальний звіт
  архітекторці (SHA старту й фінальний, коміти, гейти з часом, мутації,
  бенчмарк, рішення з полем «вплив на спеку», обмеження, кандидати). Codex
  коду запускає архітекторка.
- [ ] **Крок 4 (після «так»).** `git fetch origin && git merge origin/main` →
  `git push -u origin feat/p4-a6` → `gh pr create` у `main` (українською, без
  трейлерів) → номер PR архітекторці.

## Журнал рішень виконання

(заповнює виконавець: рішення, відхилення, вплив на спеку)

- **Задача 1, крок 3 — «підписка на `UPDATE`».** Подія запису
  (`beforeWrite`/`onWrite`) завжди має тригер `INSERT` (`subscription-units.ts`;
  `whenChanged` звужує лише тригер `UPDATE`), підписки лише на `UPDATE` у
  метаданих немає. Негативні кейси — події видалення на тих самих таблицях і
  `onWrite` на `BranchMember`. Вплив на спеку: немає.
- **Задача 1, крок 1 — місце тестів «root create is explicit only».** Розгорнута
  проєкція й домен рівня видно лише у `VALUES` функцій `rights_projection` і
  `rights_domain`, тож тести — у `rights-functions.test.ts` (там помічник
  `valuesRows`), `rightsDomainRows` — там само. Вплив на спеку: немає.
- **`rights.grant-level` на корені** отримує параметр `root` і власний текст
  (правило кореня, а не загальне правило рівня). Обсяг виміру на `create`
  кореня — та сама діагностика на дії. Вплив на спеку: немає.
- **`rights.root-creator-membership`** — лише коли членство виду з прийнятого
  джерела: вид без членства вже має `rights.scope-without-membership`.
  **`rights.root-creator-no-admin`** знімає `administerRights` на будь-якому
  довіднику прав свого рівня («Ролі» чи «Призначення ролей»), як у §4.1.
  **`rights.root-create-author`** — правило стадії 4 без рівня (і в наборах):
  `create@own` кореня без `createdBy` не відкриває рядка на жодному рівні.
  Вплив на спеку: немає.
- **Фікстури.** `GlobalAdmin` з `tenantOperator()` — той самий файл і id, що в
  `adminRoles()`, з явним `fullAccess: false`: шар поверх `adminRoles()` дає
  роль плану. Нескоуплена ціль `Ref` учасника — новий довідник `Country`.
  Літерал хешу моделі `policyDomain(runtimeValuesLayer())` у
  `runtime-catalog.test.ts` оновлено: контракт прав отримав `root`, проєкція
  `fullAccess` втратила `create` кореня. Вплив на спеку: немає.
- **Задача 2 — автор кореня в контракті.** Носій автора `own`-створення
  кореня — новий факт `RightsContract.rootAuthor` (колонка `createdBy`, коли
  вона — власний носій власності кореня), обчислений у `rights/contracts.ts`
  через `findStandardColumn`: будівник умов не знає `attributeCase`, а
  порівняння `origin.standard` з літералом імені забороняє lint. Інші власники
  кореня в `create@own` не входять (тест із другим власником `owner`).
  Вплив на спеку: немає.
- **Задача 2 — DML у перевірці ядра.** `rightsCheck`/`rightsCheckPredicates`
  отримують DML останнім аргументом, `rightsIf` ядра — DML функції: створення —
  `insert`, зміна й позначка — `update` (і над `v_old`), видалення — `delete`.
  Спільний будівник фікстури — `rootCreationDomain()` (самообслуговування,
  оператор, другий власник і ТЧ кореня). Літерал хешу моделі в
  `runtime-catalog.test.ts` оновлено: політики `INSERT` кореня домену змінились.
  Вплив на спеку: немає.
- **Задача 3 — вид скоупу кореня в генераторі ефектів.** Контракт прав
  кореня `scopeKindId` не має (корінь не скоуплений), тож `buildEffectsUnits`
  отримує `scopeKinds` (`CompiledScopeKind`: `root.objectId` → id виду), а факт
  «вид має творця» — з `RoleContract.rootCreator` ролі рівня скоупу. Вставка
  маркера стоїть у гілці дії `create` під `IF TG_OP = 'INSERT'`; ребра
  `requires` — таблиця маркера й `current_user_id()`. Вплив на спеку: немає.
- **Задача 3 — причина `root-creator` на кожному довіднику призначень.** Вираз
  Р-A6-5 стоїть у тригері `INSERT` будь-якого довідника «Призначення ролей»
  (і глобального, і виду без творця), а не лише виду з `rootCreator`: рядки з
  походженням пише лише функція гранту, тож поза нею гілка не спрацьовує;
  умовна генерація додала б розвилку без захисту. Ребро `rights_tx_typed` —
  лише в функції довідника призначень. Вплив на спеку: немає.
- **Задача 3 — частковий індекс і T0.** Будівник `table()` у
  `admin-tables.ts` приймає індекс `{ keys, where }`; `PhysicalOrigin.part`
  (T0 `model/physical/snapshot.ts`, поза переліком файлів плану) отримує
  `rightsTxRootMarker`. `snapshot-sources.ts` і `guard-names.ts` не змінено:
  факти маркер не читають (тест аналізу на `rootCreationDomain()`), а функція
  перевірки маркера — платформна, не пара запобіжника таблиці. Функція
  перевірки — спільна оболонка `definer` (з `row_security = off`, як
  `rights_tx_check`). Літерал хешу моделі в `runtime-catalog.test.ts` оновлено:
  таблиці схеми `simetra` і тригери журналу змінились. Вплив на спеку: немає.
- **Задача 4 — будівники входу й посилань.** `inputLines` приймає `InputSpec`
  (таблиця, параметр, `DETAIL` форми, ключі — один перелік чи гілки
  створення/зміни `save`, `tabular`, `guard`, обов'язковий ключ і `fail` —
  `RAISE` ядра чи `RETURN` перевірки); новий `referenceChecks` — одне джерело
  умов посилань для гілки створення `save` і перевірки членства. SQL наявних
  функцій ядра дослівно той самий (порівняння всіх одиниць двох доменів до й
  після, окремий коміт рефакторингу). Вплив на спеку: немає.
- **Задача 4 — перевірка членства над рядком «після».** Тіло
  `<членство>_simetra_member_check` будує `v_new` так само, як гілка створення
  `save`: значення за замовчуванням з накладеним `p_member`, скоуп — `p_scope`,
  а не голий `jsonb_populate_record` (інакше колонка-посилання з типовим
  значенням пройшла б перевірку в одному місці й ні в іншому). Посилання на
  примушені колонки (ключ, скоуп, користувач) не перевіряються — їх пише
  функція гранту. Форма не-об'єкт повертає `'p_member'` (ядро кореня
  перевіряє форму раніше й відмовляє `creatorMember`). Функція гранту вставляє
  відсутні ключі тим самим `CASE … ELSE <типове значення>`, тож рядок членства
  дорівнює перевіреному. Вплив на спеку: немає.
- **Задача 4 — ядро кореня.** `actions.createRoot` (дія `create` кореня) поруч
  із `functions.createRoot`; ядра немає на «Користувачах»-корені (рядок
  створює провізія) і на корені без жодної колонки гранту вставки (немає
  явного гранту `create`). Порядок — як у плані, а гілка створення `save`
  (`createLines`) спільна: після контексту ядро кореня, як `save`, перевіряє
  `exists`, власні посилання кореня й копії носіїв (§6.6 вимагає перевірки
  кожного нового `Ref`; без неї `owner_id` кореня був би оракулом). На виді з
  творцем відмова `creatorMember` — і на `p_member_id IS NULL`, і на формі
  `p_member` не-об'єкт (спека §6.13: обидва обов'язкові). Невидимий рядок —
  `{<ключ>: id, <версія>: '1'}` (версія текстом, як у результаті `save`, Рт1).
  T0 `COMMAND_CORE_ERRORS.invalid.creatorMember` — причина й префікс
  `creatorMember.<колонка>` (мапу шляху робить Задача 6). Імена `create_root`
  і перевірки членства — у `derivedFunctions` (колізії стадії 4). Вплив на
  спеку: немає.
- **Задача 4 — функція гранту, розвилки для архітекторки.** (а) Ім'я —
  `simetra.<physicalName виду>_root_creator` (для фікстури —
  `simetra.org_id_root_creator`), за брифом архітекторки: фізичне ім'я не
  змінюється з перейменуванням виду; приклад Задачі 5
  (`simetra.org_root_creator`) треба читати з цим іменем. (б) Крок (1) читає
  контекст безвиняткою `command_current()`, а не суворими
  `command_action()`/`command_root()`: без контексту чи з чужим об'єктом
  перша відмова — `rights-context`, а не `command.context`. (в) Функція має
  `SET row_security = off` поверх плану: перевірка (3) інакше за відсутнього
  обходу RLS мовчки не побачила б рядків; так — гучна помилка (fail-closed),
  як у `rights_tx_check` і перевірці маркера. Вплив на спеку: (а) — немає
  (шаблон `<вид скоупу>`); (б), (в) — П4 §6.13 «Привілейований шлях» можна
  уточнити реченням, якщо архітекторка погодить.
- **Задача 4 — форма генераторів.** `memberCheckFunction` і
  `rootCreatorFunction` повертають текст `CREATE FUNCTION`, а одиниці
  (ребра `requires` з тіла, гранти `EXECUTE` лише `simetra_command`) збирає
  `buildCatalogCommandUnits`: ядро кореня кличе обидві функції, і ребра на них
  дає той самий обхід тіла. `refusal` експортовано з `guard-units.ts`;
  контракт ядра для тестів — спільний будівник
  `__tests__/fixtures/catalog-command.ts`. Літерал хешу моделі в
  `runtime-catalog.test.ts` оновлено (нові одиниці). Вплив на спеку: немає.

- **Задача 5 — форма відмов функції гранту.** Кожен рядок `it.each` має
  контроль (`broken = false`), що відрізняється лише умовою рядка й доходить
  до «`COMMIT`»; передумови, які інакше ховала б пізніша чи рання перевірка,
  стверджує крок-передумова (помилка тесту, не відмова): у (5) маркер стоїть і
  в режимі обслуговування, у (6) заголовки знімка є, а кеш початку заповнено
  рівно в зламаному варіанті, у «маркері іншого актора» заголовків ще немає.
  Рядок «(3) порожній скоуп» вставляє членство власником під контекстом
  `create` довідника членства (під контекстом кореня тригер ефектів судив би
  чужий рядок), потім повертає контекст кореня. Кейс «перевірки посилань» додає
  до плану масив `Ref` на відсутній id і «`p_member_id` без `p_member`».
  Вплив на спеку: немає.
- **Задача 5 — живий рядок входу.** Живий рядок `typed` і носій `fullAccess`
  тест рахує тими самими генераторами (`liveInputs(…, LIVE).typed`,
  `fullAccessHolderRows`) над моделлю розгортання: окремої живої функції
  входу `typed` у схемі немає. Сира відмова `23502` — код і колонка `title`
  плюс ім'я таблиці членства з повідомлення Postgres (`Refusal` таблиці не
  несе; мапу T3 робить Задача 6). Генератор не змінювався, механізмних
  дефектів DB не виявила. Scoped DB кроку 2 — 8 файлів, 60 с.
  Вплив на спеку: немає.

- **Задача 6 — факт користувача членства в каталозі (відхилення, на
  погодження).** Р-A6-9 дає T3 лише id довідника членства, а колонку
  користувача, яку T3 мусить примусити в `creatorMember` (крок 2: «з ключем,
  скоупом, користувачем»), каталог не ніс: реквізит `user` довідника членства
  має `insert` (його пише й звичайне створення учасника). Тому сам довідник
  членства в каталозі несе `membership: { userColumn }` (з
  `MembershipContract.userColumn`, на кожному довіднику з `membership`), а
  `operations.create.root` лишився `{ membership?: <id> }`. Примушені ключі
  T3 — реквізити з колонкою скоупу й користувача (ключ таблиці поза
  реквізитами — невідомий обходу). Схема каталогу вимагає, щоб
  `root.membership` вказував на об'єкт каталогу з `membership` і
  `scopeColumn`. Вплив на спеку: П4 §6.3 — речення про `membership.userColumn`
  внесено в коміті задачі.
- **Задача 6 — де T3 генерує id.** `prepareInput` повертає
  `PreparedOperation` (`id` завжди, `memberId` — у кореня з творцем); id
  кореня й рядка членства генеруються там (`globalThis.crypto.randomUUID`),
  тобто до циклу повторів, і лежать у знімку входу — повтор бере ті самі
  (Р-A6-20). Фаза `ctx.run` з `create` кореня генерує свої id на кожен
  виклик: хук і так виконується наново на кожній спробі. Вплив на спеку:
  немає.
- **Задача 6 — шляхи відмов.** Хук `beforeWrite` членства, що повертає
  `tabularSections` чи ключ поза чернеткою, — `command.invalid` з шляхом
  `creatorMember` (реквізиту з таким ім'ям немає, а шлях кореня вводив би в
  оману); значення чернетки членства — `creatorMember.<реквізит>` тим самим
  обходом. `DETAIL` `creatorMember`, `creatorMember.p_member` чи колонка поза
  довідником — шлях `creatorMember`. `23502` таблиці членства в фазі кореня
  з колонкою поза каталогом — `command.internal` (як і без членства);
  довідник членства фаза передає мапінгу в `ErrorPhase.membership`. Вплив на
  спеку: немає.
- **Задача 6 — форма відповіді ядра кореня.** `decodeRecord` (`decode.ts`)
  декодує розібраний рядок; відповідь не об'єкт, рядок без ключа чи версії,
  а на виді без творця `member` не `null` — аномалія `command.internal` з
  журналом. Вплив на спеку: немає.
- **Задача 6 — інструмент обслуговування.** Функцію перевірки членства
  інструмент кличе лише на гілці вставки нового учасника (наявному
  учаснику `member` і так відмовлено), і з `{}`, коли `member` не задано:
  типові значення колонок теж можуть посилатися. Оператор —
  `SELECT <схема>.<членство>_simetra_member_check($1::jsonb, $2::uuid) AS violation`
  після `row_security = off` і до режиму обслуговування, тож відмова —
  до першого запису. Колонка порушення → реквізит (пара — за обома
  колонками), інакше шлях `member`. Ім'я функції — `memberCheckFunctionName`,
  тепер експортоване з `simetra/compiler`. Відмова форми `member` (не
  об'єкт) — шлях `member` прямо з обходу T0. Вплив на спеку: немає.

## Журнал мутацій

(заповнює виконавець після Задачі 10)
