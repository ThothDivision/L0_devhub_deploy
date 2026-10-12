import { readFileSync } from 'node:fs';
import { GAME_SERVER_PRESETS, gamePresetEnvErrors, isSensitiveGameEnv, gameImageError, gameSummaryEnv } from '../lib/game-server-presets.ts';
const page=readFileSync(new URL('../app/new/page.tsx',import.meta.url),'utf8');
const form=readFileSync(new URL('../components/game-hosting.tsx',import.meta.url),'utf8');
const settings=readFileSync(new URL('../../crates/hive-cloud/src/project_settings.rs',import.meta.url),'utf8');
let checks=0;
function check(ok,message){checks++;if(!ok)throw new Error(message);}
const expected={minecraft:[25565,'tcp','/data',[]],terraria:[7777,'tcp','/opt/terraria/config',[]],factorio:[34197,'udp','/factorio',[]],palworld:[8211,'udp','/palworld',[]],valheim:[2456,'udp','/config',[2457,2458]],arma3:[2302,'udp','/arma3/server',[2303,2304,2305,2306]],'ark-ase':[7777,'udp','/app',[7778,27015]],gesource:[27015,'udp','/app/gesource/logs',[]],romestead:[8050,'udp','/home/steam/server-files',[]],dst:[10999,'udp','/data',[11000,12346,12347]],tf2:[27015,'udp','/home/tf2/devhub-data',[]]};
// Presets whose upstream image exposes no env controls (command-line/cfg configured only).
const NO_ENV_CONTROLS=new Set([]);
check(GAME_SERVER_PRESETS.length===11,'eleven identities required');
check(new Set(GAME_SERVER_PRESETS.map(p=>p.gameId)).size===11,'duplicate identities');
for(const t of GAME_SERVER_PRESETS){
 const [port,protocol,path,extras]=expected[t.gameId];
 check(t.port===port && t.protocol===protocol && t.volumeMountPath===path,t.name+' wrong transport/persistence');
 check(JSON.stringify((t.extraPorts??[]).map(p=>p.port))===JSON.stringify(extras),t.name+' wrong extra ports');
 check((NO_ENV_CONTROLS.has(t.gameId)?Array.isArray(t.fields)&&t.fields.length===0&&Object.keys(t.env).length===0:t.fields?.length>0) && t.profiles?.length>0 && t.imageTags?.length>0,t.name+' missing configure metadata');
 check(new Set(t.fields.map(f=>f.key)).size===t.fields.length,'duplicate fields');
 check(gameImageError(t,t.image)===undefined,'valid default image rejected');
 check(gameImageError(t,t.image.replace(/:[^/:]+$/,'@sha256:'+'a'.repeat(64)))===undefined,'valid digest rejected');
 for(const image of ['',t.image+':bad','other/repo:latest',t.image+'\n']) check(!!gameImageError(t,image),'bad image accepted');
 check(gamePresetEnvErrors(t,t.env).length===t.requiredEnv.length,t.name+' default env regression');
 const env={...t.env};
 for(const rule of t.requiredEnv){check(env[rule.key]==='','credential default not empty');check(isSensitiveGameEnv(rule.key),'credential masking missing');env[rule.key]='sentinel-'+ 'x'.repeat(rule.minLength);}
 check(!gamePresetEnvErrors(t,env).length,'valid env rejected');
 for(const rule of t.requiredEnv){const missing={...env};delete missing[rule.key];check(gamePresetEnvErrors(t,missing).length>0,'missing credential accepted');check(gamePresetEnvErrors(t,{...env,[rule.key]:' '.repeat(rule.minLength)}).length>0,'whitespace credential accepted');if(rule.minLength>1)check(gamePresetEnvErrors(t,{...env,[rule.key]:'x'.repeat(rule.minLength-1)}).length>0,'short credential accepted');}
 for(const f of t.fields){
  if(f.kind==='secret'){check(isSensitiveGameEnv(f.key),'typed secret unmasked');check(settings.includes('"'+f.key+'"'),'backend policy missing '+f.key);}
  if(f.kind==='integer')for(const value of ['-1','1.5','NaN',String(f.max+1)])check(gamePresetEnvErrors(t,{...env,[f.key]:value}).length>0,'bad integer accepted');
  if(f.kind==='select')check(gamePresetEnvErrors(t,{...env,[f.key]:'fabricated-option'}).length>0,'bad select accepted');
  if(f.kind==='ids')for(const value of ['abc','1,,2','-1'])check(gamePresetEnvErrors(t,{...env,[f.key]:value}).length>0,'bad mods accepted');
 }
 for(const p of t.profiles)check(!gamePresetEnvErrors(t,{...env,...p.env}).length,'bad profile '+p.id);
 check(!JSON.stringify(gameSummaryEnv({...env,CUSTOM_KEY:'sentinel-secret'})).includes('sentinel'),'summary leaks values');
 check(!gamePresetEnvErrors(t,{...env,CUSTOM_KEY:'sentinel'}).join(' ').includes('sentinel'),'error leaks values');
}
const mc=GAME_SERVER_PRESETS.find(t=>t.gameId==='minecraft');
for(const VERSION of ['latest','fake-release','1.2.3.4','1.2;echo'])check(gamePresetEnvErrors(mc,{...mc.env,VERSION}).length>0,'bad runtime version accepted');
check(gamePresetEnvErrors(mc,{...mc.env,TYPE:'PAPER',VERSION:'SNAPSHOT'}).length>0,'Paper snapshot accepted');
check(gamePresetEnvErrors(mc,{}).length>0,'missing EULA accepted');
const ark=GAME_SERVER_PRESETS.find(t=>t.gameId==='ark-ase');
check(ark.name.includes('Survival Evolved') && ark.env.STEAM_LOGIN==='anonymous','ARK wrong identity/login');
check(!ark.extraPorts.some(p=>p.port===27020),'RCON publicly exposed');
check(ark.env.UDP_SOCKET_PORT===String(ark.port+1),'ARK adjacent port mismatch');
const ge=GAME_SERVER_PRESETS.find(t=>t.gameId==='gesource');
check(ge.image.startsWith('ghcr.io/solutionsasservice/gamesvr-gesource:')&&ge.platform==='linux/amd64','GE:S wrong image/platform');
check(!ge.setupNotes.some(n=>n.includes('STARTUP COMMAND REQUIRED')),'GE:S derived image has an entrypoint; stale startup note');
check(!(ge.extraPorts??[]).length&&ge.protocol==='udp','GE:S must not publish RCON TCP');
check(ge.env.GES_MAP==='ge_archives'&&ge.env.GES_MAXPLAYERS==='16'&&ge.env.GES_PASSWORD===''&&ge.env.GES_RCON_PASSWORD===''&&!ge.requiredEnv.length,'GE:S defaults');
for(const key of ['GES_PASSWORD','GES_RCON_PASSWORD'])check(ge.fields.find(f=>f.key===key)?.kind==='secret'&&isSensitiveGameEnv(key)&&settings.includes('"'+key+'"'),'GE:S secret policy '+key);
for(const [k,v] of [['GES_MAP','ge_archives;quit'],['GES_MAP','../x'],['GES_MAP',''],['GES_MAXPLAYERS','0'],['GES_MAXPLAYERS','33'],['GES_HOSTNAME','a";quit'],['GES_HOSTNAME','a;quit'],['GES_HOSTNAME','$(id)'],['GES_HOSTNAME','a`id`'],['GES_HOSTNAME','a\\b'],['GES_HOSTNAME',''],['GES_HOSTNAME','x'.repeat(64)],['GES_PASSWORD','a b'],['GES_PASSWORD','a;rcon'],['GES_PASSWORD','a"b'],['GES_RCON_PASSWORD','x;quit'],['GES_RCON_PASSWORD','$x'],['GES_RCON_PASSWORD','x'.repeat(65)]])check(gamePresetEnvErrors(ge,{...ge.env,[k]:v}).length>0,'GE:S unsafe '+k+' accepted');
for(const [k,v] of [['GES_MAP','ge_depot'],['GES_HOSTNAME',"Bond's [MI6] Server #1 (EU)"],['GES_PASSWORD','mi6-secret'],['GES_RCON_PASSWORD','r@con!']])check(!gamePresetEnvErrors(ge,{...ge.env,[k]:v}).length,'GE:S valid '+k+' rejected');
const dst=GAME_SERVER_PRESETS.find(t=>t.gameId==='dst');
check(dst.image.startsWith('jamesits/dst-server:')&&dst.platform==='linux/amd64'&&dst.env.DST_CLUSTER_TOKEN===''&&dst.requiredEnv.some(r=>r.key==='DST_CLUSTER_TOKEN'),'DST token must be empty and required');
check(dst.fields.find(f=>f.key==='DST_CLUSTER_TOKEN')?.kind==='secret'&&isSensitiveGameEnv('DST_CLUSTER_TOKEN')&&settings.includes('"DST_CLUSTER_TOKEN"'),'DST token must be masked/secret');
check(dst.setupNotes[0].startsWith('MULTI-PORT / NO-NAT LIMIT'),'DST port limits must be disclosed first');
check(dst.extraPorts.every(p=>p.protocol==='udp'),'DST ports must be UDP');
for(const v of ['a b','tok\ten','x\u0000'])check(gamePresetEnvErrors(dst,{...dst.env,DST_CLUSTER_TOKEN:v}).length>0,'DST unsafe token accepted');
check(!gamePresetEnvErrors(dst,{...dst.env,DST_CLUSTER_TOKEN:'pds-g^KU_abc^xyz='}).length,'DST valid token rejected');
const tf2=GAME_SERVER_PRESETS.find(t=>t.gameId==='tf2');
check(tf2.image.startsWith('ghcr.io/melkortf/tf2-base/amd64:')&&tf2.platform==='linux/amd64','TF2 wrong image/platform');
check(!(tf2.extraPorts??[]).length&&tf2.protocol==='udp'&&tf2.env.PORT==='27015','TF2 must publish 27015/UDP only');
check(tf2.env.RCON_PASSWORD===''&&tf2.requiredEnv.some(r=>r.key==='RCON_PASSWORD'&&r.minLength>=8),'TF2 RCON password must replace upstream 123456');
check(!['/home/tf2/server','/home/tf2/server/tf','/home/tf2/server/tf/maps','/home/tf2/server/tf/cfg'].includes(tf2.volumeMountPath),'TF2 volume shadows game files');
for(const key of ['SERVER_PASSWORD','RCON_PASSWORD','SERVER_TOKEN','STV_PASSWORD'])check(tf2.fields.find(f=>f.key===key)?.kind==='secret'&&isSensitiveGameEnv(key)&&settings.includes('"'+key+'"'),'TF2 secret policy '+key);
const tfOk={...tf2.env,RCON_PASSWORD:'private-rcon-1'};
for(const [k,v] of [['RCON_PASSWORD','123 4567'],['RCON_PASSWORD','abc*defg'],['RCON_PASSWORD','pass;quit1'],['RCON_PASSWORD','short'],['SERVER_PASSWORD','a"b'],['SERVER_PASSWORD','a;b'],['STV_PASSWORD','a b'],['SERVER_HOSTNAME','x";rcon_password "y'],['SERVER_HOSTNAME','$(id)'],['SERVER_HOSTNAME',''],['SERVER_TOKEN','notahexgslt'],['SERVER_TOKEN','A'.repeat(32)+'0'],['PORT','27016'],['ENABLE_FAKE_IP','2']])check(gamePresetEnvErrors(tf2,{...tfOk,[k]:v}).length>0,'TF2 unsafe '+k+' accepted');
for(const [k,v] of [['SERVER_TOKEN','0123456789ABCDEF0123456789abcdef'],['SERVER_PASSWORD','pyro-only'],['SERVER_HOSTNAME','My TF2 | 2Fort (24/7)'],['ENABLE_FAKE_IP','1']])check(!gamePresetEnvErrors(tf2,{...tfOk,[k]:v}).length,'TF2 valid '+k+' rejected');
const rs=GAME_SERVER_PRESETS.find(t=>t.gameId==='romestead');
check(rs.env.PUID&&rs.env.PGID&&rs.env.PORT===String(rs.port)&&rs.env.UPDATE_ON_START==='true','Romestead required defaults');
check(rs.env.PASSWORD===''&&isSensitiveGameEnv('PASSWORD'),'Romestead password default/masking');
for(const [k,v] of [['PASSWORD','a"b'],['PASSWORD','a\\b'],['AUTO_START_WORLD_NAME','$(id)'],['AUTO_START_WORLD_NAME','`id`'],['AUTO_CREATE_WORLD_SEED','12 34'],['PORT','9000'],['PUID',''],['PGID','x']])check(gamePresetEnvErrors(rs,{...rs.env,[k]:v}).length>0,'Romestead unsafe '+k+' accepted');
for(const [k,v] of [['PASSWORD','correct-horse'],['AUTO_START_WORLD_NAME','My World'],['AUTO_CREATE_WORLD_SEED','abc-123'],['AUTO_CREATE_WORLD_SEED','null']])check(!gamePresetEnvErrors(rs,{...rs.env,[k]:v}).length,'Romestead valid '+k+' rejected');
check(form.includes('game.fields?.length ?'),'no-env-controls fallback missing');
for(const key of ['PASSWORD','STEAM_LOGIN','BETA_ACCESSCODE','DISCORD_WEBHOOK_URL'])check(settings.includes('"'+key+'"')&&isSensitiveGameEnv(key),'secret policy missing '+key);
check(page.includes('<GamesMenu')&&page.includes('<ConfigureGame')&&page.includes('TEMPLATES.filter(t => !t.gameId)'),'Games grouping not wired');
check(page.includes('volume_mount_path: opts.volumeMountPath')&&page.includes('image: opts.image'),'payload image/volume missing');
for(const fragment of ['aria-label="Games"','htmlFor={"game-" + f.key}','id={"game-" + f.key}','Back to Games','Back to configuration','Review configuration','stage !== "review"','!game.extraPorts?.length || ingress','gameSummaryEnv(env)','type={f.kind === "secret" ? "password"','volumeMountPath: game.volumeMountPath','port: game.port','env, volumeMountPath','raw server errors are not shown'])check(form.includes(fragment),'form source guard missing '+fragment);
check(settings.includes('game_secret || looks_like_secret(&value.value)'),'encrypted policy missing');
console.log('PASS '+checks+' offline catalog/schema/source checks; all eleven games. No browser, registry or game-runtime proof.');
