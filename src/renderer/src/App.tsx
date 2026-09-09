import { useEffect } from 'react'
import { Workspace } from './components/layout/Workspace'
import { useStore } from './store/useStore'

export default function App(): JSX.Element {
  useThumbnailStream()
  useEffect(() => {
    // Keep the existing development preview; production remains fully local.
    if (import.meta.env.DEV) void import('./dev/preview').then((m) => m.enablePreview())
  }, [])
  return <Workspace />
}

function useThumbnailStream(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.luxinus) return
    return window.luxinus.library.onThumbnail((payload) => {
      useStore.getState().applyThumbnail(payload.filePath, payload.webp, payload.meta)
    })
  }, [])
}
