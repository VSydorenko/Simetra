# Task: Валідація метаданих у конфігураторі — Core + UI

## Контекст

Аудит UI конфігуратора виявив системну прогалину: **core Zod-схеми дозволяють неповні/невалідні метадані**, а **UI не валідовує введення до коміту в store**. Результат — метадані, які формально проходять Zod, але генерують fallback DDL без попередження (String без length → `varchar(255)`, Numeric без precision → `numeric(15, 2)`, Ref без target → bare `uuid` без FK).

Окремий критичний баг: enum value names — єдине поле, де core schema взагалі не обмежує символи (просто `z.string()`), а всі інші technical names вже вимагають Latin-only.

### Масштаб змін

Задача торкається трьох шарів:
1. **Core schemas** (`@simetra/core`) — закріплення вимог до type-specific параметрів і enum value naming
2. **UI forms** (`apps/web`) — локальна валідація до коміту в store, inline error feedback
3. **Model validation / DDL-store** (`apps/web`) — розширення перевірок на posting type compatibility, silent fallbacks

### Обмеження

- Core package має залишатися pure TS + Zod — без React, без Node API
- UI валідація доповнює core, але не замінює Zod schema enforcement у store
- Зворотна сумісність з існуючими metadata JSON файлами: невалідні дані стають warning при load, не блокуючи відкриття проєкту

---

## Phase 1: Core Schema Hardening

**Мета:** Зробити Zod-схеми strict enough, щоб неповні метадані не проходили validation.

### FIX 1.1 — Enum Value Name: Latin-Only Constraint

**Проблема:** `enumValueSchema.name` — це `z.string()` без будь-яких обмежень. Кирилиця, пробіли, спецсимволи — все проходить. Ці значення стають PostgreSQL enum labels.

**Файли:**
- `packages/core/src/schemas/enumeration.ts` — schema `enumValueSchema`, поле `name`

**Вимоги:**
- [ ] Додати regex constraint до `enumValueSchema.name` — формат PascalCase, Latin-only (аналогічно до object names)
- [ ] Мінімальна довжина 1 символ
- [ ] Описове Zod error message українською
- [ ] Тести: валідні PascalCase імена проходять, кирилиця/пробіли/спецсимволи відхиляються

### FIX 1.2 — Type-Specific Parameters: Conditional Require

**Проблема:** `length`, `precision`, `scale` всі мають `.optional()` без conditional require. Attribute з type `String` без `length` — валідний за Zod, але генератор мовчки підставляє `varchar(255)`.

**Файли:**
- `packages/core/src/schemas/attribute.ts` — `attributeSchema`, секція `superRefine`

**Вимоги:**
- [ ] У `superRefine`: якщо `type === 'String'` і `length` відсутній — це Zod error (не warning)
- [ ] Якщо `type === 'Numeric'` і `precision` або `scale` відсутній — Zod error
- [ ] Існуючий cleanup для stale params залишається
- [ ] Тести: String без length → error; String з length → pass; Numeric без precision → error; Boolean без length → pass (length не потрібен)

### FIX 1.3 — Ref Without Target: Must Be Error

**Проблема:** Attribute з type `Ref` і `ref: undefined` проходить schema validation. Генератор видає bare `uuid` колонку без FK.

**Файли:**
- `packages/core/src/schemas/attribute.ts` — `attributeSchema`, секція `superRefine`

**Вимоги:**
- [ ] У `superRefine`: якщо `type === 'Ref'` і `ref` відсутній — Zod error
- [ ] Тести: Ref без ref → error; Ref з ref → pass

### FIX 1.4 — Posting Compatibility: recorderTypes Enforcement

**Проблема:** `posting-compatibility.ts` завжди повертає `compatible: true` для AccumulationRegister, навіть якщо `recorderTypes` пустий або не містить тип документа-реєстратора.

**Файли:**
- `packages/core/src/posting-compatibility.ts`

**Вимоги:**
- [ ] Якщо AccumulationRegister має непорожній `recorderTypes` — перевіряти, що документ входить до списку
- [ ] Якщо `recorderTypes` порожній або відсутній — поведінка "accept all" із окремим warning (не error)
- [ ] Тести: register з recorderTypes=[DocA] + DocB → incompatible; register з recorderTypes=[] + DocB → compatible з warning

### Тести Phase 1

