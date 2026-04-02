import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@workspace/ui/components/scroll-area'

/** Заглушка дерева метаданих — реалізація у Модулі 6 */
export function TreePanel() {
  const { t } = useTranslation()

  return (
    <ScrollArea className="h-full">
      <div className="flex h-full items-center justify-center p-3 text-xs text-muted-foreground">
        {t('editor.noSelection')}
      </div>
    </ScrollArea>
  )
}
