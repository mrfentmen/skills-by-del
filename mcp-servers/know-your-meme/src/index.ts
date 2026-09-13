#!/usr/bin/env node
/**
 * Know Your Meme MCP server.
 *
 * Scrapes PUBLIC Know Your Meme pages (no API key needed):
 *  - search_memes      -> search KYM and list matching meme entries
 *  - get_meme_details  -> fetch one meme entry page and extract its details
 *
 * Scraping is kept polite: a descriptive User-Agent, sequential requests with
 * a minimum delay between them, and graceful handling of HTTP errors.
 *
 * NOTE: The HTML selectors below are provisional best-effort candidates. Live
 * page inspection was not possible in the build environment, so they MUST be
 * verified against real knowyourmeme.com pages before trusting the output.
 * Extraction leans on standard, stable signals first (Open Graph meta tags,
 * JSON-LD article data, <h1>/<h2> headings), with site-specific class names
 * only as fallbacks.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

type Selection = cheerio.Cheerio<AnyNode>;

const BASE_URL = "https://knowyourmeme.com";
const USER_AGENT =
  "KnowYourMemeMCP/0.1.0 (MCP research tool; polite scraper, 1 req at a time)";
const MIN_DELAY_MS = 800; // minimum gap between outgoing requests
const MAX_SEARCH_RESULTS = 25;

let lastRequestAt = 0;

async function politeWait(): Promise<void> {
  const now = Date.now();
  const waitFor = MIN_DELAY_MS - (now - lastRequestAt);
  if (waitFor > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitFor));
  }
  lastRequestAt = Date.now();
}

/** Fetch a Know Your Meme page. Refuses any other host. */
async function fetchKymPage(pathOrUrl: string): Promise<string> {
  const url = new URL(pathOrUrl, BASE_URL);
  if (url.hostname !== "knowyourmeme.com" && url.hostname !== "www.knowyourmeme.com") {
    throw new Error(`Refusing to fetch non-KnowYourMeme host: ${url.hostname}`);
  }
  await politeWait();
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
  } catch (err) {
    throw new Error(
      `Network error fetching ${url.pathname}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (res.status === 404) {
    throw new Error(`Page not found (HTTP 404): ${url.toString()}`);
  }
  if (res.status === 429) {
    throw new Error(
      `Rate limited by Know Your Meme (HTTP 429). Wait a while and try again.`
    );
  }
  if (!res.ok) {
    throw new Error(`Know Your Meme returned HTTP ${res.status} for ${url.toString()}`);
  }
  return res.text();
}

function cleanText(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

function stripSiteSuffix(title: string | null): string | null {
  if (!title) return null;
  return cleanText(title.replace(/\s*[|\-–—]\s*Know Your Meme.*$/i, ""));
}

function findYear(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/\b((?:19|20)\d{2})\b/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// search_memes
// ---------------------------------------------------------------------------

export interface SearchResult {
  name: string;
  url: string;
  year: string | null;
  snippet: string | null;
}

export function parseSearchResults(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Try container-specific selectors first, then fall back to any /memes/ link.
  const candidates = [
    "a.entry-grid-item",
    ".search-results a[href^='/memes/']",
    ".results a[href^='/memes/']",
    "a[href^='/memes/']",
  ];

  let anchors: Selection | null = null;
  for (const sel of candidates) {
    const found = $(sel);
    if (found.length > 0) {
      anchors = found;
      break;
    }
  }
  if (!anchors) return results;

  anchors.each((_i, el) => {
    if (results.length >= limit) return false;
    const a = $(el);
    const href = a.attr("href");
    if (!href || !href.startsWith("/memes/")) return;
    const absolute = new URL(href, BASE_URL).toString();
    if (seen.has(absolute)) return;
    seen.add(absolute);

    const imgAlt = cleanText(a.find("img").first().attr("alt"));
    const titleAttr = cleanText(a.attr("title"));
    const anchorText = cleanText(a.text());
    const name = imgAlt ?? titleAttr ?? anchorText;
    if (!name) return;

    // Snippet: prefer an explicit description element near the link.
    const card = a.closest("div, li, article");
    const snippet =
      titleAttr ??
      cleanText(card.find("p").first().text()) ??
      null;

    // Year: only when a 4-digit year appears in the card text; else null.
    const year = findYear(card.text());

    results.push({ name, url: absolute, year, snippet });
    return undefined;
  });

  return results;
}

// ---------------------------------------------------------------------------
// get_meme_details
// ---------------------------------------------------------------------------

export interface MemeDetails {
  name: string | null;
  url: string;
  year: string | null;
  summary: string | null;
  origin: string | null;
  meaning: string | null;
  spread: string | null;
  examples: string | null;
  tags: string[];
}

interface JsonLdArticle {
  headline?: string;
  datePublished?: string;
  keywords?: string | string[];
}

function extractJsonLd($: cheerio.CheerioAPI): JsonLdArticle | null {
  let found: JsonLdArticle | null = null;
  $("script[type='application/ld+json']").each((_i, el) => {
    if (found) return;
    try {
      const raw = $(el).text();
      const parsed: unknown = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (
          item &&
          typeof item === "object" &&
          "@type" in item &&
          typeof (item as Record<string, unknown>)["@type"] === "string" &&
          /article/i.test(String((item as Record<string, unknown>)["@type"]))
        ) {
          found = item as JsonLdArticle;
          break;
        }
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  });
  return found;
}

/** Collect paragraphs under each h2/h3 heading inside the entry body. */
function extractSections(
  $: cheerio.CheerioAPI,
  body: Selection
): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current && buffer.length > 0) {
      sections.set(current, buffer.join("\n\n"));
    }
    buffer = [];
  };

  body.find("h2, h3").each((_i, el) => {
    flush();
    current = cleanText($(el).text())?.toLowerCase() ?? null;
    // Walk following siblings until the next heading.
    let node: Selection | null = $(el).next();
    while (node && node.length > 0 && !/^h[23]$/i.test(node.prop("tagName") ?? "")) {
      const tag = (node.prop("tagName") ?? "").toLowerCase();
      if (tag === "p" || tag === "li" || tag === "blockquote") {
        const t = cleanText(node.text());
        if (t) buffer.push(t);
      }
      node = node.next();
    }
    flush();
    current = null;
  });

  return sections;
}

function pickSection(sections: Map<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    for (const [heading, text] of sections) {
      if (heading.includes(key)) return text;
    }
  }
  return null;
}

export function parseMemeDetails(html: string, pageUrl: string): MemeDetails {
  const $ = cheerio.load(html);

  // Name: Open Graph title first (stable), then <h1>.
  const ogTitle = cleanText($("meta[property='og:title']").attr("content"));
  const h1 = cleanText($("h1").first().text());
  const name = stripSiteSuffix(ogTitle) ?? h1;

  const ogDescription = cleanText($("meta[property='og:description']").attr("content"));
  const ld = extractJsonLd($);

  // Entry body: try likely containers, fall back to <article>, then <main>.
  const bodyCandidates = ["#entry-body", ".entry-body", "article .body", "article", "main"];
  let body: Selection | null = null;
  for (const sel of bodyCandidates) {
    const found = $(sel).first();
    if (found.length > 0 && cleanText(found.text())?.length) {
      body = found;
      break;
    }
  }

  const paragraphs: string[] = [];
  if (body) {
    body.find("p").each((_i, el) => {
      const t = cleanText($(el).text());
      if (t && t.length > 40) paragraphs.push(t);
    });
  }

  const sections = body ? extractSections($, body) : new Map<string, string>();
  const origin = pickSection(sections, "origin");
  const spread = pickSection(sections, "spread");
  const examples = pickSection(sections, "example", "notable");

  // "Meaning" on KYM is conveyed by the opening description paragraph.
  const summary = paragraphs[0] ?? ogDescription;
  const meaning = summary;

  // Year: prefer structured publish date, else first year in the intro text.
  const year =
    findYear(ld?.datePublished) ??
    findYear($("meta[property='article:published_time']").attr("content")) ??
    findYear(summary);

  // Tags: JSON-LD keywords, meta keywords, and rel="tag" links.
  const tagSet = new Set<string>();
  const addTag = (t: string | null | undefined) => {
    const c = cleanText(t);
    if (c) tagSet.add(c);
  };
  if (ld?.keywords) {
    const kws = Array.isArray(ld.keywords) ? ld.keywords : ld.keywords.split(",");
    kws.forEach(addTag);
  }
  $("meta[name='keywords']").attr("content")?.split(",").forEach(addTag);
  $("a[rel='tag']").each((_i, el) => addTag($(el).text()));

  return {
    name,
    url: pageUrl,
    year,
    summary,
    origin,
    meaning,
    spread,
    examples,
    tags: [...tagSet].slice(0, 50),
  };
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "know-your-meme", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_memes",
      description:
        "Search Know Your Meme for a meme by keyword. Returns matching entries with name, URL, year (when shown on the result card), and a short snippet.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keywords, e.g. 'distracted boyfriend'" },
          limit: {
            type: "integer",
            description: "Max results to return (1-25).",
            minimum: 1,
            maximum: MAX_SEARCH_RESULTS,
            default: 10,
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_meme_details",
      description:
        "Fetch a Know Your Meme entry page and extract the meme's name, year, summary/meaning, origin, spread, examples, and tags.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Full Know Your Meme entry URL, e.g. https://knowyourmeme.com/memes/distracted-boyfriend",
          },
        },
        required: ["url"],
      },
    },
  ],
}));

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    if (name === "search_memes") {
      const query = a.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        return errorResult("Parameter 'query' is required and must be a non-empty string.");
      }
      let limit = 10;
      if (a.limit !== undefined) {
        if (typeof a.limit !== "number" || !Number.isInteger(a.limit)) {
          return errorResult("Parameter 'limit' must be an integer.");
        }
        limit = Math.min(Math.max(a.limit, 1), MAX_SEARCH_RESULTS);
      }
      const html = await fetchKymPage(`/search?query=${encodeURIComponent(query.trim())}`);
      const results = parseSearchResults(html, limit);
      return textResult(JSON.stringify({ query: query.trim(), results }, null, 2));
    }

    if (name === "get_meme_details") {
      const url = a.url;
      if (typeof url !== "string" || url.trim().length === 0) {
        return errorResult("Parameter 'url' is required and must be a non-empty string.");
      }
      const normalized = new URL(url.trim(), BASE_URL).toString();
      const html = await fetchKymPage(normalized);
      const details = parseMemeDetails(html, normalized);
      return textResult(JSON.stringify(details, null, 2));
    }

    return errorResult(`Unknown tool: ${name}`);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
});

import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only auto-start when executed directly (npm start / bin), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
