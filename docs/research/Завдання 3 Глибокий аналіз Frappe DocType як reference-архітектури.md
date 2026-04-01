# Архітектура DocType у Frappe Framework: глибокий технічний аналіз для BRD метаданих-конфігуратора

**Frappe Framework — найближчий open-source аналог metadata-driven підходу 1С:Підприємство.** Кожен бізнес-об'єкт у Frappe описується як DocType — JSON-файл метаданих, з якого платформа автоматично генерує SQL-таблиці, REST API, UI-форми та Python-контролери. Цей документ розкриває архітектуру DocType у деталях, достатніх для проєктування власної метамоделі. Ключовий висновок: Frappe реалізує **80% підходу 1С** на рівні платформи, але критично бракує механізму регістрів — головної архітектурної переваги 1С, яку наш продукт має реалізувати як first-class примітив.

---

## 1. Анатомія DocType: JSON як єдине джерело істини

Кожен DocType у Frappe зберігається як JSON-файл у структурі каталогів додатку:

```
{app}/{module}/doctype/{doctype_name}/
  ├── {doctype_name}.json     # Метадані (схема)
  ├── {doctype_name}.py       # Python-контролер
  ├── {doctype_name}.js       # Клієнтський скрипт
  ├── {doctype_name}_list.js  # Кастомізація списку
  └── test_{doctype_name}.py  # Тести
```

**Верхньорівневі ключі JSON-файлу** визначають поведінку об'єкта. Ось спрощений приклад структури Sales Invoice:

```json
{
  "name": "Sales Invoice",
  "doctype": "DocType",
  "module": "Accounts",
  "engine": "InnoDB",
  "naming_rule": "By naming series",
  "autoname": "naming_series:",
  "is_submittable": 1,
  "issingle": 0,
  "istable": 0,
  "is_tree": 0,
  "is_virtual": 0,
  "track_changes": 1,
  "allow_import": 1,
  "title_field": "title",
  "search_fields": "posting_date, debit_to, customer, outstanding_amount",
  "fields": [ ... ],
  "permissions": [ ... ],
  "links": [],
  "actions": [],
  "states": []
}
```

Таблиця критичних властивостей DocType:

| Властивість | Тип | Призначення |
|---|---|---|
| `is_submittable` | Check | Вмикає lifecycle Draft→Submitted→Cancelled (аналог проведення) |
| `issingle` | Check | Один запис на DocType (аналог констант/налаштувань) |
| `istable` | Check | Child-таблиця (табличні частини) |
| `is_tree` | Check | Ієрархічна структура (nested set model) |
| `is_virtual` | Check | Без фізичної таблиці в БД |
| `naming_rule` | Select | Алгоритм іменування (Series, Hash, Prompt, тощо) |
| `autoname` | Data | Вираз для автонумерації |
| `track_changes` | Check | Версіонування змін документу |

### Системні поля: невидимий каркас кожної таблиці

Frappe автоматично додає **10 стандартних полів** до кожної SQL-таблиці. Вони **не вказуються** в масиві `fields` JSON-файлу, але завжди присутні в базі:

| Поле | SQL-тип | Призначення | Аналог 1С |
|---|---|---|---|
| `name` | `VARCHAR(140)` PK | Унікальний ідентифікатор (рядок, не UUID!) | `Ссылка/Ref` |
| `creation` | `DATETIME(6)` | Дата створення | `ДатаСоздания` |
| `modified` | `DATETIME(6)` | Дата останньої зміни (індексоване) | — |
| `modified_by` | `VARCHAR(140)` | Хто змінив останнім | — |
| `owner` | `VARCHAR(140)` | Хто створив | `Автор` |
| `docstatus` | `INT(1)` | Статус: 0=Draft, 1=Submitted, 2=Cancelled | `Проведен` |
| `parent` | `VARCHAR(140)` | Для child-рядків: `name` батьківського документа | Аналог зв'язку табличної частини |
| `parentfield` | `VARCHAR(140)` | Ім'я поля Table у батьку | — |
| `parenttype` | `VARCHAR(140)` | DocType батьківського документу | — |
| `idx` | `INT(8)` | Порядковий індекс рядка | `НомерСтроки` |

