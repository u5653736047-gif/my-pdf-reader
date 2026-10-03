// The hook is where a PDF's translation becomes something the reader sees: it
// reads the page's paragraphs out of the file, asks the provider for each one,
// paints them into the page's frame, and keeps the result so a page scrolled
// back over is not paid for twice.

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FoliateView } from '@/types/view';
import type { ViewSettings } from '@/types/book';
import type { PdfPageBox, PdfTextItem } from '@/services/translation/pdfLayout';

const translate = vi.fn();

vi.mock('@/hooks/useTranslator', () => ({
  useTranslator: () => ({ translate: (texts: string[]) => translate(texts) }),
}));

const PAGE: PdfPageBox = { pageX: 0, pageY: 0, pageWidth: 612, pageHeight: 792 };

/** Three lines of one paragraph, cut into pdf.js text items. */
const PARAGRAPH_ITEMS: PdfTextItem[] = [
  {
    str: 'The first line of a paragraph.',
    transform: [11, 0, 0, 11, 60, 700],
    width: 200,
    height: 11,
  },
  {
    str: 'The second line of the same paragraph.',
    transform: [11, 0, 0, 11, 60, 686],
    width: 220,
    height: 11,
  },
  { str: 'A short tail.', transform: [11, 0, 0, 11, 60, 672], width: 60, height: 11 },
];

const item = (str: string, x: number, baseline: number) => ({
  str,
  transform: [11, 0, 0, 11, x, baseline],
  width: str.length * 5,
  height: 11,
});

let viewSettings: ViewSettings;
let bookDoc: { getPDF?: () => unknown };
let progress: unknown;
const setIsLoading = vi.fn();

const state = {
  getViewSettings: () => viewSettings,
  setIsLoading,
  getBookData: () => ({ bookDoc }),
  getPDFPageColors: () => undefined,
  getThemeCode: () => ({ bg: '#ffffff', fg: '#000000', isDarkMode: false }),
};

vi.mock('@/store/readerStore', () => ({
  useReaderStore: (selector: (s: unknown) => unknown) => selector(state),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: (selector: (s: unknown) => unknown) => selector(state),
}));
vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => progress,
}));
vi.mock('@/utils/style', () => ({
  getPDFPageColors: () => undefined,
  getThemeCode: () => ({ bg: '#ffffff', fg: '#000000', isDarkMode: false }),
}));

// Imported after the mocks so the hook sees them.
const { usePdfTranslation } = await import('@/app/reader/hooks/usePdfTranslation');

const frameDoc = () => {
  const doc = document.implementation.createHTMLDocument('page');
  // The renderer sizes the frame's document from the page's display viewport.
  Object.defineProperty(doc.documentElement, 'clientWidth', { value: 612 });
  return doc;
};

const makeView = (frames: { doc: Document; index: number }[]) =>
  ({
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    renderer: { getContents: () => frames },
  }) as unknown as FoliateView;

const makePdf = (pages: Record<number, PdfTextItem[]>) => ({
  // Keyed by pdf.js's 1-based page number, as the hook passes it through.
  getPage: async (index: number) => ({
    getViewport: () => ({ rawDims: PAGE }),
    getTextContent: async () => ({ items: pages[index] ?? [] }),
  }),
});

const settings = (over: Partial<ViewSettings> = {}): ViewSettings =>
  ({
    translationEnabled: true,
    translationProvider: 'azure',
    translateTargetLang: 'zh-CN',
    showTranslateSource: false,
    isEink: false,
    applyThemeToPDF: false,
    ...over,
  }) as ViewSettings;

const painted = (doc: Document) => [...doc.querySelectorAll<HTMLElement>('.pdf-translation')];

beforeEach(() => {
  translate.mockReset();
  translate.mockImplementation(async (texts: string[]) => texts.map((text) => `[${text}]`));
  setIsLoading.mockReset();
  viewSettings = settings();
  bookDoc = {
    getPDF: () => makePdf({ 1: PARAGRAPH_ITEMS, 2: [item('Another page entirely.', 60, 700)] }),
  };
  progress = {};
});

