# Task: Phase 1 — Виправлення дефектів Модулів 5 і 5a

## Контекст

Після code review Модулів 5 (App shell, 3-panel layout) і 5a (Tabs + Floating Windows) виявлено 6 дефектів та невідповідностей BRD-специфікації. Ці проблеми варіюються від реальних багів (створення Constant через Command Palette, нормалізація `activeWindowId`) до spec-gaps (warnings у status bar, layout defaults). Задача покриває точкові виправлення з мінімальним ризиком регресії.

**Пріоритет виконання** — строго послідовний (кожен наступний пункт може залежати від попереднього):
1. Command Palette creation path
2. activeWindowId normalization
3. Layout defaults + persist migration
4. Status bar warnings channel
5. Editable project name
6. Floating window title icon

## Вимоги

### 1. Command Palette — використання `createDefaultObject` замість raw cast

- [Х] У `apps/web/src/components/command-palette.tsx` замінити ручне створення об'єкта `{ kind, name }` на виклик `createDefaultObject(kind, existingNames)` з `apps/web/src/lib/metadata-defaults.ts`
- [Х] Використовувати `generateUniqueName(kind, existingNames)` для генерації імені замість дублювання логіки
- [Х] Після створення об'єкта перевіряти результат `createObject(...)` — якщо Zod-валідація відхилила, НЕ викликати `selectObject` і `openTab`
- [Х] Після успішного створення — викликати і `selectObject`, і `openTab` (зараз palette може не відкривати вкладку)
- [Х] Переконатися, що створення Constant через палітру працює коректно (має бути `valueType: 'String'` за замовчуванням)

### 2. Нормалізація `activeWindowId` у UI store

- [Х] У `apps/web/src/stores/ui-store.ts`, action `detachTab`: після створення floating window — встановити `activeWindowId` на id нового вікна (зараз не встановлюється)
- [Х] У action `attachWindow`: після переміщення window у tabs — якщо `activeWindowId === windowId`, скинути `activeWindowId` на `null` і встановити `activeTabId` на нову вкладку
- [Х] У action `closeWindow`: якщо `activeWindowId === windowId`, знайти наступне вікно з найвищим `zIndex` і встановити `activeWindowId` на нього (або `null`, якщо вікон більше немає)
- [Х] У action `minimizeWindow`: якщо `activeWindowId === windowId`, аналогічно знайти наступне non-minimized вікно або скинути на `null`
- [Х] Після кожної lifecycle-action, що видаляє або мінімізує вікно, має діяти інваріант: `activeWindowId` завжди вказує на існуюче, non-minimized вікно або `null`

### 3. Layout defaults відповідно до BRD

- [Х] У `apps/web/src/stores/ui-store.ts` змінити `DEFAULT_PANEL_LAYOUT` з `{ tree: 20, editor: 55, properties: 25 }` на `{ tree: 20, editor: 50, properties: 30 }` (BRD §9.1, ui-architecture.instructions.md)
- [Х] Додати persist migration (version bump) щоб у існуючих користувачів із збереженими layout в localStorage застосувалися нові defaults замість старих значень
- [Х] У компоненті, що використовує `react-resizable-panels`, забезпечити min-width для tree panel ≥ 200px (BRD §9.1: "min 200px")

### 4. Status bar — канал warnings

- [Х] У `apps/web/src/components/layout/status-bar.tsx` додати відображення кількості warnings
- [Х] Джерело даних: `openWarnings` з `useProjectStore` (масив попереджень, що повертається при open)
- [Х] Формат відображення: аналогічний до errors — іконка + кількість, інший колір (жовтий/amber замість червоного)
- [Х] Warnings показуються поруч з errors: "N errors · M warnings"

### 5. Редагування назви проєкту в top bar

- [Х] У `apps/web/src/components/layout/top-bar.tsx` замінити read-only `<span>` із назвою проєкту на inline editable input
- [Х] Поведінка: клік або F2 на назві → inline input з'являється, blur або Enter → commit через `updateProject({ name: newName })`, Escape → cancel
- [Х] Валідація: непорожній рядок (мінімум 1 символ після trim)
- [Х] Action `updateProject` вже існує в metadata store — використовувати його

### 6. Іконка типу у title bar floating window

- [Х] У `apps/web/src/components/window-manager/floating-window.tsx` замінити компонент `Badge` для типу метаданих на іконку з `KIND_ICONS` (`apps/web/src/lib/metadata-icons.ts`)
- [Х] Використати `HugeiconsIcon` з відповідною іконкою для `objectKind` — аналогічно тому, як це зроблено в дереві метаданих та `ObjectEditor`
- [Х] Зберегти текстове ім'я об'єкта поруч з іконкою

## Clarify (питання перед імплементацією)

- [Х] Min-width через CSS або `minSize` prop?
  - Рішення: (B) CSS `min-width: 200px` на внутрішньому елементі, бо react-resizable-panels minSize працює у відсотках

- [Х] Persist migration strategy
  - Рішення: (A) version bump (1→2) + migrate function у zustand persist, міграція лише якщо збережений layout точно дорівнює старим defaults 20/55/25

- [Х] Scope warnings у status bar
  - Рішення: (A) показувати тільки `openWarnings` (попередження парсингу файлів при open/import)

