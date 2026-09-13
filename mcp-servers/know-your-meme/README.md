# Know Your Meme MCP Server

An MCP (Model Context Protocol) server that lets an AI assistant look up memes on
[Know Your Meme](https://knowyourmeme.com). It scrapes the site's **public pages** —
no API key, no account, no signup needed.

**Note:** the HTML extraction selectors in `src/index.ts` are provisional and were
not yet verified against live pages in the build environment. They lean on stable
signals first (Open Graph meta tags, JSON-LD article data, `<h1>`/`<h2>` headings)
with site-specific class names only as fallbacks. Verify output against real pages
before trusting it in production.

## What it does

Two tools, exposed over stdio:

| Tool | Parameters | Returns |
|---|---|---|
| `search_memes` | `query` (string, required), `limit` (1–25, default 10) | Matching entries: name, URL, year (when shown on the result card), snippet |
| `get_meme_details` | `url` (string, required — a `knowyourmeme.com/memes/...` URL) | name, year, summary/meaning, origin, spread, examples, tags |

"Meaning" is the meme's opening description paragraph, which is how Know Your Meme
entries convey what a meme means.

## Prerequisites

- Node.js 18+ (uses the built-in `fetch`; tested on Node 24)
- npm

## Install

```bash
cd know-your-meme
npm install
npm run build
```

## Use with an MCP client (stdio)

Point your client at the built server. Example for a Claude Desktop-style
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "know-your-meme": {
      "command": "node",
      "args": ["/absolute/path/to/know-your-meme/dist/index.js"]
    }
  }
}
```

Or run it directly to smoke-test over stdio:

```bash
npm start
```

## Polite scraping

- Identifies itself with a descriptive `User-Agent`.
- Sends requests **sequentially** with a minimum 800 ms gap between them.
- Only ever fetches `knowyourmeme.com` — any other host is refused.
- Handles HTTP errors gracefully: 404 → "page not found", 429 → asks you to back off,
  other failures → clear error message instead of a crash.
- Keep usage light: this is a research/lookup helper, not a bulk crawler. If you get
  HTTP 429 responses, slow down.

## Project layout

```
know-your-meme/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts      # MCP server + HTML parsing (cheerio)
├── dist/             # built output (after npm run build)
└── README.md
```
