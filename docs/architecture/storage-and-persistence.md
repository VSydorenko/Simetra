# Storage and Persistence

> Документ описує поточну архітектуру зберігання і runtime-персистентності в Simetra. Фокус: контракти, межі шарів, потоки open/save/restore, інваріанти, graceful degradation і recovery behavior. Roadmap винесений в окрему секцію і не описує реалізований код.

## Призначення і межі

Storage/persistence layer у Simetra розв'язує три різні задачі, які не можна змішувати в один шар:

- canonical серіалізація доменної моделі у стабільний JSON-формат;
- browser-side робота з директорією проєкту або ZIP-архівом;
- runtime-відновлення сесії і crash-recovery у браузері.

Архітектурна межа тут принципова:

- `@simetra/core` визначає canonical формат JSON і Zod-валидацію, але не працює з браузерними API;
- web storage adapter мапить `ProjectModel` у файлову структуру і назад, але не визначає доменну модель;
- `project-store` оркеструє життєвий цикл проєкту, save baseline, session restore і recovery UI, але не серіалізує JSON напряму.

Ключові джерела: [../../packages/core/src/serialization.ts](../../packages/core/src/serialization.ts), [../../packages/core/src/schemas/project.ts](../../packages/core/src/schemas/project.ts), [../../packages/core/src/schemas/constant.ts](../../packages/core/src/schemas/constant.ts), [../../apps/web/src/storage/storage-provider.ts](../../apps/web/src/storage/storage-provider.ts), [../../apps/web/src/storage/web-storage.ts](../../apps/web/src/storage/web-storage.ts), [../../apps/web/src/storage/session-db.ts](../../apps/web/src/storage/session-db.ts), [../../apps/web/src/storage/draft-sync.ts](../../apps/web/src/storage/draft-sync.ts), [../../apps/web/src/stores/project-store.ts](../../apps/web/src/stores/project-store.ts)

## Шарова модель

| Шар | Поточна відповідальність | Чого не робить |
|---|---|---|
| Core serializer + schema helpers | Canonical JSON, `$schema` URL helpers, Zod-схеми `Project` і metadata objects | Не читає директорії, не працює з IndexedDB, не знає про UI lifecycle |
| Web storage mapping | `StorageProvider`, `WebStorage`, маппінг `ProjectModel <-> files`, File System Access API, ZIP fallback | Не тримає save baseline, не вирішує recovery state machine |
| Project orchestration | `project-store`, `use-session-restore`, session/draft coordination, permission/recovery transitions | Не визначає canonical key order, не валідовує JSON вручну |

Архітектурний сенс цього поділу: serializer є canonical source формату, `WebStorage` є transport/mapping шаром, а `project-store` є orchestration шаром. Їх не можна документувати як один і той самий рівень відповідальності.

## Контракт StorageProvider

Контракт визначено в [../../apps/web/src/storage/storage-provider.ts](../../apps/web/src/storage/storage-provider.ts).

| Метод | Вхід | Вихід | Поточна семантика |
|---|---|---|---|
| `openProject()` | немає | `OpenResult` | Повертає `ProjectModel`, optional directory handle і non-fatal warnings |
| `saveProject(model, handle?)` | `ProjectModel`, optional handle | `OpenProjectResult` | Повертає `model` і optional handle після успішного save |
| `exportProject(model)` | `ProjectModel` | `void` | Експортує canonical файлову структуру як ZIP |
| `importProject()` | немає | `OpenResult` | Імпортує ZIP і повертає `ProjectModel` з warnings |

`OpenResult.warnings` є важливою частиною контракту. Це не fatal exception, а список проблем рівня окремих файлів: `filePath` + `errors[]`. Поточний read-path свідомо відділяє:

- помилки JSON parsing і file-shape parsing;
- Zod validation warnings для окремих metadata files;
- fatal failure для відсутнього або невалідного `project.meta.json`.

Це дозволяє частково відкрити проєкт, якщо пошкоджені окремі object files, але не дозволяє працювати без валідного project root.

## Поточна реалізація: WebStorage

Поточний provider один: [../../apps/web/src/storage/web-storage.ts](../../apps/web/src/storage/web-storage.ts). Інших runtime-провайдерів у репозиторії немає.

### Поточна поведінка

- `openProject()` використовує directory picker, якщо браузер підтримує File System Access API; інакше переходить на ZIP open/import path.
- `saveProject()` пише в директорію, якщо доступний File System Access API; інакше робить export fallback у ZIP download.
- `importProject()` завжди працює як ZIP import.
- `exportProject()` завжди формує ZIP з canonical файлової структури.
- `openFromHandle(handle)` існує як helper поза базовим інтерфейсом і використовується тільки restore path-ом у `project-store`.

