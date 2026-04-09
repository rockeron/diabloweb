import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { basename } from 'path'

function jsccPlugin() {
  return {
    name: 'vite-plugin-jscc',
    enforce: 'pre',
    load(id) {
      if (id.endsWith('.jscc')) {
        let code = readFileSync(id, 'utf-8')
        const name = basename(id, '.jscc')
        code += `\nexport default ${name};\n`
        return code
      }
    }
  }
}

export default defineConfig({
  plugins: [react(), jsccPlugin()],
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
    plugins: () => [jsccPlugin()]
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    'process.env.PUBLIC_URL': JSON.stringify(''),
    'process.env.VERSION': JSON.stringify('2.0.0'),
  },
  server: {
    port: parseInt(process.env.PORT || '3001')
  }
})
