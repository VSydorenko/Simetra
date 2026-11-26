# План D1 М5d: умовний `publicRead` — сервер

> **Статус:** план на приймання архітекторкою М5d (`SimplyCMS-architect`).
> Блок — #439. Анкери — на `main` (`bc3b2678`); незмерджених залежностей немає.
> B2 М5c (#403) і D5 (#443) ще не виконані — їхні стики в Р-D1-13 і задачі 4.
> B7 (#408) виконується в `compiler/platform` — блок цих файлів не чіпає. Шар
> `data/**` блок не змінює (бриф: інакше розвилка через `m4-sk-architect`).
> Спільний ресурс — пул стеків `postgres`: не зупиняти й не перезапускати чужий
> стек; прогін рівня `db` — по одному на стек. Профіль — лише `postgres`
> (ADR-0117): жодного `*.supabase.db.test.ts`. Рівні `unit`, `db` і `e2e` CI
> запускає сам на кожен push чорнового PR; локально — лише цільові форми задач,
> без повного рівня. Автор плану DB-тестів не запускав.

## 1. Мета, архітектура, спека

**Мета.** Довідник може відкрити гостю чи автентифікованому лише опубліковані
рядки: `publicRead: { role, published: true }`. Чернетку бачить лише той, хто має
`read` у своєму тенанті. Публікація — окреме право й окрема дія; позначка
видалення знімає публікацію.

**Архітектура.** Умову V = `published AND NOT deletion_mark` дає один будівник
у `compiler/rights/**` як дані (Р-D1-3); політики, `rowBranch`, пояснення,
копії в ТЧ, каталог і згодом T4 (D2) — її рендери. Роль умовної форми лишається
в `AccessContract.publicRead` (стик з D5), колонки V — нове поле контракту
(Р-D1-2). `publish`/`unpublish` — стандартні дії-переходи за прецедентом
`markDeletion` (Р-D1-8, Р-D1-11).

**Спека.** [публічна частина](../specs/2026-11-25-public-app-part-design.md)
§3 (рядок D1), §4 (рядки з власником D1), §5.1, §6, §7 OQ-2, §8.
ADR-0119, ADR-0118, ADR-0102. [права](../specs/2026-10-17-rights-design.md)
§5.1 (пояснення), §5.2 (політики читання, копії носіїв), §5.4 (гейт планів).
[мультимовні дані](../specs/2026-11-24-multilingual-data-design.md) §3 (рядок
B3), §5.3 (копії `published` і `deletion_mark` у таблиці перекладів).

## 2. Глобальні обмеження

- Рядкова форма `publicRead` поводиться як раніше: SQL, каталог рантайму,
  `kernelHash` і сигнали об'єкта без умови не змінюються (наявні тести
  генераторів і знімок еталону до появи нового довідника).
- Кожен новий код правила — у `COMPILER_RULES` (`compiler/diagnostics.ts`) з
  повідомленням `uk`/`en` у `compiler/messages.ts` (тест повноти
  `messages.test.ts`).
- Нові значення `ObjectOperation` — лише в кінець `OBJECT_OPERATIONS` і
  `operationSchema` (`model/runtime/operation.ts`): `model/runtime/envelope.ts`
  розбирає варіанти за позицією.
- Без шимів: `publicReadUsing` (текст) видаляється в тій самій зміні, де
  з'являється будівник.
- DB-тест лишає стенд чистим (транзакція з відкатом або об'єкти з тегом прогону —
  `test/db/connection.ts`). Тести тригерів пишуть від власника таблиці з
  виставленим контекстом команди, тести грантів і політик — від справжніх ролей
  профілю (`queryAs`, `commandAs`).

## 3. Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р-D1-1 | **Форма T0.** `publicReadSchema` (`model/schemas/public-read.ts`) — об'єднання рядка `"anon" \| "authenticated"` і `z.strictObject({ role, published: z.literal(true) })`; схема одна для всіх видів, відмови — правилами (Р-D1-13). Хелпер T0 дає роль і ознаку умови з обох форм — єдине місце розбору. JSON-схеми видів (`packages/simetra/schemas/*.schema.json`) оновлює `pnpm schemas:update`. | none |
| Р-D1-2 | **Контракт доступу.** `AccessContract.publicRead` лишає призначення ролей для обох форм (стик D5). Нове поле `published?: { column: string; mark: string }` — фізичні колонки V цієї таблиці: на шапці — `published` і `deletion_mark`, на ТЧ — копії (Р-D1-9). Будівник контрактів (`compiler/access-units.ts`) для кожної таблиці умовного об'єкта без колонок V кидає внутрішню помилку — ніколи не відкритий доступ (unit-тест; мутація «пропустити таблицю без колонок» червона). Предикат `opensEveryRow(contract)` = `publicRead` непорожній і `published` відсутнє; на нього переходять читачі «всі рядки відкриті»: `readBoundaries` і пропуск `<t>_read_*` у `buildAccessUnits`, `rowBranch` і `boundaries` (`compiler/rights/require-units.ts`), `branch` і `explainRows` (`compiler/rights/explain-units.ts`), `SignalFacts.publicRead` (`compiler/signal/units.ts`), `publicReadOf` (`compiler/runtime-catalog.ts`). Новий читач поза переліком (`orient publicRead` перед задачею 1) — рядок архітекторці. | none |
| Р-D1-3 | **Будівник умови публічного читання** (*інтерфейс для B6-2, на приймання*). Модуль `compiler/rights/public-read.ts`, форма — §4. Умовна форма дає `rowLiteral` колонки `published` зі значенням `true` і колонки позначки з `false`; роль `authenticated` з функцією користувача — `validUser`; порожній масив — `true`. Нові варіанти `RightsCondition` (`compiler/rights/predicates.ts`) рендерить `renderCondition(condition, row?)`: `<row>.<col>` чи `NOT <row>.<col>`; `current_user_id() IS NOT NULL`. Пояснення підставляє `validUser` для свого суб'єкта. `publicReadUsing` видаляється, `publicReadNeedsUser` переїжджає в модуль. `coalesce` немає: `NULL` копії — рядок невидимий. | права §5.4 — умови `rowLiteral`/`validUser` у формі предиката (задача 0) |
| Р-D1-4 | **Політики** шапки й ТЧ умовного об'єкта: `<t>_public_read` — ті самі ролі, `USING` = рендер Р-D1-3; `<t>_scope_read` — `RESTRICTIVE … USING (V OR <межа>)`, лівий диз'юнкт — рендер лише `rowLiteral` будівника; `<t>_read_*` повертаються. Межі й політики запису не змінюються. | права §5.2 — абзац «Умовний `publicRead`» (задача 0) |
| Р-D1-5 | **`rowBranch`**: `key AND ((<умови Р-D1-3>) OR (<межа тенанта> AND <право read>))` для пари з викликачами `READ_CALLERS`; інша пара — лише права, як сьогодні. | права §5.4 — форма `(V AND …) OR <права>` (задача 0) |
| Р-D1-6 | **Пояснення.** `explainRows` умовного об'єкта дає рядок `public_read` (`carrierMatch` — рендер будівника для суб'єкта), рядки `<t>_read_*` і `scope_read` з `carrierMatch` = `V OR <межа>`. Виняток «`p_user` поза скоупом рядка» (`branch`) діє лише для `V AND NOT validUser`, і тоді лише рядок `public_read`: рядки `<t>_read_*` і `scope_read` несли б `has_right`, `carrier_match` і `roles` користувача іншого тенанта (`predicateRow`) — їх немає, коли `p_user` поза скоупом рядка. | права §5.1 — виняток лише для опублікованого рядка (задача 0) |
| Р-D1-7 | **OQ-2 закрито: пояснення не є оракулом існування чернетки.** `branch` уже вимагає видимості рядка викликачу (`visibility` над рядками `CALLER`) і гейту аналізу; з Р-D1-6 невидима викликачу чернетка дає порожній результат, як випадковий id. Розвилки немає. | §7 — OQ-2 закривається (задача 0) |
| Р-D1-8 | **Колонка й переходи (реєстр).** `catalogKind.standardColumns(obj)` (`model/kinds/catalog.ts`) за умовною формою дає `published boolean NOT NULL DEFAULT false` (поруч із `deletionMarkColumn`, `model/kinds/standard.ts`). `actions(obj)` дає `publish` (`transition { column: "published", from: false, to: true }`) і `unpublish` (`true → false`), `requires: []` — лише `⇒ read` (`actionRequires`). Обидва слова — у `STANDARD_ACTIONS` (`model/kinds/actions.ts`): їх беруть `withAction` (`model/schemas/rights.ts`) і `STANDARD_WORDS` (`compiler/rights/role-checks.ts`); кастомна дія `publish` — відмова зайнятого слова (тест). `rightsContract` збирає `published` у `transitions`, виключає з `"all"` і з INSERT-гранту ролі команд — наявним шляхом колонок переходів. | П2 — колонка й дії (задача 0) |
| Р-D1-9 | **Копії в ТЧ.** `carrierDeclarations` (`compiler/rights/facts.ts`) — нове `field: "publication"`: дві декларації (`published`, `deletionMark` шапки), безумовні для умовного об'єкта; посилання стадії 2 — поруч з `ownershipReferences` (`model/kinds/standard.ts`) і в `carrierRefs` (`compiler/stages/model.ts`). `resolveCarrier` (`compiler/rights/carriers.ts`) приймає стандартну булеву колонку шапки лише для `publication`; для інших полів `rights.carrier-not-ref` — як досі. Ім'я копії — ім'я колонки шапки, зайняте — `rights.carrier-column-taken`. Далі — наявні `addCarrierCopies`, тригери derive/propagate і крок `carriers`; пряму зміну копії derive перезаписує. Те саме джерело — вхід B3; `carrierColumn` під таблицю перекладів D1 не узагальнює. | права §5.2 — копія умови в ТЧ (задача 0) |
| Р-D1-10 | **Позначений рядок не публікується** на шляху команд. Заголовок ефектів `markDeletion` умовного об'єкта містить і `published`; `KindAction` отримує пов'язану колонку (назва поля — на розсуд виконавця). Тригер ефектів (`updateChecks`, `compiler/rights/effects-units.ts`): під `markDeletion` — `NEW.published = false` в обидва боки позначки; під `publish` — відмова за `NEW.deletion_mark`. Ядро (`markDeletionFunction`, `compiler/catalog-command/units.ts`) ставить `published = false` і при позначці, і при знятті; `publish` позначеного — `command.invalid` з новою причиною `marked` (`COMMAND_CORE_ERRORS.invalid`, `model/runtime/core.ts`; відображення відмови в T3 — `server/errors.ts`). CHECK `NOT (published AND deletion_mark)` відкинуто: стан досяжний для привілейованих писачів (спека §6), а з CHECK мутація «`NOT deletion_mark` прибрано з умови» не мала б свідка. | none (ADR-0119 п.2) |
| Р-D1-11 | **Операції й ядро.** `publish`/`unpublish` — значення `ObjectOperation` у кінці переліку; варіанти `operationSchema` з `object`, `id`, `expectedVersion`; `OPERATION_EVENTS` — `write`. Ядро: мітки `CATALOG_COMMAND_LABELS`, `actionsOf` (`compiler/catalog-command/contracts.ts`), функції `<t>_publish(uuid, bigint)`/`<t>_unpublish` за скелетом `markDeletionFunction`. Сигнал переходу — `op: "update"`: перелік `op` не змінюється ні в `model/runtime/signal.ts` (його розбирає приймач T4), ні в `CHANGE_OPS` (`compiler/signal/units.ts`). T3: `callOf` і `checkDraft` (`server/phase.ts`), `wireOperationSchema` (`envelope.ts`); вичерпні `Record<ObjectOperation, …>` знаходить typecheck. Цілі `operations.publish`/`unpublish` каталогу рантайму (`operationsOf`) — лише в умовного об'єкта. | П4 — перелік операцій (задача 0) |
| Р-D1-12 | **Каталог рантайму.** `publicReadOf` дає `publicRead` лише за `opensEveryRow`; умовний — `publicReadPublished: "anon" \| "authenticated"` (нове поле `RuntimeObject`, `model/runtime/catalog.ts`). Клієнтський каталог (`entryOf`, `compiler/client-catalog.ts`) у D1 його не переносить — це D2; `publicRead` умовного там немає, тож `publicReadCovers` T4 його не відкриває. Текст правила в `compiler/messages.ts` («publicRead … opens every row») уточнюється. | none |
| Р-D1-13 | **Правила відмов** (`compiler/rights/checks.ts`, поруч із `rights.public-read-forbidden`): `rights.public-read-published-kind` — вид без `commandWrites`; `rights.public-read-published-rights` — проєкт без функцій прав (`hasRightsFunctions`); `rights.public-read-published-read` — об'єкт без контракту прав з дією `read`. Покажчик — `/publicRead`. `rights.public-read-forbidden` судить `!== undefined` — діє на обидві форми, тест додається. Стик B2: правило `languages.public-read` на `main` на початку задачі 2 — задача додає тест умовної форми на «Мовах»; інакше тест пише B2 (Р-B2-2 відмовляє будь-якій формі). | none |
| Р-D1-14 | **План T2.** Увімкнення умови й вимкнення (видалення `published` — руйнівний крок з `dataLoss` і дозволом) — наявні кроки. «Умовний → рядковий» — нова множина id кроків поруч із `foreignChanges` (`schema/apply/steps.ts`): кроки двигуна, що лишають `<t>_public_read` таблиці, яка в `applied` мала умову, без неї; дозвіл за id, окремий від дозволу на видалення колонки. Ключ виявлення — на розсуд виконавця; результат фіксований: дозволу вимагає й випадок, коли в тій самій зміні з'являється реквізит з фізичним ім'ям `published`. Зайвий дозвіл на хибній тривозі — безпечний. | none (§5.1 «План» уже вимагає) |
| Р-D1-15 | **Поправка done-when §3 D1** (*на приймання*): рядок «під `simetra_command` без контексту `UPDATE … SET published = true` зачіпає 0 рядків, а `INSERT` з `published = true` — відмова `WITH CHECK`» не відповідає коду. Політики запису довідника кличуть строгий `command_root` (`compiler/rights/command-units.ts`), запобіжник `command_action()` теж строгий: без контексту обидва запити дають `command.context` `missing` (випадок `no-context`, `test/db/rights-write.db.test.ts`); `INSERT` з `published` першим відмовляє колонковий грант. Нове формулювання — інваріант 12. | §3 рядок D1 (задача 0) |
| Р-D1-16 | **Свідок мутації «лівий диз'юнкт — `published` замість V»** (*на приймання*). Глобальна роль дій над скоупленим об'єктом не дає (`levelActions`, `compiler/rights/expand.ts`), гранти рівня скоупу з'єднані з членством (`compiler/rights/functions.ts`): для них `<t>_read_*` ⇒ межа, і мутація на рівні БД еквівалентна. Не перевірено: контейнерна роль (гранти рівня контейнера членства не з'єднують) і вид скоупу з дослівною `setFunction`, вужчою за множину прав. Задача 8 спершу шукає такого свідка: є — DB-мутація за спекою, і поправка не потрібна; немає — генераторний тест (`USING` `<t>_scope_read` — рендер `rowLiteral` будівника) і поправка §3. | §3 рядок D1 — лише за відсутності свідка (задача 0) |

