import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type, x-rpg-key","Access-Control-Allow-Methods":"POST, OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const required=(value:unknown,field:string)=>{if(typeof value!=="string"||!value.trim())throw new Error(`${field}_required`);return value.trim();};
const optional=(value:unknown)=>typeof value==="string"&&value.trim()?value.trim():null;
const objectValue=(value:unknown):Record<string,unknown>=>typeof value==="object"&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{};
const isUuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const secretKeys=new Set(["x-rpg-key","api_key","apikey","authorization","token","access_token","refresh_token","service_role_key","password","secret"]);

function sanitize(value:unknown,depth=0):unknown{
  if(depth>6)return "[max_depth]";
  if(Array.isArray(value))return value.slice(0,50).map(v=>sanitize(v,depth+1));
  if(value&&typeof value==="object"){
    const output:Record<string,unknown>={};
    for(const [key,item] of Object.entries(value as Record<string,unknown>)){
      output[key]=secretKeys.has(key.toLowerCase())?"[redacted]":sanitize(item,depth+1);
    }
    return output;
  }
  if(typeof value==="string"&&value.length>2000)return `${value.slice(0,2000)}...[truncated]`;
  return value;
}

async function auditEvent(supabase:SupabaseClient|undefined,requestId:string,stage:string,data:Record<string,unknown>={}){
  if(!supabase)return;
  try{await supabase.from("rpg_api_request_log_events").insert({request_id:requestId,stage,data:sanitize(data)});}catch(error){console.error("audit_event_failed",error);}
}

async function auditUpdate(supabase:SupabaseClient|undefined,requestId:string,changes:Record<string,unknown>){
  if(!supabase)return;
  try{await supabase.from("rpg_api_request_logs").update(sanitize(changes) as Record<string,unknown>).eq("request_id",requestId);}catch(error){console.error("audit_update_failed",error);}
}

async function resolveWorldId(supabase:SupabaseClient,ownerId:string,reference:string){
  if(isUuid(reference))return {id:reference,method:"world_id"};
  const {data,error}=await supabase.from("rpg_worlds").select("id").eq("owner_id",ownerId).or(`slug.ilike.${reference},name.ilike.${reference}`).limit(1).maybeSingle();
  if(error)throw error;
  if(!data?.id)throw new Error("world_not_found");
  return {id:data.id as string,method:"world_slug_or_name"};
}

async function resolveCampaignId(supabase:SupabaseClient,ownerId:string,worldId:string,reference:string|null){
  if(!reference)return {id:null,method:"world_scope"};
  if(isUuid(reference))return {id:reference,method:"campaign_id"};
  const {data,error}=await supabase.from("rpg_campaigns").select("id").eq("owner_id",ownerId).eq("world_id",worldId).ilike("name",reference).limit(1).maybeSingle();
  if(error)throw error;
  if(!data?.id)throw new Error("campaign_not_found");
  return {id:data.id as string,method:"campaign_name"};
}

async function resolveCharacterId(supabase:SupabaseClient,ownerId:string,reference:string){
  if(isUuid(reference)){
    const {data:character,error:characterError}=await supabase.from("rpg_characters").select("id").eq("owner_id",ownerId).eq("id",reference).maybeSingle();
    if(characterError)throw characterError;
    if(character?.id)return {id:character.id as string,method:"character_id"};
    const {data:actor,error:actorError}=await supabase.from("rpg_actors").select("source_id").eq("owner_id",ownerId).eq("id",reference).eq("source_kind","character").maybeSingle();
    if(actorError)throw actorError;
    if(actor?.source_id)return {id:actor.source_id as string,method:"actor_id"};
  }else{
    const {data,error}=await supabase.from("rpg_characters").select("id").eq("owner_id",ownerId).ilike("name",reference).limit(1).maybeSingle();
    if(error)throw error;
    if(data?.id)return {id:data.id as string,method:"character_name"};
  }
  const {data,error}=await supabase.from("rpg_characters").select("id").eq("owner_id",ownerId).limit(2);
  if(error)throw error;
  if(data?.length===1)return {id:data[0].id as string,method:"sole_owned_character_fallback"};
  throw new Error(data&&data.length>1?"character_reference_ambiguous":"character_not_found");
}

