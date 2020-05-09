module.exports = {
  apps: [
    {
      name: "swap-server",
      script: "index.js",
      watch: ["*.js"],
      interpreter: "node",
      env: {
        COMMON_VARIABLE: "true",
        NODE_OPTIONS: "--require ./.pnp.js"
      },
      env_production: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--require ./.pnp.js"
      }
    }
  ]
};
