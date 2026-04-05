# Task: Phase 1 Closure — Виправлення за результатами код-ревью

## Контекст

Код-ревью Phase 1 Closure Backlog виявило проблеми різної критичності. Усі виправляються в рамках Phase 1 без переносу на Phase 2. Задача охоплює: data-loss bug у parser constants, implicit restore після ZIP import, UI/core drift для Constant Ref, i18n drift у formatReference, $schema URL drift, та покриття тестами.

> **Примітка:** Стандартні реквізити табличних частин (колишній Fix 4) винесені в окрему задачу: `docs/tasks/standard-attributes-comprehensive.md`

## Вимоги

### Fix 1: Constants wrapper parser fallback (CRITICAL — data loss)

- [ ] У `parseFileStructure` (`apps/web/src/storage/web-storage.ts`): коли `constantsFileSchema.safeParse` для wrapper фейлиться — розпакувати `wrapperResult.data.constants` (або сиру JSON-масу `.constants`) **поелементно** через `constantSchema.safeParse` на кожному елементі
- [ ] Валідні елементи → у `parsed.objects`, невалідні → у `warnings` з адресою `constants[i]` та деталізацією помилки
- [ ] Happy path (wrapper schema passes): елементи з `wrapperResult.data.constants` вже пройшли `z.array(constantSchema)` на рівні wrapper — додаткова поелементна валідація не потрібна
- [ ] Додати regression test: wrapper з 3 constants, один broken → 2 повертаються у model, 1 warning з коректною адресою

### Fix 2: ZIP import — persisted origin у SessionData (повна реалізація)

- [ ] Додати поле `origin?: ProjectOrigin` до `SessionData` interface у `apps/web/src/storage/session-db.ts`
- [ ] Розширити сигнатуру `saveSession` для прийому `origin`
- [ ] Оновити всі 5 callsites `saveSession` у `apps/web/src/stores/project-store.ts` — передавати актуальний `projectOrigin`:
  - `saveProject` → `"directory"`
  - `openProject` → `"directory"` або `"zip-import"` (залежно від handle)
  - `importProject` → `"zip-import"`
  - `restoreSession` (handle branch) → `"directory"`
  - `requestDirectoryPermission` → `"directory"`
- [ ] У `restoreSession` (null-handle branch): читати `session.origin` замість hardcoded `"zip-import"`, використовувати його для `projectOrigin`
- [ ] Прибрати `projectOrigin === "zip-import"` з умови `showWelcome` у `apps/web/src/components/layout/editor-panel.tsx` — ця умова зараз **включає** Welcome Screen для zip-import навіть після restore; без неї ZIP-проєкт після restore працює як повноцінний відкритий проєкт (editor відразу видимий)
- [ ] Оновити `SessionMeta` у `welcome-screen.tsx`: додати `origin` і використовувати для кращого UX повідомлення (розрізняти ZIP session і draft)
- [ ] Маппінг origin для кожного callsite `saveSession`: `"directory"`, `"zip-import"` persist-яться; `"new"` і `"draft-recovery"` — НЕ persist-яться, бо ці стани не зберігаються як session (newProject не викликає saveSession, restoreDraft не викликає saveSession)
- [ ] Backward compatibility: якщо `origin` відсутній у збереженій session (legacy), виводити з наявності/відсутності `projectHandle`
- [ ] Додати тест на збереження та відновлення origin через saveSession/loadSession

### Fix 3: Constant UI — заборонити Ref у FieldTypeSelect

> **Примітка:** Core-level fix вже виконаний: `constantValueTypeSchema = fieldTypeSchema.exclude(["Ref"])` у `packages/core/src/schemas/constant.ts`. Цей fix стосується тільки UI — щоб dropdown не показував заборонений варіант.

- [ ] Додати prop `excludeTypes?: FieldType[]` у `FieldTypeSelect` (`apps/web/src/components/editor/field-type-select.tsx`)
- [ ] Фільтрувати options на рівні рендерингу: не показувати типи з `excludeTypes`
- [ ] У `ConstantTypeSettings` (`apps/web/src/components/properties/object-properties.tsx`) передати `excludeTypes={["Ref"]}` у `FieldTypeSelect`
- [ ] Перевірити, що Zod-валідація у store залишається як fallback safety net — НЕ видаляти

### Fix 5: formatReference — перенести presentation logic у UI

