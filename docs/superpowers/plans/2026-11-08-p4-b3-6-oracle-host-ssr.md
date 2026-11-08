# П4-B3-6. Оракул, тестовий хост і SSR — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** SSR-гідратація даних T4 за §6.6 — сторінка з даними гідрується без
запиту даних і без зміни DOM, знімок одного суб'єкта не потрапляє іншому;
браузерний оракул заборонених кадрів у Chromium і WebKit на production- і
dev-збірці тестового хоста ловить мерехтіння й не дає хибно-зеленого
результату; мережеві бюджети браузерних сценаріїв — тести; job `oracle` у CI.

**Архітектура:** SSR — модуль ядра B3-2 `store/ssr.ts` і звірка після
гідратації в рантаймі. Тестовий хост — приватний пакет воркспейсу
`packages/test-host` на TanStack Start зі штатними опціями §6.6. Дані —
справжній `createDataHandler` (`simetra/server`) над фейковим
`CommandRuntime` у пам'яті, тож конверт, звірка сумісності, частина
`version`, бюджет відповіді й правило походження — код T3, а фейк — лише
шар даних з тестом еквівалентності проти справжнього рантайму на базі.
Оракул — записувач і правила спайку вікна як основа, посилені за аудитом:
дозволи на рядки, засів треків на вході в сегмент, перевірка повноти журналу,
сентинели суб'єкта; самотест — точний вид порушення на мутацію й чиста пара.

**Стек:** TypeScript, React 19, TanStack Start 1.169.4 і Router 1.170.46
(піни тесту пакування), `@tanstack/react-virtual` (пін B3-3), Playwright
(точний пін, той самий, що тег образу контейнера CI), Vite, Vitest.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) Рд36, Рд38,
Рд39, Рд45, §6.6, §12 рядки «браузерний оракул», «SSR», «Мережеві бюджети» і
«CI оракула», §12 «Належність кейсів блокам», §13 рядок B3-6, §14.3; звіти
спайків [UI й SSR](../specs/2026-11-08-t4-ux-spike-report.md) і
[вікна](../specs/2026-11-08-t4-window-spike-report.md); [план
B3-3](2026-11-08-p4-b3-3-window-public-api.md).

**Поділ і залежності.** Після мерджу B3-3, B3-4 і B3-5. **Передумова B3-6b**
— межа фреймворку для `packages/test-host` (Task 0, затверджено власником
2026-11-08).
П'ять частин з власним «готово»: **B3-6a** (Task 1–3) — SSR у ядрі й
рантаймі; **B3-6b** (Task 4–6) — пакет хоста, фейковий рантайм і маршрути;
**B3-6c** (Task 7–9) — оракул, unit-тести правил, сценарії й самотест;
**B3-6d** (Task 10–11) — SSR-кейси й бюджети; **B3-6e** (Task 12–13) — CI і
спеки. Кейси `rightsVersion` (свіжий знімок з версією прав, «права змінились —
`purge`») — **B5** разом зі знімком прав (§13). Код спайків — лише еталон.

## Global Constraints

