# План B7 М5c: тип `RichText`

> **Статус:** план на приймання архітекторкою М5c. Блок — #408.
> Спільний ресурс — стенд `postgres` (один DB-слот М5c). Стенд не зупиняти й не
> перезапускати. Профіль лише `postgres` (ADR-0117): жодного
> `*.supabase.db.test.ts`, рівень `db-supabase` не потрібен. Повні рівні `unit`,
> `db` і `packaging` запускає CI; локально — лише цільові форми задач.
> Незлитої роботи, на яку план спирається, немає.

## 1. Мета, архітектура, спека

**Мета.** Логічний тип `RichText`: ProseMirror JSON у колонці `jsonb`, вхід
команди перевіряється профілем (відмова, а не відсікання), межа `maxBytes`
1 МіБ, типово `load: "lazy"` у шапці, предикат порожності в T0 і в SQL.
Резерв для B3, B4 і B8: одне джерело профілю, одна функція порожності з однією
таблицею випадків, одна точка перевірки значення в T3.

**Архітектура.** T0 (`packages/simetra/src/model`) отримує тип у
`LOGICAL_TYPES`, сталу профілю, перевірку профілю, предикат порожності й
TypeScript-тип документа — без нових залежностей (лише `zod`). Обхід
реквізитів `encodeAttributes` (`model/runtime/values.ts`, його кличе T3)
виносить перевірку одного значення в окрему експортовану функцію. Компілятор
(T1) виводить SQL-функцію `simetra.rich_text_is_empty(jsonb)` у шарі платформи
з тих самих сталих T0 і додає типову лінивість. Читання, фільтр, сортування й
сховище T4 трактують `RichText` як `Json`. Редактора й нових пакетів блок не
додає.

