/**
 * Who else has the note open: the page says it is here, shows the others' pictures in the note's head (the one
 * writing with a pencil, first), and says goodbye when it moves on.
 */
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test'

const TAB = { 'X-Nexlore-Client': 'tab-e2e-presence' }

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

const OTHERS = [
  { id: 901, name: 'anna', avatar: null, writing: true },
  { id: 902, name: 'bob', avatar: null, writing: false },
]

/** A reader of Heath, signed in from a request context of its own (never the operator's page). */
async function reader(page: Page, baseURL: string): Promise<APIRequestContext> {
  const invite = await page.request.post('/api/spaces/Heath/invites', { data: { role: 'read', days: 1 }, headers: TAB })
  expect(invite.ok()).toBe(true)
  const token = new URL((await invite.json()).link).pathname.split('/').pop()!
  const other = await request.newContext({ baseURL, extraHTTPHeaders: TAB })
  const made = await other.post(`/api/invite/${token}`, { data: { name: 'onlooker', password: 'e2e onlooker password' } })
  expect(made.ok()).toBe(true)
  return other
}

/** Who the reader sees with the note open, saying it is there itself. */
async function seenBy(other: APIRequestContext, path: string): Promise<string[]> {
  const answer = await other.post('/api/presence', { data: { path } })
  expect(answer.ok()).toBe(true)
  return (await answer.json()).people.map((person: { name: string }) => person.name)
}

test('two people with the same note open see each other, and not after one moved on', async ({ page, baseURL }) => {
  const problems = collectProblems(page)
  const other = await reader(page, baseURL!)
  expect(await seenBy(other, 'Heath/Heather.md')).toEqual([])
  const said = page.waitForRequest((request) => request.url().includes('/api/presence') && request.method() === 'POST')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Heather.md')
  expect((await said).postDataJSON()).toEqual({ path: 'Heath/Heather.md' })
  const here = page.getByTestId('note-toolbar').getByTestId('presence')
  await expect(here).toHaveAttribute('aria-label', 'onlooker is reading')
  expect(await seenBy(other, 'Heath/Heather.md')).toEqual(['tester'])

  // Moving on inside the app says goodbye to the old note and hello to the new one.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Comment me')
  await page.getByRole('dialog', { name: 'Search' }).getByRole('button', { name: /^Comment me/ }).first().click()
  await expect(page.getByTestId('presence')).toHaveCount(0)
  await expect.poll(() => seenBy(other, 'Heath/Heather.md')).toEqual([])
  await expect.poll(() => seenBy(other, 'Heath/Comment me.md')).toEqual(['tester'])
  // Leaving the page altogether (a reload, a closed tab) says goodbye as well.
  await page.goto('/files')
  await expect.poll(() => seenBy(other, 'Heath/Comment me.md')).toEqual([])
  await other.dispose()
  expect(problems).toEqual([])
})

test('the others are shown in the head, the one writing with a pencil', async ({ page }) => {
  const problems = collectProblems(page)
  await page.route('**/api/presence', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ json: { people: OTHERS } }) : route.fulfill({ status: 204 }),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Heather.md')
  const here = page.getByTestId('note-toolbar').getByTestId('presence')
  await expect(here).toBeVisible()
  await expect(here).toHaveAttribute('aria-label', 'anna is writing, bob is reading')
  const people = here.locator('[data-person]')
  await expect(people).toHaveCount(2)
  await expect(people.nth(0)).toHaveAttribute('data-person', 'anna')
  await expect(people.nth(0)).toHaveAttribute('data-writing', 'true')
  await expect(people.nth(1)).not.toHaveAttribute('data-writing', /.*/)
  expect(problems).toEqual([])
})
