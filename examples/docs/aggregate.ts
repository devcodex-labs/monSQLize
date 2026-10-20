/**
 * Aggregation pipeline example.
 * See: docs/aggregate.md
 *
 * Run:
 *   npm run build && tsc -p tsconfig.examples.json
 *   node .generated/examples-dist/examples/docs/aggregate.js
 */
import { setupExample, teardownExample } from '../helpers/bootstrap.js';

async function main() {
    const { msq, server } = await setupExample('example-aggregate');
    const orders = msq.collection('orders');

    await orders.insertMany([
        { product: 'Widget', category: 'tools', amount: 29.99, qty: 3, status: 'completed' },
        { product: 'Gadget', category: 'tools', amount: 59.99, qty: 1, status: 'completed' },
        { product: 'Widget', category: 'tools', amount: 29.99, qty: 2, status: 'pending' },
        { product: 'Doohickey', category: 'parts', amount: 9.99, qty: 5, status: 'completed' },
        { product: 'Gadget', category: 'tools', amount: 59.99, qty: 2, status: 'completed' },
    ]);

    // ── Basic aggregate pipeline ───────────────────────────────────────────
    const revenueByCategory = await orders.aggregate([
        { $match: { status: 'completed' } },
        {
            $group: {
                _id: '$category',
                totalRevenue: { $sum: { $multiply: ['$amount', '$qty'] } },
                orderCount: { $sum: 1 },
            },
        },
        { $sort: { totalRevenue: -1 } },
    ]);
    console.log('Revenue by category:');
    for (const cat of revenueByCategory as Record<string, unknown>[]) {
        console.log(`  ${cat._id}: $${(cat.totalRevenue as number).toFixed(2)} (${cat.orderCount} orders)`);
    }

    // ── Aggregate with project + addFields ────────────────────────────────
    const detailed = await orders.aggregate([
        { $match: { status: 'completed' } },
        {
            $addFields: {
                lineTotal: { $multiply: ['$amount', '$qty'] },
            },
        },
        {
            $project: {
                product: 1,
                qty: 1,
                amount: 1,
                lineTotal: 1,
                _id: 0,
            },
        },
        { $sort: { lineTotal: -1 } },
        { $limit: 3 },
    ]);
    console.log('\nTop 3 line items:');
    for (const item of detailed as Record<string, unknown>[]) {
        console.log(`  ${item.product} × ${item.qty} = $${(item.lineTotal as number).toFixed(2)}`);
    }

    // ── Aggregate with $count ──────────────────────────────────────────────
    const total = await orders.aggregate([
        { $match: { status: 'completed' } },
        { $count: 'completedOrders' },
    ]);
    console.log('\nCompleted orders:', (total[0] as Record<string, unknown>)?.completedOrders);

    const withMeta = await orders.aggregate([{ $match: { status: 'completed' } }], { meta: true }).toArray();
    console.log('Metadata result rows:', withMeta.data.length);

    await teardownExample(msq, server);
    console.log('✅ Aggregate example complete');
}

main().catch((err) => {
    console.error('❌ Example failed:', err);
    process.exit(1);
});
