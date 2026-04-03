# Task: Editor Layer Redesign — перехід до 1С-подібного UX

## Контекст

Поточний editor layer у Simetra побудований як набір горизонтальних вкладок у центральній зоні з частковим дублюванням налаштувань між `SettingsForm` (центр) і `ObjectProperties` (права панель). Стандартні реквізити змішані з користувацькими в одній таблиці, дерево метаданих — двохрівневе (kind → object), а `activeEditorTab` глобальний замість per-object.

Мета — модернізувати editor layer до рівня UX конфігуратора 1С:Підприємство:
- Єдина універсальна картка з вертикальними вкладками
- Глибоке дерево метаданих (kind → object → attributes/tables)
- Права панель — **єдине місце** редагування властивостей
- Стандартні реквізити та індекси — через окремі діалогові вікна
- Кольорові піктограми замість текстових кнопок
- Reference picker для посилальних типів (FR-036)

**Важливо:** Ця задача — відхилення від поточного BRD §9.5 (горизонтальні вкладки) та FR-021 (стандартні реквізити inline). Перед імплементацією потрібно оновити BRD відповідними змінами через `doc-update` агента.

---

## Модуль A: Підготовка — bugfixes та BRD update

### Вимоги
- [ ] Виправити `restoreSession` без handle: читати `session.lastSavedVersion` замість хардкоду `null`. Поточний код у `project-store.ts` (branch "no handle") ставить `lastSavedVersion = null`, що робить проєкт dirty одразу після restore без реальних змін. `session-db` зберігає `lastSavedVersion` у `SessionData`, але воно ігнорується
- [ ] Виправити `find-references.ts`: порівняння `attr.ref` лише по `name` без kind — false positives. Додати перевірку `attr.type` (startsWith `CatalogRef`/`DocumentRef`/`EnumRef`) та порівняння kind target
- [ ] Виправити `deleteObject` version increment: `version++` стоїть поза умовою знаходження об'єкта — інкрементує навіть якщо об'єкт не існує
- [ ] Виправити `AttributeTable` → `selectField`: не передає `tabularSectionName` prop, хоча `TabularSectionsEditor` його прокидає. FieldProperties вже вміє з ним працювати
- [ ] Оновити BRD §9.5, §9.6, FR-021 через `doc-update` агента — зафіксувати дизайнерські рішення (вертикальні вкладки, стандартні реквізити через діалог, права панель як єдине місце редагування)

### Definition of Done
- [ ] Session restore зі збереженим проєктом БЕЗ handle — проєкт clean при reload (якщо не було змін)
- [ ] `find-references` не дає false positives при однакових name в різних kinds
- [ ] `deleteObject` з неіснуючим name не інкрементує version
- [ ] Вибір поля табличної частини в editor → права панель показує правильний контекст (з `tabularSectionName`)
- [ ] BRD оновлений і відповідає новому дизайну

---

## Модуль B: Per-object state та dirty tracking

### Вимоги
- [ ] Розширити `TabItem` у ui-store полем `activeSection: string` (замість глобального `activeEditorTab`)
- [ ] Розширити `FloatingWindow` у ui-store полем `activeSection: string`
- [ ] При відкритті нового tab — ставити `activeSection` за замовчуванням (перша доступна секція для kind)
- [ ] При переключенні між відкритими вкладками — зберігати і відновлювати `activeSection` per-tab
- [ ] Додати `objectVersions: Record<string, number>` у metadata-store — інкрементувати при кожній мутації конкретного об'єкта (ключ = `kind/name`)
- [ ] Додати `lastSavedObjectVersions: Record<string, number>` у project-store — snapshot при save
- [ ] Dirty per object = `objectVersions[id] !== lastSavedObjectVersions[id]` або object не існує в saved snapshot
- [ ] Dirty indicator (зірочка `*`) на кожній вкладці TabBar та floating window title bar

