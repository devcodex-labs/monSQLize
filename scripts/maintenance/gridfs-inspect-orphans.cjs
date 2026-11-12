'use strict';

/**
 * Operator-only, inspect-only reporter for GridFS chunk files_id groups.
 * Walks <bucket>.chunks via the existing { files_id, n } index in range pages.
 * Each files_id is classified only after a unified re-check of files and uploads:
 *   - visible_file: a files document exists
 *   - owned: no files document, but an uploads owner/session exists
 *   - candidate_orphan: no files document and no uploads owner at re-check time
 *
 * This tool never deletes, never applies, and never uses document age as a
 * deletion criterion. It is not part of the public GridFSBucket API.
 *
 * Usage:
 *   MONSQLIZE_RECOVERY_MONGODB_URI=... node scripts/maintenance/gridfs-inspect-orphans.cjs \
 *     --db=my_database --bucket=fs [--page-size=200]
 */
const { MongoClient, ObjectId } = require('mongodb');

function fail(message) {
    const error = new Error(message);
    error.code = 'GRIDFS_INSPECT_PRECONDITION_FAILED';
    throw error;
}

async function classifyFilesId(db, bucket, group) {
    const files = db.collection(bucket + '.files');
    const uploads = db.collection(bucket + '.uploads');
    const file = await files.findOne({ _id: group.id }, { projection: { _id: 1 } });
    const owner = await uploads.findOne(
        { _id: group.id },
        { projection: { _id: 1, kind: 1, status: 1 } },
    );
    let classification;
    if (file) classification = 'visible_file';
    else if (owner) classification = 'owned';
    else classification = 'candidate_orphan';
    const finding = {
        filesId: group.id instanceof ObjectId ? group.id.toHexString() : String(group.id),
        chunkCount: group.count,
        minN: group.minN,
        maxN: group.maxN,
        classification,
    };
    if (owner && !file) {
        finding.ownerKind = owner.kind ?? null;
        finding.ownerStatus = owner.status ?? null;
    }
    return finding;
}

async function inspectGridFSOrphans(input) {
    const { db, bucket, pageSize = 200 } = input;
    if (!db || !bucket || typeof bucket !== 'string') fail('Invalid database or bucket');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10000) {
        fail('pageSize must be an integer between 1 and 10000');
    }
    if (input.apply === true) fail('This inspector has no apply mode and never deletes');

    const chunks = db.collection(bucket + '.chunks');
    const findings = [];
    let lastId = null;
    let lastN = -1;
    let current = null;
    let pages = 0;

    const flush = async (group) => {
        findings.push(await classifyFilesId(db, bucket, group));
    };

    for (;;) {
        const filter = lastId == null
            ? {}
            : {
                $or: [
                    { files_id: { $gt: lastId } },
                    { files_id: lastId, n: { $gt: lastN } },
                ],
            };
        const page = await chunks.find(filter)
            .sort({ files_id: 1, n: 1 })
            .project({ files_id: 1, n: 1 })
            .limit(pageSize)
            .toArray();
        pages += 1;
        if (page.length === 0) break;
        for (const doc of page) {
            const filesId = doc.files_id;
            if (!current || !sameId(current.id, filesId)) {
                if (current) await flush(current);
                current = { id: filesId, minN: doc.n, maxN: doc.n, count: 1 };
            } else {
                current.count += 1;
                if (doc.n < current.minN) current.minN = doc.n;
                if (doc.n > current.maxN) current.maxN = doc.n;
            }
            lastId = filesId;
            lastN = doc.n;
        }
        if (page.length < pageSize) break;
    }
    if (current) await flush(current);

    const countOf = (name) => findings.filter((row) => row.classification === name).length;
    return {
        bucket,
        pageSize,
        pages,
        filesIdsScanned: findings.length,
        visibleFiles: countOf('visible_file'),
        owned: countOf('owned'),
        candidateOrphans: countOf('candidate_orphan'),
        findings,
    };
}

function sameId(left, right) {
    if (left === right) return true;
    if (left && right && typeof left.equals === 'function') return left.equals(right);
    return String(left) === String(right);
}

function readArg(args, name) {
    const prefix = '--' + name + '=';
    const found = args.find((a) => a.startsWith(prefix));
    return found && found.slice(prefix.length);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--apply')) fail('This inspector has no apply mode and never deletes');
    const uri = process.env.MONSQLIZE_RECOVERY_MONGODB_URI || process.env.MONSQLIZE_MAINTENANCE_MONGODB_URI;
    if (!uri) fail('MONSQLIZE_RECOVERY_MONGODB_URI is required (do not put credentials in argv)');
    const dbName = readArg(args, 'db');
    const bucket = readArg(args, 'bucket');
    if (!dbName || !bucket) fail('--db and --bucket are required');
    const pageSizeArg = readArg(args, 'page-size');
    const pageSize = pageSizeArg === undefined ? 200 : Number(pageSizeArg);
    if (pageSizeArg !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) {
        fail('--page-size must be a positive integer');
    }
    const client = new MongoClient(uri);
    await client.connect();
    try {
        const report = await inspectGridFSOrphans({ db: client.db(dbName), bucket, pageSize });
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } finally {
        await client.close();
    }
}

module.exports = { inspectGridFSOrphans };
if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(String(error.code || 'INSPECT_ERROR') + ': ' + error.message + '\n');
        process.exitCode = 1;
    });
}
