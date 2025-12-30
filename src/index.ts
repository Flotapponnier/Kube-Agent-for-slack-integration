import { createServer } from 'node:http';
import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { config } from './config.ts';
import { registerHandlers } from './slack/handlers.ts';

console.log('Starting Kube-Bot...');

// Track connection state for health checks
let isConnected = false;
let lastActivityTime = Date.now();

// Create a custom SocketModeReceiver with stable connection settings
const socketModeReceiver = new SocketModeReceiver({
  appToken: config.SLACK_APP_TOKEN,
  clientOptions: {
    // Longer ping timeout to prevent premature disconnects (default is 5s, we use 30s)
    clientPingTimeout: 30000,
    // Longer server ping timeout (default is 30s, we use 120s)
    serverPingTimeout: 120000,
  },
  // Disable ping pong logging to reduce noise
  pingPongLoggingEnabled: false,
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

// Listen to Socket Mode client events for connection state tracking
const socketClient = socketModeReceiver.client;

socketClient.on('connected', () => {
  console.log('[Socket] Connected to Slack');
  isConnected = true;
  lastActivityTime = Date.now();
});

socketClient.on('disconnected', () => {
  console.log('[Socket] Disconnected from Slack');
  isConnected = false;
});

socketClient.on('reconnecting', () => {
  console.log('[Socket] Reconnecting to Slack...');
  isConnected = false;
});

socketClient.on('error', (error) => {
  console.error('[Socket] Error:', error);
});

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
  if (req.url === '/health' || req.url === '/healthz') {
    const now = Date.now();
    const idleTime = now - lastActivityTime;
    // Consider unhealthy if no activity for more than 5 minutes
    const isHealthy = isConnected && idleTime < 300000;
    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: isHealthy ? 'ok' : 'unhealthy',
        connected: isConnected,
        uptime: process.uptime(),
        idleSeconds: Math.floor(idleTime / 1000),
      }),
    );
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
    lastActivityTime = Date.now();
    console.log('Kube-Bot is running!');
    console.log(`   Model: ${config.OPENAI_MODEL}`);
    console.log(`   Log level: ${config.LOG_LEVEL}`);

    // Start health check server on port 3000
    healthServer.listen(3000, () => {
      console.log('   Health check: http://localhost:3000/health');
    });

    // Heartbeat to track that app is still responsive
    setInterval(() => {
      if (isConnected) {
        lastActivityTime = Date.now();
      }
    }, 60000); // Update activity every minute when connected
  } catch (error) {
    console.error('Failed to start Kube-Bot:', error);
    process.exit(1);
  }
})();