### Clarify (питання перед імплементацією)
- [ ] Чи потрібен механізм "скинути зміни одного об'єкта" (revert per object), чи тільки глобальний undo?
  - Чому це важливо: per-object dirty tracking відкриває можливість per-object revert
  - Варіанти: A) тільки глобальний undo/redo / B) per-object revert через snapshot
  - Вплив на рішення: архітектура store

### Рекомендовані патерни

#### `activeSection` per-tab
`selectObject` не повинен скидати `activeSection` — це відбувається лише при першому відкритті нового tab. При переключенні між вже відкритими вкладками значення зберігається.

#### `objectVersions` як lightweight tracking
Лічильник per-object мінімально впливає на performance. При rename — ключ мігрує разом з об'єктом. При delete — ключ видаляється.

### Антипатерни

#### ❌ JSON.stringify для dirty comparison
Порівняння серіалізованих об'єктів — O(n) на кожен render. Лічильник version — O(1).

#### ❌ Глобальний `activeEditorTab` без per-tab override
Поточний баг: якщо в tab A вибрати "Налаштування", потім переключити на tab B (той же kind) — він одразу покаже "Налаштування" замість того, де користувач був в tab B.

### Definition of Done
- [ ] Переключення між вкладками зберігає внутрішню секцію кожної вкладки
- [ ] Зірочка `*` з'являється тільки на вкладках зі зміненими об'єктами
- [ ] Після save — всі зірочки зникають
- [ ] `objectVersions` коректно обробляє rename та delete

---

## Модуль C: Вертикальні вкладки в картці об'єкта

### Вимоги
- [ ] Замінити горизонтальні shadcn `Tabs` всередині `ObjectEditor` на вертикальну навігацію (sidebar зліва від контенту)
- [ ] Вертикальні вкладки мають підтримувати довільну кількість секцій (буде рости з Phase 2+)
- [ ] Активна вкладка — візуально виділена (фон, border-left accent), всі інші — subtle
- [ ] Перелік секцій залежить від `kind` об'єкта. Мінімальний набір:
  - **Catalog**: Основні, Дані, Нумерація, Налаштування
  - **Document**: Основні, Дані, Нумерація, Рухи, Налаштування
  - **Enumeration**: Основні, Значення
  - **InformationRegister**: Основні, Дані, Налаштування
  - **AccumulationRegister**: Основні, Дані, Налаштування
  - **Constant**: Основні
  - **CustomTable**: Основні, Дані, Налаштування
- [ ] Секція "Основні" — об'єднує displayName, ключові налаштування типу (те, що зараз у ObjectProperties TypeSettings)
- [ ] Секція "Дані" — вміщує дерево/список реквізитів, табличних частин, вимірів, ресурсів (структурний вигляд)
- [ ] Інші секції — наповнюватимуться у Phase 2+ (Форми, Макети, Права тощо)
- [ ] `activeSection` зберігається per-tab (Модуль B)
- [ ] Вертикальні вкладки мають ScrollArea для випадку великої кількості

### Clarify (питання перед імплементацією)
- [ ] Який мінімальний ширині sidebar-а вертикальних вкладок? 160px? 200px?
  - Чому це важливо: впливає на доступний простір центрального контенту, особливо при floating windows
  - Варіанти: A) фіксована ширина 180px / B) resizable / C) collapsible з іконками
  - Вплив на рішення: UI/layout

### Рекомендовані патерни

#### Декларативний конфіг секцій per kind
Замість switch/case — об'єкт-конфігурація `SECTION_CONFIG: Record<MetadataKind, SectionDef[]>`. Кожна `SectionDef` = `{ id, labelKey (i18n), icon, component }`. Це дає single point of change при додаванні нових секцій або kinds.

#### shadcn/ui не має vertical tabs — кастомний компонент
Не намагатися адаптувати shadcn `Tabs` через CSS rotate. Створити простий компонент `VerticalNav` на базі `<nav>` + `<button>` з Tailwind стилями.

