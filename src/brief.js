import { mkdir, readFile, writeFile } from "node:fs/promises";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const NO_AI = args.has("--no-ai");
const MODEL = process.env.OPENAI_MODEL || "gemini-3-flash-preview";
const BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const TIME_ZONE = process.env.BRIEF_TZ || "Asia/Shanghai";

const config = JSON.parse(await readFile(new URL("../sources.json", import.meta.url), "utf8"));
const since = Date.now() - config.lookbackHours * 3600 * 1000;

// ---------- fetching ----------

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "ai-daily-brief/1.0 (+github actions)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

// Minimal RSS 2.0 / Atom parser; good enough for well-formed news feeds.
function parseFeed(xml, source) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const atomLink = b.match(/<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/i) || b.match(/<link\b[^>]*href="([^"]+)"/i);
    const link = decode(tag(b, "link")) || (atomLink ? atomLink[1] : "");
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    return {
      source,
      title: decode(tag(b, "title")),
      link: link.trim(),
      time: Date.parse(decode(date)) || 0,
      summary: decode(tag(b, "description") || tag(b, "summary") || tag(b, "content")).slice(0, 300),
    };
  });
}

async function fetchFeeds() {
  const results = await Promise.allSettled(
    config.feeds.map(async (f) => parseFeed(await fetchText(f.url), f.name)),
  );
  return results.flatMap((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.warn(`[warn] ${config.feeds[i].name}: ${r.reason.message}`);
    return [];
  });
}

async function fetchHackerNews() {
  const { minPoints, keywords } = config.hackerNews;
  const re = new RegExp(`\\b(${keywords.join("|")})\\b`, "i");
  const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=200&numericFilters=created_at_i>${Math.floor(since / 1000)},points>=${minPoints}`;
  try {
    const data = JSON.parse(await fetchText(url));
    return data.hits
      .filter((h) => re.test(h.title))
      .map((h) => ({
        source: `Hacker News (${h.points} pts)`,
        title: h.title,
        link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        time: h.created_at_i * 1000,
        summary: `Discussion: https://news.ycombinator.com/item?id=${h.objectID}`,
      }));
  } catch (e) {
    console.warn(`[warn] Hacker News: ${e.message}`);
    return [];
  }
}

async function collect() {
  const all = [...(await fetchFeeds()), ...(await fetchHackerNews())];
  const seen = new Set();
  return all
    .filter((it) => it.title && it.link && it.time >= since)
    .filter((it) => !seen.has(it.link) && seen.add(it.link))
    .sort((a, b) => b.time - a.time)
    .slice(0, config.maxItems);
}

// ---------- summarizing ----------

const SYSTEM_PROMPT = `You are an editor producing a daily AI news brief for a software engineer.
Write the entire brief in Simplified Chinese, formatted as GitHub Markdown.

Structure:
1. "## 今日要点" - the 3 to 5 most important stories, one or two sentences each, explaining why they matter.
2. Then group the remaining noteworthy items under a few "##" topic headings (for example models and products, research, open source and tools, industry). Pick headings that fit the day's news; skip empty ones.
3. Each item is one bullet: a bold short Chinese title, a one-sentence summary, then the original link as [source](url).

Rules:
- Only use the items provided. Do not invent facts, numbers or links.
- Merge items that cover the same story into one bullet with multiple links, separated by " · ". Never use the "|" character anywhere, because it renders as a table.
- Drop marketing fluff, duplicates and items unrelated to AI.
- Keep product and model names in their original language.`;

async function summarize(items, date) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required (or pass --no-ai)");
  const list = items
    .map((it, i) => `${i + 1}. [${it.source}] ${it.title}\n   ${it.link}\n   ${it.summary}`)
    .join("\n");

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Date: ${date}\n\nItems collected in the last ${config.lookbackHours} hours:\n\n${list}` },
      ],
    }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  const text = (await res.json()).choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM API returned an empty response");
  return text;
}

function renderRaw(items) {
  return items.map((it) => `- **${it.title}** — ${it.source}\n  ${it.link}`).join("\n");
}

// ---------- publishing ----------

async function createIssue(title, body) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required to create an issue");
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return (await res.json()).html_url;
}

// Writes Markdown into docs/ for GitHub Pages (Jekyll renders it).
async function writeSite(date, title, body) {
  const docs = new URL("../docs/", import.meta.url);
  const briefs = new URL("briefs/", docs);
  await mkdir(briefs, { recursive: true });
  // The archive list is rendered by docs/_layouts/default.html.
  const page = `---\ntitle: ${title}\nbrief_date: "${date}"\n---\n\n${body}\n`;
  await writeFile(new URL(`${date}.md`, briefs), page);
  await writeFile(new URL("index.md", docs), page);
}

// ---------- main ----------

const date = new Date().toLocaleDateString("sv-SE", { timeZone: TIME_ZONE });
const items = await collect();
console.log(`Collected ${items.length} items since ${new Date(since).toISOString()}`);

if (items.length === 0) {
  console.log("Nothing new, skip.");
  process.exit(0);
}

const content = NO_AI ? renderRaw(items) : await summarize(items, date);
const body = `${content}\n\n---\n<sub>Generated by ai-daily-brief · ${items.length} items · ${NO_AI ? "raw" : MODEL}</sub>`;
const title = `AI Daily Brief ${date}`;

if (DRY_RUN) {
  console.log(`\n# ${title}\n\n${body}`);
} else {
  await writeSite(date, title, body);
  console.log(`Site updated: docs/briefs/${date}.md`);
  console.log(`Issue created: ${await createIssue(title, body)}`);
}
