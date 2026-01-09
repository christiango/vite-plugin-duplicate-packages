import type { Plugin, ViteDevServer } from 'vite' with { 'resolution-mode': 'import' };
import { join, resolve, normalize } from 'path';
import findRoot from 'find-root';
import chalk from 'chalk';
import { readFileSync } from 'fs';

export interface DuplicatePackagesConfig {
  /** There are some cases where duplication cannot be avoided in a bundle. Use this to add specific exceptions to the no duplicate packages policy. */
  exceptions?: {
    /** Map of package name to exceptions. */
    [packageName: string]: {
      /* Maximum number of different versions to allow. Will not error if count is less than max, but will error if there are no duplicates */
      maxAllowedVersionCount: number;
    };
  };

  /**
   * Automatically deduplicate NPM/Yarn doppelgangers https://rushjs.io/pages/advanced/npm_doppelgangers/
   */
  deduplicateDoppelgangers?: boolean;

  /**
   * Enable duplicate detection in dev mode. Default: false
   * Note: Dev mode detection only analyzes modules that have been loaded.
   * Run a production build for comprehensive analysis.
   */
  enableInDev?: boolean;
}

export interface PackageInfo {
  name: string;

  version: string;

  /** The root path for the package json file being bundled */
  rootPath: string;
}

interface DuplicatePackageError {
  packageName: string;
  versions: Set<string>;
  maxAllowedVersionCount?: number;
}

interface DuplicateAnalysisResult {
  duplicatePackageErrors: DuplicatePackageError[];
  unusedExceptions: Set<string>;
}

function getPackageJsonForPath(path: string): PackageInfo | undefined {
  try {
    // Normalize the path to use platform-specific separators
    const normalizedPath = normalize(path);
    const root = findRoot(normalizedPath);

    const packageJsonPath = join(root, 'package.json');
    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    if (!packageJson) {
      return undefined;
    }

    if (packageJson.name === undefined && packageJson.version === undefined) {
      // We've seen some packages have a dummy package.json nested in their projects (@babel\runtime is an example), continue climbing the file hierarchy to find a real package.json
      return getPackageJsonForPath(resolve(root, '..'));
    }

    return { name: packageJson.name, version: packageJson.version, rootPath: root };
  } catch {
    return undefined;
  }
}

/**
 * Analyzes a collection of module IDs for duplicate packages.
 * Shared logic between build mode (generateBundle) and dev mode (moduleGraph).
 */
function analyzeForDuplicates(moduleIds: Iterable<string>, config?: DuplicatePackagesConfig): DuplicateAnalysisResult {
  const packagesMap = new Map<string, { versions: Set<string> }>();

  for (const moduleId of moduleIds) {
    if (!moduleId.includes('node_modules')) {
      continue;
    }

    const packageInfo = getPackageJsonForPath(moduleId);
    if (packageInfo) {
      const packageEntryInMap = packagesMap.get(packageInfo.name) ?? { versions: new Set<string>() };
      packageEntryInMap.versions.add(packageInfo.version);
      packagesMap.set(packageInfo.name, packageEntryInMap);
    }
  }

  const duplicatePackageErrors: DuplicatePackageError[] = [];
  const unusedExceptions = new Set<string>(Object.keys(config?.exceptions ?? {}));

  for (const [packageName, packageInfo] of packagesMap.entries()) {
    // Remove from unused exceptions since we found this package in the bundle
    unusedExceptions.delete(packageName);

    if (packageInfo.versions.size > 1) {
      const relevantException = config?.exceptions?.[packageName];

      if (!relevantException || packageInfo.versions.size > relevantException.maxAllowedVersionCount) {
        duplicatePackageErrors.push({
          packageName,
          versions: packageInfo.versions,
          maxAllowedVersionCount: relevantException?.maxAllowedVersionCount,
        });
      }
    }
  }

  return { duplicatePackageErrors, unusedExceptions };
}

/**
 * Vite plugin that detects and optionally deduplicates duplicate packages in both build and dev modes.
 * @param config Plugin configuration
 * @returns Vite plugin
 */
