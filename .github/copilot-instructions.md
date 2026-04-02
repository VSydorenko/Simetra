# GitHub Copilot Instructions

> Copilot-specific config. Domain-specific rules auto-applied from `.github/instructions/*.md` by file path.

## Subagents (.github/agents/)

Specialized agents for delegating specific workflows:

| Agent | Purpose |
|-------|---------|
| `codebase-research` | **Дослідження кодової бази.** Read-only аналіз структури, патернів, залежностей, Zod-схем. Завжди запускай цього агента замість generic Explore для збору контексту перед імплементацією. |
| `code-review` | Review implementation for architecture compliance and quality. Does NOT run terminal commands. |
| `create-task` | Prepare task files in `docs/tasks/` for coding agent. No code examples — only requirements + clarify questions. |
| `discussion` | Explanation and architecture discussion only. No code generation (max 3 lines). |
| `doc-update` | Update `docs/architecture/`, instructions, and other docs to match current code. |

> **⚠️ Дослідження кодової бази** — для збору контексту перед реалізацією фічі або задачі **завжди** делегуй субагенту `codebase-research`. Він знає структуру Simetra, Zod-схеми core-пакету і повертає структурований звіт замість raw file dumps. Не використовуй generic Explore для цього.

## Project Overview

**Simetra** — open-source візуальний конфігуратор бізнес-метаданих. Монорепо (pnpm workspaces + turborepo):

| Package | Purpose |
|---------|---------|
| `packages/core` (`@simetra/core`) | Zod-схеми метаданих, типи, валідація. Чистий TS — без UI, без Node API |
| `packages/ui` (`@workspace/ui`) | shadcn/ui компоненти з Tailwind CSS 4 |
| `apps/web` | React SPA (Vite 6) — основний інтерфейс конфігуратора |

### Key Domain Concepts

Simetra працює з **бізнес-метаданими** — не таблицями БД, а типізованими бізнес-об'єктами:

| Metadata Type | Purpose | Phase |
|--------------|---------|-------|
| Catalog | Довідники (контрагенти, номенклатура, склади) | MVP |
| Document | Документи (продажі, оплати, переміщення) | MVP |
| Enumeration | Перелічення (статуси, типи, ознаки) | MVP |
| InformationRegister | Регістри відомостей (курси валют, ціни) | MVP |
| AccumulationRegister | Регістри накопичення (залишки, обороти) | MVP |
| Constant | Константи (налаштування, параметри) | MVP |
| CustomTable | Довільні таблиці (логи, черги) | MVP |

### Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | React 18+ / Vite 6 |
| UI Kit | shadcn/ui + Tailwind CSS 4 |
| State | Zustand + immer |
| Undo/Redo | zundo |
| Validation | Zod (v4) |
| Tree | react-arborist |
| Table | @tanstack/react-table v8 |
| Layout | react-resizable-panels |
| Command Palette | cmdk (shadcn/ui Command) |
| Keyboard | react-hotkeys-hook |
| Icons | lucide-react |
| Tests | Vitest + Testing Library |
| Monorepo | pnpm workspaces + turborepo |
| TypeScript | strict mode |

<system>
ALWAYS escalate (ask expert via tools) IF uncertain, AMBIGUOUS, or CONFLICTING instructions, OR repeated failures, OR destructive edits, OR public API changes, OR architecture uncertainty. Never guess silently. Never continue after 2 failed attempts without escalation.
ALWAYS WHEN YOU ARE UNSURE, ASK FOR HELP.
ALWAYS ESCALATE EARLY.
ALWAYS AT THE END OF YOUR WORK ASK EXPERT ABOUT WHAT YOU HAVE DONE AND FOLLOW HIS INSTRUCTIONS.
EACH TIME ADD CONSIDERATIONS WITH EXPERT IN ALL YOURS TODO LIST IN BEGINNING AND TO THE END OF YOURS TODO LIST.
SEND TO EXPERT ONLY SIMPLE TEXT, EVEN IF YOU HAVE CODE, SEND IT AS SIMPLE TEXT.
NEVER TRY TO DEBUG APP. ALWAYS ASK EXPERT. NOT USER!!!
</system>
