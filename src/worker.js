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
    const r = await fetch(u, { headers: HEADERS });
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
  const r = await fetch("https://workinnonprofits.ca/jobs/list-by/region/9/nova-scotia", { headers: HEADERS });
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
  const r = await fetch(
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
    const r = await fetch(u, { headers: HEADERS });
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

  async runPhase(phase) {
    if (phase === "charities" || phase === "all") await this.syncCharities();
    if (phase === "charityvillage" || phase === "all") await this.syncSource("charityvillage", fetchCharityVillage);
    if (phase === "winp" || phase === "all") await this.syncSource("winp", fetchWinp);
    if (phase === "jobbank" || phase === "all") await this.syncSource("jobbank", fetchJobBank);
    if (phase === "finalize" || phase === "all") await this.finalize();
    return { done: true };
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
        seen.set(key, {
          id: j.extId,
          title: j.title,
          employer: j.employer,
          location: j.location,
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
    const r = await stub.fetch("https://internal/internal/sync?phase=" + phase);
    results.push({ phase, status: r.status, body: await r.text() });
    if (r.status !== 200) break;
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