### Антипатерни

#### ❌ CSS hack для вертикальних shadcn Tabs
shadcn Tabs використовує Radix UI Tabs, який жорстко зав'язаний на горизонтальну модель з `role="tablist"` orientation. CSS rotate порушить accessibility і keyboard navigation.

#### ❌ Секції як children ObjectEditor замість конфігурації
Хардкод JSX з conditional rendering per kind — саме те, що є зараз і спричинило дублювання. Декларативний конфіг дозволяє уникнути цього.

### Definition of Done
- [ ] Вертикальна навігація відображається зліва від контенту в картці об'єкта
- [ ] Секції відповідають типу об'єкта
- [ ] Keyboard navigation працює (Arrow Up/Down, Enter)
- [ ] Scroll при великій кількості секцій
- [ ] Стилізація active/inactive секцій відповідає 1С-подібному UX

---

## Модуль D: Права панель — єдине місце редагування

### Вимоги
- [ ] **Видалити** `SettingsForm` (`apps/web/src/components/editor/settings-form.tsx`) повністю
- [ ] Перенести всі kind-specific налаштування (CatalogSettings, DocumentSettings, InformationRegisterSettings, AccumulationRegisterSettings, ConstantSettings, CustomTableSettings) у `ObjectProperties` правої панелі
- [ ] Центральна зона (секція "Дані") — тільки **структурний вигляд**:
  - Дерево/список реквізитів (name, type) — readonly preview
  - Список табличних частин
  - Для переліку — список значень
  - Дії: додати, видалити, перемістити (вгору/вниз)
- [ ] **Вибір елемента** в центральній зоні → права панель оновлюється з повними властивостями виділеного
- [ ] Пріоритет контексту правої панелі (зберегти поточний):
  1. `selectedField` → FieldProperties
  2. `selectedObject` → ObjectProperties
  3. activeTab/activeWindow → ObjectProperties
  4. нічого → ProjectSettings
- [ ] `FieldProperties` — додати всі поля з BRD §6.3: name, displayName, type, length, precision, scale, ref (через MetadataRefPicker — Модуль F), allowedTypes, required, indexed, unique, defaultValue, description
- [ ] `ObjectProperties` — консолідувати всі kind-specific налаштування:
  - Catalog: codeLength, codeType, descriptionLength, hierarchyType, owners, autonumber, codeUnique, mainPresentation, predefinedItems
  - Document: numberLength, numberType, autonumber, numberPeriodicity, posting, registerMovements
  - AccumulationRegister: registerType, recorderTypes
  - InformationRegister: periodicity, writeMode, recorderTypes
  - CustomTable: autoAddPrimaryKey
  - Constant: valueType, defaultValue
- [ ] Додати у ObjectProperties посилання "Стандартні реквізити" (→ Модуль G)
- [ ] Додати у ObjectProperties посилання "Додаткові індекси" (→ Модуль H)

### Рекомендовані патерни

#### Права панель = view на store, без проміжного form state
Кожне поле — controlled компонент: value зі store, onChange → dispatch action (commit-on-blur для текстових полів щоб уникнути зайвих Zod-валідацій на кожен keystroke).

#### Accordion групи — collapsible state персистити
Збережений в ui-store або localStorage стан розгорнутих/згорнутих Accordion груп правої панелі (General, DataType, Constraints, Additional). Невеликий UX-плюс, але помітний при постійній роботі.

### Антипатерни

#### ❌ Дублювання UI для одних і тих самих полів
Зараз `SettingsForm` і `ObjectProperties` — дві незалежні реалізації. Обидві викликають `updateObject`, але JSX повністю дубльований. Після рефакторингу джерело UI для будь-якого налаштування має бути рівно одне.

#### ❌ Локальний form state що "синхронізується" з store
Store — єдине джерело правди. Commit-on-blur для тексту і instant dispatch для select/checkbox/switch — єдиний патерн.

