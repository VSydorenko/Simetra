# Patterns and Decisions

> Canonical реєстр стабільних архітектурних рішень Simetra. Цей документ
> замінює архітектурний зміст кількох історичних phase-1 task-документів,
> після перенесення стабільних рішень у канонічну документацію.

## Призначення і межі

Тут фіксуються лише рішення й патерни, підтверджені кодом або вже прийняті як
архітектурний контракт поточного репозиторію. Цей файл не дублює деталі схем,
state slices чи storage flows з тематичних документів. Невиконані або частково
закриті пункти описуються в документах про обмеження та backlog, а не тут.

## ADR-001: Unified Ref model замість kind-specific ref types

- Статус: прийнято
- Контекст: історична модель з окремими `CatalogRef`/`DocumentRef`/`EnumRef`
  дублювала маппінги між `type` і target kind у core та UI. Водночас інші
  міжоб'єктні зв'язки вже використовували структурований `MetadataRef`.
- Рішення: для атрибутів використовується один тип `Ref`, а target
  описується через `ref: { kind, name }` або `allowedTypes: MetadataRef[]`.
  `ref` і `allowedTypes` трактуються як взаємовиключні режими одного
  посилального типу.
- Наслідки: core є єдиним джерелом truth для reference model. UI не вводить
  власні ref-type enum'и та не відновлює kind з префіксів типу.
- Джерела:
  [../../packages/core/src/schemas/metadata-ref.ts](../../packages/core/src/schemas/metadata-ref.ts),
  [../../packages/core/src/schemas/attribute.ts](../../packages/core/src/schemas/attribute.ts),
  [./metadata-model.md](./metadata-model.md),
  [../BRD-metadata-configurator.md](../BRD-metadata-configurator.md)

## ADR-002: parent_id є структурним UUID, а не reference

- Статус: прийнято
- Контекст: ієрархія каталогів потребує structural parent link, але
  моделювання `parent_id` як self-reference змішувало структуру дерева з
  міжоб'єктними бізнес-посиланнями.
- Рішення: `parent_id` визначається як `UUID` стандартного реквізиту ієрархії
  без `ref` або `allowedTypes`.
- Наслідки: traversal ієрархії не проходить через reference infrastructure, а
  UI не повинен показувати `parent_id` як configurable Ref target.
- Джерела:
  [../../packages/core/src/schemas/standard-attributes.ts](../../packages/core/src/schemas/standard-attributes.ts),
  [./metadata-model.md](./metadata-model.md),
  [../BRD-metadata-configurator.md](../BRD-metadata-configurator.md)

## ADR-003: Vertical nav замість horizontal tabs усередині ObjectEditor

- Статус: прийнято
- Контекст: секції картки об'єкта мають IDE-подібний характер і не повинні
  конкурувати з верхнім рівнем вкладок/вікон. Горизонтальні tabs усередині
  editor layer перевантажували центральну панель.
- Рішення: перемикання секцій об'єкта виконується через ліву вертикальну
  навігацію всередині `ObjectEditor`.
- Наслідки: tab bar і floating windows відповідають за навігацію між
  об'єктами, а vertical nav відповідає за навігацію всередині одного об'єкта.
- Джерела:
  [../../apps/web/src/components/editor/object-editor.tsx](../../apps/web/src/components/editor/object-editor.tsx),
  [../../apps/web/src/components/editor/vertical-nav.tsx](../../apps/web/src/components/editor/vertical-nav.tsx),
  [./ui-components.md](./ui-components.md)

## ADR-004: Properties panel є primary surface для детального редагування

- Статус: прийнято
- Контекст: попередній editor layer дублював detail-editing між центральними
  формами та правою панеллю. Це розмивало ownership властивостей об'єкта і
  поля.
- Рішення: контекстна права панель є основною поверхнею для редагування
  властивостей об'єкта, поля й налаштувань проєкту. Центральні редактори при
  цьому зберігають структурні inline-операції там, де вони природні для списку
  або таблиці, наприклад для складу атрибутів чи значень enum.
- Наслідки: нові detail forms не повинні дублювати праву панель у центрі.
  Inline editing у центральних редакторах допустимий, якщо він описує
  структуру списку, а не створює другу незалежну surface для тих самих
  властивостей.
- Джерела:
  [../../apps/web/src/components/layout/properties-panel.tsx](../../apps/web/src/components/layout/properties-panel.tsx),
  [../../apps/web/src/components/editor/attribute-table.tsx](../../apps/web/src/components/editor/attribute-table.tsx),
  [../../apps/web/src/components/editor/enum-values-editor.tsx](../../apps/web/src/components/editor/enum-values-editor.tsx),
  [./ui-components.md](./ui-components.md)

## ADR-005: DataTypeEditorDialog використовує draft state + revisionKey pattern

- Статус: прийнято
- Контекст: редагування типу поля охоплює кілька взаємопов'язаних атрибутів,
  тому live-mutation через store робила діалог нестабільним і ускладнювала
  cancel semantics.
