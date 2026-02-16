/**
 * PM2 Configuration for Production Deployment
 * 
 * Usage:
 * - Install: npm install -g pm2
 * - Start: pm2 start ecosystem.config.js --env production
 * - Monitor: pm2 monit
 * - Logs: pm2 logs
 * - Restart: pm2 restart ecosystem.config.js
 * - Stop: pm2 stop ecosystem.config.js
 * 
 * Auto-restart on server reboot:
 * - pm2 startup
 * - pm2 save
 */

module.exports = {
  apps: [
    {
      name: 'cbt-exam-backend',
      script: './dist/server.js',
      instances: 'max', // Uses all CPU cores
      exec_mode: 'cluster', // Cluster mode for load balancing
      watch: false,
      max_memory_restart: '1G', // Restart if memory exceeds 1GB
      env: {
        NODE_ENV: 'development',
        PORT: 5000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
      
      // Error handling
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 3000,
      
      // Health monitoring
      instance_var: 'INSTANCE_ID',
    }
  ],
};
