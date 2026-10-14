# П3-2b-1 — гарантії перед `COMMIT`: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** раннер застосування доводить перед кінцем транзакції те, що
спека промоції §7.2 вимагає «перед `COMMIT`», — для **будь-якого** плану:

1. преамбула двигуна виконується цілком, а тіла функцій перевіряються
   наново після кроків проти базової лінії, знятої в тій самій транзакції
   (валідатори `sql` і `plpgsql`, `plpgsql_check`);
2. відкладені обмеження спрацьовують до кінця транзакції; недійсних обмежень
   та індексів, яких немає в бажаному стані, після кроків немає;
3. репетиція доводить «каталог = бажаний стан» повним доказом двигуна на тому
   самому з'єднанні, а розбіжність відбитка на цілі пояснюється витягом до
   `ROLLBACK`;
4. закрито борг 2a:
   - вхідні FK між `plan` і `apply`;
   - тимчасові імена наміру;
   - сирі помилки замірів;
   - гілка «до 17» права на `LOCK`.

Застосування промоції з `COMMIT` і далі відмовляє
(`apply.promotion-checks-pending`): відмову знімає П3-2b-2.

**Архітектура:**

- **T2 `packages/simetra/src/schema/apply/`** — увесь алгоритм: фази
  раннера, набори налаштувань, SQL перевірок, порівняння з базовою лінією.
  Нові модулі:
  - `settings.ts` — `withLocalSettings`, налаштування ревалідації;
  - `function-checks.ts` — валідатори, `plpgsql_check`, базова лінія, сліпі
    функції;
  - `validity.ts` — недійсні обмеження й індекси;
  - `retry.ts` — повторювані SQLSTATE.
- **Порт `ApplyTransaction`** отримує можливість `extract(scope)`: витяг
  двигуна на тому самому з'єднанні в точці збереження. `SchemaEngine` не
  змінюється.
- **`@simetra/designer`:**
  - обгортка-пул на точці збереження зі сторожем за деревом розбору;
  - `apply --rehearse` будує бажану тінь для повного доказу.

  `pg` і pg-delta в `simetra` не з'являються.

**Технології:**

- TypeScript 7, Zod 4, Vitest;
- `libpg-query` через `loadSqlParser`;
- `@supabase/pg-delta` 1.0.0-alpha.56 без змін версії, `renames: "off"`;
- локальний стек Supabase (Postgres 17.6, `plpgsql_check` 2.8 у
  `pg_available_extensions`).

**Спека:**

