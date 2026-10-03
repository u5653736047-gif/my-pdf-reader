import { useCallback, useEffect, useRef, useState } from 'react';
import { FoliateView } from '@/types/view';
import { UseTranslatorOptions } from '@/services/translators';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useTranslator } from '@/hooks/useTranslator';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { getLocale } from '@/utils/misc';
import { getPDFPageColors, getThemeCode } from '@/utils/style';
import {
  clusterPdfParagraphs,
  type PdfPageBox,
  type PdfParagraph,
  type PdfTextItem,
} from '@/services/translation/pdfLayout';
import {
  removePdfTranslationLayer,
  renderPdfTranslationLayer,
  type PdfTranslationBox,
  type PdfTranslationColors,
} from '@/services/translation/pdfTranslationLayer';

/**
 * Immersive translation for PDFs.
 *
 * An EPUB paragraph is translated in place — a wrapper appended to it, so it
 * reflows with the document. A PDF page cannot reflow: its text is positioned
 * over a canvas. So the translation is painted into the page's own frame, one
 * box per source paragraph at that paragraph's position, in the page's line
 * height. The source paragraph is covered rather than moved.
 *
 * Only the pages on screen are translated, and each page is translated once:
 * the result stays in `pages`, so scrolling back neither re-translates nor
 * spends another request on it.
 */

const MAX_CONCURRENT_TRANSLATIONS = 3;

/** The slice of pdf.js this feature reads, typed as it uses it. */
interface PdfDocumentLike {
  getPage(index: number): Promise<{
    getViewport(params: { scale: number }): { rawDims: PdfPageBox };
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
  }>;
}

interface PageTranslations {
  paragraphs: PdfParagraph[];
  translations: (string | undefined)[];
}

interface TranslationJob {
  pageIndex: number;
  paragraphIndex: number;
  text: string;
}

