# Task: Data Type Editor — 1С-подібний діалог редагування типу реквізита

## Контекст

Поточний UX вибору типу реквізита в Simetra — плоский `Select` з двома групами (примітиви + Ref), вбудований у праву панель властивостей. Додаткові параметри типу (length, precision, scale) розсипані окремими полями в тій же панелі. Reference picker — окремий Popover. Всі зміни застосовуються live (без підтвердження). Це принципово відрізняється від UX конфігуратора 1С:Підприємство, де редагування типу — це **окрема модальна форма** з деревом метаданих, чекбоксами, параметрами типу внизу та кнопками Зберегти / Скасувати.

### Чому це важливо

- Вибір типу — це **комплексна операція**, що торкається кількох полів атрибута одночасно: `type`, `ref`, `allowedTypes`, `length`, `precision`, `scale`. Атомарний Save гарантує консистентність
- Дерево метаданих у діалозі дає користувачу повний огляд доступних reference targets з піктограмами — не потрібно запам'ятовувати імена об'єктів
- Checkbox "Складений тип" (compound type) та параметри типу (довжина, точність) в одному вікні — все як у 1С

### Поточний стан

| Компонент | Файл | Роль |
|-----------|------|------|
| `FieldTypeSelect` | `apps/web/src/components/editor/field-type-select.tsx` | Select з двома групами: primitive + Ref |
| `MetadataRefPicker` | `apps/web/src/components/properties/metadata-ref-picker.tsx` | Popover для single/polymorphic ref |
| `FieldProperties` | `apps/web/src/components/properties/field-properties.tsx` | Права панель — live update без Save/Cancel |
| `attributeSchema` | `packages/core/src/schemas/attribute.ts` | Zod-схема: type, ref, allowedTypes, length, precision, scale |
| `fieldTypeSchema` | `packages/core/src/schemas/field-type.ts` | `z.enum([UUID, String, Text, Integer, Numeric, Boolean, Date, DateTime, Binary, Ref])` |
| `metadata-icons.ts` | `apps/web/src/lib/metadata-icons.ts` | `KIND_ICONS`, `FIELD_TYPE_ICONS`, `KIND_COLORS` |
| `tree-builder.ts` | `apps/web/src/components/layout/tree/tree-builder.ts` | Data-builder для дерева (чистий TS, без React) |
| `tree-types.ts` | `apps/web/src/components/layout/tree/tree-types.ts` | `TreeNodeData` інтерфейс |

---

## Фаза 0: Core-модель — розширення attributeSchema (якщо потрібно)

### Аналіз поточних type-specific параметрів

Поточна `attributeSchema` підтримує:
- `String` → `length: number`
- `Numeric` → `precision: number`, `scale: number`
- `Ref` → `ref: MetadataRef`, `allowedTypes: MetadataRef[]`

**Відсутні параметри**, що були б корисні (аналогія 1С):
- `Integer` → **Немає параметрів**. Поточний UI помилково показує precision/scale для Integer — це баг
- `Date` / `DateTime` → **Немає параметрів**. В 1С є "Тип дати" (Дата, Час, Дата+Час), але в Simetra Date і DateTime — окремі типи, тому додатковий параметр не потрібен
- `Numeric` → **Немає `nonNegative`**. В 1С є checkbox "Неотрицательный", що впливає на DDL. Опціонально — можна додати в core

### Вимоги

- [ ] Виправити баг: прибрати показ precision/scale для `Integer` у FieldProperties. Integer не має type-specific параметрів
- [ ] Очищення type-specific полів при зміні типу — перенести в Data Type Editor (замість live cleanup в FieldProperties)

### Clarify (питання перед імплементацією)

- [ ] **Чи додавати `nonNegative: boolean` в `attributeSchema`?**
  - Чому це важливо: впливає на DDL генерацію (`CHECK (value >= 0)` або `UNSIGNED`)
  - Варіанти: A) Додати зараз як optional boolean / B) Відкласти до Phase DDL generation
  - Вплив на рішення: core-модель, BRD §6.3

