import { App, LogLevel } from '@slack/bolt';
import { config } from './config.ts';
import { registerHandlers } from './slack/handlers.ts';

console.log('Starting Kube-Bot...');
console.log('Slack SDK version: @slack/bolt ^3.17.1');

// Initialize Slack Bolt app in Socket Mode
// Note: If you see constant reconnection loops, regenerate your App-Level Token
// in Slack API settings with the 'connections:write' scope
const app = new App({
  token: config.SLACK_BOT_TOKEN,
  appToken: config.SLACK_APP_TOKEN,
  socketMode: true,
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
  } catch (error) {
    console.error('Failed to start Kube-Bot:', error);
    process.exit(1);
  }
})();
