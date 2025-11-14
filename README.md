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
