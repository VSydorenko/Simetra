# Task: Phase 1 Closure Backlog

> **Мета:** Зібрати всі невиконані пункти Phase 1 в одному місці, щоб закрити фазу перед переходом до Phase 2. Після виконання цієї задачі та задачі `architecture-documentation.md` — всі архівні задачі з `docs/tasks/` мають бути видалені.

## Контекст

Phase 1 "Web UI Prototype" виконана на ~85%. Основний конфігуратор працює: 7 типів метаданих, 3-панельний layout, дерево з 4+ рівнями, Tab Bar + Floating Windows, Properties Panel, Session Persistence, Data Type Editor Dialog, Standard Attributes Dialog, Additional Indexes Dialog, Undo/Redo, Command Palette, i18n (uk/en).

Проте залишаються невиконані пункти з BRD та task-файлів, які блокують стабільний перехід до Phase 2 (генерація DDL). Ця задача консолідує їх.

### Статус попередніх задач після дослідження

| Джерело | Що залишилось | Примітка |
|---------|---------------|----------|
| `phase1-foundation.md` Модуль 9 | Where Used UI, project-level validation UX | Project-level validation — тільки scoping (Блок G) |
| `phase1-module5-state-and-tests.md` | Тести window manager, тести shell | View state → known limitation (Блок C) |
| `session-persistence.md` | ZIP import flow | `clearSession` gap — ✅ CLOSED (newProject вже викликає обидва) |
| `editor-layer-redesign.md` Модуль G | StdAttr діалог для TabularSection | Компонент готовий, проблема лише у wiring |
| `editor-layer-redesign.md` Модуль F | ~~Auto-focus ref після Ref вибору~~ | ❌ STALE — DataTypeEditorDialog замінив FieldTypeSelect flow |
| `data-type-editor.md` Фаза 5 | Компонентні тести діалогу | Без змін |
| `reference-type-redesign.md` Фаза 3 | Тести cascade rename | Без змін |
| BRD §7.6 | `$schema` контракт + constants format | Об'єднано з новим findings |
| BRD §5.7 + §6 | Constant `valueType: "Ref"` без target | Нова знахідка |

### Закриті пункти (підтверджено дослідженням)

Наступні пункти з попередніх задач **вже реалізовані** і не потребують роботи:

- ✅ **Delete confirmation з references** — `DeleteConfirmDialog` у `tree-panel.tsx` вже показує список посилань через `findReferences`
- ✅ **`newProject()` → `clearSession()` + `clearDraft()`** — `project-store.ts` вже викликає обидва
- ✅ **`activeEditorTab` terminology** — store мігровано (migration v3), `activeSection` per-tab/per-window
- ✅ **Auto-focus ref при виборі FieldTypeSelect** — STALE, тепер DataTypeEditorDialog

---

## Вимоги

### Блок A: `$schema` контракт та файловий формат (BRD §7.6) — КРИТИЧНИЙ

> Блокує Phase 2: DDL генератор, preview, import/export і міграції успадкують нестабільний файловий контракт, якщо `$schema` не стабілізовано зараз.

**Контекст з дослідження:**
- `serialization.ts`: `$schema` стоїть першим у всіх KEY_ORDER масивах, але `orderKeys()` лише **копіює** ключі, що вже існують на вхідному об'єкті — injection НЕ відбувається
- `serializeMetadataObject(obj)` приймає **один аргумент** — не має доступу до `schemaVersion` проєкту
- Zod-схеми мають `$schema: z.string().optional()` — runtime-об'єкти не створюються з цим полем
- Golden fixtures мають `$schema` у **старому форматі**: `/v1/catalog.json` (без `.schema.json` suffix)
- `serializeToFiles(model: ProjectModel)` у web-storage.ts має доступ до `model.project.schemaVersion`

#### A1: Core — enrichment helper
- [ ] Створити pure-функцію `enrichSchemaUrl(obj: MetadataObject, schemaVersion: string): MetadataObject` в `packages/core/src/serialization.ts`
  - Формує URL: `https://simetra.dev/schemas/v${schemaVersion}/${kind-kebab}.schema.json`
  - Додає `$schema` як поле об'єкту
  - **Завжди перезаписувати** `$schema` URL (не keep-as-is) — запобігає stale URL якщо schemaVersion змінився
  - Аналогічна функція для Project: `enrichProjectSchemaUrl(project, schemaVersion)`
