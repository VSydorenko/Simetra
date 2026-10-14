# П3-2b-2 — кроки даних промоції: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** промоція з кроками `fill` (спека промоції §4) планується, доводиться
на копії й репетирується на цілі:

1. значення обчислюються в старих іменах у тимчасові таблиці транзакції,
   колонка-ціль з'являється кроком наміру, значення записуються до кроків
   двигуна з вимкненими тригерами користувача;
2. кроки даних і заміри збереження йдуть під закріпленими налаштуваннями
   (`DATA_SETTINGS`), а збереження цілей `fill` доводиться за виразом мапінгу;
3. відмову `plan.promotion-unsupported` з `reason: "dataSteps"` знято, ремонт
   наявних значень дозволяє пункт `repair:<таблиця>`;
4. закрито борг тестів 2b-1 і здешевлено DB-тести раннера.

Застосування промоції з `COMMIT` і далі відмовляє
(`apply.promotion-checks-pending`): звіт репетиції й зняття відмови — план
[П3-2b-3](2026-10-14-p3-2b-3-rehearsal-report-commit.md).

**Архітектура:**

- **T2 `packages/simetra/src/schema/apply/`** — весь алгоритм. Нові модулі:
  - `promotion/data.ts` — секція кроків даних, її побудова з запису й рендер
    SQL обчислення, запису й тригерів;
  - `settings.ts` отримує `DATA_SETTINGS`.
- **T1 `packages/simetra/src/compiler/operations/promote/fill.ts`** — вивід
  викликів виразу для T2 і вирівнювання функцій часу до спеки.
- **`@simetra/designer`** — лише показ секції, дозвіл `repair:` у вході
  `apply` і тести. `pg` і pg-delta в `simetra` не з'являються.

**Технології:** TypeScript 7, Zod 4, Vitest; `libpg-query` через
`loadSqlParser`; `@supabase/pg-delta` 1.0.0-alpha.56 без змін версії,
`renames: "off"`; локальний стек Supabase (Postgres 17.6).

**Спека:**

- [спека промоції](../specs/2026-10-06-promotion-design.md): §4 (мапінг,
  `fill`, детермінованість), §7.2 («Порядок транзакції», «Закріплені
  налаштування даних», «Перевірки перед `COMMIT`»), §8 («Дозволи»,
  «Репетиція з даними»), §9.6;
- [платформна спека](../specs/2026-09-24-simetra-platform-design.md): §6.2
  п.3–4, §6.6, §6.9, §6.10.

Задача 1 вносить правки спек для цього плану й для П3-2b-3 одним
docs-комітом.

**Плани, на яких стоїть цей:**

- [П3-1](2026-10-11-p3-1-apply-core.md): рішення 9, 11, 14;
- [П3-2a](2026-10-12-p3-2a-promotion-intent.md): рішення 2, 5, 6, 8, 11;
- [план 4 промоції](2026-10-10-promotion-4-promote-mapping-rewriter.md):
  рішення 12 (`fill` і контракт налаштувань);
- [П3-2b-1](2026-10-13-p3-2b-1-pre-commit-guarantees.md): рішення 1 (фази),
  2 (`withLocalSettings`), R1–R9.

**Передумова:** П3-2b-1 прийнято; локальний стек (`pnpm db:start`); на
checkout комітить одна сесія.

**Архітектор задачі:** сесія `consumer-reconciliation2`. До неї через
`SendMessage` ідуть розвилки поза «Рішеннями плану». Якщо сесії немає — до
власника.

**Поза планом (свідомо):**

- **П3-2b-3:** звіт репетиції, факти сервера й голова ledger, відбиток без
  власників на репетиції, `apply.rehearsal-required`, `statement_timeout`
  зі звіту, зняття `apply.promotion-checks-pending` і
  `plan.promotion-commit-pending`, наскрізний тест повного циклу.
- **П3-3:** політики й тригери підписок, лічильники нумерації, переклад
  міток, динамічний гейт доступу.
- **П3-4:** фази «розширити → звузити».
- **Окремий план:** зворотне читання боргу з тіні, затінення імен у
  `search_path`.
- **Решта:** підплан регістрів, шлях запису (Пр21), нетранзакційні кроки,
  `ALTER … OWNER TO`, беклог метамоделі, копія доказу під іншою роллю,
  апстрім-issue pg-delta, реальна база споживача.

## Global Constraints

- 🔴 **Розбіжність спеки з кодом — стоп.** Поведінка поза рішеннями нижче —
  стоп і звіт архітекторові. Кожне рішення під час виконання має поле
  «вплив на спеку» («немає» або § із правкою); погоджене відхилення
  приходить разом із правкою спеки тим самим блоком роботи.
- 🔴 **Зона рушія:** production-код `packages/simetra` не імпортує `pg` чи
  `@supabase/pg-delta` (`packages/simetra/eslint.tier-zones.js`, тест
  `packages/simetra/test/tier-boundary.test.ts`). Імпорти — лише вниз.
- 🔴 **Жодного стану поза транзакцією на цілі:** налаштування — лише
  `set_config(…, true)`; жоден **наш** об'єкт у `pg_temp` не переживає
  транзакцію (тимчасові таблиці — `ON COMMIT DROP`).
- 🔴 **`DROP … CASCADE` — ніколи.** `renames: "off"` в адаптері не
  змінюється.
- 🔴 **Ідентичність — UUID, а не ім'я**; посилання на об'єкти двигуна —
  структурні (`EngineObjectRef`), без розбору рядкових StableId.
- 🔴 **Кожен гейт і кожна відмова мають негативний тест**, а підключення
  гейта до конвеєра — тест на рівні конвеєра.
- Хибна відмова допустима, мовчазна втрата — ні.
- Нове правило діагностики — рядок у `COMPILER_RULES`
  (`packages/simetra/src/compiler/diagnostics.ts`) і тексти en/uk (+ hint) у
  `packages/simetra/src/compiler/messages.ts`. Рівня `info` немає.
- Артефакт плану — детермінований канонічний JSON без часу; `PLAN_FORMAT`
  лишається `3` (рішення 12 плану 2b-1: релізу між планами П3-2b немає).
- Тестові файли, які ламає нове обов'язкове поле, входять у коміт задачі, що
  його додає. Літерали плану є, зокрема, у:
  - `packages/simetra/src/schema/apply/__tests__/execute.test.ts`;
  - `packages/simetra/src/schema/apply/__tests__/artifact.test.ts`;
  - `packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts`;
  - `packages/designer/src/schema-engine/__tests__/read-only.db.test.ts`;
  - `packages/designer/src/__tests__/apply-outcome.test.ts`.

  Повний перелік дає typecheck.
- Кожна задача закінчується зеленим `pnpm --filter <пакет> typecheck` для
  змінених пакетів; зміна T2 запускає й typecheck `@simetra/designer`.
- Без шимів; коментарі — українською, «чому»; 🔴 без `--` перед шаблоном
  vitest; коміти — Conventional Commits українською, без трейлерів.
- DB-тести — `*.db.test.ts`, лише `pnpm db:*` / `pnpm test:db`; кожна ціль —
  окрема база (`inTarget`); тест нічого не лишає, зокрема на шляху падіння;
  чужих об'єктів стеку не видаляти — сиріт називати архітекторові. Не
  запускати гейти, поки інший агент редагує checkout.
- Тексти для споживача — англійською, стисло. Репо публічне: синтетичні
  імена й дані.

## Review Focus

1. **Вираз `fill` з віконною функцією** (`row_number() over (order by id)`).
   Замір «до» загортає вираз в агрегат, а віконна функція в агрегаті
   Postgres заборонена. Очікування: замір рахує вирази в підзапиті, і
   промоція проходить репетицію. Тест — задача 4.
2. **Колонка-ціль має відкладений FK, і запис його порушує** (ремонт пише
   посилання на неіснуючий рядок). Очікування:
   `apply.deferred-constraint-failed` з `after: "data"` одразу після запису,
   а не `55006 pending trigger events` на наступному кроці двигуна. Тест —
   задача 5.
