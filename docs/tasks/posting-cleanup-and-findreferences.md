# Task: Видалення boolean posting та інтеграція posting refs

## Контекст

Phase 2b Етап 1 створив Zod-схеми для декларативного маппінгу проведення (`postingSchema`, `postingMovementSchema`, `postingValidationSchema`). При цьому для зворотної сумісності поле `posting` в `documentSchema` було реалізоване як `z.union([z.boolean(), postingSchema]).default(true)`.

Оскільки **жодного реального проекту ще не побудовано** і міграцій не виконано, тимчасовий backward-compat шар потрібно повністю видалити. Крім того, code-review і дослідження виявили прогалини: `findReferences` не має тестів для posting, DDL store не валідує posting refs, UI Switch залишається старим boolean toggle, store не нормалізує порожній posting object, відсутній інваріант між posting і registerMovements, а BRD/architecture docs описують застарілий контракт.

**Семантика після цієї задачі:**
- Документ **з** секцією `posting` (де є хоча б один movement) — проведений
- Документ **без** секції `posting` (або `posting: undefined`) — не-проведений (не робить рухів)
- Порожній posting object `{ movements: [], validations: [] }` нормалізується в `undefined` на store рівні — він не зберігається і не серіалізується
- Validations без movements заборонені як model validation warning
- Boolean `posting: true/false` більше не існує в runtime коді, тестах, fixtures, temp metadata та canonical docs

## Архітектурні інваріанти

1. **Presence/absence семантика**: `doc.posting !== undefined` — єдиний canonical спосіб перевірити "чи документ проведений"
2. **Порожній posting = відсутній posting**: store нормалізує `{ movements: [], validations: [] }` → `undefined`
3. **Validations потребують movements**: posting з validations без movements — model validation warning
4. **posting register refs ⊆ registerMovements**: кожен `posting.movements[].register` має бути оголошений у `registerMovements`
5. **Core schema не обмежує draft-flow**: пустий posting object валідний для parse, нормалізація — відповідальність store

---

## Фаза 1: Core contract

**Мета:** прибрати boolean union, зафіксувати core schema contract.

**Зміни:**

- [X] **document.ts** — замінити `posting: z.union([z.boolean(), postingSchema]).default(true)` на `posting: postingSchema.optional()`
- [X] **schemas.test.ts** — видалити/переписати тести boolean posting:
  - Видалити: "document without posting defaults to true (backward compatible)"
  - Видалити: "document with posting: true (backward compatible)"
  - Видалити: "document with posting: false"
  - Видалити: assertion `expect(result.posting).toBe(true)` з тесту "parses minimal document"
  - Додати: "document without posting → posting is undefined"
  - Адаптувати: "document with posting object" та "document with empty posting object" — вже працюють, перевірити
- [X] **fixtures/document.json** — видалити `"posting": true` з golden fixture. Оновити roundtrip тест якщо assertion зламається
- [X] **find-references.test.ts** — додати тести для `postingMovement` та `postingValidation` reference kinds:
  - Документ з posting.movements → findReferences знаходить `postingMovement` ref на регістр
  - Документ з posting.validations → findReferences знаходить `postingValidation` ref на регістр
  - Документ без posting → findReferences не падає і не знаходить posting refs

**Ризики:** зміна core schema зламає downstream consumers, тому ця фаза має бути завершена першою.

**DoD фази:** core schema і core tests виражають одну семантику без boolean; `pnpm --filter @simetra/core test` — green.

---

## Фаза 2: Downstream cleanup (generator-pg)

**Мета:** прибрати boolean posting у всіх тестах і fixtures generator-pg.

**Зміни:**

- [X] **generate-table.test.ts** — замінити boolean posting у inline fixtures:
  - L232: `posting: true` → видалити поле
  - L371: `posting: false` → видалити поле
  - L813: `posting: false` → видалити поле
- [X] **generate-posting.test.ts** — замінити boolean posting:
  - L441: `posting: true` → видалити поле (тест "document without posting" має працювати з `posting: undefined`)

**Примітка:** runtime код `generate-posting.ts` не потребує змін — guard `typeof doc.posting !== 'object'` вже коректно обробляє `undefined` після видалення union.

**Ризики:** мінімальні, це чисто тестовий cleanup.

**DoD фази:** `pnpm --filter @simetra/generator-pg test` — green; жодних boolean posting у пакеті.

---

## Фаза 3: Web alignment

**Мета:** прибрати boolean toggle, додати DDL validation, нормалізацію порожнього posting, інваріант posting↔registerMovements, guard validations-without-movements.

### 3.1. UI cleanup

- [X] **object-properties.tsx** — видалити Switch "Posting" з `DocumentTypeSettings`. Блок з `checked={!!o.posting}` та `onCheckedChange` повністю видаляється

