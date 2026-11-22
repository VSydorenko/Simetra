import { describe, expect, it } from "vitest"
import { parseSupabaseS3 } from "./s3"

describe("parseSupabaseS3", () => {
  const status = [
    'API_URL="http://127.0.0.1:54321"',
    'S3_PROTOCOL_ACCESS_KEY_ID="abc"',
    'S3_PROTOCOL_ACCESS_KEY_SECRET="def"',
    'S3_PROTOCOL_REGION="local"',
  ].join("\n")

  it("takes the keys and region, derives the endpoint from the API URL", () => {
    expect(parseSupabaseS3(status)).toEqual({
      endpoint: "http://127.0.0.1:54321/storage/v1/s3",
      region: "local",
      accessKeyId: "abc",
      secretAccessKey: "def",
    })
  })

  it("names what is missing instead of guessing", () => {
    expect(() => parseSupabaseS3('API_URL="http://127.0.0.1:54321"')).toThrow(
      /no S3 values/
    )
  })
})