describe('usePdfTranslation', () => {
  it('translates the paragraphs of a rendered page and paints them in its frame', async () => {
    const doc = frameDoc();
    const view = makeView([{ doc, index: 0 }]);
    renderHook(() => usePdfTranslation('book', view));

    await waitFor(() => expect(painted(doc).length).toBeGreaterThan(0));
    // One request per paragraph, not per line: the layout groups the three items
    // into the paragraph they form.
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith([
      'The first line of a paragraph. The second line of the same paragraph. A short tail.',
    ]);
    const boxes = painted(doc);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.textContent).toBe(
      '[The first line of a paragraph. The second line of the same paragraph. A short tail.]',
    );
  });

  it('answers with the page’s own box, so a shorter translation still covers the text', async () => {
    const doc = frameDoc();
    renderHook(() => usePdfTranslation('book', makeView([{ doc, index: 0 }])));
    await waitFor(() => expect(painted(doc).length).toBe(1));
    const box = painted(doc)[0]!;
    expect(box.style.left).toBe(`${(60 / 612) * 100}%`);
    expect(box.style.width).toBe(`${(220 / 612) * 100}%`);
    // The first line's top (81pt down) to the last line's bottom (122.2pt), so a
    // one-line translation still covers all three lines of the source.
    expect(box.style.minHeight).toBe(`${((122.2 - 81) / 792) * 100}%`);
  });

  it('leaves the page alone when the translator answers with the source text', async () => {
    translate.mockImplementation(async (texts: string[]) => texts);
    const doc = frameDoc();
    renderHook(() => usePdfTranslation('book', makeView([{ doc, index: 0 }])));

    await waitFor(() => expect(translate).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(painted(doc)).toHaveLength(0);
  });

  it('spends no second request when the page comes back into view', async () => {
    const doc = frameDoc();
    const view = makeView([{ doc, index: 0 }]);
    const { rerender } = renderHook(() => usePdfTranslation('book', view));
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    // A scroll back over the same page re-runs the sweep: the progress store
    // hands out a fresh object for every relocation.
    progress = { ...(progress as object) };
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('translates a page that loads later, when the reader scrolls to it', async () => {
    const first = frameDoc();
    const second = frameDoc();
    const view = makeView([{ doc: first, index: 0 }]);
    const { rerender } = renderHook(() => usePdfTranslation('book', view));
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    // The frame's own 'load' event carries the page that just rendered.
    const listener = (
      view.addEventListener as unknown as { mock: { calls: [string, EventListener][] } }
    ).mock.calls.find(([type]) => type === 'load')![1];
    listener(new CustomEvent('load', { detail: { doc: second, index: 1 } }));

    await waitFor(() => expect(painted(second).length).toBe(1));
    expect(painted(second)[0]!.textContent).toBe('[Another page entirely.]');
    rerender();
  });

  it('takes the translation away when it is switched off', async () => {
    const doc = frameDoc();
    const view = makeView([{ doc, index: 0 }]);
    const { rerender } = renderHook(() => usePdfTranslation('book', view));
    await waitFor(() => expect(painted(doc).length).toBe(1));

    viewSettings = settings({ translationEnabled: false });
    rerender();
    await waitFor(() => expect(painted(doc).length).toBe(0));
    expect(doc.querySelector('.pdf-translation-layer')).toBeNull();
  });

  it('translates again for a different target language', async () => {
    const doc = frameDoc();
    const view = makeView([{ doc, index: 0 }]);
    const { rerender } = renderHook(() => usePdfTranslation('book', view));
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    viewSettings = settings({ translateTargetLang: 'ja' });
    rerender();
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
    expect(painted(doc)[0]!.textContent).toBe(
      '[The first line of a paragraph. The second line of the same paragraph. A short tail.]',
    );
  });

  it('paints nothing while translation is off', async () => {
    viewSettings = settings({ translationEnabled: false });
    const doc = frameDoc();
    renderHook(() => usePdfTranslation('book', makeView([{ doc, index: 0 }])));

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(translate).not.toHaveBeenCalled();
    expect(painted(doc)).toHaveLength(0);
  });
});
