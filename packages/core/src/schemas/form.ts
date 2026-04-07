import { z } from 'zod'
import { metadataRefSchema } from './metadata-ref'
import { localizedStringSchema, type LocalizedString } from './localized-string'

export const formKindSchema = z.enum(['ItemForm', 'ListForm'])
export type FormKind = z.infer<typeof formKindSchema>

// Kinds що підтримують forms
export const formSupportedKinds = ['Catalog', 'Document', 'CustomTable'] as const
export type FormSupportedKind = (typeof formSupportedKinds)[number]

// ============================================================
// TypeScript-типи для layout елементів (BRD §10.5.3)
// Визначаємо окремо від Zod для підтримки рекурсії
// ============================================================

/** Поле форми, прив'язане до реквізиту об'єкта */
export interface FormFieldElement {
  element: 'Field'
  ref: string
  label?: LocalizedString | null
  component?: string | null
  readOnly?: boolean
  autoFocus?: boolean
  placeholder?: LocalizedString | null
  className?: string | null
  hidden?: boolean
}

/** Таблична частина у формі */
export interface FormTabularSectionElement {
  element: 'TabularSection'
  ref: string
  columns?: string[] | null
  allowAdd?: boolean
  allowDelete?: boolean
  allowReorder?: boolean
}

/** Горизонтальна лінія-роздільник */
export interface FormSeparatorElement {
  element: 'Separator'
}

/** Статичний текстовий label */
export interface FormLabelElement {
  element: 'Label'
  text: LocalizedString
  className?: string | null
}

/** Візуальна група полів з заголовком */
export interface FormGroupElement {
  element: 'Group'
  title?: LocalizedString
  children: FormLayoutElement[]
  className?: string | null
}

/** Одна колонка у multi-column layout */
export interface FormColumnElement {
  element: 'Column'
  children: FormLayoutElement[]
}

/** Multi-column layout (містить Column[]) */
export interface FormColumnsElement {
  element: 'Columns'
  /** Масив Column-елементів (task spec: columns, не children) */
  columns: FormColumnElement[]
}

/** Одна вкладка */
export interface FormTabElement {
  element: 'Tab'
  title: LocalizedString
  children: FormLayoutElement[]
}

/** Набір вкладок (містить Tab[]) */
export interface FormTabsElement {
  element: 'Tabs'
  /** Масив Tab-елементів (task spec: tabs, не children) */
  tabs: FormTabElement[]
}

/** Секція, що згортається */
export interface FormAccordionElement {
  element: 'Accordion'
  title: LocalizedString
  children: FormLayoutElement[]
}

/** Будь-який layout-елемент форми (BRD §10.5.3) */
export type FormLayoutElement =
  | FormFieldElement
  | FormTabularSectionElement
  | FormSeparatorElement
  | FormLabelElement
  | FormGroupElement
  | FormColumnsElement
  | FormColumnElement
  | FormTabsElement
  | FormTabElement
  | FormAccordionElement

// ============================================================
// Leaf element schemas (без рекурсії)
// ============================================================

const formFieldElementSchema = z.object({
  element: z.literal('Field'),
  ref: z.string().min(1, 'Field ref must not be empty'),
  label: localizedStringSchema.nullable().optional(),
  component: z.string().nullable().optional(),
  readOnly: z.boolean().optional(),
  autoFocus: z.boolean().optional(),
  placeholder: localizedStringSchema.nullable().optional(),
  className: z.string().nullable().optional(),
  hidden: z.boolean().optional(),
})

const formTabularSectionElementSchema = z.object({
  element: z.literal('TabularSection'),
  ref: z.string().min(1, 'TabularSection ref must not be empty'),
  columns: z.array(z.string()).nullable().optional(),
  allowAdd: z.boolean().optional(),
  allowDelete: z.boolean().optional(),
  allowReorder: z.boolean().optional(),
})

const formSeparatorElementSchema = z.object({
  element: z.literal('Separator'),
})

const formLabelElementSchema = z.object({
  element: z.literal('Label'),
  text: localizedStringSchema,
  className: z.string().nullable().optional(),
})

// ============================================================
// Recursive discriminated union для layout елементів
// Використовує z.lazy() для підтримки контейнерних елементів (Group, Column, Tabs, Tab, Accordion)
// ============================================================

