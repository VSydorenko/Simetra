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
| Р3-1 | **Факти актора — чотири:** `rights` (входи `rights_mine` — Р3-15), `scopes` (мої скоупи з учасниками), `values` (мої значення вимірів), `scopeSets` (вихід дослівних функцій множини виду скоупу, Р3-11). Дві гілки мають: `rights_mine`, `rights_my_scopes`, `rights_dimension_values`, `<членство>_member_scopes`, `<членство>_my_member`, нова `simetra.rights_scope_set(p_scope_kind uuid)`. Решта (`rights_any`, `rights_own`, `rights_dim`, `rights_container`, `has_right`, `rights_my_members`, `rights_versions`, `analysisGate`) читає факти лише через них. `rights_visible_users` бере мої скоупи зі знімка, а рядки інших учасників — наживо (дані, не права актора); `current_user_carrier_sources()` — дані рядка. Носії контейнера — рядки `rights_mine` | одне місце на факт | спека прав §5.1 |
| Р3-2 | **Сховище:** `simetra.rights_tx_header (xid bigint, fact text, actor uuid)`, PK `(xid, fact)`; таблиці входів факту `rights` — Р3-15 (`rights_tx_actor` видаляється); `simetra.rights_tx_scopes (xid, scope_kind_id, scope, member, catalog boolean)`, індекс `(xid, scope_kind_id, scope)`; `simetra.rights_tx_values (xid, dimension_id, value uuid NULL)`, індекс `(xid, dimension_id)`; `simetra.rights_tx_scope_sets (xid, scope_kind_id, scope)`, індекс `(xid, scope_kind_id)`. Усі `rowLevelSecurity: "off"`, без грантів. `catalog` — рядок довідника членства (функції членства виду читають лише такі). Рядки скоупів з `NULL` у `scope`/`member` у знімок не пишуться (живі функції їх не зіставляють) | заголовок серед рядків прав шукався б перебором; індекс `scope` — для `_my_member(p_scope)` на рядок | спека прав §7 |
| Р3-3 | **Присутність і власник:** `present(fact)` = `CASE WHEN txid_current_if_assigned() IS NULL THEN false ELSE EXISTS (SELECT 1 FROM simetra.rights_tx_header h WHERE h.xid = txid_current_if_assigned() AND h.fact = '<fact>') END`; `owned(fact)` — те саме з `AND h.actor IS NOT DISTINCT FROM (SELECT simetra.current_user_id())`; `foreign()` — `CASE` з тією самою охороною й `EXISTS` заголовка **будь-якого** факту цього xid з `actor IS DISTINCT FROM (SELECT simetra.current_user_id())`. `CASE`, бо кон'юнкти верхнього рівня планувальник переставляє за ціною. Гілка знімка — під `owned(fact)`, жива — під `NOT present(fact) AND NOT foreign()`: актор транзакції закріплюється першим знятим фактом, і інший актор не отримує живих фактів навіть тих, яких ще не знято (fail-closed; так само сесія без користувача — `current_user_id()` `NULL` — після знімка користувача отримує порожні факти, і це навмисно); другий запис у джерело — відмова тіла знімка `rights-context`; COMMIT відмовляє `actorCheck`, коли в черзі ключ `actor`. Без xid (`READ ONLY` §6.11, PostgREST) таблиць знімка не читає ніхто | `txid_current()` видав би xid кожному читанню | спека прав §5.1 |
| Р3-4 | **Живі варіанти:** `rights_mine_live()`, `rights_my_scopes_live()` (+ колонка `catalog`), `rights_my_members_live(p_scope_kind)`, `rights_dimension_values_live(p_dimension)`, `rights_scope_set_live(p_scope_kind)` — форма `stable` (`LANGUAGE sql STABLE SET search_path = ''`, invoker), `executeGrants(…, [])`; тіла — ті самі будівники з `RightsUser` `LIVE`. Кличуть їх лише функції від власника; права пари `rights_mine(p_object, p_action)` — Р3-16 | одне тіло на факт; без `EXECUTE` знімка не обійти | спека прав §5.1 |
| Р3-5 | **Момент знімка.** Тригер `BEFORE INSERT OR UPDATE OR DELETE … FOR EACH STATEMENT` (мітка `simetra_rights_snapshot`, функція на таблицю, як зараз) на кожному джерелі; тіло знімає лише відсутні факти цього джерела. Лише з контекстом команди й не в режимі обслуговування: DML у таблиці виду має лише `simetra_command`, порожній контекст відмовляє `RESTRICTIVE`-політика `<t>_command_*` (§5.3). Факти рахують живі варіанти (факт `rights` — генератори входів, Р3-15), тож знімок успадковує їхні фільтри: умову активності й умову рядків прийнятих джерел членства й призначень (`activeCondition`, `sourceConditions` у `myScopesBody`, `sourceAssignments`) і дієвість носіїв (`fullAccessHolderRows`); гілка знімка читає вже відфільтровані рядки й повторно не фільтрує. Заголовок факту — після його рядків. Оператор, що взяв знімок, сам читає живі факти — вони рівні знімку | доказ — Задача 6 | спека прав §7 |
| Р3-6 | **Джерела — аналізом, fail-closed.** `snapshotSources` будує для кожного факту замикання викликів тіл його живих варіантів (`relationReads` над `[head, ...reachableUnits(head, …)]` — `reachableUnits` голови не повертає; голови — живі варіанти факту; згенеровані одиниці — як `VerbatimUnit`) над **повним** переліком базових одиниць — згенеровані функції прав, членства й платформного шару (`current_user_id` читає «Користувачів» і `simetra.identities`) плюс дослівні — бо `reachableUnits` мовчки пропускає нерозв'язаний виклик; і класифікує кожне відношення: таблиця виду (не `declared`) — джерело цього факту; подання моделі — прозоре (його базові відношення класифікуються за тим самим правилом); матеріалізоване подання — виняток `materializedView`, лише коли всі його базові відношення — винятки, інакше помилка; виняток — прийняті джерела членства й призначень та їхні таблиці ролей (§4.7: на прийняту таблицю платформа тригерів не ставить), `CustomTable` (вид `declared`), `simetra.identities`, `simetra.rights_tx_*`; посилання без схеми — джерело чи виняток, лише коли кожен можливий збіг ним є; будь-що інше — помилка компілятора `rights.snapshot-source-unknown`. Винятки тримає Р3-13 | вивід з тих самих тіл, що читають факти; невідоме відношення не мовчить | спека прав §7 |
| Р3-7 | **Знімок живе до кінця транзакції.** `rights_tx_check` знімка не видаляє. Тіло знімка, коли бере хоч один факт і `current_setting('transaction_isolation') = 'read committed'`, спершу прибирає рядки завершених транзакцій: для кожної таблиці знімка (Р3-15) окремо `DELETE FROM t WHERE ctid = ANY (ARRAY(SELECT ctid FROM t WHERE xid <> txid_current() FOR UPDATE SKIP LOCKED))`. Чужі видимі рядки — лише закомічені; замок рядка й видалення — в одному операторі, тож прибиральники не чекають один одного. В інших рівнях ізоляції прибирання пропускається (його зробить наступний знімок у `read committed`) | видалення на спорожнілій черзі відкривало діру: пройдена `SET CONSTRAINTS ALL IMMEDIATE` прибирала знімок, і зміни, яких ⊆ не судить (виміри, членство без призначень), діяли б до COMMIT | спека прав §7 |
| Р3-8 | **Запобіжники на COMMIT.** `actorPending` ставить ключ `actor`, коли є заголовок факту `rights` цього xid (а не рядок `rights_tx_actor`: у актора без прав рядків немає). `actorCheck` бере «після» з `rights_mine_live()`, «до» — `startRights` над входами знімка (Р3-15), актора — з `rights_tx_header`. Перевірки ролі й призначення — образи рядків і `rights_role_grants`; `last-full-access` — таблиці (`fullAccessHolderRows`). Функції аналізу чужого користувача (`_of`) — живі. `rights_explain` судить видимість викликача функціями зі знімком: CTE викликача перебудовано на `rights_mine` (колонки `role_id`, `custom_role` — `NULL`), `rights_my_members`, `rights_dimension_values`, функції множини виду | приріст — проти живого кінцевого стану; пояснення ≡ RLS викликача | спека прав §5.1, §7 |
| Р3-9 | **Продуктивність — поріг (затверджено архітекторкою; перевищення будь-якого — розвилка до неї).** (а) Накладні гілок — серверний замір (сценарій 6): plpgsql-цикл з `clock_timestamp()`, K = 1 000 викликів на зразок однієї форми для обох сторін (`PERFORM count(*) FROM f(…)`), ≥ 31 чергований зразок публічної функції й живого варіанта (`rights_mine`, `rights_my_scopes`, `_member_scopes`, `_my_member(p_scope)`, `rights_scope_set`) на малому обсязі; без знімка — медіана ≤ базова лінія тієї самої публічної функції на `BENCH_BASE` (до блоку) × 1,05 + 2 мкс **і** медіана різниці з живим варіантом ≤ 30 мкс на виклик без знімка (xid призначено записом не в джерело); зі знімком ≤ живий варіант × 1,05 + 10 мкс; довірчий інтервал — у звіті. (б) Сценарії 1–3 до/після — звіт; розвилка, коли клітинка ≥ 5 мс зросла > 10 %. (в) Перший запис команди (сценарій 7, власна модель): у контейнер, у таблицю дослівної функції виміру, у довідник членства — для звичайного актора й для актора найбільших обсягів сценаріїв 1 і 2; абсолютний приріст до/після ≤ 1,25 × час знятих фактів + 10 мкс × N рядків, **і** розвилка до мерджу, коли приріст першого запису > 5 мс для звичайного актора чи > 50 мс для найбільшого; час фактів — сума `total_time` кожного верхнього виклику `*_live` з тіла знімка з `pg_stat_xact_user_functions` (поріг застосовується лише коли `calls > 0` кожного; живі варіанти з `SET search_path` не вбудовуються, і гейт тіл це тримає) у тій самій транзакції до відкату (`track_functions = 'all'` — з'єднанням суперкористувача `testSuperuserUrl`, або `has_parameter_privilege` і зупинка з помилкою); окремі рядки — прибирання N рядків чужого закоміченого xid (розвилка > 2 мс на 1 000 рядків), запис у «Користувачів» (знімає всі чотири факти), і C = 10 відкритих транзакцій з великим знімком під час прибирання; у звіт — розмір кожної таблиці `SNAPSHOT_TABLES` і `n_dead_tup` після сценарію (церн рядків до наступного знімка). (г) Сценарій 5 (1 і 1 000 команд): ≤ +10 %; критерій (в) для першого запису замінено розвилкою (2): Σ операторів заповнення знімка — Задача 5, доповнення | замір у прогоні на сервері — шум мікросекунд, не мілісекунд | немає |
| Р3-10 | **Очікування DB-кейсу A4** «the database still lets a direct command use rights granted in its transaction»: після Права-3 оновлення після самопризначення відмовляє ядро **тією самою причиною, що контрольний запис без ролі** (`E.forbidden.noRight`); `rights-context` — причина бар'єру T3. **Розвилка Р-1** | — | немає |
| Р3-11 | **Дослівна функція множини виду** (`setFunction` об'єктом) — під знімок: `tenantBoundary` (обидва виклики: `access-units.ts` і ядро `catalog-command/units.ts`) для такого виду кличе `simetra.rights_scope_set('<вид>')` (дві гілки; жива — `rights_scope_set_live`, що кличе дослівну функцію виду); `AccessContract.scope` отримує поле `verbatim: boolean` — лише коли `hasActorSnapshot` (без довідників прав межа тенанта — як зараз); `EXECUTE` дослівної функції множини лишається (платформна спека §6.7): її прямий виклик SQL застосунку — домен застосунку, а межа тенанта й ядро йдуть через обгортку; `scopeSetMatch` у `rights/explain-units.ts` для викликача — через `rights_scope_set` / `_member_scopes`; джерела — за Р3-6. Вид `setFunction: "membership"` — як зараз (`_member_scopes`). **Розвилка Р-2**: альтернатива — дослівна функція лишається живою, а читання нею джерела прав (довідників прав, членства) — помилка компілятора, і обмеження в §7 | дослівна функція може читати довідники членства й призначень, які ⊆ судить; без бар'єру T3 діра лишилася б | спека прав §5.2 (межа тенанта), §7 |
| Р3-12 | **A6 (спека П4 §6.13 крок 6):** A6 дописує в `rights_tx_typed` рядок призначення архетипу `rootCreator` на рівні скоупу `p_root`, рядок `rights_tx_holders`, коли архетип має `fullAccess`, і рядок `rights_tx_scopes` (новий скоуп, учасник-творець, `catalog = true`); замикання рахує спільний `mineBody` гілки знімка (Р3-15). Права-3 правлять лише текст §6.13 | межа тенанта й `own` читають знімок | спека П4 §6.13 |
| Р3-13 | **Шлях запису в таблицю-виняток — закритий у SQL застосунку.** Помилка компілятора `rights.snapshot-exempt-writer`, коли дослівний SQL відкриває ролі команд (`simetra_command`) чи `PUBLIC` запис у таблицю-виняток Р3-6: (а) `GRANT INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`, табличний чи поколонковий, або типові привілеї схеми винятку, що дають такий грант (`ALTER DEFAULT PRIVILEGES`); модель — **таблицю ніхто не пише без гранту**; (б) подання з правом запису над винятком без `security_invoker`, доступне їм; (в) функція чи процедура `SECURITY DEFINER` (зокрема через `ALTER FUNCTION … SECURITY DEFINER`, `functionSettingsOf`), замикання якої пише виняток (`bodyKindTable` з `sql/kind-table-verbatim.ts` над винятками як `KindTables`, з поданнями; запис у вкладеному `WITH … AS (INSERT|UPDATE|DELETE|MERGE …)` — теж запис: `statementsOf` (`sql/function-body.ts`) уже збирає вкладені оператори, зокрема `CommonTableExpr.ctequery`, і правило 1 це тримає тестом «a data-modifying CTE» у `kind-table-verbatim.test.ts`), коли SQL не відкликає `EXECUTE` від `PUBLIC` **явно** (`REVOKE EXECUTE ON FUNCTION <сигнатура> FROM PUBLIC` без пізнішого `GRANT` `PUBLIC` чи ролі команд) або дає його ролі команд; типові привілеї (`ALTER DEFAULT PRIVILEGES`, глобальні чи `IN SCHEMA`) відкликанням не рахуються: вони діють лише на об'єкти, створені після них і лише названою роллю — для функцій `PUBLIC` має `EXECUTE` за замовчуванням; (г) тригерна функція `SECURITY DEFINER` (`RETURNS trigger`), замикання якої пише виняток і яку SQL застосунку чіпляє `CREATE TRIGGER` до будь-якої таблиці, — незалежно від `EXECUTE` (тригер його не потребує). Правило діє лише за `hasActorSnapshot`. Спільний з гейтом шляху запису промоції лише розбір грантів і типових привілеїв: гілки `GrantStmt` і `AlterDefaultPrivilegesStmt` (`writeGrant` і зіставлення цілей) з `writePathProblems` (`compiler/operations/promote/gates.ts`) винести в `compiler/sql/write-paths.ts` з параметрами (одиниці, ролі, таблиці); гілка політик запису лишається в гейті промоції (у Р3-13 політика без гранту запису не відкриває); (б)–(г) — новий код. Повідомлення (en/uk) називає річ, яку прибрати: грант (одиниця й роль), подання чи функцію `SECURITY DEFINER`, і таблицю-виняток. Обчислюється в `pipeline.ts` після генерації (потрібен перелік винятків). Живі ACL прийнятої таблиці в цільовій базі компілятор не бачить: роль команд створює платформа, тож давніх грантів їй бути не може, а новий грант іде через SQL застосунку — обмеження §7 і пункт боргу (гейт живих ACL під час застосування). **Розвилка Р-4**: альтернатива — попередження й обмеження §7 | без правила виняток тримався б лише фікстурою | спека прав §4.7, §6.1, §7 |
| Р3-14 | **Бар'єр T3 видаляється повністю**: `Transaction.rightsPhase`, `startPhase`, `checkBarrier`, `RIGHTS_CONTEXT`, `isRightsContext`, `isRightsObject` (`server/transaction.ts`), виклики в `server/phase.ts`, `server/hook-context.ts`, ре-експорт `administerRightsAction` у `model/kinds/registry.ts`, якщо його більше ніхто не імпортує; тести бар'єру; текст бар'єру в спеці П4 і скілі споживача (у формі, яку внесе A4) | принцип 5 | спека П4 §6.5, §6.9, §6.10, §6.12, §6.13, §6.15, §6.16, §7.1, §7.2, §8 (рядок A4 без бар'єру; новий рядок блоку Права-3; порядок A1 → A2 → A3 → A4 → Права-3 → A6 → A5), Додаток А; спека прав §7 (пункт ⊆); скіл споживача |
| Р3-15 | **Факт `rights` — входи `rights_mine`, а не її вихід** (рішення архітекторки, замінює форму `rights_tx_actor` з Р3-1, Р3-2, Р3-5, Р3-8). Вихід для актора з 2 000 скоупів — 152 тис. рядків (скоупи × проєкція ролі), знімок виходу коштував би ~3,5–4 с. **Таблиці входів** — виходи вхідних CTE `mineBody`, звужені до актора: `simetra.rights_tx_typed (xid, storage, storage_id, scope_kind_id, scope, container, custom_role, archetype, level, level_id)` — рядки CTE `typed`, індекс `(xid)`; `simetra.rights_tx_containers (xid, level_id, container, scope_kind_id, scope)` — рядки CTE `containers`, на які посилається `typed` цього xid, індекс `(xid, level_id, container)`; `simetra.rights_tx_deltas (xid, storage, storage_id, custom_role, scope_key, effect, object, action, extent, dimension_id)` — рядки CTE `deltas` кастомних ролей з `typed` цього xid, індекс `(xid, storage, custom_role, scope_key)`; `simetra.rights_tx_holders (xid, level, level_id, scope)` — носії `fullAccess` актора (`fullAccessHolderRows`, як зараз), індекс `(xid)`. Типи колонок — типи колонок відповідних CTE. `rights_tx_actor` видаляється. **Заповнення** — тими самими генераторами (`assignmentsCte`, `typedCte`, `containersCte`, `deltasCte`) з `RightsUser` `LIVE`: `activeCondition`/`sourceConditions` прийнятих джерел діють на заповненні без окремого успадкування. **Джерела (Р3-6):** голови факту `rights` — синтетична одиниця вхідного запиту (не розгортається) і `fullAccessHolderRows`; таблиця членства — джерело **і `scopes`, і `rights`** (носії читають її напряму, і `actorPending` ставить ключ `actor` лише за заголовком `rights`), тож обидва факти знімаються першим записом у членство, і живі скоупи в живій гілці дорівнюють скоупам початку. **Диспетчер** (розвилка (1), варіант (а)): `rights_mine()` і `rights_mine(p_action, p_object)` (Р3-16) — `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''`, `EXECUTE` — як зараз у `rights_mine()`; тіло — `IF <snapshotOwned('rights')> THEN RETURN QUERY <mineBody над snapshotInputs>; ELSIF NOT <snapshotPresent('rights')> AND NOT <snapshotForeign()> THEN RETURN QUERY <mineBody над liveInputs(LIVE)>; END IF;` — обидві гілки — згенерований `mineBody`, без ручного SQL; рядки «кожного користувача» — усередині гілки, тож чужий актор їх не отримує. План кожного `RETURN QUERY` кешується на сесію, мертву гілку не планує ніхто (SQL-функцію з `SET search_path` Postgres планує на кожен виклик). Решта функцій фактів — SQL-гілки Р3-3; диспетчер для них — беклог. **`rights_mine_live()`** — повністю живий SQL — для `actorCheck` «після» й бенчмарку. **На COMMIT** (розвилка (3)): лінивий кеш `simetra.rights_tx_start (xid, level, level_id, scope, container, object, action, extent, dimension_id, full_access)`, індекс `(xid)` — форма колишнього `rights_tx_actor`; першою перевіркою черги цього xid, що його потребує, заповнюється з `startRights` (`mineBody` над `snapshotInputs`, повний, `user` — актор заголовка `rights`) і `rights_tx_holders` (`full_access = true`); `actorCheck` «до» й покриття кожного `escalationSql` читають кеш. Одна повна оцінка на адміністративну транзакцію — як на `BENCH_BASE` (там її робив знімок). Прибирання кешу — Р3-7, тим самим лінивим механізмом. **`rights_explain`** — detail-варіант того самого генератора над входами знімка, коли `owned`, інакше над живими | обсяг ∝ призначенням і дельтам (~2 000 рядків для найбільшого актора); семантика тотожна за побудовою | спека прав §5.1, §7 |
| Р3-16 | **Варіант A — права пари** (рішення архітекторки). Нова публічна `simetra.rights_mine(p_action text, p_object text)` (порядок і типи — як у `rights_any`: `object` — текстова мітка) — диспетчер Р3-15 з тілом `mineBody` з `pair`: фільтр `object = p_object AND action = ANY (<p_action> ∪ req*(p_action))` у **обох** гілках `role_rows` (рядки проєкції архетипу й дельти `allow`), у рядках `deny` вікна й у рядках «кожного користувача»; `req*` — `SELECT q.required FROM rights_requires() q WHERE q.object = p_object AND q.action = p_action` (`rights_requires` транзитивно замкнене). **Контракт:** вихід `rights_mine(a, o)` = рядки повного `rights_mine()` з `object = o AND action ∈ {a} ∪ req*(a)` — точно (`closurePass` з'єднує вимоги лише за `q.object = g.object`, вікно `deny` розбите за `(…, object, action, …)`, тож фільтр бере розбиття цілими). Гранти й `EXECUTE` — як `rights_mine()`. Через пару: `rights_any`, `rights_own`, `rights_dim`, `rights_container`, `has_right` і `analysisGate` (`rights_mine('administerRights', <мітка>)`); повний `rights_mine()` — для `_of`, `rights_explain`, `startRights`. Ядро ≡ RLS не зачіпає: обидва кличуть ті самі функції | перевірка RLS для актора з 2 000 скоупів — 2 821 → 68 мс (дослідження `rights_mine`); без A поріг Р3-9 (в) недосяжний навіть зі знімком входів | спека прав §5.1, §5.4 (правило: функції множин рахують лише запитану пару з замиканням вимог) |

## Розвилки — розв'язано архітекторкою

- **Р-1** (Р3-10): `noRight` замість `rights-context` у переписаному кейсі A4 — **так**. Вплив: немає.
- **Р-2** (Р3-11): **рішення — обгортка `simetra.rights_scope_set` зі знімком.** Варіанти були: під знімком через обгортку (рекомендовано) чи жива з забороною читати джерела прав. Вплив: §5.2/§7.
- **Р-3** (Р3-9): пороги затверджено з доповненням до (а) — шлях без знімка ≤ базова лінія `BENCH_BASE` × 1,05 + 2 мкс.
- **Р-4** (Р3-13): **рішення — помилка `rights.snapshot-exempt-writer` (fail-closed), з підказкою, що прибрати.** Варіанти були: помилка (рекомендовано) чи попередження, коли SQL застосунку відкриває ролі команд запис у таблицю-виняток; живі ACL цільової бази — борг. Вплив: §6.1/§7.
- **Р-5** (до відома): сценарії діри через `commandAs` неможливі — він відкочує свою точку збереження після одного оператора; сценарії йдуть через багатокроковий `commandSteps` (той самий шлях: claims, контекст, `simetra_command`, повз T3) і через `runtime.run`. «Користувачі як джерело» — регістр зв'язку виміру з суб'єктом-«Користувачем»: сам рядок «Користувачів» живить факти лише через `current_user_id()`, а `invalid`/`user_kind` команда не пише. Зміни джерел, яких політики не відкривають (самоприйняття), — від власника з контекстом команди, як у наявних тестах запобіжників.
- **Р-6** (до відома): видалення таблиці `rights_tx_actor` (Р3-15; до того — колонки `actor`) — руйнівна зміна для рушія схеми; застосування над стендом з A4 потребує дозволу `destructive` (таблиця між транзакціями порожня); споживачів з розгорнутим A4 немає, тож дозвіл торкається лише тестових стендів — це явно в звіті Задачі 9.
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

6. **Планувальник на таблицях входів з постійним обертом рядків** — з'єднання `deltas` з `held` за індексом власника і замикання не повинні деградувати після прибирання. Тест — гейт тіл зі знімком (Задача 5 крок 3) на `rights_mine(p_object, p_action)` і бенчмарк сценарію 7.

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

**Порядок:** 0 → 1 → 2 → 3 → 3а → 4 + 6 (один коміт) → 5 → 7 → 8 → 10 (DB-мутації на закоміченому дереві) → 9.
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

## Задача 3а: знімок входів факту `rights` і кеш COMMIT (Р3-15)

Поведінка читання не змінюється: публічні функції знімка ще не читають
(це Задача 4). Задача 3 поклала наповнення факту `rights` в окремий генератор
`rightsFactRows` (`guard-units.ts`); тут він переходить з виходу
`rights_mine_live()` на входи, а COMMIT — на кеш `rights_tx_start`.

**Files:** `rights/admin-tables.ts`, `rights/actor-snapshot.ts`, `rights/functions.ts` (`mineBody` з `inputs`, експорт генераторів вхідних CTE), `rights/guard-units.ts` (`rightsFactRows`, кеш, `actorCheck` «до», `escalationSql`), `rights/snapshot-sources.ts` (голова факту `rights` — синтетична одиниця вхідного запиту плюс `fullAccessHolderRows`); Test `rights-admin-tables.test.ts`, `rights-functions.test.ts`, `rights-guards.test.ts`, `rights-snapshot-sources.test.ts`, `test/db/rights-guards.db.test.ts`.

**Produces:**
- `SNAPSHOT_TABLES = { header, typed, containers, deltas, holders, start, scopes, values, scopeSets }` (без `actor`); прибирання Р3-7 — для кожної з дев'яти таблиць.
- `interface MineInputs { typed: string; containers: string; deltas: string }`; `liveInputs(contracts, physical, style, user: RightsUser): MineInputs`; `snapshotInputs(xid: string): MineInputs` (читання таблиць входів за `xid`); `mineBody(contracts, physical, style, user, detail, inputs: MineInputs, pair?: MinePair)`; `interface MinePair { action: string; object: string }` (SQL-вирази).
- `startRights(contracts, physical, style, xid: string): string` — `mineBody` над `snapshotInputs(xid)`, повний, `user` — `(SELECT h.actor FROM simetra.rights_tx_header h WHERE h.xid = <xid> AND h.fact = 'rights')`.
- `startCache(xid: string): string` — оператор plpgsql-тіла `rights_tx_check`: коли рядків `rights_tx_start` цього xid ще немає — `INSERT … SELECT` зі `startRights` і `rights_tx_holders`; рядок-маркер `(xid, NULL…, full_access = false)` пишеться завжди, щоб порожні права актора теж були «закешовані».

- [x] **Крок 1. Тести:**
  - `rights-admin-tables.test.ts`: `adds the input tables of the rights fact` — колонки, індекси Р3-15 (`typed`, `containers`, `deltas`, `holders`, `start`); `rights_tx_actor` відсутня.
  - `rights-guards.test.ts`:
    - `snapshots the inputs of rights_mine with the shared generators` — тіло знімка вставляє в `rights_tx_typed` рівно `liveInputs(…, LIVE).typed` (цілий фрагмент), `containers` і `deltas` звужено до `typed` цього xid, `rights_tx_holders` — `fullAccessHolderRows`; `rights_mine_live` у тілі знімка не викликається;
    - `caches the start rights on the first commit check` — `rights_tx_check` перед гілками `actor`/`role`/`assignment` кличе `startCache` рівно раз; `actorCheck` «до» і покриття кожного `escalationSql` читають `rights_tx_start`, а не `startRights` і не `rights_tx_holders`;
    - оновити старі асерти, які 3а робить хибними: `writes the header of a fact after its rows` (тепер `rights_tx_typed`), перелік таблиць прибирання (дев'ять), асерти `escalationSql` і `actorCheck` з `rights_tx_actor`.
  - `rights-functions.test.ts`: `renders rights_mine_live with live inputs` (тіло = `mineBody(…, LIVE, false, liveInputs(…, LIVE))`).
  - `rights-snapshot-sources.test.ts`: оновити рукописну мапу — таблиця членства лишається джерелом `rights` і `scopes`; таблиці ролей, ТЧ дельт, призначень і контейнерів — `rights`.
  - `rights-guards.db.test.ts`: `computes the commit cache from the snapshot inputs` — актор має на початку роль з правом `p`; у транзакції через `commandSteps`: призначає іншому користувачу роль з `p` (покривається станом початку), потім знімає власне призначення ролі; `immediate: true` — проходить; контроль — без власної ролі на початку та сама пара кроків — `escalation`.
- [x] **Крок 2.** Червоні: `pnpm --filter simetra test rights-admin-tables rights-functions rights-guards rights-snapshot-sources`.
- [x] **Крок 3.** Реалізувати; `rights_tx_actor` і його заповнення видалити (принцип 5).
- [x] **Крок 4.** Зелені; `pnpm --filter simetra test:db rights-guards catalog-command-admin rights-plan-gate`; `typecheck`, `lint`.
- [x] **Крок 5.** Коміт `feat(compiler): знімок входів факту прав актора й кеш прав початку на COMMIT`.

## Задача 4: дві гілки

**Files:** `rights/actor-snapshot.ts`, `rights/functions.ts`, `membership-functions.ts`, `access-units.ts`, `catalog-command/units.ts`, `contracts.ts` (`AccessContract.scope.verbatim`), `pipeline.ts`, `rights/explain-units.ts`; Test `rights-functions.test.ts`, тест функцій членства, тест `access-units`, `rights-explain.test.ts`.

**Produces:** `snapshotBranches(fact, snapshot, live)` = `SELECT * FROM (<snapshot>) s WHERE <snapshotOwned(fact)> UNION ALL SELECT * FROM (<live>) l WHERE NOT <snapshotPresent(fact)> AND NOT <snapshotForeign()>`; `RIGHTS_FUNCTIONS.scopeSet` (`rights_scope_set(p_scope_kind uuid) RETURNS SETOF uuid`, definer, `EXECUTE` — як функцій множини: користувач, сервісна, команд).

Гілки (лише коли `hasActorSnapshot`): `rights_mine` і `rights_mine(p_object, p_action)` (`rights`; гілки — на вхідних CTE, Р3-15); `rights_my_scopes` (`scopes`; сигнатура та сама; обидві гілки проєктують рівно `scope_kind_id, scope, member` — живий варіант має ще `catalog`); `rights_dimension_values` (`values`); `_member_scopes`, `_my_member` (`scopes`, `catalog AND scope_kind_id = <вид>`, `_my_member` — ще `scope = p_scope`); `rights_scope_set` (`scopeSets`); `tenantBoundary` виду з дослівною функцією — `ARRAY(SELECT simetra.rights_scope_set('<вид>'))`; `rights_explain` — Р3-8.

- [x] **Крок 1. Тести:** `renders snapshotPresent and snapshotOwned literally` (рукописний очікуваний текст для `rights`); для кожної функції з гілками — тіло = `snapshotBranches(<факт>, …)` (цілий оператор); `renders no snapshot branch without rights catalogs`; `uses no txid_current() in fact functions` (лише `_if_assigned`); `routes the tenant boundary of a verbatim set function through rights_scope_set`; `judges caller visibility by snapshot-aware functions`.
- [x] **Крок 2.** Червоні. **Крок 3.** Реалізувати. **Крок 4.** Зелені unit; DB — Задача 6 (спільний коміт).

**Доповнення Р3-15/Р3-16:**

- `rights_mine()` і `rights_mine(p_action, p_object)` — диспетчер Р3-15 (не `snapshotBranches`); застаріле «знімок — `MINE_COLUMNS` з `rights_tx_actor`» не діє. Решта функцій з гілками — SQL-гілки, як вище.
- Новий `RIGHTS_FUNCTIONS.minePair` (`simetra.rights_mine(p_action text, p_object text)`) — Р3-16; `scopesBody`, `containerBody`, `hasRightBody` і `analysisGate` кличуть його.
- Тести:
  - `dispatches rights_mine between two generated branches` — тіло обох `rights_mine` = рукописний каркас `IF … THEN RETURN QUERY … ELSIF … THEN RETURN QUERY … END IF`, де кожен `RETURN QUERY` — рівно `mineBody(…, snapshotInputs(<xid>), pair)` / `mineBody(…, LIVE, …, liveInputs(…, LIVE), pair)`, умови — `snapshotOwned('rights')` і `NOT snapshotPresent('rights') AND NOT snapshotForeign()`; `LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = ''`, гранти як у `rights_mine()`;
  - `filters role rows by the pair and its requirements` — рукописний очікуваний фрагмент фільтра для архетипу, дельт `allow`, рядків `deny` і `everyUser`;
  - `routes the set functions through the pair variant` — тіла `rights_any`, `rights_own`, `rights_dim`, `rights_container`, `has_right`, `analysisGate` кличуть `rights_mine(p_action, p_object)`, а не `rights_mine()`;
  - `keeps the full rights_mine for analysis and the commit cache` — `_of`, `rights_explain`, `startRights` — повний.

## Задача 5: гейт тіл і бенчмарк

**Files:** `test/db/rights-plan-gate.db.test.ts`, `test/db/explain-plan.ts`, `bench/rights.bench.db.ts`.

- [x] **Крок 1.** `ANALYZE` таблиць знімка (`SNAPSHOT_TABLES`) в `beforeAll` гейта й на початку кожного сценарію бенчмарку. Висновок бенчмарку — рядок «reads run with an assigned xid». Гейт аналізує таблиці знімка з фоном 1 000 чужих знімків (від'ємні xid): на одній сторінці рядків `Seq Scan` — правильний план, і критерій «за індексом» нічого не доводив би.
- [x] **Крок 2.** `autoExplain` — параметр `before?: string`: оператор від власника з контекстом команди, до підписки на повідомлення.
- [x] **Крок 3.** Окремий `it.each` `"%s with a snapshot: fact functions read the snapshot by index"` — `rights_mine()` і точкове читання задачі; `before`: `UPDATE <довідник членства> SET <колонка> = <колонка> WHERE false` (тригер оператора спрацьовує на нулі рядків; знімає всі факти). Критерії: тіла читають `rights_tx_header` і таблиці свого факту; піддерево живої гілки (виклик `*_live`) є в плані й має `Actual Loops = 0`; повторних `CTE Scan`/`Seq Scan` немає (`RIGHTS_TABLES` + таблиці знімка). Наявний `it.each` без знімка — без змін, плюс: піддерево гілки знімка є й має `loops = 0`.
- [x] **Крок 4.** `"rights_role_grants body reads no CTE more than once"` (борг прав §2): від власника `SELECT count(*) FROM simetra.rights_role_grants('scope', '<ORG_KIND_ID>', '<ORG_ADMIN_ID>', <jsonb з 200 рядків дельт allow/deny над доменом рівня>)` під `auto_explain`; рядків > 0; жодного `CTE Scan` з `loops > 1`.
- [x] **Крок 5.** Бенчмарк: у сценарій 6 — живі варіанти й «зі знімком» (Р3-9 (а)); у сценарії 7 — рядки часу знятих фактів, N і прибирання.
- [x] **Крок 6.** `pnpm --filter simetra test:db rights-plan-gate`; коміт `test(simetra): гейт тіл прав зі знімком і rights_role_grants; бенчмарк знімка`.

**Доповнення Р3-15/Р3-16:**

- Гейт тіл: `rights_mine(p_action, p_object)` — в обох `it.each` (без знімка й зі знімком); `auto_explain.log_nested_statements = on` — гейт бачить план кожного `RETURN QUERY` диспетчера; критерії ті самі; асерт, що план гілки, яка працювала, у журналі є. Оператор «зі знімком» — запис у таблицю призначень (`… WHERE false`) і асерт заголовка `rights` цього xid. Мутація М35 доводить, що гейт ловить `Seq Scan` у тілі гілки диспетчера. **Правило циклів гейту** (рішення архітекторки): `CTE Scan` з `loops > 1` дозволено лише тоді, коли зовнішня сторона циклу (`Nested Loop`) виведена тільки зі сталих функцій компіляції (`rights_projection`, `rights_requires`, `rights_domain`) — перевірка за деревом плану (усі листки зовнішнього піддерева — `Function Scan` цих функцій чи `Result`), не за назвою вузла рядком; тоді вартість лінійна за скоупами. Для повного `rights_mine()` критерій не послаблюється. Мутація М37 доводить, що CTE, залежний від скоупів, на зовнішній стороні циклу робить гейт червоним. Вплив на спеку: немає.
- Бенчмарк: сценарій 6 — `rights_mine(p_action, p_object)` і `rights_any` на парі (`BENCH_BASE` має лише `rights_any`); сценарій 7 — для найбільшого актора (2 000 скоупів / 20 000 значень) перший `UPDATE` до/після і перевірка `rights_any` на парі; COMMIT пакета призначень найбільшого актора (1 і 1 000) до/після; цикл оберту — N знімків і прибирань без `ANALYZE` на обсязі найбільшого актора, потім точкове читання й перший запис.
- **Критерій Р3-9 (в)** (розвилка (2)): Σ операторів заповнення знімка ≤ 50 мс для найбільшого й ≤ 5 мс для звичайного актора, з розбивкою за фактами (`typed`, `containers`, `deltas`, `holders`, `scopes`, `values`, `scopeSets`) — клієнтом, тими самими запитами заповнення окремими операторами в точці збереження з відкатом до першого запису; повний перший `UPDATE` до/після — у звіт без порогу; COMMIT пакета найбільшого актора — поріг пропоную на вимірі (розвилка до мерджу). Плюс перелік джерел знімка, що є бізнес-даними (контейнери, зв'язки вимірів, таблиці дослівних функцій), — тут знімок платять звичайні записи.

## Задача 6: DB-доказ механізму

Кейси — у `catalog-command-admin.db.test.ts` (наявне розгортання; бракує
виміру, контейнера, регістру зв'язку чи виду з дослівною функцією множини —
розширити спільний будівник). Кожна зміна джерела — `rowCount = 1`. Кожен
запис з контекстом — у точці збереження `commandSteps` (Review Focus 1).

**`proveOpened`** — крок `check` після зміни джерела: від власника під claims
актора `EXISTS` факту, що відкриває `X`, у живому варіанті — `true`, у
публічній функції — `false`. **Близнюк читання** кожного кейсу «hides»: актор
з тим самим фактом з початку транзакції той самий `SELECT X` — ≥ 1 рядок.

- [x] **Крок 1.** describe `"actor snapshot"`:
  - `keeps the effects of earlier steps visible to later steps` — помічник Задачі 1.
  - `takes the snapshot equal to the live facts of the actor` — актор з правами рівня скоупу, `own`, виміру (регістр і дослівна функція, що дає й `NULL`) і контейнера; до запису публічні функції = живі; після оператора, що знімає всі факти й нічого не змінює, вміст таблиць знімка = живі множини (живу сторону — без `NULL` у `scope`/`member`), кожна непорожня; чотири заголовки.
  - `takes the snapshot before the first change of own membership` (вимога 1) — актор має глобальну роль з правом читання `X` і запрошений рядок членства в `S2` з призначенням; самоприйняття (`asOwner`); далі **без запису в довідники прав** `SELECT X` у `S2` під `simetra_command` — `0` рядків (тримає межа тенанта); `rights_my_scopes()`, `_member_scopes()`, `_my_member('<S2>')` — без `S2`; `proveOpened` (`S2` у `rights_my_scopes_live()`).
  - `judges the self-acceptance of an actor without rights` (Review Focus 5) — актор без жодного рядка прав (модель без ролей `everyUser`): самоприйняття рядка з призначеннями, `immediate: true` → `escalation`. Спільна фікстура має `everyUser` — тоді друге мале розгортання в тому самому файлі (модель без `everyUser`, лише довідник членства й призначень); лише коли воно неможливе — unit-асерт `queues the actor key by the rights header`, з причиною в журналі.
  - `keeps an inactive adopted member out of the snapshot` — прийняте джерело членства з колонкою активності (`adoptedMembership` з `active`) і прийняте джерело призначень; учасник актора неактивний на початку транзакції; оператор, що знімає факти: `rights_tx_scopes` без цього учасника, `rights_tx_typed` без його призначення з джерела, `rights_mine()` і `rights_my_scopes()` — без них; контроль — активний учасник того самого джерела дає рядки в обох таблицях знімка.
  - `reads live facts while no source changed` — xid призначено записом не в джерело: публічні функції = живі; заголовків xid немає.
  - `returns empty facts to another actor after a single-fact snapshot` — для кожного факту окремо: запис у джерело лише цього факту (контейнер → `rights`; регістр зв'язку → `values`; таблиця дослівної функції множини → `scopeSets`) знімає один факт актора A; claims → B: функції **усіх** фактів порожні.
  - `returns empty facts to another actor of the transaction` — знімок актора A записом у довідник прав; claims → B: функції фактів порожні, `SELECT X`, видимих B наживо, — `0`; запис у джерело — `rights-context`; `SET CONSTRAINTS ALL IMMEDIATE` — `rights-context`.
  - `retakes the snapshot after a rolled back savepoint`.
  - `keeps the snapshot after a passed immediate check` (Р3-7) — зміна виміру актора (регістр, `asOwner`), `proveOpened`, потім запис у довідник прав, що ставить ключ (призначення іншому користувачу в межах ⊆); `SET CONSTRAINTS ALL IMMEDIATE` проходить; `SELECT X` з обсягом виміру — `0`; заголовки xid є.
  - `cleans the snapshots of finished transactions` — xid закоміченої транзакції: `SELECT txid_current()` на окремому з'єднанні зі стеком (тег прогону — за помічниками `connection.ts`; xid спільні для кластера); рядки з ним у кожній таблиці `SNAPSHOT_TABLES` (власник); запис, що бере знімок; рядків чужого xid немає, свого — є.
  - `keeps exempt sources out of reach of the command role` — для кожного винятку: `has_any_column_privilege('simetra_command', t, 'INSERT')`, `…'UPDATE'`, `has_table_privilege(…, 'DELETE')`, `…'TRUNCATE'` — `false`; контроль — таблиця виду-джерела: `true`; це DB-доказ, що згенерований SQL ролі команд винятків не відкриває.
  - `takes no snapshot in maintenance mode` — запис у джерело в режимі обслуговування: заголовків xid немає.
  - `revokes execute on live variants from every api role` — `has_function_privilege` для ролей `PROVIDER_API_ROLES` і `simetra_command` на живі варіанти — `false`.
- [x] **Крок 2.** describe `"the database judges a command by the rights at the start of its transaction"` (вимога 4), через `commandSteps`, без `COMMIT`; у кожному — `proveOpened`. Кейси «hides» закінчуються поверненням джерела й `immediate: true`, що проходить. Для кейсів «refuses» — близнюк без кроку `X`: зміна → повернення → `immediate: true` проходить (кінцевий стан проходить ⊆).
  - `refuses assign → update X → unassign` — `noRight`;
  - `hides X in assign → read X → unassign` — `0`;
  - `refuses assign → update a member row → unassign` — роль дає `own`; `noRight`;
  - `refuses membership → update a member row → revert` — право `own` з початку; зміна членства додає актору учасника, якому належить рядок; `noRight` (тримає `scopes`);
  - `hides X in membership → read X → revert` — межа тенанта (`_member_scopes`);
  - `keeps the catalog rows apart from adopted sources in membership set functions` — рядок прийнятого джерела членства того самого виду (`adoptedMembership`) у `rights_tx_scopes` з `catalog = false`: `_member_scopes()` його не повертає (М17);
  - `hides X in a verbatim scope set → read X → revert` і `refuses a verbatim scope set → update X → revert` — вид з дослівною функцією множини; зміна рядка таблиці виду, яку читає функція; `0` / відмова ядра (`rights_scope_set`);
  - `refuses users as a source → update X → revert`, `hides X in users as a source → read X → revert` — право з обсягом виміру з початку; актор міняє свій рядок регістру зв'язку; `noRight` / `0`;
  - кейс A4 → `the database refuses a direct command the rights granted in its transaction`: `E.forbidden.noRight`, як у контрольного запису (Р-1), плюс `proveOpened`; коментар про Права-3 прибрати.
- [x] **Крок 3. Ядро ≡ RLS** (`catalog-command-rights.db.test.ts`): підмножина сітки (по точці на обсяг і дію) з варіантом `snapshot: "taken"` — у зовнішній точці збереження під актором точки оператор, що знімає факти (`… WHERE false`), додаткове призначення, що відкриває точку (режим обслуговування), обидва шляхи; результат = результат без призначення. Контроль: без знімка те саме призначення відкриває хоч одну відмовлену точку.
- [x] **Крок 4. Пояснення** (`rights-analysis.db.test.ts`): `explains only rows visible by the snapshot` — самопризначення ролі, що відкриває рядок (`commandSteps`); `rights_explain` для рядка — порожньо; контроль — актор з цією роллю з початку отримує пояснення; варіант з межею тенанта — самоприйняття членства (`asOwner`).
- [x] **Крок 5.** Scoped DB: `pnpm --filter simetra test:db catalog-command-admin catalog-command-rights rights-analysis rights-guards rights-functions rights-plan-gate` — зелені, час записати. Зелені після Задачі 5: 840 тестів, 65 с.
- [x] **Крок 6. Ширший прогін перед комітом** (Review Focus 1): `pnpm --filter simetra test:db rights membership access command` і `pnpm --filter @simetrajs/designer test:db rights promotion apply database`. Червоний тест поза планом — розвилка.
- [x] **Крок 7.** Коміт (Задачі 4 і 6) `feat(compiler): функції фактів актора читають знімок транзакції`.
- [ ] **Крок 8.** Unit-мутації Задачі 10, чий тест уже є; DB-мутації — після Задачі 8 (Задача 10).

**Доповнення Р3-15/Р3-16:**

- `takes the snapshot equal to the live facts of the actor` — для `rights`: `rights_mine()` зі знімком = `rights_mine_live()` у мить знімка (повна множина); таблиці входів непорожні; `rights_tx_holders` = `fullAccessHolderRows` актора.
- describe `"rights of a pair"` (Р3-16). Фікстура: дельти `allow` і `deny`, кастомна роль, контейнер, виміри, прийняте джерело з умовами, роль `everyUser`, і три розрізняльні рядки — `deny`, що знімає утримуваний рядок дії `a`; `deny` на дію з `req(a)`; дія з `req(a)`, яку дає лише дельта `allow`. Для **кожної** пари `(action, object)` з `SELECT DISTINCT object, action FROM simetra.rights_domain()` (не вибірка):
  - контракт: `rights_mine(a, o)` = рядки повного `rights_mine()` з `object = o AND action ∈ {a} ∪ req*(a)`;
  - для `rights_any`, `rights_own`, `rights_dim` (кожен вимір пари), `rights_container` і `has_right` (кожна пара `(extent, dimension_id)` пари з домену): результат = той самий фільтр над повним `rights_mine()`;
  - двічі — без знімка (жива гілка) і після запису в таблицю призначень `… WHERE false` з асертом заголовка `rights` цього xid (гілка знімка);
  - для кожної функції в кожній гілці хоча б одна пара дає непорожній результат (асерт лічильника, не лише рівності).
- `refuses capturing a member row with full access` (заміна колишнього кейсу про скоупи; вимога безпеки аудиту) — актор має право `update` на довідник членства в `S`; рядок учасника `X` належить іншому користувачу й має призначення архетипу з `fullAccess`; актор пише `X.user = <актор>` і `immediate: true` → `escalation`; контроль — рядок учасника без призначень проходить.

## Задача 7: спеки, скіл, борг

- [x] **Крок 1. Спека прав §5.1:** «Функції фактів актора» — Р3-1, Р3-3, Р3-4, Р3-8 (аналіз); імена — у «Імена (остаточні)».
- [x] **Крок 2. §5.2:** межа тенанта виду з дослівною функцією — через `rights_scope_set` (Р3-11, за Р-2).
- [x] **Крок 3. §7** (пункт ⊆): права актора на початок транзакції — і для читання; момент і джерела (Р3-5, Р3-6, `rights.snapshot-source-unknown`); знімок до кінця транзакції, прибирання й рівень ізоляції (Р3-7); COMMIT — живий стан (Р3-8); функція застосунку, що пише виняток (Р3-13, за Р-4; діагностика — і в §6.1).
- [x] **Крок 4. Спека П4:** прибрати бар'єр і обмеження хуків членства з §6.5, §6.9, §6.10, §6.12, §6.15, §6.16 (інваріант 17) у формі A4; §6.15 — одне речення: код host-а з пулом `simetra_runtime` — домен довіри Рт6, а права команди в транзакції — права її початку (спека прав §7); §6.11 — читання без xid таблиць знімка не торкається; §6.13 крок 6 — Р3-12. Також: §7.1 рядок «unit T3» і §7.2 DB-кейс бар'єру — переписати на нове очікування (самопризначення в транзакції не діє до COMMIT); §8 — прибрати бар'єр з рядка A4, додати рядок блоку Права-3 (зміст, «готово, коли», «після A4») і порядок «A1 → A2 → A3 → A4 → Права-3 → A6 → A5»; Додаток А — рядок «спека прав §7, ⊆» переписати на кінцевий стан. Причина `rights-context` прямого запису без контексту команди (T0 `COMMAND_CORE_ERRORS`, скіл споживача про прямий запис) лишається.
- [x] **Крок 5. Скіл споживача** `packages/designer/skills/simetra-metadata/references/people-and-rights.md`: прибрати бар'єр і правило «призначення в хуку членства — останньою фазою»; додати: права, видані в транзакції команди, діють з наступної транзакції; Р3-13 — як виправити (`REVOKE EXECUTE … FROM PUBLIC`).
- [x] **Крок 6. Борг:** у `docs/superpowers/plans/2026-10-26-rights-residual-debt.md` зняти «Тіло `rights_role_grants` поза гейтом тіл функцій прав» (посилання на цей план); у `docs/superpowers/plans/2026-10-30-archive-residual-debt.md` пункт «Хибна `escalation` у `SET CONSTRAINTS ALL IMMEDIATE`» — переписати за Р3-7 (знімок береться раз на транзакцію) або зняти з посиланням, якщо кейс `keeps the snapshot after a passed immediate check` його закриває. Новий пункт боргу прав: гейт живих ACL таблиць-винятків під час застосування (Р3-13) — природне місце поруч із гейтом `plan.write-path` designer. `docs/ROADMAP.md` — статус Права-3, якщо рядок є.
- [ ] **Крок 7.** Перевірка якорів — повний гейт: Задача 9 крок 1.
- [x] **Крок 8.** Коміт `docs(spec): права актора на початок транзакції — знімок фактів`.

## Задача 8: видалення бар'єру T3

- [x] **Крок 1.** `hooks.test.ts`: `refuses a second member of a batch when the membership onWrite assigns a role` → `runs a second member of a batch when the membership onWrite assigns a role`: пакет `[create, { ...create, id: OTHER }]` успішний; `db.calls` — дві фази `Client` і дві фази призначення в порядку пакета, потім `COMMIT` (помічники `harness.ts`). Червоний до кроку 2.
- [x] **Крок 2.** Видалити код Р3-14, describe `"rights barrier in a batch"` (`transaction.test.ts`) і `"rights barrier in hooks"` (`hooks.test.ts`, крім кроку 1), помічники, яких ніхто більше не читає.
- [x] **Крок 3.** `pnpm --filter simetra test server`; `typecheck`, `lint`; `git grep -n "checkBarrier\|startPhase\|rightsPhase\|isRightsObject\|isRightsContext" -- packages` — порожньо.
- [x] **Крок 4. Designer DB:** describe `"the T3 barrier after a rights phase"` → `"the database judges a batch by the rights at the start of its transaction"`: `assign → update X → unassign in one batch`, `assign → update X through ctx.run in a hook`, `assign → update a member row → unassign` — `command.forbidden`, причина `noRight`, відкат; `assign → read X → unassign through a hook` — `ctx.read` порожній, пакет комітиться; контроль — актор з роллю з початку той самий хук бачить `X`. `transfers fullAccess in one batch, own assignment first` — без змін. Новий `reads through rights functions in a read only transaction without an xid` — з'єднання з тінню, `BEGIN READ ONLY`, claims актора, роль API користувача: `SELECT X` дає рядки за правами; після читання `txid_current_if_assigned()` `IS NULL` і `pg_stat_xact_user_tables` має по рядку на кожну таблицю `SNAPSHOT_TABLES` з `seq_scan + idx_scan = 0`; контроль в окремій транзакції не `READ ONLY`: xid призначено записом не в джерело, те саме читання — сканів > 0. Scoped: `pnpm --filter @simetrajs/designer test:db rights-admin-commands`.
- [x] **Крок 5.** Ширший прогін (Review Focus 1): `pnpm --filter simetra test server`, `pnpm --filter simetra test:db catalog-command`, `pnpm --filter @simetrajs/designer test:db rights`.
- [x] **Крок 6.** Коміт `refactor(server): прибрано тимчасовий бар'єр T3 — права команди тримає знімок бази`.

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
| М19 | `present` — `EXISTS` без охорони `txid_current_if_assigned() IS NULL` | designer `reads through rights functions in a read only transaction without an xid` (вузол плану над `SNAPSHOT_TABLES` з `Actual Loops > 0`). Форма `AND` замість `CASE` — рівнозначна мутація, коли планувальник ставить дешевшу умову першою: записати з `EXPLAIN` як доказ |
| М20 | `rights_explain` судить викликача варіантом `_of` | `explains only rows visible by the snapshot` |
| М21 | `actorPending` знову шукає рядок `rights_tx_actor` | `judges the self-acceptance of an actor without rights` (або unit `queues the actor key by the rights header`) |
| М22 | діагностика Р3-13 ігнорує типовий `EXECUTE` для `PUBLIC` | `refuses a definer function writing an exempt table…` |
| М23 | діагностика Р3-13 ігнорує поколонковий грант | `refuses a grant of DML on an exempt table…` |
| М24 | спільний розбір шляхів запису ігнорує `PUBLIC` | `refuses a grant of DML on an exempt table to public or the command role` |
| М25 | `tenantBoundary` ядра (`catalog-command/units.ts`) кличе дослівну функцію напряму | `refuses a verbatim scope set → create X → revert` (межа ядра — лише на створенні) |
| М26 | правило (г) враховує `EXECUTE` тригерної функції | `refuses a definer trigger function writing an exempt table` |
| М27 | `rights_my_scopes_live` (гілка `withOrigin`) без `activeCondition` джерела | `keeps an inactive adopted member out of the snapshot` (асерт `rights_tx_scopes`) |
| М27а | `sourceAssignments` без `activeCondition` | `keeps an inactive adopted member out of the snapshot` (асерт `rights_tx_typed`) |
| М28 | обхід записів не бачить DML у `WITH` | `refuses a definer function writing an exempt table through a data-modifying CTE` і наявний «a data-modifying CTE» |

**Мутації Р3-15/Р3-16:**

| № | Мутація | Має почервоніти |
| --- | --- | --- |
| М29 | фільтр пари без `req*` | `rights of a pair` (контракт пари; розрізняльний рядок) |
| М30 | фільтр пари лише за `object` | `rights of a pair` (контракт пари: вихід містить інші дії) |
| М31а | гілка знімка диспетчера читає живий `typed` | кейси Задачі 6 крок 2 з призначенням (`refuses assign → update X → unassign`, `hides X in assign → read X → unassign`) |
| М31б | гілка знімка читає живі `deltas` | кейс Задачі 6 крок 2: `refuses a custom role delta → update X → revert` (дельта `allow` утримуваної кастомної ролі; додати до кроку 2) |
| М31в | гілка знімка читає живі `containers` | кейс Задачі 6 крок 2: `refuses a new container → update X → revert` (поява контейнера, на який посилається призначення актора; додати до кроку 2) |
| М32 | таблицю членства прибрано з джерел `rights` | `judges the self-acceptance of an actor without rights`; `refuses capturing a member row with full access` |
| М33 | `escalationSql` покриває рядками `rights_mine_live()` замість кешу | unit: асерт `caches the start rights on the first commit check`; у DB ту саму відмову дає ключ `actor` — обмеження в журналі |
| М34 | гілка `everyUser` поза умовою диспетчера (жива для чужого актора) | `returns empty facts to another actor of the transaction` (фікстура з `everyUser`) |
| М35 | у тіло гілки знімка диспетчера — читання таблиці без індексу (`Seq Scan`) | гейт тіл зі знімком `"%s with a snapshot: fact functions read the snapshot by index"` |
| М36 | `startRights` над живими входами | `computes the commit cache from the snapshot inputs` |
| М37 | у гейті — зовнішня сторона циклу з CTE, залежним від скоупів (`held` чи `my_scopes`), рахується «сталою» | гейт тіл `set functions of a task policy …` на парі (фікстура з циклом над `held` зовні) |

М8 (тіло знімка кличе `rights_mine()`) замінюється на: тіло знімка пише в `rights_tx_typed` вихід `rights_mine_live()` замість входів — unit `snapshots the inputs of rights_mine with the shared generators`. М27а — неактивний рядок прийнятого джерела призначень при **активному** учасникові (інакше рядок знімає вже `my_scopes`, М27); асерт — `rights_tx_typed`. М21 — пошук заголовка, як і було; `rights_tx_actor` більше немає.

## Журнал рішень виконання

- Задача 6, відхилення 1–5 — погоджено архітекторкою: кожен кейс доводить те саме правило на формі, яку платформа допускає.
- Захоплення чужого рядка учасника тримає тригер ефектів (незмінність `user_id`) незалежно від знімка; М32 доводить членство як джерело `rights` через прийняття запрошення не-учасником.
- `rights-guards.db` `a canonical custom action id passes and its deny takes the right away` читає права іншого користувача функцією аналізу `_of`: за Р3-3 чужий актор у транзакції зі знімком бачить порожньо.
- Задача 4 закомічена окремо від Задачі 6: передача роботи між виконавцями — через коміт.
- Задача 8, крок 4: контроль кейсу без xid призначає xid `SELECT txid_current()`, а не записом — доводить те саме (гілку знімка обирає лише наявність xid). `SNAPSHOT_TABLES` реекспортовано в `packages/simetra/test/support.ts` для designer. Помічник `rightsPhase` у `hooks.test.ts` перейменовано на `rightsRolePhase`: він живий (фаза `RightsRole` у кейсах хуків), а `git grep` кроку 3 мусить бути порожнім. Згадки бар'єру в скілі споживача — Задача 7 крок 5.

## Журнал мутацій

Виконано на `1ae21bdd` (дерево закомічене й чисте перед кожною мутацією; після — `git checkout -- .`, `git status` порожній). Команди — `pnpm --filter <пакет> …` без `--`; `CCA` — `simetra test:db catalog-command-admin`, `RG` — `simetra test:db rights-guards`, `GATE` — `simetra test:db rights-plan-gate`, `DSG` — `@simetrajs/designer test:db rights-admin-commands`. Інші червоні — у дужках. М35, М36, М37 перепрогнано (журналу часу з Задач 3а і 5 немає, кожна < 15 с).

| № | мутація (як застосовано) | рівень | команда | червоний тест | час |
| --- | --- | --- | --- | --- | --- |
| М1 | `snapshotBranches` повертає `live`; диспетчер: `IF (false AND …)`, `ELSIF (true)` | DB | `CCA`; `DSG` | усі кейси «judges a command by the rights at the start» (17), designer `assign → update X → unassign in one batch`, `… through ctx.run in a hook`, `assign → update a member row → unassign`, `assign → read X → unassign through a hook` (і `reads … without an xid` — контроль без сканів) | 12 + 27 с |
| М2 | `rights_my_scopes`: гілки замінено живою | DB | `CCA` | `refuses membership → update a member's user → revert` (назва Задачі 6; ще 8: `hides X in membership`, `reads X by the start membership after leaving`, «another actor», `takes the snapshot before the first change of own membership`) | 11 с |
| М3 | `rights_dimension_values` — лише жива | DB | `CCA` | `refuses users as a source → update X → revert`, `hides X in users as a source → read X → revert`, `keeps the snapshot after a passed immediate check` (+ «another actor») | 11 с |
| М4 | `_member_scopes` — лише жива | DB | `CCA` | `reads X by the start membership after leaving → read X → revert` — межу тенанта Задача 6 перенесла сюди; `hides X in membership` тепер доводить межу «Користувачів» (+ `takes the snapshot before…`, М17-кейс, «another actor») | 11 с |
| М5 | `_my_member` — лише жива | DB | `CCA` | `takes the snapshot before the first change of own membership` — асерт `my_member: 0` (отримано 1) (+ «another actor») | 12 с |
| М6 | `rights_scope_set` — лише жива | DB | `CCA` | `hides X in a verbatim scope set → read X → revert`, `refuses a verbatim scope set → update X → revert` (+ «single-fact») | 11 с |
| М7 | `snapshotOwned` без `h.actor IS NOT DISTINCT FROM …` | DB | `CCA` | `returns empty facts to another actor of the transaction` (+ `single-fact (rights)`, `(values)`) | 12 с |
| М7а | без `NOT snapshotForeign()` у живій гілці `snapshotBranches` і в `ELSIF` диспетчера (правило в двох місцях) | DB | `CCA` | `returns empty facts to another actor after a single-fact snapshot` (усі три факти) (+ `… of the transaction`) | 11 с |
| М8 (заміна) | `rightsFactRows`: у `rights_tx_typed` — `SELECT * FROM rights_mine_live()` замість `inputs.typed` | unit | `simetra test rights-guards` | `snapshots the inputs of rights_mine with the shared generators` (+ `computes the snapshot and the actor check from live variants`) | 4 с |
| М9 | голови факту `rights` без входу `containers` — головна таблиця контейнера (`public.project`) випадає з джерел | unit | `simetra test rights-snapshot-sources` | `maps the sources of the fixture to their facts` (+ `maps the direct reads of every live variant`) | 6 с |
| М10 | `classify`/`classifyTable`: три гілки `unknown` → `exempt` (`declared`) | unit | `simetra test rights-snapshot-sources` | `reports an unknown relation` | 5 с |
| М11 | тригер знімка `AFTER INSERT OR UPDATE OR DELETE` | DB | `CCA` | `takes the snapshot before the first change of own membership` (+ 17: кейси кроку 2, «another actor», self-acceptance, `refuses capturing a member row…`) | 11 с |
| М12 | `actorCheck` «після» — `rights_mine()` замість `rights_mine_live()` | DB | `RG` + `CCA` | `member-claim-assigned judges the actor's own increment` (rights-guards), `judges the self-acceptance of an actor without rights (invite@T)`, `refuses capturing a member row with full access (invite@A)` | 15 с |
| М13 | `rights_tx_check`: після видалення ключа — порожня черга xid → `DELETE` з усіх `SNAPSHOT_TABLES` | DB | `CCA` + `RG` | `keeps the snapshot after a passed immediate check` (+ rights-guards: `IMMEDIATE mode does not lose the actor snapshot`, `membership-only transactions … keep the actor snapshot`, `the pending keys are cleaned …, the actor snapshot is kept`) | 16 с |
| М14 | прибирання Р3-7 без `rights_tx_values` | DB | `CCA` | `cleans the snapshots of finished transactions` | 11 с |
| М15 | у тесті перед перевіркою: `GRANT INSERT (xid) ON simetra.rights_tx_header TO simetra_command` (фікстура; через SQL застосунку мутацію спинив би Р3-13 ще на компіляції) | DB | `CCA` | `keeps exempt sources out of reach of the command role` | 11 с |
| М16 | `live(…)` — `grants: ["command"]` | unit + DB | `simetra test rights-functions`; `CCA` | `revokes execute on live variants` (+ `declares every rights function with its signature, shape and grants`); DB `revokes execute on live variants from every api role` | 13 + 12 с |
| М17 | `_member_scopes`: з `catalogScopes` прибрано `AND s.catalog` (`_my_member` не зачеплено) | DB | `CCA` | `keeps the catalog rows apart from adopted sources in membership set functions` | 12 с |
| М18 | тіло знімка: `IF v_action IS NULL THEN RETURN NULL` (без режиму обслуговування) | DB | `CCA` | `takes no snapshot in maintenance mode` | 11 с |
| М19 | `guarded()` повертає `exists` без `CASE WHEN txid_current_if_assigned() IS NULL …` | DB | `DSG`; `GATE`; `simetra test rights-functions` | `DSG` (на `301ce527`): `reads through rights functions in a read only transaction without an xid` — асерт плану `auto_explain`: 27 вузлів над таблицями знімка з `Actual Loops = 1` (`rights_tx_header`, …), очікувано `[]`. Діагноз первинного прогону (зелена) нижче | 32 с |
| М20 | `rights_explain`: `caller_granted` з `rights_detail_of(current_user_id())`, `CALLER.sets = "of"` | DB | `simetra test:db rights-analysis` | `explains only rows visible by the snapshot` (асерт `[0]`, отримано `[7]`) | 10 с |
| М21 (заміна) | `actorPending`: `WHERE EXISTS (SELECT 1 FROM rights_tx_typed WHERE xid = txid_current())` замість заголовка `rights` | DB | `CCA` | `judges the self-acceptance of an actor without rights (invite@T)` (+ `refuses capturing a member row with full access`) | 11 с |
| М22 | `executableBy`: типовий `EXECUTE` `PUBLIC` не рахується (`privilegedRoles(…).length < 0`) | unit | `simetra test rights-snapshot-sources` | `refuses a definer function writing an exempt table through a data-modifying CTE`, `refuses a definer writer whose execute is revoked only in default privileges` (global, in schema) | 5 с |
| М23 | `writeGrant`: привілеї з переліком колонок відкинуто | unit | `simetra test rights-snapshot-sources` | `refuses a grant of DML on an exempt table to public or the command role (a column grant)` | 6 с |
| М24 | `writeGrant`: `ROLESPEC_PUBLIC` → `[]` | unit | `simetra test rights-snapshot-sources` | `refuses a grant of DML … (a column grant)` — єдиний кейс з `PUBLIC` | 6 с |
| М25 | ядро (`catalog-command/units.ts`): `tenantBoundary({ ...scope, verbatim: false }, "v_new")` — дослівна функція напряму | DB | `CCA` | `CCA` (на `301ce527`): `refuses a verbatim scope set → create X → revert` — створення в скоупі, відкритому лише наживо, проходить замість `noRight`. Діагноз первинного прогону (зелена) нижче | 12 с |
| М26 | правило (г): тригерна функція ще й `executableBy(…)` | unit | `simetra test rights-snapshot-sources` | `refuses a definer trigger function writing an exempt table` | 5 с |
| М27 | `myScopesBody`: `activeCondition` джерела лише без `withOrigin` | DB | `CCA` | `keeps an inactive adopted member out of the snapshot` — асерт `rights_tx_scopes` (+ `my_scopes`, `rights_tx_typed`, `mine`) | 12 с |
| М27а (заміна) | `sourceAssignments` без `activeCondition` (неактивне призначення `idleOffGrantB` активного `idle@B`) | DB | `CCA` | `keeps an inactive adopted member out of the snapshot` — асерт `rights_tx_typed` (`snapshot_containers` + зайвий контейнер) | 12 с |
| М28 | `statementsOf` не заходить у `ctequery` | unit | `simetra test rights-snapshot-sources kind-table-verbatim function-body` | `refuses a definer function writing an exempt table through a data-modifying CTE`, `a data-modifying CTE → error, not debt`, `a data-modifying CTE into a kind table` | 17 с |
| М29 | `pairFilter`: `action = ANY (ARRAY[p_action])` без `rights_requires` | DB | `CCA` | `matches the full rights of the actor for every pair of the domain, live and from the snapshot` (93 розбіжні пари) і `… over adopted sources with conditions` (+ 13: вимоги ролей ламають команди адміністрування) | 9 с |
| М30 | `pairFilter`: лише `object = p_object` | DB | `CCA` | `matches the full rights of the actor for every pair …` (61) | 11 с |
| М31а | гілка знімка диспетчера: `typed` — `liveInputs(…, LIVE).typed` | DB | `CCA` | `refuses assign → update X → unassign`, `hides X in assign → read X → unassign` (+ `refuses assign → update a member row`, кейс A4, `reads X by the start membership after leaving`) | 12 с |
| М31б | те саме для `deltas` | DB | `CCA` | `refuses a custom role delta → update X → revert` | 12 с |
| М31в | те саме для `containers` | DB | `CCA` | `refuses a new container → update X → revert` | 12 с |
| М32 | `snapshotSources`: таблиця довідника членства не додається до факту `rights` | DB | `CCA` | `judges the self-acceptance of an actor without rights (invite@T)`, `refuses capturing a member row with full access (invite@A)` | 11 с |
| М33 | `escalationSql`: покриття — `(SELECT m.*, false AS full_access FROM rights_mine_live() m)` замість `rights_tx_start` | unit + DB | `simetra test rights-guards`; `RG` + `CCA` | unit `caches the start rights on the first commit check` (+ 2). DB теж червоні (обмеження плану не підтвердилось): `computes the commit cache from the snapshot inputs`, `self-assign refuses uncovered grants on COMMIT`, `self-held-role-delta enforces deferred guard`, `cross-scope: fullAccess …`, `member-claim-assigned …`, self-acceptance, `refuses capturing …` | 4 + 17 с |
| М34 | диспетчер: після `END IF` — `RETURN QUERY` рядків `everyUser` для будь-якого дійсного користувача | DB | `CCA` | `returns empty facts to another actor of the transaction` (+ «single-fact» ×3, контракт пари) | 13 с |
| М35 | гілка знімка диспетчера: до `typed` — `AND NOT EXISTS (SELECT 1 FROM simetra.rights_tx_deltas z WHERE z.action = 'never')` (`Seq Scan`) | DB | `GATE` | `%s with a snapshot: fact functions read the snapshot by index` — `rights_mine()`, `rights_mine(p_action, p_object)`, `set functions of a task policy` («snapshot tables read without an index») | 14 с |
| М36 | `startCache` у `rights_tx_check` — `startRights` над `liveInputs(…, LIVE)` | DB | `RG` | `computes the commit cache from the snapshot inputs` (+ 4 кейси ⊆ на COMMIT) | 7 с |
| М37 | `constantSubtree` (`test/db/explain-plan.ts`): листок `CTE Scan` — «сталий» | DB | `GATE` | `rights_mine(p_action, p_object): rights function bodies read no CTE …` і `set functions of a task policy: …` — контроль `loopFixtures(["held"], ["my_scopes"])` | 14 с |

Підсумок: 41 мутація (М1–М37 з М7а, М27а, М31а–в), усі червоні (М19 і М25 — після кейсів `301ce527`, первинно зелені), непридатних немає (М8, М21, М27а — у формі заміни Р3-15/Р3-16). Сумарний час прогонів ≈ 9 хв.

**Знахідка М19 (закрито кейсом `301ce527`).** Без охорони `CASE` у транзакції `READ ONLY` без xid `EXISTS` по заголовку виконується (`Index Only Scan … actual loops=1` замість `never executed`, перевірено `EXPLAIN ANALYZE` на тимчасовій таблиці), але `idx_scan` у `pg_stat_xact_user_tables` лишається `0`: btree з ключем `NULL` (`xid = txid_current_if_assigned()`) виходить з `_bt_first` за `qual_ok = false` до лічильника скану. Тест рахує скани, тож мутацію не бачить; xid мутація не призначає (`_if_assigned`), тож втрата — лише зайвий вузол плану на кожне читання. Форма `AND` рівнозначна: планувальник ставить `InitPlan` з `EXISTS` першим (`One-Time Filter: ((InitPlan 1).col1 AND (txid_current_if_assigned() IS NOT NULL))`, скан `loops=1`). Пропоную тест: у тому самому designer-кейсі (чи в `GATE`, сценарій без xid) читання під `auto_explain` (`log_analyze`, `log_nested_statements`) з асертом, що кожен вузол над таблицями `SNAPSHOT_TABLES` має `Actual Loops = 0`; лічильник сканів лишити контролем гілки з xid.

**Знахідка М25 (закрито кейсом `301ce527`).** `tenantBoundary` ядра стоїть лише в гілці `create` (межа `scope_insert`), а кейс `refuses a verbatim scope set → update X → revert` пише `update`: межу оновлення тримають інші перевірки, тож мутація червоного не дає. Пропоную кейс `refuses a verbatim scope set → create X → revert` у describe «actor snapshot over adopted sources»: рядок `OrgGuest` відкриває скоуп наживо (`proveOpened`), потім `task_comment_save` створює рядок у цьому скоупі — `E.forbidden.noRight`; близнюк — без кроку створення, `immediate: true` проходить.

## Самоперевірка плану (автор)

- Вимоги архітекторки: 1 — Задача 6 крок 1; 2 — Р3-9, Задачі 0.4, 5, 9.1; 3 — Задача 6 крок 3; 4 — Задача 6 крок 2, Задача 8 крок 4, М1–М6; 5 — Задачі 7–8.
- Бриф: гілки за `txid_current_if_assigned()` — Р3-3; живі варіанти для запобіжників — Р3-4, Р3-8; один генератор і `relationReads` — Р3-6; A6 — Р3-12.
