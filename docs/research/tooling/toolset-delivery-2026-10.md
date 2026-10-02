# Доставка інструментів розробника споживачам (2026-10)

## Про цей документ

- **Питання дослідження:** як постачати інструменти розробника
  споживачам платформи — ядро й режими виклику (CLI, MCP, студія), назви
  пакетів і скілів, доставка скілів у проєкт споживача, онбординг і
  реєстрація MCP у клієнтах.
- **Дата:** 2026-10-02. Версії, ліцензії й лічильники нижче перевірено на цю
  дату; далі вони старіють.
- **Метод і джерела:** огляд першоджерел (документація, README, `npm view` /
  `npm pack` пакетів, `gh api` репозиторіїв), розбір двох відкритих проєктів
  (unica, simplyCMS), звірка зі станом канону Simetra. Твердження з
  агрегаторів і пошукової видачі позначено `[вторинне]`. Код сторонніх
  проєктів не копіювався.
- **Куди лягли рішення:**
  [`docs/superpowers/specs/2026-10-02-simetra-designer-design.md`](../../superpowers/specs/2026-10-02-simetra-designer-design.md)
  (спека пишеться паралельно з цим документом). Якщо спека суперечить цьому
  тексту, чинна спека.
- **Статус:** дослідження, не рішення. Розділ 10 — кандидати для власника.

## 1. Питання і контекст

Прототип постачав `@simetra/cli` із командами `compile`, `explain`, `fix`,
`mcp` (stdio MCP над тими самими API) і скіл `simetra-cli`. Скіл за змістом
призначений споживачу (як перевіряти й редагувати `metadata/`), але лежить
серед repo-скілів розробки платформи, а `AGENTS.md` перелічує його як скіл
розробки. Канон водночас обіцяє, що скіли для споживачів їдуть у пакеті
(`skills/`), проте каталогу `skills/` у жодному пакеті немає, а механіка
доставки ніде не описана (розділ 9).

Питання розпадаються на п'ять: (1) де живе ядро операцій і чим є CLI, MCP і
студія стосовно нього; (2) як називати пакети й скіли; (3) як скіл потрапляє
в проєкт споживача й залишається тієї ж версії, що й код; (4) як споживач
реєструє MCP у своєму клієнті; (5) чи потрібна явна команда онбордингу.

## 2. Три шари в екосистемі

Ринок сходиться до трьох шарів:

1. **Ядро** — операції продукту як бібліотека або CLI пакета-продукту.
2. **Тонкі адаптери** — CLI, MCP, IDE-розширення без власної логіки й власних
   схем, над тим самим ядром.
3. **Скіли** — знання «як робити задачу» (коли викликати інструмент, чекліст,
   де читати версійні доки). Факти про модель у скілі не переказуються.

Докази (перевірено 2026-10-02):

