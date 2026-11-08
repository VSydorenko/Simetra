# Postgres стека `postgres`: офіційний образ і розширення з PGDG, що вже
# підключений в образі. Пакети без точної версії: основний репозиторій PGDG
# тримає лише останню, і пін зламав би збірку з першим оновленням.
FROM postgres:17.11-trixie@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql-17-pgtap \
    postgresql-17-plpgsql-check \
  && rm -rf /var/lib/apt/lists/*
