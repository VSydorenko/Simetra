# @simetra/cli

CLI для генерації SQL з метаданих Simetra.

## Запуск

```bash
# З кореня монорепо
node packages/cli/bin/simetra.mjs generate --help

# Або через pnpm
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
simetra generate --input ./temp/metadata --output ./output --schema public
```

## Технічні деталі

CLI використовує `tsx` як TypeScript runtime, оскільки workspace-пакети (`@simetra/core`, `@simetra/generator-pg`) експортують `.ts` source напряму.

## Ліцензія

[Apache-2.0](../../LICENSE)