| Продукт | Ядро й поверхні | Урок |
| --- | --- | --- |
| Nx | CLI `nx`; MCP — підкоманда `nx mcp` (Nx 21.4+, раніше окремий `nx-mcp`) | MCP свідомо урізано до read-only і remote-сервісів; усе, що робиться CLI-викликом, винесено в скіли (`--minimal` за замовчуванням). Спершу всі операції були MCP-інструментами — «this approach created bloat» ([nx.dev/blog/nx-ai-agent-skills](https://nx.dev/blog/nx-ai-agent-skills)) |
| Angular CLI | `ng`, `ng mcp` (підкоманда) | Прапори `--read-only`, `--local-only`; частина інструментів experimental ([angular.dev/ai/mcp](https://angular.dev/ai/mcp)) |
| Prisma | CLI `prisma`; поточні доки описують лише remote MCP | Деструктивні CLI-команди (`migrate reset --force`) блокуються для AI-агентів без явної згоди ([prisma.io/docs](https://www.prisma.io/docs)) |
| Supabase | CLI `supabase`; MCP — окремий пакет і hosted-сервіс; agent-skills; Claude-плагін | Скоуп і режим у конфігурації: `read_only`, `project_ref`, `features` ([supabase.com/docs/guides/getting-started/mcp](https://supabase.com/docs/guides/getting-started/mcp)) |
| Playwright | `playwright` + `playwright-cli`; `@playwright/mcp` 0.0.83 | README: агенти дедалі частіше віддають перевагу CLI-флоу у вигляді SKILL над MCP, бо CLI економніший за токенами ([github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)). Opt-in категорії `--caps` |
| Next.js | Вбудований endpoint `/_next/mcp` у dev-сервері; міст `next-devtools-mcp` 0.4.0 | Окремий пакет-міст «decouples the agent interface from the internal implementation» ([nextjs.org/docs/app/guides/mcp](https://nextjs.org/docs/app/guides/mcp)) |
| Storybook | CLI `storybook`; `@storybook/addon-mcp` 10.6.1 | MCP живе в dev-сервері як addon; toolsets Development / Docs / Testing ([github.com/storybookjs/mcp](https://github.com/storybookjs/mcp)) |

Висновки:

- **Підкоманда головного CLI**, коли ядро вже є CLI-пакетом, а MCP потребує
  тих самих залежностей (Nx, Angular): один пакет, одна версія, нуль
  розбіжності схем. Ціна — весь CLI тягнеться в MCP-процес.
- **Окремий пакет** лише коли MCP має інший життєвий цикл або споживає живий
  процес (Next, Storybook, Playwright, hosted-сервіси).
- Публічно задокументованого «спільного Zod-пакета схем» у розглянутих
  продуктів немає: практика — один шар операцій і тонкі адаптери.
- Аналогія з 1С: пакетний режим Конфігуратора
  (`1cv8 DESIGNER /DumpConfigToFiles`, `/CheckConfig`, `/UpdateDBCfg`) і EDT —
  режими одного ядра, а не окремі продукти. Джерела `[вторинне]`:
  <https://infostart.ru/public/1909958/>, <https://habr.com/ru/articles/968144>.
  Ризик аналогії: в 1С немає агента як клієнта.

## 3. unica v0.13 (IngvarConsulting/unica)

Джерело: <https://github.com/IngvarConsulting/unica>, перевірено 2026-10-02.
Плагін Codex / Claude Code / ZCode для розробки на 1С:Предприятии. **Ліцензія
LGPL-3.0-or-later: беремо лише патерни, код не копіюємо.** v0.13 ще не вийшов:
є `v0.13.0-rc.1` (2026-09-22), `rc.2` (09-25), `rc.3` (09-28); остання стабільна
— v0.12.3.

**Ядро й поверхні.** Rust-workspace з двох крейтів: `crates/unica-coder`
(ядро й MCP runtime) і `crates/unica-bootstrap` (перевірювана доставка, кеш,
запуск). Публічна поверхня **одна** — stdio MCP `unica` (правило
`INV.WIRE.ONE-SERVER`); публічного CLI, LSP чи HTTP немає. Шари
`domain` → `application` → `infrastructure` → `interfaces` з CI-скриптом, що
забороняє зворотні залежності (аналог наших tier-zones).

**Каталог інструментів як SSOT.** Реєстр
`crates/unica-coder/src/application/v13/tool_catalog.rs` (ім'я, опис, схема
входу як дані). З нього генеруються wire-схема й довідник `docs/tool-surface.md`
(скрипт `scripts/ci/generate-tool-surface.py` читає `tools/list` зібраного
бінарника); дрейф довідника — падіння CI. Близько до нашого «Zod = SSOT».

**Консолідація 74 → 8.** У v0.12 було 74 інструменти (`unica.meta.*`,
`cfe.*`, `runtime.*` …), у v0.13 — 8 за питанням, а не за функцією:
`view, apply, resolve, search, check, diff, run, docs` (+3 сумісних
`task.*` для хостів без native MCP Tasks; профіль — рівно 8 або 11).
Адресація — логічна `<sourceSet>:<Kind>.<Name>`; словник операцій вузла
повертає `unica.view` у секції `can`, а не схема входу. Типізовані `data`-відповіді:
у 0.12 48 з 74, у 0.13 11 з 11. Закритий набір кодів відмов, dry-run як
чесний preview із `ifRev`, пагінація курсорами.

**Бюджети токенів як гейти.** Baseline `tools/list` ≈264 643 токенів
(o200k_base) → 55 122 після зняття описів → ціль 2000–3000 (issue #479).
Метрика — токени на розв'язання задачі плюс first-call invocation success,
обидві обов'язкові. CI-інваріанти: опис ≤2 KiB, `tools/list` ≤16 KiB.
Головним баластом були deep-union схеми писачів (`meta.edit` — 6319 токенів).

**Скіли в плагіні.** `plugins/unica/skills/<name>/SKILL.md` (76 у v0.12.3,
близько 50 у v0.13 після видалення дублів) їдуть у складі плагіна. Кожен скіл —
тонкий маршрутизатор: frontmatter (`name`, `description` «Используй когда…»,
`argument-hint`, `allowed-tools`) і секція **«MCP routing»** («Preferred path:
use MCP `unica` tool `unica.view` …»). Довідники — окремо в `references/`.
**Лінтер прикладів:** `tests/ci/test_unica_skills.py` забороняє згадувати зняті
інструменти, перевіряє JSON-приклади, а Rust-тест
`every_skill_example_address_is_routable` проганяє кожну адресу зі SKILL.md
через справжню граматику (інваріант `INV.SURFACE.SKILL-EXAMPLE-ADDRESSES-ROUTE`).
Скіли синхронізуються з реєстром інструментів автоматично, інакше дрейфують.
Іменування змішане (за дією — `meta-edit`, за доменом — `bsp-patterns`, за
задачею — `code-review`) і не 1:1 з іменами інструментів.

**Доставка через git-marketplace.** Не npm: git-репо
`IngvarConsulting/unica-marketplace`, каталог кожного хоста вказує `git-subdir`
на `plugins/unica`, **закріплений тегом релізу**. Онбординг — команди хоста
(`claude plugin marketplace add …` + `claude plugin install unica@unica`,
аналог у Codex; ZCode — через UI). `init`/`doctor` немає. Один спільний
`.mcp.json` для трьох хостів; plugin root визначається змінною хоста
(`CLAUDE_PLUGIN_ROOT` та ін.). Робоча тека проєкту береться з контексту хоста,
а не з аргументів моделі. Канали stable і `next` (з rc.3).

**Thin package + verified cache.** У git-пакеті лише скіли, assets,
`runtime-manifest.json` і три нативні `unica-bootstrap`. Ядро й рушії — не в
пакеті: bootstrap качає ядро з GitHub Release, рушії — докачує перед першим
викликом, якому вони потрібні. SHA-256 архіву й кожного файлу, HTTP Range
resume, незмінний ключ кешу `<artifact>/<version>--<asset-sha256>/<target>`
(оновлення плагіна не перекачує незмінне), `prefetch` для offline.

**Больові точки.**

- Холодне завантаження runtime не вкладається в 30-секундний startup-бюджет
  MCP хоста Codex (issue #585 відкрита). Урок: важке завантаження на старті MCP
  крихке, ядро тримати малим.
- Немає `init`/`doctor`; Codex оновлюється як remove + add, сесія не бачить нових
  скілів до нової задачі; stable і next конфліктують однаковим іменем сервера.
  Cursor і VS Code не підтримуються.
- MCP Resources непереносні (research unica #336: Claude Code не викликає
  `resources/templates/list`, `list_changed` інертний) — критичне тримають у
  `inputSchema` і скілах.
- Висока вартість супроводу: десятки Python-гейтів, receipt-ledger, daemon;
  flaky Windows-тести (#750); багато правил з відкритим `gap`.
- Prose-скіли дублюють знання інструментів, тож без постійного лінтера
  неминучий дрейф.

## 4. simplyCMS

Джерело: <https://github.com/simplyCMS/simplyCMS> (версія пакетів 0.6.0,
остання зміна 2026-09-24; GitHub issues порожні). Шляхи нижче — всередині
цього репо.

- **Скіли в пакеті.** Джерело правди —
  `packages/simplycms/skills/<name>/` (SKILL.md + `scripts/`), один скіл
  `redesign-from-reference`; їде в npm-пакет `simplycms` через
  `"files": ["dist","src","routes","skills","migrations", ...]`. Frontmatter
  лише `name` і `description` (тригер «Use when…», двомовний). Іменування — за
  задачею. Рішення зафіксовано в
  `docs/superpowers/specs/2026-08-20-package-consolidation-design.md`
  (ПК8–ПК10): окремий репо скілів не створюється, `npx skills add` не канал,
  доставка цілком у npm.
- **Лінкування в проєкт.** Власного `postinstall` немає. Два CLI-кроки:
  `create-simplycms-store` (`src/skill-links.mjs`, після install залежностей)
  і `@simplycms/cli` (`simplycms update` → `reconcileSkillLinks`;
  `simplycms doctor` перевірка №12 `checkSkillLinks`). Лінки створюються в
  `.agents/skills` і `.claude/skills`; прямі, не ланцюжком.
- **Відносні лінки через `node_modules/<pkg>`.** POSIX-ціль
  `../../node_modules/simplycms/skills/<name>` переживає перенос теки проєкту;
  шляхи `.pnpm` у лінки не потрапляють (pnpm сам тримає симлінк
  `node_modules/simplycms`). Нова версія пакета автоматично дає нову версію
  скіла: «нуль дрейфу, нуль копій». Зайнятий шлях (власний скіл чи форк) не
  чіпається. `update` прибирає осиротілі лінки, `doctor` попереджає.
- **Windows.** Junction вимагає абсолютної цілі й існуючого каталогу; при
  пропущеному install лінки не створюються (`pending`, домалює `update`).
  Лінки не переживають перенос теки.
- **AGENTS.md/CLAUDE.md магазину не пишуться:** агент знаходить скіл лише за
  `description` через автодискавері `.claude/skills` / `.agents/skills`.
- **Болі.** Код `skill-links` продубльовано у двох пакетах (пакети не імпортують
  один одного). Резервний список `BUNDLED_SKILLS` ведеться вручну й
  синхронізується тестом. Чистий `pnpm add simplycms` скілів не дає без CLI-кроку.
  Видалення пакета лишає биті лінки до `update`. Окрема помилка у самому репо:
  закомічені симлінки `.claude/skills/tanstack-*` з абсолютними шляхами на
  локальну машину й на тимчасові каталоги сесії — антипатерн «committed absolute
  symlinks» (розділ 8).
- **MCP.** Магазинам MCP не їде; є лише внутрішній інструмент репо.
- CI пілота (`scripts/pilot-pack/link-skills.mjs`) пакує tarball, ставить у
  скретч-проєкт і читає `SKILL.md` крізь лінк: падає, якщо `files` звузили.

## 5. TanStack Intent та інші канали доставки скілів

**TanStack Intent** (`@tanstack/intent` 0.5.0, MIT, змінено 2026-09-30;
<https://tanstack.com/intent/latest/docs/overview>,
<https://github.com/TanStack/intent>). 0.x: формат вже змінювався.

- Автор: `skills/<name>/SKILL.md` у пакеті, keyword `tanstack-intent`,
  allowlist у `files`; розширений frontmatter (`type`, `library`,
  `library_version`, `requires`). Команди `validate`, `stale` (скіл відстав від
  source-docs).
- Споживач: `npx @tanstack/intent@latest install` скануе `node_modules` і
  пише керований блок між `<!-- intent-skills:start -->` і
  `<!-- intent-skills:end -->` в `AGENTS.md` (або CLAUDE.md, `.cursorrules`,
  copilot-instructions). Блок 0.5.0:

  ```
  tanstackIntent:
    - id: "@tanstack/db#db-core"
      run: "pnpm exec intent load @tanstack/db#db-core"
      for: "<description>"
  ```

  Ні копій, ні симлінків: файли лишаються в `node_modules`, агент викликає
  `intent load <pkg>#<skill>`; оновлення пакета оновлює скіл. Код забороняє
  локальні шляхи в блоці. Опційно `hooks install` (SessionStart).
- Болі (issues TanStack/intent): #39, #153, #297 — discovery ламається під
  pnpm isolated і на Windows; #128 — OOM через рекурсивні симлінки в моноспейсах;
  #215 — агенти спершу пробують нативні механізми скілів. Висновок: `load` за
  іменем надійніший за скан.
- **Наш `AGENTS.md`** уже містить блок із цими маркерами, але з тілом ранньої
  версії формату (`skills:` → `task` / `load: ".agents/skills/..."`). Повторний
  `intent install` перезапише тіло блоку: блок керований.

**`skills-npm`** (antfu, <https://github.com/antfu/skills-npm>): симлінкує
`skills/` пакетів з `node_modules` у `.claude/skills/` (відносні лінки, можна
комітити; `prepare` у кореневому package.json; префікс `npm-`).

**Vercel `skills`** (`npx skills add`, 1.7.0,
<https://github.com/vercel-labs/skills>): джерело — git-репо, не npm-версія;
режими symlink (за замовчуванням) і `--copy`, 75+ агентів. Версії скілів і
бібліотеки розходяться. Так дистрибутують Supabase, Shopify, Nx (для не-Claude
агентів).

**Скіл-вказівник на доки пакета.** Turborepo
([SKILL.md](https://github.com/vercel/turborepo/blob/main/skills/turborepo/SKILL.md)):
«The complete Turborepo documentation ships inside the installed `turbo`
package … Always read the bundled docs, which match the installed version
exactly». Next.js 16 так само вказує агенту на версійні доки в
`node_modules/next/dist/docs/`. Скіл навчає коли й як, факти — у доках пакета.

**agentskills RFC #81** (<https://github.com/agentskills/agentskills/issues/81>):
«skills у node_modules» не стандартизовано. Blockers, перелічені мейнтейнером:
prompt-injection supply chain; симлінки на Windows; не в кожного менеджера
пакетів є скановний каталог чи lifecycle-хуки; осиротілі скіли після видалення
залежності; конфлікти імен; керовані й користувацькі скіли в одному каталозі;
у моноспейсах незрозуміло, чиї версії скілів перемагають.

Порівняння трьох моделей доставки:

| Модель | Протухання | Windows / pnpm | Нативний каталог агента |
| --- | --- | --- | --- |
| Симлінк (simplyCMS, skills-npm) | немає, поки лінк живий | junction, осиротілі лінки, ізоляція pnpm | так |
| Копія (`--copy`, Nx для не-Claude) | є: потрібен stale-check | працює всюди | так |
| Вказівник у AGENTS.md + `load` (Intent) | немає | надійно за іменем | ні: потрібен явний рядок «run … load» |

## 6. Реєстрація MCP у клієнтах

Перевірено 2026-10-02 за документацією клієнтів
([Claude Code](https://code.claude.com/docs/en/mcp),
[VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers),
[Codex](https://developers.openai.com/codex/mcp)).

| Клієнт | Файл / команда | Нюанси |
| --- | --- | --- |
| Claude Code | `.mcp.json` у корені (ключ `mcpServers`); `claude mcp add --scope project <name> -- <cmd> args` | project-scope схвалюється при першому запуску; `${VAR:-default}` у command/args/env; плагін може бандлити `.mcp.json` і скіли (`${CLAUDE_PLUGIN_ROOT}`) |
| VS Code / Copilot | `.vscode/mcp.json` — ключ **`servers`**, не `mcpServers`; `code --add-mcp '{json}'` | trust-діалог; файл радять комітити |
| Cursor | `.cursor/mcp.json` (`mcpServers`) | так у доках Angular і Supabase |
| Codex | `.codex/config.toml` (довірені проєкти) або глобальний: `[mcp_servers.x]`; `codex mcp add <name> -- <cmd>` | `enabled_tools` / `disabled_tools`, `startup_timeout_sec` (10), `tool_timeout_sec` (60) |
| Gemini CLI | `gemini mcp add --transport http … --scope user` | `[вторинне]` з доків Prisma |

Портативний мінімум: `.mcp.json` у корені (Claude Code, частково інші) плюс
друк готових команд `claude mcp add` / `codex mcp add` та окремий сніпет для
`.vscode/mcp.json`.

**Хто постачає init:**

- **Nx** — `npx nx configure-ai-agents [--agents claude,codex,copilot,cursor,gemini]`
  пише AGENTS.md/CLAUDE.md, MCP-конфіг і скіли; `--check=all` перевіряє
  протухання. Для Claude — плагін, для решти — копія.
- **Intent** — `install` (лише guidance в AGENTS.md) і `hooks install`.
- **skills-npm** — `setup`. **Storybook** — `storybook add` + `mcp-add`.
- Angular, Next.js, Prisma, Playwright, Shopify, Supabase — лише
  задокументований сніпет або плагін без init.
- unica — init немає, усе через команди marketplace хоста.

## 7. Найменування пакетів і скілів

**Пакети.** Назва пакета — назва продукту, поверхні — підкоманди: `prisma`,
`nx mcp`, `ng mcp`, `supabase`, `turbo`. `@x/cli` як основний вектор у вибірці
не зустрівся: CLI живе в пакеті продукту (`bin` у `prisma`, `nx`,
`@angular/cli`). Окремі MCP-пакети мають суфікс домену, а не транспорту
(`next-devtools-mcp`, `@playwright/mcp`, `@shopify/dev-mcp`,
`@storybook/addon-mcp`). `@x/cli` виправданий, коли головний пакет —
бібліотека, яку не хочуть робити `bin`-ом. `@tanstack/intent` — окремий
tooling-пакет, що працює з чужими пакетами; скіли при цьому живуть у самих
бібліотеках.

**Скіли** ([Anthropic, skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)):

- `name` ≤64 символи, `[a-z0-9-]`, без слів «anthropic» і «claude»;
  `description` ≤1024, що скіл робить і коли використовувати, **третя особа**.
- Рекомендація: gerund (`processing-pdfs`, `managing-databases`); прийнятні
  `pdf-processing`, `process-pdfs`. Уникати `helper`, `utils`, `tools`, `data`.
- Progressive disclosure: на старті в контексті лише `name` і `description`;
  тіло SKILL.md до 500 рядків; посилання на допоміжні файли на один рівень.
- Спершу evaluation-сценарії (три на скіл, baseline без скіла), перевірка на
  Haiku / Sonnet / Opus. Для MCP-інструментів у скілі — повні імена
  `ServerName:tool_name`.
- Практика продуктів: імена нейтральні до транспорту, за задачею чи доменом
  (Nx — `nx-workspace`, `nx-run-tasks`; Supabase — `supabase`; Turborepo —
  `turborepo`). Транспорт — деталь усередині скіла («якщо є MCP — інструмент X,
  інакше `x compile`»). Префікс продукту знижує ризик колізій імен між
  пакетами (RFC #81).
- Наш `simetra-cli` названо за транспортом; за гайдом Anthropic ближче
  інтентні назви на кшталт `validating-metadata` / `editing-metadata`.

## 8. Антипатерни

1. **`postinstall` / `prepare` у залежності, що пише в проєкт споживача.**
   pnpm 10+ не виконує lifecycle-скрипти залежностей за замовчуванням
   (`onlyBuiltDependencies`), pnpm 11 — `allowBuilds`
   ([pnpm 11](https://pnpm.io/blog/releases/11.0),
   [settings](https://pnpm.io/settings/build)); CVE-2025-69264 — обхід через
   git-залежності, де `prepare` / `prepack` усе ще виконуються. Не в усіх
   менеджерів пакетів є lifecycle-хуки (RFC #81). Пише лише явна команда
   `init`, яку запускає людина.
2. **Протухлі копії скілів.** `npx skills add` відв'язує скіл від версії
   бібліотеки; `--copy` потребує stale-check (Intent `stale`, Nx `--check`).
3. **MCP дублює CLI-логіку чи схеми.** Nx і Playwright винесли мутації в CLI
   і скіли саме через роздутість і токени.
4. **Роздутий каталог інструментів.** Anthropic: «more tools don't always
   lead to better outcomes», консолідувати, namespacing, `concise`/`detailed`,
   пагінація
   ([writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)).
   Claude Code: ліміт виводу MCP 25 000 токенів (`MAX_MCP_OUTPUT_TOKENS`).
   unica пройшов 74 → 8 і 264 643 → ціль 2000–3000 токенів на `tools/list`.
5. **Write-інструменти за замовчуванням.** Supabase (`read_only`,
   `project_ref`), Angular (`--read-only`), Prisma (деструктив блокується для
   агентів), Nx (MCP read-only). Для деструктивних і пакетних операцій —
   plan-validate-execute, dry-run.
6. **Закомічені абсолютні симлінки** (simplyCMS: `.claude/skills/tanstack-*` на
   локальні шляхи машини й тимчасові каталоги). Лінк у git лише відносний і лише
   на каталог, що гарантовано є в чекауті.
7. **Симлінк як єдиний механізм** (Windows, ізоляція pnpm, рекурсія в
   моноспейсах, осиротілі лінки, змішування керованих і власних скілів в одному
   каталозі).
8. **Скіл, що переказує spec чи доки пакета** — дублікат, який протухає.
   Turborepo-скіл прямо відмовляється від власного змісту на користь доків у
   пакеті.
9. **Автопідхоплення скілів усіх залежностей без довіри.** `description`
   завжди в контексті, тож це supply-chain вектор prompt injection (RFC #81;
   Intent: allowlist пакетів, review змін).
10. **Важке завантаження при старті MCP** (unica #585: стартовий бюджет хоста).
11. **Хардкод одного формату конфігу клієнта**, тихий запис у глобальні
    user-конфіги.

## 9. Стан канону Simetra на 2026-10-02

Скорочення: платформна спека — `docs/superpowers/specs/2026-09-24-simetra-platform-design.md`
(далі S), P2 — `docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md`.

- **S §3.2:** `@simetra/cli` (компіляція, план, застосування, `explain`, `fix`,
  `mcp`, `studio`), `@simetra/studio`, `create-simetra-app`; версія спільна з
  флагманським пакетом; `simetra mcp` — MCP над тими самими API. S §3.1 у
  переліку команд `studio` не має.
- **S §11:** tsdown, `exports`, publint + attw, canary, пілот із tarball;
  «скіли їдуть у пакеті (`skills/`)»; скіли розробки платформи окремо від скілів
  для споживачів. **S §12:** збірка й публікація відкладені, мінімальна
  доставка (щонайменше CLI) — у П3.
- **P2 §8.6:** CLI `compile`, `explain`, `fix`, `mcp`; MCP read-only за
  замовчуванням, запис лише через операції й після успішної компіляції,
  «єдині двері»; прапор `--allow-write` у спеці явно не названо (він лише у
  скілі).
- **CLAUDE.md:** скіли для споживачів їдуть у пакеті `skills/`, repo-скіли —
  лише про код платформи.
- **Код:** `packages/simetra` і `packages/cli` — `private`, `exports` на сирий
  TS, збірки немає; `@simetra/cli` запускається з вихідників через tsx.
  Каталогу `skills/` у жодному пакеті немає.

Прогалини:

1. `skills/` обіцяно, але не існує; механіка (який пакет, `files`, як агент
   застосунку підхоплює скіл) ніде не описана.
2. `simetra-cli` — споживацький за змістом, але лежить серед repo-скілів і
   згаданий в `AGENTS.md` як скіл розробки; його тіло посилається на шляхи
   репо й «runs from sources», нечинні для споживача пакета.
3. `scripts/check-doc-anchors.py` жорстко прив'язує корпус скілів до `.agents/skills`
   (глоби джерел, `SKILLS_DIR`, ліміти рядків): скіл у `packages/*/skills/`
   випаде з перевірок, якщо гард не розширити.
4. `init` / `create-simetra-app` — лише назва, без команд, змісту й ролі скілів
   у шаблоні.
5. CLI → studio (S §3.2 включає `studio` у CLI, `@simetra/studio` окремий пакет):
   залежність не визначена.
6. Розбіжність S §3.2 («`@simetra/cli`») і підходу «один пакет-продукт з
   режимами» (розділ 2): відкрите питання для власника.

## 10. Брати / уникати

| Брати | Уникати |
| --- | --- |
| Ядро операцій як експортований API пакета-продукту (`simetra`); CLI, MCP, студія — тонкі адаптери без власної логіки й схем; окремий пакет лише з власним життєвим циклом (Nx, Angular, Next-міст) | `@x/cli` як центр; MCP з власною копією логіки чи схем; дроблення без окремого життєвого циклу |
| Один реєстр операцій (у нас Zod) → `tools/list`, згенерований довідник, CI-гейти дрейфу (unica `tool_catalog`) | Ручний довідник інструментів, що дрейфує від коду |
| Мало інструментів за питаннями, а не CRUD; бюджети токенів як гейти; метрика «токени на розв'язання + first-call success» (unica) | Один інструмент на ендпоінт; великі відповіді без пагінації й обрізання |
| MCP read-only за замовчуванням, запис — явний прапор (`--allow-write`) + фільтр інструментів / груп; dry-run; мутації через CLI у скілах (Nx, Playwright) | Write-інструменти за замовчуванням; деструктив без підтвердження чи dry-run |
| Скіли в `skills/<name>/SKILL.md` пакета-продукту, `files` у package.json; версія скіла = версія коду | Скіли з git-репо окремо від версії бібліотеки як єдиний канал |
| Скіл — тонкий маршрутизатор («MCP routing»: якщо є MCP — інструмент X, інакше команда CLI), факти — у спеках і доках пакета, вказівник на версійні доки (Turborepo, Next) | Скіл, що переказує spec; SKILL.md понад 500 рядків; вкладені посилання |
| CI-лінтер скілів: приклади проганяються через справжній парсер, заборона знятих інструментів, validate + stale (unica, Intent) | Скіли без перевірки дрейфу від коду |
| Іменування скілів за задачею (gerund чи noun-phrase), `description` = що + коли, третя особа, префікс продукту | Назва за транспортом (`x-cli`), `helper`/`utils`/`tools`, зарезервовані слова |
| Явна ідемпотентна `init` з `--agents`, `--check`, `--dry-run` (Nx `configure-ai-agents`); пише `.mcp.json` і друкує `claude mcp add` / `codex mcp add` та сніпет для `.vscode/mcp.json` (ключ `servers`) | `postinstall` / `prepare` у залежності, що пише в проєкт (pnpm 10+/11, CVE-2025-69264); тихий запис у глобальні конфіги |
| Доставка скіла в проєкт: вказівник у AGENTS.md/CLAUDE.md + команда `load` (Intent-модель) або відносний симлінк через `node_modules/<pkg>` (simplyCMS) із `doctor`/`update`; копія лише з маркером версії й перевіркою протухання | Симлінк як єдиний шлях; закомічені абсолютні лінки; змішування керованих і власних скілів в одному каталозі без маркера |
| Сумісність з Intent майже безкоштовна: `skills/` у пакеті + keyword `tanstack-intent`; зважити формат блоку 0.5.0 перед `intent install` у нашому `AGENTS.md` | Автопідхоплення скілів усіх залежностей без allowlist |
| Thin package + verified cache із незмінним ключем (unica) — лише якщо з'явиться бінарне ядро поза npm | Важке завантаження на старті MCP (unica #585) |
| Скіли розробки платформи (`.agents/skills`) і скіли споживача (`skills/` пакета) розвести за призначенням | Споживацький скіл серед repo-скілів і в `AGENTS.md` як скіл розробки |
