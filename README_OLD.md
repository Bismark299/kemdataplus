# KemDataplus Project Structure

## 📁 Directory Overview

```
Track/
├── client/                    # Frontend Application
│   ├── public/               # Static assets & main pages
│   │   ├── css/              # Stylesheets
│   │   ├── js/               # JavaScript files
│   │   ├── img/              # Images
│   │   └── dashboard.html    # Main dashboard
│   └── pages/                # Additional pages
│       ├── login.html
│       ├── orders.html
│       ├── profile.html
│       └── wallet.html
│
├── server/                    # Backend Application
│   ├── src/
│   │   ├── controllers/      # Route handlers
│   │   ├── middleware/       # Auth, validation, errors
│   │   ├── routes/           # API route definitions
│   │   ├── config/           # Configuration files
│   │   ├── utils/            # Helper functions
│   │   └── index.js          # Express app entry
│   ├── prisma/
│   │   ├── schema.prisma     # Database schema
│   │   └── seed.js           # Seed data
│   ├── package.json
│   └── .env.example
│
├── docs/                      # Documentation
├── tests/                     # Test files
└── package.json              # Root package.json

```

## 🚀 Quick Start

### 1. Install Dependencies
```bash
cd server
npm install
```

### 2. Setup Environment
```bash
# Copy .env.example to .env
cp .env.example .env
# Edit .env with your database credentials
```

### 3. Setup Database
```bash
# Generate Prisma client
npx prisma generate

# Push schema to database
npx prisma db push

# Seed initial data
npm run db:seed
```

### 4. Run the Server
```bash
npm run dev
```

Server runs at: http://localhost:3000

## 📡 API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - User login
- `POST /api/auth/refresh` - Refresh token
- `POST /api/auth/logout` - Logout

### Users
- `GET /api/users/me` - Get current user
- `PUT /api/users/me` - Update profile
- `GET /api/users` - Get all users (admin)
- `GET /api/users/:id` - Get user by ID (admin)

### Wallet
- `GET /api/wallet` - Get wallet details
- `GET /api/wallet/balance` - Get balance
- `GET /api/wallet/transactions` - Transaction history
- `POST /api/wallet/deposit` - Request deposit
- `POST /api/wallet/transfer` - Transfer funds

### Orders
- `GET /api/orders` - Get user's orders
- `POST /api/orders` - Create new order
- `GET /api/orders/:id` - Get order details
- `POST /api/orders/:id/cancel` - Cancel order

### Bundles
- `GET /api/bundles` - Get all bundles
- `GET /api/bundles/:id` - Get bundle by ID
- `GET /api/bundles/network/:network` - Get by network

## 🔐 Default Credentials

**Admin:**
- Email: admin@kemdataplus.com
- Password: admin123

**Test User:**
- Email: user@test.com
- Password: user123
