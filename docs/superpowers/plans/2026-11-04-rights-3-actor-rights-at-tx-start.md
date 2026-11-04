# Права-3: права актора на початок транзакції — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Виконання — за `/виконай-задачу` цього репо.

Статус: план (фаза 1). Виконання — лише після мерджу П4-A4 у `main` і «далі»
архітекторки прав.

**Goal:** щойно в транзакції команди є знімок актора, кожна функція, яку
читають RLS і ядро команди, повертає факти актора зі знімка, а не з живих
таблиць; тимчасовий бар'єр T3 (Р-A4-17) прибирається повністю.

**Architecture:** знімок актора — чотири факти (права, мої скоупи, мої
значення вимірів, множини дослівних функцій виду скоупу), кожен зі своїм
заголовком у `simetra.rights_tx_header`. Тригер `BEFORE … FOR EACH STATEMENT`
на кожному джерелі знімає ті факти, які це джерело живить, до першої зміни.
Джерела компілятор виводить аналізом відношень тіл живих варіантів;
невідоме відношення — помилка компілятора. Публічні функції фактів мають дві
гілки: заголовок факту цього xid є — знімок, немає — живий варіант без
`EXECUTE`. Знімок живе до кінця транзакції; рядки завершених транзакцій
прибирає наступний знімок. Бар'єр T3 видаляється.

**Tech Stack:** TypeScript (компілятор T1 `packages/simetra/src/compiler`,
модель T0 `packages/simetra/src/model`, сервер T3
`packages/simetra/src/server`), PostgreSQL 17, Vitest (unit, DB
`*.db.test.ts`, проєкт `bench`), DB-тести `@simetrajs/designer` над тінню.

**Spec:** [спека прав](../specs/2026-10-17-rights-design.md) §4.7, §5.1, §5.2,
§5.4, §6.1, §7; [спека П4](../specs/2026-10-26-p4-runtime-design.md) Рт6, Рт8,
§6.5, §6.9, §6.10, §6.11, §6.12, §6.13, §6.15, §6.16; план A4
`docs/superpowers/plans/2026-10-31-p4-a4-rights-administration.md` — Р-A4-17.

## Global Constraints

- Комітиш лише у `feat/rights-3` (worktree `/home/vsydorenko/Simetra-rights3`);
  Conventional Commits з українським описом; без трейлерів; історію не
  переписуєш; злиття `main` — `git merge`.
- Версії пакетів і `PLATFORM_VERSION` не змінюються. `AGENTS.md`, `CLAUDE.md`
  не правиш. Репо публічне: фікстури синтетичні.
- Під час роботи — лише scoped: `pnpm --filter <pkg> test <pattern>` і
  `pnpm --filter <pkg> test:db <pattern>`, без `--` перед шаблоном.