**Спека.** [мультимовні дані](../specs/2026-11-24-multilingual-data-design.md)
§3 (рядок B7), §4 (рядок `RichText`), §5.7; споживачі — §5.3 (CHECK з
`simetra.rich_text_is_empty`), §5.4 (`maxBytes` і профіль на кожну мову в
`encodeAttributes`), §5.8 (поле Tiptap). ADR-0116. [П4-B](../specs/2026-11-05-p4-b-client-data-design.md)
Рд25 (лінивий атрибут) і рядок `maxBytes` (правило `Json`). [П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§4 (система типів), §5 («Лінивий реквізит», `maxBytes`).

## 2. Глобальні обмеження

- T0 не отримує жодної залежності, крім `zod`; `@tiptap/*` і `prosemirror-*` у
  B7 не додаються (Р-B7-11).
- Наявні тести лишаються зеленими. Знімки й фікстури, що перелічують типи
  (JSON Schema у `packages/simetra/schemas`), оновлюються генератором
  (`pnpm --filter simetra schemas:update`), не руками.
- Наявні фікстури доменів (`compiler/__tests__/fixtures/*.ts`,
  `server/__tests__/fixtures.ts`) реквізит `RichText` отримують лише там, де
  тест його перевіряє; домен DB-тесту — окремий шар у тесті (задача 5), щоб
  чужі знімки не змінювались.
- Повідомлення правил — англійською й українською в
  `compiler/messages.ts`, як решта правил.

## 3. Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р-B7-1 | `RichText` — новий член `LOGICAL_TYPES` (`model/schemas/value-type.ts`); фізичний тип — `jsonb` (`model/physical/pg-types.ts`). Зворотне читання каталогу (`SCALAR_TYPES`) лишає `jsonb → Json`: з колонки тип не вивести, тож прийняття таблиці дає `Json`, а дрейф порівнює фізичний тип і розбіжності не бачить. | П2 §4 (рядок таблиці типів) |
| Р-B7-2 | **Профіль `RichText`** — одна стала T0 `RICH_TEXT_PROFILE` для всієї платформи, без налаштування на реквізиті в цій віці. Склад — вузли й позначки Tiptap StarterKit 3.35.0. Вузли: `doc`, `paragraph`, `text`, `heading` (`level` 1–6), `bulletList`, `orderedList` (`start`, `type`), `listItem`, `blockquote`, `codeBlock` (`language`), `hardBreak`, `horizontalRule`. Позначки: `bold`, `italic`, `strike`, `code`, `underline`, `link` (`href`, `target`, `rel`, `class`, `title`). Вузлів-вкладень немає: поле вкладення в профілі є, а зображення за id файлу — окремий блок, бо воно перетинає межу прав файлів. Розширення профілю — адитивне. *На приймання архітекторки.* | §5.7 (склад — посиланням на сталу) |
| Р-B7-3 | Правила профілю, усі — відмова. Невідомий вузол, позначка, ключ вузла (дозволені `type`, `attrs`, `content`, `marks`, `text`) чи атрибут. Атрибут поза своїм доменом: `heading.level` — ціле 1–6; `orderedList.start` — ціле ≥ 0; `orderedList.type` — `null` чи одне з `1 a A i I`; `codeBlock.language` — `null` чи `^[A-Za-z0-9_+#.-]{1,32}$`; `link.target` — `null` чи `_blank`; `link.rel` — `null` чи токени `[a-z]+` через пробіл; `link.class` — лише `null`; `link.title` — `null` чи рядок. Пропущений атрибут — типове значення, як у `getJSON`. Дочірні вузли — за переліком дозволених дітей вузла; непорожній `content` там, де схема ProseMirror вимагає `+` (`doc`, списки, `listItem`, `blockquote`). Текстовий вузол — непорожній `text`, без дублікатів позначок; у `codeBlock` — без позначок. Глибина ≤ `RICH_TEXT_MAX_DEPTH` (64). Обхід ітеративний. *На приймання архітекторки.* | §5.7 |
| Р-B7-4 | `link.href` — лише `http:`/`https:`/`mailto:` (схема без урахування регістру), відносний шлях з `/`, але не з `//`, чи якір `#…`; будь-який керівний символ (U+0000–U+001F, U+007F) чи пробільний символ у `href` — відмова до розбору схеми. Тож `javascript:`, `data:`, `vbscript:`, ` javascript:`, `java\tscript:` і `//host` відмовляються. | §5.7 |
| Р-B7-5 | Відмова профілю — `command.invalid`, `path` — шлях реквізиту, `reason: "rich-text-profile"`. Місце всередині документа назовні не йде: перевірку з місцем дає клієнтові сама функція T0 (B8). Нова причина стає поряд з `LIMIT_REASONS` у `model/runtime/errors.ts` окремою сталою причин значення. | П4 §6.10 (рядок `command.invalid`) |
| Р-B7-6 | Точка перевірки одного значення — експортована `encodeAttributeValue(attribute, value, path, { maxBytes })` у `model/runtime/values.ts`. Тіло циклу `encodeAttributes` переходить у неї без зміни поведінки для наявних типів. Порядок: кодування чистого JSON (`encodeItemValue`) → `maxBytes` (`too-large`) → профіль (`rich-text-profile`). B4 кличе її раз на мову. | none (§5.4 це вже каже) |
| Р-B7-7 | **Порожність.** Документ порожній, коли ніде в ньому, на будь-якій глибині, немає об'єкта з `type: "text"` і рядковим `text` з непробільним символом і немає об'єкта з `type` вузла-вкладення профілю. Визначення — над будь-яким `jsonb`, не лише над документом профілю: CHECK B3 бачить і записи через `psql` та `import`. Пробільні символи — одна стала T0 `RICH_TEXT_WHITESPACE` (набір `\s` JavaScript). Предикат T0 `isRichTextEmpty` і регулярний вираз SQL будуються з неї, бо `\s` Postgres залежить від локалі. | §5.7 |
| Р-B7-8 | `simetra.rich_text_is_empty(jsonb) RETURNS boolean`. Мова `sql`, `IMMUTABLE STRICT PARALLEL SAFE`, тіло — `jsonb_path_exists`, нелінивий режим. Текст функції будує компілятор зі сталих Р-B7-7. На будь-якому `jsonb` функція не кидає помилки. `NULL` повертає `NULL` (`STRICT`, як `!~` для `String` у §5.3); `NULL` B3 обробляє сам. Функцію шар платформи виводить безумовно для кожного проєкту, як `outbox` (`compiler/platform/units.ts`). Гранти — `executeGrants` для `SESSION_ROLES`: кожна роль, що пише рядок, обчислює CHECK. | §5.7 |
| Р-B7-9 | Метадані: `RichText` відмовляє `array`, `unique` і `uniqueWithin`, `indexed`, членству в складеному індексі, полю пошуку (`search-fields.ts`), `defaultValue` (як `Json`, без `empty`). `RichText` дозволено реквізиту шапки й ТЧ видів 1С; поле регістра, константа й колонка `CustomTable` — відмова, доки вони не мають ядра команди з перевіркою профілю. Коди правил і тексти дає виконавиця. *На приймання архітекторки.* | П2 §4, §5 |
| Р-B7-10 | Типова лінивість: `load` без значення — `lazy` для `RichText` шапки (`compiler/runtime-catalog.ts`, поряд з `Bytes`); у ТЧ — `eager`. `maxBytes` типово 1 МіБ (`MAX_BYTES_DEFAULTS`), явний `maxBytes` дозволено; міра — як у `Json`, з надлишком ширини чисел `jsonb` (`wireBytes`). Фільтр, сортування й параметр `where` — заборонені, як `Json`: `server/read-filter.ts`, `server/read.ts`, `server/values.ts`, `data/store/filter.ts`. Декодування дроту — як `Json` (`model/runtime/wire.ts`). Кодоген дає тип документа `RichTextDocument`, експортований з `simetra/model`, тим самим механізмом, що `Json_` (`compiler/codegen.ts`). | П2 §5, §8.5 |
| Р-B7-11 | Нової залежності B7 не додає. Ліцензії для B8 перевірено 2026-11-25: файл ліцензії репозиторію `ueberdosis/tiptap` — MIT; тарболи 3.35.0 `@tiptap/starter-kit`, `extension-link`, `extension-heading`, `extension-code-block`, `extension-list` — MIT. Pro-розширень і хмари профіль не використовує. | none |

## 4. Інтерфейси

| Що дає B7 | Вид | Де | Споживачі |
| --- | --- | --- | --- |
| `RICH_TEXT_PROFILE`: вузли з атрибутами й дітьми, позначки з атрибутами, вузли-вкладення, `RICH_TEXT_MAX_DEPTH` | стала T0 | `simetra/model` | T3 (перевірка), B8 (конфігурація розширень Tiptap) |
| `checkRichText(value)` → `{ ok: true }` чи `{ ok: false, at, rule }` | функція T0 | `simetra/model` | `encodeAttributeValue`, B8 (перевірка в полі) |
| `isRichTextEmpty(value)`, `RICH_TEXT_WHITESPACE` | функція й стала T0 | `simetra/model` | B4 (порожній переклад знімає ключ, §5.4), B8 |
| `RichTextDocument` | тип T0 | `simetra/model` | кодоген, B8 |
| `encodeAttributeValue(attribute, value, path, { maxBytes })` | функція T0, кличе T3 | `model/runtime/values.ts` | `encodeAttributes`, B4 (раз на мову) |
| `simetra.rich_text_is_empty(jsonb)` і стала її кваліфікованого імені | SQL-функція, стала T1 | `compiler/platform/names.ts` | B3 (CHECK таблиці перекладів) |
| спільна таблиця випадків порожності `{ doc, empty }` | тестова фікстура | `model/runtime/__tests__/rich-text-cases.ts` | unit T0, DB-тест B7, тести CHECK B3 |
| причина `rich-text-profile` | стала T0 | `model/runtime/errors.ts` | T3, B4, B8 |

B8 перевіряє відповідність профілю й схеми Tiptap. Перший напрям: документ, що
проходить `checkRichText`, проходить `Node.fromJSON(schema, doc).check()`
StarterKit без змін. Другий напрям: `getJSON()` будь-якого документа редактора
StarterKit проходить `checkRichText`. Розбіжність виправляється в профілі T0, не
в редакторі. Це тест B8, не B7.

## 5. Інваріанти безпеки

- **Відмова, а не відсікання.** Валідний документ із невідомим вузлом на
  глибині 3 (і окремо: невідомою позначкою, зайвим атрибутом) дає `command.invalid`
  з `reason: "rich-text-profile"`. Значення в базі не змінюється: DB-тест
  перечитує рядок. **Мутація:** перевірка, що мовчки викидає невідомий вузол і
  пропускає решту, — unit-тест профілю й DB-тест червоні.
- **Схема посилання.** Unit-тест відмовляє кожному `href` з Р-B7-4 і пропускає
  `https://…`, `MAILTO:x@y`, `/p`, `#a`. **Мутація:** порівняння схеми з
  урахуванням регістру чи перевірка схеми до відкидання керівних символів —
  червоніють `JavaScript:` і `java\tscript:`.
- **`class` посилання й мова блоку коду** не несуть довільного тексту в атрибут
  HTML. **Мутація:** `class` — будь-який рядок — тест `class: "x"` червоніє.
- **Межа розміру.** Документ рівно `maxBytes` проходить, на байт більший —
  `too-large`. Документ понад межу з невідомим вузлом дає `too-large`, а не
  профіль: це перевірка порядку Р-B7-6. **Мутація:** профіль до `maxBytes` —
  тест порядку червоніє. DB-тест: документ понад 1 МіБ через команду —
  `too-large`, рядок не записано.
- **Глибина.** Документ глибини 65 — відмова. Документ глибини 10 000 у межах
  `maxBytes` дає `command.invalid`, а не виняток. **Мутація:** рекурсивний
  обхід без межі глибини — тест глибини 65 червоніє.
- **Порожність одна в T0 і SQL.** Кожен випадок спільної таблиці дає той самий
  результат у `isRichTextEmpty` і в `simetra.rich_text_is_empty` на стенді.
  Серед випадків: NBSP (U+00A0), U+3000 і U+FEFF як єдиний текст — порожній;
  U+200B — непорожній (поза `\s`); текст лише в атрибуті чи в позначці —
  порожній; не документ (`[]`, `"x"`, `1`, `{}`) — порожній і без помилки.
  **Мутація:** SQL-регулярний вираз з `\s` замість набору зі сталої — DB-тест
  червоніє на U+FEFF чи U+3000.
- **Роль, що пише, може обчислити функцію.** DB-тест кличе
  `simetra.rich_text_is_empty` від ролі команд і ролі користувача профілю
  `postgres`. **Мутація:** гранти без `command` — тест червоніє з
  `permission denied`.

## 6. Частини

Немає.

## 7. Задачі

| # | Задача | Файли | Готово, коли | Після | Перевірка |
| --- | --- | --- | --- | --- | --- |
| 0 | Якорі й поправки спеки | спеки й глосарій з §8 | `orient --plan` і `doc anchors` чисті; поправки §8 внесено одним комітом `docs(spec)` | — | `doc anchors` |
| 1 | Тип і правила метаданих | `model/schemas/value-type.ts`, `attribute.ts`, `rules.ts`, `model/physical/pg-types.ts`, `compiler/messages.ts`, `compiler/search-fields.ts`, складені індекси, `custom-table.ts`, схеми регістрів і констант; JSON Schema генератором | `RichText` у `LOGICAL_TYPES`, фізичний `jsonb`. Кожна відмова Р-B7-9 має тест правила з кодом. Типовий `maxBytes` — 1 МіБ, явний дозволено. Опис `load` і `maxBytes` у `.meta` згадує `RichText`. Тест зворотного читання: `jsonb` → `Json` | 0 | `run-tests unit --changed` |
| 2 | Профіль, перевірка, порожність у T0 | новий модуль `model/runtime/rich-text.ts` (чи `model/schemas/`, на вибір виконавиці) з експортом через `simetra/model`; `rich-text-cases.ts`; тести | `checkRichText` виконує Р-B7-2–Р-B7-4, `isRichTextEmpty` — Р-B7-7. Тест на кожне правило відмови й на прийняття справжнього виходу `getJSON` StarterKit (зразок документа зі всіма вузлами й позначками — у фікстурі). Мутації §5 для профілю, `href`, `class`, глибини й таблиці порожності червоні | 0 | `run-tests unit --filter rich-text` |
| 3 | Точка перевірки значення й тип у шляхах читання | `model/runtime/values.ts` (`encodeAttributeValue`, гілка `RichText`, `wireBytes`), `model/runtime/errors.ts`, `model/runtime/wire.ts`, `server/values.ts`, `server/read-filter.ts`, `server/read.ts`, `data/store/filter.ts`, `compiler/row-budget.ts`, `compiler/codegen.ts` | `encodeAttributes` кличе `encodeAttributeValue`, наявні тести `values.test.ts` без змін зелені. Тест порядку Р-B7-6 і межі на байт є. Фільтр, сортування й `where` по `RichText` — `command.invalid`, як для `Json`, у T3 і T4. Кодоген дає `RichTextDocument` | 1, 2 | `run-tests unit --changed` |
| 4 | Лінивість і SQL-функція порожності | `compiler/runtime-catalog.ts`; `compiler/platform/units.ts`, `names.ts`; розпізнавач шару платформи (`compiler/platform/recogniser.ts`, `install.ts`) | `RichText` шапки без `load` у каталозі — `lazy`, у ТЧ — `eager`. Шар платформи кожного проєкту, з довідником «Користувачі» й без нього, містить функцію з грантами; тест шару платформи й розпізнавача бачить її як об'єкт платформи. Текст функції збудовано зі сталих T0. Unit-тест тексту: `IMMUTABLE STRICT PARALLEL SAFE`, набір пробільних символів — з `RICH_TEXT_WHITESPACE` | 2 | `run-tests unit --changed` |
| 5 | DB-тест запису й читання | новий файл `rich-text.db.test.ts` у `packages/designer/src/__tests__/`. Домен — `Gauge` (фікстура прав `compiler/__tests__/fixtures/rights.ts`) з реквізитом `RichText` у шарі цього тесту, за зразком `wideBigintLayer` (`compiler/__tests__/fixtures/rights.ts`, реекспорт через `packages/simetra/test/support.ts`). Опора — `read-query.db.test.ts` і `support/db.ts` | на стенді `postgres` від ролі користувача: `create` з повним зразком документа, потім читання картки повертає рівний документ (глибока рівність; `jsonb` міняє порядок ключів), а списочне читання реквізиту не віддає. `update` з невідомим вузлом — `rich-text-profile`, рядок не змінився. Документ понад 1 МіБ — `too-large`. Фільтр за реквізитом — `command.invalid`. Кожен випадок `rich-text-cases.ts` через `simetra.rich_text_is_empty` дає очікуване. Функцію кличуть роль команд і роль користувача. Тест лишає стенд чистим | 3, 4 | `run-tests db --filter rich-text` |
| 6 | Звіт архітекторці | — | PR з `Refs #408`; у тілі — рішення на приймання й підсумок | 5 | — |

Нотатки виконавиці:

- Кожна вичерпна гілка за типом (компілятор TypeScript їх знайде) отримує
  явний `case "RichText"`. Невичерпні гілки з переліку задачі 3 typecheck не
  знайде: їх перевіряє тест.
- Якщо T5 (`ui/fields`) вимагає гілку за типом, `RichText` іде гілкою `Json`
  лише для читання. Поле редактора дає B8.
- Шаблон застосунку (`create-simetra-app`) реквізиту `RichText` у B7 не
  отримує.

## 8. Задача 0 — поправки спеки

| Документ | Поправка |
| --- | --- |
| мультимовні дані §5.7 | профіль — посиланням на `RICH_TEXT_PROFILE`: склад Р-B7-2, правила Р-B7-3/Р-B7-4; визначення порожності Р-B7-7 (будь-який `jsonb`, набір пробільних символів T0); `STRICT` і `NULL` Р-B7-8; причина `rich-text-profile` |
| П2 §4 | рядок `RichText` у таблиці типів (`jsonb`, ProseMirror JSON, профіль, зворотне читання → `Json`); рядок «jsonb масово: rich text…» лишає `Json` для решти |
| П2 §5 | «Лінивий реквізит»: типове `lazy` для `RichText` шапки — правило, а не намір; `maxBytes` — серед типів `RichText`; відмови Р-B7-9 |
| П2 §8.5 | кодоген: `RichText` → `RichTextDocument` |
| П4 §6.10 | рядок `command.invalid`: `reason: "rich-text-profile"`, `path` — реквізит |
| П4-B (Рд26 і рядок таблиці `maxBytes`) | «майбутній `RichText`» → `RichText`; правило те саме |
| платформна спека, таблиця відкладеного | `RichText` прибрано з рядка модуля «Документація» з посиланням на ADR-0116 |
| `docs/GLOSSARY.md` | термін **профіль `RichText`** — перелік дозволених вузлів, позначок і атрибутів; *Avoid:* «профіль» без уточнення, «схема редактора» |

## 9. Задачі власника

Немає.

## 10. Підсумок аудиту

Заповнюється після аудиту.
