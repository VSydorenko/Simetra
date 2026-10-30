# Права: борг-2 — план виконання

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: план, до виконання.

**Goal:** закрити шість пунктів боргу прав: режим обслуговування за
дозвільним списком, дельта лише з домену архетипу, одне джерело переліку платформних тригерів, пошук колонки
«Вид користувача» за визначенням, лінт стандартних імен для `?.` і глобальні
дельти в гейті планів.

**Architecture:** режим обслуговування діє лише для сесії, що увійшла під
власником функцій прав (`session_user = current_user` у `SECURITY DEFINER`).
Платформні тригери таблиці описує один реєстр T1, з якого читають reverse,
промоція й тест прийому з нуля. Решта — точкові правки й тести.

**Tech Stack:** TypeScript (strict), Zod, Vitest, ESLint `no-restricted-syntax`,
PostgreSQL 17 (локальний стек Supabase), libpg-query.

**Spec:** спека прав `docs/superpowers/specs/2026-10-17-rights-design.md` (§7);
спека П4 `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` (§6.2, §6.12);
борг — `docs/superpowers/plans/2026-10-26-rights-residual-debt.md` (§3).

## Global Constraints

- Робоче місце — worktree `/home/vsydorenko/Simetra-debt2`, гілка
  `feat/rights-debt-2`. Основний checkout `/home/vsydorenko/Simetra` не
  чіпати.
- Коміти — Conventional Commits з українським описом, без трейлерів.
- Коментарі коду — українською, пояснюють **чому**. Посилання в нових
  коментарях — на розділи спек («спека прав §7»), не на ідентифікатори
  рішень (Р2c2-*, Р-A1-*, Рб1-*, Рб2-*): Рб2-* живуть лише в таблиці рішень
  цього плану. Наявні посилання на ідентифікатори в рядках, яких задача не
  торкається, не переписувати — їх замінює окрема очистка документів.
- Під час роботи — лише scoped тести: `pnpm --filter <pkg> test <pattern>`,
  **без `--`** перед шаблоном. DB-тести — `pnpm --filter <pkg> test:db <pattern>`.
