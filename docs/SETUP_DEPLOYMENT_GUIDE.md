# KemPlus - Complete Setup & Deployment Guide

## Quick Start (Local Development)

### Prerequisites
- Node.js 18+
- PostgreSQL 13+
- Redis 6+ (optional but recommended)
- npm or yarn

### Step 1: Database Setup

```bash
# Create PostgreSQL database
createdb kemplus_db

# Set a secure password for postgres user
psql -U postgres -c "ALTER USER postgres WITH PASSWORD 'your_secure_password';"
```

### Step 2: Backend Setup

```bash
cd backend

# Install dependencies
npm install

# Copy and configure environment file
cp .env.example .env

# Edit .env with your database credentials
# DATABASE_URL="postgresql://postgres:password@localhost:5432/kemplus_db"
```

### Step 3: Database Migration & Seeding

```bash
# Run migrations (creates all tables)
npm run prisma:migrate

# Seed database (creates admin, roles, packages, pricing)
npm run seed

# Optional: Open Prisma Studio to view data
npm run prisma:studio  # Accessible at http://localhost:5555
```

### Step 4: Start Backend

```bash
# Development mode (with auto-restart)
npm run dev

# Production mode
npm start
```

Backend will be running at: **http://localhost:5000**

### Step 5: Admin Dashboard Setup

```bash
cd backend/admin-dashboard

# Install dependencies
npm install

# Create .env file
echo "REACT_APP_API_URL=http://localhost:5000/api" > .env

# Start development server
npm start
```

Admin Dashboard will be running at: **http://localhost:3000**

### Step 6: Frontend Integration

```bash
# Copy API integration file
cp js/api.js /path/to/your/frontend/

# Edit your login.html to:
# 1. Include <script src="js/api.js"></script>
# 2. Replace form handling with kemApi.login()
# 3. Handle token storage & user redirect
```

See `js/INTEGRATION_GUIDE.md` for detailed integration examples.

---

## Default Credentials

**Admin Panel:**
- Email: `admin@kemplus.com`
- Password: `SecureAdminPassword123!`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Client Browser                            │
│  ┌──────────────────┐        ┌──────────────────────────┐   │
│  │  Frontend App    │        │  Admin Dashboard (React)  │   │
│  │  (HTML/JS)       │        │                          │   │
│  └────────┬─────────┘        └──────────┬───────────────┘   │
│           │                             │                     │
└───────────┼─────────────────────────────┼─────────────────────┘
            │      HTTPS/REST API         │
            │  (Axios/Fetch)              │
            │                             │
┌───────────┼──────────────────────────────┼──────────────────────┐
│           ↓                              ↓                      │
│  ┌─────────────────────────────────────────────────────┐       │
│  │        Express.js Backend (Node.js)                 │       │
│  │  ┌──────────────────────────────────────────────┐  │       │
│  │  │  Routes & Controllers                         │  │       │
│  │  │  • Auth (login, register, refresh)           │  │       │
│  │  │  • Wallets (balance, transactions)           │  │       │
│  │  │  • Orders (create, status, refund)           │  │       │
│  │  │  • MoMo Claims (initiate, submit, approve)   │  │       │
│  │  │  • Admin (users, pricing, dashboard)         │  │       │
│  │  └──────────────────────────────────────────────┘  │       │
│  │  ┌──────────────────────────────────────────────┐  │       │
│  │  │  Services & Business Logic                    │  │       │
│  │  │  • AuthService                               │  │       │
│  │  │  • WalletService (ledger-based)              │  │       │
│  │  │  • OrderService                              │  │       │
│  │  │  • PricingService (role-based)               │  │       │
│  │  │  • MoMoClaimService (fraud protection)       │  │       │
│  │  └──────────────────────────────────────────────┘  │       │
│  │  ┌──────────────────────────────────────────────┐  │       │
│  │  │  Middleware                                   │  │       │
│  │  │  • Auth (JWT validation)                      │  │       │
│  │  │  • Role Check (RBAC)                          │  │       │
│  │  │  • Rate Limiting                              │  │       │
│  │  │  • Request Validation (Joi)                   │  │       │
│  │  └──────────────────────────────────────────────┘  │       │
│  └─────────┬──────────────────────────┬────────────────┘       │
│            │                          │                        │
└────────────┼──────────────────────────┼────────────────────────┘
             │                          │
        ┌────┴────┐                ┌────┴────┐
        ↓         ↓                ↓         ↓
    PostgreSQL  Redis         Prisma    JWT
    Database    Cache         ORM       Auth