### DoD фази 0
- [ ] Integer не показує precision/scale
- [ ] BRD оновлений якщо є зміни core-моделі

---

## Фаза 1: Компонент DataTypeEditorDialog

**Мета:** Створити модальний діалог "Редагування типу даних" за патерном `StandardAttributesDialog` (draft state + revisionKey + Save/Cancel).

### Layout діалогу

```
┌─────────────── Редагування типу даних ───────────────┐
│                                                       │
│  ☐ Складений тип                                      │
│                                                       │
│  🔍 Пошук (Ctrl+Alt+M)                               │
│  ┌─────────────────────────────────────────────────┐  │
│  │  ☐ 183 Число                                    │  │
│  │  ☐ abc Строка                                   │  │
│  │  ☐ 31 Дата                                      │  │
│  │  ☐ ✓  Булево                                    │  │
│  │  ▶ 📖 СправочникПосилання                       │  │
│  │    ☐ 📖 Номенклатура                            │  │
│  │    ☐ 📖 Контрагенти                             │  │
│  │    ☐ 📖 Склади                                  │  │
│  │  ▶ 📄 ДокументПосилання                         │  │
│  │    ☐ 📄 ЗамовленняПокупця                       │  │
│  │    ☐ 📄 Оплата                                  │  │
│  │  ▶ 📋 ПерелічуванняПосилання                    │  │
│  │    ☐ 📋 ТипиЦін                                 │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ─── Параметри типу ──────────────────────────────    │
│  Довжина:  [10  ▼]     Точність: [0  ▼]              │
│  ☐ Невід'ємний                                        │
│                                                       │
│                          [ Скасувати ]  [ Зберегти ]  │
└───────────────────────────────────────────────────────┘
```

### Вимоги

#### Структура компонента

- [ ] Створити `apps/web/src/components/editor/data-type-editor-dialog.tsx`
- [ ] Використати патерн wrapper + body з `revisionKey` (як у `StandardAttributesDialog`)
- [ ] Draft state: при відкритті — `structuredClone` поточних значень type-related полів атрибута (`type`, `ref`, `allowedTypes`, `length`, `precision`, `scale`). При Save — передати всі зміни одним patch. При Cancel — нічого не зберігати
- [ ] Props: `open`, `onOpenChange`, `attribute: Attribute` (поточний стан), `onSave: (updates: Partial<Attribute>) => void`
- [ ] isDirty — порівняння draft з початковими значеннями

#### Чекбокс "Складений тип" (compound type)

- [ ] Вгорі діалогу — чекбокс "Складений тип"
- [ ] Увімкнений "Складений тип" дозволяє вибрати **кілька** типів одночасно (мультиселект): кілька примітивних типів + кілька reference targets. Це аналог "Составной тип данных" у 1С
- [ ] Вимкнений "Складений тип" дозволяє вибрати тільки **один** тип (радіо-кнопка/одиничний вибір)
- [ ] Перемикання compound → single: якщо вибрано більше одного — показати підтвердження або зберегти перший вибраний

#### Область вибору типу — дерево (основна секція)

- [ ] Побудувати дерево з двома рівнями:
  - **Рівень 1 — примітивні типи**: плоский список з піктограмами з `FIELD_TYPE_ICONS` (Число, Строка, Текст, Дата, ДатаЧас, Булево, UUID, Двійкові дані)
  - **Рівень 2 — reference kinds**: розгортаються як дерева, де kind-node = "ДовідникПосилання" / "ДокументПосилання" / "ПеречисленняПосилання" (з `KIND_ICONS`), а дочірні — конкретні обʼєкти з поточної моделі