- **Гейти — одне вікно на блок.** Повні гейти разом із повним `pnpm test:db`
  (таймаут ≥ 45 хв) і бенчмарком — рівно один раз, коли всі задачі виконано,
  перед фінальною перевіркою лінзами й Codex архітекторки, на одному SHA, за
  «можна» архітекторки (Задача 9 крок 1): `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
  `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db`,
  `pnpm --filter simetra bench:rights`, `pnpm build:packages && pnpm test:packaging`.
  Після виправлень рецензії — лише швидкі гейти (`format:check`, `lint`,
  `typecheck`, `test`) і scoped DB зачеплених файлів; повний DB ще раз
  проганяє CI на PR, мердж — за зеленим CI. Після `git merge origin/main`
  повтор — лише якщо `main` приніс код у зачеплені області. Scoped DB
  зачеплених областей Права-3: `pnpm --filter simetra test:db rights- catalog-command- command-runtime membership access`
  (з гейтом тіл `rights-plan-gate`), `pnpm --filter @simetrajs/designer test:db rights-admin-commands rights- promotion apply database`.
- На коміт задачі — `pnpm --filter <pkg> lint`, `pnpm --filter <pkg> typecheck`,
  scoped тести; не `eslint .` по репо.
- Стек — лише `pnpm db:*`, не перезапускати; бази `metahub_copy*` не чіпати.
- DB-мутації — лише на закоміченому дереві; журнал — у кінці плану.
- Розвилки й відхилення — архітекторці (`consumer-reconciliation2`,
  `SendMessage`) з полем «вплив на спеку».
- Коментарі коду — українською, «чому». Імена тестів — англійською.
- Принцип 5 `AGENTS.md`: бар'єр T3 і старий формат знімка видаляються в цьому
  блоці, без прапорців і обгорток.
- Скіл `.agents/skills/writing-tests/SKILL.md` — перед кожною задачею з
  тестами; фікстури — зі спільних будівників
  (`src/compiler/__tests__/fixtures/rights.ts`, `test/db/rights-seed.ts`);
  нові DB-кейси — у наявних розгортаннях.

## Рішення

| № | Рішення | Обґрунтування | Вплив на спеку |
| --- | --- | --- | --- |
| Р3-1 | **Факти актора — чотири:** `rights` (рядки `rights_mine`), `scopes` (мої скоупи з учасниками), `values` (мої значення вимірів), `scopeSets` (вихід дослівних функцій множини виду скоупу, Р3-11). Дві гілки мають: `rights_mine`, `rights_my_scopes`, `rights_dimension_values`, `<членство>_member_scopes`, `<членство>_my_member`, нова `simetra.rights_scope_set(p_scope_kind uuid)`. Решта (`rights_any`, `rights_own`, `rights_dim`, `rights_container`, `has_right`, `rights_my_members`, `rights_versions`, `analysisGate`) читає факти лише через них. `rights_visible_users` бере мої скоупи зі знімка, а рядки інших учасників — наживо (дані, не права актора); `current_user_carrier_sources()` — дані рядка. Носії контейнера — рядки `rights_mine` | одне місце на факт | спека прав §5.1 |
| Р3-2 | **Сховище:** `simetra.rights_tx_header (xid bigint, fact text, actor uuid)`, PK `(xid, fact)`; `simetra.rights_tx_actor` — рядки прав і носіїв `full_access`, без рядка-заголовка й колонки `actor`; `simetra.rights_tx_scopes (xid, scope_kind_id, scope, member, catalog boolean)`, індекс `(xid, scope_kind_id, scope)`; `simetra.rights_tx_values (xid, dimension_id, value uuid NULL)`, індекс `(xid, dimension_id)`; `simetra.rights_tx_scope_sets (xid, scope_kind_id, scope)`, індекс `(xid, scope_kind_id)`. Усі `rowLevelSecurity: "off"`, без грантів. `catalog` — рядок довідника членства (функції членства виду читають лише такі). Рядки скоупів з `NULL` у `scope`/`member` у знімок не пишуться (живі функції їх не зіставляють) | заголовок серед рядків прав шукався б перебором; індекс `scope` — для `_my_member(p_scope)` на рядок | спека прав §7 |
| Р3-3 | **Присутність і власник:** `present(fact)` = `CASE WHEN txid_current_if_assigned() IS NULL THEN false ELSE EXISTS (SELECT 1 FROM simetra.rights_tx_header h WHERE h.xid = txid_current_if_assigned() AND h.fact = '<fact>') END`; `owned(fact)` — те саме з `AND h.actor IS NOT DISTINCT FROM (SELECT simetra.current_user_id())`; `foreign()` — `CASE` з тією самою охороною й `EXISTS` заголовка **будь-якого** факту цього xid з `actor IS DISTINCT FROM (SELECT simetra.current_user_id())`. `CASE`, бо кон'юнкти верхнього рівня планувальник переставляє за ціною. Гілка знімка — під `owned(fact)`, жива — під `NOT present(fact) AND NOT foreign()`: актор транзакції закріплюється першим знятим фактом, і інший актор не отримує живих фактів навіть тих, яких ще не знято (fail-closed; так само сесія без користувача — `current_user_id()` `NULL` — після знімка користувача отримує порожні факти, і це навмисно); другий запис у джерело — відмова тіла знімка `rights-context`; COMMIT відмовляє `actorCheck`, коли в черзі ключ `actor`. Без xid (`READ ONLY` §6.11, PostgREST) таблиць знімка не читає ніхто | `txid_current()` видав би xid кожному читанню | спека прав §5.1 |
| Р3-4 | **Живі варіанти:** `rights_mine_live()`, `rights_my_scopes_live()` (+ колонка `catalog`), `rights_my_members_live(p_scope_kind)`, `rights_dimension_values_live(p_dimension)`, `rights_scope_set_live(p_scope_kind)` — форма `stable` (`LANGUAGE sql STABLE SET search_path = ''`, invoker), `executeGrants(…, [])`; тіла — ті самі будівники з `RightsUser` `LIVE`. Кличуть їх лише функції від власника | одне тіло на факт; без `EXECUTE` знімка не обійти | спека прав §5.1 |
| Р3-5 | **Момент знімка.** Тригер `BEFORE INSERT OR UPDATE OR DELETE … FOR EACH STATEMENT` (мітка `simetra_rights_snapshot`, функція на таблицю, як зараз) на кожному джерелі; тіло знімає лише відсутні факти цього джерела. Лише з контекстом команди й не в режимі обслуговування: DML у таблиці виду має лише `simetra_command`, порожній контекст відмовляє `RESTRICTIVE`-політика `<t>_command_*` (§5.3). Факти рахують живі варіанти, тож знімок успадковує їхні фільтри: умову активності й умову рядків прийнятих джерел членства й призначень (`activeCondition`, `sourceConditions` у `myScopesBody`, `sourceAssignments`) і дієвість носіїв (`fullAccessHolderRows`); гілка знімка читає вже відфільтровані рядки й повторно не фільтрує. Заголовок факту — після його рядків. Оператор, що взяв знімок, сам читає живі факти — вони рівні знімку | доказ — Задача 6 | спека прав §7 |
| Р3-6 | **Джерела — аналізом, fail-closed.** `snapshotSources` будує для кожного факту замикання викликів тіл його живих варіантів (`relationReads` над `[head, ...reachableUnits(head, …)]` — `reachableUnits` голови не повертає; голови — живі варіанти факту; згенеровані одиниці — як `VerbatimUnit`) над **повним** переліком базових одиниць — згенеровані функції прав, членства й платформного шару (`current_user_id` читає «Користувачів» і `simetra.identities`) плюс дослівні — бо `reachableUnits` мовчки пропускає нерозв'язаний виклик; і класифікує кожне відношення: таблиця виду (не `declared`) — джерело цього факту; подання моделі — прозоре (його базові відношення класифікуються за тим самим правилом); матеріалізоване подання — виняток `materializedView`, лише коли всі його базові відношення — винятки, інакше помилка; виняток — прийняті джерела членства й призначень та їхні таблиці ролей (§4.7: на прийняту таблицю платформа тригерів не ставить), `CustomTable` (вид `declared`), `simetra.identities`, `simetra.rights_tx_*`; посилання без схеми — джерело чи виняток, лише коли кожен можливий збіг ним є; будь-що інше — помилка компілятора `rights.snapshot-source-unknown`. Винятки тримає Р3-13 | вивід з тих самих тіл, що читають факти; невідоме відношення не мовчить | спека прав §7 |
| Р3-7 | **Знімок живе до кінця транзакції.** `rights_tx_check` знімка не видаляє. Тіло знімка, коли бере хоч один факт і `current_setting('transaction_isolation') = 'read committed'`, спершу прибирає рядки завершених транзакцій: для кожної з п'яти таблиць окремо `DELETE FROM t WHERE ctid = ANY (ARRAY(SELECT ctid FROM t WHERE xid <> txid_current() FOR UPDATE SKIP LOCKED))`. Чужі видимі рядки — лише закомічені; замок рядка й видалення — в одному операторі, тож прибиральники не чекають один одного. В інших рівнях ізоляції прибирання пропускається (його зробить наступний знімок у `read committed`) | видалення на спорожнілій черзі відкривало діру: пройдена `SET CONSTRAINTS ALL IMMEDIATE` прибирала знімок, і зміни, яких ⊆ не судить (виміри, членство без призначень), діяли б до COMMIT | спека прав §7 |
| Р3-8 | **Запобіжники на COMMIT.** `actorPending` ставить ключ `actor`, коли є заголовок факту `rights` цього xid (а не рядок `rights_tx_actor`: у актора без прав рядків немає). `actorCheck` бере «після» з `rights_mine_live()`, актора — з `rights_tx_header`. Перевірки ролі й призначення — образи рядків і `rights_role_grants`; `last-full-access` — таблиці (`fullAccessHolderRows`). Функції аналізу чужого користувача (`_of`) — живі. `rights_explain` судить видимість викликача функціями зі знімком: CTE викликача перебудовано на `rights_mine` (колонки `role_id`, `custom_role` — `NULL`), `rights_my_members`, `rights_dimension_values`, функції множини виду | приріст — проти живого кінцевого стану; пояснення ≡ RLS викликача | спека прав §5.1, §7 |
| Р3-9 | **Продуктивність — поріг (затверджено архітекторкою; перевищення будь-якого — розвилка до неї).** (а) Накладні гілок — серверний замір (сценарій 6): plpgsql-цикл з `clock_timestamp()`, K = 1 000 викликів на зразок однієї форми для обох сторін (`PERFORM count(*) FROM f(…)`), ≥ 31 чергований зразок публічної функції й живого варіанта (`rights_mine`, `rights_my_scopes`, `_member_scopes`, `_my_member(p_scope)`, `rights_scope_set`) на малому обсязі; без знімка — медіана ≤ базова лінія тієї самої публічної функції на `BENCH_BASE` (до блоку) × 1,05 + 2 мкс **і** медіана різниці з живим варіантом ≤ 30 мкс на виклик без знімка (xid призначено записом не в джерело); зі знімком ≤ живий варіант × 1,05 + 10 мкс; довірчий інтервал — у звіті. (б) Сценарії 1–3 до/після — звіт; розвилка, коли клітинка ≥ 5 мс зросла > 10 %. (в) Перший запис команди (сценарій 7, власна модель): у контейнер, у таблицю дослівної функції виміру, у довідник членства — для звичайного актора й для актора найбільших обсягів сценаріїв 1 і 2; абсолютний приріст до/після ≤ 1,25 × час знятих фактів + 10 мкс × N рядків, **і** розвилка до мерджу, коли приріст першого запису > 5 мс для звичайного актора чи > 50 мс для найбільшого; час фактів — сума `total_time` кожного верхнього виклику `*_live` з тіла знімка з `pg_stat_xact_user_functions` (поріг застосовується лише коли `calls > 0` кожного; живі варіанти з `SET search_path` не вбудовуються, і гейт тіл це тримає) у тій самій транзакції до відкату (`track_functions = 'all'` — з'єднанням суперкористувача `testSuperuserUrl`, або `has_parameter_privilege` і зупинка з помилкою); окремі рядки — прибирання N рядків чужого закоміченого xid (розвилка > 2 мс на 1 000 рядків), запис у «Користувачів» (знімає всі чотири факти), і C = 10 відкритих транзакцій з великим знімком під час прибирання; у звіт — розмір п'яти таблиць і `n_dead_tup` після сценарію (церн рядків до наступного знімка). (г) Сценарій 5 (1 і 1 000 команд): ≤ +10 % | замір у прогоні на сервері — шум мікросекунд, не мілісекунд | немає |
| Р3-10 | **Очікування DB-кейсу A4** «the database still lets a direct command use rights granted in its transaction»: після Права-3 оновлення після самопризначення відмовляє ядро **тією самою причиною, що контрольний запис без ролі** (`E.forbidden.noRight`); `rights-context` — причина бар'єру T3. **Розвилка Р-1** | — | немає |
| Р3-11 | **Дослівна функція множини виду** (`setFunction` об'єктом) — під знімок: `tenantBoundary` (обидва виклики: `access-units.ts` і ядро `catalog-command/units.ts`) для такого виду кличе `simetra.rights_scope_set('<вид>')` (дві гілки; жива — `rights_scope_set_live`, що кличе дослівну функцію виду); `AccessContract.scope` отримує поле `verbatim: boolean` — лише коли `hasActorSnapshot` (без довідників прав межа тенанта — як зараз); `EXECUTE` дослівної функції множини лишається (платформна спека §6.7): її прямий виклик SQL застосунку — домен застосунку, а межа тенанта й ядро йдуть через обгортку; `scopeSetMatch` у `rights/explain-units.ts` для викликача — через `rights_scope_set` / `_member_scopes`; джерела — за Р3-6. Вид `setFunction: "membership"` — як зараз (`_member_scopes`). **Розвилка Р-2**: альтернатива — дослівна функція лишається живою, а читання нею джерела прав (довідників прав, членства) — помилка компілятора, і обмеження в §7 | дослівна функція може читати довідники членства й призначень, які ⊆ судить; без бар'єру T3 діра лишилася б | спека прав §5.2 (межа тенанта), §7 |
| Р3-12 | **A6 (спека П4 §6.13 крок 6):** A6 додає в `rights_tx_actor` колонку походження (`root-creator`) і дописує рядки проєкції архетипу `rootCreator`, обмежені `p_root` (з розгортанням замикання, як `rights_mine_live`), рядок носія `full_access`, коли архетип його має, і рядок `rights_tx_scopes` (новий скоуп, учасник-творець, `catalog = true`). Права-3 правлять лише текст §6.13 | межа тенанта й `own` читають знімок | спека П4 §6.13 |
| Р3-13 | **Шлях запису в таблицю-виняток — закритий у SQL застосунку.** Помилка компілятора `rights.snapshot-exempt-writer`, коли дослівний SQL відкриває ролі команд (`simetra_command`) чи `PUBLIC` запис у таблицю-виняток Р3-6: (а) `GRANT INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`, табличний чи поколонковий, або типові привілеї схеми винятку, що дають такий грант (`ALTER DEFAULT PRIVILEGES`); модель — **таблицю ніхто не пише без гранту**; (б) подання з правом запису над винятком без `security_invoker`, доступне їм; (в) функція чи процедура `SECURITY DEFINER` (зокрема через `ALTER FUNCTION … SECURITY DEFINER`, `functionSettingsOf`), замикання якої пише виняток (`bodyKindTable` з `sql/kind-table-verbatim.ts` над винятками як `KindTables`, з поданнями; запис у вкладеному `WITH … AS (INSERT|UPDATE|DELETE|MERGE …)` — теж запис: `statementsOf` (`sql/function-body.ts`) уже збирає вкладені оператори, зокрема `CommonTableExpr.ctequery`, і правило 1 це тримає тестом «a data-modifying CTE» у `kind-table-verbatim.test.ts`), коли SQL не відкликає `EXECUTE` від `PUBLIC` **явно** (`REVOKE EXECUTE ON FUNCTION <сигнатура> FROM PUBLIC` без пізнішого `GRANT` `PUBLIC` чи ролі команд) або дає його ролі команд; типові привілеї (`ALTER DEFAULT PRIVILEGES`, глобальні чи `IN SCHEMA`) відкликанням не рахуються: вони діють лише на об'єкти, створені після них і лише названою роллю — для функцій `PUBLIC` має `EXECUTE` за замовчуванням; (г) тригерна функція `SECURITY DEFINER` (`RETURNS trigger`), замикання якої пише виняток і яку SQL застосунку чіпляє `CREATE TRIGGER` до будь-якої таблиці, — незалежно від `EXECUTE` (тригер його не потребує). Правило діє лише за `hasActorSnapshot`. Спільний з гейтом шляху запису промоції лише розбір грантів і типових привілеїв: гілки `GrantStmt` і `AlterDefaultPrivilegesStmt` (`writeGrant` і зіставлення цілей) з `writePathProblems` (`compiler/operations/promote/gates.ts`) винести в `compiler/sql/write-paths.ts` з параметрами (одиниці, ролі, таблиці); гілка політик запису лишається в гейті промоції (у Р3-13 політика без гранту запису не відкриває); (б)–(г) — новий код. Повідомлення (en/uk) називає річ, яку прибрати: грант (одиниця й роль), подання чи функцію `SECURITY DEFINER`, і таблицю-виняток. Обчислюється в `pipeline.ts` після генерації (потрібен перелік винятків). Живі ACL прийнятої таблиці в цільовій базі компілятор не бачить: роль команд створює платформа, тож давніх грантів їй бути не може, а новий грант іде через SQL застосунку — обмеження §7 і пункт боргу (гейт живих ACL під час застосування). **Розвилка Р-4**: альтернатива — попередження й обмеження §7 | без правила виняток тримався б лише фікстурою | спека прав §4.7, §6.1, §7 |
| Р3-14 | **Бар'єр T3 видаляється повністю**: `Transaction.rightsPhase`, `startPhase`, `checkBarrier`, `RIGHTS_CONTEXT`, `isRightsContext`, `isRightsObject` (`server/transaction.ts`), виклики в `server/phase.ts`, `server/hook-context.ts`, ре-експорт `administerRightsAction` у `model/kinds/registry.ts`, якщо його більше ніхто не імпортує; тести бар'єру; текст бар'єру в спеці П4 і скілі споживача (у формі, яку внесе A4) | принцип 5 | спека П4 §6.5, §6.9, §6.10, §6.12, §6.13, §6.15, §6.16, §7.1, §7.2, §8 (рядок A4 без бар'єру; новий рядок блоку Права-3; порядок A1 → A2 → A3 → A4 → Права-3 → A6 → A5), Додаток А; спека прав §7 (пункт ⊆); скіл споживача |

## Розвилки — розв'язано архітекторкою

- **Р-1** (Р3-10): `noRight` замість `rights-context` у переписаному кейсі A4 — **так**. Вплив: немає.
- **Р-2** (Р3-11): **рішення — обгортка `simetra.rights_scope_set` зі знімком.** Варіанти були: під знімком через обгортку (рекомендовано) чи жива з забороною читати джерела прав. Вплив: §5.2/§7.
- **Р-3** (Р3-9): пороги затверджено з доповненням до (а) — шлях без знімка ≤ базова лінія `BENCH_BASE` × 1,05 + 2 мкс.
- **Р-4** (Р3-13): **рішення — помилка `rights.snapshot-exempt-writer` (fail-closed), з підказкою, що прибрати.** Варіанти були: помилка (рекомендовано) чи попередження, коли SQL застосунку відкриває ролі команд запис у таблицю-виняток; живі ACL цільової бази — борг. Вплив: §6.1/§7.
- **Р-5** (до відома): сценарії діри через `commandAs` неможливі — він відкочує свою точку збереження після одного оператора; сценарії йдуть через багатокроковий `commandSteps` (той самий шлях: claims, контекст, `simetra_command`, повз T3) і через `runtime.run`. «Користувачі як джерело» — регістр зв'язку виміру з суб'єктом-«Користувачем»: сам рядок «Користувачів» живить факти лише через `current_user_id()`, а `invalid`/`user_kind` команда не пише. Зміни джерел, яких політики не відкривають (самоприйняття), — від власника з контекстом команди, як у наявних тестах запобіжників.
- **Р-6** (до відома): видалення колонки `rights_tx_actor.actor` — руйнівна зміна для рушія схеми; застосування над стендом з A4 потребує дозволу `destructive` (таблиця між транзакціями порожня); споживачів з розгорнутим A4 немає, тож дозвіл торкається лише тестових стендів — це явно в звіті Задачі 9.
- **Р-7** (до відома): «Користувачі» — джерело всіх чотирьох фактів (`current_user_id()`), тож команда, що пише «Користувачів» (зміна профілю), бере повний знімок; ціна — рядок сценарію 7.

## Review Focus

1. **Наявний сценарій, що користується новими правами в тій самій
   транзакції** (прийняття запрошення, хуки членства, передача
   `fullAccess`), і **DB-описи зі спільним xid**: знімок живе до кінця
   транзакції опису, тож запис у джерело з контекстом поза відкоченою точкою
   збереження ламає наступні кейси (`rights-context`, старі факти). Кожен
   червоний тест поза планом — розвилка. Задачі 6 крок 6, 8 крок 5.
2. **Інший актор у транзакції зі знімком** — порожні факти. Тест —
   `returns empty facts to another actor of the transaction`.
3. **Відкат точки збереження, що взяла знімок.** Тест — `retakes the snapshot
   after a rolled back savepoint`.
4. **Читання без xid** — жодного скану таблиць знімка. Тест — designer,
   `reads through rights functions in a read only transaction without an xid`.
5. **Актор без прав, що самоприймає запрошення з призначеннями,** — ⊆ на
   COMMIT. Тест — `judges the self-acceptance of an actor without rights`.

---

## Файли

| Файл | Що | Задачі |
| --- | --- | --- |
| `packages/simetra/src/model/physical/snapshot.ts` | частини `rightsTxHeader`, `rightsTxScopes`, `rightsTxValues`, `rightsTxScopeSets` | 3 |
| `packages/simetra/src/compiler/rights/admin-tables.ts` | таблиці Р3-2 | 3 |
| `packages/simetra/src/compiler/rights/actor-snapshot.ts` (новий) | `SNAPSHOT_TABLES`, `SnapshotFact`, `snapshotPresent`, `snapshotOwned`, `snapshotBranches`, `hasActorSnapshot` | 3, 4 |
| `packages/simetra/src/compiler/rights/snapshot-sources.ts` (новий) | аналіз джерел Р3-6 | 3 |
| `packages/simetra/src/compiler/rights/functions.ts` | `LIVE`, живі варіанти (Задача 2), `rights_scope_set_live` (Задача 3), `rights_scope_set` і гілки (Задача 4) | 2, 3, 4 |
| `packages/simetra/src/compiler/membership-functions.ts` | гілки `_member_scopes`/`_my_member` | 4 |
| `packages/simetra/src/compiler/access-units.ts` | `tenantBoundary` для дослівної функції — `rights_scope_set` | 4 |
| `packages/simetra/src/compiler/rights/explain-units.ts` | CTE викликача | 4 |
| `packages/simetra/src/compiler/rights/guard-units.ts` | `GuardContracts` (експорт, `assignmentSources`), тіла знімка, прибирання, `actorPending`, `actorCheck`, `requires` | 2, 3 |
| `packages/simetra/src/compiler/pipeline.ts` | виклики генераторів; діагностики Р3-6, Р3-13 | 3 |
| `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts` | `rights.snapshot-source-unknown`, `rights.snapshot-exempt-writer` | 3 |
| `packages/simetra/src/compiler/sql/write-paths.ts` (новий), `compiler/operations/promote/gates.ts` | спільний розбір шляхів запису (Р3-13) | 3 |
| `packages/simetra/src/compiler/catalog-command/units.ts`, `compiler/contracts.ts` | межа тенанта ядра; `AccessContract.scope.verbatim` | 4 |
| `packages/simetra/src/compiler/__tests__/` — `rights-admin-tables`, `rights-functions`, `rights-guards`, `rights-explain`, новий `rights-snapshot-sources`, тест функцій членства, тест `access-units` | unit | 2–4 |
| `packages/simetra/test/db/connection.ts` | `commandSteps` | 1 |
| `packages/simetra/test/db/catalog-command-admin.db.test.ts` | знімок, діра, кейс A4, винятки | 6 |
| `packages/simetra/test/db/catalog-command-rights.db.test.ts` | ядро ≡ RLS зі знімком | 6 |
| `packages/simetra/test/db/rights-analysis.db.test.ts` | пояснення зі знімком | 6 |
| `packages/simetra/src/compiler/__tests__/fixtures/rights.ts`, `test/db/rights-seed.ts` | будівники: скоуплений регістр зв'язку з суб'єктом-«Користувачем» (шаблон `UserRegion` з `unscopedDimension()`), дослівна функція виміру над таблицею виду, що кличе `_member_scopes`, вид скоупу з дослівною функцією множини | 0, 3, 6 |
| `packages/simetra/test/db/rights-plan-gate.db.test.ts`, `test/db/explain-plan.ts` | гейт тіл | 5 |
| `packages/simetra/bench/rights.bench.db.ts` | сценарії 6, 7 | 0, 5 |
| `packages/simetra/src/server/{transaction,phase,hook-context}.ts`, `packages/simetra/src/model/kinds/registry.ts`, `src/server/__tests__/{transaction,hooks}.test.ts`, `fixtures.ts`, `harness.ts` | видалення бар'єру | 8 |
| `packages/designer/src/__tests__/rights-admin-commands.db.test.ts` | сценарії через `runtime.run`, `READ ONLY` | 8 |
| спеки, скіл споживача, борг, `docs/ROADMAP.md` | Задача 7 | 7 |

**Порядок:** 0 → 1 → 2 → 3 → 4 + 6 (один коміт) → 5 → 7 → 8 → 10 (DB-мутації на закоміченому дереві) → 9.
Задачі 1–3 поведінки читання не змінюють.

---

## Задача 0: старт фази 2

- [x] **Крок 1.** `git -C /home/vsydorenko/Simetra-rights3 fetch origin && git -C /home/vsydorenko/Simetra-rights3 merge origin/main`. Конфлікт — архітекторці.
- [x] **Крок 2.** `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-11-04-rights-3-actor-rights-at-tx-start.md`; розбіжності — архітекторці. Відомий дрейф A4: `holderRows` → `fullAccessHolderRows`.
- [x] **Крок 3. Інвентар бар'єру:** `git grep -n "checkBarrier\|startPhase\|rightsPhase\|isRightsObject\|isRightsContext\|RIGHTS_CONTEXT\|Р-A4-17\|Права-3\|бар'єр" -- packages docs`. Нове проти Р3-14 — у Задачу 8 і архітекторці.
- [x] **Крок 4. Сценарії базової лінії — до будь-яких змін коду.** Сценарії 6 і 7 (Р3-9 (а), (в)): 6 — серверний замір публічних функцій фактів (`rights_mine`, `rights_my_scopes`, `_member_scopes`, `_my_member(p_scope)`, дослівна функція множини виду); 7 — з власною моделлю бенчмарку (`policyDomain(adminRoles())` + вид-контейнер + вимір з дослівною функцією над таблицею виду + вид скоупу з дослівною функцією множини; будівники — у `fixtures/rights.ts`). Коміт `test(simetra): сценарії бенчмарку знімка` — лише тести поверх SHA злиття з `main`, код продукту той самий; його SHA — `BENCH_BASE` (= `1f7ea62e`). Бенчмарк тут **не запускати**: «до» і «після» міряються підряд в одному вікні гейтів (Задача 9 крок 1), щоб змінне навантаження машини не робило їх непорівнянними. Задача 5 крок 5 лише додає до сценарію 6 вимір «живий варіант» і рядки знімка, не змінюючи заміру базової лінії.

## Задача 1: помічник багатокрокової команди

**Files:** `packages/simetra/test/db/connection.ts`.

**Produces:** `commandSteps(client: pg.Client, claims: Record<string, unknown>, steps: readonly CommandStep[], options?: { immediate?: boolean }): Promise<{ completed: unknown[]; refusal?: Refusal }>`, де `CommandStep = { context?: CommandContext; sql: string; params?: unknown[]; asOwner?: boolean } | { check: (client: pg.Client) => Promise<unknown> }`. Одна точка збереження на сценарій; claims — раз; контекст — перед кроком, що його має; крок `asOwner` — `RESET ROLE` (власник з контекстом команди), інакше `SET LOCAL ROLE simetra_command`; крок `check` — від власника, без зміни контексту, його результат — у `completed`; для кроку SQL у `completed` — `{ rows, rowCount }`; між кроками `SET CONSTRAINTS` немає; `immediate` — `SET CONSTRAINTS ALL IMMEDIATE` від власника після останнього кроку; перший `DatabaseError` — `refusal` (форма `Refusal` з `commandAs`), `completed` — кроки до нього; відкат точки збереження — у `finally`.

- [x] **Крок 1.** Реалізувати. `connection.test.ts` перевіряє лише чисті функції, тож перший тест помічника — перший кейс Задачі 6 (`keeps the effects of earlier steps visible to later steps`).
- [x] **Крок 2.** `pnpm --filter simetra typecheck`, `lint`; коміт `test(simetra): багатокрокова команда для DB-сценаріїв прав`.

## Задача 2: живі варіанти

Поведінка не змінюється: тіло знімка й `actorCheck` переходять на живі
варіанти до появи гілок.

**Files:** `rights/functions.ts`, `rights/guard-units.ts`; Test `rights-functions.test.ts`, `rights-guards.test.ts`.

**Produces:** `RIGHTS_FUNCTIONS.mineLive`, `myScopesLive`, `myMembersLive`, `dimensionValuesLive`; `const LIVE: RightsUser` (`user: CURRENT_USER`, `scopes: call(myScopesLive)`, `members: k => call(myMembersLive, [k])`, `current: true`); `myScopesBody(contracts, whose, withOrigin = false)` — з `withOrigin` колонка `catalog`.

- [x] **Крок 1. Тести:** `revokes execute on live variants` (одиниці кожного = `executeGrants("<сигнатура>", [], provider)`, цілими операторами); `renders live variants as stable invoker functions` (`LANGUAGE sql STABLE SET search_path = ''`, без `SECURITY DEFINER`); `computes the snapshot and the actor check from live variants` (тіла знімка й `rights_tx_check` кличуть `rights_mine_live()`, не `rights_mine()`; `requires` цих функцій — живий варіант).
- [x] **Крок 2.** Червоні: `pnpm --filter simetra test rights-functions rights-guards`.
- [x] **Крок 3.** Реалізувати; `snapshotBody`, `actorCheck` і їхні `requires` — на `mineLive`.
- [x] **Крок 4.** Зелені; `pnpm --filter simetra test:db rights-functions rights-guards`; `typecheck`, `lint`.
- [x] **Крок 5.** Коміт `feat(compiler): живі варіанти функцій фактів актора`.

## Задача 3: сховище, джерела, тіла знімка

Поведінка читання не змінюється: знімок наповнюється, публічні функції його
ще не читають.

**Files:** `model/physical/snapshot.ts`, `rights/admin-tables.ts`, `rights/actor-snapshot.ts`, `rights/snapshot-sources.ts`, `rights/functions.ts` (`rights_scope_set_live`), `rights/guard-units.ts`, `pipeline.ts`, `diagnostics.ts`, `messages.ts`, новий `sql/write-paths.ts` (спільний розбір шляхів запису), `operations/promote/gates.ts` (перехід на нього); Test `rights-admin-tables.test.ts`, `rights-snapshot-sources.test.ts`, `rights-guards.test.ts`.

**Produces:**
- `actor-snapshot.ts`: `type SnapshotFact = "rights" | "scopes" | "values" | "scopeSets"`; `SNAPSHOT_TABLES = { header, actor, scopes, values, scopeSets }`; `snapshotPresent(fact)`, `snapshotOwned(fact)`, `snapshotForeign()` — вирази Р3-3 дослівно; `hasActorSnapshot(contracts, provider)` = `rightsCatalogs.length > 0 && hasRightsFunctions(contracts, provider)` (перевірка на початку `buildRightsGuardUnits` — на нього).
- `snapshot-sources.ts`: `snapshotSources(input: { contracts: GuardContracts; physical: PhysicalSnapshot; objects: readonly Pick<ParsedObject, "id" | "kind" | "file">[]; generated: readonly SqlUnit[]; verbatim: readonly VerbatimUnit[]; parse: SqlParser; plpgsql: PlpgsqlParser }): { sources: { table: PhysicalTable; facts: readonly SnapshotFact[] }[]; exempt: { table: QualifiedName; reason: "membershipSource" | "assignmentSource" | "sourceRoleTable" | "declared" | "identities" | "materializedView" | "snapshot" }[]; unknown: { relation: string; fact: SnapshotFact; via: string }[] }` — Р3-6; `unknown` непорожній — діагностика `rights.snapshot-source-unknown` у `pipeline.ts`.
- `GuardContracts` — експорт, `+ "assignmentSources"`; `buildRightsGuardUnits(…, sources: ReturnType<typeof snapshotSources>)` — `pipeline.ts` рахує джерела раз і передає.
- `actorPending()` — `EXISTS` заголовка `rights` цього xid.

Тіло функції знімка таблиці: (1) без контексту чи в режимі обслуговування — `RETURN NULL`; (2) заголовок цього xid з іншим актором — `rights-context`; (3) немає жодного відсутнього факту таблиці — `RETURN NULL`; (4) прибирання Р3-7; (5) для кожного відсутнього факту: рядки (`rights`: `rights_mine_live()` + рядки носіїв цього актора; `scopes`: `rights_my_scopes_live()` без `NULL`; `values`: на кожен вимір — `rights_dimension_values_live('<id>')`; `scopeSets`: на кожен вид з дослівною функцією — `rights_scope_set_live('<вид>')`), потім заголовок `(txid_current(), '<fact>', current_user_id())`.

Діагностика Р3-13 (за Р-4) — у `pipeline.ts` після генерації.

- [x] **Крок 1. Тести:**
  - `rights-admin-tables.test.ts`: `adds the snapshot tables` — колонки, PK, індекси Р3-2; `rights_tx_actor` без `actor`.
  - `rights-snapshot-sources.test.ts`, фікстура з усіма видами джерел (довідник членства; прийняті джерела членства й призначень з таблицею ролей; вид-контейнер; вимір зі зв'язком у таблиці виду; скоуплений регістр зв'язку з суб'єктом-«Користувачем»; дослівна функція виміру над таблицею виду, що кличе `_member_scopes`; вимір зі зв'язком у `CustomTable`; вид скоупу з дослівною функцією множини над таблицею виду):
    - `maps the sources of the fixture to their facts` — **рукописна** очікувана мапа «таблиця → факти» і «виняток → причина» для фікстури;
    - `reads no snapshot table from live variants`;
    - `maps the direct reads of every live variant` — кожна таблиця, яку тіло живого варіанта читає **напряму** (не через виклик), є в мапі свого факту;
    - `reports an unknown relation` — `snapshotSources` напряму над рукописними одиницями (судження голів раніше відхилило б таку дослівну функцію, і конвеєр до генерації не дійшов би): тіло читає таблицю `simetra` поза винятками → `unknown`; і через конвеєр — матеріалізоване подання моделі над таблицею виду, яке читає дослівна функція виміру → `rights.snapshot-source-unknown`;
    - `sees through a model view` — дослівна функція виміру читає подання моделі над таблицею виду → таблиця виду — джерело `values`, без помилки.
  - `rights-guards.test.ts`: `puts a snapshot trigger with its facts on every source`; `writes the header of a fact after its rows`; `cleans finished snapshots only in read committed`; `keeps the snapshot to the end of the transaction` (тіло `rights_tx_check` не видаляє з таблиць знімка); `queues the actor key by the rights header` (`actorPending`); наявні асерти старого знімка — оновити.
  - Діагностика (за Р-4): `accepts an adopted source without grants` (база: фікстура `adoptedSources` без жодного гранту — без помилки); `accepts a write policy on an exempt table without a grant`; `refuses a definer trigger function writing an exempt table` (з `REVOKE EXECUTE … FROM PUBLIC`, причеплена до таблиці); `refuses a definer function writing an exempt table through a data-modifying CTE`; `refuses a definer writer whose execute is revoked only in default privileges` (`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` — і глобальні, і `IN SCHEMA` — помилка; контроль — явний `REVOKE EXECUTE ON FUNCTION` без помилки); `refuses a definer function writing an exempt table and executable by the command role` (контроль — з `REVOKE EXECUTE … FROM PUBLIC` без помилки); `refuses a grant of DML on an exempt table to public or the command role` (табличний, поколонковий, `TRUNCATE`, типові привілеї схеми; контроль — `SELECT`); `refuses a writable view over an exempt table`. Наявні тести гейту шляху запису промоції — зелені без змін очікувань.
- [x] **Крок 2.** Червоні: `pnpm --filter simetra test rights-admin-tables rights-snapshot-sources rights-guards`.
- [x] **Крок 3.** Реалізувати.
- [x] **Крок 4.** Зелені; `pnpm --filter simetra test:db rights-guards catalog-command-admin`; `pnpm --filter simetra typecheck lint`; `pnpm --filter @simetrajs/designer typecheck`.
- [x] **Крок 5.** Коміт `feat(compiler): знімок фактів актора до першої зміни їхнього джерела`.

## Задача 4: дві гілки

**Files:** `rights/actor-snapshot.ts`, `rights/functions.ts`, `membership-functions.ts`, `access-units.ts`, `catalog-command/units.ts`, `contracts.ts` (`AccessContract.scope.verbatim`), `pipeline.ts`, `rights/explain-units.ts`; Test `rights-functions.test.ts`, тест функцій членства, тест `access-units`, `rights-explain.test.ts`.

**Produces:** `snapshotBranches(fact, snapshot, live)` = `SELECT * FROM (<snapshot>) s WHERE <snapshotOwned(fact)> UNION ALL SELECT * FROM (<live>) l WHERE NOT <snapshotPresent(fact)> AND NOT <snapshotForeign()>`; `RIGHTS_FUNCTIONS.scopeSet` (`rights_scope_set(p_scope_kind uuid) RETURNS SETOF uuid`, definer, `EXECUTE` — як функцій множини: користувач, сервісна, команд).

Гілки (лише коли `hasActorSnapshot`): `rights_mine` (`rights`; знімок — `MINE_COLUMNS` з `rights_tx_actor` за xid і `NOT full_access`); `rights_my_scopes` (`scopes`; сигнатура та сама; обидві гілки проєктують рівно `scope_kind_id, scope, member` — живий варіант має ще `catalog`); `rights_dimension_values` (`values`); `_member_scopes`, `_my_member` (`scopes`, `catalog AND scope_kind_id = <вид>`, `_my_member` — ще `scope = p_scope`); `rights_scope_set` (`scopeSets`); `tenantBoundary` виду з дослівною функцією — `ARRAY(SELECT simetra.rights_scope_set('<вид>'))`; `rights_explain` — Р3-8.

- [ ] **Крок 1. Тести:** `renders snapshotPresent and snapshotOwned literally` (рукописний очікуваний текст для `rights`); для кожної функції з гілками — тіло = `snapshotBranches(<факт>, …)` (цілий оператор); `renders no snapshot branch without rights catalogs`; `uses no txid_current() in fact functions` (лише `_if_assigned`); `routes the tenant boundary of a verbatim set function through rights_scope_set`; `judges caller visibility by snapshot-aware functions`.
- [ ] **Крок 2.** Червоні. **Крок 3.** Реалізувати. **Крок 4.** Зелені unit; DB — Задача 6 (спільний коміт).

## Задача 5: гейт тіл і бенчмарк

**Files:** `test/db/rights-plan-gate.db.test.ts`, `test/db/explain-plan.ts`, `bench/rights.bench.db.ts`.

- [ ] **Крок 1.** `ANALYZE` п'яти таблиць знімка в `beforeAll` гейта й на початку кожного сценарію бенчмарку. Висновок бенчмарку — рядок «reads run with an assigned xid».
- [ ] **Крок 2.** `autoExplain` — параметр `before?: string`: оператор від власника з контекстом команди, до підписки на повідомлення.
- [ ] **Крок 3.** Окремий `it.each` `"%s with a snapshot: fact functions read the snapshot by index"` — `rights_mine()` і точкове читання задачі; `before`: `UPDATE <довідник членства> SET <колонка> = <колонка> WHERE false` (тригер оператора спрацьовує на нулі рядків; знімає всі факти). Критерії: тіла читають `rights_tx_header` і таблиці свого факту; піддерево живої гілки (виклик `*_live`) є в плані й має `Actual Loops = 0`; повторних `CTE Scan`/`Seq Scan` немає (`RIGHTS_TABLES` + таблиці знімка). Наявний `it.each` без знімка — без змін, плюс: піддерево гілки знімка є й має `loops = 0`.
- [ ] **Крок 4.** `"rights_role_grants body reads no CTE more than once"` (борг прав §2): від власника `SELECT count(*) FROM simetra.rights_role_grants('scope', '<ORG_KIND_ID>', '<ORG_ADMIN_ID>', <jsonb з 200 рядків дельт allow/deny над доменом рівня>)` під `auto_explain`; рядків > 0; жодного `CTE Scan` з `loops > 1`.
- [ ] **Крок 5.** Бенчмарк: у сценарій 6 — живі варіанти й «зі знімком» (Р3-9 (а)); у сценарії 7 — рядки часу знятих фактів, N і прибирання.
- [ ] **Крок 6.** `pnpm --filter simetra test:db rights-plan-gate`; коміт `test(simetra): гейт тіл прав зі знімком і rights_role_grants; бенчмарк знімка`.

## Задача 6: DB-доказ механізму

Кейси — у `catalog-command-admin.db.test.ts` (наявне розгортання; бракує
виміру, контейнера, регістру зв'язку чи виду з дослівною функцією множини —
розширити спільний будівник). Кожна зміна джерела — `rowCount = 1`. Кожен
запис з контекстом — у точці збереження `commandSteps` (Review Focus 1).

**`proveOpened`** — крок `check` після зміни джерела: від власника під claims
актора `EXISTS` факту, що відкриває `X`, у живому варіанті — `true`, у
публічній функції — `false`. **Близнюк читання** кожного кейсу «hides»: актор
з тим самим фактом з початку транзакції той самий `SELECT X` — ≥ 1 рядок.

- [ ] **Крок 1.** describe `"actor snapshot"`:
  - `keeps the effects of earlier steps visible to later steps` — помічник Задачі 1.
  - `takes the snapshot equal to the live facts of the actor` — актор з правами рівня скоупу, `own`, виміру (регістр і дослівна функція, що дає й `NULL`) і контейнера; до запису публічні функції = живі; після оператора, що знімає всі факти й нічого не змінює, вміст таблиць знімка = живі множини (живу сторону — без `NULL` у `scope`/`member`), кожна непорожня; чотири заголовки.
  - `takes the snapshot before the first change of own membership` (вимога 1) — актор має глобальну роль з правом читання `X` і запрошений рядок членства в `S2` з призначенням; самоприйняття (`asOwner`); далі **без запису в довідники прав** `SELECT X` у `S2` під `simetra_command` — `0` рядків (тримає межа тенанта); `rights_my_scopes()`, `_member_scopes()`, `_my_member('<S2>')` — без `S2`; `proveOpened` (`S2` у `rights_my_scopes_live()`).
  - `judges the self-acceptance of an actor without rights` (Review Focus 5) — актор без жодного рядка прав (модель без ролей `everyUser`): самоприйняття рядка з призначеннями, `immediate: true` → `escalation`. Спільна фікстура має `everyUser` — тоді друге мале розгортання в тому самому файлі (модель без `everyUser`, лише довідник членства й призначень); лише коли воно неможливе — unit-асерт `queues the actor key by the rights header`, з причиною в журналі.
  - `keeps an inactive adopted member out of the snapshot` — прийняте джерело членства з колонкою активності (`adoptedMembership` з `active`) і прийняте джерело призначень; учасник актора неактивний на початку транзакції; оператор, що знімає факти: `rights_tx_scopes` без цього учасника, `rights_tx_actor` без прав його призначення з джерела, `rights_mine()` і `rights_my_scopes()` — без них; контроль — активний учасник того самого джерела дає рядки в обох таблицях знімка.
  - `reads live facts while no source changed` — xid призначено записом не в джерело: публічні функції = живі; заголовків xid немає.
  - `returns empty facts to another actor after a single-fact snapshot` — для кожного факту окремо: запис у джерело лише цього факту (контейнер → `rights`; регістр зв'язку → `values`; таблиця дослівної функції множини → `scopeSets`) знімає один факт актора A; claims → B: функції **усіх** фактів порожні.
  - `returns empty facts to another actor of the transaction` — знімок актора A записом у довідник прав; claims → B: функції фактів порожні, `SELECT X`, видимих B наживо, — `0`; запис у джерело — `rights-context`; `SET CONSTRAINTS ALL IMMEDIATE` — `rights-context`.
  - `retakes the snapshot after a rolled back savepoint`.
  - `keeps the snapshot after a passed immediate check` (Р3-7) — зміна виміру актора (регістр, `asOwner`), `proveOpened`, потім запис у довідник прав, що ставить ключ (призначення іншому користувачу в межах ⊆); `SET CONSTRAINTS ALL IMMEDIATE` проходить; `SELECT X` з обсягом виміру — `0`; заголовки xid є.
  - `cleans the snapshots of finished transactions` — xid закоміченої транзакції: `SELECT txid_current()` на окремому з'єднанні зі стеком (тег прогону — за помічниками `connection.ts`; xid спільні для кластера); рядки з ним у п'яти таблицях (власник); запис, що бере знімок; рядків чужого xid немає, свого — є.
  - `keeps exempt sources out of reach of the command role` — для кожного винятку: `has_any_column_privilege('simetra_command', t, 'INSERT')`, `…'UPDATE'`, `has_table_privilege(…, 'DELETE')`, `…'TRUNCATE'` — `false`; контроль — таблиця виду-джерела: `true`; це DB-доказ, що згенерований SQL ролі команд винятків не відкриває.
  - `takes no snapshot in maintenance mode` — запис у джерело в режимі обслуговування: заголовків xid немає.
  - `revokes execute on live variants from every api role` — `has_function_privilege` для ролей `PROVIDER_API_ROLES` і `simetra_command` на живі варіанти — `false`.
- [ ] **Крок 2.** describe `"the database judges a command by the rights at the start of its transaction"` (вимога 4), через `commandSteps`, без `COMMIT`; у кожному — `proveOpened`. Кейси «hides» закінчуються поверненням джерела й `immediate: true`, що проходить. Для кейсів «refuses» — близнюк без кроку `X`: зміна → повернення → `immediate: true` проходить (кінцевий стан проходить ⊆).
  - `refuses assign → update X → unassign` — `noRight`;
  - `hides X in assign → read X → unassign` — `0`;
  - `refuses assign → update a member row → unassign` — роль дає `own`; `noRight`;
  - `refuses membership → update a member row → revert` — право `own` з початку; зміна членства додає актору учасника, якому належить рядок; `noRight` (тримає `scopes`);
  - `hides X in membership → read X → revert` — межа тенанта (`_member_scopes`);
  - `keeps the catalog rows apart from adopted sources in membership set functions` — рядок прийнятого джерела членства того самого виду (`adoptedMembership`) у `rights_tx_scopes` з `catalog = false`: `_member_scopes()` його не повертає (М17);
  - `hides X in a verbatim scope set → read X → revert` і `refuses a verbatim scope set → update X → revert` — вид з дослівною функцією множини; зміна рядка таблиці виду, яку читає функція; `0` / відмова ядра (`rights_scope_set`);
  - `refuses users as a source → update X → revert`, `hides X in users as a source → read X → revert` — право з обсягом виміру з початку; актор міняє свій рядок регістру зв'язку; `noRight` / `0`;
  - кейс A4 → `the database refuses a direct command the rights granted in its transaction`: `E.forbidden.noRight`, як у контрольного запису (Р-1), плюс `proveOpened`; коментар про Права-3 прибрати.
- [ ] **Крок 3. Ядро ≡ RLS** (`catalog-command-rights.db.test.ts`): підмножина сітки (по точці на обсяг і дію) з варіантом `snapshot: "taken"` — у зовнішній точці збереження під актором точки оператор, що знімає факти (`… WHERE false`), додаткове призначення, що відкриває точку (режим обслуговування), обидва шляхи; результат = результат без призначення. Контроль: без знімка те саме призначення відкриває хоч одну відмовлену точку.
- [ ] **Крок 4. Пояснення** (`rights-analysis.db.test.ts`): `explains only rows visible by the snapshot` — самопризначення ролі, що відкриває рядок (`commandSteps`); `rights_explain` для рядка — порожньо; контроль — актор з цією роллю з початку отримує пояснення; варіант з межею тенанта — самоприйняття членства (`asOwner`).
- [ ] **Крок 5.** Scoped DB: `pnpm --filter simetra test:db catalog-command-admin catalog-command-rights rights-analysis rights-guards rights-functions rights-plan-gate` — зелені, час записати.
- [ ] **Крок 6. Ширший прогін перед комітом** (Review Focus 1): `pnpm --filter simetra test:db rights membership access command` і `pnpm --filter @simetrajs/designer test:db rights promotion apply database`. Червоний тест поза планом — розвилка.
- [ ] **Крок 7.** Коміт (Задачі 4 і 6) `feat(compiler): функції фактів актора читають знімок транзакції`.
- [ ] **Крок 8.** Unit-мутації Задачі 10, чий тест уже є; DB-мутації — після Задачі 8 (Задача 10).

## Задача 7: спеки, скіл, борг

- [ ] **Крок 1. Спека прав §5.1:** «Функції фактів актора» — Р3-1, Р3-3, Р3-4, Р3-8 (аналіз); імена — у «Імена (остаточні)».
- [ ] **Крок 2. §5.2:** межа тенанта виду з дослівною функцією — через `rights_scope_set` (Р3-11, за Р-2).
- [ ] **Крок 3. §7** (пункт ⊆): права актора на початок транзакції — і для читання; момент і джерела (Р3-5, Р3-6, `rights.snapshot-source-unknown`); знімок до кінця транзакції, прибирання й рівень ізоляції (Р3-7); COMMIT — живий стан (Р3-8); функція застосунку, що пише виняток (Р3-13, за Р-4; діагностика — і в §6.1).
- [ ] **Крок 4. Спека П4:** прибрати бар'єр і обмеження хуків членства з §6.5, §6.9, §6.10, §6.12, §6.15, §6.16 (інваріант 17) у формі A4; §6.15 — одне речення: код host-а з пулом `simetra_runtime` — домен довіри Рт6, а права команди в транзакції — права її початку (спека прав §7); §6.11 — читання без xid таблиць знімка не торкається; §6.13 крок 6 — Р3-12. Також: §7.1 рядок «unit T3» і §7.2 DB-кейс бар'єру — переписати на нове очікування (самопризначення в транзакції не діє до COMMIT); §8 — прибрати бар'єр з рядка A4, додати рядок блоку Права-3 (зміст, «готово, коли», «після A4») і порядок «A1 → A2 → A3 → A4 → Права-3 → A6 → A5»; Додаток А — рядок «спека прав §7, ⊆» переписати на кінцевий стан. Причина `rights-context` прямого запису без контексту команди (T0 `COMMAND_CORE_ERRORS`, скіл споживача про прямий запис) лишається.
- [ ] **Крок 5. Скіл споживача** `packages/designer/skills/simetra-metadata/references/people-and-rights.md`: прибрати бар'єр і правило «призначення в хуку членства — останньою фазою»; додати: права, видані в транзакції команди, діють з наступної транзакції; Р3-13 — як виправити (`REVOKE EXECUTE … FROM PUBLIC`).
- [ ] **Крок 6. Борг:** у `docs/superpowers/plans/2026-10-26-rights-residual-debt.md` зняти «Тіло `rights_role_grants` поза гейтом тіл функцій прав» (посилання на цей план); у `docs/superpowers/plans/2026-10-30-archive-residual-debt.md` пункт «Хибна `escalation` у `SET CONSTRAINTS ALL IMMEDIATE`» — переписати за Р3-7 (знімок береться раз на транзакцію) або зняти з посиланням, якщо кейс `keeps the snapshot after a passed immediate check` його закриває. Новий пункт боргу прав: гейт живих ACL таблиць-винятків під час застосування (Р3-13) — природне місце поруч із гейтом `plan.write-path` designer. `docs/ROADMAP.md` — статус Права-3, якщо рядок є.
- [ ] **Крок 7.** Перевірка якорів — повний гейт: Задача 9 крок 1.
- [ ] **Крок 8.** Коміт `docs(spec): права актора на початок транзакції — знімок фактів`.

## Задача 8: видалення бар'єру T3

- [ ] **Крок 1.** `hooks.test.ts`: `refuses a second member of a batch when the membership onWrite assigns a role` → `runs a second member of a batch when the membership onWrite assigns a role`: пакет `[create, { ...create, id: OTHER }]` успішний; `db.calls` — дві фази `Client` і дві фази призначення в порядку пакета, потім `COMMIT` (помічники `harness.ts`). Червоний до кроку 2.
- [ ] **Крок 2.** Видалити код Р3-14, describe `"rights barrier in a batch"` (`transaction.test.ts`) і `"rights barrier in hooks"` (`hooks.test.ts`, крім кроку 1), помічники, яких ніхто більше не читає.
- [ ] **Крок 3.** `pnpm --filter simetra test server`; `typecheck`, `lint`; `git grep -n "checkBarrier\|startPhase\|rightsPhase\|isRightsObject\|isRightsContext" -- packages` — порожньо.
- [ ] **Крок 4. Designer DB:** describe `"the T3 barrier after a rights phase"` → `"the database judges a batch by the rights at the start of its transaction"`: `assign → update X → unassign in one batch`, `assign → update X through ctx.run in a hook`, `assign → update a member row → unassign` — `command.forbidden`, причина `noRight`, відкат; `assign → read X → unassign through a hook` — `ctx.read` порожній, пакет комітиться; контроль — актор з роллю з початку той самий хук бачить `X`. `transfers fullAccess in one batch, own assignment first` — без змін. Новий `reads through rights functions in a read only transaction without an xid` — з'єднання з тінню, `BEGIN READ ONLY`, claims актора, роль API користувача: `SELECT X` дає рядки за правами; після читання `txid_current_if_assigned()` `IS NULL` і `pg_stat_xact_user_tables` має рівно п'ять рядків таблиць знімка з `seq_scan + idx_scan = 0`; контроль в окремій транзакції не `READ ONLY`: xid призначено записом не в джерело, те саме читання — сканів > 0. Scoped: `pnpm --filter @simetrajs/designer test:db rights-admin-commands`.
- [ ] **Крок 5.** Ширший прогін (Review Focus 1): `pnpm --filter simetra test server`, `pnpm --filter simetra test:db catalog-command`, `pnpm --filter @simetrajs/designer test:db rights`.
- [ ] **Крок 6.** Коміт `refactor(server): прибрано тимчасовий бар'єр T3 — права команди тримає знімок бази`.

