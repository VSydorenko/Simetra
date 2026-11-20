# П4-B5b, частина 1. Знімок прав: SQL, частина `rights`, предикати — план імплементації

**Статус:** чернетка на приймання архітекторкою М4 (`m4-simetra-milestone`).
Issue #114, віха М4. Блок B5b спеки П4-B переписано над `main` після B3-8
(#272), B5c (#284) і ПГ-4/B2 частин A–C (#273, #279, #288).

- **Анкори.** Усі анкори — на `main`; незмерджених залежностей частина не має.
- **Спільні ресурси.** Стеки `postgres` і `supabase` — спільні: лише
  `pnpm db:pg:start` з основного checkout, не зупиняти, не чистити чужих
  об'єктів. Нових ролей і розширень частина не додає.
- **Межі серії.** `src/compiler/sql/**` змінює виконавець #275, потім #297:
  ця частина його не чіпає (нова одиниця — у `compiler/rights/`). Звір
  перед стартом таблицю сесій у спільному брифі архітекторки М4.
- **Лише CI.** Повні рівні `unit`, `db`, `db-supabase` (профіль, `ci: true`)
  запускає CI на draft PR. Задачі закінчуються лише цільовими
  `run-tests … --filter <файл>` чи `--changed`.

## Серія B5b: частини, порядок, шви

| Частина | Файл | Зміст | Після |
| --- | --- | --- | --- |
| 1 | цей | T0 схема знімка й частина `rights`; поля каталогу; T1 `rights_client_snapshot()`; T3 частина `rights` у пакеті `read`; чисті предикати T4 `readAllowed` і `canSubscribe`; DB-еквівалентність обох | `main` |
| 2 | [частина 2](2026-11-20-p4-b5b-2-rights-snapshot-core.md) | знімок у ядрі T4: перший пакет, `requestRights`, службова частина звірки й такту, правило втрати доступу, SSR `rightsVersion`, тригери перечитування | 1 |
| 3 | [частина 3](2026-11-20-p4-b5b-3-signal-receiver.md) | порт `SignalTransport` §8.5, приймач у ядрі, модельний тест, метрики | 2 |
| 4 | [частина 4](2026-11-20-p4-b5b-4-centrifugo-transport.md) | `simetra/data/centrifugo`, пакування, стенд, Г7 | 3 |

Кожна частина — один PR з власним «готово». Шви: частина 1 дає форму
знімка, частину пакета й предикати без споживача в ядрі (споживач — частина
2); частина 2 дає знімок у сесії ядра й подію його заміни (споживач —
приймач частини 3); частина 3 дає порт і фабрику транспорту в опціях
рантайму (реалізація — частина 4). Старий план
`2026-11-08-p4-b5b-signal-receiver-rights-snapshot.md` видалено в PR цього
плану; посилання плану B6 переведено на цей файл.

## Мета, архітектура, спека

**Мета.** Сервер віддає знімок прав поточного користувача частиною `rights`
пакета `read` в одній транзакції з даними; клієнт має чисті предикати
«чи можу читати пару (скоуп, об'єкт)» і «чи можу підписатися на канал»,
доведені рівними правилу бази. Готово, коли: unit T0/T1/T3 і предикатів
зелені; DB-кейси знімка на обох стеках зелені; DB-еквівалентність
`canSubscribe` ≡ `signal_topic_allowed(c, false)` і `readAllowed` ≡
видимість фікстурного рядка пари зелені на обох стеках.

**Архітектура.** `simetra.rights_client_snapshot()` — одиниця T1 поряд із
функціями фактів (`compiler/rights/`), `STABLE SECURITY INVOKER` над
наявними `current_user_id()`, `rights_mine()` і `scopeSetCall` кожного виду
скоупу (`compiler/access-units.ts`). T3 виконує частину `rights` у тій самій
транзакції `REPEATABLE READ READ ONLY`, що й частини `query`
(`server/runtime.ts` `readParts`), і рахує `rightsVersion` — відбиток
знімка. Частина умовна: клієнт шле відомий `rightsVersion`, і за збігу
сервер повертає лише відбиток. Предикати — чисті функції T4 у
`data/store/` (зона ядра: лише `./`, `simetra/model`, `zod`) над знімком і
клієнтським каталогом.

**Спека.** П4-B `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`:
§3 (клієнтський каталог), §4.5 (частина `rights`), §8.3 (режим підписки),
§8.4 «Підписки», §9.1, §9.3, §12 (рядки «DB `simetra`» — знімок і
еквівалентність; бюджети), §13 рядки B5, B6. ADR-0073.

## Глобальні обмеження

- Існуючі тести `signal-topic-allowed.*`, `authorize-channels.*`,
  `rights-functions*` і тести пакета `read` лишаються зеленими без
  послаблення очікувань.
- Знімок містить лише факти поточного користувача; нової definer-поверхні
  немає (§9.1). Будь-яке відхилення — розвилка до архітекторки.
- DB-кейс «на обох стеках» — спільне тіло `*.support.ts` і два тонкі файли
  (`*.db.test.ts`, `*.supabase.db.test.ts`), як `signal-topic-allowed.*`.
- Без shims: коментар «`type: "rights"` — B5» у `model/runtime/envelope.ts`
  замінює реальна частина.

## Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Межа з B6.** B5b підписується лише на канали змін і дає `refreshTokens` як метод порту з реалізацією (частини 3–4). Тригер `refreshTokens` за сигналом прав користувача, канали `simetra-rights:`/`simetra-user:`, `signal_rights`/`signal_user_rights` — B6 (рядок B6 §13 їх уже має): до B6 сигналу прав користувача немає. **B6 розширює знімок, не дублює**: одне сховище знімка в ядрі (частина 2). **На погодження архітекторки** | §13 рядок B5: «`refreshTokens` (метод порту й реалізація; тригер за сигналом прав користувача — B6)» (задача 0) |
| Р2 | **Поля знімка B5b** — рівно `{ userId: uuid \| null, scopeSets: { scopeKind, scope }[], rights: Row[] }`, `Row` — рядок `rights_mine()` у camelCase (`level`, `levelId`, `scope`, `container`, `object`, `action`, `extent`, `dimensionId`), усі дії (B6 рахує й запис). `level` і `extent` — рядки без переліку: новий рівень не валить схему. `versions`, `projectionVersion`, `members`, `dimensionValues` додає B6, коли в них з'являється читач. Схема сувора (`strictObject`) | §9.1 — поля за блоками (задача 0) |
| Р3 | **`rightsVersion` — відбиток знімка, який рахує T3**: sha-256 (WebCrypto) канонічного JSON знімка, hex. Канонічність тримає функція: кожен масив — `ORDER BY` повного кортежу. Відбиток покриває всі поля, тож B6 його не змінює. Не версії скоупів (§9.3): ті змінюються від чужих змін прав у скоупі й не покривають проєкту без довідників прав | §6.6, §9.3 — значення `rightsVersion` (задача 0) |
| Р4 | **Частина `rights` умовна**: запит `{ type: "rights", known?: string }`, відповідь `{ rightsVersion, snapshot? }`; `snapshot` немає тоді й лише тоді, коли `known` = поточний `rightsVersion`. Сервер виконує функцію завжди (той самий оператор), заощаджує лише байти. Так такт інтервалу (§8.4) несе `rights` у межі «≤ 8 Б × рядків + 2 КіБ» §12 без `jsonBytes` знімка. Не більше однієї частини `rights` на пакет; частина `rights` входить у `READ_BATCH_MAX` і в бюджет відповіді пакета (`batch-budget`, `response-too-large`), як `query` | §4.5 — форма частини; §12 — бюджети `resume()`/такту: `jsonBytes` знімка лише коли знімок змінився; оператори бази «≤ 4 + частини `query` + цілі `include` + частина `rights`» (задача 0) |
| Р5 | **Анонім і недійсний користувач** (`sessionKind` ≠ `"user"`) — `{ userId: null, scopeSets: [], rights: [] }` без звернення до бази й без функції; так само `rightsVersion` (відбиток цього значення) | немає |
| Р6 | **Нові поля клієнтського каталогу** (одне джерело — компілятор): запис об'єкта — `publicRead?: "anon" \| "authenticated"` (з `access.publicRead`, тим самим джерелом, що `signalFacts`) і `rightsContract?: true` (об'єкт має контракт прав, тобто його читання під RLS судять рядки прав); каталог — `rightsSnapshot?: true`, коли проєкт має функції прав (`hasRightsFunctions`; тоді є й `rights_client_snapshot`, і сигнали). Без прапорця каталогу T4 не шле `rights` і не створює приймача (частини 2, 3). `snapshotHash` змінюється, `kernelHash` — ні. B6 Р1 замінить `rightsContract` контрактом `rights?` без shims | §3 — поля запису й каталогу (задача 0) |
| Р7 | **`readAllowed(snapshot, pair, entry)`** — предикат прибирання пари (скоуп, об'єкт), дзеркало безрядкової частини політики читання: об'єкт без `rightsContract` — `true` (знімок його читання не описує; таке читання свіжіє перечитуванням); `publicRead` — `true`; скоуплений — скоуп у `scopeSets` свого виду **і** хоч один рядок `action = 'read'` мітки об'єкта, що діє в цьому скоупі, будь-якого обсягу, зокрема контейнерний; нескоуплений (`ZERO_UUID`) — хоч один рядок `read` мітки об'єкта. Точне правило «рядок діє в скоупі» (рівні `global`, `everyUser`, `scope`, `container`) виконавець бере з політики читання й доводить еквівалентністю (задача 6), а не з цього речення | §8.4/§6.2 правило 4 — одне речення про предикат пари (задача 0) |
| Р8 | **`canSubscribe(snapshot, channel, catalog)`** — дзеркало режиму підписки `signal_topic_allowed` (`compiler/signal/units.ts` `subscribeCondition`): лише канал змін (`parseTopic`); `userId` `null` — `false`; невідомий чи несигнальний об'єкт, вид топіка ≠ `scopeKindId` (нескоуплений — `ZERO_UUID`) — `false`; `publicRead` — скоуплений `true`, нескоуплений — лише `ZERO_UUID`; інакше — скоуп у `scopeSets` (нескоуплений — `ZERO_UUID`) **і** рядок `read` мітки об'єкта з обсягом, який дає `rowFreeGrants` (не контейнер). Канали прав — `false` (B6) | немає |
| Р9 | **Еквівалентність — у `packages/simetra/test/db`** поряд із `signal-topic-allowed.support.ts`, на його фікстурах: тест імпортує предикати з `src`, тож нового входу `simetra/data/testing` не треба | §12 рядок DB — місце кейсу не змінює (немає) |

## Інтерфейси

| Що | Хто дає | Хто бере |
| --- | --- | --- |
| `rightsSnapshotSchema`, `type RightsSnapshot` (Р2), T0 `model/runtime/` | 1 | 2, 3, B6 |
| частина `{ type: "rights", known? }` і результат `{ rightsVersion, snapshot? }` у `ReadPart` і `wireReadPartSchema` (дискримінація значенням `type`, як `version`, рішення приймання #272); у `CorePart` ядра її вводить частина 2 | 1 | 2 |
| `CommandRuntime.rightsSnapshot(session)` (і в `readParts`) | 1 | 2 (через пакет), B6 |
| `CatalogEntry.publicRead?`, `rightsContract?`; `ClientCatalog.rightsSnapshot?` (Р6) | 1 | 2, 3, B6 |
| `readAllowed`, `canSubscribe` (`data/store/rights.ts`) | 1 | 2 (правило втрати), 3 (підписки) |

## Інваріанти безпеки

| Інваріант | Тест, що червоніє | Мутація словами |
| --- | --- | --- |
| Знімок — лише мої факти | DB: два користувачі одного скоупу з різними ролями — знімок кожного містить рівно його рядки й `userId` = `current_user_id()` | тіло читає рядки прав без фільтра поточного користувача (функція деталей усіх учасників) |
| Без нової definer-поверхні; `EXECUTE` не для `PUBLIC` і `anon` | unit дерева SQL (`SECURITY INVOKER`, `search_path = ''`, гранти) і DB: виклик під анонімною роллю — `permission denied` | `SECURITY DEFINER` чи грант анонімній ролі |
| `scopeSets` = межа тенанта бази | DB: вид із членством — непорожній; вид з дослівною функцією, що відсікає скоуп учасника, — скоупу немає | `rights_scope_set` чи `rights_my_scopes` для всіх видів замість `scopeSetCall` |
| `canSubscribe` ≡ режим підписки | еквівалентність (задача 6) | предикат пропускає лише контейнерне право; предикат без умови `scopeSets` |
| `readAllowed` ≡ видимість пари | еквівалентність (задача 6) | предикат ігнорує `scopeSets` для рядка рівня `global`/`everyUser` на скоупленому об'єкті; предикат не бачить контейнерного рядка |
| Знімок у `READ ONLY` без запису | DB: виклик у транзакції `READ ONLY` успішний | тіло пише (будь-який DML) |
| Анонім без бази | unit T3: анонім — 0 операторів | функцію кличуть і для аноніма |

## Задачі

### Задача 0. Анкори й поправки спеки

`orient --plan` на цей файл і `doc anchors` — дельти в тіло PR. Поправки
П4-B за рішеннями Р1–Р7 (стовпець «вплив»); §13 рядок B5 — частини 1–4 і
межа Р1; §14.1 рядок «`include` і переоцінка після втрати скоупу» — правило
частини 2 Р6. Без лічильників і наративу фаз.
Готово: `doc anchors && doc lint` зелені; тести `*.docs.test.ts` зелені.
Перевірка: `doc anchors && doc lint`, `run-tests unit --changed`.

### Задача 1. Поля клієнтського каталогу (Р6)

Файли: `model/runtime/catalog.ts` (`catalogEntrySchema`), T0 клієнтського
каталогу, `compiler/runtime-catalog.ts`, `compiler/client-catalog.ts`.
Готово: об'єкт з `publicRead` (обидві ролі) і без; об'єкт з контрактом прав і
без; проєкт із функціями прав і без — поля в обох каталогах точно за Р6;
`snapshotHash` змінюється, `kernelHash` — ні; `pnpm metadata:check` зелений.
Мутація: `publicRead` з іншого джерела, ніж `access.publicRead` (наприклад,
лише `anon`) — тест червоний.
Перевірка: `run-tests unit --filter client-catalog.test.ts`,
`run-tests unit --filter runtime-catalog.test.ts`.

### Задача 2. T0: схема знімка й частина `rights` (Р2, Р4)

Файли: `model/runtime/rights-snapshot.ts` (нове), `model/runtime/read.ts`
(`ReadPart`), `model/runtime/envelope.ts` (`wireReadPartSchema`, союз
результату), `model/runtime/index.ts`.
Готово: схема приймає вихід з рівнем `everyUser` і порожніми масивами,
відмовляє на зайвому полі; частина з `known` і без; результат зі `snapshot`
і без; пакет із двома частинами `rights` — відмова з `path`; частина
`rights` рахується в `READ_BATCH_MAX`.
Після: задача 0. Перевірка: `run-tests unit --filter src/model/runtime`.

### Задача 3. T1: `simetra.rights_client_snapshot()`

Файли: `compiler/rights/client-snapshot.ts` (нове) — окремий генератор за
зразком `buildSignalUnits` (`compiler/signal/units.ts`): вхід — контракти прав
разом із `contracts.access` (як `buildExplainUnits` у `compiler/pipeline.ts`),
умова `hasRightsFunctions`; ребра створення — `bodyRequires` /
`Declaration.requires` на функції фактів і функції множин, які кличе тіло;
`compiler/pipeline.ts` (виклик генератора); DB-тести
`test/db/rights-client-snapshot.support.ts` + два тонкі файли.
Тіло — за §9.1 і Р2: `current_user_id()`; `NULL` → `{ userId: null,
scopeSets: [], rights: [] }`; `scopeSets` — `scopeSetCall` кожного виду
скоупу, що має хоч один скоуплений об'єкт, один раз на вид; `rights` —
`rights_mine()`; масиви впорядковано (Р3). `EXECUTE` — роль запиту `user`
профілю й `simetra_command`, `REVOKE … FROM PUBLIC`.
Готово: unit дерева SQL — атрибути функції, гранти, `scopeSetCall` того
самого виду, що в `<t>_scope_read`, ребра `requires` на кожну викликану
функцію (мутація: без ребра — порядок створення ламається, тест червоний); проєкт без функцій прав — одиниці
немає; без довідників прав — є. DB (обидва стеки): рядки інваріантів
безпеки вище; проєкт без довідників прав працює; вихід проходить
`rightsSnapshotSchema`; повторний виклик дає той самий текст (порядок).
Після: задача 2. Перевірка: `run-tests unit --filter rights-client-snapshot.test.ts`,
`run-tests db --filter rights-client-snapshot.db.test.ts`,
`run-tests db-supabase --filter rights-client-snapshot.supabase.db.test.ts`.

### Задача 4. T3: `rightsSnapshot` і частина `rights` у `readParts` (Р3–Р5)

Файли: `server/runtime.ts` (`CommandRuntime.rightsSnapshot`, гілка частини в
`readParts`/`executeRead`), `server/read.ts` за потреби, `server/data-handler.ts`
(`slotOf`: частина `rights` іде в транзакцію, а не як `version` без бази).
Правила: частина виконується в тій самій транзакції пакета одним оператором;
`inProcess` дозволено (§4.5: лише `receipt`/`run` вимагають HTTP); вихід
функції проходить `rightsSnapshotSchema`, розбіжність — `command.internal` і
журнал; анонім — Р5; пакет лише з `rights` (без `query`) теж відкриває
транзакцію.
Готово: unit на порті-фейку — `[query, rights]`: один `BEGIN … READ ONLY`,
оператор знімка, один `COMMIT`; кількість операторів за формулою Р4;
`known` збігся — без `snapshot`, не збігся — зі `snapshot`; анонім — 0
операторів; невалідний вихід — `command.internal`; частина не вміщується в
залишок бюджету — `batch-budget`. DB (`packages/designer/src/__tests__/read-batch.db.test.ts`, стек
`postgres`; supabase-пари в нього немає, а сам знімок обидва стеки
доводить задача 3): `userId` = id користувача сесії, `inProcess` =
HTTP-конверт.
Мутації: обчислювати `rightsVersion` без канонічного порядку (два виклики з
переставленими рядками — різні відбитки, тест червоний); повертати
`snapshot` за збігу `known`.
Після: задачі 2, 3. Перевірка: `run-tests unit --filter src/server`,
`run-tests db --filter read-batch.db.test.ts`.

### Задача 5. T4: чисті предикати `readAllowed` і `canSubscribe` (Р7, Р8)

Файли: `data/store/rights.ts` (нове), unit `data/store/__tests__/rights.test.ts`.
Готово: `it.each` за кейсами режиму підписки §12 (свій скоуп з правом;
учасник без `read`; чужий скоуп; лише `own`; лише контейнер — скоуплений і
нескоуплений; нескоуплений з `own`; роль рівня скоупу на нескоупленому;
`everyUser`; глобальна роль; `publicRead` обох видів; несигнальний об'єкт
(«Користувачі»); корінь свій і чужий; вид топіка ≠ вид об'єкта; верхній
регістр; `userId: null`; канали прав) і за кейсами `readAllowed` (контейнер
— так; скоуп поза `scopeSets` при рядку `global`/`everyUser` — за правилом
політики; об'єкт без `rightsContract` — так). Модуль не імпортує нічого поза
зоною ядра.
Після: задачі 1, 2. Перевірка: `run-tests unit --filter rights.test.ts`.

### Задача 6. DB-еквівалентність предикатів (Р9)

Файли: `test/db/rights-predicates.support.ts` (нове) + `.db.test.ts` і
`.supabase.db.test.ts`; фікстури — з `signal-topic-allowed.support.ts`
(спільний помічник, а не копія).
Еталони: `canSubscribe(знімок, канал)` = `signal_topic_allowed(канал,
false)` під claims того самого користувача для кожної пари «користувач,
скоуп, сигнальний об'єкт»; `readAllowed(знімок, пара)` = «хоч один
фікстурний рядок пари видимий `SELECT` під claims користувача», де фікстури
кожної пари мають рядки, які покривають кожен обсяг (свій `own`, рядок
кожного контейнера, рядок значення виміру). Фікстури: лише контейнер; роль
рівня скоупу на нескоупленому; `everyUser` і глобальна роль на нескоупленому
й скоупленому; `deny`, що звужує обсяг; замикання графа вимог; вимір; вид з
дослівною функцією множини; «Користувачі»; чужий вид у топіку; топік
неправильної форми. Вибір скоупів для `publicRead` — поза еквівалентністю
(§12). Знімок у тесті — виклик `rights_client_snapshot()` тим самим
користувачем.
Готово: обидва стеки зелені; мутації інваріантів безпеки (рядки 4–5)
червоніють — у тілі PR.
Після: задачі 3, 5. Перевірка: `run-tests db --filter rights-predicates.db.test.ts`,
`run-tests db-supabase --filter rights-predicates.supabase.db.test.ts`.

## Задачі власника

немає

## Підсумок аудиту

Ризик: права, сигнали (предикат підписки), бюджети. Раунд 1: Sonnet «план проти спеки й коду» (0 blocker, 1 major, 1 minor) і Opus «безпека» разом із частиною 2 (до цієї частини безпекових знахідок немає; перевірено `EXECUTE`/`SECURITY INVOKER` на обох профілях, «без `rightsContract` — `true`» нешкідливе, бо без контракту й `publicRead` політики читання немає). Виправлено: генератор знімка — окремий, за зразком `buildSignalUnits`, з `contracts.access` і ребрами `requires` (major); частину `rights` у `CorePart` перенесено в частину 2 (minor). Codex (5 питань: власні факти, еквівалентність предиката, об'єкти поза контрактом, умовна частина, `readParts`) — 0 знахідок. Лишилось: 0 blocker, 0 security major.
