import { useCallback, useState } from 'react'

import { ApiError } from '../../api/client'
import { errorText } from '../../lib/errors'

/** One running action at a time, with its error as a sentence and an optional success line. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const run = useCallback(async (action: () => Promise<unknown>, success: string | null = null) => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      await action()
      setDone(success)
      return true
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, problem, done, run, setProblem }
}
