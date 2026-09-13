# ifdb-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for the
**Interactive Fiction Database** ([IFDB](https://ifdb.org)) — the community
catalog of text adventures / interactive fiction, from *Zork* to modern
competition entries.

It exposes two tools:

- **`search_games`** — search IFDB by title, author, or keyword, with optional
  result ordering (by rating, rating count, date, title, ...). Returns title,
  authors, year, average star rating, rating count, and the IFDB URL.
- **`get_game_details`** — full details for one game: description, authors,
  year, genres, development system, average rating, rating histogram,
  review/play/wishlist counts, download links (with notes), and a
  play-in-browser link.

## Prerequisites

- Node.js 18 or newer
- No API key needed — IFDB has no public API; this server reads IFDB's public
  HTML pages and parses them with [cheerio](https://cheerio.js.org/).

## Install

```bash
cd ~/workspace/skills/mcp-servers/ifdb
npm install
npm run build
```

## Add to an MCP client

Point your client at the built server over stdio. For example, in a
Claude Desktop-style config:

```json
{
  "mcpServers": {
    "ifdb": {
      "command": "node",
      "args": ["/home/hatch/workspace/skills/mcp-servers/ifdb/dist/index.js"]
    }
  }
}
```

Adjust the path to wherever you installed it. Start it manually with
`npm start` (or `node dist/index.js`); it speaks MCP over stdio.

## Tools

### `search_games`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Title, author, or keyword to search for. |
| `limit` | integer | no | 10 | Max results to return (1–50). |
| `sort` | enum | no | `relevance` | `relevance`, `title`, `author`, `newest`, `oldest`, `highest_rated`, `lowest_rated`, `most_ratings`, `fewest_ratings`, `longest`, `shortest`, `random`. |

Returns `{ query, sort, totalResults, returned, results: [...] }`, where each
result has `id`, `title`, `authors`, `year`, `averageStars`, `ratingCount`,
and `url`.

### `get_game_details`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `game` | string | yes | Full IFDB URL (`https://ifdb.org/viewgame?id=...`), relative path (`viewgame?id=...`), or bare game TUID (e.g. `4gxk83ja4twckm6j`). |

Returns `{ id, url, title, authors, year, genres, devSystem, description,
averageStars, ratingCount, ratingHistogram, reviewCount, playedByCount,
wishlistCount, downloads: [{ name, url, notes }], playOnlineUrl }`.

## Notes on data source

- This server **scrapes IFDB's public web pages** — there is no official IFDB
  API and no key is required. It identifies itself with the User-Agent
  `ifdb-mcp/1.0`, sends requests strictly one at a time, and spaces them out
  (~800 ms) to stay polite. If IFDB changes its page markup, the parsers will
  need updating.
- **Tags are not exposed**: IFDB only shows a game's tag list to logged-in
  members, so anonymous page fetches can't see them. Genres, which are public,
  are included instead.
- Errors (network failures, HTTP errors, invalid game ids) are returned as
  MCP tool errors with a plain-English message.
