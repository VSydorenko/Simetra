# Task: Phase 1 — State preservation та тестове покриття Модулів 5/5a

## Контекст

Друга частина виправлень після code review Модулів 5 (App shell) і 5a (Tabs + Floating Windows). Ця задача покриває складнішу проблему збереження стану при detach/attach та недостатнє тестове покриття shell і window manager.

**Залежність**: мержити ПІСЛЯ `phase1-module5-bugfixes.md` (Task A), бо тести залежатимуть від виправлених багів (зокрема activeWindowId normalization).

**Пріоритет виконання**:
1. State preservation при detach/attach
2. Тести window manager (store invariants + component)
3. Тести shell (hotkeys + command palette interaction)

## Вимоги

### 1. Збереження стану при detach/attach

- [ ] Створити механізм object-scoped view state у UI store, де для кожного objects зберігається:
  - `activeEditorTab` — активна вкладка редактора (Attributes, TabularSections, Dimensions тощо)
  - `selectedField` — вибраний рядок у таблиці атрибутів (index або id)
- [ ] Ключ — `objectId` (формат `{kind}:{name}`)
- [ ] При detachTab → view state вже збережений у store (не в локальному useState компонента) → floating window підхоплює його
- [ ] При attachWindow → аналогічно, view state залишається у store → нова вкладка підхоплює його
- [ ] Очистка view state при закритті останньої вкладки/вікна для цього об'єкта (коли objectId більше не відкритий ніде)
- [ ] У `apps/web/src/components/editor/attribute-table.tsx` замінити локальний `useState` для `selectedRow` на read/write з UI store view state

### 2. Тести window manager

#### Store invariant tests (`apps/web/src/__tests__/ui-store.test.ts`)
- [ ] Після `attachWindow`: `activeWindowId` !== attached window id
- [ ] Після `closeWindow` останнього вікна: `activeWindowId === null`
- [ ] Після `minimizeWindow` активного вікна: `activeWindowId` переключається на інше non-minimized вікно або `null`
- [ ] Після `detachTab`: `activeWindowId` === нового floating window id
- [ ] Інваріант: `activeWindowId` завжди є `null` або id існуючого non-minimized вікна з `floatingWindows[]`
- [ ] Інваріант: якщо `floatingWindows` не порожній і є non-minimized вікна, то `activeWindowId` не `null` (якщо користувач не зробив explicit focus на tab)

#### Component integration tests
- [ ] Створити `apps/web/src/__tests__/floating-window.test.tsx`
- [ ] Floating window рендерить ObjectEditor з правильним objectId
- [ ] Title bar показує іконку типу та ім'я об'єкта (після фіксу з Task A)
- [ ] Кнопки minimize/maximize/close викликають відповідні store actions
- [ ] Мінімізовані вікна не рендеряться у FloatingWindowContainer
- [ ] Мінімізовані вікна відображаються у Taskbar

### 3. Тести shell

#### Keyboard shortcuts tests (`apps/web/src/__tests__/app-shell.test.tsx`)
- [ ] Ctrl+S dispatch-ить save action у project store
- [ ] Ctrl+Z dispatch-ить undo у metadata store
- [ ] Ctrl+Shift+Z dispatch-ить redo у metadata store
- [ ] Ctrl+N відкриває діалог нового об'єкта або створює через default action
- [ ] Ctrl+W закриває активну вкладку
- [ ] Ctrl+Tab / Ctrl+Shift+Tab перемикає вкладки
- [ ] Ctrl+K відкриває command palette

#### Command palette interaction tests
- [ ] Замінити mock cmdk (що зараз повертає null) на lightweight mock, що рендерить input + filterable list
- [ ] Palette фільтрує об'єкти по назві
- [ ] Palette створює об'єкт при виборі "New {Kind}"
- [ ] Palette переходить до існуючого об'єкта при виборі його зі списку

## Clarify (питання перед імплементацією)

- [ ] Де зберігати view state — Map у UI store чи окремий slice?
  - Чому це важливо: view state (activeEditorTab, selectedField) для кожного об'єкта — це runtime UI state, але пов'язаний з конкретним об'єктом
  - Варіанти: (A) `Record<string, ObjectViewState>` поле у UI store, (B) окремий `viewStateStore`, (C) `Map` у UI store
  - Вплив на рішення: persist стратегія (зберігати між сесіями чи ні), serialization (Map не серіалізується), memory footprint

- [ ] Глибина збереження view state
  - Чому це важливо: крім activeEditorTab і selectedField, може бути scroll position, expanded sections тощо
  - Варіанти: (A) мінімум — тільки activeEditorTab + selectedField, (B) включити scroll position, (C) включити expanded accordion sections
  - Вплив на рішення: складність реалізації, обсяг рефакторингу компонентів

- [ ] Стратегія мокання react-rnd у тестах
  - Чому це важливо: react-rnd є DOM-heavy і потребує browser layout engine для drag/resize
  - Варіанти: (A) повний mock модуля що рендерить div з пропсами, (B) shallow render без drag тестів, (C) partial mock — тестувати тільки callbacks
  - Вплив на рішення: coverage vs test complexity

- [ ] Стратегія мокання cmdk для palette тестів
  - Чому це важливо: поточний mock (повертає null) не дозволяє тестувати взаємодію
  - Варіанти: (A) lightweight mock з input + filtered list, (B) partial mock зі збереженням filter logic, (C) тестувати лише store actions напряму без UI
  - Вплив на рішення: coverage UI interaction vs complexity

