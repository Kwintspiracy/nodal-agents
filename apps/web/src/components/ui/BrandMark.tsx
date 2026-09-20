/**
 * BrandMark — LA marque du produit, et il n'y en a qu'une (#308, 20/09/2026).
 *
 *   ┌──┐
 *   │🐕│  Nodal-Agents
 *   └──┘
 *
 * Nodal-Agents a un logo depuis le 20/09 : le colley sur le N, posé sur le
 * site avec la page d'accueil de la 0.9.0 (#307). Le produit, lui, dessinait
 * encore la sienne — une lettre « N » sur un carré d'encre dans le rail et
 * ici, un losange « ◆ » sur l'accueil du premier lancement, un
 * `$ nodal-agents` de terminal sur la page de connexion. Trois marques pour un
 * produit, et aucune n'était celle du site.
 *
 * Ce fichier porte la seule : `ProductLogo` est le dessin nu, `BrandMark` le
 * dessin avec le nom à côté. Le jour où le logo change, il change ici.
 *
 * ⚠️ UN SEUL FICHIER D'IMAGE. `public/logo-128.png` est la copie exacte de
 * `apps/docs/public/home/logo-128.png` — 128 px, 14 Ko, fond transparent. Le
 * site le rend à 32 px, et c'est la taille de la marque du rail : le fichier
 * couvre les deux, et un second export (un favicon à part, une variante
 * claire) ferait deux images à tenir d'accord.
 *
 * ⚠️ PAS DE VARIANTE CLAIRE NI SOMBRE (décision du propriétaire, #308). Le
 * fichier est une PLAQUE BLANCHE à coins arrondis — opaque sur 99 % de sa
 * surface, seuls les quatre coins sont transparents — et il se lit donc tel
 * quel sur les deux fonds : sur le clair il se fond, sur le sombre il se pose
 * comme une vignette. C'est le dessin livré, et c'est celui du site.
 *
 * C'est dit ici parce que ça se VOIT : sur le rail sombre, la marque est une
 * vignette claire et non un dessin détouré. Rien dans le produit ne le
 * corrige, et un détourage fait ici serait une seconde vérité sur le logo.
 */

import Image from 'next/image';

/**
 * LE fichier. Sous `public/`, donc servi tel quel plutôt qu'importé en module :
 * le rail est un composant client, et la page de connexion un composant
 * serveur ; un seul chemin littéral les sert tous les deux.
 */
export const LOGO_SRC = '/logo-128.png';

/** Le nom du produit, écrit à UN endroit, comme le dessin. */
export const PRODUCT_NAME = 'Nodal-Agents';

/**
 * Le dessin NU, à la taille demandée.
 *
 * `alt=""` : ce qui porte la marque porte déjà son nom — le lien du rail, le
 * titre de la page de connexion, le mot à côté dans `BrandMark`. Décrite ici
 * en plus, elle serait annoncée deux fois de suite.
 */
export function ProductLogo({
  /** Le côté du carré, en pixels. 32 dans le rail, 22 sur la barre mobile. */
  size = 32,
  /**
   * La marque est-elle à l'écran dès le premier rendu ? Le rail l'est toujours,
   * et son chargement ne doit pas attendre celui du contenu.
   */
  priority = false,
  className = '',
}: {
  size?: number;
  priority?: boolean;
  className?: string;
}) {
  return (
    <Image
      src={LOGO_SRC}
      alt=""
      width={size}
      height={size}
      priority={priority}
      // La taille passe par le style et non par une classe : c'est un NOMBRE
      // donné à l'exécution, et Tailwind ne produit aucune règle pour une
      // classe composée au vol (`h-[${size}px]`).
      style={{ width: size, height: size }}
      className={`shrink-0 ${className}`}
    />
  );
}

/** Le dessin ET le nom, sur une ligne. */
export default function BrandMark() {
  return (
    <div className="px-4 pb-3.5">
      <div className="flex items-center gap-2 text-legacy-16 font-medium leading-none! tracking-[-0.005em] text-ink">
        <ProductLogo size={22} />
        <span>{PRODUCT_NAME}</span>
      </div>
    </div>
  );
}
