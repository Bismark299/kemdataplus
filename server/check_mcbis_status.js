/**
 * Test: check what MCBIS actually returns for a few order references
 * Shows the FULL raw response so we can see which field is the real delivery status
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const settingsPath = path.join(__dirname, 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const token = process.env.DATAHUB_API_TOKEN || settings.adminSettings?.mcbisApiToken;
const baseUrl = process.env.DATAHUB_API_URL || settings.adminSettings?.mcbisApiUrl || 'https://datahub.mcbissolution.com/api/v1';

// Pick a handful of references from the stuck list - check them all
const references = [
  'KEM1777067885898JKMCS5', // ORD-038585-01 - ~2.5hrs old
  'KEM1777067582593MUOP3R', // ORD-038584-01
  'KEM1777034673676AM82FF', // ORD-038132 - older (12:44)
  'KEM17770352727638OCQCS', // ORD-038138 - older
];

async function check(ref) {
  const url = `${baseUrl}/checkOrderStatus/${ref}`;
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: 15000
    });
    console.log(`\n=== ${ref} ===`);
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.log(`\n=== ${ref} === ERROR: ${err.message}`);
  }
}

(async () => {
  for (const ref of references) await check(ref);
})();
