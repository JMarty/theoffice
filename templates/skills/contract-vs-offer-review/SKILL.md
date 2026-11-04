---
name: contract-vs-offer-review
description: Review a contract, order form, hotel/venue checklist or vendor form received for Owner BEFORE he signs or before we fill it - diff it line by line against the negotiated email offer AND last year's signed version, check the math, read every line of every form plus the booking/package, build an included / asked / open inventory, ask the owner ONE round of questions, then fill or reply once. Use when a hotel/venue/vendor sends "the contract", "the group/meeting checklist", "please fill in and return", or he asks "is this OK to sign?" (an event Mövenpick, Hoxton, Split venues, Perk event offers).
---
# Contract vs offer review (and vendor form fill)

Born from two real cases: an event 2027 Mövenpick contract No <id> (2026-10-05, 6 discrepancies found before signing)
and the Hoxton Lloyd Strategy Day forms (2026-10-14, three redrafts because the forms were answered without reading them
against the booking; memory cross-check-forms-against-booking).

## Mikor használd
- A counterparty sends a contract/order form to sign, or a checklist/form to fill and return.
- He asks "can I sign this?", "fill in their forms", "reply to the hotel".
- Delegate the raw reading if there are 5+ long documents (CLAUDE.md delegation rule); keep the verdict yourself.

## Eljárás
1. *Collect the three sources* (all inboxes: gmail-multi-inbox-check; attachments: read-gmail-attachment):
   a. the received document (contract PDF / forms),
   b. the negotiated offer: the vendor's offer email + every later email that changed a term (thread order),
   c. last year's signed version / previous booking, if any (an event: 2026 Perk-Mövenpick contract 951306).
   Plus for forms: the actual booking (Perk confirmation, package inclusions, rates, T&Cs).
2. *Read every line of every document* - headers, intro paragraph, tables, deposit table, footnotes, T&C sections.
   an event: the intro said 21.05-30.05.27 while the room table said 23-29 May.
3. *Term-by-term diff table* (in a scratch file): term | offer says | contract says | last year | verdict.
   Typical terms: rates per room type and occupancy, extras (breakfast, spa, chocolate hour), free upgrades, room block
   per night, conference room days + price, cancellation / attrition ladder, final-numbers clause, deposits + due dates,
   party names, registry code + VAT on both sides, signatory.
   an event findings: upgrades 5/2/2 vs offered 10/3/3 (last year's wording copied); <amt> EUR twin rate + chocolate hour
   missing; header dates wrong; conference 1,100 in one table vs 1,000 in the deposit table; conference cancellation +
   final-numbers clauses dropped vs 2026; the employer OÜ registry code + VAT missing.
4. *Math check*: recompute every total from its parts (room-nights x rate, deposit split, VAT). an event: 365 room-nights
   x 190 = <amt> EUR = 2 x 34,675 (10 Jan + 10 Apr). Compare the block with last year's ACTUALS per night (Sun 45 vs 58
   used) and say which gap is risky (adding rooms later depends on availability; dropping is free until 60 days out).
5. *For forms, build the inventory*: for each form line -> INCLUDED (already in the booking/package: say so, do not order
   it again) / ASKED (owner already answered: use his words) / OPEN (genuinely unknown or conflicting). Hoxton misses:
   package room only 09:00-17:00 (we needed later), lunch/coffee/screen/flipchart already included, rooms prepaid via Perk
   so "master account" options did not fit, city tax excluded.
6. *ONE owner message* (office-say, phone format): verdict first ("NOT ready to sign" / "OK to sign"), then
   *Wrong vs offer*, *Errors inside the document*, *vs last year (my judgement)*, *Also*, each numbered, then the open
   questions with my recommendation, and the offered next step ("draft a reply asking for 1-5 to be fixed?").
   He may accept items as is (an event 10-05: "fine with him") - record that in memory and do not re-raise.
7. *Then act once*: fill the forms (fill-pdf-form) or draft the reply/correction email (Gmail DRAFT only, in his thread,
   gmail-draft-any-account; he sends). Clarifications and explanations (billing, timing) go in the email body, not in an
   "any other info" box; never the same answer in several places.
8. *Corrected version arrives* -> re-run steps 2-4 on it before telling him it is ready to sign.

## Buktatók
- "Last year's wording copied over" is the most common defect: diff against the OFFER, not only against last year.
- One document can contradict itself (two tables, intro vs table). Compare inside the document too.
- Do not add requests he did not make to the vendor draft (memory draft-what-he-asked-for-nothing-else).
- A cached figure or a subject line is not the term: quote the document.
- Signing authority / internal sign-off: mention it once as an assumption, do not block on it.
- Never send: email is draft-only (CLAUDE.md hard rule).

## Ellenőrzés
- Diff table covers every term of the offer and every table of the document; each row has a verdict.
- Every total recomputed and matching (or flagged).
- The owner got ONE message with the verdict first; open questions asked once, with recommendations.
- After the fill/draft: rendered PDF pages read back (fill-pdf-form step 6) or the draft re-read from Gmail.
- **Read last year's NEGOTIATION thread, not just last year's signed PDF (Tenerife 2026-11-02, owner caught it).** The Split contract with Onsite Hub came out of a Jan-Feb legal review (contact-4f397e@example.com thread "Retreat planning stuff", Dorian Duda): a commission-agent clause written by the employer's lawyer (so its odd wording is OURS, not a defect), a SEPARATE DPA (Drive "<long-id>.pdf", tied to that one event and ending with it), and an agreed reading of cancellation (only the PM fee non-refundable). Side documents (DPA, insurance, annexes) never show up in a diff of the main contract. Search the vendor's thread for "DPA", "clause", "lawyer", "insurance" before calling anything fine or a defect.
- DocuSign envelope (Tenerife 2026-11-03): don't open his signing link yourself (it is his session and marks the envelope viewed). Ask him for Other actions > Download (doesn't sign), then check it. Scanned contract pages have no text layer: render with pdftoppm and read every page as an image. Compare an annex we drafted with a word-set diff against our docx (python-docx paragraphs + tables), ignoring numbering/line breaks.
