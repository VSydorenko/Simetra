# План D1 М5d: умовний `publicRead` — сервер

> **Статус:** план на приймання архітекторкою М5d (`SimplyCMS-architect`).
> Блок — #439. Анкери — на `main` (`bc3b2678`); незмерджених залежностей немає.
> B2 М5c (#403) і D5 (#443) ще не виконані — їхні стики в Р-D1-14 і Р-D1-15.
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

**Архітектура.** Умова V = `published AND NOT deletion_mark` має один будівник
у `compiler/rights/**` (Р-D1-3). Його вихід — дані (умови «колонка рядка =
літерал» і умова дійсного користувача), SQL — їхній рендер. Політики,
`rowBranch`, пояснення, копії носія в ТЧ, каталог рантайму і згодом T4 (D2)
беруть V лише з нього. Роль умовної форми лишається в `AccessContract.publicRead`
(рішення архітекторки, стик з D5); ознака умови — нове поле контракту доступу.
Кожен читач, що трактує непорожній `publicRead` як «відкрито всі рядки»,
переходить на один предикат (Р-D1-2). Переходи `publish`/`unpublish` — стандартні
дії виду за прецедентом `markDeletion`, з операціями T0, ядром команди й
диспетчем T3.

**Спека.** [публічна частина](../specs/2026-11-25-public-app-part-design.md)
§3 (рядок D1), §4 (рядки з власником D1), §5.1, §6, §7 OQ-2, §8.
ADR-0119, ADR-0118, ADR-0102. [права](../specs/2026-10-17-rights-design.md)
§5.1 (пояснення), §5.2 (політики читання, копії носіїв), §5.4 (гейт планів).
[мультимовні дані](../specs/2026-11-24-multilingual-data-design.md) §3 (рядок
B3), §5.3 (копії `published` і `deletion_mark` у таблиці перекладів).

## 2. Глобальні обмеження

- Наявна рядкова форма `publicRead` поводиться як раніше: SQL, каталог рантайму,
  `kernelHash` і сигнали об'єкта без умови не змінюються. Перевірка — наявні
  тести генераторів і знімок еталонного проєкту до появи нового довідника.
- Кожен новий код правила — у `COMPILER_RULES` (`compiler/diagnostics.ts`) з
  повідомленням `uk`/`en` у `compiler/messages.ts` (тест повноти
  `messages.test.ts`).
- Нові значення `ObjectOperation` — лише в кінець `OBJECT_OPERATIONS` і
  `operationSchema` (`model/runtime/operation.ts`): `model/runtime/envelope.ts`
  розбирає варіанти за позицією.
- Без шимів: `publicReadUsing` (текст) видаляється в тій самій зміні, де
  з'являється будівник; жодного реекспорту.
- Згенерований SQL перевіряють тести генератора й DB-тести на стенді, ніколи
  ручне застосування до живої бази.
- DB-тест лишає стенд чистим (транзакція з відкатом або об'єкти з тегом прогону —
  `test/db/connection.ts`). Тести тригерів пишуть від власника таблиці з
  виставленим контекстом команди, тести грантів і політик — від справжніх ролей
  профілю (`queryAs`, `commandAs`), як у B2.

## 3. Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р-D1-1 | **Форма T0.** `publicReadSchema` (`model/schemas/public-read.ts`) — об'єднання рядка `"anon" \| "authenticated"` і `z.strictObject({ role, published: z.literal(true) })`. Схема одна для всіх видів; відмови — правилами компілятора (нижче), щоб діагностика мала покажчик і код. Хелпер T0 дає роль і ознаку умови з обох форм — єдине місце розбору форми. | none |
| Р-D1-2 | **Контракт доступу.** `AccessContract.publicRead` лишає призначення ролей для обох форм (стик D5). Нове поле `published?: { column: string; mark: string }` — фізичні колонки V саме цієї таблиці: на шапці — `published` і `deletion_mark`, на ТЧ — колонки-копії (Р-D1-9). Один предикат `opensEveryRow(contract)` = `publicRead` непорожній і `published` відсутнє. На нього переходять усі читачі «всі рядки відкриті»: `readBoundaries`, пропуск `<t>_read_*` у `buildAccessUnits` (`compiler/access-units.ts`), `rowBranch` і `boundaries` (`compiler/rights/require-units.ts`), `branch` і `explainRows` (`compiler/rights/explain-units.ts`), факт `SignalFacts.publicRead` (`compiler/signal/units.ts`), `publicReadOf` (`compiler/runtime-catalog.ts`). Перелік перевіряє `orient publicRead` перед задачею 1; новий читач поза переліком — рядок архітекторці. | none |
| Р-D1-3 | **Будівник умови публічного читання** (*інтерфейс для B6-2, на приймання*). Новий модуль `compiler/rights/public-read.ts`: `publicReadConditions(contract, sessionUser): RightsCondition[]` — AND умов. Для умовної форми — `{ kind: "rowLiteral", column: published.column, value: true }`, `{ kind: "rowLiteral", column: published.mark, value: false }`; для ролі `authenticated` з функцією користувача — `{ kind: "validUser" }`. Порожній масив — `true`. `RightsCondition` (`compiler/rights/predicates.ts`) отримує два нові варіанти; `renderCondition(condition, row?)` рендерить `rowLiteral` як `<row>.<col>` чи `NOT <row>.<col>`, `validUser` — як `current_user_id() IS NOT NULL`. Пояснення підставляє `validUser` для свого суб'єкта (як сьогодні `publicReadNeedsUser`). `publicReadUsing` видаляється, `publicReadNeedsUser` переїжджає в модуль будівника. `coalesce` немає: `NULL` копії — рядок невидимий (fail-closed). | права §5.4 — одне речення: умови `rowLiteral`/`validUser` у формі предиката (задача 0) |
| Р-D1-4 | **Політики** на шапці й ТЧ умовного об'єкта: `<t>_public_read` — ті самі ролі, `USING` = рендер Р-D1-3; межа тенанта `<t>_scope_read` є: `RESTRICTIVE … USING (V OR <межа>)`, лівий диз'юнкт — рендер лише рядкових умов будівника (без `validUser`); `<t>_read_*` повертаються. Межі й політики запису не змінюються. | права §5.2 — абзац «Умовний `publicRead`» (задача 0) |
| Р-D1-5 | **`rowBranch`** умовного об'єкта: `key AND ((<умови Р-D1-3>) OR (<межа тенанта> AND <право read>))` — для пари з викликачами `READ_CALLERS`; для іншої пари — лише права, як сьогодні. Межу тенанта як окремий AND-член `boundaries` для умовного читання не додає. | права §5.4 — форма `(V AND …) OR <права>` у гейті планів (задача 0) |
| Р-D1-6 | **Пояснення.** `explainRows` дає для умовного об'єкта і рядок `public_read` (`carrierMatch` = рендер будівника для суб'єкта), і рядки `<t>_read_*`, і рядок `scope_read` з `carrierMatch` = `V OR <межа>`. Виняток «`p_user` поза скоупом рядка» (`branch`) діє лише для `V AND NOT validUser`: на чернетці перевірка членства `p_user` лишається. | права §5.1 — виняток лише для опублікованого рядка (задача 0) |
| Р-D1-7 | **OQ-2 закрито: пояснення не є оракулом існування чернетки.** `branch` уже вимагає видимості рядка викликачу (`visibility` над рядками `CALLER`) і гейту аналізу; з Р-D1-6 невидима викликачу чернетка дає порожній результат — той самий, що випадковий id. DB-тест інваріанта 9. Рекомендація §7 тримається, розвилки немає. | §7 — рядок OQ-2 закривається (задача 0) |
| Р-D1-8 | **Колонка й переходи (реєстр).** `catalogKind.standardColumns(obj)` (`model/kinds/catalog.ts`) за умовною формою дає `published boolean NOT NULL DEFAULT false` (визначення поруч із `deletionMarkColumn`, `model/kinds/standard.ts`), за прецедентом умовних `code`/`description`. `actions(obj)` дає `publish` (`transition { column: "published", from: false, to: true }`) і `unpublish` (`true → false`), `requires: []` — лише ребро `⇒ read` (`actionRequires`); право `publish` без `update` достатнє (§3 D1). `rightsContract` збирає `published` у `transitions` з дефолтом, виключає з `"all"` `create`/`update` і з INSERT-гранту ролі команд — наявним шляхом колонок переходів. | П2 — стандартна колонка й дії (задача 0) |
| Р-D1-9 | **Копії носія в ТЧ.** `carrierDeclarations` (`compiler/rights/facts.ts`) отримує нове значення `field: "publication"` — дві декларації (`published`, `deletionMark` шапки), безумовні для умовного об'єкта. Посилання стадії 2 — поруч з `ownershipReferences`/`bindingReferences`/`accessReferences` (`model/kinds/standard.ts`, виклик у `model/kinds/catalog.ts`) і в `carrierRefs` (`compiler/stages/model.ts`). `resolveCarrier` (`compiler/rights/carriers.ts`) приймає стандартну булеву колонку шапки лише для `field: "publication"` — для інших полів `rights.carrier-not-ref` діє як досі. Ім'я копії — ім'я колонки шапки; зайняте ім'я на ТЧ — `rights.carrier-column-taken`. Далі наявні `addCarrierCopies`, тригери derive/propagate, `carrierBackfillStatements` і крок `carriers` плану: копію пише лише платформа, пряму зміну копії тригер derive перезаписує. Те саме джерело — вхід B3 для таблиці перекладів; `carrierColumn` під таблицю перекладів D1 не узагальнює. | права §5.2 — копія умови в ТЧ (задача 0) |
| Р-D1-10 | **Ефект `markDeletion`.** Для умовного об'єкта заголовок ефектів `markDeletion` містить і `published`, а `KindAction` отримує однобічну пов'язану колонку (назва поля — на розсуд виконавця; семантика фіксована): під дією `markDeletion` `published` змінюється лише `true → false`, а встановлення позначки на рядку з `OLD.published` вимагає `NEW.published = false`. Перевірку рендерить `updateChecks` тригера ефектів (`compiler/rights/effects-units.ts`). Ядро (`markDeletionFunction`, `compiler/catalog-command/units.ts`) при `p_mark` ставить `published = false` у тому самому `UPDATE` і в `v_new`; зняття позначки `published` не чіпає — рядок лишається чернеткою. | none (ADR-0119 п.2) |
| Р-D1-11 | **Операції й ядро.** `publish`/`unpublish` — нові значення `ObjectOperation` у кінці `OBJECT_OPERATIONS`; варіанти `operationSchema` з `object`, `id`, `expectedVersion`; `OPERATION_EVENTS` — `write`. Ядро: мітки в `CATALOG_COMMAND_LABELS`, `actionsOf`/`functions` (`compiler/catalog-command/contracts.ts`), функція `<t>_publish(uuid, bigint)`/`<t>_unpublish` за скелетом `markDeletionFunction` (контекст, замок, версія, право дії над `v_old`, `UPDATE` однієї колонки, `relink`, сигнал, результат). Сигнал переходу — `op: "update"`: перелік `op` сигналу (`model/runtime/signal.ts`, `CHANGE_OPS`) не змінюється, бо його розбирає приймач T4. T3: `callOf` і `checkDraft` (`server/phase.ts`), `wireOperationSchema` (`model/runtime/envelope.ts`), дієслова агента (`server/agent/verbs.ts`, `describe.ts`, `tools.ts`), `hook-context.ts`. Каталог рантайму: цілі `operations.publish`/`unpublish` (`operationsOf`, схема в `model/runtime/catalog.ts`) лише в умовного об'єкта. | П4 — перелік операцій (задача 0) |
| Р-D1-12 | **Точка переходу для D4** — `Change.operation` у `CommandResult.changes` (`model/runtime/result.ts`) зі значеннями `publish`, `unpublish`, `markDeletion`, `update`. D4 фільтрує зміни після коміту без змін коду D1. | none |
| Р-D1-13 | **Каталог рантайму.** `publicReadOf` дає `publicRead` лише за `opensEveryRow`; умовний — `publicReadPublished: "anon" \| "authenticated"` (нове поле `RuntimeObject`, `model/runtime/catalog.ts`). Клієнтський каталог (`entryOf`, `compiler/client-catalog.ts`) у D1 `publicReadPublished` не переносить — це D2; `publicRead` умовного об'єкта в ньому немає, тож `publicReadCovers` T4 його не відкриває. Текст правила в `compiler/messages.ts` («publicRead … opens every row») уточнюється для умовної форми. | none |
| Р-D1-14 | **Правила відмов** (стадія прав, `compiler/rights/checks.ts`, поруч із `rights.public-read-forbidden`): `rights.public-read-published-kind` — умовна форма на виді без `commandWrites`; `rights.public-read-published-rights` — проєкт без функцій прав (`hasRightsFunctions`); `rights.public-read-published-read` — об'єкт без контракту прав з дією `read`. Покажчик — `/publicRead`. `rights.public-read-forbidden` уже судить `!== undefined` — діє на обидві форми, тест додається. Стик B2: якщо на початку задачі 2 на `main` є правило `languages.public-read`, задача додає тест «умовна форма на «Мовах» — відмова»; інакше тест пише B2 (Р-B2-2 уже відмовляє будь-якій формі). | none |
| Р-D1-15 | **Стик D5.** Якщо D5 злито раніше за D1, done-when задачі 3 додає тест: умовна форма `publicRead` ролі `authenticated` є в переліку діагностики `selfSignUp`. | none |
| Р-D1-16 | **План T2.** Увімкнення умови — колонка з типовим `false`, копії носія з кроком `carriers`, політики: наявні кроки. Вимкнення (видалення `published`) — наявний руйнівний крок з `dataLoss` і дозволом. Перехід «умовний → рядковий»: нова функція поруч із `foreignChanges` (`schema/apply/steps.ts`) — множина id кроків двигуна, що створюють чи перевизначають `<t>_public_read` таблиці, яка в останньому застосованому стані (`applied`) мала колонку `published`, а в бажаному її не має й політику лишає. Ці кроки потребують дозволу за id, окремого від дозволу на видалення колонки. Хибна тривога (рядковий об'єкт втрачає реквізит з фізичним ім'ям `published`) — дозвіл зайвий, але безпечний. | none (§5.1 «План» уже вимагає) |
| Р-D1-17 | **Еталонний проєкт.** Новий довідник `Announcement` у `examples/reference/metadata` (скоуп `org`, ТЧ `Items`, `publicRead: { role: "anon", published: true }`, контракт прав з `read`); `Counterparty` не змінюється. Шаблон застосунку не змінюється — публічна сторінка в D3. | none |
| Р-D1-18 | **Поправка done-when §3 D1** (*на приймання*). Рядок «під `simetra_command` без контексту … `INSERT` з `published = true` — відмова `WITH CHECK`» перевірити неможливо: колонка переходу поза INSERT-грантом ролі команд, тож першим відмовляє грант (`42501` за колонкою). Тест ділиться на два: `INSERT` без контексту (без `published`) — відмова `WITH CHECK` запобіжника (мутація «запобіжник прибрано» червона); `INSERT` з `published` під роллю команд — відмова гранту (мутація «колонка в INSERT-гранті» дає відмову тригера ефектів — тест розрізняє шар за повідомленням, не лише за `SQLSTATE`). | §3 рядок D1 — формулювання (задача 0) |

