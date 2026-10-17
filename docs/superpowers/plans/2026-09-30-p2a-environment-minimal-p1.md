# П2, план A — середовище й мінімальний П1: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** піднята локальна БД-база провайдера (стек Supabase CLI) у dev і CI, а
репо зведено до флагманського пакета `simetra` з ярусами під лінт-зонами, де
T0 `model` — перенесений `packages/core`. Прототип без майбутнього заморожено в
`legacy/`, прототипний рантайм видалено.

**Архітектура:** крок 0 спеки П2 (§11) — стек Supabase CLI, закріплений як
devDependency кореня, з pgTAP-тестом базового стану провайдера, окрема CI-джоба
`db`. Крок 1 — три послідовні зміни, кожна з зеленими гейтами: спершу
заморожування й видалення (у core не лишається споживачів), потім перенесення
core в `packages/simetra/src/model` з теками всіх ярусів, потім лінт-зони
ярусів із негативним тестом через ESLint API.

**Технології:** pnpm 11 workspace, turbo, Supabase CLI 2.118.0 (npm-пакет
`supabase`), pgTAP (`supabase test db`), ESLint 10 flat config
(`no-restricted-imports` з `regex`-патернами), Vitest 5, TypeScript 7 (native).

**Спека:** [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md) —
§10.4, §11 кроки 0–1, М7–М9; [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
— §1 (Postgres 17), §3.1 (яруси, межа з фреймворками), §6.2 (тінь), §14 (доля
прототипу).

**Серія планів П2.** План A (цей, кроки 0–1) → B (кроки 2–4: ідентичність і
файли, `CustomTable` і типи, реєстр видів, каркас компілятора T1) → C (кроки
5–6: скоуп; документ, проведення, регістри) → D (крок 7: компілятор, CLI, MCP,
pre-commit) → E (кроки 8–9: `SchemaEngine`, рендер, тінь, round-trip, домен,
паперовий тест). Кожен наступний план пишеться після приземлення попереднього,
під реальний код.

## Global Constraints

- Node `24.15.0` (`.node-version`), pnpm `11.4.0` (`packageManager`) — не змінювати.
- Postgres мажорної версії **17** у локальному стеку й CI (платформна спека §1).
- Supabase CLI — npm-пакет `supabase`, версія **`2.118.0`** точно, без каретки
  ([карта перевикористання](../../research/stack/reuse-map-2026-09.md), рядок «Тіньова база»).
- `supabase/config.toml` — без секретів; `project_id = "simetra"`.
- Імпорт між ярусами — лише вниз: T0 `model` < T1 `compiler` < T2 `schema` <
  T3 `server` < T4 `data` < T5 `ui` < T6 `shell` (платформна спека §3.1).
- Коментарі в коді — українською й пояснюють **чому**; тексти лінт-повідомлень,
  `README` і харнес (`AGENTS.md`, скіли) — англійською (`AGENTS.md` § «Language policy»).
- Без шимів сумісності: жодних аліасів чи ре-експортів `@simetra/core` після
  переносу (`AGENTS.md` принцип 5).
- Код у `legacy/` лише переноситься — не редагується, не збирається, не
  тестується (М8).
- Коміти — Conventional Commits з українським описом, **без жодних трейлерів**
  (`Co-Authored-By`, «Generated with» тощо).
- Без `--` перед vitest-патерном у `pnpm --filter`.
- Після кожної правки документів, скілів чи переносу файлів —
  `python3 scripts/check-doc-anchors.py` чистий.
- Гейти після кожної задачі: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.

## Review Focus

1. **Відносний крос-ярусний імпорт** із вкладеної теки чи через корінь пакета
   (`../../../compiler`, `../../src/compiler`, `./../compiler`) — зона мусить
   ловити кожне написання, а не лише bare `simetra/<ярус>`. Тест — задача 4.
2. **`import type`, `export … from`, `export * from`** на вищий ярус — теж
   порушення, а не лише value-import. Тест — задача 4.
3. **Зона, що мовчки відвалилась** (одруківка в глобі, файл, з'їдений
   `ignores`, файл `.tsx`) дає зелений лінт і нічого не доводить. Тест
   `isPathIgnored` і `.tsx`-кейс — задача 4.
4. **Заморожений код, що повертається в гейти** (glob workspace чи
   `prettier --check .` бачать `legacy/`). Перевірка складу workspace і
   `format:check` — задача 2.
5. **Стек не тієї версії чи без базового стану провайдера** (не 17, немає
   `auth.users`, ролей `anon`/`authenticated`/`service_role`), або DB-тести
   тихо «проходять» без бази. pgTAP-тест і прогін без стеку — задача 1.

---

### Task 1: Локальний стек Supabase і CI-джоба з тестом базового стану провайдера (крок 0)

**Files:**
- Modify: `package.json` (devDependency `supabase`, скрипти `db:start`, `db:stop`, `test:db`)
- Modify: `pnpm-workspace.yaml` (лише якщо pnpm вимагає дозволу build-скрипта `supabase`)
- Create: `supabase/config.toml` (через `supabase init`, потім правки), `supabase/.gitignore` (створює `init`)
- Create: `supabase/tests/provider-base-state.test.sql`
- Modify: `.github/workflows/ci.yml` (нова джоба `db`)
- Modify: `scripts/check-doc-anchors.py` (`REPO_ROOTS` + `"supabase"`)
- Modify: `AGENTS.md` § «Commands and gates»

**Interfaces:**
- Produces: `pnpm db:start` / `pnpm db:stop` / `pnpm test:db` у корені;
  стек з `project_id = "simetra"`, БД на `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
  (дефолтні порти CLI); контейнер БД `supabase_db_simetra`; CI-джоба `db`.
  Плани B–E додають власні DB-тести до `test:db`.

- [ ] **Step 1: Закріпити Supabase CLI**

Додай у `devDependencies` кореневого `package.json` `"supabase": "2.118.0"`,
запусти `pnpm install`. Якщо pnpm повідомляє про проігнорований build-скрипт
`supabase`, додай у `allowBuilds` у `pnpm-workspace.yaml` рядок
`supabase: true` з коментарем-причиною (пакет ставить нативний бінарник CLI).

Run: `pnpm exec supabase --version`
Expected: `2.118.0`

- [ ] **Step 2: Прибрати чужий стек зі стандартних портів**

Власник у сесії планування 2026-09-30 дозволив зупинити й **видалити** стек
іншого проєкту (`project_id` `slctbhbsdxaibubqvljz`, порти 54321/54322/54324,
спека П2 §10.4). Команда незворотна (видаляє томи з даними): перед запуском
покажи її власнику й дочекайся підтвердження.

Run: `pnpm exec supabase stop --project-id slctbhbsdxaibubqvljz --no-backup`
Потім: `docker ps -a --filter label=com.supabase.cli.project=slctbhbsdxaibubqvljz -q; docker volume ls --filter label=com.supabase.cli.project=slctbhbsdxaibubqvljz -q; ss -ltn | grep -E ':5432[0-4]\b'`
Expected: усі три виводи порожні. Інших контейнерів (`simplycms-review-pg` тощо) не чіпати.

- [ ] **Step 3: Створити конфіг стеку**

Run: `pnpm exec supabase init` (неінтерактивно; VS Code / IntelliJ-налаштувань не генерувати).

У `supabase/config.toml` задай:
- `project_id = "simetra"`;
- `[db] major_version = 17`;
- `[db.migrations] enabled = false` і `[db.seed] enabled = false` — схемою
  керує рушій Simetra, а не міграції CLI;
- `enabled = false` для `[api]`, `[studio]`, `[inbucket]`, `[analytics]`,
  `[edge_runtime]` — DB-тестам вони не потрібні;
- `[auth]`, `[storage]`, `[realtime]` лишити ввімкненими: вони створюють схеми
  `auth`, `storage`, `realtime`, тобто базовий стан провайдера (спека П2 §9,
  §10.4).
Над кожною зміненою секцією — однорядковий український коментар «чому».

- [ ] **Step 4: Додати скрипти в кореневий `package.json`**

`"db:start": "supabase start"`, `"db:stop": "supabase stop"`,
`"test:db": "supabase test db"`.

- [ ] **Step 5: Написати тест базового стану провайдера**

`supabase/tests/provider-base-state.test.sql`, дослівно (коментарі — українською, «чому»):

```sql
-- Базовий стан провайдера — передумова round-trip і паперового тесту
-- (спека П2 §9, §10.4): без auth.users і ролей провайдера тінь не розгорне
-- FK на auth.users і політики на об'єктах провайдера.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

select ok(current_setting('server_version_num')::int / 10000 = 17,
  'Postgres major version is 17');
select has_schema('auth');
select has_schema('storage');
select has_schema('realtime');
select has_schema('extensions');
select has_table('auth', 'users', 'auth.users exists');
select has_role('anon');
select has_role('authenticated');
select has_role('service_role');

select * from finish();
rollback;
```

- [ ] **Step 6: Прогнати тест без стеку — має впасти**

Run: `pnpm test:db; echo "exit=$?"`
Expected: помилка з'єднання з БД, `exit=1` (не 0). Так відсутність бази — червоне, а не пропуск (спека П2 §10.4).

- [ ] **Step 7: Підняти стек і прогнати тест**

Run: `pnpm db:start && pnpm test:db`
Expected: `supabase_db_simetra` слухає 54322; pg_prove звітує `All tests successful`, 9 тестів.
Якщо падає `has_schema('realtime')` чи `has_schema('storage')`, з'ясуй, яка служба стеку створює цю схему, і ввімкни її. Тест не послаблюй — повідом власника.

- [ ] **Step 8: Додати CI-джобу `db`**

У `.github/workflows/ci.yml` додай другу джобу `db` (`name: Database`,
`runs-on: ubuntu-latest`, `timeout-minutes: 20`). Кроки checkout / pnpm /
setup-node / `pnpm install --frozen-lockfile` — ті самі, що в `checks`, з тими
самими SHA-пінами. Далі `pnpm db:start` і `pnpm test:db`. Над джобою — коментар:
DB-тести йдуть проти того самого стеку й образу провайдера, що в dev.

- [ ] **Step 9: Синхронізувати харнес**

- `scripts/check-doc-anchors.py`: додай `"supabase"` у `REPO_ROOTS`, щоб шляхи
  `supabase/...` у доках перевірялись.
- `AGENTS.md` § «Commands and gates»: у блок команд додай `pnpm db:start`,
  `pnpm test:db`, `pnpm db:stop` з коментарем (local Supabase stack, needs
  Docker; provider base-state pgTAP tests). Рядок про CI зміни так: CI запускає
  чотири гейти плюс джобу `db`, яка піднімає стек і запускає `pnpm test:db`.
  Додай правило: стек запускається лише через `pnpm db:*` (закріплена версія
  CLI), а не глобальним `supabase`.

Run: `python3 scripts/check-doc-anchors.py && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: усе зелене.

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml supabase .github/workflows/ci.yml scripts/check-doc-anchors.py AGENTS.md
git commit -m "build(db): локальний стек Supabase і CI-джоба з тестом базового стану провайдера"
```

CI-джобу `db` перевіряє перший push гілки. Push робиться лише на прохання власника; до того в звіті зазнач, що джоба ще не проганялась.

---

### Task 2: Заморозити прототип у `legacy/`, видалити прототипний рантайм (крок 1а)

**Files:**
- Move: `apps/web` → `legacy/web`; `packages/cli` → `legacy/cli`;
  `packages/generator-pg` → `legacy/generator-pg`; `packages/generator-api` →
  `legacy/generator-api`; `packages/ui` → `legacy/ui`
- Create: `legacy/README.md`
- Delete: `packages/app-runtime`, `packages/data-provider`,
  `packages/data-provider-postgrest`, `packages/form-runtime`, `apps/runtime`
- Delete: `.agents/skills/simetra-cli/`, симлінк `.claude/skills/simetra-cli`
- Modify: `pnpm-workspace.yaml`, `package.json`, `.prettierrc`, `.prettierignore`,
  `scripts/check-doc-anchors.py`, `AGENTS.md`,
  `.claude/commands/проведи-додаткове-дослідження.md`,
  `.agents/skills/code-review/references/simetra-domain-criteria.md`

**Interfaces:**
- Consumes: —
- Produces: workspace = корінь + `packages/*`, де лишився тільки
  `packages/core`. Заморожений референс лежить у `legacy/<ім'я>/` (у плані D
  там читатимуть логіку каскаду перейменування й генератора). Шлях
  `packages/cli` вільний для нового `@simetra/cli` (план D).

- [ ] **Step 1: Зафіксувати базову лінію тестів core**

Run: `pnpm --filter @simetra/core test`
Expected: PASS. Запиши число тестів N з рядка `Tests  N passed`. Задача 3 звіряє з ним.

- [ ] **Step 2: Перенести заморожені пакети й видалити рантайм**

`git mv` кожного з п'яти заморожених каталогів у `legacy/<ім'я>` (див. Files).
`git rm -r` для п'яти каталогів рантайму. Після цього `rm -rf` залишків, які git
не відстежує: `node_modules` у `legacy/*/`, самі видалені каталоги й порожній
`apps/`.

- [ ] **Step 3: Вивести заморожене з гейтів**

- `pnpm-workspace.yaml`: `packages: ["packages/*"]` (без `apps/*`).
- Кореневий `package.json`: прибери скрипти `simetra`, `dev:web`,
  `dev:runtime` і devDependency `prettier-plugin-tailwindcss`.
- `.prettierrc`: прибери `plugins`, `tailwindStylesheet`, `tailwindFunctions`.
  Tailwind у workspace більше немає; UI повертається в П4.
- `.prettierignore`: додай `legacy/` з коментарем (заморожений референс, М8).
- `legacy/README.md` (англійською, кілька рядків): що це заморожений прототип
  (платформна спека §14, спека П2 М8), лише для читання — не збирається, не
  тестується, не імпортується й не розширюється; нові реалізації живуть у
  `packages/`.
- Run: `pnpm install`. Якщо `msw` чи `esbuild` зникли з `pnpm-lock.yaml`
  (`grep -c` дає 0), прибери їхні рядки з `allowBuilds`.

Run: `pnpm ls -r --depth -1`
Expected: лише корінь і `@simetra/core`.

- [ ] **Step 4: Синхронізувати харнес і документацію**

- Скіл `simetra-cli` описує заморожений CLI, який більше не запускається, тож
  видали `.agents/skills/simetra-cli/`, симлінк `.claude/skills/simetra-cli` і
  його запис у блоці skill mappings `AGENTS.md`. Скіл нового CLI з'явиться в
  плані D.
- `.claude/commands/проведи-додаткове-дослідження.md`: прибери приклад
  `pnpm simetra …`.
- `AGENTS.md` § «Target architecture vs. the prototype», абзац «Current code is
  a prototype»: опиши новий стан — прототипна метамодель живе в workspace, а
  заморожений референс лежить у `legacy/` (читати можна, не збирати, не
  тестувати, не імпортувати й не розширювати). Пункт «Do not start the tier
  reorganisation…» заміни правилом: код із `legacy/` береться лише як
  референс для нової реалізації.
- `scripts/check-doc-anchors.py`: додай `"legacy"` у `REPO_ROOTS`.
- `simetra-domain-criteria.md`: вкажи для шляхів `packages/generator-pg/...`
  нове місце `legacy/generator-pg/...`.

Run: `python3 scripts/check-doc-anchors.py`
Expected: без помилок. Мертві шляхи, які він назве, виправ у живих доках. Датовані спеки й плани в `docs/superpowers/` не чіпай.

- [ ] **Step 5: Гейти**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: усе зелене; turbo запускає задачі лише для `@simetra/core`.

- [ ] **Step 6: Commit**

```bash
git add -A
git status --short   # переконайся, що жодного node_modules/, temp/ чи секретів
git commit -m "refactor(repo): заморозити прототип у legacy/ і видалити прототипний рантайм"
```

---

### Task 3: Флагманський пакет `simetra`, `packages/core` → ярус T0 `model` (крок 1б)

**Files:**
- Move: `packages/core/src` → `packages/simetra/src/model`
- Create: `packages/simetra/package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`
- Create: `packages/simetra/src/{compiler,schema,server,data,ui,shell}/index.ts`
- Delete: решта `packages/core/` (`package.json`, конфіги)
- Modify: кореневий `package.json` (`name`), `.prettierignore`, `AGENTS.md`,
  `docs/BRD.md`, `docs/ROADMAP.md`,
  `.agents/skills/code-review/references/simetra-domain-criteria.md`

**Interfaces:**
- Consumes: задача 2 (у core немає споживачів).
- Produces: пакет `simetra` (`packages/simetra`) з subpath-експортами
  `simetra/model`, `simetra/compiler`, `simetra/schema`, `simetra/server`,
  `simetra/data`, `simetra/ui`, `simetra/shell` → `./src/<ярус>/index.ts`.
  `simetra/model` експортує рівно те, що експортував `@simetra/core` (`.`).
  Окремого subpath `./model/schemas` немає: `model/index.ts` уже
  ре-експортує `./schemas`. Тести T0 лежать у `src/model/__tests__/`, конфіг
  ESLint — у `packages/simetra/eslint.config.js` (задача 4 додає в нього зони).

- [ ] **Step 1: Перейменувати кореневий пакет**

У кореневому `package.json` `"name": "simetra"` → `"simetra-monorepo"`. Причина:
turbo і pnpm вимагають унікальних імен у workspace, а ім'я `simetra` бере
флагманський пакет.

- [ ] **Step 2: Перенести код і створити пакет**

`git mv packages/core/src packages/simetra/src/model`. Конфіги пакета візьми з
`packages/core` з такими змінами:
- `package.json`: `"name": "simetra"`, решта полів і залежностей як у core.
  `exports` — сім subpath-ів з Interfaces, кореневого `"."` немає: споживач
  імпортує ярус, а не весь пакет.
- `tsconfig.json`: `include: ["src", "test"]`. `test/` з'явиться в задачі 4.
- `eslint.config.js`: `files: ["**/*.{ts,tsx}"]`.
- `vitest.config.ts`: як у core.
Потім `git rm` решти файлів `packages/core/` і `rm -rf packages/core`.

- [ ] **Step 3: Теки ярусів T1–T6**

Кожен `src/<ярус>/index.ts` містить однорядковий український коментар і
`export {}`. Коментар каже, що вміст ярусу з'являється в наступних кроках П2
чи підпроєктах (платформна спека §3.1), а тека й subpath існують від початку,
бо лінт-зони й експорти мають покривати кожен ярус.

- [ ] **Step 4: Прибрати слід `@simetra/core`**

- `.prettierignore`: шлях фікстур → `packages/simetra/src/model/__tests__/fixtures/`.
- `AGENTS.md`: заголовок `Metamodel rules (\`packages/core\`)` →
  `Metamodel rules (T0 \`packages/simetra/src/model\`)`. Формулювання
  «in `@simetra/core`», «Core has no runtime dependency…», «import … from core»
  переведи на T0 `simetra/model`. Шлях до `standard-attributes.ts` — новий.
  Абзац про прототип: прототипна метамодель тепер лежить у T0 і
  перебудовується на місці (спека П2 М9).
- `docs/BRD.md` (шлях до `schemas/`), `docs/ROADMAP.md` (рядок П2: замість
  шляху `packages/core` — «прототипна метамодель → ярус T0»),
  `simetra-domain-criteria.md`: шляхи й назва `@simetra/core` → нові.
- Run: `grep -rn "@simetra/core\|packages/core" --exclude-dir=node_modules --exclude-dir=legacy --exclude-dir=superpowers --exclude-dir=research . --include='*.md' --include='*.ts' --include='*.json' --include='*.js' --include='*.yaml' --exclude=pnpm-lock.yaml`
  Expected: порожньо.

- [ ] **Step 5: Встановити й перевірити**

Run: `pnpm install && pnpm ls -r --depth -1`
Expected: лише `simetra-monorepo` і `simetra`.

Run: `pnpm --filter simetra test`
Expected: PASS, рівно N тестів (базова лінія з задачі 2, крок 1).

Run: `python3 scripts/check-doc-anchors.py && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: усе зелене.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(simetra): флагманський пакет simetra з теками ярусів, packages/core → ярус T0 model"
```

---

### Task 4: Лінт-зони ярусів і межа з фреймворками з негативним тестом (крок 1в)

**Files:**
- Create: `packages/simetra/eslint.tier-zones.js`
- Modify: `packages/simetra/eslint.config.js`
- Test: `packages/simetra/test/tier-boundary.test.ts`
- Modify: `AGENTS.md` § «Target architecture vs. the prototype»
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes: пакет `simetra` і його `eslint.config.js` із задачі 3.
- Produces: `export const tierZoneConfigs` — масив flat-config об'єктів, по
  одному на ярус, `files: ["src/<ярус>/**/*.{ts,tsx}"]`, правило
  `no-restricted-imports` з `regex`-патернами. Кожна зміна таблиці ярусів — архітектурне рішення. Механізм і негативний тест
  повторюють еталон `simplyCMS: eslint.tier-zones.mjs`,
  `tests/tier-boundary.test.ts` (платформна спека §3.1), але реалізацію
  написано самостійно: код звідти не копіюється.

- [ ] **Step 1: Написати негативний тест**

`packages/simetra/test/tier-boundary.test.ts`. Таблицю ярусів тест тримає
**сам**, а не імпортує з конфігу: інакше ярус, що випав із конфігу, випав би й
з тесту.

```ts
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { describe, expect, it } from "vitest"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..")
const eslint = new ESLint({ cwd: PKG })
const TIERS = ["model", "compiler", "schema", "server", "data", "ui", "shell"]

async function restricted(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(PKG, file),
    warnIgnored: true,
  })
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message)
}
const importOf = (s: string) =>
  `import { probe } from "${s}"\nexport const used = probe\n`
```

Тести (`describe("tier zones")`), кожен із явним повідомленням в `expect`:

1. `rejects every higher tier, bare form` — для кожної пари `i < j`:
   `restricted(importOf(\`simetra/${TIERS[j]}\`), \`src/${TIERS[i]}/__fixture.ts\`)`
   має довжину 1, повідомлення містить `"Tier zone"`.
2. `rejects every higher tier, relative forms` — для кожної пари `i < j` окремо
   ловиться кожна з форм: `../${up}` і `../${up}/x` з
   `src/${tier}/__fixture.ts`; `../../../${up}` і `../../../../src/${up}` з
   `src/${tier}/a/b/__fixture.ts`; `./../${up}` з `src/${tier}/__fixture.ts`.
3. `allows lower tiers and own tier` — для `j < i` порожньо і
   `simetra/${TIERS[j]}`, і `../${TIERS[j]}/x`. У `src/model/a/__fixture.ts`
   порожньо для `../schemas/catalog`: ім'я `schemas` (реальна тека T0) не
   збігається з ярусом `schema`. Порожньо для `./local`.
4. `same imports outside tier folders are clean` — `simetra/shell` і
   `../src/shell` з `test/__fixture.ts` дають порожньо.
5. `type imports and re-exports are covered` — у `src/model/__fixture.ts` кожен
   із `import type { X } from "simetra/compiler"`, `export { X } from "../compiler"`,
   `export * from "../compiler"` дає рівно 1 повідомлення.
6. `tsx files are covered` — `importOf("simetra/shell")` у
   `src/ui/__fixture.tsx` дає 1 повідомлення.
7. `ui rejects router, host framework and data-engine libraries` — у
   `src/ui/__fixture.ts` кожен із `@tanstack/react-router`,
   `@tanstack/react-start/server`, `@tanstack/react-db`, `@tanstack/react-query`,
   `next/link`, `@supabase/supabase-js` дає 1 повідомлення з
   `"Framework boundary"`. Кожен із `react`, `react-dom/client`,
   `@tanstack/react-virtual`, `next-themes` — порожньо.
8. `framework libraries are legal in shell` — `@tanstack/react-router` у
   `src/shell/__fixture.ts` дає порожньо.
9. `no zone is ignored` — `await eslint.isPathIgnored(join(PKG, \`src/${t}/__fixture.ts\`))`
   дорівнює `false` для кожного ярусу `t`.

- [ ] **Step 2: Переконатися, що тест червоний**

Run: `pnpm --filter simetra test tier-boundary`
Expected: FAIL. Кейси 1, 2, 5, 6, 7 падають з `expected [] to have length 1`, а 3, 4, 8, 9 проходять.

- [ ] **Step 3: Реалізувати `packages/simetra/eslint.tier-zones.js`**

`no-restricted-imports` звіряє рядок специфікатора, а не резолвлений модуль.
Тому один regex на зону покриває і bare-субшлях, і будь-яку кількість `../`,
зокрема шлях через корінь пакета (`src/`):

```js
function tierPattern(tiers) {
  const alt = tiers.join("|")
  return `^(?:simetra/(?:${alt})|(?:\\./)?(?:\\.\\./)+(?:src/)?(?:${alt}))(?:/|$)`
}
```

Регулярний вираз межі з фреймворками для `src/ui` (роутер, host-фреймворк,
бібліотеки рушія даних — платформна спека §3.1, Р16):

```js
const FRAMEWORK_PATTERN =
  "^(?:@tanstack/(?:react-)?(?:router|start|db|query)(?:[-/].*)?|react-router(?:[-/].*)?|next(?:/.*)?|@supabase/.*)$"
```

- Таблиця `TIERS` — сім імен у порядку ярусів. Для ярусу `i` заборонено всі
  яруси з індексом `> i`. У `shell` порожня заборона, тож блок без патернів не
  створюється.
- Зона `ui` має в одному правилі дві групи: ярусну й `FRAMEWORK_PATTERN`. Flat
  config замінює опції правила цілком, тож окремий блок затер би ярусну групу.
- Повідомлення англійською. Ярусне починається з
  `Tier zone: src/<tier> is T<n>; import only lower tiers (platform spec §3.1).`
  і додає, що підняти імпорт угору — архітектурне рішення зі зміною таблиці в
  `eslint.tier-zones.js`. Фреймворкове починається з
  `Framework boundary: T5 ui imports only React, T4 contracts and the navigation adapter interface (platform spec §3.1).`
- Коментар над модулем: динамічний `import()` правило не бачить. Це межа
  механізму, а не дірка, яку треба закривати переліком.

У `packages/simetra/eslint.config.js` допиши `...tierZoneConfigs` після
базового блоку.

- [ ] **Step 4: Переконатися, що тест зелений**

Run: `pnpm --filter simetra test tier-boundary`
Expected: PASS, 9 тестів.

- [ ] **Step 5: Синхронізувати канон і статус**

- `AGENTS.md`: до абзаців «Target» і «Framework boundary» додай речення, що
  обидві межі тримає `packages/simetra/eslint.tier-zones.js` з негативним
  тестом `packages/simetra/test/tier-boundary.test.ts`, а зміна таблиці
  ярусів — рішення власника.
- `docs/ROADMAP.md`: у колонку «Документи» рядка П2 додай посилання на цей
  план. Рядок «Зараз» зміни на: план A (середовище й мінімальний П1)
  виконано, далі план B.

Run: `python3 scripts/check-doc-anchors.py && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm test:db`
Expected: усе зелене.

- [ ] **Step 6: Commit**

```bash
git add packages/simetra AGENTS.md docs/ROADMAP.md
git commit -m "feat(simetra): лінт-зони ярусів і межа з фреймворками з негативним тестом"
```

---

## Критерії приймання плану A

- `pnpm db:start && pnpm test:db` — 9 pgTAP-тестів зелені на Postgres 17. Без
  стеку `pnpm test:db` падає ненульовим кодом.
- `.github/workflows/ci.yml` має джоби `checks` (чотири гейти) і `db` (стек +
  `pnpm test:db`).
- `pnpm ls -r --depth -1` показує лише `simetra-monorepo` і `simetra`. У
  `packages/` лежить тільки `simetra`, `apps/` немає, заморожене лежить у
  `legacy/`, прототипного рантайму немає.
- Тести T0 після переносу — рівно N, як у базовій лінії.
- Негативний тест лінт-зон зелений. Порушення ярусу чи межі з фреймворками
  дає червоний `pnpm lint`.
- `python3 scripts/check-doc-anchors.py` чистий. У живих доках немає згадок
  `@simetra/core`, `packages/core` чи `simetra-cli`.
