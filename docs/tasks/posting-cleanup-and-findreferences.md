# Task: Видалення boolean posting та інтеграція posting refs

## Контекст

Phase 2b Етап 1 створив Zod-схеми для декларативного маппінгу проведення (`postingSchema`, `postingMovementSchema`, `postingValidationSchema`). При цьому для зворотної сумісності поле `posting` в `documentSchema` було реалізоване як `z.union([z.boolean(), postingSchema]).default(true)`.

Оскільки **жодного реального проекту ще не побудовано** і міграцій не виконано, тимчасовий backward-compat шар потрібно повністю видалити. Крім того, code-review виявив прогалини: `findReferences` не має тестів для posting, DDL store не валідує posting refs, UI Switch залишається старим boolean toggle, а BRD/architecture docs описують застарілий контракт.

**Семантика після цієї задачі:**
- Документ **з** секцією `posting` — проведений (має маппінг руху)
- Документ **без** секції `posting` — не-проведений (не робить рухів)
- Boolean `posting: true/false` більше не існує ніде

## Вимоги

### Core (`packages/core`)

- [ ] **document.ts** — замінити `posting: z.union([z.boolean(), postingSchema]).default(true)` на `posting: postingSchema.optional()`
- [ ] **schemas.test.ts** — видалити/переписати тести boolean posting:
  - Видалити: "document without posting defaults to true (backward compatible)"
  - Видалити: "document with posting: true (backward compatible)"
  - Видалити: "document with posting: false"
  - Видалити: assertion `expect(result.posting).toBe(true)` з тесту "parses minimal document"
  - Додати: "document without posting → posting is undefined"
  - Адаптувати: "document with posting object" та "document with empty posting object" — вже працюють, перевірити
- [ ] **fixtures/document.json** — видалити `"posting": true` з golden fixture. Оновити roundtrip тест якщо assertion зламається
- [ ] **find-references.test.ts** — додати тести для `postingMovement` та `postingValidation` reference kinds:
  - Документ з posting.movements → findReferences знаходить `postingMovement` ref на регістр
  - Документ з posting.validations → findReferences знаходить `postingValidation` ref на регістр
  - Документ без posting → findReferences не падає і не знаходить posting refs

### Generator PG (`packages/generator-pg`)

- [ ] **generate-table.test.ts** — замінити `posting: true` та `posting: false` у inline fixtures:
  - `posting: true` → видалити поле (або замінити на мінімальний posting object якщо тест потребує проведення)
  - `posting: false` → видалити поле

### UI (`apps/web`)

- [ ] **object-properties.tsx** — видалити Switch "Posting" з `DocumentTypeSettings`. Блок з `checked={!!o.posting}` та `onCheckedChange` повністю видаляється
- [ ] **ddl-store.ts** — додати валідацію posting refs за патерном `use-model-validation.ts`:
  - Перевірити `posting.movements[].register` існує в моделі
  - Перевірити `posting.validations[].register` існує в моделі
  - Повідомлення помилки аналогічне іншим ref-помилкам у DDL store

### Temp metadata

- [ ] **temp/metadata/documents/** — у всіх 4 файлах (`document-post`, `invoice-client`, `new-document3`, `new-document4`) видалити рядок `"posting": true,`

### Документація

- [ ] **BRD §5.3** — в таблиці замінити `| posting | Boolean | true | Підтримка проведення |` на `| posting | PostingConfig (optional) | — | Декларативний маппінг проведення (§5.3.1) |`
- [ ] **BRD §5.3.1** — замінити "Документи без секції posting працюють як раніше — тільки декларація зв'язку через registerMovements" на "Документи без секції posting є не-проведеними і не створюють рухів у регістрах"
- [ ] **metadata-model.md** — додати опис posting object: семантику, вплив на findReferences, зв'язок з registerMovements

## Clarify (питання перед імплементацією)

- [ ] **Що робити з `registerMovements` після переходу на posting object?**
  - Чому це важливо: `registerMovements` дублює інформацію з `posting.movements[].register` — обидва декларують зв'язок документа з регістрами
  - Варіанти: A) залишити registerMovements як окреме поле (для документів без детального маппінгу); B) registerMovements стає derived з posting.movements
  - Вплив на рішення: архітектура, серіалізація, UI
  - **Рекомендація:** залишити обидва поля на цьому етапі — registerMovements виконує "lightweight" декларацію зв'язку, posting — повний маппінг. Консолідацію розглянути окремо

## Рекомендовані патерни

### Posting як optional object
Замість union boolean | object, використовувати `postingSchema.optional()`. Перевірка "чи документ проведений" — через `doc.posting !== undefined`. Це єдиний canonical спосіб.

### Валідація posting refs у DDL store
Слідувати існуючому патерну `use-model-validation.ts` (рядки 137–162) — `typeof obj.posting === "object"` guard, потім iterate movements та validations.

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

### Цільовий стан (після задачі)
```
documentSchema.posting = postingSchema.optional()
```
- UI Switch видалений
- Тести покривають тільки object/undefined
- JSON fixtures без boolean posting
- findReferences: traversal + тести
- DDL store: валідує posting refs

## Файли для зміни (повний список)

| Файл | Дія |
|---|---|
| `packages/core/src/schemas/document.ts` | Змінити тип posting |
| `packages/core/src/__tests__/schemas.test.ts` | Видалити/переписати boolean тести |
| `packages/core/src/__tests__/fixtures/document.json` | Видалити `"posting": true` |
| `packages/core/src/__tests__/find-references.test.ts` | Додати posting ref тести |
| `packages/generator-pg/src/__tests__/generate-table.test.ts` | Адаптувати inline fixtures |
| `apps/web/src/components/properties/object-properties.tsx` | Видалити Switch "Posting" |
| `apps/web/src/stores/ddl-store.ts` | Додати posting ref validation |
| `temp/metadata/documents/document-post/document-post.meta.json` | Видалити posting |
| `temp/metadata/documents/invoice-client/invoice-client.meta.json` | Видалити posting |
| `temp/metadata/documents/new-document3/new-document3.meta.json` | Видалити posting |
| `temp/metadata/documents/new-document4/new-document4.meta.json` | Видалити posting |
| `docs/BRD-metadata-configurator.md` | Оновити §5.3 таблицю та §5.3.1 |
| `docs/architecture/metadata-model.md` | Додати posting object опис |

## Пов'язана документація

- `docs/BRD-metadata-configurator.md` §5.3, §5.3.1 — специфікація posting
- `docs/architecture/metadata-model.md` — модель метаданих
- `docs/tasks/phase2b-posting-engine.md` — батьківська задача
- `packages/core/src/schemas/posting.ts` — posting Zod-схеми (вже реалізовані)
- `packages/core/src/find-references.ts` — traversal (вже має posting, потребує тестів)
- `apps/web/src/hooks/use-model-validation.ts` — reference патерн для DDL store

## Definition of Done

- [ ] `posting` в documentSchema — `postingSchema.optional()`, без boolean union
- [ ] Жодного `posting: true` або `posting: false` у всій кодовій базі (grep clean)
- [ ] find-references.test.ts має тести для `postingMovement` та `postingValidation`
- [ ] DDL store валідує posting refs
- [ ] UI Switch "Posting" видалений з object-properties
- [ ] BRD §5.3 описує posting як PostingConfig (optional)
- [ ] metadata-model.md описує posting object
- [ ] `pnpm --filter @simetra/core test` — green
- [ ] `pnpm --filter @simetra/generator-pg test` — green
- [ ] `pnpm lint ; pnpm typecheck` — clean
