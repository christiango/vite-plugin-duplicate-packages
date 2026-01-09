import { test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createServer, type ViteDevServer, type Plugin } from 'vite';
import { duplicatePackagesPlugin } from '../lib/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DevServerOptions {
  plugins: Plugin[];
  entrypoint?: string;
}

async function createDevServer(options: DevServerOptions): Promise<ViteDevServer> {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');

  const server = await createServer({
    root: appPath,
    server: {
      port: 0, // Random available port
    },
    plugins: options.plugins,
    logLevel: 'silent',
    // Disable dependency optimization so we can see the real node_modules paths
    optimizeDeps: {
      noDiscovery: true,
      include: [],
    },
  });

  await server.listen();
  return server;
}

type CheckDuplicatesResult = {
  duplicatePackageErrors: Array<{
    packageName: string;
    versions: string[];
    maxAllowedVersionCount?: number;
  }>;
  unusedExceptions: string[];
  hasIssues: boolean;
};

async function fetchCheckDuplicates(server: ViteDevServer): Promise<CheckDuplicatesResult> {
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server address not available');
  }

  const response = await fetch(`http://localhost:${address.port}/__check-duplicates`);
  return response.json() as Promise<CheckDuplicatesResult>;
}

/**
 * Warm up the module graph by resolving and transforming modules.
 * This manually resolves all imports to populate the plugin's tracking.
 */
