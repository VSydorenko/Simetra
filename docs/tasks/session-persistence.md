# Task: Session Persistence — збереження сесії проєкту між перезавантаженнями

## Контекст

Simetra — браузерний конфігуратор метаданих, який працює з файловою системою через File System Access API. Після Phase 1 реалізовано повний storage layer: Open/Save/Export/Import працюють коректно. Метадані зберігаються як canonical JSON на диску (BRD §7).

**Проблема:** Після reload сторінки користувач бачить порожній проєкт. `projectHandle` (FileSystemDirectoryHandle) живе тільки в пам'яті Zustand store без persist. Немає ні auto-restore сесії, ні beforeunload-попередження, ні відображення шляху до проєкту. Поведінка непередбачувана: IDE-подібний інтерфейс, але без IDE-подібного lifecycle.

**Ціль:** Зробити UX як у VS Code: відкрив проєкт → працюєш → reload → проєкт на місці. Файлова система залишається primary storage, IndexedDB — для session restore та crash recovery.

## Вимоги

### Модуль A: Захист від втрати даних (швидкі фікси)

- [Х] Додати `beforeunload` handler в `AppShell`, що попереджає при `isDirty === true`
  - Handler підписується на dirty-стан через `useMetadataStore.version` і `useProjectStore.lastSavedVersion`
  - Стандартний браузерний діалог "Ви впевнені, що хочете покинути сторінку?"
  - Не показувати при `isDirty === false`
- [Х] Відображати шлях/назву директорії проєкту у StatusBar
  - Якщо проєкт збережений через FS API → `projectHandle.name` (назва кореневої папки)
  - Якщо імпортовано з ZIP → i18n ключ `statusBar.importedFromZip`
  - Якщо новий проєкт → i18n ключ `statusBar.notSaved`
  - Формат: іконка папки + назва, ліворуч від лічильника об'єктів
- [Х] Додати `projectDirectoryName` до `ProjectState` — computed з `projectHandle?.name ?? null`

### Модуль B: IndexedDB persistence layer

- [Х] Встановити бібліотеку `idb` (typed wrapper для IndexedDB, ~2KB gzipped)
  - `pnpm --filter web add idb`
- [Х] Створити `apps/web/src/storage/session-db.ts` — обгортка над IndexedDB:
  - Database name: `simetra-session`
  - Object store `session`: зберігає `{ projectHandle, projectModel, lastSavedVersion, savedAt }`
  - Object store `drafts`: зберігає `{ model, version, savedAt }` для crash recovery
  - API:
    - `saveSession(handle, model, version)` — зберігає поточну сесію
    - `loadSession()` — повертає збережену сесію або null
    - `clearSession()` — видаляє сесію (при New Project)
    - `saveDraft(model, version)` — зберігає draft для crash recovery
    - `loadDraft()` — повертає draft або null
    - `clearDraft()` — видаляє draft
- [Х] IndexedDB підтримує зберігання `FileSystemDirectoryHandle` як structured clone
  - Це нативна можливість браузера, серіалізація не потрібна
  - Після reload handle треба перевалідувати через `handle.requestPermission({ mode: 'readwrite' })`

### Модуль C: Auto-restore сесії при старті

- [Х] Створити `apps/web/src/hooks/use-session-restore.ts`:
  - При mount AppShell — перевірити IndexedDB на збережену сесію
  - Якщо є сесія з `projectHandle`:
    1. Спробувати `handle.requestPermission({ mode: 'readwrite' })`
    2. Якщо `granted` — прочитати файли з директорії через існуючий `WebStorage.openFromDirectory(handle)`, завантажити в metadata-store
    3. Якщо `denied` або `prompt` — показати Welcome Screen з кнопкою "Відновити доступ"
  - Якщо є сесія без handle (import з ZIP) — завантажити model з IndexedDB draft
  - Якщо сесії немає — показати Welcome Screen
