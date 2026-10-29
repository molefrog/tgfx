import { resolve } from "node:path";
const root=resolve(import.meta.dir,"..");
const binary=process.env.TGFX_CONFORMANCE_EXE??resolve(process.env.CARGO_TARGET_DIR??resolve(root,"target"),"debug/examples/conformance");
function request(value:unknown):any{const r=Bun.spawnSync([binary],{stdin:new TextEncoder().encode(JSON.stringify(value)),stdout:"pipe",stderr:"pipe"});if(r.exitCode)throw new Error(new TextDecoder().decode(r.stderr));return JSON.parse(new TextDecoder().decode(r.stdout));}
function stripDefaults(v:any):any{if(Array.isArray(v))return v.map(stripDefaults);if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).filter(([k,v])=>!(v===false&&["is_header","is_checked"].includes(k))).map(([k,v])=>[k,stripDefaults(v)]));return v;}
export function markdownToRichBlocks(source:string){return stripDefaults(request({op:"markdown",source}).blocks??[]);}
export class AcpProjector{
 private events:any[]=[];private started:number;
 constructor(private icons:Record<string,string>={},private clock:()=>number=Date.now){this.started=clock();}
 // Preserve the legacy renderer assertions under the three renamed styles.
 // `report` shared Detailed's final projection; its delivery mode was removed.
 private state(output="live",final=false){const modes:Record<string,string>={answer:"final",progress:"live",live:"detailed",report:"detailed"};return request({op:"projector",icons:this.icons,started:this.started,events:this.events,now:this.clock(),output:modes[output]??output,final});}
 apply(value:unknown){this.events.push({value,at:this.clock()});return this.state().change;}
 setWaiting(waiting:string|undefined){this.events.push({waiting:waiting??null,at:this.clock()});return this.state().change;}
 snapshot(){return this.state().snapshot;}
 rich(options:{output:string;final:boolean}){return stripDefaults(this.state(options.output,options.final).rich);}
 plainFinal(output:string){return this.state(output,true).plain;}
}

const toolsRegistry=request({op:"tools",action:"registry"});
export const FX_TOOLS=Object.fromEntries(toolsRegistry.names.map((name:string)=>[name,{}]));
export const TOOL_ACTIVITY_ORDER=toolsRegistry.activities;
export function describeTool(call:Record<string,unknown>){return request({op:"tools",...call});}
export function activitySummary(activity:string,count:number){return request({op:"tools",action:"summary",activity,count});}

function cleanNull(v:any):any{if(Array.isArray(v))return v.map(cleanNull);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([,v])=>v!==null).map(([k,v])=>[k,cleanNull(v)]));return v;}
export const SESSION_BOOTSTRAP_INSTRUCTIONS=request({op:"bootstrap"});
export function normalizeMessageUpdate(bot:any,update:any,lookup?:(chat:string,id:string)=>string|undefined){const m=update.message??update.edited_message??update.channel_post??update.edited_channel_post;const refs:any={};if(m&&lookup){for(const msg of [m,m.reply_to_message].filter(Boolean)){const value=lookup(String(m.chat.id),String(msg.message_id));if(value)refs[`${m.chat.id}:${msg.message_id}`]=value;}}const result=cleanNull(request({op:"normalize",bot,update,lookup:refs}));if(!result)return undefined;result.timestamp=new Date(result.timestamp);return result;}
export function toEnvelope(message:any,options:any={}){return request({op:"envelope",message,bootstrap:options.sessionBootstrap??false});}
export function commandFromText(text:string|undefined,username?:string){return request({op:"command",text,username})??undefined;}
export function groupMigrationFromUpdate(update:any){return cleanNull(request({op:"migration",update}))??undefined;}
export function isAuthorized(config:any,message:any){return request({op:"authorized",config,message});}
export function shouldInvokeAgent(message:any,username?:string,botId?:string,policy?:string){return request({op:"invoke",message,username,botId,policy});}
const catalog=request({op:"icons"});export const TGFX_CUSTOM_ICONS=catalog.icons;export const TGFX_CUSTOM_ICON_SET=catalog.set;
export function customIcons(kind:string){return request({op:"icons",kind}).icons;}
export function providerIconsFromStickerSet(stickers:any[]){return request({op:"provider_icons",stickers});}
function view(v:any){if(v===null)return undefined;return {text:v.text,replyMarkup:v.reply_markup};}
export function providerPicker(data:any,page=0,icons:any={}){return view(request({op:"model_picker_icons",options:data.options,current:data.currentValue,id:data.interactionId,page,icons}));}
export function modelPicker(data:any,provider:number,page=0,icons:any={}){return view(request({op:"model_picker_icons",options:data.options,current:data.currentValue,id:data.interactionId,page,provider,icons}));}
export function selectedModel(model:any){return view(request({op:"selected_model",model}));}
export function replyStylePicker(current:string){return view(request({op:"reply_style",current}));}
export function sessionConfirmation(action:string,id:string){return request({op:"session_confirmation",action,id});}
export function costReport(report:any){const v=request({op:"cost_report",report});return{richMessage:stripDefaults(v.rich_message),replyMarkup:v.reply_markup};}
export function parseFxUsage(source:string){return request({op:"parse_usage",source});}
