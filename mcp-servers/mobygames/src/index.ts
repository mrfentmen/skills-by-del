#!/usr/bin/env node
/**
 * mobygames-mcp — an MCP server exposing the MobyGames video game database.
 *
 * Uses the official MobyGames API v1 (https://api.mobygames.com/v1/).
 * Docs: https://www.mobygames.com/info/api/
 *
 * Authentication: the API requires a free API key, read from the
 * MOBYGAMES_API_KEY environment variable and sent as the `api_key`
 * query parameter on every request.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = "https://api.mobygames.com/v1";
// Non-commercial quota is 720 req/hour with a max of 1 req/second.
// Sequential tool requests are throttled to stay under the per-second cap.
const REQUEST_GAP_MS = 1100;

const apiKey = process.env.MOBYGAMES_API_KEY;
if (!apiKey) {
  console.error(
    "Error: MOBYGAMES_API_KEY environment variable is not set.\n" +
      "Get a free MobyGames API key from your MobyPro API page after creating\n" +
      "an account at https://www.mobygames.com/, then export MOBYGAMES_API_KEY=<your key>\n" +
      "before starting this server."
  );
  process.exit(1);
}
const API_KEY: string = apiKey;

/* ------------------------------------------------------------------ */
/* MobyGames API response shapes (from the official API docs)          */
/* ------------------------------------------------------------------ */

interface MobyApiError {
  code: number;
  error: string;
  message: string;
}

interface MobyGenre {
  genre_category: string | null;
  genre_category_id: number | null;
  genre_description: string | null;
  genre_id: number;
  genre_name: string;
}

interface MobyGamePlatform {
  first_release_date: string | null;
  platform_id: number;
  platform_name: string;
}

interface MobyAlternateTitle {
  description: string | null;
  title: string;
}

interface MobyGame {
  game_id: number;
  title: string;
  moby_url: string;
  description: string | null;
  moby_score: number | null;
  num_votes: number | null;
  official_url: string | null;
  genres: MobyGenre[];
  platforms: MobyGamePlatform[];
  alternate_titles?: MobyAlternateTitle[];
}

interface MobyPlatform {
  platform_id: number;
  platform_name: string;
}

interface MobyCompany {
  company_id: number;
  company_name: string;
  role: string;
}

interface MobyRelease {
  companies: MobyCompany[];
  countries: string[];
  description: string | null;
  product_codes: string[];
  release_date: string | null;
}

interface MobyPlatformReleaseInfo {
  game_id: number;
  platform_id: number;
  platform_name: string;
  first_release_date: string | null;
  attributes: Array<{
    attribute_category_name: string;
    attribute_name: string;
  }>;
  patches: unknown[];
  ratings: unknown[];
  releases: MobyRelease[];
}

/* ------------------------------------------------------------------ */
/* HTTP layer                                                          */
/* ------------------------------------------------------------------ */

function describeApiError(status: number, body: MobyApiError | null): string {
  const apiMessage =
    body && (body.message || body.error) ? `: ${body.error}${body.message ? ` — ${body.message}` : ""}` : "";
  switch (status) {
    case 400:
      return `MobyGames API rejected the request (400 Bad Request)${apiMessage}. A parameter had an invalid type (e.g. a string where an integer was expected).`;
    case 401:
      return (
        `MobyGames API authorization failed (401 Unauthorized)${apiMessage}. ` +
        "Your MOBYGAMES_API_KEY is missing or invalid. Double-check the key on your MobyPro API page."
      );
    case 404:
      return `MobyGames API returned 404 Not Found${apiMessage}. The requested game, platform, or resource does not exist.`;
    case 422:
      return `MobyGames API could not process the parameters (422)${apiMessage}.`;
    case 429:
      return (
        `MobyGames API rate limit exceeded (429)${apiMessage}. ` +
        "Non-commercial keys are limited to 720 requests/hour and at most 1 request/second. Wait and retry."
      );
    default:
      return `MobyGames API request failed with HTTP ${status}${apiMessage}.`;
  }
}

