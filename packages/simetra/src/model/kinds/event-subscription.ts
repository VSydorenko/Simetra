import {
  eventSubscriptionSchema,
  type EventSubscription,
} from "../schemas/event-subscription"
import {
  keyOrderOf,
  type KindDefinition,
  type SubscriptionSpec,
} from "./standard"

function subscriptionOf(obj: unknown): SubscriptionSpec {
  const data = obj as EventSubscription
  return {
    sources: data.sources.map((source, index) => {
      const pointer = `/sources/${index}`
      if ("providerTable" in source) {
        // Форму `<схема>.<таблиця>` гарантує схема виду.
        const [schema, table] = source.providerTable.split(".") as [
          string,
          string,
        ]
        return { pointer, providerTable: { schema, table } }
      }
      return { pointer, ref: source }
    }),
    event: data.event,
    ...(data.whenChanged === undefined
      ? {}
      : { whenChanged: data.whenChanged }),
    handler: {
      ...(data.handler.schema === undefined
        ? {}
        : { schema: data.handler.schema }),
      name: data.handler.name,
    },
  }
}

/**
 * Підписка на подію — вид без сховища, як перерахування (спека промоції
 * §9.3): таблиці й значень немає, на неї не посилаються. Джерела-об'єкти —
 * посилання індексу, тож перейменування й видалення джерела бачать її даром.
 */
export const eventSubscriptionKind: KindDefinition = {
  kind: "EventSubscription",
  dir: "event-subscriptions",
  schema: eventSubscriptionSchema,
  keyOrder: keyOrderOf(eventSubscriptionSchema),
  referenceable: false,
  writePattern: "none",
  actions: [],
  materializes: "none",
  scope: "absent",
  declared: false,
  columnFields: [],
  valueElements: false,
  standardColumns: () => [],
  references: (obj) =>
    subscriptionOf(obj).sources.flatMap((source) =>
      "ref" in source
        ? [
            {
              pointer: source.pointer,
              ref: source.ref,
              role: "eventSubscription.source" as const,
            },
          ]
        : []
    ),
  subscription: subscriptionOf,
}
