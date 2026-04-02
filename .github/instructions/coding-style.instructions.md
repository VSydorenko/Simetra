---
applyTo: '**/*'
description: 'Стиль коду, форматування та документація'
---

## TypeScript

| Правило | Приклад |
|---------|---------|
| **camelCase** для змінних/функцій | `userName`, `getUserData()` |
| **PascalCase** для компонентів/типів | `UserProfile`, `CatalogSchema` |
| **UPPER_SNAKE_CASE** для констант | `MAX_ATTRIBUTES`, `DEFAULT_CODE_LENGTH` |
| **kebab-case** для файлів | `catalog-editor.tsx`, `field-type.ts` |
| **snake_case** для метаданих | `deletion_mark`, `parent_id`, `line_number` |

- Завжди вказуй типи для параметрів функцій
- `interface` для об'єктів, `type` для union/intersection
- Уникай `any`, використовуй `unknown` або конкретні типи
- Zod inferred types замість дублювання: `type Catalog = z.infer<typeof catalogSchema>`

## Formatting

```
Відступи:        2 пробіли
Довжина рядка:   100 символів
Лапки:           одинарні
Крапка з комою:  ні (за налаштуваннями проєкту)
Trailing commas: так
```

## Документація

- Пиши коментарі **українською мовою**
- Поясни **ЧОМУ**, а не що робить код
- Додавай TODO з датою та автором

## Naming Conventions для метаданих

- Технічні імена об'єктів/полів: **PascalCase** (Products, SalesOrder)
- Імена в PostgreSQL (при генерації): **snake_case** (products, sales_order)
- JSON ключі у файлах метаданих: **camelCase** (codeLength, hierarchyType)
- DisplayName: **LocalizedString** `{ uk: "...", en: "..." }`