## 4. Інтерфейси

Дає (власник — D1, спека §4):

- **Форма T0** `publicRead: { role, published: true }` і правила Р-D1-14 — D2, D3,
  D6, B3.
- **Будівник умови** `publicReadConditions(contract, sessionUser):
  RightsCondition[]` у `compiler/rights/public-read.ts` (Р-D1-3). Форма
  результату: AND умов; `{ kind: "rowLiteral"; column: string; value: boolean }`
  — фізична колонка таблиці контракту і літерал; `{ kind: "validUser" }` —
  дійсний користувач сесії. Перелік — `m4-sk-architect` для перевизначення B6-2
  (нейтральне дерево ADR-0102 бере ці вузли; фізичну колонку на носій каталогу
  відображає рендер B6-2).
- **Колонки V таблиці** — `AccessContract.published` (Р-D1-2): джерело копії
  носія `field: "publication"` для B3.
- **Колонка `published`, дії й операції `publish`/`unpublish`, ефект
  `markDeletion`** — D4, D6, D7; точка переходу — `Change.operation` (Р-D1-12).
- **Поле каталогу рантайму** `publicReadPublished` — D2.

Бере: нічого.

## 5. Інваріанти безпеки

Суб'єкти DB-тестів: гість (`anon`), користувач тенанта A з `read`, користувач
тенанта B з `read`, автентифікований без прав, роль команд з контекстом і без
нього, власник таблиці. Стани рядка шапки: чернетка A, чернетка B, опублікований
A, опублікований і позначений A; кожен — з рядком ТЧ.