### Graceful degradation

- Відсутність File System Access API не блокує open/save повністю: система переходить на ZIP-based flow.
- ZIP import/export не повертає directory handle, тому після такого відкриття проєкт живе без прив'язки до директорії.
- Read-path не зупиняє відкриття через кожен невалідний об'єкт; warnings накопичуються і віддаються вище.

### File parsing і validation boundaries

У `WebStorage` є два явні кроки read-path:

1. `parseFileStructure()` читає JSON і перетворює файлова-структура -> parsed payloads, збираючи parse warnings.
2. `buildProjectModel()` робить Zod validation і збирає schema warnings перед складанням `ProjectModel`.

Це важлива межа: parsing warnings і schema warnings не змішуються, а UI/store можуть показати їх як non-fatal попередження при успішному відкритті.

## Канонічний serializer і файловий контракт

Canonical serializer живе в [../../packages/core/src/serialization.ts](../../packages/core/src/serialization.ts). Web layer лише викликає його і розкладає результат по файлах.

### Інваріанти serializer contract

- порядок ключів фіксований per kind і per nested structure;
- масиви `attributes`, `dimensions`, `resources`, `tabularSections`, `values`, `owners`, `allowedTypes` та інші user-ordered масиви зберігають користувацький порядок;
- серіалізація використовує відступ у 2 пробіли;
- кожен файл завершується trailing newline;
- `$schema` не довіряється вже наявному значенню в пам'яті: helper-функції щоразу збагачують об'єкти canonical URL перед записом;
- `projectSchema` і metadata schemas є Zod boundary для write/read path, а не лише типами для UI.

### `$schema` URL helpers

- `enrichProjectSchemaUrl()` формує URL для `project.meta.json`.
- `enrichSchemaUrl()` формує URL для кожного metadata object file.
- `buildConstantsSchemaUrl()` формує URL для wrapper-файлу констант.

Поточна конвенція: `https://simetra.dev/schemas/v{schemaVersion}/{kind}.schema.json`, де `schemaVersion` береться з [../../packages/core/src/schemas/project.ts](../../packages/core/src/schemas/project.ts).

### One-file-per-object layout

`serializeToFiles()` у [../../apps/web/src/storage/web-storage.ts](../../apps/web/src/storage/web-storage.ts) мапить `ProjectModel` на директорії BRD-формату:

| Kind | Директорія |
|---|---|
| `Catalog` | `catalogs/` |
| `Document` | `documents/` |
| `Enumeration` | `enumerations/` |
| `InformationRegister` | `information-registers/` |
| `AccumulationRegister` | `accumulation-registers/` |
| `Constant` | `constants/` |
| `CustomTable` | `custom-tables/` |

Імена об'єктів перетворюються з PascalCase у kebab-case через `toKebabCase()`, а повний шлях для більшості об'єктів має вигляд:

`metadata/{kind-dir}/{object-kebab}/{object-kebab}.meta.json`

Для `Constant` діє окрема домовленість: один wrapper-файл `metadata/constants/constants.meta.json`. Це не окрема canonical schema в UI-шарі, а спеціальний file-level контейнер, де:

- schema wrapper (`constantsFileSchema`) визначена в core у [../../packages/core/src/schemas/constant.ts](../../packages/core/src/schemas/constant.ts);
- складання wrapper JSON виконується у `WebStorage`, бо це file-layout concern, а не object schema concern.

### Stale file cleanup

`saveToDirectory()` перед записом очищає весь `metadata/` каталог. Це поточний інваріант write-path:

- rename або delete об'єкта не повинні залишати orphaned files;
- запис є rewrite всієї canonical snapshot, а не patch поверх існуючих файлів;
- forms серіалізуються canonical serializer-ом як окремі файли у `forms/` підкаталозі відповідного об'єкта (наприклад `catalogs/products/forms/item.form.json`), а не як частина `*.meta.json`.

Ігнорування цього правила призвело б до розсинхронізації між in-memory model і директорією проєкту.

## Save flow

