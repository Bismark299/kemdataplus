const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * STRICT PRICING RULES - DO NOT MODIFY
 * =====================================
 * 1. ALL prices are set MANUALLY by admin per role per bundle
 * 2. NO automatic margins or calculations
 * 3. NO price inheritance between roles
 * 4. If no price exists for a role → bundle is NOT shown to that role
 * 5. Frontend CANNOT send prices - server fetches from database only
 */

// Role hierarchy (for admin display order only, NOT for pricing)
const ROLE_HIERARCHY = ['ADMIN', 'PARTNER', 'SUPER_DEALER', 'DEALER', 'SUPER_AGENT', 'AGENT'];

/**
 * Convert data amount string to MB for sorting
 * e.g., "500MB" -> 500, "1GB" -> 1024, "1.5GB" -> 1536
 */
function parseDataAmountToMB(dataAmount) {
  if (!dataAmount) return 0;
  const str = dataAmount.toString().toUpperCase().trim();
  
  // Extract number and unit
  const match = str.match(/^([\d.]+)\s*(GB|MB|TB|KB)?$/i);
  if (!match) return 0;
  
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'MB').toUpperCase();
  
  switch (unit) {
    case 'TB': return value * 1024 * 1024;
    case 'GB': return value * 1024;
    case 'MB': return value;
    case 'KB': return value / 1024;
    default: return value;
  }
}

/**
 * Sort bundles by network (asc) then by data amount (asc)
 */
function sortBundlesByDataSize(bundles) {
  return bundles.sort((a, b) => {
    // First sort by network
    const networkCompare = a.network.localeCompare(b.network);
    if (networkCompare !== 0) return networkCompare;
    
    // Then sort by data amount (ascending)
    const aSize = parseDataAmountToMB(a.dataAmount);
    const bSize = parseDataAmountToMB(b.dataAmount);
    return aSize - bSize;
  });
}