/**
 * Zod-схема для FormLayoutElement.
 * z.lazy() дозволяє рекурсивні посилання всередині контейнерних елементів.
 */
export const formLayoutElementSchema: z.ZodType<FormLayoutElement> = z.lazy(() =>
  z.discriminatedUnion('element', [
    formFieldElementSchema,
    formTabularSectionElementSchema,
    formSeparatorElementSchema,
    formLabelElementSchema,
    // Group — контейнер з довільними дочірніми елементами
    z.object({
      element: z.literal('Group'),
      title: localizedStringSchema.optional(),
      children: z.array(formLayoutElementSchema),
      className: z.string().nullable().optional(),
    }),
    // Column — одна колонка (дочірній елемент Columns)
    z.object({
      element: z.literal('Column'),
      children: z.array(formLayoutElementSchema),
    }),
    // Columns — multi-column layout, columns — виключно Column[]  (task spec: ключ "columns")
    z.object({
      element: z.literal('Columns'),
      columns: z.array(
        z.object({
          element: z.literal('Column'),
          children: z.array(formLayoutElementSchema),
        }),
      ),
    }),
    // Tab — одна вкладка (дочірній елемент Tabs)
    z.object({
      element: z.literal('Tab'),
      title: localizedStringSchema,
      children: z.array(formLayoutElementSchema),
    }),
    // Tabs — набір вкладок, tabs — виключно Tab[] (task spec: ключ "tabs")
    z.object({
      element: z.literal('Tabs'),
      tabs: z.array(
        z.object({
          element: z.literal('Tab'),
          title: localizedStringSchema,
          children: z.array(formLayoutElementSchema),
        }),
      ),
    }),
    // Accordion — секція, що згортається
    z.object({
      element: z.literal('Accordion'),
      title: localizedStringSchema,
      children: z.array(formLayoutElementSchema),
    }),
  ]) as z.ZodType<FormLayoutElement>,
)

// ============================================================
// Toolbar schemas (BRD §10.5.4)
// ============================================================

/** Стандартна кнопка або роздільник у toolbar */
export const toolbarItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SaveButton') }),
  z.object({ type: z.literal('SaveAndCloseButton') }),
  z.object({ type: z.literal('PostButton') }),
  z.object({ type: z.literal('UnpostButton') }),
  z.object({ type: z.literal('DeletionMarkButton') }),
  z.object({ type: z.literal('Separator') }),
  z.object({
    type: z.literal('CustomButton'),
    name: z.string().min(1),
    label: localizedStringSchema,
    icon: z.string().optional(),
    action: z.string().optional(),
  }),
])

export type ToolbarItem = z.infer<typeof toolbarItemSchema>

// ============================================================
// CommandBar schemas (BRD §10.5.4)
// ============================================================

/** Навігаційне посилання внизу форми */
export const commandBarItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('NavigationLink'),
    label: localizedStringSchema,
    target: metadataRefSchema,
    filter: z.record(z.string(), z.string()).optional(),
  }),
])

export type CommandBarItem = z.infer<typeof commandBarItemSchema>

// ============================================================
// FormSchema — повна схема файлу форми (BRD §10.5.2)
// ============================================================

/** Ширина форми */
export const formWidthSchema = z.enum(['sm', 'md', 'lg', 'xl', '2xl', 'full'])
export type FormWidth = z.infer<typeof formWidthSchema>

// Препроцесор для layout: порожній об'єкт {} (BRD placeholder) перетворюємо на undefined
// для backward-compatibility зі збереженими чернетковими формами
const layoutPreprocessSchema = z.preprocess(
  (v) =>
    v != null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !('element' in (v as Record<string, unknown>))
      ? undefined
      : v,
  formLayoutElementSchema.optional(),
)

export const formSchema = z.object({
  $schema: z.string().optional(),
  kind: formKindSchema,
  objectRef: metadataRefSchema,
  title: localizedStringSchema.optional(),
  width: formWidthSchema.optional(),
  layout: layoutPreprocessSchema,
  toolbar: z.array(toolbarItemSchema).optional(),
  commandBar: z.array(commandBarItemSchema).optional(),
})

export type FormSchema = z.infer<typeof formSchema>
