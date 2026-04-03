# Task: Reference Type Redesign — уніфікація посилальних типів

> **⚠️ Ця задача є spec change.** Вона змінює метамодель, описану в BRD. Всі фази виконуються в одній гілці/PR — BRD, core, UI та тести йдуть разом, щоб репозиторій ніколи не перебував у стані, де документація описує модель, якій код не відповідає.

## Контекст

Поточна модель reference-полів у Simetra використовує **окремі FieldType значення** (`CatalogRef`, `DocumentRef`, `EnumRef`, `AnyRef`) для кодування класу посилання, а target name зберігається окремо як `ref: string`. Водночас top-level зв'язки (`owners`, `recorderTypes`, `registerMovements`) вже використовують структурований формат `MetadataRef { kind, name }`. Це створює асиметрію і дублювання маппінгів `type → kind` у 5+ місцях коду.

### Поточна модель (❌)

- `type: "CatalogRef"` + `ref: "Products"` — kind і target розділені між двома полями
- `type: "DocumentRef"` + `ref: "SalesOrder"` — маппінг `KIND_TO_REF_PREFIX` дублюється у `find-references.ts`, `metadata-store.ts`, `metadata-ref-picker.tsx`, `field-properties.tsx`
- `type: "AnyRef"` + `allowedTypes: MetadataRef[]` — асиметрична модель: single-ref використовує `ref: string`, а polymorphic — `allowedTypes: MetadataRef[]`
- `parent_id` має фіктивне посилання `ref: "Self"` — хоча parent_id є **структурним полем ієрархії**, а не конфігурованим посиланням

### Цільова модель (✅)

- `type: "Ref"` + `ref: { kind: "Catalog", name: "Products" }` — єдиний тип, все в одному об'єкті
- `type: "Ref"` + `allowedTypes: MetadataRef[]` — polymorphic reference (замість окремого `AnyRef`)
- `ref` і `allowedTypes` **взаємовиключні** (Zod `.refine()`)
- `parent_id` — тип `UUID`, без ref (ієрархія визначається через `hierarchyType`, а не через reference-тип)
- Display формат `CatalogRef.Products` — derived value, не збережений рядок

### Чому це важливо

- Проєкт pre-release — немає зовнішніх споживачів, міграція не потрібна
- Ранній fixing запобігає накопиченню технічного боргу
- Масштабованість — додавання нового kind (наприклад `ChartOfAccounts`) не вимагає зміни FieldType enum
- Повна симетрія: `attribute.ref`, `owners[]`, `recorderTypes[]`  — всі використовують `MetadataRef`

---

## Фаза 0: BRD та документація update

**Мета:** Привести специфікацію у відповідність до цільової моделі. Без цієї фази решта задачі формально суперечить чинній документації.

### Вимоги

- [Х] Оновити `docs/BRD-metadata-configurator.md` §6.2 — замінити таблицю reference types (`CatalogRef`, `DocumentRef`, `EnumRef`, `AnyRef`) на один `Ref` з двома режимами (single / polymorphic)
- [Х] Оновити `docs/BRD-metadata-configurator.md` §6.3 — поле `ref` стає `MetadataRef | undefined` замість `String`; додати опис `allowedTypes` як альтернативного режиму для polymorphic ref
- [Х] Оновити `docs/BRD-metadata-configurator.md` §5.2 — `parent_id` тип → `UUID` (структурне поле ієрархії, не reference); видалити згадку `CatalogRef.Self`
- [Х] Оновити `docs/BRD-metadata-configurator.md` §5.2 — `owner_id`: single owner → `type: Ref, ref: { kind: "Catalog", name: "{Owner}" }`; multiple owners → `type: Ref, allowedTypes: owners[]`
- [Х] Оновити `docs/BRD-metadata-configurator.md` §5.5, §5.6 — `recorder_id`: `type: Ref, ref: { kind: "Document", name: "{Recorder}" }` / `allowedTypes: recorderTypes[]`
- [Х] Оновити `docs/BRD-metadata-configurator.md` §7.4, §7.5 — JSON приклади під нову модель
- [Х] Оновити `docs/BRD-metadata-configurator.md` §16 — уточнити вирішене питання "compound types": тепер `Ref` + `allowedTypes`, а не окремий `AnyRef`
- [Х] Оновити `.github/instructions/metadata-model.instructions.md` — правила Zod-схем під нову модель