async function resolveContentId(supabase:SupabaseClient,ownerId:string,characterId:string,reference:string){
  if(isUuid(reference))return {id:reference,method:"content_id"};
  const {data:character,error:characterError}=await supabase.from("rpg_characters").select("campaign_id").eq("id",characterId).eq("owner_id",ownerId).maybeSingle();
  if(characterError)throw characterError;
  if(!character?.campaign_id)throw new Error("character_not_found");
  const {data:campaign,error:campaignError}=await supabase.from("rpg_campaigns").select("world_id").eq("id",character.campaign_id).eq("owner_id",ownerId).maybeSingle();
  if(campaignError)throw campaignError;
  if(!campaign?.world_id)throw new Error("campaign_not_found");
  const {data,error}=await supabase.from("rpg_content_catalog").select("id,code,name").eq("owner_id",ownerId).eq("world_id",campaign.world_id).eq("status","active").or(`code.ilike.${reference},name.ilike.${reference}`).limit(1).maybeSingle();
  if(error)throw error;
  if(!data?.id)throw new Error("content_not_found");
  return {id:data.id as string,method:String(data.code).toLowerCase()===reference.toLowerCase()?"content_code":"content_name"};
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const requestId=crypto.randomUUID();
  const startedAt=Date.now();
  let stage="initialization";
  let supabase:SupabaseClient|undefined;
  let body:Record<string,unknown>={};
  let route="unknown";
  let operationId="unknown";
  try{
    const url=Deno.env.get("SUPABASE_URL");
    const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey=req.headers.get("x-rpg-key");
    if(!url||!serviceKey)return reply({request_id:requestId,error:{code:"CONFIGURATION_ERROR",message:"Configuração interna ausente"}},500);
    supabase=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    route=new URL(req.url).pathname.split("/rpg-content")[1]||"";
    operationId=route==="/search"?"searchWorldContent":route==="/upsert"?"upsertWorldContent":route==="/character"?"manageCharacterContent":"unknown";
    body=await req.json().catch(()=>({})) as Record<string,unknown>;
    await supabase.from("rpg_api_request_logs").insert({request_id:requestId,route,operation_id:operationId,request_payload:sanitize(body),status:"started",edge_function:"rpg-content",edge_function_version:"3",api_key_present:Boolean(apiKey)});
    await auditEvent(supabase,requestId,"request_received",{method:req.method,route,operation_id:operationId,payload:sanitize(body) as Record<string,unknown>});
    if(!apiKey)throw new Error("api_key_required");

    stage="authentication";
    const auth=await supabase.rpc("rpg_validate_api_key",{p_api_key:apiKey});
    if(auth.error||!auth.data)throw new Error("invalid_api_key");
    const ownerId=auth.data as string;
    await auditUpdate(supabase,requestId,{owner_id:ownerId});
    await auditEvent(supabase,requestId,"authentication_validated",{owner_id:ownerId});

    let result;
    const resolved:Record<string,unknown>={};
    if(route==="/search"&&req.method==="POST"){
      stage="resolve_world";
      const world=await resolveWorldId(supabase,ownerId,required(body.world_id,"world_id"));
      resolved.world_id=world.id; resolved.world_resolution=world.method;
      stage="resolve_campaign";
      const campaign=await resolveCampaignId(supabase,ownerId,world.id,optional(body.campaign_id));
      resolved.campaign_id=campaign.id; resolved.campaign_resolution=campaign.method;
      await auditEvent(supabase,requestId,"references_resolved",resolved);
      stage="rpc_search_content";
      result=await supabase.rpc("rpg_gateway_search_content",{p_api_key:apiKey,p_world_id:world.id,p_campaign_id:campaign.id,p_content_type:optional(body.content_type),p_query:optional(body.query),p_limit:typeof body.limit==="number"?body.limit:20});
    }else if(route==="/upsert"&&req.method==="POST"){
      stage="resolve_world";
      const world=await resolveWorldId(supabase,ownerId,required(body.world_id,"world_id"));
      resolved.world_id=world.id; resolved.world_resolution=world.method;
      stage="resolve_campaign";
      const campaign=await resolveCampaignId(supabase,ownerId,world.id,optional(body.campaign_id));
      resolved.campaign_id=campaign.id; resolved.campaign_resolution=campaign.method;
      await auditEvent(supabase,requestId,"references_resolved",resolved);
      stage="rpc_upsert_content";
      result=await supabase.rpc("rpg_gateway_upsert_content",{p_api_key:apiKey,p_world_id:world.id,p_campaign_id:campaign.id,p_content_type:required(body.content_type,"content_type"),p_content:objectValue(body.content)});
    }else if(route==="/character"&&req.method==="POST"){
      stage="resolve_character";
      const character=await resolveCharacterId(supabase,ownerId,required(body.character_id,"character_id"));
      resolved.character_reference=body.character_id; resolved.character_id=character.id; resolved.character_resolution=character.method;
      stage="resolve_content";
      const content=await resolveContentId(supabase,ownerId,character.id,required(body.content_id,"content_id"));
      resolved.content_reference=body.content_id; resolved.content_id=content.id; resolved.content_resolution=content.method;
      await auditEvent(supabase,requestId,"references_resolved",resolved);
      stage="rpc_manage_character_content";
      result=await supabase.rpc("rpg_gateway_manage_character_content",{p_api_key:apiKey,p_character_id:character.id,p_operation:required(body.operation,"operation"),p_content_id:content.id,p_changes:objectValue(body.changes)});
    }else throw new Error("route_not_found");

    if(result.error)throw result.error;
    const durationMs=Date.now()-startedAt;
    const summary=sanitize(result.data) as Record<string,unknown>;
    await auditEvent(supabase,requestId,"rpc_completed",{status:"success",duration_ms:durationMs});
    await auditUpdate(supabase,requestId,{resolved_payload:resolved,response_summary:summary,status:"success",http_status:200,duration_ms:durationMs,completed_at:new Date().toISOString()});
    return reply({request_id:requestId,result:result.data});
  }catch(error){
    const message=error instanceof Error?error.message:"Erro interno";
    const code=message.toUpperCase().replace(/[^A-Z0-9]+/g,"_");
    const status=code==="API_KEY_REQUIRED"||code==="INVALID_API_KEY"?401:code==="ROUTE_NOT_FOUND"?404:400;
    const durationMs=Date.now()-startedAt;
    console.error({request_id:requestId,stage,code,message});
    await auditEvent(supabase,requestId,"request_failed",{stage,code,message,duration_ms:durationMs});
    await auditUpdate(supabase,requestId,{status:"error",http_status:status,error_code:code,error_message:message,error_stage:stage,duration_ms:durationMs,completed_at:new Date().toISOString()});
    return reply({request_id:requestId,error:{code,message,retryable:false,stage}},status);
  }
});