# Task: Session Persistence — виправлення критичних дефектів restore flow

## Контекст

Задача `session-persistence.md` реалізована, але code review та глибоке дослідження виявили 11 дефектів різної критичності. Основна структура (session-db, draft-sync, welcome-screen, beforeunload) працює, але restore flow має декілька мертвих шляхів, state machine перевантажена, dirty-семантика ненадійна між сесіями.

Цей файл описує **виправлення існуючого коду**, а не нову функціональність. Усі зміни обмежені `apps/web/src/`.

**Scope:** 7 файлів project-store, draft-sync, session-db, welcome-screen, editor-panel, status-bar, app-shell + нові тести + i18n ключі.

## Вимоги

### Фаза 1: Критичні виправлення store (P0)

#### 1.1 Race condition у saveProject — snapshot version до await
- [x] У `saveProject` (`stores/project-store.ts`) зафіксувати і model, і version з одного синхронного snapshot **до** асинхронного запису на диск
- [x] Поточний стан: model читається до await, але version — після. Якщо користувач змінить model під час IO, version буде новий, а на диску — стара модель
- [x] `lastSavedVersion` оновлювати тільки збереженим snapshot version, не поточним runtime version
- [x] Перевірити ту ж логіку в `openProject` — там version читається після loadModel, що коректно

#### 1.2 Draft-only restore після ZIP import
- [x] У `importProject` (`stores/project-store.ts`) замість `clearSession()` + `saveDraftToDb()` зберігати повноцінну session через `saveSession(null, result.model, version)`
- [x] Це єдина зміна: замість двох викликів — один `saveSession`. Draft-sync продовжить працювати окремо для crash recovery
- [x] Перевірити: після reload з ZIP import → `restoreSession` знаходить session → Welcome Screen показує CTA → `restoreDraft` або `requestDirectoryPermission` працюють

#### 1.3 Debounced draft не скасовується після save
- [x] У `saveProject`, `openProject`, `newProject` замість прямого `void clearDraft()` викликати `stopAndClearDraft()` з `storage/draft-sync.ts`
- [x] `stopAndClearDraft` вже існує, але жодного call site немає — це dead code
- [x] Функція і скасовує pending debounce timer, і очищує IndexedDB — єдина точка відповідальності
- [x] Залишити `pauseDraftSync()` / `resumeDraftSync()` як є — вони працюють коректно для load-time паузи

### Фаза 2: State machine нормалізація (P1)

#### 2.1 sessionRestoreStatus не нормалізується після open/import/new
- [ ] У `newProject`, `openProject`, `importProject` додати `sessionRestoreStatus: 'restored'` до фінального `set({...})`
- [ ] Без цього EditorPanel продовжує показувати Welcome Screen поверх вже завантаженої моделі, якщо немає відкритих вкладок
- [ ] Логіка `showWelcome` в `editor-panel.tsx` залежить від sessionRestoreStatus — після successful open/import/new він має бути `restored`

#### 2.2 Dirty-state після draft restore
- [ ] У `restoreDraft` (`stores/project-store.ts`) записувати `lastSavedVersion: null` замість `draft.version`
- [ ] Семантика: draft recovery — це незбережені зміни, dirty = true — коректна поведінка
- [ ] Поточний стан хибно записує `draft.version` з попередньої сесії; після loadModel runtime counter вже інший, тому dirty буде випадково true/false залежно від порядку операцій
- [ ] `lastSavedVersion: null` означає "ніколи не зберігалося на диск" → `getIsDirty()` → true → beforeunload працює

#### 2.3 Інваріант projectHandle / projectDirectoryName
- [ ] Створити приватний helper у project-store (всередині create callback):
  `const withHandle = (handle: FileSystemDirectoryHandle | null) => ({ projectHandle: handle, projectDirectoryName: handle?.name ?? null })`
