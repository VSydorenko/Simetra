# #297. Ідентичність SQL-одиниць через `quoteIdent` — план імплементації

**Статус:** чернетка на приймання архітекторкою М4 (`m4-simetra-milestone`).
Issue #297, віха М4. Автор і (після сигналу архітекторки) виконавець —
сесія `simetra-33`.

- **Анкори.** На `main` (e06018d4). #275 (`simetra-f3`, гілка
  `issue-275-exec`) змінює ті самі файли: `compiler/sql/units.ts`,
  `definer-reads.ts`, `dependencies.ts`, `function-body.ts`,
  `write-paths.ts`, `function-execute.ts`, `stages/integrity.ts`,
  `diagnostics.ts`, `messages.ts`. Анкори в цих файлах — «після #275»:
  виконання починається лише після мерджу #275, задача 0 звіряє їх заново.
- **Межі серії.** `packages/simetra/src/data/**` не змінюється. Ідентифікатори
  двигуна (`StableId` pg-delta: `table:…`, `index:…`, `type:…` у
  `database-tools.ts`, `steps.ts`) — не ідентичність одиниці; блок їх не
  змінює (див. Р9).
- **Спільні ресурси.** Стеки `postgres` і `supabase` спільні; запуск лише
  `pnpm db:pg:start` з основного checkout; не зупиняти; чужих об'єктів не
  видаляти. Блок додає один DB-тест (задача 2).
- **Лише CI.** Повні рівні `unit`, `db`, `db-supabase` запускає CI на draft
  PR. Задача закінчується лише цільовим `run-tests unit --filter <файл>` /
  `run-tests unit --changed` / `run-tests db --filter <файл>`. Локально ще
  `doc anchors && doc lint` (задача 0) і `pnpm metadata:check` (задача 1).

## Мета, архітектура, спека

**Мета.** Ідентичність SQL-одиниці ін'єктивна: різні об'єкти Postgres мають
різні ідентичності, бо кожна частина імені пишеться за `quoteIdent`. Одне
правило на всіх споживачів; локальні латки Д1 (перевірка
`sql.function-name-unsupported`, `unsupportedSignaturePart`, `sqlTypeName`,
`tupleKey`) зникають. Готово, коли виконано «Done when» issue #297:
ідентичності з `.`, `,`, `"` у лапках не збігаються; грант `EXECUTE`
влучає рівно у свою сигнатуру (DB-доказ); тест кожного споживача червоніє,
якщо зламати правило.

**Архітектура.** Новий модуль `identity.ts` у `compiler/sql/`
— єдиний, хто складає й розбирає рядок ідентичності: `<клас>:<ключ>`, де
кожна частина імені (схема, ім'я, таблиця тригера й політики, частини імені
типу, частини `%type`) — `quoteIdent`, а роздільники `.` `,` `:` `(` `)`
стоять лише поза лапками. `classify`, `typeName`, `signature`,
`functionObject`, `targetName`, `relation`-ключі в `units.ts` будують ключ
через нього; `functionIdentity` переїжджає туди. Ключ ідентичності функції
стає валідним SQL-підписом (`"a.b".c(int4, "x,y".t)`), тож підпис гранту
(`functionSignatureSql`) — це той самий ключ, а не розбір рядка назад.
Підпис іде з вузлів `TypeName` (через `typeName` з резолвом типів моделі) —
так, як вимагає бриф. Поля `schema`/`name` одиниці лишаються сирими
(іменами каталогу): порівняння полів — не склеювання й правилом не
зачіпається.

