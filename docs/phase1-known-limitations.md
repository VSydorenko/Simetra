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

**Status:** Частково закрито у Phase 1; актуальний limitation стосується UX,
а не відсутності самої project-level validation.

**Опис:** Debounced project-level validation уже працює через
`useModelValidation()` і наповнює `modelErrors` окремо від
mutation-time `validationErrors`. Поточна реалізація вже покриває
graph-level / cross-object перевірки для reachable refs і duplicate object
names у межах kind. Обмеження Phase 1 полягає в тому, що UX подачі цих
результатів лишається розподіленим: помилки видно в status bar та у
properties-панелях, але немає окремого validation workspace з навігацією по
всіх findings.

**Можливі подальші покращення UX:**
- окремий validation panel
- навігація до next/previous issue
- command palette action для переходу по findings

**Ref:** FR-005 лишається актуальним як validation UX follow-up, але не як
твердження про відсутність project-level / cross-object validation.

## Standard Attributes для Tabular Sections

**Status:** Закрито у Phase 1.

**Опис:** Обмеження, за яким standard attributes для табличних частин не мали
окремого selection/context path, більше не актуальне. Поточний UI має
`selectedTabularSection`, окремий `TabularSectionProperties` і записує
description overrides у `tabularSection.standardAttributeOverrides`.

**Вплив:** Немає активного limitation для цього сценарію у Phase 1.

## Constant valueType: Ref

**Status:** Закрито у Phase 1.

**Опис:** `constantValueTypeSchema` виключає `"Ref"` через `fieldTypeSchema.exclude(["Ref"])`.
UI-компонент `FieldTypeSelect` фільтрує заборонені типи через prop `excludeTypes={["Ref"]}` для Constant. Якщо Ref-константи потрібні у майбутньому, необхідно додати поле `ref` до `constantSchema` та прибрати excludeTypes.
