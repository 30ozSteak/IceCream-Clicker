# Third-party assets

Source review date: 2026-08-25.

## FatBoy brand assets

- `brand/fatboy-logo.png` — current FatBoy wordmark, sourced from the header of the official [FatBoy website](https://fatboyicecream.com/) ([original PNG](https://fatboyicecream.com/wp-content/uploads/2023/11/FB-Logo-23c.png)).
- `brand/fatboy-vanilla-6-pack.webp` — current Premium Vanilla six-count retail box, sourced from the official [Ice Cream Sandwiches page](https://fatboyicecream.com/ice-cream-sandwiches/) ([original PNG](https://fatboyicecream.com/wp-content/uploads/2025/02/FB-SandwichVanilla-6ct-3dbox-01.png)); locally WebP-compressed at its original 2048×2048 dimensions without creative alteration.
- `brand/vanilla-sandwich.webp` — “Vanilla Ice Cream Sandwich,” sourced from the official [FatBoy Broker Resource Center](https://fatboyicecream.com/brokers/) ([original JPEG](https://fatboyicecream.com/downloads/vanilla2.jpg)); locally resized and WebP-compressed without creative alteration.

FatBoy and Casper's brand assets remain the property of their respective rights holders and are included under the project's stated brand authorization.

## 3D model

- `models/fatboy-sandwich.glb` — user-supplied Meshy-generated FatBoy model, simplified from roughly 3.1 million to 62,728 triangles and resized to 1024px WebP textures for real-time browser rendering. The optimized file retains the supplied model's geometry and material artwork.

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
