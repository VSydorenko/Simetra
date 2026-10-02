#!/usr/bin/env python3
"""Гард якорів документації і канону скілів.

Перевіряє, що кожен якір, названий у каноні, справді існує:
  1. шлях репо (`apps/…`, `packages/…`, `docs/…`, `.agents/…`, `.claude/…`,
     `scripts/…`) — у беквотах або як ціль маркдаун-лінка;
  2. маркдаун-лінк на сусідній док (`[X](Y.md)`), зокрема відносний;
  3. вказівник на розділ за назвою — `док § «Розділ»`, `док § "Section"`,
     `skill `x` § "Section"` — розділ шукається серед ЗАГОЛОВКІВ цільового
     файла, а не будь-де в тексті;
  3b. вказівник на розділ за номером — `док.md §14`, `док.md` § 3.2 — лише коли
     ім'я дока стоїть ВПРИТУЛ перед `§`: номер без явного дока (`спека §14`)
     не резолвиться ні в що певне, і вгадування давало б хибне червоне.

І що корпус не відтворює те, що канон уже заборонив:
  4. дослівний блок рядків-тверджень, який лежить у двох файлах корпусу, —
     копія моделі (правило «один факт — один док»);
  5. `SKILL.md` довший за ліміт канону скілів;
  6. reference довший за ліміт — без «Змісту»/«Contents»: навігація всередині
     файла зникає;
  7. вказівник з одного reference в інший — другий рівень від `SKILL.md`,
     хоч би якою формою записаний: і шляхом `references/<файл>.md`, і голим
     `<файл>.md`;
  8. якір `шлях:НОМЕР` — номери рядків канон забороняє: вони мовчки зсуваються
     від першого ж рефакторингу.

Чому саме так: канон велить посилатись на файл і розділ, а не копіювати код.
Це працює, лише поки вказівник живий. Мертвий шлях у доці не бачить ні
typecheck, ні lint, ні тести — його бачить тільки цей гард. Перевірки 4-8 — та
сама логіка, застосована не до якоря, а до форми самого корпусу: прибирання
дублів і лімітів без гарда живе рівно до наступного скіла, який хтось напише.

Корпус — лише жива документація: AGENTS.md, CLAUDE.md, README.md, `docs/**`,
`.agents/skills/**`, `.claude/**`. Поза ним свідомо:
  - `docs/research/**` — сторонні дослідження: чужий текст, його якорі не наші;
  - `docs/superpowers/**` — датовані спеки й плани: це запис рішення на момент
    ухвалення, а не опис поточного стану; переписувати їх під код, що змінився
    пізніше, означало б фальсифікувати історію. Посилатися НА них можна —
    шляхи й розділи в них гард звіряє як ціль.
Файли беруться з git (відстежувані + нові не ігноровані): так у корпус не
потрапляють `node_modules`, `.claude/worktrees/` і вміст симлінків
`.claude/skills/*` — останні інакше дали б кожен скіл двічі і хибні «копії
моделі» самого себе.

🔴 Межі. Перевірка, чию межу не видно, читається ширше, ніж вона є, — тому межа
кожної записана тут, поруч із самою перевіркою:
  1-3. гард бачить ШЛЯХИ і РОЗДІЛИ, не символи. Посилання на живий файл із
       мертвим експортом усередині — зелене. Символи ловить лише рев'ю
       (лінза drift скіла code-review).
  4.   ловить ДОСЛІВНУ копію. Переказ тієї самої моделі іншими словами не
       ловиться нічим, крім рев'ю.
  5-6. ліміт — це кількість РЯДКІВ, а не насиченість: скіл із 490 рядків води
       зелений.
  7.   межа — РОЗТАШУВАННЯ вказівника, а не форма запису. У `references/**`
       посилання на сусідній reference заборонене будь-якою формою; у
       `SKILL.md` те саме голе ім'я ЛЕГІТИМНЕ — називати свій другий рівень є
       призначенням маршрутизатора, тож туди перевірка навмисно не заходить.
  8.   ловить лише якір на ШЛЯХ РЕПО з хвостом `:НОМЕР`. Голе ім'я файла з
       номером (`tokens.css:148`) не ловиться: без кореня репо це не шлях, і в
       каноні ця форма трапляється саме як приклад забороненого.

⚪ Свідомо НЕ перевіряється (борг, а не пропуск): внутрішньофайлові якорі
`](#розділ)`. Надійний GFM-slug дає лише канонічний `github-slugger`; власний
регекс червонітиме на розбіжностях нашого розуміння GFM із реальним GFM, а не на
дефектах, — і забере довіру до решти перевірок разом із собою.

Використання:
  scripts/check-doc-anchors.py            # звіт + exit 1, якщо є порушення
  scripts/check-doc-anchors.py --quiet    # лише порушення
  scripts/check-doc-anchors.py --list     # що саме перевірено (для калібрування)
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Шаблони шляхів відносно кореня репо: `*` — у межах сегмента, `**/` — будь-яка
# глибина (зокрема нульова).
SOURCE_GLOBS = [
    "docs/**/*.md",
    ".agents/skills/**/*.md",
    "packages/*/skills/**/*.md",
    ".claude/**/*.md",
]
SOURCE_FILES = ["AGENTS.md", "CLAUDE.md", "README.md"]
# Чому саме ці два — див. докстрінг, абзац «Корпус».
SOURCE_EXCLUDE = ["docs/research/**", "docs/superpowers/**"]

REPO_ROOTS = ("apps", "packages", "docs", "scripts", ".agents", ".claude", ".github", "supabase", "legacy")

# Плейсхолдер або glob — не якір: перевіряти нічого.
PLACEHOLDER = re.compile(r"[<>{}*|]|\.\.\.|\$\{|\$[A-Za-z_]")
# Токен шляху: усе до пробілу/беквота/дужки. Кирилиця дозволена — слеш-команди.
BACKTICKED = re.compile(r"`([^`\n]+)`")
MD_LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
# Назва розділу в лапках: українські «», типографські “” або прямі "".
QUOTED = r"(?:«[^»\n]+»|“[^”\n]+”|\"[^\"\n]+\")"
SECTION_NAME = re.compile(r"«([^»\n]+)»|“([^”\n]+)”|\"([^\"\n]+)\"")
# §-вказівник і найближче ПЕРЕД ним посилання на док/скіл (у рядку їх буває кілька).
SECTION_AT = re.compile(
    rf"§{{1,2}}\s*(?P<sections>{QUOTED}(?:\s*(?:,|і|and)\s*{QUOTED})*)"
)
ANCHOR_BEFORE = re.compile(
    r"(?<![A-Za-z0-9_./-])"
    r"(?:(?P<doc>[A-Za-z0-9_./-]+\.md)|(?:скіл|skill)\s+`(?P<skill>[a-z0-9-]+)`)"
    r"(?!.*(?:\.md|(?:скіл|skill)\s+`))",
    re.S,
)
# «§ «X» нижче» / `§ "X" below` — вказівник на розділ ЦЬОГО ж файла.
OWN_SECTION_TAIL = re.compile(r"\s*(нижче|вище|тут|below|above|here)\b", re.I)
# 3b. Номерний §: ім'я дока (можливо в беквотах) ВПРИТУЛ перед `§N[.N…]`.
NUMBERED_SECTION = re.compile(
    r"(?<![A-Za-z0-9_./-])`?(?P<doc>[A-Za-z0-9_./-]+\.md)`?\s*,?\s*§\s*(?P<num>\d+(?:\.\d+)*)"
)
# Канон поза git: memory-індекс (машинно-локальний) і локальні нотатки;
# `SKILL.md` без шляху — згадка форми скіла, не посилання на конкретний файл.
# 🔴 Це справжній skip-list, і він стоїть ПЕРЕД resolve_doc: голий `SKILL.md` не
# перевіряється ВЗАГАЛІ. `SKILL.md § "Розділ"` іде іншою гілкою (SECTION_AT) і
# розділ таки звіряє. Скільки токенів сюди провалилось — друкує `--list`.
EXTERNAL_DOCS = {"MEMORY.md", "SKILL.md", "CLAUDE.local.md"}
HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*$", re.M)
URL = re.compile(r"https?://")

# --- Канон скілів: ліміти й форма (перевірки 4-8) ---------------------------
# `SKILL.md` — тригер і розвилки, reference — деталь кроку. Поріг дубля — у
# рядках-ТВЕРДЖЕННЯХ (див. statement_lines): піднімати його, щоб «стало зелено»,
# не можна — типова копія моделі має рівно три змістовні рядки.
MAX_SKILL_LINES = 500
MAX_REFERENCE_LINES = 100
CONTENTS_HEAD_LINES = 20
DUPLICATE_BLOCK = 3

# Скіли репо (про цей код) і скіли споживача, що їдуть у пакетах: канон один.
SKILLS_DIRS = [ROOT / ".agents/skills", *sorted(ROOT.glob("packages/*/skills"))]


def skills_root_of(path: Path) -> Path | None:
    """Тека скілів, якій належить файл, або `None` — файл не скіл."""
    resolved = path.resolve()
    for d in SKILLS_DIRS:
        if resolved.is_relative_to(d.resolve()):
            return d
    return None
CONTENTS_MARK = re.compile(r"зміст|contents", re.I)
# Хвіст «:рядок» у якорі: `:171`, `:148-149`, `:82, 85`.
LINE_SUFFIX = re.compile(r":\s*\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*$")
# Вказівник із reference углиб: шлях у теку references (свою чи чужу).
REFERENCE_PATH = re.compile(r"(?:^|/)references/[^/]+\.md$")

# Рядки, що НЕ є твердженням: збіг структури — не копія моделі. Відсіюються
# вони, а не піднімається поріг: поріг каже, наскільки довгий збіг вважаємо
# дублем, нормалізація — збіг ЧОГО ми взагалі рахуємо.
FENCE = re.compile(r"^\s*(?:```|~~~)")
SEPARATOR = re.compile(r"^(?:[-*_]{3,}|:?-{2,}:?)$")
POINTER_ONLY = re.compile(
    r"^[-*>\s]*(?:\*\*)?(?:Еталон|Exemplar|Reference|Example)(?:\*\*)?\s*:\s*`?[^\s`]+`?\.?$"
)
LONE_LINK = re.compile(r"^[-*>\s]*\[[^\]]+\]\([^)\s]+\)[.,;:]?$")
SPACES = re.compile(r"\s+")


def glob_regex(pattern: str) -> re.Pattern[str]:
    out = ""
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out += r"(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            out += r".*"
            i += 2
        elif pattern[i] == "*":
            out += r"[^/]*"
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.compile(out + r"\Z")


INCLUDE = [glob_regex(g) for g in SOURCE_GLOBS]
EXCLUDE = [glob_regex(g) for g in SOURCE_EXCLUDE]


def norm(token: str) -> str:
    token = token.strip().rstrip(".,:;)»").lstrip("@")
    if token.startswith("./"):
        token = token[2:]
    return token


def resolve_doc(name: str, src: Path) -> Path | None:
    """Голе ім'я `.md` може означати сусідній файл, SKILL.md свого скіла,
    reference свого скіла, док у `docs/` або кореневий канон — приймаємо
    будь-який із варіантів."""
    if name.startswith(str(ROOT)):
        cand = Path(name)
        return cand if cand.exists() else None
    stripped = name.lstrip("/")
    for cand in (
        src.parent / stripped,
        src.parent.parent / stripped,
        # 🔴 `SKILL.md`, що назвав свій reference ГОЛИМ ім'ям. Форма легітимна
        #    (маршрутизатор має право називати другий рівень), і без цього
        #    кандидата вона давала б «немає дока» — хибне червоне на дозволеному.
        src.parent / "references" / stripped,
        ROOT / stripped,
        ROOT / "docs" / stripped,
        ROOT / "docs/superpowers/specs" / Path(stripped).name,
        ROOT / "docs/superpowers/plans" / Path(stripped).name,
    ):
        if cand.exists():
            return cand
    # крос-скілове посилання виду `references/foo.md` — шукаємо серед усіх скілів.
    # 🔴 Межа: резолв за голим іменем вимагає УНІКАЛЬНОСТІ імені файла. Щойно в
    # двох скілах з'явиться reference з однаковим ім'ям, усі вказівники на це
    # ім'я почервоніють ХИБНО — і виглядатиме це як «гард зламався», а не як
    # «з'явився омонім».
    if stripped.startswith("references/"):
        hits = [h for d in SKILLS_DIRS for h in d.glob(f"*/{stripped}")]
        if len(hits) == 1:
            return hits[0]
    return None


def is_repo_path(token: str) -> bool:
    """🔴 Це ПЕРЕМИКАЧ між двома способами перевірки, а не гейт: `False` не
    означає, що гард сліпий. Токен `.md` без кореня репо йде в resolve_doc, який
    резолвить сусідні файли, `SKILL.md` свого скіла, доки, кореневий канон і
    крос-скілові `references/<файл>.md`."""
    return token.split("/", 1)[0] in REPO_ROOTS and "/" in token


def headings(path: Path) -> list[str]:
    try:
        return [h.strip() for h in HEADING.findall(path.read_text(encoding="utf-8"))]
    except OSError:
        return []


def heading_matches(name: str, pool: list[str]) -> bool:
    """Заголовок може нести номер («## 3. Хуки…») або лапки — звіряємо за входженням."""
    needle = name.strip().lower()
    return any(needle in h.lower() for h in pool)


def numbered_heading_matches(num: str, pool: list[str]) -> bool:
    """`§3.2` відповідає заголовку «3.2 …», «3.2. …» чи «§3.2 …», але не «3.20 …»."""
    pat = re.compile(rf"^(?:§\s*)?{re.escape(num)}(?:[.)]|\s|$)")
    return any(pat.match(h) for h in pool)


def sources() -> list[Path]:
    try:
        listed = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=ROOT,
            check=True,
            capture_output=True,
        ).stdout.decode("utf-8")
    except (OSError, subprocess.CalledProcessError) as err:
        sys.exit(f"check-doc-anchors: cannot list repository files via git: {err}")
    out: list[Path] = []
    for rel in sorted(set(filter(None, listed.split("\0")))):
        wanted = rel in SOURCE_FILES or any(p.match(rel) for p in INCLUDE)
        if not wanted or any(p.match(rel) for p in EXCLUDE):
            continue
        path = ROOT / rel
        # Симлінк на файл або видалений, але ще відстежуваний файл — не джерело.
        if path.is_symlink() or not path.is_file():
            continue
        out.append(path)
    return out


