import { App, LogLevel } from '@slack/bolt';
import { config } from './config.ts';
import { registerHandlers } from './slack/handlers.ts';

console.log('🤖 Starting Kube-Bot...');

// Initialize Slack Bolt app in Socket Mode
const app = new App({
  token: config.SLACK_BOT_TOKEN,
  appToken: config.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: config.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

// Register event handlers
registerHandlers(app);

// Start the app
(async () => {
  await app.start();
  console.log('⚡️ Kube-Bot is running!');
  console.log(`   Model: ${config.OPENAI_MODEL}`);
  console.log(`   Log level: ${config.LOG_LEVEL}`);
})();