## Рекомендовані патерни

### Object-scoped view state як Record в UI store
View state для кожного відкритого об'єкта зберігається як `Record<string, ObjectViewState>`. Ключ — `objectId` у форматі `Kind:Name`. Store actions для компонентів: `getViewState(objectId)`, `setViewState(objectId, partial)`. При закритті останнього tab/window для об'єкта — cleanup entry.

### Controlled selectedRow через store замість useState
Замість `const [selectedRow, setSelectedRow] = useState(null)` у attribute-table — використовувати view state з UI store. Це дозволяє зберігати вибір при переключенні между tabs/windows і при detach/attach. Патерн: `const selectedRow = useUiStore(s => s.getViewState(objectId)?.selectedField)`.

### Store invariant tests як окрема test suite
Виділити invariant checks в окрему describe-групу. Кожен тест виконує послідовність actions і перевіряє, що invariant тримається. Приклад: "open 3 windows → close active → activeWindowId points to remaining window with highest zIndex".

### Component tests через store preloading
Замість мокання store — preload store з потрібним initial state через `useUiStore.setState(...)` перед render. Це тестує реальну інтеграцію компонент ↔ store.

### Firevent для keyboard shortcuts
Використовувати `fireEvent.keyDown(document, { key: 's', ctrlKey: true })` для тестування hotkeys. react-hotkeys-hook слухає keyboard events на document — для Testing Library це працює напряму.

## Антипатерни (уникати)

### ❌ Локальний useState для стану що має переживати remount
Якщо `selectedRow` в attribute-table зберігається у useState — він зникне при переключенні вкладок (unmount → mount) і при detach/attach. View state, що має переживати lifecycle — тільки через store.

### ❌ Мокання внутрішніх деталей store
Не мокати `set()` або `get()` Zustand. Використовувати реальний store з preloaded state. Мокати тільки зовнішні залежності (storage, DOM APIs).

### ❌ Snapshot тести для динамічного UI
Floating windows мають dynamic position, size, zIndex — snapshot тести будуть ламатися при кожній зміні. Тестувати поведінку (які actions викликаються), а не HTML-структуру.

### ❌ Тести що залежать від порядку виконання
Кожен тест має ізольований store state. Використовувати `beforeEach` з `useUiStore.setState(initialState)` або `useUiStore.getState().reset()`.

### ❌ Надмірно детальний view state
Не зберігати scroll position чи pixel-level selection у v1. Почати з мінімуму (activeEditorTab + selectedField), розширити пізніше якщо потрібно.

## Архітектурні рішення

### View state lifecycle

```
openTab / detachTab (об'єкт вперше відкритий)
        │
        ▼
viewState[objectId] створюється з defaults
 { activeEditorTab: 'attributes', selectedField: null }
        │
        ▼
Користувач взаємодіє → setViewState(objectId, partial)
        │
        ▼
detachTab / attachWindow
        │
        ▼
Компонент unmount → mount у новому контексті
        │
        ▼
Новий компонент читає viewState[objectId] → відновлює стан
        │
        ▼
closeTab / closeWindow (останній для objectId)
        │
        ▼
Перевірити: чи objectId ще відкритий в іншому tab/window?
        ├── Так → залишити viewState
        └── Ні → delete viewState[objectId]
```

### Тестова архітектура

```
__tests__/
├── ui-store.test.ts            ← існуючі + нові invariant тести
├── app-shell.test.tsx          ← існуючі + hotkey/palette тести
└── floating-window.test.tsx    ← новий файл, component інтеграція
```

## Пов'язана документація

- `docs/tasks/phase1-module5-bugfixes.md` — Task A (мержити першою)
- `docs/tasks/phase1-foundation.md` — Модуль 5 і 5a повна специфікація, незакриті тести
- `docs/BRD-metadata-configurator.md` — §9.3 (editor panel), §9.4 (floating windows)
- `.github/instructions/ui-architecture.instructions.md` — state management патерни, z-index система
- `apps/web/src/stores/ui-store.ts` — поточний UI store, FloatingWindow тип
- `apps/web/src/components/editor/attribute-table.tsx` — локальний selectedRow useState (рядок 60)
- `apps/web/src/components/editor/object-editor.tsx` — activeEditorTab management
- `apps/web/src/__tests__/ui-store.test.ts` — існуючі store тести
- `apps/web/src/__tests__/app-shell.test.tsx` — існуючі smoke тести

## Definition of Done

- [ ] View state (activeEditorTab, selectedField) зберігається при detach/attach
- [ ] attribute-table використовує store-based selectedRow замість локального useState
- [ ] View state очищається при закритті останнього tab/window для об'єкта
- [ ] Store invariant тести: activeWindowId коректний після всіх lifecycle actions
- [ ] component тести floating-window: render, title bar, minimize/maximize/close
- [ ] Shell hotkey тести: Ctrl+S/Z/Shift+Z/N/W/Tab/K dispatch правильні actions
- [ ] Command palette interaction тести: filter, create, navigate
- [ ] Закриті незакриті тести з phase1-foundation.md: "Hotkeys dispatch відповідні actions у store", "Command Palette відкривається і фільтрує команди", "Floating window draggable і resizable", "При detach/attach — стан обʼєкта зберігається"
- [ ] Існуючі тести (`pnpm --filter web test`) проходять
- [ ] `pnpm lint && pnpm typecheck` — green
