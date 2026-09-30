#!/usr/bin/env node
// Assay release watcher.
// 1. Lists chat models from each provider and finds ones not seen before.
// 2. Reads the configured release-note pages and drafts a scenario per new model.
// 3. Runs live test packs through the same engine as index.html (loaded in jsdom).
// 4. Writes results/latest.json and renders reports/latest.pdf with Playwright.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "watcher/config.json"), "utf8"));
const LIVE = cfg.liveTests === true;
// Desk-audit mode (liveTests: false) never uses API keys, so it costs nothing.
const KEYS = LIVE ? { openai: process.env.OPENAI_API_KEY || "", anthropic: process.env.ANTHROPIC_API_KEY || "", gemini: process.env.GEMINI_API_KEY || "" } : { openai: "", anthropic: "", gemini: "" };
const TODAY = new Date().toISOString().slice(0, 10);
// How this run was started: GitHub sets GITHUB_EVENT_NAME to "schedule" or "workflow_dispatch".
const EVENT = process.env.GITHUB_EVENT_NAME || "";
const TRIGGER = EVENT === "schedule" ? "scheduled" : EVENT === "workflow_dispatch" ? "on-demand" : "local";
// Full audit on Mondays, on demand and locally; other scheduled days only test new releases.
const FULL = TRIGGER === "scheduled" ? new Date().getUTCDay() === 1 : process.env.ASSAY_FULL !== "false";
// Optional on-demand list, e.g. "anthropic:claude-sonnet-5-5, openai:gpt-6-sol".
const FORCED = String(process.env.ASSAY_MODELS || "").split(/[\s,]+/).filter(Boolean).map(x => { const [p, ...r] = x.split(":"); return r.length ? { provider: p, id: r.join(":") } : null; }).filter(Boolean);
const RUN_URL = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "";
const warn = m => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `[assay] WARNING ${m}`);
const log = (...a) => console.log("[assay]", ...a);
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(path.join(ROOT, f), "utf8")); } catch { return d; } };
const writeJSON = async (f, o) => { await fs.mkdir(path.dirname(path.join(ROOT, f)), { recursive: true }); await fs.writeFile(path.join(ROOT, f), JSON.stringify(o, null, 2)); };

// Load the app itself so the watcher and the browser share one engine.
const dom = new JSDOM(await fs.readFile(path.join(ROOT, "index.html"), "utf8"), { runScripts: "dangerously", pretendToBeVisual: true, url: "https://assay.local/" });
const w = dom.window;
w.fetch = fetch; w.confirm = () => true; w.alert = m => log(m); w.scrollTo = () => {};
const A = w.Assay;

// Scenarios from the repo (the embedded set is already loaded).
const index = await readJSON("scenarios/index.json", { scenarios: [] });
const files = await Promise.all(index.scenarios.map(f => readJSON("scenarios/" + f, null)));
A.addScenarios(files.filter(Boolean));

