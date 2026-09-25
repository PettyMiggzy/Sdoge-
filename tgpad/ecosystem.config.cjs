// pm2 process file: `pm2 start ecosystem.config.cjs && pm2 save`.
// .cjs because package.json is "type": "module".
module.exports = {
  apps: [
    {
      name: 'sdoge-tgpad',
      script: 'src/index.js',
      node_args: ['--env-file=.env'],
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      // On SIGINT the bot stops taking new work and waits for transactions
      // already sent (a receipt wait can take up to 120 s, see txTimeoutSec)
      // before it saves and exits; anything still unconfirmed is saved by hash
      // and checked after the restart. pm2 must not SIGKILL it before that.
      kill_timeout: 150000,
      max_memory_restart: '350M',
    },
  ],
};
