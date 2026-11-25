# План B2 М5c: довідник «Мови»

> **Статус:** план на приймання архітекторкою М5c (`SimplyCMS-architect`).
> Блок — #403, спека — #410. Анкери — на `main` (`e969ba59`); незмерджених
> залежностей немає. B7 (#408) виконується паралельно — його файлів блок не
> чіпає. Спільний ресурс — стенд `postgres` (один DB-слот М5c): не зупиняти й не
> перезапускати; прогін рівня `db` — по одному на стек. Профіль — лише `postgres`
> (ADR-0117): жодного `*.supabase.db.test.ts`. Рівні `unit`, `db` і `e2e` CI
> запускає сам на кожен push чорнового PR; локально — лише цільові форми задач.

## 1. Мета, архітектура, спека

**Мета.** Довідник з роллю `languages` — набір мов даних, що його B3–B8
споживають як дані: компілятор виводить з ролі колонки, CHECK, гранти, політики
й тригер; основна мова призначається раз у `project.meta.json` і з'являється в
базі засівом; інваріанти мов тримає база для будь-якого автора (ADR-0026).

**Архітектура.** Роль — новий запис `CATALOG_ROLES` (`model/kinds/catalog.ts`)
з новими фактами ролі; компілятор читає їх лише через поля реєстру видів
(`KIND_REGISTRY[kind].…`), без нових порівнянь `role === "languages"`. Таблиця й
команди — звичайний шлях довідника (`standardColumns`, `commandWriteColumns`,
`buildAccessUnits`, ядро команди). Нове: генератор тригера стану мови (одна
функція, один рядковий тригер плюс запобіжник `TRUNCATE`), політика читання
опублікованих рядків і колонковий грант гостя, тримач рівня проєкту в
`ASSIGNED_ONCE`, крок даних apply «засів передвизначених рядків» з одним
джерелом — основною мовою.

**Спека.** [мультимовні дані](../specs/2026-11-24-multilingual-data-design.md)
§3 (рядок B2), §4 (рядок ролі `languages`), §5.2; споживачі — §5.3 (`language_id`,
фільтр `state = 'published'` у `<t>_public_read`), §5.4 (брама публікації в
тригері B2), §6, §8 (П2 і права — правки B2). ADR-0113, ADR-0115, ADR-0026.
Платформна спека Р24 (передвизначені елементи, засів `ON CONFLICT DO NOTHING`).

## 2. Глобальні обмеження

- Факти ролі — лише в `CATALOG_ROLES`; споживачі в compiler/schema читають їх
  через поля `KindDefinition`, як `globalRoot` і `rightsSystem`. П'ять наявних
  порівнянь `role === "users"` блок не множить і не переробляє.
- `publicRead`, `users`, довідники прав і наявні DB-тести поводяться як раніше:
  нова політика й грант — окремий шлях лише для таблиці з фактом ролі.
- Кожен новий код правила — у `COMPILER_RULES` (`compiler/diagnostics.ts`) з
  повідомленням `uk`/`en` у `compiler/messages.ts` (тест повноти
  `messages.test.ts`).
- Новий платформний тригер реєструється в `platformTriggers`
  (`compiler/platform-triggers.ts`), а BEFORE-мітка — у
  `PLATFORM_BEFORE_ROW_LABELS` (`compiler/before-trigger-names.ts`); очікування
  вмісту платформи — у `packages/designer/src/schema-engine/__tests__/platform-content.support.ts`.
- Згенерований SQL перевіряють тести генератора й DB-тести на стенді, ніколи
  ручне застосування до живої бази.
- DB-тест лишає стенд чистим (транзакція з відкатом або об'єкти з тегом прогону —
  `test/db/connection.ts`).

## 3. Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р-B2-1 | Роль `languages` у переліку `role` (`model/schemas/catalog.ts`) і в `CATALOG_ROLES`. Факти ролі в `CatalogRoleDefinition`: `columns` (`state`, `isPrimary` одразу після позначки видалення), `requiredScope: "none"`, `codeForm` (`codeType: "String"`, `codeLength: 12`, `autonumber: false`, `codeUnique: true`, CHECK BCP 47 §5.2 на стандартній колонці `code`), `actions: "noDelete"` (`read`, `create`, `update` — без `markDeletion` і `delete`), `fixedColumns` (поза грантами ролі команд, нижче), `publishedRead` (Р-B2-5), `predefinedSeed` (Р-B2-7), `languageState` (Р-B2-4), `notMarked` (CHECK `NOT deletion_mark` на таблиці ролі). Нові поля `KindDefinition` віддають їх споживачам; серед них — поле, що ідентифікує довідник ролі (`languagesCatalog: (obj) => boolean`, за зразком `globalRoot`/`rightsSystem`): за ним правила Р-B2-2, засів Р-B2-7, а згодом B3 (FK `language_id`) і B4 (`rights_require`) знаходять «Мови» без порівняння імені ролі. | П2 §5 — абзац «Мови» поруч з «Користувачі й авторство» (задача 0) |
| Р-B2-2 | Невідповідність фактам ролі — відмова компілятора, а не тихе перевизначення. Коди правил: `languages.catalog-duplicate` (більше одного довідника з роллю), `languages.scope-not-none`, `languages.code-form` (кожне з `codeType`, `codeLength`, `autonumber`, `codeUnique` окремою діагностикою з покажчиком на поле), `languages.description-required` (`descriptionLength` 0: найменування входить у грант гостя), `languages.public-read` (`publicRead` на довіднику з роллю: факт ролі вже дає читання опублікованих, а `publicRead` відкрив би гостю рядки `draft`), `languages.predefined-items` (оголошені `predefinedItems`: передвизначений рядок ролі виводиться, а мови додають даними), `languages.primary-missing` (довідник з роллю без основної мови в проєкті), `languages.primary-without-catalog` (основна мова без довідника). Перевірка — у стадії цілісності поруч із `checkUsersCatalogs` (`compiler/stages/integrity.ts`). «Мультимовний реквізит без довідника» — правило B3. | П2 §5 (той самий абзац) |
| Р-B2-3 | Гранти ролі команд (`commandWriteColumns`, `compiler/rights/command-columns.ts`): `isPrimary` — поза INSERT і UPDATE; `code` — поза UPDATE (у INSERT); `state` — поза INSERT (DEFAULT `'draft'`), в UPDATE; `deletion_mark` — поза INSERT і UPDATE (позначки видалення «Мови» не мають, ADR-0115). Механізм — факт ролі `fixedColumns` замість нового прапорця на `StandardColumnDef` (прецедент `usersFixed`, але з реєстру, а не за ім'ям ролі). Перевірки, що вже читають цей перелік (`rights/checks.ts`, `catalog-command/contracts.ts` — шапка ядра називає лише оновлювані колонки), дістають факт тим самим шляхом. Наслідок для ядра: `code` у ключі таблиці (`keyColumns`, `catalog-command/units.ts`) більше не потрапляє в `SET` оновлення. | none |
| Р-B2-4 | **Тригер стану мови — одна функція й один рядковий тригер** `BEFORE INSERT OR UPDATE OR DELETE` на таблиці ролі. Функція `SECURITY DEFINER`, `search_path = ''`, `SET row_security = off`, без `EXECUTE` для будь-кого (`definerTrigger` у `compiler/rights/definer.ts`); тіло збирається з частин (рядки за `TG_OP`), за зразком `buildEffectsUnits`. Відмови — `22023` `command.invalid` з `DETAIL` причиною (`COMMAND_CORE_ERRORS.invalid`, `model/runtime/core.ts`), нова причина `language-state`. Правила: `INSERT` з `is_primary = false` і `state <> 'draft'` — відмова; `UPDATE` зміни `is_primary` чи `code` — відмова; `UPDATE` `deletion_mark` на `true` — відмова (а `INSERT` з `deletion_mark = true` тримає CHECK `NOT deletion_mark`, Р-B2-1); перехід стану поза дозволеними (матриця нижче) — відмова; `DELETE` — відмова. Окремий запобіжник `BEFORE TRUNCATE` рівня оператора (прецедент `compiler/rights/guard-units.ts`). BEFORE-мітка — у `PLATFORM_BEFORE_ROW_LABELS` перед `simetra_touch`, щоб відмовлений запис не брав версію. | none (§5.2 уже це вимагає) |
| Р-B2-5 | **Читання опублікованих — факт ролі, не `publicRead`.** Нове поле `AccessContract` (наприклад `publishedRead: { stateColumn, guestColumns }`) з факту ролі. `buildAccessUnits` дає: `PERMISSIVE FOR SELECT` політику `<t>_published_read` (ім'я не збігається з `<t>_public_read`) `TO <гість>, <користувач>, simetra_command USING (state = 'published')`, незалежну від функцій прав (як `publicRead`); `tableGrants` — колонковий `GRANT SELECT (id, state, code, description) … TO <гість>` (імена — фізичні, з колонок таблиці). Користувач і роль команд отримують звичайний табличний SELECT; решта рядків — політики читання за правами довідника, які для цієї таблиці лишаються (на відміну від `publicRead`, що їх вимикає). Межа «Користувачів» і межа тенанта цієї таблиці не стосуються (скоуп `none`). Пояснення прав (`compiler/rights/explain-units.ts`, перелік політик пояснення) отримує рядок `published_read` з умовою `state = 'published'`: пояснення збігається з RLS викликача (права §5.1). | права §5.2 — абзац «Читання опублікованих рядків «Мов»» (задача 0) |
| Р-B2-6 | **Основна мова — поле `primaryDataLanguage` у `projectSchema`** (`model/schemas/project.ts`): рядок за тим самим регексом BCP 47, необов'язковий; окремий від `defaultLocale` (мова інтерфейсу, ADR-0113 «Consequences»). `ASSIGNED_ONCE` (`model/named-elements.ts`) отримує тримача `on: "project"` для цього поля; `compiler/assigned-once.ts` реєструє корінь проєкту як тримача без `id` (ключ — `PROJECT_FILE`); зміна чи видалення наявного значення — `identity.assigned-once-changed` з покажчиком `/primaryDataLanguage`; поява значення там, де його не було, — не зміна. *Назва поля — публічний API, на приймання архітекторки.* | §5.2 — назва поля (задача 0); П2 — рядок про тримача рівня проєкту |
| Р-B2-7 | **Засів — крок даних apply загальної форми** (рішення архітекторки, варіант А): факт T1 «передвизначені рядки до засіву» (таблиця, мітка `predefined_name`, значення колонок) → крок `INSERT … ON CONFLICT (predefined_name) WHERE predefined_name IS NOT NULL DO NOTHING` у `schema/apply/plan.ts` після DDL (тригери вже є). B2 дає йому одне джерело: роль `languages` з кодом `primaryDataLanguage` — рядок з `id` від `gen_random_uuid()`, `code`, найменуванням (`code`, доки B8 не дасть редагування), `state = 'published'`, `is_primary = true`, сталою міткою ролі. Тригер Р-B2-4 пропускає таку вставку (основна мова). Мітка живе лише в даних засіву: функції пошуку `<t>_predefined` компілятор сьогодні не генерує взагалі (`lookupFunction` — лише ім'я в `PredefinedContract`, `compiler/contracts.ts`), а споживачі знаходять основну мову за `is_primary`. Факт T1 — новий контракт скомпільованої моделі (поруч із контрактами в `compiler/contracts.ts`), який компілятор будує з поля реєстру Р-B2-1 і `primaryDataLanguage` проєкту; apply читає лише його, а не `project.meta.json`. Прецедент кроку даних із факту компілятора — `carrierBackfillSteps` (`schema/apply/carrier-backfill.ts`), підключений у `plan.ts`; крок засіву отримує нове значення `PlanStep.origin` (`schema/apply/steps.ts`, закритий перелік). Загальний засів `predefinedItems` і функція пошуку за міткою (Р24) пізніше лише додають джерела в цей крок. | §5.2 — одне речення «засів — крок даних apply» (задача 0) |
| Р-B2-8 | **Розбіжність засіву й конфігу — відмова apply.** Перед засівом крок перевіряє: у таблиці вже є рядок з `is_primary` і `code` ≠ `primaryDataLanguage` → apply відмовляє з кодом правила (`apply.primary-language-changed` у `COMPILER_RULES` і `messages.ts`; `applyDiagnostic`, `schema/apply/diagnostic.ts`), `DO NOTHING` її не ковтає (ADR-0113: основну мову призначають раз). Перевірка — на етапі плану, читанням цілі через `dbs.reader` у транзакції з відкатом, за зразком `backfillChecks` у `plan.ts`: відмова до будь-якого кроку DDL; порожня таблиця чи збіг коду — без діагностики. | none |
| Р-B2-9 | **Шов для B4.** Функція Р-B2-4 має іменовану гілку «перехід не основної мови в `published`» — у B2 порожню; B4 додає в неї браму публікації, не створюючи другого тригера. Опції функції, яких брама потребує понад B2 (`SET lock_timeout`, перевірка `READ COMMITTED`), додає B4. | none |
| Р-B2-10 | Сигнали, клієнтський каталог і T4 факту `publishedRead` у B2 не читають: таблиця «Мов» для них — звичайний довідник без `publicRead` (сигнал іде за правами, гість сигналів «Мов» не отримує — fail-closed). Стан мов у T4 — B6. | none |
| Р-B2-12 | Обробник підписки `beforeWrite` на «Мовах» може спрацювати після тригера стану (BEFORE-тригери — за іменем) і переписати `state`, `is_primary` чи `code`. Спека §6 обмежує гарантію авторами, що пишуть не з тригера застосунку; B2 це не закриває. *На рішення архітекторки:* поширити на колонки ролі правило на кшталт `subscription.handler-assigns-carrier` (`compiler/stages/links.ts`) — окремим рядком спеки — чи лишити за §6. | none (або §6 — за рішенням) |
| Р-B2-11 | Еталонний проєкт `examples/reference/metadata` отримує довідник з роллю `languages` і `primaryDataLanguage`, щоб знімок і DDL-тести (`readReferenceDomain`) покривали роль. Шаблон застосунку (`packages/create-simetra-app/template`) не змінюється — довідник там з'явиться з B8. | none |

**Матриця переходів `state`** (§5.2; рядок — старий, стовпчик — новий; «—» — без зміни):

| | `draft` | `published` | `disabled` |
| --- | --- | --- | --- |
| `draft` | — | так | так |
| `published` | ні | — | так |
| `disabled` | так | так | — |

Пара `disabled ↔ draft` §5.2 — обидва напрямки. Для основної мови будь-який перехід з `published` відмовляє вже CHECK `NOT is_primary OR state = 'published'` (а не тригер).

## 4. Інтерфейси

Дає (власник — B2, спека §4):

- **Таблиця «Мов»:** стандартні колонки довідника + `state text` (CHECK
  `draft | published | disabled`, DEFAULT `'draft'`) і `is_primary boolean`
  (NOT NULL, DEFAULT `false`, `partialUnique` `is_primary`), CHECK основна лише
  `published`, CHECK форми `code`. Фізичні імена — за `naming.attributeCase`.
- **Читання опублікованих:** B3 фільтрує `language_id = ANY (ARRAY(SELECT id FROM
  <мови> WHERE state = 'published'))` під гостем, користувачем і роллю команд —
  це працює лише завдяки гранту `id, state` гостю й політиці `<t>_published_read`.
- **Тригер стану:** гілка Р-B2-9 для брами B4; причина `language-state`.
- **Факт T1 засіву** (Р-B2-7) — точка, куди загальний засів Р24 додасть джерела.
- **`primaryDataLanguage`** у `project.meta.json`; основну мову в базі
  знаходять за `is_primary` (функції пошуку за міткою немає — борг Р24).
- **Поле реєстру «довідник ролі `languages`»** — B3 (правило «мультимовний
  реквізит без довідника», FK `language_id`) і B4 (`rights_require` для «Мов»)
  знаходять таблицю за ним.

Бере: нічого.

## 5. Інваріанти безпеки

Кожен інваріант має два шари (грант чи CHECK і тригер). Тести тригера пишуть
від власника таблиці (обхід грантів і RLS), щоб видалення гілки тригера не
ховав грант; тести гранту й політик — від справжніх ролей профілю `postgres`
(`queryAs`).

1. **Щонайбільше одна основна.** Друга вставка `is_primary = true` — порушення
   часткового унікального індексу. *Мутація:* прибрати `partialUnique` —
   тест червоніє.
2. **Основна лише `published`; основну не вимкнути.** `UPDATE` основної в
   `disabled` чи `draft` від власника — відмова CHECK. *Мутація:* прибрати CHECK.
3. **`isPrimary` і `code` незмінні.** Від власника: зміна `is_primary` (обидва
   напрямки) і зміна `code` — `22023` `language-state`. Від ролі команд —
   `42501` (поза грантом). *Мутації:* гілка тригера для кожної колонки окремо;
   колонка в гранті UPDATE.
4. **Переходи станів.** Усі дев'ять пар матриці §3 від власника: дозволені
   проходять, заборонені — `language-state`. *Мутація:* дозволити
   `published → draft` — тест червоніє.
5. **`INSERT` не основної мови не в `draft`** — відмова; у `draft` — проходить.
   *Мутація:* прибрати гілку `INSERT`. Від ролі команд вставка з `state` —
   `42501` (поза грантом INSERT).
6. **Видалення й позначка видалення.** `DELETE` від власника — відмова тригера;
   `INSERT` з `deletion_mark = true` від власника — відмова CHECK `NOT deletion_mark`
   (*мутація:* прибрати CHECK); від ролі команд `deletion_mark` поза грантами — `42501`;
   `UPDATE deletion_mark = true` — відмова; `TRUNCATE` від власника — відмова
   запобіжника. Від ролі команд — немає гранту `DELETE` і немає політик дій
   `delete`/`markDeletion`. *Мутації:* кожна гілка окремо.
7. **Видимість ролям.** Гість бачить лише рядки `published` і лише колонки
   `id, state, code, description`: `SELECT` іншої колонки (наприклад `version`)
   — `42501`; рядки `draft` і `disabled` невидимі. Користувач без прав на «Мови»
   і роль команд від його імені бачать лише `published`; користувач з правом
   `read` бачить усі рядки. *Мутації:* політика без `state = 'published'` —
   гість бачить `draft`; табличний грант гостю замість колонкового — `SELECT`
   `version` проходить.
8. **`publicRead` на «Мовах» неможливий** — `languages.public-read` (unit).
   *Мутація:* прибрати правило — компіляція з `publicRead` проходить.
9. **Засів не ковтає зміну основної мови** (Р-B2-8): apply з іншим
   `primaryDataLanguage` над базою з основною мовою — відмова з кодом правила.
   *Мутація:* прибрати перевірку — apply проходить, а в базі лишається стара
   мова.

## 6. Частини

Немає: блок — один шар даних (T0–T2) з одним споживачем, ціна помилки однакова.

## 7. Задачі

| # | Задача | Файли й модулі | Готово, коли | Після | Перевірка |
| --- | --- | --- | --- | --- | --- |
| 0 | Якорі й поправки спеки | план; спеки мультимовних даних §5.2, П2 §5, права §5.2 | `orient --plan` і `doc anchors` чисті; поправки §8 цього плану внесено; Р24-дрейф (тригер предвизначених рядків не генерується) — рядок архітекторці, не латати | — | `doc anchors docs/superpowers/plans/2026-11-25-multilingual-b2-languages.md` |
| 1 | Роль і факти ролі в T0 | `model/schemas/catalog.ts`, `model/kinds/catalog.ts`, `model/kinds/standard.ts` (поля `KindDefinition`), `model/kinds/actions.ts` (`noDelete`) | роль у переліку; колонки `state`, `isPrimary` з CHECK і `partialUnique`; CHECK форми `code`; CHECK `NOT deletion_mark`; дії `read`, `create`, `update`; поле `languagesCatalog` і решта нових полів реєстру віддають факти; тести реєстру | 0 | `run-tests unit --changed` |
| 2 | Основна мова в проєкті й тримач рівня проєкту | `model/schemas/project.ts`, `model/named-elements.ts`, `compiler/assigned-once.ts` | `primaryDataLanguage` з перевіркою регексу; зміна й видалення — `identity.assigned-once-changed` `/primaryDataLanguage`, поява — ні; тест у `assigned-once.test.ts` | 1 | `run-tests unit --filter assigned-once` |
| 3 | Відмови компілятора Р-B2-2 | `compiler/stages/integrity.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`, новий тест поруч із `users.test.ts` | кожне правило має рядок таблиці «файли → код → покажчик»; позитивний випадок компілюється без діагностик | 1, 2 | `run-tests unit --changed` |
| 4 | Гранти ролі команд і читання опублікованих | `compiler/rights/command-columns.ts`, `compiler/access-units.ts`, `compiler/contracts.ts` (`AccessContract`), `compiler/rights/explain-units.ts`, споживачі переліку колонок (`rights/checks.ts`, `catalog-command/contracts.ts`) | unit-тести генератора: INSERT без `is_primary`, `state` і `deletion_mark`, UPDATE без `is_primary`, `code` і `deletion_mark`, без DELETE; рядок пояснення `published_read`; `<t>_published_read` для трьох ролей; колонковий SELECT гостю; політики прав читання на місці; для довідника без ролі вивід не змінився | 1 | `run-tests unit --filter access-units` |
| 5 | Тригер стану й запобіжник `TRUNCATE` | новий генератор у `compiler/` поруч із `hierarchy-units.ts`, `compiler/pipeline.ts`, `compiler/platform-triggers.ts`, `compiler/before-trigger-names.ts`, `platform-content.support.ts` | unit-тест тіла: усі гілки Р-B2-4 і порожня гілка Р-B2-9; `platform-triggers.test.ts` і `before-trigger-names.test.ts` зелені | 1 | `run-tests unit --changed` |
| 6 | Засів і перевірка розбіжності | `compiler/contracts.ts` (контракт засіву), `schema/apply/plan.ts`, `schema/apply/steps.ts` (`PlanStep.origin`), `schema/apply/diagnostic.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`; прецедент — `schema/apply/carrier-backfill.ts` | unit-тест плану apply: крок засіву після DDL, ідемпотентний; перевірка Р-B2-8 на етапі плану до DDL | 1, 2, 5 | `run-tests unit --filter plan` |
| 7 | Еталонний проєкт | `examples/reference/metadata` (довідник ролі, `primaryDataLanguage`) | знімок і DDL еталонного проєкту оновлено; `pnpm metadata:check` зелений | 3, 4, 5 | `run-tests unit --changed` |
| 8 | DB-тести інваріантів | новий файл `languages.db.test.ts` у `packages/simetra/test/db/` (компіляція з фікстури, `renderDesiredState`, `withRollback`, як `mechanics.db.test.ts`; ролі — `queryAs`); засів і Р-B2-8 — через apply дизайнера (`withModelTarget`, як `storage-sql.db.test.ts`), новий файл `languages-seed.db.test.ts` у `packages/designer/src/__tests__/` | інваріанти 1–7 і 9 §5 зелені, кожна названа мутація перевірена червоною (звіт називає мутацію й тест) | 4, 5, 6 | `run-tests db --filter languages` |

## 8. Задача 0 — поправки спеки

- Спека мультимовних даних §5.2: назва поля `primaryDataLanguage`; речення
  «засів — крок даних apply; розбіжність коду основної мови в базі й у конфігу —
  відмова apply»; ім'я політики `<t>_published_read` і причина `language-state`.
- П2 §5: абзац «Мови» поруч із «Користувачі й авторство» — роль, факти ролі,
  правила Р-B2-2; тримач рівня проєкту в переліку полів, призначених раз.
- Права §5.2: абзац «Читання опублікованих рядків «Мов»» (Р-B2-5), і
  `languages` у переліку довідників, де `publicRead` — помилка компілятора.
- Платформна спека Р24 не змінюється: загальний засів `predefinedItems` і тригер
  предвизначених рядків — борг (рядок архітекторці, issue заводить вона).

## 9. Задачі власника

Немає.

## 10. Підсумок аудиту

_Заповнює авторка після аудиту._

**Рішення на приймання:** Р-B2-2 (набір правил), Р-B2-3 (`state` поза
INSERT-грантом), Р-B2-5 (читання опублікованих окремим шляхом, не
`publicRead`), Р-B2-6 (назва `primaryDataLanguage`), Р-B2-11 (еталон, не шаблон).

**Борг:** загальний засів `predefinedItems` (платформна Р24) — у той самий крок
Р-B2-7; issue — архітекторка.
