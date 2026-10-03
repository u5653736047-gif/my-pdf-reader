/**
 * Turns a PDF page's text items into paragraphs, so the reader can translate a
 * page the way it translates a book: a whole paragraph at a time, in place.
 *
 * Two things make this more than a sort. A PDF has no paragraphs — it has text
 * positioned on a page, in content-stream order — and the boxes have to be in
 * the coordinate system the page's own text layer is laid out in, so a
 * translation stays glued to the text it translates.
 *
 * The coordinate system is pdf.js's (`display/text_layer.js`): percentages of
 * the *unrotated* page box, from a matrix that flips y and offsets by the media
 * box origin. Using the same one means an overlay needs no measurement of the
 * live DOM — the page box is a percentage container at every zoom, exactly as
 * the text layer's own spans are.
 */

/** A pdf.js text-content item. Only the fields the layout needs. */
export interface PdfTextItem {
  str: string;
  /** [a, b, c, d, e, f]: the text rendering matrix, e/f being the baseline start. */
  transform: number[];
  /** Advance width, in the same units as `transform`. */
  width: number;
  height: number;
}

/** The unrotated page geometry, as `viewport.rawDims` reports it. */
export interface PdfPageBox {
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
}

/** One paragraph of source text, with the box it occupies on the page. */
export interface PdfParagraph {
  text: string;
  /** Fractions of the page box, so the box survives any zoom. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The source line's height in page units, to size the translation to match. */
  fontSize: number;
}

/** Text laid out sideways (vertical CJK, rotated labels) is not a line here. */
const MAX_TEXT_ANGLE = 0.05;
/** Beyond this the gap between two runs starts a new column, not a wide space. */
const MAX_INLINE_GAP = 1.5;
/** Two runs this far apart on the baseline are two different lines. */
const MAX_BASELINE_DRIFT = 0.5;
/** Line spacing tighter than this is a paragraph break, not a line break. */
const MIN_PARAGRAPH_GAP = 1;
/** A line this much short of the paragraph's right edge is the paragraph's last. */
const SHORT_LINE_TOLERANCE = 0.8;
/** Fewer lines than this and the page is one column, whatever its gutters. */
const MIN_COLUMN_LINES = 3;
/** A gutter narrower than this (× line height) is not a gutter. */
const MIN_GUTTER = 3;

// Scripts that set no space between lines, plus the CJK punctuation and
// fullwidth blocks: 。 and ， are Script=Common, not Han, but sit in CJK text.
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

/** CJK sets no spaces between lines; Latin needs them. */
const needsSpace = (before: string, after: string) =>
  !(CJK.test(before.at(-1) ?? '') && CJK.test(after[0] ?? ''));

const multiply = (m: number[], t: number[]) => [
  m[0]! * t[0]! + m[2]! * t[1]!,
  m[1]! * t[0]! + m[3]! * t[1]!,
  m[0]! * t[2]! + m[2]! * t[3]!,
  m[1]! * t[2]! + m[3]! * t[3]!,
  m[0]! * t[4]! + m[2]! * t[5]! + m[4]!,
  m[1]! * t[4]! + m[3]! * t[5]! + m[5]!,
];

interface Glyph {
  text: string;
  left: number;
  right: number;
  /** Page coordinates, y down, as the text layer lays them out. */
  top: number;
  bottom: number;
  baseline: number;
  fontHeight: number;
}

/** A run of text on one baseline: either a whole line, or a column's half of one. */
interface Run {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  fontHeight: number;
}

const toGlyphs = (items: PdfTextItem[], box: PdfPageBox): Glyph[] => {
  // The flip pdf.js applies before writing `left`/`top` as percentages.
  const flip = [1, 0, 0, -1, -box.pageX, box.pageY + box.pageHeight];
  const glyphs: Glyph[] = [];
  for (const item of items) {
    if (!item.str || !item.transform || item.transform.length < 6) continue;
    const tx = multiply(flip, item.transform);
    const fontHeight = Math.hypot(tx[2]!, tx[3]!);
    if (!(fontHeight > 0)) continue;
    if (Math.abs(Math.atan2(tx[1]!, tx[0]!)) > MAX_TEXT_ANGLE) continue;
    const left = tx[4]!;
    glyphs.push({
      text: item.str,
      left,
      right: left + Math.abs(item.width || 0),
      baseline: tx[5]!,
      top: tx[5]! - fontHeight,
      bottom: tx[5]! + fontHeight * 0.2,
      fontHeight,
    });
  }
  return glyphs;
};

