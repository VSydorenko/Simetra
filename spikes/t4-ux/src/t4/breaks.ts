// Навмисно зламані реалізації для тесту самого оракула (критерій 1).
// Вмикаються параметром `?break=a,b` або cookie `break` (для SSR-гілок).
export const breaks = new Set<string>()

export function readBreaks(source: string | null | undefined) {
  breaks.clear()
  for (const b of (source ?? "").split(",")) if (b) breaks.add(b)
}