Додатково платформа створює **4 службові текстові колонки**: `_user_tags`, `_comments`, `_assign`, `_liked_by` — для тегів, коментарів, призначень та лайків.

**Архітектурне рішення**: `name` — це `VARCHAR(140)`, а не UUID чи auto-increment. Це означає, що primary key — людиночитаний рядок (наприклад, `SINV-2024-00001`), що зручно для бізнес-користувачів, але створює обмеження на продуктивність при великих обсягах даних.

---

## 2. Система типів полів: 37+ типів від Data до Dynamic Link

Frappe надає розгалужену систему типів полів, кожен з яких маппиться на конкретний SQL-тип колонки. Усі типи можна розділити на чотири категорії.

### Поля введення даних

| Fieldtype | SQL-тип | Опис | `options` |
|---|---|---|---|
| **Data** | `VARCHAR(140)` | Текстовий рядок | `"Email"`, `"Phone"`, `"URL"` — валідація |
| **Int** | `INT(11)` | Ціле число | — |
| **Float** | `DECIMAL(18,6)` | Десяткове число | — |
| **Currency** | `DECIMAL(18,6)` | Грошова сума | Посилання на поле з валютою |
| **Percent** | `DECIMAL(18,6)` | Відсоток | — |
| **Check** | `INT(1)` | Boolean 0/1 | — |
| **Date** | `DATE` | Дата | — |
| **Datetime** | `DATETIME(6)` | Дата і час з мікросекундами | — |
| **Time** | `TIME(6)` | Час | — |
| **Select** | `VARCHAR(140)` | Випадаючий список | Значення через `\n` |
| **Small Text** | `TEXT` | Текст | — |
| **Text** | `TEXT` | Текст | — |
| **Long Text** | `LONGTEXT` | Великий текст | — |
| **Text Editor** | `LONGTEXT` | WYSIWYG-редактор | — |
| **Code** | `LONGTEXT` | Редактор коду | `"Python"`, `"JavaScript"`, `"JSON"` |
| **Password** | `VARCHAR(140)` | Зашифрований пароль | — |
| **Color** | `VARCHAR(140)` | Hex-колір | — |
| **JSON** | `JSON` | JSON-дані | — |

### Поля зв'язків (relationship fields) — ключова архітектура

| Fieldtype | SQL-тип | Опис |
|---|---|---|
| **Link** | `VARCHAR(140)` | Посилання на інший DocType (аналог `СправочникСсылка.X`) |
| **Dynamic Link** | `VARCHAR(140)` | Поліморфне посилання (тип визначається іншим полем) |
| **Table** | *(без колонки)* | Табличні частини — вбудовує Child DocType |
| **Table MultiSelect** | *(без колонки)* | Множинний вибір через child-таблицю |

### Як працює Link-поле (аналог посилальних типів 1С)

Link-поле — це серце реляційної моделі Frappe. Визначення в JSON:

```json
{
  "fieldname": "customer",
  "fieldtype": "Link",
  "label": "Customer",
  "options": "Customer",
  "reqd": 1,
  "search_index": 1
}
```

**Критичний факт**: Frappe **не створює SQL FOREIGN KEY constraints**. Валідація посилальної цілісності відбувається виключно на рівні Python-коду (`get_invalid_links()`). При збереженні документа фреймворк перевіряє, що вказаний `name` існує в цільовій таблиці, а для submittable-типів — що він не скасований. Це архітектурне рішення дає гнучкість, але ціною відсутності гарантій на рівні СУБД.

**Dynamic Link** реалізує поліморфні посилання (аналог складеного типу 1С):

```json
{
  "fieldname": "party_type",
  "fieldtype": "Link",
  "options": "DocType"
},
{
  "fieldname": "party",
  "fieldtype": "Dynamic Link",
  "options": "party_type"
}
```

Тут `party_type` може містити `"Customer"` або `"Supplier"`, а `party` — конкретний `name` із відповідної таблиці.

### Механізм fetch_from — автозаповнення з пов'язаного документа

```json
{
  "fieldname": "customer_name",
  "fieldtype": "Data",
  "fetch_from": "customer.customer_name",
  "read_only": 1
}
```

