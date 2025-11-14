import * as path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runBasicE2ETest() {
  console.log('Running basic E2E test...');

  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const outDir = path.join(appPath, 'dist');

  try {
    // Build the app package using Vite API
    await build({
      root: appPath,
      build: {
        outDir,
        lib: {
          entry: path.join(appPath, 'index.js'),
          name: 'App',
          fileName: 'app',
          formats: ['es'],
        },
        rollupOptions: {
          // Don't bundle dependencies, treat them as external
          external: ['dep-a', 'dep-b', 'dep-c'],
        },
      },
      logLevel: 'info',
    });

    console.log('✅ Build completed successfully!');
    console.log(`Output directory: ${outDir}`);
  } catch (error) {
    console.error('❌ Build failed:', error);
    throw error;
  }
}

// Run the test
runBasicE2ETest().catch((error) => {
  console.error('E2E test failed:', error);
  process.exit(1);
});
