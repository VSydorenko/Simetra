import { useMetadataStore } from "@/stores/metadata-store"
import { useUiStore } from "@/stores/ui-store"

export function startUiSelectionSync(): () => void {
  const syncSelection = (
    previousModel = useMetadataStore.getState().model
  ): void => {
    const { model } = useMetadataStore.getState()
    useUiStore.getState().reconcileSelectionWithModel(model, previousModel)
  }

  syncSelection()

  return useMetadataStore.subscribe((state, previousState) => {
    if (state.model === previousState.model) {
      return
    }

    useUiStore
      .getState()
      .reconcileSelectionWithModel(state.model, previousState.model)
  })
}