```

---

## API Security

### Authentication Flow

```
1. User submits credentials
   POST /api/auth/login
   { email, password }

2. Server validates & returns tokens
   { accessToken, refreshToken, user }

3. Client stores tokens in localStorage
   localStorage.setItem('authToken', accessToken)

4. Client includes token in headers for all requests
   Authorization: Bearer <accessToken>

5. Server validates token on each request
   via authMiddleware

6. When accessToken expires (15min):
   Client requests refresh
   POST /api/auth/refresh
   
7. Server returns new accessToken
   if refreshToken is still valid (7 days)

8. If refreshToken expired:
   Redirect user to login
```

### Rate Limiting

- Login attempts: **5 per 15 minutes**
- API requests: **100 per 1 minute**
- Account lock: **30 minutes after 5 failed attempts**

### Password Security

- Minimum 8 characters
- Hashed with bcrypt (10 salt rounds)
- Never stored in plaintext
- Never transmitted in logs

---

## Database Schema Highlights

### Immutable Ledger (WalletTransaction)
- Every wallet change creates an entry
- Never deleted or modified
- Stores: balance before/after, type, amount, reference
- Perfect for audit trails

### Role-Based Pricing (RolePricing)
- Admin sets custom prices per role per package
- Frontend cannot override prices
- Prices enforced at backend validation
- All changes logged in audit_logs

### MoMo Fraud Detection
- Reference code must be unique
- Automatic expiration (48 hours)
- Amount verification
- Admin notes for investigation

### Audit Logs (AuditLog)
- Every admin action logged
- Target user tracking
- IP & user agent recording
- JSON diff of changes
- Immutable (never deleted)

---

## Environment Configuration

### Development (.env)

```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/kemplus_db"
REDIS_URL="redis://localhost:6379"
JWT_ACCESS_SECRET="dev-secret-change-in-production"
JWT_REFRESH_SECRET="dev-refresh-secret"
PORT=5000
NODE_ENV="development"
FRONTEND_URL="http://localhost:3000"
ADMIN_URL="http://localhost:3001"
```

### Production (.env)

```env
DATABASE_URL="postgresql://user:password@prod-db:5432/kemplus_db"
REDIS_URL="redis://prod-redis:6379"
JWT_ACCESS_SECRET="generate-random-string-min-32-chars"
JWT_REFRESH_SECRET="generate-random-string-min-32-chars"
PORT=5000
NODE_ENV="production"
FRONTEND_URL="https://your-frontend.com"
ADMIN_URL="https://admin.your-domain.com"
ADMIN_EMAIL="admin@your-domain.com"
ADMIN_PASSWORD="generate-secure-password"
MOMO_OFFICIAL_NUMBER="+233-actual-momo-number"
```

### Generate Secure Secrets

```bash
# Generate random secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Testing the System

### 1. Test User Registration

```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@kemplus.com",
    "phone": "+233200000099",
    "firstName": "Test",
    "lastName": "User",
    "password": "TestPassword123!"
  }'
```

### 2. Test Login

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@kemplus.com",
    "password": "TestPassword123!"
  }'
