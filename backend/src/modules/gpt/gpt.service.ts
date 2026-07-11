import type { GptRepository } from './gpt.types.js';
import type {
  CreateEventInput, ListCampaignActorsInput, LoadGameInput, ManageActorContentInput,
  PatchActorInput, UpsertActorInput, UpsertContentInput,
} from './gpt.schemas.js';

export function createGptService(repository: GptRepository) {
  return {
    loadGame: (input: LoadGameInput) => repository.loadGame(input),
    listCampaignActors: (input: ListCampaignActorsInput) => repository.listCampaignActors(input),
    upsertActor: (input: UpsertActorInput) => repository.upsertActor(input),
    patchActor: (actorRef: string, input: PatchActorInput) => repository.patchActor(actorRef, input),
    upsertContent: (input: UpsertContentInput) => repository.upsertContent(input),
    manageActorContent: (actorRef: string, input: ManageActorContentInput) => repository.manageActorContent(actorRef, input),
    createEvent: (input: CreateEventInput) => repository.createEvent(input),
  };
}
