# Task: Phase 1 — Фундамент конфігуратора

## Контекст

Simetra — open-source візуальний конфігуратор бізнес-метаданих. Monorepo вже ініціалізовано:
- `packages/core` має Zod-схеми для всіх 7 MVP-типів, але без project-level моделі, стандартних реквізитів як reusable механізму, referential integrity та canonical serialization.
- `packages/ui` має лише Button та глобальні стилі.
- `apps/web` — заглушка без layout, store, storage або будь-якої функціональності.

Мета Phase 1 — зібрати мінімально життєздатний конфігуратор: створити проєкт, додати об'єкти всіх 7 типів, редагувати їх у 3-панельному інтерфейсі, зберегти в canonical JSON і безпечно повернутися до цього стану через open/save/undo/redo.

Цей файл описує **весь перший етап** як послідовність модулів. Кожен модуль — окрема задача для coding agent. Виконувати **строго по порядку**, бо кожен наступний модуль спирається на попередній.

---

## Модуль 1: Технічний baseline

### Вимоги
- [ ] Встановити в `apps/web` залежності Phase 1:
  - `zustand`, `immer`, `zundo` — state management
  - `react-arborist` — дерево метаданих
  - `@tanstack/react-table` — таблиця реквізитів
  - `react-resizable-panels` — resizable layout
  - `cmdk` — command palette
  - `react-hotkeys-hook` — keyboard shortcuts
  - `lucide-react` — іконки
  - `@simetra/core` — workspace dependency (вже є як `@workspace/ui`)
- [ ] Встановити `lucide-react` у `packages/ui` (замінить hugeicons для нових компонентів)
- [ ] Додати в `packages/ui` shadcn-компоненти, потрібні для shell:
  - `input`, `textarea`, `select`, `tabs`, `accordion`, `badge`, `dropdown-menu`, `dialog`, `tooltip`, `scroll-area`, `separator`, `table`, `command`, `context-menu`, `popover`, `sheet`
- [ ] Визначити i18n стратегію для інтерфейсу (FR-090, FR-091):
  - Встановити мінімальний i18n framework (наприклад, `react-i18next` або простий `t()` helper з JSON-словниками)
  - Створити початкові словники `uk.json` та `en.json` для UI labels
  - Українська — мова за замовчуванням
  - Усі наступні модулі мають використовувати `t('label.key')` замість хардкодених рядків
- [ ] Перевірити сумісність усіх бібліотек з React 19 (поточна версія у workspace)
- [ ] Запустити `pnpm build && pnpm lint && pnpm typecheck && pnpm test` — green baseline

### Clarify
- [ ] Hugeicons vs Lucide: BRD і інструкції вказують на lucide-react, але scaffold використовує hugeicons
  - Чому важливо: два icon-набори = несумісність, подвійні залежності
  - Варіанти: A) повністю перейти на lucide; B) залишити hugeicons для існуючих, lucide для нових
  - Вплив: UI consistency, bundle size
- [ ] ThemeProvider: scaffold стартує з system theme, BRD каже dark-by-default
  - Варіанти: A) змінити default на dark; B) залишити system
  - Вплив: UI
- [ ] i18n framework: повноцінний react-i18next чи мінімальний t() helper?
  - Чому важливо: впливає на кожен UI-модуль, рефакторинг пізніше — дорогий
  - Варіанти: A) react-i18next (namespace-и, lazy loading, plurals); B) простий Record<string, string> з t() функцією
  - Вплив: архітектура, bundle size, DX

