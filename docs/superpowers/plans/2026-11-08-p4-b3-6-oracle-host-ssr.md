# П4-B3-6. Оракул, тестовий хост і SSR — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** SSR-гідратація даних T4 за §6.6 — сторінка з даними гідрується без
запиту даних і без зміни DOM, знімок одного суб'єкта не потрапляє іншому;
браузерний оракул заборонених кадрів у Chromium і WebKit на production- і
dev-збірці тестового хоста ловить мерехтіння, і його самотест доводить, що
він не зеленіє хибно; мережеві бюджети браузерних сценаріїв — тести; job
`oracle` у CI.

**Архітектура:** SSR — модуль ядра B3-2 `store/ssr.ts` (`dehydrate`,
`hydrate`, `endHydration`, перенесені зі спайку 1 як еталон) і звірка після
гідратації в рантаймі. Тестовий хост — приватний пакет воркспейсу
`packages/test-host` на TanStack Start зі штатними опціями §6.6; дані —
справжній `DataTransport` над фейковим сервером у пам'яті, що говорить формою
передачі T0. Оракул — записувач і правила спайку вікна (надмножина спайку
UX), перенесені в `packages/test-host/oracle/` з unit-тестами правил на
синтетичних журналах, покадровими знімками ключових переходів і мутаційним
самотестом, де кожна мутація має чисту пару.

**Стек:** TypeScript, React 19, TanStack Start і Router (точні піни),
`@tanstack/react-virtual` (пін B3-3), Playwright (точний пін, той самий, що
образ контейнера CI), Vite, Vitest.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) Рд36, Рд38,
Рд39, Рд45, §6.6, §12 рядки «браузерний оракул», «SSR», «Мережеві бюджети» і
«CI оракула», §13 рядок B3-6, §14.3 (розташування оракула й хоста); звіти
спайків [UI й SSR](../specs/2026-11-08-t4-ux-spike-report.md) і
[вікна](../specs/2026-11-08-t4-window-spike-report.md); [план
B3-3](2026-11-08-p4-b3-3-window-public-api.md) (`createRuntimeHolder`,
`simetra/data/react`, `VirtualList`, `countingTransport`).