- [ ] Для побудови reference-дерева — reuse data logic з `tree-builder.ts` (функція `buildTreeData` або витягти utility для отримання обʼєктів по kind).  Самі обʼєкти брати з `useMetadataStore((s) => s.model)` через `KIND_TO_KEY`
- [ ] Піктограми: використати `FIELD_TYPE_ICONS` для примітивів та `KIND_ICONS` для reference groups. Для окремих reference targets — іконку kind батьківського вузла
- [ ] Колір піктограм reference kinds — з `KIND_COLORS`
- [ ] Пошук (CommandInput або окремий Input зверху) — фільтрує і примітивні типи, і reference targets по name
- [ ] react-arborist для дерева — consistency з головним деревом метаданих. Але без context menu, без rename, без delete, без drag-and-drop — тільки вибір

#### Режим single type (compound type вимкнений)

- [ ] Радіо-вибір: клік на елемент — обирає його, знімає з попереднього
- [ ] Клік на примітивний тип → draft: `type = вибраний`, `ref = undefined`, `allowedTypes = undefined`
- [ ] Клік на reference target (конкретний обʼєкт) → draft: `type = "Ref"`, `ref = { kind, name }`, `allowedTypes = undefined`
- [ ] Клік на reference kind node (наприклад "ДовідникПосилання") — **розгортає** групу, не обирає
- [ ] Візуально — виділення radio-style (кружок або підсвітка)

#### Режим compound type (складений тип увімкнений)

- [ ] Мультиселект через чекбокси на кожному елементі
- [ ] Можна обрати кілька примітивних типів та/або кілька reference targets одночасно
- [ ] Якщо обрано хоча б один reference target — draft: `type = "Ref"`, `allowedTypes = [обрані ref targets]`
- [ ] Якщо обрано тільки примітивні — зберегти перший обраний як `type`, решту... (Clarify — див. нижче)
- [ ] Чекбокс на kind-node ("ДовідникПосилання") — обирає/знімає **всі** reference targets цього kind

#### Параметри типу (нижня секція)

- [ ] Динамічна секція внизу діалогу — показує параметри залежно від обраного типу
- [ ] `String` → поле "Довжина" (Input type="number", min=1)
- [ ] `Numeric` → поля "Точність" (precision) та "Масштаб" (scale)
- [ ] `Integer` → **немає параметрів** (виправлення поточного бага)
- [ ] `Ref` (single) → readonly відображення обраного target (`CatalogRef.Products`)
- [ ] `Ref` (compound) → readonly відображення кількості обраних (`AnyRef(3)`)
- [ ] Інші типи (UUID, Boolean, Text, Date, DateTime, Binary) → секція прихована або текст "Додаткових налаштувань немає"
- [ ] Значення параметрів зберігаються в draft і передаються разом із Save
- [ ] При зміні типу — параметри попереднього типу очищуються з draft

#### Footer (кнопки)

- [ ] "Скасувати" — закрити без збереження
- [ ] "Зберегти" — apply draft як один `Partial<Attribute>` update, закрити діалог
- [ ] "Зберегти" disabled якщо `!isDirty`

### Clarify (питання перед імплементацією)

- [ ] **Compound primitive types — як зберігати в core?**
  - Чому це важливо: Поточна `attributeSchema` підтримує тільки один `type: FieldType`. Compound type з кількома примітивами (наприклад Число + Строка) не вкладається в поточну модель
  - Варіанти: A) MVP без compound primitives — compound type тільки для references (allowedTypes), одиничний тип для примітивів / B) Розширити core: `type: FieldType | FieldType[]` або окрема структура
  - Вплив на рішення: core-модель, BRD, серіалізація
  - **Рекомендація:** Варіант A для MVP. Compound тип у 1С прив'язаний до runtime variant-типу. Simetra генерує DDL, де кожна колонка має один SQL-тип. Compound primitives потребують окремого архітектурного рішення (union column, JSON, окремі колонки). Тож compound type поки = reference polymorphism (allowedTypes)