- [ ] У `packages/core/src/find-references.ts`: змінити `formatReference` щоб повертав структуру `{ fieldName: string | undefined; tabularSectionName: string | undefined; referenceKind: ReferenceKind }` замість готового display string
- [ ] Видалити старий `formatReference` string-based (breaking change прийнятний — єдиний споживач `apps/web`)
- [ ] У `apps/web/src/components/editor/where-used-dialog.tsx`: замінити `formatReference(ref)` на `fieldName` / `tabularSectionName` для колонки Field; колонка Ref Kind вже використовує `t(referenceKind.*)` — зберегти
- [ ] У `apps/web/src/components/layout/tree-panel.tsx` (delete confirm): формувати текст через `t(referenceKind.*)` + field info замість `formatReference`
- [ ] У `apps/web/src/lib/find-references.ts`: оновити реекспорт
- [ ] Видалити `REFERENCE_KIND_LABELS` з core (hardcoded English labels)
- [ ] Перевірити i18n ключі `referenceKind.*` у `apps/web/src/i18n/locales/uk.json` і `en.json` — вони вже існують, переконатись що повні
- [ ] Оновити тести `formatReference` у `packages/core/src/__tests__/find-references.test.ts` під нову структуру

### Fix 6: $schema URL — нормалізація version формату

- [ ] У `buildSchemaUrl` (`packages/core/src/serialization.ts`): нормалізувати schemaVersion — `.0` minor → тільки major (BRD правило: `v1` для `1.0`, `v1.1` для `1.1`)
- [ ] Оновити enrichment тести у `schemas.test.ts`: змінити очікування з `v1.0` на `v1`
- [ ] Перевірити, що roundtrip тести з fixtures (які вже використовують `v1`) проходять без змін
- [ ] `temp/metadata/` — не чіпати (dev sandbox, $schema додається при serialize-time)

### Fix 7: Test coverage — regression та integration тести

- [ ] **parseFileStructure + buildProjectModel**: тест broken constants wrapper (з Fix 1), тест legacy array format, тест валідного wrapper
- [ ] **Session restore flow**: тест saveSession з origin, тест loadSession з origin, тест backward compatibility (session без origin)
- [ ] **Session restore implicit/explicit**: тест що null-handle session з origin "zip-import" коректно restore-ить і ставить правильний projectOrigin
- [ ] **FieldTypeSelect excludeTypes**: тест що Ref не рендериться з `excludeTypes={["Ref"]}`
- [ ] **formatReference нова структура**: тест що повертає `{ fieldPath, referenceKind }` замість string
- [ ] **$schema URL нормалізація**: тест що `1.0` → `v1`, `1.1` → `v1.1`, `2.0` → `v2`

## Clarify (питання перед імплементацією)

> Питання про StdAttrs ТЧ винесено в окрему задачу: `docs/tasks/standard-attributes-comprehensive.md`

## Рекомендовані патерни

### Graceful degradation для масивів у wrapper
Коли Zod-схема масиву фейлиться — ітерувати поелементно через `.safeParse()` на кожному item. Валідні зберігати, невалідні — у warnings з індексом. Не використовувати all-or-nothing підхід для user data.

### Persisted origin у session
Origin зберігається як optional string у IndexedDB. Backward compatibility через fallback: якщо `origin` відсутній, виводити з `projectHandle !== null → "directory"`, інакше `null`. Не ламати існуючі sessions.

### excludeTypes prop для type selectors
Генеричний prop `excludeTypes` замість domain-specific `isConstant` прапорця. Дозволяє перевикористати pattern для майбутніх обмежень без зміни API компонента.

