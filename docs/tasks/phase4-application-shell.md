# Task: Phase 4 — Application Shell & Configured Runtime

> **Prerequisite:** Runtime foundation already implemented and documented in [../architecture/runtime-architecture.md](../architecture/runtime-architecture.md) and [../architecture/OVERVIEW.md](../architecture/OVERVIEW.md): `@simetra/form-runtime`, `@simetra/app-runtime` (fallback mode), `@simetra/data-provider` + PostgREST adapter працюють end-to-end.
> **Prerequisite:** Phase 2 DDL pipeline: metadata → SQL → PostgreSQL → PostgREST — має бути end-to-end.

## Контекст

Поточний runtime baseline зафіксований у [../architecture/runtime-architecture.md](../architecture/runtime-architecture.md) та [../architecture/OVERVIEW.md](../architecture/OVERVIEW.md): unified `@simetra/app-runtime` уже надає fallback mode з flat навігацією по kinds з `ProjectModel`, default `SidebarWithHeader` shell, стандартними list/item pages і `InMemoryDataProvider` для dev preview без БД.

Phase 4 розширює **той самий пакет** до production-ready configured mode: subsystems, configurable shell layouts, dashboard widgets, theming — все контролюється через `application.meta.json`.

**Ціль Phase 4:** Перехід від fallback до configured mode у `@simetra/app-runtime`. Розробник описує структуру додатку в `application.meta.json` — і отримує повноцінний SPA з підсистемами, dashboard-ом і брендованим shell.

**Ключовий принцип — progressive configuration (convention-over-configuration):**

| Конфігурація | Поведінка |
|---|---|
| Без `application.meta.json` | Phase 3 fallback: flat nav by kind, default shell |
| З `application.meta.json` без `subsystems[]` | Брендований shell з theme, але без підсистем |
| З повним `application.meta.json` | Subsystem routing, configured layout, dashboard widgets |

**Backward compatibility:** жодна Phase 3 feature не ламається. `<SimetraApp model={m} dataProvider={dp} />` без `applicationConfig` prop продовжує працювати як раніше.

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
├── core/                       ← розширюється: application.meta.json Zod-схеми, subsystem schema
├── app-runtime/                ← розширюється: configured mode, subsystem routing, shell layouts, dashboard
├── form-runtime/               ← без змін (library рендерингу форм)
├── data-provider/              ← без змін
├── data-provider-postgrest/    ← без змін
├── ui/                         ← без змін (shadcn/ui примітиви: Sheet, Sidebar, Tabs тощо)
├── generator-api/              ← без змін
├── generator-pg/               ← без змін
└── cli/                        ← без змін
apps/
├── web/                        ← розширюється: конфігуратор application.meta.json (editor UI)
└── runtime/                    ← thin host, без змін (передає applicationConfig prop, якщо файл є)
```

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

#### 1.4. Subsystem schema

```ts
export const subsystemObjectSchema = z.object({
  ref: metadataRefSchema,
  showInList: z.boolean().default(true),
  listForm: z.string().nullable().default(null),
})

export const subsystemSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  displayName: localizedStringSchema,
  icon: z.string().optional(),
  order: z.number().default(0),
  objects: z.array(subsystemObjectSchema).default([]),
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

**Тести:** валідація application.meta.json, defaults, invalid refs, empty subsystems.

**DoD:**
- [ ] Zod-схеми application, theme, shell, subsystem, dashboard — у `packages/core/src/schemas/`
- [ ] Inferred types exported
- [ ] Unit-тести валідації
- [ ] `application.meta.json` включений у `parseMetadataFiles()` / `serializeToFiles()`

---

### Етап 2: Storage integration — read/write `application.meta.json`

**Пакет:** `packages/core`, `apps/web`

#### 2.1. Core metadata IO

Розширити `metadata-io.ts`:
- `parseMetadataFiles()` — розпізнавати і парсити `application.meta.json` у корені metadata/
- `serializeToFiles()` — серіалізувати application config як `metadata/application.meta.json`
- `ProjectModel` — додати optional поле `application?: ApplicationConfig`

#### 2.2. Web configurator storage

Розширити `web-storage.ts`:
- Зберігати/читати `application.meta.json` разом з рештою метаданих
- Canonical write-path повинен включати application файл (інакше він буде видалений при збереженні — per storage write-path behavior)

#### 2.3. apps/runtime thin host

Розширити metadata loading в `apps/runtime`:
- Якщо `application.meta.json` присутній у metadata/ каталозі — парсити і передати як `applicationConfig` prop до `<SimetraApp />`
- Якщо відсутній — `<SimetraApp />` працює у fallback mode (Phase 3 behavior)

