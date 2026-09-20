# NS Charity Jobs

Automatic aggregator of **current job openings at charities in Nova Scotia**.
Runs itself: a daily cron refreshes listings, and the site + JSON API are served
from the same Cloudflare Worker.

Live site: `https://ns-charity-jobs.waraichinstitute.workers.dev`

## How it works

One Cloudflare Worker (`src/worker.js`) + one Durable Object (`JobsDB`, SQLite storage).
No KV/R2/D1 to provision — the DO is created from `wrangler.toml` on deploy.

**Daily cron** (`0 10 * * *` UTC = 7:00 AM ADT) runs five phases through the DO,
each as its own invocation to stay inside the free-plan CPU budget:

1. `charities` — pulls the CRA Charities Directorate open-data list via the CKAN
   API (`Province=NS`, ~3,700 charities, refreshed monthly) and builds a normalized
   name index with an inverted token index for fuzzy matching.
2. `charityvillage` — scrapes `charityvillage.com/jobs/nova-scotia` (all pages,
   10s between requests per their `Crawl-delay`).
3. `winp` — scrapes `workinnonprofits.ca` Nova Scotia region listing.
4. `jobbank` — reads the federal Job Bank Atom feed (`fprov=NS`); entries are
   kept **only** when the employer matches the CRA charity registry (it's a
   general job feed otherwise).
5. `finalize` — normalizes, dedupes across sources by (employer, title, city),
   drops expired postings (or >60 days old with no expiry), badges employers
   verified against the CRA registry, and writes the final JSON.

**Politeness / hygiene:** identifiable bot user-agent, each source polled at most
once per day, aggressive caching, and only metadata is stored
(title/employer/location/work-model/dates/salary + link back to the original
posting) — full job descriptions are never republished.

## Endpoints

- `GET /` — the frontend (static assets in `public/`).
- `GET /api/jobs` — `{ updatedAt, count, jobs: [...] }`.
- `GET /api/status` — sync health (`count`, `updatedAt`, `lastCharitySync`).
- `GET /api/admin/sync?key=ADMIN_KEY` — trigger a full refresh manually
  (runs ~1–2 min in the background; key is in `wrangler.toml`).

## Deploy

Via Cloudflare Workers Builds (GitHub-connected), same as the BandMate project:

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → connect the repo.
   `wrangler.toml` supplies the Durable Object, the cron trigger and the
   static assets — no manual binding setup needed.
3. After the first deploy, hit `/api/admin/sync?key=…` once and wait ~2 minutes,
   then open the site. The daily cron takes over from there.

## Local test

`wrangler dev` serves the site + API, but this sandbox's workerd build can't do
outbound TLS, so the sync phases were verified with a Node harness instead
(`/tmp/harness.mjs` pattern): real network fetches against all four sources
through a faithful in-memory shim of the DO's SQLite usage — 34 listings,
7 charity badges, 0 false positives on the last run.

## Notes / limits (v1)

- CharityVillage's Terms prohibit scraping; the user explicitly accepted that
  risk for this personal-use project. If they ever grant/deny permission, flip
  the source on/off in `PHASES`.
- The "registered charity" badge uses the **NS-filtered** CRA registry, so
  national charities hiring in NS (e.g. Canadian Cancer Society) list but don't
  badge. Conservative matching: single-word employers only badge on exact match.
- IWK Health / Nova Scotia Health employers are excluded from Job Bank results
  (public-sector, not charities); the IWK charitable foundation is not excluded.
