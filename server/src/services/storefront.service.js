/**
 * STOREFRONT SERVICE
 * ==================
 * User-generated storefront management.
 * Handles store creation, product management, and public access.
 */

const prisma = require('../lib/prisma');

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

    // Step 4: Create order and process payment in transaction
    // Balance check MUST be inside transaction to prevent race conditions
    const result = await prisma.$transaction(async (tx) => {
      // 4a. Re-check owner wallet balance INSIDE transaction (prevents race condition)
      const ownerWallet = await tx.wallet.findUnique({
        where: { userId: storefront.ownerId }
      });

      if (!ownerWallet || ownerWallet.balance < ownerCostPrice) {
        throw new Error('Store temporarily unavailable. Please try again later.');
      }

      // 4b. Create storefront order record
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
          platformProfit: Math.max(0, ownerCostPrice - (bundle.baseCost || 0)),
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
          idempotencyKey: `STORE-MOMO-${storefrontOrder.id}`, // Required unique key
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

      // Create wallet transaction (use ownerWallet from balance check)
      await tx.transaction.create({
        data: {
          walletId: ownerWallet.id,
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

    const orders = await prisma.storefrontOrder.findMany({
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
    
    // Debug log
    console.log('[getStoreOrders] First order status:', orders[0]?.status, 'linked order status:', orders[0]?.order?.status);
    
    return orders;
  },

  /**
   * Get customer orders by phone (public - for order tracking)
   * Searches by paymentPhone (recipient) OR customerPhone (account)
   */
  async getCustomerOrders(storefrontId, phone) {
    // Normalize phone format
    const normalizedPhone = phone.startsWith('0') ? phone : '0' + phone;
    
    // Search by recipient phone (paymentPhone) OR customer account phone
    const orders = await prisma.storefrontOrder.findMany({
      where: { 
        storefrontId,
        OR: [
          { paymentPhone: normalizedPhone },  // Recipient phone (where data went)
          { customerPhone: normalizedPhone }  // Account phone
        ]
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

    // Status priority: show whichever is further along in the fulfillment pipeline
    const STATUS_PRIORITY = { 'PENDING': 1, 'PROCESSING': 2, 'COMPLETED': 3, 'FAILED': 3, 'CANCELLED': 3, 'DUPLICATE_HOLD': 0 };
    const higherStatus = (a, b) => {
      const pa = STATUS_PRIORITY[a] || 0;
      const pb = STATUS_PRIORITY[b] || 0;
      return pa >= pb ? a : b;
    };

    // Map to customer-friendly format
    return orders.map(o => ({
      id: o.id.slice(0, 8).toUpperCase(),
      phone: o.paymentPhone || o.customerPhone, // Show recipient phone
      bundle: o.bundle?.name || 'Data Bundle',
      network: o.bundle?.network || 'N/A',
      dataAmount: o.bundle?.dataAmount || 'N/A',
      amount: o.amount,
      status: higherStatus(o.status, o.order?.status || 'PENDING'),
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
  async createPendingPaystackOrder(storefrontId, bundleId, customerPhone, customerName = null, recipientPhone = null) {
    // recipientPhone = where data goes (may differ from customerPhone)
    // customerPhone = customer's account phone (for order lookup)
    const dataRecipient = recipientPhone || customerPhone;
    
    // Check for existing pending order from same customer for same bundle (within last 5 minutes)
    // This prevents duplicate orders if customer clicks "Pay" multiple times
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const existingPendingOrder = await prisma.storefrontOrder.findFirst({
      where: {
        storefrontId,
        bundleId,
        customerPhone,
        paymentStatus: 'PENDING',
        createdAt: { gte: fiveMinutesAgo }
      }
    });

    if (existingPendingOrder) {
      console.log(`[Storefront] Found existing pending order ${existingPendingOrder.id} for ${customerPhone}, reusing...`);
      
      // Return existing pending order to avoid duplicates
      const bundle = await prisma.bundle.findUnique({ where: { id: bundleId } });
      return {
        storefrontOrderId: existingPendingOrder.id,
        amount: existingPendingOrder.amount,
        bundle: bundle?.name || 'Data Bundle'
      };
    }

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
    
    // Platform's profit = owner's cost - supplier cost (never negative)
    const platformProfit = Math.max(0, ownerCostPrice - supplierCost);

    // Step 4: Validate selling price covers costs
    if (agentPrice < ownerCostPrice) {
      throw new Error(`Price cannot be below cost (GHS ${ownerCostPrice.toFixed(2)})`);
    }

    // Step 5: Create PENDING storefront order with full financial tracking
    // NO wallet debit - Paystack orders don't require upfront payment from agent
    // customerPhone = account phone (for order lookup)
    // paymentPhone = recipient phone (where data goes)
    const storefrontOrder = await prisma.storefrontOrder.create({
      data: {
        storefrontId,
        storefrontProductId: customProduct?.id || null,
        customerPhone,         // Customer's account phone (for order tracking)
        customerName,
        paymentPhone: dataRecipient, // Recipient phone (where data goes)
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
   * 
   * CRITICAL: Uses database-level locking to prevent race conditions
   * between webhook and frontend verification calling simultaneously
   */
  async completePaystackOrder(storefrontOrderId, paystackReference) {
    // Use the global order ID system
    const orderGroupService = require('./order-group.service');
    
    console.log(`[Storefront] completePaystackOrder called for: ${storefrontOrderId}`);
    
    // CRITICAL: Do EVERYTHING in a transaction with row-level locking
    // This prevents race condition between webhook and frontend verify
    const result = await prisma.$transaction(async (tx) => {
      // First, fetch the order to check if already completed
      const existingOrder = await tx.storefrontOrder.findUnique({
        where: { id: storefrontOrderId }
      });
      
      if (!existingOrder) {
        throw new Error('Order not found');
      }
      
      // Check if already completed BEFORE doing anything else
      if (existingOrder.orderId) {
        console.log(`[Storefront] DUPLICATE PREVENTION: Order ${storefrontOrderId} already completed with orderId: ${existingOrder.orderId}`);
        return { success: true, alreadyCompleted: true, orderId: existingOrder.orderId };
      }
      
      // Now fetch full data with relations
      const storefrontOrder = await tx.storefrontOrder.findUnique({
        where: { id: storefrontOrderId },
        include: {
          storefront: { include: { owner: true } },
          bundle: true
        }
      });
      
      const storefront = storefrontOrder.storefront;
      const bundle = storefrontOrder.bundle;
      
      if (!storefront || !bundle) {
        throw new Error('Storefront or bundle not found');
      }
      
      console.log(`[Storefront] Processing order: ${storefrontOrderId}, Bundle: ${bundle.name}, Network: ${bundle.network}`);
      
      const supplierCost = storefrontOrder.supplierCost || bundle.baseCost;
      const customerPrice = storefrontOrder.amount; // What customer paid
      const ownerCost = storefrontOrder.ownerCost;  // Agent's cost
      
      // Recipient phone = paymentPhone (where data goes) or fallback to customerPhone
      const recipientPhone = storefrontOrder.paymentPhone || storefrontOrder.customerPhone;

      // Store orders are exempt from the duplicate guard — always process immediately
      const orderStatus = 'PENDING';

      // Create OrderGroup for global ID system
      const orderGroup = await tx.orderGroup.create({
        data: {
          idempotencyKey: `STORE-PAYSTACK-${storefrontOrderId}`, // Required unique key
          userId: storefront.ownerId,
          tenantId: storefront.tenantId,
          totalAmount: customerPrice,
          itemCount: 1,
          status: orderStatus,
          summaryStatus: orderStatus
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
          recipientPhone: recipientPhone, // Use recipient phone (where data goes)
          quantity: 1,
          unitPrice: customerPrice,     // Customer payment price
          totalPrice: customerPrice,    // Customer payment price
          baseCost: supplierCost,       // Platform's supplier cost
          reference: displayId,         // Use global order ID
          status: orderStatus,         // PENDING or DUPLICATE_HOLD
          paymentStatus: 'PAID',       // Customer already paid via Paystack
          storefrontId: storefront.id,
          storefrontOrderId: storefrontOrderId,
          priceSnapshot: ownerCost     // Agent's cost price snapshot
        }
      });

      // Create OrderItem linked to OrderGroup
      await tx.orderItem.create({
        data: {
          orderGroupId: orderGroup.id,
          bundleId: storefrontOrder.bundleId,
          recipientPhone: recipientPhone, // Use recipient phone (where data goes)
          quantity: 1,
          unitPrice: customerPrice,
          totalPrice: customerPrice,
          baseCost: supplierCost,
          status: orderStatus,
          reference: `${displayId}-01`
        }
      });

      // Update storefront order - mark as paid, link to main order
      await tx.storefrontOrder.update({
        where: { id: storefrontOrderId },
        data: { 
          orderId: order.id,
          status: 'PROCESSING',
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
        storefrontOrderId: storefrontOrderId,
        bundleId: bundle.id, // Needed for auto-process API fulfillment
        bundle: bundle.name,
        bundleNetwork: bundle.network, // Pass network for API fulfillment
        dataAmount: bundle.dataAmount, // Pass data amount for API call
        phone: recipientPhone, // The phone where data goes
        recipientPhone: recipientPhone, // Alias for auto-process
        amount: storefrontOrder.amount,
        agentProfit: storefrontOrder.ownerProfit,
        status: 'PROCESSING',
        duplicateHold: false,
        duplicateInfo: null
      };
    });
    
    // If already completed, just return
    if (result.alreadyCompleted) {
      return result;
    }

    // If duplicate hold, skip auto-processing
    if (result.duplicateHold) {
      console.log(`[Storefront] ⚠️ Order ${result.storefrontOrderId} held for duplicate review - skipping auto-process`);
      return { 
        success: true, 
        ...result,
        message: 'Order created but held for admin review - potential duplicate detected'
      };
    }

    console.log(`[Storefront] ✅ Paystack order ready for fulfillment: ${storefrontOrderId}`);
    console.log(`[Storefront] Agent profit (GHS ${result.agentProfit}) will be credited on completion`);

    // AUTO-PROCESS: Push order to API for fulfillment (per-network routing)
    try {
      const settingsController = require('../controllers/settings.controller');
      const siteSettings = settingsController.getSiteSettings();
      const orderNetwork = result.bundleNetwork || '';
      
      // Per-network routing: find the right provider for this network
      const isTruthy = (val) => val === true || val === 'true' || val === 1;
      const getNetworkToggleKey = (prefix, network) => {
        const n = (network || '').toLowerCase().replace(/\s+/g, '');
        if (n === 'mtn') return `${prefix}_mtnAPI`;
        if (n === 'telecel' || n === 'vodafone') return `${prefix}_telecelAPI`;
        if (n === 'airteltigo' || n === 'at') return `${prefix}_airteltigoAPI`;
        if (n === 'at-bigtime' || n === 'atbigtime' || n === 'at-big time' || n.includes('big time') || n.includes('bigtime')) return `${prefix}_bigtimeAPI`;
        return null;
      };
      
      const PROVIDERS = [
        { key: 'ckgodswayAPI',     name: 'CKGODSWAY', prefix: 'ckgodsway',     getService: () => require('./ckgodsway.service') },
        { key: 'mcbisAPI',         name: 'MCBIS',     prefix: 'mcbis',         getService: () => require('./datahub.service') },
        { key: 'instantdataghAPI', name: 'IDG',       prefix: 'instantdatagh', getService: () => require('./instantdatagh.service') }
      ];

      let selectedProvider = null;

      // MTN failover: use the designated primary provider instead of normal toggle order
      const mtnFailoverEnabled = isTruthy(siteSettings.mtnFailoverEnabled);
      if (mtnFailoverEnabled && orderNetwork?.toLowerCase() === 'mtn') {
        const primaryName = (siteSettings.mtnPrimaryProvider || 'MCBIS').toUpperCase();
        const primaryKey  = primaryName === 'IDG' ? 'instantdataghAPI' : 'mcbisAPI';
        const candidate   = PROVIDERS.find(p => p.key === primaryKey);
        if (candidate && isTruthy(siteSettings[candidate.key])) {
          selectedProvider = candidate;
          console.log(`[Storefront] MTN failover active — using primary provider: ${primaryName}`);
        }
      }

      // Normal toggle-based routing (non-MTN, or failover not enabled/configured)
      if (!selectedProvider) {
        for (const p of PROVIDERS) {
          if (!isTruthy(siteSettings[p.key])) continue;
          const toggleKey = getNetworkToggleKey(p.prefix, orderNetwork);
          if (toggleKey) {
            const enabled = siteSettings[toggleKey] !== false;
            if (!enabled) continue;
          }
          selectedProvider = p;
          break;
        }
      }
      
      if (selectedProvider) {
        const service = selectedProvider.getService();
        console.log(`[Storefront] Triggering ${selectedProvider.name} API fulfillment for order ${result.orderId} (${orderNetwork})...`);
        
        // Extract data amount from result (passed from transaction)
        let dataAmount = 1;
        if (result.dataAmount) {
          const match = result.dataAmount.match(/(\d+)/);
          if (match) dataAmount = parseInt(match[1]);
        }
        
        // Atomic lock: claim order before API call
        const claimResult = await prisma.order.updateMany({
          where: { id: result.orderId, apiSentAt: null, status: 'PENDING', externalReference: null },
          data: { apiSentAt: new Date() }
        });
        
        if (claimResult.count === 0) {
          console.log(`[Storefront] Order ${result.orderId} already claimed`);
        } else {
          const apiResult = await service.placeOrder({
            network: orderNetwork,
            phone: result.recipientPhone || customerPhone,
            amount: dataAmount,
            orderId: result.orderId
          });
          
          await prisma.order.update({
            where: { id: result.orderId },
            data: {
              status: apiResult.success ? 'PROCESSING' : 'PENDING',
              externalReference: apiResult.reference || null,
              ...(apiResult.success ? { providerName: selectedProvider.name } : {})
            }
          });

          // CRITICAL: Also update the linked OrderItem so retryStuckPendingOrders
          // does not pick it up and send a duplicate to the API.
          if (apiResult.success && apiResult.reference) {
            await prisma.orderItem.updateMany({
              where: {
                orderGroup: { idempotencyKey: `STORE-PAYSTACK-${storefrontOrderId}` },
                status: 'PENDING'
              },
              data: {
                status: 'PROCESSING',
                externalReference: apiResult.reference,
                apiSentAt: new Date()
              }
            });
          } else if (!apiResult.success) {
            // CKGodsway has no idempotency — each retry creates a NEW order on their end.
            // Mark FAILED so retryPendingOrders never re-queues it.
            // For MCBIS: reset apiSentAt so it stays PENDING and can be retried.
            const isCkGodsway = selectedProvider.name === 'CKGODSWAY';
            await prisma.order.update({
              where: { id: result.orderId },
              data: isCkGodsway
                ? { status: 'FAILED', failureReason: apiResult.error || 'CKGodsway API failed' }
                : { apiSentAt: null }
            });
          }

          if (!apiResult.success) {
            console.log(`[Storefront] ⚠️ API processing failed: ${apiResult.error}`);
          } else {
            console.log(`[Storefront] ✅ ${selectedProvider.name} accepted order: ${apiResult.reference}`);
          }
        }
      } else {
        console.log(`[Storefront] No API enabled for ${orderNetwork || 'unknown'} network, order will stay PENDING`);
      }
    } catch (apiError) {
      console.error(`[Storefront] API auto-process error:`, apiError.message);
      // Don't throw - order is created, just not auto-processed
    }

    return { success: true, ...result };
  }
};

module.exports = storefrontService;