- [ ] Використовувати `...withHandle(handle)` скрізь, де store записує projectHandle, замість окремих присвоєнь (8 замін)
- [ ] Окремо: для `awaiting-permission` path, де handle ще не в store, додати поле `pendingDirectoryName: string | null` до ProjectState
- [ ] `pendingDirectoryName` записується тільки в `restoreSession` при prompt/denied, очищується при restored/failed/idle
- [ ] StatusBar використовує `projectDirectoryName ?? pendingDirectoryName`

#### 2.4 Додати projectOrigin для коректного StatusBar
- [ ] Додати поле `projectOrigin: 'new' | 'directory' | 'zip-import' | 'draft-recovery' | null` до ProjectState
- [ ] Виставляти явно:
  - `newProject` → `'new'`
  - `openProject` з handle → `'directory'`, без handle (ZIP fallback) → `'zip-import'`
  - `importProject` → `'zip-import'`
  - `restoreDraft` → `'draft-recovery'`
  - `restoreSession`/`requestDirectoryPermission` з FS → `'directory'`
- [ ] StatusBar (`ProjectDirectoryIndicator`) використовує `projectOrigin` замість евристики `!isNewProject && !projectHandle`

### Фаза 3: Crash recovery та permission fallback (P2)

#### 3.1 Порівняння draft vs FS через timestamp замість version
- [ ] У `restoreSession`, коли FS restore успішний і є draft, порівнювати `draft.savedAt > session.savedAt` замість `draft.version > version`
- [ ] Runtime version counter нестабільний між сесіями (починається з 0). Timestamp стабільний
- [ ] session-db вже зберігає `savedAt` і в session, і в draft — додаткові зміни в DB schema не потрібні

#### 3.2 Recovery prompt для новішого draft
- [ ] Додати стан `'recovery-available'` до типу `SessionRestoreStatus`
- [ ] Додати поле `pendingRecovery: { savedAt: number } | null` до ProjectState
- [ ] У `restoreSession`, якщо `draft.savedAt > session.savedAt`, після успішного FS restore:
  - Виставити `sessionRestoreStatus: 'recovery-available'`
  - Записати `pendingRecovery: { savedAt: draft.savedAt }`
  - Не очищати draft
- [ ] У `requestDirectoryPermission` — та ж логіка замість безумовного `clearDraft()`
- [ ] Створити компонент `RecoveryBanner` — це не модальне вікно, а banner поверх editor content:
  - Показується в EditorPanel коли `sessionRestoreStatus === 'recovery-available'`
  - Текст: "Знайдено незбережені зміни від [дата]. Відновити?" (через i18n)
  - Дія "Відновити" → `restoreDraft()` + `set({ pendingRecovery: null })`
  - Дія "Відхилити" → `clearDraft()` + `set({ sessionRestoreStatus: 'restored', pendingRecovery: null })`
- [ ] EditorPanel: `recovery-available` не показує Welcome Screen, а показує RecoveryBanner поверх editor

#### 3.3 Denied permission — fallback на draft

> **⚠️ Примітка з Фази 1 code-review:** Після виправлення 1.2 (importProject → saveSession(null, ...)), `restoreSession()` для session з `handle: null` не використовує `session.projectModel` — замість цього шукає draft. Якщо draft не встиг зберегтись (draft-sync debounce 3с), проєкт не відновиться. При реалізації 3.3/3.4 потрібно:
> 1. Додати restore path для session з `handle: null` — використовувати `session.projectModel` як джерело відновлення (аналогічно restoreDraft, але з session payload).
> 2. Або забезпечити негайний запис draft при import (крім saveSession), щоб draft завжди був доступний для restore.
> 3. При наявності session з `handle: null` віддавати пріоритет session.projectModel над старим draft від попереднього проєкту.

- [ ] Додати поле `hasDraftFallback: boolean` до ProjectState (default false)
- [ ] У `requestDirectoryPermission`, коли `permission !== 'granted'`:
  - Перевірити `loadDraft()`
  - Якщо draft є → `set({ sessionRestoreStatus: 'awaiting-permission', hasDraftFallback: true })`
  - Якщо draft немає → `set({ sessionRestoreStatus: 'awaiting-permission', hasDraftFallback: false })`