// 1. Detect new models.
log(`trigger: ${TRIGGER}${FULL ? " (full audit)" : " (new releases only)"}, ${LIVE ? "live tests on" : "desk audit, no API calls"}`);
if (LIVE) Object.entries(KEYS).forEach(([p, k]) => { if(!k) warn(`${p.toUpperCase()}_API_KEY is not available to the workflow: no catalogue check and no live tests for ${p}.`); });
const known = await readJSON("watch/known-models.json", { models: [] });
// Only an empty list counts as a first run. A list that already holds models is the baseline,
// so the first keyed run can no longer swallow a release made since then.
const firstRun = !known.baselined && !(known.models || []).length;
const knownSet = new Set(known.models.map(m => m.provider + ":" + m.id));
const found = [];
for (const p of Object.keys(KEYS)) {
  if (!KEYS[p]) { if (LIVE) log(`no ${p} key, skipping catalogue`); continue; }
  try {
    const list = (await A.listModels(p, KEYS[p])).filter(m => A.isChatModel(p, m.id));
    list.forEach(m => found.push(m));
    log(`${p}: ${list.length} chat models`);
  } catch (e) { log(`${p} catalogue failed: ${e.message}`); }
}
// Scenario model IDs count as known too.
A.scenarios().forEach(sc => sc.models.forEach(m => m.modelId && knownSet.add(m.provider + ":" + m.modelId)));
const catalogueFresh = firstRun ? [] : found.filter(m => !knownSet.has(m.provider + ":" + m.id));
// Release-note scan: works without keys, so a missing secret no longer hides a launch.
const stripHtml = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noteCache = {};
async function releaseText(p) {
  if (noteCache[p] !== undefined) return noteCache[p];
  let txt = "";
  for (const url of (cfg.releaseNotes[p] || [])) {
    try { const r = await fetch(url, { headers: { "user-agent": "assay-watch" } }); if (r.ok) txt += `\nSOURCE ${url}\n` + stripHtml(await r.text()).slice(0, 40000); else log(`release notes ${url}: HTTP ${r.status}`); } catch (e) { log(`could not read ${url}: ${e.message}`); }
  }
  return (noteCache[p] = txt);
}
const noteFresh = [];
// The first note scan records what the pages already list, so old IDs in the history are not drafted.
const notesFirst = !known.notesBaselined;
let notesRead = false;
for (const [p, pat] of Object.entries(cfg.modelPatterns || {})) {
  const txt = await releaseText(p); if (!txt) continue; notesRead = true;
  const ids = [...new Set((txt.toLowerCase().match(new RegExp(pat, "g")) || []))].filter(id => A.isChatModel(p, id));
  ids.filter(id => !knownSet.has(p + ":" + id) && !found.some(m => m.provider === p && m.id === id)).forEach(id => noteFresh.push({ provider: p, id, via: "release notes" }));
}
const seen = new Set();
const fresh = [...FORCED.map(m => Object.assign({ via: "requested" }, m)), ...catalogueFresh.map(m => Object.assign({ via: "catalogue" }, m)), ...(firstRun || notesFirst ? [] : noteFresh)]
  .filter(m => { const k = m.provider + ":" + m.id; if (seen.has(k)) return false; seen.add(k); return true; });
log(firstRun ? "first run: recording the current catalogue as the baseline" : `${fresh.length} new models${fresh.length ? ": " + fresh.map(m => `${m.id} (${m.via})`).join(", ") : ""}`);
const merged = new Map(known.models.map(m => [m.provider + ":" + m.id, m]));
found.concat(firstRun ? [] : noteFresh).forEach(m => { const k = m.provider + ":" + m.id; if (!merged.has(k)) merged.set(k, { provider: m.provider, id: m.id, firstSeen: TODAY }); });
const knownChanged = merged.size !== (known.models || []).length || (notesRead && !known.notesBaselined) || !known.baselined;
if (knownChanged) await writeJSON("watch/known-models.json", { updated: TODAY, baselined: !!known.baselined || found.length > 0 || (known.models || []).length > 0, notesBaselined: !!known.notesBaselined || notesRead, models: [...merged.values()] });

// 2. Draft scenarios from release notes, unless a reviewed scenario already covers the model.
const covered = [];
const drafts = [];
for (const m of fresh.slice(0, 6)) {
  const cur = A.scenarios().find(sc => sc.status !== "draft" && sc.models.some(x => x.provider === m.provider && x.modelId === m.id && x.id !== "base"));
  if (cur) { covered.push(cur.id); log(`${m.id} is covered by scenario ${cur.id}`); continue; }
  const pool = found.concat(known.models);
  const baseId = cfg.predecessors[m.id] || A.guessPredecessor(m.provider, m.id, pool);
  let claims = [], summary = "", sourceUrl = (cfg.releaseNotes[m.provider] || [])[0] || "";
  const txt = await releaseText(m.provider);
  if (txt && KEYS.anthropic) {
    try {
      const focus = txt.includes(m.id) ? txt.slice(Math.max(0, txt.indexOf(m.id) - 4000), txt.indexOf(m.id) + 12000) : txt.slice(0, 16000);
      const out = await A.extractClaims({ text: `New model: ${m.id}\n${focus}`, vendor: m.provider, key: KEYS.anthropic, model: cfg.extractionModel });
      claims = out.claims; summary = out.summary || "";
    } catch (e) { log(`extraction failed for ${m.id}: ${e.message}`); }
  }
  const pr = id => cfg.prices[id] || [0, 0];
  const sc = A.buildDraftScenario({ provider: m.provider, candId: m.id, baseId, baseIn: pr(baseId)[0], baseOut: pr(baseId)[1], candIn: pr(m.id)[0], candOut: pr(m.id)[1], claims, summary: summary ? summary + " Draft: claims extracted automatically and not yet reviewed." : "", sourceUrl, released: m.created || TODAY });
  await writeJSON("scenarios/" + sc.id + ".json", sc);
  if (!index.scenarios.includes(sc.id + ".json")) index.scenarios.push(sc.id + ".json");
  A.addScenarios([sc]); drafts.push(sc.id);
  log(`drafted ${sc.id} with ${claims.length} claims (baseline ${baseId || "unknown"})`);
}
await writeJSON("scenarios/index.json", index);

