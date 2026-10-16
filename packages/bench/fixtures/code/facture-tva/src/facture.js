// Le total d'une facture. Chaque ligne vaut quantité × prix unitaire hors taxes.
// `tauxTva` est un pourcentage (20 pour 20 %). Les montants rendus sont
// arrondis au centime le plus proche.
export function totalFacture(lignes, tauxTva) {
  let ht = 0;
  for (const ligne of lignes) ht += ligne.quantite * ligne.prixUnitaire;
  const tva = ht * tauxTva;
  return { ht: arrondi(ht), tva: arrondi(tva), ttc: arrondi(ht + tva) };
}

function arrondi(montant) {
  return Math.floor(montant * 100) / 100;
}
