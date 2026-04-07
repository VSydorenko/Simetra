import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TooltipProvider } from '@workspace/ui/components/tooltip'
import '../i18n'
import { useDdlStore } from '../stores/ddl-store'
import type { GeneratorOutput } from '@simetra/generator-api'

// Мок shiki — WASM не працює в jsdom
vi.mock('shiki', () => ({
  codeToHtml: vi.fn(() =>
    Promise.resolve('<pre><code>mocked sql</code></pre>'),
  ),
}))

const { SqlPreviewPanel } = await import(
  '../components/sql-preview/sql-preview-panel'
)

function renderPanel() {
  return render(
    <TooltipProvider>
      <SqlPreviewPanel />
    </TooltipProvider>,
  )
}

const singleFileOutput: GeneratorOutput = {
  files: [{ path: 'schema.sql', content: 'CREATE TABLE test ();' }],
  warnings: [],
}

const multiFileOutput: GeneratorOutput = {
  files: [
    { path: 'catalogs.sql', content: 'CREATE TABLE catalogs ();' },
    { path: 'documents.sql', content: 'CREATE TABLE documents ();' },
  ],
  warnings: [],
}

describe('SqlPreviewPanel', () => {
  beforeEach(() => {
    useDdlStore.setState({
      output: null,
      selectedFilePath: null,
      isGenerating: false,
      generationError: null,
      validationErrors: [],
    })
  })

  it('renders empty state when no output', () => {
    renderPanel()
    // Текст з i18n: "Натисніть \"Згенерувати SQL\" для перегляду DDL"
    expect(screen.getByText(/згенерувати sql/i)).toBeInTheDocument()
  })

  it('renders validation errors UI', () => {
    useDdlStore.setState({
      validationErrors: ['Catalog.Orders.attributes.client: test error'],
    })
    renderPanel()
    // Заголовок: "Знайдено помилки у моделі"
    expect(screen.getByText(/помилки у моделі/i)).toBeInTheDocument()
    expect(screen.getByText(/test error/i)).toBeInTheDocument()
  })

  it('renders generation error', () => {
    useDdlStore.setState({ generationError: 'Something broke' })
    renderPanel()
    // Заголовок: "Помилка генерації SQL"
    expect(screen.getByText(/помилка генерації/i)).toBeInTheDocument()
    expect(screen.getByText('Something broke')).toBeInTheDocument()
  })

  it('renders toolbar and viewer with single-file output', () => {
    useDdlStore.setState({
      output: singleFileOutput,
      selectedFilePath: 'schema.sql',
    })
    renderPanel()
    // Кнопки тулбару: "Копіювати все" та "Завантажити .sql"
    expect(screen.getByLabelText(/копіювати/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/завантажити/i)).toBeInTheDocument()
  })

  it('renders file tree with multi-file output', () => {
    useDdlStore.setState({
      output: multiFileOutput,
      selectedFilePath: 'catalogs.sql',
    })
    renderPanel()
    expect(screen.getByText('catalogs.sql')).toBeInTheDocument()
    expect(screen.getByText('documents.sql')).toBeInTheDocument()
  })
})
