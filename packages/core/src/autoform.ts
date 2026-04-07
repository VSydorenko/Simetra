import type {
  FormSchema,
  FormLayoutElement,
  FormSupportedKind,
  FormTabElement,
  FormKind,
} from './schemas/form'
import type { ProjectModel } from './schemas/project-model'
import type { MetadataRef } from './schemas/metadata-ref'
import { getStandardAttributes } from './schemas/standard-attributes'

// Типи об'єктів, з яких autoform витягує attributes і tabularSections
interface AutoformObjectBase {
  name: string
  attributes: { name: string }[]
}

interface AutoformObjectWithTabular extends AutoformObjectBase {
  tabularSections?: { name: string; displayName?: { uk: string; en: string } }[]
}

// Налаштування для отримання стандартних реквізитів
interface CatalogSettings {
  hierarchyType?: 'None' | 'FoldersAndItems' | 'ItemsOnly'
  owners?: { kind: string; name: string }[]
}

interface CustomTableSettings {
  autoAddPrimaryKey?: boolean
}

// ============================================================
// Стандартні реквізити, які НЕ показуються в тілі форми
// (показуються в header/sidebar як readonly)
// ============================================================

/** Набір імен стандартних реквізитів для конкретного kind + settings */
function getStandardAttributeNames(
  kind: FormSupportedKind,
  object: Record<string, unknown>,
): Set<string> {
  const settings = buildStandardAttributeSettings(kind, object)
  const stdAttrs = getStandardAttributes(kind, settings)
  return new Set(stdAttrs.map((a) => a.name))
}

/** Зібрати StandardAttributeSettings з полів об'єкта */
function buildStandardAttributeSettings(
  kind: FormSupportedKind,
  object: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case 'Catalog':
      return {
        hierarchyType: (object as CatalogSettings).hierarchyType ?? 'None',
        owners: (object as CatalogSettings).owners ?? [],
      }
    case 'CustomTable':
      return {
        autoAddPrimaryKey: (object as CustomTableSettings).autoAddPrimaryKey ?? true,
      }
    case 'Document':
      return {}
    default:
      return {}
  }
}

// ============================================================
// Стандартні presentation реквізити для list forms
// ============================================================

/** Presentation реквізити для списку відповідно до kind */
function getPresentationColumns(kind: FormSupportedKind): string[] {
  switch (kind) {
    case 'Catalog':
      return ['code', 'description']
    case 'Document':
      return ['number', 'date']
    case 'CustomTable':
      return []
  }
}



// ============================================================
// Toolbar generation
// ============================================================

/** Toolbar за типом об'єкта */
function generateToolbar(kind: FormSupportedKind): FormSchema['toolbar'] {
  switch (kind) {
    case 'Catalog':
      return [{ type: 'SaveButton' }, { type: 'DeletionMarkButton' }]
    case 'Document':
      return [
        { type: 'SaveButton' },
        { type: 'PostButton' },
        { type: 'UnpostButton' },
        { type: 'DeletionMarkButton' },
      ]
    case 'CustomTable':
      return [{ type: 'SaveButton' }]
    default:
      return [{ type: 'SaveButton' }]
  }
}

// ============================================================
// Максимум стовпців у auto-list
// ============================================================

const MAX_LIST_COLUMNS = 8
const MAX_LIST_COLUMNS_THRESHOLD = 10

// ============================================================
// Item Form Generation
// ============================================================

/**
 * Генерує canonical ItemForm з metadata об'єкта.
 *
 * Алгоритм:
 * 1. Стандартні реквізити НЕ включаються в тіло форми
 * 2. User-defined attributes у порядку масиву
 * 3. Є ТЧ → Tabs (перша вкладка "Основні" з полями, решта — по ТЧ)
 * 4. Немає ТЧ, полів > 6 → Columns (два стовпці)
 * 5. Немає ТЧ, полів ≤ 6 → вертикальний список Field
 */
