# Metadata Model

> Документ описує поточну архітектуру метамоделі Simetra. Фокус: межі
> моделі, інваріанти, похідні правила, serializer contract і розподіл
> валідації між core та web. Це не dump усіх схем і не заміна BRD.

## Призначення і межі

Метамодель Simetra описує бізнес-об'єкти, а не таблиці бази даних.
Канонічне представлення живе в `@simetra/core`: Zod-схеми задають форму
даних, локальні інваріанти і canonical JSON contract для збереження.
Web-рівень працює поверх цієї моделі, але не дублює її.

Поточний scope моделі обмежений проєктом і сімома колекціями метаданих:
довідники, документи, перелічення, регістри відомостей, регістри
накопичення, константи і довільні таблиці. Генерація SQL, міграції БД і
runtime-поведінка бізнес-логіки не є частиною поточного model contract.

Джерела: [../../packages/core/src/schemas/project-model.ts](../../packages/core/src/schemas/project-model.ts),
[../../packages/core/src/schemas/project.ts](../../packages/core/src/schemas/project.ts),
[../../packages/core/src/serialization.ts](../../packages/core/src/serialization.ts),
[../BRD-metadata-configurator.md](../BRD-metadata-configurator.md)

## Три шари моделі

### Поточна реалізація

| Шар | Відповідальність | Поточне джерело істини |
|---|---|---|
| Core canonical model | `ProjectModel`, metadata kinds, `FieldType`, `MetadataRef`, object schemas, local invariants | [../../packages/core/src/schemas/project-model.ts](../../packages/core/src/schemas/project-model.ts), [../../packages/core/src/schemas](../../packages/core/src/schemas) |
| Derived standard attributes and helpers | Обчислення стандартних реквізитів і helper-подань, що залежать від налаштувань об'єкта | [../../packages/core/src/schemas/standard-attributes.ts](../../packages/core/src/schemas/standard-attributes.ts) |
| Application-level validation | Debounced graph-level перевірки, reachable refs, duplicate object names після імпорту | [../../apps/web/src/hooks/use-model-validation.ts](../../apps/web/src/hooks/use-model-validation.ts), [../../apps/web/src/stores/metadata-store.ts](../../apps/web/src/stores/metadata-store.ts) |

Цей поділ принциповий:

- Core визначає, що є валідним об'єктом.
- Helper-layer обчислює похідні стандартні реквізити, але не робить їх
  частиною persisted user-defined arrays.
- Web-рівень валідовує цілісний граф проєкту і життєвий цикл редагування.

BRD описує політику моделі і бажану еволюцію. Для поточного коду пріоритет
має реалізація в core і web.

## ProjectModel як aggregate root

`ProjectModel` у поточному коді складається з двох різних площин:

- `project` з налаштуваннями проєкту;
- сім колекцій metadata objects: `catalogs`, `documents`, `enumerations`,
  `informationRegisters`, `accumulationRegisters`, `constants`,
  `customTables`;
- колекція `forms` (Phase 3) — top-level масив `FormSchema[]` з `objectRef`
  зв'язком до відповідних об'єктів.

`project` не є просто ще одним metadata object.

- Він не входить до `metadataObjectSchema` і не має `kind`-дискримінатора.
- Він містить глобальні налаштування формату і генерації:
  `schemaVersion`, `defaultLocale`, `database`, `generation`.
- Саме він визначає serializer context для `$schema` URL і canonical
  project file.
- Він не входить до `KIND_TO_KEY`, не має `kind/name` identity і не є
  ціллю `findReferences()`.

Архітектурно це означає, що `ProjectModel` є aggregate root: metadata
objects живуть усередині проєкту, а не поруч із ним як рівноправні записи.

Джерела: [../../packages/core/src/schemas/project-model.ts](../../packages/core/src/schemas/project-model.ts),
[../../packages/core/src/schemas/project.ts](../../packages/core/src/schemas/project.ts),
[../../packages/core/src/find-references.ts](../../packages/core/src/find-references.ts),
[../../packages/core/src/serialization.ts](../../packages/core/src/serialization.ts)

## Єдина reference-модель

У поточному коді немає окремих типів на кшталт `CatalogRef` або
`DocumentRef`. Reference-модель уніфікована.

