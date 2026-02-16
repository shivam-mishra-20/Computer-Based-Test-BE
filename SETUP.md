# Quick Setup Guide - Production-Ready Chat System

## 🚀 Installation

```bash
cd cbt-exam-be

# Install new dependencies
npm install ioredis@^5.4.1 @socket.io/redis-adapter@^8.3.0 express-rate-limit@^7.5.0 rate-limit-redis@^4.2.0

# Install types
npm install --save-dev @types/ioredis
```

## 📋 Environment Setup

Add to your `.env` file:

```env
# Redis (choose one option)
REDIS_URL=redis://localhost:6379                                       # Local
# REDIS_URL=redis://red-xxx.render.com:6379                           # Render (FREE)
# REDIS_URL=redis://default:pass@redis-12345.cloud.redislabs.com:6379 # Redis Cloud (FREE 30MB)

# Optional overrides
WORKER_PROCESSES=4          # Number of CPU cores to use (default: auto-detect)
MAX_CONNECTIONS=10000       # Max connections per server instance
CORS_ORIGIN=http://localhost:3000,http://localhost:8081
```

## 🐳 Quick Start with Docker  (Includes Redis)

```bash
# Start Redis + Backend
docker-compose up -d

# Scale to 4 instances
docker-compose up -d --scale backend=4

# View logs
docker-compose logs -f backend

# Stop
docker-compose down
```

## 🔧 Development

```bash
# Single process (development)
npm run dev

# Multi-core cluster (test horizontal scaling locally)
npm run dev:cluster
```

## 🚀 Production Deployment

### Option 1: Heroku/Render (Simplest)

```bash
# Build and start
npm start

# Uses default single process mode
# Redis URL from environment variable
```

### Option 2: PM2 (Recommended)

```bash
# Install PM2
npm install -g pm2

# Start with all CPU cores
pm2 start ecosystem.config.js --env production

# Enable auto-restart on server reboot
pm2 startup
pm2 save

# Management commands
pm2 logs        # View logs
pm2 monit       # Real-time monitoring
pm2 restart all # Restart all  processes
pm2 stop all    # Stop all processes
```

### Option 3: Node Cluster (Manual)

```bash
# Uses all CPU cores automatically
npm run start:cluster
```

## 🧪 Testing

### Load Test with curl:

```bash
# Health check
curl http://localhost:5000/api/health

# Expected response:
# {
#   "status": "healthy",
#   "connections": 5,
#   "uptime": 120.5,
#   "memory": {...}
# }
```

### Artillery Load Test:

```bash
npm install -g artillery

# Create test file
cat > load-test.yml << EOF
config:
  target: "http://localhost:5000"
  phases:
    - duration: 60
      arrivalRate: 10
scenarios:
  - name: "WebSocket connections"
    engine: socketio
    flow:
      -emit:
          channel: "join_doubt"
          data: "test-doubt-123"
      - think: 2
      - emit:
          channel: "typing"
          data:
            doubtId: "test-doubt-123"
            isTyping: true
EOF

# Run test
artillery run load-test.yml
```

## 📊 Capacity Estimates

| Setup | Users | Messages/sec | Monthly Cost |
|-------|-------|--------------|--------------|
| Free tier (Render  + Redis Cloud) | 100 | 50 | $0 |
| Single 2-core server | 500 | 200 | $12 |
| PM2 (4-core) | 2,000 | 800 | $24 |
| Docker (4 containers) | 5,000 | 2,000 | $40 |
| Kubernetes (10 pods) | 50,000+ | 10,000+ | $120+ |

## ⚙️ Configuration

### Rate Limits (in code, customizable):

- **Global API**: 1000 requests / 15 min per IP
- **Auth endpoints**: 10 attempts / 15 min
- **Messages**: 30 messages / minute per user
- **Uploads**: 50 uploads / hour per user
- **Socket messages**: 30 events / minute per socket

### Connection Limits:

- **Max connections per server**: 10,000
- **Max rooms per socket**: 50
- **Max payload size**: 1MB

## 🔒 Security Features Enabled

✅ JWT authentication on WebSocket  
✅ Redis-backed rate limiting  
✅ Connection limits per serve  r  
✅ Room limits per socket  
✅ Input validation on all events  
✅ Message payload size limits  
✅ CORS configuration  
✅ Helmet security headers  
✅ IP-based rate limiting

## 🐛 Troubleshooting

### Redis connection fails

```bash
# Check if Redis is running
redis-cli ping
# Should respond: PONG

# Test connection
node -e "const Redis = require('ioredis'); const client = new Redis(process.env.REDIS_URL); client.ping().then(() => console.log('OK')).catch(console.error);"
```

### Rate limit not working

- Ensure Redis URL is correct in `.env`
- Check Redis connection in server logs
- Verify `trust proxy` is enabled (required behind load balancers)

### Messages not syncing across servers

- All server instances must connect to the **same Redis instance**
- Check Redis adapter initialization log: `✅ Socket.IO Redis adapter initialized`
- Ensure Redis is not in cluster mode (Socket.IO adapter requires standard mode)

### High memory usage

- Check connection count: `curl http://localhost:5000/api/health`
- Restart workers: `pm2 restart all`
- Increase memory limit in PM2: `max_memory_restart: '1G'` (already in ecosystem.config.js)

## 📈 Monitoring

### PM2 Dashboard:

```bash pm2 monit  # Live monitoring
pm2 status  # Quick status
pm2 logs --lines 100  # Last 100 log lines
```

### Health Endpoint:

```bash
# Check server health
watch -n 5 'curl -s http://localhost:5000/api/health | jq'
```

## 🔄 Scaling Guide

**Scale UP (vertical)**:
- Increase server CPU/RAM
- Adjust `WORKER_PROCESSES` env var
- Upgrade Redis plan if needed

**Scale OUT (horizontal)**:
1. Deploy multiple server instances
2. Point all to same Redis instance
3. Add load balancer (Nginx/ALB)
4. Configure sticky sessions for WebSocket

**Kubernetes Auto-scaling**:
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: cbt-backend-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: cbt-backend
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## 📚 Additional Resources

- [PM2 Process Management](https://pm2.keymetrics.io/docs/usage/quick-start/)
- [Socket.IO Scaling](https://socket.io/docs/v4/using-multiple-nodes/)
- [Redis Best Practices](https://redis.io/docs/management/optimization/)
- [Express Rate Limiting](https://express-rate-limit.mintlify.app/overview)

## ✅ Production Checklist

Before going live:

- [ ] Redis URL configured
- [ ] CORS_ORIGIN set to your frontend URL
- [ ] JWT_SECRET changed from default
- [ ] Environment variables secured (not in git)
- [ ] SSL/TLS enabled (use Nginx/Cloudflare)
- [ ] PM2 or orchestration platform configured
- [ ] Monitoring/alerting setup  
- [ ] Log aggregation enabled
- [ ] Backup strategy for MongoDB
- [ ] Redis persistence enabled (if needed)
- [ ] Rate limits tuned for your use case
- [ ] Load testing completed

---

**Need help?** Check [SCALING_GUIDE.md](./SCALING_GUIDE.md) for detailed architecture explanation.
