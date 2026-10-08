// 建物データ(PLATEAU)は Draco という方式で圧縮されている。読み出し用の部品を public/draco/ にコピーする。
import { cpSync, mkdirSync } from "node:fs";
const from = new URL("../node_modules/three/examples/jsm/libs/draco/gltf/", import.meta.url);
const to = new URL("../public/draco/", import.meta.url);
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log("draco decoder copied");
