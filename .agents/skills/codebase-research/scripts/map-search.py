#!/usr/bin/env python3
"""BM25-пошук теми людською мовою по корпусу доків — двигун `orient --map`.

Тема шукається прямо в корпусі, а не виводиться з коду (символи → доки): на
старті задачі назв символів ще немає, є лише тема.

Живий скан на кожен запит, без індексу й кроку збірки: корпус невеликий, а
індекс довелося б тримати синхронним із доками — ще один артефакт, що старіє.
"""

from __future__ import annotations

import collections
import math
import pathlib
import re
import subprocess
import sys

# ------------------------------------------------------------------ корпус
# Allowlist, а не blocklist: rglob('*.md') по всьому репо ловив би плани,
# чернетки, node_modules і assets/** скілів (шаблони коду, не проза).
# Allowlist виключає цей клас помилки структурно.
#
# Поза корпусом навмисно:
#   CLAUDE.md                 — і так у контексті кожної Claude-сесії;
#   docs/superpowers/plans/** — плани виконання, не канон.
# AGENTS.md — у корпусі: його читають не всі харнеси, а в ньому живуть
# правила, які тема може зачепити.
INCLUDE_GLOBS = [
    "AGENTS.md",
    "README.md",
    "docs/*.md",
    "docs/superpowers/specs/**/*.md",
    "docs/research/**/*.md",
    ".agents/skills/*/SKILL.md",
    ".agents/skills/*/references/**/*.md",
    "packages/*/README.md",
    "apps/*/README.md",
    # Скіли для споживачів їдуть у пакеті (платформна спека, «Доставка»).
    "packages/*/skills/*/SKILL.md",
    "packages/*/skills/*/references/**/*.md",
]

WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
MIN_TOKEN_LEN = 3

# Стандартні параметри BM25. b=0.3, а не класичні 0.75: корпус змішує дуже
# довгі доки (спеки, дослідження) з короткими (SKILL.md, README пакетів), і
# повний штраф за довжину топить довгу спеку, що справді про тему; b=0 навпаки
# дає довгому сусідові з розпорошеними згадками витіснити коротку ціль.
# Компроміс, а не «правильне значення» — міняти лише після заміру на наборі
# реальних запитів.
K1 = 1.5
B = 0.3

# Скільки файлів плоского ранжування потрапляє у вивід — і як топ-рівневі
# пункти, і як діти SKILL.md. Ліміт діє ДО групування, інакше reference з
# дна рангу витісняв би з виводу вищий несуміжний док.
TOP_N = 10

# Тригер — вказівник у терміналі, не документ: довгий абзац гірший за
# втрату хвоста речення.
MAX_TRIGGER_LEN = 160


# ------------------------------------------------------------- лематизація
# pymorphy3 опційний: без нього режим працює на сирих токенах (у cloud-сесіях
# його не буде — це робочий шлях, не аварія). Рівень друкується у виводі, а
# не мовчки підмінюється. Лематизується лише українська частина корпусу —
# латиницю pymorphy3 повертає як є.
#
# Ловимо Exception, а не лише ImportError: пакет може імпортуватись, а
# `MorphAnalyzer(lang="uk")` — падати окремо (словники `pymorphy3-dicts-uk`
# ставляться окремим дистрибутивом; несумісна версія падає так само).
try:
    import pymorphy3  # type: ignore

    _morph = pymorphy3.MorphAnalyzer(lang="uk")
except Exception:
    _morph = None

if _morph is None:
    LEMMA_LEVEL = "raw tokens"

    def lemma(word: str) -> str:
        return word

else:
    _lemma_cache: dict[str, str] = {}
    LEMMA_LEVEL = "lemmas"
    _m = _morph  # локальне імʼя для замикання — не покладаємось на global

    def lemma(word: str) -> str:
        if word not in _lemma_cache:
            _lemma_cache[word] = _m.parse(word)[0].normal_form
        return _lemma_cache[word]


def tokenize(text: str) -> list[str]:
    return [lemma(w.lower()) for w in WORD.findall(text) if len(w) >= MIN_TOKEN_LEN]


