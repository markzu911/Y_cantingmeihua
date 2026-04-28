import fs from 'fs';

let content = fs.readFileSync('src/App.tsx', 'utf8');

// 1. Remove blobs
content = content.replace(/<div className="absolute top-\[-10%\].*?blur-3xl.*? \/>/g, '');
content = content.replace(/<div className="absolute bottom-\[-10%\].*?blur-3xl.*? \/>/g, '');
// For the 2nd one:
content = content.replace(/<div className="absolute top-\[-10%\].*?blur-3xl pointer-events-none" \/>/g, '');
content = content.replace(/<div className="absolute bottom-\[-10%\].*?blur-3xl pointer-events-none" \/>/g, '');

// 2. Background and text
content = content.replace(/bg-slate-50/g, 'bg-[#f5f5f0]');
content = content.replace(/bg-slate-900/g, 'bg-[#5A5A40]');
content = content.replace(/text-slate-900/g, 'text-[#1a1a1a]');
content = content.replace(/text-slate-800/g, 'text-[#2d2d2a]');
content = content.replace(/text-slate-700/g, 'text-[#3f3f3c]');
content = content.replace(/text-slate-600/g, 'text-[#52524f]');
content = content.replace(/hover:bg-slate-800/g, 'hover:bg-[#4a4a35]');

// 3. Borders and soft UI
content = content.replace(/rounded-3xl/g, 'rounded-[32px]');
content = content.replace(/rounded-2xl/g, 'rounded-[24px]');

// 4. Update the brand and main headers to use serif
content = content.replace(/<h1 className="text-xl font-bold tracking-tight text-\[#1a1a1a\]">/g, '<h1 className="text-2xl font-bold tracking-tight text-[#1a1a1a] font-serif">');
content = content.replace(/<h1 className="text-2xl font-bold text-\[#1a1a1a\] mb-3 tracking-tight">/g, '<h1 className="text-3xl font-bold text-[#1a1a1a] mb-3 tracking-tight font-serif">');
content = content.replace(/<h2 className="text-lg font-bold mb-5 flex items-center gap-3 text-\[#2d2d2a\] tracking-tight">/g, '<h2 className="text-xl font-bold mb-5 flex items-center gap-3 text-[#2d2d2a] tracking-tight font-serif">');

// 5. Replace slate with stone globally for other components
content = content.replace(/slate/g, 'stone');

// Fix button roundness
content = content.replace(/rounded-\[24px\] font-medium flex items-center justify-center/g, 'rounded-full font-medium flex items-center justify-center');
content = content.replace(/rounded-\[24px\] font-semibold flex items-center justify-center/g, 'rounded-full font-semibold flex items-center justify-center');
content = content.replace(/rounded-\[24px\] font-medium transition-all shadow-md/g, 'rounded-full font-medium transition-all shadow-md');

fs.writeFileSync('src/App.tsx', content);
console.log('Done!');
