---
description: Perform comprehensive code review of implementation with architecture compliance, quality checks, and actionable recommendations
tools: [vscode/askQuestions, execute/getTerminalOutput, execute/runInTerminal, read/terminalSelection, read/terminalLastCommand, read/problems, read/readFile, agent, search, web, todo, vscode.mermaid-chat-features/renderMermaidDiagram]
handoffs:
  - label: Update Documentation
    agent: doc-update
    prompt: Обнови документацію по результату виконання code review
  - label: Discuss Issues
    agent: discussion
    prompt: Детально обговори знайдені проблеми з code review вище. Поясни причини кожної проблеми та можливі підходи до вирішення.
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Outline

**GitHub Copilot coding agent виконав задачу. Перевір його реалізацію через аналіз кодової бази.**

### 1. Збір контексту

**ВАЖЛИВО:** Аналізуй код виключно через read_file, grep_search, semantic_search.

**ЗАБОРОНЕНО:**
- ❌ НЕ запускай команди: `typecheck`, `lint`, `build`, `test`, `pnpm`, `npm`, `git`
- ❌ НЕ використовуй git commands: `git diff`, `git log`, `git status`
- ❌ НЕ компілюй та не запускай скрипти

**Автоматичне визначення scope (DO NOT ask user):**

1. IF attached file exists in `docs/tasks/` → use as baseline requirements
2. IF `$ARGUMENTS` contains file paths → analyze those files
3. IF `$ARGUMENTS` describes changes → search workspace for matching files
4. IF no specific scope → analyze recent workspace changes via semantic_search

**CRITICAL: NEVER ask "Що було реалізовано?" — extract context from attachments and $ARGUMENTS automatically.**

**Завантаж релевантну документацію:**
- `docs/architecture/OVERVIEW.md` — якщо архітектурні зміни
- `docs/BRD-metadata-configurator.md` — якщо зміни стосуються метамоделі
- `.github/instructions/*.instructions.md` — правила для конкретної області коду

### 2. Архітектурна перевірка

#### 🏗️ Architecture & Design

**Перевір відповідність патернам:**

- **Монорепо розділення:**
  - [ ] `packages/core` — чистий TS, без React, без Node API, без UI
  - [ ] `packages/ui` — тільки shadcn/ui компоненти, без бізнес-логіки
  - [ ] `apps/web` — React SPA, імпортує з `@simetra/core` та `@workspace/ui`
  - [ ] Відсутність circular dependencies

- **Metadata Model (core):**
  - [ ] Zod-схеми відповідають BRD (секції 5.1–5.10)
  - [ ] Стандартні реквізити кожного типу — коректні та незмінні
  - [ ] Ролі полів для регістрів (Dimension/Resource/Attribute) — правильно типізовані
  - [ ] Валідація імен: snake_case, латиниця, заборона SQL reserved words

- **State Management:**
  - [ ] Zustand store з immer middleware
  - [ ] zundo для undo/redo
  - [ ] UI state відокремлений від metadata state
  - [ ] Mutations через immer — чисті та передбачувані

- **UI Architecture:**
  - [ ] 3-panel layout (tree, editor, properties)
  - [ ] react-arborist для дерева метаданих
  - [ ] @tanstack/react-table для таблиці реквізитів
  - [ ] shadcn/ui компоненти, не кастомні примітиви

### 3. Якість коду

#### 🔍 Code Quality

- **Читабельність:**
  - [ ] Зрозумілі назви змінних/функцій (camelCase для змінних, PascalCase для компонентів)
  - [ ] Функції < 800 рядків
  - [ ] Коментарі українською пояснюють **ЧОМУ**, не що

- **TypeScript:**
  - [ ] Відсутність `any` (використовувати `unknown` або конкретні типи)
  - [ ] `interface` для об'єктів, `type` для union/intersection
  - [ ] Експорт через `export type` / `export interface`
  - [ ] Zod schemas як single source of truth для типів

- **Форматування:**
  - [ ] 2 пробіли для відступів
  - [ ] Максимум 100 символів на рядок
  - [ ] Одинарні лапки для рядків
  - [ ] Trailing commas

