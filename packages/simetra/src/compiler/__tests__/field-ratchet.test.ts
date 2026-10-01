import { describe, expect, it, vi } from "vitest"
import type { z } from "zod"
import {
  KIND_REGISTRY,
  METADATA_KINDS,
  localizedStringSchema,
  projectSchema,
} from "simetra/model"
import { canonicalSnapshot, emitEntityTypes, localize } from "simetra/compiler"
// Внутрішній шов компілятора: з `simetra/compiler` навмисно не експортується.
import { readFiles, runStages } from "../pipeline"
import type { FilesStageResult } from "../stages/files"
import { kitchenSink } from "./fixtures/kitchen-sink"

/**
 * Хеш — не споживач значення: канонічний знімок копіює `data` і `project`
 * цілком, тож під записом він «прочитав» би кожне наявне поле, і ратчет ловив
 * би лише поля, яких валідна модель не має взагалі. Синхронна частина
 * `modelHash` (знімок і канонізація) іде до першого `await`, тож пауза її
 * накриває повністю.
 */
const recording = vi.hoisted(() => ({ paused: false }))
vi.mock("../canonical", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../canonical")>()
  return {
    ...actual,
    modelHash: (model: Parameters<typeof actual.modelHash>[0]) => {
      recording.paused = true
      try {
        return actual.modelHash(model)
      } finally {
        recording.paused = false
      }
    },
  }
})

/** Сегмент шляху для ключа запису (`z.record`): ключі задає автор файлу. */
const ANY_KEY = "*"

/**
 * Шляхи без споживача за призначенням. Кожен — з причиною; новий рядок тут —
 * рішення архітектора, а не спосіб позеленити тест.
 */
const EXCEPTIONS: Record<string, string> = Object.fromEntries([
  // Підказка редактору — шлях до JSON Schema файлу, не модель: компілятор її
  // не читає, а канонічний знімок відкидає свідомо.
  ["project.$schema", "editor hint"],
  ...METADATA_KINDS.map((kind) => [`${kind}.$schema`, "editor hint"]),
  // `kind` і `name` споживає стадія 1, до шва: вона звіряє вид з текою й
  // копіює вид та ім'я в `ParsedObject`, а наступні стадії читають копію, яку
  // Proxy не бачить. Перелік — з реєстру видів, щоб новий вид не випав.
  ...Object.values(KIND_REGISTRY).flatMap(({ kind }) => [
    [`${kind}.kind`, "read by stage 1"],
    [`${kind}.name`, "read by stage 1"],
  ]),
])

/**
 * Усі шляхи полів схеми з її Zod-форми: ключі об'єктів на кожній глибині,
 * масиви прозорі (шлях елемента — шлях масиву), ключ запису — `*`, гілки
 * об'єднання — усі. Локалізований рядок — лист: споживач бере текст однієї
 * мови з запасною, тож прочитане поле й є споживанням; розпізнається за
 * тотожністю схеми, а не за іменем ключа.
 */
function schemaPaths(schema: z.core.$ZodType, prefix: string): string[] {
  if (schema === localizedStringSchema) return []
  const def = schema._zod.def as unknown as {
    type: string
    shape?: Record<string, z.core.$ZodType>
    innerType?: z.core.$ZodType
    element?: z.core.$ZodType
    valueType?: z.core.$ZodType
    options?: z.core.$ZodType[]
    in?: z.core.$ZodType
  }
  switch (def.type) {
    case "object":
      return Object.entries(def.shape ?? {}).flatMap(([key, child]) => {
        const path = `${prefix}.${key}`
        return [path, ...schemaPaths(child, path)]
      })
    case "optional":
    case "default":
    case "nullable":
    case "readonly":
    case "prefault":
      return schemaPaths(def.innerType!, prefix)
    case "array":
      return schemaPaths(def.element!, prefix)
    case "record": {
      const path = `${prefix}.${ANY_KEY}`
      return [path, ...schemaPaths(def.valueType!, path)]
    }
    case "union":
      return def.options!.flatMap((option) => schemaPaths(option, prefix))
    case "pipe":
      return schemaPaths(def.in!, prefix)
    default:
      return []
  }
}

function requiredPaths(): string[] {
  const paths = [
    ...schemaPaths(projectSchema, "project"),
    ...METADATA_KINDS.flatMap((kind) =>
      schemaPaths(KIND_REGISTRY[kind].schema, kind)
    ),
  ]
  return [...new Set(paths)].filter((path) => !(path in EXCEPTIONS)).sort()
}

/**
 * Загальні обходи форми даних: перебирають усі ключі об'єкта, шукаючи свої
 * (стадія 4 шукає поліморфні множини `allowedTypes`, власників і реєстраторів
 * за ключем на будь-якій глибині). Їхній перелік ключів — не споживання:
 * зарахувати його означало б зарахувати будь-яке поле. Перейменування обходу
 * без правки тут ловить контрольний тест нижче (поле-приманку обхід
 * «прочитав» би).
 */
