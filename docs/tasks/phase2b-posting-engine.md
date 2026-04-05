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

---

## Етапи

### Етап 1: Zod-схеми posting у `@simetra/core`

- [ ] Створити `packages/core/src/schemas/posting.ts`:
  - `mappingExpressionSchema` — string validation для `doc.`, `row.`, `sum()`, `count()`, `literal:`, `now()`, арифметика
  - `movementMappingSetSchema` — `{ dimensions: Record<string, expr>, resources: Record<string, expr>, attributes: Record<string, expr> }`
  - `postingMovementSchema` — `{ register: MetadataRef, movementType, source, condition?, mappings }`
  - `postingValidationSchema` — `{ type: "NonNegativeBalance", register, dimensions, resource, message, applyTo? }`
  - `postingSchema` — `{ movements: postingMovementSchema[], validations: postingValidationSchema[] }`
- [ ] Розширити `documentSchema` — додати опціональне поле `posting: postingSchema.optional()`
- [ ] Оновити серіалізацію (`serialization.ts`) — додати `posting` у key order для Document
- [ ] **Тести:**
  - Валідний posting з movements + validations → pass
  - Невалідні mapping expressions → fail
  - Document без posting → pass (backward compatible)
  - Document з порожнім posting → pass
  - `pnpm --filter @simetra/core test` — green

### Етап 2: Генерація posting SQL у `@simetra/generator-pg`

- [ ] `post_{document_name}(doc_id uuid)`:
  - Перевірка `IF posted THEN RAISE EXCEPTION`
  - Очистка попередніх рухів: `DELETE FROM {register} WHERE recorder_id = doc_id` (для кожного register з movements)
  - Для кожного `movements[]` елемента:
    - Якщо `source = "tabularSection:{name}"` → `INSERT INTO {register} SELECT ... FROM {document}_{tabularSection} WHERE parent_id = doc_id`
    - Якщо `source = "document"` → `INSERT INTO {register} VALUES (...)`
    - Mapping expressions → SQL expressions (`doc.warehouse` → `d.warehouse_id`, `row.quantity` → `ts.quantity`, `row.a * row.b` → `ts.a * ts.b`, `sum(items.amount)` → `(SELECT sum(amount) FROM ...)`)
  - Виконання валідацій
  - `UPDATE {document} SET posted = true, updated_at = now() WHERE id = doc_id`
  - Обгорнуто в `BEGIN ... END` (єдина транзакція)
- [ ] `unpost_{document_name}(doc_id uuid)`:
  - `DELETE FROM {register} WHERE recorder_id = doc_id` — для кожного регістру з `movements[]`
  - `UPDATE {document} SET posted = false, updated_at = now() WHERE id = doc_id`
- [ ] `check_{register}_{resource}(dimensions...)`:
  - Перевіряє, що залишок не стане від'ємним
  - Підставляє displayName у повідомлення помилки
- [ ] Точка розширення: виклик `{document_name}_post_custom(doc_id)` (якщо функція існує)
- [ ] **Тести:**
  - Golden fixture: GoodsReceipt → InventoryBalance (tabularSection source)
  - Golden fixture: PaymentOrder → SettlementsBalance (document source)
  - Динамічний movementType (`doc.operation_type`)
  - NonNegativeBalance validation → correct check function
  - Арифметика в mappings: `row.quantity * row.price`
  - Агрегація: `sum(items.amount)`
  - `pnpm --filter @simetra/generator-pg test` — green

### Етап 3: Візуальний editor маппінгів у `apps/web`

- [ ] Замінити placeholder "comingSoon" у секції "Рухи" (`object-editor.tsx`) реальним контентом
- [ ] UI секції "Рухи" для Document:
  - Список movements (кожен — окремий рядок/картка):
    - Dropdown для вибору цільового регістру (з `registerMovements` document settings)
    - Radio для типу руху (Receipt/Expense/Dynamic)
    - Dropdown для source (document / tabularSection:{name})
    - Textarea для condition (опціонально)
  - Для кожного movement — панель маппінгів:
    - Ліва колонка: поля документа/ТЧ (джерело)
    - Права колонка: виміри + ресурси + реквізити обраного регістру (ціль)
    - Dropdown-based маппінг (MVP); drag-drop лінії зв'язку як enhancement
    - Input для expression (якщо потрібна арифметика/агрегація)
  - Секція валідацій внизу:
    - Кнопка "Додати валідацію"
    - Вибір регістру, вимірів, ресурсу
    - Текст повідомлення (LocalizedString)
- [ ] Зберігання змін маппінгу в store → секція `posting` JSON-файлу документа
- [ ] Sync: зміни в `registerMovements` (ObjectProperties) → оновлення списку доступних регістрів у movements editor
- [ ] **Тести:**
  - Component test: movements editor рендерить movement items
  - Adding/removing movement → store update → JSON persistence
  - Mapping change → correct posting structure in metadata

---

## Clarify (питання перед імплементацією)

- [ ] **Drag-and-drop vs dropdown для маппінгів?** Drag-drop ефектніший візуально, але dropdown простіший для MVP. Рекомендація: dropdown + expression input для MVP, drag-drop як enhancement.
- [ ] **Валідація posting-маппінгу в реальному часі?** Перевіряти, що source fields існують, що target dimensions/resources існують у регістрі. Рекомендація: так, аналогічно до field ref validation.
- [ ] **Чи потрібна кнопка "Preview Posting SQL" до Phase 2a SQL Preview?** Рекомендація: використовувати існуючий SQL Preview з Phase 2a.

---

## Definition of Done

- [ ] `pnpm --filter @simetra/core test` — green (posting schemas)
- [ ] `pnpm --filter @simetra/generator-pg test` — green (posting SQL generation)
- [ ] `pnpm lint ; pnpm typecheck` — clean
- [ ] Movements editor UI функціональний: створення/редагування/видалення movements + validations
- [ ] Документ з posting секцією → Generate → SQL включає post/unpost/check функції
- [ ] Backward compatible: документи без posting секції працюють як раніше
