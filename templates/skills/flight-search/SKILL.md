---
name: flight-search
description: Scrape live flight prices and itineraries from Google Flights via headless Chromium. Use for any "find flights from X to Y on date" task, daily price monitoring for upcoming bookings, comparing routes for event attendees, or providing pre-booking shortlists. Outputs structured JSON (price, airlines, stops, times, layovers).
---

# Flight Search (headless scraper)

## When to use
- Pre-booking shortlist for any traveler (anyone) on a specific route + date pair.
- Daily price monitoring on an unbooked trip — set up a cron-style daily scan and watch for "price climbing fast" or "low seat count" signals.
- "What does it cost from city A to city B next month" style fact-finding without burning an approval slot.
- Comparing baseline route options when reviewing an out-of-policy approval request.

Do NOT use this for actual bookings — bookings go through whatever channel your organization requires. This tool is for price/options recon only.

## Procedure (procedure)

1. **One-shot search**:
   ```bash
   cd <agent dir>/tools/flight-scraper
   node scrape.js --origin AAA --dest BBB --depart 2026-01-10 --return 2026-01-17 --max 8
   ```
   Flags:
   - `--origin` / `--dest`: 3-letter IATA codes (uppercased automatically)
   - `--depart` / `--return`: ISO dates `YYYY-MM-DD`. Omit `--return` for one-way.
   - `--max N`: cap on results (default 8)
   - `--debug`: dumps a screenshot + HTML into `./debug/` for selector troubleshooting
   - `--headful`: visible browser (debugging only — Chromium needs an X server)

   Output is a JSON object on stdout: `{ query, scraped_at, source, count, flights: [...] }`. Each flight has `price_eur`, `stops`, `airlines`, `depart_time`, `arrive_time`, `duration`, `layover`, plus the original aria-label in `raw`.

2. **Daily monitor for a specific trip**: copy
   `monitor-<name>-<route>.sh` as a template, edit the origin/dest/dates,
   and either trigger it via the Marveen scheduler or by direct cron.

3. **Reading results for a recommendation**: pick the top 3 by this priority:
   - cheapest direct (if any exists for the day)
   - cheapest 1-stop with layover ≤ 3 hr and total duration ≤ 6 hr
   - any premium option (lounge access, better times) within ~<amt> EUR of the cheapest reasonable option

   Skip anything with an overnight layover (>5 hr) unless the traveler has
   explicitly asked for one — the scraper will surface them as "cheapest"
   because Google sorts by price, not sanity.

## Pitfalls (pitfalls)

- **Google's aria-label format shifts.** The parser keys off
  `"From N euros round trip total. STOPS flight with AIRLINES. Leaves ... at TIME on DATE and arrives at ... at TIME on DATE. Total duration HH hr MM min."`
  If a future scrape returns `count: 0`, run with `--debug` and grep the saved
  HTML for `aria-label="From` — if the wording changed, patch the regex in
  `scrape.js` (`departMatch`, `arriveMatch`, `durationMatch`).
- **Round-trip price includes the cheapest return.** The displayed price is
  outbound + cheapest connecting return Google found. The arrive_time fields
  refer to the outbound leg only. Drilling into specific return options needs
  a second scrape with the outbound time prefilled — not yet implemented.
- **Consent wall.** The script pre-seeds `SOCS` and `CONSENT` cookies for
  `.google.com` so we land directly on results. If Google rotates the consent
  cookie name, the script will hang on a "Before you continue" page — re-grab
  fresh cookies from a manual browser session.
- **Headless detection.** If Google starts serving a captcha (the HTML will
  contain "unusual traffic detected"), rotate the user-agent in `scrape.js`
  or fall back to a residential proxy. So far no captcha hit.

## Verification (validation)

- `count > 0` and at least one flight has a non-null `airlines` field.
- `price_eur` is within a sane band (10 to <amt> EUR — anything outside
  suggests a parser glitch).
- `depart_date` matches the requested `--depart` day-of-week.
- For monitoring jobs: compare against the previous snapshot in
  `snapshots/<trip-id>/` — if cheapest option rose by >15% day-over-day OR
  count dropped to ≤ 3 results, escalate to Michael immediately (low
  availability is the precursor to a price spike).

## Related
