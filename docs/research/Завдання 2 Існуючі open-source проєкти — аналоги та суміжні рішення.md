# research-02-opensource-projects.md

# Open-source проєкти для metadata-driven бізнес-додатків

**Найближчим аналогом конфігуратора 1С у світі open-source є Frappe Framework** з його системою DocType, яка реалізує повний цикл «метадані → БД → UI → API». Жоден із досліджених проєктів не реалізує концепцію регістрів (накопичення, відомостей, бухгалтерії) — це унікальна інновація платформи 1С, яку доведеться будувати з нуля. Екосистема 1С має ключовий open-source компонент — бібліотеку **MDClasses**, що повністю моделює метадані конфігурацій у Java-об'єктах і підтримує обидва формати (XML конфігуратора та EDT). Серед інструментів моделювання схем БД жоден не має бізнес-семантики — усі працюють на рівні таблиць і колонок, що підтверджує наявність ринкової ніші для візуального конфігуратора бізнес-метаданих.

---

## A. Проєкти з екосистеми 1С на GitHub

### MDClasses — ядро моделі метаданих усієї екосистеми

**MDClasses** (1c-syntax/mdclasses) є єдиним проєктом, що надає **повну, програмну, двонаправлену модель метаданих** конфігурацій 1С. Бібліотека читає та записує метадані з обох форматів — XML (вивантаження конфігуратора) та EDT (проєктний формат 1C:EDT). Моделюються всі ключові об'єкти: довідники, документи, регістри відомостей, регістри накопичення, регістри бухгалтерії, перерахування, константи, плани обміну, ролі, підсистеми, загальні модулі, форми (включно з елементами, реквізитами, командами, обробниками).

- **URL:** https://github.com/1c-syntax/mdclasses
- **Ліцензія:** LGPL-3.0
- **Мова:** Java 56.5%, 1C Enterprise 41.4%
- **Зірки:** ~58 | **Останній реліз:** v0.18.0 (лютий 2026)
- **Архітектура:** іммутабельна об'єктна модель (Lombok), класи `CF`, `MD`, `MDChild`; публікується як Maven-артефакт `io.github.1c-syntax:mdclasses`

**Ключовий висновок для BRD:** MDClasses — найважливіше джерело для розуміння структури метаданих 1С. Архітектурні рішення (dual-format support, immutable objects, builder pattern) варто врахувати при проєктуванні нового конфігуратора.

### BSL Language Server — інтелектуальний аналіз коду на основі метаданих

BSL Language Server реалізує протокол LSP для мови 1С (BSL) та **залежить від MDClasses** для metadata-aware діагностики. Використовує метадані для визначення типу модуля, належності до підсистем, статусу підтримки. Має **395 зірок** і є найпопулярнішим проєктом організації 1c-syntax.

- **URL:** https://github.com/1c-syntax/bsl-language-server
- **Ліцензія:** LGPL-3.0 | **Мова:** Java 85.5%
- **Останній реліз:** v0.28.5 (лютий 2026) | **Комітів:** 8 444
- **Парсинг:** ANTLR4 (через bsl-parser), Spring Framework

BSL Language Server не моделює метадані самостійно — він споживає модель MDClasses. Для BRD цікавий як приклад **споживача** метаданих, що демонструє потреби клієнтського коду.

### OneScript — альтернативний рантайм без власної моделі метаданих

OneScript (EvilBeaver/OneScript) — кросплатформна віртуальна машина для виконання скриптів мовою 1С **без платформи 1С**. Версія 2.0.0 (січень 2026) побудована на сучасному .NET. OneScript **не моделює метадані конфігурацій** — це скриптовий рантайм. Проте його екосистема (opm, gitsync, vanessa-runner) є інфраструктурою DevOps для 1С.

- **URL:** https://github.com/EvilBeaver/OneScript
- **Ліцензія:** MPL-2.0 | **Мова:** C# 67.5%
- **Зірки:** ~553 | **Комітів:** 5 399

### V8Unpack — розпакування бінарних контейнерів без семантики