- [ ] **Чи потрібно перевикористати react-arborist чи можна простіший компонент?**
  - Чому це важливо: react-arborist — потужний але складний. Для діалогу без DnD, rename, delete може бути overhead
  - Варіанти: A) react-arborist (consistency з головним деревом) / B) рекурсивний Disclosure/Collapsible / C) shadcn Accordion + flat list
  - Вплив на рішення: UX consistency, складність, performance
  - **Рекомендація:** Варіант A, якщо є виграш у поведінці (virtualizer, keyboard nav). Варіант B — якщо обʼєктів менше 200 і virtualizer не потрібен

- [ ] **Де показувати іконку відкриття діалогу?**
  - Варіанти: A) Кнопка "..." біля FieldTypeSelect / B) Замінити FieldTypeSelect на кнопку-тригер / C) Обидва варіанти — Select для швидкої зміни + кнопка для повного діалогу
  - Вплив на рішення: UX flow
  - **Рекомендація:** Варіант B — FieldTypeSelect в правій панелі стає readonly display з кнопкою відкриття діалогу. Як у 1С — поле "Тип" відображає поточне значення і має кнопку "..." для відкриття форми редагування

### DoD фази 1
- [ ] Діалог відкривається з правої панелі (FieldProperties)
- [ ] Дерево показує примітивні типи + reference kinds з дочірніми обʼєктами
- [ ] Піктограми для всіх типів відповідають `FIELD_TYPE_ICONS` і `KIND_ICONS`
- [ ] Single mode: вибір одного типу працює
- [ ] Compound mode: мультиселект reference targets працює
- [ ] Параметри типу відображаються і редагуються в нижній секції
- [ ] Save — атомарний patch для `type`, `ref`, `allowedTypes`, `length`, `precision`, `scale`
- [ ] Cancel — жодних змін
- [ ] Пошук по дереву працює

---

## Фаза 2: Інтеграція з FieldProperties

**Мета:** Замінити поточний inline flow (FieldTypeSelect + MetadataRefPicker + окремі поля параметрів) на єдиний тригер діалогу.

### Вимоги

- [ ] У FieldProperties секція "Тип даних" замінюється на:
  - Readonly display поточного типу (з піктограмою) + кнопка "..." (або іконка Edit) для відкриття `DataTypeEditorDialog`
  - Формат display: для примітивів — назва типу, для ref — `CatalogRef.Products`, для polymorphic — `AnyRef(3)`
  - Використати існуючу функцію `formatRefDisplay` з `apps/web/src/lib/format-ref-display.ts`
- [ ] Видалити з FieldProperties:
  - Inline `FieldTypeSelect` (Select компонент)
  - Inline поля `length`, `precision`, `scale`
  - Inline `MetadataRefPicker`
- [ ] Зберегти readonly відображення параметрів типу під display value (як підказка):
  - String → "Довжина: 50"
  - Numeric → "Точність: 10, Масштаб: 2"
  - Ref → display target name
- [ ] При зміні type через діалог — store отримує single update з усіма полями, очищення непотрібних полів (length при зміні з String на Boolean тощо) відбувається всередині діалога перед Save
- [ ] Якщо діалог використовується також із `AttributeTable` (центральна зона) — забезпечити відкриття з двох точок входу

### Clarify

- [ ] **Чи залишити FieldTypeSelect як fallback / quick-switch?**
  - Варіанти: A) Тільки діалог — як у 1С / B) Select для примітивів + діалог для повного редагування
  - Вплив на рішення: UX, кількість кліків для простої зміни String → Integer
  - **Рекомендація:** Варіант A для consistency з 1С. Один клік на "..." → діалог → вибір → Зберегти. Це 3 кліки vs 2, але діалог дає повну картину і уникає помилок

### DoD фази 2
- [ ] FieldProperties не містить inline type-editing UI
- [ ] Поле "Тип" показує readonly display + кнопку відкриття діалогу
- [ ] Зміна типу через діалог атомарно оновлює store
- [ ] Type-specific параметри очищуються автоматично при зміні типу

---

