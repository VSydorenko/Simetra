// Кодек протоколу серіалізації Start (seroval, перехресний JSON) для JSON-значень:
// `POST /_serverFn/<id>` приймає лише його. Це не бібліотека, а мінімум, якого
// потребують кейси: об'єкти, масиви, рядки, числа, булеві й `null`. Форму
// звірено з `toJSON` пакета seroval тієї версії, що тягне Start.

type Node = {
  t: number
  s?: unknown
  i?: number
  a?: Node[]
  p?: { k: string[]; v: Node[] }
  o?: number
}

const CONST_NULL = 0
const CONST_UNDEFINED = 1
const CONST_TRUE = 2
const CONST_FALSE = 3

// seroval екранує рядки, щоб їх можна було вкласти в HTML
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)

const escapeString = (s: string): string =>
  s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("<", "\\x3C")
    .replaceAll(LS, "\\u2028")
    .replaceAll(PS, "\\u2029")

const unescapeString = (s: string): string =>
  s
    .replaceAll("\\x3C", "<")
    .replaceAll("\\u2028", LS)
    .replaceAll("\\u2029", PS)
    .replaceAll('\\"', '"')
    .replaceAll("\\\\", "\\")

/** Тіло запиту Server Function: `{ data }` у форматі Start. */
export function encodePayload(data: unknown): string {
  let id = 0
  const node = (v: unknown): Node => {
    if (v === null) return { t: 2, s: CONST_NULL }
    if (v === undefined) return { t: 2, s: CONST_UNDEFINED }
    if (typeof v === "boolean") return { t: 2, s: v ? CONST_TRUE : CONST_FALSE }
    if (typeof v === "number") return { t: 0, s: v }
    if (typeof v === "string") return { t: 1, s: escapeString(v) }
    if (Array.isArray(v)) {
      const i = id++
      return { t: 9, i, a: v.map(node), o: 0 }
    }
    const entries = Object.entries(v as Record<string, unknown>)
    const i = id++
    return {
      t: 10,
      i,
      p: { k: entries.map(([k]) => k), v: entries.map(([, x]) => node(x)) },
      o: 0,
    }
  }
  return JSON.stringify({
    t: { t: 10, i: id++, p: { k: ["data"], v: [node(data)] }, o: 0 },
    f: 127,
    m: [],
  })
}

/** Значення з відповіді Server Function; `refs` — повторні посилання за `i`. */
export function decodeResponse(body: string): unknown {
  const root = JSON.parse(body) as Node
  const refs = new Map<number, unknown>()
  const read = (n: Node): unknown => {
    switch (n.t) {
      case 0:
        return n.s
      case 1:
        return unescapeString(n.s as string)
      case 2:
        return [null, undefined, true, false][n.s as number]
      case 9: {
        const out: unknown[] = []
        refs.set(n.i!, out)
        for (const x of n.a!) out.push(read(x))
        return out
      }
      case 10: {
        const out: Record<string, unknown> = {}
        refs.set(n.i!, out)
        n.p!.k.forEach((k, idx) => {
          out[k] = read(n.p!.v[idx]!)
        })
        return out
      }
      case 4:
        return refs.get(n.i!)
      default:
        throw new Error(`unsupported serialization node ${n.t}`)
    }
  }
  return read(root)
}
