import { useTranslation } from 'react-i18next'

/** Заглушка редактора — реалізація у Модулі 7 */
export function EditorPanel() {
  const { t } = useTranslation()

  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {t('editor.noSelection')}
    </div>
  )
}
