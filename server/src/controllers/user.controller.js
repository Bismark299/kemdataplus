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
      if (currentPassword && newPassword) {
        const user = await prisma.user.findUnique({
          where: { id: req.user.id }
        });

        const isValidPassword = await bcrypt.compare(currentPassword, user.password);
        if (!isValidPassword) {
          return res.status(400).json({ error: 'Current password is incorrect' });
        }

        updateData.password = await bcrypt.hash(newPassword, 12);
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

      res.json({
        message: 'Profile updated successfully',
        user: updatedUser
      });
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

      const updatedUser = await prisma.user.update({
        where: { id: req.params.id },
        data: { name, phone, role, isActive },
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