### DoD фази 0
- [Х] BRD не згадує `CatalogRef`, `DocumentRef`, `EnumRef`, `AnyRef` як FieldType значення
- [Х] BRD не згадує `CatalogRef.Self` — parent_id описаний як UUID
- [Х] JSON приклади у BRD використовують `type: "Ref"` + `ref: { kind, name }`
- [Х] `.github/instructions/` узгоджені з новою моделлю

---

## Фаза 1: Core schema (packages/core)

**Мета:** Змінити Zod-схеми, серіалізацію, стандартні реквізити та тести.

### Вимоги

- [Х] `field-type.ts` — видалити `referenceFieldType` enum. Створити єдиний `fieldTypeSchema = z.enum([...primitives, "Ref"])`. Видалити типи `PrimitiveFieldType`, `ReferenceFieldType` — залишити один `FieldType`
- [Х] `attribute.ts` — змінити `ref` з `z.string().optional()` на `metadataRefSchema.optional()`. Зберегти `allowedTypes: z.array(metadataRefSchema).optional()`. Додати `.refine()`: якщо `type === "Ref"`, має бути заповнено **рівно одне** з `ref` або `allowedTypes` (або жодне — для стану "ще не обрано"). Одночасна присутність обох — помилка валідації
- [Х] `standard-attributes.ts` — змінити `StandardAttribute` інтерфейс: `ref` стає `{ kind: string; name: string } | undefined`, додати `allowedTypes?: { kind: string; name: string }[]`
- [Х] `standard-attributes.ts` — `parent_id`: змінити тип на `UUID`, **видалити** `ref: 'Self'`. parent_id — структурне поле ієрархії (`hierarchyType`), а не конфігуроване посилання
- [Х] `standard-attributes.ts` — `owner_id`: single owner → `type: 'Ref', ref: { kind: 'Catalog', name: owners[0].name }`; multiple owners → `type: 'Ref', allowedTypes: owners.map(...)`
- [Х] `standard-attributes.ts` — `recorder_id`: single recorder → `type: 'Ref', ref: { kind: 'Document', name: recorderTypes[0].name }`; multiple → `type: 'Ref', allowedTypes: recorderTypes`
- [Х] `index.ts` — видалити exports `primitiveFieldType`, `referenceFieldType`, `PrimitiveFieldType`, `ReferenceFieldType`
- [Х] `serialization.ts` — додати `ref` до `NESTED_OBJECT_KEY_ORDERS` як `ref: METADATA_REF_KEY_ORDER` (ref тепер object, а не scalar)
- [Х] Оновити `__tests__/schemas.test.ts` — тести single ref, polymorphic ref, mutual exclusion ref/allowedTypes
- [Х] Оновити `__tests__/fixtures/` — JSON під нову модель (`type: "Ref"`, `ref: { kind, name }`)

### DoD фази 1
- [Х] `pnpm --filter @simetra/core test` — всі тести проходять
- [Х] `pnpm typecheck` — без помилок
- [Х] Жодне значення `CatalogRef`/`DocumentRef`/`EnumRef`/`AnyRef` не існує в core
- [Х] Тест: `parent_id` має `type: 'UUID'`, без `ref`
- [Х] Тест: `owner_id` з одним owner → `type: 'Ref'` + `ref: MetadataRef`
- [Х] Тест: `owner_id` з кількома owners → `type: 'Ref'` + `allowedTypes: MetadataRef[]`
- [Х] Тест: `recorder_id` — аналогічні кейси
- [Х] Тест: attribute з `ref` і `allowedTypes` одночасно → validation error
- [Х] Тест: attribute з `type: 'Ref'` без `ref` і без `allowedTypes` → valid (стан "ще не обрано")

---

## Фаза 2: UI adaptation (apps/web)

**Мета:** Прибрати маппінги type→kind, перевести UI на MetadataRef, спростити reference editing flow.

### FieldTypeSelect

- [ ] Зберегти дві `CommandGroup`: "Примітивні типи" і "Посилання"
- [ ] В групі "Посилання" — один пункт `Ref` (з іконкою `Link04Icon` та label "Посилання")
- [ ] При виборі `Ref` — auto-scroll/focus на секцію "Тип даних" у правій панелі

### MetadataRefPicker

