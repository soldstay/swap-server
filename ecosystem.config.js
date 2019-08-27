module.exports = {
  apps: [
    {
      name: "swap-server",
      script: "index.js",
      watch: ["*.js"],
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
