# Third-party licences

nexlore itself is licensed under the **GNU Affero General Public License v3.0** (see [LICENSE](LICENSE)). This file
lists what it ships or depends on.

## Bundled with the app

These files travel inside the container image, so their notices travel with them.

| What | Copyright | Licence | Notice in the app |
|---|---|---|---|
| Fonts Inter, Atkinson Hyperlegible Next, Literata, Source Serif 4, IBM Plex Sans, JetBrains Mono (via Fontsource) | their authors, see the notice | OFL-1.1 | `/licenses/fonts.txt` |
| The same fonts as TTF for PDFs, plus Noto Emoji (from Google Fonts) | their authors, see the notices | OFL-1.1 | `backend/app/fonts/OFL-*.txt` |
| mitex 0.2.6, LaTeX formulas in PDFs (a Typst package) | Myriad-Dreamin, OrangeX4, Enter-tainer | Apache-2.0 | `backend/app/typst/packages/preview/mitex/0.2.6/LICENSE` |
| Lucide icons (partly from Feather) | Lucide Icons and Contributors; Cole Bemis | ISC, MIT | `/licenses/lucide.txt` |

nexlore loads no font, icon or script from another host.

## Code taken over

`frontend/src/editor/listItemView.ts` is Milkdown's list item view (`@milkdown/components`, 7.22.2) with one change.
The notice ships with the app at `/licenses/milkdown.txt`.

```
The MIT License (MIT)

Copyright (c) 2020-present Mirone

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Backend

| Package | Licence |
|---|---|
| FastAPI, SQLAlchemy, pydantic, pydantic-settings, markdown-it-py, mdit-py-plugins, PyYAML, watchfiles, argon2-cffi, PyJWT | MIT |
| uvicorn, httpx, pypdf, segno, tinycss2 | BSD-3-Clause |
| numpy | BSD-3-Clause (with small parts under 0BSD, MIT, Zlib, CC0-1.0) |
| Pillow | MIT-CMU |
| python-multipart, typst (Python binding of Typst, which it bundles) | Apache-2.0 |
| cryptography | Apache-2.0 **or** BSD-3-Clause |
| pillow-heif | BSD-3-Clause for its own code; the binary wheels are **GPLv2** as a whole, see below |

### HEIC photos: pillow-heif and the libraries it brings

To turn iPhone photos (HEIC) into WebP, nexlore uses pillow-heif. Its binary wheels, and so the container image,
contain:

| Library | Licence |
|---|---|
| libheif | LGPL-3.0 |
| libde265 | LGPL-3.0 |
| x265 | GPL-2.0-or-later |

The wheel ships these notices in `pillow_heif-*.dist-info/licenses/`. GPL-2.0-or-later and LGPL-3.0 may be combined
with an AGPL-3.0 work, and the source of every part is public.

## Frontend

| Package | Licence |
|---|---|
| React, React DOM, React Router, React Flow (`@xyflow/react`, the canvas; notice at `/licenses/xyflow.txt`), Milkdown (Crepe, Kit), Vue (used by Milkdown's components), CodeMirror language support, Lezer, marked, KaTeX, Mermaid, i18next, react-i18next, unist-util-visit, mdast-util-gfm-table | MIT |
| d3-force, yaml | ISC |
| Fontsource packages | MIT (the fonts themselves OFL-1.1, see above) |

Build and test tools (Vite, TypeScript, Tailwind CSS, Vitest, Playwright, ruff, pytest) are not part of the image.

## Compatibility

All of the above may be combined into an AGPL-3.0 work. The obligation runs one way: nexlore as a whole is
AGPL-3.0, and anyone who runs a modified version as a network service must offer its source.
