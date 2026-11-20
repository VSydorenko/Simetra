# П4-B6. Кеш прав клієнта й сигнали прав — план імплементації

**Статус:** чернетка на приймання архітекторкою М4 (`m4-simetra-milestone`).
Issue #115, віха М4. Блок B6 спеки П4-B, переписаний над `main` і
прийнятими планами B5b (частини 1–4); рішення B5b цитуються як «1-Р<n>»…«4-Р<n>».

- **Анкори.** Частина A — після B5b-1 (схема знімка, генератор
  `rights_client_snapshot`, поля каталогу `publicRead`, `rightsContract`,
  `rightsSnapshot`, предикати `readAllowed`/`canSubscribe` у
  `data/store/rights.ts`, еквівалентність `test/db/rights-predicates.*`).
  Частина B — після B5b-2 (знімок у ядрі, `requestRights`, бар'єр пари в
  `Epochs`, подія заміни), B5b-3 (`store/receiver.ts`, хвиля приєднання,
  фейковий канал) і B5b-4 (`simetra/data/centrifugo`, стенд
  `packages/designer/src/__tests__/signal-receiver.*`). Решта — `main`.
  **Перед стартом кожної частини:** `orient --plan <цей файл>`; розійшлося
  ім'я — виправ у плані за кодом; розійшлася поведінка — до архітекторки.
