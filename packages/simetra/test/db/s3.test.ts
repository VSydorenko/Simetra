import { afterEach, describe, expect, it, vi } from "vitest"
import { parseSupabaseS3, s3ConfigOf } from "./s3"

describe("parseSupabaseS3", () => {
  const status = [
    'STORAGE_S3_URL="http://127.0.0.1:54321/storage/v1/s3"',
    'S3_PROTOCOL_ACCESS_KEY_ID="abc"',
    'S3_PROTOCOL_ACCESS_KEY_SECRET="def"',
    'S3_PROTOCOL_REGION="local"',
  ].join("\n")

  it("takes the keys and region, takes the endpoint from STORAGE_S3_URL", () => {
    expect(parseSupabaseS3(status)).toEqual({
      endpoint: "http://127.0.0.1:54321/storage/v1/s3",
      region: "local",
      accessKeyId: "abc",
      secretAccessKey: "def",
    })
  })

  it("does not derive the endpoint from API_URL", () => {
    const noUrl = status
      .split("\n")
      .filter((l) => !l.startsWith("STORAGE_S3_URL"))
      .concat('API_URL="http://127.0.0.1:54321"')
      .join("\n")
    expect(() => parseSupabaseS3(noUrl)).toThrow(/no S3 values/)
  })

  it("names what is missing instead of guessing", () => {
    expect(() => parseSupabaseS3('API_URL="http://127.0.0.1:54321"')).toThrow(
      /no S3 values/
    )
  })
})

describe("s3ConfigOf postgres", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("takes the Garage S3 endpoint from the stack index on each call", () => {
    vi.stubEnv("SIMETRA_STACK", undefined)
    expect(s3ConfigOf("postgres").endpoint).toBe("http://127.0.0.1:3900")
    vi.stubEnv("SIMETRA_STACK", "2")
    expect(s3ConfigOf("postgres").endpoint).toBe("http://127.0.0.1:3910")
  })
})