Утиліти V8Unpack працюють на рівні **бінарного контейнера** — розпаковують формат *.cf/*.epf/*.erf на окремі файли. Існує кілька реалізацій: C++ (e8tools/v8unpack), Rust (ava57r/v8unpack-rs). Семантичної моделі метаданих **не мають** — це preprocessing-крок перед парсингом XML.

Утиліта **gconn** у контексті 1С **не знайдена** — пошук не виявив відповідного проєкту.

### Vanessa Automation та Vanessa ADD — тестування без моделі метаданих

**Vanessa Automation** (Pr-Mex/vanessa-automation) — BDD-фреймворк для UI-тестування 1С на базі Gherkin. **603 зірки**, BSD-3-Clause, 98 контрибʼюторів. Працює на рівні UI (TestClient), не має власної моделі метаданих — взаємодіє з елементами форм за їхніми унікальними іменами.

**Vanessa ADD** (vanessa-opensource/add) — набір інструментів TDD/BDD/smoke-тестування. **363 зірки**, MPL-2.0. Включає готові smoke-тести, що генерично перевіряють об'єкти метаданих через рефлексію платформи 1С. Менш активний (останній реліз — липень 2023).

Обидва фреймворки **не мають самостійної моделі метаданих** — покладаються на API рефлексії платформи 1С.

### Інші проєкти та загальна архітектура екосистеми

Організація **1c-syntax** має **42 репозиторії**, формуючи найбільшу open-source екосистему для 1С. Ключові додаткові проєкти: bsl-parser (ANTLR4-граматика BSL), sonar-bsl-plugin-community (інтеграція з SonarQube), supportconf (читання даних підтримки), vsc-language-1c-bsl (розширення VS Code).

Від **1C-Company** на GitHub: dt-demo-configuration (демо-конфігурація у форматі EDT, 75 зірок), v8-code-style (Eclipse-плагін стандартів коду), 1c-edt-issues (трекер EDT). Усі EDT-плагіни — Java/Eclipse-based.

**Ієрархія залежностей екосистеми:**

```
BSL Language Server / SonarQube Plugin  (споживачі)
        ↓
    MDClasses                            (МОДЕЛЬ МЕТАДАНИХ)
        ↓
    BSL Parser / SupportConf             (парсинг BSL-коду / підтримка)
        ↓
    V8Unpack                             (розпакування контейнерів)
        ↓
    OneScript + екосистема               (рантайм + DevOps-утиліти)
    Vanessa Automation/ADD               (тестування)
```

---

## B. Metadata-driven бізнес-платформи

### Frappe Framework — найближчий аналог конфігуратора 1С

**Frappe Framework** реалізує парадигму, максимально близьку до 1С: **DocType** (аналог об'єктів метаданих) визначається як JSON-файл, з якого автоматично генерується таблиця БД, REST API, форма введення та списковий вигляд. Це точна реалізація принципу «визначи метадані — отримай працюючу систему».

- **URL:** https://github.com/frappe/frappe
- **Ліцензія:** MIT (фреймворк) / GPLv3 (ERPNext)
- **Стек:** Python, JavaScript, MariaDB/PostgreSQL, Redis
- **Зірки:** ~9 800 | **Останній реліз:** v16.10.9 (березень 2026)

**Система DocType** підтримує **40+ типів полів** (Data, Link, Select, Table, Currency, Date, Attach тощо). Стандартні поля створюються автоматично: `name`, `owner`, `creation`, `modified`, `modified_by`, **`docstatus`** (0=Чернетка, 1=Проведений, 2=Скасований). Підтримка child tables через тип поля «Table» — пряма аналогія табличних частин 1С. Клас **Meta** забезпечує кешований доступ до метаданих DocType.

**Що запозичити (MIT — максимально дозвільна):**
- JSON-формат опису DocType → синхронізація БД → автогенерація UI → автогенерація API
- Патерн `docstatus` для життєвого циклу документів (Чернетка/Проведений/Скасований)
- Custom Field / Property Setter для кастомізації на рівні інсталяції
- Система дозволів (role-based per DocType)

**Чого немає:** вбудованих регістрів, ієрархічних довідників (хоча є прапор `is_tree`), системи компоновки даних.

### Odoo — найбагатша система наслідування моделей

**Odoo Community Edition** — найпопулярніша open-source ERP з **~49 600 зірками**. Моделі визначаються як Python-класи, що наслідують `models.Model`. Метадані зберігаються у системних таблицях `ir.model` / `ir.model.fields`.

- **URL:** https://github.com/odoo/odoo
- **Ліцензія:** LGPL-3.0 (Community) / Proprietary (Enterprise)
- **Стек:** Python, JavaScript (OWL), PostgreSQL

**Три типи наслідування** — унікальна перевага Odoo:
1. **Класичне** (`_inherit`): розширення існуючої моделі на місці
2. **Делеговане** (`_inherits`): композиція через FK
3. **Абстрактне**: міксіни без таблиці в БД

**Computed fields** з декоратором `@api.depends()` можуть бути збереженими або віртуальними. XPath-based наслідування XML-в'юшок для модульної кастомізації. **Odoo Studio** (тільки Enterprise) — повний no-code конструктор моделей, прямий аналог конфігуратора 1С.

**Що запозичити (LGPL-3.0 — модифікації ядра залишаються LGPL, нові модулі можуть бути пропрієтарними):** трирівнева система наслідування, computed/stored fields з відстеженням залежностей, реєстр метаданих ir.model.

### Saltcorn і Budibase — no-code платформи без бізнес-семантики

**Saltcorn** (MIT, ~1 800 зірок) — Node.js no-code платформа з drag-and-drop конструктором на Craft.js. Таблиці та поля визначаються візуально, зберігаються у PostgreSQL/SQLite. Має систему пакунків (packs) для експорту/імпорту додатків та плагінну архітектуру для розширення типів полів. **Бізнес-семантики немає** — generic CRUD builder.

**Budibase** (GPL-3.0, ~27 750 зірок) — TypeScript/Svelte платформа для internal tools. Dual-архітектура: внутрішня CouchDB + зовнішні SQL-конектори. Auto-columns (`Created By`, `Created At`, `Updated By`, `Updated At`) аналогічні стандартним реквізитам 1С. Візуальний automation builder. **Бізнес-семантики немає**.

### NocoDB — найкраща реалізація віртуальних колонок

**NocoDB** перетворює SQL-базу на Airtable-подібний інтерфейс. Метадані зберігаються у таблицях `nc_*`, а фізична схема БД залишається незмінною. Ключова інновація — **віртуальні колонки**: Formula (обчислювані), Lookup (підтягування з пов'язаних таблиць), Rollup (агрегати — COUNT, SUM, AVG).

- **URL:** https://github.com/nocodb/nocodb
- **Ліцензія:** Sustainable Use License (з v0.301.0; раніше AGPLv3) — **не є open-source за визначенням OSI**
- **Зірки:** ~52 500 | **Стек:** TypeScript, Vue.js

**Що запозичити:** система UI type → DB type mapping, патерн віртуальних колонок. **Увага з ліцензією:** нова ліцензія забороняє комерційне SaaS-використання.

### Directus — еталон schema introspection

**Directus** підключається до існуючої БД і **автоматично генерує REST + GraphQL API** на основі інтроспекції схеми. Dual-schema підхід: фізичні таблиці БД + метадані у `directus_*` таблицях (колекції, поля, зв'язки, інтерфейси).

- **URL:** https://github.com/directus/directus
- **Ліцензія:** BSL 1.1 (безкоштовно для організацій <$5M; комерційна ліцензія для більших)
- **Зірки:** ~29 000 | **Стек:** TypeScript, Vue.js, Knex.js

**Що запозичити:** пакет `@directus/schema` для інтроспекції БД, dual-schema overlay pattern, Schema diff/apply API для міграції між середовищами (аналог порівняння конфігурацій 1С).

### Amplication — найкращий приклад генерації коду з метаданих

**Amplication** визначає сутності візуально і **генерує повний вихідний код** бекенду, який пушиться в Git. Генерується NestJS + Prisma + GraphQL/REST (Node.js) або ASP.NET Core + EF (.NET): моделі, DTO, CRUD API, автентифікація, міграції БД, Docker-конфіги.

- **URL:** https://github.com/amplication/amplication
- **Ліцензія:** Apache 2.0
- **Зірки:** ~17 000 | **Стек:** TypeScript, NestJS, React

**Що запозичити (Apache 2.0 — дуже дозвільна):** паттерн Entity → Prisma Schema → DB migration, плагінна архітектура для кастомізації генерованого коду, система Blueprints для організаційних стандартів. **Увага:** amplication.com знаходився у maintenance mode на момент дослідження.

---

## C. Інструменти візуального моделювання схем БД

### Жоден інструмент не має бізнес-семантики

Ключовий результат дослідження цієї категорії: **всі п'ять інструментів працюють виключно на рівні таблиць, колонок і зв'язків**. Жоден не підтримує абстракцій рівня «документ», «довідник» або «регістр». Це підтверджує наявність ніші для візуального конфігуратора бізнес-метаданих.

**DBML** (holistics/dbml) — Apache 2.0, ~3 500 зірок. Людиночитабельна DSL для опису схем БД з двонаправленою конвертацією DBML ↔ SQL. Парсер на ANTLR4 + Parsimmon, AST-based архітектура. Концепція **Table Partials** (повторно використовувані набори полів) концептуально близька до базових типів об'єктів 1С. Візуальний редактор dbdiagram.io — пропрієтарний SaaS, open-source лише парсер.

**pgModeler** (pgmodeler/pgmodeler) — GPL-3.0, ~3 500 зірок, C++/Qt. Повноцінний desktop GUI для моделювання PostgreSQL. Зберігає моделі у **XML з підтримкою split-формату** (.sdbm — окремі файли для кожного об'єкта, оптимізовано для Git). Має **diff/sync engine** для порівняння моделі з живою БД — прямий аналог механізму оновлення конфігурації БД у 1С. Шаблонна мікромова для генерації коду.

**DrawDB** (drawdb-io/drawdb) — AGPL-3.0, **~35 400 зірок** (найпопулярніший серед DB-інструментів). Браузерний React-додаток для візуального проєктування ER-діаграм. Внутрішнє JSON-представлення діаграм. Експорт SQL для MySQL, PostgreSQL, SQLite, MariaDB, SQL Server. Імпорт з DDL. Відмінний UX, не потребує облікового запису.

**Prisma** (prisma/prisma) — Apache 2.0, **~45 600 зірок** (найпопулярніший за зірками). **Prisma Schema Language (PSL)** — декларативна DSL як single source of truth для схеми БД, генерації type-safe клієнта та міграцій. Парсер на Rust (високопродуктивний). Повна система міграцій (Prisma Migrate). Система `@attribute` декораторів може бути розширена для бізнес-семантики.

**Drizzle ORM** (drizzle-team/drizzle-orm) — Apache 2.0, ~33 400 зірок. **Schema-as-TypeScript-code** — схеми визначаються безпосередньо у .ts файлах через builder-функції (`pgTable()`, `mysqlTable()`). Цей підхід дозволяє **програмно створювати фабрики** типів: `documentTable()`, `catalogTable()`, `registerTable()` — з готовими наборами полів та поведінок. Drizzle Kit має branch-aware міграції з DAG-перевіркою комутативності.

---

## D. Зведена порівняльна таблиця

### Проєкти екосистеми 1С

| Назва | URL | Ліцензія | Мова/стек | Бізнес-семантика | Станд. реквізити | Візуальний редактор | Code generation | Що можна запозичити |
|---|---|---|---|---|---|---|---|---|
| MDClasses | github.com/1c-syntax/mdclasses | LGPL-3.0 | Java | ✅ Повна модель 1С | ✅ | ❌ | ❌ | Повна об'єктна модель метаданих 1С, dual-format (XML/EDT) |
| BSL Language Server | github.com/1c-syntax/bsl-language-server | LGPL-3.0 | Java | ✅ (через MDClasses) | ✅ | ❌ | ❌ | LSP-інтеграція, metadata-aware діагностики |
| BSL Parser | github.com/1c-syntax/bsl-parser | GPL-3.0 | Java/ANTLR4 | ❌ | ❌ | ❌ | ❌ | ANTLR4-граматика мови BSL |
| OneScript | github.com/EvilBeaver/OneScript | MPL-2.0 | C# | ❌ | ❌ | ❌ | ❌ | Рантайм BSL на .NET, пакетний менеджер opm |
| V8Unpack | github.com/e8tools/v8unpack | Open source | C++ | ❌ | ❌ | ❌ | ❌ | Розпакування бінарних контейнерів 1С |
| Vanessa Automation | github.com/Pr-Mex/vanessa-automation | BSD-3 | 1C/Gherkin | ❌ | ❌ | ❌ | ❌ | BDD-підхід до тестування конфігурацій |
| Vanessa ADD | github.com/vanessa-opensource/add | MPL-2.0 | 1C/Gherkin | ❌ | ❌ | ❌ | ❌ | Smoke-тести метаданих через рефлексію |

### Metadata-driven бізнес-платформи

| Назва | URL | Ліцензія | Мова/стек | Бізнес-семантика | Станд. реквізити | Візуальний редактор | Code generation | Що можна запозичити |
|---|---|---|---|---|---|---|---|---|
| Frappe | github.com/frappe/frappe | MIT | Python, JS | ✅ DocType + docstatus | ✅ name, owner, creation, modified, docstatus | ✅ Повний | Runtime | JSON DocType → DB sync → UI → API; патерн docstatus |
| Odoo CE | github.com/odoo/odoo | LGPL-3.0 | Python, JS | ✅ Повна ERP | ✅ id, create_date, write_date, create_uid | ✅ (Studio — Enterprise) | Runtime | Три типи наслідування, computed fields, ir.model registry |
| Saltcorn | github.com/saltcorn/saltcorn | MIT | Node.js | ❌ | ⚠️ id + опціональні | ✅ Drag-and-drop | Runtime | Плагінна архітектура, система пакунків |
| Budibase | github.com/Budibase/budibase | GPL-3.0 | TypeScript, Svelte | ❌ | ✅ Auto-columns | ✅ Drag-and-drop | Runtime | Dual internal/external DB, automation builder |
| NocoDB | github.com/nocodb/nocodb | Sustainable Use¹ | TypeScript, Vue | ❌ | ✅ Системні колонки | ✅ Spreadsheet UI | Runtime | Віртуальні колонки (Formula, Lookup, Rollup) |
| Directus | github.com/directus/directus | BSL 1.1 | TypeScript, Vue | ❌ (CMS) | ⚠️ Опціональні | ✅ Data Studio | Runtime | Schema introspection, dual-schema, diff/apply API |
| Amplication | github.com/amplication/amplication | Apache 2.0 | TypeScript, React | ❌ | ✅ id, createdAt, updatedAt | ✅ Веб-редактор | ✅ Повний (Git push) | Entity → Prisma → DB migration, плагінна генерація |

¹ Раніше AGPLv3; змінено на Sustainable Use License — не є open-source за OSI

### Інструменти моделювання схем БД

| Назва | URL | Ліцензія | Мова/стек | Бізнес-семантика | Станд. реквізити | Візуальний редактор | Code generation | Що можна запозичити |
|---|---|---|---|---|---|---|---|---|
| DBML | github.com/holistics/dbml | Apache 2.0 | JS/TS | ❌ | ❌ | ❌ (SaaS — пропрієтарний) | SQL ↔ DBML | DSL-дизайн, AST-парсер, Table Partials |
| pgModeler | github.com/pgmodeler/pgmodeler | GPL-3.0 | C++, Qt | ❌ | ❌ | ✅ Повний desktop GUI | PostgreSQL DDL | Split XML для Git, diff/sync engine |
| DrawDB | github.com/drawdb-io/drawdb | AGPL-3.0 | React, JS | ❌ | ❌ | ✅ Браузерний | Multi-DB SQL | React canvas для ER-діаграм, JSON-модель |
| Prisma | github.com/prisma/prisma | Apache 2.0 | TypeScript, Rust | ❌ | ❌ | ⚠️ Data browser | Type-safe client + міграції | PSL як single source of truth, @attribute система |
| Drizzle | github.com/drizzle-team/drizzle-orm | Apache 2.0 | TypeScript | ❌ | ❌ | ⚠️ Data browser | Type-safe client + міграції | Schema-as-code, фабричні функції, branch-aware міграції |

---

## Аналітичні висновки та рекомендації

### Три ключові архітектурні патерни для нового конфігуратора

Аналіз 19 проєктів виявив три домінуючі підходи до metadata-driven розробки, кожен з яких пропонує цінні ідеї.

**Патерн 1: «JSON-метадані → рантайм-інтерпретація» (Frappe, Saltcorn, Budibase).** DocType зберігається як JSON, платформа на льоту генерує DDL, UI та API. Найпростіший для реалізації, найближчий до 1С. Frappe — еталон цього підходу з MIT-ліцензією.

**Патерн 2: «Код-як-модель → ORM → БД» (Odoo, Drizzle, Prisma).** Моделі описуються кодом (Python-класи або TypeScript), ORM синхронізує з БД. Перевага — повна міць мови програмування для опису складної логіки. Drizzle-підхід з фабричними функціями (`pgTable()`) найлегше розширити до бізнес-семантики (`documentTable()`, `catalogTable()`).

**Патерн 3: «Візуальна модель → генерація вихідного коду» (Amplication).** Сутності визначаються у веб-редакторі, генерується повноцінний backend-код, що пушиться у Git. Перевага — згенерований код повністю належить користувачу. Недолік — складніший цикл зворотного зв'язку.

### Що відсутнє в усіх досліджених проєктах

Жоден із досліджених проєктів не реалізує повністю наступні концепції 1С, які є ключовими для бізнес-додатків:

- **Регістри** (накопичення, відомостей, бухгалтерії) з вимірами, ресурсами та реквізитами — це фундаментальна абстракція для обліку, якої немає ніде в open-source
- **Проведення документів** з рухами по регістрах — лише Frappe має `docstatus`, але без механізму рухів
- **Система компоновки даних** — декларативна мова звітів 1С не має аналогів
- **Керовані форми** з програмним управлінням розкладкою — форми 1С значно складніші за будь-який досліджений візуальний конструктор
- **Конфігурація як артефакт** для розгортання — найближчі: JSON-fixtures Frappe та schema diff/apply Directus

### Рекомендована стратегія запозичення

Для нового open-source конфігуратора з дозвільною ліцензією (MIT або Apache 2.0) рекомендується комбінувати ідеї з проєктів, що мають сумісні ліцензії:

- **Формат метаданих:** JSON-based за зразком Frappe DocType (MIT), розширений бізнес-семантикою 1С з MDClasses (LGPL-3.0 — для вивчення моделі)
- **DSL для опису схеми:** натхнення від Prisma PSL (Apache 2.0) — декларативна мова з `@attribute` декораторами для бізнес-семантики
- **Система наслідування:** трирівнева модель Odoo (LGPL-3.0 — вивчити концепцію, реалізувати самостійно)
- **Візуальний редактор:** React-based канвас за зразком DrawDB (AGPL-3.0 — лише як UX-натхнення, код не запозичувати)
- **Генерація коду:** патерн Entity → Prisma → DB Migration з Amplication (Apache 2.0)
- **Міграції:** branch-aware підхід Drizzle Kit (Apache 2.0)
- **Віртуальні колонки:** Formula/Lookup/Rollup з NocoDB (код до v0.301.0 під AGPLv3)
- **Introspection існуючих БД:** `@directus/schema` (перевірити ліцензію пакету окремо)

Найбільш ліцензійно-безпечні джерела для прямого запозичення коду: **Frappe (MIT)**, **Amplication (Apache 2.0)**, **Prisma (Apache 2.0)**, **Drizzle (Apache 2.0)**, **DBML (Apache 2.0)**, **Saltcorn (MIT)**.