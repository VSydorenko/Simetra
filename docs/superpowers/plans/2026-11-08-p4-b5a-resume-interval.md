# П4-B5a. Тригери `resume()` та інтервалу — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** рантайм T4 сам підтримує свіжість видимих виглядів без каналу
сигналів. Повернення вкладки (`resume()`), навігація (`navigated()`) й
інтервал `revalidateIntervalMs` перечитують видимі вигляди пакетом з
`known`, з межею частоти `resumeMinIntervalMs`. Звірка `version` на
`resume()` іде завжди, прихована вкладка не шле нічого.

**Архітектура:** стан свіжості на вигляді ядра (відмітка успішного
читання, спроба, лічильник збоїв, ознака польоту) і час читання на рядку
сховища; `revalidate` з single-flight і хвостом та з вибором виглядів для
планувальника; один предикат цілей для таймера й `revalidate`; планувальник
рантайму з одним таймером на найближчий строк; події host-а `resume()`,
`suspend()`, `navigated()` і початкова видимість; `requestVersion()` з
B3-4. Події однієї мікрозадачі збирає збирач B3-3 в один запит.

**Стек:** TypeScript, Vitest (фейкові таймери), fast-check, Playwright
(`page.clock`).

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §6.1,
§6.3 («Частота»), §6.7 («Системне перечитування вікна й `full`»), §8.4
(«Збіжність без нового приєднання», «Максимальний час збіжності»,
«Зворотний тиск»), §10 («Перевірка версії»), §12 (рядки бюджетів
`resume()`, такту, прихованої вкладки), §13 (рядок B5), Рд37, Рд44;
платформна Р39, Р42; плани
[B3-3](2026-11-08-p4-b3-3-window-public-api.md) (збирач, `countingTransport`,
перечитування вікна й `full` одним пакетом, `include` тим самим запитом),
[B3-4/B3-5](2026-11-08-p4-b3-4-b3-5-write-receipts.md) Task 4 (частина
`version`, `requestVersion()`, таблиця «подія → `version`»),
[B3-6](2026-11-08-p4-b3-6-oracle-host-ssr.md) (тестовий хост, звірка після
гідратації, Task 11),
[B1c](2026-11-08-p4-b1c-conditional-batched-reads.md) (пакет читань,
обмежувач на рівні запиту, `READ_BATCH_MAX`, `known`).

**Залежності:** після B1c, B3-3, B3-4 і B3-6 (пакет між об'єктами формує
збирач на рівні запиту; обмежувач B1c рахує запити, а не частини; Task 5 —
на хості B3-6). Канал, приймач, приєднання без `recovered`, частина `rights`
і звірка прав на `resume()` — **B5b**. Імена ядра — з B3-2 (`CoreSession`,
`createCore`, `Subset`, `RowEntry`) і планів B3-3, B3-4; виконавець звіряє їх
з `main` (`orient --plan`). `requestVersion()` з B3-4 (форму вписано в план
B3-4 Task 4, погоджено архітекторкою): метод `CoreSession.requestVersion():
void` кладе частину `version` у збирач поточної мікрозадачі; частина, вже
покладена в цій мікрозадачі, — другої немає; виклик під час запиту
`version` у дорозі ставить один хвіст після його осідання, скільки б
викликів не було; останній запит `version` будь-якого джерела ставить
спільну відмітку `lastVersionAt`.

## Global Constraints

