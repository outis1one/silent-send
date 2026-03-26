/**
 * web-ext configuration for Firefox extension development.
 *
 * For signing, you need a Mozilla API key and secret.
 * Get them at: https://addons.mozilla.org/developers/addon/api/key/
 *
 * Set these environment variables before running `npm run sign:firefox`:
 *   export WEB_EXT_API_KEY="user:12345:678"
 *   export WEB_EXT_API_SECRET="your-secret-here"
 *
 * Or create a .env file (git-ignored) and source it:
 *   source .env && npm run sign:firefox
 */

module.exports = {
  sourceDir: 'dist/firefox',
  artifactsDir: 'dist/firefox-signed',
  ignoreFiles: [
    'generate-icons.html',
  ],
  build: {
    overwriteDest: true,
  },
  run: {
    startUrl: ['https://claude.ai/'],
    // Firefox Developer Edition or Nightly recommended for MV3
    // firefox: '/path/to/firefox-developer-edition',
  },
  sign: {
    channel: 'unlisted',
    // API credentials come from environment variables:
    //   WEB_EXT_API_KEY and WEB_EXT_API_SECRET
  },
};
