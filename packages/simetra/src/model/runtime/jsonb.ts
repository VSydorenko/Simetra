/**
 * Pairs per `jsonb_build_object` call. Postgres accepts at most 100 function
 * arguments (`FUNC_MAX_ARGS`), and every pair takes two of them.
 */
export const JSONB_PAIRS_PER_CALL = 50

/**
 * Renders a `jsonb` object from already-rendered `'<key>', <expr>` pairs.
 * Up to {@link JSONB_PAIRS_PER_CALL} pairs give one `jsonb_build_object(…)`;
 * more pairs are split into chunks joined by `||`, in parentheses, so a table
 * with any number of columns stays under the 100-argument limit.
 *
 * @throws Error when `pairs` is empty: the caller decides what an object
 *   without pairs means (`to_jsonb(row)` alone, `'{}'::jsonb`, nothing).
 */
export function jsonbBuildObject(pairs: readonly string[]): string {
  // Порожній вхід — помилка генератора: мовчазне `'{}'::jsonb` сховало б, що
  // викликач забув свою гілку «без пар».
  if (pairs.length === 0) throw new Error("jsonbBuildObject: no pairs")
  const calls: string[] = []
  for (let i = 0; i < pairs.length; i += JSONB_PAIRS_PER_CALL) {
    calls.push(
      `jsonb_build_object(${pairs.slice(i, i + JSONB_PAIRS_PER_CALL).join(", ")})`
    )
  }
  return calls.length === 1 ? calls[0]! : `(${calls.join(" || ")})`
}
