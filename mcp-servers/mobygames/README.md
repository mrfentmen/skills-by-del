# mobygames-mcp

An MCP (Model Context Protocol) server that exposes the [MobyGames](https://www.mobygames.com/)
video game database as tools for AI assistants. Uses the official
[MobyGames API v1](https://api.mobygames.com/v1/) — no web scraping.

Built with the TypeScript [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
and the stdio transport.

## What it does

Three tools:

| Tool | What it does |
|---|---|
| `search_games` | Search games by title substring (case-insensitive). Optional `platform` filter (platform name or ID, e.g. `"Windows"` or `"3"`) and `limit` (1–100, default 10). Returns `game_id`, `title`, earliest release `year`, `platforms`, `moby_score`, `num_votes`, and `moby_url`. |
| `get_game_details` | Full details for one game by numeric `game_id` (from `search_games`): description, genres, alternate titles, platforms with first release dates, companies grouped by role (developers, publishers, …), per-platform releases (dates, countries, companies), and rating info (`moby_score`, `num_votes`). |
| `get_platforms` | List all MobyGames platforms with their numeric IDs. Optional `name` substring filter (e.g. `"playstation"`). |

## Prerequisites

- **Node.js 18+** (uses the built-in `fetch`).
- **A free MobyGames API key.** MobyGames offers free API access for hobbyists:
  1. Create an account at https://www.mobygames.com/ (free).
  2. Open your **MobyPro API page** (linked from the [API docs](https://www.mobygames.com/info/api/)) and copy your private API key.
  3. Export it before starting the server:

```sh
export MOBYGAMES_API_KEY=your_api_key_here
```

If the variable is missing, the server refuses to start and tells you exactly what's wrong.
All keys are URL-encoded and sent as the `api_key` query parameter, per the API docs.

## Install and build

```sh
cd ~/workspace/skills/mcp-servers/mobygames
npm install
npm run build   # compiles src/index.ts -> dist/ with tsc
```

## MCP client configuration (stdio)

Example for Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mobygames": {
      "command": "node",
      "args": ["/home/hatch/workspace/skills/mcp-servers/mobygames/dist/index.js"],
      "env": {
        "MOBYGAMES_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Or run it directly:

```sh
MOBYGAMES_API_KEY=your_api_key_here node dist/index.js
```

## Notes and limits

- **Rate limits respected.** Non-commercial keys are limited to 720 requests/hour and at most
  1 request/second. Sequential requests are throttled (~1.1 s apart). Note that
  `get_game_details` fans out one request per platform (release/company info is per-platform
  in the API), so games with many platforms take a few extra seconds.
- **Error handling.** API errors are surfaced with clear messages: 401 for bad/missing keys,
  404 for unknown game/platform IDs, 422 for invalid parameter values (e.g. a title longer
  than 128 characters), and 429 for rate-limit breaches.
- Some fields may be `null` and lists may be empty — that's normal per the API docs.
