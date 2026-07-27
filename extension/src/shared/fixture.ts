export interface DemoResource {
  readonly label: 'HP' | 'Mana' | 'SP';
  readonly current: number;
  readonly maximum: number;
}

export interface DemoItem {
  readonly name: string;
  readonly description: string;
  readonly quantity?: number;
}

export const DEMO_CHARACTER = {
  accountName: 'OAuth Readonly Test',
  name: 'Test Adventurer',
  title: 'Explorador do Véu',
  level: 4,
  resources: [
    { label: 'HP', current: 36, maximum: 42 },
    { label: 'Mana', current: 18, maximum: 24 },
    { label: 'SP', current: 12, maximum: 16 },
  ] satisfies readonly DemoResource[],
  attributes: [
    ['Força', 11], ['Destreza', 14], ['Vitalidade', 12],
    ['Intelecto', 15], ['Vontade', 13], ['Percepção', 14],
  ] as const,
  inventory: [
    { name: 'Poção de Bruma', description: 'Recipiente sintético para recuperação breve.', quantity: 2 },
    { name: 'Mapa dobrado', description: 'Rascunho local sem localização real.' },
    { name: 'Pedra-eco', description: 'Lembra uma voz fictícia quando segurada.' },
  ] satisfies readonly DemoItem[],
  equipment: { name: 'Manto do Caminhante', description: 'Equipamento demonstrativo, sem efeito mecânico.' },
  abilities: [
    { name: 'Luz Velada', description: 'Capacidade demonstrativa de iluminação suave.' },
    { name: 'Passo Silencioso', description: 'Capacidade demonstrativa de deslocamento discreto.' },
    { name: 'Leitura de Runas', description: 'Capacidade demonstrativa de interpretação arcana.' },
  ] satisfies readonly DemoItem[],
} as const;
