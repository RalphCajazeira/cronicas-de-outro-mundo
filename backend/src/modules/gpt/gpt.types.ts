import type {
  CreateEventInput, ListCampaignActorsInput, LoadGameInput, ManageActorContentInput, ManageActorInventoryInput,
  ListPlayerWorldsInput, ListWorldCampaignsInput, PatchActorInput, ResolveActorEffectInput, StartGameInput, UpsertActorInput, UpsertContentInput,
} from './gpt.schemas.js';

export type ApiResult = Record<string, unknown> | Array<Record<string, unknown>>;

export interface GptRepository {
  loadGame(input: LoadGameInput): Promise<ApiResult>;
  listPlayerWorlds(input: ListPlayerWorldsInput): Promise<ApiResult>;
  listWorldCampaigns(input: ListWorldCampaignsInput): Promise<ApiResult>;
  startGame(input: StartGameInput): Promise<ApiResult>;
  listCampaignActors(input: ListCampaignActorsInput): Promise<ApiResult>;
  upsertActor(input: UpsertActorInput): Promise<ApiResult>;
  patchActor(actorRef: string, input: PatchActorInput): Promise<ApiResult>;
  upsertContent(input: UpsertContentInput): Promise<ApiResult>;
  manageActorContent(actorRef: string, input: ManageActorContentInput): Promise<ApiResult>;
  manageActorInventory(actorRef: string, input: ManageActorInventoryInput): Promise<ApiResult>;
  createEvent(input: CreateEventInput): Promise<ApiResult>;
  resolveActorEffect(input: ResolveActorEffectInput): Promise<ApiResult>;
}
