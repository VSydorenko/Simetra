// Portions copied from munin-mcp (https://github.com/VSydorenko/munin-mcp, gateway/src/oauth/safe-fetch.ts, gateway/src/oauth/redirects.ts)
// Copyright 2026 Volodymyr Sydorenko
// Licensed under Apache-2.0. Modified: a loopback redirect is any http loopback URI (any port, any path); normalisation always drops jwks_uri/jwks/token_endpoint_auth_signing_alg and forces auth method none; a document that neither declares nor supports none is refused; the munin redirect allowlist is not copied; error messages are in English.
import dns from "node:dns"
import type http from "node:http"
import https from "node:https"
import net from "node:net"

// Спеціальні IPv4 (RFC 6890 і суміжні): unspecified, private, CGNAT, loopback, link-local, документація, multicast, резерв.
const V4_DENY: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]
// IPv6: дозволено лише глобальний unicast 2000::/3, крім спеціальних підмереж у ньому (Teredo/IETF, документація, 6to4).
const V6_DENY_IN_GLOBAL: readonly [string, number][] = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0)
}

function v4Forbidden(ip: string): boolean {
  const a = v4ToInt(ip)
  return V4_DENY.some(([p, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (a & mask) >>> 0 === (v4ToInt(p) & mask) >>> 0
  })
}

/** 128-бітне значення IPv6 (з вкладеним IPv4 у кінці або без). */
function v6ToBigInt(ip: string): bigint {
  let s = ip
  const lastColon = s.lastIndexOf(":")
  if (s.slice(lastColon + 1).includes(".")) {
    // вкладений a.b.c.d → дві шістнадцяткові групи
    const v4 = v4ToInt(s.slice(lastColon + 1))
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const [head, rest] = s.includes("::")
    ? (s.split("::") as [string, string])
    : [s, undefined]
  const left = head ? head.split(":") : []
  const right = rest ? rest.split(":") : []
  const fill = rest === undefined ? 0 : 8 - left.length - right.length
  const groups = [...left, ...Array<string>(fill).fill("0"), ...right].map(
    (g) => parseInt(g, 16)
  )
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n)
}

function inV6(a: bigint, prefix: string, bits: number): boolean {
  const shift = BigInt(128 - bits)
  return a >> shift === v6ToBigInt(prefix) >> shift
}

/**
 * Адреса, до якої шлюз не з'єднується: unspecified, loopback, private, link-local, CGNAT `100.64/10`, ULA, multicast,
 * документація, `::ffff:`-відображені на заборонені IPv4. Нерозпізнаний рядок — заборонений.
 */
export function isForbiddenAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Forbidden(ip)
  if (!net.isIPv6(ip) || ip.includes("%")) return true
  const a = v6ToBigInt(ip.toLowerCase())
  if (a >> 32n === 0xffffn) {
    const v4 = Number(a & 0xffffffffn)
    return v4Forbidden(
      [v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join(".")
    )
  }
  if (!inV6(a, "2000::", 3)) return true
  return V6_DENY_IN_GLOBAL.some(([p, bits]) => inV6(a, p, bits))
}

/**
 * Нормалізація документа CIMD (спека П4-F §5.4): клієнти лише публічні, тож метод
 * автентифікації — `none`, а `jwks_uri`/`jwks` видаляються, щоб бібліотека їх не
 * завантажувала. Документ без `application_type`, усі redirect якого — loopback,
 * стає `native`: тоді loopback порівнюється без порту (RFC 8252 §7.3).
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

// Loopback — `http:` з хостом loopback, будь-який порт і будь-який шлях
// (рішення архітекторки до Р-F4-6): шлях збігається з документом точно й так
function isLoopbackRedirect(uri: unknown): boolean {
  const u = typeof uri === "string" ? URL.parse(uri) : null
  return u !== null && u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)
}

export function normalizeClientMetadata<T extends Record<string, unknown>>(
  meta: T
): T {
  if (!acceptsPublicAuth(meta)) throw new CimdRejectedError()
  const out: Record<string, unknown> = {
    ...meta,
    token_endpoint_auth_method: "none",
  }
  for (const k of ["jwks_uri", "jwks", "token_endpoint_auth_signing_alg"])
    delete out[k]
  const uris = out.redirect_uris
  if (
    out.application_type === undefined &&
    Array.isArray(uris) &&
    uris.length > 0 &&
    uris.every(isLoopbackRedirect)
  ) {
    out.application_type = "native"
  }
  return out as T
}

// Публічний клієнт (`none`) мусить бути тим, що документ оголошує чи
// підтримує: інакше ми мовчки міняли б клієнтові, що вимагає автентифікації,
// модель довіри (Р-F4-6)
function acceptsPublicAuth(meta: Record<string, unknown>): boolean {
  const supported = meta.token_endpoint_auth_methods_supported
  return (
    meta.token_endpoint_auth_method === "none" ||
    (Array.isArray(supported) && supported.includes("none"))
  )
}

/** Документ CIMD не оголошує й не підтримує публічної автентифікації `none`. */
export class CimdRejectedError extends Error {
  constructor() {
    super("the client metadata document does not allow auth method none")
    this.name = "CimdRejectedError"
  }
}

export class ForbiddenAddressError extends Error {
  constructor() {
    super("the address is forbidden by the SSRF policy")
    this.name = "ForbiddenAddressError"
  }
}

export interface SafeFetchOptions {
  resolve?: typeof dns.lookup
  /** Загальний строк запиту; типово 5 с. */
  timeoutMs?: number
  /** Межа тіла; типово 5 КБ. */
  maxBytes?: number
  /** Лише для тестів: транспорт (http замість https) і політика адрес. */
  transport?: typeof https.request
  isForbidden?: (ip: string) => boolean
}

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_BYTES = 5 * 1024
const NULL_BODY = new Set([101, 204, 205, 304])

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number
) => void

