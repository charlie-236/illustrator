module.exports = {
  apps: [
    {
      name: 'illustrator',
      script: 'node_modules/.bin/next',
      args: 'start -p 3001',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