## 4. Інтерфейси

Дає (власник — D1, спека §4):

- **Форма T0** `publicRead: { role, published: true }` і правила Р-D1-13 — D2, D3,
  D6, B3.
- **Будівник умови** `publicReadConditions(contract: AccessContract,
  sessionUser: boolean): RightsCondition[]` у `compiler/rights/public-read.ts`
  (Р-D1-3) — AND умов: `{ kind: "rowLiteral"; column: string; value: boolean }`
  (фізична колонка таблиці контракту = літерал) і `{ kind: "validUser" }`
  (дійсний користувач сесії). Для `m4-sk-architect` — у перевизначення B6-2:
  нейтральне дерево ADR-0102 бере ці вузли, фізичну колонку на носій каталогу
  відображає рендер B6-2.
- **Колонки V таблиці** — `AccessContract.published` (Р-D1-2); джерело копії
  носія `field: "publication"` — для B3.
- **Колонка `published`, дії й операції `publish`/`unpublish`, ефект
  `markDeletion`** — D4, D6, D7. Точка переходу для D4 — `Change.operation` у
  `CommandResult.changes` (`model/runtime/result.ts`) зі значеннями `publish`,
  `unpublish`, `markDeletion`, `update`: D4 фільтрує зміни після коміту без змін
  коду D1.