def statement_lines(text: str) -> list[tuple[int, str]]:
    """Рядки-ТВЕРДЖЕННЯ файла: те, чим модель описують. Усе, що є структурою —
    код у фенсах, заголовки, таблиці, роздільники, рядок-вказівник, порожні —
    викидається, бо його збіг у двох файлах копією моделі не є за визначенням."""
    out: list[tuple[int, str]] = []
    in_fence = False
    for i, raw in enumerate(text.splitlines(), 1):
        if FENCE.match(raw):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("|"):
            continue
        if SEPARATOR.match(line) or POINTER_ONLY.match(line) or LONE_LINK.match(line):
            continue
        out.append((i, SPACES.sub(" ", line)))
    return out


def check_duplicates(texts: dict[Path, str]) -> tuple[list[str], int]:
    """4. Той самий блок тверджень у двох файлах корпусу — копія моделі."""
    seen: dict[tuple[str, ...], list[tuple[Path, int]]] = {}
    total = 0
    for src, text in texts.items():
        lines = statement_lines(text)
        total += len(lines)
        for i in range(len(lines) - DUPLICATE_BLOCK + 1):
            window = lines[i : i + DUPLICATE_BLOCK]
            seen.setdefault(tuple(w[1] for w in window), []).append((src, window[0][0]))

    broken: list[str] = []
    # На пару файлів друкуємо ПЕРШИЙ збіг: довгий дубль дає стільки вікон, скільки
    # в ньому рядків, і звіт перетворився б на стіну. Отже «одне влучання» не
    # означає «один рядок» — після правки перевірку ганяють ще раз.
    reported: set[tuple[str, str]] = set()
    for window, hits in seen.items():
        by_file: dict[Path, int] = {}
        for src, line_no in hits:
            by_file.setdefault(src, line_no)
        if len(by_file) < 2:
            continue
        places = sorted((str(s.relative_to(ROOT)), n) for s, n in by_file.items())
        pair = (places[0][0], places[1][0])
        if pair in reported:
            continue
        reported.add(pair)
        where = ", ".join(f"{rel}:{n}" for rel, n in places)
        broken.append(
            f"{places[0][0]}: duplicated block — same statements in {where}: "
            f"\"{window[0][:60]}…\""
        )
    return broken, total


