# П4-B6, частина 1. Права в базі й каталозі: контракт, знімок, сигнали прав — план імплементації

**Статус:** чернетка на приймання архітекторкою М4 (`m4-simetra-milestone`).
Issue #115, віха М4. Блок B6 спеки П4-B, переписаний над `main` і прийнятими
планами B5b; рішення B5b цитуються як «1-Р<n>»…«4-Р<n>».

- **Анкори після B5b-1:** схема знімка, генератор `rights_client_snapshot`,
  поля каталогу `publicRead`, `rightsContract`, `rightsSnapshot`, предикати
  `readAllowed`/`canSubscribe` (`data/store/rights.ts`). Решта — `main`.
- **Межі серії.** `src/compiler/sql/**` план не чіпає (там #275 → #297 → Д2).
  Звір таблицю сесій у спільному брифі архітекторки М4.
- **Спільні ресурси.** Стеки `postgres` і `supabase` спільні: не зупиняти, не
  чистити чужих об'єктів. Нових ролей і розширень план не додає.
- **Лише CI.** Повні `unit`, `db`, `db-supabase`, `e2e`, `packaging` — CI на
  draft PR. Задачі закінчуються цільовими `run-tests … --filter <файл>` чи
  `--changed`; жодна задача не закінчується повним локальним прогоном.
- **Перед стартом:** `orient --plan <цей файл>`; розійшлося ім'я — виправ у
  плані за кодом; розійшлася поведінка — до архітекторки.

## Серія B6: частини й шви

| Частина | Файл | Зміст | Після |
| --- | --- | --- | --- |
| 1 | [частина 1](2026-11-20-p4-b6-1-rights-db-catalog.md) | контракт прав у каталозі, поля знімка, `adoptedFacts`; `signal_rights`/`signal_user_rights` і генератор тригерів сигналу; канали прав у `signal_topic_allowed` | B5b-1 |
| 2 | [частина 2](2026-11-20-p4-b6-2-rights-client.md) | обчислювач `can` і еквівалентність; звуження й шлюз `admit`; приймач: канали прав, реакція, `since`, стенд; `useCan` | 1, B5b-2, B5b-3, B5b-4 |

Кожна частина — один PR з власним «готово». Шов: частина 1 дає форму
каталогу, знімка й сигналів без споживача на клієнті; частина 2 — їхнього
споживача. Нумерація рішень наскрізна: Р1, Р2, Р8–Р10 — тут, решта — у частині 2. Рішення Р2, Р8, Р9 (варіант А:
`adoptedFacts`), Р12, Р13 затверджено архітекторкою.

## Мета, архітектура, спека

**Мета.** Компілятор кладе контракт прав у клієнтський каталог і розширює
знімок B5b; зміна прав пише рядок outbox у канал прав скоупу чи користувача;
канал прав відкривається лише своєму. Готово: unit T0/T1, DB-кейси сигналів
прав і режиму підписки на обох стеках зелені.

**Архітектура.** Контракт — нове поле запису каталогу замість
`rightsContract?: true` (1-Р6). Сигнали прав шле один новий генератор
AFTER-тригерів над модельними таблицями фактів (Р9) через функції Р8 від
власника; `guard-units.ts` сигналів не шле. `signal_topic_allowed` дістає
гілки каналів прав (Р10).

**Спека.** П4-B `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`:
§3, §8.1–§8.3, §8.6, §9.1, §12 (рядок «unit T1»), §13 рядок B6, §14.3; спека
прав `2026-10-17-rights-design.md` Рх15, §4.7; спека системної схеми §3.
Тести — скіл `writing-tests`.

## Глобальні обмеження

- Наявні тести `signal-topic-allowed.*`, `authorize-channels.*`,
  `rights-guards*`, `rights-predicates.*` — без послаблення. Послаблення
  оракула — розвилка.
- Без shims: `rightsContract?: true` (1-Р6) і гілка «канали прав — `false`»
  зникають у тій самій зміні.

## Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Контракт прав у каталозі**: `catalogEntrySchema.rights?` замінює `rightsContract?: true`. Поля — з `RightsContract`/`AccessContract` (`compiler/contracts.ts`): `actions` з обсягами (`any`, `own`, вимір), `ownership` (носій, власник — користувач чи членство виду), `access` (вимір, носій, `fresh`, суб'єкт), `binding?` (контейнер, носій), `readBoundary` (`readBoundaries`), `root?` (носій автора), `scopeSet: "membership" \| "verbatim"`. `carrier` — `{ attribute: <логічне ім'я> } \| { key: true }` (за `carrierColumn`; колонка ні серед атрибутів, ні ключем — помилка компілятора). `fresh` — зв'язок `values.relation` невідомого `KIND_REGISTRY` виду (є тригер зв'язку); функція виміру чи прийнята `CustomTable` — `false`. `snapshotHash` змінюється, `kernelHash` — ні | §3, §9.2 (задача 0) |
| Р2 | **Знімок розширюється, не дублюється**: до полів 1-Р2 додано `members: { scopeKind, scope, member }[]` (`rights_my_scopes()`) і `dimensionValues: { dimension, values, truncated?, digest? }[]` (`rights_dimension_values` на кожен вимір контрактів; понад `RIGHTS_DIMENSION_VALUES_MAX` = 1 000 значень виміру — перші за порядком, `truncated: true` і `digest` — sha-256 повного впорядкованого набору, тож зміна будь-якого значення за межею змінює `rightsVersion`; гілка такого виміру — `unknown`, а зміна `digest` для Р6 — втрата: знімок повертається цілим на кожну зміну, тож його розмір має межу). **`versions` і `projectionVersion` у знімок не входять**: версії скоупів змінюються від чужих змін прав і змушували б повертати знімок без зміни моїх фактів; ключ кешу — `rightsVersion` (1-Р3). Окремої ознаки свіжості немає: сигнали прав є в кожному проєкті з функціями прав (Р9), тобто з `rightsSnapshot` (1-Р6) | §9.1 — поля; §9.3 — ключ кешу = `rightsVersion` (задача 0). **На погодження** |
| Р8 | **`signal_rights(p_scope_kind uuid, p_scope uuid)`** і **`signal_user_rights(p_user uuid)`** — `plpgsql VOLATILE SECURITY INVOKER SET search_path = ''`, `EXECUTE` нікому, `REVOKE … FROM PUBLIC`. Кличе їх лише definer-тригер прав від власника (`row_security = off`, outbox без `FORCE`), тож `signal_payload_allowed` рядок не судить: **форму перевіряє сама функція** до `INSERT` — аргументи не `NULL`, вид і скоуп обидва нульові чи обидва ненульові, користувач ≠ `ZERO_UUID`; інакше `RAISE` з `22023`. `data` рівно `{ op: "rights" }` (`id` ставить штамп outbox); `rightsSignalSchema` T0 втрачає `row_ver` — клієнт версій не порівнює (Р2). Режим злиття їх не гасить | §8.1, §8.2 (задача 0). **На погодження** |
| Р9 | **Хто шле й куди — один генератор.** Новий генератор `compiler/rights/signal-triggers.ts` ставить AFTER-тригер оператора (`SECURITY DEFINER`, `row_security = off`, від власника) на **кожну модельну таблицю фактів прав**. Множина — з того самого аналізу досяжності, що й джерела знімка актора (`snapshotSources`, `compiler/rights/snapshot-sources.ts`: читає тіла plpgsql і подання; ребер `requires` функції фактів не мають), тепер під `hasRightsFunctions`, а не лише під `hasActorSnapshot` (`pipeline.ts`): `facts`-таблиці — тригер; класи `exempt` `snapshot`/`identities` — без тригера; прийняті джерела (`membershipSource`, `assignmentSource`, `sourceRoleTable`) — без тригера, бо на прийняту таблицю платформа тригерів не ставить (спека прав §4.7), як і на прийняту `CustomTable`. Тригери `guard-units.ts` сигналів не шлють. Тест повноти порівнює набір тригерів із результатом аналізу (не порожній на фікстурі з довідниками прав і без них). Канал (старі й нові рядки, `DISTINCT` на оператор): **визначення** ролі чи дельти рівня скоупу — `signal_rights` скоупу, глобального (зокрема `everyUser`) — глобальний; **призначення** — `signal_user_rights` суб'єкта (рівень скоупу — через довідник членства виду, глобальний — `subject`); **членство** — користувач рядка `IS NOT NULL`; **зв'язок** — суб'єкт зв'язку; **«Користувачі»** на `invalid`/`user_kind` — сам рядок. Глобальний канал шлють лише визначення глобальних ролей. **Факти прийнятих джерел свіжіють за інтервалом** (такт частини `rights`, B5c; вихід — промоція). Походження рядка публічні виходи `rights_mine()`/`rights_my_scopes()` не несуть, тож правило — за каталогом: компілятор кладе в каталог `adoptedFacts?: { membershipKinds: uuid[], assignments?: true }`; для `can` — `unknown` межа тенанта й кожна гілка, що залежать від членства виду з прийнятим джерелом членства (зокрема грант рівня скоупу цього виду й для `publicRead`-об'єкта), і кожна гілка з грантом **будь-якого** рівня (глобальний, скоуп, контейнер — `CompiledAssignedOn`), коли є прийняте джерело призначень. `snapshotSources` переходить під `hasRightsFunctions` разом із діагностикою `rights.snapshot-source-unknown`; `snapshotExemptWriters` лишається під `hasActorSnapshot`. `rights_bump` не змінюється. Видимість «Користувачів» іншим учасникам скоупу сигналу не має: об'єкт несигнальний, свіжіє за інтервалом (§8.6) | §8.2, спека прав Рх15 (задача 0); §4.7 без змін; §8.6 — межа для фактів прийнятих джерел (інтервал, вихід — промоція). **На погодження: розвилка «прийняті джерела»** |
| Р10 | **Режим підписки `signal_topic_allowed`** — спершу `current_user_id() IS NOT NULL`; `simetra-rights:<вид>:<скоуп>` — вид є видом скоупу моделі й скоуп ∈ `scopeSetCall(вид)`; `simetra-rights:<нуль>:<нуль>` — дійсний користувач; змішані нулі — `false`; `simetra-user:<id>` — `id = current_user_id()`. Режим відправки обох префіксів — `false`; `signal_payload_allowed` з `op: "rights"` — `false` | §8.3 (задача 0) |

## Інтерфейси

| Що | Хто дає | Хто бере |
| --- | --- | --- |
| `CatalogEntry.rights?` (Р1), `ClientCatalog.adoptedFacts?` (Р9) | B6-1 | B6-2, D5 #122 (нічого не міняє) |
| поля знімка `members`, `dimensionValues` (Р2) | B6-1 | B6-2 |
| `signal_rights`, `signal_user_rights`, гілки прав `signal_topic_allowed` | B6-1 | стенд B6-2, `authorizeChannels` (без змін коду) |

## Інваріанти безпеки

Мутація — на закоміченому дереві, відкат зворотним патчем; кожен бар'єр
судиться окремо. Мутація без червоного тесту — до архітекторки.

| Інваріант | Тест (рівень) | Мутація словами |
| --- | --- | --- |
| І1. Підробити сигнал прав може лише власник | DB обох стеків: `EXECUTE` на `signal_rights`/`signal_user_rights` — `false` для `simetra_command`, `simetra_signals`, кожної ролі API; під `simetra_command` прямий `INSERT` рядка каналу прав в outbox — відмова політики | `GRANT EXECUTE … TO simetra_command`; режим відправки пропускає канал прав |
| І2. Форма рядка — у функції | DB: кожен недійсний аргумент Р8 — `22023` і 0 рядків outbox; дійсний — `data` рівно `{ id, op }` | прибрати кожну перевірку Р8 окремо |
| І3. Зміна прав — у правильний канал | DB під `simetra_command`: роль скоупу → канал скоупу; глобальна роль → глобальний; призначення й переміщення призначення між скоупами → обидва користувачі, 0 рядків каналу скоупу; членство (зокрема виду без довідника прав скоупу) і деактивація → канал користувача; запрошення без користувача — успіх; зв'язок без скоупу → канал суб'єкта, 0 глобальних; `ROLLBACK` — 0 рядків; видалення учасника разом із призначеннями одним оператором — сигнал користувачу; довідник членства в проєкті без довідників прав → канал користувача; прийняте джерело — 0 тригерів платформи; `adoptedFacts` у каталозі для джерела членства й для джерела призначень кожного рівня (зокрема контейнера) | тригер членства без `signal_user_rights` чи без `IS NOT NULL`; призначення шле в канал скоупу; зв'язок шле в глобальний; таблиця фактів без тригера сигналу (тест повноти червоний) |
| І4. Канал прав — лише своєму | DB обох стеків: свій скоуп так, чужий ні; дослівна функція, що відсікає скоуп, — ні; деактивований користувач — ні (зокрема з дослівною функцією, що включає скоуп); глобальний — лише дійсний; канал користувача — лише свій; змішані нулі — ні; `authorizeChannels` відсіює чужі | гілка користувача без `= current_user_id()`; гілка скоупу без `scopeSetCall`; гілка без перевірки дійсного користувача |

## Задачі

### Задача 0. Анкори й поправки спек

`orient --plan` і `doc anchors` на цей файл — дельти в тіло PR. Поправки за
стовпцем «вплив» рішень цієї частини: П4-B §3, §8.1–§8.3 (Р8–Р10), §8.6 —
межа фактів прийнятих джерел (Р9: інтервал, вихід — промоція), §9.1 (Р2),
§9.3 — ключ кешу `rightsVersion`, §14.3 (рядок негативних DB-кейсів каналу
прав), Додаток А (рядки B6 бази); спека прав Рх15 (сигнал шле тригер, не
`rights_bump`); спека системної схеми §3. Без лічильників і наративу.
Готово: `doc anchors && doc lint` зелені; `*.docs.test.ts` зелені.
Перевірка: `doc anchors && doc lint`, `run-tests unit --changed`.

### Задача 1. Контракт прав у каталозі (Р1, Р2)

Файли: `model/runtime/catalog.ts`, `compiler/runtime-catalog.ts`
(`runtimeObject`), `compiler/client-catalog.ts` (`entryOf`); джерело —
`RightsContract`, `AccessContract` (`compiler/contracts.ts`),
`readBoundaries`, `scopeSetCall` (`access-units.ts`), `carrierColumn`
(`rights/predicates.ts`, зараз не експортована — експортувати).
Готово: unit T0 і T1 — схема сувора; контракт для `any`/`own`/виміру/
контейнера/кореня/межі `users`/носія-ключа; `fresh: false` для функції
виміру й прийнятої `CustomTable`; `scopeSet` дослівного виду; носій поза
атрибутами й ключем — помилка компілятора; `rightsContract` зник (`grep` — 0;
`generated/*.json` шаблону оновлює `pnpm metadata:check`, не рука); `snapshotHash`
змінюється, `kernelHash` — ні; `pnpm metadata:check` зелений.
Перевірка: `run-tests unit --filter client-catalog.test.ts`,
`run-tests unit --filter runtime-catalog.test.ts`.

### Задача 2. Поля знімка `members`, `dimensionValues` (Р2)

Файли: генератор `rights_client_snapshot` (`compiler/rights/client-snapshot.ts`),
`model/runtime/rights-snapshot.ts`, `server/rights-snapshot.ts`
(`canonicalSnapshot`, `ANONYMOUS_SNAPSHOT` — нові поля входять у відповідь і
в `rightsVersion`), літерали знімка в наявних тестах, DB-тест знімка B5b-1;
`RIGHTS_DIMENSION_VALUES_MAX` — нова стала T0.
Готово: DB обох стеків — поля лише мої; функція лишається `SECURITY
INVOKER` без нової definer-поверхні; вихід проходить схему; масиви
впорядковано (відбиток 1-Р3 стабільний); вимір понад
`RIGHTS_DIMENSION_VALUES_MAX` — `truncated` і рівно межа значень (мутація:
без межі — тест червоний); unit T3 — відповідь `rights` зі зміненим знімком
у межі §12 (корисні байти = знімок, ≤ 1,1 × + 2 КіБ) на фікстурі з межею
значень.
Після: задача 1. Перевірка: `run-tests unit --filter rights-client-snapshot.test.ts`,
`run-tests unit --filter rights-snapshot.test.ts` (unit T3 — `server/__tests__`),
`run-tests db --filter rights-client-snapshot.db.test.ts`,
`run-tests db-supabase --filter rights-client-snapshot.supabase.db.test.ts`.

### Задача 3. `signal_rights`, `signal_user_rights` і тригери (Р8, Р9)

Файли: `compiler/signal/units.ts` (функції), `compiler/rights/signal-triggers.ts`
(нове: генератор тригерів сигналу над таблицями фактів), `compiler/pipeline.ts`
(`snapshotSources` під `hasRightsFunctions`, виклик генератора),
`compiler/platform-triggers.ts` (нова сім'я тригерів у реєстрі, модуль імен
на зразок `guard-names.ts`), `adoptedFacts` (Р9): `model/runtime/client-catalog.ts`,
`compiler/client-catalog.ts`; `model/runtime/signal.ts` (`rightsSignalSchema`
без `row_ver`), DB-тести `test/db/rights-signals.support.ts` + два тонкі файли.
Готово: unit T1 (дерево SQL: `SECURITY INVOKER`, без `EXECUTE`, виклики в
тригерах; тест повноти таблиць фактів; проєкт без довідників прав із джерелами — тригери є) і DB обох стеків — І1,
І2, І3; масове членство (1 000 рядків одним оператором) — один сигнал на
користувача; додавання учасника в новий скоуп — сигнал у його канал
користувача.
Після: задача 0. Перевірка: `run-tests unit --filter signal-units.test.ts`,
`run-tests unit --filter rights-signal-triggers.test.ts`,
`run-tests unit --filter rights-guards.test.ts`,
`run-tests unit --filter platform-triggers.test.ts`,
`run-tests unit --filter rights-snapshot-sources.test.ts`,
`run-tests unit --filter signal.test.ts` (`model/runtime`),
`run-tests db --filter rights-signals.db.test.ts`,
`run-tests db-supabase --filter rights-signals.supabase.db.test.ts`.

### Задача 4. Канали прав у `signal_topic_allowed` (Р10)

Файли: `compiler/signal/units.ts` (розбір `simetra-rights:`/`simetra-user:`
поряд із `CHANGES_TOPIC`), `test/db/signal-topic-allowed.support.ts`.
Готово: І4 на обох стеках; `authorizeChannels` видає канали прав лише за
Р10 (`packages/designer/src/__tests__/authorize-channels.*`); мутацію І1
«режим відправки пропускає канал прав» повторити тут — гілку відправки
переписує ця задача.
Після: задача 3. Перевірка: `run-tests db --filter signal-topic-allowed.db.test.ts`,
`run-tests db-supabase --filter signal-topic-allowed.supabase.db.test.ts`,
`run-tests db --filter authorize-channels.db.test.ts`,
`run-tests db-supabase --filter authorize-channels.supabase.db.test.ts`.

**Готово — частина 1:** цільові прогони задач 1–4 зелені; CI draft PR
зелений (повні рівні, `metadata:check`).

## Задачі власника

немає

## Підсумок аудиту

Ризик: права й кеш прав, сигнали й канали, бюджети. Раунд 1: Sonnet «план проти спеки й коду» (1 major: механізм шлюзу Р7 не названо), Sonnet «бюджети» (3 major: сплеск від сигналу користувача без джитера, хвиля після `refreshTokens` без `recovered`, розмір знімка без межі), Opus «безпека» (3 security major: втрата скоупу не звужувала «Користувачів», джерела фактів без сигналу, сигнал скоупу на прихованій вкладці чекав `resume()`). Усе внесено (Р6, Р7 `admit`, Р9, Р12 один джитер для всіх каналів прав, Р13 межа хвилі, Р2 межа значень виміру). Раунд 2 (Opus, діф): 3 security major — `writeBack` оминав шлюз, втрата значення за межею не змінювала знімка, джерело призначень глобального рівня; внесено (`admit` — єдиний вхід запису значень сервера, `digest`, відображення за рівнем); minor — вплив Р12 на §8.3/§8.6. Codex (6 питань): 5 major; спростовано 1 (видимість «Користувачів» іншим учасникам — несигнальний об'єкт, інтервал §8.6); прийнято 4 — таблиці фактів без сигналу в проєкті без довідників прав, перехід у `truncated`, гідратація оминає шлюз, бюджет прихованої вкладки §12. Модель сигналів змінено на один генератор над таблицями фактів. Вузький Opus після зміни: blocker — функції фактів не мають ребер `requires` (множина — з `snapshotSources`), major — §4.7 забороняє тригери на прийнятих таблицях; внесено. Остання вузька перевірка: походження рядка в публічних виходах знімка немає — правило переведено на ознаку каталогу `adoptedFacts`. Зона «прийняті джерела» давала знахідки в кожному з останніх раундів, тож раунди зупинено: модель для прийнятих джерел — розвилка до архітекторки. Архітекторка обрала варіант А (`adoptedFacts`) і поділ на дві частини. Вузька перевірка Opus правила `adoptedFacts`: 1 security major — прийняте джерело призначень рівня контейнера лишалося однозначним; внесено (будь-який рівень гранту, `publicRead`). Лишилось: 0 blocker, 0 відкритих security major.

