/**
 * REPAIR FAILED ORDERS - May 7 2026
 * 
 * 1. For each FAILED OrderItem (KEM refs): check actual status on MCBIS
 * 2. If MCBIS says completed → mark our record COMPLETED
 * 3. If MCBIS says not found / failed → reset to PENDING so live server retries
 * 4. Reset stuck PENDING Orders (apiSentAt=null) — live server auto-retry handles them
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
      timeout: 20000
    });
    return resp.data;
  } catch (err) {
    if (err.response) return { error: err.response.status, data: err.response.data };
    return { error: err.message };
  }
}

async function main() {
  const today = new Date('2026-05-07T00:00:00Z');

  const failedItems = await prisma.orderItem.findMany({
    where: { status: 'FAILED', createdAt: { gte: today } },
    select: { id: true, reference: true, recipientPhone: true, externalReference: true, failureReason: true, orderGroupId: true },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`\nChecking ${failedItems.length} failed OrderItems against MCBIS...\n`);

  const toMarkCompleted = [];
  const toResetPending = [];

  for (const item of failedItems) {
    const extRef = item.externalReference;
    if (!extRef) {
      console.log(`[${item.reference}] No externalReference — will reset to PENDING`);
      toResetPending.push(item);
      continue;
    }

    process.stdout.write(`[${item.reference}] Checking ${extRef}... `);
    const result = await checkMcbisStatus(extRef);
    
    // MCBIS status response: result.data.status or result.status
    const status = result?.data?.status || result?.status || '';
    const statusLower = (status || '').toLowerCase();
    
    if (statusLower === 'completed' || statusLower === 'success' || statusLower === 'successful') {
      console.log(`COMPLETED ✅ (MCBIS says: ${status})`);
      toMarkCompleted.push({ item, mcbisData: result.data });
    } else if (statusLower === 'failed' || statusLower === 'cancelled') {
      console.log(`FAILED on MCBIS ❌ (${status}) — resetting to PENDING`);
      toResetPending.push(item);
    } else if (result.error === 404 || (result.data && JSON.stringify(result.data).includes('not found'))) {
      console.log(`NOT FOUND on MCBIS — resetting to PENDING`);
      toResetPending.push(item);
    } else if (statusLower === 'pending' || statusLower === 'processing' || statusLower === 'initiated') {
      console.log(`IN PROGRESS on MCBIS (${status}) — marking PROCESSING`);
      toMarkCompleted.push({ item, status: 'PROCESSING', mcbisData: result.data });
    } else {
      // Unknown / error — if it was a Cloudflare error (520/521/522), safe to reset
      const isCfError = item.failureReason && /52[012]|Server Error/.test(item.failureReason);
      const isConnAborted = item.failureReason && item.failureReason.includes('ECONNABORTED');
      console.log(`UNKNOWN (MCBIS resp: ${JSON.stringify(result).substring(0, 80)}) | failReason: ${item.failureReason?.substring(0, 40)}`);
      if (isCfError) {
        console.log(`  → Cloudflare error on original call → resetting to PENDING`);
        toResetPending.push(item);
      } else if (isConnAborted) {
        console.log(`  → ECONNABORTED + unknown MCBIS status → resetting to PENDING (will be re-sent)`);
        toResetPending.push(item);
      } else {
        console.log(`  → Skipping (manual review needed)`);
      }
    }

    // Small delay to avoid hammering MCBIS
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`  To mark COMPLETED: ${toMarkCompleted.filter(x => !x.status || x.status === 'PROCESSING' ? false : true).length}`);
  console.log(`  To mark PROCESSING: ${toMarkCompleted.filter(x => x.status === 'PROCESSING').length}`);
  console.log(`  To reset PENDING: ${toResetPending.length}`);

  // --- Apply changes ---

  // Mark completed items
  for (const { item, status: overrideStatus, mcbisData } of toMarkCompleted) {
    const finalStatus = overrideStatus || 'COMPLETED';
    await prisma.orderItem.update({
      where: { id: item.id },
      data: {
        status: finalStatus,
        failureReason: null
      }
    });
    // Also update the parent Order
    await prisma.order.updateMany({
      where: { reference: item.reference.replace(/-\d+$/, '') },
      data: { status: finalStatus }
    });
    console.log(`  ✅ Marked ${item.reference} as ${finalStatus}`);
  }

  // Reset failed items to PENDING so live server retries
  for (const item of toResetPending) {
    await prisma.orderItem.update({
      where: { id: item.id },
      data: {
        status: 'PENDING',
        externalReference: null,
        apiSentAt: null,
        failureReason: null
      }
    });
    // Also reset parent Order
    await prisma.order.updateMany({
      where: { reference: item.reference.replace(/-\d+$/, '') },
      data: {
        status: 'PENDING',
        externalReference: null,
        apiSentAt: null,
        failureReason: null
      }
    });
    console.log(`  🔄 Reset ${item.reference} (${item.recipientPhone}) to PENDING`);
  }

  console.log(`\n✅ Done. The live server auto-retry will pick up all PENDING items within minutes.`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
