// The overlay that paints translated paragraphs onto a PDF page.
//
// It lives inside the page's own iframe, next to the text layer, for two
// reasons: a percentage box needs no coordinate conversion between the reader
// and the frame, and `--total-scale-factor` (set on the frame's document by the
// renderer on every zoom) lets the translation track the page's zoom exactly as
// the source text layer's glyphs do.
//
// The source text is not hidden and not moved: a translated paragraph is opaque
// and sized to the source's own box, so it covers the text it replaces. A
// translation taller than its source simply runs over the paragraph below,
// which paints after it — the same trade-off every in-place PDF translator
// makes.

import type { PdfParagraph } from './pdfLayout';

/** A paragraph of the page with the text to put in its box. */
export interface PdfTranslationBox extends PdfParagraph {
  translated: string;
}

export interface PdfTranslationColors {
  background: string;
  foreground: string;
  /** A hairline for e-ink screens, which cannot lean on a background tint. */
  border: string;
}

const LAYER_CLASS = 'pdf-translation-layer';
/** Above the text layer (z-index 0) and the annotation layer. */
const LAYER_Z_INDEX = 2;

const createLayer = (doc: Document) => {
  const layer = doc.createElement('div');
  layer.className = LAYER_CLASS;
  // The reader's own hit-testing (selection, annotation, links) must not see
  // this layer: it is a page's worth of boxes sitting over the whole page.
  layer.setAttribute(
    'style',
    `position:absolute;inset:0;z-index:${LAYER_Z_INDEX};pointer-events:none`,
  );
  doc.body.appendChild(layer);
  return layer;
};

const createBox = (
  { x, y, w, h, fontSize, translated }: PdfTranslationBox,
  colors: PdfTranslationColors,
) => {
  const box = document.createElement('div');
  box.className = 'pdf-translation';
  // The source paragraph's own language is not the translation's, and its
  // direction is whatever the page was. Resolved from the text instead, so
  // Arabic and Hebrew align to the right rather than inheriting the page.
  box.setAttribute('dir', 'auto');
  Object.assign(box.style, {
    position: 'absolute',
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: `${w * 100}%`,
    // Never smaller than the source paragraph, so the text it stands in for is
    // covered even when the translation is shorter.
    minHeight: `${h * 100}%`,
    fontSize: `calc(var(--total-scale-factor, 1) * ${fontSize}px)`,
    lineHeight: '1.4',
    padding: '0.1em 0.25em',
    background: colors.background,
    color: colors.foreground,
    border: `1px solid ${colors.border}`,
    borderRadius: '0.15em',
    textAlign: 'start',
    overflowWrap: 'break-word',
  });
  box.textContent = translated;
  return box;
};

/**
 * Paints one page's translations, replacing whatever was painted before. The
 * renderer rebuilds the text layer on every zoom but leaves the rest of the
 * frame alone, so a layer painted here survives a zoom untouched.
 */
export const renderPdfTranslationLayer = (
  doc: Document,
  boxes: PdfTranslationBox[],
  colors: PdfTranslationColors,
) => {
  const layer = doc.querySelector<HTMLElement>(`.${LAYER_CLASS}`) ?? createLayer(doc);
  layer.replaceChildren(...boxes.map((box) => createBox(box, colors)));
};

/**
 * Steps the layer out of the way while the reader is working on the source
 * text. Selecting text that a translation covers is blind — the selection
 * highlight is painted underneath the overlay — and annotating is the reader's
 * main job, so the overlay gives way for as long as there is a selection.
 */
export const setPdfTranslationLayerVisible = (doc: Document, visible: boolean) => {
  const layer = doc.querySelector<HTMLElement>(`.${LAYER_CLASS}`);
  if (layer) layer.style.visibility = visible ? '' : 'hidden';
};

export const removePdfTranslationLayer = (doc: Document) => {
  doc.querySelector(`.${LAYER_CLASS}`)?.remove();
};
