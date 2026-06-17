import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, 'index.js');
const distPath = path.join(__dirname, 'index.cjs');

console.log('Building CommonJS target...');
let code = fs.readFileSync(srcPath, 'utf8');

// Replace the ESM default export at the end of the file with CommonJS exports.
// We remove:
// export default SvgConverter;
// export { Vector2, CubicBezier, SvgConverter };
code = code.replace('export default SvgConverter;', '');
code = code.replace('export { Vector2, CubicBezier, SvgConverter };', '');

// Append CommonJS exports
code += `
module.exports = SvgConverter;
module.exports.SvgConverter = SvgConverter;
module.exports.Vector2 = Vector2;
module.exports.CubicBezier = CubicBezier;
`;

fs.writeFileSync(distPath, code);
console.log('Build completed successfully!');
