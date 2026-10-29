import { afterEach, expect, test } from "bun:test";
import { mkdtemp,writeFile,chmod,rm,realpath } from "node:fs/promises";
import { join,resolve } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { FakeTelegram } from "./fixtures/fake-telegram";
const binary=process.env.TGFX_RUST_BINARY??resolve(process.env.CARGO_TARGET_DIR??"target","debug/tgfx");
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
async function setup(extra:Record<string,unknown>={}){
 const dir=await realpath(await mkdtemp(join("/tmp","tgfx-native-e2e-")));cleanups.push(()=>rm(dir,{recursive:true,force:true}));
 const telegram=new FakeTelegram();cleanups.push(()=>telegram.stop());
 const home=join(dir,"home");const hash=createHash("sha256").update(dir).digest("hex").slice(0,12);
 const configPath=join(home,"projects",`${dir.split('/').at(-1)}-${hash}.json`);
 await Bun.write(configPath,JSON.stringify({version:1,activeBotId:"100",access:{userIds:["42"],chatIds:[]},approvals:{chatId:"42",topicId:"0"},output:"live",customIcons:false,...extra}));
 const fx=join(dir,"fx");await writeFile(fx,`#!/bin/sh\nexec '${process.execPath.replaceAll("'","'\\''")}' '${resolve("tests/fixtures/fake-fx.ts").replaceAll("'","'\\''")}' "$@"\n`);await chmod(fx,0o700);
 const env:Record<string,string|undefined>={...process.env,TGFX_HOME:home,TGFX_API_ROOT:telegram.url,TELEGRAM_BOT_TOKEN:"100:native-fixture",FX_BINARY:fx,FAKE_FX_LOG:join(dir,"fx.jsonl")};delete env.TGFX_RUNTIME_DIR;
 let child:Bun.Subprocess<"ignore","pipe","pipe">;let stdout:Promise<string>,stderr:Promise<string>;
 const start=async()=>{child=Bun.spawn([binary,"--no-tui","--json"],{cwd:dir,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});stdout=new Response(child.stdout).text();stderr=new Response(child.stderr).text();await Promise.race([telegram.waitForCalls("getUpdates",telegram.calls("getUpdates").length+1,10_000),child.exited.then(async()=>{throw new Error(`Native TGFX exited: ${await stderr}`)})]);};
 const stop=async()=>{if(child&&child.exitCode===null){child.kill("SIGTERM");const timed=setTimeout(()=>child.kill("SIGKILL"),5000);await child.exited;clearTimeout(timed);}return{out:await stdout,err:await stderr};};cleanups.push(async()=>{await stop();});
 await start();
 return{dir,home,telegram,configPath,env,start,stop,database:()=>new Database(join(home,"state/100.db")),fxLog:async()=>{const text=await Bun.file(join(dir,"fx.jsonl")).text();return text.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}};
}
function callback(t:FakeTelegram,data:string,message=1000,user=42,chat=user){const id=`cb-${crypto.randomUUID()}`;t.push({callback_query:{id,from:{id:user,is_bot:false,first_name:"Tester"},chat_instance:"fixture",data,message:{message_id:message,date:1,chat:{id:chat,type:chat<0?"supergroup":"private"},text:"menu"}}} as any);return id;}
function findData(v:any,prefix:string):string|undefined{if(v&&typeof v==="object"){if(typeof v.callback_data==="string"&&v.callback_data.startsWith(prefix))return v.callback_data;for(const value of Object.values(v)){const r=findData(value,prefix);if(r)return r;}}}
test("native binary delivers a real HTTP/ACP turn and journals completion",async()=>{const f=await setup();f.telegram.sendUserMessage({userId:42,text:"hello native"});const calls=await f.telegram.waitForCalls("sendRichMessage");expect(JSON.stringify(calls[0]!.payload.rich_message)).toContain("fake streamed text");await f.stop();const db=f.database();expect(db.query("SELECT status FROM telegram_inbox").all()).toEqual([{status:"done"}]);expect(db.query("SELECT status FROM telegram_outbox").all()).toEqual([{status:"sent"}]);db.close();},20_000);
test("controls remain responsive while FX waits and format only changes the next turn",async()=>{const f=await setup();f.telegram.sendUserMessage({userId:42,text:"WAIT"});await f.telegram.waitForCalls("sendRichMessageDraft");f.telegram.sendUserMessage({userId:42,text:"/format"});await f.telegram.waitForRequest(r=>r.method==="sendMessage"&&JSON.stringify(r.payload).includes("fmt:final"));callback(f.telegram,"fmt:final");await f.telegram.waitForCalls("answerCallbackQuery");f.telegram.sendUserMessage({userId:42,text:"/stop"});await f.telegram.waitForRequest(r=>r.method==="sendMessage"&&JSON.stringify(r.payload).toLowerCase().includes("cancel"),10_000);const before=f.telegram.calls("sendRichMessageDraft").length;f.telegram.sendUserMessage({userId:42,text:"next request"});await f.telegram.waitForRequest(r=>r.method==="sendRichMessage"&&JSON.stringify(r.payload).includes("fake streamed text"),10_000);expect(f.telegram.calls("sendRichMessageDraft").length).toBe(before);},25_000);
test("unauthorized payloads are discarded and a permitted request still completes",async()=>{const f=await setup();f.telegram.sendUserMessage({userId:999,text:"MUST_NOT_STORE"});f.telegram.sendUserMessage({userId:42,text:"allowed request"});await f.telegram.waitForCalls("sendRichMessage");await f.stop();const db=f.database();expect(JSON.stringify(db.query("SELECT * FROM telegram_inbox").all())).not.toContain("MUST_NOT_STORE");expect(JSON.stringify(await f.fxLog())).not.toContain("MUST_NOT_STORE");db.close();});
test("a stalled DM does not block another authorized route",async()=>{const f=await setup({access:{userIds:["42","43"],chatIds:[]}});f.telegram.sendUserMessage({userId:42,text:"WAIT"});await f.telegram.waitForCalls("sendRichMessageDraft");f.telegram.sendUserMessage({userId:43,text:"concurrent request"});const reply=await f.telegram.waitForRequest(r=>r.method==="sendRichMessage"&&String(r.payload.chat_id)==="43",10_000);expect(JSON.stringify(reply.payload.rich_message)).toContain("fake streamed text");f.telegram.sendUserMessage({userId:42,text:"/stop"});},20_000);
test("confirmed clear discards queued work and the next request uses a new session",async()=>{const f=await setup();f.telegram.sendUserMessage({userId:42,text:"WAIT"});await f.telegram.waitForCalls("sendRichMessageDraft");f.telegram.sendUserMessage({userId:42,text:"QUEUED_SHOULD_DISCARD"});f.telegram.sendUserMessage({userId:42,text:"/clear"});const card=await f.telegram.waitForRequest(r=>r.method==="sendRichMessage"&&Boolean(findData(r.payload,"session:")));const db=f.database();let cardId:number|undefined;const deadline=Date.now()+5000;while(cardId===undefined && Date.now()<deadline){const saved=db.query("SELECT payload_json FROM telegram_interactions ORDER BY rowid DESC LIMIT 1").get() as any;cardId=saved?JSON.parse(saved.payload_json).card?.messageId:undefined;if(cardId===undefined)await Bun.sleep(1);}db.close();expect(cardId).toBeDefined();callback(f.telegram,findData(card.payload,"session:")!,Number(cardId));await f.telegram.waitForRequest(r=>(r.method==="sendMessage"||r.method==="editMessageText")&&JSON.stringify(r.payload).toLowerCase().includes("fresh conversation"),10_000);f.telegram.sendUserMessage({userId:42,text:"fresh request"});await f.telegram.waitForRequest(r=>r.method==="sendRichMessage"&&JSON.stringify(r.payload).includes("fake streamed text"),10_000);const prompts=(await f.fxLog()).filter(x=>x.event==="prompt");expect(prompts.some(x=>x.value.prompt.at(-1)?.text==="QUEUED_SHOULD_DISCARD")).toBe(false);expect(prompts.length).toBe(2);},25_000);
test("external background event uses a distinct envelope and no Telegram delivery",async()=>{const f=await setup();const before=f.telegram.calls("sendRichMessage").length;const p=Bun.spawn([binary,"emit","fixture.event","--id","native-event","--payload",'{"message_id":"mail-1"}',"--wait"],{cwd:f.dir,env:f.env,stdout:"pipe",stderr:"pipe"});const [text,err,status]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);expect(status,err).toBe(0);expect(JSON.parse(text).status).toBe("done");expect(f.telegram.calls("sendRichMessage").length).toBe(before);const log=await f.fxLog();expect(JSON.stringify(log)).toContain("external_event");expect(log.find(x=>x.event==="new").value.mcpServers).toEqual([]);},20_000);

