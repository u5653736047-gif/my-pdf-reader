import type { BookDoc } from '@/libs/document';
import type { BookNote } from '@/types/book';

import { resolveCfi } from './providers/readest';

/**
 * Writing the reader's own highlights back into a PDF file.
 *
 * A reader that shows a highlight without storing it in the file loses it as
 * soon as the book is opened anywhere else, so the PDF track has to end in a
 * real /Highlight annotation. pdf.js already has that writer behind
 * `PDFDocumentProxy.saveDocument()`: it walks the entries the annotation editor
 * left in `annotationStorage` and re-creates them with its own annotation
 * classes. Feeding it entries built from Readest's notes therefore reuses the
 * shipped writer instead of a second, weaker PDF writer of our own.
 *
 * Everything below is in PDF user space (points, origin bottom-left); the one
 * entry point that touches CSS pixels says so on its signature.
 */

/** A rect in CSS pixels within a rendered page frame (the text layer's space). */
export interface DisplayRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A rect in PDF user space, already ordered low-to-high. */
export interface PdfRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * One `annotationStorage` value, as pdf.js serialises a highlight
 * (AnnotationEditorType.HIGHLIGHT). Plain objects are accepted as-is: only
 * AnnotationEditor instances get `serialize()`d on the way to the save path.
 */
export interface PdfHighlightEntry {
  annotationType: number;
  color: [number, number, number];
  opacity: number;
  quadPoints: number[];
  outlines: number[][];
  pageIndex: number;
  rect: [number, number, number, number];
}

/** The rendered page frames a note's CFI has to resolve against. */
export interface PdfFrameView {
  getContents: () => Array<{ doc: Document; index?: number }>;
}

/** Viewports come straight from pdf.js; only the conversion is used here. */
type ToPdfPoint = (x: number, y: number) => [number, number];

/** Used when a note carries no color at all. */
const DEFAULT_HIGHLIGHT_COLOR = '#facc15';

/**
 * The rendered page's layers sit in real display coordinates, so the canvas'
 * CSS box is the page drawn at its current scale: the most direct read of the
 * scale a frame is laid out at.
 */
const getFrameScale = (doc: Document, unitWidth: number): number => {
  const width = doc.querySelector('#canvas canvas')?.clientWidth ?? 0;
  return width > 0 && unitWidth > 0 ? width / unitWidth : 1;
};

/** Collect a range's line boxes as one display rect each, in document order. */
const getDisplayRects = (range: Range): DisplayRect[] =>
  Array.from(range.getClientRects())
    .filter(({ width, height }) => width > 0 && height > 0)
    .map(({ left, top, right, bottom }) => ({ left, top, right, bottom }));

/** Map a highlight color onto the 0-255 channels pdf.js stores as /C. */
export const toRgb255 = (hex: string | undefined): [number, number, number] => {
  const int = Number.parseInt((hex ?? DEFAULT_HIGHLIGHT_COLOR).replace('#', ''), 16);
  if (!Number.isInteger(int)) return [250, 204, 21];
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
};

/** Convert one display rect into PDF user space, through a pdf.js viewport. */
export const toPdfRect = (rect: DisplayRect, toPdf: ToPdfPoint): PdfRect => {
  const [x1, yTop] = toPdf(rect.left, rect.top);
  const [x2, yBottom] = toPdf(rect.right, rect.bottom);
  return {
    x1: Math.min(x1, x2),
    y1: Math.min(yTop, yBottom),
    x2: Math.max(x1, x2),
    y2: Math.max(yTop, yBottom),
  };
};

/**
 * The quad's four corners, TL, TR, BL, BR — the order HighlightEditor writes
 * (and its parser reads back), so a highlight saved this way is
 * indistinguishable from one the pdf.js editor made. `outlines` is the same
 * quad as a closed polygon, which is what the appearance stream paints.
 */
export const buildQuadPoints = (rect: PdfRect): { quadPoints: number[]; outline: number[] } => ({
  quadPoints: [rect.x1, rect.y2, rect.x2, rect.y2, rect.x1, rect.y1, rect.x2, rect.y1],
  outline: [rect.x1, rect.y1, rect.x2, rect.y1, rect.x2, rect.y2, rect.x1, rect.y2],
});

/** Build the storage entry for one highlight spanning any number of line boxes. */
export const buildHighlightEntry = ({
  pageIndex,
  color,
  opacity,
  rects,
}: {
  pageIndex: number;
  color: [number, number, number];
  opacity: number;
  rects: PdfRect[];
}): PdfHighlightEntry => {
  const quadPoints: number[] = [];
  const outlines: number[][] = [];
  for (const rect of rects) {
    const { quadPoints: quad, outline } = buildQuadPoints(rect);
    quadPoints.push(...quad);
    outlines.push(outline);
  }
  return {
    annotationType: 9,
    color,
    opacity,
    quadPoints,
    outlines,
    pageIndex,
    rect: [
      Math.min(...rects.map((r) => r.x1)),
      Math.min(...rects.map((r) => r.y1)),
      Math.max(...rects.map((r) => r.x2)),
      Math.max(...rects.map((r) => r.y2)),
    ],
  };
};

/** Storage keys outside the editor's prefix are ignored when saving. */
export const getPdfEditorKey = (id: string): string => `pdfjs_internal_editor_${id}`;

/**
 * Put every resolvable highlight note for `bookDoc` into the pdf.js document's
 * annotation storage, ready for `saveDocument()`. Notes on pages that are not
 * currently rendered have no text layer to measure, so they are skipped and the
 * caller is told how many made it in.
 *
 * `getColorHex` resolves a note's highlight color, which is the only place the
 * user's custom colors are known.
 */
export const addPdfAnnotations = async (
  bookDoc: BookDoc,
  view: PdfFrameView,
  notes: BookNote[],
  getColorHex: (color: BookNote['color']) => string | undefined,
): Promise<number> => {
  const pdf = bookDoc.getPDF?.();
  if (!pdf) return 0;
  const frames = view.getContents();
  let written = 0;

  for (const note of notes) {
    if (note.type !== 'annotation') continue;
    const resolved = resolveCfi(bookDoc, note.cfi);
    if (!resolved?.anchor) continue;
    const { index, anchor } = resolved;
    const frame = frames.find((content) => content.index === index);
    if (!frame) continue;

    const page = await pdf.getPage(index + 1);
    const scale = getFrameScale(frame.doc, page.getViewport({ scale: 1 }).width);
    const viewport = page.getViewport({ scale });
    const toPdf: ToPdfPoint = (x, y) => viewport.convertToPdfPoint(x, y);

    const range = anchor(frame.doc);
    if (typeof range === 'number') continue;
    const rects = getDisplayRects(range).map((r) => toPdfRect(r, toPdf));
    if (rects.length === 0) continue;

    pdf.annotationStorage.setValue(
      getPdfEditorKey(note.id),
      buildHighlightEntry({
        pageIndex: index,
        color: toRgb255(getColorHex(note.color)),
        opacity: 1,
        rects,
      }),
    );
    written += 1;
  }
  return written;
};
