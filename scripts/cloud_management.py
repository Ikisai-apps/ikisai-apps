"""Management API client. Tokens stay in ignored files; redirects and arbitrary hosts are rejected."""
import json,os,re,urllib.error,urllib.request
from pathlib import Path

class CloudError(Exception):
 def __init__(self,status,code='CLOUD_REQUEST_FAILED'):self.status=status;self.code=code;super().__init__(code)
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
DATABASE_ERRORS={'CURSOR_CONFLICT','ACCESS_CONTEXT_CHANGED','IDEMPOTENCY_REUSE','FORBIDDEN','NO_MEMBERSHIP','DEPENDENCY_CYCLE','APP_NOT_FOUND','APP_EXISTS_NO_OVERWRITE','INVALID_REQUEST','INVALID_EVENT','INVALID_STATE','INVALID_PARENT','LAST_ACTIVE_TAB','INBOX_PROTECTED'}
class SupabaseManagement:
 def __init__(self,file=None):
  file=file or Path(__file__).resolve().parents[1]/'private/cloud-credentials.json'
  config={'projectRef':'ctytaorylbninfyupfsn','accessToken':os.environ['SUPABASE_ACCESS_TOKEN']} if os.environ.get('SUPABASE_ACCESS_TOKEN') else json.loads(Path(file).read_text(encoding='utf-8'))['supabase']
  if config.get('projectRef')!='ctytaorylbninfyupfsn' or not isinstance(config.get('accessToken'),str) or not config['accessToken'].startswith('sbp_'):raise ValueError('Invalid authorized project or administrative token')
  self.ref=config['projectRef'];self.token=config['accessToken'];self.base='https://api.supabase.com/v1/projects/'+self.ref;self.opener=urllib.request.build_opener(NoRedirect())
 def request(self,path,body=None,method=None):
  if not isinstance(path,str) or not re.fullmatch(r'/[A-Za-z0-9_/-]+',path) or '..' in path:raise ValueError('Invalid API route')
  payload=None if body is None else json.dumps(body,ensure_ascii=False,allow_nan=False).encode('utf-8')
  req=urllib.request.Request(self.base+path,data=payload,method=method,headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json','Accept':'application/json'})
  try:
   with self.opener.open(req,timeout=45) as response:
    raw=response.read();return json.loads(raw) if raw else None
  except urllib.error.HTTPError as e:
   # Return only a known domain error name, never the provider body or SQL context.
   raw=e.read(16384).decode('utf-8',errors='replace');code='CLOUD_REQUEST_FAILED'
   for expected in DATABASE_ERRORS:
    if re.search(r'\b'+expected+r'\b',raw):code=expected;break
   sqlstate=re.search(r'ERROR:\s*([A-Z0-9]{5}):',raw)
   if code=='CLOUD_REQUEST_FAILED' and sqlstate:code='DATABASE_ERROR_'+sqlstate.group(1)
   raise CloudError(e.code,code) from None
  except (urllib.error.URLError,TimeoutError,OSError):raise CloudError(None,'CLOUD_NETWORK_FAILED') from None
 def query(self,sql,parameters=None,read_only=False):
  body={'query':sql,'read_only':read_only}
  if parameters is not None:body['parameters']=parameters
  return self.request('/database/query',body)
