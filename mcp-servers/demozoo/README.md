# demozoo-mcp

An MCP server for [Demozoo](https://demozoo.org) — the demoscene database:
386,000+ productions (demos, intros, cracktros, music, graphics), plus
demoparties. Uses Demozoo's public read-only JSON API. **No API key needed.**

## Prerequisites

- Node.js 18+

## Install

```bash
npm install
npm run build
```

## Use with an MCP client (stdio)

```json
{
  "mcpServers": {
    "demozoo": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-servers/demozoo/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Parameters | What it returns |
|---|---|---|
| `search_productions` | `title` (optional), `platform` (optional numeric id), `production_type` (optional numeric id or name like `demo`, `64k`, `cracktro`, `music`), `supertype` (optional, e.g. `production`, `graphics`, `music`), `page`, `limit` | Paged matches: id, title, type, platforms, release date, authors/groups, Demozoo URL |
| `get_production_details` | `id` (required) | Full production detail: authors, download links, screenshots, Demozoo URL |
| `list_parties` | `page`, `limit` | Paged demoparties: name, dates, location, website |
| `get_party_details` | `id` (required) | One party's details |

**Important API quirk:** Demozoo's `title` filter is an *exact*,
case-insensitive match — it is not a substring search. To discover things,
browse with `platform` / `production_type` filters instead, then pull details
by id. Unknown query parameters are silently ignored by the API, so only the
parameters above are exposed.

## Politeness

- Identifying `User-Agent` on every request.
- Requests are sequential with ~1.5 s spacing. Demozoo's `robots.txt`
  publishes `Crawl-delay: 10` for crawlers; this server keeps interactive use
  far below that.
- Only the public `/api/v1/` endpoints are used (never the disallowed
  `/search/` pages).

## Verification status

- Compiles clean (`tsc`), `node --check` passes, stdio handshake +
  `tools/list` + error paths verified live.
- Endpoint shapes verified from real-world API consumers (the official API
  docs site was unreachable at build time): base URL, `?format=json`,
  production list/detail params, and the production-type id table come from
  documented integrations; the parties URL pattern from a third-party client
  library. **No live API calls were made during the build** — run
  `search_productions` once against the real API to confirm response parsing
  before trusting production output.