def check_skill_canon(texts: dict[Path, str]) -> tuple[list[str], int, int, int]:
    """5-7. Ліміт `SKILL.md`, «Зміст» у довгому reference, глибина вказівників."""
    broken: list[str] = []
    skills = refs = pointers = 0

    for src, text in sorted(texts.items()):
        root = skills_root_of(src)
        if root is None:
            continue
        rel = src.resolve().relative_to(root.resolve())
        lines = text.splitlines()

        if src.name == "SKILL.md" and len(rel.parts) == 2:
            skills += 1
            if len(lines) > MAX_SKILL_LINES:
                broken.append(
                    f"{src.relative_to(ROOT)}: {len(lines)} lines — "
                    f"SKILL.md limit is {MAX_SKILL_LINES}"
                )
            continue

        if len(rel.parts) != 3 or rel.parts[1] != "references":
            continue
        skill = rel.parts[0]
        refs += 1
        if len(lines) > MAX_REFERENCE_LINES and not CONTENTS_MARK.search(
            "\n".join(lines[:CONTENTS_HEAD_LINES])
        ):
            broken.append(
                f"{src.relative_to(ROOT)}: {len(lines)} lines without a Contents "
                f"section (limit {MAX_REFERENCE_LINES}; searched in the first "
                f"{CONTENTS_HEAD_LINES} lines)"
            )

        # 7. Один рівень від `SKILL.md`. 🔴 Сюди доходять ЛИШЕ файли
        #    `<скіл>/references/*.md` — `SKILL.md` відсіяно вище, і це межа
        #    перевірки, а не оптимізація: маршрутизатор МУСИТЬ називати свій
        #    другий рівень. Усередині reference перехід у сусідній reference веде
        #    повз маршрутизатор незалежно від форми запису. Легальні виходи звідси
        #    лишаються два: док і `SKILL.md` (свій чи чужий).
        for raw in BACKTICKED.findall(text) + MD_LINK.findall(text):
            token = norm(raw)
            if not token.endswith(".md") or URL.search(token) or PLACEHOLDER.search(token):
                continue
            target = resolve_doc(token, src)
            if target is None or target == src:
                continue
            troot = skills_root_of(target)
            if troot is None:
                continue  # док або кореневий канон — легальний вихід із reference
            trel = target.resolve().relative_to(troot.resolve())
            if len(trel.parts) != 3 or trel.parts[1] != "references":
                continue  # `SKILL.md` свого чи чужого скіла — легально
            pointers += 1
            here = src.relative_to(ROOT)
            if trel.parts[0] != skill:
                broken.append(
                    f"{here}: `{token}` — reference of another skill "
                    f"`{trel.parts[0]}`; enter it through its SKILL.md"
                )
            elif REFERENCE_PATH.search(token):
                broken.append(
                    f"{here}: path `{token}` leads to a second level below SKILL.md"
                )
            else:
                broken.append(
                    f"{here}: `{token}` — sibling reference; navigation between "
                    f"references belongs to `{skill}/SKILL.md`"
                )

    return broken, skills, refs, pointers