### Структурний return замість display string у core
Core повертає структуровані дані (об'єкт з полями), UI форматує через i18n. Core ніколи не повинен генерувати human-readable текст — це порушує SRP і блокує локалізацію.

### URL version нормалізація
Правило: `major.0` → `vMajor`, `major.minor` (minor > 0) → `vMajor.Minor`. Тобто trailing `.0` відсікається. Узгоджено з BRD §7.7 (приклади: `/schemas/v1/`, `/schemas/v1.1/`).

### Іменування полів у структурних return values
Переважати конкретні імена (`fieldName`, `tabularSectionName`, `referenceKind`) замість абстрактних (`fieldPath`, `context`). Конкретні імена self-documenting і не потребують коментарів.

## Антипатерни (уникати)

### ❌ All-or-nothing парсинг user data
Один невалідний елемент масиву не повинен відкидати весь файл. Це призводить до silent data loss при імпорті.

### ❌ Hardcoded presentation text у core
Core (`@simetra/core`) — чистий TS без UI. Display labels, форматування для UI, локалізація — це відповідальність `apps/web`. Поточний `REFERENCE_KIND_LABELS` у `find-references.ts` — порушення цього принципу.

### ❌ Implicit state restore без persisted context
Якщо restore flow потребує контексту (origin, permissions), цей контекст має бути persisted разом із session. Виведення origin з runtime heuristics (є handle → directory, немає → zip) крихке.

### ❌ UI показує варіанти, заборонені доменною моделлю
Якщо Zod-схема забороняє значення, UI не повинен його показувати. Runtime validation у store — safety net, а не замінник коректного UI.

## Архітектурні рішення

### Data flow для Fix 1 (constants parser)

```
constants.meta.json
  → JSON.parse
  → constantsFileSchema.safeParse(wrapper)
    ✓ success → extract constants array → push all to parsed.objects
    ✗ failure → iterate wrapper.constants[]
      → constantSchema.safeParse(item)
        ✓ → push to parsed.objects
        ✗ → push to warnings with constants[i] address
```

### Session origin persistence (Fix 2)

```
saveSession(handle, model, version, origin?)
  → IndexedDB { ...session, origin }

restoreSession()
  → loadSession()
  → session.origin ?? inferFromHandle(session.projectHandle)
  → set projectOrigin
```

### formatReference refactor (Fix 5)

```
[BEFORE] core: formatReference(ref) → "field_name (ref)"
[AFTER]  core: formatReference(ref) → { fieldName: "field_name", tabularSectionName: undefined, referenceKind: "attributeRef" }
         UI:   t(`referenceKind.${ref.referenceKind}`) + fieldName
```

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура монорепо
- `docs/BRD-metadata-configurator.md` — бізнес-вимоги:
  - §5.8 — стандартні реквізити табличної частини
  - §6.1 — система типів полів
  - §7.6–7.7 — правила `$schema` URL та версіонування
- `docs/phase1-known-limitations.md` — відомі обмеження Phase 1 (Constant Ref exclusion)
- `docs/tasks/phase1-closure-backlog.md` — початкова задача Phase 1 бэклогу
- `.github/instructions/architecture-core.instructions.md` — правило: core без UI залежностей
- `.github/instructions/coding-style.instructions.md` — naming conventions
- `.github/instructions/metadata-model.instructions.md` — правила роботи з Zod-схемами

## Scope файлів (орієнтовний)

| Fix | Файли |
|-----|-------|
| 1 | `apps/web/src/storage/web-storage.ts`, тести |
| 2 | `apps/web/src/storage/session-db.ts`, `apps/web/src/stores/project-store.ts`, `apps/web/src/components/layout/editor-panel.tsx`, `apps/web/src/components/editor/welcome-screen.tsx`, тести |
| 3 | `apps/web/src/components/editor/field-type-select.tsx`, `apps/web/src/components/properties/object-properties.tsx`, тести |
| 5 | `packages/core/src/find-references.ts`, `apps/web/src/components/editor/where-used-dialog.tsx`, `apps/web/src/components/layout/tree-panel.tsx`, `apps/web/src/lib/find-references.ts`, `packages/core/src/__tests__/find-references.test.ts`, `apps/web/src/i18n/locales/uk.json`, `apps/web/src/i18n/locales/en.json` |
| 6 | `packages/core/src/serialization.ts`, `packages/core/src/__tests__/schemas.test.ts` |
| 7 | `apps/web/src/__tests__/` (нові та оновлені файли) |

## Поза scope цієї задачі

- **Block C (View state detach/attach)** — задокументовано у `docs/phase1-known-limitations.md` як known limitation Phase 1. Рішення в Phase 2 якщо потрібно.
- **Blocks E1–E7 (компонентні тести web layer)** — широкий scope тестів (Window Manager, Shell hotkeys, Command Palette) не є наслідком знайдених багів. Regression тести для конкретних фіксів (Fix 7) покривають необхідний мінімум.

## Definition of Done

- [ ] Fix 1: broken constants wrapper → валідні siblings збережені, точні warnings
- [ ] Fix 2: origin persisted у IndexedDB, restore flow використовує persisted origin, Welcome Screen коректний для всіх scenarios
- [ ] Fix 3: Ref не з'являється у FieldTypeSelect для Constant
- [ ] Fix 5: core повертає структуру, UI форматує через i18n, delete confirm локалізований
- [ ] Fix 6: `schemaVersion 1.0` → URL `/schemas/v1/`, відповідно до BRD §7.7
- [ ] Fix 7: regression тести для кожного fix проходять
- [ ] `pnpm lint` — без помилок
- [ ] `pnpm typecheck` — без помилок
- [ ] `pnpm test` — всі тести проходять
- [ ] `docs/phase1-known-limitations.md` оновлений (видалити вирішені обмеження)