**Поділ і залежності.** Після мерджу B3-3, B3-4 і B3-5 (сценарії оракула
пишуть, а `unknown` розв'язує квитанція). Чотири частини з власним «готово»:
**B3-6a** (Task 1–3) — SSR у ядрі й рантаймі; **B3-6b** (Task 4–6) —
тестовий хост, фейковий сервер, оракул і unit-тести правил; **B3-6c** (Task
7–9) — сценарії, самотест, бюджети; **B3-6d** (Task 10–11) — job `oracle` у CI
і спеки. **Справи власника** (Task 12) — окремо, на затвердження: захист гілки
й рядки `AGENTS.md`. Код спайків `spike/t4-ux` і `spike/t4-window` — лише
еталон: ядро спайку 1 не збігається з модулями B3-2, а полігон спайку має
власний воркспейс і відносні імпорти вихідників.

## Global Constraints

- Рантайм даних на сервері — на запит у фабриці роутера, ніколи на рівні модуля; анонімний запит рантайму не створює й даних у HTML не кладе.
- Знімок у HTML: `dehydrate()` — склади готових підмножин і `atEnd` вікон, рядки лише цих підмножин (з `stale` і версіями проєкції лінивих полів), ТЧ з `ownerVersion`, слоти `removed` без значень; без журналу мутацій, слухачів і рядків без власника; тотожність `{ subject, catalogHash, rightsVersion, issuedAt, ttlMs }` (`ttlMs` типово 60 000).
- Відповідь із персональним знімком — `Cache-Control: private, no-store` і `Vary: Cookie`.
- Гідратація — до першого рендера (`router.options.hydrate`); знімок гідрується завжди; `endHydration()` — один раз (StrictMode повторює ефект).
- Звірка після гідратації — один запит `read` з частиною `version` (з B5 — і `rights`); інший `subject` чи `rightsVersion` — виняток безпеки (`purge` і причина); інший `catalogHash` — `onStaleClient()` і `stale` без перечитування як свіжих даних; прострочений знімок і знімок без `rightsVersion` — `revalidate` видимих виглядів без зміни складу.
- TanStack Start — лише штатні опції: `createRouter({ dehydrate, hydrate })`, `defaultStaleReloadMode: "blocking"`, великий `defaultPendingMs`, `defaultPendingMinMs: 0`, маршрути з даними `ssr: true`.
- Оракул: правила — чиста функція над журналом; сегмент — проміжок між позначками дії; дозволи сегмента вузькі (на рядки й операції); переход `removed` → значення дозволено лише в сценарії розбіжних паралельних читань і лише для названого рядка.
- Мутаційний самотест: кожна мутація червоніє своїм типом заборони в обох браузерах, а її чиста пара (той самий сценарій без мутації) зелена; набір мутацій — з §12 і спайків.
- Playwright — точна версія; образ контейнера CI — та сама версія; група syncpack.
- Тестовий хост — приватний пакет (`"private": true`), у `build:packages` і публікацію не йде.
- Файли ПГ-1 змінено вже після його мерджу: кореневий `package.json`, `ci.yml` — правка поверх ПГ-1.
- Коментарі — українською й про «чому».

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | Тестовий хост — приватний пакет воркспейсу `packages/test-host` (TanStack Start, Vite, Playwright у його `devDependencies`), а не проєкт з власним воркспейсом | гейти репозиторію (`lint`, `typecheck`, `deps:check`) бачать його; імпорт `simetra` — як у споживача, з `exports`, без відносних шляхів до вихідників | §14.3 П4-B закрито (Task 11); межа фреймворку `AGENTS.md` — Task 12 (власник) |
| Р2 | Дані хоста — справжній `DataTransport` над фейковим сервером у пам'яті `createFakeDataServer(catalog)`, що приймає й віддає форму передачі T0 (схеми й мапінг T0, частини `read`, `run`, `receipt`), з керуванням сценарію (`latency`, `failNext`, `hold`/`release`, `edit`, `remove`, `insert`, `rights`, `lostReplyNext`); справжнього `createDataHandler` і бази немає | оракул доводить кадри, а не SQL; DB-поведінку тримають DB-тести; бюджети міряє той самий `countingTransport`, що й unit (Р5 B3-3) | немає |
| Р3 | SSR ядра — модуль `store/ssr.ts` у ядрі B3-2 (перенесення `dehydrate`/`hydrate`/`endHydration` зі спайку 1 під модулі B3-2 і модель слабкого власника B3-3: слабко утримані рядки в знімок не йдуть) і `DataRuntime.dehydrate()`, `hydrate(snapshot)`, `endHydration()`; тотожність знімка й звірка — у рантаймі (`runtime/ssr.ts`) над тримачем B3-3 | знімок — серіалізація сховища, тож живе поряд із ним; звірка — політика рантайму | немає |
| Р4 | Частина `version` у пакеті `read` — у збирачі B3-3 (Р4 B3-3 відклав її до B3-6): звірка після гідратації — один запит | §6.6: один запит після гідратації | немає |
| Р5 | Оракул — `packages/test-host/oracle/`: `recorder.js` і `rules.ts` з `spike/t4-window` як основа; нові unit-тести правил на синтетичних журналах (кожна заборона й кожен дозвіл); покадрові знімки ключових переходів (`page.screenshot` на позначках дії, у звіті прогону); мутації — прапорець хоста, а не окрема збірка | звіт спайку UX §8: unit-тестів правил і покадрових знімків у спайку немає | немає |
| Р6 | Мережеві бюджети браузерних сценаріїв міряє `countingTransport` у клієнті хоста (вивід у `window` для тесту) і мережевий журнал Playwright для розміру HTML | §12 «Мережеві бюджети»: запити й байти транспорту; HTML — поза транспортом | немає |
| Р7 | CI: `oracle-changes` (без контейнера, `fetch-depth: 0`, скрипт `.github/scripts/oracle-paths.mjs` порівнює зміни з базою злиття; на `push` у `main` — завжди), `oracle-leg` (матриця `chromium`/`webkit` × `production`/`dev`, контейнер `mcr.microsoft.com/playwright:v<пін>`, `timeout-minutes: 20`, самотест — у ногах `production`), агрегатор `oracle` (`needs` обох, `if: always()`, успіх за пропущених ніг чи всіх зелених) | §12 «CI оракула» | немає |

Кожне рішення — розвилка до погодження архітекторкою.

## Review Focus

1. **Оракул зеленіє на поломці, якої він не бачить** (заборона без
   мутації, мутація без чистої пари, сценарій, що мовчки падає до позначки):
   Task 6 і Task 8.
2. **Знімок одного суб'єкта в HTML іншого** (паралельні SSR-запити): Task 7.
3. **Права змінились між SSR і гідратацією**: `purge` і причина першим кроком
   — Task 3 і Task 7.
4. **Слабко утримані рядки й журнал мутацій у знімку**: їх там немає —
   Task 1.
5. **Нога CI, пропущена фільтром шляхів при зміні T4**: агрегатор червоний —
   Task 10.

---

## B3-6a. SSR у ядрі й рантаймі

### Task 1: `dehydrate`, `hydrate`, `endHydration` у ядрі

**Files:**
- Create: `packages/simetra/src/data/store/ssr.ts`, `packages/simetra/src/data/store/__tests__/ssr.test.ts`
- Modify: `packages/simetra/src/data/store/core.ts` (методи сесії), `types.ts` (`CoreSnapshot`, `format: 1`), `subsets.ts` (утримання знімком до першої підписки)

**Interfaces:**
- Produces: `CoreSession.dehydrate(): CoreSnapshot`, `hydrate(snapshot: CoreSnapshot): void`, `endHydration(): void`; `CoreSnapshot = { format: 1; subject: string; objects; sections; subsets }` (форма — за спайком 1 з поправками B3-2/B3-3); знімок утримує свої підмножини до першої підписки, `endHydration()` відпускає невзяті через `releaseDelayMs`.

- [ ] **Step 1: Unit `ssr.test.ts`:** знімок — лише рядки підмножин знімка (слабко утримані й рядки без власника — ні), слоти `removed` без значень, `stale` і версії проєкції лінивих полів, ТЧ з `ownerVersion`, без журналу мутацій; `hydrate` того самого знімка дає ті самі знімки виглядів (посилка за посилкою); підписка після `hydrate` — без запиту; `endHydration` удруге — нічого; невзята підмножина звільняється через `releaseDelayMs`; `hydrate` після `dispose()` — нічого.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test ssr core`.
- [ ] **Step 3: Модельний тест** — крок «дегідрація й гідрація в новому рантаймі» з інваріантом «знімки виглядів рівні до й після».
- [ ] **Step 4: Commit.** `feat(data): SSR-знімок ядра — dehydrate, hydrate, endHydration`

### Task 2: Тотожність знімка й API рантайму

**Files:**
- Create: `packages/simetra/src/data/runtime/ssr.ts`
- Modify: `packages/simetra/src/data/runtime/runtime.ts`, `holder.ts` (B3-3; мета знімка в тримачі), `packages/simetra/src/data/index.ts`
- Test: `packages/simetra/src/data/runtime/__tests__/ssr.test.ts`

**Interfaces:**
- Produces: `DataRuntime.dehydrate(): DataSnapshot`, `DataSnapshot = { meta: SnapshotMeta; core: CoreSnapshot }`, `SnapshotMeta = { subject; catalogHash; rightsVersion?: string; issuedAt: number; ttlMs: number }`; `DataRuntime.hydrate(snapshot)`, `endHydration()`; `RuntimeHolder.hydrateFrom(snapshot)` створює рантайм суб'єкта знімка й гідрує його.

- [ ] **Step 1: Unit:** мета — `snapshotHash` клієнтського каталогу, `rightsVersion` з кешу прав (до B5 — відсутня), `issuedAt` з годинника рантайму; знімок серіалізується `JSON.stringify` без втрат (`bigint` — текстом за кодеком T0).
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test ssr runtime holder`.
- [ ] **Step 3: Commit.** `feat(data): тотожність SSR-знімка й API рантайму`

### Task 3: Звірка після гідратації

**Files:**
- Modify: `packages/simetra/src/data/runtime/ssr.ts` (`verifyAfterHydration`), `packages/simetra/src/data/store/batcher.ts` (частина `version`, Р4)
- Test: `packages/simetra/src/data/runtime/__tests__/ssr.test.ts`

**Interfaces:**
- Produces: `endHydration()` кличе звірку один раз: один запит `read` з частиною `version`; результати — `ok`, `subject-changed` і `rights-changed` (виняток безпеки: `purge` усіх ключів знімка й причина, заміна рантайму тримачем), `catalog-changed` (`onStaleClient()` без об'єкта, `stale` рядків знімка), `expired` чи без `rightsVersion` (`revalidate` видимих виглядів, склад незмінний).

- [ ] **Step 1: Unit (`it.each` за результатом):** кожна гілка дає свою дію; для свіжого знімка з `rightsVersion` — рівно один запит і жодного читання даних; знімок без `rightsVersion` — `revalidate` одразу; StrictMode (подвійний ефект) — одна звірка; інший `subject` — змонтовані хуки не показують рядків старого суб'єкта.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test ssr batcher hooks`.
- [ ] **Step 3: Commit.** `feat(data): звірка після гідратації одним запитом`

**Готово B3-6a:** unit-тести SSR ядра й рантайму, модельний крок гідратації зелені.

## B3-6b. Тестовий хост, фейковий сервер, оракул

### Task 4: Пакет тестового хоста й фейковий сервер

**Files:**
- Create: `packages/test-host/` — `package.json` (`"private": true`; залежності — `simetra` з воркспейсу, `react`, `react-dom`, `@tanstack/react-start`, `@tanstack/react-router`, `@tanstack/react-virtual`; dev — `@playwright/test`, `vite`, `@vitejs/plugin-react`; точні піни, група syncpack), `vite.config.ts`, `tsconfig.json`, `src/router.tsx`, `src/server.ts` (заголовки кешу), `src/client.tsx` (`hydrateRoot` під StrictMode, `onRecoverableError` → `window.__oracleRecoverable`), `src/routes/{__root,index,login,full,items.$id,window}.tsx`, `src/server/fake-data.ts`, `src/server/fns.ts` (одна Server Function даних над `createFakeDataServer`, сесія з cookie), `src/server/control.ts` (керування сценарію), `src/breaks.ts` (мутації самотесту), `scripts/serve-prod.mjs`, `playwright.config.ts`
- Modify: `pnpm-workspace.yaml` (без змін — `packages/*`), `.syncpackrc.json`, `packages/simetra/eslint.tier-zones.js` не змінюється (хост — поза ярусами)

**Interfaces:**
- Produces: `createFakeDataServer(catalog: ClientCatalog, seed: FakeSeed): { transport(subject): DataTransport; control: FakeControl }` — валідує конверт схемами T0, виконує частини `read` (фільтр, сортування, keyset, `known` і маркери за правилами T3, межі й бюджет відповіді), `run` (версія з лічильника, квитанції за `mutationId`), `receipt`; правила видимості — простий предикат скоупу на суб'єкта; рядки форми передачі.

- [ ] **Step 1: Unit `packages/test-host/src/server/__tests__/fake-data.test.ts`:** конверт поза схемою — `command.invalid`; частини одного запиту — один знімок даних; `known` рівної версії — маркер, іншої — рядок; невидимий суб'єкту рядок — відсутній; квитанція — повтор `mutationId` дає збережений результат.
- [ ] **Step 2: Хост:** маршрути списку (`full` і `window` на `VirtualList`), картки й входу; опції роутера за Global Constraints; `pnpm --filter test-host build` і `typecheck` зелені.
- [ ] **Step 3: Commit.** `feat(test-host): тестовий хост на TanStack Start і фейковий сервер даних`

### Task 5: Записувач і правила оракула з unit-тестами

**Files:**
- Create: `packages/test-host/oracle/recorder.js`, `rules.ts`, `harness.ts` (`Oracle`: `mark`, `log`, `expectClean`, `regionUpdatesAfterHydration`, `screenshotAt`), `packages/test-host/oracle/__tests__/rules.test.ts`

**Interfaces:**
- Produces: контракт хоста для оракула — атрибути `[data-region]`, `[data-row-key]`, `[data-field]`, `[data-state]`, `[data-scroll]`, `[data-skeleton]`, `[data-loading]`, `[data-stream-slot]`, корінь `#app`, `window.__oracleHydrated`, `window.__oracleRecoverable`; `analyze(log): Violation[]` з видами `empty-after-data`, `blank`, `presence-aba`, `value-aba`, `reorder`, `shift`, `height`, `scroll-jump`, `scroll-rigid`, `layout-shift`, `forbidden-text`, `hydration-mutation`, `hydration-error`; дозволи `clear`, `reorder`, `shift`, `shift-once`, `scroll`, `aba`, `removed-restore` (лише для названого рядка).

- [ ] **Step 1: Unit `rules.test.ts` (синтетичні журнали, `it.each` за видом):** кожна заборона спрацьовує на мінімальному журналі; той самий журнал з дозволом сегмента — чисто; дозвіл сегмента n не діє в сегменті n + 1; `removed-restore` діє лише для названого ключа; рядок, схований стилем, — як відсутній; сегмент 0 без дозволів.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter test-host test rules`.
- [ ] **Step 3: Commit.** `feat(test-host): записувач і правила оракула з unit-тестами`

### Task 6: Мутаційний самотест оракула

**Files:**
- Create: `packages/test-host/e2e/oracle-self.spec.ts`
- Modify: `packages/test-host/src/breaks.ts`

- [ ] **Step 1: Таблиця мутацій** (кожна — свій тест «ловить» і пара «чисто без мутації» в тому самому сценарії): `skeleton` → `empty-after-data`; `flash` → `empty-after-data` чи `presence-aba`; `revert` → `value-aba`; `reorder` → `reorder` чи `shift`; `heightjump` → `height`; `scrolljump` → `scroll-jump`; `lazyshift` → `height` чи `layout-shift`; `keepcore` → `forbidden-text`; `hydration` → `hydration-mutation` чи `hydration-error`; `asyncrender` → `blank`; `noanchor` → `scroll-rigid`; `highlight` → `value-aba`; `restore-other` (повернення значення не названого рядка) → `presence-aba`. Сценарій, що впав до останньої позначки, — червоний тест, а не «нічого не знайдено».
- [ ] **Step 2: Прогін у Chromium і WebKit, production і dev.** `pnpm --filter test-host exec playwright test oracle-self`.
- [ ] **Step 3: Commit.** `test(test-host): мутаційний самотест оракула з чистими парами`

**Готово B3-6b:** unit-тести фейкового сервера й правил зелені; самотест зелений у чотирьох комбінаціях.

## B3-6c. Сценарії, SSR-кейси, бюджети

### Task 7: SSR-кейси

**Files:**
- Create: `packages/test-host/e2e/ssr.spec.ts`

- [ ] **Step 1:** HTML містить рядки, перший кадр без скелета; після гідратації свіжого знімка з `rightsVersion` — 0 запитів даних, 0 commit-ів зони рядків (після монтування зони), 0 мутацій DOM, один запит `read` з частиною `version`; права змінились між SSR і гідратацією — `purge` і причина; інший `subject` — `purge`; інший `catalogHash` — `onStaleClient()` і `stale` без перечитування; прострочений знімок — `revalidate` без зміни складу; 10 пар паралельних SSR-запитів двох суб'єктів — без перетину; анонім — без даних; заголовки `Cache-Control: private, no-store` і `Vary: Cookie`; `endHydration` один раз під StrictMode; потоковий слот `count` — рядки в першому фрагменті.
- [ ] **Step 2: Прогін у чотирьох комбінаціях.**
- [ ] **Step 3: Commit.** `test(test-host): SSR-кейси гідратації й ізоляції суб'єктів`

### Task 8: Сценарії оракула

**Files:**
- Create: `packages/test-host/e2e/flows.ts`, `scenarios.spec.ts`, `window.spec.ts`

- [ ] **Step 1: Сценарії §12** (кожен — `oracle.expectClean()` і `screenshotAt` на ключових позначках): SSR-вхід; список → картка → список без запиту; правка поля обох політик; відмова й «Скасувати»; створення; фонове перечитування (змінений на місці, зниклий — `removed`, новий — `hasNewRows`, склад змінює лише `showNew()`); змінене поле сортування; прокрутка й підвантаження; зміна суб'єкта (зокрема з відповіддю старого в дорозі); StrictMode; вікно — 50 сторінок вниз і назад, те саме з вивантаженням і межею знімків, `goTo` в кінець і назад, зміна сортування, оновлення посередині, змінна висота й ліниве поле; розбіжні паралельні читання — дозвіл `removed-restore` лише для названого рядка; потоковий SSR; осідання під час навігації; повторне монтування після `releaseDelayMs`. Сигнальні сценарії р1–р9 — B5 (там канал).
- [ ] **Step 2: Прогін у чотирьох комбінаціях.**
- [ ] **Step 3: Commit.** `test(test-host): сценарії браузерного оракула`

### Task 9: Мережеві бюджети браузерних сценаріїв

**Files:**
- Modify: `packages/test-host/src/client.tsx` (транспорт клієнта — `countingTransport` з `simetra/data/testing`, статистика у `window.__oracleTransport`), `packages/test-host/e2e/budgets.spec.ts` (Create)

- [ ] **Step 1:** рядки бюджетів §12 з браузером: SSR-вхід після гідратації — 1 запит, ≤ 2 КіБ + 128 Б × об'єктів каталогу; знімок SSR у HTML — ≤ 1,1 × корисних + 2 КіБ (розмір HTML — мережевий журнал Playwright); відкриття списку без SSR — 1 запит; список → картка зі сховища — 1; картка → список у межах `releaseDelayMs` — 0; `resume()` раніше за `resumeMinIntervalMs` — 1 (`version`); прихована вкладка — 0. Бюджети `resume()` і приєднання без `recovered` з сигналами — B5.
- [ ] **Step 2: Прогін.**
- [ ] **Step 3: Commit.** `test(test-host): мережеві бюджети браузерних сценаріїв`

**Готово B3-6c:** SSR-кейси, сценарії й бюджети зелені в Chromium і WebKit, production і dev.

## B3-6d. CI і спеки

### Task 10: Job `oracle` у CI

**Files:**
- Modify: `.github/workflows/ci.yml` (jobs `oracle-changes`, `oracle-leg`, `oracle` за Р7)
- Create: `.github/scripts/oracle-paths.mjs` (перелік шляхів: T0 `packages/simetra/src/model/runtime/**`, клієнтський каталог T1 `packages/simetra/src/compiler/{client-catalog,runtime-catalog}.ts`, T3 `packages/simetra/src/server/{read,read-filter,runtime,data-handler,response-budget,origin}.ts`, T4 `packages/simetra/src/data/**`, T5 `packages/simetra/src/ui/**`, T6 `packages/simetra/src/shell/**`, `packages/test-host/**`, `pnpm-lock.yaml`, `packages/simetra/package.json`, `.github/workflows/ci.yml`, сам скрипт; шаблон host-а П4-D додається, коли з'явиться), `.github/scripts/__tests__/oracle-paths.test.mjs`

- [ ] **Step 1: Unit скрипта:** зміна в кожному шляху переліку — `run=true`; зміна лише в `docs/**` — `false`; `push` у `main` — `true`.
- [ ] **Step 2: Workflow:** ноги запускаються лише за `run=true`; агрегатор `oracle` — успіх за пропущених ніг чи всіх зелених, відмова за будь-якої червоної чи скасованої ноги; кеш браузерів не потрібен (образ); `timeout-minutes: 20`.
- [ ] **Step 3: Прогін у PR.** Час кожної ноги записати в §12 (Task 11).
- [ ] **Step 4: Commit.** `ci: job oracle — браузерний оракул з фільтром шляхів і агрегатором`

### Task 11: Спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (§12 «CI оракула» — фактичний час ноги; §14.3 — розташування оракула й хоста закрито (Р1); §6.6 — модуль `store/ssr.ts` і `runtime/ssr.ts`; Додаток А — рядки B3-6 «внесено (B3-6)»), `docs/ROADMAP.md`

- [ ] **Step 1: Правки**; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Гейти.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm deps:check`, `pnpm build:packages && pnpm test:packaging`.
- [ ] **Step 3: Commit.** `docs(spec): SSR, оракул і CI під B3-6`

**Готово B3-6d:** job `oracle` зелений у PR на чотирьох ногах, час записано; спеки оновлено.

## Task 12: Справи власника (на затвердження, окремо від блоку)

Виконавець їх не робить: готує текст і передає архітекторці для власника.

- [ ] **Захист гілки `main`:** обов'язкова перевірка — агрегатор `oracle` (а не ноги матриці, які звітують під іменами з параметрами).
- [ ] **`AGENTS.md`, § «Commands and gates»:** у речення про CI додати job `oracle` (браузерний оракул Chromium і WebKit на production- і dev-збірці тестового хоста `packages/test-host`, з фільтром шляхів у першому job-і й агрегатором `oracle`).
- [ ] **`AGENTS.md`, § «Target architecture vs. the prototype»:** у речення «the host template and the studio are the only places that import TanStack Start» додати тестовий хост `packages/test-host` (Р1).

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| знімок несе слабко утримані рядки чи журнал мутацій | `store/__tests__/ssr.test.ts` |
| рантайм на рівні модуля сервера | `e2e/ssr.spec.ts` (паралельні суб'єкти) |
| знімок без `Vary: Cookie` | `e2e/ssr.spec.ts` |
| гідратувати після першого рендера | `e2e/ssr.spec.ts` (`hydration-mutation`) |
| пропустити звірку `rightsVersion` | `runtime/__tests__/ssr.test.ts` |
| звірка двома запитами замість однієї частини | `runtime/__tests__/ssr.test.ts`, `e2e/budgets.spec.ts` |
| `endHydration` двічі під StrictMode | `runtime/__tests__/ssr.test.ts` |
| правило оракула без дозволу сегмента | `oracle/__tests__/rules.test.ts` |
| мутація самотесту без чистої пари | `e2e/oracle-self.spec.ts` (огляд таблиці — Review Focus 1) |
| сценарій падає до позначки й зеленіє | `e2e/oracle-self.spec.ts` |
| фільтр шляхів пропускає `src/data/**` | `oracle-paths.test.mjs` |
| агрегатор зелений за червоної ноги | Task 10 Step 2 (перевірка в PR) |