- [Х] `requestPermission()` вимагає user gesture (клік) — auto-restore **можливий** тільки якщо дозвіл вже granted (persistent permission). Інакше — потрібна кнопка
- [Х] Логіка вибору джерела при restore:
  - IndexedDB draft.version > file system version → запитати: "Є незбережена чернетка. Відновити?" (crash recovery)
  - IndexedDB draft.version === file system version → завантажити з FS (основне джерело)
  - IndexedDB draft.version < file system version → завантажити з FS (файли новіші, наприклад git pull)

### Модуль D: Auto-save draft у IndexedDB

- [Х] Підписатися на зміни metadata-store через `useMetadataStore.subscribe()`
  - Debounce: зберігати draft **не частіше ніж раз на 3 секунди**
  - Зберігати в IndexedDB object store `drafts`
  - Draft — це підстраховка від крашу, не заміна Ctrl+S
- [Х] При успішному `saveProject()` (на диск) — очистити draft
- [Х] При `newProject()` — очистити draft і session
- [Х] При `openProject()` або `importProject()` — оновити session, очистити draft

### Модуль E: Welcome Screen

- [Х] Створити `apps/web/src/components/editor/welcome-screen.tsx`
  - Відображається в центральній панелі, коли немає відкритих вкладок І немає завантаженого проєкту (або це новий порожній проєкт)
  - Дії:
    - "Створити новий проєкт" → `useProjectStore.newProject()`
    - "Відкрити проєкт" → `useProjectStore.openProject()`
    - "Імпортувати з ZIP" → `useProjectStore.importProject()`
    - "Відновити останній проєкт" → restore session з IndexedDB (показувати тільки якщо є збережена сесія)
  - Стиль: мінімалістичний, по центру, з іконками hugeicons
  - Dark theme, compact density — відповідно до дизайн-системи
- [Х] Показувати назву останнього проєкту і дату збереження (з IndexedDB session metadata)
- [Х] Keyboard shortcut: Enter на "Відновити останній" якщо він доступний

### Модуль F: Інтеграція session з project-store

- [Х] Розширити `ProjectState`:
  - `projectDirectoryName: string | null` — `handle?.name ?? null`
  - `sessionRestoreStatus: 'idle' | 'restoring' | 'awaiting-permission' | 'restored' | 'failed'`
- [Х] Розширити `ProjectActions`:
  - `restoreSession()` — зчитати IndexedDB, перевалідувати handle, завантажити model
  - `requestDirectoryPermission()` — для кнопки "Відновити доступ" з Welcome Screen
- [Х] При saveProject — оновити session в IndexedDB (зберегти handle + version)
- [Х] При openProject — оновити session в IndexedDB
- [Х] При newProject — очистити session і draft в IndexedDB
- [Х] При importProject — зберегти model як draft (без handle), очистити session

## Clarify (питання перед імплементацією)

- [ ] **Стратегія draft-порівняння з FS**
  - Чому це важливо: якщо draft новіший за файли на диску, треба визначити що показувати
  - Варіанти: A) Порівнювати version (counter) — просто, але не працює між сесіями. B) Порівнювати вміст (hash) — точно, але повільно. C) Порівнювати timestamp draft vs mtime файлів — compromise
  - Вплив на рішення: архітектура restore flow
  - Рекомендація: version-based + timestamp як fallback

- [ ] **Поведінка при відмові у дозволі на директорію**
  - Чому це важливо: requestPermission може повернути 'denied'
  - Варіанти: A) Показати draft з IndexedDB (read-only mode). B) Показати Welcome Screen з повторним запитом. C) Показати порожній проєкт
  - Вплив на рішення: UX при кожному старті
  - Рекомендація: B — повторний запит через кнопку + показати метадані draft як preview

- [ ] **Розмір IndexedDB quota**
  - Чому це важливо: теоретично IndexedDB обмежений, хоча зазвичай це сотні MB
  - Варіанти: зберігати тільки останній draft vs кілька версій
  - Вплив на рішення: складність session-db
  - Рекомендація: один draft + одна session — мінімальний footprint

## Рекомендовані патерни

### Session DB як ізольований модуль
`session-db.ts` — чиста обгортка над IndexedDB через `idb`. Не імпортує Zustand stores, не знає про React. Повертає plain objects. Stores та hooks викликають session-db, а не навпаки.

