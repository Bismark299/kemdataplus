const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const userController = {
  // Get current user profile
  async getProfile(req, res, next) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          createdAt: true,
          wallet: {
            select: { balance: true }
          }
        }
      });

      res.json(user);
    } catch (error) {
      next(error);
    }
  },

  // Update current user profile
  async updateProfile(req, res, next) {
    try {
      const { name, phone, currentPassword, newPassword } = req.body;
      const updateData = {};

      if (name) updateData.name = name;
      if (phone) updateData.phone = phone;

      // Handle password change
      let passwordChanged = false;
      if (currentPassword && newPassword) {
        const user = await prisma.user.findUnique({
          where: { id: req.user.id }
        });

        const isValidPassword = await bcrypt.compare(currentPassword, user.password);
        if (!isValidPassword) {
          return res.status(400).json({ error: 'Current password is incorrect' });
        }

        updateData.password = await bcrypt.hash(newPassword, 12);
        // Track password change time for token invalidation
        updateData.passwordChangedAt = new Date();
        passwordChanged = true;
      }

      const updatedUser = await prisma.user.update({
        where: { id: req.user.id },
        data: updateData,
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true
        }
      });

      // If password was changed, inform user they need to re-login
      const response = {
        message: passwordChanged 
          ? 'Password changed successfully. Please login again with your new password.'
          : 'Profile updated successfully',
        user: updatedUser
      };
      
      // Clear the auth cookie if password changed
      if (passwordChanged) {
        res.clearCookie('token', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict'
        });
        response.requireRelogin = true;
      }

      res.json(response);
    } catch (error) {
      next(error);
    }
  },

  // Get all users (admin)
  async getAllUsers(req, res, next) {
    try {
      // Validate and sanitize pagination parameters
      const page = Math.max(1, Math.min(parseInt(req.query.page) || 1, 10000));
      const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100));
      const skip = (page - 1) * limit;

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          skip,
          take: limit,
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            role: true,
            isActive: true,
            createdAt: true,
            wallet: {
              select: { balance: true }
            }
          },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.user.count()
      ]);

      res.json({
        users,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  },

  // Get user by ID (admin)
  async getUserById(req, res, next) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true,
          wallet: {
            select: { balance: true }
          },
          orders: {
            take: 10,
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(user);
    } catch (error) {
      next(error);
    }
  },

  // Update user (admin)
  async updateUser(req, res, next) {
    try {
      const { name, phone, role, isActive } = req.body;

      // Whitelist allowed fields only
      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (phone !== undefined) updateData.phone = phone;
      
      // Role changes require extra validation
      if (role !== undefined) {
        // Only allow valid roles
        const validRoles = ['USER', 'AGENT', 'ADMIN'];
        if (!validRoles.includes(role)) {
          return res.status(400).json({ error: 'Invalid role' });
        }
        // Prevent changing own role (must be done by another admin)
        if (req.params.id === req.user.id) {
          return res.status(400).json({ error: 'Cannot change your own role' });
        }
        updateData.role = role;
      }
      
      // isActive changes require validation
      if (isActive !== undefined) {
        if (req.params.id === req.user.id && isActive === false) {
          return res.status(400).json({ error: 'Cannot deactivate your own account' });
        }
        updateData.isActive = isActive;
      }

      const updatedUser = await prisma.user.update({
        where: { id: req.params.id },
        data: updateData,
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          isActive: true
        }
      });

      res.json({
        message: 'User updated successfully',
        user: updatedUser
      });
    } catch (error) {
      next(error);
    }
  },

  // Deactivate user (admin)
  async deactivateUser(req, res, next) {
    try {
      // Prevent admin from deactivating themselves
      if (req.params.id === req.user.id) {
        return res.status(400).json({ error: 'Cannot deactivate your own account' });
      }

      // Check if target is the last active admin
      const targetUser = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (targetUser?.role === 'ADMIN') {
        const activeAdminCount = await prisma.user.count({
          where: { role: 'ADMIN', isActive: true }
        });
        if (activeAdminCount <= 1) {
          return res.status(400).json({ error: 'Cannot deactivate the last active admin' });
        }
      }

      await prisma.user.update({
        where: { id: req.params.id },
        data: { isActive: false }
      });

      res.json({ message: 'User deactivated successfully' });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = userController;
