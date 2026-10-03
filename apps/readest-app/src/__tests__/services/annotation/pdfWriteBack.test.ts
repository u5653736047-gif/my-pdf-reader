// Writing Readest's PDF highlights back into the file. The whole dual-track
// annotation plan rests on one question: can a highlight the user makes in the
// reader reach `PDFDocumentProxy.saveDocument()` as a real /Highlight
// annotation? These tests answer it against the pdf.js build the app ships
// (pdfjs-dist 6.x legacy, the one `@pdfjs/pdf.min.mjs` aliases to) and a real
// PDF, not a mock.
//
// Contracts relied on, each read off that build:
//   - `PDFDocumentProxy.annotationStorage.setValue()` takes plain objects:
//     AnnotationStorage.serializable() only calls `serialize()` on values that
//     are AnnotationEditor instances, and passes everything else through, so an
//     entry built outside pdf.js survives to the save path;
//   - keys must be prefixed `pdfjs_internal_editor_`, or the worker's
//     getNewAnnotationsMap() drops them;
//   - AnnotationEditorType.HIGHLIGHT is 9, and an entry with `quadPoints` is
//     written by HighlightAnnotation.createNewAnnotation();
//   - the entry carries PDF user-space coordinates, which the rendered text
//     layer's rects get back through the display viewport.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  addPdfAnnotations,
  buildHighlightEntry,
  buildQuadPoints,
  getPdfEditorKey,
  toPdfRect,
  toRgb255,
} from '@/services/annotation/pdfWriteBack';
import type { BookNote } from '@/types/book';
import type { BookDoc } from '@/libs/document';

type Point = [number, number];

/** The slice of pdf.js this feature talks to, in its own terms. */
interface PdfViewport {
  width: number;
  convertToPdfPoint(x: number, y: number): Point;
  convertToViewportPoint(x: number, y: number): Point;
}
interface PdfTextItem {
  str: string;
  width: number;
  height: number;
  /** [a, b, c, d, e, f] — e is the baseline x, f the baseline y in PDF space. */
  transform: number[];
}
interface PdfAnnotation {
  subtype: string;
  rect: number[];
  quadPoints?: number[];
  color?: number[];
  opacity?: number;
  hasAppearance?: boolean;
}
interface PdfPage {
  rotate: number;
  getViewport(params: { scale: number }): PdfViewport;
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  getAnnotations(): Promise<PdfAnnotation[]>;
}
interface PdfDocument {
  getPage(index: number): Promise<PdfPage>;
  annotationStorage: {
    setValue(key: string, value: unknown): void;
    getRawValue(key: string): unknown;
  };
  saveDocument(): Promise<Uint8Array>;
}
interface PdfjsLib {
  getDocument(params: { data: Uint8Array; verbosity: number }): { promise: Promise<PdfDocument> };
}

let pdfjsLib: PdfjsLib;

// Node has no worker, so pdf.js falls back to its fake worker: it wants the
// worker module's message handler reachable on `globalThis`.
beforeAll(async () => {
  pdfjsLib = (await import('@pdfjs/pdf.min.mjs')) as PdfjsLib;
  // @ts-expect-error Same build, worker half.
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import('@pdfjs/pdf.worker.min.mjs');
});

const openPdf = (bytes: Uint8Array): Promise<PdfDocument> =>
  pdfjsLib.getDocument({ data: bytes, verbosity: 0 }).promise;

// pdf.js rejects a `Buffer` for `data`, so hand it a plain Uint8Array.
const fixture = () =>
  new Uint8Array(readFileSync(resolve(__dirname, '../../fixtures/data/sample-alice.pdf')));

