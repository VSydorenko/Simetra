# Task: Architecture Documentation — актуалізація документації до стану Phase 1

> **Мета:** Створити повноцінну архітектурну документацію в `docs/architecture/`, яка відображає реальний стан коду після завершення Phase 1. Після виконання цієї задачі всі архівні task-файли (`phase1-foundation.md`, `editor-layer-redesign.md`, `reference-type-redesign.md`, `data-type-editor.md`, `session-persistence.md`, `phase1-module5-state-and-tests.md`) мають бути **видалені** — документація їх замінює.

## Контекст

Наразі `docs/architecture/OVERVIEW.md` — єдиний архітектурний документ, який є високорівневим загальним оглядом. Він не покриває:
- Реальну структуру stores (3 stores, їхні slices і actions)
- UI component hierarchy (які компоненти де, як data flows)
- Систему вікон (tabs + floating windows) і її state management
- Session persistence з IndexedDB
- Reference model (unified Ref) та find-references
- Data Type Editor і його draft-state pattern
- Standard Attributes / Additional Indexes діалоги
- Canonical serializer і $schema контракт
- Tree builder і presentation/interaction layer split
- i18n architecture

Водночас 6 task-файлів містять цінні **архітектурні рішення, патерни та антипатерни**, які мають бути збережені в документації, але task-файли як формат — неактуальні (змішані TODO, clarify, DoD).

## Вимоги

### Документ 1: `docs/architecture/OVERVIEW.md` — оновити

- [ ] Оновити секцію 2 "Монорепо структура" — актуальна file tree з реальними файлами (stores, storage, hooks, components)
- [ ] Оновити секцію 6 "UI Layout" — додати вертикальні вкладки, floating windows, deep tree
- [ ] Оновити секцію 7 "State Management" — три stores (metadata-store, ui-store, project-store), їхні ролі
- [ ] Оновити секцію 8 "$schema" — фактичний стан контракту
- [ ] Оновити секцію 11 "Roadmap" — Phase 1 → closure, Phase 2 → Supabase як перший deployment target
- [ ] Перевірити що всі технології в Tech Stack актуальні

### Документ 2: `docs/architecture/state-management.md` — створити

- [ ] Три stores: metadata-store (Zustand + immer + zundo), ui-store (Zustand), project-store (Zustand)
- [ ] Metadata store: ProjectModel, actions (CRUD objects, attributes, tabular sections, enum values), objectVersions, validationErrors
- [ ] UI store: openTabs, activeTabId, floatingWindows, activeWindowId, selectedField, expandedTreeNodes, viewState (planned), per-tab activeSection
- [ ] Project store: projectHandle, sessionRestoreStatus, lastSavedVersion, lastSavedObjectVersions, isDirty logic
- [ ] zundo middleware — тільки на metadata-store, UI state поза undo-стеком
- [ ] Persist: ui-store → localStorage (layout, panels), session → IndexedDB (project handle, model, drafts)
- [ ] Data flow діаграма: user action → store mutation → Zod validation → re-render
- [ ] Dirty tracking: global (metadata version vs lastSavedVersion) + per-object (objectVersions vs lastSavedObjectVersions)

### Документ 3: `docs/architecture/ui-components.md` — створити

- [ ] Component hierarchy (AppShell → panels → tree/editor/properties)
- [ ] Tree layer: tree-builder.ts (pure function), tree-types.ts, tree-nodes.tsx (interaction layer), tree-node-presentation.tsx (presentation layer)
- [ ] Deep tree: 4+ рівні (kind → object → structural group → field)
- [ ] Editor layer: ObjectEditor → vertical-nav.tsx (section-config.ts) → секційний контент
- [ ] Properties panel: ObjectProperties, FieldProperties, ProjectSettings — context-sensitive priority
- [ ] Window system: TabBar + FloatingWindowContainer + Taskbar. Z-index система.
- [ ] Dialogs: StandardAttributesDialog, AdditionalIndexesDialog, DataTypeEditorDialog — draft state + revisionKey pattern
- [ ] Command Palette (cmdk)
- [ ] i18n: react-i18next, uk/en locales, naming conventions

### Документ 4: `docs/architecture/storage-and-persistence.md` — створити

