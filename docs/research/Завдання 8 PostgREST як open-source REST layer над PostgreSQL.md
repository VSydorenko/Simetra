# PostgREST як open-source REST layer над PostgreSQL для Simetra

**PostgREST є окремим open-source сервером, що автоматично публікує REST API поверх звичайної PostgreSQL-бази.** Це не функція самої PostgreSQL і не ексклюзив Supabase: Supabase використовує PostgREST як частину свого managed-стеку, але той самий API-шар можна розгорнути самостійно через Docker, systemd або інший deployment. Для Simetra це сильний кандидат на перший runtime adapter у Phase 3: він добре покриває CRUD, фільтрацію, пагінацію, RPC-виклики для posting functions і працює поверх уже згенерованої PostgreSQL-схеми без написання окремого backend CRUD-шару.

---

## 1. Що таке PostgREST

PostgREST — це standalone web server, який підключається до PostgreSQL і автоматично перетворює таблиці, views та SQL-функції на HTTP API. Структура endpoint-ів, доступні операції та видимість даних визначаються не кодом контролерів, а схемою БД, правами ролей і RLS-політиками.

Ключова ідея PostgREST: **database as single source of truth**. Логіка моделі живе в PostgreSQL, а HTTP-шар лише надає стандартизований доступ до вже описаних об'єктів.

Для Simetra це добре стикується з уже прийнятою архітектурою:

- `@simetra/core` описує бізнес-метадані
- `@simetra/generator-pg` генерує PostgreSQL DDL і posting functions
- runtime не мусить мати окремий handwritten CRUD backend
- `@simetra/data-provider-postgrest` може напряму працювати з таблицями і RPC-функціями, які вже створює генератор

---

## 2. Open-source статус і офіційні джерела

| Ресурс | URL | Примітка |
|---|---|---|
| Офіційний сайт | https://postgrest.org/ | Перенаправляє на актуальну документацію |
| Документація | https://docs.postgrest.org/en/stable/ | Головна точка входу |
| GitHub | https://github.com/PostgREST/postgrest | Канонічний репозиторій |
| Docker image | https://hub.docker.com/r/postgrest/postgrest | Офіційний контейнер |
| Releases | https://github.com/PostgREST/postgrest/releases | Версії та changelog |

**Ліцензія:** MIT.

Це важливо для Simetra: PostgREST можна вільно використовувати як частину self-hosted рішення або як reference adapter без ліцензійних обмежень типу copyleft на інтеграцію.

---

## 3. Що PostgREST дає з коробки

### 3.1. Автоматичний REST для таблиць і views

Кожна доступна таблиця або view може бути доступна як resource. Типові операції:

- `GET /table` — список записів
- `GET /table?id=eq.<uuid>` — читання конкретного запису
- `POST /table` — створення
- `PATCH /table?id=eq.<uuid>` — оновлення
- `DELETE /table?id=eq.<uuid>` — видалення

### 3.2. Потужна фільтрація через query parameters

PostgREST підтримує:

- фільтри `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `like`, `ilike`, `in`
- сортування через `order`
- пагінацію через `limit`, `offset`, range-заголовки
- підрахунок кількості рядків через `Prefer: count=exact` або related механізми
- вибір колонок через `select`

Для runtime-списків Simetra цього достатньо для MVP list/grid сценаріїв без окремого search backend.

### 3.3. RPC для SQL-функцій

SQL-функції в PostgreSQL можуть публікуватися як endpoint-и виду:

- `POST /rpc/function_name`

Це критично для Simetra, бо posting/unposting документів уже моделюється не як простий CRUD, а як виклик згенерованих PostgreSQL functions.

### 3.4. OpenAPI

PostgREST автоматично віддає OpenAPI-опис API. Це корисно для:

- ручної інспекції доступних endpoint-ів
- майбутнього автогенерування клієнтів
- швидкої діагностики, що саме реально експонує schema і права доступу

---

## 4. Що PostgREST не робить

PostgREST не є повноцінною backend-платформою на кшталт Supabase або custom application server. Він **не вирішує**:

- автентифікацію користувачів як продуктову функцію сам по собі
- UI runtime або form rendering
- бізнес-семантику рівня «документ», «довідник», «регістр»
- orchestration складних workflow поза SQL/RPC
- файлове сховище, realtime, cron, edge functions

Для Simetra це означає: PostgREST закриває **транспортний шар даних**, але не замінює form-runtime, metadata model або application runtime.

---

## 5. Як він розгортається

PostgREST не вбудований у PostgreSQL. Щоб отримати automatic REST над plain PostgreSQL, потрібен окремий процес PostgREST, який підключається до бази.

### 5.1. Мінімальний standalone stack

```text
Browser / Runtime app
        ↓ HTTP
    PostgREST
        ↓ SQL
    PostgreSQL