- **Поле каталогу рантайму** `publicReadPublished` — D2.

Бере: нічого.

## 5. Інваріанти безпеки

Суб'єкти DB-тестів: гість (`anon`), користувач тенанта A з `read`, користувач
тенанта B з `read`, автентифікований без прав, адміністратор прав тенанта A,
роль команд з контекстом і без нього, власник таблиці. Стани рядка шапки:
чернетка A, чернетка B, опублікований A, опублікований B, опублікований і
позначений A (засів від власника); кожен — з рядком ТЧ.

1. **Гість бачить лише опубліковані непозначені** — прямий `SELECT` шапки й ТЧ.
   *Мутації:* умову прибрано з `<t>_public_read`; `NOT deletion_mark` прибрано з
   будівника — гість бачить чернетку чи позначений рядок.
2. **Межа тенанта на чернетці.** Користувач A з `read` бачить чернетки A і не
   бачить чернеток B — шапка й ТЧ. *Мутації:* межа без лівого диз'юнкта —
   опублікований рядок B невидимий користувачу A, червоне; лівий диз'юнкт —
   лише `published` — за Р-D1-16.
3. **Автентифікований без прав** при ролі `authenticated` бачить лише
   опубліковані.
4. **Новий рядок — чернетка.** `create` повертає рядок (`RETURNING` під роллю
   команд), `update` змінює чернетку. Від власника з контекстом `create`:
   `INSERT` з `published = true` — відмова тригера ефектів. *Мутація:* прибрати
   відмову не типового значення в `mainBody` — тест власника червоний.