- Рантайм даних на сервері — на запит у фабриці роутера, ніколи на рівні модуля; анонімний запит рантайму не створює й даних у HTML не кладе.
- Знімок у HTML: склади готових підмножин і `atEnd` вікон, рядки лише цих підмножин зі `stale` (три позначки), `versionEpoch` (B1c) і версіями проєкції лінивих полів, ТЧ з `ownerVersion`, слоти `removed` без значень; без слабко утриманих рядків (B3-3 Р8), журналу мутацій, слухачів і рядків без власника; тотожність `{ subject, catalogHash, rightsVersion?, issuedAt, ttlMs }` (`ttlMs` 60 000).
- Відповідь із персональним знімком — `Cache-Control: private, no-store` і `Vary: Cookie`.
- Гідратація — до першого рендера; знімок гідрується завжди; `endHydration()` — один раз.
- Звірка після гідратації — один запит `read`: частина `version`, а за відсутності `rightsVersion` чи простроченого знімка — і частини перечитування видимих виглядів того самого такту мікрозадач; інший `subject` закриває наявний шлях `session-changed` (B3-2); інший `catalogHash` — `onStaleClient()` і `stale` без перечитування як свіжих даних.
- TanStack Start — лише штатні опції §6.6.
- Пороги оракула: `shift` — `|Δtop| ≥ 1 px`; `scroll-rigid` і якір — допуск 2 px; накопичений дрейф від базового знімка сегмента — понад 2 px; `blank` — смуга понад 2 px; `playwright.config.ts` фіксує `deviceScaleFactor: 1` і `viewport`.
- Оракул: правила — чиста функція; дозвіл сегмента — `{ kind, region, keys?, fields? }`, а не на весь сегмент; `removed-restore` — лише для названого рядка; журнал без досягнутих позначок чи без рядків очікуваних зон — червоний; знімки екрана — діагностика, не гейт.
- Самотест: кожна мутація має точний очікуваний вид порушення, сегмент і зону для кожного браузера; кожен вид порушення має щонайменше одну мутацію, де він — єдиний очікуваний; кожна мутація має чисту пару; `layout-shift` — лише Chromium.
- Playwright: обидва проєкти визначені завжди, нога запускає `--project`; `retries: 0`, `forbidOnly`, `reuseExistingServer: !process.env.CI`, порт ноги — з середовища; перший тест ноги перевіряє `browserName` і `window.__oracleBuild` (значення з `import.meta.env.PROD`, а не зі змінної ноги); збірку ноги обирає змінна `ORACLE_BUILD` (`production` чи `dev`); пропущений тест у теках оракула — червоний.
- Тестовий хост — приватний пакет (`"private": true`), не публікується; `simetra/data/testing` — dev-only вхід `exports`, не в `publishConfig.exports`.
- Коментарі — українською й про «чому».

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | Тестовий хост — приватний пакет `packages/test-host` з власними `eslint.config.js`, `vitest.config.ts` (без `e2e/**`), скриптами `lint`, `typecheck`, `test`, `e2e`; імпорт `simetra` — з `exports` | гейти репозиторію бачать його, а Vitest не збирає специфікацій Playwright | §14.3 П4-B (Task 13); межа фреймворку `AGENTS.md` — Task 0 (затверджено власником 2026-11-08) |
| Р2 | Дані хоста — справжній `createDataHandler` над фейковим `CommandRuntime` у пам'яті, що живе в `packages/simetra/src/server/testing/` під лінт-зоною T3 і dev-only входом `simetra/server/testing` (механізм Р6), тож хост і designer беруть його через `exports` (`createFakeRuntime(catalog: RuntimeCatalog, seed)`: `read`, `readParts`, `run`, квитанції; фільтр, сортування, keyset, `known` і маркери — проста модель) і тест еквівалентності фейку проти справжнього рантайму на базі (designer DB-тест, спільні фікстури) | конверт, сумісність, `version`, бюджет відповіді й походження — код T3, тож шляхи T3 у фільтрі CI справді перевіряються; розбіжність моделі ловить тест еквівалентності | немає |
| Р3 | SSR ядра — `store/ssr.ts` (поряд із `object-store.ts`, `section-store.ts`, `window.ts`, `epoch.ts`): знімок рядків з `versionEpoch` і трьома позначками `stale`, ТЧ, складів і курсорів сторінок вікна; епоха сесії не переноситься (новий рантайм — свої епохи) | гідратований рядок мусить іти в `known` за правилом B3-3 | немає |
| Р4 | Частина `version` — у збирачі B3-3: `CorePart` і `CoreReadItem` зі значенням `VersionValue`, група Server Function навіть за перевизначеного адаптера | §6.6: один запит після гідратації | немає |
| Р5 | `RuntimeHolder.hydrateFrom(snapshot, create: (subject: string) => DataRuntime)` — host дає фабрику рантайму | тримач B3-3 не знає каталогу й транспорту | немає |
| Р6 | `simetra/data/testing` (`countingTransport`) і `simetra/server/testing` (фейковий рантайм) — dev-only входи в `exports` `packages/simetra/package.json`, без `publishConfig.exports` (як `./ui` і `./shell` сьогодні); тест пакування доводить, що його не опубліковано | хост бере помічник як споживач, а в пакет він не йде | немає |
| Р7 | Бюджети браузера: `countingTransport` у клієнті звіряється з мережевим журналом Playwright (`/_serverFn/`) — розбіжність червона; кожен бюджет «0» має позитивний контроль на тій самій тривалості; байти знімка — за скриптом дегідрованих даних, а не всім HTML | лічильник бачить лише те, що пройшло через нього, а нульовий бюджет на короткому вікні проходить завжди | немає |
| Р8 | CI: `oracle-changes` (без контейнера, `fetch-depth: 0`; `node --test` трьох файлів з перевіркою кількості тестів; скрипт шляхів з `--no-renames` дає `run=false` лише тоді, коли перелік змінених файлів непорожній і всі вони — у `docs/**`, `legacy/**`, `.agents/**` чи `*.md`; порожній перелік, помилка, неперевірені base і head (обидва SHA існують і різні) і `push` у `main` — `run=true`; перевірка, що тег образу Playwright у `ci.yml` дорівнює піну `@playwright/test`), `oracle-leg` (матриця `chromium`/`webkit` × `production`/`dev`, контейнер `mcr.microsoft.com/playwright:v<пін>` з `actions/setup-node` за `.node-version` усередині, `timeout-minutes: 20`, самотест — лише в ногах `production`; після прогону скрипт `.github/scripts/playwright-gate.mjs` читає JSON-звіт Playwright і червоніє за будь-якого пропущеного тесту чи кількості тестів, меншої за очікувану для ноги), агрегатор `oracle` (`needs` обох, `if: always()`, логіка — скрипт `.github/scripts/oracle-gate.mjs`: успіх лише коли `oracle-changes.result == success` і (`run == false` та ноги `skipped`) чи (`run == true` та ноги `success`), інакше відмова) | агрегатор не мусить зеленіти, коли впав сам фільтр чи умова ніг хибна | §12 П4-B (Task 13) |

