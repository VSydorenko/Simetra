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
| Р-A6-17 | **Бенчмарк** — сценарій 8 у `packages/simetra/bench/rights.bench.db.ts`; пороги — Задача 8 крок 2 (межу ядра найбільшого актора архітекторка переглянула 2026-11-05: ≤ 300 мс) | форма сценаріїв Права-3 | немає |
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

- [x] **Крок 1.** Кейси, кожен — прямим портом і через `throughPoolerAs`
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
- [x] **Крок 2.** `rights-maintenance.db.test.ts`: `tenantFullAccess` з
  `member`, де масивний `Ref` чи поліморфна пара вказує на відсутній рядок
  чи рядок іншого скоупу, — `maintenance.invalid-member` з `path`; на наявний
  рядок того самого скоупу — проходить.
- [x] **Крок 3.** `pnpm --filter @simetrajs/designer test:db tenant-creation rights-maintenance command-runtime`;
  коміт `test(designer): створення тенанта через runtime.run і пулер`.

## Задача 7а: MCP `data-command` — створення тенанта з `creatorMember` (Р-A6-18)

A5 уже в `main` (зведено в `feat/p4-a6`), тож повний кейс П4 §6.14 — у цьому
блоці.

**Files:** `packages/designer/src/tools/data-policy.ts`,
`packages/designer/src/tools/data-tools.ts` (опис інструмента),
`packages/designer/src/__tests__/data-policy.test.ts`,
`packages/designer/src/__tests__/tenant-creation.db.test.ts`,
`packages/simetra/test/support.ts` (реекспорт `MEMBER_FILE`),
`packages/designer/skills/simetra-metadata/references/agents-over-mcp.md`.

- [x] **Крок 1.** `dataCommandRefusal`: для `create` кореня виду з
  `rootCreator` (довідник членства — той, який каталог рантайму називає
  `operations.create.root.membership`) правило «об'єкт із модулем» діє й на
  довідник членства — `command.invalid` `object-module` з `object` довідника
  членства; без `--allow-rights-write` — відмова `rights` (як для довідників
  прав). Кожна фаза пакета перевіряється окремо.
- [x] **Крок 2.** Unit-рядки `data-policy.test.ts` на моделі А
  (`tenantSelfService({ requiredMember: true })` + `tenantOperator()`):
  обидва прапорці — проходить; без `--allow-rights-write` — відмова (і як
  друга фаза пакета після `Branch`); модуль на `OrgMember` — `command.invalid`
  (і як друга фаза пакета); модуль лише на непов'язаному `TaskComment` —
  проходить; `create` кореня оператора `Branch` (без творця) — лише запис
  даних.
- [x] **Крок 3.** DB-кейс `tenant-creation.db.test.ts` (модель А, тека
  метаданих і ознака бази розробника на тій самій тіні): `data-command`
  `create Organization` з `creatorMember` без `--allow-rights-write` —
  `rights-write-disabled`, кількість `organization` і `org_member` незмінна; з
  обома прапорцями — тенант створено, творець — дієвий носій `TenantOwner`
  рівно в новому скоупі, журнал `root-creator`.
- [x] **Крок 4.** Мутація М27 (журнал мутацій); скіл споживача — рядок про
  обидва прапорці й модуль довідника членства; коміт
  `feat(designer): MCP data-command створює тенант з creatorMember`.

## Задача 8: бенчмарк (Р-A6-17)

**Files:** `packages/simetra/bench/rights.bench.db.ts`.

- [x] **Крок 1.** `snapshotBenchDomain(...layers: Layer[])` (`fixtures/rights.ts`)
  приймає шари; сценарій `8 tenant creation` — модель сценарію 7 плюс
  `tenantSelfService()`; «`COMMIT`» — `SET CONSTRAINTS ALL IMMEDIATE` у
  транзакції сценарію, як у сценарії 7: актори `ordinary actor` (`actor(1, 1)`) і `largest actor`
  (`actor(2000, 20000)`; `RIGHTS_BENCH_SMOKE` — `actor(100, 1000)`). Рядки:
  `8 tenant creation, <актор>` (ядро кореня до `COMMIT`),
  `8 tenant creation COMMIT, <актор>`, розбивка: вставка членства з
  заповненням знімка, тіло функції гранту без знімка; плюс рядок
  `8 assignment write, largest actor` — звичайне призначення найбільшим
  актором до й після змін Задачі 3 (ціна гілки причини журналу).
