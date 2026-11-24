# План: F3 — каталог інструментів агента (#389)

## 1. Заголовок

- **Статус:** на приймання; приймає архітекторка `tooling-architect`. Виконує
  авторка плану після приймання (`agent-kit:execute`) у гілці-продовженні.
- **Опори:** `main` після злиття PR #385 (обов'язкове поле `present`
  інструментів із даними, попередження `warningsFor` у `data-read`/`data-command`). Задачу 0 виконано в PR плану. Розвилки 1–5 вирішила архітекторка 2026-11-24
  (рядки Р-F3-3, Р-F3-5, Р-F3-7, Р-F3-13). Перед стартом задачі 1 звірити з
  `m4-sk-architect`, чи ADR-0102 уже змінює `model/runtime/catalog.ts` у
  гілці: конфлікт мерджу допустимий, семантичні зміни їхніх полів — ні.
- **Спільні ресурси й заборони:** стек `postgres` спільний з М4 — DB-прогони
  чекають замка, чужих об'єктів стека не чіпати. Не змінювати
  `packages/simetra/src/data/**`, `src/server/signals/**`, `src/server/runtime.ts`,
  `packages/designer/src/__tests__/signal-receiver.*`,
  `packages/designer/skills/simetra-metadata/**`, `.github/**`, `AGENTS.md`,
  `CLAUDE.md`. Без MCP SDK у T3.
- **Лише CI:** повні рівні `unit`, `db`, `db-supabase`, `e2e` і `packaging`
  (`ci: true` у `.agents/kit.profile.json`). Локально — лише
  `run-tests <рівень> --filter <файл>` чи `run-tests unit --changed`; повного
  локального прогону жодна задача не робить.

## 2. Мета / Архітектура / Спека

**Мета.** T3 дає каталог інструментів агента `describe`, `read`, `write`,
`remove` над `CommandRuntime` з позначками MCP, формою результату (зі
зарезервованим станом «чекає підтвердження»), закритим переліком помилок,
межею розміру й поданням для `structuredContent` і `content`. `data-read` і
`data-command` designer кличуть ядро каталогу; їхні DB-тести зелені без зміни
очікувань.

