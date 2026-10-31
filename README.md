# Lastping

**Know when your jobs stop running.** Heartbeat, cron and uptime monitoring that runs entirely on Cloudflare's edge, for $0.

[![status](https://lastping.a2a-cloud.workers.dev/badge/lastping-demo.svg)](https://lastping.a2a-cloud.workers.dev/s/lastping-demo)
[![ci](https://github.com/youssef-110/lastping/actions/workflows/ci.yml/badge.svg)](https://github.com/youssef-110/lastping/actions/workflows/ci.yml)

- **Live app:** https://lastping.a2a-cloud.workers.dev
- **Live status page** (my own deployed projects, monitored by Lastping): https://lastping.a2a-cloud.workers.dev/s/lastping-demo

Cron jobs, backups, scrapers and queue workers fail silently: nothing errors, they just stop. Lastping turns that silence into an alert. A job pings a URL when it finishes. If the ping doesn't arrive on schedule, the check goes **late**, then **down**, and you get a Discord, Slack, ntfy (phone push) or webhook alert. It also probes websites over HTTP every minute, and publishes a status page and README badge for each project.

No signup: create a project, get a key, start pinging.

## Usage

```bash
# simplest: ping when the job succeeds
0 3 * * *  ./backup.sh && curl -fsS -m 10 https://lastping.a2a-cloud.workers.dev/ping/<check-id>

# report the exit code, so a failure alerts immediately instead of after the grace period
0 3 * * *  ./backup.sh; curl -fsS -m 10 https://lastping.a2a-cloud.workers.dev/ping/<check-id>/$?

# measure run time, and attach the log tail when it fails
curl -fsS https://…/ping/<id>/start
./job.sh && curl -fsS https://…/ping/<id> || curl -fsS --data-raw "$(tail -c 900 job.log)" https://…/ping/<id>/fail
```

| Endpoint | Meaning |
|---|---|
| `GET/POST/HEAD /ping/:id` | success |
| `/ping/:id/start` | job started (enables run-time measurement) |
| `/ping/:id/fail` | job failed: alert now (POST body is kept as the log) |
| `/ping/:id/:exitCode` | `0` = success, anything else = fail |
| `/s/:slug` | public status page, 90-day uptime history |
| `/badge/:slug.svg` | status badge for READMEs |

## How it works

```
 cron job / CI / worker ──ping──▶ ┌────────────────────────────┐
                                  │  Worker (fetch handler)    │──▶ D1 (SQLite)
 browser dashboard ──REST API──▶  │  routes · auth · validation│     checks · events · projects
                                  └────────────────────────────┘
                                  ┌────────────────────────────┐
 Cron Trigger, every minute ───▶  │  Worker (scheduled sweep)  │──▶ HTTP probes (≤40 per run)
                                  │  late/down detection       │──▶ Discord / Slack / ntfy / webhook
                                  └────────────────────────────┘
```

The core is a set of **pure modules with no I/O**. The Worker only loads rows, calls them and persists what they return:

- **`src/cron.ts`**: a five-field cron parser and next-run calculator written from scratch. It handles lists, ranges, steps, month and day names, `@daily`-style macros, and Vixie-cron day semantics (when both day-of-month and day-of-week are restricted, *either* may match). Instead of scanning minute by minute it skips whole months, days and hours that cannot match, and it detects schedules that never fire (`0 0 30 2 *`).
- **`src/monitor.ts`**: the check state machine (`new → up → late → down`, plus `paused`). Every function returns `{patch, event, transition}`, and only a transition sends an alert, so an outage produces exactly one *down* and one *up* message. HTTP checks need **two consecutive failures** before going down (flap damping).
- **Uptime is rebuilt from transitions alone.** Only `up`/`down` events are kept forever. Per-day uptime is computed by clipping down-intervals to day buckets, including outages that span midnight. The sweep writes nothing for healthy checks.

### Engineering for the free tier

Cloudflare Workers free plan: 100k requests/day, 50 subrequests per invocation, D1 at 100k writes/day. The design follows those numbers:

- The minute sweep only reads checks whose deadline has passed (`due_at <= now`, partial index), so its cost tracks *due* checks, not *all* checks.
- Healthy HTTP probes write one row update and no event. Only failures and transitions are logged.
- At most 40 probes run per sweep, below the 50-subrequest cap. Each has a 10 s timeout and runs in parallel.
- Noisy events (pings, starts, probe failures) are trimmed after 30 days by an hourly housekeeping pass. Transitions stay forever.
- Abuse limits: 5 projects per IP per day, 25 checks per project, 10 test alerts per hour, and size caps on every field.
- Outbound safety: probe and alert URLs must use public hostnames. IP literals, localhost-style and `.internal` names, and Lastping's own host are rejected. Redirects are not followed. Discord alerts disable mentions, so a check named `@everyone` pings nobody.

### Security model

There are no accounts and no personal data. Creating a project returns a random 192-bit key. Only its SHA-256 hash is stored, and the dashboard keeps the key in `localStorage`. You can move it to another device with a link that carries the key in the URL fragment, which browsers never send to the server. Check IDs are random UUIDs, and knowing one only lets you report pings for that check. Status pages show only checks marked public, and never their IDs.

## Tests

```bash
npm test        # vitest: cron parser, state machine, uptime math
npm run typecheck
```

The cron tests include a **property test**: 150 random expressions, each checked against a brute-force minute-by-minute search. The state-machine tests include a fuzz run of 2,000 random probe results that asserts alerts alternate strictly *down/up* with no duplicates.

## Run it yourself

```bash
npm install
npx wrangler d1 create lastping          # put the id in wrangler.jsonc
npm run db:init:local
npm run dev                               # http://localhost:8787, `curl "localhost:8787/__scheduled?cron=*+*+*+*+*"` runs a sweep
npx wrangler d1 execute lastping --remote --file=schema.sql
npm run deploy                            # set PUBLIC_URL in wrangler.jsonc first
```

## Roadmap

- Time zones for cron schedules (currently UTC)
- Email alerts and multiple alert channels per project
- Optional accounts and teams; paid tier with more checks, 1-minute heartbeats and SMS
- Multi-region probes, so a check only goes down when several locations agree

## Why I built it

I run around ten side projects on free tiers, and more than once one died quietly for days before I noticed. Lastping monitors all of them now; its status page is linked above. A [council of reviewer agents](docs/COUNCIL.md) helped choose this project over two alternatives.

MIT licensed.
