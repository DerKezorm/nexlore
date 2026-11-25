import { pageOrder, PAGES } from '../../vendor/nexkonten/konten'

/** The parts of the pages Profile and Security, top to bottom: the module's in its order, then nexlore's own
 * (`pageOrder`, konten 0.3.6). The vitest `nexkonten.test.ts` holds the pages to it. */
export const APP_PAGES = {
  profile: pageOrder('profile', ['signOut']),
  security: pageOrder('security', ['providers']),
} as const

/** One part of the module's pages (`PAGES`) by its name: its title, hint and buttons. */
export const pagePart = (page: keyof typeof PAGES, name: string) => PAGES[page].parts.find((entry) => entry.part === name)!
