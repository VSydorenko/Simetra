# Task: Post-Review Fixes — Видалення legacy normalization, strict defaults, тестове покриття

## Контекст

Code review реалізації задачі `metadata-configurator-validation.md` виявив кілька проблем, які не покриті оригінальною специфікацією:

1. **Legacy normalization** — `normalizeLegacyAttribute` у `metadata-io.ts` нормалізує лише 2 з 4 strict rules (String length, Numeric precision/scale), але не торкається enum names та Ref без target. Об'єкти, що не проходять safeParse, мовчки відкидаються з моделі.
2. **Мертва гілка posting-compatibility** — параметр `recorder` опціональний, але жоден production caller не викликає без нього. Гілка `missingRecorderContext` — dead code.
3. **Прогалини тестового покриття** — нові strict rules (enum PascalCase, String length required, Numeric precision/scale required) не мають negative-тестів у core. Posting-compatibility тести не покривають recorderTypes enforcement. Web-тести для validateTechnicalName, tree rename rejection, DataTypeEditor blocking відсутні.
4. **Невалідні тестові дані** — файли в `temp/metadata/` містять кирилицю в enum names, String без length тощо.

### Ключова умова

**Легасі підтримувати не треба.** Зараз немає жодного робочого проєкту — все тестове. Дані в `temp/metadata/` можна видалити і перестворити. Це суттєво спрощує рішення: замість backward-compat normalization — просто видалити мертвий код і привести дані до strict стандартів.

### Зв'язок із задачами

- Базова задача: `docs/tasks/metadata-configurator-validation.md` — Phase 1/2/3 вже реалізовані
- Ця задача — cleanup і hardening після code review

---

## Вимоги

### Етап A: Видалення legacy normalization

- [ ] Видалити функцію `normalizeLegacyAttribute` з `packages/core/src/metadata-io.ts`
- [ ] Видалити функцію `normalizeLegacyAttributes` з `packages/core/src/metadata-io.ts`
- [ ] Видалити функцію `normalizeLegacyMetadataObject` з `packages/core/src/metadata-io.ts`
- [ ] Видалити виклик normalizer у `buildProjectModelFromParsed` (lenient mode branch ~L439-441)
- [ ] Видалити імпорти `STRING_LENGTH`, `NUMERIC_PRECISION`, `NUMERIC_SCALE` з metadata-io.ts, якщо вони більше не використовуються там
- [ ] Змінити default у `BuildModelOptions` з `strict: false` на `strict: true`
- [ ] Перевірити, що lenient mode все ще працює (без normalization, але з skip invalid objects + warnings) — це потрібно для CLI який може читати чужі файли
- [ ] Оновити або видалити тести в `metadata-io.test.ts`, що покладалися на normalization behavior

### Етап B: Виправлення тестових даних у temp/metadata

- [ ] `temp/metadata/enumerations/types-of-items/types-of-items.meta.json` — замінити кириличні enum value names на PascalCase Latin
- [ ] `temp/metadata/catalogs/items/items.meta.json` — додати `length` до всіх String-атрибутів, де його немає (~L36, L52, L85, L107)
- [ ] `temp/metadata/documents/document-post/document-post.meta.json` — додати `length` до String-атрибутів (~L58, L66)
- [ ] `temp/metadata/accumulation-registers/currencies-exchange-rates/currencies-exchange-rates.meta.json` — додати `length` до String-атрибуту (~L11)
- [ ] Після виправлень перевірити: `buildProjectModelFromParsed` у strict mode (новий default) успішно парсить усі файли без warnings

### Етап C: Posting-compatibility — видалення dead code

- [ ] Зробити параметр `recorder` **обов'язковим** у сигнатурі `isPostingCompatible` (видалити `?`)
- [ ] Видалити гілку `missingRecorderContext` (~L36-40) — жоден production caller не використовує
- [ ] Оновити тести в `posting-compatibility.test.ts` — усі виклики мають передавати recorder context
- [ ] Перевірити, що всі production call sites компілюються без змін (вони вже передають recorder):
  - `apps/web/src/hooks/use-model-validation.ts`
  - `apps/web/src/stores/ddl-store.ts`
  - `apps/web/src/components/editor/register-picker-dialog.tsx`
  - `packages/generator-pg/src/generate-posting.ts`

### Етап D: Core-тести — покриття strict rules

- [ ] У `packages/core/src/__tests__/schemas.test.ts`, секція `enumerationSchema`:
  - Тест: `enumValueSchema rejects non-PascalCase name` (кирилиця, snake_case, з пробілами)
  - Тест: `enumValueSchema rejects empty name`
  - Тест: `enumValueSchema accepts valid PascalCase name` (позитивний, якщо відсутній)
