// @vitest-environment jsdom
/**
 * The buttons of the account pages look as the module konten gives them (E39: no app overrides a module's button):
 * kind, symbol and, since konten 1.1.0, size. "Verwalten" in the list of accounts is `sm`, as in nexnotes (gallery, joint round).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUTTONS, buttonSize, type ButtonName } from '../vendor/nexkonten/konten'
import { AccountButton } from './AccountButton'

let root: Root
let box: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
})

describe('a button of the account pages', () => {
  it('has the size, kind and symbol of the module, "Verwalten" sm', () => {
    const names = Object.keys(BUTTONS) as ButtonName[]
    act(() => root.render(<>{names.map((name) => <AccountButton key={name} name={name} testId={name} />)}</>))
    const seen = names.map((name) => {
      const button = box.querySelector<HTMLElement>(`[data-testid="${name}"]`)!
      return [name, button.dataset.size, button.dataset.kind, button.dataset.icon]
    })
    expect(seen).toEqual(names.map((name) => [name, buttonSize(name), BUTTONS[name].kind, BUTTONS[name].icon]))
    expect(box.querySelector<HTMLElement>('[data-testid="account.manage"]')!.dataset.size).toBe('sm')
    expect(seen.filter(([, size]) => size === 'sm').length).toBeGreaterThan(10)
  })
})
