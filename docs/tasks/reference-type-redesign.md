# Task: Reference Type Redesign — уніфікація посилальних типів за моделлю 1С

## Контекст

Поточна модель reference-полів у Simetra побудована неправильно: reference type кодує **клас** посилання (`CatalogRef`, `DocumentRef`, `EnumRef`) як окремі значення FieldType, а target name зберігається окремо в `ref: string`. Це суперечить моделі 1С:Підприємства, де є один тип "Посилання" (`СправочникСсылка.Номенклатура`), а конкретний target фіксується в самій структурі реквізиту.

### Поточна модель (❌)

- `type: "CatalogRef"` + `ref: "Products"` — kind і target розділені
- `type: "DocumentRef"` + `ref: "SalesOrder"` — дублювання маппінгу kind↔type в 5+ місцях коду
- `type: "AnyRef"` + `allowedTypes: MetadataRef[]` — асиметрична модель порівняно з single-ref
- Top-level references (`owners`, `recorderTypes`, `registerMovements`) вже використовують `MetadataRef { kind, name }` — тобто повну кваліфіковану форму

### Цільова модель (✅)

- `type: "Ref"` + `ref: { kind: "Catalog", name: "Products" }` — єдиний тип, все в одному місці
- Display формат `CatalogRef.Products` виводиться з `ref.kind` + `ref.name`, а не зберігається як string
- Один UI picker для всіх kinds (як форма "Редагування типу данних" у 1С)

### Чому це важливо

- Проєкт на ранній стадії — немає користувачів і збережених конфігурацій, міграція не потрібна
- Виправлення зараз запобігає накопиченню технічного боргу
- Масштабованість — додавання нового kind (наприклад `ChartOfAccounts`) не вимагає зміни FieldType enum
- Пряма відповідність BRD §6.2, де тип записується як `CatalogRef.{Name}` — тобто єдиний кваліфікований ідентифікатор

---

## Вимоги

### Core (packages/core)

- [ ] Замінити `referenceFieldType` enum (`CatalogRef`, `DocumentRef`, `EnumRef`, `AnyRef`) на один literal `"Ref"` у `field-type.ts`
- [ ] Змінити `ref` у `attributeSchema` з `z.string().optional()` на `metadataRefSchema.optional()`
- [ ] Видалити `allowedTypes` з `attributeSchema` повністю (мультивибір — окрема майбутня задача)
- [ ] Оновити `standard-attributes.ts`: замінити `type: "CatalogRef"` / `type: "DocumentRef"` на `type: "Ref"`, `ref` змінити з `string` на `{ kind, name }` у `StandardAttribute` інтерфейсі
- [ ] Оновити тести в `packages/core/src/__tests__/schemas.test.ts` під нову модель
- [ ] Оновити fixtures у `packages/core/src/__tests__/fixtures/` за потреби
- [ ] Оновити `serialization.ts`, якщо є reference-специфічна логіка

### UI — FieldTypeSelect (apps/web)

- [ ] Прибрати окрему групу "Reference types" з FieldTypeSelect
- [ ] Додати `"Ref"` як один пункт у загальному списку типів (з відповідною іконкою та label)
- [ ] При виборі `"Ref"` — автоматично фокусувати MetadataRefPicker у правій панелі

### UI — MetadataRefPicker (apps/web)

- [ ] Переробити як єдиний picker для вибору target reference
- [ ] Показувати ВСІ referenceable kinds (Catalog, Document, Enumeration), згруповані в CommandGroup
- [ ] Працювати з `MetadataRef` (`{ kind, name }`) замість plain `string`
- [ ] Показувати значення у форматі `CatalogRef.{Name}` або `{Kind}.{Name}` (локалізовано)
- [ ] Зберегти пошук (Command/cmdk) та валідацію існування target
- [ ] Кнопка очищення (встановити `ref: undefined`)

### UI — FieldProperties (apps/web)

- [ ] Спростити логіку: якщо `type === "Ref"` → показувати MetadataRefPicker, інакше — ні
- [ ] Видалити маппінг `REF_TYPE_TO_KIND` та всю логіку визначення kind з type
- [ ] Видалити `isAnyRef` / `isSingleRef` розділення — тепер завжди один picker
- [ ] При зміні type з `Ref` на інший — очищати `ref`
- [ ] При зміні type на `Ref` — зберігати `ref` якщо він вже був заданий

### UI — Мультивибір та "Будь-яке посилання" (placeholder)

