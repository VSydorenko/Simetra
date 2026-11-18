# П4-B3-4-Л. Запис: `update` з `await`, write-back, коди відмов — план імплементації

> **Виконання:** `agent-kit:execute`. Частина ⑤ тонкого зрізу М3
> ([ADR-0091](../../adr/0091-m3-thin-slice-scale-later.md)). **Якорі — після
> c1 B3-3** (#109: a2-Л і c1 мусять бути в `main`): `ViewHandle`,
> `createRuntimeHolder`, вхід `simetra/data/react`, `useRow` з `isStale`.
> Перед стартом — `orient --plan` цього файла й звірка імен з `main`; інше
> ім'я в `main` — бере ім'я з `main` і пише заміну в звіт. Приймає план і
> розвилки — архітекторка сесії «Тонкий зріз М3».
>
> **Спільні ресурси.** `packages/simetra/src/data/**` веде один виконавець
> (частини ①–⑥ послідовно; c2 може йти паралельно, але `data/**` не править).
> Задача 1 має один DB-кейс (стек `postgres`, спільний: лише
> `run-tests db --filter <file>`, стек не зупиняти, чужих об'єктів не чіпати). Повні рівні `unit`, `db`, `db-supabase` і
> `format:check`, `lint`, `typecheck`, `metadata:check` запускає CI на draft
> PR; задачі закінчуються цільовим `run-tests unit --filter <file>` чи
> `run-tests unit --changed`, не повним рівнем.

**Мета.** Картка довідника зберігає шапку командою: `DataWriter.update`
шле один `run` з `expectedVersion`, показ чекає відповіді (`await`), успіх
записує рядок результату й знімає мутацію одним `commit`, відмова лишає
мутацію в журналі зі станом і діями за §7.3.

**Архітектура.** Журнал `Overlay` (`store/overlay.ts`, Р-4 серії) з
індексом за ключем і межею 500; порт запису `CoreSource.run` поряд з
`read`; `DataWriter` над сесією ядра (`writerOf(runtime)`, `useWriter()`);
стан рядка рахує `computeRowView` з журналу; звірка сумісності — частина
`version`, остання бачена `serverHash` і позначка «застарілий» в ядрі.
`predict`, перебазування, поглинання, `create`, `markDeletion`, `delete`,
`batch`, дельти ТЧ → #208 (B3-9, М5). Квитанції й `mutationId` → #111
(B3-5, М5).

**Спека.** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §6.2
(межа журналу), §6.4 (`isStale`), §6.5 (стани й дії), §7.1–§7.3, §10, §12
(«unit T4 ядра», модельний тест), §13 рядок B3-4; Рд6, Рд22, Рд24, Рд27.

## Глобальні обмеження

- Лише `await`: показане значення рядка не змінюється до відповіді; поле
  форми показує чернетку (П4-D).
- Один виклик `update` — одна мутація й рівно один `run` з однією
  операцією `update`; без автоповтору на будь-якому коді.
- Жодних полів «про запас»: ні `mutationId` у конверті, ні `predict` у
  каталозі, ні `batch` у `DataWriter` (ADR-0091, lockstep).
- `settled` ніколи не відхиляється. Помилка розробника — `DataError`
  синхронно, до журналу й транспорту.
- Запит `run` (`model/runtime/envelope.ts`) не змінюється; результат `run`
  отримує лише `epoch` (Р10). Інших змін T0/T3 блок не робить.
- Коментарі — українською й про «чому»; JSDoc експорту — англійською.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Одна мутація на ключ.** `update` ключа з мутацією `pending` — `DataError` `data.mutation-pending` синхронно (форма вимикає «Зберегти» на `pending`). `update` ключа з мутацією `failed`, `conflict` чи `unknown` заміняє її запис: це «Перезаписати» форми (нова база — поточний серверний рядок). Черги ключа немає до #208. Для погодження архітекторкою | §6.1 — новий код `data.mutation-pending` у переліку кодів `DataError` |
| Р2 | **Журнал у М3 рядків не тримає** (не власник за Рд22): запис мутації — ключ, об'єкт, поля, база (`expectedVersion`), стан, помилка. Показ `await` бере підтверджений рядок сховища; рядок без власника-вигляду ніде не показаний, а write-back його не пише (Рд6: лише ключі з власником). Власником журнал стає з `create`/`predict` (#208). Для погодження архітекторкою | §6.2 Рд22 і §6.1 `Overlay` — речення «з B3-9» |
| Р3 | **Write-back — окремий метод `Writer.writeBack(object, rows, epoch, readEpoch)`** (погоджено архітекторкою), не `apply`: `apply` — шлюз відповіді читання, і рядок з епохою читання, пізнішою за `hide` чи `removed`, зняв би позначку. `writeBack` не знімає `hidden`, `removed` і надгробків (Р-2 серії) і пише лише ключі з власником. Епоха результату (Р10) дорівнює епосі сховища — правило версії (Рд24); інша епоха — значень не пише, ключі йдуть на перечитування (правило перемикання епохи B1c). Шляху `versionEpoch: null` для write-back немає (борг #189). `writeBack` не йде через шлях `ObjectStore.put`, що знімає позначки (`clearMarks`, зняття `removed` за `readEpoch`): до запису він дивиться запис ключа, і ключ з `removed` чи `stale.hidden` пропускає без запису й віддає в перечитування; перевірку надгробка робить з `readEpoch` старту спроби (його `Overlay` фіксує на старті, `CoreSession.readEpoch()`). Форма в коді — `writeBack` поверх `put` з прапорцем «без зняття позначок» чи окремий шлях `ObjectStore` — вибір виконавця, `object-store.ts` входить у файли задачі 2. Ключ з новішим надгробком чи відкинутий правилом — без запису й з перечитуванням за ключем (§7.2 п. 4); ключ без власника з рядком тієї самої епохи осідає рядком `run` без перечитування (рішення архітекторки 17.11). Тест `writer-gate-guard`: `writeBack` кличе лише `Overlay`; writer лишається єдиним шляхом запису | §7.2 п. 3 — правило епохи write-back (задача 0) |
| Р10 | **Результат `run` несе `epoch`** (погоджено архітекторкою): T3 читає епоху версій рядків у транзакції команди тим самим оператором і `epochOf`, що й `readParts` (`server/runtime.ts`), після записів команди (тоді скидання епохи, що бере `LOCK … SHARE`, чекає її `COMMIT`); `CommandResult.epoch: string \| null` (T0 `model/runtime/result.ts`), `WireRunResult.epoch` (`server/response-budget.ts`; бюджет відповіді рахує поле, як у читанні), клієнтська схема значення `run` у T0. Версії порівнянні лише в межах однієї епохи (Рд24) | §7.2 п. 3, §7.4 «версія з послідовності» — результат `run` несе епоху (задача 0) |
| Р4 | **Ключ без повного рядка результату перечитується до осідання**: результат без `rows`, рядок без лінивих колонок при зміні лінивого атрибута, `writeBack` без запису. Перечитування — `rereadKey` (`store/writer.ts`): **за ключем** через `readKeys` над `CoreSource`, запис лише у слоти власників з епохою старту читання; лінива правка — формою картки ключа; результат викликачу (успіх, збій, відкинуто), колбек у тому самому `commit`, де пишеться перечитаний рядок (там `Overlay` знімає мутацію), межа 5 с. Вигляди цілком не перечитуються (рішення архітекторки 17.11 замість розширення `revalidateHolders`: швидкодія — вимога). Ключ без власника не перечитується. Збій чи межа — осідання `{ ok: true, rows: [undefined] }` і `stale` за §7.2 п. 4 | немає |
| Р5 | **Дії мутації — у рядку**: `RowView.mutation = { id, state, error?, retry?, cancel?, dismiss? }`. `failed` — `retry`, `cancel`; `conflict` — `cancel` (це «Взяти серверне»: рядок уже перечитано); `unknown` — `dismiss` («Скасувати показ», Р-1 серії). `retry()` — нова спроба тих самих полів і бази й новий `Mutation`. `takeServer`/`overwrite` — дії форми над `cancel` і новим `update` (П4-D) | §6.5 — назви дій у таблиці (ідентифікатори `retry`, `cancel`, `dismiss`) |
| Р6 | **`unknown` у М3** (`command.unavailable` на `run`, тайм-аут, обрив): перечитування ключа й дія `dismiss`; розв'язання квитанцією — з #111. Мутація `unknown` лишається в журналі й у межі 500, доки її не прибере `dismiss`, `cancel` чи новий `update` ключа | §7.3 рядок `unavailable` — «до B3-5: перечитування за ключем і `dismiss`» |
| Р7 | **`hidden`, `removed` і мутація** (Р-2 серії): `hidden` ховає значення й має пріоритет показу над станами мутації; `RowView.mutation` лишається з діями, мутація осідає звичайно, write-back позначки не знімає. Гілка `removed` `RowView` теж несе `mutation` з діями (`cancel`, для `unknown` — `dismiss`): §6.5 «`removed` з незавершеною мутацією — причина й «Скасувати»», інакше мутацію `forbidden` → `removed` нічим прибрати | §6.5 — пріоритет станів (`hidden` першим після `removed`) |
| Р11 | **`purge` і `removed` чистять журнал** (§6.2, §12 «`purge` лишає мутації в журналі без значень»; `removed` за звуженням скидає чернетку, як `purged`): `purge` ключа чи пари, що зачепив ключ мутації, і перехід ключа мутації в `removed` у тому самому `commit` стирають поля запису `Overlay`; мутація лишається зі станом і помилкою, без `retry` — лише `cancel` чи `dismiss`. Відповідь польоту за таким ключем значень не пише (надгробок). Запис `Overlay` тримає скоуп ключа на старті спроби (зі сховища; рядка немає — скоуп невідомий): ключ без власника `ObjectStore` уже не тримає, і `purgeScope` його не знайде. `purge` пари (об'єкт, скоуп) стирає поля записів цього об'єкта з тим самим або невідомим скоупом. `hide` полів не стирає: доступ не втрачено остаточно, мутація осідає звичайно (Р7); але `retry` недоступний, поки ключ `hidden` (лише `cancel`, `dismiss`), — до читання після позначки клієнт не знає, чи право є | немає |
| Р8 | **Звірка сумісності в ядрі.** Рантайм віддає ядру `serverHash` кожної відповіді (зокрема відмови) внутрішнім колбеком; зміна проти останнього баченого (перший — `snapshotHash` клієнтського каталогу) — `requestVersion()`. Колбек кличеться лише після перевірки `closedWith`: відповідь після `dispose()` чи `session-changed` не запускає `requestVersion` і `onStaleClient` закритого рантайму. Частина `version` — окремий метод `CoreSource.version()`, завжди через Server Function, навіть за перевизначеного адаптера об'єкта; відповідь із частиною `version` лише оновлює останній хеш і позначки, нового запиту не запускає. `requestVersion()` — single-flight з одним хвостом | §10 — без змін (реалізація) |
| Р9 | **Порт запису без `AbortSignal`**: `DataTransport` його не має; пізню відповідь відкидає токен спроби | §7.2 п. 2 — «без `AbortSignal`: відповідь після `dispose()` чи `cancel` відкидає токен спроби» |

## Інтерфейси

| Що | Форма | Хто дає → хто бере |
| --- | --- | --- |
| `DataWriter` | `{ update(object: ObjectName, id: Key, values: Values, options: { expectedVersion: number }): Mutation }` | B3-4-Л → D (картка), T5 |
| `Mutation` | `{ id: string; settled: Promise<{ ok: true; rows: readonly (ServerRow \| undefined)[] } \| { ok: false; error: CommandError }> }`; `id` — локальний, не `mutationId` | B3-4-Л → D |
| `writerOf(runtime)`, `useWriter()` | `simetra/data`; `simetra/data/react` (через тримач c1: після `replace` — writer нового рантайму) | B3-4-Л → D |
| `RowView.mutation` | Р5; `RowView.state` бере `pending`/`failed`/`conflict`/`unknown` з журналу | B3-4-Л → c1 `useRow`, D |
| `ViewSnapshot.isStale` | позначка «застарілий» об'єкта вигляду (§10); c1 `useRow`/`useRows` віддає її в `isStale` | B3-4-Л → c1 хуки, D |
| `DataRuntimeOptions.onStaleClient` | `(object: ObjectName) => void`; на кожну відповідь `stale-client` і на переході позначки «знято» → «поставлено» | B3-4-Л → D (хост) |
| `CoreSource.run` | `run(op: Operation, kernels): Promise<{ rows: (ServerRow \| undefined)[]; changes: Change[] } \| CommandError>` (форма — виконавця); мапінг `operationToWire`, `kernels` об'єкта операції, `decodeRow`, `changesFromWire`; значення, яке не кодується, — `command.invalid` з логічним `path` без транспорту | внутрішнє |
| `CoreSource.version()`, `CoreSession.requestVersion()` | Р8 | B3-4-Л → ⑥ (`resume()`-Л), B5b пізніше |
| `Writer.writeBack(object, rows, epoch, readEpoch)` | Р3 | внутрішнє |
| `rereadKey(ctx, object, key, { form, unconfirmed?, onCommit? })` | Р4 | внутрішнє |
| `CommandResult.epoch`, `epoch` у значенні `run` | Р10 | B3-4-Л (T0/T3) → T4, `runtime.run` у процесі |
| `DataErrorCode` | `+ data.journal-full`, `+ data.mutation-pending` | B3-4-Л |

Бере: `Writer.hide`, `RowView.hidden`, `revalidateHolders` (B3-3 t0, у
`main`); тримач і хуки (c1); `operationToWire`, `changesFromWire`,
`errorFromWire` (T0); частина `version` конверта й `readParts` T3 (у
`main`).

## Інваріанти безпеки й коректності

Кожен — тест, що червоніє на названому дефекті.

| Інваріант | Тест і мутація |
| --- | --- |
| Після `dispose()` чи `session-changed` відповідь `run` нічого не пише, а кожен живий `settled` уже розв'язано `{ ok: false, error: disposed }` (чи `session-changed`) | `overlay.test.ts`; мутація «писати write-back без перевірки токена» — червоний |
| Write-back не знімає `hidden` і `removed` і не воскрешає `purge`-ключа | модельний тест; дефект `writeback-lifts-hidden` у `defects.ts` — модель червона |
| Write-back іншої епохи не пише значень і перечитує ключі | `overlay.test.ts` і крок «перемикання епохи з мутацією в дорозі» моделі; мутація «писати рядок результату без звірки епохи» — червоний |
| Епоха результату `run` — епоха транзакції команди, не `null` на базі з епохою | DB-кейс задачі 1; мутація «не читати епоху в `run`» — червоний |
| Позначка «застарілий»: запис об'єкта з позначкою — `stale-client` без транспорту; чергування відповідей `version` двох каталогів ставить і знімає позначку без циклу запитів | `runtime.test.ts`; мутація «відповідь `version` теж кличе `requestVersion`» — лічильник запитів червоний |
| Після `purge` ключа чи пари або переходу в `removed` журнал не тримає значень зачеплених мутацій, і `retry` недоступний (так само поки ключ `hidden`) | `overlay.test.ts`: зокрема ключ без власника-вигляду й `purge` пари його скоупу; інваріант моделі; дефекти «`purge` не чистить журнал» і «`purge` пари шукає ключі лише в сховищі» — червоні |
| Відповідь після закриття рантайму не кличе `onStaleClient` і не шле `version` | `runtime.test.ts`; мутація «колбек `serverHash` до перевірки закриття» — червоний |
| Дві сесії не бачать мутацій одна одної | `overlay.test.ts`: журнал — у сесії ядра; мутація «журнал на модулі» — червоний |
| `path` відмови — логічний: фізичне ім'я колонки назовні не виходить | `overlay.test.ts` (`it.each` за §7.3); мутація «без мапінгу `path`» — червоний |

## Задачі

### Задача 0 — якорі й правки спеки

`orient --plan` цього файла; звірка з `main` імен c1 (`RuntimeHolder`,
`useRow`, `ViewHandle`) і a2-Л. Правки П4-B за Р1, Р2, Р5–Р7, Р9: §6.1
(коди, `Overlay` без рядків до B3-9), §7.2 п. 3 і §7.4 (епоха результату
`run`, правило епохи write-back, Р3, Р10), §6.5 (пріоритет з `hidden`, назви
дій), §7.2 п. 2, §7.3 рядок `unavailable`; Додаток А — рядки «внесено
(B3-4-Л)». Готово: `doc anchors && doc lint` зелені; дельти коду проти
плану — у звіті задачі. Коміт `docs(spec): П4-B — запис тонкого зрізу`.

### Задача 1 — епоха в результаті `run`, порт запису й частина `version`

T0/T3 за Р10: `model/runtime/result.ts`, схема значення `run` у
`model/runtime/envelope.ts`, `server/runtime.ts` (епоха в транзакції
команди), `server/data-handler.ts`, `server/response-budget.ts`. DB-кейс
поряд із `packages/designer/src/__tests__/read-batch.db.test.ts`: епоха
`run` дорівнює епосі `read` тієї самої бази; після скидання епохи
(`reset_row_version_epoch`) — нова. T4: `store/source.ts` (`CoreSource.run`, `CoreSource.version`), `adapter.ts`
(Server Function: `run` і `read` з частиною `version` через `send`),
`runtime/runtime.ts` (колбек `serverHash` у ядро; `send` без змін форми),
`store/testing/fake-source.ts` (`run` і `version` фейку).
Готово: `source.test.ts` — мапінг `run` туди й назад, `kernels` об'єкта
операції, `Mapped.invalid` → `command.invalid` з логічним `path` без
транспорту, хибна форма відповіді → `command.internal`, `version` іде через
Server Function за перевизначеного адаптера; значення `run` без `epoch` —
`command.internal`. `run-tests unit --filter source`, `--filter response-budget`,
`run-tests db --filter <файл DB-кейсу>`.

### Задача 2 — `Overlay`, `DataWriter`, write-back (після 1)

Створити `store/overlay.ts`, `data-writer.ts` (`writerOf`; ім'я не
`writer.ts` — там `Writer` ядра), `react/use-writer.ts`,
`store/__tests__/overlay.test.ts`. Змінити `store/core.ts` (журнал у сесії;
`close` розв'язує живі `settled`), `store/writer.ts` (`writeBack`, Р3;
`rereadKey` за ключем, Р4; `purge` чистить журнал, Р11), `store/object-store.ts` (запис без
зняття позначок, Р3),
`store/snapshot.ts` (`computeRowView`: стан з журналу, `mutation`, Р7),
`store/types.ts`, `errors.ts`, `index.ts`, `react/index.ts`.
Готово (`overlay.test.ts`, `snapshot.test.ts`, `writer-gate-guard`):
`await` не змінює значення до відповіді, стан `pending`; успіх — запис
рядка й зняття мутації одним сповіщенням; Р1 (`pending` → `DataError`;
`failed` → заміна); межа 500 — `data.journal-full` без транспорту; `update`
без `expectedVersion` — `data.version-required`; Р4 (без `rows` і ліниве
поле — перечитування до осідання, збій 5 с — `stale` і `rows: [undefined]`);
ключ з новішим надгробком — осідання без запису й перечитування; запис
перечитаного й зняття мутації — одне сповіщення; `removed` з мутацією
несе `cancel`; `cancel`,
`dismiss`, `retry` за Р5; відповідь після `cancel`, `retry`, `dispose()` —
нічого не пише; `useWriter` після `replace` тримача — writer нового
рантайму. `run-tests unit --filter overlay`, потім `--changed`.

### Задача 3 — коди відмов і позначка «застарілий» (після 2)

`store/overlay.ts` (таблиця «код → стан і дія»), `store/core.ts`
(позначки об'єктів, `requestVersion`, `ViewSnapshot.isStale`),
`runtime/runtime.ts` (`onStaleClient`).
Готово — `it.each` за §7.3 у `overlay.test.ts`: `conflict` — стан
`conflict` і перечитування ключа; `forbidden` — `failed` і перечитування,
відсутній рядок — `removed`; `invalid` — `failed` з логічним `path`;
`stale-client` — `failed`, `requestVersion`, `onStaleClient(object)`, без
повтору; `unavailable`, тайм-аут, обрив — `unknown`, перечитування, лише
`dismiss`; `unavailable` `disposed` — нічого; `session-changed` — закриття;
`busy`, `timeout`, решта — `failed`. У `runtime.test.ts`: зміна
`serverHash` — один запит `version`; два виклики в мікрозадачі — одна
частина; три виклики під час польоту — рівно один хвіст; відповідь
`version` лише оновлює хеш і позначки; `isStale` ставиться й знімається;
запис позначеного об'єкта — `stale-client` без транспорту.
`run-tests unit --filter overlay`, `--filter runtime`.

### Задача 4 — модельний тест і контракт чернетки (після 3)

`store/__tests__/model.test.ts`, `store/defects.ts`,
`store/__tests__/draft-contract.test.ts` (фейкова форма над `DataWriter`).
Кроки моделі до наявних: `update` `await`, відповідь будь-якої спроби в
будь-якому порядку (`ok`, `conflict`, `forbidden`, `unavailable`), `retry`,
`cancel`, `dismiss`, чужа правка ключа з мутацією, `purge` і `hide` ключа з
мутацією, `dispose()` з мутацією в дорозі. Інваріанти: показаний рядок =
підтверджений (`await`); відмова не прибирає мутації мовчки; межа журналу;
write-back не знімає `hidden` і не воскрешає `purge`; після `purge` ключа
журнал не тримає його значень; після `dispose()`
жоден `settled` не дає `ok: true`. Самотест: дефекти «показати значення до
відповіді», «осідати окремим `commit`», «знімати `hidden` write-back»,
«писати відповідь після `cancel`» — модель червона. Контракт чернетки за
§13 рядком B3-4: відповідь на ревізію A не перезаписує правок ревізії B;
`conflict` лишає правки; «Скасувати» скидає одним кадром; `purged` скидає
чернетку. `run-tests unit --filter model`, `--filter draft-contract`.

## Шлях до #208 і #207

Тонка форма — планове відкладення (ADR-0091, рядок «швидкодія — вимога»
m3-common), не спрощення назавжди. Шви, на які #208 і #207 стають без
переписування коду М3:

| Шов | Що дає М3 | Що додає пізніший блок |
| --- | --- | --- |
| `Overlay` — записи за ключем зі станами (`pending`, `failed`, `conflict`, `unknown`) й індексом `Map<Key, Entry[]>` | один запис на ключ (Р1) | #208: черга ключа (кілька записів), база з попереднього запису |
| поле режиму запису `policy` | лише значення `"await"`; `computeRowView` читає показ через функцію режиму | #208: значення `"predict"` — передбачене значення в шарі показу, поглинання, перебазування |
| `Writer.writeBack(object, rows, epoch, readEpoch)` | рядки ключів з власником за правилом епохи | #208: власні створення й підтвердження `predict` тим самим методом |
| власність рядка (Рд22) | журнал не власник (Р2, погоджено архітекторкою) | #208: запис журналу стає власником адитивно, через наявний лічильник власників `RowEntry` |
| `DataWriter` | лише `update` | #208: `create`, `markDeletion`, `delete`, `batch`, дельти ТЧ — нові методи над тим самим `Overlay` |
| `CoreSession.requestVersion()` | окремий запит `read` з частиною `version` | #207: та сама функція кладе частину в пакет збирача; викликачі не змінюються |
| перечитування після запису — `rereadKey` за ключем через `readKeys` | окремий запит за ключем | #207: пакет збирача з `known` |
| дії рядка `RowView.mutation` | `retry`, `cancel`, `dismiss` | #208: `cancel` для `predict` у `pending`; #111: розв'язання `unknown` квитанцією без зміни дій |

Зміна, що зламала б цей шов (злиття станів у прапорець, write-back через
інший шлях, режим поза записом журналу), — розвилка архітекторці.

## Відкладене

- `predict`, перебазування, поглинання, `noop`, `create`, `markDeletion`,
  `delete`, `batch`, дельти ТЧ, журнал як власник рядка, гачок `pinned` → #208.
- Квитанції `run`, `mutationId`, розв'язання `unknown` запитом стану (B3-5) → #111.
- Бюджети запису через `countingTransport` → #210.
- Перечитування після запису одним пакетом збирача з `known` → #207.

## Задачі власника

Немає.

## Підсумок аудиту

Раунд 1 — дві лінзи паралельно: Sonnet «план проти спеки й коду» і Opus
«безпека й старе покоління» (блок торкається меж суб'єктів і версій). Sonnet
дав три major виконуваності: `revalidateHolders` перечитує вигляди й комітить
сам (→ Р4: результат ключа, колбек у тому самому `commit`, межа 5 с);
`ObjectStore.put` знімає `hidden`/`removed` (→ Р3: перевірка до запису,
`readEpoch` старту спроби); гілка `removed` без дій мутації (→ Р7). Opus дав
один security major: `purge` не чистив значення журналу (→ Р11). Паралельно
архітекторка вирішила розвилку write-back: окремий `Writer.writeBack` і
`epoch` у результаті `run` (Р3, Р10). Codex (тригер — security major від
Opus) дав два blocker: `purge` пари не бачить ключа без власника (прийнято →
скоуп у записі журналу) і `retry` після `hide` (прийнято частково: це не
витік, права тримає сервер, але `retry` до читання після позначки знято).
Раунд 2 — Opus по диффу правок: 0 blocker, 0 security major, один minor
(`removed` за звуженням теж чистить журнал, як каже спека) — внесено, бо
дешево. Не прийнято як знахідки (впевненість < 80, лишено виконавцю): порядок
колбека `serverHash` відносно `session-changed`; осідання, коли всіх
тримачів пропущено, — через межу 5 с.
