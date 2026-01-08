const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

// SECURITY WARNING: This seed file creates test accounts with weak passwords.
// Only run in development environments. Never run in production.
if (process.env.NODE_ENV === 'production') {
  console.error('\n❌ ERROR: Database seed should NOT be run in production!');
  console.error('This script creates test accounts with insecure passwords.');
  console.error('If you need to initialize production data, create a separate production-safe script.\n');
  process.exit(1);
}

// Role hierarchy pricing margins (percentage markup from base price)
// Lower role = higher price (more markup)
const ROLE_MARGINS = {
  ADMIN: 0,        // Admin sees base/cost price
  PARTNER: 0.05,   // 5% markup
  SUPER_DEALER: 0.10, // 10% markup
  DEALER: 0.15,    // 15% markup
  SUPER_AGENT: 0.20, // 20% markup
  AGENT: 0.25      // 25% markup (retail price)
};

async function main() {
  console.log('🌱 Starting database seed...');

  // Create admin user (password should be changed after first login)
  const adminPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'ChangeMe123!', 12);
  const admin = await prisma.user.upsert({
    where: { email: process.env.ADMIN_EMAIL || 'admin@kemdataplus.com' },
    update: {},
    create: {
      email: process.env.ADMIN_EMAIL || 'admin@kemdataplus.com',
      password: adminPassword,
      name: 'System Admin',
      phone: '0201234567',
      role: 'ADMIN',
      wallet: {
        create: { balance: 100000 }
      }
    }
  });
  console.log('✅ Admin user created:', admin.email);

  // Create test users for each role
  const testPassword = await bcrypt.hash('test123', 12);
  
  const testUsers = [
    { email: 'partner@test.com', name: 'Test Partner', role: 'PARTNER', balance: 50000 },
    { email: 'superdealer@test.com', name: 'Test Super Dealer', role: 'SUPER_DEALER', balance: 20000 },
    { email: 'dealer@test.com', name: 'Test Dealer', role: 'DEALER', balance: 10000 },
    { email: 'superagent@test.com', name: 'Test Super Agent', role: 'SUPER_AGENT', balance: 5000 },
    { email: 'agent@test.com', name: 'Test Agent', role: 'AGENT', balance: 1000 },
  ];

  for (const userData of testUsers) {
    await prisma.user.upsert({
      where: { email: userData.email },
      update: {},
      create: {
        email: userData.email,
        password: testPassword,
        name: userData.name,
        phone: '0241234567',
        role: userData.role,
        wallet: {
          create: { balance: userData.balance }
        }
      }
    });
    console.log(`✅ ${userData.role} user created:`, userData.email);
  }

  // Bundle base prices (cost price)
  const bundleData = [
    // MTN Bundles
    { name: 'MTN 1GB', network: 'MTN', dataAmount: '1GB', basePrice: 4.00, validity: 'Non-Expiry' },
    { name: 'MTN 2GB', network: 'MTN', dataAmount: '2GB', basePrice: 7.50, validity: 'Non-Expiry' },
    { name: 'MTN 5GB', network: 'MTN', dataAmount: '5GB', basePrice: 17.00, validity: 'Non-Expiry' },
    { name: 'MTN 10GB', network: 'MTN', dataAmount: '10GB', basePrice: 30.00, validity: 'Non-Expiry' },
    { name: 'MTN 20GB', network: 'MTN', dataAmount: '20GB', basePrice: 55.00, validity: 'Non-Expiry' },
    
    // Telecel Bundles
    { name: 'Telecel 1GB', network: 'TELECEL', dataAmount: '1GB', basePrice: 4.00, validity: 'Non-Expiry' },
    { name: 'Telecel 2GB', network: 'TELECEL', dataAmount: '2GB', basePrice: 7.50, validity: 'Non-Expiry' },
    { name: 'Telecel 5GB', network: 'TELECEL', dataAmount: '5GB', basePrice: 17.00, validity: 'Non-Expiry' },
    { name: 'Telecel 10GB', network: 'TELECEL', dataAmount: '10GB', basePrice: 30.00, validity: 'Non-Expiry' },
    
    // AirtelTigo Bundles
    { name: 'AT 1GB', network: 'AIRTELTIGO', dataAmount: '1GB', basePrice: 3.80, validity: 'Non-Expiry' },
    { name: 'AT 2GB', network: 'AIRTELTIGO', dataAmount: '2GB', basePrice: 7.00, validity: 'Non-Expiry' },
    { name: 'AT 5GB', network: 'AIRTELTIGO', dataAmount: '5GB', basePrice: 15.00, validity: 'Non-Expiry' },
    { name: 'AT 10GB', network: 'AIRTELTIGO', dataAmount: '10GB', basePrice: 28.00, validity: 'Non-Expiry' },
  ];

  const roles = ['ADMIN', 'PARTNER', 'SUPER_DEALER', 'DEALER', 'SUPER_AGENT', 'AGENT'];

  for (const bundle of bundleData) {
    // Create or update bundle
    const bundleId = bundle.name.toLowerCase().replace(/\s/g, '-');
    const createdBundle = await prisma.bundle.upsert({
      where: { id: bundleId },
      update: {
        name: bundle.name,
        network: bundle.network,
        dataAmount: bundle.dataAmount,
        basePrice: bundle.basePrice,
        validity: bundle.validity
      },
      create: {
        id: bundleId,
        name: bundle.name,
        network: bundle.network,
        dataAmount: bundle.dataAmount,
        basePrice: bundle.basePrice,
        validity: bundle.validity
      }
    });

    // Create role-based prices for this bundle
    for (const role of roles) {
      const margin = ROLE_MARGINS[role];
      const price = Number((bundle.basePrice * (1 + margin)).toFixed(2));
      
      await prisma.bundlePrice.upsert({
        where: {
          bundleId_role: {
            bundleId: createdBundle.id,
            role: role
          }
        },
        update: { price },
        create: {
          bundleId: createdBundle.id,
          role: role,
          price: price
        }
      });
    }
  }
  console.log('✅ Bundles with role-based pricing created:', bundleData.length);

  console.log('🎉 Database seed completed!');
  console.log('\n📋 Role Pricing Margins:');
  Object.entries(ROLE_MARGINS).forEach(([role, margin]) => {
    console.log(`   ${role}: +${(margin * 100).toFixed(0)}% markup`);
  });
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
