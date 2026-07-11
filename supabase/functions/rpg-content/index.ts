import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type, x-rpg-key","Access-Control-Allow-Methods":"POST, OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const required=(value:unknown,field:string)=>{if(typeof value!=="string"||!value.trim())throw new Error(`${field}_required`);return value.trim();};
const optional=(value:unknown)=>typeof value==="string"&&value.trim()?value.trim():null;
const objectValue=(value:unknown):Record<string,unknown>=>typeof value==="object"&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{};
const isUuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

async function resolveWorldId(supabase:SupabaseClient,ownerId:string,reference:string){
  if(isUuid(reference))return reference;
  const {data,error}=await supabase.from("rpg_worlds").select("id").eq("owner_id",ownerId).or(`slug.ilike.${reference},name.ilike.${reference}`).limit(1).maybeSingle();
  if(error)throw error;
  if(!data?.id)throw new Error("world_not_found");
  return data.id as string;
}

async function resolveCampaignId(supabase:SupabaseClient,ownerId:string,worldId:string,reference:string|null){
  if(!reference)return null;
  if(isUuid(reference))return reference;
  const {data,error}=await supabase.from("rpg_campaigns").select("id").eq("owner_id",ownerId).eq("world_id",worldId).ilike("name",reference).limit(1).maybeSingle();
  if(error)throw error;
  if(!data?.id)throw new Error("campaign_not_found");
  return data.id as string;
}

async function resolveCharacterId(supabase:SupabaseClient,ownerId:string,reference:string){
  if(isUuid(reference))return reference;
  const {data,error}=await supabase.from("rpg_characters").select("id").eq("owner_id",ownerId).ilike("name",reference).limit(1).maybeSingle();
  if(error)throw error;
  if(!data?.id)throw new Error("character_not_found");
  return data.id as string;
}

async function resolveContentId(supabase:SupabaseClient,ownerId:string,characterId:string,reference:string){
  if(isUuid(reference))return reference;
  const {data:character,error:characterError}=await supabase.from("rpg_characters").select("campaign_id").eq("id",characterId).eq("owner_id",ownerId).maybeSingle();
  if(characterError)throw characterError;
  if(!character?.campaign_id)throw new Error("character_not_found");
  const {data:campaign,error:campaignError}=await supabase.from("rpg_campaigns").select("world_id").eq("id",character.campaign_id).eq("owner_id",ownerId).maybeSingle();
  if(campaignError)throw campaignError;
  if(!campaign?.world_id)throw new Error("campaign_not_found");
  const {data,error}=await supabase.from("rpg_content_catalog").select("id").eq("owner_id",ownerId).eq("world_id",campaign.world_id).eq("status","active").or(`code.ilike.${reference},name.ilike.${reference}`).or(`scope.eq.world,and(scope.eq.campaign,campaign_id.eq.${character.campaign_id})`).limit(1).maybeSingle();
  if(error)throw error;
  if(!data?.id)throw new Error("content_not_found");
  return data.id as string;
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  try{
    const url=Deno.env.get("SUPABASE_URL");
    const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey=req.headers.get("x-rpg-key");
    if(!url||!serviceKey)return reply({error:{code:"CONFIGURATION_ERROR",message:"Configuração interna ausente"}},500);
    if(!apiKey)return reply({error:{code:"API_KEY_REQUIRED",message:"Chave obrigatória"}},401);

    const supabase=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const auth=await supabase.rpc("rpg_validate_api_key",{p_api_key:apiKey});
    if(auth.error||!auth.data)return reply({error:{code:"INVALID_API_KEY",message:"Chave inválida"}},401);
    const ownerId=auth.data as string;

    const path=new URL(req.url).pathname.split("/rpg-content")[1]||"";
    const body=await req.json().catch(()=>({})) as Record<string,unknown>;
    let result;

    if(path==="/search"&&req.method==="POST"){
      const worldId=await resolveWorldId(supabase,ownerId,required(body.world_id,"world_id"));
      const campaignId=await resolveCampaignId(supabase,ownerId,worldId,optional(body.campaign_id));
      result=await supabase.rpc("rpg_gateway_search_content",{
        p_api_key:apiKey,
        p_world_id:worldId,
        p_campaign_id:campaignId,
        p_content_type:optional(body.content_type),
        p_query:optional(body.query),
        p_limit:typeof body.limit==="number"?body.limit:20,
      });
    } else if(path==="/upsert"&&req.method==="POST"){
      const worldId=await resolveWorldId(supabase,ownerId,required(body.world_id,"world_id"));
      const campaignId=await resolveCampaignId(supabase,ownerId,worldId,optional(body.campaign_id));
      result=await supabase.rpc("rpg_gateway_upsert_content",{
        p_api_key:apiKey,
        p_world_id:worldId,
        p_campaign_id:campaignId,
        p_content_type:required(body.content_type,"content_type"),
        p_content:objectValue(body.content),
      });
    } else if(path==="/character"&&req.method==="POST"){
      const characterId=await resolveCharacterId(supabase,ownerId,required(body.character_id,"character_id"));
      const contentRef=required(body.content_id,"content_id");
      const contentId=await resolveContentId(supabase,ownerId,characterId,contentRef);
      result=await supabase.rpc("rpg_gateway_manage_character_content",{
        p_api_key:apiKey,
        p_character_id:characterId,
        p_operation:required(body.operation,"operation"),
        p_content_id:contentId,
        p_changes:objectValue(body.changes),
      });
    } else return reply({error:{code:"ROUTE_NOT_FOUND",message:"Rota não encontrada"}},404);

    if(result.error)throw result.error;
    return reply({result:result.data});
  }catch(error){
    const message=error instanceof Error?error.message:"Erro interno";
    console.error(error);
    return reply({error:{code:message.toUpperCase().replace(/[^A-Z0-9]+/g,"_"),message,retryable:false}},400);
  }
});