describe('toPdfRect', () => {
  it('converts a text-layer rect into PDF user space through the viewport', () => {
    // 1:1 mapping with the y axis flipped, as a top-left-origin space would be.
    const toPdf = (x: number, y: number): Point => [x, 800 - y];
    expect(toPdfRect({ left: 10, top: 20, right: 30, bottom: 40 }, toPdf)).toEqual({
      x1: 10,
      y1: 760,
      x2: 30,
      y2: 780,
    });
  });

  it('keeps x1,y1 the low corner however the viewport maps the axes', () => {
    const swap = (x: number, y: number): Point => [y, x];
    expect(toPdfRect({ left: 10, top: 20, right: 30, bottom: 40 }, swap)).toEqual({
      x1: 20,
      y1: 10,
      x2: 40,
      y2: 30,
    });
  });
});

describe('buildQuadPoints', () => {
  it('writes the quad TL, TR, BL, BR as pdf.js itself does', () => {
    // HighlightEditor#serializeBoxes, and the order its own parser reads back.
    const { quadPoints, outline } = buildQuadPoints({ x1: 10, y1: 20, x2: 30, y2: 40 });
    expect(quadPoints).toEqual([10, 40, 30, 40, 10, 20, 30, 20]);
    expect(outline).toEqual([10, 20, 30, 20, 30, 40, 10, 40]);
  });
});

describe('buildHighlightEntry', () => {
  it('wraps every rect as a quad and unions them into one rect', () => {
    const entry = buildHighlightEntry({
      pageIndex: 2,
      color: toRgb255('#facc15'),
      opacity: 0.5,
      rects: [
        { x1: 0, y1: 0, x2: 10, y2: 10 },
        { x1: 20, y1: 30, x2: 40, y2: 50 },
      ],
    });
    expect(entry.annotationType).toBe(9);
    expect(entry.quadPoints).toHaveLength(16);
    expect(entry.outlines).toHaveLength(2);
    expect(entry.rect).toEqual([0, 0, 40, 50]);
    expect(entry.pageIndex).toBe(2);
  });
});

describe('getPdfEditorKey', () => {
  it('prefixes the id so pdf.js picks the entry up when saving', () => {
    expect(getPdfEditorKey('n1')).toBe('pdfjs_internal_editor_n1');
  });
});

describe('toRgb255', () => {
  it('maps a highlight hex onto the 0-255 channels', () => {
    expect(toRgb255('#ff0000')).toEqual([255, 0, 0]);
    expect(toRgb255('#facc15')).toEqual([250, 204, 21]);
  });

  it('falls back to yellow when no color resolves', () => {
    expect(toRgb255(undefined)).toEqual([250, 204, 21]);
    expect(toRgb255('#nope')).toEqual([250, 204, 21]);
  });
});

describe('saveDocument round trip', () => {
  it('writes the highlight into the file, on the text it was taken from', async () => {
    const pdf = await openPdf(fixture());
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.5 });

    const item = (await page.getTextContent()).items.find((i) => i.str.trim().length > 0)!;
    const [baselineX, baselineY] = [item.transform[4]!, item.transform[5]!];
    // The line's box in PDF user space: the baseline is its bottom edge.
    const pdfBox = {
      x1: baselineX,
      y1: baselineY,
      x2: baselineX + item.width,
      y2: baselineY + item.height,
    };
    // … and how that same box sits in the page's text layer, in CSS pixels.
    const [left, top] = viewport.convertToViewportPoint(pdfBox.x1, pdfBox.y2);
    const [right, bottom] = viewport.convertToViewportPoint(pdfBox.x2, pdfBox.y1);

    const rect = toPdfRect({ left, top, right, bottom }, (x, y) =>
      viewport.convertToPdfPoint(x, y),
    );
    pdf.annotationStorage.setValue(
      getPdfEditorKey('spike'),
      buildHighlightEntry({
        pageIndex: 0,
        color: toRgb255('#4ade80'),
        opacity: 0.6,
        rects: [rect],
      }),
    );

    const saved = await pdf.saveDocument();

    const pageAgain = await (await openPdf(new Uint8Array(saved))).getPage(1);
    const highlights = (await pageAgain.getAnnotations()).filter((a) => a.subtype === 'Highlight');
    expect(highlights).toHaveLength(1);

    const highlight = highlights[0]!;
    const quad = highlight.quadPoints!;
    // pdf.js reads QuadPoints back canonicalised: TL, TR, BL, BR.
    expect(Math.min(quad[0]!, quad[2]!, quad[4]!, quad[6]!)).toBeCloseTo(pdfBox.x1, 1);
    expect(Math.max(quad[0]!, quad[2]!, quad[4]!, quad[6]!)).toBeCloseTo(pdfBox.x2, 1);
    expect(Math.min(quad[1]!, quad[3]!, quad[5]!, quad[7]!)).toBeCloseTo(pdfBox.y1, 1);
    expect(Math.max(quad[1]!, quad[3]!, quad[5]!, quad[7]!)).toBeCloseTo(pdfBox.y2, 1);
    // The stored /C must be the highlight colour itself, not a scaled copy.
    expect(Array.from(highlight.color!)).toEqual(toRgb255('#4ade80'));
    expect(highlight.opacity).toBeCloseTo(0.6, 2);
    // The appearance stream is what most viewers paint the highlight from.
    expect(highlight.hasAppearance).toBe(true);
  }, 30000);
});

