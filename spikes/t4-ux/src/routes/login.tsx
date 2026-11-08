import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { login } from '../server/fns'
import { breaks } from '../t4/breaks'
import { useHolder } from '../t4/hooks'
import { createCore } from '../t4/runtime'

export const Route = createFileRoute('/login')({ component: LoginPage })

function LoginPage() {
  const holder = useHolder()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  return (
    <form
      data-region="login"
      onSubmit={async (e) => {
        e.preventDefault()
        const { subject } = await login({ data: name })
        // Зламана реалізація: лишити старе ядро після зміни суб'єкта.
        if (!(breaks.has('keepcore') && holder.core)) holder.replace(createCore(subject))
        await navigate({ to: '/' })
      }}
    >
      <input data-field="login" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" data-action="login">
        Увійти
      </button>
    </form>
  )
}
