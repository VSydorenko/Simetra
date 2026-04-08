import { Link } from 'react-router'
import { useMetadata } from '@simetra/form-runtime'
import { buildFlatNavigation } from '../navigation-builder'

export function HomePage() {
  const model = useMetadata()
  const groups = buildFlatNavigation(model)

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-bold">Головна</h1>
      {groups.length === 0 && (
        <p className="text-muted-foreground">Об'єкти метаданих не знайдено.</p>
      )}
      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <section key={group.kind}>
            <h2 className="mb-2 text-lg font-semibold">{group.label}</h2>
            <ul className="flex flex-col gap-1">
              {group.items.map((item) => (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    className="text-sm text-foreground/80 underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {item.displayName}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