/**
 * Завантаження документа CIMD (спека § 6): лише `https`; DNS-відповідь перевіряється **до** з'єднання (власний `lookup`),
 * IP-літерал — до запиту; без редиректів (3xx повертається як є); тіло > `maxBytes` і перевищення строку — помилка.
 */
export async function safeFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  o: SafeFetchOptions = {}
): Promise<Response> {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  )
  if (url.protocol !== "https:") throw new TypeError("only https is allowed")
  if (url.username || url.password)
    throw new TypeError("userinfo in the URL is forbidden")
  const forbidden = o.isForbidden ?? isForbiddenAddress
  const resolve = o.resolve ?? dns.lookup
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const hostname = url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname
  // IP-літерал net.connect не резолвить — lookup не викликався б.
  if (net.isIP(hostname) && forbidden(hostname))
    throw new ForbiddenAddressError()

  const lookup = (host: string, opts: dns.LookupOptions, cb: LookupCb) => {
    resolve(host, { ...opts, all: true }, (err, addrs) => {
      if (err) {
        cb(err, "")
        return
      }
      const list = addrs as unknown as dns.LookupAddress[]
      if (
        !Array.isArray(list) ||
        list.length === 0 ||
        list.some((a) => forbidden(a.address))
      ) {
        cb(
          Object.assign(new ForbiddenAddressError(), { code: "EFORBIDDEN" }),
          ""
        )
        return
      }
      if (opts.all) cb(null, list)
      else cb(null, list[0]!.address, list[0]!.family)
    })
  }

  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((v, k) => {
    headers[k] = v
  })
  const request = o.transport ?? https.request
  const signals = [
    AbortSignal.timeout(timeoutMs),
    ...(init.signal ? [init.signal] : []),
  ]

  return new Promise<Response>((resolveP, reject) => {
    let settled = false
    const fail = (e: unknown) => {
      if (settled) return
      settled = true
      req.destroy()
      reject(e instanceof Error ? e : new Error(String(e)))
    }
    const req = request(
      {
        hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers,
        agent: false,
        lookup: lookup as unknown as http.RequestOptions["lookup"],
        signal: AbortSignal.any(signals),
      },
      (res) => {
        const status = res.statusCode ?? 0
        const declared = Number(res.headers["content-length"])
        if (Number.isFinite(declared) && declared > maxBytes) {
          fail(new Error("the response body exceeds the limit"))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on("data", (c: Buffer) => {
          size += c.length
          if (size > maxBytes) {
            fail(new Error("the response body exceeds the limit"))
            return
          }
          chunks.push(c)
        })
        res.on("error", fail)
        res.on("end", () => {
          if (settled) return
          if (status < 200 || status > 599) {
            fail(new Error("unexpected response status"))
            return
          }
          settled = true
          const h = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined || k === "set-cookie") continue
            h.set(k, Array.isArray(v) ? v.join(", ") : v)
          }
          resolveP(
            new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), {
              status,
              headers: h,
            })
          )
        })
      }
    )
    req.on("error", fail)
    req.end()
  })
}

/**
 * Обгортка над `fetch` провайдера: успішний JSON-документ CIMD проходить
 * `normalizeClientMetadata` раніше, ніж його бачить бібліотека. Документ без
 * `none` — виняток транспорту, тож бібліотека відмовляє клієнтові
 * (`invalid_client`). Решта відповідей — як є (бібліотека сама відкине не-200,
 * не-JSON і завеликі).
 */
export function withCimdNormalization(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init)
    if (res.status !== 200) return res
    const text = await res.text()
    const headers = new Headers(res.headers)
    headers.delete("content-length")
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // не JSON — бібліотека відкине сама
      return new Response(text, { status: res.status, headers })
    }
    const body =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? JSON.stringify(
            normalizeClientMetadata(parsed as Record<string, unknown>)
          )
        : text
    return new Response(body, { status: res.status, headers })
  }) as typeof fetch
}
