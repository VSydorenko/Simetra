import { cn } from '@workspace/ui/lib/utils'
import { useDdlStore } from '@/stores/ddl-store'
import type { GeneratedFile } from '@simetra/generator-api'

interface SqlFileTreeProps {
  files: GeneratedFile[]
}

export function SqlFileTree({ files }: SqlFileTreeProps) {
  const selectedFilePath = useDdlStore((s) => s.selectedFilePath)
  const selectFile = useDdlStore((s) => s.selectFile)

  return (
    <div className="py-1">
      {files.map((file) => (
        <button
          key={file.path}
          type="button"
          className={cn(
            'flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs',
            'transition-colors hover:bg-accent/50',
            selectedFilePath === file.path &&
              'bg-accent text-accent-foreground',
          )}
          onClick={() => selectFile(file.path)}
        >
          <span className="truncate font-mono">{file.path}</span>
        </button>
      ))}
    </div>
  )
}
