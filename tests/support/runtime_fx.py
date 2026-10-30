#!/usr/bin/env python3
"""Log real ACP stdin requests then run the shared concurrent protocol fixture."""
import sys, os, json
original = sys.stdin
class LoggingInput:
 def __iter__(self): return self
 def __next__(self):
  line = next(original)
  path = os.environ.get('RUNTIME_FX_LOG')
  if path:
   with open(path, 'a') as f: f.write(line)
  if path and os.environ.get('RUNTIME_HANG_INITIALIZE_ONCE') == '1' and json.loads(line).get('method') == 'initialize' and not os.path.exists(path+'.hung'):
   open(path+'.hung','w').close()
   import urllib.request, threading
   urllib.request.urlopen(urllib.request.Request(os.environ['RUNTIME_FX_READY_URL'],b'{}',{'Content-Type':'application/json'}),timeout=3).close()
   threading.Event().wait()
  if path and os.environ.get('RUNTIME_HOLD_LOAD') == '1' and json.loads(line).get('method') == 'session/load':
   import time
   open(path+'.loading','w').close()
   while not os.path.exists(path+'.resume'): time.sleep(.01)
  return line
sys.stdin = LoggingInput()
path = os.path.join(os.path.dirname(__file__), 'fx_fixture.py')
exec(compile(open(path).read(),path,'exec'))
