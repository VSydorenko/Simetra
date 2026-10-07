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
  // Споживач — T2 engineScope (межа гейта, платформна §6.9): компілятор лише
  // перевіряє наявність поля.
  ["project.database", "read by T2 engineScope"],
  ["project.database.provider", "read by T2 engineScope"],
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

function allSchemaPaths(): string[] {
  return [
    ...new Set([
      ...schemaPaths(projectSchema, "project"),
      ...METADATA_KINDS.flatMap((kind) =>
        schemaPaths(KIND_REGISTRY[kind].schema, kind)
      ),
    ]),
  ]
}

function requiredPaths(): string[] {
  return allSchemaPaths()
    .filter((path) => !(path in EXCEPTIONS))
    .sort()
}

/** Ключ-приманка, якого схема не має і жоден споживач не читає. */
const BAIT = "zzUnread"

/**
 * Впорскує приманку в кожен вкладений об'єкт розібраних даних, що за схемою є
 * об'єктом із полями (має підшляхи, і це не запис), і повертає шляхи схеми
 * впорскувань. Позиції беруться з обходу фікстури за формою схеми, а не з
 * ручного переліку: нова вкладена форма в kitchen-sink потрапляє сюди сама.
 * Запис (`z.record`) — не позиція, але його значення-об'єкти — так; ключ
 * запису в шляху схеми — `*`. Локалізований рядок підшляхів не має — лист.
 */
function injectBaitEverywhere(stage1: FilesStageResult): string[] {
  const known = allSchemaPaths()
  const isRecord = (path: string) => known.includes(`${path}.${ANY_KEY}`)
  const hasFields = (path: string) =>
    !isRecord(path) && known.some((k) => k.startsWith(`${path}.`))
  const injected = new Set<string>()
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, path))
      return
    }
    if (typeof value !== "object" || value === null) return
    const record = value as Record<string, unknown>
    for (const [key, child] of Object.entries(record)) {
      visit(child, `${path}.${isRecord(path) ? ANY_KEY : key}`)
    }
    if (hasFields(path)) {
      record[BAIT] = "control"
      injected.add(`${path}.${BAIT}`)
    }
  }
  visit(stage1.project, "project")
  stage1.objects.forEach((object) => visit(object.data, object.kind))
  return [...injected].sort()
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

/**
 * Стек без ліміту: V8 тримає лише `Error.stackTraceLimit` кадрів (типово 10),
 * а рекурсивний `visit` обходу на третьому рівні вкладеності витісняє кадр
 * обходу зі стеку — і його перелік ключів зараховувався б як читання.
 */
function byShapeWalker(): boolean {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = Infinity
  let stack: string
  try {
    stack = new Error().stack ?? ""
  } finally {
    Error.stackTraceLimit = limit
  }
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
 * до запису — для контрольних полів, які ніхто не читає, — і повертає їхні
 * шляхи схеми, щоб ті теж увійшли до перевірки.
 */
async function unreadPaths(
  tamper: (stage1: FilesStageResult) => readonly string[] = () => []
): Promise<string[]> {
  const stage1 = readFiles(kitchenSink())
  const extraPaths = tamper(stage1)
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

  it("a field that nobody reads turns the ratchet red at every nested position", async () => {
    // Контроль чутливості на кожній глибині: приманка в кожному вкладеному
    // об'єкті мусить з'явитися серед непрочитаних — інакше ратчет там
    // порожній (так було з переліком ключів загальним обходом за обрізаним
    // стеком і зі spread колонок CustomTable й зовнішньої цілі FK).
    const baseline = await unreadPaths()
    let injected: string[] = []
    const tampered = await unreadPaths((stage1) => {
      injected = injectBaitEverywhere(stage1)
      return injected
    })
    expect(tampered.filter((path) => !baseline.includes(path))).toEqual(
      injected
    )
    expect(injected).toEqual(
      expect.arrayContaining([
        `project.${BAIT}`,
        `project.scopeKinds.root.external.${BAIT}`,
        `Catalog.${BAIT}`,
        `Catalog.tabularSections.attributes.${BAIT}`,
        `Catalog.standardAttributeOverrides.${ANY_KEY}.${BAIT}`,
        `Document.posting.movements.source.${BAIT}`,
        `CustomTable.columns.${BAIT}`,
        `CustomTable.foreignKeys.references.external.${BAIT}`,
        `CustomTable.indexes.keys.${BAIT}`,
      ])
    )
  })
})
