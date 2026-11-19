import { z } from "zod"
import { appSchemaNameSchema } from "./pg-schema"
import { elementNameSchema, metadataIdSchema } from "./identity"
import { metadataRefSchema } from "./metadata-ref"
import type { GrantPurpose } from "./project"
import type { SchemaRule } from "./rules"

/**
 * Суфікс файлу декларацій функцій: `<основа>.functions.json` лежить поруч із
 * `<основа>.sql` і описує функції саме цього файлу (ADR-0092).
 */
export const FUNCTIONS_FILE_SUFFIX = ".functions.json"

/**
 * Викликачі — явний перелік, а не весь `GrantPurpose`: роль споживача
 * сигналів платформна, і функцію застосунку їй не відкривають (спека
 * декларацій функцій §5.1). `satisfies` тримає перелік у межах призначень,
 * які знає генератор грантів.
 */
export const SQL_FUNCTION_CALLERS = [
  "user",
  "anonymous",
  "service",
  "command",
] as const satisfies readonly GrantPurpose[]

export type SqlFunctionCaller = (typeof SQL_FUNCTION_CALLERS)[number]

/** Функція з SQL сусіднього файлу: ім'я з `CREATE FUNCTION`, а не `physicalName`. */
const declaredFunctionSchema = z
  .strictObject({
    // Схема за відсутності — `defaultSchema` проєкту, як у `setFunction`;
    // підставляє компілятор, тож дублі після підстановки судить він, а не схема.
    schema: appSchemaNameSchema.min(1).optional().meta({
      description:
        "PostgreSQL schema of the function; defaultSchema when absent.",
    }),
    name: z.string().min(1).meta({
      description: "Name of the function in its CREATE FUNCTION statement.",
    }),
  })
  .meta({ description: "SQL function of the sibling .sql file." })

/**
 * Названа перевірка (спека декларацій §5.2). `row` і `scope` разом схема
 * приймає: це причина `twoTargets` компілятора, з адресою на саму перевірку.
 */
const functionCheckSchema = z
  .strictObject({
    action: elementNameSchema.meta({
      description:
        "A word of the action vocabulary or the name of a custom action of the object.",
    }),
    object: metadataRefSchema.meta({
      description: "Metadata object whose rights contract is checked.",
    }),
    row: z.string().min(1).optional().meta({
      description:
        "Name of the uuid IN parameter that holds the primary key of the checked row.",
    }),
    scope: z.string().min(1).optional().meta({
      description:
        "Name of the uuid IN parameter that holds the scope value of the check.",
    }),
  })
  .meta({
    description:
      "Rights check the function applies before it acts on behalf of the caller.",
  })

export const sqlFunctionDeclarationSchema = z
  .strictObject({
    id: metadataIdSchema.optional(),
    function: declaredFunctionSchema,
    callers: z.array(z.enum(SQL_FUNCTION_CALLERS)).meta({
      description:
        "Role purposes that get EXECUTE on the function; empty — no application role, only other functions of the owner call it.",
    }),
    check: functionCheckSchema.optional(),
  })
  .meta({
    description: "Declaration of one function of the sibling .sql file.",
  })

export type SqlFunctionDeclaration = z.infer<
  typeof sqlFunctionDeclarationSchema
>

/**
 * Порядок записів файлу: запис без `schema` — перед записами зі схемою, далі
 * схема й ім'я, порівняння за кодовими одиницями (не залежить від локалі).
 * Нуль — той самий записаний `function`.
 */
export function compareDeclaredFunctions(
  a: { schema?: string; name: string },
  b: { schema?: string; name: string }
): number {
  if ((a.schema === undefined) !== (b.schema === undefined)) {
    return a.schema === undefined ? -1 : 1
  }
  const units = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
  return units(a.schema ?? "", b.schema ?? "") || units(a.name, b.name)
}

/**
 * Файл декларацій функцій одного `.sql` (спека декларацій §5.1). Масив
 * відсортовано й без дублів записаного значення — diff показує зміну, а не
 * порядок, як у `sql-debt.json`.
 */
export const sqlFunctionsFileSchema = z
  .strictObject({
    $schema: z.string().optional().meta({
      description: "Editor hint: path to the JSON Schema of this file.",
    }),
    functions: z.array(sqlFunctionDeclarationSchema).meta({
      description:
        "Declarations of functions of the sibling .sql file, sorted by function (entries without schema first, then by schema and name) and without duplicates.",
    }),
  })
  .meta({
    description:
      "Declarations of SQL functions: who may execute them and which rights check they apply.",
  })
  .superRefine((file, ctx) => {
    file.functions.forEach((entry, index) => {
      if (index === 0) return
      const previous = file.functions[index - 1]!.function
      const order = compareDeclaredFunctions(previous, entry.function)
      if (order < 0) return
      const shown =
        entry.function.schema === undefined
          ? entry.function.name
          : `${entry.function.schema}.${entry.function.name}`
      ctx.addIssue({
        code: "custom",
        message:
          order === 0
            ? `Function "${shown}" is declared twice`
            : `Declaration of "${shown}" is out of order`,
        path: ["functions", index],
        params: { rule: "declarations.not-canonical" satisfies SchemaRule },
      })
    })
  })

export type SqlFunctionsFile = z.infer<typeof sqlFunctionsFileSchema>
