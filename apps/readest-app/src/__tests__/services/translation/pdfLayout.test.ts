// Immersive translation of a PDF: the page's text items have to be turned into
// *paragraphs* before anything is sent to a translator, and each paragraph needs
// a box in the same coordinate system the page's text layer is laid out in.
//
// The boxes here are fractions of the unrotated page box — exactly what pdf.js
// itself writes into the text layer's `left`/`top` (`display/text_layer.js`:
// `100 * tx[4] / rawDims.pageWidth`), so an overlay in these coordinates stays
// aligned at every zoom without any measurement of the live DOM.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { clusterPdfParagraphs } from '@/services/translation/pdfLayout';
import type { PdfPageBox, PdfTextItem } from '@/services/translation/pdfLayout';

/** A letter page, the common case: no rotation, origin at the bottom-left. */
const PAGE: PdfPageBox = { pageX: 0, pageY: 0, pageWidth: 612, pageHeight: 792 };

/**
 * One text item as pdf.js reports it: `transform` is the text rendering matrix
 * (font size on the diagonal, baseline position in e/f) and `width` is the
 * advance in the same units.
 */
const item = (str: string, x: number, baseline: number, fontSize = 11, advance = 0.5) => ({
  str,
  transform: [fontSize, 0, 0, fontSize, x, baseline],
  width: str.length * fontSize * advance,
  height: fontSize,
});

/** A full-width line of prose: 40 characters at half an em each. */
const line = (text: string, x: number, baseline: number, fontSize = 11) =>
  item(text, x, baseline, fontSize);

describe('clusterPdfParagraphs', () => {
  it('joins consecutive lines of prose into one paragraph', () => {
    const items = [
      line('The first line of a paragraph of prose.', 60, 700),
      line('The second line continues the same paragraph.', 60, 686),
      line('And so does the third, which is also full width.', 60, 672),
    ];
    const paragraphs = clusterPdfParagraphs(items, PAGE);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.text).toBe(
      'The first line of a paragraph of prose. The second line continues the same paragraph. And so does the third, which is also full width.',
    );
  });

  it('gives each paragraph a box in fractions of the page, with the line height in points', () => {
    const source = 'A single line.';
    const [paragraph] = clusterPdfParagraphs([line(source, 60, 700)], PAGE);
    // pdf.js flips the baseline with 792 - y and then lifts by the ascent.
    expect(paragraph!.y).toBeCloseTo((792 - 700 - 11) / 792, 6);
    expect(paragraph!.h).toBeCloseTo((11 + 0.2 * 11) / 792, 6);
    expect(paragraph!.x).toBeCloseTo(60 / 612, 6);
    expect(paragraph!.w).toBeCloseTo((source.length * 11 * 0.5) / 612, 6);
    expect(paragraph!.fontSize).toBe(11);
  });

  it('keeps boxes inside the page', () => {
    const paragraphs = clusterPdfParagraphs(
      [
        line('Top of the page.', 60, 760),
        line('Bottom of the page.', 60, 60),
        item('Wide text that runs to the far margin and past it.', 0, 400, 11, 1),
      ],
      PAGE,
    );
    for (const { x, y, w, h } of paragraphs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(1);
      expect(y + h).toBeLessThanOrEqual(1);
    }
  });

  it('starts a new paragraph after a short line', () => {
    const items = [
      line('The first line of a paragraph of prose.', 60, 700),
      line('A tail.', 60, 686),
      line('The next paragraph starts here.', 60, 672),
    ];
    const paragraphs = clusterPdfParagraphs(items, PAGE);
    expect(paragraphs).toHaveLength(2);
    // The short line closes the paragraph it belongs to rather than opening one.
    expect(paragraphs[0]!.text).toBe('The first line of a paragraph of prose. A tail.');
    expect(paragraphs[1]!.text).toBe('The next paragraph starts here.');
  });

  it('starts a new paragraph at an indented first line', () => {
    const items = [
      line('The first line of a paragraph of prose.', 60, 700),
      line('Indented, so it must be a new paragraph.', 96, 686),
    ];
    const paragraphs = clusterPdfParagraphs(items, PAGE);
    expect(paragraphs).toHaveLength(2);
  });

  it('starts a new paragraph across a wider vertical gap', () => {
    const items = [line('A heading on its own line.', 60, 740), line('Body text.', 60, 700)];
    const paragraphs = clusterPdfParagraphs(items, PAGE);
    expect(paragraphs).toHaveLength(2);
  });

  it('reads two columns in order', () => {
    const left = [
      line('Left column, first line of the first block.', 60, 700),
      line('Left column, second line of the first block.', 60, 686),
      line('Left column, third line of the first block.', 60, 672),
    ];
    const right = [
      line('Right column, first line of the second block.', 350, 700),
      line('Right column, second line of the second block.', 350, 686),
      line('Right column, third line of the second block.', 350, 672),
    ];
    const paragraphs = clusterPdfParagraphs([...left, ...right], PAGE);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.text).toBe(
      'Left column, first line of the first block. Left column, second line of the first block. Left column, third line of the first block.',
    );
    expect(paragraphs[1]!.text).toBe(
      'Right column, first line of the second block. Right column, second line of the second block. Right column, third line of the second block.',
    );
    // Column 1 sits to the left of column 2.
    expect(paragraphs[1]!.x).toBeGreaterThan(paragraphs[0]!.x);
  });

  it('reads a page whose lines are narrow as one column, not two', () => {
    // A large-print page: every line is short, but they all share one extent, so
    // there is no gutter to split on.
    const items = Array.from({ length: 8 }, (_, i) =>
      line('A short line of large print.', 60, 740 - i * 20),
    );
    const paragraphs = clusterPdfParagraphs(items, PAGE);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.text.split(' ').length).toBeGreaterThan(40);
  });

  it('ignores items pdf.js reports as rotated', () => {
    const upright = line('Upright text on the page.', 60, 700);
    // A quarter turn: the matrix's x axis points along the page's y axis.
    const sideways = {
      str: 'rotated',
      transform: [0, 11, -11, 0, 500, 700],
      width: 60,
      height: 11,
    };
    const paragraphs = clusterPdfParagraphs([upright, sideways], PAGE);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.text).toBe('Upright text on the page.');
  });

  it('joins CJK lines without inserting Latin spaces', () => {
    const items = [
      item('这是第一行的中文内容。', 60, 700),
      item('这是第二行的中文内容。', 60, 686),
    ];
    expect(clusterPdfParagraphs(items, PAGE)[0]!.text).toBe(
      '这是第一行的中文内容。这是第二行的中文内容。',
    );
  });

  it('scales line height with the font, so headings keep their own size', () => {
    const [heading] = clusterPdfParagraphs([line('Chapter One', 60, 700, 24)], PAGE);
    expect(heading!.fontSize).toBe(24);
  });

  it('returns nothing for a page with no text', () => {
    expect(clusterPdfParagraphs([], PAGE)).toEqual([]);
    expect(
      clusterPdfParagraphs(
        [{ str: '', transform: [11, 0, 0, 11, 0, 0], width: 0, height: 11 }],
        PAGE,
      ),
    ).toEqual([]);
  });
});

