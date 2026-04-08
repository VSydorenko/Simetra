# Simetra

Відкритий візуальний конфігуратор бізнес-метаданих.

## Структура

```
apps/web               — React SPA (Vite + Tailwind CSS 4 + shadcn/ui)
apps/runtime           — Runtime dev preview host (Vite + metadata serving + provider bootstrap)
packages/ui            — Спільні UI-компоненти (shadcn/ui)
packages/core          — Zod-схеми бізнес-метаданих
packages/form-runtime  — Runtime-рендерінг форм і domain-компоненти
packages/app-runtime   — Runtime shell, routing і стандартні сторінки
packages/data-provider — Контракт доступу до даних і in-memory provider
packages/data-provider-postgrest — PostgREST adapter для runtime data access
packages/cli           — CLI для генерації та застосування SQL з метаданих
packages/generator-pg  — Генератор PostgreSQL DDL і posting SQL
packages/generator-api — Контракти API генераторів
```

## Швидкий старт

```bash
pnpm install
pnpm dev
```

## Runtime Dev Preview

```bash
cp apps/runtime/.env.example apps/runtime/.env.local

# Вкажіть абсолютний шлях до каталогу metadata в apps/runtime/.env.local
pnpm dev:runtime
```

За замовчуванням runtime запускається з `VITE_SIMETRA_DATA_PROVIDER=mock`. Для PostgREST/Supabase-compatible API змініть `.env.local` на `VITE_SIMETRA_DATA_PROVIDER=postgrest` і задайте `VITE_SIMETRA_API_URL`.

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