1. **Гість бачить лише опубліковані непозначені** — прямий `SELECT` шапки й ТЧ.
   *Мутації:* умову прибрано з `<t>_public_read`; `NOT deletion_mark` прибрано з
   умови будівника — гість бачить чернетку чи позначений рядок.
2. **Межа тенанта на чернетці.** Користувач A з `read` бачить чернетки A і не
   бачить чернеток B — шапка й ТЧ. *Мутації:* межа без лівого диз'юнкта
   (опублікований рядок B невидимий користувачу A без прав на B — червоне);
   лівий диз'юнкт — лише `published` замість V (позначений опублікований рядок B
   видно користувачу A — червоне).
3. **Автентифікований без прав** при ролі `authenticated` бачить лише
   опубліковані.
4. **Новий рядок — чернетка.** Команда `create` повертає рядок (`RETURNING`
   проходить під роллю команд); `update` змінює чернетку. Від власника з
   контекстом `create`: `INSERT` з `published = true` — відмова тригера ефектів.
   Від ролі команд — інваріант 12. *Мутація:* прибрати відмову не типового
   значення в `mainBody` — тест власника червоний.
5. **Публікація — окреме право.** `publish` без права — `command.forbidden`; з
   правом `publish` без `update` — успіх; `published` у `values` `update` —
   відмова (код і шар фіксує тест; рядок не змінився). Прямий `UPDATE … SET
   published = true` під контекстом `update` — `command.forbidden` `effect`.
   *Мутація:* `published` в `"all"` `update` — тест `values` червоний.
