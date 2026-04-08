# Task: Selection Flow, View State та Validation UX — комплексне рішення

## Контекст

Ця задача замінює `docs/phase1-known-limitations.md` і об'єднує три пов'язані проблеми UI-рівня, що разом стосуються однієї архітектурної зони — **selection model і view state management** в `apps/web`.

Два з трьох пунктів (`phase1-known-limitations.md` §1 View State, §2 Validation UX) залишилися актуальними. Третя проблема — нова: feedback loop при виборі field/tabularSection у tree. Закриті пункти (Standard Attributes для Tabular Sections, Constant valueType: Ref) повністю реалізовані в поточній кодовій базі й не потребують подальших дій.

Рішення мають бути **комплексними**: не мінімальний патч, а повноцінна архітектурна переробка selection/view state моделі, навіть якщо це потребує значного рефакторингу.

## Вимоги

### Етап A: Per-Context View State Model

- [ ] Розширити `TabItem` і `FloatingWindow` в `ui-store.ts` полем `viewState` для збереження per-tab/per-window selection context
- [ ] `viewState` має містити: `selectedRow?: string`, `selectedFieldName?: string`, `selectedTabularSectionName?: string`
- [ ] `viewState` — runtime-only, НЕ persist-ити між сесіями (не додавати до Zustand persist partialize)
- [ ] `detachTab` і `attachWindow` мають переносити `viewState` між tab і floating window (аналогічно `activeSection`)
- [ ] Замінити глобальний `selectedField` і `selectedTabularSection` в ui-store на derived getters, що читають з viewState активного tab/window
- [ ] Зберегти `selectedObject` як глобальний anchor для properties panel priority chain
- [ ] При перемиканні tabs/windows — зчитувати viewState з нового активного контексту замість обнуління

### Етап B: Tree ↔ Selection Synchronization

- [ ] Виправити feedback loop в `tree-panel.tsx`: useEffect синхронізації `selectedNodeId` має враховувати всі три рівні selection (field → tabularSection → object)
- [ ] Додати ref-guard (`isHandlingTreeSelect`) щоб useEffect не перезаписував `selectedNodeId` одразу після programmatic зміни selection в тому ж render-циклі react-arborist
- [ ] При кліку на field node в tree: properties panel має одразу показати `FieldProperties`
- [ ] При кліку на tabularSection node в tree: properties panel має одразу показати `TabularSectionProperties`
- [ ] При кліку на field в tabular section (вкладений field node): properties panel має показати `FieldProperties` з правильним `tabularSectionName`
- [ ] `handleSelect` не має викликати `selectObject` перед `selectField` — замінити на єдиний atomic action, що ставить і selectedObject, і field/section одночасно без проміжного обнуління
- [ ] `handleActivate` (double-click / Enter) має відкривати tab І зберігати field/section selection — openTab не повинен знищувати deep selection

### Етап C: Controlled Selection у Editor Tables

- [ ] `AttributeTable` має приймати `selectedRow` як controlled prop замість внутрішнього `useState`
- [ ] `AttributeTable` при кліку по row має викликати callback `onSelectRow(fieldName)`, що пише в viewState активного tab/window
- [ ] `EnumValuesEditor` має приймати `selectedRow` як controlled prop за тим самим контрактом
- [ ] Для register tables (dimensions, resources, attributes) — той самий `AttributeTable`, та сама зміна
- [ ] Для tabular section attributes — той самий `AttributeTable`, та сама зміна
- [ ] `TabularSectionsEditor` — перевірити, чи потрібен controlled `expandedSections` для per-tab persistence (secondary, але перевірити)
- [ ] `MovementsSection` — перевірити `selectedRegisterRef` на ту саму проблему (secondary)
- [ ] При видаленні field/row — оновити viewState (скинути selectedRow), не лише локальний state

### Етап D: Validation Panel та навігація

- [ ] Додати `ValidationPanelState` в `ui-store`: `validationPanelOpen: boolean`, `selectedFindingIndex?: number`
- [ ] Реалізувати normalized findings selector (hook або memoized selector) поверх `metadata-store`:
  - зведення `validationErrors + modelErrors` у плоский `Finding[]`
  - дедуплікація за `path:message` в межах об'єкта
  - кожен `Finding` має поля: `objectRef: MetadataRef`, `path: string`, `message: string`, `source: 'mutation' | 'model'`, `severity: 'error' | 'warning'`
- [ ] Розширити `ValidationError` в `metadata-store` полем `severity: 'error' | 'warning'` (по всьому ланцюгу: metadata-store → use-model-validation → consumers)
- [ ] У `use-model-validation.ts` класифікувати перевірку "validations-without-movements" як `severity: 'warning'`, решту як `severity: 'error'`
- [ ] Status bar: зробити error count клікабельним — toggle validation panel
- [ ] Status bar: показувати errors і warnings окремими лічильниками (errors → destructive, warnings → amber)
- [ ] Validation panel (нижня панель або drawer):
  - список findings, згрупованих по object key
  - для кожного finding: severity icon, object name, path, message
  - click по finding → `selectObject` + `openTab` + `selectField` (якщо finding має field path)
  - keyboard navigation: arrow keys, Enter для jump-to
