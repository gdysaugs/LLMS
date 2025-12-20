const fs = require('fs');
const p = '/home/adama/LLMS/lipdiffusion/frontend/src/pages/Generate.tsx';
let d = fs.readFileSync(p, 'utf8');
d = d.replace(/\n\s*<p className="muted">\n\s*注意: 長尺ファイルはCloudflare Pagesの25MB制限を超えないようにしてください。結果取得が失敗した場合はタスクIDとログを控えてください。\n\s*<\/p>/, '');
d = d.replace(/この内容で生成する/g, '生成');
fs.writeFileSync(p, d);
