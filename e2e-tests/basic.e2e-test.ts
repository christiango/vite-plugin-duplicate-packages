import { test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('basic e2e - vite should bundle app package', async () => {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const outDir = path.join(appPath, 'dist');

  // Clean up dist directory if it exists
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true });
  }

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

  // Assert that the output file was created
  const outputFile = path.join(outDir, 'app.js');
  assert.ok(fs.existsSync(outputFile), 'Output file should exist');

  // Assert that the output file is not empty
  const fileStats = fs.statSync(outputFile);
  assert.ok(fileStats.size > 0, 'Output file should not be empty');

  console.log(`✅ Output file created: ${outputFile} (${fileStats.size} bytes)`);
});
