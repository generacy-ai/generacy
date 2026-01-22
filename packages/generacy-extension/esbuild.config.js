const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function build() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
    plugins: [
      {
        name: 'watch-plugin',
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length === 0) {
              console.log('[watch] Build succeeded');
            }
          });
        },
      },
    ],
  });

  if (watch) {
    await ctx.watch();
    console.log('[watch] Watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
