# LiteRT.js 打包檔

`litert.bundle.js` 由 `@litertjs/core@2.6.0` 與其相依套件 `@litertjs/wasm-utils@2.6.0` 以 esbuild 打包成單一 ES 模組（`--bundle --format=esm --minify`）。
兩個套件的授權皆為 Apache-2.0。打包的原因：`@litertjs/core` 的發行檔使用裸模組名稱（bare import）匯入相依套件，瀏覽器無法直接從 CDN 載入。
WebAssembly 檔（約 11 MB）不放在本儲存庫，量測時由 jsdelivr 的 `@litertjs/core@2.6.0/wasm/` 載入。
