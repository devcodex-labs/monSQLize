/**
 * findPage() example - cursor-based and offset-based pagination.
 * See: docs/en/findPage.md and docs/zh/findPage.md
 *
 * Run:
 *   npm run build && tsc -p tsconfig.examples.json
 *   node .generated/examples-dist/examples/docs/find-page.js
 */
import { setupExample, teardownExample } from '../helpers/bootstrap.js';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

interface ArticleDoc { title: string; views: number; published: boolean; }

async function main() {
    const { msq, server } = await setupExample('example-find-page');
    const articles = msq.collection<ArticleDoc>('articles');

    // Seed 15 articles
    await articles.insertMany(
        Array.from({ length: 15 }, (_, i) => ({
            title: `Article ${i + 1}`,
            views: (i + 1) * 10,
            published: true,
        })),
    );

    // ── Cursor-based pagination (default) ─────────────────────────────────
    // findPage() takes a single FindPageOptions object.
    const page1 = await articles.findPage({
        query: { published: true },
        limit: 5,
        sort: { views: -1 },
    });
    console.log('Page 1 - items:', page1.items.length);
    console.log('Page 1 - hasNext:', page1.pageInfo.hasNext);
    console.log('Page 1 - hasPrev:', page1.pageInfo.hasPrev);
    console.log('Page 1 - cursor:', page1.pageInfo.endCursor ? 'present' : 'absent');

    // ── Query-level page result cache ─────────────────────────────────────
    const cachedPage = await articles.findPage({
        query: { published: true },
        limit: 5,
        sort: { views: -1 },
        cache: 60_000,
        meta: true,
    });
    const cachedPageAgain = await articles.findPage({
        query: { published: true },
        limit: 5,
        sort: { views: -1 },
        cache: 60_000,
        meta: true,
    });
    console.log('Cached page - items:', cachedPage.items.length);
    console.log('Cached page hit:', cachedPageAgain.meta?.cacheHit === true);

    // Custom normalizers handle every sort field, including the _id tie-breaker.
    // Bump the stable version whenever this conversion behavior changes.
    const versionedOptions = {
        query: { published: true },
        limit: 5,
        sort: [['views', 'desc']] as [string, 'desc'][],
        projection: { _id: 0 }, // Business fields remain; cursor fields are retained.
        cache: 60_000,
        meta: true,
        cursorValueNormalizer: (field: string, value: unknown) =>
            field === '_id' && typeof value === 'string' ? new ObjectId(value) : value,
        cursorValueNormalizerVersion: 'article-scalars:v1',
    };
    const versionedPage = await articles.findPage(versionedOptions);
    const versionedHit = await articles.findPage(versionedOptions);
    assert.equal(versionedHit.meta?.cacheHit, true);
    assert.equal(versionedPage.items[0]?.title, 'Article 15');
    const versionedNext = await articles.findPage({
        ...versionedOptions,
        after: versionedPage.pageInfo.endCursor ?? undefined,
    });
    assert.equal(versionedNext.items[0]?.title, 'Article 10');
    console.log('Versioned normalizer cache hit:', versionedHit.meta?.cacheHit);
    console.log('Versioned next page - first title:', versionedNext.items[0]?.title);

    // ── Next page using cursor ─────────────────────────────────────────────
    const page2 = await articles.findPage({
        query: { published: true },
        limit: 5,
        sort: { views: -1 },
        after: page1.pageInfo.endCursor ?? undefined,
    });
    console.log('Page 2 - items:', page2.items.length);
    console.log('Page 2 - hasNext:', page2.pageInfo.hasNext);

    // ── Offset-based pagination via page number ────────────────────────────
    const offset2 = await articles.findPage({
        query: { published: true },
        limit: 5,
        sort: { views: 1 },
        page: 2,
    });
    console.log('Offset page 2 - first title:', offset2.items[0]?.title);

    await teardownExample(msq, server);
    console.log('✅ findPage example complete');
}

main().catch((err) => {
    console.error('❌ Example failed:', err);
    process.exit(1);
});