def repo_root() -> pathlib.Path:
    """Корінь репо — той самий спосіб, що в `orient`: git, а не лічба `..`."""
    here = pathlib.Path(__file__).resolve()
    out = subprocess.run(
        ["git", "-C", str(here.parent), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
    )
    if out.returncode == 0 and out.stdout.strip():
        return pathlib.Path(out.stdout.strip())
    # запасний варіант — скрипт лежить у .agents/skills/codebase-research/scripts/
    return here.parents[4]


def collect_corpus(root: pathlib.Path) -> dict[pathlib.Path, collections.Counter]:
    files: set[pathlib.Path] = set()
    for pattern in INCLUDE_GLOBS:
        files.update(p for p in root.glob(pattern) if p.is_file())

    index: dict[pathlib.Path, collections.Counter] = {}
    # Сортуємо: `set` ітерується в порядку хешу, а хеш рядків рандомізований
    # per-process (PYTHONHASHSEED) — без сорту порядок при рівних балах BM25
    # був би недетермінованим між запусками.
    for f in sorted(files):
        rel = f.relative_to(root)
        if "assets" in rel.parts or "node_modules" in rel.parts:
            continue  # захисна поправка — див. коментар над INCLUDE_GLOBS
        try:
            text = f.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        index[rel] = collections.Counter(tokenize(text))
    return index


def bm25(
    query: str, index: dict[pathlib.Path, collections.Counter]
) -> list[tuple[pathlib.Path, float]]:
    n = len(index)
    if n == 0:
        return []
    df: collections.Counter = collections.Counter()
    for counts in index.values():
        df.update(counts.keys())
    avgdl = sum(sum(c.values()) for c in index.values()) / n

    ql = tokenize(query)
    scores: dict[pathlib.Path, float] = {}
    for f, counts in index.items():
        dl = sum(counts.values())
        s = 0.0
        for t in ql:
            tf = counts.get(t)
            if not tf:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            # Нормалізація довжини: довший за середній файл штрафується —
            # помірно, бо B=0.3 (обґрунтування — біля константи).
            s += idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * dl / avgdl))
        if s:
            scores[f] = s
    return sorted(scores.items(), key=lambda kv: -kv[1])


# ------------------------------------------------------------------- вивід
def skill_owner(rel: pathlib.Path) -> pathlib.Path | None:
    """Для `<...>/skills/<name>/references/<x>.md` — шлях до SKILL.md скіла.

    Загальне правило, а не лише `.agents/skills`: скіли для споживачів лежать
    у `packages/<pkg>/skills/`, і групуватись мають так само.
    """
    p = rel.parts
    for i in range(2, len(p)):
        if p[i] == "references" and p[i - 2] == "skills":
            return pathlib.Path(*p[:i], "SKILL.md")
    return None


# Тригер reference-файла — рядок, що вже написаний у файлі («Load when …»;
# український варіант лишено для доків, перенесених без перекладу). Жирний
# шрифт необов'язковий — трапляються обидва варіанти.
TRIGGER_RE = re.compile(
    r"\*{0,2}(?:Load (?:this )?when|Завантажуй, коли)\*{0,2}.*?(?=\n\s*\n|\Z)",
    re.DOTALL | re.IGNORECASE,
)


def extract_trigger(root: pathlib.Path, rel: pathlib.Path) -> str:
    """Тригер беремо лише з самого файла — не вигадуємо."""
    try:
        text = (root / rel).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
    m = TRIGGER_RE.search(text)
    if not m:
        return ""
    return " ".join(line.strip() for line in m.group(0).strip().splitlines())


def clean_trigger(text: str) -> str:
    """Термінальний вказівник, не markdown: без сирих `**` і без цілого абзацу."""
    text = text.replace("**", "")
    if len(text) > MAX_TRIGGER_LEN:
        text = text[:MAX_TRIGGER_LEN].rsplit(" ", 1)[0] + "…"
    return text


def build_report(theme: str, root: pathlib.Path) -> str:
    index = collect_corpus(root)
    # Зрізаємо до TOP_N ОДРАЗУ, до групування: групування — лише спосіб ПОКАЗУ
    # вже відібраних файлів. SKILL.md-власник підтягується нагору незалежно від
    # власного балу (власника видно завжди), але дітьми стають лише references,
    # що самі потрапили в TOP_N.
    ranked = bm25(theme, index)[:TOP_N]

    order: list[pathlib.Path] = []
    children: dict[pathlib.Path, list[pathlib.Path]] = collections.defaultdict(list)

    for f, _score in ranked:
        owner = skill_owner(f)
        slot = owner if owner is not None else f
        if slot not in order:
            order.append(slot)
        if owner is not None:
            children[slot].append(f)

    # Розмір корпусу друкується ЗАВЖДИ: без нього «двигун упав» і «двигун
    # відпрацював, збігів немає» виглядають однаково — порожнім виводом.
    lines = [f"# orient --map: {theme}", f"# corpus: {len(index)} files"]
    if not order:
        lines.append("  (no matches in the doc corpus — rephrase the theme or add the other-language term)")

    # Колонка рівня вирівнюється по найдовшому шляху — шляхи різняться на
    # десятки символів, фіксований відступ рвав би колонку.
    width = max((len(str(p)) for p in order), default=0) + 2

    # Якорів розділів (§) тут немає навмисно: BM25 міряє файл, а не розділ,
    # і друкувати розділ як результат означало б видавати незʼясований збіг
    # за ранжування.
    for top_file in order:
        lines.append(f"{str(top_file):<{width}}(level: {LEMMA_LEVEL})")
        for child in children.get(top_file, []):
            trigger = clean_trigger(extract_trigger(root, child))
            suffix = f" ← {trigger}" if trigger else ""
            lines.append(f"   └ {child}{suffix}")
    lines.append("")
    lines.append("# These are pointers. Read the files for the content.")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print('usage: map-search.py "<theme>"', file=sys.stderr)
        return 2
    print(build_report(argv[1], repo_root()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
