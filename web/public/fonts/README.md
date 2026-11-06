# Self-hosted fonts

Two variable faces, latin subset, served from this origin rather than a font CDN.

| File | Family | Axes | License |
|---|---|---|---|
| `inter-latin-var.woff2` | Inter | `wght 100..900` | SIL Open Font License 1.1 |
| `jetbrains-mono-latin-var.woff2` | JetBrains Mono | `wght 100..800` | SIL Open Font License 1.1 |

Both are OFL, which permits redistribution and bundling.

## Why self-hosted and not Google Fonts

Argos routes live chain reads through the Nym mixnet so an RPC provider sees a Nym exit instead
of the visitor's IP (`web/src/lib/transport.ts`). Linking a font CDN would hand the visitor's IP,
`User-Agent` and `Referer` to a third party on *every* page load — before any of that privacy work
even starts, and on a page whose whole subject is what you can be observed doing. Self-hosting
keeps the first-party guarantee intact.

It also matters that the built app is published as a static Swarm collection: a CDN `<link>` would
be an external dependency the collection cannot carry, so the typography would silently fall back.

Upstream: <https://github.com/rsms/inter>, <https://github.com/JetBrains/JetBrainsMono>.
