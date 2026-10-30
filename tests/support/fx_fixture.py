#!/usr/bin/env python3
"""A real stdio ACP peer. Concurrent worker prompts exercise ordered bidirectional dispatch."""
import json, os, sys, threading, time
lock=threading.Lock(); permissions={}; wait=threading.Event(); cancelled=False; ignore_cancel=False
usage_path=os.path.join(os.getcwd(), ".fixture-usage.json")
config=[{"id":"model","name":"Model","type":"select","currentValue":"fixture","options":[{"value":"fixture","name":"Fixture"},{"value":"next","name":"Next"}]},{"id":"mode","name":"Mode","type":"select","currentValue":"ask","options":[{"value":"auto","name":"Auto"},{"value":"ask","name":"Ask"}]}]
if os.environ.get("RUNTIME_MODEL_SETTINGS") == "1":
 models=["fixture", "anthropic/claude-opus"]+[f"openai/model-{i}" for i in range(8)]
 config[0]["options"]=[{"value":v,"name":v} for v in models]
 config.extend([
  {"id":"effort","name":"Reasoning effort","type":"select","currentValue":"auto","options":[{"value":v,"name":v} for v in ["auto","high","low"]]},
  {"id":"fast","name":"Fast","type":"boolean","currentValue":False},
  {"id":"ultrafast","name":"Ultrafast","type":"boolean","currentValue":False}])
def visible_config():
 if config[0]["currentValue"].startswith("anthropic/"):
  return [o for o in config if o["id"] not in ["effort","fast","ultrafast"]]
 return config
def send(v):
 with lock: print(json.dumps(v),flush=True)
def result(i,v):send({"jsonrpc":"2.0","id":i,"result":v})
def update(v):send({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fixture","update":v}})
def answer(i,p):
 global cancelled, ignore_cancel
 blocks=p.get("prompt",[]); text=blocks[-1].get("text","") if blocks else ""
 update({"sessionUpdate":"fixture_future_update","_meta":{"unknown":True}})
 if text=="USAGE" or os.environ.get("RUNTIME_USAGE")=="1":
  usage={"sessionUpdate":"usage_update","used":6400,"size":256000}
  update(usage)
  with open(usage_path,"w") as f:json.dump(usage,f)
  update({"sessionUpdate":"usage_update","used":0,"size":0})
 if p.get("_meta",{}).get("fx",{}).get("steer"):
  if text=="BLOCKS":update({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":json.dumps(blocks)}})
  cancelled=False;wait.set();result(i,{"stopReason":"end_turn"});return
 if text=="WAIT" or text=="IGNORE_CANCEL":
  wait.clear();cancelled=False;ignore_cancel=text=="IGNORE_CANCEL";update({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"WAIT_READY"}})
  wait.wait(20 if text=="IGNORE_CANCEL" else 5)
  result(i,{"stopReason":"cancelled" if cancelled else "end_turn"});return
 if text=="PERMISSION":
  event=threading.Event();permissions["p1"]=[event,None]
  send({"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"fixture","toolCall":{"toolCallId":"t","title":"Read fixture","kind":"read","status":"pending"},"options":[{"optionId":"reject","name":"Reject","kind":"reject_once"},{"optionId":"allow","name":"Allow","kind":"allow_once"}]}})
  event.wait(10);update({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":json.dumps(permissions["p1"][1])}})
 elif text=="CRASH":
  print("FIXTURE_CRASH",file=sys.stderr,flush=True);os._exit(17)
 elif text=="CHILD":
  import subprocess
  child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(100)"])
  update({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":str(child.pid)}})
 elif text=="ENV":
  update({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":json.dumps({k:v for k,v in os.environ.items() if k.startswith("TGFX_") or k=="TELEGRAM_BOT_TOKEN"})}})
 elif text=="BLOCKS":
  update({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":json.dumps(blocks)}})
 else:
  update({"sessionUpdate":"agent_thought_chunk","messageId":"thought-1","content":{"type":"text","text":"Considering"},"_meta":{"fx":{"retained":True}}})
  update({"sessionUpdate":"tool_call","toolCallId":"tool","name":"read_file","title":"Read","kind":"read","status":"pending","rawInput":{"path":"file.txt"},"_meta":{"futureField":123}})
  update({"sessionUpdate":"tool_call_update","toolCallId":"tool","status":"completed"})
  update({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text or "OK"},"_meta":{"fx":{"retained":True}}})
 result(i,{"stopReason":"max_tokens" if text=="MAX" else "end_turn"})
if "--version" in sys.argv:print("0.0.15");sys.exit()
if "doctor" in sys.argv:print(json.dumps({"fail_count":0,"warn_count":0,"model":"fixture","auth":"fixture","workspace":os.getcwd(),"checks":[]}));sys.exit()
if "usage" in sys.argv:
 totals={k:0 for k in ["total_tokens","input_tokens","output_tokens","cache_read_tokens","cache_write_tokens","reasoning_tokens","request_count","spend"]}
 provider=os.environ.get("RUNTIME_USAGE_PROVIDER","ai_gateway")
 if provider=="broken":print("unavailable",file=sys.stderr);sys.exit(1)
 totals["spend"]=6.94 if provider=="ai_gateway" else 0
 print(json.dumps({"kind":"usage","schema_version":2,"source":provider,"status":"unavailable" if provider=="unavailable" else "ready","period":sys.argv[sys.argv.index("--period")+1],"totals":totals,"models":[]}));sys.exit()
for line in sys.stdin:
 try:r=json.loads(line)
 except ValueError:continue
 if "method" not in r:
  if r.get("id") in permissions:permissions[r["id"]][1]=r.get("result");permissions[r["id"]][0].set()
  continue
 i=r.get("id");p=r.get("params",{});m=r["method"]
 if m=="initialize":result(i,{"protocolVersion":1,"agentCapabilities":{"loadSession":True},"agentInfo":{"name":"fx-fixture","version":"0.0.15"},"authMethods":[]})
 elif m=="session/new":result(i,{"sessionId":"fixture","configOptions":visible_config()})
 elif m=="session/load":
  if p["sessionId"]=="missing":send({"jsonrpc":"2.0","id":i,"error":{"code":-32602,"message":"missing session"}})
  else:
   if os.path.exists(usage_path):
    with open(usage_path) as f:update(json.load(f))
   result(i,{"configOptions":visible_config()})
 elif m=="session/set_config_option":
  if p["configId"] in ["effort","fast","ultrafast"] and os.environ.get("RUNTIME_REJECT_SETTINGS") == "1":
   send({"jsonrpc":"2.0","id":i,"error":{"code":-32602,"message":"setting unavailable"}});continue
  for o in config:
   if o["id"]==p["configId"]:o["currentValue"]=p["value"]
   elif p["configId"] in ["fast","ultrafast"] and p["value"] is True and o["id"] in ["fast","ultrafast"]:o["currentValue"]=False
  result(i,{"configOptions":visible_config()})
 elif m=="session/prompt":threading.Thread(target=answer,args=(i,p),daemon=True).start()
 elif m=="session/cancel":
  cancelled=True
  if not ignore_cancel:wait.set()
 elif m=="session/close":result(i,{})
 else:send({"jsonrpc":"2.0","id":i,"error":{"code":-32601,"message":"unknown method"}})