6. **Зміст опублікованого рядка.** `update` опублікованого рядка гість бачить
   одразу.
7. **Позначка знімає публікацію.** `markDeletion` опублікованого — `published =
   false`; зняття позначки дає чернетку. Від власника з контекстом `markDeletion`:
   `SET deletion_mark = true` без `published = false` — відмова; `SET published =
   true` — відмова. *Мутації:* «позначка не знімає публікації» (ядро без `published
   = false`) — червоне; однобічна перевірка прибрана — пряме зняття позначки
   повертає опублікований рядок, тест червоний.
8. **Копія в ТЧ.** Зміна `published` шапки доходить до копії; пряма зміна копії
   не діє (тригер derive повертає значення шапки). *Мутація:* копія в ТЧ не
   оновлюється за шапкою — гість бачить рядок ТЧ знятої з публікації шапки.
9. **Пояснення — не оракул** (Р-D1-7). Адміністратор тенанта A без видимості
   чернетки B: `rights_explain` для чернетки B і для випадкового id — той самий
   (порожній) результат. Пояснення опублікованого рядка й чернетки A збігається з
   RLS викликача. *Мутація:* виняток `p_user` для всього умовного об'єкта, а не
   лише для V — тест чернетки червоний.
10. **Один будівник.** Для кожного стану рядка й суб'єкта видимість за RLS, за
    `rowBranch` (`rights_require`) і за поясненням однакова. *Мутація:* другий
    шлях, що будує V інакше (наприклад, `rowBranch` без `NOT deletion_mark`), —
    тест рівності червоний.