- [ ] В UI picker-а додати **disabled** опцію/чекбокс "Складений тип" з tooltip "Буде доступно пізніше"
- [ ] В UI picker-а додати **disabled** опцію "Будь-яке посилання" з tooltip "Буде доступно пізніше"
- [ ] НЕ реалізовувати логіку мультивибору — лише UI-заглушка

### Store та логіка (apps/web)

- [ ] Оновити `find-references.ts`: порівнювати `attr.ref?.kind` + `attr.ref?.name` напряму замість виведення kind з attr.type
- [ ] Оновити `metadata-store.ts` cascade rename: оновлювати `ref.kind` + `ref.name` напряму при rename цільового об'єкта
- [ ] Оновити `metadata-store.ts` deleteObject: перевіряти `ref.kind` + `ref.name` при пошуку залежностей
- [ ] Оновити `metadata-defaults.ts` якщо є reference-специфічна логіка
- [ ] Оновити `tree-nodes.tsx`: іконки вузлів для поля з `type: "Ref"` замість перевірок `CatalogRef`/`DocumentRef`/`EnumRef`
- [ ] Оновити `attribute-table.tsx`: відображення type у таблиці — показувати `Ref → CatalogRef.Products` замість просто `CatalogRef`

### Тести

- [ ] Оновити `packages/core/src/__tests__/schemas.test.ts` — тести валідації нової структури
- [ ] Оновити `apps/web/src/__tests__/module-a-bugfixes.test.ts` — тести find-references
- [ ] Переконатися, що всі existing тести проходять після змін

---

## Clarify (питання перед імплементацією)

- [Х] **Формат display value у таблиці реквізитів**
  - Чому це важливо: у стовпці "Тип" таблиці AttributeTable потрібно показувати повний кваліфікований тип
  - Варіанти: (A) `CatalogRef.Products` — точна відповідність BRD §6.2 | (B) `Ref(Catalog.Products)` — functional notation | (C) `Довідник.Products` — локалізований kind
  - Вплив на рішення: UI, i18n
  - **Рішення:** (A) — BRD-формат `CatalogRef.{Name}`, з можливістю tooltip на hover для локалізованого варіанту

- [Х] **Стандартні реквізити з type "Ref" — структура StandardAttribute**
  - Чому це важливо: `StandardAttribute` інтерфейс зараз має `ref?: string`, а потрібен `ref?: { kind: string; name: string }` або повторне використання `MetadataRef`
  - Варіанти: (A) змінити `ref` на `MetadataRef`-подібний об'єкт | (B) використовувати рядок у форматі `Kind/Name` і парсити
  - Вплив на рішення: core типи, серіалізація
  - **Рішення:** (A) — структурований об'єкт, без парсингу рядків. `StandardAttribute.ref` стає `{ kind: string; name: string } | undefined`. Спеціальне значення `{ kind: "Self", name: "" }` для parent_id (посилання на себе)

- [ ] **Як позначити `Ref` у FieldType — окреме значення чи частина primitives?**  
  - Чому це важливо: семантично `Ref` — не primitive, але технічно немає сенсу мати окремий referenceFieldType enum з одним значенням
  - Варіанти: (A) додати `"Ref"` до primitiveFieldType, перейменувати в `fieldType` | (B) зберегти два enum, де reference = `z.enum(["Ref"])` | (C) зробити `fieldTypeSchema = z.enum([...all including Ref])`
  - Вплив на рішення: архітектура core, export surface
  - **Рекомендація:** (C) — єдиний `fieldTypeSchema = z.enum([...primitives, "Ref"])`. Видалити `primitiveFieldType`/`referenceFieldType` поділ — він більше не має сенсу. Якщо для UI потрібно розділити, це робиться масивами-константами в UI-коді, а не Zod-схемами

---

## Рекомендовані патерни

### Єдиний `fieldTypeSchema` без поділу

Замість двох enum'ів з union — один enum з усіма типами. Reference-типів тепер один (`Ref`), тому окремий `referenceFieldType` зайвий. UI може мати власний масив-константу `PRIMITIVE_TYPES` / `REFERENCE_TYPES` для групування в select, але в core це не потрібно.

### `MetadataRef` як universal reference format

`{ kind, name }` — єдиний формат для ВСІХ посилань: `attribute.ref`, `owners[]`, `recorderTypes[]`, `registerMovements[]`. Повна симетрія. Код, що працює з посиланнями, має один інтерфейс.

