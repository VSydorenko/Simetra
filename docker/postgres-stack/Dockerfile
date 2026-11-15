# Postgres стека `postgres`: офіційний образ і розширення з PGDG, що вже
# підключений в образі. Пакети розширень з точною версією: без неї apt
# підтягнув би з PGDG новіший сервер, ніж у базовому образі, і тег образу
# збрехав би. Пакет `postgresql-17` тут не ставиться і версії не має: сервер
# приходить з базового образу, а розширення залежать від нього. Версію сервера
# збірка не змінює; пін розширень оновлюється разом з базовим образом.
#
# PGDG тримає в основному джерелі лише найновішу збірку пакета, тож пін старішої
# версії зник би з нього після першого ж оновлення. Архів `apt-archive`
# зберігає всі збірки: його джерело додано поряд, і пін лишається доступним.
# Архів віддається лише по HTTPS, а базовий образ не має кореневих
# сертифікатів, тож `ca-certificates` ставиться першим кроком без піна: пакет
# не впливає на версію сервера чи розширень, а його пін живе лише в
# trixie-security і зникає з індексу після наступного оновлення безпеки.
# Відновлення: якщо apt не знаходить версію (ні в основному джерелі, ні в
# архіві), оновіть піни пакетів і дайджест базового образу разом.
FROM postgres:17.12-trixie@sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && echo "deb [signed-by=/usr/local/share/keyrings/postgres.gpg.asc] https://apt-archive.postgresql.org/pub/repos/apt trixie-pgdg-archive main" \
    > /etc/apt/sources.list.d/pgdg-archive.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql-17-pgtap=1.3.4-1.pgdg13+2 \
    postgresql-17-plpgsql-check=2.10.16-1.pgdg13+2 \
  && rm -rf /var/lib/apt/lists/*

# Після встановлення пакетів: інший хеш не скидає кеш шару apt
ARG SIMETRA_STACK_FILES_HASH
LABEL simetra.stack-files-hash=$SIMETRA_STACK_FILES_HASH