- Повні гейти, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`
  і повний `pnpm test:db` — лише на одному SHA з дозволу архітекторки.
- Стек — лише `pnpm db:*`; не зупиняти й не перезапускати. Бази
  `metahub_copy*` не чіпати. `supabase/roles.sql` план не змінює.
- Версій пакетів і `PLATFORM_VERSION` не чіпати. Історію не переписувати.
- Без шимів: замінене видаляється в тому ж коміті.
- Фікстури синтетичні (репо публічне).
- Мутація на кожне правило; DB-мутації — лише на закоміченому дереві.

## Рішення

| № | Рішення | Обґрунтування | Вплив на спеку |
| --- | --- | --- | --- |
| Рб2-1 | **Режим обслуговування — лише для входу власника функцій прав, і ніколи для спільного входу провайдера** (архітекторка: варіант А, після аудиту — форма (а1)). Вираз `maintenanceSql(provider)`: `coalesce(current_setting('simetra.rights_maintenance', true) = 'on', false) AND session_user = current_user AND session_user::text <> ALL (ARRAY[<PROVIDER_LOGIN_ROLES[provider]>]::text[])`. Усі вживання — у функціях `definer()` (`SECURITY DEFINER`), тож `current_user` там — власник функції, тобто мігратор, що застосував план. `PROVIDER_LOGIN_ROLES` і параметр `provider` лишаються; `PLATFORM_LOGIN_ROLES` з виразу виходять (рантайм власником не буває), коментар обох констант оновлюється | Власник таблиць і так може `ALTER TABLE … DISABLE TRIGGER`, тож довіра до нього не додає поверхні атаки. Заборонний список сам по собі пропускав будь-який логін поза ним (новий логін провайдера, пулер з іншою роллю, логін звітів споживача). Залишковий перелік входів провайдера закриває випадок, коли план помилково застосовано під спільним входом, під яким працюють сервіси провайдера (Realtime під `supabase_admin`): тоді власник — цей вхід. Нова роль, `roles.sql` і звірка в `roles` не потрібні: тести вже вмикають режим з `postgres`, власника на стеку | спека прав §7 — пункт режиму обслуговування; спека П4 §6.2 (абзаци «Ролі» й «Режим обслуговування прав»), §6.12 («Поза командами»), рядок Рт9, рядок матриці тестів unit T1 |
| Рб2-2 | **Відоме обмеження Рб2-1:** коли власник функцій прав — групова `NOLOGIN`-роль, а мігратор лише її член, режим недоступний (fail-closed) | Членство через `pg_has_role` пропустило б суперкористувача; групового власника стек і CI не мають | спека прав §7 — одне речення |
| Рб2-7 | **Дельта поза доменом рівня її ролі — відмова на COMMIT** (архітекторка; форма уточнена після аудиту). У `rights_tx_check`, гілка `kind = 'role'` (ключ `role` ставлять і події ролі, і події дельти): для кожного рядка дельти, записаного в цій транзакції (за `rights_journal`), а при зміні архетипу — для кожної живої дельти ролі, мусить існувати рядок `rights_roles()` з `role_id` = архетип ролі й сховищем довідника (`storage = 'scope'` і `storage_id` виду скоупу; для глобального — `storage = 'global'`) і рядок `rights_domain()` того самого `level`/`level_id` з рівними `object`, `action`, `extent` і `IS NOT DISTINCT FROM` для виміру; інакше — `DETAIL` `delta-domain`. Перевірка безумовна, як `role-in-use`, тож діє і в режимі обслуговування. Позначка видалення ролі винятку не дає: інакше зміна архетипу під позначкою з наступним її зняттям лишила б дельти поза доменом. Зміну архетипу визначає перший образ ролі в транзакції проти живого рядка: A→B→A в одній транзакції — не зміна. Перевставка ролі тим самим id видаляє її дельти каскадом (FK `parent_id` ТЧ — `ON DELETE CASCADE`), тож сиріт не лишає. Сирота від зміни коду не блокує непов'язаних операцій (призначення, позначка, зняття позначки, перейменування ролі). Так закрито обидва випадки: запис дельти поза доменом і зміну архетипу, що робить дельти сиротами. `DELETE` дельт перевірки не потребує, тож очистка сиріт можлива. Сирота від зміни коду, як і раніше, ігнорується з попередженням плану `plan.rights-orphans`. CHECK регістру UUID не додається | Дельта діє лише через `JOIN rights_domain()` у `closurePass`, тож усе поза доменом (одрук, UUID видаленої чи не канонічної дії, `own` без власності, чужий вимір, архетип іншого рівня чи сховища) мовчки ігнорується; для `deny` це більше прав, ніж задумано. Домен — рівня (`DOMAIN_COLUMNS`), архетип дає рівень через `rights_roles()`. На COMMIT, бо `<t>_save` пише шапку раніше за ТЧ: перевірка на операторі шапки відхилила б одну команду «новий архетип + нові дельти». Умова сховища — як у сиріт плану застосування (`rights-sources.ts`) | спека прав §7 — новий пункт: «рядок дельти поза доменом рівня архетипу її ролі на COMMIT транзакції, і зміна архетипу, що робить дельти сиротами, — відмова `delta-domain`, зокрема в режимі обслуговування; сирота від зміни коду ігнорується з попередженням плану; судиться лише змінене в транзакції: записані дельти, а при зміні архетипу — усі дельти ролі» |
| Рб2-3 | **Реєстр платформних тригерів таблиці в T1** — `packages/simetra/src/compiler/platform-triggers.ts`. `platformTriggers(table)` повертає всі пари «тригер → функція» з сімейством і генератором одиниці. Reverse (`platformTriggerFunction`, `platformFunctions`), промоція (`triggerReplacement`) і тест прийому з нуля (`mechanicsLoss`) читають лише його. Нова механіка — один запис реєстру | Три ручні переліки розходилися з кожною новою механікою (A1 — авторство, A2 — ієрархія). Тест повноти реєстру на скомпільованій моделі ловить пропущений запис раніше за reverse | немає |
| Рб2-4 | **Колонки «Користувачів» за логічним ім'ям** — `USER_PLATFORM_COLUMNS` у `model/kinds/catalog.ts`, у стилі `RIGHTS_COLUMNS`. `guard-units.ts` бере `USER_PLATFORM_COLUMNS.userKind` замість `userPlatformColumns()[0]!` | Індекс масиву мовчки візьме інший реквізит після зміни порядку | немає |
| Рб2-5 | **Лінт стандартних імен ловить `?.`**: правило в `eslint.standard-columns.js` — і для `ChainExpression`-операнда порівняння | `c.origin?.standard === "…"` — той самий пошук за літералом | немає |
| Рб2-6 | **Гейт планів читає й глобальні дельти**: засів гейта додає глобальну кастомну роль із дельтою, а `RIGHTS_TABLES` — `global_roles` і `global_roles_delta` | Повторне читання глобальних дельт у тілі функції прав гейт інакше не бачить | немає |

## Review Focus

1. **Тест наявного режиму з `postgres` іде з тієї самої сесії, що
   розгортала.** Кейс без розгортання під `postgres` (власник — інший) мусив
   би відмовити. Якщо якийсь DB-тест розгортає під однією роллю, а режим
   вмикає з іншої, він почервоніє — це очікувано, не «полагодити» умову
   (Задача 1, крок 6).
2. **Режим на COMMIT заново не обчислюється:** перевірка
   `rights_tx_check` читає прапорець `maintenance` рядка черги
   `rights_tx_pending`, записаний `definer()`-тригером оператора
   (`pendingInsert`). Правити треба лише `maintenanceSql`; сторонній логін
   відмовляє вже на операторі (Задача 1, крок 5).
3. **Тригери оновлення з умовою змісту** (механіка й авторство на таблиці з
   копіями носіїв): у промоції вони платформні лише разом з умовою.
   Реєстр мусить зберегти цю ознаку (Задача 3, крок 1).
4. **Спільні функції тригерів** (`simetra.touch()` тощо) поза межею звірки:
   тест прийому з нуля не повинен рахувати їх втратою (Задача 3, крок 6).
5. **Засів гейта не на тому користувачі чи лише з `deny`-дельтами** дав би
   зелений гейт без перевірки глобальних дельт: роль — у `gate.full`, обидві
   гілки, рядки є (Задача 6, кроки 1 і 4).

6. **Перевірка дельт на COMMIT** читає журнал без `reason`, `rights_roles()`
   — усередині `NOT EXISTS`, позначка ролі винятку не дає, а відсутність
   запису ролі в журналі — «архетип не змінився» (Задача 2, кроки 1 і 6).

---

### Задача 1: режим обслуговування за входом власника (Рб2-1, Рб2-2)

**Files:**
- Modify: `packages/simetra/src/compiler/rights/guard-units.ts` (`maintenanceSql` і його виклики)
- Modify: `packages/simetra/src/model/schemas/project.ts` (коментарі `PROVIDER_LOGIN_ROLES` і `PLATFORM_LOGIN_ROLES`)
- Test: `packages/simetra/src/compiler/__tests__/rights-guards.test.ts`
- Test: `packages/simetra/test/db/rights-guards.db.test.ts` (опис `maintenance from provider API logins`)
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§7)
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` (§6.2, §6.12, Рт9, матриця тестів)