### Display format як derived value

`CatalogRef.Products` — це function від `ref.kind` + `ref.name`, а не збережений рядок. Хелпер `formatRefDisplay(ref: MetadataRef): string` у core або UI utils. Використовується в таблиці реквізитів, в дереві метаданих, в FieldProperties.

### Picker з CommandGroup per kind

shadcn/ui Command вже підтримує `CommandGroup` з heading. Кожен kind — окрема група: "Довідники", "Документи", "Перелічення". Всередині — відсортовані об'єкти. Пошук фільтрує по всіх групах одночасно (built-in в cmdk).

### `Self` reference для parent_id

Стандартний реквізит `parent_id` каталогу посилається на сам каталог. Конвенція: `ref: { kind: "Self", name: "" }` або `ref: { kind: "Catalog", name: "Self" }`. При runtime рендерінг — розрізняти як special case. Рекомендація: використовувати `ref: { kind: "Catalog", name: "Self" }` — менше special case логіки, `kind: "Self"` потребує розширення MetadataKind.

---

## Антипатерни (уникати)

### ❌ Окремі FieldType per reference kind

`CatalogRef`, `DocumentRef`, `EnumRef` як окремі значення FieldType — точно те, від чого ми відходимо. Вся інформація про kind посилання має бути в `ref.kind`, а не дублюватися в `type`.

### ❌ Маппінг type → kind у декількох місцях

Поточний `REF_TYPE_TO_KIND` map продубльований у `MetadataRefPicker`, `FieldProperties`, `find-references.ts`, `metadata-store.ts`. Після рефакторингу kind вже є в `ref.kind` — маппінг не потрібен.

### ❌ ref як plain string

`ref: "Products"` без kind — втрата контексту. Потребує зовнішнього маппінгу для відновлення повного кваліфікованого посилання. Тільки `ref: { kind, name }`.

### ❌ Парсинг рядків для reference

`"CatalogRef.Products".split(".")` — крихкий pattern, порушується при name з крапкою. Structured object `{ kind, name }` — надійний.

### ❌ Мультивибір та AnyRef у цій задачі

Складений тип (мультивибір) та "будь-яке посилання" — окрема задача на обговорення. В цій задачі — тільки single-ref з `type: "Ref"` + `ref: MetadataRef`. МультиВибір лише як disabled UI placeholder.

### ❌ allowedTypes в новій моделі

Повністю видалити з `attributeSchema`. Повернеться в іншій формі при реалізації мультивибору.

---

## Архітектурні рішення

### Трансформація моделі даних

```
ЗАРАЗ:                                  ПІСЛЯ:
─────────────────────────────────        ─────────────────────────────────
attribute:                               attribute:
  type: "CatalogRef"                       type: "Ref"
  ref: "Products"          (string)        ref:                (MetadataRef)
  allowedTypes: [...]      (AnyRef)          kind: "Catalog"
                                             name: "Products"
                                           (allowedTypes видалений)

FieldType enum:                          FieldType enum:
  UUID, String, Text, ...                  UUID, String, Text, ...
  CatalogRef, DocumentRef,                 Ref
  EnumRef, AnyRef
```

### Mapping скасованих типів

| Старий тип | Новий тип | Новий ref |
|-----------|----------|----------|
| `CatalogRef` + `ref: "X"` | `Ref` | `{ kind: "Catalog", name: "X" }` |
| `DocumentRef` + `ref: "X"` | `Ref` | `{ kind: "Document", name: "X" }` |
| `EnumRef` + `ref: "X"` | `Ref` | `{ kind: "Enumeration", name: "X" }` |
| `AnyRef` + `allowedTypes: [...]` | N/A — видаляється | Мультивибір — окрема задача |

### Потік UI (Reference Picker як у 1С)

```
1. Користувач у FieldTypeSelect обирає тип "Ref" (Посилання)
2. В правій панелі (FieldProperties) з'являється MetadataRefPicker
3. Picker відкриває Popover з Command:
   ┌──────────────────────────────┐
   │ 🔍 Пошук...                 │
   ├──────────────────────────────┤
   │ ☐ Складений тип (disabled)  │
   │ ☐ Будь-яке посилання (dis.) │
   ├──────────────────────────────┤
   │ 📂 Довідники                │
   │   ◻ Products                │
   │   ◻ Warehouses              │
   │   ◻ Contractors             │
   │ 📂 Документи                │
   │   ◻ SalesOrder              │
   │   ◻ Payment                 │
   │ 📂 Перелічення              │
   │   ◻ OrderStatus             │
   │   ◻ ProductType             │
   └──────────────────────────────┘
4. Користувач обирає → ref зберігається як MetadataRef
5. У таблиці реквізитів відображається: "CatalogRef.Products"
```

