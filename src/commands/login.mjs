export function runLogin() {
  console.log('Open https://ampcode.com/install to create or retrieve an access token.');
  console.log(`Then run: export AMP_API_KEY=${process.env.AMP_API_KEY ? '<already-set>' : '<token>'}`);
}
