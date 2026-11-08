// Тонкий фасад полігона над ядром спайку 1: специфікації виглядів, запис із
// політикою дії і фонове перечитування (рух складу — лише дією користувача).
import {
  ITEM,
  ORDER,
  type ActionPolicy,
  type CoreSession,
  type ViewSpec,
} from "../core"

export const LIST: ViewSpec = {
  kind: "window",
  object: ITEM,
  orderBy: ORDER,
  pageSize: 100,
}
export const cardSpec = (key: string): ViewSpec => ({
  kind: "card",
  object: ITEM,
  key,
})
export const linesSpec = (key: string): ViewSpec => ({
  kind: "section",
  object: ITEM,
  owner: key,
  section: "lines",
})

/** Політика дії за замовчуванням полігона (`?policy=`); ядро типово — `await`. */
export const settings: { policy: ActionPolicy } = { policy: "predict" }

export function writerOf(core: CoreSession) {
  const tx = () => core.begin({ policy: settings.policy })
  return {
    update: (key: string, values: Record<string, unknown>) =>
      tx().update(ITEM, key, values).commit(),
    // id генерує клієнт (§7.1): ключ рядка стабільний від першого кадру до підтвердження.
    create: (values: Record<string, unknown>) =>
      tx().create(ITEM, crypto.randomUUID(), values).commit(),
    remove: (key: string) => tx().delete(ITEM, key).commit(),
    retry: (id: number) => core.retry(id),
    cancel: (id: number) => core.cancel(id),
  }
}

/** Фонове перечитування (як rejoin): лише наявні ключі, склад не змінюється. */
export function rereadVisible(core: CoreSession) {
  const keys = core
    .view(LIST)
    .getSnapshot()
    .rows.map((r) => r.key)
  return core.refetchKeys(ITEM, keys)
}
