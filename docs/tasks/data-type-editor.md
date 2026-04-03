# Task: Data Type Editor — 1С-подібний діалог редагування типу реквізита

## Контекст

Поточний UX вибору типу реквізита в Simetra — плоский `Select` з двома групами (примітиви + Ref), вбудований у праву панель властивостей. Додаткові параметри типу (length, precision, scale) розсипані окремими полями в тій же панелі. Reference picker — окремий Popover. Всі зміни застосовуються live (без підтвердження). Це принципово відрізняється від UX конфігуратора 1С:Підприємство, де редагування типу — це **окрема модальна форма** з деревом метаданих, чекбоксами, параметрами типу внизу та кнопками Зберегти / Скасувати.

### Чому це важливо

- Вибір типу — це **комплексна операція**, що торкається кількох полів атрибута одночасно: `type`, `ref`, `allowedTypes`, `length`, `precision`, `scale`. Атомарний Save гарантує консистентність
- Дерево метаданих у діалозі дає користувачу повний огляд доступних reference targets з піктограмами — не потрібно запам'ятовувати імена об'єктів
- Checkbox "Складений тип" (compound type = polymorphic Ref) та параметри типу (довжина, точність) в одному вікні — все як у 1С

### Scope

**Входить у задачу:** Редагування type-related полів атрибута (attributes, dimensions, resources, tabularSection attributes).

**НЕ входить у задачу:** Constant.valueType — окремий scope. `FieldTypeSelect` залишається без змін для Constant (окреме рішення — фільтрація Ref зі списку для Constant).

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
| `referenceableKindSchema` | `packages/core/src/schemas/metadata-ref.ts` | Source of truth для referenceable kinds |

### Ключові рішення (прийняті на основі дослідження)

| # | Рішення | Обґрунтування |
|---|---------|---------------|
| R1 | **Compound type = тільки polymorphic Ref** (allowedTypes). Compound primitive types — out of scope | BRD §6.2 фіксує compound тільки як Ref. Core `type: FieldType` — одиничне поле, compound primitives потребують зміни core + DDL стратегії |
| R2 | **Core superRefine** для type-specific полів | Stale length/precision/scale без cross-field refine проходять validation. Потрібен guard на рівні схеми |
| R3 | **REFERENCEABLE_KINDS з core**, не UI literal | `referenceableKindSchema` вже є source of truth у `packages/core/src/schemas/metadata-ref.ts` |
| R4 | **Рефакторинг TreeNodeData** для підтримки і sidebar, і data type editor | Один shared tree model, один renderer pattern. Без ризику стилістичного розходження |
| R5 | **react-arborist** для дерева в діалозі | Consistency з головним деревом, virtualizer, keyboard nav. Спільний TreeNodeData |
| R6 | **Діалог = dumb component**, caller формує onSave | Routing-логіка (attribute/dimension/resource/tabularSection) залишається в caller |
| R7 | **nonNegative** — відкладено до задачі DDL generation | Немає погодженого DDL-ефекту в BRD |
| R8 | **i18n namespace `fieldType.*`** для всіх field type labels | Поточні raw enum strings — не user-facing якість |

---

## Фаза 0: Core-модель та bugfixes

**Мета:** Посилити `attributeSchema` валідацією type-specific полів. Виправити Integer bug.

### Вимоги

- [Х] Додати `superRefine` в `attributeSchema` (`packages/core/src/schemas/attribute.ts`):
  - `length` дозволений **тільки** коли `type === 'String'`; інакше — issue
  - `precision` і `scale` дозволені **тільки** коли `type === 'Numeric'`; інакше — issue
  - Це доповнює існуючий refine для ref/allowedTypes, а не замінює його
- [Х] Виправити `isNumericType` у `field-properties.tsx` рядок ~243: прибрати `|| attribute.type === 'Integer'`. Integer не має type-specific параметрів (BRD §6.1)
- [Х] Оновити тести `attributeSchema` — перевірити, що stale length при type=Boolean rejected, stale precision при type=String rejected
- [Х] `pnpm --filter @simetra/core test` — зелене

### Ризики

- Existing test fixtures або persisted data можуть містити stale params. Перевірити фікстури, при потребі очистити. Проєкт на етапі розробки — дані тестові, можна ігнорувати

### DoD фази 0
- [Х] `attributeSchema` відхиляє stale length/precision/scale для невідповідного type
- [Х] Integer не показує precision/scale у FieldProperties
- [Х] Тести core зелені

---

## Фаза 1: Рефакторинг TreeNodeData + shared tree infrastructure

**Мета:** Розширити `TreeNodeData` і tree layer так, щоб він підтримував і sidebar метаданих, і дерево вибору типу в діалозі — з єдиним renderer pattern і без стилістичного розходження.

