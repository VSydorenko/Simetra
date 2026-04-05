# Simetra — Architecture Overview

> Цей документ описує поточну архітектуру коду. Roadmap винесений в окрему секцію і не описує вже реалізований стан.

## 1. Що таке Simetra

Simetra — open-source візуальний конфігуратор бізнес-метаданих. Поточна реалізація — web-first SPA, у якій користувач працює з бізнес-об'єктами, а не з таблицями бази даних.

Канонічна модель домену живе в `@simetra/core`: Zod-схеми задають типи метаданих, правила валідації й формат серіалізації. `apps/web` використовує цю модель без дублювання типів.

Ліцензія: Apache 2.0.

## 2. Монорепо структура

Поточна структура монорепо зосереджена на трьох робочих пакетах і документації.

### apps/web

- `src/components/layout` — shell застосунку: TopBar, 3-panel layout, StatusBar, panel composition.
- `src/components/editor` — редактори об'єктів, вертикальна навігація секцій, діалоги, recovery banner, welcome screen.
- `src/components/properties` — context-sensitive редактори властивостей поля, табличної частини, об'єкта та налаштувань проєкту.
- `src/components/window-manager` — вкладки, floating windows, taskbar.
- `src/stores` — `metadata-store`, `ui-store`, `project-store`.
- `src/storage` — I/O абстракція, браузерне файлове сховище, IndexedDB session/draft persistence.
- `src/hooks` — dirty tracking, project-level validation, session restore та інші реактивні адаптери.
- `src/i18n` — ініціалізація локалізації й ресурси `uk`/`en`.
- `src/lib` — похідні утиліти UI-рівня, що працюють поверх `@simetra/core`.

### packages/core/src

- `schemas` — Zod-схеми всіх типів метаданих, `Project`, `ProjectModel`, reference model.
- `serialization.ts` — canonical JSON serializer, порядок ключів і `$schema` URL helpers.
- `find-references.ts` — пошук міжоб'єктних посилань у `ProjectModel`.
- `index.ts` — публічний barrel export для UI та тестів.

### packages/ui/src

- `components` — спільні shadcn/ui компоненти.
- `hooks` — базові UI hooks.
- `lib` — допоміжні утиліти UI kit.
- `styles` — глобальні стилі й theme assets.

### docs/architecture

- `OVERVIEW.md` — коротка карта поточної архітектури.
- Тематичні документи цього розділу деталізують state, UI, storage і рішення без дублювання коду.

Майбутні генератори, CLI та інші deployment targets не вважаються частиною поточної структури коду; вони описуються тільки в roadmap.

Ключові файли: [../../apps/web/src/components/layout/app-shell.tsx](../../apps/web/src/components/layout/app-shell.tsx), [../../apps/web/src/stores/metadata-store.ts](../../apps/web/src/stores/metadata-store.ts), [../../apps/web/src/storage/storage-provider.ts](../../apps/web/src/storage/storage-provider.ts), [../../packages/core/src/schemas/project-model.ts](../../packages/core/src/schemas/project-model.ts), [../../packages/core/src/serialization.ts](../../packages/core/src/serialization.ts)

## 3. Ключовий принцип: Core як canonical source

`@simetra/core` є серцевиною системи.

- Пакет не залежить від React, браузерних API чи Node.js.
- Zod-схеми є single source of truth для типів метаданих і правил валідації.
- UI імпортує типи, схеми, serializer helpers і reference utilities з core, а не описує модель повторно.
- Серіалізація у файловий формат також визначена в core, тому write-path і доменна модель еволюціонують разом.

## 4. Система типів метаданих

Поточний `ProjectModel` містить сім колекцій бізнес-об'єктів:

| Тип | Призначення |
|-----|-------------|
| Catalog | Довідники |
| Document | Документи |
| Enumeration | Перелічення |
| InformationRegister | Регістри відомостей |
| AccumulationRegister | Регістри накопичення |
| Constant | Константи |
| CustomTable | Довільні таблиці |

Детальна специфікація стандартних реквізитів, ролей полів і JSON-формату описана в [../BRD-metadata-configurator.md](../BRD-metadata-configurator.md). Поточна програмна модель визначена в [../../packages/core/src/schemas/project-model.ts](../../packages/core/src/schemas/project-model.ts) і в каталозі [../../packages/core/src/schemas](../../packages/core/src/schemas).

## 5. Технологічний стек

### UI layer

| Компонент | Поточний стек |
|-----------|---------------|
| Framework | React 19 + Vite 8 |
| UI kit | shadcn/ui через `@workspace/ui` + Tailwind CSS 4 |
| State | Zustand 5 + immer |
| Undo/redo | zundo |
| Tree | react-arborist |
| Floating windows | react-rnd |
| Panel layout | react-resizable-panels |
| i18n | i18next + react-i18next |
| Browser persistence | idb + IndexedDB |
| Tables | @tanstack/react-table v8 |
| Command palette | cmdk |
| Hotkeys | react-hotkeys-hook |

