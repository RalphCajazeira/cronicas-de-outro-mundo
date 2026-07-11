# Estrutura Supabase

Projeto: `isekai-rpg-db`

Região: São Paulo (`sa-east-1`)

## Segurança

- RLS ativo nas tabelas do RPG.
- API Key armazenada apenas como hash.
- Edge Functions validam `x-rpg-key`.
- Service role nunca deve ser exposta ao GPT.
- Não versionar segredos.

## Grupos de tabelas

### Core
- rpg_worlds
- rpg_campaigns
- rpg_characters
- rpg_game_events
- rpg_save_snapshots

### Inventário e progressão
- rpg_item_catalog
- rpg_inventory
- rpg_skills
- rpg_spell_catalog
- rpg_character_spells
- rpg_talent_catalog
- rpg_character_talents
- rpg_heritages

### Missões e NPCs
- rpg_quests
- rpg_quest_progress
- rpg_npcs
- rpg_relationships

### Combate
- rpg_enemy_catalog
- rpg_enemy_loot_entries
- rpg_combats
- rpg_combat_enemies
- rpg_pending_loot

### Mundo
- rpg_locations
- rpg_routes
- rpg_transport_modes
- rpg_travel_log

### Companheiros e Codex
- rpg_companions
- rpg_companion_skills
- rpg_codex_entries

## Planejado

- rpg_entities
- rpg_entity_memories
- rpg_entity_relationships
- rpg_shops
- rpg_shop_inventory
- rpg_shop_transactions
- rpg_quest_givers
- rpg_quest_choices
- rpg_quest_consequences
