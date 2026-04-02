import type { MetadataKind } from './metadata-kind'

export interface StandardAttribute {
  name: string
  type: string
  ref?: string
  description: { uk: string; en: string }
}

export interface StandardAttributeSettings {
  hierarchyType?: 'None' | 'FoldersAndItems' | 'ItemsOnly'
  owners?: { kind: string; name: string }[]
  periodicity?: string
  writeMode?: string
  registerType?: 'Balance' | 'Turnover'
  autoAddPrimaryKey?: boolean
}

function catalogStandardAttributes(
  settings: StandardAttributeSettings,
): StandardAttribute[] {
  const attrs: StandardAttribute[] = [
    {
      name: 'id',
      type: 'UUID',
      description: { uk: 'Унікальний ідентифікатор', en: 'Unique identifier' },
    },
    {
      name: 'code',
      type: 'String',
      description: { uk: 'Код елемента', en: 'Item code' },
    },
    {
      name: 'description',
      type: 'String',
      description: { uk: 'Найменування', en: 'Description' },
    },
    {
      name: 'deletion_mark',
      type: 'Boolean',
      description: { uk: 'Позначка видалення', en: 'Deletion mark' },
    },
  ]

  if (settings.hierarchyType && settings.hierarchyType !== 'None') {
    attrs.push(
      {
        name: 'parent_id',
        type: 'CatalogRef',
        ref: 'Self',
        description: { uk: 'Батьківський елемент', en: 'Parent item' },
      },
      {
        name: 'is_folder',
        type: 'Boolean',
        description: { uk: 'Це група', en: 'Is folder' },
      },
    )
  }

  if (settings.owners && settings.owners.length > 0) {
    // TODO: 2026-04-02 — якщо є кілька owners, тип має бути AnyRef (polymorphic reference)
    attrs.push({
      name: 'owner_id',
      type: 'CatalogRef',
      ref: settings.owners[0].name,
      description: { uk: 'Власник', en: 'Owner' },
    })
  }

  attrs.push(
    {
      name: 'predefined_name',
      type: 'String',
      description: {
        uk: "Ім'я попередньо визначеного елемента",
        en: 'Predefined item name',
      },
    },
    {
      name: 'created_at',
      type: 'DateTime',
      description: { uk: 'Дата створення', en: 'Created at' },
    },
    {
      name: 'updated_at',
      type: 'DateTime',
      description: { uk: 'Дата оновлення', en: 'Updated at' },
    },
  )

  return attrs
}

function documentStandardAttributes(): StandardAttribute[] {
  return [
    {
      name: 'id',
      type: 'UUID',
      description: { uk: 'Унікальний ідентифікатор', en: 'Unique identifier' },
    },
    {
      name: 'number',
      type: 'String',
      description: { uk: 'Номер документа', en: 'Document number' },
    },
    {
      name: 'date',
      type: 'DateTime',
      description: { uk: 'Дата документа', en: 'Document date' },
    },
    {
      name: 'posted',
      type: 'Boolean',
      description: { uk: 'Проведений', en: 'Posted' },
    },
    {
      name: 'deletion_mark',
      type: 'Boolean',
      description: { uk: 'Позначка видалення', en: 'Deletion mark' },
    },
    {
      name: 'created_at',
      type: 'DateTime',
      description: { uk: 'Дата створення', en: 'Created at' },
    },
    {
      name: 'updated_at',
      type: 'DateTime',
      description: { uk: 'Дата оновлення', en: 'Updated at' },
    },
  ]
}

function informationRegisterStandardAttributes(
  settings: StandardAttributeSettings,
): StandardAttribute[] {
  const attrs: StandardAttribute[] = []

  if (settings.periodicity && settings.periodicity !== 'NonPeriodic') {
    attrs.push({
      name: 'period',
      type: 'DateTime',
      description: { uk: 'Період', en: 'Period' },
    })
  }

  if (settings.writeMode === 'RecorderSubordinate') {
    attrs.push(
      {
        name: 'recorder_id',
        type: 'DocumentRef',
        description: { uk: 'Реєстратор', en: 'Recorder' },
      },
      {
        name: 'line_number',
        type: 'Integer',
        description: { uk: 'Номер рядка', en: 'Line number' },
      },
      {
        name: 'active',
        type: 'Boolean',
        description: { uk: 'Активність', en: 'Active' },
      },
    )
  }

  return attrs
}

function accumulationRegisterStandardAttributes(
  settings: StandardAttributeSettings,
): StandardAttribute[] {
  const attrs: StandardAttribute[] = [
    {
      name: 'period',
      type: 'DateTime',
      description: { uk: 'Період', en: 'Period' },
    },
    {
      name: 'recorder_id',
      type: 'DocumentRef',
      description: { uk: 'Реєстратор', en: 'Recorder' },
    },
    {
      name: 'line_number',
      type: 'Integer',
      description: { uk: 'Номер рядка', en: 'Line number' },
    },
    {
      name: 'active',
      type: 'Boolean',
      description: { uk: 'Активність', en: 'Active' },
    },
  ]

  if (settings.registerType === 'Balance') {
    attrs.push({
      name: 'movement_type',
      type: 'Enum(Receipt,Expense)',
      description: { uk: 'Вид руху', en: 'Movement type' },
    })
  }

  return attrs
}

function customTableStandardAttributes(
  settings: StandardAttributeSettings,
): StandardAttribute[] {
  if (settings.autoAddPrimaryKey === false) {
    return []
  }
  return [
    {
      name: 'id',
      type: 'UUID',
      description: { uk: 'Унікальний ідентифікатор', en: 'Unique identifier' },
    },
  ]
}

export function getTabularSectionStandardAttributes(): StandardAttribute[] {
  return [
    {
      name: 'id',
      type: 'UUID',
      description: { uk: 'Унікальний ідентифікатор', en: 'Unique identifier' },
    },
    {
      name: 'line_number',
      type: 'Integer',
      description: { uk: 'Номер рядка', en: 'Line number' },
    },
  ]
}

export function getStandardAttributes(
  kind: MetadataKind,
  settings: StandardAttributeSettings = {},
): StandardAttribute[] {
  switch (kind) {
    case 'Catalog':
      return catalogStandardAttributes(settings)
    case 'Document':
      return documentStandardAttributes()
    case 'Enumeration':
      return []
    case 'InformationRegister':
      return informationRegisterStandardAttributes(settings)
    case 'AccumulationRegister':
      return accumulationRegisterStandardAttributes(settings)
    case 'Constant':
      return []
    case 'CustomTable':
      return customTableStandardAttributes(settings)
  }
}