test("a saved DM style survives restart without changing another chat", async () => {
  const f = await setup({ output: undefined, access: { userIds: ["42", "43"], chatIds: [] } });
  const id = callback(f.telegram, "fmt:final");
  await f.telegram.waitForRequest(r => r.method === "answerCallbackQuery" && r.payload.callback_query_id === id);
  const saved = await Bun.file(f.configPath).json();
  expect(saved.chatFormats).toEqual({ "42": "final" });
  expect(saved.output).toBeUndefined();
  await f.stop();
  await f.start();

  f.telegram.sendUserMessage({ userId: 42, text: "FX_TOOL" });
  await f.telegram.waitForRequest(r => r.method === "sendRichMessage" && String(r.payload.chat_id) === "42");
  expect(f.telegram.calls("sendRichMessageDraft").filter(r => String(r.payload.chat_id) === "42")).toHaveLength(0);
  f.telegram.sendUserMessage({ userId: 43, text: "WAIT" });
  await f.telegram.waitForRequest(r => r.method === "sendRichMessageDraft" && String(r.payload.chat_id) === "43");
}, 25_000);

test("groups explain Final and cannot change a DM style through old buttons", async () => {
  const f = await setup({ output: "detailed", access: { userIds: ["42"], chatIds: ["-9"] } });
  f.telegram.sendUserMessage({ userId: 42, chatId: -9, chatType: "supergroup", text: "/format@fake_bot" });
  const reply = await f.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.chat_id) === "-9");
  expect(reply.payload.text).toContain("Final");
  expect(findData(reply.payload, "fmt:")).toBeUndefined();
  const id = callback(f.telegram, "fmt:live", 1000, 42, -9);
  const answer = await f.telegram.waitForRequest(r => r.method === "answerCallbackQuery" && r.payload.callback_query_id === id);
  expect(answer.payload.text).toContain("Final");
  const saved = await Bun.file(f.configPath).json();
  expect(saved.output).toBe("detailed");
  expect(saved.chatFormats).toBeUndefined();
});

