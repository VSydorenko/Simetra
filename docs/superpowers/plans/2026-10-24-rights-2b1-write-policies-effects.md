# Права-2b1: контекст команди, політики запису й тригер ефектів — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: прийнято архітектором 2026-10-24 після 4 раундів аудиту автора й аудиту Codex.
Архітектор задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** роль `simetra_command` пише в таблиці виду лише за правами. Контекст
команди `simetra.command` розбирає одна згенерована функція; політики
`INSERT`/`UPDATE`/`DELETE` дають кореневому рядку право дії команди, решті
рядків — природну дію за DML; тригер ефектів відхиляє зміну, що виходить за
дозволені ефекти дії. Межу тенанта на запис 2a2 вперше доводить DB-сценарій.

**Архітектура:**

- **T0** (`packages/simetra/src/model`): `COMMAND_SETTING` і форма
  `CommandContext` поруч із `PLATFORM_ROLES`; факт реєстру
  `KindAction.natural` — природна дія за DML.
- **T1** (`packages/simetra/src/compiler`): контракт прав несе `natural` і
  тримає інваріант «усі дії об'єкта — один набір обсягів»; генератор
  `command` (`compiler/rights/command-units.ts`) — функції контексту; будівник
  умов 2a1 приймає дію контексту (`COMMAND_ACTION`); `access-units.ts` —
  політики запису двох родин і `RESTRICTIVE`-запобіжник контексту; генератор
  `effects` (`compiler/rights/effects-units.ts`) — тригер ефектів.
- **T2** (`packages/simetra/src/schema`): зворотна генерація й промоція
  впізнають одиниці ефектів як платформні.
- **Тести:** unit на деревах SQL; один DB-опис запису під `simetra_command`.

**Стек:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query (WASM),
локальний стек Supabase (Postgres 17).

**Спека:** [спека прав](../specs/2026-10-17-rights-design.md) — читати повністю,
головне §3, §5.2, §5.3, §5.4, §6.2, §8; [платформна
спека](../specs/2026-09-24-simetra-platform-design.md) §6.7, §6.8, Р21, Р24,
Р29; [спека промоції](../specs/2026-10-06-promotion-design.md) §8, §9.2, §9.3.
Плани [Права-2a1](2026-10-18-rights-2a1-command-role-functions.md) і
[Права-2a2](2026-10-18-rights-2a2-read-policies-carriers.md) — їхні таблиці
рішень діють; їхні форми тут — дані.

**Залежність:** Права-2a2 виконано й прийнято (гілка `feat/rights-2a2` чи її
злиття): є `rightsPredicates`/`renderCondition` (`compiler/rights/predicates.ts`),
`accessPolicyNames`, `buildAccessUnits` (`compiler/access-units.ts`),
`hasRightsFunctions` (`compiler/rights/functions.ts`), `contentChangeCondition`
і `mechanicsStandardNames` (`compiler/mechanics-units.ts`), `carrierCopies`,
`carrierTriggerNames` (`compiler/rights/carrier-units.ts`), `policyDomain()`
(`compiler/__tests__/fixtures/rights.ts`), `describeTransaction`
(`test/db/rights-seed.ts`), `queryAs` (`test/db/connection.ts`), помилка
`rights.public-read-forbidden` (Р2a2-33). З планом
[Права-2b2](2026-10-24-rights-2b2-carrier-backfill.md) спільного коду й спільних файлів немає;
порядок виконання — 2b1, потім 2b2 (рішення архітектора). Перед стартом —
`.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-24-rights-2b1-write-policies-effects.md`.

## Global Constraints

- Усі обмеження планів Права-1a, 1b, 2a1 і 2a2 (їхні розділи «Global Constraints») діють і тут.
- 🔴 `pnpm --filter <pkg> test <pattern>` — **без** `--` перед шаблоном.
- 🔴 Кожна умова права в політиці запису — з `rightsPredicates`/`renderCondition`; власних форм предиката немає. Умова родини (кореневий рядок чи ні) — лише через `simetra.command_root`.
- 🔴 Ролі в `TO` — лише `PLATFORM_ROLES.command` (політики запису й запобіжник контексту); ролі API й `anon` — ніколи. Ім'я налаштування — лише через `COMMAND_SETTING`, літерала `'simetra.command'` поза T0 немає (тести — теж через сталу).
- 🔴 Жодних грантів DML у згенерованому SQL (тест 2a1 `generated SQL never manages the command role itself` лишається зеленим); DML і `SELECT` ролі команд — П4. DB-сценарій видає їх собі в транзакції з відкатом.
- 🔴 Тригер ефектів не читає GUC-прапорців, `pg_trigger_depth()` чи `current_user`; контекст — лише через безвиняткову поверхню розбору (Р2b1-2).
- 🔴 Перелік змістових колонок (поза механікою, копіями й генерованими) — одне джерело `contentColumns` для `contentChangeCondition` і тригера ефектів (Р2b1-9, Р2b1-15).
- Генератори `command` і `effects` і політики запису — лише там, де `hasRightsFunctions` (Р2a2-24).
- DB-тест — лише для того, що вирішує Postgres; SQL-текст — unit. Скіл `.agents/skills/writing-tests/SKILL.md` обов'язковий перед кожним кроком тестів.
- Між задачами гейти не червоні: зміна, що ламає тест, і правка цього тесту — в одному коміті.
- Репо публічне: приклади й фікстури — синтетичні.

## Рішення плану

Розвилки (а), (г), (д), (е), (ж) і поділ 2b на 2b1/2b2 вирішив архітектор
задачі 2026-10-24.

| # | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р2b1-1 | Значення `simetra.command` — JSON-об'єкт рівно з ключами `action` (непорожній рядок: слово словника чи UUID кастомної дії), `object` (непорожній рядок: мітка кореневого об'єкта), `root` (UUID кореневого рядка). Ім'я налаштування — T0 `COMMAND_SETTING = "simetra.command"`, форма — T0 `CommandContext { action: string; object: string; root: string }` (їх візьме `runCommand` П4) | мітка й дія — довільний текст, позиційний формат вимагав би екранування; JSON розбирає Postgres | спека прав §5.3 — формат значення й імена функцій (Задача 0) |
| Р2b1-2 | Генератор `command` (схема `simetra`, `LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''`, `EXECUTE` лише `PLATFORM_ROLES.command`, `REVOKE … FROM PUBLIC` і ролей API): приватний розбір `command_parsed(p_strict boolean, OUT action text, OUT object text, OUT root uuid)` і три поверхні над ним — `command_action() RETURNS text` і `command_root(p_object text) RETURNS uuid` (суворі: відсутнє, порожнє чи зіпсоване значення — `RAISE` `42501`, `MESSAGE 'command.context'`, `DETAIL 'missing'` чи `'malformed'`), `command_current(OUT action text, OUT object text, OUT root uuid)` (безвиняткова для відсутнього й порожнього: усі `NULL`; зіпсоване — той самий `RAISE`). `command_root` повертає `root`, коли `object = p_object`, інакше `NULL`. Розбір один. Розбір також відхиляє (`DETAIL 'unknown-action'`) пару (`object`, `action`), якої немає серед дій з непорожнім `effects.dml` контрактів прав проєкту — перелік вшито сталою `VALUES` у тіло `command_parsed` (спека §3: невідома дія — відмова команди; інакше контекст із вигаданою дією пропускав би записи інших об'єктів за природною дією; аудит Codex) | гучна відмова замість тихих «0 рядків» на `UPDATE`, коли запис дійшов до RLS (оператор, що не торкнувся жодного рядка, політик не обчислює й завершується нулем рядків — це не відмова й не витік); тригеру треба розрізнити «контексту немає» без винятку; один парсер — без розсинхрону | спека прав §5.3 (Задача 0) |
| Р2b1-3 | Запобіжник контексту — `RESTRICTIVE` `<t>_command_insert` (`WITH CHECK`), `<t>_command_update` (`USING` і `WITH CHECK`), `<t>_command_delete` (`USING`) `TO simetra_command` з умовою `(SELECT "simetra"."command_action"()) IS NOT NULL` на кожній таблиці з політиками запису. Порожній чи відсутній контекст — відмова навіть на таблиці без кореневої родини (регістр) | один запобіжник з одною мутацією; умова суворої функції або істинна, або кидає | спека прав §5.3, рядок «порожнє чи відсутнє — відмова» (Задача 0: назва запобіжника) |
| Р2b1-4 | Політики запису — дві родини на кожну команду `INSERT`/`UPDATE`/`DELETE`, `PERMISSIVE TO simetra_command`, по політиці на предикат: **кореневий рядок** — `<ключ> = (SELECT "simetra"."command_root"('<мітка>'))` AND предикат дії контексту (`COMMAND_ACTION`); **решта рядків** — `<ключ> IS DISTINCT FROM (SELECT "simetra"."command_root"('<мітка>'))` AND предикат природної дії за DML. Ключ основної таблиці — колонка-ключ стандартного реквізиту `ref` (`origin.standard` = ім'я `ref` у стилі проєкту), лише коли саме вона — одноколонковий первинний ключ; ТЧ такої основної таблиці — колонка власника (`parent_id`, та сама, що в `carrierColumn` для носія-ключа) з міткою власника. Таблиця без такого ключа — незалежний регістр відомостей (первинного ключа немає), константа (ключ — `singleton` чи колонка скоупу) — кореневої родини не має, а «решта» — без умови родини (аудит, раунд 1: `boolean = uuid` на константі зламав би розгортання). `UPDATE`: та сама умова в `USING` і `WITH CHECK`. Похідні таблиці регістрів (`origin.part`) і об'єкти без жодної дії з `dml` політик запису не мають. Межі тенанта 2a2 — без змін | дія команди діє лише над кореневим рядком (§5.3); обидві умови некорельовані (`InitPlan`) | спека прав §5.3 — дві родини (Задача 0) |
| Р2b1-5 | Будівник 2a1 приймає дію контексту: `rightsPredicates(contract, action: string \| typeof COMMAND_ACTION, table, main?)`, де `COMMAND_ACTION` — експортований символ; у `head` замість `sqlLiteral(action)` — `(SELECT "simetra"."command_action"())`. Обсяги — спільний набір обсягів об'єкта (Р2b1-6). Сумісне розширення сигнатури, виклики з літералом не змінюються | ~42 політики на основну таблицю документа замість ~63 статичних на кожну дію, без росту від кастомних дій | Р2a1-17 / Задача 7 плану 2a1 — рядок про розширення сигнатури (Задача 0); спека — немає |
| Р2b1-6 | Інваріант «усі дії об'єкта мають один набір обсягів» (на ньому стоїть Р2b1-5) тримає код: `uniformExtents(actions: readonly RightsAction[], label: string): RightsExtent[]` у `compiler/rights/contracts.ts` кидає внутрішню помилку компілятора (`internal: rights actions of <мітка> differ in extents`), якщо набори різняться; `rightsPredicates` з `COMMAND_ACTION` бере обсяги лише через неї | дія з іншим набором обсягів дала б мовчазне розходження політик | немає |
| Р2b1-7 | Природна дія за DML — факт реєстру `KindAction.natural?: true` на `create`, `update`, `delete`, `write`: природні DML дії — її `effects.dml` (довідник і документ: `update` — `["update"]`; константа: `update` — `["insert", "update"]`; регістр: `write` — усі три); контракт — `RightsAction.natural: Dml[]` (= `effects.dml` природної дії, інакше `[]`; кастомна — `[]`). На кожен DML об'єкта — щонайбільше одна природна дія (внутрішня перевірка контракту). Природна дія ТЧ на будь-який DML — природна дія власника для `update`. DML без природної дії — «решта» не генерується (fail-closed) | гілка за видом заборонена (`AGENTS.md`); регістр не має `create`/`update`/`delete`, лише `write` | спека прав §3 — «природна дія за DML — факт реєстру» (Задача 0) |
| Р2b1-8 | Тригер ефектів — генератор `effects`: функція `<t>_simetra_effects()` у схемі таблиці (`LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off`, кваліфіковані відношення, `RETURNS trigger`, `EXECUTE` — нікому; повз RLS читає лише існування власника рядка ТЧ (Р2b1-9) і GUC контексту, у запит віддає лише `NULL` чи відмову — як функції носіїв, Р2a2-8; запобіжник не тримає безпеки на вимозі графа `delete ⇒ read`) і `AFTER … FOR EACH ROW` тригери: на таблиці без копій — `<t>_simetra_effects` на `INSERT OR UPDATE OR DELETE`; з копіями — `<t>_simetra_effects` на `INSERT OR DELETE` і `<t>_simetra_effects_update` на `UPDATE … WHEN (<contentChangeCondition>)`. Лише на основних таблицях з кореневою родиною (Р2b1-4) і їхніх ТЧ. `AFTER` бачить остаточний рядок після всіх `BEFORE`-тригерів — незалежність від порядку без заборон; зміна лише копій (поширення функціями носіїв `SECURITY DEFINER`, виведення копій) — не дія | без GUC, `pg_trigger_depth` і `current_user` (архітектор) | спека прав §5.3 — тригер `AFTER`, зміна лише копій не є дією (Задача 0) |
| Р2b1-9 | Тіло тригера: `command_current()`; `action IS NULL` — `RETURN NULL`; `object` ≠ мітка (власника для ТЧ) чи рядок не кореневий — перевірка рядка за ефектами природної дії (Р2b1-18(4)), а не вихід (аудит Codex: інакше запис іншого об'єкта в контексті команди обходив би колонки переходів). Ключ `ref` основної таблиці незмінний за будь-якої дії й для будь-якого рядка: `OLD.<ключ> IS DISTINCT FROM NEW.<ключ>` — `effect`, і ключ не входить у розгорнуту шапку `"all"` (аудит Codex: `UPDATE task SET id = …` під `update` змінив би ідентичність кореня). Основна таблиця: рядок кореневий, якщо `OLD.<ключ>` чи `NEW.<ключ>` (за `TG_OP`) = `root`; для кореневого — `TG_OP` ∈ `effects.dml` дії і, на `UPDATE` з `header` ≠ `"all"`, жодна змістова колонка поза `header` не змінилася. ТЧ: рядок кореня, якщо `OLD.parent_id`/`NEW.parent_id` = `root`; дозволено, якщо `effects.tabularSections` і DML рядка ТЧ узгоджений з DML дії над власником (`INSERT` рядка ТЧ — коли `effects.dml` містить `insert` чи `update`; `UPDATE` і `DELETE` рядка ТЧ — лише коли містить `update`: дія `create` над наявним коренем не змінює й не видаляє його рядків ТЧ; аудит, раунд 3), або `TG_OP = 'DELETE'` і рядка власника вже немає — `NOT EXISTS (SELECT 1 FROM <власник> WHERE <скоуп> = OLD.<скоуп> AND <ключ> = OLD.parent_id)` (так виглядає каскад FK: він іде після видалення власника, і власник уже не видимий; у ТЧ кореня скоупу умова — одна пара за `parent_id`). Окремий рядок ТЧ живого документа під дією без `tabularSections` не видаляється: інакше роль з `delete` без `update` змінила б зміст документа (архітектор). Невідома дія — відмова. Колонки порівняння — `contentColumns(table, attributeCase)` (новий експорт `mechanics-units.ts`, з якого тепер будується й `contentChangeCondition`); механіку (`version`, `updated_at`) він уже виключає (Р2b1-15). Відмова — `RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'command.forbidden', DETAIL = 'effect', TABLE = '<t>'` (і `COLUMN = '<колонка>'` для шапки), без даних рядка | §5.3, §6.2 (`effect`); без винятку каскаду видалення документа з рядками впало б на тригері ТЧ | спека прав §6.2 — код відмови тригера й виняток каскаду (Задача 0) |
| Р2b1-10 | Обробник `beforeWrite`, що під дією-переходом (`post`, `markDeletion`) змінює іншу колонку шапки кореня, — відмова тригера ефектів (fail-closed); детермінований перерахунок того самого значення змін не дає. Обчислення під проведенням — у хуку команди П4 чи в ефектах кастомної дії | ефект — межа дії, а не лише оператора | спека прав §5.3 — речення (Задача 0); скіл споживача |
| Р2b1-11 | Імена: `accessPolicyNames(table)` додає `commandInsert`, `commandUpdate`, `commandDelete` (`<t>_command_<dml>`) і `write(dml: Dml, family: "root" \| "rest", label: string)` = `<t>_<dml>_<family>_<мітка>` з тим самим обмеженням мітки 40 байтів, що `rights` (Р2a2-2; мітка — `rightsLabel`). Імена функцій ефектів — у `derivedFunctions` (колізія — `physical.function-duplicate`, як Р2a2-22) | наявні члени `accessPolicyNames` не змінюються | немає |
| Р2b1-12 | Зворотна генерація й промоція: `<t>_simetra_effects`, `<t>_simetra_effects_update` і функція `<t>_simetra_effects()` — платформні (`platformTriggerFunction` у `schema/reverse/units.ts`), не стають заміною прийнятого тригера (fail-closed); функції генератора `command` — як функції генератора `rights`. Нові `PERMISSIVE`-політики запису ролі команд у промоції потрапляють у пункт `access:<таблиця>` рядком `adds roles simetra_command` (наявна поведінка `addedRoles`; коду не змінює — тест фіксує) | доступ, який додає промоція, має бути видно під дозволом | немає |
| Р2b1-13 | DB-сценарій під `simetra_command`: у транзакції опису `GRANT SELECT, INSERT, UPDATE, DELETE` таблицям схеми фікстури ролі команд і членство з `SET`. Перший шлях — `GRANT simetra_command TO CURRENT_USER WITH SET TRUE`; якщо Postgres відмовляє (код помилки ≠ успіх), запасний — `SET LOCAL createrole_self_grant = 'set'`, `CREATE ROLE <testRoleName("command")> NOLOGIN`, `GRANT simetra_command TO <тегова> WITH SET TRUE`, далі в кожному кейсі `SET LOCAL ROLE <тегова>` і `SET LOCAL ROLE simetra_command`. Критерій вибору — результат першого `GRANT` у точці збереження; обраний шлях — у коментарі опису. Усе відкочується | механізм визначає весь сценарій (архітектор) | немає |
| Р2b1-14 | Відхилення від умови архітектора до (д) «команда `post` пише A лише з правом `post`, без `update`»: за графом `post ⇒ update` (`postAction.requires`), тож замикання прибирає `post` без `update`, і кейс неможливий. Натомість DB-кейси `post-extent` (роль з `update@any` і `post@own` не проводить чужу задачу, хоч оновити її може), `root-transition` (корінь пишеться лише з правом `markDeletion`, що вимагає лише `read`) і `rest-needs-natural` (інший рядок тієї самої команди вимагає `update`) — погоджено архітектором | вони гостріші й можливі за графом | немає |
| Р2b1-15 | Тригер ефектів не рахує зміною лише колонки, значення яких **примушує платформа**: механіка (`touchFunction`, `compiler/mechanics-units.ts`) перезаписує `NEW.version` (`1` на вставці, `OLD.version + 1` на оновленні) і `NEW.updated_at := now()` незалежно від запиту, а `contentColumns` їх уже виключає (`mechanicsStandardNames`) — одне джерело з механікою. `created_at`, `created_by`, `updated_by` механіка не примушує (факт коду), тож вони — зміст: дія-перехід, що їх змінює, — відмова `effect` (fail-closed: інакше `post` переписав би автора). Коли П4 дасть механіку авторства (примушене `updated_by`), колонка переходить у перелік механіки тим самим джерелом (рядок боргу) | архітектор: виключення лише для примушеного; окремого переліку немає | спека прав §5.3 — «аудит (авторство) — лише після примушеної механіки авторства П4; до того зміна авторства під дією-переходом — відмова `effect`» (Задача 0) |
| Р2b1-17 | Об'єкт із `publicRead`: `<t>_public_read` отримує й `PLATFORM_ROLES.command` — уточнення форми Р2a2-3 (архітектор). Роль команд діє від імені користувача з його claims, а рядки такого об'єкта цьому користувачеві й так відкриті; без цього `UPDATE … WHERE`, `DELETE … WHERE` і `INSERT … RETURNING` на ньому не бачили б рядків, і політики запису були б мертві. Межі запису 2a2 й політики запису 2b1 на ньому діють | роль команд не повинна бачити менше за користувача, від імені якого діє | спека прав §5.2 — пункт про `publicRead` (Задача 0); план 2a2 — уточнення Р2a2-3 (Задача 0) |
| Р2b1-18 | **Колонки переходів** (рішення архітектора за F1 раунду 4). Факт реєстру `KindAction.transition?: { column: string; from?: boolean; to?: boolean }` (`column` — канонічне логічне ім'я): `post` — `{ column: "posted", from: false, to: true }`, `unpost` — `{ column: "posted", from: true, to: false }`, `markDeletion` — `{ column: "deletionMark" }` (у реєстрі одна дія в обидва боки, напрямку немає; окремої дії зняття позначки реєстр і спека не мають). Контракт: `RightsAction.transition?: { column: string; from?: boolean; to?: boolean }` (фізична колонка) і `RightsContract.transitions: { column: string; default: string }[]` (колонки переходів об'єкта зі значенням за замовчуванням з реєстру, `"false"`). (1) `"all"` у `canonicalHeader` розгортається в «колонки шапки основної таблиці мінус колонки переходів» — `update`, `create` і кастомні дії з `"all"` мають явний перелік, тож тригер порівнює колонки переходів, як будь-які поза ефектом. (2) `INSERT` рядка основної таблиці (корінь чи ні): кожна колонка переходу = своє значення за замовчуванням, інакше `effect`. (3) Перехід змінює свою колонку лише у своєму напрямку: змінена колонка під дією з `from`/`to` — лише `OLD = from` і `NEW = to`. (4) **Некореневі рядки** таблиці з колонками переходів у контексті будь-якої команди (контекст є, рядок не кореневий цього об'єкта) перевіряються за ефектами природної дії: `UPDATE` — шапка природної `update` (без колонок переходів), `INSERT` — правило (2). (5) Кастомна дія, чий `effects.header` називає колонку переходу, — помилка `rights.custom-action-effects` з `reason: "transitionColumn"` на `/customActions/<i>/effects/header/<j>` (колонки переходів — з `transition` стандартних дій виду, без гілки за видом) | інакше `update`/`create` проводили б чи позначали б рядок без права `post`/`markDeletion`, `post` розпроводив би без `unpost`, команда над A проводила б B під природним `update`, а кастомна дія була б обхідною дорогою | спека прав §3 — напрям переходу як факт реєстру й заборона колонок переходів у кастомних діях; §5.3 — шапка `update` без колонок переходів, перехід лише у своєму напрямку, тригер перевіряє й некореневі рядки за природною дією (Задача 0) |
| Р2b1-19 | **Межа довіри контексту** (F1 аудиту Codex, рішення архітектора). Контекст ставить `runCommand`; TS-код із сирим SQL у транзакції команди — у домені довіри `runCommand` (може й `RESET ROLE`), тож захист від підміни контексту там — API хуків П4 (хуки без сирого SQL і без `SET`/`RESET`/`set_config`), а не база. SQL застосунку, що виконується в базі посеред DML команди, контексту не змінює: функція закритого SQL-модуля будь-якого виду (`sqlModule: "closed"` — обробники підписок `EventSubscription` і функції модуля об'єкта М5) з `set_config` з першим аргументом-літералом на `simetra.` чи з нелітеральним першим аргументом, з оператором `SET`/`RESET` на `simetra.*` чи `RESET ALL`, або з опцією функції `SET simetra.…` — помилка `sql.command-context-write` (`{ name, form: "setConfig" \| "setStatement" \| "functionOption" \| "nonLiteral" }`). Динамічний SQL у закритому модулі вже відмовлено (`closedFormProblem` → `dynamicSql`, `compiler/sql/closed-forms.ts`), тож нелітеральний текст `EXECUTE` окремої перевірки не потребує. Борговий SQL `CustomTable` (`sqlModule: "debt"`) поза перевіркою — відоме обмеження до заборони дослівних тригерів на таблицях виду (2c) | обробник підписки спрацьовує посеред оператора команди, і змінений ним GUC побачили б політики наступних рядків і операторів | спека прав §5.3 — межа довіри контексту й заборона для SQL застосунку; спека промоції §9.3 — заборона в переліку для обробника (Задача 0) |
| Р2b1-19a | **Межа довіри контексту — розширення** (рішення архітектора 2026-10-24). SQL застосунку (функції закритих модулів, обробники й функції спільних SQL-файлів, крім боргового SQL прийнятих таблиць `CustomTable`) не змінює налаштувань `simetra.*` у жодній формі: `set_config`, `SET`/`RESET`, опція функції, запис у `pg_settings` (форма `settingsTable`: `UPDATE`/`INSERT`/`DELETE` над `pg_settings` чи `pg_catalog.pg_settings`, незалежно від `WHERE`), літеральний динамічний SQL (`EXECUTE '…'` розбирається й судиться як звичайний SQL); нелітеральний — у закритих модулях і обробниках заборонено (`dynamicSql`), у боргових функціях спільних файлів — відоме обмеження до 2c | функція закритого модуля чи обробник може викликати допоміжну функцію спільного `sql/`-файлу; `UPDATE pg_settings` проходить правилом подання в `set_config`, а ім'я налаштування в `WHERE` надійно не перевірити; прийом реальних баз з борговим динамічним SQL не ламається, а `rewrite.dynamic-sql-unscoped` промоції лишається попередженням | спека прав §5.3 — речення про SQL застосунку замінено текстом цього рішення |
| Р2b1-20 | Колонка скоупу основної таблиці й ТЧ, як і ключ `ref`, незмінна за будь-якої дії й для будь-якого рядка: `OLD.<скоуп> IS DISTINCT FROM NEW.<скоуп>` на `UPDATE` — `effect`; на `INSERT` не порівнюється (`OLD` немає) — вставка під `create` і рядки ТЧ не відмовляють через колонку скоупу. Незмінні колонки — одне джерело (те саме правило, що для ключа `ref`), не окремий перелік | перенесення між тенантами — не правка змісту, а складені FK скоупу ТЧ і копій однаково не дали б зробити його цілісно; якщо знадобиться — окремий механізм зі спекою, не `update` (рішення архітектора) | спека прав §5.3 — «колонка скоупу, як і ключ `ref`, незмінна за будь-якої дії» |
| Р2b1-19b | **Захищені налаштування сесії й заборона зміни ролі** (рішення архітектора 2026-10-24). Перелік у T0 (`PROTECTED_SESSION_SETTINGS`): префікси `simetra.` і `request.jwt.` (claims `SESSION_CLAIMS_SETTING` і стара форма `request.jwt.claim.*`), імена `role` і `session_authorization`; `command-context.ts` судить за ним усіма формами Р2b1-19a, код — `sql.command-context-write`. Зміна ролі (`SET ROLE`, `RESET ROLE`, `SET`/`RESET SESSION AUTHORIZATION`, `set_config('role' \| 'session_authorization', …)`, опція функції `SET role`) — та сама форма `setStatement`/`setConfig`/`functionOption`: розбирач дає `VariableSetStmt` з цими іменами, окремої форми немає. Обробник підписки й функція множини судяться й у модулі боргу `CustomTable` | claims визначають користувача в політиках запису — підміна сильніша за `simetra.command`; `RESET ROLE` стане обходом, коли в П4 розшириться членство `simetra_runtime`; легітимної причини в SQL застосунку немає | спека прав §5.3 — речення про SQL застосунку: налаштування сесії платформи — `simetra.*`, claims (`request.jwt.*`) і роль |
| Р2b1-21 | `maxWorkers: "50%"` в обох `vitest.config.ts` (`simetra`, `@simetrajs/designer`) | інфраструктура прогону, а не поведінка: паралельний `pnpm test` двох пакетів разом зі збіркою переплачував за ядра й падав на 5-секундних таймаутах щоразу в інших тестах; DB-проєктів не зачіпає (`fileParallelism: false`); відкат — один рядок | немає |
| Р2b1-22 | **`sql.command-context-write` судить кожну одиницю SQL застосунку**, не лише класи `FUNCTION_CLASSES`: усі одиниці спільних `sql/`-файлів і модулів видів, зокрема прийнятий борг спільних файлів; поза перевіркою — лише борговий SQL `CustomTable` (з винятком для обробників і функцій множин). Механізм один — обхід дерева одиниці (`treeWrite`): опції `ALTER FUNCTION/PROCEDURE/ROUTINE … SET` — форма `functionOption` (до загального обходу), подання, домени (CHECK), політики, значення параметрів за замовчуванням. Вбудований `set_config` — останнє ім'я `set_config` і одна частина або `pg_catalog` перед ним (до трьох частин: `<база>.pg_catalog.set_config`). Агрегат, опція якого (`sfunc`, `finalfunc`, `combinefunc`, `serialfunc`, `deserialfunc`, `msfunc`, `minvfunc`, `mfinalfunc`) називає вбудований `set_config`, — `nonLiteral`. Подання, що читає `pg_settings` (без схеми чи `pg_catalog`), — `settingsTable`; читання `pg_settings` у тілах функцій дозволене. Тіла мов поза `sql`/`plpgsql` не розбираються — відоме обмеження разом із нелітеральним `EXECUTE` | доказ на стеку (архітектор): `postgres.pg_catalog.set_config(…)` змінює налаштування під роллю `postgres`; `CREATE AGGREGATE … (SFUNC = pg_catalog.set_config, STYPE = text, INITCOND = <налаштування>)` ставить його; `UPDATE` подання над `pg_settings` змінює налаштування; усе це компілювалося без діагностики | спека прав §5.3 — речення про SQL застосунку: кожна одиниця, будь-яка допустима кваліфікація `set_config`, подання над `pg_settings`, тіла інших мов — обмеження |
| Р2b1-23 | Кастомна дія, чий `effects.header` називає незмінну колонку (ключ `ref` основної таблиці), — `rights.custom-action-effects` з причиною `immutableColumn`, як `transitionColumn`. Колонку скоупу шапка назвати не може: у кореня виду скоупу вона і є `ref`, а власну колонку скоупу платформа додає без імені елемента (`rights.attribute-unknown`) | `header: ["ref"]` компілювався мовчки, а тригер ефектів однаково відмовляв: декларація тихо нічого не давала | спека прав §5.3 і §6.2 — причина `immutableColumn` у переліку відмов ефектів кастомної дії |
| Р2b1-16 | Відхилення від обмеження 2a1 «`GRANT simetra_command TO …` не виконує ніхто» — лише в транзакції DB-тесту з відкатом (Р2b1-13): згенерований SQL і інструменти його й далі не дають (тест `generated SQL never manages the command role itself`) | DB-сценарій запису неможливий без членства з `SET` | немає |

## Відомі обмеження

- Створення кореня скоупу (`<корінь>` з `assignedOn` рівня скоупу) політика
  `create` не пропускає: множина скоупів нового тенанта не містить; межу нового
  тенанта дає `rootCreator` у П4 (Рх19).
- Обробник `beforeWrite`, що під `post`/`markDeletion` змінює іншу колонку
  шапки кореня, дає відмову (Р2b1-10).
- Дослівний тригер на таблиці виду ще не заборонено (2c): він бачить запис
  команди, як і раніше.
- Підміна контексту кодом із сирим SQL у транзакції команди (TS-хук) базою не
  закривається: такий код у домені довіри `runCommand` (може й `RESET ROLE`);
  захист — API хуків П4 (Р2b1-19). Борговий SQL `CustomTable` перевірка
  `sql.command-context-write` не охоплює.
- Нелітеральний динамічний SQL функцій спільних файлів (борг прийнятих баз) і
  тіла функцій мовами поза `sql`/`plpgsql` у спільних файлах (перевірка їх не
  розбирає, Р2b1-22) можуть змінити `simetra.*`, якщо їх викличе код у
  транзакції команди; закриття — 2c (заборона дослівних тригерів на таблицях
  виду й аналіз викликів із закритих модулів і обробників) разом з API хуків П4.
- Гранти DML ролі команд, `simetra_runtime`, `runCommand`, `authorize` і
  мапінг `42501` → `command.forbidden` — П4; запобіжники §7, версії й журнал
  прав — 2c; гейт планів і бенчмарк — 2d.

## Review Focus

1. **Дія команди на чужому рядку:** команда `markDeletion` над T1 пише T2 — потрібне `update` на T2, а не `markDeletion`. Тест — Задача 6 (`rest-needs-natural`).
2. **Права переходу не обходяться:** `update`/`create` не проводять і не позначають рядок, `post` не розпроводить, команда над A не проводить B (Р2b1-18). Тест — Задача 6 (`update-cannot-post`, `create-cannot-post`, `post-cannot-unpost`, `rest-cannot-post`).
3. **Обсяг дії, а не `update`:** роль з `update@any` і `post@own` не проводить чужу задачу, хоч оновити її може. Тест — Задача 6 (`post-extent`).
4. **Запис без контексту:** будь-який DML ролі команд без `simetra.command` — `42501`, зокрема на регістрі без кореневої родини. Тест — Задача 6 (`no-context`).
5. **Зміна лише копій під дією без ТЧ:** кастомна дія `reassign` (шапка `assignee`, без ТЧ) змінює носій — поширення в ТЧ кореня проходить. Тест — Задача 6 (`copy-only`).
6. **Видалення документа з рядками ТЧ:** дія `delete` видаляє корінь, каскад ТЧ проходить. Тест — Задача 6 (`delete-cascade`).

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/model/schemas/project.ts` | `COMMAND_SETTING`, `CommandContext` |
| `packages/simetra/src/model/kinds/actions.ts` | `KindAction.natural` |
| `packages/simetra/src/compiler/contracts.ts`, `compiler/rights/contracts.ts` | `RightsAction.natural`, `uniformExtents` |
| `packages/simetra/src/compiler/rights/command-units.ts` (новий) | генератор `command` |
| `packages/simetra/src/compiler/sql/closed-forms.ts` | `sql.command-context-write` |
| `packages/simetra/src/compiler/rights/predicates.ts` | `COMMAND_ACTION` |
| `packages/simetra/src/compiler/access-units.ts` | політики запису й запобіжник контексту |
| `packages/simetra/src/compiler/mechanics-units.ts` | `contentColumns` |
| `packages/simetra/src/compiler/rights/effects-units.ts` (новий) | генератор `effects` |
| `packages/simetra/src/compiler/{sql/units,pipeline}.ts` | генератори `command`, `effects` |
| `packages/simetra/src/schema/reverse/units.ts`, `schema/apply/promotion/replacements.ts` | одиниці ефектів — платформні |
| `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` | шари `writeRoles()`, `writableRegister()` |
| `packages/simetra/test/db/connection.ts` | `commandAs` |
| `packages/simetra/test/db/rights-write.db.test.ts` (новий) | DB-сценарій запису |
| `packages/designer/skills/simetra-metadata/SKILL.md` | запис командою, ефекти |

Шари фікстури (`fixtures/rights.ts`, поверх `policyDomain()`):

- `writeRoles(): Layer` — кастомна дія `reassign` на `Task` (`requires: ["read"]`, ефекти `{ dml: ["update"], header: ["assignee"], tabularSections: false }`); роль `TaskWriter` (`scopeKind: "org"`): `read`, `create`, `update`, `delete`, `reassign` на `Task` і `read`, `update` на `TaskComment` — `any`, `post` на `Task` — `own`; роль `TaskMarker` (`scopeKind: "org"`): `read`, `markDeletion` на `Task` — `any`; довідник `Bulletin` (`scope: "org"`, `publicRead: "authenticated"`, реквізит `text`), на який `TaskWriter` має `read`, `create`, `update` — `any`; роль `ProjectWriter` (`assignedOn: { container: Project }`): `read`, `create`, `update` на `Task` — `any` (предикат контейнера не містить умови скоупу, тож лише на ньому мутація межі тенанта 2a2 дає інший результат). Експорти `TASK_WRITER_ID`, `TASK_MARKER_ID`, `PROJECT_WRITER_ID`, `REASSIGN_ACTION_ID`, `BULLETIN_TABLE`.
- `writableRegister(): Layer` — незалежний регістр відомостей `RegionNotes` (`scope: "org"`, вимір `region` → `Region`, ресурс `note`, `access: [{ attribute: "region", dimension: "region" }]`) і власна роль `RegionWriter` (`scopeKind: "org"`): `read`, `write` на `RegionNotes` з обсягом виміру `region` (шар самодостатній: `withRoles` зливає файли поверхнево, тож умовного `include` між шарами бути не може). Експорти `REGION_NOTES_TABLE`, `REGION_WRITER_ID`.
- `globalConstant(): Layer` — нескоуплена константа `Rate` (`scope: "none"`, значення `Numeric`) і грант `read`, `update` на неї в глобальній ролі `Support`. Експорт `RATE_TABLE`.

---

### Задача 0: правки спек

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§3, §5.2, §5.3, §6.2), `docs/superpowers/specs/2026-10-06-promotion-design.md` (§9.3)
- Modify: `docs/superpowers/plans/2026-10-18-rights-2a2-read-policies-carriers.md` (Р2a2-3), `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` (§5)
- Modify: `docs/superpowers/plans/2026-10-18-rights-2a1-command-role-functions.md` (таблиця рішень)

- [x] **Step 1:** §3 — після речення про ефекти: «колонки, які називає шапка дії-переходу (`posted` — `post`/`unpost`, позначка видалення — `markDeletion`), належать переходу; напрям переходу (`post` — `false → true`, `unpost` — `true → false`; `markDeletion` — в обидва боки) — факт реєстру; кастомна дія не називає колонок переходів»; далі «природна дія за DML — факт реєстру: природні дії (`create`, `update`, `delete`, `write`) покривають DML своїх ефектів (`update` довідника й документа — оновлення, константи — вставку й оновлення; `write` регістра — усі три); рядок ТЧ — природна дія власника для оновлення».
- [x] **Step 2:** §5.3:
  - перше речення: дописати «значення — JSON `{"action", "object", "root"}`; розбирає його лише платформа: `simetra.command_action()` і `simetra.command_root(<мітка>)` (порожнє чи зіпсоване — відмова `42501`) і безвиняткова `simetra.command_current()` для тригера ефектів»;
  - пункт про кореневий рядок: «політики запису — дві родини: кореневий рядок (`<ключ> = command_root(<мітка>)`) — право дії команди; решта рядків — право природної дії за DML (замість «`INSERT` → `create`, `UPDATE` → `update`, `DELETE` → `delete`» — природна дія реєстру); ТЧ — за колонкою власника з міткою власника; таблиця без ключа `ref` (регістр, константа) — лише природна дія»;
  - речення «Платформні колонки механіки (`version`, `updated_at`, аудит) пише платформа за будь-якої дії» — замінити на «Платформні колонки механіки (`version`, `updated_at`) пише платформа за будь-якої дії; авторство (`created_by`, `updated_by`) стане механікою з примушеною механікою авторства П4, а до того його зміна під дією-переходом — відмова тригера ефектів» (Р2b1-15);
  - пункт про ефекти, на початку: «шапка `update` і `create` — уся шапка, крім колонок переходів; вставка рядка — колонки переходів зі значенням за замовчуванням; перехід змінює свою колонку лише у своєму напрямку; тригер перевіряє й некореневі рядки — за ефектами природної дії»; далі «тригер платформи (`AFTER`, тож бачить рядок після всіх `BEFORE`-тригерів; функція `SECURITY DEFINER`, що повз RLS читає лише існування власника рядка ТЧ) відхиляє решту, зокрема DML поза ефектами дії й зміну обробника `beforeWrite`; зміна лише копій носіїв і колонок механіки — не дія»;
  - пункт «порожнє чи відсутнє `simetra.command` — відмова»: дописати «(`RESTRICTIVE`-політики `<t>_command_*`)».
- [x] **Step 3:** §6.2 — після переліку кодів причини: «тригер ефектів відмовляє `42501` з `MESSAGE 'command.forbidden'` і `DETAIL 'effect'`, без даних рядка; рядок ТЧ кореня під дією без запису ТЧ видаляється лише каскадом — коли рядка власника вже немає; окремий рядок ТЧ живого документа — відмова `effect`».
- [x] **Step 2a:** §5.3 — новий пункт: «контекст ставить `runCommand`; код із сирим SQL у транзакції команди — у домені довіри `runCommand` (може й `RESET ROLE`), тож захист від підміни контексту там — API хуків П4 (хуки без сирого SQL і без `SET`/`RESET`/`set_config`); SQL застосунку в базі (обробники підписок, функції SQL-модуля) налаштувань `simetra.*` не змінює — помилка компілятора». Спека промоції §9.3, речення про те, чого обробник `beforeWrite` не присвоює, — дописати «і не змінює налаштувань `simetra.*` (`set_config`, `SET`/`RESET`, опція функції), спека прав §5.3».
- [x] **Step 3a:** §5.2, пункт про межу тенанта — речення про `publicRead`: дописати «політика читання всіх рядків `<t>_public_read` — для ролей API за `publicRead` і для ролі команд, що діє від імені користувача». План 2a2, рядок Р2a2-3 — дописати «(уточнено Р2b1-17: `<t>_public_read` — і для ролі команд)». Борг `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` §5 — рядок «**Механіка авторства** (П4): примушене `updated_by` переходить у перелік механіки (`mechanicsStandardNames`), тож тригер ефектів 2b1 перестає рахувати його зміною (Р2b1-15)».
- [x] **Step 4:** План 2a1, таблиця рішень — новий рядок після Р2a1-17: «Р2a1-17a | `rightsPredicates` приймає й дію контексту `COMMAND_ACTION` (план Права-2b1, Р2b1-5, Р2b1-6) | немає».
- [x] **Step 5:** Run: `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [x] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-17-rights-design.md docs/superpowers/specs/2026-10-06-promotion-design.md docs/superpowers/plans/2026-10-18-rights-2a1-command-role-functions.md docs/superpowers/plans/2026-10-18-rights-2a2-read-policies-carriers.md docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md
git commit -m "docs(spec): контекст команди, політики запису двох родин і тригер ефектів"
```

---

### Задача 1: природна дія й єдиний набір обсягів

**Files:**
- Modify: `packages/simetra/src/model/kinds/actions.ts`, `model/schemas/project.ts`, `model/schemas/index.ts`, `compiler/contracts.ts`, `compiler/rights/contracts.ts`, `compiler/rights/checks.ts`, `compiler/messages.ts` (текст причини `transitionColumn` en/uk)
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` (шари `writableRegister()`, `globalConstant()`)
- Test: `packages/simetra/src/compiler/__tests__/rights-contract.test.ts`

**Interfaces:**
- Produces: `KindAction.natural?: true`; `KindAction.transition?: { column: string; from?: boolean; to?: boolean }`; `RightsAction.transition?`; `RightsContract.transitions: { column: string; default: string }[]`; причина `transitionColumn` коду `rights.custom-action-effects`; шари фікстури `writableRegister(): Layer`, `globalConstant(): Layer`; `RightsAction.natural: Dml[]`; `uniformExtents(actions: readonly RightsAction[], label: string): RightsExtent[]`; T0 `COMMAND_SETTING: "simetra.command"`, `interface CommandContext { action: string; object: string; root: string }`.

- [x] **Step 1: Write the failing tests (unit)** у `rights-contract.test.ts`:
  - `it.each` над контрактами `policyDomain(writableRegister(), globalConstant())`: `Task` — `natural` у `create`/`update`/`delete` — `["insert"]`/`["update"]`/`["delete"]`, у `markDeletion`, `post`, `read` — `[]`; `RegionNotes` — `write.natural` = `["insert", "update", "delete"]`; `Rate` — `update.natural` = `["insert", "update"]`.
  - `it("every object's actions share one extent set")`: для кожного контракту `kitchenSink()` і `policyDomain(writableRegister(), globalConstant())` `uniformExtents(c.actions, c.kindLabel)` повертає `c.actions[0].extents`, а кожна дія має рівно його.
  - `it("transition columns belong to their transitions")` над `policyDomain()`: `Task` — `post.transition` = `{ column: "posted", from: false, to: true }`, `unpost` — навпаки, `markDeletion` — `{ column: "deletion_mark" }`; `transitions` = `[{ column: "deletion_mark", default: "false" }, { column: "posted", default: "false" }]`; `update.effects.header` і `create.effects.header` — явний перелік колонок шапки без `posted` і `deletion_mark` (не `"all"`). Мутація: лишити `"all"` — тест червоніє.
  - `it("a custom action may not name a transition column")`: `customActions` на `Task` з `effects.header: ["posted"]` → `rights.custom-action-effects` з `reason: "transitionColumn"` на `/customActions/0/effects/header/0`. Мутація: прибрати перевірку — тест червоніє.
  - `it("uniformExtents refuses differing extent sets")`: дві дії з `[{ form: "any" }]` і `[{ form: "any" }, { form: "own" }]` → кидає `internal: rights actions of x differ in extents`.
- [x] **Step 2:** Run: `pnpm --filter simetra test rights-contract` — FAIL.
- [x] **Step 3: Implement:** `transition` у `postAction`, `unpostAction`, `markDeletionAction`; `canonicalHeader` розгортає `"all"` за Р2b1-18; перевірка кастомної дії — поруч із `noWrite`/`noTabularSections` у `compiler/rights/checks.ts`; `natural: true` у `createAction`, `updateAction`, `deleteAction`, `writeAction`; копіювання в `RightsAction` (`compiler/rights/contracts.ts`, поруч із `effects`), у кастомних — `[]`; перевірка «щонайбільше одна природна дія на DML» — `must`-подібна внутрішня помилка при побудові контракту; `uniformExtents` викликається й тут (контракт не будується з різними наборами). T0 сталі поруч із `PLATFORM_ROLES`, реекспорт. Коментар «чому» біля `natural` — Р2b1-7.
- [x] **Step 4:** Run: `pnpm --filter simetra test rights-contract rights-expand explain contracts` — PASS; точні очікування контрактів змінюються лише полями `natural`, `transition`, `transitions` і явним переліком шапки замість `"all"` у дій з `"all"`.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(model): природна дія за DML у реєстрі й єдиний набір обсягів дій"
```

---

### Задача 2: генератор контексту команди

**Files:**
- Create: `packages/simetra/src/compiler/rights/command-units.ts`
- Modify: `packages/simetra/src/compiler/sql/units.ts` (`UnitGenerator` — `"command"`, `FIXED_BODY.command = true`), `compiler/pipeline.ts` (`sqlUnits`, `describeGenerated`)
- Test: `packages/simetra/src/compiler/__tests__/command-units.test.ts` (новий), `creation-order.test.ts`

**Interfaces:**
- Consumes: `COMMAND_SETTING`, `PLATFORM_ROLES`, `executeGrants`, `hasRightsFunctions`, `generatedUnit`.
- Produces: `COMMAND_FUNCTIONS: { parsed: QualifiedName; action: QualifiedName; root: QualifiedName; current: QualifiedName }` (схема `simetra`); `buildCommandUnits(contracts: Pick<Contracts, "rights" | "roles" | "users">, provider: DatabaseProvider, module: string, parse: SqlParser): SqlUnit[]`.

- [x] **Step 1: Write the failing tests (unit)** `command-units.test.ts`:
  - `it("renders no command functions without rights functions")`: `rightsFiles()` → жодної одиниці `generator: "command"`.
  - `it("declares the command functions closed, invoker and for the command role only")` над `withRoles()`: ідентичності — `simetra.command_parsed(boolean)`, `command_action()`, `command_root(text)`, `command_current()`; дерево кожної — `LANGUAGE plpgsql`, `STABLE`, без `SECURITY DEFINER`, опція `search_path = ''`; гранти — `REVOKE … FROM PUBLIC` і ролей API, `GRANT EXECUTE … TO "simetra_command"` і нікому іншому.
  - `it("refuses a context with an unknown object action")` над `policyDomain(writeRoles())`: тіло `command_parsed` має сталу множину пар (`object`, `action`) — рівно дії з непорожнім `effects.dml` контрактів прав (зокрема `('task', '<UUID reassign>')`, без `('task', 'read')`), і гілку `RAISE` з `DETAIL 'unknown-action'`.
  - `it("parses the setting once")`: `current_setting(<COMMAND_SETTING>, true)` є лише в тілі `command_parsed`; інші три кличуть `simetra.command_parsed` (`true` у суворих, `false` у `command_current`).
  - `creation-order.test.ts`: `command_parsed` створюється раніше за три поверхні.
- [x] **Step 2:** Run: `pnpm --filter simetra test command-units creation-order` — FAIL.
- [x] **Step 3: Implement** `command-units.ts` за зразком plpgsql-функцій `carrier-units.ts` і `touchFunction` (`mechanics-units.ts`), не `closedFunction` (та дає лише `LANGUAGE sql`), з `dollarTag`; гранти — `executeGrants`. Кожна поверхня має `requires: [{ type: "unit", identity: "function:simetra.command_parsed(boolean)" }]` (граф створення тіл plpgsql не читає, а сортування за ідентичністю поставило б поверхні раніше). Тіло `command_parsed`: `current_setting(…, true)`; `NULL` чи `''` — суворий `RAISE` (`DETAIL 'missing'`) / безвиняткова повертає `NULL`; не об'єкт JSON, ключі ≠ рівно три, порожні `action`/`object`, `root` не UUID — `RAISE` (`DETAIL 'malformed'`) в обох (Р2b1-2). Підключити в `sqlUnits` після `rights`.
- [x] **Step 4:** Run: `pnpm --filter simetra test command-units creation-order platform-layer function-execute` — PASS; DB-гейти, що бачать нові одиниці на базі: `pnpm --filter @simetrajs/designer exec vitest run --project db engine-desired-corpus engine-extract round-trip` і `pnpm --filter simetra exec vitest run --project db reference-domain rights-policies` (або CI `db`) — PASS.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): функції контексту команди в схемі simetra"
```

---

### Задача 2a: SQL застосунку не змінює контексту команди

**Files:**
- Modify: `packages/simetra/src/compiler/sql/closed-forms.ts` (`checkSqlModules`), `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/closed-forms.test.ts` , `messages.test.ts`

**Interfaces:**
- Produces: код `sql.command-context-write` (`{ name: string; form: "setConfig" | "setStatement" | "functionOption" | "nonLiteral" }`), en/uk.

- [x] **Step 1: Write the failing test (unit)** — `it.each` над модулем обробника підписки (будівник підписки з `event-subscriptions.test.ts`) і над функцією модуля документа (М5), форма → очікування:

| form | тіло | код |
| --- | --- | --- |
| `setConfig` | `PERFORM set_config('simetra.command', '{}', true);` | `sql.command-context-write` |
| `setConfig` (кваліфікований, регістр) | `PERFORM pg_catalog.set_config('Simetra.Command', '{}', true);` | те саме |
| `nonLiteral` | `PERFORM set_config(v_name, '{}', true);` | те саме |
| `setStatement` | `SET LOCAL simetra.command = '{}';`, `RESET simetra.command;`, `RESET ALL;` | те саме |
| `functionOption` | `CREATE FUNCTION … SET simetra.command = '{}' AS …` | те саме |
| — | `PERFORM set_config('app.x', '1', true);`, `SET LOCAL statement_timeout = '1s';` | нічого |

  Плюс функція мовою `sql` з `SELECT set_config('simetra.command', …)` — той самий код. Мутація: прибрати перевірку `FuncCall` — рядки `setConfig` і `nonLiteral` червоніють; прибрати перевірку `VariableSetStmt` — рядки `setStatement`.
- [x] **Step 2:** Run: `pnpm --filter simetra test closed-forms event-subscriptions messages` — FAIL.
- [x] **Step 3: Implement** у `checkSqlModules` для кожної функції закритого модуля: обхід дерев виразів plpgsql (`PlpgsqlStatement.expressions` ролей, крім `dynamic`, — той самий обхід, що `copyReads` у `stages/links.ts`, Р2a2-9) і тіла функції `sql`: `FuncCall` з ім'ям `set_config` (з чи без `pg_catalog`) — перший аргумент `A_Const` рядок, що без урахування регістру починається з `simetra.`, → `setConfig`; не `A_Const` → `nonLiteral`; `VariableSetStmt` з ім'ям на `simetra.` чи `VAR_RESET_ALL` → `setStatement`; опції `CREATE FUNCTION` `SET` (`VariableSetStmt` у `options`) на `simetra.` → `functionOption`. Коментар «чому» — Р2b1-19.
- [x] **Step 4:** Run: `pnpm --filter simetra test closed-forms event-subscriptions messages stage-links && pnpm metadata:check` — PASS (примірні застосунки контексту не змінюють).
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): SQL застосунку не змінює налаштувань simetra.* контексту команди"
```

---

### Задача 3: політики запису двох родин і запобіжник контексту

**Files:**
- Modify: `packages/simetra/src/compiler/rights/predicates.ts`, `compiler/access-units.ts`
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` (шар `writeRoles()`)
- Modify: `packages/simetra/test/db/access.db.test.ts` (тест `every read policy plans its sets once` бере в очікувані лише політики `FOR SELECT` — за деревом, а не за переліком імен; інакше нові політики запису потрапили б у порівняння з `pg_policies WHERE cmd = 'SELECT'`)
- Test: `packages/simetra/src/compiler/__tests__/access-units.test.ts`, `rights-predicates.test.ts`, `creation-order.test.ts`

**Interfaces:**
- Consumes: `COMMAND_FUNCTIONS` (Задача 2), `uniformExtents`, `RightsAction.natural` (Задача 1).
- Produces: `COMMAND_ACTION: unique symbol` (експорт `predicates.ts`); `rightsPredicates(contract, action: string | typeof COMMAND_ACTION, table, main?)`; `accessPolicyNames(table)` додає `commandInsert`, `commandUpdate`, `commandDelete`, `write(dml, family, label)` (Р2b1-11).

- [x] **Step 1: Write the failing tests (unit):**
  - `rights-predicates.test.ts`: `it("the command action renders the context action, uncorrelated")` — для `Task` предикати з `COMMAND_ACTION` мають ті самі обсяги й носії, що з `"update"`, а в кожній умові з функцією прав перший аргумент — `(SELECT "simetra"."command_action"())`; правило §5.4 (2a1) — і над цими предикатами.
  - `access-units.test.ts` над `policyDomain(writeRoles(), writableRegister())`:
    - `it("guards every write command with the context")`: на `task`, `task_checklist`, `region_notes` — рівно `CREATE POLICY task_command_insert ON public.task AS RESTRICTIVE FOR INSERT TO simetra_command WITH CHECK ((SELECT "simetra"."command_action"()) IS NOT NULL);` і відповідні `_update` (`USING` і `WITH CHECK`) та `_delete` (`USING`) — цілі оператори.
    - `it("binds the root row to the command action and the rest to the natural one")`: на `task` для кожного предиката `rightsPredicates(Task, COMMAND_ACTION)` — `task_update_root_<мітка>` `PERMISSIVE FOR UPDATE TO simetra_command USING ("id" = (SELECT "simetra"."command_root"('task')) AND <умови>) WITH CHECK (той самий вираз)`, а для кожного предиката `rightsPredicates(Task, "update")` — `task_update_rest_<мітка>` з `"id" IS DISTINCT FROM (…)`; `INSERT` — `rest` за `create`, `DELETE` — за `delete`.
    - `it("a tabular section binds to its owner")`: `task_checklist` — умови родини за `parent_id` з міткою `task`; `rest` на всі три команди — за `update` власника.
    - `it("a register writes by its natural action without a root family")`: `region_notes` — лише `region_notes_<dml>_rest_*` за `write`, без `command_root`; похідні таблиці `TaskHours` — жодної політики запису.
    - `it("public read opens rows to the command role too")` (Р2b1-17): `bulletin` — рівно `CREATE POLICY bulletin_public_read ON public.bulletin AS PERMISSIVE FOR SELECT TO authenticated, simetra_command USING (true);`; межі запису `bulletin_scope_*` і політики запису — є, `bulletin_scope_read` і `bulletin_read_*` — немає; з `publicRead: "anon"` — `TO anon, authenticated, simetra_command`; у проєкті без функцій прав роль команд у `public_read` теж є (читання від імені користувача від прав не залежить).
    - `it("a constant has no root family")` — і над скоупленою константою референсного домену (`DefaultCurrency`, ключ — колонка скоупу): жодного `command_root` на `default_currency`; над `policyDomain(globalConstant())`: `rate` — лише `rate_insert_rest_*` і `rate_update_rest_*` за природною `update` (`natural` = `["insert", "update"]`), без `command_root` і без `rate_delete_*` (Р2b1-4, Р2b1-7).
    - `it("no write policies without rights functions or write actions")`: `rightsFiles()` — жодної `_command_*` і `_<dml>_*`; системні довідники прав (лише `read`) — жодної.
    - наявний тест довжини імен (`policy names of a 60-byte table stay within 63 bytes`) — і над `commandInsert…` і `write(…)`, зокрема `update_root_in_<60-байтний контейнер>_own`; ідентичності політик таблиці не дублюються.
  - `creation-order.test.ts`: ребро `simetra.command_root(text)` → `policy:public.task.task_update_root_any`.
  - наявні тести `access-units.test.ts` з точним переліком політик таблиці — `rights read policies come from the predicate builder` (`task`) і `public read keeps write scope policies and has no rights read` (`task`, `task_checklist`) — фільтрують перелік до міток `_read_`/`_scope_`/`_public_read` (предмет цих тестів — читання); нові політики запису перевіряють тести вище.
- [x] **Step 2:** Run: `pnpm --filter simetra test access-units rights-predicates creation-order` — FAIL.
- [x] **Step 3a: Implement** Р2b1-17: `<t>_public_read` — ролі API за `publicRead` плюс `PLATFORM_ROLES.command`; наявні точні очікування `public_read` (`access-units.test.ts`, тести промоції доступу, знімки каталогу, якщо вони перелічують ролі політики) оновити в цьому ж коміті лише додаванням `simetra_command`.
- [x] **Step 3: Implement:** у `rightsPredicates` — гілка `COMMAND_ACTION`: обсяги — `uniformExtents(contract.actions, contract.kindLabel)`, `head[0]` — вираз контексту; у `buildAccessUnits` — для таблиці з контрактом прав, коли `rightsOn`, таблиця не похідна (`origin.part`) і в контракті є дія з непорожнім `effects.dml`: запобіжник Р2b1-3 і родини Р2b1-4 (ключ кореневої родини — за Р2b1-4: колонка стандартного реквізиту `ref`, коли саме вона — одноколонковий `primaryKey` основної таблиці, чи колонка власника ТЧ такої таблиці; інакше родини немає — зокрема в скоупленої константи, де одноколонковий ключ — колонка скоупу); природна дія — за `natural` (Р2b1-7). Коментарі «чому» — Р2b1-3, Р2b1-4 (некорельованість умови родини). Шари фікстури — за описом вище.
- [x] **Step 4:** Run: `pnpm --filter simetra test access-units rights-predicates creation-order platform-layer` і `pnpm --filter simetra exec vitest run --project db access` (або CI `db`) — PASS (`generated SQL never manages the command role itself` — без змін).
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler packages/simetra/test/db/access.db.test.ts
git commit -m "feat(compiler): політики запису ролі команд — кореневий рядок і природна дія"
```

---

### Задача 4: тригер ефектів дії

**Files:**
- Create: `packages/simetra/src/compiler/rights/effects-units.ts`
- Modify: `packages/simetra/src/compiler/mechanics-units.ts` (`contentColumns`), `compiler/sql/units.ts` (`"effects"`, `FIXED_BODY.effects = true`), `compiler/pipeline.ts`, `compiler/contracts.ts` (`derivedFunctions`: ім'я функції ефектів резервується з надлишком — для кожної основної таблиці з ключем `ref` (Р2b1-4) і її ТЧ, незалежно від наявності прав: `derivedFunctions` контрактів прав не бачить, а зайве резервування лише звужує простір імен)
- Test: `packages/simetra/src/compiler/__tests__/effects-units.test.ts` (новий), `mechanics-units.test.ts`, `creation-order.test.ts`

**Interfaces:**
- Consumes: `COMMAND_FUNCTIONS.current`, `RightsAction.effects`, `contentChangeCondition`, `carrierCopies`.
- Produces: `contentColumns(table: Pick<PhysicalTable, "columns">, attributeCase: AttributeCase): PhysicalColumn[]`; `effectsTriggerNames(table: QualifiedName): { all: string; update: string }` (`makeObjectName(table.name, undefined, "simetra_effects")` і `…"simetra_effects_update"`, як `carrierTriggerNames` — інакше довгі імена перевищили б 63 байти й Postgres мовчки обрізав би їх); `effectsFunctionName(table: QualifiedName): QualifiedName`; `buildEffectsUnits(contracts: Pick<Contracts, "rights" | "roles" | "users">, physical: PhysicalSnapshot, attributeCase: AttributeCase, provider: DatabaseProvider, module: string, parse: SqlParser): SqlUnit[]` (`provider` — для `executeGrants(…, [], provider)`: `REVOKE` від `PUBLIC` і ролей API).

- [x] **Step 1: Write the failing tests (unit)** `effects-units.test.ts` над `policyDomain(writeRoles(), writableRegister())`, перевірки — на дереві PL/pgSQL:
  - `it("checks the root row against the effects of the command action")`: функція `task` — виклик `simetra.command_current()`; ранній `RETURN NULL` лише коли дії немає; `object <> 'task'` — гілка природної дії; зміна `id` — `RAISE` за будь-якої дії; гілка на кожну дію `Task` (зокрема UUID `reassign`): дозволені `TG_OP` = `effects.dml`; для `markDeletion` — порівняння `OLD.<c> IS DISTINCT FROM NEW.<c>` рівно над `contentColumns(task)` без колонки позначки видалення (`created_by_id`, `updated_by_id` — у переліку: механіка їх не примушує, Р2b1-15); для `reassign` — без `assignee_id`; для `update` — над `posted`, `deletion_mark` і колонкою скоупу (незмінна, Р2b1-20) (шапка `update` — уся, крім колонок переходів, Р2b1-18); для `post` — перевірка напрямку `OLD.posted = false AND NEW.posted = true` при зміні; на `INSERT` — `NEW.posted` і `NEW.deletion_mark` проти `false`; гілка некореневого рядка (контекст іншого кореня чи об'єкта) — порівняння колонок переходів за природною `update`; гілка «інша дія» — `RAISE`.
  - `it("a tabular section follows its owner's effects, deletion cascades")`: функція `task_checklist` — `parent_id` проти `root`; `update` — дозволено на всі три DML; `create` — лише `INSERT` (`UPDATE`/`DELETE` рядка ТЧ — `RAISE`); `markDeletion`, `post`, `reassign`, `delete` — `RAISE`, крім `TG_OP = 'DELETE'` з `NOT EXISTS (SELECT 1 FROM <схема>.task WHERE org_id = OLD.org_id AND id = OLD.parent_id)` (пари — з `fieldForeignKey(task_checklist, "parent_id")`, кваліфіковане відношення).
  - `it("the effects function is a closed definer granted to nobody")`: дерево кожної функції — `SECURITY DEFINER`, опції `search_path = ''` і `row_security = off` (власник функції під RLS дав би гучну помилку замість тихого «власника немає», як `carrierBackfillRefusals` 2a2), `REVOKE EXECUTE` від `PUBLIC` і ролей API, жодного `GRANT EXECUTE`; єдине відношення в тілі — таблиця власника в `NOT EXISTS` (лише у функціях ТЧ). Мутація: прибрати умову скоупу з `NOT EXISTS` — тест форми вище червоніє.
  - `it("fires after the row is final and skips copy-only updates")`: на `task_comment` (з копіями) — `task_comment_simetra_effects` `AFTER INSERT OR DELETE` і `task_comment_simetra_effects_update` `AFTER UPDATE … WHEN (<contentChangeCondition(task_comment)>)`; на `task` — один `AFTER INSERT OR UPDATE OR DELETE`; кожен `FOR EACH ROW`.
  - `it("refuses with the effect code and no row data")`: кожен `RAISE` — `ERRCODE = '42501'`, `MESSAGE = 'command.forbidden'`, `DETAIL = 'effect'`; жодного `NEW.`/`OLD.` у `MESSAGE`, `DETAIL`, `HINT`.
  - `it("reads no flags, depth or current user")`: у тілах немає `current_setting`, `pg_trigger_depth`, `current_user`, `session_user`.
  - `it("no effects triggers on registers, constants or without rights functions")`: `region_notes`, похідні `TaskHours`, `rate` (`globalConstant()`), `rightsFiles()` — нічого; на `rate` — лише політики родини «решта» за природною `update` на `INSERT` і `UPDATE` і жодного `command_root`.
  - `it("effects function names collide like carrier functions")` (Р2b1-11) — `physical.function-duplicate`. Наявний тест `carrier-units.test.ts` `carrier function names collide like membership functions` (60-байтна `TaskComment` і її ТЧ) тепер дає дві колізії — носіїв і ефектів: очікування — два записи `["physical.function-duplicate", COMMENT_FILE, "/physicalName"]` у цьому ж коміті.
  - `mechanics-units.test.ts`: `it("content columns are one list for the condition and the effects")` — `contentChangeCondition(t)` будується рівно з `contentColumns(t)` (на `task_report` генерована колонка періоду поза переліком).
- [x] **Step 2:** Run: `pnpm --filter simetra test effects-units mechanics-units creation-order` — FAIL.
- [x] **Step 3: Implement** `effects-units.ts` за зразком `carrier-units.ts` (`generatedUnit`, `requires` — таблиця й `command_current`); `contentChangeCondition` переписати через `contentColumns`. Коментарі «чому»: `AFTER` — Р2b1-8 (незалежність від порядку); `WHEN` — зміна лише копій не дія; каскад ТЧ — Р2b1-9.
- [x] **Step 4:** Run: `pnpm --filter simetra test effects-units mechanics-units carrier-units subscription-units creation-order platform-layer` — PASS; DB-гейти, що бачать нові одиниці на базі: `pnpm --filter @simetrajs/designer exec vitest run --project db engine-desired-corpus engine-extract round-trip` і `pnpm --filter simetra exec vitest run --project db reference-domain rights-policies` (або CI `db`) — PASS.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): тригер дозволених ефектів дії команди"
```

---

### Задача 5: зворотна генерація й промоція впізнають нові одиниці

**Files:**
- Modify: `packages/simetra/src/schema/reverse/units.ts` (`platformTriggerFunction`, `isPlatformTrigger`), `schema/apply/promotion/replacements.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/promotion-removals.test.ts`, тест зворотної генерації поруч із розпізнавачем (`orient platformTriggerFunction`)

- [x] **Step 1: Write the failing tests (unit):**
  - зворотна генерація: `it("recognizes effects triggers and functions as platform")` — бажаний стан `policyDomain(writeRoles())` туди-назад не пише `<t>_simetra_effects`, `<t>_simetra_effects_update`, `<t>_simetra_effects()` і функцій `simetra.command_*` як дослівних одиниць; тригер з іменем `<t>_simetra_effects`, що кличе іншу функцію, — дослівний.
  - `promotion-removals.test.ts`: `it("an effects trigger is never a replacement of an adopted trigger")` — прийнятий тригер `AFTER INSERT OR UPDATE OR DELETE` на промотованій таблиці, що кличе функцію з іменем `<t>_simetra_effects()` (`triggerReplacement` інакше й так не зіставив би інших функцій), бажаний стан лише з тригером ефектів → `plan.platform-replacement-missing`; `it("write rights policies of the command role are listed under access")` — над `promotableTag()`/`tagMapping()` у пункті `access:<таблиця>` рядки форми `unitChanges` — `extra policy:public.tag.tag_update_root_any adds roles simetra_command` (Р2b1-12).
- [x] **Step 2:** Run: `pnpm --filter simetra test promotion-removals reverse-generate` — FAIL на нових кейсах розпізнавача (кейс `access` може пройти одразу — він фіксує наявну поведінку).
- [x] **Step 3: Implement** за Р2b1-12.
- [x] **Step 4:** Run: `pnpm --filter simetra test promotion-removals reverse-generate` — PASS.
- [x] **Step 5: Commit**

```bash
git add packages/simetra/src/schema
git commit -m "fix(schema): промоція й зворотна генерація впізнають тригер ефектів і функції контексту"
```

---

### Задача 6: DB-сценарій запису під роллю команд

**Files:**
- Create: `packages/simetra/test/db/rights-write.db.test.ts`
- Modify: `packages/simetra/test/db/connection.ts` (`commandAs`), `test/db/rights-seed.ts` (засів, якщо спільний з `rights-policies`)
- Modify: `packages/designer/src/schema-engine/__tests__/engine-desired-corpus.db.test.ts` (модель з новими одиницями — у корпус)

**Interfaces:**
- Produces: `commandAs<T>(client: pg.Client, claims: Record<string, unknown>, context: CommandContext | string | undefined, sql: string, options?: { params?: unknown[]; after?: string }): Promise<{ rows: T[]; after?: pg.QueryResultRow[] } | { code: string; message: string; detail?: string; column?: string }>` — точка збереження, `request.jwt.claims`, `set_config(COMMAND_SETTING, …, true)` (рядок — сирий, для кейсу зіпсованого; `undefined` — не ставити), перемикання ролі за обраним шляхом Р2b1-13, запит; `after` — запит власником (`RESET ROLE`) у тій самій точці збереження до відкату (каскад і поширення копій інакше не видно); відкат до точки збереження. Кількість змінених рядків — лише через `RETURNING id`.

Причина DB-рівня (шапка файлу): які рядки пише роль під RLS запису, що відхиляє тригер `AFTER` і як каскад ТЧ проходить тригер — вирішує Postgres.

- [x] **Step 1: Перевірити механізм ролі** (Р2b1-13): у транзакції опису, у точці збереження — `GRANT simetra_command TO CURRENT_USER WITH SET TRUE`; успіх — перший шлях; помилка — відкат точки й запасний шлях (тегова роль; він потребує того самого `ADMIN`, тож покриває лише заборону самопризначення); помилка й там — третій шлях: клієнт опису з `testSuperuserUrl()` (`test/db/connection.ts`); записати обраний у коментар опису.
- [x] **Step 1a: Перевірити два факти Postgres** (Р2b1-8, Р2b1-9), до кейсів, на розгорнутій моделі: (1) під час каскаду `DELETE FROM task WHERE id = T4` тимчасовий `AFTER DELETE`-тригер на `task_checklist`, що записує результат `EXISTS (SELECT 1 FROM task WHERE id = OLD.parent_id)` у тимчасову таблицю, дає `false` — власник уже не видимий; (2) функція `SECURITY DEFINER` бачить рядок `task`, якого роль `simetra_command` під своїми політиками читання не бачить. Обидва — у точці збереження з відкатом. **Якщо (1) дає `true` — стоп і звіт архітектору**, без кейсів далі.
- [x] **Step 2: Write the test** — один опис, одне розгортання (`describeTransaction`): компіляція `policyDomain(writeRoles(), writableRegister())`, `renderDesiredState`, розгортання, гранти Р2b1-13, засів власником: організації A, B; оголошення `Bulletin` `BA` (A) і `BB` (B); учасники `w1` (A, `TaskWriter` і `RegionWriter`), `w2` (A, `TaskMarker`), `w3` (B, `TaskWriter`), `w4` (A, лише `ProjectWriter` на `P1`), `w5` (`TaskWriter` і в A, і в B); проєкти `P1` (A), `PB` (B); задачі A у `P1`: `T1` (`assignee` = w2), `T2` (`assignee` = w1) з рядком `checklist`, `T5` (`assignee` = w1, `posted = true`), `T3` з рядками `checklist` і коментарем, `T4` з рядками `checklist` без коментарів (коментар тримає задачу FK `NO ACTION` — `23503` на видаленні), `T6` без посилань і залежних рядків; задача B `TB` у `PB`; регіони `r1`, `r2` (A) і рядок `MemberRegion` w1 → `r1`. Кейси — `commandAs(…)`, кожен у точці збереження:

| case | user, контекст | запит | очікування |
| --- | --- | --- | --- |
| `no-context` | w1, без контексту | `UPDATE task SET region_id = r2 WHERE id = T2`; `INSERT INTO region_notes (…, region_id = r1, …)` | `42501` `command.context`/`missing`; те саме |
| `malformed-context` | w1, `'{"action":"update","object":"task"}'` (бракує лише `root`); повний контекст з зайвим ключем `"x":1`; сирі `'not json'`, `'[1,2,3]'`, `'{"action":"update","object":"task","root":"x"}'` | `UPDATE task SET region_id = r2 WHERE id = T2` | `42501` `command.context`/`malformed` на кожен (не `22P02`/`22023` з глибини розбору) |
| `root-transition` | w2, `markDeletion/task/T1` | `UPDATE task SET deletion_mark = true WHERE id = T1 RETURNING id` | 1 рядок (`markDeletion` без `update`) |
| `rest-needs-natural` | w2, `markDeletion/task/T1` | `UPDATE task SET deletion_mark = true WHERE id = T2 RETURNING id` | 0 рядків (T2 — природна `update`, якої в w2 немає) |
| `rest-delete-needs-natural` | w2, `markDeletion/task/T1` | `DELETE FROM task WHERE id = T2 RETURNING id` | 0 рядків (T2 — природна `delete`, якої в w2 немає) |
| `post-extent` | w1, `post/task/T1`; `post/task/T2` | `UPDATE task SET posted = true WHERE id = <корінь> RETURNING id` | T1 (чужа) — 0 рядків, хоч `update@any` є; T2 (своя) — 1 |
| `root-effect` | w2, `markDeletion/task/T1` | `UPDATE task SET deletion_mark = true, region_id = r2 WHERE id = T1` | `42501` `command.forbidden`/`effect` |
| `root-dml` | w1, `update/task/T2` | `DELETE FROM task WHERE id = T2` | `42501` `command.forbidden`/`effect` (`DELETE` ∉ ефектів `update`) |
| `tabular-transition` | w2, `markDeletion/task/T1`; w1, `update/task/T1` | `INSERT INTO task_checklist (parent_id = T1, …)` | `42501` `command.forbidden`/`effect`; успіх |
| `delete-cascade` | w1, `delete/task/T4` | `DELETE FROM task WHERE id = T4 RETURNING id`, `after`: `SELECT parent_id FROM task_checklist WHERE parent_id IN (T4, T3)` | 1 рядок; `after` — лише два рядки T3 (позитивний контроль: вибірка бачить рядки ТЧ) |
| `delete-single-line` | w1, `delete/task/T4` | `DELETE FROM task_checklist WHERE parent_id = T4 AND <один рядок>` | `42501` `command.forbidden`/`effect` (власник живий) |
| `copy-only` | w1, `reassign/task/T3` | `UPDATE task SET assignee_id = w2 WHERE id = T3 RETURNING id`, `after`: `SELECT DISTINCT assignee_id FROM task_checklist WHERE parent_id = T3` | 1 рядок; `after` — лише w2 |
| `tenant-boundary` | w4, `update/task/TB`; `create/task/<новий id>`; `update/task/T2` | `UPDATE task … WHERE id = TB RETURNING id`; `INSERT INTO task (id = <новий>, org_id = B, project_id = P1, …)`; `UPDATE task SET org_id = B` (без `WHERE` і `RETURNING`: інакше `UPDATE` потребує читання, і новий рядок відкинула б уже `task_scope_read`, а не `task_scope_update`; рядки обирають лише `USING` політик запису — T2 кореневою родиною, решта задач `P1` природною `update`) | 0 рядків; `42501` з текстом порушення політики RLS (RLS — раніше за FK `AFTER`); те саме |
| `register-dimension` | w1, `write/region_notes/<будь-який uuid>` | `INSERT INTO region_notes (org_id = A, region_id = r1, …)`; те саме з `r2` | успіх; `42501` з текстом порушення політики RLS |
| `public-read-write` | w1, `update/bulletin/BA`; `update/bulletin/BB` | `UPDATE bulletin SET text = 'x' WHERE id = <корінь> RETURNING id` | BA (тенант A) — 1 рядок; BB (тенант B, видимий через `publicRead`) — 0 рядків |
| `forged-author` | w1, `post/task/T2` | `UPDATE task SET posted = true, created_by_id = <інший користувач> WHERE id = T2` | `42501` `command.forbidden`/`effect` (автора механіка не примушує, Р2b1-15) |
| `forced-mechanics` | w1, `post/task/T2` | `UPDATE task SET posted = true, version = 999 WHERE id = T2 RETURNING version` | 1 рядок; `version` = попередня + 1 (механіка примусила, тригер ефектів зміни не бачить) |
| `create-existing-root` | w1, `create/task/T2` (наявний корінь) | `UPDATE task_checklist SET note = 'x' WHERE parent_id = T2` (рядок `checklist` T2 у засіві) | `42501` `command.forbidden`/`effect` |
| `update-cannot-post` | w1, `update/task/T2` | `UPDATE task SET posted = true WHERE id = T2` | `42501` `command.forbidden`/`effect` |
| `update-cannot-mark` | w1, `update/task/T2` | `UPDATE task SET deletion_mark = true WHERE id = T2` | `42501` `command.forbidden`/`effect` |
| `create-cannot-post` | w1, `create/task/<новий id>` | `INSERT INTO task (id = <новий>, org_id = A, project_id = P1, posted = true, …)` | `42501` `command.forbidden`/`effect` |
| `post-cannot-unpost` | w1, `post/task/T5` | `UPDATE task SET posted = false WHERE id = T5` | `42501` `command.forbidden`/`effect` |
| `rest-cannot-post` | w1, `post/task/T2` | `UPDATE task SET posted = true WHERE id = T1` (T1 — природна `update`, яку w1 має) | `42501` `command.forbidden`/`effect` |
| `cross-object-transition` | w1 (`TaskWriter`: `update@any` на `Bulletin`), `update/task/T2` | `UPDATE bulletin SET deletion_mark = true WHERE id = BA` | `42501` `command.forbidden`/`effect` (запис іншого об'єкта — природна `update` без колонок переходів) |
| `unknown-action` | w1, `'{"action":"invent","object":"task","root":"<T2>"}'`; `post/bulletin/BA` (дія є, але в іншого об'єкта) | `UPDATE bulletin SET text = 'x' WHERE id = BA` | `42501` `command.context`/`unknown-action`; те саме |
| `root-rekey` | w1, `update/task/T6` | `UPDATE task SET id = <новий UUID> WHERE id = T6` | `42501` `command.forbidden`/`effect`, колонка `id` (T6 без залежних рядків: на T2 FK рядка ТЧ `ON UPDATE NO ACTION` дав би `23503` раніше за тригер `AFTER`) |
| `create-root` | w1, `create/task/<новий id>` | `INSERT INTO task (id = <новий>, org_id = A, project_id = P1, …)` | успіх |
| `tenant-move` | w5 (`TaskWriter` в A і B), `update/task/T6`; `update/task/T2` | `UPDATE task SET org_id = B WHERE id = T6`; `UPDATE task_checklist SET org_id = B, parent_id = TB WHERE id = <рядок T2>` | `42501` `command.forbidden`/`effect`, колонка `org_id` (RLS пропускає: `USING` в A, `WITH CHECK` у B; відмовляє тригер, Р2b1-20); те саме (FK (B, TB) існує, шапку ТЧ тригер не порівнює — скоуп рядка ТЧ тримає лише незмінність) |
| `provider-api-role-write` | сервісна роль провайдера (`PROVIDER_API_ROLES`, DML-грант у транзакції опису), без контексту | `UPDATE task SET region_id = r2 WHERE id = T2 RETURNING region_id`; власником — `SELECT region_id` | 1 рядок; рядок змінено (тригер ефектів `SECURITY DEFINER` доходить до раннього виходу без контексту: `EXECUTE` на функціях контексту має лише роль команд, Р2b1-8) |

  EXPLAIN-гейт шаблонів запису (платформна спека §6.8): під роллю команд з контекстом `EXPLAIN (FORMAT JSON, VERBOSE)` `UPDATE` і `DELETE` над `task` і `task_checklist` — виклики `simetra.command_action()` і `simetra.command_root(…)` лише у виходах InitPlan, жодного виклику функції `simetra.*` в умовах сканування, жодного `SubPlan`. `INSERT … VALUES` перевірок `WITH CHECK` у плані не показує, тож його в гейті немає.

  Кейс `no-context` пише в `region_notes` рядок з `region_id = r1` (без запобіжника його пропустила б природна `write@region` ролі `RegionWriter`; w1 у засіві має й `RegionWriter`). Кожна відмова звіряється з `code` і `message`/`detail`, відмова тригера ефектів — ще й з колонкою (`column`), якщо тригер її називає — `42501` дають і RLS, і відсутній грант, і контекст, і тригер.

- [x] **Step 3:** `engine-desired-corpus.db.test.ts` — модель `policyDomain(writeRoles(), writableRegister())` у корпус поруч із `policyDomain()`: функції контексту, тригери ефектів з `WHEN` і `RESTRICTIVE`/`PERMISSIVE`-політики запису проходять туди-назад.
- [x] **Step 4:** Run: `pnpm --filter simetra exec vitest run --project db rights-write rights-policies` і `pnpm --filter @simetrajs/designer exec vitest run --project db engine-desired-corpus` — PASS. **Мутаційний доказ** (вручну, без коміту; кожна мутація червонить свій кейс):

| Мутація | Червоніє |
| --- | --- |
| прибрати `<t>_command_*` | `no-context` (регістр) |
| `command_parsed` приймає ключі понад три | `malformed-context` (другий запит) |
| `command_parsed` приймає контекст без `root` | `malformed-context` (перший запит) |
| у кореневій родині `COMMAND_ACTION` → природна дія | `root-transition`, `post-extent` |
| у родині «решта» природна дія → `COMMAND_ACTION` | `rest-needs-natural` |
| родина «решта» на `DELETE` без умови права | `rest-delete-needs-natural` |
| умова родини чи запобіжник контексту без обгортки `(SELECT …)` (корельовані) | EXPLAIN-гейт (`plan of … evaluates the write policies once per statement`) |
| прибрати умову `IS DISTINCT FROM` з родини «решта» | `post-extent` (T1 проходить за `update@any` w1) |
| прибрати кореневу родину | `create-root` |
| прибрати порівняння шапки в тригері | `root-effect` |
| прибрати перевірку `TG_OP` ∈ `effects.dml` | `root-dml` |
| прибрати колонку скоупу з незмінних | `tenant-move` (другий запит, рядок ТЧ: `{ rows: [] }` замість відмови з колонкою `org_id`); в основній таблиці мутація рівнозначна — порівняння шапки відмовляє з тією самою колонкою |
| прибрати перевірку `tabularSections` у ТЧ | `tabular-transition` (перший запит) |
| прибрати виняток каскаду | `delete-cascade` |
| прибрати умову `NOT EXISTS` (виняток на будь-який `DELETE`) | `delete-single-line` |
| прибрати `WHEN (<contentChangeCondition>)` з `_effects_update` | `copy-only` |
| прибрати `<t>_scope_update` (2a2) | `tenant-boundary` (третій запит, без `WHERE`: `23503` складеного FK замість `42501`) |
| прибрати `<t>_scope_insert` (2a2) | `tenant-boundary` (другий запит: `23503` замість `42501`) |
| прибрати `PLATFORM_ROLES.command` з `<t>_public_read` | `public-read-write` (BA — 0 рядків) |
| виключити `created_by_id` з переліку порівняння тригера | `forged-author` |
| у порівнянні тригера лишити `version` (порівнювати `table.columns` без виключення механіки) | `forced-mechanics` (`42501` `effect`) |
| прибрати з `touchFunction` примушення `version` (`NEW.version := OLD.version + 1`) | `forced-mechanics` (`version` = 999) |
| у ТЧ прибрати узгодження DML рядка з DML дії | `create-existing-root` |
| `canonicalHeader` лишає `"all"` (колонки переходів у шапці `update`) | `update-cannot-post` |
| з `"all"` виключати лише `posted` | `update-cannot-mark` |
| прибрати перевірку значень за замовчуванням на `INSERT` | `create-cannot-post` |
| прибрати перевірку напрямку переходу | `post-cannot-unpost` |
| прибрати перевірку некореневих рядків | `rest-cannot-post` |
| на `object` ≠ мітка — ранній `RETURN NULL` | `cross-object-transition` |
| прибрати перевірку пари (`object`, `action`) у `command_parsed` | `unknown-action` |
| прибрати незмінність ключа | DB-рівнем рівнозначна: ключ поза шапкою будь-якої дії, тож порівняння шапки дає ту саму відмову з колонкою `id` (`root-rekey` зелений); її ловить юніт `effects-units` «checks the root row against the effects of the command action» |
| тригер ефектів без `SECURITY DEFINER` і `row_security = off` | `provider-api-role-write` (запис сервісної ролі падає на правах функцій контексту) |
| у `command_parsed` пара — лише `t.a = action` (без `t.o = object`) | `unknown-action` (другий запит) |
| прибрати з `command_parsed` три перевірки: `pg_input_is_valid(…, 'jsonb')`, `jsonb_typeof = 'object'`, `pg_input_is_valid(root, 'uuid')` | `malformed-context` (сирі: `22P02` замість `command.context`) |
| у регістрі прибрати умову значень виміру (`rights_dimension_values`) з предиката | `register-dimension` (другий запит) |

- [x] **Step 5: Commit**

```bash
git add packages/simetra/test/db packages/designer/src
git commit -m "test(db): запис під роллю команд — родини політик, ефекти дії й межа тенанта"
```

---

### Задача 7: скіл, гейти й заміри

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md`, `docs/ROADMAP.md`, цей план (позначки)

- [x] **Step 1:** Скіл споживача (англійською): таблиці виду пише лише команда; кореневий рядок команди — право дії команди, решта — природна дія за DML; дія-перехід (`post`, `markDeletion`, кастомна) змінює лише свої колонки шапки й не пише ТЧ; обробник `beforeWrite`, що під переходом змінює іншу колонку, дає відмову — обчислення під проведенням у хук команди чи в ефекти кастомної дії.
- [x] **Step 2:** Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — код 0.
- [x] **Step 3:** Run: `pnpm metadata:check && python3 scripts/check-doc-anchors.py && .agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-24-rights-2b1-write-policies-effects.md` — код 0.
- [x] **Step 4:** (локально на d112352: код 0, 1345 с — pgTAP, simetra 171, designer 559; приріст — нові `rights-write` ≈ 3,4 с і кейс корпусу `write policy domain` ≈ 5,9 с, разом ≈ 9 с; базу 2a2 міряли на CI, тож приріст — за доданими файлами) Повний `pnpm test:db` на одному SHA (у фоні, таймаут не коротший за 45 хв): `/usr/bin/time -f %e pnpm test:db` — код 0 (або CI job `db`, якщо стеку немає); приріст проти прогону після 2a2 ≤ 15 с, інакше звіт архітектору з розкладом за файлами.
- [x] **Step 5:** ROADMAP — рядок прав: «Права-2b1 виконано»; позначки плану.
- [x] **Step 6: Commit**

```bash
git add packages/designer/skills docs/ROADMAP.md docs/superpowers/plans/2026-10-24-rights-2b1-write-policies-effects.md
git commit -m "docs(plan): Права-2b1 виконано — скіл, ROADMAP, позначки"
```

## Критерії приймання

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py` — зелені після **кожного** коміту; повний `pnpm test:db` — зелений на одному SHA, приріст записано (≤ 15 с).
- Згенерований SQL не дає DML ролі команд і не керує нею (тест 2a1 без змін).
- Кожна умова права в політиці запису — з `rightsPredicates`; дія контексту — лише через `COMMAND_ACTION`; інваріант єдиного набору обсягів тримає `uniformExtents` (Задача 1).
- `simetra.command` розбирає одна функція; суворі поверхні відмовляють `42501`, тригер — без винятку на відсутньому контексті (Задача 2).
- Кожен запобіжник Задачі 6 має мутаційний доказ з її таблиці.
- Спека прав §3, §5.3, §6.2 і таблиця 2a1 оновлені (Задача 0).