- [ ] У `restoreSession`, denied path — та ж логіка
- [ ] Welcome Screen: якщо `hasDraftFallback === true` і `sessionRestoreStatus === 'awaiting-permission'`, показувати **два** CTA:
  - "Відновити доступ до папки" → `requestDirectoryPermission()`
  - "Відновити з резервної копії" → `restoreDraft()`
- [ ] i18n ключі `welcome.restoreFromBackup` / `welcome.restoreFromBackupDescription` вже заготовлені в uk.json і en.json

#### 3.4 Welcome Screen: одноразове читання session meta
- [ ] Замінити одноразовий `useEffect` + `loadSession()` на комбінований джерело:
  - Спочатку `loadSession()` — якщо є, побудувати sessionMeta
  - Якщо session немає — спробувати `loadDraft()` і побудувати sessionMeta з draft.model.project.name + draft.savedAt + hasHandle: false
- [ ] Додати залежність від `sessionRestoreStatus` — при зміні статусу (наприклад після newProject → clearSession) sessionMeta перечитується
- [ ] Видалити глобальний Enter keydown listener — autoFocus на restore кнопці вже достатній

### Фаза 4: Тести (P2)

#### 4.1 session-db тести
- [ ] Створити `apps/web/src/__tests__/session-db.test.ts`
- [ ] Встановити `fake-indexeddb` (devDependency): `pnpm --filter web add -D fake-indexeddb`
- [ ] У setup файлі або у тесті: `import 'fake-indexeddb/auto'`
- [ ] Тести:
  - roundtrip: saveSession → loadSession → порівняти model, version, savedAt
  - draft lifecycle: saveDraft → loadDraft → clearDraft → loadDraft returns null
  - clearSession видаляє тільки session, draft залишається
  - loadSession повертає null, якщо нічого не збережено
  - loadDraft повертає null, якщо нічого не збережено
  - graceful degradation: якщо IndexedDB недоступний, функції повертають null / не кидають помилок

#### 4.2 project-store інтеграційні тести
- [ ] Створити `apps/web/src/__tests__/project-store.test.ts`
- [ ] Mock-нути `session-db` модуль для контролю повернених даних
- [ ] Mock-нути `WebStorage` для контролю openProject/saveProject
- [ ] Тести:
  - saveProject оновлює session в IndexedDB та викликає stopAndClearDraft
  - newProject очищує session і draft (stopAndClearDraft)
  - newProject виставляє sessionRestoreStatus: 'restored'
  - openProject оновлює session і виставляє sessionRestoreStatus: 'restored'
  - importProject зберігає session з handle: null (не clearSession + saveDraft)
  - restoreDraft виставляє lastSavedVersion: null
  - saveProject snapshot version фіксується до await

#### 4.3 Welcome Screen та EditorPanel тести
- [ ] Створити `apps/web/src/__tests__/welcome-screen.test.tsx`
- [ ] Mock-нути stores та session-db
- [ ] Тести:
  - рендериться коли немає вкладок і проєкт порожній
  - показує "Відновити останній" тільки якщо є session або draft
  - показує два CTA при hasDraftFallback === true
  - не показується після successful open (sessionRestoreStatus: 'restored' + !isNewProject)
  - RecoveryBanner показується при recovery-available

## Clarify (питання перед імплементацією)

- [ ] **startDraftSync lifecycle**
  - Чому це важливо: зараз draft sync стартує в useEffect AppShell, що прив'язує persistence до React lifecycle
  - Варіанти: A) Залишити як є — достатньо для SPA. B) Перенести в main.tsx перед ReactDOM.createRoot
  - Вплив: якщо AppShell unmount-иться (неможливо в поточній архітектурі) — draft sync зупиниться
  - Рекомендація: A — AppShell ніколи не unmount-иться, зміна непотрібна