### Definition of Done
- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` — зелений
- [ ] Усі Phase 1 залежності в package.json
- [ ] shadcn-примітиви додані у `packages/ui`
- [ ] i18n framework встановлений, початкові словники створені

---

## Модуль 2: Core foundation — посилення ядра

### Вимоги
- [ ] Зробити `metadataRefSchema.kind` типізованим через `metadataKindSchema` замість вільного `z.string()`
  - Зараз: `kind: z.string()` у `packages/core/src/schemas/metadata-ref.ts`
  - Має бути: `kind: metadataKindSchema`
- [ ] Enforce: ресурси AccumulationRegister приймають тільки Numeric-тип
  - Зараз: `resources: z.array(attributeSchema)` без обмежень
  - Має бути: окрема схема `numericAttributeSchema` або `.refine()` на рівні register
- [ ] Створити реєстр стандартних реквізитів для кожного типу
  - Окремий файл `packages/core/src/schemas/standard-attributes.ts`
  - Кожен тип має функцію, яка повертає список стандартних реквізитів з урахуванням налаштувань (hierarchyType, writeMode тощо)
  - UI використовуватиме це для відображення readonly-полів
  - Стандартні реквізити визначені в BRD §5.2–§5.9 — не змінювати набір
- [ ] Створити агреговану модель проєкту
  - Файл `packages/core/src/schemas/project-model.ts`
  - Тип `ProjectModel` = Project settings + колекції всіх об'єктів метаданих
  - Це runtime-контейнер для всього проєкту, який store буде тримати в памʼяті
- [ ] Додати валідацію SQL reserved words для імен обʼєктів та полів
  - Список заборонених слів: `order`, `group`, `user`, `table`, `select`, `insert`, `update`, `delete`, `index`, `column`, `row`, `type`, `check`, `primary`, `key`, `constraint`, `default`, `null`, `not`, `and`, `or`, `from`, `where`, `join`, `on`, `as`, `in`, `create`, `alter`, `drop`, `grant`, `revoke`, `set`, `values`, `into`, `like`, `between`, `union`, `all`, `any`, `exists`, `case`, `when`, `then`, `else`, `end`, `having`, `limit`, `offset`, `distinct`, `view`, `trigger`, `function`, `procedure`, `schema` тощо
  - Може бути `.refine()` або окрема утилітарна функція
- [ ] Додати валідацію унікальності імен атрибутів у межах одного обʼєкта
- [ ] Створити canonical JSON serializer
  - Файл `packages/core/src/serialization.ts`
  - Фіксований порядок ключів (відповідає BRD §7.6)
  - 2-пробільний відступ, trailing newline, UTF-8 без BOM
  - Масиви attributes/dimensions/resources/tabularSections зберігають порядок користувача
- [ ] Додати barrel export нових модулів у `packages/core/src/schemas/index.ts` та `packages/core/src/index.ts`

### Архітектурні рішення (прийняті)
- **ProjectModel** використовує `Record<MetadataKind, Array<MetadataObject>>` — простіше, достатньо для 200 об'єктів (BRD §11.1), нормалізація не потрібна на цьому етапі
- **MetadataObject** = discriminated union по `kind` (`z.discriminatedUnion("kind", [...])`) — кожна схема вже має `kind` literal, це дає type-safe доступ
- **Валідація імен**: PascalCase regex `/^[A-Z][A-Za-z0-9]*$/` для імен об'єктів, snake_case regex `/^[a-z][a-z0-9_]*$/` для імен полів (FR-024)

### Рекомендовані патерни

#### Discriminated union для метаданих
Кожна Zod-схема вже має `kind` literal. Зібрати єдиний `metadataObjectSchema = z.discriminatedUnion("kind", [...])` як entry point для парсингу будь-якого обʼєкта.

#### Стандартні реквізити як функція від налаштувань
Не хардкодити масив — зробити функцію `getStandardAttributes(kind, settings)`, яка повертає реквізити з урахуванням умов (parent_id є тільки при hierarchyType !== None, movement_type є тільки при registerType === Balance тощо).

#### Canonical serializer як pure function
`serialize(schema, data) => string` — детерміністичний результат, без side effects. Порядок ключів визначається не `JSON.stringify`, а явним маппінгом для кожної схеми.

### Антипатерни

#### ❌ Стандартні реквізити в UI-компонентах
Якщо зашити список стандартних реквізитів у React-компоненти, кожна нова фіча (нові типи, нові умови) потребуватиме змін і в core, і в UI. Джерело правди — тільки core.

#### ❌ z.any() для гетерогенних колекцій
Не використовувати `z.any()` або `unknown` для ProjectModel. Discriminated union або конкретні типи — завжди.

#### ❌ Серіалізація через JSON.stringify
`JSON.stringify` не гарантує порядок ключів і не додає trailing newline. Canonical serializer має бути явним.

### Тести
- [ ] Golden fixtures: створити `packages/core/src/__tests__/fixtures/` з еталонними JSON-файлами для кожного типу (catalog, document, register...) і тестувати roundtrip `parse → serialize → parse`
- [ ] Тести стандартних реквізитів: перевірити, що `getStandardAttributes('Catalog', { hierarchyType: 'FoldersAndItems' })` повертає parent_id та is_folder
- [ ] Тести reserved words: `order`, `group`, `user`, `table` мають відхилятися
- [ ] Тести унікальності імен: два атрибути з однаковим name — reject
- [ ] Тести AccumulationRegister resources: тип String у resource — reject
- [ ] Тести metadataRef: `kind: 'InvalidKind'` — reject

### Definition of Done
- [ ] `metadataRefSchema` типізований через `metadataKindSchema`
- [ ] Ресурси AccumulationRegister enforce Numeric
- [ ] `getStandardAttributes()` працює для всіх 7 типів
- [ ] `ProjectModel` описує повну структуру проєкту
- [ ] `MetadataObject` discriminated union працює
- [ ] Canonical serializer проходить golden fixture тести
- [ ] Reserved words відхиляються
- [ ] Унікальність імен валідується
- [ ] `pnpm --filter @simetra/core test` — green
- [ ] `pnpm lint && pnpm typecheck` — green

---

## Модуль 3: State layer

### Вимоги
- [ ] Створити metadata store (`apps/web/src/stores/metadata-store.ts`)
  - Zustand + immer middleware
  - zundo middleware для undo/redo
  - Тримає `ProjectModel` з core
  - Actions: createObject, updateObject, deleteObject, duplicateObject, renameObject
  - Actions для полів: addAttribute, updateAttribute, removeAttribute, reorderAttributes
  - Actions для табличних частин: addTabularSection, removeTabularSection
  - Actions для значень enum: addEnumValue, removeEnumValue, reorderEnumValues
  - Selector: getObjectByKindAndName, getObjectsByKind, getAllObjects
  - Selector: isDirty (є незбережені зміни)
  - Валідація через Zod-схеми core при кожній мутації
- [ ] Створити UI store (`apps/web/src/stores/ui-store.ts`)
  - Zustand без immer (простий стан)
  - selectedObjectId: {kind, name} | null
  - selectedAttributeIndex: number | null
  - expandedTreeNodes: Set<string>
  - activeTab: string
  - propertiesPanelCollapsed: boolean
  - searchQuery: string
- [ ] Створити project store або slice (`apps/web/src/stores/project-store.ts`)
  - projectPath: string | null (для File System Access API)
  - projectName: string
  - isNewProject: boolean
  - Actions: newProject, openProject, saveProject, exportProject, importProject
  - Делегує серіалізацію/десеріалізацію до core canonical serializer

### Архітектурне рішення (прийняте)
- **Два окремі stores**: metadata store (Zustand + immer + zundo) і UI store (Zustand без immer). Project store — третій, для lifecycle (new/open/save). zundo підключається тільки до metadata store, тому undo/redo не торкає UI state (selections, expanded nodes).
- **Валідація при мутації**: object-level Zod validation при кожній мутації конкретного об'єкта. Project-level validation (referential integrity, унікальність) — debounced, результати в окремому selector.

### Рекомендовані патерни

#### Metadata store + UI store = два окремі stores
zundo підключається тільки до metadata store. UI state (selections, expanded nodes) не потрапляє в undo-стек.

#### Валідація при мутації, а не при відображенні
Кожен action у metadata store проганяє зміну через Zod-схему core. Якщо невалідно — action відхиляється, помилка потрапляє в UI через callback або error state.

#### Імпорт типів тільки з core
Store типізується через `ProjectModel`, `Catalog`, `Document` і т.д. з `@simetra/core`. Жодного дублювання типів.

### Антипатерни

#### ❌ UI state в metadata store
Selections, expanded tree nodes, active tab — це не метадані. Якщо вони потраплять у undo-стек, Ctrl+Z почне "скакати" по вкладках замість відміни реальних змін.

#### ❌ Мутація state напряму
Тільки через immer produce. Ніяких `state.objects.push(...)` поза immer-контекстом.

#### ❌ Окремі stores для кожного типу метаданих
Один централізований metadata store, а не catalogStore + documentStore + registerStore. Інакше referential integrity стає неможливою.

### Definition of Done
- [ ] Metadata store створює/редагує/видаляє обʼєкти всіх 7 типів
- [ ] Undo/Redo працює для всіх мутацій метаданих
- [ ] UI store тримає selections і стан панелей окремо
- [ ] Object-level Zod validation при кожній мутації
- [ ] Project-level validation debounced
- [ ] isDirty правильно відстежує незбережені зміни
- [ ] `pnpm lint && pnpm typecheck` — green

---

## Модуль 4: Storage abstraction

### Вимоги
- [ ] Створити інтерфейс StorageProvider (`apps/web/src/storage/storage-provider.ts`)
  - `openProject(): Promise<ProjectModel>` — вибір каталогу, читання JSON-файлів
  - `saveProject(model: ProjectModel): Promise<void>` — запис canonical JSON
  - `exportProject(model: ProjectModel): Promise<void>` — ZIP-архів
  - `importProject(): Promise<ProjectModel>` — з ZIP
- [ ] Реалізувати WebStorage (`apps/web/src/storage/web-storage.ts`)
  - File System Access API (Chrome/Edge): `showDirectoryPicker()` для open/save
  - Download/upload fallback (Safari/Firefox): JSON download, file input upload
  - Feature detection для переключення між стратегіями
- [ ] Інтегрувати storage з project store
  - save → serialize через canonical serializer з core → write через storage
  - open → read через storage → parse через Zod-схеми core → load у metadata store
- [ ] Створити новий проєкт із дефолтними значеннями (empty ProjectModel)

### Архітектурне рішення (прийняте)
- **File System Access API** (Chrome/Edge): save/open працює з директорією, один файл на об'єкт (BRD §7.2)
- **Fallback** (Safari/Firefox): export/import як ZIP-архів зі структурою каталогів з BRD §7.2
- **Export** завжди створює ZIP незалежно від браузера — для портативності

### Рекомендовані патерни

#### Абстракція storage від store
Store не знає про File System Access API чи ZIP. Він працює тільки з `StorageProvider` інтерфейсом і `ProjectModel`. Деталі I/O — всередині конкретної реалізації.

#### Parse → Validate → Load (а не навпаки)
При відкритті проєкту: спочатку JSON parse, потім Zod validation кожного файлу, потім завантаження у store. Помилки валідації — показувати користувачу, а не мовчки ігнорувати.

### Антипатерни

#### ❌ localStorage як основне сховище
localStorage обмежений 5–10 MB і не підтримує структуру каталогів. Його можна використовувати тільки для auto-save draft, не для основного проєкту.

#### ❌ Серіалізація з volatile даними
Ніяких timestamps, checksums, auto-increment IDs у збережених файлах. Canonical JSON має бути детерміністичним для чистих Git-дифів.

### Тести
- [ ] Roundtrip test: create empty project → save → open → порівняти з оригіналом
- [ ] Валідація при open: зіпсований JSON → зрозуміла помилка
- [ ] Canonical serialization: save → save → byte-identical output

### Definition of Done
- [ ] Можна створити новий проєкт
- [ ] Можна зберегти й відкрити проєкт через File System Access API
- [ ] Fallback працює для браузерів без FS API
- [ ] Export/Import через ZIP працює
- [ ] Roundtrip зберігає byte-identical JSON
- [ ] `pnpm lint && pnpm typecheck` — green

---

## Модуль 5: App shell і 3-panel layout

### Вимоги
- [ ] Замінити заглушку в `apps/web/src/App.tsx` на app shell
- [ ] Top bar:
  - Логотип / назва Simetra
  - Назва поточного проєкту (editable)
  - Кнопки: New, Open, Save (Ctrl+S), Export, Import
  - Dirty indicator (крапка або зірочка біля назви)
  - Undo (Ctrl+Z) / Redo (Ctrl+Shift+Z) кнопки (з disabled стан коли стек порожній)
- [ ] 3-panel layout через `react-resizable-panels`:
  - Ліва панель (дерево) — 20%, min 200px
  - Центральна панель (редактор) — 50%, min 30%
  - Права панель (властивості) — 30%, collapsible
- [ ] Status bar:
  - Кількість обʼєктів у проєкті
  - Кількість validation errors/warnings
  - Dirty state текстом
- [ ] Keyboard shortcuts через `react-hotkeys-hook`:
  - Ctrl+K / Cmd+K — Command Palette
  - Ctrl+S / Cmd+S — Save
  - Ctrl+Z / Cmd+Z — Undo
  - Ctrl+Shift+Z / Cmd+Shift+Z — Redo
  - Ctrl+N / Cmd+N — New object
  - Alt+Enter — Відкрити властивості вибраного елемента (BRD §9.7)
- [ ] Command Palette через `cmdk`:
  - Пошук обʼєктів по назві
  - Команди: New Catalog, New Document, New Enumeration тощо
  - Save, Export, Undo, Redo
- [ ] Dark theme за замовчуванням

### Рекомендовані патерни

#### Shell як composition root
App shell — це місце, де зʼєднуються stores, panels і shortcuts. Кожна панель — окремий компонент, що підключається до store через hooks.

#### Responsive hotkeys з scoping
`react-hotkeys-hook` має scoped handlers. Ctrl+S працює глобально, Delete — тільки коли фокус у дереві або таблиці.

### Антипатерни

#### ❌ Inline стилі для layout
Тільки Tailwind CSS 4 класи. Ніяких style={{}} для розмірів панелей — це робить react-resizable-panels.

#### ❌ Hardcoded розміри
Панелі повинні бути резиновими через react-resizable-panels, а не через фіксовані px/%.

### Тести
- [ ] App shell рендериться без crash
- [ ] Hotkeys dispatch відповідні actions у store
- [ ] Command Palette відкривається і фільтрує команди

### Definition of Done
- [ ] 3-panel layout рендериться і ресайзиться
- [ ] Top bar з усіма кнопками (connected до stores)
- [ ] Status bar показує актуальний стан
- [ ] Keyboard shortcuts працюють (включно з Alt+Enter)
- [ ] Command Palette відкривається по Ctrl+K
- [ ] Dark theme за замовчуванням
- [ ] Усі UI labels через i18n (t() helper)
- [ ] `pnpm build && pnpm lint && pnpm typecheck` — green

---

## Модуль 6: Дерево метаданих (ліва панель)

### Вимоги
- [ ] Реалізувати дерево через `react-arborist`
- [ ] Фіксовані кореневі розділи (не видаляються, не переміщуються):
  - Довідники (BookOpen) — Catalogs
  - Документи (FileText) — Documents
  - Перелічення (List) — Enumerations
  - Регістри відомостей (Database) — InformationRegisters
  - Регістри накопичення (BarChart3) — AccumulationRegisters
  - Константи (Settings) — Constants
  - Довільні таблиці (Table) — CustomTables
- [ ] Badge з кількістю обʼєктів біля назви кожного розділу
- [ ] Іконка типу для кожного обʼєкта всередині розділу
- [ ] Контекстне меню (правий клік) на обʼєкті:
  - Додати (Insert / Ctrl+N) — з автоматичним ім'ям NewCatalog1, NewDocument1 тощо
  - Перейменувати (F2) — inline rename з валідацією PascalCase
  - Дублювати — глибока копія з суфіксом Copy
  - Видалити (Delete) — з діалогом підтвердження і перевіркою вхідних посилань
  - Де використовується — показати список вхідних посилань (реалізація action у Модулі 9, пункт меню додати зараз)
- [ ] Контекстне меню на розділі:
  - Додати новий обʼєкт цього типу
- [ ] Вибір обʼєкта у дереві → оновлення centralPanel і propertiesPanel
- [ ] Інкрементний пошук: Ctrl+F → поле пошуку вгорі панелі, фільтрація дерева
- [ ] Keyboard navigation: стрілки, Enter для розгортання/згортання, Space для вибору

### Рекомендовані патерни

#### Дерево читає з metadata store, пише через actions
Дерево — read view metadata store + dispatch actions (createObject, deleteObject, renameObject). Дерево не тримає власну копію даних.

#### Валідація імен при rename
Використовувати regex з core (`/^[A-Z][A-Za-z0-9]*$/`) + перевірку reserved words + унікальність серед обʼєктів цього типу.

### Антипатерни

#### ❌ Локальний state для даних дерева
Дані беруться тільки зі store. Локальний state — тільки для UI: which node is being renamed, search query, expanded nodes.

#### ❌ Видалення без перевірки посилань
Перед видаленням обʼєкта — знайти всі вхідні посилання (ref, recorderTypes, owners, registerMovements, allowedTypes). Показати діалог.

### Тести
- [ ] Дерево рендерить 7 фіксованих розділів
- [ ] Контекстне меню відкривається на об'єкті і на розділі
- [ ] Створення об'єкта додає його у відповідний розділ
- [ ] Rename з невалідним ім'ям (не PascalCase) — відхиляється

### Definition of Done
- [ ] 7 розділів з іконками рендеряться
- [ ] CRUD обʼєктів працює через контекстне меню
- [ ] Inline rename з валідацією
- [ ] Видалення з перевіркою посилань
- [ ] «Де використовується» у контекстному меню
- [ ] Пошук фільтрує дерево
- [ ] Keyboard navigation працює
- [ ] Badge з кількістю обʼєктів
- [ ] Усі labels через i18n
- [ ] `pnpm lint && pnpm typecheck` — green

---

## Модуль 7: Центральний редактор

### Вимоги
- [ ] Заголовок: імʼя обʼєкта (editable), badge типу, displayName
- [ ] Вкладки (залежно від типу):
  - **Реквізити** (Catalog, Document, CustomTable) — таблиця полів
  - **Табличні частини** (Catalog, Document) — список табличних частин → при виборі — таблиця їх реквізитів
  - **Значення** (Enumeration) — таблиця значень (name, displayName, order)
  - **Виміри / Ресурси / Реквізити** (InformationRegister, AccumulationRegister) — три окремі секції
  - **Налаштування** — специфічні для типу параметри
- [ ] Таблиця реквізитів через `@tanstack/react-table`:
  - Колонки: Імʼя, Тип, Обовʼязковий (checkbox), Індексований (checkbox), Опис
  - Стандартні реквізити — readonly рядки вгорі таблиці, візуально відокремлені (іконка замка, приглушений фон)
  - Стандартні реквізити беруться з `getStandardAttributes()` з core
  - Кнопки: Додати поле, Видалити вибране поле, Вгору, Вниз (зміна порядку)
- [ ] Inline editing для імені поля та типу
- [ ] Вибір типу поля з категоризованого dropdown: Примітивні / Посилальні / Перелічення
- [ ] Для посилальних типів — вибір цільового обʼєкта з dropdown (фільтрований за kind)
- [ ] Для регістрів — візуальне розділення Dimensions / Resources / Attributes (окремі секції або кольорові маркери)
- [ ] Вкладка "Значення" для Enumeration:
  - Таблиця: name (PascalCase), displayName {uk, en}, order
  - Кнопки: Додати, Видалити, Вгору, Вниз
- [ ] Empty state для кожної вкладки з підказкою що робити
- [ ] Вкладка "Налаштування" (Constant):
  - Відображати valueType і defaultValue як форму, а не таблицю

### Рекомендовані патерни

#### Стандартні реквізити — derived data
Не зберігати їх у store. Обчислювати через `getStandardAttributes(kind, settings)` при кожному рендері. Це забезпечує актуальність при зміні налаштувань типу.

#### Editor реагує на selectedObject з UI store
Один компонент `ObjectEditor`, який рендерить правильний набір вкладок залежно від `kind` вибраного обʼєкта.

### Антипатерни

#### ❌ Окремі editor-и під кожен тип
Не створювати `CatalogEditor`, `DocumentEditor`, `RegisterEditor` як окремі компоненти. Один `ObjectEditor` з conditional tabs — менше дублювання, єдина point of change.

#### ❌ Редагування стандартних реквізитів
Стандартні реквізити — readonly завжди. Їх набір змінюється тільки через налаштування типу (наприклад, включення ієрархії додає parent_id).

### Тести
- [ ] Editor показує правильний набір вкладок для Catalog, Document, Enumeration, InformationRegister, AccumulationRegister, Constant, CustomTable
- [ ] Стандартні реквізити рендеряться readonly (не можна редагувати чи видалити)
- [ ] Додавання атрибута через кнопку — з'являється у таблиці
- [ ] Вибір типу CatalogRef показує dropdown з наявними довідниками

### Definition of Done
- [ ] Editor показує правильні вкладки для кожного типу
- [ ] Стандартні реквізити відображаються readonly
- [ ] CRUD атрибутів працює
- [ ] CRUD табличних частин працює
- [ ] CRUD значень enum працює
- [ ] Dimensions/Resources/Attributes для регістрів розділені
- [ ] Тип поля обирається з dropdown
- [ ] Посилальні типи мають вибір цільового обʼєкта
- [ ] Зміна порядку полів працює
- [ ] Усі labels через i18n
- [ ] `pnpm lint && pnpm typecheck` — green

---

## Модуль 8: Панель властивостей (права панель)

### Вимоги
- [ ] Context-sensitive: контент залежить від вибраного елементу
- [ ] Коли вибрано обʼєкт у дереві:
  - Група "Основні": name (readonly), displayName {uk, en}
  - Група "Налаштування типу" — специфічна для кожного типу:
    - Catalog: codeLength, codeType, descriptionLength, hierarchyType, owners, autonumber, codeUnique, mainPresentation, predefinedItems
    - Document: numberLength, numberType, autonumber, numberPeriodicity, posting, registerMovements
    - AccumulationRegister: registerType, recorderTypes
    - InformationRegister: periodicity, writeMode, recorderTypes
    - CustomTable: autoAddPrimaryKey
    - Enumeration: (немає додаткових налаштувань)
    - Constant: valueType, defaultValue
- [ ] Коли вибрано поле у таблиці:
  - Група "Основні": name, displayName
  - Група "Тип даних": type, length, precision, scale, ref, allowedTypes
  - Група "Обмеження": required, indexed, unique, defaultValue
  - Група "Додатково": description
- [ ] Групи через shadcn/ui Accordion (collapsible)
- [ ] Зміна налаштувань типу (наприклад, hierarchyType) одразу впливає на стандартні реквізити в editor
- [ ] Для посилальних полів owners/recorderTypes/registerMovements — multi-select з наявних обʼєктів
- [ ] **Project Settings view** (FR-004): коли нічого не вибрано або вибрано кореневий вузол дерева — показувати форму:
  - Project name, displayName
  - Database: target (postgresql), schema, namingConvention
  - Generation: tablePrefix, enumStrategy, constantsStrategy

### Рекомендовані патерни

#### Форми читають з store, пишуть через actions
Кожне поле форми — controlled компонент, значення з store, onChange → dispatch action. Не тримати проміжний form state.

#### Зміна налаштувань типу = мутація в metadata store
Коли hierarchyType змінюється з None на FoldersAndItems — store оновлює обʼєкт, editor автоматично перерендерить стандартні реквізити.

### Антипатерни

#### ❌ Form state окремо від store
Не тримати локальний form state і "синхронізувати" його зі store. Store — єдине джерело правди, forms — view на нього.

#### ❌ Редагування name обʼєкта в properties
Name обʼєкта змінюється тільки через rename в дереві (F2), а не в панелі властивостей. У properties name відображається readonly.

### Тести
- [ ] Properties panel показує поля об'єкта при виборі в дереві
- [ ] Properties panel показує поля атрибута при виборі в таблиці
- [ ] Зміна hierarchyType з None на FoldersAndItems — parent_id з'являється у стандартних реквізитах editor
- [ ] Project Settings відображається коли нічого не вибрано

### Definition of Done
- [ ] Властивості обʼєкта показуються при виборі в дереві
- [ ] Властивості поля показуються при виборі в таблиці
- [ ] Project Settings view працює (FR-004)
- [ ] Accordion-групи працюють
- [ ] Зміна налаштувань типу одразу відображається в editor
- [ ] Multi-select для owners/recorderTypes працює
- [ ] Панель collapsible
- [ ] Усі labels через i18n
- [ ] `pnpm lint && pnpm typecheck` — green

---

## Модуль 9: Валідація, References та Productivity

### Вимоги
- [ ] Реалтайм-валідація:
  - Зміни перевіряються через Zod-схеми core
  - Помилки відображаються inline біля відповідного поля
  - Загальна кількість помилок — у status bar
- [ ] Referential integrity:
  - При видаленні обʼєкта — показати список вхідних посилань (FR-051, FR-052)
  - "Де використовується" — через контекстне меню або окремий action
  - Пошук по всіх ref, allowedTypes, owners, recorderTypes, registerMovements
- [ ] Валідація цілісності проєкту:
  - Усі reference targets існують (FR-050)
  - Імена унікальні в межах типу
  - Обовʼязкові поля заповнені
- [ ] Command Palette розширити:
  - Quick navigation до обʼєкта по назві
  - Recently used commands
- [ ] Accessibility:
  - ARIA-атрибути для дерева (role="tree", role="treeitem")
  - ARIA-атрибути для таблиці (role="grid")
  - Focus indicators на всіх інтерактивних елементах
  - Semantic HTML

### Рекомендовані патерни

#### Project-level validation як derived selector
Одна функція `validateProject(model: ProjectModel): ValidationResult[]` у core. UI підписується на результат через selector з metadata store.

#### Вхідні посилання як on-demand computation
Не тримати граф посилань у store. Обчислювати `findIncomingReferences(kind, name, project)` при запиті — проєкт до 200 обʼєктів, це миттєво.

### Антипатерни

#### ❌ Валідація тільки при save
Валідація має бути реалтаймовою. Користувач має бачити проблеми одразу, а не при спробі зберегти.

#### ❌ Блокування UI при валідації
Для проєктів до 200 обʼєктів Zod-валідація працює синхронно і швидко. Не ускладнювати async workers.

### Definition of Done
- [ ] Validation errors показуються inline і в status bar
- [ ] "Де використовується" працює для кожного обʼєкта
- [ ] Видалення з діалогом вхідних посилань
- [ ] Command Palette навігація по обʼєктах
- [ ] ARIA-атрибути на дереві, таблиці
- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` — green для всіх пакетів