- Рішення: модальні редактори складних конфігурацій відкриваються з локальним
  snapshot/draft state, а `revisionKey` примусово перестворює внутрішній state
  на кожне нове відкриття. Застосування змін відбувається тільки на Save.
- Наслідки: той самий патерн використовується не лише для
  `DataTypeEditorDialog`, а й для діалогів стандартних реквізитів та додаткових
  індексів. Cancel не змінює store, а повторне відкриття не підхоплює stale
  draft з попереднього mount.
- Джерела:
  [../../apps/web/src/components/editor/data-type-editor-dialog.tsx](../../apps/web/src/components/editor/data-type-editor-dialog.tsx),
  [../../apps/web/src/components/editor/standard-attributes-dialog.tsx](../../apps/web/src/components/editor/standard-attributes-dialog.tsx),
  [../../apps/web/src/components/editor/additional-indexes-dialog.tsx](../../apps/web/src/components/editor/additional-indexes-dialog.tsx),
  [./ui-components.md](./ui-components.md)

## ADR-006: Tree presentation та interaction розділяються окремими шарами

- Статус: прийнято; уніфікація впроваджена частково
- Контекст: дерево має одночасно вирішувати візуальні задачі, keyboard
  navigation, CRUD actions, drag/drop та контекстні меню. Змішування всього в
  одному renderer робить повторне використання важким.
- Рішення: presentation-only компоненти для вузлів дерева винесені в окремий
  шар, а interaction/store wiring мають бути окремою відповідальністю renderer.
  У головному metadata tree цей поділ уже існує концептуально, але основна
  interaction-логіка все ще суттєво зосереджена в `tree-nodes.tsx`.
- Наслідки: архітектура визнає split як цільовий контракт, але не стверджує
  повну міграцію головного дерева. Нові tree surfaces повинні відділяти
  presentation від store access, а документація не повинна описувати main tree
  як повністю уніфікований renderer.
- Джерела:
  [../../apps/web/src/components/layout/tree/tree-node-presentation.tsx](../../apps/web/src/components/layout/tree/tree-node-presentation.tsx),
  [../../apps/web/src/components/layout/tree/tree-nodes.tsx](../../apps/web/src/components/layout/tree/tree-nodes.tsx),
  [./ui-components.md](./ui-components.md)

## ADR-007: Session persistence для project/session state проходить через IndexedDB

- Статус: прийнято
- Контекст: стан відкритого проєкту й crash-recovery draft не можна надійно
  зберігати в `localStorage` або в `zustand persist`, бо вони містять великі
  runtime snapshots і `FileSystemDirectoryHandle`.
- Рішення: session і draft persistence зберігаються в IndexedDB. `localStorage`
  через `persist` використовується лише для стабільних UI preferences, а
  канонічним джерелом даних проєкту лишається файлова система.
- Наслідки: IndexedDB у Simetra є session/recovery layer, а не primary project
  storage. Рішення про Save/Open залишаються в storage layer і працюють через
  canonical files, не через browser cache.
- Джерела:
  [../../apps/web/src/storage/session-db.ts](../../apps/web/src/storage/session-db.ts),
  [../../apps/web/src/storage/draft-sync.ts](../../apps/web/src/storage/draft-sync.ts),
  [../../apps/web/src/stores/project-store.ts](../../apps/web/src/stores/project-store.ts),
  [../../apps/web/src/stores/ui-store.ts](../../apps/web/src/stores/ui-store.ts),
  [./storage-and-persistence.md](./storage-and-persistence.md)

## ADR-008: Shared tree infrastructure будується навколо buildTypeEditorTree

- Статус: прийнято; використання уніфіковане частково
- Контекст: type picker не повинен будувати окрему ad hoc модель дерева,
  несумісну з рештою tree infrastructure. Водночас різні дерева мають різну
  interaction-логіку.
- Рішення: спільні node contracts і builder-підхід використовуються як база для
  tree surfaces; окремо зафіксований builder `buildTypeEditorTree` для Data
  Type Editor. Це shared infrastructure, навіть якщо renderer paths між
  sidebar tree і type editor ще не повністю зведені до одного implementation
  path.
- Наслідки: нові дерева повинні перевикористовувати node semantics, selection
  ids і builder pattern замість локальних структур. Формулювання про shared
  tree infrastructure не означає повної рендер-уніфікації всіх дерев у коді.
- Джерела:
  [../../apps/web/src/components/layout/tree/tree-builder.ts](../../apps/web/src/components/layout/tree/tree-builder.ts),
  [../../apps/web/src/components/editor/data-type-editor-dialog.tsx](../../apps/web/src/components/editor/data-type-editor-dialog.tsx),
  [./ui-components.md](./ui-components.md)

## ADR-009: Referenceable kinds походять з core, а не з UI literals

