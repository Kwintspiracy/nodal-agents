'use client';

// ApprovalsLive — la page des approbations suit la MÊME vérité que le rail.
//
// Le défaut que ce fichier ferme (Quentin, 22/09/2026, capture à l'appui) : le
// rail disait « Approvals 1 » et la section APPROVALS de la barre listait la
// demande, pendant que la page disait « 0 pending approvals ». Les deux avaient
// raison chacune à leur heure. La barre lit `ApprovalsProvider`, qui se relit
// sur la cadence de la barre ; la page est rendue par le serveur, et
// `force-dynamic` ne la rafraîchit qu'à la NAVIGATION. Une demande arrivée
// pendant qu'on la regarde n'apparaissait donc jamais. « Des pastilles partout
// mais plus rien à approuver, c'est perturbant. »
//
// ⚠️ PAS UN SECOND INTERVALLE. La page ne se relit pas sur une horloge à elle :
// elle se relit quand LE PROVIDER change d'avis, c'est-à-dire quand l'ensemble
// des demandes en attente n'est plus le même. Deux horloges indépendantes
// auraient laissé les deux surfaces se croiser à contretemps — exactement ce
// que Quentin a vu — et une pastille à 1 aurait pu coexister avec une page à 0
// le temps d'un tour. Ici la page ne peut être en retard que d'un rendu.
//
// Et elle ne se relit PAS quand rien n'a changé : relire toutes les quinze
// secondes pour redessiner les mêmes lignes ferait clignoter la page sous les
// yeux de quelqu'un qui lit une demande avant de répondre.

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useApprovals } from '@/components/ApprovalsProvider';

/**
 * CE QUI IDENTIFIE l'ensemble des attentes : leurs identifiants, triés.
 *
 * Le nombre ne suffirait pas — une demande répondue et une autre arrivée dans
 * le même tour laisseraient le compte à un, et la page garderait la première
 * sous les yeux. Les identifiants disent que ce ne sont pas les mêmes lignes.
 */
export function signatureDesAttentes(ids: readonly string[]): string {
  return [...ids].sort().join(',');
}

export default function ApprovalsLive() {
  const { pending } = useApprovals();
  const router = useRouter();
  const signature = signatureDesAttentes(pending.map((a) => a.id));
  // Le premier rendu ne rafraîchit rien : le serveur vient de rendre la page à
  // partir des mêmes lignes.
  const derniere = useRef(signature);

  useEffect(() => {
    if (derniere.current === signature) return;
    derniere.current = signature;
    router.refresh();
  }, [signature, router]);

  return null;
}