**Interfaces:**
- Produces: `maintenanceSql(provider: DatabaseProvider): string` (сигнатура та сама).

- [ ] **Step 1: Переписати unit-тест.** У `rights-guards.test.ts` два кейси
  `maintenance mode never trusts the platform runtime login (%s)` і
  `maintenance mode requires a non-API login role` замінити одним
  `it("maintenance mode trusts only the owner login, never a provider login")`:
  `expect(expr(maintenanceSql("supabase"))).toEqual(expr(oracle))`, де
  `oracle` — вираз Рб2-1 з `PROVIDER_LOGIN_ROLES.supabase` у порядку
  переліку; окремо — у масиві виразу немає `PLATFORM_LOGIN_ROLES.runtime`.
  Решту тіла старого кейсу (усі гілки режиму в тригерах — той самий вираз)
  зберегти. Що функції з гілкою режиму — `SECURITY DEFINER`, тримає наявний
  кейс `defines guard functions as closed SECURITY DEFINER plpgsql…`. Кейс знімка з
  `maintenanceSql("supabase")` лишається. Прибрати імпорти, що стали
  невживаними (`DATABASE_PROVIDERS` — після видалення
  `it.each(DATABASE_PROVIDERS)`).
- [ ] **Step 2: Запустити — червоне.**
  `pnpm --filter simetra test rights-guards` → FAIL (вираз ще старий).
- [ ] **Step 3: Реалізувати.** `maintenanceSql(provider)` будує вираз Рб2-1.
  Коментар над ним: чому `session_user = current_user` у `SECURITY DEFINER`
  означає «вхід мігратора»; що власник і так може вимкнути тригер; що
  сторонній вхід, рантайм і суперкористувач-не-власник відпадають; навіщо
  залишковий перелік входів провайдера (план, застосований під спільним
  входом); обмеження групового власника. Посилання — спека прав §7.
  Імпорт `PLATFORM_LOGIN_ROLES` у `guard-units.ts` стає невживаним —
  прибрати.
  Коментар `PROVIDER_LOGIN_ROLES`: перелік закриває режим для спільних
  входів провайдера, навіть коли вони власники. Коментар
  `PLATFORM_LOGIN_ROLES`: рантайм не вмикає режиму, бо він не власник
  функцій прав.
- [ ] **Step 4: Запустити — зелене.**
  `pnpm --filter simetra test rights-guards` → PASS;
  `pnpm --filter simetra typecheck` → без помилок.
