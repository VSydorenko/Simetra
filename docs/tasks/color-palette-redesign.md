# Task: Редизайн кольорової палітри — від ахроматичної до бізнесово-пастельної

## Контекст

Поточна тема Simetra (shadcn radix-mira, baseColor: neutral) є **повністю ахроматичною**: всі CSS-токени мають chroma=0 в oklch (чисті відтінки сірого від білого до чорного). Це робить інтерфейс плоским і нечитабельним — практично неможливо розрізнити елементи, панелі, типи метаданих.

Мета — перевести палітру на **slate-blue бізнесову тему** з пастельними акцентами: додати хроматичне забарвлення до існуючих CSS-токенів, ввести семантичні кольори (success, warning, info), створити унікальні кольори для кожного з 7 типів метаданих, покращити видимість бордерів та додати мінімальні тіні.

**Критичне обмеження**: розміри, відступи, padding, шрифт (Inter Variable), радіуси, структура компонентів shadcn/ui — НЕ змінювати. Зміни торкаються тільки кольорів, бордерів, тіней та застосування кольорів до конкретних елементів UI.

## Діагноз поточного стану

### Файл `packages/ui/src/styles/globals.css`

Всі токени мають 0 chroma — це і є кореневе причина монохромності:

```
/* Кожен токен = oklch(L 0 0) — чистий grayscale */
--primary: oklch(0.922 0 0);       /* білий як primary у dark mode */
--accent: oklch(0.269 0 0);        /* = secondary = muted — всі однакові */
--border: oklch(1 0 0 / 10%);      /* ледь видимий */
--ring: oklch(0.556 0 0);          /* сірий — focus state непомітний */
--chart-1..5: всі ахроматичні      /* графіки теж сірі */
```

### Компоненти, що потребують кольорового оновлення

| Компонент | Файл | Проблема |
|---|---|---|
| Іконки дерева | `apps/web/src/components/layout/tree-panel.tsx` | `text-muted-foreground` — всі 7 типів однаковим сірим |
| Вузол обʼєкта | `tree-panel.tsx` → `ObjectNode` | Виділення `bg-accent` ідентичне фону |
| Вузол розділу | `tree-panel.tsx` → `SectionNode` | Badge `variant="secondary"` — сірий на сірому |
| Tab Bar | `apps/web/src/components/window-manager/tab-bar.tsx` | Активна вкладка `bg-background shadow-sm` — ледь відрізняється |
| Badge типу у вкладці | `tab-bar.tsx` → `Badge variant="outline"` | Монохромний outline badge — не несе інформації окрім тексту |
| ObjectEditor header | `apps/web/src/components/editor/object-editor.tsx` | Іконка `text-muted-foreground`, badge `variant="outline"` — невиразні |
| AttributeTable | `apps/web/src/components/editor/attribute-table.tsx` | Виділення рядка `bg-accent` — непомітне |
| Top Bar | `apps/web/src/components/layout/top-bar.tsx` | `bg-background border-b border-border` — зливається |
| Status Bar | `apps/web/src/components/layout/status-bar.tsx` | `text-muted-foreground` — весь статус бар майже невидимий |
| metadata-icons.ts | `apps/web/src/lib/metadata-icons.ts` | Тільки іконки, без кольорів |

## Вимоги

### Частина 1: Оновлення CSS-токенів у globals.css

