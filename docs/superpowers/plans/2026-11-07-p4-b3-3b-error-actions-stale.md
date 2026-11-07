# П4-B3-3b — дії за кодом помилки, позначка «застарілий» і `version`: план реалізації

> **Статус:** на прийманні архітекторкою П4-B (2026-11-07). Підсумок аудиту —
> у плані [B3-3a](2026-11-07-p4-b3-3a-write-facade.md) (обидва плани
> аудитовано разом). Виконання — після B3-3a (а отже після B3-2b, B1b-2 і
> B1b-3). Якорі «після B3-3a», «після B1b-2» виконавець **звіряє в `main`
> перед стартом** (`orient --plan`); розбіжність поведінки — до
> архітекторки. Перед стартом — злиття `main` у гілку (без rebase).
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** фасад T4 відповідає на кожен код помилки запису й читання дією
§7.3, тримає позначку «застарілий» на об'єкт за відповідями `version`,
відмовляє запису позначеного об'єкта без транспорту й дає host-у
`onStaleClient`, `isStale`, `resume()` і `navigated()`.

**Architecture:** дії за кодом рядків (перечитування за ключем, перезапит
ТЧ, звірка реєстру) — у обробнику запису B3-3a, на гілці відмови `run`.
Дії сумісності (запит `version`, позначка, `onStaleClient`) — у трекері
версії рантайму, який бачить **кожну** відповідь обгортки транспорту B3-1
(читання й `run`): там і `serverHash`, і `stale-client`, і `schema`.
Позначка — стан рантайму; хуки читають її підпискою.

**Tech Stack:** як у B3-3a.

