# TanStack DB 1.0 RC: що змінилось для фасаду колекцій T4

## Про цей документ

- **Питання.** Що TanStack DB 1.0 RC змінює для фасаду колекцій і запису T4
  і як переносити фасад першого споживача на платформу.
- **Дата.** 2026-11-04. Версії й поведінку бібліотек перевірено на цю дату
  (npm registry, документація й CHANGELOG у репозиторії TanStack/db,
  опубліковані тарболи).
- **Метод.** Документація й CHANGELOG TanStack DB, гайд міграції на RC,
  вміст опублікованих тарболів, експериментальна міграція фасаду запису
  першого споживача з версії до RC на RC. Кожен зовнішній факт має URL.
- **Куди лягли рішення.** Факти бібліотеки — [платформна
  спека](../../superpowers/specs/2026-09-24-simetra-platform-design.md) §8.1,
  §11, §13; версії й умови — [карта
  перевикористання](../stack/reuse-map-2026-09.md) розділ 6; відкрите
  питання — [спека П4](../../superpowers/specs/2026-10-26-p4-runtime-design.md)
  §9.
- **Статус.** Вхід для спеки П4-B, не ухвалено.

## 1. Факти RC

Версії на 2026-11-04: `@tanstack/db` і `@tanstack/react-db` 1.0.0-rc.1.3,
`@tanstack/query-db-collection` 1.5.1, `@tanstack/offline-transactions`
1.2.0. Перший RC вийшов 2026-10-29, дати стабільного 1.0 не оголошено [1].

- **Залежності.** `react-db` залежить від `db` точною версією;
  query-db-collection і offline-transactions беруть `db` як peer
  `^1.0.0-rc.0` (npm registry).
- **Write-back явний.** Після обробника мутації автоматичного рефетчу немає,
  `{ refetch: false }` прибрано. Обробник повертає `Promise<void>` і сам
  чекає `collection.utils.refetch()` або пише підтверджені рядки через
  `write*`. Якщо він не зробив ні того, ні іншого, оптимістичний рядок після
  завершення транзакції повертається до синхронізованого стану [2][3].
- **Прямі записи не запускають запиту.** В on-demand режимі `write*` латають
  лише ключі, уже присутні в активних результатах. Новий рядок прямого запису
  не має власника-підмножини й переживає вивантаження підмножини. Прибрати
  його може лише пізніший повний необмежений результат того самого скоупу; не
  може — сторінка з `limit`, `offset` чи курсором, невдалий запит і запит,
  розпочатий до запису [4].
- **Решта змін API.** `tx.when('settled')` замість
  `transaction.isPersisted.promise`; `$hasPendingWrites` замість `$synced`;
  `status` і `health` окремо (`crashed`, `collection.health`, `reload()`), у
  хука `isLoadingError`, `isCrashed`, `isSyncError` замість `isError`;
  `write*` повертають проміс, що відхиляється на помилці валідації; ключі
  лише string або number; `LoadSubsetOptions` має `signal`, `refetch`,
  `cursor`, `offset`; ядро залежить від `@tanstack/pacer-lite` і має
  `createPacedMutations` [3][5].
- **Дублікат інстансу.** Дві копії `@tanstack/db` втрачають контекст
  транзакції, бо кожна тримає власний стек. За гайдом міграції dev-збірка в
  браузері тоді кидає `DuplicateDbInstanceError` [5]. У тарболі
  1.0.0-rc.1.3 коду цієї перевірки немає, є лише її оголошення типу; тож
  гейт єдиності — граф модулів бандла
  ([звіт П0 (а)](../../superpowers/specs/2026-11-04-p0-a-host-report.md)).
- **Без змін.** Обчислюваний вираз в `orderBy` разом з `limit()` вимикає
  ліниве завантаження [6].

## 2. Пропозиції для спеки П4-B

1. **Перенести фасад запису першого споживача в T4 як є, одразу на RC.**
   Фасад першого споживача над TanStack DB експериментально перевели з
   версії до RC на 1.0 RC. Код модуля фасаду змін не потребував; єдина зміна
   в обв'язці — тип завершення обробника став `void`. Проміжний перенос на
   версію до RC нічого не дає, а перенос на RC не потребує переписування
   фасаду.
2. **Протокол обробника — `Promise<void>` з першого дня.** Обробник фасаду
   завершується після `write*` підтверджених рядків або після
   `await utils.refetch()` чи перечитування адаптером. Розрахунку на
   автоматичний рефетч у контракті немає [2]. Звідки обробник бере
   підтверджені рядки — відкрите питання: набір змін T3
   ([спека П4](../../superpowers/specs/2026-10-26-p4-runtime-design.md) §6.5)
   несе об'єкт, скоуп, ключ, версію й операцію, а не рядок. Для видалення
   цього досить; для вставки й зміни потрібен рядок із результату команди,
   перечитування адаптером за ключами або `refetch()`.
3. **Чого RC не покриває — фасад лишає це собі:**
   - single-flight оновлення з одним хвостовим запитом: поки триває
     оновлення, нові запити зливаються в один наступний;
   - очікування, поки осядуть усі pending-транзакції колекції: публічного
     API на рівні колекції в RC немає, `tx.when('settled')` діє на одну
     транзакцію;
   - `peek` колекції після `cleanup` повертає `undefined`.
4. **Пачкування сигналів реального часу.** Сигнал веде до перечитування
   адаптером або `refetch()`, тож пачка сигналів має дати один запит.
   Ядро вже залежить від `@tanstack/pacer-lite`; `createPacedMutations`
   стосується мутацій, не сигналів. Чи вистачить `pacer-lite` замість
   `@tanstack/pacer` (0.x, точний pin) — перевірити в П4-B.
5. **Шаблон host-а** ставить `@tanstack/db` у `resolve.dedupe` за списком
   [звіту П0 (а)](../../superpowers/specs/2026-11-04-p0-a-host-report.md);
   єдиність перевіряє граф модулів бандла, а не `DuplicateDbInstanceError`.

## Джерела

1. Блог TanStack, «TanStack DB 1.0 RC1» —
   https://tanstack.com/blog/tanstack-db-1.0-rc1-going-all-in-on-oracles
2. query-collection, «Persistence Handlers» і «Controlling Refetch
   Behavior» —
   https://github.com/TanStack/db/blob/main/docs/collections/query-collection.md
3. CHANGELOG query-db-collection (1.5.0; 1.4.4, #2065) —
   https://github.com/TanStack/db/blob/main/packages/query-db-collection/CHANGELOG.md
4. query-collection, «Direct Writes and Query Sync» —
   https://github.com/TanStack/db/blob/main/docs/collections/query-collection.md#direct-writes-and-query-sync
5. Гайд міграції на RC —
   https://github.com/TanStack/db/blob/main/docs/guides/migrate-to-1-0-rc.md
6. Live queries —
   https://github.com/TanStack/db/blob/main/docs/guides/live-queries.md
