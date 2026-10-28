#!/usr/bin/env node
// Dependencies are loaded behind a check, so a git checkout without `npm install` says so.
try {
  const { main } = await import('../src/cli.js');
  await main(process.argv);
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !/Cannot find package/.test(err.message)) throw err;
  const dir = new URL('..', import.meta.url).pathname;
  console.error(`agentmgr: dependencies are missing (${err.message.match(/'([^']+)'/)?.[1] ?? 'a package'}).\nRun \`npm install\` in ${dir} and try again.`);
  process.exit(1);
}
