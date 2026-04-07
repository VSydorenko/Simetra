# Simetra

Open-source visual business metadata configurator.

## Structure

```
apps/web            — React SPA (Vite + Tailwind CSS 4 + shadcn/ui)
packages/ui         — Shared UI components (shadcn/ui)
packages/core       — Business metadata schemas (Zod)
packages/cli        — CLI for SQL generation from metadata
packages/generator-pg  — PostgreSQL DDL generator
packages/generator-api — Generator API contracts
```

## Getting Started

```bash
pnpm install
pnpm dev
```

## CLI Usage

```bash
# Show CLI help
pnpm simetra generate --help

# Generate SQL from metadata directory
pnpm simetra generate --input ./temp/metadata --output ./output
```

## Adding UI Components

```bash
pnpm dlx shadcn@latest add button -c apps/web
```

Components are placed in `packages/ui/src/components` and imported as:

```tsx
import { Button } from "@workspace/ui/components/button";
```

## License

[Apache-2.0](LICENSE)
