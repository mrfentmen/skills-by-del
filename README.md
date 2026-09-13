# skills — made by Del

A collection of Agent Skills and MCP servers, built from scratch by Del.

## Agent Skills

Code-poetry skills. Each one makes the agent write your code *as* the poem —
working, runnable code shaped into the poetic form, not a poem about code.

| Skill | Form |
|---|---|
| `skills/villanelle/` | 19 lines, two refrains, ABA rhyme — a stubborn old poet who repeats himself |
| `skills/sestina/` | 39 lines, six end-words rotating in fixed permutation — a mathematician-poet |
| `skills/pantoum/` | Echoing quatrains where lines 2 & 4 become the next stanza's 1 & 3 |
| `skills/ghazal/` | 5–15 couplets ending in the same refrain + rhyme, poet's name in the finale |

Each skill is a single `SKILL.md` — drop the folder into your skills directory to install it.

## MCP Servers

Stdio MCP servers (TypeScript, Node 18+). Each has its own README with install
and client-config instructions.

| Server | What it does | Key needed? |
|---|---|---|
| `mcp-servers/ifdb/` | Search the Interactive Fiction Database, get game details (ratings, downloads, play-online links), sort by highest rated | No |
| `mcp-servers/know-your-meme/` | Search Know Your Meme, get a meme's origin, meaning, and spread | No |
| `mcp-servers/mobygames/` | Search MobyGames, get full game details (developers, publishers, releases, genres) | Yes — free key via `MOBYGAMES_API_KEY` |
| `mcp-servers/demozoo/` | Search Demozoo's demoscene database (productions, parties), get details with download links | No |

Quick start per server:

```bash
cd mcp-servers/ifdb   # or know-your-meme / mobygames / demozoo
npm install
npm run build
node dist/index.js
```

## Status notes

- **ifdb** — live-tested end to end (search + game details against real IFDB pages).
- **know-your-meme** — compiles and passes stdio/error-path tests, but its page
  selectors were never verified against live Know Your Meme pages. Run
  `search_memes` / `get_meme_details` against the real site and adjust selectors
  if fields come back empty.
- **mobygames** — compiles; request shapes follow the official API docs, but no
  live calls were made (needs your free API key from mobygames.com).
- **demozoo** — compiles; stdio handshake, `tools/list`, and error paths
  verified live. Endpoint shapes verified from real-world API consumers
  (official docs site was unreachable at build time), but **no live API
  calls were made** — run `search_productions` once against the real API to
  confirm response parsing.
