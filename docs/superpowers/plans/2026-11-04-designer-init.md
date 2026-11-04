# Доставка-1: `simetra init` — план виконання

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: виконано; повні гейти зелені на 98beac81.

**Goal:** команда `simetra init [--agents …] [--dry-run] [--check]` у проєкті
споживача розкладає відносні симлінки скілів `@simetrajs/designer` і
MCP-конфіги агентів, ідемпотентно й без чужих перезаписів; гейт пакування
доводить це на tarball-ах.

**Architecture:** `init` — окрема команда командного рядка поза каталогом
інструментів (як `mcp`). Вона спершу будує план дій (`planInit`: читає диск,
нічого не пише), потім застосовує його (`applyInit`); `--dry-run` і `--check`
— той самий план без застосування. Шляхи до встановленого пакета дає один
механізм `io/package-path.ts` (`installedPackageDir` + `posixRelative`), яким
уже користується резолвер `$schema`; ним же будуються ціль лінків скілів і
шлях до бінарника в MCP-конфігах.

**Tech Stack:** TypeScript (strict), Node ≥ 24 (`node:fs/promises`), citty
0.2.2, Vitest, гейт пакування (`npm install` / `pnpm add` tarball-ів у
скретч-проєкт), `@modelcontextprotocol/client` (stdio).

**Spec:** [спека designer](../specs/2026-10-02-simetra-designer-design.md)
§4.2 (контракт `init`), §4.4 (рядок pre-commit), §3.1–§3.2 (запис увімкнено,
`--read-only`), §4.1 (скіли в пакеті), §5.3; [платформна
спека](../specs/2026-09-24-simetra-platform-design.md) §11 «Доставка»;
[release.md](../../architecture/release.md) (гейт пакування);
[звіт П0 (а)](../specs/2026-11-04-p0-a-host-report.md).

## Global Constraints

- Робоче місце — worktree `/home/vsydorenko/Simetra-init`, гілка
  `feat/designer-init`. Перед першою задачею — `pnpm install` у worktree
  (`node_modules` там немає). Дерева `/home/vsydorenko/Simetra` (A4),
  `Simetra-deps`, `Simetra-rights3` не чіпати.
- Коміти — Conventional Commits з українським описом, без трейлерів.
- Коментарі коду — українською, пояснюють **чому**; посилання — на розділи
  спек («спека designer §4.2»), не на «Рі-n».
- Тексти, що читає споживач (вивід команди, README, скіл, `description`
  citty), — англійською.
- **Одна нова залежність** — `smol-toml` 1.9.1 (точний pin, BSD-3-Clause за `LICENSE` репо `squirrelchat/smol-toml`, без залежностей; Рі-6) у `dependencies` `@simetrajs/designer`. Конфлікт `pnpm-lock.yaml` з `chore/deps-refresh` розв'язується при зведенні.
- Реєстр інструментів (`src/tools/*`), MCP-адаптер (`src/mcp/*`) і
  `src/cli/command.ts` план **не змінює** — їх змінює A4 (`Tool.cliOnly`,
  `rights-maintenance`). Єдина спільна з A4 поверхня —
  `skills/simetra-metadata/SKILL.md` (Task 5): правка — окремий новий розділ у
  кінці файлу, без зміни наявних рядків (A4 міняє таблицю маршрутизації).
- Версії пакетів і `PLATFORM_VERSION` не змінюються; публікації немає.
- Під час роботи — лише scoped тести: `pnpm --filter @simetrajs/designer test <pattern>`,
  **без `--`** перед шаблоном. Кожен коміт — scoped тести, `typecheck` і
  `lint` пакета.
- Повні гейти (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
  `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`,
  `pnpm build:packages && pnpm test:packaging`) — лише на одному SHA з дозволу
  архітекторки. Для налагодження Task 4 локальний `pnpm build:packages &&
  pnpm test:packaging` у worktree дозволено (стека не чіпає). DB-коду план не
  торкається; стек не перезапускати.
- Тести — на тимчасових теках (`mkdtemp(tmpdir())`), прибирання в `afterEach`.
  Перед тестами прочитати `.agents/skills/writing-tests/SKILL.md`.
- Коди виходу — як у решти CLI (`docs/architecture/designer.md`): 0 — чисто,
  1 — діагностика (`--check` знайшов розбіжність), 2 — використання чи
  введення-виведення (зокрема будь-яка відмова плану, і з `--check` теж).

## Рішення

