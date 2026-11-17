import { buildAll } from './build.mjs';
import { serve } from './server.mjs';
await buildAll(true);
serve(Number(process.env.PORT || 4173));
console.log('试玩地址：http://127.0.0.1:4173');
