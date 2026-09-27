/** Small rules around signing in. */

/** Only a path inside nexlore: `next` comes from the address bar, and `//host` would leave the site. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
}
