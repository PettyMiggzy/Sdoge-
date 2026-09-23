// pm2 config for running the buy bot 24/7 on your own server.
//
//   cd bot && npm install -g pm2   # if you don't have it yet
//   cp .env.example .env && $EDITOR .env
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup        # survive a server reboot
//
// .cjs (not .js) because bot/package.json sets "type": "module" - pm2
// config files are conventionally CommonJS, and the .cjs extension forces
// that regardless of the package's own module type.
module.exports = {
  apps: [
    {
      name: 'sdoge-buy-bot',
      script: 'buy-bot.js',
      cwd: __dirname,
      // Loads bot/.env directly (Node 20.6+ native support - no dotenv
      // dependency needed). Real secrets (TELEGRAM_BOT_TOKEN) live only in
      // that gitignored file, never in this committed config.
      node_args: ['--env-file=.env'],
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      time: true,
    },
  ],
};