---

## Загальні архітектурні рішення

```
apps/web/src/
├── App.tsx                          — app shell, layout, providers
├── components/
│   ├── top-bar.tsx                  — заголовок, кнопки, project name
│   ├── status-bar.tsx               — валідація, кількість, dirty state
│   ├── metadata-tree/               — ліва панель
│   │   ├── metadata-tree.tsx
│   │   ├── tree-node.tsx
│   │   └── tree-context-menu.tsx
│   ├── object-editor/               — центральна панель
│   │   ├── object-editor.tsx
│   │   ├── attributes-table.tsx
│   │   ├── tabular-sections.tsx
│   │   ├── enum-values.tsx
│   │   ├── register-fields.tsx
│   │   └── type-settings.tsx
│   ├── properties-panel/            — права панель
│   │   ├── properties-panel.tsx
│   │   ├── object-properties.tsx
│   │   └── attribute-properties.tsx
│   ├── command-palette.tsx
│   └── theme-provider.tsx           — (вже існує)
├── stores/
│   ├── metadata-store.ts
│   ├── ui-store.ts
│   └── project-store.ts
├── storage/
│   ├── storage-provider.ts          — інтерфейс
│   └── web-storage.ts               — File System Access API + fallback
├── hooks/
│   ├── use-hotkeys.ts
│   └── use-validation.ts
└── lib/
    └── utils.ts                     — (вже існує)
```

