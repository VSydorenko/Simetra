# Task: Phase 1 Closure Backlog

> **Мета:** Зібрати всі невиконані пункти Phase 1 в одному місці, щоб закрити фазу перед переходом до Phase 2. Після виконання цієї задачі та задачі `architecture-documentation.md` — всі архівні задачі з `docs/tasks/` мають бути видалені.

## Контекст

Phase 1 "Web UI Prototype" виконана на ~85%. Основний конфігуратор працює: 7 типів метаданих, 3-панельний layout, дерево з 4+ рівнями, Tab Bar + Floating Windows, Properties Panel, Session Persistence, Data Type Editor Dialog, Standard Attributes Dialog, Additional Indexes Dialog, Undo/Redo, Command Palette, i18n (uk/en).

Проте залишаються невиконані пункти з BRD та task-файлів, які блокують стабільний перехід до Phase 2 (генерація DDL). Ця задача консолідує їх.

### Джерела невиконаних пунктів

| Джерело | Що залишилось |
|---------|---------------|
| `phase1-foundation.md` Модуль 9 | Where Used UI, project-level validation UX, деякі тести |
| `phase1-module5-state-and-tests.md` | Object-scoped view state, тести window manager, тести shell |
| `session-persistence.md` | Контракт `clearSession`, import flow, тести persistence |
| `editor-layer-redesign.md` Модуль F/G | StdAttr діалог для TabularSection, auto-focus ref після Ref вибору |
| `data-type-editor.md` Фаза 5 | Компонентні тести діалогу (keyboard nav, group toggle) |
| `reference-type-redesign.md` Фаза 3 | Тести cascade rename, delete confirmation під нову модель |
| BRD §7.6 | `$schema` контракт не закритий |

---

## Вимоги

### Блок A: `$schema` контракт (BRD §7.6) — КРИТИЧНИЙ

> Цей блок блокує Phase 2: генератор, preview, import/export і міграції успадкують нестабільний файловий контракт, якщо `$schema` не стабілізовано зараз.

- [ ] Визначити **канонічну URL-конвенцію** для `$schema`:
  - Формат: `https://simetra.dev/schemas/v{schemaVersion}/{kind-kebab}.schema.json`
  - Приклади: `https://simetra.dev/schemas/v1/catalog.schema.json`, `https://simetra.dev/schemas/v1/project.schema.json`
- [ ] Зробити `$schema` **обов'язковим** у всіх Zod-схемах метаданих (`packages/core/src/schemas/`)
  - Додати поле `$schema: z.string().url()` до кожної object-level схеми (catalog, document, enumeration, information-register, accumulation-register, constant, custom-table, project)
  - Поле має бути першим у порядку серіалізації (canonical serializer)
- [ ] Оновити canonical serializer (`packages/core/src/serialization.ts`):
  - `$schema` має бути **першим ключем** у кожному серіалізованому файлі
  - Додати `$schema` до `KEY_ORDER` для кожного типу
- [ ] Автоматичне заповнення `$schema` при серіалізації:
  - Якщо об'єкт не має `$schema` — серіалізатор має автоматично додати правильний URL на основі `kind` та `schemaVersion` проєкту
  - Якщо має — зберегти as-is
- [ ] Оновити golden fixtures (`packages/core/src/__tests__/fixtures/*.json`) — додати `$schema` з правильними URL
- [ ] Оновити `temp/metadata/` sample файли — додати `$schema`
- [ ] Оновити тести roundtrip серіалізації
- [ ] `pnpm --filter @simetra/core test` — green

### Блок B: Where Used UI (FR-052, BRD §8.6)

> Доменна логіка `findReferences` вже реалізована в `apps/web/src/lib/find-references.ts`. Поточний UI закінчується на `console.info` — потрібен діалог.

- [ ] Створити компонент `WhereUsedDialog` (`apps/web/src/components/editor/where-used-dialog.tsx`):
  - Заголовок: "Де використовується: {ObjectName}"
  - Таблиця результатів: Об'єкт (іконка + ім'я), Поле, Тип посилання (ref / allowedTypes / owners / recorderTypes / registerMovements)
  - Клік на рядок → перехід до об'єкта (відкриття вкладки)
  - Empty state: "Посилань не знайдено"
- [ ] Інтегрувати з контекстним меню дерева:
  - Замінити `console.info` на відкриття `WhereUsedDialog`
- [ ] Інтегрувати з діалогом підтвердження видалення:
  - Якщо є вхідні посилання — показати їх список у діалозі видалення
  - Текст: "Об'єкт використовується в N місцях. Видалити?"
- [ ] i18n ключі для діалогу

### Блок C: Object-scoped view state (з phase1-module5-state-and-tests.md)

> `selectedRow` в `attribute-table.tsx` ще використовує локальний `useState`, що ламає стан при detach/attach floating windows.

- [ ] Створити механізм object-scoped view state у UI store:
  - `viewState: Record<string, ObjectViewState>` де ключ = `{kind}:{name}`
  - `ObjectViewState { activeEditorTab?: string, selectedField?: string | number }`
