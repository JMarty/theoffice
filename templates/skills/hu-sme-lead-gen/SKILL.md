---
name: hu-sme-lead-gen
description: Generate, qualify, and draft first-touch outreach for Hungarian SME leads. Use when Owner, Jim, or a business-side agent needs a B2B lead list for a Hungarian small/medium business — given an ideal-customer brief (industry, region, company size), produce a ranked, deduped, qualified lead list with Hungarian-language openers. This is the "Hunter" wedge skill. Triggers on "find leads for", "lead-gen", "ügyfélkeresés", "leadlista", "prospect list for a Hungarian company".
---

# Hungarian SME Lead Generation

## When to use

- A Hungarian SME needs a B2B prospect list
- Owner or Jim says "find leads for [business]", "build a lead list", "ügyfélkeresés", "kik lehetnének ügyfelek"
- A pilot customer wants the Hunter role demonstrated
- NOT for B2C / consumer marketing — this is B2B, Hungarian-company-to-company

## Inputs you need (ask if missing)

1. **Who is the client** (the business doing the outreach) — what do they sell, what's their value prop
2. **Ideal customer profile**: industry / TEAOR area, region (Budapest, Pest megye, országos), company size band (micro 1-9, small 10-49, medium 50-249)
3. **Volume**: how many leads (default 20-30 for a first pass)
4. **Outreach channel**: email, LinkedIn, phone — affects the opener format

If the brief is vague ("find me customers"), ask 2-3 sharp questions before running. A bad brief makes a bad list.

## Procedure

1. **Lock the ICP.** Write a one-line ideal-customer definition before searching. Everything filters against it.

2. **Source candidates.** Pull Hungarian companies from:
   - e-cegjegyzek.hu (official company registry — name, seat, activity, status)
   - opten.hu / companywall.hu (financials, signals, contact)
   - Industry directories, chamber lists, Google Maps for local/regional
   - Use WebSearch + browser; if a source blocks automated fetch, note it and use an alternate
   - Capture for each: company name, TEAOR/activity, seat/region, rough size signal, status (must be aktív — skip felszámolás/végelszámolás/törölt)

3. **Qualify against the ICP.** Score each candidate:
   - Size band match (from headcount/revenue signals)
   - Activity match (TEAOR + what they actually do)
   - Status: active only, no insolvency proceedings
   - Need signal: is there a visible reason they'd want what the client sells
   - Drop anything that fails status or is a clear mismatch. Dedup by tax number / name.

4. **Rank.** Order by fit strength. Top of list = highest-confidence, clearest-need.

5. **Draft Hungarian first-touch opener per lead** (see references/hu-outreach-etiquette.md). Personalize the first line to the specific company — never a mail-merge feel. Magázódás by default. Short, concrete, one clear ask.

6. **Output** a clean table: rank | company | region | size | why-they-fit | status | + the per-lead opener. Plus a one-line "what I'd do next" (e.g. which 3 to call first).

## Pitfalls (pitfalls)

- **Status check is non-negotiable.** A lead in felszámolás/végelszámolás/törölt is worse than no lead — it signals you didn't check. Always verify aktív status.
- **No American cold-email energy.** Hungarian B2B outreach is more formal, less hype, magázódás. "Forradalmasítjuk a működését!" kills the email. See references file.
- **Don't invent contact data.** If you can't find a real email/phone, say so and mark it "contact unknown — needs lookup", never fabricate an address.
- **Don't invent company facts.** If financials/size aren't findable, mark as estimate or unknown. A wrong "50 fős cég" claim in the opener destroys credibility.
- **Dedup by adószám, not name.** Same company can appear under slightly different names across sources.
- **GDPR sanity:** B2B company contact data is fine for legitimate outreach; don't scrape/store personal data of named individuals beyond a public business contact.
- **Sourcing bottleneck (learned in practice):** WebSearch + site-fetch reliably returns real company names, public emails, services, and location — but NOT verified headcount, aktív cégjegyzék status, or adószám. For a large qualified list you need a real company-data source (Cégtár API, opten, e-cégjegyzék bulk). Without it, produce a SMALL high-confidence list and flag each lead for what still needs verification, rather than padding to the requested volume with unverified guesses. A short honest list beats a long unverifiable one.

## Verification (validation)

- Every lead on the list is aktív status (spot-check 3-5 against e-cegjegyzek)
- No duplicate adószám
- Each opener references something specific about that company (not generic)
- Openers are magázódás, no em dash, no hype clichés, one clear ask
- The list is ranked, and the top 3 have the clearest need-fit
- A real human could send the top opener as-is without editing

## Output ownership

This is the Hunter role made concrete. When run for a pilot SME, log the result and the customer's reaction (would they pay? was the list usable?) to memory with keyword "hu-sme-lead-gen, pilot" — that feedback is product validation, not just task output.