```mermaid
flowchart TD
  User[Користувач: Save] --> Store[project-store.saveProject]
  Store --> Snapshot[Зняти snapshot: model + version + objectVersions]
  Snapshot --> Provider[WebStorage.saveProject]

  Provider --> FsCheck{File System Access API доступний?}
  FsCheck -- так --> DirSave[saveToDirectory]
  DirSave --> Serialize[serializeToFiles + enrichSchemaUrl helpers\nінклюдить forms файли]
  Serialize --> Clear[Очистити metadata/]
  Clear --> Write[Записати canonical files]

  FsCheck -- ні --> ZipFallback[exportProject -> ZIP download]

  Write --> Success[Успішне завершення]
  ZipFallback --> Success

  Success --> Baseline[Оновити lastSavedVersion і lastSavedObjectVersions]
  Baseline --> Session[saveSession(handle, model, version)]
  Session --> Draft[stopAndClearDraft()]
```

### Інваріанти save-path

- write-path завжди працює з одним store snapshot, узятим до `await`, щоб baseline не змістився під час асинхронного save;
- `serializeToFiles()` тепер включає forms файли — кожна форма з `model.forms` серіалізується у `{kind-dir}/{object-kebab}/forms/{form-kind-kebab}.form.json`;
- повний rewrite `metadata/` каталогу зберігається як інваріант — forms записуються serializer-ом разом з `*.meta.json` файлами;
- після успішного save `project-store` оновлює session snapshot в IndexedDB;
- після успішного disk-save чернетка очищується, бо recovery state вже не новіший за збережений baseline.

## Open flow

```mermaid
flowchart TD
  User[Користувач: Open] --> Store[project-store.openProject]
  Store --> Provider[WebStorage.openProject]
  Provider --> FsCheck{File System Access API доступний?}

  FsCheck -- так --> PickDir[showDirectoryPicker]
  PickDir --> ReadDir[readFromDirectory]

  FsCheck -- ні --> PickZip[Вибір ZIP]
  PickZip --> Unzip[unzipEntries]

  ReadDir --> Parse[parseFileStructure]
  Unzip --> Parse
  Parse --> Build[buildProjectModel]
  Build --> Result[OpenResult model + warnings]

  Result --> Pause[pauseDraftSync]
  Pause --> Load[metadata-store.loadModel]
  Load --> ClearUndo[clear temporal history]
  ClearUndo --> Baseline[Оновити save baseline]
  Baseline --> Persist[saveSession(handle or null, model, version)]
  Persist --> Resume[resumeDraftSync]
```

### Graceful open behavior

- Якщо користувач обирає корінь проєкту, `readFromDirectory()` читає `metadata/` всередині нього.
- Якщо користувач одразу обирає сам каталог `metadata/`, reader теж приймає його як корінь.
- Неуспішний parsing окремих object files дає warnings, а не повний abort.
- Неуспішний `project.meta.json` є fatal, бо без нього неможливо зібрати `ProjectModel`.

## Session persistence в IndexedDB

Session persistence визначена в [../../apps/web/src/storage/session-db.ts](../../apps/web/src/storage/session-db.ts).

### Поточна схема

- база даних: `simetra-session`;
- version: `1`;
- object stores: `session`, `drafts`;
- ключі для обох store: `current`.

### Намір payload-ів

`session` store зберігає:

- `projectHandle` або `null`;
- `projectModel`;
- `lastSavedVersion`;
- `savedAt`.

`drafts` store зберігає:

- `model`;
- `version`;
- `savedAt`.

Архітектурний сенс різниці:

- `session` описує останній відомий baseline сесії і контекст директорії;
- `draft` описує новіші незбережені доменні зміни для recovery.

### Graceful degradation

Операції `saveSession`, `loadSession`, `clearSession`, `saveDraft`, `loadDraft`, `clearDraft` свідомо загорнуті в `try/catch` і тихо деградують, якщо:

- IndexedDB недоступний;
- браузер обмежує storage у private mode;
- вичерпано quota;
- structured clone для handle/payload не спрацьовує в поточному оточенні.

Наслідок: відсутність IndexedDB не блокує редактор, але вимикає прозоре session restore і draft recovery.

## Draft sync

Draft autosave визначений у [../../apps/web/src/storage/draft-sync.ts](../../apps/web/src/storage/draft-sync.ts) і підключається з [../../apps/web/src/components/layout/app-shell.tsx](../../apps/web/src/components/layout/app-shell.tsx).

### Поточна поведінка

- тригером є зміна `metadata-store.version`, а не будь-який UI state;
- запис у IndexedDB дебаунситься на `3000 ms`;
- `pauseDraftSync()` тимчасово блокує autosave і скидає активний таймер;
- `resumeDraftSync()` відновлює autosave після lifecycle-переходу;
- `stopAndClearDraft()` скидає таймер і видаляє поточну чернетку.

### Навіщо потрібні pause/resume