- [ ] **Видалення полів isNewProject**
  - Чому це важливо: з projectOrigin поле isNewProject стає частково надмірним
  - Варіанти: A) Залишити обидва для зворотної сумісності. B) Замінити isNewProject на projectOrigin === 'new'
  - Рекомендація: A — мінімальний scope, isNewProject використовується в 3 місцях

## Рекомендовані патерни

### Snapshot-before-await для async store actions
Для будь-якої async операції, де потрібна consistency між model і version: зафіксувати обидва значення синхронно з одного getState() до першого await. Не читати state після await — він може змінитися.

### Helper withHandle для парних полів
Парні поля (handle + directoryName) оновлювати через один helper, щоб гарантувати інваріант. Helper визначається як const всередині create callback, не як окремий модуль.

### stopAndClearDraft як єдина точка очистки
Будь-яка операція, що робить draft неактуальним (save, open, new), повинна викликати stopAndClearDraft() з draft-sync.ts замість прямого clearDraft(). Це скасовує pending debounce і очищує IndexedDB атомарно.

### saveSession замість clearSession + saveDraft при import
Для handle-less сесій (ZIP import) зберігати повноцінну session з handle: null. Це дозволяє стартовому restore flow знайти session як зазвичай, без окремого draft-only entry point.

### Timestamp для міжсесійних порівнянь
Runtime version counter — тільки для in-session dirty state. Для порівняння draft vs FS між сесіями — `savedAt` timestamp із session-db.

### RecoveryBanner як inline notification
Crash recovery prompt — це не модальне вікно і не Welcome Screen overlay. Це inline banner в EditorPanel, що з'являється поверх вже завантаженого проєкту і пропонує вибір.

## Антипатерни (уникати)

### ❌ Читання state після await
Не робити `const version = useMetadataStore.getState().version` після `await storage.saveProject(...)`. Між await і наступним рядком model міг змінитися.

### ❌ Окремі присвоєння парних полів
Не писати `set({ projectHandle: handle })` без одночасного `projectDirectoryName: handle?.name`. Використовувати helper.

### ❌ clearDraft напряму з project-store
Не імпортувати clearDraft з session-db у project-store для прямого виклику. Використовувати stopAndClearDraft з draft-sync, який і скасовує таймер, і очищує DB.

### ❌ Version counter для міжсесійного порівняння
Не порівнювати draft.version з runtime metadata-store.version — вони з різних сесій. Використовувати savedAt.

### ❌ clearSession без clearDraft при створенні нового проєкту
API clearSession очищує тільки session store. Якщо семантика дії передбачає повну очистку (new project), треба явно очищати і draft.

### ❌ Модальний діалог для crash recovery
Не використовувати Dialog/Modal для recovery prompt — він блокує роботу. Inline banner дозволяє працювати з проєктом і прийняти рішення пізніше.

### ❌ sessionRestoreStatus перевантажений різними семантиками
`awaiting-permission` одночасно означає "потрібен user gesture для handle" і "є draft fallback". Використовувати додаткові булеві поля (hasDraftFallback) для уточнення семантики замість нових enum значень.

## Архітектурні рішення

### State machine sessionRestoreStatus (після виправлення)

```
               mount
                |
                v
             [idle]
                |
          restoreSession()
                |
                v
           [restoring]
           /    |     \
     granted  prompt   no-session/denied
        |       |              |
        v       v              v
        |  [awaiting-       [idle] (або awaiting-permission
        |   permission]       якщо є draft fallback)
        |       |
        |  user click
        |       |
        v       v
    [restored] --- draft newer? ---> [recovery-available]
        ^                                    |
        |          accept/dismiss            |
        +------------------------------------+

    openProject/importProject/newProject ---> [restored]
```

### Файли що змінюються

