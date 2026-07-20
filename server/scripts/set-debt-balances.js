/**
 * One-time script: set debtBalance for users who could not be recovered
 * immediately because their wallet balance was too low.
 * The debt is automatically deducted on their next deposit.
 *
 * Run: node server/scripts/set-debt-balances.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEBTS = [
  { email: 'blockerbee1@gmail.com',   name: 'Emmanuel Simpson', debt: 80.00 },
  { email: 'kwesidela5670@gmail.com', name: 'Dela Kwesi',        debt: 8.00  },
];

async function main() {
  console.log('=== Setting Pending Debt Balances ===\n');

  for (const rec of DEBTS) {
    const user = await prisma.user.findUnique({
      where: { email: rec.email },
      include: { wallet: true }
    });

    if (!user || !user.wallet) {
      console.log(`⚠  NOT FOUND  ${rec.name} (${rec.email})`);
      continue;
    }

    const current = user.wallet.debtBalance || 0;
    if (current >= rec.debt) {
      console.log(`⏩  SKIP  ${rec.name} — debt already set to GH₵${current.toFixed(2)}`);
      continue;
    }

    await prisma.wallet.update({
      where: { id: user.wallet.id },
      data: { debtBalance: rec.debt }
    });

    console.log(`✓  SET  ${rec.name} (${rec.email}): debtBalance = GH₵${rec.debt.toFixed(2)}  (wallet balance: GH₵${user.wallet.balance.toFixed(2)})`);
  }

  console.log('\nDone. Debt will be auto-deducted on their next deposit.');
}

main()
  .catch(err => { console.error('Script failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
