import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFile(path.join(root,f),'utf8');
let html=await read('src/index.html');
const core=await read('src/core.js');
const css=await read('src/styles.css'), client=await read('src/client.js');
const boot=await read('src/boot.js');
// Function replacements preserve literal dollar signs in application code.
html=html.replace('/* APP_CSS */',()=>css).replace('/* APP_BOOT */',()=>boot+'\n//# sourceURL=customer-boot.js\n').replace('/* APP_CORE */',()=>core+'\n//# sourceURL=customer-core.js\n').replace('/* APP_CLIENT */',()=>client+'\n//# sourceURL=customer-client.js\n');
await fs.mkdir(path.join(root,'preview'),{recursive:true});
await fs.writeFile(path.join(root,'gas/Index.html'),html);
await fs.writeFile(path.join(root,'gas/Core.gs'),core.replace(/\nif \(typeof module[^\n]+\n?$/,''));
await fs.writeFile(path.join(root,'preview/index.html'),html);
console.log('GAS用HTML・Core.gsとローカルプレビューを生成しました。');
