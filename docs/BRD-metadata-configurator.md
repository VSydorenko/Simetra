# BRD — Open-Source Business Metadata Configurator

**Версія документа:** 3.0
**Дата:** 2026-04-05
**Статус:** Draft для архітектурного ревʼю  
**Мова інтерфейсу:** Українська (перша), English (друга)

---

## 1. Огляд продукту

**Робоча назва:** Simetra

**Суть продукту:**  
Open-source візуальний конфігуратор бізнес-метаданих, натхненний підходом конфігуратора 1С:Підприємство, але реалізований як сучасний кросплатформний додаток для роботи з PostgreSQL та сучасними технологічними стеками.

**Ключова відмінність від усіх існуючих інструментів:**  
Це НЕ ще один дизайнер таблиць БД. Це інструмент, де користувач мислить бізнес-об'єктами — довідниками, документами, регістрами — а система знає структуру, стандартні реквізити та правила поведінки кожного типу. Користувач обирає "Створити довідник" і отримує об'єкт з Кодом, Найменуванням, ПозначкоюВидалення та можливістю ієрархії. Обирає "Створити регістр накопичення" — і отримує структуру з вимірами, ресурсами та типом (залишки/обороти).

**Ліцензія:** Apache 2.0  
**Внески:** DCO (Developer Certificate of Origin)

---

## 2. Проблема

### 2.1. Для кого ця проблема існує

Розробники, які будують облікові, ERP-подібні або бізнес-системи на сучасних стеках (.NET, Node.js, Python, Go), щоразу стикаються з однією і тією ж задачею: їм потрібно спроектувати структуру даних для довідників, документів, реєстрів руху — і щоразу вони роблять це вручну, з нуля, без стандартів і без інструменту.

### 2.2. Як виглядає проблема сьогодні

**Підхід "від таблиць"** — розробник відразу пише CREATE TABLE або Prisma schema. Немає стандартних реквізитів, немає типізації бізнес-об'єктів. Кожен новий проєкт — нова структура. Документ не відрізняється від довідника на рівні архітектури.

**Підхід "від 1С"** — розробник, який знає 1С, розуміє, що потрібні довідники з кодом і найменуванням, документи з датою і номером, регістри з вимірами і ресурсами. Але 1С — закрита пропрієтарна платформа з власною мовою і рантаймом. Перенести ці концепції на PostgreSQL + .NET потрібно вручну.

**Існуючі інструменти не вирішують проблему:**

| Інструмент | Що робить | Чого не має |
|---|---|---|
| pgAdmin, DBeaver | Робота з існуючою БД | Бізнес-семантика, моделювання з нуля |
| dbdiagram.io, DrawDB | Візуальне моделювання таблиць | Бізнес-типи, стандартні реквізити |
| Prisma, Drizzle | Code-first ORM-схеми | Візуальний конфігуратор, бізнес-семантика |
| Frappe/ERPNext | Metadata-driven ERP | Регістри, типізовані прототипи об'єктів |
| Supabase Studio | Візуальний редактор PostgreSQL | Бізнес-об'єкти, генерація |

**Жоден із 19 проаналізованих open-source проєктів не реалізує регістри (накопичення, відомостей, бухгалтерії) з вимірами, ресурсами та реквізитами як first-class примітив.**

### 2.3. Наслідки

- Кожна команда винаходить структуру довідників і документів з нуля
- Відсутність стандартів призводить до архітектурних помилок (наприклад, відсутність ПозначкиВидалення, неправильна нумерація)
- Знання 1С-архітектури залишається замкненим у пропрієтарній екосистемі
- Немає інструменту, який би допоміг валідувати архітектуру бізнес-системи до написання коду

---

## 3. Візія продукту

### 3.1. Коротко

Стати стандартним open-source інструментом для проєктування бізнес-систем — тим, чим Prisma стала для ORM, а Figma — для дизайну інтерфейсів, але для доменної архітектури облікових і ERP-систем.

### 3.2. Що продукт дає користувачу

1. **Моделювання бізнес-об'єктів** — довідники, документи, регістри, перелічення — з вбудованою семантикою кожного типу
2. **Візуальний конфігуратор** — дерево метаданих, редактор реквізитів, панель властивостей — як у конфігураторі 1С, але в сучасному UI
3. **Генерація артефактів** — PostgreSQL DDL, EF Core entities, міграції — з метаданих, без ручного кодування схеми
4. **Git-native формат** — метадані зберігаються як JSON-файли, один файл на об'єкт, оптимізовані для diff/merge
5. **Плагінна архітектура** — генератори для різних стеків як незалежні модулі

### 3.3. Чим продукт НЕ є (еволюційна позиція)

Позиціонування Simetra змінюється з розвитком продукту:

**Phase 1–2 (Конфігуратор + Генератор):**
- Не runtime-платформа — не виконує бізнес-логіку, тільки генерує артефакти
- Не ORM (як Prisma або EF Core) — не генерує клієнтський код для запитів
- Не редактор таблиць БД (як pgAdmin) — працює на рівні бізнес-об'єктів, а не SQL

**Phase 3+ (Runtime-рендерінг форм):**
- Може рендерити форми і додатки з JSON-метаданих напряму (JSON → React)
- Але НЕ є повноцінною application platform з власним server runtime (як 1С або Frappe)
- Бізнес-логіка генерується як PostgreSQL функції або React код, а не інтерпретується

**Незалежно від фази:**
- Не замінник 1С:Підприємство — Simetra перетворює архітектурні концепції 1С на сучасний стек, а не копіює платформу

### 3.4. Дорожня карта розвитку

| Горизонт | Можливість | Фаза |
|----------|------------|------|
| Декларативний движок проведення (posting engine) | Phase 2b |
| Генерація PostgreSQL функцій проведення/валідації | Phase 2b |
| Supabase як deployment target + auto REST API | Phase 2c |
| Runtime-рендерінг форм з JSON-метаданих | Phase 3 |
| Бібліотека domain-компонентів (@simetra/ui) | Phase 3 |
| Візуальний конструктор форм | Phase 4 |
| Application Shell (навігація, маршрутизація, dashboard) | Phase 4 |
| Codegen React-додатку (eject) | Phase 4–5 |
| Generated .NET/Node.js API | Phase 5 |
| Імпорт існуючих схем БД з розпізнаванням бізнес-типів | Phase 3 |
| Колаборативне редагування метаданих (cloud-версія) | Phase 5+ |

---

## 4. Цільові користувачі

### 4.1. Первинні

**Розробник бізнес-систем із досвідом 1С.** Знає, що таке довідники, документи, регістри. Переходить на .NET/Node/Python і хоче перенести перевірені архітектурні патерни 1С на сучасний стек. Цей користувач — найбільш мотивований early adopter.

**Fullstack-розробник, який будує облікову/ERP-систему.** Не має досвіду 1С, але стикається з тими ж задачами: потрібна нумерація документів, ієрархія довідників, реєстрація руху по регістрах. Для нього продукт — це фреймворк архітектурних рішень.

### 4.2. Вторинні

- Архітектор, який ревʼює структуру даних команди
- Аналітик, який моделює предметну область перед розробкою
- DevOps/DBA, який працює з генерованими міграціями

---

## 5. Система типів метаданих

Це серцевина продукту. Кожен тип метаданих — це не просто "entity з тегом", а об'єкт з чітко визначеною структурою, де частина полів задана системою.

### 5.1. Реєстр типів метаданих (Metadata Type Registry)

