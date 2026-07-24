import type { GptRepository } from './gpt.types.js';
import type {
  CreateEventInput, ListCampaignActorsInput, LoadGameInput, ManageActorContentInput, ManageActorInventoryInput,
  ListPlayerWorldsInput, ListWorldCampaignsInput, ManageActorProgressionInput, PatchActorInput, ResolveActorEffectInput,
  StartGameInput, UpsertActorInput, UpsertContentInput,
} from './gpt.schemas.js';

export function createGptService(repository: GptRepository) {
  return {
    loadGame: (input: LoadGameInput) => repository.loadGame(input),
    listPlayerWorlds: (input: ListPlayerWorldsInput) => repository.listPlayerWorlds(input),
    listWorldCampaigns: (input: ListWorldCampaignsInput) => repository.listWorldCampaigns(input),
    startGame: (input: StartGameInput) => repository.startGame(input),
    listCampaignActors: (input: ListCampaignActorsInput) => repository.listCampaignActors(input),
    upsertActor: (input: UpsertActorInput) => repository.upsertActor(input),
    patchActor: (actorRef: string, input: PatchActorInput) => repository.patchActor(actorRef, input),
    upsertContent: (input: UpsertContentInput) => repository.upsertContent(input),
    manageActorContent: (actorRef: string, input: ManageActorContentInput) => repository.manageActorContent(actorRef, input),
    manageActorInventory: (actorRef: string, input: ManageActorInventoryInput) => repository.manageActorInventory(actorRef, input),
    manageActorProgression: (input: ManageActorProgressionInput) => repository.manageActorProgression(input),
    createEvent: (input: CreateEventInput) => repository.createEvent(input),
    resolveActorEffect: (input: ResolveActorEffectInput) => repository.resolveActorEffect(input),
  };
}
