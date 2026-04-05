---
applyTo: 'apps/web/**/*.{ts,tsx},packages/ui/**/*.{ts,tsx}'
description: 'Правила побудови UI: React компоненти, layout, state management'
---

## Layout — 3-panel конфігуратор з multi-window

```
┌──────────┬───────────────────────────────┬──────────────┐
│  Дерево  │  Tab Bar: [Obj1] [Obj2*] [+]  │ Властивості  │
│  [20%]   ├───────────────────────────────┤  [30%]       │
│          │   Вміст активної вкладки      │              │
│          │   (або floating windows)      │              │
└──────────┴───────────────────────────────┴──────────────┘
```

- `react-resizable-panels` для resizable layout
- Центральна панель = Tab Bar + ObjectEditor/welcome state + floating window container
- Середня панель — не менше 30%
- Права панель — collapsible
- Dark theme за замовчуванням

## Система вікон (Tabs + Floating)

- **Tabs** (за замовчуванням) — вкладки у Tab Bar, як у браузері
- **Floating Windows** — MDI-подібні вікна всередині viewport центральної панелі
- **Detach/Attach** — перемикання між режимами через drag або контекстне меню
- Properties Panel синхронізується з активною вкладкою або active floating window
- Z-index: panels(10) → tab-content(20) → floating-windows(30) → dialogs(40) → command-palette(50)

## Компоненти

### Дерево метаданих (ліва панель)
- `react-arborist` для дерева
- Фіксовані кореневі розділи за типами (Catalogs, Documents, ...)
- Контекстне меню: Додати, Перейменувати, Видалити, Дублювати
- Пошук: Ctrl+F

### ObjectEditor (центральна панель)
- Основний контент центральної панелі — `ObjectEditor`, а не окрема універсальна таблиця
- Навігація всередині об'єкта — через vertical nav і секції `main` / `data` / `values` / інші доступні для kind
- Tabs і floating windows відповідають за навігацію між об'єктами, а не між секціями всередині редактора
- Таблиці реквізитів, tabular sections і enum values є вмістом окремих секцій `ObjectEditor`

### Панель властивостей (права панель)
- Context-sensitive: залежить від вибраного елемента
- shadcn/ui Accordion для груп: "Основні", "Тип даних", "Обмеження", "Додатково"

## State Management

### ✅ ALWAYS
- Zustand + immer для store
- zundo middleware використовуй для `metadata-store`, а не для всього runtime state
- Явно розділяй `metadata-store`, `ui-store`, `project-store`
- `metadata-store` = доменна модель і мутації метаданих
- `ui-store` = tabs, floating windows, layout, selection, navigation state
- `project-store` = file context, save baseline, open/save/restore orchestration
- Імпортуй типи з `@simetra/core` для store typing
- Валідуй через Zod-схеми з core при мутаціях

### ❌ NEVER
- Не тримай UI state (selections, expanded nodes) у metadata store
- Не змішуй file/session lifecycle з `ui-store` або доменними мутаціями в `metadata-store`
- Не мутуй state напряму — тільки через immer produce
- Не зводь metadata, UI і project lifecycle concerns в один store
- Не дублюй Zod-типи в UI — імпортуй з `@simetra/core`

## shadcn/ui

- Використовуй компоненти з `@workspace/ui` (packages/ui)
- Для нових компонентів: `pnpm dlx shadcn@latest add <component> -c apps/web`
- Tailwind CSS 4 для стилізації
- hugeicons для іконок (@hugeicons/react + @hugeicons/core-free-icons)

### Іконки типів метаданих
| Тип | Іконка (hugeicons) |
|-----|----------------------|
| Catalog | Book02Icon |
| Document | File02Icon |
| Enumeration | Menu01Icon |
| AccumulationRegister | BarChart01Icon |
| InformationRegister | Database01Icon |
| Constant | Settings02Icon |
| CustomTable | Table01Icon |

## Keyboard Shortcuts

| Комбінація | Дія |
|---|---|
| Ctrl+K / Cmd+K | Command Palette (cmdk) |
| Ctrl+S / Cmd+S | Зберегти проєкт |
| Ctrl+Z / Cmd+Z | Undo |
| Ctrl+Shift+Z / Cmd+Shift+Z | Redo |
| Ctrl+N / Cmd+N | Новий об'єкт |
| Delete | Видалити вибраний елемент |
| F2 | Перейменувати |
| Ctrl+F / Cmd+F | Пошук по дереву |

## Accessibility

- Повна клавіатурна навігація
- ARIA-атрибути для дерева та таблиці
- Semantic HTML елементи
- Focus indicators

## ℹ️ Де шукати деталі
- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `docs/architecture/ui-components.md` — shell, tree layer, editor, properties panel, dialogs і window system
- `docs/architecture/state-management.md` — межі `metadata-store` / `ui-store` / `project-store` і runtime UI state
- `docs/BRD-metadata-configurator.md`, секція 9 — UI Layout та компоненти
