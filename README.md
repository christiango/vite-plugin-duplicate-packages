# vite-plugin-duplicate-packages

Vite plugin for helping to deal with duplicate packages.

## Installation

```bash
npm install @christiango/vite-plugin-duplicate-packages
# or
yarn add @christiango/vite-plugin-duplicate-packages
```

## Usage

Add the plugin to your `vite.config.js` or `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { duplicatePackagesPlugin } from '@christiango/vite-plugin-duplicate-packages';

export default defineConfig({
  plugins: [
    duplicatePackagesPlugin({
      // options
    }),
  ],
});
```

## Options

### `deduplicateDoppelgangers`

- **Type:** `boolean`
- **Default:** `false`

Automatically deduplicate NPM/Yarn doppelgangers. Doppelgangers are packages that exist in multiple versions but one version is never actually used (phantom dependency). When enabled, the plugin will eliminate duplicate packages of the same version that are bundled multiple times from different locations in the dependency tree.

For more information about doppelgangers, see [Rush.js documentation on NPM doppelgangers](https://rushjs.io/pages/advanced/npm_doppelgangers/).

**Example:**

```typescript
duplicatePackagesPlugin({
  deduplicateDoppelgangers: true,
});
```

When enabled, if you have:

- `package-a@1.0.0` in `node_modules/dep-x/node_modules/package-a`
- `package-a@1.0.0` in `node_modules/dep-y/node_modules/package-a`
- `package-a@2.0.0` in `node_modules/package-a` (unused)

The plugin will deduplicate the two instances of `package-a@1.0.0`, reducing your bundle size.

### `exceptions`

- **Type:** `{ [packageName: string]: { maxAllowedVersionCount: number; compilations?: string[] } }`
- **Default:** `{}`

Configure exceptions for packages that are allowed to have multiple versions in the bundle. This is useful for cases where duplicate packages cannot be avoided.

Each exception can optionally specify a `compilations` array to limit which compilations the exception applies to (see [`compilationName`](#compilationname) below). Omit `compilations` to apply the exception to all compilations.

**Example:**

```typescript
duplicatePackagesPlugin({
  exceptions: {
    react: { maxAllowedVersionCount: 2 },
    lodash: { maxAllowedVersionCount: 3, compilations: ['client'] },
  },
});
```

With this configuration:

- `react` can have up to 2 versions in the bundle without causing an error (in any compilation)
- `lodash` can have up to 3 versions without error, but only during `client` compilations
- Any other package with multiple versions will cause a build error

**Important:** The plugin will throw an error if you define an exception for a package that is not found in the bundle or doesn't have duplicates. This helps keep your configuration clean and up-to-date. Exceptions scoped to a different compilation via `compilations` are excluded from this check.

### `compilationName`

- **Type:** `string`
- **Default:** Auto-detected (`'ssr'` for SSR builds, `'client'` otherwise)

Identifies the current compilation. Used together with the `compilations` field on individual exceptions to scope which exceptions apply to which build.

This is useful in multi-compilation setups like TanStack Start, Remix, or other frameworks that run multiple Vite builds (e.g. client, server, SSR) from a single project.

**Example — multi-compilation setup:**

```typescript
// Shared exception config used across all compilations
const exceptions = {
  // Applies everywhere
  lodash: { maxAllowedVersionCount: 2 },
  // Only relevant in client builds
  'react-dom': { maxAllowedVersionCount: 2, compilations: ['client'] },
  // Only relevant in server builds
  'server-renderer': { maxAllowedVersionCount: 2, compilations: ['server'] },
};

// Client vite config
duplicatePackagesPlugin({
  compilationName: 'client',
  exceptions,
});

// Server vite config
duplicatePackagesPlugin({
  compilationName: 'server',
  exceptions,
});
```

With this setup:

- The `react-dom` exception is only active during the `client` build and won't cause an "unused exception" error during the `server` build
- The `server-renderer` exception is only active during the `server` build
- The `lodash` exception applies to both

## Features

### Duplicate Package Detection

By default, the plugin analyzes your bundle and throws an error if multiple versions of the same package are detected. This helps prevent issues caused by having different versions of the same library in your bundle.

**Example error message:**

```text
Duplicate packages detected in bundle:

  • react: 17.0.2, 18.2.0

Multiple versions of the same package can cause runtime errors and increase bundle size.
```

When duplicates are detected, the build will fail with a clear error message showing which packages have multiple versions.
