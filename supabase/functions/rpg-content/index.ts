import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type, x-rpg-key","Access-Control-Allow-Methods":"POST, OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const required=(value:unknown,field:string)=>{if(typeof value!=="string"||!value.trim())throw new Error(`${field}_required`);return value.trim();};
const optional=(value:unknown)=>typeof value==="string"&&value.trim()?value.trim():null;
const objectValue=(value:unknown):Record<string,unknown>=>typeof value==="object"&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{};

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

    const path=new URL(req.url).pathname.split("/rpg-content")[1]||"";
    const body=await req.json().catch(()=>({})) as Record<string,unknown>;
    let result;

    if(path==="/search"&&req.method==="POST"){
      result=await supabase.rpc("rpg_gateway_search_content",{
        p_api_key:apiKey,
        p_world_id:required(body.world_id,"world_id"),
        p_campaign_id:optional(body.campaign_id),
        p_content_type:optional(body.content_type),
        p_query:optional(body.query),
        p_limit:typeof body.limit==="number"?body.limit:20,
      });
    } else if(path==="/upsert"&&req.method==="POST"){
      result=await supabase.rpc("rpg_gateway_upsert_content",{
        p_api_key:apiKey,
        p_world_id:required(body.world_id,"world_id"),
        p_campaign_id:optional(body.campaign_id),
        p_content_type:required(body.content_type,"content_type"),
        p_content:objectValue(body.content),
      });
    } else if(path==="/character"&&req.method==="POST"){
      result=await supabase.rpc("rpg_gateway_manage_character_content",{
        p_api_key:apiKey,
        p_character_id:required(body.character_id,"character_id"),
        p_operation:required(body.operation,"operation"),
        p_content_id:required(body.content_id,"content_id"),
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