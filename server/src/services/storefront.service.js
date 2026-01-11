/**
 * STOREFRONT SERVICE
 * ==================
 * User-generated storefront management.
 * Handles store creation, product management, and public access.
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Roles allowed to create storefronts
const STOREFRONT_ALLOWED_ROLES = ['ADMIN', 'PARTNER', 'SUPER_DEALER', 'DEALER', 'SUPER_AGENT', 'AGENT'];

// Maximum storefronts per role
const MAX_STOREFRONTS_BY_ROLE = {
  ADMIN: 999,
  PARTNER: 10,
  SUPER_DEALER: 5,
  DEALER: 3,
  SUPER_AGENT: 2,
  AGENT: 1
};

const storefrontService = {
  /**
   * Create a new storefront
   * @param {string} userId - Owner user ID
   * @param {object} storeData - Store details
   */
  async createStore(userId, storeData) {
    // Step 1: Validate user status
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        storefronts: true,
        tenant: true
      }
    });

    if (!user) {
      throw new Error('User not found');
    }

    if (!user.isActive) {
      throw new Error('User account is not active');
    }

    // Step 2: Validate role permission
    if (!STOREFRONT_ALLOWED_ROLES.includes(user.role)) {
      throw new Error(`Role ${user.role} is not allowed to create storefronts`);
    }

    // Step 3: Enforce store limits
    const maxStores = MAX_STOREFRONTS_BY_ROLE[user.role] || 1;
    if (user.storefronts.length >= maxStores) {
      throw new Error(`Maximum storefront limit (${maxStores}) reached for your role`);
    }

    // Step 4: Generate unique slug
    let slug = this.generateSlug(storeData.name || storeData.slug);
    
    // Ensure slug is unique
    let slugExists = await prisma.storefront.findUnique({ where: { slug } });
    let counter = 1;
    const baseSlug = slug;
    while (slugExists) {
      slug = `${baseSlug}-${counter}`;
      slugExists = await prisma.storefront.findUnique({ where: { slug } });
      counter++;
    }

    // Step 5: Create storefront
    const storefront = await prisma.storefront.create({
      data: {
        ownerId: userId,
        tenantId: user.tenantId,
        slug,
        name: storeData.name,
        description: storeData.description,
        logoUrl: storeData.logoUrl,
        bannerUrl: storeData.bannerUrl,
        primaryColor: storeData.primaryColor || '#024959',
        accentColor: storeData.accentColor || '#F2C12E',
        contactPhone: storeData.contactPhone || user.phone,
        contactEmail: storeData.contactEmail || user.email,
        contactWhatsapp: storeData.contactWhatsapp,
        isPublic: storeData.isPublic !== false,
        showOwnerInfo: storeData.showOwnerInfo || false,
        allowDirectContact: storeData.allowDirectContact !== false,
        status: 'ACTIVE'
      },
      include: {
        owner: {
          select: { id: true, name: true, email: true, role: true }
        }
      }
    });

    // Step 6: Log audit event
    await prisma.auditLog.create({
      data: {
        user: { connect: { id: userId } },
        tenant: user.tenantId ? { connect: { id: user.tenantId } } : undefined,
        action: 'CREATE',
        entityType: 'Storefront',
        entityId: storefront.id,
        newValues: { slug, name: storeData.name }
      }
    });

    return storefront;
  },

  /**
   * Generate URL-safe slug from name
   */
  generateSlug(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50);
  },

  /**
   * Get storefront by slug (public access)
   * Filters out products where bundle is out of stock
   */
  async getBySlug(slug) {
    const storefront = await prisma.storefront.findUnique({
      where: { slug },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            role: true
          }
        },
        products: {
          where: { 
            isVisible: true,
            bundle: {
              isActive: true,
              outOfStock: false
            }
          },
          include: {
            bundle: {
              select: {
                id: true,
                name: true,
                network: true,
                dataAmount: true,
                validity: true,
                description: true,
                isActive: true,
                outOfStock: true
              }
            }
          },
          orderBy: { displayOrder: 'asc' }
        }
      }
    });

    if (!storefront) {
      return null;
    }

    // Don't show suspended/disabled stores publicly
    if (storefront.status !== 'ACTIVE') {
      return null;
    }

    // Increment view count
    await prisma.storefront.update({
      where: { id: storefront.id },
      data: { viewCount: { increment: 1 } }
    });

    // Hide owner info if configured
    if (!storefront.showOwnerInfo) {
      storefront.owner = {
        name: storefront.name,
        phone: storefront.contactPhone,
        email: storefront.contactEmail
      };
    }

    return storefront;
  },

  /**
   * Get storefront by ID
   */
  async getById(storefrontId) {
    return prisma.storefront.findUnique({
      where: { id: storefrontId },
      include: {
        owner: {
          select: { id: true, name: true, email: true, role: true }
        },
        products: {
          include: {
            bundle: true
          }
        }
      }
    });
  },

  /**
   * Get all storefronts owned by user
   */
  async getByOwner(userId) {
    return prisma.storefront.findMany({
      where: { ownerId: userId },
      include: {
        _count: {
          select: { orders: true, products: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  /**
   * Update storefront details
   */
  async updateStore(storefrontId, userId, updates) {
    const storefront = await prisma.storefront.findUnique({
      where: { id: storefrontId }
    });

    if (!storefront) {
      throw new Error('Storefront not found');
    }

    if (storefront.ownerId !== userId) {
      throw new Error('Not authorized to update this storefront');
    }

    // Prevent slug change after creation (URL stability)
    delete updates.slug;
    delete updates.ownerId;
    delete updates.tenantId;
    delete updates.status;

    const updated = await prisma.storefront.update({
      where: { id: storefrontId },
      data: updates
    });

    await prisma.auditLog.create({
      data: {
        user: { connect: { id: userId } },
        action: 'UPDATE',
        entityType: 'Storefront',
        entityId: storefrontId,
        oldValues: storefront,
        newValues: updates
      }
    });

    return updated;
  },

  /**
   * Add product to storefront
   */
  async addProduct(storefrontId, userId, bundleId, options = {}) {
    const storefront = await prisma.storefront.findUnique({
      where: { id: storefrontId },
      include: { owner: true }
    });

    if (!storefront) {
      throw new Error('Storefront not found');
    }

    if (storefront.ownerId !== userId) {
      throw new Error('Not authorized');
    }

    // Check if product already exists
    const existingProduct = await prisma.storefrontProduct.findFirst({
      where: { storefrontId, bundleId }
    });

    if (existingProduct) {
      throw new Error('Product already exists in this store');
    }

    // Get owner's cost price for this bundle
    const ownerCostPrice = await this.resolveOwnerPrice(storefront.owner, bundleId);
    if (!ownerCostPrice) {
      throw new Error('No price available for this bundle');
    }

    // Validate selling price (must be >= cost price)
    let sellingPrice = options.sellingPrice ? parseFloat(options.sellingPrice) : null;
    if (sellingPrice !== null && sellingPrice < ownerCostPrice) {
      throw new Error(`Selling price (${sellingPrice}) cannot be less than your cost price (${ownerCostPrice})`);
    }

    const product = await prisma.storefrontProduct.create({
      data: {
        storefrontId,
        bundleId,
        displayName: options.displayName,
        displayOrder: options.displayOrder || 0,
        isVisible: options.isVisible !== false,
        priceSnapshot: ownerCostPrice,
        sellingPrice: sellingPrice
      },
      include: { bundle: true }
    });

    return {
      ...product,
      costPrice: ownerCostPrice,
      profit: sellingPrice ? sellingPrice - ownerCostPrice : 0
    };
  },

  /**
   * Update product pricing and visibility
   */
  async updateProduct(storefrontId, userId, productId, updates) {
    const product = await prisma.storefrontProduct.findFirst({
      where: {
        id: productId,
        storefrontId,
        storefront: { ownerId: userId }
      },
      include: { storefront: { include: { owner: true } } }
    });

    if (!product) {
      throw new Error('Product not found or not authorized');
    }

    // If updating selling price, validate it's >= cost
    if (updates.sellingPrice !== undefined) {
      const sellingPrice = parseFloat(updates.sellingPrice);
      if (sellingPrice < product.priceSnapshot) {
        throw new Error(`Selling price cannot be less than your cost price (GHS ${product.priceSnapshot})`);
      }
      updates.sellingPrice = sellingPrice;
    }

    const updated = await prisma.storefrontProduct.update({
      where: { id: productId },
      data: {
        displayName: updates.displayName,
        displayOrder: updates.displayOrder,
        isVisible: updates.isVisible,
        sellingPrice: updates.sellingPrice
      },
      include: { bundle: true }
    });

    return {
      ...updated,
      costPrice: updated.priceSnapshot,
      profit: updated.sellingPrice ? updated.sellingPrice - updated.priceSnapshot : 0
    };
  },

  /**
   * Remove product from storefront
   */
  async removeProduct(storefrontId, userId, productId) {
    const product = await prisma.storefrontProduct.findFirst({
      where: {
        id: productId,
        storefrontId,
        storefront: { ownerId: userId }
      }
    });

    if (!product) {
      throw new Error('Product not found or not authorized');
    }

    await prisma.storefrontProduct.delete({
      where: { id: productId }
    });

    return { success: true };
  },

  /**
   * Resolve owner's price for a bundle
   */
  async resolveOwnerPrice(owner, bundleId) {
    // First check tenant-specific price
    if (owner.tenantId) {
      const tenantPrice = await prisma.tenantBundlePrice.findFirst({
        where: {
          tenantId: owner.tenantId,
          bundleId,
          role: owner.role,
          isValid: true
        }
      });
      if (tenantPrice) return tenantPrice.price;
    }

    // Fall back to system role price
    const rolePrice = await prisma.bundlePrice.findFirst({
      where: { bundleId, role: owner.role }
    });
    
    return rolePrice?.price || null;
  },

  /**
   * Get products with live prices for storefront (public view)
   */
  /**
   * Get ALL bundles for storefront display (public view)
   * All bundles are shown - inactive ones marked as "Out of Stock"
   * Owner can set custom selling prices via StorefrontProduct records
   */
  async getStorefrontProducts(storefrontId, isOwnerView = false) {
    const storefront = await prisma.storefront.findUnique({
      where: { id: storefrontId },
      include: {
        owner: true,
        products: true // Custom prices set by owner
      }
    });

    if (!storefront) {
      throw new Error('Storefront not found');
    }

    // Get ALL bundles (including inactive - they show as "Out of Stock")
    const bundles = await prisma.bundle.findMany({
      orderBy: [{ network: 'asc' }, { dataAmount: 'asc' }]
    });

    // Map custom prices by bundleId for quick lookup
    const customPrices = {};
    storefront.products.forEach(p => {
      customPrices[p.bundleId] = p;
    });

    // Build products list with owner's prices
    const productsWithPrices = await Promise.all(
      bundles.map(async (bundle) => {
        const costPrice = await this.resolveOwnerPrice(storefront.owner, bundle.id);
        if (!costPrice) return null; // Skip if no price available for owner

        const customProduct = customPrices[bundle.id];
        const sellingPrice = customProduct?.sellingPrice || costPrice; // Default to cost if no custom price
        const profit = sellingPrice - costPrice;
        
        // Bundle is out of stock if isActive is false OR outOfStock is true
        const isOutOfStock = !bundle.isActive || bundle.outOfStock === true;

        return {
          id: customProduct?.id || bundle.id,
          bundleId: bundle.id,
          displayName: bundle.name,
          outOfStock: isOutOfStock,
          bundle: {
            id: bundle.id,
            name: bundle.name,
            network: bundle.network,
            dataAmount: bundle.dataAmount,
            validity: bundle.validity,
            description: bundle.description,
            isActive: bundle.isActive
          },
          // Public sees selling price
          price: sellingPrice,
          // Owner sees cost breakdown
          ...(isOwnerView && {
            costPrice,
            sellingPrice,
            profit,
            hasCustomPrice: !!customProduct
          })
        };
      })
    );

    return productsWithPrices.filter(p => p !== null);
  },

  /**
   * Set custom selling price for a bundle in owner's store
   */
  async setProductPrice(storefrontId, userId, bundleId, sellingPrice) {
    const storefront = await prisma.storefront.findFirst({
      where: { id: storefrontId, ownerId: userId },
      include: { owner: true }
    });

    if (!storefront) {
      throw new Error('Storefront not found or not authorized');
    }

    // Get owner's cost price
    const costPrice = await this.resolveOwnerPrice(storefront.owner, bundleId);
    if (!costPrice) {
      throw new Error('Bundle not available');
    }

    // Validate selling price >= cost price
    if (sellingPrice < costPrice) {
      throw new Error(`Selling price cannot be less than your cost (GHS ${costPrice})`);
    }

    // Upsert the custom price
    const product = await prisma.storefrontProduct.upsert({
      where: {
        storefrontId_bundleId: { storefrontId, bundleId }
      },
      update: {
        sellingPrice,
        priceSnapshot: costPrice
      },
      create: {
        storefrontId,
        bundleId,
        sellingPrice,
        priceSnapshot: costPrice
      },
      include: { bundle: true }
    });

    return {
      ...product,
      costPrice,
      profit: sellingPrice - costPrice
    };
  },

  /**
   * Get all bundles with owner's pricing for store management
   */
  async getAvailableBundles(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true }
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Get all active bundles that are NOT out of stock
    const bundles = await prisma.bundle.findMany({
      where: { 
        isActive: true,
        outOfStock: false
      },
      orderBy: [{ network: 'asc' }, { dataAmount: 'asc' }]
    });

    // Get prices for each bundle based on user's role
    const bundlesWithPrices = await Promise.all(
      bundles.map(async (bundle) => {
        const costPrice = await this.resolveOwnerPrice(user, bundle.id);
        return {
          ...bundle,
          costPrice: costPrice || 0,
          hasPrice: costPrice !== null
        };
      })
    );

    return bundlesWithPrices.filter(b => b.hasPrice);
  },

  /**
   * ADMIN: Suspend storefront
   */
  async suspendStore(storefrontId, adminId, reason) {
    const storefront = await prisma.storefront.update({
      where: { id: storefrontId },
      data: {
        status: 'SUSPENDED',
        suspendedAt: new Date(),
        suspendedReason: reason,
        suspendedBy: adminId
      }
    });

    await prisma.auditLog.create({
      data: {
        user: { connect: { id: adminId } },
        action: 'TENANT_SUSPEND',
        entityType: 'Storefront',
        entityId: storefrontId,
        newValues: { status: 'SUSPENDED', reason }
      }
    });

    return storefront;
  },

  /**
   * ADMIN: Activate storefront
   */
  async activateStore(storefrontId, adminId) {
    const storefront = await prisma.storefront.update({
      where: { id: storefrontId },
      data: {
        status: 'ACTIVE',
        suspendedAt: null,
        suspendedReason: null,
        suspendedBy: null
      }
    });

    await prisma.auditLog.create({
      data: {
        user: { connect: { id: adminId } },
        action: 'UPDATE',
        entityType: 'Storefront',
        entityId: storefrontId,
        newValues: { status: 'ACTIVE' }
      }
    });

    return storefront;
  },

  /**
   * ADMIN: Disable storefront permanently
   */
  async disableStore(storefrontId, adminId, reason) {
    const storefront = await prisma.storefront.update({
      where: { id: storefrontId },
      data: {
        status: 'DISABLED',
        suspendedAt: new Date(),
        suspendedReason: reason,
        suspendedBy: adminId
      }
    });

    await prisma.auditLog.create({
      data: {
        user: { connect: { id: adminId } },
        action: 'DELETE',
        entityType: 'Storefront',
        entityId: storefrontId,
        newValues: { status: 'DISABLED', reason }
      }
    });

    return storefront;
  },

  /**
   * ADMIN: Get all storefronts
   */
  async getAllStorefronts(filters = {}) {
    const where = {};
    
    if (filters.status) where.status = filters.status;
    if (filters.ownerId) where.ownerId = filters.ownerId;
    if (filters.tenantId) where.tenantId = filters.tenantId;

    return prisma.storefront.findMany({
      where,
      include: {
        owner: {
          select: { id: true, name: true, email: true, role: true }
        },
        _count: {
          select: { orders: true, products: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  /**
   * Update storefront analytics after order
   */
  async recordOrder(storefrontId, orderAmount) {
    await prisma.storefront.update({
      where: { id: storefrontId },
      data: {
        totalOrders: { increment: 1 },
        totalRevenue: { increment: orderAmount }
      }
    });
  },

  /**
   * Place order through storefront (public customer)
   * Customer pays via MoMo, then order is processed
   * Store owner's wallet is debited at their cost price
   */
  async placeOrder(storefrontId, bundleId, customerPhone, customerName = null, paymentReference = null) {
    // Step 1: Get storefront details
    const storefront = await prisma.storefront.findUnique({
      where: { id: storefrontId },
      include: {
        owner: {
          include: { wallet: true }
        },
        products: {
          where: { bundleId }
        }
      }
    });

    if (!storefront || storefront.status !== 'ACTIVE') {
      throw new Error('Store not available');
    }

    // Step 2: Get bundle and verify it's active
    const bundle = await prisma.bundle.findFirst({
      where: {
        id: bundleId,
        isActive: true,
        outOfStock: false
      }
    });

    if (!bundle) {
      throw new Error('Bundle not available');
    }

    // Step 3: Calculate prices
    const ownerCostPrice = await this.resolveOwnerPrice(storefront.owner, bundleId);
    if (!ownerCostPrice) {
      throw new Error('Price configuration error');
    }

    // Get custom selling price or default to cost
    const customProduct = storefront.products[0];
    const sellingPrice = customProduct?.sellingPrice || ownerCostPrice;
    const profit = sellingPrice - ownerCostPrice;

    // Step 4: Check owner wallet has enough balance
    if (!storefront.owner.wallet || storefront.owner.wallet.balance < ownerCostPrice) {
      throw new Error('Store temporarily unavailable. Please try again later.');
    }

    // Step 5: Create order and process payment in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create storefront order record
      const storefrontOrder = await tx.storefrontOrder.create({
        data: {
          storefrontId,
          storefrontProductId: customProduct?.id || null,
          customerPhone,
          customerName,
          bundleId,
          amount: sellingPrice,
          ownerCost: ownerCostPrice,
          ownerProfit: profit,
          supplierCost: bundle.baseCost || ownerCostPrice,
          platformProfit: ownerCostPrice - (bundle.baseCost || 0),
          status: 'PENDING',
          paymentStatus: paymentReference ? 'PAID' : 'PENDING',
          paymentReference,
          paymentMethod: 'MOMO'
        }
      });

      // Use the global order ID system
      const orderGroupService = require('./order-group.service');
      
      // Create OrderGroup for global ID
      const orderGroup = await tx.orderGroup.create({
        data: {
          userId: storefront.ownerId,
          tenantId: storefront.tenantId,
          totalAmount: sellingPrice,
          itemCount: 1,
          status: 'PENDING',
          summaryStatus: 'PENDING'
        }
      });

      // Format the display ID (ORD-XXXXXX)
      const displayId = orderGroupService.formatOrderId(orderGroup.sequenceNum);
      
      // Update with display ID
      await tx.orderGroup.update({
        where: { id: orderGroup.id },
        data: { displayId }
      });

      // Create main order with global ID
      const order = await tx.order.create({
        data: {
          userId: storefront.ownerId,
          bundleId,
          recipientPhone: customerPhone,
          quantity: 1,
          unitPrice: sellingPrice,
          totalPrice: sellingPrice,
          baseCost: bundle.baseCost || ownerCostPrice,
          reference: displayId,
          status: 'PENDING',
          paymentStatus: 'PAID',
          storefrontId,
          storefrontOrderId: storefrontOrder.id,
          priceSnapshot: ownerCostPrice
        }
      });

      // Create OrderItem linked to OrderGroup
      await tx.orderItem.create({
        data: {
          orderGroupId: orderGroup.id,
          bundleId,
          recipientPhone: customerPhone,
          quantity: 1,
          unitPrice: sellingPrice,
          totalPrice: sellingPrice,
          baseCost: bundle.baseCost || ownerCostPrice,
          status: 'PENDING',
          reference: `${displayId}-01`
        }
      });

      // Link order to storefront order
      await tx.storefrontOrder.update({
        where: { id: storefrontOrder.id },
        data: { orderId: order.id }
      });

      // Debit owner's wallet at cost price
      await tx.wallet.update({
        where: { userId: storefront.ownerId },
        data: {
          balance: { decrement: ownerCostPrice }
        }
      });

      // Create wallet transaction
      await tx.transaction.create({
        data: {
          walletId: storefront.owner.wallet.id,
          type: 'PURCHASE',
          amount: ownerCostPrice,
          description: `Store order - ${bundle.name} to ${customerPhone}`,
          reference: `STORE-${storefrontOrder.id}`,
          status: 'COMPLETED'
        }
      });

      // Update storefront stats
      await tx.storefront.update({
        where: { id: storefrontId },
        data: {
          totalOrders: { increment: 1 },
          totalRevenue: { increment: sellingPrice }
        }
      });

      return {
        orderId: order.id,
        storefrontOrderId: storefrontOrder.id,
        bundle: bundle.name,
        phone: customerPhone,
        amount: sellingPrice,
        status: 'PENDING'
      };
    });

    return result;
  },

  /**
   * Get storefront orders (for store owner)
   */
  async getStoreOrders(storefrontId, userId) {
    const storefront = await prisma.storefront.findFirst({
      where: { id: storefrontId, ownerId: userId }
    });

    if (!storefront) {
      throw new Error('Storefront not found or not authorized');
    }

    return prisma.storefrontOrder.findMany({
      where: { storefrontId },
      include: {
        bundle: {
          select: { name: true, network: true, dataAmount: true, validity: true }
        },
        order: {
          select: { status: true, createdAt: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  /**
   * Get customer orders by phone (public - for order tracking)
   */
  async getCustomerOrders(storefrontId, phone) {
    // Normalize phone format
    const normalizedPhone = phone.startsWith('0') ? phone : '0' + phone;
    
    const orders = await prisma.storefrontOrder.findMany({
      where: { 
        storefrontId,
        customerPhone: normalizedPhone
      },
      include: {
        bundle: {
          select: { name: true, network: true, dataAmount: true, validity: true }
        },
        order: {
          select: { status: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 20 // Limit to last 20 orders
    });

    // Map to customer-friendly format
    return orders.map(o => ({
      id: o.id.slice(0, 8).toUpperCase(),
      bundle: o.bundle?.name || 'Data Bundle',
      network: o.bundle?.network || 'N/A',
      dataAmount: o.bundle?.dataAmount || 'N/A',
      amount: o.amount,
      status: o.order?.status || o.status,
      paymentStatus: o.paymentStatus,
      createdAt: o.createdAt
    }));
  },

  /**
   * Create pending storefront order for Paystack payment
   * Does NOT debit wallet - profits credited only after fulfillment completes
   * 
   * Financial Flow:
   * 1. Customer pays via Paystack (GHS X)
   * 2. Order created and fulfilled
   * 3. On COMPLETED: Agent profit credited to wallet
   */
  async createPendingPaystackOrder(storefrontId, bundleId, customerPhone, customerName = null) {
    // Step 1: Get storefront details
    const storefront = await prisma.storefront.findUnique({
      where: { id: storefrontId },
      include: {
        owner: {
          include: { wallet: true, tenant: true }
        },
        products: {
          where: { bundleId }
        }
      }
    });

    if (!storefront || storefront.status !== 'ACTIVE') {
      throw new Error('Store not available');
    }

    // Step 2: Get bundle and verify it's active
    const bundle = await prisma.bundle.findFirst({
      where: {
        id: bundleId,
        isActive: true,
        outOfStock: false
      }
    });

    if (!bundle) {
      throw new Error('Bundle not available');
    }

    // Step 3: Get pricing components
    const financialOrderService = require('./financial-order.service');
    
    // Get owner's actual cost price (what they pay based on their role)
    const ownerCostPrice = await this.resolveOwnerPrice(storefront.owner, bundleId);
    if (!ownerCostPrice) {
      throw new Error('Price configuration error');
    }

    // Supplier cost = what KemDataPlus pays (baseCost)
    const supplierCost = bundle.baseCost || 0;

    // Get agent's selling price (custom or default to owner's cost)
    // This MUST match what getStorefrontProducts shows to customers
    const customProduct = storefront.products[0];
    const agentPrice = customProduct?.sellingPrice || ownerCostPrice;
    
    // Agent's profit = selling price - their cost
    const agentProfit = agentPrice - ownerCostPrice;
    
    // Platform's profit = owner's cost - supplier cost
    const platformProfit = ownerCostPrice - supplierCost;

    // Step 4: Validate selling price covers costs
    if (agentPrice < ownerCostPrice) {
      throw new Error(`Price cannot be below cost (GHS ${ownerCostPrice.toFixed(2)})`);
    }

    // Step 5: Create PENDING storefront order with full financial tracking
    // NO wallet debit - Paystack orders don't require upfront payment from agent
    const storefrontOrder = await prisma.storefrontOrder.create({
      data: {
        storefrontId,
        storefrontProductId: customProduct?.id || null,
        customerPhone,
        customerName,
        bundleId,
        // Customer payment (what customer pays = agent's selling price)
        amount: agentPrice,
        // Financial snapshots
        ownerCost: ownerCostPrice,      // Agent's cost (based on their role)
        ownerProfit: agentProfit,       // Agent's profit margin
        supplierCost: supplierCost,     // Platform's cost (baseCost)
        platformProfit: platformProfit, // Platform's profit margin
        // Profit tracking
        profitCredited: false,          // Will be true after COMPLETED
        // Payment tracking
        status: 'PENDING',
        paymentStatus: 'PENDING',
        paymentMethod: 'PAYSTACK'
      }
    });

    console.log(`[Storefront] Created Paystack order: ${storefrontOrder.id}`);
    console.log(`[Storefront] Pricing: Customer pays GHS ${agentPrice}, Agent cost: GHS ${ownerCostPrice}, Agent profit: GHS ${agentProfit}, Platform profit: GHS ${platformProfit}`);

    return {
      storefrontOrderId: storefrontOrder.id,
      amount: agentPrice,
      bundle: bundle.name
    };
  },

  /**
   * Complete Paystack order after payment verification
   * Creates main order for fulfillment - NO wallet debit
   * 
   * Paystack Flow (profit-on-completion):
   * 1. Customer pays → Payment verified (we're here)
   * 2. Main order created → API fulfillment triggered
   * 3. On COMPLETED → Agent profit credited via financial-order.service
   */
  async completePaystackOrder(storefrontOrderId, paystackReference) {
    // Get the pending order
    const storefrontOrder = await prisma.storefrontOrder.findUnique({
      where: { id: storefrontOrderId },
      include: {
        storefront: {
          include: {
            owner: true
          }
        },
        bundle: true
      }
    });

    if (!storefrontOrder) {
      throw new Error('Order not found');
    }

    // Check if already completed
    if (storefrontOrder.orderId) {
      console.log(`[Storefront] Order ${storefrontOrderId} already completed`);
      return { success: true, alreadyCompleted: true };
    }

    const storefront = storefrontOrder.storefront;
    const supplierCost = storefrontOrder.supplierCost || storefrontOrder.bundle.baseCost;
    const customerPrice = storefrontOrder.amount; // What customer paid
    const ownerCost = storefrontOrder.ownerCost;  // Agent's cost

    // Use the global order ID system
    const orderGroupService = require('./order-group.service');
    
    // Complete in transaction - NO WALLET DEBIT for Paystack orders
    const result = await prisma.$transaction(async (tx) => {
      // Create OrderGroup for global ID system
      const orderGroup = await tx.orderGroup.create({
        data: {
          userId: storefront.ownerId,
          tenantId: storefront.tenantId,
          totalAmount: customerPrice,
          itemCount: 1,
          status: 'PENDING',
          summaryStatus: 'PENDING'
        }
      });

      // Format the display ID (ORD-XXXXXX)
      const displayId = orderGroupService.formatOrderId(orderGroup.sequenceNum);
      
      // Update with display ID
      await tx.orderGroup.update({
        where: { id: orderGroup.id },
        data: { displayId }
      });

      // Create main order for fulfillment with proper pricing
      const order = await tx.order.create({
        data: {
          userId: storefront.ownerId,
          bundleId: storefrontOrder.bundleId,
          recipientPhone: storefrontOrder.customerPhone,
          quantity: 1,
          unitPrice: customerPrice,     // Customer payment price
          totalPrice: customerPrice,    // Customer payment price
          baseCost: supplierCost,       // Platform's supplier cost
          reference: displayId,         // Use global order ID
          status: 'PENDING',           // Ready for API fulfillment
          paymentStatus: 'PAID',       // Customer already paid via Paystack
          storefrontId: storefront.id,
          storefrontOrderId: storefrontOrder.id,
          priceSnapshot: ownerCost     // Agent's cost price snapshot
        }
      });

      // Create OrderItem linked to OrderGroup
      await tx.orderItem.create({
        data: {
          orderGroupId: orderGroup.id,
          bundleId: storefrontOrder.bundleId,
          recipientPhone: storefrontOrder.customerPhone,
          quantity: 1,
          unitPrice: customerPrice,
          totalPrice: customerPrice,
          baseCost: supplierCost,
          status: 'PENDING',
          reference: `${displayId}-01`
        }
      });

      // Update storefront order - mark as paid, link to main order
      await tx.storefrontOrder.update({
        where: { id: storefrontOrderId },
        data: { 
          orderId: order.id,
          status: 'PROCESSING',        // Being processed
          paymentStatus: 'PAID',
          paystackReference
        }
      });

      // Update storefront stats
      await tx.storefront.update({
        where: { id: storefront.id },
        data: {
          totalOrders: { increment: 1 },
          totalRevenue: { increment: storefrontOrder.amount }
        }
      });

      return {
        orderId: order.id,
        storefrontOrderId: storefrontOrder.id,
        bundle: storefrontOrder.bundle.name,
        phone: storefrontOrder.customerPhone,
        amount: storefrontOrder.amount,
        agentProfit: storefrontOrder.ownerProfit,
        status: 'PROCESSING'
      };
    });

    console.log(`[Storefront] ✅ Paystack order ready for fulfillment: ${storefrontOrderId}`);
    console.log(`[Storefront] Agent profit (GHS ${storefrontOrder.ownerProfit}) will be credited on completion`);

    return { success: true, ...result };
  }
};

module.exports = storefrontService;
