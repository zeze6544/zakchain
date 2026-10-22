# Catalogue at zaks.life/list

A static catalogue page. `catalog.json` is the single source of truth. `index.html` fetches it on load and builds the summary counts, filter chips and cards, so you never edit the HTML to change products.

This copy lives in `docs/list/` and is served at https://zaks.life/list/ by the existing GitHub Pages site (publishing root `docs/`, no build step). Do not add a CNAME here.

Brand rules: use only "Zak" or "Zaks.life" (never the surname). Products and services only.

## Files
- `index.html`: the page (dark theme, pink/green accents, mobile-first)
- `catalog.json`: the data

## Item format (`catalog.json` -> `items[]`)
```json
{
  "name": "Product name",
  "category": "digital | merch | service | app | dropshipping",
  "platform": "Gumroad",
  "price": "A$24",
  "status": "live | draft | blocked-payout | coming-soon | waiting-on-james | needs designs",
  "url": "https://...",
  "notes": "Short note",
  "updated": "2026-10-23T02:10:00+11:00"
}
```
Also update the top-level `"updated"`, which is the "Last updated" stamp on the page.

## Add or update an item
1. Edit `catalog.json` by adding an object to `items` or changing its `status`/`price`/`url`. Bump `updated`.
2. Validate it: `python3 -m json.tool catalog.json > /dev/null`
3. Commit and push to `main`. GitHub Pages redeploys in about a minute.

Typical flip: when payouts are connected and a Gumroad product is published, change its `status` from `blocked-payout` to `live`.

New statuses need a label and colour: add them to `LABEL` in `index.html` and a `.s-<status>` CSS rule. Status values with spaces use a hyphenated class (for example `needs designs` → `.s-needs-designs`).

Category chips are built from the items, so a new category such as `dropshipping` shows up on its own.

## Preview locally
```bash
cd docs && python3 -m http.server 8080   # open http://localhost:8080/list/
```