- [ ] НЕ змінювати `$schema` у Zod-схемах — залишити `z.string().optional()` (injection — на рівні серіалізації, не валідації)
- [ ] Експортувати helper з `@simetra/core`

#### A2: Web — виклик injection у pipeline
- [ ] У `serializeToFiles()` (`apps/web/src/storage/web-storage.ts`) — викликати `enrichSchemaUrl` перед `serializeMetadataObject` для кожного об'єкта
- [ ] Для project.meta.json — викликати `enrichProjectSchemaUrl` перед `serializeProject`

#### A3: Constants format — object wrapper
- [ ] Змінити формат `constants/constants.meta.json` з **top-level array** на **object wrapper**:
  - Поточний: `[ { kind: "Constant", ... }, ... ]`
  - Новий: `{ "$schema": "..../constants.schema.json", "constants": [ ... ] }`
- [ ] Визначити Zod-схему для wrapper у core: `constantsFileSchema = z.object({ $schema: z.string().optional(), constants: z.array(constantSchema) })`
  - Потрібна для Phase 2 DDL generator якщо він парситиме файли напряму
- [ ] Оновити `serializeToFiles()` — серіалізувати обгорнуту структуру
- [ ] Оновити `parseFileStructure()` — парсити обидва формати (backward compat на перехідний період)

#### A4: Fixtures та sample data
- [ ] Оновити golden fixtures (`packages/core/src/__tests__/fixtures/*.json`) — URL suffix `.schema.json`
- [ ] Оновити `temp/metadata/` sample файли — додати `$schema` з правильними URL
- [ ] Оновити тести roundtrip серіалізації (перевірити що `$schema` зʼявляється після enrichment)
- [ ] `pnpm --filter @simetra/core test` — green

### Блок B: Reference enrichment + findReferences migration + Where Used UI (FR-052, BRD §8.6)

> Доменна логіка `findReferences` реалізована в `apps/web/src/lib/find-references.ts`. Поточний `Reference = { from: MetadataRef, via: string }` — `via` є free-form string (`"owners"`, `"attribute \"price\" ref"`), що непридатний для UI рендерингу. `getObjectAttributes()` збирає атрибути з tabularSections але **втрачає контекст** якій ТЧ належить атрибут. Поточний UI закінчується на `console.info`.

#### B1: Збагатити Reference type (prerequisite для всього блоку)
- [ ] Замінити `Reference` interface на structured type:
  - `referenceKind: "owners" | "recorderTypes" | "registerMovements" | "attributeRef" | "attributeAllowedTypes"`
  - `fieldName?: string` — ім'я атрибута (для attributeRef / attributeAllowedTypes)
  - `tabularSectionName?: string` — якщо атрибут у табличній частині
  - Видалити `via: string`
- [ ] Переписати `getObjectAttributes()` на ітерацію із збереженням ТЧ-контексту
- [ ] Створити helper `formatReference(ref: Reference): string` для UI відображення (замість raw `via`)
- [ ] Оновити `DeleteConfirmDialog` у `tree-panel.tsx` — використовувати `formatReference()` замість `ref.via`

#### B2: Перенести findReferences у @simetra/core
- [ ] Перемістити `find-references.ts` з `apps/web/src/lib/` в `packages/core/src/`
  - Функція вже pure TS, працює з `ProjectModel`, не використовує React/browser API
  - Це підготовка до Phase 2 де DDL generator потребуватиме dependency ordering
- [ ] Перенести `KIND_TO_KEY` mapping з `apps/web/src/lib/metadata-defaults.ts` у `@simetra/core`
  - `findReferences` імпортує `KIND_TO_KEY` — при міграції потрібен еквівалент у core
  - Оцінити: чи вже є аналогічний mapping у core, чи створити новий
- [ ] Реекспортувати з `packages/core/src/index.ts`
- [ ] Оновити імпорти в `apps/web/` — замінити `../lib/find-references` на `@simetra/core`
- [ ] Додати unit-тести в `packages/core/src/__tests__/`

