import { test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, createBuilder } from 'vite';
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

test('no plugin: should bundle with duplicates', async () => {
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

test('plugin without deduplicateDoppelgangers: should bundle with duplicates', async () => {
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

test('plugin with deduplicateDoppelgangers: should deduplicate dep-d', async () => {
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

test('plugin without exceptions: should throw error for duplicate packages', async () => {
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
      const expectedError = `Duplicate packages detected in bundle (compilation: client):

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

test('plugin with noDuplicateViolations: should build successfully with no duplicates', async () => {
  await buildAndVerify({
    outDirName: 'dist-test5',
    plugins: [duplicatePackagesPlugin()],
    expectedCounts: {
      depDV1: 0,
      depAV2: 0,
      depAV1: 0,
      depBV1: 0,
      depCV1: 1,
    },
    entrypoint: 'noDuplicateViolations.js',
  });
});

test('plugin with unused exception: should throw error for unused exception', async () => {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const outDir = path.join(appPath, 'dist-test6');

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
            entry: path.join(appPath, 'noDuplicateViolations.js'),
            name: 'App',
            fileName: 'app',
            formats: ['es'],
          },
        },
        plugins: [
          duplicatePackagesPlugin({
            exceptions: {
              'dep-2': { maxAllowedVersionCount: 2 },
            },
          }),
        ],
        logLevel: 'error',
      });
    },
    (error: Error) => {
      const expectedError = `Unused duplicate package exceptions (compilation: client):

  • dep-2

These duplicate package exceptions are not used. Please remove them from your configuration to vite-plugin-duplicate-packages.`;
      assert.ok(
        error.message.includes(expectedError),
        `Error message should contain expected error. Got: ${error.message}`,
      );
      return true;
    },
    'Should throw an error when exception is unused',
  );
});

test('plugin with duplicate and unused exception: should throw combined error', async () => {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const outDir = path.join(appPath, 'dist-test7');

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
        plugins: [
          duplicatePackagesPlugin({
            exceptions: {
              'unused-package': { maxAllowedVersionCount: 3 },
            },
          }),
        ],
        logLevel: 'error',
      });
    },
    (error: Error) => {
      const expectedDuplicateError = `Duplicate packages detected in bundle (compilation: client):

  • dep-a: 2.0.0, 1.0.0

Multiple versions of the same package can cause runtime errors and increase bundle size.`;

      const expectedUnusedError = `Unused duplicate package exceptions (compilation: client):

  • unused-package

These duplicate package exceptions are not used. Please remove them from your configuration to vite-plugin-duplicate-packages.`;

      assert.ok(
        error.message.includes(expectedDuplicateError),
        `Error message should contain duplicate package error. Got: ${error.message}`,
      );
      assert.ok(
        error.message.includes(expectedUnusedError),
        `Error message should contain unused exception error. Got: ${error.message}`,
      );
      return true;
    },
    'Should throw an error with both duplicate package and unused exception messages',
  );
});

test('plugin with allowUnusedExceptions: should not throw error for unused exception', async () => {
  await buildAndVerify({
    outDirName: 'dist-test8',
    plugins: [
      duplicatePackagesPlugin({
        allowUnusedExceptions: true,
        exceptions: {
          'dep-2': { maxAllowedVersionCount: 2 },
        },
      }),
    ],
    entrypoint: 'noDuplicateViolations.js',
  });
});

test('exception scoped to matching compilation: should apply exception', async () => {
  // Exception scoped to 'client' should apply during a non-SSR (client) build
  await buildAndVerify({
    outDirName: 'dist-test9',
    plugins: [
      duplicatePackagesPlugin({
        compilationName: 'client',
        exceptions: {
          'dep-a': { maxAllowedVersionCount: 2, compilations: ['client'] },
        },
      }),
    ],
    expectedCounts: {
      depDV1: 2,
      depAV2: 1,
      depAV1: 1,
      depBV1: 1,
      depCV1: 1,
    },
    entrypoint: 'withDuplicates.js',
  });
});

test('exception scoped to different compilation: should not apply exception', async () => {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const outDir = path.join(appPath, 'dist-test10');

  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true });
  }

  // Exception scoped to 'server' should NOT apply during a 'client' build,
  // so the duplicate dep-a should cause an error
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
        plugins: [
          duplicatePackagesPlugin({
            compilationName: 'client',
            exceptions: {
              'dep-a': { maxAllowedVersionCount: 2, compilations: ['server'] },
            },
          }),
        ],
        logLevel: 'error',
      });
    },
    (error: Error) => {
      assert.ok(
        error.message.includes('Duplicate packages detected in bundle (compilation: client)'),
        `Error should mention client compilation. Got: ${error.message}`,
      );
      assert.ok(error.message.includes('dep-a'), `Error should mention dep-a. Got: ${error.message}`);
      return true;
    },
    'Should error because the exception is scoped to server, not client',
  );
});

test('out-of-scope exception should not be flagged as unused', async () => {
  // Exception scoped to 'server' shouldn't cause an unused-exception error during a 'client' build
  await buildAndVerify({
    outDirName: 'dist-test11',
    plugins: [
      duplicatePackagesPlugin({
        compilationName: 'client',
        exceptions: {
          'dep-a': { maxAllowedVersionCount: 2, compilations: ['client'] },
          'some-server-only-pkg': { maxAllowedVersionCount: 2, compilations: ['server'] },
        },
      }),
    ],
    expectedCounts: {
      depDV1: 2,
      depAV2: 1,
      depAV1: 1,
      depBV1: 1,
      depCV1: 1,
    },
    entrypoint: 'withDuplicates.js',
  });
});

test('in-scope unused exception should be flagged', async () => {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const outDir = path.join(appPath, 'dist-test12');

  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true });
  }

  // Exception scoped to 'client' that doesn't match any package should be flagged as unused
  await assert.rejects(
    async () => {
      await build({
        root: appPath,
        build: {
          outDir,
          lib: {
            entry: path.join(appPath, 'noDuplicateViolations.js'),
            name: 'App',
            fileName: 'app',
            formats: ['es'],
          },
        },
        plugins: [
          duplicatePackagesPlugin({
            compilationName: 'client',
            exceptions: {
              'nonexistent-pkg': { maxAllowedVersionCount: 2, compilations: ['client'] },
              'server-only-pkg': { maxAllowedVersionCount: 2, compilations: ['server'] },
            },
          }),
        ],
        logLevel: 'error',
      });
    },
    (error: Error) => {
      assert.ok(
        error.message.includes('nonexistent-pkg'),
        `Error should flag nonexistent-pkg as unused. Got: ${error.message}`,
      );
      assert.ok(
        !error.message.includes('server-only-pkg'),
        `Error should NOT flag server-only-pkg (out of scope). Got: ${error.message}`,
      );
      return true;
    },
    'Should only flag in-scope unused exceptions',
  );
});

test('custom compilationName in error messages', async () => {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const outDir = path.join(appPath, 'dist-test13');

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
        plugins: [
          duplicatePackagesPlugin({
            compilationName: 'my-custom-build',
          }),
        ],
        logLevel: 'error',
      });
    },
    (error: Error) => {
      assert.ok(
        error.message.includes('(compilation: my-custom-build)'),
        `Error should include custom compilation name. Got: ${error.message}`,
      );
      return true;
    },
    'Should include custom compilationName in error message',
  );
});

test('exception with multiple compilations', async () => {
  // Exception scoped to both 'client' and 'server' should apply during a 'client' build
  await buildAndVerify({
    outDirName: 'dist-test14',
    plugins: [
      duplicatePackagesPlugin({
        compilationName: 'client',
        exceptions: {
          'dep-a': { maxAllowedVersionCount: 2, compilations: ['client', 'server'] },
        },
      }),
    ],
    expectedCounts: {
      depDV1: 2,
      depAV2: 1,
      depAV1: 1,
      depBV1: 1,
      depCV1: 1,
    },
    entrypoint: 'withDuplicates.js',
  });
});

test('exception without compilations applies to all', async () => {
  // Exception without compilations field should apply regardless of compilationName
  await buildAndVerify({
    outDirName: 'dist-test15',
    plugins: [
      duplicatePackagesPlugin({
        compilationName: 'server',
        exceptions: {
          'dep-a': { maxAllowedVersionCount: 2 },
        },
      }),
    ],
    expectedCounts: {
      depDV1: 2,
      depAV2: 1,
      depAV1: 1,
      depBV1: 1,
      depCV1: 1,
    },
    entrypoint: 'withDuplicates.js',
  });
});

test('multi-environment build: client-scoped exceptions should not be flagged as unused in other environments', async () => {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const outDir = path.join(appPath, 'dist-test-multi-env');

  // Clean up dist directory if it exists
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true });
  }

  // Use createBuilder to build multiple environments with a shared plugin instance.
  // The plugin should auto-detect the environment name from this.environment.name
  // and only check in-scope exceptions per environment.
  //
  // - "client" environment builds withDuplicates.js (has dep-a duplication) with exception scoped to ['client']
  // - "custom_server" environment builds noDuplicateViolations.js (no dep-a at all)
  //
  // Before the fix: compilationName was set once in configResolved as 'client' and never updated,
  // so the custom_server environment would see dep-a exception as in-scope, find it unused, and error.
  // After the fix: each environment reads this.environment.name, so custom_server correctly skips
  // the client-scoped exception.
  const builder = await createBuilder({
    root: appPath,
    plugins: [
      duplicatePackagesPlugin({
        exceptions: {
          'dep-a': { maxAllowedVersionCount: 2, compilations: ['client'] },
        },
      }),
    ],
    logLevel: 'silent',
    environments: {
      client: {
        build: {
          outDir: path.join(outDir, 'client'),
          lib: {
            entry: path.join(appPath, 'withDuplicates.js'),
            name: 'App',
            fileName: 'app',
            formats: ['es'],
          },
        },
      },
      custom_server: {
        build: {
          outDir: path.join(outDir, 'custom_server'),
          lib: {
            entry: path.join(appPath, 'noDuplicateViolations.js'),
            name: 'App',
            fileName: 'app',
            formats: ['es'],
          },
        },
      },
    },
  });

  // buildApp builds all environments — should not throw
  await builder.buildApp();

  // Verify both outputs exist
  const clientOutput = path.join(outDir, 'client', 'app.js');
  const serverOutput = path.join(outDir, 'custom_server', 'noDuplicateViolations.js');
  assert.ok(fs.existsSync(clientOutput), 'Client output file should exist');
  assert.ok(fs.existsSync(serverOutput), 'Server output file should exist');
});