```

**Response:**
```json
{
  "user": {
    "id": "uuid",
    "email": "test@kemplus.com",
    "firstName": "Test",
    "role": "AGENT"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

### 3. Test Wallet Balance (with token)

```bash
TOKEN="your_access_token_here"

curl -X GET http://localhost:5000/api/wallets/balance \
  -H "Authorization: Bearer $TOKEN"
```

### 4. Test Admin Login

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@kemplus.com",
    "password": "SecureAdminPassword123!"
  }'
```

### 5. Test Admin Endpoints (with admin token)

```bash
ADMIN_TOKEN="admin_access_token_here"

# Get all users
curl -X GET http://localhost:5000/api/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Get dashboard stats
curl -X GET http://localhost:5000/api/admin/dashboard/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# View audit logs
curl -X GET http://localhost:5000/api/admin/audit-logs \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Troubleshooting

### Issue: "Cannot connect to PostgreSQL"
**Solution:**
```bash
# Check if PostgreSQL is running
psql -U postgres -c "SELECT version();"

# Verify DATABASE_URL in .env
# Format: postgresql://user:password@host:port/database
```

### Issue: "Redis connection failed"
**Solution:**
```bash
# Check if Redis is running
redis-cli ping  # Should return PONG

# If not installed:
# macOS: brew install redis
# Ubuntu: sudo apt-get install redis-server
# Windows: Use Redis Docker image
```

### Issue: "Port 5000 already in use"
**Solution:**
```bash
# Find process using port 5000
lsof -i :5000

# Kill process
kill -9 <PID>

# Or use different port
PORT=5001 npm start
```

### Issue: "Prisma migration errors"
**Solution:**
```bash
# Reset database (WARNING: deletes all data)
npm run prisma:migrate -- --name init --create-only

# Then run migration
npm run prisma:migrate

# Then seed again
npm run seed
```

---

## Monitoring & Logs

### Backend Logs
- **File**: `error.log`, `combined.log`
- **Format**: JSON with timestamp
- **Include**: Request details, errors, stack traces

### Check Health
```bash
curl http://localhost:5000/api/health
# Response: { "status": "OK", "timestamp": "2024-01-01T00:00:00Z" }
```

### View Real-time Logs
```bash
tail -f combined.log
```

---

## Scaling Considerations

### Session Storage
Currently uses in-memory (no scaling across servers).
For production, use Redis:

```javascript
// Already configured in src/config/redis.js
```

### Database Connection Pool
Configured via Prisma with:
- Min connections: 2
- Max connections: 10

### Load Balancing
Use Nginx or HAProxy with sticky sessions for JWT.

### Caching Strategy
Implement Redis caching for:
- Frequently accessed pricing
- User role information
- Package lists

---

## Backup & Recovery

### Database Backup
```bash
pg_dump kemplus_db > backup.sql

# Restore
psql kemplus_db < backup.sql
```

### Automated Backups
```bash
# Create cron job for daily backups
0 2 * * * pg_dump kemplus_db | gzip > /backups/db-$(date +\%Y\%m\%d).sql.gz
```

---

## Support Resources

- **Backend Documentation**: `backend/README.md`
- **Admin Dashboard**: `backend/admin-dashboard/README.md`
- **Frontend Integration**: `js/INTEGRATION_GUIDE.md`
- **API Validation**: Check Joi schemas in routes

## Next Steps

1. ✅ Backend running on port 5000
2. ✅ Database populated with seed data
3. ✅ Admin dashboard on port 3000
4. ✅ Frontend integration via api.js
5. Test complete user flow:
   - Register user
   - Login user
   - Create order
   - Submit MoMo claim
   - Admin approval
6. Deploy to production
7. Configure SSL/TLS
8. Set up monitoring & alerts
9. Regular database backups
10. Plan scaling strategy

---

**Production Checklist:**
- [ ] Change all default passwords
- [ ] Generate secure JWT secrets
- [ ] Enable HTTPS/SSL
- [ ] Configure firewall rules
- [ ] Set up monitoring & alerting
- [ ] Configure automated backups
- [ ] Enable rate limiting
- [ ] Set up CDN for assets
- [ ] Configure email notifications
- [ ] Test disaster recovery plan