**Архітектура.** Нова тека `agent/` у `packages/simetra/src/server` (зона чистоти T3:
лише `./…`, `simetra/model`, `zod`, `node:async_hooks`). Два шари: **ядро**
(`describe`, `read`, `execute` — дані без меж подання) і **шар інструментів**
(дескриптори, розбір входу, звуження дієслів, межа розміру, результат і
подання MCP як прості об'єкти). Запобіжник запису прав — чиста функція над
`RuntimeCatalog`, щоб адаптер викликав її до відкриття пулу. F4 бере шар
інструментів; designer — ядро й запобіжник.

**Спека.** П4-F §3 (рядок F3), §4 (`AgentToolCatalog`, позначки), §5.3, §6;
ADR-0104, ADR-0109 (замінює ADR-0107), ADR-0110; П4 §6.3 (каталог рантайму), §6.14 (MCP над даними, Рт14);
спека designer §3.2 (бюджет `tools/list`). Глосарій: «Каталог інструментів
агента».

## 3. Глобальні обмеження

- Наявні тести зелені; `data-tools.db.test.ts`, `data-tools.postgres.db.test.ts`,
  `data-tools.supabase.db.test.ts`, `tenant-creation.db.test.ts` — без змін
  (`git diff <база>.. -- <ці файли>` порожній).
- Схеми входу каталогу — похідні від схем T0 (`batchSchema`, `readQuerySchema`,
  `metadataRefSchema`), не переоголошені (AGENTS.md § «Metamodel rules»).
- Гілка за видом — лише з фактів каталогу рантайму чи реєстру видів, ніколи за
  іменем виду.
- Тексти для агента (описи, `hint`, повідомлення) — англійською; коментарі —
  українською, «чому».
- Нового шляху в базу немає: каталог кличе лише методи `CommandRuntime`
  (платформна спека Р21).

## 4. Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р-F3-1 | Каталог — `server/agent/`, експорт із `simetra/server`: фабрика `createAgentToolCatalog({ runtime, permissions?, maxResultChars? })`, запобіжник `agentWriteRefusal`, подання `agentResultToMcp`, типи §5. Адаптер передає дозволи при створенні каталогу, а не на виклик. Ядро `execute` саме застосовує запобіжник Р-F3-4 з дозволами фабрики: шляху запису повз запобіжник на об'єкті каталогу немає; designer додатково кличе запобіжник до відкриття пулу. | none |
| Р-F3-2 | Дієслова — вичерпне відображення `Record<ObjectOperation, "write" \| "remove">` над `OBJECT_OPERATIONS`: `create`, `update` → `write`; `markDeletion`, `delete` → `remove`. Нова операція рантайму не компілюється без рядка. Дієслово доступне об'єкту, коли його операція є в `catalog.objects[].operations`. | none |
| Р-F3-3 | Ядро пакета `execute(session, batch)` — під `write` і `remove` і під `data-command`: змішаний пакет кількох об'єктів лишається можливим для designer. `write`/`remove` звужують той самий пакет до одного об'єкта й своїх дій. Рішення архітекторки (розвилка 3). | §5.3: рядок про ядро пакета; П4 §6.14: `data-command` кличе ядро каталогу |
| Р-F3-4 | Запобіжник запису прав — чиста функція над `RuntimeCatalog` і пакетом: відмова, коли будь-яка операція пакета — над об'єктом, чиї операції мають контекст `administerRights` (системні довідники прав), або `create` кореня з `operations.create.root.membership` (корінь із творцем). Без дозволу `permissions.rightsWrite` — відмова до бази. Контекст `administerRights` ставить T1 саме ролям `rightsRoles`/`roleAssignments` (`actions: "rights"` у реєстрі видів), тож окрема ознака в каталозі не потрібна. | §3 (рядок F3), §5.3, §6: «створення кореня скоупу» → «створення кореня скоупу з творцем (`rootCreator`)», як П4 §6.14 |
| Р-F3-5 | `describe` перелічує всі об'єкти каталогу рантайму з їхніми інструментами й операціями, без передбачення прав. Причина: повний клієнтський каталог уже їде в браузер кожному користувачу, тож фільтр за правами не дає конфіденційності, а третє дзеркало предиката читання суперечило б ADR-0102. Межу прав тримають RLS і ядро на `read`/`write`/`remove`: відмова — код каталогу з `outcome`. Рішення архітекторки (розвилка 1). | §3 (рядок F3: прибрати «лише об'єкти, які користувач може читати»), §5.3 (рядок `describe`) |
| Р-F3-6 | Невідомий названий об'єкт — `catalog.unknown-object` з `outcome: fix_input`. Опис об'єкта — поля (ім'я, тип, обов'язковість, масив, `maxLength`, значення перерахування, ціль `Ref` як `MetadataRef`), табличні частини, дієслова й операції об'єкта з каталогу. Прав `describe` не судить: їх судить виклик (`command.forbidden`, `outcome: ask_user`). Вивід `describe` — явний перелік полів: поля клієнтського каталогу, мітки Р-F3-7 і дієслова; ніколи не відфільтрована копія `RuntimeObject` (функції ядра, контексти, `constraints`, `membership` не виходять). Мітки всіх об'єктів бачить кожен користувач: метадані (імена, мітки, описи) не захищаються правами, секретів в описах метаданих не кладуть (рішення архітекторки). | §5.3: «доступні» = операції об'єкта; §6: правило «метадані не захищаються правами» |
| Р-F3-7 | Людські мітки: частина рантайму каталогу (`runtimeObjectSchema`, реквізит і ТЧ рантайму, не спільний `catalogEntrySchema`) отримує необов'язкові `title`, `description` (`localizedStringSchema`) з метаданих; обидві мови як є. `snapshotHash` = `model.hash`, тож база не потребує повторного застосування. Екрани, коли їм знадобляться мітки, беруть їх із тієї самої проєкції компілятора, а не з другого джерела. Рішення архітекторки (розвилка 2). | П4 §6.3: вміст каталогу рантайму й правило одного джерела міток |
| Р-F3-8 | Результат інструмента: `{ state, data?, truncated?, continuation? }` або помилка. `state` — `"done" \| "awaiting_confirmation"`; друге значення зарезервоване (ADR-0104) і в першому випуску не повертається. | §5.3: ім'я поля й значень |
| Р-F3-9 | Помилка: `{ code, message, hint, outcome, error? }`. `code` — закритий перелік каталогу: коди `CommandError` T0 плюс власні `catalog.invalid-input`, `catalog.unknown-tool`, `catalog.unknown-object`, `catalog.rights-write-refused`, `catalog.result-too-large`. `outcome` — повне відображення `Record<код, "retry" \| "ask_user" \| "fix_input">`. Помилка рантайму несе вихідний `CommandError` без втрат у `error`. | none |
| Р-F3-10 | Подання MCP — проста функція T3 без SDK: успіх — `structuredContent` = об'єкт результату, `content` = його повний JSON-текст; помилка — `isError: true`, лише `content` з текстом, що несе `code`, `message`, `hint`, `outcome` (клієнти Anthropic показують за помилки лише `content`). | none |
| Р-F3-11 | Межа розміру — `maxResultChars` (типово 44 000, як у munin-mcp: 20 000 токенів × 2,2) на довжину тексту `content`. Сторінка `read` урізається з кінця до межі: `truncated: true`, `continuation: { offset }` наступного рядка; перелік `describe` — `truncated: true` і підказка назвати об'єкт. Картка `read`, що не вміщується, — `catalog.result-too-large` з `outcome: fix_input`. Після того як `run` завершився успіхом, результат `write`/`remove` ніколи не помилка: понад межу рядки змін урізаються до ключа й версії, далі — з кінця, з `truncated: true` і `state: "done"`; інакше агент повторив би закомічений пакет (новий корінь, дублікати). Урізаний результат узгоджений (`included` лише для лишених рядків). | none |
| Р-F3-12 | `bigint` → десятковий рядок в одному місці — ядро каталогу; `toJson` designer замінюється функцією каталогу. | none |
| Р-F3-13 | Designer: `data-read` кличе ядро `read`, `data-command` — запобіжник Р-F3-4 до `withData` і ядро `execute`; відмова модуля лишається в designer і йде першою на весь пакет (спека §5.3, Рт14). Подання designer (`present`, `summarizeData`) не змінюється; самодостатнє подання каталогу вживає F4. Рішення архітекторки (розвилка 4). Наслідок: пакет «довідник прав, потім об'єкт із модулем» без `--allow-rights-write` дає відмову модуля замість відмови прав; тестами не зафіксовано. | §5.3: адаптер designer зберігає своє подання; П4 §6.14: запобіжник прав — із T3 |
| Р-F3-14 | Бюджет описів каталогу — тест T3 за зразком `TOOLS_LIST_BUDGET`: розмір JSON переліку `{ name, title, description, inputSchema: z.toJSONSchema(input), annotations }` ≤ `AGENT_TOOLS_BUDGET`; правило зміни бюджету — у коментарі тесту, як у designer. | none |

