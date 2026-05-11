/**
 * check_duplicates_recent.js
 * Checks for duplicate MCBIS sends in the last 4 hours.
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
  const hoursAgo = 4;
  const since = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  console.log(`\nChecking for duplicates since: ${since.toISOString()} (last ${hoursAgo} hours)`);

  const items = await prisma.orderItem.findMany({
    where: {
      createdAt: { gte: since },
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

  console.log(`Total MCBIS OrderItems in window: ${items.length}`);

  const groups = {};
  for (const item of items) {
    const key = `${item.recipientPhone}|${item.bundleId}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  const dupes = Object.values(groups).filter(g => g.length > 1);
  console.log(`Duplicate groups (same phone+bundle): ${dupes.length}`);

  if (dupes.length === 0) {
    console.log('No duplicates in this window.');
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
      const minutesAgo = Math.round((Date.now() - item.createdAt) / 60000);
      console.log(`  ${item.reference} | ${item.status} | MCBIS: ${mcbisStatus} | ${minutesAgo} min ago | ref: ${item.externalReference}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
