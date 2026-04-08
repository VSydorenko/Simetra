# Task: Phase 4 — Application Shell & Configured Runtime

> **Prerequisite:** Runtime foundation already implemented and documented in [../architecture/runtime-architecture.md](../architecture/runtime-architecture.md) and [../architecture/OVERVIEW.md](../architecture/OVERVIEW.md): `@simetra/form-runtime`, `@simetra/app-runtime` (fallback mode), `@simetra/data-provider` + PostgREST adapter працюють end-to-end.
> **Prerequisite:** Phase 2 DDL pipeline: metadata → SQL → PostgreSQL → PostgREST — має бути end-to-end.

## Контекст

Поточний runtime baseline зафіксований у [../architecture/runtime-architecture.md](../architecture/runtime-architecture.md) та [../architecture/OVERVIEW.md](../architecture/OVERVIEW.md): unified `@simetra/app-runtime` уже надає fallback mode з flat навігацією по kinds з `ProjectModel`, default `SidebarWithHeader` shell, стандартними list/item pages і `InMemoryDataProvider` для dev preview без БД.

Phase 4 розширює **той самий пакет** до production-ready configured mode: subsystems, configurable shell layouts, dashboard widgets, theming — все контролюється через `application.meta.json`.

**Ціль Phase 4:** Перехід від fallback до configured mode у `@simetra/app-runtime`. Розробник описує структуру додатку в `application.meta.json` — і отримує повноцінний SPA з підсистемами, dashboard-ом і брендованим shell.

**Ключовий принцип — progressive configuration (convention-over-configuration):**

| `model.application` | `.subsystems` | `.dashboard` | Поведінка |
|---|---|---|---|
| `undefined` | — | — | **Phase 3 fallback:** flat nav by kind, default shell |
| present | `[]` empty | `undefined` | **Branded flat:** Phase 3 flat nav + theme/logo/shell config |
| present | `[...]` non-empty | `undefined` | **Configured nav:** grouped sidebar, `/` = redirect на першу підсистему |
| present | `[...]` non-empty | `{widgets: [...]}` | **Full configured:** grouped sidebar, `/` = dashboard page |
| present | `[]` empty | `{widgets: [...]}` | **Dashboard-only:** flat nav, `/` = dashboard page |

**Backward compatibility:** жодна Phase 3 feature не ламається. `<SimetraApp model={m} dataProvider={dp} />` де `model.application` = `undefined` — продовжує працювати як раніше.

### Що НЕ входить у цю фазу

- Codegen React App (`simetra generate --target react-app`) — Phase 5
- Generated .NET / Node.js API backend — Phase 5
- Desktop Tauri shell — Phase 5+
- VS Code extension — Phase 5+
- Form designer (visual drag-and-drop для form.json) — Phase 5+
- Auth/RBAC UI — Phase 5+
- Розширення `DataProvider` interface (aggregate API) — Phase 5

### Монорепо-контекст

```
packages/
├── core/                       ← розширюється: application.meta.json Zod-схеми, generic lenient validation
├── app-runtime/                ← розширюється: path module, configured routing, shell layouts, theme, dashboard
├── form-runtime/               ← без змін (library рендерингу форм)
├── data-provider/              ← без змін (Phase 4 працює на існуючому contract)
├── data-provider-postgrest/    ← без змін
├── ui/                         ← без змін (shadcn/ui примітиви + globals.css design tokens)
├── generator-api/              ← без змін
├── generator-pg/               ← без змін (generator-pg ігнорує model.application — це metadata-only)
└── cli/                        ← розширюється: read-metadata.ts читає application.meta.json
apps/
├── web/                        ← розширюється: EditorTarget refactor, підсистеми, Application editor
└── runtime/                    ← thin host, БЕЗ ЗМІН (core parser автоматично повертає model.application)
```

---

## Ключові архітектурні рішення

### R1. Єдине джерело істини — `ProjectModel.application`

`ProjectModel.application` (optional) є **єдиним** canonical source для application config. `SimetraApp` читає `model.application` напряму — **без** окремого `applicationConfig` prop.

**Обґрунтування:** Forms уже працюють за цим патерном — один pipeline parse → serialize → undo → dirty → save. Окремий prop створює two-source-of-truth ризик.

**Thin host не потребує змін:** Vite plugin (`vite-metadata-plugin.ts`) уже рекурсивно індексує всі `.json`. Host уже викликає `parseMetadataFiles()` → `buildProjectModelFromParsed()`. Якщо core навчиться парсити `application.meta.json` в `ProjectModel.application`, host автоматично передасть його через `model`.

### R2. Shell layouts і widgets — в `app-runtime`

Shell layouts (`SidebarWithHeader`, `TopNavWithTabs`, `MinimalSidebar`) і dashboard widgets — **domain компоненти**, не generic UI primitives. Вони живуть у `@simetra/app-runtime`, не в `@workspace/ui`.

**Підтвердження:** BRD §10.6.4 прямо каже "React-компонент у `@simetra/app-runtime`". Поточний код уже тримає `SidebarLayout` у `packages/app-runtime/src/shell/`.

### R3. URL contract — повний ієрархічний шлях, subsystem як navigation context

| Сегмент | Джерело | Перетворення | Приклад |
|---|---|---|---|
| subsystem | `subsystem.name` | `toKebabCase()` | `sales_management` → `sales-management` |
| nested subsystem | child `subsystem.name` | `toKebabCase()` | `orders` → `orders` |
| object | `object.name` (PascalCase) | `toKebabCase()` | `SalesOrder` → `sales-order` |
| id | record UUID | as-is | `550e8400-...` |

**Рішення (закрите):** URL для вкладених підсистем включає **повний ієрархічний шлях**, а не лише leaf slug.

**Обґрунтування:** Leaf-only slug має ризик колізій (наприклад `orders` у `sales` і `orders` у `warehouse`). Повний шлях гарантує унікальність, тривіальні breadcrumbs і прозорий navigation context. При reorganize URL змінюється — це **правильна семантика**: URL = navigation context, не canonical identity.

Configured mode routes:
```
/                                                    → Dashboard або flat home
/{subsystem-slug}                                    → Subsystem landing
/{subsystem-slug}/{object-slug}                      → List page
/{subsystem-slug}/{object-slug}/new                  → Create page
/{subsystem-slug}/{object-slug}/:id                  → Edit page
/{parent-slug}/{child-slug}/{object-slug}            → Nested subsystem list
/{parent-slug}/{child-slug}/{object-slug}/new        → Nested subsystem create
/{parent-slug}/{child-slug}/{object-slug}/:id        → Nested subsystem edit
/constants                                           → Constants page (canonical)
/settings                                            → Redirect → /constants
```

Fallback mode зберігає Phase 3 маршрути `/{kind-slug}/{object-slug}` без змін.

**Router implementation:** Configured mode використовує splat route `/*` — app-runtime програмно резолвить segments замість фіксованих `:param` рівнів. Fallback mode зберігає фіксовані `:kindSlug/:objectSlug` routes.

**Multi-membership:** Один об'єкт доступний через декілька subsystem URL-ів. URL стає navigation context, не canonical identity. Breadcrumbs і sidebar highlight показують поточний subsystem context.

### R4. Multi-membership — один об'єкт у кількох підсистемах

Один metadata object може входити в **довільну кількість** підсистем. Це стандартна бізнес-практика (аналог 1С:Підприємство).