- [ ] Замінити ахроматичні oklch-значення на хроматичні (з ненульовим chroma) у **обох** режимах: `:root` (light) та `.dark`
- [ ] Базовий hue-сімейство: **250 (slate-blue)** — бізнесовий, спокійний, професійний
- [ ] Токени, що змінюються (із збереженням lightness-контрасту для WCAG AA):

  **Dark theme (.dark):**
  | Токен | Поточне | Нове | Пояснення |
  |---|---|---|---|
  | `--primary` | `oklch(0.922 0 0)` | `oklch(0.65 0.15 250)` | Slate-blue — кнопки, active tab |
  | `--primary-foreground` | `oklch(0.205 0 0)` | `oklch(0.98 0.005 250)` | Легкий blue-tint на білому |
  | `--accent` | `oklch(0.269 0 0)` | `oklch(0.30 0.04 250)` | Subtle blue tint для hover/selection |
  | `--accent-foreground` | `oklch(0.985 0 0)` | `oklch(0.95 0.01 250)` | Помітно від primary-foreground |
  | `--muted` | `oklch(0.269 0 0)` | `oklch(0.25 0.02 260)` | Холодний відтінок для badge-фонів |
  | `--muted-foreground` | `oklch(0.708 0 0)` | `oklch(0.68 0.03 250)` | Ледь кольоровий вторинний текст |
  | `--card` | `oklch(0.205 0 0)` | `oklch(0.20 0.015 260)` | Ледь синюватий фон карток |
  | `--card-foreground` | `oklch(0.985 0 0)` | `oklch(0.95 0.01 250)` | Узгодження |
  | `--popover` | `oklch(0.205 0 0)` | `oklch(0.22 0.02 255)` | Трохи відрізняється від card |
  | `--secondary` | `oklch(0.269 0 0)` | `oklch(0.28 0.03 250)` | Відмінне від muted |
  | `--border` | `oklch(1 0 0 / 10%)` | `oklch(1 0 0 / 14%)` | Помітніші бордери |
  | `--input` | `oklch(1 0 0 / 15%)` | `oklch(1 0 0 / 18%)` | Помітніші input borders |
  | `--ring` | `oklch(0.556 0 0)` | `oklch(0.60 0.14 250)` | Blue focus ring — видимий! |
  | `--background` | `oklch(0.145 0 0)` | `oklch(0.16 0.01 255)` | Мінімальний blue tint на фоні |
  | `--foreground` | `oklch(0.985 0 0)` | `oklch(0.96 0.01 250)` | Трохи тепліший білий |
  | `--sidebar` | `oklch(0.205 0 0)` | `oklch(0.19 0.015 255)` | Ледь інший від background |
  | `--sidebar-primary` | `oklch(0.488 0.243 264.376)` | `oklch(0.65 0.15 250)` | = primary для консистентності |
  | `--sidebar-accent` | `oklch(0.269 0 0)` | `oklch(0.28 0.04 250)` | Для hover у sidebar |

  **Light theme (:root):**
  | Токен | Поточне | Нове |
  |---|---|---|
  | `--primary` | `oklch(0.205 0 0)` | `oklch(0.45 0.18 250)` |
  | `--primary-foreground` | `oklch(0.985 0 0)` | `oklch(0.98 0.005 250)` |
  | `--accent` | `oklch(0.97 0 0)` | `oklch(0.95 0.02 250)` |
  | `--muted` | `oklch(0.97 0 0)` | `oklch(0.95 0.015 250)` |
  | `--muted-foreground` | `oklch(0.556 0 0)` | `oklch(0.50 0.04 250)` |
  | `--card` | `oklch(1 0 0)` | `oklch(0.99 0.005 250)` |
  | `--popover` | `oklch(1 0 0)` | `oklch(0.99 0.005 250)` |
  | `--secondary` | `oklch(0.97 0 0)` | `oklch(0.96 0.02 250)` |
  | `--border` | `oklch(0.922 0 0)` | `oklch(0.88 0.02 250)` |
  | `--input` | `oklch(0.922 0 0)` | `oklch(0.88 0.02 250)` |
  | `--ring` | `oklch(0.708 0 0)` | `oklch(0.55 0.15 250)` |
  | `--background` | `oklch(1 0 0)` | `oklch(0.99 0.005 260)` |
  | `--foreground` | `oklch(0.145 0 0)` | `oklch(0.18 0.02 250)` |
  | `--sidebar` | `oklch(0.985 0 0)` | `oklch(0.97 0.01 255)` |
  | `--sidebar-primary` | `oklch(0.205 0 0)` | `oklch(0.45 0.18 250)` |

