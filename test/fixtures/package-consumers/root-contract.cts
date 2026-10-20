import MonSQLize, { ModelInstance, Logger, type ResultWithMeta } from 'monsqlize';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const runtime: MonSQLize;
declare const model: ModelInstance<{ name: string }>;
// @ts-expect-error The runtime constructor remains private to typed consumers.
new ModelInstance();
// @ts-expect-error A string is not a valid optimistic-concurrency version.
model.updateOne({}, {}, { expectedVersion: 'wrong' });
if (model instanceof ModelInstance) {
    // @ts-expect-error instanceof must preserve the existing write-option constraint.
    model.updateOne({}, {}, { expectedVersion: 'wrong' });
    const page = model.findPage({ totals: { mode: 'sync' } });
    type Total = Assert<Equal<Awaited<typeof page>['totals']['total'], number>>;
    type Pages = Assert<Equal<Awaited<typeof page>['totals']['totalPages'], number>>;
    void (null as Total | Pages | null);
}
const collection = runtime.collection<{ name: string }>('users');
const find = collection.find({}, { meta: true }).toArray();
const aggregate = collection.aggregate<{ name: string }>([], { meta: true }).toArray();
const findResult: Promise<ResultWithMeta<Array<{ name: string }>>> = find;
const aggregateResult: Promise<ResultWithMeta<Array<{ name: string }>>> = aggregate;
// @ts-expect-error Meta-enabled toArray returns a result envelope.
const plainFind: Promise<Array<{ name: string }>> = find;
// @ts-expect-error Meta-enabled toArray returns a result envelope.
const plainAggregate: Promise<Array<{ name: string }>> = aggregate;
const logger = new Logger({ debug() {}, info() {}, warn() {}, error() {} }, { structured: true, enableTraceId: false });
const traceId: string = Logger.generateTraceId();
void [findResult, aggregateResult, plainFind, plainAggregate, logger, traceId];
