'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');
const { _test: { extractFileText } } = require('../services/onDemandAiService');

function pdfFixture() {
  const content = 'BT /F1 12 Tf 40 100 Td (Dealer report: 42 enquiries) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString('base64');
}

test('a real PDF is parsed through the v2 API and the worker is destroyed', async (t) => {
  const original = PDFParse.prototype.destroy;
  let destroyed = 0;
  t.mock.method(PDFParse.prototype, 'destroy', async function destroy() {
    destroyed += 1;
    return original.call(this);
  });
  const result = await extractFileText(pdfFixture(), 'report.pdf');
  assert.equal(result.kind, 'pdf');
  assert.match(result.text, /Dealer report: 42 enquiries/);
  assert.equal(destroyed, 1);
});

test('spreadsheet parsing bounds extracted rows while preserving the total row count and XLS support', async () => {
  const rows = [['Dealer', 'Enquiries'], ...Array.from({ length: 250 }, (_, i) => [`Dealer ${i}`, i])];
  for (const bookType of ['xlsx', 'xls']) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Report');
    const data = XLSX.write(wb, { type: 'buffer', bookType });
    const result = await extractFileText(data.toString('base64'), `report.${bookType}`);
    assert.equal(result.rowCount, 250, bookType);
    assert.equal(result.text.split('\n').length, 60, bookType);
    assert.match(result.text, /Dealer 58/);
    assert.equal(result.text.includes('Dealer 249'), false);
  }
});

test('CSV files retain their existing table format', async () => {
  const result = await extractFileText(Buffer.from('Dealer,Enquiries\nD1,42\nD2,7').toString('base64'), 'report.csv');
  assert.equal(result.rowCount, 2);
  assert.equal(result.text, 'Dealer | Enquiries\nD1 | 42\nD2 | 7');
});

test('a wide one-row spreadsheet cannot create an unbounded AI prompt', async () => {
  const data = Buffer.from(`Dealer,Notes\nD1,${'a'.repeat(100000)}`).toString('base64');
  const result = await extractFileText(data, 'report.csv');
  assert.equal(result.rowCount, 1);
  assert.equal(result.text.length, 8000);
  assert.equal(result.sampled, true);
});

test('unsupported, empty and oversized uploads are rejected before invoking a parser', async () => {
  await assert.rejects(extractFileText('abc', 'payload.html'), { code: 'INVALID_UPLOAD' });
  await assert.rejects(extractFileText('', 'report.pdf'), { code: 'INVALID_UPLOAD' });
  await assert.rejects(extractFileText('a'.repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4 + 1), 'report.pdf'), { code: 'UPLOAD_TOO_LARGE' });
});

test('PDF cleanup runs on a parse error and does not mask that error', async (t) => {
  const original = PDFParse.prototype.destroy;
  let destroyed = 0;
  const parseError = new Error('synthetic parse failure');
  t.mock.method(PDFParse.prototype, 'getText', async () => { throw parseError; });
  t.mock.method(PDFParse.prototype, 'destroy', async function destroy() {
    destroyed += 1;
    await original.call(this);
    throw new Error('synthetic cleanup failure');
  });
  await assert.rejects(extractFileText(pdfFixture(), 'report.pdf'), (err) => err === parseError);
  assert.equal(destroyed, 1);
});
