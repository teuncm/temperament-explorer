import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config.js'

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      // Exercise Vapor with the complete browser runtime in jsdom.
      alias: [
        {
          find: /^vue$/,
          replacement: fileURLToPath(
            new URL(
              './node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.js',
              import.meta.url,
            ),
          ),
        },
      ],
    },
    test: {
      environment: 'jsdom',
      exclude: [...configDefaults.exclude, 'e2e/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
    },
  }),
)
