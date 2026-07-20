/**
 * Recover excess amounts from the 28 newly-identified over-refund events.
 * Groups by walletId so each wallet is only touched once per transaction,
 * avoiding balance race conditions and negative-balance constraint violations.
 *
 * DRY RUN by default. Set DRY_RUN=false to commit.
 * Run: node server/scripts/recover-new-overrefunds.js
 * Run: DRY_RUN=false node server/scripts/recover-new-overrefunds.js
 */
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const prisma = new PrismaClient();

const DRY_RUN = process.env.DRY_RUN !== 'false';

const OVER_REFUNDS = [
  // Jul 8–16
  { orderRef: 'ORD-083155-02', correct: 4.00,   actual: 8.00   },
  { orderRef: 'ORD-082068-02', correct: 4.00,   actual: 16.00  },
  { orderRef: 'ORD-082673-01', correct: 4.00,   actual: 8.00   },
  { orderRef: 'ORD-083419-01', correct: 16.00,  actual: 24.00  },
  { orderRef: 'ORD-083238-01', correct: 4.00,   actual: 36.00  },
  { orderRef: 'ORD-083228-01', correct: 20.00,  actual: 40.00  },
  { orderRef: 'ORD-082506-02', correct: 4.00,   actual: 12.00  },
  { orderRef: 'ORD-082485-02', correct: 8.00,   actual: 16.00  },
  { orderRef: 'ORD-082326-01', correct: 4.00,   actual: 43.50  },
  { orderRef: 'ORD-081742-01', correct: 190.50, actual: 198.50 },
  { orderRef: 'ORD-082739-01', correct: 39.50,  actual: 47.50  },
  { orderRef: 'ORD-082909-02', correct: 16.00,  actual: 55.50  },
  { orderRef: 'ORD-082838-04', correct: 8.00,   actual: 20.00  },
  { orderRef: 'ORD-083009-07', correct: 8.00,   actual: 79.50  },
  // Jul 17
  { orderRef: 'ORD-083560-04', correct: 8.00,   actual: 144.50 },
  { orderRef: 'ORD-084069-01', correct: 4.00,   actual: 147.00 },
  { orderRef: 'ORD-084050-01', correct: 4.00,   actual: 55.50  },
  { orderRef: 'ORD-084042-02', correct: 4.00,   actual: 36.00  },
  { orderRef: 'ORD-084002-06', correct: 20.00,  actual: 191.00 },
  { orderRef: 'ORD-083736-01', correct: 4.00,   actual: 16.00  },
  { orderRef: 'ORD-083726-01', correct: 4.00,   actual: 40.00  },
  { orderRef: 'ORD-083636-02', correct: 4.00,   actual: 24.00  },
  { orderRef: 'ORD-083558-04', correct: 4.00,   actual: 116.00 },
  { orderRef: 'ORD-083539-04', correct: 4.00,   actual: 73.00  },
  { orderRef: 'ORD-083485-01', correct: 4.00,   actual: 44.00  },
  // Jul 18
  { orderRef: 'ORD-084592-02', correct: 4.10,   actual: 16.40  },
  { orderRef: 'ORD-084475-01', correct: 40.00,  actual: 80.00  },
  { orderRef: 'ORD-084241-18', correct: 4.10,   actual: 279.50 },
];

function r2(n) { return Math.round(n * 100) / 100; }