- [ ] Оновити chart-кольори на хроматичні (п'ять різних hue):
  - `--chart-1`: `oklch(0.65 0.15 250)` (blue)
  - `--chart-2`: `oklch(0.65 0.15 155)` (green)
  - `--chart-3`: `oklch(0.70 0.12 30)` (coral)
  - `--chart-4`: `oklch(0.70 0.10 300)` (lavender)
  - `--chart-5`: `oklch(0.75 0.12 85)` (amber)

### Частина 2: Нові семантичні CSS-токени

- [ ] Додати нові CSS custom properties до `:root` і `.dark` у `globals.css`:
  - `--success` / `--success-foreground` — для валідації ОК, saved status
  - `--warning` / `--warning-foreground` — для validation warnings
  - `--info` / `--info-foreground` — для інформаційних badge/підказок

  **Dark theme значення:**
  | Токен | Значення |
  |---|---|
  | `--success` | `oklch(0.65 0.15 155)` |
  | `--success-foreground` | `oklch(0.98 0.01 155)` |
  | `--warning` | `oklch(0.75 0.12 85)` |
  | `--warning-foreground` | `oklch(0.20 0.04 85)` |
  | `--info` | `oklch(0.65 0.12 240)` |
  | `--info-foreground` | `oklch(0.98 0.01 240)` |

  **Light theme значення:**
  | Токен | Значення |
  |---|---|
  | `--success` | `oklch(0.55 0.18 155)` |
  | `--success-foreground` | `oklch(0.98 0.01 155)` |
  | `--warning` | `oklch(0.65 0.15 85)` |
  | `--warning-foreground` | `oklch(0.20 0.04 85)` |
  | `--info` | `oklch(0.55 0.15 240)` |
  | `--info-foreground` | `oklch(0.98 0.01 240)` |

- [ ] Зареєструвати нові токени в `@theme inline` блоці:
  - `--color-success`, `--color-success-foreground`
  - `--color-warning`, `--color-warning-foreground`
  - `--color-info`, `--color-info-foreground`

### Частина 3: Кольори типів метаданих (KIND_COLORS)

- [ ] Створити маппінг `KIND_COLORS` у `apps/web/src/lib/metadata-icons.ts` (поруч з `KIND_ICONS`)
- [ ] Кожен MetadataKind отримує унікальний пастельний колір:

  | MetadataKind | CSS-клас (Tailwind) | oklch Dark | oklch Light | Опис |
  |---|---|---|---|---|
  | Catalog | `text-kind-catalog` | `oklch(0.70 0.12 220)` | `oklch(0.50 0.15 220)` | Спокійний блакитний |
  | Document | `text-kind-document` | `oklch(0.70 0.12 155)` | `oklch(0.48 0.15 155)` | М'який зелений |
  | Enumeration | `text-kind-enum` | `oklch(0.70 0.10 300)` | `oklch(0.50 0.13 300)` | Лавандовий |
  | InformationRegister | `text-kind-info-reg` | `oklch(0.70 0.10 60)` | `oklch(0.55 0.12 60)` | Теплий пісочний |
  | AccumulationRegister | `text-kind-acc-reg` | `oklch(0.70 0.12 30)` | `oklch(0.52 0.15 30)` | Пастельний коралловий |
  | Constant | `text-kind-constant` | `oklch(0.65 0.08 200)` | `oklch(0.48 0.10 200)` | Приглушений teal |
  | CustomTable | `text-kind-custom` | `oklch(0.65 0.06 250)` | `oklch(0.48 0.08 250)` | Нейтральний slate |

- [ ] Реалізація: `KIND_COLORS` як `Record<MetadataKind, string>` — значення = Tailwind CSS клас
- [ ] Визначити кольори через CSS custom properties в globals.css (щоб автоматично перемикались між dark/light):
  - У `:root` і `.dark` додати `--kind-catalog`, `--kind-document`, `--kind-enum`, `--kind-info-reg`, `--kind-acc-reg`, `--kind-constant`, `--kind-custom`
  - В `@theme inline` додати відповідні `--color-kind-*` маппінги
- [ ] `KIND_COLORS` зберігає Tailwind-клас, наприклад `'text-kind-catalog'` — без inline styles

### Частина 4: Застосування кольорів у компонентах

- [ ] **Tree Panel** (`apps/web/src/components/layout/tree-panel.tsx`):
  - `SectionNode`: замінити `text-muted-foreground` на іконці → `KIND_COLORS[data.kind]`
  - `ObjectNode`: замінити `text-muted-foreground` на іконці → `KIND_COLORS[data.kind]`
  - `ObjectNode` selected: додати `border-l-2 border-primary` до `bg-accent` для виразнішого виділення

- [ ] **Tab Bar** (`apps/web/src/components/window-manager/tab-bar.tsx`):
  - Active tab: додати `border-b-2 border-primary` замість тільки `bg-background shadow-sm`
  - Badge типу: застосувати фоновий колір kind-а (light-версія як `bg-kind-*/10` або через opacity)
  - Іконку типу поруч з badge — можна не додавати, достатньо кольорового badge

- [ ] **Object Editor** (`apps/web/src/components/editor/object-editor.tsx`):
  - Іконка у заголовку: замінити `text-muted-foreground` → `KIND_COLORS[objectRef.kind]`
  - Badge типу: зробити трохи кольоровим (background з opacity від kind-кольору)

- [ ] **Attribute Table** (`apps/web/src/components/editor/attribute-table.tsx`):
  - Виділений рядок: переконатись що `bg-accent` з новим blue-tinted accent візуально помітний
  - Toolbar border: переконатись що `border-b border-border` помітний з новим border token

- [ ] **Status Bar** (`apps/web/src/components/layout/status-bar.tsx`):
  - Помилки: показувати кольором `text-destructive` замість `text-muted-foreground` коли `errorCount > 0`
  - "Немає помилок": показувати `text-success` (новий семантичний колір)
  - "Незбережені зміни": показувати `text-warning`

- [ ] **Top Bar** (`apps/web/src/components/layout/top-bar.tsx`):
  - Dirty indicator (`*`): текст `text-warning` замість звичайного muted

### Частина 5: Тіні та бордери

- [ ] **Панельні бордери**: переконатись що `border-border` з новим `oklch(1 0 0 / 14%)` дає видимий розподіл панелей (не торкати padding/margins!)
- [ ] **Картки/Popover**: додати `shadow-sm` з тонкою тінню — через CSS custom property або Tailwind shadow
- [ ] **Active tab**: додати subtle `shadow-sm` для виділення
- [ ] **Floating windows**: переконатись що вже наявний shadow достатній з новою палітрою

## Clarify (питання перед імплементацією)

- [Х] **oklch gamut clipping у різних браузерах**
  - Чому це важливо: oklch ще відносно новий, деякі значення chroma можуть виходити за gamut sRGB
  - Варіанти: A) перевірити всі запропоновані oklch значення через https://oklch.com/ на sRGB gamut, B) додати fallback через CSS `color()` функцію
  - Вплив на рішення: кросбраузерність
  - **Рішення**: скористатися oklch.com для перевірки. Всі запропоновані значення мають помірний chroma (0.02-0.18) і не повинні виходити за gamut sRGB.