export const usePdfTranslation = (bookKey: string, view: FoliateView | null) => {
  const _ = useTranslation();
  const getBookData = useBookDataStore((s) => s.getBookData);
  const getViewSettings = useReaderStore((s) => s.getViewSettings);
  const setIsLoading = useReaderStore((s) => s.setIsLoading);
  const viewSettings = getViewSettings(bookKey);
  // Reactive on purpose: a page turn re-runs the sweep over the visible pages.
  const progress = useBookProgress(bookKey);

  const enabled = useRef(viewSettings?.translationEnabled);
  const [provider, setProvider] = useState(viewSettings?.translationProvider);
  const [targetLang, setTargetLang] = useState(viewSettings?.translateTargetLang);

  const { translate } = useTranslator({
    provider,
    targetLang: targetLang || getLocale(),
  } as UseTranslatorOptions);
  const translateRef = useRef(translate);

  const pages = useRef(new Map<number, PageTranslations>());
  const frames = useRef(new Map<number, Document>());
  const queue = useRef<TranslationJob[]>([]);
  const active = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const colors = useRef<PdfTranslationColors>({
    background: '#ffffff',
    foreground: '#1a1a1a',
    border: 'transparent',
  });

  useEffect(() => {
    translateRef.current = translate;
  }, [translate]);

  const getPdf = useCallback(
    () => getBookData(bookKey)?.bookDoc?.getPDF?.() as PdfDocumentLike | undefined,
    [bookKey, getBookData],
  );

  const paintPage = useCallback((pageIndex: number) => {
    const doc = frames.current.get(pageIndex);
    const page = pages.current.get(pageIndex);
    if (!doc || !page) return;
    const boxes: PdfTranslationBox[] = [];
    page.paragraphs.forEach((paragraph, index) => {
      const translated = page.translations[index];
      if (translated) boxes.push({ ...paragraph, translated });
    });
    renderPdfTranslationLayer(doc, boxes, colors.current);
  }, []);

  const drainQueue = useCallback(() => {
    while (active.current < MAX_CONCURRENT_TRANSLATIONS && queue.current.length > 0) {
      const job = queue.current.shift()!;
      const page = pages.current.get(job.pageIndex);
      if (!page || page.translations[job.paragraphIndex]) continue;
      active.current += 1;
      translateRef
        .current([job.text])
        .then((parts) => {
          const translated = parts.join('').trim();
          if (translated && translated !== job.text) {
            page.translations[job.paragraphIndex] = translated;
            paintPage(job.pageIndex);
          }
        })
        .catch((err: unknown) => {
          console.warn('PDF translation failed:', err);
        })
        .finally(() => {
          active.current -= 1;
          drainQueue();
        });
    }
    if (queue.current.length === 0 && active.current === 0) {
      setTimeout(() => setIsLoading(bookKey, false), 500);
    }
  }, [bookKey, paintPage, setIsLoading]);

  const hintTranslating = useCallback(() => {
    setIsLoading(bookKey, true);
    eventDispatcher.dispatch('hint', { bookKey, message: _('Translating...') });
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => {
      hintTimer.current = null;
      setIsLoading(bookKey, false);
    }, 2000);
  }, [bookKey, setIsLoading, _]);

  /** Reads a page's paragraphs out of the file, once per translation settings. */
  const loadPage = useCallback(
    async (pdf: PdfDocumentLike, pageIndex: number): Promise<PageTranslations | null> => {
      const cached = pages.current.get(pageIndex);
      if (cached) return cached;
      try {
        const page = await pdf.getPage(pageIndex + 1);
        const { items } = await page.getTextContent();
        const paragraphs = clusterPdfParagraphs(items, page.getViewport({ scale: 1 }).rawDims);
        const entry: PageTranslations = {
          paragraphs,
          translations: paragraphs.map(() => undefined),
        };
        pages.current.set(pageIndex, entry);
        return entry;
      } catch (err) {
        console.warn('Failed to read PDF text for translation:', err);
        return null;
      }
    },
    [],
  );

  const queuePage = useCallback((pageIndex: number) => {
    const page = pages.current.get(pageIndex);
    if (!page) return;
    page.paragraphs.forEach(({ text }, paragraphIndex) => {
      if (page.translations[paragraphIndex]) return;
      const queued = queue.current.some(
        (job) => job.pageIndex === pageIndex && job.paragraphIndex === paragraphIndex,
      );
      if (!queued) queue.current.push({ pageIndex, paragraphIndex, text });
    });
  }, []);

  const translateFrame = useCallback(
    async (pdf: PdfDocumentLike, doc: Document, pageIndex: number) => {
      frames.current.set(pageIndex, doc);
      const page = await loadPage(pdf, pageIndex);
      if (!page) return;
      paintPage(pageIndex);
      queuePage(pageIndex);
      if (queue.current.length > 0) {
        hintTranslating();
        drainQueue();
      }
    },
    [drainQueue, hintTranslating, loadPage, paintPage, queuePage],
  );

  const clear = useCallback(() => {
    queue.current = [];
    active.current = 0;
    pages.current.clear();
    for (const doc of frames.current.values()) removePdfTranslationLayer(doc);
    frames.current = new Map();
    setIsLoading(bookKey, false);
  }, [bookKey, setIsLoading]);

  // A page's frame finishes loading after its text layer is built, so this is
  // the moment it can be painted. The sweep below covers the pages that were
  // already on screen when translation was switched on.
  useEffect(() => {
    if (!view || !enabled.current) return undefined;
    const onLoad = (event: Event) => {
      if (!enabled.current) return;
      const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail ?? {};
      const pdf = getPdf();
      if (!doc || typeof index !== 'number' || !pdf) return;
      void translateFrame(pdf, doc, index);
    };
    view.addEventListener('load', onLoad);
    return () => view.removeEventListener('load', onLoad);
  }, [view, getPdf, translateFrame]);

  useEffect(() => {
    if (!enabled.current || !progress) return;
    const timer = setTimeout(() => {
      const pdf = getPdf();
      if (!pdf || !view) return;
      frames.current = new Map();
      for (const { doc, index } of view.renderer.getContents()) {
        if (index === undefined) continue;
        void translateFrame(pdf, doc, index);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [progress, view, getPdf, translateFrame]);

  useEffect(() => {
    if (!viewSettings) return;

    const themeCode = getThemeCode();
    const pageColors = getPDFPageColors(viewSettings, themeCode);
    colors.current = {
      background: pageColors?.background ?? '#ffffff',
      foreground: pageColors?.foreground ?? '#1a1a1a',
      // E-ink screens have no background tint to lean on, so the box needs a
      // hairline to say where the translation ends.
      border: viewSettings.isEink ? themeCode.fg : 'transparent',
    };

    const enabledChanged = enabled.current !== viewSettings.translationEnabled;
    const providerChanged = provider !== viewSettings.translationProvider;
    const targetLangChanged = targetLang !== viewSettings.translateTargetLang;

    if (enabledChanged) enabled.current = viewSettings.translationEnabled;
    if (providerChanged) setProvider(viewSettings.translationProvider);
    if (targetLangChanged) setTargetLang(viewSettings.translateTargetLang);

    if (enabledChanged || providerChanged || targetLangChanged) {
      // A translation belongs to one target language and one provider.
      clear();
      const pdf = getPdf();
      if (enabled.current && pdf && view) {
        frames.current = new Map();
        for (const { doc, index } of view.renderer.getContents()) {
          if (index === undefined) continue;
          void translateFrame(pdf, doc, index);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey, viewSettings, provider, targetLang]);

  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
      for (const doc of frames.current.values()) removePdfTranslationLayer(doc);
    },
    [],
  );
};
