export {
  DataProviderProvider,
  useDataProvider,
  MetadataProvider,
  useMetadata,
} from './context'

export { resolveFieldComponent, type FieldComponentType, type FieldMappingResult } from './field-mapping'

export { buildFormSchema } from './schema-builder'

// Domain-компоненти
export { CatalogCombobox, type CatalogComboboxProps } from './components/catalog-combobox'
export { EnumSelect, type EnumSelectProps } from './components/enum-select'
export {
  RuntimeDataTable,
  type RuntimeDataTableProps,
  type RuntimeDataTableColumn,
} from './components/runtime-data-table'
export { PolymorphicRefPlaceholder } from './components/polymorphic-ref-placeholder'
export { PostButton, type PostButtonProps } from './components/post-button'
export { UnpostButton, type UnpostButtonProps } from './components/unpost-button'
export { DeletionMarkButton, type DeletionMarkButtonProps } from './components/deletion-mark-button'
export { SaveButton, type SaveButtonProps } from './components/save-button'
export { ItemFormRenderer, type ItemFormRendererProps } from './item-form-renderer'
export { ListRenderer, type ListRendererProps } from './list-renderer'
export { FormFieldRenderer, type FormFieldRendererProps } from './components/form-field-renderer'
export { ConstantsForm, type ConstantsFormProps } from './components/constants-form'