const bundleController = {
  /**
   * Get all bundles with role-based pricing
   * RULE: Only returns bundles that have a price set for the user's role
   * ADMIN: Sees ALL bundles (active and inactive) for management
   * NON-ADMIN: Sees ALL bundles - inactive ones shown as "Out of Stock"
   */
  async getAllBundles(req, res, next) {
    try {
      const userRole = req.user?.role || 'AGENT';
      const isAdmin = userRole === 'ADMIN';
      
      // Fetch ALL bundles (including inactive) for everyone
      // Admins manage them, users see inactive as "Out of Stock"
      const bundles = await prisma.bundle.findMany({
        include: { prices: true }
      });

      if (isAdmin) {
        // Admin sees ALL bundles with ALL role prices (active and inactive)
        const adminBundles = bundles.map(bundle => ({
          id: bundle.id,
          name: bundle.name,
          network: bundle.network,
          dataAmount: bundle.dataAmount,
          basePrice: bundle.basePrice,
          validity: bundle.validity,
          description: bundle.description,
          isActive: bundle.isActive,
          createdAt: bundle.createdAt,
          updatedAt: bundle.updatedAt,
          // All role prices for admin
          rolePrices: bundle.prices.reduce((acc, p) => {
            acc[p.role] = p.price;
            return acc;
          }, {})
        }));
        // Sort by network then data size ascending
        return res.json(sortBundlesByDataSize(adminBundles));
      }

      // NON-ADMIN: Only return bundles that have a price for this role
      const bundlesForRole = [];
      
      for (const bundle of bundles) {
        const rolePrice = bundle.prices.find(p => p.role === userRole);
        
        // STRICT RULE: No price for role = bundle not available
        if (!rolePrice) {
          continue; // Skip this bundle - user cannot see it
        }

        bundlesForRole.push({
          id: bundle.id,
          name: bundle.name,
          network: bundle.network,
          dataAmount: bundle.dataAmount,
          price: rolePrice.price, // Server-set price only
          validity: bundle.validity,
          description: bundle.description,
          isActive: bundle.isActive
          // NO basePrice, NO rolePrices - user sees only their price
        });
      }

      // Sort by network then data size ascending
      res.json(sortBundlesByDataSize(bundlesForRole));
    } catch (error) {
      next(error);
    }
  },

  /**
   * Get bundle by ID with role-based price
   * RULE: Returns 404 if no price exists for user's role
   */
  async getBundleById(req, res, next) {
    try {
      const userRole = req.user?.role || 'AGENT';
      const isAdmin = userRole === 'ADMIN';
      
      const bundle = await prisma.bundle.findUnique({
        where: { id: req.params.id },
        include: { prices: true }
      });

      if (!bundle || !bundle.isActive) {
        return res.status(404).json({ error: 'Bundle not found' });
      }

      if (isAdmin) {
        return res.json({
          ...bundle,
          rolePrices: bundle.prices.reduce((acc, p) => {
            acc[p.role] = p.price;
            return acc;
          }, {})
        });
      }

      // Non-admin: must have price for role
      const rolePrice = bundle.prices.find(p => p.role === userRole);
      
      if (!rolePrice) {
        return res.status(404).json({ error: 'Bundle not available for your role' });
      }

      res.json({
        id: bundle.id,
        name: bundle.name,
        network: bundle.network,
        dataAmount: bundle.dataAmount,
        price: rolePrice.price,
        validity: bundle.validity,
        description: bundle.description,
        isActive: bundle.isActive
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Get bundles by network with role-based pricing
   * RULE: Only returns bundles with prices set for user's role
   */
  async getBundlesByNetwork(req, res, next) {
    try {
      const { network } = req.params;
      const userRole = req.user?.role || 'AGENT';
      const isAdmin = userRole === 'ADMIN';

      const bundles = await prisma.bundle.findMany({
        where: {
          network: network.toUpperCase(),
          isActive: true
        },
        include: { prices: true }
      });

      if (isAdmin) {
        const adminBundles = bundles.map(bundle => ({
          id: bundle.id,
          name: bundle.name,
          network: bundle.network,
          dataAmount: bundle.dataAmount,
          basePrice: bundle.basePrice,
          validity: bundle.validity,
          description: bundle.description,
          isActive: bundle.isActive,
          rolePrices: bundle.prices.reduce((acc, p) => {
            acc[p.role] = p.price;
            return acc;
          }, {})
        }));
        // Sort by data size ascending
        return res.json(sortBundlesByDataSize(adminBundles));
      }

      // Non-admin: filter to only bundles with price for role
      const bundlesForRole = [];
      
      for (const bundle of bundles) {
        const rolePrice = bundle.prices.find(p => p.role === userRole);
        if (!rolePrice) continue;

        bundlesForRole.push({
          id: bundle.id,
          name: bundle.name,
          network: bundle.network,
          dataAmount: bundle.dataAmount,
          price: rolePrice.price,
          validity: bundle.validity,
          description: bundle.description,
          isActive: bundle.isActive
        });
      }

      // Sort by data size ascending
      res.json(sortBundlesByDataSize(bundlesForRole));
    } catch (error) {
      next(error);
    }
  },

  /**
   * Create bundle (admin only)
   * RULE: Prices are set manually per role - no automatic calculation
   */
  async createBundle(req, res, next) {
    try {
      const { 
        name, network, dataAmount, validity, description,
        basePrice, // Cost price (admin reference)
        // Role prices - ALL must be set manually
        partnerPrice, superDealerPrice, dealerPrice, superAgentPrice, agentPrice,
        rolePrices // Alternative: { PARTNER: x, SUPER_DEALER: y, ... }
      } = req.body;

      if (!name || !network || !dataAmount) {
        return res.status(400).json({ error: 'Name, network, and dataAmount are required' });
      }

      const validBasePrice = Number(basePrice) || 0;

      // Build role prices from request
      const pricesMap = {};
      
      // Support both individual fields and rolePrices object
      if (rolePrices && typeof rolePrices === 'object') {
        for (const [role, price] of Object.entries(rolePrices)) {
          if (ROLE_HIERARCHY.includes(role) && price !== undefined && price !== null && price !== '') {
            pricesMap[role] = Number(price);
          }
        }
      }
      
      // Individual fields override rolePrices object
      if (partnerPrice !== undefined && partnerPrice !== '') pricesMap['PARTNER'] = Number(partnerPrice);
      if (superDealerPrice !== undefined && superDealerPrice !== '') pricesMap['SUPER_DEALER'] = Number(superDealerPrice);
      if (dealerPrice !== undefined && dealerPrice !== '') pricesMap['DEALER'] = Number(dealerPrice);
      if (superAgentPrice !== undefined && superAgentPrice !== '') pricesMap['SUPER_AGENT'] = Number(superAgentPrice);
      if (agentPrice !== undefined && agentPrice !== '') pricesMap['AGENT'] = Number(agentPrice);

      // Create bundle with prices in transaction
      const bundle = await prisma.$transaction(async (tx) => {
        const newBundle = await tx.bundle.create({
          data: {
            name,
            network: network.toUpperCase(),
            dataAmount,
            basePrice: validBasePrice,
            validity: validity || 'Non-Expiry',
            description: description || ''
          }
        });

        // Create ONLY the prices that were explicitly set
        for (const [role, price] of Object.entries(pricesMap)) {
          if (isNaN(price)) continue;
          
          await tx.bundlePrice.create({
            data: {
              bundle: { connect: { id: newBundle.id } },
              role,
              price: Number(price.toFixed(2))
            }
          });
        }

        return tx.bundle.findUnique({
          where: { id: newBundle.id },
          include: { prices: true }
        });
      });

      res.status(201).json({
        message: 'Bundle created successfully',
        bundle: {
          ...bundle,
          rolePrices: bundle.prices.reduce((acc, p) => {
            acc[p.role] = p.price;
            return acc;
          }, {})
        }
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Update bundle (admin only)
   * RULE: Only updates prices that are explicitly provided
   */
  async updateBundle(req, res, next) {
    try {
      const { 
        name, network, dataAmount, validity, description, isActive,
        basePrice,
        partnerPrice, superDealerPrice, dealerPrice, superAgentPrice, agentPrice,
        rolePrices
      } = req.body;

      // Build role prices from request
      const pricesMap = {};
      
      if (rolePrices && typeof rolePrices === 'object') {
        for (const [role, price] of Object.entries(rolePrices)) {
          if (ROLE_HIERARCHY.includes(role) && price !== undefined && price !== null) {
            pricesMap[role] = Number(price);
          }
        }
      }
      
      if (partnerPrice !== undefined) pricesMap['PARTNER'] = Number(partnerPrice);
      if (superDealerPrice !== undefined) pricesMap['SUPER_DEALER'] = Number(superDealerPrice);
      if (dealerPrice !== undefined) pricesMap['DEALER'] = Number(dealerPrice);
      if (superAgentPrice !== undefined) pricesMap['SUPER_AGENT'] = Number(superAgentPrice);
      if (agentPrice !== undefined) pricesMap['AGENT'] = Number(agentPrice);

      const bundle = await prisma.$transaction(async (tx) => {
        // Build update data
        const updateData = {};
        if (name !== undefined) updateData.name = name;
        if (network !== undefined) updateData.network = network.toUpperCase();
        if (dataAmount !== undefined) updateData.dataAmount = dataAmount;
        if (basePrice !== undefined) updateData.basePrice = Number(basePrice);
        if (validity !== undefined) updateData.validity = validity;
        if (description !== undefined) updateData.description = description;
        if (isActive !== undefined) updateData.isActive = isActive;

        await tx.bundle.update({
          where: { id: req.params.id },
          data: updateData
        });

        // Update prices that were provided
        for (const [role, price] of Object.entries(pricesMap)) {
          if (isNaN(price)) continue;
          
          await tx.bundlePrice.upsert({
            where: {
              bundleId_role: {
                bundleId: req.params.id,
                role
              }
            },
            update: { price: Number(price.toFixed(2)) },
            create: {
              bundle: { connect: { id: req.params.id } },
              role,
              price: Number(price.toFixed(2))
            }
          });
        }

        return tx.bundle.findUnique({
          where: { id: req.params.id },
          include: { prices: true }
        });
      });

      res.json({
        message: 'Bundle updated successfully',
        bundle: {
          ...bundle,
          rolePrices: bundle.prices.reduce((acc, p) => {
            acc[p.role] = p.price;
            return acc;
          }, {})
        }
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Delete role price (admin only)
   * Removes a specific role's access to a bundle
   */
  async deleteRolePrice(req, res, next) {
    try {
      const { bundleId, role } = req.params;

      await prisma.bundlePrice.delete({
        where: {
          bundleId_role: {
            bundleId,
            role
          }
        }
      });

      res.json({ message: `Price for ${role} removed from bundle` });
    } catch (error) {
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Price not found' });
      }
      next(error);
    }
  },

  /**
   * Get price for current user's role
   * RULE: Returns 404 if no price set for role
   */
  async getBundlePrice(req, res, next) {
    try {
      const { bundleId } = req.params;
      const userRole = req.user?.role || 'AGENT';

      const bundle = await prisma.bundle.findUnique({
        where: { id: bundleId },
        include: { prices: true }
      });

      if (!bundle || !bundle.isActive) {
        return res.status(404).json({ error: 'Bundle not found' });
      }

      const rolePrice = bundle.prices.find(p => p.role === userRole);
      
      if (!rolePrice) {
        return res.status(404).json({ error: 'Bundle not available for your role' });
      }

      res.json({
        bundleId: bundle.id,
        bundleName: bundle.name,
        role: userRole,
        price: rolePrice.price
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Delete bundle (admin) - soft delete
   */
  async deleteBundle(req, res, next) {
    try {
      await prisma.bundle.update({
        where: { id: req.params.id },
        data: { isActive: false }
      });

      res.json({ message: 'Bundle deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = bundleController;
