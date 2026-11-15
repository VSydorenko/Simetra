# ADR-0028: Ядро платформи спирається лише на Postgres 17 і contrib

Status: accepted 2026-10-01
Decided by: owner
Spec: [платформа в Postgres](../superpowers/specs/2026-10-01-platform-in-postgres-design.md) §2 (Р27); [платформна спека](../superpowers/specs/2026-09-24-simetra-platform-design.md) §2 (Р27), §6.12

## Context

Платформа має працювати в різних провайдерів Postgres. Матриця доступності за офіційними переліками Supabase, Neon, RDS і Azure показує, що розширення різняться. Обов'язковий механізм на розширенні одного провайдера зробив би платформу платформою цього провайдера.

## Decision

Обов'язкові механізми платформи спираються лише на Postgres 17 і contrib-розширення, присутні в усіх цільових провайдерів (`pg_trgm`, `unaccent`, `ltree`, `btree_gist`, `btree_gin`, `citext`, `hstore`, `pgcrypto`, `tablefunc`, `postgres_fdw`, `pg_stat_statements`). `pg_cron`, `pg_partman` і тригери подій DDL — через абстракцію з визначеною поведінкою без них. `pgmq`, `pg_net`, Vault, Realtime, Storage, `pg_jsonschema`, pgTAP — профіль провайдера із запасним шляхом. Не будувати на `plv8`, `timescaledb`, `pg_ivm`, `pgsodium`, `pgjwt`, `periods`, `temporal_tables`. Логіка в базі — лише SQL і PL/pgSQL.

## Why

- Матриця доступності розширень у чотирьох провайдерів: обов'язковий механізм на розширенні профілю зробив би платформу платформою одного провайдера ([спека](../superpowers/specs/2026-10-01-platform-in-postgres-design.md) §2, Р27; [платформна спека](../superpowers/specs/2026-09-24-simetra-platform-design.md) §6.12).
- JavaScript у базі в цільових провайдерів недоступний, тож `plv8` не підстава.

## Rejected

- Залежність від розширення одного провайдера — привʼязує платформу до нього.
- `pg_ivm` для підсумків регістрів — ексклюзивне блокування всього подання, без секціонування (див. ADR-0023).

## Consequences

Легше: перенесення між провайдерами й self-host. Важче: де розширення дало б простіше рішення, платформа дає запасний шлях (наприклад, outbox-таблиця з `SKIP LOCKED` без `pgmq`). Профіль провайдера (ADR-0057) задає відмінності поверх ядра. Не «виправляти»: розширення з переліку «не будувати» не вводити як обов'язкові.