export function duplicatePackagesPlugin(config?: DuplicatePackagesConfig): Plugin {
  interface DoppelgangerInfo {
    resolveToPath: string;
    paths: Set<string>;
  }
  const doppelgangerMap = new Map<string, DoppelgangerInfo>();

  // Track all resolved module IDs for dev mode analysis
  // This captures modules resolved through both client and SSR paths
  const resolvedModuleIds = new Set<string>();

  return {
    name: 'vite-duplicate-package-plugin',
    apply: (_, { command }) => {
      // Always apply in build mode
      if (command === 'build') {
        return true;
      }
      // In serve mode, only apply if enableInDev is explicitly true
      return config?.enableInDev === true;
    },
    enforce: 'pre',

    // Track all resolved modules and optionally deduplicate doppelgangers
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0')) {
        return null;
      }

      // Let Vite resolve the module first
      const resolved = await this.resolve(source, importer, { skipSelf: true, ...options });

      if (!resolved || !resolved.id.includes('node_modules')) {
        return null;
      }

      // Track all resolved node_modules for dev mode analysis
      resolvedModuleIds.add(resolved.id);

      const packageInfo = getPackageJsonForPath(resolved.id);
      if (!packageInfo) {
        return null;
      }

      // Doppelganger deduplication (only when enabled)
      if (config?.deduplicateDoppelgangers) {
        const packageId = `${packageInfo.name}@${packageInfo.version}`;
        const match = doppelgangerMap.get(packageId);

        if (match && match.resolveToPath !== packageInfo.rootPath) {
          // Doppelganger found - redirect to canonical path
          match.paths.add(packageInfo.rootPath);

          // Normalize paths to handle Windows path separator mismatch
          // resolved.id uses forward slashes, but packageInfo.rootPath may use backslashes on Windows
          const normalizedOriginalPath = packageInfo.rootPath.replace(/\\/g, '/');
          const normalizedCanonicalPath = match.resolveToPath.replace(/\\/g, '/');
          const redirectedId = resolved.id.replace(normalizedOriginalPath, normalizedCanonicalPath);

          return redirectedId;
        } else if (!match) {
          // First occurrence - store as canonical
          doppelgangerMap.set(packageId, {
            resolveToPath: packageInfo.rootPath,
            paths: new Set([packageInfo.rootPath]),
          });
        }
      }

      return null;
    },

    // Dev mode: configure server with duplicate check endpoint
    configureServer(server: ViteDevServer) {
      // Add endpoint for on-demand duplicate checking
      server.middlewares.use('/__check-duplicates', (_req, res) => {
        // Combine module IDs from both the client module graph and our tracked resolutions
        const allModuleIds = new Set<string>(resolvedModuleIds);

        // Also add modules from the client module graph
        for (const mod of server.moduleGraph.idToModuleMap.values()) {
          if (mod.id) {
            allModuleIds.add(mod.id);
          }
        }

        const result = analyzeForDuplicates(allModuleIds, config);
        const hasIssues = result.duplicatePackageErrors.length > 0 || result.unusedExceptions.size > 0;

        // Convert Sets to arrays for JSON serialization
        const jsonResult = {
          duplicatePackageErrors: result.duplicatePackageErrors.map((err) => ({
            ...err,
            versions: Array.from(err.versions),
          })),
          unusedExceptions: Array.from(result.unusedExceptions),
          hasIssues,
        };

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(jsonResult, null, 2));
      });

      // Return post-hook that runs after internal middlewares are added
      return () => {
        console.log(chalk.cyan('\n  Duplicate Package Check: visit /__check-duplicates to analyze loaded modules\n'));
      };
    },

    generateBundle(_, bundle) {
      // Analyze the bundle for multiple versions of the same package
      const moduleIds: string[] = [];
      for (const [, fileInfo] of Object.entries(bundle)) {
        if (fileInfo.type === 'chunk') {
          moduleIds.push(...Object.keys(fileInfo.modules));
        }
      }

      const { duplicatePackageErrors, unusedExceptions } = analyzeForDuplicates(moduleIds, config);

      const hasErrors = duplicatePackageErrors.length > 0 || unusedExceptions.size > 0;

      if (hasErrors) {
        const errorParts: string[] = [];

        if (duplicatePackageErrors.length > 0) {
          const duplicateDetails = duplicatePackageErrors
            .map(({ packageName, versions, maxAllowedVersionCount }) => {
              const versionList = Array.from(versions).join(', ');
              const exceptionNote =
                maxAllowedVersionCount !== undefined
                  ? ` (exception allows max ${maxAllowedVersionCount}, found ${versions.size})`
                  : '';
              return `  \u2022 ${packageName}: ${versionList}${exceptionNote}`;
            })
            .join('\n');

          errorParts.push(
            `Duplicate packages detected in bundle:\n\n${duplicateDetails}\n\nMultiple versions of the same package can cause runtime errors and increase bundle size.`,
          );
        }

        if (unusedExceptions.size > 0) {
          const unusedDetails = Array.from(unusedExceptions)
            .map((packageName) => `  \u2022 ${packageName}`)
            .join('\n');

          errorParts.push(
            `Unused duplicate package exceptions:\n\n${unusedDetails}\n\nThese duplicate package exceptions are not used. Please remove them from your configuration to vite-plugin-duplicate-packages.`,
          );
        }

        this.error(errorParts.join('\n\n'));
      }
    },

    // Report duplicates and doppelgangers after build
    buildEnd() {
      // Report eliminated doppelgangers
      if (config?.deduplicateDoppelgangers) {
        for (const [packageId, info] of doppelgangerMap) {
          if (info.paths.size > 1) {
            console.log(chalk.green(`${packageId}: eliminated ${info.paths.size - 1} doppelgangers`));
          }
        }
      }
    },
  };
}