test("group turns deliver only the final answer with a Detailed default", async () => {
  const f = await setup({ output: "detailed", groupReply: "all", access: { userIds: ["42"], chatIds: ["-9"] } });
  f.telegram.sendUserMessage({ userId: 42, chatId: -9, chatType: "group", text: "FX_TOOL" });
  const reply = await f.telegram.waitForRequest(r => r.method === "sendRichMessage" && String(r.payload.chat_id) === "-9");
  expect(JSON.stringify(reply.payload.rich_message)).toContain("fake streamed text");
  expect(JSON.stringify(reply.payload.rich_message)).not.toContain('"type":"details"');
  expect(f.telegram.calls("sendRichMessageDraft")).toHaveLength(0);
});

test("external events use the destination chat style", async () => {
  const f = await setup({ output: "detailed", chatFormats: { "42": "final" }, access: { userIds: ["42", "43"], chatIds: ["-9"] } });
  for (const chat of ["42", "43", "-9"]) {
    const p = Bun.spawn([binary, "emit", "fixture.format", "--chat", chat, "--prompt", "FX_TOOL", "--wait"], {
      cwd: f.dir, env: f.env, stdout: "pipe", stderr: "pipe",
    });
    const [status, error] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(status, error).toBe(0);
    const reply = await f.telegram.waitForRequest(r => r.method === "sendRichMessage" && String(r.payload.chat_id) === chat);
    expect(JSON.stringify(reply.payload.rich_message).includes('"type":"details"')).toBe(chat === "43");
  }
}, 25_000);