- [ ] **Step 5: DB-кейси.** У `maintenance from provider API logins`
  (перейменувати на `maintenance only from the owner login`):
  - створити від `supabase_admin` (суперкористувач, у тій самій транзакції
    з відкатом) роль `testRoleName("foreign_login")` з `LOGIN` і
    `GRANT authenticated TO <роль>`; ім'я — з помічника тегу прогону
    `packages/simetra/test/db/connection.ts`;
  - додати функцію-зонд `public.debt_grant_plain(p_subject uuid)` — та сама,
    що `debt_grant`, але без `set_config` режиму;
  - очікування: `probe("postgres")` → проходить; `probe(<foreign_login>, "rights-context")`;
    `probe("authenticator", "rights-context")`; `probe("supabase_admin", "rights-context")`;
    `postgres` з `debt_grant_plain` → `rights-context` (прапорець обов'язковий).
  `probe` узагальнити параметром функції-зонда; `SET ROLE authenticated`
  лишається для всіх, крім `postgres`.
  Другий `it` — `a provider login that owns the rights functions never enables maintenance`:
  у `withRollback(fn, testSuperuserUrl())` розгорнути модель **без**
  `SET ROLE postgres` (власник — справжній `supabase_admin`), засіяти й
  створити `debt_grant` так само; `probe("supabase_admin", "rights-context")`
  при `session_user = current_user`. Бюджет: +1 розгортання.
- [ ] **Step 6: Запустити DB-тести прав.**
  `pnpm --filter simetra test:db rights-guards` → PASS;
  `pnpm --filter simetra test:db access rights-plan-gate command-grants rights-functions rights-sources rights-policies rights-write`
  і `pnpm --filter @simetrajs/designer test:db rights-last-full-access catalog-command-concurrency` → PASS.
  Червоний кейс тут означає, що тест вмикає режим не з власника, — доповісти
  архітекторці, умову не послаблювати. Решту DB-тестів, що засівають у
  режимі обслуговування, покриває повний `test:db` на погодженому SHA.
- [ ] **Step 7: Спека.** Спека прав §7, пункт режиму: «діє лише для сесії,
  що увійшла під власником функцій прав (мігратором): `session_user =
  current_user` у `SECURITY DEFINER`, і ніколи для ролі входу API
  провайдера, навіть коли вона власник». Речення Рб2-2. Спека П4 §6.2: абзац «Режим
  обслуговування прав» — та сама умова замість об'єднання переліків
  (`PLATFORM_LOGIN_ROLES` з умови виходить). §6.12:
  «`session_user` поза обома переліками ролей входу» → «вхід мігратора,
  власника функцій прав». Рт9 — без «не вмикається режим обслуговування
  (`maintenanceSql`)» як властивості переліку; матриця unit T1 —
  «`maintenanceSql` з обома переліками» → «`maintenanceSql` — вхід власника поза входами провайдера».
  Ще три місця: спека П4 §6.2, абзац «Ролі» — згадку
  `PROVIDER_LOGIN_ROLES` лишити, якщо вона не обіцяє переліку
  `PLATFORM_LOGIN_ROLES` в умові режиму; речення
  після абзацу режиму «Ця правка входить у блок A1 разом зі створенням
  ролі…» — прибрати, бо умова вже не перелікова; спека прав §7, речення
  «Спільна роль входу інструментів і сервісу… інструменти використовують
  окремий довірений вхід» — переписати: довірений вхід — вхід власника
  функцій прав (мігратора), спільний вхід інструментів і рантайму ним не
  буває. Рядки таблиці правок спек та історію блоку A1 не переписувати.
- [ ] **Step 8: Коміт** (код, тести й спеки — разом).
  `git commit -m "fix(rights): режим обслуговування лише для входу власника функцій прав"`
- [ ] **Step 9: Мутації** (на закоміченому дереві, по одній, з відкатом):
  (а) прибрати `AND session_user = current_user` → червоніють unit-кейс і
  DB-кейс `foreign_login`; (б) прибрати залишковий перелік входів
  провайдера → червоніють unit-кейс і DB-кейс власника `supabase_admin`;
  (в) прибрати перевірку прапорця → червоніє кейс `debt_grant_plain`.

### Задача 2: дельта лише з домену рівня її ролі (Рб2-7)

**Files:**
- Modify: `packages/simetra/src/compiler/rights/guard-units.ts` (`checkBody` / `catalogCheck`: гілка `kind = 'role'` функції `rights_tx_check`; ребра `requires`)
- Modify: `packages/simetra/test/db/rights-seed.ts` (помічник засіву сироти)
- Test: `packages/simetra/src/compiler/__tests__/rights-guards.test.ts`
- Test: `packages/simetra/test/db/rights-guards.db.test.ts`
- Test: `packages/simetra/test/db/catalog-command-admin.db.test.ts` (кейс `_save`)
- Modify: `packages/simetra/test/db/rights-functions.db.test.ts` (засів дельт поза доменом — через помічник сироти)
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§7)

**Interfaces:**
- Consumes: `simetra.rights_journal` (`xid`, `relation`, `row_id`, `parent_id`, `seq`, `before`, `after`) і `journalRelation(table)`; `RIGHTS_FUNCTIONS.roles` (`simetra.rights_roles()`: `role_id`, `level`, `level_id`, `storage`, `storage_id`), `RIGHTS_FUNCTIONS.domain` (`simetra.rights_domain()`: `level`, `level_id`, `object`, `action`, `extent`, `dimension_id`), `v_pending.key` (id ролі) гілки `role`, `catalogStorageKind(catalog)`, `RIGHTS_COLUMNS` (`archetype`, `object`, `action`, `extent`, `dimension`).
- Produces: `DETAIL` `delta-domain`; помічник `insertOrphan(client, table, row)` у `rights-seed.ts` — вставка з `ALTER TABLE … DISABLE TRIGGER USER` / `ENABLE TRIGGER USER` навколо (власник таблиць — сесія розгортання), для засіву сиріт.