const toRun = (glyphs: Glyph[]): Run => ({
  text: glyphs
    .map(({ text }) => text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim(),
  left: Math.min(...glyphs.map(({ left }) => left)),
  right: Math.max(...glyphs.map(({ right }) => right)),
  top: Math.min(...glyphs.map(({ top }) => top)),
  bottom: Math.max(...glyphs.map(({ bottom }) => bottom)),
  fontHeight: Math.max(...glyphs.map(({ fontHeight }) => fontHeight)),
});

/** Groups glyphs into runs: same baseline, and close enough to be one line. */
const toRuns = (glyphs: Glyph[]): Run[] => {
  const sorted = [...glyphs].sort((a, b) => a.baseline - b.baseline || a.left - b.left);
  const runs: Glyph[][] = [];
  for (const glyph of sorted) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (
      run &&
      previous &&
      Math.abs(glyph.baseline - previous.baseline) <= previous.fontHeight * MAX_BASELINE_DRIFT &&
      glyph.left - previous.right <= previous.fontHeight * MAX_INLINE_GAP
    ) {
      run.push(glyph);
    } else {
      runs.push([glyph]);
    }
  }
  return runs.map(toRun);
};

/**
 * Splits a page's runs into columns, by the widest vertical band no text falls
 * in. A single-column page has no such band — its lines share one extent, so
 * even a page of very short lines is not mistaken for two columns. A run
 * straddling the gutter (a full-width heading) keeps its column by its middle.
 */
const splitColumns = (runs: Run[]): Run[][] => {
  if (runs.length < MIN_COLUMN_LINES * 2) return [runs];
  const heights = runs.map(({ fontHeight }) => fontHeight).sort((a, b) => a - b);
  const lineHeight = heights[heights.length >> 1]!;

  const byLeft = [...runs].sort((a, b) => a.left - b.left);
  let reach = byLeft[0]!.right;
  let gutter = 0;
  let middle = 0;
  for (const run of byLeft.slice(1)) {
    if (run.left > reach && run.left - reach > gutter) {
      gutter = run.left - reach;
      middle = (reach + run.left) / 2;
    }
    reach = Math.max(reach, run.right);
  }
  if (gutter < lineHeight * MIN_GUTTER) return [runs];

  const columns = [
    runs.filter(({ left, right }) => (left + right) / 2 < middle),
    runs.filter(({ left, right }) => (left + right) / 2 >= middle),
  ];
  if (columns.some((column) => column.length < MIN_COLUMN_LINES)) return [runs];
  return columns;
};

export const clusterPdfParagraphs = (items: PdfTextItem[], box: PdfPageBox): PdfParagraph[] => {
  const runs = toRuns(toGlyphs(items, box)).filter(({ text }) => text.length > 0);
  if (runs.length === 0) return [];
  // Columns in reading order, each column top to bottom.
  const ordered = splitColumns(runs).flatMap((column) =>
    [...column].sort((a, b) => a.top - b.top || a.left - b.left),
  );

  const grouped: { runs: Run[]; left: number; right: number }[] = [];
  for (const run of ordered) {
    const paragraph = grouped.at(-1);
    const previous = paragraph?.runs.at(-1);
    const continues =
      paragraph &&
      previous &&
      // A first line indented past the paragraph's own margin opens a new one.
      run.left <= paragraph.left + previous.fontHeight * MAX_INLINE_GAP &&
      // A line that falls short of the margin closed the one before it.
      previous.right >= paragraph.right - previous.fontHeight * SHORT_LINE_TOLERANCE &&
      // Spacing wider than a line's height is a break between blocks.
      run.top - previous.bottom <= previous.fontHeight * MIN_PARAGRAPH_GAP;
    if (continues) {
      paragraph.runs.push(run);
      paragraph.right = Math.max(paragraph.right, run.right);
    } else {
      grouped.push({ runs: [run], left: run.left, right: run.right });
    }
  }

  return grouped.map(({ runs: paragraphRuns }) => {
    let text = '';
    paragraphRuns.forEach((run, i) => {
      if (i > 0 && needsSpace(paragraphRuns[i - 1]!.text, run.text)) text += ' ';
      text += run.text;
    });
    const left = Math.min(...paragraphRuns.map(({ left }) => left));
    const top = Math.min(...paragraphRuns.map(({ top }) => top));
    const right = Math.max(...paragraphRuns.map(({ right }) => right));
    const bottom = Math.max(...paragraphRuns.map(({ bottom }) => bottom));
    return {
      text,
      x: left / box.pageWidth,
      y: top / box.pageHeight,
      w: (right - left) / box.pageWidth,
      h: (bottom - top) / box.pageHeight,
      fontSize: Math.max(...paragraphRuns.map(({ fontHeight }) => fontHeight)),
    };
  });
};
