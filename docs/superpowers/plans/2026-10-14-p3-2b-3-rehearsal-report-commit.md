# П3-2b-3 — звіт репетиції й застосування промоції з `COMMIT`: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** застосування промоції з `COMMIT` стає можливим, і лише після
репетиції на копії цієї цілі з даними:

1. репетиція доводить, що копія — копія саме цієї цілі (факти сервера,
   голова ledger, відбиток без власників), і пише звіт
   `plans/<from12>-<to12>.rehearsal.json`;
2. застосування промоції без чинного звіту відмовляє
   (`apply.rehearsal-required`), порожня на копії таблиця з рядками на цілі —
   відмова, менше рядків — попередження, `statement_timeout` виводиться зі
   звіту, хеш звіту лягає в ledger;
3. відмови `apply.promotion-checks-pending` і `plan.promotion-commit-pending`
   знято;
4. наскрізний тест повного циклу: `promote` з `fill` → `plan` → репетиція
   на копії з даними → `apply` з `COMMIT` → повторний `plan` порожній.

**Архітектура:**

- **T2 `packages/simetra/src/schema/apply/`**: новий модуль `rehearsal.ts`
  (схема звіту, побудова з доказів раннера, перевірка застарілості,
  формула тайм-ауту); `server.ts` (факти сервера), `state.ts` (голова ledger); раннер
  збирає докази репетиції.
- **`@simetra/designer`**: `apply --rehearse` пише звіт у `plans/`, `apply`
  його читає. `pg` і pg-delta в `simetra` не з'являються.

**Технології:** TypeScript 7, Zod 4, Vitest; локальний стек Supabase
(Postgres 17.6).

**Спека:**