- [ ] **Step 1: Unit-тест.** У `rights-guards.test.ts`
  `it("refuses at commit a role whose deltas leave the domain of its level")`:
  у гілці `kind = 'role'` тіла `rights_tx_check` кожного довідника «Ролей» є
  відмова `delta-domain` з `EXISTS` над дельтами ролі `v_pending.key`, де
  `NOT EXISTS (SELECT 1 FROM rights_roles() m JOIN rights_domain() d ON
  d.level = m.level AND d.level_id IS NOT DISTINCT FROM m.level_id WHERE
  m.role_id = <архетип ролі> AND <сховище довідника> AND d.object = … AND
  d.action = … AND d.extent = … AND d.dimension_id IS NOT DISTINCT FROM …)`
  (`rights_roles()` — усередині `NOT EXISTS`, інакше невідомий архетип
  пройшов би), і ця відмова не стоїть під `NOT v_pending.maintenance`.
  Умова сховища — `m.storage = 'scope' AND m.storage_id = '<scopeKindId>'`
  для довідника рівня скоупу, `m.storage = 'global'` для глобального.
  Перевіряються лише дельти, змінені в транзакції: (1) живі рядки дельт ролі
  з записом `rights_journal` цієї транзакції (`j.xid = v_pending.xid`,
  `j.relation` — таблиця дельт, `j.row_id` — id живої дельти, `after IS NOT
  NULL`) — завжди; (2) усі живі дельти
  ролі — коли архетип **першого** образу ролі в транзакції (`DISTINCT ON
  (row_id) … ORDER BY seq` за `xid`, `relation`, `row_id = v_pending.key`)
  `IS DISTINCT FROM` архетипу живого рядка, зокрема коли перший `before`
  порожній; запису ролі в журналі транзакції немає — архетип не змінився
  (форма — `EXISTS` над першим образом, не скалярний підзапит, що дав би
  `NULL`); позначка видалення винятку не дає. Умова журналу — лише `xid`, `relation`, `row_id`: **без
  `reason`** (режим обслуговування пише `reason = 'maintenance'`), тож
  фрагмент `stateRows` з `reason = 'command'` не копіювати; unit-тест
  перевіряє, що `reason` в умові немає.
  Перевірити й ребра `requires` функції на `rights_roles` і `rights_domain`.
- [ ] **Step 2: Запустити — червоне.** `pnpm --filter simetra test rights-guards` → FAIL.
- [ ] **Step 3: Реалізувати** перевірку в гілці `role` (поряд із
  `role-in-use`, безумовно) і явні ребра `requires`
  (`unitNode(RIGHTS_FUNCTIONS.roles)`, `unitNode(RIGHTS_FUNCTIONS.domain)`;
  табличних ребер `rights_tx_check` на довідники прав сьогодні немає, тож
  нових не додавати). Коментар — чому на
  COMMIT, чому лише змінене в транзакції і чому домен, а не CHECK
  (посилання — спека прав §7). Відмова `delta-domain` стоїть до
  `escalationSql`. Дельти читати за батьком зі `scopedDoc`, як `deltaArray`,
  але журнал — без `reason`; роль — за PK: кейс гейта `the COMMIT check reads
  rights tables by index` забороняє `Seq Scan` таблиць прав.
- [ ] **Step 4: Запустити — зелене.** `pnpm --filter simetra test rights-guards` → PASS.
- [ ] **Step 5: Засів сиріт.** Помічник `insertOrphan` у `rights-seed.ts`;
  коментар у ньому: так можна лише в засіві тестової транзакції, бо відкат
  повертає тригери, а сирота імітує зміну коду після запису. У
  `rights-functions.db.test.ts` черга на COMMIT не скидається (опис
  відкочується без `SET CONSTRAINTS`), тож три дельти поза доменом ролі
  `custom` там не відмовляють; перевести їх на `insertOrphan` — лише захист
  від майбутнього скидання, кейси читання fail-closed лишаються.
