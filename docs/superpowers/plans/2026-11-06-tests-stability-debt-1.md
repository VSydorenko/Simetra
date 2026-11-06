# Стабільність і прогалини тестів, частина 1 — план виконання

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Мета:** закрити п'ять пунктів реєстру боргу §7 «Тести»: флейк входу ролі
через пулер, Правило 1 для таблиць схеми `simetra`, мутаційну перевірку
політик читання й копій носіїв, підказку перегенерації JSON Schema і локальний
будівник ролі адміністратора прав.

**Архітектура:** зміни лише в тестах, тестовій підтримці та скрипті пакета.
Продуктовий код не змінюється. Мутації задачі 3 — тимчасові правки генератора
в робочій копії, вони не комітяться.

**Стек:** Vitest (проєкти `unit` і `db`), локальний Supabase-стек (Supavisor
2.9 у режимі транзакцій), pnpm.

**Джерело вимог:** реєстр боргу
`docs/superpowers/plans/2026-10-30-archive-residual-debt.md` §7 (пункти
«Флейк входу тегованої ролі…», «Таблиці схеми `simetra` під Правилом 1»,
«Мутаційна перевірка політик читання й копій носіїв», «Перегенерація JSON
Schema», «Локальний будівник ролі адміністратора прав»). Форма тестів — скіл
`.agents/skills/writing-tests/SKILL.md`.

## Глобальні обмеження

- Робоча копія — лише worktree `/home/vsydorenko/Simetra-tests`, гілка
  `test/stability-debt-1`. Основний checkout не чіпати.