## 5. Інтерфейси

Дає F3 (споживачі — F4, designer):

- `AgentToolCatalog`: `tools: readonly AgentTool[]`; `call(session, name, input): Promise<AgentToolResult>` — шар інструментів; ядро `describe(object?)`, `read(session, query)`, `execute(session, batch)` — дані в JSON-формі; помилка — `CommandFailure` або відмова запобіжника `AgentWriteRefused` (несе `MetadataRef` об'єкта).
- `AgentTool`: `name` (`^[a-z][a-z0-9_]{0,47}$`), `title`, `description` (≤ 4096 символів), `input` (схема Zod), `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false` — усі явно, значення таблиці §5.3).
- `AgentToolResult`: успіх Р-F3-8 або помилка Р-F3-9.
- `agentWriteRefusal(catalog: RuntimeCatalog, batch, { rightsWrite: boolean }): { object: MetadataRef } | undefined` — Р-F3-4.
- `agentResultToMcp(result): { structuredContent?, content: [{ type: "text", text }], isError? }` — Р-F3-10.
- Входи: `describe` — `{ object?: MetadataRef }`; `read` — `{ query: readQuerySchema }`; `write`/`remove` — `{ operations: batchSchema }` з уточненням: один об'єкт і лише дії свого дієслова (`catalog.invalid-input` з `path`).

Бере F3: `CommandRuntime` (`run`, `read`, `catalog`) і схеми T0 — без змін їхнього контракту; T1 — проєкція міток (Р-F3-7).

## 6. Інваріанти безпеки

| # | Інваріант | Тест, що червоніє на ваді (мутація словами) |
| --- | --- | --- |
| І-F3-1 | Запис у системний довідник прав без дозволу відмовляє до бази | без `rightsWrite`: `write` у довідник ролей і в призначення, `remove` з `markDeletion` на ролях і з `delete` на призначеннях, ядро `execute` з тими самими операціями — `catalog.rights-write-refused` / `AgentWriteRefused`, фейкова база без жодного оператора. Мутації: прибрати перевірку контексту `administerRights`; застосовувати запобіжник лише під `write`; не застосовувати його в `execute` |
| І-F3-2 | Запобіжник бачить кожну операцію пакета | пакет «звичайний об'єкт, потім довідник прав». Мутація: перевіряти лише першу операцію |
| І-F3-3 | `create` кореня з творцем без дозволу відмовляє; корінь без творця — ні | обидва випадки. Мутація: ігнорувати `root.membership` |
| І-F3-4 | Ознака «довідник прав» каталогу рантайму рівна `rightsSystem` реєстру видів | тест T1 на моделях фікстур: для кожного об'єкта `rightsSystem(data) !== undefined` ⇔ усі контексти операцій — `administerRights`. Мутація: дати довіднику прав стандартну дію `update` |
| І-F3-5 | `read` і `describe` не пишуть, `write` не видаляє, `remove` не створює | фейковий рантайм рахує виклики `run`; `write` з `delete` і `remove` з `create` — `catalog.invalid-input` без виклику `run`. Мутація: дозволити будь-яку дію в `write` |
| І-F3-6 | Designer відмовляє запису прав до відкриття пулу | наявний unit `open: 0` у `data-tools.test.ts` зелений. Мутація: викликати запобіжник усередині `withData` |

