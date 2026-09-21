import { randomBytes,scrypt,timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './domain.mjs';

const derive=promisify(scrypt);
const parameters={N:16384,r:8,p:1,maxmem:32*1024*1024};
function validPassword(value) {
  if(typeof value!=='string')return false;
  const characters=[...value].length;
  return characters>=8&&characters<=128&&Buffer.byteLength(value,'utf8')<=256;
}
function validRecord(record) {
  return record?.algorithm==='scrypt-v1'&&typeof record.salt==='string'&&/^[A-Za-z0-9_-]{22}$/.test(record.salt)
    &&typeof record.hash==='string'&&/^[A-Za-z0-9_-]{43}$/.test(record.hash);
}
export function createAdminPassword(store) {
  return {
    configured:()=>Boolean(store.getAdminPasswordRecord()),
    async set(password) {
      if(!validPassword(password))fail('登录密码需为 8–128 个字符，且不超过 256 字节');
      const salt=randomBytes(16),derived=await derive(password,salt,32,parameters);
      store.setAdminPasswordRecord({algorithm:'scrypt-v1',salt:salt.toString('base64url'),hash:derived.toString('base64url')});
    },
    async verify(password) {
      const record=store.getAdminPasswordRecord();
      if(!validPassword(password)||!validRecord(record))return false;
      const derived=await derive(password,Buffer.from(record.salt,'base64url'),32,parameters);
      // A password changed during an in-flight login must not issue a new session.
      const current=store.getAdminPasswordRecord();
      return current?.salt===record.salt&&current?.hash===record.hash&&timingSafeEqual(derived,Buffer.from(record.hash,'base64url'));
    }
  };
}