При виборі клієнта поле `customer_name` автоматично заповнюється значенням з документа Customer. Це аналог механізму `ПриИзмененииРеквизитаЗаполнить` у 1С.

### Властивості поля (DocField attributes)

Кожне поле в масиві `fields` має десятки атрибутів, що визначають його поведінку:

```json
{
  "fieldname": "grand_total",
  "fieldtype": "Currency",
  "label": "Grand Total",
  "options": "currency",
  "read_only": 1,
  "bold": 1,
  "in_list_view": 1,
  "in_standard_filter": 0,
  "reqd": 0,
  "unique": 0,
  "hidden": 0,
  "no_copy": 0,
  "allow_on_submit": 0,
  "permlevel": 0,
  "depends_on": "eval:doc.items.length > 0",
  "mandatory_depends_on": "",
  "non_negative": 1,
  "print_hide": 0,
  "translatable": 0
}
```

Ключові атрибути: `depends_on` (умовна видимість через eval-вирази), `fetch_from` (автозаповнення), `permlevel` (рівень доступу), `allow_on_submit` (можливість редагування після проведення).

---

## 3. Child Table: реалізація табличних частин

Child DocType — це аналог **табличних частин** 1С. Визначається через прапорець `istable: 1` і має принципові відмінності від звичайного DocType.

### Визначення та структура

```json
{
  "name": "Sales Invoice Item",
  "module": "Accounts",
  "istable": 1,
  "editable_grid": 1,
  "permissions": [],
  "fields": [
    {
      "fieldname": "item_code",
      "fieldtype": "Link",
      "options": "Item",
      "in_list_view": 1,
      "reqd": 1
    },
    {
      "fieldname": "qty",
      "fieldtype": "Float",
      "label": "Quantity",
      "in_list_view": 1,
      "reqd": 1,
      "default": "1"
    },
    {
      "fieldname": "rate",
      "fieldtype": "Currency",
      "in_list_view": 1
    },
    {
      "fieldname": "amount",
      "fieldtype": "Currency",
      "in_list_view": 1,
      "read_only": 1
    }
  ]
}
```

Зв'язок із батьківським DocType створюється через поле типу `Table`:

```json
{
  "fieldname": "items",
  "fieldtype": "Table",
  "label": "Items",
  "options": "Sales Invoice Item",
  "reqd": 1
}
```

### Як зберігаються дані

Кожен Child DocType отримує **окрему SQL-таблицю** (наприклад, `tabSales Invoice Item`) зі стандартними полями `parent`, `parentfield`, `parenttype`, `idx`. При завантаженні документа через `frappe.get_doc()` дані всіх child-таблиць завантажуються автоматично:

```python
invoice = frappe.get_doc('Sales Invoice', 'SINV-00001')
# invoice.items — це список об'єктів Sales Invoice Item
# Кожен рядок має: parent='SINV-00001', parenttype='Sales Invoice',
#                   parentfield='items', idx=1,2,3...
```

### Ключові обмеження child-таблиць