| № | Рішення | Обґрунтування | Вплив на спеку |
| --- | --- | --- | --- |
| Рі-1 | **`init` — команда поза каталогом інструментів**: `src/commands/init.ts`, підключення в `src/main.ts` поряд із `mcp`. У MCP її немає; `TOOL_NAMES`, `Tool`, `invoke` не змінюються | Каталог — операції над текою метаданих з осями `files`/`database`/`data`; `init` пише конфіги агента в корінь проєкту, жодна вісь цього не описує. Прецедент — `mcp`. Заодно немає конфлікту з A4 у реєстрі | спека designer §3.1 (пункт «командний рядок»: поза каталогом — лише команди запуску режиму `mcp` і онбордингу `init`) і §4.2 (одне речення: `init` — команда командного рядка, MCP її не має) |
| Рі-2 | **Один механізм шляхів**: `installedPackageDir(fromDir, pkg)` (наявний, без `realpath`) + новий `posixRelative(fromDir, to)` в `io/package-path.ts`. Резолвер `$schema` переходить на `posixRelative`; ціль лінків скілів і шлях до бінарника в MCP-конфігах будуються тими самими функціями від кореня проєкту — поточної теки запуску. Пошук іде вгору від кореня, тож піднятий (hoisted) `node_modules` дає довший, але відносний шлях (`../../../node_modules/…`) | Спека §4.2 вимагає одного механізму. Факт перевірено: борг `$schema` у коді вже закрито (`installedPackageDir`, `schemaPathResolver`, тест пакування «fix writes $schema…»); у спеці П2 §14 пункту про `$schema` немає, §8.5 описує цільове правило з посиланням на §4.2. Лишилось — повторно використати механізм і прибрати з канону наратив «борг закривається» | спека designer §4.2: ціль — відносний шлях до `node_modules/@simetrajs/designer/skills/<скіл>`, найближчого вгору від кореня (зазвичай `../../node_modules/…`); останнє речення — без «закриває борг»; §5.1 — пункт про П2 §14 прибрати як виконаний |
| Рі-3 | **Власний лінк** — симлінк (junction), чий `readlink`, резолвлений від теки лінка й нормалізований (`packageSubpath` у `src/init/own-path.ts`), — тека рівно на рівень нижче якоїсь `node_modules/@simetrajs/designer/skills/` (ціль із `..`, що виводить за межі, — чужа); перед видаленням (сирота, `replaces`) `applyInit` перевіряє це правило на диску ще раз і без збігу падає з `changed-since-plan`; також звичайний файл, чий вміст (без пробілів по краях) дорівнює очікуваній POSIX-цілі (git на Windows без `core.symlinks` так розгортає закомічений симлінк). **Лінк збігається**, коли `resolve(dirname(link), readlink(link))` дорівнює очікуваній теці скіла — форма цілі (відносна чи абсолютна) не важить; порівняння — чиста функція `sameDir(a, b, platform)` (на `win32` без регістру й хвостового роздільника). Решта (тека, інший файл, симлінк кудись інде) — **чуже**: `init` не чіпає, друкує примітку; `--check` зелений з приміткою | Правило за ціллю ловить застарілі власні лінки (перенос проєкту, інший `node_modules`). Збіг за резолвом не дає вічного дрейфу між Windows (абсолютний junction) і POSIX (відносний лінк) у спільному репо. Чуже ім'я — свідомий форк скіла власником проєкту: `init` його ніколи не виправить, тож червоний `--check` був би вічним | спека designer §4.2: що таке «власний» і «чужий» лінк; `--check` на чужому імені зелений з приміткою |
| Рі-4 | **Агенти за замовчуванням — `claude`** (лише `.mcp.json`). Скіли кладуться в обидві теки (`.agents/skills`, `.claude/skills`) незалежно від `--agents`. `--check` перевіряє той самий набір, що дав би `init` з тими ж `--agents`. **Лінки й конфіги комітяться**; `--check` у CI звіряє закомічене | `.mcp.json` — портативний мінімум (дослідження доставки §6); конфіги інших клієнтів без запиту — сміття в репо споживача. Теки скілів у спеці не прив'язані до агента. Без коміту `--check` у CI не мав би що звіряти | спека designer §4.2: «без `--agents` — `claude`»; лінки й конфіги — частина репо споживача; CI кличе `--check` з тими ж `--agents` |
| Рі-5 | **Запис MCP** — ключ `simetra`; `command: "node"`, `args: [<bin>, "mcp"]`, де `<bin>` = `posixRelative(root, join(pkgDir, manifest.bin.simetra))` з маніфесту **встановленого** пакета (у зібраному пакеті — `node_modules/@simetrajs/designer/dist/main.js`). `.vscode/mcp.json` додає `"type": "stdio"`; `.vscode/mcp.json` — `"cwd": "${workspaceFolder}"` (за документацією VS Code поле підтримується, типово — тека воркспейсу); `.cursor/mcp.json` — `"type": "stdio"` (обов'язкове) і `${workspaceFolder}` прямо в `args`: `["${workspaceFolder}/<bin>", "mcp", "${workspaceFolder}/<dir>"]`, де `<dir>` — `DEFAULT_DIR` з `src/io/default-dir.ts` без `./` (те саме джерело, з якого `simetra mcp` бере теку без позиційного аргументу; конфігу проєкту з текою немає), бо проєктний `mcp.json` Cursor поля `cwd` не має, інтерполює лише `command`/`args`/`env`/`url`/`headers`, а робочої теки сервера не документує (звірено через context7, 04.11); Claude Code і Codex запускають сервер у корені проєкту самі (Codex — тека сесії, перевірено за кодом Codex: `local_process_cwd`). **Власний запис** — `command === "node"` і `args[0]` (без префікса `${workspaceFolder}/`), резолвлений від кореня й нормалізований, лежить у якійсь `node_modules/@simetrajs/designer/`. **Збіг** — одна чиста функція `matchesOwn(entry, expected)`: `command === "node"`, `args[0]` дорівнює очікуваному шляху bin (для Cursor — з префіксом `${workspaceFolder}/`), `args[1] === "mcp"`, для Cursor — `args[2..]`, розібрані citty за описом аргументів команди `mcp` (`mcpArgs` у `src/commands/mcp-args.ts`), мають позиційну теку, ключі, яких вимагає клієнт (`type`, `cwd` за таблицею Task 2), рівні очікуваним; зайві ключі (`env`) і `args[1..]` (дописаний `--read-only`, тека) не важать. Власний запис без збігу `init` оновлює: ставить `args[0]`, `args[1] = "mcp"`, обов'язкові ключі, для Cursor без позиційної теки — вставляє `${workspaceFolder}/<dir>` третім елементом (нестандартну теку власник дописує в `args` будь-якого клієнта сам — її `init` зберігає як `args[2..]`); решту (`args[2..]`, зайві ключі) лишає; `--check` для нього червоний. Запис `simetra` іншої форми — **чужий**: не переписується, примітка, `--check` зелений | `node` + шлях не залежить від ОС (`npx` на нативному Windows вимагає обгортки `cmd /c`, а конфіг спільний для всіх ОС) і від менеджера пакетів; шлях до bin бере той самий механізм, що й лінки, а оновлення пакета, яке змінить шлях bin, ловить `--check`. Тека метаданих — типова `./metadata` (без прапорців, §4.2) | спека designer §4.2: форма запису й правило власного/чужого запису |
| Рі-6 | **`.codex/config.toml` — розбір парсером `smol-toml`, запис — дописуванням тексту** (архітекторка, фаза 2). Нерозбірний TOML — відмова `invalid-toml`. Запис шукається в розібраному об'єкті як `mcp_servers.simetra` (будь-яка форма: заголовок, лапки, inline-таблиця, dotted keys). Немає — блок `[mcp_servers.simetra]` з `command`/`args` дописується в кінець файлу; префікс — наявні байти без змін; закінчення рядків — як у файлі (CRLF, якщо він є); роздільник — одне закінчення рядка, якщо файл ним закінчується, два — якщо ні; порожній файл — без роздільника. Є — класифікація `matchesOwn` (Codex `cwd` не вимагає). Власний без збігу `init` оновлює, лише якщо в тексті рівно один рядок-заголовок цієї таблиці (`[mcp_servers.simetra]` з будь-якими лапками й пробілами) і в її блоці (до наступного заголовка) рівно один однорядковий рядок `args = [ … ]`: цей рядок замінюється масивом з виправленими `args[0..1]` і збереженими `args[2..]`; результат знову розбирається, і він мусить дати очікуваний запис. Інакше — відмова `ambiguous-toml` (код 2) | Парсер не помиляється на багаторядкових рядках, inline-таблицях, лапках і коментарях; дописування й заміна одного рядка зберігають коментарі й порядок споживача; повторний розбір після правки — доказ, що правка однозначна | немає |
| Рі-7 | **Все або нічого на рівні плану**: `planInit` повністю читає диск і повертає дії, примітки й відмови. Будь-яка помилка ФС, крім `ENOENT`, на шляху чи його предку (`ENOTDIR`, `EISDIR`, `EACCES`) — відмова, а не виняток. Відмови: непарсований JSON (напр. з коментарями), корінь не об'єкт, `mcpServers`/`servers` не об'єкт, неоднозначний TOML, предок шляху — не тека, шлях конфігу — тека, тека скілів чи її предок у корені — симлінк не на іншу теку скілів (Рі-11). За будь-якої відмови нічого не пишеться, код 2. Помилка ФС під час `applyInit` — код 2, `error: <path>: <code>`. `--check` разом із `--dry-run` — помилка використання, код 2. Відмови плану — все або нічого, але збій вводу-виводу посеред застосування може лишити частину дій виконаною; повторний `init` їх доробляє | Часткове застосування лишало б проєкт у стані, якого не описує жоден вивід; збій посеред застосування після чистого плану — лише гонка з іншим процесом | немає |
| Рі-8 | **Windows**: `linkSpec(linkPath, targetDir, platform)` — на `win32` `{ type: "junction", target: <абсолютний> }`, інакше `{ type: "dir", target: posixRelative(...) }`. Вітки Windows (`linkSpec`, `sameDir`) покриті юніт-тестами чистих функцій, а не прогоном на Windows | Junction вимагає абсолютної цілі (дослідження доставки §4). CI — лише Linux; обмеження фіксується у звіті | немає (спека вже каже «на Windows — junction») |
| Рі-9 | **JSON-конфіг переписується цілим**: `JSON.stringify(obj, null, 2) + "\n"`, порядок ключів збережено, новий сервер — останнім. Збіг запису — `matchesOwn` (Рі-5) проти очікуваного запису **цього клієнта**, без залежності від порядку ключів | Без коментарів і невідомих ключів (§4.2); форматування чужого файлу може змінитися — прийнятно для строгого JSON. Обмеження: переписування через `JSON.stringify` нормалізує чужий файл — форматування і точність великих чисел | немає |
| Рі-10 | **Після `init` і `--dry-run`** вивід закінчують два рядки: про `--read-only` (§4.2) і готовий рядок для `.husky/pre-commit` — `npx simetra compile --all --staged` (§4.4). `--check` їх не друкує | Обидва рядки вимагає спека; у CI-виводі вони — шум | немає |
| Рі-11 | **Тека скілів-симлінк**: якщо `.claude/skills` (чи `.agents/skills`) — симлінк, чия ціль лексично (`sameDir(resolve(dirname(p), readlink(p)), <інша тека скілів>)`, без `realpath`, тож і коли ціль ще не існує) — інша тека скілів (поширена схема `.claude/skills → ../.agents/skills`), тека-симлінк пропускається з приміткою `aliased-skill-dir`, план будується для теки, на яку вона вказує. Симлінк теки скілів кудись інде, а також симлінк-предок теки скілів у межах кореня (`.claude`, `.agents`) — відмова `skill-dir-is-a-link` | Дві дії `link` на один фізичний шлях дали б `EEXIST` посеред застосування; відносна ціль, порахована від лексичного шляху, у чужій фізичній теці не резолвилась би | немає |
| Рі-12 | **Аргументи суворі**: `runInit` відхиляє невідомі ключі (білий список: `agents`, `dry-run`, `check`, camelCase-аліаси, які додає citty — `dryRun`, — і `_`), позиційні аргументи, порожній `--agents`, невідомого агента (код 2, stderr називає поганий аргумент). Валідація аргументів — до пошуку пакета | citty 0.2.2 мовчки ковтає `--agent codex` (`{ agent: true, _: ["codex"] }`): `init --check --agent codex` у CI був би зеленим без перевірки Codex | немає |
| Рі-13 | **Перевірка `init` — у гейті пакування** вже зараз; пілот із host (платформна спека §11) лишається окремою роботою доставки й повторить її на формі реального споживача | Гейт пакування — наявний механізм на tarball-ах; пілот поза обсягом | немає: §11 не змінюється, гейт лише додає ранню перевірку |

## Review Focus

1. **Повторний `init` після ручного дописування `--read-only`** у `args` запису
   `simetra` — нічого не змінює, `--check` зелений (Task 2, «keeps extra args of
   an own entry»).
2. **`.vscode/mcp.json` з коментарями** (VS Code їх дозволяє) — відмова з
   назвою файлу, лінки скілів теж не створюються (Task 3, «refuses and writes
   nothing»).
3. **`.claude/skills → ../.agents/skills`** — одна дія на скіл, жодного `EEXIST`
   (Task 1, Task 3).
4. **Оновлення пакета** — новий вміст скіла видно крізь той самий лінк без
   повторного `init`; новий скіл чи зміна шляху bin — `--check` червоний, `init`
   виправляє — і для JSON, і для TOML Codex (Task 1, Task 2, Task 4).
5. **Запуск поза проєктом** (немає `node_modules/@simetrajs/designer` вище
   кореня) — код 2 з назвою пакета, нічого не створено (Task 3).

---

### Task 1: Спільний механізм шляхів і план лінків скілів

**Files:**
- Modify: `packages/designer/src/io/package-path.ts`
- Modify: `packages/designer/src/io/schema-path.ts`
- Create: `packages/designer/src/init/types.ts`
- Create: `packages/designer/src/init/fs-probe.ts`
- Create: `packages/designer/src/init/skills.ts`
- Test: `packages/designer/src/__tests__/package-path.test.ts` (доповнити)
- Test: `packages/designer/src/__tests__/init-skills.test.ts`

**Interfaces:**
- Produces (`io/package-path.ts`):
  `posixRelative(fromDir: string, to: string): string` — `relative()` з
  роздільниками `/`.
- Produces (`init/types.ts`):
  ```ts
  export type InitAction =
    | { kind: "link"; path: string; target: string; type: "dir" | "junction"; replaces: boolean }
    | { kind: "unlink"; path: string }
    | { kind: "write"; path: string; content: string; creates: boolean }
  export type InitNote =
    | { kind: "foreign-skill"; path: string }
    | { kind: "aliased-skill-dir"; path: string }
    | { kind: "foreign-mcp-entry"; path: string }
  export type InitRefusalReason =
    | "invalid-json" | "not-an-object" | "servers-not-an-object"
    | "invalid-toml" | "ambiguous-toml"
    | "not-a-directory" | "not-a-file" | "skill-dir-is-a-link" | "unreadable"
  export interface InitRefusal { path: string; reason: InitRefusalReason; code?: string }
  export interface InitPlan { actions: InitAction[]; notes: InitNote[]; refusals: InitRefusal[] }
  ```
  Шляхи в `path` — абсолютні; рендер (Task 3) показує їх відносно кореня.
- Produces (`init/fs-probe.ts`): `probe(path: string): Promise<{ kind: "missing" | "file" | "dir" | "symlink" } | { kind: "error"; code: string }>`
  на `lstat`: `ENOENT` → `missing`, інша помилка → `error` (стає відмовою `unreadable`
  чи `not-a-directory` для `ENOTDIR`). Спільний для Task 1 і Task 2.
- Produces (`init/skills.ts`):
  - `SKILL_DIRS = [".agents/skills", ".claude/skills"] as const`
  - `DESIGNER_PACKAGE = "@simetrajs/designer"`
  - `linkSpec(linkPath: string, targetDir: string, platform: NodeJS.Platform): { target: string; type: "dir" | "junction" }`
  - `sameDir(a: string, b: string, platform: NodeJS.Platform): boolean`
  - `planSkillLinks(root: string, pkgDir: string, platform: NodeJS.Platform): Promise<InitPlan>` —
    скіли пакета = підтеки `<pkgDir>/skills` з `SKILL.md`.

- [X] **Step 1: Тест `posixRelative`.** У `package-path.test.ts`:
  `posixRelative("/p/.claude/skills", "/p/node_modules/x/skills/a")` →
  `"../../node_modules/x/skills/a"`. Наявний тест резолвера `$schema` лишається без змін.
- [X] **Step 2: Додати `posixRelative`, перевести на нього `schemaPathResolver`.**
  Тести `package-path` зелені.
- [X] **Step 3: Тести `init-skills.test.ts`** (фікстура: тимчасовий корінь з
  `node_modules/@simetrajs/designer/{package.json,skills/<n>/SKILL.md}`; у
  pnpm-варіанті пакет лежить у `store/`, а `node_modules/@simetrajs/designer` —
  симлінк на нього). Кожен тест перевіряє і план, і (де план порожній чи є
  відмова) що на диску нічого не з'явилось:
  - `plans relative links in both skill dirs`: скіли `a`, `b` — чотири дії `link`,
    `target === "../../node_modules/@simetrajs/designer/skills/a"`, `type: "dir"`.
  - `links through node_modules, not the pnpm store`: pnpm-фікстура — `target` не містить `store`.
  - `hoisted node_modules gives a longer relative target`: корінь `<tmp>/app`,
    пакет у `<tmp>/node_modules` — `target === "../../../node_modules/@simetrajs/designer/skills/a"`.
  - `leaves a foreign directory alone`: справжня тека `.claude/skills/a` з файлом —
    жодної дії на цей шлях, примітка `foreign-skill`.
  - `leaves a foreign symlink alone`: `.agents/skills/a` → `../../vendor/a` — те саме.
  - `removes an own orphan link`: `.claude/skills/old` → `../../node_modules/@simetrajs/designer/skills/old`
    (скіла `old` у пакеті немає) — дія `unlink`.
  - `replaces an own stale link`: `.claude/skills/a` → `../../../elsewhere/node_modules/@simetrajs/designer/skills/a` —
    дія `link` з `replaces: true`.
  - `replaces a symlink checked out as a plain file`: файл `.claude/skills/a` з
    вмістом `../../node_modules/@simetrajs/designer/skills/a` — дія `link`, `replaces: true`.
  - `accepts an absolute link to the right dir`: `.claude/skills/a` → абсолютний
    шлях очікуваної теки — без дій (збіг за резолвом).
  - `no actions when links match`: після створення очікуваних лінків — порожній план.
  - `does not touch unrelated entries`: `.claude/skills/mine` (чужа тека з іншим іменем) — без дій і без примітки.
  - `plans once for aliased skill dirs`: `.claude/skills` → `../.agents/skills` —
    дві дії `link` (лише в `.agents/skills`), примітка `aliased-skill-dir`; те саме, коли
    `.agents/skills` ще не існує (висячий аліас).
  - `refuses a skill dir linked elsewhere`: `.claude/skills` → `../shared` — відмова `skill-dir-is-a-link`; так само `.claude` → `vendor/deep/claude`.
  - `refuses when an ancestor is a file`: `.claude` — файл — відмова `not-a-directory`; файл
    `.claude/skills` — так само.
  - `linkSpec`: `linux` → `{ type: "dir", target: "../../node_modules/…/a" }`;
    `win32` → `{ type: "junction", target: <абсолютний шлях targetDir> }`.
  - `sameDir`: `win32` — `C:\\P\\node_modules\\X\\skills\\a\\` і `c:\\p\\NODE_MODULES\\x\\skills\\a` → `true`;
    `linux` — різний регістр → `false`.
- [X] **Step 4: Перевірити, що тести падають** (`pnpm --filter @simetrajs/designer test init-skills`) — FAIL.
- [X] **Step 5: Реалізувати `init/types.ts`, `init/fs-probe.ts`, `init/skills.ts`.**
  Биті власні лінки — власні (класифікація за `readlink`, не за `stat`).
- [X] **Step 6: Тести зелені; `typecheck`, `lint` пакета.**
- [X] **Step 7: Коміт** `feat(designer): спільний резолв шляхів пакета й план лінків скілів`.

### Task 2: План MCP-конфігів агентів

**Files:**
- Create: `packages/designer/src/init/mcp-config.ts`
- Modify: `packages/designer/package.json`, `pnpm-lock.yaml` (`smol-toml`)
- Test: `packages/designer/src/__tests__/init-mcp-config.test.ts`

**Interfaces:**
- Consumes: типи з `init/types.ts`, `probe`, `posixRelative`, `DESIGNER_PACKAGE` (Task 1).
- Produces:
  - `AGENTS = ["claude", "codex", "cursor", "vscode"] as const`, `type Agent = (typeof AGENTS)[number]`
  - `DEFAULT_AGENTS: readonly Agent[] = ["claude"]`
  - `MCP_SERVER_NAME = "simetra"`
  - `mcpLaunch(root: string, pkgDir: string): Promise<{ command: "node"; args: [string, "mcp"] }>` —
    `args[0]` = `posixRelative(root, join(pkgDir, bin))`, `bin` — `bin.simetra`
    (або рядок `bin`) з `<pkgDir>/package.json`.
  - `matchesOwn(entry: unknown, expected: Record<string, unknown>): "match" | "own-differs" | "foreign"` — правило Рі-5.
  - `planMcpConfigs(root: string, agents: readonly Agent[], launch: { command: string; args: string[] }): Promise<InitPlan>`
  - Таблиця клієнтів (Рі-5, спека §4.2):

    | Агент | Файл | Контейнер | Очікуваний запис |
    | --- | --- | --- | --- |
    | `claude` | `.mcp.json` | `mcpServers` | `{ command, args }` |
    | `cursor` | `.cursor/mcp.json` | `mcpServers` | `{ type: "stdio", command, args: ["${workspaceFolder}/<bin>", "mcp", "${workspaceFolder}/<dir>"] }` (`<dir>` — з `DEFAULT_DIR`) |
    | `vscode` | `.vscode/mcp.json` | `servers` | `{ type: "stdio", command, args, cwd: "${workspaceFolder}" }` |
    | `codex` | `.codex/config.toml` | `[mcp_servers.simetra]` | `command = "node"` / `args = ["<bin>", "mcp"]` |

    Форми VS Code і Cursor звірено через context7 до реалізації (Рі-5).

- [X] **Step 1: Тести** (кожен — на тимчасовому корені з пакетом-фікстурою, чий
  `package.json` має `"bin": { "simetra": "./dist/main.js" }`):
  - `derives the launcher from the installed manifest`: `mcpLaunch` →
    `{ command: "node", args: ["node_modules/@simetrajs/designer/dist/main.js", "mcp"] }`;
    hoisted-фікстура — `"../node_modules/…"`.
  - `round trip is empty for every client` (table-driven за чотирма агентами):
    перший план для порожнього кореня дає одну дію `write` з `creates: true`;
    `content` записується на диск; повторний план — ні дій, ні приміток. Для JSON
    додатково — `JSON.parse(content)` у контейнері має очікуваний запис з таблиці.
  - `keeps foreign servers and keys`: `.mcp.json` з `{"mcpServers":{"other":{"command":"x"}},"extra":1}` —
    `other` і `extra` у `content` збережено, `simetra` додано.
  - `keeps extra args and keys of an own entry`: власний запис з `args: [<bin>, "mcp", "--read-only"]` і `env: { X: "1" }` — ні дії, ні примітки.
  - `restores required keys of an own entry`: `vscode`, власний запис без `cwd`, з `env` і `--read-only` — дія `write`; у `content` є `cwd: "${workspaceFolder}"`, `env` і `--read-only` збережено. `cursor`, власний запис без теки (`args: ["${workspaceFolder}/<bin>", "mcp", "--read-only"]`) — `args === ["${workspaceFolder}/<bin>", "mcp", "${workspaceFolder}/metadata", "--read-only"]`. `content` записується на диск, повторний план — ні дій, ні приміток.
  - `restores mcp as the second arg`: власний запис `args: [<bin>, "bogus", "--read-only"]` — дія `write`, `args === [<bin>, "mcp", "--read-only"]`; повторний план порожній.
  - `cursor dir comes from DEFAULT_DIR`: третій елемент очікуваного запису Cursor дорівнює `${workspaceFolder}/` + `DEFAULT_DIR` без `./` (тест імпортує константу, не літерал); власний запис Cursor з нестандартною текою `${workspaceFolder}/meta/app` — без дії, тека збережена.
  - `matchesOwn` (table-driven): збіг / `own-differs` (інший `args[0]`, `args[1]` не `"mcp"`, брак `type` для vscode) / `foreign` (`command: "npx"`, `args[0]` поза пакетом).
  - `updates the bin path of an own entry` (table-driven: `claude`, `cursor`, `vscode`): власний запис з
    `args: ["node_modules/@simetrajs/designer/old/main.js", "mcp", "--read-only"]` — дія
    `write`, у `content` `args === [<bin>, "mcp", "--read-only"]` і обов'язкові ключі клієнта;
    `content` записується на диск, повторний план — ні дій, ні приміток.
  - `leaves a foreign simetra entry alone`: `{"command":"npx","args":["simetra","mcp"]}` — ні дії, примітка `foreign-mcp-entry`.
  - `refuses JSON with comments`: `.vscode/mcp.json` з `// note` — відмова `invalid-json`.
  - `refuses a non-object root or container`: `[]` → `not-an-object`; `{"mcpServers":[]}` → `servers-not-an-object`.
  - `refuses a config path that is a directory`: тека `.mcp.json` — відмова `not-a-file`; файл `.vscode` → `not-a-directory`.
  - `appends to an existing codex config`: TOML `model = "x"` без кінцевого `\n` —
    `content === 'model = "x"\n\n[mcp_servers.simetra]\n…'`; з кінцевим `\n` — один порожній рядок;
    коментарі файлу збережено побайтово.
  - `finds the codex entry in any form` (table-driven): `[mcp_servers."simetra"]`, inline-таблиця
    `mcp_servers = { simetra = { command = "node", args = ["<bin>", "mcp"] } }`, dotted keys — збіг, без дії;
    з `command = "npx"` — примітка `foreign-mcp-entry`.
  - `refuses invalid toml`: `[mcp_servers` — відмова `invalid-toml`.
  - `keeps extra args of an own codex entry`: блок з `args = ["<bin>", "mcp", "--read-only"]` — без дії.
  - `fixes the bin of an own codex entry`: блок з `args = ["node_modules/@simetrajs/designer/old/main.js", "mcp", "--read-only"]  # mine` і коментарем вище —
    дія `write`, змінено лише рядок `args` (`--read-only` збережено), решта файлу побайтово та сама;
    `content` записується на диск, повторний план — ні дій, ні приміток.
  - `refuses to fix an own codex entry it cannot locate`: власний запис з іншим `args[0]` у inline-таблиці чи з
    багаторядковим `args` — відмова `ambiguous-toml`.
  - `writes only the selected agents`: `["claude"]` — дія лише для `.mcp.json`.
- [X] **Step 2: Тести падають** (`pnpm --filter @simetrajs/designer test init-mcp-config`).
- [X] **Step 3: Додати `smol-toml` 1.9.1 у `dependencies` designer (`pnpm --filter @simetrajs/designer add smol-toml@1.9.1 --save-exact`); реалізувати `mcpLaunch`, `matchesOwn` і `planMcpConfigs`** (Рі-5, Рі-6, Рі-9).
- [X] **Step 4: Тести зелені; `typecheck`, `lint`.**
- [X] **Step 5: Коміт** `feat(designer): план MCP-конфігів агентів для init`.

### Task 3: Команда `simetra init`

**Files:**
- Create: `packages/designer/src/init/plan.ts`
- Create: `packages/designer/src/commands/init.ts`
- Modify: `packages/designer/src/main.ts` (один рядок `init` у `subCommands`)
- Test: `packages/designer/src/__tests__/init.test.ts`
- Test: `packages/designer/src/__tests__/bin.test.ts` (доповнити)

**Interfaces:**
- Consumes: `installedPackageDir`, `planSkillLinks`, `DESIGNER_PACKAGE`,
  `mcpLaunch`, `planMcpConfigs`, `AGENTS`, `DEFAULT_AGENTS` (Task 1–2);
  `RunResult` з `src/cli/command.ts` (лише тип).
- Produces:
  - `planInit(root: string, agents: readonly Agent[], platform: NodeJS.Platform): Promise<InitPlan>` —
    злиття двох планів; відсутній пакет — `UsageError` з `installedPackageDir`.
  - `applyInit(plan: InitPlan): Promise<void>` — `link`/`write` з `replaces` спершу
    `unlink`; `mkdir -p` батьківських тек; `symlink(target, path, type)`; `writeFile`.
  - `runInit(args: Record<string, unknown>, cwd: string, platform?: NodeJS.Platform): Promise<RunResult>` —
    приймає розібрані citty-аргументи як є (Рі-12 перевіряє ключі; citty 0.2.2 додає camelCase-аліаси — `--dry-run` дає `dry-run` і `dryRun`); не викликає `process.exit`.
  - citty-команда `init` з `--agents` (рядок через кому), `--dry-run`, `--check`.

- [X] **Step 1: Тести `init.test.ts`** (через `runInit` на тимчасовому корені з пакетом-фікстурою):
  - `init creates links and the default config`: код 0; `readFile(".claude/skills/a/SKILL.md")`
    крізь лінк читається; є `.mcp.json`, немає `.vscode/`, `.cursor/`, `.codex/`;
    stdout містить `--read-only` і `compile --all --staged`.
  - `second init changes nothing`: перед другим запуском `utimes` усіх створених
    файлів у `0`; другий запуск — код 0, stdout каже, що змін немає; `mtimeMs === 0`
    у `.mcp.json`, `lstat` лінків незмінний (`ino`).
  - `--check is green after init and red on drift`: після `init` — 0; після
    видалення одного лінка — 1, stdout називає шлях; нічого не створено.
  - `--check is red when a selected config lacks the entry`: `init`, потім `--check --agents claude,cursor` — 1.
  - `--check with a refusal exits 2`: `.mcp.json` з коментарем — `--check` дає 2.
  - `--dry-run writes nothing`: код 0, план надруковано, `.claude`, `.agents`, `.mcp.json` не існують.
  - `refuses and writes nothing`: `.vscode/mcp.json` з коментарем, `--agents claude,vscode` —
    код 2, stderr називає файл, лінків і `.mcp.json` немає.
  - `aliased skill dirs init cleanly`: `.claude/skills → ../.agents/skills`, а `.agents/skills` ще не існує — код 0,
    `SKILL.md` читається крізь обидві теки, другий `init` без змін.
  - `fails outside a project`: без `node_modules/@simetrajs/designer` — код 2, stderr
    містить `@simetrajs/designer is not installed`, нічого не створено.
  - `rejects bad arguments before looking for the package` (table-driven, корінь без
    пакета): `--agents claude,emacs`, `--agents ""`, `--agent codex`, позиційний
    `extra`, `--check --dry-run` — код 2, stderr називає саме поганий аргумент
    (а не `not installed`).
  - `removes an own orphan link on disk`: власний лінк `.claude/skills/old` (скіла `old` у пакеті немає) — після `init` його немає (`lstat` → `ENOENT`), `--check` — 0.
  - `does not touch AGENTS.md or CLAUDE.md`: наявні файли побайтово незмінні після `init`.
- [X] **Step 2: Тести падають** (`pnpm --filter @simetrajs/designer test init.test`).
- [X] **Step 3: Реалізувати `plan.ts`, `commands/init.ts`, рядок у `main.ts`.**
  Рендер: одна дія — один рядок з відносним шляхом (`link .claude/skills/a -> ../../node_modules/…`,
  `remove …`, `write .mcp.json`, `note: …`); відмови — у stderr (`error: <path>: <reason>`).
  `--check`: відмови — 2; порожній список дій — 0; інакше 1 з переліком розбіжностей.
- [X] **Step 4: Тести `bin.test.ts`** через `bin/simetra.mjs`: `init --agents bogus` —
  код 2 і stderr містить `bogus`; `init --check` у тимчасовому корені з пакетом-фікстурою
  без лінків — код 1 (проброс `RunResult.exitCode`); `--help` перелічує `init`.
- [X] **Step 5: Тести зелені; `typecheck`, `lint`.**
- [X] **Step 6: Коміт** `feat(designer): команда simetra init`.

### Task 4: Гейт пакування

**Files:**
- Modify: `packages/designer/test/packaging/support.ts`
- Modify: `packages/designer/test/packaging/published-packages.pack.test.ts`

**Interfaces:**
- Consumes: наявні `packWorkspace`, `installConsumer`, `exec`, `REPO`.
- Produces (`support.ts`):
  - `installConsumer(tarballs: string[], manager?: "npm" | "pnpm"): Promise<string>` —
    `pnpm`: той самий маніфест без поля `overrides` плюс `pnpm-workspace.yaml` у корені споживача з `overrides:\n  simetra: "file:<tarball simetra>"` (pnpm 11 поле `pnpm` у `package.json` не читає; `$`-посилання pnpm 11.28 вважає застарілим), `pnpm install`.
  - `repackWithVersion(tarball: string, version: string, edit: (dir: string) => Promise<void>): Promise<string>` —
    розпакувати tarball у tmp, змінити `version` маніфесту, застосувати `edit`,
    запакувати назад (`tar -czf`, корінь `package/`).

- [X] **Step 1: Тести в `describe("@simetrajs/designer")`** (npm-споживач; стан спільний,
  тести в файлі йдуть послідовно в цьому порядку):
  - `init links the skills and writes MCP configs`: `init --agents claude,codex,cursor,vscode` —
    код 0; для кожного скіла з tarball і кожної з двох тек `readlink` дорівнює
    `../../node_modules/@simetrajs/designer/skills/<n>`, `SKILL.md` читається крізь лінк;
    чотири конфіги існують.
  - `init --check is green and a second init changes nothing`: `--check` з тими самими
    `--agents` — код 0; повторний `init` — вміст усіх чотирьох конфігів побайтово незмінний.
  - `the configured MCP server starts`: `command`/`args` з `.mcp.json` →
    `mcpServers.simetra`, `StdioClientTransport` з `cwd: consumer` — `listTools()` містить `compile`.
  - `a package update flows through the links`: `repackWithVersion(designer, "<v>-update.0", …)`
    дописує рядок-маркер у `skills/simetra-metadata/SKILL.md`; `npm install <новий tarball>` —
    `readlink` лінків той самий, маркер читається крізь лінк, `--check` — 0.
- [X] **Step 2: Окремий `describe("@simetrajs/designer under pnpm")`**: `installConsumer(…, "pnpm")`;
  `node_modules/.pnpm` містить запис `simetra@file+…`, а не `simetra@<версія з реєстру>` (інакше
  designer з tarball-а біг би проти опублікованого `simetra`); `init` — код 0; `readlink` `.claude/skills/simetra-metadata` дорівнює
  `../../node_modules/@simetrajs/designer/skills/simetra-metadata` (не `.pnpm`);
  `SKILL.md` читається крізь лінк; сервер з `.mcp.json` стартує й віддає `compile`.
- [X] **Step 3: Прогін:** `pnpm build:packages && pnpm test:packaging` — PASS
  (для налагодження — локально; зарахований прогін — разом з повними гейтами).
- [X] **Step 4: Коміт** `test(designer): гейт пакування для simetra init`.

### Task 5: Скіл, README і канон

**Files:**
- Modify: `packages/designer/README.md`
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` (новий розділ у кінці)
- Modify: `packages/designer/src/__tests__/skill-examples.test.ts` (`known` + `"init"`)
- Modify: `docs/superpowers/specs/2026-10-02-simetra-designer-design.md` (§3.1, §4.2, §5.1)
- Modify: `docs/architecture/designer.md` (§ «Проєкт споживача»)
- Modify: `docs/architecture/release.md` (перелік перевірок гейту)
- Modify: `docs/ROADMAP.md` (рядок «П0 (а) і доставка пакета»)

- [X] **Step 1: README** (англійською): розділ «Start a project» —
  `pnpm add simetra`, `pnpm add -D @simetrajs/designer`,
  `pnpm exec simetra init [--agents claude,codex,cursor,vscode]`; що створює `init`;
  лінки й конфіги комітяться, CI — `simetra init --check` з тими ж `--agents`;
  `--read-only` дописується в `args` вручну; конфіг Codex діє лише в довіреному
  проєкті; у монорепо `init` запускається в корені, з якого стартує агент, —
  там, де лежить тека `metadata`; на Windows без `core.symlinks` git розгортає
  лінки файлами — `init` замінює їх junction-ами. Розділ «Agent skills» — згадка,
  що `init` їх підключає.
- [X] **Step 2: Скіл `simetra-metadata`**: короткий розділ «Project setup» у кінці
  файлу — `init`, `init --check` у CI, оновлення пакета не потребує повторного
  `init`, крім появи нового скіла чи агента (це ловить `--check`). Наявних рядків
  не міняти (A4). У sh-блоках — лише форми `pnpm exec simetra …` / `npx simetra …`
  (їх розбирає тест прикладів). Додати `"init"` у `known` тесту прикладів.
- [X] **Step 3: Спека designer** — правки з колонки «Вплив на спеку» Рі-1…Рі-5.
- [X] **Step 4: `docs/architecture/designer.md`** — рядок «Стан»: `simetra init` у коді;
  пілот із host — разом із рештою доставки. Речення «симлінки підхоплюють новий
  скіл самі» → «симлінки підхоплюють новий вміст скілів самі; новий скіл
  додає повторний `init`, розбіжність ловить `init --check` у CI».
  **`release.md`** — у переліку гейту додати `init` (лінки, `--check`, повторний
  запуск, оновлення пакета крізь лінки, MCP з конфігу, pnpm-споживач).
- [X] **Step 5: ROADMAP** — у рядку «П0 (а) і доставка пакета», колонка стану:
  «спайк П0 (а) виконано ([звіт](…)); `simetra init` виконано; решта доставки — не розпочато».
- [X] **Step 6: Перевірки:** `pnpm --filter @simetrajs/designer test skill-examples`,
  `python3 scripts/check-doc-anchors.py`, `pnpm format:check`.
- [X] **Step 7: Коміт** `docs(designer): simetra init у README, скілі й каноні`.

## Критерії приймання

- Усі тести Task 1–4 зелені; кожен інваріант (чужа тека, чужий симлінк, чужий
  запис MCP, додаткові `args` власного запису, `--check` на розсинхроні, відмова
  без часткового запису, аліас тек скілів, ідемпотентність, суворі аргументи) має
  тест, що червоніє від мутації відповідного рядка коду.
- `schemaPathResolver`, лінки скілів і шлях bin у MCP-конфігах використовують одні
  й ті самі `installedPackageDir` і `posixRelative`.
- `src/tools/*`, `src/mcp/*`, `src/cli/command.ts`, версії пакетів не змінені.
- Повні гейти й гейт пакування — зелені на одному SHA.