- **Code Smells:**
  - [ ] Відсутність дублювання коду
  - [ ] Відсутність magic numbers
  - [ ] Відсутність глибокого nesting (> 3 рівні)

### 4. Продуктивність

#### ⚡ Performance

- **React Optimization:**
  - [ ] Правильне використання `useMemo` / `useCallback`
  - [ ] Відсутність непотрібних ре-рендерів
  - [ ] Dynamic imports для важких компонентів

- **Metadata Operations:**
  - [ ] Плавна робота з 200+ об'єктів і 5000+ полів
  - [ ] Дерево: розгортання/згортання < 16ms
  - [ ] Збереження проєкту < 1 секунда

### 5. Безпека

#### 🔒 Security

- **Validation:**
  - [ ] Zod schemas для вхідних даних
  - [ ] Валідація імен метаданих (заборона SQL injection через імена)
  - [ ] Sanitization user input

- **File Operations:**
  - [ ] Безпечна робота з File System Access API
  - [ ] Валідація JSON при імпорті
  - [ ] Обробка malformed metadata files

### 6. Функціональність

#### 🎯 Functionality

- **Вимоги:**
  - [ ] Відповідає task specification / BRD
  - [ ] Обробляє всі user scenarios
  - [ ] Реалізує всі required features

- **Error Handling:**
  - [ ] Інформативні error messages
  - [ ] Fallback UI для errors
  - [ ] Empty states для порожніх списків

- **Edge Cases:**
  - [ ] Порожній проєкт
  - [ ] Об'єкт без реквізитів
  - [ ] Видалення об'єкта з посиланнями
  - [ ] Undo/Redo на межі стеку

### 7. Доступність та UX

#### ♿ Accessibility

- [ ] Semantic HTML елементи
- [ ] ARIA labels для інтерактивних елементів
- [ ] Tab order логічний
- [ ] Focus indicators видимі
- [ ] Keyboard shortcuts працюють

## Принципи оцінки та рекомендацій

- **Повне рішення, без відкладення.** Якщо проблема виявлена — вона має бути вирівняна за цей прохід.
- **Відхилення від норми — повідомляй, не вирішуй автоматично.**
- **Максимальна стандартизація.** Обирай підхід, що забезпечує єдиний спільний патерн.
- **Без нових абстракцій поверх абстракцій.**

## Структура звіту

**Формат output прямо у чаті (НЕ створюй окремий файл):**

```markdown
# Code Review Report

## 📊 Summary

- **Files Reviewed:** [число]
- **Overall Quality:** [🟢 Excellent / 🟡 Good / 🟠 Needs Work / 🔴 Critical Issues]
- **Architecture Compliance:** [Yes/No/Partial]

## ✅ Positive Aspects

- [Що добре зроблено, конкретні приклади]

## ⚠️ Issues and Suggestions

### 🏗️ Architecture
- [File path] - [Опис проблеми + рекомендація]

### 🔍 Code Quality
- [File path] - [Code smell + як виправити]

### ⚡ Performance
- [File path] - [Проблема продуктивності + оптимізація]

## 🚨 Critical Issues (Must Fix)

1. **[Issue Title]** ([File path])
   - **Problem:** [Детальний опис]
   - **Impact:** [Чому критично]
   - **Fix:** [Конкретні кроки виправлення]

## 💡 Recommendations

### Quick Wins
- [Швидкі покращення з великим impact]

### Long-term Improvements
- [Стратегічні покращення архітектури]

## 🎯 Next Steps

1. [ ] Fix critical issues
2. [ ] Address code quality concerns
3. [ ] Update documentation
```

## Workflow Summary

1. **Find files** — grep_search/semantic_search для знаходження змінених файлів
2. **Read code** — read_file для аналізу реалізації
3. **Check architecture** — відповідність patterns через порівняння з docs
4. **Review quality** — TypeScript, formatting, code smells
5. **Assess functionality** — логіка, errors, edge cases
6. **Generate report** — structured output прямо у чаті

**ПРІОРИТЕТ:** Швидкий, корисний feedback без запуску команд.