## Задача 9: гейти, рецензія, контрольна точка, зведення

- [ ] **Крок 1. Вікно гейтів** (одне на блок), за «можна», на SHA гілки після Задачі 8 і мутацій: повні гейти з Global Constraints з часом кожного; бенчмарк «до» і «після» підряд, на тій самій машині: «до» — в окремому worktree на `BENCH_BASE` (`git worktree add <scratchpad>/rights3-base BENCH_BASE`, `pnpm install`, `pnpm --filter simetra bench:rights`, потім `git worktree remove`), «після» — на SHA гілки; таблиці — у scratchpad-теку сесії (`bench-before.md`, `bench-after.md`, повні шляхи — у звіт); поріг Р3-9. Червоне — виправити й повторити лише зачеплене (швидкі гейти + scoped DB).
- [ ] **Крок 2.** Лінзи `code-review` (агент `code-review`, по одній; межа — `origin/main...feat/rights-3`): `correctness` (обхід знімка, момент, гонки прибирання, A6), `test-honesty`, `drift`. Кожна знахідка — `code-review-verifier`; підтверджене — окремим комітом; після виправлень — швидкі гейти й scoped DB зачеплених файлів. Codex коду запускає архітекторка.
- [ ] **Крок 3. Звіт архітекторці** (контрольна точка): SHA і коміти; журнал мутацій; гейти й scoped DB з часом (приріст DB > 15 с — пояснити); бенчмарк до/після (накладні без знімка — окремим числом); рішення з полем «вплив на спеку»; відкриті розвилки. Чекати «далі».
- [ ] **Крок 4. Після «так»:** `git merge origin/main` → повтор гейтів лише якщо `main` приніс код у зачеплені області (тоді — швидкі гейти й scoped DB цих областей) → `git push -u origin feat/rights-3` → `gh pr create` у `main` (українською, без трейлерів) → номер PR архітекторці; повний `test:db` — у CI, мердж за зеленим CI.