3. **Таблиця з тригером `ENABLE ALWAYS`.** Очікування: на час запису тригер
   вимкнено, після — він знову `A`, а не `O`. Тест — задача 5.
4. **За пулером на backend лишилась сесійна тимчасова таблиця
   `simetra_fill_1` попереднього клієнта.** Очікування: `apply.temp-name-taken`
   до будь-якого запису, а не чужі рядки в обчисленні чи сирий `42P07`.
   Тест — задача 5.
5. **Ціль `fill` — колонка зі зміною `text → jsonb`, що нормалізує текст.**
   Без кроку даних сторож звуження відмовляє. Очікування: ремонт
   `content::jsonb` пише нормалізований текст до кроку двигуна, і сторож
   його пропускає. Тест — задача 6.

## Рішення плану

Розвилки вирішив архітектор задачі (сесія `consumer-reconciliation2`)
2026-10-14 за спайком автора на локальному стеку (PG 17.6, роль `postgres`
без суперкористувача, з `BYPASSRLS`). Напрям п'яти правок спеки погодив
власник; точний текст — задача 1.

1. **Фази транзакції.** Таблиця рішення 1 плану 2b-1 змінюється так (решта
   фаз — як є):

   | # | Фаза | Режими | Налаштування |
   | --- | --- | --- | --- |
   | 6a | заміри «до»: кожна таблиця одиниці, цілі `fill` — за виразом | усі | **даних** |
   | 8 | **НОВЕ** обчислення: на таблицю — перевірка імені `pg_temp.simetra_fill_<n>`, CTAS у старих іменах, лічильник обчислених | усі | **даних** |
   | 9 | кроки наміру; **НОВЕ** `ADD COLUMN` незмаплених цілей | усі | транзакції |
   | 10 | **НОВЕ** запис: на таблицю — звірка тригерів, `DISABLE TRIGGER` поштучно, один `UPDATE`, лічильник записаних = обчисленим, `ENABLE [ALWAYS] TRIGGER`; потім `SET CONSTRAINTS ALL IMMEDIATE` — лише коли секція `data` не порожня | усі | **даних** |
   | 13 | `SET CONSTRAINTS ALL IMMEDIATE` (параметр `after: "steps"`) | усі | транзакції |
   | 14 | заміри «після» | усі | **даних** |

   - **Одна тимчасова таблиця й один `UPDATE` на таблицю**, а не на крок:
     кожен `UPDATE` пише нову версію рядка, тож N кроків дали б N переписувань
     і N-кратне роздуття heap. Кроки однієї таблиці в одному `SELECT`
     однаково бачать вихідний рядок.
   - **Тип у CTAS — бажаний тип цілі** (`(<вираз>)::<тип>`): збій приведення
     ловиться до запису (вже заміром 6a).
   - **Змаплена ціль зі зміною типу** у фазі 10 ще має старий тип: зміна
     типу — крок двигуна фази 11. Запис робить друге, неявне приведення
     «бажаний → старий» за правилами присвоєння. Воно точне лише тоді, коли
     старий тип — рядковий без межі (`text`, `varchar` без довжини):
     текстова форма значення бажаного типу, а двигун потім приводить її
     туди. Тому крок даних на змаплену ціль зі зміною типу, чий старий тип
     не `text`/`varchar` без межі, — відмова `plan.promotion-unsupported`
     (`reason: "dataStepType"`). Хибна відмова допустима, хибна
     `apply.preservation-failed` з оманливою підказкою — ні. Обидві форми
     свідомої конверсії (`text → jsonb`, `text → varchar(n)`) під правило
     підпадають.
   - **Рендер виразу з переводом рядка** — `(\n<вираз>\n)` у
     `dataComputeSql`, `preservationQuery` і `castProbeQuery`: T1 розбирає
     `SELECT <вираз>\nFROM …` і пропускає вираз з коментарем `--`, а
     однорядковий рендер закоментував би решту оператора.
   - **Тригери звіряються перед вимкненням** (правка §7.2, погоджена): до
     запису нічого не змінено, а після вимкнення живий перелік уже `D`.
     Відбиток фази 6 уже покриває тригери з `tgenabled` (секція `triggers`
     у `fingerprint.ts`), тож це захисна звірка за спекою.
   - **`SET CONSTRAINTS ALL IMMEDIATE` фази 10** діє до кінця транзакції.
     Відновити «як було» неможливо: `ALL DEFERRED` відклав би й обмеження
     `INITIALLY IMMEDIATE`. Фаза 13 однаково робить те саме, а кроки двигуна
     — DDL без рядкових тригерів. Без нього наступний `ALTER TABLE` тієї
     самої таблиці падає `55006` (спайк С6).
   - **Помилка `SET CONSTRAINTS`** фаз 10 і 13 — код
     `apply.deferred-constraint-failed` з новим параметром `after: "data" |
     "steps"`; тексти — «відкладений тригер чи обмеження»: не-повторну
     помилку може кинути й тригер-обмеження користувача.
   - **Тимчасові таблиці** живуть до кінця транзакції. Перевірки фаз 15–18
     (`FUNCTION_SCOPE_SQL`, межа відбитка, витяг двигуна) тимчасових схем не
     бачать; звірка сліду (19a) — лише таблиці, що були до кроків (спайк С2).
     Тест фіксує обидва.
   - **Сторожі звуження фази 11 бачать уже записані значення.** Свідома
     конверсія типів, що нормалізують текст (`text → jsonb`), і обрізання
     ремонтом (`left(code, 20)` перед `varchar(20)`) — природний наслідок
     порядку, окремого коду немає; підказка `apply.type-narrowing` радить
     такий крок (задача 6).
