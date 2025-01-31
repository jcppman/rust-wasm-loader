const child_process = require('child_process')
const fs = require('fs')
const loaderUtils = require('loader-utils')
const path = require('path')
const toml = require('toml')
const babel = require('babel-core');

module.exports = function(source) {
  // Indicate that this loader is asynchronous
  const callback = this.async()
  const srcDir = path.dirname(path.dirname(this.resourcePath))
  // Find the rust package name in the Cargo.toml
  const packageName = toml.parse(
    fs.readFileSync(path.join(srcDir, 'Cargo.toml'), 'utf8').toString()
  ).package.name

  const opts = loaderUtils.getOptions(this)

  const rustTarget = (opts || {}).rustTarget || `wasm32-unknown-unknown`;

  const builtin = /unknown-unknown/.test(rustTarget);

  // debug builds are presently broken in straight rust wasm
  const release = builtin || (opts ? opts.release : false)

  const buildPath = opts ? opts.path : undefined
  if (buildPath === undefined) {
    return callback(
      new Error(
        'You must set the `path` option to the path to webpack output relative to project root'
      ),
      null
    )
  }

  const outDir = path.join(
    srcDir,
    'target',
    rustTarget,
    release ? 'release' : 'debug'
  )

  const outFile = path.join(outDir, `${packageName}.js`);

  const subcmd = `cargo ${builtin ? 'web ' : ''}build`;
  const cmd = `${subcmd} --target=${rustTarget}${release ? ' --release' : ''} ${builtin ? '--runtime library-es6' : ''} --verbose`

  const self = this
  child_process.exec(cmd, { cwd: this.context }, function(
    error,
    stdout,
    stderr
  ) {
    if (error) {
      return callback(error, null)
    }
    // Get the contents of the javascript 'glue' code generated by Emscripten
    const out = fs.readFileSync(outFile, 'utf8')

    let wasmFile;
    if (builtin) {
      wasmFile = path.join(outDir, `${packageName}.wasm`);
    } else {
      wasmFile = fs
        .readdirSync(path.join(outDir, 'deps'))
        .find(f => /\.wasm$/.test(f));
      wasmFile = path.join(outDir, 'deps', wasmFile)
    }

    if (!wasmFile) {
      return callback(new Error('No wasm file found', null))
    }

    // Emit the wasm file
    self.emitFile(
      `${packageName}.wasm`,
      fs.readFileSync(wasmFile)
    )

    const wasmPath = path.join(buildPath, `${packageName}.wasm`)

    if (builtin) {
      // `cargo web build` emits es6 which
      // causes problems with `webpack -p`
      const es5out = babel.transform(out, {
        'presets': ['env']
      });

      // use custom runtime because cargo-web standalone runtime currently
      // does not support custom file path
      // Ref: https://github.com/koute/cargo-web/issues/131
      const runtime = `
        const module = eval(\`${es5out.code}\`);
        const { imports } = module();
        const wasmPath = '${wasmPath}';

        exports.default = () => new Promise((resolve, reject) => {
            WebAssembly.instantiateStreaming(fetch(wasmPath), imports).then((obj) => {
                resolve(obj.instance.exports);
            }, reject);
        });
      `;

      return callback(null, runtime);
    }

    // This object is passed to the Emscripten 'glue' code
    const Module = {
      // Path in the built project to the wasm file
      wasmBinaryFile: wasmPath,
      // Indicates that we are NOT running in node, despite 'require' being defined
      ENVIRONMENT: 'WEB',
    }

    const glue = `module.exports = (function(existingModule){
      return {
        // Returns a promise that resolves when the wasm runtime is initialized and ready for use
        initialize: function(userDefinedModule) {
          return new Promise(function(resolve, reject) {
            if (!userDefinedModule) {
              userDefinedModule = {}
            }
            var Module = Object.assign({}, userDefinedModule, existingModule);
            Module['onRuntimeInitialized'] = function() { resolve(Module) };
            \n${out}\n
          });
        }
      }
    })(${JSON.stringify(Module)})`

    return callback(null, glue)
  })
}
