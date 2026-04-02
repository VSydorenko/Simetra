---
applyTo: '**/*'
description: 'Базові архітектурні правила Simetra'
---

## ✅ ALWAYS
- Дотримуйся поділу пакетів: `packages/core` — чистий TS без UI/Node, `packages/ui` — shadcn/ui компоненти, `apps/web` — React SPA.
- Будь-які зміни в архітектурі звіряй з документацією:
  - `docs/architecture/OVERVIEW.md`
  - `docs/BRD-metadata-configurator.md` — специфікація типів метаданих
- `@simetra/core` — серцевина. Не залежить ні від React, ні від Node.js API. Чистий TypeScript з Zod.
- Zod-схеми є **single source of truth** для типів метаданих. JSON Schema генерується як build artifact.
- Zustand + immer для state management. zundo для undo/redo.
- Використовуй компоненти з `@workspace/ui` замість створення власних примітивів.
- Стандартні реквізити кожного типу метаданих — незмінні, визначені в BRD (секції 5.1–5.10).
- Метадані зберігаються як JSON-файли, один файл на об'єкт, оптимізовані для diff/merge.

## ❌ NEVER
- Не додавай React, Node.js API або UI залежності в `packages/core` — він має залишатися pure TS + Zod.
- Не змінюй структуру монорепо (apps/packages/docs) без синхронізації з `docs/architecture/OVERVIEW.md`.
- Не дублюй Zod-схеми — імпортуй з `@simetra/core`.
- Не зберігай volatile дані (timestamps, checksums) у файлах метаданих.
- Не видаляй і не модифікуй стандартні реквізити типів метаданих.
- Не створюй кастомні UI-примітиви якщо існує shadcn/ui компонент.

## 📚 Коли потрібні деталі
- Типи метаданих: `docs/BRD-metadata-configurator.md`, секції 5.1–5.10
- Система типів полів: `docs/BRD-metadata-configurator.md`, секція 6
- Формат JSON: `docs/BRD-metadata-configurator.md`, секція 7
- UI layout: `docs/BRD-metadata-configurator.md`, секція 9
- Zod-схеми: `packages/core/src/schemas/`

## 🔄 Робочий цикл
1. Прочитай відповідний розділ документації.
2. Оціни, чи існує інструкція в `.github/instructions` для твоєї сфери.
3. Лише після цього додавай або змінюй код.
4. Після змін: `pnpm format ; pnpm lint ; pnpm typecheck`.
