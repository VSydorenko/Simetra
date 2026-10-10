import { KIND_REGISTRY, standardLogicalName } from "simetra/model"
import { diagnostic, toPointer, type Diagnostic } from "../../diagnostics"
import { completeNarrowAndCompile, type CompletionOptions } from "../fix"
import type { PromoteInput } from "../inputs"
import { compileInput, refused, refuseSuppliedId } from "../refuse"
import { objectFiles } from "../target"
import type { OperationResult } from "../types"
import { cascadeReferences, type PromotedReferences } from "./cascade"
import { kindFile } from "./kind-file"
import {
  missingFills,
  placeColumns,
  structuralSubjects,
  type PromotedTable,
  type PromotionTarget,
} from "./mapping"
import { promotionRecord, type PromoteResult } from "./record"

const MODULE_SUFFIX = ".module.ts"

/**
 * Відмова, якщо частина входу, з якої народжуються нові елементи, несе `id`
 * (як у `create`/`add`). Ключі мапінгу — імена колонок, тож перевіряються
 * лише тіла елементів і дані виду, а не весь вхід: колонка `id` не є id.
 */
function suppliedId(
  files: ReadonlyMap<string, string>,
  input: PromoteInput
): OperationResult | undefined {
  const bodies: [unknown, string[]][] = [[input.into.data, ["into", "data"]]]
  const columns = (mappings: PromoteInput["columns"], at: string[]) => {
    for (const [name, mapping] of Object.entries(mappings)) {
      if (mapping.to === "attribute") {
        bodies.push([mapping.element, [...at, name, "element"]])
      }
    }
  }
  columns(input.columns, ["columns"])
  input.tabularSections.forEach((section, i) => {
    const at = ["tabularSections", String(i)]
    bodies.push([section.data, [...at, "data"]])
    columns(section.columns, [...at, "columns"])
  })
  for (const [value, root] of bodies) {
    const found = refuseSuppliedId(files, value, root)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Промоція прийнятої таблиці у вид 1С (спека промоції §4, §7.1): чисто
 * файлова мутація. Файл виду заміняє файли `CustomTable` з перенесеними id і
 * канонічними фізичними іменами, посилання з інших файлів переходять на вид,
 * а запис промоції несе все, що П3 має знати про старий стан. Як і інші
 * мутації: повний вхід або відмова, компіляція перед записом, усе або нічого.
 */
export async function promoteObject(
  files: ReadonlyMap<string, string>,
  input: PromoteInput,
  o: CompletionOptions
): Promise<PromoteResult> {
  // 1. Вхід і чиста модель.
  const supplied = suppliedId(files, input)
  if (supplied !== undefined) return supplied
  const clean = await compileInput(files)
  if (!clean.ok) return clean.result
  const { model } = clean
  const style = model.project.naming.attributeCase

  // 2. Ціль — прийнята таблиця; ім'я нового об'єкта вільне.
  const object = model.objects.find(
    (x) =>
      KIND_REGISTRY[x.kind].declared &&
      KIND_REGISTRY[x.kind].materializes === "table" &&
      x.name === input.target.name
  )
  if (object === undefined) {
    return refused(files, [
      diagnostic("operation.target-not-found", "", "", {
        target: `CustomTable ${input.target.name}`,
        name: input.target.name,
      }),
    ])
  }
  const { into } = input
  const def = KIND_REGISTRY[into.kind]
  const dir = `${def.dir}/${into.name}/`
  const path = `${dir}${into.name}.meta.json`
  const existing = model.objects.find(
    (x) => x.kind === into.kind && x.name === into.name
  )
  if (
    existing !== undefined ||
    [...files.keys()].some((file) => file.startsWith(dir))
  ) {
    return refused(files, [
      diagnostic("operation.object-exists", existing?.file ?? path, "", {
        kind: into.kind,
        name: into.name,
      }),
    ])
  }

  // Склад стандартних колонок залежить від налаштувань виду, тож вони
  // розбираються до розміщення колонок.
  const settings = def.schema.safeParse({
    ...into.data,
    kind: into.kind,
    name: into.name,
  })
  if (!settings.success) {
    return refused(
      files,
      settings.error.issues.map((issue) =>
        diagnostic("promote.mapping-unknown", "", "", {
          at: toPointer(["into", "data", ...issue.path]),
          detail: issue.message,
        })
      )
    )
  }
  const target: PromotionTarget = {
    kind: into.kind,
    name: into.name,
    standard: def.standardColumns(settings.data),
  }

  // 3. Повнота й гейти. Задача 9 додає сюди класифікацію SQL-одиниць і
  // гейти шляху запису та користувачів провайдера.
  const problems: Diagnostic[] = []
  const placement = placeColumns(
    model,
    object,
    input.columns,
    ["columns"],
    target,
    input.conversions
  )
  problems.push(...placement.problems)
  const main: PromotedTable = placement.table
  const subjects = structuralSubjects(main)
  for (const s of subjects) {
    if (s.required && input.conversions[s.subject] === undefined) {
      problems.push(
        diagnostic("promote.unclassified", s.file, s.pointer, {
          subject: s.subject,
        })
      )
    }
  }
  const known = new Set(subjects.map((s) => s.subject))
  for (const key of Object.keys(input.conversions)) {
    if (!known.has(key)) {
      problems.push(
        diagnostic("promote.mapping-unknown", "", "", {
          at: toPointer(["conversions", key]),
          detail:
            "it names no SQL unit or structural element of the promoted tables",
        })
      )
    }
  }
  problems.push(...missingFills(main, target, input.fill))

  // 4. Файл виду.
  const becomes = { kind: into.kind, name: into.name }
  const built = kindFile(
    { model, into, unit: new Map([[object.name, becomes]]) },
    main
  )
  problems.push(...built.problems)

  // 6. Каскад посилань з інших файлів.
  const columns = new Map(
    main.columns.map(({ column, fate }) => [
      column.id!,
      {
        name: column.name,
        becomes:
          fate.to === "standard"
            ? standardLogicalName(fate.def, style)
            : fate.to === "attribute"
              ? String(fate.element.name)
              : undefined,
      },
    ])
  )
  const references: PromotedReferences[] = [
    { objectId: object.id, table: object.name, becomes, columns },
  ]
  // Каскад рахується до запису, щоб його відмови прийшли разом з іншими.
  const cascade = cascadeReferences(model, files, references)
  problems.push(...cascade.problems)
  if (problems.length > 0) return refused(files, problems)

  // 5. Файли прийнятої таблиці знімаються, файл виду й каскад пишуться.
  // Модуль `.module.ts` — код застосунку, а не опис таблиці: він переїжджає
  // до файлу виду, як при перейменуванні, а не зникає мовчки.
  const after = new Map(files)
  for (const file of objectFiles(files, object)) {
    if (file.endsWith(MODULE_SUFFIX)) {
      after.set(`${dir}${into.name}${MODULE_SUFFIX}`, files.get(file)!)
    }
    after.delete(file)
  }
  after.set(path, JSON.stringify(built.raw))
  for (const [file, text] of cascade.files) after.set(file, text)

  // 7–8. Доповнення (канонічні фізичні імена, рішення 10), звуження боргу й
  // компіляція результату.
  const completed = await completeNarrowAndCompile(
    files,
    after,
    o,
    new Set([path, ...cascade.files.keys()])
  )
  if (!completed.result.ok || completed.model === undefined) {
    return completed.result
  }
  // 9. Запис — з моделі результату.
  return {
    ...completed.result,
    record: promotionRecord(input, model, completed.model, main),
  }
}
