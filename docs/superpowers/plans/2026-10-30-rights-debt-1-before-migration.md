# Права: борг перед першою міграцією — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: виконано задачі 0–7; Задача 8 — після відновлення сесій.
Архітекторка задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** закрити пункти [боргу прав](2026-10-26-rights-residual-debt.md) §1,
які блокують першу міграцію споживача: проєкт зі стилем атрибутів
`snake_case` і довідниками прав компілюється й працює; ключ `id` таблиці виду
незмінний для будь-якого автора; кожна згенерована функція має
`SET search_path = ''`, і компілятор це гарантує; RLS виду задано в реєстрі
явно; шлях `SET` від ролі запиту до керівника ролі платформи гейт відхиляє;
для FK `CustomTable` на не-ключову колонку таблиці виду — рішення архітекторки.

**Архітектура:**

- **T0** (`packages/simetra/src/model`): обов'язкове `rowLevelSecurity` у
  реєстрі видів (`kinds/standard.ts`); визначення стандартних колонок прав
  експортуються з реєстру (`kinds/catalog.ts`, `kinds/registry.ts`).
- **T1** (`packages/simetra/src/compiler`): один помічник пошуку стандартної
  колонки за визначенням реєстру й стилем проєкту; генератори прав переходять
  на нього; правило лінту проти порівняння `origin.standard` з літералом;
  безумовний тригер незмінності ключа на кожній таблиці виду; перевірка
  `search_path` згенерованих функцій у конвеєрі.
- **T2** (`packages/simetra/src/schema`): `apply/rights-sources.ts` — той самий
  помічник; `apply/platform-roles.ts` — рекурсивна перевірка шляху до
  керівника.
- **Тести:** близнюк фікстури прав у `snake_case` і тест рівності
  згенерованого SQL обох стилів; один DB-опис повного циклу на близнюку.

**Стек технологій:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query
(WASM), ESLint (flat config), локальний стек Supabase (Postgres 17).

**Джерела:** [борг прав](2026-10-26-rights-residual-debt.md) §1;
[спека прав](../specs/2026-10-17-rights-design.md) §5.2, §6.2, §7;
[спека П4](../specs/2026-10-26-p4-runtime-design.md) §6.2, §6.16;
[спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md) §8.3
(RLS виду); `AGENTS.md` § «Metamodel rules» (стандартні атрибути — з реєстру;
кожна гілка за видом читає реєстр). Плани Права-2a1…2c2 і
[П4-A1](2026-10-29-p4-a1-roles-grants-authorship.md) — їхні рішення діють.

**Залежність:** гілка `feat/rights-debt-1` від `fbd49194` (фінал П4-A1).
Перед стартом — `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-30-rights-debt-1-before-migration.md`.

## Global Constraints