// 3. Reuse control: verification and authorisation to reuse are kept apart.
// The ledger seals each verdict with a fingerprint of its conditions. If the conditions change,
// the verdict stays in the record but is no longer cleared for reuse until a person re-reviews
// the scenario (bumps its "checked" date), which re-seals it and keeps the old seal in history.
const ledgerPath = "watch/verdict-ledger.json";
const ledger = await readJSON(ledgerPath, { schema: "assay-ledger/1", entries: {} });
const ledgerBefore = JSON.stringify(ledger);
ledger.maxAgeDays = cfg.reuseMaxDays || ledger.maxAgeDays || 90;
for (const sc of A.scenarios().filter(x => x.status !== "draft")) for (const c of sc.claims) {
  const v = A.refVerdict(sc, c); if (v.key === "noref") continue;
  const key = sc.id + "/" + c.id, fp = A.conditionFingerprint(sc, c), conditions = A.conditionsOf(sc, c), e = ledger.entries[key];
  if (!e) { ledger.entries[key] = { fp, verdict: v.key, sealed: TODAY, reviewed: sc.checked, conditions, history: [] }; log(`sealed ${key} (${fp})`); continue; }
  if (e.fp === fp) continue;
  if (String(sc.checked) > String(e.reviewed || "")) {
    e.history = [{ fp: e.fp, verdict: e.verdict, sealed: e.sealed, conditions: e.conditions }, ...(e.history || [])].slice(0, 5);
    Object.assign(e, { fp, verdict: v.key, sealed: TODAY, reviewed: sc.checked, conditions });
    log(`re-sealed ${key} after review (${fp})`);
  }
}
A.setReuseContext(ledger, [...merged.values()]);
const needsReview = [];
for (const sc of A.scenarios().filter(x => x.status !== "draft")) for (const c of sc.claims) {
  const r = A.reuseStatus(sc, c, null, TODAY);
  if (r.status !== "none" && r.status !== "valid") needsReview.push({ key: r.key, title: `${sc.title}: ${c.text}`, status: r.status, reasons: r.reasons, fp: r.fp });
}
if (needsReview.length) warn(`${needsReview.length} verdict(s) not cleared for reuse: ${needsReview.map(x => x.key + " (" + x.status + ")").join(", ")}`);
const ledgerChanged = JSON.stringify(ledger) !== ledgerBefore;
if (ledgerChanged) await writeJSON(ledgerPath, ledger);
await fs.writeFile(path.join(process.env.RUNNER_TEMP || "/tmp", "assay-reuse.json"), JSON.stringify({ runDate: TODAY, needsReview }, null, 2));

// 4. Run live packs within budget.
await fs.writeFile(path.join(process.env.RUNNER_TEMP || "/tmp", "assay-new-models.json"), JSON.stringify({ runDate: TODAY, models: fresh.map(m => ({ provider: m.provider, id: m.id, via: m.via, draft: drafts.find(d => d.includes(slug(m.id))) || "", covered: covered.find(id => A.scenarios().find(sc => sc.id === id && sc.models.some(x => x.modelId === m.id))) || "" })) }, null, 2));
function slug(t) { return String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60); }
const reuseSummary = { cleared: 0, needsReview: needsReview.length };
A.scenarios().filter(x => x.status !== "draft").forEach(sc => sc.claims.forEach(c => { if (A.reuseStatus(sc, c, null, TODAY).status === "valid") reuseSummary.cleared++; }));
const results = { reuse: reuseSummary, mode: LIVE ? "live" : "desk", generatedAt: new Date().toISOString(), runDate: TODAY, trigger: TRIGGER, fullAudit: FULL, runUrl: RUN_URL,
  keys: Object.fromEntries(Object.entries(KEYS).map(([p, k]) => [p, !!k])),
  newModels: fresh.map(m => ({ provider: m.provider, id: m.id, via: m.via })), scenarios: {}, skipped: {} };