Open/new/restore flows не повинні породжувати хибний autosave поверх щойно завантаженої моделі. Тому `project-store` явно паузить draft sync перед `loadModel()` і відновлює його тільки після узгодження baseline та recovery state.

## Restore і recovery architecture

Bootstrap починається з [../../apps/web/src/hooks/use-session-restore.ts](../../apps/web/src/hooks/use-session-restore.ts): hook лише один раз викликає `project-store.restoreSession()` при mount shell. Увесь реальний state machine живе в [../../apps/web/src/stores/project-store.ts](../../apps/web/src/stores/project-store.ts).

### Стани відновлення

| Статус | Значення в поточному коді |
|---|---|
| `idle` | restore ще не запускався або session відсутня |
| `restoring` | виконується автоматичне або явне відновлення |
| `awaiting-permission` | є directory handle, але потрібен user gesture або permission denied/prompt |
| `restored` | модель успішно завантажена і recovery prompt не потрібен |
| `failed` | restore path завершився помилкою |
| `recovery-available` | директорія/сесія відновлена, але знайдено новіший draft |

### Поточні recovery правила

- Якщо session має `projectHandle` і permission уже `granted`, `project-store` тихо перечитує директорію через `WebStorage.openFromHandle()`.
- Якщо permission дорівнює `prompt` або `denied`, store переходить у `awaiting-permission` і зберігає `pendingDirectoryName`.
- Якщо одночасно існує draft, UI отримує `hasDraftFallback`, щоб дати користувачу backup path без доступу до директорії.
- Якщо session не має handle, відновлення йде з `session.projectModel`, тобто останнього ZIP-based session snapshot.
- Якщо `draft.savedAt > session.savedAt`, store не затирає session baseline, а переходить у `recovery-available`.
- `restoreDraft()` завантажує draft як окремий recovery state: handle скидається до `null`, `lastSavedVersion` стає `null`, а `projectOrigin` переходить у `draft-recovery`.

Останній пункт важливий: draft recovery не вважається збереженим проєктом. Після такого відновлення наступне save має бути явним і встановлює новий baseline заново.

## Restore flow

```mermaid
flowchart TD
  Mount[AppShell mount] --> Hook[use-session-restore]
  Hook --> Restore[project-store.restoreSession]
  Restore --> Session{Є session?}

  Session -- ні --> Idle[idle]
  Session -- так --> Handle{Є projectHandle?}

  Handle -- ні --> LoadSession[load session.projectModel]
  LoadSession --> RestoredZip[restored + origin zip-import]

  Handle -- так --> Permission{queryPermission(readwrite)}
  Permission -- granted --> OpenHandle[WebStorage.openFromHandle]
  OpenHandle --> Compare{Є новіший draft?}
  Compare -- ні --> RestoredDir[restored + clear draft]
  Compare -- так --> Recovery[recovery-available + pendingRecovery]

  Permission -- prompt/denied --> Await[awaiting-permission]
  Await --> Fallback{Є draft fallback?}
  Fallback -- так --> UI[WelcomeScreen: reopen або restore draft]
  Fallback -- ні --> UI

  Recovery --> Banner[RecoveryBanner: accept or dismiss]
  Banner --> DraftAccept[restoreDraft]
  Banner --> Dismiss[clear draft + restored]
```

### UI surfaces recovery state

- [../../apps/web/src/components/editor/welcome-screen.tsx](../../apps/web/src/components/editor/welcome-screen.tsx) показує restore/reopen CTA, коли немає активного editor context або потрібен permission step.
- [../../apps/web/src/components/editor/recovery-banner.tsx](../../apps/web/src/components/editor/recovery-banner.tsx) показує inline prompt, коли директорія вже відкрита, але є новіший draft.
- [../../apps/web/src/components/layout/app-shell.tsx](../../apps/web/src/components/layout/app-shell.tsx) лише підключає bootstrap hooks; UI-логіка restore розміщена нижче, в [../../apps/web/src/components/layout/editor-panel.tsx](../../apps/web/src/components/layout/editor-panel.tsx).

## Import / Export flow

```mermaid
flowchart TD
  ExportUser[Користувач: Export] --> ExportStore[project-store.exportProject]
  ExportStore --> ExportProvider[WebStorage.exportProject]
  ExportProvider --> Serialize[serializeToFiles]
  Serialize --> Zip[fflate zip]
  Zip --> Download[Blob download *.simetra.zip]

  ImportUser[Користувач: Import] --> ImportStore[project-store.importProject]
  ImportStore --> ImportProvider[WebStorage.importProject]
  ImportProvider --> Pick[Вибір ZIP]
  Pick --> Unzip[fflate unzip]
  Unzip --> Parse[parseFileStructure]
  Parse --> Build[buildProjectModel]
  Build --> Load[metadata-store.loadModel]
  Load --> Session[saveSession(null, model, version)]
  Session --> Origin[projectOrigin = zip-import]
```