## Фаза 3: Reuse дерева метаданих

**Мета:** Дерево в діалозі максимально перевикористовує data layer головного дерева.

### Що можна перевикористати

| Артефакт | Файл | Що береться |
|----------|------|-------------|
| `KIND_ICONS` | `metadata-icons.ts` | Піктограми для reference kind groups |
| `FIELD_TYPE_ICONS` | `metadata-icons.ts` | Піктограми для примітивних типів |
| `KIND_COLORS` | `metadata-icons.ts` | Кольори для kind у дереві |
| `KIND_TO_KEY` | `metadata-defaults.ts` | Маппінг kind → model key |
| `REFERENCEABLE_KINDS` | `metadata-ref-picker.tsx` | `['Catalog', 'Document', 'Enumeration']` |
| `useAvailableObjects` | `metadata-ref-picker.tsx` | Хук для отримання MetadataRef[] |
| Стилістика вузлів | `tree-nodes.tsx` | Відповідність іконок, кольорів, відступів |

### Що НЕ можна перевикористати (нова реалізація)

| Артефакт | Причина |
|----------|---------|
| `tree-panel.tsx` | Прив'язаний до ui-store, tab management, delete dialog |
| `tree-nodes.tsx` | CRUD логіка, context menus, rename — не потрібні в діалозі |
| `tree-builder.ts` | Будує повне дерево з attributes — в діалозі потрібні тільки objects без полів |

### Вимоги

- [ ] Створити utility `buildTypeEditorTree(model: MetadataModel): TypeEditorTreeNode[]` або аналогічну функцію, що будує дерево тільки з:
  - Примітивних типів (плоский список)
  - Reference kind groups → дочірні object nodes (без attributes/tabularSections)
- [ ] Вирівняти стилістику вузлів із головним деревом: ті ж іконки, ті ж кольори, той же spacing
- [ ] Винести `REFERENCEABLE_KINDS` як shared constant (зараз дублюється в `metadata-ref-picker.tsx`)

### DoD фази 3
- [ ] Дерево в діалозі візуально відповідає головному дереву
- [ ] Data layer не дублює tree-builder.ts
- [ ] `REFERENCEABLE_KINDS` — one source of truth

---

## Фаза 4: Інтеграція з AttributeTable (центральна зона)

**Мета:** Додати можливість відкрити діалог безпосередньо з таблиці реквізитів.

### Вимоги

- [ ] В колонці "Тип" таблиці реквізитів — clickable display значення з іконкою
- [ ] Клік на тип у таблиці → відкриває `DataTypeEditorDialog` для цього атрибута
- [ ] Після Save — таблиця оновлюється автоматично (reactive через store)
- [ ] Зберегти також відкриття діалогу через праву панель (два entry points)

### DoD фази 4
- [ ] Клік на тип в AttributeTable відкриває діалог
- [ ] Два entry points: таблиця і права панель

---

## Фаза 5: Тести та i18n

### Вимоги

- [ ] Додати i18n ключі для нового діалогу (uk + en):
  - `dataTypeEditor.title` — "Редагування типу даних"
  - `dataTypeEditor.compoundType` — "Складений тип"
  - `dataTypeEditor.search` — "Пошук"
  - `dataTypeEditor.typeParams` — "Параметри типу"
  - `dataTypeEditor.noParams` — "Додаткових налаштувань немає"
  - `dataTypeEditor.refGroup.Catalog` — "ДовідникПосилання"
  - `dataTypeEditor.refGroup.Document` — "ДокументПосилання"
  - `dataTypeEditor.refGroup.Enumeration` — "ПеречисленняПосилання"
  - `dataTypeEditor.nonNegative` — "Невідʼємний" (якщо включено)
- [ ] Unit тести для `buildTypeEditorTree`:
  - Всі примітивні типи присутні
  - Reference kinds показують лише REFERENCEABLE_KINDS
  - Обʼєкти беруться з model
  - Пошук фільтрує коректно