- [Х] **Чи зберігати сумісність з radix-mira preset?**
  - Чому це важливо: shadcn preset radix-mira з baseColor: neutral — це генеровані стилі. Після ручної модифікації globals.css, оновлення через `shadcn add` може перезаписати зміни.
  - Варіанти: A) модифікувати globals.css напряму (простіше), B) створити окремий override layer
  - Вплив на рішення: підтримуваність при оновленнях shadcn
  - **Рішення**: модифікувати globals.css напряму. Shadcn-компоненти не перезаписують globals.css при `shadcn add <component>`, тільки при `shadcn init`.

- [Х] **Окремий файл для kind-кольорів чи в globals.css?**
  - Чому це важливо: CSS custom properties для MetadataKind — це доменна логіка, не загальна тема
  - Варіанти: A) все в globals.css, B) окремий `kind-colors.css` у packages/ui або apps/web
  - Вплив на рішення: організація коду
  - **Рішення**: все в globals.css — один source of truth для CSS-змінних, простіше підтримувати.

## Рекомендовані патерни

### CSS Custom Properties як єдине джерело кольорів
Всі кольори визначаються тільки в `globals.css` через CSS custom properties. Компоненти використовують Tailwind-класи (`text-primary`, `bg-accent`, `border-border`), а не inline oklch значення. Це забезпечує автоматичне переключення dark/light і єдину точку зміни.

### Kind-кольори через CSS-змінні, а не JS-обʼєкт
`KIND_COLORS` зберігає Tailwind-клас (`'text-kind-catalog'`), а не hex/oklch/rgb. Самі значення `--kind-catalog` визначені в `:root`/`.dark` — це дає автоматичне переключення теми без додаткової логіки в React.

### Мінімальна хроматичність для бізнесового відчуття
Chroma-значення в діапазоні 0.01–0.04 для фонових/бордер токенів — ледь помітний відтінок, що створює "тепле" або "холодне" відчуття без кричущих кольорів. Активні елементи (primary, ring, kind-кольори) з вищим chroma 0.10–0.18.

### Семантичні кольори для стану
`success/warning/info/destructive` — чотири семантичних токени покривають всі потреби status feedback. Не створювати більше.

### Контрастність за WCAG AA
При зміні кольорів перевіряти контрастне відношення тексту до фону — мінімум 4.5:1 для нормального тексту, 3:1 для великого тексту (>18px bold). Інструмент: https://oklch.com/ або браузерний DevTools.

## Антипатерни (уникати)

### ❌ Inline кольори в компонентах
Не використовувати `style={{ color: 'oklch(0.70 0.12 220)' }}` або `className="text-[oklch(0.70_0.12_220)]"`. Тільки CSS-змінні через Tailwind-класи. Інакше зміна теми потребуватиме правок у десятках файлів.