**DoD:**
- [ ] `ProjectModel` містить optional `application` поле
- [ ] Round-trip: parse → serialize → parse = identical
- [ ] Web storage зберігає application.meta.json
- [ ] apps/runtime передає applicationConfig, якщо файл є

---

### Етап 3: Subsystem routing у `@simetra/app-runtime`

**Пакет:** `packages/app-runtime`

#### 3.1. Navigation builder — configured mode

Розширити `buildNavigation()`:
- Якщо `applicationConfig` має непорожній `subsystems[]` — побудувати grouped navigation по підсистемах
- Кожна підсистема = group у sidebar з `icon`, `displayName`, `objects[]`
- Objects в підсистемі = навігаційні елементи з links на list pages

#### 3.2. Router builder — subsystem routes

Розширити `buildRoutes()`:
- Якщо configured mode — маршрути за BRD §10.6.5:
  ```
  /                                      → Dashboard (або fallback list)
  /{subsystem.name}                      → Список об'єктів підсистеми
  /{subsystem.name}/{object.name}        → List page
  /{subsystem.name}/{object.name}/new    → Create page
  /{subsystem.name}/{object.name}/:id    → Edit page
  /settings                              → Constants page
  ```
- Fallback mode (Phase 3) залишається без змін

#### 3.3. SimetraApp — applicationConfig prop

```tsx
interface SimetraAppProps {
  model: ProjectModel
  dataProvider: DataProvider
  applicationConfig?: ApplicationConfig  // Phase 4: optional configured mode
}
```

Коли `applicationConfig` переданий:
- `buildNavigation(model, applicationConfig)` замість `buildFlatNavigation(model)`
- `buildRoutes(model, applicationConfig)` замість `buildRoutes(model)`
- Shell layout бере з `applicationConfig.shell.layout`
- Dashboard page рендериться як `/`

**DoD:**
- [ ] Subsystem-grouped sidebar навігація працює
- [ ] Routes `/{subsystem}/{object}/:id` генеруються
- [ ] Fallback mode без applicationConfig не зламаний
- [ ] Objects не в жодній підсистемі — не зникають (показуються в "Інше")

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

`app-runtime` обирає layout компонент за `applicationConfig.shell.layout`:
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
- [ ] Layout зчитується з applicationConfig
- [ ] Sidebar config (position, collapsible, width) працює
- [ ] Без applicationConfig — default SidebarWithHeader (Phase 3 behavior)

---

### Етап 5: Theming

**Пакет:** `packages/app-runtime`, `packages/ui`

#### 5.1. Theme application

З `applicationConfig.theme`:
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

Якщо `applicationConfig.logo` вказаний — відобразити у sidebar header / top nav.

**DoD:**
- [ ] Theme з application.meta.json застосовується до UI
- [ ] Dark/light/system mode працює
- [ ] Radius і accent color впливають на компоненти
- [ ] Logo відображається у shell header

---

### Етап 6: Dashboard

**Пакет:** `packages/app-runtime`

#### 6.1. Dashboard page

Route `/` рендерить dashboard, якщо `applicationConfig.dashboard` має widgets.
Без dashboard config — redirect на першу підсистему.

#### 6.2. Widget framework

Кожен widget — React-компонент, який отримує:
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

### Етап 7: Application configurator UI в `apps/web`

**Пакет:** `apps/web`

#### 7.1. Application node у дереві метаданих

Додати "Application" як top-level елемент у дереві метаданих конфігуратора. По кліку — відкриває Application editor.

#### 7.2. Application editor

Вкладки:
- **Загальне:** displayName, logo, theme (base, mode, radius, accentColor)
- **Shell:** layout picker (SidebarWithHeader / TopNavWithTabs / MinimalSidebar), sidebar config, header config
- **Підсистеми:** sortable list підсистем, drag objects між підсистемами, subsystem properties (name, displayName, icon, order)
- **Dashboard:** widget list, widget type picker, widget config editor

#### 7.3. Subsystem editor

- Створення/видалення/перейменування підсистем
- Drag-and-drop об'єктів метаданих у підсистему
- Об'єкти, не включені в жодну підсистему — показуються окремо з попередженням
- Порядок підсистем (drag sort)

#### 7.4. Theme preview

Live preview theming у конфігураторі — мінімальний mockup як виглядатиме runtime з обраною темою.

**DoD:**
- [ ] Application editor у конфігураторі
- [ ] Subsystems drag-and-drop працює
- [ ] Shell layout picker
- [ ] Dashboard widget editor
- [ ] Зміни зберігаються в application.meta.json через web-storage

---

### Етап 8: Breadcrumbs, global search, extended list pages

**Пакет:** `packages/app-runtime`

#### 8.1. Breadcrumbs

