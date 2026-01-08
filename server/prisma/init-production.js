/**
 * Production-Safe Database Initialization
 * Creates admin user with secure credentials from environment variables
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function initProduction() {
  console.log('🚀 Initializing production database...');

  // Get credentials from environment or use secure defaults
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@kemdataplus.com';
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    console.error('❌ ERROR: ADMIN_PASSWORD environment variable is required!');
    console.log('Set it in your Render environment variables.');
    process.exit(1);
  }

  if (adminPassword.length < 8) {
    console.error('❌ ERROR: ADMIN_PASSWORD must be at least 8 characters!');
    process.exit(1);
  }

  try {
    // Check if admin already exists
    const existingAdmin = await prisma.user.findFirst({
      where: { role: 'ADMIN' }
    });

    if (existingAdmin) {
      console.log('✅ Admin user already exists:', existingAdmin.email);
      console.log('Skipping admin creation.');
    } else {
      // Create admin user with wallet
      const hashedPassword = await bcrypt.hash(adminPassword, 12);
      
      const admin = await prisma.user.create({
        data: {
          email: adminEmail,
          password: hashedPassword,
          name: 'Administrator',
          phone: '0200000000',
          role: 'ADMIN',
          isActive: true,
          canCreateUsers: true,
          hierarchyLevel: 0,
          wallet: {
            create: {
              balance: 0
            }
          }
        }
      });

      console.log('✅ Admin user created successfully!');
      console.log('   Email:', admin.email);
      console.log('   Role:', admin.role);
    }

    // Create default bundles if none exist
    const bundleCount = await prisma.bundle.count();
    
    if (bundleCount === 0) {
      console.log('📦 Creating default bundles...');
      
      const defaultBundles = [
        { name: 'MTN 1GB', network: 'MTN', dataAmount: '1GB', baseCost: 3.50, basePrice: 4.50, validity: '30 days' },
        { name: 'MTN 2GB', network: 'MTN', dataAmount: '2GB', baseCost: 6.50, basePrice: 8.00, validity: '30 days' },
        { name: 'MTN 5GB', network: 'MTN', dataAmount: '5GB', baseCost: 14.00, basePrice: 18.00, validity: '30 days' },
        { name: 'MTN 10GB', network: 'MTN', dataAmount: '10GB', baseCost: 26.00, basePrice: 32.00, validity: '30 days' },
        { name: 'Telecel 1GB', network: 'Telecel', dataAmount: '1GB', baseCost: 3.50, basePrice: 4.50, validity: '30 days' },
        { name: 'Telecel 2GB', network: 'Telecel', dataAmount: '2GB', baseCost: 6.50, basePrice: 8.00, validity: '30 days' },
        { name: 'AirtelTigo 1GB', network: 'AirtelTigo', dataAmount: '1GB', baseCost: 3.50, basePrice: 4.50, validity: '30 days' },
        { name: 'AirtelTigo 2GB', network: 'AirtelTigo', dataAmount: '2GB', baseCost: 6.50, basePrice: 8.00, validity: '30 days' },
      ];

      for (const bundleData of defaultBundles) {
        // Create bundle with role-based prices
        const bundle = await prisma.bundle.create({ 
          data: bundleData
        });
        
        // Create prices for each role
        const roles = ['PARTNER', 'SUPER_DEALER', 'DEALER', 'SUPER_AGENT', 'AGENT'];
        const priceMultipliers = { PARTNER: 1.0, SUPER_DEALER: 1.05, DEALER: 1.10, SUPER_AGENT: 1.15, AGENT: 1.20 };
        
        for (const role of roles) {
          await prisma.bundlePrice.create({
            data: {
              bundleId: bundle.id,
              role: role,
              price: Math.round(bundleData.basePrice * priceMultipliers[role] * 100) / 100
            }
          });
        }
      }
      
      console.log(`✅ Created ${defaultBundles.length} default bundles with role prices`);
    } else {
      console.log(`✅ ${bundleCount} bundles already exist`);
    }

    console.log('');
    console.log('🎉 Production initialization complete!');
    console.log('');
    console.log('You can now log in at:');
    console.log('  Admin Panel: https://kemdataplus.onrender.com/admin/dashboard.html');
    console.log('  Email:', adminEmail);

  } catch (error) {
    console.error('❌ Initialization failed:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

initProduction();
