# Why Lastping: project selection record

Four reviewer perspectives (Strategist, Scout, Architect, Skeptic) were each asked independently to propose a project. The goals: distinct from my existing repos (which are mostly LLM and agent tooling), something I would use daily, a plausible startup, $0 to run, and shippable in one session.

## Shortlist

| Rank | Project | For | Against |
|---|---|---|---|
| 1 | **Lastping**: heartbeat, cron and uptime monitor | Used daily for my own ~10 deployed projects; proven paid market (Healthchecks.io, Cronitor); reliability engineering (scheduling, state machines, alert de-duplication); no runtime LLM or PII | Crowded market, so the angle has to be free-tier-native, no signup, EU-friendly |
| 2 | Driftpad: local-first notes with a hand-written CRDT on Durable Objects | Strongest "walk me through it" interview topic | Weaker daily pull and startup case; a correct CRDT plus editor is risky to finish in one session |
| 3 | Quota: one dashboard of free-tier limits across Vercel, Cloudflare, Neon and Supabase | Real pain I have | Must store users' provider API tokens (encryption and trust burden); provider APIs differ a lot |

Rejected by the Skeptic's criteria: Berlin appointment-slot watchers (bot detection, ToS), AI resume tools (paid APIs, PII), and marketplaces (empty without network effects).

## Criteria the pick had to pass

1. No secrets or paid APIs at runtime.
2. No personal data stored on a server.
3. Useful to the first visitor, with a live demo seeded with real data.
4. Anonymous writes rate-limited and size-capped.
5. A technically deep core beyond glue code. Here that is a cron parser written from scratch, with property tests, and a pure state machine with fuzz tests.
6. A plausible paid tier later.

## Decision

Lastping, with the Architect's requirement folded in: the scheduling and state logic is written from scratch as pure, tested modules, not pulled from a library.
