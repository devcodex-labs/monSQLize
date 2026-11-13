/**
 * Create a Search index of type vectorSearch, wait until it is queryable,
 * and query it with collection.vectorSearch().
 *
 * See: docs/vector-search.md, docs/search-indexes.md
 *
 * Required environment (either variable):
 *   MONSQLIZE_VECTOR_SEARCH_URI
 *   MONSQLIZE_ATLAS_LOCAL_URI
 *
 * Point the URI at MongoDB Atlas, the mongodb/mongodb-atlas-local image, or
 * a compatible MongoDB Community/Enterprise + mongot pair. MongoDB 8.2 is EOL;
 * pair current self-managed versions using the official compatibility table. Plain mongod and the default
 * mongodb-memory-server cannot serve Search indexes.
 *
 * When neither variable is set, this process prints a skip line and exits 0
 * so `npm run test:examples` can compile and invoke it without a Search server.
 *
 * Run after building the project:
 *   npm run build && tsc -p tsconfig.examples.json
 *   MONSQLIZE_VECTOR_SEARCH_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
 *     node .generated/examples-dist/examples/docs/vector-search.js
 */
import MonSQLize from 'monsqlize';
import { Binary } from 'mongodb';

const DIMENSIONS = 8;
const INDEX_NAME = 'articles_embedding_index';

interface ArticleDoc {
    title: string;
    status: 'draft' | 'published';
    embedding: number[];
    embeddingInt8: Binary;
    embeddingInt1: Binary;
}

function searchUri(): string | undefined {
    const raw = process.env.MONSQLIZE_VECTOR_SEARCH_URI || process.env.MONSQLIZE_ATLAS_LOCAL_URI;
    const uri = raw?.trim();
    return uri ? uri : undefined;
}

function embedding(seed: number): number[] {
    return Array.from({ length: DIMENSIONS }, (_, index) => Math.sin(seed + index) / 2);
}

async function main(): Promise<void> {
    const uri = searchUri();
    if (!uri) {
        console.log('[vector-search] SKIPPED: set MONSQLIZE_VECTOR_SEARCH_URI or MONSQLIZE_ATLAS_LOCAL_URI (Atlas, mongodb/mongodb-atlas-local, or a compatible Community/Enterprise + mongot pair).');
        return;
    }

    const databaseName = process.env.MONSQLIZE_VECTOR_SEARCH_DB?.trim() || 'monsqlize_vector_example';
    const collectionName = `articles_${Date.now().toString(36)}`;
    const msq = new MonSQLize({
        type: 'mongodb',
        databaseName,
        config: { uri },
    });

    await msq.connect();
    const articles = msq.collection<ArticleDoc>(collectionName);

    try {
        const inputs: Array<Omit<ArticleDoc, 'embeddingInt8' | 'embeddingInt1'>> = [
            { title: 'published-near', status: 'published', embedding: embedding(0.2) },
            { title: 'published-far', status: 'published', embedding: embedding(2.4) },
            { title: 'draft-near', status: 'draft', embedding: embedding(0.25) },
        ];
        const documents: ArticleDoc[] = inputs.map((document) => ({
            ...document,
            embeddingInt8: Binary.fromInt8Array(Int8Array.from(document.embedding.map(value => Math.round(value * 127)))),
            embeddingInt1: Binary.fromBits(document.embedding.map(value => value >= 0 ? 1 : 0)),
        }));
        await articles.insertMany(documents);

        const created = await articles.createSearchIndex({
            name: INDEX_NAME,
            type: 'vectorSearch',
            definition: {
                fields: [
                    {
                        type: 'vector',
                        path: 'embedding',
                        numDimensions: DIMENSIONS,
                        similarity: 'cosine',
                    },
                    { type: 'filter', path: 'status' },
                ],
            },
        });
        console.log('createSearchIndex:', created.name, created.action);

        const ready = await articles.waitForSearchIndex(INDEX_NAME, {
            until: 'queryable',
            timeoutMs: 600_000,
        });
        console.log('waitForSearchIndex:', ready.status, ready.queryable);

        const hits = await articles.vectorSearch({
            index: INDEX_NAME,
            path: 'embedding',
            queryVector: embedding(0.2),
            limit: 2,
            numCandidates: 10,
            filter: { status: 'published' },
        });

        if (hits.length === 0) {
            throw new Error('vectorSearch returned no hits');
        }

        for (const hit of hits) {
            if (!Number.isFinite(hit.score)) {
                throw new Error('vectorSearch hit is missing a finite score');
            }
            if (hit.document.status !== 'published') {
                throw new Error(`vectorSearch filter leaked status ${String(hit.document.status)}`);
            }
            console.log(hit.score, hit.document.title);
        }

        for (const [name, path, similarity, queryVector] of [
            ['articles_int8_index', 'embeddingInt8', 'cosine', documents[0].embeddingInt8],
            ['articles_int1_index', 'embeddingInt1', 'euclidean', documents[0].embeddingInt1],
        ] as const) {
            await articles.createSearchIndex({
                name, type: 'vectorSearch',
                definition: { fields: [
                    { type: 'vector', path, numDimensions: DIMENSIONS, similarity },
                    { type: 'filter', path: 'status' },
                ] },
            });
            await articles.waitForSearchIndex(name, { timeoutMs: 600_000 });
            const binaryHits = await articles.vectorSearch({
                index: name, path, queryVector, limit: 2, numCandidates: 10,
                filter: { status: 'published' },
            });
            if (!binaryHits.length || binaryHits.some(hit => !Number.isFinite(hit.score) || hit.document.status !== 'published')) {
                throw new Error(`Invalid BSON Vector Search results from ${name}`);
            }
            console.log(name, binaryHits.map(hit => ({ title: hit.document.title, score: hit.score })));
        }

        await articles.dropSearchIndex(INDEX_NAME);
        const dropped = await articles.waitForSearchIndex(INDEX_NAME, {
            until: 'dropped',
            timeoutMs: 120_000,
        });
        console.log('dropSearchIndex:', dropped.status);
        console.log('Vector search example complete');
    } finally {
        await articles.dropCollection().catch((error: unknown) => {
            console.error('Collection cleanup failed:', error);
        });
        await msq.close();
    }
}

main().catch((err: unknown) => {
    console.error('Example failed:', err);
    process.exit(1);
});
