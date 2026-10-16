// Une solution de référence : le taux est un pourcentage, l'arrondi est au plus proche.
export function totalFacture(lignes, tauxTva) {
  let ht = 0;
  for (const ligne of lignes) ht += ligne.quantite * ligne.prixUnitaire;
  const tva = (ht * tauxTva) / 100;
  return { ht: arrondi(ht), tva: arrondi(tva), ttc: arrondi(ht + tva) };
}

function arrondi(montant) {
  return Math.round(montant * 100) / 100;
}
