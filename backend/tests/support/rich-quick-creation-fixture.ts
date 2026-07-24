const knownLink = () => ({
  state: 'known' as const,
  rank: 1,
  progress: 0,
  mastery: 0,
});

function starterPackage(
  starterBlueprint: string,
  contentType: string,
  code: string,
  name: string,
  options?: Record<string, unknown>,
  linked = false,
) {
  return {
    definition: {
      mode: 'create' as const,
      scope: 'world' as const,
      code,
      contentType,
      starterBlueprint,
      ...(options === undefined ? {} : { blueprintOptions: options }),
      name,
      description: `${name} reproduzido da criação conversacional sanitizada.`,
      presentation: { summary: `${name} inicial.` },
      tags: ['starter'],
      status: 'active' as const,
    },
    ...(linked ? { protagonistLink: knownLink() } : {}),
  };
}

function buildRichQuickCreationPayload(prefix: string, corrected: boolean) {
  const code = (suffix: string) => `${prefix}-${suffix}`;
  const bootsType = corrected ? 'armor' : 'clothing';
  const mantleType = corrected ? 'armor' : 'clothing';
  const fixedOption = corrected ? undefined : { unitWeight: 1 };
  const packages = [
    starterPackage(
      'shadow_wrapped_status', 'status_effect', code('shadow-wrapped'), 'Envolto em Sombras',
    ),
    starterPackage(
      'veil_of_darkness_spell', 'spell', code('veil'), 'Véu das Trevas',
      { linkedStatusCode: code('shadow-wrapped') }, true,
    ),
    starterPackage(
      'basic_offensive_spell', 'spell', code('shadow-dart'), 'Dardo Umbrático',
      { damageElement: 'shadow' }, true,
    ),
    starterPackage(
      'basic_mobility_skill', 'skill', code('twilight-step'), 'Passo Crepuscular',
      undefined, true,
    ),
    starterPackage(
      'detect_hidden_skill', 'skill', code('grave-sight'), 'Olhar do Sepulcro',
      undefined, true,
    ),
    starterPackage(
      'simple_melee_weapon', 'weapon', code('dagger'), 'Adaga da Ordem Morta', fixedOption,
    ),
    starterPackage(
      'simple_magic_focus', 'weapon', code('focus'), 'Foco Ritual de Obsidiana', fixedOption,
    ),
    starterPackage(
      'secondary_modifier_equipment', bootsType, code('boots'), 'Botas de Passos Silenciosos',
      {
        equipmentSlot: 'feet',
        unitWeight: 1,
        secondaryModifiers: {
          physicalDefense: 2,
          magicalDefense: 5,
          evasion: 2,
          movementSpeed: 1,
        },
      },
    ),
    starterPackage(
      'secondary_modifier_equipment', mantleType, code('mantle'), 'Manto Leve de Erudito',
      {
        equipmentSlot: 'body',
        unitWeight: 1,
        secondaryModifiers: corrected ? { physicalDefense: 1, stealth: 2 } : { stealth: 2 },
      },
    ),
    starterPackage(
      'basic_healing_consumable', 'consumable', code('potion'), 'Poção de Cura', fixedOption,
    ),
    {
      definition: {
        mode: 'create' as const,
        scope: 'campaign' as const,
        code: code('notebook'),
        contentType: 'other' as const,
        name: 'Caderno Cifrado da Ordem',
        description: 'Registro narrativo sem bônus mecânico.',
        profile: null,
        inventorySpec: {
          schemaVersion: 1 as const,
          rulesetCode: 'core-v1' as const,
          inventoryRulesCode: 'core-v1-inventory-v1' as const,
          unitWeight: 1,
          stacking: { mode: 'unique' as const },
        },
        presentation: { summary: 'Caderno cifrado.' },
        tags: ['narrative'],
        status: 'active' as const,
      },
    },
  ];
  if (corrected) {
    packages[0]!.definition.tags = ['shadow_wrapped', 'stealth'];
    packages[1]!.definition.tags = ['shadow', 'stealth'];
    packages[4]!.definition.tags = ['detect_hidden', 'informational'];
  }
  return {
    idempotencyKey: `${prefix}-start-001`,
    playerMode: 'create' as const,
    playerRef: code('player'),
    playerDisplayName: 'Ralph',
    worldMode: 'create' as const,
    worldRef: code('world'),
    worldName: 'Erdhavar',
    worldDescription: 'Uma terra sombria de cidades decadentes e ruínas soterradas.',
    worldConfiguration: {
      schemaVersion: 1 as const,
      genres: ['dark fantasy'],
      setting: 'Reinos, florestas e ruínas.',
      era: 'medieval fantástica',
      technologyLevel: { grade: 'preindustrial' as const },
      magicLevel: { grade: 'rare' as const },
      worldTone: ['dark', 'mysterious'],
    },
    campaignRef: code('campaign'),
    campaignName: 'Os Arquivos da Ordem Morta',
    campaignConfiguration: {
      schemaVersion: 1 as const,
      difficulty: { preset: 'standard' as const },
      progressionPace: 'standard' as const,
      narrativeTone: ['dark', 'investigative'],
      focus: ['exploration', 'stealth'],
      playerFreedom: 'open' as const,
      consequenceLevel: 'serious' as const,
      classModel: {
        mode: 'identity' as const,
        startingClass: 'required' as const,
        progressionBasis: ['study', 'discovery', 'practice'],
        description: 'A classe é uma identidade narrativa; conteúdos concedem capacidades mecânicas.',
      },
    },
    protagonist: {
      code: code('player'),
      name: 'Vael',
      actorType: 'character' as const,
      species: 'Humano',
      className: 'Mago das Sombras',
      role: 'explorador furtivo',
      description: 'Erudito perseguido que explora ruínas antigas.',
      primaryAttributes: {
        strength: 4,
        vitality: 4,
        agility: 13,
        dexterity: 12,
        intelligence: 16,
        wisdom: 8,
        perception: 14,
        willpower: 11,
        luck: 8,
      },
      appearance: { summary: 'Erudito de presença discreta.' },
      personality: { traits: ['cauteloso', 'meticuloso'] },
      origin: { label: 'Último erudito', summary: 'Busca recuperar os arquivos perdidos.' },
    },
    initialContentPackages: packages,
    initialInventory: [
      {
        scope: 'world' as const, contentType: 'weapon' as const, code: code('dagger'), quantity: 1,
        entryRefs: [code('dagger-1')], equip: { targetSlotRef: 'main_hand' as const },
      },
      {
        scope: 'world' as const, contentType: 'weapon' as const, code: code('focus'), quantity: 1,
        entryRefs: [code('focus-1')],
      },
      {
        scope: 'world' as const, contentType: bootsType, code: code('boots'), quantity: 1,
        entryRefs: [code('boots-1')], equip: { targetSlotRef: 'feet' as const },
      },
      {
        scope: 'world' as const, contentType: mantleType, code: code('mantle'), quantity: 1,
        entryRefs: [code('mantle-1')],
      },
      {
        scope: 'world' as const, contentType: 'consumable' as const, code: code('potion'), quantity: 2,
        entryRefs: [code('potions-1')],
      },
      {
        scope: 'campaign' as const, contentType: 'other' as const, code: code('notebook'), quantity: 1,
        entryRefs: [code('notebook-1')],
      },
    ],
    initialPremise: 'Uma biblioteca subterrânea foi localizada antes dos perseguidores.',
  };
}

/**
 * Sanitized structural reproduction of the payload captured from the failed GPT Action.
 * It intentionally retains the invalid blueprint combinations that previously escaped as HTTP 500.
 */
export function capturedRichQuickCreationPayload(prefix = 'captured-rich') {
  return buildRichQuickCreationPayload(prefix, false);
}

export function correctedRichQuickCreationPayload(prefix = 'corrected-rich') {
  return buildRichQuickCreationPayload(prefix, true);
}