- Source of truth для membership: `subsystem.objects[]` (на стороні підсистеми, не об'єкта)
- Об'єкти, не включені в жодну підсистему — автоматично потрапляють у синтетичну групу "Інше" в runtime sidebar
- "Інше" не є окремою підсистемою в `application.meta.json` — це runtime-only UI construct

### R5. Ієрархічні підсистеми

Підсистеми підтримують вкладеність (nested subsystems), як у конфігураторі 1С:Підприємство (наприклад: Деньги → Банк, Касса). Zod-схема використовує `z.lazy()` для рекурсії.

### R6. Підсистеми в дереві конфігуратора (1С-модель)

Два взаємодоповнюючі UI surfaces для subsystem membership:

1. **Дерево метаданих:** "Підсистеми" — перша top-level секція (перед Catalogs, Documents...). Клік по підсистемі → SubsystemEditor з editor-ом об'єктів (чекбокси).
2. **ObjectEditor vertical tab:** Для **всіх 7 metadata kinds** — вкладка "Підсистеми" з деревом підсистем і чекбоксами.

Інвертована мутація: чекбокс в ObjectEditor технічно мутує `subsystem.objects[]` в `model.application.subsystems`, а не сам об'єкт.

### R7. Validation boundary

| Шар | Що перевіряє | Де |
|---|---|---|
| `applicationSchema` | Data shape: types, format, enums, defaults | `packages/core/src/schemas/application.ts` |
| `projectModelSchema.superRefine` | Cross-model: ref existence, subsystem name uniqueness, widget refs | `packages/core/src/schemas/project-model.ts` |

Lenient mode: application validation issues деградують у warnings — **повне відкидання application** з fallback до Phase 3 mode, а не часткове застосування. Це принципова відмінність від forms (де кожна форма незалежна): application = shell/routing contract, часткове застосування дасть непередбачувану поведінку.

### R8. Централізований Path module у app-runtime

**Проблема:** Поточний runtime дублює kind-slug knowledge між `router-builder.tsx`, `navigation-builder.ts` і `resolve-object.ts`. Display name fallback і path construction дублюються в pages і breadcrumbs. Phase 4 додає subsystem layer, що розмножить це дублювання до ~8 місць.

**Рішення:** Єдиний `packages/app-runtime/src/paths.ts` module з canonical API:
- `buildListPath(mode, ...)` / `buildItemPath(mode, ...)` / `buildCreatePath(mode, ...)` / `buildBackPath(mode, ...)`
- `resolveObjectFromSlug(model, kindSlug, objectSlug)` — slug → MetadataRef
- `RUNTIME_KIND_CONFIG` — single canonical map kind → slug, collectionKey, icon, label
- `mode: 'flat' | 'subsystem'` визначається наявністю `model.application.subsystems`

Router, navigation builder, pages, breadcrumbs — всі використовують **тільки** paths module. Дублювання усувається.

### R9. EditorTarget — generic editor identity у configurator

**Проблема:** UI configurator має жорстко object-centric модель: `TabItem` union знає лише `ObjectTab | SqlPreviewTab`. `FloatingWindow` має `objectRef` напряму. Editor routing — ternary chain. Properties panel працює від `selectedObject`. Dirty tracking тримає ключі тільки як `kind/name`. Для Application/Subsystem editors цього **недостатньо** — потрібен повноцінний рефакторинг, а не ще два special case.

**Рішення:** Ввести `EditorTarget` union — canonical editor identity для всіх editor surfaces:
- `{ type: 'object', ref: MetadataRef }` — замінює поточний `ObjectTab.objectRef`
- `{ type: 'application' }` — singleton
- `{ type: 'subsystem', path: string[] }` — з payload для ієрархії
- `{ type: 'sql-preview' }` — singleton

**Що змінюється:**
- `TabItem`: розширений union, `objectRef` → `target: EditorTarget`, `activeSection` стає optional capability
- `FloatingWindow`: `objectRef` → `target: EditorTarget` (або закріпити обмеження: floating = лише objects)
- Editor routing: ternary → registry `tab.target.type → React.ComponentType`
- Properties panel: resolution через `activeEditorTarget` замість тільки `selectedObject`
- Tree activation: explicit branches для `subsystem`, `application` node types замість default object fallback

**Обґрунтування:** Phase 5 принесе form designer editor — ще один non-object editor. Без generic identity з'являться 5+ special cases. Рефакторинг робиться **зараз** як infrastructure, щоб кожна наступна фіча просто підключалася в ready framework.

### R10. Unified EditorKey для dirty tracking

**Проблема:** `objectVersions` Map у metadata-store тримає ключі як `kind/name`. `useIsObjectDirty` приймає лише `MetadataRef`. Tab bar показує dirty тільки для object tabs. Non-object entities (Application, Subsystem) не мають dirty indicator.

**Рішення:** `EditorKey` — canonical string derived від `EditorTarget`:
- Objects: `Catalog/Products` (ідентичний до поточного — backward compat)
- Application: `Application/_` (synthetic singleton)
- Subsystem: `Subsystem/sales` або `Subsystem/sales/orders` (path-based)

Helper `editorTargetToKey(target: EditorTarget): string` використовується для:
- `objectVersions` map key (перейменувати семантично чи залишити ім'я, розширивши контракт)
- Tab dirty resolution — через `editorTargetToKey(tab.target)` замість `tab.id`
- Save baseline comparison у `project-store.lastSavedObjectVersions`

Application mutations (`updateApplication`, `updateTheme`, `addSubsystem` тощо) bumps `Application/_` key.

### R11. Generic lenient validation у core

**Проблема:** Lenient mode для forms у `metadata-io.ts` — hard-coded двошаровий fallback: per-file pre-validation + schema-level check `path[0] === 'forms'`. Для application потрібна аналогічна поведінка, але додавати ще один hard-coded блок — шлях до нерозширюваного коду.

**Рішення:** Виділити generic optional-section mechanism у `buildProjectModelFromParsed`:
- Список `OPTIONAL_SECTIONS` (зараз: `'forms'`, `'application'`): ключі top-level полів ProjectModel, які при invalid data деградують у warnings замість fatal
- safeParse ProjectModel → якщо fail → перевірити, чи всі issues під одним із optional section keys → видалити ці sections, retry, emit warnings
- Для application per-file pre-validation **не потрібна** (один root file)
- Семантика application fallback: **повне відкидання** → `model.application = undefined`, warnings видаються, runtime → fallback mode

### R12. Shared Theme contract між configurator і runtime

**Проблема:** Design tokens (CSS custom properties) уже централізовані в `packages/ui/src/styles/globals.css`. `ThemeProvider` в apps/web керує лише dark/light/system через root classList. apps/runtime імпортує globals.css, але не має ThemeProvider — light-by-default. Якщо runtime введе ad hoc theme injection, з'являться дві різні моделі темізації.

**Рішення — два незалежних шари:**

**Шар 1: RuntimeThemeProvider (mode switching).** Перенести mode-switching логіку (classList, system media query, localStorage persistence) у `packages/app-runtime/src/theme/`. Configurator залишає свій ThemeProvider (інший localStorage scope, keyboard shortcuts). Runtime отримує власний provider з mode з `model.application.theme.mode`.

**Шар 2: Application theme tokens (CSS variables override).** `applyApplicationTheme(theme)` у app-runtime:
- `--radius` → з `theme.radius`
- `--primary` tokens → з `theme.accentColor` (pre-built HSL palettes для обмеженого set: blue, green, orange, violet, red)
- `base` → підміна base palette tokens (zinc/slate/stone/gray/neutral)
- `mode` → передається в RuntimeThemeProvider як defaultTheme

**Ключовий принцип:** Це **override existing tokens** з globals.css, а не нова тема-система. Tailwind utilities, shadcn/ui компоненти — все працює через ті самі CSS variables.

Без `model.application.theme` — globals.css defaults залишаються (backward compat).

### R13. DataProvider contract — Phase 4 працює як є

**Проблема:** Dashboard widgets потенційно потребують aggregate API (`count`, `sum`, `groupBy`), якого в DataProvider немає.

**Рішення:** Phase 4 **не розширює** DataProvider interface. Всі 4 widget types працюють на існуючому contract:
- `RecentDocuments` → `list()` з `sortBy: 'created_at', sortDirection: 'desc', pageSize: 10`
- `Counter` → `list()` з `pageSize: 1` + використання `total` з `ListResult`
- `QuickLinks` → статичний config, без data fetching
- `RegisterBalance` → `list()` з filters, показує top-N записів (а не справжній pivot)

Global search: metadata objects → client-side по `ProjectModel`, records → `list()` з `search` param.

Якщо widget потребує агрегації — client-side computation на малих наборах або відкладення до Phase 5 (aggregate contract).

---

## BRD References

| Розділ | Тема |
|--------|------|
| §10.6.1 | `application.meta.json` schema |
| §10.6.2 | `subsystems[]` специфікація |
| §10.6.3 | Dashboard widgets |
| §10.6.4 | Shell layouts |
| §10.6.5 | Автогенерація маршрутів |
| §10.6.6 | Стандартні сторінки (розширені) |
| §10.6.7 | Два режими (Runtime / Codegen) — тільки Runtime у Phase 4 |
| §10.6.8 | Зв'язок з бекендом |
| §10.6.9 | Фазування Application Shell |

---

## Етапи

### Етап 1: `application.meta.json` — Zod-схеми в `@simetra/core`

**Пакет:** `packages/core`

Додати Zod-схеми для application-рівня метаданих. Типи та валідація, без React.

#### 1.1. Базова application schema

```ts
// packages/core/src/schemas/application.ts
export const applicationSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal('Application'),
  displayName: localizedStringSchema,
  logo: z.string().optional(),
  theme: themeSchema.optional(),
  shell: shellConfigSchema.optional(),
  subsystems: z.array(subsystemSchema).default([]),
  dashboard: dashboardSchema.optional(),
})
```

#### 1.2. Theme schema

```ts
export const themeSchema = z.object({
  base: z.enum(['zinc', 'slate', 'stone', 'gray', 'neutral']).default('zinc'),
  mode: z.enum(['light', 'dark', 'system']).default('system'),
  radius: z.number().min(0).max(1).default(0.5),
  accentColor: z.string().default('blue'),
})
```

#### 1.3. Shell config schema

```ts
export const shellConfigSchema = z.object({
  layout: z.enum(['SidebarWithHeader', 'TopNavWithTabs', 'MinimalSidebar']).default('SidebarWithHeader'),
  sidebar: z.object({
    position: z.enum(['left', 'right']).default('left'),
    collapsible: z.boolean().default(true),
    width: z.number().default(240),
    showSearch: z.boolean().default(true),
  }).optional(),
  header: z.object({
    showBreadcrumbs: z.boolean().default(true),
    showGlobalSearch: z.boolean().default(true),
    showUserMenu: z.boolean().default(true),
  }).optional(),
})
```

#### 1.4. Ієрархічна subsystem schema

```ts
export const subsystemObjectSchema = z.object({
  ref: metadataRefSchema,
  showInList: z.boolean().default(true),
  listForm: z.string().nullable().default(null),
})

export const subsystemSchema: z.ZodType<SubsystemConfig> = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  displayName: localizedStringSchema,
  icon: z.string().optional(),
  order: z.number().default(0),
  objects: z.array(subsystemObjectSchema).default([]),
  subsystems: z.lazy(() => z.array(subsystemSchema)).default([]),  // ← ієрархія
})
```

#### 1.5. Dashboard schema

```ts
export const dashboardWidgetSchema = z.discriminatedUnion('type', [
  recentDocumentsWidgetSchema,
  registerBalanceWidgetSchema,
  counterWidgetSchema,
  quickLinksWidgetSchema,
])

export const dashboardSchema = z.object({
  widgets: z.array(dashboardWidgetSchema).default([]),
})
```

#### 1.6. ProjectModel extension

```ts
// packages/core/src/schemas/project-model.ts
export const projectModelSchema = z.object({
  project: projectSchema,
  // ... існуючі 7 collections ...
  forms: z.array(formSchema).default([]),
  application: applicationSchema.optional(),  // ← Phase 4
}).superRefine(/* existing forms validation + new application validation */)
```

Cross-model validation у `superRefine`:
1. Кожен `subsystem.objects[].ref` має існувати у відповідній collection ProjectModel
2. `subsystem.name` — unique у межах одного рівня ієрархії (siblings)
3. Dashboard widget refs (`documentTypes[].ref`, `registerRef`) — existence check
4. `listForm` якщо заданий — має відповідати existed form у `model.forms`

**Тести:** валідація application.meta.json, defaults, invalid refs, empty subsystems, nested subsystems, multi-membership.

**DoD:**
- [ ] Zod-схеми application, theme, shell, subsystem (з ієрархією), dashboard — у `packages/core/src/schemas/`
- [ ] Inferred types exported через `packages/core/src/index.ts`
- [ ] `ProjectModel.application` — optional typed field
- [ ] Cross-model superRefine для application refs
- [ ] Unit-тести валідації (shape, defaults, invalid refs, nested subsystems)

---

### Етап 2: Storage integration — read/write `application.meta.json`

**Пакет:** `packages/core`, `packages/cli`

`application.meta.json` інтегрується в core metadata-io як **root-level special file** (аналогічно до `project.meta.json`), а не як восьмий metadata kind directory.

#### 2.1. Core metadata IO — parse pipeline

Розширити `metadata-io.ts`:
- `ParsedFiles` — додати optional `application?: unknown` поле
- `parseMetadataFiles()` — додати special-case для `application.meta.json` поруч із `project.meta.json` (explicit root file pattern, не wildcard discovery)
- `buildProjectModelFromParsed()` — generic optional-section lenient mechanism (див. R11):
  - `OPTIONAL_SECTIONS = ['forms', 'application']`
  - safeParse ProjectModel → якщо fail → перевірити чи всі issues під optional section keys → видалити, retry, emit warnings
  - Замінює поточний hard-coded `path[0] === 'forms'` check на generic loop
  - Для application: повне відкидання при invalid → `model.application = undefined` + warnings

#### 2.2. Core metadata IO — serialize pipeline

Розширити `metadata-io.ts` та `serialization.ts`:
- `serializeToFiles()` — якщо `model.application` present → додати `FileEntry { path: 'application.meta.json', content }`
- `serialization.ts` — додати `buildApplicationSchemaUrl()` (аналогічно до `buildConstantsSchemaUrl`) і canonical key order для application

#### 2.3. CLI read-metadata

Розширити `packages/cli/src/read-metadata.ts`:
- Читати `application.meta.json` з тієї ж root directory, що й `project.meta.json`

#### 2.4. Generator-pg isolation

`generator-pg` ітерує лише по metadata object collections. `model.application` має бути **явно проігнорований** DDL pipeline — application є metadata-only, без SQL артефактів. Додати тест що підтверджує це.

**Чому apps/web і apps/runtime НЕ змінюються на цьому етапі:**
- `apps/web` web-storage вже використовує `serializeToFiles()` з core — зміни в core автоматично підхоплюються
- `apps/runtime` Vite plugin уже рекурсивно індексує всі `.json`, host уже використовує `parseMetadataFiles()` + `buildProjectModelFromParsed()` — `model.application` потрапляє автоматично

**DoD:**
- [ ] `ParsedFiles.application` — optional field
- [ ] `parseMetadataFiles()` парсить `application.meta.json` з root
- [ ] `buildProjectModelFromParsed()` валідовує і вкладає application в model
- [ ] `serializeToFiles()` генерує `application.meta.json` якщо `model.application` present
- [ ] `buildApplicationSchemaUrl()` + canonical key order
- [ ] CLI `read-metadata.ts` збирає `application.meta.json`
- [ ] Round-trip тести: parse → serialize → parse = identical (з/без application)
- [ ] ZIP export/import round-trip з application.meta.json
- [ ] Generator-pg ігнорує `model.application` — тест
- [ ] Lenient mode: invalid application → warning, не fatal

---

### Етап 3: Централізований Path module і subsystem routing у `@simetra/app-runtime`

**Пакет:** `packages/app-runtime`

> **Передумова:** Path module створюється **до** feature routing, як infrastructure refactor.

#### 3.0. Path module — усунення дублювання (infrastructure)

Створити `packages/app-runtime/src/paths.ts`. Мотивація: kind-slug knowledge зараз дублюється між `router-builder.tsx` (SUPPORTED_KIND_SLUGS), `navigation-builder.ts` (GROUP_CONFIG), `resolve-object.ts` (SLUG_MAP). Display name fallback і back-navigation paths дублюються в pages і breadcrumbs.

Path module надає:
- `RUNTIME_KIND_CONFIG` — single canonical map `MetadataKind → { slug, collectionKey, icon, label }`
- `buildListPath(mode, params)` — canonical list URL для flat і subsystem modes
- `buildItemPath(mode, params)` — canonical item URL
- `buildCreatePath(mode, params)` — canonical create URL
- `buildBackPath(mode, params)` — back from item to list (mode-aware)
- `resolveObjectFromSlug(model, kindSlug, objectSlug)` — slug → MetadataRef + object (re-exports core `toKebabCase`)
- `resolveDisplayName(obj)` — canonical display name fallback (uk → en → name)
- `type RoutingMode = 'flat' | 'subsystem'`

Після створення paths module: **router-builder, navigation-builder, resolve-object, всі pages, breadcrumbs** мігрують на єдине API. `GROUP_CONFIG`, `SUPPORTED_KIND_SLUGS`, `SLUG_MAP` видаляються.

#### 3.1. Navigation builder — configured mode

Розширити navigation builder:
- Якщо `model.application` має непорожній `subsystems[]` — побудувати grouped navigation по підсистемах (з ієрархією)
- Кожна підсистема = group у sidebar з `icon`, `displayName`, `objects[]`
- Objects в підсистемі = навігаційні елементи з links на list pages
- Objects не в жодній підсистемі — автоматично групуються в "Інше" (runtime-only UI construct)
- Multi-membership: один об'єкт може з'являтися в кількох subsystem groups

#### 3.2. Router builder — subsystem routes

Розширити `buildRoutes()`:
- Configured mode: splat route `/*` → app-runtime програмно парсить segments через paths module (повний ієрархічний шлях підсистеми, не фіксовані param levels)
- Fallback mode: зберігає фіксовані `:kindSlug/:objectSlug` routes як у Phase 3
- Додати redirect `/settings` → `/constants` (зараз відсутній)
- Router, navigation builder, pages — **всі** використовують paths module замість локальних slug maps
- Fallback route `/{kind-slug}/{object-slug}/:id` залишається для Phase 3 backward compatibility

#### 3.3. SimetraApp — mode selection

`SimetraApp` читає `model.application` (без окремого prop):
- `model.application` present → configured mode (navigation, routes, shell selection)
- `model.application` undefined → fallback mode (Phase 3 behavior 1-в-1)

**Back navigation:** `ItemPage` зараз зашиває абсолютний `/{kind}/{object}` literal. У configured mode — `buildBackPath()` з paths module.

**Title:** `model.application.displayName` як override поверх поточного `model.project.displayName` fallback. Якщо немає application displayName — зберігається поточна логіка.

**DoD:**
- [ ] `paths.ts` module створений з повним API (buildListPath, buildItemPath, buildCreatePath, buildBackPath, resolveObjectFromSlug, RUNTIME_KIND_CONFIG)
- [ ] `GROUP_CONFIG`, `SUPPORTED_KIND_SLUGS`, `SLUG_MAP` видалені — все мігровано на paths module
- [ ] Subsystem-grouped sidebar навігація працює (з ієрархією)
- [ ] Splat route для configured mode, фіксовані routes для fallback mode
- [ ] Multi-membership: об'єкт доступний через кілька subsystem URL-ів
- [ ] Objects не в жодній підсистемі — показуються в "Інше"
- [ ] Fallback mode без `model.application` — Phase 3 behavior не зламаний
- [ ] `/constants` — canonical, `/settings` — redirect
- [ ] Back navigation mode-aware через buildBackPath()

---

### Етап 4: Configured shell layouts

**Пакет:** `packages/app-runtime`

#### 4.1. Shell layout компоненти

За BRD §10.6.4, три layout варіанти:

| Layout | Опис | Аналогія |
|---|---|---|
| `SidebarWithHeader` | Sidebar зліва + header зверху | Supabase, Linear — вже існує з Phase 3 |
| `TopNavWithTabs` | Горизонтальна навігація вгорі | 1С:Fresh, Odoo |
| `MinimalSidebar` | Іконки без тексту зліва | Slack |

`SidebarWithHeader` — default, створений у Phase 3. Додати `TopNavWithTabs` і `MinimalSidebar`.

#### 4.2. Shell resolver

`app-runtime` обирає layout компонент за `model.application.shell.layout`:
```ts
function resolveShellLayout(layout: ShellLayout): React.ComponentType<ShellProps> {
  switch (layout) {
    case 'TopNavWithTabs': return TopNavWithTabsShell
    case 'MinimalSidebar': return MinimalSidebarShell
    default: return SidebarWithHeaderShell
  }
}
```

#### 4.3. Shell параметризація

Sidebar config: `position`, `collapsible`, `width`, `showSearch`.
Header config: `showBreadcrumbs`, `showGlobalSearch`, `showUserMenu`.

**DoD:**
- [ ] Три shell layouts рендеряться коректно
- [ ] Layout зчитується з `model.application.shell.layout`
- [ ] Sidebar config (position, collapsible, width) працює
- [ ] Header config (showBreadcrumbs, showGlobalSearch, showUserMenu) працює
- [ ] Без `model.application` — default SidebarWithHeader (Phase 3 behavior)

---

### Етап 5: Theming

**Пакет:** `packages/app-runtime`

> **Ключовий принцип (R12):** Theming — це override existing CSS tokens з `globals.css`, а не нова тема-система. Tailwind utilities, shadcn/ui компоненти працюють через ті самі CSS variables.

#### 5.1. RuntimeThemeProvider (mode switching)

Створити `packages/app-runtime/src/theme/runtime-theme-provider.tsx`:
- Mode switching (dark/light/system) через root classList — аналог поточного `ThemeProvider` з apps/web
- `defaultTheme` приймається з `model.application.theme.mode` (або 'system' як fallback)
- localStorage persistence для user override
- System media query listener для 'system' mode

Configurator (`apps/web`) залишає свій `ThemeProvider` — інший localStorage scope (`theme` vs `runtime-theme`), keyboard shortcuts, default dark mode.

#### 5.2. Application theme tokens (CSS variables override)

Створити `packages/app-runtime/src/theme/apply-theme.ts`:
```ts
function applyApplicationTheme(theme: ThemeConfig): void {
  // Override existing CSS custom properties з globals.css
  // --radius → theme.radius
  // --primary HSL tokens → pre-built palette для theme.accentColor
  // Base palette tokens → theme.base (zinc/slate/stone/gray/neutral)
}
```

**AccentColor palette:** Обмежений set з pre-built HSL palettes: `blue`, `green`, `orange`, `violet`, `red`. Не runtime hex→HSL conversion.

**Base palette:** Pre-built token sets для 5 neutral scales (zinc, slate, stone, gray, neutral). Підміняють `--card`, `--muted`, `--accent` і похідні tokens.

#### 5.3. SimetraApp theme integration

`SimetraApp` обгортає children у `RuntimeThemeProvider`. Конкретна семантика:
- `model.application.theme` present → `RuntimeThemeProvider` з `defaultTheme = theme.mode` + `applyApplicationTheme(theme)` override tokens
- `model.application` present, але `theme` undefined → `RuntimeThemeProvider` з `defaultTheme = 'system'`, CSS tokens = globals.css defaults
- `model.application` undefined (Phase 3 fallback) → **жодного RuntimeThemeProvider**, globals.css defaults як зараз (light-by-default у runtime, повна backward compat)

Тобто RuntimeThemeProvider монтується **лише** при наявному model.application. Phase 3 behavior не змінюється.

#### 5.4. Logo

Якщо `model.application.logo` вказаний — відобразити у sidebar header / top nav.

**DoD:**
- [ ] `RuntimeThemeProvider` у app-runtime з mode switching
- [ ] `applyApplicationTheme()` override CSS tokens
- [ ] Dark/light/system mode працює
- [ ] Radius і accent color (pre-built palettes) впливають на компоненти
- [ ] Base palette (zinc/slate/stone/gray/neutral) працює
- [ ] Logo відображається у shell header
- [ ] Без `model.application.theme` — globals.css defaults (backward compat)

---

### Етап 6: Dashboard

**Пакет:** `packages/app-runtime`

#### 6.1. Dashboard page

Route `/` рендерить dashboard, якщо `model.application.dashboard` має widgets.
Без dashboard config і з непорожнім subsystems — redirect на першу підсистему.
Без dashboard config і без subsystems — Phase 3 fallback home page.

#### 6.2. Widget framework

Кожен widget — React-компонент у `packages/app-runtime/src/widgets/`, який отримує:
- widget config (з application.meta.json)
- `DataProvider` для data fetching
- `ProjectModel` для metadata resolution

Grid layout: widgets розміщуються в responsive grid з `span` property.

#### 6.3. Widget types (MVP)

За BRD §10.6.3, **працюють на існуючому DataProvider contract** (R13 — без нових aggregate API):

| Тип | Компонент | Дані | DataProvider mapping |
|---|---|---|---|
| `RecentDocuments` | Таблиця останніх документів | `dataProvider.list()` з sort by date DESC | `list({sortBy:'created_at', sortDirection:'desc', pageSize:10})` |
| `RegisterBalance` | Картка або таблиця записів | `dataProvider.list()` з filters | `list({filters, pageSize:20})` — top-N записів, не pivot |
| `Counter` | Число з іконкою | `dataProvider.list()` з count | `list({pageSize:1})` → використовує `total` з `ListResult` |
| `QuickLinks` | Набір кнопок | Статичний список з config | Без data fetching |

> **Обмеження Phase 4:** `RegisterBalance` показує top-N записів, а не справжній aggregate pivot. Складні агрегації відкладені до Phase 5 (aggregate contract у DataProvider).

#### 6.4. Widget resolution

```ts
function resolveWidget(type: WidgetType): React.ComponentType<WidgetProps> {
  const registry: Record<WidgetType, React.ComponentType<WidgetProps>> = {
    RecentDocuments: RecentDocumentsWidget,
    RegisterBalance: RegisterBalanceWidget,
    Counter: CounterWidget,
    QuickLinks: QuickLinksWidget,
  }
  return registry[type]
}
```

**DoD:**
- [ ] Dashboard page рендериться з widgets
- [ ] Responsive grid layout з span
- [ ] Всі 4 widget types працюють з реальним DataProvider
- [ ] Без dashboard config — redirect на першу підсистему або fallback page

---

### Етап 7: Configurator UI — EditorTarget refactor, підсистеми, Application editor

**Пакет:** `apps/web`

> **Етап 7 розбитий на 5 підетапів** через значний обсяг: поточний configurator є object-centric (tree nodes, tabs, dirty tracking, properties panel), і Phase 4 вимагає generic editor infrastructure перед feature work. Це infrastructure рефакторинг, а не ad hoc special cases.

#### 7.0. EditorTarget refactor (infrastructure prerequisite)

**Мотивація:** Поточний UI побудований навколо `MetadataRef` як єдиної editor identity. `TabItem` знає `ObjectTab | SqlPreviewTab`. `FloatingWindow` має `objectRef`. Editor routing — ternary chain. Properties panel працює від `selectedObject`. Без generic editor identity, Application і Subsystem editors стануть третім і четвертим special case (після SQL Preview), а Phase 5 form designer — п'ятим.

**Зміни:**

**7.0.1. EditorTarget type:**
- Union: `ObjectTarget | ApplicationTarget | SubsystemTarget | SqlPreviewTarget`
- Кожен варіант: `{ type: 'object', ref: MetadataRef }`, `{ type: 'application' }`, `{ type: 'subsystem', path: string[] }`, `{ type: 'sql-preview' }`
- Helper: `editorTargetToTabId(target): string` — unique tab ID
- Helper: `editorTargetToKey(target): string` — dirty tracking key (EditorKey, R10)

**7.0.2. TabItem refactor:**
- Розширити union новими type variants із `target: EditorTarget`
- `activeSection` — optional capability (має сенс для object, subsystem; не для sql-preview)
- Tabs не персистяться (підтверджено state-management.md) — міграції збережених вкладок не потрібно

**7.0.3. Editor routing refactor:**
- Замінити ternary chain у `editor-panel.tsx` на registry map `target.type → React.ComponentType`
- Розширюється одним рядком при додаванні нового editor type

**7.0.4. Dirty tracking refactor:**
- `bumpObjectVersion` → `bumpEditorVersion(key: string)` (або розширити контракт)
- `useIsObjectDirty` → `useIsEditorDirty(target: EditorTarget)` (зберігає backward compat для object refs)
- Tab bar: dirty resolution через `editorTargetToKey(tab.target)`

**7.0.5. Properties panel refactor:**
- Resolution через `activeEditorTarget` замість тільки `selectedObject`
- Application/Subsystem editors: можуть мати власний inspector або fallback на ProjectSettings

**7.0.6. Tree activation refactor:**
- Explicit branches у `handleSelect`/`handleActivate` для application, subsystem node types
- Прибрати залежність на default object fallback для non-object nodes

**DoD 7.0:**
- [ ] `EditorTarget` type і helpers у shared types
- [ ] `TabItem` використовує `target: EditorTarget` замість `objectRef`
- [ ] Editor routing через registry map
- [ ] Dirty tracking через `editorTargetToKey`
- [ ] Properties panel через `activeEditorTarget`
- [ ] Tree activation з explicit non-object branches
- [ ] **Все існуюче працює як раніше** (object tabs, SQL Preview, dirty dots, properties)
- [ ] Tabs працюють як раніше (tabs не персистяться — міграція не потрібна)

#### 7.1. Store actions для application/subsystem

Application мутується через `metadata-store` (не `project-store`). Кожна mutation інкрементує `version` + bumps `Application/_` EditorKey → zundo tracking → undo/redo.

```
Нові actions:
- createApplication()                              ← створити default application config
- deleteApplication()                              ← видалити (model.application → undefined)
- updateApplication(config)                        ← theme, shell, dashboard, displayName, logo
- addSubsystem(parentPath?, data)                  ← створення підсистеми (опц. вкладеної)
- updateSubsystem(path, data)                      ← displayName, icon, order
- removeSubsystem(path)                            ← каскадне видалення вкладених
- reorderSubsystems(parentPath?, order)
- toggleSubsystemMembership(subsystemPath, objectRef)  ← ключовий action для чекбоксів
- updateDashboard(dashboard)
- updateTheme(theme)
- updateShellConfig(shell)
```

Всі actions bumps EditorKey `Application/_`. Subsystem-specific actions також оновлюють відповідний `Subsystem/{path}` key для dirty indicator вкладки.

**DoD 7.1:**
- [ ] Всі 11 store actions реалізовані
- [ ] Кожна mutation bumps `Application/_` EditorKey
- [ ] Undo/redo працює для application mutations
- [ ] Unit-тести для кожного action

#### 7.2. Tree model — Subsystems і Application nodes

Додати node types в `TreeNodeType` union: `subsystem`, `application`, `subsystemSection`.

**Дерево метаданих:**
```
Metadata Tree
├── 📋 Підсистеми              ← top-level секція (лише якщо model.application present)
│   ├── Продажі
│   │   ├── Замовлення         ← вкладена підсистема
│   │   └── Оплати
│   ├── Закупки
│   └── Склад
├── 📕 Довідники
│   ├── Contractors
│   └── Warehouses
├── 📄 Документи
│   ├── SalesOrder
│   └── Payment
├── ...інші kinds...
└── ⚙️ Application             ← завжди видимий singleton (placeholder якщо undefined)
```

**Application node (R7 entry point):**
- **Завжди видимий** у дереві (внизу, після metadata kinds), незалежно від `model.application`
- Якщо `model.application` = undefined: стан "не налаштовано", click → editor з кнопкою "Створити Application"
- Якщо present: click → Application editor
- Context menu: "Створити Application" (якщо undefined) або "Видалити Application" (якщо present)

**Секція "Підсистеми":**
- Показується **лише** якщо `model.application` present (без application підсистеми семантично неможливі)
- Перша top-level секція (перед Catalogs)
- `buildTreeData` будує subsystem subtree рекурсивно для nested
- Context menu підсистеми: Створити, Перейменувати, Видалити, Додати вкладену

**DoD 7.2:**
- [ ] Node types `application`, `subsystem`, `subsystemSection` у TreeNodeType
- [ ] Application node **завжди видимий** (placeholder при undefined)
- [ ] Subsystems секція — перша в дереві (лише при present application)
- [ ] Рекурсивний subtree для nested subsystems
- [ ] Context menus для application і subsystem nodes
- [ ] Activation handlers відкривають відповідні editors

#### 7.3. SubsystemEditor і ApplicationEditor

**SubsystemEditor** — non-object tab (EditorTarget `{ type: 'subsystem', path }` ):
- `displayName` (LocalizedString), `name`, `icon`, `order`
- **Список включених об'єктів:** дерево всіх metadata objects з чекбоксами
- Checked = об'єкт включений у цю підсистему
- Мутація чекбоксу → `toggleSubsystemMembership(subsystemPath, objectRef)`

**ApplicationEditor** — non-object tab (EditorTarget `{ type: 'application' }` ):
- **Загальне:** `displayName`, `logo`
- **Тема:** `base`, `mode`, `radius`, `accentColor`
- **Shell:** layout picker, sidebar config, header config
- **Dashboard:** widget list, widget type picker, widget config

Theme preview (7.6): reuse `applyApplicationTheme()` з app-runtime для live preview.

**DoD 7.3:**
- [ ] SubsystemEditor з чекбоксами об'єктів
- [ ] ApplicationEditor з секціями Загальне/Тема/Shell/Dashboard
- [ ] Обидва editors використовують EditorTarget tab contract
- [ ] Dirty indicator працює для обох editors
- [ ] Theme live preview у ApplicationEditor

#### 7.4. ObjectEditor — vertical tab "Підсистеми"

Для **всіх 7 metadata kinds** додається vertical tab "Підсистеми" в `section-config.ts`.

Контент — дерево підсистем (з ієрархією) з **чекбоксами**:
- Checked = цей об'єкт включений у дану підсистему
- Unchecked = не включений
- Мутація чекбоксу → `toggleSubsystemMembership(subsystemPath, objectRef)`
- Якщо `model.application` undefined — секція показує повідомлення "Створіть Application для налаштування підсистем"

**Інвертована мутація:** чекбокс у ObjectEditor технічно мутує `subsystem.objects[]` в `model.application.subsystems`, а не сам об'єкт.

Референс-патерн: forms section вже додана для 3 kinds через `SECTION_CONFIG` з окремим case у `SectionContent` switch.

**DoD 7.4:**
- [ ] Vertical tab "Підсистеми" для всіх 7 kinds
- [ ] Дерево підсистем з чекбоксами (ієрархічне)
- [ ] Інвертована мутація через toggleSubsystemMembership
- [ ] Повідомлення при відсутньому application

**DoD Етап 7 (сумарний):**
- [ ] EditorTarget refactor — generic editor identity
- [ ] Store actions для application/subsystem з undo/redo та dirty tracking
- [ ] Tree model з application і subsystem nodes
- [ ] SubsystemEditor, ApplicationEditor, ObjectEditor subsystem tab
- [ ] Зміни зберігаються в application.meta.json через canonical pipeline

---

### Етап 8.1: Breadcrumbs

**Пакет:** `packages/app-runtime`

> **Залежність:** paths module (Етап 3.0)

Breadcrumbs будуються від **structured route info** (mode + params з paths module), а не від split pathname (поточний підхід у `useBreadcrumbs`).

Формат для configured mode:
```
Dashboard > {Parent Subsystem} > {Child Subsystem} > {Object} > {Record displayName}
```

**Зміни:**
- Замінити поточний pathname-based `useBreadcrumbs` на paths-module-aware builder
- Subsystem segments з display names через model lookup
- Group crumb веде на subsystem landing, а не на root (поточний баг)
- Nested subsystems: кожен рівень = окремий breadcrumb

**DoD:**
- [ ] Breadcrumbs побудовані від structured route info (не pathname split)
- [ ] Subsystem → object → record hierarchy
- [ ] Nested subsystems: кожен рівень як breadcrumb
- [ ] Fallback mode: поточна поведінка зберігається

---

### Етап 8.2: Global search

**Пакет:** `packages/app-runtime`

> **Залежність:** paths module (Етап 3.0)

Command palette (cmdk) стиль:

**Metadata search (client-side):**
- Пошук по об'єктах метаданих (displayName, name) → навігація до list page через paths module
- Пошук по підсистемах → навігація до subsystem page
- Джерело: `ProjectModel`, без DataProvider

**Records search (DataProvider):**
- Пошук по записах через `dataProvider.list({ search: query })` — вже є в contract
- Навігація до item page через paths module

**DoD:**
- [ ] Command palette UI (cmdk) у app-runtime
- [ ] Metadata objects search (client-side по ProjectModel)
- [ ] Records search (через DataProvider.list з search param)
- [ ] Навігація до відповідної сторінки

---

### Етап 8.3: Extended list pages

**Пакет:** `packages/app-runtime`

> **Найбільш незалежний від Phase 4 core — може виконуватися окремо.**

Доповнити стандартну list page (Phase 3) features з BRD §10.6.6:
- Фільтр по періоду (для Document) — date range picker → `FilterExpression` з `gte`/`lte`
- Підтримка ієрархії (для Catalog з hierarchyType ≠ None) — tree list view
- Bulk-дії (масове видалення/позначка видалення)
- Column visibility і sorting preferences persistence

**DoD:**
- [ ] Фільтр по періоду для Document lists
- [ ] Ієрархічний list для Catalog з hierarchyType
- [ ] Bulk-дії
- [ ] Column preferences persistence

---

### Етап 9: Integration testing & polish

#### 9.1. End-to-end сценарій

1. Конфігуратор (`apps/web`) — створити metadata з application.meta.json:
   - 2+ підсистеми з вкладеністю (наприклад: "Продажі" → "Замовлення", "Склад")
   - Об'єкти розподілені по підсистемах (деякі в кількох)
   - Dashboard з RecentDocuments і Counter
   - Shell: SidebarWithHeader
2. DDL → PostgreSQL через CLI
3. `apps/runtime` з PostgREST DataProvider:
   - Sidebar показує grouped підсистеми (з ієрархією)
   - Dashboard рендерить widgets
   - CRUD через list → create → edit → delete
   - Multi-membership: один об'єкт доступний через різні subsystem URL-и
   - Breadcrumbs показують subsystem context
4. Той самий проєкт без application.meta.json → fallback mode (Phase 3 behavior)

#### 9.2. Backward compatibility

- Перевірити: Phase 3 metadata без application.meta.json працює як раніше
- Перевірити: InMemoryDataProvider + model.application = configured shell без БД
- Перевірити: `<SimetraApp model={modelWithoutApplication} />` = fallback mode
- Перевірити: import metadata з application.meta.json → model.application populated
- Перевірити: import metadata без application.meta.json → model.application = undefined (не залишається від попереднього стану)

#### 9.3. Performance

- Shell re-render при навігації — не повний remount
- Dashboard widget data loading — parallel, з loading skeletons
- Large metadata projects (100+ objects, 10 subsystems) — плавна навігація

**DoD:**
- [ ] End-to-end сценарій з configured mode працює
- [ ] Backward compatibility з Phase 3 fallback mode
- [ ] InMemoryDataProvider + model.application combo працює
- [ ] Import/export round-trip з application.meta.json
- [ ] Performance для 100+ objects проєктів прийнятний
- [ ] `pnpm lint ; pnpm typecheck ; pnpm test` — green
- [ ] `docs/architecture/OVERVIEW.md` оновлений (EditorTarget, paths module, application config)
- [ ] `docs/architecture/runtime-architecture.md` оновлений (configured mode, theme, dashboard)
- [ ] `docs/architecture/state-management.md` оновлений (EditorKey, application store actions)
- [ ] `docs/architecture/ui-components.md` оновлений (EditorTarget, non-object editors, tree model)

---

## Clarify (питання перед імплементацією)

### Вирішені clarify (зафіксовані рішення)

| # | Питання | Рішення | Обґрунтування | Архітектурне рішення |
|---|---------|---------|---------------|---------------------|
| C1 | Глибина вкладеності підсистем | Без обмеження — `z.lazy()` рекурсія | UI nature self-limits; технічне обмеження зайве | R5 |
| C2 | URL для nested subsystems | Повний ієрархічний шлях `/{parent}/{child}/{object}` | Уникальність URL, тривіальні breadcrumbs, stable context | R3 |
| C3 | Object visibility inheritance | Лише leaf — як у 1С | Стандартна поведінка 1С:Підприємство | R4, R6 |
| C4 | Lenient mode для invalid application | Повне відкидання → fallback mode + warnings | Application = shell/routing contract, часткове застосування непередбачуване | R7, R11 |
| C5 | Tab model для non-object editors | EditorTarget union — generic editor identity | Один рефакторинг замість N special cases (Phase 5 form designer) | R9 |
| C6 | Theme contract runtime vs configurator | Shared token override, окремі mode providers | Один token contract, різні localStorage scopes | R12 |
| C7 | DataProvider scope для dashboard | Існуючий contract, без нових aggregate API | Phase 4 не розширює interface, RegisterBalance = top-N | R13 |
| C8 | Entry point створення Application | Завжди видимий placeholder node | Прозорий UX, тестованіший | R9 (tree model) |
| C9 | Dirty tracking для non-object editors | Unified EditorKey contract | Backward compat для objects, єдиний pattern для всіх editors | R10 |

### Відкриті clarify

### C10. FloatingWindow для non-object editors
- **Питання:** Чи мають Application і Subsystem editors підтримувати detach у floating windows?
- **Варіанти:** A) Так, generic EditorTarget у FloatingWindow; B) Ні, обмежити floating лише object editors
- **Рекомендований дефолт:** B — singleton editors непрактичні у floating windows
- **Вплив:** EditorTarget refactor scope

