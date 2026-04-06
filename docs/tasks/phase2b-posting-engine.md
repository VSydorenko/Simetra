# Task: Phase 2b — Posting Engine

> **Prerequisite:** Phase 2a (DDL Generator) — `@simetra/generator-pg` має існувати з базовою структурою.

## Контекст

Phase 2a створила DDL генератор для структурної генерації (CREATE TABLE, INDEX, VIEW). Phase 2b додає **бізнес-логіку на рівні БД** — декларативний маппінг проведення документів та генерацію SQL-функцій.

**Ціль Phase 2b:** Реалізувати повний цикл:
1. Користувач описує маппінг полів документа → вимірів/ресурсів регістру (через UI)
2. Маппінг зберігається у секції `posting` JSON-метаданих документа
3. Генератор створює PostgreSQL stored functions (`post_`, `unpost_`, `check_`)
4. Функції доступні як Supabase RPC endpoints

### Специфікація posting-метаданих

Повна специфікація секції `posting` описана в BRD §5.3.1: `posting.movements[]`, `posting.validations[]`, mapping expressions, межі декларативності.

> **Note:** Boolean backward-compat шар `z.union([z.boolean(), postingSchema]).default(true)` видалений задачею `posting-cleanup-and-findreferences`. Поточний контракт: `posting: postingSchema.optional()`. Детальний опис семантики — у `docs/architecture/metadata-model.md`.

---

## Етапи

### Етап 1: Zod-схеми posting у `@simetra/core`

- [Х] Створити `packages/core/src/schemas/posting.ts`:
  - `mappingExpressionSchema` — string validation для `doc.`, `row.`, `sum()`, `count()`, `literal:`, `now()`, арифметика
  - `movementMappingSetSchema` — `{ dimensions: Record<string, expr>, resources: Record<string, expr>, attributes: Record<string, expr> }`
  - `postingMovementSchema` — `{ register: MetadataRef, movementType, source, condition?, mappings }`
  - `postingValidationSchema` — `{ type: "NonNegativeBalance", register, dimensions, resource, message, applyTo? }`
  - `postingSchema` — `{ movements: postingMovementSchema[], validations: postingValidationSchema[] }`
- [Х] Розширити `documentSchema` — додати опціональне поле `posting: postingSchema.optional()`
- [Х] Оновити серіалізацію (`serialization.ts`) — додати `posting` у key order для Document
- [Х] **Тести:**
  - Валідний posting з movements + validations → pass
  - Невалідні mapping expressions → fail
  - Document без posting → pass (backward compatible)
  - Document з порожнім posting → pass
  - `pnpm --filter @simetra/core test` — green

### Етап 2: Візуальний editor маппінгів у `apps/web`

> **Залежність від Етапу 1:** posting Zod-схеми мають бути в core до початку persisted save (крок 2.6).

#### 2.1. Параметризація tree-builder

- [Х] Додати параметри в `buildTypeEditorTree` (`tree-builder.ts`):
  - `allowedKinds: readonly MetadataKind[]` — які kinds показувати (дефолт: `REFERENCEABLE_KINDS`)
  - `includePrimitives: boolean` — чи показувати примітивні типи (дефолт: `true`)
- [Х] Зберегти зворотну сумісність: поточний виклик з `DataTypeEditorDialog` працює без змін
- [Х] Оновити тести `buildTypeEditorTree` під нові параметри

#### 2.2. Виділення MetadataObjectTreeSelector

- [Х] Витягнути з `DataTypeEditorBody` спільний stateless блок `MetadataObjectTreeSelector`:
  - Props: `model`, `allowedKinds`, `searchQuery`, `selectedIds: Set<string>`, `mode: "radio" | "checkbox"`, `includePrimitives`
  - Callbacks: `onSelectTarget(MetadataRef)`, `onToggleKindGroup(kind: MetadataKind)`
  - Рендерить: search input + tree container + presentation nodes (`RefKindGroupPresentation`, `RefTargetPresentation`, опціонально `PrimitiveTypePresentation`)
  - Bulk toggle для kind groups у checkbox mode — через `kindCheckedStates` по `allowedKinds`
- [Х] Рефакторити `DataTypeEditorBody` — замінити inline tree на `MetadataObjectTreeSelector`
- [Х] Підтвердити: `DataTypeEditorDialog` працює ідентично до рефакторингу

#### 2.3. Секція "Рухи" в ObjectEditor

- [Х] Замінити placeholder `comingSoon` у секції `movements` (`object-editor.tsx`) реальним компонентом `MovementsSection`
- [Х] Перенести `registerMovements` з правої панелі (`DocumentTypeSettings` в `object-properties.tsx`) у центральну секцію:
  - Таблиця "Регістри для рухів" з колонками: Регістр, Тип руху, Джерело
  - Кнопка **"Додати"** → відкриває `RegisterPickerDialog`
  - Кнопка **"Видалити"** → видаляє обраний рядок
  - Кнопка **"Конструктор рухів"** → відкриває `MovementConstructorDialog` для обраного рядка
