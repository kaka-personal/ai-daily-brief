import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

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
    headers: { "user-agent": "Mozilla/5.0 (compatible; ai-daily-brief/1.0; +github actions)" },
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
    .replace(/<[^>]+>/g, " ") // entity-escaped HTML (Atom type="html") becomes tags only after unescaping
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

// Stage 1: pick stories and assign each to a fixed section (from sources.json).
// The model only returns section and item numbers, so every story keeps its real links and lands in a known section.
const PLAN_PROMPT = `You are the editor of a daily AI news brief for software engineers. You receive numbered news items.
Select the noteworthy AI stories and assign each one to a section. Reply with JSON only, no Markdown fences:
{"stories":[{"section":0,"title":"...","items":[1,4]}]}

Sections (use the number in "section"):
${config.sections.map((s, i) => `${i}. ${s}`).join("\n")}

Rules:
- Section 0 holds the 3 to 5 most important stories of the day. Put every other story into the one section that fits it best.
- A section can hold any number of stories. Leaving a section empty is fine; never merge stories to fill a section.
- A story is exactly one event. "items" lists the numbers of the input items that report that same event; only merge items when they cover the same event. Unrelated items are always separate stories.
- Each story appears once in the whole brief.
- When stories already in today's brief are listed, skip items about those events, and add to section 0 only as many stories as it has room for.
- "title" is a short Simplified Chinese headline. Keep product and model names in their original language.
- Drop marketing fluff, duplicates and items unrelated to AI.`;

// Stage 2: write one story from its source material (the fetched article when available).
const DETAIL_PROMPT = `You write one entry of a daily AI news brief in Simplified Chinese. You receive a headline and its source material.
Reply with JSON only, no Markdown fences:
{"summary":"...","points":["...","..."],"why":"..."}

- summary: one sentence, at most 60 Chinese characters.
- points: 3 to 5 key facts from the source material, one sentence each.
- why: one or two sentences on why it matters to software engineers.
- Only use facts found in the source material. Do not invent numbers, names or quotes. If the material is thin, write fewer points.
- Keep product and model names in their original language.`;

const ARTICLE_CHARS = 6000;
const MIN_FEED_CHARS = 150;

async function chat(system, user) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required (or pass --no-ai)");
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  const text = (await res.json()).choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM API returned an empty response");
  return text;
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Model did not return JSON: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

async function mapLimit(list, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) await fn(list[next++]);
    }),
  );
}

// Best-effort readable text of an article page; returns "" when the page is blocked or too short.
async function fetchArticle(url) {
  try {
    const raw = await fetchText(url);
    // Page summaries in meta tags (arXiv puts the abstract in citation_abstract).
    const meta = ["citation_abstract", "og:description", "description"]
      .map((n) => raw.match(new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*content=["']([^"']+)`, "i"))?.[1])
      .find(Boolean);
    const html = raw.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
    const main = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] || html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] || html;
    const paras = (main.match(/<(p|blockquote)\b[\s\S]*?<\/\1>/gi) || []).map(decode).filter((p) => p.length > 40);
    const parts = [...new Set([meta && decode(meta), ...paras].filter(Boolean))];
    const text = (parts.length ? parts.join("\n") : decode(main)).slice(0, ARTICLE_CHARS);
    return text.length >= 300 ? text : "";
  } catch {
    return "";
  }
}

const toSource = (it) => ({ name: it.source, title: it.title, url: it.link });

// Plans stories from fresh items and appends them to today's sections; returns the added stories.
// Stories already in the brief are listed so the model skips events that are covered.
async function planStories(items, sections) {
  const list = items.map((it, i) => `${i + 1}. [${it.source}] ${it.title}\n   ${it.summary}`).join("\n");
  const covered = sections.flatMap((s, i) => s.stories.map((st) => `- [${i}] ${st.title}`));
  const context = covered.length
    ? `\n\nAlready in today's brief; skip items about these events. Section 0 has room for ${Math.max(0, 5 - sections[0].stories.length)} more stories:\n${covered.join("\n")}`
    : "";
  const plan = parseJson(await chat(PLAN_PROMPT, `News items:\n${list}${context}`));
  const added = [];
  for (const st of plan.stories || []) {
    const section = sections[st.section];
    const story = {
      title: String(st.title || "").trim(),
      // The model sometimes returns a bare number or numeric strings instead of an array.
      items: [...new Set([].concat(st.items ?? []).map(Number))].map((n) => items[n - 1]).filter(Boolean),
    };
    if (!section) console.warn(`[warn] unknown section ${st.section} for "${story.title}"`);
    else if (story.title && story.items.length) {
      section.stories.push(story);
      added.push(story);
    }
  }
  return added;
}

// Stage 2 for one story: fetch its articles, write the detail, and replace its items with sources.
async function writeDetail(st) {
  const texts = await Promise.all(st.items.map((it) => fetchArticle(it.link)));
  // A short feed summary (e.g. a Hacker News discussion link) is not material: writing from it would be guesswork.
  const bodies = st.items.map((it, i) => texts[i] || (it.summary.length >= MIN_FEED_CHARS ? it.summary : ""));
  const material = st.items
    .map((it, i) => bodies[i] && `Source ${i + 1}: [${it.source}] ${it.title}\n${bodies[i]}`)
    .filter(Boolean)
    .join("\n\n");
  st.basis = texts.some(Boolean) ? "article" : material ? "feed" : "none";
  Object.assign(st, { summary: "", points: [], why: "" });
  if (material) {
    try {
      const d = parseJson(await chat(DETAIL_PROMPT, `Headline: ${st.title}\n\n${material}`));
      st.summary = String(d.summary || "");
      st.points = Array.isArray(d.points) ? d.points.map(String).slice(0, 5) : [];
      st.why = String(d.why || "");
    } catch (e) {
      console.warn(`[warn] detail failed for "${st.title}": ${e.message}`);
    }
  }
  st.sources = st.items.map(toSource);
  delete st.items;
}

// --no-ai: every fresh item becomes a story in the first section.
function addRawStories(items, sections) {
  const added = items.map((it) => ({ title: it.title, summary: it.summary, points: [], why: "", basis: "feed", sources: [toSource(it)] }));
  sections[0].stories.push(...added);
  return added;
}

// Markdown for the Issue and for the no-JavaScript fallback of the site.
function toMarkdown(sections) {
  const esc = (s) => s.replace(/\|/g, "/");
  return sections
    .filter((s) => s.stories.length)
    .map((s) => `## ${esc(s.title)}\n\n` + s.stories
      .map((st) => `- **${esc(st.title)}**${st.summary ? `: ${esc(st.summary)}` : ""} ${st.sources.map((x) => `[source](${x.url})`).join(" · ")}`)
      .join("\n"))
    .join("\n\n");
}

// ---------- publishing ----------

// Updates today's open issue if one exists (manual reruns), otherwise creates it.
async function upsertIssue(title, body) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required to create an issue");
  const api = async (path, method = "GET", data) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: data && JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    return res.json();
  };

  const open = await api("/issues?state=open&per_page=50");
  const existing = open.find((i) => i.title === title && !i.pull_request);
  const issue = existing
    ? await api(`/issues/${existing.number}`, "PATCH", { body })
    : await api("/issues", "POST", { title, body });
  return `${existing ? "updated" : "created"} ${issue.html_url}`;
}