11. **Сигнали.** Підписка на сигнал умовного об'єкта автентифікованим без `read`
    — відмова. *Мутація:* `subscribeCondition` повертає `true` для умовного —
    червоне.
12. **Межа довіри запису.** Під `simetra_command` без контексту `UPDATE … SET
    published = true` зачіпає 0 рядків; `INSERT` без контексту — відмова `WITH
    CHECK`; `INSERT` з `published` — відмова гранту (Р-D1-18). *Мутація:*
    запобіжник прибрано — перші два тести червоні.
13. **Гейт планів** (права §5.4): без `SubPlan` під роллю користувача й гостя на
    умовному об'єкті, шапка й ТЧ.
14. **Каталоги не відкривають умовного об'єкта** (unit): у каталозі рантайму й
    клієнтському немає `publicRead`, є `publicReadPublished` лише в рантайму.
    *Мутація:* `publicReadOf` без `opensEveryRow` — тест червоний.
15. **План T2** (unit, designer DB): вимкнення умови — руйнівний крок з `dataLoss`
    і дозволом; «умовний → рядковий» — окремий крок з дозволом за id. *Мутація:*
    прибрати множину Р-D1-16 — план проходить без дозволу.

## 6. Частини

| Частина | Задачі | Готово, коли |
| --- | --- | --- |
| A. Межа читання | 1, 2, 3, 6 | інваріанти 1–3, 9–11, 13, 14 |
| B. Публікація й команди | 4, 5 | інваріанти 4–7, 12 |
| C. Копії й план | 6, 7 | інваріанти 8, 15 |

