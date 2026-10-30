/**
 * Стандартну колонку генератор знаходить за визначенням реєстру видів у стилі
 * проєкту, ніколи за літералом імені: `origin.standard` несе логічне ім'я в стилі проєкту, і
 * camelCase-літерал мовчки не знаходить `custom_role` у snake_case-проєкті.
 * Операнд з `?.` — це `ChainExpression`, а не `MemberExpression`, тож має
 * власні варіанти селектора: той самий пошук за літералом.
 * Літеральну множину правило не ловить — її ловить тест рівності SQL обох
 * стилів (`snake-case-parity.test.ts`).
 */
const LOOKUPS =
  "/^(?:standardColumn|findStandardColumn|styleFreeColumn|findStyleFreeColumn)$/"

export const standardColumnConfigs = [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/__tests__/**", "src/model/kinds/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "BinaryExpression[operator=/^[!=]==?$/]:matches([left.property.name='standard'][right.value=type(string)], [right.property.name='standard'][left.value=type(string)], [left.expression.property.name='standard'][right.value=type(string)], [right.expression.property.name='standard'][left.value=type(string)])",
          message:
            "Find a standard column by its registry definition (standardColumn / findStandardColumn), not by comparing origin.standard with a name literal.",
        },
        {
          selector: `CallExpression[callee.name='standardLogicalName'][arguments.0.type='ObjectExpression'], CallExpression[callee.name=${LOOKUPS}][arguments.1.type='ObjectExpression']`,
          message:
            "Pass a standard column definition from the kind registry, not an object literal.",
        },
      ],
    },
  },
]
