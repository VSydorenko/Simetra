import { Link } from 'react-router'

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-12">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">Сторінку не знайдено</p>
      <Link
        to="/"
        className="text-sm underline underline-offset-4 hover:text-foreground"
      >
        На головну
      </Link>
    </div>
  )
}
