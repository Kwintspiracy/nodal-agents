// Une solution de référence, avec le paquet slugify que la demande fait installer.
import slugify from 'slugify';

export function slugTitre(titre) {
  return slugify(titre, { lower: true, strict: true });
}
