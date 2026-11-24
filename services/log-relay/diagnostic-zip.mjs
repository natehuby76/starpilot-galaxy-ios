const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

export async function diagnosticZip(text, filename = 'diagnostics.txt') {
  const encoder = new TextEncoder();
  const name = encoder.encode(filename);
  const contents = encoder.encode(text);
  const stream = new Blob([contents]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const deflated = compressed.length < contents.length;
  const data = deflated ? compressed : contents;
  let crc = 0xffffffff;
  for (const byte of contents) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];

  const local = new Uint8Array(30 + name.length);
  const directory = new Uint8Array(46 + name.length);
  const end = new Uint8Array(22);
  const localHeader = new DataView(local.buffer);
  const entry = new DataView(directory.buffer);
  const footer = new DataView(end.buffer);
  localHeader.setUint32(0, 0x04034b50, true);
  entry.setUint32(0, 0x02014b50, true);
  entry.setUint16(4, 20, true);
  for (const [view, start] of [[localHeader, 4], [entry, 6]]) {
    view.setUint16(start, 20, true);
    view.setUint16(start + 4, deflated ? 8 : 0, true);
    view.setUint16(start + 8, 33, true); // 1980-01-01
    view.setUint32(start + 10, crc ^ 0xffffffff, true);
    view.setUint32(start + 14, data.length, true);
    view.setUint32(start + 18, contents.length, true);
    view.setUint16(start + 22, name.length, true);
  }
  local.set(name, 30);
  directory.set(name, 46);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, 1, true);
  footer.setUint16(10, 1, true);
  footer.setUint32(12, directory.length, true);
  footer.setUint32(16, local.length + data.length, true);
  return new Blob([local, data, directory, end], {type: 'application/zip'});
}