- [ ] Компонентні тести для `DataTypeEditorDialog`:
  - Single mode: вибір примітивного типу → draft оновлюється
  - Single mode: вибір reference target → draft = `{ type: "Ref", ref: MetadataRef }`
  - Compound mode: мультиселект references → draft = `{ type: "Ref", allowedTypes: MetadataRef[] }`
  - Save → onSave викликається з правильним patch
  - Cancel → onSave не викликається
  - Зміна типу очищує непотрібні параметри
  - isDirty правильно обчислюється
- [ ] `pnpm lint && pnpm typecheck && pnpm test` — все зелене

### DoD фази 5
- [ ] i18n ключі додані в uk.json та en.json
- [ ] Тести дерева та діалогу проходять
- [ ] Lint + typecheck + tests — green

---

## Рекомендовані патерни

### Draft state + revisionKey

Патерн з `StandardAttributesDialog`: при відкритті діалогу інкрементувати `revisionKey`, що скидає внутрішній body компонент. Draft ініціалізується з `structuredClone` поточних type-related полів атрибута. `isDirty` обчислюється порівнянням draft із snapshot. Save комітить всі зміни одним patch.

```
Файл-еталон: apps/web/src/components/editor/standard-attributes-dialog.tsx
```

### Atomic type update

При Save діалог формує `Partial<Attribute>` що включає **всі** type-related поля: `type`, `ref`, `allowedTypes`, `length`, `precision`, `scale`. Навіть якщо деякі стають `undefined` — їх потрібно явно передати, щоб store очистив попередні значення. Це усуває потребу в cleanup-логіці у FieldProperties.

### Піктограми з metadata-icons.ts

`FIELD_TYPE_ICONS` і `KIND_ICONS` — єдине джерело піктограм для типів. Діалог повинен використовувати ті ж самі icon records, а не імпортувати hugeicons напряму. Це гарантує синхронність із головним деревом.

### KIND_COLORS для reference groups

Reference kind nodes у дереві — зафарбовувати тими ж кольорами, що й секції головного дерева (KIND_COLORS). Це створює візуальну когерентність.

### Readonly display type у FieldProperties

Після заміни FieldTypeSelect на readonly display, використовувати `formatRefDisplay` для генерації display value. Для примітивних типів — просто назву типу. Рядок із піктограмою та кнопкою "..." — один SettingRow.

---

## Антипатерни (уникати)

### ❌ Live update без Save/Cancel для комплексного вибору типу

Поточний flow: FieldTypeSelect → onChange → instant store write. Потім окремо параметри типу. Це спричиняє проміжні невалідні стани (наприклад, тип змінено на String, але length ще не задано). Діалог із draft state вирішує цю проблему.

### ❌ Окремий Select для типу + Popover для reference

Розмежування "тип поля" та "якісь об'єкт посилається" — штучне. У 1С це один потік: вибрав "СправочникПосилання.Номенклатура" — і тип, і target задані одночасно. Діалог об'єднує ці два кроки.

### ❌ Дублювання tree-builder.ts для діалогу

Не копіювати `buildTreeData`. Створити **окрему** utility function що бере model і будує спрощене дерево без attributes/tabularSections. Використовувати shared constants (`KIND_TO_KEY`, `REFERENCEABLE_KINDS`).

### ❌ Прив'язка дерева діалогу до ui-store

Дерево в діалозі — **ізольоване**. Його expanded/selected state — тільки локальний (useState). Не писати в ui-store.expandedTreeNodes і не читати з нього.

### ❌ Context menu, rename, delete у дереві діалогу

Дерево діалогу — read-only selector. Ніяких CRUD операцій. Тільки вибір типу.

### ❌ Копіювання стилів tree-nodes.tsx

Не дублювати JSX з tree-nodes.tsx. Створити окремий renderer для діалогу, що використовує ті ж icons/colors, але набагато простіший (без actionButtons, без RenameInput, без isEditing).