const prev = await readJSON("results/latest.json", { scenarios: {} });
const toRun = !LIVE ? [] : [...new Set((FULL ? cfg.autoRun : []).concat(covered, cfg.autoRunDrafts ? drafts : []))];
const prevReuse = (await readJSON("results/latest.json", {})).reuse || {};
if (!FULL && !fresh.length && !ledgerChanged && prevReuse.needsReview === needsReview.length) { log("no new releases today; nothing to test, report left unchanged"); process.exit(0); }
for (const id of toRun) {
  const sc = A.scenarios().find(s => s.id === id);
  if (!sc) { log(`scenario ${id} not found`); continue; }
  const tasks = 15 + ((sc.livePack && sc.livePack.extraTasks) || []).length;
  let repeats = cfg.runSettings.repeats;
  while (repeats > 1 && sc.models.length * tasks * repeats > cfg.maxCallsPerScenario) repeats--;
  if (sc.models.length * tasks * repeats > cfg.maxCallsPerScenario) { log(`${id} exceeds the call budget even at 1 repeat; skipped`); continue; }
  try {
    log(`running ${id}: ${sc.models.length} models × ${tasks} tasks × ${repeats} repeats`);
    const r = await A.runScenarioHeadless(id, KEYS, Object.assign({}, cfg.runSettings, { repeats }));
    if (r) {
      r.runDate = TODAY; r.trigger = TRIGGER; results.scenarios[id] = r;
      const errs = r.runs.filter(x => x.error);
      log(`${id}: ${r.runs.length} calls, ${errs.length} errors`);
      if (errs.length) warn(`${id}: ${errs.length} of ${r.runs.length} calls failed, e.g. ${errs[0].error}`);
    } else { results.skipped[id] = "no API key for its provider"; warn(`${id}: skipped, no API key for its provider`); }
  } catch (e) { results.skipped[id] = e.message; warn(`${id} failed: ${e.message}`); }
}
// Keep earlier results for scenarios not re-run this week.
for (const [id, v] of Object.entries(prev.scenarios || {})) if (!results.scenarios[id]) results.scenarios[id] = v;
await writeJSON("results/latest.json", results);
await writeJSON(`results/${TODAY}.json`, results);

// 4. Render the PDF report from the deployed page itself.
const types = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf" };
const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const f = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { const b = await fs.readFile(f); res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }).end(b); } catch { res.writeHead(404).end(); }
}).listen(0);
const port = server.address().port;
try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?pdf=1#report`);
  await page.waitForFunction("window.__reportReady === true", null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  await fs.mkdir(path.join(ROOT, "reports"), { recursive: true });
  const footer = `<div style="font-size:7px;width:100%;padding:0 14mm;display:flex;justify-content:space-between;color:#565C7D;font-family:sans-serif"><span>Assay | ${cfg.reportTitle}</span><span>${cfg.footerCredit || ""}</span><span class="pageNumber"></span></div>`;
  const opts = { preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true, headerTemplate: "<div></div>", footerTemplate: footer };
  await page.pdf(Object.assign({ path: path.join(ROOT, `reports/assay-report-${TODAY}.pdf`) }, opts));
  await fs.copyFile(path.join(ROOT, `reports/assay-report-${TODAY}.pdf`), path.join(ROOT, "reports/latest.pdf"));
  await browser.close();
  log(`report written to reports/assay-report-${TODAY}.pdf`);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Assay ${TRIGGER} run, ${TODAY}\n\n- New models: ${fresh.map(m => m.id).join(", ") || "none"}\n- Live results: ${Object.keys(results.scenarios).filter(id => results.scenarios[id].runDate === TODAY).join(", ") || "none"}\n- Skipped: ${Object.entries(results.skipped).map(([k, v]) => k + " (" + v + ")").join(", ") || "none"}\n- Verdicts cleared for reuse: ${reuseSummary.cleared}; need review: ${needsReview.map(x => x.key + " (" + x.status + ")").join(", ") || "none"}\n- Keys present: ${Object.entries(results.keys).map(([p, v]) => p + (v ? " yes" : " NO")).join(", ")}\n`);
} finally { server.close(); }