Система має вбудований реєстр типів, який визначає для кожного типу:
- Стандартні реквізити (задані платформою, не видаляються)
- Налаштування типу (конфігурує поведінку конкретного об'єкта)
- Дозволені підоб'єкти (табличні частини, виміри, ресурси тощо)
- Ролі полів (для регістрів: вимір, ресурс, реквізит)
- Правила поведінки (нумерація, ієрархія, проведення)

У MVP користувач не може створювати нові типи метаданих — тільки обирати з вбудованих. Розширення реєстру — у long-term scope.

### 5.2. Довідник (Catalog)

**Призначення:** Зберігання умовно-постійної інформації — контрагенти, номенклатура, склади, валюти.

**Стандартні реквізити:**

| Реквізит | Тип у метамоделі | Тип у PostgreSQL | Опис | Видаляється |
|---|---|---|---|---|
| id | UUID | `uuid DEFAULT gen_random_uuid()` | Унікальний ідентифікатор | Ні |
| code | String / Number | `varchar(N)` / `integer` | Код елемента | Ні |
| description | String | `varchar(N)` | Найменування | Ні |
| deletion_mark | Boolean | `boolean DEFAULT false` | Позначка на видалення | Ні |
| parent_id | UUID | `uuid REFERENCES ... NULL` | Батьківська група (якщо ієрархічний) | Ні¹ |
| is_folder | Boolean | `boolean DEFAULT false` | Це група (якщо ієрархічний) | Ні¹ |
| owner_id | Ref → {Owner} | `uuid REFERENCES ...` | Власник (якщо підпорядкований) | Ні² |
| predefined_name | String | `varchar(100) NULL` | Ім'я предефінованого елемента | Ні |
| created_at | DateTime | `timestamptz DEFAULT now()` | Дата створення | Ні |
| updated_at | DateTime | `timestamptz DEFAULT now()` | Дата останньої зміни | Ні |

¹ — присутній тільки якщо увімкнена ієрархія  
² — присутній тільки якщо задані власники. `parent_id` — структурне поле ієрархії (визначається `hierarchyType`), не reference-поле. `owner_id` при одному owner → `type: "Ref"`, `ref: { kind: "Catalog", name: "{Owner}" }`; при кількох owners → `type: "Ref"`, `allowedTypes: owners[]`

**Налаштування типу:**

| Параметр | Тип | Значення за замовчуванням | Опис |
|---|---|---|---|
| codeLength | Integer | 9 | Довжина коду |
| codeType | Enum: String, Number | String | Тип коду |
| descriptionLength | Integer | 150 | Довжина найменування |
| hierarchyType | Enum: None, FoldersAndItems, ItemsOnly | None | Тип ієрархії |
| owners | Array of {kind, name} | [] | Довідники-власники |
| autonumber | Boolean | true | Автонумерація коду |
| codeUnique | Boolean | true | Унікальність коду |
| mainPresentation | Enum: Code, Description | Description | Представлення за замовчуванням |
| predefinedItems | Array of {name, description} | [] | Предефіновані елементи |

**Дозволені підоб'єкти:** Реквізити (Attributes), Табличні частини (TabularSections).

### 5.3. Документ (Document)

**Призначення:** Реєстрація подій бізнес-діяльності — продажі, оплати, переміщення товарів.

**Стандартні реквізити:**

| Реквізит | Тип | PostgreSQL | Опис |
|---|---|---|---|
| id | UUID | `uuid` PK | Унікальний ідентифікатор |
| number | String / Number | `varchar(N)` / `integer` | Номер документа |
| date | DateTime | `timestamptz NOT NULL` | Дата документа |
| posted | Boolean | `boolean DEFAULT false` | Проведений |
| deletion_mark | Boolean | `boolean DEFAULT false` | Позначка на видалення |
| created_at | DateTime | `timestamptz DEFAULT now()` | Дата створення |
| updated_at | DateTime | `timestamptz DEFAULT now()` | Дата останньої зміни |

**Налаштування типу:**

| Параметр | Тип | За замовчуванням | Опис |
|---|---|---|---|
| numberLength | Integer | 11 | Довжина номера |
| numberType | Enum: String, Number | String | Тип номера |
| autonumber | Boolean | true | Автонумерація |
| numberPeriodicity | Enum: None, Year, Quarter, Month, Day | Year | Періодичність нумерації |
| posting | PostingConfig (optional) | — | Декларативний маппінг проведення (§5.3.1) |
| registerMovements | Array of {kind, name} | [] | Регістри, по яких документ здійснює рухи |

**Дозволені підоб'єкти:** Реквізити, Табличні частини.

**Поведінка проведення:**  
Документ підтримує життєвий цикл Draft → Posted → Unposted → Draft (зворотне проведення без зміни номера — на відміну від Frappe). Зв'язок з регістрами декларативний: у метаданих документа вказуються регістри, по яких він робить рухи (`registerMovements`). Детальний маппінг полів описується в секції `posting` (див. §5.3.1).

#### 5.3.1. Секція `posting` — декларативний маппінг проведення

Опціональна секція `posting` описує **як саме** дані документа стають рухами регістру. У 1С цей маппінг пишеться кодом у процедурі `ОбробкаПроведення()`. У 90% випадків цей код шаблонний: "візьми поле X з рядка табличної частини → запиши у вимір Y регістру". Simetra робить це декларативно.

Документи без секції `posting` є не-проведеними і не створюють рухів у регістрах. Зовнішня декларація `registerMovements` визначає зв'язок документа з регістрами, а `posting` деталізує маппінг полів.

**Формат у JSON-метаданих:**

```json
{
  "kind": "Document",
  "name": "GoodsReceipt",
  "posting": {
    "movements": [
      {
        "register": { "kind": "AccumulationRegister", "name": "InventoryBalance" },
        "movementType": "Receipt",
        "source": "tabularSection:items",
        "mappings": {
          "dimensions": {
            "product": "row.product",
            "warehouse": "doc.warehouse"
          },
          "resources": {
            "quantity": "row.quantity",
            "amount": "row.amount"
          },
          "attributes": {
            "responsible": "doc.responsible"
          }
        }
      }
    ],
    "validations": [
      {
        "type": "NonNegativeBalance",
        "register": { "kind": "AccumulationRegister", "name": "InventoryBalance" },
        "dimensions": ["product", "warehouse"],
        "resource": "quantity",
        "message": {
          "uk": "Недостатньо товару «{product}» на складі «{warehouse}»",
          "en": "Not enough product \"{product}\" in warehouse \"{warehouse}\""
        },
        "applyTo": "Expense"
      }
    ]
  }
}
```

**Специфікація `posting.movements[]`:**

| Поле | Тип | Обов'язкове | Опис |
|---|---|---|---|
| register | MetadataRef `{ kind, name }` | Так | Цільовий регістр |
| movementType | `"Receipt"` \| `"Expense"` \| mapping expression | Так | Фіксований тип або посилання на поле документа |
| source | `"document"` \| `"tabularSection:{name}"` | Так | Джерело рядків |
| condition | Expression \| null | Ні | Умова формування руху |
| mappings | MappingSet | Так | Маппінг полів |

**Джерело рядків (`source`):**
- `"document"` — один рух на весь документ (наприклад, загальна сума для регістру взаєморозрахунків)
- `"tabularSection:{name}"` — один рух на кожен рядок табличної частини

**Тип руху (`movementType`):**
- Фіксований: `"Receipt"` або `"Expense"`
- Динамічний: `"doc.operation_type"` — значення береться з реквізиту документа. Поле має бути Ref (kind=Enumeration) з значеннями, що маплятся на Receipt/Expense

**Маппінг виразів (mapping expressions):**
- `"doc.{field}"` — значення реквізиту документа
- `"row.{field}"` — значення поля рядка табличної частини (тільки якщо source = tabularSection)
- `"sum({tabularSection}.{field})"` — сума по полю табличної частини (тільки якщо source = document)
- `"count({tabularSection})"` — кількість рядків табличної частини
- `"literal:{value}"` — фіксоване значення
- `"now()"` — поточний timestamp
- `"row.{fieldA} * row.{fieldB}"` — арифметичний вираз між полями одного рядка (обмежений набір: `+`, `-`, `*`, `/`)

**Специфікація `posting.validations[]`:**

| Поле | Тип | Обов'язкове | Опис |
|---|---|---|---|
| type | `"NonNegativeBalance"` | Так | Тип перевірки (MVP — тільки контроль невід'ємних залишків) |
| register | MetadataRef | Так | Регістр для перевірки |
| dimensions | string[] | Так | По яких вимірах перевіряти |
| resource | string | Так | Який ресурс перевіряти |
| message | LocalizedString | Так | Повідомлення помилки з плейсхолдерами `{dimension_name}` |
| applyTo | `"Receipt"` \| `"Expense"` \| `"Both"` | Ні | Для яких типів руху перевіряти (default: `"Expense"`) |

**Що генерується з posting-метаданих:**

1. **Функція проведення `post_{document_name}(doc_id uuid)`:**
   - Перевірка `IF posted THEN RAISE EXCEPTION`
   - Очистка попередніх рухів (для перепроведення)
   - INSERT рухів з маппінгу expressions → SQL expressions
   - Виконання валідацій
   - `UPDATE {document} SET posted = true`
   - Обгорнуто в `BEGIN ... END` (єдина транзакція)

2. **Функція скасування проведення `unpost_{document_name}(doc_id uuid)`:**
   - DELETE рухів з кожного регістру
   - `UPDATE {document} SET posted = false`

3. **Функція перевірки залишків** (для кожного validation типу NonNegativeBalance):
   - `check_{register}_{resource}(dimensions..., required_qty)`
   - Підставляє displayName з довідників у повідомлення помилки

**Межі декларативності:**

| Покривається маппінгами (генерується автоматично) | Потребує кастомного коду (eject) |
|---|---|
| Прямий маппінг полів документа/ТЧ → виміри/ресурси регістру | FIFO/LIFO розрахунок собівартості |
| Агрегація: `sum()`, `count()` по табличній частині | Умовні рухи зі складною бізнес-логікою |
| Арифметика в межах одного рядка: `quantity * price` | Кросдокументне проведення |
| Контроль невід'ємних залишків | Виклик зовнішніх API при проведенні |
| Статичний або поле-залежний тип руху | Складні валідації (кредитний ліміт, терміни) |

Для кастомних випадків генерована функція проведення має **точку розширення** — виклик `{document_name}_post_custom(doc_id)`, яку розробник реалізує самостійно.

### 5.4. Перелічення (Enumeration)

**Призначення:** Фіксовані набори значень — статуси, типи, ознаки.

**Структура:**

| Властивість | Тип | Опис |
|---|---|---|
| name | String | Ім'я перелічення |
| values | Array of {name, displayName, order} | Перелік значень |

**Стандартних реквізитів немає** — перелічення не має таблиці в БД у класичному розумінні. Генерується як PostgreSQL ENUM type або як lookup-таблиця (конфігурується в генераторі).

**Підоб'єктів немає.**

### 5.5. Регістр відомостей (InformationRegister)

**Призначення:** Зберігання структурованої інформації "ключ → значення" з можливою періодичністю — курси валют, ціни, кадрові дані.

**Стандартні реквізити:**

| Реквізит | Тип | Умова | Опис |
|---|---|---|---|
| period | Date / DateTime | Якщо періодичний | Дата запису |
| recorder_id | Ref → {Recorder} | Якщо підпорядкований реєстратору | Документ-реєстратор |
| line_number | Integer | Якщо підпорядкований реєстратору | Номер рядка |
| active | Boolean | Якщо підпорядкований реєстратору | Активність запису |

`recorder_id` при одному реєстраторі → `type: "Ref"`, `ref: { kind: "Document", name: "{Recorder}" }`; при кількох → `type: "Ref"`, `allowedTypes: recorderTypes[]`.

**Налаштування типу:**

| Параметр | Тип | За замовчуванням | Опис |
|---|---|---|---|
| periodicity | Enum: NonPeriodic, Day, Month, Quarter, Year | NonPeriodic | Періодичність |
| writeMode | Enum: Independent, RecorderSubordinate | Independent | Режим запису |
| recorderTypes | Array of {kind, name} | [] | Документи-реєстратори (якщо RecorderSubordinate) |

**Ролі полів:** Виміри (Dimensions), Ресурси (Resources), Реквізити (Attributes).

- **Виміри** — ключові поля, за якими зберігається інформація (наприклад, Валюта, Організація)
- **Ресурси** — значення, що зберігаються (наприклад, Курс, Кратність). Тип — будь-який (не тільки числовий)
- **Реквізити** — додаткова інформація (наприклад, Відповідальний)

**Унікальність:** Комбінація (period + усі виміри) є унікальним ключем для незалежного регістру.

### 5.6. Регістр накопичення (AccumulationRegister)

**Призначення:** Накопичення числових даних — залишки товарів, взаєморозрахунки, рух коштів.

**Стандартні реквізити:**

| Реквізит | Тип | Опис |
|---|---|---|
| period | DateTime | Дата руху |
| recorder_id | Ref → {Recorder} | Документ-реєстратор |
| line_number | Integer | Номер рядка |
| active | Boolean | Активність запису |
| movement_type | Enum: Receipt, Expense | Вид руху (тільки для регістрів залишків) |

`recorder_id` при одному реєстраторі → `type: "Ref"`, `ref: { kind: "Document", name: "{Recorder}" }`; при кількох → `type: "Ref"`, `allowedTypes: recorderTypes[]`.

**Налаштування типу:**

| Параметр | Тип | За замовчуванням | Опис |
|---|---|---|---|
| registerType | Enum: Balance, Turnover | Balance | Тип регістру |
| recorderTypes | Array of {kind, name} | [] | Документи-реєстратори |

**Ролі полів:** Виміри, Ресурси (тільки числові), Реквізити.

- **Виміри** — аналітичні розрізи (Номенклатура, Склад, Організація)
- **Ресурси** — числові величини для накопичення (Кількість, Сума). Тільки Numeric
- **Реквізити** — додаткові дані без накопичення

**Автоматичні віртуальні таблиці (генеруються):**

Для **регістрів залишків**:
- Таблиця рухів (основна)
- Таблиця залишків (агреговані залишки по періодах)
- View: Залишки на дату
- View: Обороти за період
- View: Залишки та обороти

Для **регістрів оборотів**:
- Таблиця рухів (основна)
- View: Обороти за період

### 5.7. Константи (Constant)

**Призначення:** Одиничні значення налаштувань — назва організації, валюта обліку, ставка ПДВ.

**Структура:**

| Властивість | Тип | Опис |
|---|---|---|
| name | String | Ім'я константи |
| valueType | FieldType | Тип значення |
| defaultValue | Any | Значення за замовчуванням |

Всі константи зберігаються в одній таблиці `constants` у форматі key-value або кожна як окрема однорядкова таблиця (конфігурується в генераторі).

### 5.8. Таблична частина (TabularSection)

**Призначення:** Підпорядкована таблиця, що належить довіднику або документу — рядки товарів у накладній, контактні особи контрагента.

**Стандартні реквізити:**

| Реквізит | Тип | Опис |
|---|---|---|
| id | UUID | Унікальний ідентифікатор рядка |
| line_number | Integer | Номер рядка |

Таблична частина автоматично отримує зовнішній ключ на батьківський об'єкт з ON DELETE CASCADE.

**Обчислювані поля (Phase 3):**

Опціональна секція `computedFields` описує формули для автоперерахунку полів табличної частини:

```json
{
  "computedFields": [
    {
      "target": "amount",
      "formula": "row.quantity * row.price",
      "recalcOn": ["quantity", "price"]
    }
  ]
}
```

Simetra генерує з цього:
- **PostgreSQL trigger** — `BEFORE INSERT OR UPDATE OF quantity, price` для серверної валідації
- **React hook** (у codegen-режимі) — `useWatch` + `setValue` для автоперерахунку на фронтенді

**Дозволені підоб'єкти:** Реквізити (тільки прості поля, без вкладених табличних частин у MVP).

### 5.9. Довільна таблиця (CustomTable)

**Призначення:** Службові таблиці, що не вписуються в жоден бізнес-тип — логи, черги, налаштування, тимчасові дані. Також використовується для відображення таблиць існуючої БД, що не розпізнані як бізнес-об'єкти.

**Стандартні реквізити:**

| Реквізит | Тип | Опис | Видаляється |
|---|---|---|---|
| id | UUID | Унікальний ідентифікатор (якщо autoAddPrimaryKey = true) | Ні¹ |

¹ — присутній за замовчуванням; вимикається через налаштування `autoAddPrimaryKey: false`

**Налаштування типу:**

| Параметр | Тип | За замовчуванням | Опис |
|---|---|---|---|
| autoAddPrimaryKey | Boolean | true | Автоматично додавати id (UUID) як PK |

**Дозволені підоб'єкти:** Реквізити.

### 5.10. Зведена карта типів

| Тип | Стандартні реквізити | Ролі полів | Табличні частини | Ієрархія | Проведення | Фаза |
|---|---|---|---|---|---|---|
| Catalog | id, code, description, deletion_mark, parent_id, is_folder, owner_id, predefined_name, created_at, updated_at | — | Так | Так | — | MVP |
| Document | id, number, date, posted, deletion_mark, created_at, updated_at | — | Так | — | Так | MVP |
| Enumeration | — | — | — | — | — | MVP |
| InformationRegister | period, recorder_id, line_number, active | Dimension, Resource, Attribute | — | — | — | MVP |
| AccumulationRegister | period, recorder_id, line_number, active, movement_type | Dimension, Resource (numeric), Attribute | — | — | — | MVP |
| Constant | — | — | — | — | — | MVP |
| CustomTable | id¹ | — | — | — | — | MVP |

¹ — `id` присутній за замовчуванням (`autoAddPrimaryKey: true`), можна вимкнути

**Примітка:** `created_at` / `updated_at` наявні у Catalog та Document (див. розділи 5.2, 5.3), але не включені в таблицю для стислості.

| Тип | Стандартні реквізити | Ролі полів | Табличні частини | Ієрархія | Проведення | Фаза |
|---|---|---|---|---|---|---|
| ChartOfCharacteristicTypes | id, code, description, deletion_mark, value_type | — | Так | Так | — | Phase 2 |
| ChartOfAccounts | id, code, description, deletion_mark, off_balance, order | — | Так | Так | — | Phase 3 |
| AccountingRegister | period, recorder_id, line_number, active, debit_account, credit_account | Dimension, Resource, Attribute | — | — | — | Phase 3 |
| BusinessProcess | id, number, date, started, completed, deletion_mark | — | Так | — | — | Phase 4 |
| Task | id, number, date, executed, deletion_mark, business_process_id, route_point | — | Так | — | — | Phase 4 |

---

## 6. Система типів полів

### 6.1. Примітивні типи

| Тип у метамоделі | PostgreSQL | Параметри | Опис |
|---|---|---|---|
| UUID | `uuid` | — | Унікальний ідентифікатор |
| String | `varchar(N)` | length | Рядок обмеженої довжини |
| Text | `text` | — | Текст необмеженої довжини |
| Integer | `integer` / `bigint` | — | Ціле число |
| Numeric | `numeric(p,s)` | precision, scale | Десяткове число |
| Boolean | `boolean` | — | Логічне значення |
| Date | `date` | — | Дата |
| DateTime | `timestamptz` | — | Дата і час з часовим поясом |
| Binary | `bytea` | — | Двійкові дані |

### 6.2. Посилальні типи

Усі посилання на інші об'єкти метаданих використовують єдиний тип `Ref` з двома режимами:

| Режим | Опис | Структура |
|---|---|---|
| Single ref | Посилання на один конкретний об'єкт | `type: "Ref"`, `ref: { kind, name }` |
| Polymorphic ref | Посилання на один із дозволених об'єктів (складений тип) | `type: "Ref"`, `allowedTypes: [{ kind, name }, ...]` |

`ref` і `allowedTypes` — **взаємовиключні**: у одному полі може бути задано лише одне з них (або жодне — стан "ще не обрано").

**Підтримувані `kind` для посилань:** `Catalog`, `Document`, `Enumeration`.

**Display формат** — derived value, не збережений рядок:
- Single ref → `CatalogRef.Products` (з `ref.kind` + `ref.name`)
- Polymorphic ref → `AnyRef(2)` (кількість дозволених типів)

**Приклад single ref у JSON-метаданих:**

```json
{
  "name": "product",
  "displayName": { "uk": "Товар", "en": "Product" },
  "type": "Ref",
  "ref": { "kind": "Catalog", "name": "Products" },
  "required": true
}
```

Генерується як `product_id uuid REFERENCES products(id) NOT NULL` у PostgreSQL.

**Приклад polymorphic ref у JSON-метаданих:**

```json
{
  "name": "owner",
  "displayName": { "uk": "Власник", "en": "Owner" },
  "type": "Ref",
  "allowedTypes": [
    { "kind": "Catalog", "name": "Products" },
    { "kind": "Catalog", "name": "Services" }
  ],
  "required": true
}
```

Поліморфне посилання генерується як пара полів у PostgreSQL: `owner_type varchar(100) NOT NULL` + `owner_id uuid NOT NULL` (Dynamic Link pattern).

### 6.3. Властивості поля (Attribute Properties)

| Властивість | Тип | За замовчуванням | Опис |
|---|---|---|---|
| name | String | (required) | Технічне ім'я (snake_case) |
| displayName | LocalizedString | — | Відображуване ім'я {uk, en} |
| type | FieldType | (required) | Тип даних |
| required | Boolean | false | Обов'язковість |
| indexed | Boolean | false | Індексувати |
| unique | Boolean | false | Унікальність |
| defaultValue | String | null | Значення за замовчуванням |
| description | LocalizedString | — | Опис |
| length | Integer | — | Довжина (для String) |
| precision | Integer | — | Точність (для Numeric) |
| scale | Integer | — | Масштаб (для Numeric) |
| ref | MetadataRef | — | Цільовий об'єкт `{ kind, name }` (для `type: "Ref"`, single ref) |
| allowedTypes | Array of MetadataRef | — | Дозволені цільові об'єкти (для `type: "Ref"`, polymorphic ref) |

---

## 7. Формат метаданих

### 7.1. Рішення: JSON з JSON Schema валідацією

**Обґрунтування** (на основі аналізу 6 альтернативних форматів):
- JSON — універсальні парсери в усіх мовах (.NET, TypeScript, Rust, Python)
- JSON Schema — стандартна валідація, x-розширення для бізнес-семантики
- Не потребує створення власного парсера (на відміну від Prisma DSL або DBML)
- Достатня людиночитабельність при правильному форматуванні
- DSL-представлення може бути додане як sugar-синтаксис у майбутньому (Phase 3+)

### 7.2. Структура каталогів

```
metadata/
├── project.meta.json                          # Налаштування проєкту
├── application.meta.json                      # Каркас додатку (Phase 4)
├── catalogs/
│   └── products/
│       ├── products.meta.json
│       └── forms/                             # Phase 3: canonical частина file structure
│           ├── item.form.json
│           └── list.form.json
├── documents/
│   └── sales-order/
│       └── sales-order.meta.json
├── enumerations/
│   └── order-status/
│       └── order-status.meta.json
├── accumulation-registers/
│   └── inventory-balance/
│       └── inventory-balance.meta.json
├── information-registers/
│   └── exchange-rates/
│       └── exchange-rates.meta.json
├── constants/
│   └── constants.meta.json                    # Всі константи в одному файлі
└── custom-tables/
    └── audit-log/
        └── audit-log.meta.json
```

Один файл на об'єкт. Ім'я каталогу = kebab-case від імені об'єкта. Файли серіалізуються з сортованими ключами, 2-пробільним відступом і trailing newline для чистих Git-дифів.

Підкаталог `forms/` є canonical частиною file structure об'єкта. Форми серіалізуються як окремі файли `{form-kind-kebab}.form.json` у підкаталозі `forms/` відповідного об'єкта. Kinds що підтримують форми: `Catalog`, `Document`, `CustomTable`. Serializer записує forms як частину canonical snapshot разом з `*.meta.json` файлами.

### 7.3. Формат файлу проєкту

```json
{
  "$schema": "https://simetra.dev/schemas/v1/project.schema.json",
  "schemaVersion": "1.0",
  "name": "MyBusinessApp",
  "displayName": { "uk": "Мій бізнес-додаток", "en": "My Business App" },
  "defaultLocale": "uk",
  "database": {
    "target": "postgresql",
    "schema": "public"
  },
  "generation": {
    "tablePrefix": "",
    "enumStrategy": "pgEnum",
    "constantsStrategy": "singleTable"
  }
}
```

### 7.4. Приклад файлу довідника

```json
{
  "$schema": "https://simetra.dev/schemas/v1/catalog.schema.json",
  "kind": "Catalog",
  "name": "Products",
  "displayName": { "uk": "Товари", "en": "Products" },
  "codeLength": 9,
  "codeType": "String",
  "descriptionLength": 150,
  "hierarchyType": "FoldersAndItems",
  "autonumber": true,
  "codeUnique": true,
  "mainPresentation": "Description",
  "predefinedItems": [
    { "name": "Delivery", "description": { "uk": "Доставка", "en": "Delivery" } }
  ],
  "attributes": [
    {
      "name": "article",
      "displayName": { "uk": "Артикул", "en": "Article" },
      "type": "String",
      "length": 50,
      "indexed": true
    },
    {
      "name": "unit",
      "displayName": { "uk": "Одиниця виміру", "en": "Unit" },
      "type": "Ref",
      "ref": { "kind": "Enumeration", "name": "Units" }
    },
    {
      "name": "base_price",
      "displayName": { "uk": "Базова ціна", "en": "Base Price" },
      "type": "Numeric",
      "precision": 15,
      "scale": 2
    }
  ],
  "tabularSections": [
    {
      "name": "barcodes",
      "displayName": { "uk": "Штрихкоди", "en": "Barcodes" },
      "attributes": [
        { "name": "barcode", "type": "String", "length": 200, "required": true },
        { "name": "barcode_type", "type": "Ref", "ref": { "kind": "Enumeration", "name": "BarcodeTypes" } }
      ]
    }
  ]
}
```

### 7.5. Приклад файлу регістру накопичення

```json
{
  "$schema": "https://simetra.dev/schemas/v1/accumulation-register.schema.json",
  "kind": "AccumulationRegister",
  "name": "InventoryBalance",
  "displayName": { "uk": "Залишки товарів", "en": "Inventory Balance" },
  "registerType": "Balance",
  "recorderTypes": [
    { "kind": "Document", "name": "SalesOrder" },
    { "kind": "Document", "name": "PurchaseOrder" },
    { "kind": "Document", "name": "InventoryTransfer" }
  ],
  "dimensions": [
    {
      "name": "product",
      "displayName": { "uk": "Товар", "en": "Product" },
      "type": "Ref",
      "ref": { "kind": "Catalog", "name": "Products" },
      "required": true
    },
    {
      "name": "warehouse",
      "displayName": { "uk": "Склад", "en": "Warehouse" },
      "type": "Ref",
      "ref": { "kind": "Catalog", "name": "Warehouses" },
      "required": true
    }
  ],
  "resources": [
    {
      "name": "quantity",
      "displayName": { "uk": "Кількість", "en": "Quantity" },
      "type": "Numeric",
      "precision": 15,
      "scale": 3
    },
    {
      "name": "amount",
      "displayName": { "uk": "Сума", "en": "Amount" },
      "type": "Numeric",
      "precision": 15,
      "scale": 2
    }
  ],
  "attributes": [
    {
      "name": "responsible",
      "displayName": { "uk": "Відповідальний", "en": "Responsible" },
      "type": "Ref",
      "ref": { "kind": "Catalog", "name": "Users" }
    }
  ]
}
```

### 7.6. Правила детерміністичної серіалізації

1. Ключі об'єктів — у фіксованому порядку (визначається JSON Schema)
2. Масиви attributes, dimensions, resources, tabularSections — **зберігають порядок, визначений користувачем** (порядок полів є частиною моделі). Сортування за `name` НЕ застосовується — порядок масиву в JSON є canonical
3. Ключі всередині кожного об'єкта масиву — у фіксованому порядку (name, displayName, type, ...)
4. Відступ: 2 пробіли
5. Trailing newline: обов'язково
6. Ніяких volatile даних (timestamps, checksums, auto-increment idx)
7. Кожен файл має `$schema` для валідації
8. UTF-8 без BOM

### 7.7. Стратегія еволюції схеми (Schema Evolution)

Поле `schemaVersion` у `project.meta.json` визначає версію формату метаданих. Правила еволюції:

1. **Additive-only changes** — нові поля додаються з дефолтними значеннями, існуючі поля не видаляються і не змінюють семантику. Це дозволяє старим проєктам відкриватися новою версією без breaking changes
2. **Deprecation з терміном** — якщо поле стає застарілим, воно позначається `deprecated` в JSON Schema на 1 minor-версію, видаляється на наступну major
3. **Автоматичний upgrade** — при відкритті проєкту з старшим `schemaVersion` конфігуратор пропонує міграцію (з показом diff). Міграція — це функція `(oldJson, oldVersion) → newJson`, що зберігається в коді ядра
4. **Версіонування** — SemVer: major (зламні зміни), minor (нові типи/поля), patch (виправлення схеми). Додавання `ChartOfAccounts` у Phase 3 — це minor, бо старі проєкти просто не використовують цей тип
5. **JSON Schema per version** — кожна версія `schemaVersion` має відповідний набір JSON Schema (`/schemas/v1/`, `/schemas/v1.1/`)
6. **URL-домен** — `https://simetra.dev/schemas/` як base URL для `$schema` у файлах метаданих

---

## 8. Функціональні вимоги

### 8.1. Управління проєктом

| ID | Вимога | Пріоритет | Статус |
|---|---|---|---|
| FR-001 | Створити новий проєкт з ім'ям та базовими налаштуваннями | MVP | ✅ Done |
| FR-002 | Відкрити існуючий проєкт з каталогу metadata/ | MVP | ✅ Done |
| FR-003 | Зберегти проєкт у файлову систему (JSON-файли) | MVP | ✅ Done |
| FR-004 | Налаштувати параметри проєкту (database target, naming convention) | MVP | ✅ Done |
| FR-005 | Валідувати цілісність проєкту (посилальна цілісність, обов'язкові поля) | MVP | ⚠️ Partial — object-level done, project-level validation UX incomplete |

### 8.2. Дерево метаданих

| ID | Вимога | Пріоритет | Статус |
|---|---|---|---|
| FR-010 | Відображати дерево метаданих з фіксованими розділами за типами | MVP | ✅ Done — глибоке дерево 4+ рівні |
| FR-011 | Додавати об'єкт усередині розділу (контекстне меню, кнопка, Cmd+N) | MVP | ✅ Done |
| FR-012 | Перейменовувати об'єкт (F2, inline rename) | MVP | ✅ Done |
| FR-013 | Видаляти об'єкт з перевіркою посилальної цілісності | MVP | ✅ Done — findReferences logic exists |
| FR-014 | Вибирати об'єкт з відображенням його полів та властивостей | MVP | ✅ Done |
| FR-015 | Показувати кількість об'єктів у кожному розділі | MVP | ✅ Done — badge |
| FR-016 | Пошук/фільтрація по дереву (Ctrl+F) | MVP | ✅ Done |
| FR-017 | Показувати іконку типу для кожного об'єкта | MVP | ✅ Done — hugeicons |
| FR-018 | Drag-and-drop для зміни порядку | Phase 2 | — |
| FR-019 | Фільтрація дерева за тегами/підсистемами | Phase 2 | — |
| FR-01A | Дублювати об'єкт (глибока копія з новим ім'ям) | MVP | ✅ Done |

### 8.3. Редагування об'єкта

| ID | Вимога | Пріоритет | Статус |
|---|---|---|---|
| FR-020 | Редагувати базові властивості об'єкта (ім'я, displayName, налаштування типу) | MVP | ✅ Done |
| FR-021 | Стандартні реквізити не відображаються inline в таблиці реквізитів; доступні через окремий Dialog з ObjectProperties. Кнопка Стандартні реквізити видима тільки для Catalog, Document, InformationRegister, AccumulationRegister та CustomTable | MVP | ✅ Done — StandardAttributesDialog |
| FR-022 | Показувати налаштування, специфічні для типу (hierarchyType для Catalog, registerType для AccumulationRegister) | MVP | ✅ Done — ObjectProperties |
| FR-023 | Валідувати зміни в реальному часі (унікальність імен, коректність типів) | MVP | ✅ Done — Zod validation per mutation |
| FR-024 | Валідація імен об'єктів та полів: snake_case, латиниця, заборона SQL reserved words (`order`, `group`, `user`, `table` тощо) | MVP | ✅ Done — core schema refine |

### 8.4. Редагування полів (реквізитів)

| ID | Вимога | Пріоритет | Статус |
|---|---|---|---|
| FR-030 | Відображати список полів об'єкта в табличному вигляді | MVP | ✅ Done — @tanstack/react-table |
| FR-031 | Додавати нове поле | MVP | ✅ Done |
| FR-032 | Редагувати поле (inline або в панелі властивостей) | MVP | ✅ Done — FieldProperties + DataTypeEditorDialog |
| FR-033 | Видаляти поле | MVP | ✅ Done |
| FR-034 | Змінювати порядок полів (кнопки вгору/вниз; drag-and-drop — Phase 2) | MVP | ✅ Done — кнопки вгору/вниз |
| FR-035 | Обирати тип поля з категоризованого списку (примітивні, посилальні, перелічення) | MVP | ✅ Done — DataTypeEditorDialog з деревом |
| FR-036 | Для посилальних типів — обирати цільовий об'єкт з випадаючого списку | MVP | ✅ Done — MetadataRefPicker + DataTypeEditorDialog |
| FR-037 | Для регістрів — призначати роль поля (Dimension / Resource / Attribute) | MVP | ✅ Done |
| FR-038 | Відображати роль поля візуально (іконка або колір) | MVP | ✅ Done — hugeicons + kind colors |

### 8.5. Табличні частини

| ID | Вимога | Пріоритет | Статус |
|---|---|---|---|
| FR-040 | Додавати табличну частину до довідника або документа | MVP | ✅ Done |
| FR-041 | Редагувати реквізити табличної частини (як окремий список полів) | MVP | ✅ Done |
| FR-042 | Видаляти табличну частину | MVP | ✅ Done |
| FR-043 | Перемикатися між основними реквізитами і табличними частинами | MVP | ✅ Done — deep tree + vertical nav |

### 8.6. Посилальна цілісність

| ID | Вимога | Пріоритет | Статус |
|---|---|---|---|
| FR-050 | Валідувати, що цільовий об'єкт посилального поля існує | MVP | ✅ Done — validation hint у MetadataRefPicker |
| FR-051 | Попереджати при видаленні об'єкта, на який є посилання | MVP | ✅ Done — findReferences + confirmation dialog |
| FR-052 | Показувати список вхідних посилань на об'єкт (де використовується) | MVP | ⚠️ Partial — логіка є (findReferences), UI закінчується на console.info. Діалог WhereUsed — у phase1-closure-backlog |

### 8.7. Генерація (Post-MVP)

| ID | Вимога | Пріоритет | Статус |
|---|---|---|---|
| FR-060 | Згенерувати PostgreSQL DDL (CREATE TABLE, CREATE INDEX, FK) з метаданих | Phase 2a | — Planned: phase2a-ddl-generator.md |
| FR-061 | Згенерувати SQL-міграцію (ALTER TABLE) при зміні метаданих | Phase 2c | — Planned: phase2c-deployment-adapter.md |
| FR-062 | Згенерувати EF Core entity classes + IEntityTypeConfiguration | Phase 2+ | — Deferred |
| FR-063 | Згенерувати view/materialized view для віртуальних таблиць регістрів | Phase 2a | — Planned: phase2a-ddl-generator.md |
| FR-064 | Показати diff між поточними метаданими та станом БД | Phase 2c | — Planned: phase2c-deployment-adapter.md |
| FR-065 | Підключитися до живої PostgreSQL БД для schema introspection | Phase 3 | — |
| FR-066 | Згенерувати SQL-функції проведення/скасування з posting-метаданих | Phase 2b | — Planned: phase2b-posting-engine.md |
| FR-067 | Візуальний редактор маппінгів проведення (movements editor) | Phase 2b | — Planned: phase2b-posting-engine.md |
| FR-068 | Runtime-рендерінг форм з JSON-метаданих (form.json → React) | Phase 3 | — |
| FR-069 | Генерація каркасу додатку (Application Shell) з метаданих | Phase 4 | — |

### 8.8. Import / Export

| ID | Вимога | Пріоритет | Статус |
|---|---|---|---|
| FR-070 | Експортувати проєкт як ZIP-архів JSON-файлів | MVP | ✅ Done |
| FR-071 | Імпортувати проєкт з ZIP-архіву | MVP | ✅ Done |
| FR-072 | Імпортувати схему з існуючої PostgreSQL БД (schema introspection) | Phase 3 | — |

### 8.9. Undo/Redo

| ID | Вимога | Пріоритет | Статус |
|---|---|---|---|
| FR-080 | Підтримка Undo (Ctrl+Z) для всіх операцій редагування | MVP | ✅ Done — zundo |
| FR-081 | Підтримка Redo (Ctrl+Shift+Z) | MVP | ✅ Done — zundo |

### 8.10. Локалізація

| ID | Вимога | Пріоритет | Статус |
|---|---|---|---|
| FR-090 | Інтерфейс українською мовою за замовчуванням | MVP | ✅ Done — i18next, uk default |
| FR-091 | Підтримка англійської мови інтерфейсу | MVP | ✅ Done — en locale |
| FR-092 | Всі displayName — локалізовані об'єкти {uk, en} | MVP | ✅ Done |
| FR-093 | Технічні ідентифікатори — англійською (snake_case) | MVP | ✅ Done |

---

## 9. Архітектура UI

### 9.1. Технологічний стек

| Компонент | Технологія | Обґрунтування |
|---|---|---|
| Framework | React 18+ + Vite 8 | Швидкість збірки, ecosystem |
| UI Kit | shadcn/ui + Tailwind CSS 4 | Повний контроль, професійний вигляд |
| Дерево | react-arborist | Custom renderer, keyboard nav, search |
| Таблиця | @tanstack/react-table v8 | shadcn/ui інтеграція, sorting, filtering |
| Layout | react-resizable-panels | Вбудований у shadcn/ui |
| Command Palette | cmdk (shadcn/ui Command) | Швидка навігація, Ctrl+K / Cmd+K |
| State | Zustand + immer | Централізований store, інтуїтивні мутації |
| Undo/Redo | zundo | Battle-tested temporal middleware |
| Validation | Zod | Runtime validation, TypeScript inference, генерація JSON Schema |
| JSON Schema | zod-to-json-schema | Zod як single source of truth → JSON Schema як build artifact |
| Keyboard | react-hotkeys-hook | Scoped hotkeys |
| Icons | hugeicons (@hugeicons/react + @hugeicons/core-free-icons) | Візуальна тема shadcn "mira" працює з hugeicons |
| CLI (Phase 2) | citty (unjs) | Lightweight CLI framework для generate/validate/init |
| Desktop shell (Phase 3) | Tauri 2.0 | Кросплатформний desktop-додаток, Rust-бекенд для нативного FS |
| VS Code extension (Phase 3) | VS Code Extension API | Інтеграція в IDE, sidebar panel |
| Тести | Vitest + Testing Library | Vite-native, швидкий запуск |
| Монорепо | pnpm workspaces + turborepo | Розділення пакетів, кешовані збірки |

### 9.2. Архітектура пакетів (монорепо)

Проєкт організований як pnpm monorepo з turborepo для кешованих збірок:

```
packages/
├── @simetra/core                ← Zod-схеми, типи, валідація (чистий TS, без UI/Node API)
├── @workspace/ui                ← shadcn/ui примітиви (Phase 1, existing)
├── @simetra/json-schemas        ← Згенеровані JSON Schema (з Zod, build step)
├── @simetra/generator-api       ← MetadataGenerator interface + спільні утиліти (Phase 2a)
├── @simetra/generator-pg        ← PostgreSQL DDL + posting SQL генератор (Phase 2a–2b)
├── @simetra/generator-efcore    ← EF Core генератор (Phase 2+, deferred)
├── @simetra/cli                 ← CLI обгортка (citty) над core + generators (Phase 2a)
├── @simetra/ui                  ← Domain-компоненти: CatalogCombobox, PostButton, DataTable (Phase 3)
├── @simetra/form-runtime        ← JSON → React form renderer (Phase 3)
├── @simetra/app-runtime         ← Unified runtime: fallback shell (Phase 3) + configured mode (Phase 4)
├── @simetra/generator-react     ← Form codegen (.tsx eject) (Phase 4)
└── @simetra/generator-react-app ← Full app codegen (Phase 5)
apps/
├── web/                         ← React SPA (Vite) — основний інтерфейс (Phase 1)
├── desktop/                     ← Tauri 2.0 обгортка web-додатку з нативним FS (Phase 3)
└── vscode/                      ← VS Code extension — sidebar panel (Phase 3)
```

**Ключовий принцип:** `@simetra/core` — це серцевина. Вона не залежить ні від React, ні від Tauri, ні від Node.js API. Чистий TypeScript з Zod. Це дозволяє:
- Використовувати в Web UI (React), CLI (Node.js), Desktop (Tauri), VS Code extension
- Тестувати метамодель незалежно від UI
- Спільний код валідації між усіма клієнтами

**Стратегія доступу до файлової системи:**

Оскільки Phase 1 — це web SPA без серверу, доступ до файлів абстрагований через інтерфейс `StorageProvider`:
- `WebStorage` (Phase 1) — File System Access API (Chrome/Edge) + download/upload fallback для Safari/Firefox
- `TauriStorage` (Phase 3) — нативний FS через Tauri FS API
- `NodeStorage` (Phase 2) — для CLI

**JSON Schema генерується, не пишеться вручну:** `zod-to-json-schema` як build step генерує JSON Schema з Zod-схем пакету `@simetra/core`. Zod є єдиним джерелом правди для структури метаданих.

### 9.3. Layout

```
┌──────────────────────────────────────────────────────────┐
│  [Logo] [Project Name]    [Save] [Generate] [Export]     │  Top Bar
├──────────┬───────────────────────────────┬───────────────┤
│          │  Tab Bar: [Obj1] [Obj2*] [+]  │               │
│  Дерево  ├───────────────────────────────┤  Властивості  │
│  мета-   │                               │  (панель      │
│  даних   │    Вміст активної вкладки      │   context-    │
│          │    (або floating windows       │   sensitive)  │
│  [20%]   │     на canvas)                │  [30%]        │
│          │    [50%]                       │               │
├──────────┴───────────────────────────────┴───────────────┤
│  [Status bar: validation, object count, dirty state]     │
└──────────────────────────────────────────────────────────┘
```

Три панелі — resizable, середня не менше 30%, права — collapsible. Dark theme за замовчуванням.

### 9.4. Ліва панель — дерево метаданих

- Фіксовані кореневі розділи (Довідники, Документи, Перелічення, Регістри відомостей, Регістри накопичення, Константи, Довільні таблиці)
- Глибоке дерево метаданих: 4+ рівні навігації `kind → object → structural group → field`; для табличних частин допускається додатковий рівень `tabular section → field`
- Structural groups залежать від типу об'єкта: Реквізити, Табличні частини, Виміри, Ресурси
- Іконки для кожного типу (hugeicons: Book02Icon для довідників, File02Icon для документів, BarChart01Icon для регістрів накопичення, Database01Icon для регістрів відомостей, Menu01Icon для перелічень, Settings02Icon для констант)
- Контекстне меню: Додати, Перейменувати, Видалити, Дублювати, Показати посилання
- Інкрементний пошук: Ctrl+F → пошукове поле у верхній частині панелі
- Кількість об'єктів у badge біля назви розділу

### 9.5. Центральна панель — редактор та система вікон

Центральна панель поєднує **Tab Bar** зверху і **область вмісту** знизу. Користувач працює з багатьма об'єктами одночасно через два режими відображення:

**Режим "Tabs"** (за замовчуванням) — вкладки у верхній частині центральної панелі, аналогічно вкладкам у браузері. Кожна вкладка = відкрита картка об'єкта. Підтримка pin, close, reorder (drag), dirty indicator (зірочка `*`).

**Режим "Floating"** — картка "від'єднується" від Tab Bar і стає окремим вікном-панеллю всередині viewport (MDI-подібний інтерфейс, як у конфігураторі 1С:Підприємство). Floating windows можна переміщувати, змінювати розмір, мінімізувати, максимізувати. Це дозволяє бачити декілька карток одночасно — наприклад, Документ і Регістр, по якому він здійснює рухи.

**Detach / Attach** — вкладку можна "від'єднати" у floating window (drag за межі Tab Bar або через контекстне меню) і назад (drag на Tab Bar).

Коли вибрано об'єкт у дереві (double-click або Enter) — він відкривається як нова вкладка (або активується, якщо вже відкритий).

**Вміст картки об'єкта:**

**Заголовок:** ім'я об'єкта, тип (badge), кнопка редагування displayName.

**Секції картки об'єкта** — вертикальна навігація зліва від контенту замість горизонтальних вкладок у центральній зоні. Набір секцій залежить від `kind` об'єкта:
- **Catalog** — Основні, Дані, Нумерація, Налаштування
- **Document** — Основні, Дані, Нумерація, Рухи (posting editor — візуальний редактор маппінгів, Phase 2b), Налаштування
- **Enumeration** — Основні, Значення
- **InformationRegister** — Основні, Дані, Налаштування
- **AccumulationRegister** — Основні, Дані, Налаштування
- **Constant** — Основні
- **CustomTable** — Основні, Дані, Налаштування

Секція **Дані** у центральній зоні показує лише структурний вигляд об'єкта (readonly preview) з CRUD-діями для керування елементами. Inline-форми налаштувань у центральній зоні не використовуються.

Всі налаштування об'єкта та його елементів редагуються виключно через праву панель Properties.

### 9.6. Система вікон (Window Management)

Інтерфейс Simetra оптимізований для роботи з великою кількістю одночасно відкритих карток об'єктів — типовий сценарій для конфігуратора метаданих.

**Модель вікон — гібрид Tabs + Floating (MDI):**

| Аспект | Tabs (за замовчуванням) | Floating Windows |
|---|---|---|
| Розташування | Tab Bar у центральній панелі | Вільне розташування у viewport |
| Кількість видимих | Одна активна вкладка | Декілька одночасно |
| Сценарій | Послідовна робота з об'єктами | Порівняння / паралельна робота |
| Аналогія | Браузер | Конфігуратор 1С |

**Операції з вкладками:**
- Open (double-click у дереві, Enter, Ctrl+click)
- Close (×), Close Others, Close All
- Pin / Unpin
- Reorder (drag)
- Detach → Floating Window

**Операції з floating windows:**
- Переміщення (drag за заголовок)
- Зміна розміру (resize handles)
- Мінімізація / Максимізація
- Attach → повернення у Tab Bar

**Синхронізація:** активна вкладка або активне floating window визначає контент правої панелі властивостей. Зміна активного вікна → оновлення Properties Panel.

**Z-index система:** panels(10) → tab-content(20) → floating-windows(30) → dialogs(40) → command-palette(50).

### 9.7. Права панель — властивості

Права панель Properties — єдине місце редагування властивостей об'єктів та полів. `SettingsForm` у центральній зоні не використовується.

Пріоритет контексту:
1. `selectedField` → FieldProperties
2. `selectedObject` → ObjectProperties
3. `activeTab` / `activeWindow` → ObjectProperties
4. Нічого не вибрано → ProjectSettings

Контент залежить від того, що вибрано:
- Вибрано об'єкт у дереві або активній картці → властивості об'єкта (name, displayName, налаштування типу)
- Вибрано поле у структурному вигляді → властивості поля (type, required, indexed, defaultValue, description, ref)

У `ObjectProperties` додані кнопки-посилання **Стандартні реквізити** та **Додаткові індекси**, які відкривають окремі діалогові вікна.

Згруповано через shadcn/ui Accordion: "Основні", "Тип даних", "Обмеження", "Додатково".

### 9.8. Keyboard shortcuts

| Комбінація (Windows / macOS) | Дія |
|---|---|
| Ctrl+K / Cmd+K | Command Palette |
| Ctrl+S / Cmd+S | Зберегти проєкт |
| Ctrl+Z / Cmd+Z | Undo |
| Ctrl+Shift+Z / Cmd+Shift+Z | Redo |
| Ctrl+N / Cmd+N | Новий об'єкт |
| Delete | Видалити вибраний елемент |
| F2 | Перейменувати |
| Ctrl+F / Cmd+F | Пошук по дереву |
| Alt+Enter | Відкрити властивості |

---

## 10. Архітектура генераторів (Phase 2+)

### 10.1. Принцип: генератори — це плагіни

Ядро продукту — це метамодель і UI. Генератори — це окремі модулі, які читають метадані (JSON) і виробляють артефакти для конкретного стеку.

```
Metadata JSON (canonical)
    │
    ├── PostgreSQL SQL Generator  →  DDL, migrations
    ├── EF Core Generator         →  C# entities, DbContext, configurations
    ├── Prisma Generator          →  .prisma schema
    ├── Drizzle Generator         →  TypeScript schema
    ├── TypeScript Types          →  .d.ts files
    └── [Community generators]    →  Django models, Laravel migrations, ...
```

### 10.2. PostgreSQL SQL Generator (перший, вбудований)

**Phase 2a — структурна генерація:**

- `CREATE TABLE` для кожного об'єкта з правильними типами, constraints, FK
- `CREATE TYPE` для перелічень (якщо обрана стратегія pgEnum)
- `CREATE INDEX` для індексованих полів
- `CREATE VIEW` / `CREATE MATERIALIZED VIEW` для віртуальних таблиць регістрів
- Trigger-функцію для автонумерації (якщо autonumber = true)

**Phase 2b — генерація проведення (posting SQL):**

- `post_{document_name}(doc_id uuid)` — функція проведення документа (див. §5.3.1)
- `unpost_{document_name}(doc_id uuid)` — функція скасування проведення
- `check_{register}_{resource}(dims...)` — функція перевірки залишків
- Всі функції доступні як Supabase RPC endpoints через PostgREST

**Phase 2c — міграції:**

- `ALTER TABLE` міграції при зміні метаданих (snapshot-based diff)

**Джерела для реалізації** (ліцензійно безпечні):
- SQL-запити introspection: supabase/pg_meta (Apache 2.0)
- Snapshot diff алгоритм: drizzle-kit (MIT)
- DDL generation patterns: Prisma Engines (Apache 2.0)
- Migration runner: DbUp (MIT)

### 10.3. EF Core Generator (другий, вбудований)

Генерує:
- Entity class для кожного об'єкта
- `IEntityTypeConfiguration<T>` з правильними іменами таблиць, індексами, FK
- DbContext з DbSet для кожного об'єкта
- Migration scaffolding (опціонально)

### 10.4. Інтерфейс плагіна генератора

```typescript
interface MetadataGenerator {
  name: string;
  version: string;
  description: LocalizedString;
  generate(project: ProjectModel, options: GeneratorOptions): GeneratorOutput;
}

interface GeneratorOutput {
  files: Array<{
    path: string;
    content: string;
  }>;
  warnings: string[];
}
```

### 10.5. Генерація UI-форм (Phase 3–4)

Simetra знає все необхідне для генерації форм: типи полів, обов'язковість, зв'язки між об'єктами, табличні частини. Підтримуються три рівні:

**Рівень 1 — Автоформа (zero config).** Генерується повністю з метаданих без додаткової конфігурації.

**Рівень 2 — Візуальний конструктор (Phase 4).** Кастомізація автоформи: переміщення полів, групування у вкладки/секції/колонки, override компонентів. Результат — `*.form.json`.

**Рівень 3 — Export to code / eject (Phase 4).** Генерація повноцінного `.tsx` файлу — React-компонент з shadcn/ui, react-hook-form, Zod-валідацією.

#### 10.5.1. Маппінг типів полів → shadcn/ui компоненти

| Тип поля (Simetra) | shadcn/ui компонент | Умови / override |
|---|---|---|
| String (length ≤ 255) | `<Input />` | — |
| String (length > 255) / Text | `<Textarea />` | — |
| Integer, Numeric | `<Input type="number" />` | Числове форматування |
| Boolean | `<Switch />` | `<Checkbox />` через override |
| Date | `<DatePicker />` | — |
| DateTime | `<DatePicker />` + time input | — |
| Ref (kind=Enumeration) | `<Select />` | `<RadioGroup />` якщо ≤5 значень |
| Ref (kind=Catalog) | `<Combobox />` з пошуком | Autocomplete по довіднику |
| Ref (kind=Document) | `<Combobox />` з пошуком | Autocomplete по документу |
| Ref (polymorphic) | `<Select />` (тип) + `<Combobox />` (значення) | Пара компонентів |
| TabularSection | `<DataTable />` (TanStack Table + shadcn) | Inline edit, add/delete rows |
| Binary | `<FileUpload />` | Кастомний компонент |

**Додаткові правила маппінгу:**
- Стандартні реквізити з `readOnly` ознакою → `<Input readOnly className="bg-muted" />`
- Поля з `required: true` → label з `*`, Zod `.min(1)` або `.nonempty()`
- Поля з `description` → tooltip (shadcn Tooltip) або helper text під полем

#### 10.5.2. Формат файлу форми (`*.form.json`)

Layout описується як дерево елементів. Кожен файл — один тип форми для одного об'єкта. Кожна `formSchema` має `objectRef: MetadataRef` (`{ kind, name }`) для explicit прив'язки до конкретного об'єкта — це canonical зв'язок форми з її об'єктом у `ProjectModel`:

```
metadata/catalogs/counterparties/
├── counterparties.meta.json       # Метадані об'єкта
└── forms/
    ├── item.form.json             # Форма елемента
    ├── list.form.json             # Форма списку
    └── quick-create.form.json     # Спрощена форма
```

Структура `*.form.json`:

```json
{
  "$schema": "https://simetra.dev/schemas/v1/form.schema.json",
  "kind": "ItemForm",
  "objectRef": { "kind": "Catalog", "name": "Counterparties" },
  "title": { "uk": "Контрагент", "en": "Counterparty" },
  "width": "2xl",
  "layout": { },
  "toolbar": [ ],
  "commandBar": [ ]
}
```

#### 10.5.3. Layout-елементи

| Елемент | Опис | shadcn/ui + Tailwind | Дочірні |
|---|---|---|---|
| Field | Одне поле, прив'язане до реквізиту | `<FormField />` + input за типом | Ні |
| Group | Візуальна група з заголовком | `<Card />` або `<fieldset>` | Так |
| Columns | Багатоколонковий layout | `<div className="grid grid-cols-{n} gap-4">` | Column[] |
| Column | Одна колонка | `<div className="space-y-4">` | Так |
| Tabs | Набір вкладок | `<Tabs />` (shadcn) | Tab[] |
| Tab | Одна вкладка | `<TabsContent />` | Так |
| TabularSection | Редагована таблиця | `<DataTable />` (TanStack + shadcn) | Ні |
| Separator | Горизонтальна лінія | `<Separator />` (shadcn) | Ні |
| Label | Статичний текст | `<p className="text-sm text-muted-foreground">` | Ні |
| Accordion | Секція, що згортається | `<Accordion />` (shadcn) | Так |

**Властивості Field:**

| Поле | Тип | Опис |
|---|---|---|
| ref | string | Ім'я реквізиту з метаданих об'єкта (required) |
| label | LocalizedString \| null | Override label (якщо null — береться з displayName реквізиту) |
| component | string \| null | Override компонента (наприклад, `"Textarea"` замість `"Input"`) |
| readOnly | boolean | Тільки для читання |
| autoFocus | boolean | Фокус при відкритті форми |
| placeholder | LocalizedString \| null | Placeholder |
| className | string \| null | Додатковий CSS-клас |
| hidden | boolean | Приховане поле (зберігає значення, але не відображається) |
| visibleWhen | Expression \| null | Умова видимості (Phase 4) |

**Властивості TabularSection:**

| Поле | Тип | Опис |
|---|---|---|
| ref | string | Ім'я табличної частини |
| columns | string[] \| null | Які колонки показувати (null = всі) |
| allowAdd | boolean | Дозволити додавання рядків (default: true) |
| allowDelete | boolean | Дозволити видалення (default: true) |
| allowReorder | boolean | Дозволити зміну порядку (default: false) |

#### 10.5.4. Toolbar і CommandBar

**Toolbar** — кнопки вгорі форми:

| Тип | Опис |
|---|---|
| SaveButton | Зберегти запис |
| SaveAndCloseButton | Зберегти і закрити |
| PostButton | Провести документ (тільки для Document з posting) |
| UnpostButton | Скасувати проведення |
| DeletionMarkButton | Позначити/зняти позначку на видалення |
| Separator | Роздільник |
| CustomButton | Кастомна кнопка з name, label, icon, action |

**CommandBar** — навігаційні посилання внизу форми:

| Тип | Опис |
|---|---|
| NavigationLink | Перехід до пов'язаного списку з фільтром. Приклад: "Документи продажу" → list of SalesOrder where counterparty_id = $id |

#### 10.5.5. Автоформа: алгоритм генерації

Коли форма ще не створена (немає `*.form.json`), Simetra генерує автоформу:

1. Взяти всі attributes об'єкта (без стандартних)
2. Якщо є tabularSections — створити `Tabs`: перша вкладка "Основні" з полями, решта — по одній на кожну ТЧ
3. Якщо немає ТЧ — просто вертикальний список полів
4. Якщо полів > 6 — розбити на 2 колонки
5. Ref-поля: на довідники → `Combobox`, на перелічення → `Select`
6. Toolbar за типом: Catalog → Save + DeletionMark; Document → Save + Post/Unpost + DeletionMark

#### 10.5.6. Runtime-рендерер (`@simetra/form-runtime`, Phase 3)

React-компонент, який зчитує `form.json` + `meta.json` і рендерить повноцінну форму:

```tsx
<SimetraForm
  objectRef={{ kind: "Catalog", name: "Counterparties" }}
  formKind="item"
  metadata={projectMetadata}
  apiClient={supabaseClient}
  recordId={id}
  onSave={handleSave}
/>
```

Рендерер:
- Зчитує метадані об'єкта (`*.meta.json`) — стандартні та кастомні реквізити
- Зчитує форму (`*.form.json`) — layout, toolbar
- Генерує Zod-схему валідації на льоту
- Будує react-hook-form з zodResolver
- Рендерить layout дерево рекурсивно, підставляючи shadcn/ui компоненти
- Для Ref-полів — виконує запити до API (autocomplete/search)
- Для TabularSection — рендерить TanStack Table з inline edit

Зміни у формі (`form.json`) або метаданих (`meta.json`) → миттєве оновлення рендерінгу без перекомпіляції.

#### 10.5.7. Codegen (`@simetra/generator-react`, Phase 4)

Для кожного об'єкта з формою генерується:
- `{object}-form.tsx` — React-компонент з shadcn/ui, react-hook-form, Zod
- `{object}-schema.ts` — Zod-схема валідації
- `{object}-columns.tsx` — column definitions для TanStack Table (для list form)
- `{object}-api.ts` — typed API client (Supabase або generic fetch)

**Бібліотека доменних компонентів `@simetra/ui` (Phase 3):**
- `<CatalogCombobox catalogRef="Products" />` — combobox з пошуком по довіднику
- `<EnumSelect enumRef="OrderStatus" />` — select з значеннями перелічення
- `<EditableDataTable />` — таблиця для табличних частин з inline edit
- `<DocumentNumberInput />` — поле номера з автонумерацією
- `<PostButton />` / `<UnpostButton />` — кнопки проведення з RPC-викликом

#### 10.5.8. Візуальний конструктор форм (`apps/web`, Phase 4)

Візуальний конструктор працює з forms як частиною `ProjectModel` у конфігураторі, а не як окремою файловою системою. Forms є top-level колекцією `model.forms` з `objectRef` зв'язком — конструктор читає і мутує цю колекцію через store, а serializer записує результат у файли `forms/` підкаталогу.

**Layout:**
- Ліва палітра: список нерозміщених полів + layout-елементи (Group, Tabs, Columns, Separator)
- Canvas: структурне представлення форми з рамками елементів. Drag-and-drop через @dnd-kit
- Права панель: властивості вибраного елемента (label override, component override, className, visibility)

**Операції:**
- Drag field з палітри на canvas
- Drag-and-drop для зміни порядку
- Wrap selection у Group/Columns/Tabs
- Delete елемент (повертається у палітру)
- Preview: рендерінг форми через `@simetra/form-runtime`

**Збереження:** зміни зберігаються у `model.forms` колекції `ProjectModel` і серіалізуються canonical serializer-ом у `*.form.json` файли у каталозі `forms/` об'єкта.

#### 10.5.9. Фазування форм

| Крок | Пакет | Фаза |
|---|---|---|
| Zod-схеми для form.json + інтеграція forms у `ProjectModel` | `@simetra/core` | Phase 3 |
| Shared metadata IO layer (parsing + serialization forms) | `@simetra/core` | Phase 3 |
| Алгоритм автоформи | `@simetra/core` | Phase 3 |
| Runtime-рендерер | `@simetra/form-runtime` | Phase 3 |
| Data provider contract + PostgREST adapter | `@simetra/data-provider`, `@simetra/data-provider-postgrest` | Phase 3 |
| Dev preview shell (unified app-runtime, fallback mode) | `@simetra/app-runtime` + `apps/runtime` | Phase 3 |
| Бібліотека доменних компонентів | `@simetra/form-runtime` (domain components) | Phase 3 |
| Codegen React | `@simetra/generator-react` | Phase 4 |
| Візуальний конструктор форм | `apps/web` | Phase 4 |

### 10.6. Генерація каркасу додатку — Application Shell (Phase 4–5)

Після Phase 2–3 Simetra генерує БД + API + форми. Application Shell додає навігацію, маршрутизацію та dashboard.

#### 10.6.1. `application.meta.json`

Файл метаданих рівня проєкту, що описує структуру додатку — підсистеми, навігацію, тему, dashboard:

```json
{
  "$schema": "https://simetra.dev/schemas/v1/application.schema.json",
  "kind": "Application",
  "displayName": { "uk": "Торговий облік", "en": "Trade Accounting" },
  "logo": "assets/logo.svg",
  "theme": {
    "base": "zinc",
    "mode": "system",
    "radius": 0.5,
    "accentColor": "blue"
  },
  "shell": {
    "layout": "SidebarWithHeader",
    "sidebar": {
      "position": "left",
      "collapsible": true,
      "width": 240,
      "showSearch": true
    },
    "header": {
      "showBreadcrumbs": true,
      "showGlobalSearch": true,
      "showUserMenu": true
    }
  },
  "subsystems": [],
  "dashboard": { "widgets": [] }
}
```

#### 10.6.2. Специфікація subsystems[]

| Поле | Тип | Опис |
|---|---|---|
| name | string (snake_case) | Технічне ім'я (→ URL path) |
| displayName | LocalizedString | Назва розділу |
| icon | string | Ім'я іконки (lucide-react) |
| order | number | Порядок у sidebar |
| objects | SubsystemObject[] | Об'єкти в розділі |

**SubsystemObject:**

| Поле | Тип | Опис |
|---|---|---|
| ref | MetadataRef `{ kind, name }` | Посилання на об'єкт метаданих |
| showInList | boolean | Показувати в меню розділу (default: true) |
| listForm | string \| null | Override форми списку (ім'я form.json) |

#### 10.6.3. Dashboard widgets

```json
{
  "dashboard": {
    "widgets": [
      {
        "type": "RecentDocuments",
        "title": { "uk": "Останні документи" },
        "documentTypes": [
          { "kind": "Document", "name": "SalesOrder" }
        ],
        "limit": 10,
        "span": 2
      },
      {
        "type": "RegisterBalance",
        "title": { "uk": "Залишки на складах" },
        "registerRef": { "kind": "AccumulationRegister", "name": "InventoryBalance" },
        "groupBy": ["warehouse"],
        "resource": "quantity",
        "span": 1
      },
      {
        "type": "Counter",
        "title": { "uk": "Неоплачені рахунки" },
        "source": { "kind": "Document", "name": "SalesInvoice" },
        "filter": "posted = true AND paid = false",
        "icon": "AlertCircle",
        "variant": "destructive",
        "span": 1
      }
    ]
  }
}
```

**Типи віджетів (MVP):**

| Тип | Опис | Дані |
|---|---|---|
| RecentDocuments | Список останніх документів | Запит до таблиць документів, сортування по date desc |
| RegisterBalance | Залишки по регістру | View `{register}_balance` |
| Counter | Число з іконкою та підписом | `SELECT count(*) FROM ... WHERE ...` |
| QuickLinks | Набір кнопок швидких дій | Статичний список `{ label, icon, href }[]` |

#### 10.6.4. Shell layouts

| Layout | Опис | Аналогія |
|---|---|---|
| SidebarWithHeader | Sidebar зліва + header зверху | Supabase, Linear |
| TopNavWithTabs | Горизонтальна навігація вгорі | 1С:Fresh, Odoo |
| MinimalSidebar | Іконки без тексту зліва | Slack |

Кожен layout — React-компонент у `@simetra/ui`, параметризований через `application.meta.json`.

#### 10.6.5. Автогенерація маршрутів

З `subsystems[]` і `objects[]` Simetra автоматично генерує маршрути:

```
/                                      → Dashboard
/{subsystem.name}                      → Список об'єктів підсистеми
/{subsystem.name}/{object.name}        → Список записів об'єкта
/{subsystem.name}/{object.name}/new    → Форма створення
/{subsystem.name}/{object.name}/:id    → Форма редагування
/settings                             → Константи / налаштування
```

#### 10.6.6. Стандартні сторінки

**Сторінка списку** — автоматично для кожного об'єкта:
- TanStack Table з колонками з `list.form.json` або автоматично з metadata
- Пошук по displayName полях (code, description для Catalog; number, date для Document)
- Фільтр по періоду (для Document)
- Підтримка ієрархії (для Catalog з hierarchyType ≠ None)
- Кнопка "Створити", bulk-дії

**Сторінка елемента** — обгортка навколо форми (item.form.json):
- Toolbar (Save, Post/Unpost, DeletionMark)
- Breadcrumbs
- Навігація "назад до списку"

**Сторінка констант** — одна форма для всіх констант з підсистеми.

#### 10.6.7. Два режими

**Runtime:** `<SimetraApp metadata={project} apiClient={supabase} />` — один React-компонент, який читає всі JSON-метадані і рендерить повний додаток. Зміни в метаданих → миттєве оновлення UI.

**Codegen (eject):** `simetra generate --target react-app` → повний Next.js/Vite проєкт зі структурою:

```
exported-app/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                    # Dashboard
│   │   └── {subsystem}/
│   │       └── {object}/
│   │           ├── page.tsx            # List
│   │           ├── [id]/page.tsx       # Edit
│   │           └── new/page.tsx        # Create
│   ├── components/
│   │   ├── shell/                      # Sidebar, Header, Breadcrumbs
│   │   ├── forms/                      # Згенеровані форми
│   │   └── lists/                      # Згенеровані списки
│   ├── lib/
│   │   ├── api.ts                      # Supabase client
│   │   └── schemas/                    # Zod-схеми
│   └── simetra.config.json            # Зв'язок з метаданими
├── package.json
└── tailwind.config.ts
```

#### 10.6.8. Зв'язок з бекендом

| Стратегія | Опис | Коли |
|---|---|---|
| Supabase | Simetra створила таблиці в Supabase → PostgREST дає API автоматично. Фронтенд працює через supabase-js | Phase 2–3, основний шлях |
| Generated API | Simetra генерує .NET/Node.js API з метаданих (контролери, сервіси, маршрути) | Phase 5 |
| Embedded | Simetra як Tauri-додаток має вбудований сервер, що працює з локальною PostgreSQL напряму | Phase 5 |

#### 10.6.9. Фазування Application Shell

| Крок | Пакет | Фаза |
|---|---|---|
| Zod-схеми для application.meta.json | `@simetra/core` | Phase 4 |
| Configured shell layouts (TopNavWithTabs, MinimalSidebar) | `@simetra/app-runtime` | Phase 4 |
| Subsystem routing + configured mode | `@simetra/app-runtime` | Phase 4 |
| Dashboard widgets (RecentDocuments, RegisterBalance, Counter, QuickLinks) | `@simetra/app-runtime` | Phase 4 |
| Codegen React App | `@simetra/generator-react-app` | Phase 5 |
| Generated .NET/Node.js API | `@simetra/generator-dotnet` / `generator-node` | Phase 5 |

---

## 11. Нефункціональні вимоги

### 11.1. Продуктивність
- Плавна робота з проєктами до 200 об'єктів і 5000 полів сумарно
- Дерево метаданих — миттєве розгортання/згортання (< 16ms)
- Збереження проєкту — менше 1 секунди
- Генерація SQL — менше 5 секунд для проєкту з 200 об'єктами

### 11.2. Портативність
- Web SPA (Phase 1): працює в Chrome, Firefox, Safari, Edge (останні 2 мажорні версії). File System Access API для повноцінної роботи з файлами (Chrome/Edge), download/upload fallback (інші браузери)
- Tauri desktop (Phase 3): Windows 10+, macOS 12+, Ubuntu 22.04+ — нативний FS, file dialogs
- VS Code extension (Phase 3): будь-яка платформа з VS Code 1.85+
- Метадані: read/write без серверу (файлова система або browser storage)

### 11.3. Якість коду
- TypeScript strict mode
- Розділення: metadata model / UI rendering / generation logic (монорепо-пакети)
- Zustand store typed через Zod schemas
- CI: lint (ESLint 9 flat config), format (Prettier), type check, unit tests (Vitest)

### 11.4. Git-friendliness
- Детерміністична серіалізація JSON (sorted keys, 2-space indent, trailing newline)
- Один файл на об'єкт — мінімальний diff при зміні одного об'єкта
- Ніяких автогенерованих timestamp-ів у файлах метаданих
- JSON Schema валідація у CI/CD

### 11.5. Розширюваність
- Нові типи метаданих додаються через Metadata Type Registry без переписування UI
- Нові генератори — через plugin interface
- Нові типи полів — через розширення FieldType enum

### 11.6. Доступність
- Повна клавіатурна навігація
- ARIA-атрибути для дерева та таблиці
- Підтримка screen reader для ключових операцій

---

## 12. Стратегія доставки

### Phase 1 — Web UI Prototype

**Ціль:** Валідувати layout, взаємодію та метамодель. Web-first — додаток працює у браузері без серверу.

**Результат:**
- React SPA (Vite) — 3-panel layout з деревом, таблицею полів, панеллю властивостей
- `@simetra/core` — Zod-схеми, типи, валідація як окремий пакет
- Всі 7 типів метаданих MVP у дереві
- Створення, редагування, видалення об'єктів
- Стандартні реквізити для кожного типу (readonly)
- Налаштування типу (ієрархія для довідників, registerType для регістрів)
- Ролі полів для регістрів (dimension/resource/attribute)
- Табличні частини для довідників і документів
- Збереження/завантаження проєкту через File System Access API (Chrome/Edge) + download/upload fallback (Safari/Firefox)
- Undo/Redo
- Command Palette
- Пошук по дереву

**Не включено:** генерація, підключення до БД, schema introspection, Tauri desktop, VS Code extension.

### Phase 2a — DDL Generator + SQL Preview

**Ціль:** Перетворити метадані на PostgreSQL-схему та показати результат.

**Результат:**
- `@simetra/generator-pg` — новий пакет: CREATE TABLE, INDEX, FK, ENUM types для всіх 7 типів метаданих
- View/materialized view для регістрів (залишки, обороти, зріз останніх)
- Trigger для автонумерації (Catalog, Document)
- `@simetra/generator-api` — інтерфейс MetadataGenerator
- SQL Preview UI: кнопка "Generate" → syntax-highlighted preview → download/copy
- Validation перед генерацією (referential integrity, обов'язкові поля)
- `@simetra/cli` — CLI: `simetra generate --target postgresql`

### Phase 2b — Posting Engine

**Ціль:** Декларативний маппінг проведення документів і генерація SQL-функцій.

**Результат:**
- Zod-схеми `posting` секції у `@simetra/core` (movements, validations, mapping expressions)
- Генерація `post_`/`unpost_`/`check_` SQL-функцій у `@simetra/generator-pg`
- Візуальний editor маппінгів у `apps/web`: dropdown-based маппінг полів документа на виміри/ресурси регістру (MVP); drag-drop лінії як enhancement
- SQL-функції доступні як Supabase RPC endpoints через PostgREST

### Phase 2c — Deployment Adapter + Schema Diff

**Ціль:** Задеплоїти згенерований SQL і підтримувати еволюцію схеми.

**Результат:**
- Supabase як перший deployment target (Edge Function proxy для Apply)
- Connection settings у Project Settings (URL, API key — не в метаданих)
- Schema snapshot + diff: порівняння new DDL vs applied state
- Генерація ALTER TABLE замість CREATE TABLE для існуючих об'єктів
- Destructive changes (DROP) з explicit confirmation

### Phase 3 — Form Runtime + Domain Components

**Ціль:** Runtime-рендерінг форм з JSON-метаданих і бібліотека domain-компонентів.

**Результат:**
- **Zod-схеми для `form.json`** — layout-елементи (Field, Group, Columns, Tabs, TabularSection, Separator, Accordion)
- **Алгоритм автоформи** — zero-config генерація форми з метаданих об'єкта:
  - Маппінг типів полів → shadcn/ui компоненти (String→Input, Ref(Catalog)→Combobox, Boolean→Switch тощо)
  - Якщо полів > 6 → 2 колонки; якщо є ТЧ → Tabs
- **`@simetra/form-runtime`** — React-компонент `<SimetraForm>`, який читає `*.form.json` + `*.meta.json` і рендерить форму на льоту (react-hook-form + zodResolver + shadcn/ui)
- **`@simetra/ui`** — domain-компоненти: `<CatalogCombobox>`, `<EnumSelect>`, `<EditableDataTable>`, `<DocumentNumberInput>`, `<PostButton>`, `<UnpostButton>`
- **`computedFields` у TabularSection** — формули автоперерахунку (§5.8)
- **Desktop (Tauri 2.0)** — обгортка web-додатку з нативним FS (Windows, macOS, Linux)
- **VS Code extension** — sidebar panel з деревом метаданих у webview
- Schema introspection, live DB connection, import існуючої БД

### Phase 4 — Application Shell + Visual Form Designer

**Ціль:** Повний каркас додатку і візуальний конструктор форм.

**Результат:**
- **`application.meta.json`** — новий файл метаданих рівня проєкту:
  - Підсистеми (subsystems) — логічне групування об'єктів у розділи
  - Shell layout (SidebarWithHeader, TopNavWithTabs, MinimalSidebar)
  - Dashboard з типізованими віджетами (RecentDocuments, RegisterBalance, Counter, QuickLinks)
  - Тема (base color, mode, radius, accent)
- **Автогенерація маршрутів** з subsystems: `/{subsystem}/{object}`, `/{subsystem}/{object}/:id`
- **`@simetra/app-runtime`** — `<SimetraApp>` рендерить повний додаток з JSON-метаданих
- **Візуальний конструктор форм** у `apps/web`: палітра полів + canvas + drag-and-drop (@dnd-kit)
- **Codegen React (eject):** `@simetra/generator-react` → `.tsx` файли з shadcn/ui, react-hook-form, Zod
- **Advanced Modeling:** ChartOfAccounts, AccountingRegister, Schema Visualizer (React Flow)

### Phase 5 — Platform + Full App Codegen

**Ціль:** Повноцінний low-code app builder з codegen-eject.

**Результат:**
- `@simetra/generator-react-app` — повний Next.js/Vite проєкт (shell, forms, lists, routing)
- Generated .NET/Node.js API з метаданих (контролери, сервіси, маршрути)
- Бізнес-процеси та Задачі
- Embedded server mode (Tauri + local PostgreSQL)
- Плагінна архітектура для генераторів
- Cloud-версія з колаборацією

---

## 13. Обмеження та ризики

### 13.1. Обмеження

1. PostgreSQL — єдина підтримувана СУБД на старті. Архітектура дозволяє інші, але реалізація — тільки PG
2. Метамодель підтримує тільки вбудовані типи метаданих — кастомні типи не в scope MVP
3. Генератори в Phase 2a не виконують SQL — тільки генерують файли. Phase 2c додає Supabase Apply Adapter для виконання
4. Phase 1–2: продукт не виконує бізнес-логіку — це інструмент проєктування та генерації. Phase 3+ додає runtime-рендерінг форм

### 13.2. Ризики

| Ризик | Ймовірність | Вплив | Мітигація |
|---|---|---|---|
| Спроба повторити всю функціональність 1С занадто рано | Висока | Критичний | Жорсткий scope MVP: тільки 7 типів, тільки метадані, без runtime |
| Метамодель виявиться недостатньо гнучкою для генерації | Середня | Високий | JSON Schema з x-розширеннями, schemaVersion для еволюції |
| Низьке adoption через вузьку нішу (1С-розробники на сучасних стеках) | Середня | Високий | Позиціонувати ширше: для всіх, хто будує облікові системи, не тільки ex-1С |
| Складність UI для дерева з DnD та inline editing | Середня | Середній | react-arborist як перевірене рішення, Phase 1 без DnD |
| Конфлікти merge у JSON-файлах при командній роботі | Низька | Середній | Один файл на об'єкт, сортовані ключі, canonical JSON |
| Високий обсяг JSON Schema підтримки (7+ схем у MVP, 12+ у Phase 4) | Середня | Середній | Генерація JSON Schema з Zod-схем (zod-to-json-schema) — Zod як single source of truth |
| Tauri 2.0 екосистема плагінів ще молода | Низька | Низький | Web-first стратегія: Tauri — Phase 3, не блокує MVP. Валідувати file dialogs, FS watcher перед інтеграцією |
| File System Access API не підтримується у Safari/Firefox | Середня | Середній | Download/upload fallback для браузерів без FS Access API; повноцінна робота в Chrome/Edge |

---

## 14. Юридичні аспекти

### 14.1. Ліцензія продукту

**Apache License 2.0** — обрана на основі аналізу 18 порівнянних проєктів:
- Явний патентний грант (критично для бізнес-інструменту)
- Індустріальний стандарт серед аналогів (Prisma, Drizzle, Supabase, Amplication)
- Сумісність з GPL v3
- Корпоративне прийняття

### 14.2. Внески

**DCO (Developer Certificate of Origin)** замість CLA:
- Мінімальний бар'єр для контриб'юторів
- Достатній захист у поєднанні з Apache 2.0
- Індустріальний тренд (Linux kernel, Docker, GitLab)
- Автоматизація через DCO Bot для GitHub

### 14.3. Термінологія 1С

Терміни "довідник", "документ", "регістр накопичення", "табличні частини", "проведення" є загальними функціональними термінами бухгалтерського домену і вільно використовуються (доктрина scènes à faire, рішення SAS Institute v. World Programming Ltd).

Назва "1С" **не використовується** в назві продукту. У документації — формулювання "натхненний концепціями 1С:Підприємство" з дисклеймером.

### 14.4. Запозичення коду

Безпечні джерела (Apache 2.0 / MIT):
- supabase/pg-meta — SQL introspection запити
- frappe/frappe — lifecycle patterns
- prisma/prisma-engines — schema diff concepts
- drizzle-kit — snapshot diff
- holistics/dbml — DSL parser (якщо знадобиться)
- DbUp — migration runner

Тільки ідеї (copyleft):
- ERPNext, Odoo, DrawDB, pgModeler, NocoDB, Directus, BSL Language Server, MDClasses

Файл THIRD-PARTY-NOTICES для attribution запозиченого коду.

---

## 15. Критерії успіху

### Phase 1 (Web UI Prototype)

1. Користувач може створити проєкт і додати 7 типів об'єктів без написання коду
2. Стандартні реквізити відображаються автоматично і відповідають специфікації 1С
3. Регістри мають ролі полів (dimension/resource/attribute)
4. Модель зберігається/завантажується як JSON-файли
5. Формат JSON стабільний для Git (мінімальні дифи при однакових змінах)
6. Undo/Redo працює для всіх операцій
7. Додаток працює у браузері без встановлення (web SPA)

### Phase 2 (Generation)

1. Згенерований DDL створює валідну PostgreSQL-схему
2. Регістри отримують view для залишків/оборотів
3. CLI працює без UI (headless generation)
4. Функції проведення (post/unpost) коректно маплять поля документа на регістри
5. Supabase Apply працює енд-ту-енд: Generate → Apply → REST API auto-created
6. Schema diff коректно обробляє додавання/видалення полів

### Загальний успіх продукту

1. 100+ зірок на GitHub протягом 3 місяців після публічного релізу
2. Хоча б 3 community-генератори (для різних стеків)
3. Використання у реальному проєкті (dogfooding на AutoHUB або DoxyHub)
4. Хоча б 10 користувачів створили проєкт з ≥10 об'єктами (метрика реального використання)

---

## 16. Відкриті питання

### Вирішені питання

- ~~**Назва продукту**~~ → **Simetra**. GitHub repo: `Simetra`, npm scope: `@simetra/*`, CLI command: `simetra`, домен: `simetra.dev`.
- ~~**Мова ядра конфігуратора**~~ → **TypeScript** для всього бізнес-ядра (core, generators, UI, CLI). Rust мінімальний — тільки Tauri commands для FS у Phase 3. Обґрунтування: єдина кодова база, Zod як shared source of truth, відсутність потреби в Rust-performance для проєктів до 200 об'єктів.
- ~~**Стратегія зберігання стану**~~ → **Zustand** (in-memory) з серіалізацією у файлову систему через абстракцію `StorageProvider` при Save. Phase 1: `WebStorage` (File System Access API + download/upload fallback). Phase 3: `TauriStorage` (нативний FS).
- ~~**Як обробляти compound types**~~ → Єдиний тип `Ref` з двома режимами: single ref (`ref: { kind, name }`) і polymorphic ref (`allowedTypes: [{ kind, name }, ...]`). `ref` і `allowedTypes` — взаємовиключні. Polymorphic ref генерується як `{field}_type` + `{field}_id` (Dynamic Link pattern).
- ~~**Web vs Desktop first**~~ → **Web-first**. Phase 1 — React SPA у браузері, без серверу. Tauri desktop та VS Code extension — Phase 3. Обґрунтування: нижчий бар'єр для adoption (не потрібно встановлювати), швидший прототип, спільний код між усіма платформами.
- ~~**Як генерувати код проведення**~~ → **Декларативний mapping** у секції `posting` метаданих документа (§5.3.1). Покриває 90% шаблонних випадків. Для складної логіки — точка розширення `_post_custom()`.

### Потребують рішення до Phase 2

4. **Формат міграцій** — SQL-файли (як Drizzle/Prisma) чи C# класи (як EF Core)?
6. **Стратегія для регістрів бухгалтерії** — чи потрібен Plan of Accounts як prerequisite, чи можна спростити?

### Архітектурні (можуть чекати)

7. **Чи потрібна підтримка кастомних типів метаданих** (user-defined entity kinds)?

---

## 17. Дисклеймер

> Цей проєкт не пов'язаний, не схвалений і не асоційований з компанією 1С або її продуктами. «1С» та «1С:Підприємство» є зареєстрованими товарними знаками. Цей проєкт є незалежним open-source інструментом, натхненним концепціями конфігуратора 1С:Підприємство.
