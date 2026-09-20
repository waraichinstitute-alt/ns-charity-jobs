var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var UA = "NSCharityJobsBot/1.0 (+https://ns-charity-jobs.waraichinstitute.workers.dev; personal research project, contact via site)";
var HEADERS = { "User-Agent": UA, "Accept": "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8" };
var DB_NAME = "main";
var sleep = /* @__PURE__ */ __name((ms) => new Promise((r) => setTimeout(r, ms)), "sleep");
function unescapeHtml(s) {
  return (s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&#x27;/gi, "'").replace(/&nbsp;/g, " ");
}
__name(unescapeHtml, "unescapeHtml");
var SUFFIXES = /* @__PURE__ */ new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "ltd",
  "limited",
  "society",
  "societies",
  "association",
  "assoc",
  "foundation",
  "charities",
  "charity",
  "trust",
  "fund",
  "centre",
  "center",
  "organization",
  "organisation",
  "club",
  "services",
  "service",
  "network",
  "cooperative",
  "coop",
  "alliance",
  "coalition"
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
__name(normName, "normName");
function normText(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
__name(normText, "normText");
function cityOf(loc) {
  return normText((loc || "").split(",")[0]);
}
__name(cityOf, "cityOf");
function dedupeKey(j) {
  return normName(j.employer) + "|" + normText(j.title) + "|" + cityOf(j.location);
}
__name(dedupeKey, "dedupeKey");
var BLOCKED_EMPLOYER_RE = /iwk health(?!.*foundation)|nova scotia health|nshealth/i;
var FIELD_GUARD = "(?:(?!jcl-job-teaser-(?:location|remote|company|salary))[\\s\\S])*?";
function teaserField(c, cls, wrap) {
  const re = new RegExp(cls + '"' + FIELD_GUARD + "<\\/svg><\\/span>" + (wrap || "") + "([^<]+)");
  const m = c.match(re);
  return m ? unescapeHtml(m[1]).replace(/\s+/g, " ").trim() : "";
}
__name(teaserField, "teaserField");
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
      url: urlM ? "https://www.charityvillage.com" + urlM[1] : ""
    });
  }
  return jobs;
}
__name(parseCharityVillage, "parseCharityVillage");
async function fetchCharityVillage() {
  const jobs = [];
  for (let page = 1; page <= 8; page++) {
    if (page > 1) await sleep(1e4);
    const u = "https://www.charityvillage.com/jobs/nova-scotia" + (page > 1 ? "?page=" + page : "");
    const r = await fetch(u, { headers: HEADERS });
    if (!r.ok) break;
    const parsed = parseCharityVillage(await r.text());
    if (!parsed.length) break;
    jobs.push(...parsed);
  }
  return jobs;
}
__name(fetchCharityVillage, "fetchCharityVillage");
function parseWinp(html) {
  const byId = /* @__PURE__ */ new Map();
  const cards = html.split("<div id=");
  for (const c of cards) {
    if (!c.includes("job_item")) continue;
    const idM = c.match(/^\s*"(\d+)"/);
    if (!idM) continue;
    const id = idM[1];
    const aM = c.match(/lj_title[^>]*><a href="(\/jobs\/view\/\d+\/([EF])\/[^"]+)">([^<]+)<\/a>/);
    if (!aM) continue;
    const isEnglish = aM[2] === "E";
    if (byId.has(id) && !isEnglish) continue;
    const dateM = c.match(/lj_date[^>]*>([^<]+)/);
    const orgM = c.match(/lj_org">([^<]+)/);
    const tipM = c.match(/winp_tooltip" title="([^"]+)"/);
    const locM = c.match(/lj_loc">([^<]+)/);
    const wtM = c.match(/<b>([^<]+)<\/b>\s*\|\s*([^<]+)</);
    let expires = null;
    const closes = dateM ? unescapeHtml(dateM[1]).trim().toLowerCase() : "";
    const dm = closes.match(/closes in (\d+) days?/);
    if (dm) {
      const d = /* @__PURE__ */ new Date();
      d.setDate(d.getDate() + parseInt(dm[1], 10));
      expires = d.toISOString().slice(0, 10);
    } else if (closes.includes("closes today")) {
      expires = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    } else if (closes.includes("closes tomorrow")) {
      const d = /* @__PURE__ */ new Date();
      d.setDate(d.getDate() + 1);
      expires = d.toISOString().slice(0, 10);
    }
    const rawWT = (wtM ? wtM[1] : "") + " " + (wtM ? wtM[2] : "");
    const typeRaw = wtM ? unescapeHtml(wtM[2]).trim() : "";
    byId.set(id, {
      extId: "winp-" + id,
      title: unescapeHtml(aM[3]).trim(),
      employer: orgM ? unescapeHtml(orgM[1]).trim() : "",
      location: tipM ? unescapeHtml(tipM[1]).trim() : locM ? unescapeHtml(locM[1]).trim() : "",
      workModel: /work from home|remote/i.test(rawWT) ? "Remote" : /hybrid/i.test(rawWT) ? "Hybrid" : /on.site|in.person/i.test(rawWT) ? "On-site" : "",
      jobType: /full.time/i.test(typeRaw) ? "Full-time" : /part.time/i.test(typeRaw) ? "Part-time" : /contract|temporary|casual|term/i.test(typeRaw) ? "Contract" : "",
      posted: null,
      expires,
      salary: "",
      url: "https://workinnonprofits.ca" + aM[1]
    });
  }
  return [...byId.values()];
}
__name(parseWinp, "parseWinp");
async function fetchWinp() {
  const r = await fetch("https://workinnonprofits.ca/jobs/list-by/region/9/nova-scotia", { headers: HEADERS });
  if (!r.ok) return [];
  return parseWinp(await r.text());
}
__name(fetchWinp, "fetchWinp");
function parseJobBank(xml) {
  const jobs = [];
  const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
  for (const e of entries) {
    const cdata = /* @__PURE__ */ __name((re) => {
      const m = e.match(re);
      return m ? unescapeHtml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")).trim() : "";
    }, "cdata");
    const title = cdata(/<title[^>]*>([\s\S]*?)<\/title>/);
    const linkM = e.match(/<link[^>]*href="([^"]+)"/);
    const updM = e.match(/<updated>([^<]+)/);
    const summary = cdata(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    const empM = summary.match(/<strong>Employer:<\/strong>\s*([^<]+)/);
    const locM = summary.match(/<strong>Location:<\/strong>\s*([^<]+)/);
    const salM = summary.match(/<strong>Salary:<\/strong>\s*([^<]+)/);
    const employer = empM ? empM[1].trim() : "";
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
      url: linkM ? linkM[1] : ""
    });
  }
  return jobs;
}
__name(parseJobBank, "parseJobBank");
async function fetchJobBank() {
  const r = await fetch(
    "https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed?fprov=NS&rows=100&sort=D",
    { headers: HEADERS }
  );
  if (!r.ok) return [];
  return parseJobBank(await r.text());
}
__name(fetchJobBank, "fetchJobBank");
var CKAN = "https://open.canada.ca/data/api/3/action/datastore_search";
var CKAN_RESOURCE = "694fdc72-eae4-4ee0-83eb-832ab7b230e3";
async function fetchCharityNames() {
  const chars = /* @__PURE__ */ new Map();
  const tokIndex = {};
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
__name(fetchCharityNames, "fetchCharityNames");
var STOP_TOKENS = /* @__PURE__ */ new Set(["the", "of", "for", "and", "a", "an", "to", "in", "on", "de", "la", "le", "des", "du", "les", "un", "une", "et", "st"]);
function sigTokens(norm) {
  return norm.split(" ").filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}
__name(sigTokens, "sigTokens");
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
        if (acc === et) {
          found = true;
          break;
        }
      }
    }
    if (!found) return false;
  }
  return true;
}
__name(acronymVerify, "acronymVerify");
var ALIASES = {
  "nova scotia spca": "nova scotia society for the prevention of cruelty",
  "united way halifax": "united way maritimes centraide des maritimes"
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
  for (let k = 0; k < 4 && parts.length > 2; k++) {
    parts.pop();
    const t = parts.join(" ");
    if (cmap.has(t)) return cmap.get(t);
  }
  const empToks = sigTokens(n);
  if (empToks.length < 2) return null;
  const need = empToks.length >= 3 ? 1 : 2;
  const counts = /* @__PURE__ */ new Map();
  for (const tok of empToks) {
    const bucket = idx.tokIndex[tok];
    if (!bucket || bucket.length > 400) continue;
    for (const cn of bucket) counts.set(cn, (counts.get(cn) || 0) + 1);
  }
  const cands = [...counts.entries()].filter(([, c]) => c >= need).sort((a, b) => b[1] - a[1]).map(([cn]) => cn).slice(0, 80);
  for (const cn of cands) {
    if (acronymVerify(empToks, cn)) return cmap.get(cn);
  }
  return null;
}
__name(matchCharity, "matchCharity");
var JobsDB = class {
  static {
    __name(this, "JobsDB");
  }
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
        lastCharitySync: this.kvGet("charities_synced_at")
      });
    }
    if (p === "/internal/jobs") {
      const body = this.kvGet("jobs_json") || '{"updatedAt":null,"count":0,"jobs":[]}';
      return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" } });
    }
    if (p === "/internal/sync") {
      const phase = url.searchParams.get("phase") || "all";
      const lock = this.kvGet("sync_lock");
      if (lock && Date.now() - parseInt(lock, 10) < 20 * 60 * 1e3) {
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
    if (last && Date.now() - parseInt(last, 10) < 30 * 24 * 3600 * 1e3) {
      return;
    }
    const idx = await fetchCharityNames();
    this.kvSet("charities_json", JSON.stringify(idx));
    this.kvSet("charities_synced_at", String(Date.now()));
    this.kvSet("charities_count", String(idx.chars.length));
  }
  async syncSource(source, fn) {
    const jobs = await fn();
    this.sql.exec(
      `INSERT OR REPLACE INTO staging (source, data, updated_at) VALUES (?, ?, ?)`,
      source,
      JSON.stringify(jobs),
      (/* @__PURE__ */ new Date()).toISOString()
    );
  }
  async finalize() {
    const idxRaw = JSON.parse(this.kvGet("charities_json") || '{"chars":[],"tokIndex":{}}');
    const idx = { cmap: new Map(idxRaw.chars), tokIndex: idxRaw.tokIndex || {} };
    const all = [];
    for (const row of this.sql.exec(`SELECT source, data FROM staging`).toArray()) {
      try {
        for (const j of JSON.parse(row.data)) {
          j._src = row.source;
          all.push(j);
        }
      } catch {
      }
    }
    const now = /* @__PURE__ */ new Date();
    const today = now.toISOString().slice(0, 10);
    const seen = /* @__PURE__ */ new Map();
    for (const j of all) {
      if (!j.title || !j.employer) continue;
      if (j.expires && j.expires < today) continue;
      if (!j.expires && j.posted) {
        const ageDays = (now - /* @__PURE__ */ new Date(j.posted + "T00:00:00Z")) / 864e5;
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
          sources: [j._src]
        });
      }
    }
    const jobs = [];
    for (const j of seen.values()) {
      const charityName = matchCharity(j.employer, idx);
      if (j.sources.length === 1 && j.sources[0] === "jobbank" && !charityName) continue;
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
};
var PHASES = ["charities", "charityvillage", "winp", "jobbank", "finalize"];
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
__name(runAllPhases, "runAllPhases");
var worker_default = {
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
      ctx.waitUntil(runAllPhases(env));
      return Response.json({ ok: true, started: true, note: "sync running in background; check /api/status in about a minute" });
    }
    return env.ASSETS.fetch(request);
  },
  // Daily cron: phases run as separate DO invocations so each stays
  // well inside the free-plan CPU budget (fetches are I/O, not CPU).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllPhases(env));
  }
};

// ../bandmate-cloudflare/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../bandmate-cloudflare/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-pvaCUK/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../bandmate-cloudflare/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-pvaCUK/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  JobsDB,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
