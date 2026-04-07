# Task: Posting Web Validation — виправлення залишкових дефектів

## Контекст

Code review реалізації Phase 2b (posting engine + posting fixes) виявив **три залишкових дефекти** у web-шарі (`apps/web`), які не покриваються задачею `phase2a-ddl-bugfixes.md` (generator scope). Всі три стосуються валідації та UX конструктора рухів:

1. **P2 (HIGH)** — `validateExpressionFields` перевіряє лише перший field-token у composite mapping expression (`row.qty * row.typo` → валідує тільки `row.qty`)
2. **P3 (HIGH)** — всі діалоги закриваються безумовно після Save, навіть якщо store відхилив дані (системний UI-патерн)
3. **P4 (MEDIUM)** — перевірка повноти dimensions у `use-model-validation.ts` та `ddl-store.ts` вимагає маппінг для УСІХ dimensions, а не тільки required/NOT NULL

### Зв'язок із попередніми задачами

- `phase2b-posting-fixes.md` **PROBLEM 6** (expression validation) — позначена виконаною `[X]`, але реалізація має баг з single `.match()`. Ця задача виправляє залишковий дефект
- `phase2b-posting-fixes.md` **PROBLEM 9** (ddl-store) — формулювання "NOT NULL dimensions", але реалізація перевіряє ВСІ dimensions. Ця задача приводить код у відповідність до специфікації
- Dialog close-on-failure — **нова проблема**, не згадана в жодній попередній задачі

### Масштаб змін

Всі зміни локалізовані в `apps/web/`. Жодних змін у `@simetra/core` чи `@simetra/generator-pg`.

---

## Вимоги

### FIX 1 — Multi-token expression validation (HIGH)

- [X] `apps/web/src/lib/expression-validation.ts`: функція `validateExpressionFields` — замінити одиночний `expr.match(/\bdoc\.(\w+)/)` на ітерацію по всіх збігах через `expr.matchAll(/\bdoc\.(\w+)/g)`
- [X] Аналогічно для `expr.match(/\brow\.(\w+)/)` → `expr.matchAll(/\brow\.(\w+)/g)`
- [X] Для кожного знайденого `doc.field` або `row.field` — перевіряти існування серед standard + custom attributes
- [X] Повертати помилку на **першому** невалідному полі (early return, як зараз)
- [X] Не змінювати `isExpressionInvalid` — вона вже використовує `.test()` з regex без `/g`, що коректно для source-incompatibility перевірки
- [X] Додати тести для `validateExpressionFields` у `apps/web/src/__tests__/expression-validation.test.ts`:
  - [X] `row.qty * row.price` — обидва поля існують → null
  - [X] `row.qty * row.nonexistent` — друге поле не існує → error
  - [X] `row.a + row.b - row.c` — три поля, третє не існує → error
  - [X] `doc.date` — стандартний реквізит документа → null
  - [X] `doc.nonexistent` — не існує → error
  - [X] `sum(Items.amount)` — ТЧ і поле існують → null (не змінюється)
  - [X] `literal:100` — без полів → null (не змінюється)
  - [X] `now()` — без полів → null (не змінюється)

### FIX 2 — Dialog save result check (HIGH)

- [X] Встановити конвенцію: `onSave` callback у діалогах повертає `ValidationError[] | null` (або `Promise<...>` якщо async)
- [X] `MovementConstructorDialog` (`apps/web/src/components/editor/movement-constructor-dialog.tsx`):
  - `handleSave` — перевіряти результат `onSave(movement)` перед викликом `onCancel()`
  - Якщо `onSave` повернув помилки — показати toast (через shadcn/ui Sonner) і **не закривати** діалог
  - Якщо `onSave` повернув `null` — закрити діалог як зараз
- [X] `movements-section.tsx` → `handleSaveMovement`:
  - Зберегти return value від `storeUpdateMovement(objectName, movement.register, movement)`
  - Повернути його як `ValidationError[] | null` для `onSave` callback
- [X] Застосувати той самий патерн до **всіх** діалогів, де store-метод повертає `ValidationError[] | null`:
  - `StandardAttributesDialog` — виправлено (обидві гілки: tabular + object)
  - `AdditionalIndexesDialog` — void-ланцюг через useFieldUpdate hook, потребує follow-up
  - `DataTypeEditorDialog` — void-ланцюг через батьківські callbacks, потребує follow-up
  - `RegisterPickerDialog` — void-ланцюг через батьківські callbacks, потребує follow-up
