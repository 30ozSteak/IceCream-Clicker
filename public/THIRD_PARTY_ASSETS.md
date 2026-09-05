# Third-party assets

Source review date: 2026-08-25.

## Open Pravatar portraits

The files in `portraits/` are locally cached, pre-generated synthetic images from [Open Pravatar](https://openpravatar.com/docs). They are not photographs of real people. The catalog records every selected image as `review_status: approved`, `subject_count: 1`, and `license: synthetic-commercial`.

- Catalog query: `https://openpravatar.com/api/search?family=portrait&limit=100`
- Source ID: each filename stem is the stable Open Pravatar asset ID also recorded in `lib/portraits.ts`.
- Cached source URL: `https://openpravatar.com/thumbs/{SOURCE_ID}.webp?w=800`
- Canonical original URL: `https://openpravatar.com/library/{SOURCE_ID}/original.png`
- Terms: [Open Pravatar usage licence](https://openpravatar.com/legal) permits commercial and non-commercial use without attribution, but prohibits reselling or redistributing the images as stock photography or a competing asset library.

Portraits are bundled only as gameplay content for this application. Do not extract and redistribute them as a standalone image library.

### Curation and mouth-target review

On 2026-08-25, `scripts/import-portraits.mjs` selected all 72 eligible results returned by the catalog query above. Eligibility required an approved review status, exactly one subject, the portrait family, and an adult age band. Apple Vision outer-lip landmarks seeded each normalized target; the importer rejected no image for missing landmarks or multiple detectable faces.

The first 60 targets were reviewed on a 6×10 contact sheet with every manifest ellipse overlaid on its locally cached portrait; the final 12 catalog results were reviewed individually at full size. All 72 entries in `lib/portraits.ts` were visually reviewed. Every target landed on a clear, unobstructed mouth, so no additional images were rejected or manually shifted. This review covers the exact manifest generated on the source review date; rerunning the importer against a changed catalog requires a new visual review.