### C11. Subsystem membership для runtime-incapable kinds
- **Питання:** Enumeration та обидва register kinds зараз не мають runtime list/item pages. Чи дозволяти їх включення в subsystems?
- **Варіанти:** A) Дозволяти в моделі, runtime navigation показує лише kinds з pages; B) Обмежити membership тільки runtime-capable kinds
- **Рекомендований дефолт:** A — модель не обрізається штучно, runtime фільтрує при побудові навігації
- **Вплив:** schema validation / runtime navigation

### C12. Subsystem landing page контент
- **Питання:** Що показує subsystem landing page (route `/{subsystem-slug}`)?
- **Варіанти:** A) Список об'єктів підсистеми (like home page section); B) Redirect на перший об'єкт; C) Dashboard підсистем
- **Рекомендований дефолт:** A — простий, консистентний, не потребує додаткового config
- **Вплив:** UI / routing
- **Уточнення:** Landing показує лише **direct members** підсистеми, а не агрегат descendant objects. Це відповідає C3 (object visibility = leaf-only).

---

## Анти-патерни

### ❌ Breaking Phase 3 fallback mode
`<SimetraApp />` де `model.application` = `undefined` ПОВИНЕН працювати як у Phase 3. Subsystem routing, configured layouts, dashboard — тільки при наявності `model.application`. Ніколи не ламати fallback.

