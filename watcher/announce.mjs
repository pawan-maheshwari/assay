// Assay release desk: turns watcher findings into short public posts.
// Writes watch/announcements.json (read by world-of-ai.co.in/assay) and
// watch/announcements.xml (RSS). No API keys, no cost.
//
// Two kinds of post:
//   detected  - a model seen for the first time on this run; claims not yet checked.
//   audited   - a reviewed scenario with at least one independently checked claim.
//               A new "checked" date on the scenario produces an updated post.
// Posts are kept once written, so the feed is a running record.
import fs from "node:fs/promises";
import path from "node:path";

const SITE = "https://world-of-ai.co.in/assay.html";
const FEED_URL = "https://pawan-maheshwari.github.io/assay/watch/announcements.xml";
const VENDOR = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Google", google: "Google" };
const WORD = { ok: "Hallmarked", part: "Plated", bad: "Fool's gold", noref: "Unassayed" };
const MAX_POSTS = 60;

// claude-opus-5-5 -> Claude Opus 5.5, gpt-6.2-sol -> GPT-6.2 Sol, gemini-4-argon -> Gemini 4 Argon
export function prettyModel(id) {
  const parts = String(id || "").split("-").filter(p => p && !/^\d{8}$/.test(p));
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (/^\d+(\.\d+)?$/.test(p) && last && /^\d+$/.test(last) && p.length <= 2) { out[out.length - 1] = last + "." + p; continue; }
    out.push(p);
  }
  return out.map((p, i) => p === "gpt" ? "GPT" : /^\d/.test(p) ? p : p[0].toUpperCase() + p.slice(1))
    .join(" ").replace(/^GPT (\d)/, "GPT-$1");
}

const longDate = d => { const t = Date.parse(d); return isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : d; };
const xml = s => String(s ?? "").replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

function auditPost(A, sc, today) {
  const claims = (sc.claims || []).map(c => ({ c, v: A.refVerdict(sc, c) }));
  const tally = { ok: 0, part: 0, bad: 0, noref: 0 };
  claims.forEach(({ v }) => { tally[v.key] = (tally[v.key] || 0) + 1; });
  const checked = claims.length - tally.noref;
  if (!checked) return null;
  // Subject and baseline: from the title ("X against Y"), else from the first claim's model roles.
  const c0 = (sc.claims || [])[0] || {}, byId = id => sc.models.find(m => m.id === id) || {};
  const cand = byId(c0.candidate || "cand"), base = byId(c0.baseline || "base");
  const [tName, tBase] = String(sc.title || "").split(/\s+against\s+/i);
  const name = tName || prettyModel(cand.modelId);
  const baseName = tBase || prettyModel(base.modelId) || "its predecessor";
  const parts = ["ok", "part", "bad"].filter(k => tally[k]).map(k => `${tally[k]} ${WORD[k]}`);

  // A later per-claim re-check produces an "audit updated" post.
  const last = (sc.claims || []).reduce((d, c) => String(c.checked || "") > d ? c.checked : d, String(sc.checked || today));
  const updated = last > String(sc.checked || "");
  const id = `audited-${sc.id}-${last}`;
  const lines = claims.filter(r => r.v.key !== "noref").sort((a, b) => (b.c.checked === last) - (a.c.checked === last)).slice(0, 4).map(r => `${WORD[r.v.key]}: ${r.c.text}`);
  const headline = updated ? `${name}: audit updated` : `${name}: ${checked} launch claim${checked > 1 ? "s" : ""} assayed`;
  const body = `${sc.vendor ? sc.vendor + "'s launch claims for " : "The launch claims for "}${name} were checked against ${baseName} using independent measurements. Result: ${parts.join(", ")}.${updated ? ` Re-checked on ${longDate(last)} against the latest independent data.` : ""}`;
  return {
    id, kind: "audited", date: last, provider: cand.provider || "", model: cand.modelId || "",
    baseline: base.modelId || "", scenario: sc.id, headline, body, highlights: lines, tally,
    url: `${SITE}#post-${id}`,
    share: `${headline}.\n\n${body}\n\n${lines.map(l => "• " + l).join("\n")}\n\nFull evidence: ${SITE}#post-${id}\n\n#Assay #LLM #AIGovernance`
  };
}

function detectedPost(m, sc, baseId, today) {
  const name = prettyModel(m.id), vendor = VENDOR[m.provider] || m.provider;
  const id = `detected-${m.provider}-${m.id}`;
  const headline = `New release: ${vendor} ${name}`;
  const body = `Assay's watcher found ${name} in ${vendor}'s release notes on ${longDate(today)}. Its launch claims are now in the audit queue${baseId ? `, to be checked against ${prettyModel(baseId)}` : ""}. Verdicts will be posted here once they are checked against independent data.`;
  return {
    id, kind: "detected", date: today, provider: m.provider, model: m.id, baseline: baseId || "",
    scenario: sc ? sc.id : "", headline, body, highlights: [], tally: null,
    url: `${SITE}#post-${id}`,
    share: `${headline}.\n\n${body}\n\nFollow the audit: ${SITE}#post-${id}\n\n#Assay #LLM`
  };
}

export async function writeAnnouncements({ A, ROOT, TODAY, fresh, drafts }) {
  const file = path.join(ROOT, "watch/announcements.json");
  let feed;
  try { feed = JSON.parse(await fs.readFile(file, "utf8")); } catch { feed = null; }
  const firstRun = !feed;
  feed = feed || { schema: "assay-announcements/1", posts: [] };
  const have = new Set(feed.posts.map(p => p.id));
  const added = [];
  const add = p => { if (p && !have.has(p.id)) { have.add(p.id); feed.posts.push(p); added.push(p.id); } };

  // New releases seen on this run. The first run only records audits, so the
  // backlog of old drafts is not announced as news.
  if (!firstRun) for (const m of fresh) {
    const sc = A.scenarios().find(s => s.models.some(x => x.provider === m.provider && x.modelId === m.id && x.id !== "base"));
    const base = sc && sc.models.find(x => x.id === "base");
    add(detectedPost(m, sc, base && base.modelId, TODAY));
  }
  // Every reviewed scenario with checked claims gets one post per review date.
  for (const sc of A.scenarios().filter(s => s.status !== "draft")) add(auditPost(A, sc, TODAY));

  if (!added.length && !firstRun) return { added };
  feed.updated = TODAY;
  feed.posts.sort((a, b) => String(b.date).localeCompare(String(a.date)) || (a.kind === "audited" ? -1 : 1));
  feed.posts = feed.posts.slice(0, MAX_POSTS);
  await fs.writeFile(file, JSON.stringify(feed, null, 2));

  const items = feed.posts.slice(0, 30).map(p => `  <item>
    <title>${xml(p.headline)}</title>
    <link>${xml(p.url)}</link>
    <guid isPermaLink="false">${xml(p.id)}</guid>
    <pubDate>${new Date(p.date + "T09:00:00Z").toUTCString()}</pubDate>
    <description>${xml([p.body, ...p.highlights].join(" "))}</description>
  </item>`).join("\n");
  await fs.writeFile(path.join(ROOT, "watch/announcements.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Assay release desk</title>
  <link>${SITE}</link>
  <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>
  <description>New AI model releases and how their launch claims held up against independent measurement.</description>
  <language>en</language>
${items}
</channel>
</rss>
`);
  return { added };
}
