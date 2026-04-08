# @simetra/cli

CLI для генерації та застосування SQL з метаданих Simetra.

## Запуск

```bash
# З кореня монорепо
pnpm simetra generate --help

# Або напряму для пакета CLI
pnpm --filter @simetra/cli exec tsx src/index.ts generate --help
```

## Команда `generate`

Генерація SQL з директорії метаданих проєкту.

```bash
simetra generate [OPTIONS]
```

### Аргументи

| Аргумент | Опис | За замовчуванням |
|---|---|---|
| `--target` | Цільова база даних | `postgresql` |
| `--input` | Шлях до директорії з метаданими | `.` |
| `--output` | Шлях для збереження результату | `./output` |
| `--schema` | SQL schema | `public` |
| `--enum-strategy` | Стратегія enum: `pgEnum`, `lookupTable` | `pgEnum` |
| `--constants-strategy` | Стратегія констант: `singleTable`, `separateTables` | `singleTable` |
| `--output-mode` | Режим виводу: `singleFile`, `perObject` | `singleFile` |

### Приклад

```bash
pnpm simetra generate --input ./temp/metadata --output ./output --schema public
```

## Команда `apply`

Застосування згенерованого SQL до PostgreSQL.

```bash
simetra apply [OPTIONS]
```

### Аргументи

| Аргумент | Опис | За замовчуванням |
|---|---|---|
| `--connection-string` | PostgreSQL connection string. Якщо не передано, використовується `SIMETRA_DATABASE_URL` | — |
| `--input` | Шлях до директорії з метаданими | `.` |
| `--schema` | SQL schema | `public` |
| `--dry-run` | Показати SQL без виконання | `false` |
| `--enum-strategy` | Стратегія enum: `pgEnum`, `lookupTable` | `pgEnum` |
| `--constants-strategy` | Стратегія констант: `singleTable`, `separateTables` | `singleTable` |
| `--allow-destructive` | Дозволити деструктивні зміни (`DROP TABLE`, `DROP COLUMN`) | `false` |

### Diff схеми

Якщо в директорії метаданих уже існує snapshot `.simetra/applied-schema.json`, команда автоматично:

- будує новий snapshot зі стану метаданих;
- обчислює diff між applied state і новою схемою;
- генерує `ALTER TABLE` міграцію замість повного початкового DDL.

Для деструктивних змін CLI вимагає явний прапорець `--allow-destructive`.

### Приклади

```bash
# Застосувати SQL до PostgreSQL
pnpm simetra apply --connection-string "$SIMETRA_DATABASE_URL" --input ./temp/metadata

# Попередній перегляд без виконання
pnpm simetra apply --dry-run --input ./temp/metadata

# Дозволити деструктивні зміни після явного підтвердження через прапорець
pnpm simetra apply --connection-string "$SIMETRA_DATABASE_URL" --input ./temp/metadata --allow-destructive
```

## Технічні деталі

CLI використовує `tsx` як TypeScript runtime, оскільки workspace-пакети (`@simetra/core`, `@simetra/generator-pg`) експортують `.ts` source напряму.

## Ліцензія

[Apache-2.0](../../LICENSE)
