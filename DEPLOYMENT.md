# KemDataplus - Deployment Guide

## Quick Deployment Options

### Option 1: Render.com (Recommended - Free Tier Available)

1. **Create Account**: Sign up at [render.com](https://render.com)

2. **Create PostgreSQL Database**:
   - Dashboard → New → PostgreSQL
   - Name: `kemdataplus-db`
   - Copy the **Internal Database URL**

3. **Deploy Web Service**:
   - Dashboard → New → Web Service
   - Connect your GitHub repository
   - Settings:
     - **Name**: `kemdataplus`
     - **Root Directory**: `server`
     - **Build Command**: `npm install && npx prisma generate && npx prisma migrate deploy`
     - **Start Command**: `npm start`
   
4. **Environment Variables** (Add these):
   ```
   DATABASE_URL=<your-internal-database-url>
   JWT_SECRET=<generate-a-64-char-random-string>
   JWT_EXPIRES_IN=7d
   NODE_ENV=production
   ADMIN_EMAIL=admin@kemdataplus.com
   ADMIN_PASSWORD=YourSecurePassword123!
   ```

5. **Run Database Seed** (First time only):
   - Go to Shell tab in Render dashboard
   - Run: `node prisma/seed.js`

---

### Option 2: Railway.app

1. **Create Account**: Sign up at [railway.app](https://railway.app)

2. **New Project** → Deploy from GitHub

3. **Add PostgreSQL**:
   - Click "New" → "Database" → "PostgreSQL"
   - Copy the `DATABASE_URL` from Variables tab

4. **Configure Variables**:
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   JWT_SECRET=<your-secret>
   NODE_ENV=production
   ```

5. **Settings**:
   - Root Directory: `server`
   - Build: `npm install && npx prisma generate`
   - Start: `npm start`

---

### Option 3: Vercel + Supabase

1. **Supabase Database**:
   - Create project at [supabase.com](https://supabase.com)
   - Go to Settings → Database → Connection string
   - Copy the URI (use Transaction pooler for serverless)

2. **Deploy to Vercel**:
   - Import GitHub repo
   - Root Directory: `server`
   - Add environment variables

---

### Option 4: DigitalOcean/VPS

```bash
# On your VPS (Ubuntu 22.04)

# 1. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install PostgreSQL
sudo apt install postgresql postgresql-contrib

# 3. Setup database
sudo -u postgres psql
CREATE DATABASE kemdataplus;
CREATE USER kduser WITH ENCRYPTED PASSWORD 'yourpassword';
GRANT ALL PRIVILEGES ON DATABASE kemdataplus TO kduser;
\q

# 4. Clone and setup
git clone <your-repo-url> /var/www/kemdataplus
cd /var/www/kemdataplus/server
npm install

# 5. Create .env file
cp .env.example .env
nano .env  # Edit with your values

# 6. Setup database
npx prisma generate
npx prisma migrate deploy
node prisma/seed.js

# 7. Install PM2 for process management
sudo npm install -g pm2
pm2 start src/index.js --name kemdataplus
pm2 save
pm2 startup

# 8. Setup Nginx reverse proxy
sudo apt install nginx
sudo nano /etc/nginx/sites-available/kemdataplus
```

Nginx config:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable and setup SSL
sudo ln -s /etc/nginx/sites-available/kemdataplus /etc/nginx/sites-enabled/
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | Secret for JWT tokens (min 32 chars) |
| `JWT_EXPIRES_IN` | ❌ | Token expiry (default: 7d) |
| `NODE_ENV` | ✅ | `production` for live |
| `PORT` | ❌ | Server port (default: 3000) |
| `ADMIN_EMAIL` | ❌ | Initial admin email |
| `ADMIN_PASSWORD` | ❌ | Initial admin password |
| `FRONTEND_URL` | ❌ | For CORS (if separate frontend) |

---

## Generate Secure JWT Secret

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## Post-Deployment Checklist

- [ ] Change default admin password immediately
- [ ] Verify database connection
- [ ] Test login functionality
- [ ] Check order creation works
- [ ] Verify wallet operations
- [ ] Test admin panel access
- [ ] Setup domain and SSL
- [ ] Configure backup strategy

---

## Monitoring

**Health Check Endpoint**: `GET /api/health`

Response:
```json
{
  "status": "ok",
  "timestamp": "2026-01-03T12:00:00.000Z",
  "service": "KemDataplus API",
  "environment": "production"
}
```

---

## Troubleshooting

### Database Connection Issues
- Verify DATABASE_URL is correct
- Check if database exists and user has permissions
- For cloud DBs, check if IP is whitelisted

### JWT Errors
- Ensure JWT_SECRET is set and consistent
- Check token expiry settings

### CORS Issues
- Verify FRONTEND_URL matches your domain
- Check browser console for specific errors

### Static Files Not Loading
- Ensure client folder is deployed alongside server
- Check file paths in deployment logs