## Задача 10: мутації (після Задачі 8, до Задачі 9)

DB-мутації — для правил безпеки (М1–М7, М7а, М11–М15, М17, М18, М19, М20, М21, М25, М27, М27а),
лише на закоміченому дереві; решта — unit-мутації (М8–М10, М16, М22–М24, М26, М28). Scoped прогін; очікування —
названий червоний тест; потім `git checkout -- .`. Журнал: мутація, рівень,
команда, червоний тест, час.

| № | Мутація | Має почервоніти |
| --- | --- | --- |
| М1 | `snapshotBranches` — лише жива гілка | усі кейси Задачі 6 крок 2, designer крок 8.4 |
| М2 | `rights_my_scopes` — лише жива | `refuses membership → update a member row → revert` |
| М3 | `rights_dimension_values` — лише жива | кейси «users as a source»; `keeps the snapshot after a passed immediate check` |
| М4 | `_member_scopes` — лише жива | `hides X in membership → read X → revert` |
| М5 | `_my_member` — лише жива | асерт `_my_member('<S2>')` у `takes the snapshot before the first change of own membership` |
| М6 | `rights_scope_set` — лише жива | `hides X in a verbatim scope set → read X → revert` |
| М7 | `snapshotOwned` без умови актора | `returns empty facts to another actor of the transaction` |
| М7а | жива гілка без `NOT snapshotForeign()` | `returns empty facts to another actor after a single-fact snapshot` |
| М8 | тіло знімка кличе `rights_mine()` | unit `computes the snapshot and the actor check from live variants` (на DB рівнозначна: заголовок пишеться після рядків) |
| М9 | `snapshotSources` пропускає головні таблиці контейнерів | `maps the sources of the fixture to their facts` |
| М10 | `snapshotSources` класифікує невідоме відношення як виняток | `reports an unknown relation` |
| М11 | тригер знімка `AFTER` замість `BEFORE` | `takes the snapshot before the first change of own membership` |
| М12 | `actorCheck` «після» з `rights_mine()` | кейс `rights-guards.db` «самоприйняття рядка з призначеннями — `escalation`» |
| М13 | `rights_tx_check` знову видаляє знімок на спорожнілій черзі | `keeps the snapshot after a passed immediate check` |
| М14 | прибирання без `rights_tx_values` | `cleans the snapshots of finished transactions` |
| М15 | поколонковий `GRANT INSERT (…)` на виняток для `simetra_command` у фікстурі | `keeps exempt sources out of reach of the command role` |
| М16 | живий варіант з `executeGrants(…, ["command"])` | `revokes execute on live variants…` (unit і DB) |
| М17 | фільтр `catalog` прибрано з `_member_scopes` | тест функцій членства (рядок джерела того самого виду) |
| М18 | знімок береться й у режимі обслуговування | `takes no snapshot in maintenance mode` |
| М19 | `present` — `EXISTS` без охорони `txid_current_if_assigned() IS NULL` | designer `reads through rights functions in a read only transaction without an xid` (сканів > 0). Форма `AND` замість `CASE` — рівнозначна мутація, коли планувальник ставить дешевшу умову першою: записати з `EXPLAIN` як доказ |
| М20 | `rights_explain` судить викликача варіантом `_of` | `explains only rows visible by the snapshot` |
| М21 | `actorPending` знову шукає рядок `rights_tx_actor` | `judges the self-acceptance of an actor without rights` (або unit `queues the actor key by the rights header`) |
| М22 | діагностика Р3-13 ігнорує типовий `EXECUTE` для `PUBLIC` | `refuses a definer function writing an exempt table…` |
| М23 | діагностика Р3-13 ігнорує поколонковий грант | `refuses a grant of DML on an exempt table…` |
| М24 | спільний розбір шляхів запису ігнорує `PUBLIC` | `refuses a grant of DML on an exempt table to public or the command role` |
| М25 | `tenantBoundary` ядра (`catalog-command/units.ts`) кличе дослівну функцію напряму | `refuses a verbatim scope set → update X → revert` |
| М26 | правило (г) враховує `EXECUTE` тригерної функції | `refuses a definer trigger function writing an exempt table` |
| М27 | `rights_my_scopes_live` (гілка `withOrigin`) без `activeCondition` джерела | `keeps an inactive adopted member out of the snapshot` (асерт `rights_tx_scopes`) |
| М27а | `sourceAssignments` без `activeCondition` | `keeps an inactive adopted member out of the snapshot` (асерт `rights_tx_actor`) |
| М28 | обхід записів не бачить DML у `WITH` | `refuses a definer function writing an exempt table through a data-modifying CTE` і наявний «a data-modifying CTE» |

## Журнал мутацій

(заповнює виконавець)

## Самоперевірка плану (автор)

- Вимоги архітекторки: 1 — Задача 6 крок 1; 2 — Р3-9, Задачі 0.4, 5, 9.1; 3 — Задача 6 крок 3; 4 — Задача 6 крок 2, Задача 8 крок 4, М1–М6; 5 — Задачі 7–8.
- Бриф: гілки за `txid_current_if_assigned()` — Р3-3; живі варіанти для запобіжників — Р3-4, Р3-8; один генератор і `relationReads` — Р3-6; A6 — Р3-12.
