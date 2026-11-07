# Звіт спайку B3: фасад колекцій на закріпленій RC TanStack DB

> **Статус:** звіт спайку від 2026-11-07, перша задача блоку B3
> ([спека П4-B](2026-11-05-p4-b-client-data-design.md) §13, рядок B3).
> Механізми, які перевіряє спайк, — спека П4-B Рд19–Рд24, Рд27, §6.1–§6.4,
> §7.1–§7.2. Код проби — одноразовий пакет поза репо (у git не зберігається);
> сервера немає, джерело — фейковий `queryFn`, що записує
> `ctx.meta.loadSubsetOptions`. Поправки §6 і §7 вносить план B3 після рішення
> архітекторки.

## Питання і відповідь

**Питання.** Чи тримає закріплена RC механізми §6 спеки П4-B? Сім механізмів:
сторінка вікна як підмножина `inArray`, власність через лінивий `leftJoin`,
часткове злиття, вивантаження за лічильником посилань, семантика помилок
`write*`, відкладене застосування результату під час обробника, `full` як
`eager`.

**Відповідь: так, для всіх семи.** Два мають умови, що змінюють текст §6 і §7
(Q5, Q6); три дають уточнення без зміни механізму (Q2, Q3, Q7).

| # | Питання | Відповідь | Чи змінює §6/§7 |
| --- | --- | --- | --- |
| 1 | Сторінка вікна як `inArray` | **так** | ні |
| 2 | Власність через лінивий `leftJoin` | **так**; складений ключ рядка join, індекс за полем з'єднання, потреба — весь набір ключів | уточнення §6.2, §6.4 |
| 3 | Часткове злиття `partial` | **так**; ліниве поле переживає картку, порожнє поле — явний `null` | уточнення §6.2 |
| 4 | Вивантаження за лічильником | **так** | ні (наслідок — у Q5) |
| 5 | Помилки `write*` | **так з умовою**: відхилений проміс, а не виняток; пакет атомарний; присутність ≠ `collection.base` | **так** — §7.2 крок 2, §6.2 |
| 6 | Відкладене застосування | **так з умовою**: застосування чекає осідання **всіх** `persisting` транзакцій колекції | **так** — §6.2, §7.1, §7.2 крок 6 |
| 7 | `full` як `eager` | **так**; наступна повна вибірка авторитетна | уточнення §6.1 |

## Середовище

| Інструмент | Версія |
| --- | --- |
| Node | 24.22.1 |
| `@tanstack/db` | 1.0.0-rc.1.4 (точно) |
| `@tanstack/db-ivm` | 1.0.0-rc.1.2 (залежність `db`) |
| `@tanstack/query-db-collection` | 1.5.1 (точно) |
| `@tanstack/query-core` | 5.107.1 (peer `query-db-collection`: `^5.90.15`) |
| `vitest` | 5.1.0, середовище `node` |

У `node_modules` — одна копія кожного пакета `@tanstack/*`. Колекції — через
`queryCollectionOptions`, кожна з власним `QueryClient`; режим `syncMode:
'on-demand'` (у Q7 — `'eager'`); підмножини — живі запити
`createLiveQueryCollection`. Фейкове джерело розбирає `loadSubsetOptions`
через `parseLoadSubsetOptions` (`eq`, `in`), падає на `orderBy` чи `limit` і
ділить `in` за ключем на шматки по 200. Сім файлів тестів, 26 кейсів; повний
прогін зелений тричі поспіль. Вихідний код бібліотек читано в пакетах (шляхи
нижче — відносно `node_modules/@tanstack/`).

### 1. Сторінка вікна як підмножина `inArray` — так

```ts
q.from({ r: collection }).where(({ r }) => inArray(r.id, ['k40', 'k07', 'k23']))
```

```text
Q1 loadSubsetOptions[0]: {"where":{"name":"in","args":[{"path":["id"],"type":"ref"},
  {"value":["k40","k07","k23"],"type":"val"}],"type":"func"},"signal":{}}
Q1 two pages: calls = 2 collection keys = k01,k02,k30,k31,k32
```

