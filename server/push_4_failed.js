/**
 * push_4_failed.js
 * 
 * Sends the 4 failed OrderItems (MCBIS returned 404 - never received) to MCBIS now.
 * Orders: ORD-047937, ORD-047936, ORD-047941, ORD-047939
 * 
 * Run: node push_4_failed.js
 */

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient({
  datasources: { db: { url: 'process.env.DATABASE_URL' } }
});

const MCBIS_URL = 'https://datahub.mcbissolution.com/api/v1';
const MCBIS_TOKEN = '44|XWxomstKxT6Evxv2FUpvBq3uDs3yukPT4iFQSrsc894d387f';

const NETWORK_MAP = {
  'MTN': 'mtn', 'mtn': 'mtn',
  'TELECEL': 'telecel', 'telecel': 'telecel', 'Telecel': 'telecel',
  'AIRTELTIGO': 'atishare', 'AirtelTigo': 'atishare', 'airteltigo': 'atishare', 'AT': 'atishare',
  'AT-BIG TIME': 'atbigtime', 'AT-BIGTIME': 'atbigtime', 'AT- BIG TIME': 'atbigtime'
};

const TARGET_REFS = ['ORD-047937-01', 'ORD-047936-01', 'ORD-047941-01', 'ORD-047939-01'];

function generateReference() {
  return `KEM${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
}

function formatPhone(phone) {
  let p = (phone || '').replace(/\s+/g, '');
  if (p.startsWith('+233')) return '0' + p.slice(4);
  if (p.startsWith('233')) return '0' + p.slice(3);
  return p;
}

async function sendToMcbis(network, phone, dataAmount, itemRef) {
  const apiNetwork = NETWORK_MAP[network];
  if (!apiNetwork) throw new Error(`Unknown network: ${network}`);

  const reference = generateReference();
  const payload = { network: apiNetwork, reference, receiver: formatPhone(phone), amount: dataAmount };

  console.log(`  Sending to MCBIS: ${JSON.stringify(payload)}`);

  const resp = await axios.post(`${MCBIS_URL}/placeOrder`, payload, {
    headers: {
      Authorization: `Bearer ${MCBIS_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    timeout: 45000
  });

  return { reference, data: resp.data };
}

async function main() {
  const items = await prisma.orderItem.findMany({
    where: { reference: { in: TARGET_REFS } },
    include: { bundle: true }
  });

  if (items.length === 0) {
    console.log('No items found for those references.');
    return;
  }

  console.log(`\nFound ${items.length} items to push:\n`);

  for (const item of items) {
    const network = item.bundle?.network || 'MTN';
    const dataAmountStr = item.bundle?.dataAmount || '1GB';
    const match = dataAmountStr.match(/(\d+)/);
    const dataAmount = match ? parseInt(match[1]) : 1;

    console.log(`${item.reference} | ${item.recipientPhone} | ${network} ${dataAmountStr}`);

    try {
      // Delay between sends to avoid rate limit
      await new Promise(r => setTimeout(r, 2000));

      const result = await sendToMcbis(network, item.recipientPhone, dataAmount, item.reference);

      console.log(`  ✅ Sent! MCBIS ref: ${result.reference} | Response: ${JSON.stringify(result.data).substring(0, 120)}`);

      // Update DB: mark PROCESSING with new reference
      await prisma.orderItem.update({
        where: { id: item.id },
        data: {
          status: 'PROCESSING',
          externalReference: result.reference,
          apiSentAt: new Date(),
          failureReason: null
        }
      });

      console.log(`  ✅ DB updated to PROCESSING`);

    } catch (err) {
      const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
      console.log(`  ❌ Failed: ${errMsg}`);
    }
  }

  console.log('\n=== Done ===');
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
