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

  // Read the bundled output and inspect dependency bundling
  const bundledContent = fs.readFileSync(outputFile, 'utf-8');

  // Count occurrences of each dependency using their greet strings
  const countOccurrences = (content: string, searchString: string): number => {
    const matches = content.match(new RegExp(searchString, 'g'));
    return matches ? matches.length : 0;
  };

  // Verify dep-d: should appear twice (v1 from dep-a and v1 from dep-b)
  const depDV1Count = countOccurrences(bundledContent, 'Hello from dep-d v1');
  assert.strictEqual(
    depDV1Count,
    2,
    `dep-d v1 should be bundled twice (once from dep-a, once from dep-b), found ${depDV1Count}`
  );

  // Verify dep-a: should appear twice (v2 directly and v1 nested in dep-b)
  const depAV2Count = countOccurrences(bundledContent, 'Hello from dep-a v2');
  const depAV1Count = countOccurrences(bundledContent, 'Hello from dep-a v1');
  assert.strictEqual(depAV2Count, 1, `dep-a v2 should be bundled once, found ${depAV2Count}`);
  assert.strictEqual(depAV1Count, 1, `dep-a v1 should be bundled once (from dep-b), found ${depAV1Count}`);

  // Verify dep-b: should appear once
  const depBCount = countOccurrences(bundledContent, 'Hello from dep-b v1');
  assert.strictEqual(depBCount, 1, `dep-b v1 should be bundled once, found ${depBCount}`);

  // Verify dep-c: should appear once (hoisted to root)
  const depCCount = countOccurrences(bundledContent, 'Hello from dep-c v1');
  assert.strictEqual(depCCount, 1, `dep-c v1 should be bundled once, found ${depCCount}`);
});