- **Заборонено вкладені child-таблиці** — child DocType не може містити поле типу Table. Це жорстке обмеження, яке спільнота критикує роками (GitHub Issues #17503, #23307, #36467), але воно не знято станом на v16.
- **Немає власних дозволів** — успадковуються від батька.
- **Немає самостійного доступу** — не відображаються в списках Desk, не мають окремого REST endpoint.
- **Обмеження колонок у grid** — до v16 відображалось лише 10 колонок без горизонтального скролу.
- **Продуктивність** — при 1000+ рядках спостерігається значна деградація.

---

## 4. Автоматична генерація з метаданих: від JSON до працюючої системи

Це серце metadata-driven підходу Frappe. З одного JSON-файлу платформа автоматично створює повний стек.

### SQL-таблиці: маппінг fieldtype → column type

При збереженні DocType (або виконанні `bench migrate`) клас `DBTable` у `frappe/database/schema.py` генерує або оновлює SQL-таблицю:

```sql
CREATE TABLE `tabSales Invoice` (
  `name` varchar(140) PRIMARY KEY,
  `creation` datetime(6),
  `modified` datetime(6),
  `modified_by` varchar(140),
  `owner` varchar(140),
  `docstatus` int(1) NOT NULL DEFAULT 0,
  `idx` int(8) NOT NULL DEFAULT 0,
  -- Для child-таблиць додатково:
  `parent` varchar(140),
  `parentfield` varchar(140),
  `parenttype` varchar(140),
  INDEX `parent`(`parent`),
  -- Кастомні поля з DocType JSON:
  `customer` varchar(140),
  `posting_date` date,
  `grand_total` decimal(18,6),
  ...
  INDEX `modified`(`modified`)
) ENGINE=InnoDB;
```

**Критичне правило**: при видаленні поля з DocType колонка в БД **ніколи не видаляється автоматично** — це захист від втрати даних, але призводить до накопичення orphaned-колонок.

### Schema sync через bench migrate

Процес `bench migrate` виконує:

1. Виконання `before_migrate` хуків
2. Запуск патчів з `patches.txt` (секції `[pre_model_sync]` та `[post_model_sync]`)
3. **Синхронізація схеми** — порівняння MD5-хешу JSON-файлу DocType із збереженим хешем. Якщо хеші відрізняються, DocType перезавантажується
4. Синхронізація fixtures (Custom Fields, Property Setters)
5. Оновлення перекладів та пошукового індексу
6. Виконання `after_migrate` хуків

Алгоритм синхронізації таблиці (`DBTable.sync()`): зчитує поточні колонки через `DESCRIBE`, порівнює з очікуваними з метаданих, і для кожної колонки виконує `ADD COLUMN`, `MODIFY COLUMN`, або створює/видаляє індекси. **Зворотних міграцій не існує.**

### REST API: повний CRUD без рядка коду

Frappe автоматично створює REST endpoints для кожного DocType:

| Операція | HTTP | URL |
|---|---|---|
| Створити | `POST` | `/api/resource/Sales Invoice` |
| Прочитати | `GET` | `/api/resource/Sales Invoice/SINV-00001` |
| Список | `GET` | `/api/resource/Sales Invoice?filters=[["status","=","Unpaid"]]` |
| Оновити | `PUT` | `/api/resource/Sales Invoice/SINV-00001` |
| Видалити | `DELETE` | `/api/resource/Sales Invoice/SINV-00001` |

Фільтрація підтримує оператори `=`, `!=`, `>`, `<`, `like`, `in`, `between`, `is`. Пагінація — через `limit_start` та `limit_page_length`. Вибірка полів — `fields=["name","customer","grand_total"]`. Усі endpoints автоматично перевіряють дозволи згідно з ролями користувача.

Додатково: будь-який Python-метод, декорований `@frappe.whitelist()`, стає доступним як RPC endpoint через `/api/method/{dotted.path}`.

### UI-форми: рендеринг з метаданих на клієнті

Коли користувач відкриває `/app/sales-invoice/SINV-00001`, клієнтський SPA (Desk) завантажує метадані DocType і дані документа, потім рендерить форму:

1. `frappe.get_meta()` завантажує метадані (кешовані)
2. `frappe.ui.form.Layout` організує поля за `Section Break` / `Column Break` / `Tab Break`
3. Для кожного поля створюється відповідний контрол (`ControlLink`, `ControlData`, `ControlTable` тощо)
4. Поля типу `Table` рендеряться як `frappe.ui.form.Grid` — інтерактивна таблиця
5. Завантажуються клієнтські скрипти (`{doctype}.js`)

### Controller-класи та lifecycle hooks

Кожен DocType може мати Python-контролер:

```python
# erpnext/accounts/doctype/sales_invoice/sales_invoice.py
class SalesInvoice(AccountsController):
    def validate(self):
        self.validate_items()
        self.calculate_totals()

    def on_submit(self):
        self.make_gl_entries()

    def on_cancel(self):
        self.reverse_gl_entries()
```

**Повний порядок виконання hooks при створенні нового документа:**

```
before_naming → autoname → before_insert → before_validate → validate
→ before_save → db_insert → after_insert → on_update → on_change → after_save
```

**При проведенні (submit):**

```
before_submit → on_submit → on_update_after_submit (при наступних змінах)
```

**При скасуванні (cancel):**

```
before_cancel → on_cancel
```

Зовнішні додатки можуть підключатися до hooks будь-якого DocType через `hooks.py`:

```python
doc_events = {
    "Sales Invoice": {
        "on_submit": "custom_app.events.on_submit_handler",
    },
    "*": {  # Для ВСІХ DocTypes
        "on_update": "custom_app.events.track_all_updates",
    }
}
```

---

## 5. Submit/Cancel та Amended Document: аналог проведення 1С

### Машина станів docstatus

Для DocTypes з `is_submittable=1` діє сувора однонаправлена машина станів:

```
Draft (0) → Submitted (1) → Cancelled (2)
                                   ↓
                            Amend → New Draft (0) з суфіксом -1
```

**Принципова відмінність від 1С**: перехід назад неможливий. Проведений документ не можна «відпровести» і повернути в чернетку — лише скасувати та створити новий через Amend.

При **проведенні** (`doc.submit()`): `docstatus` змінюється на 1, спрацьовує `on_submit`, в ERPNext — створюються GL Entry / Stock Ledger Entry. Усі поля блокуються, окрім тих, де `allow_on_submit=1`.

При **скасуванні**: `docstatus` стає 2, `on_cancel` виконує зворотні проводки. **Обов'язкова умова**: всі залежні downstream-документи мають бути скасовані першими (щоб скасувати Sales Order, спочатку треба скасувати Delivery Note та Sales Invoice).

**Amended Document**: при створенні виправлення `frappe.copy_doc()` створює нову чернетку з суфіксом (`SINV-00001` → `SINV-00001-1`), поле `amended_from` вказує на скасований оригінал. Листування, коментарі та частина вкладень **не копіюються** — це відомий біль спільноти.

### Порівняння з проведенням 1С

| Аспект | Frappe Submit/Cancel | 1С Проведення/Відміна |
|---|---|---|
| Машина станів | `0→1→2`, суворо лінійна | Гнучка: можна відпровести, змінити, перепровести |
| Зворотність | Неможлива — тільки Cancel+Amend | Відміна проведення → редагування → перепроведення |
| Збереження номера | Номер змінюється (суфікс -1) | Той самий документ, той самий номер |
| Регістрові рухи | ERPNext створює GL Entry через Python | Платформа атомарно створює/видаляє рухи регістрів |
| Каскадне скасування | Обов'язкове для downstream | Рухи можна відмінити незалежно |

**Висновок для нашого продукту**: система 1С суттєво зручніша для користувача. Наш продукт повинен реалізувати `post()`/`unpost()` з атомарним зв'язком із регістровими рухами та можливістю повернення в чернетку.

### Workflow Engine

Frappe має окремий Workflow DocType, що накладає довільну машину станів поверх docstatus:

```
Draft (docstatus=0) → Pending Approval (docstatus=0) → Approved (docstatus=1)
                                                      → Rejected (docstatus=0)
```

Workflow визначає стани (`Workflow State`), переходи (`Workflow Transition`) з ролями та умовами (`condition: doc.grand_total > 100000`), та дії (`Workflow Action`). Стани маппяться на docstatus — перехід у стан з `doc_status=1` автоматично виконує submit.

---

## 6. Naming Series: нумератори Frappe

Система автоіменування в Frappe обробляється модулем `frappe/model/naming.py` з чіткою пріоритизацією:

1. Якщо документ amended → суфікс `-1`, `-2`
2. Метод `doc.autoname()` контролера
3. Властивість `autoname` з метаданих DocType
4. Document Naming Rules
5. Fallback → **hash** (10-символьний рядок)

### Формати autoname

| Формат | Приклад конфігу | Результат |
|---|---|---|
| `naming_series:` | `ACC-SINV-.YYYY.-.####` | `ACC-SINV-2024-0001` |
| `field:customer_name` | — | Значення поля `customer_name` |
| `format:INV-{customer}-{YYYY}-{####}` | — | `INV-ACME-2024-0001` |
| `prompt` | — | Користувач вводить вручну |
| `hash` | — | Рандомний 10-символьний рядок |
| `autoincrement` | — | SQL auto-increment integer |

Патерн серії розбирається по крапках: `####` — лічильник (кількість `#` = кількість нулів), `YYYY`/`YY` — рік, `MM` — місяць, `DD` — день, `{fieldname}` — значення поля.

### Механізм лічильника (tabSeries)

```sql
CREATE TABLE tabSeries (
    name VARCHAR(140) PRIMARY KEY,  -- Префікс (напр., "SINV-24-01-")
    current INT                      -- Поточне значення
);
```

Лічильник використовує `SELECT ... FOR UPDATE` для row-level locking. **Важливий нюанс**: префікс включає **розв'язані дати** — `SINV-24-01-` та `SINV-24-02-` — це різні ключі, тому лічильник **автоматично скидається** з кожним новим місяцем.

**Порівняно з нумераторами 1С**: концептуально ідентично — обидві системи підтримують лічильники з періодичними сегментами. Різниця: у 1С нумератор — окремий метаданих-об'єкт, який можна шарити між типами документів з більш розвинутим контролем періодичності. У Frappe лічильник може мати розриви (gaps), якщо транзакція відкочується після інкременту.

---

## 7. Система дозволів: три шари захисту

Frappe реалізує **багаторівневу систему дозволів**, що поєднує ролі, рядкову та польову безпеку.

### Рівень 1: Role-Based DocType Permissions

Визначаються в масиві `permissions` DocType JSON:

```json
{
  "role": "Accounts User",
  "permlevel": 0,
  "read": 1, "write": 1, "create": 1, "delete": 0,
  "submit": 1, "cancel": 1, "amend": 1,
  "report": 1, "export": 1, "import": 0,
  "print": 1, "email": 1, "share": 1,
  "if_owner": 0
}
```

**14 типів дозволів**: `read`, `write`, `create`, `delete`, `submit`, `cancel`, `amend`, `report`, `export`, `import`, `share`, `print`, `email`, `set_user_permissions`. Прапорець `if_owner` обмежує дію лише документами, створеними поточним користувачем.

### Рівень 2: User Permissions (рядкова безпека)

Обмежує **які записи** бачить користувач на основі Link-полів. Наприклад: «Іван бачить лише документи, де `company = "Моя Компанія"`». Це грубий аналог RLS у 1С, але значно простіший — фільтрація лише за значеннями Link-полів, без підтримки складних умов.

### Рівень 3: Permission Levels (польова безпека)

Поля групуються за числовим рівнем `permlevel` (0, 1, 2...). Різні ролі можуть мати read/write доступ до різних рівнів. Наприклад: в Delivery Note поля сум мають `permlevel=2` — Stock Manager їх бачить і редагує, Stock User — ні.

### Порівняння з 1С

| Аспект | Frappe | 1С |
|---|---|---|
| Рольова модель | Ролі — мітки; дозволи per DocType | Ролі з комплексними об'єктами прав |
| Рядкова безпека | User Permissions (лише за Link-полями) | RLS з довільними умовами |
| Польова безпека | `permlevel` (числові групи) | Обмеження per-field |
| Ієрархія ролей | Відсутня | Можлива |
| Динамічні умови | Обмежені (`if_owner`, Workflow conditions) | Повноцінні програмні перевірки |

---

## 8. Кастомізація: Custom Fields і Property Setters

Frappe реалізує елегантну **двошарову архітектуру кастомізації**, що дозволяє модифікувати стандартні DocType без зміни їхніх JSON-файлів:

**Custom Fields** зберігаються в окремій таблиці `tabCustom Field`:

```json
{
  "doctype": "Custom Field",
  "dt": "Customer",
  "fieldname": "custom_age",
  "fieldtype": "Int",
  "label": "Age",
  "insert_after": "customer_group"
}
```

**Property Setters** перевизначають атрибути існуючих полів (label, hidden, read_only тощо).

При завантаженні метаданих через `frappe.get_meta()`:

```
DocType JSON (стандартні поля)
  → + Custom Fields (з tabCustom Field, позиціоновані через insert_after)
    → + Property Setters (перевизначення атрибутів)
      → + Custom DocPerm (перевизначення дозволів)
        → Кешований Meta-об'єкт
```

Кастомні поля автоматично отримують префікс `custom_` для уникнення конфліктів. Вони можуть експортуватися у fixtures кастомного додатку для version control.

---

## 9. Архітектурні обмеження та критика спільноти

Незважаючи на елегантність metadata-driven підходу, Frappe має суттєві обмеження, виявлені роками продакшн-експлуатації.

### Відсутність вкладених child-таблиць

Child DocType **не може містити інший Table-field**. Це обмеження на один рівень вкладеності — найбільш запитувана фіча спільноти (GitHub #17503, #23307, #36467), досі не реалізована. Для моделювання ієрархічних даних доводиться використовувати окремі DocType або JSON-поля.

### Проблеми продуктивності

`frappe.get_doc()` виконує **окремий SQL-запит на кожну child-таблицю** — для документа з 5 табличними частинами це мінімум 6 запитів. `get_list()` з child-таблицями використовує LEFT JOIN, що створює **дублікати батьківських рядків**. Реальний кейс із телеком-проєкту: обробка 100K рахунків зайняла 32 години через ORM overhead — довелося monkey-patch'ити Redis-черги для досягнення 2 годин. Кожна операція проходить повний lifecycle (validate → before_save → after_insert), навіть для bulk-операцій.

### Проблеми міграцій

Колонки **ніколи не видаляються** при видаленні полів — накопичуються orphaned-колонки. **Зворотних міграцій не існує**. Видалення Custom Field через Customize Form та експорт fixtures **не синхронізує видалення** при `bench migrate` (GitHub #19655). Дозволи не оновлюються при міграціях — потрібні ручні патчі.

### Архітектурний борг Cancel/Amend

Суфікси `-1`, `-2`, `-3` захаращують звіти. Каскадне скасування вимагає скасувати всі downstream-документи. Листування та коментарі втрачаються. У 2019 засновник Frappe Rushabh Mehta запропонував зробити Cancel = повернення в Draft, але спільнота відхилила через порушення ISO 9001 та вимог аудиту.

### Інші обмеження

- **Немає table inheritance** — кожен DocType = окрема таблиця, дублювання полів між подібними DocType
- **Жорстка прив'язка до MariaDB** — PostgreSQL підтримується, але як secondary
- **Тісний зв'язок Desk і backend** — побудова альтернативного UI вимагає обходу фреймворку
- **JSON-файли для складних DocType** — сотні полів, конфлікти мерджів у Git

---

## 10. Зведене порівняння 1С та Frappe: карта концепцій

| # | Концепція 1С | Аналог Frappe | Ключова відмінність |
|---|---|---|---|
| 1 | **Довідник** (Catalog) | DocType (regular) | 1С: вбудована ієрархія, Code+Description, predefined items. Frappe: flat за замовчуванням, is_tree для ієрархії |
| 2 | **Документ** (Document) | DocType (`is_submittable=1`) | 1С: завжди Date+Number, проведення пише в регістри. Frappe: docstatus без платформних регістрів |
| 3 | **Табличні частини** | Child DocType (`istable=1`) | Практично ідентичні. Обмеження Frappe: лише 1 рівень вкладеності |
| 4 | **Проведення/Відміна** | Submit/Cancel | 1С: зворотне, зберігає номер. Frappe: одностороннє, змінює номер при Amend |
| 5 | **Нумератори** | Naming Series | Подібні. 1С: окремий об'єкт, шарінг між типами. Frappe: per-DocType |
| 6 | **Регістр накопичення** | **Немає аналогу** | Killer feature 1С. ERPNext імітує через GL Entry / Stock Ledger Entry в Python |
| 7 | **Регістр відомостей** | **Немає аналогу** | 1С: періодичні дані з SliceLast/SliceFirst. Frappe: звичайний DocType |
| 8 | **Регістр бухгалтерії** | GL Entry (ERPNext, рівень додатку) | 1С: платформний рівень з автоматикою. Frappe: прикладний код |
| 9 | **План рахунків** | Chart of Accounts (tree DocType) | 1С: first-class з динамічними субконто. Frappe: звичайний ієрархічний DocType |
| 10 | **Перелічення** | Select field | 1С: окремий об'єкт метаданих. Frappe: значення в `options` поля |
| 11 | **Складений тип** | Dynamic Link | 1С: поле приймає кілька типів. Frappe: пара полів (тип + значення) |
| 12 | **Керовані форми** | Auto-generated forms | 1С: декларативне дерево елементів форми. Frappe: Section/Column Break розмітка |
| 13 | **Мова запитів** | Report Builder / SQL | 1С: розіменування через крапку, віртуальні таблиці. Frappe: стандартний SQL |
| 14 | **Конфігурація vs ІБ** | App + Site | 1С: чітке розділення. Frappe: app = git repo, site = DB |
| 15 | **Бізнес-процеси** | Workflow DocType | Порівнянні за функціональністю, різний підхід |

---

## 11. Що взяти від кожної платформи для нашого продукту

### Від 1С — обов'язково реалізувати

**Регістри як first-class примітив платформи.** Це найважливіший урок. Accumulation Register із Dimensions (ключі), Resources (значення) та віртуальними таблицями (Balances, Turnovers, SliceLast) — елімінує ~80% ручного коду для обліку. Наш продукт **повинен** мати:

- Декларативне визначення регістрів (dimensions, resources, attributes)
- Два типи: Balance (залишок) і Turnover (обороти)
- Автоматичні таблиці залишків/оборотів
- Атомарний зв'язок document.post() → register movements

**Зворотне проведення.** Документ повинен підтримувати цикл Draft → Posted → Unposted → Draft без створення нового документа та зміни номера.

**Типізовані посилання.** `CatalogRef.Products` замість generic Link — компілятор/валідатор може перевіряти коректність на етапі конфігурування.

**Періодичні регістри відомостей** з вбудованим SliceLast — для курсів валют, цінових прайсів, кадрових даних.

**Прототипи об'єктів** (Reference, Transaction, Register) замість generic DocType — кожен прототип має вбудовану семантику та поведінку.

### Від Frappe — обов'язково реалізувати

**JSON/YAML метадані у Git.** Зберігання схеми як файлів у репозиторії — найкращий підхід для version control та CI/CD.

**Автоматичний REST API** для кожної сутності з фільтрацією, пагінацією, сортуванням — zero-config.

**Custom Fields як overlay.** Двошарова кастомізація (base schema + custom layer) — дозволяє оновлювати базову конфігурацію без втрати кастомізацій.

**Hooks/Events система.** doc_events + controller lifecycle hooks — чистий механізм розширення.

**Web-native архітектура.** Python + JavaScript + REST — відкрита екосистема замість пропрієтарної мови 1С.

**Dynamic Link** для поліморфних посилань — елегантне рішення, яке 1С вирішує через складені типи менш зручно.

### Помилки, яких слід уникнути

| Від кого | Помилка | Що робити інакше |
|---|---|---|
| Frappe | Регістри як прикладний код | Регістри — платформний примітив |
| Frappe | Однонаправлений docstatus | Post/Unpost із збереженням номера |
| Frappe | VARCHAR(140) як PK | UUID або configurable PK strategy |
| Frappe | Відсутність SQL FK constraints | Опціональні FK з fallback на app-level валідацію |
| Frappe | Неможливість вкладених child-таблиць | Підтримка мінімум 2 рівнів вкладеності |
| 1С | Пропрієтарна мова | Python/TypeScript |
| 1С | Закритість платформи | Open-source, MIT license |
| 1С | Застарілий web UI | Web-first, SPA |
| Обидва | Слабкий міграційний інструментарій | Robust migrations з rollback від початку |
| Обидва | Погана масштабованість bulk-операцій | Batch API без ORM overhead для масових операцій |

---

## Висновки для архітектури метамоделі

Frappe доводить, що metadata-driven підхід працює для real-world ERP — **ERPNext обслуговує тисячі компаній** на основі цієї архітектури. Головний інсайт дослідження: поєднання **декларативності 1С** (регістри, типізовані прототипи, зворотне проведення) із **відкритістю Frappe** (web-native, REST-first, Git-based schemas, hook-система) створить платформу, що перевершує обидва прототипи.

Найвища пріоритетність для MVP — реалізувати **три ядрові примітиви**: (1) типізовані метаоб'єкти (Reference, Transaction) з JSON-схемою, (2) регістри накопичення з автоматичними віртуальними таблицями залишків/оборотів, (3) зворотний механізм проведення з атомарними регістровими рухами. Ці три компоненти покривають ~90% потреб типового бізнес-додатку обліку і становлять технологічний фундамент, якого не вистачає жодній існуючій open-source платформі.