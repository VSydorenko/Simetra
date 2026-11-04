import { createFileRoute } from "@tanstack/react-router"

// Окремий маршрут пакета — гейт C перевіряє, що він у власному чанку.
export const Route = createFileRoute("/heavy")({
  component: function Heavy() {
    return <p data-heavy="p0a">heavy-route-marker</p>
  },
})
