import { resolve } from "node:path";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
const root=resolve(import.meta.dir,"..");
const dir=await mkdtemp(resolve(tmpdir(),"tgfx-rust-parity-"));
try{
 for(const name of ["rich-markdown","projector","tools","normalize","model-picker","custom-icon-set","reply-style","session-confirmation","cost-report"]){
  let source=await Bun.file(resolve(root,`tests/${name}.test.ts`)).text();
  source=source.replace(/from "\.\.\/src\/([^\"]+)"/g,(_,path)=>`from ${JSON.stringify(["telegram/rich-markdown","fx/projector","fx/tools","telegram/normalize","telegram/model-picker","telegram/custom-icon-set","telegram/reply-style","telegram/session-confirmation","telegram/cost-report","fx/usage"].includes(path)?resolve(root,"scripts/rust-test-proxy.ts"):resolve(root,"src",path))}`);
  source=source.replace(/from "(\.\/[^\"]+)"/g,(_,path)=>`from ${JSON.stringify(resolve(root,"tests",path))}`);
  await Bun.write(resolve(dir,`${name}.test.ts`),source);
 }
 // Each assertion crosses a native process seam; give the bridge time on busy CI hosts.
 const p=Bun.spawn([process.execPath,"test","--timeout","30000",resolve(dir)],{cwd:root,stdout:"inherit",stderr:"inherit",env:process.env});
 process.exitCode=await p.exited;
}finally{await rm(dir,{recursive:true,force:true});}
