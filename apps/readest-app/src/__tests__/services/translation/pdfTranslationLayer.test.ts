// The overlay has to be a set of boxes glued to the page: percentage-positioned
// (so a zoom does not move them), sized in the page's own line height (so the
// text matches the page it sits on), and inert (so the reader's own selection
// and annotation hit-testing still reaches the page underneath).

import { describe, expect, it } from 'vitest';

import {
  PdfTranslationBox,
  PdfTranslationColors,
  removePdfTranslationLayer,
  renderPdfTranslationLayer,
  setPdfTranslationLayerVisible,
} from '@/services/translation/pdfTranslationLayer';

const COLORS: PdfTranslationColors = {
  background: '#ffffff',
  foreground: '#111111',
  border: 'transparent',
};

/** One paragraph, as the layout module reports it. */
const box = (over: Partial<PdfTranslationBox> = {}): PdfTranslationBox => ({
  text: 'source',
  translated: 'translated',
  x: 0.1,
  y: 0.2,
  w: 0.8,
  h: 0.05,
  fontSize: 11,
  ...over,
});

const layerOf = (doc: Document) => doc.querySelector<HTMLElement>('.pdf-translation-layer');
const boxesOf = (doc: Document) => [...layerOf(doc)!.children] as HTMLElement[];

const frame = () => document.implementation.createHTMLDocument('page');

describe('renderPdfTranslationLayer', () => {
  it('paints a box per translated paragraph, at the paragraph’s own box', () => {
    const doc = frame();
    renderPdfTranslationLayer(doc, [box(), box({ translated: 'second', x: 0.1, y: 0.4 })], COLORS);
    const boxes = boxesOf(doc);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.textContent).toBe('translated');
    expect(boxes[0]!.style.left).toBe('10%');
    expect(boxes[0]!.style.top).toBe('20%');
    expect(boxes[0]!.style.width).toBe('80%');
    expect(boxes[0]!.style.minHeight).toBe('5%');
    expect(boxes[1]!.textContent).toBe('second');
  });

  it('sizes the text with the page’s own zoom factor', () => {
    const doc = frame();
    renderPdfTranslationLayer(doc, [box({ fontSize: 12.5 })], COLORS);
    // The renderer sets --total-scale-factor on the frame's document at every
    // zoom, so the glyphs track the page without any measurement.
    expect(boxesOf(doc)[0]!.style.fontSize).toBe('calc(var(--total-scale-factor, 1) * 12.5px)');
  });

  it('never shrinks below the source paragraph’s height', () => {
    const doc = frame();
    renderPdfTranslationLayer(doc, [box({ h: 0.12 })], COLORS);
    expect(boxesOf(doc)[0]!.style.minHeight).toBe('12%');
  });

  it('takes the theme’s colors', () => {
    const doc = frame();
    renderPdfTranslationLayer(doc, [box()], {
      background: '#101418',
      foreground: '#e6e6e6',
      border: 'transparent',
    });
    const painted = boxesOf(doc)[0]!;
    // jsdom normalizes colors to rgb().
    expect(painted.style.background).toBe('rgb(16, 20, 24)');
    expect(painted.style.color).toBe('rgb(230, 230, 230)');
    expect(painted.style.border).toBe('1px solid transparent');
  });

  it('stays out of the reader’s way', () => {
    const doc = frame();
    renderPdfTranslationLayer(doc, [box()], COLORS);
    const layer = layerOf(doc)!;
    expect(layer.style.pointerEvents).toBe('none');
    // Above the text and annotation layers, which pdf.js styles at z-index 0.
    expect(layer.style.zIndex).toBe('2');
  });

  it('replaces the previous paint instead of stacking on it', () => {
    const doc = frame();
    renderPdfTranslationLayer(doc, [box(), box({ translated: 'old' })], COLORS);
    renderPdfTranslationLayer(doc, [box({ translated: 'new' })], COLORS);
    const boxes = boxesOf(doc);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.textContent).toBe('new');
    // One layer per frame, however many times it is painted.
    expect(doc.querySelectorAll('.pdf-translation-layer')).toHaveLength(1);
  });

  it('leaves nothing behind when removed', () => {
    const doc = frame();
    renderPdfTranslationLayer(doc, [box()], COLORS);
    removePdfTranslationLayer(doc);
    expect(layerOf(doc)).toBeNull();
  });
});

describe('setPdfTranslationLayerVisible', () => {
  it('steps aside while the reader selects the text it covers', () => {
    const doc = frame();
    renderPdfTranslationLayer(doc, [box()], COLORS);
    const layer = layerOf(doc)!;
    expect(layer.style.visibility).toBe('');

    setPdfTranslationLayerVisible(doc, false);
    expect(layer.style.visibility).toBe('hidden');

    // The selection is gone, so the translation is back.
    setPdfTranslationLayerVisible(doc, true);
    expect(layer.style.visibility).toBe('');
  });

  it('keeps what it painted, so coming back does not re-translate', () => {
    const doc = frame();
    renderPdfTranslationLayer(doc, [box()], COLORS);
    setPdfTranslationLayerVisible(doc, false);
    expect(boxesOf(doc)).toHaveLength(1);
  });

  it('does nothing on a page it never painted', () => {
    const doc = frame();
    setPdfTranslationLayerVisible(doc, false);
    expect(layerOf(doc)).toBeNull();
  });
});
