/**
 * Advanced aggregation pipeline examples: $lookup, $group, $facet, $bucket.
 * See: docs/aggregate.md
 *
 * Run:
 *   npm run build && tsc -p tsconfig.examples.json
 *   node .generated/examples-dist/examples/docs/aggregate-advanced.js
 */
import { setupExample, teardownExample } from '../helpers/bootstrap.js';

async function main() {
    const { msq, server } = await setupExample('example-aggregate-advanced');
    const orders = msq.collection('orders');
    const customers = msq.collection('customers');

    // ── Seed data ──────────────────────────────────────────────────────────
    await customers.insertMany([
        { _id: 'c1' as unknown, name: 'Alice', tier: 'gold' },
        { _id: 'c2' as unknown, name: 'Bob', tier: 'silver' },
        { _id: 'c3' as unknown, name: 'Carol', tier: 'gold' },
    ]);

    await orders.insertMany([
        { customerId: 'c1', product: 'Widget', amount: 120, category: 'tools', month: 1 },
        { customerId: 'c1', product: 'Gadget', amount: 250, category: 'electronics', month: 1 },
        { customerId: 'c2', product: 'Widget', amount: 60, category: 'tools', month: 2 },
        { customerId: 'c2', product: 'Part', amount: 30, category: 'parts', month: 2 },
        { customerId: 'c3', product: 'Gadget', amount: 400, category: 'electronics', month: 1 },
        { customerId: 'c3', product: 'Widget', amount: 90, category: 'tools', month: 3 },
    ]);

    // ── $lookup — join orders with customer data ───────────────────────────
    console.log('=== $lookup: orders with customer info ===');
    const ordersWithCustomers = await orders.aggregate([
        {
            $lookup: {
                from: 'customers',
                localField: 'customerId',
                foreignField: '_id',
                as: 'customer',
            },
        },
        { $unwind: '$customer' },
        {
            $project: {
                product: 1,
                amount: 1,
                'customer.name': 1,
                'customer.tier': 1,
                _id: 0,
            },
        },
        { $sort: { amount: -1 } },
        { $limit: 3 },
    ]) as Array<{ product: string; amount: number; customer: { name: string; tier: string } }>;
    for (const o of ordersWithCustomers) {
        const cust = o.customer as unknown as { name: string; tier: string };
        console.log(`  ${o.product} ($${o.amount}) — ${cust.name} [${cust.tier}]`);
    }

    // ── $lookup with let + pipeline — filter related rows before returning ─
    type GoldCustomerOrder = {
        product: string;
        amount: number;
        customer: { name: string; tier: string };
    };
    const goldCustomerOrders = await orders.aggregate<GoldCustomerOrder>([
        {
            $lookup: {
                from: 'customers',
                let: { customerId: '$customerId' },
                pipeline: [
                    { $match: { $expr: { $eq: ['$_id', '$$customerId'] }, tier: 'gold' } },
                    { $project: { _id: 0, name: 1, tier: 1 } },
                ],
                as: 'customer',
            },
        },
        { $unwind: '$customer' },
        { $project: { _id: 0, product: 1, amount: 1, customer: 1 } },
        { $sort: { amount: -1 } },
    ]);
    console.log('\n=== $lookup pipeline: gold customer orders ===');
    for (const order of goldCustomerOrders) {
        console.log(`  ${order.product} ($${order.amount}) — ${order.customer.name}`);
    }

    // ── $group — revenue per category per month ────────────────────────────
    console.log('\n=== $group: monthly category revenue ===');
    const monthly = await orders.aggregate([
        {
            $group: {
                _id: { category: '$category', month: '$month' },
                total: { $sum: '$amount' },
                count: { $sum: 1 },
            },
        },
        { $sort: { '_id.month': 1, total: -1 } },
    ]) as Array<{ _id: { category: string; month: number }; total: number; count: number }>;
    for (const row of monthly) {
        console.log(`  M${row._id.month} ${row._id.category}: $${row.total} (${row.count} orders)`);
    }

    // ── $facet — parallel aggregations in one pass ─────────────────────────
    console.log('\n=== $facet: category summary + top spenders in one pass ===');
    const [facetResult] = await orders.aggregate([
        {
            $facet: {
                byCategory: [
                    { $group: { _id: '$category', revenue: { $sum: '$amount' } } },
                    { $sort: { revenue: -1 } },
                ],
                topSpenders: [
                    { $group: { _id: '$customerId', total: { $sum: '$amount' } } },
                    { $sort: { total: -1 } },
                    { $limit: 2 },
                ],
                totalOrders: [{ $count: 'count' }],
            },
        },
    ]) as Array<{
        byCategory: Array<{ _id: string; revenue: number }>;
        topSpenders: Array<{ _id: string; total: number }>;
        totalOrders: Array<{ count: number }>;
    }>;
    console.log('  Category revenues:');
    for (const c of facetResult.byCategory) {
        console.log(`    ${c._id}: $${c.revenue}`);
    }
    console.log('  Top spenders:');
    for (const s of facetResult.topSpenders) {
        console.log(`    ${s._id}: $${s.total}`);
    }
    console.log(`  Total orders: ${facetResult.totalOrders[0]?.count}`);

    // ── $bucket — segment orders by amount ────────────────────────────────
    console.log('\n=== $bucket: order amount tiers ===');
    const buckets = await orders.aggregate([
        {
            $bucket: {
                groupBy: '$amount',
                boundaries: [0, 50, 100, 200, 500],
                default: '500+',
                output: {
                    count: { $sum: 1 },
                    products: { $push: '$product' },
                },
            },
        },
    ]) as Array<{ _id: number; count: number; products: string[] }>;
    for (const b of buckets) {
        console.log(`  $${b._id}: ${b.count} orders (${b.products.join(', ')})`);
    }

    await teardownExample(msq, server);
    console.log('\n✅ Advanced aggregate example complete');
}

main().catch((err) => {
    console.error('❌ Example failed:', err);
    process.exit(1);
});