### 3.2. Нормалізація порожнього posting → undefined

- [X] **metadata-store.ts** — у `removeMovement`, `removePostingValidation` та у sync-гілці `updateObject` (при зміні registerMovements): після фільтрації перевірити `movements.length === 0 && validations.length === 0` → якщо так, встановити `doc.posting = undefined`
  - `removeMovement` (≈L1721–1737): після фільтрації movements і validations перевірити порожність
  - `removePostingValidation` (≈L1794–1801): після фільтрації validations перевірити обидва масиви
  - `updateObject` sync-гілка (≈L547–560): після фільтрації stale items перевірити порожність

### 3.3. DDL store posting ref validation

- [X] **ddl-store.ts** — додати валідацію posting refs за патерном `use-model-validation.ts` (рядки 136–162):
  - Після блоку `registerMovements` validation (≈L126–133), додати:
  - Перевірити `posting.movements[].register` існує в моделі
  - Перевірити `posting.validations[].register` існує в моделі
  - Повідомлення помилки аналогічне іншим ref-помилкам у DDL store

### 3.4. Model validation: інваріант posting↔registerMovements

- [X] **use-model-validation.ts** — додати cross-check: для кожного `posting.movements[].register` перевірити, що відповідний ref є в `registerMovements`. Якщо ні — error `posting.movements contains register not declared in registerMovements`

### 3.5. Model validation: validations without movements

- [X] **use-model-validation.ts** — додати перевірку: якщо `posting.validations.length > 0 && posting.movements.length === 0` → warning `posting has validations but no movements — validations will have no effect`

### 3.6. UI guard: validations without movements

- [X] **movements-section.tsx** — заблокувати кнопку "Add validation" додатково: якщо `postingData?.movements.length === 0 || !postingData`. Зараз блокується тільки при `registerMovements.length === 0`

### 3.7. Web-тести (нова поведінка)

- [X] **Тест ddl-store posting ref validation** — створити модель з документом, де `posting.movements[].register` вказує на неіснуючий регістр → `validateModelForDdl()` має повернути відповідну помилку. Аналогічний тест для `posting.validations[].register`
- [X] **Тест metadata-store empty posting normalization** — створити документ з posting, видалити останній movement і останню validation → `doc.posting` має стати `undefined`
- [X] **Тест use-model-validation cross-check** — документ з `posting.movements[].register` = X, де X відсутній у `registerMovements` → `modelErrors` містить відповідну помилку

**Ризики:**
- Нормалізація в store стосується трьох action-ів — треба уважно не зламати undo/redo
- Cross-check posting↔registerMovements може давати хибні спрацювання у перехідному стані, але `useModelValidation` уже debounced (300ms)

**DoD фази:** web більше не опирається на boolean semantics; DDL validation parity з model validation; нові поведінкові гілки покриті тестами; `pnpm --filter web test` — green.

---

## Фаза 4: Docs та temp metadata

**Мета:** синхронізувати документацію і зразкові дані з новим контрактом.

### 4.1. Temp metadata