Частини приймаються окремо; DB-задача 8 закриває всі.

## 7. Задачі

| # | Задача | Файли й модулі | Готово, коли | Після | Перевірка |
| --- | --- | --- | --- | --- | --- |
| 0 | Якорі й поправки спеки | план; спеки §8 цього плану | `orient --plan` і `doc anchors` чисті; поправки §8 внесено | — | `doc anchors docs/superpowers/plans/2026-11-26-public-app-d1-conditional-public-read.md` |
| 1 | Будівник і читачі | `compiler/rights/public-read.ts` (новий), `compiler/rights/predicates.ts`, `compiler/contracts.ts` (`AccessContract.published`), `compiler/access-units.ts`, `compiler/rights/require-units.ts`, `compiler/rights/explain-units.ts`, `compiler/signal/units.ts`, `compiler/runtime-catalog.ts` | `publicReadUsing` видалено; усі читачі Р-D1-2 — через `opensEveryRow`; unit-тести над контрактом з `published`, побудованим вручну: політики Р-D1-4, `rowBranch` Р-D1-5, рядки пояснення Р-D1-6, факт сигналу; для контракту без `published` вивід не змінився | 0 | `run-tests unit --filter access-units` і `run-tests unit --changed` |
| 2 | Форма T0, колонка, дії, правила | `model/schemas/public-read.ts`, `model/kinds/catalog.ts`, `model/kinds/standard.ts`, `model/kinds/actions.ts`, `compiler/rights/contracts.ts`, `compiler/access-units.ts` (заповнення `published`), `compiler/rights/checks.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts` | схема приймає обидві форми; колонка й дії лише за умовою; `transitions` містить `published`; INSERT-грант без `published`; кожне правило Р-D1-14 — рядок таблиці «файли → код → покажчик»; стик B2 за Р-D1-14 | 1 | `run-tests unit --changed` |
| 3 | Каталог рантайму | `model/runtime/catalog.ts`, `compiler/runtime-catalog.ts`, `compiler/client-catalog.ts` (без змін — тест), `compiler/messages.ts` | інваріант 14; `kernelHash` об'єкта без умови не змінився (тест); стик D5 за Р-D1-15 | 2 | `run-tests unit --filter runtime-catalog` |
| 4 | Ефект `markDeletion` | `model/kinds/actions.ts`, `compiler/rights/effects-units.ts`, `compiler/catalog-command/units.ts` | unit: тіло `updateChecks` з однобічною перевіркою; тіло `mark_deletion` з `published = false` (оновити `catalog-command-mark.test.ts`); для об'єкта без умови тіло не змінилось | 2 | `run-tests unit --filter effects-units` |
| 5 | Операції `publish`/`unpublish` | `model/runtime/operation.ts`, `model/runtime/envelope.ts`, `model/runtime/catalog.ts` (`operations`), `compiler/catalog-command/contracts.ts`, `compiler/catalog-command/units.ts`, `compiler/runtime-catalog.ts` (`operationsOf`), `server/phase.ts`, `server/agent/*`, `server/hook-context.ts` | unit: схема й конверт приймають нові операції, старі індекси не зсунулись; функції ядра; диспетч T3; сигнал `update`; `Change.operation` несе нові значення | 2, 4 | `run-tests unit --changed` |
| 6 | Копії носія в ТЧ | `compiler/rights/facts.ts`, `compiler/rights/carriers.ts`, `compiler/rights/checks.ts`, `model/kinds/standard.ts`, `model/kinds/catalog.ts`, `compiler/stages/model.ts` | ТЧ умовного об'єкта має копії `published`, `deletion_mark`; `AccessContract.published` ТЧ — колонки-копії; `rights.carrier-not-ref` для інших полів не змінився (тест); зайняте ім'я — `rights.carrier-column-taken` | 2 | `run-tests unit --changed` |
| 7 | План T2 | `schema/apply/steps.ts`, `schema/apply/plan.ts`; DB-тест apply у `packages/designer/src/__tests__/` (як `storage-sql.db.test.ts`) | інваріант 15: unit на діях двигуна; DB через apply дизайнера — увімкнення з наявними рядками дає чернетки й заповнені копії | 6 | `run-tests unit --filter steps` і `run-tests db --filter public-read-plan` |
| 8 | Еталон і DB-тести межі | `examples/reference/metadata` (Р-D1-17); новий файл `public-read-published.db.test.ts` у `packages/simetra/test/db/` (оснастка `compileRights`, `deploy`, `queryAs`, `commandAs` з `rights-seed`/`connection`; випадки запису — за таблицею `rights-write.db.test.ts`); гейт планів — у `rights-plan-gate.db.test.ts` | знімок і DDL еталону оновлено, `pnpm metadata:check` зелений; інваріанти 1–13 зелені; кожна названа мутація перевірена червоною (звіт називає мутацію й тест) | 1–7 | `run-tests db --filter public-read-published` і `run-tests db --filter rights-plan-gate` |

