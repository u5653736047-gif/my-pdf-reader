/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { DatabaseService } from '@/types/database';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import { ReedyDb } from '@/services/reedy/db/ReedyDb';
import { BookIndexer } from '@/services/reedy/retrieval/BookIndexer';
import type { EmbeddingModel } from '@/services/reedy/models/EmbeddingModel';
import type { BookDoc, SectionItem } from '@/libs/document';

const DIM = 4;

function fakeModel(overrides: Partial<EmbeddingModel> = {}): EmbeddingModel {
  return {
    id: 'fake-model',
    dim: DIM,
    batchSize: 2,
    async embed(texts) {
      // Deterministic embedding: char-code sums over four buckets, normalized.
      return texts.map((t) => {
        const v = [0, 0, 0, 0];
        for (let i = 0; i < t.length; i++) {
          v[i % 4]! += t.charCodeAt(i);
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
    },
    ...overrides,
  };
}

function section(id: string, html: string): SectionItem {
  return {
    id,
    cfi: '',
    size: html.length,
    linear: 'yes',
    async createDocument() {
      return new DOMParser().parseFromString(
        `<!DOCTYPE html><html><body>${html}</body></html>`,
        'text/html',
      );
    },
  };
}

function fakeBook(sections: SectionItem[]): BookDoc {
  return {
    metadata: { title: 'T', author: 'A', language: 'en' },
    rendition: {},
    dir: 'ltr',
    sections,
    splitTOCHref: () => [],
    async getCover() {
      return null;
    },
  };
}

describe('BookIndexer', () => {
  let svc: DatabaseService;
  let reedy: ReedyDb;
  let indexer: BookIndexer;

  beforeEach(async () => {
    svc = await NodeDatabaseService.open(':memory:', { experimental: ['index_method'] });
    await migrate(svc, getMigrations('reedy'));
    reedy = new ReedyDb(svc);
    indexer = new BookIndexer(reedy);
  });

  afterEach(async () => {
    await svc.close();
  });

  it('happy path: chunks all sections, writes embeddings, lands status=indexed', async () => {
    const book = fakeBook([
      section('s0', '<p>Alpha bravo charlie delta echo.</p>'),
      section('s1', '<p>Foxtrot golf hotel india juliet.</p>'),
    ]);
    const model = fakeModel();

    await indexer.indexBook(book, 'bk-happy', model);

    const meta = await reedy.getBookMeta('bk-happy');
    expect(meta?.indexingStatus).toBe('indexed');
    expect(meta?.chunkCount).toBeGreaterThan(0);
    expect(meta?.embeddingModel).toBe('fake-model');
    expect(meta?.embeddingDim).toBe(DIM);
    expect(meta?.indexedAt).toBeGreaterThan(0);

    const chunkRows = await svc.select<{ c: number }>(
      "SELECT COUNT(*) as c FROM reedy_book_chunks WHERE book_hash = 'bk-happy'",
    );
    expect(chunkRows[0]!.c).toBeGreaterThan(0);

    const embRows = await svc.select<{ c: number }>(
      "SELECT COUNT(*) as c FROM reedy_book_chunk_embeddings WHERE book_hash = 'bk-happy'",
    );
    expect(embRows[0]!.c).toBe(chunkRows[0]!.c);
  });

  it('image-only book lands status=empty_index with chunk_count=0', async () => {
    const book = fakeBook([section('s0', '<img src="cover.png" alt=""/>')]);
    await indexer.indexBook(book, 'bk-empty', fakeModel());

    const meta = await reedy.getBookMeta('bk-empty');
    expect(meta?.indexingStatus).toBe('empty_index');
    expect(meta?.chunkCount).toBe(0);
  });

  it('respects model.batchSize when calling embed (multiple smaller batches)', async () => {
    const calls: number[] = [];
    const model: EmbeddingModel = {
      id: 'batch-model',
      dim: DIM,
      batchSize: 2,
      async embed(texts) {
        calls.push(texts.length);
        return texts.map(() => [1, 0, 0, 0]);
      },
    };
    // 5 small paragraphs → CfiChunker emits 5 chunks (each well below maxChunkSize)
    const html = Array.from({ length: 5 }, (_, i) => `<p>Para ${i} text here.</p>`).join('');
    const book = fakeBook([section('s0', html)]);

    await indexer.indexBook(book, 'bk-batch', model, {
      chunkOptions: { maxChunkSize: 30, minChunkSize: 5, overlapSize: 0, breakSearchRange: 5 },
    });

    expect(calls.length).toBeGreaterThan(1);
    for (const n of calls) expect(n).toBeLessThanOrEqual(2);
  });

  it('on embed failure lands status=failed with the error message and does not throw past indexBook', async () => {
    const model: EmbeddingModel = {
      id: 'broken-model',
      dim: DIM,
      async embed() {
        throw new Error('embedding gateway down');
      },
    };
    const book = fakeBook([section('s0', '<p>Some real text content.</p>')]);

    await expect(indexer.indexBook(book, 'bk-fail', model)).rejects.toThrow(/gateway down/);

    const meta = await reedy.getBookMeta('bk-fail');
    expect(meta?.indexingStatus).toBe('failed');
    expect(meta?.error).toContain('gateway down');
  });

  it('rejects an embedding model whose returned vector length differs from model.dim', async () => {
    const wrongDimModel: EmbeddingModel = {
      id: 'wrong-dim',
      dim: DIM,
      async embed(texts) {
        // Claims dim=DIM but actually returns dim=DIM+1
        return texts.map(() => Array.from({ length: DIM + 1 }, () => 0));
      },
    };
    const book = fakeBook([section('s0', '<p>Real chunkable content text body.</p>')]);

    await expect(indexer.indexBook(book, 'bk-bad-dim', wrongDimModel)).rejects.toThrow(/dim/);
    const meta = await reedy.getBookMeta('bk-bad-dim');
    expect(meta?.indexingStatus).toBe('failed');
  });

  it('serializes concurrent indexBook calls for the same book (mutex)', async () => {
    let active = 0;
    let maxActive = 0;
    const model: EmbeddingModel = {
      id: 'mtx',
      dim: DIM,
      async embed(texts) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return texts.map(() => [1, 0, 0, 0]);
      },
    };
    const make = () =>
      fakeBook([section('s0', '<p>Content text for serialization test goes here.</p>')]);

    await Promise.all([
      indexer.indexBook(make(), 'bk-mtx', model),
      indexer.indexBook(make(), 'bk-mtx', model),
      indexer.indexBook(make(), 'bk-mtx', model),
    ]);

    // With the mutex, only one indexBook is ever embedding for bk-mtx at a time.
    expect(maxActive).toBe(1);

    // After all three resolve the row is in a terminal state (indexed/empty).
    const meta = await reedy.getBookMeta('bk-mtx');
    expect(meta?.indexingStatus).toBe('indexed');
  });

  it('does NOT serialize indexBook calls across different books', async () => {
    let active = 0;
    let maxActive = 0;
    const model: EmbeddingModel = {
      id: 'cross',
      dim: DIM,
      async embed(texts) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return texts.map(() => [1, 0, 0, 0]);
      },
    };
    const make = () => fakeBook([section('s0', '<p>Cross-book parallelism check.</p>')]);

    await Promise.all([
      indexer.indexBook(make(), 'bookA', model),
      indexer.indexBook(make(), 'bookB', model),
      indexer.indexBook(make(), 'bookC', model),
    ]);

    expect(maxActive).toBeGreaterThan(1);
  });
});

// A PDF page has no flow content to walk, so its chunks come from the file's
// own text items instead (see pdfChunker). These tests pin that path through
// the whole pipeline, against the real paragraph grouping.
describe('BookIndexer — PDF books', () => {
  let svc: DatabaseService;
  let reedy: ReedyDb;
  let indexer: BookIndexer;

  const PAGE_BOX = { pageX: 0, pageY: 0, pageWidth: 612, pageHeight: 792 };

  /** One pdf.js text item per paragraph of a page. */
  const item = (str: string, x: number, baseline: number) => ({
    str,
    transform: [11, 0, 0, 11, x, baseline],
    width: str.length * 5,
    height: 11,
  });

  /** A PDF book: one section per page, each with its own paragraphs. */
  const pdfBook = (pages: string[][]) => {
    const book = fakeBook(pages.map((_, i) => section(`p${i}`, '')));
    (book as { getPDF?: () => unknown }).getPDF = () => ({
      getPage: async (index: number) => ({
        getViewport: () => ({ rawDims: PAGE_BOX }),
        getTextContent: async () => ({
          items: pages[index - 1]!.map((text, line) => item(text, 60, 700 - line * 40)),
        }),
      }),
    });
    return book;
  };

  const storedChunks = (hash: string) =>
    svc
      .select<{ text: string; chapter_title: string | null; section_index: number }>(
        `SELECT text, chapter_title, section_index FROM reedy_book_chunks
         WHERE book_hash = '${hash}' ORDER BY position_index`,
      )
      .then((rows) => rows);

  beforeEach(async () => {
    svc = await NodeDatabaseService.open(':memory:', { experimental: ['index_method'] });
    await migrate(svc, getMigrations('reedy'));
    reedy = new ReedyDb(svc);
    indexer = new BookIndexer(reedy);
  });

  afterEach(async () => {
    await svc.close();
  });

  it('chunks each page from its own paragraphs and lands status=indexed', async () => {
    const book = pdfBook([
      ['The first paragraph of the first page.', 'The second paragraph, same page.'],
      ['A different page entirely.'],
    ]);

    await indexer.indexBook(book, 'bk-pdf', fakeModel());

    const meta = await reedy.getBookMeta('bk-pdf');
    expect(meta?.indexingStatus).toBe('indexed');
    expect(meta?.chunkCount).toBe(3);
    expect(await storedChunks('bk-pdf')).toEqual([
      {
        text: 'The first paragraph of the first page.',
        chapter_title: 'Page 1',
        section_index: 0,
      },
      { text: 'The second paragraph, same page.', chapter_title: 'Page 1', section_index: 0 },
      { text: 'A different page entirely.', chapter_title: 'Page 2', section_index: 1 },
    ]);
  });

  it('drops a page number, which has nothing to retrieve', async () => {
    const book = pdfBook([['42', 'The text of the page.']]);

    await indexer.indexBook(book, 'bk-pdf-numbers', fakeModel());

    expect((await storedChunks('bk-pdf-numbers')).map(({ text }) => text)).toEqual([
      'The text of the page.',
    ]);
  });

  it('reads the pages through pdf.js, not through their documents', async () => {
    const book = pdfBook([['Only one page.']]);
    let createDocumentCalls = 0;
    for (const section of book.sections) {
      section.createDocument = () => {
        createDocumentCalls += 1;
        return Promise.resolve(new DOMParser().parseFromString('<html></html>', 'text/html'));
      };
    }

    await indexer.indexBook(book, 'bk-pdf-nodoc', fakeModel());

    expect(createDocumentCalls).toBe(0);
    expect((await reedy.getBookMeta('bk-pdf-nodoc'))?.indexingStatus).toBe('indexed');
  });

  it('skips a page whose text cannot be read, and indexes the rest', async () => {
    const book = pdfBook([['A readable page.'], ['An unreadable page.']]);
    const pdf = book.getPDF!() as { getPage: (index: number) => Promise<unknown> };
    let firstCall = true;
    (book as { getPDF?: () => unknown }).getPDF = () => ({
      getPage: async (index: number) => {
        if (firstCall) {
          firstCall = false;
          return pdf.getPage(index);
        }
        throw new Error('page data is missing');
      },
    });

    await indexer.indexBook(book, 'bk-pdf-bad-page', fakeModel());

    expect((await storedChunks('bk-pdf-bad-page')).map(({ text }) => text)).toEqual([
      'A readable page.',
    ]);
  });
});
