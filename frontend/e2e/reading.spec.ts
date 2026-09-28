/**
 * The reading view shows Obsidian's own writing as Obsidian does: a callout folded shut, a highlight, a comment left
 * out, a wiki link in a table cell, and a part of another note embedded, whose links can be followed.
 */
import { expect, test, type Page } from '@playwright/test'

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

test("the reading view shows callouts, highlights, comments, links in tables and embedded notes", async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zoo/Reading.md')
  const article = page.locator('article')
  await expect(article.locator('mark')).toHaveText('marked')
  await expect(article).not.toContainText('secret remark')
  await expect(article).not.toContainText('%%')
  await expect(article).not.toContainText('[!tip]')

  // Folded shut until the title is clicked.
  await expect(article.getByText('Folded tip')).toBeVisible()
  await expect(article.getByText('Hidden until opened.')).toBeHidden()
  await article.getByText('Folded tip').click()
  await expect(article.getByText('Hidden until opened.')).toBeVisible()

  const cell = article.locator('td a.nn-wikilink')
  await expect(cell).toHaveText('the embedded one')
  await expect(cell).not.toHaveClass(/missing/)

  // The part under "Part two" only, one level deep.
  const embed = article.locator('.nn-embedded')
  await expect(embed).toContainText('In the embed, with a link to')
  await expect(embed).not.toContainText('Not in the embed.')
  // An embed inside the embed stays a link.
  await expect(embed.locator('[data-embed]')).toHaveCount(0)
  await expect(embed.locator('a.nn-wikilink', { hasText: 'Reading' })).toBeVisible()
  await embed.getByText('Across target').click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Across%20target\.md$/)
  await expect(page.locator('article')).toContainText('Reached from another space.')
  expect(problems).toEqual([])
})
