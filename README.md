# Simetra

Відкритий візуальний конфігуратор бізнес-метаданих.

## Структура

```
apps/web               — React SPA (Vite + Tailwind CSS 4 + shadcn/ui)
packages/ui            — Спільні UI-компоненти (shadcn/ui)
packages/core          — Zod-схеми бізнес-метаданих
packages/cli           — CLI для генерації та застосування SQL з метаданих
packages/generator-pg  — Генератор PostgreSQL DDL і posting SQL
packages/generator-api — Контракти API генераторів
```

## Швидкий старт

```bash
pnpm install
pnpm dev
```

## Використання CLI

```bash
# Показати довідку CLI
pnpm simetra generate --help

# Згенерувати SQL з директорії метаданих
pnpm simetra generate --input ./temp/metadata --output ./output

# Застосувати SQL до PostgreSQL бази даних
pnpm simetra apply --connection-string "$SIMETRA_DATABASE_URL" --input ./temp/metadata

# Переглянути SQL без застосування
pnpm simetra apply --dry-run --input ./temp/metadata
```

## Додавання UI-компонентів

```bash
pnpm dlx shadcn@latest add button -c apps/web
```

Компоненти створюються в `packages/ui/src/components` і імпортуються так:

```tsx
import { Button } from '@workspace/ui/components/button'
```

## Ліцензія

[Apache-2.0](LICENSE)