5. **Публікація — окреме право.** `publish` без права — `command.forbidden`; з
   правом `publish` без `update` — успіх; `published` у `values` `update` —
   відмова (код і шар фіксує тест; рядок не змінився); прямий `UPDATE … SET
   published = true` під контекстом `update` — `command.forbidden` `effect`.
   *Мутація:* `published` в `"all"` `update` — тест `values` червоний.
6. **Зміст опублікованого рядка.** `update` опублікованого рядка гість бачить
   одразу.
7. **Позначка знімає публікацію, позначений не публікується** (Р-D1-10).
   `markDeletion` опублікованого — `published = false`; зняття позначки дає
   чернетку; «позначка → `publish` → зняття» від користувача A з `read` і
   `publish` — `publish` дає `command.invalid` `marked`, рядок невидимий гостю.
   Від власника з контекстом: `markDeletion` з `published = true` у `NEW` і
   `publish` позначеного — відмова. *Мутації:* ядро без `published = false`;
   перевірку `marked` у ядрі прибрано (команда дає відмову тригера, а не
   `command.invalid`); кожну гілку тригера прибрано — кожна червона.
8. **Копія в ТЧ.** Зміна `published` шапки доходить до копії; пряма зміна копії
   не діє. *Мутація:* копія не оновлюється за шапкою — гість бачить рядок ТЧ
   знятої з публікації шапки.
