---
applyTo: '**/*'
description: 'Форматування, перевірки, середовище та workflow'
---

## Стандартні скрипти

### Команди через Turbo (корінь монорепо):
```bash
pnpm dev          # Запуск dev-сервера (apps/web)
pnpm build        # Продакшн збірка всіх пакетів
pnpm test         # Запуск тестів (Vitest)
pnpm typecheck    # Перевірка типів TypeScript
pnpm lint         # Лінтинг (ESLint 9 flat config)
```

### Команди для окремого пакета:
```bash
pnpm --filter @simetra/core test
pnpm --filter @simetra/core typecheck
pnpm --filter web dev
pnpm --filter web build
```

## Тестування
- Unit тести: Vitest (`pnpm test`)
- Тести Zod-схем: `packages/core/src/__tests__/`
- При додаванні нової Zod-схеми — обов'язково додати тести валідації

## Робота в терміналі
- **ОС**: Linux
- **Термінал**: bash
- **Розділювач команд**: `&&` або `;`
- **Шляхи**: Використовуй прямі слеші `/`

## Перед PR
1. `pnpm lint ; pnpm typecheck`
2. `pnpm test` — запусти тести
3. Онови документацію/інструкції, якщо змінюється поведінка
4. Переконайся, що артефакти не потрапили у staged files

## Додавання shadcn/ui компонентів
```bash
pnpm dlx shadcn@latest add <component> -c apps/web
```

## Документація
- Високорівнева структура — `docs/architecture/OVERVIEW.md`
- Бізнес-вимоги — `docs/BRD-metadata-configurator.md`
- README у пакетах тримай лаконічними: призначення, встановлення, API
