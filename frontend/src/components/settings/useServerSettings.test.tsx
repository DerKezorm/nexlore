/** The shared server settings say when they could not be loaded, and load again on ``reload``. */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

const answers = vi.hoisted(() => ({ settings: vi.fn() }))
vi.mock('../../api/client', () => ({ adminApi: { settings: answers.settings } }))

import { useServerSettings } from './useServerSettings'

describe('useServerSettings', () => {
  it('marks a failed load and clears it when a retry works', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    answers.settings.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce({ public_url: 'https://lore.example.com' })
    let latest: ReturnType<typeof useServerSettings> | undefined
    function Probe() {
      latest = useServerSettings()
      return null
    }
    const box = document.createElement('div')
    const root = createRoot(box)
    await act(async () => root.render(createElement(Probe)))
    expect(latest![0]).toBeNull()
    expect(latest![2]).toBe(true)
    await act(async () => latest![3]())
    expect(latest![2]).toBe(false)
    expect(latest![0]).toEqual({ public_url: 'https://lore.example.com' })
    expect(answers.settings).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
  })
})
