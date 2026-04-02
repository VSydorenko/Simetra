import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@workspace/ui/components/scroll-area'

/** Заглушка панелі властивостей — реалізація у Модулі 8 */
export function PropertiesPanel() {
  const { t } = useTranslation()

  return (
    <ScrollArea className="h-full">
      <div className="flex h-full items-center justify-center p-3 text-xs text-muted-foreground">
        {t('properties.title')}
      </div>
    </ScrollArea>
  )
}
