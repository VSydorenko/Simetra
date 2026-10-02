import {
  KIND_REGISTRY,
  formatMetaFile,
  formatProjectFile,
  projectSchema,
} from "simetra/model"
import type { z } from "zod"
import { diagnostic } from "../diagnostics"
import { PROJECT_FILE } from "../stages/files"
import type { RenameInput } from "./inputs"
import { compileInput, compileResult, refused } from "./refuse"
import { objectFiles, resolveTarget } from "./target"
import {
  placeOf,
  renameJsonPlaces,
  renameMarkers,
  type Place,
} from "./text-edits"
import type { OperationResult } from "./types"

type Json = Record<string, unknown>

/** Вузол за pointer щойно знайденої цілі (сегменти — імена й індекси). */
function nodeAt(root: Json, pointer: string): Json {
  let current: unknown = root
  for (const segment of pointer.split("/").slice(1)) {
    current = (current as Json)[segment]
  }
  return current as Json
}

/**
 * Перейменовує об'єкт чи вкладений іменований елемент (спека П2 §3, §8.6):
 * поле `name` цілі плюс каскад — кожне посилання індексу з id цілі. Id і
 * `physicalName` не змінюються, тож перейменування не дає DDL (Р5). Об'єкт
 * переносить теку й кожен свій файл. Текст `.module.ts` каскад свідомо не
 * переписує: імпорти згенерованих типів за логічним іменем ловить typecheck
 * модуля.
 */
export async function renameElement(
  files: ReadonlyMap<string, string>,
  input: RenameInput
): Promise<OperationResult> {
  const clean = await compileInput(files)
  if (!clean.ok) return clean.result
  const { model } = clean

  const target = resolveTarget(model, files, input.target)
  if (!target.ok) return refused(files, [target.diagnostic])
  const { newName } = input

  // Ціль-об'єкт: його тека й файли переїжджають під нове ім'я.
  const moves = new Map<string, string>()
  const object = model.objects.find((o) => o.id === target.id)
  if (object !== undefined && object.name !== newName) {
    const dir = KIND_REGISTRY[object.kind].dir
    const from = `${dir}/${object.name}/`
    const to = `${dir}/${newName}/`
    const taken =
      model.objects.some((o) => o.kind === object.kind && o.name === newName) ||
      [...files.keys()].some((path) => path.startsWith(to))
    if (taken) {
      // Без цієї перевірки перенос мовчки затер би файли наявного об'єкта.
      return refused(files, [
        diagnostic("operation.object-exists", `${to}${newName}.meta.json`, "", {
          kind: object.kind,
          name: newName,
        }),
      ])
    }
    for (const path of objectFiles(files, object)) {
      const fileName = path.slice(from.length)
      moves.set(
        path,
        to +
          (fileName.startsWith(`${object.name}.`)
            ? newName + fileName.slice(object.name.length)
            : fileName)
      )
    }
  }

  // Чиста компіляція гарантує, що кожен `.meta.json` розбирається.
  const parsed = new Map<string, Json>()
  const rawOf = (file: string) => {
    let raw = parsed.get(file)
    if (raw === undefined) {
      raw = JSON.parse(files.get(file)!) as Json
      parsed.set(file, raw)
    }
    return raw
  }
  // Схема файлу відрізняє ключ `record` від значення (форма місця).
  const schemaOf = (file: string): z.ZodType | undefined => {
    if (file === PROJECT_FILE) return projectSchema
    const owner = model.objects.find((o) => o.file === file)
    return owner === undefined ? undefined : KIND_REGISTRY[owner.kind].schema
  }

  nodeAt(rawOf(target.file), target.pointer).name = newName

  const jsonPlaces = new Map<string, Place[]>()
  const markerLines = new Map<string, number[]>()
  for (const ref of model.references) {
    if (ref.to.id !== target.id) continue
    const file = ref.from.file
    const place =
      ref.line !== undefined
        ? placeOf(ref, undefined, undefined)
        : placeOf(ref, rawOf(file), schemaOf(file))
    if (place.form === "marker") {
      markerLines.set(file, [...(markerLines.get(file) ?? []), place.line])
    } else {
      jsonPlaces.set(file, [...(jsonPlaces.get(file) ?? []), place])
    }
  }

  const after = new Map(files)
  for (const [file, raw] of parsed) {
    renameJsonPlaces(raw, jsonPlaces.get(file) ?? [], newName)
    after.set(
      file,
      file === PROJECT_FILE ? formatProjectFile(raw) : formatMetaFile(raw)
    )
  }
  for (const [file, lines] of markerLines) {
    after.set(file, renameMarkers(after.get(file)!, lines, newName))
  }
  for (const [from, to] of moves) {
    const content = after.get(from)!
    after.delete(from)
    after.set(to, content)
  }
  return compileResult(files, after)
}