```

Практично це можна розгорнути як:

- Docker-контейнер `postgrest/postgrest`
- systemd service на Linux
- контейнер у compose/k8s поряд із PostgreSQL
- reverse proxy через Nginx або Traefik

### 5.2. Supabase як managed-варіант

У Supabase PostgREST уже присутній у складі платформи. Тобто:

- **Supabase Data API** = керований PostgREST endpoint
- додатково Supabase дає auth, storage, edge functions, dashboard, secrets, hosting-інфраструктуру

Висновок для Simetra: Supabase — це зручний deployment target, але не обов'язкова залежність. Для self-hosted сценарію достатньо PostgreSQL + PostgREST.

---

## 6. Безпека і модель доступу

Одна з найсильніших сторін PostgREST — тісна прив'язка до PostgreSQL authorization model.

### 6.1. Ролі та права в БД

Видимість таблиць, views і functions визначається PostgreSQL grants. Якщо роль не має доступу до таблиці або функції, endpoint не працюватиме належним чином незалежно від того, що очікує frontend.

### 6.2. JWT і role switching

PostgREST підтримує роботу з JWT і делегує авторизацію ролям бази даних. Це дозволяє робити fine-grained доступ на рівні самої БД.

### 6.3. RLS

Row Level Security природно вписується в модель PostgREST. Для багатокористувацького runtime це важливо, бо доступ до рядків можна описувати в PostgreSQL, а не дублювати в окремих контролерах.

Для Simetra це потенційно корисно у Phase 4, але для Phase 3 dev preview достатньо простішого режиму з service-role або локальним mock provider.

---

## 7. Можливості PostgREST, релевантні для Simetra Phase 3

### 7.1. Відповідність DataProvider-контракту

| Метод DataProvider | Типовий PostgREST pattern | Коментар для Simetra |
|---|---|---|
| `list()` | `GET /rest/v1/{table}?select=...&order=...&limit=...&offset=...` | Підходить для list renderer |
| `get()` | `GET /rest/v1/{table}?id=eq.{id}` | Підходить для item form edit |
| `create()` | `POST /rest/v1/{table}` | Стандартний insert |
| `update()` | `PATCH /rest/v1/{table}?id=eq.{id}` | Стандартний partial update |
| `delete()` | `DELETE /rest/v1/{table}?id=eq.{id}` | Стандартний delete |
| `searchRef()` | `GET /rest/v1/{table}?or=(code.ilike.*q*,description.ilike.*q*)&limit=20` | Добре лягає на Catalog ref lookup |
| `getRefDisplay()` | `GET /rest/v1/{table}?id=eq.{id}&select=code,description` | Може потребувати thin mapping logic |
| `postDocument()` | `POST /rest/v1/rpc/{post_fn}` | Виклик згенерованої posting function |
| `unpostDocument()` | `POST /rest/v1/rpc/{unpost_fn}` | Аналогічно |
| `getConstants()` | `GET /rest/v1/constants` | Працює для MVP `singleTable` |
| `updateConstant()` | `PATCH /rest/v1/constants?key=eq.{name}` | Простий MVP-патерн |

### 7.2. Що особливо добре збігається з Simetra

- CRUD поверх уже згенерованих таблиць
- RPC-виклики поверх posting/unposting functions
- server-side pagination і sorting для list forms
- відсутність потреби писати окремий Node/.NET backend тільки для базових runtime-операцій

### 7.3. Що потребує обережності

- naming endpoint-ів має збігатися з `@simetra/generator-pg`
- ref lookup вимагає узгоджених display-колонок (`code`, `description`, `number`, `date`)
- polymorphic refs у MVP не лягають на простий lookup без додаткової логіки
- constants strategy `separateTables` не підходить для MVP-контракту без додаткової абстракції

---

## 8. Чому для Simetra обрано не supabase-js, а generic fetch adapter

У Phase 3 task зафіксовано, що `@simetra/data-provider-postgrest` має працювати через `fetch`, а не напряму через `@supabase/supabase-js`.

Причини цього рішення:

- PostgREST є ширшим deployment target, ніж Supabase
- один і той самий adapter можна використовувати і з self-hosted PostgREST, і з Supabase
- form-runtime не блокується на конкретному SDK або vendor API
- простіше тестувати HTTP-рівень через `msw`
- архітектурно чистіше: `@simetra/data-provider` лишається transport-agnostic контрактом

Тобто Supabase SDK може з'явитися окремим adapter-ом у майбутньому, але не повинен визначати MVP runtime boundary.

---

## 9. Обмеження і ризики для Simetra

### 9.1. PostgREST не знає про бізнес-об'єкти Simetra

Для PostgREST таблиця — це просто таблиця. Він не розрізняє Catalog, Document, Constant або Register. Уся бізнес-семантика має залишатися в:

- `@simetra/core`
- autoform/resolution layer
- naming rules з `@simetra/generator-pg`
- DataProvider adapter, який знає, які endpoint-и і поля очікуються

### 9.2. Складні join-сценарії краще виносити у view або RPC

Якщо runtime потребуватиме складних read-моделей, totals, enriched projections або compound searches, краще не перевантажувати frontend ad-hoc параметрами. Практичні варіанти:

- materialized view / view
- SQL function через `/rpc/...`
- спеціальні projection tables

### 9.3. Polymorphic refs — не MVP-friendly

PostgREST добре працює з конкретною таблицею. Але polymorphic ref означає, що lookup залежить від типу цілі, а це вже не простий REST endpoint. Саме тому в Phase 3 вони свідомо позначені як degraded behavior / placeholder.

---

## 10. Рекомендація для Simetra

Для Phase 3 PostgREST є **прагматичним першим runtime transport layer**.

Рекомендований шлях:

1. Залишити `@simetra/data-provider` як чистий TS-контракт.
2. Реалізувати `@simetra/data-provider-postgrest` через generic `fetch`.
3. Використовувати naming helpers із `@simetra/generator-pg`, а не дублювати PascalCase → snake_case.
4. Обмежити MVP простими CRUD, ref lookup, constants `singleTable` і document RPC.
5. Для локальної розробки підтримувати mock provider, щоб runtime не залежав від піднятого PostgREST.

Це дає Simetra хороший баланс між швидкістю реалізації, простотою self-hosting і чистотою архітектурних меж.

---

## 11. Висновок

PostgREST — це не «магія Supabase» і не функція PostgreSQL, а окремий open-source сервер, який добре підходить як тонкий data-access layer поверх уже згенерованої PostgreSQL-схеми. Для Simetra його сила в тому, що він дозволяє закрити runtime CRUD і RPC без побудови окремого application backend для MVP. При цьому він не підміняє form-runtime, metadata model або production app shell, а займає чітке місце в архітектурі: **adapter між runtime UI і PostgreSQL**.

---

## 12. Корисні посилання

- Офіційна документація: https://docs.postgrest.org/en/stable/
- Installation: https://docs.postgrest.org/en/stable/explanations/install.html
- API reference: https://docs.postgrest.org/en/stable/references/api.html
- Authentication: https://docs.postgrest.org/en/stable/references/auth.html
- Configuration: https://docs.postgrest.org/en/stable/references/configuration.html
- Architecture: https://docs.postgrest.org/en/stable/explanations/architecture.html
- GitHub: https://github.com/PostgREST/postgrest
- Docker image: https://hub.docker.com/r/postgrest/postgrest
- Supabase architecture overview: https://supabase.com/docs/guides/getting-started/architecture