- `queryFn` отримує рівно ключі сторінки, без `orderBy`, `limit`, `offset` і
  `cursor`; у колекції лише ключі сторінки — ні префікса, ні повного джерела.
- Дві сторінки — два виклики `queryFn` і два записи кешу Query; обидві
  співіснують в одній колекції.
- Ключ запиту підмножини має семантику множини: той самий набір ключів в
  іншому порядку — той самий запит. Порядок сторінки тримає фасад (Рд20).
- Джерело: `db/src/collection/subscription.ts` (будує `LoadSubsetOptions`),
  `query-db-collection/src/query.ts` (`generateQueryKeyFromOptions`,
  `createQueryFromOpts`), `db/src/query/ir-stable-identity.ts`
  (`getLoadSubsetDemandKey`).

**Наслідок для §6:** немає; форма 2 §6.1 тримається.

### 2. Власність через лінивий `leftJoin` — так

```ts
q.from({ o }).where(({ o }) => inArray(o.id, keys))
 .leftJoin({ c }, ({ o, c }) => eq(o.customer, c.id))
 .select(({ o, c }) => ({ id: o.id, customer: o.customer, customerName: c?.name }))
```

```text
Q2 lazy-side loadSubset calls: [{"op":"in","field":["id"],"n":450}]
Q2 chunk sizes: 200,200,50
Q2 after A cleanup: orders = o2,o3 customers = c2,c3
Q2 after B cleanup: orders = ∅ customers = ∅
Q2 FK change: extra lazy loads = [["c2","c99"]] | customers = c2,c99 | o1.customerName = Customer 99
```

- Лінива сторона отримує один `loadSubset` — `inArray(c.id, [усі 450])`, без
  `limit`; поділ по 200 робить `queryFn` (три запити, один масив результату).
- Спільна ціль двох списків живе, поки її тримає хоч один; після закриття
  обох колекція цілі порожня.
- Зміна FK рядка активної сторони запускає нову ліниву підмножину на **весь**
  новий набір ключів; стара вивантажується.
- Ключ рядка живого запиту з join складений (`["o0","c0"]`), тож
  `lq.get('o7')` — `undefined`.
- Без індексу за полем з'єднання бібліотека попереджає «Join requires an
  index … Falling back to scanning local data».
- Джерело: `db/src/query/live/subset-demand-controller.ts` (`createSegment`).

**Наслідок для §6 (уточнення):** §6.4 — `refs` фасад будує за власним ключем
рядка (`o.id`), а не за ключем рядка join; §6.2 — колекція цілі має індекс за
полем з'єднання; лінива потреба — весь набір ключів живого запиту, і будь-яка
зміна FK перезапитує його цілком, тож `include` ставиться на живий запит
однієї сторінки (≤ 200 ключів активної сторони — один запит цілей).

### 3. Часткове злиття `rowUpdateMode: 'partial'` — так

Джерело віддає `body` лише картці (`eq`), списку — без нього.

```text
Q3 options.sync.rowUpdateMode = undefined | collection.config.sync.rowUpdateMode = undefined
Q3 row a after list: {"id":"a","title":"A2","body":"BODY-A","version":2,…}
Q3 row a after refetch: {"id":"a","title":"A3","version":1,"body":"BODY-A",…}
Q3 row a after writeUpsert: {"id":"a","title":"W2","body":"BODY-A","version":3,…}
Q3 row a after card cleanup (list still active): {…,"body":"BODY-A",…}
```

- `queryCollectionOptions` не ставить `rowUpdateMode`, діє типовий `partial`
  (`db/src/collection/state.ts`, `mergesOverRow`) — контрактний тест.
- Список без `body` не стирає завантаженого карткою `body` — і коли список
  вперше бере рядок у власність, і на перечитуванні лише його підмножини.
- `writeUpdate` і `writeUpsert` з частковим рядком теж не стирають `body`
  (`query-db-collection/src/manual-sync.ts`, `applyWriteOperations`).
- Після закриття картки рядок, яким володіє список, досі несе `body`.