let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = REQUEST_GAP_MS - (now - lastRequestAt);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
}

/**
 * GET a path on the MobyGames API, appending the api_key query parameter.
 * All values (including the key) are URL-encoded per the API docs.
 */
async function mobyGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(API_BASE + path);
  url.searchParams.set("api_key", API_KEY);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  await throttle();
  const response = await fetch(url.toString());
  if (!response.ok) {
    let body: MobyApiError | null = null;
    try {
      body = (await response.json()) as MobyApiError;
    } catch {
      body = null;
    }
    throw new Error(describeApiError(response.status, body));
  }
  return (await response.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Extract the year (YYYY) from a MobyGames release date string like "1998", "1998-06", or "1998-06-15". */
function yearOf(date: string | null): number | null {
  if (!date) return null;
  const match = /^(\d{4})/.exec(date);
  return match ? parseInt(match[1], 10) : null;
}

/** Earliest release year across a game's platform list, or null if unknown. */
function firstReleaseYear(game: MobyGame): number | null {
  const years = game.platforms
    .map((p) => yearOf(p.first_release_date))
    .filter((y): y is number => y !== null);
  return years.length > 0 ? Math.min(...years) : null;
}

let platformCache: MobyPlatform[] | null = null;

async function listPlatforms(): Promise<MobyPlatform[]> {
  if (!platformCache) {
    const data = await mobyGet<{ platforms: MobyPlatform[] }>("/platforms");
    platformCache = data.platforms ?? [];
  }
  return platformCache;
}

/**
 * Resolve a user-supplied platform filter (name or numeric ID) to a platform ID.
 * Throws a clear error if the name does not match any known platform.
 */
async function resolvePlatformId(platform: string): Promise<number> {
  const trimmed = platform.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  const platforms = await listPlatforms();
  const lower = trimmed.toLowerCase();
  const exact = platforms.find((p) => p.platform_name.toLowerCase() === lower);
  if (exact) return exact.platform_id;
  const matches = platforms.filter((p) => p.platform_name.toLowerCase().includes(lower));
  if (matches.length === 1) return matches[0].platform_id;
  if (matches.length > 1) {
    const names = matches
      .slice(0, 8)
      .map((p) => `${p.platform_name} (${p.platform_id})`)
      .join(", ");
    throw new Error(
      `Platform "${platform}" is ambiguous — it matches: ${names}${matches.length > 8 ? ", …" : ""}. ` +
        "Use one of the listed platform IDs."
    );
  }
  throw new Error(
    `Unknown platform "${platform}". Use the get_platforms tool to see the list of valid platforms.`
  );
}

/* ------------------------------------------------------------------ */
/* MCP server                                                          */
/* ------------------------------------------------------------------ */

const server = new McpServer({
  name: "mobygames-mcp",
  version: "1.0.0",
});

server.registerTool(
  "search_games",
  {
    title: "Search MobyGames games",
    description:
      "Search the MobyGames database for games by title substring (case-insensitive). " +
      "Optionally filter to games released on a specific platform (platform name or ID). " +
      "Returns game IDs, titles, earliest release year, platforms, and Moby scores.",
    inputSchema: {
      title: z
        .string()
        .min(1, "title must not be empty")
        .max(128, "title filter must be 128 characters or fewer")
        .describe("Substring of the game title to search for (case-insensitive)."),
      platform: z
        .string()
        .optional()
        .describe(
          "Optional platform filter: a platform name (e.g. \"Windows\", \"PlayStation\") or numeric platform ID. " +
            "Use get_platforms to discover platform names/IDs."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("Maximum number of results to return (1–100, default 10)."),
    },
  },
  async ({ title, platform, limit }) => {
    const params: Record<string, string> = {
      title: title.trim(),
      format: "normal",
      limit: String(limit),
    };
    if (platform) {
      params.platform = String(await resolvePlatformId(platform));
    }
    const data = await mobyGet<{ games: MobyGame[] }>("/games", params);
    const games = data.games ?? [];
    if (games.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No games found matching title "${title}"${platform ? ` on platform "${platform}"` : ""}.`,
          },
        ],
      };
    }
    const results = games.map((game) => ({
      game_id: game.game_id,
      title: game.title,
      year: firstReleaseYear(game),
      platforms: game.platforms.map((p) => p.platform_name),
      moby_score: game.moby_score,
      num_votes: game.num_votes,
      moby_url: game.moby_url,
    }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: results.length, results }, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "get_game_details",
  {
    title: "Get MobyGames game details",
    description:
      "Fetch full details for a single MobyGames game by its numeric game_id " +
      "(get game_ids from search_games): description, genres, platforms, releases, " +
      "companies (developers/publishers by role), and rating info (Moby score, vote count).",
    inputSchema: {
      game_id: z
        .number()
        .int()
        .positive()
        .describe("The numeric MobyGames game ID (e.g. 1)."),
    },
  },
  async ({ game_id }) => {
    // Convenience endpoint; equivalent to /games?id=<game_id>&format=normal.
    const game = await mobyGet<MobyGame>(`/games/${game_id}`, { format: "normal" });

    // Release/company info lives per platform; fetch each platform's release info.
    const platformsInfo = await mobyGet<{ platforms: MobyGamePlatform[] }>(`/games/${game_id}/platforms`);
    const releaseDetails: Array<{
      platform_id: number;
      platform_name: string;
      first_release_date: string | null;
      releases: MobyRelease[];
    }> = [];
    const companiesByRole: Record<string, string[]> = {};
    for (const p of platformsInfo.platforms ?? []) {
      const info = await mobyGet<MobyPlatformReleaseInfo>(`/games/${game_id}/platforms/${p.platform_id}`);
      releaseDetails.push({
        platform_id: p.platform_id,
        platform_name: p.platform_name,
        first_release_date: p.first_release_date,
        releases: info.releases ?? [],
      });
      for (const release of info.releases ?? []) {
        for (const company of release.companies ?? []) {
          const list = (companiesByRole[company.role] ??= []);
          if (!list.includes(company.company_name)) {
            list.push(company.company_name);
          }
        }
      }
    }

    const details = {
      game_id: game.game_id,
      title: game.title,
      moby_url: game.moby_url,
      official_url: game.official_url,
      description: game.description,
      genres: (game.genres ?? []).map((g) => ({
        name: g.genre_name,
        category: g.genre_category,
      })),
      alternate_titles: (game.alternate_titles ?? []).map((t) => ({
        title: t.title,
        description: t.description,
      })),
      platforms: (platformsInfo.platforms ?? []).map((p) => ({
        platform_id: p.platform_id,
        platform_name: p.platform_name,
        first_release_date: p.first_release_date,
      })),
      companies_by_role: companiesByRole,
      releases: releaseDetails,
      rating: {
        moby_score: game.moby_score,
        num_votes: game.num_votes,
      },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    };
  }
);

server.registerTool(
  "get_platforms",
  {
    title: "List MobyGames platforms",
    description:
      "List all platforms known to MobyGames (e.g. Windows, DOS, PlayStation) with their numeric platform IDs. " +
      "Optionally filter by a name substring. Useful for finding the platform ID for search_games.",
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe("Optional case-insensitive substring to filter platform names (e.g. \"playstation\")."),
    },
  },
  async ({ name }) => {
    const platforms = await listPlatforms();
    const lower = name?.trim().toLowerCase();
    const filtered = lower ? platforms.filter((p) => p.platform_name.toLowerCase().includes(lower)) : platforms;
    if (filtered.length === 0) {
      return {
        content: [{ type: "text", text: `No platforms found matching "${name}".` }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: filtered.length, platforms: filtered }, null, 2),
        },
      ],
    };
  }
);

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("mobygames-mcp failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
