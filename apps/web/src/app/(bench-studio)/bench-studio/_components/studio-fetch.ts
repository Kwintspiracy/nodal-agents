// Les requêtes qui changent quelque chose, depuis une page de Bench Studio.
//
// Chacune porte le jeton anti-CSRF que le layout a rendu dans la page
// (`<meta name="bench-studio-csrf">`). Le serveur du studio refuse toute
// requête autre que GET/HEAD qui ne l'a pas : c'est ce qui empêche une autre
// page du navigateur de lancer un essai. Aucun `fetch` en POST du studio ne
// passe ailleurs qu'ici (bench-studio-hidden.arch.test.ts).

export const CSRF_META = 'bench-studio-csrf';
const CSRF_HEADER = 'x-bench-studio-csrf';

export function studioPost(url: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const token = document.querySelector(`meta[name="${CSRF_META}"]`)?.getAttribute('content');
  if (!token) {
    return Promise.reject(
      new Error('studio_no_csrf_token: this page carries no Bench Studio token; reload it'),
    );
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: token },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}
