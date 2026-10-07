import { z } from "zod"
import { metadataRefSchema } from "./metadata-ref"
import { objectHeaderShape } from "./object-header"

/**
 * Події підписки (спека промоції §9.3): до чи після запису й видалення рядка
 * джерела. Тригер за подією генерує П3; тут — лише множина значень.
 */
export const SUBSCRIPTION_EVENTS = [
  "beforeWrite",
  "onWrite",
  "beforeDelete",
  "onDelete",
] as const
export type SubscriptionEvent = (typeof SUBSCRIPTION_EVENTS)[number]

/** Події видалення: змінених колонок у них немає, тож `whenChanged` — помилка. */
export const DELETE_EVENTS: ReadonlySet<SubscriptionEvent> =
  new Set<SubscriptionEvent>(["beforeDelete", "onDelete"])

/**
 * Таблиця провайдера як джерело — `<схема>.<таблиця>` з пресету провайдера
 * (`PROVIDER_EVENT_SOURCES`). Наявність у пресеті перевіряє компілятор: лише
 * він бачить провайдера проєкту.
 */
const providerTableSourceSchema = z
  .strictObject({
    providerTable: z
      .string()
      .regex(/^[^.\s]+\.[^.\s]+$/)
      .meta({
        description:
          "Provider table as <schema>.<table>; it must be in the provider event source preset.",
      }),
  })
  .meta({ description: "A table of the database provider as the source." })

/**
 * Підписка на подію — вид без сховища (як перерахування): файл на підписку,
 * `physicalName` — база імені тригера П3, призначена раз. PG-схеми й скоупу в
 * неї немає: тригер живе на таблиці джерела, обробник називає схему сам.
 */
export const eventSubscriptionSchema = z.strictObject({
  ...z.object(objectHeaderShape).omit({ schema: true, scope: true }).shape,
  kind: z
    .literal("EventSubscription")
    .meta({ description: "Metadata kind; always EventSubscription." }),
  sources: z
    .array(z.union([metadataRefSchema, providerTableSourceSchema]))
    .min(1)
    .meta({
      description:
        "Tables whose rows raise the event: application objects with a table or provider tables from the preset.",
    }),
  event: z.enum(SUBSCRIPTION_EVENTS).meta({
    description: "Row event the handler reacts to, before or after it.",
  }),
  whenChanged: z.array(z.string().min(1)).min(1).optional().meta({
    description:
      "Write events only: fire only when one of these attributes changes; logical names in every object source, preset columns for a provider table.",
  }),
  handler: z
    .strictObject({
      schema: z.string().optional().meta({
        description:
          "PostgreSQL schema of the handler; the project defaultSchema applies when absent.",
      }),
      name: z.string().min(1).meta({
        description:
          "Name of a function without arguments that returns trigger, declared in the .sql files.",
      }),
    })
    .meta({ description: "Trigger function called for the event." }),
})

export type EventSubscription = z.infer<typeof eventSubscriptionSchema>
