# ADR-0062: Провайдер ідентичності — запис пресету, а не новий SQL; у postgres — Better Auth, claims формує host, JWT для бази немає

Status: accepted 2026-10-23
Decided by: owner
Spec: [спека профілів провайдера](../superpowers/specs/2026-10-23-provider-profiles-design.md) §2 (ПП5); [спека профілю postgres](../superpowers/specs/2026-11-08-postgres-profile-design.md) §2 (ПГ4, ПГ5), §4; [спека П4](../superpowers/specs/2026-10-26-p4-runtime-design.md) §5 (Рт19)

## Context

Модель ідентичності (`simetra.identities (provider, subject)` і провізія користувача, ADR-0046, ADR-0047) уже нейтральна до провайдера. Профіль `postgres` (ADR-0057) потребує стороннього провайдера ідентичності, а ключ облікового запису мусить бути uuid і збігатися з `id` довідника «Користувачі».

## Decision

- Новий провайдер ідентичності — новий запис даних `PROVIDER_IDENTITY_SOURCES` і `PROVIDER_API_ROLES` у T0, а не новий SQL: провізія одна (ПП5, ПГ4).
- У `postgres` провайдер — Better Auth зі схемою `better_auth`, uuid-ключем (`advanced.database.generateId: "uuid"`) і плагіном `anonymous`; ключ провайдера в `identities` — `better-auth`.
- Claims сесії формує host із сесії провайдера (`{ sub, is_anonymous }`); JWT для бази немає, claims ставить `set_config` (ПГ5). `role`, `iss` і `aud` у claims не потрібні: роль ставить `runCommand` чи читання.
- Форма claims (`SessionClaims`) і порт `verifySession(headers)` — у T0; реалізація й перевірка підпису — домен host-а, T3 їх не перевіряє. Ідентичність база бере з `sub` і `providerKey`, а не з `iss` (Рт19).
- Шаблон host-а не вмикає кеш сесії в cookie.

## Why

- Контракт сесії (`request.jwt.claims` і `current_user_id()`) не залежить від провайдера; `auth.uid()` лишається деталлю адаптера Supabase (ПП5, ПГ5).
- Підпис JWT лише для бази — зайвий секрет і другий шлях автентифікації (ПГ5).
- Перевірка сесії залежить від провайдера й живе там, де host має заголовки запиту (Рт19).
- Кеш сесії в cookie продовжив би життя відкликаної сесії до `maxAge` без звернення до бази (спека профілю postgres §4.4).

## Rejected

- Новий SQL для кожного провайдера — множить провізію (ПП5).
- JWT, підписаний для бази — другий шлях автентифікації й секрет (ПП5, ПГ5).
- Перевірка підпису в T3 — залежала б від провайдера (Рт19).

## Consequences

Пакет `simetra` не залежить від `better-auth`: адаптер сесії — у шаблоні host-а. Анонімна сесія читає як гість (роль за claim `is_anonymous`), команд їй немає. Недійсність користувача діє з наступного запиту, бо claims формуються на кожен запит.
