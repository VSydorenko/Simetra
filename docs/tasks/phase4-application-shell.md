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

### Монорепо-контекст

```
packages/
├── core/                       ← розширюється: application.meta.json Zod-схеми, ієрархічна subsystem schema
├── app-runtime/                ← розширюється: configured mode, subsystem routing, shell layouts, dashboard, widgets
├── form-runtime/               ← без змін (library рендерингу форм)
├── data-provider/              ← без змін
├── data-provider-postgrest/    ← без змін
├── ui/                         ← без змін (shadcn/ui примітиви: Sheet, Sidebar, Tabs тощо)
├── generator-api/              ← без змін
├── generator-pg/               ← без змін (generator-pg ігнорує model.application — це metadata-only)
└── cli/                        ← розширюється: read-metadata.ts читає application.meta.json
apps/
├── web/                        ← розширюється: підсистеми в дереві, ObjectEditor tab "Підсистеми", Application editor
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

### R3. URL contract — slug-based, subsystem як navigation context

| Сегмент | Джерело | Перетворення | Приклад |
|---|---|---|---|
| subsystem | `subsystem.name` | `toKebabCase()` | `sales_management` → `sales-management` |
| object | `object.name` (PascalCase) | `toKebabCase()` | `SalesOrder` → `sales-order` |
| id | record UUID | as-is | `550e8400-...` |

Configured mode routes:
```
/                                      → Dashboard або flat home
/{subsystem-slug}                      → Subsystem landing
/{subsystem-slug}/{object-slug}        → List page
/{subsystem-slug}/{object-slug}/new    → Create page
/{subsystem-slug}/{object-slug}/:id    → Edit page
/constants                             → Constants page (canonical)
/settings                              → Redirect → /constants
```

Fallback mode зберігає Phase 3 маршрути `/{kind-slug}/{object-slug}` без змін.

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

Lenient mode: application validation issues деградують у warnings (аналогічно до forms), а не ламають весь build.

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
- `parseMetadataFiles()` — додати special-case для `application.meta.json` поруч із `project.meta.json`
- `buildProjectModelFromParsed()` — `applicationSchema.safeParse()` → вкласти у фінальний model; application validation issues у lenient mode деградують у warnings (аналогічно до forms)

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

### Етап 3: Subsystem routing у `@simetra/app-runtime`

**Пакет:** `packages/app-runtime`

#### 3.1. Navigation builder — configured mode

Розширити navigation builder:
- Якщо `model.application` має непорожній `subsystems[]` — побудувати grouped navigation по підсистемах (з ієрархією)
- Кожна підсистема = group у sidebar з `icon`, `displayName`, `objects[]`
- Objects в підсистемі = навігаційні елементи з links на list pages
- Objects не в жодній підсистемі — автоматично групуються в "Інше" (runtime-only UI construct)
- Multi-membership: один об'єкт може з'являтися в кількох subsystem groups

#### 3.2. Router builder — subsystem routes

Розширити `buildRoutes()`:
- Configured mode маршрути (kebab-case slug convention):
  ```
  /                                      → Dashboard (або redirect на першу підсистему)
  /{subsystem-slug}                      → Subsystem landing
  /{subsystem-slug}/{object-slug}        → List page
  /{subsystem-slug}/{object-slug}/new    → Create page
  /{subsystem-slug}/{object-slug}/:id    → Edit page
  /constants                             → Constants page (canonical)
  /settings                              → Redirect → /constants
  ```
- Fallback route `/{kind-slug}/{object-slug}/:id` залишається для прямих посилань і Phase 3 backward compatibility
- **Централізувати** route resolution: усунути поточну дублікацію SLUG_MAP між `resolve-object.ts` і `router-builder.tsx`, створити одну mode-aware `buildListPath()` utility

#### 3.3. SimetraApp — mode selection

`SimetraApp` читає `model.application` (без окремого prop):
- `model.application` present → configured mode (navigation, routes, shell selection)
- `model.application` undefined → fallback mode (Phase 3 behavior 1-в-1)

**Back navigation:** `ItemPage` зараз повертає на абсолютний `/{kind}/{object}`. У configured mode — mode-aware back path `/{subsystem}/{object}`.

**Title:** `model.application.displayName` як override поверх поточного `model.project.displayName` fallback. Якщо немає application displayName — зберігається поточна логіка.

**DoD:**
- [ ] Subsystem-grouped sidebar навігація працює (з ієрархією)
- [ ] Routes `/{subsystem-slug}/{object-slug}/:id` генеруються
- [ ] Multi-membership: об'єкт доступний через кілька subsystem URL-ів
- [ ] Objects не в жодній підсистемі — показуються в "Інше"
- [ ] Fallback mode без `model.application` — Phase 3 behavior не зламаний
- [ ] `/constants` — canonical, `/settings` — redirect
- [ ] Route resolution централізована (без дублікації SLUG_MAP)
- [ ] Back navigation mode-aware

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
- [ ] Без `model.application` — default SidebarWithHeader (Phase 3 behavior)

---

### Етап 5: Theming

**Пакет:** `packages/app-runtime`

#### 5.1. Theme application

З `model.application.theme`:
- `base` — Tailwind CSS base color scheme (zinc, slate, stone, gray, neutral)
- `mode` — light/dark/system
- `radius` — border-radius scale
- `accentColor` — primary accent

#### 5.2. CSS variables injection

App-runtime при рендерингу інжектить CSS custom properties:
```ts
function applyTheme(theme: ThemeConfig): void {
  // Встановити --radius, --primary, color-scheme та base palette
  document.documentElement.style.setProperty('--radius', `${theme.radius}rem`)
  // ... Tailwind CSS 4 compatible theme tokens
}
```

#### 5.3. Logo

Якщо `model.application.logo` вказаний — відобразити у sidebar header / top nav.

**DoD:**
- [ ] Theme з application.meta.json застосовується до UI
- [ ] Dark/light/system mode працює
- [ ] Radius і accent color впливають на компоненти
- [ ] Logo відображається у shell header

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

За BRD §10.6.3:

| Тип | Компонент | Дані |
|---|---|---|
| `RecentDocuments` | Таблиця останніх документів | `dataProvider.list()` з sort by date DESC |
| `RegisterBalance` | Картка або таблиця залишків | `dataProvider.list()` з групуванням |
| `Counter` | Число з іконкою | `dataProvider.list()` з count |
| `QuickLinks` | Набір кнопок | Статичний список з config |

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

### Етап 7: Configurator UI — підсистеми, Application editor

**Пакет:** `apps/web`

Модель конфігуратора 1С:Підприємство: підсистеми є top-level секцією в дереві метаданих, а об'єкти включаються в підсистеми через чекбокси у vertical tab об'єкта.

#### 7.1. Підсистеми як top-level секція в дереві метаданих

Додати "Підсистеми" як **першу** top-level секцію в `SECTION_ORDER` (перед Catalogs, Documents...):

```
Metadata Tree
├── 📋 Підсистеми              ← НОВА TOP-LEVEL СЕКЦІЯ
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
└── ⚙️ Application             ← singleton для theme/shell/dashboard
```

- `TreeNodeType` — додати `subsystem`
- `TreeNodeData` — додати поля для subsystem context
- `buildTreeData` — будувати subsystem subtree з `model.application.subsystems` (рекурсивно для nested)
- Context menu підсистеми: Створити, Перейменувати, Видалити, Додати вкладену підсистему
- Секція "Підсистеми" показується тільки якщо `model.application` present

#### 7.2. SubsystemEditor — non-object tab

Клік по підсистемі в дереві відкриває SubsystemEditor (non-object special tab, аналогічно SQL Preview):
- `displayName` (LocalizedString), `name`, `icon`, `order`
- **Список включених об'єктів:** дерево всіх metadata objects з чекбоксами (аналог правої частини карточки об'єкта в 1С)
- Checked = об'єкт включений у цю підсистему
- Мутація чекбоксу → store action `toggleSubsystemMembership(subsystemPath, objectRef)`

Tab identity: synthetic ID `subsystem/{subsystem-path}`.

#### 7.3. ObjectEditor — vertical tab "Підсистеми"

Для **всіх 7 metadata kinds** додається vertical tab "Підсистеми" в `section-config.ts`.

Контент — дерево підсистем (з ієрархією) з **чекбоксами**:
- Checked = цей об'єкт включений у дану підсистему
- Unchecked = не включений
- Мутація чекбоксу → store action `toggleSubsystemMembership(subsystemPath, objectRef)`
- Якщо `model.application` undefined — секція показує повідомлення "Створіть Application для налаштування підсистем"

**Інвертована мутація:** чекбокс у ObjectEditor технічно мутує `subsystem.objects[]` в `model.application.subsystems`, а не сам об'єкт.

Референс-патерн: forms section вже додана для 3 kinds через `SECTION_CONFIG` з окремим case у `SectionContent` switch.

#### 7.4. Application editor — singleton node

Окремий singleton node "Application" в дереві (внизу, після metadata kinds). По кліку — non-object special tab:
- **Загальне:** `displayName`, `logo`
- **Тема:** `base`, `mode`, `radius`, `accentColor` — theme editor
- **Shell:** layout picker (SidebarWithHeader / TopNavWithTabs / MinimalSidebar), sidebar config, header config
- **Dashboard:** widget list, widget type picker, widget config editor

Application node з'являється тільки якщо `model.application` present. Context menu дерева: "Створити Application" (якщо undefined), "Видалити Application" (якщо present).

#### 7.5. Store actions (metadata-store)

Application мутується через `metadata-store` (не `project-store`). Кожна mutation інкрементує `version` → zundo tracking → undo/redo.

```
Нові actions:
- updateApplication(config)                    ← theme, shell, dashboard, displayName, logo
- createApplication()                          ← створити default application config
- deleteApplication()                          ← видалити (model.application → undefined)
- addSubsystem(parentPath?, data)              ← створення підсистеми (опц. вкладеної)
- updateSubsystem(path, data)                  ← displayName, icon, order
- removeSubsystem(path)                        ← каскадне видалення вкладених
- reorderSubsystems(parentPath?, order)
- toggleSubsystemMembership(subsystemPath, objectRef)  ← ключовий action для чекбоксів
- updateDashboard(dashboard)
- updateTheme(theme)
- updateShellConfig(shell)
```

Dirty tracking: synthetic key `Application/_` в `objectVersions` map для application editor tab dirty indicator.

#### 7.6. Theme preview

Live preview theming у конфігураторі — мінімальний mockup як виглядатиме runtime з обраною темою.

**DoD:**
- [ ] "Підсистеми" — top-level секція в дереві метаданих (з ієрархією)
- [ ] SubsystemEditor з чекбоксами об'єктів
- [ ] ObjectEditor vertical tab "Підсистеми" для всіх 7 kinds (з чекбоксами підсистем)
- [ ] Application editor (Загальне, Тема, Shell, Dashboard)
- [ ] Store actions для application/subsystem mutations з undo/redo
- [ ] Create/Delete Application через context menu
- [ ] Зміни зберігаються в application.meta.json через canonical pipeline

---

### Етап 8: Breadcrumbs, global search, extended list pages

**Пакет:** `packages/app-runtime`

#### 8.1. Breadcrumbs

Breadcrumbs будуються динамічно з route params + metadata display names:
```
Dashboard > {Subsystem} > {Object} > {Record displayName}
```
Для nested subsystems: `Dashboard > {Parent} > {Child} > {Object} > ...`

#### 8.2. Global search

Command palette (cmdk) стиль — пошук по:
- Об'єктах метаданих → навігація до list page
- Підсистемах → навігація до subsystem page
- Записах (через DataProvider search) → навігація до item page

#### 8.3. Extended list pages

Доповнити стандартну list page (Phase 3) features з BRD §10.6.6:
- Фільтр по періоду (для Document)
- Підтримка ієрархії (для Catalog з hierarchyType ≠ None)
- Bulk-дії (масове видалення/позначка видалення)
- Column visibility і sorting preferences persistence

**DoD:**
- [ ] Breadcrumbs з subsystem → object → record hierarchy (з nested subsystems)
- [ ] Global search (cmdk) з навігацією
- [ ] Фільтр по періоду для Document lists
- [ ] Ієрархічний list для Catalog з hierarchyType

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
- [ ] `docs/architecture/OVERVIEW.md` і `docs/architecture/runtime-architecture.md` оновлені

---

## Clarify (питання перед імплементацією)

### C1. Глибина вкладеності підсистем
- **Питання:** Чи є обмеження на рівні вкладеності (BAS має ~3-4 рівні)?
- **Варіанти:** A) Без обмеження — Zod lazy рекурсія; B) Обмежити 3-4 рівнями через schema
- **Рекомендований дефолт:** A — без обмеження, UI nature self-limits
- **Вплив:** schema / tree rendering

### C2. Routing для nested subsystems
- **Питання:** Як формувати URL для вкладених підсистем?
- **Варіанти:** A) `/{parent-slug}/{child-slug}/{object-slug}` — повний шлях; B) `/{leaf-subsystem-slug}/{object-slug}` — тільки leaf
- **Рекомендований дефолт:** B — flat leaf slug простіше для URL і не ламає навігацію при reorganize
- **Вплив:** routing / breadcrumbs / backward compat

### C3. Object visibility inheritance
- **Питання:** Якщо об'єкт включений у "Продажі → Замовлення", чи видно його в sidebar "Продажі" (parent) теж?
- **Варіанти:** A) Ні, тільки leaf — як у 1С; B) Так, propagate up to parent
- **Рекомендований дефолт:** A — лише leaf, як в 1С
- **Вплив:** UI / navigation

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
Dashboard widgets отримують дані ВИКЛЮЧНО через `DataProvider` contract. Не робити прямих fetch до PostgREST або Supabase з widget компонентів.

### ❌ Shell layout компоненти в packages/ui
Shell layouts і dashboard widgets — це **domain компоненти**, не generic UI primitives. Вони живуть у `@simetra/app-runtime`, не в `@workspace/ui`. UI kit тримає лише примітиви (Sheet, Sidebar, Tabs тощо).

### ❌ Application як восьмий MetadataKind
Application — project-level singleton, не metadata object collection. Не додавати його в `MetadataKind`, `KIND_TO_KEY`, `SCHEMA_MAP` або object-centric CRUD pipeline.

### ❌ Membership source of truth на об'єкті
Membership зберігається в `subsystem.objects[]`, не на самому об'єкті. ObjectEditor tab "Підсистеми" — derived view + write через subsystem mutation.

---

## Scope свідомо відкладений до Phase 5

| Тема | Причина | BRD |
|------|---------|-----|
| Codegen React App | `simetra generate --target react-app` — окремий генератор | §10.6.7, §10.6.9 |
| Generated .NET / Node.js backend API | Потребує server codegen pipeline | §10.6.8 |
| Form designer (visual) | Drag-and-drop form builder — окрема задача | §10.5 |
| Desktop Tauri shell | Потребує electron/tauri integration | §11.2 |
| VS Code extension | Потребує extension API integration | §11.2 |
| Auth / RBAC UI | Потребує auth schema + middleware | Future |

---

## Definition of Done (Phase 4)

### Core
- [ ] Zod-схеми `application.meta.json` — у `packages/core/src/schemas/` (з ієрархічними subsystems)
- [ ] `ProjectModel.application` — optional typed field
- [ ] Cross-model superRefine для application refs
- [ ] Metadata IO: parse/serialize `application.meta.json` round-trip (save/open/export/import)
- [ ] `buildApplicationSchemaUrl()` + canonical key order
- [ ] CLI read-metadata.ts збирає application.meta.json
- [ ] Generator-pg ігнорує `model.application` — тест
- [ ] Unit-тести валідації application config

### App Runtime
- [ ] `SimetraApp` читає `model.application` (без окремого prop)
- [ ] Configured mode: subsystem-grouped sidebar навігація (з ієрархією)
- [ ] Multi-membership: об'єкт у кількох підсистемах sidebar
- [ ] Routes `/{subsystem-slug}/{object-slug}/:id` (kebab-case)
- [ ] "Інше" group для objects без підсистеми
- [ ] Три shell layouts рендеряться коректно
- [ ] Dashboard з 4 widget types (в `app-runtime/src/widgets/`)
- [ ] Breadcrumbs з subsystem hierarchy
- [ ] Global search (cmdk)
- [ ] Theming з `model.application.theme`
- [ ] Fallback mode без `model.application` — Phase 3 behavior зберігається

### Configurator (apps/web)
- [ ] "Підсистеми" — top-level секція в дереві метаданих (ієрархічна)
- [ ] SubsystemEditor з чекбоксами об'єктів (non-object tab)
- [ ] ObjectEditor vertical tab "Підсистеми" для всіх 7 kinds (чекбокси з інвертованою мутацією)
- [ ] Application singleton editor (Загальне, Тема, Shell, Dashboard)
- [ ] Create/Delete Application через context menu
- [ ] Store actions з undo/redo та dirty tracking
- [ ] Зміни зберігаються в application.meta.json через canonical pipeline

### Integration
- [ ] End-to-end: configured metadata → runtime з subsystems + dashboard + CRUD
- [ ] Backward compatibility: Phase 3 metadata (без application.meta.json) = fallback mode
- [ ] Import/export round-trip з/без application.meta.json
- [ ] `pnpm lint ; pnpm typecheck ; pnpm test` — green
- [ ] `docs/architecture/OVERVIEW.md` і `docs/architecture/runtime-architecture.md` оновлені