- [ ] `packages/core/src/__tests__/enumeration.test.ts` — enum value naming
- [ ] `packages/core/src/__tests__/attribute.test.ts` — conditional require, Ref without target
- [ ] `packages/core/src/__tests__/posting-compatibility.test.ts` — recorderTypes enforcement

### DoD Phase 1

- [ ] `pnpm --filter @simetra/core test` — green
- [ ] `pnpm typecheck` — без помилок
- [ ] Існуючі тести не зламані (крім тих, що очікували проходження невалідних даних — їх оновити)

---

## Phase 2: UI Form Validation

**Мета:** Кожна форма де користувач вводить або редагує technical name має:
1. Локальну pre-commit валідацію Latin-only символів
2. Inline error feedback біля конкретного input
3. Блокування коміту невалідного значення

### Загальний підхід

- Створити shared utility `validateTechnicalName(value: string, format: 'PascalCase' | 'snake_case'): string | null` — повертає error message або null
- Використовувати цей utility у всіх формах перед store call
- Для tree rename — показати inline error tooltip або колір бордера замість silent revert

### FIX 2.1 — Object Rename в Tree Panel

**Проблема:** Rename у дереві (Enter) відправляє значення в store, store відхиляє через PascalCase regex, input мовчки повертається до попереднього значення.

**Файли:**
- `apps/web/src/components/layout/tree/tree-nodes.tsx` — submit handler (~L695)
- `apps/web/src/components/layout/tree-panel.tsx` — rename sink (~L232)

**Вимоги:**
- [ ] Перед викликом store — перевірити `validateTechnicalName(value, 'PascalCase')`
- [ ] Якщо невалідно — показати inline error (red border + tooltip) замість silent revert
- [ ] Enter на невалідному значенні — не комітить, показує помилку
- [ ] Escape — скасовує редагування (як зараз)

### FIX 2.2 — Object Rename в Properties Panel

**Проблема:** Та сама проблема, що й в Tree, але через правий panel. Є generic error section, але помилка не біля конкретного input.

**Файли:**
- `apps/web/src/components/properties/object-properties.tsx` — name input (~L104), commit handler (~L126)

**Вимоги:**
- [ ] Локальна перевірка PascalCase перед store call
- [ ] Inline error message під input полем name
- [ ] Блокування коміту невалідного значення

### FIX 2.3 — Tabular Section Rename в Properties Panel

**Проблема:** Найгірший UX-кейс: rejected rename фактично німий. TabularSectionProperties не підключає validationErrors, немає жодної error surface.

**Файли:**
- `apps/web/src/components/properties/tabular-section-properties.tsx` — name input (~L38), commit handler (~L58)

**Вимоги:**
- [ ] Локальна перевірка snake_case перед store call
- [ ] Inline error message під input полем name
- [ ] Підключити validation errors до компоненту або додати власний error state

### FIX 2.4 — Enum Value Name Inline Edit

**Проблема:** Це єдиний UI де невалідне значення не просто мовчки відхиляється, а **успішно зберігається** (бо core schema не має обмежень — FIX 1.1).

**Файли:**
- `apps/web/src/components/editor/enum-values-editor.tsx` — inline input (~L216), commit handler (~L232)

**Вимоги:**
- [ ] Локальна перевірка PascalCase перед store call
- [ ] Inline error feedback (red border або message) при спробі зберегти невалідне ім'я
- [ ] Нові enum values створюються з автогенерованим валідним ім'ям (перевірити існуючу логіку)

### FIX 2.5 — Data Type Editor: Ініціалізація Defaults

**Проблема:** При зміні типу attribute `cleanupDraftForType` тільки **очищає** несумісні параметри, але не **ініціалізує** defaults для нового типу. String без length, Numeric без precision — діалог дозволяє зберегти.

**Файли:**
- `apps/web/src/components/editor/data-type-editor-dialog.tsx` — `cleanupDraftForType` (~L74)

**Вимоги:**
- [ ] При зміні типу на String — ініціалізувати `length` значенням за замовчуванням (50 або інший розумний default)
- [ ] При зміні типу на Numeric — ініціалізувати `precision` і `scale` (наприклад, 15 і 2)
- [ ] При зміні типу на Ref — спорожнити ref, але показати warning що target обов'язковий
- [ ] Кнопка Save заблокована якщо обов'язкові type-specific параметри відсутні

