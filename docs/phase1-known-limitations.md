# Phase 1 Known Limitations

## View State при Detach/Attach Floating Windows (Block C)

**Status:** Known limitation — не виправляється у Phase 1.

**Опис:** `selectedRow` у `attribute-table.tsx` та `enum-values-editor.tsx` використовує локальний `useState`, що скидається при detach/attach floating windows. `selectedField` у `ui-store.ts` є глобальним (не per-tab). `activeSection` вже per-tab/per-window (в TabItem) — це правильний патерн.

**Вплив:** UX degradation — скидання виділення рядка при переміщенні вікон. Функціональність не ламається.

**Рішення для Phase 2 (якщо потрібно):**
- Додати `selectedRow?: string` до `TabItem` та `FloatingWindow` (аналогічно `activeSection`)
- Замінити локальний `useState` для `selectedRow` на read/write з TabItem
- View state НЕ persist-ити між сесіями (runtime-only)

## Project-Level Validation UX (Block G, FR-005)

**Status:** Тільки scoping — реалізація в Phase 2.

**Опис:** Validation на рівні об'єкта (Zod per mutation) працює. Project-level — це cross-object checks, що не реалізовані.

**Cross-object checks для Phase 2:**
- Broken refs (посилання на неіснуючий об'єкт)
- Duplicate names across kinds
- Empty required collections (порожній проєкт — це valid?)

**Варіанти UI для відображення результатів:**
- Status bar badge
- Validation panel
- Command palette action

**Ref:** BRD FR-005 — «Partial — object-level done, project-level validation UX incomplete»

## Constant valueType: Ref

**Status:** Виключено у Phase 1 (constantValueTypeSchema без "Ref").

**Опис:** Якщо Ref-константи потрібні у майбутньому, необхідно додати поле `ref` (аналогічно до `Attribute`) до `constantSchema`. До цього — "Ref" виключено зі списку допустимих типів.