- Системне перечитування — лише видимих виглядів видимої вкладки; прихована вкладка — 0 запитів планувальника (хвостові завантаження, запис, опитування квитанцій і звірку після гідратації B3-6 планувальник не чіпає).
- `resume()` перечитує вигляд, лише коли його `refreshedAt` старший за `resumeMinIntervalMs` (типово `min(15 000, revalidateIntervalMs)` мс); частину `version` `resume()` шле завжди, крім злиття Р8.
- `refreshedAt` — час **старту** читання, а ставить його лише успішне осідання; до першого успіху — `undefined` (Р2).
- Інтервал `revalidateIntervalMs` (типово 60 000 мс) — один таймер на рантайм на найближчий строк серед цілей; такт забирає цілі без збоїв зі строком до `now + 0,1 × revalidateIntervalMs` і цілі зі збоями, чий строк уже настав.
- Після збою — пауза `min(I, 0,1 × I × 2^(failures − 1))` від старту спроби; успіх скидає її (Р7).
- `navigated()` — запит `version` не частіше разу на 60 000 мс від `lastVersionAt`; у прихованій вкладці — 0 запитів; перечитувань навігація не запускає.
- Одна подія — один синхронний прохід: `revalidate` усіх об'єктів без `await` між ними і `requestVersion()` у тій самій мікрозадачі; `revalidateViews` кладе частини в збирач без `await` до постановки, тож перша фаза йде одним запитом (до `READ_BATCH_MAX` частин; понад — `⌈частин / READ_BATCH_MAX⌉` пакетів за B1c).
- Бюджет «нічого не змінено» — рівно 1 запит на рантайм, включно з вікном і `full` на кількох сторінках та `include` (B3-3: сторінки — частинами одного пакета, `include` тим самим запитом); більше лише понад `READ_BATCH_MAX` частин і, коли щось змінилось, наступний пакет за ключами, що випали (Р9).
- Зворотний тиск §8.4 — обмежувач B1c на рівні запиту; single-flight на вигляд — Р5.
- Один годинник: рантайм передає ту саму функцію `now` ядру й планувальнику.
- Після `dispose()` чи закриття сесії — 0 таймерів планувальника й 0 запитів.
- T4 не читає `document` і роутера: події й початкову видимість дає host.
- Опції `revalidateIntervalMs`, `resumeMinIntervalMs` — скінченні цілі > 0; після підстановки типових `resumeMinIntervalMs ≤ revalidateIntervalMs`, інакше `TypeError` з обома значеннями.
- Коментарі — українською й про «чому».

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | Подія `runtime.suspend()` — `visibilitychange` у `hidden` (погоджено архітекторкою): знімає лише таймер свіжості; опитування квитанцій, запити в дорозі, `session-changed` і `purge` працюють далі; ідемпотентна; `resume()` коректний і без `suspend()`; після `dispose()` — нічого. Початкова видимість — опція `createDataRuntime({ visible })` (типово `true`): host передає `!document.hidden`; серверний рантайм (B3-6) передає `false` і таймера не має | §8.4: інтервал «лише поки вкладка видима», а T4 не читає `document`; вкладка, відкрита у фоні, `visibilitychange` до першого показу не шле | §6.1 — `suspend()`, опція `visible` (Task 0) |
| Р2 | Стан свіжості `Subset`: `refreshedAt?` (старт останнього успішного читання), `attemptAt?` (старт останньої спроби — і `load()`, і перечитування), `failures`, `rereads` (лічильник проходів `revalidate` у дорозі), `revalidateTrailing`; `inFlight` не зберігається, а виводиться: `s.flight !== undefined || s.rereads > 0`; рядок сховища тримає `readAt` — найбільший час старту читання, що його записало. Вигляд, що став `loaded` без читання (картка зі сховища), бере `refreshedAt` = мінімум `readAt` частин, які показує: шапки, ТЧ (повна підмножина `section`) і показаних лінивих полів — свіжість картки дорівнює свіжості її найстаршої частини (погоджено архітекторкою); write-back результату `run` (B3-4) ставить `readAt` = старт запиту `run`, перечитування після запису чи сигналу (B5b) — старт того перечитування; рядки, записані не читанням: write-back — старт запиту `run`, гідратація — клієнтський `now`, `Writer.patch` (B5b) `readAt` не змінює, рядок лише слабких власників зберігає старий `readAt` (вигляд перечитується раніше, а не пізніше); `readAt` (8 Б) входить в оцінку байтів рядка §6.2; гідратація (B3-6) — `now` у момент гідратації, бо звірка після гідратації одразу перечитує видимі вигляди. Годинник — опція ядра `now`, типово `performance.now()` (монотонний) | старт, а не осідання, і час рядка, а не відкриття картки, тримають межу §8.4 `I + rt`; без відмітки такий вигляд не потрапив би в такт ніколи | §6.3 «Частота» — значення відмітки, годинник, `readAt` (Task 6); §6.2 — 8 Б на рядок в оцінці байтів (Task 0) |
| Р3 | Один предикат цілей ядра `freshnessTargets(object)`: `loaded`, видимий, не `inFlight`, ТЧ — лише змонтована (як фільтр `revalidate`); його беруть і таймер, і вибір планувальника | кандидат, якого `revalidate` не бере, тримав би таймер на нулі без запитів | немає |
| Р4 | `CoreSession.revalidate(object, { visibleOnly, select? })`: `select(view: FreshnessView) => boolean` — вибір планувальника серед цілей Р3; `CoreSession.freshnessOf(object): readonly FreshnessView[]` — легка вибірка без ключів | `activeViews` копіює склад; планувальник кличе вибірку на кожній зміні | немає |
| Р5 | Single-flight `revalidate` з одним хвостом, як `load()` (`trailing`): виклик **без** `select` для вигляду в польоті ставить один хвіст — ще один прохід після осідання з новою епохою старту (сигнали B5b, `narrow` B3-3, перемикання епохи B1c, конфлікт B3-4 потребують читання, що почалось після події); виклик **з** `select` (планувальник) вигляд у польоті не бере взагалі — предикат Р3 його вже виключив. хвіст — прапорець `revalidateTrailing`, який виконують `finally` і `load()`, і проходу, і завжди через `revalidateViews` (не через `load()`, що змінив би склад); прохід зменшує `rereads` у `finally`; повторний прохід після `purge` (`again`) рахує себе в `rereads` і не фільтрує за `inFlight` | пропуск без хвоста лишив би значення схованим чи `stale` до наступного такту | §6.3 — single-flight з хвостом для `revalidate` (Task 6) |
| Р6 | Планувальник — `runtime/freshness.ts`; таймер завжди стоїть на найближчий строк серед цілей Р3 (вигляди в польоті не цілі, тож таймер, поставлений під час проходу, не бачить їхнього старого строку); перепланування — на кожному колбеку ядра `onFreshnessChange`, злитому в одну мікрозадачу; строк вигляду: збоїв немає — `refreshedAt + I`, є — `attemptAt + пауза Р7` | один таймер без «вікна без таймера» під час проходу | немає |
| Р7 | Пауза після збою (погоджено архітекторкою) — `min(I, 0,1 × I × 2^(failures − 1))`; збій `load()` вигляду, що вже `loaded`, теж рахується; `resume()` вигляду з паузою, що ще не минула, не перечитує; вікно 10 % не бере вигляду зі збоями раніше його строку | мертвий сервер інакше отримує запит щотакту від кожної вкладки | §8.4 — пауза після збою (Task 6) |
| Р8 | Злиття `resume()` (погоджено архітекторкою): `resume()` за `RESUME_COALESCE_MS` (1 000 мс) після останнього **прийнятого** `resume()` не шле запитів, навіть частини `version`, але відновлює видимість і таймер, якщо їх зняв `suspend()`; `suspend()` злиття не скидає | повернення вкладки шле `visibilitychange` і `focus` окремими задачами | §6.1, §12 — злиття подій повернення (Task 0) |
| Р9 | Бюджет «`resume()` чи такт, нічого не змінено» — рівно 1 запит на рантайм для будь-якого набору виглядів до `READ_BATCH_MAX` частин, включно з вікном і `full` на кількох сторінках з `include` (B3-3 уже читає сторінки частинами одного пакета й `include` тим самим запитом, як вимагає §6.7); понад `READ_BATCH_MAX` — `⌈частин / READ_BATCH_MAX⌉`; коли щось змінилось і ключ випав — ще 1 пакет за ключами; кожен сценарій бюджету в тестах називає число запитів явно | так бюджет «1» лишається точним, а не формулою «на фазу» | §12 — число запитів кожного сценарію (Task 0); формула «на фазу» з попередньої редакції — не потрібна |