**Наслідок для §6.2 (уточнення):** ліниве поле лишається в колекції, поки
рядком володіє інша підмножина — межа пам'яті рахує тіла раніше відкритих
карток; пропущене поле не очищує значення, тож порожнє значення звичайного
поля кодек і T3 передають явним `null`, а не пропуском.

### 4. Вивантаження за лічильником посилань — так

```text
Q4 after A.cleanup(): b,c
Q4 after B.cleanup(): ∅
Q4 identical subsets: queryFn calls = 1 cache entries = 1
Q4 gcTime path: 5ms after unsubscribe = a,d | 85ms = ∅ | lq.status = cleaned-up
Q4 during pending tx after unload: has(a) = true base.has(a) = true
Q4 after tx settled: has(a) = false base.has(a) = false
```

- `cleanup()` прибирає рядки, яких не тримає інша підмножина; спільні
  лишаються. Однакова підмножина двічі — один запит з лічильником 2.
- Без явного `cleanup()` працює відписка разом із `gcTime` живого запиту —
  шлях хука.
- Підмножина, що міститься в завантаженій, отримує власний запит і власність.
- Вивантаження під час `persisting` транзакції стає в чергу: рядок зникає
  після осідання.
- Джерело: `query-db-collection/src/query.ts` (`unloadSubset`,
  `cleanupQueryIfIdle`, `removeQueryOwnership`).

**Наслідок для §6:** механізм тримається; вплив відкладеного вивантаження на
write-back — у Q5.

### 5. Семантика помилок `write*` — так з умовою

```text
Q5 outcomes: {"updateAbsent":"rejected UpdateOperationItemNotFoundError",
  "deleteAbsent":"rejected DeleteOperationItemNotFoundError",
  "insertDup":"rejected DuplicateKeySyncError","upsertAbsent":"resolved"}
Q5 status/health after rejections: ready "ready"
Q5 batch with absent key: rejected UpdateOperationItemNotFoundError | a.v = 1 |
  batch with dup key: rejected DuplicateKeyInBatchError
Q5 escaped rejection: tx rejected UpdateOperationItemNotFoundError state = failed a.v = 1
Q5 unload during handler:
  base.has(a)=true
  writeUpdate: rejected UpdateOperationItemNotFoundError
```

- `write*` повертає `Promise<void>` і синхронно не кидає: відсутній ключ у
  `writeUpdate`/`writeDelete` — відхилення `*ItemNotFoundError`; наявний ключ
  у `writeInsert` — `DuplicateKeySyncError`. `writeUpsert` відсутнього ключа
  вставляє рядок. Колекція після відхилення лишається `ready`.
- `writeBatch` атомарний: один відсутній ключ відхиляє весь пакет, нічого не
  застосовано; дублікат ключа — `DuplicateKeyInBatchError`.
- Ключ лише в оптимістичному стані вважається відсутнім; `writeInsert`
  власного створення проходить.
- Транзакція падає й відкочує оптимістичний стан, лише коли обробник
  випускає відхилення назовні.
- Присутність для `write*` — внутрішній прийнятий стан
  (`db/src/collection/state.ts`, `getAcceptedSyncedRow`), що враховує
  синхронні записи в черзі; публічний `collection.base` їх не бачить
  (`db/src/collection/index.ts`, `get base()`). Коли підмножину закрили під час
  обробника, `base.has` — `true`, а `writeUpdate` відхилено.
- Джерело: `query-db-collection/src/manual-sync.ts` (`validateOperations`,
  `performWriteOperations`, `writeBatch`).

**Наслідок для §7.2 крок 2 і §6.2 (змінює механізм).** Пропонований зміст
кроку 2: фасад відбирає ключі за `collection.base`; `write*` не кидає —
відсутній ключ відхиляє проміс **усього пакета**; відбір за `base` не бачить
вивантаження в черзі, тож фасад завжди чекає проміс пакета й ловить
відхилення; на `*ItemNotFound` — повтор поштучно з ковтанням відхилення ключа
(рядок уже вивантажено); на `DuplicateKeySyncError` — `writeUpdate` за правилом
версії; відхилення `write*` ніколи не виходить з обробника (крок 7).
`writeUpsert` для відбору не годиться: у цій гонці він вставив би рядок без
власника (Рд22).