- [ ] Переробити для роботи з `MetadataRef` (`{ kind, name }`) замість `string`
- [ ] Показувати ВСІ referenceable kinds (Catalog, Document, Enumeration), згруповані в `CommandGroup`
- [ ] Додати перемикач single ref ↔ polymorphic ref (чекбокс "Складений тип")
- [ ] Single ref: вибір одного `MetadataRef` → `attribute.ref` (при перемиканні з polymorphic — очищати `allowedTypes`)
- [ ] Polymorphic ref: мультивибір `MetadataRef[]` → `attribute.allowedTypes` (при перемиканні з single — очищати `ref`). Використати існуючий `AllowedTypesMultiPicker`
- [ ] Показувати значення у форматі `{Kind}Ref.{Name}` (наприклад `CatalogRef.Products`)
- [ ] Кнопка очищення (скидає `ref` / `allowedTypes`)
- [ ] Валідація існування target object

### FieldProperties

- [ ] Спростити логіку: якщо `type === "Ref"` → показувати MetadataRefPicker
- [ ] Видалити `REF_TYPE_TO_KIND` маппінг та всю логіку визначення kind з type
- [ ] Видалити `isAnyRef` / `isSingleRef` розділення
- [ ] При зміні type з `Ref` на інший — очищати `ref` і `allowedTypes`
- [ ] При зміні type на `Ref` — зберігати `ref`/`allowedTypes` якщо вони вже задані

### attribute-table.tsx

- [ ] Display format для ref: `formatRefDisplay` helper
  - `type === "Ref"` + `ref` → `CatalogRef.Products`
  - `type === "Ref"` + `allowedTypes` → `AnyRef(2)` (кількість дозволених типів)
  - `type === "Ref"` без ref/allowedTypes → `Ref (не вказано)`
  - будь-який інший тип — як є

### tree display

- [ ] `metadata-icons.ts` — замінити 4 записи (`CatalogRef`, `DocumentRef`, `EnumRef`, `AnyRef`) на один `Ref: Link04Icon`
- [ ] `tree-builder.ts` — передавати derived `fieldTypeDisplay: string` у TreeNodeData (замість raw `attr.type`), щоб дерево показувало `CatalogRef.Products` а не `Ref`
- [ ] `tree-nodes.tsx` — використовувати `fieldTypeDisplay` для відображення

### Store та логіка

- [ ] `find-references.ts` — видалити `KIND_TO_REF_PREFIX`. Порівнювати `attr.ref?.kind === targetKind && attr.ref?.name === targetName` напряму. Зберегти перевірку `attr.allowedTypes`
- [ ] `metadata-store.ts` — cascade rename: оновлювати `ref.kind` + `ref.name` напряму. Зберегти оновлення `allowedTypes`
- [ ] `metadata-store.ts` — cascade rename: видалити `KIND_TO_REF_PREFIX` маппінг

### DoD фази 2
- [ ] Жодного `REF_TYPE_TO_KIND` або `KIND_TO_REF_PREFIX` маппінгу в codebase
- [ ] Жодних перевірок `CatalogRef`/`DocumentRef`/`EnumRef`/`AnyRef` у UI-коді
- [ ] FieldTypeSelect показує один пункт "Посилання" в окремій групі
- [ ] MetadataRefPicker — unified picker для single і polymorphic ref
- [ ] Таблиця реквізитів показує derived display format
- [ ] Дерево показує derived display format

---

## Фаза 3: Тести та валідація

**Мета:** Переконатися що все працює коректно end-to-end.

### Вимоги