- Стек спільний: не зупиняти й не перезапускати. DB-прогони — лише через
  проєкт `db` (guard серіалізує). Повний `pnpm test:db` — один раз, у задачі 6.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter`.
- Не чіпати файлів паралельного B1a поза потребою:
  `packages/designer/src/__tests__/command-runtime.db.test.ts` і
  `packages/designer/src/__tests__/carrier-locks.db.test.ts` не редагувати
  (задача 3 лише запускає їх).
- Коміти: Conventional Commits, опис українською, без трейлерів.
- Коментарі в коді — українською, пояснюють «чому».
- 🔴 Не використовувати `git stash`: `refs/stash` спільний для всіх worktree
  репо, і паралельна сесія в основному checkout може забрати чужий stash.
  Тимчасово зняти правку — через патч у scratchpad і `git apply`.
- Перший коміт гілки — цей план (`docs(plan): план стабільності тестів,
  частина 1`), щоб перевірки «`git status` порожній» були виконувані.

## Що з'ясовано до плану

**Причина флейку пулера (задача 1) — відтворено.** Проба під guard: роль
`simetra_probe_<тег>` створено, вхід через пулер — успіх; роль видалено й
створено знову з тим самим ім'ям і новим паролем — вхід через пулер дає
`28P01 password authentication failed` щоразу. Роль з новим ім'ям входить.
Отже Supavisor тримає секрет ролі за ім'ям, і перестворена роль зі старим
ім'ям не входить, доки кеш не скинеться. `withRuntimeLogin`
(`packages/designer/src/__tests__/support/db.ts`) називає роль
`testRoleName(label)`, тобто `simetra_<label>_<тег>` без випадкового хвоста.
Мітка за замовчуванням `runtime` повторюється в кількох DB-файлах designer
одного прогону: через пулер з нею входять `command-runtime` і перший блок
`commands` у `rights-admin-commands`. Те саме ім'я `simetra_runtime_<тег>`
створює й `roles-tool.db.test.ts` (`testRoleName("runtime")`). Через пулер такий файл падає, коли попередній файл уже закешував
секрет ролі з тим самим ім'ям. Поразковість залежить від порядку файлів і
часу життя кешу. Повтор із межею лише чекав би скидання кешу. Виправлення —
унікальне ім'я ролі на кожен виклик.

## Фокус рев'ю

1. Унікальне ім'я ролі лишається тегованим: прибиральник
   (`runObjectPatterns`, `runTagOf` у `packages/simetra/test/db/connection.ts`)
   впізнає його як роль цього прогону. Тест задачі 1 це перевіряє.
2. Ім'я ролі не довше 63 байтів. Найдовша мітка сьогодні —
   `data_owner_member` (`data-tools.db.test.ts`): 39 байтів з хвостом і
   тегом, запас великий.
3. Рядки Правила 1 (задача 2) — по одному на таблицю, і мутація походження
   однієї таблиці червонить саме її рядок.
4. Мутація задачі 3, після якої все зелене, закривається тестом, а не
   записом «дірка».
5. Скрипт перегенерації (задача 4) не пише файлів у звичайному `pnpm test`.

---

### Задача 1: унікальна роль входу на кожен виклик

**Файли:**

- Змінити: `packages/designer/src/__tests__/support/db.ts` (функція
  `withRuntimeLogin`)
- Створити: `packages/designer/src/__tests__/runtime-login.db.test.ts`

**Інтерфейси:**

- Сигнатура `withRuntimeLogin(url, memberOf, fn, label = "runtime",
  attributes)` не змінюється. Змінюється лише ім'я ролі:
  `testRoleName(\`${label}_${хвіст}\`)`, хвіст — 6 символів `[0-9a-f]`
  (`randomBytes(3).toString("hex")`).

- [ ] **Крок 1: тест, що падає.** DB-тест (причина рівня — кеш секретів
  Supavisor, юніт його не бачить) у `runtime-login.db.test.ts`:
  `it("two logins with the same label both enter through the pooler and stay run-tagged")`.
  Двічі поспіль `withRuntimeLogin(testDatabaseUrl(), [], fn, "runtime_cmd")`.
  У кожному `fn`: клієнт `pg` на `throughPoolerAs(login)`, `SELECT 1`
  успішний, `client.end()` у `finally` (інакше прибирання ролі обриває
  відкритий клієнт); `runTagOf("role", new URL(login).username)` дорівнює `runTag()`.
  Після обох викликів: імена ролей різні.
- [ ] **Крок 2: запуск — червоний.**
  `pnpm --filter @simetrajs/designer exec vitest run --project db runtime-login`.
  Очікувано: другий вхід — `28P01` (або рівність імен).
- [ ] **Крок 3: реалізація.** Хвіст у імені ролі в `withRuntimeLogin`.
  Коментар «чому»: Supavisor кешує секрет ролі за ім'ям, перестворена роль з
  тим самим ім'ям не входить через пулер. Оновити JSDoc: `label` тепер лише
  читабельна частина імені, унікальність дає хвіст.
- [ ] **Крок 4: запуск — зелений.** Та сама команда. Вирішальний доказ —
  тест кроку 1: на старому коді він червоний детерміновано. Допоміжно —
  файли, що входять тією самою міткою, п'ять разів поспіль:
  `for i in 1 2 3 4 5; do pnpm --filter @simetrajs/designer exec vitest run --project db rights-admin-commands command-runtime roles-tool || break; done`.
  Очікувано: п'ять зелених прогонів. Порядок файлів задає sequencer vitest,
  тож контроль на старому коді може й не почервоніти — це не дефект доказу.
  Контроль без `git stash`: `git diff -- packages/designer/src/__tests__/support/db.ts > <scratchpad>/fix.patch`,
  `git checkout -- packages/designer/src/__tests__/support/db.ts`, цикл,
  `git apply <scratchpad>/fix.patch`, `git diff --stat` — лише `db.ts`.
- [ ] **Крок 5: коміт.**
  `fix(test): унікальна роль входу на кожен виклик — кеш секретів Supavisor не ламає вхід через пулер`.

### Задача 2: таблиці схеми `simetra` під Правилом 1

**Файли:**

- Змінити: `packages/simetra/src/compiler/__tests__/kind-table-verbatim.test.ts`
  (блок `describe("sql.kind-table-verbatim: application SQL does not write a kind table …")`)

**Інтерфейси:**

- Споживає: `SNAPSHOT_TABLES` з `packages/simetra/src/compiler/rights/actor-snapshot.ts`
  (як у `packages/simetra/test/db/catalog-command-admin.db.test.ts`), наявні
  помічники файлу `plpgsqlFn`, `bodyVerbatim`, `files`, `brief`, `EXTRA`.

- [ ] **Крок 1: тест.** Окремий `it.each` поруч із наявною таблицею «→ error,
  not debt»: по рядку на таблицю — `simetra.rights_versions`,
  `simetra.rights_journal`, `simetra.rights_tx_pending`, `simetra.identities`
  і кожне значення `SNAPSHOT_TABLES` (об'єкти `{ schema, name }`, рядок —
  `` `${t.schema}.${t.name}` ``). Зараз це всі 12 таблиць
  `rightsAdminTables` плюс `identities`; при нагоді взяти перелік зі
  скомпільованої моделі, щоб нова таблиця не випала з тесту.
  Тіло: `plpgsqlFn("DELETE FROM <таблиця> WHERE false")`. Очікування:
  `brief(result.diagnostics)` дорівнює
  `[bodyVerbatim(EXTRA, "<таблиця>", "DeleteStmt")]`. Назва:
  `"%s → error: a platform table of the snapshot is a kind table"`.
  Якщо `policyDomain(promotableTaskNote())` не дає котроїсь із таблиць
  (немає власника `roleAssignments` чи `users`), зупинитися й повідомити
  архітекторці, а не міняти фікстуру мовчки.
- [ ] **Крок 2: запуск — зелений.**
  `pnpm --filter simetra test kind-table-verbatim`.
- [ ] **Крок 3: мутація.** Тимчасово в `rightsAdminTables`
  (`packages/simetra/src/compiler/rights/admin-tables.ts`) дати таблиці
  `rights_versions` `origin.objectId: ""` — перевизначенням одного елемента
  (`{ ...table("rights_versions", …), origin: { objectId: "", part: "rightsVersions" } }`),
  бо `objectId` задає спільний помічник `table()`. Очікувано: червоний лише рядок
  `simetra.rights_versions`. Те саме для `simetra.identities` у
  `packages/simetra/src/compiler/platform/identities.ts`. Відкотити;
  `git diff --stat` показує лише файл тесту.
- [ ] **Крок 4: коміт.**
  `test(compiler): Правило 1 для таблиць схеми simetra — рядки з мутацією`.

### Задача 3: мутаційна перевірка політик читання й копій носіїв

**Файли:**

- Запуск (не редагувати): `packages/simetra/test/db/rights-policies.db.test.ts`,
  `packages/designer/src/__tests__/carrier-locks.db.test.ts`
- Тимчасово мутувати: генератори SQL прав і носіїв у `packages/simetra/src/`
  (точне місце кожної мутації виконавець знаходить сам: `orient` або пошук за
  ім'ям політики чи тригера)
- Можливо змінити: `packages/simetra/test/db/rights-policies.db.test.ts` —
  лише якщо мутація лишила все зеленим (крок 3)

**Інтерфейси:** немає нових.

Перелік мутацій і кейс, що мусить почервоніти (з реєстру боргу):

| # | Мутація згенерованого SQL | Кейс |
| --- | --- | --- |
| 1 | прибрати `task_read_own` | `own` |
| 2 | прибрати `_read_region` | `dimension` |
| 3 | прибрати `_read_in_project_any` | `container` |
| 4 | прибрати `users_scope_read` | `users-cross-tenant` |
| 5 | з'єднання `rights_visible_users` лише за скоупом | `users-cross-kind` |
| 6 | прибрати `users_devices_scope_read` | `users-devices-cross-tenant` |
| 7 | прибрати політику ТЧ | `tabular` |
| 8 | прибрати копію шляху з предиката | `path` |
| 9 | прибрати поширення копії до ТЧ коментаря | `path-tabular` |
| 10 | прибрати предикат ТЧ за `parent_id` для носія-ключа | `key-carrier` |
| 11 | прибрати політику підсумків | `register-totals` |
| 12 | тригер носіїв бере значення з запиту | `forged-copy` |
| 13 | прибрати гілку `INSERT` тригера поширення | `source-after-dependent` |
| 14 | прибрати тригер поширення | `propagation-owner` |
| 15a | прибрати `contentChangeCondition` механіки | `propagation-path` |
| 15b | прибрати `contentChangeCondition` підписки | `propagation-path` |
| 16 | прибрати `FOR SHARE` на `INSERT` | «inserting a tabular row waits…» (`carrier-locks`) |
| 17 | прибрати блокування власника на `UPDATE` рядка ТЧ | «… does not deadlock» (`carrier-locks`) |
| 18 | `RESTRICTIVE` → `PERMISSIVE` у `task_scope_read` | `member-without-role` |

- [ ] **Крок 1: базова лінія.** Дерево чисте (`git status` порожній). Обидва
  файли зелені:
  `pnpm --filter simetra exec vitest run --project db rights-policies` і
  `pnpm --filter @simetrajs/designer exec vitest run --project db carrier-locks`.
- [ ] **Крок 2: мутації по одній.** Для кожного рядка таблиці: одна правка
  генератора; запуск відповідного файлу; записати, які кейси червоні; відкотити
  (`git checkout -- <файл>`); `git status` знову порожній. Мутація
  «зелена» — якщо очікуваний кейс не почервонів. Мутація, яку не вдається
  поставити, бо генератор уже не має такої форми, — записати з причиною й
  повідомити архітекторці.
- [ ] **Крок 3: дірки.** На кожну «зелену» мутацію — кейс у
  `rights-policies.db.test.ts` (рядок таблиці `CASES` або окремий `it`), який
  під цією мутацією червоний, а без неї зелений. Перевірити обидва стани.
  Будівники — наявні у файлі й у `packages/simetra/src/compiler/__tests__/fixtures/rights.ts`.
  Якщо дірка в `carrier-locks.db.test.ts` (мутації 16, 17) — не редагувати
  файл, а повідомити архітекторці: файл змінює B1a.
- [ ] **Крок 4: коміт** (лише якщо крок 3 додав тести). Перед комітом:
  мутацію відкочено, `git diff --stat` — лише `rights-policies.db.test.ts`,
  `git add` — лише цей файл.
  `test(rights): закрити дірки мутаційної перевірки політик читання`.
  Таблиця результатів (мутація → червоні кейси) — у описі PR і у звіті
  архітекторці, не в репо.

### Задача 4: підказка перегенерації JSON Schema

**Файли:**

- Змінити: `packages/simetra/package.json` (скрипт)
- Змінити: `packages/simetra/src/compiler/__tests__/json-schema.test.ts`

**Інтерфейси:**

- Скрипт пакета `schemas:update`:
  `UPDATE_JSON_SCHEMAS=1 vitest run --project unit json-schema`.

- [ ] **Крок 1: скрипт.** Додати `schemas:update` у `scripts` пакета
  `simetra`.
- [ ] **Крок 2: повідомлення.** У кейсі «schemas are up to date» друге
  аргументом `expect` — `` `${file} is stale: run pnpm --filter simetra schemas:update` ``.
  У кейсі «orphan json schema file…» — повідомлення, що зайвий файл треба
  видалити з `packages/simetra/schemas/`.
- [ ] **Крок 3: перевірка.** `pnpm --filter simetra schemas:update` —
  `git status` без змін у `packages/simetra/schemas/`, `pnpm format:check`
  зелений. Режим оновлення не видаляє зайвого файлу — кейс «orphan»
  червоніє й під `schemas:update`, це очікувано. Тимчасово змінити один
  `*.schema.json` — `pnpm --filter simetra test json-schema` червоний із
  підказкою; `pnpm --filter simetra schemas:update` — файл відновлено.
- [ ] **Крок 4: коміт.**
  `test(compiler): підказка й скрипт перегенерації JSON Schema`.

### Задача 5: спільний будівник ролі адміністратора прав

**Файли:**

- Змінити: `packages/simetra/test/db/catalog-command-admin.db.test.ts`

**Інтерфейси:**

- Споживає: `rightsAdminReadingMembers(): Layer` з
  `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` (гранти ті
  самі, що в локальному `RightsAdmin`).

- [ ] **Крок 1: заміна.** Локальний `rightsAdmins()` лишає тільки
  `BlindRightsAdmin` (перейменувати на `blindRightsAdmin()`); у
  `actorSnapshotDomain(…)` передати `rightsAdminReadingMembers()` і
  `blindRightsAdmin()` на місці нинішнього `rightsAdmins()` — після
  `adminRoles()`: шари зливаються поверхнево, пізніший `RightsAdmin`
  перезаписує `grants`. JSDoc — лише про сліпого двійника.
- [ ] **Крок 2: запуск — зелений.**
  `pnpm --filter simetra exec vitest run --project db catalog-command-admin`.
- [ ] **Крок 3: коміт.**
  `test(rights): спільний будівник адміністратора прав у catalog-command-admin`.

### Задача 6: реєстр боргу, гейти, PR

**Файли:**

- Змінити: `docs/superpowers/plans/2026-10-30-archive-residual-debt.md` §7

- [ ] **Крок 1: реєстр.** Прибрати п'ять виконаних пунктів §7. Пункт
  мутаційної перевірки прибрати, лише якщо всі мутації почервоніли або дірки
  закрито; інакше лишити залишок (які мутації й чому).
  `python3 scripts/check-doc-anchors.py` — чисто.
- [ ] **Крок 2: коміт.** `docs(plan): прибрати виконані пункти §7 боргу тестів`.
- [ ] **Крок 3: гейти.**
  `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, потім
  один повний `pnpm test:db`. Усе зелене.
- [ ] **Крок 4: PR у `main`.** Опис: що зроблено, причина флейку, таблиця
  мутацій, залишок. Звіт архітекторці. Мердж — за архітекторкою.