## Пов'язана документація
- `docs/architecture/OVERVIEW.md` — загальна архітектура монорепо
- `docs/BRD-metadata-configurator.md` §5.1–§5.10 — специфікація типів метаданих
- `docs/BRD-metadata-configurator.md` §6 — система типів полів
- `docs/BRD-metadata-configurator.md` §7 — формат JSON та canonical serialization
- `docs/BRD-metadata-configurator.md` §8 — функціональні вимоги MVP (FR-001 — FR-093)
- `docs/BRD-metadata-configurator.md` §9 — UI Layout, Tech Stack, Keyboard shortcuts
- `docs/BRD-metadata-configurator.md` §12 — Phase 1 scope
- `.github/instructions/architecture-core.instructions.md` — архітектурні правила
- `.github/instructions/metadata-model.instructions.md` — правила роботи зі схемами core
- `.github/instructions/ui-architecture.instructions.md` — правила побудови UI
- `.github/instructions/coding-style.instructions.md` — стиль коду, naming conventions
- `.github/instructions/tooling.instructions.md` — команди збірки, тестування, CI

## Загальний Definition of Done для Phase 1
- [ ] Можна створити новий проєкт
- [ ] Можна налаштувати параметри проєкту (FR-004)
- [ ] Можна додати обʼєкт кожного з 7 типів
- [ ] Стандартні реквізити відображаються автоматично для кожного типу
- [ ] Можна додавати/редагувати/видаляти користувацькі поля
- [ ] Можна додавати/редагувати/видаляти табличні частини
- [ ] Можна додавати/редагувати/видаляти значення перелічень
- [ ] Регістри мають ролі полів (dimension/resource/attribute)
- [ ] Зміна налаштувань типу впливає на стандартні реквізити
- [ ] Проєкт зберігається/відкривається як canonical JSON
- [ ] Undo/Redo працює для всіх мутацій
- [ ] Command Palette і keyboard shortcuts працюють
- [ ] Validation errors показуються реалтаймово
- [ ] Referential integrity перевіряється при видаленні
- [ ] Dark theme за замовчуванням
- [ ] Інтерфейс українською за замовчуванням, підтримка англійської (FR-090, FR-091)
- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` — green
- [ ] Формат JSON стабільний для Git (byte-identical при однакових даних)

## NFR Acceptance Criteria (BRD §11.1)
- [ ] Smoke test: створити 50 об'єктів з 10 атрибутами кожен — UI responsive
- [ ] Дерево метаданих — розгортання/згортання < 16ms
- [ ] Збереження проєкту < 1 секунда