export function generateItemForm(
  object: AutoformObjectWithTabular & Record<string, unknown>,
  kind: FormSupportedKind,
): FormSchema {
  const stdNames = getStandardAttributeNames(kind, object)
  const userAttrs = object.attributes.filter((a) => !stdNames.has(a.name))
  const tabularSections = object.tabularSections ?? []

  const fieldElements: FormLayoutElement[] = userAttrs.map((a) => ({
    element: 'Field' as const,
    ref: a.name,
  }))

  let layout: FormLayoutElement | undefined

  if (tabularSections.length > 0) {
    // Tabs: перша вкладка "Основні" з полями, решта — по одній на кожну ТЧ
    const mainTab: FormTabElement = {
      element: 'Tab' as const,
      title: { uk: 'Основні', en: 'General' },
      children: fieldElements,
    }

    const tsTabsElements: FormTabElement[] = tabularSections.map((ts) => ({
      element: 'Tab' as const,
      title: ts.displayName ?? { uk: ts.name, en: ts.name },
      children: [
        {
          element: 'TabularSection' as const,
          ref: ts.name,
        } satisfies FormLayoutElement,
      ],
    }))

    layout = {
      element: 'Tabs' as const,
      tabs: [mainTab, ...tsTabsElements],
    }
  } else if (userAttrs.length > 6) {
    // Два стовпці: поділити поля порівну
    const mid = Math.ceil(userAttrs.length / 2)
    layout = {
      element: 'Columns' as const,
      columns: [
        {
          element: 'Column' as const,
          children: fieldElements.slice(0, mid),
        },
        {
          element: 'Column' as const,
          children: fieldElements.slice(mid),
        },
      ],
    }
  } else if (fieldElements.length > 0) {
    // Вертикальний список полів у Group
    layout = {
      element: 'Group' as const,
      children: fieldElements,
    }
  }

  return {
    kind: 'ItemForm',
    objectRef: { kind, name: object.name },
    toolbar: generateToolbar(kind),
    ...(layout ? { layout } : {}),
  }
}

// ============================================================
// List Form Generation
// ============================================================

/**
 * Генерує canonical ListForm з metadata об'єкта.
 *
 * Алгоритм:
 * 1. Presentation стовпці: code/description для Catalog, number/date для Document
 * 2. User-defined attributes у порядку масиву
 * 3. Для великих об'єктів (>10 стовпців) → обрізати до MAX_LIST_COLUMNS (8)
 * 4. Sorting defaults (Catalog → code asc, Document → date desc) —
 *    не зберігаються у FormSchema (відсутнє поле sort), реалізуються в runtime
 */
export function generateListForm(
  object: AutoformObjectBase & Record<string, unknown>,
  kind: FormSupportedKind,
): FormSchema {
  const stdNames = getStandardAttributeNames(kind, object)
  const presentationCols = getPresentationColumns(kind)
  const userAttrs = object.attributes.filter((a) => !stdNames.has(a.name))

  // Presentation columns + user-defined attributes
  const allColumns = [...presentationCols, ...userAttrs.map((a) => a.name)]

  // Обмежити кількість стовпців лише для великих об'єктів (>10 полів)
  const columns =
    allColumns.length > MAX_LIST_COLUMNS_THRESHOLD
      ? allColumns.slice(0, MAX_LIST_COLUMNS)
      : allColumns

  const columnFields: FormLayoutElement[] = columns.map((col) => ({
    element: 'Field' as const,
    ref: col,
  }))

  return {
    kind: 'ListForm',
    objectRef: { kind, name: object.name },
    ...(columnFields.length > 0
      ? {
          layout: {
            element: 'Group' as const,
            children: columnFields,
          },
        }
      : {}),
  }
}

// ============================================================
// Form Resolution
// ============================================================

/** Колекція ProjectModel → ключ */
const KIND_TO_COLLECTION: Record<FormSupportedKind, keyof ProjectModel> = {
  Catalog: 'catalogs',
  Document: 'documents',
  CustomTable: 'customTables',
}

/**
 * Знаходить explicit form або генерує autoform.
 *
 * Precedence rule:
 * 1. Explicit form у model.forms → пріоритет
 * 2. Autogenerated стандартна форма → гарантований fallback
 */
export function resolveForm(
  objectRef: MetadataRef,
  formKind: FormKind,
  model: ProjectModel,
): FormSchema {
  // Спочатку шукаємо explicit form
  const explicit = model.forms?.find(
    (f) =>
      f.kind === formKind &&
      f.objectRef.kind === objectRef.kind &&
      f.objectRef.name === objectRef.name,
  )
  if (explicit) return explicit

  // Fallback: autogenerated form
  const kind = objectRef.kind as FormSupportedKind
  const collectionKey = KIND_TO_COLLECTION[kind]
  if (!collectionKey) {
    // Для непідтримуваних kinds — мінімальна порожня форма
    return {
      kind: formKind,
      objectRef: { kind: objectRef.kind, name: objectRef.name },
    }
  }

  const collection = model[collectionKey] as
    | (AutoformObjectWithTabular & Record<string, unknown>)[]
    | undefined
  const object = collection?.find((o) => o.name === objectRef.name)
  if (!object) {
    // Об'єкт не знайдено — порожня форма
    return {
      kind: formKind,
      objectRef: { kind: objectRef.kind, name: objectRef.name },
    }
  }

  return formKind === 'ItemForm'
    ? generateItemForm(object, kind)
    : generateListForm(object, kind)
}