---

## Файли, що потребують змін

### packages/core

| Файл | Зміни |
|------|-------|
| `src/schemas/field-type.ts` | Видалити `referenceFieldType`. Об'єднати в один `fieldTypeSchema` з `"Ref"`. Видалити типи `PrimitiveFieldType`, `ReferenceFieldType` — залишити один `FieldType` |
| `src/schemas/attribute.ts` | `ref: metadataRefSchema.optional()`. Видалити `allowedTypes` |
| `src/schemas/standard-attributes.ts` | `StandardAttribute.ref` → `{ kind: string; name: string }`. Оновити всі standard attributes з Ref |
| `src/schemas/index.ts` | Оновити exports — прибрати `primitiveFieldType`, `referenceFieldType`, `PrimitiveFieldType`, `ReferenceFieldType` |
| `src/index.ts` | Автоматично підхопить з index.ts |
| `src/__tests__/schemas.test.ts` | Оновити тести |
| `src/__tests__/fixtures/` | Оновити fixtures |
| `src/serialization.ts` | Перевірити і оновити за потреби |

### apps/web

| Файл | Зміни |
|------|-------|
| `src/components/editor/field-type-select.tsx` | Один тип `Ref` замість групи reference types |
| `src/components/properties/metadata-ref-picker.tsx` | Повна переробка: працює з `MetadataRef`, показує всі kinds |
| `src/components/properties/field-properties.tsx` | Спрощення логіки reference handling |
| `src/components/editor/attribute-table.tsx` | Display format для ref type |
| `src/components/layout/tree/tree-nodes.tsx` | Іконки для `Ref` type |
| `src/stores/metadata-store.ts` | Cascade rename/delete з `MetadataRef` |
| `src/lib/find-references.ts` | Пряме порівняння `ref.kind` + `ref.name` |
| `src/lib/metadata-defaults.ts` | Оновити за потреби |
| `src/lib/metadata-icons.ts` | Оновити за потреби |
| `src/__tests__/module-a-bugfixes.test.ts` | Оновити тести find-references |

---

## Пов'язана документація

- `docs/BRD-metadata-configurator.md` §6.2 — специфікація посилальних типів (`CatalogRef.{Name}` формат)
- `docs/BRD-metadata-configurator.md` §6.3 — властивості поля (attribute properties)
- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `.github/instructions/metadata-model.instructions.md` — правила Zod-схем
- `.github/instructions/architecture-core.instructions.md` — архітектурні обмеження core
- `docs/tasks/editor-layer-redesign.md` — Модуль F (Reference Picker) — цю задачу замінює

---

## Definition of Done

### Core
- [ ] `fieldTypeSchema` містить `"Ref"` замість `CatalogRef`/`DocumentRef`/`EnumRef`/`AnyRef`
- [ ] `attributeSchema.ref` має тип `MetadataRef | undefined` замість `string | undefined`
- [ ] `allowedTypes` видалений з `attributeSchema`
- [ ] `StandardAttribute.ref` — structured object `{ kind, name }`
- [ ] Всі тести `pnpm --filter @simetra/core test` проходять
- [ ] `pnpm typecheck` проходить без помилок

### UI
- [ ] FieldTypeSelect показує один пункт "Посилання" (Ref) замість трьох
- [ ] MetadataRefPicker показує всі kinds згруповано, працює з `MetadataRef`
- [ ] FieldProperties коректно показує/приховує picker для `type === "Ref"`
- [ ] Таблиця реквізитів показує display format `CatalogRef.{Name}` для ref полів
- [ ] Cascade rename працює з новою моделлю `ref: MetadataRef`
- [ ] find-references працює з прямим порівнянням `ref.kind` + `ref.name`
- [ ] Disabled placeholder "Складений тип" та "Будь-яке посилання" видимі в picker

### Якість
- [ ] `pnpm lint` проходить
- [ ] `pnpm typecheck` проходить
- [ ] `pnpm test` проходить (core + web)
- [ ] Немає дублювання маппінгу type→kind — kind завжди береться з `ref.kind`