**Spec:** [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) — §6.1
(«Події host-а», «Рантайм даних»), §6.2 правило 1 (звірка реєстру на
конфлікті й відмові), §6.4 (`isStale`), §7.1 (запис позначеного об'єкта),
§7.3, §10 («Відповідь», «Позначка», `onStaleClient`, «Перевірка версії»),
§12 (кейси B3-3b за «Належністю кейсів»), §13 (рядок B3-3b).

## Global Constraints

- Усі обмеження B3-3a (мова, коміти, межа бібліотеки, `runtime.disposed`
  після кожного `await`, прямий запис лише обгортками).
- Автоматичного повтору немає ні на якому коді (`stale-client`,
  `unavailable`, `busy`, `timeout`); повтор — рішення host-а.
- Позначка ставиться лише за невідомим об'єктом чи іншим `kernelHash` у
  відповіді `version` і знімається, коли хеш збігся; несумісна колонка
  (`stale-client` без такої розбіжності) позначки не ставить.
- T4 не читає `document` і роутера: `resume()` і `navigated()` кличе host.
- Поза блоком: `SUBSCRIBED` у таблиці «подія → `version`», звірка реєстру
  на `SUBSCRIBED` і перечитування знімка прав на `unavailable` для `create`
  кореня виду скоупу — B5; адаптер PostgREST (`schema` з його відповіді) —
  B4 (трекер дає точку `requestVersion`).

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| В1 | Трекер версії живе в обгортці транспорту B3-1: кожна відповідь (зокрема відмова) проходить `observe(response, request)`; зміна `serverHash` відносно останнього баченого (перший — відносно `snapshotHash` клієнтського каталогу) — запит `version` | §10 (примітка) |
| В2 | Запит `version` — single-flight з одним хвостом; відповідь `version` переоцінює позначку **кожного** об'єкта каталогу клієнта: UUID відсутній у `objects` чи хеш ≠ — позначено, інакше — знято; відмова запиту `version` позначки не змінює | немає |
| В3 | `onStaleClient(object: MetadataRef)` — на кожну відповідь `command.stale-client` (з `object` у помилці; без нього — для кожного об'єкта запиту), один виклик на відповідь; і на переході позначки об'єкта з `false` у `true` | §10 (`onStaleClient`) |
| В4 | `navigated()` — не частіше `NAVIGATED_VERSION_MS` = 60 000 мс (час — `now` з опцій рантайму для тестів); `resume()` — без обмеження частоти | немає |
| В5 | `create` кореня виду скоупу на `command.unavailable` — лише перечитування ключів операції (у такого `create` їх немає — нічого); перечитування знімка прав і переліку скоупів додає B5 (рішення архітекторки, без заглушки) | §13 рядок B5 (у коміті планів) |

## Review Focus

1. **Розкатка: відповіді `version` двох каталогів чергуються** — позначка
   ставиться й знімається, запис з повтором вдається, без циклу запитів;
   задача 2.
2. **`stale-client` колонки** (новий реквізит у старої вкладки) — без
   позначки, без повтору, `onStaleClient` один раз; задача 2.
3. **`command.unavailable` на `run` з невідомим результатом** — перечитано
   ключі операції, оптимістичний стан відкочено, але рядок, який сервер таки
   записав, з'явився з перечитування; задача 1.
4. **Конфлікт власного створення в реєстрі** — реєстр звірено, рядок, якого
   немає, прибрано; задача 1.
5. **Запит `version` після `dispose()`** — не надсилається, позначка не
   змінюється, `onStaleClient` не кличеться; задача 3.

---

### Task 1: таблиця «код → дія» для запису й читання

**Files:** Create `packages/simetra/src/data/facade/error-actions.ts`;
Modify `packages/simetra/src/data/facade/transactions.ts`,
`write-back.ts` (після B3-3a); Test `error-actions.test.ts`.

**Interfaces:**
- Consumes (після B3-3a): `runWrite`, `rereadKeys`, `reconcileOwnCreates`,
  `fetchedOnce`, `ownCreatesOf`; (після B1b-3) коди `command.busy`,
  `command.timeout`.
- `onWriteFailure(runtime, ops: PreparedOp[], failure: CommandFailure): Promise<void>`
  — викликається обробником перед відхиленням транзакції (відхилення —
  той самий `CommandFailure`; `path` — логічний, B3-3a); дія:

| Код | Дія |
| --- | --- |
| `command.conflict` | `rereadKeys` ключа `failure.object`/`id` операції (чи всіх ключів операцій, якщо `object` немає) і `fetchedOnce` активної підмножини «ТЧ власника» кожного з них, з межею `writeBackRefetchMs`; чернетку й дельту не накладає повторно |
| `command.forbidden` | `rereadKeys` ключів операцій (невидимий рядок прибирає `rereadKeys`); з `reason: "origin"` — нічого |
| `command.unavailable` (без `reason: "schema"`) | `rereadKeys` ключів операцій; `create` без `id` — нічого (В5) |
| `command.busy`, `command.timeout` | нічого |
| решта (зокрема `command.invalid`) | нічого |

  Після дії — `reconcileOwnCreates` для ключів реєстру серед ключів
  операцій (правило 1 §6.2: «конфлікт чи відмова запису»). Дії `stale-client`,
  `unavailable` `schema` і `session-changed` дає трекер (задача 2) і B3-1,
  тут — нічого. Виняток дії — у `log`, відхилення лишається вихідним
  `CommandFailure`.
- Читання (`queryFn`, `readPage`, `readCount`): дій рядків немає; таблиця для
  читання тримається тим, що ці гілки нічого не роблять поза трекером.

- [ ] **Step 1: Failing tests (таблиця по кодах `COMMAND_ERROR_CODES` × запис
  і читання):** для кожного коду — очікувані запити транспорту після відмови
  (журнал фейку) і стан колекції; `conflict` — рядок і версія з сервера
  (`currentVersion`), підмножина ТЧ перезапитана, повторного `run` немає;
  `forbidden` — невидимий рядок прибрано, `origin` — нуль запитів;
  `unavailable` на `run` — перечитано ключі (Review Focus 3), повтору `run`
  немає; `busy`/`timeout` — відкат, нуль запитів; читання з будь-яким кодом —
  нуль запитів рядків; Review Focus 4; мутації: повторити `run` після
  `unavailable` автоматично; перечитування на `forbidden` `origin`.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test error-actions`).
- [ ] **Step 5: Commit** — `feat(data): дії фасаду за кодом помилки команди`.

### Task 2: трекер версії, позначка «застарілий» і `onStaleClient`

**Files:** Create `packages/simetra/src/data/facade/version.ts`; Modify
`packages/simetra/src/data/facade/runtime.ts` (після B3-1: обгортка
транспорту кличе `observe`; опція `onStaleClient`), `writer.ts` (після
B3-3a); Test `version.test.ts`.

**Interfaces:**
- Опція `createDataRuntime({ …, onStaleClient?: (object: MetadataRef) => void })`.
- `versionOf(runtime): { observe(request, response): void; requestVersion(): Promise<void>; isStale(object: UUID): boolean; subscribe(listener: () => void): () => void }`
  — В1–В3; `requestVersion` — через обгортку транспорту (`{ type: "version" }`),
  відповідь — `versionValueSchema` (після B1b-2); `observe` не бачить
  відповідей, що прийшли після `dispose()` (їх відкидає обгортка).
- Тригери запиту: зміна `serverHash` (В1); `command.stale-client` у будь-якій
  відповіді; `command.unavailable` `reason: "schema"`; `resume()`;
  `navigated()` (задача 3). `SUBSCRIBED` — B5 через `requestVersion`.
- Запис: `prepareOps` (B3-3a) відмовляє `CommandFailure`
  `command.stale-client` з `object` без транзакції й транспорту, якщо хоч
  один об'єкт операцій позначено.

- [ ] **Step 1: Failing tests:**
  - таблиця «подія → запит `version`»: зміна `serverHash` у відповіді
    читання й `run` — один запит; той самий `serverHash` — нуль; перша
    відповідь з хешем ≠ `snapshotHash` каталогу — запит; `stale-client` —
    запит; `unavailable` `schema` — запит; три тригери під час активного —
    один хвостовий;
  - позначка: відповідь `version` з іншим `kernelHash` об'єкта — `isStale`
    true; без UUID — true; збіг — знято; Review Focus 1 — фейк чергує дві
    відповіді `version` (A, A′, A, …): позначка йде слідом, кількість запитів
    дорівнює кількості тригерів, запис після зняття проходить;
  - Review Focus 2: `stale-client` колонки — `onStaleClient` один раз,
    позначки немає, повтору немає;
  - запис позначеного об'єкта — `command.stale-client`, журнал транспорту
    порожній, оптимістичного стану немає; `batch` з одним позначеним —
    відмова цілком;
  - мутації: позначка за `stale-client` колонки; не знімати позначку на
    збігу; автоповтор після `stale-client`.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test version`).
- [ ] **Step 5: Commit** — `feat(data): позначка «застарілий» за відповіддю version`.

### Task 3: `resume()`, `navigated()` і `isStale` у хуках

**Files:** Modify `packages/simetra/src/data/facade/runtime.ts`,
`packages/simetra/src/data/hooks.ts`, `packages/simetra/src/data/index.ts`;
Test `version-events.test.ts`, `packages/simetra/src/data/__tests__/hooks-stale.test.ts`.

**Interfaces:**
- `DataRuntime` отримує `resume(): void` і `navigated(): void` — обидва
  кличуть `requestVersion` (`navigated` — з обмеженням В4); після
  `dispose()` — нічого. Опція `now?: () => number` (типово `Date.now`) —
  для тесту частоти.
- `RowsResult` і `RowResult` (B3-2b) отримують `isStale: boolean` —
  позначка об'єкта входу, оновлюється підпискою `versionOf(...).subscribe`
  через `useSyncExternalStore`.

- [ ] **Step 1: Failing tests:** `resume()` двічі — два запити (single-flight
  з хвостом — не більше двох); `navigated()` тричі за 60 с — один запит,
  після 60 с — ще один; Review Focus 5 — `resume()` і `navigated()` після
  `dispose()` — нуль запитів, `onStaleClient` не кликано; jsdom: `useRows` і
  `useRow` дають `isStale` false, після відповіді `version` з іншим хешем —
  true без перемонтування, після збігу — false.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test version-events hooks-stale`).
- [ ] **Step 5: Commit** — `feat(data): resume, navigated і isStale`.

### Task 4: мутації, документація й гейти

- [ ] **Step 1: Mutation check (без коміту; кожна червоніє):** трекер лише
  на відповідях `run` (задача 2 — зміна `serverHash` у читанні); `navigated()`
  без обмеження частоти (задача 3); запит `version` після `dispose()`
  (задача 3); перевірка позначки після транспорту (задача 2). Повернути код.
- [ ] **Step 2:** спека П4-B — §14.3 рядок «`command.forbidden` `origin`» —
  «закрито (B3-3b)»; `docs/ROADMAP.md` (рядок П4: B3-3b, блок B3 закрито);
  скіл споживача — якщо є розділ даних застосунку, додати `isStale`,
  `onStaleClient`, `resume()`, `navigated()`; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 3: Гейти:**

```bash
pnpm deps:check
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm metadata:check
pnpm test:db
pnpm build:packages && pnpm test:packaging
```

- [ ] **Step 4: Commit** — `docs(spec): П4-B3-3b — §14 і ROADMAP`.

## Готово (§13, рядок B3-3b)

- табличні тести «код помилки → дія фасаду» (запис і читання) і «подія →
  запит `version`» (без `SUBSCRIBED` — B5) зелені; позначка ставиться й
  знімається без циклу; запис позначеного об'єкта відмовляє без транспорту;
- мутації задач 1–4 червоніють; гейти зелені.
