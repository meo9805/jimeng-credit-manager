const parts = value => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value)) return null;
  const values=value.split('.').map(Number);
  if (values.some(number=>number>65535)) return null;
  return [...values,...Array(4-values.length).fill(0)];
};
export function newerVersion(candidate,current) {
  const next=parts(candidate),installed=parts(current);
  if (!next || !installed) return false;
  for (let index=0;index<4;index++) {
    if (next[index] !== installed[index]) return next[index]>installed[index];
  }
  return false;
}
export function publishedUpdate(release,current) {
  if (!release || release.distribution !== 'unpacked' || release.announcedVersion !== release.version || !newerVersion(release.version,current)) return null;
  const date=typeof release.announcedAt === 'string' ? new Date(release.announcedAt) : null;
  return {version:release.version,distribution:'unpacked',announcedVersion:release.version,
    announcedAt:date && Number.isFinite(date.valueOf()) ? date.toISOString() : null};
}
export const MAX_UPDATE_BYTES=10*1024*1024;
export async function readUpdateZip(response) {
  const length=Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length>MAX_UPDATE_BYTES) throw new Error('更新包过大');
  const reader=response.body?.getReader?.();
  let bytes;
  if (reader) {
    const chunks=[];let size=0;
    try {
      for (;;) {
        const {done,value}=await reader.read();
        if (done) break;
        size+=value.byteLength;
        if (size>MAX_UPDATE_BYTES) {await reader.cancel();throw new Error('更新包过大');}
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
    bytes=new Uint8Array(size);let offset=0;
    for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  } else bytes=new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength>MAX_UPDATE_BYTES || bytes.byteLength<4 || bytes[0]!==0x50 || bytes[1]!==0x4b || bytes[2]!==3 || bytes[3]!==4) throw new Error('更新包格式不正确');
  let binary='';
  for (let offset=0;offset<bytes.length;offset+=32768) binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return btoa(binary);
}