```
apps/web/src/
├── stores/project-store.ts        — основні виправлення store logic
├── storage/draft-sync.ts          — без змін (stopAndClearDraft вже є)
├── storage/session-db.ts          — без змін
├── hooks/use-session-restore.ts   — без змін
├── components/
│   ├── layout/
│   │   ├── editor-panel.tsx       — recovery-available check, RecoveryBanner
│   │   └── status-bar.tsx         — projectOrigin замість евристики
│   └── editor/
│       └── welcome-screen.tsx     — dual CTA, draft fallback, sessionMeta refresh
├── i18n/locales/
│   ├── uk.json                    — нові ключі recovery banner
│   └── en.json                    — нові ключі recovery banner
└── __tests__/
    ├── session-db.test.ts         — НОВИЙ
    ├── project-store.test.ts      — НОВИЙ
    └── welcome-screen.test.tsx    — НОВИЙ
```

### Потік даних після виправлення: Import → Reload → Restore

```
importProject()
  → saveSession(null, model, version)     ← замість clearSession + saveDraft
  → draft-sync продовжує працювати

Browser reload
  → restoreSession()
    → loadSession() → session існує (handle: null)
      → немає handle → loadDraft()
        → якщо draft є → awaiting-permission
        → якщо draft нема → idle
    → Welcome Screen бачить sessionMeta
      → CTA "Відновити останній проєкт" → restoreDraft()
        → loadModel(draft.model)
        → lastSavedVersion: null (dirty = true)
        → sessionRestoreStatus: 'restored'
```

### Потік даних після виправлення: FS Restore + Newer Draft

```
restoreSession()
  → loadSession() → session з handle
    → queryPermission === 'granted'
      → openFromHandle(handle) → loadModel → restored
      → loadDraft()
        → draft.savedAt > session.savedAt?
          → ТАК: sessionRestoreStatus: 'recovery-available'
                 pendingRecovery: { savedAt: draft.savedAt }
          → НІ: clearDraft()
  → EditorPanel бачить recovery-available
    → RecoveryBanner: "Знайдено незбережені зміни від [дата]"
      → "Відновити" → restoreDraft() + clearPendingRecovery
      → "Відхилити" → clearDraft() + sessionRestoreStatus: 'restored'
```

## Пов'язана документація

- `docs/tasks/session-persistence.md` — оригінальна задача, яку ця задача виправляє
- `docs/architecture/OVERVIEW.md` — загальна архітектура (§7 State Management, §9 Storage Strategy)
- `docs/BRD-metadata-configurator.md` — формат метаданих, §7 збереження як JSON
- `.github/instructions/ui-architecture.instructions.md` — state management правила, z-index система

## Послідовність виконання

1. **Фаза 1** — P0 критичні виправлення store (saveProject snapshot, import → saveSession, stopAndClearDraft)
2. **Фаза 2** — P1 state machine нормалізація (sessionRestoreStatus, dirty, handle інваріант, projectOrigin)
3. **Фаза 3** — P2 crash recovery та permission fallback (timestamp порівняння, RecoveryBanner, dual CTA, sessionMeta refresh)
4. **Фаза 4** — P2 тести

Після кожної фази: `pnpm lint ; pnpm typecheck`. Після фази 4: `pnpm test`.

## Definition of Done

- [ ] `saveProject` фіксує model і version з одного snapshot до await
- [ ] Після `importProject` → reload → Welcome Screen показує CTA відновлення
- [ ] `stopAndClearDraft()` викликається замість `clearDraft()` у save/open/new
- [ ] Після `openProject`/`importProject`/`newProject` sessionRestoreStatus = 'restored'
- [ ] Після `restoreDraft` lastSavedVersion = null, dirty = true, beforeunload працює
- [ ] projectHandle і projectDirectoryName завжди синхронізовані через helper
- [ ] StatusBar використовує projectOrigin — коректно розрізняє directory, zip-import, draft-recovery
- [ ] Crash recovery: при новішому draft показується RecoveryBanner з вибором
- [ ] Denied permission: показується fallback CTA "Відновити з резервної копії"
- [ ] Порівняння draft vs FS використовує savedAt timestamp, не runtime version
- [ ] Усі 6 тестових файлів зелені: session-db, project-store, welcome-screen
- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` — green
- [ ] Усі нові UI labels через i18n (`t()` helper)
- [ ] Жодних нових залежностей крім `fake-indexeddb` (devDependency)