async function warmupModules(server: ViteDevServer, entrypoint: string): Promise<void> {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');
  const fullPath = path.join(appPath, entrypoint);

  const resolvedIds = new Set<string>();

  // Recursively resolve all imports starting from the entrypoint
  // Use a combination of (specifier, importer) as the key to handle same package from different contexts
  const resolveKey = (spec: string, imp?: string) => `${spec}::${imp ?? 'root'}`;

  async function resolveImports(id: string, importer?: string): Promise<void> {
    const key = resolveKey(id, importer);
    if (resolvedIds.has(key)) return;
    resolvedIds.add(key);

    // Resolve the module using the plugin container
    const resolved = await server.pluginContainer.resolveId(id, importer);
    if (!resolved) {
      return;
    }

    const resolvedId = typeof resolved === 'string' ? resolved : resolved.id;

    // Skip virtual modules
    if (resolvedId.startsWith('\0')) return;

    // Track this resolved path
    resolvedIds.add(resolvedId);

    // Read the file and parse its imports (for both app code and node_modules)
    try {
      const code = readFileSync(resolvedId, 'utf-8');
      // Simple regex to find imports - handles both import and require
      const importRegex = /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
      let match;
      while ((match = importRegex.exec(code)) !== null) {
        const importSource = match[1] || match[2];
        if (importSource && !importSource.startsWith('.')) {
          // Bare specifier - resolve from the current module
          await resolveImports(importSource, resolvedId);
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  await resolveImports(fullPath);
}

test('dev mode test 1 - plugin loads in dev mode when enabled', async () => {
  const server = await createDevServer({
    plugins: [duplicatePackagesPlugin({ enableInDev: true })],
  });

  try {
    // Verify server is running and endpoint exists
    const result = await fetchCheckDuplicates(server);
    assert.ok(typeof result.hasIssues === 'boolean', 'Should return hasIssues boolean');
    assert.ok(Array.isArray(result.duplicatePackageErrors), 'Should return duplicatePackageErrors array');
    assert.ok(Array.isArray(result.unusedExceptions), 'Should return unusedExceptions array');
  } finally {
    await server.close();
  }
});

test('dev mode test 2 - plugin is disabled in dev mode by default', async () => {
  const server = await createServer({
    root: path.resolve(__dirname, 'mock-repo', 'packages', 'app'),
    server: { port: 0 },
    plugins: [duplicatePackagesPlugin()], // No enableInDev, defaults to false
    logLevel: 'silent',
  });

  await server.listen();

  try {
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server address not available');
    }

    // The endpoint should not exist when plugin is disabled in dev mode
    const response = await fetch(`http://localhost:${address.port}/__check-duplicates`);
    // When plugin is disabled, the middleware isn't added, so we get 404 or the default vite handler
    assert.notStrictEqual(response.headers.get('content-type'), 'application/json');
  } finally {
    await server.close();
  }
});

test('dev mode test 3 - detects duplicates after loading modules', async () => {
  const server = await createDevServer({
    plugins: [duplicatePackagesPlugin({ enableInDev: true })],
  });

  try {
    // Load the entry module which imports dependencies with duplicates
    await warmupModules(server, 'withDuplicates.js');

    // Check for duplicates
    const result = await fetchCheckDuplicates(server);

    // Should detect dep-a as having duplicate versions (1.0.0 and 2.0.0)
    assert.ok(result.hasIssues, 'Should detect duplicate issues');
    assert.ok(
      result.duplicatePackageErrors.some((err) => err.packageName === 'dep-a'),
      'Should detect dep-a as duplicate',
    );

    const depAError = result.duplicatePackageErrors.find((err) => err.packageName === 'dep-a');
    assert.ok(depAError, 'dep-a should be in errors');
    assert.ok(depAError.versions.includes('1.0.0'), 'Should include version 1.0.0');
    assert.ok(depAError.versions.includes('2.0.0'), 'Should include version 2.0.0');
  } finally {
    await server.close();
  }
});

test('dev mode test 4 - exceptions work in dev mode', async () => {
  const server = await createDevServer({
    plugins: [
      duplicatePackagesPlugin({
        enableInDev: true,
        exceptions: {
          'dep-a': { maxAllowedVersionCount: 2 },
        },
      }),
    ],
  });

  try {
    // Load the entry module
    await warmupModules(server, 'withDuplicates.js');

    // Check for duplicates
    const result = await fetchCheckDuplicates(server);

    // dep-a should NOT be in errors due to exception
    assert.ok(
      !result.duplicatePackageErrors.some((err) => err.packageName === 'dep-a'),
      'dep-a should not be in errors due to exception',
    );
  } finally {
    await server.close();
  }
});

test('dev mode test 5 - doppelganger deduplication works in dev mode', async () => {
  const server = await createDevServer({
    plugins: [
      duplicatePackagesPlugin({
        enableInDev: true,
        deduplicateDoppelgangers: true,
        exceptions: {
          'dep-a': { maxAllowedVersionCount: 2 },
        },
      }),
    ],
  });

  try {
    // Load the entry module
    await warmupModules(server, 'withDuplicates.js');

    // Check the duplicates endpoint - dep-d should NOT be reported as a duplicate
    // because the doppelgangers (same version from different paths) were deduplicated
    const result = await fetchCheckDuplicates(server);

    // dep-d@1.0.0 exists in both dep-a's node_modules and dep-b's node_modules
    // With deduplication enabled, it should resolve to a single path
    // and therefore NOT appear in duplicate errors
    assert.ok(
      !result.duplicatePackageErrors.some((err) => err.packageName === 'dep-d'),
      'dep-d should not appear in duplicate errors (doppelgangers deduplicated)',
    );
  } finally {
    await server.close();
  }
});

test('dev mode test 6 - no duplicates scenario', async () => {
  const server = await createDevServer({
    plugins: [duplicatePackagesPlugin({ enableInDev: true })],
  });

  try {
    // Load the clean entry module that only imports dep-c
    await warmupModules(server, 'noDuplicateViolations.js');

    // Check for duplicates
    const result = await fetchCheckDuplicates(server);

    // Should not have any duplicate issues
    assert.strictEqual(result.hasIssues, false, 'Should not have any duplicate issues');
    assert.strictEqual(result.duplicatePackageErrors.length, 0, 'Should have no duplicate package errors');
  } finally {
    await server.close();
  }
});

test('dev mode test 7 - unused exceptions detected in dev mode', async () => {
  const server = await createDevServer({
    plugins: [
      duplicatePackagesPlugin({
        enableInDev: true,
        exceptions: {
          'nonexistent-package': { maxAllowedVersionCount: 2 },
        },
      }),
    ],
  });

  try {
    // Load the clean entry module
    await warmupModules(server, 'noDuplicateViolations.js');

    // Check for duplicates
    const result = await fetchCheckDuplicates(server);

    // Should detect unused exception
    assert.ok(result.hasIssues, 'Should have issues due to unused exception');
    assert.ok(result.unusedExceptions.includes('nonexistent-package'), 'Should report unused exception');
  } finally {
    await server.close();
  }
});