- [Х] Прибрати `registerMovements` picker з `DocumentTypeSettings` у правій панелі (уникнення двох точок редагування)
- [Х] Секція валідацій внизу:
  - Таблиця: Регістр, Виміри, Ресурс, Повідомлення
  - Кнопки Додати/Видалити
- [Х] Зміни `registerMovements` → оновлення через `updateObject` в metadata-store

#### 2.4. RegisterPickerDialog — діалог вибору регістрів

- [Х] Новий діалог з патерном `open/onOpenChange + revisionKey + local draft + Save → close` (як `StandardAttributesDialog`)
- [Х] Використовує `MetadataObjectTreeSelector` з props:
  - `allowedKinds={["AccumulationRegister", "InformationRegister"]}`
  - `mode="checkbox"` (multi-select)
  - `includePrimitives={false}`
  - `selectedIds` = вже додані регістри (для pre-check)
- [Х] Save → повертає `MetadataRef[]`, caller додає нові до `registerMovements`
- [Х] Cancel → відкидає зміни

#### 2.5. MovementConstructorDialog — конструктор рухів для одного регістру

- [Х] Окремий модальний діалог, відкривається по кнопці "Конструктор рухів" з обраним рядком регістру
- [Х] Патерн: `open/onOpenChange + revisionKey + local draft + Save/Cancel`
- [Х] Заголовок: "Конструктор рухів: {RegisterName}"
- [Х] Верхня частина — налаштування руху:
  - **Тип руху**: Radio `Прихід / Розхід / Динамічний` (+ dropdown для поля документа при "Динамічний")
  - **Джерело**: Dropdown `Документ / ТЧ:{name}` (список ТЧ з document.tabularSections)
  - **Умова**: Input для condition expression (опціонально)
- [Х] Основна частина — таблиця маппінгу:
  - Ліва колонка: "Поле регістру" — dimensions, resources, attributes цільового регістру, згруповані з заголовками
  - Права колонка: "Вираз" — combobox з динамічним набором опцій залежно від source:
    - Якщо source = `tabularSection:{name}`:
      - Група "Рядок ТЧ": `row.{field}` для кожного attribute ТЧ (custom + standard `line_number`)
      - Група "Документ": `doc.{field}` для кожного attribute шапки (custom + standard `number`, `date`, `posted`)
      - Група "Вираз": вільний ввід для арифметики `row.a * row.b`
    - Якщо source = `document`:
      - Група "Документ": `doc.{field}`
      - Група "Агрегати": `sum({ts}.{field})`, `count({ts})` для кожної ТЧ
      - Група "Константи": `literal:{value}`, `now()`
- [Х] При зміні source — вже заповнені вирази, що стали невалідними, підсвічуються як помилка (не очищаються автоматично)
- [Х] Save → комітить draft у posting.movements[index] через store
- [Х] Cancel → відкидає всі зміни маппінгу

#### 2.6. Persisted save та інтеграція зі store

- [Х] Posting-aware actions у metadata-store:
  - `updateMovement(kind, name, registerRef, movementDraft)` — оновити один movement
  - `removeMovement(kind, name, registerRef)` — видалити movement
  - `addValidation(kind, name, validation)` / `removeValidation(kind, name, index)`
- [Х] При додаванні/видаленні регістру в `registerMovements` — sync з `posting.movements[]` (видалення movement при видаленні регістру)
- [Х] Розширити `cascadeRenameRefs` у metadata-store для `posting.movements[].register` і `posting.validations[].register`
- [Х] Розширити `use-model-validation.ts` — перевіряти, що posting refs існують
- [Х] Зміни зберігаються через serializer у JSON-файл документа

#### 2.7. Утиліта buildExpressionOptions

- [Х] Створити `apps/web/src/lib/build-expression-options.ts`:
  - Вхід: `document: Document`, `source: string`
  - Вихід: `{ group: string, options: { value: string, label: string }[] }[]`
  - Збирає поля з: `document.attributes`, `document.tabularSections[name].attributes`, `getStandardAttributes("Document")`, `getTabularSectionStandardAttributes()`
  - Динамічно перезбирається при зміні source

#### 2.8. Тести

- [Х] Unit тест: `buildTypeEditorTree` з custom `allowedKinds` → показує тільки зазначені kinds
- [Х] Unit тест: `buildExpressionOptions` → коректні групи для source=document і source=tabularSection
- [Х] Component test: `MovementsSection` рендерить таблицю регістрів
- [ ] Component test: `RegisterPickerDialog` → multi-select → save → registerMovements оновлено
- [ ] Component test: `MovementConstructorDialog` → заповнення маппінгу → save → posting.movements оновлено
- [ ] Component test: зміна source → невалідні вирази підсвічуються
- [ ] Integration: додавання/видалення movement → store update → JSON persistence
- [X] `pnpm --filter web test` — green

### Етап 3: Генерація posting SQL у `@simetra/generator-pg`