- `fieldTypeSchema` є єдиним enum для примітивів і `Ref`.
- `MetadataRef` є загальним контейнером `{ kind, name }` для всіх явних
  міжоб'єктних посилань.
- Single ref для атрибута виражається як `type: "Ref"` і `ref`.
- Polymorphic ref для атрибута виражається як `type: "Ref"` і
  `allowedTypes`.

Для атрибутів core вводить додаткове звуження: `attributeRefTargetSchema`
дозволяє тільки `Catalog`, `Document` і `Enumeration`. Це і є поточна
domain-rule для `attribute.ref` і `attribute.allowedTypes`.

Object-level reference settings звужені слабше:

- `owners` у `Catalog`
- `recorderTypes` у регістрах
- `registerMovements` у `Document`

усі вони типізовані через загальний `metadataRefSchema`, тобто current core
не примушує повне kind-level narrowing для цих колекцій.

`findReferences()` у core є traversal utility, а не validator. Його scope:

- `owners`
- `recorderTypes`
- `registerMovements`
- `attribute.ref`
- `attribute.allowedTypes`
- такі самі поля всередині `dimensions`, `resources` і tabular sections

Важлива межа: traversal працює з явними persisted refs. Derived standard
attributes не обходяться як окремі custom fields.

### Posting як optional object

Починаючи з поточної версії, поле `posting` у `documentSchema` визначено як
`postingSchema.optional()`. Попередній backward-compat union
`z.union([z.boolean(), postingSchema])` видалений.

**Семантика presence/absence:**

- `doc.posting !== undefined` — документ є проведеним (має декларативний
  маппінг рухів)
- `doc.posting === undefined` — документ не створює рухів у регістрах

**Нормалізація порожнього posting:**

Store (`metadata-store`) нормалізує порожній posting object
`{ movements: [], validations: [] }` у `undefined` після операцій
`removeMovement`, `removePostingValidation` та sync-гілки `updateObject`.
Core schema продовжує приймати порожній object для parse (legacy JSON,
draft-flow), але store не дозволяє йому persist.

**Інваріант posting register refs ⊆ registerMovements:**

Кожен `posting.movements[].register` має бути оголошений у
`registerMovements`. Перевірка виконується у `use-model-validation.ts`
(model validation) та `ddl-store.ts` (pre-DDL validation).

**Вплив на findReferences:**

`findReferences()` обходить `posting.movements[].register` (reference kind
`postingMovement`) та `posting.validations[].register` (reference kind
`postingValidation`). Guard `typeof obj.posting === "object"` коректно
обробляє як наявний, так і відсутній posting.

**Зв'язок з registerMovements:**

`registerMovements` — lightweight декларація зв'язку документа з регістрами.
`posting` — повний маппінг полів. Обидва поля persisted окремо.
Автоматична синхронізація registerMovements при зміні posting не
виконується — замість цього model validation показує warning.

Джерела: [../../packages/core/src/schemas/field-type.ts](../../packages/core/src/schemas/field-type.ts),
[../../packages/core/src/schemas/metadata-ref.ts](../../packages/core/src/schemas/metadata-ref.ts),
[../../packages/core/src/schemas/attribute.ts](../../packages/core/src/schemas/attribute.ts),
[../../packages/core/src/find-references.ts](../../packages/core/src/find-references.ts)

## Стандартні реквізити як derived layer

Стандартні реквізити в Simetra не зберігаються в `attributes`, `dimensions`,
`resources` або `tabularSections[].attributes` як user-defined записи.
Вони обчислюються helper-функціями з виду об'єкта і його налаштувань.

### Поточні правила derivation

- `Catalog`: базово `id`, `code`, `description`, `deletion_mark`,
  `predefined_name`, `created_at`, `updated_at`.
- `Catalog`: `parent_id` і `is_folder` з'являються тільки якщо
  `hierarchyType !== "None"`.
- `Catalog`: `owner_id` з'являється тільки якщо `owners.length > 0`; для
  одного owner використовується `ref`, для кількох `allowedTypes`.
- `Catalog`: predefined-контекст моделюється через `predefined_name`; окремий
  boolean-прапорець `predefined` helper-layer не вводить.
- `Document`: `id`, `number`, `date`, `posted`, `deletion_mark`,
  `created_at`, `updated_at`.
