import type { Plugin } from 'vite' with { 'resolution-mode': 'import' };
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
}

export interface PackageInfo {
  name: string;

  version: string;

  /** The root path for the package json file being bundled */
  rootPath: string;
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
 * Vite plugin that detects duplicate packages in builds and optionally deduplicates doppelgangers.
 * @param config Plugin configuration
 * @returns Vite plugin
 */
export function duplicatePackagesPlugin(config?: DuplicatePackagesConfig): Plugin {
  interface DoppelgangerInfo {
    resolveToPath: string;
    paths: Set<string>;
  }
  const doppelgangerMap = new Map<string, DoppelgangerInfo>();

  return {
    name: 'vite-duplicate-package-plugin',
    apply: (_, { command }) => {
      // Always apply in build mode
      if (command === 'build') {
        return true;
      }
      // In serve mode, only apply if doppelganger deduplication is enabled
      return config?.deduplicateDoppelgangers === true;
    },
    enforce: 'pre',

    // Doppelganger deduplication happens during module resolution
    async resolveId(source, importer, options) {
      if (!config?.deduplicateDoppelgangers || !importer || source.startsWith('\0')) {
        return null;
      }

      // Let Vite resolve the module first
      const resolved = await this.resolve(source, importer, { skipSelf: true, ...options });

      if (!resolved || !resolved.id.includes('node_modules')) {
        return null;
      }

      const packageInfo = getPackageJsonForPath(resolved.id);
      if (!packageInfo) {
        return null;
      }

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

      return null;
    },

    generateBundle(_, bundle) {
      // Analyze the bundle for multiple versions of the same package
      const packagesMap = new Map<string, { versions: Set<string> }>();
      for (const [, fileInfo] of Object.entries(bundle)) {
        if (fileInfo.type === 'chunk') {
          for (const moduleId of Object.keys(fileInfo.modules)) {
            const packageInfo = getPackageJsonForPath(moduleId);
            if (packageInfo) {
              const packageEntryInMap = packagesMap.get(packageInfo.name) ?? { versions: new Set<string>() };
              packageEntryInMap.versions.add(packageInfo.version);
              packagesMap.set(packageInfo.name, packageEntryInMap);
            }
          }
        }
      }

      const duplicatePackageErrors: { packageName: string; versions: Set<string>; maxAllowedVersionCount?: number }[] =
        [];
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
              return `  • ${packageName}: ${versionList}${exceptionNote}`;
            })
            .join('\n');

          errorParts.push(
            `Duplicate packages detected in bundle:\n\n${duplicateDetails}\n\nMultiple versions of the same package can cause runtime errors and increase bundle size.`,
          );
        }

        if (unusedExceptions.size > 0) {
          const unusedDetails = Array.from(unusedExceptions)
            .map((packageName) => `  • ${packageName}`)
            .join('\n');

          errorParts.push(
            `Unused duplicate package exceptions:\n\n${unusedDetails}\n\nThese duplicate package exceptions are not used. Please remove them from your configuration to vite-plugin-duplicate-packages.`,
          );
        }

        this.error(errorParts.join('\n\n'));
      }
    },

    // Report eliminated doppelgangers after build
    buildEnd() {
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