#### B3: Where Used Dialog
- [ ] Створити компонент `WhereUsedDialog` (`apps/web/src/components/editor/where-used-dialog.tsx`):
  - Заголовок: "Де використовується: {ObjectName}"
  - Таблиця результатів: Об'єкт (іконка + ім'я), Поле (fieldName + tabularSectionName), Тип посилання (referenceKind)
  - Клік на рядок → перехід до об'єкта (відкриття вкладки)
  - Empty state: "Посилань не знайдено"
- [ ] Інтегрувати з контекстним меню дерева:
  - Замінити `console.info` в `tree-nodes.tsx` `handleWhereUsed` на відкриття `WhereUsedDialog`
- [ ] i18n ключі для діалогу

### Блок C: View state при detach/attach (LOW PRIORITY — known limitation)

> `selectedRow` в `attribute-table.tsx` та `enum-values-editor.tsx` використовує локальний `useState`, що скидається при detach/attach floating windows. `selectedField` в `ui-store.ts` є **глобальним** (не per-tab). `activeSection` вже per-tab/per-window (в TabItem) — це правильний патерн.

**Рішення з дослідження:** Пріоритет LOW. Функціональність не ламається — тільки UX degradation (скидання виділення рядка). Два варіанти:

#### Варіант A (мінімальний — рекомендовано для Phase 1):
- [ ] Задокументувати як known limitation у BRD/release notes
- [ ] Не витрачати час на рефакторинг view state

#### Варіант B (повний — якщо є час):
- [ ] Додати `selectedRow?: string` до `TabItem` та `FloatingWindow` (аналогічно `activeSection`)
- [ ] Замінити локальний `useState` для `selectedRow` в `attribute-table.tsx` на read/write з TabItem
- [ ] Аналогічно для `enum-values-editor.tsx`
- [ ] View state НЕ persist-ити між сесіями (runtime-only)

### Блок D: ZIP Import — silent auto-restore (з session-persistence.md)

> **Контекст з дослідження:** `importProject()` зберігає session з `handle: null`. При reload `restoreSession()` знаходить session без handle → завантажує model → `status: "restored"`. `editor-panel.tsx`: `showWelcome` excludes `"restored"` → показує порожній "noOpenTabs" placeholder замість Welcome Screen. Користувач бачить порожній екран з даними проєкту у sidebar.

> **Закрито дослідженням:** `clearSession()` + `clearDraft()` — `newProject()` вже викликає обидва. Це НЕ gap.

- [ ] При `importProject()` — зберігати model як **draft** замість session з null handle
  - Або додати `origin: "zip-import"` до session metadata
- [ ] При restore: якщо `origin === "zip-import"` або null handle — показувати Welcome Screen з action "Відновити імпортований проєкт" замість silent auto-load
- [ ] Перевірити edge case: reload після import з ZIP → має показати Welcome Screen з можливістю відновлення, а не порожній проєкт
- [ ] ~~`clearSession()` → очищати і session, і drafts~~ — ✅ CLOSED: `newProject()` вже викликає обидва; окремість API — by design

### Блок X: Constant `valueType: "Ref"` — schema gap (BRD §5.7 + §6)

> **Нова знахідка з дослідження:** `constantSchema` дозволяє `valueType: fieldTypeSchema` який включає `"Ref"`, але НЕ має полів `ref` або `allowedTypes`. UI показує "Ref" в списку типів для константи через `DataTypeEditorDialog`, але вибір target неможливий. Фактично — broken state у schema.

- [ ] Створити `constantValueTypeSchema` = `fieldTypeSchema.exclude(["Ref"])` в `packages/core/src/schemas/constant.ts`
- [ ] Замінити `valueType: fieldTypeSchema` на `valueType: constantValueTypeSchema`
- [ ] Оновити тести — перевірити що `valueType: "Ref"` reject-ується для Constant
- [ ] Якщо Ref-константи потрібні у майбутньому  — задокументувати як Phase 2 item з додаванням `ref` поля
- [ ] `pnpm --filter @simetra/core test` — green

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

- [ ] Стандартні реквізити табличних частин (id, line_number) — показувати в StandardAttributesDialog при виборі табличної частини
  - Джерело: editor-layer-redesign.md Модуль G
  - **Контекст:** `standard-attributes-dialog.tsx` вже підтримує `tabularSectionName?: string` prop та переключається на `getTabularSectionStandardAttributes()`. Проблема лише у wiring — ніхто не передає цей prop.
  - Рішення: передати `tabularSectionName` з контексту вибраного вузла дерева або з `selectedField?.tabularSectionName`. Мінімальний scope — кнопка в контекстному меню вузла `tabularSection` або в header AttributeTable.