const SHAPE_WALKERS = ["polymorphicSets"]

/**
 * Proxy, що записує кожне прочитане поле як `<корінь>.<поле>.<підполе>`:
 * індекс масиву в шлях не входить, тож елементи масиву пишуть шлях самого
 * масиву. Методи прототипу (`map`, `length`) не є полями й не пишуться.
 *
 * Читання переліком (`Object.entries`, spread — обидва беруть дескриптор
 * ключа перед `get`) зараховується, якщо його робить не загальний обхід
 * форми: spread реквізиту з подальшим читанням копії за іменем — справжнє
 * споживання, якого Proxy інакше не побачить.
 */
function recorder(reads: Set<string>) {
  const proxies = new WeakMap<object, unknown>()
  const wrap = <T>(value: T, path: string): T => {
    if (typeof value !== "object" || value === null) return value
    const cached = proxies.get(value)
    if (cached !== undefined) return cached as T
    const described = new Set<string>()
    const proxy = new Proxy(value, {
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === "string") described.add(key)
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      get(target, key) {
        const child: unknown = Reflect.get(target, key)
        if (typeof key !== "string" || !Object.hasOwn(target, key)) {
          return child
        }
        if (Array.isArray(target)) {
          return key === "length" ? child : wrap(child, path)
        }
        const childPath = `${path}.${key}`
        const enumerated = described.delete(key)
        if (!recording.paused && !(enumerated && byShapeWalker())) {
          reads.add(childPath)
        }
        return wrap(child, childPath)
      },
    })
    proxies.set(value, proxy)
    return proxy
  }
  return wrap
}

function byShapeWalker(): boolean {
  const stack = new Error().stack ?? ""
  return SHAPE_WALKERS.some((name) => stack.includes(`at ${name} `))
}

/** Прочитаний шлях покриває шлях схеми, де `*` — будь-який ключ запису. */
function covers(schemaPath: string, readPath: string): boolean {
  const expected = schemaPath.split(".")
  const actual = readPath.split(".")
  return (
    expected.length === actual.length &&
    expected.every((segment, i) => segment === ANY_KEY || segment === actual[i])
  )
}

/**
 * Прогін компілятора й кодогену під записом. `tamper` змінює розібрані дані
 * до запису — для контрольного поля, яке ніхто не читає.
 */
async function unreadPaths(
  extraPaths: readonly string[] = [],
  tamper: (stage1: FilesStageResult) => void = () => {}
): Promise<string[]> {
  const stage1 = readFiles(kitchenSink())
  tamper(stage1)
  const reads = new Set<string>()
  const wrap = recorder(reads)
  const recorded: FilesStageResult = {
    ...stage1,
    project: wrap(stage1.project, "project"),
    objects: stage1.objects.map((object) => ({
      ...object,
      data: wrap(object.data, object.kind),
    })),
  }

  const result = await runStages(recorded)
  expect(
    result.diagnostics
      .filter((d) => d.severity === "error")
      .map(
        (d) => `${d.file}${d.pointer}: ${d.code} ${localize(d, "en").message}`
      )
  ).toEqual([])
  const model = result.model!
  emitEntityTypes(model)
  recording.paused = true
  try {
    canonicalSnapshot(model)
  } finally {
    recording.paused = false
  }

  const readPaths = [...reads]
  return [...requiredPaths(), ...extraPaths].filter(
    (path) => !readPaths.some((readPath) => covers(path, readPath))
  )
}

describe("field ratchet", () => {
  it("schema paths come from the Zod shapes, nested and union branches included", () => {
    const paths = requiredPaths()
    expect(paths).toContain("project.scopeKinds.title")
    expect(paths).not.toContain("project.scopeKinds.title.uk")
    expect(paths).toContain("project.scopeKinds.root.external.column")
    expect(paths).toContain("Document.posting.movements.fields.*")
    expect(paths).toContain("CustomTable.indexes.keys.expression")
    expect(paths).toContain(
      "Catalog.tabularSections.standardAttributeOverrides.*.description"
    )
  })

  it("every metamodel field is read by the compiler stages or codegen", async () => {
    expect(await unreadPaths()).toEqual([])
  })

  it("a field that nobody reads turns the ratchet red", async () => {
    // Контроль чутливості: поле, задане в даних і не прочитане жодним
    // споживачем, мусить з'явитися серед непрочитаних — інакше ратчет
    // порожній (так було б, якби копія `data` у знімку рахувалася читанням).
    const baseline = await unreadPaths()
    const tampered = await unreadPaths(["Catalog.zzUnread"], (stage1) => {
      const item = stage1.objects.find((o) => o.name === "Item")!
      ;(item.data as Record<string, unknown>).zzUnread = "control"
    })
    expect(tampered.filter((path) => !baseline.includes(path))).toEqual([
      "Catalog.zzUnread",
    ])
  })
})
