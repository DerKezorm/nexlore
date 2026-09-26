/**
 * Invented sample vault for the mockup. Nothing here belongs to a real person; addresses use example.com.
 *
 * Every note lives in a folder path whose first entry is its space. Links are written as [[Title]], like in
 * Obsidian, and resolved by title.
 */

export type Attachment = { name: string; size: string; kind: 'image' | 'pdf' | 'file' }

export type Note = {
  id: string
  title: string
  /** Folder path, first entry is the space. */
  path: string[]
  body: string
  updated: string
  author: string
  /** Written by an AI assistant through the MCP server, not yet taken over by a person. */
  aiDraft?: boolean
  /** Someone else is editing the note right now. */
  lockedBy?: string
  attachments?: Attachment[]
}

export type Space = { name: string; shared: boolean; members: string[] }

export const ME = 'Alex'

/** The MCP key the AI drafts in the mockup came through: a name its owner gave it, so data, not a UI text. */
export const DRAFT_ACCESS = 'Desktop-Assistent'

/** MCP keys in the settings sketch: name, key start, when last used, what it did. */
export const MCP_KEYS = [
  { name: 'Desktop-Assistent', key: 'nxl_4f2a…', used: '2026-09-26T10:42:00Z', did: { kind: 'draft', title: 'Offsite-Kopie' } },
  { name: 'Editor-Assistent', key: 'nxl_91cd…', used: '2026-09-23T08:15:00Z', did: { kind: 'read', count: 12 } },
] as const

export const SPACES: Space[] = [
  { name: 'Mein Wissen', shared: false, members: [ME] },
  { name: 'Lernen', shared: false, members: [ME] },
  { name: 'Team Homelab', shared: true, members: [ME, 'Anna', 'Ben', 'Chris'] },
]

/** Small seeded random generator, so the vault looks the same on every reload. */
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

const random = seeded(7)