const note = (over: Partial<BookNote> = {}): BookNote => ({
  id: 'n1',
  type: 'annotation',
  cfi: 'epubcfi(/2/4)',
  text: 'Alice',
  note: '',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('addPdfAnnotations', () => {
  const makeFrame = (doc: Document) => {
    doc.body.innerHTML =
      '<div id="canvas"><canvas></canvas></div><div class="textLayer"><span>Alice</span></div>';
    // jsdom has no layout: the canvas box drives the frame scale in the reader.
    Object.defineProperty(doc.querySelector('canvas')!, 'clientWidth', { value: 1200 });
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector('span')!);
    // jsdom does no layout, so stand the line box up by hand.
    Object.defineProperty(range, 'getClientRects', {
      value: () => [new DOMRect(10, 20, 30, 12)],
    });
    return range;
  };

  const makeBookDoc = (pdf: PdfDocument, range: Range) =>
    ({
      resolveCFI: () => ({ index: 0, anchor: () => range }),
      getPDF: () => pdf,
    }) as unknown as BookDoc;

  it('writes one entry per resolvable note and reports the count', async () => {
    const pdf = await openPdf(fixture());
    const doc = document.implementation.createHTMLDocument('');
    const range = makeFrame(doc);
    const bookDoc = makeBookDoc(pdf, range);

    const written = await addPdfAnnotations(
      bookDoc,
      { getContents: () => [{ index: 0, doc }] },
      [note({ color: 'green' }), note({ id: 'n2', type: 'bookmark' })],
      (color) => (color === 'green' ? '#4ade80' : undefined),
    );

    expect(written).toBe(1);
    const entry = pdf.annotationStorage.getRawValue(getPdfEditorKey('n1')) as {
      pageIndex: number;
      annotationType: number;
      rect: number[];
    };
    expect(entry).toMatchObject({ pageIndex: 0, annotationType: 9 });
    // The 1200px-wide frame stands for the page scaled up, so the rect must
    // shrink to the fraction of the page the selection actually covered.
    const unit = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const scale = 1200 / unit.width;
    expect(entry.rect[2]! - entry.rect[0]!).toBeCloseTo(30 / scale, 3);
    expect(entry.rect[3]! - entry.rect[1]!).toBeCloseTo(12 / scale, 3);
  });

  it('skips notes whose page has no rendered frame', async () => {
    const pdf = await openPdf(fixture());
    const doc = document.implementation.createHTMLDocument('');
    const bookDoc = makeBookDoc(pdf, makeFrame(doc));

    expect(
      await addPdfAnnotations(bookDoc, { getContents: () => [] }, [note()], () => '#facc15'),
    ).toBe(0);
    expect(pdf.annotationStorage.getRawValue(getPdfEditorKey('n1'))).toBe(undefined);
  });
});
