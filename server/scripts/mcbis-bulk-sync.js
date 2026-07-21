/**
 * mcbis-bulk-sync.js
 * ------------------
 * Checks all PROCESSING/PENDING McBIS order items against the live McBIS API
 * and fixes their status (CANCELLED / COMPLETED / FAILED) + refunds wallets.
 *
 * Usage (run from /server directory):
 *   MCBIS_API_KEY="your_key" node scripts/mcbis-bulk-sync.js            (dry run)
 *   MCBIS_API_KEY="your_key" node scripts/mcbis-bulk-sync.js --apply    (live fix)
 *   MCBIS_API_KEY="your_key" node scripts/mcbis-bulk-sync.js --apply --limit=50
 *
 * Rate limit: McBIS allows 60 req/min → we wait 1100ms between calls (~54/min).
 */

const axios  = require('axios');
const prisma = require('../src/lib/prisma');

const APPLY  = process.argv.includes('--apply');
const TODAY  = process.argv.includes('--today');
const LIMIT  = (() => {
  const a = process.argv.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1]) : null;
})();
const API_KEY = process.env.MCBIS_API_KEY;
const DELAY   = 1100;

if (!API_KEY) { console.error('ERROR: Set MCBIS_API_KEY env var'); process.exit(1); }

async function checkMcbis(reference) {
  const resp = await axios.get(
    `https://datahub.mcbissolution.com/api/v1/checkOrderStatus/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' }, timeout: 15000 }
  );
  return resp.data;
}

function mapStatus(mcbisStatus) {
  const s = (mcbisStatus || '').trim().toLowerCase();
  if (['success', 'completed', 'delivered'].includes(s))              return 'COMPLETED';
  if (['failed', 'fail', 'error', 'rejected'].includes(s))            return 'FAILED';
  if (['cancelled', 'canceled', 'cancel'].includes(s))                return 'CANCELLED';
  if (['pending', 'processing', 'queued', 'initiated'].includes(s))   return null;
  return 'UNKNOWN';
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  console.log('\n=== McBIS Bulk Sync ===');
  console.log(`Mode  : ${APPLY ? 'LIVE (--apply)' : 'DRY RUN'}`);
  console.log(`Filter: ${TODAY ? `today (>= ${todayStart.toISOString()})` : 'all dates'}`);
  console.log(`Limit : ${LIMIT || 'none'}\n`);

  const items = await prisma.orderItem.findMany({
    where: {
      status: { in: ['PROCESSING', 'PENDING'] },
      externalReference: { not: null },
      NOT: [
        { externalReference: { startsWith: 'CK-' } },
        { externalReference: { startsWith: 'DGK-' } }
      ],
      ...(TODAY ? { createdAt: { gte: todayStart } } : {})
    },
    include: { orderGroup: true },
    orderBy: { createdAt: 'asc' },
    ...(LIMIT ? { take: LIMIT } : {})
  });

  // Fetch wallets by userId in one batch
  const userIds    = [...new Set(items.map(i => i.orderGroup?.userId).filter(Boolean))];
  const wallets    = await prisma.wallet.findMany({ where: { userId: { in: userIds } } });
  const walletMap  = Object.fromEntries(wallets.map(w => [w.userId, w]));

  console.log(`Found ${items.length} PROCESSING/PENDING McBIS items.\n`);

  const counts = { completed: 0, cancelled: 0, failed: 0, inFlight: 0, unknown: 0, error: 0 };
  const issues = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const og   = item.orderGroup;
    const wallet = og ? walletMap[og.userId] : null;

    process.stdout.write(`[${i + 1}/${items.length}] ${item.reference} → `);

    let mcbisStatus = '', newStatus;
    try {
      const raw = await checkMcbis(item.externalReference);
      mcbisStatus = raw?.data?.order?.status || '';
      newStatus   = mapStatus(mcbisStatus);
    } catch (err) {
      const code = err.response?.status;
      if (code === 404) {
        mcbisStatus = 'not_found';
        newStatus   = 'FAILED';
      } else if (code === 429 || err.message?.toLowerCase().includes('rate')) {
        console.log('RATE LIMITED — pausing 65s...');
        await sleep(65000);
        try {
          const raw2 = await checkMcbis(item.externalReference);
          mcbisStatus = raw2?.data?.order?.status || '';
          newStatus   = mapStatus(mcbisStatus);
        } catch (e2) {
          console.log(`still failing: ${e2.message}`);
          counts.error++;
          issues.push({ reference: item.reference, error: e2.message });
          await sleep(DELAY);
          continue;
        }
      } else {
        console.log(`ERROR: ${err.message}`);
        counts.error++;
        issues.push({ reference: item.reference, error: err.message });
        await sleep(DELAY);
        continue;
      }
    }

    if (newStatus === null) {
      console.log(`still in-flight (${mcbisStatus})`);
      counts.inFlight++;
      await sleep(DELAY);
      continue;
    }

    if (newStatus === 'UNKNOWN') {
      console.log(`⚠️  unrecognized: '${mcbisStatus}'`);
      counts.unknown++;
      issues.push({ reference: item.reference, mcbisStatus });
      await sleep(DELAY);
      continue;
    }

    const needsRefund = (newStatus === 'CANCELLED' || newStatus === 'FAILED')
                        && og?.walletDeducted
                        && item.totalPrice > 0
                        && wallet;

    console.log(`${mcbisStatus} → ${newStatus}${needsRefund ? ` (refund GHS ${item.totalPrice})` : ''}`);
    counts[newStatus.toLowerCase()]++;

    if (!APPLY) { await sleep(DELAY); continue; }

    try {
      // 1. Update order item status
      await prisma.orderItem.update({
        where: { id: item.id },
        data:  { status: newStatus, externalStatus: mcbisStatus, updatedAt: new Date() }
      });

      // 2. Update order group status (if not already terminal)
      if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(og.status)) {
        await prisma.orderGroup.update({
          where: { id: og.id },
          data:  { status: newStatus, summaryStatus: newStatus, updatedAt: new Date() }
        });
      }

      // 3. Refund wallet — idempotent via unique reference
      if (needsRefund) {
        const refundRef   = `MCBIS-REFUND-${item.reference}`;
        const existing    = await prisma.walletLedger.findFirst({ where: { reference: refundRef } });

        if (!existing) {
          const newBalance = parseFloat(wallet.balance) + parseFloat(item.totalPrice);
          await prisma.wallet.update({
            where: { id: wallet.id },
            data:  { balance: { increment: item.totalPrice }, updatedAt: new Date() }
          });
          await prisma.walletLedger.create({
            data: {
              walletId:       wallet.id,
              entryType:      'REFUND',
              amount:         item.totalPrice,
              runningBalance: newBalance,
              orderId:        og.id,
              description:    `Auto-refund: McBIS ${newStatus.toLowerCase()} — ${item.reference}`,
              reference:      refundRef
            }
          });
        } else {
          console.log(`      ↳ refund already issued, skipped`);
        }
      }
    } catch (txErr) {
      console.log(`      ↳ DB ERROR: ${txErr.message}`);
      counts.error++;
      issues.push({ reference: item.reference, error: txErr.message });
    }

    await sleep(DELAY);
  }

  console.log('\n=== Summary ===');
  console.log(`  ✅ Completed : ${counts.completed}`);
  console.log(`  🚫 Cancelled : ${counts.cancelled}`);
  console.log(`  ❌ Failed    : ${counts.failed}`);
  console.log(`  🔄 In-flight : ${counts.inFlight}`);
  console.log(`  ⚠️  Unknown   : ${counts.unknown}`);
  console.log(`  💥 Errors    : ${counts.error}`);
  if (!APPLY) console.log('\n  (dry run — re-run with --apply to make changes)');
  if (issues.length) {
    console.log('\nItems needing review:');
    issues.forEach(x => console.log(`  ${x.reference}: ${x.mcbisStatus || x.error}`));
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