- [спека промоції](../specs/2026-10-06-promotion-design.md): §7.2
  («З'єднання й блокування», «Перевірки перед `COMMIT`»), §8 («Репетиція з
  даними»: копія, звіт, застосування промоції, `statement_timeout»);
- [платформна спека](../specs/2026-09-24-simetra-platform-design.md): §6.1
  (ledger), §6.2 п.4–5, §6.10;
- [спека designer](../specs/2026-10-02-simetra-designer-design.md): §3.2
  (файли `plans/`, звіт репетиції).

Правки спек для цього плану вносить задача 1 плану
[П3-2b-2](2026-10-14-p3-2b-2-promotion-data-steps.md).

**Плани, на яких стоїть цей:** П3-1 (рішення 9, 11, 14), П3-2a (рішення 11 —
колонка ledger тим самим планом), П3-2b-1 (рішення 1, 7), П3-2b-2 (кроки
даних, `computeData`/`writeData`).

**Передумова:** П3-2b-2 виконано й прийнято; локальний стек; на checkout
комітить одна сесія.

**Архітектор задачі:** сесія `consumer-reconciliation2`; якщо її немає — до
власника.

**Поза планом (свідомо):** П3-3 (політики й тригери підписок, лічильники,
переклад міток, динамічний гейт доступу); П3-4; зворотне читання боргу й
затінення в `search_path`; підплан регістрів; шлях запису (Пр21);
нетранзакційні кроки; `ALTER … OWNER TO`; копія доказу під іншою роллю;
автоматичне готування копії з даними (спека §8: її дає оператор); апстрім-issue
pg-delta; реальна база споживача.

## Global Constraints

- 🔴 Усі Global Constraints плану П3-2b-2 діють і тут: стоп на розбіжності
  спеки, зона рушія, лише `set_config(…, true)`, жодного нашого об'єкта в
  `pg_temp` після транзакції, без `CASCADE`, UUID замість імені,
  `EngineObjectRef`, негативний тест кожного гейта (зокрема на рівні
  конвеєра), правила діагностик, `PLAN_FORMAT = 3`, тестові файли з новими
  полями — у коміті задачі, typecheck змінених пакетів, коментарі
  українською, без трейлерів, без `--` перед шаблоном vitest, DB-тести
  нічого не лишають, репо публічне.
- 🔴 **Звіт — не метадані й не план:** у `planHash` він не входить (спека
  §8). Він детермінований канонічний JSON без часу дня; тривалості в ньому —
  дані виміру, не мітки часу.
- 🔴 **Звіт пише будь-яка успішна репетиція, вимагає лише промоція** (спека
  §8).
- Формат звіту — `REHEARSAL_FORMAT = 1`; інший формат — «звіт застарів», без
  шиму.

## Review Focus

1. **Репетиція на staging того самого проєкту**, який отримав ті самі плани
   окремими застосуваннями. Ланцюжок, роль, відбиток і сервер збігаються.
   Очікування: `apply.target-changed` (`sections: "ledger"`), бо голова
   ledger інша, і звіту немає. Тест — задача 1.
2. **Копію відновлено з бекапу під іншими власниками об'єктів.** Очікування:
   фаза 6 репетиції порівнює відбиток без власників і цю різницю пропускає;
   `apply` на цілі порівнює з власником. Що робить далі повний доказ
   двигуна (фаза 18), фіксує задача 0 (рішення 1). Тест — задача 1.
3. **Звіт є, але план перебудовано** (той самий `from`/`to`, інший
   `planHash`). Очікування: `apply.rehearsal-stale` (`reason: "plan"`) до
   будь-якої транзакції. Тест — задача 4.
4. **Таблиця одиниці на копії порожня, а на цілі має рядки.** Очікування:
   `apply.rehearsal-copy-empty` у транзакції до першого кроку, нічого не
   записано. Тест — задача 4.
5. **Ціль у сто разів більша за копію на одній таблиці й рівна на решті.**
   Очікування: `statement_timeout` масштабується відношенням саме цієї
   таблиці, а не суми. Тест — задача 4 (чиста формула) і DB-тест значення
   `current_setting('statement_timeout')` у транзакції.

## Рішення плану

Розвилки вирішив архітектор задачі 2026-10-14 (розвилки 4–6 автора);
напрям правок спеки погодив власник, текст — задача 1 плану П3-2b-2.

1. **Доказ копії.** Список спеки §8 повністю, з такими механізмами:
   - ланцюжок (фаза 4) і роль (фаза 1a) — як є;
   - **відбиток на `rehearse` — без власників** (фаза 6): відновлена копія
     може мати інших власників; з власником порівнює `apply`. Повний доказ
     двигуна фази 18 порівнює витяг копії з бажаною тінню, а витяг pg-delta
     несе нетиповий власник (`map-model.ts`). Задача 0 це вимірює: якщо
     двигун на копії з іншим власником дає дію чи помилку, репетиція такої
     копії — `apply.rehearsal-proof-failed`, і це «Відоме обмеження»; якщо
     ні — `rolledBack`. Тест задачі 1 фіксує виміряну гілку. Вердикт
     архітектора для першої гілки:
     - власників із повного доказу **не виключати**: це послабило б доказ;
     - відмова називає причину, а не сирий diff: фаза 6 на `rehearse`
       запам'ятовує, чи різнилася секція власника відбитка
       (`ownersDiffer`, структурно з `compareFingerprints` з власником,
       без розбору SQL), і збій фази 18 при `ownersDiffer` —
       `apply.rehearsal-proof-failed` з параметром `cause: "owners"`:
       текст «the owners of the copy differ from the target», підказка
       «restore the copy with the plan's role and `pg_restore --no-owner`»
       (тоді власник — роль плану, як і на цілі за переписом власників
       П3-1); без `ownersDiffer` — як є, `count` і `first`;
   - **факти сервера** — нове поле артефакту `server` під `planHash`, яке
     `plan` читає в `READ ONLY`; нова фаза 4e на `rehearse` і `apply`:
     живі факти ≠ `plan.server` → `apply.target-changed` (`sections:
     "server"`);
   - **голова ledger** — нове поле артефакту `ledgerHead: string | null`
     (`apply_id` рядка ledger з найбільшим `id`; `null` — ledger немає чи він
     порожній), читає `plan`; фаза 4e: інша голова → `apply.target-changed`
     (`sections: "ledger"`). Для першого застосування (`null`) пункт нічого
     не додає — відомо й прийнятно.
2. **Факти сервера** (`ServerFacts`):
   `{ major: number; encoding: string; collate: string; ctype: string;
   localeProvider: string; locale: string | null; collationVersion: string |
   null }` з `server_version_num / 10000`, `pg_encoding_to_char(encoding)`,
   `datcollate`, `datctype`, `datlocprovider`, `datlocale` і
   `datcollversion` поточної бази `pg_database`.
3. **Звіт** (`rehearsal.ts`, Zod strict):

   ```ts
   interface RehearsalReport {
     format: 1
     planHash: string
     server: ServerFacts
     ledgerHead: string | null
     // таблиці — структурно { schema, table }, скрізь у старих іменах
     rows: { schema: string; table: string; rows: number }[] // з заміру 6a
     durations: {
       phases: { phase: string; ms: number }[]
       steps: { id: string; ms: number }[] // s<N>; оператор таблиці даних — першим d<N> таблиці
       longestStatementMs: number
     }
     data: { schema: string; table: string; computed: number; written: number }[]
     preservation: { schema: string; table: string; rows: number }[]
     plpgsqlCheck:
       | "skipped"
       | { mode: PlpgsqlCheckMode; baseline: FunctionError[]; after: FunctionError[] }
     triggers: { schema: string; table: string; name: string; enabled: "O" | "A" }[]
     lockFootprint: { table: string; mode: string; planned: string }[] // параметри apply.lock-footprint-exceeded
   }
   ```

   - Будує T2 чистою функцією `rehearsalReport(planHash, evidence)` з
     доказів раннера (рішення 4); файл пише `@simetra/designer` після
     `rolledBack` поруч із файлом плану (`rehearsalFileName(fromHash,
     toHash)` → `<from12>-<to12>.rehearsal.json`, той самий префікс, що
     `planFileName`), і вивід репетиції називає шлях файлу.
   - `plpgsqlCheck` — `"skipped"`, коли перевірку пропущено (план без
     промоції з режимом `unavailable`); інакше `baseline`/`after` у межі
     `FUNCTION_ERROR_LIMIT`, як перевірка.
   - Форма `table` у `data` — така сама, як у результаті `writeData` П3-2b-2
     (там вона структурна: `{ schema, table, computed, written }`, старі
     імена).
   - **Лічильники — числа.** Порт повертає `count(*)` (`bigint`) рядком
     (заміри 6a порівнюють `String(…)`). Докази перетворюють кожен лічильник
     (`rows`, `computed`, `written`) помічником `countOf(value: unknown):
     number`: десятковий рядок чи число → `Number`, перевірка
     `Number.isSafeInteger(n) && n >= 0`, інакше `Error` (дефект порту, не
     стан цілі). Схема звіту — `z.number().int().nonnegative()`.
   - **Вивід репетиції** (аудит Codex): `renderApply` для `rolledBack` зараз
     каже «nothing was written» — тепер «rolled back; the database was not
     changed; rehearsal report written to <шлях>»; `ApplyData` отримує
     `report: string | null`; CLI (`cli/render.ts`, де `artifacts` зараз
     лише для `plan`) і MCP (`mcp/tools.ts`) віддають `artifacts` і для
     `apply`.
4. **Докази раннера.** `ExecuteOutcome` статусу `rolledBack` у режимі
   `rehearse` несе `evidence: RehearsalEvidence` — усе для звіту, крім
   `planHash`/`format`.
   - **Вимір — обгорткою `ApplyTransaction`**, а не викликами в
     `execute.ts`: оператори йдуть і з помічників (`readFingerprint`,
     `function-checks.ts`, `locks.ts`, `withLocalSettings`,
     `computeData`/`writeData`). `runAttempt` у режимі `rehearse` загортає
     `tx` у `timedTransaction(tx, clock)`, яка міряє кожен `query` і
     приписує його поточній фазі; `runAttempt` ставить фазу
     (`setPhase(name, step?)`) на вході в кожну фазу й крок.
   - Годинник — `ExecuteBase.clock?: () => number`, типово
     `performance.now` (глобаль, без Node API).
   - Фази — за таблицею рішення 1 плану 2b-1 з доповненнями 2b-2/2b-3:
     `"advisory"`, `"role"`, `"timeouts"`, `"chain"`, `"targetChecks"`
     (4a–4e), `"lock"`, `"fingerprint"`, `"measureBefore"`, `"existing"`,
     `"baseline"`, `"compute"`, `"intent"`, `"write"`, `"engine"`,
     `"environment"`, `"deferred"`, `"measureAfter"`, `"revalidation"`,
     `"validity"`, `"verify"`, `"proof"`, `"state"`, `"footprint"`.
   - `tx.extract` (фази 17–18) не є оператором для `longestStatementMs`: на
     `apply` його немає, і він роздув би тайм-аут; його тривалість іде лише
     у фазу `"proof"`.
   - Докази — останньої спроби: попередні відкочено повтором.
5. **Застарілість звіту.** До транзакції (чисто, без бази):
   - звіт читає лише `apply` плану з промоцією: файл
     `rehearsalFileName(artifact.fromHash, artifact.toHash)` у `plans/`.
     План без промоції звіт не читає й не вимагає;
   - файлу немає → `apply.rehearsal-required`;
   - `parseRehearsal` з `reason: "format"` → `apply.rehearsal-stale`
     (`reason: "format"`) — у `apply-tools`, бо строгий тип з літералом
     `format: 1` інший формат не пропускає; `reason: "invalid"` →
     `UsageError`, як «is not a plan file»;
   - `report.planHash ≠ planHash` → `apply.rehearsal-stale` (`reason:
     "plan"`) — у раннері (`rehearsalRefusals`), бо `executePlan` не довіряє
     інструменту;
   - `report.server ≠ plan.server` → `apply.rehearsal-stale` (`reason:
     "server"`) — спека §8: «звіт іншого плану, формату чи сервера — відмова
     „звіт застарів“» (аудит Codex). `report.ledgerHead ≠ plan.ledgerHead` →
     `reason: "ledger"`. Звіт пише раннер після тих самих звірок, тож
     розбіжність означає підмінений файл, але звіт не під `planHash`, і
     раннер йому не довіряє;
   - **склад рядків звіту** (аудит Codex, блокер): `report.rows` має рівно
     один запис на кожну таблицю одиниці (`record.tables`, старі імена) і
     нічого більше; інакше → `apply.rehearsal-stale` (`reason: "tables"`).
     Без цього звіт з правильним `planHash` і `rows: []` оминув би гейт
     порожньої копії;
   - **живий сервер і голову ledger** цілі звіряє фаза 4e з `plan.server` і
     `plan.ledgerHead` → `apply.target-changed` (`sections: "server"` /
     `"ledger"`): це вже не звіт, а ціль, що змінилась. Два коди не
     суперечать спеці: перший каже про звіт, другий — про ціль.
6. **Рядки й тайм-аут — у транзакції** (правка §8, погоджена). Нова фаза 6c
   лише для `apply` промоції, після заміру «до» (6a, що вже рахує
   `count(*)` кожної таблиці одиниці під замками):
   - таблиця з рядками на цілі й `rows = 0` у звіті →
     `apply.rehearsal-copy-empty` (`table`), відмова;
   - менше рядків на копії → попередження `apply.rehearsal-fewer-rows`
     (`table`, `copy`, `target`);
   - якщо `statementTimeoutMs` не задано явно
     (`o.timeouts?.statementTimeoutMs === undefined`: злиті `timeouts` уже
     несуть типове значення) — `set_config('statement_timeout', …, true)` за
     формулою §8: `max(60 000, ⌈3 × longestStatementMs × max(1, maxₜ(ціль ₜ
     / копія ₜ))⌉)` мс за таблицями з рядками на копії. До 6c діє типовий
     тайм-аут раннера. `statement_timeout` немає ні в `DATA_SETTINGS`, ні в
     преамбулі, ні в ревалідації, тож `withLocalSettings` його не перекриє.
7. **Ledger.** Нова колонка `rehearsal_hash text`, хеш —
   `rehearsalHash(report)` = `sha256Hex(canonicalize(report))`. Значення —
   лише в застосуванні промоції; план без промоції пише SQL `NULL`. Колонку
   до старого ledger додає той самий план, що пише стан (рішення 11 плану
   2a): ledger — частина бажаного стану. Тест апгрейду (борг 2b-1) — у
   режимі `apply` планом без промоції: колонка з'являється, рядок має
   `NULL`; хеш промоції перевіряє наскрізний тест.
8. **Зняття відмов.** Одним комітом: гілка `apply.promotion-checks-pending`
   у `executePlan`, код і тексти; попередження й код
   `plan.promotion-commit-pending`; рядок скіла споживача; опис інструмента
   `apply`; рядок `docs/architecture/designer.md`.
9. **Гейти `COMMIT` промоції** — зелені всі, по черзі (вердикт
   архітектора):
   1. до транзакції: версії відбитків, преамбула, лінт, дозволи (зокрема
      `repair:`), `recordHash`, `preservesEveryTable`, `dataMatchesRecord`,
      порядок походження кроків, **НОВЕ** промоція з `plpgsqlCheck ===
      "unavailable"` — `Error` зламаного конвеєра (план таку відхиляє, тож
      це підмінений файл; інакше фаза 7 мовчки дала б `skipped`), звіт
      чинний;
   2. фази 1–4e: `busy`, роль, роль API, ланцюжок, `providerLocks`,
      `environment`, `foreignKeys`, режим `plpgsql_check`, сервер і голова
      ledger;
   3. 5 замки; 6 відбиток з власником; 6a заміри «до»; 6c рядки й тайм-аут;
   4. 7 базова лінія з `plpgsql_check` (не `skipped` — гарантує пункт 1);
   5. 8–10 обчислення, намір, тригери й запис, `SET CONSTRAINTS`;
   6. 11–13 двигун зі сторожами, середовище, `SET CONSTRAINTS`;
   7. 14 збереження; 15 ревалідація; 16 валідність; 17 відбиток = бажаний.

   Не на `apply`: повний доказ двигуна (18) і звірка сліду (19a) — їх дала
   репетиція, і звіт це несе.
10. **Запис звіту — нове значення осі файлів `"artifact"`.** `apply` з
    `files: "write"` отримав би `dryRun` (MCP `mcpInputSchema`, CLI
    `--dry-run`), а `invoke.ts` вважає `dryRun && files === "write"`
    переглядом без підтвердження — і `apply {dryRun: true}` закомітив би
    план без `confirm`. Тому `FILES_ACCESS = ["read", "artifact",
    "write"]`:
    - `"artifact"` — інструмент пише лише власні артефакти в `plans/`, без
      перегляду `dryRun` і без зміни метаданих;
    - `--read-only` (вісь дозволів `permits`) його забороняє, як `"write"`;
    - `apply` стає `files: "artifact"`;
    - **`plan` теж стає `"artifact"`** (вердикт архітектора: дві різні осі
      для «пише лише `plans/`» — розбіжність, яку ніхто потім не пояснить).
      `plan` пише лише артефакт (`outcome.artifacts`), метаданих не змінює,
      базу лише читає й не руйнівний. Його `dryRun` пропускав лише запис
      інертного файлу плану, який наступний `plan` однаково перезаписує,
      тож перегляд нічого не захищав. Тепер у `plan` немає `dryRun` і
      `--dry-run`; тести `plan` з `dryRun` (`apply-tools.db.test.ts`
      «plan writes the artifact next to metadata», `cli.test.ts` «apply has
      --yes and no --dry-run; plan has --dry-run», `mcp.test.ts` «`plan` пише
      лише файл») переписуються під нове правило;
    - `promote` лишається `"write"`: він змінює теку метаданих і пише запис
      у `plans/`, і його `dryRun` — справжній перегляд змін теки;
    - `invoke.ts`: зміни теки (`changes`) пишуться лише для `"write"` і не
      під `dryRun`; артефакти (`artifacts`) — для `"write"` (не під
      `dryRun`) і для `"artifact"` (завжди, бо перегляду немає);
      `checkArtifacts` тримає їх у `plans/`; інструмент `"artifact"` з
      непорожніми `changes` — дефект інструмента (`Error`).

    Вичерпні `switch` у `permits`, `mcp/tools.ts` і `cli/command.ts`
    змушують вирішити кожне місце. Вплив на спеку: спека designer §3.2 —
    рядок про осі дозволів (`files: read | artifact | write`) і про
    `--dry-run` (лише в інструментів, що змінюють теку); правка в задачі 3,
    diff архітекторові до коміту (він погоджує з власником).

### Рішення під час виконання

Кожне погодив архітектор задачі.

- **В1. Тест `countOf` — у `rehearsal.test.ts`** (задача 2): у переліку
  файлів задачі 2 його не було, задача 3 файл розширює. Вплив на спеку:
  немає.
- **В2. Кожен оператор — окремий запис `durations.steps`** (задача 2):
  `longestStatementMs` — максимум за всіма операторами під
  `statement_timeout` (заміри, CTAS, сторожі, перевірки тіл, обидва
  `SET CONSTRAINTS`), ніколи не сума фази; `phases` — суми. Схема id:
  крок наміру `s<N>`; оператори таблиці даних `compute-table-<n>` і
  `write-table-<n>` (один `UPDATE` на таблицю — один запис);
  `constraints-data` (фаза `"write"`, після запису даних, В17 плану 2b-2) і
  `constraints-deferred` (фаза `"deferred"`); решта — `<phase>-<k>`, k — за
  спробу. У звіт іде остання спроба, без злиття. Вплив на спеку: немає
  (§8 «найдовший оператор звіту» — точне прочитання).
- **В3. `tx.extract` поза максимумом:** успішний шлях `apply` витягу не
  викликає (фаза 18 — лише `rehearse`; `divergedPaths` — шлях відмови після
  розбіжності відбитка, з відкатом); це тримає unit-тест «never extracts on a
  successful apply». Вплив на спеку: немає.
- **В4. Власники копії** (задачі 0–1): вимір задачі 0 — на копії з іншим
  власником двигун фази 18 дає ACL-дії, тож репетиція —
  `apply.rehearsal-proof-failed` з `cause: "owners"` (перша гілка рішення 1).
  На таблиці без явних грантів різниться лише секція `owner`, фаза 6 без
  власників проходить. ACL відносно власника не нормалізується: це послабило
  б звірку ідентичності. `cause: "owners"` і на фазі 6, і на фазі 18 — лише
  коли поза власником різняться тільки ACL (фаза 18: усі дії — `GRANT`,
  `REVOKE` чи `OWNER TO`, розбір структурний); інакше — загальна порада.
  Вплив на спеку: §8 (речення про привілеї, що несуть власника).
- **В5. Postgres нижче 17 — `apply.server-unsupported`** одразу після
  advisory lock і першою в `plan`: платформна спека §1 робить 17 мінімумом,
  тож факти сервера читають колонки 17 без гілок версій. Вплив на спеку:
  немає.
- **В6. Округлення мс — лише в `rehearsalReport`** (задачі 2–3): кожен
  оператор `Math.ceil`, фаза — сума округлених, `proof` — плюс округлений
  витяг; схема — цілі невід'ємні. Тому `RehearsalEvidence` несе сирі виміри
  й не дорівнює `Omit<RehearsalReport, …>`. Схема звіту перевіряє id за
  закритим переліком форм і фаз (`REHEARSAL_PHASES`) і відкидає повтори id
  та фаз. Вплив на спеку: немає.
- **В7. Межа `statement_timeout`** (задача 5): формула обрізається до
  2 147 483 647 мс (межа Postgres), а не відмовляє — таке значення
  фактично знімає межу; обрізання дає попередження
  `apply.rehearsal-timeout-unbounded` з порадою задати тайм-аут явно чи
  репетирувати на повнішій копії. Вплив на спеку: немає.
- **В8. Звіт-тека й межа `proof`** (задача 5): тека на шляху звіту — як
  відсутній звіт (`apply.rehearsal-required`), як і для файлу плану; режим
  `proof` комітить без звіту, ланцюжка й ролі і призначений лише для чистої
  копії (`plan.ts`). Вплив на спеку: немає.

## Відомі обмеження

- **Перше застосування** (`ledgerHead = null`): голова ledger не відрізняє
  копію цілі від іншої бази без стану; решта пунктів доказу діє.
- **Копія під іншою роллю** — `apply.role-mismatch` (борг П3-1).
- **Звіт старшого формату** — `apply.rehearsal-stale`, перерепетирувати.
- **Тривалості — з копії.** Інше навантаження цілі формула не бачить;
  явний `statementTimeoutMs` має перевагу.
- **Таблиця, порожня і на копії, і на цілі**, тайм-аут не масштабує (немає
  відношення); `max(60 с, …)` дає нижню межу.
- **Копія з іншими власниками** (вимір задачі 0, В4) —
  `apply.rehearsal-proof-failed` з `cause: "owners"`; з явними грантами —
  уже `apply.target-changed` на звірці копії (фаза 6), теж з
  `cause: "owners"`. Копію відновлюють роллю плану з `pg_restore
  --no-owner`.

---

### Task 0: Звірка, вимір власників і базова лінія

**Files:** —

- [ ] **Step 1:** `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-14-p3-2b-3-rehearsal-report-commit.md`
  Expected: знайдено `runAttempt`, `executePlan`, `ExecuteOptions`,
  `ExecuteOutcome`, `proveWithEngine`, `computeData`, `writeData`,
  `planFileName`, `writeApplyStateStatements`, `renderApplyState`,
  `findApply`, `applyTool`, `readPlanFile`, `FILES_ACCESS`, `permits`,
  `mcpInputSchema`, а також усе, що додав П3-2b-2 (`DataTable`,
  `DATA_SETTINGS`, `dataMatchesRecord`). Розбіжність — стоп.
- [ ] **Step 2: Виміряти фазу 18 на копії з іншим власником** (рішення 1).
  Скрипт у scratchpad: база-ціль з `app.t`, план без промоції (будь-який
  крок), копія `CREATE DATABASE … TEMPLATE`, у копії `ALTER TABLE app.t
  OWNER TO <роль, членом якої є postgres>`, `engine.plan(витяг копії,
  бажаний каталог, scope)` після кроків. Записати в журнал: чи є дія чи
  помилка через власника. Обидві бази й роль прибрати. Результат визначає
  очікування тесту задачі 1 (`rolledBack` чи `apply.rehearsal-proof-failed`)
  і рядок «Відомих обмежень».
- [ ] **Step 3:** гейти базової лінії, як у задачі 0 плану П3-2b-2.

### Task 1: Факти сервера, голова ledger і відбиток без власників на репетиції

**Files:**
- Create: `packages/simetra/src/schema/apply/server.ts`
- Modify: `packages/simetra/src/schema/apply/artifact.ts` (`server`,
  `ledgerHead`, схеми)
- Modify: `packages/simetra/src/schema/apply/plan.ts` (обидві гілки
  `buildPlan`)
- Modify: `packages/simetra/src/schema/apply/execute.ts` (фази 4e, 6)
- Modify: `packages/simetra/src/schema/apply/state.ts` (`readLedgerHead`)
- Test: `packages/simetra/src/schema/apply/__tests__/execute.test.ts`,
  `artifact.test.ts`;
  `packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts`,
  `apply-state.db.test.ts`

**Interfaces:**
- Produces: `ServerFacts` (рішення 2), `readServerFacts(tx:
  ApplyTransaction): Promise<ServerFacts>` у `server.ts`;
  `readLedgerHead(tx): Promise<string | null>` у `state.ts` (без таблиць
  стану — `to_regclass`, як `findApply` — `null`); поля `server:
  ServerFacts`, `ledgerHead: string | null` в артефакті й `ExecutablePlan`.

- [ ] **Step 1: Падаючі тести:**
  - `execute.test.ts` `"refuses another server"` → `apply.target-changed`
    `sections: "server"` на `apply` і `rehearse`; на `proof` звірки немає;
  - `execute.test.ts` `"refuses another ledger head"` → `sections:
    "ledger"`;
  - `execute.test.ts` `"compares the target fingerprint without owners on a
    rehearsal"`: відбиток, що різниться лише секцією власника, — `rehearse`
    проходить фазу 6, `apply` — `apply.target-changed`;
  - `apply-state.db.test.ts` `"reads the head of the ledger"`: два
    застосування → `apply_id` другого; база без стану → `null`;
  - `execute-plan.db.test.ts` `"refuses a copy with the same chain and
    another head"` (Review Focus 1): дві бази з того самого стану, кожна з
    окремим застосуванням того самого плану; репетиція другої за новим
    планом першої → `sections: "ledger"`;
  - `execute-plan.db.test.ts` `"rehearses a copy restored under other
    owners"` (Review Focus 2): у копії таблиця належить ролі
    `simetra_copy_owner`, членом якої є роль застосування → очікування за
    виміром задачі 0: `rolledBack` або `apply.rehearsal-proof-failed` з
    `cause: "owners"` і підказкою про `--no-owner` (рішення 1); та сама
    різниця на `apply` → `apply.target-changed`;
  - `execute.test.ts` `"names the owners as the cause of a failed proof"`:
    фейковий двигун дає дію при відбитку, що різниться лише власником →
    `cause: "owners"`; та сама дія при рівних власниках — без `cause`, з
    `count` і `first`. (Тест власників вище прибирає роль і бази у
    `finally`, зокрема на шляху падіння; роль — після баз.)
  - `execute-plan.db.test.ts` `"refuses a copy on another server"` (аудит
    Codex, конвеєр): копія — `CREATE DATABASE … TEMPLATE template0
    LC_COLLATE 'C' LC_CTYPE 'C'` з тією самою схемою й станом (факт
    `collate` інший) → репетиція → `apply.target-changed` з `sections:
    "server"` до першого кроку; базу з `LC_COLLATE 'C'` створює сам тест і
    прибирає у `finally`, зокрема на шляху падіння (інакше її зловить
    `stack-guard`).
- [ ] **Step 2: FAIL.** Run: `pnpm --filter simetra test execute artifact`.
- [ ] **Step 3: Реалізувати:** `plan` читає обидва поля тією самою
  транзакцією `READ ONLY`, що стан застосування; фаза 4e — після 4d, без
  повтору; фаза 6 — `owner: o.mode === "apply"`.
- [ ] **Step 4: PASS:** `pnpm --filter simetra test`, typecheck обох
  пакетів, `pnpm test:db`.
- [ ] **Step 5: Коміт**

```bash
git add packages/simetra/src packages/designer/src
git commit -m "feat(schema): доказ копії репетиції — факти сервера, голова ledger, відбиток без власників"
```

### Task 2: Докази репетиції в раннері

**Files:**
- Create: `packages/simetra/src/schema/apply/rehearsal.ts` — лише типи
  `RehearsalReport` (рішення 3), `RehearsalEvidence` і помічник `countOf`;
  схему, розбір і файл додає задача 3 (аудит Codex: тип мусить існувати до
  коміту з `typecheck`)
- Modify: `packages/simetra/src/schema/apply/execute.ts`
- Test: `packages/simetra/src/schema/apply/__tests__/execute.test.ts`,
  `packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts`

**Interfaces:**
- Produces: `RehearsalEvidence` = `Omit<RehearsalReport, "format" |
  "planHash">`; `countOf(value: unknown): number` (рішення 3, «Лічильники —
  числа»); `ExecuteOutcome` статусу `rolledBack` у `rehearse` —
  `{ …, evidence: RehearsalEvidence }`; `timedTransaction(tx, clock):
  ApplyTransaction & { setPhase(phase: string, step?: string): void;
  durations(): RehearsalEvidence["durations"] }` у `execute.ts`;
  `ExecuteBase.clock?: () => number`.

- [ ] **Step 1: Падаючі тести:**
  - `execute.test.ts` `"collects rehearsal evidence"`: фейковий годинник
    +5 мс на виклик → `durations.steps` для `s1` і `d1`,
    `longestStatementMs` — максимум, `data` з `computed`/`written`
    фейкового порту, `rows` із заміру «до», `triggers` секції;
  - `execute.test.ts` `"times the statements of the helpers"`: оператор
    відбитка й валідаторів потрапляє у фази `"fingerprint"` і `"baseline"`;
  - `execute.test.ts` `"leaves the extract out of the longest statement"`;
  - `execute.test.ts` `"keeps the evidence of the last attempt"`: перша
    спроба — `55P03`, друга успішна → докази другої;
  - `execute.test.ts` `"has no evidence outside a rehearsal"`;
  - `execute-plan.db.test.ts` `"reports the rows and the data counters of a
    rehearsal"` на справжній базі з кроком даних: `rows`, `computed`,
    `written` — числа (`typeof === "number"`), не рядки порту;
  - `rehearsal.test.ts` `"reads a count as a safe integer"`: `countOf("12")`
    → `12`; `countOf("-1")`, `countOf("9007199254740993")`, `countOf(null)`
    → `Error`.
- [ ] **Step 2–4:** FAIL → реалізувати (рішення 4) → PASS
  (`pnpm --filter simetra test execute`, typecheck, `pnpm test:db`).
- [ ] **Step 5: Коміт**

```bash
git add packages/simetra/src packages/designer/src
git commit -m "feat(schema): раннер збирає докази репетиції — тривалості, рядки, лічильники, plpgsql_check, тригери, слід"
```

### Task 3: Звіт — схема, файл, вісь `"artifact"`, ledger

**Files:**
- Modify: `packages/simetra/src/schema/apply/rehearsal.ts` (схема, розбір,
  хеш, ім'я файлу)
- Modify: `packages/simetra/src/schema/apply/__tests__/rehearsal.test.ts`
- Modify: `packages/designer/src/io/report.ts` (`renderApply` — шлях звіту),
  `packages/designer/src/cli/render.ts` (`artifacts` і для `apply`),
  `packages/designer/src/mcp/tools.ts` (`artifacts` у результаті `apply`)
- Modify: `packages/simetra/src/schema/apply/state.ts` (колонка
  `rehearsal_hash`, `ApplyRecord.rehearsalHash: string | null`)
- Modify: `packages/simetra/src/schema/apply/index.ts` (експорти)
- Modify: `packages/designer/src/tools/types.ts` (`FILES_ACCESS`),
  `tools/invoke.ts`, `mcp/tools.ts`, `cli/command.ts` (кожен `switch` за
  віссю файлів), `tools/apply-tools.ts` (`files: "artifact"` для `plan` і
  `apply`, звіт — у `outcome.artifacts`), `docs/architecture/designer.md`
  (рядок про `--dry-run`)
- Test: `packages/designer/src/__tests__/cli.test.ts`, `mcp.test.ts`,
  `apply-tools.db.test.ts` (тести `plan` з `dryRun`)
- Modify: `docs/superpowers/specs/2026-10-02-simetra-designer-design.md`
  (§3.2, осі дозволів — рішення 10; diff архітекторові до коміту)
- Test: `rehearsal.test.ts`;
  `packages/designer/src/__tests__/apply-tools.db.test.ts`,
  `packages/designer/src/schema-engine/__tests__/apply-state.db.test.ts`,
  тести осей інструментів (`packages/designer/src/tools/__tests__/` — файл,
  що перебирає `FILES_ACCESS × DATABASE_ACCESS`)

**Interfaces:**
- Produces: `REHEARSAL_FORMAT = 1`; `RehearsalReport` (рішення 3);
  `rehearsalReportSchema`; `rehearsalReport(planHash: string, evidence:
  RehearsalEvidence): RehearsalReport`; `serializeRehearsal(r): string`
  (канонічна форма, як `serializePlan`); `parseRehearsal(text: string):
  { ok: true; report: RehearsalReport } | { ok: false; reason: "format" |
  "invalid"; message: string }`; `rehearsalHash(r): Promise<string>`;
  `rehearsalFileName(fromHash: string | null, toHash: string): string`.

- [ ] **Step 1: Падаючі тести:**
  - `rehearsal.test.ts`: `"round-trips a report through its canonical
    form"`, `"refuses an unknown field"`, `"reports another format as
    format"`, `"names the report after the plan"` (той самий префікс, що
    `planFileName`);
  - осі інструментів (тест-гейт рішення 10): `"dryRun exists only for
    tools that write files"` — перебір каталогу: `dryRun` у MCP-схемі й
    `--dry-run` у CLI є рівно в інструментів з `files: "write"`; `"apply
    has no dryRun"` — MCP-вхід `apply` з `dryRun` невалідний, CLI `apply
    --dry-run` → `UsageError`, `apply` без `confirm` → `unconfirmed`;
    `"apply with dryRun commits nothing"` — виклик `invoke` з `dryRun:
    true` і `confirmed: true` до інструмента не `"write"` відмовляє новою
    відмовою `invoke` `dry-run-unsupported` до `tool.run` (шпигун на `run`
    — нуль викликів): канали не дають такого входу, але `invoke` не
    покладається на них; `"read-only forbids an artifact tool"` (`plan`
    і `apply`); `"an artifact tool may not change the directory"`;
  - переписати тести `plan` з `dryRun` (рішення 10): `plan` без `dryRun`
    пише артефакт; `plan --dry-run` → `UsageError`;
  - `apply-tools.db.test.ts` `"writes the rehearsal report next to the
    plan"`: `apply --rehearse` → файл `plans/<from12>-<to12>.rehearsal.json`
    з `planHash` плану; текстовий вивід CLI каже «rehearsal report written
    to <шлях>» замість «nothing was written», JSON CLI і результат MCP
    містять шлях в `artifacts`; невдала репетиція файлу не пише;
  - `apply-state.db.test.ts` `"adds the rehearsal column to an older ledger
    in an applied plan"` (борг 2b-1, режим `apply`, рішення 7): `ALTER TABLE
    simetra.ledger DROP COLUMN rehearsal_hash`, `plan` без промоції →
    `apply` з `COMMIT` → колонка є, рядок має `NULL`.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Реалізувати** (рішення 3, 7, 10). Правку спеки designer
  §3.2 — архітекторові до коміту.
- [ ] **Step 4: PASS:** `pnpm --filter simetra test`, `pnpm --filter
  @simetra/designer test`, typecheck, `pnpm test:db`,
  `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 5: Коміт**

```bash
git add packages/simetra/src packages/designer/src docs/superpowers/specs/2026-10-02-simetra-designer-design.md
git commit -m "feat(designer): звіт репетиції в plans/ — строга схема, канонічний JSON, вісь файлів artifact, колонка ledger"
```

### Task 4: Звіт обов'язковий для промоції, рядки, тайм-аут і зняття `promotion-checks-pending`

Одна задача й один коміт (рішення 8): поки стоїть
`apply.promotion-checks-pending`, жоден тест `apply` промоції не дійде до
фази 6c; а зняття відмови без гейта звіту відкрило б `COMMIT` без звіту.

**Files:**
- Modify: `packages/simetra/src/schema/apply/execute.ts` (до транзакції;
  фаза 6c; `ExecuteOptions` — варіант `{ mode: "apply"; report?:
  RehearsalReport }` окремо від `{ mode: "proof" }`; ledger отримує
  `rehearsalHash`)
- Modify: `packages/simetra/src/schema/apply/rehearsal.ts`
  (`rehearsalRefusals`, `statementTimeoutFromReport`)
- Modify: `packages/simetra/src/schema/apply/plan.ts` (без
  `plan.promotion-commit-pending`)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts`
- Modify: `packages/designer/src/tools/apply-tools.ts` (читання звіту,
  опис), `packages/designer/skills/simetra-metadata/SKILL.md`,
  `docs/architecture/designer.md`
- Test: `rehearsal.test.ts`, `execute.test.ts`, `execute-plan.db.test.ts`,
  `apply-tools.db.test.ts`, `packages/designer/src/__tests__/apply-outcome.test.ts`,
  `packages/designer/src/__tests__/promotion-lifecycle.db.test.ts`,
  `packages/designer/src/schema-engine/__tests__/build-plan.db.test.ts`,
  тест бюджету описів інструментів (`tools/list`)

**Interfaces:**
- Produces: `rehearsalRefusals(plan: Pick<ExecutablePlan, "server" |
  "ledgerHead" | "promotion">, planHash: string, report: RehearsalReport |
  undefined): EngineDiagnostic[]` (лише для плану з промоцією; рішення 5 —
  план, сервер, голова ledger і склад `rows` проти `promotion.record.tables`);
  `statementTimeoutFromReport(report: RehearsalReport, targetRows: { schema:
  string; table: string; rows: number }[]): number`. Нові коди:
  `apply.rehearsal-required`, `apply.rehearsal-stale` (`reason: "plan" |
  "format" | "server" | "ledger" | "tables"`), `apply.rehearsal-copy-empty` (`table`),
  `apply.rehearsal-fewer-rows` (`table`, `copy`, `target`; попередження).
  Видалені коди: `apply.promotion-checks-pending`,
  `plan.promotion-commit-pending`.

- [ ] **Step 1: Падаючі тести:**
  - `rehearsal.test.ts` `"scales by the worst table, not the sum"` (Review
    Focus 5): копія `{a: 10, b: 1000}`, ціль `{a: 1000, b: 1000}`;
    `longestStatementMs: 100` → `max(60000, 3 × 100 × 100) = 60000`;
    `longestStatementMs: 1000` → `300000`; `"has a floor of a minute"`;
  - `execute.test.ts` `"refuses a promotion without a report"`, `"refuses a
    report of another plan"` (Review Focus 3) — `attempts: 0`, одна
    діагностика; `"does not need a report without a promotion"`;
    `"refuses a report of another server"`, `"… of another ledger head"`,
    `"… without a row count for every unit table"` (`rows: []`, зайва
    таблиця, повтор таблиці) → `apply.rehearsal-stale` з `reason`
    `server` / `ledger` / `tables`, `attempts: 0`;
  - `execute.test.ts` `"refuses a table empty on the copy"` (Review Focus
    4), `"warns about fewer rows on the copy"`, `"keeps an explicit
    statement timeout"`, `"sets the statement timeout after the measures"`
    (параметр `set_config('statement_timeout', …)` фази 6c іде після
    заміру 6a й дорівнює формулі);
  - `execute.test.ts` `"is a broken pipeline for a promotion without
    plpgsql_check"` → `Error` до `BEGIN`;
  - `execute-plan.db.test.ts` `"sets the statement timeout from the report"`:
    вручну зібраний `ExecutablePlan` (як тест «leaves the transaction
    settings as they were» плану 2b-1, з тригером на `simetra.ledger`, що
    пише `current_setting('statement_timeout')`, і бажаним відбитком із
    тригером) → значення за формулою;
  - `apply-tools.db.test.ts` (на рівні конвеєра): `apply` промоції без
    файлу звіту → `apply.rehearsal-required`; звіт іншого плану →
    `apply.rehearsal-stale` (`plan`); звіт іншого формату → `stale`
    (`format`); звіт з `rows: []` (файл переписано, `planHash` той самий)
    → `stale` (`tables`) до будь-якої транзакції (аудит Codex, блокер);
    зіпсований файл → `UsageError`; копія з меншою кількістю рядків →
    попередження `apply.rehearsal-fewer-rows` і `committed`;
  - переписати тести, що чекали відмову: `"refuses to commit the promotion
    in this plan"` (`promotion-lifecycle.db.test.ts`) → `"commits the
    promotion with a valid rehearsal report"`; тести
    `plan.promotion-commit-pending` (`build-plan.db.test.ts`,
    `apply-outcome.test.ts`) → «попередження немає».
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Реалізувати** (рішення 5, 6, 8, 9). Скіл: «A promotion is
  applied only with a valid rehearsal report: rehearse the plan on a copy of
  the target with data first; `apply` refuses without it
  (`apply.rehearsal-required`) and when the plan changed since
  (`apply.rehearsal-stale`)». Опис `apply` — те саме стисло, у межі бюджету
  `tools/list` (тест бюджету зелений).
- [ ] **Step 4: PASS:** `grep -rn "promotion-checks-pending\|promotion-commit-pending" packages docs/architecture`
  — порожньо; `pnpm --filter simetra test`, `pnpm --filter @simetra/designer
  test`, typecheck, `pnpm test:db`, `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 5: Коміт**

```bash
git add packages docs
git commit -m "feat(schema): промоція застосовується з COMMIT лише з чинним звітом репетиції; рядки цілі й тайм-аут у транзакції; відмову 2a знято"
```

### Task 5: Наскрізний тест повного циклу

**Files:**
- Create: `packages/designer/src/__tests__/promotion-commit.db.test.ts`

- [ ] **Step 1: Тест** `"promotes, rehearses on a copy with data, commits and
  plans nothing"` — синтетичний проєкт без імен споживача:
  1. ціль (`inTarget`): адаптована таблиця `app.members` (`id uuid PK`,
     `name text NOT NULL`, `inactive boolean NULL`), 500 рядків, третина
     `inactive = true`, частина `NULL`; без грантів ролям API (діє статичний
     гейт доступу 2a; політик до П3-3 немає);
  2. `promote` у `Catalog` з `inactive → retire` і `fill` `deletionMark ←
     coalesce(inactive, false)` (конверсія до перейменувань);
  3. `plan` → `planned`, секція `data` з одним кроком, попередження
     `plan.promotion-commit-pending` немає;
  4. копія з даними: закрити всі пули до цілі, `CREATE DATABASE … TEMPLATE
     <ціль>` з ім'ям за конвенцією тестових баз (щоб `stack-guard` назвав
     сироту), `DROP DATABASE … WITH (FORCE)` у `finally`; `apply --rehearse`
     на копії → `rolledBack`, звіт записано, `rows` = 500;
  5. `apply` на цілі з `COMMIT` → `committed`; `deletion_mark` має рівно
     стільки `true`, скільки було `inactive = true`, жодного `NULL`; ledger
     має `rehearsal_hash` = `rehearsalHash(звіт)`;
  6. повторний `plan` → `unchanged`.
- [ ] **Step 2: Негативні гілки в тому самому файлі:** `apply` без звіту →
  `apply.rehearsal-required`; копія, у якій таблицю очищено, → звіт з
  `rows: 0` → `apply` → `apply.rehearsal-copy-empty`, ціль не змінено.
- [ ] **Step 3: PASS і коміт** (`pnpm test:db`)

```bash
git add packages/designer/src/__tests__/promotion-commit.db.test.ts
git commit -m "test(designer): повний цикл промоції з кроком даних — репетиція на копії з даними, COMMIT, порожній повторний план"
```

### Task 6: Фінальні гейти

- [ ] Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
  `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`,
  `pnpm test:db`. Expected: усе зелене; стек після прогону = до нього.
- [ ] Фінальний звіт архітекторові: діапазон комітів, рішення під час
  виконання з «впливом на спеку», борг.
