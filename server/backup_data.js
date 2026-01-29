// Backup script to save data before migration
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

const prisma = new PrismaClient();

async function backupData() {
  try {
    console.log('Backing up data before migration...\n');
    
    const backup = {};
    
    // Backup agent_payouts table
    try {
      const agentPayouts = await prisma.$queryRawUnsafe('SELECT * FROM agent_payouts');
      backup.agent_payouts = agentPayouts;
      console.log(`agent_payouts: ${agentPayouts.length} rows`);
      if (agentPayouts.length > 0) {
        console.log('Sample:', JSON.stringify(agentPayouts[0], null, 2));
      }
    } catch (e) {
      console.log('agent_payouts: table not found or error -', e.message);
    }
    
    // Check for paystackRecipientCode column
    try {
      const usersWithCode = await prisma.$queryRawUnsafe(
        'SELECT id, email, "paystackRecipientCode" FROM users WHERE "paystackRecipientCode" IS NOT NULL'
      );
      backup.users_paystackRecipientCode = usersWithCode;
      console.log(`\nusers with paystackRecipientCode: ${usersWithCode.length} rows`);
      if (usersWithCode.length > 0) {
        console.log('Sample:', JSON.stringify(usersWithCode[0], null, 2));
      }
    } catch (e) {
      console.log('\npaystackRecipientCode column: not found -', e.message);
    }
    
    // Save backup to file
    const backupFile = `backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
    console.log(`\n✅ Backup saved to: ${backupFile}`);
    
  } catch (error) {
    console.error('Backup error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

backupData();
