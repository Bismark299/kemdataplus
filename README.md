# KemDataplus - Data Bundle Reseller Platform

A full-stack application for managing data bundle reselling operations with multi-tier agent management, wallet system, and order processing.

## ✨ Features

- 🔐 **Multi-Role Authentication**: Admin, Partner, Super Dealer, Dealer, Super Agent, Agent
- 💰 **Wallet System**: Deposits, withdrawals, transfers, balance management
- 📦 **Order Management**: Create, process, complete, cancel orders with automatic refunds
- 📊 **Admin Dashboard**: Full control over users, orders, networks, and reports
- 📱 **Agent Dashboard**: Order creation (single/bulk/excel), history, wallet
- 🌐 **Network Management**: MTN, Telecel, AirtelTigo with tiered pricing
- 📈 **Reports**: Sales reports, user reports with export capability

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL database

### Local Development

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd kemdataplus

# 2. Install dependencies
cd server && npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your database URL and secrets

# 4. Setup database
npx prisma generate
npx prisma migrate deploy
node prisma/seed.js

# 5. Start server
npm run dev
```

### Access Points
| URL | Description |
|-----|-------------|
| http://localhost:3000 | Agent Dashboard |
| http://localhost:3000/admin/dashboard.html | Admin Panel |
| http://localhost:3000/api/health | API Health Check |

## 🔑 Default Credentials

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@kemdataplus.com | ChangeMe123! |

**⚠️ Change the default password immediately after first login!**

## 📁 Project Structure

```
kemdataplus/
├── client/                  # Frontend
│   ├── public/             # Main dashboard
│   │   ├── css/           # Stylesheets
│   │   ├── js/            # JavaScript
│   │   └── dashboard.html # Agent dashboard
│   ├── admin/             # Admin panel
│   │   └── dashboard.html # Admin dashboard
│   └── pages/             # Other pages
│       ├── login.html
│       ├── orders.html
│       └── wallet.html
│
├── server/                  # Backend
│   ├── src/
│   │   ├── controllers/   # Route handlers
│   │   ├── middleware/    # Auth, validation
│   │   ├── routes/        # API routes
│   │   └── index.js       # App entry
│   └── prisma/
│       ├── schema.prisma  # Database schema
│       └── seed.js        # Seed data
│
├── DEPLOYMENT.md           # Deployment guide
└── package.json
```

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL + Prisma ORM
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Security**: Helmet, CORS, Rate Limiting, JWT

## 📡 API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/login | User login |
| POST | /api/auth/register | User registration |
| GET | /api/auth/me | Get current user (admin) |

### Users
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/users/me | Get current user profile |
| PUT | /api/users/me | Update profile |
| GET | /api/users | List all users (admin) |

### Wallet
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/wallet/balance | Get wallet balance |
| POST | /api/wallet/deposit | Request deposit |
| POST | /api/wallet/transfer | Transfer funds |

### Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/orders | Get user orders |
| POST | /api/orders | Create new order |
| PUT | /api/orders/:id/status | Update order status |
| POST | /api/orders/:id/cancel | Cancel order |
| POST | /api/orders/:id/refund | Refund order (admin) |

### Bundles
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/bundles | Get all bundles |
| POST | /api/bundles | Create bundle (admin) |
| PUT | /api/bundles/:id | Update bundle (admin) |

## 🚢 Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for detailed deployment instructions:

- ✅ Render.com (Recommended)
- ✅ Railway.app
- ✅ DigitalOcean/VPS
- ✅ Vercel + Supabase

## 🔒 Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| DATABASE_URL | ✅ | PostgreSQL connection string |
| JWT_SECRET | ✅ | Secret for JWT tokens (32+ chars) |
| NODE_ENV | ✅ | `production` or `development` |
| PORT | ❌ | Server port (default: 3000) |

## 📄 License

ISC
