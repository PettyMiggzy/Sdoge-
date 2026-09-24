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
      kill_timeout: 10000,
      max_memory_restart: '350M',
    },
  ],
};