// Writes the page Markdown and its JSON data into docs/ for GitHub Pages.
// docs/_layouts/default.html renders the cards from data/<date>.json and lists the archive.
async function writeSite(date, title, body, brief) {
  const docs = new URL("../docs/", import.meta.url);
  const briefs = new URL("briefs/", docs);
  const data = new URL("data/", docs);
  await mkdir(briefs, { recursive: true });
  await mkdir(data, { recursive: true });
  const page = `---\ntitle: ${title}\nbrief_date: "${date}"\n---\n\n${body}\n`;
  await writeFile(new URL(`${date}.md`, briefs), page);
  await writeFile(new URL("index.md", docs), page);
  await writeFile(new URL(`${date}.json`, data), JSON.stringify(brief));
}

// ---------- main ----------

// Tells the workflow whether the site changed, so it can skip the Pages deploy.
async function setOutput(changed) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

const date = new Date().toLocaleDateString("sv-SE", { timeZone: TIME_ZONE });
const previous = await readFile(new URL(`../docs/data/${date}.json`, import.meta.url), "utf8").then(JSON.parse, () => null);
// Links already handled today (kept or dropped), so each item is planned only once.
// Source links of existing stories count too (data written before "seen" existed).
const seen = new Set([
  ...(previous?.seen || []),
  ...(previous?.sections || []).flatMap((s) => s.stories.flatMap((st) => st.sources.map((x) => x.url))),
]);
// Today's stories so far, in the current config order.
const sections = config.sections.map((title) => ({
  title,
  stories: previous?.sections.find((s) => s.title === title)?.stories || [],
}));

const items = await collect();
const fresh = items.filter((it) => !seen.has(it.link));
console.log(`Collected ${items.length} items since ${new Date(since).toISOString()}, ${fresh.length} new`);

if (fresh.length === 0) {
  console.log("Nothing new, skip.");
  await setOutput(false);
  process.exit(0);
}

const added = NO_AI ? addRawStories(fresh, sections) : await planStories(fresh, sections);
if (!NO_AI) await mapLimit(added, 4, writeDetail);
fresh.forEach((it) => seen.add(it.link));
const byBasis = (b) => added.filter((s) => s.basis === b).length;
console.log(`Added ${added.length} stories (article ${byBasis("article")}, feed ${byBasis("feed")}, none ${byBasis("none")})`);

const stories = sections.flatMap((s) => s.stories);
const time = new Date().toLocaleTimeString("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" });
const footer = `Generated by ai-daily-brief · ${stories.length} stories from ${seen.size} items · ${NO_AI ? "raw" : MODEL} · last update ${time}`;
const body = `${toMarkdown(sections)}\n\n---\n<sub>${footer}</sub>`;
const title = `AI Daily Brief ${date}`;

if (DRY_RUN) {
  console.log(`\n# ${title}\n\n${body}\n\n${JSON.stringify(added, null, 2)}`);
} else {
  // Always save "seen", even when nothing was added, so dropped items are not planned again.
  await writeSite(date, title, body, { date, footer, sections, seen: [...seen] });
  if (added.length) {
    console.log(`Site updated: docs/briefs/${date}.md`);
    console.log(`Issue ${await upsertIssue(title, body)}`);
  }
  await setOutput(added.length > 0);
}