## 7. Частини

none — один блок, приймається цілим.

## 8. Задачі

| # | Задача | Файли / модулі | Готово, коли | Після | Доказ |
| --- | --- | --- | --- | --- | --- |
| 1 | Мітки в каталозі рантайму (Р-F3-7) | `model/runtime/catalog.ts`, `compiler/runtime-catalog.ts`, `packages/create-simetra-app/template/generated/runtime-catalog.json` | об'єкт, реквізит, ТЧ рантайму несуть `title`/`description`, коли метадані їх мають; клієнтський каталог не змінився; згенерований артефакт шаблону оновлено `compile --out`; `pnpm metadata:check` зелений | 0 | `run-tests unit --filter packages/simetra/src/compiler/__tests__/runtime-catalog.test.ts` |
| 2 | Ядро каталогу: `describe`, `read`, `execute`, запобіжник, JSON-значення | `server/agent/`, `server/index.ts` | І-F3-1…3 зелені на фейковому рантаймі (`server/__tests__/harness.ts`, `fake-database.ts`); І-F3-4 — у тестах T1; `describe` дає всі об'єкти каталогу; невідомий об'єкт — `catalog.unknown-object` | 1 | `run-tests unit --filter packages/simetra/src/server/__tests__/<тест ядра>` |
| 3 | Шар інструментів: дескриптори, розбір входу, звуження дієслів, результат, помилки, межа розміру, подання MCP, бюджет | `server/agent/` | рядок F3 §3: позначки — значення §5.3 і всі явно; кожне поле `structuredContent` є в тексті `content`; помилка — текст із `code`, `hint`, `outcome`; понад межу — `truncated`; імена й довжини описів; `awaiting_confirmation` у типі й ніколи не повертається; І-F3-5 зелений; тест бюджету Р-F3-14 | 2 | `run-tests unit --filter packages/simetra/src/server/__tests__/<тест інструментів>` |
| 4 | Designer — адаптер (Р-F3-12, Р-F3-13) | `packages/designer/src/tools/data-tools.ts`, `data-policy.ts` | `data-policy.ts` лишає тільки відмову модуля; запис прав — `agentWriteRefusal`; `toJson` — з каталогу; DB-тести й `data-tools.test.ts` без зміни очікувань (`git diff` порожній); І-F3-6 зелений; `TOOLS_LIST_BUDGET` не росте | 3 | `run-tests unit --filter packages/designer/src/__tests__/data-tools.test.ts`; `run-tests db --filter packages/designer/src/__tests__/data-tools.db.test.ts`; `run-tests db --filter packages/designer/src/__tests__/tenant-creation.db.test.ts` |

## 9. Задача 0

Виконано в PR плану: `orient --plan` і `doc anchors` плану зелені; правки — П4-F
§3 (рядок F3), §5.3, §6; ADR-0109 замінює ADR-0107 (`describe` без фільтра
прав), ADR-0110 (метадані не захищаються правами), глосарій «Каталог
інструментів агента» → ADR-0109; П4 §6.3 (мітки й одне джерело міток), §6.14
(адаптер каталогу). Виконавиця перед стартом повторює `orient --plan` на
поточному `main`.

## 10. Задачі власника

none.

## 11. Підсумок аудиту

Класифікатор ризику: питання 1 — так (запобіжник запису прав, дозвіл
адаптера), 4 — так за правилом «не певна — так», 2, 3, 5, 6 — ні. Раунд 1:
Sonnet «план проти спеки й коду» і Opus «безпека й старе покоління», паралельно.
Sonnet: одна minor (звуження кореня з творцем лише в §5.3) — виправлено в
задачі 0. Opus: одна major — закомічений `write` понад межу розміру повертався б
помилкою, і агент повторив би пакет; виправлено в Р-F3-11. Чотири minor
виправлено, бо кожна — рядок плану: вивід `describe` — явний перелік полів
(Р-F3-6), ядро `execute` саме застосовує запобіжник (Р-F3-1), випадки `remove` і
`execute` в І-F3-1, П4-F §6 і ADR-0107 у задачі 0. Спростованих немає. Blocker і
security major немає, тож раунду 2 і Codex немає. Мітки всіх об'єктів у
`describe` архітекторка прийняла правилом (Р-F3-6, П4-F §6). Поза планом:
запис у довідник прав фазою `ctx.run` хука — логіка застосування під RLS і
`has_right`, спека її не відносить до входу агента.
