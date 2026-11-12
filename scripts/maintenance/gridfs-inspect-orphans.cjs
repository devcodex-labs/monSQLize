'use strict';

/**
 * Operator-only, inspect-only reporter for GridFS chunk files_id groups.
 * Walks <bucket>.chunks via the existing { files_id, n } index in range pages.
 * Each files_id is classified only after a unified re-check of files and uploads:
 *   - visible_file: a files document exists
 *   - owned: no files document, but an uploads owner/session exists
 *   - candidate_orphan: no files document and no uploads owner at re-check time
 *
 * Findings are streamed (onFinding / CLI NDJSON) and capped by maxFindings.
 * Use resumeAfter.filesId (exclusive) to continue a truncated scan. Counters
 * are accumulated incrementally for the current invocation only. This tool
 * never deletes, never applies, and never uses document age as a deletion
 * criterion. It is not part of the public GridFSBucket API.
 *
 * Usage:
 *   MONSQLIZE_RECOVERY_MONGODB_URI=... node scripts/maintenance/gridfs-inspect-orphans.cjs \
 *     --db=my_database --bucket=fs [--page-size=200] [--max-findings=1000] \
 *     [--after-files-id=0123456789abcdef01234567]
 */
const { MongoClient, ObjectId } = require('mongodb');

const DEFAULT_MAX_FINDINGS = 1000;
const MAX_FINDINGS_CAP = 100000;

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

function parseAfter(after) {
    if (after == null) return null;
    const raw = after.filesId ?? after.files_id;
    if (raw == null || raw === '') fail('after.filesId is required to resume');
    const filesId = raw instanceof ObjectId ? raw : new ObjectId(String(raw));
    return filesId;
}

async function inspectGridFSOrphans(input) {
    const { db, bucket, pageSize = 200, onFinding, collectFindings = true } = input;
    if (!db || !bucket || typeof bucket !== 'string') fail('Invalid database or bucket');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10000) {
        fail('pageSize must be an integer between 1 and 10000');
    }
    const maxFindings = input.maxFindings === undefined ? DEFAULT_MAX_FINDINGS : input.maxFindings;
    if (!Number.isInteger(maxFindings) || maxFindings < 1 || maxFindings > MAX_FINDINGS_CAP) {
        fail('maxFindings must be an integer between 1 and ' + MAX_FINDINGS_CAP);
    }
    if (input.apply === true) fail('This inspector has no apply mode and never deletes');

    const afterId = parseAfter(input.after || input.resumeAfter);
    const chunks = db.collection(bucket + '.chunks');
    const findings = collectFindings ? [] : undefined;
    let lastId = afterId;
    let lastN = -1;
    let current = null;
    let pages = 0;
    let filesIdsScanned = 0;
    let visibleFiles = 0;
    let owned = 0;
    let candidateOrphans = 0;
    let truncated = false;
    let resumeAfter = null;
    let lastClassifiedId = afterId;

    const flush = async (group) => {
        const finding = await classifyFilesId(db, bucket, group);
        filesIdsScanned += 1;
        if (finding.classification === 'visible_file') visibleFiles += 1;
        else if (finding.classification === 'owned') owned += 1;
        else candidateOrphans += 1;
        if (typeof onFinding === 'function') onFinding(finding);
        if (findings) findings.push(finding);
        lastClassifiedId = group.id;
        if (filesIdsScanned >= maxFindings) {
            const more = await chunks.find({ files_id: { $gt: group.id } }).project({ _id: 1 }).limit(1).next();
            if (more) {
                truncated = true;
                resumeAfter = {
                    filesId: group.id instanceof ObjectId ? group.id.toHexString() : String(group.id),
                };
            }
        }
    };

    for (;;) {
        const filter = lastId == null
            ? {}
            : lastN < 0
                ? { files_id: { $gt: lastId } }
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
                if (current) {
                    await flush(current);
                    if (truncated) {
                        current = null;
                        break;
                    }
                }
                current = { id: filesId, minN: doc.n, maxN: doc.n, count: 1 };
            } else {
                current.count += 1;
                if (doc.n < current.minN) current.minN = doc.n;
                if (doc.n > current.maxN) current.maxN = doc.n;
            }
            lastId = filesId;
            lastN = doc.n;
        }
        if (truncated) break;
        if (page.length < pageSize) break;
    }
    if (current && !truncated) await flush(current);

    return {
        bucket,
        pageSize,
        maxFindings,
        pages,
        filesIdsScanned,
        visibleFiles,
        owned,
        candidateOrphans,
        truncated,
        resumeAfter,
        ...(findings ? { findings } : {}),
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
    const maxArg = readArg(args, 'max-findings');
    const maxFindings = maxArg === undefined ? DEFAULT_MAX_FINDINGS : Number(maxArg);
    if (maxArg !== undefined && (!Number.isInteger(maxFindings) || maxFindings < 1)) {
        fail('--max-findings must be a positive integer');
    }
    const afterFilesId = readArg(args, 'after-files-id');
    const client = new MongoClient(uri);
    await client.connect();
    try {
        const report = await inspectGridFSOrphans({
            db: client.db(dbName),
            bucket,
            pageSize,
            maxFindings,
            after: afterFilesId ? { filesId: afterFilesId } : undefined,
            collectFindings: false,
            onFinding: (finding) => {
                process.stdout.write(JSON.stringify({ type: 'finding', ...finding }) + '\n');
            },
        });
        process.stdout.write(JSON.stringify({ type: 'summary', ...report }) + '\n');
    } finally {
        await client.close();
    }
}

module.exports = { inspectGridFSOrphans, DEFAULT_MAX_FINDINGS };
if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(String(error.code || 'INSPECT_ERROR') + ': ' + error.message + '\n');
        process.exitCode = 1;
    });
}
