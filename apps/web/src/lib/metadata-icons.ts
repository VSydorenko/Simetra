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

/** Маппінг MetadataKind → Tailwind CSS клас кольору тексту */
export const KIND_COLORS: Record<MetadataKind, string> = {
  Catalog: 'text-kind-catalog',
  Document: 'text-kind-document',
  Enumeration: 'text-kind-enum',
  InformationRegister: 'text-kind-info-reg',
  AccumulationRegister: 'text-kind-acc-reg',
  Constant: 'text-kind-constant',
  CustomTable: 'text-kind-custom',
}

/** Маппінг MetadataKind → Tailwind CSS клас фону badge з opacity */
export const KIND_BADGE_CLASSES: Record<MetadataKind, string> = {
  Catalog: 'bg-kind-catalog/15 text-kind-catalog border-kind-catalog/25',
  Document: 'bg-kind-document/15 text-kind-document border-kind-document/25',
  Enumeration: 'bg-kind-enum/15 text-kind-enum border-kind-enum/25',
  InformationRegister: 'bg-kind-info-reg/15 text-kind-info-reg border-kind-info-reg/25',
  AccumulationRegister: 'bg-kind-acc-reg/15 text-kind-acc-reg border-kind-acc-reg/25',
  Constant: 'bg-kind-constant/15 text-kind-constant border-kind-constant/25',
  CustomTable: 'bg-kind-custom/15 text-kind-custom border-kind-custom/25',
}