### ❌ Окремий applicationConfig prop
`SimetraApp` читає `model.application` — **без** окремого prop. Один source of truth через ProjectModel pipeline.

### ❌ Shell/routing logic в thin host
`apps/runtime` — thin host. `model.application` потрапляє автоматично через core parser. Shell layouts, routing, pages — виключно в `@simetra/app-runtime`. Не дублювати logic в apps/runtime.

### ❌ Application config у ProjectModel required
`ProjectModel.application` — optional. Не робити його required — Phase 3 metadata не містить application.meta.json.

### ❌ Hardcoded subsystem list
Navigation ЗАВЖДИ будується динамічно з `model.application.subsystems[]`. Не хардкодити назви, іконки чи порядок підсистем.

### ❌ Widget data fetching поза DataProvider
Dashboard widgets отримують дані ВИКЛЮЧНО через `DataProvider` contract. Не робити прямих fetch до PostgREST або Supabase з widget компонентів. Не розширювати DataProvider interface у Phase 4.

### ❌ Shell layout компоненти в packages/ui
Shell layouts і dashboard widgets — це **domain компоненти**, не generic UI primitives. Вони живуть у `@simetra/app-runtime`, не в `@workspace/ui`. UI kit тримає лише примітиви (Sheet, Sidebar, Tabs тощо).

