import { useState } from 'react'

/**
 * The new password typed a second time. The page checks it on sending; from then on the field says "do not match"
 * until both are the same again, and nothing is sent while they differ.
 */
export function usePasswordConfirm(password: string) {
  const [confirm, setConfirm] = useState('')
  const [checked, setChecked] = useState(false)
  return {
    confirm,
    setConfirm,
    mismatch: checked && confirm !== password,
    /** On sending: true when both are the same; otherwise the second field shows why nothing was sent. */
    matches: () => {
      setChecked(true)
      return confirm === password
    },
    clear: () => {
      setConfirm('')
      setChecked(false)
    },
  }
}