function pick<T>(list: T[]): T {
  return list[Math.floor(random() * list.length)]
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

type Draft = Partial<Omit<Note, 'id' | 'title' | 'path'>> & { links?: string[]; text?: string }

const notes: Note[] = []

function daysAgo(days: number): string {
  const d = new Date(Date.UTC(2026, 8, 26, 9, 0))
  d.setUTCDate(d.getUTCDate() - days)
  d.setUTCHours(8 + Math.floor(random() * 11), Math.floor(random() * 60))
  return d.toISOString()
}

function add(path: string, title: string, draft: Draft = {}): void {
  const { links = [], text, ...rest } = draft
  const intro = text ?? `Kurze Notiz zu **${title}**.`
  const related = links.length ? `\n\n## Verwandt\n\n${links.map((l) => `- [[${l}]]`).join('\n')}` : ''
  notes.push({
    id: slug(path + '-' + title),
    title,
    path: path.split('/'),
    body: rest.body ?? `# ${title}\n\n${intro}${related}\n`,
    updated: rest.updated ?? daysAgo(Math.floor(random() * 120)),
    author: rest.author ?? ME,
    aiDraft: rest.aiDraft,
    lockedBy: rest.lockedBy,
    attachments: rest.attachments,
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Mein Wissen / Homelab
// ---------------------------------------------------------------------------------------------------------------

const NET = 'Mein Wissen/Homelab/Netzwerk'
add(NET, 'VLANs', {
  text: 'Vier Netze, sauber getrennt. Geräte ohne Updates landen im IoT-Netz und kommen nicht an die Server.',
  links: ['Firewall-Regeln', 'Switch-Konfiguration', 'IP-Plan', 'WLAN-Planung'],
})
add(NET, 'DNS und Pi-hole', { links: ['VLANs', 'Reverse Proxy', 'Docker-Host'] })
add(NET, 'Reverse Proxy', {
  body: `# Reverse Proxy

Alle Dienste hängen hinter einem Proxy, jeder unter einer eigenen Subdomain von \`home.example.com\`.

## Aufbau

| Dienst | Adresse | Intern |
|---|---|---|
| Plex | plex.home.example.com | 10.0.20.11:32400 |
| Paperless | paperless.home.example.com | 10.0.20.12:8000 |
| Grafana | grafana.home.example.com | 10.0.20.13:3000 |

## Zertifikate

Wildcard per DNS-Challenge, verlängert sich selbst. Das Vorgehen steht im Runbook [[Zertifikate erneuern]].

## Offen

- [x] HSTS für alle Subdomains
- [ ] Zugriff von außen nur über [[WireGuard]]
- [ ] Rate-Limit vor der Anmeldung von [[Vaultwarden]]

## Verwandt

- [[DNS und Pi-hole]]
- [[Docker-Host]]
- [[Uptime Kuma]]
`,
})
add(NET, 'WireGuard', { links: ['Reverse Proxy', 'Firewall-Regeln', 'Zugreisen Europa'] })
add(NET, 'Firewall-Regeln', { links: ['VLANs', 'IPv6'] })
add(NET, 'IPv6', { links: ['Firewall-Regeln', 'DNS und Pi-hole'] })
add(NET, 'Switch-Konfiguration', { links: ['VLANs', 'Geräteliste'] })
add(NET, 'WLAN-Planung', { links: ['VLANs'] })

const SRV = 'Mein Wissen/Homelab/Server'
add(SRV, 'Proxmox', {
  text: 'Zwei Knoten plus Quorum-Gerät. Jede VM hat ein Backup-Ziel, siehe [[restic]] und [[ZFS-Snapshots]].',
  links: ['TrueNAS', 'Docker-Host', 'Mini-PC', 'Warum Proxmox', 'USV'],
  attachments: [{ name: 'proxmox-cluster.png', size: '412 KB', kind: 'image' }],
})
add(SRV, 'TrueNAS', { links: ['ZFS-Snapshots', 'Proxmox', 'Offsite-Kopie', 'Warum ZFS'] })
add(SRV, 'Docker-Host', { links: ['Proxmox', 'Reverse Proxy', 'Uptime Kuma', 'Paperless-ngx', 'Immich'] })
add(SRV, 'USV', { links: ['Stromverbrauch', 'Server neu starten'] })
add(SRV, 'Mini-PC', { links: ['Proxmox', 'Stromverbrauch'] })
add(SRV, 'Stromverbrauch', { links: ['USV', 'Grafana'] })

const SVC = 'Mein Wissen/Homelab/Dienste'
add(SVC, 'Plex', { links: ['Docker-Host', 'Reverse Proxy', 'TrueNAS'] })
add(SVC, 'Home Assistant', { links: ['VLANs', 'Stromverbrauch', 'Grafana'] })
add(SVC, 'Paperless-ngx', { links: ['Docker-Host', 'restic', 'Offsite-Kopie'] })
add(SVC, 'Vaultwarden', { links: ['Reverse Proxy', 'restic'] })
add(SVC, 'Immich', { links: ['Docker-Host', 'Kamera-Ausrüstung', 'TrueNAS'] })
add(SVC, 'Uptime Kuma', { links: ['Reverse Proxy', 'Monitoring-Konzept'] })
add(SVC, 'Nextcloud', { links: ['Docker-Host', 'TrueNAS'] })
add(SVC, 'Grafana', { links: ['Monitoring-Konzept', 'Stromverbrauch'] })

const BAK = 'Mein Wissen/Homelab/Sicherung'
add(BAK, '3-2-1-Regel', {
  text: 'Drei Kopien, zwei Medien, eine außer Haus. Klingt einfach, scheitert meist an der dritten.',
  links: ['restic', 'Offsite-Kopie', 'Restore-Test'],
})
add(BAK, 'restic', {
  body: `# restic

Sichert alle Datenordner der Container jede Nacht um 03:15 auf das [[TrueNAS]].

\`\`\`bash
restic -r sftp:backup@nas.home.example.com:/restic backup /srv/data \\
  --exclude-caches --tag nightly
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
\`\`\`

> Ein Backup, das nie zurückgespielt wurde, ist eine Hoffnung. Siehe [[Restore-Test]].

## Verwandt

- [[3-2-1-Regel]]
- [[Paperless-ngx]]
- [[Vaultwarden]]
- [[Backup zurückspielen]]
`,
})
add(BAK, 'ZFS-Snapshots', { links: ['TrueNAS', 'Warum ZFS', 'Restore-Test'] })
add(BAK, 'Restore-Test', { links: ['restic', 'ZFS-Snapshots', 'Backup zurückspielen'] })
add(BAK, 'Offsite-Kopie', {
  aiDraft: true,
  author: 'KI-Assistent',
  updated: daysAgo(0),
  body: `# Offsite-Kopie

*Entwurf, geschrieben über den MCP-Zugang aus dem Gespräch vom Vormittag.*

## Ziel

Die dritte Kopie aus der [[3-2-1-Regel]] liegt außer Haus, verschlüsselt, ohne dass der Anbieter hineinsehen kann.

## Vorschlag

1. Zweites restic-Repository bei einem S3-Anbieter, Schlüssel nur lokal
2. Wöchentlich statt täglich, um Kosten zu sparen
3. Einmal im Quartal ein [[Restore-Test]] aus dieser Kopie

## Offene Fragen

- Welche Ordner sind groß genug, dass sie das Budget sprengen? Vermutlich die Fotos aus [[Immich]].
- Reicht die Upload-Bandbreite für den ersten Lauf?
`,
})

// ---------------------------------------------------------------------------------------------------------------
// Mein Wissen / Projekte
// ---------------------------------------------------------------------------------------------------------------

const APP = 'Mein Wissen/Projekte/App-Ideen'
add(APP, 'Notiz-App', {
  body: `# Notiz-App

Wie Obsidian, aber einfacher und im Browser. Markdown-Dateien auf der Platte, ein Graph, in den man hineinzoomen kann.

## Grundsätze

- Die Dateien sind die Wahrheit, keine Datenbank dahinter
- Einer tippt zur Zeit, die anderen sehen eine Sperre
- Konten und OIDC von Anfang an

## Bausteine

- [[Graph mit Hineinzoomen]]
- [[Markdown-Editor]]
- [[Plugin-Sandbox]]
- [[MCP-Anbindung]]
`,
})
add(APP, 'Graph mit Hineinzoomen', {
  text: 'Von weitem Bereiche als Wolken, beim Hineinzoomen gehen sie auf. Wie eine Landkarte von Ländern zu Städten.',
  links: ['Notiz-App', 'Regression', 'Bayes-Theorem'],
})
add(APP, 'Plugin-Sandbox', { links: ['Notiz-App', 'Async in Rust'] })
add(APP, 'MCP-Anbindung', { links: ['Notiz-App', 'Offsite-Kopie'] })
add(APP, 'Markdown-Editor', { links: ['Notiz-App', 'Traits'] })

const WS = 'Mein Wissen/Projekte/Werkstatt'
add(WS, '3D-Drucker', { links: ['Filamente', 'Werkbank', 'Stromverbrauch'] })
add(WS, 'Filamente', { links: ['3D-Drucker'] })
add(WS, 'Lötstation', { links: ['Werkbank'] })
add(WS, 'Werkbank', { links: ['Regalsystem', 'Lötstation'] })
add(WS, 'Regalsystem', { links: ['Werkbank', 'Mini-PC'] })

// ---------------------------------------------------------------------------------------------------------------
// Mein Wissen / Küche, Reisen
// ---------------------------------------------------------------------------------------------------------------

const REC = 'Mein Wissen/Küche/Rezepte'
add(REC, 'Sauerteigbrot', {
  body: `# Sauerteigbrot

Grundrezept für einen Laib, rund 900 g. Der Sauerteig muss vorher aktiv sein, siehe [[Sauerteig ansetzen]].

## Zutaten

- 500 g Weizenmehl 550
- 350 g Wasser
- 100 g aktiver Sauerteig
- 10 g Salz

## Ablauf

1. Mehl und Wasser mischen, eine Stunde ruhen lassen
2. Sauerteig und Salz einarbeiten
3. Vier Mal dehnen und falten, alle 30 Minuten
4. Über Nacht im Kühlschrank gehen lassen
5. Im [[Gusseisen pflegen|Gusseisentopf]] bei 250 °C backen, 20 Minuten mit Deckel, 25 ohne

## Verwandt

- [[Focaccia]]
- [[Pizzateig]]
`,
  attachments: [{ name: 'krume.jpg', size: '1,8 MB', kind: 'image' }],
})
add(REC, 'Pizzateig', { links: ['Sauerteigbrot', 'Focaccia', 'Portugal'] })
add(REC, 'Ramen', { links: ['Fermentieren', 'Japanisch-Vokabeln Küche'] })
add(REC, 'Linsencurry', { links: ['Messer schärfen'] })
add(REC, 'Shakshuka', { links: ['Gusseisen pflegen', 'Portugal'] })
add(REC, 'Focaccia', { links: ['Sauerteigbrot', 'Pizzateig'] })
add(REC, 'Kimchi', { links: ['Fermentieren', 'Ramen'] })

const BAS = 'Mein Wissen/Küche/Grundlagen'
add(BAS, 'Sauerteig ansetzen', { links: ['Sauerteigbrot', 'Fermentieren'] })
add(BAS, 'Fermentieren', { links: ['Kimchi', 'Sauerteig ansetzen'] })
add(BAS, 'Messer schärfen', { links: ['Werkbank'] })
add(BAS, 'Gusseisen pflegen', { links: ['Shakshuka'] })

const TRV = 'Mein Wissen/Reisen'
add(TRV, 'Norwegen 2025', {
  links: ['Packliste', 'Kamera-Ausrüstung', 'Zugreisen Europa'],
  attachments: [{ name: 'route.gpx', size: '96 KB', kind: 'file' }],
})
add(TRV, 'Portugal', { links: ['Zugreisen Europa', 'Packliste'] })
add(TRV, 'Packliste', { links: ['Kamera-Ausrüstung'] })
add(TRV, 'Zugreisen Europa', { links: ['Portugal', 'Norwegen 2025'] })
add(TRV, 'Kamera-Ausrüstung', { links: ['Immich'] })

// Daily notes: they make an Obsidian graph turn into a hairball, because each one links to a few topics.
const TOPICS = [
  'Proxmox', 'restic', 'Reverse Proxy', 'Home Assistant', 'Sauerteigbrot', 'Notiz-App', 'Graph mit Hineinzoomen',
  'Ownership', 'Hiragana', '3D-Drucker', 'Plex', 'Paperless-ngx', 'VLANs', 'Restore-Test', 'Portugal', 'Kimchi',
  'Traits', 'Regression', 'Immich', 'WireGuard', 'Pizzateig', 'Treffen im Juli', 'Monitoring-Konzept',
]
for (let day = 0; day < 42; day++) {
  const date = new Date(Date.UTC(2026, 8, 25))
  date.setUTCDate(date.getUTCDate() - day * 2)
  const label = date.toISOString().slice(0, 10)
  const count = 1 + Math.floor(random() * 3)
  const chosen = new Set<string>()
  while (chosen.size < count) chosen.add(pick(TOPICS))
  add('Mein Wissen/Tagesnotizen', label, {
    text: `Was heute war: ${[...chosen].map((t) => `[[${t}]]`).join(', ')}.`,
    updated: date.toISOString(),
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Lernen
// ---------------------------------------------------------------------------------------------------------------

const RUST = 'Lernen/Rust'
add(RUST, 'Ownership', { links: ['Borrowing', 'Traits'] })
add(RUST, 'Borrowing', { links: ['Ownership', 'Lifetimes'] })
add(RUST, 'Lifetimes', { links: ['Borrowing'] })
add(RUST, 'Traits', { links: ['Ownership', 'Fehlerbehandlung'] })
add(RUST, 'Fehlerbehandlung', { links: ['Traits', 'Async in Rust'] })
add(RUST, 'Async in Rust', { links: ['Fehlerbehandlung', 'Cargo'] })
add(RUST, 'Cargo', { links: ['Async in Rust'] })

const STAT = 'Lernen/Statistik'
add(STAT, 'Mittelwert und Median', { links: ['Normalverteilung'] })
add(STAT, 'Normalverteilung', { links: ['Mittelwert und Median', 'Hypothesentests'] })
add(STAT, 'Hypothesentests', { links: ['Normalverteilung', 'Bayes-Theorem'] })
add(STAT, 'Regression', { links: ['Normalverteilung'] })
add(STAT, 'Bayes-Theorem', { links: ['Hypothesentests'] })

const JP = 'Lernen/Japanisch'
add(JP, 'Hiragana', { links: ['Katakana', 'Kanji-Liste'] })
add(JP, 'Katakana', { links: ['Hiragana'] })
add(JP, 'Kanji-Liste', { links: ['Hiragana', 'Japanisch-Vokabeln Küche'] })
add(JP, 'Partikel', { links: ['Höflichkeitsformen'] })
add(JP, 'Höflichkeitsformen', { links: ['Partikel'] })
add(JP, 'Japanisch-Vokabeln Küche', { links: ['Ramen', 'Kanji-Liste'] })

const BOOK = 'Lernen/Bücher'
add(BOOK, 'Der pragmatische Programmierer', { links: ['Fehlerbehandlung', 'Notiz-App'] })
add(BOOK, 'Schnelles Denken, langsames Denken', { links: ['Bayes-Theorem', 'Hypothesentests'] })
add(BOOK, 'Datenintensive Anwendungen', { links: ['Warum ZFS', 'restic'] })

// ---------------------------------------------------------------------------------------------------------------
// Team Homelab (shared with three people)
// ---------------------------------------------------------------------------------------------------------------

const RUN = 'Team Homelab/Runbooks'
add(RUN, 'Server neu starten', { author: 'Ben', links: ['USV', 'Update-Fenster'] })
add(RUN, 'Zertifikate erneuern', {
  author: 'Anna',
  lockedBy: 'Anna',
  links: ['Reverse Proxy', 'Namensschema'],
})
add(RUN, 'Backup zurückspielen', {
  author: 'Chris',
  body: `# Backup zurückspielen

Für den Fall, dass ein Dienst weg ist. Getestet zuletzt beim [[Restore-Test]] im August.

1. Dienst stoppen
2. Snapshot wählen: \`restic snapshots --tag nightly\`
3. In einen leeren Ordner zurückspielen, **nie** direkt über die Daten
4. Vergleichen, dann tauschen
5. Im [[Treffen im September]] kurz berichten

## Verwandt

- [[restic]]
- [[ZFS-Snapshots]]
`,
})
add(RUN, 'Neuen Benutzer anlegen', { author: 'Anna', links: ['Namensschema', 'Lizenzen'] })
add(RUN, 'Update-Fenster', { author: 'Ben', links: ['Server neu starten', 'Monitoring-Konzept'] })

const DEC = 'Team Homelab/Entscheidungen'
add(DEC, 'Warum Proxmox', { author: 'Ben', links: ['Proxmox', 'Treffen im Juli'] })
add(DEC, 'Warum ZFS', { author: 'Chris', links: ['TrueNAS', 'ZFS-Snapshots'] })
add(DEC, 'Monitoring-Konzept', { author: 'Anna', links: ['Uptime Kuma', 'Grafana'] })
add(DEC, 'Namensschema', { author: 'Ben', links: ['IP-Plan', 'Geräteliste'] })

const MEET = 'Team Homelab/Besprechungen'
for (const [title, links, author] of [
  ['Treffen im Mai', ['Warum ZFS', 'Namensschema'], 'Chris'],
  ['Treffen im Juni', ['Monitoring-Konzept', 'Treffen im Mai'], 'Anna'],
  ['Treffen im Juli', ['Warum Proxmox', 'Treffen im Juni'], 'Ben'],
  ['Treffen im August', ['Restore-Test', 'Treffen im Juli'], 'Chris'],
  ['Treffen im September', ['Backup zurückspielen', 'Treffen im August', 'Offsite-Kopie'], 'Anna'],
] as [string, string[], string][]) {
  add(MEET, title, { author, links })
}

const INV = 'Team Homelab/Inventar'
add(INV, 'Geräteliste', { author: 'Ben', links: ['Mini-PC', 'USV', 'Switch-Konfiguration'] })
add(INV, 'IP-Plan', {
  author: 'Chris',
  links: ['VLANs', 'Namensschema'],
  attachments: [{ name: 'ip-plan.pdf', size: '220 KB', kind: 'pdf' }],
})
add(INV, 'Lizenzen', { author: 'Anna', links: ['Neuen Benutzer anlegen'] })

export const NOTES: Note[] = notes
