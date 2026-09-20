// NS Charity Jobs — Cloudflare Worker.
// Daily cron scrapes Nova Scotia charity job sources, normalizes + dedupes
// into a Durable Object (SQLite), and serves a JSON API + static frontend.
//
// Polite-crawler rules: identifiable UA, CharityVillage Crawl-delay 10
// honored (10s between page fetches), each source polled at most once per
// day, only metadata stored (title/employer/location/dates/salary + link
// back to the original posting — never full descriptions verbatim).

export { JobsDB };

const UA = "NSCharityJobsBot/1.0 (+https://ns-charity-jobs.waraichinstitute.workers.dev; personal research project, contact via site)";
const HEADERS = { "User-Agent": UA, "Accept": "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8" };
const DB_NAME = "main";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fail fast: a hanging source must never wedge the whole pipeline.
// Each HTTP fetch gets 30s; a timed-out source keeps its last good
// staging data and the remaining phases still run.
const FETCH_TIMEOUT_MS = 30000;
function fetchT(url, opts) {
  return fetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
}

function unescapeHtml(s) {
  return (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

// ---- name normalization (for charity matching + dedupe) ----
const SUFFIXES = new Set([
  "inc", "incorporated", "corp", "corporation", "ltd", "limited",
  "society", "societies", "association", "assoc", "foundation",
  "charities", "charity", "trust", "fund", "centre", "center",
  "organization", "organisation", "club", "services", "service",
  "network", "cooperative", "coop", "alliance", "coalition",
]);
function normName(s) {
  let t = (s || "").toLowerCase().replace(/&/g, " and ");
  t = t.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^the /, "");
  for (let k = 0; k < 3; k++) {
    const p = t.split(" ");
    if (p.length > 1 && SUFFIXES.has(p[p.length - 1])) p.pop();
    else break;
    t = p.join(" ");
  }
  return t;
}
function normText(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function cityOf(loc) {
  return normText((loc || "").split(",")[0]);
}

// ---- Nova Scotia gazetteer: normalized community name -> [lat, lng] ----
// Places job pins on the map. Covers the communities the boards use most;
// anything unmatched gets lat/lng null and is listed without a pin.
const NS_GEO = {
  "halifax": [44.6488, -63.5752],
  "halifax regional municipality": [44.6488, -63.5752],
  "dartmouth": [44.6658, -63.5676],
  "bedford": [44.7347, -63.6572],
  "lower sackville": [44.7796, -63.6598],
  "sackville": [44.7796, -63.6598],
  "fall river": [44.8181, -63.6167],
  "hammonds plains": [44.7408, -63.7931],
  "tantallon": [44.7001, -63.9031],
  "upper tantallon": [44.7001, -63.9031],
  "hubbards": [44.6403, -63.8731],
  "peggys cove": [44.4933, -63.9147],
  "eastern passage": [44.6147, -63.4703],
  "cole harbour": [44.6711, -63.4803],
  "cole harbor": [44.6711, -63.4803],
  "spryfield": [44.6219, -63.5764],
  "herring cove": [44.5667, -63.5667],
  "sambro": [44.4767, -63.6083],
  "beaver bank": [44.8167, -63.6500],
  "mount uniacke": [44.9000, -63.8333],
  "enfield": [44.9417, -63.5403],
  "elmsdale": [44.9767, -63.5111],
  "shubenacadie": [45.0897, -63.4011],
  "stewiacke": [45.1417, -63.3467],
  "brookfield": [45.2567, -63.2817],
  "truro": [45.3646, -63.2848],
  "bible hill": [45.3736, -63.2622],
  "great village": [45.4167, -63.6000],
  "tatamagouche": [45.7122, -63.2906],
  "pugwash": [45.8533, -63.6625],
  "amherst": [45.8333, -64.2167],
  "oxford": [45.7333, -63.8667],
  "parrsboro": [45.4056, -64.3278],
  "springhill": [45.6458, -64.0611],
  "new glasgow": [45.5875, -62.6485],
  "stellarton": [45.5590, -62.6630],
  "westville": [45.5578, -62.7150],
  "trenton": [45.6139, -62.6375],
  "pictou": [45.6783, -62.7097],
  "antigonish": [45.6229, -61.9933],
  "port hawkesbury": [45.6167, -61.3483],
  "mulgrave": [45.6139, -61.3889],
  "canso": [45.3367, -60.9958],
  "guysborough": [45.3917, -61.5042],
  "sherbrooke": [45.1417, -61.9750],
  "kentville": [45.0777, -64.4952],
  "new minas": [45.0711, -64.4522],
  "wolfville": [45.0917, -64.3597],
  "port williams": [45.1000, -64.4167],
  "canning": [45.1583, -64.4222],
  "berwick": [45.0478, -64.7339],
  "greenwood": [44.9736, -64.9361],
  "kingston": [44.9833, -64.9500],
  "middleton": [44.9431, -65.0678],
  "bridgetown": [44.8417, -65.2889],
  "annapolis royal": [44.7417, -65.5139],
  "windsor": [44.9917, -64.1311],
  "hantsport": [44.9667, -64.1833],
  "falmouth": [44.9833, -64.1667],
  "bridgewater": [44.3771, -64.5190],
  "lunenburg": [44.3771, -64.3096],
  "mahone bay": [44.4506, -64.0146],
  "chester": [44.5417, -64.2392],
  "liverpool": [44.0389, -64.7128],
  "lockeport": [43.7000, -65.1167],
  "shelburne": [43.7639, -65.3239],
  "barrington": [43.5667, -65.5667],
  "clarks harbour": [43.4333, -65.6333],
  "yarmouth": [43.8375, -66.1154],
  "tusket": [43.8667, -65.9500],
  "wedgeport": [43.7333, -65.9667],
  "meteghan": [44.1833, -66.1333],
  "saulnierville": [44.2667, -66.1333],
  "weymouth": [44.4167, -65.9833],
  "digby": [44.6227, -65.7615],
  "bear river": [44.5667, -65.6333],
  "sydney": [46.1368, -60.1942],
  "cape breton": [46.1368, -60.1942],
  "cape breton regional municipality": [46.1368, -60.1942],
  "cbrm": [46.1368, -60.1942],
  "sydney river": [46.1000, -60.2333],
  "sydney mines": [46.2367, -60.2200],
  "north sydney": [46.2103, -60.2519],
  "glace bay": [46.1975, -59.9583],
  "new waterford": [46.0036, -59.8875],
  "dominion": [46.1833, -59.9000],
  "reserve mines": [46.1667, -60.0000],
  "westmount": [46.1167, -60.2167],
  "howie centre": [46.0833, -60.2000],
  "membertou": [46.1083, -60.1867],
  "louisbourg": [45.9208, -59.9708],
  "baddeck": [46.1000, -60.7528],
  "st peters": [45.6583, -60.8733],
  "inverness": [46.2283, -61.3075],
  "mabou": [46.0733, -61.3906],
  "cheticamp": [46.6283, -61.0139],
  "whycocomagh": [45.9667, -61.1167],
  "eskasoni": [45.9333, -60.6167],
  "porters lake": [44.7417, -63.3014],
  "musquodoboit harbour": [44.7667, -63.1333],
  "sheet harbour": [44.9167, -62.8333],
};
function geocodeCity(loc) {
  const c = cityOf(loc).replace(/\s+ns$/, "");
  return NS_GEO[c] || null;
}
function dedupeKey(j) {
  return normName(j.employer) + "|" + normText(j.title) + "|" + cityOf(j.location);
}

// Employers that are public-sector / health-authority, not charities,
// even if a name variant appears in a registry. (IWK Foundation, the
// actual charity, is NOT matched by this pattern.)
const BLOCKED_EMPLOYER_RE = /iwk health(?!.*foundation)|nova scotia health|nshealth/i;

// Extracts the human-readable text of a jcl-job-teaser-* field. The value
// always follows the field icon's </svg></span> (optionally wrapped in one
// span/div); the tempered matcher keeps the search from crossing into the
// next field's markup, so missing fields yield "" instead of a neighbour's
// text.
const FIELD_GUARD = "(?:(?!jcl-job-teaser-(?:location|remote|company|salary))[\\s\\S])*?";
function teaserField(c, cls, wrap) {
  const re = new RegExp(cls + '"' + FIELD_GUARD + "<\\/svg><\\/span>" + (wrap || "") + "([^<]+)");
  const m = c.match(re);
  return m ? unescapeHtml(m[1]).replace(/\s+/g, " ").trim() : "";
}

// ---- CharityVillage: https://www.charityvillage.com/jobs/nova-scotia ----
function parseCharityVillage(html) {
  const jobs = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, "");
  const chunks = clean.split('<div title="');
  for (const c of chunks) {
    const m = c.match(/^([^"]+)" data-test-id="job-teaser-(\d+)/);
    if (!m) continue;
    const title = unescapeHtml(m[1].trim());
    const id = m[2];
    const urlM = c.match(/href="(\/job\/[^"]+)"/);
    const flat = c.replace(/<[^>]+>/g, " ");
    const pubM = flat.match(/Published\s*:?\s*(\d{4}-\d{2}-\d{2})/);
    const expM = flat.match(/Expires\s*:?\s*(\d{4}-\d{2}-\d{2})/);
    const rawRemote = teaserField(c, "jcl-job-teaser-remote");
    const location = teaserField(c, "jcl-job-teaser-location", "(?:<span[^>]*>)?").replace(/\s*\+$/, "").trim();
    jobs.push({
      extId: "cv-" + id,
      title,
      employer: teaserField(c, "jcl-job-teaser-company", "(?:<div[^>]*>)?"),
      location,
      workModel: /remote/i.test(rawRemote) ? "Remote" : /hybrid/i.test(rawRemote) ? "Hybrid" : rawRemote ? "On-site" : "",
      jobType: "",
      posted: pubM ? pubM[1] : null,
      expires: expM ? expM[1] : null,
      salary: teaserField(c, "jcl-job-teaser-salary"),
      url: urlM ? "https://www.charityvillage.com" + urlM[1] : "",
    });
  }
  return jobs;
}

async function fetchCharityVillage() {
  const jobs = [];
  for (let page = 1; page <= 8; page++) {
    if (page > 1) await sleep(10000); // honor Crawl-delay: 10
    const u = "https://www.charityvillage.com/jobs/nova-scotia" + (page > 1 ? "?page=" + page : "");
    const r = await fetchT(u, { headers: HEADERS });
    if (!r.ok) break;
    const parsed = parseCharityVillage(await r.text());
    if (!parsed.length) break;
    jobs.push(...parsed);
  }
  return jobs;
}

// ---- WorkInNonProfits.ca: /jobs/list-by/region/9/nova-scotia ----
function parseWinp(html) {
  const byId = new Map();
  const cards = html.split("<div id=");
  for (const c of cards) {
    if (!c.includes("job_item")) continue;
    const idM = c.match(/^\s*"(\d+)"/);
    if (!idM) continue;
    const id = idM[1];
    const aM = c.match(/lj_title[^>]*><a href="(\/jobs\/view\/\d+\/([EF])\/[^"]+)">([^<]+)<\/a>/);
    if (!aM) continue;
    const isEnglish = aM[2] === "E";
    if (byId.has(id) && !isEnglish) continue; // prefer English card over French twin
    const dateM = c.match(/lj_date[^>]*>([^<]+)/);
    const orgM = c.match(/lj_org">([^<]+)/);
    const tipM = c.match(/winp_tooltip" title="([^"]+)"/);
    const locM = c.match(/lj_loc">([^<]+)/);
    const wtM = c.match(/<b>([^<]+)<\/b>\s*\|\s*([^<]+)</);
    let expires = null;
    const closes = dateM ? unescapeHtml(dateM[1]).trim().toLowerCase() : "";
    const dm = closes.match(/closes in (\d+) days?/);
    if (dm) {
      const d = new Date(); d.setDate(d.getDate() + parseInt(dm[1], 10));
      expires = d.toISOString().slice(0, 10);
    } else if (closes.includes("closes today")) {
      expires = new Date().toISOString().slice(0, 10);
    } else if (closes.includes("closes tomorrow")) {
      const d = new Date(); d.setDate(d.getDate() + 1);
      expires = d.toISOString().slice(0, 10);
    }
    const rawWT = (wtM ? wtM[1] : "") + " " + (wtM ? wtM[2] : "");
    const typeRaw = wtM ? unescapeHtml(wtM[2]).trim() : "";
    byId.set(id, {
      extId: "winp-" + id,
      title: unescapeHtml(aM[3]).trim(),
      employer: orgM ? unescapeHtml(orgM[1]).trim() : "",
      location: tipM ? unescapeHtml(tipM[1]).trim() : (locM ? unescapeHtml(locM[1]).trim() : ""),
      workModel: /work from home|remote/i.test(rawWT) ? "Remote" : /hybrid/i.test(rawWT) ? "Hybrid" : /on.site|in.person/i.test(rawWT) ? "On-site" : "",
      jobType: /full.time/i.test(typeRaw) ? "Full-time" : /part.time/i.test(typeRaw) ? "Part-time" : /contract|temporary|casual|term/i.test(typeRaw) ? "Contract" : "",
      posted: null,
      expires,
      salary: "",
      url: "https://workinnonprofits.ca" + aM[1],
    });
  }
  return [...byId.values()];
}

async function fetchWinp() {
  const r = await fetchT("https://workinnonprofits.ca/jobs/list-by/region/9/nova-scotia", { headers: HEADERS });
  if (!r.ok) return [];
  return parseWinp(await r.text());
}

// ---- Job Bank (federal) Atom feed, NS filter ----
// NOTE: general NS feed, not charity-specific — entries are kept only
// when the employer matches the CRA registered-charity list.
function parseJobBank(xml) {
  const jobs = [];
  const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
  for (const e of entries) {
    const cdata = (re) => {
      const m = e.match(re);
      return m ? unescapeHtml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")).trim() : "";
    };
    const title = cdata(/<title[^>]*>([\s\S]*?)<\/title>/);
    const linkM = e.match(/<link[^>]*href="([^"]+)"/);
    const updM = e.match(/<updated>([^<]+)/);
    const summary = cdata(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    const empM = summary.match(/<strong>Employer:<\/strong>\s*([^<]+)/);
    const locM = summary.match(/<strong>Location:<\/strong>\s*([^<]+)/);
    const salM = summary.match(/<strong>Salary:<\/strong>\s*([^<]+)/);
    const employer = empM ? empM[1].trim() : "";
    // Drop public-sector health employers (checked on the raw name so the
    // "foundation" carve-out for IWK's charitable arm still works).
    if (!employer || BLOCKED_EMPLOYER_RE.test(employer)) continue;
    jobs.push({
      extId: "jb-" + (linkM ? linkM[1].split("/").pop() : normText(title).slice(0, 40)),
      title: title.charAt(0).toUpperCase() + title.slice(1),
      employer,
      location: locM ? locM[1].replace(/\s*\(NS\)\s*/i, "").trim() : "",
      workModel: "",
      jobType: "",
      posted: updM ? updM[1].slice(0, 10) : null,
      expires: null,
      salary: salM ? salM[1].trim() : "",
      url: linkM ? linkM[1] : "",
    });
  }
  return jobs;
}

async function fetchJobBank() {
  const r = await fetchT(
    "https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed?fprov=NS&rows=100&sort=D",
    { headers: HEADERS }
  );
  if (!r.ok) return [];
  return parseJobBank(await r.text());
}

// ---- CRA Charities Directorate: registered-charity identity via CKAN ----
const CKAN = "https://open.canada.ca/data/api/3/action/datastore_search";
const CKAN_RESOURCE = "694fdc72-eae4-4ee0-83eb-832ab7b230e3";

async function fetchCharityNames() {
  const chars = new Map(); // normalized -> display name
  const tokIndex = {};     // significant token -> [normalized names]
  const filters = encodeURIComponent(JSON.stringify({ Province: "NS" }));
  let offset = 0, total = Infinity;
  while (offset < total) {
    const u = `${CKAN}?resource_id=${CKAN_RESOURCE}&filters=${filters}&limit=1000&offset=${offset}`;
    const r = await fetchT(u, { headers: HEADERS });
    if (!r.ok) throw new Error("CKAN HTTP " + r.status);
    const j = await r.json();
    if (!j.success) throw new Error("CKAN API error");
    total = j.result.total;
    for (const rec of j.result.records) {
      for (const k of ["Legal Name", "Account Name"]) {
        const n = rec[k];
        if (!n) continue;
        const norm = normName(n);
        if (norm.length >= 4 && !chars.has(norm)) chars.set(norm, String(n).trim());
      }
    }
    offset += j.result.records.length;
    if (!j.result.records.length) break;
  }
  for (const norm of chars.keys()) {
    for (const tok of sigTokens(norm)) {
      (tokIndex[tok] = tokIndex[tok] || []).push(norm);
    }
  }
  return { chars: [...chars.entries()], tokIndex };
}

const STOP_TOKENS = new Set(["the", "of", "for", "and", "a", "an", "to", "in", "on", "de", "la", "le", "des", "du", "les", "un", "une", "et", "st"]);
function sigTokens(norm) {
  return norm.split(" ").filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

// True if every significant employer token matches the charity name, where a
// token matches either exactly or as the initials of consecutive charity
// words (covers acronyms: "spca" vs "society prevention cruelty animals").
function acronymVerify(empToks, chNorm) {
  const chToks = chNorm.split(" ");
  const initials = chToks.map((t) => t[0]).join("");
  let ti = 0;
  for (const et of empToks) {
    if (chToks.includes(et)) continue;
    let found = false;
    for (let i = 0; i < chToks.length && !found; i++) {
      let acc = "";
      for (let j = i; j < chToks.length && acc.length < et.length + 2; j++) {
        acc += chToks[j][0];
        if (acc === et) { found = true; break; }
      }
    }
    if (!found) return false;
  }
  return true;
}

// Known brand-name -> CRA legal-name mappings (verified), checked before
// algorithmic matching. Covers acronym brands the algorithm can't bridge.
const ALIASES = {
  "nova scotia spca": "nova scotia society for the prevention of cruelty",
  "united way halifax": "united way maritimes centraide des maritimes",
};

function matchCharity(employer, idx) {
  const base = (employer || "").replace(/\s+-\s+[A-Za-z][A-Za-z .&']*$/, "");
  const n = normName(base);
  if (!n) return null;
  const cmap = idx.cmap;
  const aliased = ALIASES[n];
  if (aliased && cmap.has(aliased)) return cmap.get(aliased);
  if (cmap.has(n)) return cmap.get(n);
  const parts = n.split(" ");
  for (let k = 0; k < 4 && parts.length > 2; k++) { // progressive trailing strip
    parts.pop();
    const t = parts.join(" ");
    if (cmap.has(t)) return cmap.get(t);
  }
  // token-overlap candidates via inverted index, then strict verification:
  // every significant employer token must match a charity word exactly or as
  // the initials of consecutive charity words. Single-token employers only
  // match exactly (avoids "Mariner" matching "River Bourgeois Mariner Society").
  const empToks = sigTokens(n);
  if (empToks.length < 2) return null;
  const need = empToks.length >= 3 ? 1 : 2;
  const counts = new Map();
  for (const tok of empToks) {
    const bucket = idx.tokIndex[tok];
    if (!bucket || bucket.length > 400) continue; // too generic to discriminate
    for (const cn of bucket) counts.set(cn, (counts.get(cn) || 0) + 1);
  }
  const cands = [...counts.entries()]
    .filter(([, c]) => c >= need)
    .sort((a, b) => b[1] - a[1])
    .map(([cn]) => cn)
    .slice(0, 80);
  for (const cn of cands) {
    if (acronymVerify(empToks, cn)) return cmap.get(cn);
  }
  return null;
}

// ---- Durable Object: all state lives here (SQLite) ----
class JobsDB {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS staging (source TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`);
  }
  kvGet(k) {
    const rows = this.sql.exec(`SELECT v FROM kv WHERE k = ?`, k).toArray();
    return rows.length ? rows[0].v : null;
  }
  kvSet(k, v) {
    this.sql.exec(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`, k, v);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/internal/status") {
      const meta = JSON.parse(this.kvGet("jobs_json") || '{"jobs":[],"meta":{}}');
      return Response.json({
        ok: true,
        count: meta.jobs ? meta.jobs.length : 0,
        updatedAt: meta.updatedAt || null,
        lastCharitySync: this.kvGet("charities_synced_at"),
      });
    }
    if (p === "/internal/jobs") {
      const body = this.kvGet("jobs_json") || '{"updatedAt":null,"count":0,"jobs":[]}';
      return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" } });
    }
    if (p === "/internal/sync") {
      const phase = url.searchParams.get("phase") || "all";
      // simple lock: skip if another sync started < 20 min ago
      const lock = this.kvGet("sync_lock");
      if (lock && Date.now() - parseInt(lock, 10) < 20 * 60 * 1000) {
        return Response.json({ ok: false, busy: true, phase });
      }
      this.kvSet("sync_lock", String(Date.now()));
      try {
        const result = await this.runPhase(phase);
        return Response.json({ ok: true, phase, ...result });
      } catch (err) {
        return Response.json({ ok: false, phase, error: String(err && err.message || err) }, { status: 500 });
      } finally {
        this.kvSet("sync_lock", "0");
      }
    }
    return new Response("not found", { status: 404 });
  }

  // One failing source must not block the others: each step is isolated,
  // and a failed source simply keeps its last good staging data.
  async runPhase(phase) {
    const errors = {};
    const step = async (name, fn) => {
      try {
        await fn();
      } catch (err) {
        errors[name] = String((err && err.message) || err);
      }
    };
    if (phase === "charities" || phase === "all") await step("charities", () => this.syncCharities());
    if (phase === "charityvillage" || phase === "all") await step("charityvillage", () => this.syncSource("charityvillage", fetchCharityVillage));
    if (phase === "winp" || phase === "all") await step("winp", () => this.syncSource("winp", fetchWinp));
    if (phase === "jobbank" || phase === "all") await step("jobbank", () => this.syncSource("jobbank", fetchJobBank));
    if (phase === "finalize" || phase === "all") await step("finalize", () => this.finalize());
    return { done: true, errors };
  }

  async syncCharities() {
    const last = this.kvGet("charities_synced_at");
    if (last && Date.now() - parseInt(last, 10) < 30 * 24 * 3600 * 1000) {
      return; // refresh monthly; the registry barely changes
    }
    const idx = await fetchCharityNames();
    this.kvSet("charities_json", JSON.stringify(idx));
    this.kvSet("charities_synced_at", String(Date.now()));
    this.kvSet("charities_count", String(idx.chars.length));
  }

  async syncSource(source, fn) {
    const jobs = await fn();
    this.sql.exec(`INSERT OR REPLACE INTO staging (source, data, updated_at) VALUES (?, ?, ?)`,
      source, JSON.stringify(jobs), new Date().toISOString());
  }

  async finalize() {
    const idxRaw = JSON.parse(this.kvGet("charities_json") || '{"chars":[],"tokIndex":{}}');
    const idx = { cmap: new Map(idxRaw.chars), tokIndex: idxRaw.tokIndex || {} };
    const all = [];
    for (const row of this.sql.exec(`SELECT source, data FROM staging`).toArray()) {
      try {
        for (const j of JSON.parse(row.data)) { j._src = row.source; all.push(j); }
      } catch { /* ignore corrupt staging row */ }
    }
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const seen = new Map();
    for (const j of all) {
      if (!j.title || !j.employer) continue;
      if (j.expires && j.expires < today) continue;               // expired
      if (!j.expires && j.posted) {                              // stale w/o expiry
        const ageDays = (now - new Date(j.posted + "T00:00:00Z")) / 86400000;
        if (ageDays > 60) continue;
      }
      const key = dedupeKey(j);
      const ex = seen.get(key);
      if (ex) {
        if (j.posted && (!ex.posted || j.posted < ex.posted)) ex.posted = j.posted;
        if (j.expires && (!ex.expires || j.expires > ex.expires)) ex.expires = j.expires;
        if (!ex.salary && j.salary) ex.salary = j.salary;
        if (!ex.workModel && j.workModel) ex.workModel = j.workModel;
        if (!ex.jobType && j.jobType) ex.jobType = j.jobType;
        ex.links.push({ source: j._src, url: j.url });
        if (!ex.sources.includes(j._src)) ex.sources.push(j._src);
      } else {
        const geo = geocodeCity(j.location);
        seen.set(key, {
          id: j.extId,
          title: j.title,
          employer: j.employer,
          location: j.location,
          lat: geo ? geo[0] : null,
          lng: geo ? geo[1] : null,
          workModel: j.workModel || "",
          jobType: j.jobType || "",
          posted: j.posted || null,
          expires: j.expires || null,
          salary: j.salary || "",
          links: [{ source: j._src, url: j.url }],
          sources: [j._src],
        });
      }
    }
    const jobs = [];
    for (const j of seen.values()) {
      const charityName = matchCharity(j.employer, idx);
      if (j.sources.length === 1 && j.sources[0] === "jobbank" && !charityName) continue; // Job Bank is general; keep only charity-verified
      j.charity = !!charityName;
      j.charityName = charityName;
      jobs.push(j);
    }
    jobs.sort((a, b) => {
      if (!a.posted && !b.posted) return a.title.localeCompare(b.title);
      if (!a.posted) return 1;
      if (!b.posted) return -1;
      return b.posted < a.posted ? -1 : b.posted > a.posted ? 1 : 0;
    });
    this.kvSet("jobs_json", JSON.stringify({ updatedAt: now.toISOString(), count: jobs.length, jobs }));
  }
}

const PHASES = ["charities", "charityvillage", "winp", "jobbank", "finalize"];

async function runAllPhases(env) {
  const stub = env.JOBS_DB.get(env.JOBS_DB.idFromName(DB_NAME));
  const results = [];
  for (const phase of PHASES) {
    try {
      const r = await stub.fetch("https://internal/internal/sync?phase=" + phase);
      const body = await r.text();
      results.push({ phase, status: r.status, body: body.slice(0, 300) });
    } catch (err) {
      // Never let one phase break the chain; finalize must still run.
      results.push({ phase, status: "dispatch-error", body: String((err && err.message) || err).slice(0, 300) });
    }
  }
  return results;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/jobs") {
      const stub = env.JOBS_DB.get(env.JOBS_DB.idFromName(DB_NAME));
      return stub.fetch("https://internal/internal/jobs");
    }
    if (url.pathname === "/api/status") {
      const stub = env.JOBS_DB.get(env.JOBS_DB.idFromName(DB_NAME));
      return stub.fetch("https://internal/internal/status");
    }
    if (url.pathname === "/api/admin/sync") {
      if (url.searchParams.get("key") !== env.ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      ctx.waitUntil(runAllPhases(env)); // runs ~40s in background; data appears when done
      return Response.json({ ok: true, started: true, note: "sync running in background; check /api/status in about a minute" });
    }
    return env.ASSETS.fetch(request);
  },

  // Daily cron: phases run as separate DO invocations so each stays
  // well inside the free-plan CPU budget (fetches are I/O, not CPU).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllPhases(env));
  },
};