- `InformationRegister`: `period` з'являється коли
  `periodicity !== "NonPeriodic"`.
- `InformationRegister`: `recorder_id`, `line_number`, `active`
  з'являються тільки коли `writeMode === "RecorderSubordinate"`; single
  recorder задається через `ref`, multi-recorder через `allowedTypes`.
- `AccumulationRegister`: `period`, `recorder_id`, `line_number`, `active`
  додаються завжди; `movement_type` додається helper-рівнем тільки для
  `registerType === "Balance"`.
- `CustomTable`: `id` додається тільки якщо
  `autoAddPrimaryKey !== false`.
- `Enumeration`: стандартних реквізитів немає, бо порядок already живе у
  `values[].order`.
- `Constant`: стандартних реквізитів немає.
- Tabular sections мають окремий helper для `id` і `line_number`; цей набір
  структурно фіксований так само, як і object-level standard attributes.

`standardAttributeOverrides` у схемах об'єктів не робить стандартні поля
persisted custom fields. Поточна роль цього словника значно вужча: standard
attributes мають readonly structure, а override дозволяє редагувати тільки
метадані опису. Те саме правило діє і для tabular sections через
`tabularSection.standardAttributeOverrides`.

BRD описує бізнес-політику цих реквізитів. Поточна реалізація helper-layer
визначає, які з них реально з'являються у UI та serializer flows сьогодні.

Джерела: [../../packages/core/src/schemas/standard-attributes.ts](../../packages/core/src/schemas/standard-attributes.ts),
[../../packages/core/src/schemas/catalog.ts](../../packages/core/src/schemas/catalog.ts),
[../../packages/core/src/schemas/document.ts](../../packages/core/src/schemas/document.ts),
[../../packages/core/src/schemas/enumeration.ts](../../packages/core/src/schemas/enumeration.ts),
[../../packages/core/src/schemas/information-register.ts](../../packages/core/src/schemas/information-register.ts),
[../../packages/core/src/schemas/accumulation-register.ts](../../packages/core/src/schemas/accumulation-register.ts),
[../../packages/core/src/schemas/constant.ts](../../packages/core/src/schemas/constant.ts),
[../../packages/core/src/schemas/tabular-section.ts](../../packages/core/src/schemas/tabular-section.ts)

## Інваріанти атрибутів і об'єктів

Core зараз гарантує локальні інваріанти об'єкта і поля, але не весь граф
проєкту.

- Імена metadata objects валідовуються як PascalCase, Latin only.
- Імена attributes валідовуються як snake_case, Latin only.
- Імена об'єктів і полів відкидаються, якщо збігаються з SQL reserved words.
- `LocalizedString` вимагає хоча б одну локаль: `uk` або `en`.
- `attributeSchema.superRefine()` відкидає stale type params:
  `length` поза `String`, `precision` і `scale` поза `Numeric`, `ref` і
  `allowedTypes` поза `Ref`.
- `ref` і `allowedTypes` взаємовиключні для одного атрибута.
- Схеми об'єктів вимагають локальну унікальність імен у межах масиву
  `attributes`, `tabularSections`, `dimensions`, `resources`, `values`.
- `AccumulationRegister.resources` обмежені числовими типами:
  `Integer` або `Numeric`.

Ці правила є current implementation. Вони не покривають усі project-level
referential constraints, які залежать від інших об'єктів у моделі.

Джерела: [../../packages/core/src/schemas/attribute.ts](../../packages/core/src/schemas/attribute.ts),
[../../packages/core/src/schemas/catalog.ts](../../packages/core/src/schemas/catalog.ts),
[../../packages/core/src/schemas/document.ts](../../packages/core/src/schemas/document.ts),
[../../packages/core/src/schemas/information-register.ts](../../packages/core/src/schemas/information-register.ts),
[../../packages/core/src/schemas/accumulation-register.ts](../../packages/core/src/schemas/accumulation-register.ts),
[../../packages/core/src/schemas/constant.ts](../../packages/core/src/schemas/constant.ts),
[../../packages/core/src/schemas/localized-string.ts](../../packages/core/src/schemas/localized-string.ts),
[../../packages/core/src/schemas/sql-reserved-words.ts](../../packages/core/src/schemas/sql-reserved-words.ts)

