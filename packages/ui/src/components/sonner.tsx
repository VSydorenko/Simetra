import { Toaster as SonnerToaster } from 'sonner'
export { toast } from 'sonner'

function Toaster(props: React.ComponentProps<typeof SonnerToaster>) {
  return (
    <SonnerToaster
      className="toaster group"
      position="bottom-right"
      theme="dark"
      {...props}
    />
  )
}

export { Toaster }
