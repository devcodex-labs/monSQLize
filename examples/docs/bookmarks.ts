/**
 * Bookmark maintenance example — prewarm, list, and clear bookmark cache.
 * See: docs/en/bookmarks.md and docs/zh/bookmarks.md
 */
import { setupExample, teardownExample } from '../helpers/bootstrap.js';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

async function main() {
    const { msq, server } = await setupExample('example-bookmarks');
    const posts = msq.collection('posts');

    await posts.insertMany([
        { title: 'A', status: 'published', createdAt: new Date('2026-05-01T00:00:00Z') },
        { title: 'B', status: 'published', createdAt: new Date('2026-05-02T00:00:00Z') },
        { title: 'C', status: 'published', createdAt: new Date('2026-05-03T00:00:00Z') },
        { title: 'D', status: 'published', createdAt: new Date('2026-05-04T00:00:00Z') },
    ]);

    const keyDims = {
        query: { status: 'published' },
        sort: { createdAt: 1 as const },
        limit: 1,
        // A custom normalizer replaces default restoration for every cursor field.
        cursorValueNormalizer: (field: string, value: unknown) => {
            if (typeof value !== 'string') return value;
            if (field === '_id') return new ObjectId(value);
            if (field === 'createdAt') return new Date(value);
            return value;
        },
        cursorValueNormalizerVersion: 'post-date-and-id:v1',
    };

    const prewarmed = await posts.prewarmBookmarks(keyDims, [1, 2, 3]);
    const listed = await posts.listBookmarks(keyDims);
    assert.equal(prewarmed.failed, 0);
    assert.deepEqual(listed.pages, [1, 2, 3]);
    const secondPage = await posts.findPage({ ...keyDims, page: 2 });
    assert.equal(secondPage.items[0]?.title, 'B');
    const cleared = await posts.clearBookmarks(keyDims);
    assert.equal((await posts.listBookmarks(keyDims)).count, 0);

    console.log('prewarm warmed:', prewarmed.warmed, '| failed:', prewarmed.failed);
    console.log('listed pages:', listed.pages?.join(', ') ?? 'none');
    console.log('clear result:', cleared.cleared, '| keysBefore:', cleared.keysBefore);

    await teardownExample(msq, server);
    console.log('✅ Bookmarks example complete');
}

main().catch((err) => {
    console.error('❌ Example failed:', err);
    process.exit(1);
});