- [x] **Крок 2.** Пороги (погоджено архітекторкою; рядок «звичайне призначення
  найбільшим актором до/після» обов'язковий, > 10 % — розвилка з розкладом):
  звичайний актор — ядро ≤ 30 мс, `COMMIT` ≤ 30 мс (медіана); найбільший —
  ядро ≤ 300 мс (перегляд архітекторки 2026-11-05 замість «Σ операторів
  заповнення знімка + 50 мс»; журнал), `COMMIT` ≤ 6 с (поріг
  `COMMIT` одного призначення Р3-9). Перевищення — розвилка архітекторці.
- [x] **Крок 3.** `RIGHTS_BENCH_SMOKE=1 pnpm --filter simetra bench:rights`;
  коміт `test(bench): сценарій створення тенанта`.
- [ ] **Контрольна точка (обов'язкова, після Задач 5, 7 і 8).** Звіт
  архітекторці: SHA і коміти по рядку; мутації, які вже можна (Задача 10);
  scoped DB з часом; рішення й відхилення з полем «вплив на спеку». Чекати
  «далі».

## Задача 9: документи й борг

- [x] **Крок 0 (Р-A6-18).** Виконано в Задачі 7а.
- [x] **Крок 1.** Спека П4, Додаток А — рядки блоку A6 «внесено»; спека
  системної схеми §3 — `rights_tx_root_marker` і функція гранту.
- [x] **Крок 2.** Скіл споживача `people-and-rights.md`: створення тенанта
  (вид з `rootCreator`, явний грант `everyUser` `create@own` чи `global`
  `create`, `setFunction: "membership"`, `creatorMember`, результат
  оператора, підписки на `INSERT` членства — хук команди, діагностики
  Р-A6-16 і Р-A6-19); `tenantFullAccess` — перевірка посилань `member`;
  `SKILL.md` — рядок таблиці задач.
- [x] **Крок 3.** `docs/ROADMAP.md` — статус A6. Зняти: борг прав §1
  «Інструмент обслуговування не перевіряє посилань у `member`», беклог §6
  «Обхід реквізитів значень двічі».
- [x] **Крок 4.** `python3 scripts/check-doc-anchors.py`; коміт
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
| М28 | `rights.root-creator-assignment-required` вимкнена | рядок `it.each` `a required assignment attribute without a default` (`rights-roles.test.ts`) |
| М29 | `decodeCoreRow` (`server/phase.ts`) без перевірки скоупу взагалі, не лише для рядка членства ядра кореня | unit T3 `decodes the row before COMMIT and logs a row without its scope` |
| М30 | функція гранту без повторної перевірки рядка членства | DB `direct grant call checks member references` |
| М31 | (а) `rootCreatorOf` не знімає факт творця з кореня без ядра створення; (б) без попередження `rights.root-creator-unreachable` | unit `compiles with the unreachable warning and no grant function, create core or marker` |

## Задача 11: гейти, перевірка, зведення

- [ ] **Крок 1.** Написати архітекторці й чекати «можна». Повні гейти одним
  вікном на одному SHA (Global Constraints), час кожного — у звіт.
- [ ] **Крок 2.** Лінзи `code-review`: `correctness` (функція гранту діє лише
  після вставки кореня під `create` у цій транзакції й з контекстом цього
  кореня; у шляху команд її кличе лише ядро кореня, сирий SQL під
  `simetra_command` — домен довіри host-а, Рт6; права творця — рівно в
  новому скоупі; ⊆ ловить усе інше), `test-honesty`, `drift`, `architecture`;
  кожну знахідку — `code-review-verifier`.
- [ ] **Крок 3.** Виправлення рецензії (C1, A1, T1, D1–D3) — виконано
  2026-11-05 (журнал рішень, М29), scoped DB і швидкі гейти зелені; фінальний звіт
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
  П4 §6.13 — «раз на `run`» уточнено: для операцій `runtime.run`, фаза
  `ctx.run` — на кожній спробі (внесено виправленням рецензії D1; спочатку
  тут стояло «немає»).
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

- **Задача 7 — `40001` у кейсі «retry keeps ids» (відхилення форми).** Власний
  виняток хука T3 мапить у `command.internal` без повтору (`callHook`, спека
  П4 §7.2), тож помилка з кодом `40001`, кинута хуком, повтору не дає. Хук
  `onWrite` кореня на першій спробі лише «озброює» порт-обгортку
  (`serializationFailureOnce` у тесті), і та замість першого `COMMIT`
  виконує в тій самій транзакції `DO … RAISE … USING ERRCODE = '40001'`:
  відмову повтору дає сама база, відкат прибирає корінь, членство й маркер.
  Тест стверджує дві однакові пари параметрів ядра кореня, `ctx.id` хука
  однаковий в обох спробах, `COMMIT` — `40001`, потім успіх, таблиця маркера
  порожня, творець — дієвий носій `TenantOwner` рівно в новому скоупі.
  Вплив на спеку: немає.
- **Задача 7 — «parallel tenant creation does not block».** Окремий
  `describe.each` за портами (той самий послідовний файл): перший `run` тримає
  транзакцію в `onWrite` кореня до сигналу тесту, другий `run` іншого
  користувача мусить закомітитися за 15 с, поки перший ще не завершився.
  Детектор перевірено вручну: коли й другий `run` чекає на той самий сигнал,
  обидва варіанти падають «the second creation waited». Блокувань механізм не
  має. Вплив на спеку: немає.
- **Задача 7 — фікстури.** Модель А й Б — спільні будівники
  `tenantSelfService`/`tenantOperator`, реекспортовані через
  `packages/simetra/test/support.ts` разом з id ролей і `ORG_KIND_ID`.
  Посилання учасника на скоуплену ціль для інструмента обслуговування — новий
  шар `memberScopedReferences()` (`requiredMemberAttribute()` плюс масив `Ref`
  на `Region` і пара `Region`/`Users`); цілі `tenantSelfService` нескоуплені, а
  «рядок іншого скоупу» вимагає скоупленої. Модель `rights-maintenance.db.test.ts`
  тепер `policyDomain(adminRoles(), memberScopedReferences())` — наявні кейси без
  змін. `commandRefusal` винесено в `support/db.ts` (локальні копії
  `command-runtime` і `rights-admin-commands` не чіпав). Механізмних дефектів
  DB не виявила. Scoped DB кроку 3 — 3 файли, 42 тести, 23 с.
  Вплив на спеку: немає.

- **Задача 7а — MCP-кейс створення тенанта.** Ознака «корінь з творцем» у
  політиці — та сама, що в `rootCreate` каталогу рантайму (роль `rootCreator`
  рівня виду плюс контракт членства виду); політика читає скомпільовану
  модель, бо каталог рантайму ознаки модуля не несе. Перевірка діє на кожен
  `create` такого кореня, з `creatorMember` чи без: ядро кореня вставляє
  членство творця й з `{}`. Відмова модуля називає довідник членства, а не
  корінь. DB-кейс — у `tenant-creation.db.test.ts` (модель А вже розгорнута
  там; `heldEnv` тепер пише теку метаданих і віддає `url`/`login`), а не в
  `data-tools.db.test.ts`, щоб не розгортати третю тінь. Вплив на спеку:
  немає.

- **Задача 8 — бенчмарк створення тенанта.** Сценарій 8 у
  `rights.bench.db.ts` на моделі `snapshotBenchDomain(tenantSelfService())`;
  актори сценарію 7 винесено в `seedActor`/`benchActors`, Σ операторів
  заповнення знімка — у `snapshotFill` (обидва сценарії). Пороги друкує
  таблиця поруч із заміром (`limit …: within/EXCEEDED`), а не перевірка
  тесту: бенчмарк — заміри машини, рішення про межу — за архітекторкою.
  Межа найбільшого актора рахується від рядка `8 snapshot fill, sum of
  statements` тієї самої моделі (Σ усіх чотирьох фактів; ядро бере лише
  `rights`, `scopes`, `values` — межа щедріша за точну). Розбивка:
  (а) вставка членства із заповненням знімка — той самий оператор, що крок
  (4) функції гранту: від власника з `row_security = off` під контекстом
  `create` членства в щойно вставлений сирим `INSERT` корінь (кореневий
  `INSERT` знімка не бере — перевіряється); (б) тіло функції гранту без
  знімка — виклик функції після знімка, взятого раніше записом власника з
  контекстом у «Користувачів» на нулі рядків (як у сценарії 6; кеш початку
  порожній — перевіряється). «До/після» призначення — тимчасовий окремий
  замір (не комітиться) тієї самої форми на моделі сценарію 7 у двох
  тимчасових worktree: `origin/main` 240caf5a (без A6) і HEAD 00441191,
  чергуванням main/head/main/head, по 31 прогону, актор 2 000 / 20 000.
  Повний прогін — 2026-11-05 на 00441191 з робочими змінами задачі,
  навантаження 1,6–5, 36 хв, 8/8 тестів:

  | Рядок | Медіана | Межа | Висновок |
  | --- | --- | --- | --- |
  | ядро, звичайний | 28,9 мс | ≤ 30 мс | у межі (впритул) |
  | COMMIT, звичайний | 29,9 мс | ≤ 30 мс | у межі (впритул) |
  | ядро, найбільший | 237,4 мс | ≤ Σ 57,3 + 50 = 107,3 мс | **перевищено** |
  | COMMIT, найбільший | 5 804 мс | ≤ 6 с | у межі (перший прогін 6 431) |
  | призначення, найбільший | 41,5 мс | Δ ≤ 10 % | Δ ≈ −0,2 % |

  Розбивка ядра найбільшого актора: вставка членства зі знімком 92,4 мс,
  тіло функції гранту без знімка 32,5 мс; решта ≈ 112 мс — поза функцією
  гранту. Пофункційний замір (`track_functions = 'all'`, разовий, на
  димових обсягах 100 / 1 000, не комітиться) відносить її до перевірок
  пари до знімка: `rights_mine(text, text)` ×5 (через `has_right` ×3
  політики `INSERT` кореня й `rights_any`/`rights_own` читання рядків
  результату) — 25,5 з 34,9 мс ядра; `rights_projection()` ×10 і
  `rights_requires()` ×22 — помітна частка. Призначення «до/після»: запис
  43,46 / 41,77 мс (main) проти 41,76 / 43,23 мс (head) — середнє 42,6 →
  42,5 мс; COMMIT 5 577 / 5 302 проти 5 302 / 5 427 мс — різниця в шумі.
  **Розвилка архітекторці:** ядро найбільшого актора понад межу (Задача 8
  крок 2). Вплив на спеку: немає (до рішення архітекторки).
- **Задача 8 — рішення архітекторки про межу (2026-11-05).** Межа ядра
  найбільшого актора — ≤ 300 мс (замір 237,4 мс — у межі); звичайний актор:
  ядро 28,9 мс і `COMMIT` 29,9 мс у межі ≤ 30 мс (впритул); запис
  призначення найбільшим актором до/після — Δ −0,2 %. Бенчмарк друкує нову
  межу (`≤ 300 ms`). Причину перевищення — перевірки пари `has_right` над
  усіма призначеннями рівня скоупу до знімка — записано кандидатом у борг
  прав («Продуктивність прав»). Вплив на спеку: немає.

- **Задача 9 — діагностика `rights.root-creator-assignment-required`
  (погоджено архітекторкою 2026-11-05).** Функція гранту вставляє
  призначення творця лише з ключем, скоупом, суб'єктом і архетипом
  (`root-creator-units.ts`), тож обов'язковий реквізит застосунку без
  `defaultValue` на довіднику «Призначення ролей» рівня виду з `rootCreator`
  робив би кожне створення тенанта відмовою бази. Помилка стоїть поруч з
  іншими перевірками виду творця (`rootCreatorKindProblems` у
  `rights/role-checks.ts`), на `/rootCreator` ролі, з параметрами
  `scopeKind`, `catalog`, `attribute` (одна діагностика на реквізит). Вплив
  на спеку: П4 §6.13 (абзац «Компілятор»), спека прав §4.1 (перелік відмов) —
  внесено.
- **Задача 9 — уточнення функції гранту в спеці (погоджено архітекторкою
  2026-11-05).** П4 §6.13: крок (1) читає контекст безвиняткою
  `simetra.command_current()` (відсутній чи чужий контекст — теж
  `rights-context`), функція має `SET row_security = off` (fail-closed) —
  розвилки (б), (в) Задачі 4. Вплив на спеку: П4 §6.13 — внесено.
- **Задача 9 — документи.** Додаток А: правки блоку A6 позначено внесеними
  тим самим способом, що й інших блоків (перелік у вступі додатка). Спека
  системної схеми §3 — рядки `rights_tx_root_marker` і функції гранту з
  посиланням на П4 §6.13. Скіл споживача — розділ «Tenant creation» у
  `people-and-rights.md`, перевірка посилань `member` у `tenantFullAccess`,
  рядок створення тенанта в «Supported limits»; у `SKILL.md` таблиця
  «Which tool when» — про інструменти, тож замість рядка таблиці — вказівка
  в розділі «Users, membership and rights». ROADMAP — ранній зріз П4
  виконано (A6 — останній блок П4-A, спека П4 §8). Борг: знято два пункти,
  які закрив план, додано кандидата про `has_right` для `create` кореня.
  Вплив на спеку: немає.

- **Виправлення рецензії C1 — невидимий рядок членства (рішення архітекторки,
  варіант (а)).** Ядро кореня віддає рядок членства, невидимий творцю після
  гранту, формою `{ключ, версія}` без скоупу; T3 вимагав скоуп і давав
  `command.internal`. `decodeCoreRow` (`server/phase.ts`) отримав параметр
  `requireScope` (типово `true`); `false` передає лише `runRootPhase` для
  рядка членства з результату ядра кореня — рядок не йде в набір змін, тож
  скоуп не потрібен. Решта ядер вимагає скоуп, як і раніше (unit
  `a row without its scope`, М29). Тести: unit `membership onWrite gets an
  invisible member row as id and version` (червоний без виправлення);
  designer DB — модель В `tenantSelfService({ fullAccess: false, memberRead:
  false })` (новий параметр будівника знімає грант `TenantOwner` на
  `OrgMember`), обидва порти: `onWrite` членства отримує `{id, version: 1}`,
  рядок членства в базі, творець читає корінь наступною транзакцією й має
  `TenantOwner` з причиною `root-creator`. Вплив на спеку: П4 §6.13 — речення
  про форму невидимого рядка членства (внесено); скіл споживача —
  `people-and-rights.md`.
- **Виправлення рецензії A1 — факт творця кореня в одному місці.**
  `CompiledScopeKind.rootCreator?: { role, membership, assignments }`
  обчислює `pipeline.ts` (`rootCreatorOf`) лише для виду з роллю
  `rootCreator` і коренем-об'єктом; відсутність довідника членства чи
  «Призначень ролей» там — захисний `internal` (раніше — у `rootCreators`;
  мутація М25 (в) тепер упала б тим самим захистом із pipeline). Поле читають
  `rootCreators` (`catalog-command/units.ts`), `rootCreate`
  (`runtime-catalog.ts`) і маркер у `buildEffectsUnits`; `dataCommandRefusal`
  designer отримав каталог рантайму й читає
  `operations.create.root.membership`. У канонічний знімок поле не входить
  (похідне від контрактів), тож хеш моделі й літерали тестів не змінились;
  тести змінено лише в місці виклику `dataCommandRefusal`. Вплив на спеку:
  немає.
- **Виправлення рецензії T1.** Рядок `(2) second call in the same scope`
  перейменовано на `(2)+(3) …`: відмову дає (2) (маркер спожито), а без неї —
  (3); коментар таблиці називає цей виняток. Вплив на спеку: немає.
- **Виправлення рецензії D1–D3.** П4 §6.13 і скіл споживача: id «раз на
  `run`» — для операцій `runtime.run`, фаза `ctx.run` генерує свої на кожній
  спробі. П4 §6.13 крок 2: ключ маркера — один, `(xid, вид скоупу, корінь)` з
  актором. Коментарі `WARNING_RULES`, `rootCreatorAdminWarnings` і
  `pipeline.ts` посилаються на П4 §6.13 замість спеки прав §4.1. Вплив на
  спеку: П4 §6.13 (внесено).
- **Перевірка після виправлень (2026-11-05, 91fa008c).** Unit `simetra`
  180 файлів, 5187 тестів, 1 хв 44 с; `@simetrajs/designer` 38 файлів, 763
  тести, 16 с; typecheck і lint обох пакетів, `format:check`,
  `metadata:check`, перевірка якорів — зелені. Scoped DB: `simetra`
  (`tenant-creation catalog-command rights-guards rights-write membership
  access`) — 8 файлів, 927 тестів, 55 с; designer (`tenant-creation
  command-runtime rights-maintenance data-tools`) — 4 файли, 60 тестів, 37 с.
  Вплив на спеку: немає.
- **Знахідка Codex 1 — прямий виклик функції гранту оминає перевірки
  посилань `p_member`.** Сирий SQL під `simetra_command` (вставка кореня під
  `create`, потім виклик функції гранту) обходив `referenceViolations`, які
  йшли лише в INVOKER-ядрі. Той самий механізм, що Р-A6-12: функція гранту
  перед вставкою членства (крок 4) кличе
  `<членство>_simetra_member_check(p_member - <примушені ключі>, p_root)`;
  від власника з `row_security = off` це «ціль існує й у тому самому
  скоупі». Код відмови — `rights-context`: це родина відмов функції гранту, а
  до неї в шляху команд доходить лише вхід, який уже прийняло ядро (там
  відмова — `command.invalid` `creatorMember.<колонка>`, видимість під RLS, без
  змін), тож порушення тут — лише обхід ядра. Примушені ключі (ключ, скоуп,
  користувач) з входу знято перед перевіркою: функція їх ігнорує й пише сама
  (DB `forced member columns`, М19) — інакше перевірка відмовила б на
  невідомому ключі й зробила б примушення неспостережним. Ребро `requires`
  на функцію перевірки — з одиниць того самого генератора. Факт
  `RootCreatorFacts.membership.check` — одне джерело і для ядра кореня, і для
  функції гранту (`RootCreator.check` прибрано). Фікстура:
  `tenantSelfService({ memberRegions: true })` — масив `Ref` і поліморфна
  пара `OrgMember` на скоуплений `Region`. Тести: unit — крок у тілі й ребро
  `requires`; DB — масив і поліморфна пара на `Region` тенанта `T` →
  `rights-context`, контроль із наявними нескоупленими цілями проходить
  (М30). Вплив на спеку: П4 §6.13 крок 4 — речення (внесено).
- **Знахідка Codex 2 — `rootCreator` без ядра створення кореня давав
  `internal`.** Як сформульовано («без явного гранту `create` на корені»),
  знахідка не відтворюється: ядро `<корінь>_create_root` від грантів не
  залежить (право судить `has_right` під час виклику, а `create` кореня може
  дати й дельта глобальної кастомної ролі, Рх7, Р-A6-22), ключ завжди серед
  колонок вставки, тож без гранту модель компілюється з ядром і функцією
  гранту, а створення відмовляє `no-right`. Коментар у
  `catalog-command/contracts.ts`, який стверджував протилежне, виправлено.
  Відтворюється інший шлях: корінь виду — «Користувачі» (`actionsOf` не дає
  `createRoot`: рядок створює провізія) — `rootCreators` падав `internal`.
  Рішення: факт обрізає `rootCreatorOf` (`pipeline.ts`) через
  `rootCreatedByCommand` (`rights/role-checks.ts`) — той самий предикат
  читає попередження, тож ядро, маркер (`buildEffectsUnits`), каталог
  рантайму (`operations.create.root.membership`), designer і діагностика
  згодні; решта відсутніх передумов у `rootCreators` лишається `internal`.
  Попередження `rights.root-creator-unreachable` (не помилка: модель валідна,
  першу роль призначає інструмент оператора) — поруч із
  `rights.root-creator-no-admin`, у `WARNING_RULES`, en/uk у `messages.ts`;
  будівник `usersRootCreator()`. Тест: unit — компіляція з рівно цим
  попередженням, без функції гранту, ядра кореня й вставки маркера; той
  самий фільтр на `rootCreationDomain()` бачить усі чотири одиниці (М31).
  Вплив на спеку: П4 §6.13, абзац «Компілятор» — речення (внесено). Спека
  прав §4.1 перелічує лише відмови (і `rights.root-creator-no-admin` там
  немає), тож рядка там немає — попередження належить П4 §6.13. Скіл
  споживача — `people-and-rights.md`.
- **Перевірка після знахідок Codex (2026-11-05, 6e25e38c).** Unit `simetra`
  180 файлів, 5189 тестів, 1 хв 44 с; `@simetrajs/designer` 38 файлів, 763
  тести, 16 с; typecheck і lint обох пакетів (13 с), `format:check`,
  `metadata:check`, перевірка якорів — зелені. Scoped DB: `simetra`
  (`tenant-creation catalog-command rights-guards`) — 5 файлів, 876 тестів,
  48 с; designer (`tenant-creation data-tools`) — 2 файли, 36 тестів, 23 с.
  Вплив на спеку: немає.

## Журнал мутацій

Виконано 2026-11-05 на закоміченому дереві 149f61b2 (`feat/p4-a6`), кожна
мутація окремо, після кожної — `git checkout -- .` і чисте дерево. Мутації — у
генераторах, T3 і designer, не в тестах. Команди — найвужчі (без `--` перед
шаблоном); DB — спільний стек через `pnpm … test:db` під guard-ом. Колонка
«час» — початок прогону (UTC). Усього 14:19–14:32, ≈ 13 хв. Підсумок: 35
мутацій червоні (М25 — шість діагностик, кожна окремо червона), одна
**ЗЕЛЕНА** (М12) і одна зелена допоміжна форма (М13а′) — на рішення
архітекторці; М13 і М17а не запускались (еквівалентні за таблицею Задачі 10).

Скорочення команд: `S` = `pnpm --filter simetra test`, `SDB` =
`pnpm --filter simetra test:db tenant-creation`, `DDB` =
`pnpm --filter @simetrajs/designer test:db`.

| № | Мутація | Команда | Результат | Час |
| --- | --- | --- | --- | --- |
| М1 | `allowedActions` (`rights/expand.ts`): корінь на рівні скоупу — `new Set([...allowed])` замість фільтра `create` | `S rights-expand -t "root create by level"` | червоний: `grants create of a scope root in a scope role` — очікуваної `rights.grant-level` (`root: "true"`) на `OrgMember` немає | 14:25 |
| М1а | `levelDomain` (`rights/functions.ts`): за `explicit` рівню `scope` кореня додано `create` | `S rights-functions -t "root create is explicit only"`; `SDB -t "scope delta cannot grant root create"` | червоні: `keeps root create in the domain of the global and everyUser levels only` — у домені `["scope","any"]`, `["scope","own"]`; DB `scope delta cannot grant root create: root create` — відмови `delta-domain` немає | 14:26 |
| М2 | `expandedProjection`: `levelDomain(role.assignedOn, contracts.rights, true)` | `S rights-functions -t "root create is explicit only"`; `SDB -t "global fullAccess without explicit grant"` | червоні: `leaves root create out of the expanded projection` — зайві рядки `GlobalFull` `any`/`own`; DB — очікувано `no-right`, створення пройшло | 14:26 |
| М3 | `rightsContract` (`rights/contracts.ts`): `standardRequires` лишає ребро `create ⇒ read` кореня | `S rights-expand -t "root create requires nothing"` | червоний: `closes the requires of root create to nothing and keeps them elsewhere` — дві `rights.requires-missing` («create» на Organization вимагає «read») | 14:26 |
| М4 | `rootCreatePredicates` (`rights/predicates.ts`): `own` без `ownerCondition` (лише `has_right(…, 'own')`) | `S rights-predicates -t "root insert is boolean"` | червоні 2: `own by the author only on the self-service root`, `the core action gives the same predicates` — немає умови `currentUser` `created_by_id` | 14:24 |
| М4а | `writePolicies` (`access-units.ts`): родина `rest` `INSERT` кореня лишається | `S access-units` | червоний: `the scope root inserts only its own row by the boolean create right` — зайві `organization_insert_rest_any`, `organization_insert_rest_own_created_by_id` | 14:24 |
| М4б | `rightsPredicates`: булева форма для `insert` і `update` кореня | `S rights-predicates` | червоний: `the root keeps the column form for update` — `has_right('create', …)` замість колонкової умови `id` над `rights_any` | 14:25 |
| М5 | функція гранту (`rights/root-creator-units.ts`): без кроку (1) — перевірки контексту | `SDB -t "grant function refuses: .1. context"` | червоні 3: `(1) context of another action/object/root` — зламаний варіант без відмови (очікувано `rights-context`) | 14:19 |
| М6 | функція гранту: без кроку (2) — `DELETE` маркера, `ROW_COUNT`, відмова | `SDB -t "grant function refuses: .2."` | червоні 3: `(2) root inserted without the command context` — виклик без маркера проходить до кінця; `(2)+(3) second call…` (до перейменування за рецензією — `(2) second call…`) і `(2) marker of another actor` — контроль падає `rights-context` на COMMIT (маркер не спожито) | 14:19 |
| М7 | функція гранту: без кроку (3) — скоуп без учасника й призначення | `SDB -t "grant function refuses: .[23]."` | червоний: `(3) scope already has a member` — зламаний варіант без відмови; рядки (2) зелені (там відмова кроку (2)) | 14:20 |
| М8 | функція гранту: без кроку (5) — заголовки знімка | `SDB -t "grant function refuses: .5."` | червоний: `(5) snapshot headers missing` — без відмови | 14:20 |
| М9 | функція гранту: без кроку (6) — кеш початку | `SDB -t "grant function refuses: .6."` | червоний: `(6) start cache filled before appending` — `escalation` (⊆ на COMMIT) замість `rights-context` | 14:20 |
| М10 | функція гранту: `rights_tx_typed.scope` = `NULL` | `SDB -t "creator rights exist only in the new scope"` | червоний: контроль (призначення в новому скоупі) — `42501` RLS на `org_role_assignments`: прав творця в новому скоупі немає | 14:20 |
| М10а | функція гранту: `rights_tx_holders.scope` = `NULL`; другий прогін — `level_id` чужого виду (сталий uuid) | `SDB -t "appended typed row equals the live typed row"` | червоні обидва: holders — `[]` замість одного рядка; `level_id` …0001 замість …6001 | 14:20, 14:21 |
| М10б | функція гранту: `DELETE` маркера без `m.actor = current_user_id()` | `SDB -t "grant function refuses: .2. marker of another actor"` | червоний: зламаний варіант без відмови (маркер чужого актора спожито) | 14:21 |
| М11 | функція гранту: `rights_tx_scopes.catalog = false` | `SDB -t "creates a tenant"` | червоний: `creates a tenant: root, member and assignment in one transaction` — у результаті кореня немає `created_by_id` (рядок кореня невидимий, неповний результат) | 14:21 |
| М12 | `INPUT_COLUMNS.typed` (`rights/admin-tables.ts`) + `["provenance", "text"]`; окрему DDL-колонку `provenance` прибрано, щоб не дублювати | `S rights-admin-tables -t "snapshot inputs do not see provenance"` | **ЗЕЛЕНА.** Тест бере очікування з самого `INPUT_COLUMNS` (`typedColumns`) і для `snapshotInputs`, і для колонок `INSERT` знімка — оракул самопосилальний, мутація змінює обидві сторони; `liveInputs` будує вхід без `INPUT_COLUMNS`, тож перевірка `names(live)` мутацію не бачить. Ловить DB: з мутацією (функцію гранту доведено до компіляції — її `typedColumns` без `provenance`) `SDB -t "creates a tenant\|appended typed row"` червоні `42703 column t.provenance does not exist`. Unit-тест, що зловив би: літеральний перелік дев'яти колонок `INPUT_COLUMNS.typed` чи `expect(snapshotInputs("x").typed).not.toContain("provenance")` | 14:27 |
| М12 (повтор) | те саме, після виправлення тесту 71c7947f (літеральні `not.toContain("provenance")`/`"assignment"` для `INPUT_COLUMNS.typed`, `snapshotInputs` і колонок вставки знімка) | `S rights-admin-tables -t "snapshot inputs do not see provenance"` | червоний: `expected [ 'storage', 'storage_id', …(8) ] to not include 'provenance'` | 14:35 |
| М12а | причина журналу (`rights/guard-units.ts` `transitionSql`): `t.scope = r.scope` замість `t.assignment = r.row_id` | `DDB tenant-creation -t "membership hook assigns a role"` | червоні 2 (прямий порт і пулер): призначення хука членства `TenantReader` — `reason: "root-creator"` замість `command` | 14:31 |
| М13 | `stateRows` лише `reason = 'command'` | — | не запускалась: еквівалентна (пояснення — таблиця Задачі 10) | — |
| М13а | `transitionSql`: гілка `root-creator` і для `UPDATE`, для `UPDATE` — без умови `NOT EXISTS` першого образу | `SDB -t "escalation through the creator"` | червоний: журнал `UPDATE` — `reason: "root-creator"` замість `command` | 14:22 |
| М13а′ | `transitionSql`: лише умова `operation === "INSERT" \|\| operation === "UPDATE"`, `NOT EXISTS` лишається | `SDB -t "escalation through the creator"` | **зелена.** Умова `NOT EXISTS` (рядка журналу того самого `row_id` у транзакції) відсікає `UPDATE`: вставку призначення функція гранту вже записала в журнал тієї самої транзакції, а рядок `typed` з походженням є лише в транзакції вставки. Розрізнювального тесту в цій формі не бачу — на рішення архітекторці | 14:22 |
| М13б | `rootCreatePredicates`: `has_right((SELECT simetra.command_action()), …)` замість `'create'` | `S rights-predicates -t "root insert is boolean"`; `SDB -t "insert policy"` | червоні: unit 3 рядки — вираз без літерала `'create'`; DB `insert policy: update of a root elsewhere does not open INSERT` — `command.forbidden` (`effect`) замість RLS `42501` | 14:24 |
| М14 | `transitionSql`: без гілки `root-creator` | `SDB -t "creates a tenant"` | червоний: журнал призначення творця — `reason: "command"` замість `root-creator` | 14:22 |
| М15 | (а) `rootMarkerBody` (`guard-units.ts`) без `RAISE`; (б) тригер маркера без `DEFERRABLE INITIALLY DEFERRED` | (а) `SDB -t "marker without creator"`; (б) `SDB -t "creates a tenant"` | червоні: (а) відмови `rights-context` на COMMIT немає; (б) `creates a tenant…` — `rights-context` одразу на вставці кореня | 14:23 |
| М16 | `buildEffectsUnits` (`rights/effects-units.ts`): маркер і на корені виду без `rootCreator` | `SDB -t "operator model"` | червоні: `operator model: a root without a creator` — `rights-context` на COMMIT; також контроль `insert policy: a direct root INSERT needs the create right` | 14:23 |
| М16а | ядро кореня (`catalog-command/units.ts`): `IF p_member <> '{}'::jsonb THEN PERFORM <грант> END IF` | `SDB -t "global creator on a rootCreator kind becomes the owner"` | червоний: `rights-context` на COMMIT (функції гранту не було, маркер лишився) | 14:23 |
| М17 | функція гранту: без `set_config` перед вставкою призначення | `SDB -t "creates a tenant"` | червоний: `command.forbidden` `effect` | 14:21 |
| М17а | без `set_config` перед вставкою членства | — | не запускалась: еквівалентна (пояснення — таблиця Задачі 10) | — |
| М18 | функція гранту: без кроку (9) — повернення контексту кореня | `SDB -t "creates a tenant"` | червоний: контекст після ядра — `administerRights`/`org_role_assignments` замість `create`/`organization` | 14:21 |
| М19 | функція гранту: користувач членства — `v_in.user_id` (з `p_member`) | `SDB -t "forced member columns"` | червоний: `user_id` рядка членства — `other` замість творця | 14:22 |
| М20 | ядро кореня: без виклику `<членство>_simetra_member_check` і його відмови | `SDB -t "creatorMember reference checks"` | червоні 4: поліморфний і масивний `Ref` на чужий чи відсутній рядок — без `command.invalid` `creatorMember.<колонка>`; контроль (власний користувач) зелений | 14:23 |
| М21 | `rootInput` (`server/phase.ts`): без відмови `id` у `create` кореня | `S server/__tests__/transaction -t "rejects an id in a root create"` | червоний: `rejects an id in a root create before the port` — `CommandFailure` не кинуто | 14:28 |
| М22 | `runRootPhase`: без повторної перевірки `draft.tabularSections` кореня | `S server/__tests__/hooks -t "tenant creation hooks"` | червоний: `root beforeWrite returns tabularSections: command.invalid before the core` — відмови немає | 14:28 |
| М23 | `runRootPhase`: нові `id` і `memberId` на кожну спробу | `S server/__tests__/transaction -t "retry reuses the root and member ids"` | червоні 2 (`40001`, `40P01`): контекст і параметри ядра — інші id в кожній спробі | 14:28 |
| М24 | `buildCatalogCommandUnits`: додатковий `GRANT EXECUTE ON FUNCTION simetra.<вид>_root_creator(uuid, uuid, jsonb) TO authenticated` | `S rights-root-creator` | червоний: `has no EXECUTE except command` — зайвий `GrantStmt` для `authenticated` | 14:29 |
| М25 | кожна діагностика окремо (`rights/role-checks.ts`, `stages/links.ts`): (а) `-membership`; (б) `-set-function`; (в) `-assignments`; (г) `-subscription`; (д) `root-create-author`; (е) `-no-admin` | `S rights-roles -t "reports a kind with"`, `-t "reports a kind whose assignments"`, `-t "reports root create on own"`, `-t "reports a root creator without full access"`; `S event-subscriptions -t "a write subscription on"` | червоні: (а) `reports a kind with an adopted membership sourc…` — немає `-membership`; (б) той самий рядок і `reports a kind with a verbatim set function`; (в) `reports a kind whose assignments come from an a…` — без діагностики компіляція доходить до генератора й падає захисним `internal: scope kind … has a root creator without root, membership or assignments command` (`rootCreators`); (г) 4 рядки `a write subscription on … is an error` — `[]`; (д) 3 рядки `reports root create on own …`; (е) `reports a root creator without full access and …` — `[]` | 14:29–14:30 |
| М26 | `rights-maintenance.ts`: виклик `checkMember` прибрано | `DDB rights-maintenance -t "is invalid-member"` | червоні 4: інструмент повертає `ok: true` замість `maintenance.invalid-member` | 14:30 |
| М27 | `dataCommandRefusal` (`designer/src/tools/data-policy.ts`): без перевірки модуля довідника членства кореня | `pnpm --filter @simetrajs/designer test data-policy` | червоні 2: `tenant creation when the membership cat…` і пакетний варіант — немає `object-module` на `OrgMember`; переповторено на закоміченому дереві | 14:31 |
| М28 | `rootCreatorKindProblems`: умова `rights.root-creator-assignment-required` вимкнена | `S rights-roles -t "reports a required assignment attribute"` | червоний: `reports a required assignment attribute without…` — `[]` замість діагностики | 14:31 |
| М29 | `decodeCoreRow` (`server/phase.ts`): перевірку скоупу вимкнено для всіх рядків (`false &&` замість `requireScope &&`) — виправлення рецензії C1, на закоміченому дереві 91fa008c | `S server/__tests__/transaction server/__tests__/hooks` | червоний 1: `decodes the row before COMMIT and logs a row without its scope` — рядок звичайного ядра без скоупу пройшов без аномалії; решта 119 зелені | 17:02 |
| М30 | функція гранту (`rights/root-creator-units.ts`): без повторної перевірки `<членство>_simetra_member_check` — знахідка Codex 1, на закоміченому дереві 6e25e38c | `SDB -t "direct grant call checks member references"` | червоні 2: масив і поліморфна пара на `Region` чужого тенанта — рядок членства вставлено, відмови немає; контроль зелений | 17:25 |
| М31 | (а) `rootCreatorOf` (`pipeline.ts`): умова `rootCreatedByCommand` вимкнена; (б) без `rootCreatorUnreachableWarnings` у діагностиках — знахідка Codex 2, 6e25e38c | `S rights-root-creator` | червоні обидва: (а) `internal: scope kind … has a root creator without root, membership or assignments command`; (б) `[]` замість попередження | 17:26 |