### ❌ Application як восьмий MetadataKind
Application — project-level singleton, не metadata object collection. Не додавати його в `MetadataKind`, `KIND_TO_KEY`, `SCHEMA_MAP` або object-centric CRUD pipeline.

### ❌ Membership source of truth на об'єкті
Membership зберігається в `subsystem.objects[]`, не на самому об'єкті. ObjectEditor tab "Підсистеми" — derived view + write через subsystem mutation.

### ❌ Ще один special case замість EditorTarget refactor
Не додавати Application/Subsystem editors як hardcoded branches поруч із SQL Preview. Використовувати generic EditorTarget → registry pattern (R9). Phase 5 form designer стане наступним editor — framework має бути готовий.

### ❌ Дублювання slug/path knowledge
Не додавати ще один SLUG_MAP або GROUP_CONFIG. Використовувати тільки paths module (R8). Kind-slug mapping має жити в одному місці.

### ❌ Часткове застосування invalid application
Якщо `application.meta.json` невалідний — **повне відкидання** з fallback до Phase 3 mode + warnings. Не намагатися частково застосувати shell або routing з invalid config.

### ❌ Нова тема-система поверх існуючих tokens
Theme у app-runtime — **override** existing CSS custom properties з globals.css, а не паралельна система. Не створювати нові token namespaces. Не дублювати ThemeProvider з apps/web — різні scope, різні defaults.

