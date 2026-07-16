// CommonJS: the project is CJS (no "type":"module") so main/preload get native
// __dirname and a sandbox-compatible CJS preload.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
}
