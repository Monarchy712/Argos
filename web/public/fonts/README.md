# Self-hosted fonts

Two variable faces, latin subset, served from this origin rather than a font CDN.

| File | Family | Axes | License |
|---|---|---|---|
| `inter-latin-var.woff2` | Inter | `wght 100..900` | SIL Open Font License 1.1 |
| `jetbrains-mono-latin-var.woff2` | JetBrains Mono | `wght 100..800` | SIL Open Font License 1.1 |

Both are OFL, which permits redistribution and bundling.

## Why self-hosted and not Google Fonts

Argos ships no trackers, analytics or third-party assets, so loading the page contacts nobody but
the endpoints the app needs. Linking a font CDN would hand the visitor's IP, `User-Agent` and
`Referer` to a third party on *every* page load, on a page whose whole subject is what you can be
observed doing. Self-hosting keeps that guarantee intact.

It also matters that the built app is published as a static Swarm collection: a CDN `<link>` would
be an external dependency the collection cannot carry, so the typography would silently fall back.

Upstream: <https://github.com/rsms/inter>, <https://github.com/JetBrains/JetBrainsMono>.
