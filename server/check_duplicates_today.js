/**
 * check_duplicates_today.js
 * Finds duplicate sends for May 8, 2026 only.
 * Looks for same phone+bundle sent more than once today (both OrderItem and legacy Order tables).
 */

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient({
  datasources: { db: { url: 'process.env.DATABASE_URL' } }
});

const MCBIS_URL = 'https://datahub.mcbissolution.com/api/v1';
const MCBIS_TOKEN = '44|XWxomstKxT6Evxv2FUpvBq3uDs3yukPT4iFQSrsc894d387f';

async function checkMcbisStatus(reference) {
  try {
    const resp = await axios.get(`${MCBIS_URL}/checkOrderStatus/${reference}`, {
      headers: { Authorization: `Bearer ${MCBIS_TOKEN}`, Accept: 'application/json' },
      timeout: 15000
    });
    return (resp.data?.data?.order?.status || resp.data?.data?.status || 'unknown').toLowerCase();
  } catch (err) {
    if (err.response?.status === 404) return 'unknown';
    return `error:${err.message}`;
  }
}

async function main() {
  const today = new Date('2026-05-08T00:00:00Z');

  // Get all OrderItems sent to MCBIS today
  const items = await prisma.orderItem.findMany({
    where: {
      createdAt: { gte: today },
      externalReference: { not: null },
      NOT: { externalReference: { startsWith: 'CK-' } }
    },
    select: {
      id: true, reference: true, recipientPhone: true, bundleId: true,
      status: true, externalReference: true, createdAt: true,
      bundle: { select: { name: true, dataAmount: true } }
    },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`\nTotal MCBIS OrderItems today (May 8): ${items.length}`);

  // Find duplicates: same phone+bundleId
  const groups = {};
  for (const item of items) {
    const key = `${item.recipientPhone}|${item.bundleId}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  const dupes = Object.values(groups).filter(g => g.length > 1);
  console.log(`\nDuplicate groups (same phone+bundle sent >1 time): ${dupes.length}`);

  if (dupes.length === 0) {
    console.log('No duplicates found today.');
    await prisma.$disconnect();
    return;
  }

  console.log('\n--- DUPLICATE GROUPS ---');
  for (const group of dupes) {
    const first = group[0];
    console.log(`\nPhone: ${first.recipientPhone} | Bundle: ${first.bundle?.name} (${first.bundle?.dataAmount})`);

    for (const item of group) {
      await new Promise(r => setTimeout(r, 1000));
      const mcbisStatus = await checkMcbisStatus(item.externalReference);
      console.log(`  ${item.reference} | ${item.status} | ref: ${item.externalReference} | MCBIS: ${mcbisStatus} | at: ${item.createdAt.toISOString()}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
