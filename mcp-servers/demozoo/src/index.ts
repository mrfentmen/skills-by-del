#!/usr/bin/env node
/**
 * demozoo-mcp — MCP server for Demozoo (demozoo.org), the demoscene database.
 *
 * Uses Demozoo's public read-only JSON API (https://demozoo.org/api/v1/).
 * No API key needed. Requests are sequential, polite, and spaced out.
 *
 * Verified API facts (from real-world API consumers, since the official
 * docs site was unreachable at build time):
 *  - Base URL: https://demozoo.org/api/v1/
 *  - Append ?format=json — otherwise the API returns browsable HTML.
 *  - GET /productions/ — list. The ONLY real filter params are:
 *      title (EXACT, case-insensitive match — NOT a substring search),
 *      platform (numeric id), production_type (numeric id),
 *      supertype, page. Unknown params are silently IGNORED.
 *  - GET /productions/<id>/ — full detail for one production.
 *  - GET /parties/<id>/ — detail for one party (verified URL pattern).
 *  - GET /parties/ — paged party list (same Django REST framework
 *    pagination as productions: {count, next, previous, results}).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = "https://demozoo.org/api/v1";
const USER_AGENT =
  "demozoo-mcp/1.0.0 (+https://github.com/mrfentmen/skills-by-del)";
const REQUEST_GAP_MS = 1500; // stay polite: Demozoo asks crawlers for restraint

// Production type name -> numeric id, from the verified Defacto2 Go client
// constants for the Demozoo API (pkg.go.dev/github.com/Defacto2/server).
const PRODUCTION_TYPES: Record<string, number> = {
  demo: 1,
  "64k": 2,
  "64k intro": 2,
  "4k": 3,
  "4k intro": 3,
  intro: 4,
  diskmag: 5,
  "disk magazine": 5,
  tool: 6,
  musicdisk: 7,
  "music disk": 7,
  pack: 9,
  "production pack": 9,
  "40k": 10,
  "40k intro": 10,
  "chipmusic pack": 12,
  cracktro: 13,
  music: 14,
  "32b": 15,
  "32b intro": 15,
  "64b": 16,
  "64b intro": 16,
  "128b": 18,
  "128b intro": 18,
  "256b": 19,
  "256b intro": 19,
  "512b": 20,
  "512b intro": 20,
  "1k": 21,
  "1k intro": 21,
  "32k": 22,
  "32k intro": 22,
  game: 33,
  "16k": 35,
  "16k intro": 35,
  "2k": 37,
  "2k intro": 37,
  "100k": 39,
  "100k intro": 39,
  bbstro: 41,
  "8k": 43,
  "8k intro": 43,
  magazine: 47,
  textmag: 49,
  "text magazine": 49,
  "96k": 50,
  "96k intro": 50,
  bbsdoor: 53,
  "8b": 54,
  "8b intro": 54,
  "16b": 55,
  "16b intro": 55,
};

function resolveProductionType(
  input: number | string | undefined
): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "number" && Number.isInteger(input)) return input;
  const key = String(input).trim().toLowerCase();
  if (/^\d+$/.test(key)) return parseInt(key, 10);
  return PRODUCTION_TYPES[key];
}

// --- polite fetch -----------------------------------------------------------

let lastRequestAt = 0;

async function apiGet(path: string, params: Record<string, string> = {}) {
  const wait = REQUEST_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const url = new URL(API_BASE + path);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  lastRequestAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
  } catch (err) {
    throw new Error(
      `Network error reaching Demozoo API: ${(err as Error).message}`
    );
  }
  if (res.status === 404) throw new Error("Not found on Demozoo (HTTP 404).");
  if (res.status === 429)
    throw new Error("Demozoo rate-limited the request (HTTP 429) — try again later.");
  if (!res.ok)
    throw new Error(`Demozoo API error: HTTP ${res.status} ${res.statusText}.`);
  return res.json();
}

// --- defensive field mapping (API shapes evolve; never crash on them) -------

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function summarizeProduction(p: Record<string, unknown>) {
  const authors = asArray(p["author_nicks"] ?? p["authors"]).map((a) => {
    const r = (a as Record<string, unknown>)?.["releaser"] as
      | Record<string, unknown>
      | undefined;
    return {
      name: str((a as Record<string, unknown>)?.["name"]),
      releaser: r ? str(r["name"]) : null,
      releaser_is_group: r ? r["is_group"] === true : null,
    };
  });
  const out: Record<string, unknown> = {
    id: num(p["id"]),
    title: str(p["title"]),
    supertype: str(p["supertype"]),
    release_date: str(p["release_date"]),
    authors,
    demozoo_url: str(p["demozoo_url"]) ?? str(p["url"]),
  };
  const platforms = asArray(p["platforms"])
    .map((x) => str((x as Record<string, unknown>)?.["name"]))
    .filter((x): x is string => !!x);
  if (platforms.length) out["platforms"] = platforms;
  const types = asArray(p["types"])
    .map((x) => str((x as Record<string, unknown>)?.["name"]))
    .filter((x): x is string => !!x);
  if (types.length) out["types"] = types;
  const downloads = asArray(p["download_links"])
    .map((d) => ({
      url: str((d as Record<string, unknown>)?.["url"]),
      comment: str((d as Record<string, unknown>)?.["comment"]),
    }))
    .filter((d) => d.url);
  if (downloads.length) out["download_links"] = downloads;
  const screenshots = asArray(p["screenshots"])
    .map((s) =>
      str((s as Record<string, unknown>)?.["original_url"]) ??
      str((s as Record<string, unknown>)?.["url"])
    )
    .filter((x): x is string => !!x);
  if (screenshots.length) out["screenshots"] = screenshots;
  return out;
}

function summarizeParty(p: Record<string, unknown>) {
  return {
    id: num(p["id"]),
    name: str(p["name"]),
    start_date: str(p["start_date"]) ?? str(p["start_date_display"]),
    end_date: str(p["end_date"]) ?? str(p["end_date_display"]),
    location: str(p["location"]),
    country: str(p["country_code"]) ?? str(p["country"]),
    website: str(p["website"]),
    demozoo_url: str(p["demozoo_url"]) ?? str(p["url"]),
  };
}

function pagedResults(json: unknown): {
  count: number | null;
  results: Record<string, unknown>[];
} {
  if (Array.isArray(json)) return { count: json.length, results: json };
  const o = json as Record<string, unknown>;
  return {
    count: typeof o?.["count"] === "number" ? (o["count"] as number) : null,
    results: asArray(o?.["results"]) as Record<string, unknown>[],
  };
}

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}
function err(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

// --- server -----------------------------------------------------------------

const server = new McpServer({
  name: "demozoo-mcp",
  version: "1.0.0",
});

server.registerTool(
  "search_productions",
  {
    title: "Search Demozoo productions",
    description:
      "Search Demozoo's demoscene production database. IMPORTANT: the `title` filter is an EXACT, case-insensitive match — it is NOT a substring search (a limitation of Demozoo's API). For browsing, filter by platform id and/or production type instead, which returns paged results.",
    inputSchema: {
      title: z
        .string()
        .optional()
        .describe("Exact production title (case-insensitive). Not a substring search."),
      platform: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Numeric Demozoo platform id (e.g. 2 was used for a platform filter in Demozoo's own tracker)."),
      production_type: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe(
          "Production type: numeric id or name (" +
            Object.keys(PRODUCTION_TYPES)
              .filter((k) => !k.includes(" "))
              .join(", ") +
            ")."
        ),
      supertype: z
        .string()
        .optional()
        .describe("Supertype filter, e.g. 'production', 'graphics', 'music'."),
      page: z.number().int().min(1).default(1).describe("Result page number."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results to return from the fetched page."),
    },
  },
  async ({ title, platform, production_type, supertype, page, limit }) => {
    try {
      const typeId = resolveProductionType(production_type as number | string | undefined);
      if (production_type !== undefined && typeId === undefined) {
        return err(
          `Unknown production_type '${production_type}'. Use a numeric id or one of: ${Object.keys(
            PRODUCTION_TYPES
          )
            .filter((k) => !k.includes(" "))
            .join(", ")}.`
        );
      }
      const params: Record<string, string> = { page: String(page) };
      if (title) params["title"] = title;
      if (platform !== undefined) params["platform"] = String(platform);
      if (typeId !== undefined) params["production_type"] = String(typeId);
      if (supertype) params["supertype"] = supertype;
      const json = await apiGet("/productions/", params);
      const { count, results } = pagedResults(json);
      return ok({
        count,
        page,
        results: results.slice(0, limit).map(summarizeProduction),
      });
    } catch (e) {
      return err((e as Error).message);
    }
  }
);

server.registerTool(
  "get_production_details",
  {
    title: "Get Demozoo production details",
    description:
      "Get full details for one Demozoo production: title, type, platforms, release date, authors/groups, download links, screenshots, and its Demozoo page URL.",
    inputSchema: {
      id: z
        .union([z.number().int(), z.string()])
        .describe("Numeric Demozoo production id."),
    },
  },
  async ({ id }) => {
    try {
      const json = await apiGet(`/productions/${id}/`);
      return ok(summarizeProduction(json as Record<string, unknown>));
    } catch (e) {
      return err((e as Error).message);
    }
  }
);

server.registerTool(
  "list_parties",
  {
    title: "List Demozoo parties",
    description:
      "Browse Demozoo's demoparty database, paged (the API's default ordering).",
    inputSchema: {
      page: z.number().int().min(1).default(1).describe("Result page number."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results to return from the fetched page."),
    },
  },
  async ({ page, limit }) => {
    try {
      const json = await apiGet("/parties/", { page: String(page) });
      const { count, results } = pagedResults(json);
      return ok({
        count,
        page,
        results: results.slice(0, limit).map(summarizeParty),
      });
    } catch (e) {
      return err((e as Error).message);
    }
  }
);

server.registerTool(
  "get_party_details",
  {
    title: "Get Demozoo party details",
    description:
      "Get details for one demoparty: name, dates, location, website, and its Demozoo page URL.",
    inputSchema: {
      id: z.union([z.number().int(), z.string()]).describe("Numeric Demozoo party id."),
    },
  },
  async ({ id }) => {
    try {
      const json = await apiGet(`/parties/${id}/`);
      return ok(summarizeParty(json as Record<string, unknown>));
    } catch (e) {
      return err((e as Error).message);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("demozoo-mcp failed to start:", e);
  process.exit(1);
});