#### ❌ Редагування name об'єкта в properties панелі
Name змінюється тільки через rename в дереві (F2). В ObjectProperties — завжди readonly.

### Definition of Done
- [ ] `SettingsForm` видалений
- [ ] Всі kind-specific налаштування доступні через ObjectProperties
- [ ] Центральна зона "Дані" — тільки структурний вигляд + CRUD дії
- [ ] Вибір елемента в центрі → права панель показує його властивості
- [ ] Немає дублювання UI для одних і тих самих полів

---

## Модуль E: Глибоке дерево метаданих

### Вимоги
- [ ] Розширити `buildTreeData` для побудови глибокого дерева:
  ```
  📁 Довідники (badge: 3)
    📋 Номенклатура
      📂 Реквізити
        📄 Артикул
        📄 Вага
      📂 Табличні частини
        📂 ДодатковіРеквізити
          📄 Властивість
          📄 Значення
    📋 Контрагенти
      📂 Реквізити
        📄 ІПН
  📁 Документи (badge: 2)
    📋 Замовлення
      📂 Реквізити
      📂 Табличні частини
      📂 Рухи (registerMovements)
  📁 Регістри накопичення
    📋 ЗалишкиТоварів
      📂 Виміри
      📂 Ресурси
      📂 Реквізити
  ```
- [ ] Структурні вузли (📂 Реквізити, 📂 Табличні частини, 📂 Виміри, 📂 Ресурси) — не editable, дії через контекстне меню (Додати)
- [ ] Вузли реквізитів (📄) — кліком виділяються, відкривають FieldProperties в правій панелі
- [ ] При додаванні нового реквізиту/табличної частини — автоматично:
  - Розгорнути батьківський вузол
  - Виділити новий елемент
  - Фокус на права панель для редагування
- [ ] Контекстне меню на реквізиті в дереві: Видалити, Вгору, Вниз
- [ ] Іконки для різних типів вузлів (hugeicons):
  - Реквізити group → відповідна іконка
  - Табличні частини group → відповідна іконка
  - Виміри/Ресурси → відповідна іконка
  - Окремий реквізит → іконка залежно від типу поля (String, Numeric, Boolean, Reference, DateTime)
- [ ] Пошук (Ctrl+F) — фільтрує по всіх рівнях, включаючи імена реквізитів
- [ ] `expandedTreeNodes` — зберігати в ui-store, але використовувати react-arborist `ref` API для програмного розгортання при додаванні елементів

### Clarify (питання перед імплементацією)
- [ ] Чи показувати стандартні реквізити в дереві?
  - Чому це важливо: якщо так — дерево стає дуже великим; якщо ні — користувач не бачить повну структуру
  - Варіанти: A) не показувати (тільки через діалог) / B) показувати згорнутими під окремим вузлом "Стандартні реквізити"
  - Вплив на рішення: UI, tree data model
- [ ] Чи потрібен drag-and-drop для reorder реквізитів у дереві?
  - Чому це важливо: дублює функціональність кнопок "вгору/вниз", але може бути зручніший для великих списків
  - Варіанти: A) ні, залишити тільки arrow buttons / B) так, через react-arborist drag
  - Вплив на рішення: складність імплементації, UX

### Рекомендовані патерни

#### Efficient selectors для tree data
Не підписувати дерево на `metadata-store.model` цілком. Використовувати shallow selectors: `useMetadataStore(s => s.model.catalogs)` тощо, щоб re-render відбувався тільки при зміні конкретної колекції.

#### react-arborist ref API для програмного керування
При додаванні реквізиту: `treeRef.current?.open(parentNodeId)` + `treeRef.current?.focus(newNodeId)`. Це працює без remount і без fully-controlled open state.

