/**
 * Check for duplicate MCBIS orders sent this morning
 * - Two OrderItems for same phone+bundle within 30 mins
 * - Both have KEM... externalReferences (meaning both were actually sent to MCBIS)
 */

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const DB_URL = 'process.env.DATABASE_URL';
const MCBIS_URL = 'https://datahub.mcbissolution.com/api/v1';
const MCBIS_TOKEN = '44|XWxomstKxT6Evxv2FUpvBq3uDs3yukPT4iFQSrsc894d387f';

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

async function checkMcbisStatus(reference) {
  try {
    const resp = await axios.get(`${MCBIS_URL}/checkOrderStatus/${reference}`, {
      headers: { Authorization: `Bearer ${MCBIS_TOKEN}`, Accept: 'application/json' },
      timeout: 15000
    });
    return resp.data;
  } catch (err) {
    if (err.response) return { _httpStatus: err.response.status, ...err.response.data };
    return { error: err.message };
  }
}

async function main() {
  const today = new Date('2026-05-07T00:00:00Z');

  // Get all OrderItems sent to MCBIS today (KEM prefix, not CK-)
  const mcbisItems = await prisma.orderItem.findMany({
    where: {
      createdAt: { gte: today },
      externalReference: { not: null },
      NOT: { externalReference: { startsWith: 'CK-' } }
    },
    select: {
      id: true,
      reference: true,
      recipientPhone: true,
      bundleId: true,
      status: true,
      externalReference: true,
      apiSentAt: true,
      createdAt: true,
      orderGroup: { select: { displayId: true } }
    },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`\nTotal MCBIS OrderItems today: ${mcbisItems.length}`);

  // Also check legacy Orders table
  const mcbisOrders = await prisma.order.findMany({
    where: {
      createdAt: { gte: today },
      externalReference: { not: null },
      NOT: { externalReference: { startsWith: 'CK-' } }
    },
    select: {
      id: true,
      reference: true,
      recipientPhone: true,
      bundleId: true,
      status: true,
      externalReference: true,
      apiSentAt: true,
      createdAt: true
    },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`Total MCBIS legacy Orders today: ${mcbisOrders.length}`);

  // Find duplicates: same phone+bundleId within 30 min window
  const WINDOW_MS = 30 * 60 * 1000;
  const duplicatePairs = [];

  const allItems = [
    ...mcbisItems.map(i => ({ ...i, _table: 'OrderItem' })),
    ...mcbisOrders.map(o => ({ ...o, _table: 'Order' }))
  ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  for (let i = 0; i < allItems.length; i++) {
    for (let j = i + 1; j < allItems.length; j++) {
      const a = allItems[i], b = allItems[j];
      const timeDiff = Math.abs(new Date(b.createdAt) - new Date(a.createdAt));
      if (timeDiff > WINDOW_MS) break;

      if (a.recipientPhone === b.recipientPhone &&
          a.bundleId === b.bundleId &&
          a.externalReference !== b.externalReference) {
        // Both were sent to MCBIS with different refs
        duplicatePairs.push({ a, b, timeDiffMin: Math.round(timeDiff / 60000) });
      }
    }
  }

  if (duplicatePairs.length === 0) {
    console.log('\n✅ No duplicate MCBIS orders found this morning.');
    await prisma.$disconnect();
    return;
  }

  console.log(`\n⚠️  Found ${duplicatePairs.length} potential duplicate pairs:\n`);

  for (const { a, b, timeDiffMin } of duplicatePairs) {
    console.log(`--- DUPLICATE PAIR (${timeDiffMin} min apart) ---`);
    console.log(`  A: [${a._table}] ${a.reference} | ${a.recipientPhone} | ref: ${a.externalReference} | status: ${a.status}`);
    console.log(`  B: [${b._table}] ${b.reference} | ${b.recipientPhone} | ref: ${b.externalReference} | status: ${b.status}`);
  }

  // Check MCBIS status for each unique externalReference involved
  console.log('\n--- Checking MCBIS status for each ref ---');
  const allRefs = new Set();
  duplicatePairs.forEach(({ a, b }) => {
    allRefs.add(a.externalReference);
    allRefs.add(b.externalReference);
  });

  const refStatuses = {};
  for (const ref of allRefs) {
    process.stdout.write(`  ${ref}: `);
    const result = await checkMcbisStatus(ref);
    const status = result?.data?.status || result?.status || result?.error || 'unknown';
    refStatuses[ref] = status;
    console.log(status);
    await new Promise(r => setTimeout(r, 300));
  }

  // Recommend action for each pair
  console.log('\n--- Recommended Actions ---');
  for (const { a, b } of duplicatePairs) {
    const statusA = refStatuses[a.externalReference];
    const statusB = refStatuses[b.externalReference];
    const aCompleted = /success|complet/i.test(statusA);
    const bCompleted = /success|complet/i.test(statusB);

    console.log(`\n  Phone: ${a.recipientPhone}`);
    console.log(`  A (${a.reference}): MCBIS=${statusA}, DB=${a.status}`);
    console.log(`  B (${b.reference}): MCBIS=${statusB}, DB=${b.status}`);

    if (aCompleted && bCompleted) {
      console.log(`  ⚠️  BOTH completed on MCBIS — customer received DATA TWICE. Mark B as FAILED in DB and flag for refund.`);
    } else if (aCompleted && !bCompleted) {
      console.log(`  ✅ A completed, B not. B should be FAILED/cancelled on MCBIS. Safe.`);
    } else if (!aCompleted && bCompleted) {
      console.log(`  ✅ B completed, A not. A should be FAILED/cancelled on MCBIS. Safe.`);
    } else {
      console.log(`  ℹ️  Neither completed — one may still be processing.`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
