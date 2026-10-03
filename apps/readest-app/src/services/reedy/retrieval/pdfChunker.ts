// A PDF page has no flow content to chunk: its text is positioned, and a CFI
// built from one of those positions does not resolve in the reader (the page's
// rendered DOM is rebuilt on every zoom, and the positions carry the zoom).
// So a PDF is chunked from its own text items — the same paragraph grouping the
// translation overlay uses — and the chunks carry no CFI, which the Thread
// renders as a static row instead of a link.
//
// Both unit-tested against a real PDF, like pdfLayout.

import type { ChunkRow } from '@/services/reedy/db/types';

/** Paragraphs of one page, as `clusterPdfParagraphs` reports them. */
export interface PdfParagraphText {
  text: string;
  fontSize: number;
}

/**
 * A page number, a rule, a stray glyph: no letters, so embedding it would spend
 * a slot to retrieve nothing. A heading has letters and is worth keeping.
 */
const hasLetters = (text: string) => /\p{L}/u.test(text);

const tokenCount = (text: string) => {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

/**
 * Turns one PDF page's paragraphs into index chunks. Paragraphs are already
 * near a chunk's worth of text, so each is one chunk rather than being sliced
 * again — the alternative (a window over the page) would cut paragraphs in half
 * and give the retriever fragments with no start or end.
 */
export const chunkPdfSection = (
  paragraphs: PdfParagraphText[],
  {
    sectionIndex,
    chapterTitle,
    bookHash,
    positionOffset,
  }: {
    sectionIndex: number;
    chapterTitle: string;
    bookHash: string;
    /** Global running chunk count, so ids stay unique across the book. */
    positionOffset: number;
  },
): ChunkRow[] =>
  paragraphs
    .filter(({ text }) => hasLetters(text))
    .map(({ text }, index) => {
      const positionIndex = positionOffset + index;
      return {
        id: `${bookHash}-${positionIndex}`,
        bookHash,
        sectionIndex,
        chapterTitle,
        startCfi: '',
        endCfi: '',
        positionIndex,
        text,
        tokenCount: tokenCount(text),
      };
    });
