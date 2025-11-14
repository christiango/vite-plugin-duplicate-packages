import type { Plugin } from 'vite' with { 'resolution-mode': 'import' };
import { join, resolve } from 'path';
import findRoot from 'find-root';
import chalk from 'chalk';
import { readFileSync } from 'fs';

export interface DuplicatePackagesConfig {
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
    const root = findRoot(path);
    
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
 * Vite plugin that helps
 * @param config
 * @returns
 */
export function duplicatePackagesPlugin(config?: DuplicatePackagesConfig): Plugin {
  interface DoppelgangerInfo {
    resolveToPath: string;
    paths: Set<string>;
  }
  const doppelgangerMap = new Map<string, DoppelgangerInfo>();

  return {
    name: 'vite-duplicate-package-plugin',
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
        const redirectedId = resolved.id.replace(packageInfo.rootPath, match.resolveToPath);
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