## 8. Задача 0 — поправки спеки

- Спека публічної частини §3 рядок D1 — формулювання Р-D1-18; §7 — OQ-2
  закрито (Р-D1-7), з посиланням на DB-тест.
- Права §5.1 — виняток пояснення `publicRead` лише для опублікованого рядка
  (Р-D1-6); §5.2 — абзац «Умовний `publicRead`»: межа `V OR <межа>`,
  `<t>_read_*`, копія умови в ТЧ (Р-D1-4, Р-D1-9); §5.4 — умови `rowLiteral`,
  `validUser` і форма `(V AND …) OR <права>` (Р-D1-3, Р-D1-5).
- П2 — форма `publicRead` з `published`, стандартна колонка `published`, дії
  `publish`/`unpublish`, ефект `markDeletion`, кроки плану вимкнення умови.
- П4 — операції `publish`/`unpublish` у переліку операцій ядра; сигнал переходу
  — `update`.
- Промоція §16 — рядок «`publicRead` з умовою — відкласти» закривається ADR-0119.
- П4-B §8.6 — підписка умовного об'єкта лише за правами.
- Спеку ядра синхронізації й рядки §8 інших блоків (D2–D6) задача 0 не чіпає.

## 9. Задачі власника

Немає.

## 10. Підсумок аудиту

Заповнює автор після аудиту.