- [ ] Оновити `apps/web/src/__tests__/module-a-bugfixes.test.ts` — тести find-references під нову модель (`ref: { kind, name }` замість `type: CatalogRef` + `ref: string`)
- [ ] Перевірити що cascade rename працює коректно для single ref і polymorphic ref
- [ ] Перевірити що delete confirmation dialog показує правильні залежності
- [ ] `pnpm lint` — без помилок
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm test` — core + web, все зелене

### DoD фази 3
- [ ] `pnpm lint && pnpm typecheck && pnpm test` — все проходить
- [ ] Manual smoke test: створити об'єкт, додати Ref поле, обрати target, перейменувати target — ref оновиться

---

## Clarify (вирішені питання)

- [✅] **Це задача на реалізацію BRD чи на зміну моделі?**
  - **Рішення:** Spec change. BRD описує стару модель, задача її змінює. BRD оновлюється в Фазі 0

- [✅] **Формат display value у таблиці реквізитів**
  - **Рішення:** `{Kind}Ref.{Name}` — derived value з `ref.kind` + `ref.name`. Для polymorphic — `AnyRef({count})`. Для не вказаного — `Ref (не вказано)`

- [✅] **Доля AnyRef і allowedTypes**
  - **Рішення:** Зберегти `allowedTypes` у `attributeSchema`. Один тип `Ref`, два режими: single (`ref: MetadataRef`) і polymorphic (`allowedTypes: MetadataRef[]`). Взаємовиключні через `.refine()`

- [✅] **Self-reference для parent_id**
  - **Рішення:** `parent_id` — це НЕ reference-поле. Це структурний механізм ієрархії, визначений через `hierarchyType`. Тип `parent_id` стає `UUID` (foreign key на ту ж таблицю). `ref: 'Self'` видаляється повністю. Cascade rename/delete для parent_id не потрібен — target завжди implicit

- [✅] **Як позначити `Ref` у FieldType**
  - **Рішення:** Єдиний `fieldTypeSchema = z.enum([...primitives, "Ref"])`. Видалити `primitiveFieldType`/`referenceFieldType` поділ. UI може мати власні масиви-константи для групування

- [✅] **Reference integrity при delete**
  - **Рішення:** Не змінювати boundary. `deleteObject` залишається голою мутацією. `findReferences` оновлюється під нову модель. Перевірка залежностей — в UI (`tree-panel`)

- [✅] **Стандартні реквізити з Ref — owner_id, recorder_id**
  - **Рішення:** `StandardAttribute.ref` стає `{ kind: string; name: string } | undefined`. Single owner/recorder → `ref: { kind, name }`. Multiple → `allowedTypes: [...]`

---

## Рекомендовані патерни

### Єдиний `fieldTypeSchema` без поділу

Один enum з усіма типами. Поділ на `primitiveFieldType`/`referenceFieldType` — деталь імплементації, яка більше не має сенсу з одним `Ref`. UI може мати власні масиви-константи для групування.

### `MetadataRef` як universal reference format

`{ kind, name }` — єдиний формат для ВСІХ посилань: `attribute.ref`, `attribute.allowedTypes[]`, `owners[]`, `recorderTypes[]`, `registerMovements[]`. Повна симетрія.

### Single ref vs Polymorphic ref — discriminant через поля

- `type: "Ref"` + `ref: MetadataRef` = single reference
- `type: "Ref"` + `allowedTypes: MetadataRef[]` = polymorphic reference
- Взаємовиключні через Zod `.refine()`
- В UI: перемикач "Складений тип" в picker

### Display format як derived value

`CatalogRef.Products` — це `formatRefDisplay(attr)`, не збережений рядок. Хелпер в `apps/web/src/lib/`. Використовується в таблиці, дереві, FieldProperties.

### parent_id — структурне поле, не reference

parent_id — це механізм ієрархії, визначений через `hierarchyType`. Його тип = `UUID`, foreign key на ту саму таблицю генерується автоматично при `hierarchyType !== 'None'`. Це не configurable reference — target завжди implicit (сам каталог).

### Picker з CommandGroup per kind

shadcn/ui Command + `CommandGroup` з heading. Кожен kind — окрема група. Пошук фільтрує по всіх групах (built-in в cmdk).

---

## Антипатерни (уникати)

### ❌ Окремі FieldType per reference kind

`CatalogRef`, `DocumentRef`, `EnumRef` як окремі значення FieldType — причина поточного дублювання. Kind посилання має бути в `ref.kind`.

### ❌ Маппінг type → kind

`REF_TYPE_TO_KIND`, `KIND_TO_REF_PREFIX` — дублюються в 5+ файлах. Після redesign — не потрібні.

### ❌ ref як plain string

`ref: "Products"` без kind — втрата контексту. Тільки `ref: { kind, name }`.

### ❌ Self-reference через ref

`ref: "Self"` або `ref: { kind: "Catalog", name: "Self" }` — архітектурно некоректно. parent_id — це ієрархія, а не reference. Ієрархія визначається через `hierarchyType`, не через тип поля.

### ❌ Парсинг рядків для reference

`"CatalogRef.Products".split(".")` — крихкий pattern. Structured `{ kind, name }` — надійний.

---

## Архітектурні рішення

### Трансформація моделі даних

```
ЗАРАЗ:                                     ПІСЛЯ:
───────────────────────────────────         ───────────────────────────────────
attribute:                                  attribute:
  type: "CatalogRef"                          type: "Ref"
  ref: "Products"          (string)           ref:                (MetadataRef)
                                                kind: "Catalog"
                                                name: "Products"