#### Node ID convention для глибокого дерева
Унікальні ID для всіх рівнів: `section:{kind}`, `object:{kind}/{name}`, `group:{kind}/{name}/attributes`, `field:{kind}/{name}/attributes/{fieldName}`, `ts:{kind}/{name}/tabularSections/{sectionName}`, і так далі.

### Антипатерни

#### ❌ Повний remount дерева при кожній зміні
react-arborist virtualizes — окей для 1000+ вузлів. Але якщо `buildTreeData` повертає нові об'єкти на кожен render, дерево втратить стан (scroll position, selection). Мемоїзувати через `useMemo` / `useRef` comparison.

#### ❌ Окремий state для дерева
Дерево — read view metadata-store. Ніякого локального дублювання колекцій attributes/tabularSections. Тільки UI state (expanded, selection) — в ui-store.

### Definition of Done
- [ ] Дерево відображає 4+ рівні: kind → object → structural group → field/section
- [ ] Клік на реквізит → FieldProperties в правій панелі з правильним контекстом (включаючи tabularSectionName)
- [ ] Додавання реквізиту → батько розгортається, новий елемент виділяється
- [ ] Пошук фільтрує по всіх рівнях
- [ ] Контекстне меню на реквізиті та структурній групі
- [ ] Іконки відповідають типам вузлів

---

## Модуль F: Reference Picker (FR-036)

### Вимоги
- [ ] Створити компонент `MetadataRefPicker` — shadcn/ui Combobox (Popover + Command):
  - Фільтрація за kind відповідно до типу поля:
    - `CatalogRef` → список усіх каталогів
    - `DocumentRef` → список усіх документів
    - `EnumRef` → список усіх переліків
    - `AnyRef` → всі перелічені вище (multi-select через `AllowedTypesSelect`)
  - Вільний пошук по name
  - Можливість очистити ref (кнопка ×)
  - Validation hint якщо target не існує в поточній моделі
- [ ] Замінити plain `Input` для `ref` у `FieldProperties` на `MetadataRefPicker`
- [ ] Існуючий `RefMultiSelect` (для owners/recorderTypes/registerMovements) — уніфікувати з `MetadataRefPicker` де можливо, або залишити окремим, але з однаковим UX
- [ ] При rename цільового об'єкта — автоматичне оновлення ref у всіх полях, що посилаються на нього (вже є `renameObject` з cascade в metadata-store — перевірити що cascade працює для `attribute.ref`)
- [ ] Для `FieldTypeSelect` в центральній зоні (таблиця реквізитів) — при виборі reference type автоматично фокусувати права панель на поле `ref` для вибору target

### Рекомендовані патерни

#### Combobox з Command для пошуку
shadcn/ui Command (cmdk) всередині Popover — стандартний патерн для searchable select. Не потрібен кастомний dropdown.

#### Reactive list Available Objects
Список доступних об'єктів — derived selector з metadata-store: `useMetadataStore(s => s.model[kindKey])`. При додаванні нового каталогу — він одразу з'являється у picker для CatalogRef полів.

### Антипатерни

#### ❌ Plain text input для reference
Поточна реалізація — текстове поле для `ref`. Користувач мусить вводити точне ім'я об'єкта вручну, без валідації існування та без автодоповнення. Це основний UX gap.

#### ❌ Дублювання списків об'єктів для picker
Не хардкодити списки. Завжди брати з metadata-store через selector.

### Definition of Done
- [ ] Для CatalogRef/DocumentRef/EnumRef — dropdown з існуючими об'єктами відповідного kind
- [ ] Пошук по name працює
- [ ] Вибір target оновлює `attribute.ref`
- [ ] Неіснуючий target — validation warning
- [ ] При rename target — ref оновлюється автоматично

---

## Модуль G: Стандартні реквізити — Dialog