**Спека.** Платформна спека §6.3 (ідентичність одиниці — ім'я й сигнатура з
розбору); спека П2 §3 («Ідентичність одиниці — PG-схема, ім'я й сигнатура»)
і §8.3 (абзац про канонічні типи аргументів); спека декларацій функцій
§5.1 (абзац про `sql.function-name-unsupported`) і §5.7 (рядок діагностики).

## Глобальні обмеження

- Без сумісності зі старим форматом (правило власника 2026-11-18): ні
  аліасів, ні читача старих рядків.
- Ідентичність простих імен у нижньому регістрі не змінюється
  (`function:public.f(int4)`); змінюється лише там, де `quoteIdent` ставить
  лапки: верхній регістр, спецсимволи, ключові слова (`"numeric"`,
  `"timestamp"`, `"time"`, `"varchar"`, `"char"`, `"bit"`, `"interval"`).
- Наявні тести лишаються зеленими; рядки ідентичностей у тестах і
  `fixtures/platform-catalog-forms.ts` оновлюються під правило, а не
  навпаки.

## Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Одне правило рендеру:** кожна частина імені в ключі — `quoteIdent` (`packages/simetra/src/model/physical/pg-names.ts`), і для типів каталогу теж. Альтернатива «типи каталогу без лапок» відкинута: `char` без лапок у SQL — `bpchar`, а `"char"` — інший тип, тож ключ перестав би бути валідним підписом. Ціна — `"numeric"`/`"timestamp"` в ідентичностях; лише вигляд. **Затверджено архітекторкою.** | П2 §8.3 — одне речення (задача 0) |
| Р2 | **Ключ функції = підпис SQL.** `functionSignatureSql(unit)` повертає ключ ідентичності (з `", "` між типами — косметика рендеру гранту); `sqlTypeName` і розбір через `splitIdentity` у ньому зникають. Згенерований грант, розібраний `generatedUnit` без типів моделі, дає ту саму ціль, бо тип моделі в ключі вже кваліфікований. | none |
| Р3 | **Перевірка Д1 зникає.** `sql.function-name-unsupported`, `unsupportedSignaturePart`, `checkExecuteSignatures` і фільтр у `buildFunctionExecuteUnits` видаляються разом із кодом у `diagnostics.ts`/`messages.ts`; тести перевірки стають позитивними тестами гранту. | спека декларацій §5.1 абзац, §5.7 рядок (задача 0) |
| Р4 | **Будь-яке складання ідентичності поза `identity.ts` заборонено правилом lint** (`no-restricted-syntax` на шаблон/рядок з префіксом класу одиниці) з негативним тестом у стилі `tier-boundary.test.ts`. Місце для ідентифікаторів двигуна — коментар-виняток з причиною. Без цього клас дефекту повернеться вчетверте. | none |
| Р5 | **Ключі просторів імен і колізій** (`pgNamespaceKeys` для `rel`/`type`/`proc`, `functionCollisions` у `stages/integrity.ts`) будуються тим самим правилом: зараз `"a.b".c` і `a."b.c"` дають один ключ `rel`. | none |
| Р6 | **Локальні кортежі Д1.** `tupleKey` (`JSON.stringify`) → `qualifiedName(schema, name)` з `identity.ts`. Структуровані порівняння полів (`sameKey`, `RepairKey` і `newRepairErrors`, фільтр форм у `executeTargets`) лишаються: вони порівнюють сирі частини, не склеєний рядок, і `RepairKey` — рішення Codex-аудиту Д1. | none |
| Р7 | **Збережені ідентичності поза marker** — `sql-debt.json` проєкту, журнал промоції, `resultCatalog` артефакту плану (план, зібраний до оновлення, на таблиці у верхньому регістрі дає `apply.backfill-triggers-changed`) — без міграції (немає споживачів): стара ідентичність дає гучне `sql.debt-stale` / `promote.mapping-unknown`, тихого збігу немає (перевірено аудитом). У репо `sql-debt.json` немає (`git ls-files '*sql-debt.json'`; перевірка задачі 0). | none |
| Р10 | **Ідентичність у marker — похідна, не збережена правда.** `driftGate` (`schema/apply/drift.ts`) порівнює `marker.catalog` з поточною моделлю через `diffCatalogModels` за `u.identity` (`model/physical/catalog.ts`); стара форма дала б хибний `apply.drift` на незмінній цілі, і оператор звикав би приймати дрейф наосліп. Правило: одна чиста функція «застосований каталог» (marker → `CatalogModel` з `identity`, перевиведеною `readSqlUnits` з `sql` кожної одиниці) у `schema/apply/state.ts`; її викликає `plan.ts` (вже має `parse`) один раз, і результат читають обидва споживачі — `driftGate` і `providerTriggerConflicts`. `checkChain` (`execute.ts`) бере лише `snapshotHash` і нічого не перевиводить. Збережене поле не читається ніде. Одиниця, з `sql` якої виходить не рівно одна одиниця без діагностик, чи дві одиниці з однією ідентичністю → функція повертає разом із каталогом перелік нечитних одиниць. `driftGate` отримує його й за непорожнього переліку вважає модельний свідок непорівнюваним: нова гілка з попередженням `apply.drift-partial` (параметр причини), лишається свідок-відбиток — зараз `drift-partial` видається лише за іншої версії відбитка (`drift.ts`), тож це зміна гейта. `providerTriggerConflicts` за непорожнього переліку не застосовує виняток «живий SQL тотожний бажаному» (`plan.ts`): тригер провайдера поза застосованим каталогом — `plan.provider-trigger-taken` (fail-closed). Ні повернення до збереженого поля, ні тихого пропуску. Інваріант «другого авторитетного сховища ідентичності немає». Альтернатива «версія формату в marker → пропуск модельного свідка» відкинута: послаблює дрейф-гейт. **Затверджено архітекторкою.** | платформна §6.2 (звірка з marker) — одне речення (задача 0) |
| Р11 | **Ім'я файлу зворотної генерації.** `baseName` (`schema/reverse/units.ts`) ділить аргументи `splitIdentity`, а не `split(",")`; `slug` лишається. Перевантаження, що відрізняються лише межею лапок, дають один `slug` — гучна `introspect.path-collision`, а не тихий перезапис; розрізнювальний суфікс не вводиться (рідкісні імена, fail-closed). | none |
| Р8 | **`%type` — помилка компілятора** (затверджено архітекторкою, варіант (а)). `quoteIdent` робить підпис `"T".c%type` валідним, але не точним: `pg_proc` зберігає тип колонки на момент `CREATE`, а `GRANT ON FUNCTION f(t.c%type)` резолвить тип заново, тож після зміни типу колонки грант влучив би в чуже перевантаження. Тому аргумент `%type` у функції з виведеним `EXECUTE` (задекларована, функція модуля виду, функція значень виміру, форма платформи) — помилка `sql.function-argument-type-reference` без гранту (fail-closed). Розгортання `%type` в ідентичності за типом колонки знімка — #300 (беклог). Частини імені `%type` в ідентичності однаково йдуть за `quoteIdent` (Р1). | спека декларацій §5.1 — речення про помилку; §5.7 — рядок нового коду замість `sql.function-name-unsupported` (задача 0) |
| Р9 | **Межа з двигуном.** `classifyUnit` (`map-units.ts`) уже веде SQL двигуна через `readSqlUnits`, тож обидві сторони отримують нове правило разом. Рядки, що порівнюються з ідентичністю одиниці (`census-read.ts` `materializedView:…`, шлях `units.<ідентичність>` у `database-tools.ts`), переходять на `identity.ts`. `StableId` двигуна (`table:`, `sequence:` у плані дій) — інша мова; задача 0 перевіряє, як pg-delta кодує ім'я в лапках (`encodeId`): якщо сиро — це окремий дефект, issue до архітекторки, не цей блок. | none |

## Інтерфейси

- **Дає** (новий `identity.ts` у `compiler/sql/`, реекспорт з `simetra/compiler` там,
  де designer чи T2 його читає): `qualifiedName(...parts)`,
  `unitIdentity(class, ...parts)`, `functionIdentity(schema, name, argTypes)`
  (переїзд, сигнатура та сама), розбір `identityKey(identity)` і
  `identityParts` для ключів з крапками (тригер, політика: схема, таблиця,
  ім'я — без лапок). Точні імена — вибір виконавця; вимога — одне місце.
- **Бере.** `quoteIdent` (T0); `splitIdentity` (лапко-обізнаний розбір,
  лишається).
- **Не змінює** публічних типів T0 і схем файлів.

## Інваріанти безпеки

| # | Інваріант | Тест | Мутація → червоний |
| --- | --- | --- | --- |
| І1 | `REVOKE`/`GRANT EXECUTE` задекларованої функції влучає рівно в неї. Пари: `"F"()` поруч із чужою `f()` (лише регістр — тихий шлях); схема `"Sch"` поруч із `sch` з однойменною чужою функцією; тип `"x,y"`. Перевірка: роль без грантів не виконує задекларовану (відкликання від `PUBLIC` влучило), роль викликача виконує; `proacl` чужої функції лишається `NULL` (ніхто не чіпав) | новий `*.db.test.ts` (postgres); unit-рядки в `function-execute.test.ts` | рендер без `quoteIdent` кожної частини окремо (схема, ім'я, тип) → `REVOKE` падає на чужу функцію чи помиляється |
| І7 | Функція з виведеним `EXECUTE` і аргументом `%type` — `sql.function-argument-type-reference`, гранту немає; та сама функція без виведеного `EXECUTE` — без цієї помилки | `function-execute.test.ts` | прибрати перевірку → грант з `%type` з'являється |
| І6 | Незмінена ціль після оновлення правила: рядок marker з ідентичностями старої форми (`(numeric)`, тригер на таблиці у верхньому регістрі) → функція «застосований каталог» → `driftGate` дає `drift: null`, `providerTriggerConflicts` бачить свій тригер; `sql` одиниці, що не класифікується, → `apply.drift-partial` і `plan.provider-trigger-taken` | тест функції «застосований каталог» з подачею результату в `driftGate` і `providerTriggerConflicts` (`drift.test.ts`, тест тригерів провайдера) | читати збережене `identity` → `apply.drift`; пропустити неможливу одиницю → `drift: null` без попередження |
| І2 | Дослівний грант на чуже перевантаження з тим самим склеєним текстом не стає `sql.generated-grant` і не вирізається `fix` | `function-execute.test.ts` | порівнювати цілі без лапок |
| І3 | `executableBy`/`targetOf` (`definer-reads.ts`) бачать грант на відношення й функцію з ім'ям у лапках — `sql.definer-caller-unchecked` не зникає мовчки | `definer-reads.test.ts` | ключ `table|${schema}.${name}` сиро |
| І4 | Дві функції / в'юхи / тригери, що відрізняються лише межею лапок, — різні одиниці: без `sql.unit-duplicate`, без `sql.namespace-conflict`, без колізії стадії 4 | `sql-units.test.ts`, integrity-тест колізій | склеїти частини без лапок у `pgNamespaceKeys` чи `functionCollisions` |
| І5 | Тригер механіки, ідентичності, бекфілу на прийнятій таблиці з ім'ям у верхньому регістрі знаходиться (`row-version.ts`, `plan.ts`, `backfill.ts`) — план не губить і не дублює тригер | `row-version.test.ts`, `identity-table.test.ts`, `backfill.test.ts` | повернути сирий шаблон `trigger:${…}` |

## Споживач → тест (червоний на мутації)

Мутація для кожного рядка — повернути сире склеювання в цьому місці.
Повний перелік місць — у звіті розвідки (тіло PR); виконавець звіряє його
задачею 0 через `orient` і `git grep` префіксів класів.

| Споживач (файл · функція) | Тест |
| --- | --- |
| `units.ts` · `classify`, `typeName`, `signature`, `targetName`, `functionObject`, `pgNamespaceKeys` | `sql-units.test.ts` |
| `units.ts` · `functionSignatureSql`; `function-execute.ts` · `buildFunctionExecuteUnits`, `grantTargetKeys`, `ownsTarget` | `function-execute.test.ts` + DB-тест І1 |
| `definer-reads.ts` · `executableBy`, `targetOf` | `definer-reads.test.ts` |
| `closed-forms.ts` · `ruledFunctions` (споживачі `debt.ts`, `function-body.ts`, `function-settings-shell.ts`) | `closed-forms.test.ts` |
| `declarations.ts` · `tupleKey`; `operations/platform-forms.ts` | `declarations.test.ts` |
| `catalog-command/units.ts` · `bodyRequires` (префікс функції) | `catalog-command-contracts.test.ts` |
| `subscription-units.ts` · ціль `subscription.trigger-name-taken` | `subscription-units.test.ts` |
| `rights/guard-units.ts`, `rights/command-units.ts`, `schema/apply/state.ts` `STATE_FUNCTIONS`, `row-version.ts` `SEQUENCE_ID` · ідентичності з констант платформи (імена в нижньому регістрі) | правило lint Р4 (задача 6); unit-мутації тут не існує, вимога «випадок з лапками» на них не діє |
| `stages/integrity.ts` · `functionCollisions` | тест колізій стадії 4 |
| `schema/apply/row-version.ts` · `SEQUENCE_ID`, `liveMechanicsTables`, `modelTriggers` | `row-version.test.ts` |
| `schema/apply/plan.ts` · `hasIdentityTriggers` | `identity-table.test.ts` |
| `schema/apply/steps.ts` · `inApplied` (тригер, політика: сирий шаблон проти застосованого каталогу) | тест `foreignChanges` у тестах кроків: власний тригер на таблиці у верхньому регістрі не чужий |
| `schema/apply/backfill.ts` · `triggerIdentity` і рядок поруч | `backfill.test.ts` |
| `schema/apply/state.ts` · префікси `applyStateOwnership`; читач marker (Р10) | `state.test.ts`; тест І6 |
| `schema/reverse/units.ts` · `qualified`, `baseName`, `pathOf`, `split(":")` | `reverse-generate.test.ts`: `f("x,y")` — один аргумент у імені файлу; пара з різною межею лапок — `introspect.path-collision` (Р11) |
| `schema/apply/promotion/replacements.ts` · `subjectGrant`; `platform/install.ts` · `grantAtoms` | `promotion-removals.test.ts`, `platform-install-diff.test.ts` |
| designer `census-read.ts` · `readUnpopulatedViews`; `tools/database-tools.ts` · шляхи `units.<ідентичність>` і розбір ключа `sequenceOwnedBy` (`nameParts(identity.slice(…))`) | `census-read.test.ts`, `database-errors.test.ts` |

## Задачі

### Задача 0 — анкори й спека

(після мерджу #275; `git merge origin/main`
у worktree). `orient --plan` і `doc anchors` на цей план; дельти — сюди
рядком. Перевірити: (а) `encodeId` pg-delta для імен у лапках (Р9);
(б) `git ls-files '*sql-debt.json'` порожньо (Р7); (в) нові місця
складання ідентичності, які #275 додав. Поправки спек: П2 §3 і §8.3 — одне
речення правила Р1 з прикладом `"a.b".c` ≠ `a."b.c"`; платформна §6.3 —
посилання на правило, якщо там описано формат; платформна §6.2 — речення
Р10; спека декларацій — абзац
§5.1 про `sql.function-name-unsupported` замінити реченням Р8, рядок §5.7
замінити рядком `sql.function-argument-type-reference` (корінь — #300). Готово:
`doc anchors && doc lint` зелені, коміт `docs(spec): #297 — …`.

**Дельти задачі 0.** Анкори після #275 цілі. (а) `encodeId` pg-delta (`seg`) бере в лапки сегмент лише з `.:(),"` чи пробілом, дублюючи `"` — ін'єктивно, не сиро; але верхній регістр лишає без лапок, тож `StableId` двигуна (`table:public.Foo`) не збігається з ідентичністю одиниці за `quoteIdent` (`table:public."Foo"`) — межа Р9 порівнює лише там, де споживач уже на `identity.ts`. (б) `sql-debt.json` у репо немає. (в) #275 нових місць складання ідентичності не додав (лише ключі `table|…` у `write-paths.ts`, не ідентичності). Місця поза таблицею споживачів: `catalog-command/units.ts` (`table:${relation(table)}`), `operations/fix.ts` (`schema:${schema}`), `sql/heads.ts` (`table:${qualified}`), `sql/units.ts` (`label: table:…`), `write-paths.ts` (ключі `table|…`), `designer/tools/database-tools.ts` (`table:`, `type:`, `index:`, `sequence:` — ідентичності двигуна чи одиниць, розрізнити за Р9), `guard-units.ts`/`command-units.ts` (`function:${ref(…)}(uuid,uuid)` — константи платформи, вже в таблиці).

### Задача 1 — модуль ідентичності й класифікатор

(після 0).
новий `identity.ts` у `compiler/sql/`; `units.ts`: `classify`, `typeName`,
`signature`, `functionObject`, `targetName`, ключі `relation`, тригер,
політика, `pgNamespaceKeys`, `platformFunctionSignatures`,
`functionSignatureSql` (Р2), видалити `sqlTypeName`; оновити рядки
ідентичностей у тестах і `fixtures/platform-catalog-forms.ts`. Таблиця
випадків у `sql-units.test.ts`: пари, що відрізняються межею лапок, для
функції, агрегату, в'юхи, тригера, політики, гранту, коментаря; `f("a,b")`
— один аргумент; `"char"` ≠ `bpchar`; `%type` змішаного регістру; ключ
функції розбирається Postgres-парсером назад як `ObjectWithArgs` з тими
самими частинами (властивість на згенерованих іменах — `fast-check`, якщо
вже є в залежностях, інакше таблиця). Готово: `run-tests unit --filter
sql-units`, `run-tests unit --changed`, `pnpm metadata:check` зелені.

### Задача 2 — грант `EXECUTE` без латок

(після 1). `compiler/function-execute.ts`,
`compiler/pipeline.ts` (виклик `checkExecuteSignatures`),
`compiler/diagnostics.ts`, `compiler/messages.ts`: Р3 і Р8 (новий код
`sql.function-argument-type-reference`, тест І7). Тести `sql.function-name-unsupported`
стають позитивними (І1, І2). Новий DB-тест І1 на postgres-стеку: функція з
лапкованими частинами + чуже перевантаження поза моделлю → після
застосування перевірки І1 (об'єкти з тегом запуску, helpers
`packages/simetra/test/db/connection.ts`). Готово: `run-tests unit --filter
function-execute`, `run-tests db --filter <новий файл>` зелені; мутація І1
(без `quoteIdent` для однієї частини) робить DB-тест червоним — описати в
звіті задачі.

### Задача 3 — споживачі компілятора

(після 1). `definer-reads.ts`,
`declarations.ts` (+`operations/platform-forms.ts`),
`catalog-command/units.ts`, `subscription-units.ts`,
`rights/guard-units.ts`, `rights/command-units.ts`, `stages/integrity.ts`,
`sql/dependencies.ts` (якщо ключі цілей там сирі). Кожен рядок таблиці
«споживач → тест» цієї частини має випадок з ім'ям у лапках. Готово:
`run-tests unit --changed`.

### Задача 4 — споживачі T2

(після 1). `schema/apply/row-version.ts`,
`plan.ts`, `steps.ts` (`inApplied`), `drift.ts` (Р10), `backfill.ts`, `state.ts`, `promotion/replacements.ts`,
`compiler/platform/install.ts`, `schema/reverse/units.ts` (Р11); читач
marker у `state.ts` (Р10, тест І6). Тригер-ключі розбираються через
`identity.ts`, не `slice` префікса. Готово:
`run-tests unit --changed`.

### Задача 5 — designer

(після 1). `census-read.ts`, `tools/database-tools.ts`
(шляхи `units.<ідентичність>` і розбір ключа `sequenceOwnedBy` — через
`identity.ts`; `StableId` двигуна не чіпати, Р9).
Готово: `run-tests unit --changed` для designer.

### Задача 6 — запобіжник lint

(після 3–5). Правило Р4 лише для
виробничих `src/**` (без `__tests__`, `*.support.ts`). Селектор зливається в
наявні масиви опцій `no-restricted-syntax` за зразком
`packages/simetra/eslint.standard-columns.js` (flat config замінює опції
правила пізнішим блоком, а `src/ui/**` має свої — окремий блок мовчки
вимкнув би старі правила); для designer — `packages/designer/eslint.zones.js`.
Негативний тест — поруч із `packages/simetra/test/tier-boundary.test.ts`:
шаблон `` `trigger:${…}` `` дає помилку, і наявні селектори в тому самому
глобі досі спрацьовують. Готово: `run-tests unit
--filter <негативний тест>` зелений і червоніє без правила; lint дерева —
гейт CI на draft PR.

## Задачі власника

Немає. Стеки не змінюються (DB-тест задачі 2 створює лише свої об'єкти).

## Підсумок аудиту

Раунд 1 — Sonnet «план проти спеки й коду» і Opus «безпека». Sonnet: 3 major
(рядки з константами без мутації → запобіжник lint; область і злиття
правила lint; колізія імен файлів зворотної генерації → Р11), 2 minor
(`database-tools.ts` `sequenceOwnedBy`, `pipeline.ts`) — усе внесено. Opus:
безпекова major (хибний `apply.drift` від старих ідентичностей у marker →
Р10), minor (DB-тест І1 без тихого шляху регістру) — внесено. Раунд 2 —
Opus на дифі: 3 major (тест І6 обходив читача; поведінка нечитної одиниці
marker; схема в І1) і minor (`resultCatalog` артефакту плану) — внесено.
Codex (`codex-audit`, 5 питань, 34 файли): 5 major. Підтверджено й внесено:
`drift-partial` не має загальної гілки (зміна гейта названа в Р10),
виняток «тотожний SQL» у `providerTriggerConflicts` (Р10), пропущений
`steps.ts` `inApplied`. Підтверджено, винесено на розвилку: `%type` (Р8) — архітекторка обрала помилку компілятора, розгортання — #300.
Частково: некваліфікований тип розширення залежить від `search_path` —
наявна поведінка, прийнята спекою П2 §8.3; блок її не змінює й не
погіршує. Зона marker повторилась у трьох раундах; причина — збережена
копія похідної ідентичності, і Р10 прибирає її як друге авторитетне
сховище. Лишилось: 0 blocker, 0 безпекових major.
