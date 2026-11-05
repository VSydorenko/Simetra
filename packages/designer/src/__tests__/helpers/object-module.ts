/**
 * Сайдкар модуля `<Name>.module.ts` поруч з `<Name>.meta.json`: компілятор
 * бачить його як модуль об'єкта (`moduleFiles`), а вміст йому байдужий.
 */
export function withObjectModule(
  files: ReadonlyMap<string, string>,
  metaFile: string
): Map<string, string> {
  if (!metaFile.endsWith(".meta.json"))
    throw new Error(`not a metadata file: ${metaFile}`)
  const module = metaFile.replace(/\.meta\.json$/, ".module.ts")
  return new Map([...files, [module, "export default {}\n"]])
}
