# ADR-0063: Тести без CLI провайдера: pgTAP через Vitest, основний стек — docker compose профілю postgres, supabase — регресійний

Status: accepted 2026-10-23
Decided by: owner
Spec: [спека профілів провайдера](../superpowers/specs/2026-10-23-provider-profiles-design.md) §2 (ПП6); [спека профілю postgres](../superpowers/specs/2026-11-08-postgres-profile-design.md) §2 (ПГ13), §10; [спека П2](../superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md) §2 (М7, замінено)

## Context

Початково тести й тінь спиралися на локальний стек Supabase (М7 спеки П2: образ провайдера тієї самої мажорної версії). Профіль `postgres` (ADR-0057) не має CLI провайдера, а основний профіль мусить бути основним і в тестах.

## Decision

- pgTAP-набори йдуть через тонкий Vitest-раннер в обох профілях: тегована база, транзакція з `ROLLBACK`, роль, claims (ПП6, ПГ13). `supabase test db` і `supabase db lint` — лише профіль `supabase`; `plpgsql_check` — напряму.
- Тінь і копія доказу в `postgres` — чистий Postgres тієї самої мажорної версії.
- Стек розробки й CI профілю `postgres` — docker compose: Postgres 17 (образ репо з pgTAP і `plpgsql_check`), Centrifugo, Garage; команди `pnpm db:pg:*`. DB-тести типово йдуть на ньому; стек `supabase` — регресійний (ПГ13).
- Рішення М7 (локальний стек Supabase як крок 0) замінено цим ADR.

## Why

- Тінь на чистому Postgres уже доведено (платформна спека §6.2, «Тіньова БД») (ПП6).
- Основний профіль має бути основним і в тестах; спільна дисципліна stack-guard діє на обох стеках (ПГ13).

## Rejected

- Залежність тестів від `supabase test db` — прив'язала б їх до CLI одного провайдера (ПП6).
- Стек `supabase` як основний тестовий — суперечить ADR-0084.

## Consequences

Тести, прив'язані до Supabase (`*.supabase.db.test.ts`), живуть окремим регресійним проєктом; тест, що вживає ролі чи схеми Supabase поза ним, переводиться на дані профілю, а не перейменовується. Раннер відхиляє набір pgTAP з операторами керування транзакцією.
