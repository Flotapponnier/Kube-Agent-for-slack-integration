import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { config } from './config.ts';
import { registerHandlers } from './slack/handlers.ts';

console.log('Starting Kube-Bot...');

// Create a custom SocketModeReceiver with extended timeouts
// This prevents the connection from being dropped due to slow ping responses
const socketModeReceiver = new SocketModeReceiver({
  appToken: config.SLACK_APP_TOKEN,
  clientOptions: {
    // Increase client ping timeout (default: 5000ms)
    // Time to wait for a pong response from Slack
    clientPingTimeout: 30000,
    // Increase server ping timeout (default: 30000ms)  
    // Time to wait between server pings before considering connection dead
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

// Start the app
(async () => {
  try {
    await app.start();
    console.log('Kube-Bot is running!');
    console.log(`   Model: ${config.OPENAI_MODEL}`);
    console.log(`   Log level: ${config.LOG_LEVEL}`);
    console.log('   Ping timeouts: client=30s, server=60s');
  } catch (error) {
    console.error('Failed to start Kube-Bot:', error);
    process.exit(1);
  }
})();