- [ ] Command palette: додати команду "Show Validation Errors" та "Go to Next Error"
- [ ] Existing consumers (`object-properties.tsx`, `field-properties.tsx`, `status-bar.tsx`): рефакторити на єдиний normalized findings selector замість трьох окремих merge+dedup логік

### Етап E: openTab без знищення selection

- [ ] `openTab` в `ui-store.ts` не повинен обнуляти `selectedField` і `selectedTabularSection` якщо objectRef збігається з поточним selection
- [ ] `setActiveTab` — аналогічно: якщо об'єкт того ж tab має viewState з field selection, він має відновитися, а не обнулитися
- [ ] `focusWindow` — аналогічно: не обнуляти deep selection при фокусі на window з тим самим об'єктом

## Clarify (питання перед імплементацією)

- [ ] **viewState у TabItem vs окремий Map**
  - Чому це важливо: per-tab viewState можна тримати inline в TabItem або в окремому `Record<tabId, ViewState>` поза масивом tabs
  - Варіанти: inline (простіше, той самий патерн що activeSection) / окремий Map (менше mutations на масиві tabs)
  - Вплив на рішення: архітектура store, immer performance

- [ ] **selectedField як derived vs separate**
  - Чому це важливо: якщо selectedField стає derived getter від active tab/window viewState, усі поточні consumers `useUiStore(s => s.selectedField)` мають продовжити працювати без зміни API
  - Варіанти: derived getter поверх viewState (backward-compatible) / breaking change з explicit `useActiveViewState()` hook
  - Вплив на рішення: обсяг змін у consumers, backward compatibility

- [ ] **Validation panel layout**
  - Чому це важливо: bottom panel (як Problems у VS Code) потребує зміни layout системи (додаткова resizable area), drawer — менше layout змін
  - Варіанти: bottom panel з react-resizable-panels / sheet/drawer з shadcn/ui / окремий tab в центральній панелі
  - Вплив на рішення: UI layout, shell composition, z-index система

- [ ] **Path-to-selection mapping для finding navigation**
  - Чому це важливо: при кліку на finding треба парсити `path` (наприклад `attributes.client.ref`) і перетворювати на `selectField({ objectRef, fieldName: 'client' })`
  - Варіанти: regex parser для відомих path patterns / structured finding target model від початку
  - Вплив на рішення: складність navigation, extensibility для нових перевірок

## Рекомендовані патерни

### Per-Context View State (аналогічно activeSection)
viewState має зберігатися per-tab/per-window і переноситися при detach/attach — це той самий proof-of-concept патерн, що `activeSection` вже робить успішно. Різниця лише в ширині збережених полів.

### Atomic Selection Actions
Замість послідовних `selectObject` → `selectField` (де перший обнуляє результат другого), ввести atomic actions що встановлюють весь selection context одним `set()` викликом. Це ключовий фікс для feedback loop.

### Normalized Findings Selector
Єдиний hook/selector що зводить `validationErrors + modelErrors` у плоский `Finding[]` з дедуплікацією. Усі UI consumers (status bar, properties, validation panel) мають використовувати його замість три окремих merge логік.

### Controlled Table Selection
Editor tables (`AttributeTable`, `EnumValuesEditor`) мають працювати як controlled components: приймати `selectedRow` і `onSelectRow` як props, делегуючи persistence в per-tab/per-window viewState через store.

### ref-guard для Tree<->Store Sync
Використати `useRef` прапорець в tree-panel, щоб розрізнити user-initiated selection від programmatic (store sync) selection. react-arborist v3.4.3 не робить цього сам — він fires `onSelect` при будь-якій зміні selection prop.

## Антипатерни (уникати)

### ❌ Послідовні selectObject + selectField
Ніколи не викликати `selectObject` (що обнуляє field) перед `selectField` — це створює проміжний стан, де React може відрендерити properties panel без field context.

### ❌ Глобальний selectedField для multi-window
`selectedField` як єдиний глобальний слот не працює коли один об'єкт відкритий і в tab, і у floating window — selection одного перезаписує інший. Per-context viewState вирішує це.

### ❌ Локальний useState для persistent view state
Будь-який `useState` всередині editor components втрачається при remount (tab switch, detach/attach, conditional render). Якщо state має пережити remount — він має бути в store.

### ❌ Окремий merge+dedup validationErrors у кожному consumer
Поточний код дублює merge+dedup логіку в `status-bar.tsx`, `object-properties.tsx`, `field-properties.tsx`. Це порушує DRY і ускладнює зміну формату errors.

