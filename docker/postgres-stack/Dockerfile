# Postgres стека `postgres`: офіційний образ і розширення з PGDG, що вже
# підключений в образі. Пакети розширень з точною версією: без неї apt
# підтягнув би з PGDG новіший сервер, ніж у базовому образі, і тег образу
# збрехав би. Пакет `postgresql-17` тут не ставиться і версії не має: сервер
# приходить з базового образу, а розширення залежать від нього. Версію сервера
# збірка не змінює; пін розширень оновлюється разом з базовим образом.
FROM postgres:17.12-trixie@sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql-17-pgtap=1.3.4-1.pgdg13+2 \
    postgresql-17-plpgsql-check=2.10.16-1.pgdg13+2 \
  && rm -rf /var/lib/apt/lists/*

# Після встановлення пакетів: інший хеш не скидає кеш шару apt
ARG SIMETRA_STACK_FILES_HASH
LABEL simetra.stack-files-hash=$SIMETRA_STACK_FILES_HASH