### Core layer

| Компонент | Поточний стек |
|-----------|---------------|
| Validation | Zod 4 |
| Domain model | TypeScript 6 |
| Cross-object utilities | `find-references.ts` у core |
| Canonical serialization | `serialization.ts` у core |

### Tooling

| Компонент | Поточний стек |
|-----------|---------------|
| Monorepo orchestration | pnpm workspaces + Turbo 2 |
| Linting | ESLint 9 flat config |
| Tests | Vitest 4 + Testing Library |
| Type checking | TypeScript 6 strict mode |

Ключові файли: [../../apps/web/package.json](../../apps/web/package.json), [../../packages/core/package.json](../../packages/core/package.json), [../../packages/ui/package.json](../../packages/ui/package.json), [../../package.json](../../package.json)

## 6. UI Layout

Поточний shell побудований навколо 3-panel конфігуратора з верхньою та нижньою службовими панелями.

- `TopBar` містить глобальні дії проєкту: створення, відкриття, збереження, import/export, undo/redo.
- Ліва панель — дерево метаданих з пошуком і глибокою ієрархією `kind -> object -> structural group -> field/tabular section`.
- Центральна панель — робоча область редактора: `TabBar`, контент активного об'єкта, `RecoveryBanner`, `FloatingWindowContainer`, `Taskbar`.
- Права панель — context-sensitive properties panel для поля, табличної частини, об'єкта або проєкту.
- `StatusBar` показує стан проєкту, кількість об'єктів, помилки/попередження, відкриті робочі елементи та dirty state.

Редагування об'єкта відбувається у `ObjectEditor`: ліворуч вертикальна навігація секцій, праворуч контент активної секції. Це замінює спрощену модель з однією таблицею в центрі.

Система вікон має два режими роботи:

- вкладки — основний спосіб навігації між об'єктами;
- floating windows — від'єднані редактори всередині центральної панелі з власним z-order і taskbar для мінімізованих вікон.

Панель властивостей працює за пріоритетом контексту: вибране поле, потім вибрана таблична частина, потім активний object-level контекст (`selectedObject`, далі active floating window, далі active tab), і лише після цього налаштування проєкту.

Ключові файли: [../../apps/web/src/components/layout/app-shell.tsx](../../apps/web/src/components/layout/app-shell.tsx), [../../apps/web/src/components/layout/editor-panel.tsx](../../apps/web/src/components/layout/editor-panel.tsx), [../../apps/web/src/components/layout/properties-panel.tsx](../../apps/web/src/components/layout/properties-panel.tsx), [../../apps/web/src/components/layout/tree-panel.tsx](../../apps/web/src/components/layout/tree-panel.tsx), [../../apps/web/src/components/layout/tree/tree-builder.ts](../../apps/web/src/components/layout/tree/tree-builder.ts), [../../apps/web/src/components/editor/object-editor.tsx](../../apps/web/src/components/editor/object-editor.tsx), [../../apps/web/src/components/editor/vertical-nav.tsx](../../apps/web/src/components/editor/vertical-nav.tsx), [../../apps/web/src/components/window-manager/tab-bar.tsx](../../apps/web/src/components/window-manager/tab-bar.tsx), [../../apps/web/src/components/window-manager/floating-window-container.tsx](../../apps/web/src/components/window-manager/floating-window-container.tsx), [../../apps/web/src/components/window-manager/taskbar.tsx](../../apps/web/src/components/window-manager/taskbar.tsx)

## 7. State Management

Поточний стан не зведений в один conceptual store. Замість цього застосунок розділяє відповідальність між трьома stores.

### metadata-store

- Тримає canonical in-memory `ProjectModel`.
- Виконує CRUD-операції над об'єктами, атрибутами, табличними частинами, enum values, dimensions і resources.
- Підтримує `version`, `objectVersions`, `validationErrors`, `modelErrors`.
- Єдиний store, підключений до `zundo`; undo/redo застосовується тільки до доменної моделі.

### ui-store

- Тримає volatile selection і навігаційний контекст у UI: `selectedObject`, `selectedTabularSection`, `selectedField`, стан панелей, пошук, expanded nodes.
- Керує `openTabs`, `activeTabId`, `floatingWindows`, `activeWindowId`, z-index і per-tab/per-window active section.
- Персистить layout та UI preferences у браузерне storage через Zustand persist.

### project-store

- Керує файловим контекстом і життєвим циклом проєкту.
- Тримає `projectHandle`, `lastSavedVersion`, `lastSavedObjectVersions`, статуси save/load/restore, походження проєкту й recovery state.
- Оркеструє save/open/import/export/restore поверх `StorageProvider`.

### Dirty tracking і validation

- Глобальний dirty state визначається як різниця між `metadata-store.version` і `project-store.lastSavedVersion`.
- Object-scoped dirty state визначається через `objectVersions` проти `lastSavedObjectVersions`.
- `useModelValidation` виконує debounced project-level validation і синхронізує `modelErrors`.
- `useSessionRestore` запускає відновлення сесії при ініціалізації shell.

