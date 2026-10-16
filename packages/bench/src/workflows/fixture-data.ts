// workflows/fixture-data.ts — le contenu des fixtures, en un seul endroit.
//
// `make-fixtures.ts` écrit les fichiers de packages/bench/fixtures/ à partir de
// ces données ; les juges lisent les fichiers eux-mêmes, et ne prennent ici que
// ce qu'aucun fichier ne dit (la réponse attendue à une question).

export const STOCK = {
  sheet: 'Stock',
  header: ['Article', 'Quantité', 'Prix unitaire'],
  rows: [
    ['Stylo', 120, 0.85],
    ['Cahier', 45, 2.4],
    ['Classeur', 30, 4.75],
    ['Agrafeuse', 12, 9.9],
    ['Gomme', 200, 0.35],
  ] as Array<[string, number, number]>,
};

export const NOTES = {
  sheet: 'Notes',
  header: ['Élève', 'Maths', 'Français', 'Histoire'],
  rows: [
    ['Alice', 14, 12, 16],
    ['Bruno', 9, 13, 11],
    ['Chloé', 17, 15, 18],
    ['David', 11, 8, 12.5],
  ] as Array<[string, number, number, number]>,
};

export const QUARTER = {
  sheet: 'Ventes',
  header: ['Produit', 'Janvier', 'Février', 'Mars'],
  rows: [
    ['Thé vert', 120, 95, 130],
    ['Café moulu', 210, 180, 160],
    ['Chocolat chaud', 90, 140, 175],
    ['Infusion', 60, 75, 80],
  ] as Array<[string, number, number, number]>,
};

export const CONTACTS_CSV = [
  'nom,email,ville',
  'Camille Martin,camille.martin@example.org,Lyon',
  'Hugo Bernard,hugo.bernard@example.org,Nantes',
  'Léa Petit,lea.petit@example.org,Lille',
  'Nathan Robert,nathan.robert@example.org,Bordeaux',
  'Inès Richard,ines.richard@example.org,Rennes',
  'Louis Durand,louis.durand@example.org,Grenoble',
].join('\n');

export const CONTRACT = {
  title: 'Contrat de prestation',
  paragraphs: [
    'Entre ACME SARL, société au capital de 10 000 euros, et le client désigné ci-dessous.',
    'ACME SARL s’engage à livrer la prestation dans un délai de trente jours.',
    'Toute réclamation est adressée par écrit au siège d’ACME SARL.',
  ],
  table: [
    ['Partie', 'Rôle'],
    ['ACME SARL', 'Prestataire'],
    ['Atelier Bench', 'Client'],
  ],
  /** Le nombre de fois où le nom à remplacer apparaît. */
  occurrences: 4,
  from: 'ACME SARL',
  to: 'Nodal Bench SAS',
};

export const MINUTES = {
  title: 'Compte rendu de la réunion du 3 octobre 2026',
  paragraphs: [
    'Présents : Alice, Bruno, Chloé et David.',
    'Le lancement de la nouvelle offre est confirmé pour le mois de novembre.',
    'Le budget marketing du trimestre est fixé à 15 000 euros.',
    'Le recrutement d’un designer est validé, avec une prise de poste en janvier.',
  ],
};

export const PROJECT_DECK = [
  ['Projet Atlas', 'Point d’avancement'],
  [
    'Objectifs',
    'Réduire les délais de livraison',
    'Simplifier la facturation',
    'Ouvrir deux nouvelles régions',
  ],
  ['Calendrier', 'Octobre : cadrage', 'Novembre : développement', 'Décembre : mise en service'],
];

export const REVIEW_DECK = [
  ['Bilan 2025', 'Une année de croissance'],
  ['Chiffres clés 2025', 'Chiffre d’affaires 2025 : 1,2 M€', 'Clients actifs fin 2025 : 340'],
  ['Perspectives après 2025', 'Consolider les acquis de 2025', 'Préparer la suite'],
];

export const OFFER_DECK = [
  ['Offre Nodal', 'Présentation commerciale'],
  ['Fonctionnalités', 'Agents sur mesure', 'Tableau de bord', 'Connecteurs'],
  ['Tarifs', 'Formule Essentielle : 19 € par mois', 'Formule Pro : 49 € par mois'],
  ['Contact', 'contact@example.org'],
];
export const OFFER_PRO_PRICE = 49;

export const INVOICE_PDF = [
  'FACTURE',
  'Facture n° FB-2026-117',
  'Date : 2 octobre 2026',
  'Client : Atelier Bench',
  'Prestation de conseil : 1 028,80 EUR HT',
  'TVA 20 % : 205,76 EUR',
  'Total TTC : 1 234,56 EUR',
];
export const INVOICE_NUMBER = 'FB-2026-117';
export const INVOICE_TOTAL = 1234.56;

export const GUIDE_PDF = [
  ['Guide de démarrage', 'Chapitre 1 : Présentation', 'Ce guide présente l’outil en trois étapes.'],
  ['Chapitre 2 : Installation', 'Téléchargez l’installateur puis lancez-le.'],
  ['Chapitre 3 : Premiers pas', 'Créez votre premier projet.'],
];

export const MEETING_MD = `# Réunion produit du 9 octobre 2026

## Participants

- Alice
- Bruno

## Décisions

- Lancer la bêta le 2 novembre
- Recruter un designer

## Prochaine réunion

Le 23 octobre 2026 à 10 h.
`;

export const WEATHER_CSV = [
  'jour,min,max',
  'lundi,8,15',
  'mardi,9,17',
  'mercredi,7,14',
  'jeudi,6,12.5',
  'vendredi,10,18',
  'samedi,11,19',
  'dimanche,9,16',
].join('\n');

export const HOME_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Accueil</title>
</head>
<body>
<h1>Bienvenue chez Bench</h1>
<p>Nous fabriquons des tables en bois massif depuis 1987.</p>
<p>Notre atelier est ouvert du mardi au samedi.</p>
</body>
</html>
`;

/** Un générateur pseudo-aléatoire déterministe (LCG) : la même fixture à chaque écriture. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export const REGIONS = ['Nord', 'Sud', 'Est', 'Ouest', 'Centre'];

export function salesCsv(): string {
  const rnd = lcg(20261015);
  const products = ['Lampe', 'Chaise', 'Table', 'Étagère', 'Tapis'];
  const lines = ['date,region,produit,quantite,prix_unitaire'];
  for (let i = 0; i < 120; i++) {
    const day = String(1 + Math.floor(rnd() * 28)).padStart(2, '0');
    const month = String(1 + Math.floor(rnd() * 9)).padStart(2, '0');
    const region = REGIONS[Math.floor(rnd() * REGIONS.length)]!;
    const product = products[Math.floor(rnd() * products.length)]!;
    const qty = 1 + Math.floor(rnd() * 20);
    const price = (5 + Math.floor(rnd() * 9500) / 100).toFixed(2);
    lines.push(`2026-${month}-${day},${region},${product},${qty},${price}`);
  }
  return lines.join('\n');
}