- [X] `post_{document_name}(doc_id uuid)`:
  - Перевірка `IF posted THEN RAISE EXCEPTION`
  - Очистка попередніх рухів: `DELETE FROM {register} WHERE recorder_id = doc_id` (для кожного register з movements)
  - Для кожного `movements[]` елемента:
    - Якщо `source = "tabularSection:{name}"` → `INSERT INTO {register} SELECT ... FROM {document}_{tabularSection} WHERE parent_id = doc_id`
    - Якщо `source = "document"` → `INSERT INTO {register} VALUES (...)`
    - Mapping expressions → SQL expressions (`doc.warehouse` → `d.warehouse_id`, `row.quantity` → `ts.quantity`, `row.a * row.b` → `ts.a * ts.b`, `sum(items.amount)` → `(SELECT sum(amount) FROM ...)`)
  - Виконання валідацій
  - `UPDATE {document} SET posted = true, updated_at = now() WHERE id = doc_id`
  - Обгорнуто в `BEGIN ... END` (єдина транзакція)
- [X] `unpost_{document_name}(doc_id uuid)`:
  - `DELETE FROM {register} WHERE recorder_id = doc_id` — для кожного регістру з `movements[]`
  - `UPDATE {document} SET posted = false, updated_at = now() WHERE id = doc_id`
- [X] `check_{register}_{resource}(dimensions...)`:
  - Перевіряє, що залишок не стане від'ємним
  - Підставляє displayName у повідомлення помилки
- [X] Точка розширення: виклик `{document_name}_post_custom(doc_id)` (якщо функція існує)
- [X] **Тести:**
  - Golden fixture: GoodsReceipt → InventoryBalance (tabularSection source)
  - Golden fixture: PaymentOrder → SettlementsBalance (document source)
  - Динамічний movementType (`doc.operation_type`)
  - NonNegativeBalance validation → correct check function
  - Арифметика в mappings: `row.quantity * row.price`
  - Агрегація: `sum(items.amount)`
  - `pnpm --filter @simetra/generator-pg test` — green

---

## Clarify (питання перед імплементацією)

- [Х] ~~**Drag-and-drop vs dropdown для маппінгів?**~~ → Combobox з автокомплітом для MVP. Drag-drop як enhancement.
- [Х] ~~**Inline editor vs окремий діалог для маппінгів?**~~ → Окремий `MovementConstructorDialog` для одного регістру (1С-подібний патерн).
- [Х] ~~**Окремий builder для register tree vs параметризація існуючого?**~~ → Параметризація `buildTypeEditorTree` + виділення `MetadataObjectTreeSelector` як спільного блоку.
- [Х] ~~**Де живе registerMovements — центр чи права панель?**~~ → Тільки центральна секція "Рухи". З правої панелі прибирається.
- [ ] **Валідація posting-маппінгу в реальному часі?** Перевіряти, що source fields існують, що target dimensions/resources існують у регістрі. Рекомендація: так, аналогічно до field ref validation.
- [ ] **Чи потрібна кнопка "Preview Posting SQL" до Етапу 3?** Рекомендація: використовувати існуючий SQL Preview з Phase 2a.

---

## Рекомендовані патерни

### Dialog lifecycle
Усі діалоги Phase 2b мають повторювати патерн `open/onOpenChange + revisionKey + local draft + Save → close`, підтверджений у `StandardAttributesDialog` і `AdditionalIndexesDialog`.

### MetadataObjectTreeSelector
Спільний stateless блок для tree-based вибору metadata objects. Використовується і в рефакторнутому `DataTypeEditorDialog`, і в `RegisterPickerDialog`. Не є окремим діалогом — це **частина body** діалогу.

### Expression picker
Combobox з динамічним набором опцій, що перезбирається при зміні source. Список формується утилітою `buildExpressionOptions` зі стандартних + custom полів документа та його ТЧ.

## Антипатерни (уникати)

### ❌ Два місця редагування registerMovements
registerMovements не повинен редагуватися одночасно з центральної секції Movements і правої панелі ObjectProperties.

### ❌ Автоматичне очищення виразів при зміні source
При зміні source невалідні вирази підсвічуються як помилка, але не очищаються — щоб не втрачати роботу користувача.

### ❌ Пряме reuse DataTypeEditorDialog для register selection
Dialog має Attribute-специфічний draft і save contract. Reuse — через виділений `MetadataObjectTreeSelector`, а не через conditional props самого діалогу.

---

## Definition of Done

- [Х] `pnpm --filter @simetra/core test` — green (posting schemas)
- [ ] `pnpm --filter @simetra/generator-pg test` — green (posting SQL generation)
- [ ] `pnpm lint ; pnpm typecheck` — clean
- [ ] `buildTypeEditorTree` параметризований, `MetadataObjectTreeSelector` виділений
- [ ] `DataTypeEditorDialog` працює ідентично після рефакторингу
- [ ] Секція "Рухи" в ObjectEditor: таблиця регістрів + Додати/Видалити
- [ ] `RegisterPickerDialog`: tree-based multi-select вибір регістрів
- [ ] `MovementConstructorDialog`: per-register маппінг з expression combobox
- [ ] registerMovements прибрано з правої панелі
- [ ] Persisted save: маппінги зберігаються в posting секції JSON
- [ ] Документ з posting секцією → Generate → SQL включає post/unpost/check функції
- [ ] Backward compatible: документи без posting секції працюють як раніше
