# Runtime Architecture

> Документ описує поточну Phase 3 runtime-архітектуру в репозиторії. Фокус: межі пакетів, metadata bootstrap, env contract, data providers і резолюція форм. Phase 4 речі відділені окремо як roadmap.

## Призначення і межі

Поточний runtime у Simetra не редагує metadata model і не має власного metadata write-path. Його роль інша:

- read-only завантажити metadata JSON;
- зібрати з них `ProjectModel` через shared core parser;
- побудувати browser shell, routing і pages;
- рендерити explicit forms або autoforms;
- виконувати CRUD операції над бізнес-записами через `DataProvider`.

Metadata лишається канонічним контрактом, який виробляє configurator і читають CLI та runtime. Runtime mutates data records, але не metadata files.

## Пакетні межі

| Шар | Поточний пакет/app | Відповідальність |
|---|---|---|
| Dev host | `apps/runtime` | Vite host, env bootstrap, metadata HTTP serving, вибір data provider |
| Shell і pages | `@simetra/app-runtime` | sidebar layout, navigation, routes, Home/List/Item/Constants pages |
| Form rendering | `@simetra/form-runtime` | providers, item/list/constants renderers, field components, runtime form interaction |
| Data contract | `@simetra/data-provider` | `DataProvider` interface і `InMemoryDataProvider` |
| HTTP adapter | `@simetra/data-provider-postgrest` | PostgREST/Supabase-compatible реалізація `DataProvider` |
| Canonical metadata model | `@simetra/core` | `ProjectModel`, metadata IO, `resolveForm()`, autoform generation |

Ключова межа: `apps/runtime` лишається thin host. Власна shell/routing логіка живе в `@simetra/app-runtime`, а не в app-рівні.

## Metadata loading через Vite plugin

### Dev server side

`apps/runtime/vite.config.ts` передає `SIMETRA_METADATA_PATH` у `metadataPlugin()`.

- `SIMETRA_METADATA_PATH` — це filesystem path, який читає Vite dev server.
- Плагін монтує цей каталог під HTTP path `/metadata`.
- `/metadata/index.json` генерується динамічно і повертає список усіх `.json` файлів.
- `/metadata/<path>.json` віддає вміст конкретного metadata file.
- Якщо `SIMETRA_METADATA_PATH` не заданий або каталог не існує, dev server повертає 500 для metadata endpoint.
- Fallback на `temp/metadata` у поточному коді відсутній.

### Browser side

`apps/runtime/src/App.tsx` читає `VITE_SIMETRA_METADATA_PATH` і використовує його як base URL для fetch.

Bootstrap потік такий:

1. Fetch `index.json`.
2. Fetch усіх metadata JSON files зі списку.
3. `parseMetadataFiles(files)` у `@simetra/core`.
4. `buildProjectModelFromParsed(parsed)` у `@simetra/core`.
5. Монтування `SimetraApp` з готовим `ProjectModel`.

Fetch metadata працює fail-fast: помилка `index.json` або будь-якого окремого file fetch зупиняє bootstrap runtime.

## Env contract

| Env | Де використовується | Статус | Призначення |
|---|---|---|---|
| `SIMETRA_METADATA_PATH` | Vite dev server (`apps/runtime/vite.config.ts`) | required | Абсолютний filesystem path до каталогу metadata |
| `VITE_SIMETRA_METADATA_PATH` | Browser runtime (`apps/runtime/src/config.ts`) | required | HTTP base path для fetch metadata, типовий value: `/metadata` |
| `VITE_SIMETRA_DATA_PROVIDER` | Browser runtime | optional | Тип provider: `mock` за замовчуванням або `postgrest` |
| `VITE_SIMETRA_API_URL` | Browser runtime | required для `postgrest` | Base URL PostgREST / Supabase REST API |
| `VITE_SIMETRA_ANON_KEY` | Browser runtime | optional | Supabase project publishable key або legacy anon key для auth header у PostgREST/Supabase сценарії. Account token з dashboard/account/tokens не підходить |

Різниця між двома metadata env принципова:

- `SIMETRA_METADATA_PATH` бачить тільки dev server і читає файлову систему.
- `VITE_SIMETRA_METADATA_PATH` вбудовується у frontend bundle і визначає, куди браузер робить HTTP fetch.

