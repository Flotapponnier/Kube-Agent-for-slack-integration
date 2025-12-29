import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { createServer } from 'node:http';
import { config } from './config.ts';
import { registerHandlers } from './slack/handlers.ts';

console.log('Starting Kube-Bot...');

// Track connection state for health checks
let isConnected = false;
let lastPingTime = Date.now();

// Create a custom SocketModeReceiver with extended timeouts
const socketModeReceiver = new SocketModeReceiver({
  appToken: config.SLACK_APP_TOKEN,
  clientOptions: {
    clientPingTimeout: 30000,
    serverPingTimeout: 60000,
  },
  logLevel: config.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

// Initialize Slack Bolt app with custom receiver
const app = new App({
  token: config.SLACK_BOT_TOKEN,
  receiver: socketModeReceiver,
  logLevel: config.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

// Register event handlers
registerHandlers(app);

// Global error handler to prevent crashes
app.error(async (error) => {
  console.error('Slack app error:', error);
});

// Handle unhandled rejections and exceptions to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Handle process signals gracefully
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  await app.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  await app.stop();
  process.exit(0);
});

// Health check HTTP server for Kubernetes liveness probe
const healthServer = createServer((req, res) => {
  lastPingTime = Date.now();
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected: isConnected, uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// Start the app
(async () => {
  try {
    await app.start();
    isConnected = true;
    console.log('Kube-Bot is running!');
    console.log(`   Model: ${config.OPENAI_MODEL}`);
    console.log(`   Log level: ${config.LOG_LEVEL}`);
    
    // Start health check server on port 3000
    healthServer.listen(3000, () => {
      console.log('   Health check: http://localhost:3000/health');
    });
  } catch (error) {
    console.error('Failed to start Kube-Bot:', error);
    process.exit(1);
  }
})();
