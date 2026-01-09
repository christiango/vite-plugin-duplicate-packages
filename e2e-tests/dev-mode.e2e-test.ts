import { test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createServer, type ViteDevServer, type Plugin } from 'vite';
import { duplicatePackagesPlugin } from '../lib/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createDevServer(plugins: Plugin[]): Promise<ViteDevServer> {
  const mockRepoPath = path.resolve(__dirname, 'mock-repo');
  const appPath = path.join(mockRepoPath, 'packages', 'app');

  const server = await createServer({
    root: appPath,
    server: {
      port: 0, // Random available port
    },
    plugins,
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

/**
 * Warm up the module graph by resolving modules.
 * This triggers the plugin's resolveId hook for doppelganger deduplication.
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
      const importRegex =
        /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
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

test('without deduplicateDoppelgangers, doppelgangers are NOT deduplicated', async () => {
  const server = await createDevServer([
    duplicatePackagesPlugin(), // No deduplicateDoppelgangers - plugin won't apply in dev mode
  ]);

  try {
    const mockRepoPath = path.resolve(__dirname, 'mock-repo');
    const appPath = path.join(mockRepoPath, 'packages', 'app');

    // dep-d is imported by both dep-a and dep-b (same version 1.0.0)
    // Without deduplication, they should resolve to DIFFERENT paths (duplicates remain)
    const depAPath = path.join(appPath, 'node_modules', 'dep-a', 'index.js');
    const depBPath = path.join(appPath, 'node_modules', 'dep-b', 'index.js');

    const depDFromA = await server.pluginContainer.resolveId('dep-d', depAPath);
    const depDFromB = await server.pluginContainer.resolveId('dep-d', depBPath);

    assert.ok(depDFromA, 'Should resolve dep-d from dep-a');
    assert.ok(depDFromB, 'Should resolve dep-d from dep-b');

    const resolvedFromA = typeof depDFromA === 'string' ? depDFromA : depDFromA.id;
    const resolvedFromB = typeof depDFromB === 'string' ? depDFromB : depDFromB.id;

    // Without deduplication, they should resolve to DIFFERENT paths (doppelgangers remain)
    assert.notStrictEqual(
      resolvedFromA,
      resolvedFromB,
      'Without deduplication, dep-d should resolve to different paths (doppelgangers NOT deduplicated)',
    );

    // Verify they are indeed different nested paths
    assert.ok(resolvedFromA.includes('dep-a'), 'dep-d from dep-a should be in dep-a node_modules');
    assert.ok(resolvedFromB.includes('dep-b'), 'dep-d from dep-b should be in dep-b node_modules');
  } finally {
    await server.close();
  }
});

test('doppelganger deduplication works in dev mode', async () => {
  const server = await createDevServer([
    duplicatePackagesPlugin({
      deduplicateDoppelgangers: true,
    }),
  ]);

  try {
    // Load all modules to trigger doppelganger deduplication
    await warmupModules(server, 'withDuplicates.js');

    // Now resolve dep-d from two different contexts and verify they resolve to the same path
    const mockRepoPath = path.resolve(__dirname, 'mock-repo');
    const appPath = path.join(mockRepoPath, 'packages', 'app');

    // dep-d is imported by both dep-a and dep-b
    // With doppelganger deduplication, both should resolve to the same path
    const depAPath = path.join(appPath, 'node_modules', 'dep-a', 'index.js');
    const depBPath = path.join(appPath, 'node_modules', 'dep-b', 'index.js');

    const depDFromA = await server.pluginContainer.resolveId('dep-d', depAPath);
    const depDFromB = await server.pluginContainer.resolveId('dep-d', depBPath);

    assert.ok(depDFromA, 'Should resolve dep-d from dep-a');
    assert.ok(depDFromB, 'Should resolve dep-d from dep-b');

    const resolvedFromA = typeof depDFromA === 'string' ? depDFromA : depDFromA.id;
    const resolvedFromB = typeof depDFromB === 'string' ? depDFromB : depDFromB.id;

    // Both should resolve to the same canonical path (doppelganger eliminated)
    assert.strictEqual(
      resolvedFromA,
      resolvedFromB,
      'dep-d should resolve to the same path from both dep-a and dep-b (doppelganger deduplicated)',
    );
  } finally {
    await server.close();
  }
});

test('dev mode test 3 - different versions are not deduplicated', async () => {
  const server = await createDevServer([
    duplicatePackagesPlugin({
      deduplicateDoppelgangers: true,
    }),
  ]);

  try {
    // Load all modules
    await warmupModules(server, 'withDuplicates.js');

    const mockRepoPath = path.resolve(__dirname, 'mock-repo');
    const appPath = path.join(mockRepoPath, 'packages', 'app');

    // dep-a has two versions: v2.0.0 in app/node_modules and v1.0.0 in dep-b/node_modules
    // These are different versions, so they should NOT be deduplicated
    const entryPath = path.join(appPath, 'withDuplicates.js');
    const depBPath = path.join(appPath, 'node_modules', 'dep-b', 'index.js');

    const depAFromEntry = await server.pluginContainer.resolveId('dep-a', entryPath);
    const depAFromDepB = await server.pluginContainer.resolveId('dep-a', depBPath);

    assert.ok(depAFromEntry, 'Should resolve dep-a from entry');
    assert.ok(depAFromDepB, 'Should resolve dep-a from dep-b');

    const resolvedFromEntry = typeof depAFromEntry === 'string' ? depAFromEntry : depAFromEntry.id;
    const resolvedFromDepB = typeof depAFromDepB === 'string' ? depAFromDepB : depAFromDepB.id;

    // These should be DIFFERENT paths because they are different versions
    assert.notStrictEqual(
      resolvedFromEntry,
      resolvedFromDepB,
      'dep-a v2.0.0 and dep-a v1.0.0 should resolve to different paths (different versions)',
    );
  } finally {
    await server.close();
  }
});
