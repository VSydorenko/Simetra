# Промоція-4 — мутація `promote`, мапінг і переписувач тіл функцій: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** прийнята `CustomTable` (разом із таблицями своїх ТЧ) однією
перевіреною файловою мутацією `promote` стає довідником, документом без рухів
або незалежним регістром відомостей. Ця мутація:

- переносить id і канонізує імена;
- переписує тіла функцій, що згадують промотовані таблиці;
- повертає запис промоції «що на що» для плану бази П3.

Заодно закрита оболонка функції забороняє динамічний SQL.

**Архітектура:**

- **T1 (`packages/simetra/src/compiler`)** отримує:
  - модуль розбору PL/pgSQL;
  - переписувач SQL-тексту за позиціями парсера (`sql/rewrite/`);
  - операцію `promote` (`operations/promote/`), побудовану як інші мутації: чиста функція над мапою файлів, компіляція перед записом, усе або нічого.
- Мапінг — разовий вхід операції (Zod у `operations/inputs.ts`); у
  `metadata/` він не лишається.
- Операція повертає `PromotionRecord`: перейменування, кроки даних, зняте з
  класами конверсії. Зберігає запис і будує з нього план бази П3 (спека
  промоції §16 п.5).
- Перевірка «призначене раз» розпізнає промоцію з ідентичності.
- **`@simetra/designer`** отримує інструмент каталогу `promote` (`files: "write"`,
  `database: "none"`).

**Технології:**

- TypeScript 7, Zod 4, Vitest;
- `libpg-query` 17.7.4 — розбір і позиції, без змін;
- нова залежність `@libpg-query/parser` 17.8.0 — лише `parsePlPgSQLSync`;
- локальний стек Supabase (Postgres 17, розширення `plpgsql_check` 2.8 — для DB-тесту).

**Спека:**

- [спека промоції](../specs/2026-10-06-promotion-design.md): §4, §5, §6, §7.1, §8, §9.4, §9.6, §9.10, §9.11, §11, §16 п.3, Пр2–Пр4, Пр9, Пр18, Пр21, Пр25;
- [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md): §3 («Дослівний SQL», «Призначене раз — правило компілятора»), §8.6;
- [спека designer](../specs/2026-10-02-simetra-designer-design.md): §3.1, §3.2;
- [CONTRIBUTING](../../../CONTRIBUTING.md): § "Dependencies".

**Передумова:**

- плани промоції 1, 2a, 2b, 3 виконано (мітка виду, `ASSIGNED_ONCE`, закриті форми, `sql-debt.json`, системна схема);
- `orient --plan` цього файлу;
- локальний стек (`pnpm db:start`);
- на checkout працює одна сесія, що комітить.

**Архітектор задачі:** сесія `consumer-reconciliation`. Розвилки й тексти
правок спек — до неї (`SendMessage`); якщо сесії немає — до власника.

**Поза планом (свідомо):**

- зберігання `PromotionRecord`, план бази з наміром перейменування (розширення порту T2 `SchemaEngine`, `acceptRenames` pg-delta, зняття `renames: "off"` в адаптері);
- класи кроків, дозволи за хешем, репетиція, застосування однією транзакцією, ledger, відбиток каталогу, `plpgsql_check` у тіні;
- зворотне читання дослівних не-функцій боргу з тіні — усе П3 (§16 п.5);
- документ із рухами, регістри накопичення, регістр відомостей, підпорядкований реєстратору — підплан регістрів (§16 п.6);
- скіл конверсії (§16 п.4);
- конверсія об'єктів `PgEnum` у `Enumeration` (лише колонка → `Ref` на наявне перерахування);
- опція «лишити прийняте фізичне ім'я» — відхилена власником (Пр18: канонізація повна);
- codemod коду споживача;
- переписування `.module.ts`.

## Global Constraints

- 🔴 **Розбіжність спеки з кодом — стоп.** Поведінка коду чи спеки поза
  рішеннями нижче — стоп і звіт архітекторові.
- 🔴 **Правки спек — один docs-коміт, текст до коміту переглядає
  архітектор** (задача 1).
- 🔴 **Сканер libpg-query не вживається** (`scan`, `scanSync` жодного з
  пакетів): у збірці PG17 він переповнює буфер на токені довшому за ~1,3 КБ.
  Позиції — лише `location` дерев `libpg-query` 17.7.4 і `lineno` дерева
  PL/pgSQL.
- 🔴 **Залежність:** `"@libpg-query/parser": "17.8.0"` — точний пін у
  `packages/simetra/package.json`, жодного діапазону; з пакета імпортуються
  лише `loadModule` і `parsePlPgSQLSync`.
- Переписувач ніколи не пропускає мовчки: місце, яке він не довів статично, —
  гучна діагностика з файлом і рядком, і операція не пише нічого.
- Переписувач не змінює нічого, крім токенів імен, які він резолвив, і
  вставок `AS <старе>`: коментарі, розкладка й регістр решти тексту
  зберігаються байт у байт.
- Операція не має евристик щодо змісту колонок і не ставить запитань: кожна
  колонка, одиниця й структурний елемент або названі у вході, або відмова.
- Кожне розгалуження за видом читає реєстр видів (`KIND_REGISTRY`), а не ім'я
  виду.
- Нове правило — рядок у `COMPILER_RULES` (`compiler/diagnostics.ts`) і
  тексти en/uk (+ hint, де є що порадити) у `compiler/messages.ts`.
- Без шимів; коментарі — українською, «чому»; 🔴 без `--` перед шаблоном
  vitest; коміти — Conventional Commits українською, без трейлерів.
- Тексти, які бачить споживач (описи Zod-полів, повідомлення, опис
  інструмента, скіл), — англійською (uk-повідомлення — українською).

## Рішення плану

Рішення ухвалив архітектор задачі (сесія `consumer-reconciliation`)
2026-10-10.

1. **Залежність і позиції.** `@libpg-query/parser` 17.8.0 (MIT, гілка
   граматики PG17 та сама, що в `libpg-query` 17.7.4) — лише
   `parsePlPgSQLSync`: дерево, `lineno`, виявлення динамічного SQL.

   Позиції правок:
   - беруться з `location` дерева `libpg-query` 17.7.4 (байти UTF-8 →
     індекси UTF-16 через `byteOffsets`);
   - розбирається текст кожного виразу PL/pgSQL окремо (див. рішення 9);
   - текст виразу розміщується в тілі верифіковано;
   - результат перевіряється повторним `parsePlPgSQLSync` і рівністю
     послідовності текстів виразів очікуваній.

   Обмеження:
   - тіло функції — лише в доларових лапках, текст тіла береться з дерева й
     звіряється з вирізаним;
   - deparse не вживається.

   Альтернатива `libpg-query@18.1.5` (сканер виправлено) відхилена:
   граматика PG18 ≠ мінімальна ціль PG17, друга копія того самого пакета.
2. **Межа з П3.** `promote` — чиста файлова мутація: `files: "write"`,
   `database: "none"`, `destructive: false` (файли в git; втрата даних у базі —
   дозволені кроки П3).

   Результат несе `record: PromotionRecord` (задача 7) — він і є переглядом
   «що на що перетворюється» (§7.1); загальний dry-run каталогу не
   змінюється.
3. **«Призначене раз» проти канонізації (Пр18).** Виняток розпізнається з
   ідентичності. Об'єкт, який у базовому стані був `CustomTable`, а в
   поточному — вид 1С з тим самим id, — промотований. Звільнено лише:
   - `physicalName` промотованого об'єкта;
   - `physicalName` кожного елемента, чий носій у базовому стані лежав у файлі
     промотованого об'єкта або у файлі `CustomTable`, id якої тепер — таблична
     частина промотованого об'єкта;
   - перехід `kindLabel` «значення → відсутність» лише тоді, коли поточний вид
     мітки не має (`KIND_REGISTRY[kind].kindLabel !== true`) **і** жоден
     поліморфний `Ref` проєкту не має цього об'єкта ціллю. Коментар біля
     правила: «значення може лежати в даних; повторне вживання — борг П3».

   Будь-яка інша зміна `kindLabel`, `schema` чи `physicalName` — і далі
   `identity.assigned-once-changed`. Окремого файлу-декларації немає (§4).
