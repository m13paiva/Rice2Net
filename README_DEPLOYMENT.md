# Rice2Net - Production Deployment and Operations Guide

Technical documentation for deployment, hosting, and systems maintenance.

---

## 1. System Architecture

The application is structured into three isolated tiers with local loopback communication:

```text
[ Client / Web Browser ]
           │ (HTTP :80)
           ▼
     ┌───────────┐
     │   Nginx   │ ── Static Web Server & Reverse Proxy (Port 80)
     └─────┬─────┘
           │ (Reverse Proxy /api/*)
           ▼
     ┌───────────┐
     │  Node.js  │ ── Express Middleware API managed by PM2 (Port 3000 at 127.0.0.1)
     └─────┬─────┘
           │ (Bolt :7687)
           ▼
     ┌───────────┐
     │   Neo4j   │ ── Graph Database (127.0.0.1:7687 with Authentication)
     └───────────┘
```

---

## 2. Prerequisites

- **Operating System:** Ubuntu Server 22.04 LTS or higher.
- **Runtime:** Node.js (v18.x or v20.x LTS) + npm.
- **Process Manager:** PM2 (`sudo npm install -g pm2`).
- **Web Server:** Nginx.
- **Database:** Neo4j Community / Enterprise 5.x.

---

## 3. Installation Steps

### 3.1. Database Setup (Neo4j)
1. Ensure Neo4j binds strictly to localhost in `/etc/neo4j/neo4j.conf`:
   ```properties
   server.bolt.listen_address=127.0.0.1:7687
   server.default_listen_address=127.0.0.1
   ```
2. Enable and start the service:
   ```bash
   sudo systemctl enable --now neo4j
   ```

### 3.2. Backend Configuration (API)
1. Install production dependencies:
   ```bash
   cd server/
   npm install --omit=dev
   ```
2. Create the environment configuration file:
   ```bash
   cp .env.example .env
   ```
3. Update `.env` with the production database credentials:
   ```properties
   PORT=3000
   NODE_ENV=production
   NEO4J_URI=bolt://127.0.0.1:7687
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=<PRODUCTION_PASSWORD>
   ```
4. Start and persist the application using PM2:
   ```bash
   pm2 start server.js --name "rice2net-api"
   pm2 save
   sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME
   ```

### 3.3. Web Server & Reverse Proxy (Nginx)
1. Copy the Nginx configuration template:
   ```bash
   sudo cp deploy/rice2net.conf /etc/nginx/sites-available/rice2net
   ```
   *(Ensure the `root` directive points to your actual installation path, e.g., `/var/www/Rice2Net`).*
2. Enable the site and restart Nginx:
   ```bash
   sudo ln -sf /etc/nginx/sites-available/rice2net /etc/nginx/sites-enabled/rice2net
   sudo rm -f /etc/nginx/sites-enabled/default
   sudo nginx -t && sudo systemctl restart nginx
   ```

---

## 4. Maintenance and Monitoring Commands

| Action | Command |
| :--- | :--- |
| **API Process Status** | `pm2 status` |
| **Live Resource Monitor** | `pm2 monit` |
| **API Real-Time Logs** | `pm2 logs rice2net-api` |
| **Restart Backend API** | `pm2 restart rice2net-api` |
| **Neo4j Status** | `sudo systemctl status neo4j` |
| **Restart Nginx** | `sudo systemctl restart nginx` |
| **Nginx Error Logs** | `sudo tail -f /var/log/nginx/error.log` |

---

## 5. Security Measures Implemented

- **Database Isolation:** Neo4j Bolt port is restricted to `127.0.0.1` and never exposed externally.
- **Defensive HTTP Headers:** `Helmet` integration preventing MIME-sniffing and clickjacking.
- **DoS Mitigation:** IP-based `express-rate-limit` (200 req/min for general endpoints; 50 req/min for `/api/network/init`).
- **Cypher Injection Prevention:** Fully parameterized Cypher queries with strict Regex validation (`/^[a-zA-Z0-9_\.\-]{2,64}$/`).