### ❌ Object-only dirty keys / tab-id dirty resolution
Dirty tracking має використовувати `editorTargetToKey()` (R10), а не покладатися на збіг `tab.id === objectVersions key`. Не додавати object-specific shortcuts, що обходять EditorKey contract.

### ❌ Hard-coded lenient branches замість generic mechanism
Lenient validation має працювати через `OPTIONAL_SECTIONS` (R11). Не додавати нові `if (path[0] === 'application')` поруч із `if (path[0] === 'forms')`. Кожна нова optional section додається одним записом у registry.

---

## Scope свідомо відкладений до Phase 5

| Тема | Причина | BRD |
|------|---------|-----|
| Codegen React App | `simetra generate --target react-app` — окремий генератор | §10.6.7, §10.6.9 |
| Generated .NET / Node.js backend API | Потребує server codegen pipeline | §10.6.8 |
| Form designer (visual) | Drag-and-drop form builder — окрема задача (EditorTarget framework ready) | §10.5 |
| Desktop Tauri shell | Потребує electron/tauri integration | §11.2 |
| VS Code extension | Потребує extension API integration | §11.2 |
| Auth / RBAC UI | Потребує auth schema + middleware | Future |
| DataProvider aggregate API | count/sum/groupBy — окремий contract extension | Future |
| Stable canonical links | `/objects/{kind}/{name}/:id` → redirect до subsystem context | Future |