## Рекомендовані патерни

### Єдина фабрика для створення об'єктів
Всі шляхи створення об'єктів (дерево, command palette, hotkey) мають використовувати `createDefaultObject()` з `metadata-defaults.ts`. Це гарантує, що всі required fields (як-от `valueType` для Constant) завжди присутні. Дублювання логіки створення — джерело багів.

### Атомарна нормалізація активного фокусу
При будь-якій зміні колекції `floatingWindows` або `openTabs` — нормалізувати `activeWindowId` і `activeTabId` в тому ж immer produce block. Не розділяти на окремі виклики `set()`, бо це створює проміжний стан де обидва можуть бути неконсистентними.

### Persist migration через zustand version
Zustand persist підтримує `version` + `migrate(oldState, oldVersion)`. При зміні shape або defaults — bump version і написати міграцію. Не покладатися на "просто змінити default" — це не вплине на вже збережений стан.

### Inline edit pattern: controlled → commit → revert
Для inline editing (project name): (1) перемикач isEditing, (2) локальний useState для draft значення, (3) onBlur/Enter → commit до store, (4) Escape → revert до store value, (5) autoFocus + selectAll при вході в режим редагування.

## Антипатерни (уникати)

### ❌ Дублювання логіки створення об'єктів
Якщо Command Palette створює об'єкт по-своєму (обминаючи `createDefaultObject`), кожне додавання нового required field у core-схему ламатиме один зі шляхів створення. Один factory — одне місце для змін.

### ❌ Розрізнені виклики set() для зв'язаних полів
`set({ activeWindowId: null }); set({ activeTabId: newId })` — між цими двома викликами React може зарендерити проміжний стан. Все пов'язане — в одному `set()` або immer `produce`.

### ❌ Fallback на default без міграції persist
Якщо просто змінити `DEFAULT_PANEL_LAYOUT` без persist migration, Zustand бере збережене значення (старе 20/55/25) і ігнорує новий default. Користувач ніколи не побачить правильний layout, поки не очистить localStorage.

### ❌ Fire-and-forget при створенні об'єкта
Зараз command-palette викликає `createObject(obj)` і одразу `selectObject` + `openTab` без перевірки результату. Якщо `createObject` відхилить об'єкт (Zod validation fail), `selectObject` спробує виділити неіснуючий об'єкт. Завжди перевіряти результат перед side effects.

### ❌ z.any() для inline edit value
Навіть тимчасовий draft value має бути типізованим (string для project name). Не використовувати type assertions.

## Архітектурні рішення

### Потік даних при створенні об'єкта

```
Command Palette / Tree / Hotkey
        │
        ▼
generateUniqueName(kind, existingNames)
        │
        ▼
createDefaultObject(kind, existingNames)   ← єдина фабрика
        │
        ▼
metadataStore.createObject(object)         ← Zod validation
        │
        ├── OK → selectObject + openTab
        └── Fail → показати помилку, НЕ відкривати
```

### Нормалізація activeWindowId

```
Будь-яка lifecycle action (close / attach / minimize)
        │
        ▼
Видалити/змінити window у floatingWindows[]
        │
        ▼
Чи activeWindowId === змінений window?
        │
        ├── Ні → нічого
        └── Так → знайти наступне non-minimized window
                    з найвищим zIndex
                    │
                    ├── Є → activeWindowId = його id
                    └── Немає → activeWindowId = null
```

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `docs/BRD-metadata-configurator.md` — §9.1 (layout), §9.2 (top bar), §9.6 (status bar), §9.7 (keyboard shortcuts)
- `docs/tasks/phase1-foundation.md` — Модуль 5 і 5a (повна специфікація)
- `.github/instructions/ui-architecture.instructions.md` — layout 20/50/30, z-index система, keyboard shortcuts
- `.github/instructions/metadata-model.instructions.md` — Zod-схеми, типи метаданих
- `apps/web/src/lib/metadata-defaults.ts` — `createDefaultObject`, `generateUniqueName`
- `apps/web/src/lib/metadata-icons.ts` — `KIND_ICONS` маппінг
- `apps/web/src/stores/ui-store.ts` — window lifecycle actions, `DEFAULT_PANEL_LAYOUT`
- `apps/web/src/stores/metadata-store.ts` — `createObject`, `updateProject`
- `apps/web/src/stores/project-store.ts` — `openWarnings`

## Definition of Done

- [Х] Створення Constant через Command Palette працює без помилок валідації
- [Х] Всі шляхи створення об'єктів використовують `createDefaultObject`: дерево (`tree-panel.tsx`), command palette (`command-palette.tsx`), hotkey Ctrl+N (`app-shell.tsx`)
- [Х] `activeWindowId` завжди вказує на існуюче non-minimized вікно або `null` (інваріант)
- [Х] `DEFAULT_PANEL_LAYOUT` = 20/50/30, persist migration працює
- [Х] Min-width tree panel забезпечено
- [Х] Status bar показує warnings поруч з errors
- [Х] Назва проєкту редагується inline з commit-on-blur
- [Х] Floating window title bar показує іконку типу замість Badge
- [Х] Існуючі тести (`pnpm --filter web test`) проходять
- [Х] `pnpm lint && pnpm typecheck` — green
