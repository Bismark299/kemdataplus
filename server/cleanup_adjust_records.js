/**
 * One-time cleanup: Delete AdminProfitAdjustment records
 * that were NOT created by the +/- quick buttons.
 *
 * Quick buttons always use notes starting with "Quick deduction" or "Quick addition".
 * The Adjust modal used custom notes. The user confirmed only -107 was made via the modal.
 *
 * Run: cd server && node cleanup_adjust_records.js
 * (Requires DATABASE_URL in environment or .env)
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // First, show ALL adjustment records so we can verify
  const all = await prisma.adminProfitAdjustment.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { name: true, email: true } } }
  });

  console.log(`\nTotal AdminProfitAdjustment records: ${all.length}\n`);
  all.forEach(r => {
    console.log(`  ID: ${r.id}`);
    console.log(`  User: ${r.user?.name || 'Unknown'} (${r.userId})`);
    console.log(`  Amount: ${r.amount}`);
    console.log(`  Note: ${r.note || '(no note)'}`);
    console.log(`  Created: ${r.createdAt}`);
    console.log(`  ---`);
  });

  // Find records NOT from quick +/- buttons
  const nonQuickRecords = all.filter(r => {
    const note = (r.note || '').toLowerCase();
    return !note.startsWith('quick deduction') && !note.startsWith('quick addition');
  });

  console.log(`\nRecords NOT from +/- buttons (to delete): ${nonQuickRecords.length}`);
  nonQuickRecords.forEach(r => {
    console.log(`  -> ${r.user?.name}: ${r.amount} | note: "${r.note || '(none)'}"`);
  });

  if (nonQuickRecords.length === 0) {
    console.log('\nNothing to delete. All records are from +/- buttons.');
    return;
  }

  // Delete them
  const ids = nonQuickRecords.map(r => r.id);
  const result = await prisma.adminProfitAdjustment.deleteMany({
    where: { id: { in: ids } }
  });

  console.log(`\nDeleted ${result.count} adjustment record(s).`);
  console.log('Agent balances will now recalculate correctly without those adjustments.');
}

main()
  .catch(e => { console.error('Error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