### Вимоги
- [ ] Видалити стандартні реквізити з таблиці реквізитів у центральній зоні. Після створення об'єкта список custom реквізитів має бути **пустим**
- [ ] Додати в ObjectProperties (права панель) кнопку-посилання **"Стандартні реквізити"** (видимо тільки для types що мають стандартні реквізити — Catalog, Document, InformationRegister, AccumulationRegister, CustomTable; для Enumeration та Constant — не показувати)
- [ ] Клік відкриває shadcn `Dialog` з:
  - Заголовок: "{TypeLabel} {ObjectName}: Стандартні реквізити"
  - Список стандартних реквізитів у вигляді таблиці: Ім'я, Тип, Опис
  - Реквізити беруть з `getStandardAttributes(kind, settings)` з `@simetra/core`
  - Усі поля readonly
  - Для реквізитів з displayName — можливість переглянути/редагувати displayName (єдине що можна міняти у стандартних реквізитах)
  - Умовні реквізити (parent_id при hierarchyType, owner_id при owners, movement_type при Balance) — автоматично з'являються/зникають при зміні відповідних налаштувань
- [ ] Стандартні реквізити табличних частин (id, line_number) — показувати в діалозі при виборі табличної частини в дереві

### Рекомендовані патерни

#### Стандартні реквізити — derived data з core
Не зберігати в store. Завжди обчислювати через `getStandardAttributes(kind, settings)`. Це гарантує актуальність при зміні налаштувань типу (hierarchyType, owners, writeMode).

### Антипатерни

#### ❌ Стандартні реквізити в загальному списку реквізитів
Зараз вони рендеряться як muted readonly рядки у верхній частині AttributeTable. Це спричиняє візуальний шум і дезорієнтує користувача (виглядає як реквізити які можна видалити, але не можна).

#### ❌ Хардкод стандартних реквізитів в UI
Джерело правди для стандартних реквізитів — тільки `@simetra/core`. Якщо зашити список у React-компоненти, кожна зміна потребуватиме оновлення і core, і UI.

### Definition of Done
- [ ] Таблиця реквізитів у центральній зоні не містить стандартних реквізитів
- [ ] Кнопка "Стандартні реквізити" є в ObjectProperties
- [ ] Діалог показує актуальний список стандартних реквізитів для поточних settings
- [ ] Зміна hierarchyType → діалог одразу показує/ховає parent_id та is_folder

---

## Модуль H: Додаткові індекси — Dialog

### Вимоги
- [ ] Додати в ObjectProperties кнопку-посилання **"Додаткові індекси"** (для всіх types крім Enumeration та Constant)
- [ ] Клік відкриває shadcn `Dialog` з:
  - Список усіх реквізитів об'єкта (включаючи стандартні) з checkbox "Індексований"
  - Можливість увімкнути/вимкнути indexed для кожного реквізиту
  - Для стандартних реквізитів — через `standardAttributeSettings` mechanism (вже є в core)
  - Для custom реквізитів — через `updateAttribute({ indexed: true/false })`
- [ ] Зберегти можливість встановлювати indexed і через FieldProperties (checkbox "Індексований" в групі "Обмеження")

### Definition of Done
- [ ] Кнопка "Додаткові індекси" є в ObjectProperties
- [ ] Діалог показує всі реквізити (standard + custom) з checkbox indexed
- [ ] Зміна indexed в діалозі синхронізується з FieldProperties і навпаки

---

## Модуль I: Кольорові піктограми замість текстових кнопок

### Вимоги
- [ ] Замінити текстові кнопки у toolbar-ах на іконки hugeicons з tooltip:
  - "Додати реквізит" → зелена іконка Add (наприклад, `AddCircleIcon` або `PlusSignIcon`)
  - "Видалити вибране" → червона іконка Delete (наприклад, `Delete02Icon`)
  - "Вгору" → нейтральна іконка Arrow Up (`ArrowUp02Icon`)
  - "Вниз" → нейтральна іконка Arrow Down (`ArrowDown02Icon`)
  - "Додати табличну частину" → зелена іконка з Table accent
