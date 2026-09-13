#!/usr/bin/env node
/**
 * ifdb-mcp-server — Model Context Protocol server for the Interactive Fiction
 * Database (IFDB, https://ifdb.org).
 *
 * Exposes two tools:
 *   - search_games:      search IFDB by title/author/keyword, with optional sort
 *   - get_game_details:  full details for one game (description, ratings,
 *                        downloads, genres, play-online link, ...)
 *
 * IFDB has no public API and requires no API key, so this server reads the
 * public HTML pages and parses them with cheerio. Requests are sequential,
 * carry an identifying User-Agent, and are spaced out to be polite.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as cheerio from "cheerio";
import { z } from "zod";

const IFDB_BASE = "https://ifdb.org";
const USER_AGENT =
  "ifdb-mcp/1.0 (+https://ifdb.org; MCP server for the Interactive Fiction Database)";
const REQUEST_GAP_MS = 800;

let lastRequestAt = 0;

/** Polite sequential fetch of an IFDB page. */
async function fetchIfdbPage(url: string): Promise<string> {
  const now = Date.now();
  const wait = REQUEST_GAP_MS - (now - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
      },
    });
  } catch (err) {
    throw new Error(
      `Network error fetching IFDB: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    lastRequestAt = Date.now();
  }

  if (!res.ok) {
    throw new Error(`IFDB returned HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

/** Parse a star label like "4 Stars out of 5" or "2½ Stars out of 5". */
function parseStarLabel(label: string | undefined): number | null {
  if (!label) return null;
  const m = label.match(/(\d+(?:\.\d+)?)(½)?\s*Stars?/i);
  if (!m) return null;
  return parseFloat(m[1]) + (m[2] ? 0.5 : 0);
}

/** Parse "(33 ratings)" / "33 ratings" / "(1 rating)" into a count. */
function parseRatingCount(text: string): number | null {
  const m = text.match(/\((\d+)\s+ratings?\)/i) ?? text.match(/(\d+)\s+ratings?\b/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Normalize user input (bare id, relative path, or full URL) to a TUID. */
function normalizeGameId(input: string): string {
  const trimmed = input.trim();
  const idMatch = trimmed.match(/viewgame\?id=([A-Za-z0-9]+)/i);
  const id = idMatch ? idMatch[1] : trimmed;
  if (!/^[A-Za-z0-9]+$/.test(id)) {
    throw new Error(
      `Invalid game id "${input}". Expected a TUID like "4gxk83ja4twckm6j" or an IFDB URL like https://ifdb.org/viewgame?id=4gxk83ja4twckm6j`
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// search_games
// ---------------------------------------------------------------------------

const SORT_OPTIONS = {
  relevance: "rel",
  title: "ttl",
  author: "auth",
  newest: "new",
  oldest: "old",
  highest_rated: "ratu",
  lowest_rated: "ratd",
  most_ratings: "rcu",
  fewest_ratings: "rcd",
  longest: "long",
  shortest: "short",
  random: "rand",
} as const;

interface SearchResult {
  id: string;
  title: string;
  authors: string;
  year: string | null;
  averageStars: number | null;
  ratingCount: number | null;
  url: string;
}

function parseSearchResults(html: string): { total: number; results: SearchResult[] } {
  const $ = cheerio.load(html);

  let total = 0;
  const countText = $("div.search__rowcnt").first().text();
  const countMatch = countText.match(/(\d+)\s+results?\s+found/i);
  if (countMatch) total = parseInt(countMatch[1], 10);

  const results: SearchResult[] = [];
  $("article.grid").each((_, el) => {
    const $el = $(el);
    const link = $el.find("h3.result a").first();
    const href = link.attr("href") ?? "";
    const idMatch = href.match(/viewgame\?id=([A-Za-z0-9]+)/i);
    if (!idMatch) return;
    const id = idMatch[1];
    const title = link.text().trim();

    // Byline structure inside the article: h3, then a text node "by AUTHORS",
    // then span.details (year), then span[role=img] (stars), then span.details
    // holding "(N ratings)". Walk the child nodes of the result div directly
    // instead of regexing serialized HTML.
    const bodyDiv = $el.find("h3.result").parent();
    let authors = "";
    let year: string | null = null;
    bodyDiv.contents().each((_, node) => {
      if (node.type === "text") {
        const t = $(node).text().trim();
        if (/^by\s+/i.test(t)) authors = t.replace(/^by\s+/i, "").trim();
      } else if (node.type === "tag" && node.tagName === "span") {
        const cls = $(node).attr("class") ?? "";
        if (cls.includes("details")) {
          const t = $(node).text().trim();
          if (/^\d{4}/.test(t) && !year) year = t;
        }
      }
    });

    const starSpan = $el.find("span[role='img'][aria-label]").first();
    const averageStars = parseStarLabel(starSpan.attr("aria-label"));

    const ratingCount = parseRatingCount($el.text());

    results.push({
      id,
      title,
      authors,
      year,
      averageStars,
      ratingCount,
      url: `${IFDB_BASE}/viewgame?id=${id}`,
    });
  });

  return { total, results };
}

// ---------------------------------------------------------------------------
// get_game_details
// ---------------------------------------------------------------------------

interface DownloadLink {
  name: string;
  url: string;
  notes: string | null;
}

interface GameDetails {
  id: string;
  url: string;
  title: string;
  authors: string;
  year: string | null;
  genres: string[];
  devSystem: string | null;
  description: string | null;
  averageStars: number | null;
  ratingCount: number | null;
  ratingHistogram: Record<string, number>;
  reviewCount: number | null;
  playedByCount: number | null;
  wishlistCount: number | null;
  downloads: DownloadLink[];
  playOnlineUrl: string | null;
}

function parseGameDetails(html: string, id: string): GameDetails {
  const $ = cheerio.load(html);
  const url = `${IFDB_BASE}/viewgame?id=${id}`;

  const header = $("#viewgame__header");

  const title = header.find("h1").first().text().trim();

  const byline = header.find("b").first().text().trim();
  const authors = byline.replace(/^by\s+/i, "").trim();

  // Header details block: year, genre links, dev system text lines, then the
  // external-links anchor div (excluded from the metadata walk).
  let year: string | null = null;
  const genres: string[] = [];
  let devSystem: string | null = null;
  const detailsDiv = header.find("div.details").first().clone();
  detailsDiv.find(".viewgame__externalLinksAnchor").remove();
  detailsDiv.contents().each((_, node) => {
    if (node.type === "text") {
      const t = $(node).text().trim();
      // Skip empty nodes and pure punctuation separators (e.g. ", " between
      // genre links) so they are not mistaken for the dev-system line.
      if (!t || /^[\s,;|–—-]+$/.test(t)) return;
      if (!year && /^\d{4}/.test(t)) {
        year = t;
      } else if (!devSystem && t.length < 60) {
        devSystem = t;
      }
    } else if (node.type === "tag" && node.tagName === "a") {
      const href = $(node).attr("href") ?? "";
      if (/search\?searchfor=genre:/i.test(href)) {
        genres.push($(node).text().trim());
      }
    }
  });

  // "About the Story" section holds the game description.
  let description: string | null = null;
  const aboutHeading = $("h3").filter((_, el) => $(el).text().trim() === "About the Story").first();
  if (aboutHeading.length) {
    const descText = aboutHeading.next("div.readMore").find("p").first().text().trim();
    if (descText) description = descText;
  }

  // Rating summary sits right after the header section. Note: HTML parsing
  // auto-closes <p> before a <div>, so the summary div is a sibling of the
  // (empty) <p>, not a child — walk forward to the first div.details.
  const headerSection = $("#viewgame__header").closest("section");
  let summaryDetails = headerSection.nextAll("div.details").first();
  const averageStars = parseStarLabel(
    summaryDetails.find("span[role='img'][aria-label]").first().attr("aria-label")
  );
  let ratingCount: number | null = null;
  const ratingsLink = summaryDetails.find('a[href*="&ratings"]').first();
  if (ratingsLink.length) ratingCount = parseRatingCount(ratingsLink.text());
  if (ratingCount === null) ratingCount = parseRatingCount(summaryDetails.text());

  const ratingHistogram: Record<string, number> = {};
  $("table.ratingHistogram tr").each((_, row) => {
    const cells = $(row).find("td");
    const starLabel = $(cells[0]).text().trim();
    const countText = $(cells[cells.length - 1]).text();
    const starMatch = starLabel.match(/(\d+)\s*star/i);
    const countMatch = countText.match(/\((\d+)\)/);
    if (starMatch && countMatch) {
      ratingHistogram[`${starMatch[1]}-star`] = parseInt(countMatch[1], 10);
    }
  });

  let reviewCount: number | null = null;
  const reviewsLink = $(`a[href="viewgame?id=${id}&reviews"]`).first();
  if (reviewsLink.length) {
    const m = reviewsLink.text().match(/(\d+)\s+reviews?/i);
    if (m) reviewCount = parseInt(m[1], 10);
  }

  const playedText = $("#playlistCount").first().text();
  const playedByCount = (() => {
    const m = playedText.match(/(\d+)\s+members?/i);
    return m ? parseInt(m[1], 10) : null;
  })();
  const wishlistText = $("#wishlistCount").first().text();
  const wishlistCount = (() => {
    const m = wishlistText.match(/(\d+)\s+wishlists?/i);
    return m ? parseInt(m[1], 10) : null;
  })();

  const downloads: DownloadLink[] = [];
  $("#externalLinks ul.downloadlist li").each((_, li) => {
    const item = $(li).find("div.downloaditem").first();
    if (!item.length) return;
    const linkEl = item.find("a[href]").first();
    const dlUrl = linkEl.attr("href") ?? "";
    const name = item.find("b").first().text().trim() || linkEl.text().trim();
    const notesRaw = item.find("span.dlnotes").first().text().trim();
    if (!dlUrl) return;
    downloads.push({ name, url: dlUrl, notes: notesRaw || null });
  });

  const playOnlineUrl = $("a.viewgame__playOnline").first().attr("href") ?? null;

  return {
    id,
    url,
    title,
    authors,
    year,
    genres,
    devSystem,
    description,
    averageStars,
    ratingCount,
    ratingHistogram,
    reviewCount,
    playedByCount,
    wishlistCount,
    downloads,
    playOnlineUrl,
  };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "ifdb-mcp-server",
  version: "1.0.0",
});

server.registerTool(
  "search_games",
  {
    title: "Search IFDB games",
    description:
      "Search the Interactive Fiction Database (IFDB) for text adventure games by title, author, or keyword. Returns matching games with title, authors, year, average star rating, rating count, and IFDB URL. No API key needed.",
    inputSchema: {
      query: z.string().min(1).describe("Search query: game title, author, or keyword."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results to return (1-50)."),
      sort: z
        .enum(Object.keys(SORT_OPTIONS) as [keyof typeof SORT_OPTIONS, ...Array<keyof typeof SORT_OPTIONS>])
        .default("relevance")
        .describe(
          "Result order: relevance, title, author, newest, oldest, highest_rated, lowest_rated, most_ratings, fewest_ratings, longest, shortest, random."
        ),
    },
  },
  async ({ query, limit, sort }) => {
    const params = new URLSearchParams({ searchfor: query });
    if (sort !== "relevance") params.set("sortby", SORT_OPTIONS[sort]);
    const html = await fetchIfdbPage(`${IFDB_BASE}/search?${params.toString()}`);
    const { total, results } = parseSearchResults(html);
    const payload = {
      query,
      sort,
      totalResults: total,
      returned: Math.min(limit, results.length),
      results: results.slice(0, limit),
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  }
);

server.registerTool(
  "get_game_details",
  {
    title: "Get IFDB game details",
    description:
      "Fetch full details for one IFDB game: description, authors, year, genres, development system, average star rating, rating histogram, review/play/wishlist counts, download links, and a play-in-browser link. Accepts an IFDB game URL, a relative 'viewgame?id=...' path, or a bare game TUID. No API key needed.",
    inputSchema: {
      game: z
        .string()
        .min(1)
        .describe(
          "Game identifier: full IFDB URL (https://ifdb.org/viewgame?id=...), relative path (viewgame?id=...), or bare TUID (e.g. 4gxk83ja4twckm6j)."
        ),
    },
  },
  async ({ game }) => {
    const id = normalizeGameId(game);
    const html = await fetchIfdbPage(`${IFDB_BASE}/viewgame?id=${id}`);
    const details = parseGameDetails(html, id);
    if (!details.title) {
      throw new Error(`No game found at ${IFDB_BASE}/viewgame?id=${id} (the page had no title).`);
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("ifdb-mcp-server failed:", err);
  process.exit(1);
});
