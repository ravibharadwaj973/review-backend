// PM2 process file for running the API on a server (AWS EC2, any VPS).
//   pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'starling-api',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1, // the review-sync scheduler runs in this process; keep 1 unless you split out the worker
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', RUN_WORKER: 'true' },
      max_memory_restart: '600M',
      time: true,
      out_file: 'logs/api.out.log',
      error_file: 'logs/api.err.log',
    },
  ],
};
