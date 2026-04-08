import { Outlet, NavLink, useLocation, Link } from 'react-router'
import { ScrollArea } from '@workspace/ui/components/scroll-area'
import { cn } from '@workspace/ui/lib/utils'
import type { NavigationGroup } from '../navigation-builder'

export interface SidebarLayoutProps {
  navigation: NavigationGroup[]
  projectName?: { uk?: string; en?: string } | null
}

/** Побудувати breadcrumbs з поточного pathname */
function useBreadcrumbs(navigation: NavigationGroup[]) {
  const { pathname } = useLocation()
  const segments = pathname.split('/').filter(Boolean)

  if (segments.length === 0) return []

  const crumbs: { label: string; path: string }[] = [{ label: 'Головна', path: '/' }]

  // Знайти відповідну навігаційну групу
  const kindSlug = segments[0]
  const group = navigation.find((g) =>
    g.items.some((item) => item.path.startsWith(`/${kindSlug}/`)),
  )
  if (group) {
    crumbs.push({ label: group.label, path: '/' })
  }

  // Знайти конкретний об'єкт
  if (segments.length >= 2) {
    const itemPath = `/${segments[0]}/${segments[1]}`
    const item = navigation.flatMap((g) => g.items).find((i) => i.path === itemPath)
    if (item) {
      crumbs.push({ label: item.displayName, path: item.path })
    }
  }

  return crumbs
}

export function SidebarLayout({ navigation, projectName }: SidebarLayoutProps) {
  const title = projectName?.uk ?? projectName?.en ?? 'Simetra Runtime'
  const breadcrumbs = useBreadcrumbs(navigation)

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border px-4">
        <h1 className="text-sm font-semibold">{title}</h1>
        {breadcrumbs.length > 0 && (
          <nav className="flex items-center gap-1 text-sm text-muted-foreground">
            {breadcrumbs.map((crumb, i) => (
              <span key={crumb.path + i} className="flex items-center gap-1">
                {i > 0 && <span>/</span>}
                <Link
                  to={crumb.path}
                  className="hover:text-foreground transition-colors"
                >
                  {crumb.label}
                </Link>
              </span>
            ))}
          </nav>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[250px] shrink-0 border-r border-border">
          <ScrollArea className="h-full">
            <nav className="flex flex-col gap-4 p-3">
              {navigation.map((group) => (
                <div key={group.kind}>
                  <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {group.items.map((item) => (
                      <li key={item.path}>
                        <NavLink
                          to={item.path}
                          className={({ isActive }) =>
                            cn(
                              'block rounded-md px-2 py-1.5 text-sm transition-colors',
                              isActive
                                ? 'bg-accent text-accent-foreground font-medium'
                                : 'text-foreground/70 hover:bg-accent/50 hover:text-foreground',
                            )
                          }
                        >
                          {item.displayName}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </ScrollArea>
        </aside>

        {/* Content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
