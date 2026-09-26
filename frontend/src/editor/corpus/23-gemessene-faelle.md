---
title: Gemessene Fälle
tags:
  - test
---
Titel mit Linie
===============

Ein Bild ![Foto vom Regal](Anhänge/regal.webp) mitten im Satz.

![Markdown-Bild](Anhänge/foto.webp)

<%* tR += tp.date.now("YYYY-MM-DD") %>

~~~bash
echo tilde
~~~

    eingerückter Code
    zweite Zeile

Nackt https://example.net/pfad und in Klammern <https://example.org>.

| Links | Rechts | Zentrum |
|:------|-------:|:-----:|
| Alpha | Beta | Gamma |

Mit [Referenz][ref] und ![Bildref][bild].

[ref]: https://example.com/ref "Titel"
[bild]: Anhänge/ref.png

- Liste
	- mit Tab eingerückt
	- zweiter

```js title="beispiel.js"
const wert = 1
```

$$
a^2 + b^2 = c^2
$$

> [!warning]- Eingeklappt
> Inhalt mit ==Markierung== und %% Kommentar %%.

#tag am Zeilenanfang und Satzende ^block-1

| Wiki | Feld |
|---|---|
| [[Ziel\|Alias]] | Zelle |
