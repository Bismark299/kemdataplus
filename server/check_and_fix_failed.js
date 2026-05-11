/**
 * check_and_fix_failed.js
 * 
 * For today's FAILED OrderItems that have a KEM... externalReference:
 * - Checks actual status on MCBIS
 * - If MCBIS says success/processing → marks PROCESSING (auto-sync will complete)
 * - If MCBIS says unknown/failed → leaves as FAILED (safe)
 * 
 * Run: node check_and_fix_failed.js
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
      timeout: 20000
    });
    const orderStatus = resp.data?.data?.order?.status || resp.data?.data?.status || 'unknown';
    return { success: true, status: orderStatus.toLowerCase(), raw: resp.data };
  } catch (err) {
    if (err.response) return { success: false, status: 'unknown', error: `HTTP ${err.response.status}` };
    return { success: false, status: 'unknown', error: err.message };
  }
}

async function main() {
  const today = new Date('2026-05-08T00:00:00Z');

  // Get FAILED OrderItems today that have a KEM reference (were sent to MCBIS)
  const failedItems = await prisma.orderItem.findMany({
    where: {
      status: 'FAILED',
      createdAt: { gte: today },
      externalReference: { not: null },
      NOT: { externalReference: { startsWith: 'CK-' } }
    },
    select: { id: true, reference: true, recipientPhone: true, externalReference: true, failureReason: true }
  });

  console.log(`\nFailed OrderItems with MCBIS refs today: ${failedItems.length}`);

  if (failedItems.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  let movedToProcessing = 0;
  let leftAsFailed = 0;
  let checkFailed = 0;

  for (const item of failedItems) {
    console.log(`\nChecking ${item.reference} | ${item.recipientPhone} | ref: ${item.externalReference}`);

    // Delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 1500));

    const result = await checkMcbisStatus(item.externalReference);
    console.log(`  MCBIS status: ${result.status} ${result.error ? `(${result.error})` : ''}`);

    if (!result.success) {
      console.log(`  ⚠️  Could not reach MCBIS — leaving as FAILED`);
      checkFailed++;
      continue;
    }

    const s = result.status;
    if (s === 'success' || s === 'completed' || s === 'delivered' || s === 'successful' ||
        s === 'pending' || s === 'processing' || s === 'initiated') {
      // MCBIS has this order — mark PROCESSING so auto-sync can confirm
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { status: 'PROCESSING', failureReason: null }
      });
      console.log(`  ✅ Moved to PROCESSING`);
      movedToProcessing++;
    } else {
      // unknown / failed on MCBIS side — safe to leave as FAILED
      console.log(`  ❌ MCBIS unknown/failed — left as FAILED`);
      leftAsFailed++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  Moved to PROCESSING: ${movedToProcessing}`);
  console.log(`  Left as FAILED:      ${leftAsFailed}`);
  console.log(`  Could not check:     ${checkFailed}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
