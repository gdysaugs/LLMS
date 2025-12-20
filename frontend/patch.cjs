const fs = require('fs');
const p = '/home/adama/LLMS/lipdiffusion/frontend/src/pages/Generate.tsx';
let d = fs.readFileSync(p, 'utf8');
d = d.replace(/<\/div>\n\s*<p className=\"muted\">[\s\S]*?<\/p>\n\s*<div className=\"actions\">/, '</div>\n          <div className="actions">');
d = d.replace(/isRunning \?[^\n]*\n/, "isRunning ? '生成中...' : '生成'\n");
fs.writeFileSync(p, d);