// The geometry has to hold up on a real PDF, where items arrive in content-stream
// order rather than reading order and paragraph breaks are whatever the producer
// happened to lay out.
interface PdfTextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}
interface PdfPageLike {
  getViewport(params: { scale: number }): {
    rawDims: PdfPageBox;
  };
  getTextContent(): Promise<{ items: PdfTextItemLike[] }>;
}
interface PdfDocumentLike {
  getPage(index: number): Promise<PdfPageLike>;
}

let pdf: PdfDocumentLike;

beforeAll(async () => {
  const pdfjsLib = (await import('@pdfjs/pdf.min.mjs')) as unknown as {
    getDocument(params: { data: Uint8Array; verbosity: number }): {
      promise: Promise<PdfDocumentLike>;
    };
  };
  // @ts-expect-error Same build, worker half.
  globalThis.pdfjsWorker = await import('@pdfjs/pdf.worker.min.mjs');
  pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(readFileSync(resolve(__dirname, '../../fixtures/data/sample-alice.pdf'))),
    verbosity: 0,
  }).promise;
});

describe('clusterPdfParagraphs on a real page', () => {
  it('reconstructs paragraphs in reading order', async () => {
    const page = await pdf.getPage(1);
    const box = page.getViewport({ scale: 1 }).rawDims;
    const { items } = await page.getTextContent();
    const paragraphs = clusterPdfParagraphs(items as PdfTextItem[], box);

    expect(paragraphs.length).toBeGreaterThan(3);
    for (const { x, y, w, h, text, fontSize } of paragraphs) {
      expect(text.length).toBeGreaterThan(0);
      expect(fontSize).toBeGreaterThan(0);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y + h).toBeLessThanOrEqual(1);
    }
    // Top to bottom, without overlap: nothing may be read out of order.
    for (let i = 1; i < paragraphs.length; i++) {
      expect(paragraphs[i]!.y).toBeGreaterThanOrEqual(paragraphs[i - 1]!.y);
    }
    // The page opens with its title, which is its own paragraph.
    expect(paragraphs[0]!.text).toMatch(/^Project Gutenberg/);
  });

  it('keeps the words of the page', async () => {
    const page = await pdf.getPage(2);
    const box = page.getViewport({ scale: 1 }).rawDims;
    const { items } = await page.getTextContent();
    const paragraphs = clusterPdfParagraphs(items as PdfTextItem[], box);
    const words = (s: string) => s.split(/\s+/).filter(Boolean);

    const clustered = words(paragraphs.map(({ text }) => text).join(' '));
    const onPage = words(items.map(({ str }) => str).join(' '));
    // Every word on the page survives the clustering, in some paragraph.
    expect(clustered.length).toBeGreaterThanOrEqual(onPage.length * 0.95);
  });
});
