const fs = require('fs');
const path = require('path');
const { contextBridge } = require('electron');

const assets = Object.freeze({
  wasm: path.join(__dirname, '..', 'build', 'deepfilternet', 'v3', 'pkg', 'df_bg.wasm'),
  model: path.join(__dirname, '..', 'build', 'deepfilternet', 'v3', 'models', 'DeepFilterNet3_onnx.tar.gz')
});

contextBridge.exposeInMainWorld('pairDeepFilter', {
  getAsset: async name => Object.hasOwn(assets, name) ? fs.readFileSync(assets[name]) : null
});
