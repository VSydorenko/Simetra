# П4-B3-3c. Хуки, компонент списку й лінт T5 — план імплементації

> **Виконання:** `agent-kit:execute`. Частини c1 і c2 плану
> [B3-3](2026-11-08-p4-b3-3-window-public-api.md): його шапка, глобальні
> обмеження, рішення, інтерфейси й інваріанти діють і тут. Старт — після
> мерджу частини a2-Л (тонкий зріз М3,
> [ADR-0091](../../adr/0091-m3-thin-slice-scale-later.md)); перед стартом — `orient --plan` цього файла.

**Мета.** T4 дає хуки `useRows`, `useRow` і `DataRuntimeProvider` (вхід
`simetra/data/react`), T5 — компонент списку на TanStack Virtual (вхід
`./ui`) з правилами лінту зони T5. Спека: П4-B §3, §6.4, §6.5, §12; [звіт
спайку 4](../specs/2026-11-08-t4-window-spike-report.md) §6.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р6 | Хуки й провайдер — окремий вхід `simetra/data/react` (`simetra/data` без `react`). DOM-типи — окремий проєкт `tsconfig.dom.json` для `src/ui/**`, `src/data/react/**` і jsdom-тестів; основний `tsconfig.json` їх виключає, `typecheck` перевіряє обидва (інакше DOM-глобали побачив би T0). Публічний тримач — `runtime/holder.ts`; `runtime/handle.ts` лишається внутрішнім | §3, §12 рядок пакування (задача 0 B3-3) |
| Р7 | `@tanstack/react-virtual` — необов'язковий peer входу `./ui` з точним dev-піном і групою syncpack `sameRange`; вхід tsdown і `publishConfig.exports` `./ui` (dev-експорт `./ui` уже є) | §3 (задача 0) |

## Частини й задачі

### c1 — хуки (PR 4, після a2-Л)

#### Задача 10 — Хуки й провайдер

`src/data/react/` (`index.ts`, `provider.ts`, `use-rows.ts`,
`use-row.ts`), `runtime/holder.ts`, `tsconfig.dom.json`, `tsconfig.json`,
скрипт `typecheck`, `tsdown.config.ts` і exports `./data/react`, лінт-зона T4
(`src/data/react/**` може імпортувати `react`), `src/data/index.ts` (лише
`createRuntimeHolder` і типи), devDependencies (`jsdom`,
`@testing-library/react`, `@testing-library/dom`, `react-dom`,
`@types/react`, `@types/react-dom`), тест пакування
`published-packages.pack.test.ts`. Інтерфейс:
`RuntimeHolder = { current(); closed(); replace(next, reason?); subscribe(listener) }`;
`useRow({ object, id, tabularSections? })` →
`{ row, tabularSections, version, editable, status, error?, needsRefresh, isStale }`.
Готово: jsdom `hooks.test.ts` за рядком §12 «unit T4 (публічний API)»;
`removed`, `purged`, `hidden` — у тому самому кадрі, що й ядро; StrictMode без запиту й порожнього кадру; закритий рантайм — сталий
знімок з причиною, не `loading`; `.d.ts` без сесії, сховищ, `Scope` і
`@tanstack/*`; споживач без `react` імпортує `simetra/data`. `run-tests unit --filter hooks`; пакування — CI.

### c2 — компонент списку, вхід `./ui`, лінт T5 (PR 5, після c1)

#### Задача 11 — `VirtualList` і `./ui`

`src/ui/list/virtual-list.ts`,
`src/ui/index.ts`, `package.json` (Р7), `tsdown.config.ts`, syncpack, тест
пакування (`./ui` у exports; `react` і `@tanstack/react-virtual` —
необов'язкові peer; серверний споживач без них). Компонент — за §6.4 і звітом
спайку 4 §6 (ключ слота за ключем рядка, один `translateY`, вимкнена
вбудована компенсація росту, якір у layout-ефекті, перемонтування за `chain`,
SSR через `initialRect`; діапазон — у `setVisibleRange` (у М3 без дії, Р13 плану B3-3), після гідратації —
лише після першої прокрутки; `removed` — слот того самого розміру). Готово:
контрактний тест на піні (компенсація є за замовчуванням, її вимикає
властивість екземпляра, версії дорівнюють піну) і jsdom `virtual-list.test.ts`
з підміненими вимірами (ріст висоти над видимими — зсув рівно на приріст).
`run-tests unit --filter virtual`.

#### Задача 12 — Лінт зони T5

за §3 і §12: `eslint.tier-zones.js`,
`eslint.standard-columns.js` (селектори T5 і стандартних колонок — в одних
опціях `no-restricted-syntax`, бо пізніший блок заміняє опції цілком;
атрибути — і як `JSXAttribute`, і як `Property` props `createElement`;
віртуалізатор, `onScroll` і `addEventListener("scroll")` дозволені лише в
`src/ui/list/**`). Готово: негативні тести `tier-boundary.test.ts` на `.ts` і
`.tsx` на кожне правило; ярусні заборони й правила стандартних колонок
лишаються в обох теках. `run-tests unit --filter tier-boundary`.

Задача 13 (спека після виміру пам'яті вікна, §14.3) → #206. Рядки
Додатку А спеки П4-B для B3-3 позначає документний PR ⑩ (D4).

## Задачі власника

Немає.
