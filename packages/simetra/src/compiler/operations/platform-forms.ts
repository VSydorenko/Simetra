import {
  formatSqlFunctionsFile,
  sqlFunctionsFileSchema,
  type SqlFunctionDeclaration,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { readFiles } from "../pipeline"
import { platformFormFunctions } from "../sql/declarations"
import { functionIdentity } from "../sql/units"

/** Файли після переходу й попередження про ширші призначення форм. */
export interface PlatformFormTransition {
  files: Map<string, string>
  diagnostics: Diagnostic[]
}

/**
 * Перехід задекларованої функції у форму платформи (спека декларацій функцій
 * §5.1, Р12) — спільний для хвостів мутацій (`create`, `add`, далі
 * `declare-function`). Після зміни функція, яку метадані зробили формою
 * (`setFunction` виду скоупу, функція значень виміру), отримує `EXECUTE` від
 * генератора, тож її декларація в тій самій зміні зникає: інакше результат
 * мав би нову помилку `sql.declaration-platform-form`, і мутація з режимом
 * `repair` відмовила б. Файл без записів видаляється, решта записів —
 * канонічним записом. Коли призначення форми ширші за викликачів видаленої
 * декларації, перехід відкриває функцію ролям, яких автор не називав, —
 * попередження `sql.declaration-platform-form-widens` з переліком доданих
 * ролей. Функція значень виміру не розширює ніколи: її призначення порожні.
 */
export function toPlatformForms(
  files: ReadonlyMap<string, string>
): PlatformFormTransition {
  const result = new Map(files)
  const diagnostics: Diagnostic[] = []
  const { project, objects, functionsFiles } = readFiles(files)
  // Зламаний проєкт чи файл декларацій не судиться тут: причину назве
  // компіляція результату.
  if (project === undefined) return { files: result, diagnostics }
  const forms = platformFormFunctions(objects, project)
  for (const parsed of functionsFiles) {
    const kept: SqlFunctionDeclaration[] = []
    for (const declaration of parsed.functions) {
      const schema = declaration.function.schema ?? project.defaultSchema
      const { name } = declaration.function
      const form = forms.get(functionIdentity(schema, name, []))
      if (form === undefined) {
        kept.push(declaration)
        continue
      }
      const added = form.purposes.filter(
        (p) => !declaration.callers.includes(p)
      )
      if (added.length > 0) {
        // Pointer — увесь файл: запис, про який мова, уже видалено.
        diagnostics.push(
          diagnostic("sql.declaration-platform-form-widens", parsed.file, "", {
            schema,
            name,
            function: `${schema}.${name}`,
            form: form.form,
            roles: added.join(", "),
          })
        )
      }
    }
    if (kept.length === parsed.functions.length) continue
    if (kept.length === 0) {
      result.delete(parsed.file)
      continue
    }
    // `$schema` — з тексту файлу: розібраний запис стадії 1 його не несе.
    const raw = sqlFunctionsFileSchema.parse(
      JSON.parse(files.get(parsed.file)!)
    )
    result.set(parsed.file, formatSqlFunctionsFile({ ...raw, functions: kept }))
  }
  return { files: result, diagnostics }
}