- [ ] Застосувати до всіх toolbar-ів:
  - AttributeTable toolbar
  - TabularSectionsEditor toolbar
  - EnumValuesEditor toolbar
  - Нові toolbar-и в глибокому дереві (contextual)
- [ ] Кольорове кодування:
  - Зелений accent для дій додавання
  - Червоний accent для дій видалення
  - Нейтральний (muted) для переміщення/сортування
- [ ] Tooltip на кожній іконці з i18n label

### Рекомендовані патерни

#### shadcn Button variant="ghost" + icon + tooltip
Стандартний патерн: `<TooltipProvider><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon">...</Button></TooltipTrigger><TooltipContent>...</TooltipContent></Tooltip></TooltipProvider>`.

### Definition of Done
- [ ] Усі текстові кнопки toolbar-ів замінені на іконки з tooltip
- [ ] Кольорове кодування: зелений/червоний/нейтральний

---

## Модуль J: Валідація — заповнення validationErrors

### Вимоги
- [ ] При failure мутації в metadata-store — записувати помилки в `validationErrors[kind/name]`
- [ ] При success мутації — очищати `validationErrors[kind/name]` для цього об'єкта
- [ ] `errorCount` у status bar — тепер показує реальну кількість помилок
- [ ] Inline відображення помилок у правій панелі біля відповідних полів
- [ ] Додати project-level validation як debounced selector:
  - Усі reference targets існують (FR-050)
  - Імена унікальні в межах типу
  - Обов'язкові поля заповнені

### Рекомендовані патерни

#### Validation через Zod issues → field path mapping
Zod `.safeParse()` повертає `ZodError` з `issues[].path`. Маппити path у конкретне поле для inline display: `["attributes", 0, "name"]` → "attributes[0].name".

### Антипатерни

#### ❌ Валідація тільки при save
BRD: валідація має бути реалтаймовою. Користувач бачить проблеми одразу.

#### ❌ validationErrors як write-only
Поточна ситуація: errors ніде не пишуться, більше не повинна повторюватися.

### Definition of Done
- [ ] `validationErrors` в store заповнюється при кожній мутації
- [ ] Status bar показує реальний errorCount
- [ ] Inline помилки відображаються в правій панелі

---

## Архітектурні рішення

### Цільовий layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  [Logo] Simetra │ Збережений проект *  │ 🔧 💾 📥 📤 ↩ ↪ │ Top Bar │
├──────────┬──────┬────────────────────────┬──────────────────────────┤
│          │      │  Tab Bar: [Obj1*] [Obj2]                         │
│  Глибоке │ Верт.├────────────────────────┤   Властивості            │
│  дерево  │ вкл. │                        │   (ЄДИНЕ місце           │
│  мета-   │      │   Контент активної     │    редагування)          │
│  даних   │ Осн. │   секції               │                          │
│          │ Дані │                        │   [Стандартні реквізити]  │
│  Kind    │ Нум. │   (структурний вигляд  │   [Додаткові індекси]    │
│   └Obj   │ Рухи │    + CRUD дії)         │                          │
│     └Attr│ Нал. │                        │                          │
│     └TS  │      │                        │                          │
├──────────┴──────┴────────────────────────┴──────────────────────────┤
│  сіметра │ 7 об'єктів │ Без помилок │ 1 вкладка                    │
└──────────────────────────────────────────────────────────────────────┘
```

### Потік вибору та синхронізації

```
Клік у дереві (kind/object) → selectedObject → ObjectProperties у правій панелі
Клік у дереві (field) → selectedField (з tabularSectionName) → FieldProperties у правій панелі
Клік у центральній зоні (рядок таблиці) → selectedField → FieldProperties у правій панелі
Переключення вкладки TabBar → activeTab → selectedObject → ObjectProperties (або збережений selectedField)
```

### State stores — зміни

```
metadata-store (існуючий, розширити):
  + objectVersions: Record<string, number>  // per-object dirty tracking