- [ ] У `packages/core/src/__tests__/schemas.test.ts`, секція `attributeSchema`:
  - Тест: `rejects String without length` — safeParse fail з описовим error
  - Тест: `rejects Numeric without precision` — safeParse fail
  - Тест: `rejects Numeric without scale` — safeParse fail
  - Тест: `accepts String with length` (позитивний, якщо відсутній)
  - Тест: `accepts Numeric with precision and scale` (позитивний, якщо відсутній)
- [ ] У `packages/core/src/__tests__/posting-compatibility.test.ts`:
  - Тест: `AccumulationRegister with matching recorderTypes → compatible`
  - Тест: `AccumulationRegister with mismatching recorderTypes → incompatible`
  - Тест: `AccumulationRegister with empty recorderTypes → compatible + warnings contains acceptsAnyRecorder`
  - Тест: assertions на **вміст warnings array**, не лише compatible/reason
  - Оновити test helpers щоб дозволяти кастомні `recorderTypes` (зараз завжди `[]`)

### Етап E: Web-тести — покриття UI validation

- [ ] Створити `apps/web/src/__tests__/validate-technical-name.test.ts`:
  - PascalCase: accept `Products`, `SalesOrder`, `A1` — reject `products`, `sales_order`, `Продукти`, `Product Name`, ``
  - snake_case: accept `line_items`, `a1` — reject `LineItems`, `line-items`, `рядки`, ``
- [ ] Розширити `apps/web/src/__tests__/data-type-editor-dialog.test.tsx`:
  - Тест: Save button disabled коли String обраний але length пустий
  - Тест: Save button disabled коли Numeric обраний але precision/scale пусті
  - Тест: при зміні типу на String — length ініціалізується defaults (50)
  - Тест: при зміні типу на Numeric — precision (15) і scale (2) ініціалізуються
- [ ] (Бажано) Integration-тест для posting-compatibility.test.ts: AccumulationRegister з recorderTypes mismatch → incompatible reason містить allowedRecorderTypes

---

## Clarify (питання перед імплементацією)

- [ ] **Lenient mode: залишати чи ні?**
  - Чому це важливо: після видалення normalization, lenient mode лише пропускає invalid objects з warning. Без normalization він слабший, але все ще корисний для CLI.
  - Варіанти: A) залишити lenient без normalization / B) видалити lenient mode повністю
  - Вплив на рішення: API `BuildModelOptions`, CLI behavior
  - Рекомендація: **A** — залишити, він дає graceful degradation для CLI readers

- [ ] **Тести metadata-io: що робити з normalization-specific тестами?**
  - Чому це важливо: є тести що перевіряють lenient load з auto-fill defaults (L294 metadata-io.test.ts). Після видалення normalization вони стають invalid.
  - Варіанти: A) видалити тести / B) переписати на нову поведінку (lenient load без normalization → objects з missing params відкидаються з warning)
  - Вплив на рішення: тестове покриття metadata-io
  - Рекомендація: **B** — переписати, щоб покрити нову поведінку

- [ ] **posting-compatibility.test.ts: test helpers з hardcoded recorderTypes: []**
  - Чому це важливо: helper `makeAccumulationRegister` завжди створює `recorderTypes: []`. Нові тести потребують кастомних recorderTypes.
  - Варіанти: A) додати параметр до helper / B) створювати об'єкт inline в кожному тесті
  - Вплив на рішення: читабельність тестів, DRY
  - Рекомендація: **A** — додати optional `overrides` параметр до test helper

---

## Рекомендовані патерни

### Видалення normalizer: incremental approach
Спершу видалити normalizer функції та їхній виклик. Потім запустити `pnpm --filter @simetra/core test` і виправити тести, що зламалися. Далі виправити `temp/metadata/`. Нарешті запустити повний `pnpm test && pnpm typecheck`.

### Test helpers з overrides
Для posting-compatibility test helpers використовувати патерн:
```
makeAccumulationRegister(overrides?: Partial<AccumulationRegister>)
```
Це дозволить кастомізувати `recorderTypes`, `registerType` тощо без дублювання boilerplate.

### Core test negative assertions
Для negative tests перевіряти не лише `success: false`, але і `error.issues[0].path` та `error.issues[0].message` — це гарантує, що помилка виникає через правильну причину з правильним повідомленням.

### Web test: validateTechnicalName
Це pure function без side effects — тестувати як unit test, без mounting React components.

---

## Антипатерни (уникати)

### ❌ Часткове видалення normalizer
Не залишати одну з трьох `normalizeLegacy*` функцій "на всяк випадок". Або видалити всі три, або залишити всі — напівходки створюють confusing behavior.