## Межі валідації

### Core і mutation-time validation

Core-схеми задають shape та локальні інваріанти. `metadata-store` у web не
винаходить власну схему поверх них: він повторно викликає
`metadataObjectSchema.safeParse()` на create/update flows і накопичує
`validationErrors` для поточної операції.

### Project-level validation у web

`useModelValidation()` виконує debounced sweep усієї моделі і зберігає
`modelErrors` окремо від mutation-time помилок. Саме тут сьогодні
реалізовані:

- перевірка reachable reference targets для `ref`, `allowedTypes`, `owners`,
  `recorderTypes`, `registerMovements`
- перевірка duplicate object names у межах kind для вже завантажених або
  імпортованих моделей

`projectModelSchema` сам по собі не є повним graph validator. Він описує
aggregate shape, але не перевіряє referential integrity усього проєкту.

### `findReferences()` не є validator

`findReferences()` обходить where-used graph, але не сигналізує про биті
посилання і не гарантує коректність моделі. Використовувати його як заміну
project-level validation некоректно.

Джерела: [../../apps/web/src/stores/metadata-store.ts](../../apps/web/src/stores/metadata-store.ts),
[../../apps/web/src/hooks/use-model-validation.ts](../../apps/web/src/hooks/use-model-validation.ts),
[../../packages/core/src/schemas/project-model.ts](../../packages/core/src/schemas/project-model.ts),
[../../packages/core/src/find-references.ts](../../packages/core/src/find-references.ts)

## Канонічний JSON contract

Serializer contract визначений у core, а не в UI.

- Порядок top-level ключів фіксований для `Project` і кожного metadata kind.
- Для вкладених структур також зафіксовані окремі key orders.
- Порядок елементів у масивах зберігається як user-defined order; serializer
  його не сортує.
- Усі файли серіалізуються з відступом у 2 пробіли і завершуються trailing
  newline.
- `$schema` збагачується helper-функціями і завжди перезаписується, щоб не
  тягнути stale URL після зміни `schemaVersion`.

Важлива межа відповідальності:

- `serializeMetadataObject()` і `serializeProject()` canonicalize JSON.
- `enrichSchemaUrl()` і `enrichProjectSchemaUrl()` додають canonical URLs.
- `WebStorage.serializeToFiles()` підставляє `schemaVersion`, розкладає
  об'єкти по файловій структурі і формує constants wrapper.

Нюанс з константами відрізняється від інших metadata kinds:

- core має `constantsFileSchema` для parsing boundary;
- write-path у web складає один файл `constants.meta.json` з wrapper-об'єктом;
- read-path підтримує і current wrapper, і legacy array format як обмежену
  backward compatibility.

Джерела: [../../packages/core/src/serialization.ts](../../packages/core/src/serialization.ts),
[../../packages/core/src/schemas/constant.ts](../../packages/core/src/schemas/constant.ts),
[../../apps/web/src/storage/web-storage.ts](../../apps/web/src/storage/web-storage.ts)

## SchemaVersion і еволюція формату

### Що реалізовано сьогодні

- У `project` існує поле `schemaVersion` з дефолтом `1.0`.
- `$schema` URL helpers будуються з поточного `schemaVersion`.
- Є лише вузький backward compatibility path для legacy constants array при
  читанні.

### Що лишається політикою BRD або future evolution

- additive-only governance для всіх майбутніх змін формату
- повний набір migrators за версіями
- auto-upgrade flow при відкритті старого проєкту
- примусова міграція на нову версію serializer contract

BRD описує бажану policy-модель еволюції. Поточний код не має загального
migration pipeline, тому документувати його як already implemented не можна.

Джерела: [../../packages/core/src/schemas/project.ts](../../packages/core/src/schemas/project.ts),
[../../packages/core/src/serialization.ts](../../packages/core/src/serialization.ts),
[../../apps/web/src/storage/web-storage.ts](../../apps/web/src/storage/web-storage.ts),
[../BRD-metadata-configurator.md](../BRD-metadata-configurator.md)

## Forms model (Phase 3)

Forms є top-level колекцією в `ProjectModel`: `forms: FormSchema[]`. Кожна форма прив'язана до конкретного об'єкта через `objectRef: MetadataRef` (`{ kind, name }`).

