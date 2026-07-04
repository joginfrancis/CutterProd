const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('\x1b[35m%s\x1b[0m', '====================================================');
console.log('\x1b[36m%s\x1b[0m', ' Launching CutterProd Server :3');
console.log('\x1b[35m%s\x1b[0m', '====================================================\n');

// Sync SvgConverter from the package to the web app src folder
try {
    console.log('Syncing svg-trajectory-converter package to local src/...');
    
    // 1. Build CJS target in the package
    const packageDir = path.join(__dirname, 'svg-trajectory-converter');
    execSync('node build.js', { cwd: packageDir, stdio: 'inherit' });
    
    // 2. Copy index.js to src/SvgConverter.js
    const srcFile = path.join(packageDir, 'index.js');
    const destFile = path.join(__dirname, 'src', 'SvgConverter.js');
    fs.copyFileSync(srcFile, destFile);
    console.log('\x1b[32m%s\x1b[0m', '✓ SvgConverter synchronized successfully.\n');
} catch (e) {
    console.error('Failed to sync SvgConverter package:', e.message);
}


// Start the CutterProd static server (npx serve src)
const serveProcess = spawn('npx', ['-y', 'serve', 'src', '-l', '3000'], {
    shell: true,
    stdio: 'inherit'
});

// Graceful cleanup on exit
function shutdown() {
    console.log('\n\x1b[31m%s\x1b[0m', ' Shutting down server...');

    // Kill processes safely
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', serveProcess.pid, '/f', '/t']);
        } else {
            serveProcess.kill('SIGINT');
        }
    } catch (e) {
        // Ignore kill errors if already dead
    }

    setTimeout(() => {
        process.exit(0);
    }, 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);
