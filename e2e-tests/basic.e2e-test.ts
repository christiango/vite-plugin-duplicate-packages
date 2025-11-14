import { test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import { duplicatePackagesPlugin } from '../lib/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ExpectedDuplicationCounts {
  depDV1: number;
  depAV2: number;
  depAV1: number;
  depBV1: number;
  depCV1: number;
}

interface BuildAndVerifyOptions {
  outDirName: string;
  plugins: Plugin[];
  expectedCounts?: ExpectedDuplicationCounts;
  entrypoint: string;
}

async function buildAndVerify({ outDirName, plugins, expectedCounts, entrypoint }: BuildAndVerifyOptions) {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const outDir = path.join(appPath, outDirName);

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
        entry: path.join(appPath, entrypoint),
        name: 'App',
        fileName: 'app',
        formats: ['es'],
      },
    },
    plugins,
    logLevel: 'info',
  });

  // Assert that the output file was created
  const outputFile = path.join(outDir, 'app.js');
  assert.ok(fs.existsSync(outputFile), 'Output file should exist');

  // Assert that the output file is not empty
  const fileStats = fs.statSync(outputFile);
  assert.ok(fileStats.size > 0, 'Output file should not be empty');

  // Only verify counts if expectedCounts is provided
  if (!expectedCounts) {
    return;
  }

  // Read the bundled output and inspect dependency bundling
  const bundledContent = fs.readFileSync(outputFile, 'utf-8');

  // Count occurrences of each dependency using their greet strings
  const countOccurrences = (content: string, searchString: string): number => {
    const matches = content.match(new RegExp(searchString, 'g'));
    return matches ? matches.length : 0;
  };

  // Verify dep-d
  const depDV1Count = countOccurrences(bundledContent, 'Hello from dep-d v1');
  assert.strictEqual(
    depDV1Count,
    expectedCounts.depDV1,
    `dep-d v1 should be bundled ${expectedCounts.depDV1} time(s), found ${depDV1Count}`,
  );

  // Verify dep-a v2
  const depAV2Count = countOccurrences(bundledContent, 'Hello from dep-a v2');
  assert.strictEqual(
    depAV2Count,
    expectedCounts.depAV2,
    `dep-a v2 should be bundled ${expectedCounts.depAV2} time(s), found ${depAV2Count}`,
  );

  // Verify dep-a v1
  const depAV1Count = countOccurrences(bundledContent, 'Hello from dep-a v1');
  assert.strictEqual(
    depAV1Count,
    expectedCounts.depAV1,
    `dep-a v1 should be bundled ${expectedCounts.depAV1} time(s), found ${depAV1Count}`,
  );

  // Verify dep-b
  const depBCount = countOccurrences(bundledContent, 'Hello from dep-b v1');
  assert.strictEqual(
    depBCount,
    expectedCounts.depBV1,
    `dep-b v1 should be bundled ${expectedCounts.depBV1} time(s), found ${depBCount}`,
  );

  // Verify dep-c
  const depCCount = countOccurrences(bundledContent, 'Hello from dep-c v1');
  assert.strictEqual(
    depCCount,
    expectedCounts.depCV1,
    `dep-c v1 should be bundled ${expectedCounts.depCV1} time(s), found ${depCCount}`,
  );
}

test('e2e test 1 - no plugin: should bundle with duplicates', async () => {
  await buildAndVerify({
    outDirName: 'dist-test1',
    plugins: [],
    expectedCounts: {
      depDV1: 2, // duplicated from dep-a and dep-b
      depAV2: 1,
      depAV1: 1,
      depBV1: 1,
      depCV1: 1,
    },
    entrypoint: 'withDuplicates.js',
  });
});

test('e2e test 2 - plugin without deduplicateDoppelgangers: should bundle with duplicates', async () => {
  await buildAndVerify({
    outDirName: 'dist-test2',
    plugins: [
      duplicatePackagesPlugin({
        exceptions: {
          'dep-a': { maxAllowedVersionCount: 2 },
        },
      }),
    ],
    expectedCounts: {
      depDV1: 2, // still duplicated
      depAV2: 1,
      depAV1: 1,
      depBV1: 1,
      depCV1: 1,
    },
    entrypoint: 'withDuplicates.js',
  });
});

test('e2e test 3 - plugin with deduplicateDoppelgangers: should deduplicate dep-d', async () => {
  await buildAndVerify({
    outDirName: 'dist-test3',
    plugins: [
      duplicatePackagesPlugin({
        deduplicateDoppelgangers: true,
        exceptions: {
          'dep-a': { maxAllowedVersionCount: 2 },
        },
      }),
    ],
    expectedCounts: {
      depDV1: 1, // deduplicated!
      depAV2: 1,
      depAV1: 1,
      depBV1: 1,
      depCV1: 1,
    },
    entrypoint: 'withDuplicates.js',
  });
});

test('e2e test 4 - plugin without exceptions: should throw error for duplicate packages', async () => {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const outDir = path.join(appPath, 'dist-test4');

  // Clean up dist directory if it exists
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true });
  }

  await assert.rejects(
    async () => {
      await build({
        root: appPath,
        build: {
          outDir,
          lib: {
            entry: path.join(appPath, 'withDuplicates.js'),
            name: 'App',
            fileName: 'app',
            formats: ['es'],
          },
        },
        plugins: [duplicatePackagesPlugin()],
        logLevel: 'error',
      });
    },
    (error: Error) => {
      const expectedError = `Duplicate packages detected in bundle:

  • dep-a: 2.0.0, 1.0.0

Multiple versions of the same package can cause runtime errors and increase bundle size.`;
      assert.ok(
        error.message.includes(expectedError),
        `Error message should contain expected error. Got: ${error.message}`,
      );
      return true;
    },
    'Should throw an error when duplicates are detected without exceptions',
  );
});