Р1, Р2, Р5, Р6, Р7, Р8, Р9 погоджено архітекторкою; Р3, Р4 — розвилки до погодження.

## Review Focus

1. **Повернення вкладки (`visibilitychange` → `visible`, потім `focus`)**:
   рівно 1 запит (Task 3, Task 5).
2. **Сервер недоступний 10 хв**: рівно 12 запитів одного вигляду, а поряд
   зі справним виглядом — пауза зламаного не скорочується (Task 2).
3. **Перехід на вигляд, утриманий `preload` чи `releaseDelayMs`, коли
   таймера немає**: таймер з'являється, такт — за часом його читання
   (Task 2).
4. **Вкладка, відкрита у фоні**: 0 запитів планувальника до першого
   показу (Task 3, Task 5).
5. **`revalidate` сигналу чи конфлікту під час такту в дорозі**: після
   осідання — ще одне читання (Task 1).

---

### Task 0: Поділ рядка B5 і події host-а в спеці

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`:
  - §13: рядок B5 ділиться на **B5a** «Тригери `resume()` та інтервалу» (обсяг цього плану; залежності B1c, B3-3, B3-4, B3-6; готово — unit стану свіжості, планувальника, подій і бюджетів, модельний тест з подіями зелені, браузерні бюджети — у чотирьох ногах) і **B5b** «Приймач сигналів і знімок прав» (решта рядка B5; залежності B2, ПГ-4, B5a);
  - §12 «Належність кейсів блокам» — «частота — B5a, сигнали — B5b»; у рядках бюджетів частина `rights` — «з B5b»; рядок «`resume()` чи такт, нічого не змінено» — число запитів за Р9;
  - §6.1 — `resume()`, `suspend()`, `navigated()` як API рантайму, межі Р1, опція `visible`, злиття Р8 (усі правки §6.1 — лише тут);
  - §10 «Перевірка версії» — `navigated()` рахує межу 60 с від `lastVersionAt` будь-якого джерела; `requestVersion()` з одним хвостом;
  - §6.2 — `readAt` рядка (8 Б) в оцінці байтів рядка ядра, якщо формулу там названо;
  - решта посилань на B5 у спеці й Додатку А — на B5a чи B5b за змістом.
- Modify: плани з посиланнями на B5 (`grep -rn 'B5' docs/superpowers/plans docs/superpowers/specs`): B3-3 Р4, B3-6 Task 11, B3-4 Task 4 — на B5a чи B5b за змістом.

- [ ] **Step 1: Правки**; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Commit.** `docs(spec): поділ B5 на B5a і B5b, події повернення вкладки`

### Task 1: Стан свіжості, час рядка, предикат цілей і `revalidate` з хвостом

**Files:**
- Modify:
  - `packages/simetra/src/data/store/object-store.ts` (`RowEntry.readAt` — найбільший час старту читання, що записало рядок; write-back `run` — старт запиту `run`; 8 Б в оцінці байтів рядка, якою B3-3 рахує `ghostBytes`); `store/section-store.ts` (`readAt` повної підмножини ТЧ); лінивий шар полів (`readAt` проєкції лінивих полів);
  - `store/subsets.ts` (поля Р2 на `Subset`; `load()` ставить `attemptAt` на старті (`inFlight` виводиться з `s.flight`), на успіху `refreshedAt = старт` і `failures = 0`, на збої `failures + 1`, у `finally` виконує `revalidateTrailing`; картка зі сховища в `start()` — `refreshedAt = row.readAt`; колбек `onFreshnessChange` на переході слухачів 0 ↔ ≥ 1 у `subscribe`/`unsubscribe`, на `release`, на `purge` вигляду, на `loaded` без читання, на старті й у `finally` `load()`);
  - `store/writer.ts` (`revalidate` з `select`; `revalidateViews` — Р5: `rereads + 1` і `attemptAt` на старті, хвіст `revalidateTrailing` для викликів без `select`, `rereads − 1` і колбек свіжості у `finally`, `again` рахує себе в `rereads`; частини в збирач — без `await` до постановки; колбек з `setVisible`);
  - `store/core.ts` (опції `now` і `onFreshnessChange` у `createCore`; `freshnessTargets`, `freshnessOf`);
  - `store/types.ts` (`FreshnessView`), `store/defects.ts` (прапорці Step 3 і Task 4);
  - гідратація B3-6 (`store/ssr.ts`): `refreshedAt = now` для гідрованих виглядів;
  - перечитування `full` і вікна з `include` (`readFullAgain`, перечитування вікна): спершу перевірити, що B3-3 кладе цілі `include` у той самий пакет; якщо ні — тут цілі `include` читаються частинами того самого проходу й мікрозадачі з `known`, а не окремим `await readIncluded`. Цілі `include` свіжіють разом з виглядом-власником, а не як окремі видимі вигляди (підмножини цілей не мають слухачів і в `freshnessTargets` не входять).
- Test: `packages/simetra/src/data/store/__tests__/writer.test.ts`, `views.test.ts`, `model.test.ts`

**Interfaces:**
- Produces: `FreshnessView = { spec: ViewSpec; refreshedAt: number; attemptAt?: number; failures: number }` (лише цілі Р3, тож `refreshedAt` визначено); `Subset.refreshedAt?: number`; `RowEntry.readAt: number`; `CoreSession.freshnessOf(object): readonly FreshnessView[]`; `CoreSession.revalidate(object, { visibleOnly: boolean; select?: (v: FreshnessView) => boolean }): Promise<void>`; `createCore({ …, now?: () => number, onFreshnessChange?: () => void })`.

- [ ] **Step 1: Unit `writer.test.ts` (`it.each`; фейковий годинник просувається між відправкою й відповіддю):** до відповіді `refreshedAt` незмінний; після успіху — дорівнює часу старту, `failures` 0; збій — `refreshedAt` незмінний, `attemptAt` = старт, `failures + 1`; `select` перечитує лише вибрані; `revalidate` без `select` під час такту в дорозі — після осідання рівно одне додаткове читання з новою епохою старту (три такі виклики — теж одне); `revalidate` без `select` під час `refresh()` — після осідання рівно одне системне перечитування, склад незмінний; `purge` під час проходу, коли завантаження вигляду в дорозі, — вигляду немає у `freshnessOf`, доки завантаження не осяде; `revalidate` з `select` для вигляду в польоті — нічого; `purge` під час перечитування й `load` у польоті — після осідання вигляд знову у `freshnessOf` (`inFlight` знято); старе покоління стану не пише; конкурентне завантаження, що стартувало пізніше, — `refreshedAt = max`; збій `refresh` вигляду, що вже `loaded`, — `attemptAt` = старт і `failures + 1`; п'ять виглядів трьох об'єктів у одній мікрозадачі — один виклик `countingTransport`.
- [ ] **Step 2: Unit `views.test.ts`:** годинник просунуто до 10 000; список прочитано о 1 000, картка зі сховища відкрита о 10 000 — `refreshedAt` картки 1 000 (`row.readAt`), а не 10 000; шапка прочитана о 5 000, ТЧ о 2 000, показане ліниве поле о 3 000 — `refreshedAt` картки 2 000 (мінімум); write-back `run`, стартованого о 4 000, — `readAt` рядка 4 000; картка над власним створенням (write-back) — `refreshedAt` = старт `run`; картка над рядком лише слабкого власника — його старий `readAt`; ТЧ з `setVisible(true)` без слухачів — не в `freshnessOf`; невидимий вигляд — не в `freshnessOf`; вигляд до першого успіху — `refreshedAt` `undefined`.
- [ ] **Step 3: Модельний тест:** інваріанти — `refreshedAt` не зменшується; `loaded ⇒ refreshedAt !== undefined`; вигляд, чиє останнє читання впало, зберіг попередню відмітку; `inFlight ⇔ є читання цього вигляду в дорозі` (в обидва боки); після затишшя кожна ціль `revalidate` без `select`, викликаного на позиції журналу p, має осіле читання, видане не раніше p, або вигляд зник (ловить `freshness-skip-without-trailing`, запис у `CAUGHT_BY`). Самотест: дефекти `freshness-stamp-on-send`, `freshness-stamp-on-failure`, `freshness-skip-without-trailing` — модель червона.
- [ ] **Step 4: Червоний → реалізація → зелений.** `pnpm --filter simetra test writer views model`.
- [ ] **Step 5: Commit.** `feat(data): стан свіжості вигляду, час рядка й revalidate з хвостом`

### Task 2: Планувальник інтервалу

**Files:**
- Create: `packages/simetra/src/data/runtime/freshness.ts`, `packages/simetra/src/data/runtime/__tests__/freshness.test.ts`
- Modify: `runtime/runtime.ts` (опції `revalidateIntervalMs`, `resumeMinIntervalMs`, `visible`, `now` з перевіркою `TypeError` після підстановки типових; той самий `now` — у `createCore` і `createFreshness`; `dispose()` зупиняє планувальник); наявні тести рантайму з фейковими таймерами понад 60 с (`runtime/__tests__/*.test.ts`) — виконавець перевіряє, що живий таймер не додав їм запитів

**Interfaces:**
- Consumes: `CoreSession.freshnessOf`, `revalidate` з `select`, `onFreshnessChange` (Task 1); `CoreSession.requestVersion()` (B3-4).
- Produces: `createFreshness({ core, objects, now, setTimer, clearTimer, intervalMs, resumeMinMs, visible, defects? }): { resume(): void; suspend(): void; navigated(): void; dispose(): void }`; `setTimer`/`clearTimer` типово `setTimeout`/`clearTimeout`.

- [ ] **Step 1: Unit** (фейкові таймери Vitest; живі таймери планувальника лічить шпигун на інжектованих `setTimer`/`clearTimer`, а не `vi.getTimerCount()`; шпигун обгортає колбек і зменшує лічильник і на `clearTimer`, і на спрацюванні):
  - є ціль поза польотом і вкладка видима — рівно 1 живий таймер; `resume()` п'ять разів поспіль — 1; цілей немає — 0;
  - строки t, t + 0,05·I, t + 0,15·I (три вигляди двох об'єктів): такт бере перші два одним викликом транспорту (`countingTransport`) і не бере третього; третій — своїм тактом;
  - п'ять виглядів трьох об'єктів зі спільним строком — 1 виклик транспорту;
  - відповідь такту через 5 с — другого запиту до наступного строку немає (вигляди в польоті не цілі);
  - збій: сервер недоступний з `t = 0`, вигляд свіжий у `t = 0`, `I` = 60 с — за 600 с рівно 12 запитів (60, 66, 78, 102, 150, 210 … 570 с); кроки паузи 6/12/24/48/60 с — окремо; успіх скидає паузу до 6 с;
  - той самий збій поряд зі справним виглядом іншого об'єкта — зламаний вигляд читається за своїм розкладом (12 за 600 с), такти справного його раніше строку не беруть;
  - вигляд завантажено о 0, `refresh` падає о 30 с (без жодного системного перечитування до того) — за 5 с після збою 0 спрацювань; о 36 с — рівно 1 спрацювання й 1 запит (мутант зі старим `attemptAt` читає о 30 с);
  - 0 таймерів → `subscribe` на вигляд, утриманий `preload` (прочитаний о `r`) — рівно 1 таймер, такт о `r + I`;
  - невидимий завантажений вигляд поряд із видимим — не перечитано;
  - ТЧ без слухачів з `setVisible(true)` — 0 спрацювань за 10 с;
  - `setVisible(true)` кількох виглядів у одній мікрозадачі — одне перепланування;
  - `suspend()` — 0 живих таймерів планувальника; запит у дорозі осідає; новий таймер до `resume()` не ставиться; таймер опитування квитанції `unknown` (B3-5) і хвостове завантаження працюють далі;
  - прихована 10 хв — 0 запитів планувальника; позитивний контроль — той самий сценарій видимим: рівно 10 запитів (такти 60 … 600 с, `advanceTimersByTime(600_000)`);
  - `visible: false` на створенні — 0 таймерів до `resume()`;
  - `dispose()` — 0 живих таймерів; такт, що вже спрацював, запиту не шле; `dispose()` під час перечитування в дорозі — після осідання 0 живих таймерів; закриття сесії — те саме;
  - опції `0`, `NaN`, `resumeMinIntervalMs > revalidateIntervalMs` — `TypeError`; лише `revalidateIntervalMs: 10_000` — прийнято, `resumeMinIntervalMs` = 10 000.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test freshness runtime`.
- [ ] **Step 3: Commit.** `feat(data): планувальник інтервалу з одним таймером і паузою після збою`

### Task 3: `resume()`, `suspend()`, `navigated()` і бюджети

**Files:**
- Modify: `runtime/freshness.ts`, `runtime/runtime.ts` (публічні `DataRuntime.resume()`, `suspend()`, `navigated()` з JSDoc події браузера; опція `visible`), `packages/simetra/src/data/index.ts` (типи)
- Test: `runtime/__tests__/freshness.test.ts`, `runtime/__tests__/budgets.test.ts` (Create)

**Interfaces:**
- Produces: `DataRuntime.resume(): void`, `suspend(): void`, `navigated(): void`; `DataRuntimeOptions.visible?: boolean`, `revalidateIntervalMs?`, `resumeMinIntervalMs?`; сталі T4 `RESUME_COALESCE_MS = 1000`, `NAVIGATION_VERSION_MIN_MS = 60_000`.

- [ ] **Step 1: Unit:**
  - `resume()` — 1 запит: частина `version` і перечитування цілей з `refreshedAt`, старшим за `resumeMinIntervalMs`; другий `resume()` через 2 с — 1 запит лише з `version`; другий за 500 мс — 0;
  - `resume()` кожні 600 мс п'ять разів — прийнято 1-й, 3-й і 5-й (відлік від останнього прийнятого);
  - справжня послідовність повернення: `resume()` (`visibilitychange`), за 50 мс `resume()` (`focus`) — 1 запит;
  - `resume` → `suspend` за 300 мс → `resume` за 500 мс — другий `resume()` запитів не шле, живих таймерів знову 1, інтервал іде далі (такт о `refreshedAt + I`);
  - `suspend, suspend, resume` і `resume, resume` (за 2 с) — перечитування лише в першому запиті; таймер один;
  - `resume()` без цілей — лише `version`; `resume()` вигляду з паузою після збою, що ще не минула, — без його перечитування;
  - `resume()` під час такту в дорозі — другого читання вигляду немає;
  - `navigated()` двічі за 30 с — 1 запит `version`; рівно через 60 с — другий; одразу після `resume()` — 0 (спільна `lastVersionAt`); у прихованій вкладці — 0; перечитувань не запускає;
  - `resume()`, `suspend()`, `navigated()` після `dispose()` — нічого.
- [ ] **Step 2: Бюджети `budgets.test.ts`** (`countingTransport` рахує запити, байти тіла й відповіді та склад частин за типом (`parts`, `byType`, B3-3) — кожен сценарій перевіряє точний склад, а не лише число; фікстура без перевизначених адаптерів; межі — від `jsonBytes` фікстури; фікстури з копіями носіїв і без; кожен рядок — точне число запитів):
  - `resume()` раніше за `resumeMinIntervalMs` — рівно 1 запит зі складом `[version]`, тіло й відповідь ≤ 2 КіБ + 128 Б × об'єктів каталогу (без `rights` — B5b);
  - `resume()` після межі, нічого не змінено, вікно на 3 сторінки, картка, ТЧ і `full` на 3 сторінки з `include` — рівно 1 запит зі складом: 3 сторінки вікна + 3 сторінки `full` + картка + ТЧ + частини цілей `include` + `version`, маркер на кожен ключ `known`, тіло ≤ 64 Б × ключів `known` + 2 КіБ, відповідь ≤ 8 Б × рядків + 2 КіБ + частина `version`;
  - такт, нічого не змінено, той самий набір — рівно 1 запит з тим самим складом без `version`, ті самі межі;
  - такт, змінено 2 рядки й 1 ключ випав — рівно 2 запити: перший з відповіддю ≤ 1,1 × корисних + 2 КіБ, другий — за ключем, що випав;
  - 17 об'єктів з видимими виглядами (по одній частині) — рівно 2 пакети;
  - `navigated()` — 1 запит лише з `version`, тіло ≤ 2 КіБ;
  - прихована вкладка 10 хв — 0; позитивний контроль видимою — 10.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test freshness budgets`.
- [ ] **Step 4: Commit.** `feat(data): resume(), suspend() і navigated() рантайму з бюджетами`

### Task 4: Модельний тест — кроки подій

**Files:**
- Modify: `packages/simetra/src/data/store/__tests__/model.test.ts` (рантайм-шар поверх наявної моделі: `createFreshness` над ядром моделі; один явний `now` — лічильник, який оновлює кожен `advanceTimersByTime(ms)` моделі, зокрема в `converge`; крок «до найближчого строку» — `advanceTimersByTime(due − now)` за строком зі шпигуна таймерів, а не `advanceTimersToNextTimer`, бо модель фейкує лише `setTimeout`/`clearTimeout`), `store/defects.ts`

- [ ] **Step 1: Кроки:** `resume()`, `suspend()`, `navigated()`, `setVisible`, `subscribe`/`unsubscribe`, крок «до найближчого строку планувальника», чужа зміна на фейковому сервері, збій сервера на N кроків; малі інтервали (`revalidateIntervalMs` 2 000, `resumeMinIntervalMs` 500).
- [ ] **Step 2: Інваріанти:**
  - між `suspend()` і `resume()` — 0 перечитувань, які запустив планувальник;
  - живих таймерів планувальника ≤ 1, і рівно 1, коли вкладка видима й є ціль Р3 (поза польотом);
  - межа збіжності: зміна на сервері в момент `t` у вигляді, видимому безперервно від `t` на видимій вкладці, без збоїв і без `suspend` — видима не пізніше `max(t, останній resume) + I + rt`, де `rt` — від відправки до кроку `answer: ok` того читання;
  - `resume()` не перечитує вигляду, свіжішого за `resumeMinIntervalMs`.
- [ ] **Step 3: Самотест** (прапорці — у `createFreshness({ defects })`, кожен із записом у `CAUGHT_BY` — інваріант, який мусить його зловити): `freshness-timer-per-view`, `freshness-resume-no-limit`, `freshness-interval-after-suspend`, `freshness-resume-no-version`, `freshness-no-reschedule` (ловить межа збіжності), `freshness-coalesce-drops-timer`; кожен прогін самотесту вимагає щонайменше одного такту з ≥ 1 читанням.
- [ ] **Step 4: Зелений.** `pnpm --filter simetra test model`.
- [ ] **Step 5: Commit.** `test(data): модельний тест з подіями свіжості`

### Task 5: Браузерні бюджети (тестовий хост B3-6)

**Files:**
- Modify: `packages/test-host/src/client.tsx` (`createDataRuntime({ visible: !document.hidden, … })`; `resume()` на `focus` і `visibilitychange` → `visible`, `suspend()` на `visibilitychange` → `hidden`, `navigated()` на зміні маршруту; малі інтервали з конфігурації хоста лише для e2e: `revalidateIntervalMs` 2 000, `resumeMinIntervalMs` 500), `src/router.tsx` (серверний рантайм — `visible: false`), `packages/test-host/e2e/budgets.spec.ts`, маніфести ніг `packages/test-host/e2e/manifest.<project>.<build>.json` (B3-6 Р8)

- [ ] **Step 1: Механіка** (записати в шапці `budgets.spec.ts`): `page.clock.install()` до `goto` — підміняє `Date`, `setTimeout` і `performance.now` сторінки, тож годинник ядра й таймери рантайму — фейкові разом; після `goto` і гідратації — `page.clock.pauseAt(…)`, бо після `install` час іде природно й такти спрацьовували б поза кроками тесту; далі час рухається лише циклом «`page.clock.runFor(I)` → дочекатися відповіді в журналі `/_serverFn/`», бо таймер наступного такту залежить від осідання реального мережевого читання; видимість — `addInitScript`, що перевизначає `document.visibilityState` і `hidden`, і `dispatchEvent(new Event("visibilitychange"))`; фокус — `window.dispatchEvent(new Event("focus"))` (headless сам його не шле); перевіряється проводка хоста, а не браузерний механізм видимості; лічильник звіряється з мережевим журналом `/_serverFn/` (B3-6 Р7), і частина `version` теж іде через `/_serverFn/`.
- [ ] **Step 2: Бюджети:**
  - повернення: `visibilitychange` → `visible`, за 50 мс `focus` — рівно 1 запит;
  - фокус після межі без змін — рівно 1 запит, відповідь ≤ 8 Б × рядків + 2 КіБ + частина `version`;
  - прихована на 5 інтервалів — 0 запитів; позитивний контроль — 5 циклів видимою: рівно 5;
  - сторінка відкрита прихованою — після гідратації рівно 1 запит звірки B3-6 і 0 запитів планувальника до першого показу; показ — рівно 1 (злиття Р8 не діє: попередній `resume()` не приймався);
  - навігація двічі за 30 с — рівно 1 запит `version`.
- [ ] **Step 3: Маніфести ніг** — додати id нових тестів; повний прогін `e2e` у чотирьох комбінаціях зелений (нові обробники `focus` не зсувають кадрів наявних сценаріїв).
- [ ] **Step 4: Commit.** `test(test-host): браузерні бюджети resume() та інтервалу`

### Task 6: Спеки й гейти

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (§6.3 «Частота» — значення відмітки й час рядка Р2, годинник `performance.now()`, предикат Р3, single-flight з хвостом Р5; §8.4 — пауза Р7; Додаток А — рядки B5a «внесено (B5a)»; §6.1, §10, §12, §13 — лише Task 0), `docs/ROADMAP.md` (B5a)

- [ ] **Step 1: Правки**; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Гейти.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm build:packages && pnpm test:packaging`; `ORACLE_BUILD=production pnpm --filter test-host e2e --project=chromium` і решта ніг.
- [ ] **Step 3: Commit.** `docs(spec): тригери resume() та інтервалу під B5a`

**Готово B5a:** unit стану свіжості, планувальника, подій і бюджетів, модельний тест з подіями зелені; браузерні бюджети зелені в чотирьох ногах.

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| відмітка на відправці, а не на осіданні | `writer.test.ts` (годинник між відправкою й відповіддю), модельний тест (`freshness-stamp-on-send`) |
| відмітка на збої | `writer.test.ts`, модельний тест |
| відмітка = час осідання замість старту | `writer.test.ts` |
| картка зі сховища — `now` замість `row.readAt` | `views.test.ts` (годинник просунуто) |
| картка бере `readAt` шапки, а не мінімум частин | `views.test.ts` |
| `revalidate` без `select` пропускає вигляд у польоті без хвоста | `writer.test.ts`, модельний тест (`freshness-skip-without-trailing`) |
| `inFlight` не знімається після `purge` | `writer.test.ts` |
| збій `load()` без `attemptAt` | `freshness.test.ts` (збій о 30 с — читання о 36 с, а не о 30 с) |
| таймер на кожен вигляд | `freshness.test.ts` (шпигун `setTimer`), модельний тест |
| такт без вікна 10 % чи з усіма видимими | `freshness.test.ts` (строки t, t + 0,05·I, t + 0,15·I) |
| вікно 10 % бере вигляд зі збоєм раніше строку | `freshness.test.ts` (поряд зі справним) |
| `subscribe` на `loaded` вигляд не перепланує | `freshness.test.ts` (`preload`) |
| повтор після збою без паузи | `freshness.test.ts` (рівно 12 за 600 с) |
| пауза не скидається на успіху | `freshness.test.ts` |
| інтервал після `suspend()` | `freshness.test.ts`, модельний тест |
| `visible: false` ігнорується | `freshness.test.ts`, `budgets.spec.ts` (відкрита прихованою) |
| `resume()` без межі `resumeMinIntervalMs` | `freshness.test.ts`, модельний тест |
| `resume()` без частини `version` | `freshness.test.ts`, модельний тест |
| два `resume()` повернення — два запити | `freshness.test.ts`, `budgets.spec.ts` |
| злиття `resume()` гасить і відновлення таймера | `freshness.test.ts`, модельний тест (`freshness-coalesce-drops-timer`) |
| злиття від кожного виклику, а не від прийнятого | `freshness.test.ts` (кожні 600 мс) |
| `navigated()` без межі 60 с чи без спільної відмітки | `freshness.test.ts` |
| `suspend()` зупиняє опитування квитанції | `freshness.test.ts` |
| таймер переживає `dispose()` | `freshness.test.ts` (0 живих таймерів після осідання) |
| перечитування невидимого вигляду | `freshness.test.ts` |
| прохід з `await` між об'єктами | `writer.test.ts`, `freshness.test.ts` (5 виглядів — 1 виклик) |
| сторінки `full` читаються послідовними запитами | `budgets.test.ts` (рівно 1 запит) |
| вікна, `full` чи цілей `include` немає серед частин перечитування | `budgets.test.ts` (склад частин) |
| `include` перечитується окремим запитом | `budgets.test.ts` (рівно 1 запит зі складом) |
| `inFlight` знімає перший з двох польотів | `writer.test.ts` (`purge` під час проходу з `load` у дорозі) |
