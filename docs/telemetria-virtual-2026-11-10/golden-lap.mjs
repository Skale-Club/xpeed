// Builds the golden lap files of FORMATO-DE-VOLTA.md byte by byte, without using src/lib/sim/lap-file.ts or the
// Companion's writer, so both can be checked against an independent reading of the layout.
//   node docs/telemetria-virtual-2026-11-10/golden-lap.mjs        prints both files as hexadecimal
// The headers are written out by hand, key by key, in the fixed order the spec gives.

function file(version, headerText, columns) {
  const text = Buffer.from(headerText, 'utf8');
  const headerBytes = Math.ceil(text.length / 4) * 4;
  const preamble = Buffer.alloc(12);
  preamble.write('XLAP', 0, 'ascii');
  preamble.writeUInt16LE(version, 4);
  preamble.writeUInt16LE(0, 6);
  preamble.writeUInt32LE(headerBytes, 8);
  const padded = Buffer.alloc(headerBytes, 0x20);
  text.copy(padded);
  const data = Buffer.concat(
    columns.map((column) => {
      const out = Buffer.alloc(column.length * 4);
      column.forEach((value, i) => out.writeFloatLE(value, i * 4));
      return out;
    }),
  );
  return Buffer.concat([preamble, padded, data]);
}

// Version 1: the lap of the first version of the format.
const v1 = file(
  1,
  '{"game":"lmu","track":{"name":"Test Track","variant":"GP","lengthM":20},"car":{"name":"Test Car","class":"HYPERCAR"},"lap":{"number":1,"timeMs":1000,"valid":true,"sectorsMs":[400,600]},"startedAt":"2026-11-10T12:00:00.000Z","sampleRateHz":2,"sampleCount":3,"channels":[{"id":"t","unit":"s"},{"id":"dist","unit":"m"},{"id":"speed","unit":"m/s"}]}',
  [[0, 0.5, 1], [0, 10, 20], [0, 10, 20]],
);

// Version 2: the same kind of lap with the session, the weather, the tyre compound, in and out lap, and two of the
// channels added in version 2 (one of them with a unit that is not ASCII, and one sample the game did not give).
const v2 = file(
  2,
  '{"game":"ac","track":{"name":"Test Track","variant":"GP","lengthM":20},"car":{"name":"Test Car","class":"GT3"},"lap":{"number":2,"timeMs":1000,"valid":true,"sectorsMs":[400,300,300],"inLap":false,"outLap":true},"startedAt":"2026-11-10T12:00:00.000Z","sampleRateHz":2,"sampleCount":3,"sessionId":"a1b2c3d4e5f60718293a4b5c6d7e8f90","sessionKind":"practice","weather":"rain","airTempC":18.5,"trackTempC":22,"tyreCompound":"Soft","channels":[{"id":"t","unit":"s"},{"id":"dist","unit":"m"},{"id":"speed","unit":"m/s"},{"id":"tyre_temp_fl","unit":"°C"},{"id":"g_lat","unit":"g"}]}',
  [[0, 0.5, 1], [0, 10, 20], [0, 10, 20], [80, NaN, 82], [0, 0.5, -1]],
);

console.log(`v1 (${v1.length} bytes)\n${v1.toString('hex')}\n`);
console.log(`v2 (${v2.length} bytes)\n${v2.toString('hex')}`);
