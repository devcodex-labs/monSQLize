/**
 * Expression functions example — expr() and compilePipelineExpressions.
 * See: docs/expression-functions.md
 *
 * Run:
 *   npm run build && tsc -p tsconfig.examples.json
 *   node .generated/examples-dist/examples/docs/expression-functions.js
 */
import MonSQLize from 'monsqlize';
import assert from 'node:assert/strict';
import { setupExample, teardownExample } from '../helpers/bootstrap.js';

async function main() {
    const { msq, server } = await setupExample('example-expressions');
    const orders = msq.collection('orders');

    await orders.insertMany([
        { product: 'Widget', unitPrice: 9.99, qty: 3, discount: 0.1 },
        { product: 'Gadget', unitPrice: 49.99, qty: 2, discount: 0.0 },
        { product: 'Part', unitPrice: 2.99, qty: 10, discount: 0.2 },
    ]);

    // ── expr() — wrap a DSL/raw expression string ─────────────────────────
    // expr() takes a single string in MongoDB expression syntax or a DSL
    // string. The returned object is compiled into a real MongoDB pipeline
    // operator when passed to aggregate().
    const { expr, compilePipelineExpressions } = MonSQLize;

    // Stage-root predicates and quoted field-like text have distinct roles.
    const literalLabels = await orders.aggregate([
        { $match: expr('qty > 2') },
        { $project: { _id: 0, product: 1, label: expr('"$unitPrice"') } },
    ]);
    assert.equal(literalLabels.length, 2);
    assert.ok(literalLabels.every((row) => (row as { label: string }).label === '$unitPrice'));

    // Each expr wraps a self-contained expression string.
    // For arithmetic involving multiple fields, write the full expression:
    const subtotalExpr = expr('$multiply: [$unitPrice, $qty]');
    const discountExpr = expr('$multiply: [$unitPrice, $qty, $discount]');
    const finalExpr    = expr('$multiply: [$unitPrice, $qty]'); // simplified — subtotal

    // Use compilePipelineExpressions to resolve expr objects before sending
    // to MongoDB (the collection.aggregate() method does this automatically).
    const rawPipeline = [
        {
            $addFields: {
                subtotal:       subtotalExpr,
                discountAmount: discountExpr,
                finalPrice:     finalExpr,
            },
        },
        { $project: { product: 1, subtotal: 1, discountAmount: 1, finalPrice: 1, _id: 0 } },
        { $sort: { finalPrice: -1 } },
    ];

    // compilePipelineExpressions converts expr objects → real MongoDB operators
    const compiled = compilePipelineExpressions(rawPipeline);
    console.log('Compiled pipeline stage 0 keys:', Object.keys(compiled[0]));

    // Use expr inline in aggregate (auto-compiled by the collection layer)
    const priced = await orders.aggregate([
        {
            $project: {
                product: 1,
                subtotal: { $multiply: ['$unitPrice', '$qty'] },
                _id: 0,
            },
        },
        { $sort: { subtotal: -1 } },
    ]);

    console.log('Pricing breakdown:');
    for (const o of priced as Record<string, unknown>[]) {
        console.log(`  ${o.product}: subtotal=$${(o.subtotal as number).toFixed(2)}`);
    }

    // ── expr for field annotations ────────────────────────────────────────
    // A common use is to annotate a query field with a DSL expression so
    // that the ORM can translate it (e.g. virtual sort keys, computed fields).
    const computed = {
        orderYear: expr('YEAR(createdAt)'),
        fullProduct: expr("CONCAT(product, ' (batch)')"),
    };
    console.log('\nexpr objects:', JSON.stringify(computed, null, 2));

    // ── Conditional tier via raw MongoDB cond ────────────────────────────
    const tiered = await orders.aggregate([
        {
            $addFields: {
                finalPrice: { $multiply: ['$unitPrice', '$qty'] },
                tier: {
                    $cond: {
                        if:   { $gte: [{ $multiply: ['$unitPrice', '$qty'] }, 50] },
                        then: 'premium',
                        else: 'standard',
                    },
                },
            },
        },
        { $project: { product: 1, tier: 1, _id: 0 } },
    ]);

    console.log('\nOrder tiers:');
    for (const o of tiered as Record<string, unknown>[]) {
        console.log(`  ${o.product}: ${o.tier}`);
    }

    await teardownExample(msq, server);
    console.log('✅ Expression functions example complete');
}

main().catch((err) => {
    console.error('❌ Example failed:', err);
    process.exit(1);
});