Import/export не залежать від File System Access API і тому є transport-agnostic backup path для браузерів без directory access.

## BRD alignment і поточні розбіжності

Основна структура файлів і serializer contract узгоджені з [../BRD-metadata-configurator.md](../BRD-metadata-configurator.md), особливо з секціями 7.2, 7.3, 7.6 і 7.7. Водночас є кілька важливих уточнень.

| Тема | Поточний код | Статус |
|---|---|---|
| One-file-per-object layout | Реалізовано через `serializeToFiles()` і `KIND_TO_DIR` | current |
| `constants.meta.json` wrapper | Реалізовано; schema wrapper у core, file assembly у web-storage | current |
| Deterministic JSON | Реалізовано в core: key order, 2-space indent, trailing newline, array order preservation | current |
| `$schema` base URL | Відповідає BRD base URL `https://simetra.dev/schemas/` | current |
| Нотація версії в `$schema` | Код формує `/v1.0/`, якщо `schemaVersion = "1.0"`; BRD приклади для `1.0` показують `/v1/` | mismatch, потребує синхронізації документації/конвенції |
| Автоматичні migration/upgrade | BRD описує migration flow, але в коді загальної системи міграцій поки немає | roadmap-only |
| Інші storage providers | `TauriStorage`, `NodeStorage` та інші провайдери відсутні в репозиторії | roadmap-only |

Окремо важливо: поточний код не має DI-based provider injection. `project-store` напряму створює `new WebStorage()`, тому припускати вже наявну змінну provider-архітектуру було б некоректно для поточного стану.

## Стратегія тестування

Поточне тестове покриття розділене по шарах.

### Що вже перевіряється

- [../../packages/core/src/__tests__/schemas.test.ts](../../packages/core/src/__tests__/schemas.test.ts) перевіряє canonical serialization через fixture roundtrip і idempotence для metadata objects.
- [../../apps/web/src/__tests__/storage.test.ts](../../apps/web/src/__tests__/storage.test.ts) перевіряє `toKebabCase()`, `serializeToFiles()`, constants wrapper, trailing newline, byte-identical repeat serialization і базовий roundtrip mapping.

### Що поки не ізольовано окремими тестами

- `session-db.ts` і деградація IndexedDB paths;
- `draft-sync.ts` як окремий debounce/pause/resume механізм;
- restore state machine у `project-store.ts`;
- browser permission flows для `queryPermission()` і `requestPermission()`.

Отже поточна стратегія сильна на pure serialization/mapping рівні, але слабша на integration-рівні browser persistence і recovery orchestration.

## Антипатерни

- Документувати migration/auto-upgrade як уже реалізовані. У поточному коді немає загального migration pipeline.
- Змішувати `WebStorage` з serializer layer. Serializer contract належить core, а `WebStorage` лише мапить модель на файлову структуру і browser I/O.
- Зберігати session/draft у `localStorage`. Поточна архітектура тримає project/session data в IndexedDB, а `localStorage` лишає для стабільних UI preferences у [../../apps/web/src/stores/ui-store.ts](../../apps/web/src/stores/ui-store.ts).
- Ігнорувати наслідки stale file cleanup. Без повного очищення `metadata/` rename/delete залишали б orphaned files і некоректний disk state.
- Припускати, що provider injection уже існує. Поточний `project-store` жорстко прив'язаний до `WebStorage` і не має DI-контейнера чи runtime registry.

## Поточний стан vs roadmap

### Поточна реалізація

- один browser provider: `WebStorage`;
- canonical serializer у core;
- directory save/open через File System Access API;
- ZIP import/export fallback;
- session і drafts в IndexedDB;
- recovery UI через `WelcomeScreen` і `RecoveryBanner`.

### Roadmap-only ідеї

- загальна схема migration/auto-upgrade за `schemaVersion`;
- альтернативні runtime providers поза браузером;
- повноцінна DI-конфігурація storage provider.

## Пов'язана документація

- [OVERVIEW.md](./OVERVIEW.md)
- [state-management.md](./state-management.md)
- [ui-components.md](./ui-components.md)
- [metadata-model.md](./metadata-model.md)
- [patterns-and-decisions.md](./patterns-and-decisions.md)
- [../BRD-metadata-configurator.md](../BRD-metadata-configurator.md)
