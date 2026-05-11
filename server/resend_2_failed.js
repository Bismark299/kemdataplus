/**
 * Resend 2 specific failed OrderItems (May 7 2026 17:16 & 17:20)
 * - ORD-047450-01 | 0556632842 | ECONNABORTED
 * - ORD-047451-01 | 0547067925 | API Error 522
 * 
 * Steps:
 * 1. Check each on MCBIS — if already completed, mark completed (don't double-send)
 * 2. Otherwise reset to PENDING so live server retries
 */

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const DB_URL = 'process.env.DATABASE_URL';
const MCBIS_URL = 'https://datahub.mcbissolution.com/api/v1';
const MCBIS_TOKEN = '44|XWxomstKxT6Evxv2FUpvBq3uDs3yukPT4iFQSrsc894d387f';

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const TARGET_REFS = ['ORD-047450-01', 'ORD-047451-01'];

async function checkMcbisStatus(extRef) {
  try {
    const resp = await axios.get(`${MCBIS_URL}/checkOrderStatus/${extRef}`, {
      headers: { Authorization: `Bearer ${MCBIS_TOKEN}`, Accept: 'application/json' },
      timeout: 20000
    });
    return resp.data;
  } catch (err) {
    if (err.response) return { error: err.response.status, data: err.response.data };
    return { error: err.message };
  }
}

async function main() {
  const items = await prisma.orderItem.findMany({
    where: { reference: { in: TARGET_REFS } },
    select: { id: true, reference: true, recipientPhone: true, externalReference: true, failureReason: true, status: true }
  });

  console.log(`\nFound ${items.length} target OrderItems:\n`);
  items.forEach(i => console.log(`  ${i.reference} | ${i.recipientPhone} | status: ${i.status} | extRef: ${i.externalReference}`));
  console.log('');

  for (const item of items) {
    console.log(`--- Processing ${item.reference} (${item.recipientPhone}) ---`);

    // Check MCBIS if we have an extRef
    if (item.externalReference) {
      process.stdout.write(`  Checking MCBIS status for ${item.externalReference}... `);
      const result = await checkMcbisStatus(item.externalReference);
      const status = (result?.data?.status || result?.status || '').toLowerCase();
      console.log(`MCBIS responded: ${JSON.stringify(result).substring(0, 120)}`);

      if (status === 'completed' || status === 'success' || status === 'successful') {
        // Already went through — just mark completed, don't re-send
        await prisma.orderItem.update({
          where: { id: item.id },
          data: { status: 'COMPLETED', failureReason: null }
        });
        await prisma.order.updateMany({
          where: { reference: item.reference.replace(/-\d+$/, '') },
          data: { status: 'COMPLETED', failureReason: null }
        });
        console.log(`  ✅ Already completed on MCBIS — marked COMPLETED (no re-send needed)`);
        continue;
      }
    }

    // Reset to PENDING — live server will re-send
    await prisma.orderItem.update({
      where: { id: item.id },
      data: {
        status: 'PENDING',
        externalReference: null,
        apiSentAt: null,
        failureReason: null
      }
    });
    await prisma.order.updateMany({
      where: { reference: item.reference.replace(/-\d+$/, '') },
      data: {
        status: 'PENDING',
        externalReference: null,
        apiSentAt: null,
        failureReason: null
      }
    });
    console.log(`  🔄 Reset to PENDING — live server will retry within minutes`);
  }

  console.log('\n✅ Done.');
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
