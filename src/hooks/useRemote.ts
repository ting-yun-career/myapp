import { useEffect, useState } from 'react'

type RemoteState<T> = { key: string; nonce: number; data?: T; error?: unknown }

// Loads data whenever `key` changes. Loading is derived (the stored result belongs to an
// older key/nonce) rather than set inside the effect, so a key change never renders stale data.
export function useRemote<T>(key: string, load: () => Promise<T>) {
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<RemoteState<T> | null>(null)

  useEffect(() => {
    let cancelled = false
    load().then(
      (data) => {
        if (!cancelled) setState({ key, nonce, data })
      },
      (error: unknown) => {
        if (!cancelled) setState({ key, nonce, error: error ?? new Error('Unknown error') })
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = state?.key === key && state.nonce === nonce ? state : null
  return {
    data: current?.data,
    error: current?.error,
    isLoading: current === null,
    retry: () => setNonce((value) => value + 1),
  }
}