За BRD §10.6.6:
```
Dashboard > {Subsystem} > {Object} > {Record displayName}
```
Breadcrumbs будуються динамічно з route params + metadata display names.

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
- [ ] Breadcrumbs з subsystem → object → record hierarchy
- [ ] Global search (cmdk) з навігацією
- [ ] Фільтр по періоду для Document lists
- [ ] Ієрархічний list для Catalog з hierarchyType

---

### Етап 9: Integration testing & polish

#### 9.1. End-to-end сценарій

1. Конфігуратор (`apps/web`) — створити metadata з application.meta.json:
   - 2+ підсистеми (наприклад: "Продажі", "Склад")
   - Об'єкти розподілені по підсистемах
   - Dashboard з RecentDocuments і Counter
   - Shell: SidebarWithHeader
2. DDL → PostgreSQL через CLI
3. `apps/runtime` з PostgREST DataProvider:
   - Sidebar показує grouped підсистеми
   - Dashboard рендерить widgets
   - CRUD через list → create → edit → delete
   - Breadcrumbs показують path
4. Той самий проєкт без application.meta.json → fallback mode (Phase 3 behavior)

#### 9.2. Backward compatibility

- Перевірити: Phase 3 metadata без application.meta.json працює як раніше
- Перевірити: InMemoryDataProvider + applicationConfig = configured shell без БД
- Перевірити: `<SimetraApp />` без applicationConfig prop = fallback mode

#### 9.3. Performance

- Shell re-render при навігації — не повний remount
- Dashboard widget data loading — parallel, з loading skeletons
- Large metadata projects (100+ objects, 10 subsystems) — плавна навігація

**DoD:**
- [ ] End-to-end сценарій з configured mode працює
- [ ] Backward compatibility з Phase 3 fallback mode
- [ ] InMemoryDataProvider + applicationConfig combo працює
- [ ] Performance для 100+ objects проєктів прийнятний

---

## Анти-патерни

### ❌ Breaking Phase 3 fallback mode
`<SimetraApp />` без `applicationConfig` prop ПОВИНЕН працювати як у Phase 3. Subsystem routing, configured layouts, dashboard — тільки при наявності `applicationConfig`. Ніколи не ламати fallback.

### ❌ Shell/routing logic в thin host
`apps/runtime` — thin host. Він лише передає `applicationConfig` як prop. Shell layouts, routing, pages — виключно в `@simetra/app-runtime`. Не дублювати logic в apps/runtime.

### ❌ Application config у ProjectModel required
`ProjectModel.application` — optional. Не робити його required — Phase 3 metadata не містить application.meta.json.

### ❌ Hardcoded subsystem list
Navigation ЗАВЖДИ будується динамічно з `applicationConfig.subsystems[]`. Не хардкодити назви, іконки чи порядок підсистем.

### ❌ Widget data fetching поза DataProvider
Dashboard widgets отримують дані ВИКЛЮЧНО через `DataProvider` contract. Не робити прямих fetch до PostgREST або Supabase з widget компонентів.

### ❌ Shell layout компоненти в packages/ui
Shell layouts (`SidebarWithHeader`, `TopNavWithTabs`, `MinimalSidebar`) — це **domain компоненти**, не generic UI primitives. Вони живуть у `@simetra/app-runtime`, не в `@workspace/ui`. UI kit тримає лише примітиви (Sheet, Sidebar, Tabs тощо).

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
- [ ] Zod-схеми `application.meta.json` — у `packages/core/src/schemas/`
- [ ] `ProjectModel.application` — optional typed field
- [ ] Metadata IO: parse/serialize `application.meta.json` round-trip
- [ ] Unit-тести валідації application config

### App Runtime
- [ ] `<SimetraApp applicationConfig={cfg} />` — configured mode працює
- [ ] Subsystem-grouped sidebar навігація
- [ ] Routes `/{subsystem}/{object}/:id`
- [ ] Три shell layouts рендеряться коректно
- [ ] Dashboard з 4 widget types
- [ ] Breadcrumbs з subsystem hierarchy
- [ ] Global search (cmdk)
- [ ] Theming з application.meta.json
- [ ] Fallback mode без applicationConfig — Phase 3 behavior зберігається

### Configurator (apps/web)
- [ ] Application editor з вкладками: Загальне, Shell, Підсистеми, Dashboard
- [ ] Subsystem editor з drag-and-drop objects
- [ ] Зміни зберігаються в application.meta.json

### Integration
- [ ] End-to-end: configured metadata → runtime з subsystems + dashboard + CRUD
- [ ] Backward compatibility: Phase 3 metadata (без application.meta.json) = fallback mode
- [ ] `pnpm lint ; pnpm typecheck ; pnpm test` — green