| Р9 | Кожен сценарій має кінцеву умову ефекту дії з двох частин: стан DOM (нове значення, `removed`, банер, `scrollTop`, склад) і журнал фейкового рантайму (виклики `run` з `mutationId`, квитанції, `readParts` з `known`) | оракул ловить лише заборонені кадри, тож сценарій, у якому нічого не сталося, був би чистим за побудовою | немає |
| Р10 | Згенеровані артефакти хоста (`generated/client-catalog.json`, `generated/runtime-catalog.json`, `src/routeTree.gen.ts`) комітяться; тест хоста перевіряє їхню свіжість (перегенерація в тимчасову теку й порівняння) | `checks` CI біжить на чистому checkout без кроку генерації | немає |

Кожне рішення — розвилка до погодження архітекторкою.

## Review Focus

1. **Агрегатор зелений за впалого фільтра чи пропущених ніг на зміні T4**:
   таблиця логіки — Task 12.
2. **Мертве правило оракула** (вид без мутації, де він єдиний): таблиця
   самотесту — Task 9.
3. **Порожній журнал чи недосягнута позначка**: червоний — Task 7.
4. **Знімок одного суб'єкта в HTML іншого**: сентинели суб'єктів — Task 10.
5. **Нульовий бюджет на короткому вікні**: позитивний контроль — Task 11.

---

## Task 0 (передумова B3-6b): межа фреймворку — затверджено власником 2026-11-08

**Files:** `AGENTS.md` (§ «Target architecture vs. the prototype»), лінт-зона межі фреймворку (`packages/simetra/eslint.tier-zones.js` і, якщо зона діє на рівні репозиторію, кореневий `eslint.config.js`) та її негативний тест (`packages/simetra/test/tier-boundary.test.ts`).

- [ ] У речення «the host template and the studio are the only places that import TanStack Start» додати тестовий хост `packages/test-host` поряд із шаблоном host-а й студією.
- [ ] Лінт-зона дозволяє імпорт TanStack Start лише в `packages/test-host` серед нових місць; негативний тест: імпорт `@tanstack/react-start` поза дозволеними місцями — відмова, у `packages/test-host/**` — прохід.
- [ ] Commit: `docs(agents): тестовий хост у межі фреймворку (затверджено власником)`.

## B3-6a. SSR у ядрі й рантаймі

### Task 1: `dehydrate`, `hydrate`, `endHydration` у ядрі

**Files:**
- Create: `packages/simetra/src/data/store/ssr.ts`, `packages/simetra/src/data/store/__tests__/ssr.test.ts`
- Modify: `core.ts` (методи сесії), `types.ts` (`CoreSnapshot`), `object-store.ts` (серіалізація рядка з `versionEpoch`, позначками `stale`, версіями проєкції), `section-store.ts` (ТЧ з `ownerVersion` і повнотою), `window.ts` (склади й курсори власних сторінок; знімки показу не йдуть), `subsets.ts` (утримання знімком до першої підписки)

**Interfaces:**
- Produces: `CoreSession.dehydrate(): CoreSnapshot`, `hydrate(snapshot: CoreSnapshot): void`, `endHydration(): void`; `CoreSnapshot = { format: 1; subject: string; objects; sections; subsets }`.

- [ ] **Step 1: Unit:** знімок — лише рядки підмножин знімка (слабко утримані, рядки без власника й журнал — ні), слоти `removed` без значень, позначки `stale`, `versionEpoch`, версії проєкції, ТЧ з `ownerVersion`; `hydrate` дає ті самі знімки виглядів; підписка після `hydrate` — без запиту; гідратований рядок іде в `known` при перечитуванні; `endHydration` удруге — нічого; невзята підмножина звільняється через `releaseDelayMs`; `hydrate` після `dispose()` — нічого.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test ssr core`.
- [ ] **Step 3: Модельний тест** — крок «дегідрація й гідрація в новому рантаймі» з інваріантом «знімки виглядів рівні до й після».
- [ ] **Step 4: Commit.** `feat(data): SSR-знімок ядра`

### Task 2: Тотожність знімка, API рантайму й тримача

**Files:**
- Create: `packages/simetra/src/data/runtime/ssr.ts`, `packages/simetra/src/data/runtime/__tests__/ssr.test.ts`
- Modify: `runtime/runtime.ts`, `runtime/holder.ts` (B3-3), `packages/simetra/src/data/index.ts`

**Interfaces:**
- Produces: опція `createDataRuntime({ now?: () => number })` — годинник рантайму; `DataRuntime.dehydrate(): DataSnapshot`, `DataSnapshot = { meta: SnapshotMeta; core: CoreSnapshot }`, `SnapshotMeta = { subject; catalogHash; rightsVersion?: string; issuedAt: number; ttlMs: number }`; `DataRuntime.hydrate(snapshot)`, `endHydration()`; `RuntimeHolder.hydrateFrom(snapshot, create)`.

- [ ] **Step 1: Unit:** мета `catalogHash` — `snapshotHash` каталогу **сервера** (§6.6; серверний рантайм рендера бере його з каталогу рантайму, а клієнт звіряє з власним), різні хеші сервера й клієнта — `catalog-changed`, без `rightsVersion` до B5, `issuedAt` з годинника рантайму; знімок туди й назад через `JSON.stringify`; `hydrateFrom` створює рантайм суб'єкта знімка фабрикою host-а.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test ssr runtime holder`.
- [ ] **Step 3: Commit.** `feat(data): тотожність SSR-знімка й API рантайму`