- [ ] Store actions: `getViewState(objectId)`, `setViewState(objectId, partial)`
- [ ] Cleanup: при закритті останньої вкладки/вікна для об'єкта — видалити entry
- [ ] Замінити локальний `useState` для `selectedRow` в `attribute-table.tsx` на read/write з UI store view state
- [ ] View state НЕ persist-ити між сесіями (runtime-only)

### Блок D: Session Persistence — контрактні gap-и (з session-persistence.md)

- [ ] `clearSession()` в `session-db.ts` — має очищати і session, і drafts (зараз тільки session)
- [ ] `importProject()` в `project-store.ts` — зберігати model як draft (без handle) замість session з null handle
- [ ] Перевірити edge case: reload після import з ZIP → має показати Welcome Screen з можливістю відновлення draft, а не порожній проєкт
- [ ] `newProject()` — перевірити виклик `clearSession()` + `clearDraft()`

### Блок E: Компонентні тести — web layer

> Тестове покриття web-layer слабке. AppShell тести smoke-only, cmdk mock блокує palette coverage, session persistence не покрита.

#### E1: Window Manager (store invariants) — доповнити `ui-store.test.ts`
- [ ] Після `attachWindow`: `activeWindowId` !== attached window id
- [ ] Після `closeWindow` останнього вікна: `activeWindowId === null`
- [ ] Після `minimizeWindow` активного: `activeWindowId` переключається або `null`
- [ ] Після `detachTab`: `activeWindowId` === нового floating window id
- [ ] Інваріант: `activeWindowId` завжди `null` або id існуючого non-minimized вікна

#### E2: Floating Window component tests — створити `floating-window.test.tsx`
- [ ] Floating window рендерить ObjectEditor з правильним objectId
- [ ] Title bar показує іконку типу та ім'я об'єкта
- [ ] Кнопки minimize/maximize/close викликають store actions
- [ ] Мінімізовані вікна не рендеряться у FloatingWindowContainer

#### E3: Shell hotkeys — доповнити `app-shell.test.tsx`
- [ ] Ctrl+S → save action
- [ ] Ctrl+Z / Ctrl+Shift+Z → undo/redo
- [ ] Ctrl+N → new object dialog
- [ ] Ctrl+W → close active tab
- [ ] Ctrl+Tab / Ctrl+Shift+Tab → switch tabs
- [ ] Ctrl+K → command palette opens

#### E4: Command Palette interaction
- [ ] Замінити mock cmdk на lightweight mock з input + filterable list
- [ ] Palette фільтрує об'єкти по назві
- [ ] Palette створює об'єкт при виборі "New {Kind}"
- [ ] Palette переходить до існуючого об'єкта

#### E5: Session persistence tests
- [ ] `session-db.ts` — saveSession/loadSession/clearSession roundtrip
- [ ] `use-session-restore.ts` — mock IndexedDB + FS handle permission scenarios
- [ ] `beforeunload` — handler підключається при isDirty
- [ ] Welcome Screen — "Відновити" кнопка видима коли є збережена сесія

#### E6: Data Type Editor Dialog tests (з data-type-editor.md Фаза 5)
- [ ] Single mode: вибір примітивного типу → draft оновлюється
- [ ] Single mode: вибір reference target → draft = `{ type: "Ref", ref: MetadataRef }`
- [ ] Compound mode: мультиселект references → `{ type: "Ref", allowedTypes: MetadataRef[] }`
- [ ] Compound mode: примітивні типи disabled
- [ ] Kind-group checked / indeterminate state
- [ ] Зміна типу очищує непотрібні параметри
- [ ] Переключення compound → single зберігає перший target
- [ ] Keyboard navigation / activate flow
- [ ] Search + group toggle

#### E7: Reference model tests (з reference-type-redesign.md Фаза 3)
- [ ] Cascade rename single ref і polymorphic ref — ref оновлюється
- [ ] Delete confirmation dialog показує правильні залежності під нову модель
- [ ] Manual smoke: створити об'єкт → Ref поле → обрати target → перейменувати target → ref оновлюється

### Блок F: Дрібні UX gap-и

- [ ] Стандартні реквізити табличних частин (id, line_number) — показувати в StandardAttributesDialog при виборі табличної частини в дереві
  - Джерело: editor-layer-redesign.md Модуль G
- [ ] При виборі reference type у FieldTypeSelect — auto-focus на секцію "Тип даних" у правій панелі
  - Джерело: editor-layer-redesign.md Модуль F (останній невиконаний пункт)

---

## Clarify (питання перед імплементацією)

- [ ] Чи потрібні JSON Schema файли як реальні артефакти на Phase 1, чи достатньо `$schema` URL як convention?
  - Чому: BRD §7.6 вимагає `$schema`, але реальні .schema.json файли — це build artifact з `zod-to-json-schema`. Якщо URL поки не резолвиться — це нормально для Phase 1?
  - Варіанти: (A) Додати URL без реальних файлів — convention only. (B) Додати build step `zod-to-json-schema` і генерувати реальні файли
  - Вплив: складність build pipeline
  - Рекомендація: (A) для Phase 1 closure, (B) як окрема задача Phase 2