9. **Пояснення — не оракул** (Р-D1-6, Р-D1-7). Адміністратор A:
   `rights_explain` для чернетки B і для випадкового id — той самий порожній
   результат. Чернетка A з `p_user` поза A — порожньо (*мутація* «виняток `p_user`
   для всього умовного об'єкта» дає рядки — червоне). Опублікований A з `p_user`
   поза A — лише рядок `public_read` (*мутація* «рядки `<t>_read_*` при винятку» —
   червоне). Умовний об'єкт ролі `authenticated` у проєкті з `current_user_id()`
   (окрема фікстура, як `rights-analysis.db.test.ts`): опублікований A з `p_user`
   поза A і з випадковим uuid — однаково порожньо (*мутація* «виняток без
   `NOT validUser`» — червоне).
10. **Один будівник.** Для кожного стану й суб'єкта видимість за RLS і за
    `rowBranch` (`rights_require`) однакова; для викликачів, що проходять гейт
    аналізу, пояснення збігається з RLS. *Мутація:* другий шлях, що будує V
    інакше (наприклад, `rowBranch` без `NOT deletion_mark`), — тест рівності
    червоний.
11. **Сигнали.** Підписка на сигнал умовного об'єкта автентифікованим без `read`
    — відмова. *Мутація:* `subscribeCondition` повертає `true` — червоне.
12. **Межа довіри запису** (Р-D1-15). Під `simetra_command` без контексту
    `UPDATE … SET published = true` і `INSERT` на видимому рядку —
    `command.context` `missing`; `INSERT` з `published` під контекстом `create` —
    відмова колонкового гранту. *Мутації:* запобіжник і строгий `command_root`
    прибрано — обидва перші тести червоні; колонка в INSERT-гранті — відмова
    тригера ефектів, тест розрізняє шар за повідомленням.
13. **Гейт планів** (права §5.4): без `SubPlan` під роллю користувача й гостя на
    умовному об'єкті, шапка й ТЧ.
14. **Каталоги не відкривають умовного об'єкта** (unit): у каталозі рантайму й
    клієнтському немає `publicRead`, `publicReadPublished` — лише в рантайму.
    *Мутація:* `publicReadOf` без `opensEveryRow` — червоне.
15. **План T2** (unit, designer DB): вимкнення умови — руйнівний крок з
    `dataLoss` і дозволом; «умовний → рядковий» — окремий дозвіл за id, зокрема з
    новим реквізитом `published` (Р-D1-14). *Мутація:* прибрати множину — план
    проходить без дозволу.

## 6. Частини

Немає: кожен інваріант доводить DB-задача 8, тож частини окремо не приймаються.

## 7. Задачі

| # | Задача | Файли й модулі | Готово, коли | Після | Перевірка |
| --- | --- | --- | --- | --- | --- |
| 0 | Якорі й поправки спеки | план; спеки §8 цього плану | `orient --plan` і `doc anchors` чисті; поправки §8 внесено | — | `doc anchors docs/superpowers/plans/2026-11-26-public-app-d1-conditional-public-read.md` |
| 1 | Будівник і читачі | `compiler/rights/public-read.ts` (новий), `compiler/rights/predicates.ts`, `compiler/contracts.ts` (`AccessContract.published`), `compiler/access-units.ts`, `compiler/rights/require-units.ts`, `compiler/rights/explain-units.ts`, `compiler/signal/units.ts`, `compiler/runtime-catalog.ts` | `publicReadUsing` видалено; читачі Р-D1-2 — через `opensEveryRow`; unit над контрактом з `published`, побудованим вручну: політики Р-D1-4, `rowBranch` Р-D1-5, рядки пояснення Р-D1-6, факт сигналу; без `published` вивід не змінився | 0 | `run-tests unit --filter access-units` і `run-tests unit --changed` |
| 2 | Форма T0, колонка, дії, правила | `model/schemas/public-read.ts`, `packages/simetra/schemas/*.schema.json`, `model/kinds/catalog.ts`, `model/kinds/standard.ts`, `model/kinds/actions.ts`, `compiler/rights/contracts.ts`, `compiler/access-units.ts` (колонки V шапки, внутрішня помилка Р-D1-2), `compiler/rights/checks.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts` | обидві форми в схемі; колонка й дії лише за умовою; `transitions` з `published`; INSERT-грант без `published`; правила Р-D1-13 — рядок таблиці «файли → код → покажчик»; умовний об'єкт з ТЧ до задачі 3 — внутрішня помилка (тест) | 1 | `run-tests unit --changed` |
| 3 | Копії в ТЧ | `compiler/rights/facts.ts`, `compiler/rights/carriers.ts`, `compiler/rights/checks.ts`, `model/kinds/standard.ts`, `model/kinds/catalog.ts`, `compiler/stages/model.ts` | ТЧ умовного об'єкта має копії; `AccessContract.published` ТЧ — колонки-копії; `rights.carrier-not-ref` для інших полів не змінився (тест); зайняте ім'я — `rights.carrier-column-taken` | 2 | `run-tests unit --changed` |
| 4 | Каталог рантайму | `model/runtime/catalog.ts`, `compiler/runtime-catalog.ts`, `compiler/client-catalog.ts` (лише тест), `compiler/messages.ts` | інваріант 14; `kernelHash` об'єкта без умови не змінився; якщо D5 злито раніше: умовна форма ролі `authenticated` є в переліку діагностики `selfSignUp` | 2 | `run-tests unit --filter runtime-catalog` |
| 5 | Ефект `markDeletion` | `model/kinds/actions.ts`, `compiler/rights/effects-units.ts`, `compiler/catalog-command/units.ts` | unit: гілки `updateChecks` Р-D1-10; тіло `mark_deletion` з `published = false` (оновити `catalog-command-mark.test.ts`); без умови тіло не змінилось | 2 | `run-tests unit --filter effects-units` |
| 6 | Операції `publish`/`unpublish` | `model/runtime/operation.ts`, `model/runtime/envelope.ts`, `model/runtime/core.ts`, `model/runtime/catalog.ts` (`operations`), `compiler/catalog-command/contracts.ts`, `compiler/catalog-command/units.ts`, `compiler/runtime-catalog.ts` (`operationsOf`), `server/phase.ts`, `server/errors.ts`, `server/agent/*` | unit: схема й конверт приймають нові операції, старі індекси не зсунулись; функції ядра; диспетч T3; сигнал `update`; `Change.operation` несе нові значення; `publish` позначеного — `command.invalid` `marked` | 2, 5 | `run-tests unit --changed` |
| 7 | План T2 | `schema/apply/steps.ts`, `schema/apply/plan.ts`; DB-тест apply — новий файл `public-read-plan.db.test.ts` у `packages/designer/src/__tests__/` (як `storage-sql.db.test.ts`) | інваріант 15: unit на діях двигуна; DB через apply — увімкнення з наявними рядками дає чернетки й заповнені копії | 3 | `run-tests unit --filter steps` і `run-tests db --filter public-read-plan` |
| 8 | Еталон і DB-тести межі | `examples/reference/metadata` — новий довідник `Announcement` (скоуп `org`, ТЧ `Items`, `publicRead: { role: "anon", published: true }`, контракт прав з `read`; `Counterparty` і шаблон не змінюються); новий файл `public-read-published.db.test.ts` у `packages/simetra/test/db/` (оснастка `compileRights`, `deploy`, `queryAs`, `commandAs`; випадки запису — за таблицею `rights-write.db.test.ts`); гейт планів — у `rights-plan-gate.db.test.ts` | знімок і DDL еталону оновлено, `pnpm metadata:check` зелений; свідок Р-D1-16 знайдено чи ні — у звіті; інваріанти 1–13 зелені; кожна названа мутація перевірена червоною (звіт називає мутацію й тест) | 1–7 | `run-tests db --filter public-read-published` і `run-tests db --filter rights-plan-gate` |

## 8. Задача 0 — поправки спеки

- Спека публічної частини §3 рядок D1 — формулювання Р-D1-15 і, за
  відсутності свідка, Р-D1-16; §7 — OQ-2 закрито (Р-D1-7) з посиланням на
  DB-тест.
- Права §5.1 — виняток пояснення лише для опублікованого рядка й лише рядок
  `public_read` (Р-D1-6); §5.2 — абзац «Умовний `publicRead`»: межа
  `V OR <межа>`, `<t>_read_*`, копія умови в ТЧ (Р-D1-4, Р-D1-9); §5.4 — умови
  `rowLiteral`, `validUser` і форма `(V AND …) OR <права>` (Р-D1-3, Р-D1-5).
- П2 — форма `publicRead` з `published`, колонка `published`, дії
  `publish`/`unpublish`, ефект `markDeletion`, кроки плану вимкнення умови.
- П4 — операції `publish`/`unpublish` у переліку операцій ядра; сигнал переходу
  — `update`.
- Промоція §16 — рядок «`publicRead` з умовою — відкласти» закривається ADR-0119.
- П4-B §8.6 — підписка умовного об'єкта лише за правами.
- Мультимовні дані — без правок: §3 рядок B3 уже називає залежність від D1
  (будівник, джерело копії носія).
- Спеку ядра синхронізації й рядки §8 інших блоків (D2–D6) задача 0 не чіпає.

## 9. Задачі власника

Немає.

## 10. Підсумок аудиту

Раунд 1 — Sonnet «план проти спеки й коду» (з лінзою id рішень) і Opus «безпека
й старе покоління». Sonnet: три minor на виконуваність, внесено. Opus: безпекова
major — `publish` позначеного рядка й зняття позначки без права `publish`
відкривали рядок гостю (виправлено Р-D1-10, інваріант 7); major — очікування
«0 рядків» і `WITH CHECK` без контексту хибні (Р-D1-15). Раунд 2 — Opus на дифі
правок: нових витоків немає; і Codex (тригер — безпекова major): три major
чесності тестів, підтверджені кодом (Р-D1-16, інваріанти 9 і 10). Після раунду 2
автор закрив без нового раунду: внутрішню помилку для таблиці умовного об'єкта
без колонок V (Р-D1-2), рядки пояснення при винятку `p_user` (Р-D1-6), результат
виявлення Р-D1-14. Спростованих знахідок немає. Blocker і безпекових major — 0.
Вузький прохід Opus після них: витоків немає; одна minor — випадок ролі `authenticated` в інваріанті 9, внесено. Рішення на приймання з причинами — в описі PR.