Це різні контракти, навіть якщо в типовому dev preview вони разом дають зв'язку filesystem path -> `/metadata`.

## Data access: mock vs PostgREST

Runtime створює provider на bootstrap і далі працює тільки через `DataProvider` interface.

### Default: mock

Якщо `VITE_SIMETRA_DATA_PROVIDER` не заданий або дорівнює `mock`, runtime використовує `InMemoryDataProvider`.

- Дані живуть у пам'яті браузерного процесу.
- CRUD, ref search, constants і post/unpost реалізовані без зовнішнього бекенда.
- Це типовий режим для dev preview, isolated UI перевірок і тестів.

### Optional: PostgREST

Якщо `VITE_SIMETRA_DATA_PROVIDER=postgrest`, runtime створює `PostgRestDataProvider`.

- `VITE_SIMETRA_API_URL` стає обов'язковим.
- `VITE_SIMETRA_ANON_KEY` для Supabase має бути саме project publishable key або legacy anon key з `Project Settings -> API Keys`.
- Personal account token з `dashboard/account/tokens` не підходить для browser запитів до `/rest/v1` і приводить до `401 Unauthorized`.
- Адаптер працює через generic `fetch`, без прив'язки до окремого SDK.
- `MetadataRef` мапиться на physical table names через naming helpers з generator/core stack.
- Runtime продовжує читати metadata локально або через Vite host, але records читає і змінює через HTTP API.

Отже read path для metadata і read/write path для data records у runtime навмисно розділені.

## Form resolution: explicit vs autoform

Runtime pages не містять власного алгоритму побудови форм. Вони викликають `resolveForm()` з `@simetra/core`.

Поточне правило пріоритету таке:

1. Якщо в `model.forms` є explicit форма для `objectRef + formKind`, runtime бере її.
2. Якщо explicit форми немає, core генерує стандартну autoform.
3. Якщо kind не підтримує forms або object не знайдено, повертається мінімальна порожня форма.

Поточні page flows:

- `ListPage` резолвить `ListForm` і передає її в `ListRenderer`.
- `ItemPage` резолвить `ItemForm` і передає її в `ItemFormRenderer`.
- `ConstantsPage` працює окремим runtime surface для constants, не через `resolveForm()`.

## Read-only metadata, mutable data

Поточна модель доступу така:

- metadata files: read-only для runtime;
- data records: CRUD через `DataProvider`;
- constants values: read/write через provider methods `getConstants()` і `updateConstant()`;
- document posting state: `postDocument()` і `unpostDocument()` через provider.

Runtime не серіалізує назад `ProjectModel` і не має save/open flow для metadata директорії. Це свідоме відокремлення від configurator storage architecture.

## Запуск dev preview

Root scripts у [../../package.json](../../package.json) вже враховують окремий runtime host:

- `pnpm dev` — загальний `turbo dev` для всього монорепо;
- `pnpm dev:web` — лише configurator;
- `pnpm dev:runtime` — лише runtime host;
- `pnpm dev:apps` — паралельний запуск `web` і `runtime` apps.

Мінімальний dev preview contract:

1. Задати `SIMETRA_METADATA_PATH` до існуючого каталогу metadata.
2. Задати `VITE_SIMETRA_METADATA_PATH`, зазвичай `/metadata`.
3. За потреби увімкнути `VITE_SIMETRA_DATA_PROVIDER=postgrest` і додати `VITE_SIMETRA_API_URL`.
4. Запустити `pnpm dev:runtime`.

Приклад env наведений у [../../apps/runtime/.env.example](../../apps/runtime/.env.example).

## Поточний стан vs roadmap

### Поточна реалізація

- thin Vite host у `apps/runtime`;
- unified shell/routing library у `@simetra/app-runtime`;
- form rendering library у `@simetra/form-runtime`;
- mock і PostgREST data providers;
- shared metadata IO і `resolveForm()` у `@simetra/core`.

### Roadmap-only після Phase 3

- `application.meta.json` і application-level config;
- subsystem-based routing і navigation filtering;
- deployment-specific runtime hosts поза thin Vite dev preview.

## Пов'язана документація

- [OVERVIEW.md](./OVERVIEW.md)
- [metadata-model.md](./metadata-model.md)
- [storage-and-persistence.md](./storage-and-persistence.md)
- [../BRD-metadata-configurator.md](../BRD-metadata-configurator.md)