- [ ] Глибина view state — тільки `activeEditorTab` + `selectedField`, чи більше?
  - Чому: scroll position, expanded accordion sections можуть бути корисні при detach/attach
  - Варіанти: (A) мінімум — тільки tab + field, (B) включити scroll position
  - Рекомендація: (A) — мінімум для MVP

- [ ] Стратегія мокання react-rnd у floating window тестах
  - Чому: react-rnd потребує browser layout engine
  - Варіанти: (A) повний mock модуля, (B) partial mock — тестувати тільки callbacks
  - Рекомендація: (A) — повний mock з div

- [ ] Стратегія мокання cmdk для palette тестів
  - Чому: поточний mock повертає null
  - Варіанти: (A) lightweight mock з input + filtered list, (B) тестувати store actions напряму
  - Рекомендація: (A) — для повного coverage

---

## Рекомендовані патерни

### `$schema` injection через canonical serializer
Серіалізатор автоматично додає `$schema` як перший ключ, якщо його немає. URL формується з `kind` + `schemaVersion` проєкту. Це гарантує що всі збережені файли отримають `$schema` без ручного втручання.

### Object-scoped view state як Record в UI store
`Record<string, ObjectViewState>` у ui-store. Ключ = `Kind:Name`. Actions: `getViewState(id)`, `setViewState(id, partial)`. Cleanup при закритті останнього tab/window. Не persist-ити між сесіями.

### WhereUsedDialog як reusable component
Діалог приймає `references: ReferenceInfo[]` і `objectName: string`. Логіка пошуку — в `find-references.ts` (вже є). Caller (дерево або delete confirmation) формує список і передає.

### Store invariant tests як окрема test suite
Кожен тест виконує послідовність actions і перевіряє інваріант. Preload store через `useUiStore.setState(...)`.

### Firevent для keyboard shortcuts
`fireEvent.keyDown(document, { key: 's', ctrlKey: true })` для тестування hotkeys. react-hotkeys-hook слухає на document.

---

## Антипатерни (уникати)

### ❌ `$schema` як runtime validation guard
`$schema` — це metadata для IDE та CI. Не блокувати завантаження проєкту якщо URL не резолвиться. Валідувати тільки формат (string URL).

### ❌ View state у metadata store
View state — це UI state. Не має потрапляти в undo-стек zundo.

### ❌ WhereUsedDialog з прямим доступом до store
Діалог приймає готові дані. Логіка пошуку — caller responsibility.

### ❌ Тести через snapshot
Компонентні тести — через assertions на конкретні елементи. Snapshot тести — fragile і не дають розуміння що зламалось.

### ❌ JSON.stringify для dirty comparison (view state)
View state порівнювати по reference або shallow equality. Не серіалізувати.

---

## Порядок виконання

```
A ($schema контракт)
  ↓
B (Where Used UI)  ‖  C (View state)  ‖  D (Session gaps)
  ↓                    ↓                   ↓
E (Тести — всі блоки E1-E7)
  ↓
F (Дрібні UX gap-и)
```

Блоки B, C, D можуть виконуватися паралельно. Блок E залежить від B, C, D (тестує їх). Блок F — останній.

---

## Пов'язана документація

- `docs/BRD-metadata-configurator.md` — бізнес-вимоги (§7.6 — $schema, §8.6 — referential integrity, §9.5-9.8 — UI)
- `.github/instructions/metadata-model.instructions.md` — правила Zod-схем
- `.github/instructions/ui-architecture.instructions.md` — правила побудови UI
- `packages/core/src/schemas/` — Zod-схеми метаданих
- `packages/core/src/serialization.ts` — canonical serializer
- `apps/web/src/lib/find-references.ts` — Where Used логіка
- `apps/web/src/stores/ui-store.ts` — UI store
- `apps/web/src/storage/session-db.ts` — IndexedDB persistence
- `apps/web/src/components/editor/data-type-editor-dialog.tsx` — Data Type Editor

---

## Definition of Done

### Контракти
- [ ] Всі `.meta.json` файли мають `$schema` як перший ключ
- [ ] Canonical serializer автоматично додає `$schema`
- [ ] `$schema` URL відповідає конвенції `https://simetra.dev/schemas/v1/{kind}.schema.json`

### UI
- [ ] "Де використовується" відкриває діалог з таблицею посилань (а не console.info)
- [ ] Delete confirmation показує вхідні посилання
- [ ] View state зберігається при detach/attach floating windows
- [ ] Session persistence: clearSession очищує drafts, importProject працює коректно

### Тести
- [ ] Window manager invariant tests (5+ тестів)
- [ ] Floating window component tests (4+ тестів)
- [ ] Shell hotkey tests (7+ тестів)
- [ ] Command palette interaction tests (3+ тестів)
- [ ] Session persistence tests (4+ тестів)
- [ ] Data Type Editor dialog tests (10+ тестів)
- [ ] Reference model tests (3+ тестів)

### Quality gate
- [ ] `pnpm lint` — без помилок
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm test` — все зелене
- [ ] Жодної `console.info` / `console.log` замість реального UI