### ❌ Зміна strict default без виправлення тестових даних
Якщо зробити `strict: true` default, але не виправити `temp/metadata/`, то integration-тести зламаються. Етапи A і B мають виконуватися разом.

### ❌ Додавання нових тестів без виправлення test helpers
Якщо posting test helpers завжди створюють `recorderTypes: []`, нові тести для recorderTypes enforcement не працюватимуть. Спершу оновити helpers.

### ❌ Тестування лише happy path для strict rules
Кожен новий strict rule (enum PascalCase, String length, Numeric precision/scale) потребує як мінімум один **negative** тест (rejection case). Позитивних тестів недостатньо.

### ❌ Видалення lenient mode повністю
CLI може читати metadata з зовнішніх джерел — lenient mode дає graceful degradation. Видалення normalization ≠ видалення lenient mode.

---

## Архітектурні рішення

```
Поточний стан (до цієї задачі):
─────────────────────────────────
JSON files → parseMetadataFiles → normalizeLegacy* → safeParse (lenient)
                                  ↑ заповнює defaults    ↑ відкидає invalid
                                  ↑ ВИДАЛИТИ              ↑ залишити

Цільовий стан (після цієї задачі):
───────────────────────────────────
JSON files → parseMetadataFiles → safeParse (strict default)
                                  ↑ відхиляє invalid одразу

Lenient mode (для CLI):
───────────────────────
JSON files → parseMetadataFiles → safeParse (lenient) → skip invalid + warning
                                  ↑ БЕЗ normalization
                                  ↑ invalid objects НЕ потрапляють у model
```

### Матриця змін по файлах

| Файл | Що змінюється |
|------|--------------|
| `packages/core/src/metadata-io.ts` | Видалити 3 normalizer функції, їхній виклик, змінити BuildModelOptions default |
| `packages/core/src/posting-compatibility.ts` | Зробити `recorder` required, видалити dead branch |
| `packages/core/src/__tests__/schemas.test.ts` | Додати negative tests: enum, String, Numeric |
| `packages/core/src/__tests__/posting-compatibility.test.ts` | Оновити helpers, додати recorderTypes tests |
| `packages/core/src/__tests__/metadata-io.test.ts` | Переписати normalization tests на нову поведінку |
| `temp/metadata/enumerations/types-of-items/...` | PascalCase enum names |
| `temp/metadata/catalogs/items/...` | Додати String length |
| `temp/metadata/documents/document-post/...` | Додати String length |
| `temp/metadata/accumulation-registers/...` | Додати String length |
| `apps/web/src/__tests__/validate-technical-name.test.ts` | Новий файл — unit tests |
| `apps/web/src/__tests__/data-type-editor-dialog.test.tsx` | Розширити: save blocking, defaults init |

---

## Пов'язана документація

- `docs/tasks/metadata-configurator-validation.md` — оригінальна задача, Phase 1-3
- `docs/architecture/metadata-model.md` — модель метаданих
- `docs/architecture/state-management.md` — store contract, validation flow
- `docs/architecture/storage-and-persistence.md` — metadata file layout, write-path behavior
- `docs/BRD-metadata-configurator.md` секція 6 — система типів полів
- `packages/core/src/schemas/attribute.ts` — attributeSchema з superRefine
- `packages/core/src/schemas/enumeration.ts` — enumValueSchema
- `packages/core/src/posting-compatibility.ts` — posting contract
- `packages/core/src/metadata-io.ts` — парсинг, нормалізація, model builder
- `.github/instructions/metadata-model.instructions.md` — правила Zod-схем

---

## Definition of Done

### Обов'язкові
- [ ] `normalizeLegacyAttribute`, `normalizeLegacyAttributes`, `normalizeLegacyMetadataObject` видалені з metadata-io.ts
- [ ] `BuildModelOptions.strict` default змінено на `true`
- [ ] Параметр `recorder` в `isPostingCompatible` обов'язковий, dead branch видалено
- [ ] Усі файли в `temp/metadata/` проходять strict safeParse без warnings
- [ ] Core negative tests: enum PascalCase rejection, String без length, Numeric без precision/scale
- [ ] Core posting tests: recorderTypes match/mismatch/empty з assertions на warnings
- [ ] Web validate-technical-name.test.ts: PascalCase і snake_case coverage
- [ ] Web data-type-editor-dialog.test.tsx: save blocking і defaults init
- [ ] `pnpm test` — green
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm lint` — без помилок

### Бажані
- [ ] metadata-io.test.ts: переписані тести на нову lenient behavior (skip without normalization)
- [ ] Lenient mode працює без normalization: invalid objects → warning + skip
