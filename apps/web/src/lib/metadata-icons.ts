import type { IconSvgElement } from '@hugeicons/react'
import {
  BookOpen02Icon,
  File02Icon,
  Menu01Icon,
  Database02Icon,
  ChartHistogramIcon,
  Settings02Icon,
  GridTableIcon,
} from '@hugeicons/core-free-icons'
import type { MetadataKind } from '@simetra/core'

/** Маппінг MetadataKind → іконка hugeicons */
export const KIND_ICONS: Record<MetadataKind, IconSvgElement> = {
  Catalog: BookOpen02Icon,
  Document: File02Icon,
  Enumeration: Menu01Icon,
  InformationRegister: Database02Icon,
  AccumulationRegister: ChartHistogramIcon,
  Constant: Settings02Icon,
  CustomTable: GridTableIcon,
}