attribute (polymorphic):                    attribute (polymorphic):
  type: "AnyRef"                              type: "Ref"
  allowedTypes: [                             allowedTypes: [
    { kind: "Catalog", name: "A" }              { kind: "Catalog", name: "A" }
  ]                                           ]

parent_id:                                  parent_id:
  type: "CatalogRef"                          type: "UUID"
  ref: "Self"                                 (без ref — ієрархія через hierarchyType)

FieldType enum:                             FieldType enum:
  UUID, String, Text, ...                     UUID, String, Text, ...
  CatalogRef, DocumentRef,                    Ref
  EnumRef, AnyRef
```

### Mapping скасованих типів

| Старий тип | Новий тип | Нова структура |
|-----------|----------|----------------|
| `CatalogRef` + `ref: "X"` | `Ref` | `ref: { kind: "Catalog", name: "X" }` |
| `DocumentRef` + `ref: "X"` | `Ref` | `ref: { kind: "Document", name: "X" }` |
| `EnumRef` + `ref: "X"` | `Ref` | `ref: { kind: "Enumeration", name: "X" }` |
| `AnyRef` + `allowedTypes: [...]` | `Ref` | `allowedTypes: [...]` (без змін формату) |
| `CatalogRef` + `ref: "Self"` (parent_id) | `UUID` | без ref (структурне поле) |

### Потік UI

```
1. Користувач у FieldTypeSelect обирає тип "Ref" (Посилання)
2. В правій панелі (FieldProperties) з'являється MetadataRefPicker
3. За замовчуванням — single ref mode
4. Picker відкриває Popover з Command:
   ┌──────────────────────────────┐
   │ 🔍 Пошук...                 │
   ├──────────────────────────────┤
   │ ☑ Складений тип             │
   ├──────────────────────────────┤
   │ 📂 Довідники                │
   │   ◻ Products                │
   │   ◻ Warehouses              │
   │ 📂 Документи                │
   │   ◻ SalesOrder              │
   │ 📂 Перелічення              │
   │   ◻ OrderStatus             │
   └──────────────────────────────┘