- **Межі серії.** `src/compiler/sql/**` план не чіпає (там #275 → #297 → Д2).
  `src/data/**` — лише після приземлення B5b-4. Звір таблицю сесій у
  спільному брифі архітекторки М4.
- **Спільні ресурси.** Стеки `postgres` і `supabase` спільні: не зупиняти, не
  чистити чужих об'єктів. Нових ролей і розширень план не додає. Стенд
  Centrifugo — власний контейнер прогону з тегом.
- **Лише CI.** Повні `unit`, `db`, `db-supabase`, `e2e`, `packaging` — CI на
  draft PR. Задачі закінчуються цільовими `run-tests … --filter <файл>` чи
  `--changed`; жодна задача не закінчується повним локальним прогоном.

## Мета, архітектура, спека

**Мета.** Клієнт рахує `can(action, object, { scope?, row? })` →
`true | false | "unknown"` за контрактом прав із клієнтського каталогу й
знімком B5b; звуження обсягу `read` ховає чи прибирає рядки негайно; зміна
прав доходить до клієнта сигналом за секунди, а не за інтервалом свіжості
чи строком токена. Готово (рядок B6 §13): DB-еквівалентність обчислювача з
ядром, unit кешу прав і гейт доставки сигналів прав на стенді зелені.

**Архітектура.**
- **T1.** Компілятор кладе контракт прав об'єкта в клієнтський каталог
  (замість `rightsContract?: true`, 1-Р6). Знімок B5b дістає мої id
  учасника й значення вимірів. Нові `signal_rights` і `signal_user_rights`
  пишуть рядок outbox від власника; кличуть їх тригери прав
  (`guard-units.ts`), не `rights_bump`. `signal_topic_allowed` у режимі
  підписки відкриває канали прав.
- **T4.** Обчислювач — чистий модуль зони ядра поряд із `readAllowed`
  (`data/store/rights.ts`), над одним сховищем знімка (2-Р4). Звуження на
  заміні знімка — `can(read, row)` над підтвердженими ключами; читання в
  польоті судить той самий бар'єр `Epochs`, що й втрату пари (2-Р4). Приймач
  B5b-3 підписується на канали прав і реагує за §9.3.
- **T4 React.** `useCan` — поряд із `useRows`/`useRow` у `src/data/react`.

**Спека.** П4-B `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`:
§3, §6.2 правило 4, §6.5, §8.1–§8.4, §8.6, §9, §12 (рядки «unit T1», «unit T4
(кеш прав)», «unit T4 (публічний API)», «DB `simetra`», «стенд сигналу»),
§13 рядок B6, §14.3 (рядки B6). Спека прав
`2026-10-17-rights-design.md` Рх15, §6.3; профіль `postgres` §6 (межа
відкликання 5 хв 30 с). Тести — скіл `writing-tests`.

## Глобальні обмеження

- **Одне сховище знімка** (1-Р1, 2-Р4). Обчислювач, предикати підписки,
  звуження й бар'єр читають знімок лише через стан сесії B5b-2; другого кешу
  немає.
- Обчислювач — не захист (§9.2): база — бар'єр. Помилка `can` дає зайву чи
  сховану кнопку; помилка звуження не сміє показати значення, яких база вже
  не дає.
- Запис у сховище — лише `commit(fn, token)`; старий токен, `dispose()`,
  `session-changed` — 0 записів, 0 запитів, 0 таймерів. Таймери — лише ядра
  (`schedulerDue`, `session.sleep`).
- Без shims: `rightsContract?: true` (1-Р6), звуження «до B6» (2-Р5), гілка
  «канали прав — `false`» у `canSubscribe` (1-Р8) зникають у тій самій зміні.
- Наявні тести `signal-topic-allowed.*`, `authorize-channels.*`,
  `rights-guards*`, `rights-predicates.*`, приймача й моделі — без
  послаблення; лічильник запитів чи байтів отримує нову частину явно в
  очікуванні, рядком у тілі PR. Послаблення оракула — розвилка.

## Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Контракт прав у каталозі**: `catalogEntrySchema.rights?` замінює `rightsContract?: true`. Поля: `actions: { action, extents: ("any" \| "own" \| { dimension })[] }[]`; `ownership: { carrier, owner: "user" \| { membership: scopeKindId } }[]`; `access: { dimension, carrier, fresh, subject: "user" \| "membership" }[]`; `binding?: { container, carrier }`; `readBoundary: "tenant" \| "users" \| "none"` (з `readBoundaries`); `root?: { author?: carrier }`; `scopeSet: "membership" \| "verbatim"` для скоупленого (`AccessContract.scope.verbatim`). `carrier` — `{ attribute: <логічне ім'я> } \| { key: true }` (за `carrierColumn`; колонка ні серед атрибутів, ні ключем — помилка компілятора). `fresh` — зв'язок `values.relation` невідомого `KIND_REGISTRY` виду (є тригер зв'язку); функція виміру чи прийнята `CustomTable` — `false`. Граф вимог і `deny` уже розгорнуто в рядках знімка. `snapshotHash` змінюється, `kernelHash` — ні. `publicRead` лишається полем 1-Р6 | §3, §9.2 (задача 0) |
| Р2 | **Знімок розширюється, не дублюється**: до полів 1-Р2 додано `members: { scopeKind, scope, member }[]` (`rights_my_scopes()`) і `dimensionValues: { dimension, values }[]` (`rights_dimension_values` на кожен вимір контрактів). **`versions` і `projectionVersion` у знімок не входять**: `rightsVersion` (1-Р3) покриває кожне поле, а версії скоупів змінюються від чужих змін прав у скоупі й змушували б повертати знімок без зміни моїх фактів. Ознака свіжості — поле каталогу `rightsSignals?: true` (проєкт має довідники прав, тож і тригери сигналів прав) | §9.1 — поля; §9.3 — ключ кешу = `rightsVersion` (задача 0). **На погодження** |
| Р3 | **Гілки `can` — дзеркало `rightsPredicates`** (`compiler/rights/predicates.ts`): гілка на кожен обсяг дії × носій. Скоуплений об'єкт — рядок `level = 'scope'` зі `scope` рядка (як `rights_any/own/dim`); глобальні й `everyUser` рядки скоупленого не відкривають; нескоуплений — будь-який рівень, крім `container` (як `has_right`); контейнерна гілка — рядок `level = 'container'` з тим самим внутрішнім обсягом і `container` = носій прив'язки, плюс умова обсягу (як `inContainer`). `own` — носій = `userId` чи ∈ моїх `member` виду; вимір — носій ∈ `dimensionValues`. `create` кореня — гілка `rootCreatePredicates`: грант будь-якого рівня, крім контейнера, без скоупу; `own` — лише автор | §9.2 (задача 0) |
| Р4 | **Тризначна композиція (Кліні)**: результат = межі ∧ (∨ гілок). Межі: тенант — скоуп ∈ `scopeSets` виду, поза ним `false`, для `scopeSet: "verbatim"` — `unknown` (§14.3); `users` — для `read` власний рядок `true`, решта `unknown`; `publicRead` знімає межу тенанта для `read` дійсного користувача (§14.3). `unknown` у гілці: вимір з `fresh: false`; відсутній носій у рядку; каталог без `rightsSignals` — гілки й межі, що залежать від членства. Об'єкт без контракту — `unknown`. Без рядка — межі ∧ (∨ гілок без умов носіїв) | §9.2, §14.3 (задача 0) |
| Р5 | **Пара лишається булевою**: прибирання пари — `readAllowed` B5b (1-Р7, еквівалентність доведена). `unknown` дослівного виду — лише у `can`/`useCan`; звуження (Р6) судить лише ключі пар, що лишились дозволеними | §14.3 — «для `can`» (задача 0) |
| Р6 | **Звуження обсягу `read`** замінює 2-Р5. На заміні знімка ядро в тому самому `commit`, що й прохід пар 2-Р4, для кожного об'єкта, чиї входи **втратили** елемент (рядок `read` його мітки, `member` його виду, значення його виміру, скоуп `scopeSets` його виду), рахує `can(read, object, { scope, row })` кожного підтвердженого ключа (власні сторінки, знімки показу вікна, цілі `include`): `false` — `Writer.purge(object, { keys })` (надгробок ключа, чернетку скинуто); `unknown` — `Writer.hide(object, keys)` (є на `main`: `stale.hidden`, `RowView.hidden`, `revalidateHolders` після `commit`, зокрема невидимі вигляди й підмножини `include`), запис журналу `rights-hidden` без ключів. Додавання елемента звужувати не може (∨ і межі монотонні), тож прохід пропускається. Ключ без значень рядка (частковий запис) рахується з рядком без носіїв — `unknown` | §6.2 правило 4 — «до B6» прибрати, прохід лише на втраті (задача 0) |
| Р7 | **Читання в польоті — той самий бар'єр `Epochs`** (2-Р4), одна функція, яку питають обидва сховища: вхід — надгробок пари (B5b) і вердикт рядка (B6). Заміна знімка зі звуженням ставить об'єкту `narrowedAt = appliedEpoch`; рядок читання з `readEpoch < narrowedAt` судиться `can(read, row)` за поточним знімком: `false` — новий ключ відкинуто, наявний сховано (`stale.hidden`) і поставлено в хвіст перечитування; `unknown` — записано схованим. Рядки ТЧ такого читання пишуться лише коли шапка власника видима. Другої перевірки в `object-store.ts`/`section-store.ts` немає | §6.2 правило 4 — одне речення (задача 0) |
| Р8 | **`signal_rights(p_scope_kind uuid, p_scope uuid)`** і **`signal_user_rights(p_user uuid)`** — `plpgsql VOLATILE SECURITY INVOKER SET search_path = ''`, `EXECUTE` нікому, `REVOKE … FROM PUBLIC`. Кличе їх лише definer-тригер прав від власника (`row_security = off`, outbox без `FORCE`), тож `signal_payload_allowed` рядок не судить: **форму перевіряє сама функція** до `INSERT` — аргументи не `NULL`, вид і скоуп обидва нульові чи обидва ненульові, користувач ≠ `ZERO_UUID`; інакше `RAISE` з `22023`. `data` рівно `{ op: "rights" }` (`id` ставить штамп outbox); `rightsSignalSchema` T0 втрачає `row_ver` — клієнт версій не порівнює (Р2). Режим злиття їх не гасить | §8.1, §8.2 (задача 0). **На погодження** |
| Р9 | **Хто шле й куди** (тригери `guard-units.ts`, одна подія — один `DISTINCT` набір на оператор, старі й нові рядки `UPDATE`/`DELETE`): зміна **визначення** ролі чи дельти рівня скоупу — `signal_rights` скоупу; глобального рівня (зокрема `everyUser`) — глобальний канал. **Призначення** — `signal_user_rights` кожного зачепленого користувача (рівень скоупу — `subject` → користувач через довідник членства; глобальний — `subject`), каналу скоупу не шле: змінюються лише факти суб'єкта. **Членство** — `signal_user_rights` за `userColumn … IS NOT NULL` (запрошення й самоприйняття легальні). **Зв'язок** — `signal_user_rights` суб'єкта зв'язку (користувач чи через членство). **«Користувачі»** на `invalid`/`user_kind` — сам рядок. Глобальний канал зв'язки й «Користувачі» не чіпають. Тригер сигналу членства стоїть на кожному довіднику членства проєкту з довідниками прав, зокрема виду без довідника прав рівня скоупу (зараз там тригера немає: лише сигнал, без `rights_bump`). `rights_bump` не змінюється. Без довідників прав сигналів прав немає — свіжість за інтервалом (§8.6) | §8.2, спека прав Рх15 (задача 0). **На погодження** |
| Р10 | **Режим підписки `signal_topic_allowed`** — спершу `current_user_id() IS NOT NULL`; `simetra-rights:<вид>:<скоуп>` — вид є видом скоупу моделі й скоуп ∈ `scopeSetCall(вид)`; `simetra-rights:<нуль>:<нуль>` — дійсний користувач; змішані нулі — `false`; `simetra-user:<id>` — `id = current_user_id()`. Режим відправки обох префіксів — `false`; `signal_payload_allowed` з `op: "rights"` — `false` | §8.3 (задача 0) |
| Р11 | **Підписки приймача** (3-Р4) — лише з `rightsSignals`: канал прав кожного скоупу `scopeSets`, глобальний і `simetra-user:<userId>`. `canSubscribe` (1-Р8) отримує гілки каналів прав — дзеркало Р10; перерахунок — тією самою дельтою на заміні знімка | §8.4 (задача 0) |
| Р12 | **Реакція** (§9.3). Сигнал каналу прав скоупу чи глобального — строк `requestRights()` (з `known`) через `random() × RIGHTS_JITTER_MS` (2000), доданком `schedulerDue` ядра, як хвиля 3-Р10: сигнали вікна злито, прихована вкладка чекає `resume()`. Сигнал каналу користувача — `requestRights()` і `refreshTokens()` одразу й на прихованій вкладці (втрата доступу прибирає пам'ять незалежно від видимості, §6.5), далі не частіше `REFRESH_MIN_MS` (5000) з одним хвостом на `session.sleep`. Нерозібране повідомлення каналу прав — як сигнал без даних. Відмова `auth`: канал прав скоупу — `purge({ scope })` кожного об'єкта виду й `requestRights()`; глобальний чи канал користувача — `requestVersion()` і `requestRights()` | §8.4 (задача 0) |
| Р13 | **`refreshTokens` без зайвого перечитування.** Заміна підписки 4-Р3 дає `onSubscribed(recovered: false)` → хвиля приєднання (3-Р10) на кожен сигнал користувача. B6 передає новій підписці `since` — останню позицію потоку старої (`offset`, `epoch` з `subscribed`/публікацій); SDK 5.8.0 тоді просить відновлення (`_setOptions`: `since` → `_recover = true`, `build/index.js`), і за історії маємо `recovered: true` — 0 перечитувань. Змінює `src/data/centrifugo` B5b-4. **На погодження** (міжблокове) | немає |
| Р14 | **`useCan(action, object, opts?) : boolean \| "unknown"`** у `src/data/react`: `useSyncExternalStore` над публічним читачем рантайму (`DataRuntime.can`, `onRightsChange` — над подією заміни B5b-2). Хост показує `unknown` доступним (§9.2). Функціональних опцій хук не рахує (П4-E) | немає |

## Інтерфейси

| Що | Хто дає | Хто бере |
| --- | --- | --- |
| `CatalogEntry.rights?`, `ClientCatalog.rightsSignals?` (Р1, Р2) | B6-A | T4, D5 #122 (нічого не міняє) |
| поля знімка `members`, `dimensionValues` | B6-A | T4 |
| `signal_rights`, `signal_user_rights`, гілки прав `signal_topic_allowed` | B6-A | стенд, `authorizeChannels` (без змін коду) |
| `can` (`data/store/rights.ts`), `DataRuntime.can`/`onRightsChange`, `useCan` | B6-B | host, T5, D5, e2e #263 |
| знімок сесії, подія заміни, бар'єр `Epochs`, `requestRights` | B5b-2 | B6-B |
| `SignalTransport.refreshTokens`, фейковий канал, хвиля приєднання | B5b-3 | B6-B |
| `createCentrifugoTransport` | B5b-4 | B6-B (`since`, Р13) |

## Інваріанти безпеки

Кожен рядок — тест виконавця й навмисна мутація на закоміченому дереві
(відкат зворотним патчем після червоного прогону). Кожен бар'єр судиться
окремо, щоб другий не маскував мутацію першого. Мутація без червоного тесту
— дефект плану, до архітекторки.

| Інваріант | Тест (рівень) | Мутація словами |
| --- | --- | --- |
| І1. Підробити сигнал прав може лише власник | DB обох стеків: `EXECUTE` на `signal_rights`/`signal_user_rights` — `false` для `simetra_command`, `simetra_signals`, кожної ролі API; під `simetra_command` прямий `INSERT` рядка каналу прав в outbox — відмова політики | `GRANT EXECUTE … TO simetra_command`; режим відправки пропускає канал прав |
| І2. Форма рядка — у функції | DB: кожен недійсний аргумент Р8 — `22023` і 0 рядків outbox; дійсний — `data` рівно `{ id, op }` | прибрати кожну перевірку Р8 окремо |
| І3. Зміна прав — у правильний канал | DB під `simetra_command`: роль скоупу → канал скоупу; глобальна роль → глобальний; призначення й переміщення призначення між скоупами → обидва користувачі, 0 рядків каналу скоупу; членство (зокрема виду без довідника прав скоупу) і деактивація → канал користувача; запрошення без користувача — успіх; зв'язок без скоупу → канал суб'єкта, 0 глобальних; `ROLLBACK` — 0 рядків; видалення учасника разом із призначеннями одним оператором — сигнал користувачу | тригер членства без `signal_user_rights` чи без `IS NOT NULL`; призначення шле в канал скоупу; зв'язок шле в глобальний |
| І4. Канал прав — лише своєму | DB обох стеків: свій скоуп так, чужий ні; дослівна функція, що відсікає скоуп, — ні; деактивований користувач — ні (зокрема з дослівною функцією, що включає скоуп); глобальний — лише дійсний; канал користувача — лише свій; змішані нулі — ні; `authorizeChannels` відсіює чужі | гілка користувача без `= current_user_id()`; гілка скоупу без `scopeSetCall`; гілка без перевірки дійсного користувача |
| І5. `canSubscribe` каналів прав ≡ база | DB-еквівалентність (розширення `rights-predicates.*`): кожна пара «користувач, канал прав» | предикат пропускає скоуп поза `scopeSets` |
| І6. `can` ≡ ядро | DB обох стеків: дії запису — `true`/`false` ≡ успіх/`no-right` команди в транзакції з `ROLLBACK`; `read` — видимість `SELECT` під claims; без рядка — існування фікстурного рядка з успіхом. Фікстури: `any`, `own` (користувач і членство), вимір з оголошеним зв'язком, контейнер з `any` і з `own`, `deny`, `fullAccess`, глобальна роль і `everyUser` на скоупленому й нескоупленому, `publicRead`, `create` кореня, дія з переходом, носій-ключ, дослівна функція, що відсікає скоуп, «Користувачі» поза моїми скоупами. `unknown` не судиться, але для `fresh: true` з `rightsSignals` не з'являється | глобальний рядок відкриває скоуплений; контейнер без внутрішнього обсягу; межа як `∨`, а не `∧` |
| І7. Втрата `read` ховає негайно | unit T4: звуження → `false` — `purge` ключа в усіх власниках і чернетці `card`; `unknown` — значення сховано в тому самому `commit`, `revalidate` усіх виглядів ключа, збій перечитування лишає сховано; `unknown` → `removed` — чернетку скинуто; поки сховано — `RowView.hidden`, мутації журналу без значень | `unknown` без `hide`; частковий запис формою «без рядка» |
| І8. Читання з польоту не відкриває звуженого | unit T4 і модель: сторінка стартувала до звуження `any` → `own`, осіла після — чужі рядки не видимі; наявний ключ v5 (`owner` = я), читання з польоту дає v6 (`owner` = інший) — v5 сховано й перечитано; ТЧ з такого читання при схованій шапці не пишеться; читання, почате після застосування, пишеться | `put` з польоту без вердикту; `false` для наявного ключа лише відкидає рядок; бар'єр рядка у сховищі окремо від `Epochs` |
| І9. Одне джерело знімка | unit T4: заміна знімка змінює відповідь `can` і `useCan` без іншого кешу | другий кеш у модулі обчислювача |
| І10. Сигнал користувача закриває канал | unit T4 (фейковий канал): сигнал `simetra-user:` → `refreshTokens()` у тій самій мікрозадачі, зокрема на прихованій вкладці; канал з `refused` → `auth` → `purge` пари; 20 сигналів за 5 с — 2 виклики `refreshTokens` і 2 `rights` | реакція без `refreshTokens`; без межі частоти |
| І11. Старе покоління нічого не робить | unit T4 і модель: сигнал прав і відповідь `rights` після `dispose()`/`session-changed` — 0 записів; строк джитера й хвіст `refreshTokens` — 0 викликів транспорту, 0 таймерів | таймер без перевірки токена |

## Задачі

### Задача 0. Анкори й поправки спек

`orient --plan` і `doc anchors` на цей файл — дельти в тіло PR. Поправки за
стовпцем «вплив»: П4-B §3, §6.2 правило 4 (Р6, Р7; «до B6» прибрати), §8.1–§8.4
(Р8–Р12), §9.1–§9.3 (Р1–Р4), §12 рядок «unit T4 (кеш прав)» (ключ кешу —
`rightsVersion`), §14.3 (рядки B6 закрито), Додаток А (рядки B6); спека прав
Рх15 (сигнал шле тригер, не `rights_bump`), §6.3; спека системної схеми §3.
§8.6 — у задачі 7 після виміру. Без лічильників і наративу.
Готово: `doc anchors && doc lint` зелені; `*.docs.test.ts` зелені.
Перевірка: `doc anchors && doc lint`, `run-tests unit --changed`.

## Частина A — база й каталог (після B5b-1)

### Задача 1. Контракт прав у каталозі (Р1, Р2)

Файли: `model/runtime/catalog.ts`, `compiler/runtime-catalog.ts`
(`runtimeObject`), `compiler/client-catalog.ts` (`entryOf`); джерело —
`RightsContract`, `AccessContract` (`compiler/contracts.ts`),
`readBoundaries`, `scopeSetCall` (`access-units.ts`), `carrierColumn`
(`rights/predicates.ts`).
Готово: unit T0 і T1 — схема сувора; контракт для `any`/`own`/виміру/
контейнера/кореня/межі `users`/носія-ключа; `fresh: false` для функції
виміру й прийнятої `CustomTable`; `scopeSet` дослівного виду; носій поза
атрибутами й ключем — помилка компілятора; `rightsSignals` лише з
довідниками прав; `rightsContract` зник (`grep` — 0); `snapshotHash`
змінюється, `kernelHash` — ні; `pnpm metadata:check` зелений.
Перевірка: `run-tests unit --filter client-catalog.test.ts`,
`run-tests unit --filter runtime-catalog.test.ts`.

### Задача 2. Поля знімка `members`, `dimensionValues` (Р2)

Файли: генератор `rights_client_snapshot` (B5b-1, `compiler/rights/`),
`model/runtime/rights-snapshot.ts`, DB-тест знімка B5b-1.
Готово: DB обох стеків — поля лише мої; функція лишається `SECURITY
INVOKER` без нової definer-поверхні; вихід проходить схему; масиви
впорядковано (відбиток 1-Р3 стабільний).
Після: задача 1. Перевірка: `run-tests unit --filter rights-client-snapshot.test.ts`,
`run-tests db --filter rights-client-snapshot.db.test.ts`,
`run-tests db-supabase --filter rights-client-snapshot.supabase.db.test.ts`.

### Задача 3. `signal_rights`, `signal_user_rights` і тригери (Р8, Р9)

Файли: `compiler/signal/units.ts` (функції), `compiler/rights/guard-units.ts`
(виклики в `catalogBody`, `memberEventBody`, `usersEventBody`, тригер зв'язку;
тригер сигналу членства виду без довідника прав скоупу),
`model/runtime/signal.ts` (`rightsSignalSchema` без `row_ver`), DB-тести
`test/db/rights-signals.support.ts` + два тонкі файли.
Готово: unit T1 (дерево SQL: `SECURITY INVOKER`, без `EXECUTE`, виклики в
тригерах, тригера сигналу немає без довідників прав) і DB обох стеків — І1,
І2, І3; масове членство (1 000 рядків одним оператором) — один сигнал на
користувача; додавання учасника в новий скоуп — сигнал у його канал
користувача.
Після: задача 0. Перевірка: `run-tests unit --filter signal-units.test.ts`,
`run-tests unit --filter rights-guards.test.ts`,
`run-tests db --filter rights-signals.db.test.ts`,
`run-tests db-supabase --filter rights-signals.supabase.db.test.ts`.

### Задача 4. Канали прав у `signal_topic_allowed` (Р10)

Файли: `compiler/signal/units.ts` (розбір `simetra-rights:`/`simetra-user:`
поряд із `CHANGES_TOPIC`), `test/db/signal-topic-allowed.support.ts`.
Готово: І4 на обох стеках; `authorizeChannels` видає канали прав лише за
Р10 (`packages/designer/src/__tests__/authorize-channels.*`).
Після: задача 3. Перевірка: `run-tests db --filter signal-topic-allowed.db.test.ts`,
`run-tests db-supabase --filter signal-topic-allowed.supabase.db.test.ts`,
`run-tests db --filter authorize-channels.db.test.ts`.

**Готово — частина A:** цільові прогони задач 1–4 зелені; CI draft PR
зелений (повні рівні, `metadata:check`).

## Частина B — клієнт (після B5b-2, B5b-3, B5b-4)

### Задача 5. Обчислювач `can` і еквівалентність (Р3, Р4)

Файли: `data/store/rights.ts` (`can` поряд із `readAllowed`), unit
`data/store/__tests__/rights.test.ts`, DB `test/db/rights-evaluator.support.ts`
+ два тонкі файли (тест імпортує з `src`, як 1-Р9).
Готово: unit рядка §12 «кеш прав» (однозначні відповіді `own`, виміру з
оголошеним зв'язком, контейнера; `unknown` за Р4; композиція Кліні;
`publicRead`; дослівний вид поза `scopeSets` — `unknown`); І6 на обох
стеках. Модуль не імпортує нічого поза зоною ядра.
Перевірка: `run-tests unit --filter rights.test.ts`,
`run-tests db --filter rights-evaluator.db.test.ts`,
`run-tests db-supabase --filter rights-evaluator.supabase.db.test.ts`.

### Задача 6. Звуження й бар'єр рядка (Р6, Р7)

Файли: стан знімка B5b-2 (`store/core.ts` чи `store/rights-state.ts`) —
прохід звуження замість 2-Р5; `store/epoch.ts` — вердикт рядка в бар'єрі
2-Р4; `store/types.ts` (`CoreLogEntry` `rights-hidden`); тест
`store/__tests__/rights-replace.test.ts` (B5b-2); модельний тест — кроки
«заміна зі звуженням» і «читання в польоті під час звуження».
Готово: І7, І8; без втрати входів — 0 викликів `can`, 0 запитів, 0 записів;
звуження одного об'єкта не рахує інших (лічильник викликів); `hide` + 
`revalidate` N ключів одного об'єкта — 1 запит (`countingTransport`);
модельний тест зелений з новими кроками, еталон — незалежна проста функція.
Після: задача 5. Перевірка: `run-tests unit --filter rights-replace.test.ts`,
`run-tests unit --filter model.test.ts`.

### Задача 7. Приймач: канали прав, реакція, `since`, стенд (Р11–Р13)

Файли: `data/store/rights.ts` (`canSubscribe` — гілки прав),
`store/receiver.ts` (підписки, сталі `RIGHTS_JITTER_MS`, `REFRESH_MIN_MS`,
реакція, відмови), `store/core.ts` (доданок строку прав у `schedulerDue`),
`src/data/centrifugo/index.ts` (`since` у заміні підписки), тести
`store/__tests__/receiver-rights.test.ts`, `data/centrifugo/__tests__/centrifugo.test.ts`;
еквівалентність `test/db/rights-predicates.*` (І5); стенд
`packages/designer/src/__tests__/signal-receiver.*`; спека §8.6 — число виміру.
Готово: unit з фейковим каналом — підписки Р11 (без `rightsSignals` —
жодного каналу прав); сигнал скоупу — 1 запит `rights` на вікно джитера,
шторм 1 000 сигналів — 1; прихована вкладка — 0 до `resume()`; відмови Р12;
І10, І11; unit транспорту — `refreshTokens` передає `since` останньої позиції
(мутація: без `since` — тест червоний); стенд обох профілів — гейт доставки
сигналів прав скоупу й користувача (§12 «стенд сигналу»), після
`refreshTokens` з історією — `recovered: true` і 0 перечитувань виглядів;
видалення членства при живій підписці — канал закрито й пару прибрано за
секунди (число — у §8.6).
Після: задача 6. Перевірка: `run-tests unit --filter receiver-rights.test.ts`,
`run-tests unit --filter centrifugo.test.ts`,
`run-tests db --filter rights-predicates.db.test.ts`,
`run-tests db-supabase --filter rights-predicates.supabase.db.test.ts`,
`run-tests db --filter signal-receiver.db.test.ts`,
`run-tests db-supabase --filter signal-receiver.supabase.db.test.ts`.

### Задача 8. `useCan` і документація

Файли: `src/data/react/use-can.ts` (нове), `data/react/index.ts`,
`data/runtime/runtime.ts` (`can`, `onRightsChange`), тест jsdom
`data/react/__tests__/hooks.test.ts`; скіл споживача
`packages/designer/skills/simetra-metadata/` — `useCan` і `unknown`
(англійською); пак-тест — новий експорт.
Готово: перерендер на заміні знімка, що змінила відповідь; 0 рендерів без
зміни відповіді; `getServerSnapshot === getSnapshot`; таблиця «інваріант →
мутація → червоний тест» у тілі PR.
Після: задача 5. Перевірка: `run-tests unit --filter hooks.test.ts`,
`doc anchors && doc lint`.

**Готово — частина B:** цільові прогони зелені; CI draft PR зелений (повні
рівні, `packaging`); фінальне рев'ю — Opus з лінзою `data-layer` і Codex-рев'ю
коду (зона бар'єра 2-Р4 давала знахідки в кожному раунді B5b).

## Review Focus

1. **Кількість каналів** = |`scopeSets`| + 2 на вкладку, кожен — токен
   каналу через host (4-Р1). Межа `AUTHORIZE_CHANNELS_MAX` (256) — на виклик,
   транспорт B5b-4 просить по каналу; виконавець звіряє, що проєкт із
   сотнями скоупів не впирається в неї.
2. **Шторм сигналів прав** — один оператор, що зачіпає багато скоупів чи
   користувачів, дає кожному клієнту ≤ 1 `rights` на вікно джитера (скоуп)
   чи на `REFRESH_MIN_MS` (користувач).
3. **Прихована вкладка** читає лише за сигналом користувача (Р12): ≤ 1
   запит на 5 с, і лише за зміною моїх фактів.

## Задачі власника

немає

## Підсумок аудиту

(заповнює авторка після аудиту)