### Debounced draft через Zustand subscribe
`useMetadataStore.subscribe()` за межами React lifecycle — у файлі project-store або окремому `draft-sync.ts`. Не useEffect — subscribe працює навіть без mounted компонентів. Debounce через `setTimeout`/`clearTimeout`, без lodash.

### Welcome Screen як частина editor panel
Welcome Screen рендериться в `EditorPanel` коли `openTabs.length === 0` і проєкт порожній або session restore не завершено. Це не окремий route, не modal — просто вміст центральної панелі.

### beforeunload як side effect в AppShell
Один `useEffect` з підпискою на `beforeunload`. Callback перевіряє `isDirty` через `useProjectStore.getState().getIsDirty()` (не через хук — в event handler потрібна актуальна версія).

### Session metadata — мінімальна
IndexedDB зберігає тільки: handle, model (повна копія ProjectModel), version, savedAt (timestamp). Не зберігати UI state (вкладки, виділення) — це вже persist-иться окремо в localStorage через ui-store.

### Handle revalidation — graceful degradation
Після reload `handle.queryPermission()` перед `requestPermission()`. Якщо вже granted — тихий auto-restore. Якщо prompt — показати Welcome Screen з кнопкою. Якщо denied — fallback на draft з IndexedDB.

## Антипатерни (уникати)

### ❌ Persist Zustand store з FileSystemDirectoryHandle
`FileSystemDirectoryHandle` — це structured-clonable об'єкт, але Zustand persist використовує `JSON.stringify`, що **не підтримує handle**. Тому handle треба зберігати в IndexedDB напряму, а не через Zustand persist middleware.

### ❌ Auto-restore без user consent
Браузер блокує `requestPermission()` без user gesture. Не робити `await handle.requestPermission()` у `useEffect` на mount — це не спрацює. Тільки якщо permission вже granted (queryPermission === 'granted'), можна зробити тихий restore.

### ❌ IndexedDB як primary storage
IndexedDB — це backup та session metadata. Primary storage — файлова система (BRD §7). Не замінювати File System Access API на IndexedDB, не відмовлятися від canonical JSON на диску.

### ❌ localStorage для project model
`localStorage` обмежений 5-10 MB і працює тільки з рядками. ProjectModel може вирости, handle не серіалізується в JSON. Тільки IndexedDB.

### ❌ Draft sync всередині React lifecycle
Не робити `useEffect(() => { saveDraft(model) }, [model])` — це ре-рендерить при кожній зміні. Підписка через `useMetadataStore.subscribe()` за межами React, з debounce.

### ❌ Збереження UI state (openTabs, selections) в IndexedDB
UI state вже persist-иться через `ui-store` в `localStorage`. Не дублювати в IndexedDB — це різні lifecycle: UI preferences живуть незалежно від проєкту.

### ❌ Множинні draft-и або версії в IndexedDB
Зберігати тільки один draft і одну session. Це crash recovery, не version control. Для версій є Git.

## Архітектурні рішення

### Потік даних при Save

```
User clicks Save
  → project-store.saveProject()
    → WebStorage.saveProject(model, handle)  — canonical JSON на диск
    → sessionDb.saveSession(handle, model, version)  — IndexedDB
    → sessionDb.clearDraft()  — draft більше не потрібен
    → project-store.markSaved(handle)
```

### Потік даних при Reload

```
Browser reload
  → AppShell mount
    → useSessionRestore()
      → sessionDb.loadSession()
        → if session exists:
          → handle.queryPermission()
            → if 'granted':
              → WebStorage.openFromDirectory(handle)  — читаємо з FS
              → metadata-store.loadModel(model)
              → sessionDb.loadDraft()
                → if draft.version > model.version:
                  → show "Recover unsaved changes?" dialog
            → if 'prompt':
              → show Welcome Screen with "Reopen project" button
                → user clicks → handle.requestPermission() → restore
            → if 'denied':
              → sessionDb.loadDraft()
                → if draft exists: show "Load from backup?" 
                → else: show Welcome Screen
        → if no session:
          → show Welcome Screen
```