Ключові файли: [../../apps/web/src/stores/metadata-store.ts](../../apps/web/src/stores/metadata-store.ts), [../../apps/web/src/stores/ui-store.ts](../../apps/web/src/stores/ui-store.ts), [../../apps/web/src/stores/project-store.ts](../../apps/web/src/stores/project-store.ts), [../../apps/web/src/hooks/use-is-dirty.ts](../../apps/web/src/hooks/use-is-dirty.ts), [../../apps/web/src/hooks/use-model-validation.ts](../../apps/web/src/hooks/use-model-validation.ts), [../../apps/web/src/hooks/use-session-restore.ts](../../apps/web/src/hooks/use-session-restore.ts)

## 8. `$schema` і формат метаданих

Файловий формат будується навколо canonical serializer contract у core, а не навколо ad-hoc JSON stringify в UI.

- Serializer використовує URL-конвенцію `$schema`: `https://simetra.dev/schemas/v{schemaVersion}/{kind}.schema.json`.
- `$schema` додається на write-path під час серіалізації через `enrichProjectSchemaUrl` і `enrichSchemaUrl`; це дозволяє не покладатися на вже записані або застарілі значення в пам'яті.
- `project.meta.json` описує налаштування проєкту.
- Для більшості типів використовується one-file-per-object layout: `metadata/{kind-dir}/{object-kebab}/{object-kebab}.meta.json`.
- Константи серіалізуються окремо як wrapper-файл `metadata/constants/constants.meta.json` з власним `$schema` і масивом `constants`.
- Serializer фіксує порядок ключів, зберігає користувацький порядок елементів у масивах, використовує відступ у 2 пробіли і завжди додає trailing newline.

Цей контракт узгоджується з BRD, але фактична реалізація serializer є частиною core і має пріоритет для поточного коду.

Ключові файли: [../../packages/core/src/serialization.ts](../../packages/core/src/serialization.ts), [../../packages/core/src/schemas/project.ts](../../packages/core/src/schemas/project.ts), [../../packages/core/src/schemas/project-model.ts](../../packages/core/src/schemas/project-model.ts), [../../apps/web/src/storage/web-storage.ts](../../apps/web/src/storage/web-storage.ts), [../BRD-metadata-configurator.md](../BRD-metadata-configurator.md)

## 9. Storage Strategy

Доступ до файлової системи винесений в `StorageProvider`, щоб stores працювали з `ProjectModel`, а не з деталями браузерного I/O.

- `StorageProvider` задає контракти `openProject`, `saveProject`, `exportProject`, `importProject`.
- Поточна реалізація `WebStorage` підтримує File System Access API для роботи з директорією проєкту.
- Для браузерів без directory access або для перенесення проєктів використовується ZIP import/export fallback.
- Збереження на диск формує каталог `metadata/`, очищає stale файли й пише canonical serialized contents.
- Session persistence зберігається в IndexedDB через `idb`: handle, модель, версію останнього збереження.
- Draft recovery також живе в IndexedDB: `draft-sync.ts` робить debounced autosave чернетки, а `use-session-restore` і `project-store` відновлюють сесію або показують recovery flow.

Ключові файли: [../../apps/web/src/storage/storage-provider.ts](../../apps/web/src/storage/storage-provider.ts), [../../apps/web/src/storage/web-storage.ts](../../apps/web/src/storage/web-storage.ts), [../../apps/web/src/storage/session-db.ts](../../apps/web/src/storage/session-db.ts), [../../apps/web/src/storage/draft-sync.ts](../../apps/web/src/storage/draft-sync.ts), [../../apps/web/src/hooks/use-session-restore.ts](../../apps/web/src/hooks/use-session-restore.ts)

## 10. Пов'язані архітектурні документи

Цей overview є точкою входу. Деталізація винесена в окремі документи набору `docs/architecture`:

- `state-management.md` — stores, undo/redo, dirty tracking, validation flow.
- `ui-components.md` — component hierarchy, tree layer, window system, dialogs.
- `storage-and-persistence.md` — storage provider, filesystem flows, IndexedDB persistence.
- `metadata-model.md` — `ProjectModel`, reference model, validation boundaries, serializer contract.
- `patterns-and-decisions.md` — стабільні архітектурні рішення й повторно вживані патерни.

## 11. Roadmap

Ця секція описує напрямок розвитку, а не реалізований код.

| Етап | Фокус | Статус |
|------|-------|--------|
| Phase 1 closure | Дошліфування поточного web configurator: документація, UX gaps, перевірки, завершення архітектурного набору документів | roadmap |
| Phase 2 | Генерація PostgreSQL DDL з моделі `@simetra/core`, перший deployment target — Supabase | roadmap |

Усі інші пакети, рантайми й deployment targets мають з'являтися в overview тільки після появи реального коду в репозиторії.