4. **Мітка виду (Пр25, §9.11).**
   - Мітка `CustomTable` переходить у файл виду без змін.
   - «Наявна мітка споживача» — це мітка, яку скіл поставив у `kindLabel`
     прийнятої таблиці до її першого коміту.
   - Інакше вхід називає `consumerLabels` — значення, якими дані споживача
     кодують цей об'єкт. Тоді:
     - запис несе `labelTranslation`: мапу «стара мітка → `kindLabel`» і
       перелік поліморфних колонок-споживачів (`_type`-колонки пар
       `allowedTypes`/`owners`/`recorderTypes`, ціллю яких є цей об'єкт),
       знайдених статично. Ці колонки лежать в інших таблицях, тож `fill` їх не
       торкається: кроки перекладу міток **виводить П3** із запису;
     - рядковий літерал, рівний одному з `consumerLabels`, у тілі
       переписуваної функції — гучна діагностика `rewrite.label-literal`.
   - Ціль `InformationRegister` (мітки не має):
     - якщо об'єкт — ціль поліморфного `Ref`, це відмова `promote.label-target`;
     - інакше мітка зникає.
5. **Доля залежного SQL і структурних елементів.** Вхід класифікує:
   - кожну SQL-одиницю модуля (`<Ім'я>.sql`) промотованих таблиць, що не є
     функцією в закритій оболонці;
   - кожну одиницю деінде, ціль якої (`unitTargets`) — промотована таблиця:
     політики, тригери, гранти, коментарі, publications, `REPLICA IDENTITY`;
   - кожен прийнятий `uniques` / `checks` / `indexes` таблиць одиниці;
   - значення за замовчуванням колонки, змапленої на власний реквізит, якщо
     `element` не задає `defaultValue` (ключ `"<CustomTable>#default/<колонка>"`).
     Значення за замовчуванням колонки, змапленої на стандартний реквізит,
     заміщує значення виду — його еквівалентність бачить план П3.

   Деталі класифікації:
   - Класи: `platform | property | rowRule | metadata | applicationCode | removed`.
     Некласифіковане — відмова `promote.unclassified`.
   - Класифіковане знімається з файлів, а клас іде в запис.
   - Функція в закритій оболонці з модуля переходить у закритий модуль виду
     (або, якщо вона названа в `sharedFunctions`, — у
     `sql/<схема>/<ім'я функції>.sql`) і переписується.
   - Тригер знімається з класом `property`; `EventSubscription` створює
     окремий `create` після `promote`.
   - Дослівна **не-функція деінде**, текст якої згадує промотовану таблицю
     чи її колонку (в'юха, політика іншої таблиці), — гучна відмова
     `promote.debt-text-reference` зі списком місць. Зворотне читання з тіні —
     П3 п.5.
   - FK не класифікуються: колонка з FK стає `Ref` чи стандартним
     реквізитом, а зміна семантики видалення в будь-який бік (§9.5, Пр8) іде
     в запис (`deleteSemantics`) для дозволу П3:
     - власний FK з `CASCADE`/`SET NULL` стає restrict (`direction: "own"`);
     - ТЧ, прийнята з `NO ACTION` на власника, отримує каскад виду (`direction: "own"`, `to: "cascade"`) — розширення;
     - вхідний FK з `CASCADE`/`SET NULL` з таблиці, що лишається `CustomTable`,
       у сам промотований об'єкт (`direction: "incoming"`, дія не змінюється,
       але потребує дозволу). Посилання ззовні одиниці на таблицю ТЧ (FK,
       `Ref`, підписка) — `promote.unit-unsupported`: ТЧ не є об'єктом, на який
       посилаються.
6. **Одиниця й гейти.**
   - Ціль — `Catalog`, `Document` без `posting` або `InformationRegister` з
     `writeMode: "Independent"`, разом із таблицями ТЧ. Інше —
     `promote.unit-unsupported`.
   - Посилання (FK, `Ref`) таблиці одиниці на `CustomTable` поза одиницею —
     `promote.reference-not-promoted` (§11).
   - Гейт шляху запису (Пр21) — у файлах, до будь-яких змін. Спрацьовує, якщо:
     - `GRANT` з `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`ALL` на таблицю одиниці
       ролі API провайдера (`PROVIDER_API_ROLES`, `PUBLIC`);
     - одиниця типових привілеїв (`ALTER DEFAULT PRIVILEGES … GRANT … ON TABLES`) схеми таблиці надає такий привілей тим самим ролям. Зворотна генерація не пише явного `GRANT`, коли ACL таблиці дорівнює типовим привілеям схеми (`expectedPrivileges` у `packages/designer/src/schema-engine/pg-delta/map-units.ts`), тож саме так виглядає типова схема Supabase;
     - політика команди `INSERT`/`UPDATE`/`DELETE`/`ALL` на таблиці.

     Тоді — `promote.write-path`. Повідомлення називає відкрите питання «Шлях
     запису після промоції» (§17).
   - Зовнішній FK колонки на таблицю користувачів провайдера (§9.10) —
     дозволено лише як `{ "to": "scope" }` виду скоупу із зовнішнім коренем на
     цю таблицю; інакше `promote.provider-user-reference`.
7. **Динамічний SQL заборонено в закритій оболонці.** `ClosedShellProblem`
   отримує два значення:
   - `dynamicSql` — `PLpgSQL_stmt_dynexecute`, `PLpgSQL_stmt_dynfors`,
     `PLpgSQL_stmt_return_query` з `dynquery`, `PLpgSQL_stmt_open` з `dynquery`;
   - `body` — тіло plpgsql не розбирається: синтаксична чи семантична помилка
     парсера PL/pgSQL.

   Де діє:
   - скрізь, де перевіряється оболонка: модуль виду, обробник підписки,
     функція множини, `debtUnits`/`checkDebt`, зворотна генерація;
   - функція з динамічним SQL у модулі боргу стає боргом: `introspect` засіває
     її сам, рукописна дає `sql.debt-grows`.
8. **Вхід** — inline JSON, як у решти мутацій: CLI позиційно чи stdin `-`,
   MCP — аргументами. Бюджет `tools/list` у `mcp.test.ts` перевимірюється з
   обґрунтуванням у коментарі. Його визначає структура мапінгу (колонки
   розгортаються в корені й у кожній ТЧ), а не описи; правила входу `promote`
   живуть у скілі й повідомленнях відмов, а схема каже лише «що» (описи
   лишаються там, де ім'я поля не пояснює вмісту).
9. **Колонка `PgEnum`** мапиться лише на `Ref` до наявного `Enumeration`,
   фізичні мітки значень якого включають усі мітки енаму (Пр9; статична
   перевірка). Інакше — `promote.enum-labels`.
10. **Фізичні імена — завжди канонічні:** операція стирає `physicalName`
    об'єкта, ТЧ і власних реквізитів, а доповнення (`completeFiles`) призначає
    їх наново тим самим правилом, що `fix`.
11. **Логічні імена стандартних реквізитів у вході** — канонічні camelCase
    (`StandardColumnDef.logicalName`: `ref`, `description`, `deletionMark`,
    `parent`, `owner`, `number`, `date`, `posted`, `lineNumber`, `period`, …)
    незалежно від `naming.attributeCase`. У файлах після промоції посилання на
    них пишуться в стилі проєкту (`standardLogicalName`).
12. **`fill` — одна форма для конверсії, розщеплення, дозаповнення й
    ремонту.** Крок `{ table?, target, expression }` задає значення колонки
    цілі виразом над рядком прийнятої таблиці.

    **Стан імен:** вираз пишеться й виконується над **старими** фізичними
    іменами, до перейменувань. Запис каже це явно
    (`dataSteps[].names: "beforeRenames"`, `table` — старе ім'я), і П3 виконує
    крок у транзакції до `RENAME`.

    **Вид кроку** операція виводить сама, у такому пріоритеті:
    1. `repair` — ціль змаплена з колонки;
    2. `conversion` — вираз читає хоча б одну виведену з ужитку колонку;
    3. `split` — вираз читає колонку, що лишилась реквізитом;
    4. `backfill` — вираз колонок не читає.

    **Вираз** — рівно один скалярний вираз над колонками своєї таблиці. П3
    виконує крок як `UPDATE … FROM (SELECT id, <вираз> …)`, тому віконні
    функції дозволено. Таблиця має мати одноколонковий первинний ключ — це
    гейт для регістрів відомостей зі складеним ключем. Заборонено:
    - підзапити, агрегати без `OVER` (зокрема `JSON_ARRAYAGG`/`JSON_OBJECTAGG`),
      посилання на інші таблиці;
    - кілька операторів чи кілька цілей у списку виводу;
    - віконна функція, `ORDER BY` вікна якої не містить ключа таблиці
      (порядок недетермінований).

    **Ключ вікна** (`PARTITION BY`, `ORDER BY`) резолвиться й перевіряється
    (колонки своєї таблиці, без підзапитів, `ORDER BY` містить ключ), але виду
    кроку не задає: він лише впорядковує рядки, тож виведена колонка в ньому
    допустима. Аргументи віконної функції — прочитані колонки.

    **Виклики — лише доведено детерміновані.** Кожен виклик функції доводиться,
    а не відхиляється за переліком:
    - функція каталогу — лише ім'я зі знімка
      `operations/promote/catalog-functions.ts`: функції `pg_catalog`
      (`oid < 16384`), усі перевантаження яких `provolatile = 'i'` і жодне не
      `proretset`; значення — `prokind`, тож агрегат і віконна функція й далі
      вимагають `OVER`. Знімок генерує `pnpm --filter simetra catalog-functions`
      над локальним стеком, а DB-тест звіряє його з живим Postgres. Чого в
      знімку немає (невідома функція, `extensions.*` чи інша схема, STABLE,
      VOLATILE, функція множини) — відмова;
    - єдиний виняток з IMMUTABLE — час транзакції: `now`, `current_timestamp`,
      `current_date`, `transaction_timestamp`, `statement_timestamp`,
      `localtimestamp`, `localtime`, `current_time` (зокрема формами
      ключових слів). Поза `repair` дозволено, у `repair` — відмова: ремонт
      наявних даних детермінований. Іншого STABLE немає ніде;
    - функція моделі — лише з явною `IMMUTABLE` для будь-якого виду кроку;
      STABLE, без позначки, VOLATILE, `SETOF`/`TABLE` чи агрегат — відмова.
      Некваліфіковане ім'я, яке модель визначає не лише як IMMUTABLE, —
      відмова: перевантаження й `search_path` статично не видно;
    - приведення типів і оператори волатильністю не перевіряються (це вимагало
      б виводу типів). Виняток — рядки `'now'`, `'today'`, `'tomorrow'`,
      `'yesterday'` (без урахування регістру й пробілів), приведені до типу дати
      чи часу будь-якою формою (`::`, `CAST`, `timestamptz '…'`): у `repair` —
      відмова, деінде — як `now()`. Звичайні літерали дати
      (`'2024-01-01'::timestamptz`) — константи.

    Порушення — `promote.expression-invalid` з `params.reason` і
    `params.at: /fill/<i>/expression`.

    **Ключ не заповнюється:** крок на ключову стандартну колонку (`ref`) —
    відмова завжди, змаплена вона чи ні: ключ несе ідентичність рядка.

    Стандартна колонка виду з `notNull` без `default`/`defaultValue`/
    `generated`, не змаплена й без `fill`, — `promote.fill-missing`. Так само
    новий обов'язковий реквізит, який задає лише `into.data` чи
    `tabularSections[].data`, без `defaultValue` і без `fill`
    (`reason: "new-attribute"`).

    **Контракт П3:** крок даних виконується з закріпленими `TimeZone`,
    `DateStyle`, `IntervalStyle` (`SET LOCAL` у транзакції промоції, ті самі
    значення на репетиції й робочій базі).
13. **Правила резолву переписувача** (задачі 5–6):
    - ім'я таблиці — за схемою; некваліфіковане — за `SET search_path`
      функції, без нього — `rewrite.unqualified-table`, якщо ім'я збігається з
      промотованою таблицею;
    - колонка — за областями `FROM` поточного й зовнішніх рівнів запиту;
      некваліфікована колонка, що збігається з іменем змінної PL/pgSQL чи
      параметра, — `rewrite.ambiguous-name`;
    - кожне голе посилання на перейменовану колонку в списку виводу
      `SELECT` отримує ` AS <старе>` (форма запису, RPC і підзапиту не
      змінюється — як Postgres робить для в'юх). Виняток: верхній список
      синтетичної обгортки `SELECT <вираз>` виразу PL/pgSQL (умова,
      значення, права частина присвоєння, параметр `RAISE`) і `PERFORM` —
      їхні імена виводу ніде не спостерігаються, а `AS` там зламав би вираз;
    - `NEW.<колонка>`/`OLD.<колонка>`, зокрема ціль присвоєння, — лише коли
      функція прив'язана тригерами чи підписками рівно до промотованих
      таблиць, що однаково перейменовують колонку; інакше
      `rewrite.trigger-binding`;
    - змінна `<таблиця>%ROWTYPE` і запис, заповнений `SELECT * INTO` чи `FOR …
      IN SELECT * FROM` однієї промотованої таблиці, — поля переписуються за
      мапою колонок; `%TYPE` — переписується текст типу в `DECLARE`,
      нерезольвний — `rewrite.unresolved-type`;
    - посилання на перейменоване ім'я у вузлі без `location` (список `USING`,
      `ON CONFLICT (…)`) — `rewrite.unsupported`;
    - ` AS <старе>` діє й у списках `RETURNING`;
    - ціле `NEW`/`OLD` як значення, `*` промотованої таблиці у списку виводу,
      `RETURNS SETOF`/`%ROWTYPE` промотованої таблиці в сигнатурі —
      попередження `rewrite.contract-change` без правки. `SELECT * INTO r`,
      де `r` — `%ROWTYPE` тієї самої таблиці, — не зміна контракту;
    - зміна контракту функції (`RETURNS SETOF`/`RETURNS <таблиця>`/`%ROWTYPE`)
      транзитивно поширюється на функції-викликачі проєкту — попередження
      `rewrite.contract-change` (`reason: "caller"`) зі списком ланцюжка;
      рішення — скіл конверсії;
    - **обсяг** переписування визначає резолв, а не слово. Слово — це лише
      надмножинний **відбір кандидатів**: функція, текст якої містить старе
      фізичне ім'я промотованої таблиці як слово (без урахування регістру),
      прив'язана до промотованої таблиці чи переходить з модуля одиниці.
      Кандидат, у якому резолв не знайшов посилань, лишається без змін і не
      йде в запис;
    - кандидат із динамічним SQL — `rewrite.dynamic-sql`. Функція боргу
      проєкту з динамічним SQL поза кандидатами — попередження
      `rewrite.dynamic-sql-unscoped` зі списком: SQL, що збирає ім'я таблиці
      з частин, статичний аналіз не бачить, і це межа, названа в спеці;
    - дослівна не-функція деінде (рішення 5) потрапляє під відмову
      `promote.debt-text-reference` за резолвом залежностей
      (`compiler/sql/dependencies.ts`: посилання на відношення промотованої
      таблиці), а не за словом;
    - `lineno` PL/pgSQL рахується від початку тіла: рядок 1 — рядок
      відкривального `$тег$`. Абсолютний рядок у тексті одиниці = рядок
      `$тег$` + `lineno` − 1;
    - вирази розміщуються в порядку тексту (стабільне сортування за
      `lineno`), кожен — після попереднього збігу й не раніше початку свого
      рядка.
14. **Захоплення імен** (архітектор, 2026-10-10, за знахідкою задачі 5).
    Некваліфіковане ім'я резолвиться двічі — за каталогом до промоції
    (`knownTables`) і після (`TableRename.columnsAfter`). Якщо цілі різні з
    точністю до мапи перейменувань — `rewrite.ambiguous-name` з
    `detail: "capture"`, без правки. Захоплення дають:
    - додані колонки виду;
    - цілі перейменувань, яких до промоції не було (`name → description` у
      внутрішній таблиці захоплює некваліфіковане `description` зовнішньої
      області);
    - зняті колонки: ім'я, що резолвилось у внутрішню таблицю, після зняття
      мовчки падає в зовнішню.

    Те саме для імені, що було змінною чи параметром PL/pgSQL і після
    промоції збігається з колонкою таблиці в області. Посилання на зняту
    колонку (без нового імені) — відмова. `topLevelOutput: "ignore"`
    (зокрема й гасіння звіту `star`) — лише для `PERFORM` і синтетичної
    обгортки виразу; `RETURN QUERY`, `SELECT … INTO` запису, `FOR … IN
    SELECT` лишають звіт. `INSERT` без списку колонок у промотовану таблицю —
    `contract-change` (`star`): позиційну вставку ламають додані й зняті
    колонки, а не перейменування.
    Захоплення буває й через ім'я відношення: видиме ім'я елемента `FROM` після перейменування таблиці без аліасу та аліас `JOIN` — теж `rewrite.ambiguous-name`; некваліфікована промотована таблиця переписується, лише коли в `search_path` перед її схемою немає схеми поза моделлю (`detail: "search-path"`).
15. **Посилення й режим RLS у записі** (архітектор, 2026-10-10, за знахідками
    задачі 7).
    - `tightened: { schema; table; column; constraint: "notNull" }[]` (нові
      фізичні імена). Ціль `notNull` (стандартний реквізит виду чи власний з
      `required: true`), джерело якої nullable, вимагає кроку `fill` на цю
      ціль, інакше `promote.fill-missing` з `params.reason: "nullable-source"`.
      `default` стандартної колонки від кроку не звільняє: `DEFAULT` не
      заповнює наявні `NULL`. Звільнення за `default` — лише для незмапленої
      колонки (рішення 12). Виведений вид кроку — `repair`, тож `now()` у ньому
      заборонено й далі: ремонт наявних даних детермінований.
    - `rowLevelSecurity: { schema; table; from: "off" | "forced"; to:
      "enabled" }[]` — для кожної таблиці об'єкта, зокрема ТЧ, у старих
      іменах. `off → enabled` звужує читання, `forced → enabled` розширює
      доступ (власник і `SECURITY DEFINER` перестають підпадати під
      політики). Гейта й ключа в `conversions` немає: `conversions`
      класифікує видалення, а зміну доступу ловить гейт еквівалентності «роль ×
      дія × рядок» П3 окремим дозволеним кроком; запис дає П3 явний перелік.
    - Коментар колонки, змапленої на стандартний реквізит чи `scope`, —
      ключ `"<CT>#comment/<колонка>"` у `conversions`; коментар таблиці, коли
      `into.data` задає інший `description`, — `"<CT>#comment"`. Допустимий
      клас — лише `removed` (опис стандартного реквізиту бере вид), інший —
      `promote.unclassified` з причиною; некласифікований —
      `promote.unclassified`. Коментар виведеної з ужитку колонки йде разом із
      колонкою.
    - Власний реквізит, чий `element.description` відрізняється від коментаря колонки, теж вимагає ключа `"<CT>#comment/<колонка>"` (лише `removed`); при збігу чи без опису ключ не потрібен.
    - Nullable-колонка, змаплена на `scope`, — `promote.type-unsupported` з `params.reason: "nullable-scope"`: `fill` скоуп не адресує, а призначення тенанта — рішення про належність даних; шлях споживача — позначити колонку `notNull` у `CustomTable`, застосувати звичайним конвеєром, потім промотувати.
    - `.module.ts` прийнятої таблиці переїжджає в теку виду байт у байт (як
      у `rename`); у запис не йде — переїзд видно в мапі файлів результату.

## Review Focus

1. **Тіло з довгим рядковим літералом (2000 символів)** переписується без
   падіння: сканер не вживається, а розбір виразу йде деревом. Тест —
   задача 6.
2. **Ідентифікатор у коментарі чи рядковому літералі**, що збігається зі
   старим іменем колонки, не змінюється; коментар зберігається байт у байт.
   Тест — задачі 5 і 6.
3. **Кирилиця перед перейменованим посиланням** (коментар чи літерал у тому
   самому рядку): байтові позиції UTF-8 переводяться в UTF-16 правильно.
   Тест — задачі 5 і 6.
4. **Та сама назва колонки у двох таблицях `FROM` або змінна, названа як
   колонка**, дає гучну відмову, а не правку не того токена. Тест — задача 5.
5. **Тригерна функція, прив'язана до промотованої й непромотованої
   таблиць**, де вжито `NEW.<колонка>`, дає відмову `rewrite.trigger-binding`.
   Тест — задача 6.

---

### Task 0: Звірка плану з кодом і базова лінія

**Files:** — (лише читання)

- [ ] **Step 1: Якори**

Run: `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-10-promotion-4-promote-mapping-rewriter.md`
Expected: якори існують, крім позначених `Create`. Інакше — стоп і звіт.

- [ ] **Step 2: Базова лінія**

Run: `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`,
`pnpm metadata:check`, `pnpm db:start && pnpm test:db`
Expected: зелено.

---

### Task 1: Правки спек (один docs-коміт, перегляд архітектора)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-06-promotion-design.md` (§4, §6, §7.1, §9.11, Пр4, Пр18)
- Modify: `docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md` (§3 «Дослівний SQL», §3 «Призначене раз — правило компілятора», §8.6)
- Modify: `docs/superpowers/specs/2026-10-02-simetra-designer-design.md` (§3.1, перелік мутацій)

- [ ] **Step 1: Написати правки**

1. **Спека промоції §6, пункт «Тіла функцій у закритій оболонці».**
   Формулювання «за позиціями парсера (libpg-query: сканер токенів і парсер
   PL/pgSQL)» замінити за рішенням 1:
   - позиції — `location` дерева розбору ядра в тексті кожного виразу;
   - дерево PL/pgSQL дає оператори й `lineno`;
   - текст виразу розміщується в тілі верифіковано, результат перевіряється
     повторним розбором;
   - сканер не вживається, бо у збірці PG17 переповнює буфер на довгих
     токенах.

   Речення про «нове рішення про залежність» замінити фактом: `@libpg-query/parser`
   17.8.0, точний пін, лише парсер PL/pgSQL. Правила переписувача доповнити
   рішенням 13 (області `FROM`, `AS <старе>` для кожного голого посилання у
   списку виводу й `RETURNING`, записи `%ROWTYPE`/`SELECT * INTO`, вузли без
   позиції → відмова, транзитивна зміна контракту викликачів). Явно: обсяг
   переписування визначає резолв; пошук старого імені як слова — лише
   надмножинний відбір кандидатів, а не гейт (узгоджено з «пошук залишків —
   за резолвом, а не за словом»); не-функції боргу — за резолвом залежностей.
2. **Спека промоції §7.1.** Мутація чисто файлова; результат несе запис
   промоції (рішення 2); вхід, крім мапінгу, класифікує одиниці й структурні
   елементи (рішення 5); гейти у файлах (рішення 6); функції переходять у
   закритий модуль виду чи в спільний `sql/<схема>/`; дослівні не-функції
   деінде, що згадують промотоване, — відмова до П3 (рішення 5).
3. **Спека промоції §9.11 і Пр18.** Виняток «призначене раз» розпізнається з
   ідентичності (рішення 3) — без декларації. Мітка при цілі без мітки
   (регістр відомостей) зникає лише тоді, коли об'єкт не є ціллю поліморфного
   `Ref` (рішення 4). Абзац «Промоція» §9.11: переписування даних поліморфних
   колонок інших таблиць виводить П3 із запису промоції (мапа «стара мітка →
   мітка виду» й колонки-споживачі, знайдені статично), а не вираз мапінгу
   (рішення 4); §4 «Мітка виду» узгодити з цим.
4. **Спека промоції §4.** Вираз конверсії, розщеплення й дозаповнення
   пишеться над старими фізичними іменами й виконується до перейменувань;
   вимагає одноколонкового ключа таблиці (рішення 12).
5. **Спека П2 §3 «Дослівний SQL».** Речення «заборона динамічного SQL
   приходить із парсером PL/pgSQL (план переписувача)…» → закрита оболонка
   забороняє динамічний SQL і нерозбірне тіло plpgsql (рішення 7);
   `plpgsql_check` у тіні — П3.
6. **Спека П2 §3 «Призначене раз — правило компілятора».** Фразу «виняток
   промоції — ledger П3, не цей механізм» замінити рішенням 3: у файлах
   виняток розпізнається з ідентичності, а ledger П3 захищає базу.
7. **Спека П2 §8.6 і спека designer §3.1.** У переліку мутацій — `promote`
   (вхід — мапінг, результат — зміни файлів і запис промоції; не руйнівна).

- [ ] **Step 2: Якори**

Run: `python3 scripts/check-doc-anchors.py`
Expected: чисто.

- [ ] **Step 3: Перегляд архітектора**

Надіслати `git diff` сесії `consumer-reconciliation`; правки за відповіддю —
до коміту.

- [ ] **Step 4: Коміт**

```bash
git add docs/superpowers/specs/
git commit -m "docs(spec): промоція-4 — переписувач без сканера, promote як файлова мутація, динамічний SQL поза оболонкою, виняток «призначене раз» з ідентичності"
```

---

### Task 2: Залежність і розбір PL/pgSQL

**Files:**
- Modify: `packages/simetra/package.json` (`"@libpg-query/parser": "17.8.0"`), `pnpm-lock.yaml`
- Modify: `packages/simetra/src/compiler/sql/parse.ts` (експорт `byteOffsets`)
- Create: `packages/simetra/src/compiler/sql/plpgsql.ts`
- Test: `packages/simetra/src/compiler/__tests__/plpgsql.test.ts`

**Interfaces:**
- Produces:
  - `byteOffsets(text: string): (byte: number) => number` — UTF-8 байт → індекс UTF-16; байт не на межі символу — `Error` (наявний `ByteOffsets`, тепер експортований функцією; приватний клас прибрати).
  - `type PlpgsqlParser = (createFunctionSql: string) => PlpgsqlParse`
  - `type PlpgsqlParse = { ok: true; fn: PlpgsqlFunction } | { ok: false; message: string } | { ok: true; fn: undefined }` — `fn: undefined` для мови не plpgsql.
  - `interface PlpgsqlFunction { variables: PlpgsqlVariable[]; statements: PlpgsqlStatement[]; dynamicSqlLines: number[] }`
  - `interface PlpgsqlVariable { name: string; lineno?: number; typeText?: string; kind: "var" | "rec" | "row" | "recfield" }` — `NEW`/`OLD` — `rec` з іменами `new`/`old`.
  - `interface PlpgsqlStatement { type: string; lineno: number; depth: number; expressions: PlpgsqlExpression[]; target?: { variable: string } }` — обхід дерева в глибину; `expressions` — лише прямі вирази оператора, без вкладених операторів. Порядок тексту для розміщення дає стабільне сортування всіх виразів за `lineno` (умова `ELSIF` стоїть у тексті після тіла `THEN`, хоча в дереві — раніше).
  - `lineno` — від початку тіла: рядок 1 — рядок відкривального `$тег$`.
  - `interface PlpgsqlExpression { query: string; parseMode: number; role: "condition" | "value" | "statement" | "assign" | "dynamic"; into?: boolean; perform?: boolean; lineno: number }` — `lineno` — найближчого предка з `lineno` (зокрема `PLpgSQL_if_elsif`, `PLpgSQL_case_when`).
  - `loadPlpgsqlParser(): Promise<PlpgsqlParser>` — один `loadModule()` на процес, як `loadSqlParser`; кеш результатів за текстом (`Map<string, PlpgsqlParse>`), бо оболонку перевіряють кілька стадій.

- [ ] **Step 1: Перевірити ліцензію й пін**

Прочитати `LICENSE` у репозиторії `constructive-io/libpg-query-node` (а не
метадані npm): MIT. Версія 17.x — не 0.x/alpha/beta, тож за CONTRIBUTING §
"Dependencies" достатньо точного піну. Пакет формує артефакт (переписані
файли метаданих) лише через власний тип Simetra `PlpgsqlParser` — це і є порт.
Якщо `LICENSE` не MIT — стоп і звіт.

- [ ] **Step 2: Failing tests**

```ts
const parse = await loadPlpgsqlParser()
const fn = (body: string, extra = "") =>
  `CREATE FUNCTION app.t() RETURNS trigger LANGUAGE plpgsql ${extra} AS $$\n${body}\n$$;`

it("lists direct expressions in text order with their lines", () => {
  const r = parse(fn(`BEGIN\n  NEW.total := NEW.qty * NEW.price;\n  IF NEW.status = 'draft' THEN\n    PERFORM pg_notify('x', 'y');\n  END IF;\n  RETURN NEW;\nEND`))
  // `RETURN NEW` компілюється у `retvarno` без виразу, тож його вирази тут не перевіряються.
  expect(r.ok && r.fn?.statements.slice(0, 4).map((s) => [s.type, s.lineno, s.expressions.map((e) => [e.role, e.query])])).toEqual([
    ["block", 2, []],
    ["assign", 3, [["assign", "NEW.total := NEW.qty * NEW.price"]]],
    ["if", 4, [["condition", "NEW.status = 'draft'"]]],
    ["perform", 5, [["statement", "SELECT pg_notify('x', 'y')"]]],
  ])
})
it("marks SELECT INTO and PERFORM forms", () => { /* into: true для execsql з INTO, perform: true для PERFORM */ })
it.each([
  ["EXECUTE format('select 1 from %I', 'sale');", 3],
  ["RETURN QUERY EXECUTE 'select 1';", 3],
  ["FOR r IN EXECUTE 'select 1' LOOP END LOOP;", 3],
  ["OPEN c FOR EXECUTE 'select 1';", 3],
])("finds dynamic SQL: %s", (stmt, line) => { /* dynamicSqlLines = [line] */ })
it("reports declared types as text", () => { /* v app.sale.amount%TYPE → typeText "app.sale.amount%TYPE" */ })
it("returns fn undefined for LANGUAGE sql", () => {})
it("turns a semantic error into ok:false", () => {
  // RETURN QUERY у не-SETOF функції: обгортка кидає SyntaxError із JSON.parse
  expect(parse(fn("BEGIN RETURN QUERY SELECT 1; END")).ok).toBe(false)
})
it("parses a body with a 2000-char literal", () => {
  expect(parse(fn(`BEGIN PERFORM '${"x".repeat(2000)}'; RETURN NEW; END`)).ok).toBe(true)
})
```

`parse.test.ts` (наявний або новий): для тексту `'Привіт', abc` байт `16`
(початок `abc`: лапка 1 + кирилиця 12 + лапка, кома, пробіл 3) дає індекс
`text.indexOf("abc")` = `10`; байт посеред кириличного символу — кидає.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter simetra test plpgsql`
Expected: FAIL (модуля немає).

- [ ] **Step 4: Implement**

Встановити залежність: `pnpm --filter simetra add @libpg-query/parser@17.8.0 --save-exact`.
`plpgsql.ts`:
- обгортає `parsePlPgSQLSync`;
- ловить і `Error`, і `SyntaxError` — це `{ ok: false }`;
- вироджений запис мови не plpgsql (без `action`) — `{ ok: true, fn: undefined }`;
- обходить `PLpgSQL_stmt_*` у порядку полів (`body`, `then_body`, `elsif_list`, `else_body`, `stmts` у `case_whens` тощо);
- вирази — кожен `PLpgSQL_expr` у полях оператора, крім вкладених операторів;
- `type` — суфікс назви вузла без `PLpgSQL_stmt_`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter simetra test plpgsql` і `pnpm --filter simetra test parse`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/simetra/package.json pnpm-lock.yaml packages/simetra/src/compiler/sql/parse.ts packages/simetra/src/compiler/sql/plpgsql.ts packages/simetra/src/compiler/__tests__/
git commit -m "feat(compiler): розбір тіл PL/pgSQL — @libpg-query/parser 17.8.0, оператори й вирази в порядку тексту, динамічний SQL"
```

---

### Task 3: Динамічний SQL і нерозбірне тіло поза закритою оболонкою

**Files:**
- Modify: `packages/simetra/src/compiler/sql/closed-forms.ts` (`ClosedShellProblem`, `closedShellProblem`, `checkSqlModules`)
- Modify: `packages/simetra/src/compiler/sql/debt.ts`, `packages/simetra/src/compiler/stages/links.ts`, `packages/simetra/src/compiler/pipeline.ts`, `packages/simetra/src/compiler/compile.ts` (прокинути `PlpgsqlParser`; `runStages` і `currentDebt` вантажать його самі — `loadPlpgsqlParser()` поряд із `loadSqlParser()`)
- Modify: `packages/simetra/src/compiler/__tests__/helpers.ts` (виклик `debtUnits` в `acceptDebt`)
- Modify: `packages/simetra/src/compiler/messages.ts` (`CLOSED_SHELL_PROBLEM.dynamicSql`, `.body`)
- Modify: `packages/simetra/src/compiler/index.ts` (експорт `loadPlpgsqlParser`, `type PlpgsqlParser`)
- Test: `packages/simetra/src/compiler/__tests__/closed-forms.test.ts`, `sql-debt.test.ts`, `event-subscriptions.test.ts`, `packages/simetra/src/schema/__tests__/reverse-generate.test.ts`

**Interfaces:**
- Consumes: `PlpgsqlParser`, `loadPlpgsqlParser` (задача 2).
- Produces:
  - `type ClosedShellProblem = "language" | "volatility" | "searchPath" | "dynamicSql" | "body"`
  - `closedShellProblem(unit: { tree: Node; sql: string }, plpgsql: PlpgsqlParser): ClosedShellProblem | undefined` — порядок перевірок: наявні три, потім `body`, потім `dynamicSql`; `params.line` діагностики `sql.closed-shell` для `dynamicSql` — рядок першого динамічного оператора у файлі.
  - `checkSqlModules(objects, units, rowRules, plpgsql)`, `debtUnits(units, objects, project, plpgsql)`, `checkDebt(…, plpgsql)` — новий останній параметр.
  - Зворотна генерація рахує борг через `currentDebt`, тож `ReverseOptions` і `database-tools.ts` не змінюються.

- [ ] **Step 1: Failing tests**

`closed-forms.test.ts` (той самий стиль `shell(...)`):

```ts
const plpgsql = (body: string) =>
  `CREATE FUNCTION public.sale_touch() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ ${body} $$;`
it("refuses dynamic SQL in a kind module", async () => {
  const found = await diagnostics({ [SALE_SQL]: plpgsql("BEGIN EXECUTE 'select 1'; RETURN NEW; END") })
  expect(found.map((d) => [d.code, d.params?.problem])).toEqual([["sql.closed-shell", "dynamicSql"]])
})
it("refuses a plpgsql body that does not parse", async () => { /* problem "body" */ })
it("accepts static plpgsql", async () => { /* без діагностик */ })
```

`sql-debt.test.ts`: функція з `EXECUTE` у модулі `CustomTable` без запису в
`sql-debt.json` → `sql.debt-grows`; із записом — чисто.
`event-subscriptions.test.ts`: обробник із `EXECUTE` →
`subscription.handler-not-closed`.
`reverse-generate.test.ts`: прийнята функція з `EXECUTE` потрапляє в
`sql-debt.json`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test closed-forms`
Expected: FAIL.

- [ ] **Step 3: Implement**

`runStages` вантажить обидва парсери (`Promise.all`) і передає `plpgsql`
кожному виклику `closedShellProblem`. `setFunctionClosedProblem` у `links.ts`
вимагає `LANGUAGE sql`, тож динамічного SQL там бути не може; виклик оновлює
лише сигнатуру. Дублювання оболонки — наявний борг, тут не розв'язується.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test closed-forms`, `pnpm --filter simetra test sql-debt`, `pnpm --filter simetra test event-subscriptions`, `pnpm --filter simetra test reverse-generate`, потім `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`, `pnpm metadata:check`
Expected: PASS; референсний домен без нових діагностик.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): закрита оболонка забороняє динамічний SQL і нерозбірне тіло plpgsql"
```

---

### Task 4: «Призначене раз» розпізнає промоцію

**Files:**
- Modify: `packages/simetra/src/compiler/assigned-once.ts`
- Test: `packages/simetra/src/compiler/__tests__/assigned-once.test.ts`

**Interfaces:**
- Produces: `assignedOnceDiagnostics(baseline, current)` — сигнатура без змін; виняток за рішенням 3. Внутрішня `polymorphicTargets(files): ReadonlySet<string>` (`"<Kind>:<Name>"`): цілі ролей поліморфних пар (`allowedTypes`, `owners` з кількома власниками, `recorderTypes`), перелік ролей — з `ReferenceRole` у `packages/simetra/src/model/kinds/standard.ts`.

- [ ] **Step 1: Failing tests**

Базовий стан — `CustomTable` `Counterparty` (id `uuid(1)`, `physicalName:
"counterparties"`, `kindLabel: "counterparty"`, колонка id `uuid(2)`
`physicalName: "inn"`) і ТЧ-таблиця `CounterpartyContact` (id `uuid(3)`,
колонка `uuid(4)`).

```ts
it("allows canonical physical names of a promoted object and its sections", () => {
  // поточний: Catalog uuid(1) physicalName "counterparty", kindLabel "counterparty",
  // реквізит uuid(2) physicalName "tax_id", ТЧ uuid(3) з реквізитом uuid(4) physicalName "phone"
  expect(assignedOnceDiagnostics(baseline, promoted)).toEqual([])
})
it("still refuses a physical name change without a kind change", () => { /* CustomTable → CustomTable: identity.assigned-once-changed */ })
it("still refuses a changed kind label on a promoted object", () => { /* Catalog з kindLabel "cp" */ })
it("still refuses a removed kind label when the new kind has labels", () => { /* Catalog без kindLabel → after "(removed)" */ })
it("lets the label vanish when the new kind has none", () => { /* InformationRegister uuid(1) без kindLabel → [] */ })
it("refuses the vanished label of a polymorphic target", () => { /* + Document з allowedTypes на цей регістр → kindLabel "(removed)" */ })
it("still refuses a schema change on a promoted object", () => {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test assigned-once`
Expected: FAIL на перших і п'ятому тестах.

- [ ] **Step 3: Implement**

`stateOf` запам'ятовує вид об'єкта-носія й файл. Промотовані id — об'єкти,
які в базовому стані мали вид `CustomTable`, а в поточному мають інший вид, що
матеріалізується. Звільнені файли:
- файли базового стану промотованих об'єктів;
- файли `CustomTable` базового стану, чий id у поточному стані — елемент
  (ТЧ) промотованого об'єкта.

Коментар біля правила мітки — дослівно з рішення 3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test assigned-once`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler/assigned-once.ts packages/simetra/src/compiler/__tests__/assigned-once.test.ts
git commit -m "feat(compiler): «призначене раз» розпізнає промоцію з ідентичності — канонічні фізичні імена, мітка лише без поліморфних посилань"
```

---

### Task 5: Переписувач SQL-оператора

**Files:**
- Create: `packages/simetra/src/compiler/sql/rewrite/renames.ts`
- Create: `packages/simetra/src/compiler/sql/rewrite/statement.ts`
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts` (коди `rewrite.*`)
- Test: `packages/simetra/src/compiler/__tests__/rewrite-statement.test.ts`

**Interfaces:**
- Consumes: `SqlParser` (`sql/parse.ts`), `byteOffsets` (задача 2), `quoteIdent` (`simetra/model`).
- Produces:
  - `interface TableRename { schema: string; from: string; to: string; columns: ReadonlyMap<string, string>; columnsAfter: ReadonlySet<string> }` — фізичні імена; `columns` — лише перейменовані (`старе → нове`); `columnsAfter` — повна множина фізичних імен колонок таблиці після промоції (рішення 14); для непромотованої таблиці — її колонки без змін.
  - `interface RenameMap { tables: readonly TableRename[]; knownTables: ReadonlyMap<string, readonly string[]> }` — `knownTables`: `"<схема>.<таблиця>"` → колонки кожної таблиці моделі до промоції (для резолву некваліфікованих колонок).
  - `interface TextEdit { start: number; end: number; text: string }` — індекси UTF-16; `applyEdits(text: string, edits: readonly TextEdit[]): string` — від кінця, перетин країв — `Error`.
  - `interface RewriteScope { searchPath?: readonly string[]; variables: ReadonlySet<string>; records: ReadonlyMap<string, RecordBinding>; labels: readonly string[]; topLevelOutput?: "keep" | "ignore"; intoRowtypeOf?: TableRename }` — `topLevelOutput: "ignore"` вимикає ` AS <старе>` лише у верхньому списку виводу (синтетична обгортка виразу, `PERFORM`; рішення 13); типово `"keep"`. `intoRowtypeOf` — ціль `INTO` оператора — запис `%ROWTYPE` цієї таблиці: `*` тієї самої таблиці у верхньому списку не є зміною контракту. `type RecordBinding = { table: TableRename } | { trigger: TableRename[] }` — `variables` у нижньому регістрі; `NEW`/`OLD` — `records` з `trigger`.
  - `interface RewriteProblem { code: "rewrite.ambiguous-name" | "rewrite.unqualified-table" | "rewrite.unsupported" | "rewrite.trigger-binding" | "rewrite.label-literal"; offset: number; detail: string }`, `interface ContractChange { offset: number; reason: "wholeRow" | "star" | "signature" }`
  - `rewriteStatementText(text: string, parse: SqlParser, map: RenameMap, scope: RewriteScope): { edits: TextEdit[]; problems: RewriteProblem[]; contractChanges: ContractChange[] }` — `text` може містити кілька операторів (тіло `LANGUAGE sql`); `offset`/`start` — відносно `text`.
  - Нові коди в `COMPILER_RULES`: `rewrite.ambiguous-name`, `rewrite.unqualified-table`, `rewrite.unsupported`, `rewrite.trigger-binding`, `rewrite.label-literal`, `rewrite.dynamic-sql`, `rewrite.unresolved-type`, `rewrite.body-quoting`, `rewrite.verification-failed` і попередження `rewrite.contract-change`, `rewrite.dynamic-sql-unscoped` (у `WARNING_RULES`). Параметри: `function`, `line`, `column`, `detail`.

- [ ] **Step 1: Failing tests**

Мапа: `app.counterparties → app.counterparty`, колонки `name → description`,
`inn → tax_id`; `knownTables` додає `app.invoice (id, counterparty_id, name)`.

```ts
const rw = (sql: string, scope: Partial<RewriteScope> = {}) => {
  const r = rewriteStatementText(sql, parse, MAP, { variables: new Set(), records: new Map(), labels: [], ...scope })
  return { sql: applyEdits(sql, r.edits), problems: r.problems.map((p) => p.code), changes: r.contractChanges.map((c) => c.reason) }
}
it("renames qualified table and columns, keeping output names", () => {
  expect(rw("SELECT c.name, c.inn FROM app.counterparties c WHERE c.inn <> ''").sql)
    .toBe("SELECT c.description AS name, c.tax_id AS inn FROM app.counterparty c WHERE c.tax_id <> ''")
})
it("keeps an explicit alias", () => {
  expect(rw("SELECT name AS title FROM app.counterparties").sql).toBe("SELECT description AS title FROM app.counterparty")
})
it("resolves through nested and correlated scopes", () => {
  expect(rw("SELECT i.id FROM app.invoice i WHERE EXISTS (SELECT 1 FROM app.counterparties c WHERE c.id = i.counterparty_id AND c.inn = i.name)").sql)
    .toBe("SELECT i.id FROM app.invoice i WHERE EXISTS (SELECT 1 FROM app.counterparty c WHERE c.id = i.counterparty_id AND c.tax_id = i.name)")
})
it("renames UPDATE SET and INSERT column lists", () => {
  expect(rw("UPDATE app.counterparties SET inn = upper(inn) WHERE name = 'x'").sql).toBe("UPDATE app.counterparty SET tax_id = upper(tax_id) WHERE description = 'x'")
  expect(rw("INSERT INTO app.counterparties (name, inn) VALUES ('a', 'b')").sql).toBe("INSERT INTO app.counterparty (description, tax_id) VALUES ('a', 'b')")
})
it("keeps output names in RETURNING", () => {
  expect(rw("UPDATE app.counterparties SET inn = '1' RETURNING id, inn").sql).toBe("UPDATE app.counterparty SET tax_id = '1' RETURNING id, tax_id AS inn")
})
it("does not report a star read into a ROWTYPE record of the same table", () => {
  expect(rw("SELECT * FROM app.counterparties", { intoRowtypeOf: COUNTERPARTIES }).changes).toEqual([])
})
it("leaves comments and literals untouched", () => {
  const sql = "SELECT /* inn */ inn FROM app.counterparties -- name\n WHERE name = 'inn'"
  expect(rw(sql).sql).toBe("SELECT /* inn */ tax_id AS inn FROM app.counterparty -- name\n WHERE description = 'inn'")
})
it("maps byte offsets after Cyrillic", () => {
  expect(rw("SELECT 'Привіт' AS g, inn FROM app.counterparties").sql).toBe("SELECT 'Привіт' AS g, tax_id AS inn FROM app.counterparty")
})
it("quotes a renamed quoted identifier", () => {
  expect(rw('SELECT c."inn" FROM app.counterparties c').sql).toBe("SELECT c.tax_id AS inn FROM app.counterparty c")
})
it("refuses an unqualified column present in two FROM tables", () => {
  expect(rw("SELECT name FROM app.counterparties, app.invoice").problems).toEqual(["rewrite.ambiguous-name"])
})
it("refuses a column named like a variable", () => {
  expect(rw("SELECT inn FROM app.counterparties", { variables: new Set(["inn"]) }).problems).toEqual(["rewrite.ambiguous-name"])
})
it("refuses an unqualified table without search_path", () => {
  expect(rw("SELECT 1 FROM counterparties").problems).toEqual(["rewrite.unqualified-table"])
  expect(rw("SELECT inn FROM counterparties", { searchPath: ["app"] }).sql).toBe("SELECT tax_id AS inn FROM counterparty")
})
it("refuses a renamed column in USING", () => {
  expect(rw("SELECT 1 FROM app.counterparties JOIN app.invoice USING (name)").problems).toEqual(["rewrite.unsupported"])
})
it("does not alias the synthetic top-level list of an expression", () => {
  expect(rw("SELECT NEW.inn", { topLevelOutput: "ignore", records: new Map([["new", { trigger: [COUNTERPARTIES] }]]) }).sql).toBe("SELECT NEW.tax_id")
  expect(rw("SELECT EXISTS (SELECT c.inn FROM app.counterparties c)", { topLevelOutput: "ignore" }).sql)
    .toBe("SELECT EXISTS (SELECT c.tax_id AS inn FROM app.counterparty c)")
})
it("rewrites NEW fields only for a uniform trigger binding", () => {
  expect(rw("SELECT NEW.inn", { records: new Map([["new", { trigger: [COUNTERPARTIES] }]]) }).sql).toBe("SELECT NEW.tax_id AS inn")
  expect(rw("SELECT NEW.inn", { records: new Map([["new", { trigger: [] }]]) }).problems).toEqual(["rewrite.trigger-binding"])
})
it("reports whole rows and stars as contract changes", () => {
  expect(rw("SELECT row_to_json(NEW)", { records: new Map([["new", { trigger: [COUNTERPARTIES] }]]) }).changes).toEqual(["wholeRow"])
  expect(rw("SELECT * FROM app.counterparties").changes).toEqual(["star"])
})
it("flags consumer label literals", () => {
  expect(rw("SELECT 1 WHERE 'cp' = 'cp'", { labels: ["cp"] }).problems).toEqual(["rewrite.label-literal", "rewrite.label-literal"])
})
```

Захоплення імен (рішення 14), кожне — `rewrite.ambiguous-name` з
`detail: "capture"` через `EXISTS` з корельованим підзапитом: додана колонка
виду; ціль перейменування, якої до промоції не було; знята колонка; змінна
PL/pgSQL проти доданої колонки. Посилання на зняту колонку — відмова.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test rewrite-statement`
Expected: FAIL.

- [ ] **Step 3: Implement**

Обхід дерева з позиціями (не `withoutLocations`):
- стек областей — `FROM` кожного рівня, CTE затіняють таблиці;
- `RangeVar` — заміна `relname` за `location`;
- `ColumnRef` — заміна останнього поля;
- `ResTarget.name` в `INSERT`/`UPDATE`;
- голий `ColumnRef` у `ResTarget` списку `SELECT` без `name` — вставка ` AS <старе>` після токена.

Межа токена від `location`:
- лапкований ідентифікатор — до закривальних лапок з урахуванням `""`;
- інакше — символи ідентифікатора;
- текст заміни — `quoteIdent(нове)`.

Посилання на перейменоване ім'я у вузлі без `location` — `rewrite.unsupported`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test rewrite-statement` і `pnpm --filter simetra test messages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler/sql/rewrite packages/simetra/src/compiler/diagnostics.ts packages/simetra/src/compiler/messages.ts packages/simetra/src/compiler/__tests__/rewrite-statement.test.ts
git commit -m "feat(compiler): переписувач SQL-оператора за позиціями парсера — області FROM, AS <старе>, гучні відмови"
```

---

### Task 6: Переписувач тіла функції

**Files:**
- Create: `packages/simetra/src/compiler/sql/rewrite/function.ts`
- Create: `packages/simetra/src/compiler/sql/rewrite/plpgsql-body.ts`
- Test: `packages/simetra/src/compiler/__tests__/rewrite-function.test.ts`

**Interfaces:**
- Consumes: `rewriteStatementText`, `RenameMap`, `RewriteScope`, `applyEdits` (задача 5); `PlpgsqlParser` (задача 2); `SqlParser`.
- Produces:
  - `interface FunctionRewriteContext { parse: SqlParser; plpgsql: PlpgsqlParser; map: RenameMap; triggerTables: readonly TableRename[] | undefined; labels: readonly string[] }` — `triggerTables`: таблиці, до яких функцію прив'язують тригери й підписки до промоції; `undefined` — не прив'язана.
  - `rewriteFunction(unitSql: string, o: FunctionRewriteContext): { sql: string; problems: { code: RuleCode; line: number; column: number; detail: string }[]; contractChanges: { line: number; reason: ContractChange["reason"] }[] }` — `line`/`column` 1-базні відносно `unitSql`; без проблем `sql` — переписаний текст, інакше вихідний.

- [ ] **Step 1: Failing tests**

Мапа задачі 5. Тригерна функція:

```ts
const TRIGGER = `CREATE FUNCTION app.counterparty_touch() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v app.counterparties.inn%TYPE; -- inn тут лишається
  r app.counterparties%ROWTYPE;
BEGIN
  -- Привіт, inn
  NEW.inn := upper(NEW.inn);
  SELECT * INTO r FROM app.counterparties WHERE id = NEW.id;
  IF r.name IS NULL THEN RAISE EXCEPTION 'name % missing', NEW.name; END IF;
  PERFORM 1 FROM app.counterparties c WHERE c.inn = v;
  RETURN NEW;
END $fn$;`
it("rewrites a trigger function bound to the promoted table", () => {
  const r = rewriteFunction(TRIGGER, { ...ctx, triggerTables: [COUNTERPARTIES] })
  expect(r.problems).toEqual([])
  expect(r.sql).toBe(TRIGGER
    .replace("app.counterparties.inn%TYPE", "app.counterparty.tax_id%TYPE")
    .replace("app.counterparties%ROWTYPE", "app.counterparty%ROWTYPE")
    .replace("NEW.inn := upper(NEW.inn)", "NEW.tax_id := upper(NEW.tax_id)")
    .replace("FROM app.counterparties WHERE id", "FROM app.counterparty WHERE id")
    .replace("r.name IS NULL", "r.description IS NULL")
    .replace("NEW.name; END IF", "NEW.description; END IF")
    .replace("FROM app.counterparties c WHERE c.inn", "FROM app.counterparty c WHERE c.tax_id"))
})
it("refuses NEW fields when bound to a non-promoted table too", () => {
  expect(rewriteFunction(TRIGGER, { ...ctx, triggerTables: [COUNTERPARTIES, INVOICE_UNCHANGED] }).problems.map((p) => p.code))
    .toContain("rewrite.trigger-binding")
})
it("keeps the record shape of SELECT INTO with AS <old>", () => { /* SELECT c.name INTO v FROM … → c.description AS name */ })
it("does not report SELECT * INTO a ROWTYPE record of the same table", () => { /* contractChanges порожній для TRIGGER */ })
it("places an ELSIF condition after the THEN body in text order", () => { /* IF … THEN x := NEW.inn; ELSIF NEW.name = '' THEN … — обидві правки на своїх місцях */ })
it("reports absolute lines when the body starts mid-file", () => { /* $fn$ на 3-му рядку одиниці: rewrite.dynamic-sql має line = 3 + lineno − 1 */ })
it("rewrites a LANGUAGE sql string body and a BEGIN ATOMIC body", () => {})
it("refuses a single-quoted body", () => { /* rewrite.body-quoting */ })
it("refuses dynamic SQL in scope", () => { /* EXECUTE … → rewrite.dynamic-sql з рядком */ })
it("refuses an unresolved %TYPE", () => { /* app.counterparties.missing%TYPE → rewrite.unresolved-type */ })
it("rewrites next to a 2000-char literal", () => {})
it("reports a RETURNS SETOF promoted table as a contract change", () => {})
it("returns the text unchanged when nothing references the map", () => {})
it("reports a star in RETURN QUERY", () => { /* RETURN QUERY SELECT * FROM app.counterparties → contract-change star (рішення 14) */ })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test rewrite-function`
Expected: FAIL.

- [ ] **Step 3: Implement**

**Тіло:**
- опція `as` дерева `parse(unitSql)`;
- зріз тексту від `location` опції `AS` до пари доларових лапок `$тег$…$тег$`;
- рівність зрізу й `sval` — інакше `rewrite.body-quoting`.

**`LANGUAGE sql`:**
- рядкове тіло — `rewriteStatementText` над тілом із `variables` = імена параметрів;
- `BEGIN ATOMIC` — над самим `unitSql`.

**`plpgsql` (`plpgsql-body.ts`):**
- вирази в порядку тексту (стабільне сортування за `lineno`; рядок 1 — рядок відкривального `$тег$`) розміщуються в тілі:
  - пошук після попереднього збігу й не раніше початку рядка `lineno`;
  - `perform` шукається як `PERFORM` + решта після `SELECT`;
  - для `into` пробіл зразка збігається з будь-яким символом;
- розбір виразу:
  - `parseMode` 0 — оператор як є;
  - 2 — `SELECT ` + вираз;
  - 3/4 — ціль до `:=`/`=` (ім'я; `NEW.x`/`OLD.x`/`rec.x` переписується за `records`) і `SELECT ` + права частина;
  - зсув позицій — на довжину префікса;
  - `topLevelOutput: "ignore"` для режимів 2–4 і `PERFORM`;
- `%TYPE`/`%ROWTYPE`: текст типу шукається в рядку `lineno` змінної й переписується як таблиця/колонка;
- `records`:
  - `new`/`old` — `{ trigger: triggerTables ?? [] }`;
  - `%ROWTYPE` промотованої таблиці — `{ table }`; `SELECT … INTO` у такий запис передає `intoRowtypeOf`;
  - запис, заповнений `SELECT * INTO`/`FOR … IN SELECT * FROM` рівно однієї промотованої таблиці, — `{ table }`;
- `variables` — усі змінні й параметри.

**Перевірка:**
- повторний `plpgsql(sql)`;
- послідовність `query` має дорівнювати очікуваній (вихідні тексти з тими самими правками);
- інакше — `rewrite.verification-failed`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test rewrite-function`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler/sql/rewrite packages/simetra/src/compiler/__tests__/rewrite-function.test.ts
git commit -m "feat(compiler): переписувач тіл функцій — sql і plpgsql, розміщення виразів із перевіркою повторним розбором"
```

---

### Task 7: `promote` — вхід, запис і довідник з однієї таблиці

**Files:**
- Modify: `packages/simetra/src/compiler/operations/inputs.ts` (`promoteInput`)
- Create: `packages/simetra/src/compiler/operations/promote/record.ts`
- Create: `packages/simetra/src/compiler/operations/promote/kind-file.ts`
- Create: `packages/simetra/src/compiler/operations/promote/index.ts`
- Modify: `packages/simetra/src/compiler/operations/text-edits.ts` (`renameJsonPlaces(root, places, newName, newKind?)`)
- Modify: `packages/simetra/src/compiler/operations/fix.ts` (експорт `narrowDebt`)
- Modify: `packages/simetra/src/compiler/operations/index.ts`, `packages/simetra/src/compiler/index.ts`
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts` (коди `promote.*`)
- Create: `packages/simetra/src/compiler/__tests__/fixtures/promotion.ts`
- Test: `packages/simetra/src/compiler/__tests__/operations-promote.test.ts`, `operations-inputs.test.ts`

**Interfaces:**
- Consumes: `compileInput`, `refused`, `refuseSuppliedId` (`refuse.ts`); `completeAndCompile`, `CompletionOptions`, `narrowDebt` (`fix.ts`); `placeOf`, `renameJsonPlaces` (`text-edits.ts`); `objectFiles` (`target.ts`); `KIND_REGISTRY`, `standardLogicalName`, `formatMetaFile` (`simetra/model`).
- Produces (вхід, англійські `.meta({ description })` на кожному полі):

```ts
export const conversionClass = z.enum(["platform", "property", "rowRule", "metadata", "applicationCode", "removed"])
const columnMapping = z.discriminatedUnion("to", [
  z.strictObject({ to: z.literal("standard"), name: z.string().min(1) }),
  z.strictObject({ to: z.literal("scope") }),
  z.strictObject({
    to: z.literal("attribute"),
    collection: z.enum(["attributes", "dimensions", "resources"]).default("attributes"),
    element: z.record(z.string(), z.unknown()), // name обов'язкове; без id і physicalName
  }),
  z.strictObject({ to: z.literal("retire") }),
])
const columnMappings = z.record(elementNameSchema, columnMapping) // ключ — логічне ім'я колонки CustomTable
const fillStep = z.strictObject({
  table: objectNameSchema.optional(), // CustomTable ТЧ; без — головна
  target: z.discriminatedUnion("to", [
    z.strictObject({ to: z.literal("standard"), name: z.string().min(1) }),
    z.strictObject({ to: z.literal("attribute"), name: elementNameSchema }),
  ]),
  expression: z.string().min(1),
})
export const promoteInput = z.strictObject({
  target: z.strictObject({ name: objectNameSchema }), // CustomTable
  into: z.strictObject({
    kind: z.enum(["Catalog", "Document", "InformationRegister"]),
    name: objectNameSchema,
    data: z.record(z.string(), z.unknown()).optional(), // налаштування й властивості виду
  }),
  columns: columnMappings,
  tabularSections: z.array(z.strictObject({
    table: objectNameSchema, name: elementNameSchema,
    data: z.record(z.string(), z.unknown()).optional(), columns: columnMappings,
  })).default([]),
  fill: z.array(fillStep).default([]),
  conversions: z.record(z.string().min(1), conversionClass).default({}), // ключ — ідентичність одиниці або "<CustomTable>#<collection>/<name|index>", "<CustomTable>#default/<column>", "<CustomTable>#comment/<column>" чи "<CustomTable>#comment" (рішення 15)
  sharedFunctions: z.array(z.string().min(1)).default([]), // ідентичності функцій → sql/<схема>/
  consumerLabels: z.array(z.string().min(1)).default([]),
})
export type PromoteInput = z.infer<typeof promoteInput>
```

- Produces (запис, `record.ts`):

```ts
export interface PromotionRecord {
  objectId: string
  kind: "Catalog" | "Document" | "InformationRegister"
  kindLabel?: string
  labelDropped: boolean
  // Лише коли consumerLabels не порожній: кроки перекладу виводить П3 (рішення 4).
  labelTranslation?: { from: string[]; to: string; columns: { schema: string; table: string; column: string }[] }
  tables: { id: string; schema: string; from: string; to: string }[]
  columns: { id: string; schema: string; table: string; from: string; to: string }[] // table — нове ім'я
  typeChanges: { schema: string; table: string; column: string; from: string; to: string }[]
  // Вираз і table — у старих іменах, крок виконується до перейменувань (рішення 12); column — нове фізичне ім'я цілі.
  dataSteps: { names: "beforeRenames"; schema: string; table: string; key: string; column: string; expression: string; kind: "repair" | "conversion" | "split" | "backfill" }[]
  retired: { schema: string; table: string; column: string }[] // старі імена
  relaxed: { schema: string; table: string; column: string; constraint: "notNull" }[]
  tightened: { schema: string; table: string; column: string; constraint: "notNull" }[] // рішення 15
  // Старі імена; рішення 15. Зміну доступу дозволяє П3 (гейт еквівалентності).
  rowLevelSecurity: { schema: string; table: string; from: "off" | "forced"; to: "enabled" }[]
  // Будь-який бік (§9.5, Пр8); для "incoming" дія не змінюється (to === from), але потребує дозволу.
  deleteSemantics: { direction: "own" | "incoming"; schema: string; table: string; constraint?: string; columns: string[]; target: string; from: string; to: string }[]
  conversions: { subject: string; class: z.infer<typeof conversionClass> }[]
  movedUnits: { identity: string; from: string; to: string }[]
  rewrittenUnits: { identity: string; file: string }[]
  contractChanges: { identity: string; file: string; line: number; reason: string; via?: string[] }[] // via — ланцюжок викликачів
}
export interface PromoteResult extends OperationResult { record?: PromotionRecord } // record — лише коли ok
```

- Produces (операція): `promoteObject(files: ReadonlyMap<string, string>, input: PromoteInput, o: CompletionOptions): Promise<PromoteResult>`.
- Нові коди `promote.*` в `COMPILER_RULES` (усі — помилки): `promote.column-unplaced`, `promote.mapping-unknown`, `promote.unit-unsupported`, `promote.reference-not-promoted`, `promote.retired-referenced`, `promote.unclassified`, `promote.write-path`, `promote.provider-user-reference`, `promote.label-target`, `promote.enum-labels`, `promote.type-unsupported`, `promote.default-unplaced`, `promote.fill-missing`, `promote.expression-invalid`, `promote.debt-text-reference`.

Фікстура `fixtures/promotion.ts` —
`promotionProject(o: { module?: boolean; contacts?: boolean; invoice?: boolean } = {}): Map<string, string>`
(через `metaFiles`; усі частини типово ввімкнено) і
`counterpartyMapping(o = {}): PromoteInput` з тими самими перемикачами — без
модуля вхід не класифікує його одиниць, бо ключ `conversions`, що нічого не
називає, — `promote.mapping-unknown`. Задача 7 вживає
`{ module: false, contacts: false }`, задачі 8–9 — повну фікстуру:
- `CustomTable` `Counterparty`: `app.counterparties` з колонками `id` (uuid PK), `name` (`Text`, notNull), `inn` (`Text`), `isDeleted` (`Boolean`, notNull, default `false`), `createdAt` (`DateTime`, default `now()`); `UNIQUE (inn)` з ім'ям `counterparties_inn_key`;
- її модуль: тригерна функція `app.counterparty_touch()` у закритій оболонці, тригер `counterparty_touch` на ній, політика `counterparties_read FOR SELECT TO authenticated`, `GRANT SELECT … TO authenticated`;
- спільна `sql/app/counterparty_names.sql` (`LANGUAGE sql STABLE`, читає `name`, `inn`);
- `CustomTable` `CounterpartyContact` (`app.counterparty_contacts`: `id`, `counterpartyId` FK → `Counterparty.id` `CASCADE`, `phone`);
- `CustomTable` `Invoice` (`app.invoices`: `id`, `number Text`, `docDate Date`, `status Text` + `CHECK (status IN ('draft','posted'))` з ім'ям, `amount Numeric`, `counterpartyId` FK → `Counterparty`).

Мапінг-зразок `counterpartyMapping(): PromoteInput` — Catalog
`Counterparty`, `data: { codeLength: 0, descriptionLength: 150 }`:
- колонки: `id → standard ref`, `name → standard description`, `inn → attribute taxId`, `isDeleted → standard deletionMark`, `createdAt → standard createdAt`;
- conversions: `"Counterparty#uniques/counterparties_inn_key": "property"`, тригер і політика → `"platform"`, грант → `"platform"`.

- [ ] **Step 1: Failing tests**

```ts
it("promotes a catalog: ids carried, names canonical, CustomTable gone", async () => {
  const files = promotionProject({ module: false, contacts: false })
  const result = await promoteObject(files, counterpartyMapping({ module: false, contacts: false }), COMPLETION)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const after = applyChanges(files, result.changes)
  expect(after.has("custom-tables/Counterparty/Counterparty.meta.json")).toBe(false)
  const cat = json(after, "catalogs/Counterparty/Counterparty.meta.json")
  expect([cat.id, cat.physicalName, cat.kindLabel]).toEqual([COUNTERPARTY_ID, "counterparty", "counterparty"])
  expect(cat.attributes).toEqual([expect.objectContaining({ id: INN_ID, name: "taxId", physicalName: "tax_id", type: "Text" })])
  expect(result.record?.columns).toEqual(expect.arrayContaining([
    { id: INN_ID, schema: "app", table: "counterparty", from: "inn", to: "tax_id" },
    { id: `${COUNTERPARTY_ID}#description`, schema: "app", table: "counterparty", from: "name", to: "description" },
  ]))
  expect(result.record?.tables).toEqual([{ id: COUNTERPARTY_ID, schema: "app", from: "counterparties", to: "counterparty" }])
})
it("rewrites references from other files to the new kind and names", async () => { /* FK Invoice.counterpartyId → {kind:"Catalog", name}, цільова колонка "ref" */ })
it("refuses an unplaced column", async () => { /* без "inn" → promote.column-unplaced на /columns/<i> */ })
it("refuses a mapping to an unknown column, a standard attribute the kind lacks, a target mapped twice or a conversion key naming nothing", async () => { /* promote.mapping-unknown */ })
it("records a type change of a column mapped to a standard attribute", async () => { /* name Text → description String(150): record.typeChanges */ })
it("refuses an unclassified unique", async () => { /* promote.unclassified з subject */ })
it("refuses a column default without an element defaultValue or a conversion", async () => { /* promote.default-unplaced */ })
it("records a relaxed NOT NULL and a retired column", async () => {})
it("refuses a PgEnum column whose labels the Enumeration lacks", async () => { /* promote.enum-labels */ })
it("refuses an id anywhere in the input", async () => { /* operation.input-invalid */ })
it("refuses a nullable source of a notNull target without fill", async () => { /* createdAt nullable → стандартний notNull: promote.fill-missing, params.reason "nullable-source" (рішення 15) */ })
it("records RLS mode changes off and forced, not enabled", async () => { /* record.rowLevelSecurity: off → enabled, forced → enabled; таблиця enabled відсутня */ })
it("classifies a standard-attribute column comment only as removed", async () => { /* "#comment/name": "removed" → ok; "metadata" → promote.unclassified; без ключа → promote.unclassified */ })
it("moves the CustomTable module byte for byte", async () => { /* .module.ts у теці виду, старого файлу немає */ })
it("compiles the result with the baseline: no assigned-once diagnostics", async () => {
  expect((await compile(after, { baseline: files })).diagnostics.filter((d) => d.code === "identity.assigned-once-changed")).toEqual([])
})
```

`operations-inputs.test.ts`: `promoteInput` відхиляє чуже поле; `columns` — запис
логічних імен; `to: "attribute"` типово має `collection: "attributes"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test operations-promote`
Expected: FAIL.

- [ ] **Step 3: Implement**

Порядок `promoteObject`:
1. `refuseSuppliedId` → `compileInput`.
2. Ціль — `CustomTable` з таким ім'ям, інакше `operation.target-not-found`.
3. Перевірки повноти й гейти (задача 9 додає SQL-гейти).
4. Файл виду (`kind-file.ts`):
   - шапка: id, `schema`, `scope`, `title`, `description` (коментар таблиці → `description`, якщо `into.data` не задає), `kindLabel` (якщо вид має мітку);
   - `into.data`;
   - реквізити з колонок у порядку колонок: тип із колонки (FK → `Ref` на вид цілі), або з `element`, якщо він задає тип (тоді `typeChanges`); `required` = `notNull`, якщо `element` не каже інакше; коментар колонки → `description`;
   - колонка, змаплена на стандартний реквізит із іншим фізичним типом (`Text` → `String(n)` найменування), теж дає `typeChanges`; колонка `Raw`, `generated`, `identity` чи з нетиповою колляцією поза `retire` — `promote.type-unsupported`;
   - без `physicalName`.
5. Видалення файлів `CustomTable` (`objectFiles`).
6. Каскад посилань індексу (`model.references`):
   - на об'єкт — `renameJsonPlaces(…, into.name, into.kind)`;
   - на колонку — нове логічне ім'я (стандартна — `standardLogicalName`);
   - на виведену з ужитку чи `scope` — `promote.retired-referenced`.
7. `narrowDebt`.
8. `completeAndCompile(files, after, o, only = нові файли й файли з каскадом)`.
9. Запис — з `after` (нові фізичні імена) і id. Синтетичний id стандартного
   реквізиту — `standardElementId(ownerId, def)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test operations-promote`, `pnpm --filter simetra test operations-inputs`, `pnpm --filter simetra test messages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): мутація promote — мапінг колонок, перенесення id, канонічні імена, каскад посилань, запис промоції"
```

---

### Task 8: `promote` — табличні частини, документ, регістр відомостей, кроки даних

**Files:**
- Create: `packages/simetra/src/compiler/operations/promote/fill.ts`
- Modify: `packages/simetra/src/compiler/operations/promote/index.ts`, `kind-file.ts`
- Test: `packages/simetra/src/compiler/__tests__/operations-promote.test.ts`

**Interfaces:**
- Consumes: задача 7.
- Produces: `fillStepKind(step, mapped: ReadonlySet<string>, retired: ReadonlySet<string>, parse: SqlParser, table: { schema: string; name: string; key?: string; columns: readonly string[] }, volatileFunctions: ReadonlySet<string>): { kind: PromotionRecord["dataSteps"][number]["kind"]; columns: string[] } | { reason: "noKey" | "subquery" | "aggregate" | "foreignTable" | "multipleTargets" | "multipleStatements" | "setReturning" | "volatile" | "nondeterministicWindow" | "unknownColumn" }` — розбирає `SELECT <expression> FROM <схема>.<таблиця>` (старі імена), перевіряє форму за рішенням 12 і повертає прочитані колонки. `key` — одноколонковий первинний ключ таблиці; `volatileFunctions` — функції моделі з явною `VOLATILE`.

- [ ] **Step 1: Failing tests**

```ts
it("promotes a catalog with a tabular section from its CustomTable", async () => {
  // tabularSections: [{ table: "CounterpartyContact", name: "contacts", columns: { id: ref, counterpartyId: {to:"standard",name:"parent"}, phone: attribute } }],
  // fill: [{ table: "CounterpartyContact", target: {to:"standard",name:"lineNumber"}, expression: "row_number() over (partition by counterparty_id order by id)" }]
  // → ТЧ з id = id CustomTable ТЧ, physicalName "counterparty_contacts"; record.dataSteps[0].kind = "backfill"; deleteSemantics порожній (каскад ТЧ — частина виду)
})
it("promotes a document: status split into posted and an attribute", async () => {
  // columns: status → attribute status; fill: posted ← "status = 'posted'", number/date змаплені
  // → record.dataSteps: [{ column: "posted", kind: "split" }]
})
it("records a conversion when the source column is retired", async () => {})
it("records a repair on a mapped column", async () => { /* target attribute name ← left(name, 150) → "repair" */ })
it.each([
  ["mapped target that reads a retired column", "repair"],
  ["reads a retired and a kept column", "conversion"],
  ["reads only a kept column", "split"],
  ["reads no column", "backfill"],
])("orders step kinds by priority: %s", async (_, kind) => { /* record.dataSteps[0].kind */ })
it("records steps in old names before renames", async () => {
  // record.dataSteps[0]: { names: "beforeRenames", table: "invoices", key: "id", column: "posted", expression: "status = 'posted'" }
})
it("refuses a missing fill for a NOT NULL standard column without default", async () => { /* Document без number → promote.fill-missing */ })
it("records a repair and a tightened column for a nullable source", async () => { /* createdAt nullable + fill coalesce(created_at, updated_at) → dataSteps repair + tightened (рішення 15) */ })
it.each([
  ["(select 1)", "subquery"],
  ["count(*)", "aggregate"],
  ["other.x", "foreignTable"],
  ["1, 2", "multipleTargets"],
  ["1; select 2", "multipleStatements"],
  ["generate_series(1, 2)", "setReturning"],
  ["random()", "volatile"],
  ["row_number() over (partition by counterparty_id)", "nondeterministicWindow"],
  ["missing_column", "unknownColumn"],
])("refuses fill expression %s", async (expression, reason) => { /* promote.expression-invalid з params.reason */ })
it("refuses now() in a repair but allows it in a backfill", async () => {})
it("refuses a fill on a table without a single-column key", async () => { /* регістр зі складеним ключем → reason "noKey" */ })
it("promotes an independent information register and drops the label", async () => {
  // CustomTable з uuid-ключем → InformationRegister: dimensions/resources з columns; record.labelDropped = true
})
it("refuses an information register target that a polymorphic Ref points to", async () => { /* promote.label-target */ })
it("refuses a document with posting, a recorder-subordinate register and an accumulation register", async () => { /* promote.unit-unsupported */ })
it("refuses a reference to a CustomTable outside the unit", async () => { /* promote.reference-not-promoted */ })
it("records a CASCADE foreign key changed to restrict", async () => { /* record.deleteSemantics: direction "own", to "noAction" */ })
it("records a tabular section adopted with NO ACTION gaining the kind's cascade", async () => { /* direction "own", from "noAction", to "cascade" */ })
it("records an incoming CASCADE from a table that stays CustomTable", async () => { /* direction "incoming", to === from */ })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test operations-promote`
Expected: FAIL на нових тестах.

- [ ] **Step 3: Implement**

- ТЧ:
  - id таблиці ТЧ стає id табличної частини, її колонки — реквізитами ТЧ;
  - FK на власника — стандартний `parent` (каскад — дія виду, не `deleteSemantics`).
- Підтримку цілі визначає реєстр:
  - `postsMovements`;
  - `registerKeys(obj).movementsPrimaryKey === "recorder"` → `promote.unit-unsupported`;
  - `writeMode` — поле даних.
- Стандартні колонки й обов'язковість — `KIND_REGISTRY[kind].standardColumns(data)` і `tabularSectionColumns`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test operations-promote`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): promote — табличні частини, документ без рухів, незалежний регістр відомостей, кроки даних"
```

---

### Task 9: `promote` — SQL одиниці: класифікація, переїзд, переписування, гейти

**Files:**
- Create: `packages/simetra/src/compiler/operations/promote/sql.ts`
- Create: `packages/simetra/src/compiler/operations/promote/gates.ts`
- Modify: `packages/simetra/src/compiler/operations/promote/index.ts`
- Modify: `packages/simetra/src/compiler/sql/dependencies.ts` (експорт `unitRelations`)
- Test: `packages/simetra/src/compiler/__tests__/operations-promote-sql.test.ts`, `creation-order.test.ts` (`unitRelations`)

**Interfaces:**
- Consumes: `rewriteFunction` (задача 6), `RenameMap` (задача 5), `unitTargets` (`sql/unit-target.ts`), `PROVIDER_API_ROLES` (`simetra/model`), `CompiledModel.sqlUnits`/`VerbatimUnit`.
- Produces:
  - `writePathProblems(model: CompiledModel, tables: readonly { schema: string; name: string }[], parse: SqlParser): Diagnostic[]` — рішення 6;
  - `planUnits(model, input, tables, parse): { removed: VerbatimUnit[]; moved: { unit: VerbatimUnit; to: string }[]; candidates: VerbatimUnit[]; problems: Diagnostic[] }` — класифікація за рішенням 5; `candidates` — надмножинний відбір функцій за рішенням 13 (обсяг потім визначає резолв переписувача).
  - `unitRelations(unit: SqlUnit, parse: SqlParser): { schema?: string; name: string }[]` — новий експорт `compiler/sql/dependencies.ts` над наявним збиранням посилань простору `rel`. Він потрібен для `promote.debt-text-reference` і для пошуку викликачів (простір `proc`).
  - `dynamicSqlUnscoped` і транзитивні викликачі — попередження й `record.contractChanges[].via`.

- [ ] **Step 1: Failing tests**

```ts
it("moves the closed trigger function into the kind module and rewrites it", async () => {
  // повний мапінг Counterparty (тригер, політика, грант — класифіковані)
  // → catalogs/Counterparty/Counterparty.sql містить лише переписану counterparty_touch;
  //   record.movedUnits, record.conversions мають тригер/політику/грант; sql-debt.json без них
})
it("moves a function named in sharedFunctions to sql/<schema>/", async () => {})
it("rewrites a shared function that reads the promoted table", async () => {
  // sql/app/counterparty_names.sql: name → description AS name, inn → tax_id AS inn; record.rewrittenUnits
})
it("refuses an unclassified policy and a non-closed module function", async () => { /* promote.unclassified з рядком одиниці */ })
it("refuses a view of another table that reads a promoted column", async () => { /* promote.debt-text-reference з файлом і рядком */ })
it("refuses write grants and write policies", async () => {
  // GRANT INSERT ON app.counterparties TO authenticated → promote.write-path; повідомлення містить "write path after promotion"
})
it("refuses a write privilege that comes from the schema's default privileges", async () => {
  // sql/app/default-privileges.sql: ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO authenticated
  // (явного GRANT на таблицю немає, як пише зворотна генерація) → promote.write-path
})
it("ignores default privileges of another schema and read-only ones", async () => {})
it("leaves a candidate untouched when resolution finds no reference", async () => {
  // функція з 'counterparties' лише в коментарі чи в імені іншої схеми → без змін, не в record.rewrittenUnits
})
it("finds debt text references by dependency resolution, not by word", async () => {
  // в'юха з "counterparties" у літералі — без відмови; в'юха, що читає app.counterparties, — promote.debt-text-reference
})
it("warns about out-of-scope debt functions with dynamic SQL", async () => { /* rewrite.dynamic-sql-unscoped зі списком */ })
it("propagates a contract change to callers transitively", async () => {
  // f RETURNS SETOF app.counterparties ← g викликає f ← h викликає g → два попередження з via
})
it("records the label translation and the polymorphic consumer columns", async () => {
  // consumerLabels ["cp"]; Document з allowedTypes на Counterparty → record.labelTranslation.columns містить його _type-колонку
})
it("refuses a provider user reference that is not the user scope carrier", async () => { /* promote.provider-user-reference */ })
it("aggregates rewriter refusals and writes nothing", async () => {
  // EXECUTE у спільній функції, що згадує counterparties → ok:false, changes [], rewrite.dynamic-sql з файлом і рядком
})
it("flags consumer label literals", async () => { /* consumerLabels ["cp"]; 'cp' у функції в обсязі → rewrite.label-literal */ })
it("passes contract changes through as warnings and into the record", async () => {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test operations-promote-sql`
Expected: FAIL.

- [ ] **Step 3: Implement**

Прив'язки тригерів (`triggerTables`) — з одиниць `CREATE TRIGGER` і джерел
`EventSubscription` **до** промоції. `RenameMap.knownTables` — з
`model.physical` до промоції; `TableRename.columnsAfter` — з моделі після
промоції: стандартні колонки `KIND_REGISTRY[kind].standardColumns(data)`,
реквізити й зв'язки ТЧ (рішення 14).

Правки текстів одиниць:
- рядок на початку одиниці у файлі (`unit.line`) + рядок діагностики переписувача;
- зняття одиниці вирізає її текст разом із завершальним `;` і порожнім рядком після.

Діагностики переписувача:
- файл одиниці;
- `params.line` — абсолютний рядок у файлі;
- `params.function` — ідентичність.

Попередження `rewrite.contract-change` йде в `diagnostics` результату й у `record.contractChanges`, не блокуючи.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test operations-promote`, потім `pnpm --filter simetra test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): promote — класифікація й переїзд SQL-одиниць, переписування функцій в обсязі, гейти шляху запису й користувачів провайдера"
```

---

### Task 10: Інструмент `promote` у каталозі designer і скіл

**Files:**
- Modify: `packages/designer/src/tools/types.ts` (`TOOL_NAMES` — `"promote"` після `"delete"`)
- Modify: `packages/designer/src/tools/mutations.ts` (`promoteTool`), `packages/designer/src/tools/catalog.ts`
- Modify: `packages/designer/src/mcp/tools.ts` (`toResponse`: запис промоції як JSON-блок, як `diff`), `packages/designer/src/cli/render.ts` (текстовий підсумок запису; `--format json` несе `data`)
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` (рядок маршрутизації `promote`, приклад ```` ```json simetra:promote ````)
- Test: `packages/designer/src/__tests__/catalog.test.ts`, `catalog-mutations.test.ts`, `cli.test.ts`, `mcp.test.ts`, `skill-examples.test.ts`

**Interfaces:**
- Consumes: `promoteObject`, `promoteInput`, `PromotionRecord` (задача 7).
- Produces: `promoteTool = defineTool<typeof promoteInput, PromotionRecord>({ name: "promote", files: "write", database: "none", destructive: false, … })`; `run` — `apply` з `completion(dir)`, `data: result.record`. Опис (англійською): "Promote an adopted CustomTable (with its tabular-section tables) into a Catalog, a Document without movements or an independent InformationRegister from a complete one-off mapping; ids carry over, names become canonical, dependent function bodies are rewritten. Writes only when the result compiles; returns the promotion record for the database plan."

- [ ] **Step 1: Failing tests**

- `catalog.test.ts` і `mcp.test.ts`: зашиті переліки імен — з `"promote"`.
- `catalog-mutations.test.ts`: цикл осей — з `"promote"` (`files: "write"`, `database: "none"`, не руйнівна); новий тест `promote writes on ok and returns the record`, `promote dry run writes nothing`.
- `cli.test.ts`: `simetra promote - <dir>` зі stdin.
- `skill-examples.test.ts`: приклад `simetra:promote` проходить `mcpInputSchema`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @simetra/designer test catalog`
Expected: FAIL.

- [ ] **Step 3: Implement**

Бюджет `tools/list` (`mcp.test.ts`):
- перевиміряти `TOOLS_LIST_MEASURED`;
- коментар — «перевиміряно в промоції-4: вхід `promote` (мапінг)».

Скіл — лише маршрутизація й один приклад: діалог конверсії — скіл §16 п.4.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @simetra/designer test`, `python3 scripts/check-doc-anchors.py`
Expected: PASS, чисто.

- [ ] **Step 5: Commit**

```bash
git add packages/designer
git commit -m "feat(designer): інструмент promote у каталозі — CLI, MCP, запис промоції у відповіді, маршрут у скілі"
```

---

### Task 11: DB-тест — переписані тіла працюють на перейменованій схемі

**Files:**
- Create: `packages/simetra/test/db/promote-rewrite.db.test.ts`

**Interfaces:**
- Consumes: `promoteObject` (задача 7), фікстура `promotionProject` (задача 7), `withRollback`, `testSuperuserUrl` (`packages/simetra/test/db/connection.ts`).

- [ ] **Step 1: Failing test**

В одній транзакції з відкатом (суперкористувач, бо `CREATE EXTENSION`):
1. Створити прийняту схему фікстури: таблиці, вихідні функції, тригер.
2. `CREATE EXTENSION plpgsql_check`.
3. Виконати перейменування з `record.tables`/`record.columns` (`ALTER TABLE … RENAME`, `RENAME COLUMN`).
4. **Негативний контроль:** `plpgsql_check_function` вихідної тригерної
   функції дає помилки, а `CREATE OR REPLACE` вихідної `LANGUAGE sql` функції
   під `check_function_bodies = on` падає.
5. Створити переписані функції з файлів після `promote`.
6. `plpgsql_check_function(…, relid => 'app.counterparty')` без помилок; виклик SQL-функції повертає ті самі рядки, а назви колонок результату — старі (`name`, `inn`).
7. `INSERT` у `app.counterparty` спрацьовує тригером і пише `tax_id` у верхньому регістрі.

```ts
it("rewritten bodies pass plpgsql_check and keep result shapes", async () => {
  await withRollback(testSuperuserUrl(), async (db) => {
    // кроки 1–7
    expect(await checkErrors(db, "app.counterparty_touch()", "app.counterparty")).toEqual([])
    expect((await db.query("select * from app.counterparty_names()")).fields.map((f) => f.name)).toEqual(["name", "inn"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `pnpm --filter simetra test:db promote-rewrite`
Expected: спершу — FAIL лише через відсутній файл тесту; після написання —
PASS. Падіння на кроці 6 — дефект переписувача: стоп, `systematic-debugging`.

- [ ] **Step 3: Commit**

```bash
git add packages/simetra/test/db/promote-rewrite.db.test.ts
git commit -m "test(compiler): переписані тіла функцій проходять plpgsql_check на перейменованій схемі"
```

---

### Task 12: Фінальні гейти

**Files:** — (лише перевірка; правки — за знахідками)

- [ ] **Step 1: Гейти репо**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
`pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`
Expected: зелено.

- [ ] **Step 2: Звірка зі спекою**

Пройти §4, §5, §6, §7.1, §9.11 спеки промоції й рішення 1–13: для кожного
пункту — задача й тест. Розбіжність — стоп і звіт архітекторові.

- [ ] **Step 3: Звіт архітекторові**

Надіслати сесії `consumer-reconciliation`:
- діапазон комітів;
- відкладене в П3: зберігання запису, порт перейменувань, зворотне читання боргу з тіні, повторне вживання міток видалених об'єктів;
- нові знахідки.
