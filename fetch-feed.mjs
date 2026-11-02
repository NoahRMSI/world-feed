// Builds feed.json from disaster feeds, trade RSS, and Google News searches.
// Node 20+, no dependencies. Every source fails independently.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA = "WorldFeed/1.0 (personal news display)";
const ALERT_RANK = { green: 0, orange: 1, red: 2 };

// ---------- helpers ----------
export const decode = (s = "") =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};

export function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks.map(b => ({
    title: tag(b, "title"),
    link: tag(b, "link") || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "",
    date: new Date(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")),
    country: tag(b, "gdacs:country"),
    eventType: tag(b, "gdacs:eventtype"),
    alert: tag(b, "gdacs:alertlevel"),
  })).filter(i => i.title && !isNaN(i.date));
}

export function ago(date, now = Date.now()) {
  const m = Math.max(0, Math.round((now - date) / 60000));
  if (m < 60) return `${Math.max(m, 1)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

const gnews = q =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-GB&gl=GB&ceid=GB:en`;

// Google News titles look like "Headline - Publisher"
function splitSource(title, fallback) {
  const i = title.lastIndexOf(" - ");
  return i > 20 ? { title: title.slice(0, i), source: title.slice(i + 3) } : { title, source: fallback };
}

const FESTIVAL = /festival|glastonbury|coachella|lineup|line-up|headliner/i;
const ACTOR = /\b(cast|casts|casting|joins|stars?|to star|lead role|actor|actress)\b/i;
function classify(cat, title) {
  if (cat === "music") return FESTIVAL.test(title) ? "festival" : "artist";
  if (cat === "film") return ACTOR.test(title) ? "actor" : "film";
  return cat;
}

// ---------- sources ----------
async function gdacs(cfg) {
  const items = parseFeed(await get("https://www.gdacs.org/xml/rss.xml"));
  const min = ALERT_RANK[(cfg.gdacsMinAlert || "green").toLowerCase()] ?? 0;
  return items
    .filter(i => ["TC", "FL", "WF", "VO", "DR"].includes(i.eventType.toUpperCase()))
    .filter(i => (ALERT_RANK[i.alert.toLowerCase()] ?? 0) >= min)
    .map(i => ({ cat: "weather", title: i.title, source: "GDACS", place: i.country || "Worldwide", date: i.date, link: i.link }));
}

async function eonet() {
  const url = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=30&category=wildfires,severeStorms,floods,volcanoes,landslides,drought";
  const data = JSON.parse(await get(url));
  return (data.events || []).map(e => {
    const g = (e.geometry || []).at(-1);
    return {
      cat: "weather", title: e.title, source: "NASA EONET",
      place: e.categories?.[0]?.title || "Worldwide",
      date: new Date(g?.date || Date.now()), link: e.link || "",
    };
  });
}

async function rssSource(f) {
  return parseFeed(await get(f.url)).map(i => ({
    cat: classify(f.cat, i.title), title: i.title, source: f.name, place: f.place, date: i.date, link: i.link,
  }));
}

async function newsSearch(query, cat, place) {
  return parseFeed(await get(gnews(query))).map(i => {
    const s = splitSource(i.title, "Google News");
    return { cat: classify(cat, s.title), title: s.title, source: s.source, place, date: i.date, link: i.link };
  });
}

// ---------- assemble ----------
async function pool(tasks, size = 5) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      try { results.push(...await t.run()); console.log(`ok   ${t.label}`); }
      catch (e) { console.warn(`FAIL ${t.label}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

export function assemble(all, cfg, now = Date.now()) {
  const seen = new Set();
  const groups = {};
  for (const i of all.sort((a, b) => b.date - a.date)) {
    const ageH = (now - i.date) / 3600000;
    const limit = i.cat === "weather" ? cfg.weatherMaxAgeHours : cfg.maxAgeHours;
    if (ageH > limit || ageH < -24) continue;
    const key = i.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    (groups[i.cat] ||= []).push(i);
  }
  for (const k in groups) groups[k] = groups[k].slice(0, cfg.perCategoryMax);
  // round-robin so no single category dominates the featured panel
  const out = [];
  const cats = Object.keys(groups);
  for (let n = 0; out.length < cfg.totalMax && cats.some(c => groups[c][n]); n++)
    for (const c of cats) if (groups[c][n] && out.length < cfg.totalMax) out.push(groups[c][n]);
  return out.map(i => ({
    cat: i.cat, title: i.title, source: i.source, place: i.place,
    time: ago(i.date, now), published: i.date.toISOString(), link: i.link,
  }));
}

async function main() {
  const cfg = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));
  const w = cfg.watch || {};
  const tasks = [
    { label: "GDACS", run: () => gdacs(cfg) },
    { label: "NASA EONET", run: () => eonet() },
    ...(cfg.feeds || []).map(f => ({ label: f.name, run: () => rssSource(f) })),
    ...(cfg.weatherQueries || []).map(q => ({ label: `news: ${q}`, run: () => newsSearch(`${q} when:3d`, "weather", "Worldwide") })),
    ...(cfg.filmProductionQueries || []).map(q => ({ label: `news: ${q}`, run: () => newsSearch(`${q} when:7d`, "film", "Film industry") })),
    ...(w.artists || []).map(n => ({ label: `artist: ${n}`, run: () => newsSearch(`"${n}" when:3d`, "artist", n) })),
    ...(w.actors || []).map(n => ({ label: `actor: ${n}`, run: () => newsSearch(`"${n}" when:3d`, "actor", n) })),
    ...(w.festivals || []).map(n => ({ label: `festival: ${n}`, run: () => newsSearch(`"${n}" festival when:7d`, "festival", n) })),
    ...(w.films || []).map(n => ({ label: `film: ${n}`, run: () => newsSearch(`"${n}" film production when:7d`, "film", n) })),
  ];
  const feed = assemble(await pool(tasks), cfg);
  if (!feed.length) { console.error("No items fetched; leaving feed.json unchanged."); return; }
  await writeFile(path.join(ROOT, "feed.json"), JSON.stringify(feed, null, 2) + "\n");
  console.log(`Wrote ${feed.length} items.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