- [ ] **Step 6: DB-кейси** (`rights-guards.db.test.ts`, у наявному описі
  адміністрування з одним розгортанням; засів — як у `rights-seed.ts`;
  `SET CONSTRAINTS ALL IMMEDIATE`, щоб перевірка спрацювала в межах кейсу):
  - `deny` з UUID кастомної дії фікстури в неканонічній формі
    (`REASSIGN_ACTION_ID.replaceAll("-", "")`: id фікстури без hex-літер,
    тож верхній регістр дає той самий рядок) → `42501`, `DETAIL`
    `delta-domain`; те саме — дія з одруком (`"reed"`); `deny region read own`
    (об'єкт без власності) → `delta-domain` (обов'язковий кейс); дельта ролі
    з архетипом поза `rights_roles()` → `delta-domain`; роль у `org_roles`
    з глобальним архетипом `SUPPORT_ID` і дельтою `allow announcement read
    any` (у глобальному домені) → `delta-domain` (умова сховища,
    обов'язковий кейс); вставка дельти поза доменом у позначену роль
    (`markedCustom`) → `delta-domain`; зміна архетипу позначеної ролі на
    контейнерний при дельті `task_comment read any` → `delta-domain`;
    перевставка ролі одним оператором (`WITH d AS (DELETE FROM
    public.org_roles WHERE id = … RETURNING id, org_id) INSERT INTO
    public.org_roles (id, org_id, archetype) SELECT id, org_id,
    '<PROJECT_WRITER_ID>' FROM d`) видаляє її дельти каскадом — COMMIT
    проходить; перенесення дельти поза доменом в іншу роль `UPDATE
    parent_id` → `delta-domain`;
  - той самий `deny` у канонічній формі проходить, а `rights_mine` після
    нього права не дає;
  - роль у `org_roles` з архетипом рівня скоупу (`TASK_EDITOR_ID`) і дельтою
    `task_comment read any` (у домені `org`, поза контейнерним): зміна
    архетипу на контейнерний (`PROJECT_WRITER_ID`) актором `root`
    (`OrgAdmin`) → `delta-domain`; зміна архетипу в межах рівня проходить;
  - одна команда `org_roles_save` з новим архетипом і заміною дельт на
    дельти в домені нового рівня проходить — кейс у
    `packages/simetra/test/db/catalog-command-admin.db.test.ts`, де є
    обв'язка виклику `_save` і актор `root`;
  - сирота (засіяна `insertOrphan` лише в точці збереження кейсу, після
    скидання черги, на вже засіяній ролі; не в `seedAdministration`): на
    `unusedCustom` — `DELETE` сироти, призначення ролі, позначка видалення,
    перейменування (`description`) і зміна архетипу A→B→A в одній
    транзакції проходять; на `markedCustom` — зняття позначки видалення
    проходить;
  - дельта поза доменом у режимі обслуговування → `delta-domain`.
- [ ] **Step 7: Запустити.** `pnpm --filter simetra test:db rights-guards rights-functions rights-plan-gate catalog-command-admin snake-case rights-analysis`
  і `pnpm --filter @simetrajs/designer test:db rights-last-full-access` → PASS.
  Інші засіви дельт аудит перевірив — вони в домені; якщо щось червоніє з
  `delta-domain`, доповісти архітекторці (засів виправляється, перевірка
  лишається).
- [ ] **Step 8: Спека.** Спека прав §7 — пункт Рб2-7 (текст у полі «вплив
  на спеку»).
- [ ] **Step 9: Коміт.**
  `git commit -m "fix(rights): дельта кастомної ролі лише з домену її рівня"`
- [ ] **Step 10: Мутації** (на закоміченому дереві): (а) прибрати перевірку
  → червоніють кейси відмови; (б) прибрати `extent` з рівності → червоніє
  кейс `deny region read own`; (д) прибрати умову сховища → червоніє кейс
  `SUPPORT_ID` в `org_roles`; (е) перевіряти всі дельти ролі без умови
  журналу → червоніють кейси призначення, перейменування й зняття позначки
  ролі з сиротою; (є) судити зміну архетипу за кожним рядком журналу
  окремо → червоніє кейс A→B→A; (ж) пропускати позначену роль → червоніють
  кейси вставки в `markedCustom` і зміни архетипу позначеної ролі; (з)
  додати до умови журналу `j.reason = 'command'` → червоніє кейс режиму
  обслуговування; (в) винести `rights_roles()` з `NOT
  EXISTS` у зовнішній `JOIN` → червоніє кейс невідомого архетипу; (г)
  поставити перевірку під `NOT v_pending.maintenance` → червоніє кейс режиму
  обслуговування.

### Задача 3: реєстр платформних тригерів (Рб2-3)

**Files:**
- Create: `packages/simetra/src/compiler/platform-triggers.ts`
- Modify: `packages/simetra/src/compiler/index.ts` (експорт)
- Modify: `packages/simetra/src/schema/reverse/units.ts` (`platformTriggerFunction`, `platformFunctions`)
- Modify: `packages/simetra/src/schema/apply/promotion/replacements.ts` (`triggerReplacement`)
- Modify: `packages/designer/src/schema-engine/__tests__/round-trip.db.test.ts` (`mechanicsLoss`)
- Test: `packages/simetra/src/compiler/__tests__/platform-triggers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PlatformTriggerFamily =
    | "mechanics" | "author" | "key" | "carriers"
    | "hierarchy" | "effects" | "rightsGuards"
  export interface PlatformTrigger {
    family: PlatformTriggerFamily
    trigger: string
    function: QualifiedName
    /** Генератор одиниці тригера (`SqlUnit.generator`). */
    generator: "mechanics" | "key" | "carriers" | "effects" | "rightsGuards"
    /** Тригер оновлення, платформний лише з умовою змісту таблиці. */
    contentUpdate: boolean
  }
  export function platformTriggers(table: QualifiedName): PlatformTrigger[]
  /** Функції тригерів, спільні для всіх таблиць проєкту. */
  export const SHARED_TRIGGER_FUNCTIONS: readonly QualifiedName[]
  ```
- Consumes: наявні помічники імен (`mechanicsTriggerName`,
  `mechanicsUpdateTriggerName`, `authorTriggerName`, `authorUpdateTriggerName`,
  `keyTriggerNames`, `carrierTriggerNames`, `carrierFunctionNames`,
  `hierarchyNames`, `effectsTriggerNames`, `effectsFunctionName`,
  `rightsGuardNames`) і `MECHANICS_FUNCTION`, `AUTHOR_FUNCTION`, `KEY_FUNCTION`.

- [ ] **Step 1: Тест реєстру.** `platform-triggers.test.ts`:
  - `it("names every platform trigger of compiled models")` — на двох
    моделях з `src/compiler/__tests__/fixtures/rights.ts`:
    `compileRights(policyDomain(writeRoles(), adminRoles(), commandCoreLayer()))`
    (носії, ефекти, запобіжники; `Ticket` з `trackAuthor` і `hierarchyType`)
    і `compileRights(singleTenantRights(authorCarrier()))` (оновлення
    механіки й авторства з умовою змісту). Для кожної одиниці
    `class === "trigger"` з генератором із `PlatformTrigger["generator"]` на
    таблиці `model.physical.tables` поза `PLATFORM_SCHEMA` є запис реєстру з
    тим самим іменем тригера, функцією й генератором. Об'єднання знайдених
    сімейств обох моделей дорівнює всім `PlatformTriggerFamily`.
    Платформні таблиці прав (`simetra.rights_tx_pending` з тригером
    `rights_tx_pending_check`) виключено свідомо: схема `simetra` поза
    межею звірки reverse і промоції, тож реєстр таблиць виду їх не описує
    (коментар у тесті);
  - `it("marks only update triggers of mechanics and author as content-bound")` —
    `contentUpdate === true` рівно для `mechanicsUpdateTriggerName` і
    `authorUpdateTriggerName`;
  - `it("lists the shared functions")` — `SHARED_TRIGGER_FUNCTIONS` дорівнює
    `[MECHANICS_FUNCTION, AUTHOR_FUNCTION, KEY_FUNCTION]`.
- [ ] **Step 2: Запустити — червоне.**
  `pnpm --filter simetra test platform-triggers` → FAIL (модуля немає).
- [ ] **Step 3: Реалізувати `platformTriggers`** — список сімейств у порядку
  типу; генератор: механіка, авторство й ієрархія — `"mechanics"`; ключ —
  `"key"`; носії — `"carriers"`; ефекти — `"effects"`; запобіжники —
  `"rightsGuards"`. Експорт з `compiler/index.ts`.
- [ ] **Step 4: Запустити — зелене.** `pnpm --filter simetra test platform-triggers` → PASS.
- [ ] **Step 5: Перевести reverse і промоцію.** Reverse:
  `platformTriggerFunction` — запис реєстру з `trigger === unit.name`, його
  функція; `platformFunctions` стартує з `SHARED_TRIGGER_FUNCTIONS`.
  Промоція: предикат `platform(t)` у `triggerReplacement` — є запис з
  `t.name === e.trigger && sameFunction(t.function, e.function) &&
  (!e.contentUpdate || contentUpdate(t))`. `touch`, `touchUpdate` і
  `contentUpdate` лишаються для гілки `moddatetime` (`replaced:
  desired.some(content === undefined ? touch : touchUpdate)`), але
  виводяться з записів реєстру сімейства `mechanics`. Видаляються `author`,
  `keyGuard`, `carrier`, `effect`, `guard`, `hierarchy` і невживані
  імпорти. Тест:
  `pnpm --filter simetra test reverse-generate promotion` → PASS.
- [ ] **Step 6: Перевести `mechanicsLoss`.** Втрачені тригери й функції — записи
  `platformTriggers(t)` з генератором `"mechanics"` чи `"key"`; функції —
  унікальні за `schema.name` і лише зі схем `scope.schemas` (спільні поза
  межею). Реєстр замінює лише ручний перелік **кандидатів**: фільтр за
  ідентичностями фактично вилучених `lostUnits` (тригерів і функцій)
  лишається, бо реєстр повертає й тригери, яких таблиця не має. Перевірки `toHaveLength`
  лишаються. Тест:
  `pnpm --filter @simetrajs/designer test:db round-trip` → PASS.
- [ ] **Step 7: Коміт.**
  `git commit -m "refactor(compiler): один реєстр платформних тригерів для reverse, промоції й прийому з нуля"`
- [ ] **Step 8: Мутації:** (а) прибрати запис ієрархії з реєстру → червоніють
  тест повноти й `reverse-generate`; (б) поставити `contentUpdate: false` для
  оновлення механіки → червоніє тест промоції чи реєстру.

### Задача 4: «Вид користувача» за логічним ім'ям (Рб2-4)

**Files:**
- Modify: `packages/simetra/src/model/kinds/catalog.ts` (`USER_PLATFORM_COLUMNS`)
- Modify: модуль, що експортує `userPlatformColumns` з `simetra/model` (той самий шлях експорту)
- Modify: `packages/simetra/src/compiler/rights/guard-units.ts`

**Interfaces:**
- Produces: `USER_PLATFORM_COLUMNS: Readonly<Record<"userKind" | "invalid", StandardColumnDef>>`
  (форма — як `RIGHTS_COLUMNS`: `Object.fromEntries(userPlatformColumns().map(…))`).

- [ ] **Step 1: Мутація до правки:** переставити записи в
  `userPlatformColumns()` → `pnpm --filter simetra test rights-guards` FAIL
  (кейс із `o.user_kind IS DISTINCT FROM n.user_kind`). Відкотити.
- [ ] **Step 2: Реалізувати** константу й замінити `USER_KIND` на
  `USER_PLATFORM_COLUMNS.userKind`.
- [ ] **Step 3: Запустити.** `pnpm --filter simetra test rights-guards` → PASS.
- [ ] **Step 4: Мутація після правки:** та сама перестановка →
  `rights-guards` PASS. Відкотити.
- [ ] **Step 5: Коміт.**
  `git commit -m "refactor(rights): колонка виду користувача за логічним ім'ям реєстру"`

### Задача 5: лінт стандартних імен і `?.` (Рб2-5)

**Files:**
- Modify: `packages/simetra/eslint.standard-columns.js`
- Test: `packages/simetra/test/standard-columns-lint.test.ts`

- [ ] **Step 1: Тест.** До `rejects %s` додати
  `["an optional chain on the right", 'c.origin?.standard === "customRole"']`
  і `["an optional chain on the left", '"customRole" !== c?.origin?.standard']`;
  до `allows %s` — `["an optional non-standard check", "c.origin?.standard === undefined"]`.
- [ ] **Step 2: Запустити — червоне.** `pnpm --filter simetra test standard-columns-lint` → FAIL (два нові `rejects`).
- [ ] **Step 3: Реалізувати.** Селектор першого правила доповнити варіантами,
  де операнд — `ChainExpression` з `expression.property.name='standard'`
  (обидва боки). Повідомлення те саме — одна відмова на вираз.
- [ ] **Step 4: Запустити.** `pnpm --filter simetra test standard-columns-lint` → PASS;
  `pnpm --filter simetra lint` → без помилок (у коді `?.standard ===` з
  літералом немає; якщо є — доповісти, не вимикати правило).
- [ ] **Step 5: Коміт.**
  `git commit -m "fix(lint): правило стандартних імен ловить необов'язковий ланцюжок"`

### Задача 6: гейт планів і глобальні дельти (Рб2-6)

**Files:**
- Modify: `packages/simetra/test/db/rights-plan-gate.db.test.ts`

- [ ] **Step 1: Засів.** Глобальний довідник — у тій самій формі, що
  довідник `org` (вибірковий доступ за роллю, без неселективного індексу):
  - кілька сотень глобальних кастомних ролей (`archetype: SUPPORT_ID`) по
    одній дельті `allow announcement create any`, і стільки ж глобальних
    призначень користувачам, вставленим напряму в `public.users (id)` (як у
    `packages/designer/src/__tests__/rights-last-full-access.db.test.ts`) —
    одним `INSERT … SELECT generate_series` на таблицю, `line_number = 1`;
  - роль **`gate.full`** — окрема глобальна кастомна роль з двома дельтами:
    `globalDeltaRow(role, 1, ["allow", "announcement", "create", "any"])`
    (гілка `allow`, `JOIN deltas`) і
    `globalDeltaRow(role, 2, ["deny", "announcement", "read", "any"])` (гілка
    `deny`; `task` скоуплений і поза глобальним доменом — Задача 2),
    призначена через `global_role_assignments` (`assignmentRow`): тест тіл
    функцій прав (`autoExplain(gate.full, …)`) виконується від нього;
  - масові оператори — сирим `client.query` усередині наявного блоку
    `set_config(…, 'on')` / `'off'` у `seed`, інакше `rights-context`;
    рядки `gate.full` — помічником `insert` поза цим блоком (він сам вмикає
    і вимикає режим); користувачів вставляти раніше за призначення.
  `RIGHTS_TABLES` доповнити `"global_role_assignments"`, `"global_roles"` і
  `"global_roles_delta"`; ці таблиці й `public.users` — і в наявний оператор
  `ANALYZE`. Після
  засіву — `count(global_roles) > 1` і `count(global_roles_delta) > 0`.
- [ ] **Step 2: Запустити.** `pnpm --filter simetra test:db rights-plan-gate` → PASS.
  Якщо гейт червоніє на глобальних таблицях — це знайдений дефект: доповісти
  архітекторці з планом запиту, не вимикати перевірку.
- [ ] **Step 3: Коміт.**
  `git commit -m "test(rights): гейт планів перевіряє й глобальні дельти"`
- [ ] **Step 4: Мутація** (на закоміченому дереві): у генераторі
  `rights_mine` (`packages/simetra/src/compiler/rights/functions.ts`) додати
  до архетипної гілки (`role_rows`, `JOIN rights_projection p`) скалярний
  підзапит, який планувальник не розкорелює: `AND (SELECT count(*) FROM
  public.global_roles_delta x WHERE x.object = p.object) >= 0` (`SubPlan`
  на кожен рядок `Function Scan` над `rights_projection()` — цикли
  дорівнюють кількості рядків проєкції; індексу на `object` немає) → гейт червоніє `Seq Scan` з `loops >
  1` саме на `global_roles_delta`; записати фактичну кількість циклів; на дереві без нових рядків `RIGHTS_TABLES` та сама
  мутація гейт не червонить. Записати обидва результати.

### Задача 7: борг і документи

**Files:**
- Modify: `docs/superpowers/plans/2026-10-26-rights-residual-debt.md`

- [ ] **Step 1:** Додати в §1 пункт (архітекторка): «`apply`/`plan` не
  відмовляють, коли застосування йде під спільним входом провайдера чи
  суперкористувачем; власником об'єктів застосунку тоді стає вхід, під яким
  працюють сервіси провайдера. Кандидат — гейт застосування». Зняти з §3 пункти `RIGHTS_TABLES`, `USER_KIND`, правило
  лінту й три ручні переліки. Зняти з §1 пункт «Запобіжник режиму
  обслуговування — заборонний список логінів» (закрито Задачею 1).
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` → без помилок
  (з дозволу архітекторки — разом з гейтами).
- [ ] **Step 3: Коміт.**
  `git commit -m "docs(plan): борг прав — знято пункти борг-2"`

## Відомі обмеження

- Застосування плану під спільним входом провайдера чи суперкористувачем
  не відмовляється (гейт застосування — новий пункт боргу, Задача 7).
- Груповий `NOLOGIN`-власник функцій прав робить режим обслуговування
  недоступним (Рб2-2).
