---
applyTo: '**/*'
description: 'Базові архітектурні правила Simetra'
---

## ✅ ALWAYS
- Дотримуйся поділу пакетів: `packages/core` — чистий TS без UI/Node, `packages/ui` — shadcn/ui компоненти, `apps/web` — React SPA.
- Будь-які зміни в архітектурі звіряй з документацією:
  - `docs/architecture/OVERVIEW.md`
  - `docs/architecture/` — деталізація state, UI, storage, metadata model і архітектурних рішень (`state-management.md`, `ui-components.md`, `storage-and-persistence.md`, `metadata-model.md`, `patterns-and-decisions.md`)
  - `docs/BRD-metadata-configurator.md` — специфікація типів метаданих
- `@simetra/core` — серцевина. Не залежить ні від React, ні від Node.js API. Чистий TypeScript з Zod.
- Zod-схеми є **single source of truth** для типів метаданих. JSON Schema розглядай як похідний формат, але не припускай, що його build artifact уже присутній у репозиторії.
- Zustand + immer для state management. zundo для undo/redo.
- Використовуй компоненти з `@workspace/ui` замість створення власних примітивів.
- Стандартні реквізити звіряй з `docs/architecture/metadata-model.md`: у поточному коді вони виводяться з виду об'єкта та його налаштувань, а BRD і реалізація можуть мати задокументовані відмінності.
- Канонічна модель зберігання — JSON-файли, переважно один файл на об'єкт, оптимізовані для diff/merge; поточні file-layout винятки на кшталт wrapper для констант описані в `docs/architecture/storage-and-persistence.md`.

## ❌ NEVER
- Не додавай React, Node.js API або UI залежності в `packages/core` — він має залишатися pure TS + Zod.
- Не змінюй структуру монорепо (apps/packages/docs) без синхронізації з `docs/architecture/OVERVIEW.md`.
- Не дублюй Zod-схеми — імпортуй з `@simetra/core`.
- Не зберігай volatile дані (timestamps, checksums) у файлах метаданих.
- Не трактуй стандартні реквізити як звичайні persisted custom fields і не змінюй їхні правила derivation без звірки з `docs/architecture/metadata-model.md`.
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