- [X] **temp/metadata/documents/** — у всіх 4 файлах видалити рядок `"posting": true,`:
  - `document-post/document-post.meta.json`
  - `invoice-client/invoice-client.meta.json`
  - `new-document3/new-document3.meta.json`
  - `new-document4/new-document4.meta.json`

### 4.2. BRD

- [X] **BRD §5.3** — в таблиці замінити `| posting | Boolean | true | Підтримка проведення |` на `| posting | PostingConfig (optional) | — | Декларативний маппінг проведення (§5.3.1) |`
- [X] **BRD §5.3.1** — замінити "Документи без секції posting працюють як раніше — тільки декларація зв'язку через registerMovements" на "Документи без секції posting є не-проведеними і не створюють рухів у регістрах"

### 4.3. Architecture docs

- [X] **metadata-model.md** — додати опис posting object:
  - Семантика presence/absence
  - Нормалізація порожнього posting → undefined
  - Інваріант posting register refs ⊆ registerMovements
  - Вплив на findReferences (postingMovement, postingValidation reference kinds)
  - Зв'язок з registerMovements (lightweight declaration vs detailed mapping)

### 4.4. Parent task note

- [X] **phase2b-posting-engine.md** — додати note що boolean backward-compat шар видалений цією задачею, щоб уникнути конкуруючих truth-джерел

**Ризики:** documents drift — якщо пропустити оновлення, BRD і architecture docs будуть описувати старий контракт.

**DoD фази:** canonical docs описують одну й ту саму семантику; temp metadata не містить boolean posting.

---

## Фаза 5: Verification

**Мета:** grep clean, повний прогон тестів, lint, typecheck.

- [X] Grep clean по scope: `packages/`, `apps/`, `temp/`, `docs/architecture/`, `docs/BRD-metadata-configurator.md`
  - Команда: `grep -rn 'posting.*true\|posting.*false' packages/ apps/ temp/ docs/architecture/ docs/BRD-metadata-configurator.md`
  - Виключення: `docs/tasks/` (task/spec docs описують historical context і не входять у scope перевірки)
- [X] `pnpm --filter @simetra/core test` — green
- [X] `pnpm --filter @simetra/generator-pg test` — green
- [X] `pnpm --filter web test` — green
- [X] `pnpm lint ; pnpm typecheck` — clean

**DoD фази:** всі перевірки проходять з першого запуску.

---

## Clarify (вирішені питання)

### ✅ Що робити з `registerMovements` після переходу на posting object?
**Рішення:** залишити обидва поля як окремі persisted структури. `registerMovements` — lightweight декларація зв'язку, `posting` — повний маппінг. Інваріант: `posting.movements[].register` має бути підмножиною `registerMovements`. Перевірка — у `use-model-validation.ts`.

### ✅ Що означає порожній posting object?
**Рішення:** порожній posting `{ movements: [], validations: [] }` семантично еквівалентний відсутньому posting. Store нормалізує його в `undefined` після remove операцій. Core schema продовжує приймати пустий object для parse (legacy JSON, draft-flow), але store не дозволяє йому persist.

### ✅ Чи допустимий posting з validations без movements?
**Рішення:** заборонити. Validations перевіряють залишки після руху — без руху вони не мають сенсу. UI блокує кнопку "Add validation" при відсутності movements. Model validation показує warning. Generator вже ігнорує такі документи.

### ✅ Який scope grep clean?
**Рішення:** `packages/`, `apps/`, `temp/`, `docs/architecture/`, `docs/BRD-*.md`. Виключення: `docs/tasks/` (spec docs описують historical context).

## Рекомендовані патерни

### Posting як optional object
Замість union boolean | object, використовувати `postingSchema.optional()`. Перевірка "чи документ проведений" — через `doc.posting !== undefined`. Це єдиний canonical спосіб.

### Нормалізація порожнього posting у store
Після видалення останнього movement/validation — `doc.posting = undefined`. Guardrail тільки в store, бо це єдиний write-path для in-memory posting mutations. Core schema і serializer не змінюються.

### Валідація posting refs у DDL store
Слідувати існуючому патерну `use-model-validation.ts` (рядки 136–162) — `typeof obj.posting === "object"` guard, потім iterate movements та validations.

### Cross-check posting↔registerMovements
У `use-model-validation.ts`: для кожного `posting.movements[].register` — `registerMovements.some(r => r.kind === reg.kind && r.name === reg.name)`. Це підмножинна перевірка, а не strict equality.

### Тести findReferences для posting
Слідувати існуючому патерну find-references.test.ts — використовувати `buildModel()` helper, створити документ з posting object та перевірити reference kinds.

## Антипатерни (уникати)

### ❌ Залишати boolean fallback "на всякий випадок"
Немає реальних даних з boolean posting. Union ускладнює downstream код (кожен consumer повинен перевіряти `typeof posting === "boolean"`).

### ❌ Виводити "document supports posting" з наявності registerMovements
registerMovements — це lightweight зв'язок, posting — повний маппінг. Не змішувати семантику.

### ❌ Додавати окремий boolean прапорець "postingEnabled"
Наявність секції `posting` вже є прапорцем. Не дублювати інформацію.

### ❌ Валідувати posting refs тільки в одному місці
DDL store і model validation — різні контексти. DDL store блокує генерацію SQL, model validation показує помилки в UI. Обидва need coverage.

### ❌ Нормалізувати порожній posting у serializer або core schema
Serializer в core не повинен знати бізнес-семантику posting (SRP). Core schema має приймати пустий object для parse legacy JSON. Нормалізація — відповідальність store.

### ❌ Автоматично синхронізувати registerMovements при зміні posting
registerMovements — user-decided lightweight declaration. Store не повинен implicitly змінювати його за спиною user. Замість цього — model validation warning.

## Архітектурні рішення

### Поточний стан (до задачі)
```
documentSchema.posting = z.union([z.boolean(), postingSchema]).default(true)
```
- UI Switch оперує boolean
- Тести покривають boolean
- JSON fixtures містять `"posting": true`
- findReferences: traversal є, тестів немає
- DDL store: не валідує posting refs
- Store: не нормалізує порожній posting
- Model validation: не перевіряє інваріант posting↔registerMovements
- Model validation: не перевіряє validations без movements

### Цільовий стан (після задачі)
```
documentSchema.posting = postingSchema.optional()
```
- UI Switch видалений
- Тести покривають тільки object/undefined
- JSON fixtures без boolean posting
- findReferences: traversal + тести
- DDL store: валідує posting refs
- Store: нормалізує порожній posting → undefined
- Model validation: cross-check posting register refs ⊆ registerMovements
- Model validation: warning при validations без movements

## Файли для зміни (повний список)

| Файл | Дія | Фаза |
|---|---|---|
| `packages/core/src/schemas/document.ts` | Змінити тип posting | 1 |
| `packages/core/src/__tests__/schemas.test.ts` | Видалити/переписати boolean тести | 1 |
| `packages/core/src/__tests__/fixtures/document.json` | Видалити `"posting": true` | 1 |
| `packages/core/src/__tests__/find-references.test.ts` | Додати posting ref тести | 1 |
| `packages/generator-pg/src/__tests__/generate-table.test.ts` | Адаптувати inline fixtures (L232, L371, L813) | 2 |
| `packages/generator-pg/src/__tests__/generate-posting.test.ts` | Адаптувати inline fixture (L441) | 2 |
| `apps/web/src/components/properties/object-properties.tsx` | Видалити Switch "Posting" | 3 |
| `apps/web/src/stores/metadata-store.ts` | Нормалізація порожнього posting → undefined | 3 |
| `apps/web/src/stores/ddl-store.ts` | Додати posting ref validation | 3 |
| `apps/web/src/hooks/use-model-validation.ts` | Cross-check posting↔registerMovements + validations warning | 3 |
| `apps/web/src/components/editor/movements-section.tsx` | Guard validations без movements | 3 |
| `apps/web/src/__tests__/ddl-store-posting.test.ts` | Тест DDL validation | 3 |
| `apps/web/src/__tests__/posting-normalization.test.ts` | Тест empty posting → undefined | 3 |
| `apps/web/src/__tests__/posting-validation.test.ts` | Тест cross-check posting↔registerMovements | 3 |
| `temp/metadata/documents/document-post/document-post.meta.json` | Видалити posting | 4 |
| `temp/metadata/documents/invoice-client/invoice-client.meta.json` | Видалити posting | 4 |
| `temp/metadata/documents/new-document3/new-document3.meta.json` | Видалити posting | 4 |
| `temp/metadata/documents/new-document4/new-document4.meta.json` | Видалити posting | 4 |
| `docs/BRD-metadata-configurator.md` | Оновити §5.3 таблицю та §5.3.1 | 4 |
| `docs/architecture/metadata-model.md` | Додати posting object опис | 4 |
| `docs/tasks/phase2b-posting-engine.md` | Додати note про видалення boolean compat | 4 |

## Пов'язана документація

- `docs/BRD-metadata-configurator.md` §5.3, §5.3.1 — специфікація posting
- `docs/architecture/metadata-model.md` — модель метаданих
- `docs/tasks/phase2b-posting-engine.md` — батьківська задача
- `packages/core/src/schemas/posting.ts` — posting Zod-схеми (вже реалізовані)
- `packages/core/src/find-references.ts` — traversal (вже має posting, потребує тестів)
- `apps/web/src/hooks/use-model-validation.ts` — reference патерн для DDL store
- `apps/web/src/stores/metadata-store.ts` — posting actions і sync-логіка

## Definition of Done

### Contract
- [ ] `posting` в documentSchema — `postingSchema.optional()`, без boolean union
- [ ] Порожній posting object нормалізується в `undefined` у metadata-store

### Coverage
- [ ] find-references.test.ts має тести для `postingMovement` та `postingValidation`
- [ ] Web-тести: DDL validation, empty posting normalization, cross-check posting↔registerMovements

### Validation
- [ ] DDL store валідує posting refs (movements + validations)
- [ ] Model validation: cross-check posting register refs ⊆ registerMovements
- [ ] Model validation: warning при validations без movements
- [ ] UI: кнопка "Add validation" заблокована без movements

### UI
- [ ] UI Switch "Posting" видалений з object-properties

### Docs
- [ ] BRD §5.3 описує posting як PostingConfig (optional)
- [ ] metadata-model.md описує posting object, інваріанти, нормалізацію
- [ ] phase2b-posting-engine.md має note про видалення boolean compat

### Grep clean
- [X] `grep -rn 'posting.*true\|posting.*false' packages/ apps/ temp/ docs/architecture/ docs/BRD-metadata-configurator.md` → 0 hits (production code; test hits are expected negative tests)
- [X] Scope виключає `docs/tasks/` (historical context)

### Green
- [X] `pnpm --filter @simetra/core test` — green (159 passed)
- [X] `pnpm --filter @simetra/generator-pg test` — green (118 passed)
- [X] `pnpm --filter web test` — green (172 passed)
- [X] `pnpm lint ; pnpm typecheck` — clean (6/6 tasks)