- [спека промоції](../specs/2026-10-06-promotion-design.md): §7.2
  («З'єднання й блокування», «Застосування», «Перевірки перед `COMMIT`»), §8
  («Репетиція з даними»);
- [платформна спека](../specs/2026-09-24-simetra-platform-design.md): §6.2
  п.3–4, §6.6, §6.10;
- [спека designer](../specs/2026-10-02-simetra-designer-design.md): §3.2.

Правки спек для цього плану вже внесено задачею 1 плану П3-2b-0
(`docs/superpowers/plans/2026-10-13-p3-2b-0-proof-defects.md`) одним
docs-комітом на всі три плани П3-2b.

**Плани, на яких стоїть цей:**

- [П3-1](2026-10-11-p3-1-apply-core.md): рішення 4, 9, 11, 14, 16;
- [П3-2a](2026-10-12-p3-2a-promotion-intent.md): рішення 5, 6, 9, 13, R22,
  R26, R27;
- П3-2b-0: кроки середовища (`origin: "environment"`), двофазна копія
  доказу.

**Передумова:**

- П3-2b-0 виконано й прийнято;
- локальний стек (`pnpm db:start`);
- на checkout працює одна сесія, що комітить.

**Архітектор задачі:** сесія `consumer-reconciliation2`. До неї через
`SendMessage` ідуть розвилки поза «Рішеннями плану». Якщо сесії немає — до
власника.

**Поза планом (свідомо):**

- **П3-2b-2** (пишеться після прийняття цього плану):
  - кроки даних (`fill`): обчислення в тимчасові таблиці, `ADD COLUMN`
    наміру, запис до кроків двигуна, вимкнення тригерів на час запису;
  - зняття відмови `plan.promotion-unsupported` з `reason: "dataSteps"`;
  - свідома конверсія типів, що нормалізують текст (`text → jsonb`), і
    обрізання `repair` — через крок даних;
  - закріплені налаштування даних (`DATA_SETTINGS`) і заміри збереження під
    ними;
  - збереження за виразом мапінгу;
  - звіт репетиції на копії з даними, `apply.rehearsal-required`,
    `statement_timeout` зі звіту;
  - зняття `apply.promotion-checks-pending`, рядок скіла споживача, тест
    апгрейду ledger у режимі `apply`;
  - наскрізний тест повного циклу. Він мусить покривати форму `fill`, яку
    проба знайшла на реальній схемі: стандартна позначка видалення ←
    булева колонка «неактивний», конверсія до перейменувань.
- **Поза П3-2b** (вердикт архітектора за пробою):
  - `--yes` для `--rehearse` лишається: репетиція бере замки цілі, тож
    підтвердження доречне;
  - права окремої таблиці в схемі зі схемними ADP ролей API (Пр21) — П3-3;
  - UNIQUE стандартного найменування в скоупі, `DEFERRABLE` у метамоделі,
    коментар у базі — беклог метамоделі.
- **П3-3:**
  - політики й тригери підписок;
  - лічильники нумерації;
  - переклад міток;
  - динамічний гейт доступу.
- **П3-4:** фази «розширити → звузити».
- **Окремий план:** зворотне читання боргу з тіні й затінення імен у
  `search_path`.
- **Решта:**
  - підплан регістрів;
  - шлях запису (Пр21);
  - нетранзакційні кроки;
  - крок `ALTER … OWNER TO`;
  - реальна база споживача.

## Global Constraints

- 🔴 **Розбіжність спеки з кодом — стоп.** Поведінка коду чи спеки поза
  рішеннями нижче — стоп і звіт архітекторові.
- 🔴 **Зона рушія:** production-код `packages/simetra` не імпортує `pg` чи
  `@supabase/pg-delta` (`packages/simetra/eslint.tier-zones.js`, тест
  `packages/simetra/test/tier-boundary.test.ts`). Імпорти — лише вниз.
- 🔴 **Жодного стану поза транзакцією на цілі** (рішення 14 П3-1):
  - налаштування — лише `set_config(…, true)` чи `SET LOCAL`;
  - об'єкти перевірок (схема й розширення `plpgsql_check`) живуть лише в
    точці збереження й зникають `ROLLBACK TO`;
  - жоден об'єкт у `pg_temp` не переживає транзакцію;
  - валідатори мов, що вантажать бібліотеку в процес сервера, не
    викликаються (усе, крім `sql` і `plpgsql`).
- 🔴 **`DROP … CASCADE` — ніколи.**
- 🔴 **Ідентичність — UUID, а не ім'я**; посилання на об'єкти двигуна —
  структурні (`EngineObjectRef`), без розбору рядкових StableId.
- 🔴 **Кожен гейт і кожна відмова мають негативний тест**, а підключення
  гейта до конвеєра — тест на рівні конвеєра, не лише чистої функції.
- 🔴 **`renames: "off"` в адаптері не змінюється.**
- Хибна відмова допустима, мовчазна втрата — ні: те, чого перевірка не
  бачить, називає попередження, а не тиша.
- Нове правило діагностики — рядок у `COMPILER_RULES`
  (`packages/simetra/src/compiler/diagnostics.ts`) і тексти en/uk (+ hint, де
  є що порадити) у `packages/simetra/src/compiler/messages.ts`. Рівня `info`
  немає.
- Артефакт плану — детермінований канонічний JSON без часу.
- Без шимів; коментарі — українською, «чому»; 🔴 без `--` перед шаблоном
  vitest; коміти — Conventional Commits українською, без трейлерів.
- Кожна задача закінчується зеленим `pnpm --filter <пакет> typecheck` для
  пакетів, які вона змінила; задача, що міняє T2, запускає й typecheck
  `@simetra/designer`.
- Тестові файли, які ламає нове обов'язкове поле чи тип, входять у Files і
  коміт задачі, що його додає (R9 плану 2a). Літерали плану є, зокрема, у:
  - `packages/simetra/src/schema/apply/__tests__/execute.test.ts`;
  - `packages/simetra/src/schema/apply/__tests__/artifact.test.ts`;
  - `packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts`
    (`planFor`);
  - `packages/designer/src/schema-engine/__tests__/read-only.db.test.ts`;
  - `packages/designer/src/__tests__/apply-outcome.test.ts`.

  Повний перелік дає typecheck.
- DB-тести — `*.db.test.ts` на локальному стеку, лише `pnpm db:*` /
  `pnpm test:db`. Кожна ціль — окрема база (`inTarget` у
  `packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts`).
  Лічильник тіней (`shadowDatabaseCount`) після тесту не змінюється.
- Тексти для споживача (описи інструментів, повідомлення en) — англійською,
  стисло.
- Репо публічне: синтетичні імена й дані; нічого з `simetra-private/`.

## Review Focus

1. **План без промоції створює plpgsql-функцію з синтаксичною помилкою**,
   а `plpgsql_check` недоступне. Під преамбулою `check_function_bodies = off`
   крок проходить. Очікування: `plpgsql_validator` у ревалідації її ловить —
   `apply.function-check-failed`, а не тихо зламана функція. Тест —
   задача 1.
2. **Інша сесія тримає `ACCESS EXCLUSIVE` на таблиці поза слідом, яку
   називає функція.** Валідатор чекає на неї. Очікування: `55P03` — повтор
   спроби, далі `apply.lock-timeout`, а не хибна
   `apply.function-check-failed`. Тест — задача 1.
3. **Функція чужої ролі з помилкою, що була до плану** (на локальному стеку
   функції `realtime`/`storage` уже дають помилки `plpgsql_check`).
   Очікування: базова лінія її поглинає. Нова помилка в тій самій функції
   однаково ловиться (`fatal_errors => false`). Тест — задача 2.
4. **Двигун перестворює функцію (`DROP` + `CREATE`) з тією самою помилкою,
   що була до плану.** Oid змінюється. Очікування: збіг за сигнатурою, не
   регресія. Тест — задача 2.
5. **Репетиція, де крок порушує `DEFERRABLE INITIALLY DEFERRED` FK.**
   `ROLLBACK` не запускає відкладених перевірок. Очікування:
   `apply.deferred-constraint-failed` до відкату. Тест — задача 3.

## Рішення плану

Розвилки вирішив архітектор задачі (сесія `consumer-reconciliation2`)
2026-10-13 за спайками автора на локальному стеку (PG 17.6, роль `postgres`
без суперкористувача). Поділ П3-2b на 2b-0, 2b-1 і 2b-2 погодив він же.

1. **Порядок фаз транзакції** (`runAttempt`,
   `packages/simetra/src/schema/apply/execute.ts`). Курсивом — фази
   П3-2b-2, яких цей план не реалізує, але не має їм заважати.

   | # | Фаза | Режими | Налаштування |
   | --- | --- | --- | --- |
   | 1 | advisory lock; роль (`apply.role-mismatch`) | усі (роль — не `proof`) | транзакції |
   | 2 | тайм-аути `set_config(…, true)` | усі | — |
   | 3 | роль API; ланцюжок | ланцюжок — не `proof` | транзакції |
   | 4 | звірки до замків: `providerLocks` (R27), глобальні ADP (П3-2b-0), **НОВЕ** `foreignKeys` (рішення 9), **НОВЕ** режим `plpgsql_check` (рішення 4) → `apply.target-changed` | не `proof` | транзакції |
   | 5 | `LOCK TABLE` за слідом | усі | транзакції |
   | 6 | відбиток цілі; заміри збереження «до»; таблиці до кроків | усі | транзакції (*у 2b-2 заміри — даних*) |
   | 7 | **НОВЕ** базова лінія тіл: валідатори `sql`/`plpgsql` + `plpgsql_check` | усі | ревалідації |
   | 8 | *кроки даних «обчислити» (тимчасові таблиці, старі імена)* | — | *даних* |
   | 9 | кроки наміру (перейменування, канонічні імена); *`ADD COLUMN` цілі `fill`* | усі | транзакції |
   | 10 | *запис значень (нові імена, тригери вимкнено); `SET CONSTRAINTS ALL IMMEDIATE`* | — | *даних* |
   | 11 | **НОВЕ** преамбула двигуна → кроки двигуна зі сторожами → відновлення | усі | преамбули |
   | 12 | кроки середовища (П3-2b-0) | усі | транзакції |
   | 13 | **НОВЕ** `SET CONSTRAINTS ALL IMMEDIATE` | усі | транзакції |
   | 14 | заміри збереження «після» | усі | транзакції (*у 2b-2 — даних*) |
   | 15 | **НОВЕ** ревалідація тіл проти базової лінії → `apply.function-check-failed`; сліпі функції → `apply.function-check-blind` | усі | ревалідації |
   | 16 | **НОВЕ** валідність → `apply.constraint-invalid` | усі | транзакції |
   | 17 | відбиток = бажаний (`apply.verify-failed`); **НОВЕ** на `apply`/`rehearse` — діагностичний витяг до відкату (рішення 6) | усі | транзакції |
   | 18 | **НОВЕ** повний доказ двигуна в транзакції (рішення 7) | `rehearse` | транзакції |
   | 19 | marker і ledger; звірка сліду замків (R26) | звірка — не `apply` | транзакції |
   | 20 | `COMMIT` чи `ROLLBACK` (порт) | — | — |

   - **`SET CONSTRAINTS ALL IMMEDIATE` (фаза 13).**
     - Стоїть до замірів «після»: відкладений тригер-обмеження користувача
       може змінити рядки.
     - Діє для всіх планів і режимів. Без нього репетиція з `ROLLBACK`
       ніколи не побачила б порушення відкладених обмежень.
     - Оператор діє в межах транзакції.
   - **Порядок кроків за походженням:** `intent`, далі `engine`, далі
     `environment`. Так будують `analyseOnClone` і П3-2b-0. Раннер
     виконує три блоки під своїми налаштуваннями. Інший порядок — зламаний
     конвеєр: `Error` до `BEGIN`.
   - **Преамбулу раннер виконує такою, як її записав план.** Двигун пише
     `check_function_bodies = off` лише тоді, коли план визначає тіла
     функцій, тож лише `search_path = pg_catalog` — законна преамбула.
2. **Три набори налаштувань і один помічник.**
   - `withLocalSettings(tx, settings, run)` у `settings.ts`:
     1. читає `current_setting` кожного імені;
     2. ставить `set_config(name, value, true)`;
     3. виконує `run`;
     4. повертає збережені значення тим самим `set_config(…, true)`.

     Помилка в `run` летить як є: спроба зупиняється, транзакцію відкочено.
   - **Преамбула** — `plan.preamble`, діє лише навколо блоку кроків двигуна
     разом зі сторожами.
   - **Ревалідація** — `revalidationSettings(path)`:
     - `check_function_bodies = on` (при `off` валідатор — no-op, спайк С3);
     - `search_path = plan.revalidationSearchPath`.

     Значення шляху `plan` читає з цілі `current_setting('search_path')` у
     `READ ONLY` і записує під `planHash`, тож репетиція й робота однакові.
     Закріплене `pg_catalog, pg_temp` зробило б некваліфіковані функції
     помилковими і в базовій лінії, і після — сліпа зона.
   - **Даних** — П3-2b-2.
3. **Ревалідація — валідатори мов `sql` і `plpgsql`, для всіх планів**
   (спайк С3, вердикт архітектора).
   - **Що викликається.** `pg_language.lanvalidator` мов `sql`
     (`fmgr_sql_validator`) і `plpgsql` (`plpgsql_validator`), напряму:
     - права: EXECUTE на функції й USAGE на мові; власник не потрібен;
     - каталог не змінюється, замка на функцію немає;
     - `plpgsql_validator` при `on` компілює тіло, тож ловить синтаксис
       plpgsql, який преамбула пропустила (Review Focus 1).
   - **Інші процедурні мови** (`plv8`, `plpython` тощо) не перевіряються:
     їхній валідатор вантажить бібліотеку в процес сервера, а це стан поза
     транзакцією. Вони йдуть у сліпі (рішення 5).
   - **Налаштування функції.** Валідатор **не** застосовує `proconfig` (це
     робить `ProcedureCreate`), тож DO-блок ставить їх сам:
     - кожен ключ — у власному вкладеному блоці;
     - збій `set_config` (налаштування суперкористувача) пропускається;
     - ключ `check_function_bodies` не застосовується.
   - **Обсяг:** функції мов `sql` і `plpgsql` бази, крім `pg_catalog`,
     `information_schema`, тимчасових і toast-схем і членів розширень
     (`pg_depend.deptype = 'e'`).
   - **Транспорт результатів.** Нуль об'єктів, нуль імен, право TEMP не
     потрібне:
     1. DO-блок у точці збереження накопичує помилки в масив;
     2. закінчується `RAISE EXCEPTION USING ERRCODE = 'SIMFE', MESSAGE =
        <jsonb { "total", "errors" }>`;
     3. раннер ловить `ApplyDbError` з `SIMFE`, розбирає JSON, робить
        `ROLLBACK TO`.

     Обмеження розміру:
     - до клієнта ціло доходить 5000 записів (≈757 КБ, виміряно);
     - план бере межу 1000 записів, `total` рахує всі;
     - більше 1000 з будь-якого боку — порівняти не можна, тож
       `apply.function-check-failed` із поясненням, що перелік обрізано.

     Custom GUC через `set_config` відхилено: його placeholder лишається в
     сесії.
   - **Повторювані помилки.** DO-блок кидає далі повторювані SQLSTATE
     (`55P03`, `40P01`, `40001`), а не пише їх як помилку функції. Валідатори
     й `plpgsql_check` беруть `ACCESS SHARE` на таблиці, які називають тіла,
     зокрема поза слідом. Перелік — одна константа `RETRYABLE_SQLSTATES`
     (`retry.ts`), з якої беруть і раннер, і SQL DO-блоку.
   - **Заміри:** 306 функцій — 12 мс. Функції провайдера (власник не член)
     перевіряються.
   - **`CREATE OR REPLACE` з `pg_get_functiondef` відхилено:**
     - потребує власника, тож падає на функціях провайдера;
     - бере замок на функцію;
     - змінює каталог (хай і відкатно).
4. **`plpgsql_check`** (спайк С4).
   - **Режим під `planHash`.** `plan` читає в `READ ONLY` цілі:
     - `installed` — є в `pg_extension`, роль має `USAGE` на його схему й
       `EXECUTE` на `plpgsql_check_function_tb`;
     - `transient` — є в `pg_available_extensions`, роль має `CREATE` на
       базу (`has_database_privilege(current_database(), 'CREATE')`), і
       роль може його поставити: розширення довірене
       (`pg_available_extension_versions.trusted`), роль —
       суперкористувач, або пресет провайдера називає його встановлюваним
       (`installableExtensions`; Supabase — `plpgsql_check`, через
       supautils);
     - `unavailable` — інакше, зокрема встановлене без прав.

     Вивід `plan` показує режим.
   - **Раннер у кожній базі (ціль, копія доказу) бере розширення сам:**
     1. є в цій базі — на місці, у точці збереження;
     2. ні — тимчасово:
        - `SAVEPOINT simetra_plpgsql_check`;
        - перевірка, що схема `simetra_plpgsql_check` вільна, інакше
          `apply.temp-name-taken`;
        - `CREATE SCHEMA`, `CREATE EXTENSION plpgsql_check SCHEMA …`;
        - запит;
        - `ROLLBACK TO`, `RELEASE`;
     3. не вдалося (зокрема немає `USAGE` на схему встановленого
        розширення), а план не `unavailable`:
        - на цілі (`apply`, `rehearse`) → `apply.plpgsql-check-unavailable`;
        - на копії доказу (`proof`) план без промоції дає попередження
          `plan.plpgsql-check-unavailable` з поясненням «на копії» і
          пропускає перевірку, а промоція — відмову того самого коду, що
          називає копію. Копія може жити на `shadowBase` зі стандартним
          образом Postgres без розширення, і звичайний план там не мусить
          відмовляти;
     4. план `unavailable` — перевірку пропущено: план уже попередив чи
        відмовив.

     Копія доказу розширення цілі може не мати (воно поза межею), тому
     рішення — на місці.
   - **Звірка режиму на цілі.** Поза `proof` план `installed`, а розширення
     в базі вже немає → `apply.target-changed` (`sections: "plpgsqlCheck"`).
     Перехід `transient → є` допустимий.
   - **Без розширення:**
     - план із промоцією → відмова `plan.plpgsql-check-unavailable` (спека:
       обов'язково);
     - інші плани → попередження того самого коду; ревалідація
       валідаторами лишається завжди.
   - **Хмара Supabase.** Розширення є в переліку розширень провайдера
     (сторінка документації Supabase «plpgsql_check: PL/pgSQL Linter»,
     розділ Database → Extensions), і на ньому стоїть `supabase db lint`
     (довідка CLI). Доступу до хмари в розробці немає. Якщо розширення там
     не виявиться, промоція безпечно відмовить.
   - **Обсяг:**
     - plpgsql-функції бази, крім членів розширень і схем каталогу;
     - тригерні — з кожним `tgrelid` нетехнічного тригера, з таблицями
       переходу (`oldtable => t.tgoldtable, newtable => t.tgnewtable`);
       без них тригер із `REFERENCING` дав би хибну помилку;
     - `fatal_errors => false`, інакше наявна помилка ховала б нову в тій
       самій функції;
     - рівень `error`;
     - рядки групуються (`count(*)` за функцією, таблицею, `sqlstate`,
       `message`), клієнт розгортає групу в мультимножину: одна функція
       провайдера дає до 17 однакових рядків, і без групування межа 1000
       досягалася б раніше;
     - `plpgsql_check` сам застосовує `proconfig` (виміряно).

     Параметри `plpgsql_check_function_tb` 2.8 звірено:
     `(funcoid regprocedure, relid regclass DEFAULT 0, fatal_errors boolean
     DEFAULT true, …, oldtable name, newtable name, …)`.
   - **Базова лінія й порівняння** (вердикт архітектора).
     - Помилка «після» — наявна, якщо в базовій лінії є невикористана
       помилка з тим самим `sqlstate` і `message`, тією самою таблицею
       тригера (за oid або текстом `regclass`) і тією самою функцією: спершу
       за oid, інакше за текстом `regprocedure`.
     - Порівняння — мультимножиною.
     - Запасний ключ потрібен: двигун часто перестворює тригерні функції з
       тією самою вже наявною помилкою.
   - **Заміри:**
     - 600 функцій (300 тригерів) — 183 мс;
     - `CREATE EXTENSION` — 8 мс;
     - замки перевірки відпускає `ROLLBACK TO`;
     - на функціях провайдера до плану вже 3 помилки.
   - **Подієві тригери Supabase** (`pgrst_ddl_watch`, `pgrst_drop_watch`,
     `issue_pg_graphql_access` тощо). Слухач `LISTEN pgrst` перевірив
     тимчасове встановлення з зовнішнім `COMMIT` і з `ROLLBACK`:
     - жодного `NOTIFY`, а контрольна закомічена DDL — рівно один;
     - `sum(last_value)` з `pg_sequences` не змінилась;
     - розширення й схеми в базі немає.

     Черга `NOTIFY` відкинутої підтранзакції скидається, записів поза
     транзакцією немає.
5. **Сліпі функції — попередження, а не тиша** (вердикт архітектора).
   `readBlindFunctions(tx, mode)` — запит каталогу. Сліпа функція:
   - функція процедурної мови, крім `sql`, `plpgsql`, `c`, `internal`;
   - функція `sql`/`plpgsql`, на яку роль не має `EXECUTE`
     (`has_function_privilege`): валідатор дає `42501` і до, і після;
   - plpgsql-функція, яку `plpgsql_check` не перевіряє (подієва, тригерна
     без тригера), коли режим не `unavailable`.

   Перелік (перші 10 і `count`) дає попередження `apply.function-check-blind`
   — у виводі `plan` (читання цілі в `READ ONLY`) і в результаті
   `apply`/`rehearse`. На копії доказу попередження немає: інакше вивід
   `plan` мав би два різні переліки. Функції мов `c` і `internal` тіла SQL
   не мають і сліпими не вважаються.

   Функції без `EXECUTE` DO-блок валідаторів не обходить: вони вже сліпі, а
   їхні `42501` лише наближали б межу 1000.
6. **Діагностика до відкату.** Відбиток після кроків ≠ бажаному на `apply`
   чи `rehearse`:
   1. `tx.extract(plan.scope)` у тій самій транзакції;
   2. `diffCatalogModels(plan.resultCatalog, витяг.model)` — шляхи (до 20) у
      параметрі `paths` діагностики `apply.verify-failed`;
   3. збій самого витягу — `paths` каже про це, а `verify-failed`
      лишається.

   На `proof` діагностика не потрібна: `prove()` уже будує план
   «копія → тінь».
7. **Повний доказ на репетиції.**
   - `ExecuteOptions` стає об'єднанням: режим `rehearse` вимагає
     `rehearsal: RehearsalProof` (`{ engine: Pick<SchemaEngine, "plan">;
     desired: EngineCatalog }`).
   - Після фази 17 раннер робить `tx.extract(plan.scope)`, потім
     `engine.plan(витяг.catalog, desired, plan.scope)`. Помилка плану
     двигуна чи хоч одна дія → `apply.rehearsal-proof-failed` (`count`,
     `first`). Виняток самого витягу (не обрив з'єднання, не повторюваний)
     — та сама відмова з `first: "(the extract failed: <message>)"`.
   - `apply --rehearse` будує бажану тінь тим самим шляхом, що `plan`
     (`desiredForApply(model)`, `engine.withDesiredShadow` під
     `artifact.scope`), до `BEGIN`; тінь не завантажилась — відмова з її
     діагностиками.
   - Діє для всіх планів.
8. **Витяг у транзакції — можливість `ApplyTransaction.extract(scope)`**
   (спайк С5, вердикт архітектора).
   - **Обгортка — новий об'єкт.** pg-delta (`connectWithErrorListener`) і
     `readOnlyQuery` викликають `on`, `removeListener` і перепризначають
     `release`, тож транзакційний `PoolClient` не мутується.
   - **Клієнт-обгортка:**
     - `query` — через сторож;
     - `on`, `removeListener`, `release` — no-op.
   - **Пул-обгортка:**
     - `connect` у формі промісу й колбека (колбек отримує no-op `done`);
     - `query` = `readOnlyQuery(цей пул, …)`, як у
       `readOnlyTransactionPool`: pg-delta кличе `pool.query` напряму
       (`resolveProfile`);
     - `end` і `on` — no-op.
   - **Сторож за деревом розбору.** Поза точкою збереження приймає лише
     `BEGIN …` (будь-яка форма) → `SAVEPOINT simetra_extract`. Усередині
     приймає:
     - `SELECT` без `FOR …` / `INTO`;
     - `SHOW`;
     - `SET LOCAL`;
     - `COMMIT`/`ROLLBACK` без `AND CHAIN` → `ROLLBACK TO SAVEPOINT
       simetra_extract; RELEASE SAVEPOINT simetra_extract`.

     Решта — відмова.
   - **Стан сторожа при помилці.** На відміну від `guard` у `read-only.ts`
     (помилка — транзакцію вважаємо закритою), помилка оператора всередині
     точки збереження лишає точку відкритою: наступний `ROLLBACK` двигуна
     сторож мусить прийняти й підмінити.
   - Точка збереження не буває `READ ONLY`, тож гарантію читання тримає
     сторож.
   - `extractOnTransactionClient` у `finally` закриває точку збереження
     (`ROLLBACK TO` + `RELEASE`), якщо двигун лишив її відкритою.
     `ApplyConnectionLost` позначає з'єднання втраченим, як `run` у
     `createApplyDatabase`.
   - **Виміряно:**
     - план «витяг у транзакції → бажана база» = 0 дій (до зміни — 3);
     - txid, `search_path`, `statement_timeout`, ізоляція, `pg_locks`,
       тимчасові об'єкти й `pg_prepared_statements` до й після однакові;
     - транзакція придатна далі, після `ROLLBACK` зміни немає;
     - 71 мс.
   - **Тест адаптера** в `test:db` фіксує фактичну послідовність підмін
     (`trace`) і ламається при зміні двигуна.
9. **Вхідні FK між `plan` і `apply`** (борг 2a, вердикт архітектора).
   - `lockPlan` уже читає `readLiveForeignKeys(tx, footprintSubjects(…))`.
     План записує `foreignKeys: { subjects, live }` під `planHash`.
   - Раннер (не `proof`) до замків читає `readLiveForeignKeys(tx,
     plan.foreignKeys.subjects)` тим самим кодом. Інший набір →
     `apply.target-changed` (`sections: "foreignKeys"`), без повтору — як
     `providerLocks`.
   - На `proof` звірки немає: копія несе лише межу.
10. **W-3: право на явний `LOCK` — лише на самій таблиці.**
    - Спайк: контейнери `postgres:14.24`, `postgres:15.19` і
      `postgres:16.15`.
    - Роль з `UPDATE` лише на батьківській таблиці
      (`has_table_privilege('child','update') = f`) виконує `LOCK TABLE
      parent IN ACCESS EXCLUSIVE MODE` без `ONLY`. Результат на всіх трьох:
      - для успадкування `pg_locks` показує `AccessExclusiveLock` на
        `parent` і `child`;
      - для партиції — на `p` і `p1`;
      - права нащадків не перевіряються, як і на 17+.
    - Гілка `< 17` у `lockRightsSql` прибирається, `lockRightsSql()`
      втрачає параметр версії.
    - Умова `server_version_num >= 170000` для `MAINTAIN` у
      `lockPrivileges` лишається: відмови для серверів нижче 17 у коді
      немає.
    - Відкрите питання R27 плану 2a закрито тут; план 2a не правиться.
11. **Тимчасові імена наміру** (борг 2a).
    - Намір перейменовує таблиці через `simetra_tmp_<n>` (займає будь-яке
      `pg_class.relname` і `pg_type.typname` схеми: рядковий тип таблиці).
    - Колонки йдуть через `simetra_tmp_<n>` / `simetra_retired_<n>`.
    - Канонічні імена — через `simetra_tmp_<n>` (`canonicalRenames` бачить
      лише об'єкти еквівалентності).
    - Тож `plan` на копії №1 до наміру шукає за шаблоном
      `^simetra_(tmp|retired)_[0-9]+$`:
      - усі `relname` і `typname` схем одиниці;
      - колонки й обмеження таблиць одиниці (старі імена — явним параметром
        `oldTables` в `analyseOnClone`).

      Збіг → `plan.temp-name-taken`. Хибна відмова на імені, яке не
      зіткнулося б, — допустима.
12. **Формат артефакту.** П3-2b-0 уже підняв `PLAN_FORMAT` до `3`. Задачі
    1, 2, 3, 6 додають поля в той самий формат: релізу між ними немає
    (прецедент — рішення 11 плану 2a). П3-2b-2 так само, поки пакети не
    випущено.
13. **Пункт 4 промпту** («`tightened` → `SET NOT NULL` класу «сканування для
    валідації»») уже виконано в коді: `steps.ts` класифікує
    `AT_SetNotNull` як `validationScan`. Нічого не додається; П3-2b-2 лише
    стежить, щоб `SET NOT NULL` ішов після запису (кроком двигуна).

### Рішення під час виконання

- **R1 (задача 2).** `installableExtensions` і решта фактів провайдера — дані
  в `engine/provider/presets.ts` (карта за `scope.provider`), без нового типу
  пресету; карти `SURFACES`, `PROVIDER_SYSTEM_ROLES`, `PROVIDER_LOCKS` зведено
  туди ж.
- **R2 (задача 2, вердикт архітектора «(г)»).** Очікувані сліпі функції
  базового стану провайдера пресет називає поштучно, за ідентичністю
  (`pgbouncer.get_auth(text)` та інші, кожна з причиною). Функція з переліку —
  рядок у виводі `plan`, не попередження; будь-яка інша сліпа функція, зокрема
  в схемах провайдера поза переліком, — `apply.function-check-blind`. Чому
  поштучно, а не за схемою: виняток за схемою — мовчазна зона (крок, що зламав
  тіло провайдерської функції, якої роль не бачить, пройшов би непомітно), а
  попередження, що з'являється завжди, привчає його ігнорувати.
- **R3 (задачі 1–2).** Ключі `proconfig`, які DO-блок валідаторів не
  застосовує, — один перелік у коді (`UNAPPLIED_FUNCTION_SETTINGS`):
  `check_function_bodies` (ревалідація сама ставить `on`), `lock_timeout` і
  `statement_timeout` (тайм-аути перевірки задає раннер; власний
  `lock_timeout = 0` функції перетворив би чужий замок на сиру `57014` замість
  повторюваної `55P03` і зламав би Review Focus 2).
- **R4 (задача 2).** Обсяг функцій — один SQL-фрагмент для валідаторів,
  `readBlindFunctions` і `plpgsql_check` (`FUNCTION_SCOPE_SQL`), з тестом, що
  всі три його беруть: розбіжність обсягів була б мовчазною зоною.
- **R5 (задача 2, рішення 4 крок 3).** Звірка режиму у фазі 4 — лише наявність
  розширення: план `installed`, а розширення в базі немає →
  `apply.target-changed`; розширення є, але роль втратила права →
  `apply.plpgsql-check-unavailable`.
- **R6 (задача 2).** Тригерна plpgsql-функція без тригера при доступному
  `plpgsql_check` — сліпа (рішення 5).
- **R7 (задача 4).** Сторож витягу суворіший за букву рішення 8: FOR/INTO і
  записи відмовлено на будь-якій глибині SELECT (підзапити, CTE),
  `START TRANSACTION` — відмова, приймається лише `BEGIN`. Збій діагностичного
  витягу фази 17, зокрема обрив з'єднання, іде в `paths`, а
  `apply.verify-failed` лишається (рішення 6): `COMMIT` не надсилається.
- **R8 (задача 4, вердикт архітектора; виконано у фінальній хвилі).** Сторож
  відмовляє функціям з ефектом поза транзакцією: `nextval`, `setval`, сесійні
  `pg_advisory_lock`, `pg_advisory_lock_shared`, `pg_try_advisory_lock`,
  `pg_try_advisory_lock_shared` (варіанти `*_xact_*` дозволені). Решту названо
  у «Відомих обмеженнях».
- **R9 (задачі 6–7, борг 2b-0, доручення архітектора).** Закрито: деталь
  `plan.property-not-reproduced` для UNIQUE — за полями `uniqueDifferences`;
  збій копії доказу називає фазу; тест Б3 без scope/scopeColumn; `columnOf`
  знімає лише приведення до text; тест пулів лічить клієнтські сесії до нуля;
  сторож тіней `round-trip.db.test.ts` — тінь «наша» з моменту провізії,
  прибирання й на падінні, чужі старі тіні лише називаються. Звірка
  `providerLocks` і `foreignKeys` — канонічним JSON (RFC 8785), а не
  `JSON.stringify`, щоб не залежати від порядку ключів.

## Відомі обмеження

Кожне — безпечна відмова чи явне попередження, а не мовчазна втрата.

- **Сліпі функції** (рішення 5): інші процедурні мови, функції без EXECUTE
  для ролі, подієві й тригерні без тригера — `apply.function-check-blind` з
  переліком.
- **Динамічний SQL** (`EXECUTE format('… %I …', …)`) `plpgsql_check` не
  ловить. Для промоції це клас «переписується вручну» спеки §6.
- **Функцію перейменовано, і вона мала помилку до плану.** Ні oid (якщо
  перестворено), ні сигнатура не збігаються — хибна відмова
  `apply.function-check-failed`. Обхід — розбити зміну.
- **Більше 1000 помилок функцій** з будь-якого боку — хибна відмова
  `apply.function-check-failed` («перелік обрізано»).
- **Ціль без `plpgsql_check`:**
  - промоція — `plan.plpgsql-check-unavailable`;
  - інші плани — попередження, ревалідація валідаторами лишається.
- **Діагностичні шляхи `apply.verify-failed`** беруться з моделі каталогу
  (проєкції). Розбіжність, якої модель не несе, дає порожній перелік —
  секції відбитка тоді називає сама діагностика.
- **Витяг у транзакції — `READ COMMITTED`** транзакції раннера, а не
  `REPEATABLE READ`, якого чекає pg-delta. Чужа DDL поза замками між
  запитами витягу може дати хибну відмову повного доказу. Під замками
  плану таблиці межі вже незмінні.
- **Повний доказ на репетиції потребує бажаної тіні** (co-located чи
  `shadowBase`), як і `plan`. Витяг подовжує утримання замків плану на
  час репетиції на самій цілі (десятки-сотні мс; опис інструмента `apply`
  це каже).
- **Лог сервера.** Транспорт `SIMFE` — це `ERROR` у лозі сервера на кожну
  ревалідацію (двічі на спробу й на доказі), з текстом DO-блоку, якщо ввімкнено
  `log_min_error_statement`. Сповіщення провайдера на `ERROR` можуть на
  нього реагувати.
- **`transient` на Postgres без довіреного `plpgsql_check`** і без пресету,
  що називає його встановлюваним, — режим `unavailable` (рішення 4).
- **Застосування промоції з `COMMIT`** — `apply.promotion-checks-pending` до
  П3-2b-2.
- **Сторож витягу не блокує:** `set_config(…, false)` (сесійний ефект, але на
  власному з'єднанні двигуна); функції розширень на кшталт `dblink` (виходять
  за межі транзакції); побічні ефекти всередині користувацьких функцій, які
  викликає витяг (сторож бачить лише текст запиту). Межа — довірений код
  двигуна: сторож ловить помилки, а не зловмисника.

---

### Task 0: Звірка плану з кодом і базова лінія

**Files:** —

- [ ] **Step 1: Звірити якорі плану з кодом**

Run: `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-13-p3-2b-1-pre-commit-guarantees.md`
Expected: кожен шлях і символ, який план називає наявним, знайдено. Серед
них:

- `runAttempt`, `executePlan`, `ExecuteOptions`, `ExecutablePlan`;
- `ApplyTransaction`, `createApplyDatabase`;
- `extractFrom`, `readOnlyQuery`, `readOnlyTransactionPool`,
  `vetTargetQuery`;
- `lockPlan`, `readLiveForeignKeys`, `footprintSubjects`, `lockRightsSql`,
  `lockPrivileges`;
- `measure`, `measureBefore`, `prove`, `planPromotion`, `analyseOnClone`;
- `PLAN_FORMAT`, `planArtifactSchema`, `inCatalogPath`;
- `renameIntent`, `canonicalRenames`;
- кроки `origin: "environment"` з П3-2b-0.

Розбіжність — стоп і звіт архітекторові.

- [ ] **Step 2: Базова лінія гейтів**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, потім
`pnpm db:start` і `pnpm test:db`.
Expected: усе зелене; число тестів (simetra, designer, DB) записати в журнал
виконання. Червоне до змін — стоп і звіт.

- [ ] **Step 3: Перевірити, що розширення досі є на стеку**

Run: `docker exec -e PGPASSWORD=postgres supabase_db_simetra psql -h 127.0.0.1 -U postgres -d postgres -Atc "select default_version from pg_available_extensions where name = 'plpgsql_check'"`
Expected: `2.8` (чи новіша). Порожньо — стоп: тести задачі 2 стоять на ньому.

### Task 1: Налаштування, преамбула цілком і ревалідація валідаторами

R22: преамбула й ревалідація — тим самим комітом.

**Files:**
- Create: `packages/simetra/src/schema/apply/settings.ts`
- Create: `packages/simetra/src/schema/apply/function-checks.ts`
- Create: `packages/simetra/src/schema/apply/retry.ts`
- Create: `packages/simetra/src/schema/apply/__tests__/function-checks.test.ts`
- Create: `packages/designer/src/schema-engine/__tests__/function-checks.db.test.ts`
- Modify: `packages/simetra/src/schema/apply/execute.ts` (`RETRYABLE` → `retry.ts`; фази 7, 11, 12, 15; перевірка порядку походжень; `ExecutablePlan` + `revalidationSearchPath`)
- Modify: `packages/simetra/src/schema/apply/artifact.ts` (`PLAN_FORMAT`, поле `revalidationSearchPath`, JSDoc `preamble`)
- Modify: `packages/simetra/src/schema/engine/port.ts` (коментар біля `ENGINE_PREAMBLE_ALLOWED`)
- Modify: `packages/simetra/src/schema/apply/plan.ts` (читання шляху й сліпих функцій у `buildPlan` і `planPromotion`)
- Modify: `packages/simetra/src/schema/apply/index.ts` (експорти)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts` (`apply.function-check-failed`, `apply.function-check-blind`, `apply.temp-name-taken`)
- Modify (тести, що ламає поле): `execute.test.ts` (зокрема тест «runs every step and guard under the transaction settings although the plan records a preamble»), `artifact.test.ts`, `execute-plan.db.test.ts` (`planFor`, `describe("engine preamble")`), `read-only.db.test.ts`, `apply-outcome.test.ts`

**Interfaces:**
- Consumes: `EngineSetting` (`schema/engine/port.ts`), `ApplyTransaction`, `ApplyDbError`.
- Produces:
  - `RETRYABLE_SQLSTATES: readonly string[]` = `["55P03", "40P01", "40001"]` (`retry.ts`). `execute.ts` будує з неї свою множину, а повтор спроби вмикає лише для `55P03` і `40P01`, як зараз. `40001` повторюється лише всередині перевірок: раннер його й так прокидає сирим;
  - `withLocalSettings<T>(tx: ApplyTransaction, settings: readonly EngineSetting[], run: () => Promise<T>): Promise<T>` (`settings.ts`);
  - `revalidationSettings(searchPath: string): EngineSetting[]` (`settings.ts`);
  - `readSessionSearchPath(tx: ApplyTransaction): Promise<string>` (`settings.ts`);
  - `interface FunctionError { oid: string; signature: string; relationOid: string | null; relation: string | null; sqlstate: string; message: string }` (`function-checks.ts`);
  - `interface CheckResult { total: number; errors: FunctionError[] }`;
  - `FUNCTION_ERROR_LIMIT = 1000`;
  - `readValidatorErrors(tx: ApplyTransaction): Promise<CheckResult>`;
  - `newFunctionErrors(baseline: readonly FunctionError[], after: readonly FunctionError[]): FunctionError[]` — чиста;
  - `readBlindFunctions(tx: ApplyTransaction, plpgsqlCheck: "available" | "unavailable"): Promise<string[]>` — `regprocedure` сліпих функцій, відсортовані;
  - `PlanArtifact.revalidationSearchPath: string`.

- [ ] **Step 1: Юніт-тести (червоні)**

`function-checks.test.ts`, `describe("newFunctionErrors")`:

```ts
const e = (over: Partial<FunctionError> = {}): FunctionError => ({
  oid: "100", signature: "app.f(integer)", relationOid: null, relation: null,
  sqlstate: "42703", message: 'column "a" does not exist', ...over,
})
it("keeps an error that was there before", () =>
  expect(newFunctionErrors([e()], [e()])).toEqual([]))
it("matches a recreated function by signature", () =>
  expect(newFunctionErrors([e()], [e({ oid: "200" })])).toEqual([]))
it("matches a renamed trigger table by its oid", () =>
  expect(newFunctionErrors(
    [e({ relationOid: "7", relation: "app.old" })],
    [e({ relationOid: "7", relation: "app.new" })])).toEqual([]))
it("reports a new message", () =>
  expect(newFunctionErrors([e()], [e({ message: 'column "b" does not exist' })]))
    .toHaveLength(1))
it("counts duplicates as a multiset", () =>
  expect(newFunctionErrors([e()], [e(), e()])).toHaveLength(1))
it("reports another function with the same message", () =>
  expect(newFunctionErrors([e()], [e({ oid: "300", signature: "app.g()" })]))
    .toHaveLength(1))
```

`describe("withLocalSettings")` — на фейковому `tx`, що пише журнал
запитів: порядок «читання → встановлення → `run` → повернення збережених»,
без `set_config(…, false)`.

`describe("readValidatorErrors")` — на фейковому `tx`:

- DO-блок кидає `ApplyDbError(json, "SIMFE")` →
  `{ total, errors }` розібрано, точку збереження відкочено (журнал:
  `SAVEPOINT`, DO, `ROLLBACK TO`, `RELEASE`);
- DO-блок кидає `ApplyDbError(…, "55P03")` → та сама помилка летить далі.

`execute.test.ts`:

- `"refuses a plan whose intent step follows an engine step"` — `executePlan`
  кидає `Error` до `BEGIN` (журнал порожній);
- `"refuses to compare when the function error list was cut"` — DO-блок
  повертає `total: 1001` → `failed`, `apply.function-check-failed`;
- `"refuses a plan whose environment step precedes an engine step"` —
  `Error` до `BEGIN`;
- `"throws when the validator block ends without its result"` — DO-блок
  завершується без помилки → `Error`.

- [ ] **Step 2: Запустити — червоне**

Run: `pnpm --filter simetra test function-checks`
Expected: FAIL — модуля немає.

- [ ] **Step 3: Реалізувати `retry.ts`, `settings.ts`, `function-checks.ts`**

`withLocalSettings` — два запити:

1. `current_setting` усіх імен одним
   `SELECT … FROM unnest($1::text[]) WITH ORDINALITY`;
2. `set_config(n, v, true)` одним
   `SELECT … FROM unnest($1::text[], $2::text[])`.

Повернення — так само.

`readValidatorErrors`:

1. `SAVEPOINT simetra_revalidate`;
2. DO-блок нижче;
3. `SIMFE` — розібрати повідомлення як JSON;
4. `ROLLBACK TO SAVEPOINT simetra_revalidate`,
   `RELEASE SAVEPOINT simetra_revalidate`.

Інший SQLSTATE летить далі. DO-блок завершується `SIMFE` завжди, тож
нормального завершення бути не може — інакше `Error` (зламаний SQL).

Повторювані SQLSTATE в `IN (…)` підставляються з `RETRYABLE_SQLSTATES`:

```sql
DO $simetra$
DECLARE r record; kv text; errs text[] := '{}'; total int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proconfig, l.lanvalidator
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang AND l.lanname IN ('sql', 'plpgsql')
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname !~ '^pg_(temp|toast)'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND d.objid = p.oid AND d.deptype = 'e')
      -- без EXECUTE функція сліпа (рішення 5), а її 42501 лише наближав би межу
      AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
    ORDER BY p.oid
  LOOP
    BEGIN
      FOREACH kv IN ARRAY coalesce(r.proconfig, '{}') LOOP
        CONTINUE WHEN pg_catalog.split_part(kv, '=', 1) = 'check_function_bodies';
        BEGIN
          PERFORM pg_catalog.set_config(pg_catalog.split_part(kv, '=', 1),
            pg_catalog.substr(kv, pg_catalog.strpos(kv, '=') + 1), true);
        EXCEPTION WHEN OTHERS THEN
          IF SQLSTATE IN (<RETRYABLE_SQLSTATES>) THEN RAISE; END IF;
        END;
      END LOOP;
      EXECUTE pg_catalog.format('SELECT %s($1)', r.lanvalidator::pg_catalog.regproc) USING r.oid;
      -- сторожовий виняток відкочує set_config вкладеного блоку
      RAISE EXCEPTION USING ERRCODE = 'SIMOK';
    EXCEPTION
      WHEN SQLSTATE 'SIMOK' THEN NULL;
      WHEN OTHERS THEN
        IF SQLSTATE IN (<RETRYABLE_SQLSTATES>) THEN RAISE; END IF;
        total := total + 1;
        IF total <= <FUNCTION_ERROR_LIMIT> THEN
          errs := errs || pg_catalog.jsonb_build_object('oid', r.oid::text,
            'signature', r.oid::pg_catalog.regprocedure::text,
            'sqlstate', SQLSTATE, 'message', SQLERRM)::text;
        END IF;
    END;
  END LOOP;
  RAISE EXCEPTION USING ERRCODE = 'SIMFE', MESSAGE = pg_catalog.jsonb_build_object(
    'total', total, 'errors', (SELECT coalesce(pg_catalog.jsonb_agg(x::jsonb), '[]') FROM pg_catalog.unnest(errs) AS x))::text;
END $simetra$
```

`newFunctionErrors` — рішення 4: мультимножина з одноразовим
використанням елемента базової лінії.

`readBlindFunctions` — рішення 5, одним запитом каталогу:

- мови не з `('sql', 'plpgsql', 'c', 'internal')`;
- `sql`/`plpgsql` з `NOT has_function_privilege(p.oid, 'EXECUTE')`;
- коли `plpgsqlCheck` `available`: plpgsql-функції з `prorettype` =
  `event_trigger`, а також `trigger` без нетехнічного тригера.

- [ ] **Step 4: Юніт-тести — зелене**

Run: `pnpm --filter simetra test function-checks`
Expected: PASS.

- [ ] **Step 5: Артефакт — формат і шлях ревалідації**

- `artifact.ts`:
  - `PLAN_FORMAT` — рішення 12;
  - `revalidationSearchPath: string` в інтерфейсі й `planArtifactSchema`;
  - JSDoc `preamble` — «раннер виконує її навколо кроків двигуна».
- `plan.ts` у `buildPlan` і `planPromotion` у тій самій `READ ONLY`
  транзакції цілі, де `lockPlan` читає перелік провайдера, читає:
  - `readSessionSearchPath` — в артефакт і в план доказу;
  - `readBlindFunctions` — у попередження `apply.function-check-blind`.
- `ExecutablePlan` (`Pick`) отримує `revalidationSearchPath`.
- `artifact.test.ts`: без поля → `reason: "invalid"`.
- Типові значення нових полів у `planFor` (`execute-plan.db.test.ts`) і
  фейкових планах: `revalidationSearchPath` — живим
  `readSessionSearchPath`; далі (задачі 2, 3, 6) `plpgsqlCheck` — явно,
  `desiredInvalid: []`, `foreignKeys: { subjects: [], live: [] }`.

- [ ] **Step 6: Раннер — фази 7, 11, 12, 15**

`executePlan` до `BEGIN` перевіряє порядок походжень (рішення 1): `intent`,
`engine`, `environment`, інакше `throw new Error("plan steps are out of
origin order: intent, engine, environment")`.

`runAttempt`:

- **Фаза 7** (після `measureBefore` і `readExistingTables`):
  `baseline = await withLocalSettings(tx, revalidationSettings(plan.revalidationSearchPath), () => readValidatorErrors(tx))`.
- **Фаза 9** — кроки наміру під налаштуваннями транзакції.
- **Фаза 11** — кроки двигуна зі сторожами всередині
  `withLocalSettings(tx, plan.preamble, …)`.
- **Фаза 12** — кроки середовища (П3-2b-0) під налаштуваннями транзакції.
- **Фаза 15** (після `provePreservation`): те саме читання під
  налаштуваннями ревалідації.
  - `total > FUNCTION_ERROR_LIMIT` з будь-якого боку →
    `stop("failed", "apply.function-check-failed", { count, functions: "(the list was cut at 1000; the check cannot compare it)" })`.
  - Інакше `newFunctionErrors` не порожній →
    `stop("failed", "apply.function-check-failed", { count, functions })`,
    де `functions` — перші 10 як
    `<signature>[ on <relation>]: <sqlstate> <message>`, через `; `.
  - Лише в режимах `apply` і `rehearse`: сліпі функції
    (`readBlindFunctions`) не порожні → попередження
    `apply.function-check-blind` у результаті. До задачі 2 режим
    `plpgsql_check` — `"unavailable"`.
  - `readValidatorErrors` завершився без `SIMFE` → `Error` (зламаний SQL
    DO-блоку).

Коментарі «преамбулу раннер не виконує» (`execute.ts` у коментарі циклу
кроків `// 7. Кроки по черзі`, `engine/port.ts` біля
`ENGINE_PREAMBLE_ALLOWED`) — замінити правилом R22:
пара виконується разом із ревалідацією.

Нові діагностики:

- `apply.function-check-failed`:
  - en: «After the plan's steps {count} function(s) have errors they did
    not have before: {functions}. The transaction was rolled back»;
  - hint: виправити тіло функції в тому самому плані або розбити зміну.
- `apply.function-check-blind` (warning):
  - en: «{count} function(s) cannot be checked after the steps
    (another procedural language, no EXECUTE for the applying role, or
    plpgsql_check skips them): {functions}»;
  - hint: що не перевіряється — переглянути вручну.
- `apply.temp-name-taken`:
  - en: «The name {name} the apply needs for a check inside its
    transaction is already taken. Nothing was written»;
  - hint: прибрати об'єкт із таким ім'ям.

- [ ] **Step 7: DB-тести ревалідації**

`function-checks.db.test.ts` (шаблон `inTarget` / `planFor` / `step` з
`execute-plan.db.test.ts`):

- `"refuses a step that breaks a SQL function body"`:
  - setup
    `create table app.t (id int, a text); create function app.fa() returns text language sql as $$ select a from app.t $$`;
  - крок `ALTER TABLE app.t RENAME COLUMN a TO b`;
  - → `failed`, `apply.function-check-failed`, `functions` містить
    `app.fa()`; ціль без змін.
- `"refuses a plpgsql body that does not compile although the preamble turned validation off"`
  (Review Focus 1):
  - преамбула з обома парами;
  - крок
    `CREATE FUNCTION app.bad() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$`
    (синтаксично невалідне для `int`);
  - `plpgsqlCheck: "unavailable"`;
  - → `apply.function-check-failed` з `app.bad()`.
- `"does not count a SQL function that was broken before the plan"`:
  - setup з
    `set check_function_bodies = off; create function app.fb() returns int language sql as $$ select nope from app.t $$`;
  - нейтральний крок → `committed`.
- `"validates a SQL function under its own search_path"`:
  - `create function app.fc() returns text language sql set search_path = app as $$ select a from t $$`;
  - нейтральний крок → `committed`;
  - крок, що перейменовує `a` → `apply.function-check-failed` з `app.fc()`.
- `"retries instead of blaming a function when a table it names is locked"`
  (Review Focus 2):
  - setup — `other.far (x int)` у схемі поза межею (жодна перевірка
    відбитка її не читає) і SQL-функція, що читає `other.far`;
  - друга сесія (`holder`) тримає `LOCK TABLE other.far IN ACCESS EXCLUSIVE MODE`;
  - `timeouts: { lockTimeoutMs: 200, attempts: 2 }`;
  - → `failed`, `apply.lock-timeout`, а не `apply.function-check-failed`.
- `"proves a forward-referencing SQL function"`:
  - кроки
    `CREATE FUNCTION app.ff() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM app.later $$`,
    потім `CREATE TABLE app.later (id int)`, преамбула з обома парами;
  - бажаний відбиток — з бази, де кроки виконано після
    `set check_function_bodies = off`;
  - → `committed` у режимі `proof`. Це обмеження «тіло функції з
    посиланням уперед» плану 2a, тепер зняте.
- `"warns about a function it cannot check"`:
  - функція `sql` з `revoke execute … from public`, власник —
    `simetra_execute_owner`, роль застосування не член;
  - → `committed` і попередження `apply.function-check-blind` з нею.
- `"leaves the transaction settings as they were"`: `search_path` і
  `check_function_bodies` транзакції після фази 15 — ті самі, що до фази
  7 (тригер на `simetra.ledger`, як у `describe("engine preamble")`).

`describe("engine preamble")` у `execute-plan.db.test.ts` переписати:

- кроки двигуна бачать `search_path = pg_catalog` і
  `check_function_bodies = off`;
- кроки наміру й запис стану бачать налаштування транзакції;
- після кроків двигуна налаштування знову як до них;
- преамбула лише з `search_path` виконується як є.

Тест `"proves a SQL function whose body names a table of public without schema"`
лишається зеленим: шлях ревалідації — сесійний, `public` у ньому є.

- [ ] **Step 8: Зелене й коміт**

Run: `pnpm --filter simetra test`, `pnpm --filter simetra typecheck`,
`pnpm --filter @simetra/designer typecheck`, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "feat(schema): преамбула двигуна цілком і ревалідація функцій валідаторами мов проти базової лінії в транзакції"
```

### Task 2: `plpgsql_check` проти базової лінії

**Files:**
- Modify: `packages/simetra/src/schema/apply/function-checks.ts`
- Modify: `packages/simetra/src/schema/apply/execute.ts` (фази 4, 7, 15; `ExecutablePlan` + `plpgsqlCheck`)
- Modify: `packages/simetra/src/schema/apply/artifact.ts` (поле `plpgsqlCheck`)
- Modify: `packages/simetra/src/schema/apply/plan.ts` (режим; відмова чи попередження)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts` (`plan.plpgsql-check-unavailable`, `apply.plpgsql-check-unavailable`)
- Modify: `packages/designer/src/tools/apply-tools.ts` (`PlanData.plpgsqlCheck`), `packages/designer/src/io/report.ts`
- Modify (тести, що ламає поле): `execute.test.ts`, `artifact.test.ts`, `execute-plan.db.test.ts`, `read-only.db.test.ts`, `apply-outcome.test.ts`
- Test: `function-checks.test.ts`, `function-checks.db.test.ts`, `packages/designer/src/schema-engine/__tests__/build-plan.db.test.ts`

**Interfaces:**
- Consumes: `FunctionError`, `CheckResult`, `newFunctionErrors`, `withLocalSettings`, `revalidationSettings`, `readBlindFunctions` (задача 1).
- Produces:
  - `type PlpgsqlCheckMode = "installed" | "transient" | "unavailable"`;
  - `readPlpgsqlCheckMode(tx: ApplyTransaction): Promise<PlpgsqlCheckMode>`;
  - `readPlpgsqlErrors(tx: ApplyTransaction, planned: PlpgsqlCheckMode): Promise<CheckResult | "skipped">`. Кидає `PlpgsqlCheckUnavailable` (клас у `function-checks.ts`, з `sqlstate` і `message`), коли розширення не вдалося взяти, а `planned !== "unavailable"`;
  - `planFunctionChecks(tx: ApplyTransaction, p: { promotion: boolean; installable: readonly string[] }): Promise<{ mode: PlpgsqlCheckMode; diagnostics: EngineDiagnostic[] }>` — те, що `plan.ts` кличе в транзакції `lockPlan`; `installable` — `installableExtensions` пресету провайдера;
  - пресет провайдера (`packages/simetra/src/schema/engine/provider/supabase.ts` і тип пресету) отримує `installableExtensions: readonly string[]` (Supabase — `["plpgsql_check"]`);
  - `PlanArtifact.plpgsqlCheck: PlpgsqlCheckMode`.

- [ ] **Step 1: Тести (червоні)**

`function-checks.test.ts`, `describe("planFunctionChecks")` — фейковий
`tx`, що повертає задані факти (встановлене, права на схему й функцію,
доступне, `trusted`, суперкористувач, `CREATE` на базу):

- немає ні того, ні іншого, `promotion: true` → `mode: "unavailable"`, один
  `plan.plpgsql-check-unavailable` рівня `error`;
- те саме, `promotion: false` → той самий код рівня `warning`;
- доступне, але немає `CREATE` на базу → `unavailable`;
- доступне, `CREATE` є, не довірене, не суперкористувач, `installable`
  порожній → `unavailable`; з `installable: ["plpgsql_check"]` →
  `transient`;
- встановлене, але без `USAGE` на схему → `unavailable`;
- встановлене з правами → `installed`, `[]`.

`execute.test.ts` (фейковий порт):

- `"fails when the extension cannot be taken"`: `CREATE EXTENSION
  plpgsql_check` кидає `ApplyDbError(…, "0A000")` при плані `transient` →
  `failed`, `apply.plpgsql-check-unavailable` з `sqlstate`;
- `"refuses when the installed extension is gone"`: план `installed`, у базі
  розширення немає, режим `apply` → `refused`, `apply.target-changed`
  (`sections: "plpgsqlCheck"`); у режимі `proof` — тимчасове встановлення,
  без відмови;
- `"warns on a copy without the extension"`: режим `proof`, план без
  промоції, `CREATE EXTENSION` кидає → `committed` з попередженням
  `plan.plpgsql-check-unavailable`; той самий план із промоцією → `failed`
  з тим самим кодом;
- `"refuses to compare a cut plpgsql_check list"`: запит повертає
  `FUNCTION_ERROR_LIMIT + 1` груп → `apply.function-check-failed`.

`artifact.test.ts`: без `plpgsqlCheck` → `reason: "invalid"`.

`function-checks.db.test.ts`, `describe("plpgsql_check")`:

- `"refuses a step that breaks a plpgsql body"`:
  - `create function app.fp() returns text language plpgsql as $$ declare r text; begin select a into r from app.t limit 1; return r; end $$`;
  - крок перейменовує `a`;
  - → `apply.function-check-failed` з `app.fp()`.
- `"checks a trigger function with each table it fires on"`:
  - тригерна функція `new.a := upper(new.a)` на `app.t` і `app.t2`;
  - крок перейменовує `a` лише в `app.t`;
  - → помилка рівно з `on app.t`.
- `"checks a trigger with transition tables"`:
  - `AFTER INSERT … REFERENCING NEW TABLE AS n FOR EACH STATEMENT` з
    функцією, що читає `n`;
  - нейтральний крок → `committed` (без хибної помилки).
- `"keeps an error of another role's function that was there before"`
  (Review Focus 3):
  - функція ролі `simetra_execute_owner` з помилкою `select nope …`;
  - нейтральний крок → `committed`;
  - крок, що ламає другий запит тієї самої функції →
    `apply.function-check-failed`.
- `"matches a function the plan recreates with the same error"`
  (Review Focus 4):
  - у setup — plpgsql-функція з помилкою;
  - кроки `DROP FUNCTION …` і `CREATE FUNCTION …` з тим самим тілом →
    `committed`.
- `"installs the extension only for the check"`: план `transient`, після
  `committed` у новій сесії `pg_extension` без `plpgsql_check`, схеми
  `simetra_plpgsql_check` немає.
- `"uses an installed extension in place"`:
  - setup `create schema ext; create extension plpgsql_check schema ext`
    → план `installed`;
  - помилка ловиться, розширення після прогону на місці.
- `"refuses a taken check schema"`:
  - setup `create schema simetra_plpgsql_check`, план `transient`;
  - → `refused`, `apply.temp-name-taken` з `name: simetra_plpgsql_check`.

`build-plan.db.test.ts`:

- план на стеку несе `plpgsqlCheck: "transient"`, вивід — без
  `plan.plpgsql-check-unavailable`;
- тест підключення гейта: `buildPlan` з `dbs.reader`, що обгортає справжній
  і на запиті режиму повертає «немає розширення». Для промоції — `refused`
  з `plan.plpgsql-check-unavailable`, для звичайного плану — `planned` із
  попередженням.

- [ ] **Step 2: Запустити — червоне**

Run: `pnpm --filter simetra test function-checks execute`
Expected: FAIL.

- [ ] **Step 3: Реалізувати**

`readPlpgsqlCheckMode` — рішення 4.

`readPlpgsqlErrors` — алгоритм рішення 4. Запит (схема — з `pg_extension`
цієї бази, `quoteIdent`; запит іде в точці збереження
`simetra_plpgsql_check`, під налаштуваннями ревалідації):

```sql
SELECT p.oid::text AS oid, p.oid::regprocedure::text AS signature,
  t.tgrelid::text AS "relationOid", t.tgrelid::regclass::text AS relation,
  cs.sqlstate, cs.message, pg_catalog.count(*)::int AS n
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_language l ON l.oid = p.prolang AND l.lanname = 'plpgsql'
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_catalog.pg_trigger t ON t.tgfoid = p.oid AND NOT t.tgisinternal
CROSS JOIN LATERAL <schema>.plpgsql_check_function_tb(p.oid,
  coalesce(t.tgrelid, 0), fatal_errors => false,
  oldtable => t.tgoldtable, newtable => t.tgnewtable) cs
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname !~ '^pg_(temp|toast)'
  AND p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
  AND (p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype OR t.tgrelid IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
    WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND d.objid = p.oid AND d.deptype = 'e')
  AND cs.level = 'error'
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY 2, 4, 5, 6
LIMIT <FUNCTION_ERROR_LIMIT + 1>
```

Клієнт розгортає групу з `n` у `n` однакових `FunctionError`; `total` —
сума `n`. Груп більше за межу — та сама відмова «перелік обрізано», що в
задачі 1. Повторювана
помилка запиту летить далі. Тимчасовий шлях — `CREATE SCHEMA
simetra_plpgsql_check`, `CREATE EXTENSION plpgsql_check SCHEMA
simetra_plpgsql_check`.

Раннер:

- фаза 4 (не `proof`): звірка режиму;
- фаза 7 — базова лінія;
- фаза 15 — порівняння, той самий `apply.function-check-failed`;
- `"skipped"` в обох фазах — нічого не порівнюється;
- `PlpgsqlCheckUnavailable` на цілі →
  `stop("failed", "apply.plpgsql-check-unavailable", { sqlstate, error })`;
  на копії доказу — рішення 4, крок 3.

`plan.ts`:

- кличе `planFunctionChecks(tx, …)` у транзакції `lockPlan`;
- кладе режим в артефакт і в план доказу;
- `error` — відмова плану;
- `readBlindFunctions` (задача 1) отримує `available` / `unavailable` з
  режиму.

`planData` і звіт `plan` — рядок
`plpgsql_check: installed | transient (installed for the check, rolled back) | unavailable`.

- [ ] **Step 4: Зелене й коміт**

Run: `pnpm --filter simetra test`, typecheck обох пакетів, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "feat(schema): plpgsql_check проти базової лінії в транзакції, тимчасове розширення в точці збереження"
```

### Task 3: Відкладені обмеження й валідність перед кінцем транзакції

**Files:**
- Create: `packages/simetra/src/schema/apply/validity.ts`
- Modify: `packages/simetra/src/schema/apply/execute.ts` (фази 13, 16; `ExecutablePlan` + `desiredInvalid`)
- Modify: `packages/simetra/src/schema/apply/artifact.ts` (поле `desiredInvalid: string[]`)
- Modify: `packages/simetra/src/schema/apply/plan.ts` (читання на бажаній тіні в `buildPlan` і `planPromotion`)
- Modify: `packages/simetra/src/schema/apply/fingerprint.ts` (експорт `inCatalogPath`)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts` (`apply.deferred-constraint-failed`, `apply.constraint-invalid`)
- Modify (тести, що ламає поле): ті самі файли літералів плану (Global Constraints)
- Test: `execute-plan.db.test.ts` (новий `describe("end of transaction")`), `build-plan.db.test.ts`, `artifact.test.ts`

**Interfaces:**
- Produces:
  - `readInvalidObjects(tx: ApplyTransaction, scope: EngineScope): Promise<string[]>` — відсортовані тексти `constraint <regclass> <ім'я>`, `domain constraint <regtype> <ім'я>`, `index <regclass>`;
  - `PlanArtifact.desiredInvalid: string[]`.

- [ ] **Step 1: Тести (червоні)**

`execute-plan.db.test.ts`:

- `"surfaces a deferred foreign key violation before a rehearsal rolls back"`
  (Review Focus 5):
  - setup
    `create table app.p (id int primary key); create table app.c (id int, p int references app.p deferrable initially deferred); insert into app.p values (1); insert into app.c values (1, 1)`;
  - крок `DELETE FROM app.p` (вручну, клас `destructive`, `allow`);
  - режим `rehearse` → `failed`, `apply.deferred-constraint-failed` із
    `sqlstate: "23503"`.
- `"refuses a NOT VALID constraint the desired state does not have"`:
  - крок `ALTER TABLE app.t ADD CONSTRAINT t_a CHECK (a <> '') NOT VALID`;
  - `desiredInvalid: []`;
  - `desiredFingerprint` — від бази, де обмеження дійсне;
  - → `failed`, `apply.constraint-invalid`, `objects` містить `t_a`.
- `"accepts an invalid object the desired state also has"`: той самий
  крок, `desiredInvalid` з цим об'єктом і відповідний `desiredFingerprint`
  → `committed`.

`build-plan.db.test.ts`:

- план, чий бажаний стан дійсний, несе `desiredInvalid: []`;
- тест підключення: `dbs.reader`, що обгортає справжній і на запиті
  `readInvalidObjects` до бажаної тіні повертає один рядок, → артефакт
  несе цей рядок у `desiredInvalid` (доводить, що поле читається з тіні).

`artifact.test.ts`: без поля → `reason: "invalid"`.

- [ ] **Step 2: Запустити — червоне**

Run: `pnpm test:db`
Expected: FAIL у нових тестах.

- [ ] **Step 3: Реалізувати**

**Фаза 13** (`execute.ts`, після кроків середовища, до
`provePreservation`): `SET CONSTRAINTS ALL IMMEDIATE`. Не-повторна
`ApplyDbError` →
`stop("failed", "apply.deferred-constraint-failed", { sqlstate, error })`.

**`readInvalidObjects`** — один запит через `inCatalogPath`:

- обмеження таблиць і доменів схем межі з `NOT convalidated`;
- індекси з `NOT (indisvalid AND indisready)`;
- `ORDER BY 1 COLLATE "C"`.

**Фаза 16** (після ревалідації): різниця з `plan.desiredInvalid` →
`stop("failed", "apply.constraint-invalid", { objects })`.

**`plan.ts`:** у колбеку бажаної тіні (`buildPlan` і `planPromotion`) поруч
із `readOwners` — `readInvalidObjects(tx, scope)`. `ExecutablePlan`
отримує `desiredInvalid`.

- [ ] **Step 4: Зелене й коміт**

Run: typecheck обох пакетів, `pnpm --filter simetra test`, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "feat(schema): SET CONSTRAINTS ALL IMMEDIATE і перевірка недійсних обмежень та індексів перед кінцем транзакції"
```

### Task 4: Витяг у транзакції — можливість `ApplyTransaction`, діагностика до відкату

**Files:**
- Create: `packages/designer/src/schema-engine/savepoint-pool.ts`
- Create: `packages/designer/src/schema-engine/__tests__/savepoint-pool.test.ts`
- Create: `packages/designer/src/schema-engine/__tests__/savepoint-extract.db.test.ts`
- Modify: `packages/simetra/src/schema/apply/port.ts` (`ApplyTransaction.extract`)
- Modify: `packages/designer/src/schema-engine/apply-database.ts` (реалізація `extract`)
- Modify: `packages/designer/src/schema-engine/read-only.ts` (експорт помічників розбору: `readOnlyOption`, `afterBeginKeyword`, `textOf`, `withText`)
- Modify: `packages/designer/src/schema-engine/pg-delta/adapter.ts` (експорт `extractOnTransactionClient`)
- Modify: `packages/simetra/src/schema/apply/execute.ts` (фаза 17: шляхи в `apply.verify-failed`)
- Modify: `packages/simetra/src/compiler/messages.ts` (`apply.verify-failed` з `paths`)
- Modify (фейкові порти): `execute.test.ts` та інші реалізації `ApplyTransaction`, які назве typecheck

**Interfaces:**
- Consumes: `extractFrom(pool, scope)` (`adapter.ts`, внутрішній), `readOnlyQuery`, помічники `read-only.ts`.
- Produces:
  - `ApplyTransaction.extract(scope: EngineScope): Promise<Extracted>` — у T2-порті, з JSDoc: витяг двигуна в точці збереження цієї транзакції, без стану поза нею;
  - `vetSavepointQuery(text: string, inSavepoint: boolean, parse: SqlParser): { ok: true; text: string; inSavepoint: boolean } | { ok: false; reason: string }`;
  - `savepointPool(client: pg.PoolClient, parse: SqlParser, trace?: string[]): pg.Pool` (`trace` збирає пари «оригінал → підміна»);
  - `extractOnTransactionClient(client: pg.PoolClient, scope: EngineScope, trace?: string[]): Promise<Extracted>` (`adapter.ts`).

- [ ] **Step 1: Юніт-тести сторожа (червоні)**

`savepoint-pool.test.ts`:

- `"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"` і
  `"BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"` поза точкою →
  `{ ok: true, text: "SAVEPOINT simetra_extract", inSavepoint: true }`;
- пакет `BEGIN …; SET LOCAL search_path TO 'pg_catalog'; SELECT version()`
  → підмінено лише перший оператор, решта тексту ціла;
- `"COMMIT"` і `"ROLLBACK"` у точці →
  `"ROLLBACK TO SAVEPOINT simetra_extract; RELEASE SAVEPOINT simetra_extract"`,
  `inSavepoint: false`;
- відмова:
  - `SELECT 1` поза точкою;
  - `SET search_path = x` (сесійний);
  - `SET LOCAL …` поза точкою;
  - `SET TRANSACTION …`;
  - `SELECT pg_export_snapshot()` (за іменем функції);
  - `INSERT`/`UPDATE`/`CREATE`;
  - `SELECT … FOR UPDATE`, `SELECT … INTO`;
  - `BEGIN` у точці;
  - `COMMIT AND CHAIN`;
  - `PREPARE`, `SAVEPOINT x`, `RELEASE x`.

- [ ] **Step 2: Запустити — червоне**

Run: `pnpm --filter @simetra/designer test savepoint-pool`
Expected: FAIL.

- [ ] **Step 3: Реалізувати сторож, пул і витяг**

`vetSavepointQuery`:

- підміна — за позиціями операторів дерева розбору, не регуляркою;
- кожен оператор пакета перевіряється;
- помічники розбору й форма відповіді — як `vetTargetQuery`.

`savepointPool` — рішення 8. Нові об'єкти клієнта й пулу; транзакційний
`PoolClient` не мутується. Відмова сторожа — `Error` з причиною (форма
колбека — як `guard` у `read-only.ts`).

`extractOnTransactionClient`:
`try { return await extractFrom(savepointPool(client, parse, trace), scope) } finally { …закрити точку, якщо відкрита… }`.

`createApplyDatabase` в обох режимах:

- `tx.extract = (scope) => extractOnTransactionClient(client, scope)`;
- помилки — через `normalize`;
- `ApplyConnectionLost` ставить `lost = true`.

- [ ] **Step 4: DB-тести витягу (спайк С5 як тест)**

`savepoint-extract.db.test.ts`:

- `"extracts the uncommitted catalog without leaving a trace"`:
  - ціль і бажана база — через `engine.withDesiredShadow`, як `inTarget`;
  - у транзакції порту — перейменування колонки й `CREATE OR REPLACE
    FUNCTION` бажаного тіла;
  - до й після `tx.extract(scope)` читаються txid, `search_path`,
    `statement_timeout`, тимчасові об'єкти, `pg_prepared_statements`,
    `pg_locks` — рівні;
  - `engine.plan(витяг.catalog, бажана.catalog, scope).actions` порожній;
  - після відкату колонка має старе ім'я.
- `"keeps the transaction usable"`:
  - після `tx.extract` наступний DDL раннера проходить;
  - транзакція комітиться;
  - `pool.end()` завершується (тест із тайм-аутом vitest).
- `"rewrites exactly the engine's control statements"`:
  - `trace` дорівнює фактичній послідовності, яку дає pg-delta
    1.0.0-alpha.56 разом із читаннями `readOnlyQuery` адаптера
    (зафіксувати як літерал);
  - зміна двигуна ламає тест — так задумано (рішення 8).
- `"closes the savepoint when the engine fails inside it"`: витяг з
  `scope`, що змушує помилку всередині точки (або ін'єкцією помилки в
  `trace`-пул), → виняток, а транзакція далі приймає запит.

- [ ] **Step 5: Діагностика до відкату**

Фаза 17: розбіжність відбитка в режимах `apply` і `rehearse`:

1. `tx.extract(plan.scope)`;
2. `diffCatalogModels(plan.resultCatalog, витяг.model)`;
3. `paths`:
   - перші 20 шляхів через `, ` (з `…`);
   - порожньо — `"(the catalog model shows no difference)"`;
   - виняток витягу — `"(the diagnostic extract failed: <message>)"`.

Повідомлення `apply.verify-failed` en/uk називає `paths`.

Тести:

- `execute-plan.db.test.ts`:
  `"names the differing catalog paths before it rolls back"` — план із
  навмисно хибним `desiredFingerprint` і `resultCatalog`, що не має
  створеної кроком колонки → `apply.verify-failed`, `paths` містить шлях
  цієї колонки, ціль без змін;
- `execute.test.ts`: `"keeps verify-failed when the diagnostic extract fails"`
  — фейковий `tx.extract` кидає → `apply.verify-failed`, `paths` каже про
  збій витягу.

- [ ] **Step 6: Зелене й коміт**

Run: typecheck обох пакетів, `pnpm --filter @simetra/designer test`, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "feat(schema): витяг двигуна в транзакції застосування на точці збереження, діагностика розбіжності до відкату"
```

### Task 5: Повний доказ двигуна на репетиції

**Files:**
- Modify: `packages/simetra/src/schema/apply/execute.ts` (`ExecuteOptions` — об'єднання, фаза 18)
- Modify: `packages/simetra/src/schema/apply/index.ts` (експорт `RehearsalProof`)
- Modify: `packages/designer/src/tools/apply-tools.ts` (`applyTool`: бажана тінь для `rehearse`; опис інструмента)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts` (`apply.rehearsal-proof-failed`)
- Modify (усі виклики `rehearse`): `packages/simetra/src/schema/apply/__tests__/execute.test.ts`, `packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts`, `packages/designer/src/schema-engine/__tests__/build-plan.db.test.ts`, `packages/designer/src/__tests__/promotion-lifecycle.db.test.ts`, `packages/designer/src/__tests__/apply-tools.db.test.ts`

**Interfaces:**
- Consumes: `ApplyTransaction.extract` (задача 4), `SchemaEngine.plan`, `desiredForApply`, `engine.withDesiredShadow`.
- Produces:
  - `interface RehearsalProof { engine: Pick<SchemaEngine, "plan">; desired: EngineCatalog }`;
  - `ExecuteOptions = ExecuteBase & ({ mode: "apply" | "proof" } | { mode: "rehearse"; rehearsal: RehearsalProof })`, де `ExecuteBase` — нинішні поля без `mode`.

- [ ] **Step 1: Тести (червоні)**

Правило для наявних викликів `rehearse` у тестах:

- фейкові порти й DB-тести, що не перевіряють сам доказ, — заглушка
  `stubRehearsal: RehearsalProof`. Її `engine.plan` повертає
  `{ actions: [], empty: true, preamble: [], diagnostics: [] }`, а
  `desired` — будь-який каталог;
- `build-plan.db.test.ts` бере бажаний каталог з
  `engine.withDesiredShadow`.

Нові тести:

- `execute-plan.db.test.ts`, помічник
  `desiredCatalog(setup, steps): Promise<EngineCatalog>` (`inTarget` +
  `engine.extract`):
  - `"proves the rehearsal on the same connection"`: справжній бажаний
    каталог → `rolledBack`;
  - `"refuses a rehearsal whose result differs from the desired state"`:
    `desired` від бази без кроку → `failed`, `apply.rehearsal-proof-failed`
    (`count ≥ 1`, `first` — SQL дії).
- `apply-tools.db.test.ts`:
  - `rehearse: true` будує тінь і проходить;
  - фейковий двигун, чий `withDesiredShadow` дає `shadow-failed` → відмова
    з діагностиками тіні, `executePlan` не викликано.

- [ ] **Step 2: Запустити — червоне**

Run: `pnpm --filter simetra typecheck`
Expected: FAIL на викликах `rehearse` без `rehearsal` — так і має бути.

- [ ] **Step 3: Реалізувати**

Фаза 18 (лише `rehearse`, після фази 17):

```ts
const after = await tx.extract(plan.scope)
const rest = o.rehearsal.engine.plan(after.catalog, o.rehearsal.desired, plan.scope)
```

Помилки `rest.diagnostics` рівня `error` чи дії →
`stop("failed", "apply.rehearsal-proof-failed", { count, first })`.

`applyTool`, гілка `rehearse` — у колбеку `withDatabase`, де є `db.target`
і `db.shadowBase`, до `executePlan`:

1. `desiredForApply(model)`;
2. `engine.withDesiredShadow({ target: db.target, ...(db.shadowBase ? { shadowBase: db.shadowBase } : {}) }, desired.sql, artifact.scope, (db) => engine.extract(db, artifact.scope))`;
3. `shadow-failed` → `refusedWith` діагностик тіні;
4. `rehearsal: { engine, desired: shadow.value.catalog }`.

Опис інструмента `apply` доповнити: репетиція ще й будує бажану тінь і
доводить стан тим самим з'єднанням.

- [ ] **Step 4: Зелене й коміт**

Run: typecheck обох пакетів, `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "feat(schema): репетиція доводить бажаний стан витягом двигуна на тому самому з'єднанні"
```

### Task 6: Вхідні FK між `plan` і `apply`

**Files:**
- Modify: `packages/simetra/src/schema/apply/plan.ts` (`lockPlan` повертає `foreignKeys`)
- Modify: `packages/simetra/src/schema/apply/artifact.ts` (поле `foreignKeys`)
- Modify: `packages/simetra/src/schema/apply/execute.ts` (фаза 4; `ExecutablePlan` + `foreignKeys`)
- Modify (тести, що ламає поле): ті самі файли літералів плану (Global Constraints)
- Test: `execute-plan.db.test.ts`, `build-plan.db.test.ts`, `execute.test.ts`, `artifact.test.ts`

**Interfaces:**
- Consumes: `readLiveForeignKeys`, `footprintSubjects`, `LiveForeignKey` (`locks.ts`).
- Produces: `PlanArtifact.foreignKeys: { subjects: { schema: string; name: string }[]; live: LiveForeignKey[] }`.

- [ ] **Step 1: Тести (червоні)**

- `execute-plan.db.test.ts`,
  `"refuses when a foreign key outside the scope appeared after the plan"`:
  - setup — `app.t(id int primary key)` і схема `other` поза межею;
  - план: крок `ALTER TABLE app.t ALTER COLUMN id TYPE bigint`;
    `foreignKeys` прочитано `readLiveForeignKeys` до зміни;
  - між планом і застосуванням —
    `create table other.r (t int references app.t)`;
  - → `refused`, `apply.target-changed` з `sections: "foreignKeys"`;
    кроків не виконано.
- `"applies when the foreign keys are as planned"`: той самий план без
  нового FK → `committed`.
- `build-plan.db.test.ts`:
  - план зі зміною типу колонки, на яку посилається FK поза межею, несе
    цей FK у `foreignKeys.live`;
  - план без кроків з FK — `foreignKeys: { subjects: [], live: [] }`.
- `execute.test.ts`: режим `proof` звірки не робить (у журналі немає
  запиту FK).
- `artifact.test.ts`: без поля → `reason: "invalid"`.

- [ ] **Step 2: Запустити — червоне**

Run: `pnpm --filter simetra test execute artifact`
Expected: FAIL.

- [ ] **Step 3: Реалізувати**

`lockPlan` повертає `foreignKeys: { subjects: footprintSubjects(…), live }`.
Цей самий `live` він уже читає. Обидва — в артефакт і план доказу.

Фаза 4 (не `proof`, після `providerLocks`, до замків): `subjects` не
порожній → `readLiveForeignKeys(tx, plan.foreignKeys.subjects)`.
`JSON.stringify` ≠ плановому →
`stop("refused", "apply.target-changed", { sections: "foreignKeys" })`.

- [ ] **Step 4: Зелене й коміт**

Run: typecheck обох пакетів, `pnpm --filter simetra test`, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "fix(schema): застосування звіряє FK сліду з планом до блокувань — FK поза межею, доданий після плану, дає target-changed"
```

### Task 7: Дрібний борг 2a — тимчасові імена, помилки замірів, гілка «до 17»

**Files:**
- Create: `packages/simetra/src/schema/apply/promotion/reserved-names.ts`
- Modify: `packages/simetra/src/schema/apply/promotion/index.ts` (експорт)
- Modify: `packages/simetra/src/schema/apply/plan.ts` (`analyseOnClone`: параметр `oldTables`, перевірка до наміру)
- Modify: `packages/simetra/src/schema/apply/execute.ts` (`measure`, `measureBefore`)
- Modify: `packages/simetra/src/schema/apply/locks.ts` (`lockRightsSql()` без версії, `readLockRights`)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `packages/simetra/src/compiler/messages.ts` (`plan.temp-name-taken`, `apply.preservation-measure-failed`)
- Test: `packages/simetra/src/schema/apply/__tests__/locks.test.ts`, `execute.test.ts`, `execute-plan.db.test.ts`, `build-plan.db.test.ts`

**Interfaces:**
- Produces:
  - `readReservedNames(tx: ApplyTransaction, p: { schemas: readonly string[]; tables: readonly { schema: string; name: string }[] }): Promise<string[]>` — рішення 11, відсортовані, з видом об'єкта (`relation app.simetra_tmp_1`, `type …`, `column app.items.simetra_tmp_1`, `constraint …`);
  - `lockRightsSql(): string`.

- [ ] **Step 1: Тести (червоні)**

- `build-plan.db.test.ts`, `describe("reserved temporary names")` —
  прийнята таблиця одиниці з:
  - колонкою `simetra_tmp_1`;
  - сусідньою таблицею `simetra_tmp_1` у схемі одиниці;
  - типом `simetra_retired_2` у схемі одиниці;
  - обмеженням `simetra_tmp_3` на таблиці одиниці.

  Кожен випадок — `refused`, `plan.temp-name-taken`, `names` містить
  об'єкт (а не сира `42701`/`42P07` з копії).
- `execute.test.ts` (фейковий порт):
  - `"names a measurement error that is not a cast failure"` — замір «до»
    кидає `ApplyDbError(…, "42P01")` → `failed`,
    `apply.preservation-measure-failed` з `table`, `side: "before"`,
    `sqlstate: "42P01"`;
  - те саме для заміру «після» (`side: "after"`), зокрема для класу `22`:
    після кроків зміни типу вже немає, тож і звуження назвати нічим;
  - клас `22` у замірі «до» і далі дає `apply.type-narrowing`;
  - повторювана помилка (`55P03`) летить далі як є.
- `locks.test.ts`: `lockRightsSql()` не містить `pg_inherits` і `RECURSIVE`.
- `execute-plan.db.test.ts`: тест
  `"requires the right on every descendant for an explicit LOCK before PostgreSQL 17"`
  замінити на
  `"needs the right on the table itself only, its children are locked with it"`:
  - `LOCKER` має `update` лише на `app.it` → `lockable` = `true`;
  - `LOCK TABLE` без `ONLY` від `LOCKER` проходить і займає `app.it_child`.

- [ ] **Step 2: Запустити — червоне**

Run: `pnpm --filter simetra test locks execute`
Expected: FAIL.

- [ ] **Step 3: Реалізувати**

- `analyseOnClone` отримує `oldTables`. До `runOnClone(… renames)` кличе
  `readReservedNames` на копії для схем і старих імен таблиць одиниці.
  Результат не порожній →
  `{ ok: false, diagnostics: [plan.temp-name-taken { names }] }`.
- `measure`: не-повторна `ApplyDbError` →
  `stop("failed", "apply.preservation-measure-failed", { table, side, sqlstate, error })`.
  Виняток — клас `22` у `measureBefore`, що йде на проби приведення, як
  зараз. Гілка `measureBefore` «жодне приведення окремо не впало» — теж
  `preservation-measure-failed`.
- `lockRightsSql()` — гілка 17+ для всіх версій. `readLockRights` читає
  версію лише для `lockPrivileges`. Коментар — рішення 10 (виміряно на
  14.24, 15.19, 16.15).

- [ ] **Step 4: Зелене й коміт**

Run: typecheck обох пакетів, `pnpm --filter simetra test`, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "fix(schema): тимчасові імена наміру — діагностика плану, сирі помилки замірів — код, право на LOCK лише на самій таблиці"
```

### Task 8: Документи й фінальні гейти

**Files:**
- Modify: `docs/architecture/designer.md` (розділ про `apply`)
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` (абзац про `rehearse`)
- Modify: `docs/superpowers/plans/2026-10-13-p3-2b-1-pre-commit-guarantees.md` (рішення, ухвалені під час виконання)

- [ ] **Step 1: Документи**

- `designer.md`:
  - `apply` ревалідує тіла функцій і перевіряє `plpgsql_check` (режим — у
    виводі `plan`);
  - репетиція будує бажану тінь і доводить стан тим самим з'єднанням;
  - посилання на спеку промоції §7.2.
- Скіл:
  - речення про `rehearse` (тінь, повний доказ);
  - попередження `apply.function-check-blind`;
  - рядок про відмову `COMMIT` промоції лишається до П3-2b-2.

  Перевірка — `skill-examples.test.ts`.

- [ ] **Step 2: Фінальні гейти**

Run:

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`;
- `pnpm metadata:check`;
- `python3 scripts/check-doc-anchors.py`;
- `pnpm test:db`.

Expected: усе зелене. Число тіней (`pgdelta_shadow_%`) і ролей стеку після
прогону — як до.

- [ ] **Step 3: Коміт**

```bash
git add docs packages/designer/skills
git commit -m "docs(designer): ревалідація тіл, plpgsql_check і доказ на репетиції"
```

- [ ] **Step 4: Звіт архітекторові**

Фінальний звіт `consumer-reconciliation2` має містити:

- діапазон комітів;
- рішення, ухвалені під час виконання;
- відкладені дрібниці;
- що лишається для П3-2b-2.

Не пушити.