---

## Граф залежностей етапів

```
Етап 1 (core schemas) ──────────────────────────────────────────────────▶ Етап 2 (storage IO)
                                                                              │
                         ┌────────────────────────────────────────────────────┤
                         │                                                    │
                         ▼                                                    ▼
                  Етап 7.0 (EditorTarget refactor)                    Етап 3 (path module + routing)
                         │                                                    │
                         ▼                                                    ├──▶ Етап 4 (shell layouts)
                  Етап 7.1 (store actions)                                    │         │
                         │                                                    │         ▼
                         ▼                                                    │    Етап 5 (theme)
                  Етап 7.2 (tree model)                                       │         │
                         │                                                    │         ▼
                         ▼                                                    │    Етап 6 (dashboard)
                  Етап 7.3 (editors)                                          │
                         │                                                    ├──▶ Етап 8.1 (breadcrumbs)
                         ▼                                                    │
                  Етап 7.4 (subsystem tab)                              Етап 8.2 (global search)
                         │                                                    │
                         └────────────────────┬───────────────────────────────┘
                                              ▼
                                     Етап 8.3 (extended lists — незалежний, може виконуватись паралельно)

                         Усі етапи ──────────▶ Етап 9 (integration)
```

**Ключовий принцип:** Три infrastructure рефакторинги (EditorTarget, Path module, Generic lenient validation) робляться **до** feature work. Кожна наступна фіча підключається у ready framework замість ще одного special case.