### FIX 2.6 — Shared Field Update Hook: Error Propagation

**Проблема:** `useFieldUpdate` hook ігнорує errors повернені store actions — caller не отримує feedback про rejected update.

**Файли:**
- `apps/web/src/hooks/use-field-update.ts` — всі update handlers (~L41, L53, L61, L70, L80)

**Вимоги:**
- [ ] Store actions повертають result/error — hook має пробросити їх до caller
- [ ] Callers які потребують error feedback — мають можливість відобразити inline error

### Тести Phase 2

- [ ] Unit test для `validateTechnicalName` utility — PascalCase і snake_case варіанти
- [ ] Integration тести для key forms: tree rename rejection, enum value name rejection

### DoD Phase 2

- [ ] `pnpm test` — green (web + core)
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm lint` — без помилок
- [ ] Жоден rename form не дозволяє мовчки зберегти невалідне technical name
- [ ] Enum values не приймають кирилицю, пробіли, спецсимволи

---

## Phase 3: Model Validation & DDL-Store Warnings

**Мета:** Розширити use-model-validation і ddl-store перевірками бізнес-логіки, яких зараз бракує.

### FIX 3.1 — Posting Type Compatibility

**Проблема:** Expression `now()` маппиться на String поле без warning. `expression-validation.ts` і `build-expression-options.ts` не перевіряють type compatibility між source expression і target field.

**Файли:**
- `apps/web/src/lib/expression-validation.ts`
- `apps/web/src/lib/build-expression-options.ts`
- `apps/web/src/hooks/use-model-validation.ts`

**Вимоги:**
- [ ] `expression-validation.ts` — додати перевірку type compatibility (Date expression → Date/DateTime field; String literal → String field; field ref → matching type)
- [ ] `build-expression-options.ts` — фільтрувати `now()` тільки для Date/DateTime полів, `literal:` — за типом target
- [ ] `use-model-validation.ts` — додати warning для type-mismatch у posting mappings

### FIX 3.2 — DDL-Store: Silent Fallback Warnings

**Проблема:** DDL-store виконує pre-validation для broken refs, але не для missing type-specific params. Після FIX 1.2 core відхилить такі дані, але для graceful UX потрібні попереджувальні повідомлення.

**Файли:**
- `apps/web/src/stores/ddl-store.ts`
- `apps/web/src/hooks/use-model-validation.ts`

**Вимоги:**
- [ ] `use-model-validation` — додати перевірку: attribute Ref без target, String без length, Numeric без precision
- [ ] Показувати як warnings з чіткими повідомленнями (не просто "validation error")

### DoD Phase 3

- [ ] `pnpm test` — green
- [ ] `pnpm typecheck` — без помилок
- [ ] Posting mapping `now()` → String field показує warning
- [ ] Model validation ловить Ref без target, String без length

---

## Clarify (питання перед імплементацією)

- [ ] **Enum value name format: PascalCase чи snake_case?**
  - Чому це важливо: визначає regex constraint у FIX 1.1
  - Варіанти: PascalCase (як object names) / snake_case (як attribute names) / camelCase
  - Вплив: core schema regex, UI validation, DDL generation (pgEnum labels)
  - Рекомендація: PascalCase, бо enum values — це іменовані константи бізнес-домену

- [ ] **Default values для type-specific params (FIX 2.5)**
  - Чому це важливо: визначає UX при зміні типу attribute
  - Варіанти: String length = 50 / 100 / 255; Numeric precision = 10,2 / 15,2 / 18,4
  - Вплив: UI defaults, user expectations
  - Рекомендація: length=50, precision=15, scale=2 (як поточний generator fallback, але тепер explicit)

- [ ] **Зворотна сумісність при load існуючих metadata JSON**
  - Чому це важливо: після FIX 1.2 і 1.3 — існуючі файли з String без length стануть невалідні
  - Варіанти: A) strict — відхилити load / B) lenient — load з warning + auto-fill defaults
  - Вплив: UX при відкритті старих проєктів
  - Рекомендація: B — lenient load з warning і підстановкою defaults

- [ ] **Recorder contract: error чи warning?**
  - Чому це важливо: recorderTypes mismatch може бути intentional (register приймає будь-який документ)
  - Варіанти: A) error — блокує save / B) warning — інформує
  - Вплив: model validation severity
  - Рекомендація: warning — не блокувати, бо порожній recorderTypes = "accept all"

---

## Рекомендовані патерни

### Shared Validation Utility
Єдина функція `validateTechnicalName(value, format)` яка використовується всіма UI forms. Regex паттерни імпортувати з core або синхронізувати з Zod schema constraints. Не дублювати regex у кожному компоненті.

### Inline Error State
Кожна name-edit форма тримає локальний `error: string | null` state. Error показується під/біля input поля. Store call відбувається тільки при `error === null`.

### Core SuperRefine Extension
Додавати conditional require через нові гілки в існуючому `superRefine`, а не через окремий `.refine()`. Це зберігає єдину точку валідації і дає доступ до повного контексту attribute.

### Graceful Migration
При load metadata JSON — використовувати `schema.safeParse()`. Якщо помилка в нових strict полях — підставити default і додати warning у UI. Не блокувати відкриття проєкту.

---

## Антипатерни (уникати)

### ❌ Дублювання regex у кожному компоненті
Regex для PascalCase/snake_case має бути одне джерело правди — або core schema, або shared utility. Не копіювати `/^[A-Z][a-zA-Z0-9]*$/` в кожен TSX файл.

### ❌ Blocking validation замість inline feedback
Не використовувати modal alert або toast для validation errors при rename. Помилка має бути **inline** біля конкретного input, а не десь у іншій панелі.

### ❌ Error logs замість user-facing messages
`console.warn` у store — це для dev, не для user. Validation errors мають з'являтися в UI.

### ❌ Окремий validation pipeline паралельно Zod
Не створювати другу систему валідації. Core Zod schema — source of truth. UI validation — це early feedback перед store call, а не заміна.

### ❌ Змінювати generator fallback замість фіксити source
Не "покращувати" fallback у generator-pg. Правильний підхід: зробити неповні метадані невалідними на вході.

---

## Архітектурні рішення

```
┌─────────────────────────────────────────────────────┐
│ UI Form (tree-nodes, object-properties, enum-editor)│
│                                                     │
│  1. User input                                      │
│  2. validateTechnicalName() ← shared utility        │
│  3. Inline error OR commit to store                 │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ metadata-store (Zustand + immer)                    │
│                                                     │
│  4. Merge draft into object                         │
│  5. metadataObjectSchema.safeParse() ← core Zod    │
│  6. Reject OR apply mutation                        │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ use-model-validation (debounced project-level)      │
│                                                     │
│  7. Cross-object checks: ref reachability,          │
│     posting compatibility, type mismatches          │
│  8. Warnings → status bar + properties panel        │
└─────────────────────────────────────────────────────┘
```

---

## Пов'язана документація

- `docs/architecture/metadata-model.md` — модель метаданих, стандартні реквізити
- `docs/architecture/state-management.md` — Zustand store contract, validation flow
- `docs/architecture/ui-components.md` — layout панелей, properties panel
- `docs/BRD-metadata-configurator.md` секція 5 — типи метаданих
- `docs/BRD-metadata-configurator.md` секція 6 — система типів полів (String, Numeric, Ref, etc.)
- `packages/core/src/schemas/attribute.ts` — attributeSchema з superRefine
- `packages/core/src/schemas/enumeration.ts` — enumValueSchema (target для FIX 1.1)
- `packages/core/src/posting-compatibility.ts` — posting checks
- `.github/instructions/metadata-model.instructions.md` — правила роботи з Zod-схемами

---

## Definition of Done

### Обов'язкові
- [ ] Core: enum value names — Latin-only PascalCase
- [ ] Core: String без length, Numeric без precision/scale — Zod error
- [ ] Core: Ref без target — Zod error
- [ ] UI: жодна name-edit форма не дозволяє мовчки зберегти невалідне ім'я
- [ ] UI: inline error feedback біля кожного name input
- [ ] UI: Data Type Editor ініціалізує defaults при зміні типу
- [ ] Posting: type mismatch warning (now() → String)
- [ ] `pnpm test` — green
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm lint` — без помилок

### Бажані
- [ ] Graceful load старих metadata JSON з warnings
- [ ] Model validation: recorderTypes mismatch warning
- [ ] DDL-store: попередження про missing type params (якщо core ще не блокує)