def check_section_names(
    src: Path, pool: list[str], where: str, sections: str, own: bool
) -> tuple[list[str], int]:
    rel = src.relative_to(ROOT)
    broken: list[str] = []
    checked = 0
    for groups in SECTION_NAME.findall(sections):
        name = next(g for g in groups if g)
        checked += 1
        if not heading_matches(name, pool):
            what = "no own section" if own else "no section"
            broken.append(f"{rel}: {where} — {what} \"{name}\"")
    return broken, checked


def main() -> int:
    quiet = "--quiet" in sys.argv
    listing = "--list" in sys.argv
    broken: list[str] = []
    checked_paths = checked_links = checked_sections = 0
    skipped_external = 0

    texts: dict[Path, str] = {}
    for src in sources():
        try:
            texts[src] = src.read_text(encoding="utf-8")
        except OSError:
            continue

    for src, text in texts.items():
        rel = src.relative_to(ROOT)

        # 1 + 2. Шляхи репо і маркдаун-лінки.
        for raw in BACKTICKED.findall(text) + MD_LINK.findall(text):
            token = norm(raw)
            if not token or URL.search(token) or PLACEHOLDER.search(token):
                continue
            # 8. Якір «шлях:НОМЕР». Прапорцюємо лише коли шлях РЕАЛЬНО існує:
            #    інакше червоніли б самі тексти заборони, де такий якір — приклад.
            #    Якір на НЕіснуючий шлях ловить гілка «немає шляху» нижче.
            base = LINE_SUFFIX.sub("", token)
            if base != token and is_repo_path(base) and (ROOT / base).exists():
                checked_paths += 1
                broken.append(
                    f"{rel}: line number in anchor `{token}` — point to the file "
                    f"(and a section), not to a line"
                )
                continue
            if is_repo_path(token):
                checked_paths += 1
                if not (ROOT / token).exists():
                    broken.append(f"{rel}: missing path `{token}`")
            elif token.endswith(".md"):
                if Path(token).name in EXTERNAL_DOCS:
                    skipped_external += 1
                    continue
                # ім'я дока без кореня репо: сусідній, свого скіла, у docs/, кореневий
                checked_links += 1
                if resolve_doc(token, src) is None:
                    broken.append(f"{rel}: missing doc `{token}`")

        # 3. §-вказівники за назвою: якір беремо НАЙБЛИЖЧИЙ перед §, бо в рядку
        #    їх буває кілька («док X, скіл Y § «Розділ»» — розділ належить Y).
        for m in SECTION_AT.finditer(text):
            start = max(0, m.start() - 400)
            head = text[start : m.start()]
            if URL.search(head[-60:]):
                continue
            if OWN_SECTION_TAIL.match(text[m.end() : m.end() + 20]):
                b, n = check_section_names(src, headings(src), f"`{rel.name}`", m.group("sections"), True)
                broken += b
                checked_sections += n
                continue
            anchor = ANCHOR_BEFORE.search(head)
            # match на позиції 0 — вікно, найімовірніше, розрізало токен
            if anchor is not None and anchor.start() == 0 and start > 0:
                anchor = None
            # якір далеко (>120 симв.) або відсутній — це вказівник на власний розділ
            if anchor is None or len(head) - anchor.end() > 120:
                b, n = check_section_names(src, headings(src), f"`{rel.name}`", m.group("sections"), True)
                broken += b
                checked_sections += n
                continue
            if anchor.group("doc"):
                target = norm(anchor.group("doc"))
                if Path(target).name in EXTERNAL_DOCS - {"SKILL.md"}:
                    skipped_external += 1
                    continue
                path = resolve_doc(target, src)
                if path is None:
                    broken.append(f"{rel}: missing doc `{target}` for a § pointer")
                    continue
                pool, where = headings(path), f"`{target}`"
            else:
                skill = anchor.group("skill")
                sdir = next(
                    (d / skill for d in SKILLS_DIRS if (d / skill).is_dir()), None
                )
                if sdir is None:
                    broken.append(f"{rel}: missing skill `{skill}`")
                    continue
                pool = [h for f in sorted(sdir.rglob("*.md")) for h in headings(f)]
                where = f"skill `{skill}`"
            b, n = check_section_names(src, pool, where, m.group("sections"), False)
            broken += b
            checked_sections += n

        # 3b. §-вказівники за номером — лише з явним доком упритул.
        for m in NUMBERED_SECTION.finditer(text):
            target = norm(m.group("doc"))
            if URL.search(text[max(0, m.start() - 60) : m.start()]) or PLACEHOLDER.search(target):
                continue
            if Path(target).name in EXTERNAL_DOCS:
                skipped_external += 1
                continue
            path = resolve_doc(target, src)
            checked_sections += 1
            if path is None:
                broken.append(f"{rel}: missing doc `{target}` for a § pointer")
            elif not numbered_heading_matches(m.group("num"), headings(path)):
                broken.append(f"{rel}: `{target}` — no section §{m.group('num')}")

    dup_broken, statements = check_duplicates(texts)
    canon_broken, skills, refs, pointers = check_skill_canon(texts)
    broken += dup_broken + canon_broken

    if listing:
        print(
            f"sources: {len(texts)} | paths: {checked_paths} | links: {checked_links} "
            f"| sections: {checked_sections}"
        )
        # Мовчазна гілка гірша за порожню: поки «нічого не знайдено» і «сюди
        # навіть не дивились» виглядають однаково, читач добудовує поведінку сам.
        print(
            f"skipped by skip-list: {skipped_external} | statement lines: {statements} "
            f"| skills: {skills} | references: {refs} "
            f"| reference→reference pointers: {pointers}"
        )
        for src in texts:
            print(f"  · {src.relative_to(ROOT)}")

    if broken:
        for b in broken:
            print(f"  ✗ {b}")
        print(f"\nviolations: {len(broken)}")
        return 1

    if not quiet:
        print(
            f"✓ anchors intact, skill canon respected "
            f"(paths {checked_paths}, links {checked_links}, sections {checked_sections}, "
            f"skills {skills}, references {refs})"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
