# Simetra — Architecture Overview

> Цей документ є живою архітектурною довідкою. Оновлюється разом з кодом.

## 1. Що таке Simetra

Open-source візуальний конфігуратор бізнес-метаданих, натхненний підходом конфігуратора 1С:Підприємство, але реалізований як сучасний кросплатформний додаток.

Користувач мислить **бізнес-об'єктами** — довідниками, документами, регістрами — а система знає структуру, стандартні реквізити та правила поведінки кожного типу.

**Ліцензія:** Apache 2.0

## 2. Монорепо структура

```
simetra/
├── apps/
│   └── web/                        — React SPA (Vite 6), основний інтерфейс конфігуратора
├── packages/
│   ├── core/                       — @simetra/core: Zod-схеми, типи, валідація (чистий TS)
│   └── ui/                         — @workspace/ui: shadcn/ui компоненти
├── docs/
│   ├── architecture/               — архітектурна документація (цей файл)
│   ├── research/                   — результати досліджень
│   └── tasks/                      — задачі для coding agent
└── turbo.json                      — Turborepo конфігурація
```

### Planned packages (Phase 2+)

```
packages/
├── @simetra/json-schemas           — Згенеровані JSON Schema (з Zod, build step)
├── @simetra/generator-api          — MetadataGenerator interface + спільні утиліти
├── @simetra/generator-pg           — PostgreSQL DDL генератор
├── @simetra/generator-efcore       — EF Core генератор
└── @simetra/cli                    — CLI обгортка (citty)
apps/
├── desktop/                        — Tauri 2.0 (Phase 3)
└── vscode/                         — VS Code extension (Phase 3)
```

## 3. Ключовий принцип: Core як серцевина

`@simetra/core` — не залежить ні від React, ні від Tauri, ні від Node.js API. Чистий TypeScript з Zod. Це дозволяє:
- Використовувати в Web UI (React), CLI (Node.js), Desktop (Tauri), VS Code extension
- Тестувати метамодель незалежно від UI
- Генерувати JSON Schema з Zod як build artifact

## 4. Система типів метаданих

Кожен тип метаданих має:
- **Стандартні реквізити** — задані платформою, не видаляються
- **Налаштування типу** — конфігурує поведінку конкретного об'єкта
- **Дозволені підоб'єкти** — табличні частини, виміри, ресурси
- **Ролі полів** — для регістрів: вимір, ресурс, реквізит

### MVP типи

| Тип | Стандартні реквізити | Ролі полів | Табличні частини |
|-----|---------------------|------------|------------------|
| Catalog | id, code, description, deletion_mark, parent_id, is_folder, owner_id, ... | — | ✅ |
| Document | id, number, date, posted, deletion_mark, ... | — | ✅ |
| Enumeration | — (фіксовані значення) | — | — |
| InformationRegister | period, recorder_id, line_number, active | Dimension, Resource, Attribute | — |
| AccumulationRegister | period, recorder_id, line_number, active, movement_type | Dimension, Resource (numeric), Attribute | — |
| Constant | — (одиничне значення) | — | — |
| CustomTable | id¹ | — | — |

Повна специфікація: `docs/BRD-metadata-configurator.md`, секції 5.1–5.10.

## 5. Технологічний стек

### UI Layer (apps/web)

| Компонент | Технологія |
|-----------|------------|
| Framework | React 18+ / Vite 6 |
| UI Kit | shadcn/ui + Tailwind CSS 4 |
| State management | Zustand + immer |
| Undo/Redo | zundo |
| Tree view | react-arborist |
| Table | @tanstack/react-table v8 |
| Resizable panels | react-resizable-panels |
| Command palette | cmdk |
| Hotkeys | react-hotkeys-hook |
| Icons | lucide-react |

### Core Layer (packages/core)

| Компонент | Технологія |
|-----------|------------|
| Schema validation | Zod v4 |
| JSON Schema generation | zod-to-json-schema |
| Language | TypeScript (strict) |

### Tooling

| Компонент | Технологія |
|-----------|------------|
| Monorepo | pnpm workspaces + turborepo |
| Tests | Vitest + Testing Library |
| Linting | ESLint 9 (flat config) |
| TypeScript | strict mode |

## 6. UI Layout

```
┌────────────────────────────────────────────────────────┐
│  [Logo] [Project Name]    [Save] [Generate] [Export]   │  Top Bar
├──────────┬──────────────────────────┬──────────────────┤
│          │                          │                  │
│  Дерево  │    Редактор полів        │   Властивості    │
│  мета-   │    (таблиця реквізитів   │   (панель        │
│  даних   │     або табличних        │    context-      │
│          │     частин)              │    sensitive)     │
│  [20%]   │    [50%]                 │   [30%]          │
│          │                          │                  │
├──────────┴──────────────────────────┴──────────────────┤
│  Status bar: validation, object count, dirty state     │
└────────────────────────────────────────────────────────┘
```

Три панелі — resizable, середня не менше 30%, права — collapsible. Dark theme за замовчуванням.

## 7. State Management

Zustand store з immer middleware для інтуїтивних мутацій. zundo для undo/redo.

### Store структура (концептуально)

- **Project metadata** — метадані проєкту (name, settings, database config)
- **Metadata objects** — дерево об'єктів (catalogs, documents, registers, ...)
- **UI state** — виділений об'єкт, активна вкладка, стан панелей
- **Temporal state** — стек undo/redo (zundo)

## 8. Формат метаданих

JSON-файли з JSON Schema валідацією. Один файл на об'єкт.

```
metadata/
├── project.meta.json
├── catalogs/{name}/{name}.meta.json
├── documents/{name}/{name}.meta.json
├── enumerations/{name}/{name}.meta.json
├── accumulation-registers/{name}/{name}.meta.json
├── information-registers/{name}/{name}.meta.json
├── constants/constants.meta.json
└── custom-tables/{name}/{name}.meta.json
```

### Правила серіалізації

1. Сортовані ключі (фіксований порядок з JSON Schema)
2. 2-пробільний відступ
3. Trailing newline
4. Кожен файл має `$schema`
5. UTF-8 без BOM
6. Ніяких volatile даних (timestamps, checksums)

## 9. Storage Strategy

Phase 1 (Web SPA) — доступ через абстракцію `StorageProvider`:
- `WebStorage` — File System Access API (Chrome/Edge) + download/upload fallback

Phase 2+ (planned):
- `TauriStorage` — нативний FS через Tauri
- `NodeStorage` — для CLI

## 10. Build & Dev Commands

```bash
pnpm dev          # Запуск dev-сервера
pnpm build        # Продакшн збірка
pnpm test         # Запуск тестів
pnpm typecheck    # Перевірка типів
pnpm lint         # Лінтинг
pnpm format       # Перевірка форматування
```

## 11. Roadmap

| Phase | Focus | Key deliverables |
|-------|-------|-----------------|
| Phase 1 | Web UI Prototype | 3-panel layout, 7 metadata types, CRUD, undo/redo |
| Phase 2 | Generation & CLI | PostgreSQL DDL, EF Core, CLI tool |
| Phase 3 | Desktop & Live DB | Tauri desktop, VS Code extension, schema introspection |
| Phase 4 | Advanced Modeling | Charts of accounts, accounting registers, schema visualizer |
| Phase 5 | Platform | Metadata-driven runtime |