5. Single: обирає один → ref: MetadataRef
6. Polymorphic (☑ Складений тип): обирає кілька → allowedTypes: MetadataRef[]
7. У таблиці: "CatalogRef.Products" або "AnyRef(2)"
```

---

## Файли, що потребують змін

### Фаза 0: Документація

| Файл | Зміни |
|------|-------|
| `docs/BRD-metadata-configurator.md` | §5.2, §5.5, §5.6, §6.2, §6.3, §7.4, §7.5, §16 |
| `.github/instructions/metadata-model.instructions.md` | Правила Zod-схем під нову модель |

### Фаза 1: Core

| Файл | Зміни |
|------|-------|
| `src/schemas/field-type.ts` | Один `fieldTypeSchema` з `"Ref"`. Видалити `PrimitiveFieldType`, `ReferenceFieldType` |
| `src/schemas/attribute.ts` | `ref: metadataRefSchema.optional()`. Зберегти `allowedTypes`. Додати `.refine()` для mutual exclusion |
| `src/schemas/standard-attributes.ts` | `parent_id`: type → UUID, без ref. `owner_id`/`recorder_id`: single → Ref+ref, multiple → Ref+allowedTypes |
| `src/schemas/index.ts` | Видалити exports `primitiveFieldType`, `referenceFieldType`, `PrimitiveFieldType`, `ReferenceFieldType` |
| `src/serialization.ts` | Додати `ref` до `NESTED_OBJECT_KEY_ORDERS` (тепер object) |
| `src/__tests__/schemas.test.ts` | Тести single ref, polymorphic ref, mutual exclusion, parent_id як UUID |
| `src/__tests__/fixtures/` | Оновити JSON під нову модель |

### Фаза 2: UI

| Файл | Зміни |
|------|-------|
| `src/components/editor/field-type-select.tsx` | Група "Посилання" з одним пунктом `Ref` |
| `src/components/properties/metadata-ref-picker.tsx` | Unified picker: single + polymorphic, MetadataRef, всі kinds |
| `src/components/properties/field-properties.tsx` | Спрощення: `type === "Ref"` → показати picker. Видалити маппінги |
| `src/components/editor/attribute-table.tsx` | `formatRefDisplay` для display format |
| `src/components/layout/tree/tree-builder.ts` | Передавати `fieldTypeDisplay` замість raw type |
| `src/components/layout/tree/tree-nodes.tsx` | Використовувати `fieldTypeDisplay` |
| `src/lib/metadata-icons.ts` | Один запис `Ref: Link04Icon` замість чотирьох |
| `src/stores/metadata-store.ts` | Cascade rename: прямий доступ до `ref.kind`/`ref.name`. Видалити `KIND_TO_REF_PREFIX` |
| `src/lib/find-references.ts` | Видалити `KIND_TO_REF_PREFIX`. Пряме порівняння `ref.kind` + `ref.name` |
| `src/lib/format-ref-display.ts` | **Новий файл**: хелпер `formatRefDisplay(attr)` для derived display |
| `src/components/layout/tree/tree-types.ts` | Додати `fieldTypeDisplay?: string` до `TreeNodeData` |
| `src/i18n/locales/uk.json` | Оновити/додати ключі для "Посилання", "Складений тип", display форматів |
| `src/i18n/locales/en.json` | Аналогічно |

### Фаза 3: Тести

| Файл | Зміни |
|------|-------|
| `src/__tests__/module-a-bugfixes.test.ts` | find-references під нову модель |

---

## Пов'язана документація

- `docs/BRD-metadata-configurator.md` §6.2 — посилальні типи (потребує оновлення)
- `docs/BRD-metadata-configurator.md` §6.3 — властивості поля (потребує оновлення)
- `docs/BRD-metadata-configurator.md` §5.2 — стандартні реквізити каталогу (потребує оновлення: parent_id, owner_id)
- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `.github/instructions/metadata-model.instructions.md` — правила Zod-схем (потребує оновлення)
- `.github/instructions/architecture-core.instructions.md` — архітектурні обмеження core
- `docs/tasks/editor-layer-redesign.md` — Модуль F (Reference Picker) — цю задачу замінює

---

## Definition of Done

### Документація (Фаза 0)
- [Х] BRD не згадує `CatalogRef`/`DocumentRef`/`EnumRef`/`AnyRef` як FieldType значення
- [Х] BRD не згадує `CatalogRef.Self` — `parent_id` описаний як `UUID`
- [Х] JSON приклади у BRD використовують `type: "Ref"` + `ref: { kind, name }`

### Core (Фаза 1)
- [Х] `fieldTypeSchema` — єдиний enum з `"Ref"`, без `CatalogRef`/`DocumentRef`/`EnumRef`/`AnyRef`
- [Х] `attributeSchema.ref` — тип `MetadataRef | undefined`
- [Х] `attributeSchema` — `.refine()` для mutual exclusion `ref` / `allowedTypes`
- [Х] `parent_id` — тип `UUID`, без `ref`
- [Х] `owner_id` — single → `Ref` + `ref`, multiple → `Ref` + `allowedTypes`
- [Х] `recorder_id` — аналогічно `owner_id`
- [Х] `pnpm --filter @simetra/core test` — все зелене
- [Х] `pnpm typecheck` — без помилок

### UI (Фаза 2)
- [ ] FieldTypeSelect — один пункт "Посилання" в окремій групі
- [ ] MetadataRefPicker — unified для single і polymorphic ref, працює з `MetadataRef`
- [ ] FieldProperties — одна умова `type === "Ref"`, без маппінгів
- [ ] Таблиця реквізитів — derived display format (`CatalogRef.Products` / `AnyRef(2)` / `Ref (не вказано)`)
- [ ] Дерево — derived display format
- [ ] Cascade rename — пряме оновлення `ref.kind`/`ref.name` і `allowedTypes`
- [ ] find-references — пряме порівняння без маппінгів
- [ ] Жодного `REF_TYPE_TO_KIND` або `KIND_TO_REF_PREFIX` в codebase

### Якість (Фаза 3)
- [ ] `pnpm lint` — без помилок
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm test` — core + web, все зелене
- [ ] Жодного значення `CatalogRef`/`DocumentRef`/`EnumRef`/`AnyRef` як FieldType enum value в codebase
  - **Примітка:** рядки `CatalogRef.Products` у display-форматі — це derived values, не enum values. Вони допустимі в UI-хелперах і тестах