async function main() {
  if (DRY_RUN) console.log('=== DRY RUN — no changes will be committed ===\n');
  else         console.log('=== LIVE RUN — committing changes ===\n');

  // ── 1. Resolve every order to its wallet, skip already-recovered ──────────
  const rows = []; // { orderRef, excess, walletId, userId, label }

  for (const row of OVER_REFUNDS) {
    const excess = r2(row.actual - row.correct);
    const recoveryRef = `RECOVERY-${row.orderRef}`;

    const item = await prisma.orderItem.findFirst({
      where: { reference: row.orderRef },
      include: {
        orderGroup: {
          include: {
            user: {
              select: {
                id: true, name: true, email: true,
                wallet: { select: { id: true } }
              }
            }
          }
        }
      }
    });

    if (!item?.orderGroup?.user?.wallet) {
      console.log(`⚠  SKIP  ${row.orderRef} — wallet not found`);
      continue;
    }

    const existing = await prisma.walletLedger.findFirst({
      where: { walletId: item.orderGroup.user.wallet.id, reference: recoveryRef }
    });
    if (existing) {
      console.log(`⏩  ALREADY DONE  ${row.orderRef}  (${item.orderGroup.user.email})`);
      continue;
    }

    rows.push({
      orderRef: row.orderRef,
      correct:  row.correct,
      actual:   row.actual,
      excess,
      walletId: item.orderGroup.user.wallet.id,
      userId:   item.orderGroup.user.id,
      label:    item.orderGroup.user.name || item.orderGroup.user.email || item.orderGroup.user.id.slice(0,8)
    });
  }

  // ── 2. Group by walletId so each wallet is processed in one transaction ───
  const byWallet = new Map();
  for (const row of rows) {
    if (!byWallet.has(row.walletId)) byWallet.set(row.walletId, []);
    byWallet.get(row.walletId).push(row);
  }

  let totalImmediate = 0, totalDeferred = 0, walletsDone = 0;

  for (const [walletId, items] of byWallet) {
    const totalExcess = r2(items.reduce((s, r) => s + r.excess, 0));
    const label = items[0].label;

    if (DRY_RUN) {
      // Re-fetch live balance for accurate dry-run display
      const w = await prisma.wallet.findUnique({ where: { id: walletId }, select: { balance: true, debtBalance: true } });
      const balance  = w.balance;
      const nowDeduct = r2(Math.min(totalExcess, Math.max(0, balance)));
      const defer     = r2(totalExcess - nowDeduct);
      console.log(
        `  [DRY] ${label}  total excess GH₵${totalExcess.toFixed(2)}  bal GH₵${balance.toFixed(2)}` +
        `  → deduct GH₵${nowDeduct.toFixed(2)}` +
        (defer > 0 ? `  defer GH₵${defer.toFixed(2)}` : '  fully immediate') +
        `  (${items.map(i=>i.orderRef).join(', ')})`
      );
      totalImmediate += nowDeduct;
      totalDeferred  += defer;
      walletsDone++;
      continue;
    }

    // LIVE: single transaction per wallet
    await prisma.$transaction(async (tx) => {
      // Lock & re-read balance inside the transaction
      const w = await tx.wallet.findUnique({ where: { id: walletId }, select: { balance: true, debtBalance: true } });
      let   runningBalance = w.balance;
      const currentDebt    = w.debtBalance || 0;

      let walletImmediate = 0;
      let walletDeferred  = 0;

      for (const item of items) {
        const recoveryRef = `RECOVERY-${item.orderRef}`;
        const nowDeduct   = r2(Math.min(item.excess, Math.max(0, runningBalance)));
        const defer       = r2(item.excess - nowDeduct);

        runningBalance = r2(runningBalance - nowDeduct);
        walletImmediate += nowDeduct;
        walletDeferred  += defer;

        if (nowDeduct > 0) {
          await tx.walletLedger.create({
            data: {
              id: uuidv4(),
              walletId,
              entryType: 'PURCHASE',
              amount: -nowDeduct,
              runningBalance,
              description: `Over-refund recovery: ${item.orderRef} (refunded GH₵${item.actual.toFixed(2)}, correct GH₵${item.correct.toFixed(2)})`,
              reference: recoveryRef
            }
          });
        }

        if (defer > 0) {
          await tx.walletLedger.create({
            data: {
              id: uuidv4(),
              walletId,
              entryType: 'PURCHASE',
              amount: 0,
              runningBalance,
              description: `Debt flagged GH₵${defer.toFixed(2)} for ${item.orderRef} — auto-deducted on next deposit`,
              reference: `${recoveryRef}-DEBT`
            }
          });
        }
      }

      // Apply the net balance change and debt in one wallet update
      const newDebt = r2(currentDebt + walletDeferred);
      await tx.wallet.update({
        where: { id: walletId },
        data: {
          balance: runningBalance,
          ...(newDebt !== currentDebt ? { debtBalance: newDebt } : {})
        }
      });

      totalImmediate += walletImmediate;
      totalDeferred  += walletDeferred;
    });

    const itemList = items.map(i => `${i.orderRef} GH₵${i.excess.toFixed(2)}`).join(', ');
    console.log(`✓  ${label}  total GH₵${totalExcess.toFixed(2)}  → ${itemList}`);
    walletsDone++;
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Wallets processed     : ${walletsDone}`);
  console.log(`Recovered immediately : GH₵${totalImmediate.toFixed(2)}`);
  console.log(`Deferred as debt      : GH₵${totalDeferred.toFixed(2)}`);
  console.log(`Total recovered       : GH₵${r2(totalImmediate + totalDeferred).toFixed(2)}`);
  if (DRY_RUN) console.log('\nRe-run with DRY_RUN=false to commit.');
}

main()
  .catch(err => { console.error('Script failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