2. **Форма: структурна секція `promotion.data`, SQL рендерить T2.**
   - Тип (у `promotion/data.ts`):

     ```ts
     interface DataTable {
       temp: string // simetra_fill_<n>
       before: { schema: string; table: string; key: string } // старі імена
       after: { schema: string; table: string; key: string } // нові імена
       columns: {
         step: string // d<N>
         column: string // нове ім'я цілі
         type: string // тип бажаного стану у формі record.typeChanges
         expression: string // старі імена
         kind: "repair" | "conversion" | "split" | "backfill"
       }[]
       triggers: { name: string; enabled: "O" | "A" }[] // за іменем
     }
     ```

   - Кроки даних — не `PlanStep`: між операторами є умови (звірка тригерів,
     рівність лічильників), а `PlanStep` — «виконати SQL як є». Рендер з
     полів — одне джерело правди для раннера й виводу `plan`.
   - Id — `d<N>` наскрізно в порядку `record.dataSteps`, окремий простір від
     `s<N>`.
   - `DATA_SETTINGS` у секцію не пишеться: це константа коду під
     `platformVersion` артефакту, і план іншої версії вже відхиляє гейт
     версій.
   - **T2 не вірить `record.dataSteps` на слово.** Поля `dataSteps` немає в
     звірці запису (`RECONCILED`, `transition.ts`), а від `kind` залежить
     дозвіл `repair:`: ремонт, записаний у файлі як `conversion`, пройшов би
     без дозволу. `dataPlan` для кожного кроку перевіряє: таблиця — з
     `record.tables` (старе ім'я), колонка — є в бажаній таблиці, вид —
     той самий, що виводить T1 (`recordedFillKind`, рішення 5). Розбіжність
     — `plan.promotion-record-mismatch` (`detail: "dataSteps"`).
   - **Оператор таблиці даних** (CTAS, `count`, `UPDATE`) іменується першим
     `d<N>` таблиці — так його називають слід замків, діагностики й звіт
     П3-2b-3.
   - **Вхідний FK з `ON UPDATE CASCADE | SET NULL | SET DEFAULT`** на
     колонку-ціль кроку (ремонт унікальної колонки, на яку посилаються)
     мовчки змінив би рядки поза замірами збереження — відмова
     `plan.promotion-unsupported` (`reason: "dataStepReferenced"`).
3. **Ремонт потребує дозволу `repair:<таблиця>`** (правка §4/§8, погоджена).
   - Пункт промоції на таблицю (нове ім'я), як `remove:`; `summary` — кожна
     ремонтована колонка з виразом: `"<колонка> ← <вираз>"`.
   - Конверсія, розщеплення й дозаповнення дозволу не потребують: наявних
     значень не змінюють.
   - Без дозволу — наявна відмова `apply.permission-required`, яка називає
     пункт. Група `repair:` іде після `remove:` у `PROMOTION_GROUPS`.
4. **Межі кроку — відмови плану** `plan.promotion-unsupported` з причиною,
   кожна з негативним тестом:
   - `reason: "dataStepTable"` — таблиця з нащадками за успадкуванням чи
     партиціонована (`UPDATE` без `ONLY` зачепив би нащадків з іншим ключем,
     а з `ONLY` замір без `ONLY` їх рахує; `DISABLE TRIGGER` рекурсує на
     партиції — спайк С7);
   - `reason: "dataStepType"` — тип колонки-цілі не існує у вихідному стані
     цілі (`to_regtype` — `NULL`) або його створює, змінює чи знищує крок
     плану (`produced`/`destroyed` з видом типу чи домену й тим самим
     ім'ям). Фази 8–9 ідуть до кроків двигуна, тож інакше — сирий `42704`;
   - `reason: "dataStepKey"` — ключ кроку не є одноколонковим первинним
     ключем таблиці у вихідному стані, або колонка цього ключа сама є ціллю
     `fill`, вилучається чи змінює тип. `after.key` — образ того самого
     первинного ключа після перейменувань.
5. **Детермінованість на `plan`.** Запис T1 її вже довів проти знімка
   функцій, але ціль — інший сервер:
   - **функції каталогу** виразу — на цілі в `READ ONLY` усі перевантаження
     `IMMUTABLE` і не множини, інакше `plan.data-step-volatile` (`step`,
     `function`). Функції часу транзакції (`NOW_FUNCTIONS` T1, експорт) з
     перевірки виключено: вони `STABLE`, і спека §4 дозволяє їх поза
     ремонтом, а T1 це вже перевірив;
   - **функції моделі** — є у вихідному стані цілі з `provolatile = 'i'`, і
     жоден крок плану їх не створює, не змінює й не знищує (за
     `produced`/`destroyed` з видом функції, схемою й ім'ям), інакше
     `plan.data-step-function-changed` (`step`, `function`). Збіг — за видом
     `function`, схемою й ім'ям без сигнатури: будь-яке перевантаження з
     тим самим ім'ям, змінене планом, — відмова (хибна відмова допустима).
     Форму `name` у `EngineObjectRef` функції від адаптера виконавець
     звіряє в задачі 0; якщо там сигнатура — зняти її розбором дужок не
     можна, стоп і питання архітекторові. Обчислення йде у
     фазі 8, до кроків двигуна, тобто старим тілом; замір «до» — теж старим,
     тож збереження «пройде», а значення пораховані не тим тілом;
   - **лише прямі виклики.** Транзитивний виклик (функція моделі викликає
     функцію, яку змінює план) — у «Відомих обмеженнях». Перевірку через
     `plpgsql_check_dependency_tb` відхилено: функції моделі в `fill`
     мусять бути `IMMUTABLE`, а це майже завжди мова `sql`, якої
     `plpgsql_check` не аналізує; і він не бачить динамічного SQL. Часткова
     перевірка дала б хибне відчуття повноти, а не гарантію;
   - **розбір викликів** — експорти T1, без другого обходу дерева в T2:
     `fillCalls` (лише збирає виклики `FuncCall`, без перевірок: обхід
     `ExpressionWalker` зупиняється на першій проблемі) і
     `recordedFillKind` (вид кроку з запису тим самим `fillStepKind`, що й
     `promote`);
   - **дві точки в `planPromotion`.** До копії (після `renameIntent`, окремою
     транзакцією `READ ONLY` цілі) — факти: нащадки, `to_regtype` цілей,
     `TEMP`, функції каталогу й моделі, вхідні FK; відмови з них — до
     `analyseOnClone`, тож `ADD COLUMN` з відсутнім типом ніколи не падає
     сирим `42704` на копії. Після `analyseOnClone` — лише те, що потребує
     кроків двигуна: `produced`/`destroyed` функцій і типів;
   - **`statement_timestamp()`** прибирається з функцій часу транзакції T1
     (`NOW_FUNCTIONS` → `VOLATILE_NAMES`): спека §4 дозволяє лише час
     транзакції, а замір «до» (6a) і обчислення (8) — різні оператори, тож
     вираз із ним дав би хибну `apply.preservation-failed`. Вплив на спеку:
     немає (код вирівнюється до спеки).
6. **Право `TEMP`.** План із кроками даних читає
   `has_database_privilege(current_database(), 'TEMP')` на цілі в `READ
   ONLY`; ні → `plan.temp-privilege` (`role`). Без права CTAS дає `42501`
   (спайк С3).
7. **Тимчасові таблиці** (спайк С1–С4):
   - ім'я `simetra_fill_<n>`, `n` — порядок таблиці в `record.tables` серед
     тих, що мають кроки даних, від 1; детерміноване, під `planHash`;
   - створення — `CREATE TEMP TABLE <ім'я> ON COMMIT DROP AS SELECT …`, читання
     — `pg_temp.<ім'я>` повністю кваліфіковано;
   - перед CTAS — `to_regclass('pg_temp.<ім'я>') IS NULL`, інакше
     `apply.temp-name-taken` (`name`). За пулером сесійна тимчасова таблиця
     попереднього клієнта на тому самому backend реальна (спайк С4);
   - шаблон `^simetra_(tmp|retired)_[0-9]+$` плану 2b-1 сюди не додається:
     той шукає імена в схемах одиниці на копії, а це — `pg_temp` власного
     backend.
8. **Заміри за виразом мапінгу.**
   - Колонка-ціль `fill` у `PreservedTable.columns`: `before` —
     `((<вираз>)::<тип>)`, `after` — нове ім'я колонки, нове поле
     `dataStep: "d<N>"`. Для змапленої цілі цей запис замінює звичайний; для
     незмапленої — додається.
   - `preservationQuery` рахує вирази в підзапиті для обох боків: `SELECT
     count(*) AS rows, sum(…k…x0…) AS c0, … FROM (SELECT <key> AS k, <e0> AS
     x0, … FROM <таблиця>) AS s`. Віконна функція в агрегаті заборонена
     (спайк С9), а єдина форма для всіх колонок не дає двох шляхів.
   - `castProbeQuery` — та сама форма з підзапитом (`SELECT count(x) FROM
     (SELECT (\n<вираз>\n) AS x FROM <таблиця>) AS s`): інакше проба
     віконної колонки дає `42803`, а не клас `22`, і ховає справжню
     колонку зі звуженням.
   - Набір проб `measureBefore` — колонки з `typeChangeStep` ∪ колонки з
     `dataStep`. Клас `22` у пробі колонки з `dataStep` —
     `apply.data-step-failed` з `step` (вираз і є конверсією), у пробі з
     `typeChangeStep` — як є `apply.type-narrowing`; інший SQLSTATE —
     `apply.preservation-measure-failed`.
   - Під `DATA_SETTINGS` — і заміри без кроків даних: текстова форма значень
     однаково залежить від налаштувань.
9. **`DATA_SETTINGS`** — один перелік у `settings.ts` з посиланням на спеку
   §7.2 «Закріплені налаштування даних», без копії обґрунтувань. Тест
   звіряє перелік із маркованим списком спеки (читання файлу спеки в тесті —
   Node дозволено в тестах).
10. **Тестова інфраструктура** (вердикт архітектора).
    - Сторож тіней `round-trip.db.test.ts` і `stack-guard.ts` — різні
      гарантії: перший приписує тінь тесту й прибирає її й на шляху
      падіння, другий — інваріант прогону, що лише виявляє. Дубль — лише
      знання про ім'я тіні: одне джерело правди в
      `packages/simetra/test/db/connection.ts` (`SHADOW_PREFIX`,
      `shadowAgeMinutes`). Нерозпізнане ім'я — «вік невідомий»
      (`undefined`), а не «старе».
    - Бажаний відбиток у тестах раннера — у тій самій базі-цілі: `BEGIN;
      <кроки>; readFingerprint; ROLLBACK` перед `executePlan`, а не окрема
      база. Тести, що доводять `apply.verify-failed`, лишаються зі свідомо
      іншим бажаним станом, щоб відмова не стала тавтологією.
11. **Триаж дрібниць 2b-1** (вердикт архітектора):
    - беремо: тест читання `desiredInvalid` з тіні в `planPromotion`; текст
      фази 13; тест «builds the desired shadow», що падає без тіні; uk-текст
      `apply.rehearsal-proof-failed` і коментар до `errors[0]!`; тест «обрив
      під час `tx.extract` позначає з'єднання втраченим»; DB-тести
      `apply.plpgsql-check-unavailable`, `apply.preservation-measure-failed`
      і секції `plpgsqlCheck`;
    - не беремо: тест «invalid before result fingerprint» (порядок уже
      пришпилено іншим тестом); «текстовий об'єкт запиту без тексту →
      OUTSIDE» (pg-delta такого не шле, сторож відмовляє — безпечно);
      `afterEach DROP … WITH (FORCE)` під час тіла тесту за тайм-аутом
      (давнє, 2b-2 не зачіпає).

### Рішення під час виконання

(порожньо — заповнює виконавець; кожне з полем «вплив на спеку»)

## Відомі обмеження

Кожне — безпечна відмова чи явний дозвіл, а не мовчазна втрата.

- **Транзитивні виклики функцій моделі** (рішення 5): `fill` викликає
  функцію моделі A, яка викликає функцію B, змінену планом, — обчислення
  йде старим тілом B, і відмови немає. Безпечний шлях — розбити зміну:
  спершу план зі зміною B, потім промоція.
- **Залишкові `pg_temp_N` / `pg_toast_temp_N`.** Після `COMMIT` у
  `pg_namespace` цілі лишаються два службові простори імен тимчасових
  таблиць backend. Це не наш об'єкт: Postgres створює їх для будь-якої
  тимчасової таблиці й перевикористовує. Поза відбитком (межа схем) і поза
  `stack-guard`.
- **Таблиця з нащадками чи партиціонована з кроком даних** —
  `plan.promotion-unsupported` (`dataStepTable`).
- **Тип цілі, який створює план** (новий домен, композит) —
  `plan.promotion-unsupported` (`dataStepType`). Обхід — спершу план, що
  створює тип.
- **Крок даних на змаплену ціль зі зміною типу з нерядкового старого
  типу** (`int4 → numeric(10,2)` з ремонтом) — `dataStepType`. Обхід —
  спершу план зі зміною типу, потім промоція з ремонтом.
- **Вхідний FK з каскадом оновлення на колонку-ціль** —
  `plan.promotion-unsupported` (`dataStepReferenced`).
- **Ціль без права `TEMP`** — `plan.temp-privilege`.
- **Роль з `BYPASSRLS`** (зокрема `postgres` Supabase): `row_security = off`
  не дає помилки на `FORCE`-таблиці, бо RLS на неї не діє. Без `BYPASSRLS`
  — гучна помилка, як хоче спека.
- **Застосування промоції з `COMMIT`** — `apply.promotion-checks-pending` до
  П3-2b-3.

---

### Task 0: Звірка плану з кодом і базова лінія

**Files:** —

- [ ] **Step 1: Звірити якорі**

Run: `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-14-p3-2b-2-promotion-data-steps.md`
Expected: кожен шлях і символ, який план називає наявним, знайдено, зокрема
`runAttempt`, `measureBefore`, `provePreservation`, `preservationPlan`,
`preservationQuery`, `castProbeQuery`, `renameIntent`, `planPromotion`,
`analyseOnClone`, `lockPlan`, `planFootprint`, `promotionPermissionItems`,
`PROMOTION_GROUPS`, `promotionTransition`, `fillStepKind`, `NOW_FUNCTIONS`,
`VOLATILE_NAMES`, `withLocalSettings`, `shadowDatabaseNames`. Розбіжність —
стоп і звіт архітекторові.

- [ ] **Step 2: Базова лінія гейтів**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, потім
`pnpm db:start` і `pnpm test:db`.
Expected: усе зелене; число тестів (simetra, designer, DB) — у журнал. Червоне
до змін — стоп.

### Task 1: Правки спек для П3-2b-2 і П3-2b-3

**Files:**
- Modify: `docs/superpowers/specs/2026-10-06-promotion-design.md` (§4, §7.2, §8)

Напрям погодив власник через архітектора; точний текст — тут. Diff —
архітекторові до коміту, коміт лише після його погодження.

- [ ] **Step 1: §4, абзац «Вид кроку»** — після речення про незмаплену ціль
  додати:

  > Ремонт змінює наявні значення, тож потребує окремого дозволу
  > `repair:<таблиця>` (§8). Колонка-ціль і її тип мусять існувати до кроків
  > двигуна: обчислення й `ADD COLUMN` наміру йдуть до них, тож тип, якого
  > немає у вихідному стані цілі або який план створює, змінює чи знищує, —
  > відмова плану. Ключ кроку — первинний ключ вихідного стану; ключ, що сам
  > є ціллю кроку, вилучається чи змінює тип, — відмова. Таблиця з нащадками
  > за успадкуванням чи партиціонована кроків даних не має. Значення
  > змапленої цілі зі зміною типу записується до зміни, тобто в старий тип,
  > тож такий крок допустимий лише зі старим рядковим типом без межі:
  > текстова форма значення точна, а інше приведення могло б мовчки
  > округлити. Вхідний FK, що каскадно оновлює чи обнуляє рядки інших таблиць
  > за зміною колонки-цілі, — відмова: ці зміни лежать поза доказом
  > збереження.

- [ ] **Step 2: §4, абзац «Детермінованість»** — після речення про функцію
  моделі додати:

  > План повторює доказ на цілі: функції каталогу виразу там мусять бути
  > `IMMUTABLE` (крім дозволених функцій часу транзакції), а функція моделі —
  > бути у вихідному стані й не змінюватися
  > кроками плану, бо обчислення йде до кроків двигуна, тобто старим тілом.
  > Доказ охоплює прямі виклики виразу; функцію, яку викликає функція
  > моделі, він не бачить.

- [ ] **Step 3: §7.2 «Порядок транзакції», пункт «значення кроків даних»** —
  після першого речення додати:

  > Одна тимчасова таблиця на таблицю одиниці (`pg_temp.simetra_fill_<n>`)
  > несе всі її кроки, і запис іде одним `UPDATE` на таблицю: кожен
  > `UPDATE` пише нову версію рядка. Зайняте ім'я тимчасової таблиці —
  > відмова; без права `TEMP` на базу — відмова плану. Кількість записаних
  > рядків дорівнює кількості обчислених.

- [ ] **Step 4: §7.2, пункт «тригери на час запису»** — «перед увімкненням
  раннер звіряє його з живим» замінити на «перед вимкненням раннер звіряє
  його з живим».

- [ ] **Step 5: §8 «Дозволи»** — у перелік пунктів, що охоплюють таблицю,
  додати після `access:<таблиця>`:

  > чи ремонтів її значень (`repair:<таблиця>` — кожна ремонтована колонка
  > з виразом)

- [ ] **Step 6: §8 «Доказ, що це копія цієї цілі»** — після «відбиток без
  власників = відбиток цілі плану» додати пункт:

  > - голова ledger (id останнього застосування) = голова цілі плану: інші
  >   пункти збігаються в будь-якої бази проєкту в тому самому стані, а id
  >   застосування випадковий, тож однакова голова означає копію саме цієї
  >   цілі після її останнього застосування;

  і в перелік змісту звіту додати «голову ledger».

- [ ] **Step 7: §8 «Застосування промоції перевіряє звіт до будь-якої
  транзакції на цілі»** — замінити вступ на:

  > **Застосування промоції** перевіряє звіт: наявність, план і формат — до
  > будь-якої транзакції на цілі; факти сервера й число рядків таблиць
  > одиниці — у транзакції застосування до першого кроку, тим самим заміром
  > «до», що доводить збереження (окремий підрахунок до транзакції був би
  > другим проходом таблиць цілі, і не під замками плану):

- [ ] **Step 8: §8 «`statement_timeout`»** — формулу замінити на:

  > `max(60 с, ⌈3 × найдовший оператор звіту × max(1, maxₜ(рядки цілі ₜ /
  > рядки копії ₜ))⌉)`, де `t` — таблиці одиниці з рядками на копії: оператор
  > займає одну таблицю, і велика таблиця з малою копією не ховається за
  > сумою.

- [ ] **Step 9: Якорі, diff архітекторові, коміт**

Run: `python3 scripts/check-doc-anchors.py && pnpm format:check`
Expected: PASS. Надіслати `git diff` архітекторові; після погодження:

```bash
git add docs/superpowers/specs/2026-10-06-promotion-design.md
git commit -m "docs(spec): П3-2b-2/3 — межі кроків даних, дозвіл repair:, тригери перед вимкненням, голова ledger, рядки в транзакції, тайм-аут за таблицею"
```

### Task 2: Тестова інфраструктура — ім'я тіні й бажаний відбиток

**Files:**
- Modify: `packages/simetra/test/db/connection.ts`
- Modify: `packages/simetra/test/db/stack-guard.ts`
- Modify: `packages/designer/src/schema-engine/__tests__/round-trip.db.test.ts`
- Modify: `packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts`
- Modify: `packages/designer/src/schema-engine/__tests__/function-checks.db.test.ts`

**Interfaces:**
- Produces (у `connection.ts`): `SHADOW_PREFIX = "pgdelta_shadow_"`;
  `shadowAgeMinutes(name: string, now?: number): number | undefined`
  (нерозпізнане ім'я — `undefined`); `fingerprintAfterSteps(url: string,
  scope: EngineScope, steps: readonly { sql: string }[], o?: { bodiesOff?:
  boolean; superuser?: string }): Promise<CatalogFingerprint>` — `BEGIN`,
  (за `bodiesOff` — `SET LOCAL check_function_bodies = off`), кроки,
  `readFingerprint(tx, scope)`, `ROLLBACK` на тому самому з'єднанні.

- [ ] **Step 1: Тести помічників** у
  `packages/simetra/test/db/connection.test.ts` (unit, без бази для
  `shadowAgeMinutes`):
  - `shadowAgeMinutes("pgdelta_shadow_<base36 мс>_x", now)` — хвилини;
  - `shadowAgeMinutes("pgdelta_shadow_zz")` і `("other")` — `undefined`.
- [ ] **Step 2: Перевести `stack-guard.ts` (`reportOrphanShadows`),
  `round-trip.db.test.ts` і `shadowDatabaseNames` на `SHADOW_PREFIX` і
  `shadowAgeMinutes`;** локальний `shadowAgeMinutes` у `round-trip.db.test.ts`
  видалити. Нерозпізнане ім'я у звіті сторожа — «вік невідомий».
- [ ] **Step 3: Перевести `desiredFingerprint(setup, steps)` у
  `execute-plan.db.test.ts` і `function-checks.db.test.ts` на
  `fingerprintAfterSteps`** у тій самій базі-цілі; тести, що чекають
  відмову до фази 17, — без бажаного відбитка (заглушка відбитка з
  `FINGERPRINT_VERSION`); тести `apply.verify-failed` лишають свідомо інший
  бажаний стан. Підрахунок провізій до й після записати в журнал.
- [ ] **Step 4: Зелене й коміт**

Run: `pnpm --filter simetra test connection`, `pnpm test:db`
Expected: PASS, число DB-тестів те саме, що в базовій лінії.

```bash
git add packages/simetra/test packages/designer/src/schema-engine/__tests__
git commit -m "test(db): одне джерело правди про ім'я тіні; бажаний відбиток у тій самій базі транзакцією з відкатом"
```

### Task 3: `DATA_SETTINGS`, заміри під ними й функції часу

**Files:**
- Modify: `packages/simetra/src/schema/apply/settings.ts`
- Create: `packages/simetra/src/schema/apply/__tests__/settings.test.ts`
- Modify: `packages/simetra/src/schema/apply/execute.ts` (фази 6a, 14)
- Modify: `packages/simetra/src/schema/apply/promotion/preservation.ts`
  (`preservationQuery`, `castProbeQuery`)
- Modify: `packages/simetra/src/compiler/operations/promote/fill.ts`
  (`NOW_FUNCTIONS` експорт, `VOLATILE_NAMES`, нові `fillCalls`,
  `recordedFillKind`), `packages/simetra/src/compiler/index.ts` (реекспорт)
- Test: `packages/simetra/src/schema/apply/__tests__/promotion-preservation.test.ts`,
  `packages/simetra/src/compiler/__tests__/operations-promote.test.ts`,
  `packages/simetra/src/schema/apply/__tests__/execute.test.ts`

**Interfaces:**
- Produces: `DATA_SETTINGS: readonly EngineSetting[]` (порядок і значення —
  спека §7.2, 15 пар від `search_path = pg_catalog, pg_temp` до
  `row_security = off`);
  - `fillCalls(expression: string, parse: SqlParser): { schema?: string;
    name: string }[]` — кожен вузол `FuncCall` виразу (функції й
    агрегати), без повторів, у порядку обходу; лише збір, без перевірок
    (вираз уже перевірив T1);
  - `recordedFillKind(step: PromotionRecord["dataSteps"][number], record:
    PromotionRecord, table: { columns: readonly string[] }, functions:
    ModelFunctions, parse: SqlParser): { kind: StepKind } | { reason:
    FillProblem }` — той самий `fillStepKind`, що в `promote`; змаплені й
    вилучені колонки — з `record.columns`/`record.retired` таблиці в старих
    іменах; `functions` — `modelFunctions(<бажана модель>)`;
  - `NOW_FUNCTIONS` — експорт.

- [ ] **Step 1: Падаючі тести**
  - `settings.test.ts` → `"DATA_SETTINGS matches the pinned list of the
    promotion spec"`: читає `docs/superpowers/specs/2026-10-06-promotion-design.md`,
    бере рядки `- \`<ім'я> = <значення>\`` між «**Закріплені налаштування
    даних.**» і «Не закріплюються», порівнює з `DATA_SETTINGS` за порядком.
  - `promotion-preservation.test.ts` → `"measures every expression in a
    subquery"`: `preservationQuery(t, "before")` має форму `… FROM (SELECT
    <key> AS k, <e0> AS x0 … FROM "s"."t") AS s`; для `after` — так само.
  - `operations-promote.test.ts` → `"refuses statement_timestamp in a
    backfill"`: `fill` з `statement_timestamp()` → `promote.expression-invalid`
    з причиною `volatile`.
  - `operations-promote.test.ts` → `"lists the calls of a fill expression"`:
    `fillCalls("coalesce(app.norm(lower(name)), 'x')", parse)` →
    `[{ schema: "app", name: "norm" }, { name: "lower" }]` (`coalesce` у
    libpg-query — `CoalesceExpr`, а не виклик функції).
  - `operations-promote.test.ts` → `"derives the recorded kind as promote
    does"`: для кожного виду (`repair`, `conversion`, `split`, `backfill`,
    `coalesce(<джерело>, …)`) `recordedFillKind` дає той самий вид, що
    `promote` записав.
  - `promotion-preservation.test.ts` → `"probes a windowed expression in a
    subquery"`: `castProbeQuery` — `SELECT pg_catalog.count(x) AS probe FROM
    (SELECT (\n<вираз>\n) AS x FROM "s"."t") AS s`;
    `"survives a comment in the expression"`: вираз `left(code, 20) --
    trim` дає оператори, що розбираються `loadSqlParser` як один оператор з
    `FROM`.
  - `execute.test.ts` → `"measures preservation under the pinned data
    settings"`: фейковий порт записує оператори; замір «до» і «після» йдуть
    між `set_config` з усіма парами `DATA_SETTINGS` і поверненням збережених
    значень.
- [ ] **Step 2: Запустити — FAIL**

Run: `pnpm --filter simetra test settings preservation operations-promote execute`
Expected: FAIL на нових тестах.

- [ ] **Step 3: Реалізувати.** `DATA_SETTINGS` у `settings.ts` з JSDoc
  «перелік і причини — спека промоції §7.2»; `measureBefore` і
  `provePreservation` у `runAttempt` — у `withLocalSettings(tx,
  DATA_SETTINGS, …)`; `preservationQuery` і `castProbeQuery` — підзапит
  рішення 8 з переводом рядка навколо виразу; `statement_timestamp` з
  `NOW_FUNCTIONS` у `VOLATILE_NAMES`; `fillCalls`, `recordedFillKind`,
  `NOW_FUNCTIONS` — експорт із `fill.ts` і реекспорт із
  `packages/simetra/src/compiler/index.ts`.
- [ ] **Step 4: PASS і коміт**

Run: `pnpm --filter simetra test`, `pnpm --filter simetra typecheck`,
`pnpm --filter @simetra/designer typecheck`
Expected: PASS.

```bash
git add packages/simetra/src
git commit -m "feat(schema): закріплені налаштування даних під замірами збереження, заміри в підзапиті, statement_timestamp поза часом транзакції"
```

### Task 4: Секція кроків даних у плані

**Files:**
- Create: `packages/simetra/src/schema/apply/promotion/data.ts`
- Create: `packages/simetra/src/schema/apply/__tests__/promotion-data.test.ts`
- Modify: `packages/simetra/src/schema/apply/artifact.ts`
  (`PromotionSection.data`, `PreservedTable.columns[].dataStep`, схеми)
- Modify: `packages/simetra/src/schema/apply/promotion/preservation.ts`
  (`preservationPlan` з колонками `fill`)
- Modify: `packages/simetra/src/schema/apply/promotion/intent.ts`
  (`ADD COLUMN` незмаплених цілей)
- Modify: `packages/simetra/src/schema/apply/promotion/access.ts`
  (`promotionPermissionItems` + `repair:`)
- Modify: `packages/simetra/src/schema/apply/steps.ts` (`PROMOTION_GROUPS`)
- Modify: `packages/simetra/src/schema/apply/promotion/transition.ts`
  (зняти `unsupported("dataSteps")`)
- Modify: `packages/simetra/src/schema/apply/plan.ts` (`planPromotion`,
  `lockPlan`)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/promotion-intent.test.ts`,
  `promotion-preservation.test.ts`, `promotion-transition.test.ts`,
  `artifact.test.ts`;
  `packages/designer/src/schema-engine/__tests__/build-plan.db.test.ts`

**Interfaces:**
- Consumes: `fillCalls`, `DATA_SETTINGS` (задача 3).
- Produces (у `promotion/data.ts`):
  - `DataTable` (рішення 2), `PromotionSection.data: DataTable[]`;
  - `dataPlan(p: { record: PromotionRecord; intent: RenameIntent; source:
    Pick<PhysicalSnapshot, "tables">; desired: CompiledModel; parse:
    SqlParser }): { tables: Omit<DataTable, "triggers">[] } | { refusal:
    EngineDiagnostic[] }` — чисто: звірка запису (рішення 2,
    `plan.promotion-record-mismatch`), id `d<N>`, імена `simetra_fill_<n>`,
    ключі, типи з бажаної фізичної моделі, відмови `dataStepKey` і
    `dataStepType` для змапленої цілі зі зміною типу з нерядкового старого
    типу;
  - `dataComputeSql(t: DataTable): string` — `CREATE TEMP TABLE
    "simetra_fill_<n>" ON COMMIT DROP AS SELECT <key> AS k, ((\n<e1>\n)::<t1>)
    AS v1, … FROM <старе ім'я>`;
  - `dataCountSql(t: DataTable): string` — `SELECT pg_catalog.count(*) AS
    computed FROM pg_temp."simetra_fill_<n>"`;
  - `dataWriteSql(t: DataTable): string` — `WITH u AS (UPDATE <нове ім'я> AS
    t SET <c1> = d.v1, … FROM pg_temp."simetra_fill_<n>" AS d WHERE t.<key>
    OPERATOR(pg_catalog.=) d.k RETURNING 1) SELECT pg_catalog.count(*) AS
    written FROM u`;
  - `triggerSql(t: DataTable, on: boolean): string[]` — `ALTER TABLE … DISABLE
    TRIGGER "<ім'я>"` чи `ENABLE TRIGGER` / `ENABLE ALWAYS TRIGGER` за
    `enabled`;
  - `DataFacts` = `{ triggers: Map<string, DataTable["triggers"]>;
    inherited: string[]; tempPrivilege: boolean; types: Map<string,
    boolean>; functions: { step: string; schema?: string; name: string;
    immutable: boolean; exists: boolean }[]; cascading: string[] }` (ключі
    мап — `tableKey` старого імені; `cascading` — колонки-цілі з вхідним FK
    `ON UPDATE CASCADE | SET NULL | SET DEFAULT`);
  - `readDataFacts(tx: ApplyTransaction, tables: Omit<DataTable,
    "triggers">[], parse: SqlParser): Promise<DataFacts>` — `READ ONLY`
    цілі, старі імена; виклики — `fillCalls` без `NOW_FUNCTIONS`;
  - `dataFactRefusals(tables, facts: DataFacts, role: string):
    EngineDiagnostic[]` — до копії: `dataStepTable`, `dataStepType` (тип
    відсутній), `dataStepReferenced`, `plan.temp-privilege`,
    `plan.data-step-volatile`;
  - `dataStepRefusals(tables, steps: readonly PlanStep[]):
    EngineDiagnostic[]` — після `analyseOnClone`: `dataStepType` (тип
    створює, змінює чи знищує крок), `plan.data-step-function-changed`;
  - `readUserTriggers(tx, table: { schema: string; table: string }):
    Promise<DataTable["triggers"]>` — тригери `NOT tgisinternal` з
    `tgenabled IN ('O','A')`, за іменем (його ж бере раннер у задачі 5).
  - змінені сигнатури: `preservationPlan(record, intent, before,
    typeChangeSteps, data: readonly DataTable[])`;
    `promotionPermissionItems(access, deleteSemantics, removals, data:
    readonly DataTable[])`; `lockPlan` отримує `data: readonly DataTable[]`
    і додає слід рішення 2.
- Нові коди: `plan.data-step-volatile`, `plan.data-step-function-changed`,
  `plan.temp-privilege`; причини `plan.promotion-unsupported`:
  `dataStepTable`, `dataStepType`, `dataStepKey`, `dataStepReferenced` —
  кожна зі своєю гілкою тексту en/uk (гілку `dataSteps` прибрати; гілка
  `else` тексту зараз говорить про первинний ключ). Підказки
  `apply.permission-required` і `apply.permission-unknown` перелічують і
  `repair:`; текст `apply.temp-name-taken` — без «для перевірки» (ім'я
  тепер буває й тимчасовою таблицею даних).

- [ ] **Step 1: Падаючі unit-тести** (`promotion-data.test.ts`,
  `promotion-intent.test.ts`, `promotion-preservation.test.ts`):
  - `"numbers data steps and temp tables in record order"`: два кроки на
    `app.items`, один на `app.item_lines` → `d1`, `d2`, `d3`; `temp`
    `simetra_fill_1`, `simetra_fill_2`;
  - `"renders one compute and one write per table"`: точний SQL трьох
    рендерів для таблиці з двома кроками й тригерами `[{name:"a",
    enabled:"A"},{name:"o", enabled:"O"}]`; `triggerSql(t, true)` →
    `ENABLE ALWAYS TRIGGER "a"`, `ENABLE TRIGGER "o"`;
  - `"refuses a key that is a fill target"` / `"… that is retired"` / `"…
    whose type changes"` / `"… that is not the primary key"` →
    `plan.promotion-unsupported` з `reason: "dataStepKey"`;
  - `"adds an unmapped fill target after the column renames"`:
    `renameIntent` дає останнім кроком `ALTER TABLE "app"."catalog_items" ADD
    COLUMN "deletion_mark" boolean` (без `NOT NULL` і `DEFAULT`);
  - `"measures a fill target by its expression"`: `preservationPlan` для
    змапленої цілі з ремонтом дає `before: "((left(code, 20))::varchar(20))"`,
    `dataStep: "d1"`, без звичайного запису тієї колонки; для незмапленої —
    додатковий запис;
  - `"refuses a catalog function that is not immutable on the target"`:
    `dataFactRefusals` з фактом `{ step: "d1", name: "lower", immutable:
    false, exists: true }` → `plan.data-step-volatile` (`step: "d1"`,
    `function: "lower"`); функція з `exists: false` — та сама відмова;
  - `"refuses a type a step creates"`: `dataStepRefusals` з кроком
    `produced: [{ kind: "domain", schema: "app", name: "code_t" }]` і ціллю
    типу `app.code_t` → `dataStepType`;
  - `"refuses a repair recorded as a conversion"`: запис, де ремонт має
    `kind: "conversion"` → `plan.promotion-record-mismatch` (`detail:
    "dataSteps"`); те саме для таблиці поза `record.tables` і колонки, якої
    немає в бажаній таблиці;
  - `"refuses a data step on a mapped column whose old type is not text"`:
    `price int4 → numeric(10,2)` з ремонтом → `dataStepType`; `text →
    jsonb` з ремонтом — без відмови;
  - `"lists repaired columns under repair:"`: `promotionPermissionItems` з
    одним ремонтом → `{ token: "repair:\"app\".\"catalog_items\"", summary:
    ["\"code\" ← left(code, 20)"] }` після `remove:`; конверсія пункту не дає.
- [ ] **Step 2: FAIL**

Run: `pnpm --filter simetra test promotion-data promotion-intent promotion-preservation promotion-transition`
Expected: FAIL.

- [ ] **Step 3: Реалізувати чисту частину** (`data.ts`, `intent.ts`,
  `preservation.ts`, `access.ts`, `steps.ts`, схеми `artifact.ts`; у
  `transition.ts` прибрати `unsupported("dataSteps")` і тест, що його чекав,
  переписати на «план будується»).
- [ ] **Step 4: Падаючі DB-тести** у `build-plan.db.test.ts`,
  `describe("promotion data steps")` (ціль — адаптована таблиця
  `app.items` з `inactive boolean` і `code text`):
  - `"plans a conversion of a retired column into the deletion mark"`:
    `fill` `deletionMark ← coalesce(inactive, false)` → `planned`, секція
    `data` з `kind: "conversion"`, `triggers` таблиці, крок наміру `ADD
    COLUMN`, без пункту `repair:`;
  - `"refuses an inherited table"` → `dataStepTable`;
  - `"refuses a model function the plan changes"`: `fill` викликає
    `app.norm(text)`, а бажаний стан змінює її тіло →
    `plan.data-step-function-changed` з ім'ям функції;
  - `"refuses a model function that is not immutable on the target"`:
    `app.norm` на цілі `STABLE` → `plan.data-step-volatile`;
  - `"refuses without the TEMP privilege"`: `REVOKE TEMP ON DATABASE … FROM
    PUBLIC, postgres` у базі-цілі (власник бази має право окремо, тож лише
    `PUBLIC` не досить) → `plan.temp-privilege`;
  - `"refuses a key that is a fill target"` на рівні конвеєра →
    `dataStepKey`;
  - `"refuses a fill target referenced with ON UPDATE CASCADE"` →
    `dataStepReferenced`;
  - `"plans a backfill with now()"`: `fill` на `created_at ← coalesce(created_at,
    now())` → `planned` (функції часу транзакції поза перевіркою `IMMUTABLE`);
  - `"refuses a target type absent on the target before the copy"`: ціль —
    колонка домену, якого на цілі немає (його створює бажаний стан) →
    `dataStepType`, і копію не створено (шпигун на `withTargetClone` — нуль
    викликів), а не сирий `42704` кроку наміру;
  - `"reads desiredInvalid from the shadow in a promotion"` (борг T3, гілка
    промоції `planPromotion`; звичайний план уже має такий тест): бажаний
    стан з `NOT VALID` обмеженням → `artifact.desiredInvalid` містить його.
- [ ] **Step 5: Підключити в `planPromotion`** (дві точки, рішення 5):
  `dataPlan` одразу після `renameIntent`; `readDataFacts` окремою
  транзакцією `READ ONLY` цілі й `dataFactRefusals` — до
  `engine.withTargetClone`; `ADD COLUMN` наміру йде в `intent.steps`, тож
  виконується й на копії; `dataStepRefusals` — після `analyseOnClone` за
  його кроками; секція `data` з тригерами з фактів; у `lockPlan` — слід
  `SHARE ROW EXCLUSIVE` таблиці запису в старому імені (окремий
  `StepFootprint` з `step` першого `d<N>` таблиці).
- [ ] **Step 6: PASS і коміт**

Run: `pnpm --filter simetra test`, `pnpm --filter simetra typecheck`,
`pnpm --filter @simetra/designer typecheck`, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "feat(schema): секція кроків даних промоції — ключ, тип, детермінованість на цілі, TEMP, тригери, ADD COLUMN наміру, дозвіл repair:"
```

### Task 5: Раннер — обчислення й запис

**Files:**
- Modify: `packages/simetra/src/schema/apply/execute.ts` (фази 8, 10, 13;
  `preservesEveryTable`)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/execute.test.ts`,
  `packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts`

**Interfaces:**
- Consumes: `DataTable`, `dataComputeSql`, `dataCountSql`, `dataWriteSql`,
  `triggerSql`, `readUserTriggers` (задача 4), `DATA_SETTINGS` (задача 3).
- Produces: `computeData(tx, tables): Promise<Map<string, number>>` (temp →
  обчислено) і `writeData(tx, tables, computed): Promise<{ schema: string;
  table: string; computed: number; written: number }[]>` (старі імена,
  структурно) у `execute.ts` — їх результат П3-2b-3 покладе у звіт. Нові коди: `apply.data-step-failed` (`table`,
  `steps`, `sqlstate`, `error`; у замірі «до» — `step`),
  `apply.data-write-mismatch` (`table`, `computed`, `written`); секція
  `triggers` для `apply.target-changed`; параметр `after` у
  `apply.deferred-constraint-failed`.

- [ ] **Step 1: Падаючі тести фейкового порту** (`execute.test.ts`):
  - `"computes before the intent steps and writes before the engine steps"`:
    порядок операторів — CTAS, `count`, кроки наміру, `DISABLE`, запис,
    `ENABLE`, `SET CONSTRAINTS ALL IMMEDIATE`, кроки двигуна;
  - `"refuses a taken temp table name"` → `apply.temp-name-taken`;
  - `"refuses changed triggers before disabling them"` →
    `apply.target-changed` з `sections: "triggers"`, `DISABLE` не
    надсилається;
  - `"fails when fewer rows are written than computed"` →
    `apply.data-write-mismatch`;
  - `"is a broken pipeline when the data section disagrees with the
    record"`: крок запису без колонки в секції → `Error` до `BEGIN`;
  - `"is a broken pipeline when a data step is not measured"`: секція
    збереження без колонки з `dataStep` для кроку → `Error` до `BEGIN`;
  - `"keeps the phase order of a plan without data steps"`: план без
    секції `data` не надсилає `SET CONSTRAINTS` фази 10 — оператори ті самі,
    що до задачі;
  - `"names the data step of a narrowing beside a windowed column"`: колонка
    з віконним виразом і колонка зі звуженням типу в одній таблиці; збій
    заміру «до» → `apply.type-narrowing` з кроком звуження, а не
    `apply.preservation-measure-failed` віконної проби.
- [ ] **Step 2: FAIL**

Run: `pnpm --filter simetra test execute`
Expected: FAIL.

- [ ] **Step 3: Реалізувати** фази 8 і 10 у `runAttempt` під
  `withLocalSettings(tx, DATA_SETTINGS, …)`; помилка бази, що не
  повторювана, — `apply.data-step-failed`; `SET CONSTRAINTS` фази 10 і 13 —
  один помічник з параметром `after`; тексти en/uk «a deferred trigger or
  constraint failed» / «відкладений тригер чи обмеження»;
  `preservesEveryTable` вимагає колонку з `dataStep` для кожного кроку
  запису, а `dataMatchesRecord(section)` — рівно одну колонку секції на
  кожен `record.dataSteps` з тими самими таблицею, колонкою, виразом і
  видом (`Error` зламаного конвеєра).
- [ ] **Step 4: Падаючі DB-тести** (`execute-plan.db.test.ts`,
  `describe("data steps")`, режими `proof` і `rehearse`):
  - `"writes a conversion with user triggers off"`: `BEFORE UPDATE`-тригер,
    що дописує `!`, після прогону рядки без `!`, тригер знову `O`;
  - `"restores an ENABLE ALWAYS trigger as always"` (Review Focus 3);
  - `"stops a deferred foreign key broken by the write"` →
    `apply.deferred-constraint-failed` з `after: "data"` (Review Focus 2);
  - `"refuses a session temp table left on the backend"` (Review Focus 4):
    на тому самому з'єднанні до транзакції — `CREATE TEMP TABLE
    simetra_fill_1 (k int)` → `apply.temp-name-taken`;
  - `"keeps temp tables out of the checks"`: прогін без
    `apply.lock-footprint-exceeded`, без `apply.function-check-blind`, з
    рівним відбитком; після `ROLLBACK` `to_regclass('pg_temp.simetra_fill_1')`
    — `NULL`;
  - `"measures a windowed expression"` (Review Focus 1):
    `(row_number() over (order by id))::text` → `rolledBack`;
  - `"names the data step whose expression fails"`: `(code)::int` на
    рядку `'x'` → `apply.data-step-failed` з `step: "d1"` у замірі «до»;
  - `"names the table whose write fails"`: ремонт пише значення, що
    порушує `CHECK` колонки-цілі → `apply.data-step-failed` з `table` і
    `steps` у фазі 10.
- [ ] **Step 5: PASS і коміт**

Run: `pnpm --filter simetra test`, typecheck обох пакетів, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "feat(schema): кроки даних у раннері — обчислення в тимчасові таблиці, запис з вимкненими тригерами, відкладене одразу після запису"
```

### Task 6: Свідома конверсія типів

**Files:**
- Modify: `packages/simetra/src/compiler/messages.ts` (hint
  `apply.type-narrowing`)
- Test: `packages/designer/src/schema-engine/__tests__/build-plan.db.test.ts`
  (або `packages/designer/src/__tests__/promotion-lifecycle.db.test.ts`, де
  вже є `promote → plan → rehearse`)

- [ ] **Step 1: Падаючі DB-тести** (`promote → plan → rehearse` на цілі з
  даними):
  - `"refuses a normalizing type change without a data step"`: колонка
    `payload text` з `'{"a":1}'` → тип `jsonb` без `fill` →
    `apply.type-narrowing`;
  - `"rehearses a normalizing type change through a repair"` (Review Focus
    5): той самий випадок з `fill` `payload ← payload::jsonb` і `allow`
    `repair:"app"."catalog_items"` → `rolledBack`;
  - `"rehearses a truncating repair"`: `code text` → `varchar(20)` з
    рядком довжини 25 і `fill` `code ← left(code, 20)` → `rolledBack`, без
    — `apply.type-narrowing`;
  - `"refuses a repair without its permission"` →
    `apply.permission-required` з `repair:"app"."catalog_items"`.
- [ ] **Step 2: FAIL, потім hint.** Hint `apply.type-narrowing` en: «If the
  change is intended, record it as a fill step of the promotion (a repair
  such as left(<column>, <n>) or <column>::jsonb): the step writes the
  converted values before the type change». uk — так само.
- [ ] **Step 3: PASS і коміт**

Run: `pnpm --filter simetra test messages`, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "test(designer): свідома конверсія text → jsonb і обрізання ремонтом через крок даних"
```

### Task 7: Борг тестів 2b-1

**Files:**
- Modify: `packages/designer/src/schema-engine/__tests__/function-checks.db.test.ts`
- Modify: `packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts`
- Modify: `packages/designer/src/schema-engine/__tests__/savepoint-extract.db.test.ts`
- Modify: `packages/designer/src/__tests__/apply-tools.db.test.ts`
- Modify: `packages/simetra/src/schema/apply/execute.ts` (коментар до
  `errors[0]!`), `packages/simetra/src/compiler/messages.ts` (uk-текст
  `apply.rehearsal-proof-failed`)

- [ ] **Step 1: DB-тести** (кожен — новий, проти справжньої бази):
  - `"fails when plpgsql_check cannot be taken on the target"`: план
    `installed`, роль без `USAGE` на схему розширення → 
    `apply.plpgsql-check-unavailable`;
  - `"refuses when plpgsql_check vanished since the plan"` →
    `apply.target-changed` з `sections: "plpgsqlCheck"`;
  - `"names the table whose preservation measure fails"`: колонка заміру з
    виразом, що падає не на приведенні → `apply.preservation-measure-failed`
    з `table` і `side`;
  - `"marks the connection lost when it drops during the extract"`:
    `pg_terminate_backend` з другої сесії під час `tx.extract` →
    `ApplyConnectionLost`;
  - `apply-tools.db.test.ts` `"builds the desired shadow"` переписати так, що
    він падає без тіні (шпигун на `withDesiredShadow` фіксує один виклик з
    `artifact.scope`).
- [ ] **Step 2: Тексти й коментар.** uk `apply.rehearsal-proof-failed` —
  «Репетиція не довела стан: після кроків двигун ще бачить {count} дій до
  бажаного стану, перша — {first}»; коментар біля `errors[0]!` — чому
  безпечно (`count > 0`, а `actions` порожній).
- [ ] **Step 3: PASS і коміт**

Run: `pnpm --filter simetra test`, `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/src packages/designer/src
git commit -m "test(designer): DB-випадки plpgsql_check, збою заміру й обриву на витягу; шпигун тіні репетиції"
```

### Task 8: Показ, вхід `apply`, документи й фінальні гейти

**Files:**
- Modify: `packages/designer/src/tools/apply-tools.ts` (`PlanPromotion` і
  `planPromotion` — секція `data`; регулярний вираз `allow` і опис з
  `repair:`)
- Modify: `packages/designer/src/io/report.ts` (`promotionLines` — кроки
  даних)
- Modify: `packages/designer/src/cli/command.ts` (опис `--allow` з
  `repair:`)
- Test: `packages/designer/src/__tests__/` — наявні тести `report.ts` і
  `apply-tools` (точні файли дає `grep -rln promotionLines packages/designer/src`)
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` (абзац про
  `allow` промоції)
- Modify: `docs/architecture/designer.md` (якщо називає пункти дозволу)

- [ ] **Step 1: Падаючі тести** — `promotionLines` секції з двома кроками
  показує на таблицю рядок `data steps: d1 deletion_mark ←
  coalesce(inactive, false) (conversion)`, вимкнені на час запису тригери
  й пункт `repair:`; `apply` приймає `repair:"app"."t"` у `allow`, а
  `repair` без таблиці — ні.
- [ ] **Step 2: Реалізувати й описати.** Скіл: «A promotion's `allow` also
  takes the `access:<table>`, `delete:<table>.<constraint>`, `remove:<table>`
  and `repair:<table>` items its output lists; a repair rewrites existing
  values with the fill expression shown».
- [ ] **Step 3: Фінальні гейти**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
`pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`
Expected: усе зелене; стек після прогону = до нього.

```bash
git add packages docs
git commit -m "feat(designer): показ кроків даних і дозволу repair: у плані, скіл і опис apply"
```