### ❌ Integer з precision/scale

Integer — це цілочисловий тип. Precision/scale — властивість Numeric. Поточний UI помилково показує їх для Integer. Це потрібно виправити.

### ❌ Hardcoded type names замість i18n

Усі labels типів — через t('fieldType.String'), t('fieldType.Numeric') тощо. Не хардкодити "Число", "Строка".

---

## Архітектурні рішення

### Потік роботи

```
FieldProperties: readonly "Тип: CatalogRef.Products [...]"
        │
        ▼ клік на [...]
DataTypeEditorDialog відкривається
        │
        ├── draft = structuredClone({ type, ref, allowedTypes, length, precision, scale })
        │
        ├── Користувач обирає тип у дереві
        │   ├── Примітивний → draft.type = "String", draft.ref = undefined
        │   └── Reference → draft.type = "Ref", draft.ref = { kind: "Catalog", name: "Products" }
        │
        ├── Користувач налаштовує параметри (length, precision...)
        │
        ├── [Зберегти] → onSave(draft as Partial<Attribute>) → store.updateAttribute(...)
        └── [Скасувати] → нічого не зберігається
```

### Компонентна ієрархія

```
DataTypeEditorDialog (wrapper: Dialog + revisionKey)
  └── DataTypeEditorBody (stateful body)
        ├── CompoundTypeCheckbox
        ├── TypeSearchInput
        ├── TypeSelectionTree (react-arborist або рекурсивний компонент)
        │     ├── PrimitiveTypeNode (radio/checkbox + icon + label)
        │     └── ReferenceKindNode (expandable)
        │           └── ReferenceTargetNode (radio/checkbox + icon + label)
        ├── TypeParametersSection (conditional)
        │     ├── StringParams (length)
        │     ├── NumericParams (precision, scale)
        │     └── NoParams (placeholder)
        └── DialogFooter (Cancel + Save)
```

### Модель draft state

```typescript
interface TypeEditorDraft {
  type: FieldType
  ref: MetadataRef | undefined
  allowedTypes: MetadataRef[] | undefined
  length: number | undefined
  precision: number | undefined
  scale: number | undefined
  // nonNegative: boolean | undefined  // якщо додано в core
}
```

---

## Пов'язана документація
- `docs/architecture/OVERVIEW.md` — загальна архітектура монорепо
- `docs/BRD-metadata-configurator.md` §6 — система типів полів
- `docs/BRD-metadata-configurator.md` §6.3 — властивості атрибутів
- `docs/tasks/editor-layer-redesign.md` — загальний план редизайну editor layer
- `docs/tasks/reference-type-redesign.md` — завершена задача redesign reference types
- `.github/instructions/metadata-model.instructions.md` — правила Zod-схем
- `.github/instructions/ui-architecture.instructions.md` — правила побудови UI
- `.github/instructions/coding-style.instructions.md` — стиль коду
- `packages/core/src/schemas/attribute.ts` — Zod-схема атрибута
- `packages/core/src/schemas/field-type.ts` — FieldType enum
- `apps/web/src/components/editor/standard-attributes-dialog.tsx` — еталон патерну draft + Save/Cancel

## Definition of Done (загальний)
- [ ] Модальний діалог "Редагування типу даних" створений і функціонує
- [ ] Дерево з примітивними типами + reference kinds + object targets
- [ ] Піктограми відповідають головному дереву метаданих
- [ ] Single mode (один тип) та compound mode (polymorphic ref) працюють
- [ ] Параметри типу (length, precision, scale) редагуються в діалозі
- [ ] Draft state + Save/Cancel — атомарне оновлення
- [ ] FieldProperties — readonly display + кнопка відкриття діалогу
- [ ] Integer не показує precision/scale (bugfix)
- [ ] i18n ключі для uk та en
- [ ] Тести для дерева та діалогу
- [ ] `pnpm lint && pnpm typecheck && pnpm test` — все зелене