- Статус: прийнято
- Контекст: допустимі kinds для `attribute.ref` і `allowedTypes` є доменним
  правилом, а не UI-конвенцією. Локальні enum'и або масиви в web-рівні легко
  дрейфують від core-схем.
- Рішення: source of truth для referenceable kinds лишається в
  `@simetra/core` через `referenceableKindSchema`. UI може будувати похідні
  alias-структури або labels, але не перевизначає сам набір kinds.
- Наслідки: будь-яка нова логіка вибору ref targets спирається на core options,
  а не на рядкові літерали в компонентах або helper'ах web-рівня.
- Джерела:
  [../../packages/core/src/schemas/metadata-ref.ts](../../packages/core/src/schemas/metadata-ref.ts),
  [../../apps/web/src/components/layout/tree/tree-builder.ts](../../apps/web/src/components/layout/tree/tree-builder.ts),
  [./metadata-model.md](./metadata-model.md),
  [./ui-components.md](./ui-components.md)

## ADR-010: Object-scoped dirty tracking використовує objectVersions counters

- Статус: прийнято
- Контекст: dirty marker на вкладці або вікні має бути дешевим у read path і не
  вимагати глибокого порівняння кожного об'єкта на кожен render.
- Рішення: `metadata-store` тримає `objectVersions` counters на рівні
  `kind/name`, а `project-store` зберігає `lastSavedObjectVersions` як baseline
  останнього save/open/restore. Порівняння цих значень використовується для
  об'єктного dirty indication.
- Наслідки: це рішення призначене для UI-індикації змін, а не для per-object
  undo або revert. Undo/redo залишається глобальною історією доменної моделі,
  а не окремим стеком для кожного об'єкта.
- Джерела:
  [../../apps/web/src/stores/metadata-store.ts](../../apps/web/src/stores/metadata-store.ts),
  [../../apps/web/src/stores/project-store.ts](../../apps/web/src/stores/project-store.ts),
  [../../apps/web/src/hooks/use-is-dirty.ts](../../apps/web/src/hooks/use-is-dirty.ts),
  [./state-management.md](./state-management.md)

## Загальні патерни

- Commit-on-blur: локальний input draft фіксується в store при blur або явному
  commit, щоб зменшити шум від проміжних значень у доменній моделі.
- Reactive list from canonical model: таблиці та списки читають актуальні дані
  з canonical model/store, а не підтримують паралельні long-lived копії тих
  самих сутностей.
- Derived standard attributes: стандартні реквізити виводяться з виду об'єкта
  та його налаштувань, а не редагуються як звичайні persisted custom поля.
- Store preload testing: інтеграційні тести shell/store починаються з явного
  preload потрібного store state або model snapshot, щоб перевіряти поведінку,
  а не побічні ефекти ініціалізації.
- Draft-state + revisionKey: модальні редактори складних структур відкривають
  локальний draft і скидають його новим `key` на кожне відкриття.
- Per-tab/per-window activeSection: внутрішня секція editor зберігається в
  елементі вкладки або floating window, а не в одному глобальному полі.

## Антипатерни

- UI як друге source of truth: web-рівень не повинен дублювати доменні правила,
  які вже визначені в core-схемах або helper'ах.
- `parent_id` як self-reference: structural hierarchy не слід моделювати через
  той самий механізм, що й бізнес-посилання між об'єктами.
- Локальний view state там, де важлива continuity між вкладками або вікнами:
  якщо користувач очікує збереження контексту при detach/attach або switch,
  стан не повинен жити лише в локальному `useState` компонента.
- Human-readable formatting у core/reference traversal: core має повертати
  структуровані дані для посилань і traversal, а presentation string формується
  в UI.
- Перебільшення архітектурної документації щодо поточного коду: partial
  implementations треба описувати як partial, а не як повністю завершені
  уніфікації.
- IndexedDB як primary storage: browser persistence не замінює canonical files і
  не визначає save contract проєкту.

## Історична примітка

Цей документ концептуально заміщує архітектурний зміст кількох phase-1
task-документів, які раніше жили в `docs/tasks` і були прибрані після
перенесення стабільних рішень у канонічну архітектурну документацію.

Незавершені або свідомо обмежені аспекти цих тем винесені в
[../phase1-known-limitations.md](../phase1-known-limitations.md) та
[../tasks/phase1-closure-backlog.md](../tasks/phase1-closure-backlog.md), без
повторення їхніх списків робіт у цьому документі.

## Пов'язана документація

- [OVERVIEW.md](./OVERVIEW.md)
- [state-management.md](./state-management.md)
- [ui-components.md](./ui-components.md)
- [storage-and-persistence.md](./storage-and-persistence.md)
- [metadata-model.md](./metadata-model.md)
- [../BRD-metadata-configurator.md](../BRD-metadata-configurator.md)
- [../phase1-known-limitations.md](../phase1-known-limitations.md)
- [../tasks/phase1-closure-backlog.md](../tasks/phase1-closure-backlog.md)
