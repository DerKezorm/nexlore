/**
 * End-to-end, headless. The built frontend is served by the real backend, as in the container, so the Content
 * Security Policy applies. Own data directory and own port, so a running development server is never measured.
 *
 *   npm run e2e                      build, start the backend on 8471, test
 *   E2E_BASE_URL=http://host:8470 npx playwright test    against a running instance (the server's own languages)
 */
import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 8471
const external = process.env.E2E_BASE_URL

/**
 * A fresh data directory per run, with one operator language that is deliberately incomplete and one broken file.
 * Made here and not in a global setup: the server starts first, and under Windows its open log file would block
 * cleaning up a fixed directory. The workers load this file again and inherit the directory through the environment.
 */
function dataDir(): string {
  if (process.env.NEXLORE_E2E_DATA) return process.env.NEXLORE_E2E_DATA
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlore-e2e-'))
  const locales = path.join(dir, 'locales')
  fs.mkdirSync(locales)
  const spanish = { _meta: { name: 'Español' }, nav: { graph: 'Grafo', notes: 'Notas', files: 'Archivos', settings: 'Ajustes' } }
  fs.writeFileSync(path.join(locales, 'es.json'), JSON.stringify(spanish))
  fs.writeFileSync(path.join(locales, 'xx.json'), '{broken')
  for (const [name, content] of Object.entries(E2E_NOTES)) {
    const file = path.join(dir, 'vault', ...name.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  process.env.NEXLORE_E2E_DATA = dir
  return dir
}

/** Small pictures and a PDF for the attachment tests (attachments.spec.ts), made once with Pillow. */
const ORANGE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR42mN8ViHCQAgwMRABhrciALQ1AYLyZG5iAAAAAElFTkSuQmCC', 'base64')
const BLUE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR42mMUqXjGQAgwMRABhrciALKRAYJ+ADfJAAAAAElFTkSuQmCC', 'base64')
const LEAFLET_PDF = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0OSA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDIwIDEwMCBUZCAoa2luZ2Zpc2hlciBsYW50ZXJuKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM0MCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMAolJUVPRgo=',
  'base64',
)

/** A day as `JJJJ-MM-TT` in local time, counted from today: the tasks of everyday.spec.ts are due around now. */
function day(offset = 0): string {
  const when = new Date()
  when.setDate(when.getDate() + offset)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}

/** An invented vault for the tests; each test works on its own notes, so the order does not matter. */
const E2E_NOTES: Record<string, string | Buffer> = {
  'Work/Plan.md': '---\ntags: [project]\n---\n# Plan\n\nThe roadmap links to [[Garden]] and to [[Missing note]].\n',
  'Work/Ideas/Garden.md': '# Garden\n\nTomatoes and basil grow here. Back to [[Plan]].\n',
  'Work/Scratch.md': '# Scratch\n\nFirst line.\n',
  'Work/Conflict.md': '# Conflict\n\nBefore.\n',
  'Work/Locked.md': '# Locked\n\nSomebody types here.\n',
  'Work/Rename me.md': '# Rename me\n',
  'Work/Points at rename.md': 'See [[Rename me]] and [it](Rename%20me.md).\n',
  'Work/Delete me.md': '# Delete me\n\nGone soon.\n',
  'Home/Shopping.md': '# Shopping\n\nMilk, flour and quinceapple jam.\n',
  // "#" and "%" are legal in names on every system and mean something in an address.
  'Home/50% C# done.md': '# Odd name\n\nThe zebracorn lives here.\n',
  // Links between spaces (across.spec.ts): written with the other space's name in front. Two spaces of their own,
  // after the others: notes added before Work push Plan out of the visible part of the sidebar (graph.spec.ts).
  'Zone/Across.md': '# Across\n\nThe [[Zoo/Across target]], a [[Zoo/Across new]] and [[Zoo/Across rename]].\n',
  'Zoo/Across target.md': '# Across target\n\nReached from another space.\n',
  'Zoo/Across rename.md': '# Across rename\n',
  // AI from outside (mcp.spec.ts): a note a draft is proposed for.
  'Zoo/Draft me.md': '# Draft me\r\n\r\nKept line.\r\nOld line.\r\n',
  // Plugins (plugins.spec.ts): a board, a query, headings for the contents.
  'Zoo/Board.md': '---\nkanban-plugin: basic\n---\n\n## Todo\n\n- [ ] Dig the bed\n\n## Done\n\n- [x] Buy seeds\n',
  'Zoo/Sown.md': '# Sown\n\n## Early\n\nPeas. #sown\n\n## Late\n\n```query\ntag: sown\nview: table\n```\n',
  // The calendar (everyday.spec.ts): a task with a wiki link, due on the 15th of this month (always in the grid).
  'Zoo/Linked.md': `# Linked\n\n- [ ] Call [[Board|the plumber]] 📅 ${day(0).slice(0, 8)}15\n`,
  // The reading view (reading.spec.ts): Obsidian's own writing, and a note embedded in another.
  'Zoo/Reading.md':
    '# Reading\n\n> [!tip]- Folded tip\n> Hidden until opened.\n\nA ==marked== word and %%a secret remark%% here.\n\n' +
    '| Link | Note |\n|---|---|\n| [[Embedded\\|the embedded one]] | cell |\n\n![[Embedded#Part two]]\n',
  // The editor's toolbar (toolbar.spec.ts).
  'Zoo/Toolbar.md': '# Toolbar\n\nMake this word bold.\n\nPut a link here.\n\n- one\n- two\n',
  'Zoo/Toolbar hide.md': '# Toolbar hide\n',
  // Find and replace (find.spec.ts).
  'Zoo/Find.md': '# Find\n\nThe cat sat.\n\nA *Cat* and a cat.\n\nUntouched   spacing  here.\n\n```\ncat in code\n```\n',
  'Zoo/Find keys.md': '# Find keys\n\nOne fox, two fox, three fox.\n',
  // Mentions without a link and cleaning up (cleanup.spec.ts), a space of their own so the lists stay short.
  'Moor/Pond heron.md': '# Pond heron\n\nA wading bird.\n',
  'Moor/Walk.md': '# Walk\n\nWe saw a pond heron by the water.\n',
  'Moor/Lost.md': '# Lost\n\nSee [[Bog myrtle]] and [[Moor/Deep/Sundew]].\n',
  'Moor/Deep/Linked.md': '# Linked\n\nTo the [[Walk]].\n',
  // Quick capture (capture.spec.ts): a space with no inbox yet.
  'Heath/Heather.md': '# Heather\n',
  // The calendar subscription (outward.spec.ts): a task with a date a few days ahead.
  // Comments in the margin (comments.spec.ts).
  'Heath/Comment me.md': '# Comment me\n\nThe heather blooms in August on the hill.\n',
  'Heath/Comment two.md': '# Comment two\n\nThe first words stand here. Further down the second words stand.\n',
  'Heath/Comment edit.md': '# Comment edit\n\nHeather has purple bells on the moor in late summer.\n',
  'Heath/Comment gone.md':'# Comment gone\n\nThese words are soon changed.\n',
  // Only presence.spec opens these: another test's tab may still count as there for 70 seconds.
  'Heath/Present here.md': '# Present here\n',
  'Heath/Present there.md': '# Present there\n',
  'Heath/Counted.md': '# Counted\n\nFive words stand here now.\n',
  'Heath/Slashed.md': '# Slashed\n\nFirst line.\n',
  'Heath/Counted embed.md': '# Counted embed\n\nTwo words.\n\n![[Heath/Counted]]\n',
  'Heath/Dates.md':`- [ ] Cut the heather 📅 ${day(3)}\n`,
  // AI in notes against the stand-in service (ai.spec.ts).
  'Zoo/Ai.md': '# Ai\n\nWe meet on Thursday at teh office.\n\nSecond line stays.\n',
  'Zoo/Ai whole.md': '# Ai\n\nWe meet on Thursday at teh office.\n\nSecond line stays.\n',
  'Zoo/Ai insert.md': '# Ai\n\nWe meet on Thursday at teh office.\n\nSecond line stays.\n',
  'Zoo/Ai off.md': '# Ai\n\nWe meet on Thursday at teh office.\n\nSecond line stays.\n',
  'Zoo/Lines.md': '---\ntags: [a]\n---\n# Lines\n\nFirst paragraph\ngoes on here.\n\n- one\n  - one inner\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nLast.\n',
  'Zoo/Grip left.md': '# Grip left\n\nLeft first paragraph.\n\nLeft second.\n\nLeft third.\n',
  'Zoo/Grip.md':'# Grip\n\nFirst *paragraph*  \nwith a hard break.\n\nSecond paragraph.\n\n- [ ] Third, a task.\n',
  'Zoo/Toolbar phone.md': '# Toolbar phone\n\nTyped on a phone.\n',
  // The sidebar's context menus (sidebar.spec.ts): a folder to tidy, notes to rename, move and trash.
  'Zoo/Menu.md': '# Menu\n\nMake this word bold.\n\nA line to become a heading.\n\nSee [[Across target]].\n',
  'Zoo/Tidy/Keep.md':'# Keep\n\nSee [[Move me]] and [[Open me]].\n',
  'Zoo/Tidy/Move me.md': '# Move me\n',
  'Zoo/Tidy/Open me.md': '# Open me\n\nBeing read while it is renamed.\n',
  'Zoo/Tidy/Box/Inside.md': '# Inside\n',
  'Zoo/Tidy/Old/Gone.md': '# Gone\n',
  'Zoo/Embedded.md':'# Embedded\n\n## Part one\n\nNot in the embed.\n\n## Part two\n\nIn the embed, with a link to [[Across target]].\n\n![[Reading]]\n',
  // The palette and the quick switcher (palette.spec.ts), in a space of its own after all others (nothing moves).
  'Zyx/Palette.md': `---\naliases: [Command deck]\n---\n# Palette\n\n## First part\n\n${'A line to scroll past.\n\n'.repeat(40)}## Far down\n\nThe end.\n`,
  'Zyx/Tagged.md': '---\ntags: [pal]\n---\n# Tagged\n\nOne #pal/one here, and #palette stays.\n',
  'Zyx/Rich.md': [
    '# Rich', '', 'Euler: $e^{i\\pi}+1=0$ and a note[^1].', '', '$$', '\\sum_{k=1}^{n} k', '$$', '',
    '```mermaid', 'graph TD', '  Start --> Stop', '```', '', '```js', 'const answer = 42 // the answer', '```', '',
    '[^1]: Said by nobody.', '',
  ].join('\n'),
  'Zyx/Wide.md': '---\ncssclasses: [wide, my-look]\n---\n# Wide\n\nAs wide as the window.\n',
  'Zyx/Twice.md': '# Twice\n\nFirst [[Target twice]] here.\n\nAnd **[[Target twice|again]]** later.\n',
  'Zyx/Target twice.md': '# Target twice\n\nLinked from one note two times.\n',
  // Views over notes, as Obsidian's Bases (bases.spec.ts).
  'Zyx/Kitchen/Bread.md': '---\ntags: [recipe]\nminutes: 720\nstatus: tried\n---\n# Bread\n',
  'Zyx/Kitchen/Soup.md': '---\ntags: [recipe]\nminutes: 45\nstatus: tried\n---\n# Soup\n',
  'Zyx/Kitchen/Shakshuka.md': '---\ntags: [recipe]\nminutes: 25\nstatus: planned\n---\n# Shakshuka\n',
  'Zyx/Kitchen/Overview.md': '# Overview\n\n```base\nfilters: \'file.hasTag("recipe") && minutes < 60\'\nviews:\n  - type: list\n    order: [file.name, minutes]\n```\n',
  'Zyx/Kitchen/Recipes.base':
    'filters:\n  and:\n    - file.inFolder("Kitchen")\n    - file.hasTag("recipe")\nformulas:\n  hours: "minutes / 60"\nviews:\n  - type: table\n    name: All\n    order: [file.name, minutes, status, formula.hours]\n    sort:\n      - property: minutes\n        direction: ASC\n  - type: board\n    name: Board\n    groupBy:\n      property: status\n    order: [file.name, status]\n',
  'Switch/From.md': '# From\n\nStart.\n',
  'Switch/To.md': '# To\n\nOther note.\n',
  // The editor (editor.spec.ts): Obsidian's way of writing, kept byte for byte where nothing was changed.
  'Writing/Obsidian.md':
    '---\ntags:\n  - alpha\nstatus: draft\n---\n# Obsidian\n\nFirst paragraph with [[Garden]] and ==marked== text.\n\n* star list\n* second\n\n~~~\ntilde code\n~~~\n\nLast paragraph stays.\n',
  'Writing/Quiet.md': '# Quiet\n\nNothing typed here.\n',
  'Writing/Props.md': '---\ntags: [one, two]\nstatus: draft\n---\nBody of the note.\n',
  'Writing/Twice.md': '---\nstatus: draft\n---\nBody.\n',
  'Writing/Outside props.md': '---\nstatus: draft\n---\nBody.\n',
  'Writing/Typing.md': '# Typing\n\nOld text.\n',
  'Writing/Fresh.md': '# Fresh\n\nBefore.\n',
  'Writing/Linking.md': '# Linking\n\nStart.\n',
  'Writing/Target note.md': '# Target note\n',
  'Writing/Source.md': '# Source\n\nPlain text.\n',
  'Writing/Compare.md': '# Compare\n\nKept line.\n\nOld ending.\n',
  // Attachments (attachments.spec.ts).
  'Media/Paste here.md': '# Paste here\n\nStart.\n',
  'Media/Drop here.md': '# Drop here\n\nStart.\n',
  'Media/Gallery.md': '# Gallery\n\n![[sunset.png]]\n\n![Beach](Anh%C3%A4nge/beach.png)\n\nThe [[leaflet.pdf|leaflet]].\n',
  'Media/sunset.png': ORANGE_PNG,
  'Media/Anhänge/beach.png': BLUE_PNG,
  'Media/leaflet.pdf': LEAFLET_PDF,
  'Media/Versions.md': '# Versions\n\nSee [[v1.2]].\n',
  'Media/v1.2.md': '# v1.2\n\nA note whose name ends like a file.\n',
  'Media/Later.md': '# Later\n\nStart.\n',
  'Media/Short lived.md': '# Short lived\n\nStart.\n',
  // Everyday use (everyday.spec.ts): tasks around today, templates, a folder for daily notes made on demand.
  'Year/Chores.md': `# Chores\r\n- [ ] Water the ferns 📅 ${day(0)}\r\n- [ ] Fix the gate 📅 ${day(-1)} #garden\r\n- [ ] Someday maybe\r\n`,
  'Year/Weekly.md': `# Weekly\n\n- [ ] Sweep the yard 🔁 every week 📅 ${day(0)}\n`,
  'Year/Templates/Meeting.md': '# {{title}}\n\nStarted {{date}}\n<% tp.date.now() %>\n',
  'Year/Templates/Day.md': '# Day {{title}}\n\n- [ ] plan the day\n',
  // A flat folder longer than one page of the sidebar (graph.spec.ts).
  ...Object.fromEntries(Array.from({ length: 620 }, (_, n) => [`Many/Flat/Note ${String(n).padStart(3, '0')}.md`, `# Note ${n}\n`])),
}

const DATA_DIR = external ? '' : dataDir()
/** Where the operator's session is kept for the tests (global-setup.ts signs in once). */
export const SIGNED_IN = path.join(external ? os.tmpdir() : DATA_DIR, 'e2e-operator.json')
process.env.NEXLORE_E2E_STATE = SIGNED_IN
// The project's venv on the development machines, the system Python in CI.
const venv = path.join('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const python = fs.existsSync(path.join('..', 'backend', venv)) ? venv : 'python'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  // In the CI one more try, as nexdeck does: a test that passes only then is listed as flaky, the run stays green.
  // Locally none: a red test here is read, not tried again.
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: external ?? `http://127.0.0.1:${PORT}`,
    headless: true,
    locale: 'en-US',
    storageState: SIGNED_IN,
  },
  webServer: external
    ? undefined
    : [
      {
        command: `${python} -m uvicorn app.main:app --host 127.0.0.1 --port ${PORT}`,
        cwd: path.join('..', 'backend'),
        url: `http://127.0.0.1:${PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          NEXLORE_DATA_DIR: DATA_DIR,
          NEXLORE_FRONTEND_DIST: path.resolve('dist'),
          // The watcher and the first scan run as in a real installation: they index the prepared vault.
          NEXLORE_DISABLE_BACKGROUND: '0',
          // The tests make and sign in many accounts; Argon2's strength is not what they measure.
          NEXLORE_ARGON2_TIME: '1',
          NEXLORE_ARGON2_MEMORY_KIB: '8192',
          NEXLORE_ARGON2_PARALLELISM: '1',
        },
      },
      // A stand-in AI service (ai.spec.ts): the chat interface, answering by rule.
      {
        command: 'node e2e/fake-ai.mjs',
        url: 'http://127.0.0.1:8478/health',
        reuseExistingServer: false,
        timeout: 20_000,
        env: { FAKE_AI_PORT: '8478' },
      },
    ],
})
