// scripts/lib/ocr-filter.js
//
// Shared OCR text-in-logo filter, used by both build-catalog.js (applied to
// freshly scraped entries) and recheck-text-filter.js (re-applied to the
// whole existing catalog when the filter's rules change).
//
// A guessing game can't use a logo that gives away readable text as a clue.
// Whole "Wordmark" sections are already excluded by classifySection() in
// build-catalog.js, but plenty of Primary/Secondary/Alternate marks (seals,
// badges, script logos) also bake real text into the artwork itself.
// There's no DOM signal for this — it has to be read off the actual image —
// so this runs OCR (tesseract.js) against every candidate logo thumbnail
// and drops any where it detects a run of letters at or above
// MIN_SIGNIFICANT_TEXT_LEN, anywhere in the image (not just team-name
// matches). Short 1-2 letter monograms (e.g. a stylized "KC" or "NY") are
// allowed through; anything longer is treated as a spoiler and dropped,
// regardless of whether it happens to spell out the team's own name.
//
// OCR on small/stylized sports-logo thumbnails is inherently imperfect.
// Two distinct failure modes found by visual-sampling the catalog:
//   1. Light text on a dark background reads as nothing to tesseract
//      (it's trained on document scans — dark text on light). Fixed by
//      also trying a color-inverted pass.
//   2. A single global "is this image mostly dark?" brightness check is
//      too crude for real logos, which often mix light and dark regions
//      (e.g. a dark circular border around a light banner with dark
//      text) — picking ONE polarity by average brightness sometimes
//      inverts an image that was already readable, turning a correct
//      read into garbage. Fixed by running BOTH polarities every time and
//      flagging if EITHER shows significant text, instead of guessing
//      which one to use upfront.
// Remaining known gap: curved/arched text (following a badge or seal's
// edge, e.g. text arched over a mascot) and heavily cursive script are
// still frequently missed regardless of polarity — tested upscaling and
// alternate tesseract page-segmentation modes against real examples of
// both and neither meaningfully helped. That's a real ceiling of
// tesseract's traditional OCR approach, not something more preprocessing
// fixes. This filter is a real reduction in text-logo contamination, not
// a guarantee of zero — occasional false positives are also possible on
// totally clean icon-only logos where OCR hallucinates a few letters out
// of the shape's edges.

import { createWorker } from 'tesseract.js';
import sharp from 'sharp';

const MIN_SIGNIFICANT_TEXT_LEN = 3;

function ocrHasSignificantText(ocrText) {
  const letterRuns = ocrText.toLowerCase().match(/[a-z]+/g) || [];
  return letterRuns.some((run) => run.length >= MIN_SIGNIFICANT_TEXT_LEN);
}

async function bothPolarities(buf) {
  const gray = sharp(buf).grayscale();
  const normal = await gray.png().toBuffer();
  const inverted = await gray.clone().negate().png().toBuffer();
  return [normal, inverted];
}

export async function filterTextLogos(catalog) {
  console.log('\nRunning OCR text-in-logo filter (this can take a while)...');
  const worker = await createWorker('eng');
  let scanned = 0;
  let removed = 0;

  for (const entry of catalog) {
    const kept = [];
    const flagged = [];
    for (const logo of entry.logos) {
      scanned++;
      try {
        const res = await fetch(logo.url);
        const rawBuf = Buffer.from(await res.arrayBuffer());
        const [normal, inverted] = await bothPolarities(rawBuf);
        const normalResult = await worker.recognize(normal);
        const hasText = ocrHasSignificantText(normalResult.data.text)
          || ocrHasSignificantText((await worker.recognize(inverted)).data.text);
        if (hasText) {
          flagged.push(logo);
          continue;
        }
      } catch (e) {
        console.warn(`  ! OCR failed on ${logo.url}: ${e.message} — keeping logo`);
      }
      kept.push(logo);
    }

    // Never let this filter zero out a team entirely — if every single logo
    // got flagged, that's much more likely a systematic OCR misread (e.g. an
    // icon's shape getting read as letters) than a team that genuinely has
    // no usable identity mark. Keep the originals and flag for human review
    // instead of silently dropping the team from the catalog.
    if (kept.length === 0 && flagged.length > 0) {
      console.warn(`  ? ${entry.team} ${entry.nickname}: OCR flagged ALL ${flagged.length} logo(s) as text — keeping them, needs manual review`);
      entry.logos = flagged;
    } else {
      for (const logo of flagged) {
        removed++;
        console.log(`  [text logo removed] ${entry.team} ${entry.nickname} (${logo.type}, ${logo.era})`);
      }
      entry.logos = kept;
    }
  }

  await worker.terminate();
  console.log(`OCR filter done: scanned ${scanned} logos, removed ${removed} text logos.`);
  return catalog.filter((entry) => entry.logos.length > 0);
}
