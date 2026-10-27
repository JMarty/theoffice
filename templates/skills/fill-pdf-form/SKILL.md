---
name: fill-pdf-form
description: Fill a PDF form for Owner (e.g. a contract or official form he sends or attaches), place his signature, verify visually, and optionally draft a cover email with it attached. Use when Owner says "fill in this PDF / form for me", "töltsd ki ezt a nyomtatványt", or sends a form to complete.
---

# Fill a PDF form for Owner

## When to use
Owner attaches a PDF form (Telegram document) and asks you to fill it in — official declarations, contracts, subscription forms. Often followed by "put it in a draft email" to the right address.

## Procedure
1. **Download + inspect.** `download_attachment` → Read the PDF (renders pages as images + extracts text). Read every field label; note what data each needs.
2. **Detect form type.** `python3 -c "import pypdf; print(bool(pypdf.PdfReader('f.pdf').get_fields()))"`.
   - AcroForm (fields) → fill fields directly with pypdf.
   - **Flat PDF (no fields, the common case)** → overlay text anchored to label positions (below).
3. **Gather the data.** Pull from the invoice/portal Owner provides + his memory (addresses, IDs). Ask him ONLY for what you can't derive (mobile, a date choice, signature). Don't fabricate (e.g. a residence address) — confirm or leave for him.
4. **Label-anchored overlay** (flat PDF): use `pdfplumber` to get each label word's bbox, then `reportlab` to draw the value just right of the label line (or below it for box fields). Convert coords: `y_reportlab = page.height - word['bottom']`. Merge overlay with `pypdf` `merge_page`. (See references/fill_form.py pattern.)
5. **Signature.** If he sends a signature image: knock out the white background with PIL (near-white → alpha 0 → PNG), then `reportlab` `drawImage(ImageReader(png), x, y, w, h, mask='auto')` above the signature line (anchor the lowest "aláírás"/"signature"/"Előfizető" label).
6. **VERIFY VISUALLY before sending.** Render filled pages with `pypdfium2` (`pdf[i].render(scale=2.0).to_pil().save(...)`) and Read the PNGs. Confirm every value sits on its correct line and nothing overlaps. NEVER send a form you haven't eyeballed.
7. **Deliver.** Send the filled PDF to Owner on Telegram (`sendDocument`). If he wants it emailed: create a **draft** (not send) via the Gmail API in the right account, To the verified recipient, short cover letter, the filled PDF attached (MIMEMultipart + MIMEApplication). He reviews + sends.

## Pitfalls
- **Verify the submission email** by WebSearch — don't guess an address. (e.g. a provider's cancellation address, confirmed from its FAQ.)
- reportlab Helvetica handles á é í ó ö ü ú but NOT ő ű — avoid those in overlay values, or register a Unicode TTF.
- `changes()` after a separate sqlite/pdf op is per-connection — re-read to verify, don't trust it.
- A flat-PDF white-bg signature JPEG will cover form lines; knock out white → transparent first.
- A termination date on a cancellation form can often be left blank (= earliest); check the form for a minimum notice if one is specified.

## Verification
- Rendered every filled page and visually confirmed alignment.
- For email: the draft is in the right account, recipient verified, PDF attached; Owner sends (never auto-send an official submission).