- [ ] ~~При виборі reference type у FieldTypeSelect — auto-focus на секцію "Тип даних"~~ — ❌ STALE: DataTypeEditorDialog повністю замінив FieldTypeSelect flow

### Блок G: Project-level validation UX (FR-005) — ТІЛЬКИ SCOPING

> BRD FR-005: *«⚠️ Partial — object-level done, project-level validation UX incomplete»*. Validation на рівні об'єкта (Zod per mutation) працює. Project-level — це cross-object checks.

**НЕ реалізовувати у Phase 1 closure. Тільки задокументувати scope:**

- [ ] Визначити які cross-object checks потрібні:
  - Broken refs (посилання на неіснуючий об'єкт)
  - Duplicate names across kinds
  - Empty required collections (порожній проєкт — це valid?)
- [ ] Визначити де показувати результати:
  - Варіанти: status bar badge? validation panel? command palette action?
- [ ] Оформити як окрему задачу для Phase 2

---

## Clarify (питання перед імплементацією)

- [ ] Чи потрібні JSON Schema файли як реальні артефакти на Phase 1, чи достатньо `$schema` URL як convention?
  - Чому: BRD §7.6 вимагає `$schema`, але реальні .schema.json файли — це build artifact з `zod-to-json-schema`. Якщо URL поки не резолвиться — це нормально для Phase 1?
  - Варіанти: (A) Додати URL без реальних файлів — convention only. (B) Додати build step `zod-to-json-schema` і генерувати реальні файли
  - Вплив: складність build pipeline
  - Рекомендація: **(A) для Phase 1 closure**, (B) як окрема задача Phase 2

- [ ] Backward compat для constants format: скільки довго підтримувати старий array-формат?
  - Чому: перехід з top-level array на object wrapper `{ $schema, constants: [...] }` — breaking change для існуючих проєктів
  - Варіанти: (A) Парсити обидва формати назавжди. (B) Парсити обидва 1 minor-версію, потім тільки новий. (C) Одразу тільки новий
  - Вплив: складність parseFileStructure, тести
  - Рекомендація: **(B) — backward compat на 1 minor-версію**, потім тільки object wrapper

- [ ] View state при detach — fix чи known limitation?
  - Чому: `selectedRow` скидається при detach/attach floating windows. Функціональність не ламається — тільки UX degradation
  - Варіанти: (A) Known limitation — задокументувати. (B) Per-tab selectedRow в TabItem
  - Вплив: UX polish vs engineering time
  - Рекомендація: **(A) known limitation** для Phase 1 closure

- [ ] Constant Ref — видалити чи розширити?
  - Чому: `constantSchema` дозволяє `valueType: "Ref"` але не має полів `ref`/`allowedTypes`. UI показує broken option
  - Варіанти: (A) Виключити Ref з constantValueType — простий fix. (B) Додати ref/allowedTypes — повна підтримка
  - Вплив: (A) закриває дефект, (B) додає нову функціональність
  - Рекомендація: **(A) виключити Ref** для Phase 1. Якщо потрібні Ref-константи — Phase 2

- [Х] ~~clearSession() — має чистити drafts?~~ → **RESOLVED**: `newProject()` вже викликає обидва. Окремість API — by design
- [Х] ~~activeEditorTab стан~~ → **RESOLVED**: store мігровано в v3, `activeSection` per-tab/per-window
- [Х] ~~Delete confirmation з references~~ → **RESOLVED**: вже реалізовано в `tree-panel.tsx`

### Відповіді з дослідження (для контексту)

| Питання | Відповідь | Джерело |
|---------|-----------|---------|
| Де inject `$schema`? | Core helper `enrichSchemaUrl()` + виклик у `serializeToFiles()` web-storage | `serialization.ts` L1-120, `web-storage.ts` L100-290 |
| Чому не mandatory в Zod? | Runtime-об'єкти не мають `$schema` — він додається лише при серіалізації на диск | Zod schemas `$schema: z.string().optional()` |
| Яка проблема з constants? | Top-level array не має місця для `$schema` ключа → потрібен object wrapper | `web-storage.ts` Constants branch |
| Чому via string поганий? | `getObjectAttributes()` втрачає ТЧ-контекст; UI не може розпарсити structured info | `find-references.ts` L96-120 |
| findReferences де жити? | Core — pure TS, працює з ProjectModel, потрібен для Phase 2 DDL | `find-references.ts` — no React/browser deps |
| ZIP import чому silent? | `importProject` → session c null handle → restore status "restored" → excludes Welcome | `project-store.ts` L495-530, `editor-panel.tsx` |
| StdAttrs ТЧ чому не працює? | Prop `tabularSectionName` підтримується але caller не передає | `standard-attributes-dialog.tsx` |

---

## Рекомендовані патерни

### `$schema` injection через core helper + web pipeline
Pure-функція `enrichSchemaUrl(obj, schemaVersion)` у core формує URL з `kind` + `schemaVersion`. Викликається у `serializeToFiles()` web-storage перед `serializeMetadataObject()`. Core не знає про project context — caller (web) передає `schemaVersion`. Canonical serializer тільки **впорядковує** ключі, не **додає** нових.

### Structured Reference type замість free-form string
`Reference = { from, referenceKind, fieldName?, tabularSectionName? }` — structured enum замість `via: string`. UI helper `formatReference(ref)` для відображення. Парсинг строк не потрібен.

### WhereUsedDialog як reusable component
Діалог приймає `references: Reference[]` і `objectName: string`. Логіка пошуку — в `@simetra/core` (після міграції). Caller (дерево або delete confirmation) формує список і передає.

### Constants object wrapper для уніфікації файлового контракту
Всі `.meta.json` файли мають unified shape: top-level object з `$schema` першим ключем. Константи: `{ "$schema": "...", "constants": [...] }`. Backward compat: `parseFileStructure` парсить обидва формати.

### Store invariant tests як окрема test suite
Кожен тест виконує послідовність actions і перевіряє інваріант. Preload store через `useUiStore.setState(...)`.

### Firevent для keyboard shortcuts
`fireEvent.keyDown(document, { key: 's', ctrlKey: true })` для тестування hotkeys. react-hotkeys-hook слухає на document.

---

## Антипатерни (уникати)

### ❌ `$schema` як обов'язкове поле в Zod-схемі
`$schema` — metadata для IDE та CI, додається при серіалізації. Runtime-об'єкти не повинні вимагати його. Залишати `z.string().optional()`.

### ❌ `$schema` injection у `serializeMetadataObject()`
Ця функція — pure serializer, не знає про project context (schemaVersion). Enrichment — окрема відповідальність caller.

### ❌ Free-form `via` string у Reference
Парсинг строк для UI — антипатерн. Structured enum `referenceKind` + optional `fieldName` + `tabularSectionName`.

### ❌ View state у metadata store
View state — це UI state. Не має потрапляти в undo-стек zundo.

### ❌ WhereUsedDialog з прямим доступом до store
Діалог приймає готові дані. Логіка пошуку — caller responsibility.

### ❌ Тести через snapshot
Компонентні тести — через assertions на конкретні елементи. Snapshot тести — fragile і не дають розуміння що зламалось.

### ❌ Ref як допустимий valueType для Constant (без ref поля)
Якщо schema дозволяє `"Ref"` — має бути поле `ref` для target. Інакше broken state. До додавання ref-поля — виключити `"Ref"` зі schema.

---

## Пріоритети та порядок виконання

### Таблиця пріоритетів (за результатами дослідження)

| # | Блок | Severity | Обґрунтування |
|---|------|----------|---------------|
| X | Constant Ref gap | **High** | Broken state у schema — UI показує нефункціональну опцію |
| A | $schema + constants format | **High** | Блокує Phase 2 file contract |
| B | Reference enrichment + core migration + Where Used | **High** | FR-052 частково зроблено, console.info в production |
| D | ZIP import restore | **Medium** | UX confusion — порожній екран після reload |
| F | StdAttrs ТЧ wiring | **Low** | Компонент готовий, лише wiring |
| C | View state detach | **Low** | UX degradation, не functional break |
| G | Validation UX scoping | **Info** | Тільки документування scope |
| E | Тести | — | Залежить від B, D, X |

### Граф залежностей

```
X (Constant Ref) — незалежний, швидкий fix
  ↓
A ($schema + constants format)
  ↓
B1 (Reference enrichment) → B2 (findReferences → core) → B3 (Where Used Dialog)
  ↓                                                         ↓
D (ZIP import)  ‖  F (StdAttrs ТЧ wiring)  ‖  G (Validation scoping only)
                        ↓
E (Тести — всі блоки E1-E7)
```

Блоки D, F, G незалежні одне від одного. Блок E залежить від B, D, X (тестує їх). Блок C — відкладений або known limitation.

---

## Пов'язана документація

- `docs/BRD-metadata-configurator.md` — бізнес-вимоги (§5.7 — Constant, §6 — типи полів, §7.6 — $schema та серіалізація, §8.6 — referential integrity)
- `.github/instructions/metadata-model.instructions.md` — правила Zod-схем
- `.github/instructions/ui-architecture.instructions.md` — правила побудови UI
- `packages/core/src/schemas/` — Zod-схеми метаданих
- `packages/core/src/schemas/constant.ts` — Constant schema (valueType gap)
- `packages/core/src/schemas/field-type.ts` — fieldTypeSchema (включає "Ref")
- `packages/core/src/serialization.ts` — canonical serializer (KEY_ORDER, orderKeys)
- `apps/web/src/lib/find-references.ts` — Where Used логіка (→ планується міграція в core)
- `apps/web/src/storage/web-storage.ts` — serializeToFiles / parseFileStructure (constants branch)
- `apps/web/src/stores/ui-store.ts` — UI store (selectedField, activeSection)
- `apps/web/src/stores/project-store.ts` — importProject, restoreDraft, session management
- `apps/web/src/storage/session-db.ts` — IndexedDB persistence (clearSession / clearDraft)
- `apps/web/src/components/editor/standard-attributes-dialog.tsx` — tabularSectionName prop support
- `apps/web/src/components/layout/tree/tree-nodes.tsx` — handleWhereUsed (console.info)
- `apps/web/src/components/layout/tree-panel.tsx` — DeleteConfirmDialog (вже з references)
- `apps/web/src/components/editor/data-type-editor-dialog.tsx` — Data Type Editor

---

## Definition of Done

### Контракти
- [ ] Всі `.meta.json` файли мають `$schema` як перший ключ (через `enrichSchemaUrl()` helper у core)
- [ ] `$schema` URL відповідає конвенції `https://simetra.dev/schemas/v1/{kind-kebab}.schema.json`
- [ ] `$schema` залишається `z.string().optional()` у Zod-схемах (injection — при серіалізації, не валідації)
- [ ] `constants.meta.json` — object wrapper `{ "$schema": "...", "constants": [...] }` замість top-level array
- [ ] `findReferences` перенесено в `@simetra/core`, реекспортовано
- [ ] `Reference` type — structured (referenceKind enum, fieldName, tabularSectionName)
- [ ] `constantValueTypeSchema` — без `"Ref"` (виключено до додавання ref поля)

### UI
- [ ] "Де використовується" відкриває діалог з таблицею посилань (а не console.info)
- [ ] Delete confirmation використовує `formatReference()` замість raw `ref.via`
- [ ] ZIP import: reload після import → Welcome Screen з recovery option (не порожній екран)
- [ ] StdAttrs ТЧ: StandardAttributesDialog отримує `tabularSectionName` з контексту вибраного вузла

### Тести
- [ ] Window manager invariant tests (5+ тестів)
- [ ] Floating window component tests (4+ тестів)
- [ ] Shell hotkey tests (7+ тестів)
- [ ] Command palette interaction tests (3+ тестів)
- [ ] Session persistence tests (4+ тестів)
- [ ] Data Type Editor dialog tests (10+ тестів)
- [ ] Reference model tests — cascade rename, enriched Reference (3+ тестів)
- [ ] findReferences unit tests у `packages/core/src/__tests__/` (після міграції)
- [ ] Constant valueType validation — reject "Ref" (1+ тест)
- [ ] $schema enrichment roundtrip tests (2+ тестів)
- [ ] Constants object wrapper serialization/parsing tests (2+ тестів)

### Quality gate
- [ ] `pnpm lint` — без помилок
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm test` — все зелене
- [ ] Жодної `console.info` / `console.log` замість реального UI
- [ ] Golden fixtures мають `$schema` з правильним URL suffix `.schema.json`
