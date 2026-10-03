// Why a PDF is chunked from its own text items rather than from the DOM the way
// an EPUB is: the page's text is positioned, so a CFI built from one of those
// positions does not resolve in the reader. These tests pin the chunk shape the
// indexer writes and that the RAG search reads back.

import { describe, expect, it } from 'vitest';

import { chunkPdfSection, type PdfParagraphText } from '@/services/reedy/retrieval/pdfChunker';

const paragraph = (text: string): PdfParagraphText => ({ text, fontSize: 11 });

describe('chunkPdfSection', () => {
  const run = (
    paragraphs: PdfParagraphText[],
    over: Partial<Parameters<typeof chunkPdfSection>[1]> = {},
  ) =>
    chunkPdfSection(paragraphs, {
      sectionIndex: 4,
      chapterTitle: 'Page 5',
      bookHash: 'hash',
      positionOffset: 0,
      ...over,
    });

  it('makes one chunk per paragraph', () => {
    const chunks = run([
      paragraph('The first paragraph of the page, in full.'),
      paragraph('The second paragraph of the page, also in full.'),
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toBe('The first paragraph of the page, in full.');
    expect(chunks[1]!.text).toBe('The second paragraph of the page, also in full.');
  });

  it('leaves out paragraphs with nothing to retrieve', () => {
    // A page number, a rule, a stray glyph: embedding them wastes a slot and
    // retrieves nothing, while a heading has letters and stays.
    const chunks = run([
      paragraph('42'),
      paragraph('   '),
      paragraph('The only real paragraph on the page.'),
      paragraph('—'),
    ]);
    expect(chunks.map(({ text }) => text)).toEqual(['The only real paragraph on the page.']);
  });

  it('keeps a heading, which is one word but names the chapter', () => {
    expect(run([paragraph('Introduction')]).map(({ text }) => text)).toEqual(['Introduction']);
  });

  it('carries no CFI, so the reader does not jump to a wrong place', () => {
    for (const chunk of run([paragraph('Some text on the page.')])) {
      expect(chunk.startCfi).toBe('');
      expect(chunk.endCfi).toBe('');
    }
  });

  it('keeps chunk ids and order unique across the whole book', () => {
    // Pages are indexed in order, so the second page's first chunk must not
    // take the id of the first page's.
    const first = run([paragraph('One.'), paragraph('Two.')], { sectionIndex: 0 });
    const second = run([paragraph('Three.')], { sectionIndex: 1, positionOffset: first.length });
    expect([...first, ...second].map(({ id }) => id)).toEqual(['hash-0', 'hash-1', 'hash-2']);
    expect(second[0]!.positionIndex).toBe(2);
    expect(second[0]!.sectionIndex).toBe(1);
  });

  it('names the chunk after the page it came from', () => {
    expect(run([paragraph('Text.')])[0]!.chapterTitle).toBe('Page 5');
  });

  it('counts words for the storage layer', () => {
    expect(run([paragraph('four short words here')])[0]!.tokenCount).toBe(4);
  });
});