### Precedence rule

Explicit form (файл `*.form.json` у підкаталозі `forms/` об'єкта) завжди перемагає autogenerated форму. Якщо для об'єкта немає explicit form певного `kind` (ItemForm, ListForm), runtime генерує стандартну автоформу з усіма доступними реквізитами в порядку, визначеному в конфігураторі.

### Kinds що підтримують forms

Forms підтримуються для: `Catalog`, `Document`, `CustomTable`. Інші kinds (Enumeration, InformationRegister, AccumulationRegister, Constant) не мають forms у Phase 3.

### Архітектурне рішення

Forms є **окремою top-level колекцією** в `ProjectModel`, а не вкладеним полем в object schemas. Це зберігає чистоту доменної моделі:

- Object schemas (catalogSchema, documentSchema, etc.) **не змінюються** — генератори DDL/SQL не бачать forms.
- Кожна `formSchema` має `objectRef: MetadataRef` для explicit зв'язку з об'єктом.
- Round-trip серіалізації: `serializeToFiles()` записує forms як окремі файли у `forms/` підкаталозі, `parseMetadataFiles()` зчитує їх назад у `model.forms`.

### Валідація

- `objectRef` кожної форми має посилатись на існуючий об'єкт у моделі.
- Kind об'єкта в `objectRef` має бути одним з: `Catalog`, `Document`, `CustomTable`.
- Не більше однієї форми кожного `kind` (ItemForm, ListForm) per object.

## Відомі розбіжності між кодом і BRD

Ці пункти потрібно трактувати як current code facts, а не як рекомендації.

- Нотація версії в `$schema` зараз формує `/v1.0/` для `schemaVersion = "1.0"`.
  У BRD приклади для `1.0` показують `/v1/`.
- `owners`, `recorderTypes` і `registerMovements` у core задані через
  загальний `MetadataRef[]`, тому BRD-очікуване kind narrowing для цих
  колекцій не повністю примушується schema-рівнем.
- `movement_type` існує лише як helper-level стандартний реквізит у
  [../../packages/core/src/schemas/standard-attributes.ts](../../packages/core/src/schemas/standard-attributes.ts).
  Це не окремий persisted custom field і не самостійне schema-level правило.
- Для `InformationRegister` helper `period` завжди моделюється як `DateTime`,
  незалежно від конкретної гранулярності `periodicity`.
- `Constant.valueType` сьогодні навмисно виключає `Ref`, бо schema не має
  способу зберегти target для такого значення.

## Стратегія тестування

Core test suite перевіряє модель у двох площинах.

- [../../packages/core/src/__tests__/schemas.test.ts](../../packages/core/src/__tests__/schemas.test.ts)
  покриває Zod-інваріанти, defaults, reference rules, derivation стандартних
  реквізитів, `$schema` enrichment, constant `Ref` restriction, canonical
  roundtrip по fixture-файлах і idempotent serialization.
- [../../packages/core/src/__tests__/find-references.test.ts](../../packages/core/src/__tests__/find-references.test.ts)
  покриває traversal scope для `owners`, `recorderTypes`,
  `registerMovements`, `attribute.ref`, `attribute.allowedTypes` і явно
  фіксує, що standard attributes не обходяться як persisted `.attributes`.

Ця стратегія сильна на pure-model і serializer-рівні. Вона не повинна
підміняти integration-тести web-рівня для storage або session lifecycle.

## Антипатерни

- Дублювати Zod-схеми або reference rules у UI замість імпорту з core.
- Трактувати derived standard attributes як persisted custom attributes або як
  повністю editable набір полів.
- Описувати project-level referential validation як ніби вона повністю живе
  в core.
- Використовувати `findReferences()` як validator замість traversal utility.
- Обіцяти загальну систему schema migration або auto-upgrade, якої ще немає
  в коді.

## Пов'язана документація

- [OVERVIEW.md](./OVERVIEW.md)
- [state-management.md](./state-management.md)
- [ui-components.md](./ui-components.md)
- [storage-and-persistence.md](./storage-and-persistence.md)
- [patterns-and-decisions.md](./patterns-and-decisions.md)
- [../BRD-metadata-configurator.md](../BRD-metadata-configurator.md)