### Потік даних при роботі (auto-draft)

```
User edits metadata
  → metadata-store mutation (via immer)
    → Zustand subscribe callback (debounced 3s)
      → sessionDb.saveDraft(model, version)
```

### Структура IndexedDB

```
Database: simetra-session (version 1)
├── Object Store: session
│   └── key: 'current'
│       value: {
│         projectHandle: FileSystemDirectoryHandle | null,
│         projectModel: ProjectModel,
│         lastSavedVersion: number,
│         savedAt: number (timestamp)
│       }
└── Object Store: drafts
    └── key: 'current'
        value: {
            model: ProjectModel,
            version: number,
            savedAt: number (timestamp)
        }
```

## Сумісність з браузерами

| Фіча | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| File System Access API | ✅ | ❌ | ❌ |
| IndexedDB (model + draft) | ✅ | ✅ | ✅ |
| IndexedDB (handle) | ✅ | N/A | N/A |
| Auto-restore з FS | ✅ | ❌ | ❌ |
| Draft recovery з IndexedDB | ✅ | ✅ | ✅ |
| Welcome Screen | ✅ | ✅ | ✅ |

Firefox/Safari: auto-restore директорії неможливий. Draft recovery з IndexedDB працює. Welcome Screen з "Імпортувати з ZIP" як основний UX.

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `docs/BRD-metadata-configurator.md` — формат метаданих (§7), збереження як JSON (§7.2)
- `docs/tasks/phase1-foundation.md` — Модуль 4 (Storage), архітектурні рішення щодо persist
- `.github/instructions/ui-architecture.instructions.md` — правила state management, z-index система
- `.github/instructions/tooling.instructions.md` — стандартні скрипти, тестування

## Послідовність виконання

1. **Модуль A** — beforeunload + StatusBar path (швидкі фікси, без нових залежностей)
2. **Модуль B** — IndexedDB persistence layer (session-db.ts + idb)
3. **Модуль D** — Auto-save draft (subscribe + debounce)
4. **Модуль F** — Інтеграція session з project-store
5. **Модуль C** — Auto-restore сесії (use-session-restore hook)
6. **Модуль E** — Welcome Screen

Кожен модуль будується на попередньому. Після кожного: `pnpm lint ; pnpm typecheck`.

## Тести

- [ ] `session-db.ts`: roundtrip test — save session → load session → порівняти model
- [ ] `session-db.ts`: save draft → load draft → clear draft → load returns null
- [ ] `session-db.ts`: clear session видаляє і session, і draft
- [ ] `project-store`: saveProject оновлює session в IndexedDB
- [ ] `project-store`: newProject очищує session і draft
- [ ] `project-store`: openProject оновлює session
- [ ] `use-session-restore`: якщо немає сесії — повертає 'no-session'
- [ ] `use-session-restore`: якщо є сесія з granted handle — auto-restore
- [ ] `beforeunload`: не спрацьовує коли isDirty === false
- [ ] `StatusBar`: показує handle.name коли проєкт збережений
- [ ] `StatusBar`: показує "Not saved" для нового проєкту
- [ ] `Welcome Screen`: рендериться коли немає вкладок і проєкт порожній
- [ ] `Welcome Screen`: показує "Відновити останній" тільки якщо є session

## Definition of Done

- [ ] Reload сторінки з Chrome/Edge → проєкт відновлюється автоматично (або через один клік)
- [ ] Reload з Firefox/Safari → Welcome Screen з можливістю імпортувати draft з IndexedDB
- [ ] StatusBar показує назву директорії проєкту
- [ ] beforeunload попереджає при незбережених змінах
- [ ] Crash recovery: після крашу вкладки draft відновлюється з IndexedDB
- [ ] Welcome Screen при першому запуску з чіткими діями
- [ ] Auto-draft зберігається в IndexedDB з debounce 3s
- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` — green
- [ ] Усі UI labels через i18n (`t()` helper)
- [ ] Файлова система залишається primary storage (BRD §7)