### Рекомендована послідовність виконання

Ця послідовність **вже врахована** в етапах і графі залежностей вище, але тут вона зафіксована лінійно, щоб не втрачалася під час планування спринтів або делегування між агентами.

1. **Етап 1 → Етап 2**
  Спочатку schema та canonical IO для `application.meta.json`, щоб усі наступні зміни спиралися на готовий `ProjectModel.application`.
2. **Infrastructure branch A: web editor model**
  `Етап 7.0 → 7.1 → 7.2 → 7.3 → 7.4`
  Це єдиний безпечний порядок для apps/web: спочатку generic editor identity, потім store/actions, потім tree model, потім editors, і лише після цього subsystem tab у `ObjectEditor`.
3. **Infrastructure branch B: runtime navigation contract**
  `Етап 3 → Етап 4 → Етап 5 → Етап 6`
  Спочатку centralized path module та routing contract, далі shell layouts, потім theme contract, і вже поверх них dashboard.
4. **Runtime UX branch**
  `Етап 3 → Етап 8.1`
  `Етап 3 → Етап 8.2`
  Breadcrumbs і global search залежать від нового path contract, але не повинні блокувати EditorTarget refactor у web.
5. **Independent branch**
  `Етап 8.3` може виконуватися окремим потоком і входить в integration gate лише наприкінці.
6. **Фінальна збірка**
  `Етап 9` стартує лише після завершення гілок `7.4`, `6`, `8.1`, `8.2`, `8.3`.

### Актуалізація відносно попереднього research graph

- Залежність `Етап 6 → Етап 8.2` більше **не потрібна**: global search спирається на `paths.ts`, `ProjectModel` і `DataProvider.list({ search })`, а не на dashboard.
- `Етап 8.3` тепер винесений явно як **незалежний** потік, щоб не змішувати extended list features з shell/routing refactor.
- Отже, старий graph був корисним як рефакторинг-орієнтир, але поточна версія задачі точніше відображає реальні залежності після деталізації Stage 8.

---

## Definition of Done (Phase 4)

### Core
- [ ] Zod-схеми `application.meta.json` — у `packages/core/src/schemas/` (з ієрархічними subsystems)
- [ ] `ProjectModel.application` — optional typed field
- [ ] Cross-model superRefine для application refs
- [ ] Generic lenient validation mechanism (OPTIONAL_SECTIONS) замість hard-coded forms-only fallback
- [ ] Metadata IO: parse/serialize `application.meta.json` round-trip (save/open/export/import)
- [ ] `buildApplicationSchemaUrl()` + canonical key order
- [ ] CLI read-metadata.ts збирає application.meta.json
- [ ] Generator-pg ігнорує `model.application` — тест
- [ ] Unit-тести валідації application config

### App Runtime
- [ ] Централізований `paths.ts` module — всі path/slug helpers в одному місці
- [ ] `GROUP_CONFIG`, `SUPPORTED_KIND_SLUGS`, `SLUG_MAP` видалені (zero duplication)
- [ ] `SimetraApp` читає `model.application` (без окремого prop)
- [ ] Configured mode: subsystem-grouped sidebar навігація (з ієрархією, повний шлях у URL)
- [ ] Splat route для configured mode, фіксовані routes для fallback
- [ ] Multi-membership: об'єкт у кількох підсистемах sidebar
- [ ] "Інше" group для objects без підсистеми
- [ ] `/settings` → redirect `/constants`
- [ ] Три shell layouts рендеряться коректно
- [ ] `RuntimeThemeProvider` + `applyApplicationTheme()` — shared token override (не нова тема-система)
- [ ] Dashboard з 4 widget types (на існуючому DataProvider contract, без aggregate API)
- [ ] Breadcrumbs від structured route info (не pathname split)
- [ ] Global search (cmdk) — metadata client-side + records через DataProvider
- [ ] Fallback mode без `model.application` — Phase 3 behavior зберігається

### Configurator (apps/web)
- [ ] `EditorTarget` refactor — generic editor identity (tab model, editor routing, dirty tracking, properties panel, tree activation)
- [ ] Unified `EditorKey` для dirty tracking (backward compat для objects)
- [ ] "Підсистеми" — top-level секція в дереві метаданих (ієрархічна, лише при present application)
- [ ] Application node **завжди видимий** (placeholder при undefined)
- [ ] SubsystemEditor з чекбоксами об'єктів (non-object tab via EditorTarget)
- [ ] ApplicationEditor (Загальне, Тема, Shell, Dashboard) з theme live preview
- [ ] ObjectEditor vertical tab "Підсистеми" для всіх 7 kinds (інвертована мутація)
- [ ] Store actions (11) з undo/redo та EditorKey dirty tracking
- [ ] Зміни зберігаються в application.meta.json через canonical pipeline

### Integration
- [ ] End-to-end: configured metadata → runtime з subsystems + dashboard + CRUD
- [ ] Backward compatibility: Phase 3 metadata (без application.meta.json) = fallback mode
- [ ] Import/export round-trip з/без application.meta.json
- [ ] `pnpm lint ; pnpm typecheck ; pnpm test` — green
- [ ] Документація `docs/architecture/` оновлена (OVERVIEW, runtime-architecture, state-management, ui-components)