### ❌ Неконтрольований selection prop для react-arborist
Проп `selection` react-arborist fires `onSelect` при programmatic зміні — тому sync useEffect і handleSelect мають бути capturing-aware (через ref-guard), інакше це feedback loop.

## Архітектурні рішення

### Selection Model (до і після)

**Зараз:**
```
ui-store (global)
├── selectedObject: MetadataRef | null         ← global
├── selectedTabularSection: Selection | null   ← global, lost on tab switch
├── selectedField: FieldSelection | null       ← global, lost on tab switch
├── openTabs[].activeSection                   ← per-tab ✓
└── floatingWindows[].activeSection            ← per-window ✓
```

**Після:**
```
ui-store
├── selectedObject: MetadataRef | null         ← global anchor
├── openTabs[].viewState                       ← per-tab (field, tabSection, row)
├── floatingWindows[].viewState                ← per-window (field, tabSection, row)
├── selectedField (derived getter)             ← reads from active tab/window viewState
└── selectedTabularSection (derived getter)    ← reads from active tab/window viewState
```

### Validation Data Flow

**Зараз:**
```
use-model-validation → metadata-store.modelErrors
                        ↕
status-bar ──(own merge+dedup)──→ count
object-properties ──(own merge+dedup)──→ banner
field-properties ──(own merge+dedup)──→ field banner
```

**Після:**
```
use-model-validation → metadata-store.modelErrors (з severity)
                        ↕
useFindingsSelector ──→ Finding[] (єдиний normalized list)
    ├── status-bar ──→ count + click handler
    ├── validation-panel ──→ grouped list + navigation
    ├── object-properties ──→ per-object banner
    └── field-properties ──→ per-field banner
```

## Пов'язана документація

- `docs/architecture/state-management.md` — stores, undo/redo, dirty tracking, validation flow
- `docs/architecture/ui-components.md` — component hierarchy, tree layer, window system, properties panel
- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `.github/instructions/ui-architecture.instructions.md` — правила побудови UI
- `docs/BRD-metadata-configurator.md`, секція 9 — UI Layout

## Залежності між етапами

```
Етап A (viewState model) ──→ Етап B (tree sync)
         │                         │
         └──→ Етап C (controlled tables)
                                   │
Етап A ──→ Етап E (openTab fix) ───┘
                                   
Етап D (validation panel) — незалежний від A-C, може виконуватися паралельно
```

Рекомендований порядок: **A → B → C+E (паралельно) → D**

## Definition of Done

### Етап A
- [ ] TabItem і FloatingWindow мають viewState з selectedRow, selectedFieldName, selectedTabularSectionName
- [ ] detachTab/attachWindow переносять viewState
- [ ] selectedField і selectedTabularSection працюють як derived від active context
- [ ] Перемикання tabs/windows відновлює selection з viewState замість обнуління
- [ ] Існуючі consumers `useUiStore(s => s.selectedField)` працюють без зміни API, або свідомо мігровані

### Етап B
- [ ] Клік по field node в tree → FieldProperties одразу видно в правій панелі
- [ ] Клік по tabularSection node → TabularSectionProperties одразу видно
- [ ] Клік по field в tabular section → FieldProperties з правильним tabularSectionName
- [ ] Немає feedback loop: programmatic зміна selection prop не trigger-ить повторний handleSelect що обнуляє selection
- [ ] Tree highlight синхронізується з selectedField (field node виділений, не object node)

### Етап C
- [ ] AttributeTable — controlled selectedRow через props, не внутрішній useState
- [ ] EnumValuesEditor — controlled selectedRow через props
- [ ] Detach/attach floating window зберігає виділення рядка в таблиці
- [ ] Перемикання між tabs зберігає виділення рядка per-tab
- [ ] Видалення field/row коректно оновлює viewState

### Етап D
- [ ] Error count у status bar клікабельний — відкриває validation panel
- [ ] Validation panel показує findings з severity icons, згруповані по об'єкту
- [ ] Клік по finding → навігація до об'єкта/поля (openTab + selectField)
- [ ] Command palette має команду "Show Validation Errors"
- [ ] `ValidationError` має поле `severity`
- [ ] Warnings і errors рахуються і відображаються окремо
- [ ] Три поточні merge+dedup логіки замінені єдиним findings selector

### Етап E
- [ ] openTab для того ж об'єкта не скидає field selection
- [ ] setActiveTab не скидає deep selection якщо tab має viewState
- [ ] focusWindow не скидає deep selection
- [ ] Тести підтверджують збереження selection при tab/window transitions

### Загальне
- [ ] `pnpm lint` — без помилок
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm test` — усі тести проходять
- [ ] Існуючі тести `ui-selection-sync.test.ts` адаптовані під новий selection model
- [ ] Документація `docs/architecture/state-management.md` оновлена (viewState, derived selection, findings selector)
- [ ] Документація `docs/architecture/ui-components.md` оновлена (validation panel, controlled tables)
- [ ] `docs/phase1-known-limitations.md` видалений