- Усі обмеження планів Права-2a1…2c2 і П4-A1 діють і тут.
- 🔴 `pnpm --filter <pkg> test <pattern>` — **без** `--` перед шаблоном.
- 🔴 Генератор знаходить колонку за `origin` (`standard` через визначення реєстру й `standardLogicalName`, `elementId`, `scopeKindId`, `copyOf`) і `table.origin`, **ніколи** за літералом імені.
- 🔴 Задача 1 (snake_case) — **першим кодовим комітом**; SHA одразу архітекторці (від нього залежить A2).
- 🔴 У репо — «snake_case-проєкт», без імен і деталей споживача; фікстури синтетичні.
- 🔴 Задача 5 (FK) — лише пропозиція архітекторці; код — тільки з її «так».
- Тести SQL — на деревах чи цілими операторами; DB-тест — лише для того, що вирішує Postgres. Скіл `.agents/skills/writing-tests/SKILL.md` — перед кожним кроком тестів.
- Кожне правило має тест, що червоніє від мутації; мутації — лише на закоміченому дереві.
- Між задачами гейти не червоні: зміна й правка тестів, які вона ламає, — в одному коміті.
- Повні гейти й повний `pnpm test:db` — лише з «можна» архітекторки; після 07:00 за Києвом — жодних прогонів довших за 10 хв.
- Версій пакетів і `PLATFORM_VERSION` не чіпати; історію не переписувати; пуш і PR — лише з окремої вказівки архітекторки.

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Рб1-1 | **Один помічник пошуку стандартної колонки.** `compiler/standard-column.ts`: `standardColumn(table: Pick<PhysicalTable, "columns" \| "name">, def: Pick<StandardColumnDef, "logicalName">, attributeCase: AttributeCase): PhysicalColumn` (відсутня — `internal: missing standard column <table>.<logicalName>`) і `findStandardColumn(...)`: `PhysicalColumn \| undefined`; порівнює `origin.standard` з `standardLogicalName(def, attributeCase)`. `def` береться **з реєстру** (визначення колонок довідників прав, «Користувачів», ТЧ тощо, експортовані з `model/kinds/*`), не літералом `{ logicalName: "…" }`. На помічник переходять: `catalogColumns` і `catalogAssignments` (`compiler/rights/functions.ts`), `column()` (`compiler/rights/guard-units.ts`), `standard()` (`compiler/rights/holders.ts`), `columns()`/`c()` (`schema/apply/rights-sources.ts`), `immutableColumns` (`compiler/rights/effects-units.ts`, `USER_PLATFORM_FIELDS` → `userPlatformColumns()`), перевірка `userKind` у `guard-units.ts`, `compiler/operations/promote/sql.ts` (`origin.standard === column.logicalName`), і **кожне** інше порівняння `origin.standard` з літералом у `packages/simetra/src` (однослівні — теж: правило, а не випадок). Стиль доходить параметром: `buildRightsUnits`, `effectiveHolderRows` отримують `attributeCase` (виклик — `compiler/pipeline.ts`); `rightsSourceInput` бере стиль **окремо для кожного знімка** — застосованого й бажаного, кожен зі стилю свого проєкту (колонки старого знімка мають `origin.standard` у старому стилі); `appliedRightsSchema` (`schema/apply/rights-sources.ts`) розбирає й `project.naming.attributeCase` застосованого знімка (`canonicalSnapshot` його зберігає; відсутній — `camelCase`, типовий стиль) | корінь `internal: missing rights input`: `catalogColumns` шукає `"customRole"`/`"deletionMark"`, а `origin.standard` у snake_case — `custom_role`/`deletion_mark`; помічник із визначенням реєстру не дає передати рядок | немає |
| Рб1-2 | **Правило лінту — заборона літералів імен.** У `packages/simetra/eslint.tier-zones.js` (чи сусідньому конфігу, що його підключає; без нового плагіна) — `no-restricted-syntax` для `packages/simetra/src/**` поза `**/__tests__/**` і поза `src/model/kinds/**`: (1) порівняння `==`/`===`/`!=`/`!==`, де один операнд — `MemberExpression[property.name="standard"]`, а другий — рядковий літерал; (2) виклик `standardLogicalName`, `standardColumn` чи `findStandardColumn`, де аргумент визначення — об'єктний літерал (визначення — лише змінна з реєстру). `standardElementId(objectId, { logicalName })` правило не чіпає: воно будує id елемента, не шукає колонку. Наявні місця під правилом (2): `compiler/operations/promote/record.ts` (`standardLogicalName({ logicalName: successorId.slice(…) }, style)`) — лишається з `// eslint-disable-next-line no-restricted-syntax` і коментарем: канонічне ім'я береться із синтетичного id елемента (`<власник>#<ім'я>`, власник — об'єкт чи ТЧ), а не літералом; визначення за видом тут не знайти, бо реєстр дає колонки лише за об'єктом. `{ logicalName: "ref" }` у `compiler/rights/checks.ts` — `keyColumn(false)` реєстру; `standardElementId(…, { logicalName: "ref" })` у `compiler/rights/contracts.ts` правило не чіпає. Порівняння з `undefined` («не стандартна колонка») дозволене; `compiler/standard-column.ts` експортує `isStandard(c): boolean`. Множини стандартних імен (`Set.has(c.origin.standard ?? "")`) дозволені, коли їх будують з визначень реєстру через `standardLogicalName(def, style)`. Гарантія: імена стандартних колонок у генераторах — з реєстру; літеральну множину (`new Set(["createdBy"]).has(…)`) правило не ловить — її, як і будь-який пропуск, ловить наскрізний тест рівності Рб1-3. Негативний тест — за зразком `packages/simetra/test/tier-boundary.test.ts` (`ESLint.lintText`): обидва порушення дають помилку правила; `c.origin.standard === undefined`, `standardElementId(id, { logicalName })` і `standardLogicalName(def, style)` — ні. Двоє наявних тестів, що порівнюють `origin.standard` (snake_case-кейси `author-units.test.ts`, `rights-guards.test.ts`), переходять на близнюк Рб1-3; `USER_PLATFORM_FIELDS` — на `userPlatformColumns()` | правило «за `origin`, ніколи за ім'ям» тримає машина там, де ім'я може з'явитись літералом | немає |
| Рб1-3 | **Близнюк фікстури в `snake_case` і тест рівності.** У `compiler/__tests__/fixtures/` — `snakeCaseTwin(files: Map<string, string>): Map<string, string>` (фікстури — JSON-текст за шляхом; файли `.sql` — без змін): ставить `naming.attributeCase: "snake_case"` і перейменовує логічні імена реквізитів, ТЧ, колонок `CustomTable` та кожне посилання на них у метаданих фікстури (умови `where`, шляхи власності й носіїв — зокрема стандартні реквізити на кшталт `createdBy` → `created_by`, `membership.user`, виміри). Імена об'єктів, дій (`markDeletion`, `administerRights`, кастомні дії) і ролей не змінює. Повноту перейменування перевіряє сам компілятор: пропущене посилання дає діагностику, тож тест вимагає `diagnostics: []`. Тест рівності: для `policyDomain(writeRoles(), adminRoles())` (уже має «Користувачів» із ТЧ `devices`) і `singleTenantRights({ ...authorCarrier(), ...authorCarrier("long") })` — множини `sqlUnits` (identity → sql) camelCase і snake_case **однакові** (фізичні імена не залежать від стилю: `physicalName` призначається один раз). Фізичні імена, що в camelCase-фікстурі задано явно, близнюк не чіпає. Якщо одиниці різняться законно (логічне ім'я в коментарі SQL чи в імені похідного об'єкта) — виконавець зупиняється й пише архітекторці з фактом, а не послаблює рівність | рівність SQL — матриця «кожен генератор × стиль» одним тестом: функції прав, запобіжники 2c2, ефекти, носії, гранти, авторство, механіка; новий генератор потрапляє в неї сам | немає |
| Рб1-4 | **Безумовна незмінність ключа — окремий генератор для всіх проєктів.** Новий `compiler/key-units.ts` (`buildKeyUnits(physical, attributeCase, provider, module, parse)`; викликає `pipeline.ts` поряд із механікою, **незалежно від прав**): на кожній таблиці з колонкою стандартного ключа `ref` за `origin` — основні таблиці довідників і документів та рядки ТЧ (регістри й константи ключа `ref` не мають — без тригера; `CustomTable` і таблиці `simetra` — без тригера). **Два тригери на ту саму функцію:** (1) `<t>_simetra_key` — `BEFORE UPDATE ON <t> FOR EACH ROW WHEN (OLD.<ключ> IS DISTINCT FROM NEW.<ключ>) EXECUTE FUNCTION simetra.key_immutable('<ключ>')`, мітка `simetra_key` у групі `PLATFORM_BEFORE_ROW_LABELS` (замість `simetra_rights_id`; ім'я — `platformBeforeTriggerName`; за абеткою між `carriers` і `touch`): відмовляє до перевірки унікального індексу, тож обмін ключів двох рядків одним `UPDATE` дає `effect`, а не `23505` (PK не відкладений, індекс перевіряється на кожному рядку); (2) `<t>_simetra_key_after` — `AFTER UPDATE … FOR EACH ROW WHEN (OLD.<ключ> IS DISTINCT FROM NEW.<ключ>)` на ту саму функцію, ім'я — `generatedTableFunctionName(table, "simetra_key_after")`: бачить рядок після всіх `BEFORE`-тригерів, зокрема обробника `beforeWrite`, що сортується після `simetra_key` і переписує `NEW.id`. Обидва — без `OF`. Одна функція на проєкт `simetra.key_immutable()` — `plpgsql SECURITY INVOKER SET search_path = ''` (таблиць не читає; `EXECUTE` тригерної функції Postgres не перевіряє), `EXECUTE` — нікому; тіло: `RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'command.forbidden', DETAIL = 'effect', TABLE = TG_TABLE_NAME, COLUMN = TG_ARGV[0]`. Без винятку режиму обслуговування. Знімаються: тригер `simetra_rights_id` (`addIdGuard`, членство й «Користувачі»; мітка `simetra_rights_id` — з `TABLE_GUARDS` і з `PLATFORM_BEFORE_ROW_LABELS`, де її місце займає `simetra_key`) і перевірка ключа основної таблиці в `immutableColumns` тригера ефектів (власник рядка ТЧ там лишається). Розпізнавачі: `schema/reverse/units.ts` (`platformFunctions` і тригери — як `MECHANICS`/`AUTHOR`) і `schema/apply/promotion/replacements.ts` (предикат `key`) знають тригер і функцію. Законного `UPDATE` ключа немає: промоція пише дані кроками, що не пишуть ключ (`schema/apply/promotion/data.ts`: крок, що пише ключ, відхиляється з причиною `fillTarget`; тригери на час запису даних вимкнено), рушій і засів ключ лише вставляють | §1 боргу: власник і міграції змінюють `id` без відмови; один генератор для всіх проєктів — незмінність ключа не залежить від наявності прав | спека прав §7: «зміна `id` рядка членства чи «Користувачів» — завжди відмова» → «зміна ключа `id` рядка таблиці виду (довідника, документа, рядка ТЧ) — завжди відмова `command.forbidden` / `effect` з колонкою ключа, зокрема поза командою (повідомлення лишається `command.forbidden`)» |
| Рб1-5 | **`search_path` згенерованих функцій — інваріант конвеєра.** Після збирання `sqlUnits` (`compiler/pipeline.ts`) `assertPinnedSearchPath(units)` (`compiler/sql/pinned-search-path.ts`) перевіряє кожну одиницю з `generator` (не SQL застосунку), чиє дерево — `CreateFunctionStmt`, **наявним** помічником кінцевого стану (`hasEffectiveEmptySearchPath` / `hasEmptySearchPath` у `compiler/sql/closed-forms.ts`: згортає `SET`, `RESET search_path`, `RESET ALL`, `FROM CURRENT` разом з наступними `ALTER FUNCTION` тієї самої функції); інакше `throw new Error("internal: generated function <identity> without SET search_path = ''")`. Згенерований `AlterFunctionStmt`, що змінює чи скидає `search_path` (зокрема `RESET ALL`), — теж `internal:`. Тест на фікстурах (kitchen-sink, фікстури прав обох стилів) і на `examples/reference` — без винятку; мутації: прибрати `SET search_path` з `definerTrigger` (`compiler/rights/definer.ts`) → компіляція кидає; `SET search_path = '' RESET ALL` у тесті помічника → кидає | сьогодні всі місця рендеру ставлять опцію (перевірено компіляцією фікстур), але нове місце може забути; один інваріант на виході замість точкових тестів | немає |
| Рб1-6 | **RLS виду — обов'язкове поле реєстру.** `KindDefinition.rowLevelSecurity: "enabled" \| "declared" \| "none"` (обов'язкове): `enabled` — таблиці виду під RLS; `declared` — значення з файлу метаданих (`CustomTable`); `none` — вид без таблиці (`materializes` ≠ `"table"`). `rowLevelSecurityOf` (`compiler/stages/model.ts`) без `?? "off"`; невідповідність (`declared` без `isDeclaredTable`, `none` у виду з таблицею) — `internal:`. Тест реєстру в `model/__tests__/kind-registry.test.ts`: `it.each` над `KIND_REGISTRY` — `materializes === "table"` ⇔ `rowLevelSecurity !== "none"`; `rowLevelSecurity === "declared"` ⇔ `def.declared && def.materializes === "table"` (сьогодні лише `CustomTable`; `PgEnum` — `declared`, але без таблиці, тож `none`). Мутація: позначити один вид із таблицею `none` → тест червоний | новий вид без явного значення лишався б без RLS тихо; `declared` без файлу дав би `undefined` і політики на таблиці без RLS | немає (реалізує П2 §8.3) |
| Рб1-7 | **Шлях до керівника ролі платформи.** `platformRoleGate` додатково читає рекурсивно (`WITH RECURSIVE … UNION`, щоб цикли завершувались) усі ролі, досяжні з ролей запиту (`requestNames`) **будь-яким** ребром `pg_auth_members` `member → roleid` (з PG16 `is_admin_of_role` іде всіма членствами, не лише `set`/`inherit`). Порушення (`plan.platform-role-shape` для ролі платформи): досяжна роль — керівник ролі платформи (член з `admin_option` ролі грантів чи ролі входу) → `request-path:<роль>`; досяжна роль із `rolsuper` → `request-path:<роль>`. Перевірити поведінку тегованими ролями в DB-тесті (Задача 6). Факт стека (2026-10-30): ролі запиту не мають жодного вихідного ребра; керівник обох ролей платформи — `postgres` — недосяжний; хибних відмов немає | кандидат архітекторки після C1; обхід лише `set`/`inherit` пропускав ADMIN через звичайне членство | немає |
| Рб1-8 | **FK `CustomTable` на таблицю виду — пропозиція (Задача 5, на погодження).** Ціль FK на таблицю виду (не прийняту) — лише ключ `ref`; інша колонка — нова помилка компілятора `customTable.fk-target-not-key` у `checkDeclaredTable` (`compiler/stages/integrity.ts`) поруч із `fk-action-on-kind-table`; прийняті цілі — без змін. `promote.retired-referenced` для таблиць виду стає недосяжним лише для нових FK; наявний код лишається для прийнятих цілей | роль команд оновлює будь-який унікальний реквізит довідника (Р-A1-11), і FK `NO ACTION` мовчки блокував би команду дочірніми рядками; ключ незмінний (Рб1-4), тож FK на нього стабільний; у `examples/` єдиний такий FK веде на ключ | спека прав §4.7 (межа `CustomTable`) — «FK з `CustomTable` на таблицю виду — лише на ключ `ref`, лише `NO ACTION`/`RESTRICT`» |

## Рішення архітекторки (2026-10-30)

План прийнято (`66567007`).

- Рб1-1, Рб1-2, Рб1-3, Рб1-5, Рб1-6, Рб1-7 — так. Законна різниця SQL двох стилів — до архітекторки. Правило зупинки Рб1-7 (Postgres відхиляє і `ALTER ROLE`, і `GRANT`) — так.
- Рб1-4 — так, з умовами: (1) обидва тригери мають `WHEN (NEW.<ключ> IS DISTINCT FROM OLD.<ключ>)`; (2) Задача 0 перевіряє фактом, що жоден шлях платформи законно не змінює ключ: кроки даних промоції, крок копій носіїв 2b2, засів копії доказу, `ON UPDATE CASCADE` з прийнятих таблиць на ключ таблиці виду — знайдено такий шлях → стоп і до архітекторки; (3) коди `member-id-swap`/`users-id-swap` → `effect` — так; правка спеки прав §7 — у Задачі 7.
- Рб1-8 — так, з уточненням: дозволена ціль FK `CustomTable` на таблицю виду — ключ `ref` **або** складений унікальний ключ «колонка скоупу + ключ» `(scope, id)`, який дає платформа для FK у межах тенанта; будь-яка інша колонка-ціль — помилка `customTable.fk-target-not-key`. Друга підстава: перевірка FK іде повз RLS, тож FK на вгадуване не-ключове значення (код, номер) — оракул наявності рядка в чужому тенанті. Кейси: `ref` — ок; `(scope, id)` — ок; `(scope, code)` — помилка; ціль — `CustomTable` — правило не діє. Вплив: спека прав §4.7.
- Рб1-8: ціль `(scope, id)` — Задача 8 (Рб1-9).

## Відомі обмеження

- Тест рівності (Рб1-3) доводить генератори, а не метадані поза фікстурами; приклади `examples/` лишаються в camelCase.
- Незмінність ключа (Рб1-4) — гарантія для DML з увімкненими тригерами. Власник таблиці може вимкнути тригер DDL-ом; у SQL застосунку `ALTER TABLE … DISABLE TRIGGER` уже відхиляється (Р2c1-2), а промоція вимикає тригери лише на кроки даних, що ключа не пишуть.
- `inherit`-ребра в Рб1-7 можуть відхилити екзотичну, але безпечну конфігурацію кластера; відмова названа й ручна.

## Review Focus

1. **Повний цикл у snake_case на базі:** вставка й зміна рядка командою, `rights_mine`, адміністрування прав (escalation) — та сама поведінка, що в camelCase. Тест — Задача 1, DB.
2. **Обмін ключів двох рядків одним `UPDATE`** (`SET id = CASE …`) на основній таблиці й ТЧ — відмова навіть від власника. Тест — Задача 2, DB.
3. **Нове місце рендеру функції без `search_path`** — компіляція кидає, а не тихо видає функцію. Тест — Задача 3, unit (мутація).
4. **Вид із таблицею без явного RLS** — помилка на етапі реєстру, не таблиця без RLS. Тест — Задача 4, unit.
5. **Роль запиту → посередник (SET) → керівник (ADMIN на ролі команд)** — відмова `request-path`. Тест — Задача 6, DB на тегованих іменах.

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/compiler/standard-column.ts` (новий) | пошук стандартної колонки |
| `packages/simetra/src/model/kinds/{catalog,registry,standard}.ts` | експорт визначень; `rowLevelSecurity` |
| `packages/simetra/src/compiler/rights/{functions,guard-units,holders,effects-units}.ts`, `compiler/operations/promote/sql.ts`, `compiler/pipeline.ts` | перехід на помічник, `attributeCase` |
| `packages/simetra/src/schema/apply/rights-sources.ts` | те саме в apply |
| `packages/simetra/eslint.*.js` | правило Рб1-2 |
| `packages/simetra/src/compiler/__tests__/fixtures/snake-case.ts` (новий) | `snakeCaseTwin` |
| `packages/simetra/src/compiler/__tests__/snake-case-parity.test.ts` (новий) | рівність SQL |
| `packages/simetra/test/db/snake-case.db.test.ts` (новий) | повний цикл |
| `packages/simetra/src/compiler/rights/{guard-units,guard-names,effects-units}.ts` | безумовний ключ |
| `packages/simetra/src/compiler/sql/pinned-search-path.ts` (новий) | інваріант `search_path` |
| `packages/simetra/src/compiler/key-units.ts` (новий), `compiler/before-trigger-names.ts` | тригери незмінності ключа |
| `packages/simetra/src/schema/reverse/units.ts`, `schema/apply/promotion/replacements.ts` | тригери й функція ключа — платформні |
| `packages/simetra/src/compiler/operations/promote/record.ts`, `compiler/rights/checks.ts` | місця під правилом лінту (Рб1-2) |
| `packages/simetra/src/compiler/stages/model.ts` | `rowLevelSecurityOf` |
| `packages/simetra/src/schema/apply/platform-roles.ts` | шлях до керівника |
| `packages/simetra/src/compiler/stages/integrity.ts`, `diagnostics.ts`, `messages.ts` | FK (лише після «так») |
| `docs/…`, `packages/designer/skills/simetra-metadata/*` | спека, борг, скіл |

---

### Задача 0: факти (без змін коду)

- [x] **Step 1:** Підтвердити читанням механізми, на які спирається Рб1-4: відмова з причиною `fillTarget` у `schema/apply/promotion/data.ts` (крок даних не пише ключ), вимкнення тригерів на час запису даних, засів і рушій лише вставляють ключ; плюс `grep -rnE "SET[^;]*\bid\s*=" packages/simetra/src packages/designer/src --include=*.ts | grep -v __tests__`. Законне оновлення ключа — розвилка архітекторці до Задачі 2.
- [x] **Step 2:** `rg -n "origin\.standard\s*[!=]==|[!=]==\s*[a-zA-Z.]*origin\.standard|logicalName:\s*\"|\b[a-z]\(\"[a-z]+[A-Z]" packages/simetra/src --glob '!**/__tests__/**'` — перелік місць для Задачі 1 (будь-який операнд, замикання з рядком). Кожне — на помічник Рб1-1; правило лінту Рб1-2 це потім тримає.

---

### Задача 1: snake_case-проєкт з довідниками прав (першим кодовим комітом)

**Files:** за Рб1-1, Рб1-2, Рб1-3 і структурою файлів.

**Interfaces:**
- Produces: `standardColumn(table, def, attributeCase): PhysicalColumn`, `findStandardColumn(table, def, attributeCase): PhysicalColumn | undefined` (`compiler/standard-column.ts`); `snakeCaseTwin(files)` (фікстури); `buildRightsUnits(..., attributeCase)`, `effectiveHolderRows(..., attributeCase)`, `rightsSourceInput(..., attributeCase)`.

- [x] **Step 1: Unit, червоний.** `snake-case-parity.test.ts`: `it.each` над фікстурами Рб1-3 — `compile(snakeCaseTwin(f))` → `diagnostics: []` і `sqlUnits` (identity → sql) дорівнює camelCase. Сьогодні — `internal: missing rights input`. `standard-column.test.ts`: колонка `custom_role` знаходиться визначенням реєстру в `snake_case` і `customRole` — у `camelCase`; відсутня — `internal: missing standard column`.
- [x] **Step 2:** Run `pnpm --filter simetra test snake-case-parity standard-column` — FAIL з очікуваних причин.
- [x] **Step 3: Реалізація** за Рб1-1 (кожне місце з Задачі 0 Step 2) і Рб1-3. Наявні ручні підміни `origin.standard` у `author-units.test.ts`, `effects-units.test.ts`, `rights-guards.test.ts` (кейси snake_case) замінити компіляцією близнюка — без ручних знімків.
- [x] **Step 4: Лінт** за Рб1-2 з негативним тестом. Мутація: прибрати правило → негативний тест червоний.
- [x] **Step 5: DB, повний цикл** (`packages/simetra/test/db/snake-case.db.test.ts`; причина DB — політики, тригери й функції прав виконує Postgres): спершу перенести локальний `seed()` з `rights-guards.db.test.ts` у `rights-seed.ts` (фізичні імена близнюка ті самі, тож SQL засіву спільний); розгорнути `snakeCaseTwin(policyDomain(writeRoles(), adminRoles()))` і засіяти; під `commandAs`: учасник з роллю запису вставляє й змінює рядок `task` — проходить; `rights_mine` дає ті самі права, що в camelCase-описі; самопризначення `OrgAdmin` — `escalation` на `COMMIT`. Одне розгортання на опис.
- [x] **Step 6: Мутації** (закомічене дерево): (a) `catalogColumns` знову порівнює з літералом → parity червоний; (b) `snakeCaseTwin` не перейменовує одне посилання → `diagnostics` непорожні (тест близнюка ловить, а не мовчить); (c) `rightsSourceInput` без стилю → unit у `schema/apply/__tests__/rights-sources.test.ts` (виклик на скомпільованому близнюку) червоний; (d) один стиль на обидва знімки → unit «застосований camelCase, бажаний snake_case тієї самої моделі» (`rightsSourceInput` проходить без `internal:`) червоний.
- [x] **Step 7:** Run `pnpm --filter simetra test` (увесь unit), `typecheck`, `lint` обох пакетів, `pnpm metadata:check`, scoped DB `pnpm --filter simetra test:db snake-case rights-guards rights-functions rights-sources`.
- [x] **Step 8: Commit** і SHA архітекторці одразу.

```bash
git add packages/simetra
git commit -m "fix(rights): snake_case-проєкт з довідниками прав — колонки за визначенням реєстру"
```

---

### Задача 1a: генерована колонка поза грантом ролі команд (доповнення A1)

Архітекторка, мутації A1: фільтр `c.generated === undefined` у `commandWriteColumns` (`compiler/rights/command-columns.ts`) не має тесту — у фікстурах довідників немає генерованої колонки.

- [x] **Step 1:** У `access-units.test.ts`, поруч зі snake_case-кейсами, — кейс: довідник із генерованою колонкою (якщо метадані довідника генерованої колонки не дають — фізична таблиця з колонкою `generated` у вході `commandWriteColumns`; спосіб — за кодом, без інлайн-метаданих поза будівником) → колонки немає ні в `INSERT (…)`, ні в `UPDATE (…)` гранту. Мутація: прибрати `c.generated === undefined` → червоний.
- [x] **Step 2:** Run `pnpm --filter simetra test access-units`.
- [x] **Step 3: Commit** окремо — `test(rights): генерована колонка поза грантом ролі команд`. Вплив на спеку: немає.

---

### Задача 2: ключ таблиці виду незмінний безумовно

**Files:** `compiler/key-units.ts` (новий), `compiler/pipeline.ts`, `compiler/rights/{guard-units,guard-names,effects-units}.ts`, `compiler/before-trigger-names.ts`, `compiler/__tests__/rights-guards.test.ts` (кейси `simetra_rights_id` переходять на `key-units.test.ts`), `schema/reverse/units.ts`, `schema/apply/promotion/replacements.ts`; тести — нижче.

- [x] **Step 1: Unit** `key-units.test.ts`: `it.each` над таблицями фікстур (основна довідника, ТЧ, документ, членство, «Користувачі») — оператор тригера (дерево) за Рб1-4; регістр, константа, `CustomTable`, таблиці `simetra` — без тригера; проєкт **без** прав (kitchen-sink чи мінімальний довідник) — тригер є; функція — `INVOKER`, `search_path = ''`, `EXECUTE` нікому. Тригер ефектів основної таблиці більше не перевіряє ключ; власника рядка ТЧ — перевіряє. `reverse-generate.test.ts`: тригер і `simetra.key_immutable` — платформні; `promotion-removals.test.ts`: тригер із тим самим іменем на платформну функцію — платформний, на чужу — ні. Мутації: генератор лише за наявності прав → кейс «без прав» червоний; без `AFTER`-тригера → DB-кейс обробника червоний; без `BEFORE`-тригера → DB-кейс обміну дає `23505` замість `effect` (червоний).
- [x] **Step 2: DB** (`rights-guards.db.test.ts`, наявний опис `member-id-swap`): розширити на `task` і рядок ТЧ — від власника без контексту, у режимі обслуговування й під командою — `effect` з колонкою ключа; зміна одного ключа на вільний UUID — точна відмова `42501` / `command.forbidden` / `effect` з колонкою ключа; обмін ключів двох рядків одним `UPDATE` — та сама точна відмова, не порушення унікальності (Review Focus 2); обробник `beforeWrite` (сирий тригер у точці збереження, що сортується після інших і ставить `NEW.id := gen_random_uuid()`) — відмова. `root-rekey` (`rights-write`) — без змін; `member-id-swap`/`users-id-swap` — тепер `effect`. Рядки кейсів — без залежних рядків (інакше FK `NO ACTION` дає `23503` раніше за тригер, як уже зазначено в `root-rekey`).
- [x] **Step 3:** Run unit, typecheck, lint; scoped DB `pnpm --filter simetra test:db rights-guards rights-write carrier promote mechanics`. Тригер з'являється на кожній таблиці довідника й документа, тож designer-тести з точним переліком тригерів (`promotion-commit.db.test.ts`, `desired-state.test.ts` тощо) зміняться: unit — оновити тут; designer DB `pnpm --filter @simetrajs/designer test:db promotion build-plan round-trip` (≈10+ хв) — лише до 07:00 за Києвом, інакше — до архітекторки з переліком і без коміту задачі.
- [x] **Step 4: Commit** — `feat(compiler): ключ таблиці виду незмінний для будь-якого автора`.

---

### Задача 3: `search_path` згенерованих функцій — інваріант

- [x] **Step 1: Unit** `pinned-search-path.test.ts`: (a) одиниця `CREATE FUNCTION … SET search_path = ''` з `generator` — проходить; без опції, з `search_path = public`, з `SET search_path = '' RESET ALL` — `internal:`; згенерований `ALTER FUNCTION … SET search_path = public`, `ALTER FUNCTION … RESET search_path` і `ALTER FUNCTION … RESET ALL` — `internal:`; (b) SQL застосунку (без `generator`) не перевіряється цим інваріантом (його судить гейт закритих форм); (c) компіляція kitchen-sink, фікстур прав обох стилів і `examples/reference` — без винятку. Мутація: прибрати `SET search_path` з `definerTrigger` (`compiler/rights/definer.ts`) → (c) кидає.
- [x] **Step 2:** Реалізація за Рб1-5; виклик у `pipeline.ts` після збирання одиниць.
- [x] **Step 3:** Run unit, typecheck, lint, `pnpm metadata:check`.
- [x] **Step 4: Commit** — `feat(compiler): кожна згенерована функція — з SET search_path = ''`.

---

### Задача 4: RLS виду — обов'язкове поле реєстру

- [x] **Step 1: Unit** (`model/__tests__/kind-registry.test.ts`): інваріанти Рб1-6 через `it.each(Object.entries(KIND_REGISTRY))`. Мутація: позначити вид із таблицею `none` → червоний; поле необов'язкове → `typecheck` червоний.
- [x] **Step 2:** Реалізація за Рб1-6; оновити `creation-order.test.ts`, `kind-schemas.test.ts` та інші, що читають поле.
- [x] **Step 3:** Run unit, typecheck, lint, `pnpm metadata:check`.
- [x] **Step 4: Commit** — `feat(model): RLS виду — обов'язкове поле реєстру`.

---

### Задача 5: FK `CustomTable` на не-ключову колонку — лише після «так»

- [x] **Step 1:** Надіслати архітекторці пропозицію Рб1-8 з фактами (розвідка: FK на будь-яку колонку дозволено, ключ цілі перевіряє лише тінь; `commandWriteColumns` дозволяє `UPDATE` унікального реквізиту; промоція переносить FK лише на колонку з `becomes`; у `examples/` FK лише на ключ). Чекати «так».
- [x] **Step 2 (після «так»):** unit у `stage-integrity.test.ts` — FK на `ref` таблиці виду — без діагностики; на унікальний реквізит таблиці виду — `customTable.fk-target-not-key`; на будь-яку колонку прийнятої таблиці — без змін. Мутація: прибрати перевірку → червоний. Реалізація; повідомлення en/uk; `metadata:check`.
- [x] **Step 3: Commit** — `feat(compiler): FK CustomTable на таблицю виду — лише на ключ`.

---

### Задача 6: шлях `SET` від ролі запиту до керівника ролі платформи

- [x] **Step 1: Unit** (`platform-roles.test.ts`): рядки з полем досяжності (нова форма читання) — керівник, досяжний з ролі запиту, → `request-path:<керівник>`; недосяжний — `[]`. Мутація: без перевірки досяжності → червоний.
- [x] **Step 2: DB** (`roles-tool.db.test.ts`, теговані імена, `withRollback`): тегована роль запиту → (SET) тегований посередник → (членство без `SET` і `INHERIT`) тегований керівник із `CREATEROLE` і `ADMIN` на тегованій ролі команд → `platformRoleGate(..., requestNames)` → `request-path:<керівник>`; тегована роль запиту, член ролі з `SUPERUSER` неможлива без суперкористувача — кейс `rolsuper` лише unit; цикл членств (A → B → A) — завершується; без ланцюга → `[]`. **Факт експлуатованості** (той самий опис, у точках збереження): `SET ROLE` на посередника (з `CREATEROLE`, звичайний член керівника) і спроба (a) `ALTER ROLE <тегована роль команд> CONNECTION LIMIT 1` (`AlterRole`: `CREATEROLE` + `is_admin_of_role`, що з PG16 іде всіма членствами) і (b) `GRANT <тегована роль команд> TO <тегований x>`. Записати, що Postgres дозволив. Якщо обидві відмовлено — зупинитись і написати архітекторці: обхід звузити лише після її рішення. Мутація: обхід лише `set`-ребер → кейс «без `SET` і `INHERIT`» червоний. Наявний кейс справжнього стека — `[]`.
- [x] **Step 3:** Реалізація за Рб1-7 (рекурсивний запит — одним оператором, параметри `$n`).
- [x] **Step 4:** Run unit, typecheck, lint обох пакетів; scoped DB `pnpm --filter @simetrajs/designer test:db roles-tool engine-census` (≈20 с) і `pnpm --filter simetra test:db provider-roles`.
- [x] **Step 5: Commit** — `fix(roles): гейт відхиляє шлях від ролі запиту до керівника ролі платформи`.

---

### Задача 7: документи й борг

- [x] **Step 1:** Спека прав §7 — за Рб1-4; §4.7 — за Рб1-8 (лише після «так»).
- [x] **Step 2:** Борг прав §1 — зняти закриті пункти (snake_case, `id`, `search_path`, `rowLevelSecurity`, шлях `SET`, FK — якщо закрито); правило файлу — пункт знімається з посиланням на цей план.
- [x] **Step 3:** Скіл споживача `packages/designer/skills/simetra-metadata/*` — якщо зачеплено (FK на ключ; незмінний `id`); `docs/ROADMAP.md` — рядок прав, якщо стан змінився.
- [x] **Step 4:** Run `python3 scripts/check-doc-anchors.py && pnpm format:check`.
- [x] **Step 5: Commit** — `docs(rights): борг перед першою міграцією закрито`.

---

## Критерії приймання

- Близнюк кожної фікстури прав у `snake_case` компілюється без діагностик і дає той самий SQL; DB-опис повного циклу в `snake_case` зелений.
- Ключ `id` таблиці виду не змінює ніхто: власник, режим обслуговування, команда — `effect`.
- Згенерована функція без `SET search_path = ''` ламає компіляцію.
- Реєстр видів не має неявного RLS.
- Шлях від ролі запиту до керівника ролі платформи — відмова гейта.
- Кожна мутація з задач червоніє; перелік — у звіті.
- Повні гейти на одному SHA (лише з «можна»): `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`.