- [ ] StorageProvider interface — абстракція від filesystem
- [ ] WebStorage — File System Access API (Chrome/Edge) + ZIP fallback (Safari/Firefox)
- [ ] Canonical serializer: фіксований порядок ключів, 2 пробіли, trailing newline, $schema
- [ ] Session persistence: IndexedDB (session-db.ts, idb), auto-restore (use-session-restore.ts), draft-sync (debounced 3s)
- [ ] File format: BRD §7 compliance (один файл на об'єкт, directory convention)
- [ ] Flow diagrams: Save flow, Open flow, Reload/restore flow, Import/Export flow

### Документ 5: `docs/architecture/metadata-model.md` — створити

- [ ] Reference model: unified Ref (single + polymorphic), MetadataRef { kind, name }
- [ ] Standard attributes: per-kind, conditional (hierarchyType, writeMode, owners, recorderTypes)
- [ ] field-type.ts: єдиний enum з примітивами + "Ref"
- [ ] Attribute properties: type-specific validation (superRefine), stale params rejection
- [ ] ProjectModel: project settings + collections of all 7 metadata types
- [ ] Canonical JSON format: key order, array preservation, $schema injection
- [ ] Schema evolution: schemaVersion, additive-only changes, auto-upgrade
- [ ] Validation: object-level (per mutation), project-level (debounced), SQL reserved words, name uniqueness

### Документ 6: `docs/architecture/patterns-and-decisions.md` — створити

> Цей документ зберігає архітектурні рішення та патерни з виконаних task-файлів.

- [ ] ADR-001: Unified Ref model замість CatalogRef/DocumentRef/EnumRef/AnyRef
- [ ] ADR-002: parent_id як UUID (structural field), не reference
- [ ] ADR-003: Vertical nav замість horizontal tabs в картці об'єкта
- [ ] ADR-004: Properties panel як єдине місце редагування (SettingsForm видалено)
- [ ] ADR-005: DataTypeEditorDialog з draft state + revisionKey pattern
- [ ] ADR-006: Tree presentation/interaction layer split
- [ ] ADR-007: Session persistence через IndexedDB (не localStorage, не Zustand persist)
- [ ] ADR-008: buildTypeEditorTree — shared tree infrastructure для sidebar та data type editor
- [ ] ADR-009: REFERENCEABLE_KINDS з core, не UI literal
- [ ] ADR-010: Object-scoped dirty tracking через objectVersions counter
- [ ] Загальні патерни: commit-on-blur, reactive list, derived standard attributes, store preload testing
- [ ] Антипатерни зі всіх задач: зведений перелік

---

## Clarify (питання перед імплементацією)

- [ ] Чи потрібні Mermaid-діаграми для data flow та component hierarchy?
  - Варіанти: (A) текстові описи, (B) Mermaid у markdown
  - Рекомендація: (B) — Mermaid рендериться на GitHub і в VS Code

- [ ] Чи потрібна окрема документація для тестової стратегії?
  - Варіанти: (A) секція в кожному doc, (B) окремий docs/architecture/testing-strategy.md
  - Рекомендація: (A) — поки scope невеликий

- [ ] Рівень деталізації компонентної ієрархії — назви файлів чи пропси?
  - Варіанти: (A) тільки назви компонентів і файлів, (B) файли + key props + data flow
  - Рекомендація: (B) — корисніше для нових контриб'юторів

---

## Рекомендовані патерни

### ADR формат (Architecture Decision Record)
Кожне рішення: **Контекст** (чому виникло), **Рішення** (що обрали), **Наслідки** (що це означає для коду). Без коду — тільки опис.

### Mermaid для діаграм
Рендериться на GitHub, у VS Code, у більшості markdown viewers. Не потребує зовнішніх інструментів.

### Cross-references між документами
Кожен doc має секцію "Пов'язана документація" з відносними посиланнями. OVERVIEW.md має зведений реєстр.

---

## Антипатерни (уникати)

### ❌ Copy-paste з task files
Не копіювати TODO-списки та clarify секції з task-файлів. Документація має описувати **прийняті рішення та поточний стан**, а не процес прийняття.

### ❌ Код у документації
Мінімум коду — тільки interfaces та type signatures де необхідно для контракту. Решта — посилання на файли.

### ❌ Документація як backlog
Документація описує **що є**, а не **що має бути**. Для планів — окремі task files або roadmap.

---

## Після виконання

### Видалити застарілі task-файли

Після створення всіх архітектурних документів — видалити наступні файли:

- [ ] `docs/tasks/phase1-foundation.md`
- [ ] `docs/tasks/editor-layer-redesign.md`
- [ ] `docs/tasks/reference-type-redesign.md`
- [ ] `docs/tasks/data-type-editor.md`
- [ ] `docs/tasks/session-persistence.md`
- [ ] `docs/tasks/phase1-module5-state-and-tests.md`

Ці файли повністю замінені:
- Невиконані пункти → `docs/tasks/phase1-closure-backlog.md`
- Архітектурні рішення та патерни → `docs/architecture/patterns-and-decisions.md`
- Структура коду → `docs/architecture/ui-components.md`, `state-management.md`, `storage-and-persistence.md`, `metadata-model.md`

---

## Пов'язана документація

- `docs/BRD-metadata-configurator.md` — бізнес-вимоги (source of truth для метамоделі)
- `docs/architecture/OVERVIEW.md` — поточний overview (оновлюється в цій задачі)
- `.github/instructions/*.instructions.md` — правила для coding agent (можуть потребувати оновлення після нової документації)
- Всі 6 task-файлів — **джерела** для витягування рішень і патернів

---

## Definition of Done

- [ ] `docs/architecture/OVERVIEW.md` — оновлений, відображає реальний стан коду
- [ ] `docs/architecture/state-management.md` — створений, покриває 3 stores + persistence
- [ ] `docs/architecture/ui-components.md` — створений, покриває component hierarchy + window system
- [ ] `docs/architecture/storage-and-persistence.md` — створений, покриває storage + session + serializer
- [ ] `docs/architecture/metadata-model.md` — створений, покриває reference model + validation + schema evolution
- [ ] `docs/architecture/patterns-and-decisions.md` — створений, покриває 10+ ADR + зведені патерни/антипатерни
- [ ] Cross-references між документами коректні
- [ ] Всі 6 застарілих task-файлів видалені
- [ ] `.github/instructions/` перевірені на актуальність (оновлені якщо потрібно)
- [ ] `pnpm lint` — без помилок (якщо lint перевіряє markdown)