- [X] Оновити типізацію `onSave` callback у кожному діалозі
- [X] Додати тест для `MovementConstructorDialog`: store відхиляє → діалог залишається відкритим

### FIX 3 — Dimension required semantics (MEDIUM)

- [X] `apps/web/src/hooks/use-model-validation.ts` (рядок ~238) — диференціювати перевірку за типом регістру:
  - `AccumulationRegister` → вимагати маппінг для **УСІХ** dimensions (бізнес-обов'язкові для агрегації залишків/оборотів)
  - `InformationRegister` → вимагати маппінг тільки для dimensions з `required === true`
- [X] `apps/web/src/stores/ddl-store.ts` (рядок ~187) — ідентична зміна логіки:
  - `AccumulationRegister` → всі dimensions
  - `InformationRegister` → тільки `d.required === true`
- [X] Повідомлення про помилку має відрізнятися:
  - Для AR: `"Рух до {register}: не заповнені dimensions: {names}"` (як зараз)
  - Для IR: `"Рух до {register}: не заповнені обов'язкові dimensions: {names}"`
- [X] Додати тести:
  - AR з 2 dimensions (одна required, одна ні) — обидві мають бути в missing
  - IR з 2 dimensions (одна required, одна ні) — тільки required в missing

---

## Clarify (питання перед імплементацією)

- [ ] **FIX 2: Чи всі store-методи під діалогами вже повертають `ValidationError[] | null`?**
  - Чому це важливо: деякі `onSave` callbacks можуть бути `void` → потрібно додати return type
  - Варіанти: A — змінити type усіх `onSave` props / B — тільки ті, де store повертає errors
  - Вплив на рішення: обсяг змін типізації
  - **Рекомендація:** Перед імплементацією перевірити кожен діалог — які `onSave` вже мають return value, а які `void`. Якщо `void` — пропустити діалог у цій задачі, створити follow-up

- [ ] **FIX 3: Чи `register.kind` доступний у місці перевірки?**
  - Чому це важливо: в `use-model-validation.ts` та `ddl-store.ts` register знаходиться через `findRegisterInModel` — потрібно переконатися, що результат включає `kind`
  - Варіанти: `findRegisterInModel` повертає `{ kind, name, dimensions, ... }` або потрібен додатковий lookup
  - Вплив на рішення: чи потрібно змінювати `findRegisterInModel`

---

## Рекомендовані патерни

### matchAll для multi-token validation

Використовувати `String.matchAll(regex)` з прапорцем `/g` замість `String.match(regex)`. `matchAll` повертає ітератор по ВСІХ збігах, а `match` без `/g` — тільки перший. Ітерувати через `for...of` і перевіряти кожне поле:

```
for (const match of expr.matchAll(/\brow\.(\w+)/g)) {
  // перевірити match[1] серед attributes
}
```

**Важливо:** `matchAll` **вимагає** `/g` прапорець на regex — без нього кидає `TypeError`.

### Dialog save result convention

Єдина конвенція для всіх діалогів, що мутують store:

1. `onSave` callback має тип `(data: T) => ValidationError[] | null`
2. Діалог перевіряє результат:
   - `null` → успіх → закрити діалог
   - `ValidationError[]` → показати toast з першою помилкою → **не закривати**
3. Toast через Sonner (shadcn/ui `toast()` або `sonner.error()` — те, що вже є в проєкті)
4. Кнопка Save залишається enabled після store-rejection (щоб можна було повторити після виправлення)

Поточний патерн (для контексту — що замінюється):
```
// БУЛО: onSave → onCancel безумовно
handleSave = () => { onSave(data); onCancel() }

// СТАЛО: onSave → перевірка → закриття або toast
handleSave = () => {
  const errors = onSave(data)
  if (errors) { showToast(errors); return }
  onCancel()
}
```

### Dimension check диференціація

Використовувати `register.kind` для вибору стратегії фільтрації:
- `AccumulationRegister` — dimensions є **ключем агрегації**. Без повного набору запис не має бізнес-сенсу. Фільтруємо ВСІ dimensions
- `InformationRegister` — dimension може бути nullable (наприклад, "базова ціна" без розрізу по складу). Фільтруємо тільки `d.required === true`

Це відповідає доменній семантиці 1С: в регістрах накопичення всі виміри обов'язкові для формування підсумків, а в регістрах відомостей — ні.

---

## Антипатерни (уникати)

### ❌ Повна AST-розбірка для expression validation

Граматика `MAPPING_EXPR_PATTERN` у core **вже regex-based**. Створювати окремий парсер/AST для UI-валідації — overkill. `matchAll` із тим самим regex-стилем — достатній і консистентний підхід.

### ❌ Глобальний error boundary замість per-dialog check

Не перехоплювати store-помилки через React error boundary або глобальний middleware. Помилка валідації — це нормальний UX flow, а не exception. Діалог має сам обробити rejection і показати toast.

### ❌ Закриття діалогу з відкладеним toast

Не закривати діалог і потім показувати toast "щойно збережені дані невалідні". Якщо store відхилив — діалог залишається відкритим із draft-даними. Користувач бачить toast **у контексті** своєї помилки.

### ❌ Зміна store-методів для throw замість return errors

Store-методи (`updateMovement`, `addMovement`) зараз повертають `ValidationError[] | null`. Не змінювати їх на throw — це зламає Zustand/immer flow і вимагатиме try/catch по всій кодовій базі.

### ❌ Однакова логіка dimensions для всіх типів регістрів

Не фільтрувати dimensions однаково для AccumulationRegister та InformationRegister — вони мають різну доменну семантику. AccumulationRegister.dimensions — це завжди ключ агрегації. InformationRegister.dimensions — може мати nullable виміри.

### ❌ Дублювання `isPostingCompatible` або `findRegisterInModel`

Не створювати окремі helper-и — імпортувати існуючі з `@simetra/core` (`isPostingCompatible`) та store utils (`findRegisterInModel`).

---

## Архітектурні рішення

### Шари валідації posting (defense-in-depth)

```
Шар 1: UI client-side (movement-constructor-dialog)
  ├── isExpressionInvalid           — source incompatibility (row.* у doc source)
  ├── validateExpressionFields      — field existence (doc.field, row.field)  ← FIX 1
  └── Save button disabled          — при невалідних expressions

Шар 2: Store (metadata-store)
  └── Zod safeParse                 — schema-level validation
  └── Return ValidationError[]      — caller перевіряє результат  ← FIX 2

Шар 3: Model validation (use-model-validation.ts)
  └── Incomplete mappings warning   — dimension completeness  ← FIX 3
  └── Incompatible registers
  └── Non-numeric resources

Шар 4: DDL pre-generation (ddl-store.ts)
  └── Incomplete mappings blocking  — dimension completeness  ← FIX 3
  └── Incompatible registers
  └── Non-numeric resources

Шар 5: Generator (generate-posting.ts)
  └── throw Error                   — fail-fast на invalid input
```

### Dialog lifecycle (оновлена конвенція)

```
До:   open → edit → Save → onCancel (безумовно)
Після: open → edit → Save → check result → success? onCancel : toast
```

```
MovementConstructorDialog
  │
  ├── handleSave()
  │     ├── build PostingMovement
  │     ├── errors = onSave(movement)        ← return value перевіряється
  │     ├── if errors → toast.error(message)
  │     └── if null  → onCancel()
  │
  └── movements-section.tsx
        └── handleSaveMovement(movement)
              ├── errors = storeUpdateMovement(...)  ← return value зберігається
              └── return errors                      ← передається назад діалогу
```

### Dimension check flow

```
use-model-validation.ts / ddl-store.ts:

  reg = findRegisterInModel(model, movement.register)
  │
  ├── reg.kind === 'AccumulationRegister'
  │     └── missingDims = reg.dimensions.filter(d => !mapped[d.name])
  │         (всі dimensions — ключ агрегації)
  │
  └── reg.kind === 'InformationRegister'
        └── missingDims = reg.dimensions.filter(d => d.required && !mapped[d.name])
            (тільки required — nullable dimensions allowed)
```

---

## Порядок виконання

### Фаза 1: Expression validation fix (FIX 1)

- [X] Змінити `validateExpressionFields` у `expression-validation.ts`
- [X] Створити `apps/web/src/__tests__/expression-validation.test.ts` з тестами composite expressions
- [X] Переконатися, що існуючі тести `posting-validation.test.ts` і `ddl-store-posting.test.ts` не зламані
- [X] `pnpm --filter web test` — green

### Фаза 2: Dimension required fix (FIX 3)

- [X] Змінити фільтрацію в `use-model-validation.ts`
- [X] Змінити фільтрацію в `ddl-store.ts`
- [X] Додати/оновити тести для обох register kind
- [X] `pnpm --filter web test` — green

### Фаза 3: Dialog save convention (FIX 2)

- [X] `MovementConstructorDialog` — перевірка результату `onSave`
- [X] `movements-section.tsx` — повернення результату `storeUpdateMovement`
- [X] Поширити на інші діалоги (після перевірки, які store-методи повертають errors)
- [X] Додати тест на rejected save
- [X] `pnpm --filter web test` — green

### Фаза 4: Verification

- [X] `pnpm lint ; pnpm typecheck` — clean
- [X] `pnpm test` — all green

---

## Scope змін (файли)

| Файл | Fix | Зміни |
|------|-----|-------|
| `apps/web/src/lib/expression-validation.ts` | 1 | `.match()` → `.matchAll()` + loop по всіх doc/row tokens |
| `apps/web/src/__tests__/expression-validation.test.ts` | 1 | **Новий**: тести composite expressions |
| `apps/web/src/hooks/use-model-validation.ts` | 3 | Dimension filter: диференціація AR vs IR |
| `apps/web/src/stores/ddl-store.ts` | 3 | Dimension filter: диференціація AR vs IR |
| `apps/web/src/components/editor/movement-constructor-dialog.tsx` | 2 | `handleSave` → перевірка результату onSave |
| `apps/web/src/components/editor/movements-section.tsx` | 2 | `handleSaveMovement` → return errors |
| `apps/web/src/components/dialogs/standard-attributes-dialog.tsx` | 2 | Аналогічна перевірка (якщо store повертає errors) |
| `apps/web/src/components/dialogs/additional-indexes-dialog.tsx` | 2 | Аналогічна перевірка (якщо store повертає errors) |
| `apps/web/src/components/editor/data-type-editor-dialog.tsx` | 2 | Аналогічна перевірка (якщо store повертає errors) |
| `apps/web/src/components/editor/register-picker-dialog.tsx` | 2 | Аналогічна перевірка (якщо store повертає errors) |

---

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `docs/architecture/ui-components.md` — dialog lifecycle, editor, properties panel
- `docs/architecture/state-management.md` — metadata-store / ui-store межі
- `docs/architecture/patterns-and-decisions.md` — defense-in-depth validation layers
- `docs/BRD-metadata-configurator.md` §5.5 — InformationRegister (dimensions як ключові поля)
- `docs/BRD-metadata-configurator.md` §5.6 — AccumulationRegister (dimensions як аналітичні розрізи)
- `docs/BRD-metadata-configurator.md` §6 — attribute required field (default false)
- `docs/tasks/phase2b-posting-fixes.md` — PROBLEM 6 (expression validation), PROBLEM 9 (ddl-store blocking)
- `docs/tasks/phase2b-posting-engine.md` — original posting spec, arithmetic expressions
- `packages/core/src/schemas/posting.ts` — MAPPING_EXPR_PATTERN, граматика виразів
- `packages/core/src/schemas/attribute.ts` — required: z.boolean().default(false)
- `.github/instructions/ui-architecture.instructions.md` — dialog, state management правила
- `.github/instructions/architecture-core.instructions.md` — core package rules

---

## Definition of Done

### Expression validation
- [X] `validateExpressionFields("row.qty * row.nonexistent", ...)` повертає error для `row.nonexistent`
- [X] `validateExpressionFields("row.qty * row.price", ...)` повертає null (обидва існують)
- [X] `validateExpressionFields("row.a + row.b - row.c", ...)` перевіряє всі три поля
- [X] Тести composite expressions — green

### Dialog save convention
- [X] `MovementConstructorDialog` — store-rejection → діалог залишається відкритим + toast
- [X] `MovementConstructorDialog` — store-success → діалог закривається
- [X] Інші діалоги — аналогічна поведінка (де store повертає errors)

### Dimension required semantics
- [X] AccumulationRegister з optional dimension → dimension в missing list
- [X] InformationRegister з optional dimension → dimension НЕ в missing list
- [X] InformationRegister з required dimension → dimension в missing list

### Quality gate
- [X] `pnpm test` — all green
- [X] `pnpm lint ; pnpm typecheck` — clean
- [X] Жодних змін у `packages/core` або `packages/generator-pg`