### Task 3: Звірка після гідратації

**Files:**
- Modify: `runtime/ssr.ts` (`verifyAfterHydration`), `store/batcher.ts` і `store/source.ts` (частина `version`, Р4). Спирається на B1c у `main`: частина `version` конверта `read` і `readParts` T3 уже є; якщо ні — блок не стартує
- Test: `runtime/__tests__/ssr.test.ts`, `store/__tests__/batcher.test.ts`

- [ ] **Step 1: Unit (`it.each` за гілкою):** знімок без `rightsVersion` (до B5 — завжди) — один запит з частиною `version` і частинами перечитування видимих виглядів, склад незмінний; прострочений — так само; інший `catalogHash` — `onStaleClient()` без об'єкта й `stale` рядків знімка без перечитування як свіжих; відповідь `session-changed` — закриття рантайму з причиною наявним шляхом; StrictMode — одна звірка; частина `version` за перевизначеного адаптера об'єкта — у групі Server Function; наскрізний тест (справжній `createDataHandler` над фейковим рантаймом) — звірка після гідратації дає рівно один запит транспорту.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test ssr batcher source`.
- [ ] **Step 3: Commit.** `feat(data): звірка після гідратації одним запитом`

**Готово B3-6a:** unit-тести SSR ядра, рантайму й збирача, модельний крок гідратації зелені.

## B3-6b. Пакет хоста, фейковий рантайм, маршрути

### Task 4: Пакет хоста й вхід `simetra/data/testing`

**Files:**
- Create: `packages/test-host/package.json` (`"name": "test-host"`, `"private": true`; залежності — `simetra` (`workspace:*`), `react`, `react-dom`, `@tanstack/react-start` 1.169.4, `@tanstack/react-router` 1.170.46, `@tanstack/react-virtual`; dev — `@playwright/test`, `vite`, `@vitejs/plugin-react`, `vitest`, `@simetrajs/designer` (`workspace:*`, для скрипту `catalog`), `eslint`, `@eslint/js`, `typescript-eslint`, аліаси `typescript` і `@typescript/native` за зразком `packages/simetra`, `@types/react`, `@types/react-dom`, `@types/node`; точні піни; скрипти `build`, `lint`, `typecheck`, `test`, `e2e`), `eslint.config.js`, `vitest.config.ts` (`exclude: ["e2e/**"]`), `tsconfig.json`, `vite.config.ts`, `.gitignore` (`test-results/`, `playwright-report/`, `.output/`, `dist/`), `metadata/` (проєкт метаданих хоста: об'єкти списку `Item`, вікна `WinItem` на 100 000 рядків, ТЧ `lines`, об'єкт з копією носія), скрипт `catalog` (компілює `client-catalog.json` і `runtime-catalog.json` у `generated/`; артефакти комітяться, Р10), тест свіжості артефактів `src/__tests__/generated-fresh.test.ts`
- Modify: `packages/simetra/package.json` (`exports` — `./data/testing` лише для розробки, Р6), `packages/designer/test/packaging/published-packages.pack.test.ts` (`./data/testing` не опубліковано), `.syncpackrc.json` (група пінів хоста), `.prettierignore` (`packages/test-host/metadata/**`, `generated/**`, `routeTree.gen.ts`), `pnpm-lock.yaml`

- [ ] **Step 1:** `pnpm install`; `pnpm --filter test-host catalog`, `typecheck`, `lint`, `test` (порожній набір) зелені; тест пакування — `./data/testing` поза опублікованими `exports`.
- [ ] **Step 2: Commit.** `feat(test-host): пакет тестового хоста`

### Task 5: Фейковий `CommandRuntime` і еквівалентність

**Files:**
- Create: `packages/simetra/src/server/testing/fake-runtime.ts`, `seed.ts` (малий спільний сід еквівалентності), `packages/simetra/src/server/testing/__tests__/fake-runtime.test.ts`, `packages/designer/src/__tests__/fake-runtime-equivalence.db.test.ts`; dev-only вхід `./server/testing` у `exports` (Р6)
- Create: `packages/simetra/src/server/testing/control.ts` (керування сценарію: `latency`, `failNext`, `hold`/`release`, `edit`, `remove`, `insert`, `lostReplyNext`; сентинел суб'єкта в кожному рядку — унікальний текст поля назви)

**Interfaces:**
- Produces: `createFakeRuntime(catalog: RuntimeCatalog, seed: FakeSeed): { runtime: CommandRuntime; control: FakeControl }` — видимість — предикат скоупу на суб'єкта; `readParts` з `known` і маркерами, `run` з версією з лічильника й квитанціями за `mutationId`, конфліктом версії й доменною відмовою; виконує `fit` із `readParts` (`batch-budget`, `response-too-large`); журнал викликів (`run`, `receipt`, `readParts` з `known`) для кінцевих умов Р9.

- [ ] **Step 1: Unit:** справжній `createDataHandler(fake.runtime)` — конверт поза схемою — `command.invalid`; несумісна колонка — `stale-client`; `known` рівної версії — маркер; невидимий суб'єкту рядок — відсутній; повтор `mutationId` — збережений результат.
- [ ] **Step 2: DB `fake-runtime-equivalence.db.test.ts`** (причина DB: справжній T3 на базі; малий сід `seed.ts`): одна таблиця сценаріїв через `createDataHandler` над фейком і над справжнім рантаймом на базі — читання (фільтри, сортування, keyset вперед і назад з `NULL`, маркери з копіями, видалений рядок, предикат видимості суб'єкта, бюджет сторінки й `batch-budget`), частина `version`, `run` (створення, зміна, конфлікт версії, доменна відмова), квитанції повтору й втраченої відповіді. `known` кожна сторона будує з власного попереднього читання. Нормалізація — поіменно: версії й `epoch` порівнюються за порядком і рівністю між собою, а не за значенням; `serverHash` — за рівністю між відповідями однієї сторони; решта полів — дослівно.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test fake-runtime`, `pnpm --filter @simetrajs/designer test:db fake-runtime-equivalence`.
- [ ] **Step 4: Commit.** `feat(server): фейковий CommandRuntime для тестів з тестом еквівалентності`

### Task 6: Маршрути, сервер і клієнт хоста

**Files:**
- Create: `packages/test-host/src/router.tsx` (фабрика роутера: тримач на запит, `dehydrate`, `hydrate` через `hydrateFrom`, опції §6.6; серверний рантайм закривається `dispose()` після `dehydrate`, тож таймери `releaseDelayMs` не переживають запит), `src/server.ts` (заголовки кешу для HTML), `src/server/fns.ts` (одна Server Function даних — `createDataHandler(fake.runtime)` з `RequestOrigin`; сесія з cookie; керування сценарію — окрема Server Function, яку сервер виконує лише тоді, коли процес запущено з `ORACLE_CONTROL_TOKEN` і запит несе той самий токен (інакше — відмова й 404); `scripts/serve-prod.mjs` слухає лише `127.0.0.1`), `src/client.tsx` (`hydrateRoot` під StrictMode; `onRecoverableError` → `window.__oracleRecoverable`; транспорт — `countingTransport` → `window.__oracleTransport`; `window.__oracleBuild`), `src/routes/{__root,index,login,full,items.$id,window}.tsx` (ефект кореня після commit ставить `window.__oracleHydrated`), `src/breaks.ts` (мутації самотесту — прапорець збірки, не окрема збірка), `scripts/serve-prod.mjs`, `playwright.config.ts` (Global Constraints)

- [ ] **Step 1:** `pnpm --filter test-host build`; `e2e` смоук-тест у кожному проєкті перевіряє `browserName` і `window.__oracleBuild` проти змінних ноги й наявність атрибутів контракту оракула на кожному маршруті.
- [ ] **Step 2: Commit.** `feat(test-host): маршрути, сервер і клієнт хоста`

**Готово B3-6b:** пакет, фейковий рантайм з еквівалентністю, маршрути й смоук зелені.

## B3-6c. Оракул, сценарії, самотест

### Task 7: Записувач і правила з unit-тестами

**Files:**
- Create: `packages/test-host/oracle/recorder.js`, `rules.ts`, `harness.ts`, `packages/test-host/oracle/__tests__/rules.test.ts`

**Interfaces:**
- Produces: контракт хоста — `[data-region]`, `[data-row-key]`, `[data-field]` (зокрема `INPUT`, `TEXTAREA`, `SELECT`), `[data-state]`, `[data-scroll]`, `[data-skeleton]`, `[data-loading]`, `[data-stream-slot]` (лише листовий елемент), `#app`, `window.__oracleHydrated`, `window.__oracleRecoverable`; записувач — видимість рядка через `checkVisibility({ opacityProperty: true, visibilityProperty: true })`, стиль і текст кожного поля, `textContent` рядка окремим значенням, текст зони без обрізання; ключ дедуплікації знімків включає й текст усього `#app`, тож перехідний текст поза зонами потрапляє в журнал; `analyze(log): Violation[]` з видами `empty-after-data`, `blank`, `presence-aba`, `value-aba`, `reorder`, `shift`, `height`, `scroll-jump`, `scroll-rigid`, `layout-shift`, `forbidden-text`, `hydration-mutation`, `hydration-late` (`marks[0].t < hydratedAt`), `hydration-error`, `region-shift` (зсув рамки зони відносно вікна без дозволу — ловить і зсув зони банером, у тому числі в WebKit, де `layout-shift` немає), `scroll-drift` (накопичений залишок `d0 − dScroll − wheel` від базового знімка сегмента понад 2 px під дозволом `scroll`); дозвіл — `{ kind, region, keys?, fields? }`; на вході в сегмент треки присутності й значень засіваються з попереднього знімка; під дозволом `scroll` `presence-aba` діє для рядків, видимих в обох суміжних знімках; слот потоку — одне заповнення без зміни висоти; `expectClean({ regions, marks })` червоніє, коли позначку не досягнуто, зона сегмента без рядків чи лічильник кадрів (`log.frame`) не зріс у сегменті з очікуваними зонами; `forbidden-text` перевіряє весь `#app`, а не лише зони.

- [ ] **Step 1: Unit `rules.test.ts` (синтетичні журнали, `it.each`):** кожна заборона на мінімальному журналі; дозвіл рядка A не гасить порушення рядка B; рядок відсутній у першому знімку сегмента n + 1 і повертається — `presence-aba`; значення попереднього сегмента повертається — `value-aba`; `removed-restore` лише для названого ключа; рядок, схований стилем предка, — як відсутній; позначка до гідратації — `hydration-late`; порожній журнал чи недосягнута позначка — `expectClean` червоний; граничні пороги — `shift` 0,9 px чисто й 1,0 px порушення, `scroll-rigid` 2,0 px чисто й 2,1 px порушення; 30 знімків по 1,5 px — `scroll-drift`; зсув рамки зони — `region-shift`; сегмент без приросту кадрів — червоний.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter test-host test rules`.
- [ ] **Step 3: Commit.** `feat(test-host): записувач і правила оракула з unit-тестами`

### Task 8: Сценарії оракула

**Files:**
- Create: `packages/test-host/e2e/flows.ts`, `e2e/list.spec.ts` (SSR-вхід; список → картка → список без запиту; фонове перечитування — змінений на місці, зниклий — `removed`, новий — `hasNewRows`, склад змінює лише `showNew()`; змінене поле сортування; зміна суб'єкта з відповіддю старого в дорозі й сентинелом старого як `forbidText`; StrictMode; повторне монтування після `releaseDelayMs`; осідання під час навігації; потоковий SSR), `e2e/write.spec.ts` (правка поля обох політик; відмова й «Скасувати»; створення), `e2e/window.spec.ts` (50 сторінок вниз і назад; те саме з вивантаженням і межею знімків; `goTo` в кінець і назад; зміна сортування; оновлення посередині; змінна висота й ліниве поле; розбіжні паралельні читання — дозвіл `removed-restore` лише для названого рядка)

- [ ] **Step 1: `list.spec.ts`** — кожен сценарій: `expectClean({ regions, marks })` і кінцева умова Р9; знімки екрана — діагностика. Commit `test(test-host): сценарії списку`.
- [ ] **Step 2: `write.spec.ts`** — те саме; кінцева умова — журнал `run` з `mutationId` і нове значення чи відкат у DOM. Commit `test(test-host): сценарії запису`.
- [ ] **Step 3: `window.spec.ts`** — те саме; кінцева умова — склад, `scrollTop` і `readParts` з `known` на поверненні. Commit `test(test-host): сценарії вікна`. Сигнальні сценарії р1–р9 — B5.
- [ ] **Step 4: Прогін у чотирьох комбінаціях.** `ORACLE_BUILD=production pnpm --filter test-host e2e --project=chromium` (і `webkit`, і `ORACLE_BUILD=dev`).

### Task 9: Мутаційний самотест

**Files:**
- Create: `packages/test-host/e2e/oracle-self.spec.ts`

- [ ] **Step 1: Таблиця** — на кожну мутацію точний вид, сегмент і зона для кожного браузера, і чиста пара на тому самому сценарії: `skeleton` → `empty-after-data`; `flash` → `presence-aba`; `revert` → `value-aba`; `reorder` → `reorder`; `nudge` (зсув одного рядка на 4 px) → `shift`; `heightjump` → `height`; `scrolljump` → `scroll-jump`; `noanchor` → `scroll-rigid`; `asyncrender` → `blank`; `lazyshift` → `layout-shift` (Chromium) і `height` (WebKit); `keepcore` → `forbidden-text`; `hydration` → `hydration-mutation`; `latehydrate` → `hydration-late`; `throwhydrate` → `hydration-error`; `restore-other` → `presence-aba`; `highlight` → `value-aba`; `banner-push` (банер над зоною без резерву місця) → `region-shift`; `drift` (якір зсуває рядки на 1,5 px за кадр) → `scroll-drift`; `run-noop` (запис нічого не робить) → кінцева умова `write.spec` червона; `toast-leak` (сентинел старого суб'єкта на мить у тості поза зонами після зміни суб'єкта) → `forbidden-text`. Кожен вид з Task 7 має мутацію, де він — єдиний очікуваний. Сценарій, що впав до останньої позначки, — червоний тест. У Chromium перевірка `shiftsUnsupported === false`.
- [ ] **Step 2: Прогін** — повна таблиця в ногах `production` обох браузерів; у ногах `dev` — скорочений самотест: `hydration`, `throwhydrate`, `latehydrate`, `skeleton`.
- [ ] **Step 3: Commit.** `test(test-host): мутаційний самотест оракула`

**Готово B3-6c:** unit-тести правил, сценарії в чотирьох комбінаціях і самотест у ногах `production` зелені.

## B3-6d. SSR-кейси й бюджети

### Task 10: SSR-кейси

**Files:**
- Create: `packages/test-host/e2e/ssr.spec.ts`

- [ ] **Step 1:** HTML містить рядки й сентинел свого суб'єкта; перший кадр без скелета; після гідратації — один запит `read` (частина `version` і перечитування видимих виглядів, бо `rightsVersion` до B5 немає), 0 commit-ів зони рядків після її монтування, 0 мутацій DOM (`hydration-mutation`, `hydration-late`); інший `catalogHash` — `onStaleClient()` і `stale` без перечитування; прострочений знімок — перечитування без зміни складу; 10 пар паралельних SSR-запитів двох суб'єктів — кожен HTML містить свій сентинел і не містить чужого; зміна cookie з суб'єкта A на B після отримання HTML A і до звірки — відповідь `session-changed`, змонтовані хуки показують причину закриття, рядків і сентинела A немає; анонім — без даних; `Cache-Control: private, no-store` і `Vary: Cookie`; `endHydration` один раз під StrictMode. Кейси `rightsVersion` — B5.
- [ ] **Step 2: Прогін у чотирьох комбінаціях.**
- [ ] **Step 3: Commit.** `test(test-host): SSR-кейси`

### Task 11: Мережеві бюджети браузерних сценаріїв

**Files:**
- Create: `packages/test-host/e2e/budgets.spec.ts`

- [ ] **Step 1** (лічильник транспорту звіряється з мережевим журналом `/_serverFn/`, розбіжність — червоно): SSR-вхід після гідратації — 1 запит; знімок SSR — байти скрипту дегідрованих даних ≤ 1,1 × корисних + 2 КіБ; відкриття списку без SSR — 1 запит, відповідь ≤ 1,1 × корисних + 2 КіБ; прокрутка на нову сторінку — ≤ 1 запит на сторінку з тим самим лімітом байтів; повернення сторінки-знімка без змін — 1 запит, відповідь ≤ 8 Б × рядків + 2 КіБ, тіло ≤ 64 Б × ключів `known` + 2 КіБ; правка поля `await` — 1 `run`, відповідь — рядок результату; список → картка зі сховища — 1, ≤ 1,1 × корисних + 2 КіБ; картка → список у межах `releaseDelayMs` — 0, з позитивним контролем (той самий перехід після `releaseDelayMs` — 1). Бюджети `resume()`, інтервалу, прихованої вкладки, приєднання й сигналів — B5 (їхні механізми вводить B5).
- [ ] **Step 2: Прогін.**
- [ ] **Step 3: Commit.** `test(test-host): мережеві бюджети браузерних сценаріїв`

**Готово B3-6d:** SSR-кейси й бюджети зелені в Chromium і WebKit, production і dev.

## B3-6e. CI і спеки

### Task 12: Job `oracle`

**Files:**
- Modify: `.github/workflows/ci.yml` (jobs `oracle-changes`, `oracle-leg`, `oracle` за Р8)
- Create: `.github/scripts/oracle-paths.mjs`, `oracle-gate.mjs`, `image-pin.mjs`, `playwright-gate.mjs`, `.github/scripts/__tests__/{oracle-paths,oracle-gate,image-pin,playwright-gate}.test.mjs`

- [ ] **Step 1: Unit** (`node --test` чотирьох файлів `.github/scripts/__tests__/*.test.mjs`, перелічених явно, у `oracle-changes`, з перевіркою, що вивід має `tests 4` чи більше, інакше вихід 1): шляхи — зміна будь-де поза `docs/**`, `legacy/**`, `.agents/**`, `*.md` — `run=true`; лише `docs/**` — `false`; перейменування з `src/data` в іншу теку — `true`; помилка git — `true`; порожній перелік змін — `true`; `push` — `true`; `playwright-gate` — звіт з пропущеним тестом чи меншою кількістю — червоно. Агрегатор — таблиця `oracle-changes.result` × `run` × `oracle-leg.result` (`success`, `failure`, `skipped`, `cancelled`): зелений рівно у двох рядках Р8. Тег образу дорівнює піну `@playwright/test`.
- [ ] **Step 2: Workflow:** ноги — за `needs.oracle-changes.outputs.run == 'true'` (рядок); у PR перевірити обидва шляхи: зміна T4 — ноги біжать, зміна лише `docs/` — пропущені, агрегатор зелений в обох; час кожної ноги — у §12 (Task 13).
- [ ] **Step 3: Commit.** `ci: job oracle з фільтром шляхів і агрегатором`

### Task 13: Спеки і справи власника

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (§12 «CI оракула» — логіка агрегатора й фактичний час ноги, а замість «обов'язкова перевірка гілки `main`» — «мердж змін T4–T6 і шаблону host-а — лише із зеленим `oracle` (дисципліна архітекторки; захисту гілки немає, рішення власника 2026-11-08)»; так само Рд45 П4-B; платформна Р42 — «браузерний оракул … — перевірка CI» без «обов'язкова», через архітекторку; Додаток А — рядок «налаштування репозиторію | захист гілки `main`» прибрати, рядок `AGENTS.md` про CI переписати без «обов'язкова»; §12 «Належність кейсів блокам» — кейси `rightsVersion` у B5; §14.3 — розташування хоста закрито; §6.6 — модулі `store/ssr.ts`, `runtime/ssr.ts`, `hydrateFrom`; Додаток А — рядки B3-6 «внесено (B3-6)»), `docs/ROADMAP.md`; рядок платформної спеки §11 (Рд45) — через архітекторку

- [ ] **Step 1: Правки**; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Гейти.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm deps:check`, `pnpm build:packages && pnpm test:packaging`, `pnpm test:db`.
- [ ] **Step 3: Рядок `AGENTS.md`** (рішення власника 2026-11-08): захисту гілки й обов'язкової перевірки немає; у § «Commands and gates», у речення про CI, додати job `oracle` як частину CI (браузерний оракул Chromium і WebKit на production- і dev-збірці тестового хоста з фільтром шляхів і агрегатором `oracle`), без слів «required» чи «обов'язкова»; текст рядка архітекторка показує власнику під час виконання. Мердж змін T4, T5, T6 чи шаблону host-а без зеленого `oracle` блокує дисципліна архітекторки, а не налаштування репозиторію.
- [ ] **Step 4: Commit.** `docs(spec): SSR, оракул і CI під B3-6`

**Готово B3-6e:** job `oracle` зелений у PR на чотирьох ногах, логіка агрегатора доведена, час записано; спеки оновлено; справи власника передано.

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| знімок несе слабко утримані рядки чи журнал | `store/__tests__/ssr.test.ts` |
| гідратований рядок без `versionEpoch` (не йде в `known`) | `store/__tests__/ssr.test.ts` |
| рантайм на рівні модуля сервера | `e2e/ssr.spec.ts` (сентинели) |
| знімок без `Vary: Cookie` | `e2e/ssr.spec.ts` |
| гідратувати після першого рендера | `e2e/ssr.spec.ts`, самотест `latehydrate` |
| звірка двома запитами | `runtime/__tests__/ssr.test.ts`, `e2e/budgets.spec.ts` |
| дозвіл сегмента на всі рядки | `oracle/__tests__/rules.test.ts` |
| треки без засіву на вході в сегмент | `oracle/__tests__/rules.test.ts` |
| `expectClean` на порожньому журналі | `oracle/__tests__/rules.test.ts` |
| правило без мутації, де воно єдине | огляд таблиці Task 9 (Review Focus 2) |
| `countingTransport` повз мережу | `e2e/budgets.spec.ts` (звірка з журналом) |
| фейк розходиться з T3 | `fake-runtime-equivalence.db.test.ts` |
| агрегатор зелений за впалого `oracle-changes` | `oracle-gate.test.mjs` |
| фільтр пропускає перейменування з `src/data` | `oracle-paths.test.mjs` |
| тег образу не дорівнює піну | `image-pin.test.mjs` |
| нога ганяє не той браузер чи збірку | смоук Task 6 |
| сценарій без кінцевої умови ефекту | самотест `run-noop` |
| зсув зони цілком без дозволу | самотест `banner-push` |
| повзучий дрейф під `scroll` | самотест `drift` |
| поріг `shift` 5 px | `oracle/__tests__/rules.test.ts` (граничні) |
| `node --test` без тестів зеленіє | перевірка кількості в `oracle-changes` |
| застарілі згенеровані артефакти | `generated-fresh.test.ts` |
| серверний рантайм не закрито після запиту | `e2e/ssr.spec.ts` (немає таймерів після відповіді) |
| керування сценарію без токена | `e2e/ssr.spec.ts` (виклик без токена — 404) |
| `catalogHash` з клієнтського каталогу | `runtime/__tests__/ssr.test.ts` (різні хеші) |
| дедуплікація без тексту `#app` | самотест `toast-leak` |
| пропущений тест Playwright зеленіє | `playwright-gate.test.mjs` |
| порожній перелік змін дає `run=false` | `oracle-paths.test.mjs` |