### 6. Відкладене застосування під час обробника — так з умовою

```text
Q6 utils.refetch:
  [h1] after awaited refetch: fetched=1 base.title=T1 base.version=1 get.title=T2
  [h1] +20ms still in handler: base.title=T1
  [tx1 settled, same microtask] base.title=T2 version=2
  [h2] start: original.title=T2 base.title=T2
Q6 overlap: txA settled while txB persists → base.a=A1; after txB settled → base.a=A2
```

- Межу підтверджено для `utils.refetch()` і `queryClient.refetchQueries` за
  точним ключем: обробник чекає вибірки, але рядок не застосовано, поки
  обробник триває; застосування — синхронно в момент осідання.
- Наступна мутація ключа після осідання бачить застосований рядок як
  `original`.
- **Умова:** застосування чекає осідання **всіх** `persisting` транзакцій
  колекції — поки висить обробник іншого ключа, результат не застосовано навіть
  після осідання власної транзакції.
- Джерело: `db/src/collection/state.ts` (`commitNextPendingTransactionBatch`,
  `hasPersistingTransaction`), `query-db-collection/src/query.ts`
  (`isMutationPublicationBlocked`, `runMutationHandler`).

**Наслідок (змінює механізм):** §7.2 крок 6 — «після осідання транзакції» →
«після осідання всіх `persisting` транзакцій колекції (`waitPendingSettled`,
§6.3)»; `ownerVersion` фасад оновлює за фактом застосування (версія в
`collection.base` чи після `waitPendingSettled`), а не за `tx.when('settled')`;
§7.1 — наступна мутація ключа чекає того самого застосування; §6.2 «Повна
підмножина ТЧ» — «поки триває мутація» → «поки в колекції є `persisting`
транзакція». Ризик для §6.3: потік мутацій різних ключів відкладає
застосування; межа часу кроку 6 стосується вибірки, а не застосування.

### 7. `full` як `eager` — так

```text
Q7 queryFn calls = 1 loadSubsetOptions = [{}]
Q7 after all live queries cleaned up: collection.size = 10
Q7 directly inserted row after refetch without it: has(new) = false
```

- Колекція `eager` кличе `queryFn` один раз з порожніми опціями; живі запити
  з `where`, `inArray`, `orderBy` і `orderBy+limit` нових викликів не дають.
- Після закриття всіх живих запитів колекція тримає всю вибірку.
- `writeInsert` перечитаного рядка видно в живих запитах одразу; наступна
  повна вибірка авторитетна — рядок, якого вона не повертає, зникає.
- `orderBy+limit` без індексу дає попередження бібліотеки.
- Джерело: `query-db-collection/src/query.ts` — для `eager`
  `createQueryFromOpts({})`, `loadSubset` і `unloadSubset` — `undefined`.

**Наслідок для §6.1 (уточнення):** прямо вставлений рядок живе до наступної
повної вибірки, яка його підтверджує чи прибирає; `refetch` теж служить
перечитуванням для `full`; живі запити `full` з `limit` потребують індексу за
полем сортування.

## Застереження

1. Перевірено лише в `node`, без React і `useLiveQuery`; шлях хука частково
   покриває кейс «відписка + `gcTime`» (Q4).
2. Джерело фейкове, без мережевих затримок; гонку «вибірка стартувала до
   прямого запису» не досліджено.
3. Відбір у Q5 спирається на публічний `collection.base`; фасад не читає
   внутрішнього стану бібліотеки.
4. Ключ запиту підмножини — внутрішній формат бібліотеки; фасад його не
   будує, а шукає запит предикатом.

## Що далі

- Поправки Q5 і Q6 у §6.2, §7.1, §7.2 і уточнення Q2, Q3, Q7 у §6.1, §6.2,
  §6.4 — рішення архітекторки, вносить план B3.
- Кейси спайку — кандидати в контрактні тести фасаду B3 на закріпленій RC.