### Вимоги

#### Рефакторинг TreeNodeData

- [Х] Розширити `TreeNodeType` у `tree-types.ts` новими значеннями: `'primitiveType' | 'refKindGroup' | 'refTarget'`
- [Х] Зробити `kind` **optional** у `TreeNodeData`: `kind?: MetadataKind`. Для нових node types (primitiveType) kind не має сенсу
- [Х] Додати optional поля для type editor nodes:
  - `fieldTypeValue?: FieldType` — для primitiveType і refTarget (яке значення type це представляє)
  - `refTarget?: MetadataRef` — для refTarget (конкретний об'єкт посилання)
  - ~~`icon?: IconSvgElement` — explicit icon override~~ → відкладено: icon/iconColor **не додані** в TreeNodeData; buildTypeEditorTree не заповнює ці поля. Presentation layer в tree-node-presentation.tsx отримує іконки через FIELD_TYPE_ICONS/KIND_ICONS безпосередньо. Додати у Фазі 2, якщо знадобиться
  - ~~`iconColor?: string` — explicit Tailwind color class override~~ → відкладено (див. вище)
  - `selectable?: boolean` — чи можна вибрати цей вузол (false для refKindGroup — тільки expand)
- [Х] Оновити всі існуючі usages в `tree-nodes.tsx` і `tree-builder.ts`, щоб `kind` доступався через optional chaining або guards по `nodeType`
- [~] Додати TypeScript overloads або discriminated union утиліти якщо потрібно для type safety → **відкладено**: discriminated union потребує рефакторингу всіх споживачів TreeNodeData. Поки використовується `kind!` non-null assertion у sidebar nodes де kind гарантовано є. Розглянути у Фазі 2

#### Рефакторинг TreeNode renderer

- [Х] Розділити `tree-nodes.tsx` на два шари:
  - **Presentation layer** — `tree-node-presentation.tsx`: рендер іконки + label + badge. Без CRUD, без context menu, без store access. Pure visual.
  - **Interaction layer** — поточні `KindSectionNode`, `ObjectNode`, `GroupNode`, `FieldNode`, `TabularSectionNode`: обгортки навколо presentation + CRUD + context menu
- [Х] Додати нові presentation-only renderers для нових node types:
  - `PrimitiveTypePresentation` — іконка з `FIELD_TYPE_ICONS` + label + radio/checkbox
  - `RefKindGroupPresentation` — іконка з `KIND_ICONS` + label + expand arrow (не selectable)
  - `RefTargetPresentation` — іконка kind + name обʼєкта + radio/checkbox
- [Х] Data Type Editor tree використовує ті ж presentation layers, але без interaction layer (без ContextMenu, без rename, без delete, без DnD)

#### buildTypeEditorTree

- [Х] Створити **експортовану** pure function `buildTypeEditorTree(model: ProjectModel, searchQuery: string): TreeNodeData[]` у `tree-builder.ts`
- [Х] Source of truth для referenceable kinds: `referenceableKindSchema.options` з `@simetra/core` (замість локальної константи)
- [Х] Структура дерева:
  - Рівень 0: примітивні type nodes (`nodeType: 'primitiveType'`, `fieldTypeValue`, `icon` з `FIELD_TYPE_ICONS`, `selectable: true`)
  - Рівень 0: reference kind groups (`nodeType: 'refKindGroup'`, `kind` = Catalog/Document/Enumeration, `icon` з `KIND_ICONS`, `iconColor` з `KIND_COLORS`, `selectable: false`)
  - Рівень 1: reference targets (`nodeType: 'refTarget'`, `kind`, `fieldTypeValue: 'Ref'`, `refTarget: { kind, name }`, `selectable: true`)
- [Х] Пошук: фільтрує і примітивні типи, і reference targets по name. При збігу в дочірньому — батьківський refKindGroup залишається видимим
- [Х] Обʼєкти для reference targets брати з `model` через `KIND_TO_KEY`

#### Прибрати дублювання REFERENCEABLE_KINDS

- [Х] Видалити `const REFERENCEABLE_KINDS` з `metadata-ref-picker.tsx`
- [Х] Замінити на import: `import { referenceableKindSchema } from '@simetra/core'` → `referenceableKindSchema.options`
- [Х] `buildTypeEditorTree` теж спирається на `referenceableKindSchema.options`

#### Винести useAvailableObjects

- [Х] Перенести `useAvailableObjects` з `metadata-ref-picker.tsx` у `apps/web/src/hooks/use-available-objects.ts` (shared hook)
- [Х] `metadata-ref-picker.tsx` і `DataTypeEditorDialog` обидва імпортують з shared hook

### Ризики

- Рефакторинг `kind` на optional торкається ~50 місць у `tree-nodes.tsx`. Потрібен guard `data.kind!` або narrowing по `nodeType` для metadata-specific вузлів. Зміна механічна, але об'ємна
- Рефакторинг renderer на два шари (presentation + interaction) — більший scope, але це інвестиція що прибирає дублювання надалі

### DoD фази 1
- [Х] `TreeNodeData` підтримує нові nodeTypes без ламання існуючого sidebar
- [Х] `buildTypeEditorTree` повертає дерево primitive types + ref kind groups + ref targets
- [Х] Пошук по дереву type editor працює
- [Х] Presentation layer відокремлений від interaction layer у tree-nodes
- [Х] `REFERENCEABLE_KINDS` — одне джерело з core
- [Х] `useAvailableObjects` — shared hook
- [Х] Sidebar метаданих візуально і функціонально не змінився (regression-free)
- [Х] `pnpm lint && pnpm typecheck` — зелене

### Зауваження з code review Фази 1

> Наступні пункти виявлені під час code review і **відкладені** до наступних фаз.

1. **Sidebar nodes не використовують presentation components** — sidebar `tree-nodes.tsx` (KindSectionNode, ObjectNode, тощо) не обгорнуті у `*Presentation` компоненти з `tree-node-presentation.tsx`. Причина: sidebar nodes обгорнуті Radix `ContextMenu.Trigger asChild`, що потребує `forwardRef` та Slot prop merging. Презентаційні компоненти створені для Phase 2 (Data Type Editor діалог) і працюють без Radix обгортки. Інтеграція sidebar → presentation — **окремий рефакторинг після Phase 2**, коли обидва use cases стабільні.

2. **`icon` / `iconColor` поля не додані в `TreeNodeData`** — `buildTypeEditorTree` не заповнює ці поля. Presentation layer (`tree-node-presentation.tsx`) отримує іконки напряму через `FIELD_TYPE_ICONS` / `KIND_ICONS`. Якщо Phase 2 покаже необхідність — додати.

3. **Discriminated union для `TreeNodeData`** — замість `kind?: MetadataKind` рекомендовано discriminated union по `nodeType`. Зараз використовується `kind!` non-null assertion у sidebar nodes. Рефакторинг потребує змін у всіх споживачах. Розглянути після Phase 2.

4. **Unit тести для `buildTypeEditorTree`** — відкладені до Фази 5 (тести).

---

## Фаза 2: Компонент DataTypeEditorDialog

**Мета:** Створити модальний діалог "Редагування типу даних" за патерном `StandardAttributesDialog` (draft state + revisionKey + Save/Cancel).

### Layout діалогу

```
┌─────────────── Редагування типу даних ───────────────┐
│                                                       │
│  ☐ Складений тип (Polymorphic Ref)                    │
│                                                       │
│  🔍 Пошук                                             │
│  ┌─────────────────────────────────────────────────┐  │
│  │  ○ 🔤 Рядок                                     │  │
│  │  ○ 📝 Текст                                     │  │
│  │  ○ # Ціле число                                  │  │
│  │  ○ # Число                                       │  │
│  │  ○ ✓ Булево                                      │  │
│  │  ○ 📅 Дата                                       │  │
│  │  ○ 📅 Дата і час                                 │  │
│  │  ▶ 📖 ДовідникПосилання                          │  │
│  │    ○ 📖 Номенклатура                             │  │
│  │    ○ 📖 Контрагенти                              │  │
│  │  ▶ 📄 ДокументПосилання                          │  │
│  │    ○ 📄 ЗамовленняПокупця                        │  │
│  │  ▶ 📋 ПеречисленняПосилання                      │  │
│  │    ○ 📋 ТипиЦін                                  │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ─── Параметри типу ──────────────────────────────    │
│  Довжина:  [10  ]                                     │
│                                                       │
│                          [ Скасувати ]  [ Зберегти ]  │
└───────────────────────────────────────────────────────┘
```

### Вимоги

#### Структура компонента

- [Х] Створити `apps/web/src/components/editor/data-type-editor-dialog.tsx`
- [Х] Патерн wrapper + body з `revisionKey` (як у `StandardAttributesDialog`):
  - Wrapper: `Dialog` + `revisionKey` state, інкрементується при відкритті
  - Body: монтується з `key={revisionKey}`, ініціалізує draft при mount
- [Х] Draft state: при відкритті — `structuredClone` поточних type-related полів атрибута (`type`, `ref`, `allowedTypes`, `length`, `precision`, `scale`). При Save — передати всі зміни одним patch. При Cancel — нічого не зберігати
- [Х] Props: `open`, `onOpenChange`, `attribute: Attribute` (поточний стан), `onSave: (updates: Partial<Attribute>) => void`
- [Х] `isDirty` — `JSON.stringify(draft) !== JSON.stringify(snapshot)` у useMemo
- [Х] Діалог — **dumb component**: не знає про store, не знає про field role. Caller формує `onSave` callback з правильним store dispatch

#### Чекбокс "Складений тип" (compound type = polymorphic Ref)

- [Х] Вгорі діалогу — чекбокс "Складений тип"
- [Х] Увімкнений "Складений тип" дозволяє обрати **кілька reference targets** одночасно (мультиселект). Примітивні типи стають недоступними (disabled) — compound = тільки polymorphic Ref
- [Х] Вимкнений "Складений тип" дозволяє вибрати **один** тип (радіо-кнопка/одиничний вибір): або примітивний, або один reference target
- [Х] Перемикання compound → single: якщо обрано кілька targets — зберегти перший
- [Х] Перемикання single → compound: якщо обрано примітивний тип — скинути вибір; якщо обрано single ref — перенести в allowedTypes

#### Область вибору типу — react-arborist дерево

- [Х] Використати `buildTypeEditorTree` з Фази 1 для побудови даних дерева
- [Х] react-arborist з shared `TreeNodeData` і presentation renderers з Фази 1
- [Х] Дерево ізольоване: expanded/selected state — тільки локальний (useState). Не писати в ui-store
- [Х] Без context menu, без rename, без delete, без DnD — тільки вибір і expand/collapse

#### Режим single type (compound type вимкнений)

- [Х] Радіо-вибір: клік на елемент — обирає його, знімає з попереднього
- [Х] Клік на примітивний тип → draft: `type = вибраний`, `ref = undefined`, `allowedTypes = undefined`
- [Х] Клік на reference target → draft: `type = "Ref"`, `ref = { kind, name }`, `allowedTypes = undefined`
- [Х] Клік на reference kind group → тільки expand/collapse, не обирає
- [Х] Візуально — radio-style виділення

#### Режим compound type (складений тип увімкнений)

- [Х] Мультиселект через чекбокси на reference target nodes
- [Х] Примітивні типи — disabled (не можна обрати)
- [Х] Обрані targets → draft: `type = "Ref"`, `allowedTypes = [обрані ref targets]`, `ref = undefined`
- [Х] Чекбокс на kind-node ("ДовідникПосилання") — обирає/знімає **всі** reference targets цього kind

#### Централізований cleanup type-specific полів

- [Х] При зміні типу в draft — автоматичне очищення несумісних полів:
  - `String` → зберегти `length`, очистити `precision`, `scale`, `ref`, `allowedTypes`
  - `Numeric` → зберегти `precision`, `scale`, очистити `length`, `ref`, `allowedTypes`
  - `Ref` (single) → зберегти `ref`, очистити `length`, `precision`, `scale`, `allowedTypes`
  - `Ref` (compound) → зберегти `allowedTypes`, очистити `length`, `precision`, `scale`, `ref`
  - Будь-який інший (UUID, Boolean, Text, Date, DateTime, Binary, Integer) → очистити всі type-specific поля
- [Х] Cleanup виконується в draft state, до Save — в store потрапляють тільки валідні комбінації

#### Параметри типу (нижня секція)

- [Х] Динамічна секція внизу діалогу — показує параметри залежно від обраного типу
- [Х] `String` → поле "Довжина" (Input type="number", min=1)
- [Х] `Numeric` → поля "Точність" (precision) та "Масштаб" (scale)
- [Х] `Integer` → **немає параметрів**
- [Х] `Ref` (single) → readonly display обраного target (локалізований `formatTypeLabel`)
- [Х] `Ref` (compound / allowedTypes) → readonly display кількості обраних
- [Х] Інші типи (UUID, Boolean, Text, Date, DateTime, Binary) → секція прихована або текст "Додаткових налаштувань немає"
- [Х] Значення параметрів зберігаються в draft і передаються разом із Save

#### Footer (кнопки)

- [Х] "Скасувати" — закрити без збереження
- [Х] "Зберегти" — apply draft як один `Partial<Attribute>` update (включаючи поля з `undefined` для explicit cleanup), закрити діалог
- [Х] "Зберегти" disabled якщо `!isDirty`

### Ризики

- Compound mode disabled primitives — може здивувати користувача. Потрібен tooltip "Складений тип підтримує тільки посилання"
- react-arborist у модальному вікні: треба перевірити фокус-менеджмент (Dialog trap vs tree keyboard nav)

### DoD фази 2
- [Х] Діалог відкривається, показує дерево типів + параметри
- [Х] Single mode: вибір одного типу працює коректно
- [Х] Compound mode: мультиселект reference targets працює
- [Х] Cleanup type-specific полів — автоматичний
- [Х] Save — атомарний patch для всіх type-related полів
- [Х] Cancel — жодних змін
- [Х] Пошук по дереву працює
- [Х] Presentation layer з Фази 1 — стилістично ідентичний sidebar

### Зауваження з code review Фази 2

> Наступні пункти виявлені під час code review і **відкладені** до наступних фаз.

1. **Keyboard navigation у Data Type Editor ще не доведена до паритету з sidebar tree** — поточний діалог повністю mouse-driven. Потрібно додати selection / activate pattern через `react-arborist`, щоб keyboard UX був консистентний з основним деревом.

2. **`refKindGroup` у compound mode не має checked / indeterminate affordance** — bulk-select для всього kind працює, але користувач не бачить агрегований стан групи. Потрібен окремий візуальний стан group-node.

3. **Component tests для діалогу не покривають review-critical сценарії** — потрібні окремі тести на keyboard interaction, group toggle і search + bulk-select, щоб зафіксувати поведінку діалогу перед наступними ітераціями.

---

## Фаза 3: Інтеграція з FieldProperties та AttributeTable

**Мета:** Замінити поточний inline type-editing flow на єдиний тригер діалогу. Додати entry point з таблиці атрибутів.

### Вимоги

#### FieldProperties — readonly display + тригер діалогу

- [x] Секція "Тип даних" у FieldProperties замінюється на:
  - Readonly display поточного типу (з піктограмою) + кнопка "..." для відкриття `DataTypeEditorDialog`
  - Формат display: локалізований через `formatTypeLabel` (Фаза 4)
  - Під display value — readonly підказка параметрів: String → "Довжина: 50", Numeric → "Точність: 10, Масштаб: 2"
- [x] Видалити з FieldProperties inline type-editing UI:
  - `FieldTypeSelect` (Select компонент) — прибрати import і usage
  - Inline поля `length`, `precision`, `scale`
  - Inline `MetadataRefPicker`
- [x] `onSave` callback для діалогу формується в FieldProperties з використанням існуючого `handleUpdate` (який вже робить routing по field role)
- [x] `FieldTypeSelect` **залишається** як компонент — він використовується для Constant.valueType в `object-properties.tsx`

#### AttributeTable — entry point з таблиці

- [x] В колонці "Тип" таблиці реквізитів — зробити type cell clickable
- [x] Клік на type badge → відкриває `DataTypeEditorDialog` для цього атрибута
- [x] Потрібен `stopPropagation` на cell level щоб не зламати row selection
- [x] `onSave` callback формується з координатами атрибута (kind, objectName, fieldName, field role)
- [x] Після Save — таблиця оновлюється автоматично (reactive через store)

#### UX polishing діалогу після інтеграції

- [x] Додати keyboard navigation у `DataTypeEditorDialog` до паритету з sidebar tree (`onSelect` / `onActivate`, навігація без mouse-only flow)
- [x] Додати checked / indeterminate visual state для `refKindGroup` у compound mode

### Ризики

- FieldProperties містить складну routing-логіку (`getFieldRole` → dispatch до різних store methods). Діалог не повинен дублювати її — приймає готовий onSave
- Click на type cell vs row selection: потрібен окремий event handling на cell рівні

### DoD фази 3
- [x] FieldProperties — readonly display типу + кнопка "..." → діалог
- [x] FieldProperties не містить inline type-editing UI
- [x] AttributeTable — клік на type badge відкриває діалог
- [x] Два entry points працюють: права панель і таблиця
- [x] Зміна типу через діалог атомарно оновлює store
- [x] Constant.valueType flow не зачеплено (FieldTypeSelect залишається)

---

## Фаза 4: i18n та user-facing display

**Мета:** Додати локалізацію для field types і створити user-facing formatter.

### Вимоги

#### i18n namespace fieldType

- [ ] Додати в `apps/web/src/i18n/locales/uk.json`:
  ```
  "fieldType": {
    "UUID": "UUID",
    "String": "Рядок",
    "Text": "Текст",
    "Integer": "Ціле число",
    "Numeric": "Число",
    "Boolean": "Булево",
    "Date": "Дата",
    "DateTime": "Дата і час",
    "Binary": "Двійкові дані",
    "Ref": "Посилання"
  }
  ```
- [ ] Додати в `apps/web/src/i18n/locales/en.json`:
  ```
  "fieldType": {
    "UUID": "UUID",
    "String": "String",
    "Text": "Text",
    "Integer": "Integer",
    "Numeric": "Numeric",
    "Boolean": "Boolean",
    "Date": "Date",
    "DateTime": "DateTime",
    "Binary": "Binary",
    "Ref": "Reference"
  }
  ```

#### i18n ключі для діалогу

- [ ] `dataTypeEditor.title` — "Редагування типу даних" / "Data Type Editor"
- [ ] `dataTypeEditor.compoundType` — "Складений тип" / "Compound type"
- [ ] `dataTypeEditor.compoundTooltip` — "Складений тип підтримує тільки посилання" / "Compound type supports references only"
- [ ] `dataTypeEditor.search` — "Пошук типу" / "Search type"
- [ ] `dataTypeEditor.typeParams` — "Параметри типу" / "Type parameters"
- [ ] `dataTypeEditor.noParams` — "Додаткових налаштувань немає" / "No additional settings"
- [ ] `dataTypeEditor.refGroup.Catalog` — "ДовідникПосилання" / "CatalogRef"
- [ ] `dataTypeEditor.refGroup.Document` — "ДокументПосилання" / "DocumentRef"
- [ ] `dataTypeEditor.refGroup.Enumeration` — "ПеречисленняПосилання" / "EnumerationRef"

#### User-facing formatter formatTypeLabel

- [ ] Створити `apps/web/src/lib/format-type-label.ts` — user-facing formatter:
  - Примітивний тип → `t('fieldType.String')` → "Рядок"
  - Single ref → `t('fieldType.Ref') + ': ' + ref.name` → "Посилання: Products"
  - Polymorphic ref → `t('fieldType.Ref') + ' (' + count + ')'` → "Посилання (3)"
  - Незавершений Ref → `t('fieldType.Ref')` → "Посилання"
- [ ] Використовувати у: readonly display FieldProperties, Data Type Editor dialog, AttributeTable badge
- [ ] `formatRefDisplay` залишити для технічного display (tree field nodes де `CatalogRef.Products` стиль доречний)

### Ризики

- Масив змін в locale файлах. Потрібна координація з усіма місцями де зараз raw enum strings
- `formatTypeLabel` залежить від `t()` — тобто це React-тільки helper (через useTranslation). Для pure contexts можна передавати `t` як параметр

### DoD фази 4
- [ ] `fieldType.*` namespace у uk.json та en.json
- [ ] `dataTypeEditor.*` ключі у обох locales
- [ ] `formatTypeLabel` використовується у FieldProperties, AttributeTable, DataTypeEditorDialog
- [ ] Primitive type labels локалізовані у дереві діалогу

---

## Фаза 5: Тести

**Мета:** Покрити тестами нову функціональність.

### Вимоги

#### Unit тести core

- [ ] `attributeSchema` — stale params rejected:
  - `{ type: 'Boolean', length: 50 }` → issue
  - `{ type: 'String', precision: 10 }` → issue
  - `{ type: 'String', length: 50 }` → pass
  - `{ type: 'Numeric', precision: 10, scale: 2 }` → pass

#### Unit тести buildTypeEditorTree

- [ ] Всі примітивні типи присутні (9 шт: UUID..Binary)
- [ ] Reference kinds = тільки referenceable (Catalog, Document, Enumeration)
- [ ] Об'єкти беруться з model — якщо в model 2 catalogs, в дереві 2 ref targets під CatalogRef
- [ ] Пошук фільтрує примітиви і ref targets по name
- [ ] Refactor: sidebar tree не зламаний — buildTreeData повертає ті ж результати

#### Компонентні тести DataTypeEditorDialog

- [ ] Single mode: вибір примітивного типу → draft оновлюється
- [ ] Single mode: вибір reference target → draft = `{ type: "Ref", ref: MetadataRef }`
- [ ] Compound mode: мультиселект references → draft = `{ type: "Ref", allowedTypes: MetadataRef[] }`
- [ ] Compound mode: примітивні типи disabled
- [ ] Compound mode: kind-group відображає checked / indeterminate state коректно
- [ ] Save → onSave викликається з правильним patch (включаючи undefined для cleanup)
- [ ] Cancel → onSave не викликається
- [ ] Зміна типу очищує непотрібні параметри (centralized cleanup)
- [ ] isDirty правильно обчислюється
- [ ] Переключення compound → single зберігає перший target
- [ ] Keyboard navigation / activate flow працює без mouse interaction
- [ ] Search + group toggle використовує повний набір targets kind, а не тільки відфільтровані вузли

#### Фінальна перевірка

- [ ] `pnpm lint && pnpm typecheck && pnpm test` — все зелене

### DoD фази 5
- [ ] Core тести stale params
- [ ] Tree builder тести
- [ ] Dialog тести
- [ ] Sidebar regression test
- [ ] Lint + typecheck + tests — green

---

## Рекомендовані патерни

### Draft state + revisionKey

Патерн з `StandardAttributesDialog` (файл-еталон: `apps/web/src/components/editor/standard-attributes-dialog.tsx`):
- Wrapper інкрементує `revisionKey` при відкритті
- Body монтується з `key={revisionKey}` — hard reset draft
- Draft: `structuredClone` type-related полів
- `isDirty`: `JSON.stringify(draft) !== JSON.stringify(snapshot)` у useMemo
- Save передає всі зміни одним patch

### Atomic type update

При Save діалог формує `Partial<Attribute>` що включає **всі** type-related поля: `type`, `ref`, `allowedTypes`, `length`, `precision`, `scale`. Навіть якщо деякі стають `undefined` — їх потрібно явно передати, щоб `Object.assign` у store поставив `undefined`, а серіалізатор потім їх опустить.

### Presentation + Interaction layers у tree

Tree renderer розділений на:
- **Presentation** — pure visual: іконка, label, badge, indent, expand arrow. Без store, без CRUD
- **Interaction** — обгортка: ContextMenu, onClick для select/open-tab, rename, delete, add

Data Type Editor використовує Presentation layer напряму, без Interaction layer.

### Source of truth: core → UI

- Field types: `fieldTypeSchema` з `@simetra/core`
- Referenceable kinds: `referenceableKindSchema.options` з `@simetra/core`
- Іконки/кольори: `FIELD_TYPE_ICONS`, `KIND_ICONS`, `KIND_COLORS` з `metadata-icons.ts`
- Model access: `KIND_TO_KEY` з `metadata-defaults.ts`

---

## Антипатерни (уникати)

### ❌ Live update без Save/Cancel для комплексного вибору типу

Поточний flow: FieldTypeSelect → onChange → instant store write. Потім окремо параметри типу. Проміжні невалідні стани. Діалог із draft state вирішує це.

### ❌ Окремий Select для типу + Popover для reference

У 1С це один потік: вибрав "СправочникПосилання.Номенклатура" — і тип, і target задані одночасно.

### ❌ Compound primitive types

BRD визначає compound тільки як polymorphic Ref. Core model не підтримує `type: FieldType[]`. Compound primitives потребують окремого архітектурного рішення і DDL стратегії.

### ❌ Окремий tree model для діалогу (стилістичне розходження)

Не створювати паралельний `TypeEditorNode` тип. Одна `TreeNodeData` для sidebar і для діалогу. Єдиний presentation layer забезпечує візуальну когерентність.

### ❌ Прив'язка дерева діалогу до ui-store

Дерево в діалозі — ізольоване. expanded/selected state — тільки локальний useState. Не писати в ui-store.

### ❌ REFERENCEABLE_KINDS як UI literal

Source of truth — `referenceableKindSchema` з `@simetra/core`. Не дублювати в UI.

### ❌ Integer з precision/scale

Integer — цілочисловий тип. Precision/scale — тільки Numeric. BRD §6.1 explicit.

### ❌ Hardcoded type names замість i18n

Усі user-facing labels типів — через `t('fieldType.String')`. Технічний display (`CatalogRef.Products`) — тільки у tree field nodes через `formatRefDisplay`.

### ❌ Діалог знає про store routing

Діалог приймає `onSave: (updates) => void`. Не знає чи це attribute, dimension, resource чи tabularSection. Caller формує callback.

---

## Архітектурні рішення

### Потік роботи

```
FieldProperties: readonly "Посилання: Products [...]"
        │                     або
AttributeTable: click на type badge
        │
        ▼
DataTypeEditorDialog відкривається
        │
        ├── draft = structuredClone({ type, ref, allowedTypes, length, precision, scale })
        │
        ├── Користувач обирає тип у дереві (shared TreeNodeData + presentation layer)
        │   ├── Примітивний → draft.type = "String", cleanup ref/allowedTypes/precision/scale
        │   └── Reference → draft.type = "Ref", draft.ref = { kind, name }, cleanup length/precision/scale
        │
        ├── Користувач налаштовує параметри (length, precision, scale)
        │
        ├── [Зберегти] → onSave(draft as Partial<Attribute>) → caller dispatches to store
        └── [Скасувати] → нічого не зберігається
```

### Компонентна ієрархія

```
DataTypeEditorDialog (wrapper: Dialog + revisionKey)
  └── DataTypeEditorBody (stateful body)
        ├── CompoundTypeCheckbox (enables polymorphic Ref mode)
        ├── TypeSearchInput
        ├── TypeSelectionTree (react-arborist + shared TreeNodeData)
        │     ├── PrimitiveTypeNode [presentation layer] (radio/checkbox + icon + label)
        │     ├── RefKindGroupNode [presentation layer] (expandable, not selectable)
        │     └── RefTargetNode [presentation layer] (radio/checkbox + icon + label)
        ├── TypeParametersSection (conditional)
        │     ├── StringParams (length)
        │     ├── NumericParams (precision, scale)
        │     └── NoParams (placeholder)
        └── DialogFooter (Cancel + Save)
```

### Модель draft state

```
TypeEditorDraft:
  type: FieldType
  ref: MetadataRef | undefined
  allowedTypes: MetadataRef[] | undefined
  length: number | undefined
  precision: number | undefined
  scale: number | undefined
```

### Файли, які будуть змінені

| Файл | Фаза | Що змінюється |
|------|-------|---------------|
| `packages/core/src/schemas/attribute.ts` | 0 | Додати superRefine для type-specific полів |
| `packages/core/src/__tests__/attribute.test.ts` | 0, 5 | Тести stale params |
| `apps/web/src/components/properties/field-properties.tsx` | 0, 3 | Fix Integer bug → замінити inline editing на readonly + dialog trigger |
| `apps/web/src/components/layout/tree/tree-types.ts` | 1 | Розширити TreeNodeType, зробити kind optional, додати нові поля |
| `apps/web/src/components/layout/tree/tree-builder.ts` | 1 | Додати buildTypeEditorTree, адаптувати buildTreeData під optional kind |
| `apps/web/src/components/layout/tree/tree-nodes.tsx` | 1 | Розділити на presentation + interaction, додати нові node renderers |
| `apps/web/src/components/properties/metadata-ref-picker.tsx` | 1 | Видалити REFERENCEABLE_KINDS, використати core import |
| `apps/web/src/hooks/use-available-objects.ts` | 1 | **Новий файл** — shared hook |
| `apps/web/src/components/editor/data-type-editor-dialog.tsx` | 2 | **Новий файл** — діалог |
| `apps/web/src/components/editor/attribute-table.tsx` | 3 | Clickable type cell → dialog trigger |
| `apps/web/src/lib/format-type-label.ts` | 4 | **Новий файл** — user-facing formatter |
| `apps/web/src/i18n/locales/uk.json` | 4 | fieldType.* + dataTypeEditor.* |
| `apps/web/src/i18n/locales/en.json` | 4 | fieldType.* + dataTypeEditor.* |

---

## Пов'язана документація
- `docs/architecture/OVERVIEW.md` — загальна архітектура монорепо
- `docs/BRD-metadata-configurator.md` §6 — система типів полів
- `docs/BRD-metadata-configurator.md` §6.3 — властивості атрибутів
- `docs/tasks/editor-layer-redesign.md` — загальний план редизайну editor layer
- `.github/instructions/metadata-model.instructions.md` — правила Zod-схем
- `.github/instructions/ui-architecture.instructions.md` — правила побудови UI
- `.github/instructions/coding-style.instructions.md` — стиль коду
- `packages/core/src/schemas/attribute.ts` — Zod-схема атрибута
- `packages/core/src/schemas/field-type.ts` — FieldType enum
- `packages/core/src/schemas/metadata-ref.ts` — referenceableKindSchema, ReferenceableKind
- `apps/web/src/components/editor/standard-attributes-dialog.tsx` — еталон патерну draft + Save/Cancel

## Definition of Done (загальний)
- [ ] Core: attributeSchema відхиляє stale type-specific params (superRefine)
- [ ] Tree: TreeNodeData підтримує і sidebar, і data type editor без окремих моделей
- [ ] Tree: presentation layer відокремлений від interaction layer
- [ ] Dialog: модальний діалог "Редагування типу даних" з react-arborist деревом
- [ ] Dialog: single mode (один тип) та compound mode (polymorphic ref) працюють
- [ ] Dialog: параметри типу (length, precision, scale) редагуються в діалозі
- [ ] Dialog: centralized cleanup type-specific полів при зміні типу
- [ ] Dialog: draft state + Save/Cancel — атомарне оновлення
- [ ] Integration: FieldProperties — readonly display + кнопка відкриття діалогу
- [ ] Integration: AttributeTable — click на type badge → діалог
- [ ] Integration: Constant.valueType не зачеплено (FieldTypeSelect залишається)
- [ ] i18n: fieldType.* namespace, dataTypeEditor.* ключі, formatTypeLabel utility
- [ ] Tests: core stale params, tree builder, dialog, sidebar regression
- [ ] Quality: `pnpm lint && pnpm typecheck && pnpm test` — все зелене