### ❌ Різні кольорові системи одночасно
Не змішувати oklch, hsl, hex у одному файлі globals.css. Залишити **тільки oklch** — це вже використовується, і oklch забезпечує перцептуальну однорідність яскравості.

### ❌ Занадто насичені кольори для IDE
Chroma > 0.20 створить "веселковий" ефект, невідповідний для data-dense business IDE. Kind-кольори мають бути **пастельними** (chroma 0.06–0.15), не неоновими.

### ❌ Зміна розмірів, відступів, padding
Ця задача — тільки кольори, бордери, тіні. НЕ змінювати `h-*`, `px-*`, `py-*`, `gap-*`, `text-xs`, `text-sm`, `size-*` — ці значення вже затверджені.

### ❌ Створення кастомних CSS-класів поза Tailwind
Не створювати `.kind-catalog { color: ... }`. Використовувати `@theme inline` + CSS-змінні → Tailwind сам генерує утиліти.

### ❌ Видалення існуючих CSS-змінних
Не видаляти жодну змінну з `@theme inline` блоку — shadcn-компоненти покладаються на повний набір. Тільки змінити значення та додати нові.

### ❌ Зміна destructive токену
`--destructive` вже має хроматичне значення (червоний) — не змінювати його. Він правильний.

## Архітектурні рішення

```
globals.css
├── @theme inline { ... }              ← додати нові --color-kind-*, --color-success, --color-warning, --color-info
├── :root { ... }                      ← оновити всі токени light theme + додати нові
├── .dark { ... }                      ← оновити всі токени dark theme + додати нові
└── @layer base { ... }                ← без змін

metadata-icons.ts
├── KIND_ICONS (існуючий)              ← без змін
└── KIND_COLORS (новий)                ← Record<MetadataKind, string> — Tailwind CSS класи

Компоненти (мінімальні зміни):
├── tree-panel.tsx                     ← KIND_COLORS на іконках, border-l на selected
├── tab-bar.tsx                        ← border-b-2 на active tab, badge кольори
├── object-editor.tsx                  ← KIND_COLORS на іконці заголовка
├── attribute-table.tsx                ← перевірити що accent помітний (може не потребувати змін)
├── status-bar.tsx                     ← семантичні кольори для статусів
└── top-bar.tsx                        ← warning колір для dirty indicator
```

## Порядок виконання

1. Оновити CSS-токени в `globals.css` (Частина 1 + 2) — це змінить вигляд **всього** UI одразу
2. Додати kind-кольори як CSS custom properties в `globals.css` (Частина 3 — CSS частина)
3. Створити `KIND_COLORS` у `metadata-icons.ts` (Частина 3 — JS частина)
4. Оновити компоненти для застосування kind-кольорів та семантичних кольорів (Частина 4)
5. Перевірити тіні та бордери (Частина 5)
6. Візуальна перевірка в обох темах (dark + light)
7. `pnpm build && pnpm lint && pnpm typecheck`

## Пов'язана документація

- `docs/architecture/OVERVIEW.md` — загальна архітектура
- `docs/BRD-metadata-configurator.md` — бізнес-вимоги (§9 UI layout)
- `.github/instructions/ui-architecture.instructions.md` — правила UI
- `.github/instructions/coding-style.instructions.md` — стиль коду
- `packages/ui/components.json` — конфігурація shadcn (radix-mira, neutral, hugeicons)

## Definition of Done

- [ ] Всі CSS-токени в `:root` і `.dark` мають ненульовий chroma (окрім pure white/black де це семантично правильно)
- [ ] `--success`, `--warning`, `--info` з відповідними foreground-токенами додані і зареєстровані в `@theme inline`
- [ ] `KIND_COLORS` маппінг створений у `metadata-icons.ts`
- [ ] Kind-кольори визначені через CSS custom properties і автоматично перемикаються між dark/light
- [ ] Іконки в дереві метаданих мають унікальний колір на кожен тип
- [ ] Активна вкладка має чіткий візуальний індикатор (border-b primary)
- [ ] Selected tree node має чіткий візуальний індикатор (border-l primary)
- [ ] Status bar використовує семантичні кольори (success/warning/destructive)
- [ ] Focus ring (`--ring`) помітний при keyboard navigation
- [ ] Обидві теми (dark + light) виглядають контрастно і читабельно
- [ ] Контрастність тексту ≥ 4.5:1 (WCAG AA) для обох тем
- [ ] Розміри, відступи, padding компонентів НЕ змінені
- [ ] Жодних inline кольорів — тільки CSS vars через Tailwind
- [ ] `pnpm build && pnpm lint && pnpm typecheck` — green
