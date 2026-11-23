// A minimal valid PDF with one text line per page (Helvetica), for pdftotext tests. Keeps real
// advert PDFs out of the public repo.
export function makePdf(pages) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objs.length + 1 + pages.length * 2; // placeholder id, fixed below
  const kids = [];
  for (const text of pages) {
    const lines = String(text).split('\n');
    const ops = lines.map((l, i) => `BT /F1 11 Tf 50 ${780 - i * 14} Td (${l.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  const pagesObj = add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  if (pagesObj !== pagesId) throw new Error('page tree id mismatch');
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
