import {readFile, writeFile} from 'node:fs/promises';
const path = new URL('../app/railbet.tsx', import.meta.url);
const original = await readFile(path, 'utf8');
if (original.includes("m.result_method==='archive_daily'")) {
  console.log('Automatic result label is already installed.');
} else {
  const pattern = /m\.result_method==='simulation'\?'resultado simulado':'[^']*'/g;
  const matches = [...original.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('Could not locate the result label uniquely. No file was changed.');
  const updated = original.replace(pattern,
    "m.result_method==='simulation'?'resultado simulado':m.result_method==='archive_daily'?'verificado automaticamente no arquivo':'confirmação manual'");
  await writeFile(path, updated, 'utf8');
  console.log('Automatic result label installed in app/railbet.tsx.');
}