ui-store (існуючий, змінити):
  - activeEditorTab (видалити)
  + TabItem.activeSection: string           // per-tab inner section
  + FloatingWindow.activeSection: string    // per-window inner section

project-store (існуючий, розширити):
  + lastSavedObjectVersions: Record<string, number>

Нічого нового не створювати — тільки розширити існуючі stores.
```

### Порядок імплементації модулів

```
A (bugfixes)  →  B (per-object state)  →  C (vertical tabs)
                                          ↓
              D (права панель)  ←──────── C
              ↓
              E (глибоке дерево)
              ↓
              F (ref picker)  +  G (standard attrs dialog)  +  H (indexes dialog)
              ↓
              I (іконки)  +  J (validation)
```

Модулі F, G, H можуть виконуватися паралельно після D.
Модулі I, J можуть виконуватися паралельно останніми.

## Антипатерни (загальні для всієї задачі)

### ❌ UI state в metadata store
Selections, expanded tree nodes, active section — це не метадані. Якщо вони потраплять у undo-стек, Ctrl+Z почне "скакати" по вкладках замість відміни реальних змін.

### ❌ Мутація state напряму
Тільки через immer produce. Ніяких `state.objects.push(...)` поза immer-контекстом.

### ❌ Дублювання Zod-типів в UI
Імпортувати з `@simetra/core`. Ніяких локальних type redefinitions.

### ❌ React/Node.js залежності в packages/core
`@simetra/core` — чистий TS + Zod. Без React, без Node.js API.

### ❌ Кастомні UI-примітиви замість shadcn/ui
Використовувати компоненти з `@workspace/ui`. Єдиний виняток — `VerticalNav`, якого немає в shadcn.

### ❌ Hardcoded strings замість i18n
Усі UI labels — через `t('key')`. Нові ключі додавати в `uk.json` та `en.json`.

## Пов'язана документація
- `docs/architecture/OVERVIEW.md` — загальна архітектура монорепо
- `docs/BRD-metadata-configurator.md` §5.1–§5.10 — специфікація типів метаданих
- `docs/BRD-metadata-configurator.md` §6 — система типів полів
- `docs/BRD-metadata-configurator.md` §7 — формат JSON
- `docs/BRD-metadata-configurator.md` §8 — функціональні вимоги (FR-021, FR-035, FR-036, FR-050–FR-052)
- `docs/BRD-metadata-configurator.md` §9 — UI Layout
- `docs/tasks/phase1-foundation.md` — Phase 1 план (модулі 7–9 — невиконані пункти)
- `.github/instructions/architecture-core.instructions.md` — архітектурні правила
- `.github/instructions/metadata-model.instructions.md` — правила Zod-схем
- `.github/instructions/ui-architecture.instructions.md` — правила UI
- `.github/instructions/coding-style.instructions.md` — стиль коду
- `packages/core/src/schemas/standard-attributes.ts` — `getStandardAttributes()`

## Definition of Done (загальний)
- [ ] Вертикальні вкладки в картці об'єкта (per-kind конфіг)
- [ ] Глибоке дерево з 4+ рівнями (kind → object → structural group → field)
- [ ] Права панель — єдине місце редагування (SettingsForm видалений)
- [ ] Стандартні реквізити — через Dialog, не в таблиці
- [ ] Додаткові індекси — через Dialog
- [ ] Reference picker для посилальних типів (FR-036)
- [ ] Per-tab dirty indicator (зірочка `*`)
- [ ] Кольорові іконки замість текстових кнопок
- [ ] validationErrors заповнюється і відображається
- [ ] Session restore — коректний dirty state
- [ ] `tabularSectionName` передається в selectField
- [ ] `find-references` — kind-aware
- [ ] BRD оновлений
- [ ] Усі labels через i18n
- [ ] `pnpm lint && pnpm typecheck` — green
- [ ] `pnpm test` — green (існуючі тести не зламані)
